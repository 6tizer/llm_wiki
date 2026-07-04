use crate::commands::file_sync::ProjectRootState;
use crate::panic_guard::run_guarded;
use rusqlite::{
    params, params_from_iter, Connection, OpenFlags, OptionalExtension, ToSql, Transaction,
};
use std::path::Path;
use tauri::State;

use super::*;
use crate::commands::profile_secrets::{read_profile_secret, SecretStore};
use uuid::Uuid;

/// Claim one eligible profile-pool slot for the currently-open project.
#[tauri::command]
pub fn runtime_profile_pool_claim(
    request: RuntimeProfilePoolClaimRequest,
    root_state: State<'_, ProjectRootState>,
) -> Result<RuntimeProfilePoolClaim, String> {
    run_guarded("runtime_profile_pool_claim", || {
        let runtime_enabled = resolve_work_runtime_enabled(read_work_runtime_flag_value());
        let project_root = root_state.get();
        let now = now_for_enabled_project(project_root.as_deref(), runtime_enabled)?;
        runtime_profile_pool_claim_for_project(
            project_root.as_deref(),
            runtime_enabled,
            request,
            now,
        )
    })
}

/// Release one active profile-pool claim for the currently-open project.
#[tauri::command]
pub fn runtime_profile_pool_release(
    request: RuntimeProfilePoolReleaseRequest,
    root_state: State<'_, ProjectRootState>,
) -> Result<RuntimeProfilePoolRelease, String> {
    run_guarded("runtime_profile_pool_release", || {
        let runtime_enabled = resolve_work_runtime_enabled(read_work_runtime_flag_value());
        let project_root = root_state.get();
        let now = now_for_enabled_project(project_root.as_deref(), runtime_enabled)?;
        runtime_profile_pool_release_for_project(
            project_root.as_deref(),
            runtime_enabled,
            request,
            now,
        )
    })
}

/// Renew one active profile-pool claim for the currently-open project.
#[tauri::command]
pub fn runtime_profile_pool_renew(
    request: RuntimeProfilePoolRenewRequest,
    root_state: State<'_, ProjectRootState>,
) -> Result<RuntimeProfilePoolRenew, String> {
    run_guarded("runtime_profile_pool_renew", || {
        let runtime_enabled = resolve_work_runtime_enabled(read_work_runtime_flag_value());
        let project_root = root_state.get();
        let now = now_for_enabled_project(project_root.as_deref(), runtime_enabled)?;
        runtime_profile_pool_renew_for_project(
            project_root.as_deref(),
            runtime_enabled,
            request,
            now,
        )
    })
}

/// List active profile-pool claims and open circuit breakers for observability.
#[tauri::command]
pub fn runtime_profile_pool_list(
    request: Option<RuntimeProfilePoolListRequest>,
    root_state: State<'_, ProjectRootState>,
) -> Result<RuntimeProfilePoolList, String> {
    run_guarded("runtime_profile_pool_list", || {
        let runtime_enabled = resolve_work_runtime_enabled(read_work_runtime_flag_value());
        let now = now_ms()?;
        runtime_profile_pool_list_for_project(
            root_state.get().as_deref(),
            runtime_enabled,
            request.unwrap_or(RuntimeProfilePoolListRequest {
                kind: None,
                task_family: None,
                job_id: None,
            }),
            now,
        )
    })
}

pub(crate) fn runtime_profile_pool_claim_for_project(
    project_root: Option<&Path>,
    enabled: bool,
    request: RuntimeProfilePoolClaimRequest,
    now: i64,
) -> Result<RuntimeProfilePoolClaim, String> {
    let project_root = require_enabled_project(project_root, enabled)?;
    let kind = normalize_profile_kind(&request.kind)?.to_string();
    let task_family = normalize_profile_text(
        "invalid-task-family",
        "taskFamily",
        &request.task_family,
        MAX_PROFILE_TASK_FAMILY_BYTES,
    )?;
    let holder = normalize_profile_text(
        "invalid-holder",
        "holder",
        &request.holder,
        MAX_PROFILE_DISPLAY_NAME_BYTES,
    )?;
    let claim_id = match request.claim_id {
        Some(claim_id) => normalize_profile_text(
            "invalid-claim-id",
            "claimId",
            &claim_id,
            MAX_PROFILE_ID_BYTES,
        )?,
        None => Uuid::new_v4().to_string(),
    };
    let job_id = normalize_optional_filter("invalid-job-id", "jobId", request.job_id)?;
    let ttl_ms = normalize_profile_pool_ttl(request.ttl_ms)?;
    let expires_at_ms = checked_profile_pool_deadline(now, ttl_ms, "invalid-ttl")?;
    let preferred_profile_ids = normalize_preferred_profile_ids(request.preferred_profile_ids)?;

    with_runtime_writer(|| {
        let mut connection = open_profile_pool_runtime_locked(project_root)?;
        let tx = connection.transaction().map_err(tx_err)?;
        ensure_profile_claim_id_available_tx(&tx, &claim_id)?;
        if let Some(job_id) = job_id.as_deref() {
            ensure_job_exists(&tx, job_id)?;
        }
        expire_profile_claims_tx(&tx, now)?;

        let profiles = read_visible_profiles_tx(&tx)?;
        let mut eligible = Vec::new();
        for profile in profiles {
            if profile_pool_profile_eligible(&tx, &profile, &kind, &task_family, now)? {
                eligible.push(profile);
            }
        }
        let selected = select_profile_pool_candidate(&eligible, &preferred_profile_ids)
            .ok_or_else(|| {
                "no-eligible-profile: no profile pool capacity is available".to_string()
            })?;

        tx.execute(
            "INSERT INTO runtime_profile_claims (
                claim_id,
                profile_id,
                kind,
                task_family,
                job_id,
                holder,
                acquired_at_ms,
                expires_at_ms,
                status
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                claim_id,
                selected.profile_id,
                kind,
                task_family,
                job_id,
                holder,
                now,
                expires_at_ms,
                ACTIVE_CLAIM_STATUS
            ],
        )
        .map_err(|err| format!("profile-pool-claim-insert-failed: {err}"))?;

        let event_id = if let Some(job_id) = job_id.as_deref() {
            let payload = profile_pool_claim_event_payload(
                &claim_id,
                &selected.profile_id,
                &kind,
                &task_family,
                &holder,
                expires_at_ms,
            )?;
            Some(insert_runtime_event_tx(
                &tx,
                None,
                job_id,
                PROFILE_POOL_CLAIMED_NAME,
                &payload,
                now,
            )?)
        } else {
            None
        };
        if let Some(job_id) = job_id.as_deref() {
            let payload = profile_pool_progress_payload(
                &claim_id,
                &selected.profile_id,
                "claimed",
                expires_at_ms,
                None,
            )?;
            upsert_runtime_progress_tx(
                &tx,
                job_id,
                &profile_pool_progress_key(&claim_id),
                &payload,
                now,
                event_id.as_deref(),
            )?;
        }

        let claim = read_profile_claim_tx(&tx, &claim_id)?;
        tx.commit().map_err(tx_err)?;
        Ok(RuntimeProfilePoolClaim {
            claim_id,
            profile_id: selected.profile_id.clone(),
            expires_at_ms,
            claim,
        })
    })
}

fn runtime_profile_pool_release_for_project(
    project_root: Option<&Path>,
    enabled: bool,
    request: RuntimeProfilePoolReleaseRequest,
    now: i64,
) -> Result<RuntimeProfilePoolRelease, String> {
    let project_root = require_enabled_project(project_root, enabled)?;
    let claim_id = normalize_profile_text(
        "invalid-claim-id",
        "claimId",
        &request.claim_id,
        MAX_PROFILE_ID_BYTES,
    )?;
    let outcome = normalize_profile_pool_outcome(&request.outcome)?;
    let retry_after_ms = request
        .retry_after_ms
        .map(|value| {
            normalize_profile_pool_breaker_duration("invalid-retry-after", "retryAfterMs", value)
        })
        .transpose()?;
    let circuit_open_ms = request
        .circuit_open_ms
        .map(|value| {
            normalize_profile_pool_breaker_duration("invalid-circuit-open", "circuitOpenMs", value)
        })
        .transpose()?;
    let reason = sanitize_profile_pool_optional_text(request.reason)?;
    let error = sanitize_profile_pool_optional_text(request.error)?;

    with_runtime_writer(|| {
        let mut connection = open_profile_pool_runtime_locked(project_root)?;
        let tx = connection.transaction().map_err(tx_err)?;
        let active = read_active_profile_claim_by_id_tx(&tx, &claim_id, now)?
            .ok_or_else(|| PROFILE_CLAIM_INACTIVE_ERROR.to_string())?;

        let breaker_until = match outcome {
            "success" => {
                clear_profile_circuit_breaker_tx(&tx, &active.profile_id)?;
                None
            }
            "rate-limited" => {
                let retry_after_ms = retry_after_ms.ok_or_else(|| {
                    "invalid-retry-after: retryAfterMs is required for rate-limited releases"
                        .to_string()
                })?;
                let open_until_ms =
                    checked_profile_pool_deadline(now, retry_after_ms, "invalid-retry-after")?;
                upsert_profile_circuit_breaker_tx(
                    &tx,
                    &active.profile_id,
                    "rate-limited",
                    reason.as_deref(),
                    error.as_deref(),
                    now,
                    open_until_ms,
                )?;
                Some(open_until_ms)
            }
            "error" => {
                if let Some(circuit_open_ms) = circuit_open_ms {
                    let open_until_ms = checked_profile_pool_deadline(
                        now,
                        circuit_open_ms,
                        "invalid-circuit-open",
                    )?;
                    upsert_profile_circuit_breaker_tx(
                        &tx,
                        &active.profile_id,
                        "error",
                        reason.as_deref(),
                        error.as_deref(),
                        now,
                        open_until_ms,
                    )?;
                    Some(open_until_ms)
                } else {
                    None
                }
            }
            _ => unreachable!("normalized profile pool outcome"),
        };

        let updated = tx
            .execute(
                "UPDATE runtime_profile_claims
                 SET status = ?2,
                     released_at_ms = ?3
                 WHERE claim_id = ?1
                   AND status = ?4
                   AND expires_at_ms > ?3",
                params![claim_id, RELEASED_CLAIM_STATUS, now, ACTIVE_CLAIM_STATUS],
            )
            .map_err(|err| format!("profile-pool-release-update-failed: {err}"))?;
        if updated != 1 {
            return Err(PROFILE_CLAIM_INACTIVE_ERROR.to_string());
        }

        let released = read_profile_claim_tx(&tx, &claim_id)?;
        let circuit_breaker = read_profile_circuit_breaker_optional_tx(&tx, &active.profile_id)?;
        if let Some(job_id) = active.job_id.as_deref() {
            let payload = profile_pool_release_event_payload(
                &released,
                outcome,
                breaker_until,
                reason.as_deref(),
            )?;
            let event_id = insert_runtime_event_tx(
                &tx,
                None,
                job_id,
                PROFILE_POOL_RELEASED_NAME,
                &payload,
                now,
            )?;
            let progress_payload = profile_pool_progress_payload(
                &released.claim_id,
                &released.profile_id,
                outcome,
                released.expires_at_ms,
                breaker_until,
            )?;
            upsert_runtime_progress_tx(
                &tx,
                job_id,
                &profile_pool_progress_key(&released.claim_id),
                &progress_payload,
                now,
                Some(&event_id),
            )?;
        }

        tx.commit().map_err(tx_err)?;
        Ok(RuntimeProfilePoolRelease {
            claim: released,
            circuit_breaker,
        })
    })
}

pub(crate) fn release_agent_profile_claim_for_project(
    project_root: Option<&Path>,
    enabled: bool,
    claim_id: &str,
    outcome: &str,
    error: Option<&str>,
) -> Result<(), String> {
    let now = now_ms()?;
    let diagnostic = error.and_then(classify_agent_profile_error);
    let release = RuntimeProfilePoolReleaseRequest {
        claim_id: claim_id.to_string(),
        outcome: outcome.to_string(),
        retry_after_ms: None,
        circuit_open_ms: diagnostic.map(|_| DEFAULT_RETRY_BACKOFF_MS),
        reason: Some(
            diagnostic
                .map(str::to_string)
                .unwrap_or_else(|| AGENT_PROFILE_RELEASE_REASON.to_string()),
        ),
        error: error.map(str::to_string),
    };
    match runtime_profile_pool_release_for_project(project_root, enabled, release, now) {
        Ok(_) => Ok(()),
        Err(err) if profile_claim_inactive_error(&err) => Ok(()),
        Err(err) => Err(err),
    }
}

fn classify_agent_profile_error(error: &str) -> Option<&'static str> {
    let normalized = error.to_ascii_lowercase();
    // Claude Agent SDK reports unavailable model aliases with these stable fragments.
    const SDK_MODEL_REJECTED_FRAGMENTS: &[&str] = &[
        "selected model",
        "model may not exist",
        "not have access to it",
        "run --model",
    ];
    // Gateway providers usually surface bad credentials as explicit HTTP auth failures.
    const GATEWAY_AUTH_FAILED_FRAGMENTS: &[&str] = &[
        "authentication failed",
        "authentication error",
        "authorization failed",
        "auth failed",
        "invalid api key",
        "invalid x-api-key",
    ];

    if SDK_MODEL_REJECTED_FRAGMENTS
        .iter()
        .any(|fragment| normalized.contains(fragment))
    {
        return Some(AGENT_PROFILE_SDK_MODEL_REJECTED_REASON);
    }
    if GATEWAY_AUTH_FAILED_FRAGMENTS
        .iter()
        .any(|fragment| normalized.contains(fragment))
        || contains_gateway_auth_status(&normalized)
    {
        return Some(AGENT_PROFILE_GATEWAY_AUTH_FAILED_REASON);
    }
    None
}

fn contains_gateway_auth_status(normalized_error: &str) -> bool {
    const AUTH_STATUS_FRAGMENTS: &[&str] = &[
        "http 401",
        "http 403",
        "status 401",
        "status 403",
        "status code 401",
        "status code 403",
        "401 unauthorized",
        "403 forbidden",
    ];
    AUTH_STATUS_FRAGMENTS
        .iter()
        .any(|fragment| normalized_error.contains(fragment))
}

pub(crate) fn renew_agent_profile_claim_for_project(
    project_root: Option<&Path>,
    enabled: bool,
    claim_id: &str,
) -> Result<RuntimeProfilePoolRenew, String> {
    let now = now_ms()?;
    runtime_profile_pool_renew_for_project(
        project_root,
        enabled,
        RuntimeProfilePoolRenewRequest {
            claim_id: claim_id.to_string(),
            ttl_ms: Some(MAX_PROFILE_POOL_TTL_MS),
        },
        now,
    )
}

fn runtime_profile_pool_renew_for_project(
    project_root: Option<&Path>,
    enabled: bool,
    request: RuntimeProfilePoolRenewRequest,
    now: i64,
) -> Result<RuntimeProfilePoolRenew, String> {
    let project_root = require_enabled_project(project_root, enabled)?;
    let claim_id = normalize_profile_text(
        "invalid-claim-id",
        "claimId",
        &request.claim_id,
        MAX_PROFILE_ID_BYTES,
    )?;
    let ttl_ms = normalize_profile_pool_ttl(request.ttl_ms)?;
    let expires_at_ms = checked_profile_pool_deadline(now, ttl_ms, "invalid-ttl")?;

    with_runtime_writer(|| {
        let mut connection = open_profile_pool_runtime_locked(project_root)?;
        let tx = connection.transaction().map_err(tx_err)?;
        expire_profile_claims_tx(&tx, now)?;
        let active = read_active_profile_claim_by_id_tx(&tx, &claim_id, now)?
            .ok_or_else(|| PROFILE_CLAIM_INACTIVE_ERROR.to_string())?;
        let updated = tx
            .execute(
                "UPDATE runtime_profile_claims
                 SET expires_at_ms = ?2
                 WHERE claim_id = ?1
                   AND status = ?3
                   AND released_at_ms IS NULL
                   AND expires_at_ms > ?4",
                params![claim_id, expires_at_ms, ACTIVE_CLAIM_STATUS, now],
            )
            .map_err(|err| format!("profile-pool-renew-update-failed: {err}"))?;
        if updated != 1 {
            return Err(PROFILE_CLAIM_INACTIVE_ERROR.to_string());
        }
        let claim = read_profile_claim_tx(&tx, &claim_id)?;
        tx.commit().map_err(tx_err)?;
        Ok(RuntimeProfilePoolRenew {
            claim_id,
            profile_id: active.profile_id,
            expires_at_ms,
            claim,
        })
    })
}

pub(crate) fn resolve_agent_run_profile_for_project_with_store(
    project_root: Option<&Path>,
    enabled: bool,
    profile_id: &str,
    claim_id: &str,
    store: &impl SecretStore,
) -> Result<AgentRunProfileConfig, String> {
    let now = now_ms()?;
    resolve_agent_run_profile_for_project_at_with_store(
        project_root,
        enabled,
        profile_id,
        claim_id,
        now,
        store,
    )
}

fn resolve_agent_run_profile_for_project_at_with_store(
    project_root: Option<&Path>,
    enabled: bool,
    profile_id: &str,
    claim_id: &str,
    now: i64,
    store: &impl SecretStore,
) -> Result<AgentRunProfileConfig, String> {
    let project_root = require_enabled_project(project_root, enabled)?;
    let profile_id = normalize_profile_text(
        "invalid-profile-id",
        "profileId",
        profile_id,
        MAX_PROFILE_ID_BYTES,
    )?;
    let claim_id = normalize_profile_text(
        "invalid-claim-id",
        "claimId",
        claim_id,
        MAX_PROFILE_ID_BYTES,
    )?;

    let (profile, claim) = with_runtime_writer(|| {
        let mut connection = open_profile_pool_runtime_locked(project_root)?;
        let tx = connection.transaction().map_err(tx_err)?;
        expire_profile_claims_tx(&tx, now)?;
        let claim = read_active_profile_claim_by_id_tx(&tx, &claim_id, now)?
            .ok_or_else(|| PROFILE_CLAIM_INACTIVE_ERROR.to_string())?;
        if claim.profile_id != profile_id {
            return Err(
                "profile-claim-mismatch: profileId does not match the active claim".to_string(),
            );
        }
        if claim.kind != "agent-run" || claim.task_family != "agent" {
            return Err("profile-unsupported: claim is not for an agent-run profile".to_string());
        }
        let profile = read_visible_profile_tx(&tx, &profile_id)?;
        if !profile_pool_profile_base_eligible(&tx, &profile, "agent-run", "agent", now)? {
            return Err(
                "profile-unsupported: profile is not eligible for Agent-run sidecar use"
                    .to_string(),
            );
        }
        tx.commit().map_err(tx_err)?;
        Ok((profile, claim))
    })?;

    if profile.profile_id != claim.profile_id {
        return Err(
            "profile-claim-mismatch: profileId does not match the active claim".to_string(),
        );
    }

    let secret_value = if profile_secret_required(&profile.auth_style) {
        let secret_ref = profile.secret_ref.as_deref().ok_or_else(|| {
            "profile-missing-secret: stored Agent-run profile has no secretRef".to_string()
        })?;
        Some(read_profile_secret(store, secret_ref)?)
    } else {
        None
    };

    Ok(AgentRunProfileConfig {
        profile_id: profile.profile_id,
        agent_sdk_model_id: profile
            .agent_sdk_model_id
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| profile.model_id.clone()),
        provider_model_id: profile.model_id,
        endpoint: profile.endpoint,
        auth_style: profile.auth_style,
        secret_value,
    })
}

fn runtime_profile_pool_list_for_project(
    project_root: Option<&Path>,
    enabled: bool,
    request: RuntimeProfilePoolListRequest,
    now: i64,
) -> Result<RuntimeProfilePoolList, String> {
    if !enabled {
        return Ok(RuntimeProfilePoolList {
            enabled: false,
            status: RuntimeDbHealthState::Disabled,
            active_claims: Vec::new(),
            circuit_breakers: Vec::new(),
        });
    }
    let Some(project_root) = project_root else {
        return Ok(RuntimeProfilePoolList {
            enabled: true,
            status: RuntimeDbHealthState::NoProject,
            active_claims: Vec::new(),
            circuit_breakers: Vec::new(),
        });
    };
    let kind = request
        .kind
        .as_deref()
        .map(normalize_profile_kind)
        .transpose()?;
    let task_family = request
        .task_family
        .map(|value| {
            normalize_profile_text(
                "invalid-task-family",
                "taskFamily",
                &value,
                MAX_PROFILE_TASK_FAMILY_BYTES,
            )
        })
        .transpose()?;
    let job_id = normalize_optional_filter("invalid-job-id", "jobId", request.job_id)?;
    let db_path = runtime_db_path(project_root);
    if !db_path.exists() {
        return Ok(RuntimeProfilePoolList {
            enabled: true,
            status: RuntimeDbHealthState::Healthy,
            active_claims: Vec::new(),
            circuit_breakers: Vec::new(),
        });
    }
    let connection = Connection::open_with_flags(
        db_path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|err| format!("profile-pool-list-open-failed: {err}"))?;
    if !table_exists(&connection, "runtime_profile_claims")?
        || !table_exists(&connection, "runtime_profile_circuit_breakers")?
    {
        return Ok(RuntimeProfilePoolList {
            enabled: true,
            status: RuntimeDbHealthState::Healthy,
            active_claims: Vec::new(),
            circuit_breakers: Vec::new(),
        });
    }
    Ok(RuntimeProfilePoolList {
        enabled: true,
        status: RuntimeDbHealthState::Healthy,
        active_claims: read_active_profile_claims(
            &connection,
            now,
            kind,
            task_family.as_deref(),
            job_id.as_deref(),
        )?,
        circuit_breakers: read_open_profile_circuit_breakers(&connection, now)?,
    })
}

fn normalize_profile_pool_ttl(ttl_ms: Option<i64>) -> Result<i64, String> {
    let ttl_ms = ttl_ms.unwrap_or(DEFAULT_LEASE_TTL_MS);
    if (MIN_PROFILE_POOL_TTL_MS..=MAX_PROFILE_POOL_TTL_MS).contains(&ttl_ms) {
        Ok(ttl_ms)
    } else {
        Err(format!(
            "invalid-ttl: ttlMs must be between {MIN_PROFILE_POOL_TTL_MS} and {MAX_PROFILE_POOL_TTL_MS}"
        ))
    }
}

fn normalize_profile_pool_breaker_duration(
    code: &str,
    field: &str,
    value: i64,
) -> Result<i64, String> {
    if (1..=MAX_PROFILE_POOL_BREAKER_MS).contains(&value) {
        Ok(value)
    } else {
        Err(format!(
            "{code}: {field} must be between 1 and {MAX_PROFILE_POOL_BREAKER_MS}"
        ))
    }
}

fn checked_profile_pool_deadline(now: i64, duration_ms: i64, code: &str) -> Result<i64, String> {
    now.checked_add(duration_ms)
        .ok_or_else(|| format!("{code}: profile pool deadline overflow"))
}

fn normalize_profile_pool_outcome(raw: &str) -> Result<&'static str, String> {
    match raw.trim() {
        "success" => Ok("success"),
        "rate-limited" => Ok("rate-limited"),
        "error" => Ok("error"),
        _ => Err("invalid-outcome: outcome must be success, rate-limited, or error".to_string()),
    }
}

fn profile_claim_inactive_error(err: &str) -> bool {
    err.starts_with(PROFILE_CLAIM_INACTIVE_PREFIX)
}

fn normalize_preferred_profile_ids(value: Option<Vec<String>>) -> Result<Vec<String>, String> {
    let mut ids = Vec::new();
    for raw in value.unwrap_or_default() {
        let Ok(profile_id) = normalize_profile_text(
            "invalid-profile-id",
            "preferredProfileIds",
            &raw,
            MAX_PROFILE_ID_BYTES,
        ) else {
            continue;
        };
        if !ids.contains(&profile_id) {
            ids.push(profile_id);
        }
    }
    Ok(ids)
}

fn sanitize_profile_pool_optional_text(value: Option<String>) -> Result<Option<String>, String> {
    let Some(value) = value else {
        return Ok(None);
    };
    let redacted = sanitize_profile_pool_text_for_log(&value);
    if redacted.is_empty() {
        return Ok(None);
    }
    Ok(Some(redacted))
}

/// Redacts profile-pool diagnostic text before it reaches logs or UI payloads.
pub(crate) fn sanitize_profile_pool_text_for_log(value: &str) -> String {
    let normalized = value
        .chars()
        .map(|value| if value.is_control() { ' ' } else { value })
        .collect::<String>();
    let trimmed = normalized.split_whitespace().collect::<Vec<_>>().join(" ");
    if trimmed.is_empty() {
        return String::new();
    }
    truncate_profile_pool_text(&redact_profile_pool_text(&trimmed))
}

fn redact_profile_pool_text(value: &str) -> String {
    // sanitize_profile_pool_text_for_log (the only production caller) already
    // collapses whitespace via split_whitespace().join(" ") before calling
    // this, so redacting on that pre-collapsed single-space form and
    // delegating to redact_secrets_preserving_format is equivalent to the
    // previous standalone whitespace-collapsing implementation.
    let collapsed = value.split_whitespace().collect::<Vec<_>>().join(" ");
    redact_secrets_preserving_format(&collapsed)
}

fn truncate_profile_pool_text(value: &str) -> String {
    if value.len() <= MAX_PROFILE_POOL_REASON_BYTES {
        return value.to_string();
    }
    let mut end = MAX_PROFILE_POOL_REASON_BYTES;
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    value[..end].to_string()
}

fn profile_pool_profile_eligible(
    tx: &Transaction<'_>,
    profile: &RuntimeProfileRecord,
    kind: &str,
    task_family: &str,
    now: i64,
) -> Result<bool, String> {
    if !profile_pool_profile_base_eligible(tx, profile, kind, task_family, now)? {
        return Ok(false);
    }
    let active_count = active_profile_claim_count_tx(tx, &profile.profile_id, now)?;
    Ok(active_count < profile.max_concurrency)
}

pub(crate) fn profile_pool_profile_base_eligible(
    tx: &Transaction<'_>,
    profile: &RuntimeProfileRecord,
    kind: &str,
    task_family: &str,
    now: i64,
) -> Result<bool, String> {
    if !profile.enabled
        || profile.kind != kind
        || !profile
            .task_families
            .iter()
            .any(|value| value == task_family)
        || profile.capability_version != PROFILE_PROBE_CAPABILITY_VERSION
        || !matches!(profile.capability_status.as_str(), "supported" | "limited")
        || !capability_json_supports_kind(&profile.capability_json, kind)
        || profile
            .probe_backoff_until_ms
            .is_some_and(|value| value > now)
        || profile_circuit_breaker_open_tx(tx, &profile.profile_id, now)?
    {
        return Ok(false);
    }
    Ok(true)
}

fn capability_json_supports_kind(capability_json: &str, kind: &str) -> bool {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(capability_json) else {
        return false;
    };
    match kind {
        "model-call" => value
            .get("modelCallSupported")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false),
        "agent-run" => value
            .get("agentRunSupported")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false),
        _ => false,
    }
}

fn select_profile_pool_candidate<'a>(
    eligible: &'a [RuntimeProfileRecord],
    preferred_profile_ids: &[String],
) -> Option<&'a RuntimeProfileRecord> {
    for preferred_profile_id in preferred_profile_ids {
        if let Some(profile) = eligible
            .iter()
            .find(|profile| &profile.profile_id == preferred_profile_id)
        {
            return Some(profile);
        }
    }
    eligible.first()
}

fn profile_pool_progress_key(claim_id: &str) -> String {
    format!("profile-pool:{claim_id}")
}

fn profile_pool_claim_event_payload(
    claim_id: &str,
    profile_id: &str,
    kind: &str,
    task_family: &str,
    holder: &str,
    expires_at_ms: i64,
) -> Result<String, String> {
    profile_pool_payload(serde_json::json!({
        "claimId": claim_id,
        "profileId": profile_id,
        "kind": kind,
        "taskFamily": task_family,
        "holder": holder,
        "expiresAtMs": expires_at_ms
    }))
}

fn profile_pool_release_event_payload(
    claim: &RuntimeProfileClaimRecord,
    outcome: &str,
    breaker_until_ms: Option<i64>,
    reason: Option<&str>,
) -> Result<String, String> {
    profile_pool_payload(serde_json::json!({
        "claimId": claim.claim_id,
        "profileId": claim.profile_id,
        "kind": claim.kind,
        "taskFamily": claim.task_family,
        "outcome": outcome,
        "breakerUntilMs": breaker_until_ms,
        "reason": reason
    }))
}

fn profile_pool_progress_payload(
    claim_id: &str,
    profile_id: &str,
    status: &str,
    expires_at_ms: i64,
    breaker_until_ms: Option<i64>,
) -> Result<String, String> {
    profile_pool_payload(serde_json::json!({
        "claimId": claim_id,
        "profileId": profile_id,
        "status": status,
        "expiresAtMs": expires_at_ms,
        "breakerUntilMs": breaker_until_ms
    }))
}

fn profile_pool_payload(value: serde_json::Value) -> Result<String, String> {
    let payload = value.to_string();
    require_event_payload(&payload)?;
    Ok(payload)
}

fn ensure_profile_claim_id_available_tx(
    tx: &Transaction<'_>,
    claim_id: &str,
) -> Result<(), String> {
    let existing = tx
        .query_row(
            "SELECT COUNT(*)
             FROM runtime_profile_claims
             WHERE claim_id = ?1",
            [claim_id],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|err| format!("profile-pool-claim-id-check-failed: {err}"))?;
    if existing == 0 {
        Ok(())
    } else {
        Err("claim-id-conflict: profile pool claim id already exists".to_string())
    }
}

pub(crate) fn expire_profile_claims_tx(tx: &Transaction<'_>, now: i64) -> Result<(), String> {
    expire_claims_by_ttl_tx(tx, "runtime_profile_claims", "profile-pool", now)
}

pub(crate) fn active_profile_claim_count_tx(
    tx: &Transaction<'_>,
    profile_id: &str,
    now: i64,
) -> Result<i64, String> {
    tx.query_row(
        "SELECT COUNT(*)
         FROM runtime_profile_claims
         WHERE profile_id = ?1
           AND status = ?2
           AND expires_at_ms > ?3",
        params![profile_id, ACTIVE_CLAIM_STATUS, now],
        |row| row.get(0),
    )
    .map_err(|err| format!("profile-pool-active-count-failed: {err}"))
}

fn profile_circuit_breaker_open_tx(
    tx: &Transaction<'_>,
    profile_id: &str,
    now: i64,
) -> Result<bool, String> {
    tx.query_row(
        "SELECT 1
         FROM runtime_profile_circuit_breakers
         WHERE profile_id = ?1 AND open_until_ms > ?2
         LIMIT 1",
        params![profile_id, now],
        |_| Ok(()),
    )
    .optional()
    .map(|value| value.is_some())
    .map_err(|err| format!("profile-pool-breaker-check-failed: {err}"))
}

fn clear_profile_circuit_breaker_tx(tx: &Transaction<'_>, profile_id: &str) -> Result<(), String> {
    tx.execute(
        "DELETE FROM runtime_profile_circuit_breakers WHERE profile_id = ?1",
        [profile_id],
    )
    .map_err(|err| format!("profile-pool-breaker-clear-failed: {err}"))?;
    Ok(())
}

fn upsert_profile_circuit_breaker_tx(
    tx: &Transaction<'_>,
    profile_id: &str,
    status: &str,
    reason: Option<&str>,
    error: Option<&str>,
    now: i64,
    open_until_ms: i64,
) -> Result<(), String> {
    tx.execute(
        "INSERT INTO runtime_profile_circuit_breakers (
            profile_id,
            status,
            reason,
            error,
            opened_at_ms,
            open_until_ms,
            updated_at_ms
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?5)
         ON CONFLICT(profile_id) DO UPDATE SET
            status = excluded.status,
            reason = excluded.reason,
            error = excluded.error,
            opened_at_ms = excluded.opened_at_ms,
            open_until_ms = excluded.open_until_ms,
            updated_at_ms = excluded.updated_at_ms",
        params![profile_id, status, reason, error, now, open_until_ms],
    )
    .map_err(|err| format!("profile-pool-breaker-upsert-failed: {err}"))?;
    Ok(())
}

fn read_profile_claim_tx(
    tx: &Transaction<'_>,
    claim_id: &str,
) -> Result<RuntimeProfileClaimRecord, String> {
    tx.query_row(
        &profile_claim_select_sql("WHERE claim_id = ?1"),
        [claim_id],
        map_profile_claim_row,
    )
    .map_err(|err| format!("profile-pool-claim-read-failed: {err}"))
}

pub(crate) fn read_active_profile_claim_by_id_tx(
    tx: &Transaction<'_>,
    claim_id: &str,
    now: i64,
) -> Result<Option<RuntimeProfileClaimRecord>, String> {
    tx.query_row(
        &profile_claim_select_sql(
            "WHERE claim_id = ?1 AND status = 'active' AND expires_at_ms > ?2",
        ),
        params![claim_id, now],
        map_profile_claim_row,
    )
    .optional()
    .map_err(|err| format!("profile-pool-claim-read-failed: {err}"))
}

fn read_active_profile_claims(
    connection: &Connection,
    now: i64,
    kind: Option<&str>,
    task_family: Option<&str>,
    job_id: Option<&str>,
) -> Result<Vec<RuntimeProfileClaimRecord>, String> {
    let mut filters = vec!["status = ?", "expires_at_ms > ?"];
    let mut values: Vec<Box<dyn ToSql>> =
        vec![Box::new(ACTIVE_CLAIM_STATUS.to_string()), Box::new(now)];
    if let Some(kind) = kind {
        filters.push("kind = ?");
        values.push(Box::new(kind.to_string()));
    }
    if let Some(task_family) = task_family {
        filters.push("task_family = ?");
        values.push(Box::new(task_family.to_string()));
    }
    if let Some(job_id) = job_id {
        filters.push("job_id = ?");
        values.push(Box::new(job_id.to_string()));
    }
    let suffix = format!(
        "WHERE {} ORDER BY acquired_at_ms ASC, claim_id ASC",
        filters.join(" AND ")
    );
    let params = values.iter().map(|value| value.as_ref());
    let mut statement = connection
        .prepare(&profile_claim_select_sql(&suffix))
        .map_err(|err| format!("profile-pool-claims-read-prepare-failed: {err}"))?;
    let rows = statement
        .query_map(params_from_iter(params), map_profile_claim_row)
        .map_err(|err| format!("profile-pool-claims-read-failed: {err}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|err| format!("profile-pool-claims-read-failed: {err}"))
}

fn read_profile_circuit_breaker_optional_tx(
    tx: &Transaction<'_>,
    profile_id: &str,
) -> Result<Option<RuntimeProfileCircuitBreakerRecord>, String> {
    tx.query_row(
        &profile_circuit_breaker_select_sql("WHERE profile_id = ?1"),
        [profile_id],
        map_profile_circuit_breaker_row,
    )
    .optional()
    .map_err(|err| format!("profile-pool-breaker-read-failed: {err}"))
}

fn read_open_profile_circuit_breakers(
    connection: &Connection,
    now: i64,
) -> Result<Vec<RuntimeProfileCircuitBreakerRecord>, String> {
    let mut statement = connection
        .prepare(&profile_circuit_breaker_select_sql(
            "WHERE open_until_ms > ?1 ORDER BY open_until_ms ASC, profile_id ASC",
        ))
        .map_err(|err| format!("profile-pool-breakers-read-prepare-failed: {err}"))?;
    let rows = statement
        .query_map([now], map_profile_circuit_breaker_row)
        .map_err(|err| format!("profile-pool-breakers-read-failed: {err}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|err| format!("profile-pool-breakers-read-failed: {err}"))
}

fn profile_claim_select_sql(suffix: &str) -> String {
    format!(
        "SELECT claim_id,
                profile_id,
                kind,
                task_family,
                job_id,
                holder,
                acquired_at_ms,
                expires_at_ms,
                released_at_ms,
                status
         FROM runtime_profile_claims {suffix}"
    )
}

fn profile_circuit_breaker_select_sql(suffix: &str) -> String {
    format!(
        "SELECT profile_id,
                status,
                reason,
                error,
                opened_at_ms,
                open_until_ms,
                updated_at_ms
         FROM runtime_profile_circuit_breakers {suffix}"
    )
}

fn map_profile_claim_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<RuntimeProfileClaimRecord> {
    Ok(RuntimeProfileClaimRecord {
        claim_id: row.get(0)?,
        profile_id: row.get(1)?,
        kind: row.get(2)?,
        task_family: row.get(3)?,
        job_id: row.get(4)?,
        holder: row.get(5)?,
        acquired_at_ms: row.get(6)?,
        expires_at_ms: row.get(7)?,
        released_at_ms: row.get(8)?,
        status: row.get(9)?,
    })
}

fn map_profile_circuit_breaker_row(
    row: &rusqlite::Row<'_>,
) -> rusqlite::Result<RuntimeProfileCircuitBreakerRecord> {
    Ok(RuntimeProfileCircuitBreakerRecord {
        profile_id: row.get(0)?,
        status: row.get(1)?,
        reason: row.get(2)?,
        error: row.get(3)?,
        opened_at_ms: row.get(4)?,
        open_until_ms: row.get(5)?,
        updated_at_ms: row.get(6)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    use rusqlite::{params, Connection};

    use std::fs;
    use std::sync::{Arc, Barrier};

    fn profile_pool_release_request(
        claim_id: &str,
        outcome: &str,
    ) -> RuntimeProfilePoolReleaseRequest {
        RuntimeProfilePoolReleaseRequest {
            claim_id: claim_id.to_string(),
            outcome: outcome.to_string(),
            retry_after_ms: None,
            circuit_open_ms: None,
            reason: None,
            error: None,
        }
    }

    #[test]
    fn runtime_profile_deleted_agent_profile_is_not_resolved_for_active_claim() {
        let project = temp_project("profile-delete-agent-resolver");
        fs::create_dir_all(&project).expect("create temp project");
        let created = create_agent_profile_pool_profile(&project, "profile-1");
        runtime_profile_pool_claim_for_project(
            Some(&project),
            true,
            agent_profile_pool_claim_request("claim-1", vec!["profile-1"]),
            200,
        )
        .expect("claim agent profile");
        let connection = Connection::open(runtime_db_path(&project)).expect("open runtime db");
        connection
            .execute(
                "UPDATE runtime_model_profiles
                 SET deleted_at_ms = ?2, updated_at_ms = ?2
                 WHERE profile_id = ?1",
                params!["profile-1", 250_i64],
            )
            .expect("mark profile deleted");
        drop(connection);
        let store = TestSecretStore::default();
        store.insert(created.secret_ref.expect("secret ref"), "stored-secret");

        let error = resolve_agent_run_profile_for_project_at_with_store(
            Some(&project),
            true,
            "profile-1",
            "claim-1",
            300,
            &store,
        )
        .expect_err("deleted profile is not resolved");

        assert!(error.contains("profile-not-found"));
        assert!(!error.contains("stored-secret"));
        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn profile_pool_list_disabled_no_project_and_missing_tables_are_no_touch() {
        let disabled = runtime_profile_pool_list_for_project(
            None,
            false,
            RuntimeProfilePoolListRequest {
                kind: None,
                task_family: None,
                job_id: None,
            },
            100,
        )
        .expect("disabled list");
        assert_eq!(disabled.status, RuntimeDbHealthState::Disabled);
        assert!(disabled.active_claims.is_empty());

        let no_project = runtime_profile_pool_list_for_project(
            None,
            true,
            RuntimeProfilePoolListRequest {
                kind: None,
                task_family: None,
                job_id: None,
            },
            100,
        )
        .expect("no-project list");
        assert_eq!(no_project.status, RuntimeDbHealthState::NoProject);

        let project = temp_project("profile-pool-missing-tables");
        fs::create_dir_all(&project).expect("create temp project");
        runtime_profile_create_for_project(
            Some(&project),
            true,
            profile_create_request("profile-1"),
            100,
        )
        .expect("create profile schema only");

        let list = runtime_profile_pool_list_for_project(
            Some(&project),
            true,
            RuntimeProfilePoolListRequest {
                kind: None,
                task_family: None,
                job_id: None,
            },
            200,
        )
        .expect("missing pool tables list");
        assert!(list.active_claims.is_empty());
        assert!(!migration_family_exists(&project, PROFILE_POOL_FAMILY));
        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn profile_pool_claim_uses_preferred_order_and_skips_ineligible_ids() {
        let project = temp_project("profile-pool-preferred");
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
        create_profile_pool_profile(
            &project,
            "profile-disabled",
            "model-call",
            false,
            1,
            profile_pool_capability_json(serde_json::json!(true), serde_json::json!(false)),
        );
        create_profile_pool_profile(
            &project,
            "profile-ineligible",
            "model-call",
            true,
            1,
            profile_pool_capability_json(serde_json::json!(false), serde_json::json!(false)),
        );

        let claimed = runtime_profile_pool_claim_for_project(
            Some(&project),
            true,
            profile_pool_claim_request(
                "claim-1",
                vec![
                    "missing",
                    "profile-disabled",
                    "profile-ineligible",
                    "profile-2",
                    "profile-2",
                    "profile-1",
                ],
            ),
            200,
        )
        .expect("claim preferred profile");

        assert_eq!(claimed.profile_id, "profile-2");
        assert!(migration_family_exists(&project, PROFILE_POOL_FAMILY));
        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn profile_pool_rejects_bad_capability_facts_without_hard_parse_errors() {
        let project = temp_project("profile-pool-capability-facts");
        fs::create_dir_all(&project).expect("create temp project");
        create_profile_pool_profile(
            &project,
            "profile-missing",
            "model-call",
            true,
            1,
            "{}".to_string(),
        );
        create_profile_pool_profile(
            &project,
            "profile-non-bool",
            "model-call",
            true,
            1,
            profile_pool_capability_json(serde_json::json!("true"), serde_json::json!(false)),
        );
        create_profile_pool_profile(
            &project,
            "profile-false",
            "model-call",
            true,
            1,
            profile_pool_capability_json(serde_json::json!(false), serde_json::json!(false)),
        );
        create_profile_pool_profile(
            &project,
            "profile-malformed",
            "model-call",
            true,
            1,
            profile_pool_capability_json(serde_json::json!(true), serde_json::json!(false)),
        );
        let connection = Connection::open(runtime_db_path(&project)).expect("open runtime db");
        connection
            .execute(
                "UPDATE runtime_model_profiles
                 SET capability_json = '{bad json}'
                 WHERE profile_id = 'profile-malformed'",
                [],
            )
            .expect("seed malformed capability json");
        drop(connection);

        let error = runtime_profile_pool_claim_for_project(
            Some(&project),
            true,
            profile_pool_claim_request("claim-1", vec![]),
            200,
        )
        .expect_err("bad capability facts are ineligible");

        assert!(error.starts_with("no-eligible-profile"));
        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn profile_pool_capacity_uses_claim_time_sweep_and_list_filters_expired_active_claims() {
        let project = temp_project("profile-pool-capacity");
        fs::create_dir_all(&project).expect("create temp project");
        create_profile_pool_profile(
            &project,
            "profile-1",
            "model-call",
            true,
            1,
            profile_pool_capability_json(serde_json::json!(true), serde_json::json!(false)),
        );
        let mut first = profile_pool_claim_request("claim-1", vec![]);
        first.ttl_ms = Some(1_000);
        runtime_profile_pool_claim_for_project(Some(&project), true, first, 200)
            .expect("first claim");

        let exhausted = runtime_profile_pool_claim_for_project(
            Some(&project),
            true,
            profile_pool_claim_request("claim-2", vec![]),
            300,
        )
        .expect_err("capacity exhausted");
        assert!(exhausted.starts_with("no-eligible-profile"));

        let listed_before_sweep = runtime_profile_pool_list_for_project(
            Some(&project),
            true,
            RuntimeProfilePoolListRequest {
                kind: None,
                task_family: None,
                job_id: None,
            },
            1_300,
        )
        .expect("list filters expired active claim");
        assert!(listed_before_sweep.active_claims.is_empty());

        let claimed = runtime_profile_pool_claim_for_project(
            Some(&project),
            true,
            profile_pool_claim_request("claim-2", vec![]),
            1_300,
        )
        .expect("expired claim no longer consumes capacity");
        assert_eq!(claimed.profile_id, "profile-1");

        let connection = Connection::open(runtime_db_path(&project)).expect("open runtime db");
        let old_status: String = connection
            .query_row(
                "SELECT status FROM runtime_profile_claims WHERE claim_id = 'claim-1'",
                [],
                |row| row.get(0),
            )
            .expect("read expired claim status");
        assert_eq!(old_status, EXPIRED_CLAIM_STATUS);
        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn profile_pool_release_sets_and_clears_circuit_breakers() {
        let project = temp_project("profile-pool-breaker");
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
            profile_pool_claim_request("claim-1", vec![]),
            200,
        )
        .expect("claim");
        let mut release = profile_pool_release_request("claim-1", "rate-limited");
        release.retry_after_ms = Some(5_000);
        release.reason = Some("provider returned 429 sk-secret".to_string());
        let released = runtime_profile_pool_release_for_project(Some(&project), true, release, 300)
            .expect("release rate limited");
        let breaker = released.circuit_breaker.expect("breaker");
        assert_eq!(breaker.status, "rate-limited");
        assert_eq!(breaker.open_until_ms, 5_300);
        assert!(!breaker.reason.unwrap_or_default().contains("sk-secret"));

        let blocked = runtime_profile_pool_claim_for_project(
            Some(&project),
            true,
            profile_pool_claim_request("claim-2", vec![]),
            400,
        )
        .expect_err("breaker blocks profile");
        assert!(blocked.starts_with("no-eligible-profile"));

        runtime_profile_pool_claim_for_project(
            Some(&project),
            true,
            profile_pool_claim_request("claim-2", vec![]),
            5_400,
        )
        .expect("expired breaker no longer blocks");
        let success = runtime_profile_pool_release_for_project(
            Some(&project),
            true,
            profile_pool_release_request("claim-2", "success"),
            5_500,
        )
        .expect("success clears breaker");
        assert!(success.circuit_breaker.is_none());
        let list = runtime_profile_pool_list_for_project(
            Some(&project),
            true,
            RuntimeProfilePoolListRequest {
                kind: None,
                task_family: None,
                job_id: None,
            },
            5_600,
        )
        .expect("list after clear");
        assert!(list.circuit_breakers.is_empty());
        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn profile_pool_claim_and_release_invariants_are_strict() {
        let project = temp_project("profile-pool-invariants");
        fs::create_dir_all(&project).expect("create temp project");
        create_profile_pool_profile(
            &project,
            "profile-1",
            "model-call",
            true,
            2,
            profile_pool_capability_json(serde_json::json!(true), serde_json::json!(false)),
        );
        runtime_profile_pool_claim_for_project(
            Some(&project),
            true,
            profile_pool_claim_request("claim-1", vec![]),
            200,
        )
        .expect("claim");
        let duplicate = runtime_profile_pool_claim_for_project(
            Some(&project),
            true,
            profile_pool_claim_request("claim-1", vec![]),
            250,
        )
        .expect_err("duplicate claim rejected");
        assert!(duplicate.starts_with("claim-id-conflict"));

        runtime_profile_pool_release_for_project(
            Some(&project),
            true,
            profile_pool_release_request("claim-1", "success"),
            300,
        )
        .expect("release once");
        let released_again = runtime_profile_pool_release_for_project(
            Some(&project),
            true,
            profile_pool_release_request("claim-1", "success"),
            350,
        )
        .expect_err("already released is inactive");
        assert!(released_again.starts_with("claim-inactive"));

        let unknown = runtime_profile_pool_release_for_project(
            Some(&project),
            true,
            profile_pool_release_request("missing", "success"),
            350,
        )
        .expect_err("unknown is inactive");
        assert!(unknown.starts_with("claim-inactive"));

        let invalid_duration = RuntimeProfilePoolReleaseRequest {
            claim_id: "claim-1".to_string(),
            outcome: "error".to_string(),
            retry_after_ms: None,
            circuit_open_ms: Some(MAX_PROFILE_POOL_BREAKER_MS + 1),
            reason: None,
            error: None,
        };
        let duration_error =
            runtime_profile_pool_release_for_project(Some(&project), true, invalid_duration, 400)
                .expect_err("invalid duration rejected");
        assert!(duration_error.starts_with("invalid-circuit-open"));
        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn profile_pool_renew_extends_active_claim_and_rejects_inactive_claims() {
        let project = temp_project("profile-pool-renew");
        fs::create_dir_all(&project).expect("create temp project");
        create_profile_pool_profile(
            &project,
            "profile-1",
            "model-call",
            true,
            1,
            profile_pool_capability_json(serde_json::json!(true), serde_json::json!(false)),
        );
        let mut claim = profile_pool_claim_request("claim-1", vec![]);
        claim.ttl_ms = Some(1_000);
        runtime_profile_pool_claim_for_project(Some(&project), true, claim, 200)
            .expect("claim profile");

        let renewed = runtime_profile_pool_renew_for_project(
            Some(&project),
            true,
            RuntimeProfilePoolRenewRequest {
                claim_id: "claim-1".to_string(),
                ttl_ms: Some(10_000),
            },
            800,
        )
        .expect("renew active claim");
        assert_eq!(renewed.claim_id, "claim-1");
        assert_eq!(renewed.profile_id, "profile-1");
        assert_eq!(renewed.expires_at_ms, 10_800);
        assert_eq!(renewed.claim.expires_at_ms, 10_800);

        runtime_profile_pool_release_for_project(
            Some(&project),
            true,
            profile_pool_release_request("claim-1", "success"),
            900,
        )
        .expect("release claim");
        let released = runtime_profile_pool_renew_for_project(
            Some(&project),
            true,
            RuntimeProfilePoolRenewRequest {
                claim_id: "claim-1".to_string(),
                ttl_ms: Some(10_000),
            },
            1_000,
        )
        .expect_err("released claim is inactive");
        assert!(released.starts_with("claim-inactive"));

        let mut expired_claim = profile_pool_claim_request("claim-2", vec![]);
        expired_claim.ttl_ms = Some(1_000);
        runtime_profile_pool_claim_for_project(Some(&project), true, expired_claim, 2_000)
            .expect("claim second profile slot");
        let expired = runtime_profile_pool_renew_for_project(
            Some(&project),
            true,
            RuntimeProfilePoolRenewRequest {
                claim_id: "claim-2".to_string(),
                ttl_ms: Some(10_000),
            },
            3_000,
        )
        .expect_err("expired claim is inactive");
        assert!(expired.starts_with("claim-inactive"));

        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn agent_run_profile_resolver_uses_active_agent_claim_and_reads_secret() {
        let project = temp_project("agent-profile-resolver");
        fs::create_dir_all(&project).expect("create temp project");
        let profile = create_agent_profile_pool_profile(&project, "profile-agent");
        let mut update = profile_update_request("profile-agent");
        update.agent_sdk_model_id = Some("deepseek-chat".to_string());
        runtime_profile_update_for_project(Some(&project), true, update, 175)
            .expect("set agent sdk alias");
        runtime_profile_pool_claim_for_project(
            Some(&project),
            true,
            agent_profile_pool_claim_request("claim-agent", vec!["profile-agent"]),
            200,
        )
        .expect("claim agent profile");

        let store = TestSecretStore::default();
        store.insert(profile.secret_ref.expect("secret ref"), "agent-secret");
        let resolved = resolve_agent_run_profile_for_project_at_with_store(
            Some(&project),
            true,
            "profile-agent",
            "claim-agent",
            300,
            &store,
        )
        .expect("resolve agent profile");

        assert_eq!(resolved.profile_id, "profile-agent");
        assert_eq!(resolved.provider_model_id, "claude-test");
        assert_eq!(resolved.agent_sdk_model_id, "deepseek-chat");
        assert_eq!(
            resolved.endpoint.as_deref(),
            Some("https://agent.example/v1")
        );
        assert_eq!(resolved.auth_style, "x-api-key");
        assert_eq!(resolved.secret_value.as_deref(), Some("agent-secret"));
        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn agent_run_profile_resolver_falls_back_to_provider_model_without_sdk_alias() {
        let project = temp_project("agent-profile-resolver-fallback");
        fs::create_dir_all(&project).expect("create temp project");
        let profile = create_agent_profile_pool_profile(&project, "profile-agent");
        let now = now_ms().expect("now");
        runtime_profile_pool_claim_for_project(
            Some(&project),
            true,
            agent_profile_pool_claim_request("claim-agent", vec!["profile-agent"]),
            now,
        )
        .expect("claim agent profile");

        let store = TestSecretStore::default();
        store.insert(profile.secret_ref.expect("secret ref"), "agent-secret");
        let resolved = resolve_agent_run_profile_for_project_at_with_store(
            Some(&project),
            true,
            "profile-agent",
            "claim-agent",
            now + 1,
            &store,
        )
        .expect("resolve agent profile");

        assert_eq!(resolved.provider_model_id, "claude-test");
        assert_eq!(resolved.agent_sdk_model_id, "claude-test");
        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn agent_run_profile_resolver_falls_back_when_sdk_alias_is_blank() {
        let project = temp_project("agent-profile-resolver-blank-alias");
        fs::create_dir_all(&project).expect("create temp project");
        let profile = create_agent_profile_pool_profile(&project, "profile-agent");
        let connection = Connection::open(runtime_db_path(&project)).expect("open runtime db");
        connection
            .execute(
                "UPDATE runtime_model_profiles
                 SET agent_sdk_model_id = '   '
                 WHERE profile_id = ?1",
                ["profile-agent"],
            )
            .expect("write blank sdk alias fixture");
        let now = now_ms().expect("now");
        runtime_profile_pool_claim_for_project(
            Some(&project),
            true,
            agent_profile_pool_claim_request("claim-agent", vec!["profile-agent"]),
            now,
        )
        .expect("claim agent profile");

        let store = TestSecretStore::default();
        store.insert(profile.secret_ref.expect("secret ref"), "agent-secret");
        let resolved = resolve_agent_run_profile_for_project_at_with_store(
            Some(&project),
            true,
            "profile-agent",
            "claim-agent",
            now + 1,
            &store,
        )
        .expect("resolve agent profile");

        assert_eq!(resolved.provider_model_id, "claude-test");
        assert_eq!(resolved.agent_sdk_model_id, "claude-test");
        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn agent_profile_error_classifier_distinguishes_sdk_and_gateway_failures() {
        assert_eq!(
            classify_agent_profile_error("There's an issue with the selected model. Run --model.",),
            Some(AGENT_PROFILE_SDK_MODEL_REJECTED_REASON)
        );
        assert_eq!(
            classify_agent_profile_error("gateway returned 401 unauthorized"),
            Some(AGENT_PROFILE_GATEWAY_AUTH_FAILED_REASON)
        );
        assert_eq!(
            classify_agent_profile_error("gateway connection failed on port 4019"),
            None
        );
        assert_eq!(
            classify_agent_profile_error("tool mentioned authentication prerequisites"),
            None
        );
        assert_eq!(classify_agent_profile_error("process exited"), None);
    }

    #[test]
    fn agent_run_profile_sdk_model_rejection_opens_circuit() {
        let project = temp_project("agent-profile-sdk-rejected-circuit");
        fs::create_dir_all(&project).expect("create temp project");
        create_agent_profile_pool_profile(&project, "profile-agent");
        let now = now_ms().expect("now");
        runtime_profile_pool_claim_for_project(
            Some(&project),
            true,
            agent_profile_pool_claim_request("claim-agent", vec!["profile-agent"]),
            now,
        )
        .expect("claim agent profile");

        release_agent_profile_claim_for_project(
            Some(&project),
            true,
            "claim-agent",
            "error",
            Some(
                "There's an issue with the selected model (deepseek-v4-flash). \
                 ANTHROPIC_AUTH_TOKEN=profile-token {\"apiKey\":\"json-token\"} \
                 google=AIzaSyDummYKeyValue Run --model.",
            ),
        )
        .expect("release rejected agent profile");
        let list = runtime_profile_pool_list_for_project(
            Some(&project),
            true,
            RuntimeProfilePoolListRequest {
                kind: Some("agent-run".to_string()),
                task_family: Some("agent".to_string()),
                job_id: None,
            },
            now_ms().expect("now after release"),
        )
        .expect("list pool");
        assert_eq!(list.circuit_breakers.len(), 1);
        assert_eq!(
            list.circuit_breakers[0].reason.as_deref(),
            Some(AGENT_PROFILE_SDK_MODEL_REJECTED_REASON)
        );
        let breaker_error = list.circuit_breakers[0]
            .error
            .as_deref()
            .unwrap_or_default();
        assert!(!breaker_error.contains("profile-token"));
        assert!(!breaker_error.contains("json-token"));
        assert!(!breaker_error.contains("AIza"));
        let blocked = runtime_profile_pool_claim_for_project(
            Some(&project),
            true,
            agent_profile_pool_claim_request("claim-next", vec!["profile-agent"]),
            now_ms().expect("now before circuit expiry"),
        )
        .expect_err("circuit blocks immediate reuse");
        assert!(blocked.starts_with("no-eligible-profile"));
        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn agent_run_profile_resolver_rejects_wrong_claim_and_missing_secret() {
        let project = temp_project("agent-profile-resolver-rejects");
        fs::create_dir_all(&project).expect("create temp project");
        create_agent_profile_pool_profile(&project, "profile-agent");
        create_profile_pool_profile(
            &project,
            "profile-model",
            "model-call",
            true,
            1,
            profile_pool_capability_json(serde_json::json!(true), serde_json::json!(false)),
        );
        runtime_profile_pool_claim_for_project(
            Some(&project),
            true,
            profile_pool_claim_request("claim-model", vec!["profile-model"]),
            200,
        )
        .expect("claim model profile");
        let store = TestSecretStore::default();

        let wrong_kind = resolve_agent_run_profile_for_project_at_with_store(
            Some(&project),
            true,
            "profile-model",
            "claim-model",
            250,
            &store,
        )
        .expect_err("model-call claim is rejected");
        assert!(wrong_kind.starts_with("profile-unsupported"));

        runtime_profile_pool_claim_for_project(
            Some(&project),
            true,
            agent_profile_pool_claim_request("claim-agent", vec!["profile-agent"]),
            300,
        )
        .expect("claim agent profile");
        let missing_secret = resolve_agent_run_profile_for_project_at_with_store(
            Some(&project),
            true,
            "profile-agent",
            "claim-agent",
            350,
            &store,
        )
        .expect_err("missing stored secret is rejected");
        assert!(missing_secret.starts_with("profile-secret-not-found"));

        let read_failed = resolve_agent_run_profile_for_project_at_with_store(
            Some(&project),
            true,
            "profile-agent",
            "claim-agent",
            360,
            &FailingReadSecretStore,
        )
        .expect_err("secret store read failure is rejected");
        assert!(read_failed.starts_with("profile-secret-read-failed"));

        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn agent_run_profile_resolver_rechecks_pool_eligibility_after_claim() {
        let project = temp_project("agent-profile-resolver-eligibility");
        fs::create_dir_all(&project).expect("create temp project");
        create_agent_profile_pool_profile(&project, "profile-agent");
        runtime_profile_pool_claim_for_project(
            Some(&project),
            true,
            agent_profile_pool_claim_request("claim-agent", vec!["profile-agent"]),
            200,
        )
        .expect("claim agent profile");

        let mut unsupported = profile_update_request("profile-agent");
        unsupported.capability_status = Some("unsupported".to_string());
        runtime_profile_update_for_project(Some(&project), true, unsupported, 250)
            .expect("mark claimed profile unsupported");
        let rejected = resolve_agent_run_profile_for_project_at_with_store(
            Some(&project),
            true,
            "profile-agent",
            "claim-agent",
            300,
            &TestSecretStore::default(),
        )
        .expect_err("claimed profile is rechecked");
        assert!(rejected.starts_with("profile-unsupported"));
        let _ = fs::remove_dir_all(project);

        let project = temp_project("agent-profile-resolver-circuit");
        fs::create_dir_all(&project).expect("create temp project");
        create_agent_profile_pool_profile(&project, "profile-agent");
        let mut capacity = profile_update_request("profile-agent");
        capacity.max_concurrency = Some(2);
        runtime_profile_update_for_project(Some(&project), true, capacity, 180)
            .expect("raise agent profile capacity");
        runtime_profile_pool_claim_for_project(
            Some(&project),
            true,
            agent_profile_pool_claim_request("claim-agent", vec!["profile-agent"]),
            200,
        )
        .expect("claim agent profile");
        runtime_profile_pool_claim_for_project(
            Some(&project),
            true,
            agent_profile_pool_claim_request("claim-breaker", vec!["profile-agent"]),
            220,
        )
        .expect("claim breaker profile");
        let mut release = profile_pool_release_request("claim-breaker", "rate-limited");
        release.retry_after_ms = Some(5_000);
        runtime_profile_pool_release_for_project(Some(&project), true, release, 240)
            .expect("open profile circuit");

        let rejected = resolve_agent_run_profile_for_project_at_with_store(
            Some(&project),
            true,
            "profile-agent",
            "claim-agent",
            300,
            &TestSecretStore::default(),
        )
        .expect_err("claimed profile circuit is rechecked");
        assert!(rejected.starts_with("profile-unsupported"));
        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn profile_pool_breaker_bounds_and_sanitization_are_enforced() {
        let project = temp_project("profile-pool-breaker-bounds");
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
            profile_pool_claim_request("claim-1", vec![]),
            200,
        )
        .expect("claim");

        for invalid_retry_after_ms in [-1, 0, MAX_PROFILE_POOL_BREAKER_MS + 1, i64::MAX] {
            let mut release = profile_pool_release_request("claim-1", "rate-limited");
            release.retry_after_ms = Some(invalid_retry_after_ms);
            let error =
                runtime_profile_pool_release_for_project(Some(&project), true, release, 300)
                    .expect_err("invalid retryAfterMs is rejected before release");
            assert!(error.starts_with("invalid-retry-after"));
        }
        assert!(checked_profile_pool_deadline(i64::MAX, 1, "invalid-circuit-open").is_err());

        let mut release = profile_pool_release_request("claim-1", "rate-limited");
        release.retry_after_ms = Some(5_000);
        release.reason = Some(format!(
            "provider 429 bearer abc key=sk-embedded {}",
            "r".repeat(MAX_PROFILE_POOL_REASON_BYTES + 128)
        ));
        release.error = Some(format!(
            "authorization: secret apiKey=abc {} sk-secret",
            "e".repeat(MAX_PROFILE_POOL_REASON_BYTES + 128)
        ));
        let released = runtime_profile_pool_release_for_project(Some(&project), true, release, 300)
            .expect("sanitized release");
        let breaker = released.circuit_breaker.expect("breaker");
        let reason = breaker.reason.expect("reason");
        let error = breaker.error.expect("error");
        assert!(reason.len() <= MAX_PROFILE_POOL_REASON_BYTES);
        assert!(error.len() <= MAX_PROFILE_POOL_REASON_BYTES);
        assert!(!reason.contains("bearer"));
        assert!(!reason.contains("abc"));
        assert!(!reason.contains("sk-embedded"));
        assert!(!error.contains("authorization:"));
        assert!(!error.contains("apiKey"));
        assert!(!error.contains("sk-secret"));
        let agent_error = redact_profile_pool_text(
            "ANTHROPIC_AUTH_TOKEN=profile-token ANTHROPIC_API_KEY env-token \
             {\"apiKey\":\"json-token\"} google=AIzaSyDummYKeyValue",
        );
        assert!(!agent_error.contains("profile-token"));
        assert!(!agent_error.contains("env-token"));
        assert!(!agent_error.contains("json-token"));
        assert!(!agent_error.contains("AIza"));
        assert_eq!(
            redact_profile_pool_text("flask-error api-key-not-configured"),
            "flask-error api-key-not-configured"
        );
        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn redact_profile_pool_text_redacts_tp_gateway_key() {
        let redacted = redact_profile_pool_text("gateway key=tp-test000aaaabbbbccccdddd in use");
        assert!(!redacted.contains("tp-test000aaaabbbbccccdddd"));
        assert!(redacted.contains("[REDACTED]"));
    }

    #[test]
    fn redact_profile_pool_text_keeps_short_tp_prefixed_words() {
        assert_eq!(
            redact_profile_pool_text("tp-link router and tp-1a2b device"),
            "tp-link router and tp-1a2b device"
        );
    }

    #[test]
    fn profile_pool_concurrent_claims_do_not_exceed_capacity() {
        let project = temp_project("profile-pool-concurrent");
        fs::create_dir_all(&project).expect("create temp project");
        create_profile_pool_profile(
            &project,
            "profile-1",
            "model-call",
            true,
            1,
            profile_pool_capability_json(serde_json::json!(true), serde_json::json!(false)),
        );

        let shared_project = Arc::new(project.clone());
        let barrier = Arc::new(Barrier::new(4));
        let handles = (0..4)
            .map(|index| {
                let project = Arc::clone(&shared_project);
                let barrier = Arc::clone(&barrier);
                std::thread::spawn(move || {
                    barrier.wait();
                    runtime_profile_pool_claim_for_project(
                        Some(project.as_path()),
                        true,
                        profile_pool_claim_request(&format!("claim-{index}"), vec![]),
                        200,
                    )
                })
            })
            .collect::<Vec<_>>();
        let results = handles
            .into_iter()
            .map(|handle| handle.join().expect("claim thread"))
            .collect::<Vec<_>>();
        assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
        assert!(results
            .iter()
            .filter_map(|result| result.as_ref().err())
            .all(|error| error.starts_with("no-eligible-profile")));

        let list = runtime_profile_pool_list_for_project(
            Some(&project),
            true,
            RuntimeProfilePoolListRequest {
                kind: None,
                task_family: None,
                job_id: None,
            },
            300,
        )
        .expect("list active claims");
        assert_eq!(list.active_claims.len(), 1);
        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn profile_pool_job_linkage_rolls_back_when_audit_writes_fail() {
        let project = temp_project("profile-pool-audit-rollback");
        fs::create_dir_all(&project).expect("create temp project");
        runtime_job_create_for_project(Some(&project), true, create_request("job-1"), 100)
            .expect("create job");
        create_profile_pool_profile(
            &project,
            "profile-1",
            "model-call",
            true,
            2,
            profile_pool_capability_json(serde_json::json!(true), serde_json::json!(false)),
        );
        let connection =
            open_events_progress_runtime_locked(&project).expect("initialize audit tables");
        drop(connection);

        let connection = Connection::open(runtime_db_path(&project)).expect("open runtime db");
        connection
            .execute(
                "CREATE TRIGGER reject_profile_pool_events
                 BEFORE INSERT ON runtime_events
                 WHEN NEW.event_name = 'profile-pool:claimed'
                 BEGIN
                    SELECT RAISE(ABORT, 'forced event failure');
                 END",
                [],
            )
            .expect("create event trigger");
        drop(connection);
        let mut linked = profile_pool_claim_request("claim-event-fails", vec![]);
        linked.job_id = Some("job-1".to_string());
        let claim_error = runtime_profile_pool_claim_for_project(Some(&project), true, linked, 200)
            .expect_err("event failure rolls claim back");
        assert!(claim_error.starts_with("event-insert-failed"));
        let connection = Connection::open(runtime_db_path(&project)).expect("open runtime db");
        let claim_count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM runtime_profile_claims WHERE claim_id = 'claim-event-fails'",
                [],
                |row| row.get(0),
            )
            .expect("read claim count");
        assert_eq!(claim_count, 0);
        connection
            .execute("DROP TRIGGER reject_profile_pool_events", [])
            .expect("drop event trigger");
        drop(connection);

        let mut linked = profile_pool_claim_request("claim-progress-fails", vec![]);
        linked.job_id = Some("job-1".to_string());
        runtime_profile_pool_claim_for_project(Some(&project), true, linked, 300)
            .expect("claim before progress trigger");
        let connection = Connection::open(runtime_db_path(&project)).expect("open runtime db");
        connection
            .execute(
                "CREATE TRIGGER reject_profile_pool_progress
                 BEFORE INSERT ON runtime_progress
                 WHEN NEW.progress_key LIKE 'profile-pool:%'
                 BEGIN
                    SELECT RAISE(ABORT, 'forced progress failure');
                 END",
                [],
            )
            .expect("create progress trigger");
        drop(connection);
        let release_error = runtime_profile_pool_release_for_project(
            Some(&project),
            true,
            profile_pool_release_request("claim-progress-fails", "success"),
            400,
        )
        .expect_err("progress failure rolls release back");
        assert!(release_error.starts_with("progress-upsert-failed"));
        let connection = Connection::open(runtime_db_path(&project)).expect("open runtime db");
        let status: String = connection
            .query_row(
                "SELECT status FROM runtime_profile_claims WHERE claim_id = 'claim-progress-fails'",
                [],
                |row| row.get(0),
            )
            .expect("read claim status");
        assert_eq!(status, ACTIVE_CLAIM_STATUS);
        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn profile_pool_serde_contract_uses_camel_case_fields() {
        let claim_request: RuntimeProfilePoolClaimRequest =
            serde_json::from_value(serde_json::json!({
                "claimId": "claim-1",
                "kind": "model-call",
                "taskFamily": "summarize",
                "holder": "worker-1",
                "jobId": "job-1",
                "ttlMs": 30_000,
                "preferredProfileIds": ["profile-2", "profile-1"]
            }))
            .expect("deserialize claim request");
        assert_eq!(
            claim_request.preferred_profile_ids,
            Some(vec!["profile-2".to_string(), "profile-1".to_string()])
        );
        let release_request: RuntimeProfilePoolReleaseRequest =
            serde_json::from_value(serde_json::json!({
                "claimId": "claim-1",
                "outcome": "rate-limited",
                "retryAfterMs": 60_000,
                "reason": "provider 429"
            }))
            .expect("deserialize release request");
        assert_eq!(release_request.retry_after_ms, Some(60_000));
        let unknown = serde_json::from_value::<RuntimeProfilePoolListRequest>(serde_json::json!({
            "kind": "model-call",
            "unknownField": true
        }))
        .expect_err("deny unknown list fields");
        assert!(unknown.to_string().contains("unknown field"));

        let serialized = serde_json::to_value(RuntimeProfilePoolList {
            enabled: true,
            status: RuntimeDbHealthState::Healthy,
            active_claims: Vec::new(),
            circuit_breakers: Vec::new(),
        })
        .expect("serialize list response");
        assert!(serialized.get("activeClaims").is_some());
        assert!(serialized.get("circuitBreakers").is_some());
        assert!(serialized.get("active_claims").is_none());
    }

    #[test]
    fn profile_pool_job_linkage_writes_events_and_progress_only_when_requested() {
        let project = temp_project("profile-pool-job-linkage");
        fs::create_dir_all(&project).expect("create temp project");
        runtime_job_create_for_project(Some(&project), true, create_request("job-1"), 100)
            .expect("create job");
        create_profile_pool_profile(
            &project,
            "profile-1",
            "model-call",
            true,
            2,
            profile_pool_capability_json(serde_json::json!(true), serde_json::json!(false)),
        );
        let mut linked = profile_pool_claim_request("claim-linked", vec![]);
        linked.job_id = Some("job-1".to_string());
        runtime_profile_pool_claim_for_project(Some(&project), true, linked, 200)
            .expect("linked claim");
        runtime_profile_pool_release_for_project(
            Some(&project),
            true,
            profile_pool_release_request("claim-linked", "success"),
            300,
        )
        .expect("linked release");

        let timeline = runtime_timeline_list_for_project(
            Some(&project),
            true,
            timeline_request(Some("job-1")),
        )
        .expect("timeline");
        assert_eq!(timeline.events.len(), 2);
        assert_eq!(timeline.events[0].event_name, PROFILE_POOL_CLAIMED_NAME);
        assert_eq!(timeline.events[1].event_name, PROFILE_POOL_RELEASED_NAME);
        let progress = runtime_progress_list_for_project(
            Some(&project),
            true,
            progress_list_request(Some("job-1")),
        )
        .expect("progress");
        assert_eq!(progress.progress.len(), 1);
        assert_eq!(
            progress.progress[0].progress_key,
            "profile-pool:claim-linked"
        );

        runtime_profile_pool_claim_for_project(
            Some(&project),
            true,
            profile_pool_claim_request("claim-unlinked", vec![]),
            400,
        )
        .expect("unlinked claim");
        runtime_profile_pool_release_for_project(
            Some(&project),
            true,
            profile_pool_release_request("claim-unlinked", "success"),
            500,
        )
        .expect("unlinked release");
        let timeline_after =
            runtime_timeline_list_for_project(Some(&project), true, timeline_request(None))
                .expect("timeline after unlinked");
        assert_eq!(timeline_after.events.len(), 2);
        let _ = fs::remove_dir_all(project);
    }
}
