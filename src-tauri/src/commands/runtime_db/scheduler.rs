use crate::commands::file_sync::ProjectRootState;
use rusqlite::{params, Connection, OpenFlags};
use std::path::Path;

use super::*;
use std::thread;
use std::time::Duration;
use tauri::{AppHandle, Manager};

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

fn is_benign_lease_reclaim_race(err: &str) -> bool {
    BENIGN_LEASE_RECLAIM_RACE_PREFIXES
        .iter()
        .any(|prefix| err.starts_with(prefix))
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
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    use rusqlite::Connection;

    use std::fs;

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
}
