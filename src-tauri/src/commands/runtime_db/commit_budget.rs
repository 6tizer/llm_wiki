use crate::commands::file_sync::ProjectRootState;
use crate::panic_guard::run_guarded;
use rusqlite::{params, Connection, OpenFlags, Transaction};
use std::path::Path;
use tauri::State;

use super::*;
use uuid::Uuid;

/// Claim commit-path budget capacity for the currently-open project.
#[tauri::command]
pub fn runtime_commit_budget_claim(
    request: RuntimeCommitBudgetClaimRequest,
    root_state: State<'_, ProjectRootState>,
) -> Result<RuntimeCommitBudgetClaim, String> {
    run_guarded("runtime_commit_budget_claim", || {
        let runtime_enabled = resolve_work_runtime_enabled(read_work_runtime_flag_value());
        let project_root = root_state.get();
        let now = now_for_enabled_project(project_root.as_deref(), runtime_enabled)?;
        runtime_commit_budget_claim_for_project(
            project_root.as_deref(),
            runtime_enabled,
            request,
            now,
        )
    })
}

/// Release an active commit-path budget claim.
#[tauri::command]
pub fn runtime_commit_budget_release(
    request: RuntimeCommitBudgetReleaseRequest,
    root_state: State<'_, ProjectRootState>,
) -> Result<Vec<RuntimeResourceBudgetClaimRecord>, String> {
    run_guarded("runtime_commit_budget_release", || {
        let runtime_enabled = resolve_work_runtime_enabled(read_work_runtime_flag_value());
        let project_root = root_state.get();
        let now = now_for_enabled_project(project_root.as_deref(), runtime_enabled)?;
        runtime_commit_budget_release_for_project(
            project_root.as_deref(),
            runtime_enabled,
            request,
            now,
        )
    })
}

/// List commit budget rows and active claims for the currently-open project.
#[tauri::command]
pub fn runtime_commit_budget_list(
    root_state: State<'_, ProjectRootState>,
) -> Result<RuntimeCommitBudgetList, String> {
    run_guarded("runtime_commit_budget_list", || {
        runtime_commit_budget_list_for_project(
            root_state.get().as_deref(),
            resolve_work_runtime_enabled(read_work_runtime_flag_value()),
        )
    })
}

pub(crate) fn runtime_commit_budget_claim_for_project(
    project_root: Option<&Path>,
    enabled: bool,
    request: RuntimeCommitBudgetClaimRequest,
    now: i64,
) -> Result<RuntimeCommitBudgetClaim, String> {
    let project_root = require_enabled_project(project_root, enabled)?;
    let affected_path = normalize_affected_path(&request.affected_path)?;
    let ttl_ms = normalize_commit_budget_ttl(request.ttl_ms)?;
    let expires_at_ms = now
        .checked_add(ttl_ms)
        .ok_or_else(|| "invalid-ttl: commit budget expiry overflow".to_string())?;
    let holder = require_non_empty("invalid-holder", "holder", &request.holder)?.to_string();
    let claim_id = match request.claim_id {
        Some(claim_id) => require_non_empty("invalid-claim-id", "claimId", &claim_id)?.to_string(),
        None => Uuid::new_v4().to_string(),
    };

    with_runtime_writer(|| {
        let mut connection = open_resource_budget_runtime_locked(project_root)?;
        let tx = connection.transaction().map_err(tx_err)?;
        ensure_claim_id_available(&tx, &claim_id)?;
        if let Some(job_id) = request.job_id.as_deref() {
            ensure_job_exists(&tx, job_id)?;
        }
        expire_commit_budget_claims_tx(&tx, now)?;
        ensure_path_budget(&tx, &affected_path, now)?;
        ensure_commit_total_capacity(&tx, now)?;
        ensure_commit_path_available(&tx, &affected_path.resource_key, now)?;

        insert_commit_budget_claim_row(
            &tx,
            &claim_id,
            COMMIT_TOTAL_SCOPE,
            COMMIT_TOTAL_RESOURCE_KEY,
            COMMIT_TOTAL_RESOURCE_KEY,
            request.job_id.as_deref(),
            &holder,
            now,
            expires_at_ms,
        )?;
        insert_commit_budget_claim_row(
            &tx,
            &claim_id,
            COMMIT_PATH_SCOPE,
            &affected_path.resource_key,
            &affected_path.display_key,
            request.job_id.as_deref(),
            &holder,
            now,
            expires_at_ms,
        )?;

        let claims = read_claims_by_id_tx(&tx, &claim_id)?;
        ensure_claim_pair(&claims)?;
        tx.commit().map_err(tx_err)?;
        Ok(RuntimeCommitBudgetClaim {
            claim_id,
            resource_key: affected_path.resource_key,
            display_key: affected_path.display_key,
            expires_at_ms,
            claims,
        })
    })
}

fn runtime_commit_budget_release_for_project(
    project_root: Option<&Path>,
    enabled: bool,
    request: RuntimeCommitBudgetReleaseRequest,
    now: i64,
) -> Result<Vec<RuntimeResourceBudgetClaimRecord>, String> {
    let project_root = require_enabled_project(project_root, enabled)?;
    let claim_id = require_non_empty("invalid-claim-id", "claimId", &request.claim_id)?;
    with_runtime_writer(|| {
        let mut connection = open_resource_budget_runtime_locked(project_root)?;
        let tx = connection.transaction().map_err(tx_err)?;
        let active_claims = read_active_claims_by_id_tx(&tx, claim_id)?;
        if active_claims.is_empty() {
            return Err("claim-inactive: commit budget claim is not active".to_string());
        }
        ensure_claim_pair(&active_claims)?;
        let updated = update_claim_status(&tx, claim_id, RELEASED_CLAIM_STATUS, now)?;
        if updated != 2 {
            return Err(
                "claim-inconsistent: commit budget claim did not release exactly two rows"
                    .to_string(),
            );
        }
        let claims = read_claims_by_id_tx(&tx, claim_id)?;
        tx.commit().map_err(tx_err)?;
        Ok(claims)
    })
}

fn runtime_commit_budget_list_for_project(
    project_root: Option<&Path>,
    enabled: bool,
) -> Result<RuntimeCommitBudgetList, String> {
    if !enabled {
        return Ok(RuntimeCommitBudgetList {
            enabled: false,
            status: RuntimeDbHealthState::Disabled,
            budgets: Vec::new(),
            claims: Vec::new(),
        });
    }
    let Some(project_root) = project_root else {
        return Ok(RuntimeCommitBudgetList {
            enabled: true,
            status: RuntimeDbHealthState::NoProject,
            budgets: Vec::new(),
            claims: Vec::new(),
        });
    };
    let db_path = runtime_db_path(project_root);
    if !db_path.exists() {
        return Ok(RuntimeCommitBudgetList {
            enabled: true,
            status: RuntimeDbHealthState::Healthy,
            budgets: Vec::new(),
            claims: Vec::new(),
        });
    }
    let connection = Connection::open_with_flags(
        db_path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|err| format!("commit-budget-list-open-failed: {err}"))?;
    if !table_exists(&connection, "runtime_resource_budgets")?
        || !table_exists(&connection, "runtime_resource_budget_claims")?
    {
        return Ok(RuntimeCommitBudgetList {
            enabled: true,
            status: RuntimeDbHealthState::Healthy,
            budgets: Vec::new(),
            claims: Vec::new(),
        });
    }
    Ok(RuntimeCommitBudgetList {
        enabled: true,
        status: RuntimeDbHealthState::Healthy,
        budgets: read_resource_budgets(&connection)?,
        claims: read_active_resource_claims(&connection)?,
    })
}

#[allow(dead_code)]
fn runtime_commit_budget_expire_for_project(
    project_root: Option<&Path>,
    enabled: bool,
    claim_id: &str,
    now: i64,
) -> Result<Vec<RuntimeResourceBudgetClaimRecord>, String> {
    let project_root = require_enabled_project(project_root, enabled)?;
    let claim_id = require_non_empty("invalid-claim-id", "claimId", claim_id)?;
    with_runtime_writer(|| {
        let mut connection = open_resource_budget_runtime_locked(project_root)?;
        let tx = connection.transaction().map_err(tx_err)?;
        let active_claims = read_active_claims_by_id_tx(&tx, claim_id)?;
        if active_claims.is_empty() {
            return Err("claim-inactive: commit budget claim is not active".to_string());
        }
        ensure_claim_pair(&active_claims)?;
        if active_claims.iter().any(|claim| claim.expires_at_ms > now) {
            return Err("claim-not-expired: commit budget claim has not expired".to_string());
        }
        let updated = update_claim_status(&tx, claim_id, EXPIRED_CLAIM_STATUS, now)?;
        if updated != 2 {
            return Err(
                "claim-inconsistent: commit budget claim did not expire exactly two rows"
                    .to_string(),
            );
        }
        let claims = read_claims_by_id_tx(&tx, claim_id)?;
        tx.commit().map_err(tx_err)?;
        Ok(claims)
    })
}

fn normalize_commit_budget_ttl(ttl_ms: Option<i64>) -> Result<i64, String> {
    let ttl_ms = ttl_ms.unwrap_or(DEFAULT_LEASE_TTL_MS);
    if !(MIN_COMMIT_BUDGET_TTL_MS..=MAX_COMMIT_BUDGET_TTL_MS).contains(&ttl_ms) {
        Err(format!(
            "invalid-ttl: ttlMs must be between {MIN_COMMIT_BUDGET_TTL_MS} and {MAX_COMMIT_BUDGET_TTL_MS}"
        ))
    } else {
        Ok(ttl_ms)
    }
}

fn ensure_claim_id_available(tx: &Transaction<'_>, claim_id: &str) -> Result<(), String> {
    let existing = tx
        .query_row(
            "SELECT COUNT(*)
             FROM runtime_resource_budget_claims
             WHERE claim_id = ?1",
            [claim_id],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|err| format!("claim-id-check-failed: {err}"))?;
    if existing == 0 {
        Ok(())
    } else {
        Err("claim-id-conflict: commit budget claim id already exists".to_string())
    }
}

/// Flips any active commit budget claim (total or path scope) whose TTL has
/// lapsed to `expired`. Called at the start of every claim transaction so a
/// worker that crashed without releasing its claim cannot permanently pin
/// commit-total capacity or a commit-path slot — mirrors
/// `expire_profile_claims_tx` for the profile pool. This table only ever
/// holds commit budget rows (see the `scope` CHECK constraint), so no extra
/// scope filter is needed.
pub(crate) fn expire_commit_budget_claims_tx(tx: &Transaction<'_>, now: i64) -> Result<(), String> {
    expire_claims_by_ttl_tx(tx, "runtime_resource_budget_claims", "commit-budget", now)
}

fn ensure_commit_total_capacity(tx: &Transaction<'_>, now: i64) -> Result<(), String> {
    let capacity = tx
        .query_row(
            "SELECT capacity
             FROM runtime_resource_budgets
             WHERE scope = ?1 AND resource_key = ?2",
            params![COMMIT_TOTAL_SCOPE, COMMIT_TOTAL_RESOURCE_KEY],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|err| format!("commit-total-budget-read-failed: {err}"))?;
    let active_amount = tx
        .query_row(
            "SELECT COALESCE(SUM(amount), 0)
             FROM runtime_resource_budget_claims
             WHERE scope = ?1 AND resource_key = ?2 AND status = ?3 AND expires_at_ms > ?4",
            params![
                COMMIT_TOTAL_SCOPE,
                COMMIT_TOTAL_RESOURCE_KEY,
                ACTIVE_CLAIM_STATUS,
                now
            ],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|err| format!("commit-total-budget-sum-failed: {err}"))?;
    if active_amount + COMMIT_BUDGET_AMOUNT <= capacity {
        Ok(())
    } else {
        Err("commit-total-budget-exhausted: commit total budget is exhausted".to_string())
    }
}

fn ensure_commit_path_available(
    tx: &Transaction<'_>,
    resource_key: &str,
    now: i64,
) -> Result<(), String> {
    let active_count = tx
        .query_row(
            "SELECT COUNT(*)
             FROM runtime_resource_budget_claims
             WHERE scope = ?1 AND resource_key = ?2 AND status = ?3 AND expires_at_ms > ?4",
            params![COMMIT_PATH_SCOPE, resource_key, ACTIVE_CLAIM_STATUS, now],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|err| format!("commit-path-budget-check-failed: {err}"))?;
    if active_count == 0 {
        Ok(())
    } else {
        Err("commit-path-already-claimed: commit path budget is already claimed".to_string())
    }
}

fn insert_commit_budget_claim_row(
    tx: &Transaction<'_>,
    claim_id: &str,
    scope: &str,
    resource_key: &str,
    display_key: &str,
    job_id: Option<&str>,
    holder: &str,
    now: i64,
    expires_at_ms: i64,
) -> Result<(), String> {
    tx.execute(
        "INSERT INTO runtime_resource_budget_claims (
            claim_id,
            scope,
            resource_key,
            display_key,
            job_id,
            holder,
            amount,
            acquired_at_ms,
            expires_at_ms,
            status
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        params![
            claim_id,
            scope,
            resource_key,
            display_key,
            job_id,
            holder,
            COMMIT_BUDGET_AMOUNT,
            now,
            expires_at_ms,
            ACTIVE_CLAIM_STATUS
        ],
    )
    .map_err(|err| format!("commit-budget-claim-insert-failed: {err}"))?;
    Ok(())
}

fn ensure_claim_pair(claims: &[RuntimeResourceBudgetClaimRecord]) -> Result<(), String> {
    if claims.len() != 2 {
        return Err(
            "claim-inconsistent: commit budget claim must contain exactly two active rows"
                .to_string(),
        );
    }
    let has_total = claims.iter().any(|claim| {
        claim.scope == COMMIT_TOTAL_SCOPE && claim.resource_key == COMMIT_TOTAL_RESOURCE_KEY
    });
    let has_path = claims.iter().any(|claim| claim.scope == COMMIT_PATH_SCOPE);
    if has_total && has_path {
        Ok(())
    } else {
        Err("claim-inconsistent: commit budget claim must include total and path rows".to_string())
    }
}

fn update_claim_status(
    tx: &Transaction<'_>,
    claim_id: &str,
    status: &str,
    now: i64,
) -> Result<usize, String> {
    tx.execute(
        "UPDATE runtime_resource_budget_claims
         SET status = ?2,
             released_at_ms = CASE WHEN ?2 = 'released' THEN ?3 ELSE released_at_ms END
         WHERE claim_id = ?1 AND status = ?4",
        params![claim_id, status, now, ACTIVE_CLAIM_STATUS],
    )
    .map_err(|err| format!("commit-budget-claim-update-failed: {err}"))
}

fn read_resource_budgets(
    connection: &Connection,
) -> Result<Vec<RuntimeResourceBudgetRecord>, String> {
    let mut statement = connection
        .prepare(&resource_budget_select_sql(
            "ORDER BY scope ASC, resource_key ASC",
        ))
        .map_err(|err| format!("resource-budgets-read-prepare-failed: {err}"))?;
    let rows = statement
        .query_map([], map_resource_budget_row)
        .map_err(|err| format!("resource-budgets-read-failed: {err}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|err| format!("resource-budgets-read-failed: {err}"))
}

fn read_active_resource_claims(
    connection: &Connection,
) -> Result<Vec<RuntimeResourceBudgetClaimRecord>, String> {
    let mut statement = connection
        .prepare(&resource_claim_select_sql(
            "WHERE status = 'active' ORDER BY acquired_at_ms ASC, claim_id ASC, scope ASC",
        ))
        .map_err(|err| format!("resource-claims-read-prepare-failed: {err}"))?;
    let rows = statement
        .query_map([], map_resource_claim_row)
        .map_err(|err| format!("resource-claims-read-failed: {err}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|err| format!("resource-claims-read-failed: {err}"))
}

fn read_claims_by_id_tx(
    tx: &Transaction<'_>,
    claim_id: &str,
) -> Result<Vec<RuntimeResourceBudgetClaimRecord>, String> {
    let mut statement = tx
        .prepare(&resource_claim_select_sql(
            "WHERE claim_id = ?1 ORDER BY scope ASC, resource_key ASC",
        ))
        .map_err(|err| format!("resource-claims-read-prepare-failed: {err}"))?;
    let rows = statement
        .query_map([claim_id], map_resource_claim_row)
        .map_err(|err| format!("resource-claims-read-failed: {err}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|err| format!("resource-claims-read-failed: {err}"))
}

fn read_active_claims_by_id_tx(
    tx: &Transaction<'_>,
    claim_id: &str,
) -> Result<Vec<RuntimeResourceBudgetClaimRecord>, String> {
    let mut statement = tx
        .prepare(&resource_claim_select_sql(
            "WHERE claim_id = ?1 AND status = 'active'
             ORDER BY scope ASC, resource_key ASC",
        ))
        .map_err(|err| format!("resource-claims-read-prepare-failed: {err}"))?;
    let rows = statement
        .query_map([claim_id], map_resource_claim_row)
        .map_err(|err| format!("resource-claims-read-failed: {err}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|err| format!("resource-claims-read-failed: {err}"))
}

fn resource_budget_select_sql(suffix: &str) -> String {
    format!(
        "SELECT scope,
                resource_key,
                display_key,
                capacity,
                created_at_ms,
                updated_at_ms
         FROM runtime_resource_budgets {suffix}"
    )
}

fn resource_claim_select_sql(suffix: &str) -> String {
    format!(
        "SELECT claim_id,
                scope,
                resource_key,
                display_key,
                job_id,
                holder,
                amount,
                acquired_at_ms,
                expires_at_ms,
                released_at_ms,
                status
         FROM runtime_resource_budget_claims {suffix}"
    )
}

fn map_resource_budget_row(
    row: &rusqlite::Row<'_>,
) -> rusqlite::Result<RuntimeResourceBudgetRecord> {
    Ok(RuntimeResourceBudgetRecord {
        scope: row.get(0)?,
        resource_key: row.get(1)?,
        display_key: row.get(2)?,
        capacity: row.get(3)?,
        created_at_ms: row.get(4)?,
        updated_at_ms: row.get(5)?,
    })
}

fn map_resource_claim_row(
    row: &rusqlite::Row<'_>,
) -> rusqlite::Result<RuntimeResourceBudgetClaimRecord> {
    Ok(RuntimeResourceBudgetClaimRecord {
        claim_id: row.get(0)?,
        scope: row.get(1)?,
        resource_key: row.get(2)?,
        display_key: row.get(3)?,
        job_id: row.get(4)?,
        holder: row.get(5)?,
        amount: row.get(6)?,
        acquired_at_ms: row.get(7)?,
        expires_at_ms: row.get(8)?,
        released_at_ms: row.get(9)?,
        status: row.get(10)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    use rusqlite::{params, Connection};

    use std::fs;
    use std::sync::{Arc, Barrier};

    fn commit_release_request(claim_id: &str) -> RuntimeCommitBudgetReleaseRequest {
        RuntimeCommitBudgetReleaseRequest {
            claim_id: claim_id.to_string(),
        }
    }

    #[test]
    fn disabled_commit_budget_commands_do_not_touch_disk() {
        let project = temp_project("disabled-commit-budget");
        let runtime_dir = project.join(RUNTIME_DIR);
        fs::create_dir_all(&runtime_dir).expect("create runtime dir");
        let db_path = runtime_dir.join(RUNTIME_DB_FILE);
        fs::write(&db_path, b"not sqlite").expect("write damaged db");

        let claim_error = runtime_commit_budget_claim_for_project(
            Some(&project),
            false,
            commit_claim_request("wiki/a.md", "claim-1"),
            100,
        )
        .expect_err("disabled claim should fail");
        assert!(claim_error.starts_with("runtime-disabled"));
        let release_error = runtime_commit_budget_release_for_project(
            Some(&project),
            false,
            commit_release_request("claim-1"),
            100,
        )
        .expect_err("disabled release should fail");
        assert!(release_error.starts_with("runtime-disabled"));
        let list = runtime_commit_budget_list_for_project(Some(&project), false)
            .expect("disabled list succeeds");
        assert_eq!(list.status, RuntimeDbHealthState::Disabled);
        assert_eq!(fs::read(&db_path).expect("read damaged db"), b"not sqlite");
        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn enabled_commit_budget_commands_without_project_are_no_touch() {
        let claim_error = runtime_commit_budget_claim_for_project(
            None,
            true,
            commit_claim_request("wiki/a.md", "claim-1"),
            100,
        )
        .expect_err("no-project claim should fail");
        assert!(claim_error.starts_with("no-project"));
        let release_error = runtime_commit_budget_release_for_project(
            None,
            true,
            commit_release_request("claim-1"),
            100,
        )
        .expect_err("no-project release should fail");
        assert!(release_error.starts_with("no-project"));
        let list = runtime_commit_budget_list_for_project(None, true).expect("no-project list");
        assert_eq!(list.status, RuntimeDbHealthState::NoProject);
        assert!(list.budgets.is_empty());
        assert!(list.claims.is_empty());
    }

    #[test]
    fn commit_budget_list_on_pr3_only_db_returns_empty_without_migration() {
        let project = temp_project("commit-budget-list-pr3-db");
        fs::create_dir_all(&project).expect("create temp project");
        runtime_job_create_for_project(Some(&project), true, create_request("job-1"), 100)
            .expect("create PR3 runtime db");

        let list = runtime_commit_budget_list_for_project(Some(&project), true)
            .expect("list commit budgets");

        assert_eq!(list.status, RuntimeDbHealthState::Healthy);
        assert!(list.budgets.is_empty());
        assert!(list.claims.is_empty());
        let connection = Connection::open(runtime_db_path(&project)).expect("open runtime db");
        assert!(!table_exists(&connection, "runtime_resource_budgets").expect("check budgets"));
        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn enabled_commit_budget_list_on_damaged_runtime_db_returns_error() {
        let project = temp_project("commit-budget-list-damaged-db");
        let runtime_dir = project.join(RUNTIME_DIR);
        fs::create_dir_all(&runtime_dir).expect("create runtime dir");
        fs::write(runtime_dir.join(RUNTIME_DB_FILE), b"not sqlite").expect("write damaged db");

        let error = runtime_commit_budget_list_for_project(Some(&project), true)
            .expect_err("enabled list should report damaged db");

        assert!(
            error.contains("commit-budget-list-open-failed")
                || error.contains("table-exists-check-failed")
        );
        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn commit_budget_claim_upgrades_pr2_db_and_rejects_missing_job_id() {
        let project = temp_project("commit-budget-pr2-upgrade");
        fs::create_dir_all(&project).expect("create temp project");
        runtime_db_health_for_project(Some(&project), true).expect("create PR2 runtime db");

        let mut request = commit_claim_request("wiki/a.md", "claim-1");
        request.job_id = Some("missing-job".to_string());
        let error = runtime_commit_budget_claim_for_project(Some(&project), true, request, 100)
            .expect_err("missing job should fail");

        assert!(error.starts_with("job-not-found"));
        assert_eq!(
            read_migration_family(&project, JOBS_FAMILY).version,
            JOBS_VERSION
        );
        assert_eq!(
            read_migration_family(&project, LEASES_FAMILY).version,
            LEASES_VERSION
        );
        assert_eq!(
            read_migration_family(&project, RESOURCE_BUDGETS_FAMILY).version,
            RESOURCE_BUDGETS_VERSION
        );
        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn commit_budget_claim_release_and_list_happy_path() {
        let project = temp_project("commit-budget-happy");
        fs::create_dir_all(&project).expect("create temp project");

        let claim = runtime_commit_budget_claim_for_project(
            Some(&project),
            true,
            commit_claim_request("Wiki/A.md", "claim-1"),
            100,
        )
        .expect("claim commit budget");

        assert_eq!(claim.claim_id, "claim-1");
        assert_eq!(claim.display_key, "Wiki/A.md");
        assert_eq!(claim.resource_key, "wiki/a.md");
        assert_eq!(claim.expires_at_ms, 100 + DEFAULT_LEASE_TTL_MS);
        assert_eq!(claim.claims.len(), 2);
        assert!(claim
            .claims
            .iter()
            .all(|row| row.status == ACTIVE_CLAIM_STATUS));

        let list = runtime_commit_budget_list_for_project(Some(&project), true)
            .expect("list commit budgets");
        assert_eq!(list.budgets.len(), 2);
        assert_eq!(list.claims.len(), 2);

        let released = runtime_commit_budget_release_for_project(
            Some(&project),
            true,
            commit_release_request("claim-1"),
            200,
        )
        .expect("release commit budget");
        assert_eq!(released.len(), 2);
        assert!(released
            .iter()
            .all(|row| row.status == RELEASED_CLAIM_STATUS));
        assert!(released.iter().all(|row| row.released_at_ms == Some(200)));

        let released_again = runtime_commit_budget_release_for_project(
            Some(&project),
            true,
            commit_release_request("claim-1"),
            300,
        )
        .expect_err("repeated release is inactive");
        assert!(released_again.starts_with("claim-inactive"));

        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn commit_budget_claim_with_existing_job_id_persists_job_id() {
        let project = temp_project("commit-budget-job-id");
        fs::create_dir_all(&project).expect("create temp project");
        runtime_job_create_for_project(Some(&project), true, create_request("job-1"), 100)
            .expect("create job");
        let mut request = commit_claim_request("wiki/a.md", "claim-1");
        request.job_id = Some("job-1".to_string());

        let claim = runtime_commit_budget_claim_for_project(Some(&project), true, request, 200)
            .expect("claim with job id");

        assert_eq!(claim.claims.len(), 2);
        assert!(claim
            .claims
            .iter()
            .all(|row| row.job_id.as_deref() == Some("job-1")));
        let list = runtime_commit_budget_list_for_project(Some(&project), true).expect("list");
        assert!(list
            .claims
            .iter()
            .all(|row| row.job_id.as_deref() == Some("job-1")));
        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn commit_budget_rejects_duplicate_claim_id_and_same_path() {
        let project = temp_project("commit-budget-duplicates");
        fs::create_dir_all(&project).expect("create temp project");
        runtime_commit_budget_claim_for_project(
            Some(&project),
            true,
            commit_claim_request("wiki/a.md", "claim-1"),
            100,
        )
        .expect("claim first path");

        let duplicate_id = runtime_commit_budget_claim_for_project(
            Some(&project),
            true,
            commit_claim_request("wiki/b.md", "claim-1"),
            100,
        )
        .expect_err("duplicate claim id is rejected");
        assert!(duplicate_id.starts_with("claim-id-conflict"));

        let duplicate_path = runtime_commit_budget_claim_for_project(
            Some(&project),
            true,
            commit_claim_request("WIKI/A.MD", "claim-2"),
            100,
        )
        .expect_err("same path identity is rejected");
        assert!(duplicate_path.starts_with("commit-path-already-claimed"));
        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn commit_budget_rejects_empty_claim_id_without_mutation() {
        let project = temp_project("commit-budget-empty-claim-id");
        fs::create_dir_all(&project).expect("create temp project");
        let mut request = commit_claim_request("wiki/a.md", "   ");
        request.claim_id = Some("   ".to_string());

        let error = runtime_commit_budget_claim_for_project(Some(&project), true, request, 100)
            .expect_err("empty claim id is rejected");

        assert!(error.starts_with("invalid-claim-id"));
        let list = runtime_commit_budget_list_for_project(Some(&project), true).expect("list");
        assert!(list.budgets.is_empty());
        assert!(list.claims.is_empty());
        assert!(!runtime_db_path(&project).exists());
        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn commit_budget_unique_index_rejects_duplicate_active_path_claim() {
        let project = temp_project("commit-budget-unique-index");
        fs::create_dir_all(&project).expect("create temp project");
        with_runtime_writer(|| {
            let connection = open_resource_budget_runtime_locked(&project)?;
            connection
                .execute(
                    "INSERT OR IGNORE INTO runtime_resource_budgets (
                        scope,
                        resource_key,
                        display_key,
                        capacity,
                        created_at_ms,
                        updated_at_ms
                    ) VALUES ('commit-path', 'wiki/a.md', 'wiki/a.md', 1, 100, 100)",
                    [],
                )
                .expect("insert path budget");
            connection
                .execute(
                    "INSERT INTO runtime_resource_budget_claims (
                        claim_id,
                        scope,
                        resource_key,
                        display_key,
                        holder,
                        amount,
                        acquired_at_ms,
                        expires_at_ms,
                        status
                    ) VALUES ('claim-1', 'commit-path', 'wiki/a.md', 'wiki/a.md', 'tester:a', 1, 100, 200, 'active')",
                    [],
                )
                .expect("insert first active path claim");
            let error = connection
                .execute(
                    "INSERT INTO runtime_resource_budget_claims (
                        claim_id,
                        scope,
                        resource_key,
                        display_key,
                        holder,
                        amount,
                        acquired_at_ms,
                        expires_at_ms,
                        status
                    ) VALUES ('claim-2', 'commit-path', 'wiki/a.md', 'wiki/a.md', 'tester:b', 1, 100, 200, 'active')",
                    [],
                )
                .expect_err("second active path claim must fail");
            assert!(error.to_string().contains("UNIQUE"));
            Ok(())
        })
        .expect("unique index test succeeds");
        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn commit_budget_total_capacity_rolls_back_path_claim() {
        let project = temp_project("commit-budget-total-capacity");
        fs::create_dir_all(&project).expect("create temp project");
        runtime_commit_budget_claim_for_project(
            Some(&project),
            true,
            commit_claim_request("wiki/a.md", "claim-1"),
            100,
        )
        .expect("claim first path");
        runtime_commit_budget_claim_for_project(
            Some(&project),
            true,
            commit_claim_request("wiki/b.md", "claim-2"),
            100,
        )
        .expect("claim second path");

        let exhausted = runtime_commit_budget_claim_for_project(
            Some(&project),
            true,
            commit_claim_request("wiki/c.md", "claim-3"),
            100,
        )
        .expect_err("total capacity exhausted");

        assert!(exhausted.starts_with("commit-total-budget-exhausted"));
        let list = runtime_commit_budget_list_for_project(Some(&project), true)
            .expect("list commit budgets");
        assert_eq!(list.claims.len(), 4);
        assert!(!list
            .claims
            .iter()
            .any(|claim| claim.resource_key == "wiki/c.md"));
        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn commit_budget_expire_releases_capacity_after_ttl() {
        let project = temp_project("commit-budget-expire");
        fs::create_dir_all(&project).expect("create temp project");
        runtime_commit_budget_claim_for_project(
            Some(&project),
            true,
            commit_claim_request("wiki/a.md", "claim-1"),
            100,
        )
        .expect("claim path");

        let early = runtime_commit_budget_expire_for_project(
            Some(&project),
            true,
            "claim-1",
            100 + DEFAULT_LEASE_TTL_MS - 1,
        )
        .expect_err("early expire is rejected");
        assert!(early.starts_with("claim-not-expired"));

        let expired = runtime_commit_budget_expire_for_project(
            Some(&project),
            true,
            "claim-1",
            100 + DEFAULT_LEASE_TTL_MS,
        )
        .expect("expire claim");
        assert_eq!(expired.len(), 2);
        assert!(expired.iter().all(|row| row.status == EXPIRED_CLAIM_STATUS));
        assert!(expired.iter().all(|row| row.released_at_ms.is_none()));

        let release_expired = runtime_commit_budget_release_for_project(
            Some(&project),
            true,
            commit_release_request("claim-1"),
            300,
        )
        .expect_err("expired claim cannot be released");
        assert!(release_expired.starts_with("claim-inactive"));

        let reclaimed = runtime_commit_budget_claim_for_project(
            Some(&project),
            true,
            commit_claim_request("wiki/a.md", "claim-2"),
            300,
        )
        .expect("reclaim expired path");
        assert_eq!(reclaimed.resource_key, "wiki/a.md");
        let _ = fs::remove_dir_all(project);
    }

    /// Regression coverage for the crash-orphan deadlock: a worker that dies
    /// after claiming (without ever calling the dead-code manual expire path
    /// or releasing) must not permanently pin the commit path budget. The
    /// claim path itself must self-heal purely by TTL, with no manual expire
    /// call anywhere in this test.
    #[test]
    fn commit_budget_path_self_heals_after_ttl_without_manual_expire() {
        let project = temp_project("commit-budget-path-self-heal");
        fs::create_dir_all(&project).expect("create temp project");
        runtime_commit_budget_claim_for_project(
            Some(&project),
            true,
            commit_claim_request("wiki/a.md", "claim-1"),
            100,
        )
        .expect("claim path");

        let still_locked = runtime_commit_budget_claim_for_project(
            Some(&project),
            true,
            commit_claim_request("wiki/a.md", "claim-2"),
            100 + DEFAULT_LEASE_TTL_MS - 1,
        )
        .expect_err("orphaned claim still blocks the path before ttl elapses");
        assert!(still_locked.starts_with("commit-path-already-claimed"));

        let healed = runtime_commit_budget_claim_for_project(
            Some(&project),
            true,
            commit_claim_request("wiki/a.md", "claim-2"),
            100 + DEFAULT_LEASE_TTL_MS,
        )
        .expect("orphaned claim self-heals once its ttl elapses, with no manual expire call");
        assert_eq!(healed.resource_key, "wiki/a.md");
        assert!(healed
            .claims
            .iter()
            .all(|claim| claim.claim_id == "claim-2"));

        // The stale claim-1 rows must be flipped to 'expired' in place (not
        // merely filtered at read time), otherwise the commit-path unique
        // index would have rejected the claim-2 insert above.
        let list = runtime_commit_budget_list_for_project(Some(&project), true).expect("list");
        assert_eq!(list.claims.len(), 2);
        assert!(list.claims.iter().all(|claim| claim.claim_id == "claim-2"));

        let connection = Connection::open(runtime_db_path(&project)).expect("open runtime db");
        let expired_claim1_rows: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM runtime_resource_budget_claims
                 WHERE claim_id = 'claim-1' AND status = 'expired'",
                [],
                |row| row.get(0),
            )
            .expect("count expired claim-1 rows");
        assert_eq!(expired_claim1_rows, 2);
        let _ = fs::remove_dir_all(project);
    }

    /// Same self-heal requirement as above, but for the global commit-total
    /// capacity counter rather than a single path: two crash-orphaned claims
    /// pin `DEFAULT_COMMIT_TOTAL_CAPACITY` (2) forever unless the SUM query
    /// also excludes expired rows. No manual expire call is made.
    #[test]
    fn commit_budget_total_capacity_self_heals_after_ttl_without_manual_expire() {
        let project = temp_project("commit-budget-total-self-heal");
        fs::create_dir_all(&project).expect("create temp project");
        runtime_commit_budget_claim_for_project(
            Some(&project),
            true,
            commit_claim_request("wiki/a.md", "claim-1"),
            100,
        )
        .expect("claim first path");
        runtime_commit_budget_claim_for_project(
            Some(&project),
            true,
            commit_claim_request("wiki/b.md", "claim-2"),
            100,
        )
        .expect("claim second path");

        let exhausted = runtime_commit_budget_claim_for_project(
            Some(&project),
            true,
            commit_claim_request("wiki/c.md", "claim-3"),
            100 + DEFAULT_LEASE_TTL_MS - 1,
        )
        .expect_err("total capacity still pinned by orphans before ttl elapses");
        assert!(exhausted.starts_with("commit-total-budget-exhausted"));

        let healed = runtime_commit_budget_claim_for_project(
            Some(&project),
            true,
            commit_claim_request("wiki/c.md", "claim-3"),
            100 + DEFAULT_LEASE_TTL_MS,
        )
        .expect("total capacity self-heals once orphans' ttl elapses, with no manual expire call");
        assert_eq!(healed.resource_key, "wiki/c.md");
        let _ = fs::remove_dir_all(project);
    }

    /// Guards against a crash between the two paired inserts in
    /// `runtime_commit_budget_claim_for_project`: only one of the two rows
    /// (commit-path here) ever made it to disk for the dead claim. The bulk
    /// expire sweep operates row-by-row and must clean up this unpaired
    /// orphan too, without `ensure_claim_pair` choking on it, so a fresh,
    /// well-formed pair can be claimed once the ttl elapses.
    #[test]
    fn commit_budget_single_row_orphan_self_heals_after_ttl() {
        let project = temp_project("commit-budget-single-row-orphan");
        fs::create_dir_all(&project).expect("create temp project");
        with_runtime_writer(|| {
            let connection = open_resource_budget_runtime_locked(&project)?;
            connection
                .execute(
                    "INSERT OR IGNORE INTO runtime_resource_budgets (
                        scope, resource_key, display_key, capacity, created_at_ms, updated_at_ms
                    ) VALUES ('commit-path', 'wiki/a.md', 'wiki/a.md', 1, 100, 100)",
                    [],
                )
                .expect("seed path budget");
            connection
                .execute(
                    "INSERT INTO runtime_resource_budget_claims (
                        claim_id, scope, resource_key, display_key, holder, amount,
                        acquired_at_ms, expires_at_ms, status
                    ) VALUES ('claim-orphan', 'commit-path', 'wiki/a.md', 'wiki/a.md',
                              'tester:crashed', 1, ?1, ?2, 'active')",
                    params![100i64, 100i64 + DEFAULT_LEASE_TTL_MS],
                )
                .expect("seed lone path-scope orphan row (no matching commit-total row)");
            Ok(())
        })
        .expect("seed single-row orphan");

        let still_locked = runtime_commit_budget_claim_for_project(
            Some(&project),
            true,
            commit_claim_request("wiki/a.md", "claim-2"),
            100 + DEFAULT_LEASE_TTL_MS - 1,
        )
        .expect_err("lone orphan row still blocks the path before ttl elapses");
        assert!(still_locked.starts_with("commit-path-already-claimed"));

        let healed = runtime_commit_budget_claim_for_project(
            Some(&project),
            true,
            commit_claim_request("wiki/a.md", "claim-2"),
            100 + DEFAULT_LEASE_TTL_MS,
        )
        .expect("single-row orphan self-heals once its ttl elapses");
        assert_eq!(healed.claims.len(), 2);
        assert!(healed
            .claims
            .iter()
            .all(|claim| claim.claim_id == "claim-2"));
        let _ = fs::remove_dir_all(project);
    }

    /// Two real threads race to claim the same resource key at the instant
    /// its orphaned predecessor crosses its ttl. `RUNTIME_DB_WRITE_LOCK` (a
    /// process-level mutex) serializes the claim transactions, so this test
    /// exercises business-layer serialized contention rather than genuine
    /// concurrent arbitration at the SQLite unique-index layer: the second
    /// thread blocks on the mutex and then observes the ordinary
    /// commit-path-already-claimed rejection. Exactly one thread must win;
    /// the loser must get a clean, typed rejection (not a panic, not a
    /// deadlock, not a double-active row).
    #[test]
    fn commit_budget_concurrent_claims_on_expired_path_only_one_succeeds() {
        let project = temp_project("commit-budget-concurrent-expired");
        fs::create_dir_all(&project).expect("create temp project");
        runtime_commit_budget_claim_for_project(
            Some(&project),
            true,
            commit_claim_request("wiki/a.md", "claim-orphan"),
            100,
        )
        .expect("seed orphaned claim");

        let now = 100 + DEFAULT_LEASE_TTL_MS;
        let shared_project = Arc::new(project.clone());
        let barrier = Arc::new(Barrier::new(2));
        let claim_ids = ["claim-a", "claim-b"];
        let handles = claim_ids
            .into_iter()
            .map(|claim_id| {
                let project = Arc::clone(&shared_project);
                let barrier = Arc::clone(&barrier);
                std::thread::spawn(move || {
                    barrier.wait();
                    runtime_commit_budget_claim_for_project(
                        Some(project.as_path()),
                        true,
                        commit_claim_request("wiki/a.md", claim_id),
                        now,
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
            .all(|error| error.starts_with("commit-path-already-claimed")));

        let list = runtime_commit_budget_list_for_project(Some(&project), true).expect("list");
        assert_eq!(
            list.claims
                .iter()
                .filter(
                    |claim| claim.scope == COMMIT_PATH_SCOPE && claim.resource_key == "wiki/a.md"
                )
                .count(),
            1,
            "exactly one active path claim must remain, never zero or two"
        );
        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn commit_budget_release_and_expire_reject_inconsistent_claim_pairs() {
        let project = temp_project("commit-budget-inconsistent");
        fs::create_dir_all(&project).expect("create temp project");
        runtime_commit_budget_claim_for_project(
            Some(&project),
            true,
            commit_claim_request("wiki/a.md", "claim-1"),
            100,
        )
        .expect("claim path");
        let connection = Connection::open(runtime_db_path(&project)).expect("open runtime db");
        connection
            .execute(
                "UPDATE runtime_resource_budget_claims
                 SET status = 'released'
                 WHERE claim_id = 'claim-1' AND scope = 'commit-path'",
                [],
            )
            .expect("damage claim pair");
        drop(connection);

        let release_error = runtime_commit_budget_release_for_project(
            Some(&project),
            true,
            commit_release_request("claim-1"),
            200,
        )
        .expect_err("inconsistent release is rejected");
        assert!(release_error.starts_with("claim-inconsistent"));

        let expire_error =
            runtime_commit_budget_expire_for_project(Some(&project), true, "claim-1", 500_000)
                .expect_err("inconsistent expire is rejected");
        assert!(expire_error.starts_with("claim-inconsistent"));
        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn commit_budget_release_rejects_extra_active_claim_rows() {
        let project = temp_project("commit-budget-extra-active-row");
        fs::create_dir_all(&project).expect("create temp project");
        runtime_commit_budget_claim_for_project(
            Some(&project),
            true,
            commit_claim_request("wiki/a.md", "claim-1"),
            100,
        )
        .expect("claim path");
        let connection = Connection::open(runtime_db_path(&project)).expect("open runtime db");
        connection
            .execute(
                "INSERT OR IGNORE INTO runtime_resource_budgets (
                    scope,
                    resource_key,
                    display_key,
                    capacity,
                    created_at_ms,
                    updated_at_ms
                ) VALUES ('commit-path', 'wiki/extra.md', 'wiki/extra.md', 1, 100, 100)",
                [],
            )
            .expect("insert extra budget");
        connection
            .execute(
                "INSERT INTO runtime_resource_budget_claims (
                    claim_id,
                    scope,
                    resource_key,
                    display_key,
                    holder,
                    amount,
                    acquired_at_ms,
                    expires_at_ms,
                    status
                ) VALUES ('claim-1', 'commit-path', 'wiki/extra.md', 'wiki/extra.md', 'tester:x', 1, 100, 200, 'active')",
                [],
            )
            .expect("insert extra active row");
        drop(connection);

        let error = runtime_commit_budget_release_for_project(
            Some(&project),
            true,
            commit_release_request("claim-1"),
            200,
        )
        .expect_err("extra active row is inconsistent");

        assert!(error.starts_with("claim-inconsistent"));
        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn commit_budget_ttl_bounds_are_enforced() {
        let project = temp_project("commit-budget-ttl");
        fs::create_dir_all(&project).expect("create temp project");

        for (claim_id, ttl_ms) in [("claim-low", Some(0)), ("claim-high", Some(1_200_001))] {
            let mut request = commit_claim_request("wiki/a.md", claim_id);
            request.ttl_ms = ttl_ms;
            let error = runtime_commit_budget_claim_for_project(Some(&project), true, request, 100)
                .expect_err("invalid ttl is rejected");
            assert!(error.starts_with("invalid-ttl"));
        }

        let mut overflow = commit_claim_request("wiki/a.md", "claim-overflow");
        overflow.ttl_ms = Some(MAX_COMMIT_BUDGET_TTL_MS);
        let error =
            runtime_commit_budget_claim_for_project(Some(&project), true, overflow, i64::MAX)
                .expect_err("ttl overflow is rejected");
        assert!(error.starts_with("invalid-ttl"));
        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn commit_budget_ttl_min_and_max_bounds_are_allowed() {
        let project = temp_project("commit-budget-ttl-bounds");
        fs::create_dir_all(&project).expect("create temp project");
        let mut min_request = commit_claim_request("wiki/min.md", "claim-min");
        min_request.ttl_ms = Some(MIN_COMMIT_BUDGET_TTL_MS);
        let min_claim =
            runtime_commit_budget_claim_for_project(Some(&project), true, min_request, 100)
                .expect("min ttl is allowed");
        assert_eq!(min_claim.expires_at_ms, 100 + MIN_COMMIT_BUDGET_TTL_MS);

        let mut max_request = commit_claim_request("wiki/max.md", "claim-max");
        max_request.ttl_ms = Some(MAX_COMMIT_BUDGET_TTL_MS);
        let max_claim =
            runtime_commit_budget_claim_for_project(Some(&project), true, max_request, 100)
                .expect("max ttl is allowed");
        assert_eq!(max_claim.expires_at_ms, 100 + MAX_COMMIT_BUDGET_TTL_MS);
        let _ = fs::remove_dir_all(project);
    }
}
