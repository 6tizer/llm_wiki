#![allow(dead_code)]

use crate::panic_guard::run_guarded;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};
use tauri::{AppHandle, Manager};
use uuid::Uuid;

pub const PROFILE_SECRET_REF_PREFIX: &str = "llm-wiki-profile-secret:";
const UUID_TEXT_BYTES: usize = 36;
pub const PROFILE_SECRET_REF_BYTES: usize = PROFILE_SECRET_REF_PREFIX.len() + UUID_TEXT_BYTES;
// Keep this in sync with PROFILE_SECRET_REF_PREFIX and UUID_TEXT_BYTES; SQLite GLOB
// cannot be composed from Rust constants at runtime.
pub const PROFILE_SECRET_REF_SQL_GLOB: &str =
    "llm-wiki-profile-secret:[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]";
const PROFILE_SECRET_SERVICE: &str = "llm-wiki.profile-secret";
const PROFILE_SECRET_FILE_NAME: &str = "profile-secrets.json";
const PROFILE_SECRET_FILE_VERSION: u8 = 1;
static PROFILE_SECRET_FILE_LOCK: Mutex<()> = Mutex::new(());
static PROFILE_SECRET_MIGRATION_LOCK: Mutex<()> = Mutex::new(());

pub trait SecretStore: Send + Sync {
    fn write(&self, secret_ref: &str, secret_value: &str) -> Result<(), String>;
    fn read(&self, secret_ref: &str) -> Result<String, String>;
    fn delete(&self, secret_ref: &str) -> Result<(), String>;
}

#[derive(Debug, Clone, Copy, Default, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ProfileSecretBackend {
    #[default]
    File,
    Keychain,
}

#[derive(Clone, Serialize, Deserialize)]
struct ProfileSecretFile {
    #[serde(default = "default_profile_secret_file_version")]
    version: u8,
    #[serde(default)]
    backend: ProfileSecretBackend,
    #[serde(default)]
    secrets: BTreeMap<String, String>,
}

impl Default for ProfileSecretFile {
    fn default() -> Self {
        Self {
            version: PROFILE_SECRET_FILE_VERSION,
            backend: ProfileSecretBackend::File,
            secrets: BTreeMap::new(),
        }
    }
}

fn default_profile_secret_file_version() -> u8 {
    PROFILE_SECRET_FILE_VERSION
}

#[derive(Debug, Clone)]
pub struct FileSecretStore {
    base_dir: PathBuf,
}

impl FileSecretStore {
    pub fn new(base_dir: PathBuf) -> Self {
        Self { base_dir }
    }

    fn path(&self) -> PathBuf {
        self.base_dir.join(PROFILE_SECRET_FILE_NAME)
    }

    fn load_file(&self) -> Result<ProfileSecretFile, String> {
        let path = self.path();
        match fs::read_to_string(&path) {
            Ok(raw) => {
                let file: ProfileSecretFile = serde_json::from_str(&raw)
                    .map_err(|err| bounded_secret_error("profile-secret-file-parse-failed", err))?;
                if file.version != PROFILE_SECRET_FILE_VERSION {
                    return Err(format!(
                        "profile-secret-file-version-unsupported: expected version {PROFILE_SECRET_FILE_VERSION}"
                    ));
                }
                Ok(file)
            }
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
                Ok(ProfileSecretFile::default())
            }
            Err(err) => Err(bounded_secret_error("profile-secret-file-read-failed", err)),
        }
    }

    fn save_file(&self, file: &ProfileSecretFile) -> Result<(), String> {
        fs::create_dir_all(&self.base_dir)
            .map_err(|err| bounded_secret_error("profile-secret-file-dir-failed", err))?;
        self.cleanup_stale_temp_files()?;
        let path = self.path();
        let temp_path = self.base_dir.join(format!(
            ".{PROFILE_SECRET_FILE_NAME}.{}.tmp",
            Uuid::new_v4()
        ));
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut temp = options
            .open(&temp_path)
            .map_err(|err| bounded_secret_error("profile-secret-file-temp-failed", err))?;
        let bytes = serde_json::to_vec_pretty(file)
            .map_err(|err| bounded_secret_error("profile-secret-file-serialize-failed", err))?;
        if let Err(err) = temp.write_all(&bytes).and_then(|()| temp.sync_all()) {
            let _ = fs::remove_file(&temp_path);
            return Err(bounded_secret_error(
                "profile-secret-file-write-failed",
                err,
            ));
        }
        drop(temp);
        if let Err(err) = fs::rename(&temp_path, &path) {
            let _ = fs::remove_file(&temp_path);
            return Err(bounded_secret_error(
                "profile-secret-file-rename-failed",
                err,
            ));
        }
        set_private_file_permissions(&path)
    }

    fn cleanup_stale_temp_files(&self) -> Result<(), String> {
        let prefix = format!(".{PROFILE_SECRET_FILE_NAME}.");
        let entries = fs::read_dir(&self.base_dir)
            .map_err(|err| bounded_secret_error("profile-secret-file-temp-scan-failed", err))?;
        for entry in entries {
            let entry =
                entry.map_err(|err| bounded_secret_error("profile-secret-file-temp-scan-failed", err))?;
            let file_name = entry.file_name();
            let file_name = file_name.to_string_lossy();
            if file_name.starts_with(&prefix) && file_name.ends_with(".tmp") {
                fs::remove_file(entry.path())
                    .map_err(|err| bounded_secret_error("profile-secret-file-temp-clean-failed", err))?;
            }
        }
        Ok(())
    }

    fn backend(&self) -> Result<ProfileSecretBackend, String> {
        Ok(self.load_file()?.backend)
    }

    fn set_backend(&self, backend: ProfileSecretBackend) -> Result<(), String> {
        let _migration_guard = lock_profile_secret_migration()?;
        let _guard = lock_profile_secret_file()?;
        let mut file = self.load_file()?;
        file.backend = backend;
        self.save_file(&file)
    }
}

impl SecretStore for FileSecretStore {
    fn write(&self, secret_ref: &str, secret_value: &str) -> Result<(), String> {
        validate_profile_secret_ref(secret_ref)?;
        let secret_value = require_secret_value(secret_value)?;
        let _guard = lock_profile_secret_file()?;
        let mut file = self.load_file()?;
        file.secrets
            .insert(secret_ref.to_string(), secret_value.to_string());
        self.save_file(&file)
    }

    fn read(&self, secret_ref: &str) -> Result<String, String> {
        validate_profile_secret_ref(secret_ref)?;
        self.load_file()?
            .secrets
            .get(secret_ref)
            .cloned()
            .ok_or_else(|| "profile-secret-not-found: secret reference was not found".to_string())
    }

    fn delete(&self, secret_ref: &str) -> Result<(), String> {
        validate_profile_secret_ref(secret_ref)?;
        let _guard = lock_profile_secret_file()?;
        let mut file = self.load_file()?;
        file.secrets.remove(secret_ref);
        self.save_file(&file)
    }
}

fn lock_profile_secret_file() -> Result<MutexGuard<'static, ()>, String> {
    PROFILE_SECRET_FILE_LOCK
        .lock()
        .map_err(|_| "profile-secret-file-lock-poisoned".to_string())
}

fn lock_profile_secret_migration() -> Result<MutexGuard<'static, ()>, String> {
    PROFILE_SECRET_MIGRATION_LOCK
        .lock()
        .map_err(|_| "profile-secret-migration-lock-poisoned".to_string())
}

#[cfg(unix)]
fn set_private_file_permissions(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))
        .map_err(|err| bounded_secret_error("profile-secret-file-permission-failed", err))
}

#[cfg(not(unix))]
fn set_private_file_permissions(_path: &Path) -> Result<(), String> {
    Ok(())
}

struct MigratingSecretStore {
    active_backend: ProfileSecretBackend,
    active: Box<dyn SecretStore>,
    fallback_backend: ProfileSecretBackend,
    fallback: Box<dyn SecretStore>,
}

impl MigratingSecretStore {
    fn new(
        active_backend: ProfileSecretBackend,
        active: Box<dyn SecretStore>,
        fallback_backend: ProfileSecretBackend,
        fallback: Box<dyn SecretStore>,
    ) -> Self {
        Self {
            active_backend,
            active,
            fallback_backend,
            fallback,
        }
    }
}

impl SecretStore for MigratingSecretStore {
    fn write(&self, secret_ref: &str, secret_value: &str) -> Result<(), String> {
        let _guard = lock_profile_secret_migration()?;
        self.active.write(secret_ref, secret_value)
    }

    fn read(&self, secret_ref: &str) -> Result<String, String> {
        let _guard = lock_profile_secret_migration()?;
        match self.active.read(secret_ref) {
            Ok(value) => Ok(value),
            Err(active_err) => match self.fallback.read(secret_ref) {
                Ok(value) => {
                    let _ = self.active.write(secret_ref, &value);
                    Ok(value)
                }
                Err(fallback_err) => Err(bounded_secret_error(
                    "profile-secret-read-failed",
                    format!(
                        "active {:?}: {}; fallback {:?}: {}",
                        self.active_backend, active_err, self.fallback_backend, fallback_err
                    ),
                )),
            },
        }
    }

    fn delete(&self, secret_ref: &str) -> Result<(), String> {
        let _guard = lock_profile_secret_migration()?;
        let active_result = self.active.delete(secret_ref);
        if let Err(err) = self.fallback.delete(secret_ref) {
            eprintln!(
                "{}",
                bounded_secret_error(
                    "profile-secret-delete-fallback-failed",
                    format!("fallback {:?}: {err}", self.fallback_backend),
                )
            );
        }
        active_result
    }
}

#[derive(Debug, Clone, Copy, Default)]
pub struct OsSecretStore;

impl OsSecretStore {
    fn entry(secret_ref: &str) -> Result<keyring::Entry, String> {
        validate_profile_secret_ref(secret_ref)?;
        keyring::Entry::new(PROFILE_SECRET_SERVICE, secret_ref)
            .map_err(|err| bounded_secret_error("profile-secret-entry-failed", err))
    }
}

impl SecretStore for OsSecretStore {
    fn write(&self, secret_ref: &str, secret_value: &str) -> Result<(), String> {
        let secret_value = require_secret_value(secret_value)?;
        Self::entry(secret_ref)?
            .set_password(secret_value)
            .map_err(|err| bounded_secret_error("profile-secret-write-failed", err))
    }

    fn read(&self, secret_ref: &str) -> Result<String, String> {
        Self::entry(secret_ref)?
            .get_password()
            .map_err(|err| bounded_secret_error("profile-secret-read-failed", err))
    }

    fn delete(&self, secret_ref: &str) -> Result<(), String> {
        match Self::entry(secret_ref)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(err) => Err(bounded_secret_error("profile-secret-delete-failed", err)),
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProfileSecretWriteRequest {
    pub secret_value: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileSecretWriteResult {
    pub secret_ref: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProfileSecretDeleteRequest {
    pub secret_ref: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileSecretDeleteResult {
    pub ok: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileSecretBackendResult {
    pub backend: ProfileSecretBackend,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProfileSecretBackendSetRequest {
    pub backend: ProfileSecretBackend,
}

#[tauri::command]
pub fn profile_secret_write(
    app: AppHandle,
    request: ProfileSecretWriteRequest,
) -> Result<ProfileSecretWriteResult, String> {
    run_guarded("profile_secret_write", || {
        let store = active_secret_store(&app)?;
        profile_secret_write_with_store(store.as_ref(), request)
    })
}

#[tauri::command]
pub fn profile_secret_delete(
    app: AppHandle,
    request: ProfileSecretDeleteRequest,
) -> Result<ProfileSecretDeleteResult, String> {
    run_guarded("profile_secret_delete", || {
        let store = active_secret_store(&app)?;
        profile_secret_delete_with_store(store.as_ref(), request)
    })
}

#[tauri::command]
pub fn profile_secret_backend_get(app: AppHandle) -> Result<ProfileSecretBackendResult, String> {
    run_guarded("profile_secret_backend_get", || {
        let file_store = file_secret_store_for_app(&app)?;
        Ok(ProfileSecretBackendResult {
            backend: file_store.backend()?,
        })
    })
}

#[tauri::command]
pub fn profile_secret_backend_set(
    app: AppHandle,
    request: ProfileSecretBackendSetRequest,
) -> Result<ProfileSecretBackendResult, String> {
    run_guarded("profile_secret_backend_set", || {
        let file_store = file_secret_store_for_app(&app)?;
        file_store.set_backend(request.backend)?;
        Ok(ProfileSecretBackendResult {
            backend: request.backend,
        })
    })
}

fn profile_secret_write_with_store(
    store: &(impl SecretStore + ?Sized),
    request: ProfileSecretWriteRequest,
) -> Result<ProfileSecretWriteResult, String> {
    Ok(ProfileSecretWriteResult {
        secret_ref: write_profile_secret(store, &request.secret_value)?,
    })
}

fn profile_secret_delete_with_store(
    store: &(impl SecretStore + ?Sized),
    request: ProfileSecretDeleteRequest,
) -> Result<ProfileSecretDeleteResult, String> {
    delete_profile_secret(store, &request.secret_ref)?;
    Ok(ProfileSecretDeleteResult { ok: true })
}

pub fn active_secret_store(app: &AppHandle) -> Result<Box<dyn SecretStore>, String> {
    let file_store = file_secret_store_for_app(app)?;
    let backend = file_store.backend()?;
    Ok(match backend {
        ProfileSecretBackend::File => Box::new(MigratingSecretStore::new(
            ProfileSecretBackend::File,
            Box::new(file_store),
            ProfileSecretBackend::Keychain,
            Box::new(OsSecretStore),
        )),
        ProfileSecretBackend::Keychain => Box::new(MigratingSecretStore::new(
            ProfileSecretBackend::Keychain,
            Box::new(OsSecretStore),
            ProfileSecretBackend::File,
            Box::new(file_store),
        )),
    })
}

fn file_secret_store_for_app(app: &AppHandle) -> Result<FileSecretStore, String> {
    app.path()
        .app_data_dir()
        .map(FileSecretStore::new)
        .map_err(|err| bounded_secret_error("profile-secret-app-data-dir-failed", err))
}

pub fn new_profile_secret_ref() -> String {
    format!("{PROFILE_SECRET_REF_PREFIX}{}", Uuid::new_v4())
}

pub fn write_profile_secret(
    store: &(impl SecretStore + ?Sized),
    secret_value: &str,
) -> Result<String, String> {
    let secret_value = require_secret_value(secret_value)?;
    let secret_ref = new_profile_secret_ref();
    store.write(&secret_ref, secret_value)?;
    Ok(secret_ref)
}

pub fn read_profile_secret(
    store: &(impl SecretStore + ?Sized),
    secret_ref: &str,
) -> Result<String, String> {
    store.read(validate_profile_secret_ref(secret_ref)?)
}

pub fn delete_profile_secret(
    store: &(impl SecretStore + ?Sized),
    secret_ref: &str,
) -> Result<(), String> {
    store.delete(validate_profile_secret_ref(secret_ref)?)
}

pub fn validate_profile_secret_ref(secret_ref: &str) -> Result<&str, String> {
    let secret_ref = secret_ref.trim();
    if secret_ref.is_empty() {
        return Err("invalid-secret-ref: secretRef must not be empty".to_string());
    }
    let Some(secret_id) = secret_ref.strip_prefix(PROFILE_SECRET_REF_PREFIX) else {
        return Err(
            "invalid-secret-ref: secretRef must be a profile secret UUID reference".to_string(),
        );
    };
    if secret_ref.len() != PROFILE_SECRET_REF_BYTES {
        return Err(format!(
            "invalid-secret-ref: secretRef must be exactly {PROFILE_SECRET_REF_BYTES} bytes"
        ));
    }
    let parsed = Uuid::parse_str(secret_id)
        .map_err(|_| "invalid-secret-ref: secretRef must end with a UUID".to_string())?;
    if parsed.to_string() != secret_id {
        return Err(
            "invalid-secret-ref: secretRef UUID must use canonical lowercase form".to_string(),
        );
    }
    Ok(secret_ref)
}

fn require_secret_value(secret_value: &str) -> Result<&str, String> {
    if secret_value.trim().is_empty() {
        Err("invalid-secret: secret value must not be empty".to_string())
    } else {
        Ok(secret_value)
    }
}

fn bounded_secret_error(code: &str, err: impl std::fmt::Display) -> String {
    let message = err.to_string();
    let message = truncate_on_char_boundary(&message, 240);
    format!("{code}: {message}")
}

fn truncate_on_char_boundary(message: &str, max_bytes: usize) -> &str {
    if message.len() <= max_bytes {
        return message;
    }
    let mut end = max_bytes;
    while !message.is_char_boundary(end) {
        end -= 1;
    }
    &message[..end]
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::sync::{Arc, Barrier};
    use std::sync::Mutex;
    use std::time::Duration;

    #[derive(Default)]
    struct InMemorySecretStore {
        values: Mutex<HashMap<String, String>>,
        read_count: Mutex<usize>,
    }

    impl InMemorySecretStore {
        fn insert(&self, secret_ref: &str, secret_value: &str) {
            self.values
                .lock()
                .expect("lock secret store")
                .insert(secret_ref.to_string(), secret_value.to_string());
        }

        fn read_count(&self) -> usize {
            *self.read_count.lock().expect("lock read count")
        }
    }

    impl SecretStore for InMemorySecretStore {
        fn write(&self, secret_ref: &str, secret_value: &str) -> Result<(), String> {
            self.values
                .lock()
                .expect("lock secret store")
                .insert(secret_ref.to_string(), secret_value.to_string());
            Ok(())
        }

        fn read(&self, secret_ref: &str) -> Result<String, String> {
            *self.read_count.lock().expect("lock read count") += 1;
            self.values
                .lock()
                .expect("lock secret store")
                .get(secret_ref)
                .cloned()
                .ok_or_else(|| {
                    "profile-secret-not-found: secret reference was not found".to_string()
                })
        }

        fn delete(&self, secret_ref: &str) -> Result<(), String> {
            self.values
                .lock()
                .expect("lock secret store")
                .remove(secret_ref);
            Ok(())
        }
    }

    impl SecretStore for Arc<InMemorySecretStore> {
        fn write(&self, secret_ref: &str, secret_value: &str) -> Result<(), String> {
            self.as_ref().write(secret_ref, secret_value)
        }

        fn read(&self, secret_ref: &str) -> Result<String, String> {
            self.as_ref().read(secret_ref)
        }

        fn delete(&self, secret_ref: &str) -> Result<(), String> {
            self.as_ref().delete(secret_ref)
        }
    }

    struct BlockingReadSecretStore {
        secret_ref: String,
        secret_value: String,
        read_started: Arc<Barrier>,
        release_read: Arc<Barrier>,
    }

    impl SecretStore for BlockingReadSecretStore {
        fn write(&self, _secret_ref: &str, _secret_value: &str) -> Result<(), String> {
            Ok(())
        }

        fn read(&self, secret_ref: &str) -> Result<String, String> {
            if secret_ref != self.secret_ref {
                return Err("profile-secret-not-found: secret reference was not found".to_string());
            }
            self.read_started.wait();
            self.release_read.wait();
            Ok(self.secret_value.clone())
        }

        fn delete(&self, _secret_ref: &str) -> Result<(), String> {
            Ok(())
        }
    }

    struct TempSecretDir {
        path: PathBuf,
    }

    impl TempSecretDir {
        fn new() -> Self {
            let path = std::env::temp_dir()
                .join(format!("llm-wiki-profile-secret-test-{}", Uuid::new_v4()));
            fs::create_dir_all(&path).expect("create temp dir");
            Self { path }
        }
    }

    impl Drop for TempSecretDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }

    #[test]
    fn in_memory_secret_store_round_trips_without_exposing_value_in_ref() {
        let store = InMemorySecretStore::default();

        let secret_ref = write_profile_secret(&store, "fake-test-secret").expect("write secret");

        assert!(secret_ref.starts_with(PROFILE_SECRET_REF_PREFIX));
        assert!(!secret_ref.contains("fake-test-secret"));
        assert_eq!(
            read_profile_secret(&store, &secret_ref).expect("read secret"),
            "fake-test-secret"
        );
        delete_profile_secret(&store, &secret_ref).expect("delete secret");
        assert!(read_profile_secret(&store, &secret_ref).is_err());
    }

    #[test]
    fn command_wrappers_write_and_delete_without_exposing_secret_values() {
        let store = InMemorySecretStore::default();

        let written = profile_secret_write_with_store(
            &store,
            ProfileSecretWriteRequest {
                secret_value: "fake-test-secret".to_string(),
            },
        )
        .expect("write secret");

        assert!(written.secret_ref.starts_with(PROFILE_SECRET_REF_PREFIX));
        assert!(!written.secret_ref.contains("fake-test-secret"));
        assert_eq!(
            read_profile_secret(&store, &written.secret_ref).expect("read secret"),
            "fake-test-secret"
        );

        let deleted = profile_secret_delete_with_store(
            &store,
            ProfileSecretDeleteRequest {
                secret_ref: written.secret_ref.clone(),
            },
        )
        .expect("delete secret");

        assert!(deleted.ok);
        assert!(read_profile_secret(&store, &written.secret_ref).is_err());
        let second_delete = profile_secret_delete_with_store(
            &store,
            ProfileSecretDeleteRequest {
                secret_ref: written.secret_ref,
            },
        )
        .expect("delete missing secret");
        assert!(second_delete.ok);
    }

    #[test]
    fn command_wrappers_reject_empty_secret_and_plain_refs() {
        let store = InMemorySecretStore::default();

        assert!(profile_secret_write_with_store(
            &store,
            ProfileSecretWriteRequest {
                secret_value: " ".to_string(),
            },
        )
        .is_err());
        assert!(profile_secret_delete_with_store(
            &store,
            ProfileSecretDeleteRequest {
                secret_ref: "sk-test-secret".to_string(),
            },
        )
        .is_err());
    }

    #[test]
    fn rejects_non_profile_secret_refs() {
        assert!(validate_profile_secret_ref("sk-test-secret").is_err());
        assert!(validate_profile_secret_ref("llm-wiki-profile-secret:sk-test-secret").is_err());
        assert!(validate_profile_secret_ref(
            "llm-wiki-profile-secret:550E8400-E29B-41D4-A716-446655440000",
        )
        .is_err());
        assert!(validate_profile_secret_ref("").is_err());
    }

    #[test]
    fn bounded_secret_error_truncates_on_utf8_boundaries() {
        let message = "错误".repeat(200);

        let bounded = bounded_secret_error("profile-secret-write-failed", message);

        assert!(bounded.starts_with("profile-secret-write-failed: "));
        assert!(bounded.len() <= "profile-secret-write-failed: ".len() + 240);
    }

    #[test]
    fn file_secret_store_round_trips_overwrites_and_deletes() {
        let temp = TempSecretDir::new();
        let store = FileSecretStore::new(temp.path.clone());
        let secret_ref = new_profile_secret_ref();
        let stale_temp = temp.path.join(".profile-secrets.json.stale.tmp");
        fs::write(&stale_temp, "stale").expect("write stale temp");

        store
            .write(&secret_ref, "fake-test-secret")
            .expect("write file secret");
        assert!(!stale_temp.exists());
        assert_eq!(
            store.read(&secret_ref).expect("read file secret"),
            "fake-test-secret"
        );

        store
            .write(&secret_ref, "fake-test-secret-updated")
            .expect("overwrite file secret");
        assert_eq!(
            store
                .read(&secret_ref)
                .expect("read overwritten file secret"),
            "fake-test-secret-updated"
        );

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(store.path())
                .expect("file metadata")
                .permissions()
                .mode()
                & 0o777;
            assert_eq!(mode, 0o600);
        }

        store.delete(&secret_ref).expect("delete file secret");
        assert!(store.read(&secret_ref).is_err());
    }

    #[test]
    fn file_secret_backend_defaults_to_file_and_persists_changes() {
        let temp = TempSecretDir::new();
        let store = FileSecretStore::new(temp.path.clone());

        assert_eq!(
            store.backend().expect("default backend"),
            ProfileSecretBackend::File
        );

        store
            .set_backend(ProfileSecretBackend::Keychain)
            .expect("set keychain backend");
        let reloaded = FileSecretStore::new(temp.path.clone());
        assert_eq!(
            reloaded.backend().expect("persisted backend"),
            ProfileSecretBackend::Keychain
        );

        reloaded
            .set_backend(ProfileSecretBackend::File)
            .expect("set file backend");
        assert_eq!(
            store.backend().expect("file backend"),
            ProfileSecretBackend::File
        );
    }

    #[test]
    fn migrating_secret_store_imports_fallback_value_once() {
        let active = Arc::new(InMemorySecretStore::default());
        let fallback = Arc::new(InMemorySecretStore::default());
        let secret_ref = new_profile_secret_ref();
        fallback.insert(&secret_ref, "fallback-secret");
        let store = MigratingSecretStore::new(
            ProfileSecretBackend::File,
            Box::new(active.clone()),
            ProfileSecretBackend::Keychain,
            Box::new(fallback.clone()),
        );

        assert_eq!(
            store.read(&secret_ref).expect("read fallback secret"),
            "fallback-secret"
        );
        assert_eq!(
            store.read(&secret_ref).expect("read imported secret"),
            "fallback-secret"
        );
        assert_eq!(fallback.read_count(), 1);
        assert_eq!(active.read_count(), 2);
    }

    #[test]
    fn migrating_secret_store_returns_fallback_value_when_write_back_fails() {
        let temp = TempSecretDir::new();
        fs::write(temp.path.join(PROFILE_SECRET_FILE_NAME), "{broken").expect("write broken file");
        let active = FileSecretStore::new(temp.path.clone());
        let fallback = Arc::new(InMemorySecretStore::default());
        let secret_ref = new_profile_secret_ref();
        fallback.insert(&secret_ref, "fallback-secret");
        let store = MigratingSecretStore::new(
            ProfileSecretBackend::File,
            Box::new(active),
            ProfileSecretBackend::Keychain,
            Box::new(fallback),
        );

        assert_eq!(
            store.read(&secret_ref).expect("read fallback despite write-back failure"),
            "fallback-secret"
        );
    }

    #[test]
    fn migrating_read_and_delete_do_not_resurrect_deleted_secret() {
        let temp = TempSecretDir::new();
        let active = FileSecretStore::new(temp.path.clone());
        let secret_ref = new_profile_secret_ref();
        let read_started = Arc::new(Barrier::new(2));
        let release_read = Arc::new(Barrier::new(2));
        let fallback = BlockingReadSecretStore {
            secret_ref: secret_ref.clone(),
            secret_value: "fallback-secret".to_string(),
            read_started: read_started.clone(),
            release_read: release_read.clone(),
        };
        let store = Arc::new(MigratingSecretStore::new(
            ProfileSecretBackend::File,
            Box::new(active.clone()),
            ProfileSecretBackend::Keychain,
            Box::new(fallback),
        ));

        let read_store = store.clone();
        let read_ref = secret_ref.clone();
        let read_thread = std::thread::spawn(move || read_store.read(&read_ref));
        read_started.wait();

        let delete_store = store.clone();
        let delete_ref = secret_ref.clone();
        let delete_thread = std::thread::spawn(move || delete_store.delete(&delete_ref));
        std::thread::sleep(Duration::from_millis(25));
        release_read.wait();

        assert_eq!(
            read_thread
                .join()
                .expect("join migrating read")
                .expect("read fallback secret"),
            "fallback-secret"
        );
        delete_thread
            .join()
            .expect("join delete")
            .expect("delete secret");
        assert!(active.read(&secret_ref).is_err());
    }

    #[test]
    fn keychain_active_migrates_from_file_fallback_without_clearing_file() {
        let temp = TempSecretDir::new();
        let file_store = FileSecretStore::new(temp.path.clone());
        let secret_ref = new_profile_secret_ref();
        file_store
            .write(&secret_ref, "file-secret")
            .expect("write file fallback secret");
        file_store
            .set_backend(ProfileSecretBackend::Keychain)
            .expect("switch backend");
        let keychain_store = Arc::new(InMemorySecretStore::default());
        let store = MigratingSecretStore::new(
            ProfileSecretBackend::Keychain,
            Box::new(keychain_store.clone()),
            ProfileSecretBackend::File,
            Box::new(file_store.clone()),
        );

        assert_eq!(
            store.read(&secret_ref).expect("read migrated file secret"),
            "file-secret"
        );
        assert_eq!(
            keychain_store.read(&secret_ref).expect("active received secret"),
            "file-secret"
        );
        assert_eq!(
            file_store.read(&secret_ref).expect("file fallback remains intact"),
            "file-secret"
        );
    }
}
