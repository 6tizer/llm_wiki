use crate::commands::file_sync::ProjectRootState;
use rusqlite::{params, Connection, OpenFlags};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use super::*;
use std::fs;
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager, State};

/// Expire an active running lease for a specific job/lease pair, moving the
/// job to `retry-wait` (attempts remain) or `failed` (attempts exhausted) and
/// releasing the lease as `expired`.
///
/// Called both directly (single job/lease, e.g. from an operator tool) and by
/// `runtime_job_lease_reclaim_scan_for_project`, which discovers stuck
/// `running` jobs whose active lease has already expired and calls this per
/// candidate. As of PR3 the scan is wired to a core-runtime background
/// scheduler (`start_lease_reclaim_scheduler`), so expired active leases are
/// automatically recovered instead of leaving the job stuck `running`
/// forever.
///
/// SPEC-6 PR1 (decision 5, adversarial matrix L1/P1): for a `derived-rebuild`
/// job specifically, this is also the orphan-marker reconciliation path — in
/// the SAME transaction as the job state flip:
/// - `retry-wait` (attempts remain): the `claimed` markers named by the job's
///   payload are left exactly as they are — still `claimed`, still owned by
///   THIS SAME job. Recovery is `runtime_job_retry` -> `queued` ->
///   `runtime_job_claim_by_kind` picking the SAME `job_id` back up, so the
///   attempt counter (and thus `DEFAULT_MAX_ATTEMPTS` convergence) is
///   continuous. Earlier revisions of this function reset these markers to
///   `pending`, which let `runtime_derived_marker_claim_batch` mint a BRAND
///   NEW job (attempt=0) for the same group on every crash — poison markers
///   never converged (a fresh job always has attempts to spare) and a
///   recovered original job could complete/fail over a marker set a newer
///   job had already re-claimed. Left untouched here, this is a no-op by
///   construction — nothing to sabotage in this branch.
/// - `failed` (attempts exhausted, terminal): the `claimed` markers are
///   flipped to `failed` too (poison-marker convergence — a permanently
///   panicking rebuild path stops being reclaimed forever once its owning
///   job gives up).
/// - `cancelled` markers are NOT this function's concern: that is
///   `runtime_derived_marker_release_batch`'s explicit, caller-driven path
///   after `runtime_job_cancel` (see that command's doc comment).
///
/// This must not go through `runtime_derived_marker_release_batch` (that
/// command's own `with_runtime_writer` call would deadlock against the one
/// already held here); the `failed` case is done inline against the same
/// `tx` instead. A corrupt/foreign job payload never fails this transaction
/// (a poisoned payload must not poison the shared writer lock) — parsing is
/// still attempted (so a corrupt payload is recorded in `last_error` for
/// diagnosability even on the no-op `retry-wait` branch), and any parse
/// failure never blocks the job's own state transition from landing.
///
/// PR2+ consumer contract (documented in
/// `src/core-runtime/derived-rebuild/index.ts` and
/// docs/plans/SPEC-6/pr1-marker-consumption-infrastructure-plan.md decision
/// 5): a consumer MUST poll BOTH signals — newly pending markers (fed by
/// fresh `claim_batch` calls) AND `retry-wait` `derived-rebuild` jobs (fed by
/// `runtime_job_retry` recovering an existing job). Polling only pending
/// markers will never see a poison marker's retry attempts at all, since
/// they never leave `claimed` until the owning job's final `failed`.
pub(crate) fn runtime_job_lease_timeout_for_project(
    project_root: Option<&Path>,
    enabled: bool,
    job_id: &str,
    lease_id: &str,
    now: i64,
) -> Result<RuntimeJobRecord, String> {
    let project_root = require_enabled_project(project_root, enabled)?;
    with_runtime_writer(|| {
        let mut connection = open_derived_stale_markers_runtime_locked(project_root)?;
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

        let mut last_error = "lease-timeout".to_string();
        let mut marker_ids_to_reconcile = Vec::new();
        if job.kind == DERIVED_REBUILD_JOB_KIND {
            match parse_derived_rebuild_marker_ids(&job) {
                Ok(marker_ids) => marker_ids_to_reconcile = marker_ids,
                Err(err) => last_error = format!("lease-timeout; {err}"),
            }
        }

        tx.execute(
            "UPDATE runtime_jobs
             SET state = ?2,
                 failed_at_ms = CASE WHEN ?2 = 'failed' THEN ?3 ELSE failed_at_ms END,
                 retry_after_ms = ?4,
                 last_error = ?5,
                 updated_at_ms = ?3
             WHERE job_id = ?1",
            params![job_id, next_state, now, retry_after_ms, last_error],
        )
        .map_err(|err| format!("job-lease-timeout-update-failed: {err}"))?;
        release_lease(&tx, job_id, lease_id, EXPIRED_LEASE_STATUS, now)?;

        // `retry-wait` is intentionally a no-op here (P0 fix, see doc comment
        // above): the markers stay `claimed` under this SAME job_id so a
        // retry resumes ownership of exactly what it already had, instead of
        // a fresh `claim_batch` minting a competing attempt=0 job for the
        // same group.
        if !marker_ids_to_reconcile.is_empty() && next_state == "failed" {
            let marker_error =
                Some("derived-rebuild-lease-timeout: runtime job exhausted its retry attempts");
            // Best-effort: a marker may have already moved past `claimed`
            // (e.g. a racing `runtime_derived_marker_complete_batch` landed
            // just before this reclaim tick observed the lease as expired —
            // a benign race, not corruption), so the affected-row count is
            // not asserted here, unlike the explicit claim/complete/release
            // commands above.
            update_markers_status_tx(
                &tx,
                &marker_ids_to_reconcile,
                CLAIMED_MARKER_STATUS,
                FAILED_MARKER_STATUS,
                now,
                marker_error,
            )?;
        }

        let job = read_job_tx(&tx, job_id)?;
        tx.commit().map_err(tx_err)?;
        Ok(job)
    })
}

/// Read-only scan for `running` jobs whose active lease has already expired
/// (`expires_at_ms <= now`). A live worker's heartbeat (PR2) keeps renewing
/// `expires_at_ms`, so a job with a healthy heartbeat never matches this
/// predicate — only a crashed/stalled worker's lease ages past its TTL.
fn read_expired_running_lease_candidates(
    project_root: &Path,
    now: i64,
) -> Result<Vec<(String, String)>, String> {
    let db_path = runtime_db_path(project_root);
    if !db_path.exists() {
        return Ok(Vec::new());
    }
    let connection = Connection::open_with_flags(
        &db_path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|err| format!("lease-reclaim-scan-open-failed: {err}"))?;
    if !table_exists(&connection, "runtime_jobs")?
        || !table_exists(&connection, "runtime_job_leases")?
    {
        return Ok(Vec::new());
    }
    // `<=`, not `<`: matches runtime_job_lease_timeout_for_project's own
    // definition of "expired" (it rejects only when expires_at_ms > now).
    let mut statement = connection
        .prepare(
            "SELECT j.job_id, l.lease_id
             FROM runtime_jobs j
             JOIN runtime_job_leases l
               ON l.job_id = j.job_id AND l.status = 'active'
             WHERE j.state = 'running' AND l.expires_at_ms <= ?1
             ORDER BY l.expires_at_ms ASC",
        )
        .map_err(|err| format!("lease-reclaim-scan-prepare-failed: {err}"))?;
    let rows = statement
        .query_map(params![now], |row| Ok((row.get(0)?, row.get(1)?)))
        .map_err(|err| format!("lease-reclaim-scan-query-failed: {err}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|err| format!("lease-reclaim-scan-query-failed: {err}"))
}

/// Error prefixes produced by `ensure_active_running_lease`'s recheck (plus
/// `runtime_job_lease_timeout_for_project`'s own `lease-not-expired` check)
/// that mean a reclaim candidate simply lost its "expired active lease" shape
/// between being read by `read_expired_running_lease_candidates` and being
/// processed here: a live heartbeat renewed it (`invalid-transition` — job no
/// longer `running` — or `lease-not-expired`), or a concurrent tick already
/// reclaimed it (`inactive-lease` — lease no longer `active`). These are
/// expected races, not failures, and must stay silent.
///
/// Confirmed by correctness review as the exhaustive set of benign-race
/// errors for this call path; anything else (DB/schema errors, transaction
/// failures, `job-not-found`, `lease-not-found`, ...) is a real fault and
/// must not be swallowed silently.
const BENIGN_LEASE_RECLAIM_RACE_PREFIXES: [&str; 3] =
    ["invalid-transition", "inactive-lease", "lease-not-expired"];
const ANCHOR_JOB_KINDS: [&str; 2] = ["auto-ingest-marker-event", "manual-rebuild-marker-event"];
const BENIGN_ORPHAN_RECONCILE_RACE_PREFIXES: [&str; 2] =
    ["invalid-transition", "queued-job-not-stale"];
static LAST_DERIVED_MARKER_GC_MS_BY_PROJECT: OnceLock<Mutex<HashMap<PathBuf, i64>>> =
    OnceLock::new();
static LAST_REWIND_SNAPSHOT_GC_MS_BY_PROJECT: OnceLock<Mutex<HashMap<PathBuf, i64>>> =
    OnceLock::new();

#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct RuntimeOrphanReconcileStats {
    queued_derived_jobs_cancelled: usize,
    queued_anchor_jobs_cancelled: usize,
    terminal_jobs_reconciled: usize,
    queued_markers_reconciled: usize,
    terminal_markers_reconciled: usize,
    markers_reconciled: usize,
    marker_gc_deleted: usize,
}

fn is_benign_lease_reclaim_race(err: &str) -> bool {
    BENIGN_LEASE_RECLAIM_RACE_PREFIXES
        .iter()
        .any(|prefix| err.starts_with(prefix))
}

fn is_benign_orphan_reconcile_race(err: &str) -> bool {
    BENIGN_ORPHAN_RECONCILE_RACE_PREFIXES
        .iter()
        .any(|prefix| err.starts_with(prefix))
}

fn derived_marker_gc_throttle_by_project() -> &'static Mutex<HashMap<PathBuf, i64>> {
    LAST_DERIVED_MARKER_GC_MS_BY_PROJECT.get_or_init(|| Mutex::new(HashMap::new()))
}

fn rewind_snapshot_gc_throttle_by_project() -> &'static Mutex<HashMap<PathBuf, i64>> {
    LAST_REWIND_SNAPSHOT_GC_MS_BY_PROJECT.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Reclaim every `running` job in the project whose active lease has expired:
/// each candidate is transitioned via `runtime_job_lease_timeout_for_project`
/// (to `retry-wait` or `failed`, releasing the lease as `expired`).
///
/// A candidate that no longer matches by the time it is processed (its
/// heartbeat renewed the lease, the worker released it normally, or a
/// concurrent tick already reclaimed it) is skipped silently rather than
/// treated as a scan failure — this keeps repeated ticks idempotent and safe
/// to run concurrently with live workers. See
/// `BENIGN_LEASE_RECLAIM_RACE_PREFIXES` for the exact set of errors this
/// covers.
///
/// Any other per-candidate error (a real fault: transaction/open failure,
/// schema error, unexpected missing row, ...) is logged — not silently
/// dropped — so a stuck job with a real underlying failure stays observable
/// instead of vanishing into an always-`Ok` scan. The scan itself still does
/// not fail as a whole: one bad candidate must not block reclaiming the rest
/// of the queue.
fn runtime_job_lease_reclaim_scan_for_project(
    project_root: Option<&Path>,
    enabled: bool,
    now: i64,
) -> Result<Vec<RuntimeJobRecord>, String> {
    let project_root = require_enabled_project(project_root, enabled)?;
    let candidates = read_expired_running_lease_candidates(project_root, now)?;
    let mut reclaimed = Vec::with_capacity(candidates.len());
    for (job_id, lease_id) in candidates {
        match runtime_job_lease_timeout_for_project(
            Some(project_root),
            enabled,
            &job_id,
            &lease_id,
            now,
        ) {
            Ok(job) => reclaimed.push(job),
            Err(err) if is_benign_lease_reclaim_race(&err) => {}
            Err(err) => {
                eprintln!(
                    "[lease-reclaim] candidate job_id={job_id} failed to reclaim (not a benign race): {err}"
                );
            }
        }
    }
    Ok(reclaimed)
}

/// Core-runtime entry point for one lease-reclaim tick: a no-op (not an
/// error) when the work runtime is disabled or no project is open, since
/// those are ordinary idle states for the background scheduler rather than
/// failures.
fn runtime_job_lease_reclaim_tick(
    project_root: Option<&Path>,
) -> Result<Vec<RuntimeJobRecord>, String> {
    let Some(project_root) = project_root else {
        return Ok(Vec::new());
    };
    if !work_runtime_enabled_from_env() {
        return Ok(Vec::new());
    }
    let now = now_ms()?;
    runtime_job_lease_reclaim_scan_for_project(Some(project_root), true, now)
}

fn read_stale_queued_orphan_candidates(
    project_root: &Path,
    now: i64,
) -> Result<Vec<String>, String> {
    let db_path = runtime_db_path(project_root);
    if !db_path.exists() {
        return Ok(Vec::new());
    }
    let connection = Connection::open_with_flags(
        &db_path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|err| format!("orphan-reconcile-queued-open-failed: {err}"))?;
    if !table_exists(&connection, "runtime_jobs")? {
        return Ok(Vec::new());
    }
    let has_leases_table = table_exists(&connection, "runtime_job_leases")?;
    let cutoff = now.saturating_sub(ORPHAN_QUEUED_JOB_THRESHOLD_MS);
    let sql = if has_leases_table {
        "SELECT job_id
         FROM runtime_jobs
         WHERE state = 'queued'
           AND COALESCE(queued_at_ms, created_at_ms) <= ?1
           AND (
             kind = ?2
             OR (
               (kind = ?3 OR kind = ?4)
               AND attempt = 0
               AND NOT EXISTS (
                 SELECT 1 FROM runtime_job_leases l WHERE l.job_id = runtime_jobs.job_id
               )
             )
           )
         ORDER BY COALESCE(queued_at_ms, created_at_ms) ASC, job_id ASC"
    } else {
        "SELECT job_id
         FROM runtime_jobs
         WHERE state = 'queued'
           AND COALESCE(queued_at_ms, created_at_ms) <= ?1
           AND kind = ?2
         ORDER BY COALESCE(queued_at_ms, created_at_ms) ASC, job_id ASC"
    };
    let mut statement = connection
        .prepare(sql)
        .map_err(|err| format!("orphan-reconcile-queued-prepare-failed: {err}"))?;
    if has_leases_table {
        let rows = statement
            .query_map(
                params![
                    cutoff,
                    DERIVED_REBUILD_JOB_KIND,
                    ANCHOR_JOB_KINDS[0],
                    ANCHOR_JOB_KINDS[1]
                ],
                |row| row.get(0),
            )
            .map_err(|err| format!("orphan-reconcile-queued-query-failed: {err}"))?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|err| format!("orphan-reconcile-queued-query-failed: {err}"))
    } else {
        let rows = statement
            .query_map(params![cutoff, DERIVED_REBUILD_JOB_KIND], |row| row.get(0))
            .map_err(|err| format!("orphan-reconcile-queued-query-failed: {err}"))?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|err| format!("orphan-reconcile-queued-query-failed: {err}"))
    }
}

fn read_terminal_derived_rebuild_candidates(project_root: &Path) -> Result<Vec<String>, String> {
    let db_path = runtime_db_path(project_root);
    if !db_path.exists() {
        return Ok(Vec::new());
    }
    let connection = Connection::open_with_flags(
        &db_path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|err| format!("orphan-reconcile-terminal-open-failed: {err}"))?;
    if !table_exists(&connection, "runtime_jobs")?
        || !table_exists(&connection, "runtime_derived_stale_markers")?
    {
        return Ok(Vec::new());
    }
    let mut statement = connection
        .prepare(
            "SELECT job_id
             FROM runtime_jobs
             WHERE kind = ?1 AND state IN ('failed', 'cancelled', 'completed')
             ORDER BY updated_at_ms ASC, job_id ASC",
        )
        .map_err(|err| format!("orphan-reconcile-terminal-prepare-failed: {err}"))?;
    let rows = statement
        .query_map(params![DERIVED_REBUILD_JOB_KIND], |row| row.get(0))
        .map_err(|err| format!("orphan-reconcile-terminal-query-failed: {err}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|err| format!("orphan-reconcile-terminal-query-failed: {err}"))
}

fn read_job_payload(connection: &Connection, job_id: &str) -> Result<String, String> {
    connection
        .query_row(
            "SELECT payload FROM runtime_jobs WHERE job_id = ?1",
            params![job_id],
            |row| row.get(0),
        )
        .map_err(|err| format!("orphan-reconcile-job-read-failed: {err}"))
}

fn reconcile_stale_queued_orphan_job_for_project(
    project_root: Option<&Path>,
    enabled: bool,
    job_id: &str,
    now: i64,
) -> Result<RuntimeOrphanReconcileStats, String> {
    let project_root = require_enabled_project(project_root, enabled)?;
    with_runtime_writer(|| {
        let mut connection = open_derived_stale_markers_runtime_locked(project_root)?;
        let tx = connection.transaction().map_err(tx_err)?;
        let job = read_job_tx(&tx, job_id)?;
        if job.state != "queued" {
            return Err(format!(
                "invalid-transition: queued orphan reconcile requires queued job, got '{}'",
                job.state
            ));
        }
        if now.saturating_sub(job.queued_at_ms.unwrap_or(job.created_at_ms))
            < ORPHAN_QUEUED_JOB_THRESHOLD_MS
        {
            return Err("queued-job-not-stale: queued job is still inside orphan threshold".into());
        }
        if job.kind != DERIVED_REBUILD_JOB_KIND && !ANCHOR_JOB_KINDS.contains(&job.kind.as_str()) {
            return Err(format!(
                "invalid-kind: queued orphan reconcile does not support kind '{}'",
                job.kind
            ));
        }
        if ANCHOR_JOB_KINDS.contains(&job.kind.as_str()) {
            let lease_history: i64 = tx
                .query_row(
                    "SELECT COUNT(*) FROM runtime_job_leases WHERE job_id = ?1",
                    params![job_id],
                    |row| row.get(0),
                )
                .map_err(|err| format!("orphan-reconcile-anchor-lease-check-failed: {err}"))?;
            if job.attempt != 0 || lease_history != 0 {
                return Err("queued-job-not-stale: anchor job has attempt or lease history".into());
            }
        }

        let marker_ids = if job.kind == DERIVED_REBUILD_JOB_KIND {
            parse_derived_rebuild_marker_ids(&job)?
        } else {
            Vec::new()
        };
        let updated = tx
            .execute(
                "UPDATE runtime_jobs
                 SET state = 'cancelled',
                     cancelled_at_ms = ?2,
                     updated_at_ms = ?2,
                     last_error = ?3
                 WHERE job_id = ?1 AND state = 'queued'",
                params![
                    job_id,
                    now,
                    "orphan-reconcile: queued job exceeded lease-derived threshold without a lease"
                ],
            )
            .map_err(|err| format!("orphan-reconcile-queued-job-update-failed: {err}"))?;
        if updated == 0 {
            return Err("invalid-transition: queued orphan changed state before reconcile".into());
        }

        // Best-effort by design, unlike explicit claim/complete/release
        // commands: the queued orphan path is repairing a stale ownership
        // record, and normal consumers may have already moved some markers
        // out of `claimed`.
        let markers_reconciled = update_markers_status_tx(
            &tx,
            &marker_ids,
            CLAIMED_MARKER_STATUS,
            PENDING_MARKER_STATUS,
            now,
            None,
        )?;
        if !marker_ids.is_empty() && markers_reconciled != marker_ids.len() {
            eprintln!(
                "[orphan-reconcile] queued job_id={job_id} reconciled {markers_reconciled}/{} marker(s); best-effort because markers may have raced out of claimed",
                marker_ids.len()
            );
        }
        tx.commit().map_err(tx_err)?;

        Ok(RuntimeOrphanReconcileStats {
            queued_derived_jobs_cancelled: usize::from(job.kind == DERIVED_REBUILD_JOB_KIND),
            queued_anchor_jobs_cancelled: usize::from(
                ANCHOR_JOB_KINDS.contains(&job.kind.as_str()),
            ),
            terminal_jobs_reconciled: 0,
            queued_markers_reconciled: markers_reconciled,
            terminal_markers_reconciled: 0,
            markers_reconciled,
            marker_gc_deleted: 0,
        })
    })
}

pub(crate) fn reconcile_terminal_derived_rebuild_job_markers_for_project(
    project_root: Option<&Path>,
    enabled: bool,
    job_id: &str,
    now: i64,
) -> Result<usize, String> {
    let project_root = require_enabled_project(project_root, enabled)?;
    with_runtime_writer(|| {
        let mut connection = open_derived_stale_markers_runtime_locked(project_root)?;
        let tx = connection.transaction().map_err(tx_err)?;
        let job = read_job_tx(&tx, job_id)?;
        if job.kind != DERIVED_REBUILD_JOB_KIND {
            return Err("invalid-kind: job is not a derived-rebuild job".to_string());
        }
        let (target_status, error) = match job.state.as_str() {
            "failed" => (
                FAILED_MARKER_STATUS,
                Some("derived-rebuild-terminal-reconcile: runtime job failed"),
            ),
            "cancelled" => (
                CANCELLED_MARKER_STATUS,
                Some("derived-rebuild-terminal-reconcile: runtime job cancelled"),
            ),
            "completed" => (DONE_MARKER_STATUS, None),
            other => {
                return Err(format!(
                    "invalid-transition: terminal marker reconcile requires terminal job, got '{other}'"
                ));
            }
        };
        let marker_ids = parse_derived_rebuild_marker_ids(&job)?;
        // Best-effort by design, unlike explicit claim/complete/release
        // commands: the reconcile tick is repairing stale state and a normal
        // consumer may have already moved some markers out of `claimed`.
        let updated = update_markers_status_tx(
            &tx,
            &marker_ids,
            CLAIMED_MARKER_STATUS,
            target_status,
            now,
            error,
        )?;
        if updated != marker_ids.len() {
            eprintln!(
                "[orphan-reconcile] terminal job_id={job_id} reconciled {updated}/{} marker(s); best-effort because markers may have raced out of claimed",
                marker_ids.len()
            );
        }
        tx.commit().map_err(tx_err)?;
        Ok(updated)
    })
}

pub(crate) fn reconcile_terminal_derived_rebuild_markers_for_project(
    project_root: Option<&Path>,
    enabled: bool,
    request: RuntimeDerivedMarkerReconcileRequest,
    now: i64,
) -> Result<usize, String> {
    let project_root = require_enabled_project(project_root, enabled)?;
    let layer = request
        .layer
        .as_deref()
        .map(normalize_marker_layer)
        .transpose()?;
    let affected_path = request
        .affected_path
        .as_deref()
        .map(normalize_affected_path)
        .transpose()?
        .map(|path| path.display_key);
    let candidates = read_terminal_derived_rebuild_candidates(project_root)?;
    let payload_connection = if layer.is_some() || affected_path.is_some() {
        Some(
            Connection::open_with_flags(
                runtime_db_path(project_root),
                OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
            )
            .map_err(|err| format!("orphan-reconcile-job-open-failed: {err}"))?,
        )
    } else {
        None
    };
    let mut markers_reconciled = 0;
    for job_id in candidates {
        if layer.is_some() || affected_path.is_some() {
            let Some(connection) = payload_connection.as_ref() else {
                continue;
            };
            let Ok(payload) = read_job_payload(connection, &job_id) else {
                continue;
            };
            let Ok(value) = serde_json::from_str::<serde_json::Value>(&payload) else {
                continue;
            };
            if let Some(layer) = layer.as_deref() {
                if value.get("layer").and_then(serde_json::Value::as_str) != Some(layer) {
                    continue;
                }
            }
            if let Some(path) = affected_path.as_deref() {
                if value
                    .get("affectedPath")
                    .and_then(serde_json::Value::as_str)
                    != Some(path)
                {
                    continue;
                }
            }
        }
        match reconcile_terminal_derived_rebuild_job_markers_for_project(
            Some(project_root),
            enabled,
            &job_id,
            now,
        ) {
            Ok(updated) => markers_reconciled += updated,
            Err(err) if is_benign_orphan_reconcile_race(&err) => {}
            Err(err) => {
                eprintln!(
                    "[orphan-reconcile] terminal job_id={job_id} failed to reconcile markers: {err}"
                );
            }
        }
    }
    Ok(markers_reconciled)
}

fn runtime_orphan_reconcile_scan_for_project(
    project_root: Option<&Path>,
    enabled: bool,
    now: i64,
) -> Result<RuntimeOrphanReconcileStats, String> {
    let project_root = require_enabled_project(project_root, enabled)?;
    let mut stats = RuntimeOrphanReconcileStats::default();

    for job_id in read_stale_queued_orphan_candidates(project_root, now)? {
        match reconcile_stale_queued_orphan_job_for_project(
            Some(project_root),
            enabled,
            &job_id,
            now,
        ) {
            Ok(result) => {
                stats.queued_derived_jobs_cancelled += result.queued_derived_jobs_cancelled;
                stats.queued_anchor_jobs_cancelled += result.queued_anchor_jobs_cancelled;
                stats.queued_markers_reconciled += result.queued_markers_reconciled;
                stats.markers_reconciled += result.markers_reconciled;
            }
            Err(err) if is_benign_orphan_reconcile_race(&err) => {}
            Err(err) => {
                eprintln!("[orphan-reconcile] queued job_id={job_id} failed to reconcile: {err}");
            }
        }
    }

    for job_id in read_terminal_derived_rebuild_candidates(project_root)? {
        match reconcile_terminal_derived_rebuild_job_markers_for_project(
            Some(project_root),
            enabled,
            &job_id,
            now,
        ) {
            Ok(updated) if updated > 0 => {
                stats.terminal_jobs_reconciled += 1;
                stats.terminal_markers_reconciled += updated;
                stats.markers_reconciled += updated;
            }
            Ok(_) => {}
            Err(err) if is_benign_orphan_reconcile_race(&err) => {}
            Err(err) => {
                eprintln!(
                    "[orphan-reconcile] terminal job_id={job_id} failed to reconcile markers: {err}"
                );
            }
        }
    }

    Ok(stats)
}

fn runtime_derived_marker_gc_tick(
    project_root: Option<&Path>,
    enabled: bool,
    now: i64,
) -> Result<usize, String> {
    let Some(project_root) = project_root else {
        return Ok(0);
    };
    if !enabled {
        return Ok(0);
    }
    let project_key = project_root.to_path_buf();
    let previous_last = {
        let mut throttle = derived_marker_gc_throttle_by_project()
            .lock()
            .map_err(|err| format!("derived-marker-gc-throttle-lock-failed: {err}"))?;
        let previous_last = throttle.get(&project_key).copied();
        if let Some(last) = previous_last {
            if now.saturating_sub(last) < DERIVED_MARKER_GC_INTERVAL_MS {
                return Ok(0);
            }
        }
        throttle.insert(project_key.clone(), now);
        previous_last
    };

    match runtime_derived_marker_gc_for_project(Some(project_root), enabled, now) {
        Ok(gc) => Ok(gc.deleted.len()),
        Err(err) => {
            if let Ok(mut throttle) = derived_marker_gc_throttle_by_project().lock() {
                if throttle.get(&project_key).copied() == Some(now) {
                    if let Some(last) = previous_last {
                        throttle.insert(project_key, last);
                    } else {
                        throttle.remove(&project_key);
                    }
                }
            }
            Err(err)
        }
    }
}

fn system_time_ms(time: SystemTime) -> Result<i64, String> {
    let duration = time
        .duration_since(UNIX_EPOCH)
        .map_err(|err| format!("rewind-snapshot-gc-invalid-mtime: {err}"))?;
    i64::try_from(duration.as_millis())
        .map_err(|_| "rewind-snapshot-gc-invalid-mtime: timestamp exceeds i64".to_string())
}

fn rewind_snapshot_dir_modified_ms(path: &Path) -> Result<i64, String> {
    let metadata =
        fs::metadata(path).map_err(|err| format!("rewind-snapshot-gc-stat-failed: {err}"))?;
    let modified = metadata
        .modified()
        .map_err(|err| format!("rewind-snapshot-gc-mtime-failed: {err}"))?;
    system_time_ms(modified)
}

fn rewind_snapshot_gc_for_project(project_root: &Path, now: i64) -> Result<usize, String> {
    let snapshots_root = project_root.join(".llm-wiki").join("rewind-snapshots");
    if !snapshots_root.exists() {
        return Ok(0);
    }
    let entries = fs::read_dir(&snapshots_root)
        .map_err(|err| format!("rewind-snapshot-gc-read-dir-failed: {err}"))?;
    let cutoff = now.saturating_sub(REWIND_SNAPSHOT_TTL_MS);
    let mut deleted = 0;

    // Current discovery covers agent-chat-run streamId directories written by
    // the sidecar. If the appTool channel starts writing snapshots in #309,
    // its directory discovery must be kept in sync here.
    for entry in entries {
        let entry = entry.map_err(|err| format!("rewind-snapshot-gc-read-entry-failed: {err}"))?;
        let file_type = entry
            .file_type()
            .map_err(|err| format!("rewind-snapshot-gc-file-type-failed: {err}"))?;
        if !file_type.is_dir() {
            continue;
        }

        let path = entry.path();
        let modified_ms = rewind_snapshot_dir_modified_ms(&path)?;
        if modified_ms > cutoff {
            continue;
        }
        fs::remove_dir_all(&path)
            .map_err(|err| format!("rewind-snapshot-gc-delete-failed: {err}"))?;
        deleted += 1;
    }

    Ok(deleted)
}

fn runtime_rewind_snapshot_gc_tick(project_root: Option<&Path>, now: i64) -> Result<usize, String> {
    let Some(project_root) = project_root else {
        return Ok(0);
    };
    let project_key = project_root.to_path_buf();
    let previous_last = {
        let mut throttle = rewind_snapshot_gc_throttle_by_project()
            .lock()
            .map_err(|err| format!("rewind-snapshot-gc-throttle-lock-failed: {err}"))?;
        let previous_last = throttle.get(&project_key).copied();
        if let Some(last) = previous_last {
            if now.saturating_sub(last) < REWIND_SNAPSHOT_GC_INTERVAL_MS {
                return Ok(0);
            }
        }
        throttle.insert(project_key.clone(), now);
        previous_last
    };

    match rewind_snapshot_gc_for_project(project_root, now) {
        Ok(deleted) => Ok(deleted),
        Err(err) => {
            if let Ok(mut throttle) = rewind_snapshot_gc_throttle_by_project().lock() {
                if throttle.get(&project_key).copied() == Some(now) {
                    if let Some(last) = previous_last {
                        throttle.insert(project_key, last);
                    } else {
                        throttle.remove(&project_key);
                    }
                }
            }
            Err(err)
        }
    }
}

fn runtime_orphan_reconcile_tick(
    project_root: Option<&Path>,
) -> Result<RuntimeOrphanReconcileStats, String> {
    let Some(project_root) = project_root else {
        return Ok(RuntimeOrphanReconcileStats::default());
    };
    if !work_runtime_enabled_from_env() {
        return Ok(RuntimeOrphanReconcileStats::default());
    }
    let now = now_ms()?;
    let mut stats = runtime_orphan_reconcile_scan_for_project(Some(project_root), true, now)?;
    stats.marker_gc_deleted = runtime_derived_marker_gc_tick(Some(project_root), true, now)?;
    Ok(stats)
}

/// Reconcile terminal `derived-rebuild` jobs whose claimed markers did not
/// receive the second IPC release/complete call.
#[tauri::command]
pub fn runtime_derived_marker_reconcile_terminal_jobs(
    request: Option<RuntimeDerivedMarkerReconcileRequest>,
    root_state: State<'_, ProjectRootState>,
) -> Result<usize, String> {
    run_project_write(
        "runtime_derived_marker_reconcile_terminal_jobs",
        root_state,
        |project_root, enabled, now| {
            reconcile_terminal_derived_rebuild_markers_for_project(
                project_root,
                enabled,
                request.unwrap_or(RuntimeDerivedMarkerReconcileRequest {
                    layer: None,
                    affected_path: None,
                }),
                now,
            )
        },
    )
}

/// Spawn the core-runtime background scheduler that periodically reclaims
/// `running` jobs whose active lease expired (crashed worker, stalled
/// heartbeat). Spawned once for the whole app process from `lib.rs::run()`
/// setup — deliberately independent of any frontend component's mount
/// lifecycle, and free of any UI-framework dependency beyond reading
/// `ProjectRootState` (itself populated by the `open_project`/`create_project`
/// backend commands, not by frontend code), so a future non-React shell
/// hosting this same core keeps the reclaim behavior without reimplementing
/// it.
pub fn start_lease_reclaim_scheduler(app: AppHandle) {
    thread::spawn(move || loop {
        thread::sleep(Duration::from_millis(LEASE_RECLAIM_TICK_INTERVAL_MS));
        let project_root = app.state::<ProjectRootState>().get();
        match runtime_job_lease_reclaim_tick(project_root.as_deref()) {
            Ok(reclaimed) if !reclaimed.is_empty() => {
                eprintln!(
                    "[lease-reclaim] reclaimed {} stuck running job(s) with expired leases",
                    reclaimed.len()
                );
            }
            Ok(_) => {}
            Err(err) => {
                eprintln!("[lease-reclaim] tick failed: {err}");
            }
        }
        match runtime_orphan_reconcile_tick(project_root.as_deref()) {
            Ok(stats) if stats != RuntimeOrphanReconcileStats::default() => {
                eprintln!(
                    "[orphan-reconcile] queued_derived_cancelled={} queued_anchor_cancelled={} terminal_jobs_reconciled={} queued_markers_reconciled={} terminal_markers_reconciled={} markers_reconciled={} marker_gc_deleted={}",
                    stats.queued_derived_jobs_cancelled,
                    stats.queued_anchor_jobs_cancelled,
                    stats.terminal_jobs_reconciled,
                    stats.queued_markers_reconciled,
                    stats.terminal_markers_reconciled,
                    stats.markers_reconciled,
                    stats.marker_gc_deleted
                );
            }
            Ok(_) => {}
            Err(err) => {
                eprintln!("[orphan-reconcile] tick failed: {err}");
            }
        }
        match now_ms().and_then(|now| runtime_rewind_snapshot_gc_tick(project_root.as_deref(), now))
        {
            Ok(deleted) if deleted > 0 => {
                eprintln!("[rewind-snapshot-gc] deleted {deleted} expired stream snapshot dir(s)");
            }
            Ok(_) => {}
            Err(err) => {
                eprintln!("[rewind-snapshot-gc] tick failed: {err}");
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    use rusqlite::{params, Connection};

    use std::fs;

    fn derived_job_request(
        job_id: &str,
        layer: &str,
        affected_path: &str,
        marker_ids: &[&str],
    ) -> RuntimeJobCreateRequest {
        RuntimeJobCreateRequest {
            job_id: Some(job_id.to_string()),
            kind: DERIVED_REBUILD_JOB_KIND.to_string(),
            payload: serde_json::json!({
                "layer": layer,
                "affectedPath": affected_path,
                "markerIds": marker_ids,
                "baseVersion": "hash1",
                "inputHash": "sha256:hash1",
                "reason": "commit",
            })
            .to_string(),
            max_attempts: None,
            priority: None,
        }
    }

    fn anchor_job_request(job_id: &str, kind: &str) -> RuntimeJobCreateRequest {
        RuntimeJobCreateRequest {
            job_id: Some(job_id.to_string()),
            kind: kind.to_string(),
            payload: serde_json::json!({
                "layer": "embedding",
                "affectedPath": "wiki/a.md",
            })
            .to_string(),
            max_attempts: Some(1),
            priority: None,
        }
    }

    fn rewind_snapshot_stream_dir(project: &Path, stream_id: &str) -> PathBuf {
        project
            .join(".llm-wiki")
            .join("rewind-snapshots")
            .join(stream_id)
    }

    fn create_rewind_snapshot_stream(
        project: &Path,
        stream_id: &str,
        write_manifest: bool,
    ) -> PathBuf {
        let stream_dir = rewind_snapshot_stream_dir(project, stream_id);
        fs::create_dir_all(&stream_dir).expect("create rewind snapshot stream dir");
        fs::write(stream_dir.join("snapshot-1.json"), "{}").expect("write snapshot file");
        if write_manifest {
            fs::write(
                stream_dir.join("manifest.jsonl"),
                "{\"sequence\":1,\"createdAt\":\"2026-07-06T00:00:00.000Z\"}\n",
            )
            .expect("write manifest");
        }
        stream_dir
    }

    fn bump_rewind_snapshot_dir_after(stream_dir: &Path, minimum_ms: i64) -> i64 {
        for attempt in 0..100 {
            thread::sleep(Duration::from_millis(5));
            fs::write(stream_dir.join(format!("bump-{attempt}.tmp")), "x")
                .expect("touch rewind snapshot stream dir");
            let modified_ms =
                rewind_snapshot_dir_modified_ms(stream_dir).expect("read stream dir mtime");
            if modified_ms > minimum_ms {
                return modified_ms;
            }
        }
        panic!("stream dir mtime did not advance past {minimum_ms}");
    }

    fn setup_claimed_marker_project(label: &str, marker_id: &str) -> std::path::PathBuf {
        let project = temp_project(label);
        fs::create_dir_all(&project).expect("create temp project");
        runtime_job_create_for_project(Some(&project), true, create_request("parent-job"), 0)
            .expect("create parent job");
        runtime_event_append_for_project(
            Some(&project),
            true,
            event_request(Some("parent-job"), "event-1", "{}"),
            10,
        )
        .expect("append event");
        let connection =
            open_derived_stale_markers_runtime_locked(&project).expect("open marker runtime");
        connection
            .execute(
                "INSERT INTO runtime_derived_stale_markers (
                    marker_id, layer, affected_path, input_hash, base_version,
                    marked_at_ms, reason, source_event_id, status, updated_at_ms, last_error
                ) VALUES (?1, 'embedding', 'wiki/a.md', 'sha256:hash1', 'hash1',
                    20, 'commit', 'event-1', 'claimed', 30, NULL)",
                params![marker_id],
            )
            .expect("insert claimed marker");
        project
    }

    fn marker_status(project: &Path, marker_id: &str) -> String {
        let connection = Connection::open(runtime_db_path(project)).expect("open runtime db");
        connection
            .query_row(
                "SELECT status FROM runtime_derived_stale_markers WHERE marker_id = ?1",
                params![marker_id],
                |row| row.get(0),
            )
            .expect("read marker status")
    }

    fn marker_exists(project: &Path, marker_id: &str) -> bool {
        let connection = Connection::open(runtime_db_path(project)).expect("open runtime db");
        let count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM runtime_derived_stale_markers WHERE marker_id = ?1",
                params![marker_id],
                |row| row.get(0),
            )
            .expect("read marker count");
        count > 0
    }

    fn mark_marker_done(project: &Path, marker_id: &str) {
        let connection = Connection::open(runtime_db_path(project)).expect("open runtime db");
        connection
            .execute(
                "UPDATE runtime_derived_stale_markers
                 SET status = 'done', updated_at_ms = 100
                 WHERE marker_id = ?1",
                params![marker_id],
            )
            .expect("make marker terminal");
    }

    fn job_state(project: &Path, job_id: &str) -> String {
        let connection = Connection::open(runtime_db_path(project)).expect("open runtime db");
        connection
            .query_row(
                "SELECT state FROM runtime_jobs WHERE job_id = ?1",
                params![job_id],
                |row| row.get(0),
            )
            .expect("read job state")
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

    #[test]
    fn lease_reclaim_scan_reclaims_stuck_running_job_after_expiry() {
        // Simulates a crashed worker: the job is claimed and then nothing
        // ever heartbeats it again. The scan must leave it alone before the
        // lease expires, then reclaim it (retry-wait, lease expired) once it
        // has.
        let project = temp_project("lease-reclaim-crashed");
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

        let before_expiry = runtime_job_lease_reclaim_scan_for_project(Some(&project), true, 300)
            .expect("scan before expiry");
        assert!(
            before_expiry.is_empty(),
            "a lease that has not expired yet must not be reclaimed"
        );
        let list = runtime_job_list_for_project(Some(&project), true).expect("list jobs");
        assert_eq!(list.jobs[0].state, "running");
        assert_eq!(list.leases[0].status, ACTIVE_LEASE_STATUS);

        let expired_at = 200 + DEFAULT_LEASE_TTL_MS;
        let reclaimed =
            runtime_job_lease_reclaim_scan_for_project(Some(&project), true, expired_at)
                .expect("scan after expiry");
        assert_eq!(reclaimed.len(), 1);
        assert_eq!(reclaimed[0].job_id, "job-1");
        assert_eq!(reclaimed[0].state, "retry-wait");

        let list = runtime_job_list_for_project(Some(&project), true).expect("list jobs");
        assert_eq!(list.jobs[0].state, "retry-wait");
        assert_eq!(list.leases[0].status, EXPIRED_LEASE_STATUS);
        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn lease_reclaim_tick_without_project_is_quiet_noop() {
        // Keep this env-independent without serializing process env: no-project
        // short-circuits before the runtime kill-switch is read.
        let reclaimed = runtime_job_lease_reclaim_tick(None).expect("tick without project");

        assert!(reclaimed.is_empty());
    }

    #[test]
    fn lease_reclaim_scan_skips_job_with_live_heartbeat_renewal() {
        // Simulates a live worker: a heartbeat renews the lease before the
        // original TTL would have expired it. A scan run at what would have
        // been the original expiry must not touch the job.
        let project = temp_project("lease-reclaim-heartbeat");
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

        let heartbeat_at = 200 + DEFAULT_HEARTBEAT_MIN_INTERVAL_MS + 100;
        runtime_job_heartbeat_for_project(
            Some(&project),
            true,
            lease_request("job-1", "lease-1"),
            heartbeat_at,
        )
        .expect("heartbeat renews lease");

        let original_expiry = 200 + DEFAULT_LEASE_TTL_MS;
        let reclaimed =
            runtime_job_lease_reclaim_scan_for_project(Some(&project), true, original_expiry)
                .expect("scan at the pre-renewal expiry");
        assert!(
            reclaimed.is_empty(),
            "a job whose lease was renewed by a live heartbeat must not be reclaimed"
        );

        let list = runtime_job_list_for_project(Some(&project), true).expect("list jobs");
        assert_eq!(list.jobs[0].state, "running");
        assert_eq!(list.leases[0].status, ACTIVE_LEASE_STATUS);
        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn lease_reclaim_scan_is_idempotent_across_repeated_ticks() {
        // Two stuck jobs: job-1 still has retries left (-> retry-wait),
        // job-2 is on its last attempt (-> failed). A first tick reclaims
        // both; a later tick must not re-reclaim (or error on) either one.
        let project = temp_project("lease-reclaim-idempotent");
        fs::create_dir_all(&project).expect("create temp project");
        runtime_job_create_for_project(Some(&project), true, create_request("job-1"), 100)
            .expect("create job-1");
        runtime_job_create_for_project(
            Some(&project),
            true,
            create_request_with_max_attempts("job-2", 1),
            100,
        )
        .expect("create job-2");
        runtime_job_claim_for_project(
            Some(&project),
            true,
            claim_request("worker-a", "lease-1"),
            200,
        )
        .expect("claim job-1");
        runtime_job_claim_for_project(
            Some(&project),
            true,
            claim_request("worker-b", "lease-2"),
            200,
        )
        .expect("claim job-2");

        let expired_at = 200 + DEFAULT_LEASE_TTL_MS;
        let first_tick =
            runtime_job_lease_reclaim_scan_for_project(Some(&project), true, expired_at)
                .expect("first tick reclaims both stuck jobs");
        assert_eq!(first_tick.len(), 2);
        let mut states: Vec<(String, String)> = first_tick
            .iter()
            .map(|job| (job.job_id.clone(), job.state.clone()))
            .collect();
        states.sort();
        assert_eq!(
            states,
            vec![
                ("job-1".to_string(), "retry-wait".to_string()),
                ("job-2".to_string(), "failed".to_string()),
            ]
        );

        let second_tick =
            runtime_job_lease_reclaim_scan_for_project(Some(&project), true, expired_at + 60_000)
                .expect("second tick is idempotent");
        assert!(
            second_tick.is_empty(),
            "a later tick must not re-reclaim jobs already moved out of running/active"
        );

        let list = runtime_job_list_for_project(Some(&project), true).expect("list jobs");
        assert_eq!(list.leases.len(), 2);
        assert!(list
            .leases
            .iter()
            .all(|lease| lease.status == EXPIRED_LEASE_STATUS));
        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn is_benign_lease_reclaim_race_matches_exactly_the_three_ensure_active_running_lease_prefixes()
    {
        // Positive: the exact benign-race errors `ensure_active_running_lease`
        // (plus `runtime_job_lease_timeout_for_project`'s own expiry recheck)
        // can produce when a candidate loses its "expired active lease" shape
        // between being read and being processed.
        assert!(is_benign_lease_reclaim_race(
            "invalid-transition: active lease operation requires running job, got 'retry-wait'"
        ));
        assert!(is_benign_lease_reclaim_race(
            "inactive-lease: lease is 'expired' and cannot mutate the job"
        ));
        assert!(is_benign_lease_reclaim_race(
            "lease-not-expired: active lease has not expired"
        ));

        // Negative: real faults must NOT be classified as benign, even though
        // some (job-not-found, lease-not-found) originate from the same
        // `ensure_active_running_lease` recheck — the correctness review
        // scoped "benign" to exactly the three prefixes above.
        assert!(!is_benign_lease_reclaim_race(
            "job-not-found: runtime job does not exist"
        ));
        assert!(!is_benign_lease_reclaim_race(
            "lease-not-found: active lease does not exist"
        ));
        assert!(!is_benign_lease_reclaim_race(
            "job-lease-timeout-update-failed: some sqlite error"
        ));
        assert!(!is_benign_lease_reclaim_race("job-read-failed: some error"));
        assert!(!is_benign_lease_reclaim_race(""));
    }

    #[test]
    fn lease_reclaim_scan_logs_and_continues_past_a_real_per_candidate_fault() {
        // job-1's runtime_jobs row is corrupted (non-integer `attempt`) after
        // it is claimed, simulating a real fault (e.g. a schema/storage
        // error) that surfaces from `read_job_tx` *after*
        // `ensure_active_running_lease` has already passed — i.e. a failure
        // that is not one of the three benign-race prefixes. job-2 is a
        // healthy stuck candidate alongside it.
        //
        // The scan must: (a) still return Ok overall (one bad candidate does
        // not fail the whole scan), (b) still reclaim job-2, and (c) leave
        // job-1 untouched (still `running`, lease still `active`) rather than
        // silently treating the real fault as a resolved candidate — proving
        // the fault was not swallowed the way a benign race would be.
        let project = temp_project("lease-reclaim-real-fault");
        fs::create_dir_all(&project).expect("create temp project");
        runtime_job_create_for_project(Some(&project), true, create_request("job-1"), 100)
            .expect("create job-1");
        runtime_job_create_for_project(Some(&project), true, create_request("job-2"), 100)
            .expect("create job-2");
        runtime_job_claim_for_project(
            Some(&project),
            true,
            claim_request("worker-a", "lease-1"),
            200,
        )
        .expect("claim job-1");
        runtime_job_claim_for_project(
            Some(&project),
            true,
            claim_request("worker-b", "lease-2"),
            200,
        )
        .expect("claim job-2");

        let connection = Connection::open(runtime_db_path(&project)).expect("open runtime db");
        connection
            .execute(
                "UPDATE runtime_jobs SET attempt = 'not-a-number' WHERE job_id = 'job-1'",
                [],
            )
            .expect("corrupt job-1 attempt column");
        drop(connection);

        let expired_at = 200 + DEFAULT_LEASE_TTL_MS;
        let reclaimed =
            runtime_job_lease_reclaim_scan_for_project(Some(&project), true, expired_at)
                .expect("scan must not fail as a whole due to one bad candidate");
        assert_eq!(
            reclaimed.len(),
            1,
            "the healthy candidate must still be reclaimed"
        );
        assert_eq!(reclaimed[0].job_id, "job-2");
        assert_eq!(reclaimed[0].state, "retry-wait");

        // job-1's `runtime_jobs` row is corrupted, so read it back via raw
        // SQL rather than `runtime_job_list_for_project` (which would trip
        // the same `job-read-failed` conversion error on job-1's `attempt`
        // column and panic the test on an unrelated assertion).
        let connection = Connection::open(runtime_db_path(&project)).expect("reopen runtime db");
        let (job1_state, lease1_status): (String, String) = connection
            .query_row(
                "SELECT j.state, l.status
                 FROM runtime_jobs j
                 JOIN runtime_job_leases l ON l.job_id = j.job_id
                 WHERE j.job_id = 'job-1' AND l.lease_id = 'lease-1'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("read back job-1/lease-1 state");
        assert_eq!(
            job1_state, "running",
            "a real fault must leave the candidate job untouched, not silently resolved"
        );
        assert_eq!(
            lease1_status, ACTIVE_LEASE_STATUS,
            "a real fault must leave the candidate's lease untouched, not silently resolved"
        );
        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn orphan_reconcile_cancels_stale_queued_derived_job_and_returns_marker_pending() {
        let project = setup_claimed_marker_project("orphan-queued-derived", "marker-1");
        runtime_job_create_for_project(
            Some(&project),
            true,
            derived_job_request("derived-job", "embedding", "wiki/a.md", &["marker-1"]),
            100,
        )
        .expect("create queued derived job");

        let stats = runtime_orphan_reconcile_scan_for_project(
            Some(&project),
            true,
            100 + ORPHAN_QUEUED_JOB_THRESHOLD_MS,
        )
        .expect("orphan reconcile");

        assert_eq!(stats.queued_derived_jobs_cancelled, 1);
        assert_eq!(stats.markers_reconciled, 1);
        assert_eq!(job_state(&project, "derived-job"), "cancelled");
        assert_eq!(marker_status(&project, "marker-1"), PENDING_MARKER_STATUS);
        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn orphan_reconcile_cancels_stale_queued_anchor_job_without_marker_release() {
        let project = temp_project("orphan-queued-anchor");
        fs::create_dir_all(&project).expect("create temp project");
        runtime_job_create_for_project(
            Some(&project),
            true,
            anchor_job_request("anchor-job", ANCHOR_JOB_KINDS[0]),
            100,
        )
        .expect("create queued anchor job");

        let stats = runtime_orphan_reconcile_scan_for_project(
            Some(&project),
            true,
            100 + ORPHAN_QUEUED_JOB_THRESHOLD_MS,
        )
        .expect("orphan reconcile");

        assert_eq!(stats.queued_anchor_jobs_cancelled, 1);
        assert_eq!(stats.markers_reconciled, 0);
        assert_eq!(job_state(&project, "anchor-job"), "cancelled");
        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn orphan_reconcile_leaves_resumed_anchor_job_queued() {
        let project = temp_project("orphan-anchor-resumed");
        fs::create_dir_all(&project).expect("create temp project");
        runtime_job_create_for_project(
            Some(&project),
            true,
            anchor_job_request("anchor-job", ANCHOR_JOB_KINDS[0]),
            100,
        )
        .expect("create queued anchor job");
        let connection = Connection::open(runtime_db_path(&project)).expect("open runtime db");
        connection
            .execute(
                "UPDATE runtime_jobs
                 SET attempt = 1, queued_at_ms = 100, updated_at_ms = 200
                 WHERE job_id = 'anchor-job'",
                [],
            )
            .expect("mark anchor as resumed");
        drop(connection);

        let stats = runtime_orphan_reconcile_scan_for_project(
            Some(&project),
            true,
            100 + ORPHAN_QUEUED_JOB_THRESHOLD_MS,
        )
        .expect("orphan reconcile");

        assert_eq!(stats, RuntimeOrphanReconcileStats::default());
        assert_eq!(job_state(&project, "anchor-job"), "queued");
        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn orphan_reconcile_converges_terminal_derived_jobs_to_marker_terminal_statuses() {
        for (terminal_state, expected_marker_status) in [
            ("failed", FAILED_MARKER_STATUS),
            ("cancelled", CANCELLED_MARKER_STATUS),
            ("completed", DONE_MARKER_STATUS),
        ] {
            let project = setup_claimed_marker_project(
                &format!("orphan-terminal-{terminal_state}"),
                "marker-1",
            );
            runtime_job_create_for_project(
                Some(&project),
                true,
                derived_job_request("derived-job", "embedding", "wiki/a.md", &["marker-1"]),
                100,
            )
            .expect("create derived job");
            let connection = Connection::open(runtime_db_path(&project)).expect("open runtime db");
            connection
                .execute(
                    "UPDATE runtime_jobs SET state = ?2, updated_at_ms = 200 WHERE job_id = ?1",
                    params!["derived-job", terminal_state],
                )
                .expect("force terminal state");
            drop(connection);

            let stats = runtime_orphan_reconcile_scan_for_project(Some(&project), true, 300)
                .expect("orphan reconcile");

            assert_eq!(stats.terminal_jobs_reconciled, 1);
            assert_eq!(stats.markers_reconciled, 1);
            assert_eq!(marker_status(&project, "marker-1"), expected_marker_status);
            let _ = fs::remove_dir_all(project);
        }
    }

    #[test]
    fn orphan_reconcile_leaves_fresh_queued_job_inside_threshold() {
        let project = setup_claimed_marker_project("orphan-fresh-queued", "marker-1");
        runtime_job_create_for_project(
            Some(&project),
            true,
            derived_job_request("derived-job", "embedding", "wiki/a.md", &["marker-1"]),
            100,
        )
        .expect("create queued derived job");

        let stats = runtime_orphan_reconcile_scan_for_project(
            Some(&project),
            true,
            100 + ORPHAN_QUEUED_JOB_THRESHOLD_MS - 1,
        )
        .expect("orphan reconcile before threshold");

        assert_eq!(stats, RuntimeOrphanReconcileStats::default());
        assert_eq!(job_state(&project, "derived-job"), "queued");
        assert_eq!(marker_status(&project, "marker-1"), CLAIMED_MARKER_STATUS);
        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn orphan_reconcile_leaves_burst_derived_backlog_inside_threshold() {
        let project = temp_project("orphan-derived-burst");
        fs::create_dir_all(&project).expect("create temp project");
        for index in 0..25 {
            runtime_job_create_for_project(
                Some(&project),
                true,
                derived_job_request(
                    &format!("derived-job-{index}"),
                    "embedding",
                    &format!("wiki/page-{index}.md"),
                    &[&format!("marker-{index}")],
                ),
                100,
            )
            .expect("create queued derived job");
        }

        let stats = runtime_orphan_reconcile_scan_for_project(
            Some(&project),
            true,
            100 + ORPHAN_QUEUED_JOB_THRESHOLD_MS - 1,
        )
        .expect("orphan reconcile before threshold");

        assert_eq!(stats, RuntimeOrphanReconcileStats::default());
        for index in 0..25 {
            assert_eq!(
                job_state(&project, &format!("derived-job-{index}")),
                "queued"
            );
        }
        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn orphan_reconcile_treats_normal_claim_race_as_benign() {
        let project = setup_claimed_marker_project("orphan-claim-race", "marker-1");
        runtime_job_create_for_project(
            Some(&project),
            true,
            derived_job_request("derived-job", "embedding", "wiki/a.md", &["marker-1"]),
            100,
        )
        .expect("create queued derived job");
        runtime_job_claim_for_project(
            Some(&project),
            true,
            claim_request_with_job_id("worker-a", "lease-1", "derived-job"),
            100 + ORPHAN_QUEUED_JOB_THRESHOLD_MS,
        )
        .expect("normal consumer claims job first");

        let err = reconcile_stale_queued_orphan_job_for_project(
            Some(&project),
            true,
            "derived-job",
            100 + ORPHAN_QUEUED_JOB_THRESHOLD_MS,
        )
        .expect_err("running job is no longer a queued orphan");

        assert!(is_benign_orphan_reconcile_race(&err));
        assert_eq!(job_state(&project, "derived-job"), "running");
        assert_eq!(marker_status(&project, "marker-1"), CLAIMED_MARKER_STATUS);
        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn derived_marker_gc_tick_runs_at_most_once_per_interval() {
        let project = setup_claimed_marker_project("scheduler-marker-gc", "marker-1");
        let now = DEFAULT_DERIVED_MARKER_TERMINAL_TTL_MS + 1_000;
        mark_marker_done(&project, "marker-1");

        let first_deleted =
            runtime_derived_marker_gc_tick(Some(&project), true, now).expect("first gc tick");
        assert_eq!(first_deleted, 1);
        assert!(!marker_exists(&project, "marker-1"));

        let connection = Connection::open(runtime_db_path(&project)).expect("open runtime db");
        connection
            .execute(
                "INSERT INTO runtime_derived_stale_markers (
                    marker_id, layer, affected_path, input_hash, base_version,
                    marked_at_ms, reason, source_event_id, status, updated_at_ms, last_error
                ) VALUES (
                    'marker-2', 'embedding', 'wiki/b.md', 'sha256:hash2', 'hash2',
                    20, 'commit', 'event-1', 'done', 100, NULL
                )",
                [],
            )
            .expect("insert second terminal marker");
        drop(connection);

        let throttled_deleted = runtime_derived_marker_gc_tick(
            Some(&project),
            true,
            now + DERIVED_MARKER_GC_INTERVAL_MS - 1,
        )
        .expect("throttled gc tick");
        assert_eq!(throttled_deleted, 0);
        assert!(marker_exists(&project, "marker-2"));

        let second_deleted = runtime_derived_marker_gc_tick(
            Some(&project),
            true,
            now + DERIVED_MARKER_GC_INTERVAL_MS,
        )
        .expect("second gc tick");
        assert_eq!(second_deleted, 1);
        assert!(!marker_exists(&project, "marker-2"));

        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn derived_marker_gc_tick_is_throttled_per_project_root() {
        let project_a = setup_claimed_marker_project("scheduler-marker-gc-project-a", "marker-a");
        let project_b = setup_claimed_marker_project("scheduler-marker-gc-project-b", "marker-b");
        let now = DEFAULT_DERIVED_MARKER_TERMINAL_TTL_MS + 1_000;
        mark_marker_done(&project_a, "marker-a");
        mark_marker_done(&project_b, "marker-b");

        let a_deleted =
            runtime_derived_marker_gc_tick(Some(&project_a), true, now).expect("project a gc tick");
        assert_eq!(a_deleted, 1);
        assert!(!marker_exists(&project_a, "marker-a"));

        let b_deleted =
            runtime_derived_marker_gc_tick(Some(&project_b), true, now).expect("project b gc tick");
        assert_eq!(b_deleted, 1);
        assert!(!marker_exists(&project_b, "marker-b"));

        let _ = fs::remove_dir_all(project_a);
        let _ = fs::remove_dir_all(project_b);
    }

    #[test]
    fn rewind_snapshot_gc_deletes_expired_dirs_and_keeps_fresh_dirs_by_mtime() {
        let project = temp_project("rewind-snapshot-gc");
        fs::create_dir_all(&project).expect("create temp project");

        let expired = create_rewind_snapshot_stream(&project, "expired-stream", true);
        let damaged = create_rewind_snapshot_stream(&project, "damaged-stream", false);
        let expired_mtime = rewind_snapshot_dir_modified_ms(&expired).expect("expired mtime");
        let damaged_mtime = rewind_snapshot_dir_modified_ms(&damaged).expect("damaged mtime");
        let old_cutoff_base = expired_mtime.max(damaged_mtime);

        let fresh = create_rewind_snapshot_stream(&project, "fresh-stream", true);
        bump_rewind_snapshot_dir_after(&fresh, old_cutoff_base + 1);
        let running = create_rewind_snapshot_stream(&project, "running-stream", true);
        bump_rewind_snapshot_dir_after(&running, old_cutoff_base + 1);

        let deleted =
            rewind_snapshot_gc_for_project(&project, old_cutoff_base + REWIND_SNAPSHOT_TTL_MS + 1)
                .expect("rewind snapshot gc");

        assert_eq!(deleted, 2);
        assert!(!expired.exists());
        assert!(
            !damaged.exists(),
            "GC judges by directory mtime regardless of manifest presence"
        );
        assert!(fresh.exists());
        assert!(
            running.exists(),
            "recently written stream dir is protected by mtime"
        );

        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn rewind_snapshot_gc_allows_empty_root() {
        let project = temp_project("rewind-snapshot-gc-empty");
        let snapshots_root = project.join(".llm-wiki").join("rewind-snapshots");
        fs::create_dir_all(&snapshots_root).expect("create empty rewind snapshot root");

        let deleted = rewind_snapshot_gc_for_project(&project, REWIND_SNAPSHOT_TTL_MS + 1_000)
            .expect("empty rewind snapshot gc");

        assert_eq!(deleted, 0);
        assert!(snapshots_root.exists());
        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn rewind_snapshot_gc_tick_runs_at_most_once_per_project_interval() {
        let project_a = temp_project("rewind-snapshot-gc-project-a");
        let project_b = temp_project("rewind-snapshot-gc-project-b");
        fs::create_dir_all(&project_a).expect("create project a");
        fs::create_dir_all(&project_b).expect("create project b");

        let a_old = create_rewind_snapshot_stream(&project_a, "old-a", true);
        let b_old = create_rewind_snapshot_stream(&project_b, "old-b", true);
        let old_mtime = rewind_snapshot_dir_modified_ms(&a_old)
            .expect("project a old mtime")
            .max(rewind_snapshot_dir_modified_ms(&b_old).expect("project b old mtime"));
        let now = old_mtime + REWIND_SNAPSHOT_TTL_MS + 1;

        let a_deleted =
            runtime_rewind_snapshot_gc_tick(Some(&project_a), now).expect("project a gc tick");
        assert_eq!(a_deleted, 1);
        assert!(!a_old.exists());

        let b_deleted =
            runtime_rewind_snapshot_gc_tick(Some(&project_b), now).expect("project b gc tick");
        assert_eq!(b_deleted, 1);
        assert!(!b_old.exists());

        let a_second = create_rewind_snapshot_stream(&project_a, "old-a-second", true);
        let throttled_deleted = runtime_rewind_snapshot_gc_tick(
            Some(&project_a),
            now + REWIND_SNAPSHOT_GC_INTERVAL_MS - 1,
        )
        .expect("project a throttled gc tick");
        assert_eq!(throttled_deleted, 0);
        assert!(a_second.exists());

        let second_deleted =
            runtime_rewind_snapshot_gc_tick(Some(&project_a), now + REWIND_SNAPSHOT_GC_INTERVAL_MS)
                .expect("project a second gc tick");
        assert_eq!(second_deleted, 1);
        assert!(!a_second.exists());

        let _ = fs::remove_dir_all(project_a);
        let _ = fs::remove_dir_all(project_b);
    }
}
