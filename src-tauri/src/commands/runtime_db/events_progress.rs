use crate::commands::file_sync::ProjectRootState;
use rusqlite::{params, Connection, OpenFlags, OptionalExtension, Transaction};
use std::path::Path;
use tauri::State;

use super::*;
use uuid::Uuid;

/// Append a durable runtime event for the currently-open project.
#[tauri::command]
pub fn runtime_event_append(
    request: RuntimeEventAppendRequest,
    root_state: State<'_, ProjectRootState>,
) -> Result<RuntimeEventRecord, String> {
    run_project_write(
        "runtime_event_append",
        root_state,
        |project_root, enabled, now| {
            runtime_event_append_for_project(project_root, enabled, request, now)
        },
    )
}

/// Append or coalesce a runtime progress fact for the currently-open project.
#[tauri::command]
pub fn runtime_progress_append(
    request: RuntimeProgressAppendRequest,
    root_state: State<'_, ProjectRootState>,
) -> Result<RuntimeProgressAppend, String> {
    run_project_write(
        "runtime_progress_append",
        root_state,
        |project_root, enabled, now| {
            runtime_progress_append_for_project(project_root, enabled, request, now)
        },
    )
}

/// List runtime events for the currently-open project.
#[tauri::command]
pub fn runtime_timeline_list(
    request: Option<RuntimeTimelineListRequest>,
    root_state: State<'_, ProjectRootState>,
) -> Result<RuntimeTimelineList, String> {
    run_project_read(
        "runtime_timeline_list",
        root_state,
        |project_root, enabled| {
            runtime_timeline_list_for_project(
                project_root,
                enabled,
                request.unwrap_or(RuntimeTimelineListRequest {
                    job_id: None,
                    limit: None,
                }),
            )
        },
    )
}

/// List runtime progress facts for the currently-open project.
#[tauri::command]
pub fn runtime_progress_list(
    request: Option<RuntimeProgressListRequest>,
    root_state: State<'_, ProjectRootState>,
) -> Result<RuntimeProgressList, String> {
    run_project_read(
        "runtime_progress_list",
        root_state,
        |project_root, enabled| {
            runtime_progress_list_for_project(
                project_root,
                enabled,
                request.unwrap_or(RuntimeProgressListRequest {
                    job_id: None,
                    limit: None,
                }),
            )
        },
    )
}

pub(crate) fn runtime_event_append_for_project(
    project_root: Option<&Path>,
    enabled: bool,
    request: RuntimeEventAppendRequest,
    now: i64,
) -> Result<RuntimeEventRecord, String> {
    let project_root = require_enabled_project(project_root, enabled)?;
    let job_id = require_required_non_empty("invalid-job-id", "jobId", request.job_id.as_deref())?;
    let payload = require_event_payload(&request.payload)?;
    let event_id = normalize_optional_id("invalid-event-id", "eventId", request.event_id)?;

    with_runtime_writer(|| {
        let mut connection = open_events_progress_runtime_locked(project_root)?;
        let tx = connection.transaction().map_err(tx_err)?;
        ensure_job_exists(&tx, job_id)?;
        let event_id = insert_runtime_event_tx(
            &tx,
            event_id.as_deref(),
            job_id,
            EVENT_APPENDED_NAME,
            payload,
            now,
        )?;
        let event = read_event_tx(&tx, &event_id)?;
        tx.commit().map_err(tx_err)?;
        Ok(event)
    })
}

fn runtime_progress_append_for_project(
    project_root: Option<&Path>,
    enabled: bool,
    request: RuntimeProgressAppendRequest,
    now: i64,
) -> Result<RuntimeProgressAppend, String> {
    let project_root = require_enabled_project(project_root, enabled)?;
    let job_id = require_required_non_empty("invalid-job-id", "jobId", request.job_id.as_deref())?;
    let progress_key =
        require_non_empty("invalid-progress-key", "progressKey", &request.progress_key)?;
    let payload = require_event_payload(&request.payload)?;
    let event_id = normalize_optional_id("invalid-event-id", "eventId", request.event_id)?;
    let durable = request.durable.unwrap_or(false);

    with_runtime_writer(|| {
        let mut connection = open_events_progress_runtime_locked(project_root)?;
        let tx = connection.transaction().map_err(tx_err)?;
        ensure_job_exists(&tx, job_id)?;
        let previous = read_progress_optional_tx(&tx, job_id, progress_key)?;
        let should_append_event = durable
            || previous.as_ref().is_none_or(|progress| {
                now.saturating_sub(progress.updated_at_ms) >= DEFAULT_PROGRESS_MIN_INTERVAL_MS
            });
        let inserted_event_id = if should_append_event {
            Some(insert_runtime_event_tx(
                &tx,
                event_id.as_deref(),
                job_id,
                PROGRESS_APPENDED_NAME,
                payload,
                now,
            )?)
        } else {
            None
        };
        upsert_runtime_progress_tx(
            &tx,
            job_id,
            progress_key,
            payload,
            now,
            inserted_event_id.as_deref(),
        )?;
        let progress = read_progress_tx(&tx, job_id, progress_key)?;
        let event = match inserted_event_id {
            Some(event_id) => Some(read_event_tx(&tx, &event_id)?),
            None => None,
        };
        tx.commit().map_err(tx_err)?;
        Ok(RuntimeProgressAppend { progress, event })
    })
}

pub(crate) fn runtime_timeline_list_for_project(
    project_root: Option<&Path>,
    enabled: bool,
    request: RuntimeTimelineListRequest,
) -> Result<RuntimeTimelineList, String> {
    if !enabled {
        return Ok(RuntimeTimelineList {
            enabled: false,
            status: RuntimeDbHealthState::Disabled,
            events: Vec::new(),
        });
    }
    let Some(project_root) = project_root else {
        return Ok(RuntimeTimelineList {
            enabled: true,
            status: RuntimeDbHealthState::NoProject,
            events: Vec::new(),
        });
    };
    let limit = normalize_list_limit(request.limit, DEFAULT_TIMELINE_LIMIT, MAX_TIMELINE_LIMIT)?;
    let job_id = normalize_optional_filter("invalid-job-id", "jobId", request.job_id)?;
    let db_path = runtime_db_path(project_root);
    if !db_path.exists() {
        return Ok(RuntimeTimelineList {
            enabled: true,
            status: RuntimeDbHealthState::Healthy,
            events: Vec::new(),
        });
    }
    let connection = Connection::open_with_flags(
        db_path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|err| format!("timeline-list-open-failed: {err}"))?;
    if !table_exists(&connection, "runtime_events")? {
        return Ok(RuntimeTimelineList {
            enabled: true,
            status: RuntimeDbHealthState::Healthy,
            events: Vec::new(),
        });
    }
    Ok(RuntimeTimelineList {
        enabled: true,
        status: RuntimeDbHealthState::Healthy,
        events: read_events(&connection, job_id.as_deref(), limit)?,
    })
}

pub(crate) fn runtime_progress_list_for_project(
    project_root: Option<&Path>,
    enabled: bool,
    request: RuntimeProgressListRequest,
) -> Result<RuntimeProgressList, String> {
    if !enabled {
        return Ok(RuntimeProgressList {
            enabled: false,
            status: RuntimeDbHealthState::Disabled,
            progress: Vec::new(),
        });
    }
    let Some(project_root) = project_root else {
        return Ok(RuntimeProgressList {
            enabled: true,
            status: RuntimeDbHealthState::NoProject,
            progress: Vec::new(),
        });
    };
    let limit = normalize_list_limit(request.limit, DEFAULT_PROGRESS_LIMIT, MAX_PROGRESS_LIMIT)?;
    let job_id = normalize_optional_filter("invalid-job-id", "jobId", request.job_id)?;
    let db_path = runtime_db_path(project_root);
    if !db_path.exists() {
        return Ok(RuntimeProgressList {
            enabled: true,
            status: RuntimeDbHealthState::Healthy,
            progress: Vec::new(),
        });
    }
    let connection = Connection::open_with_flags(
        db_path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|err| format!("progress-list-open-failed: {err}"))?;
    if !table_exists(&connection, "runtime_progress")? {
        return Ok(RuntimeProgressList {
            enabled: true,
            status: RuntimeDbHealthState::Healthy,
            progress: Vec::new(),
        });
    }
    Ok(RuntimeProgressList {
        enabled: true,
        status: RuntimeDbHealthState::Healthy,
        progress: read_progress_rows(&connection, job_id.as_deref(), limit)?,
    })
}

pub(crate) fn insert_runtime_event_tx(
    tx: &Transaction<'_>,
    event_id: Option<&str>,
    job_id: &str,
    event_name: &str,
    payload: &str,
    now: i64,
) -> Result<String, String> {
    let event_id = event_id
        .map(str::to_string)
        .unwrap_or_else(|| Uuid::new_v4().to_string());
    tx.execute(
        "INSERT INTO runtime_events (
            event_id,
            job_id,
            event_name,
            payload,
            created_at_ms
        ) VALUES (?1, ?2, ?3, ?4, ?5)",
        params![event_id, job_id, event_name, payload, now],
    )
    .map_err(|err| format!("event-insert-failed: {err}"))?;
    Ok(event_id)
}

pub(crate) fn upsert_runtime_progress_tx(
    tx: &Transaction<'_>,
    job_id: &str,
    progress_key: &str,
    payload: &str,
    now: i64,
    last_event_id: Option<&str>,
) -> Result<(), String> {
    tx.execute(
        "INSERT INTO runtime_progress (
            job_id,
            progress_key,
            payload,
            updated_at_ms,
            last_event_id
        ) VALUES (?1, ?2, ?3, ?4, ?5)
        ON CONFLICT(job_id, progress_key) DO UPDATE SET
            payload = excluded.payload,
            updated_at_ms = excluded.updated_at_ms,
            last_event_id = CASE
                WHEN excluded.last_event_id IS NULL
                THEN runtime_progress.last_event_id
                ELSE excluded.last_event_id
            END",
        params![job_id, progress_key, payload, now, last_event_id],
    )
    .map_err(|err| format!("progress-upsert-failed: {err}"))?;
    Ok(())
}

pub(crate) fn read_event_tx(
    tx: &Transaction<'_>,
    event_id: &str,
) -> Result<RuntimeEventRecord, String> {
    tx.query_row(
        &event_select_sql("WHERE event_id = ?1"),
        [event_id],
        map_event_row,
    )
    .map_err(|err| format!("event-read-failed: {err}"))
}

fn read_progress_tx(
    tx: &Transaction<'_>,
    job_id: &str,
    progress_key: &str,
) -> Result<RuntimeProgressRecord, String> {
    tx.query_row(
        &progress_select_sql("WHERE job_id = ?1 AND progress_key = ?2"),
        params![job_id, progress_key],
        map_progress_row,
    )
    .map_err(|err| format!("progress-read-failed: {err}"))
}

fn read_progress_optional_tx(
    tx: &Transaction<'_>,
    job_id: &str,
    progress_key: &str,
) -> Result<Option<RuntimeProgressRecord>, String> {
    tx.query_row(
        &progress_select_sql("WHERE job_id = ?1 AND progress_key = ?2"),
        params![job_id, progress_key],
        map_progress_row,
    )
    .optional()
    .map_err(|err| format!("progress-read-failed: {err}"))
}

fn read_events(
    connection: &Connection,
    job_id: Option<&str>,
    limit: i64,
) -> Result<Vec<RuntimeEventRecord>, String> {
    let suffix = match job_id {
        Some(_) => "WHERE job_id = ?1 ORDER BY created_at_ms ASC, event_id ASC LIMIT ?2",
        None => "ORDER BY created_at_ms ASC, event_id ASC LIMIT ?1",
    };
    let mut statement = connection
        .prepare(&event_select_sql(suffix))
        .map_err(|err| format!("events-read-prepare-failed: {err}"))?;
    let rows = match job_id {
        Some(job_id) => statement
            .query_map(params![job_id, limit], map_event_row)
            .map_err(|err| format!("events-read-failed: {err}"))?,
        None => statement
            .query_map([limit], map_event_row)
            .map_err(|err| format!("events-read-failed: {err}"))?,
    };
    collect_mapped_rows(rows, "events-read-failed")
}

fn read_progress_rows(
    connection: &Connection,
    job_id: Option<&str>,
    limit: i64,
) -> Result<Vec<RuntimeProgressRecord>, String> {
    let suffix = match job_id {
        Some(_) => {
            "WHERE job_id = ?1 ORDER BY updated_at_ms ASC, job_id ASC, progress_key ASC LIMIT ?2"
        }
        None => "ORDER BY updated_at_ms ASC, job_id ASC, progress_key ASC LIMIT ?1",
    };
    let mut statement = connection
        .prepare(&progress_select_sql(suffix))
        .map_err(|err| format!("progress-read-prepare-failed: {err}"))?;
    let rows = match job_id {
        Some(job_id) => statement
            .query_map(params![job_id, limit], map_progress_row)
            .map_err(|err| format!("progress-read-failed: {err}"))?,
        None => statement
            .query_map([limit], map_progress_row)
            .map_err(|err| format!("progress-read-failed: {err}"))?,
    };
    collect_mapped_rows(rows, "progress-read-failed")
}

fn event_select_sql(suffix: &str) -> String {
    format!(
        "SELECT event_id,
                job_id,
                event_name,
                payload,
                created_at_ms
         FROM runtime_events {suffix}"
    )
}

fn progress_select_sql(suffix: &str) -> String {
    format!(
        "SELECT job_id,
                progress_key,
                payload,
                updated_at_ms,
                last_event_id
         FROM runtime_progress {suffix}"
    )
}

fn map_event_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<RuntimeEventRecord> {
    Ok(RuntimeEventRecord {
        event_id: row.get(0)?,
        job_id: row.get(1)?,
        event_name: row.get(2)?,
        payload: row.get(3)?,
        created_at_ms: row.get(4)?,
    })
}

fn map_progress_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<RuntimeProgressRecord> {
    Ok(RuntimeProgressRecord {
        job_id: row.get(0)?,
        progress_key: row.get(1)?,
        payload: row.get(2)?,
        updated_at_ms: row.get(3)?,
        last_event_id: row.get(4)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    use rusqlite::{params, Connection};

    use std::fs;

    fn progress_request(
        job_id: Option<&str>,
        progress_key: &str,
        event_id: &str,
        payload: &str,
        durable: bool,
    ) -> RuntimeProgressAppendRequest {
        RuntimeProgressAppendRequest {
            job_id: job_id.map(str::to_string),
            progress_key: progress_key.to_string(),
            event_id: Some(event_id.to_string()),
            payload: payload.to_string(),
            durable: Some(durable),
        }
    }

    #[test]
    fn pr5_request_shapes_reject_unknown_fields() {
        let event = serde_json::from_value::<RuntimeEventAppendRequest>(serde_json::json!({
            "jobId": "job-1",
            "eventId": "event-1",
            "payload": "{}",
            "dbPath": "/tmp/runtime.db"
        }))
        .expect_err("event request rejects dbPath");
        assert!(event.to_string().contains("unknown field"));

        let progress = serde_json::from_value::<RuntimeProgressAppendRequest>(serde_json::json!({
            "jobId": "job-1",
            "progressKey": "compile",
            "eventId": "event-2",
            "payload": "{}",
            "durable": false,
            "timestamp": 123
        }))
        .expect_err("progress request rejects timestamp");
        assert!(progress.to_string().contains("unknown field"));

        let timeline = serde_json::from_value::<RuntimeTimelineListRequest>(serde_json::json!({
            "jobId": "job-1",
            "limit": 10,
            "root": "/tmp/project"
        }))
        .expect_err("timeline request rejects root");
        assert!(timeline.to_string().contains("unknown field"));

        let progress_list =
            serde_json::from_value::<RuntimeProgressListRequest>(serde_json::json!({
                "jobId": "job-1",
                "limit": 10,
                "minIntervalMs": 1
            }))
            .expect_err("progress list request rejects minIntervalMs");
        assert!(progress_list.to_string().contains("unknown field"));
    }

    #[test]
    fn disabled_event_progress_commands_do_not_touch_damaged_runtime_db() {
        let project = temp_project("disabled-events-progress");
        let runtime_dir = project.join(RUNTIME_DIR);
        fs::create_dir_all(&runtime_dir).expect("create runtime dir");
        let db_path = runtime_dir.join(RUNTIME_DB_FILE);
        fs::write(&db_path, b"not sqlite").expect("write damaged db");

        let event_error = runtime_event_append_for_project(
            Some(&project),
            false,
            event_request(Some("job-1"), "event-1", "{}"),
            100,
        )
        .expect_err("disabled event append should fail");
        assert!(event_error.starts_with("runtime-disabled"));

        let progress_error = runtime_progress_append_for_project(
            Some(&project),
            false,
            progress_request(Some("job-1"), "compile", "event-2", "{}", false),
            100,
        )
        .expect_err("disabled progress append should fail");
        assert!(progress_error.starts_with("runtime-disabled"));

        let timeline = runtime_timeline_list_for_project(
            Some(&project),
            false,
            timeline_request(Some("job-1")),
        )
        .expect("disabled timeline list");
        assert_eq!(timeline.status, RuntimeDbHealthState::Disabled);
        assert!(timeline.events.is_empty());

        let progress = runtime_progress_list_for_project(
            Some(&project),
            false,
            progress_list_request(Some("job-1")),
        )
        .expect("disabled progress list");
        assert_eq!(progress.status, RuntimeDbHealthState::Disabled);
        assert!(progress.progress.is_empty());

        assert_eq!(fs::read(&db_path).expect("read damaged db"), b"not sqlite");
        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn enabled_event_progress_commands_without_project_are_no_touch() {
        let event_error = runtime_event_append_for_project(
            None,
            true,
            event_request(Some("job-1"), "event-1", "{}"),
            100,
        )
        .expect_err("no-project event append should fail");
        assert!(event_error.starts_with("no-project"));

        let progress_error = runtime_progress_append_for_project(
            None,
            true,
            progress_request(Some("job-1"), "compile", "event-2", "{}", false),
            100,
        )
        .expect_err("no-project progress append should fail");
        assert!(progress_error.starts_with("no-project"));

        let timeline = runtime_timeline_list_for_project(None, true, timeline_request(None))
            .expect("timeline");
        assert_eq!(timeline.status, RuntimeDbHealthState::NoProject);
        assert!(timeline.events.is_empty());

        let progress = runtime_progress_list_for_project(None, true, progress_list_request(None))
            .expect("progress list");
        assert_eq!(progress.status, RuntimeDbHealthState::NoProject);
        assert!(progress.progress.is_empty());
    }

    #[test]
    fn event_progress_lists_return_empty_without_migration_on_existing_runtime_dbs() {
        let pr4_project = temp_project("events-progress-pr4-db");
        fs::create_dir_all(&pr4_project).expect("create temp project");
        runtime_commit_budget_claim_for_project(
            Some(&pr4_project),
            true,
            commit_claim_request("wiki/a.md", "claim-1"),
            100,
        )
        .expect("create PR4 runtime db");

        let timeline =
            runtime_timeline_list_for_project(Some(&pr4_project), true, timeline_request(None))
                .expect("timeline list");
        let progress = runtime_progress_list_for_project(
            Some(&pr4_project),
            true,
            progress_list_request(None),
        )
        .expect("progress list");

        assert!(timeline.events.is_empty());
        assert!(progress.progress.is_empty());
        let connection = Connection::open(runtime_db_path(&pr4_project)).expect("open runtime db");
        assert!(!table_exists(&connection, "runtime_events").expect("check events"));
        assert!(!migration_family_exists(
            &pr4_project,
            EVENTS_PROGRESS_FAMILY
        ));
        drop(connection);
        let _ = fs::remove_dir_all(pr4_project);

        let pr3_project = temp_project("events-progress-pr3-db");
        fs::create_dir_all(&pr3_project).expect("create temp project");
        runtime_job_create_for_project(Some(&pr3_project), true, create_request("job-1"), 100)
            .expect("create PR3 runtime db");

        let timeline =
            runtime_timeline_list_for_project(Some(&pr3_project), true, timeline_request(None))
                .expect("timeline list");
        let progress = runtime_progress_list_for_project(
            Some(&pr3_project),
            true,
            progress_list_request(None),
        )
        .expect("progress list");
        assert!(timeline.events.is_empty());
        assert!(progress.progress.is_empty());
        let connection = Connection::open(runtime_db_path(&pr3_project)).expect("open runtime db");
        assert!(!table_exists(&connection, "runtime_events").expect("check events"));
        assert!(!table_exists(&connection, "runtime_progress").expect("check progress"));
        assert!(!migration_family_exists(
            &pr3_project,
            EVENTS_PROGRESS_FAMILY
        ));
        let _ = fs::remove_dir_all(pr3_project);
    }

    #[test]
    fn events_progress_migration_preserves_higher_version_and_is_idempotent() {
        let project = temp_project("events-progress-higher-version");
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
                params![EVENTS_PROGRESS_FAMILY, 2_i64, 42_i64],
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
        let first = read_migration_family(&project, EVENTS_PROGRESS_FAMILY);

        runtime_event_append_for_project(
            Some(&project),
            true,
            event_request(Some("job-1"), "event-2", "{}"),
            300,
        )
        .expect("append second event");
        let second = read_migration_family(&project, EVENTS_PROGRESS_FAMILY);

        assert_eq!(
            first,
            RuntimeDbMigrationStatus {
                family: EVENTS_PROGRESS_FAMILY.to_string(),
                version: 2,
                applied_at_ms: 42,
            }
        );
        assert_eq!(first, second);
        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn event_schema_enables_foreign_keys_and_rejects_orphan_event() {
        let project = temp_project("events-progress-fk");
        fs::create_dir_all(&project).expect("create temp project");

        with_runtime_writer(|| {
            let connection = open_events_progress_runtime_locked(&project)?;
            let foreign_keys = connection
                .query_row("PRAGMA foreign_keys", [], |row| row.get::<_, i64>(0))
                .expect("read foreign key pragma");
            assert_eq!(foreign_keys, 1);
            let error = connection
                .execute(
                    "INSERT INTO runtime_events (
                        event_id,
                        job_id,
                        event_name,
                        payload,
                        created_at_ms
                    ) VALUES ('event-orphan', 'missing-job', 'job-runtime:event-appended', '{}', 1)",
                    [],
                )
                .expect_err("orphan event must fail");
            assert!(error.to_string().contains("FOREIGN KEY"));
            Ok(())
        })
        .expect("schema init succeeds");

        let migration = read_migration_family(&project, EVENTS_PROGRESS_FAMILY);
        with_runtime_writer(|| {
            open_events_progress_runtime_locked(&project)?;
            Ok(())
        })
        .expect("schema init is idempotent");
        assert_eq!(
            migration,
            read_migration_family(&project, EVENTS_PROGRESS_FAMILY)
        );
        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn event_append_requires_existing_job_and_timeline_is_stably_ordered() {
        let project = temp_project("events-progress-event-order");
        fs::create_dir_all(&project).expect("create temp project");

        let missing_job = runtime_event_append_for_project(
            Some(&project),
            true,
            event_request(Some("missing-job"), "event-missing", "{}"),
            100,
        )
        .expect_err("missing job is rejected");
        assert!(missing_job.starts_with("job-not-found"));

        let missing_job_id = runtime_event_append_for_project(
            Some(&project),
            true,
            event_request(None, "event-no-job", "{}"),
            100,
        )
        .expect_err("missing job id is rejected");
        assert!(missing_job_id.starts_with("invalid-job-id"));

        runtime_job_create_for_project(Some(&project), true, create_request("job-1"), 100)
            .expect("create job");
        let before = runtime_job_list_for_project(Some(&project), true).expect("list jobs");
        assert_eq!(before.jobs[0].state, "queued");
        assert_eq!(before.jobs[0].updated_at_ms, 100);
        let event_b = runtime_event_append_for_project(
            Some(&project),
            true,
            event_request(Some("job-1"), "event-b", "{\"step\":2}"),
            200,
        )
        .expect("append event b");
        let event_a = runtime_event_append_for_project(
            Some(&project),
            true,
            event_request(Some("job-1"), "event-a", "{\"step\":1}"),
            200,
        )
        .expect("append event a");

        assert_eq!(event_a.event_name, EVENT_APPENDED_NAME);
        assert_eq!(event_b.event_name, EVENT_APPENDED_NAME);
        let after = runtime_job_list_for_project(Some(&project), true).expect("list jobs");
        assert_eq!(after.jobs[0].state, "queued");
        assert_eq!(after.jobs[0].updated_at_ms, 100);
        let timeline = runtime_timeline_list_for_project(
            Some(&project),
            true,
            timeline_request(Some("job-1")),
        )
        .expect("timeline list");
        assert_eq!(
            timeline
                .events
                .iter()
                .map(|event| event.event_id.as_str())
                .collect::<Vec<_>>(),
            vec!["event-a", "event-b"]
        );
        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn progress_append_coalesces_by_key_and_preserves_last_event_id() {
        let project = temp_project("events-progress-coalesce");
        fs::create_dir_all(&project).expect("create temp project");
        runtime_job_create_for_project(Some(&project), true, create_request("job-1"), 100)
            .expect("create job");

        let first = runtime_progress_append_for_project(
            Some(&project),
            true,
            progress_request(Some("job-1"), "compile", "event-1", "{\"pct\":10}", false),
            1_000,
        )
        .expect("first progress append");
        assert_eq!(
            first.event.as_ref().map(|event| event.event_id.as_str()),
            Some("event-1")
        );
        assert_eq!(first.progress.last_event_id.as_deref(), Some("event-1"));

        let coalesced = runtime_progress_append_for_project(
            Some(&project),
            true,
            progress_request(Some("job-1"), "compile", "event-2", "{\"pct\":20}", false),
            1_000 + DEFAULT_PROGRESS_MIN_INTERVAL_MS - 1,
        )
        .expect("coalesced progress append");
        assert!(coalesced.event.is_none());
        assert_eq!(coalesced.progress.payload, "{\"pct\":20}");
        assert_eq!(coalesced.progress.last_event_id.as_deref(), Some("event-1"));

        let boundary = runtime_progress_append_for_project(
            Some(&project),
            true,
            progress_request(Some("job-1"), "compile", "event-3", "{\"pct\":30}", false),
            1_000 + DEFAULT_PROGRESS_MIN_INTERVAL_MS - 1 + DEFAULT_PROGRESS_MIN_INTERVAL_MS,
        )
        .expect("boundary progress append");
        assert_eq!(
            boundary.event.as_ref().map(|event| event.event_id.as_str()),
            Some("event-3")
        );
        assert_eq!(boundary.progress.last_event_id.as_deref(), Some("event-3"));

        let durable = runtime_progress_append_for_project(
            Some(&project),
            true,
            progress_request(Some("job-1"), "compile", "event-4", "{\"pct\":40}", true),
            1_000 + DEFAULT_PROGRESS_MIN_INTERVAL_MS - 1 + DEFAULT_PROGRESS_MIN_INTERVAL_MS + 1,
        )
        .expect("durable progress append");
        assert_eq!(
            durable.event.as_ref().map(|event| event.event_id.as_str()),
            Some("event-4")
        );
        assert_eq!(durable.progress.last_event_id.as_deref(), Some("event-4"));

        let durable_again = runtime_progress_append_for_project(
            Some(&project),
            true,
            progress_request(Some("job-1"), "compile", "event-5", "{\"pct\":45}", true),
            1_000 + DEFAULT_PROGRESS_MIN_INTERVAL_MS - 1 + DEFAULT_PROGRESS_MIN_INTERVAL_MS + 2,
        )
        .expect("second durable progress append");
        assert_eq!(
            durable_again
                .event
                .as_ref()
                .map(|event| event.event_id.as_str()),
            Some("event-5")
        );
        assert_eq!(
            durable_again.progress.last_event_id.as_deref(),
            Some("event-5")
        );

        let suppressed_after_durable = runtime_progress_append_for_project(
            Some(&project),
            true,
            progress_request(Some("job-1"), "compile", "event-6", "{\"pct\":50}", false),
            1_000 + DEFAULT_PROGRESS_MIN_INTERVAL_MS - 1 + DEFAULT_PROGRESS_MIN_INTERVAL_MS + 2,
        )
        .expect("suppressed after durable");
        assert!(suppressed_after_durable.event.is_none());
        assert_eq!(
            suppressed_after_durable.progress.last_event_id.as_deref(),
            Some("event-5")
        );

        let timeline = runtime_timeline_list_for_project(
            Some(&project),
            true,
            timeline_request(Some("job-1")),
        )
        .expect("timeline list");
        assert_eq!(
            timeline
                .events
                .iter()
                .map(|event| event.event_id.as_str())
                .collect::<Vec<_>>(),
            vec!["event-1", "event-3", "event-4", "event-5"]
        );
        let progress = runtime_progress_list_for_project(
            Some(&project),
            true,
            progress_list_request(Some("job-1")),
        )
        .expect("progress list");
        assert_eq!(progress.progress.len(), 1);
        assert_eq!(progress.progress[0].payload, "{\"pct\":50}");
        assert_eq!(
            progress.progress[0].last_event_id.as_deref(),
            Some("event-5")
        );
        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn event_progress_validation_rejects_blank_and_oversized_payloads() {
        let project = temp_project("events-progress-validation");
        fs::create_dir_all(&project).expect("create temp project");
        runtime_job_create_for_project(Some(&project), true, create_request("job-1"), 100)
            .expect("create job");

        let exact_payload = "x".repeat(MAX_EVENT_PAYLOAD_BYTES);
        let exact_event = runtime_event_append_for_project(
            Some(&project),
            true,
            event_request(Some("job-1"), "event-exact", &exact_payload),
            150,
        )
        .expect("exact max payload is allowed");
        assert_eq!(exact_event.payload.len(), MAX_EVENT_PAYLOAD_BYTES);

        let blank_event = runtime_event_append_for_project(
            Some(&project),
            true,
            event_request(Some("job-1"), "event-blank", "  "),
            200,
        )
        .expect_err("blank event payload rejected");
        assert!(blank_event.starts_with("invalid-payload"));

        let oversized = "x".repeat(MAX_EVENT_PAYLOAD_BYTES + 1);
        let oversized_progress = runtime_progress_append_for_project(
            Some(&project),
            true,
            progress_request(Some("job-1"), "compile", "event-large", &oversized, false),
            200,
        )
        .expect_err("oversized progress payload rejected");
        assert!(oversized_progress.starts_with("invalid-payload"));

        with_runtime_writer(|| {
            let connection = open_events_progress_runtime_locked(&project)?;
            let error = connection
                .execute(
                    "INSERT INTO runtime_events (
                        event_id,
                        job_id,
                        event_name,
                        payload,
                        created_at_ms
                    ) VALUES (?1, ?2, ?3, ?4, ?5)",
                    params![
                        "event-db-check",
                        "job-1",
                        EVENT_APPENDED_NAME,
                        oversized,
                        250_i64
                    ],
                )
                .expect_err("DB CHECK rejects oversized event payload");
            assert!(error.to_string().contains("CHECK"));

            let multibyte_oversized = "你".repeat((MAX_EVENT_PAYLOAD_BYTES / "你".len()) + 1);
            assert!(multibyte_oversized.chars().count() <= MAX_EVENT_PAYLOAD_BYTES);
            assert!(multibyte_oversized.len() > MAX_EVENT_PAYLOAD_BYTES);
            let multibyte_error = connection
                .execute(
                    "INSERT INTO runtime_progress (
                        job_id,
                        progress_key,
                        payload,
                        updated_at_ms
                    ) VALUES (?1, ?2, ?3, ?4)",
                    params!["job-1", "multibyte", multibyte_oversized, 260_i64],
                )
                .expect_err("DB CHECK rejects multibyte oversized progress payload");
            assert!(multibyte_error.to_string().contains("CHECK"));
            Ok(())
        })
        .expect("DB CHECK boundary test succeeds");

        let invalid_limit = runtime_timeline_list_for_project(
            Some(&project),
            true,
            RuntimeTimelineListRequest {
                job_id: None,
                limit: Some(MAX_TIMELINE_LIMIT + 1),
            },
        )
        .expect_err("invalid limit rejected");
        assert!(invalid_limit.starts_with("invalid-limit"));

        let list = runtime_progress_list_for_project(
            Some(&project),
            true,
            progress_list_request(Some("job-1")),
        )
        .expect("progress list");
        assert!(list.progress.is_empty());
        let _ = fs::remove_dir_all(project);
    }
}
