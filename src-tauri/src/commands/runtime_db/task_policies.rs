use crate::commands::file_sync::ProjectRootState;
use crate::panic_guard::run_guarded;
use rusqlite::{params, Connection, OpenFlags, OptionalExtension, Transaction};
use std::path::Path;
use tauri::State;

use super::*;

/// List all task-family fallback policies for the currently-open project.
#[tauri::command]
pub fn runtime_task_policy_list(
    root_state: State<'_, ProjectRootState>,
) -> Result<RuntimeTaskPolicyList, String> {
    run_guarded("runtime_task_policy_list", || {
        runtime_task_policy_list_for_project(
            root_state.get().as_deref(),
            resolve_work_runtime_enabled(read_work_runtime_flag_value()),
        )
    })
}

/// Upsert one task-family fallback policy for the currently-open project.
#[tauri::command]
pub fn runtime_task_policy_set(
    request: RuntimeTaskPolicySetRequest,
    root_state: State<'_, ProjectRootState>,
) -> Result<RuntimeTaskPolicySetResult, String> {
    run_guarded("runtime_task_policy_set", || {
        let runtime_enabled = resolve_work_runtime_enabled(read_work_runtime_flag_value());
        let project_root = root_state.get();
        let now = now_for_enabled_project(project_root.as_deref(), runtime_enabled)?;
        runtime_task_policy_set_for_project(project_root.as_deref(), runtime_enabled, request, now)
    })
}

pub(crate) fn runtime_task_policy_list_for_project(
    project_root: Option<&Path>,
    enabled: bool,
) -> Result<RuntimeTaskPolicyList, String> {
    if !enabled {
        return Ok(RuntimeTaskPolicyList {
            enabled: false,
            status: RuntimeDbHealthState::Disabled,
            policies: Vec::new(),
        });
    }
    let Some(project_root) = project_root else {
        return Ok(RuntimeTaskPolicyList {
            enabled: true,
            status: RuntimeDbHealthState::NoProject,
            policies: Vec::new(),
        });
    };
    let db_path = runtime_db_path(project_root);
    if !db_path.exists() {
        return Ok(RuntimeTaskPolicyList {
            enabled: true,
            status: RuntimeDbHealthState::Healthy,
            policies: Vec::new(),
        });
    }
    let connection = Connection::open_with_flags(
        db_path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|err| format!("task-policy-list-open-failed: {err}"))?;
    if !table_exists(&connection, "runtime_task_family_policies")? {
        // Older DBs get this schema on the next claim/release/write path that opens the runtime DB.
        return Ok(RuntimeTaskPolicyList {
            enabled: true,
            status: RuntimeDbHealthState::Healthy,
            policies: Vec::new(),
        });
    }
    Ok(RuntimeTaskPolicyList {
        enabled: true,
        status: RuntimeDbHealthState::Healthy,
        policies: read_task_family_policies(&connection)?,
    })
}

pub(crate) fn runtime_task_policy_set_for_project(
    project_root: Option<&Path>,
    enabled: bool,
    request: RuntimeTaskPolicySetRequest,
    now: i64,
) -> Result<RuntimeTaskPolicySetResult, String> {
    let project_root = require_enabled_project(project_root, enabled)?;
    let task_family = normalize_profile_text(
        "invalid-task-family",
        "taskFamily",
        &request.task_family,
        MAX_PROFILE_TASK_FAMILY_BYTES,
    )?;

    with_runtime_writer(|| {
        let mut connection = open_profile_pool_runtime_locked(project_root)?;
        let tx = connection.transaction().map_err(tx_err)?;
        let (profile_order, removed_profile_ids) =
            normalize_policy_profile_order_tx(&tx, request.profile_order)?;
        let profile_order_json = serde_json::to_string(&profile_order)
            .map_err(|err| format!("task-policy-profile-order-serialize-failed: {err}"))?;
        if profile_order_json.len() > MAX_TASK_POLICY_PROFILE_ORDER_BYTES {
            return Err(format!(
                "invalid-profile-order: profileOrder must be at most {MAX_TASK_POLICY_PROFILE_ORDER_BYTES} bytes"
            ));
        }
        tx.execute(
            "INSERT INTO runtime_task_family_policies (
                task_family,
                profile_order,
                auto_failover,
                updated_at_ms
             ) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(task_family) DO UPDATE SET
                profile_order = excluded.profile_order,
                auto_failover = excluded.auto_failover,
                updated_at_ms = excluded.updated_at_ms",
            params![
                task_family,
                profile_order_json,
                if request.auto_failover.unwrap_or(true) {
                    1
                } else {
                    0
                },
                now
            ],
        )
        .map_err(|err| format!("task-policy-upsert-failed: {err}"))?;
        let policy = read_task_family_policy_tx(&tx, &task_family)?
            .ok_or_else(|| "task-policy-read-after-write-failed: policy missing".to_string())?;
        tx.commit().map_err(tx_err)?;
        Ok(RuntimeTaskPolicySetResult {
            policy,
            removed_profile_ids,
        })
    })
}

pub(crate) fn read_task_family_policy_tx(
    tx: &Transaction<'_>,
    task_family: &str,
) -> Result<Option<RuntimeTaskFamilyPolicyRecord>, String> {
    let row = tx
        .query_row(
            &task_family_policy_select_sql("WHERE task_family = ?1"),
            [task_family],
            map_task_family_policy_raw_row,
        )
        .optional()
        .map_err(|err| format!("task-policy-read-failed: {err}"))?;
    Ok(row.map(parse_task_family_policy_row).transpose()?.flatten())
}

fn normalize_policy_profile_order_tx(
    tx: &Transaction<'_>,
    raw_order: Vec<String>,
) -> Result<(Vec<String>, Vec<String>), String> {
    let visible_profiles = read_visible_profiles_tx(tx)?;
    let visible_profile_ids = visible_profiles
        .iter()
        .map(|profile| profile.profile_id.as_str())
        .collect::<Vec<_>>();
    let mut profile_order = Vec::new();
    let mut removed_profile_ids = Vec::new();
    for raw in raw_order {
        let trimmed = raw.trim().to_string();
        let Ok(profile_id) = normalize_profile_text(
            "invalid-profile-id",
            "profileOrder",
            &trimmed,
            MAX_PROFILE_ID_BYTES,
        ) else {
            if !trimmed.is_empty() && !removed_profile_ids.contains(&trimmed) {
                removed_profile_ids.push(trimmed);
            }
            continue;
        };
        if profile_order.contains(&profile_id) {
            continue;
        }
        if visible_profile_ids.contains(&profile_id.as_str()) {
            profile_order.push(profile_id);
        } else if !removed_profile_ids.contains(&profile_id) {
            removed_profile_ids.push(profile_id);
        }
    }
    Ok((profile_order, removed_profile_ids))
}

fn read_task_family_policies(
    connection: &Connection,
) -> Result<Vec<RuntimeTaskFamilyPolicyRecord>, String> {
    let mut statement = connection
        .prepare(&task_family_policy_select_sql("ORDER BY task_family ASC"))
        .map_err(|err| format!("task-policy-list-prepare-failed: {err}"))?;
    let rows = statement
        .query_map([], map_task_family_policy_raw_row)
        .map_err(|err| format!("task-policy-list-failed: {err}"))?;
    let mut policies = Vec::new();
    for row in rows {
        let raw = row.map_err(|err| format!("task-policy-list-failed: {err}"))?;
        if let Some(policy) = parse_task_family_policy_row(raw)? {
            policies.push(policy);
        }
    }
    Ok(policies)
}

fn task_family_policy_select_sql(suffix: &str) -> String {
    format!(
        "SELECT task_family,
                profile_order,
                auto_failover,
                updated_at_ms
         FROM runtime_task_family_policies {suffix}"
    )
}

struct RawTaskFamilyPolicyRow {
    task_family: String,
    profile_order_json: String,
    auto_failover: bool,
    updated_at_ms: i64,
}

fn map_task_family_policy_raw_row(
    row: &rusqlite::Row<'_>,
) -> rusqlite::Result<RawTaskFamilyPolicyRow> {
    Ok(RawTaskFamilyPolicyRow {
        task_family: row.get(0)?,
        profile_order_json: row.get(1)?,
        auto_failover: row.get::<_, i64>(2)? != 0,
        updated_at_ms: row.get(3)?,
    })
}

fn parse_task_family_policy_row(
    row: RawTaskFamilyPolicyRow,
) -> Result<Option<RuntimeTaskFamilyPolicyRecord>, String> {
    let profile_order = match serde_json::from_str::<Vec<String>>(&row.profile_order_json) {
        Ok(value) => value,
        Err(err) => {
            eprintln!(
                "runtime-task-policy-invalid-json: task_family={} error={}",
                sanitize_profile_pool_text_for_log(&row.task_family),
                sanitize_profile_pool_text_for_log(&err.to_string())
            );
            return Ok(None);
        }
    };
    Ok(RuntimeTaskFamilyPolicyRecord {
        task_family: row.task_family,
        profile_order,
        auto_failover: row.auto_failover,
        updated_at_ms: row.updated_at_ms,
    }
    .into())
}

#[cfg(test)]
mod tests {
    use super::*;

    use rusqlite::Connection;
    use std::fs;

    #[test]
    fn task_policy_crud_roundtrip_filters_missing_profiles() {
        let project = temp_project("task-policy-roundtrip");
        fs::create_dir_all(&project).expect("create temp project");
        create_profile_pool_profile(
            &project,
            "profile-1",
            "model-call",
            true,
            1,
            profile_pool_capability_json(serde_json::json!(true), serde_json::json!(false)),
        );
        create_profile_pool_profile(
            &project,
            "profile-2",
            "model-call",
            true,
            1,
            profile_pool_capability_json(serde_json::json!(true), serde_json::json!(false)),
        );

        let saved = runtime_task_policy_set_for_project(
            Some(&project),
            true,
            RuntimeTaskPolicySetRequest {
                task_family: "summarize".to_string(),
                profile_order: vec![
                    "missing".to_string(),
                    "profile-2".to_string(),
                    "profile-2".to_string(),
                    "profile-1".to_string(),
                ],
                auto_failover: Some(false),
            },
            200,
        )
        .expect("save policy");

        assert_eq!(
            saved.policy.profile_order,
            vec!["profile-2".to_string(), "profile-1".to_string()]
        );
        assert!(!saved.policy.auto_failover);
        assert_eq!(saved.removed_profile_ids, vec!["missing".to_string()]);

        let listed =
            runtime_task_policy_list_for_project(Some(&project), true).expect("list policies");
        assert_eq!(listed.status, RuntimeDbHealthState::Healthy);
        assert_eq!(listed.policies, vec![saved.policy]);
        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn task_policy_bad_profile_order_json_does_not_block_claim() {
        let project = temp_project("task-policy-bad-json-claim");
        fs::create_dir_all(&project).expect("create temp project");
        create_profile_pool_profile(
            &project,
            "profile-1",
            "model-call",
            true,
            1,
            profile_pool_capability_json(serde_json::json!(true), serde_json::json!(false)),
        );
        runtime_task_policy_set_for_project(
            Some(&project),
            true,
            RuntimeTaskPolicySetRequest {
                task_family: "summarize".to_string(),
                profile_order: vec!["profile-1".to_string()],
                auto_failover: Some(true),
            },
            100,
        )
        .expect("save policy");
        let connection = Connection::open(runtime_db_path(&project)).expect("open runtime db");
        connection
            .execute(
                "UPDATE runtime_task_family_policies
                 SET profile_order = '{bad json}'
                 WHERE task_family = 'summarize'",
                [],
            )
            .expect("corrupt policy json");
        drop(connection);
        let mut request = profile_pool_claim_request("claim-1", vec![]);
        request.preferred_profile_ids = None;

        let claimed = runtime_profile_pool_claim_for_project(Some(&project), true, request, 200)
            .expect("claim ignores corrupt policy row");

        assert_eq!(claimed.profile_id, "profile-1");
        let _ = fs::remove_dir_all(project);
    }
}
