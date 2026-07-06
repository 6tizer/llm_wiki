use crate::commands::file_sync::ProjectRootState;
use crate::panic_guard::run_guarded;
use rusqlite::{params, Connection, OptionalExtension};
use std::path::{Path, PathBuf};
use tauri::State;

use super::*;
use crate::commands::profile_secrets::{PROFILE_SECRET_REF_BYTES, PROFILE_SECRET_REF_SQL_GLOB};
use std::time::{SystemTime, UNIX_EPOCH};

pub(crate) fn runtime_db_path(project_root: &Path) -> PathBuf {
    project_root.join(RUNTIME_DIR).join(RUNTIME_DB_FILE)
}

pub(crate) fn staging_dir_path(project_root: &Path) -> PathBuf {
    project_root.join(RUNTIME_DIR).join(STAGING_DIR)
}

/// Deny-list gate parser: unknown or malformed values intentionally enable
/// Work Runtime, so changing this back to an allow-list would silently
/// reintroduce production-default disablement.
fn parse_work_runtime_enabled(value: Option<&str>) -> bool {
    !matches!(
        value.map(str::trim).map(str::to_ascii_lowercase).as_deref(),
        Some("0" | "false" | "no" | "off")
    )
}

pub(crate) fn read_work_runtime_flag_value() -> Option<String> {
    std::env::var(WORK_RUNTIME_ENABLED_ENV).ok()
}

pub(crate) fn resolve_work_runtime_enabled(adapter_flag_value: Option<String>) -> bool {
    parse_work_runtime_enabled(adapter_flag_value.as_deref())
}

pub(crate) fn work_runtime_enabled_from_env() -> bool {
    resolve_work_runtime_enabled(read_work_runtime_flag_value())
}

/// Return runtime DB health/status.
///
/// When enabled, this command is an idempotent initializer: it may create
/// `<project>/.llm-wiki/runtime/`, open `runtime.db`, enable WAL, and apply
/// migration bookkeeping. It is not a pure read-only probe. When disabled or
/// when no project root is available, it does not touch disk.
#[tauri::command]
pub fn runtime_db_health(
    root_state: State<'_, ProjectRootState>,
) -> Result<RuntimeDbHealth, String> {
    run_guarded("runtime_db_health", || {
        let runtime_enabled = resolve_work_runtime_enabled(read_work_runtime_flag_value());
        let fallback_root = root_state.get();

        runtime_db_health_for_project(fallback_root.as_deref(), runtime_enabled)
    })
}

#[cfg(test)]
fn runtime_db_health_with_fallback(
    explicit_root: Option<PathBuf>,
    fallback_root: Option<PathBuf>,
    enabled: bool,
) -> Result<RuntimeDbHealth, String> {
    if !enabled {
        return runtime_db_health_for_project(explicit_root.as_deref(), false);
    }

    let project_root = explicit_root.or(fallback_root);
    runtime_db_health_for_project(project_root.as_deref(), true)
}

pub(crate) fn runtime_db_health_for_project(
    project_root: Option<&Path>,
    enabled: bool,
) -> Result<RuntimeDbHealth, String> {
    let project_path = project_root.map(path_to_string);

    if !enabled {
        return Ok(RuntimeDbHealth {
            enabled: false,
            status: RuntimeDbHealthState::Disabled,
            project_path,
            runtime_dir: None,
            db_path: None,
            journal_mode: None,
            migrations: Vec::new(),
        });
    }

    let Some(project_root) = project_root else {
        return Ok(RuntimeDbHealth {
            enabled: true,
            status: RuntimeDbHealthState::NoProject,
            project_path: None,
            runtime_dir: None,
            db_path: None,
            journal_mode: None,
            migrations: Vec::new(),
        });
    };

    initialize_runtime_db(project_root)
}

fn initialize_runtime_db(project_root: &Path) -> Result<RuntimeDbHealth, String> {
    with_runtime_writer(|| initialize_runtime_db_locked(project_root))
}

fn initialize_runtime_db_locked(project_root: &Path) -> Result<RuntimeDbHealth, String> {
    let (connection, runtime_dir, db_path, journal_mode) =
        open_initialized_runtime_db_locked(project_root)?;

    connection
        .execute(
            "CREATE TABLE IF NOT EXISTS runtime_schema_migrations (
                family TEXT PRIMARY KEY,
                version INTEGER NOT NULL,
                applied_at_ms INTEGER NOT NULL
            )",
            [],
        )
        .map_err(|err| format!("Failed to initialize runtime migrations table: {err}"))?;

    connection
        .execute(
            "INSERT OR IGNORE INTO runtime_schema_migrations (
                family,
                version,
                applied_at_ms
            ) VALUES (?1, ?2, ?3)",
            params![MIGRATIONS_FAMILY, MIGRATIONS_VERSION, now_ms()?],
        )
        .map_err(|err| format!("Failed to record runtime migration family: {err}"))?;

    Ok(RuntimeDbHealth {
        enabled: true,
        status: RuntimeDbHealthState::Healthy,
        project_path: Some(path_to_string(project_root)),
        runtime_dir: Some(path_to_string(&runtime_dir)),
        db_path: Some(path_to_string(&db_path)),
        journal_mode: Some(journal_mode),
        migrations: read_migrations(&connection)?,
    })
}

fn open_initialized_runtime_db_locked(
    project_root: &Path,
) -> Result<(Connection, PathBuf, PathBuf, String), String> {
    let runtime_dir = project_root.join(RUNTIME_DIR);
    let db_path = runtime_db_path(project_root);

    std::fs::create_dir_all(&runtime_dir).map_err(|err| {
        format!(
            "Failed to create runtime directory '{}': {err}",
            runtime_dir.display()
        )
    })?;

    let connection = open_runtime_connection(&db_path)?;
    let journal_mode = connection
        .query_row("PRAGMA journal_mode = WAL", [], |row| {
            row.get::<_, String>(0)
        })
        .map_err(|err| format!("Failed to enable WAL for '{}': {err}", db_path.display()))?;

    Ok((connection, runtime_dir, db_path, journal_mode))
}

pub(crate) fn with_runtime_writer<T>(
    body: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    let lock = RUNTIME_DB_WRITE_LOCK.get_or_init(|| Mutex::new(()));
    let _guard = lock.lock().map_err(|_| {
        "runtime-db-writer-poisoned: runtime DB writer lock is poisoned".to_string()
    })?;
    body()
}

pub(crate) fn run_project_write<T>(
    command_name: &'static str,
    root_state: State<'_, ProjectRootState>,
    body: impl FnOnce(Option<&Path>, bool, i64) -> Result<T, String>,
) -> Result<T, String> {
    run_guarded(command_name, || {
        let runtime_enabled = resolve_work_runtime_enabled(read_work_runtime_flag_value());
        let project_root = root_state.get();
        let now = now_for_enabled_project(project_root.as_deref(), runtime_enabled)?;
        body(project_root.as_deref(), runtime_enabled, now)
    })
}

pub(crate) fn run_project_read<T>(
    command_name: &'static str,
    root_state: State<'_, ProjectRootState>,
    body: impl FnOnce(Option<&Path>, bool) -> Result<T, String>,
) -> Result<T, String> {
    run_guarded(command_name, || {
        body(
            root_state.get().as_deref(),
            resolve_work_runtime_enabled(read_work_runtime_flag_value()),
        )
    })
}

fn open_runtime_connection(db_path: &Path) -> Result<Connection, String> {
    let connection = Connection::open(db_path)
        .map_err(|err| format!("Failed to open runtime DB '{}': {err}", db_path.display()))?;
    enable_foreign_keys(&connection)?;
    Ok(connection)
}

fn enable_foreign_keys(connection: &Connection) -> Result<(), String> {
    connection
        .execute("PRAGMA foreign_keys = ON", [])
        .map_err(|err| format!("Failed to enable SQLite foreign keys: {err}"))?;
    let enabled = connection
        .query_row("PRAGMA foreign_keys", [], |row| row.get::<_, i64>(0))
        .map_err(|err| format!("Failed to verify SQLite foreign keys: {err}"))?;
    if enabled == 1 {
        Ok(())
    } else {
        Err("foreign-keys-disabled: SQLite foreign key enforcement is disabled".to_string())
    }
}

pub(crate) fn open_job_runtime_locked(project_root: &Path) -> Result<Connection, String> {
    initialize_runtime_db_locked(project_root)?;
    let connection = open_runtime_connection(&runtime_db_path(project_root))?;
    initialize_job_schema(&connection)?;
    Ok(connection)
}

fn initialize_job_schema(connection: &Connection) -> Result<(), String> {
    connection
        .execute(
            "CREATE TABLE IF NOT EXISTS runtime_jobs (
                job_id TEXT PRIMARY KEY,
                kind TEXT NOT NULL,
                payload TEXT NOT NULL,
                state TEXT NOT NULL CHECK (
                    state IN (
                        'queued',
                        'running',
                        'paused',
                        'completed',
                        'failed',
                        'cancelled',
                        'retry-wait'
                    )
                ),
                attempt INTEGER NOT NULL,
                max_attempts INTEGER NOT NULL,
                priority INTEGER NOT NULL,
                created_at_ms INTEGER NOT NULL,
                updated_at_ms INTEGER NOT NULL,
                queued_at_ms INTEGER,
                started_at_ms INTEGER,
                completed_at_ms INTEGER,
                failed_at_ms INTEGER,
                cancelled_at_ms INTEGER,
                retry_after_ms INTEGER,
                last_error TEXT
            )",
            [],
        )
        .map_err(|err| format!("Failed to initialize runtime jobs table: {err}"))?;

    connection
        .execute(
            "CREATE TABLE IF NOT EXISTS runtime_job_leases (
                lease_id TEXT PRIMARY KEY,
                job_id TEXT NOT NULL,
                holder TEXT NOT NULL,
                acquired_at_ms INTEGER NOT NULL,
                heartbeat_at_ms INTEGER NOT NULL,
                expires_at_ms INTEGER NOT NULL,
                released_at_ms INTEGER,
                status TEXT NOT NULL CHECK (
                    status IN ('active', 'released', 'expired', 'cancelled')
                ),
                FOREIGN KEY(job_id) REFERENCES runtime_jobs(job_id)
            )",
            [],
        )
        .map_err(|err| format!("Failed to initialize runtime job leases table: {err}"))?;

    connection
        .execute(
            "CREATE INDEX IF NOT EXISTS runtime_jobs_claim_idx
             ON runtime_jobs(state, priority DESC, queued_at_ms ASC, created_at_ms ASC)",
            [],
        )
        .map_err(|err| format!("Failed to initialize runtime jobs claim index: {err}"))?;
    connection
        .execute(
            "CREATE INDEX IF NOT EXISTS runtime_jobs_retry_idx
             ON runtime_jobs(state, retry_after_ms)",
            [],
        )
        .map_err(|err| format!("Failed to initialize runtime jobs retry index: {err}"))?;
    connection
        .execute(
            "CREATE INDEX IF NOT EXISTS runtime_job_leases_job_active_idx
             ON runtime_job_leases(job_id, status)",
            [],
        )
        .map_err(|err| format!("Failed to initialize runtime job lease index: {err}"))?;
    connection
        .execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS runtime_job_active_lease_unique_idx
             ON runtime_job_leases(job_id)
             WHERE status = 'active'",
            [],
        )
        .map_err(|err| format!("Failed to initialize runtime active lease index: {err}"))?;
    connection
        .execute(
            "CREATE INDEX IF NOT EXISTS runtime_job_leases_expiry_idx
             ON runtime_job_leases(status, expires_at_ms)",
            [],
        )
        .map_err(|err| format!("Failed to initialize runtime lease expiry index: {err}"))?;

    record_migration_family(connection, JOBS_FAMILY, JOBS_VERSION)?;
    record_migration_family(connection, LEASES_FAMILY, LEASES_VERSION)
}

pub(crate) fn open_resource_budget_runtime_locked(
    project_root: &Path,
) -> Result<Connection, String> {
    let connection = open_job_runtime_locked(project_root)?;
    initialize_resource_budget_schema(&connection)?;
    Ok(connection)
}

pub(crate) fn open_events_progress_runtime_locked(
    project_root: &Path,
) -> Result<Connection, String> {
    let connection = open_job_runtime_locked(project_root)?;
    initialize_events_progress_schema(&connection)?;
    Ok(connection)
}

pub(crate) fn open_staging_artifacts_runtime_locked(
    project_root: &Path,
) -> Result<Connection, String> {
    let connection = open_job_runtime_locked(project_root)?;
    initialize_staging_artifacts_schema(&connection)?;
    Ok(connection)
}

pub(crate) fn open_derived_stale_markers_runtime_locked(
    project_root: &Path,
) -> Result<Connection, String> {
    let connection = open_events_progress_runtime_locked(project_root)?;
    initialize_derived_stale_markers_schema(&connection)?;
    Ok(connection)
}

pub(crate) fn open_profile_runtime_locked(project_root: &Path) -> Result<Connection, String> {
    initialize_runtime_db_locked(project_root)?;
    let connection = open_runtime_connection(&runtime_db_path(project_root))?;
    initialize_profile_schema(&connection)?;
    Ok(connection)
}

pub(crate) fn open_profile_pool_runtime_locked(project_root: &Path) -> Result<Connection, String> {
    let connection = open_events_progress_runtime_locked(project_root)?;
    initialize_profile_schema(&connection)?;
    initialize_profile_pool_schema(&connection)?;
    initialize_task_family_policy_schema(&connection)?;
    Ok(connection)
}

fn initialize_resource_budget_schema(connection: &Connection) -> Result<(), String> {
    connection
        .execute(
            "CREATE TABLE IF NOT EXISTS runtime_resource_budgets (
                scope TEXT NOT NULL CHECK (scope IN ('commit-total', 'commit-path')),
                resource_key TEXT NOT NULL,
                display_key TEXT NOT NULL,
                capacity INTEGER NOT NULL CHECK (capacity >= 1),
                created_at_ms INTEGER NOT NULL,
                updated_at_ms INTEGER NOT NULL,
                PRIMARY KEY(scope, resource_key)
            )",
            [],
        )
        .map_err(|err| format!("Failed to initialize runtime resource budgets table: {err}"))?;

    connection
        .execute(
            "CREATE TABLE IF NOT EXISTS runtime_resource_budget_claims (
                claim_id TEXT NOT NULL,
                scope TEXT NOT NULL CHECK (scope IN ('commit-total', 'commit-path')),
                resource_key TEXT NOT NULL,
                display_key TEXT NOT NULL,
                job_id TEXT,
                holder TEXT NOT NULL,
                amount INTEGER NOT NULL CHECK (amount >= 1),
                acquired_at_ms INTEGER NOT NULL,
                expires_at_ms INTEGER NOT NULL,
                released_at_ms INTEGER,
                status TEXT NOT NULL CHECK (status IN ('active', 'released', 'expired')),
                PRIMARY KEY(claim_id, scope, resource_key),
                FOREIGN KEY(scope, resource_key)
                    REFERENCES runtime_resource_budgets(scope, resource_key),
                FOREIGN KEY(job_id) REFERENCES runtime_jobs(job_id)
            )",
            [],
        )
        .map_err(|err| {
            format!("Failed to initialize runtime resource budget claims table: {err}")
        })?;

    connection
        .execute(
            "CREATE INDEX IF NOT EXISTS runtime_resource_claims_active_idx
             ON runtime_resource_budget_claims(scope, resource_key, status, expires_at_ms)",
            [],
        )
        .map_err(|err| {
            format!("Failed to initialize runtime resource claim active index: {err}")
        })?;
    connection
        .execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS runtime_commit_path_active_unique_idx
             ON runtime_resource_budget_claims(resource_key)
             WHERE scope = 'commit-path' AND status = 'active'",
            [],
        )
        .map_err(|err| format!("Failed to initialize runtime commit path unique index: {err}"))?;
    connection
        .execute(
            "CREATE INDEX IF NOT EXISTS runtime_resource_claims_claim_idx
             ON runtime_resource_budget_claims(claim_id, status)",
            [],
        )
        .map_err(|err| format!("Failed to initialize runtime resource claim id index: {err}"))?;
    connection
        .execute(
            "CREATE INDEX IF NOT EXISTS runtime_resource_claims_job_idx
             ON runtime_resource_budget_claims(job_id, status)",
            [],
        )
        .map_err(|err| format!("Failed to initialize runtime resource claim job index: {err}"))?;

    connection
        .execute(
            "INSERT OR IGNORE INTO runtime_resource_budgets (
                scope,
                resource_key,
                display_key,
                capacity,
                created_at_ms,
                updated_at_ms
            ) VALUES (?1, ?2, ?2, ?3, ?4, ?4)",
            params![
                COMMIT_TOTAL_SCOPE,
                COMMIT_TOTAL_RESOURCE_KEY,
                DEFAULT_COMMIT_TOTAL_CAPACITY,
                now_ms()?
            ],
        )
        .map_err(|err| format!("Failed to initialize runtime commit total budget: {err}"))?;
    record_migration_family(
        connection,
        RESOURCE_BUDGETS_FAMILY,
        RESOURCE_BUDGETS_VERSION,
    )
}

fn initialize_events_progress_schema(connection: &Connection) -> Result<(), String> {
    connection
        .execute(
            &format!(
                "CREATE TABLE IF NOT EXISTS runtime_events (
                    event_id TEXT PRIMARY KEY CHECK(length(event_id) > 0),
                    job_id TEXT NOT NULL CHECK(length(job_id) > 0),
                    event_name TEXT NOT NULL CHECK(length(event_name) > 0),
                    payload TEXT NOT NULL CHECK(
                        length(CAST(payload AS BLOB)) > 0
                        AND length(CAST(payload AS BLOB)) <= {MAX_EVENT_PAYLOAD_BYTES}
                    ),
                    created_at_ms INTEGER NOT NULL CHECK(created_at_ms >= 0),
                    FOREIGN KEY(job_id) REFERENCES runtime_jobs(job_id)
                )"
            ),
            [],
        )
        .map_err(|err| format!("Failed to initialize runtime events table: {err}"))?;

    connection
        .execute(
            &format!(
                "CREATE TABLE IF NOT EXISTS runtime_progress (
                    job_id TEXT NOT NULL CHECK(length(job_id) > 0),
                    progress_key TEXT NOT NULL CHECK(length(progress_key) > 0),
                    payload TEXT NOT NULL CHECK(
                        length(CAST(payload AS BLOB)) > 0
                        AND length(CAST(payload AS BLOB)) <= {MAX_EVENT_PAYLOAD_BYTES}
                    ),
                    updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= 0),
                    last_event_id TEXT,
                    PRIMARY KEY(job_id, progress_key),
                    FOREIGN KEY(job_id) REFERENCES runtime_jobs(job_id),
                    FOREIGN KEY(last_event_id) REFERENCES runtime_events(event_id)
                )"
            ),
            [],
        )
        .map_err(|err| format!("Failed to initialize runtime progress table: {err}"))?;

    connection
        .execute(
            "CREATE INDEX IF NOT EXISTS runtime_events_job_time_idx
             ON runtime_events(job_id, created_at_ms, event_id)",
            [],
        )
        .map_err(|err| format!("Failed to initialize runtime events job-time index: {err}"))?;
    connection
        .execute(
            "CREATE INDEX IF NOT EXISTS runtime_events_time_idx
             ON runtime_events(created_at_ms, event_id)",
            [],
        )
        .map_err(|err| format!("Failed to initialize runtime events time index: {err}"))?;
    connection
        .execute(
            "CREATE INDEX IF NOT EXISTS runtime_progress_updated_idx
             ON runtime_progress(updated_at_ms, job_id, progress_key)",
            [],
        )
        .map_err(|err| format!("Failed to initialize runtime progress updated index: {err}"))?;

    record_migration_family(connection, EVENTS_PROGRESS_FAMILY, EVENTS_PROGRESS_VERSION)
}

fn initialize_staging_artifacts_schema(connection: &Connection) -> Result<(), String> {
    connection
        .execute(
            &format!(
                "CREATE TABLE IF NOT EXISTS runtime_staging_artifacts (
                    artifact_id TEXT PRIMARY KEY CHECK(length(artifact_id) > 0),
                    job_id TEXT NOT NULL CHECK(length(job_id) > 0),
                    artifact_path TEXT NOT NULL CHECK(
                        length(CAST(artifact_path AS BLOB)) > 0
                        AND length(CAST(artifact_path AS BLOB)) <= {MAX_STAGING_ARTIFACT_PATH_BYTES}
                    ),
                    artifact_hash TEXT NOT NULL CHECK(
                        length(CAST(artifact_hash AS BLOB)) > 0
                        AND length(CAST(artifact_hash AS BLOB)) <= {MAX_STAGING_ARTIFACT_HASH_BYTES}
                    ),
                    target_path TEXT CHECK(
                        target_path IS NULL
                        OR (
                            length(CAST(target_path AS BLOB)) > 0
                            AND length(CAST(target_path AS BLOB)) <= {MAX_STAGING_ARTIFACT_PATH_BYTES}
                        )
                    ),
                    operation_intent TEXT CHECK(
                        operation_intent IS NULL
                        OR operation_intent IN ('create', 'update', 'append', 'delete')
                    ),
                    base_hash TEXT CHECK(
                        base_hash IS NULL
                        OR (
                            length(CAST(base_hash AS BLOB)) > 0
                            AND length(CAST(base_hash AS BLOB)) <= {MAX_STAGING_ARTIFACT_HASH_BYTES}
                        )
                    ),
                    source_kind TEXT CHECK(
                        source_kind IS NULL
                        OR (
                            length(CAST(source_kind AS BLOB)) > 0
                            AND length(CAST(source_kind AS BLOB)) <= {MAX_STAGING_ARTIFACT_SOURCE_KIND_BYTES}
                        )
                    ),
                    status TEXT NOT NULL CHECK (
                        status IN ('pending', 'committed', 'failed', 'cancelled', 'deleted')
                    ),
                    created_at_ms INTEGER NOT NULL CHECK(created_at_ms >= 0),
                    updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= 0),
                    expires_at_ms INTEGER CHECK(expires_at_ms IS NULL OR expires_at_ms >= 0),
                    deleted_at_ms INTEGER CHECK(deleted_at_ms IS NULL OR deleted_at_ms >= 0),
                    last_error TEXT CHECK(
                        last_error IS NULL
                        OR length(CAST(last_error AS BLOB)) <= {MAX_STAGING_ARTIFACT_ERROR_BYTES}
                    ),
                    FOREIGN KEY(job_id) REFERENCES runtime_jobs(job_id)
                )"
            ),
            [],
        )
        .map_err(|err| format!("Failed to initialize runtime staging artifacts table: {err}"))?;

    ensure_column_exists(
        connection,
        "runtime_staging_artifacts",
        "target_path",
        &format!(
            "ALTER TABLE runtime_staging_artifacts
             ADD COLUMN target_path TEXT CHECK(
                 target_path IS NULL
                 OR (
                     length(CAST(target_path AS BLOB)) > 0
                     AND length(CAST(target_path AS BLOB)) <= {MAX_STAGING_ARTIFACT_PATH_BYTES}
                 )
             )"
        ),
        "runtime staging artifact target_path",
    )?;
    ensure_column_exists(
        connection,
        "runtime_staging_artifacts",
        "operation_intent",
        "ALTER TABLE runtime_staging_artifacts
         ADD COLUMN operation_intent TEXT CHECK(
             operation_intent IS NULL
             OR operation_intent IN ('create', 'update', 'append', 'delete')
         )",
        "runtime staging artifact operation_intent",
    )?;
    ensure_column_exists(
        connection,
        "runtime_staging_artifacts",
        "base_hash",
        &format!(
            "ALTER TABLE runtime_staging_artifacts
             ADD COLUMN base_hash TEXT CHECK(
                 base_hash IS NULL
                 OR (
                     length(CAST(base_hash AS BLOB)) > 0
                     AND length(CAST(base_hash AS BLOB)) <= {MAX_STAGING_ARTIFACT_HASH_BYTES}
                 )
             )"
        ),
        "runtime staging artifact base_hash",
    )?;
    ensure_column_exists(
        connection,
        "runtime_staging_artifacts",
        "source_kind",
        &format!(
            "ALTER TABLE runtime_staging_artifacts
             ADD COLUMN source_kind TEXT CHECK(
                 source_kind IS NULL
                 OR (
                     length(CAST(source_kind AS BLOB)) > 0
                     AND length(CAST(source_kind AS BLOB)) <= {MAX_STAGING_ARTIFACT_SOURCE_KIND_BYTES}
                 )
             )"
        ),
        "runtime staging artifact source_kind",
    )?;

    connection
        .execute(
            "CREATE INDEX IF NOT EXISTS runtime_staging_artifacts_job_idx
             ON runtime_staging_artifacts(job_id, status)",
            [],
        )
        .map_err(|err| {
            format!("Failed to initialize runtime staging artifacts job index: {err}")
        })?;
    connection
        .execute(
            "CREATE INDEX IF NOT EXISTS runtime_staging_artifacts_gc_idx
             ON runtime_staging_artifacts(status, expires_at_ms)",
            [],
        )
        .map_err(|err| format!("Failed to initialize runtime staging artifacts GC index: {err}"))?;

    record_migration_family(
        connection,
        STAGING_ARTIFACTS_FAMILY,
        STAGING_ARTIFACTS_VERSION,
    )
}

fn initialize_derived_stale_markers_schema(connection: &Connection) -> Result<(), String> {
    connection
        .execute(
            &format!(
                "CREATE TABLE IF NOT EXISTS runtime_derived_stale_markers (
                    marker_id TEXT PRIMARY KEY CHECK(length(marker_id) > 0),
                    layer TEXT NOT NULL CHECK (
                        layer IN (
                            'embedding',
                            'graph',
                            'taxonomy',
                            'synthesis',
                            'search',
                            'index_export',
                            'overview'
                        )
                    ),
                    affected_path TEXT NOT NULL CHECK(length(affected_path) > 0),
                    input_hash TEXT CHECK(
                        input_hash IS NULL
                        OR length(CAST(input_hash AS BLOB)) <= {MAX_STAGING_ARTIFACT_HASH_BYTES}
                    ),
                    base_version TEXT NOT NULL CHECK(
                        length(CAST(base_version AS BLOB)) > 0
                        AND length(CAST(base_version AS BLOB)) <= {MAX_DERIVED_MARKER_BASE_VERSION_BYTES}
                    ),
                    marked_at_ms INTEGER NOT NULL CHECK(marked_at_ms >= 0),
                    reason TEXT NOT NULL CHECK (
                        reason IN ('commit', 'delete', 'schema_change', 'manual_rebuild')
                    ),
                    source_event_id TEXT NOT NULL,
                    status TEXT NOT NULL CHECK (
                        status IN ('pending', 'claimed', 'done', 'failed', 'cancelled')
                    ),
                    updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= 0),
                    last_error TEXT CHECK(
                        last_error IS NULL
                        OR length(CAST(last_error AS BLOB)) <= {MAX_STAGING_ARTIFACT_ERROR_BYTES}
                    ),
                    FOREIGN KEY(source_event_id) REFERENCES runtime_events(event_id)
                )"
            ),
            [],
        )
        .map_err(|err| {
            format!("Failed to initialize runtime derived stale markers table: {err}")
        })?;

    connection
        .execute(
            "CREATE INDEX IF NOT EXISTS runtime_derived_markers_status_idx
             ON runtime_derived_stale_markers(status, layer, marked_at_ms, marker_id)",
            [],
        )
        .map_err(|err| {
            format!("Failed to initialize runtime derived marker status index: {err}")
        })?;
    connection
        .execute(
            "CREATE INDEX IF NOT EXISTS runtime_derived_markers_path_idx
             ON runtime_derived_stale_markers(affected_path, layer, status)",
            [],
        )
        .map_err(|err| format!("Failed to initialize runtime derived marker path index: {err}"))?;
    connection
        .execute(
            "CREATE INDEX IF NOT EXISTS runtime_derived_markers_event_idx
             ON runtime_derived_stale_markers(source_event_id)",
            [],
        )
        .map_err(|err| format!("Failed to initialize runtime derived marker event index: {err}"))?;

    record_migration_family(
        connection,
        DERIVED_STALE_MARKERS_FAMILY,
        DERIVED_STALE_MARKERS_VERSION,
    )
}

fn initialize_profile_schema(connection: &Connection) -> Result<(), String> {
    connection
        .execute(
            &format!(
                "CREATE TABLE IF NOT EXISTS runtime_model_profiles (
                    profile_id TEXT PRIMARY KEY CHECK(
                        length(CAST(profile_id AS BLOB)) > 0
                        AND length(CAST(profile_id AS BLOB)) <= {MAX_PROFILE_ID_BYTES}
                    ),
                    kind TEXT NOT NULL CHECK(kind IN ('model-call', 'agent-run')),
                    display_name TEXT NOT NULL CHECK(
                        length(CAST(display_name AS BLOB)) > 0
                        AND length(CAST(display_name AS BLOB)) <= {MAX_PROFILE_DISPLAY_NAME_BYTES}
                    ),
                    provider_id TEXT NOT NULL CHECK(
                        length(CAST(provider_id AS BLOB)) > 0
                        AND length(CAST(provider_id AS BLOB)) <= {MAX_PROFILE_PROVIDER_BYTES}
                    ),
                    model_id TEXT NOT NULL CHECK(
                        length(CAST(model_id AS BLOB)) > 0
                        AND length(CAST(model_id AS BLOB)) <= {MAX_PROFILE_MODEL_BYTES}
                    ),
                    agent_sdk_model_id TEXT CHECK(
                        agent_sdk_model_id IS NULL
                        OR (
                            length(CAST(agent_sdk_model_id AS BLOB)) > 0
                            AND length(CAST(agent_sdk_model_id AS BLOB)) <= {MAX_PROFILE_SDK_MODEL_BYTES}
                        )
                    ),
                    endpoint TEXT CHECK(
                        endpoint IS NULL
                        OR length(CAST(endpoint AS BLOB)) <= {MAX_PROFILE_ENDPOINT_BYTES}
                    ),
                    api_mode TEXT NOT NULL CHECK(
                        api_mode IN (
                            'openai-chat-completions',
                            'anthropic-messages',
                            'google-generate-content',
                            'local-cli'
                        )
                    ),
                    auth_style TEXT NOT NULL CHECK(
                        auth_style IN ('none', 'bearer', 'x-api-key', 'api-key', 'oauth-local-cli')
                    ),
                    secret_ref TEXT CHECK(
                        secret_ref IS NULL
                        OR (
                            length(CAST(secret_ref AS BLOB)) = {PROFILE_SECRET_REF_BYTES}
                            AND secret_ref GLOB '{PROFILE_SECRET_REF_SQL_GLOB}'
                        )
                    ),
                    enabled INTEGER NOT NULL CHECK(enabled IN (0, 1)),
                    task_families_json TEXT NOT NULL CHECK(
                        length(CAST(task_families_json AS BLOB)) > 0
                        AND length(CAST(task_families_json AS BLOB)) <= {MAX_PROFILE_TASK_FAMILIES_BYTES}
                    ),
                    max_concurrency INTEGER NOT NULL CHECK(
                        max_concurrency >= 1 AND max_concurrency <= {MAX_PROFILE_CONCURRENCY}
                    ),
                    capability_status TEXT NOT NULL CHECK(
                        capability_status IN ('unknown', 'supported', 'limited', 'unsupported', 'error')
                    ),
                    capability_json TEXT NOT NULL CHECK(
                        length(CAST(capability_json AS BLOB)) > 0
                        AND length(CAST(capability_json AS BLOB)) <= {MAX_PROFILE_CAPABILITY_JSON_BYTES}
                    ),
                    capability_version TEXT NOT NULL CHECK(
                        length(CAST(capability_version AS BLOB)) > 0
                        AND length(CAST(capability_version AS BLOB)) <= {MAX_PROFILE_CAPABILITY_VERSION_BYTES}
                    ),
                    capability_checked_at_ms INTEGER CHECK(
                        capability_checked_at_ms IS NULL OR capability_checked_at_ms >= 0
                    ),
                    probe_backoff_until_ms INTEGER CHECK(
                        probe_backoff_until_ms IS NULL OR probe_backoff_until_ms >= 0
                    ),
                    last_capability_error TEXT CHECK(
                        last_capability_error IS NULL
                        OR length(CAST(last_capability_error AS BLOB)) <= {MAX_PROFILE_CAPABILITY_ERROR_BYTES}
                    ),
                    created_at_ms INTEGER NOT NULL CHECK(created_at_ms >= 0),
                    updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= 0),
                    deleted_at_ms INTEGER CHECK(deleted_at_ms IS NULL OR deleted_at_ms >= 0)
                )"
            ),
            [],
        )
        .map_err(|err| format!("Failed to initialize runtime model profiles table: {err}"))?;
    ensure_column_exists(
        connection,
        "runtime_model_profiles",
        "deleted_at_ms",
        "ALTER TABLE runtime_model_profiles
         ADD COLUMN deleted_at_ms INTEGER CHECK(deleted_at_ms IS NULL OR deleted_at_ms >= 0)",
        "runtime model profile deleted_at_ms",
    )?;
    ensure_column_exists(
        connection,
        "runtime_model_profiles",
        "agent_sdk_model_id",
        &format!(
            "ALTER TABLE runtime_model_profiles
             ADD COLUMN agent_sdk_model_id TEXT CHECK(
                 agent_sdk_model_id IS NULL
                 OR (
                     length(CAST(agent_sdk_model_id AS BLOB)) > 0
                     AND length(CAST(agent_sdk_model_id AS BLOB)) <= {MAX_PROFILE_SDK_MODEL_BYTES}
                 )
             )"
        ),
        "runtime model profile agent_sdk_model_id",
    )?;

    connection
        .execute(
            "CREATE INDEX IF NOT EXISTS runtime_model_profiles_kind_idx
             ON runtime_model_profiles(kind, enabled, provider_id, model_id)",
            [],
        )
        .map_err(|err| format!("Failed to initialize runtime model profiles kind index: {err}"))?;
    connection
        .execute(
            "CREATE INDEX IF NOT EXISTS runtime_model_profiles_status_idx
             ON runtime_model_profiles(capability_status, updated_at_ms, profile_id)",
            [],
        )
        .map_err(|err| {
            format!("Failed to initialize runtime model profiles status index: {err}")
        })?;
    connection
        .execute(
            "CREATE INDEX IF NOT EXISTS runtime_model_profiles_visible_idx
             ON runtime_model_profiles(deleted_at_ms, kind, enabled, updated_at_ms, profile_id)",
            [],
        )
        .map_err(|err| {
            format!("Failed to initialize runtime model profiles visibility index: {err}")
        })?;

    record_migration_family(connection, PROFILE_STATUS_FAMILY, PROFILE_STATUS_VERSION)
}

fn initialize_profile_pool_schema(connection: &Connection) -> Result<(), String> {
    connection
        .execute(
            &format!(
                "CREATE TABLE IF NOT EXISTS runtime_profile_claims (
                    claim_id TEXT PRIMARY KEY CHECK(
                        length(CAST(claim_id AS BLOB)) > 0
                        AND length(CAST(claim_id AS BLOB)) <= {MAX_PROFILE_ID_BYTES}
                    ),
                    profile_id TEXT NOT NULL CHECK(
                        length(CAST(profile_id AS BLOB)) > 0
                        AND length(CAST(profile_id AS BLOB)) <= {MAX_PROFILE_ID_BYTES}
                    ),
                    kind TEXT NOT NULL CHECK(kind IN ('model-call', 'agent-run')),
                    task_family TEXT NOT NULL CHECK(
                        length(CAST(task_family AS BLOB)) > 0
                        AND length(CAST(task_family AS BLOB)) <= {MAX_PROFILE_TASK_FAMILY_BYTES}
                    ),
                    job_id TEXT,
                    holder TEXT NOT NULL CHECK(length(CAST(holder AS BLOB)) > 0),
                    acquired_at_ms INTEGER NOT NULL CHECK(acquired_at_ms >= 0),
                    expires_at_ms INTEGER NOT NULL CHECK(expires_at_ms >= 0),
                    released_at_ms INTEGER CHECK(released_at_ms IS NULL OR released_at_ms >= 0),
                    status TEXT NOT NULL CHECK(status IN ('active', 'released', 'expired')),
                    FOREIGN KEY(profile_id) REFERENCES runtime_model_profiles(profile_id),
                    FOREIGN KEY(job_id) REFERENCES runtime_jobs(job_id)
                )"
            ),
            [],
        )
        .map_err(|err| format!("Failed to initialize runtime profile claims table: {err}"))?;

    connection
        .execute(
            &format!(
                "CREATE TABLE IF NOT EXISTS runtime_profile_circuit_breakers (
                    profile_id TEXT PRIMARY KEY CHECK(
                        length(CAST(profile_id AS BLOB)) > 0
                        AND length(CAST(profile_id AS BLOB)) <= {MAX_PROFILE_ID_BYTES}
                    ),
                    status TEXT NOT NULL CHECK(status IN ('rate-limited', 'error')),
                    reason TEXT CHECK(
                        reason IS NULL
                        OR length(CAST(reason AS BLOB)) <= {MAX_PROFILE_POOL_REASON_BYTES}
                    ),
                    error TEXT CHECK(
                        error IS NULL
                        OR length(CAST(error AS BLOB)) <= {MAX_PROFILE_POOL_REASON_BYTES}
                    ),
                    opened_at_ms INTEGER NOT NULL CHECK(opened_at_ms >= 0),
                    open_until_ms INTEGER NOT NULL CHECK(open_until_ms >= 0),
                    updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= 0),
                    FOREIGN KEY(profile_id) REFERENCES runtime_model_profiles(profile_id)
                )"
            ),
            [],
        )
        .map_err(|err| {
            format!("Failed to initialize runtime profile circuit breakers table: {err}")
        })?;

    connection
        .execute(
            "CREATE INDEX IF NOT EXISTS runtime_profile_claims_active_idx
             ON runtime_profile_claims(profile_id, status, expires_at_ms)",
            [],
        )
        .map_err(|err| format!("Failed to initialize runtime profile active claim index: {err}"))?;
    connection
        .execute(
            "CREATE INDEX IF NOT EXISTS runtime_profile_claims_job_idx
             ON runtime_profile_claims(job_id, status)",
            [],
        )
        .map_err(|err| format!("Failed to initialize runtime profile claim job index: {err}"))?;
    connection
        .execute(
            "CREATE INDEX IF NOT EXISTS runtime_profile_breakers_open_idx
             ON runtime_profile_circuit_breakers(open_until_ms, profile_id)",
            [],
        )
        .map_err(|err| format!("Failed to initialize runtime profile breaker index: {err}"))?;

    record_migration_family(connection, PROFILE_POOL_FAMILY, PROFILE_POOL_VERSION)
}

fn initialize_task_family_policy_schema(connection: &Connection) -> Result<(), String> {
    connection
        .execute(
            &format!(
                "CREATE TABLE IF NOT EXISTS runtime_task_family_policies (
                    task_family TEXT PRIMARY KEY CHECK(
                        length(CAST(task_family AS BLOB)) > 0
                        AND length(CAST(task_family AS BLOB)) <= {MAX_PROFILE_TASK_FAMILY_BYTES}
                    ),
                    profile_order TEXT NOT NULL DEFAULT '[]' CHECK(
                        length(CAST(profile_order AS BLOB)) > 0
                        AND length(CAST(profile_order AS BLOB)) <= {MAX_TASK_POLICY_PROFILE_ORDER_BYTES}
                    ),
                    auto_failover INTEGER NOT NULL DEFAULT 1 CHECK(auto_failover IN (0, 1)),
                    updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= 0)
                )"
            ),
            [],
        )
        .map_err(|err| {
            format!("Failed to initialize runtime task family policies table: {err}")
        })?;

    record_migration_family(
        connection,
        TASK_FAMILY_POLICIES_FAMILY,
        TASK_FAMILY_POLICIES_VERSION,
    )
}

fn record_migration_family(
    connection: &Connection,
    family: &str,
    version: i64,
) -> Result<(), String> {
    connection
        .execute(
            "INSERT OR IGNORE INTO runtime_schema_migrations (
                family,
                version,
                applied_at_ms
            ) VALUES (?1, ?2, ?3)",
            params![family, version, now_ms()?],
        )
        .map_err(|err| format!("Failed to record runtime migration family '{family}': {err}"))?;
    Ok(())
}

pub(crate) fn table_exists(connection: &Connection, table: &str) -> Result<bool, String> {
    connection
        .query_row(
            "SELECT 1
             FROM sqlite_master
             WHERE type = 'table' AND name = ?1
             LIMIT 1",
            [table],
            |_| Ok(()),
        )
        .optional()
        .map(|value| value.is_some())
        .map_err(|err| format!("table-exists-check-failed: {err}"))
}

pub(crate) fn column_exists(
    connection: &Connection,
    table: &str,
    column: &str,
) -> Result<bool, String> {
    connection
        .query_row(
            &format!("SELECT 1 FROM pragma_table_info('{table}') WHERE name = ?1 LIMIT 1"),
            [column],
            |_| Ok(()),
        )
        .optional()
        .map(|value| value.is_some())
        .map_err(|err| format!("column-exists-check-failed: {err}"))
}

pub(crate) fn staging_artifact_commit_metadata_columns_exist(
    connection: &Connection,
) -> Result<bool, String> {
    for column in [
        "target_path",
        "operation_intent",
        "base_hash",
        "source_kind",
    ] {
        if !column_exists(connection, "runtime_staging_artifacts", column)? {
            return Ok(false);
        }
    }
    Ok(true)
}

fn ensure_column_exists(
    connection: &Connection,
    table: &str,
    column: &str,
    alter_sql: &str,
    label: &str,
) -> Result<(), String> {
    if column_exists(connection, table, column)? {
        return Ok(());
    }
    connection
        .execute(alter_sql, [])
        .map_err(|err| format!("Failed to add {label} column: {err}"))?;
    Ok(())
}

pub(crate) fn tx_err(err: rusqlite::Error) -> String {
    format!("runtime-db-transaction-failed: {err}")
}

fn read_migrations(connection: &Connection) -> Result<Vec<RuntimeDbMigrationStatus>, String> {
    let mut statement = connection
        .prepare(
            "SELECT family, version, applied_at_ms
             FROM runtime_schema_migrations
             ORDER BY family",
        )
        .map_err(|err| format!("Failed to read runtime migrations: {err}"))?;

    let rows = statement
        .query_map([], |row| {
            Ok(RuntimeDbMigrationStatus {
                family: row.get(0)?,
                version: row.get(1)?,
                applied_at_ms: row.get(2)?,
            })
        })
        .map_err(|err| format!("Failed to read runtime migrations: {err}"))?;

    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|err| format!("Failed to read runtime migrations: {err}"))
}

pub(crate) fn now_ms() -> Result<i64, String> {
    let duration = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|err| format!("System clock is before Unix epoch: {err}"))?;
    i64::try_from(duration.as_millis()).map_err(|_| "Current time is too large".to_string())
}

fn path_to_string(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

#[cfg(test)]
mod tests {
    use super::*;

    use rusqlite::{params, Connection};
    use std::path::{Path, PathBuf};

    use std::fs;

    #[test]
    fn runtime_db_path_is_project_scoped() {
        assert_eq!(
            runtime_db_path(Path::new("/tmp/project")),
            PathBuf::from("/tmp/project/.llm-wiki/runtime/runtime.db")
        );
    }

    #[test]
    fn parse_work_runtime_enabled_defaults_enabled_with_explicit_falsy_kill_switch() {
        assert!(parse_work_runtime_enabled(None));

        for value in ["0", "false", "no", "off", "FALSE", " off ", "No", "Off"] {
            assert!(!parse_work_runtime_enabled(Some(value)));
        }

        for value in ["1", "true", "yes", "on", "ON", "garbage", ""] {
            assert!(parse_work_runtime_enabled(Some(value)));
        }
    }

    #[test]
    fn resolve_work_runtime_enabled_defaults_enabled_without_adapter_value() {
        assert!(resolve_work_runtime_enabled(None));
        assert!(!resolve_work_runtime_enabled(Some("false".to_string())));
        assert!(resolve_work_runtime_enabled(Some("true".to_string())));
        assert!(resolve_work_runtime_enabled(Some("garbage".to_string())));
    }

    #[test]
    fn disabled_health_does_not_create_runtime_dir() {
        let project = temp_project("disabled-no-touch");
        fs::create_dir_all(&project).expect("create temp project");

        let health =
            runtime_db_health_for_project(Some(&project), false).expect("disabled health succeeds");

        assert_eq!(health.status, RuntimeDbHealthState::Disabled);
        assert!(!project.join(RUNTIME_DIR).exists());
        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn disabled_health_does_not_open_existing_runtime_db() {
        let project = temp_project("disabled-existing-db");
        let runtime_dir = project.join(RUNTIME_DIR);
        fs::create_dir_all(&runtime_dir).expect("create runtime dir");
        let db_path = runtime_dir.join(RUNTIME_DB_FILE);
        fs::write(&db_path, b"not sqlite").expect("write sentinel db");

        let health =
            runtime_db_health_for_project(Some(&project), false).expect("disabled health succeeds");

        assert_eq!(health.status, RuntimeDbHealthState::Disabled);
        assert_eq!(fs::read(&db_path).expect("read sentinel db"), b"not sqlite");
        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn enabled_health_without_project_returns_no_project_and_does_not_touch_disk() {
        let health = runtime_db_health_for_project(None, true).expect("no-project health succeeds");

        assert_eq!(health.status, RuntimeDbHealthState::NoProject);
        assert!(health.project_path.is_none());
        assert!(health.db_path.is_none());
    }

    #[test]
    fn enabled_health_without_explicit_or_fallback_project_returns_no_project() {
        let health =
            runtime_db_health_with_fallback(None, None, true).expect("no-project health succeeds");

        assert_eq!(health.status, RuntimeDbHealthState::NoProject);
        assert!(health.project_path.is_none());
        assert!(health.db_path.is_none());
    }

    #[test]
    fn enabled_health_uses_fallback_project_root_when_explicit_path_is_absent() {
        let project = temp_project("fallback-root");
        fs::create_dir_all(&project).expect("create temp project");

        let health = runtime_db_health_with_fallback(None, Some(project.clone()), true)
            .expect("fallback health succeeds");

        assert_eq!(health.status, RuntimeDbHealthState::Healthy);
        assert!(runtime_db_path(&project).is_file());
        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn disabled_health_with_fallback_project_root_does_not_touch_disk() {
        let project = temp_project("disabled-fallback-root");
        fs::create_dir_all(&project).expect("create temp project");

        let health = runtime_db_health_with_fallback(None, Some(project.clone()), false)
            .expect("disabled fallback health succeeds");

        assert_eq!(health.status, RuntimeDbHealthState::Disabled);
        assert!(!project.join(RUNTIME_DIR).exists());
        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn enabled_health_creates_runtime_db_with_wal_and_migration_row() {
        let project = temp_project("enabled-create");
        fs::create_dir_all(&project).expect("create temp project");

        let health =
            runtime_db_health_for_project(Some(&project), true).expect("enabled health succeeds");

        assert_eq!(health.status, RuntimeDbHealthState::Healthy);
        assert_eq!(health.journal_mode.as_deref(), Some("wal"));
        assert!(project.join(RUNTIME_DIR).is_dir());
        assert!(runtime_db_path(&project).is_file());
        assert!(health.migrations[0].applied_at_ms > 0);
        assert_eq!(
            health.migrations,
            vec![RuntimeDbMigrationStatus {
                family: MIGRATIONS_FAMILY.to_string(),
                version: MIGRATIONS_VERSION,
                applied_at_ms: health.migrations[0].applied_at_ms,
            }]
        );

        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn enabled_health_is_idempotent_and_preserves_applied_at_ms() {
        let project = temp_project("enabled-idempotent");
        fs::create_dir_all(&project).expect("create temp project");

        runtime_db_health_for_project(Some(&project), true).expect("first health succeeds");
        let first = read_migration(&project);

        runtime_db_health_for_project(Some(&project), true).expect("second health succeeds");
        let second = read_migration(&project);

        assert_eq!(first, second);
        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn enabled_health_preserves_existing_higher_migration_version() {
        let project = temp_project("enabled-higher-version");
        fs::create_dir_all(project.join(RUNTIME_DIR)).expect("create runtime dir");
        let connection = Connection::open(runtime_db_path(&project)).expect("open runtime db");
        connection
            .execute(
                "CREATE TABLE runtime_schema_migrations (
                    family TEXT PRIMARY KEY,
                    version INTEGER NOT NULL,
                    applied_at_ms INTEGER NOT NULL
                )",
                [],
            )
            .expect("create migrations table");
        connection
            .execute(
                "INSERT INTO runtime_schema_migrations (
                    family,
                    version,
                    applied_at_ms
                ) VALUES (?1, ?2, ?3)",
                params![MIGRATIONS_FAMILY, 2_i64, 42_i64],
            )
            .expect("seed higher migration");
        drop(connection);

        runtime_db_health_for_project(Some(&project), true).expect("enabled health succeeds");
        let migration = read_migration(&project);

        assert_eq!(
            migration,
            RuntimeDbMigrationStatus {
                family: MIGRATIONS_FAMILY.to_string(),
                version: 2,
                applied_at_ms: 42,
            }
        );
        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn resource_budget_migration_preserves_higher_version() {
        let project = temp_project("commit-budget-higher-version");
        fs::create_dir_all(&project).expect("create temp project");
        runtime_db_health_for_project(Some(&project), true).expect("create PR2 runtime db");
        let connection = Connection::open(runtime_db_path(&project)).expect("open runtime db");
        connection
            .execute(
                "INSERT INTO runtime_schema_migrations (
                    family,
                    version,
                    applied_at_ms
                ) VALUES (?1, ?2, ?3)",
                params![RESOURCE_BUDGETS_FAMILY, 2_i64, 42_i64],
            )
            .expect("seed higher migration");
        drop(connection);

        runtime_commit_budget_claim_for_project(
            Some(&project),
            true,
            commit_claim_request("wiki/a.md", "claim-1"),
            100,
        )
        .expect("claim budget");
        let migration = read_migration_family(&project, RESOURCE_BUDGETS_FAMILY);

        assert_eq!(
            migration,
            RuntimeDbMigrationStatus {
                family: RESOURCE_BUDGETS_FAMILY.to_string(),
                version: 2,
                applied_at_ms: 42,
            }
        );
        let _ = fs::remove_dir_all(project);
    }
}
