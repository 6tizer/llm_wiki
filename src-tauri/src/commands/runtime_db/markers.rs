use crate::commands::file_sync::ProjectRootState;
use crate::panic_guard::run_guarded;
use rusqlite::{params, params_from_iter, Connection, OpenFlags, ToSql, Transaction};
use std::path::Path;
use tauri::State;

use super::*;
use uuid::Uuid;

/// Record one pending derived stale marker for the currently-open project.
#[tauri::command]
pub fn runtime_derived_stale_marker_record(
    request: RuntimeDerivedStaleMarkerRecordRequest,
    root_state: State<'_, ProjectRootState>,
) -> Result<RuntimeDerivedStaleMarkerRecord, String> {
    run_guarded("runtime_derived_stale_marker_record", || {
        let runtime_enabled = resolve_work_runtime_enabled(read_work_runtime_flag_value());
        let project_root = root_state.get();
        let now = now_for_enabled_project(project_root.as_deref(), runtime_enabled)?;
        runtime_derived_stale_marker_record_for_project(
            project_root.as_deref(),
            runtime_enabled,
            request,
            now,
        )
    })
}

/// List derived stale markers for the currently-open project.
#[tauri::command]
pub fn runtime_derived_stale_marker_list(
    request: Option<RuntimeDerivedStaleMarkerListRequest>,
    root_state: State<'_, ProjectRootState>,
) -> Result<RuntimeDerivedStaleMarkerList, String> {
    run_guarded("runtime_derived_stale_marker_list", || {
        runtime_derived_stale_marker_list_for_project(
            root_state.get().as_deref(),
            resolve_work_runtime_enabled(read_work_runtime_flag_value()),
            request.unwrap_or(RuntimeDerivedStaleMarkerListRequest {
                layer: None,
                affected_path: None,
                status: None,
                limit: None,
                since_marked_at_ms: None,
                since_marker_id: None,
            }),
        )
    })
}

/// Atomically fold every pending derived stale marker for one
/// `(layer, affectedPath)` group into a single claimed batch backed by a
/// queued `derived-rebuild` runtime job, for the currently-open project.
#[tauri::command]
pub fn runtime_derived_marker_claim_batch(
    request: RuntimeDerivedMarkerClaimBatchRequest,
    root_state: State<'_, ProjectRootState>,
) -> Result<RuntimeDerivedMarkerBatchTransition, String> {
    run_guarded("runtime_derived_marker_claim_batch", || {
        let runtime_enabled = resolve_work_runtime_enabled(read_work_runtime_flag_value());
        let project_root = root_state.get();
        let now = now_for_enabled_project(project_root.as_deref(), runtime_enabled)?;
        runtime_derived_marker_claim_batch_for_project(
            project_root.as_deref(),
            runtime_enabled,
            request,
            now,
        )
    })
}

/// Complete a derived-rebuild job's claimed marker batch (`claimed` ->
/// `done`) for the currently-open project.
#[tauri::command]
pub fn runtime_derived_marker_complete_batch(
    request: RuntimeDerivedMarkerCompleteBatchRequest,
    root_state: State<'_, ProjectRootState>,
) -> Result<RuntimeDerivedMarkerBatchTransition, String> {
    run_guarded("runtime_derived_marker_complete_batch", || {
        let runtime_enabled = resolve_work_runtime_enabled(read_work_runtime_flag_value());
        let project_root = root_state.get();
        let now = now_for_enabled_project(project_root.as_deref(), runtime_enabled)?;
        runtime_derived_marker_complete_batch_for_project(
            project_root.as_deref(),
            runtime_enabled,
            request,
            now,
        )
    })
}

/// Release a derived-rebuild job's claimed marker batch back to
/// `pending`/`failed`/`cancelled` for the currently-open project, after the
/// job itself already transitioned via `runtime_job_fail`/`runtime_job_cancel`.
#[tauri::command]
pub fn runtime_derived_marker_release_batch(
    request: RuntimeDerivedMarkerReleaseBatchRequest,
    root_state: State<'_, ProjectRootState>,
) -> Result<RuntimeDerivedMarkerBatchTransition, String> {
    run_guarded("runtime_derived_marker_release_batch", || {
        let runtime_enabled = resolve_work_runtime_enabled(read_work_runtime_flag_value());
        let project_root = root_state.get();
        let now = now_for_enabled_project(project_root.as_deref(), runtime_enabled)?;
        runtime_derived_marker_release_batch_for_project(
            project_root.as_deref(),
            runtime_enabled,
            request,
            now,
        )
    })
}

fn runtime_derived_stale_marker_record_for_project(
    project_root: Option<&Path>,
    enabled: bool,
    request: RuntimeDerivedStaleMarkerRecordRequest,
    now: i64,
) -> Result<RuntimeDerivedStaleMarkerRecord, String> {
    let project_root = require_enabled_project(project_root, enabled)?;
    let marker_id = normalize_optional_id("invalid-marker-id", "markerId", request.marker_id)?
        .unwrap_or_else(|| Uuid::new_v4().to_string());
    let layer = normalize_marker_layer(&request.layer)?;
    let affected_path = normalize_affected_path(&request.affected_path)?.display_key;
    let reason = normalize_marker_reason(&request.reason)?;
    let input_hash = normalize_marker_input_hash(request.input_hash, reason)?;
    let base_version = require_limited_non_empty(
        "invalid-base-version",
        "baseVersion",
        &request.base_version,
        MAX_DERIVED_MARKER_BASE_VERSION_BYTES,
    )?
    .to_string();
    let source_event_id = require_non_empty(
        "invalid-source-event-id",
        "sourceEventId",
        &request.source_event_id,
    )?
    .to_string();
    if base_version == source_event_id {
        return Err(
            "invalid-base-version: baseVersion must not duplicate sourceEventId".to_string(),
        );
    }

    with_runtime_writer(|| {
        let mut connection = open_derived_stale_markers_runtime_locked(project_root)?;
        let tx = connection.transaction().map_err(tx_err)?;
        read_event_tx(&tx, &source_event_id)?;
        tx.execute(
            "INSERT INTO runtime_derived_stale_markers (
                marker_id,
                layer,
                affected_path,
                input_hash,
                base_version,
                marked_at_ms,
                reason,
                source_event_id,
                status,
                updated_at_ms,
                last_error
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?6, NULL)",
            params![
                marker_id,
                layer,
                affected_path,
                input_hash,
                base_version,
                now,
                reason,
                source_event_id,
                PENDING_MARKER_STATUS
            ],
        )
        .map_err(|err| format!("derived-marker-record-insert-failed: {err}"))?;
        let marker = read_derived_marker_tx(&tx, &marker_id)?;
        tx.commit().map_err(tx_err)?;
        Ok(marker)
    })
}

fn runtime_derived_stale_marker_list_for_project(
    project_root: Option<&Path>,
    enabled: bool,
    request: RuntimeDerivedStaleMarkerListRequest,
) -> Result<RuntimeDerivedStaleMarkerList, String> {
    if !enabled {
        return Ok(RuntimeDerivedStaleMarkerList {
            enabled: false,
            status: RuntimeDbHealthState::Disabled,
            markers: Vec::new(),
            next_cursor: None,
        });
    }
    let Some(project_root) = project_root else {
        return Ok(RuntimeDerivedStaleMarkerList {
            enabled: true,
            status: RuntimeDbHealthState::NoProject,
            markers: Vec::new(),
            next_cursor: None,
        });
    };
    let limit = normalize_list_limit(
        request.limit,
        DEFAULT_DERIVED_MARKER_LIMIT,
        MAX_DERIVED_MARKER_LIMIT,
    )?;
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
    let status = request
        .status
        .as_deref()
        .map(normalize_marker_status)
        .transpose()?;
    let cursor = normalize_marker_list_cursor(request.since_marked_at_ms, request.since_marker_id)?;
    let db_path = runtime_db_path(project_root);
    if !db_path.exists() {
        return Ok(RuntimeDerivedStaleMarkerList {
            enabled: true,
            status: RuntimeDbHealthState::Healthy,
            markers: Vec::new(),
            next_cursor: None,
        });
    }
    let connection = Connection::open_with_flags(
        db_path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|err| format!("derived-marker-list-open-failed: {err}"))?;
    if !table_exists(&connection, "runtime_derived_stale_markers")? {
        return Ok(RuntimeDerivedStaleMarkerList {
            enabled: true,
            status: RuntimeDbHealthState::Healthy,
            markers: Vec::new(),
            next_cursor: None,
        });
    }
    let markers = read_derived_markers(
        &connection,
        layer,
        affected_path.as_deref(),
        status,
        cursor.as_ref(),
        limit,
    )?;
    // Only signal "there may be more" when the page came back full: a
    // short page unambiguously means the snapshot (as of this query) is
    // exhausted, matching the ORDER BY marked_at_ms ASC, marker_id ASC
    // total order used for the cursor comparison, so pages never repeat or
    // skip a row (T5 / decision 6).
    let next_cursor = if markers.len() as i64 == limit {
        markers.last().map(|marker| RuntimeDerivedMarkerCursor {
            marked_at_ms: marker.marked_at_ms,
            marker_id: marker.marker_id.clone(),
        })
    } else {
        None
    };
    Ok(RuntimeDerivedStaleMarkerList {
        enabled: true,
        status: RuntimeDbHealthState::Healthy,
        markers,
        next_cursor,
    })
}

/// Validate the composite `sinceMarkedAtMs`/`sinceMarkerId` cursor: both
/// fields must be provided together (or both omitted), since neither one
/// alone identifies a unique position in the `marked_at_ms ASC, marker_id
/// ASC` order.
fn normalize_marker_list_cursor(
    since_marked_at_ms: Option<i64>,
    since_marker_id: Option<String>,
) -> Result<Option<(i64, String)>, String> {
    match (since_marked_at_ms, since_marker_id) {
        (Some(marked_at_ms), Some(marker_id)) => {
            let marker_id =
                require_non_empty("invalid-cursor", "sinceMarkerId", &marker_id)?.to_string();
            Ok(Some((marked_at_ms, marker_id)))
        }
        (None, None) => Ok(None),
        _ => Err(
            "invalid-cursor: sinceMarkedAtMs and sinceMarkerId must both be provided together"
                .to_string(),
        ),
    }
}

/// Atomically fold every pending derived stale marker for one
/// `(layer, affectedPath)` group into a single claimed batch backed by a
/// queued `derived-rebuild` runtime job.
///
/// Correctness (adversarial matrix T1/T2/T4/D1-D4):
/// - The pending snapshot is read once inside this transaction and its exact
///   `marker_id`s become the only rows the subsequent `UPDATE` can touch
///   (`marker_id IN (<snapshot ids>)`), so a marker recorded by a *later*
///   transaction (which, under the process-wide `RUNTIME_DB_WRITE_LOCK`, can
///   only run strictly before or strictly after this one, never interleaved)
///   is never swept into this batch (T2). The `WHERE status = 'pending'`
///   guard on that same `UPDATE` plus the affected-rows check below is the
///   conditional-UPDATE-and-recheck pattern used by
///   `runtime_job_claim_matching_kind_for_project` (:2668-2687) — defense in
///   depth against the group being consumed out from under this call (T1).
/// - The group is scoped by the exact `(layer, affected_path)` pair the
///   caller asked for, so a sibling layer on the same path is never touched
///   (D4), and folding an empty group is rejected outright rather than
///   creating a job for zero markers (D1's "own set" guarantee starts here).
/// - `base_version`/`input_hash`/`reason` are copied verbatim from the
///   *last* row in the snapshot (`ORDER BY marked_at_ms ASC, marker_id ASC`),
///   i.e. the real row with the latest `marked_at_ms` — never synthesized
///   (T4/D3). If that row's `reason` is `delete`, the job payload carries
///   that verbatim too (D2); interpreting it is a PR2+ consumer concern.
fn runtime_derived_marker_claim_batch_for_project(
    project_root: Option<&Path>,
    enabled: bool,
    request: RuntimeDerivedMarkerClaimBatchRequest,
    now: i64,
) -> Result<RuntimeDerivedMarkerBatchTransition, String> {
    let project_root = require_enabled_project(project_root, enabled)?;
    let layer = normalize_marker_layer(&request.layer)?;
    let affected_path = normalize_affected_path(&request.affected_path)?.display_key;
    let job_id = normalize_optional_id("invalid-job-id", "jobId", request.job_id)?
        .unwrap_or_else(|| Uuid::new_v4().to_string());
    let max_attempts = request.max_attempts.unwrap_or(DEFAULT_MAX_ATTEMPTS).max(1);
    let priority = request.priority.unwrap_or(DEFAULT_PRIORITY);

    with_runtime_writer(|| {
        let mut connection = open_derived_stale_markers_runtime_locked(project_root)?;
        let tx = connection.transaction().map_err(tx_err)?;

        let snapshot = read_pending_markers_for_group_tx(&tx, layer, &affected_path)?;
        let latest = snapshot.last().ok_or_else(|| {
            format!(
                "derived-marker-claim-empty: no pending markers for layer '{layer}' and affectedPath '{affected_path}'"
            )
        })?;
        let base_version = latest.base_version.clone();
        let input_hash = latest.input_hash.clone();
        let reason = latest.reason.clone();
        let marker_ids: Vec<String> = snapshot
            .iter()
            .map(|marker| marker.marker_id.clone())
            .collect();

        let payload = serde_json::json!({
            "layer": layer,
            "affectedPath": affected_path,
            "markerIds": marker_ids,
            "baseVersion": base_version,
            "inputHash": input_hash,
            "reason": reason,
        })
        .to_string();

        tx.execute(
            "INSERT INTO runtime_jobs (
                job_id, kind, payload, state, attempt, max_attempts, priority,
                created_at_ms, updated_at_ms, queued_at_ms
            ) VALUES (?1, ?2, ?3, 'queued', 0, ?4, ?5, ?6, ?6, ?6)",
            params![
                job_id,
                DERIVED_REBUILD_JOB_KIND,
                payload,
                max_attempts,
                priority,
                now
            ],
        )
        .map_err(|err| format!("derived-marker-claim-job-create-failed: {err}"))?;

        let claimed = update_markers_status_tx(
            &tx,
            &marker_ids,
            PENDING_MARKER_STATUS,
            CLAIMED_MARKER_STATUS,
            now,
            None,
        )?;
        if claimed != marker_ids.len() {
            return Err(format!(
                "derived-marker-claim-conflict: expected to claim {} pending marker(s) for layer '{layer}' and affectedPath '{affected_path}' but claimed {claimed}",
                marker_ids.len()
            ));
        }

        let job = read_job_tx(&tx, &job_id)?;
        let markers = read_derived_markers_by_ids_tx(&tx, &marker_ids)?;
        tx.commit().map_err(tx_err)?;
        Ok(RuntimeDerivedMarkerBatchTransition { job, markers })
    })
}

/// Complete a derived-rebuild job's claimed marker batch (`claimed` ->
/// `done`). `ensure_active_running_lease` requires the job to be `running`
/// with the specific active, unexpired lease named by `lease_id` — a stale
/// completion from a worker whose lease already expired and was reclaimed by
/// another holder (L5), or a completion racing a cancel (P3), is rejected
/// here rather than silently overwriting the current holder's outcome.
fn runtime_derived_marker_complete_batch_for_project(
    project_root: Option<&Path>,
    enabled: bool,
    request: RuntimeDerivedMarkerCompleteBatchRequest,
    now: i64,
) -> Result<RuntimeDerivedMarkerBatchTransition, String> {
    let project_root = require_enabled_project(project_root, enabled)?;
    let job_id = require_non_empty("invalid-job-id", "jobId", &request.job_id)?.to_string();
    let lease_id = require_non_empty("invalid-lease-id", "leaseId", &request.lease_id)?.to_string();
    let requested_ids = normalize_marker_id_batch(&request.marker_ids)?;

    with_runtime_writer(|| {
        let mut connection = open_derived_stale_markers_runtime_locked(project_root)?;
        let tx = connection.transaction().map_err(tx_err)?;
        ensure_active_running_lease(&tx, &job_id, &lease_id, Some(now))?;
        let job = read_job_tx(&tx, &job_id)?;
        if job.kind != DERIVED_REBUILD_JOB_KIND {
            return Err("invalid-kind: job is not a derived-rebuild job".to_string());
        }
        let expected_ids = parse_derived_rebuild_marker_ids(&job)?;
        ensure_marker_id_sets_match(
            "derived-marker-complete-mismatch",
            &requested_ids,
            &expected_ids,
        )?;

        let completed = update_markers_status_tx(
            &tx,
            &requested_ids,
            CLAIMED_MARKER_STATUS,
            DONE_MARKER_STATUS,
            now,
            None,
        )?;
        if completed != requested_ids.len() {
            return Err(format!(
                "derived-marker-complete-conflict: expected to complete {} claimed marker(s) but updated {completed}",
                requested_ids.len()
            ));
        }

        tx.execute(
            "UPDATE runtime_jobs
             SET state = 'completed',
                 completed_at_ms = ?2,
                 updated_at_ms = ?2
             WHERE job_id = ?1",
            params![job_id, now],
        )
        .map_err(|err| format!("derived-marker-complete-job-failed: {err}"))?;
        release_lease(&tx, &job_id, &lease_id, RELEASED_LEASE_STATUS, now)?;

        let job = read_job_tx(&tx, &job_id)?;
        let markers = read_derived_markers_by_ids_tx(&tx, &requested_ids)?;
        tx.commit().map_err(tx_err)?;
        Ok(RuntimeDerivedMarkerBatchTransition { job, markers })
    })
}

/// Release a derived-rebuild job's claimed marker batch back to
/// `pending`/`failed`/`cancelled` after the job itself already transitioned
/// via `runtime_job_fail`/`runtime_job_cancel`. The required job state for
/// each target status mirrors that transition exactly (`retry-wait` ->
/// `pending`, `failed` -> `failed`, `cancelled` -> `cancelled`), so calling
/// this against a job that hasn't actually reached that state yet — e.g. a
/// cancel racing an in-flight rebuild before the job-level cancel landed
/// (P3) — is rejected.
fn runtime_derived_marker_release_batch_for_project(
    project_root: Option<&Path>,
    enabled: bool,
    request: RuntimeDerivedMarkerReleaseBatchRequest,
    now: i64,
) -> Result<RuntimeDerivedMarkerBatchTransition, String> {
    let project_root = require_enabled_project(project_root, enabled)?;
    let job_id = require_non_empty("invalid-job-id", "jobId", &request.job_id)?.to_string();
    let requested_ids = normalize_marker_id_batch(&request.marker_ids)?;
    let target_status = normalize_marker_status(&request.target_status)?;
    let expected_job_state = match target_status {
        PENDING_MARKER_STATUS => "retry-wait",
        FAILED_MARKER_STATUS => "failed",
        CANCELLED_MARKER_STATUS => "cancelled",
        _ => {
            return Err(format!(
                "invalid-status: derived marker release does not support target status '{target_status}'"
            ));
        }
    };
    let error = normalize_optional_limited_text(
        "invalid-error",
        "error",
        request.error,
        MAX_STAGING_ARTIFACT_ERROR_BYTES,
    )?;

    with_runtime_writer(|| {
        let mut connection = open_derived_stale_markers_runtime_locked(project_root)?;
        let tx = connection.transaction().map_err(tx_err)?;
        let job = read_job_tx(&tx, &job_id)?;
        if job.kind != DERIVED_REBUILD_JOB_KIND {
            return Err("invalid-kind: job is not a derived-rebuild job".to_string());
        }
        if job.state != expected_job_state {
            return Err(format!(
                "invalid-transition: releasing markers to '{target_status}' requires job state '{expected_job_state}', got '{}'",
                job.state
            ));
        }
        let expected_ids = parse_derived_rebuild_marker_ids(&job)?;
        ensure_marker_id_sets_match(
            "derived-marker-release-mismatch",
            &requested_ids,
            &expected_ids,
        )?;

        let released = update_markers_status_tx(
            &tx,
            &requested_ids,
            CLAIMED_MARKER_STATUS,
            target_status,
            now,
            error.as_deref(),
        )?;
        if released != requested_ids.len() {
            return Err(format!(
                "derived-marker-release-conflict: expected to release {} claimed marker(s) but updated {released}",
                requested_ids.len()
            ));
        }

        let markers = read_derived_markers_by_ids_tx(&tx, &requested_ids)?;
        tx.commit().map_err(tx_err)?;
        Ok(RuntimeDerivedMarkerBatchTransition { job, markers })
    })
}

fn normalize_marker_layer(raw: &str) -> Result<&'static str, String> {
    match raw.trim() {
        "embedding" => Ok("embedding"),
        "graph" => Ok("graph"),
        "taxonomy" => Ok("taxonomy"),
        "synthesis" => Ok("synthesis"),
        "search" => Ok("search"),
        "index_export" => Ok("index_export"),
        "overview" => Ok("overview"),
        _ => Err("invalid-layer: unknown derived marker layer".to_string()),
    }
}

fn normalize_marker_reason(raw: &str) -> Result<&'static str, String> {
    match raw.trim() {
        "commit" => Ok("commit"),
        "delete" => Ok("delete"),
        "schema_change" => Ok("schema_change"),
        "manual_rebuild" => Ok("manual_rebuild"),
        _ => Err("invalid-reason: unknown derived marker reason".to_string()),
    }
}

fn normalize_marker_status(raw: &str) -> Result<&'static str, String> {
    match raw.trim() {
        "pending" => Ok("pending"),
        "claimed" => Ok("claimed"),
        "done" => Ok("done"),
        "failed" => Ok("failed"),
        "cancelled" => Ok("cancelled"),
        _ => Err("invalid-status: unknown derived marker status".to_string()),
    }
}

fn normalize_marker_input_hash(
    input_hash: Option<String>,
    reason: &str,
) -> Result<Option<String>, String> {
    let input_hash = normalize_optional_limited_text(
        "invalid-input-hash",
        "inputHash",
        input_hash,
        MAX_STAGING_ARTIFACT_HASH_BYTES,
    )?;
    if reason == "delete" {
        return if input_hash.is_none() {
            Ok(None)
        } else {
            Err("invalid-input-hash: inputHash must be null for delete markers".to_string())
        };
    }
    match input_hash {
        Some(input_hash) => Ok(Some(input_hash)),
        None => Err("invalid-input-hash: inputHash is required for non-delete markers".to_string()),
    }
}

fn read_derived_marker_tx(
    tx: &Transaction<'_>,
    marker_id: &str,
) -> Result<RuntimeDerivedStaleMarkerRecord, String> {
    tx.query_row(
        &derived_marker_select_sql("WHERE marker_id = ?1"),
        [marker_id],
        map_derived_marker_row,
    )
    .map_err(|err| format!("derived-marker-read-failed: {err}"))
}

fn read_derived_markers(
    connection: &Connection,
    layer: Option<&str>,
    affected_path: Option<&str>,
    status: Option<&str>,
    cursor: Option<&(i64, String)>,
    limit: i64,
) -> Result<Vec<RuntimeDerivedStaleMarkerRecord>, String> {
    let mut filters = Vec::new();
    let mut values: Vec<Box<dyn ToSql>> = Vec::new();
    if let Some(layer) = layer {
        filters.push("layer = ?".to_string());
        values.push(Box::new(layer.to_string()));
    }
    if let Some(affected_path) = affected_path {
        filters.push("affected_path = ?".to_string());
        values.push(Box::new(affected_path.to_string()));
    }
    if let Some(status) = status {
        filters.push("status = ?".to_string());
        values.push(Box::new(status.to_string()));
    }
    if let Some((marked_at_ms, marker_id)) = cursor {
        // Matches ORDER BY marked_at_ms ASC, marker_id ASC below exactly, so
        // paging never repeats or skips a row (SPEC-6 PR1 decision 6 / T5).
        filters.push("(marked_at_ms > ? OR (marked_at_ms = ? AND marker_id > ?))".to_string());
        values.push(Box::new(*marked_at_ms));
        values.push(Box::new(*marked_at_ms));
        values.push(Box::new(marker_id.clone()));
    }
    let suffix = if filters.is_empty() {
        "ORDER BY marked_at_ms ASC, marker_id ASC LIMIT ?".to_string()
    } else {
        format!(
            "WHERE {} ORDER BY marked_at_ms ASC, marker_id ASC LIMIT ?",
            filters.join(" AND ")
        )
    };
    values.push(Box::new(limit));
    let params = values.iter().map(|value| value.as_ref());
    let mut statement = connection
        .prepare(&derived_marker_select_sql(&suffix))
        .map_err(|err| format!("derived-markers-read-prepare-failed: {err}"))?;
    let rows = statement
        .query_map(params_from_iter(params), map_derived_marker_row)
        .map_err(|err| format!("derived-markers-read-failed: {err}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|err| format!("derived-markers-read-failed: {err}"))
}

/// Snapshot the pending markers for one `(layer, affected_path)` group inside
/// a writer transaction, ordered `marked_at_ms ASC, marker_id ASC` so the
/// last element is the real row with the latest `marked_at_ms` (used to seed
/// a `derived-rebuild` job payload's `baseVersion`/`inputHash`/`reason`
/// verbatim — SPEC-6 PR1 decision 4/T4/D3). When two rows share the exact
/// same `marked_at_ms` (e.g. a single commit that marks several layers/paths
/// in the same millisecond), the `marker_id ASC` tiebreak is a lexicographic
/// string order, NOT a real happens-before clock — which of those rows is
/// treated as "latest" is then an arbitrary-but-deterministic pick. Known
/// and accepted: within one `(layer, affected_path)` group, same-millisecond
/// markers come from the same commit and therefore already agree on
/// `base_version`/`input_hash`/`reason`, so the tiebreak has no observable
/// effect on the group's fold result.
fn read_pending_markers_for_group_tx(
    tx: &Transaction<'_>,
    layer: &str,
    affected_path: &str,
) -> Result<Vec<RuntimeDerivedStaleMarkerRecord>, String> {
    let mut statement = tx
        .prepare(&derived_marker_select_sql(
            "WHERE layer = ?1 AND affected_path = ?2 AND status = 'pending'
             ORDER BY marked_at_ms ASC, marker_id ASC",
        ))
        .map_err(|err| format!("derived-marker-claim-snapshot-prepare-failed: {err}"))?;
    let rows = statement
        .query_map(params![layer, affected_path], map_derived_marker_row)
        .map_err(|err| format!("derived-marker-claim-snapshot-failed: {err}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|err| format!("derived-marker-claim-snapshot-failed: {err}"))
}

/// Read a specific, caller-named set of marker rows inside a writer
/// transaction (post-transition snapshot for claim/complete/release batch
/// responses).
fn read_derived_markers_by_ids_tx(
    tx: &Transaction<'_>,
    marker_ids: &[String],
) -> Result<Vec<RuntimeDerivedStaleMarkerRecord>, String> {
    if marker_ids.is_empty() {
        return Ok(Vec::new());
    }
    let placeholders = vec!["?"; marker_ids.len()].join(",");
    let sql = derived_marker_select_sql(&format!(
        "WHERE marker_id IN ({placeholders}) ORDER BY marked_at_ms ASC, marker_id ASC"
    ));
    let mut statement = tx
        .prepare(&sql)
        .map_err(|err| format!("derived-marker-read-batch-prepare-failed: {err}"))?;
    let sql_params: Vec<&dyn ToSql> = marker_ids.iter().map(|id| id as &dyn ToSql).collect();
    let rows = statement
        .query_map(params_from_iter(sql_params), map_derived_marker_row)
        .map_err(|err| format!("derived-marker-read-batch-failed: {err}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|err| format!("derived-marker-read-batch-failed: {err}"))
}

/// Conditionally transition a specific, caller-named set of marker rows from
/// `from_status` to `to_status`, clearing/setting `last_error` and returning
/// the number of rows actually updated. Every derived-marker batch state
/// transition in this file goes through this one helper so the
/// "restrict-by-exact-marker_id-set" invariant (T1/T3) is enforced in a
/// single place rather than re-derived per call site.
pub(crate) fn update_markers_status_tx(
    tx: &Transaction<'_>,
    marker_ids: &[String],
    from_status: &str,
    to_status: &str,
    now: i64,
    error: Option<&str>,
) -> Result<usize, String> {
    if marker_ids.is_empty() {
        return Ok(0);
    }
    let placeholders = vec!["?"; marker_ids.len()].join(",");
    let sql = format!(
        "UPDATE runtime_derived_stale_markers
         SET status = ?1, updated_at_ms = ?2, last_error = ?3
         WHERE status = ?4 AND marker_id IN ({placeholders})"
    );
    let mut sql_params: Vec<&dyn ToSql> = vec![&to_status, &now, &error, &from_status];
    for marker_id in marker_ids {
        sql_params.push(marker_id);
    }
    tx.execute(&sql, params_from_iter(sql_params))
        .map_err(|err| format!("derived-marker-status-update-failed: {err}"))
}

/// Normalize a caller-supplied marker id batch: non-empty, no blank ids, no
/// duplicates.
fn normalize_marker_id_batch(marker_ids: &[String]) -> Result<Vec<String>, String> {
    if marker_ids.is_empty() {
        return Err("invalid-marker-ids: markerIds must not be empty".to_string());
    }
    let mut seen = std::collections::HashSet::new();
    let mut normalized = Vec::with_capacity(marker_ids.len());
    for marker_id in marker_ids {
        let trimmed = require_non_empty("invalid-marker-ids", "markerIds", marker_id)?.to_string();
        if !seen.insert(trimmed.clone()) {
            return Err(format!(
                "invalid-marker-ids: duplicate markerId '{trimmed}'"
            ));
        }
        normalized.push(trimmed);
    }
    Ok(normalized)
}

/// A caller-supplied marker id batch must exactly match the set of ids the
/// job actually claimed (its own payload's `markerIds`) — not a superset, not
/// a subset — so `complete`/`release` can never touch a marker belonging to
/// a different holder's job (T3).
fn ensure_marker_id_sets_match(
    code: &str,
    requested: &[String],
    expected: &[String],
) -> Result<(), String> {
    let requested_set: std::collections::HashSet<&str> =
        requested.iter().map(String::as_str).collect();
    let expected_set: std::collections::HashSet<&str> =
        expected.iter().map(String::as_str).collect();
    if requested_set == expected_set {
        Ok(())
    } else {
        Err(format!(
            "{code}: markerIds do not match the job's claimed batch"
        ))
    }
}

/// Parse the `markerIds` array out of a `derived-rebuild` job's JSON payload
/// (written atomically by `runtime_derived_marker_claim_batch`). Kept
/// strict/fail-loud for the explicit complete/release commands; the
/// automatic lease-timeout self-heal path (which must never fail its
/// transaction on a corrupt payload) catches this error itself instead of
/// propagating it.
pub(crate) fn parse_derived_rebuild_marker_ids(
    job: &RuntimeJobRecord,
) -> Result<Vec<String>, String> {
    let value: serde_json::Value = serde_json::from_str(&job.payload).map_err(|err| {
        format!(
            "derived-marker-payload-parse-failed: job '{}' payload is not valid JSON: {err}",
            job.job_id
        )
    })?;
    let ids = value
        .get("markerIds")
        .and_then(serde_json::Value::as_array)
        .ok_or_else(|| {
            format!(
                "derived-marker-payload-parse-failed: job '{}' payload has no markerIds array",
                job.job_id
            )
        })?;
    ids.iter()
        .map(|entry| {
            entry.as_str().map(str::to_string).ok_or_else(|| {
                format!(
                    "derived-marker-payload-parse-failed: job '{}' payload markerIds must be strings",
                    job.job_id
                )
            })
        })
        .collect()
}

fn derived_marker_select_sql(suffix: &str) -> String {
    format!(
        "SELECT marker_id,
                layer,
                affected_path,
                input_hash,
                base_version,
                marked_at_ms,
                reason,
                source_event_id,
                status,
                updated_at_ms,
                last_error
         FROM runtime_derived_stale_markers {suffix}"
    )
}

fn map_derived_marker_row(
    row: &rusqlite::Row<'_>,
) -> rusqlite::Result<RuntimeDerivedStaleMarkerRecord> {
    Ok(RuntimeDerivedStaleMarkerRecord {
        marker_id: row.get(0)?,
        layer: row.get(1)?,
        affected_path: row.get(2)?,
        input_hash: row.get(3)?,
        base_version: row.get(4)?,
        marked_at_ms: row.get(5)?,
        reason: row.get(6)?,
        source_event_id: row.get(7)?,
        status: row.get(8)?,
        updated_at_ms: row.get(9)?,
        last_error: row.get(10)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    use rusqlite::{params, Connection};
    use std::path::{Path, PathBuf};

    use std::fs;
    use std::sync::{Arc, Barrier};

    fn marker_record_request(
        marker_id: &str,
        layer: &str,
        affected_path: &str,
        source_event_id: &str,
    ) -> RuntimeDerivedStaleMarkerRecordRequest {
        RuntimeDerivedStaleMarkerRecordRequest {
            marker_id: Some(marker_id.to_string()),
            layer: layer.to_string(),
            affected_path: affected_path.to_string(),
            input_hash: Some("sha256:def456".to_string()),
            base_version: format!("event:200:{source_event_id}"),
            reason: "commit".to_string(),
            source_event_id: source_event_id.to_string(),
        }
    }

    fn marker_list_request(
        layer: Option<&str>,
        affected_path: Option<&str>,
        status: Option<&str>,
    ) -> RuntimeDerivedStaleMarkerListRequest {
        RuntimeDerivedStaleMarkerListRequest {
            layer: layer.map(str::to_string),
            affected_path: affected_path.map(str::to_string),
            status: status.map(str::to_string),
            limit: None,
            since_marked_at_ms: None,
            since_marker_id: None,
        }
    }

    fn marker_list_request_with_cursor(
        limit: i64,
        since_marked_at_ms: Option<i64>,
        since_marker_id: Option<&str>,
    ) -> RuntimeDerivedStaleMarkerListRequest {
        RuntimeDerivedStaleMarkerListRequest {
            layer: None,
            affected_path: None,
            status: None,
            limit: Some(limit),
            since_marked_at_ms,
            since_marker_id: since_marker_id.map(str::to_string),
        }
    }

    fn claim_batch_request(
        layer: &str,
        affected_path: &str,
    ) -> RuntimeDerivedMarkerClaimBatchRequest {
        RuntimeDerivedMarkerClaimBatchRequest {
            layer: layer.to_string(),
            affected_path: affected_path.to_string(),
            job_id: None,
            max_attempts: None,
            priority: None,
        }
    }

    fn complete_batch_request(
        job_id: &str,
        lease_id: &str,
        marker_ids: &[&str],
    ) -> RuntimeDerivedMarkerCompleteBatchRequest {
        RuntimeDerivedMarkerCompleteBatchRequest {
            job_id: job_id.to_string(),
            lease_id: lease_id.to_string(),
            marker_ids: marker_ids.iter().map(|id| id.to_string()).collect(),
        }
    }

    fn release_batch_request(
        job_id: &str,
        marker_ids: &[&str],
        target_status: &str,
    ) -> RuntimeDerivedMarkerReleaseBatchRequest {
        RuntimeDerivedMarkerReleaseBatchRequest {
            job_id: job_id.to_string(),
            marker_ids: marker_ids.iter().map(|id| id.to_string()).collect(),
            target_status: target_status.to_string(),
            error: None,
        }
    }

    #[test]
    fn derived_stale_marker_record_and_list_happy_path() {
        let project = temp_project("derived-marker-happy");
        fs::create_dir_all(&project).expect("create temp project");
        runtime_job_create_for_project(Some(&project), true, create_request("job-1"), 100)
            .expect("create parent job");
        let event = runtime_event_append_for_project(
            Some(&project),
            true,
            event_request(Some("job-1"), "event-1", "{}"),
            200,
        )
        .expect("append commit event");

        let marker = runtime_derived_stale_marker_record_for_project(
            Some(&project),
            true,
            marker_record_request("marker-1", "embedding", "Wiki\\Page.md", &event.event_id),
            300,
        )
        .expect("record marker");

        assert_eq!(marker.marker_id, "marker-1");
        assert_eq!(marker.layer, "embedding");
        assert_eq!(marker.affected_path, "Wiki/Page.md");
        assert_eq!(marker.input_hash.as_deref(), Some("sha256:def456"));
        assert_eq!(marker.base_version, "event:200:event-1");
        assert_eq!(marker.reason, "commit");
        assert_eq!(marker.source_event_id, "event-1");
        assert_eq!(marker.status, PENDING_MARKER_STATUS);
        assert_eq!(marker.marked_at_ms, 300);
        assert_eq!(marker.updated_at_ms, 300);
        assert!(marker.last_error.is_none());

        let all = runtime_derived_stale_marker_list_for_project(
            Some(&project),
            true,
            marker_list_request(None, None, None),
        )
        .expect("list all markers");
        assert_eq!(all.markers, vec![marker.clone()]);

        let filtered = runtime_derived_stale_marker_list_for_project(
            Some(&project),
            true,
            marker_list_request(Some("embedding"), Some("Wiki/Page.md"), Some("pending")),
        )
        .expect("list filtered markers");
        assert_eq!(filtered.markers, vec![marker]);
        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn derived_stale_marker_list_returns_empty_without_migration_on_existing_runtime_dbs() {
        let project = temp_project("derived-marker-list-pr5-db");
        fs::create_dir_all(&project).expect("create temp project");
        runtime_job_create_for_project(Some(&project), true, create_request("job-1"), 100)
            .expect("create parent job");
        runtime_event_append_for_project(
            Some(&project),
            true,
            event_request(Some("job-1"), "event-1", "{}"),
            200,
        )
        .expect("create events-progress runtime db");

        let list = runtime_derived_stale_marker_list_for_project(
            Some(&project),
            true,
            marker_list_request(None, None, None),
        )
        .expect("list derived markers");

        assert_eq!(list.status, RuntimeDbHealthState::Healthy);
        assert!(list.markers.is_empty());
        let connection = Connection::open(runtime_db_path(&project)).expect("open runtime db");
        assert!(!table_exists(&connection, "runtime_derived_stale_markers").expect("check table"));
        assert!(!migration_family_exists(
            &project,
            DERIVED_STALE_MARKERS_FAMILY
        ));
        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn derived_stale_marker_list_disabled_and_no_project_are_no_touch() {
        let disabled = runtime_derived_stale_marker_list_for_project(
            None,
            false,
            marker_list_request(None, None, None),
        )
        .expect("disabled list succeeds");
        assert_eq!(disabled.status, RuntimeDbHealthState::Disabled);
        assert!(disabled.markers.is_empty());

        let no_project = runtime_derived_stale_marker_list_for_project(
            None,
            true,
            marker_list_request(None, None, None),
        )
        .expect("no-project list succeeds");
        assert_eq!(no_project.status, RuntimeDbHealthState::NoProject);
        assert!(no_project.markers.is_empty());
    }

    // ---- SPEC-6 PR1: derived marker claim/complete/release batch infra ----

    fn marker_record_request_full(
        marker_id: &str,
        layer: &str,
        affected_path: &str,
        input_hash: Option<&str>,
        base_version: &str,
        reason: &str,
        source_event_id: &str,
    ) -> RuntimeDerivedStaleMarkerRecordRequest {
        RuntimeDerivedStaleMarkerRecordRequest {
            marker_id: Some(marker_id.to_string()),
            layer: layer.to_string(),
            affected_path: affected_path.to_string(),
            input_hash: input_hash.map(str::to_string),
            base_version: base_version.to_string(),
            reason: reason.to_string(),
            source_event_id: source_event_id.to_string(),
        }
    }

    /// Seed one pending marker (and its backing event) for `project`, whose
    /// parent job `job-1` must already exist. `marked_at_ms` is used for both
    /// the event's `created_at_ms` and the marker's `marked_at_ms`.
    #[allow(clippy::too_many_arguments)]
    fn seed_pending_marker(
        project: &Path,
        marker_id: &str,
        layer: &str,
        affected_path: &str,
        event_id: &str,
        input_hash: Option<&str>,
        base_version: &str,
        reason: &str,
        marked_at_ms: i64,
    ) -> RuntimeDerivedStaleMarkerRecord {
        runtime_event_append_for_project(
            Some(project),
            true,
            event_request(Some("job-1"), event_id, "{}"),
            marked_at_ms,
        )
        .expect("append event");
        runtime_derived_stale_marker_record_for_project(
            Some(project),
            true,
            marker_record_request_full(
                marker_id,
                layer,
                affected_path,
                input_hash,
                base_version,
                reason,
                event_id,
            ),
            marked_at_ms,
        )
        .expect("record marker")
    }

    fn setup_marker_project(label: &str) -> PathBuf {
        let project = temp_project(label);
        fs::create_dir_all(&project).expect("create temp project");
        runtime_job_create_for_project(Some(&project), true, create_request("job-1"), 0)
            .expect("create parent job");
        project
    }

    // D1/T4/D3 sabotage self-verification performed during implementation
    // (matrix 6.2): temporarily changed `snapshot.last()` to
    // `snapshot.first()` in `runtime_derived_marker_claim_batch_for_project`
    // (picking the earliest row instead of the latest) — this test went red
    // (`assert_eq!(payload["baseVersion"], "hash3")` failed with
    // `"hash1" != "hash3"`). Restoring `.last()` turned it back green.
    #[test]
    fn derived_marker_claim_batch_folds_group_latest_wins_and_creates_queued_job() {
        // D1 (fold whole group), T4/D3 (latest real row wins, not synthesized).
        let project = setup_marker_project("marker-claim-fold");
        seed_pending_marker(
            &project,
            "marker-1",
            "embedding",
            "wiki/a.md",
            "event-1",
            Some("sha256:hash1"),
            "hash1",
            "commit",
            100,
        );
        seed_pending_marker(
            &project,
            "marker-2",
            "embedding",
            "wiki/a.md",
            "event-2",
            Some("sha256:hash2"),
            "hash2",
            "commit",
            200,
        );
        seed_pending_marker(
            &project,
            "marker-3",
            "embedding",
            "wiki/a.md",
            "event-3",
            Some("sha256:hash3"),
            "hash3",
            "commit",
            300,
        );

        let claimed = runtime_derived_marker_claim_batch_for_project(
            Some(&project),
            true,
            claim_batch_request("embedding", "wiki/a.md"),
            1000,
        )
        .expect("claim batch");

        assert_eq!(claimed.job.kind, DERIVED_REBUILD_JOB_KIND);
        assert_eq!(claimed.job.state, "queued");
        assert_eq!(claimed.job.attempt, 0);
        assert_eq!(claimed.markers.len(), 3);
        assert!(claimed
            .markers
            .iter()
            .all(|marker| marker.status == CLAIMED_MARKER_STATUS));

        let payload: serde_json::Value =
            serde_json::from_str(&claimed.job.payload).expect("parse job payload");
        let mut marker_ids: Vec<String> = payload["markerIds"]
            .as_array()
            .expect("markerIds array")
            .iter()
            .map(|value| value.as_str().expect("string id").to_string())
            .collect();
        marker_ids.sort();
        assert_eq!(marker_ids, vec!["marker-1", "marker-2", "marker-3"]);
        // D3: the persisted baseVersion is the real latest row's value, not a
        // synthesized composite of all three.
        assert_eq!(payload["baseVersion"], "hash3");
        assert_eq!(payload["inputHash"], "sha256:hash3");
        assert_eq!(payload["reason"], "commit");
        assert_eq!(payload["layer"], "embedding");
        assert_eq!(payload["affectedPath"], "wiki/a.md");

        // D1: the whole group is folded — zero pending markers remain.
        let remaining_pending = runtime_derived_stale_marker_list_for_project(
            Some(&project),
            true,
            marker_list_request(Some("embedding"), Some("wiki/a.md"), Some("pending")),
        )
        .expect("list pending");
        assert!(remaining_pending.markers.is_empty());
        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn derived_marker_claim_batch_rejects_empty_group() {
        let project = setup_marker_project("marker-claim-empty");

        let error = runtime_derived_marker_claim_batch_for_project(
            Some(&project),
            true,
            claim_batch_request("embedding", "wiki/missing.md"),
            1000,
        )
        .expect_err("claiming an empty group must fail");
        assert!(error.starts_with("derived-marker-claim-empty"));

        // R3: calling claim_batch again on the same still-empty group returns
        // the SAME distinguishable error, not a generic/ambiguous failure —
        // the marker layer has no holder identity of its own (that lives at
        // the job-claim layer via runtime_job_claim_by_kind), so "already
        // claimed by someone else" and "nothing to claim" collapse to this
        // one clear, typed error at this layer by design.
        let error_again = runtime_derived_marker_claim_batch_for_project(
            Some(&project),
            true,
            claim_batch_request("embedding", "wiki/missing.md"),
            1001,
        )
        .expect_err("still nothing to claim");
        assert!(error_again.starts_with("derived-marker-claim-empty"));
        let _ = fs::remove_dir_all(project);
    }

    /// T1: two threads race to fold the SAME (layer, affectedPath) group.
    /// `RUNTIME_DB_WRITE_LOCK` serializes the two writer transactions, so the
    /// loser's own pending-snapshot read (inside its transaction) already
    /// observes zero pending rows and fails with a clean, typed error —
    /// never a double-claim of the same marker by two different jobs.
    ///
    /// Sabotage self-verification performed during implementation (matrix
    /// 6.2): temporarily removed the `.ok_or_else(...)` empty-snapshot guard
    /// in `runtime_derived_marker_claim_batch_for_project` (so an empty
    /// snapshot fell through to creating a job with zero markers instead of
    /// erroring) — this test went red because BOTH threads then returned
    /// `Ok`, violating the "exactly one Ok" assertion below. Restoring the
    /// guard turned it back green.
    #[test]
    fn derived_marker_claim_batch_concurrent_calls_on_same_group_only_one_succeeds() {
        let project = setup_marker_project("marker-claim-concurrent");
        seed_pending_marker(
            &project,
            "marker-1",
            "embedding",
            "wiki/a.md",
            "event-1",
            Some("sha256:hash1"),
            "hash1",
            "commit",
            100,
        );

        let shared_project = Arc::new(project.clone());
        let barrier = Arc::new(Barrier::new(2));
        let handles = (0..2)
            .map(|_| {
                let project = Arc::clone(&shared_project);
                let barrier = Arc::clone(&barrier);
                std::thread::spawn(move || {
                    barrier.wait();
                    runtime_derived_marker_claim_batch_for_project(
                        Some(project.as_path()),
                        true,
                        claim_batch_request("embedding", "wiki/a.md"),
                        1000,
                    )
                })
            })
            .collect::<Vec<_>>();
        let results = handles
            .into_iter()
            .map(|handle| handle.join().expect("claim thread"))
            .collect::<Vec<_>>();

        assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
        assert_eq!(results.iter().filter(|result| result.is_err()).count(), 1);
        assert!(results
            .iter()
            .filter_map(|result| result.as_ref().err())
            .all(|error| error.starts_with("derived-marker-claim-empty")));

        let all = runtime_derived_stale_marker_list_for_project(
            Some(&project),
            true,
            marker_list_request(None, None, None),
        )
        .expect("list all");
        assert_eq!(all.markers.len(), 1);
        assert_eq!(all.markers[0].status, CLAIMED_MARKER_STATUS);
        let _ = fs::remove_dir_all(project);
    }

    /// T2: a marker recorded strictly AFTER a claim_batch's pending snapshot
    /// was read must never be swept into that earlier batch — folding is
    /// snapshot-scoped, not "whatever is pending right now for this group".
    ///
    /// Sabotage self-verification performed during implementation (matrix
    /// 6.2): temporarily broadened the claiming `UPDATE`'s row selector from
    /// the exact `marker_id IN (<snapshot ids>)` list to
    /// `layer = ? AND affected_path = ? AND status = 'pending'` (the same
    /// predicate the SELECT snapshot uses). This test stayed green even with
    /// that change — expected, not a gap: `RUNTIME_DB_WRITE_LOCK` fully
    /// serializes every writer transaction (see
    /// `runtime_job_claim_matching_kind_for_project`'s own "defense in
    /// depth" comment for the same property), so within one claim_batch
    /// transaction nothing can insert a new pending row between the SELECT
    /// and the UPDATE — the two predicates are provably equivalent for any
    /// single call today. `marker-2` here is recorded by a wholly separate,
    /// already-committed transaction, so it never overlaps the SABOTAGEd
    /// query's execution window regardless of predicate breadth; this test
    /// still correctly guards the (transaction-boundary-based) contract.
    /// The `marker_id`-exact-list restriction genuinely IS load-bearing
    /// elsewhere, though: sabotaging the shared `update_markers_status_tx`
    /// helper the same way (drop `marker_id IN (...)`, keep only
    /// `status = ?`) turns BOTH
    /// `derived_marker_claim_batch_scopes_layers_independently` (D4) and
    /// `derived_marker_complete_batch_only_touches_own_marker_set` (T3) red
    /// — confirmed during implementation, then reverted.
    #[test]
    fn derived_marker_claim_batch_does_not_sweep_late_arriving_marker() {
        let project = setup_marker_project("marker-claim-late-arrival");
        seed_pending_marker(
            &project,
            "marker-1",
            "embedding",
            "wiki/a.md",
            "event-1",
            Some("sha256:hash1"),
            "hash1",
            "commit",
            100,
        );

        let job_a = runtime_derived_marker_claim_batch_for_project(
            Some(&project),
            true,
            claim_batch_request("embedding", "wiki/a.md"),
            200,
        )
        .expect("claim batch A");
        assert_eq!(job_a.markers.len(), 1);

        // Arrives strictly after job A's snapshot was read/committed.
        seed_pending_marker(
            &project,
            "marker-2",
            "embedding",
            "wiki/a.md",
            "event-2",
            Some("sha256:hash2"),
            "hash2",
            "commit",
            300,
        );

        let payload_a: serde_json::Value =
            serde_json::from_str(&job_a.job.payload).expect("parse job A payload");
        let marker_ids_a: Vec<&str> = payload_a["markerIds"]
            .as_array()
            .expect("markerIds array")
            .iter()
            .map(|value| value.as_str().expect("string id"))
            .collect();
        assert_eq!(marker_ids_a, vec!["marker-1"]);

        let marker_2 = runtime_derived_stale_marker_list_for_project(
            Some(&project),
            true,
            marker_list_request(None, Some("wiki/a.md"), None),
        )
        .expect("list markers")
        .markers
        .into_iter()
        .find(|marker| marker.marker_id == "marker-2")
        .expect("marker-2 present");
        assert_eq!(marker_2.status, PENDING_MARKER_STATUS);

        // A fresh claim_batch on the same group now folds ONLY marker-2.
        let job_b = runtime_derived_marker_claim_batch_for_project(
            Some(&project),
            true,
            claim_batch_request("embedding", "wiki/a.md"),
            400,
        )
        .expect("claim batch B");
        let payload_b: serde_json::Value =
            serde_json::from_str(&job_b.job.payload).expect("parse job B payload");
        let marker_ids_b: Vec<&str> = payload_b["markerIds"]
            .as_array()
            .expect("markerIds array")
            .iter()
            .map(|value| value.as_str().expect("string id"))
            .collect();
        assert_eq!(marker_ids_b, vec!["marker-2"]);
        let _ = fs::remove_dir_all(project);
    }

    // D4 sabotage self-verification performed during implementation (matrix
    // 6.2): dropped the `marker_id IN (...)` restriction from the shared
    // `update_markers_status_tx` helper (kept only `status = ?`) — this test
    // went red (`derived-marker-claim-conflict: expected to claim 1 ...
    // but claimed 2`) because the embedding-only claim then also flipped the
    // sibling graph marker. Restoring the restriction turned it back green.
    #[test]
    fn derived_marker_claim_batch_scopes_layers_independently() {
        // D4: folding one layer must never touch a sibling layer on the same path.
        let project = setup_marker_project("marker-claim-layer-scope");
        seed_pending_marker(
            &project,
            "marker-embedding",
            "embedding",
            "wiki/a.md",
            "event-1",
            Some("sha256:hash1"),
            "hash1",
            "commit",
            100,
        );
        seed_pending_marker(
            &project,
            "marker-graph",
            "graph",
            "wiki/a.md",
            "event-2",
            Some("sha256:hash2"),
            "hash2",
            "commit",
            100,
        );

        runtime_derived_marker_claim_batch_for_project(
            Some(&project),
            true,
            claim_batch_request("embedding", "wiki/a.md"),
            200,
        )
        .expect("claim embedding batch");

        let graph_marker = runtime_derived_stale_marker_list_for_project(
            Some(&project),
            true,
            marker_list_request(Some("graph"), Some("wiki/a.md"), None),
        )
        .expect("list graph markers");
        assert_eq!(graph_marker.markers.len(), 1);
        assert_eq!(graph_marker.markers[0].status, PENDING_MARKER_STATUS);
        let _ = fs::remove_dir_all(project);
    }

    // D2 sabotage self-verification performed during implementation (matrix
    // 6.2): temporarily hardcoded `"reason": "commit"` in the claim_batch
    // payload assembly, ignoring the latest row's actual `reason` — this
    // test went red (`assert_eq!(payload["reason"], "delete")` failed with
    // `"commit" != "delete"`). Restoring `"reason": reason` turned it back
    // green.
    #[test]
    fn derived_marker_claim_batch_carries_delete_intent_verbatim() {
        // D2: a delete-intent marker's payload must say so (null inputHash,
        // reason "delete") rather than being normalized into a commit shape.
        let project = setup_marker_project("marker-claim-delete-intent");
        seed_pending_marker(
            &project,
            "marker-1",
            "embedding",
            "wiki/b.md",
            "event-1",
            None,
            "hash1",
            "delete",
            100,
        );

        let claimed = runtime_derived_marker_claim_batch_for_project(
            Some(&project),
            true,
            claim_batch_request("embedding", "wiki/b.md"),
            200,
        )
        .expect("claim delete-intent batch");
        let payload: serde_json::Value =
            serde_json::from_str(&claimed.job.payload).expect("parse payload");
        assert_eq!(payload["reason"], "delete");
        assert!(payload["inputHash"].is_null());
        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn derived_marker_claim_batch_delete_after_commit_wins_and_no_ghost_revival() {
        // D2 mixed sequence (Tester P1 #1): a commit marker followed by a
        // delete marker for the SAME group must fold to delete intent
        // (latest wins), discarding the earlier commit's hash entirely — not
        // reviving it once the batch is processed.
        let project = setup_marker_project("marker-claim-d2-mixed-sequence");
        seed_pending_marker(
            &project,
            "marker-commit",
            "embedding",
            "wiki/c.md",
            "event-1",
            Some("sha256:commit-hash"),
            "commit-hash",
            "commit",
            100,
        );
        seed_pending_marker(
            &project,
            "marker-delete",
            "embedding",
            "wiki/c.md",
            "event-2",
            None,
            "delete-base",
            "delete",
            200,
        );

        let claimed = runtime_derived_marker_claim_batch_for_project(
            Some(&project),
            true,
            claim_batch_request("embedding", "wiki/c.md"),
            300,
        )
        .expect("claim mixed-sequence batch");
        assert_eq!(claimed.markers.len(), 2);

        let payload: serde_json::Value =
            serde_json::from_str(&claimed.job.payload).expect("parse payload");
        assert_eq!(payload["reason"], "delete");
        assert!(payload["inputHash"].is_null());
        assert_eq!(payload["baseVersion"], "delete-base");

        // No ghost revival: processing this delete-intent batch to
        // completion must not produce a NEW pending marker carrying the
        // earlier commit's hash back to life.
        let claim = runtime_job_claim_by_kind_for_project(
            Some(&project),
            true,
            claim_by_kind_request("worker-1", "lease-1", DERIVED_REBUILD_JOB_KIND),
            400,
        )
        .expect("claim job");
        runtime_derived_marker_complete_batch_for_project(
            Some(&project),
            true,
            complete_batch_request(
                &claim.job.job_id,
                &claim.lease.lease_id,
                &["marker-commit", "marker-delete"],
            ),
            500,
        )
        .expect("complete delete-intent batch");
        let remaining_pending = runtime_derived_stale_marker_list_for_project(
            Some(&project),
            true,
            marker_list_request(Some("embedding"), Some("wiki/c.md"), Some("pending")),
        )
        .expect("list pending");
        assert!(remaining_pending.markers.is_empty());
        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn derived_marker_complete_batch_happy_path_marks_done_and_completes_job() {
        let project = setup_marker_project("marker-complete-happy");
        seed_pending_marker(
            &project,
            "marker-1",
            "embedding",
            "wiki/a.md",
            "event-1",
            Some("sha256:hash1"),
            "hash1",
            "commit",
            100,
        );
        let claimed = runtime_derived_marker_claim_batch_for_project(
            Some(&project),
            true,
            claim_batch_request("embedding", "wiki/a.md"),
            200,
        )
        .expect("claim batch");
        let claim = runtime_job_claim_by_kind_for_project(
            Some(&project),
            true,
            claim_by_kind_request("worker-1", "lease-1", DERIVED_REBUILD_JOB_KIND),
            300,
        )
        .expect("claim job by kind");
        assert_eq!(claim.job.job_id, claimed.job.job_id);

        let completed = runtime_derived_marker_complete_batch_for_project(
            Some(&project),
            true,
            complete_batch_request(&claim.job.job_id, &claim.lease.lease_id, &["marker-1"]),
            400,
        )
        .expect("complete batch");
        assert_eq!(completed.job.state, "completed");
        assert_eq!(completed.markers.len(), 1);
        assert_eq!(completed.markers[0].status, DONE_MARKER_STATUS);
        let _ = fs::remove_dir_all(project);
    }

    // T3 sabotage self-verification performed during implementation (matrix
    // 6.2): dropped the `marker_id IN (...)` restriction from the shared
    // `update_markers_status_tx` helper (kept only `status = ?`) — this test
    // went red (`derived-marker-complete-conflict: expected to complete 1 ...
    // but updated 2`) because A's complete then also flipped B's
    // already-claimed `marker-2` to done. Restoring the restriction turned
    // it back green.
    #[test]
    fn derived_marker_complete_batch_only_touches_own_marker_set() {
        // T3: A's complete must never touch B's newly-claimed marker on the
        // same (layer, affectedPath), and an id set mismatch is rejected
        // outright rather than silently completing a subset.
        let project = setup_marker_project("marker-complete-own-set");
        seed_pending_marker(
            &project,
            "marker-1",
            "embedding",
            "wiki/a.md",
            "event-1",
            Some("sha256:hash1"),
            "hash1",
            "commit",
            100,
        );
        let job_a = runtime_derived_marker_claim_batch_for_project(
            Some(&project),
            true,
            claim_batch_request("embedding", "wiki/a.md"),
            200,
        )
        .expect("claim batch A");
        let claim_a = runtime_job_claim_by_kind_for_project(
            Some(&project),
            true,
            claim_by_kind_request("worker-a", "lease-a", DERIVED_REBUILD_JOB_KIND),
            201,
        )
        .expect("claim job A");

        seed_pending_marker(
            &project,
            "marker-2",
            "embedding",
            "wiki/a.md",
            "event-2",
            Some("sha256:hash2"),
            "hash2",
            "commit",
            300,
        );
        let job_b = runtime_derived_marker_claim_batch_for_project(
            Some(&project),
            true,
            claim_batch_request("embedding", "wiki/a.md"),
            400,
        )
        .expect("claim batch B");
        assert_ne!(job_a.job.job_id, job_b.job.job_id);

        // Mismatch guard: A cannot complete B's marker under A's job/lease.
        let mismatch = runtime_derived_marker_complete_batch_for_project(
            Some(&project),
            true,
            complete_batch_request(
                &claim_a.job.job_id,
                &claim_a.lease.lease_id,
                &["marker-1", "marker-2"],
            ),
            500,
        )
        .expect_err("completing another job's marker must fail");
        assert!(mismatch.starts_with("derived-marker-complete-mismatch"));

        // A's own complete only touches marker-1; marker-2 (claimed by B) is untouched.
        let completed_a = runtime_derived_marker_complete_batch_for_project(
            Some(&project),
            true,
            complete_batch_request(&claim_a.job.job_id, &claim_a.lease.lease_id, &["marker-1"]),
            600,
        )
        .expect("complete A's own set");
        assert_eq!(completed_a.markers.len(), 1);
        assert_eq!(completed_a.markers[0].marker_id, "marker-1");
        assert_eq!(completed_a.markers[0].status, DONE_MARKER_STATUS);

        let marker_2 = runtime_derived_stale_marker_list_for_project(
            Some(&project),
            true,
            marker_list_request(None, Some("wiki/a.md"), None),
        )
        .expect("list markers")
        .markers
        .into_iter()
        .find(|marker| marker.marker_id == "marker-2")
        .expect("marker-2 present");
        assert_eq!(marker_2.status, CLAIMED_MARKER_STATUS);
        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn derived_marker_complete_batch_rejects_true_subset_of_own_markers() {
        // Tester P2 #5: a caller must submit the EXACT set of ids the job
        // claimed — not fewer. ensure_marker_id_sets_match rejects a genuine
        // subset of the job's own markerIds just as it rejects a
        // superset/foreign id (already covered by the mismatch case above).
        let project = setup_marker_project("marker-complete-subset-reject");
        seed_pending_marker(
            &project,
            "marker-1",
            "embedding",
            "wiki/a.md",
            "event-1",
            Some("sha256:hash1"),
            "hash1",
            "commit",
            100,
        );
        seed_pending_marker(
            &project,
            "marker-2",
            "embedding",
            "wiki/a.md",
            "event-2",
            Some("sha256:hash2"),
            "hash2",
            "commit",
            200,
        );
        seed_pending_marker(
            &project,
            "marker-3",
            "embedding",
            "wiki/a.md",
            "event-3",
            Some("sha256:hash3"),
            "hash3",
            "commit",
            300,
        );

        let claimed = runtime_derived_marker_claim_batch_for_project(
            Some(&project),
            true,
            claim_batch_request("embedding", "wiki/a.md"),
            400,
        )
        .expect("claim batch of 3");
        assert_eq!(claimed.markers.len(), 3);
        let claim = runtime_job_claim_by_kind_for_project(
            Some(&project),
            true,
            claim_by_kind_request("worker-1", "lease-1", DERIVED_REBUILD_JOB_KIND),
            500,
        )
        .expect("claim job");

        let subset = runtime_derived_marker_complete_batch_for_project(
            Some(&project),
            true,
            complete_batch_request(&claim.job.job_id, &claim.lease.lease_id, &["marker-1"]),
            600,
        )
        .expect_err("a true subset of the job's own markerIds must be rejected");
        assert!(subset.starts_with("derived-marker-complete-mismatch"));

        // All 3 remain claimed — the rejected call must not have partially applied.
        let markers = runtime_derived_stale_marker_list_for_project(
            Some(&project),
            true,
            marker_list_request(None, Some("wiki/a.md"), None),
        )
        .expect("list markers");
        assert!(markers
            .markers
            .iter()
            .all(|marker| marker.status == CLAIMED_MARKER_STATUS));
        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn derived_marker_complete_batch_rejects_empty_and_duplicate_marker_ids() {
        // P3 #9: normalize_marker_id_batch's validation exercised through
        // the actual complete_batch command path.
        let project = setup_marker_project("marker-complete-batch-id-validation");
        seed_pending_marker(
            &project,
            "marker-1",
            "embedding",
            "wiki/a.md",
            "event-1",
            Some("sha256:hash1"),
            "hash1",
            "commit",
            100,
        );
        let claimed = runtime_derived_marker_claim_batch_for_project(
            Some(&project),
            true,
            claim_batch_request("embedding", "wiki/a.md"),
            200,
        )
        .expect("claim batch");
        let claim = runtime_job_claim_by_kind_for_project(
            Some(&project),
            true,
            claim_by_kind_request("worker-1", "lease-1", DERIVED_REBUILD_JOB_KIND),
            300,
        )
        .expect("claim job");

        let empty = runtime_derived_marker_complete_batch_for_project(
            Some(&project),
            true,
            complete_batch_request(&claim.job.job_id, &claim.lease.lease_id, &[]),
            400,
        )
        .expect_err("empty markerIds must be rejected");
        assert!(empty.starts_with("invalid-marker-ids"));

        let duplicate = runtime_derived_marker_complete_batch_for_project(
            Some(&project),
            true,
            complete_batch_request(
                &claim.job.job_id,
                &claim.lease.lease_id,
                &["marker-1", "marker-1"],
            ),
            400,
        )
        .expect_err("duplicate markerIds must be rejected");
        assert!(duplicate.starts_with("invalid-marker-ids"));
        let _ = claimed;
        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn derived_marker_release_batch_rejects_empty_and_duplicate_marker_ids() {
        // P3 #9: normalize_marker_id_batch's validation exercised through
        // the actual release_batch command path.
        let project = setup_marker_project("marker-release-batch-id-validation");
        seed_pending_marker(
            &project,
            "marker-1",
            "embedding",
            "wiki/a.md",
            "event-1",
            Some("sha256:hash1"),
            "hash1",
            "commit",
            100,
        );
        let claimed = runtime_derived_marker_claim_batch_for_project(
            Some(&project),
            true,
            claim_batch_request("embedding", "wiki/a.md"),
            200,
        )
        .expect("claim batch");
        runtime_job_claim_by_kind_for_project(
            Some(&project),
            true,
            claim_by_kind_request("worker-1", "lease-1", DERIVED_REBUILD_JOB_KIND),
            300,
        )
        .expect("claim job");
        runtime_job_cancel_for_project(
            Some(&project),
            true,
            RuntimeJobCancelRequest {
                job_id: claimed.job.job_id.clone(),
            },
            400,
        )
        .expect("cancel job");

        let empty = runtime_derived_marker_release_batch_for_project(
            Some(&project),
            true,
            release_batch_request(&claimed.job.job_id, &[], "cancelled"),
            500,
        )
        .expect_err("empty markerIds must be rejected");
        assert!(empty.starts_with("invalid-marker-ids"));

        let duplicate = runtime_derived_marker_release_batch_for_project(
            Some(&project),
            true,
            release_batch_request(&claimed.job.job_id, &["marker-1", "marker-1"], "cancelled"),
            500,
        )
        .expect_err("duplicate markerIds must be rejected");
        assert!(duplicate.starts_with("invalid-marker-ids"));
        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn normalize_marker_id_batch_rejects_empty_and_duplicate_ids() {
        // P3 #9: the normalization helper itself, direct unit coverage.
        let empty = normalize_marker_id_batch(&[]).expect_err("empty batch must be rejected");
        assert!(empty.starts_with("invalid-marker-ids"));

        let duplicate =
            normalize_marker_id_batch(&["marker-1".to_string(), "marker-1".to_string()])
                .expect_err("duplicate ids must be rejected");
        assert!(duplicate.starts_with("invalid-marker-ids"));

        let blank =
            normalize_marker_id_batch(&["  ".to_string()]).expect_err("blank id must be rejected");
        assert!(blank.starts_with("invalid-marker-ids"));

        assert_eq!(
            normalize_marker_id_batch(&["marker-1".to_string(), "marker-2".to_string()])
                .expect("valid batch"),
            vec!["marker-1".to_string(), "marker-2".to_string()]
        );
    }

    /// L1 (P0 fix): a worker crash (simulated by an expired lease) is
    /// reclaimed automatically — the job moves to `retry-wait` and its
    /// claimed marker STAYS `claimed`, still owned by the SAME job (no
    /// reset-to-`pending` self-heal — see `runtime_job_lease_timeout_for_
    /// project`'s doc comment for why an earlier revision's reset-to-pending
    /// behavior in this branch was a bug, not a feature: it let
    /// `claim_batch` mint a brand-new attempt=0 job for the same group on
    /// every crash, so a poison marker never converged). Recovery is
    /// `runtime_job_retry` pulling the SAME `job_id` back to `queued`, then
    /// `runtime_job_claim_by_kind` re-claiming it — the attempt counter
    /// continues on that one job.
    ///
    /// Sabotage self-verification performed during implementation (matrix
    /// 6.2): temporarily restored the old reset-to-`pending` behavior in the
    /// `retry-wait` branch of `runtime_job_lease_timeout_for_project` — this
    /// test went red twice over: `assert_eq!(marker_after_reclaim.status,
    /// CLAIMED_MARKER_STATUS)` failed with `"pending" != "claimed"`, AND the
    /// regression-lock assertion (a fresh `claim_batch` on the same group
    /// must find nothing pending) failed because the reset marker became
    /// claimable again by a competing job. Reverting to the no-op branch
    /// turned both back green.
    #[test]
    fn derived_marker_lease_timeout_self_heals_within_same_job() {
        let project = setup_marker_project("marker-lease-timeout-l1");
        seed_pending_marker(
            &project,
            "marker-1",
            "embedding",
            "wiki/a.md",
            "event-1",
            Some("sha256:hash1"),
            "hash1",
            "commit",
            100,
        );
        let claimed = runtime_derived_marker_claim_batch_for_project(
            Some(&project),
            true,
            claim_batch_request("embedding", "wiki/a.md"),
            200,
        )
        .expect("claim batch");
        let claim_1 = runtime_job_claim_by_kind_for_project(
            Some(&project),
            true,
            claim_by_kind_request("worker-1", "lease-1", DERIVED_REBUILD_JOB_KIND),
            300,
        )
        .expect("claim job (simulated worker that then crashes)");

        // Simulate the crash: the lease is now expired.
        let reclaim_now = 300 + DEFAULT_LEASE_TTL_MS;
        let reclaimed = runtime_job_lease_timeout_for_project(
            Some(&project),
            true,
            &claim_1.job.job_id,
            &claim_1.lease.lease_id,
            reclaim_now,
        )
        .expect("reclaim expired lease");
        assert_eq!(reclaimed.state, "retry-wait");
        assert_eq!(reclaimed.job_id, claimed.job.job_id);

        // P0 fix: the marker stays `claimed`, still owned by the SAME job.
        let marker_after_reclaim = runtime_derived_stale_marker_list_for_project(
            Some(&project),
            true,
            marker_list_request(None, Some("wiki/a.md"), None),
        )
        .expect("list markers")
        .markers
        .into_iter()
        .find(|marker| marker.marker_id == "marker-1")
        .expect("marker-1 present");
        assert_eq!(marker_after_reclaim.status, CLAIMED_MARKER_STATUS);

        // Regression lock: a fresh claim_batch on the same group must NOT
        // mint a competing job — there is nothing pending left to fold while
        // the original (retry-wait) job still owns marker-1.
        let competing = runtime_derived_marker_claim_batch_for_project(
            Some(&project),
            true,
            claim_batch_request("embedding", "wiki/a.md"),
            reclaim_now + 1,
        )
        .expect_err("no pending markers to fold while the original job still owns marker-1");
        assert!(competing.starts_with("derived-marker-claim-empty"));

        // Recovery is via the SAME job: retry -> queued -> re-claim, attempt
        // count continuing from where it left off. `retry_after_ms` (set by
        // the lease timeout above) isn't eligible until DEFAULT_RETRY_BACKOFF_MS
        // has elapsed.
        let retry_now = reclaim_now + DEFAULT_RETRY_BACKOFF_MS;
        runtime_job_retry_for_project(
            Some(&project),
            true,
            RuntimeJobRetryRequest {
                job_id: claim_1.job.job_id.clone(),
            },
            retry_now,
        )
        .expect("retry the same job");
        let claim_2 = runtime_job_claim_by_kind_for_project(
            Some(&project),
            true,
            claim_by_kind_request("worker-2", "lease-2", DERIVED_REBUILD_JOB_KIND),
            retry_now + 1,
        )
        .expect("re-claim the SAME job");
        assert_eq!(claim_2.job.job_id, claim_1.job.job_id);
        assert_eq!(claim_2.job.attempt, 2);

        runtime_derived_marker_complete_batch_for_project(
            Some(&project),
            true,
            complete_batch_request(&claim_2.job.job_id, &claim_2.lease.lease_id, &["marker-1"]),
            retry_now + 2,
        )
        .expect("complete after recovery");
        let _ = fs::remove_dir_all(project);
    }

    /// L5 variant (Tester P2 #4): the zombie complete arrives while
    /// marker-1 is still `claimed` (NOT yet `done`) — the job IS `running`,
    /// just under a DIFFERENT, currently-active lease (holder 2 re-claimed
    /// the SAME job_id after holder 1's crash+retry). The rejection must
    /// therefore come from `ensure_active_running_lease`'s lease-identity
    /// check specifically, not from `update_markers_status_tx`'s
    /// affected-row-count backstop (which the original combined L1+L5 test
    /// could never actually exercise: there, holder 1's job had already left
    /// `running` entirely by the time its zombie complete was attempted, so
    /// the coarse job-state check alone was always enough).
    #[test]
    fn derived_marker_complete_batch_rejects_zombie_lease_on_recovered_running_job() {
        let project = setup_marker_project("marker-lease-timeout-l5-variant");
        seed_pending_marker(
            &project,
            "marker-1",
            "embedding",
            "wiki/a.md",
            "event-1",
            Some("sha256:hash1"),
            "hash1",
            "commit",
            100,
        );
        runtime_derived_marker_claim_batch_for_project(
            Some(&project),
            true,
            claim_batch_request("embedding", "wiki/a.md"),
            200,
        )
        .expect("claim batch");
        let claim_1 = runtime_job_claim_by_kind_for_project(
            Some(&project),
            true,
            claim_by_kind_request("worker-1", "lease-1", DERIVED_REBUILD_JOB_KIND),
            300,
        )
        .expect("holder 1 claims (then crashes)");

        let reclaim_now = 300 + DEFAULT_LEASE_TTL_MS;
        runtime_job_lease_timeout_for_project(
            Some(&project),
            true,
            &claim_1.job.job_id,
            &claim_1.lease.lease_id,
            reclaim_now,
        )
        .expect("reclaim expired lease");
        let retry_now = reclaim_now + DEFAULT_RETRY_BACKOFF_MS;
        runtime_job_retry_for_project(
            Some(&project),
            true,
            RuntimeJobRetryRequest {
                job_id: claim_1.job.job_id.clone(),
            },
            retry_now,
        )
        .expect("retry the same job");
        let claim_2 = runtime_job_claim_by_kind_for_project(
            Some(&project),
            true,
            claim_by_kind_request("worker-2", "lease-2", DERIVED_REBUILD_JOB_KIND),
            retry_now + 1,
        )
        .expect("holder 2 re-claims the SAME job");
        assert_eq!(claim_2.job.job_id, claim_1.job.job_id);

        let marker_before_zombie = runtime_derived_stale_marker_list_for_project(
            Some(&project),
            true,
            marker_list_request(None, Some("wiki/a.md"), None),
        )
        .expect("list markers")
        .markers
        .into_iter()
        .find(|marker| marker.marker_id == "marker-1")
        .expect("marker-1 present");
        assert_eq!(
            marker_before_zombie.status, CLAIMED_MARKER_STATUS,
            "holder 2 has not completed yet"
        );

        // Holder 1's stale lease-1, against the SAME job_id which IS
        // `running` (under holder 2's lease-2): rejected on lease identity.
        let zombie = runtime_derived_marker_complete_batch_for_project(
            Some(&project),
            true,
            complete_batch_request(&claim_1.job.job_id, &claim_1.lease.lease_id, &["marker-1"]),
            retry_now + 2,
        )
        .expect_err("holder 1's stale lease must be rejected even though the job is running");
        assert!(zombie.starts_with("inactive-lease"));

        // Holder 2 legitimately completes.
        runtime_derived_marker_complete_batch_for_project(
            Some(&project),
            true,
            complete_batch_request(&claim_2.job.job_id, &claim_2.lease.lease_id, &["marker-1"]),
            retry_now + 3,
        )
        .expect("holder 2 completes");
        let _ = fs::remove_dir_all(project);
    }

    /// P1 (real multi-round convergence, not a max_attempts=1 shortcut): a
    /// poison marker whose rebuild always crashes must converge to `failed`
    /// after `max_attempts=3` real claim -> crash -> reclaim rounds, each on
    /// the SAME job_id (P0 fix — attempts only converge because they
    /// accumulate on one job, not a fresh one per crash). Intermediate
    /// rounds assert the marker stays `claimed` and is NOT re-foldable by
    /// `claim_batch` — the regression lock against a competing job.
    ///
    /// Sabotage self-verification performed during implementation (matrix
    /// 6.2): temporarily hardcoded `retry_remaining = true` in
    /// `runtime_job_lease_timeout_for_project` (disabling the
    /// `attempt < max_attempts` check) — this test went red
    /// (`assert_eq!(final_job.state, "failed")` failed because the job was
    /// still `retry-wait` after 3 rounds — it never converges). Restoring
    /// the real comparison turned it back green.
    #[test]
    fn derived_marker_lease_timeout_converges_poison_marker_to_failed_after_max_attempts() {
        let project = setup_marker_project("marker-lease-timeout-p1");
        seed_pending_marker(
            &project,
            "marker-1",
            "embedding",
            "wiki/a.md",
            "event-1",
            Some("sha256:hash1"),
            "hash1",
            "commit",
            100,
        );
        let claimed = runtime_derived_marker_claim_batch_for_project(
            Some(&project),
            true,
            RuntimeDerivedMarkerClaimBatchRequest {
                max_attempts: Some(3),
                ..claim_batch_request("embedding", "wiki/a.md")
            },
            200,
        )
        .expect("claim batch with max_attempts=3");
        assert_eq!(claimed.job.max_attempts, 3);
        let job_id = claimed.job.job_id.clone();

        let mut now = 300;
        for round in 1..=2 {
            let claim = runtime_job_claim_by_kind_for_project(
                Some(&project),
                true,
                claim_by_kind_request(
                    &format!("worker-{round}"),
                    &format!("lease-{round}"),
                    DERIVED_REBUILD_JOB_KIND,
                ),
                now,
            )
            .unwrap_or_else(|err| panic!("round {round}: claim job: {err}"));
            assert_eq!(
                claim.job.job_id, job_id,
                "round {round}: same job_id every round"
            );
            assert_eq!(
                claim.job.attempt, round,
                "round {round}: attempt count continues on the same job"
            );

            now += DEFAULT_LEASE_TTL_MS;
            let reclaimed = runtime_job_lease_timeout_for_project(
                Some(&project),
                true,
                &claim.job.job_id,
                &claim.lease.lease_id,
                now,
            )
            .unwrap_or_else(|err| panic!("round {round}: reclaim: {err}"));
            assert_eq!(
                reclaimed.state, "retry-wait",
                "round {round}: attempts remain"
            );

            // Intermediate-round regression lock: the marker must stay
            // claimed under this SAME job, not be re-foldable elsewhere.
            let marker = runtime_derived_stale_marker_list_for_project(
                Some(&project),
                true,
                marker_list_request(None, Some("wiki/a.md"), None),
            )
            .expect("list markers")
            .markers
            .into_iter()
            .find(|marker| marker.marker_id == "marker-1")
            .expect("marker-1 present");
            assert_eq!(
                marker.status, CLAIMED_MARKER_STATUS,
                "round {round}: marker stays claimed"
            );
            let cannot_refold = runtime_derived_marker_claim_batch_for_project(
                Some(&project),
                true,
                claim_batch_request("embedding", "wiki/a.md"),
                now,
            )
            .unwrap_err();
            assert!(
                cannot_refold.starts_with("derived-marker-claim-empty"),
                "round {round}: nothing pending to fold into a competing job, got: {cannot_refold}"
            );

            // retry_after_ms (set by the lease timeout above) isn't eligible
            // until DEFAULT_RETRY_BACKOFF_MS has elapsed.
            now += DEFAULT_RETRY_BACKOFF_MS;
            runtime_job_retry_for_project(
                Some(&project),
                true,
                RuntimeJobRetryRequest {
                    job_id: job_id.clone(),
                },
                now,
            )
            .unwrap_or_else(|err| panic!("round {round}: retry: {err}"));
        }

        // Round 3: attempts exhausted (attempt reaches max_attempts=3) —
        // this reclaim must be the one that converges to `failed`.
        let final_claim = runtime_job_claim_by_kind_for_project(
            Some(&project),
            true,
            claim_by_kind_request("worker-3", "lease-3", DERIVED_REBUILD_JOB_KIND),
            now,
        )
        .expect("round 3: claim job");
        assert_eq!(final_claim.job.attempt, 3);
        now += DEFAULT_LEASE_TTL_MS;
        let final_job = runtime_job_lease_timeout_for_project(
            Some(&project),
            true,
            &final_claim.job.job_id,
            &final_claim.lease.lease_id,
            now,
        )
        .expect("round 3: reclaim exhausted job");
        assert_eq!(final_job.state, "failed");

        let marker = runtime_derived_stale_marker_list_for_project(
            Some(&project),
            true,
            marker_list_request(None, Some("wiki/a.md"), None),
        )
        .expect("list markers")
        .markers
        .into_iter()
        .find(|marker| marker.marker_id == "marker-1")
        .expect("marker-1 present");
        assert_eq!(marker.status, FAILED_MARKER_STATUS);
        assert!(marker
            .last_error
            .as_deref()
            .is_some_and(|error| error.contains("lease-timeout")));
        let _ = fs::remove_dir_all(project);
    }

    /// L4: an explicit clock rollback must not permanently deadlock reclaim —
    /// a `now` before the lease's real expiry is cleanly rejected, and the
    /// same lease still reclaims correctly once `now` legitimately advances.
    #[test]
    fn derived_marker_lease_timeout_clock_rollback_does_not_deadlock() {
        let project = setup_marker_project("marker-lease-timeout-l4");
        seed_pending_marker(
            &project,
            "marker-1",
            "embedding",
            "wiki/a.md",
            "event-1",
            Some("sha256:hash1"),
            "hash1",
            "commit",
            100,
        );
        runtime_derived_marker_claim_batch_for_project(
            Some(&project),
            true,
            claim_batch_request("embedding", "wiki/a.md"),
            200,
        )
        .expect("claim batch");
        let claim = runtime_job_claim_by_kind_for_project(
            Some(&project),
            true,
            claim_by_kind_request("worker-1", "lease-1", DERIVED_REBUILD_JOB_KIND),
            1_000_000,
        )
        .expect("claim job");

        // Rolled-back clock: well before the lease's real expiry.
        let rolled_back_now = 1_000_000 - 10_000_000;
        let rejected = runtime_job_lease_timeout_for_project(
            Some(&project),
            true,
            &claim.job.job_id,
            &claim.lease.lease_id,
            rolled_back_now,
        )
        .expect_err("rolled-back clock must not appear expired");
        assert!(rejected.starts_with("lease-not-expired"));

        // Marker must still be claimed — no partial/erroneous reconciliation happened.
        let marker = runtime_derived_stale_marker_list_for_project(
            Some(&project),
            true,
            marker_list_request(None, Some("wiki/a.md"), None),
        )
        .expect("list markers")
        .markers
        .into_iter()
        .find(|marker| marker.marker_id == "marker-1")
        .expect("marker-1 present");
        assert_eq!(marker.status, CLAIMED_MARKER_STATUS);

        // Clock legitimately advances past the real expiry: reclaim succeeds.
        let reclaimed = runtime_job_lease_timeout_for_project(
            Some(&project),
            true,
            &claim.job.job_id,
            &claim.lease.lease_id,
            1_000_000 + DEFAULT_LEASE_TTL_MS,
        )
        .expect("reclaim after real expiry");
        assert_eq!(reclaimed.state, "retry-wait");
        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn derived_marker_release_batch_after_cancel_rejects_complete_and_reaches_cancelled() {
        // P3: cancel-then-complete race — complete must be rejected once the
        // job is cancelled, and the marker's own terminal state (via the
        // explicit release_batch call a caller makes after job_cancel) must
        // land on `cancelled`, not silently flip back to `done`.
        let project = setup_marker_project("marker-release-cancel-p3");
        seed_pending_marker(
            &project,
            "marker-1",
            "embedding",
            "wiki/a.md",
            "event-1",
            Some("sha256:hash1"),
            "hash1",
            "commit",
            100,
        );
        let claimed = runtime_derived_marker_claim_batch_for_project(
            Some(&project),
            true,
            claim_batch_request("embedding", "wiki/a.md"),
            200,
        )
        .expect("claim batch");
        let claim = runtime_job_claim_by_kind_for_project(
            Some(&project),
            true,
            claim_by_kind_request("worker-1", "lease-1", DERIVED_REBUILD_JOB_KIND),
            300,
        )
        .expect("claim job");
        assert_eq!(claim.job.job_id, claimed.job.job_id);

        runtime_job_cancel_for_project(
            Some(&project),
            true,
            RuntimeJobCancelRequest {
                job_id: claim.job.job_id.clone(),
            },
            400,
        )
        .expect("cancel job");

        let complete_after_cancel = runtime_derived_marker_complete_batch_for_project(
            Some(&project),
            true,
            complete_batch_request(&claim.job.job_id, &claim.lease.lease_id, &["marker-1"]),
            500,
        )
        .expect_err("complete after cancel must be rejected");
        assert!(complete_after_cancel.starts_with("invalid-transition"));

        let released = runtime_derived_marker_release_batch_for_project(
            Some(&project),
            true,
            release_batch_request(&claim.job.job_id, &["marker-1"], "cancelled"),
            600,
        )
        .expect("release cancelled marker");
        assert_eq!(released.markers.len(), 1);
        assert_eq!(released.markers[0].status, CANCELLED_MARKER_STATUS);
        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn derived_marker_release_batch_rejects_wrong_job_state_and_marker_id_mismatch() {
        let project = setup_marker_project("marker-release-guards");
        seed_pending_marker(
            &project,
            "marker-1",
            "embedding",
            "wiki/a.md",
            "event-1",
            Some("sha256:hash1"),
            "hash1",
            "commit",
            100,
        );
        let claimed = runtime_derived_marker_claim_batch_for_project(
            Some(&project),
            true,
            claim_batch_request("embedding", "wiki/a.md"),
            200,
        )
        .expect("claim batch");

        // Job is still `queued`, not `failed`/`cancelled`/`retry-wait`.
        let wrong_state = runtime_derived_marker_release_batch_for_project(
            Some(&project),
            true,
            release_batch_request(&claimed.job.job_id, &["marker-1"], "failed"),
            300,
        )
        .expect_err("release against a queued job must fail");
        assert!(wrong_state.starts_with("invalid-transition"));

        runtime_job_cancel_for_project(
            Some(&project),
            true,
            RuntimeJobCancelRequest {
                job_id: claimed.job.job_id.clone(),
            },
            400,
        )
        .expect("cancel job");
        let mismatch = runtime_derived_marker_release_batch_for_project(
            Some(&project),
            true,
            release_batch_request(&claimed.job.job_id, &["marker-does-not-exist"], "cancelled"),
            500,
        )
        .expect_err("marker id mismatch must fail");
        assert!(mismatch.starts_with("derived-marker-release-mismatch"));
        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn derived_marker_list_cursor_pages_without_gaps_or_repeats() {
        // T5 / decision 6: composite cursor pagination must be exhaustive and
        // non-overlapping across pages.
        let project = setup_marker_project("marker-list-cursor");
        for (index, marked_at_ms) in [100_i64, 200, 300, 400, 500].into_iter().enumerate() {
            seed_pending_marker(
                &project,
                &format!("marker-{index}"),
                "embedding",
                &format!("wiki/page-{index}.md"),
                &format!("event-{index}"),
                Some("sha256:hash"),
                "hash",
                "commit",
                marked_at_ms,
            );
        }

        let page1 = runtime_derived_stale_marker_list_for_project(
            Some(&project),
            true,
            marker_list_request_with_cursor(2, None, None),
        )
        .expect("page 1");
        assert_eq!(page1.markers.len(), 2);
        let cursor1 = page1
            .next_cursor
            .clone()
            .expect("page 1 is full, must carry a cursor");

        let page2 = runtime_derived_stale_marker_list_for_project(
            Some(&project),
            true,
            marker_list_request_with_cursor(
                2,
                Some(cursor1.marked_at_ms),
                Some(&cursor1.marker_id),
            ),
        )
        .expect("page 2");
        assert_eq!(page2.markers.len(), 2);
        let cursor2 = page2
            .next_cursor
            .clone()
            .expect("page 2 is full, must carry a cursor");

        let page3 = runtime_derived_stale_marker_list_for_project(
            Some(&project),
            true,
            marker_list_request_with_cursor(
                2,
                Some(cursor2.marked_at_ms),
                Some(&cursor2.marker_id),
            ),
        )
        .expect("page 3");
        assert_eq!(page3.markers.len(), 1);
        assert!(
            page3.next_cursor.is_none(),
            "a short page must not claim there is more"
        );

        let mut all_ids: Vec<String> = page1
            .markers
            .iter()
            .chain(page2.markers.iter())
            .chain(page3.markers.iter())
            .map(|marker| marker.marker_id.clone())
            .collect();
        all_ids.sort();
        assert_eq!(
            all_ids,
            vec!["marker-0", "marker-1", "marker-2", "marker-3", "marker-4"]
        );
        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn derived_marker_list_cursor_tie_breaks_by_marker_id_within_same_timestamp() {
        // Tester P1 #2: markers sharing the exact same marked_at_ms (e.g. a
        // single commit batch-marking several paths in one millisecond) must
        // still page without gaps or repeats, using marker_id as the
        // secondary sort key/cursor component.
        let project = setup_marker_project("marker-list-cursor-tiebreak");
        for index in 0..5 {
            seed_pending_marker(
                &project,
                &format!("marker-{index}"),
                "embedding",
                &format!("wiki/tie-{index}.md"),
                &format!("event-{index}"),
                Some("sha256:hash"),
                "hash",
                "commit",
                100, // same marked_at_ms for all 5
            );
        }

        let page1 = runtime_derived_stale_marker_list_for_project(
            Some(&project),
            true,
            marker_list_request_with_cursor(2, None, None),
        )
        .expect("page 1");
        assert_eq!(
            page1
                .markers
                .iter()
                .map(|m| m.marker_id.as_str())
                .collect::<Vec<_>>(),
            vec!["marker-0", "marker-1"]
        );
        let cursor1 = page1
            .next_cursor
            .clone()
            .expect("full page carries a cursor");
        assert_eq!(cursor1.marked_at_ms, 100);
        assert_eq!(cursor1.marker_id, "marker-1");

        let page2 = runtime_derived_stale_marker_list_for_project(
            Some(&project),
            true,
            marker_list_request_with_cursor(
                2,
                Some(cursor1.marked_at_ms),
                Some(&cursor1.marker_id),
            ),
        )
        .expect("page 2");
        assert_eq!(
            page2
                .markers
                .iter()
                .map(|m| m.marker_id.as_str())
                .collect::<Vec<_>>(),
            vec!["marker-2", "marker-3"]
        );
        let cursor2 = page2
            .next_cursor
            .clone()
            .expect("full page carries a cursor");

        let page3 = runtime_derived_stale_marker_list_for_project(
            Some(&project),
            true,
            marker_list_request_with_cursor(
                2,
                Some(cursor2.marked_at_ms),
                Some(&cursor2.marker_id),
            ),
        )
        .expect("page 3");
        assert_eq!(
            page3
                .markers
                .iter()
                .map(|m| m.marker_id.as_str())
                .collect::<Vec<_>>(),
            vec!["marker-4"]
        );
        assert!(page3.next_cursor.is_none());
        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn derived_marker_list_cursor_exact_multiple_page_then_empty_page_past_end() {
        // P3 #7: total row count an exact multiple of `limit` — the last
        // full page still (correctly) carries a cursor pointing past the
        // end, and requesting that cursor returns an empty page, not an
        // error or a repeat.
        let project = setup_marker_project("marker-list-cursor-exact-multiple");
        for (index, marked_at_ms) in [100_i64, 200, 300, 400].into_iter().enumerate() {
            seed_pending_marker(
                &project,
                &format!("marker-{index}"),
                "embedding",
                &format!("wiki/exact-{index}.md"),
                &format!("event-{index}"),
                Some("sha256:hash"),
                "hash",
                "commit",
                marked_at_ms,
            );
        }

        let page1 = runtime_derived_stale_marker_list_for_project(
            Some(&project),
            true,
            marker_list_request_with_cursor(2, None, None),
        )
        .expect("page 1");
        assert_eq!(page1.markers.len(), 2);
        let cursor1 = page1.next_cursor.clone().expect("page 1 full");

        let page2 = runtime_derived_stale_marker_list_for_project(
            Some(&project),
            true,
            marker_list_request_with_cursor(
                2,
                Some(cursor1.marked_at_ms),
                Some(&cursor1.marker_id),
            ),
        )
        .expect("page 2");
        assert_eq!(page2.markers.len(), 2);
        let cursor2 = page2
            .next_cursor
            .clone()
            .expect("page 2 full — total is an exact multiple of limit");

        let page3 = runtime_derived_stale_marker_list_for_project(
            Some(&project),
            true,
            marker_list_request_with_cursor(
                2,
                Some(cursor2.marked_at_ms),
                Some(&cursor2.marker_id),
            ),
        )
        .expect("page 3 (past end)");
        assert!(page3.markers.is_empty());
        assert!(page3.next_cursor.is_none());
        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn derived_marker_list_cursor_requires_both_fields_together() {
        let project = setup_marker_project("marker-list-cursor-invalid");
        let error = runtime_derived_stale_marker_list_for_project(
            Some(&project),
            true,
            marker_list_request_with_cursor(10, Some(100), None),
        )
        .expect_err("cursor with only one field must be rejected");
        assert!(error.starts_with("invalid-cursor"));
        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn derived_marker_list_cursor_rejects_marker_id_without_marked_at_ms() {
        // P3 #8: the reverse direction of the existing "only one field"
        // guard — sinceMarkerId alone, without sinceMarkedAtMs, is equally
        // ambiguous and must be rejected the same way.
        let project = setup_marker_project("marker-list-cursor-invalid-reverse");
        let error = runtime_derived_stale_marker_list_for_project(
            Some(&project),
            true,
            marker_list_request_with_cursor(10, None, Some("marker-1")),
        )
        .expect_err("marker id alone without marked_at_ms must be rejected");
        assert!(error.starts_with("invalid-cursor"));
        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn derived_stale_marker_validation_rejects_invalid_inputs() {
        let project = temp_project("derived-marker-validation");
        fs::create_dir_all(&project).expect("create temp project");
        runtime_job_create_for_project(Some(&project), true, create_request("job-1"), 100)
            .expect("create parent job");
        runtime_event_append_for_project(
            Some(&project),
            true,
            event_request(Some("job-1"), "event-1", "{}"),
            200,
        )
        .expect("append commit event");

        let mut missing_hash =
            marker_record_request("marker-no-hash", "embedding", "wiki/a.md", "event-1");
        missing_hash.input_hash = None;
        let missing_hash_error = runtime_derived_stale_marker_record_for_project(
            Some(&project),
            true,
            missing_hash,
            300,
        )
        .expect_err("non-delete marker requires input hash");
        assert!(missing_hash_error.starts_with("invalid-input-hash"));

        let mut duplicate_version = marker_record_request(
            "marker-duplicate-version",
            "embedding",
            "wiki/a.md",
            "event-1",
        );
        duplicate_version.base_version = "event-1".to_string();
        let duplicate_version_error = runtime_derived_stale_marker_record_for_project(
            Some(&project),
            true,
            duplicate_version,
            300,
        )
        .expect_err("baseVersion cannot duplicate sourceEventId");
        assert!(duplicate_version_error.starts_with("invalid-base-version"));

        let mut delete_marker =
            marker_record_request("marker-delete", "search", "wiki/a.md", "event-1");
        delete_marker.reason = "delete".to_string();
        delete_marker.input_hash = None;
        let deleted = runtime_derived_stale_marker_record_for_project(
            Some(&project),
            true,
            delete_marker,
            300,
        )
        .expect("delete marker allows null input hash");
        assert_eq!(deleted.reason, "delete");
        assert!(deleted.input_hash.is_none());

        let duplicate_id = marker_record_request("marker-delete", "search", "wiki/a.md", "event-1");
        let duplicate_error = runtime_derived_stale_marker_record_for_project(
            Some(&project),
            true,
            duplicate_id,
            300,
        )
        .expect_err("duplicate marker id rejected");
        assert!(duplicate_error.starts_with("derived-marker-record-insert-failed"));

        let mut delete_with_hash =
            marker_record_request("marker-delete-hash", "search", "wiki/a.md", "event-1");
        delete_with_hash.reason = "delete".to_string();
        let delete_hash_error = runtime_derived_stale_marker_record_for_project(
            Some(&project),
            true,
            delete_with_hash,
            300,
        )
        .expect_err("delete marker rejects input hash");
        assert!(delete_hash_error.starts_with("invalid-input-hash"));

        let invalid_layer =
            marker_record_request("marker-invalid-layer", "unknown", "wiki/a.md", "event-1");
        let layer_error = runtime_derived_stale_marker_record_for_project(
            Some(&project),
            true,
            invalid_layer,
            300,
        )
        .expect_err("invalid layer rejected");
        assert!(layer_error.starts_with("invalid-layer"));

        let missing_event =
            marker_record_request("marker-missing-event", "embedding", "wiki/a.md", "missing");
        let event_error = runtime_derived_stale_marker_record_for_project(
            Some(&project),
            true,
            missing_event,
            300,
        )
        .expect_err("missing source event rejected");
        assert!(event_error.starts_with("event-read-failed"));
        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn derived_stale_marker_migration_preserves_higher_version_and_enforces_fk() {
        let project = temp_project("derived-marker-migration");
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
                params![DERIVED_STALE_MARKERS_FAMILY, 2_i64, 42_i64],
            )
            .expect("seed higher migration");
        drop(connection);

        runtime_job_create_for_project(Some(&project), true, create_request("job-1"), 100)
            .expect("create parent job");
        runtime_event_append_for_project(
            Some(&project),
            true,
            event_request(Some("job-1"), "event-1", "{}"),
            200,
        )
        .expect("append event");
        runtime_derived_stale_marker_record_for_project(
            Some(&project),
            true,
            marker_record_request("marker-1", "embedding", "wiki/a.md", "event-1"),
            300,
        )
        .expect("record marker");

        assert_eq!(
            read_migration_family(&project, DERIVED_STALE_MARKERS_FAMILY),
            RuntimeDbMigrationStatus {
                family: DERIVED_STALE_MARKERS_FAMILY.to_string(),
                version: 2,
                applied_at_ms: 42,
            }
        );

        with_runtime_writer(|| {
            let connection = open_derived_stale_markers_runtime_locked(&project)?;
            let foreign_keys = connection
                .query_row("PRAGMA foreign_keys", [], |row| row.get::<_, i64>(0))
                .expect("read foreign key pragma");
            assert_eq!(foreign_keys, 1);
            let error = connection
                .execute(
                    "INSERT INTO runtime_derived_stale_markers (
                        marker_id,
                        layer,
                        affected_path,
                        input_hash,
                        base_version,
                        marked_at_ms,
                        reason,
                        source_event_id,
                        status,
                        updated_at_ms
                    ) VALUES (
                        'marker-orphan',
                        'embedding',
                        'wiki/a.md',
                        'sha256:def',
                        'event:1:missing',
                        1,
                        'commit',
                        'missing',
                        'pending',
                        1
                    )",
                    [],
                )
                .expect_err("orphan marker must fail");
            assert!(error.to_string().contains("FOREIGN KEY"));
            Ok(())
        })
        .expect("schema init succeeds");
        let _ = fs::remove_dir_all(project);
    }
}
