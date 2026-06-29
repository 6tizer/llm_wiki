use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{params, Connection, OpenFlags, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};
use tauri::State;
use uuid::Uuid;

use crate::commands::file_sync::ProjectRootState;
use crate::panic_guard::run_guarded;

const RUNTIME_DIR: &str = ".llm-wiki/runtime";
const RUNTIME_DB_FILE: &str = "runtime.db";
const MIGRATIONS_FAMILY: &str = "migrations";
const MIGRATIONS_VERSION: i64 = 1;
const JOBS_FAMILY: &str = "jobs";
const JOBS_VERSION: i64 = 1;
const LEASES_FAMILY: &str = "leases";
const LEASES_VERSION: i64 = 1;
const WORK_RUNTIME_ENABLED_ENV: &str = "LLM_WIKI_CORE_WORK_RUNTIME_ENABLED";
const DEFAULT_MAX_ATTEMPTS: i64 = 3;
const DEFAULT_PRIORITY: i64 = 0;
const DEFAULT_LEASE_TTL_MS: i64 = 120_000;
const DEFAULT_RETRY_BACKOFF_MS: i64 = 30_000;
const ACTIVE_LEASE_STATUS: &str = "active";
const RELEASED_LEASE_STATUS: &str = "released";
const EXPIRED_LEASE_STATUS: &str = "expired";
const CANCELLED_LEASE_STATUS: &str = "cancelled";

static RUNTIME_DB_WRITE_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

/// Runtime DB health state returned by the shell-neutral health command.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum RuntimeDbHealthState {
    Disabled,
    NoProject,
    Healthy,
}

/// Applied migration bookkeeping entry for a runtime schema family.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeDbMigrationStatus {
    family: String,
    version: i64,
    applied_at_ms: i64,
}

/// Runtime DB health payload returned to Tauri callers.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeDbHealth {
    enabled: bool,
    status: RuntimeDbHealthState,
    project_path: Option<String>,
    runtime_dir: Option<String>,
    db_path: Option<String>,
    journal_mode: Option<String>,
    migrations: Vec<RuntimeDbMigrationStatus>,
}

/// Request payload for creating a queued runtime job.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeJobCreateRequest {
    job_id: Option<String>,
    kind: String,
    payload: String,
    max_attempts: Option<i64>,
    priority: Option<i64>,
}

/// Request payload for claiming the next queued runtime job.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeJobClaimRequest {
    holder: String,
    lease_id: Option<String>,
}

/// Request payload for active-lease job operations.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeJobLeaseRequest {
    job_id: String,
    lease_id: String,
}

/// Request payload for failing a running runtime job.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeJobFailRequest {
    job_id: String,
    lease_id: String,
    error: Option<String>,
    retry_after_ms: Option<i64>,
}

/// Request payload for retrying a failed or retry-ready runtime job.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeJobRetryRequest {
    job_id: String,
}

/// Request payload for cancelling a non-terminal runtime job.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeJobCancelRequest {
    job_id: String,
}

/// Snapshot of one runtime job row.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeJobRecord {
    job_id: String,
    kind: String,
    payload: String,
    state: String,
    attempt: i64,
    max_attempts: i64,
    priority: i64,
    created_at_ms: i64,
    updated_at_ms: i64,
    queued_at_ms: Option<i64>,
    started_at_ms: Option<i64>,
    completed_at_ms: Option<i64>,
    failed_at_ms: Option<i64>,
    cancelled_at_ms: Option<i64>,
    retry_after_ms: Option<i64>,
    last_error: Option<String>,
}

/// Snapshot of one runtime job lease row.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeJobLeaseRecord {
    lease_id: String,
    job_id: String,
    holder: String,
    acquired_at_ms: i64,
    heartbeat_at_ms: i64,
    expires_at_ms: i64,
    released_at_ms: Option<i64>,
    status: String,
}

/// Response payload for a successful job claim.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeJobClaim {
    job: RuntimeJobRecord,
    lease: RuntimeJobLeaseRecord,
}

/// Snapshot response for runtime jobs and leases.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeJobList {
    enabled: bool,
    status: RuntimeDbHealthState,
    jobs: Vec<RuntimeJobRecord>,
    leases: Vec<RuntimeJobLeaseRecord>,
}

fn runtime_db_path(project_root: &Path) -> PathBuf {
    project_root.join(RUNTIME_DIR).join(RUNTIME_DB_FILE)
}

fn parse_work_runtime_enabled(value: Option<&str>) -> bool {
    value
        .map(str::trim)
        .map(str::to_ascii_lowercase)
        .is_some_and(|value| matches!(value.as_str(), "1" | "true" | "yes" | "on"))
}

fn read_work_runtime_flag_value() -> Option<String> {
    std::env::var(WORK_RUNTIME_ENABLED_ENV).ok()
}

fn resolve_work_runtime_enabled(adapter_flag_value: Option<String>) -> bool {
    parse_work_runtime_enabled(adapter_flag_value.as_deref())
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

/// Create a queued runtime job for the currently-open project.
#[tauri::command]
pub fn runtime_job_create(
    request: RuntimeJobCreateRequest,
    root_state: State<'_, ProjectRootState>,
) -> Result<RuntimeJobRecord, String> {
    run_guarded("runtime_job_create", || {
        let runtime_enabled = resolve_work_runtime_enabled(read_work_runtime_flag_value());
        let project_root = root_state.get();
        let now = now_for_enabled_project(project_root.as_deref(), runtime_enabled)?;
        runtime_job_create_for_project(
            project_root.as_deref(),
            runtime_enabled,
            request,
            now,
        )
    })
}

/// Claim the next queued runtime job for the currently-open project.
#[tauri::command]
pub fn runtime_job_claim(
    request: RuntimeJobClaimRequest,
    root_state: State<'_, ProjectRootState>,
) -> Result<RuntimeJobClaim, String> {
    run_guarded("runtime_job_claim", || {
        let runtime_enabled = resolve_work_runtime_enabled(read_work_runtime_flag_value());
        let project_root = root_state.get();
        let now = now_for_enabled_project(project_root.as_deref(), runtime_enabled)?;
        runtime_job_claim_for_project(
            project_root.as_deref(),
            runtime_enabled,
            request,
            now,
        )
    })
}

/// Renew the active lease for a running runtime job.
#[tauri::command]
pub fn runtime_job_heartbeat(
    request: RuntimeJobLeaseRequest,
    root_state: State<'_, ProjectRootState>,
) -> Result<RuntimeJobClaim, String> {
    run_guarded("runtime_job_heartbeat", || {
        let runtime_enabled = resolve_work_runtime_enabled(read_work_runtime_flag_value());
        let project_root = root_state.get();
        let now = now_for_enabled_project(project_root.as_deref(), runtime_enabled)?;
        runtime_job_heartbeat_for_project(
            project_root.as_deref(),
            runtime_enabled,
            request,
            now,
        )
    })
}

/// Complete a running runtime job and release its active lease.
#[tauri::command]
pub fn runtime_job_complete(
    request: RuntimeJobLeaseRequest,
    root_state: State<'_, ProjectRootState>,
) -> Result<RuntimeJobRecord, String> {
    run_guarded("runtime_job_complete", || {
        let runtime_enabled = resolve_work_runtime_enabled(read_work_runtime_flag_value());
        let project_root = root_state.get();
        let now = now_for_enabled_project(project_root.as_deref(), runtime_enabled)?;
        runtime_job_complete_for_project(
            project_root.as_deref(),
            runtime_enabled,
            request,
            now,
        )
    })
}

/// Fail a running runtime job and release its active lease.
#[tauri::command]
pub fn runtime_job_fail(
    request: RuntimeJobFailRequest,
    root_state: State<'_, ProjectRootState>,
) -> Result<RuntimeJobRecord, String> {
    run_guarded("runtime_job_fail", || {
        let runtime_enabled = resolve_work_runtime_enabled(read_work_runtime_flag_value());
        let project_root = root_state.get();
        let now = now_for_enabled_project(project_root.as_deref(), runtime_enabled)?;
        runtime_job_fail_for_project(
            project_root.as_deref(),
            runtime_enabled,
            request,
            now,
        )
    })
}

/// Retry a failed or retry-ready runtime job.
#[tauri::command]
pub fn runtime_job_retry(
    request: RuntimeJobRetryRequest,
    root_state: State<'_, ProjectRootState>,
) -> Result<RuntimeJobRecord, String> {
    run_guarded("runtime_job_retry", || {
        let runtime_enabled = resolve_work_runtime_enabled(read_work_runtime_flag_value());
        let project_root = root_state.get();
        let now = now_for_enabled_project(project_root.as_deref(), runtime_enabled)?;
        runtime_job_retry_for_project(
            project_root.as_deref(),
            runtime_enabled,
            request,
            now,
        )
    })
}

/// Cancel a non-terminal runtime job.
#[tauri::command]
pub fn runtime_job_cancel(
    request: RuntimeJobCancelRequest,
    root_state: State<'_, ProjectRootState>,
) -> Result<RuntimeJobRecord, String> {
    run_guarded("runtime_job_cancel", || {
        let runtime_enabled = resolve_work_runtime_enabled(read_work_runtime_flag_value());
        let project_root = root_state.get();
        let now = now_for_enabled_project(project_root.as_deref(), runtime_enabled)?;
        runtime_job_cancel_for_project(
            project_root.as_deref(),
            runtime_enabled,
            request,
            now,
        )
    })
}

/// List runtime jobs and leases for the currently-open project.
#[tauri::command]
pub fn runtime_job_list(root_state: State<'_, ProjectRootState>) -> Result<RuntimeJobList, String> {
    run_guarded("runtime_job_list", || {
        runtime_job_list_for_project(
            root_state.get().as_deref(),
            resolve_work_runtime_enabled(read_work_runtime_flag_value()),
        )
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

fn runtime_db_health_for_project(
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

fn with_runtime_writer<T>(body: impl FnOnce() -> Result<T, String>) -> Result<T, String> {
    let lock = RUNTIME_DB_WRITE_LOCK.get_or_init(|| Mutex::new(()));
    let _guard = lock.lock().map_err(|_| {
        "runtime-db-writer-poisoned: runtime DB writer lock is poisoned".to_string()
    })?;
    body()
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

fn open_job_runtime_locked(project_root: &Path) -> Result<Connection, String> {
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

fn runtime_job_create_for_project(
    project_root: Option<&Path>,
    enabled: bool,
    request: RuntimeJobCreateRequest,
    now: i64,
) -> Result<RuntimeJobRecord, String> {
    let project_root = require_enabled_project(project_root, enabled)?;
    with_runtime_writer(|| {
        let connection = open_job_runtime_locked(project_root)?;
        let job_id = request.job_id.unwrap_or_else(|| Uuid::new_v4().to_string());
        connection
            .execute(
                "INSERT INTO runtime_jobs (
                    job_id,
                    kind,
                    payload,
                    state,
                    attempt,
                    max_attempts,
                    priority,
                    created_at_ms,
                    updated_at_ms,
                    queued_at_ms
                ) VALUES (?1, ?2, ?3, 'queued', 0, ?4, ?5, ?6, ?6, ?6)",
                params![
                    &job_id,
                    require_non_empty("invalid-kind", "kind", &request.kind)?,
                    require_non_empty("invalid-payload", "payload", &request.payload)?,
                    request.max_attempts.unwrap_or(DEFAULT_MAX_ATTEMPTS).max(1),
                    request.priority.unwrap_or(DEFAULT_PRIORITY),
                    now
                ],
            )
            .map_err(|err| format!("job-create-failed: {err}"))?;
        read_job(&connection, &job_id)
    })
}

fn runtime_job_claim_for_project(
    project_root: Option<&Path>,
    enabled: bool,
    request: RuntimeJobClaimRequest,
    now: i64,
) -> Result<RuntimeJobClaim, String> {
    let project_root = require_enabled_project(project_root, enabled)?;
    with_runtime_writer(|| {
        let mut connection = open_job_runtime_locked(project_root)?;
        let tx = connection.transaction().map_err(tx_err)?;
        let job_id: String = tx
            .query_row(
                "SELECT job_id
                 FROM runtime_jobs
                 WHERE state = 'queued'
                 ORDER BY priority DESC, queued_at_ms ASC, created_at_ms ASC
                 LIMIT 1",
                [],
                |row| row.get(0),
            )
            .optional()
            .map_err(|err| format!("job-claim-select-failed: {err}"))?
            .ok_or_else(|| "no-queued-job: no queued runtime job is available".to_string())?;

        ensure_no_active_lease(&tx, &job_id)?;
        tx.execute(
            "UPDATE runtime_jobs
             SET state = 'running',
                 attempt = attempt + 1,
                 started_at_ms = COALESCE(started_at_ms, ?2),
                 updated_at_ms = ?2
             WHERE job_id = ?1 AND state = 'queued'",
            params![job_id, now],
        )
        .map_err(|err| format!("job-claim-update-failed: {err}"))?;

        let lease_id = request
            .lease_id
            .unwrap_or_else(|| Uuid::new_v4().to_string());
        tx.execute(
            "INSERT INTO runtime_job_leases (
                lease_id,
                job_id,
                holder,
                acquired_at_ms,
                heartbeat_at_ms,
                expires_at_ms,
                status
            ) VALUES (?1, ?2, ?3, ?4, ?4, ?5, 'active')",
            params![
                lease_id,
                job_id,
                require_non_empty("invalid-holder", "holder", &request.holder)?,
                now,
                now + DEFAULT_LEASE_TTL_MS
            ],
        )
        .map_err(|err| format!("job-claim-lease-failed: {err}"))?;

        let job = read_job_tx(&tx, &job_id)?;
        let lease = read_lease_tx(&tx, &lease_id)?;
        tx.commit().map_err(tx_err)?;
        Ok(RuntimeJobClaim { job, lease })
    })
}

fn runtime_job_heartbeat_for_project(
    project_root: Option<&Path>,
    enabled: bool,
    request: RuntimeJobLeaseRequest,
    now: i64,
) -> Result<RuntimeJobClaim, String> {
    let project_root = require_enabled_project(project_root, enabled)?;
    with_runtime_writer(|| {
        let mut connection = open_job_runtime_locked(project_root)?;
        let tx = connection.transaction().map_err(tx_err)?;
        ensure_active_running_lease(&tx, &request.job_id, &request.lease_id, Some(now))?;
        tx.execute(
            "UPDATE runtime_job_leases
             SET heartbeat_at_ms = ?3,
                 expires_at_ms = ?4
             WHERE job_id = ?1 AND lease_id = ?2 AND status = 'active'",
            params![
                request.job_id,
                request.lease_id,
                now,
                now + DEFAULT_LEASE_TTL_MS
            ],
        )
        .map_err(|err| format!("job-heartbeat-failed: {err}"))?;
        tx.execute(
            "UPDATE runtime_jobs SET updated_at_ms = ?2 WHERE job_id = ?1",
            params![request.job_id, now],
        )
        .map_err(|err| format!("job-heartbeat-update-failed: {err}"))?;
        let job = read_job_tx(&tx, &request.job_id)?;
        let lease = read_lease_tx(&tx, &request.lease_id)?;
        tx.commit().map_err(tx_err)?;
        Ok(RuntimeJobClaim { job, lease })
    })
}

fn runtime_job_complete_for_project(
    project_root: Option<&Path>,
    enabled: bool,
    request: RuntimeJobLeaseRequest,
    now: i64,
) -> Result<RuntimeJobRecord, String> {
    terminal_running_operation(
        project_root,
        enabled,
        &request.job_id,
        &request.lease_id,
        now,
        |tx| {
            tx.execute(
                "UPDATE runtime_jobs
                 SET state = 'completed',
                     completed_at_ms = ?2,
                     updated_at_ms = ?2
                 WHERE job_id = ?1",
                params![request.job_id, now],
            )
            .map_err(|err| format!("job-complete-failed: {err}"))
        },
    )
}

fn runtime_job_fail_for_project(
    project_root: Option<&Path>,
    enabled: bool,
    request: RuntimeJobFailRequest,
    now: i64,
) -> Result<RuntimeJobRecord, String> {
    let project_root = require_enabled_project(project_root, enabled)?;
    with_runtime_writer(|| {
        let mut connection = open_job_runtime_locked(project_root)?;
        let tx = connection.transaction().map_err(tx_err)?;
        ensure_active_running_lease(&tx, &request.job_id, &request.lease_id, Some(now))?;
        let job = read_job_tx(&tx, &request.job_id)?;
        let retry_remaining = job.attempt < job.max_attempts;
        let next_state = if retry_remaining {
            "retry-wait"
        } else {
            "failed"
        };
        let retry_after_ms = retry_remaining.then_some(
            request
                .retry_after_ms
                .unwrap_or_else(|| now + DEFAULT_RETRY_BACKOFF_MS),
        );
        tx.execute(
            "UPDATE runtime_jobs
             SET state = ?2,
                 failed_at_ms = CASE WHEN ?2 = 'failed' THEN ?3 ELSE failed_at_ms END,
                 retry_after_ms = ?4,
                 last_error = ?5,
                 updated_at_ms = ?3
             WHERE job_id = ?1",
            params![
                request.job_id,
                next_state,
                now,
                retry_after_ms,
                request.error
            ],
        )
        .map_err(|err| format!("job-fail-update-failed: {err}"))?;
        release_lease(
            &tx,
            &request.job_id,
            &request.lease_id,
            RELEASED_LEASE_STATUS,
            now,
        )?;
        let job = read_job_tx(&tx, &request.job_id)?;
        tx.commit().map_err(tx_err)?;
        Ok(job)
    })
}

fn runtime_job_retry_for_project(
    project_root: Option<&Path>,
    enabled: bool,
    request: RuntimeJobRetryRequest,
    now: i64,
) -> Result<RuntimeJobRecord, String> {
    let project_root = require_enabled_project(project_root, enabled)?;
    with_runtime_writer(|| {
        let mut connection = open_job_runtime_locked(project_root)?;
        let tx = connection.transaction().map_err(tx_err)?;
        let job = read_job_tx(&tx, &request.job_id)?;
        if !matches!(job.state.as_str(), "failed" | "retry-wait") {
            return Err(format!(
                "invalid-transition: retry is not allowed from '{}'",
                job.state
            ));
        }
        if job.attempt >= job.max_attempts {
            return Err("retry-limit-exhausted: retry max is exhausted".to_string());
        }
        if job.state == "retry-wait" {
            let Some(retry_after) = job.retry_after_ms else {
                return Err("retry-not-ready: retry-wait job has no retry_after_ms".to_string());
            };
            if retry_after > now {
                return Err("retry-not-ready: retry-wait job is not eligible yet".to_string());
            }
        }
        tx.execute(
            "UPDATE runtime_jobs
             SET state = 'queued',
                 queued_at_ms = ?2,
                 retry_after_ms = NULL,
                 updated_at_ms = ?2
             WHERE job_id = ?1",
            params![request.job_id, now],
        )
        .map_err(|err| format!("job-retry-failed: {err}"))?;
        let job = read_job_tx(&tx, &request.job_id)?;
        tx.commit().map_err(tx_err)?;
        Ok(job)
    })
}

fn runtime_job_cancel_for_project(
    project_root: Option<&Path>,
    enabled: bool,
    request: RuntimeJobCancelRequest,
    now: i64,
) -> Result<RuntimeJobRecord, String> {
    let project_root = require_enabled_project(project_root, enabled)?;
    with_runtime_writer(|| {
        let mut connection = open_job_runtime_locked(project_root)?;
        let tx = connection.transaction().map_err(tx_err)?;
        let job = read_job_tx(&tx, &request.job_id)?;
        if !matches!(
            job.state.as_str(),
            "queued" | "running" | "paused" | "retry-wait"
        ) {
            return Err(format!(
                "invalid-transition: cancel is not allowed from '{}'",
                job.state
            ));
        }
        tx.execute(
            "UPDATE runtime_jobs
             SET state = 'cancelled',
                 cancelled_at_ms = ?2,
                 updated_at_ms = ?2
             WHERE job_id = ?1",
            params![request.job_id, now],
        )
        .map_err(|err| format!("job-cancel-failed: {err}"))?;
        tx.execute(
            "UPDATE runtime_job_leases
             SET status = ?2,
                 released_at_ms = ?3
             WHERE job_id = ?1 AND status = 'active'",
            params![request.job_id, CANCELLED_LEASE_STATUS, now],
        )
        .map_err(|err| format!("job-cancel-lease-failed: {err}"))?;
        let job = read_job_tx(&tx, &request.job_id)?;
        tx.commit().map_err(tx_err)?;
        Ok(job)
    })
}

fn runtime_job_list_for_project(
    project_root: Option<&Path>,
    enabled: bool,
) -> Result<RuntimeJobList, String> {
    if !enabled {
        return Ok(RuntimeJobList {
            enabled: false,
            status: RuntimeDbHealthState::Disabled,
            jobs: Vec::new(),
            leases: Vec::new(),
        });
    }
    let Some(project_root) = project_root else {
        return Ok(RuntimeJobList {
            enabled: true,
            status: RuntimeDbHealthState::NoProject,
            jobs: Vec::new(),
            leases: Vec::new(),
        });
    };
    let db_path = runtime_db_path(project_root);
    if !db_path.exists() {
        return Ok(RuntimeJobList {
            enabled: true,
            status: RuntimeDbHealthState::Healthy,
            jobs: Vec::new(),
            leases: Vec::new(),
        });
    }
    let connection = Connection::open_with_flags(
        db_path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|err| format!("job-list-open-failed: {err}"))?;
    if !table_exists(&connection, "runtime_jobs")?
        || !table_exists(&connection, "runtime_job_leases")?
    {
        return Ok(RuntimeJobList {
            enabled: true,
            status: RuntimeDbHealthState::Healthy,
            jobs: Vec::new(),
            leases: Vec::new(),
        });
    }
    Ok(RuntimeJobList {
        enabled: true,
        status: RuntimeDbHealthState::Healthy,
        jobs: read_jobs(&connection)?,
        leases: read_leases(&connection)?,
    })
}

fn terminal_running_operation(
    project_root: Option<&Path>,
    enabled: bool,
    job_id: &str,
    lease_id: &str,
    now: i64,
    update_job: impl FnOnce(&Transaction<'_>) -> Result<usize, String>,
) -> Result<RuntimeJobRecord, String> {
    let project_root = require_enabled_project(project_root, enabled)?;
    with_runtime_writer(|| {
        let mut connection = open_job_runtime_locked(project_root)?;
        let tx = connection.transaction().map_err(tx_err)?;
        ensure_active_running_lease(&tx, job_id, lease_id, Some(now))?;
        update_job(&tx)?;
        release_lease(&tx, job_id, lease_id, RELEASED_LEASE_STATUS, now)?;
        let job = read_job_tx(&tx, job_id)?;
        tx.commit().map_err(tx_err)?;
        Ok(job)
    })
}

/// Expire an active running lease for a future scheduler scan.
///
/// PR3 deliberately has no scheduler caller; without a later scanner, expired
/// active leases remain `running` and are not automatically recovered.
#[allow(dead_code)]
fn runtime_job_lease_timeout_for_project(
    project_root: Option<&Path>,
    enabled: bool,
    job_id: &str,
    lease_id: &str,
    now: i64,
) -> Result<RuntimeJobRecord, String> {
    let project_root = require_enabled_project(project_root, enabled)?;
    with_runtime_writer(|| {
        let mut connection = open_job_runtime_locked(project_root)?;
        let tx = connection.transaction().map_err(tx_err)?;
        ensure_active_running_lease(&tx, job_id, lease_id, None)?;
        let job = read_job_tx(&tx, job_id)?;
        let lease = read_lease_tx(&tx, lease_id)?;
        if lease.expires_at_ms > now {
            return Err("lease-not-expired: active lease has not expired".to_string());
        }
        let retry_remaining = job.attempt < job.max_attempts;
        let next_state = if retry_remaining {
            "retry-wait"
        } else {
            "failed"
        };
        let retry_after_ms = retry_remaining.then_some(now + DEFAULT_RETRY_BACKOFF_MS);
        tx.execute(
            "UPDATE runtime_jobs
             SET state = ?2,
                 failed_at_ms = CASE WHEN ?2 = 'failed' THEN ?3 ELSE failed_at_ms END,
                 retry_after_ms = ?4,
                 last_error = 'lease-timeout',
                 updated_at_ms = ?3
             WHERE job_id = ?1",
            params![job_id, next_state, now, retry_after_ms],
        )
        .map_err(|err| format!("job-lease-timeout-update-failed: {err}"))?;
        release_lease(&tx, job_id, lease_id, EXPIRED_LEASE_STATUS, now)?;
        let job = read_job_tx(&tx, job_id)?;
        tx.commit().map_err(tx_err)?;
        Ok(job)
    })
}

fn require_enabled_project(project_root: Option<&Path>, enabled: bool) -> Result<&Path, String> {
    if !enabled {
        return Err("runtime-disabled: work runtime is disabled".to_string());
    }
    project_root.ok_or_else(|| "no-project: no project root is open".to_string())
}

fn now_for_enabled_project(project_root: Option<&Path>, enabled: bool) -> Result<i64, String> {
    require_enabled_project(project_root, enabled)?;
    now_ms()
}

fn require_non_empty<'a>(code: &str, field: &str, value: &'a str) -> Result<&'a str, String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        Err(format!("{code}: {field} must not be empty"))
    } else {
        Ok(trimmed)
    }
}

fn ensure_no_active_lease(tx: &Transaction<'_>, job_id: &str) -> Result<(), String> {
    let active_count = tx
        .query_row(
            "SELECT COUNT(*)
             FROM runtime_job_leases
             WHERE job_id = ?1 AND status = 'active'",
            [job_id],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|err| format!("active-lease-check-failed: {err}"))?;
    if active_count == 0 {
        Ok(())
    } else {
        Err("active-lease-exists: job already has an active lease".to_string())
    }
}

fn ensure_active_running_lease(
    tx: &Transaction<'_>,
    job_id: &str,
    lease_id: &str,
    now: Option<i64>,
) -> Result<(), String> {
    let state: Option<String> = tx
        .query_row(
            "SELECT state FROM runtime_jobs WHERE job_id = ?1",
            [job_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|err| format!("job-state-check-failed: {err}"))?;
    let Some(state) = state else {
        return Err("job-not-found: runtime job does not exist".to_string());
    };
    if state != "running" {
        return Err(format!(
            "invalid-transition: active lease operation requires running job, got '{state}'"
        ));
    }

    let lease: Option<(String, i64)> = tx
        .query_row(
            "SELECT status, expires_at_ms
             FROM runtime_job_leases
             WHERE job_id = ?1 AND lease_id = ?2",
            params![job_id, lease_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(|err| format!("lease-status-check-failed: {err}"))?;
    match lease {
        Some((status, expires_at_ms)) if status == ACTIVE_LEASE_STATUS => {
            if now.is_some_and(|now| expires_at_ms <= now) {
                Err("lease-expired: active lease has already expired".to_string())
            } else {
                Ok(())
            }
        }
        Some((status, _)) => Err(format!(
            "inactive-lease: lease is '{status}' and cannot mutate the job"
        )),
        None => Err("lease-not-found: active lease does not exist".to_string()),
    }
}

fn release_lease(
    tx: &Transaction<'_>,
    job_id: &str,
    lease_id: &str,
    status: &str,
    now: i64,
) -> Result<(), String> {
    let updated = tx
        .execute(
            "UPDATE runtime_job_leases
             SET status = ?3,
                 released_at_ms = ?4
             WHERE job_id = ?1 AND lease_id = ?2 AND status = 'active'",
            params![job_id, lease_id, status, now],
        )
        .map_err(|err| format!("lease-release-failed: {err}"))?;
    if updated == 1 {
        Ok(())
    } else {
        Err("inactive-lease: active lease was not released".to_string())
    }
}

fn read_job(connection: &Connection, job_id: &str) -> Result<RuntimeJobRecord, String> {
    connection
        .query_row(&job_select_sql("WHERE job_id = ?1"), [job_id], map_job_row)
        .map_err(|err| format!("job-read-failed: {err}"))
}

fn read_job_tx(tx: &Transaction<'_>, job_id: &str) -> Result<RuntimeJobRecord, String> {
    tx.query_row(&job_select_sql("WHERE job_id = ?1"), [job_id], map_job_row)
        .map_err(|err| format!("job-read-failed: {err}"))
}

fn read_lease_tx(tx: &Transaction<'_>, lease_id: &str) -> Result<RuntimeJobLeaseRecord, String> {
    tx.query_row(
        &lease_select_sql("WHERE lease_id = ?1"),
        [lease_id],
        map_lease_row,
    )
    .map_err(|err| format!("lease-read-failed: {err}"))
}

fn read_jobs(connection: &Connection) -> Result<Vec<RuntimeJobRecord>, String> {
    let mut statement = connection
        .prepare(&job_select_sql("ORDER BY created_at_ms ASC, job_id ASC"))
        .map_err(|err| format!("jobs-read-prepare-failed: {err}"))?;
    let rows = statement
        .query_map([], map_job_row)
        .map_err(|err| format!("jobs-read-failed: {err}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|err| format!("jobs-read-failed: {err}"))
}

fn read_leases(connection: &Connection) -> Result<Vec<RuntimeJobLeaseRecord>, String> {
    let mut statement = connection
        .prepare(&lease_select_sql(
            "ORDER BY acquired_at_ms ASC, lease_id ASC",
        ))
        .map_err(|err| format!("leases-read-prepare-failed: {err}"))?;
    let rows = statement
        .query_map([], map_lease_row)
        .map_err(|err| format!("leases-read-failed: {err}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|err| format!("leases-read-failed: {err}"))
}

fn table_exists(connection: &Connection, table: &str) -> Result<bool, String> {
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

fn job_select_sql(suffix: &str) -> String {
    format!(
        "SELECT job_id,
                kind,
                payload,
                state,
                attempt,
                max_attempts,
                priority,
                created_at_ms,
                updated_at_ms,
                queued_at_ms,
                started_at_ms,
                completed_at_ms,
                failed_at_ms,
                cancelled_at_ms,
                retry_after_ms,
                last_error
         FROM runtime_jobs {suffix}"
    )
}

fn lease_select_sql(suffix: &str) -> String {
    format!(
        "SELECT lease_id,
                job_id,
                holder,
                acquired_at_ms,
                heartbeat_at_ms,
                expires_at_ms,
                released_at_ms,
                status
         FROM runtime_job_leases {suffix}"
    )
}

fn map_job_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<RuntimeJobRecord> {
    Ok(RuntimeJobRecord {
        job_id: row.get(0)?,
        kind: row.get(1)?,
        payload: row.get(2)?,
        state: row.get(3)?,
        attempt: row.get(4)?,
        max_attempts: row.get(5)?,
        priority: row.get(6)?,
        created_at_ms: row.get(7)?,
        updated_at_ms: row.get(8)?,
        queued_at_ms: row.get(9)?,
        started_at_ms: row.get(10)?,
        completed_at_ms: row.get(11)?,
        failed_at_ms: row.get(12)?,
        cancelled_at_ms: row.get(13)?,
        retry_after_ms: row.get(14)?,
        last_error: row.get(15)?,
    })
}

fn map_lease_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<RuntimeJobLeaseRecord> {
    Ok(RuntimeJobLeaseRecord {
        lease_id: row.get(0)?,
        job_id: row.get(1)?,
        holder: row.get(2)?,
        acquired_at_ms: row.get(3)?,
        heartbeat_at_ms: row.get(4)?,
        expires_at_ms: row.get(5)?,
        released_at_ms: row.get(6)?,
        status: row.get(7)?,
    })
}

fn tx_err(err: rusqlite::Error) -> String {
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

fn now_ms() -> Result<i64, String> {
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
    use std::fs;

    fn temp_project(label: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock before Unix epoch")
            .as_nanos();
        std::env::temp_dir().join(format!(
            "llm-wiki-runtime-db-{label}-{}-{nanos}",
            std::process::id()
        ))
    }

    fn read_migration(project_root: &Path) -> RuntimeDbMigrationStatus {
        read_migration_family(project_root, MIGRATIONS_FAMILY)
    }

    fn read_migration_family(project_root: &Path, family: &str) -> RuntimeDbMigrationStatus {
        let connection = Connection::open(runtime_db_path(project_root)).expect("open runtime db");
        connection
            .query_row(
                "SELECT family, version, applied_at_ms
                 FROM runtime_schema_migrations
                 WHERE family = ?1",
                [family],
                |row| {
                    Ok(RuntimeDbMigrationStatus {
                        family: row.get(0)?,
                        version: row.get(1)?,
                        applied_at_ms: row.get(2)?,
                    })
                },
            )
            .expect("read migration row")
    }

    #[test]
    fn runtime_db_path_is_project_scoped() {
        assert_eq!(
            runtime_db_path(Path::new("/tmp/project")),
            PathBuf::from("/tmp/project/.llm-wiki/runtime/runtime.db")
        );
    }

    #[test]
    fn parse_work_runtime_enabled_accepts_only_truthy_values() {
        for value in ["1", "true", "TRUE", " yes ", "on"] {
            assert!(parse_work_runtime_enabled(Some(value)));
        }

        for value in [None, Some(""), Some("0"), Some("false"), Some("enabled")] {
            assert!(!parse_work_runtime_enabled(value));
        }
    }

    #[test]
    fn resolve_work_runtime_enabled_defaults_disabled_without_adapter_value() {
        assert!(!resolve_work_runtime_enabled(None));
        assert!(!resolve_work_runtime_enabled(Some("false".to_string())));
        assert!(resolve_work_runtime_enabled(Some("true".to_string())));
    }

    #[test]
    fn now_for_enabled_project_returns_disabled_before_no_project() {
        let error = now_for_enabled_project(None, false).expect_err("disabled wins");

        assert!(error.starts_with("runtime-disabled"));
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

    fn create_request(job_id: &str) -> RuntimeJobCreateRequest {
        RuntimeJobCreateRequest {
            job_id: Some(job_id.to_string()),
            kind: "compile-page".to_string(),
            payload: "{}".to_string(),
            max_attempts: None,
            priority: None,
        }
    }

    fn create_request_with_max_attempts(
        job_id: &str,
        max_attempts: i64,
    ) -> RuntimeJobCreateRequest {
        RuntimeJobCreateRequest {
            max_attempts: Some(max_attempts),
            ..create_request(job_id)
        }
    }

    fn claim_request(holder: &str, lease_id: &str) -> RuntimeJobClaimRequest {
        RuntimeJobClaimRequest {
            holder: holder.to_string(),
            lease_id: Some(lease_id.to_string()),
        }
    }

    fn lease_request(job_id: &str, lease_id: &str) -> RuntimeJobLeaseRequest {
        RuntimeJobLeaseRequest {
            job_id: job_id.to_string(),
            lease_id: lease_id.to_string(),
        }
    }

    #[test]
    fn disabled_job_create_does_not_touch_disk() {
        let project = temp_project("disabled-job-create");
        fs::create_dir_all(&project).expect("create temp project");

        let error =
            runtime_job_create_for_project(Some(&project), false, create_request("job-1"), 10)
                .expect_err("disabled create should fail");

        assert!(error.starts_with("runtime-disabled"));
        assert!(!project.join(RUNTIME_DIR).exists());
        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn disabled_job_list_does_not_open_damaged_runtime_db() {
        let project = temp_project("disabled-job-list");
        let runtime_dir = project.join(RUNTIME_DIR);
        fs::create_dir_all(&runtime_dir).expect("create runtime dir");
        let db_path = runtime_dir.join(RUNTIME_DB_FILE);
        fs::write(&db_path, b"not sqlite").expect("write damaged db");

        let list = runtime_job_list_for_project(Some(&project), false).expect("disabled list");

        assert_eq!(list.status, RuntimeDbHealthState::Disabled);
        assert!(list.jobs.is_empty());
        assert_eq!(fs::read(&db_path).expect("read damaged db"), b"not sqlite");
        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn enabled_job_list_on_pr2_only_db_returns_empty_without_migration() {
        let project = temp_project("enabled-job-list-pr2-db");
        fs::create_dir_all(&project).expect("create temp project");
        runtime_db_health_for_project(Some(&project), true).expect("create PR2 runtime db");

        let list = runtime_job_list_for_project(Some(&project), true).expect("list jobs");

        assert_eq!(list.status, RuntimeDbHealthState::Healthy);
        assert!(list.jobs.is_empty());
        assert!(list.leases.is_empty());
        let connection = Connection::open(runtime_db_path(&project)).expect("open runtime db");
        assert!(!table_exists(&connection, "runtime_jobs").expect("check jobs table"));
        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn enabled_job_list_on_damaged_runtime_db_returns_error() {
        let project = temp_project("enabled-job-list-damaged-db");
        let runtime_dir = project.join(RUNTIME_DIR);
        fs::create_dir_all(&runtime_dir).expect("create runtime dir");
        fs::write(runtime_dir.join(RUNTIME_DB_FILE), b"not sqlite").expect("write damaged db");

        let error = runtime_job_list_for_project(Some(&project), true)
            .expect_err("enabled list should report damaged db");

        assert!(
            error.contains("job-list-open-failed") || error.contains("table-exists-check-failed")
        );
        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn job_schema_enables_foreign_keys_and_rejects_orphan_lease() {
        let project = temp_project("job-schema-fk");
        fs::create_dir_all(&project).expect("create temp project");

        with_runtime_writer(|| {
            let connection = open_job_runtime_locked(&project)?;
            let foreign_keys = connection
                .query_row("PRAGMA foreign_keys", [], |row| row.get::<_, i64>(0))
                .expect("read foreign key pragma");
            assert_eq!(foreign_keys, 1);
            let error = connection
                .execute(
                    "INSERT INTO runtime_job_leases (
                        lease_id,
                        job_id,
                        holder,
                        acquired_at_ms,
                        heartbeat_at_ms,
                        expires_at_ms,
                        status
                    ) VALUES ('lease-orphan', 'missing-job', 'holder', 1, 1, 2, 'active')",
                    [],
                )
                .expect_err("orphan lease must fail");
            assert!(error.to_string().contains("FOREIGN KEY"));
            Ok(())
        })
        .expect("schema init succeeds");

        let jobs_migration = read_migration_family(&project, JOBS_FAMILY);
        let leases_migration = read_migration_family(&project, LEASES_FAMILY);
        with_runtime_writer(|| {
            open_job_runtime_locked(&project)?;
            Ok(())
        })
        .expect("schema init is idempotent");
        assert_eq!(jobs_migration, read_migration_family(&project, JOBS_FAMILY));
        assert_eq!(
            leases_migration,
            read_migration_family(&project, LEASES_FAMILY)
        );

        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn active_lease_unique_index_rejects_duplicate_active_lease() {
        let project = temp_project("job-active-lease-unique");
        fs::create_dir_all(&project).expect("create temp project");

        with_runtime_writer(|| {
            let connection = open_job_runtime_locked(&project)?;
            connection
                .execute(
                    "INSERT INTO runtime_jobs (
                        job_id,
                        kind,
                        payload,
                        state,
                        attempt,
                        max_attempts,
                        priority,
                        created_at_ms,
                        updated_at_ms,
                        queued_at_ms
                    ) VALUES ('job-1', 'compile-page', '{}', 'running', 1, 3, 0, 100, 100, 100)",
                    [],
                )
                .expect("insert job");
            connection
                .execute(
                    "INSERT INTO runtime_job_leases (
                        lease_id,
                        job_id,
                        holder,
                        acquired_at_ms,
                        heartbeat_at_ms,
                        expires_at_ms,
                        status
                    ) VALUES ('lease-1', 'job-1', 'worker-a', 200, 200, 300, 'active')",
                    [],
                )
                .expect("insert first active lease");
            let error = connection
                .execute(
                    "INSERT INTO runtime_job_leases (
                        lease_id,
                        job_id,
                        holder,
                        acquired_at_ms,
                        heartbeat_at_ms,
                        expires_at_ms,
                        status
                    ) VALUES ('lease-2', 'job-1', 'worker-b', 200, 200, 300, 'active')",
                    [],
                )
                .expect_err("second active lease must fail");
            assert!(error.to_string().contains("UNIQUE"));
            Ok(())
        })
        .expect("unique index check succeeds");

        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn enabled_job_create_without_project_returns_no_project() {
        let error = runtime_job_create_for_project(None, true, create_request("job-1"), 100)
            .expect_err("no-project create should fail");

        assert!(error.starts_with("no-project"));
    }

    #[test]
    fn create_claim_heartbeat_and_complete_job() {
        let project = temp_project("job-happy-path");
        fs::create_dir_all(&project).expect("create temp project");

        let created =
            runtime_job_create_for_project(Some(&project), true, create_request("job-1"), 100)
                .expect("create job");
        assert_eq!(created.state, "queued");
        assert_eq!(created.attempt, 0);

        let claimed = runtime_job_claim_for_project(
            Some(&project),
            true,
            claim_request("worker-a", "lease-1"),
            200,
        )
        .expect("claim job");
        assert_eq!(claimed.job.state, "running");
        assert_eq!(claimed.job.attempt, 1);
        assert_eq!(claimed.lease.status, ACTIVE_LEASE_STATUS);
        assert_eq!(claimed.lease.expires_at_ms, 200 + DEFAULT_LEASE_TTL_MS);

        let heartbeat = runtime_job_heartbeat_for_project(
            Some(&project),
            true,
            lease_request("job-1", "lease-1"),
            250,
        )
        .expect("heartbeat job");
        assert_eq!(heartbeat.lease.heartbeat_at_ms, 250);

        let completed = runtime_job_complete_for_project(
            Some(&project),
            true,
            lease_request("job-1", "lease-1"),
            300,
        )
        .expect("complete job");
        assert_eq!(completed.state, "completed");

        let list = runtime_job_list_for_project(Some(&project), true).expect("list jobs");
        assert_eq!(list.jobs.len(), 1);
        assert_eq!(list.leases[0].status, RELEASED_LEASE_STATUS);
        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn concurrent_claims_cannot_claim_same_job() {
        let project = temp_project("job-concurrent-claim");
        fs::create_dir_all(&project).expect("create temp project");
        runtime_job_create_for_project(Some(&project), true, create_request("job-1"), 100)
            .expect("create job");

        let first_project = project.clone();
        let first = std::thread::spawn(move || {
            runtime_job_claim_for_project(
                Some(&first_project),
                true,
                claim_request("worker-a", "lease-a"),
                200,
            )
        });
        let second_project = project.clone();
        let second = std::thread::spawn(move || {
            runtime_job_claim_for_project(
                Some(&second_project),
                true,
                claim_request("worker-b", "lease-b"),
                200,
            )
        });

        let results = vec![
            first.join().expect("first thread"),
            second.join().expect("second thread"),
        ];
        assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
        assert_eq!(results.iter().filter(|result| result.is_err()).count(), 1);

        let list = runtime_job_list_for_project(Some(&project), true).expect("list jobs");
        assert_eq!(
            list.leases
                .iter()
                .filter(|lease| lease.status == ACTIVE_LEASE_STATUS)
                .count(),
            1
        );
        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn fail_retry_and_retry_wait_eligibility_are_bounded() {
        let project = temp_project("job-retry");
        fs::create_dir_all(&project).expect("create temp project");
        runtime_job_create_for_project(Some(&project), true, create_request("job-1"), 100)
            .expect("create job");
        runtime_job_claim_for_project(
            Some(&project),
            true,
            claim_request("worker-a", "lease-1"),
            200,
        )
        .expect("claim job");

        let retry_wait = runtime_job_fail_for_project(
            Some(&project),
            true,
            RuntimeJobFailRequest {
                job_id: "job-1".to_string(),
                lease_id: "lease-1".to_string(),
                error: Some("provider-error".to_string()),
                retry_after_ms: Some(500),
            },
            300,
        )
        .expect("fail to retry wait");
        assert_eq!(retry_wait.state, "retry-wait");

        let early_retry = runtime_job_retry_for_project(
            Some(&project),
            true,
            RuntimeJobRetryRequest {
                job_id: "job-1".to_string(),
            },
            400,
        )
        .expect_err("retry before retry_after is rejected");
        assert!(early_retry.starts_with("retry-not-ready"));

        let retried = runtime_job_retry_for_project(
            Some(&project),
            true,
            RuntimeJobRetryRequest {
                job_id: "job-1".to_string(),
            },
            500,
        )
        .expect("retry after eligibility");
        assert_eq!(retried.state, "queued");
        assert_eq!(retried.attempt, 1);

        let claimed_again = runtime_job_claim_for_project(
            Some(&project),
            true,
            claim_request("worker-b", "lease-2"),
            600,
        )
        .expect("claim retried job");
        assert_eq!(claimed_again.job.state, "running");
        assert_eq!(claimed_again.job.attempt, 2);
        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn retry_wait_without_retry_after_is_not_eligible() {
        let project = temp_project("job-retry-wait-null");
        fs::create_dir_all(&project).expect("create temp project");

        with_runtime_writer(|| {
            let connection = open_job_runtime_locked(&project)?;
            connection
                .execute(
                    "INSERT INTO runtime_jobs (
                        job_id,
                        kind,
                        payload,
                        state,
                        attempt,
                        max_attempts,
                        priority,
                        created_at_ms,
                        updated_at_ms,
                        queued_at_ms,
                        retry_after_ms
                    ) VALUES ('job-1', 'compile-page', '{}', 'retry-wait', 1, 3, 0, 100, 100, 100, NULL)",
                    [],
                )
                .expect("insert retry-wait job");
            Ok(())
        })
        .expect("seed retry-wait job succeeds");

        let error = runtime_job_retry_for_project(
            Some(&project),
            true,
            RuntimeJobRetryRequest {
                job_id: "job-1".to_string(),
            },
            500,
        )
        .expect_err("retry-wait without retry_after is rejected");

        assert!(error.starts_with("retry-not-ready"));
        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn cancel_is_allowed_from_queued_and_retry_wait() {
        let project = temp_project("job-cancel-non-terminal");
        fs::create_dir_all(&project).expect("create temp project");
        runtime_job_create_for_project(Some(&project), true, create_request("job-queued"), 100)
            .expect("create queued job");
        let queued_cancel = runtime_job_cancel_for_project(
            Some(&project),
            true,
            RuntimeJobCancelRequest {
                job_id: "job-queued".to_string(),
            },
            150,
        )
        .expect("cancel queued job");
        assert_eq!(queued_cancel.state, "cancelled");

        runtime_job_create_for_project(Some(&project), true, create_request("job-retry"), 200)
            .expect("create retry job");
        runtime_job_claim_for_project(
            Some(&project),
            true,
            claim_request("worker-a", "lease-retry"),
            250,
        )
        .expect("claim retry job");
        let retry_wait = runtime_job_fail_for_project(
            Some(&project),
            true,
            RuntimeJobFailRequest {
                job_id: "job-retry".to_string(),
                lease_id: "lease-retry".to_string(),
                error: Some("provider-error".to_string()),
                retry_after_ms: Some(500),
            },
            300,
        )
        .expect("fail to retry wait");
        assert_eq!(retry_wait.state, "retry-wait");
        let retry_cancel = runtime_job_cancel_for_project(
            Some(&project),
            true,
            RuntimeJobCancelRequest {
                job_id: "job-retry".to_string(),
            },
            350,
        )
        .expect("cancel retry-wait job");
        assert_eq!(retry_cancel.state, "cancelled");

        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn invalid_inputs_and_wrong_lease_are_rejected() {
        let project = temp_project("job-invalid-inputs");
        fs::create_dir_all(&project).expect("create temp project");

        let empty_kind = runtime_job_create_for_project(
            Some(&project),
            true,
            RuntimeJobCreateRequest {
                job_id: Some("job-empty-kind".to_string()),
                kind: "  ".to_string(),
                payload: "{}".to_string(),
                max_attempts: None,
                priority: None,
            },
            100,
        )
        .expect_err("empty kind is rejected");
        assert!(empty_kind.starts_with("invalid-kind"));

        let empty_payload = runtime_job_create_for_project(
            Some(&project),
            true,
            RuntimeJobCreateRequest {
                job_id: Some("job-empty-payload".to_string()),
                kind: "compile-page".to_string(),
                payload: "  ".to_string(),
                max_attempts: None,
                priority: None,
            },
            100,
        )
        .expect_err("empty payload is rejected");
        assert!(empty_payload.starts_with("invalid-payload"));

        runtime_job_create_for_project(Some(&project), true, create_request("job-1"), 100)
            .expect("create job");
        let empty_holder = runtime_job_claim_for_project(
            Some(&project),
            true,
            RuntimeJobClaimRequest {
                holder: "  ".to_string(),
                lease_id: Some("lease-empty-holder".to_string()),
            },
            200,
        )
        .expect_err("empty holder is rejected");
        assert!(empty_holder.starts_with("invalid-holder"));

        let claim = runtime_job_claim_for_project(
            Some(&project),
            true,
            claim_request("worker-a", "lease-1"),
            200,
        )
        .expect("claim job");
        assert_eq!(claim.job.state, "running");

        let wrong_lease = runtime_job_complete_for_project(
            Some(&project),
            true,
            lease_request("job-1", "lease-wrong"),
            250,
        )
        .expect_err("wrong lease is rejected");
        assert!(wrong_lease.starts_with("lease-not-found"));

        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn paused_job_only_allows_cancel_in_pr3() {
        let project = temp_project("job-paused-boundary");
        fs::create_dir_all(&project).expect("create temp project");

        with_runtime_writer(|| {
            let connection = open_job_runtime_locked(&project)?;
            connection
                .execute(
                    "INSERT INTO runtime_jobs (
                        job_id,
                        kind,
                        payload,
                        state,
                        attempt,
                        max_attempts,
                        priority,
                        created_at_ms,
                        updated_at_ms,
                        queued_at_ms
                    ) VALUES ('job-paused', 'compile-page', '{}', 'paused', 1, 3, 0, 100, 100, 100)",
                    [],
                )
                .expect("insert paused job");
            connection
                .execute(
                    "INSERT INTO runtime_job_leases (
                        lease_id,
                        job_id,
                        holder,
                        acquired_at_ms,
                        heartbeat_at_ms,
                        expires_at_ms,
                        status
                    ) VALUES ('lease-paused', 'job-paused', 'worker-a', 200, 200, 300, 'active')",
                    [],
                )
                .expect("insert paused active lease");
            Ok(())
        })
        .expect("seed paused job succeeds");

        let retry_error = runtime_job_retry_for_project(
            Some(&project),
            true,
            RuntimeJobRetryRequest {
                job_id: "job-paused".to_string(),
            },
            250,
        )
        .expect_err("paused retry is rejected");
        assert!(retry_error.contains("invalid-transition"));

        let heartbeat_error = runtime_job_heartbeat_for_project(
            Some(&project),
            true,
            lease_request("job-paused", "lease-paused"),
            250,
        )
        .expect_err("paused heartbeat is rejected");
        assert!(heartbeat_error.contains("invalid-transition"));

        let complete_error = runtime_job_complete_for_project(
            Some(&project),
            true,
            lease_request("job-paused", "lease-paused"),
            250,
        )
        .expect_err("paused complete is rejected");
        assert!(complete_error.contains("invalid-transition"));

        let fail_error = runtime_job_fail_for_project(
            Some(&project),
            true,
            RuntimeJobFailRequest {
                job_id: "job-paused".to_string(),
                lease_id: "lease-paused".to_string(),
                error: None,
                retry_after_ms: None,
            },
            250,
        )
        .expect_err("paused fail is rejected");
        assert!(fail_error.contains("invalid-transition"));

        let claim_error = runtime_job_claim_for_project(
            Some(&project),
            true,
            claim_request("worker-b", "lease-other"),
            250,
        )
        .expect_err("paused claim is rejected");
        assert!(claim_error.starts_with("no-queued-job"));

        let cancelled = runtime_job_cancel_for_project(
            Some(&project),
            true,
            RuntimeJobCancelRequest {
                job_id: "job-paused".to_string(),
            },
            300,
        )
        .expect("paused cancel succeeds");
        assert_eq!(cancelled.state, "cancelled");
        let list = runtime_job_list_for_project(Some(&project), true).expect("list jobs");
        assert_eq!(list.leases[0].status, CANCELLED_LEASE_STATUS);

        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn fail_moves_to_failed_when_retry_max_is_exhausted() {
        let project = temp_project("job-fail-exhausted");
        fs::create_dir_all(&project).expect("create temp project");
        runtime_job_create_for_project(
            Some(&project),
            true,
            create_request_with_max_attempts("job-1", 1),
            100,
        )
        .expect("create job");
        runtime_job_claim_for_project(
            Some(&project),
            true,
            claim_request("worker-a", "lease-1"),
            200,
        )
        .expect("claim job");

        let failed = runtime_job_fail_for_project(
            Some(&project),
            true,
            RuntimeJobFailRequest {
                job_id: "job-1".to_string(),
                lease_id: "lease-1".to_string(),
                error: Some("still bad".to_string()),
                retry_after_ms: Some(500),
            },
            300,
        )
        .expect("fail exhausted job");

        assert_eq!(failed.state, "failed");
        assert_eq!(failed.retry_after_ms, None);
        let retry_error = runtime_job_retry_for_project(
            Some(&project),
            true,
            RuntimeJobRetryRequest {
                job_id: "job-1".to_string(),
            },
            500,
        )
        .expect_err("retry max exhausted");
        assert!(retry_error.starts_with("retry-limit-exhausted"));
        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn cancel_running_invalidates_old_lease_results() {
        let project = temp_project("job-cancel-running");
        fs::create_dir_all(&project).expect("create temp project");
        runtime_job_create_for_project(Some(&project), true, create_request("job-1"), 100)
            .expect("create job");
        runtime_job_claim_for_project(
            Some(&project),
            true,
            claim_request("worker-a", "lease-1"),
            200,
        )
        .expect("claim job");

        let cancelled = runtime_job_cancel_for_project(
            Some(&project),
            true,
            RuntimeJobCancelRequest {
                job_id: "job-1".to_string(),
            },
            300,
        )
        .expect("cancel job");
        assert_eq!(cancelled.state, "cancelled");

        for result in [
            runtime_job_heartbeat_for_project(
                Some(&project),
                true,
                lease_request("job-1", "lease-1"),
                400,
            )
            .map(|_| ()),
            runtime_job_complete_for_project(
                Some(&project),
                true,
                lease_request("job-1", "lease-1"),
                400,
            )
            .map(|_| ()),
            runtime_job_fail_for_project(
                Some(&project),
                true,
                RuntimeJobFailRequest {
                    job_id: "job-1".to_string(),
                    lease_id: "lease-1".to_string(),
                    error: None,
                    retry_after_ms: None,
                },
                400,
            )
            .map(|_| ()),
        ] {
            let error = result.expect_err("old lease result should be ignored");
            assert!(error.contains("invalid-transition") || error.contains("inactive-lease"));
        }

        let list = runtime_job_list_for_project(Some(&project), true).expect("list jobs");
        assert_eq!(list.jobs[0].state, "cancelled");
        assert_eq!(list.leases[0].status, CANCELLED_LEASE_STATUS);
        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn lease_timeout_moves_running_job_to_retry_wait_or_failed() {
        let project = temp_project("job-lease-timeout");
        fs::create_dir_all(&project).expect("create temp project");
        runtime_job_create_for_project(Some(&project), true, create_request("job-1"), 100)
            .expect("create job");
        runtime_job_claim_for_project(
            Some(&project),
            true,
            claim_request("worker-a", "lease-1"),
            200,
        )
        .expect("claim job");

        let early_timeout =
            runtime_job_lease_timeout_for_project(Some(&project), true, "job-1", "lease-1", 300)
                .expect_err("lease timeout before expiry is rejected");
        assert!(early_timeout.starts_with("lease-not-expired"));

        let expired_at = 200 + DEFAULT_LEASE_TTL_MS;
        for result in [
            runtime_job_heartbeat_for_project(
                Some(&project),
                true,
                lease_request("job-1", "lease-1"),
                expired_at,
            )
            .map(|_| ()),
            runtime_job_complete_for_project(
                Some(&project),
                true,
                lease_request("job-1", "lease-1"),
                expired_at,
            )
            .map(|_| ()),
            runtime_job_fail_for_project(
                Some(&project),
                true,
                RuntimeJobFailRequest {
                    job_id: "job-1".to_string(),
                    lease_id: "lease-1".to_string(),
                    error: None,
                    retry_after_ms: None,
                },
                expired_at,
            )
            .map(|_| ()),
        ] {
            let error = result.expect_err("expired lease operation should be rejected");
            assert!(error.starts_with("lease-expired"));
        }

        let timeout = runtime_job_lease_timeout_for_project(
            Some(&project),
            true,
            "job-1",
            "lease-1",
            expired_at,
        )
        .expect("lease timeout");
        assert_eq!(timeout.state, "retry-wait");
        let list = runtime_job_list_for_project(Some(&project), true).expect("list jobs");
        assert_eq!(list.leases[0].status, EXPIRED_LEASE_STATUS);
        let _ = fs::remove_dir_all(project);
    }
}
