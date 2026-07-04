use rusqlite::{params, OptionalExtension, Transaction};

use super::*;

/// Shared by `expire_profile_claims_tx` and `expire_commit_budget_claims_tx`:
/// flips any active claim row in `table` whose TTL has lapsed to `expired`.
/// `table` is always one of our own hardcoded table names, never user input.
pub(crate) fn expire_claims_by_ttl_tx(
    tx: &Transaction<'_>,
    table: &str,
    error_label: &str,
    now: i64,
) -> Result<(), String> {
    tx.execute(
        &format!("UPDATE {table} SET status = ?2 WHERE status = ?1 AND expires_at_ms <= ?3"),
        params![ACTIVE_CLAIM_STATUS, EXPIRED_CLAIM_STATUS, now],
    )
    .map_err(|err| format!("{error_label}-expire-claims-failed: {err}"))?;
    Ok(())
}

pub(crate) fn ensure_active_running_lease(
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

pub(crate) fn release_lease(
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
