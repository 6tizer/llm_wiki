#![allow(dead_code)]

use crate::panic_guard::run_guarded;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

pub const PROFILE_SECRET_REF_PREFIX: &str = "llm-wiki-profile-secret:";
const UUID_TEXT_BYTES: usize = 36;
pub const PROFILE_SECRET_REF_BYTES: usize = PROFILE_SECRET_REF_PREFIX.len() + UUID_TEXT_BYTES;
// Keep this in sync with PROFILE_SECRET_REF_PREFIX and UUID_TEXT_BYTES; SQLite GLOB
// cannot be composed from Rust constants at runtime.
pub const PROFILE_SECRET_REF_SQL_GLOB: &str =
    "llm-wiki-profile-secret:[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]";
const PROFILE_SECRET_SERVICE: &str = "llm-wiki.profile-secret";

pub trait SecretStore {
    fn write(&self, secret_ref: &str, secret_value: &str) -> Result<(), String>;
    fn read(&self, secret_ref: &str) -> Result<String, String>;
    fn delete(&self, secret_ref: &str) -> Result<(), String>;
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
#[serde(rename_all = "camelCase")]
pub struct ProfileSecretWriteRequest {
    pub secret_value: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileSecretWriteResult {
    pub secret_ref: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileSecretDeleteRequest {
    pub secret_ref: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileSecretDeleteResult {
    pub ok: bool,
}

#[tauri::command]
pub fn profile_secret_write(
    request: ProfileSecretWriteRequest,
) -> Result<ProfileSecretWriteResult, String> {
    run_guarded("profile_secret_write", || {
        profile_secret_write_with_store(&OsSecretStore, request)
    })
}

#[tauri::command]
pub fn profile_secret_delete(
    request: ProfileSecretDeleteRequest,
) -> Result<ProfileSecretDeleteResult, String> {
    run_guarded("profile_secret_delete", || {
        profile_secret_delete_with_store(&OsSecretStore, request)
    })
}

fn profile_secret_write_with_store(
    store: &impl SecretStore,
    request: ProfileSecretWriteRequest,
) -> Result<ProfileSecretWriteResult, String> {
    Ok(ProfileSecretWriteResult {
        secret_ref: write_profile_secret(store, &request.secret_value)?,
    })
}

fn profile_secret_delete_with_store(
    store: &impl SecretStore,
    request: ProfileSecretDeleteRequest,
) -> Result<ProfileSecretDeleteResult, String> {
    delete_profile_secret(store, &request.secret_ref)?;
    Ok(ProfileSecretDeleteResult { ok: true })
}

pub fn new_profile_secret_ref() -> String {
    format!("{PROFILE_SECRET_REF_PREFIX}{}", Uuid::new_v4())
}

pub fn write_profile_secret(
    store: &impl SecretStore,
    secret_value: &str,
) -> Result<String, String> {
    let secret_value = require_secret_value(secret_value)?;
    let secret_ref = new_profile_secret_ref();
    store.write(&secret_ref, secret_value)?;
    Ok(secret_ref)
}

pub fn read_profile_secret(store: &impl SecretStore, secret_ref: &str) -> Result<String, String> {
    store.read(validate_profile_secret_ref(secret_ref)?)
}

pub fn delete_profile_secret(store: &impl SecretStore, secret_ref: &str) -> Result<(), String> {
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
    use std::sync::Mutex;

    #[derive(Default)]
    struct InMemorySecretStore {
        values: Mutex<HashMap<String, String>>,
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
}
