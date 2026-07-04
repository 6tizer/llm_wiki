use std::path::Path;
use rusqlite::{params, Connection, OpenFlags, OptionalExtension, Transaction};
use tauri::State;
use crate::commands::file_sync::ProjectRootState;
use crate::panic_guard::run_guarded;

use super::*;
use uuid::Uuid;
use crate::commands::profile_secrets::validate_profile_secret_ref;


/// Create a stored model profile for the currently-open project.
#[tauri::command]
pub fn runtime_profile_create(
    request: RuntimeProfileCreateRequest,
    root_state: State<'_, ProjectRootState>,
) -> Result<RuntimeProfileRecord, String> {
    run_guarded("runtime_profile_create", || {
        let runtime_enabled = resolve_work_runtime_enabled(read_work_runtime_flag_value());
        let project_root = root_state.get();
        let now = now_for_enabled_project(project_root.as_deref(), runtime_enabled)?;
        runtime_profile_create_for_project(project_root.as_deref(), runtime_enabled, request, now)
    })
}

/// Update non-secret model profile metadata for the currently-open project.
#[tauri::command]
pub fn runtime_profile_update(
    request: RuntimeProfileUpdateRequest,
    root_state: State<'_, ProjectRootState>,
) -> Result<RuntimeProfileRecord, String> {
    run_guarded("runtime_profile_update", || {
        let runtime_enabled = resolve_work_runtime_enabled(read_work_runtime_flag_value());
        let project_root = root_state.get();
        let now = now_for_enabled_project(project_root.as_deref(), runtime_enabled)?;
        runtime_profile_update_for_project(project_root.as_deref(), runtime_enabled, request, now)
    })
}

/// Soft-delete one stored model profile for the currently-open project.
#[tauri::command]
pub fn runtime_profile_delete(
    request: RuntimeProfileDeleteRequest,
    root_state: State<'_, ProjectRootState>,
) -> Result<RuntimeProfileDeleteResult, String> {
    run_guarded("runtime_profile_delete", || {
        let runtime_enabled = resolve_work_runtime_enabled(read_work_runtime_flag_value());
        let project_root = root_state.get();
        let now = now_for_enabled_project(project_root.as_deref(), runtime_enabled)?;
        runtime_profile_delete_for_project(project_root.as_deref(), runtime_enabled, request, now)
    })
}

/// List stored model profiles for the currently-open project.
#[tauri::command]
pub fn runtime_profile_list(
    root_state: State<'_, ProjectRootState>,
) -> Result<RuntimeProfileList, String> {
    run_guarded("runtime_profile_list", || {
        runtime_profile_list_for_project(
            root_state.get().as_deref(),
            resolve_work_runtime_enabled(read_work_runtime_flag_value()),
        )
    })
}

/// Read one stored model profile/capability status for the currently-open project.
#[tauri::command]
pub fn runtime_profile_status(
    request: RuntimeProfileStatusRequest,
    root_state: State<'_, ProjectRootState>,
) -> Result<RuntimeProfileRecord, String> {
    run_guarded("runtime_profile_status", || {
        runtime_profile_status_for_project(
            root_state.get().as_deref(),
            resolve_work_runtime_enabled(read_work_runtime_flag_value()),
            request,
        )
    })
}

pub(crate) fn runtime_profile_create_for_project(
    project_root: Option<&Path>,
    enabled: bool,
    request: RuntimeProfileCreateRequest,
    now: i64,
) -> Result<RuntimeProfileRecord, String> {
    let project_root = require_enabled_project(project_root, enabled)?;
    let profile_id = match request.profile_id {
        Some(profile_id) => normalize_profile_text(
            "invalid-profile-id",
            "profileId",
            &profile_id,
            MAX_PROFILE_ID_BYTES,
        )?,
        None => Uuid::new_v4().to_string(),
    };
    let kind = normalize_profile_kind(&request.kind)?;
    let display_name = normalize_profile_text(
        "invalid-display-name",
        "displayName",
        &request.display_name,
        MAX_PROFILE_DISPLAY_NAME_BYTES,
    )?;
    let provider_id = normalize_profile_text(
        "invalid-provider-id",
        "providerId",
        &request.provider_id,
        MAX_PROFILE_PROVIDER_BYTES,
    )?;
    let model_id = normalize_profile_text(
        "invalid-model-id",
        "modelId",
        &request.model_id,
        MAX_PROFILE_MODEL_BYTES,
    )?;
    let agent_sdk_model_id = normalize_optional_profile_text(
        request.agent_sdk_model_id,
        "invalid-agent-sdk-model-id",
        "agentSdkModelId",
        MAX_PROFILE_SDK_MODEL_BYTES,
    )?;
    let endpoint = normalize_optional_profile_text(
        request.endpoint,
        "invalid-endpoint",
        "endpoint",
        MAX_PROFILE_ENDPOINT_BYTES,
    )?;
    let api_mode = normalize_profile_api_mode(&request.api_mode)?;
    let auth_style = normalize_profile_auth_style(&request.auth_style)?;
    let secret_ref = normalize_profile_secret_ref(request.secret_ref)?;
    let task_families = normalize_profile_task_families(request.task_families)?;
    let task_families_json = serialize_profile_task_families(&task_families)?;
    let max_concurrency = normalize_profile_concurrency(request.max_concurrency)?;

    with_runtime_writer(|| {
        let connection = open_profile_runtime_locked(project_root)?;
        connection
            .execute(
                "INSERT INTO runtime_model_profiles (
                    profile_id,
                    kind,
                    display_name,
                    provider_id,
                    model_id,
                    agent_sdk_model_id,
                    endpoint,
                    api_mode,
                    auth_style,
                    secret_ref,
                    enabled,
                    task_families_json,
                    max_concurrency,
                    capability_status,
                    capability_json,
                    capability_version,
                    capability_checked_at_ms,
                    probe_backoff_until_ms,
                    last_capability_error,
                    created_at_ms,
                    updated_at_ms
                ) VALUES (
                    ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10,
                    ?11, ?12, ?13, ?14, ?15, ?16, NULL, NULL, NULL, ?17, ?17
                )",
                params![
                    profile_id,
                    kind,
                    display_name,
                    provider_id,
                    model_id,
                    agent_sdk_model_id,
                    endpoint,
                    api_mode,
                    auth_style,
                    secret_ref,
                    bool_to_i64(request.enabled.unwrap_or(true)),
                    task_families_json,
                    max_concurrency,
                    DEFAULT_PROFILE_STATUS,
                    DEFAULT_PROFILE_CAPABILITY_JSON,
                    DEFAULT_PROFILE_CAPABILITY_VERSION,
                    now
                ],
            )
            .map_err(|err| format!("profile-create-failed: {err}"))?;
        read_profile(&connection, &profile_id)
    })
}

pub(crate) fn runtime_profile_update_for_project(
    project_root: Option<&Path>,
    enabled: bool,
    request: RuntimeProfileUpdateRequest,
    now: i64,
) -> Result<RuntimeProfileRecord, String> {
    let project_root = require_enabled_project(project_root, enabled)?;
    let profile_id = normalize_profile_text(
        "invalid-profile-id",
        "profileId",
        &request.profile_id,
        MAX_PROFILE_ID_BYTES,
    )?;

    with_runtime_writer(|| {
        let mut connection = open_profile_runtime_locked(project_root)?;
        let tx = connection.transaction().map_err(tx_err)?;
        let existing = read_visible_profile_tx(&tx, &profile_id)?;
        let display_name = normalize_profile_text_update(
            request.display_name,
            existing.display_name,
            "invalid-display-name",
            "displayName",
            MAX_PROFILE_DISPLAY_NAME_BYTES,
        )?;
        let provider_id = normalize_profile_text_update(
            request.provider_id,
            existing.provider_id,
            "invalid-provider-id",
            "providerId",
            MAX_PROFILE_PROVIDER_BYTES,
        )?;
        let model_id = normalize_profile_text_update(
            request.model_id,
            existing.model_id,
            "invalid-model-id",
            "modelId",
            MAX_PROFILE_MODEL_BYTES,
        )?;
        let agent_sdk_model_id = if request.clear_agent_sdk_model_id.unwrap_or(false) {
            None
        } else {
            normalize_optional_profile_text(
                request.agent_sdk_model_id,
                "invalid-agent-sdk-model-id",
                "agentSdkModelId",
                MAX_PROFILE_SDK_MODEL_BYTES,
            )?
            .or(existing.agent_sdk_model_id)
        };
        let endpoint = if request.clear_endpoint.unwrap_or(false) {
            None
        } else {
            normalize_optional_profile_text(
                request.endpoint,
                "invalid-endpoint",
                "endpoint",
                MAX_PROFILE_ENDPOINT_BYTES,
            )?
            .or(existing.endpoint)
        };
        let api_mode = normalize_profile_enum_update(
            request.api_mode,
            existing.api_mode,
            normalize_profile_api_mode,
        )?;
        let auth_style = normalize_profile_enum_update(
            request.auth_style,
            existing.auth_style,
            normalize_profile_auth_style,
        )?;
        let secret_ref = if request.clear_secret_ref.unwrap_or(false) {
            None
        } else {
            normalize_profile_secret_ref(request.secret_ref)?.or(existing.secret_ref)
        };
        let task_families_json = match request.task_families {
            Some(value) => {
                serialize_profile_task_families(&normalize_profile_task_families(value)?)?
            }
            None => serialize_profile_task_families(&existing.task_families)?,
        };
        let max_concurrency = match request.max_concurrency {
            Some(value) => normalize_profile_concurrency(Some(value))?,
            None => existing.max_concurrency,
        };
        let capability_status = normalize_profile_enum_update(
            request.capability_status,
            existing.capability_status,
            normalize_profile_capability_status,
        )?;
        let capability_json = normalize_profile_json_update(
            request.capability_json,
            existing.capability_json,
            "invalid-capability-json",
            "capabilityJson",
            MAX_PROFILE_CAPABILITY_JSON_BYTES,
        )?;
        let capability_version = normalize_profile_text_update(
            request.capability_version,
            existing.capability_version,
            "invalid-capability-version",
            "capabilityVersion",
            MAX_PROFILE_CAPABILITY_VERSION_BYTES,
        )?;
        let capability_checked_at_ms = normalize_profile_ms_update(
            request.capability_checked_at_ms,
            existing.capability_checked_at_ms,
            "invalid-capability-checked-at",
            "capabilityCheckedAtMs",
        )?;
        let probe_backoff_until_ms = normalize_profile_ms_update(
            request.probe_backoff_until_ms,
            existing.probe_backoff_until_ms,
            "invalid-probe-backoff",
            "probeBackoffUntilMs",
        )?;
        let last_capability_error = if request.clear_last_capability_error.unwrap_or(false) {
            None
        } else {
            normalize_optional_profile_text(
                request.last_capability_error,
                "invalid-capability-error",
                "lastCapabilityError",
                MAX_PROFILE_CAPABILITY_ERROR_BYTES,
            )?
            .or(existing.last_capability_error)
        };

        tx.execute(
            "UPDATE runtime_model_profiles
             SET display_name = ?2,
                 provider_id = ?3,
                 model_id = ?4,
                 agent_sdk_model_id = ?5,
                 endpoint = ?6,
                 api_mode = ?7,
                 auth_style = ?8,
                 secret_ref = ?9,
                 enabled = ?10,
                 task_families_json = ?11,
                 max_concurrency = ?12,
                 capability_status = ?13,
                 capability_json = ?14,
                 capability_version = ?15,
                 capability_checked_at_ms = ?16,
                 probe_backoff_until_ms = ?17,
                 last_capability_error = ?18,
                 updated_at_ms = ?19
             WHERE profile_id = ?1",
            params![
                profile_id,
                display_name,
                provider_id,
                model_id,
                agent_sdk_model_id,
                endpoint,
                api_mode,
                auth_style,
                secret_ref,
                bool_to_i64(request.enabled.unwrap_or(existing.enabled)),
                task_families_json,
                max_concurrency,
                capability_status,
                capability_json,
                capability_version,
                capability_checked_at_ms,
                probe_backoff_until_ms,
                last_capability_error,
                now
            ],
        )
        .map_err(|err| format!("profile-update-failed: {err}"))?;
        let profile = read_visible_profile_tx(&tx, &profile_id)?;
        tx.commit().map_err(tx_err)?;
        Ok(profile)
    })
}

fn runtime_profile_delete_for_project(
    project_root: Option<&Path>,
    enabled: bool,
    request: RuntimeProfileDeleteRequest,
    now: i64,
) -> Result<RuntimeProfileDeleteResult, String> {
    let project_root = require_enabled_project(project_root, enabled)?;
    let profile_id = normalize_profile_text(
        "invalid-profile-id",
        "profileId",
        &request.profile_id,
        MAX_PROFILE_ID_BYTES,
    )?;

    with_runtime_writer(|| {
        let mut connection = open_profile_pool_runtime_locked(project_root)?;
        let tx = connection.transaction().map_err(tx_err)?;
        expire_profile_claims_tx(&tx, now)?;
        let secret_ref = read_visible_profile_secret_ref_tx(&tx, &profile_id)?;
        let active_claims = active_profile_claim_count_tx(&tx, &profile_id, now)?;
        if active_claims > 0 {
            return Err("profile-delete-blocked: active profile claim exists".to_string());
        }
        let changed = tx
            .execute(
                "UPDATE runtime_model_profiles
                 SET deleted_at_ms = ?2,
                     updated_at_ms = ?2
                 WHERE profile_id = ?1 AND deleted_at_ms IS NULL",
                params![profile_id, now],
            )
            .map_err(|err| format!("profile-delete-failed: {err}"))?;
        if changed == 0 {
            return Err("profile-not-found: runtime model profile does not exist".to_string());
        }
        tx.commit().map_err(tx_err)?;
        Ok(RuntimeProfileDeleteResult {
            profile_id,
            deleted_at_ms: now,
            secret_ref,
        })
    })
}

pub(crate) fn runtime_profile_list_for_project(
    project_root: Option<&Path>,
    enabled: bool,
) -> Result<RuntimeProfileList, String> {
    if !enabled {
        return Ok(RuntimeProfileList {
            enabled: false,
            status: RuntimeDbHealthState::Disabled,
            profiles: Vec::new(),
        });
    }
    let Some(project_root) = project_root else {
        return Ok(RuntimeProfileList {
            enabled: true,
            status: RuntimeDbHealthState::NoProject,
            profiles: Vec::new(),
        });
    };
    let db_path = runtime_db_path(project_root);
    if !db_path.exists() {
        return Ok(RuntimeProfileList {
            enabled: true,
            status: RuntimeDbHealthState::Healthy,
            profiles: Vec::new(),
        });
    }
    let connection = Connection::open_with_flags(
        db_path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|err| format!("profile-list-open-failed: {err}"))?;
    if !table_exists(&connection, "runtime_model_profiles")? {
        return Ok(RuntimeProfileList {
            enabled: true,
            status: RuntimeDbHealthState::Healthy,
            profiles: Vec::new(),
        });
    }
    Ok(RuntimeProfileList {
        enabled: true,
        status: RuntimeDbHealthState::Healthy,
        profiles: read_visible_profiles(&connection)?,
    })
}

pub(crate) fn runtime_profile_status_for_project(
    project_root: Option<&Path>,
    enabled: bool,
    request: RuntimeProfileStatusRequest,
) -> Result<RuntimeProfileRecord, String> {
    let project_root = require_enabled_project(project_root, enabled)?;
    let profile_id = normalize_profile_text(
        "invalid-profile-id",
        "profileId",
        &request.profile_id,
        MAX_PROFILE_ID_BYTES,
    )?;
    let db_path = runtime_db_path(project_root);
    if !db_path.exists() {
        return Err("profile-not-found: runtime model profile does not exist".to_string());
    }
    let connection = Connection::open_with_flags(
        db_path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|err| format!("profile-status-open-failed: {err}"))?;
    if !table_exists(&connection, "runtime_model_profiles")? {
        return Err("profile-not-found: runtime model profile does not exist".to_string());
    }
    read_visible_profile(&connection, &profile_id)
}

pub(crate) fn normalize_profile_kind(raw: &str) -> Result<&'static str, String> {
    match raw.trim() {
        "model-call" => Ok("model-call"),
        "agent-run" => Ok("agent-run"),
        _ => Err("invalid-profile-kind: kind must be model-call or agent-run".to_string()),
    }
}

pub(crate) fn normalize_profile_api_mode(raw: &str) -> Result<&'static str, String> {
    match raw.trim() {
        "openai-chat-completions" => Ok("openai-chat-completions"),
        "anthropic-messages" => Ok("anthropic-messages"),
        "google-generate-content" => Ok("google-generate-content"),
        "local-cli" => Ok("local-cli"),
        _ => Err("invalid-api-mode: apiMode is not supported".to_string()),
    }
}

pub(crate) fn normalize_profile_auth_style(raw: &str) -> Result<&'static str, String> {
    match raw.trim() {
        "none" => Ok("none"),
        "bearer" => Ok("bearer"),
        "x-api-key" => Ok("x-api-key"),
        "api-key" => Ok("api-key"),
        "oauth-local-cli" => Ok("oauth-local-cli"),
        _ => Err("invalid-auth-style: authStyle is not supported".to_string()),
    }
}

pub(crate) fn normalize_profile_capability_status(raw: &str) -> Result<&'static str, String> {
    match raw.trim() {
        "unknown" => Ok("unknown"),
        "supported" => Ok("supported"),
        "limited" => Ok("limited"),
        "unsupported" => Ok("unsupported"),
        "error" => Ok("error"),
        _ => Err("invalid-capability-status: capabilityStatus is not supported".to_string()),
    }
}

pub(crate) fn normalize_profile_text(
    code: &str,
    field: &str,
    value: &str,
    max_bytes: usize,
) -> Result<String, String> {
    let value = require_limited_non_empty(code, field, value.trim(), max_bytes)?;
    Ok(value.to_string())
}

pub(crate) fn normalize_optional_profile_text(
    value: Option<String>,
    code: &str,
    field: &str,
    max_bytes: usize,
) -> Result<Option<String>, String> {
    value
        .map(|value| normalize_profile_text(code, field, &value, max_bytes))
        .transpose()
}

fn normalize_profile_text_update(
    value: Option<String>,
    existing: String,
    code: &str,
    field: &str,
    max_bytes: usize,
) -> Result<String, String> {
    value
        .map(|value| normalize_profile_text(code, field, &value, max_bytes))
        .transpose()
        .map(|value| value.unwrap_or(existing))
}

fn normalize_profile_enum_update(
    value: Option<String>,
    existing: String,
    normalize: fn(&str) -> Result<&'static str, String>,
) -> Result<String, String> {
    value
        .map(|value| normalize(&value).map(str::to_string))
        .transpose()
        .map(|value| value.unwrap_or(existing))
}

fn normalize_profile_json_update(
    value: Option<String>,
    existing: String,
    code: &str,
    field: &str,
    max_bytes: usize,
) -> Result<String, String> {
    value
        .map(|value| normalize_profile_json(code, field, &value, max_bytes))
        .transpose()
        .map(|value| value.unwrap_or(existing))
}

fn normalize_profile_ms_update(
    value: Option<i64>,
    existing: Option<i64>,
    code: &str,
    field: &str,
) -> Result<Option<i64>, String> {
    value
        .map(|value| normalize_non_negative_ms(code, field, value))
        .transpose()
        .map(|value| value.or(existing))
}

fn normalize_profile_secret_ref(value: Option<String>) -> Result<Option<String>, String> {
    value
        .map(|value| {
            let secret_ref = validate_profile_secret_ref(&value)?;
            Ok(secret_ref.to_string())
        })
        .transpose()
}

fn normalize_profile_task_families(value: Vec<String>) -> Result<Vec<String>, String> {
    if value.is_empty() {
        return Err("invalid-task-families: taskFamilies must not be empty".to_string());
    }
    let mut task_families = Vec::new();
    for task_family in value {
        let normalized = normalize_profile_text(
            "invalid-task-family",
            "taskFamilies",
            &task_family,
            MAX_PROFILE_TASK_FAMILY_BYTES,
        )?;
        if !task_families.contains(&normalized) {
            task_families.push(normalized);
        }
    }
    let serialized = serialize_profile_task_families(&task_families)?;
    if serialized.len() > MAX_PROFILE_TASK_FAMILIES_BYTES {
        Err(format!(
            "invalid-task-families: taskFamilies must serialize to at most {MAX_PROFILE_TASK_FAMILIES_BYTES} bytes"
        ))
    } else {
        Ok(task_families)
    }
}

fn serialize_profile_task_families(value: &[String]) -> Result<String, String> {
    serde_json::to_string(value).map_err(|err| format!("invalid-task-families: {err}"))
}

fn normalize_profile_concurrency(value: Option<i64>) -> Result<i64, String> {
    let value = value.unwrap_or(1);
    if (1..=MAX_PROFILE_CONCURRENCY).contains(&value) {
        Ok(value)
    } else {
        Err(format!(
            "invalid-max-concurrency: maxConcurrency must be between 1 and {MAX_PROFILE_CONCURRENCY}"
        ))
    }
}

fn read_profile(connection: &Connection, profile_id: &str) -> Result<RuntimeProfileRecord, String> {
    let select_sql = profile_select_sql_for_connection(connection, "WHERE profile_id = ?1")?;
    connection
        .query_row(&select_sql, [profile_id], map_profile_row)
        .map_err(|err| format!("profile-read-failed: {err}"))
}

pub(crate) fn read_visible_profile(
    connection: &Connection,
    profile_id: &str,
) -> Result<RuntimeProfileRecord, String> {
    // List/status may inspect an old runtime DB read-only before any writer has migrated it.
    if !column_exists(connection, "runtime_model_profiles", "deleted_at_ms")? {
        return read_profile(connection, profile_id);
    }
    let select_sql = profile_select_sql_for_connection(
        connection,
        "WHERE profile_id = ?1 AND deleted_at_ms IS NULL",
    )?;
    connection
        .query_row(&select_sql, [profile_id], map_profile_row)
        .optional()
        .map_err(|err| format!("profile-read-failed: {err}"))
        .and_then(|profile| {
            profile.ok_or_else(|| {
                "profile-not-found: runtime model profile does not exist".to_string()
            })
        })
}

pub(crate) fn read_visible_profile_tx(
    tx: &Transaction<'_>,
    profile_id: &str,
) -> Result<RuntimeProfileRecord, String> {
    // Writer transactions run after schema initialization, so deleted_at_ms is guaranteed.
    tx.query_row(
        &profile_select_sql("WHERE profile_id = ?1 AND deleted_at_ms IS NULL"),
        [profile_id],
        map_profile_row,
    )
    .optional()
    .map_err(|err| format!("profile-read-failed: {err}"))
    .and_then(|profile| {
        profile.ok_or_else(|| "profile-not-found: runtime model profile does not exist".to_string())
    })
}

fn read_profiles(connection: &Connection) -> Result<Vec<RuntimeProfileRecord>, String> {
    let select_sql = profile_select_sql_for_connection(
        connection,
        "ORDER BY updated_at_ms ASC, profile_id ASC",
    )?;
    let mut statement = connection
        .prepare(&select_sql)
        .map_err(|err| format!("profiles-read-prepare-failed: {err}"))?;
    let rows = statement
        .query_map([], map_profile_row)
        .map_err(|err| format!("profiles-read-failed: {err}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|err| format!("profiles-read-failed: {err}"))
}

fn read_visible_profiles(connection: &Connection) -> Result<Vec<RuntimeProfileRecord>, String> {
    // List/status may inspect an old runtime DB read-only before any writer has migrated it.
    if !column_exists(connection, "runtime_model_profiles", "deleted_at_ms")? {
        return read_profiles(connection);
    }
    let select_sql = profile_select_sql_for_connection(
        connection,
        "WHERE deleted_at_ms IS NULL ORDER BY updated_at_ms ASC, profile_id ASC",
    )?;
    let mut statement = connection
        .prepare(&select_sql)
        .map_err(|err| format!("profiles-read-prepare-failed: {err}"))?;
    let rows = statement
        .query_map([], map_profile_row)
        .map_err(|err| format!("profiles-read-failed: {err}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|err| format!("profiles-read-failed: {err}"))
}

pub(crate) fn read_visible_profiles_tx(tx: &Transaction<'_>) -> Result<Vec<RuntimeProfileRecord>, String> {
    // Writer transactions run after schema initialization, so deleted_at_ms is guaranteed.
    let mut statement = tx
        .prepare(&profile_select_sql(
            "WHERE deleted_at_ms IS NULL ORDER BY updated_at_ms ASC, profile_id ASC",
        ))
        .map_err(|err| format!("profiles-read-prepare-failed: {err}"))?;
    let rows = statement
        .query_map([], map_profile_row)
        .map_err(|err| format!("profiles-read-failed: {err}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|err| format!("profiles-read-failed: {err}"))
}

fn read_visible_profile_secret_ref_tx(
    tx: &Transaction<'_>,
    profile_id: &str,
) -> Result<Option<String>, String> {
    tx.query_row(
        "SELECT secret_ref
         FROM runtime_model_profiles
         WHERE profile_id = ?1 AND deleted_at_ms IS NULL",
        [profile_id],
        |row| row.get(0),
    )
    .optional()
    .map_err(|err| format!("profile-read-failed: {err}"))?
    .ok_or_else(|| "profile-not-found: runtime model profile does not exist".to_string())
}

fn profile_select_sql(suffix: &str) -> String {
    profile_select_sql_with_sdk_alias("agent_sdk_model_id", suffix)
}

fn legacy_profile_select_sql_without_sdk_alias(suffix: &str) -> String {
    profile_select_sql_with_sdk_alias("NULL AS agent_sdk_model_id", suffix)
}

fn profile_select_sql_with_sdk_alias(sdk_alias_column: &str, suffix: &str) -> String {
    format!(
        "SELECT profile_id,
                kind,
                display_name,
                provider_id,
                model_id,
                {sdk_alias_column},
                endpoint,
                api_mode,
                auth_style,
                secret_ref,
                enabled,
                task_families_json,
                max_concurrency,
                capability_status,
                capability_json,
                capability_version,
                capability_checked_at_ms,
                probe_backoff_until_ms,
                last_capability_error,
                created_at_ms,
                updated_at_ms
         FROM runtime_model_profiles {suffix}"
    )
}

fn profile_select_sql_for_connection(
    connection: &Connection,
    suffix: &str,
) -> Result<String, String> {
    if column_exists(connection, "runtime_model_profiles", "agent_sdk_model_id")? {
        Ok(profile_select_sql(suffix))
    } else {
        Ok(legacy_profile_select_sql_without_sdk_alias(suffix))
    }
}

fn map_profile_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<RuntimeProfileRecord> {
    Ok(RuntimeProfileRecord {
        profile_id: row.get(0)?,
        kind: row.get(1)?,
        display_name: row.get(2)?,
        provider_id: row.get(3)?,
        model_id: row.get(4)?,
        agent_sdk_model_id: row.get(5)?,
        endpoint: row.get(6)?,
        api_mode: row.get(7)?,
        auth_style: row.get(8)?,
        secret_ref: row.get(9)?,
        enabled: row.get::<_, i64>(10)? == 1,
        task_families: parse_profile_task_families(row.get(11)?)?,
        max_concurrency: row.get(12)?,
        capability_status: row.get(13)?,
        capability_json: row.get(14)?,
        capability_version: row.get(15)?,
        capability_checked_at_ms: row.get(16)?,
        probe_backoff_until_ms: row.get(17)?,
        last_capability_error: row.get(18)?,
        created_at_ms: row.get(19)?,
        updated_at_ms: row.get(20)?,
    })
}

fn parse_profile_task_families(value: String) -> rusqlite::Result<Vec<String>> {
    serde_json::from_str(&value).map_err(|err| {
        rusqlite::Error::FromSqlConversionFailure(10, rusqlite::types::Type::Text, Box::new(err))
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    
    
    use rusqlite::{params, Connection};
    
    use std::fs;
    
    
    
    
    
    
    
    


    #[test]
    fn profile_request_shapes_reject_unknown_fields() {
        let create = serde_json::from_value::<RuntimeProfileCreateRequest>(serde_json::json!({
            "profileId": "profile-1",
            "kind": "model-call",
            "displayName": "GPT-4.1",
            "providerId": "openai",
            "modelId": "gpt-4.1",
            "apiMode": "openai-chat-completions",
            "authStyle": "bearer",
            "taskFamilies": ["summarize"],
            "secretValue": "sk-test"
        }))
        .expect_err("create request rejects raw secret fields");
        assert!(create.to_string().contains("unknown field"));

        let update = serde_json::from_value::<RuntimeProfileUpdateRequest>(serde_json::json!({
            "profileId": "profile-1",
            "capabilityStatus": "limited",
            "dbPath": "/tmp/runtime.db"
        }))
        .expect_err("update request rejects dbPath");
        assert!(update.to_string().contains("unknown field"));
    }

    #[test]
    fn profile_list_returns_empty_without_migration_on_existing_runtime_db() {
        let project = temp_project("profile-list-pr2-db");
        fs::create_dir_all(&project).expect("create temp project");
        runtime_db_health_for_project(Some(&project), true).expect("create base runtime db");

        let list = runtime_profile_list_for_project(Some(&project), true).expect("list profiles");

        assert_eq!(list.status, RuntimeDbHealthState::Healthy);
        assert!(list.profiles.is_empty());
        let connection = Connection::open(runtime_db_path(&project)).expect("open runtime db");
        assert!(!table_exists(&connection, "runtime_model_profiles").expect("check table"));
        assert!(!migration_family_exists(&project, PROFILE_STATUS_FAMILY));
        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn runtime_profile_persists_agent_sdk_model_alias() {
        let project = temp_project("profile-agent-sdk-alias");
        fs::create_dir_all(&project).expect("create temp project");
        let mut create = profile_create_request("profile-1");
        create.agent_sdk_model_id = Some("claude-code-alias".to_string());

        let created =
            runtime_profile_create_for_project(Some(&project), true, create, 100).expect("create");
        assert_eq!(
            created.agent_sdk_model_id.as_deref(),
            Some("claude-code-alias")
        );

        let mut update = profile_update_request("profile-1");
        update.agent_sdk_model_id = Some("deepseek-chat".to_string());
        let updated = runtime_profile_update_for_project(Some(&project), true, update, 200)
            .expect("update alias");
        assert_eq!(updated.agent_sdk_model_id.as_deref(), Some("deepseek-chat"));

        let listed = runtime_profile_list_for_project(Some(&project), true).expect("list");
        assert_eq!(
            listed.profiles[0].agent_sdk_model_id.as_deref(),
            Some("deepseek-chat")
        );
        let status = runtime_profile_status_for_project(
            Some(&project),
            true,
            RuntimeProfileStatusRequest {
                profile_id: "profile-1".to_string(),
            },
        )
        .expect("status");
        assert_eq!(status.agent_sdk_model_id.as_deref(), Some("deepseek-chat"));

        let mut clear = profile_update_request("profile-1");
        clear.clear_agent_sdk_model_id = Some(true);
        let cleared = runtime_profile_update_for_project(Some(&project), true, clear, 300)
            .expect("clear alias");
        assert!(cleared.agent_sdk_model_id.is_none());
        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn runtime_profile_list_reads_legacy_profile_table_without_deleted_marker() {
        let project = temp_project("profile-list-legacy-no-deleted-column");
        fs::create_dir_all(&project).expect("create temp project");
        runtime_db_health_for_project(Some(&project), true).expect("create base runtime db");
        let connection = Connection::open(runtime_db_path(&project)).expect("open runtime db");
        connection
            .execute(
                "CREATE TABLE runtime_model_profiles (
                    profile_id TEXT PRIMARY KEY,
                    kind TEXT NOT NULL,
                    display_name TEXT NOT NULL,
                    provider_id TEXT NOT NULL,
                    model_id TEXT NOT NULL,
                    endpoint TEXT,
                    api_mode TEXT NOT NULL,
                    auth_style TEXT NOT NULL,
                    secret_ref TEXT,
                    enabled INTEGER NOT NULL,
                    task_families_json TEXT NOT NULL,
                    max_concurrency INTEGER NOT NULL,
                    capability_status TEXT NOT NULL,
                    capability_json TEXT NOT NULL,
                    capability_version TEXT NOT NULL,
                    capability_checked_at_ms INTEGER,
                    probe_backoff_until_ms INTEGER,
                    last_capability_error TEXT,
                    created_at_ms INTEGER NOT NULL,
                    updated_at_ms INTEGER NOT NULL
                )",
                [],
            )
            .expect("create legacy profile table");
        connection
            .execute(
                "INSERT INTO runtime_model_profiles (
                    profile_id,
                    kind,
                    display_name,
                    provider_id,
                    model_id,
                    endpoint,
                    api_mode,
                    auth_style,
                    secret_ref,
                    enabled,
                    task_families_json,
                    max_concurrency,
                    capability_status,
                    capability_json,
                    capability_version,
                    capability_checked_at_ms,
                    probe_backoff_until_ms,
                    last_capability_error,
                    created_at_ms,
                    updated_at_ms
                ) VALUES (
                    ?1, 'model-call', 'Legacy profile', 'openai', 'gpt-4.1',
                    NULL, 'openai-chat-completions', 'bearer', NULL, 1,
                    '[\"chat\"]', 1, 'unknown', '{}', ?2,
                    NULL, NULL, NULL, 100, 100
                )",
                params!["profile-legacy", DEFAULT_PROFILE_CAPABILITY_VERSION],
            )
            .expect("insert legacy profile");
        assert!(
            !column_exists(&connection, "runtime_model_profiles", "deleted_at_ms")
                .expect("check missing deleted marker")
        );
        assert!(
            !column_exists(&connection, "runtime_model_profiles", "agent_sdk_model_id")
                .expect("check missing sdk alias")
        );
        drop(connection);

        let list = runtime_profile_list_for_project(Some(&project), true)
            .expect("legacy profile list works read-only");
        assert_eq!(list.profiles.len(), 1);
        assert_eq!(list.profiles[0].profile_id, "profile-legacy");
        assert!(list.profiles[0].agent_sdk_model_id.is_none());
        let status = runtime_profile_status_for_project(
            Some(&project),
            true,
            RuntimeProfileStatusRequest {
                profile_id: "profile-legacy".to_string(),
            },
        )
        .expect("legacy profile status works read-only");
        assert_eq!(status.display_name, "Legacy profile");
        assert!(status.agent_sdk_model_id.is_none());
        let connection = Connection::open(runtime_db_path(&project)).expect("reopen runtime db");
        assert!(
            !column_exists(&connection, "runtime_model_profiles", "deleted_at_ms")
                .expect("read-only paths did not migrate")
        );
        assert!(
            !column_exists(&connection, "runtime_model_profiles", "agent_sdk_model_id")
                .expect("read-only paths did not migrate sdk alias")
        );
        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn profile_schema_preserves_existing_higher_migration_version() {
        let project = temp_project("profile-higher-version");
        fs::create_dir_all(&project).expect("create temp project");
        runtime_db_health_for_project(Some(&project), true).expect("create base runtime db");
        let connection = Connection::open(runtime_db_path(&project)).expect("open runtime db");
        connection
            .execute(
                "INSERT INTO runtime_schema_migrations (
                    family,
                    version,
                    applied_at_ms
                ) VALUES (?1, ?2, ?3)",
                params![PROFILE_STATUS_FAMILY, 2_i64, 42_i64],
            )
            .expect("seed higher profile migration");
        drop(connection);

        runtime_profile_create_for_project(
            Some(&project),
            true,
            profile_create_request("profile-1"),
            100,
        )
        .expect("create profile");
        let migration = read_migration_family(&project, PROFILE_STATUS_FAMILY);

        assert_eq!(
            migration,
            RuntimeDbMigrationStatus {
                family: PROFILE_STATUS_FAMILY.to_string(),
                version: 2,
                applied_at_ms: 42,
            }
        );
        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn runtime_profile_delete_blocks_active_claims_without_soft_deleting() {
        let project = temp_project("profile-delete-active-claim");
        fs::create_dir_all(&project).expect("create temp project");
        create_profile_pool_profile(
            &project,
            "profile-1",
            "model-call",
            true,
            1,
            profile_pool_capability_json(serde_json::json!(true), serde_json::json!(false)),
        );
        runtime_profile_pool_claim_for_project(
            Some(&project),
            true,
            profile_pool_claim_request("claim-1", vec!["profile-1"]),
            200,
        )
        .expect("claim profile");

        let error = runtime_profile_delete_for_project(
            Some(&project),
            true,
            RuntimeProfileDeleteRequest {
                profile_id: "profile-1".to_string(),
            },
            300,
        )
        .expect_err("active claim blocks delete");

        assert!(error.contains("profile-delete-blocked"));
        let status = runtime_profile_status_for_project(
            Some(&project),
            true,
            RuntimeProfileStatusRequest {
                profile_id: "profile-1".to_string(),
            },
        )
        .expect("profile remains visible");
        assert_eq!(status.profile_id, "profile-1");
        let connection = Connection::open(runtime_db_path(&project)).expect("open runtime db");
        let deleted_at: Option<i64> = connection
            .query_row(
                "SELECT deleted_at_ms FROM runtime_model_profiles WHERE profile_id = ?1",
                ["profile-1"],
                |row| row.get(0),
            )
            .expect("read deleted marker");
        assert_eq!(deleted_at, None);
        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn runtime_profile_delete_sweeps_expired_claims_and_filters_default_reads() {
        let project = temp_project("profile-delete-expired-claim");
        fs::create_dir_all(&project).expect("create temp project");
        create_profile_pool_profile(
            &project,
            "profile-1",
            "model-call",
            true,
            1,
            profile_pool_capability_json(serde_json::json!(true), serde_json::json!(false)),
        );
        let mut claim = profile_pool_claim_request("claim-1", vec!["profile-1"]);
        claim.ttl_ms = Some(1_000);
        runtime_profile_pool_claim_for_project(Some(&project), true, claim, 200)
            .expect("claim profile");

        let deleted = runtime_profile_delete_for_project(
            Some(&project),
            true,
            RuntimeProfileDeleteRequest {
                profile_id: "profile-1".to_string(),
            },
            1_300,
        )
        .expect("delete after claim expiry");

        assert_eq!(deleted.profile_id, "profile-1");
        assert_eq!(deleted.deleted_at_ms, 1_300);
        assert_eq!(
            deleted.secret_ref.as_deref(),
            Some(profile_secret_ref("profile-1").as_str())
        );
        let list = runtime_profile_list_for_project(Some(&project), true).expect("list profiles");
        assert!(list.profiles.is_empty());
        let status_error = runtime_profile_status_for_project(
            Some(&project),
            true,
            RuntimeProfileStatusRequest {
                profile_id: "profile-1".to_string(),
            },
        )
        .expect_err("deleted profile is hidden from status");
        assert!(status_error.contains("profile-not-found"));
        let claim_error = runtime_profile_pool_claim_for_project(
            Some(&project),
            true,
            profile_pool_claim_request("claim-2", vec!["profile-1"]),
            1_350,
        )
        .expect_err("deleted profile cannot be claimed");
        assert!(claim_error.contains("no-eligible-profile"));
        let connection = Connection::open(runtime_db_path(&project)).expect("open runtime db");
        let (claim_count, claim_status): (i64, String) = connection
            .query_row(
                "SELECT COUNT(*), MAX(status)
                 FROM runtime_profile_claims
                 WHERE profile_id = ?1",
                ["profile-1"],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("read historical claim");
        assert_eq!(claim_count, 1);
        assert_eq!(claim_status, EXPIRED_CLAIM_STATUS);
        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn profile_update_preserves_nullable_fields_until_clear_flags_are_set() {
        let project = temp_project("profile-update-clear-flags");
        fs::create_dir_all(&project).expect("create temp project");
        let mut create = profile_create_request("profile-clear");
        create.endpoint = Some("https://api.openai.example/v1".to_string());
        runtime_profile_create_for_project(Some(&project), true, create, 100)
            .expect("create profile");

        let mut seed_error = profile_update_request("profile-clear");
        seed_error.last_capability_error = Some("temporary outage".to_string());
        runtime_profile_update_for_project(Some(&project), true, seed_error, 150)
            .expect("seed nullable fields");

        let mut rename_only = profile_update_request("profile-clear");
        rename_only.display_name = Some("Renamed profile".to_string());
        let preserved = runtime_profile_update_for_project(Some(&project), true, rename_only, 200)
            .expect("rename preserves nullable fields");

        assert_eq!(preserved.display_name, "Renamed profile");
        assert_eq!(
            preserved.endpoint.as_deref(),
            Some("https://api.openai.example/v1")
        );
        assert_eq!(
            preserved.secret_ref.as_deref(),
            Some(profile_secret_ref("profile-clear").as_str())
        );
        assert_eq!(
            preserved.last_capability_error.as_deref(),
            Some("temporary outage")
        );

        let mut clear_secret = profile_update_request("profile-clear");
        clear_secret.clear_secret_ref = Some(true);
        let secret_cleared =
            runtime_profile_update_for_project(Some(&project), true, clear_secret, 225)
                .expect("clear secret ref");

        assert_eq!(
            secret_cleared.endpoint.as_deref(),
            Some("https://api.openai.example/v1")
        );
        assert!(secret_cleared.secret_ref.is_none());
        assert_eq!(
            secret_cleared.last_capability_error.as_deref(),
            Some("temporary outage")
        );

        let mut clear = profile_update_request("profile-clear");
        clear.clear_endpoint = Some(true);
        clear.clear_last_capability_error = Some(true);
        let cleared = runtime_profile_update_for_project(Some(&project), true, clear, 250)
            .expect("clear nullable fields");

        assert!(cleared.endpoint.is_none());
        assert!(cleared.secret_ref.is_none());
        assert!(cleared.last_capability_error.is_none());
        let _ = fs::remove_dir_all(project);
    }
}
