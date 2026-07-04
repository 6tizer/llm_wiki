use crate::commands::file_sync::ProjectRootState;
use crate::panic_guard::run_guarded;
use rusqlite::{
    params, params_from_iter, Connection, OpenFlags, OptionalExtension, ToSql, Transaction,
};
use std::path::Path;
use tauri::State;

use super::*;
use uuid::Uuid;

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
        runtime_job_create_for_project(project_root.as_deref(), runtime_enabled, request, now)
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
        runtime_job_claim_for_project(project_root.as_deref(), runtime_enabled, request, now)
    })
}

/// Claim the next queued runtime job for a specific job kind.
#[tauri::command]
pub fn runtime_job_claim_by_kind(
    request: RuntimeJobClaimByKindRequest,
    root_state: State<'_, ProjectRootState>,
) -> Result<RuntimeJobClaim, String> {
    run_guarded("runtime_job_claim_by_kind", || {
        let runtime_enabled = resolve_work_runtime_enabled(read_work_runtime_flag_value());
        let project_root = root_state.get();
        let now = now_for_enabled_project(project_root.as_deref(), runtime_enabled)?;
        runtime_job_claim_by_kind_for_project(
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
        runtime_job_heartbeat_for_project(project_root.as_deref(), runtime_enabled, request, now)
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
        runtime_job_complete_for_project(project_root.as_deref(), runtime_enabled, request, now)
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
        runtime_job_fail_for_project(project_root.as_deref(), runtime_enabled, request, now)
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
        runtime_job_retry_for_project(project_root.as_deref(), runtime_enabled, request, now)
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
        runtime_job_cancel_for_project(project_root.as_deref(), runtime_enabled, request, now)
    })
}

/// Pause a queued or running runtime job.
#[tauri::command]
pub fn runtime_job_pause(
    request: RuntimeJobPauseRequest,
    root_state: State<'_, ProjectRootState>,
) -> Result<RuntimeJobRecord, String> {
    run_guarded("runtime_job_pause", || {
        let runtime_enabled = resolve_work_runtime_enabled(read_work_runtime_flag_value());
        let project_root = root_state.get();
        let now = now_for_enabled_project(project_root.as_deref(), runtime_enabled)?;
        runtime_job_pause_for_project(project_root.as_deref(), runtime_enabled, request, now)
    })
}

/// Resume a paused runtime job back to the queued state.
#[tauri::command]
pub fn runtime_job_resume(
    request: RuntimeJobResumeRequest,
    root_state: State<'_, ProjectRootState>,
) -> Result<RuntimeJobRecord, String> {
    run_guarded("runtime_job_resume", || {
        let runtime_enabled = resolve_work_runtime_enabled(read_work_runtime_flag_value());
        let project_root = root_state.get();
        let now = now_for_enabled_project(project_root.as_deref(), runtime_enabled)?;
        runtime_job_resume_for_project(project_root.as_deref(), runtime_enabled, request, now)
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

pub(crate) fn runtime_job_create_for_project(
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

pub(crate) fn runtime_job_claim_for_project(
    project_root: Option<&Path>,
    enabled: bool,
    request: RuntimeJobClaimRequest,
    now: i64,
) -> Result<RuntimeJobClaim, String> {
    runtime_job_claim_matching_kind_for_project(project_root, enabled, request, None, None, now)
}

pub(crate) fn runtime_job_claim_by_kind_for_project(
    project_root: Option<&Path>,
    enabled: bool,
    request: RuntimeJobClaimByKindRequest,
    now: i64,
) -> Result<RuntimeJobClaim, String> {
    let kind = require_non_empty("invalid-kind", "kind", &request.kind)?.to_string();
    let payload_layer = normalize_optional_id(
        "invalid-payload-layer",
        "payloadLayer",
        request.payload_layer,
    )?;
    runtime_job_claim_matching_kind_for_project(
        project_root,
        enabled,
        RuntimeJobClaimRequest {
            holder: request.holder,
            lease_id: request.lease_id,
            job_id: None,
        },
        Some(kind),
        payload_layer,
        now,
    )
}

fn runtime_job_claim_matching_kind_for_project(
    project_root: Option<&Path>,
    enabled: bool,
    request: RuntimeJobClaimRequest,
    kind_filter: Option<String>,
    payload_layer_filter: Option<String>,
    now: i64,
) -> Result<RuntimeJobClaim, String> {
    let project_root = require_enabled_project(project_root, enabled)?;
    let holder = require_non_empty("invalid-holder", "holder", &request.holder)?.to_string();
    let job_id_filter = normalize_optional_id("invalid-job-id", "jobId", request.job_id)?;
    with_runtime_writer(|| {
        let mut connection = open_job_runtime_locked(project_root)?;
        let tx = connection.transaction().map_err(tx_err)?;

        // `select` + `UPDATE ... WHERE state = 'queued'` is two round trips, so
        // in principle another writer could flip the same job's state between
        // them. `with_runtime_writer` currently serializes every writer body
        // behind one process-wide mutex, so that interleaving cannot happen
        // today — but this loop is defense-in-depth against that assumption
        // ever changing (e.g. a future move to per-connection or async
        // locking). If the UPDATE claims zero rows, the job was already taken;
        // exclude it and select the next candidate instead of inserting a
        // second active lease for a job some other transaction just claimed.
        // When `job_id_filter` is set, excluding the one-and-only matching
        // candidate on a lost race simply makes the NEXT iteration's SELECT
        // return nothing — surfacing as the same "no-queued-job" error a
        // caller would get for a job that was never queued in the first
        // place, which is the correct outcome (SPEC-6 PR3+4 P0-2a).
        let mut excluded_job_ids: Vec<String> = Vec::new();
        let job_id = loop {
            let candidate = select_queued_job_id_tx(
                &tx,
                kind_filter.as_deref(),
                payload_layer_filter.as_deref(),
                job_id_filter.as_deref(),
                &excluded_job_ids,
            )?;
            ensure_no_active_lease(&tx, &candidate)?;
            let claimed_rows = tx
                .execute(
                    "UPDATE runtime_jobs
                     SET state = 'running',
                         attempt = attempt + 1,
                         started_at_ms = COALESCE(started_at_ms, ?2),
                         updated_at_ms = ?2
                     WHERE job_id = ?1 AND state = 'queued'",
                    params![candidate, now],
                )
                .map_err(|err| format!("job-claim-update-failed: {err}"))?;
            if claimed_rows == 0 {
                excluded_job_ids.push(candidate);
                continue;
            }
            break candidate;
        };

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
            params![lease_id, job_id, holder, now, now + DEFAULT_LEASE_TTL_MS],
        )
        .map_err(|err| format!("job-claim-lease-failed: {err}"))?;

        let job = read_job_tx(&tx, &job_id)?;
        let lease = read_lease_tx(&tx, &lease_id)?;
        tx.commit().map_err(tx_err)?;
        Ok(RuntimeJobClaim { job, lease })
    })
}

fn select_queued_job_id_tx(
    tx: &Transaction<'_>,
    kind_filter: Option<&str>,
    payload_layer_filter: Option<&str>,
    job_id_filter: Option<&str>,
    excluded_job_ids: &[String],
) -> Result<String, String> {
    let mut sql = String::from(
        "SELECT job_id
         FROM runtime_jobs
         WHERE state = 'queued'",
    );
    let kind_value = kind_filter.map(str::to_string);
    let payload_layer_value = payload_layer_filter.map(str::to_string);
    let job_id_value = job_id_filter.map(str::to_string);
    let mut sql_params: Vec<&dyn ToSql> = Vec::new();
    if let Some(kind) = kind_value.as_ref() {
        sql.push_str(" AND kind = ?");
        sql_params.push(kind);
    }
    if let Some(layer) = payload_layer_value.as_ref() {
        // SQLite's json_extract returns NULL (never matches `= ?`) for a
        // payload that isn't a JSON object or has no "layer" key, rather
        // than erroring — so a job whose payload doesn't carry a layer
        // simply never matches this filter instead of failing the whole
        // claim (SPEC-6 PR3+4 P0-2b).
        sql.push_str(" AND json_extract(payload, '$.layer') = ?");
        sql_params.push(layer);
    }
    if let Some(job_id) = job_id_value.as_ref() {
        sql.push_str(" AND job_id = ?");
        sql_params.push(job_id);
    }
    for excluded_job_id in excluded_job_ids {
        sql.push_str(" AND job_id != ?");
        sql_params.push(excluded_job_id);
    }
    sql.push_str(
        " ORDER BY priority DESC, queued_at_ms ASC, created_at_ms ASC
          LIMIT 1",
    );
    let result = tx
        .query_row(&sql, params_from_iter(sql_params), |row| row.get(0))
        .optional()
        .map_err(|err| format!("job-claim-select-failed: {err}"))?;
    result.ok_or_else(|| "no-queued-job: no queued runtime job is available".to_string())
}

pub(crate) fn runtime_job_heartbeat_for_project(
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
        let existing_lease = read_lease_tx(&tx, &request.lease_id)?;
        let within_min_interval =
            now.saturating_sub(existing_lease.heartbeat_at_ms) < DEFAULT_HEARTBEAT_MIN_INTERVAL_MS;
        let has_safe_expiry_margin =
            existing_lease.expires_at_ms.saturating_sub(now) >= DEFAULT_HEARTBEAT_MIN_INTERVAL_MS;
        if within_min_interval && has_safe_expiry_margin {
            let job = read_job_tx(&tx, &request.job_id)?;
            tx.commit().map_err(tx_err)?;
            return Ok(RuntimeJobClaim {
                job,
                lease: existing_lease,
            });
        }
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

pub(crate) fn runtime_job_complete_for_project(
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

pub(crate) fn runtime_job_fail_for_project(
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

pub(crate) fn runtime_job_retry_for_project(
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

pub(crate) fn runtime_job_cancel_for_project(
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

fn runtime_job_pause_for_project(
    project_root: Option<&Path>,
    enabled: bool,
    request: RuntimeJobPauseRequest,
    now: i64,
) -> Result<RuntimeJobRecord, String> {
    let project_root = require_enabled_project(project_root, enabled)?;
    with_runtime_writer(|| {
        let mut connection = open_job_runtime_locked(project_root)?;
        let tx = connection.transaction().map_err(tx_err)?;
        let job = read_job_tx(&tx, &request.job_id)?;
        if !matches!(job.state.as_str(), "queued" | "running") {
            return Err(format!(
                "invalid-transition: pause is not allowed from '{}'",
                job.state
            ));
        }
        tx.execute(
            "UPDATE runtime_jobs
             SET state = 'paused',
                 updated_at_ms = ?2
             WHERE job_id = ?1",
            params![request.job_id, now],
        )
        .map_err(|err| format!("job-pause-failed: {err}"))?;
        if job.state == "running" {
            tx.execute(
                "UPDATE runtime_job_leases
                 SET status = ?2,
                     released_at_ms = ?3
                 WHERE job_id = ?1 AND status = 'active'",
                params![request.job_id, CANCELLED_LEASE_STATUS, now],
            )
            .map_err(|err| format!("job-pause-lease-failed: {err}"))?;
        }
        let job = read_job_tx(&tx, &request.job_id)?;
        tx.commit().map_err(tx_err)?;
        Ok(job)
    })
}

fn runtime_job_resume_for_project(
    project_root: Option<&Path>,
    enabled: bool,
    request: RuntimeJobResumeRequest,
    now: i64,
) -> Result<RuntimeJobRecord, String> {
    let project_root = require_enabled_project(project_root, enabled)?;
    with_runtime_writer(|| {
        let mut connection = open_job_runtime_locked(project_root)?;
        let tx = connection.transaction().map_err(tx_err)?;
        let job = read_job_tx(&tx, &request.job_id)?;
        if job.state != "paused" {
            return Err(format!(
                "invalid-transition: resume is not allowed from '{}'",
                job.state
            ));
        }
        tx.execute(
            "UPDATE runtime_jobs
             SET state = 'queued',
                 queued_at_ms = ?2,
                 updated_at_ms = ?2
             WHERE job_id = ?1",
            params![request.job_id, now],
        )
        .map_err(|err| format!("job-resume-failed: {err}"))?;
        let job = read_job_tx(&tx, &request.job_id)?;
        tx.commit().map_err(tx_err)?;
        Ok(job)
    })
}

pub(crate) fn runtime_job_list_for_project(
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

pub(crate) fn ensure_job_exists(tx: &Transaction<'_>, job_id: &str) -> Result<(), String> {
    let exists = tx
        .query_row(
            "SELECT 1 FROM runtime_jobs WHERE job_id = ?1 LIMIT 1",
            [job_id],
            |_| Ok(()),
        )
        .optional()
        .map_err(|err| format!("job-check-failed: {err}"))?
        .is_some();
    if exists {
        Ok(())
    } else {
        Err("job-not-found: runtime job does not exist".to_string())
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

fn read_job(connection: &Connection, job_id: &str) -> Result<RuntimeJobRecord, String> {
    connection
        .query_row(&job_select_sql("WHERE job_id = ?1"), [job_id], map_job_row)
        .map_err(|err| format!("job-read-failed: {err}"))
}

pub(crate) fn read_job_tx(tx: &Transaction<'_>, job_id: &str) -> Result<RuntimeJobRecord, String> {
    tx.query_row(&job_select_sql("WHERE job_id = ?1"), [job_id], map_job_row)
        .map_err(|err| format!("job-read-failed: {err}"))
}

pub(crate) fn read_lease_tx(
    tx: &Transaction<'_>,
    lease_id: &str,
) -> Result<RuntimeJobLeaseRecord, String> {
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

#[cfg(test)]
mod tests {
    use super::*;

    use rusqlite::Connection;

    use std::fs;
    use std::sync::{Arc, Barrier};

    fn create_request_with_kind(
        job_id: &str,
        kind: &str,
        priority: i64,
    ) -> RuntimeJobCreateRequest {
        RuntimeJobCreateRequest {
            job_id: Some(job_id.to_string()),
            kind: kind.to_string(),
            payload: "{}".to_string(),
            max_attempts: None,
            priority: Some(priority),
        }
    }

    fn pause_request(job_id: &str) -> RuntimeJobPauseRequest {
        RuntimeJobPauseRequest {
            job_id: job_id.to_string(),
        }
    }

    fn resume_request(job_id: &str) -> RuntimeJobResumeRequest {
        RuntimeJobResumeRequest {
            job_id: job_id.to_string(),
        }
    }

    #[test]
    fn job_pause_resume_request_shapes_reject_unknown_fields() {
        let pause = serde_json::from_value::<RuntimeJobPauseRequest>(serde_json::json!({
            "jobId": "job-1",
            "root": "/tmp/project"
        }))
        .expect_err("pause request rejects root");
        assert!(pause.to_string().contains("unknown field"));

        let resume = serde_json::from_value::<RuntimeJobResumeRequest>(serde_json::json!({
            "jobId": "job-1",
            "dbPath": "/tmp/runtime.db"
        }))
        .expect_err("resume request rejects dbPath");
        assert!(resume.to_string().contains("unknown field"));
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
    fn disabled_job_pause_resume_do_not_open_damaged_runtime_db() {
        let project = temp_project("disabled-job-pause-resume");
        let runtime_dir = project.join(RUNTIME_DIR);
        fs::create_dir_all(&runtime_dir).expect("create runtime dir");
        let db_path = runtime_dir.join(RUNTIME_DB_FILE);
        fs::write(&db_path, b"not sqlite").expect("write damaged db");

        let pause_error =
            runtime_job_pause_for_project(Some(&project), false, pause_request("job-1"), 100)
                .expect_err("disabled pause should fail before DB open");
        let resume_error =
            runtime_job_resume_for_project(Some(&project), false, resume_request("job-1"), 100)
                .expect_err("disabled resume should fail before DB open");

        assert!(pause_error.starts_with("runtime-disabled"));
        assert!(resume_error.starts_with("runtime-disabled"));
        assert_eq!(fs::read(&db_path).expect("read damaged db"), b"not sqlite");
        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn enabled_job_pause_resume_without_project_returns_no_project() {
        let pause_error = runtime_job_pause_for_project(None, true, pause_request("job-1"), 100)
            .expect_err("pause without project should fail");
        let resume_error = runtime_job_resume_for_project(None, true, resume_request("job-1"), 100)
            .expect_err("resume without project should fail");

        assert!(pause_error.starts_with("no-project"));
        assert!(resume_error.starts_with("no-project"));
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

        let early_heartbeat = runtime_job_heartbeat_for_project(
            Some(&project),
            true,
            lease_request("job-1", "lease-1"),
            250,
        )
        .expect("early heartbeat is idempotent");
        assert_eq!(early_heartbeat.lease.heartbeat_at_ms, 200);
        assert_eq!(
            early_heartbeat.lease.expires_at_ms,
            200 + DEFAULT_LEASE_TTL_MS
        );

        let heartbeat = runtime_job_heartbeat_for_project(
            Some(&project),
            true,
            lease_request("job-1", "lease-1"),
            200 + DEFAULT_HEARTBEAT_MIN_INTERVAL_MS,
        )
        .expect("heartbeat job after min interval");
        assert_eq!(
            heartbeat.lease.heartbeat_at_ms,
            200 + DEFAULT_HEARTBEAT_MIN_INTERVAL_MS
        );
        assert_eq!(
            heartbeat.lease.expires_at_ms,
            200 + DEFAULT_HEARTBEAT_MIN_INTERVAL_MS + DEFAULT_LEASE_TTL_MS
        );

        let completed = runtime_job_complete_for_project(
            Some(&project),
            true,
            lease_request("job-1", "lease-1"),
            200 + DEFAULT_HEARTBEAT_MIN_INTERVAL_MS + 100,
        )
        .expect("complete job");
        assert_eq!(completed.state, "completed");

        let list = runtime_job_list_for_project(Some(&project), true).expect("list jobs");
        assert_eq!(list.jobs.len(), 1);
        assert_eq!(list.leases[0].status, RELEASED_LEASE_STATUS);
        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn scoped_claim_only_claims_requested_job_kind() {
        let project = temp_project("job-claim-by-kind");
        fs::create_dir_all(&project).expect("create temp project");

        runtime_job_create_for_project(
            Some(&project),
            true,
            create_request_with_kind("job-other-high", "compile-page", 100),
            100,
        )
        .expect("create high-priority other job");
        runtime_job_create_for_project(
            Some(&project),
            true,
            create_request_with_kind("job-prepare-low", "bulk-knowledge-prepare", 10),
            110,
        )
        .expect("create lower-priority prepare job");
        runtime_job_create_for_project(
            Some(&project),
            true,
            create_request_with_kind("job-prepare-high", "bulk-knowledge-prepare", 20),
            120,
        )
        .expect("create higher-priority prepare job");

        let scoped = runtime_job_claim_by_kind_for_project(
            Some(&project),
            true,
            claim_by_kind_request("worker-a", "lease-scoped", "bulk-knowledge-prepare"),
            200,
        )
        .expect("claim prepare job");
        assert_eq!(scoped.job.job_id, "job-prepare-high");
        assert_eq!(scoped.job.kind, "bulk-knowledge-prepare");

        let unscoped = runtime_job_claim_for_project(
            Some(&project),
            true,
            claim_request("worker-b", "lease-unscoped"),
            220,
        )
        .expect("unscoped claim still sees global priority");
        assert_eq!(unscoped.job.job_id, "job-other-high");
        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn scoped_claim_rejects_missing_or_invalid_kind_without_changing_unscoped_claim() {
        let project = temp_project("job-claim-by-kind-missing");
        fs::create_dir_all(&project).expect("create temp project");
        runtime_job_create_for_project(
            Some(&project),
            true,
            create_request_with_kind("job-other", "compile-page", 100),
            100,
        )
        .expect("create non-prepare job");

        let missing = runtime_job_claim_by_kind_for_project(
            Some(&project),
            true,
            claim_by_kind_request("worker-a", "lease-missing", "bulk-knowledge-prepare"),
            200,
        )
        .expect_err("missing kind has no queued job");
        assert!(missing.starts_with("no-queued-job"));

        let invalid = runtime_job_claim_by_kind_for_project(
            Some(&project),
            true,
            claim_by_kind_request("worker-a", "lease-invalid", "  "),
            200,
        )
        .expect_err("empty kind is rejected");
        assert!(invalid.starts_with("invalid-kind"));

        let unscoped = runtime_job_claim_for_project(
            Some(&project),
            true,
            claim_request("worker-b", "lease-unscoped"),
            220,
        )
        .expect("unscoped claim remains available");
        assert_eq!(unscoped.job.job_id, "job-other");

        let unknown = serde_json::from_value::<RuntimeJobClaimByKindRequest>(serde_json::json!({
            "holder": "worker-a",
            "leaseId": "lease-unknown",
            "kind": "bulk-knowledge-prepare",
            "unknownField": true
        }))
        .expect_err("scoped claim rejects unknown fields");
        assert!(unknown.to_string().contains("unknown field"));
        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn scoped_claim_rejects_inconsistent_active_lease_on_matching_job() {
        let project = temp_project("job-claim-by-kind-active-lease");
        fs::create_dir_all(&project).expect("create temp project");
        runtime_job_create_for_project(
            Some(&project),
            true,
            create_request_with_kind("job-prepare-active", "bulk-knowledge-prepare", 100),
            100,
        )
        .expect("create prepare job");
        runtime_job_create_for_project(
            Some(&project),
            true,
            create_request_with_kind("job-prepare-next", "bulk-knowledge-prepare", 10),
            110,
        )
        .expect("create next prepare job");
        with_runtime_writer(|| {
            let connection = open_job_runtime_locked(&project)?;
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
                    ) VALUES ('lease-active', 'job-prepare-active', 'worker-old', 150, 150, 1000, 'active')",
                    [],
                )
                .expect("insert inconsistent active lease");
            Ok(())
        })
        .expect("seed active lease succeeds");

        let error = runtime_job_claim_by_kind_for_project(
            Some(&project),
            true,
            claim_by_kind_request("worker-new", "lease-new", "bulk-knowledge-prepare"),
            200,
        )
        .expect_err("matching active lease is rejected");
        assert!(error.starts_with("active-lease-exists"));
        let list = runtime_job_list_for_project(Some(&project), true).expect("list jobs");
        assert!(list.jobs.iter().all(|job| job.state == "queued"));
        assert_eq!(list.leases.len(), 1);
        let _ = fs::remove_dir_all(project);
    }

    fn create_derived_rebuild_request(job_id: &str, layer: &str, priority: i64) -> RuntimeJobCreateRequest {
        RuntimeJobCreateRequest {
            job_id: Some(job_id.to_string()),
            kind: "derived-rebuild".to_string(),
            payload: serde_json::json!({
                "layer": layer,
                "affectedPath": format!("wiki/{layer}.md"),
                "markerIds": [],
                "baseVersion": "h",
                "inputHash": "h",
                "reason": "commit",
            })
            .to_string(),
            max_attempts: None,
            priority: Some(priority),
        }
    }

    // ---- SPEC-6 PR3+4 P0-2b: payloadLayer filter on claim_by_kind ----

    #[test]
    fn scoped_claim_by_kind_with_payload_layer_filters_to_matching_layer_only() {
        // The exact cross-consumer collision the internal audit flagged:
        // embedding-consumer and taxonomy-consumer share the SAME job kind
        // ("derived-rebuild"). Without a payload-level filter, a
        // higher-priority sibling-layer job would win the plain kind-scoped
        // claim every time, and each accidental claim increments `attempt`
        // — three such misclaims silently exhausts the OTHER consumer's job
        // to a terminal `failed` state before its own poller ever sees it.
        let project = temp_project("job-claim-payload-layer-hit");
        fs::create_dir_all(&project).expect("create temp project");
        runtime_job_create_for_project(
            Some(&project),
            true,
            create_derived_rebuild_request("job-embedding-high", "embedding", 100),
            100,
        )
        .expect("create high-priority embedding job");
        runtime_job_create_for_project(
            Some(&project),
            true,
            create_derived_rebuild_request("job-taxonomy-low", "taxonomy", 10),
            110,
        )
        .expect("create lower-priority taxonomy job");

        let claimed = runtime_job_claim_by_kind_for_project(
            Some(&project),
            true,
            claim_by_kind_request_with_layer("taxonomy-consumer", "lease-tax", "derived-rebuild", "taxonomy"),
            200,
        )
        .expect("claim taxonomy-layer job despite lower priority");
        assert_eq!(claimed.job.job_id, "job-taxonomy-low");
        assert_eq!(claimed.job.attempt, 1);

        // The embedding job was never touched — still queued, attempt still 0.
        let list = runtime_job_list_for_project(Some(&project), true).expect("list jobs");
        let embedding_job = list
            .jobs
            .iter()
            .find(|job| job.job_id == "job-embedding-high")
            .expect("embedding job present");
        assert_eq!(embedding_job.state, "queued");
        assert_eq!(embedding_job.attempt, 0);
        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn scoped_claim_by_kind_with_payload_layer_no_match_returns_no_queued_job_and_does_not_touch_other_layers() {
        let project = temp_project("job-claim-payload-layer-miss");
        fs::create_dir_all(&project).expect("create temp project");
        runtime_job_create_for_project(
            Some(&project),
            true,
            create_derived_rebuild_request("job-embedding-only", "embedding", 100),
            100,
        )
        .expect("create embedding job");

        let error = runtime_job_claim_by_kind_for_project(
            Some(&project),
            true,
            claim_by_kind_request_with_layer("taxonomy-consumer", "lease-tax", "derived-rebuild", "taxonomy"),
            200,
        )
        .expect_err("no taxonomy-layer job is queued");
        assert!(error.starts_with("no-queued-job"));

        let list = runtime_job_list_for_project(Some(&project), true).expect("list jobs");
        assert_eq!(list.jobs[0].state, "queued");
        assert_eq!(list.jobs[0].attempt, 0);
        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn scoped_claim_by_kind_without_payload_layer_is_unchanged_backward_compat() {
        // `payloadLayer: None` must behave EXACTLY like before this field
        // existed — claims across layers by priority, same as
        // `scoped_claim_only_claims_requested_job_kind` already proves for
        // the plain kind filter.
        let project = temp_project("job-claim-payload-layer-none");
        fs::create_dir_all(&project).expect("create temp project");
        runtime_job_create_for_project(
            Some(&project),
            true,
            create_derived_rebuild_request("job-embedding-high", "embedding", 100),
            100,
        )
        .expect("create high-priority embedding job");
        runtime_job_create_for_project(
            Some(&project),
            true,
            create_derived_rebuild_request("job-taxonomy-low", "taxonomy", 10),
            110,
        )
        .expect("create lower-priority taxonomy job");

        let claimed = runtime_job_claim_by_kind_for_project(
            Some(&project),
            true,
            claim_by_kind_request("any-consumer", "lease-any", "derived-rebuild"),
            200,
        )
        .expect("claim next queued derived-rebuild job by priority alone");
        assert_eq!(claimed.job.job_id, "job-embedding-high");
        let _ = fs::remove_dir_all(project);
    }

    // ---- SPEC-6 PR3+4 P0-2a: job_id filter on runtime_job_claim ----

    #[test]
    fn claim_with_job_id_filter_claims_only_that_specific_queued_job() {
        let project = temp_project("job-claim-by-id-hit");
        fs::create_dir_all(&project).expect("create temp project");
        runtime_job_create_for_project(
            Some(&project),
            true,
            create_request_with_kind("job-high-priority", "compile-page", 100),
            100,
        )
        .expect("create high-priority job");
        runtime_job_create_for_project(
            Some(&project),
            true,
            create_request_with_kind("job-target-low-priority", "compile-page", 10),
            110,
        )
        .expect("create low-priority target job");

        // Without a job_id filter, priority ordering would pick
        // "job-high-priority" — the filter must override that entirely.
        let claimed = runtime_job_claim_for_project(
            Some(&project),
            true,
            claim_request_with_job_id("synthesis-manual-rebuild", "lease-1", "job-target-low-priority"),
            200,
        )
        .expect("claim the exact requested job");
        assert_eq!(claimed.job.job_id, "job-target-low-priority");

        let list = runtime_job_list_for_project(Some(&project), true).expect("list jobs");
        let untouched = list
            .jobs
            .iter()
            .find(|job| job.job_id == "job-high-priority")
            .expect("high-priority job present");
        assert_eq!(untouched.state, "queued");
        assert_eq!(untouched.attempt, 0);
        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn claim_with_job_id_filter_returns_no_queued_job_without_falling_back_to_a_different_job() {
        let project = temp_project("job-claim-by-id-miss");
        fs::create_dir_all(&project).expect("create temp project");
        runtime_job_create_for_project(
            Some(&project),
            true,
            create_request_with_kind("job-other", "compile-page", 100),
            100,
        )
        .expect("create an unrelated queued job");

        let error = runtime_job_claim_for_project(
            Some(&project),
            true,
            claim_request_with_job_id("worker", "lease-1", "job-does-not-exist"),
            200,
        )
        .expect_err("the specific job id was never queued");
        assert!(error.starts_with("no-queued-job"));

        // Must NOT have silently fallen back to claiming "job-other".
        let list = runtime_job_list_for_project(Some(&project), true).expect("list jobs");
        assert_eq!(list.jobs[0].state, "queued");
        assert_eq!(list.jobs[0].attempt, 0);
        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn heartbeat_near_expiry_bypasses_min_interval_noop() {
        let project = temp_project("job-heartbeat-near-expiry");
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
                        started_at_ms
                    ) VALUES ('job-1', 'compile-page', '{}', 'running', 1, 3, 0, 100, 100, 100, 100)",
                    [],
                )
                .expect("insert running job");
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
                    ) VALUES ('lease-1', 'job-1', 'worker-a', 100, 1000, 5999, 'active')",
                    [],
                )
                .expect("insert near-expiry active lease");
            Ok(())
        })
        .expect("seed near-expiry lease succeeds");

        let heartbeat = runtime_job_heartbeat_for_project(
            Some(&project),
            true,
            lease_request("job-1", "lease-1"),
            5000,
        )
        .expect("near-expiry heartbeat renews");

        assert_eq!(heartbeat.lease.heartbeat_at_ms, 5000);
        assert_eq!(heartbeat.lease.expires_at_ms, 5000 + DEFAULT_LEASE_TTL_MS);
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
                job_id: None,
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
    fn queued_job_can_pause_and_resume() {
        let project = temp_project("job-pause-resume-queued");
        fs::create_dir_all(&project).expect("create temp project");
        runtime_job_create_for_project(Some(&project), true, create_request("job-1"), 100)
            .expect("create job");

        let paused =
            runtime_job_pause_for_project(Some(&project), true, pause_request("job-1"), 150)
                .expect("pause queued job");
        assert_eq!(paused.state, "paused");
        assert_eq!(paused.updated_at_ms, 150);

        let claim_error = runtime_job_claim_for_project(
            Some(&project),
            true,
            claim_request("worker-a", "lease-paused"),
            175,
        )
        .expect_err("paused job is not claimable");
        assert!(claim_error.starts_with("no-queued-job"));

        let resumed =
            runtime_job_resume_for_project(Some(&project), true, resume_request("job-1"), 200)
                .expect("resume paused job");
        assert_eq!(resumed.state, "queued");
        assert_eq!(resumed.queued_at_ms, Some(200));

        let list = runtime_job_list_for_project(Some(&project), true).expect("list jobs");
        assert_eq!(list.jobs[0].state, "queued");
        assert!(list.leases.is_empty());
        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn running_pause_invalidates_old_lease_results() {
        let project = temp_project("job-pause-running");
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

        let paused =
            runtime_job_pause_for_project(Some(&project), true, pause_request("job-1"), 300)
                .expect("pause running job");
        assert_eq!(paused.state, "paused");

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
        assert_eq!(list.jobs[0].state, "paused");
        assert_eq!(list.leases[0].status, CANCELLED_LEASE_STATUS);
        assert_eq!(list.leases[0].released_at_ms, Some(300));
        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn pause_and_resume_reject_invalid_states() {
        let project = temp_project("job-pause-resume-invalid");
        fs::create_dir_all(&project).expect("create temp project");

        runtime_job_create_for_project(Some(&project), true, create_request("job-completed"), 100)
            .expect("create completed job");
        runtime_job_claim_for_project(
            Some(&project),
            true,
            claim_request("worker-a", "lease-completed"),
            120,
        )
        .expect("claim completed job");
        runtime_job_complete_for_project(
            Some(&project),
            true,
            lease_request("job-completed", "lease-completed"),
            140,
        )
        .expect("complete job");

        runtime_job_create_for_project(Some(&project), true, create_request("job-cancelled"), 200)
            .expect("create cancelled job");
        runtime_job_cancel_for_project(
            Some(&project),
            true,
            RuntimeJobCancelRequest {
                job_id: "job-cancelled".to_string(),
            },
            220,
        )
        .expect("cancel job");

        runtime_job_create_for_project(
            Some(&project),
            true,
            create_request_with_max_attempts("job-failed", 1),
            300,
        )
        .expect("create failed job");
        runtime_job_claim_for_project(
            Some(&project),
            true,
            claim_request("worker-a", "lease-failed"),
            320,
        )
        .expect("claim failed job");
        runtime_job_fail_for_project(
            Some(&project),
            true,
            RuntimeJobFailRequest {
                job_id: "job-failed".to_string(),
                lease_id: "lease-failed".to_string(),
                error: None,
                retry_after_ms: None,
            },
            340,
        )
        .expect("fail job");

        runtime_job_create_for_project(Some(&project), true, create_request("job-retry-wait"), 400)
            .expect("create retry wait job");
        runtime_job_claim_for_project(
            Some(&project),
            true,
            claim_request("worker-a", "lease-retry-wait"),
            420,
        )
        .expect("claim retry wait job");
        runtime_job_fail_for_project(
            Some(&project),
            true,
            RuntimeJobFailRequest {
                job_id: "job-retry-wait".to_string(),
                lease_id: "lease-retry-wait".to_string(),
                error: None,
                retry_after_ms: Some(900),
            },
            440,
        )
        .expect("move to retry wait");

        for job_id in [
            "job-completed",
            "job-cancelled",
            "job-failed",
            "job-retry-wait",
        ] {
            let pause_error =
                runtime_job_pause_for_project(Some(&project), true, pause_request(job_id), 500)
                    .expect_err("pause rejects invalid state");
            let resume_error =
                runtime_job_resume_for_project(Some(&project), true, resume_request(job_id), 500)
                    .expect_err("resume rejects non-paused state");
            assert!(pause_error.starts_with("invalid-transition"));
            assert!(resume_error.starts_with("invalid-transition"));
        }

        runtime_job_create_for_project(Some(&project), true, create_request("job-queued"), 600)
            .expect("create queued job");
        let resume_queued =
            runtime_job_resume_for_project(Some(&project), true, resume_request("job-queued"), 650)
                .expect_err("resume rejects queued job");
        assert!(resume_queued.starts_with("invalid-transition"));

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
    fn select_queued_job_id_tx_skips_excluded_ids_and_advances_to_next_candidate() {
        let project = temp_project("select-queued-job-skip");
        fs::create_dir_all(&project).expect("create temp project");
        runtime_job_create_for_project(
            Some(&project),
            true,
            create_request_with_kind("job-1", "compile-page", 0),
            100,
        )
        .expect("create job-1");
        runtime_job_create_for_project(
            Some(&project),
            true,
            create_request_with_kind("job-2", "compile-page", 0),
            100,
        )
        .expect("create job-2");

        let mut connection = open_job_runtime_locked(&project).expect("open runtime db");
        let tx = connection.transaction().expect("begin tx");
        let first = select_queued_job_id_tx(&tx, Some("compile-page"), None, None, &[])
            .expect("select first job");
        assert_eq!(first, "job-1");
        let second = select_queued_job_id_tx(&tx, Some("compile-page"), None, None, &[first.clone()])
            .expect("select next candidate excluding first");
        assert_eq!(second, "job-2");
        let none_left =
            select_queued_job_id_tx(&tx, Some("compile-page"), None, None, &[first, second]);
        assert!(none_left.unwrap_err().starts_with("no-queued-job"));
        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn runtime_job_claim_by_kind_never_double_leases_a_job_under_concurrent_threads() {
        // Real SQLite + real OS threads (not mocked), exercising the exact
        // claim path used by the bulk-prepare worker pool. Today
        // `with_runtime_writer`'s process-wide mutex fully serializes every
        // writer body, so this cannot currently observe a double-claim —
        // the `select_queued_job_id_tx` "skip zero-row UPDATE and retry the
        // next candidate" defense (above) exists for if that ever changes.
        // This test's job is to prove that under real concurrency each
        // queued job is claimed by exactly one thread and never carries
        // more than one active lease.
        let project = temp_project("job-claim-concurrent");
        fs::create_dir_all(&project).expect("create temp project");
        for job_id in ["job-1", "job-2"] {
            runtime_job_create_for_project(
                Some(&project),
                true,
                create_request_with_kind(job_id, "compile-page", 0),
                100,
            )
            .expect("create queued job");
        }

        let shared_project = Arc::new(project.clone());
        let worker_count = 6;
        let barrier = Arc::new(Barrier::new(worker_count));
        let handles = (0..worker_count)
            .map(|index| {
                let project = Arc::clone(&shared_project);
                let barrier = Arc::clone(&barrier);
                std::thread::spawn(move || {
                    barrier.wait();
                    runtime_job_claim_by_kind_for_project(
                        Some(project.as_path()),
                        true,
                        claim_by_kind_request(
                            &format!("worker-{index}"),
                            &format!("lease-{index}"),
                            "compile-page",
                        ),
                        200,
                    )
                })
            })
            .collect::<Vec<_>>();
        let results = handles
            .into_iter()
            .map(|handle| handle.join().expect("claim thread"))
            .collect::<Vec<_>>();

        let mut claimed_job_ids: Vec<&str> = results
            .iter()
            .filter_map(|result| result.as_ref().ok())
            .map(|claim| claim.job.job_id.as_str())
            .collect();
        claimed_job_ids.sort_unstable();
        assert_eq!(claimed_job_ids, vec!["job-1", "job-2"]);

        let failures: Vec<&String> = results
            .iter()
            .filter_map(|result| result.as_ref().err())
            .collect();
        assert_eq!(failures.len(), worker_count - 2);
        assert!(failures
            .iter()
            .all(|error| error.starts_with("no-queued-job")));

        let connection = Connection::open(runtime_db_path(&project)).expect("open runtime db");
        let mut statement = connection
            .prepare(
                "SELECT job_id, COUNT(*) AS active_count
                 FROM runtime_job_leases
                 WHERE status = 'active'
                 GROUP BY job_id
                 HAVING COUNT(*) > 1",
            )
            .expect("prepare duplicate-lease check");
        let duplicate_leases = statement
            .query_map([], |row| row.get::<_, String>(0))
            .expect("query duplicate leases")
            .count();
        assert_eq!(
            duplicate_leases, 0,
            "no job should ever carry two active leases"
        );
        let _ = fs::remove_dir_all(project);
    }
}
