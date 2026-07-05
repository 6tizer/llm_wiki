use crate::commands::file_sync::ProjectRootState;
use crate::panic_guard::run_guarded;
use rusqlite::params;
use std::path::Path;
use tauri::{AppHandle, State};

use super::*;
use crate::commands::profile_secrets::{active_secret_store, read_profile_secret, SecretStore};
use futures::future::{AbortHandle, Abortable};
use reqwest::header::{HeaderMap, HeaderValue, AUTHORIZATION, CONTENT_TYPE};
use reqwest::Client;
use serde::Deserialize;
use std::collections::{HashMap, HashSet};
use std::sync::Mutex;
use std::time::Duration;
use tauri::ipc::Channel;

#[derive(Default)]
pub struct RuntimeModelCallStreamState {
    aborts: Mutex<HashMap<String, AbortHandle>>,
}

impl RuntimeModelCallStreamState {
    fn register(&self, stream_id: String, abort: AbortHandle) -> Result<(), String> {
        let mut aborts = self
            .aborts
            .lock()
            .map_err(|_| "model-call-stream-state-poisoned".to_string())?;
        aborts.insert(stream_id, abort);
        Ok(())
    }

    fn remove(&self, stream_id: &str) -> Result<Option<AbortHandle>, String> {
        let mut aborts = self
            .aborts
            .lock()
            .map_err(|_| "model-call-stream-state-poisoned".to_string())?;
        Ok(aborts.remove(stream_id))
    }

    fn cancel(&self, stream_id: &str) -> Result<(), String> {
        if let Some(abort) = self.remove(stream_id)? {
            abort.abort();
        }
        Ok(())
    }

    #[cfg(test)]
    fn registered_count(&self) -> usize {
        self.aborts.lock().expect("lock aborts").len()
    }
}

/// Probe stored or draft model profile capabilities without returning secrets.
#[tauri::command]
pub async fn runtime_profile_probe(
    app: AppHandle,
    request: RuntimeProfileProbeRequest,
    root_state: State<'_, ProjectRootState>,
) -> Result<RuntimeProfileProbeResult, String> {
    let (project_root, runtime_enabled, now) = run_guarded("runtime_profile_probe", || {
        let runtime_enabled = resolve_work_runtime_enabled(read_work_runtime_flag_value());
        let project_root = root_state.get();
        let now = now_for_enabled_project(project_root.as_deref(), runtime_enabled)?;
        Ok((project_root, runtime_enabled, now))
    })?;

    let client = Client::builder()
        .timeout(Duration::from_secs(PROFILE_PROBE_TIMEOUT_SECS))
        .build()
        .map_err(|err| format!("profile-probe-client-failed: {err}"))?;
    let store = active_secret_store(&app)?;
    runtime_profile_probe_for_project_with_store(
        project_root.as_deref(),
        runtime_enabled,
        request,
        now,
        store.as_ref(),
        &client,
    )
    .await
}

/// List available provider model ids without returning or logging secrets.
#[tauri::command]
pub async fn runtime_profile_models_list(
    app: AppHandle,
    request: RuntimeProfileModelsListRequest,
    root_state: State<'_, ProjectRootState>,
) -> Result<RuntimeProfileModelsListResult, String> {
    let (project_root, runtime_enabled) = run_guarded("runtime_profile_models_list", || {
        let runtime_enabled = resolve_work_runtime_enabled(read_work_runtime_flag_value());
        Ok((root_state.get(), runtime_enabled))
    })?;

    let client = Client::builder()
        .timeout(Duration::from_secs(PROFILE_MODELS_LIST_TIMEOUT_SECS))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|err| format!("profile-models-list-client-failed: {err}"))?;
    let store = active_secret_store(&app)?;
    runtime_profile_models_list_for_project_with_store(
        project_root.as_deref(),
        runtime_enabled,
        request,
        store.as_ref(),
        &client,
    )
    .await
}

/// Secretless model-call plan forwarded from JS. `provider`/`apiMode`/
/// `model` are cross-checked against the claimed profile for a clearer
/// error message but are NEVER used to pick the request destination —
/// `resolve_model_call_forward_target` re-derives the URL and auth header
/// entirely from the server-stored profile so a buggy or compromised caller
/// cannot redirect the request or exfiltrate the secret. `body` is the
/// already-built provider request body (see
/// `src/lib/llm-providers.ts`); it never contains the secret or a final
/// destination URL.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeModelCallForwardRequest {
    claim_id: String,
    provider: String,
    api_mode: String,
    model: String,
    body: serde_json::Value,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeModelCallStreamRequest {
    stream_id: String,
    #[serde(flatten)]
    forward: RuntimeModelCallForwardRequest,
}

/// Forward one bulk-knowledge-prepare model-call through the profile pool.
///
/// Returns only the raw provider response body on success (2xx). On
/// failure this NEVER returns provider response bodies, request headers,
/// the destination URL, or raw reqwest error Debug output — see the
/// anti-leak notes on `runtime_model_call_forward_for_project_with_store`.
#[tauri::command]
pub async fn runtime_model_call_forward(
    app: AppHandle,
    request: RuntimeModelCallForwardRequest,
    root_state: State<'_, ProjectRootState>,
) -> Result<String, String> {
    let (project_root, runtime_enabled, now) = run_guarded("runtime_model_call_forward", || {
        let runtime_enabled = resolve_work_runtime_enabled(read_work_runtime_flag_value());
        let project_root = root_state.get();
        let now = now_for_enabled_project(project_root.as_deref(), runtime_enabled)?;
        Ok((project_root, runtime_enabled, now))
    })?;

    let client = model_call_forward_client()?;
    let store = active_secret_store(&app)?;
    runtime_model_call_forward_for_project_with_store(
        project_root.as_deref(),
        runtime_enabled,
        request,
        now,
        store.as_ref(),
        &client,
    )
    .await
}

#[tauri::command]
pub async fn runtime_model_call_stream(
    app: AppHandle,
    request: RuntimeModelCallStreamRequest,
    on_event: Channel<serde_json::Value>,
    root_state: State<'_, ProjectRootState>,
    stream_state: State<'_, RuntimeModelCallStreamState>,
) -> Result<(), String> {
    let stream_id = normalize_profile_text(
        "invalid-stream-id",
        "streamId",
        &request.stream_id,
        MAX_PROFILE_ID_BYTES,
    )?;
    let (abort_handle, abort_registration) = AbortHandle::new_pair();
    stream_state.register(stream_id.clone(), abort_handle)?;

    let result = async {
        let (project_root, runtime_enabled, now) =
            run_guarded("runtime_model_call_stream", || {
                let runtime_enabled = resolve_work_runtime_enabled(read_work_runtime_flag_value());
                let project_root = root_state.get();
                let now = now_for_enabled_project(project_root.as_deref(), runtime_enabled)?;
                Ok((project_root, runtime_enabled, now))
            })?;

        let client = model_call_stream_client()?;
        let store = active_secret_store(&app)?;
        let stream = runtime_model_call_stream_for_project_with_store(
            project_root.as_deref(),
            runtime_enabled,
            request.forward,
            now,
            store.as_ref(),
            &client,
            &on_event,
        );
        match Abortable::new(stream, abort_registration).await {
            Ok(Ok(())) => Ok(()),
            Ok(Err(err)) => {
                send_model_call_stream_error(&on_event, &err, None);
                Ok(())
            }
            Err(_) => {
                send_model_call_stream_done(&on_event);
                Ok(())
            }
        }
    }
    .await;
    stream_state.remove(&stream_id)?;
    result
}

#[tauri::command]
pub fn runtime_model_call_stream_cancel(
    stream_id: String,
    stream_state: State<'_, RuntimeModelCallStreamState>,
) -> Result<(), String> {
    let stream_id = normalize_profile_text(
        "invalid-stream-id",
        "streamId",
        &stream_id,
        MAX_PROFILE_ID_BYTES,
    )?;
    stream_state.cancel(&stream_id)
}

fn model_call_forward_client() -> Result<Client, String> {
    Client::builder()
        .timeout(Duration::from_secs(MODEL_CALL_FORWARD_TIMEOUT_SECS))
        // Anti-leak constraint #2: never follow a redirect with the
        // Authorization/x-api-key header attached. Disabling redirects
        // entirely is simpler to audit than a same-origin allowlist.
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|err| format!("model-call-forward-client-failed: {err}"))
}

fn model_call_stream_client() -> Result<Client, String> {
    Client::builder()
        .connect_timeout(Duration::from_secs(MODEL_CALL_STREAM_CONNECT_TIMEOUT_SECS))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|err| format!("model-call-stream-client-failed: {err}"))
}

async fn runtime_profile_probe_for_project_with_store(
    project_root: Option<&Path>,
    enabled: bool,
    request: RuntimeProfileProbeRequest,
    now: i64,
    store: &(impl SecretStore + ?Sized),
    client: &Client,
) -> Result<RuntimeProfileProbeResult, String> {
    let project_root = require_enabled_project(project_root, enabled)?;
    let force = request.force.unwrap_or(false);
    let (cached, target) = resolve_profile_probe_target(project_root, request, now, force, store)?;
    if let Some(result) = cached {
        return Ok(result);
    }

    let target = target.expect("probe target should exist when no cached result is returned");
    let outcome = probe_profile_target(client, &target, now).await;
    let profile = if let Some(profile_id) = target.profile_id {
        Some(apply_profile_probe_outcome(
            project_root,
            &profile_id,
            &outcome,
            now,
        )?)
    } else {
        None
    };
    Ok(runtime_profile_probe_result(profile, outcome, now))
}

async fn runtime_profile_models_list_for_project_with_store(
    project_root: Option<&Path>,
    enabled: bool,
    request: RuntimeProfileModelsListRequest,
    store: &(impl SecretStore + ?Sized),
    client: &Client,
) -> Result<RuntimeProfileModelsListResult, String> {
    let project_root = require_enabled_project(project_root, enabled)?;
    let target = resolve_profile_models_list_target(project_root, request, store)?;
    list_profile_models(client, &target).await
}

fn runtime_profile_probe_result(
    profile: Option<RuntimeProfileRecord>,
    outcome: RuntimeProfileProbeOutcome,
    now: i64,
) -> RuntimeProfileProbeResult {
    RuntimeProfileProbeResult {
        profile,
        status: outcome.status,
        capability_json: outcome.capability_json,
        capability_version: PROFILE_PROBE_CAPABILITY_VERSION.to_string(),
        checked_at_ms: now,
        backoff_until_ms: outcome.backoff_until_ms,
        message: outcome.message,
    }
}

fn resolve_profile_probe_target(
    project_root: &Path,
    request: RuntimeProfileProbeRequest,
    now: i64,
    force: bool,
    store: &(impl SecretStore + ?Sized),
) -> Result<
    (
        Option<RuntimeProfileProbeResult>,
        Option<RuntimeProfileProbeTarget>,
    ),
    String,
> {
    match (request.profile_id, request.draft) {
        (Some(profile_id), None) => {
            let profile_id = normalize_profile_text(
                "invalid-profile-id",
                "profileId",
                &profile_id,
                MAX_PROFILE_ID_BYTES,
            )?;
            let connection = open_profile_runtime_locked(project_root)?;
            let profile = read_visible_profile(&connection, &profile_id)?;
            if !force
                && profile.capability_version == PROFILE_PROBE_CAPABILITY_VERSION
                && profile
                    .probe_backoff_until_ms
                    .is_some_and(|backoff| backoff > now)
            {
                let message = profile
                    .last_capability_error
                    .clone()
                    .unwrap_or_else(|| "Probe is waiting for retry backoff.".to_string());
                return Ok((
                    Some(RuntimeProfileProbeResult {
                        profile: Some(profile.clone()),
                        status: profile.capability_status.clone(),
                        capability_json: profile.capability_json.clone(),
                        capability_version: profile.capability_version.clone(),
                        checked_at_ms: profile.capability_checked_at_ms.unwrap_or(0),
                        backoff_until_ms: profile.probe_backoff_until_ms,
                        message,
                    }),
                    None,
                ));
            }
            Ok((None, Some(probe_target_from_profile(profile, store)?)))
        }
        (None, Some(draft)) => Ok((
            None,
            Some(probe_target_from_draft(draft, request.raw_secret)?),
        )),
        _ => Err(
            "invalid-profile-probe-request: provide exactly one of profileId or draft".to_string(),
        ),
    }
}

fn resolve_profile_models_list_target(
    project_root: &Path,
    request: RuntimeProfileModelsListRequest,
    store: &(impl SecretStore + ?Sized),
) -> Result<RuntimeProfileModelsListTarget, String> {
    let RuntimeProfileModelsListRequest {
        profile_id,
        draft,
        raw_secret,
        models_url,
    } = request;
    match (profile_id, draft) {
        (Some(profile_id), None) => {
            let profile_id = normalize_profile_text(
                "invalid-profile-id",
                "profileId",
                &profile_id,
                MAX_PROFILE_ID_BYTES,
            )?;
            let connection = open_profile_runtime_locked(project_root)?;
            let profile = read_visible_profile(&connection, &profile_id)?;
            let target = probe_target_from_profile(profile, store)?;
            RuntimeProfileModelsListTarget::from_probe_target(&target, models_url)
        }
        (None, Some(draft)) => {
            RuntimeProfileModelsListTarget::from_draft(draft, raw_secret, models_url)
        }
        _ => Err(
            "invalid-profile-models-list-request: provide exactly one of profileId or draft"
                .to_string(),
        ),
    }
}

fn probe_target_from_draft(
    draft: RuntimeProfileProbeDraftRequest,
    raw_secret: Option<String>,
) -> Result<RuntimeProfileProbeTarget, String> {
    let kind = normalize_profile_kind(&draft.kind)?.to_string();
    let provider_id = normalize_profile_text(
        "invalid-provider-id",
        "providerId",
        &draft.provider_id,
        MAX_PROFILE_PROVIDER_BYTES,
    )?;
    let model_id = normalize_profile_text(
        "invalid-model-id",
        "modelId",
        &draft.model_id,
        MAX_PROFILE_MODEL_BYTES,
    )?;
    let agent_sdk_model_id = normalize_optional_profile_text(
        draft.agent_sdk_model_id,
        "invalid-agent-sdk-model-id",
        "agentSdkModelId",
        MAX_PROFILE_SDK_MODEL_BYTES,
    )?;
    let endpoint = normalize_optional_profile_text(
        draft.endpoint,
        "invalid-endpoint",
        "endpoint",
        MAX_PROFILE_ENDPOINT_BYTES,
    )?;
    let api_mode = normalize_profile_api_mode(&draft.api_mode)?.to_string();
    let auth_style = normalize_profile_auth_style(&draft.auth_style)?.to_string();
    let secret_value = if profile_secret_required(&auth_style) {
        raw_secret
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| {
                "profile-probe-missing-secret: draft probes require rawSecret".to_string()
            })?
            .to_string()
    } else {
        String::new()
    };
    Ok(RuntimeProfileProbeTarget {
        profile_id: None,
        kind,
        provider_id,
        model_id,
        agent_sdk_model_id,
        endpoint,
        api_mode,
        auth_style,
        secret_value,
    })
}

fn probe_target_from_profile(
    profile: RuntimeProfileRecord,
    store: &(impl SecretStore + ?Sized),
) -> Result<RuntimeProfileProbeTarget, String> {
    let secret_value = match profile_secret_required(&profile.auth_style) {
        true => {
            let secret_ref = profile.secret_ref.as_deref().ok_or_else(|| {
                "profile-probe-missing-secret: stored profile has no secretRef".to_string()
            })?;
            read_profile_secret(store, secret_ref)?
        }
        false => String::new(),
    };
    Ok(RuntimeProfileProbeTarget {
        profile_id: Some(profile.profile_id),
        kind: profile.kind,
        provider_id: profile.provider_id,
        model_id: profile.model_id,
        agent_sdk_model_id: profile.agent_sdk_model_id,
        endpoint: profile.endpoint,
        api_mode: profile.api_mode,
        auth_style: profile.auth_style,
        secret_value,
    })
}

struct RuntimeProfileModelsListTarget {
    endpoint: Option<String>,
    api_mode: String,
    auth_style: String,
    secret_value: String,
    models_url: Option<String>,
}

impl RuntimeProfileModelsListTarget {
    fn from_probe_target(
        target: &RuntimeProfileProbeTarget,
        models_url: Option<String>,
    ) -> Result<Self, String> {
        Ok(Self {
            endpoint: target.endpoint.clone(),
            api_mode: target.api_mode.clone(),
            auth_style: target.auth_style.clone(),
            secret_value: target.secret_value.clone(),
            models_url: normalize_optional_profile_text(
                models_url,
                "invalid-models-url",
                "modelsUrl",
                MAX_PROFILE_ENDPOINT_BYTES,
            )?,
        })
    }

    fn from_draft(
        draft: RuntimeProfileModelsListDraftRequest,
        raw_secret: Option<String>,
        models_url: Option<String>,
    ) -> Result<Self, String> {
        let endpoint = normalize_optional_profile_text(
            draft.endpoint,
            "invalid-endpoint",
            "endpoint",
            MAX_PROFILE_ENDPOINT_BYTES,
        )?;
        let api_mode = normalize_profile_api_mode(&draft.api_mode)?.to_string();
        let auth_style = normalize_profile_auth_style(&draft.auth_style)?.to_string();
        let secret_value = if profile_secret_required(&auth_style) {
            raw_secret
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| {
                    "profile-models-list-missing-secret: draft requests require rawSecret"
                        .to_string()
                })?
                .to_string()
        } else {
            String::new()
        };
        Ok(Self {
            endpoint,
            api_mode,
            auth_style,
            secret_value,
            models_url: normalize_optional_profile_text(
                models_url,
                "invalid-models-url",
                "modelsUrl",
                MAX_PROFILE_ENDPOINT_BYTES,
            )?,
        })
    }
}

pub(crate) fn profile_secret_required(auth_style: &str) -> bool {
    matches!(auth_style, "bearer" | "x-api-key" | "api-key")
}

fn apply_profile_probe_outcome(
    project_root: &Path,
    profile_id: &str,
    outcome: &RuntimeProfileProbeOutcome,
    now: i64,
) -> Result<RuntimeProfileRecord, String> {
    let status = normalize_profile_capability_status(&outcome.status)?;
    let capability_json = normalize_profile_json(
        "invalid-capability-json",
        "capabilityJson",
        &outcome.capability_json,
        MAX_PROFILE_CAPABILITY_JSON_BYTES,
    )?;
    let capability_version = normalize_profile_text(
        "invalid-capability-version",
        "capabilityVersion",
        PROFILE_PROBE_CAPABILITY_VERSION,
        MAX_PROFILE_CAPABILITY_VERSION_BYTES,
    )?;
    let backoff = outcome
        .backoff_until_ms
        .map(|value| {
            normalize_non_negative_ms("invalid-probe-backoff", "probeBackoffUntilMs", value)
        })
        .transpose()?;
    let last_error = outcome
        .last_capability_error
        .clone()
        .map(|value| {
            normalize_profile_text(
                "invalid-capability-error",
                "lastCapabilityError",
                &value,
                MAX_PROFILE_CAPABILITY_ERROR_BYTES,
            )
        })
        .transpose()?;

    with_runtime_writer(|| {
        let mut connection = open_profile_runtime_locked(project_root)?;
        let tx = connection.transaction().map_err(tx_err)?;
        read_visible_profile_tx(&tx, profile_id)?;
        tx.execute(
            "UPDATE runtime_model_profiles
             SET capability_status = ?2,
                 capability_json = ?3,
                 capability_version = ?4,
                 capability_checked_at_ms = ?5,
                 probe_backoff_until_ms = ?6,
                 last_capability_error = ?7,
                 updated_at_ms = ?5
             WHERE profile_id = ?1",
            params![
                profile_id,
                status,
                capability_json,
                capability_version,
                now,
                backoff,
                last_error,
            ],
        )
        .map_err(|err| format!("profile-probe-cache-update-failed: {err}"))?;
        let profile = read_visible_profile_tx(&tx, profile_id)?;
        tx.commit().map_err(tx_err)?;
        Ok(profile)
    })
}

async fn probe_profile_target(
    client: &Client,
    target: &RuntimeProfileProbeTarget,
    now: i64,
) -> RuntimeProfileProbeOutcome {
    match target.api_mode.as_str() {
        "anthropic-messages" => probe_anthropic_messages(client, target, now).await,
        "openai-chat-completions" => probe_openai_chat(client, target, now).await,
        "google-generate-content" => probe_google_generate_content(client, target, now).await,
        _ => unsupported_probe_outcome(target, now, "Local CLI profiles are not HTTP-probed."),
    }
}

async fn probe_anthropic_messages(
    client: &Client,
    target: &RuntimeProfileProbeTarget,
    now: i64,
) -> RuntimeProfileProbeOutcome {
    let url = anthropic_messages_url(target.endpoint.as_deref());
    let headers = probe_headers(
        "anthropic-messages",
        &target.auth_style,
        &target.secret_value,
    );
    let message_body = serde_json::json!({
        "model": target.model_id,
        "max_tokens": PROFILE_PROBE_MAX_TOKENS,
        "system": "Reply with OK.",
        "messages": [{ "role": "user", "content": "Reply OK." }]
    });
    let message = post_probe_json(client, &url, headers.clone(), message_body, false).await;
    if !message.ok {
        return failed_primary_probe_outcome(target, now, message.message);
    }

    let stream_body = serde_json::json!({
        "model": target.model_id,
        "max_tokens": PROFILE_PROBE_MAX_TOKENS,
        "stream": true,
        "messages": [{ "role": "user", "content": "Reply OK." }]
    });
    let stream = post_probe_json(client, &url, headers.clone(), stream_body, true).await;
    let tool_body = serde_json::json!({
        "model": target.model_id,
        "max_tokens": PROFILE_PROBE_MAX_TOKENS,
        "tools": [{
            "name": "profile_probe_tool",
            "description": "A no-op tool used only to check tool schema support.",
            "input_schema": {
                "type": "object",
                "properties": {},
                "additionalProperties": false
            }
        }],
        "messages": [{ "role": "user", "content": "Reply OK." }]
    });
    let tool = post_probe_json(client, &url, headers, tool_body, false).await;
    let status = if stream.ok && tool.ok {
        "supported"
    } else {
        "limited"
    };
    let message = if status == "supported" {
        "Probe succeeded: messages, streaming, and tool schema are supported.".to_string()
    } else {
        "Probe completed with limited capabilities.".to_string()
    };
    probe_outcome(
        now,
        status,
        message,
        None,
        capability_json(
            target,
            serde_json::json!({
                "messages": message_check(true, None),
                "streaming": message_check(stream.ok, stream.error_code),
                "toolUse": message_check(tool.ok, tool.error_code),
                "systemPrompt": message_check(true, None)
            }),
            true,
            stream.ok && tool.ok,
            serde_json::json!({ "maxOutputTokens": PROFILE_PROBE_MAX_TOKENS }),
            "unknown",
        ),
    )
}

async fn probe_openai_chat(
    client: &Client,
    target: &RuntimeProfileProbeTarget,
    now: i64,
) -> RuntimeProfileProbeOutcome {
    let url = openai_chat_url(target.endpoint.as_deref());
    let body = serde_json::json!({
        "model": target.model_id,
        "max_tokens": PROFILE_PROBE_MAX_TOKENS,
        "messages": [{ "role": "user", "content": "Reply OK." }]
    });
    let result = post_probe_json(
        client,
        &url,
        probe_headers(
            "openai-chat-completions",
            &target.auth_style,
            &target.secret_value,
        ),
        body,
        false,
    )
    .await;
    if !result.ok {
        return failed_primary_probe_outcome(target, now, result.message);
    }
    let status = if target.kind == "agent-run" {
        "limited"
    } else {
        "supported"
    };
    probe_outcome(
        now,
        status,
        "Probe succeeded: chat completions model-call is supported.".to_string(),
        None,
        capability_json(
            target,
            serde_json::json!({
                "messages": message_check(true, None),
                "streaming": message_check(false, Some("not-probed".to_string())),
                "toolUse": message_check(false, Some("not-probed".to_string())),
                "systemPrompt": message_check(false, Some("not-probed".to_string()))
            }),
            true,
            false,
            serde_json::json!({ "maxOutputTokens": PROFILE_PROBE_MAX_TOKENS }),
            "unsupported",
        ),
    )
}

async fn probe_google_generate_content(
    client: &Client,
    target: &RuntimeProfileProbeTarget,
    now: i64,
) -> RuntimeProfileProbeOutcome {
    let url = google_generate_content_url(target.endpoint.as_deref(), &target.model_id);
    let body = serde_json::json!({
        "contents": [{
            "role": "user",
            "parts": [{ "text": "Reply OK." }]
        }]
    });
    let result = post_probe_json(
        client,
        &url,
        probe_headers(
            "google-generate-content",
            &target.auth_style,
            &target.secret_value,
        ),
        body,
        false,
    )
    .await;
    if !result.ok {
        return failed_primary_probe_outcome(target, now, result.message);
    }
    let status = if target.kind == "agent-run" {
        "limited"
    } else {
        "supported"
    };
    probe_outcome(
        now,
        status,
        "Probe succeeded: generateContent model-call is supported.".to_string(),
        None,
        capability_json(
            target,
            serde_json::json!({
                "messages": message_check(true, None),
                "streaming": message_check(false, Some("not-probed".to_string())),
                "toolUse": message_check(false, Some("not-probed".to_string())),
                "systemPrompt": message_check(false, Some("not-probed".to_string()))
            }),
            true,
            false,
            serde_json::json!({ "maxOutputTokens": PROFILE_PROBE_MAX_TOKENS }),
            "unsupported",
        ),
    )
}

fn unsupported_probe_outcome(
    target: &RuntimeProfileProbeTarget,
    now: i64,
    message: &str,
) -> RuntimeProfileProbeOutcome {
    probe_outcome(
        now,
        "unsupported",
        message.to_string(),
        None,
        capability_json(
            target,
            serde_json::json!({
                "messages": message_check(false, Some("unsupported-api-mode".to_string())),
                "streaming": message_check(false, Some("unsupported-api-mode".to_string())),
                "toolUse": message_check(false, Some("unsupported-api-mode".to_string())),
                "systemPrompt": message_check(false, Some("unsupported-api-mode".to_string()))
            }),
            false,
            false,
            serde_json::json!({}),
            "unsupported",
        ),
    )
}

fn failed_primary_probe_outcome(
    target: &RuntimeProfileProbeTarget,
    now: i64,
    message: String,
) -> RuntimeProfileProbeOutcome {
    let safe_message = bounded_profile_probe_error(&message);
    probe_outcome(
        now,
        "error",
        safe_message.clone(),
        Some(safe_message),
        capability_json(
            target,
            serde_json::json!({
                "messages": message_check(false, Some("primary-probe-failed".to_string())),
                "streaming": message_check(false, Some("not-run".to_string())),
                "toolUse": message_check(false, Some("not-run".to_string())),
                "systemPrompt": message_check(false, Some("not-run".to_string()))
            }),
            false,
            false,
            serde_json::json!({}),
            "unknown",
        ),
    )
}

fn probe_outcome(
    now: i64,
    status: &str,
    message: String,
    last_capability_error: Option<String>,
    capability: serde_json::Value,
) -> RuntimeProfileProbeOutcome {
    RuntimeProfileProbeOutcome {
        status: status.to_string(),
        capability_json: capability.to_string(),
        message,
        backoff_until_ms: if status == "error" {
            now.checked_add(PROFILE_PROBE_BACKOFF_MS)
        } else {
            None
        },
        last_capability_error,
    }
}

fn capability_json(
    target: &RuntimeProfileProbeTarget,
    checks: serde_json::Value,
    model_call_supported: bool,
    agent_run_supported: bool,
    context: serde_json::Value,
    sdk_state: &str,
) -> serde_json::Value {
    serde_json::json!({
        "version": PROFILE_PROBE_CAPABILITY_VERSION,
        "apiMode": target.api_mode,
        "providerId": target.provider_id,
        "modelId": target.model_id,
        "agentSdkModelId": target.agent_sdk_model_id,
        "authStyle": target.auth_style,
        "endpointKind": endpoint_kind(target.endpoint.as_deref()),
        "checks": checks,
        "modelCallSupported": model_call_supported,
        "agentRunSupported": agent_run_supported,
        "thinking": "unknown",
        "tokenCounting": "unknown",
        "context": context,
        "claudeAgentSdk": {
            "contextManagement": sdk_state,
            "checkpointing": sdk_state,
            "betaHeaders": sdk_state
        }
    })
}

#[derive(Debug)]
struct ProbeHttpResult {
    ok: bool,
    message: String,
    error_code: Option<String>,
}

async fn post_probe_json(
    client: &Client,
    url: &str,
    headers: HeaderMap,
    body: serde_json::Value,
    expect_stream: bool,
) -> ProbeHttpResult {
    let response = client.post(url).headers(headers).json(&body).send().await;
    let response = match response {
        Ok(response) => response,
        Err(_) => {
            return ProbeHttpResult {
                ok: false,
                message: "profile-probe-network-failed: request failed".to_string(),
                error_code: Some("network-failed".to_string()),
            };
        }
    };
    let status = response.status();
    if !status.is_success() {
        return ProbeHttpResult {
            ok: false,
            message: format!("profile-probe-http-failed: provider returned {status}"),
            error_code: Some(format!("http-{}", status.as_u16())),
        };
    }
    if !expect_stream {
        return ProbeHttpResult {
            ok: true,
            message: "ok".to_string(),
            error_code: None,
        };
    }
    let text = match response.text().await {
        Ok(text) => text,
        Err(_) => {
            return ProbeHttpResult {
                ok: false,
                message: "profile-probe-stream-read-failed: response stream failed".to_string(),
                error_code: Some("stream-read-failed".to_string()),
            };
        }
    };
    let ok = text.lines().any(|line| {
        let line = line.trim_start();
        line.starts_with("event:") || line.starts_with("data:")
    });
    ProbeHttpResult {
        ok,
        message: if ok {
            "ok".to_string()
        } else {
            "profile-probe-stream-format-failed: response was not SSE-like".to_string()
        },
        error_code: if ok {
            None
        } else {
            Some("stream-format-failed".to_string())
        },
    }
}

fn probe_headers(api_mode: &str, auth_style: &str, secret_value: &str) -> HeaderMap {
    let mut headers = HeaderMap::new();
    headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    if api_mode == "anthropic-messages" {
        headers.insert("anthropic-version", HeaderValue::from_static("2023-06-01"));
    }
    let Ok(secret) = HeaderValue::from_str(secret_value) else {
        return headers;
    };
    match (api_mode, auth_style) {
        (_, "none") | (_, "oauth-local-cli") => {}
        ("anthropic-messages", "x-api-key") => {
            headers.insert("x-api-key", secret);
        }
        ("google-generate-content", "api-key" | "x-api-key") => {
            headers.insert("x-goog-api-key", secret);
        }
        (_, "x-api-key") => {
            headers.insert("x-api-key", secret);
        }
        _ => {
            let bearer = format!("Bearer {secret_value}");
            if let Ok(value) = HeaderValue::from_str(&bearer) {
                headers.insert(AUTHORIZATION, value);
            }
        }
    }
    headers
}

async fn list_profile_models(
    client: &Client,
    target: &RuntimeProfileModelsListTarget,
) -> Result<RuntimeProfileModelsListResult, String> {
    let candidates = profile_models_url_candidates(target)?;
    let headers = probe_headers(&target.api_mode, &target.auth_style, &target.secret_value);
    let mut failures = Vec::new();
    for url in &candidates {
        let response = client.get(url).headers(headers.clone()).send().await;
        let response = match response {
            Ok(response) => response,
            Err(_) => {
                failures.push(format!("{url}: network failed"));
                continue;
            }
        };
        let status = response.status();
        if !status.is_success() {
            failures.push(format!("{url}: provider returned {status}"));
            continue;
        }
        let body = match response.text().await {
            Ok(body) => body,
            Err(_) => {
                failures.push(format!("{url}: response read failed"));
                continue;
            }
        };
        match parse_profile_models_body(&body) {
            Some(models) => {
                return Ok(RuntimeProfileModelsListResult {
                    models,
                    source_url: url.clone(),
                });
            }
            None => failures.push(format!("{url}: response was not a model list")),
        }
    }
    Err(format!(
        "profile-models-list-failed: no usable model list; attempted [{}]; failures [{}]",
        candidates.join(", "),
        failures.join("; ")
    ))
}

fn profile_models_url_candidates(
    target: &RuntimeProfileModelsListTarget,
) -> Result<Vec<String>, String> {
    if let Some(models_url) = target.models_url.as_ref() {
        return Ok(vec![models_url.trim_end_matches('/').to_string()]);
    }

    let base = endpoint_base(
        target.endpoint.as_deref(),
        default_models_endpoint_base(&target.api_mode),
    );
    let mut candidates = Vec::new();
    push_unique_url(&mut candidates, &join_url_path(base, "v1/models"));
    push_unique_url(&mut candidates, &join_url_path(base, "models"));

    for stripped in stripped_models_endpoint_bases(base) {
        push_unique_url(&mut candidates, &join_url_path(&stripped, "models"));
        push_unique_url(&mut candidates, &join_url_path(&stripped, "v1/models"));
    }
    Ok(candidates)
}

fn default_models_endpoint_base(api_mode: &str) -> &'static str {
    match api_mode {
        "anthropic-messages" => "https://api.anthropic.com",
        "google-generate-content" => "https://generativelanguage.googleapis.com",
        _ => "https://api.openai.com",
    }
}

fn stripped_models_endpoint_bases(base: &str) -> Vec<String> {
    const KNOWN_SUFFIXES: &[&str] = &[
        "/anthropic/coding",
        "/api/anthropic",
        "/apps/anthropic",
        "/api/compatible",
        "/anthropic",
        "/step_plan",
        // KAT templates contain `{ENDPOINT_ID}` before this suffix; stripping it
        // still only gives a best-effort candidate and live fetch failure is expected.
        "/claude-code-proxy",
    ];
    let trimmed = base.trim_end_matches('/');
    let mut out = Vec::new();
    for suffix in KNOWN_SUFFIXES {
        if let Some(stripped) = trimmed.strip_suffix(suffix) {
            if !stripped.is_empty() {
                push_unique_url(&mut out, stripped);
            }
        }
    }
    out
}

fn join_url_path(base: &str, path: &str) -> String {
    format!(
        "{}/{}",
        base.trim_end_matches('/'),
        path.trim_start_matches('/')
    )
}

fn push_unique_url(out: &mut Vec<String>, value: &str) {
    let value = value.trim().trim_end_matches('/');
    if !value.is_empty() && !out.iter().any(|existing| existing == value) {
        out.push(value.to_string());
    }
}

fn parse_profile_models_body(body: &str) -> Option<Vec<String>> {
    let value: serde_json::Value = serde_json::from_str(body).ok()?;
    let source = if let Some(data) = value.get("data").and_then(|item| item.as_array()) {
        data
    } else if let Some(models) = value.get("models").and_then(|item| item.as_array()) {
        models
    } else {
        value.as_array()?
    };
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    for item in source {
        let model = item
            .as_str()
            .or_else(|| item.get("id").and_then(|value| value.as_str()))
            .or_else(|| item.get("name").and_then(|value| value.as_str()))
            .map(str::trim)
            .filter(|value| !value.is_empty());
        if let Some(model) = model {
            let model = model.to_string();
            if seen.insert(model.clone()) {
                out.push(model);
            }
        }
    }
    if out.is_empty() {
        None
    } else {
        Some(out)
    }
}

fn anthropic_messages_url(endpoint: Option<&str>) -> String {
    // Keep these cases aligned with src/lib/llm-providers.ts buildAnthropicUrl.
    let base = endpoint_base(endpoint, "https://api.anthropic.com");
    if base.ends_with("/messages") {
        base.to_string()
    } else if has_version_suffix(base) {
        format!("{base}/messages")
    } else {
        format!("{base}/v1/messages")
    }
}

fn openai_chat_url(endpoint: Option<&str>) -> String {
    let base = endpoint_base(endpoint, "https://api.openai.com");
    if base.ends_with("/chat/completions") {
        base.to_string()
    } else if has_version_suffix(base) {
        format!("{base}/chat/completions")
    } else {
        format!("{base}/v1/chat/completions")
    }
}

fn google_generate_content_url(endpoint: Option<&str>, model_id: &str) -> String {
    let base = endpoint_base(endpoint, "https://generativelanguage.googleapis.com/v1beta");
    if base.ends_with(":generateContent") {
        base.to_string()
    } else {
        format!(
            "{base}/models/{}:generateContent",
            encode_url_path_segment(model_id)
        )
    }
}

fn encode_url_path_segment(value: &str) -> String {
    let mut encoded = String::new();
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                encoded.push(byte as char);
            }
            _ => encoded.push_str(&format!("%{byte:02X}")),
        }
    }
    encoded
}

fn endpoint_base<'a>(endpoint: Option<&'a str>, default: &'a str) -> &'a str {
    endpoint
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(default)
        .trim_end_matches('/')
}

fn has_version_suffix(value: &str) -> bool {
    let Some(segment) = value.rsplit('/').next() else {
        return false;
    };
    let Some(digits) = segment.strip_prefix('v') else {
        return false;
    };
    !digits.is_empty() && digits.chars().all(|value| value.is_ascii_digit())
}

fn endpoint_kind(endpoint: Option<&str>) -> &'static str {
    match endpoint.map(str::trim).filter(|value| !value.is_empty()) {
        Some(value)
            if value.starts_with("http://127.0.0.1") || value.starts_with("http://localhost") =>
        {
            "local"
        }
        Some(_) => "custom",
        None => "default",
    }
}

fn message_check(supported: bool, error_code: Option<String>) -> serde_json::Value {
    serde_json::json!({
        "supported": supported,
        "errorCode": error_code
    })
}

fn bounded_profile_probe_error(message: &str) -> String {
    if message.len() <= MAX_PROFILE_CAPABILITY_ERROR_BYTES {
        return message.to_string();
    }
    let mut end = MAX_PROFILE_CAPABILITY_ERROR_BYTES;
    while !message.is_char_boundary(end) {
        end -= 1;
    }
    message[..end].to_string()
}

struct ModelCallForwardTarget {
    url: String,
    headers: HeaderMap,
    body: serde_json::Value,
}

/// Re-reads the claimed profile server-side (never trusting
/// `request.provider`/`apiMode`/`model` as a destination — those are only
/// cross-checked for a clearer error), builds the destination URL and auth
/// header from the STORED profile, and injects the secret.
///
/// Anti-leak constraints shared by forward and stream paths:
/// 1. No error path here ever interpolates request headers, a full
///    destination URL, raw reqwest Debug output, or a substring that could
///    contain `Authorization`/`x-api-key`/`api-key` — every error is a
///    fixed, static message or a fixed prefix + safe fields (status code,
///    clamped retry-after ms).
/// 2. Redirects are disabled entirely by the caller's model-call client, so
///    no redirect can ever carry the injected auth header anywhere.
/// 3. Non-2xx provider response bodies are never read into returned or
///    streamed errors — only the HTTP status is surfaced.
/// 4. The sanitized errors returned here are already safe before they ever
///    reach `runtime_profile_pool_release`'s breaker-error redactor; this
///    function does not rely on that redactor as a backstop.
/// 5. Forward-only: on success, `runtime_model_call_forward_for_project_with_store`
///    returns the raw provider response body — no envelope, no headers.
fn resolve_model_call_forward_target(
    project_root: Option<&Path>,
    enabled: bool,
    request: RuntimeModelCallForwardRequest,
    now: i64,
    store: &(impl SecretStore + ?Sized),
) -> Result<ModelCallForwardTarget, String> {
    let project_root = require_enabled_project(project_root, enabled)?;
    let claim_id = normalize_profile_text(
        "invalid-claim-id",
        "claimId",
        &request.claim_id,
        MAX_PROFILE_ID_BYTES,
    )?;

    let (profile, claim) = with_runtime_writer(|| {
        let mut connection = open_profile_pool_runtime_locked(project_root)?;
        let tx = connection.transaction().map_err(tx_err)?;
        expire_profile_claims_tx(&tx, now)?;
        let claim = read_active_profile_claim_by_id_tx(&tx, &claim_id, now)?
            .ok_or_else(|| PROFILE_CLAIM_INACTIVE_ERROR.to_string())?;
        if claim.kind != "model-call" || !model_call_task_family_supported(&claim.task_family) {
            return Err(
                "model-call-claim-unsupported: claim is not a supported model-call claim"
                    .to_string(),
            );
        }
        let profile = read_visible_profile_tx(&tx, &claim.profile_id)?;
        if !profile_pool_profile_base_eligible(
            &tx,
            &profile,
            "model-call",
            &claim.task_family,
            now,
        )? {
            return Err(
                "model-call-profile-unsupported: profile is not eligible for model-call use"
                    .to_string(),
            );
        }
        tx.commit().map_err(tx_err)?;
        Ok((profile, claim))
    })?;

    if profile.profile_id != claim.profile_id {
        return Err(
            "model-call-claim-mismatch: claim profile does not match resolved profile".to_string(),
        );
    }
    require_plan_field_match(&profile.provider_id, &request.provider, "provider")?;
    require_plan_field_match(&profile.api_mode, &request.api_mode, "apiMode")?;
    require_plan_field_match(&profile.model_id, &request.model, "model")?;

    let secret_value = if profile_secret_required(&profile.auth_style) {
        let secret_ref = profile.secret_ref.as_deref().ok_or_else(|| {
            "model-call-missing-secret: stored profile has no secretRef".to_string()
        })?;
        read_profile_secret(store, secret_ref)?
    } else {
        String::new()
    };

    let url = match profile.api_mode.as_str() {
        "anthropic-messages" => anthropic_messages_url(profile.endpoint.as_deref()),
        "openai-chat-completions" => openai_chat_url(profile.endpoint.as_deref()),
        "google-generate-content" => {
            google_stream_generate_content_url(profile.endpoint.as_deref(), &profile.model_id)
        }
        _ => {
            return Err(
                "model-call-api-mode-unsupported: profile api mode has no HTTP model-call transport"
                    .to_string(),
            );
        }
    };
    let headers = probe_headers(&profile.api_mode, &profile.auth_style, &secret_value);
    Ok(ModelCallForwardTarget {
        url,
        headers,
        body: request.body,
    })
}

async fn runtime_model_call_forward_for_project_with_store(
    project_root: Option<&Path>,
    enabled: bool,
    request: RuntimeModelCallForwardRequest,
    now: i64,
    store: &(impl SecretStore + ?Sized),
    client: &Client,
) -> Result<String, String> {
    let target = resolve_model_call_forward_target(project_root, enabled, request, now, store)?;

    // Anti-leak constraint #1: on network failure, do not interpolate the
    // underlying reqwest::Error (its Display can include the destination
    // URL). Mirrors `post_probe_json`'s existing pattern.
    let response = client
        .post(&target.url)
        .headers(target.headers)
        .json(&target.body)
        .send()
        .await
        .map_err(|_| "model-call-network-failed: request failed".to_string())?;

    let status = response.status();
    if status.as_u16() == 429 {
        let retry_after_ms = model_call_retry_after_ms(response.headers());
        // Anti-leak constraint #3: never read/forward the 429 body.
        return Err(format!(
            "model-call-rate-limited: retryAfterMs={retry_after_ms} provider returned {status}"
        ));
    }
    if !status.is_success() {
        // Anti-leak constraint #3: non-2xx bodies are never surfaced.
        return Err(format!(
            "model-call-http-failed: provider returned {status}"
        ));
    }

    response
        .text()
        .await
        .map_err(|_| "model-call-response-read-failed: response stream failed".to_string())
}

fn model_call_task_family_supported(task_family: &str) -> bool {
    // Keep in sync with the frontend ModelCallTaskFamily union in
    // src/lib/pool-chat.ts; routed model-call claims must agree on both sides.
    task_family == PREPARE_PROFILE_TASK_FAMILY
        || matches!(task_family, "chat" | "synthesis" | "review" | "vision")
}

async fn runtime_model_call_stream_for_project_with_store(
    project_root: Option<&Path>,
    enabled: bool,
    request: RuntimeModelCallForwardRequest,
    now: i64,
    store: &(impl SecretStore + ?Sized),
    client: &Client,
    on_event: &Channel<serde_json::Value>,
) -> Result<(), String> {
    // Shares anti-leak constraints #1-#4 with forward; #5 is forward-only because streams emit structured chunk/done/error events.
    let target = resolve_model_call_forward_target(project_root, enabled, request, now, store)?;
    let mut response = client
        .post(&target.url)
        .headers(target.headers)
        .json(&target.body)
        .send()
        .await
        .map_err(|_| "model-call-network-failed: request failed".to_string())?;

    let status = response.status();
    if status.as_u16() == 429 {
        let retry_after_ms = model_call_retry_after_ms(response.headers());
        send_model_call_stream_error(
            on_event,
            &format!(
                "model-call-rate-limited: retryAfterMs={retry_after_ms} provider returned {status}"
            ),
            Some(429),
        );
        return Ok(());
    }
    if !status.is_success() {
        send_model_call_stream_error(
            on_event,
            &format!("model-call-http-failed: provider returned {status}"),
            Some(status.as_u16()),
        );
        return Ok(());
    }

    let mut utf8_buffer = Vec::new();
    loop {
        match tokio::time::timeout(
            Duration::from_secs(MODEL_CALL_STREAM_CHUNK_TIMEOUT_SECS),
            response.chunk(),
        )
        .await
        {
            Ok(Ok(Some(chunk))) => {
                if let Some(text) = drain_complete_utf8_text(&mut utf8_buffer, &chunk) {
                    send_model_call_stream_chunk(on_event, text);
                }
            }
            Ok(Ok(None)) => {
                if !utf8_buffer.is_empty() {
                    let tail = String::from_utf8_lossy(&utf8_buffer).to_string();
                    utf8_buffer.clear();
                    send_model_call_stream_chunk(on_event, tail);
                }
                send_model_call_stream_done(on_event);
                return Ok(());
            }
            Ok(Err(_)) => {
                send_model_call_stream_error(
                    on_event,
                    "model-call-response-read-failed: response stream failed",
                    None,
                );
                return Ok(());
            }
            Err(_) => {
                send_model_call_stream_error(
                    on_event,
                    "model-call-stream-timeout: no response chunk received within 120s",
                    None,
                );
                return Ok(());
            }
        }
    }
}

fn drain_complete_utf8_text(buffer: &mut Vec<u8>, chunk: &[u8]) -> Option<String> {
    buffer.extend_from_slice(chunk);
    match std::str::from_utf8(buffer) {
        Ok(_) => {
            let text = String::from_utf8_lossy(buffer).to_string();
            buffer.clear();
            if text.is_empty() {
                None
            } else {
                Some(text)
            }
        }
        Err(err) => {
            let valid_up_to = err.valid_up_to();
            if valid_up_to == 0 {
                if let Some(error_len) = err.error_len() {
                    let drained: Vec<u8> = buffer.drain(..error_len).collect();
                    return Some(String::from_utf8_lossy(&drained).to_string());
                }
                return None;
            }
            let drain_to = match err.error_len() {
                Some(error_len) => valid_up_to + error_len,
                None => valid_up_to,
            };
            let drained: Vec<u8> = buffer.drain(..drain_to).collect();
            Some(String::from_utf8_lossy(&drained).to_string())
        }
    }
}

fn send_model_call_stream_chunk(on_event: &Channel<serde_json::Value>, data: String) {
    let _ = on_event.send(serde_json::json!({
        "type": "chunk",
        "data": data,
    }));
}

fn send_model_call_stream_done(on_event: &Channel<serde_json::Value>) {
    let _ = on_event.send(serde_json::json!({
        "type": "done",
    }));
}

fn send_model_call_stream_error(
    on_event: &Channel<serde_json::Value>,
    message: &str,
    status: Option<u16>,
) {
    let mut event = serde_json::json!({
        "type": "error",
        "message": truncate_profile_pool_text(message),
    });
    if let Some(status) = status {
        event["status"] = serde_json::json!(status);
    }
    let _ = on_event.send(event);
}

/// Checks one plan field against the claimed profile's value. `field_name`
/// must always be a hardcoded literal (never request-derived data) — the
/// error string embeds it directly and anti-leak constraint #3 forbids
/// surfacing request/response payload content in error text.
fn require_plan_field_match(actual: &str, expected: &str, field_name: &str) -> Result<(), String> {
    if actual != expected {
        return Err(format!(
            "model-call-plan-mismatch: {field_name} does not match the claimed profile"
        ));
    }
    Ok(())
}

/// Google's SSE model-call endpoint. Mirrors the "google" branch of
/// `getProviderConfig` in src/lib/llm-providers.ts (`:streamGenerateContent
/// ?alt=sse`), not the plain `:generateContent` endpoint `probe_profile_target`
/// uses for one-shot capability checks.
fn google_stream_generate_content_url(endpoint: Option<&str>, model_id: &str) -> String {
    let base = endpoint_base(endpoint, "https://generativelanguage.googleapis.com/v1beta");
    if base.contains(":streamGenerateContent") {
        return if base.contains("alt=sse") {
            base.to_string()
        } else if base.contains('?') {
            format!("{base}&alt=sse")
        } else {
            format!("{base}?alt=sse")
        };
    }
    format!(
        "{base}/models/{}:streamGenerateContent?alt=sse",
        encode_url_path_segment(model_id)
    )
}

/// Reads a provider's `Retry-After` header as integer seconds only and
/// clamps it to a sane range. HTTP-date, missing, or unparseable headers
/// fall back to the fixed 30s default — never `now` or another
/// request-derived value, so a malicious/broken provider cannot use this to
/// smuggle unbounded delays.
fn model_call_retry_after_ms(headers: &HeaderMap) -> i64 {
    let parsed = headers
        .get(reqwest::header::RETRY_AFTER)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.trim().parse::<i64>().ok())
        .map(|seconds| seconds.saturating_mul(1_000))
        .unwrap_or(DEFAULT_MODEL_CALL_RATE_LIMIT_RETRY_MS);
    parsed.clamp(
        MIN_MODEL_CALL_RATE_LIMIT_RETRY_MS,
        MAX_MODEL_CALL_RATE_LIMIT_RETRY_MS,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    use std::path::{Path, PathBuf};
    use std::sync::Arc;

    use std::fs;

    use wiremock::matchers::{header, method, path, query_param};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn stored_probe_request(profile_id: &str, force: bool) -> RuntimeProfileProbeRequest {
        RuntimeProfileProbeRequest {
            profile_id: Some(profile_id.to_string()),
            draft: None,
            raw_secret: None,
            force: Some(force),
        }
    }

    fn captured_stream_channel() -> (
        Channel<serde_json::Value>,
        Arc<Mutex<Vec<serde_json::Value>>>,
    ) {
        let events = Arc::new(Mutex::new(Vec::new()));
        let captured = Arc::clone(&events);
        let channel = Channel::new(move |body| {
            match body {
                tauri::ipc::InvokeResponseBody::Json(json) => {
                    let event = serde_json::from_str(&json).expect("channel event should be json");
                    captured.lock().expect("lock events").push(event);
                }
                tauri::ipc::InvokeResponseBody::Raw(_) => {
                    panic!("model-call stream should send json channel events");
                }
            }
            Ok(())
        });
        (channel, events)
    }

    fn setup_anthropic_probe_profile(
        label: &str,
        endpoint: &str,
    ) -> (PathBuf, TestSecretStore, Client) {
        let project = temp_project(label);
        fs::create_dir_all(&project).expect("create temp project");
        let created = runtime_profile_create_for_project(
            Some(&project),
            true,
            anthropic_profile_create_request("profile-1", endpoint),
            100,
        )
        .expect("create profile");
        let store = TestSecretStore::default();
        store.insert(created.secret_ref.expect("secret ref"), "stored-secret");
        let client = Client::builder().build().expect("client");
        (project, store, client)
    }

    #[test]
    fn profile_probe_debug_redacts_raw_secret_values() {
        let request = RuntimeProfileProbeRequest {
            profile_id: None,
            draft: None,
            raw_secret: Some("debug-secret".to_string()),
            force: Some(true),
        };
        let target = RuntimeProfileProbeTarget {
            profile_id: None,
            kind: "model-call".to_string(),
            provider_id: "openai".to_string(),
            model_id: "gpt-test".to_string(),
            agent_sdk_model_id: None,
            endpoint: None,
            api_mode: "openai-chat-completions".to_string(),
            auth_style: "bearer".to_string(),
            secret_value: "debug-secret".to_string(),
        };

        assert!(!format!("{request:?}").contains("debug-secret"));
        assert!(!format!("{target:?}").contains("debug-secret"));
    }

    #[test]
    fn profile_models_list_request_uses_camel_case_and_redacts_raw_secret() {
        let request: RuntimeProfileModelsListRequest = serde_json::from_value(serde_json::json!({
            "draft": {
                "endpoint": "https://api.deepseek.com/anthropic",
                "apiMode": "anthropic-messages",
                "authStyle": "bearer"
            },
            "rawSecret": "debug-secret",
            "modelsUrl": "https://api.deepseek.com/models"
        }))
        .expect("deserialize models list request");

        assert_eq!(request.profile_id, None);
        assert_eq!(
            request.draft.as_ref().expect("draft").api_mode,
            "anthropic-messages"
        );
        assert_eq!(
            request.models_url.as_deref(),
            Some("https://api.deepseek.com/models")
        );
        assert!(!format!("{request:?}").contains("debug-secret"));
    }

    #[test]
    fn profile_models_url_candidates_use_explicit_models_url_when_present() {
        let target = RuntimeProfileModelsListTarget {
            endpoint: Some("https://api.deepseek.com/anthropic".to_string()),
            api_mode: "anthropic-messages".to_string(),
            auth_style: "bearer".to_string(),
            secret_value: "sk-test".to_string(),
            models_url: Some("https://api.deepseek.com/models".to_string()),
        };

        assert_eq!(
            profile_models_url_candidates(&target).expect("models urls"),
            vec!["https://api.deepseek.com/models"]
        );
    }

    #[test]
    fn profile_models_url_candidates_try_base_then_stripped_compat_paths() {
        let target = RuntimeProfileModelsListTarget {
            endpoint: Some("https://api.deepseek.com/anthropic".to_string()),
            api_mode: "anthropic-messages".to_string(),
            auth_style: "bearer".to_string(),
            secret_value: "sk-test".to_string(),
            models_url: None,
        };

        assert_eq!(
            profile_models_url_candidates(&target).expect("models urls"),
            vec![
                "https://api.deepseek.com/anthropic/v1/models",
                "https://api.deepseek.com/anthropic/models",
                "https://api.deepseek.com/models",
                "https://api.deepseek.com/v1/models",
            ]
        );
    }

    #[test]
    fn profile_models_url_candidates_strip_kat_proxy_suffix_best_effort() {
        let target = RuntimeProfileModelsListTarget {
            endpoint: Some(
                "https://vanchin.streamlake.ai/api/gateway/v1/endpoints/{ENDPOINT_ID}/claude-code-proxy"
                    .to_string(),
            ),
            api_mode: "anthropic-messages".to_string(),
            auth_style: "bearer".to_string(),
            secret_value: "sk-test".to_string(),
            models_url: None,
        };

        let candidates = profile_models_url_candidates(&target).expect("models urls");
        assert!(candidates.contains(
            &"https://vanchin.streamlake.ai/api/gateway/v1/endpoints/{ENDPOINT_ID}/models"
                .to_string()
        ));
    }

    #[test]
    fn parse_profile_models_body_accepts_common_provider_shapes() {
        assert_eq!(
            parse_profile_models_body(r#"{"data":[{"id":"gpt-a"},{"id":"gpt-b"}]}"#),
            Some(vec!["gpt-a".to_string(), "gpt-b".to_string()])
        );
        assert_eq!(
            parse_profile_models_body(r#"{"models":["m-a",{"name":"m-b"},{"id":"m-c"}]}"#),
            Some(vec![
                "m-a".to_string(),
                "m-b".to_string(),
                "m-c".to_string()
            ])
        );
        assert_eq!(
            parse_profile_models_body(r#"[{"id":"bare-a/"},"bare-a","bare-a/",{}]"#),
            Some(vec!["bare-a/".to_string(), "bare-a".to_string()])
        );
        assert_eq!(parse_profile_models_body(r#"{"data":[]}"#), None);
    }

    #[tokio::test]
    async fn profile_probe_persists_supported_anthropic_capabilities_without_secret_values() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/messages"))
            .and(header("x-api-key", "stored-secret"))
            .respond_with(
                ResponseTemplate::new(200).set_body_string("event: message_start\ndata: {}\n"),
            )
            .mount(&server)
            .await;
        let (project, store, client) =
            setup_anthropic_probe_profile("profile-probe-supported", &server.uri());

        let result = runtime_profile_probe_for_project_with_store(
            Some(&project),
            true,
            stored_probe_request("profile-1", false),
            200,
            &store,
            &client,
        )
        .await
        .expect("probe profile");

        assert_eq!(result.status, "supported");
        assert_eq!(result.capability_version, PROFILE_PROBE_CAPABILITY_VERSION);
        assert_eq!(result.backoff_until_ms, None);
        let serialized = serde_json::to_string(&result).expect("serialize probe result");
        assert!(!serialized.contains("stored-secret"));
        assert!(!serialized.contains("Authorization"));
        let profile = result.profile.expect("updated profile");
        assert_eq!(profile.capability_status, "supported");
        assert_eq!(profile.capability_version, PROFILE_PROBE_CAPABILITY_VERSION);
        assert_eq!(profile.capability_checked_at_ms, Some(200));
        assert_eq!(profile.probe_backoff_until_ms, None);
        assert_eq!(profile.last_capability_error, None);
        assert!(!result.capability_json.contains("stored-secret"));
        let _ = fs::remove_dir_all(project);
    }

    #[tokio::test]
    async fn profile_probe_marks_messages_only_anthropic_as_limited() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/messages"))
            .respond_with(ResponseTemplate::new(200).set_body_string("{}"))
            .mount(&server)
            .await;
        let (project, store, client) =
            setup_anthropic_probe_profile("profile-probe-limited", &server.uri());

        let result = runtime_profile_probe_for_project_with_store(
            Some(&project),
            true,
            stored_probe_request("profile-1", true),
            200,
            &store,
            &client,
        )
        .await
        .expect("probe profile");

        assert_eq!(result.status, "limited");
        assert!(result
            .capability_json
            .contains("\"agentRunSupported\":false"));
        assert_eq!(result.backoff_until_ms, None);
        let _ = fs::remove_dir_all(project);
    }

    #[tokio::test]
    async fn profile_probe_auth_failure_sets_error_and_retry_backoff() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/messages"))
            .respond_with(ResponseTemplate::new(401))
            .mount(&server)
            .await;
        let (project, store, client) =
            setup_anthropic_probe_profile("profile-probe-auth-failure", &server.uri());

        let result = runtime_profile_probe_for_project_with_store(
            Some(&project),
            true,
            stored_probe_request("profile-1", false),
            200,
            &store,
            &client,
        )
        .await
        .expect("probe profile");

        assert_eq!(result.status, "error");
        assert_eq!(
            result.backoff_until_ms,
            Some(200 + PROFILE_PROBE_BACKOFF_MS)
        );
        let profile = result.profile.expect("updated profile");
        assert_eq!(profile.capability_status, "error");
        assert_eq!(
            profile.probe_backoff_until_ms,
            Some(200 + PROFILE_PROBE_BACKOFF_MS)
        );
        assert!(profile
            .last_capability_error
            .as_deref()
            .unwrap_or_default()
            .contains("401"));
        assert!(!profile
            .last_capability_error
            .as_deref()
            .unwrap_or_default()
            .contains("stored-secret"));
        let cached = runtime_profile_probe_for_project_with_store(
            Some(&project),
            true,
            stored_probe_request("profile-1", false),
            201,
            &store,
            &client,
        )
        .await
        .expect("cached backoff result");
        assert_eq!(cached.checked_at_ms, 200);
        assert_eq!(cached.status, "error");
        let serialized = serde_json::to_string(&cached).expect("serialize cached result");
        assert!(!serialized.contains("stored-secret"));
        assert!(!serialized.contains("Authorization"));
        let _ = fs::remove_dir_all(project);
    }

    #[tokio::test]
    async fn profile_probe_draft_openai_and_google_paths_do_not_persist_or_expose_secret() {
        let openai = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/chat/completions"))
            .and(header("authorization", "Bearer draft-secret"))
            .respond_with(ResponseTemplate::new(200).set_body_string("{}"))
            .mount(&openai)
            .await;
        let google = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/models/gemini%2Ftest:generateContent"))
            .and(header("x-goog-api-key", "draft-secret"))
            .respond_with(ResponseTemplate::new(200).set_body_string("{}"))
            .mount(&google)
            .await;
        let client = Client::builder().build().expect("client");

        let openai_result = runtime_profile_probe_for_project_with_store(
            Some(Path::new("/tmp")),
            true,
            RuntimeProfileProbeRequest {
                profile_id: None,
                draft: Some(RuntimeProfileProbeDraftRequest {
                    kind: "model-call".to_string(),
                    provider_id: "openai".to_string(),
                    model_id: "gpt-test".to_string(),
                    agent_sdk_model_id: None,
                    endpoint: Some(openai.uri()),
                    api_mode: "openai-chat-completions".to_string(),
                    auth_style: "bearer".to_string(),
                }),
                raw_secret: Some("draft-secret".to_string()),
                force: Some(true),
            },
            200,
            &TestSecretStore::default(),
            &client,
        )
        .await
        .expect("probe openai draft");
        assert_eq!(openai_result.status, "supported");
        assert!(openai_result.profile.is_none());
        assert!(!serde_json::to_string(&openai_result)
            .expect("serialize openai result")
            .contains("draft-secret"));

        let google_result = runtime_profile_probe_for_project_with_store(
            Some(Path::new("/tmp")),
            true,
            RuntimeProfileProbeRequest {
                profile_id: None,
                draft: Some(RuntimeProfileProbeDraftRequest {
                    kind: "model-call".to_string(),
                    provider_id: "google".to_string(),
                    model_id: "gemini/test".to_string(),
                    agent_sdk_model_id: None,
                    endpoint: Some(google.uri()),
                    api_mode: "google-generate-content".to_string(),
                    auth_style: "api-key".to_string(),
                }),
                raw_secret: Some("draft-secret".to_string()),
                force: Some(true),
            },
            200,
            &TestSecretStore::default(),
            &client,
        )
        .await
        .expect("probe google draft");
        assert_eq!(google_result.status, "supported");
        assert!(google_result.profile.is_none());
        assert!(!serde_json::to_string(&google_result)
            .expect("serialize google result")
            .contains("draft-secret"));
    }

    #[tokio::test]
    async fn profile_probe_saved_and_draft_no_auth_do_not_require_secret_refs() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/chat/completions"))
            .respond_with(ResponseTemplate::new(200).set_body_string("{}"))
            .mount(&server)
            .await;
        let project = temp_project("profile-probe-no-auth");
        fs::create_dir_all(&project).expect("create temp project");
        let mut create = profile_create_request("profile-1");
        create.endpoint = Some(server.uri());
        create.auth_style = "none".to_string();
        create.secret_ref = None;
        runtime_profile_create_for_project(Some(&project), true, create, 100)
            .expect("create no-auth profile");
        let client = Client::builder().build().expect("client");

        let stored = runtime_profile_probe_for_project_with_store(
            Some(&project),
            true,
            stored_probe_request("profile-1", false),
            200,
            &TestSecretStore::default(),
            &client,
        )
        .await
        .expect("probe saved no-auth profile");
        assert_eq!(stored.status, "supported");

        let draft = runtime_profile_probe_for_project_with_store(
            Some(Path::new("/tmp")),
            true,
            RuntimeProfileProbeRequest {
                profile_id: None,
                draft: Some(RuntimeProfileProbeDraftRequest {
                    kind: "model-call".to_string(),
                    provider_id: "openai".to_string(),
                    model_id: "gpt-test".to_string(),
                    agent_sdk_model_id: None,
                    endpoint: Some(server.uri()),
                    api_mode: "openai-chat-completions".to_string(),
                    auth_style: "none".to_string(),
                }),
                raw_secret: None,
                force: Some(true),
            },
            200,
            &TestSecretStore::default(),
            &client,
        )
        .await
        .expect("probe draft no-auth profile");
        assert_eq!(draft.status, "supported");
        let _ = fs::remove_dir_all(project);
    }

    #[tokio::test]
    async fn profile_probe_local_cli_returns_unsupported_without_backoff() {
        let project = temp_project("profile-probe-local-cli");
        fs::create_dir_all(&project).expect("create temp project");
        let mut create = profile_create_request("profile-1");
        create.provider_id = "claude-code".to_string();
        create.model_id = "claude-code".to_string();
        create.api_mode = "local-cli".to_string();
        create.auth_style = "oauth-local-cli".to_string();
        create.secret_ref = None;
        let created = runtime_profile_create_for_project(Some(&project), true, create, 100)
            .expect("create profile");
        assert!(created.secret_ref.is_none());
        let client = Client::builder().build().expect("client");

        let result = runtime_profile_probe_for_project_with_store(
            Some(&project),
            true,
            stored_probe_request("profile-1", false),
            200,
            &TestSecretStore::default(),
            &client,
        )
        .await
        .expect("probe local cli");

        assert_eq!(result.status, "unsupported");
        assert_eq!(result.backoff_until_ms, None);
        let profile = result.profile.expect("updated profile");
        assert_eq!(profile.capability_status, "unsupported");
        assert_eq!(profile.probe_backoff_until_ms, None);
        assert!(!serde_json::to_string(&profile)
            .expect("serialize local profile")
            .contains("stored-secret"));
        let _ = fs::remove_dir_all(project);
    }

    #[tokio::test]
    async fn profile_probe_ignores_old_version_backoff_once() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/messages"))
            .respond_with(
                ResponseTemplate::new(200).set_body_string("event: message_start\ndata: {}\n"),
            )
            .mount(&server)
            .await;
        let (project, store, client) =
            setup_anthropic_probe_profile("profile-probe-old-version", &server.uri());
        let mut stale = profile_update_request("profile-1");
        stale.probe_backoff_until_ms = Some(999_999);
        stale.last_capability_error = Some("old backoff".to_string());
        runtime_profile_update_for_project(Some(&project), true, stale, 150)
            .expect("seed stale backoff");
        let result = runtime_profile_probe_for_project_with_store(
            Some(&project),
            true,
            stored_probe_request("profile-1", false),
            200,
            &store,
            &client,
        )
        .await
        .expect("probe ignores old version backoff");

        assert_eq!(result.status, "supported");
        let profile = result.profile.expect("updated profile");
        assert_eq!(profile.capability_version, PROFILE_PROBE_CAPABILITY_VERSION);
        assert_eq!(profile.probe_backoff_until_ms, None);
        assert_eq!(profile.last_capability_error, None);
        let _ = fs::remove_dir_all(project);
    }

    fn model_call_forward_profile_create_request(
        profile_id: &str,
        provider_id: &str,
        model_id: &str,
        endpoint: &str,
        api_mode: &str,
        auth_style: &str,
    ) -> RuntimeProfileCreateRequest {
        RuntimeProfileCreateRequest {
            provider_id: provider_id.to_string(),
            model_id: model_id.to_string(),
            endpoint: if endpoint.is_empty() {
                None
            } else {
                Some(endpoint.to_string())
            },
            api_mode: api_mode.to_string(),
            auth_style: auth_style.to_string(),
            task_families: vec![PREPARE_PROFILE_TASK_FAMILY.to_string()],
            ..profile_create_request(profile_id)
        }
    }

    fn setup_model_call_forward_profile(
        label: &str,
        provider_id: &str,
        model_id: &str,
        endpoint: &str,
        api_mode: &str,
        auth_style: &str,
    ) -> (PathBuf, TestSecretStore, Client, String, String) {
        let project = temp_project(label);
        fs::create_dir_all(&project).expect("create temp project");
        let created = runtime_profile_create_for_project(
            Some(&project),
            true,
            model_call_forward_profile_create_request(
                "profile-1",
                provider_id,
                model_id,
                endpoint,
                api_mode,
                auth_style,
            ),
            100,
        )
        .expect("create model-call profile");

        let mut update = profile_update_request("profile-1");
        update.capability_status = Some("supported".to_string());
        update.capability_json = Some(profile_pool_capability_json(
            serde_json::json!(true),
            serde_json::json!(false),
        ));
        update.capability_version = Some(PROFILE_PROBE_CAPABILITY_VERSION.to_string());
        update.capability_checked_at_ms = Some(150);
        runtime_profile_update_for_project(Some(&project), true, update, 150)
            .expect("mark model-call profile capable");

        let store = TestSecretStore::default();
        if let Some(secret_ref) = created.secret_ref.clone() {
            // Deliberately fake-looking so it can never be a real credential.
            store.insert(secret_ref, "sk-test000-stored-secret");
        }

        let claim = runtime_profile_pool_claim_for_project(
            Some(&project),
            true,
            RuntimeProfilePoolClaimRequest {
                claim_id: Some("claim-1".to_string()),
                kind: "model-call".to_string(),
                task_family: PREPARE_PROFILE_TASK_FAMILY.to_string(),
                holder: "bulk-prepare:1".to_string(),
                job_id: None,
                ttl_ms: Some(10_000),
                preferred_profile_ids: None,
            },
            200,
        )
        .expect("claim ingest model-call profile");

        // Use the same client construction the real `#[tauri::command]` uses
        // (no-redirect policy included) so tests exercise production
        // behavior, not a more permissive default reqwest client.
        let client = model_call_forward_client().expect("build model call forward client");
        (project, store, client, claim.claim_id, claim.profile_id)
    }

    fn setup_model_call_forward_profile_for_family(
        label: &str,
        task_family: &str,
        endpoint: &str,
    ) -> (PathBuf, TestSecretStore, String) {
        let project = temp_project(label);
        fs::create_dir_all(&project).expect("create temp project");
        let mut create = model_call_forward_profile_create_request(
            "profile-1",
            "anthropic",
            "claude-test",
            endpoint,
            "anthropic-messages",
            "x-api-key",
        );
        create.task_families = vec![task_family.to_string()];
        let created = runtime_profile_create_for_project(Some(&project), true, create, 100)
            .expect("create model-call profile");

        let mut update = profile_update_request("profile-1");
        update.capability_status = Some("supported".to_string());
        update.capability_json = Some(profile_pool_capability_json(
            serde_json::json!(true),
            serde_json::json!(false),
        ));
        update.capability_version = Some(PROFILE_PROBE_CAPABILITY_VERSION.to_string());
        update.capability_checked_at_ms = Some(150);
        runtime_profile_update_for_project(Some(&project), true, update, 150)
            .expect("mark model-call profile capable");

        let store = TestSecretStore::default();
        if let Some(secret_ref) = created.secret_ref.clone() {
            store.insert(secret_ref, "sk-test000-stored-secret");
        }

        let claim = runtime_profile_pool_claim_for_project(
            Some(&project),
            true,
            RuntimeProfilePoolClaimRequest {
                claim_id: Some("claim-1".to_string()),
                kind: "model-call".to_string(),
                task_family: task_family.to_string(),
                holder: format!("{task_family}:1"),
                job_id: None,
                ttl_ms: Some(10_000),
                preferred_profile_ids: None,
            },
            200,
        )
        .expect("claim model-call profile");

        (project, store, claim.claim_id)
    }

    fn model_call_forward_request(
        claim_id: &str,
        provider: &str,
        api_mode: &str,
        model: &str,
        body: serde_json::Value,
    ) -> RuntimeModelCallForwardRequest {
        RuntimeModelCallForwardRequest {
            claim_id: claim_id.to_string(),
            provider: provider.to_string(),
            api_mode: api_mode.to_string(),
            model: model.to_string(),
            body,
        }
    }

    #[test]
    fn model_call_task_family_supported_matches_frontend_routed_families() {
        for task_family in ["ingest", "chat", "synthesis", "review", "vision"] {
            assert!(
                model_call_task_family_supported(task_family),
                "{task_family} should be accepted for model-call claims",
            );
        }

        assert!(!model_call_task_family_supported("unknown"));
    }

    #[test]
    fn model_call_forward_target_accepts_chat_claim_and_reuses_secretless_resolution() {
        let (project, store, claim_id) = setup_model_call_forward_profile_for_family(
            "forward-target-chat",
            "chat",
            "https://example.invalid",
        );

        let target = resolve_model_call_forward_target(
            Some(&project),
            true,
            model_call_forward_request(
                &claim_id,
                "anthropic",
                "anthropic-messages",
                "claude-test",
                serde_json::json!({ "messages": [] }),
            ),
            250,
            &store,
        )
        .expect("resolve chat model-call target");

        assert_eq!(target.url, "https://example.invalid/v1/messages");
        assert_eq!(
            target
                .headers
                .get("x-api-key")
                .and_then(|value| value.to_str().ok()),
            Some("sk-test000-stored-secret")
        );
        assert_eq!(target.body, serde_json::json!({ "messages": [] }));
        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn model_call_stream_utf8_buffer_preserves_cross_chunk_boundaries() {
        let mut buffer = Vec::new();
        let bytes = "A🙂B".as_bytes();
        assert_eq!(
            drain_complete_utf8_text(&mut buffer, &bytes[..2]),
            Some("A".to_string())
        );
        assert_eq!(
            drain_complete_utf8_text(&mut buffer, &bytes[2..5]),
            Some("🙂".to_string())
        );
        assert_eq!(
            drain_complete_utf8_text(&mut buffer, &bytes[5..]),
            Some("B".to_string())
        );
        assert!(buffer.is_empty());
    }

    #[test]
    fn model_call_stream_cancel_removes_registered_abort_handle() {
        let state = RuntimeModelCallStreamState::default();
        let (abort, _registration) = AbortHandle::new_pair();
        state
            .register("stream-1".to_string(), abort)
            .expect("register abort");

        state.cancel("stream-1").expect("cancel stream");

        assert_eq!(state.registered_count(), 0);
    }

    #[tokio::test]
    async fn model_call_stream_sends_chunk_events_and_done() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/messages"))
            .and(header("x-api-key", "sk-test000-stored-secret"))
            .respond_with(
                ResponseTemplate::new(200)
                    .insert_header("Transfer-Encoding", "chunked")
                    .set_body_string(
                        "event: content_block_delta\ndata: {\"delta\":{\"text\":\"hel\"}}\n\n\
                         event: content_block_delta\ndata: {\"delta\":{\"text\":\"lo\"}}\n\n",
                    ),
            )
            .expect(1)
            .mount(&server)
            .await;
        let (project, store, _forward_client, claim_id, _profile_id) =
            setup_model_call_forward_profile(
                "stream-success",
                "anthropic",
                "claude-test",
                &server.uri(),
                "anthropic-messages",
                "x-api-key",
            );
        let client = model_call_stream_client().expect("build stream client");
        let (channel, events) = captured_stream_channel();

        runtime_model_call_stream_for_project_with_store(
            Some(&project),
            true,
            model_call_forward_request(
                &claim_id,
                "anthropic",
                "anthropic-messages",
                "claude-test",
                serde_json::json!({ "messages": [], "stream": true }),
            ),
            250,
            &store,
            &client,
            &channel,
        )
        .await
        .expect("stream model call");

        let events = events.lock().expect("lock events");
        assert!(events.iter().any(|event| event["type"] == "chunk"));
        assert_eq!(
            events.last().and_then(|event| event["type"].as_str()),
            Some("done")
        );
        let chunk_text = events
            .iter()
            .filter(|event| event["type"] == "chunk")
            .filter_map(|event| event["data"].as_str())
            .collect::<String>();
        assert!(chunk_text.contains("content_block_delta"));
        assert!(chunk_text.contains("hel"));
        assert!(chunk_text.contains("lo"));
        let _ = fs::remove_dir_all(project);
    }

    #[tokio::test]
    async fn model_call_stream_errors_include_status_without_provider_body_or_headers() {
        for (status, label) in [(429, "stream-rate-limit"), (500, "stream-http-error")] {
            let server = MockServer::start().await;
            let mut response = ResponseTemplate::new(status).set_body_string(
                "Authorization: Bearer sk-test000-stored-secret\nprivate-upstream-body",
            );
            if status == 429 {
                response = response.insert_header("Retry-After", "12");
            }
            Mock::given(method("POST"))
                .and(path("/v1/messages"))
                .respond_with(response)
                .expect(1)
                .mount(&server)
                .await;
            let (project, store, _forward_client, claim_id, _profile_id) =
                setup_model_call_forward_profile(
                    label,
                    "anthropic",
                    "claude-test",
                    &server.uri(),
                    "anthropic-messages",
                    "x-api-key",
                );
            let client = model_call_stream_client().expect("build stream client");
            let (channel, events) = captured_stream_channel();

            runtime_model_call_stream_for_project_with_store(
                Some(&project),
                true,
                model_call_forward_request(
                    &claim_id,
                    "anthropic",
                    "anthropic-messages",
                    "claude-test",
                    serde_json::json!({ "messages": [], "stream": true }),
                ),
                250,
                &store,
                &client,
                &channel,
            )
            .await
            .expect("stream model call returns structured error");

            let events = events.lock().expect("lock events");
            assert_eq!(events.len(), 1);
            assert_eq!(events[0]["type"], "error");
            assert_eq!(events[0]["status"], serde_json::json!(status));
            let event_text = serde_json::to_string(&events[0]).expect("serialize event");
            assert!(!event_text.contains("sk-test000-stored-secret"));
            assert!(!event_text.contains("Authorization"));
            assert!(!event_text.contains("private-upstream-body"));
            let _ = fs::remove_dir_all(project);
        }
    }

    #[tokio::test]
    async fn model_call_stream_abort_sends_done_and_cleans_registry() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/messages"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_delay(Duration::from_secs(5))
                    .set_body_string("data: {\"late\":true}\n"),
            )
            .expect(1)
            .mount(&server)
            .await;
        let (project, store, _forward_client, claim_id, _profile_id) =
            setup_model_call_forward_profile(
                "stream-abort",
                "anthropic",
                "claude-test",
                &server.uri(),
                "anthropic-messages",
                "x-api-key",
            );
        let client = model_call_stream_client().expect("build stream client");
        let (channel, events) = captured_stream_channel();
        let state = RuntimeModelCallStreamState::default();
        let (abort, registration) = AbortHandle::new_pair();
        state
            .register("stream-abort".to_string(), abort)
            .expect("register stream");

        let stream = runtime_model_call_stream_for_project_with_store(
            Some(&project),
            true,
            model_call_forward_request(
                &claim_id,
                "anthropic",
                "anthropic-messages",
                "claude-test",
                serde_json::json!({ "messages": [], "stream": true }),
            ),
            250,
            &store,
            &client,
            &channel,
        );
        let mut abortable = Box::pin(Abortable::new(stream, registration));
        tokio::select! {
            _ = tokio::time::sleep(Duration::from_millis(50)) => {
                state.cancel("stream-abort").expect("cancel stream");
            }
            result = &mut abortable => {
                panic!("stream finished before cancel: {result:?}");
            }
        }
        let result = abortable.await;
        state.remove("stream-abort").expect("cleanup stream");
        if result.is_err() {
            send_model_call_stream_done(&channel);
        }

        assert_eq!(state.registered_count(), 0);
        let events = events.lock().expect("lock events");
        assert_eq!(
            events.last().and_then(|event| event["type"].as_str()),
            Some("done")
        );
        let _ = fs::remove_dir_all(project);
    }

    #[tokio::test]
    async fn model_call_forward_returns_raw_body_and_injects_secret_from_profile() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/messages"))
            .and(header("x-api-key", "sk-test000-stored-secret"))
            .respond_with(ResponseTemplate::new(200).set_body_string(
                "event: content_block_delta\ndata: {\"type\":\"content_block_delta\"}\n",
            ))
            .expect(1)
            .mount(&server)
            .await;
        let (project, store, client, claim_id, _profile_id) = setup_model_call_forward_profile(
            "forward-success",
            "anthropic",
            "claude-test",
            &server.uri(),
            "anthropic-messages",
            "x-api-key",
        );

        let body = serde_json::json!({
            "model": "claude-test",
            "max_tokens": 64,
            "stream": true,
            "messages": [{ "role": "user", "content": "hello" }]
        });
        let result = runtime_model_call_forward_for_project_with_store(
            Some(&project),
            true,
            model_call_forward_request(
                &claim_id,
                "anthropic",
                "anthropic-messages",
                "claude-test",
                body,
            ),
            250,
            &store,
            &client,
        )
        .await
        .expect("forward model call");

        assert_eq!(
            result,
            "event: content_block_delta\ndata: {\"type\":\"content_block_delta\"}\n"
        );
        let _ = fs::remove_dir_all(project);
    }

    #[tokio::test]
    async fn model_call_forward_rejects_inactive_or_unknown_claim() {
        let (project, store, client, _claim_id, _profile_id) = setup_model_call_forward_profile(
            "forward-inactive-claim",
            "anthropic",
            "claude-test",
            "http://127.0.0.1:1",
            "anthropic-messages",
            "x-api-key",
        );

        let error = runtime_model_call_forward_for_project_with_store(
            Some(&project),
            true,
            model_call_forward_request(
                "claim-does-not-exist",
                "anthropic",
                "anthropic-messages",
                "claude-test",
                serde_json::json!({}),
            ),
            250,
            &store,
            &client,
        )
        .await
        .expect_err("unknown claim must be rejected");

        assert!(error.starts_with("claim-inactive"));
        let _ = fs::remove_dir_all(project);
    }

    #[tokio::test]
    async fn model_call_forward_rejects_claim_with_wrong_kind_or_task_family() {
        let project = temp_project("forward-claim-wrong-kind");
        fs::create_dir_all(&project).expect("create temp project");
        let agent_profile = create_agent_profile_pool_profile(&project, "agent-profile-1");
        let agent_claim = runtime_profile_pool_claim_for_project(
            Some(&project),
            true,
            agent_profile_pool_claim_request("claim-agent-1", vec!["agent-profile-1"]),
            200,
        )
        .expect("claim agent-run profile");
        let store = TestSecretStore::default();
        if let Some(secret_ref) = agent_profile.secret_ref.clone() {
            store.insert(secret_ref, "sk-test000-stored-secret");
        }
        let client = Client::builder().build().expect("client");

        let error = runtime_model_call_forward_for_project_with_store(
            Some(&project),
            true,
            model_call_forward_request(
                &agent_claim.claim_id,
                "anthropic",
                "anthropic-messages",
                "claude-test",
                serde_json::json!({}),
            ),
            250,
            &store,
            &client,
        )
        .await
        .expect_err("agent-run claim must not authorize a model-call forward");

        assert!(error.starts_with("model-call-claim-unsupported"));
        let _ = fs::remove_dir_all(project);
    }

    #[tokio::test]
    async fn model_call_forward_rejects_plan_field_mismatch_against_stored_profile() {
        let (project, store, client, claim_id, _profile_id) = setup_model_call_forward_profile(
            "forward-plan-mismatch",
            "anthropic",
            "claude-test",
            "http://127.0.0.1:1",
            "anthropic-messages",
            "x-api-key",
        );

        let wrong_model = runtime_model_call_forward_for_project_with_store(
            Some(&project),
            true,
            model_call_forward_request(
                &claim_id,
                "anthropic",
                "anthropic-messages",
                "not-the-claimed-model",
                serde_json::json!({}),
            ),
            250,
            &store,
            &client,
        )
        .await
        .expect_err("model mismatch must be rejected");
        assert!(wrong_model.starts_with("model-call-plan-mismatch"));

        let wrong_provider = runtime_model_call_forward_for_project_with_store(
            Some(&project),
            true,
            model_call_forward_request(
                &claim_id,
                "openai",
                "anthropic-messages",
                "claude-test",
                serde_json::json!({}),
            ),
            250,
            &store,
            &client,
        )
        .await
        .expect_err("provider mismatch must be rejected");
        assert!(wrong_provider.starts_with("model-call-plan-mismatch"));

        let _ = fs::remove_dir_all(project);
    }

    #[tokio::test]
    async fn model_call_forward_never_leaks_non_2xx_provider_body_headers_or_secret() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/messages"))
            .respond_with(ResponseTemplate::new(500).set_body_string(
                "Authorization: Bearer sk-test000-stored-secret\nleaked-upstream-diagnostic-details",
            ))
            .expect(1)
            .mount(&server)
            .await;
        let (project, store, client, claim_id, _profile_id) = setup_model_call_forward_profile(
            "forward-error-body-leak",
            "anthropic",
            "claude-test",
            &server.uri(),
            "anthropic-messages",
            "x-api-key",
        );

        let error = runtime_model_call_forward_for_project_with_store(
            Some(&project),
            true,
            model_call_forward_request(
                &claim_id,
                "anthropic",
                "anthropic-messages",
                "claude-test",
                serde_json::json!({ "messages": [] }),
            ),
            250,
            &store,
            &client,
        )
        .await
        .expect_err("non-2xx provider response must surface as an error");

        assert_eq!(
            error,
            "model-call-http-failed: provider returned 500 Internal Server Error"
        );
        assert!(!error.contains("sk-test000-stored-secret"));
        assert!(!error.contains("Authorization"));
        assert!(!error.contains("leaked-upstream-diagnostic-details"));
        let _ = fs::remove_dir_all(project);
    }

    #[tokio::test]
    async fn model_call_forward_reports_rate_limit_with_retry_after_and_no_body_leak() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/messages"))
            .respond_with(
                ResponseTemplate::new(429)
                    .insert_header("Retry-After", "12")
                    .set_body_string("private-rate-limit-diagnostic sk-test000-stored-secret"),
            )
            .expect(1)
            .mount(&server)
            .await;
        let (project, store, client, claim_id, _profile_id) = setup_model_call_forward_profile(
            "forward-rate-limited",
            "anthropic",
            "claude-test",
            &server.uri(),
            "anthropic-messages",
            "x-api-key",
        );

        let error = runtime_model_call_forward_for_project_with_store(
            Some(&project),
            true,
            model_call_forward_request(
                &claim_id,
                "anthropic",
                "anthropic-messages",
                "claude-test",
                serde_json::json!({ "messages": [] }),
            ),
            250,
            &store,
            &client,
        )
        .await
        .expect_err("429 must surface as a rate-limited error");

        assert!(error.starts_with("model-call-rate-limited: retryAfterMs=12000"));
        assert!(!error.contains("sk-test000-stored-secret"));
        assert!(!error.contains("private-rate-limit-diagnostic"));
        let _ = fs::remove_dir_all(project);
    }

    #[tokio::test]
    async fn model_call_forward_never_follows_redirects_with_auth_header() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/messages"))
            .respond_with(
                ResponseTemplate::new(302).insert_header("Location", "/redirected-with-secret"),
            )
            .expect(1)
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/redirected-with-secret"))
            .respond_with(ResponseTemplate::new(200).set_body_string("should-never-be-fetched"))
            .expect(0)
            .mount(&server)
            .await;
        let (project, store, client, claim_id, _profile_id) = setup_model_call_forward_profile(
            "forward-no-redirect",
            "anthropic",
            "claude-test",
            &server.uri(),
            "anthropic-messages",
            "x-api-key",
        );

        let error = runtime_model_call_forward_for_project_with_store(
            Some(&project),
            true,
            model_call_forward_request(
                &claim_id,
                "anthropic",
                "anthropic-messages",
                "claude-test",
                serde_json::json!({ "messages": [] }),
            ),
            250,
            &store,
            &client,
        )
        .await
        .expect_err("a 3xx response must not be followed");

        assert!(error.starts_with("model-call-http-failed: provider returned 302"));
        let _ = fs::remove_dir_all(project);
        // wiremock's `.expect(0)` above already asserts on drop that the
        // redirect target was never hit; verified again here for clarity.
    }

    #[tokio::test]
    async fn model_call_forward_builds_google_sse_url_and_openai_chat_url() {
        let google_server = MockServer::start().await;
        Mock::given(method("POST"))
            // `endpoint_base` uses a caller-provided endpoint verbatim (no
            // implicit "/v1beta" prefix — that default only applies when the
            // profile has no endpoint override), so the test profile's
            // endpoint (the mock server's bare origin) plus the SSE path
            // segment is the full expected path.
            .and(path("/models/gemini-test:streamGenerateContent"))
            .and(query_param("alt", "sse"))
            .respond_with(ResponseTemplate::new(200).set_body_string("data: {}\n"))
            .expect(1)
            .mount(&google_server)
            .await;
        let (google_project, google_store, google_client, google_claim_id, _) =
            setup_model_call_forward_profile(
                "forward-google-url",
                "google",
                "gemini-test",
                &google_server.uri(),
                "google-generate-content",
                "api-key",
            );
        runtime_model_call_forward_for_project_with_store(
            Some(&google_project),
            true,
            model_call_forward_request(
                &google_claim_id,
                "google",
                "google-generate-content",
                "gemini-test",
                serde_json::json!({ "contents": [] }),
            ),
            250,
            &google_store,
            &google_client,
        )
        .await
        .expect("forward google model call");
        let _ = fs::remove_dir_all(google_project);

        let openai_server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/chat/completions"))
            .respond_with(ResponseTemplate::new(200).set_body_string("data: {}\n"))
            .expect(1)
            .mount(&openai_server)
            .await;
        let (openai_project, openai_store, openai_client, openai_claim_id, _) =
            setup_model_call_forward_profile(
                "forward-openai-url",
                "openai",
                "gpt-test",
                &openai_server.uri(),
                "openai-chat-completions",
                "bearer",
            );
        runtime_model_call_forward_for_project_with_store(
            Some(&openai_project),
            true,
            model_call_forward_request(
                &openai_claim_id,
                "openai",
                "openai-chat-completions",
                "gpt-test",
                serde_json::json!({ "messages": [] }),
            ),
            250,
            &openai_store,
            &openai_client,
        )
        .await
        .expect("forward openai model call");
        let _ = fs::remove_dir_all(openai_project);
    }

    #[tokio::test]
    async fn model_call_forward_rejects_local_cli_api_mode_without_network_call() {
        let (project, store, client, claim_id, _profile_id) = setup_model_call_forward_profile(
            "forward-local-cli-unsupported",
            "claude-code",
            "claude-cli",
            "",
            "local-cli",
            "oauth-local-cli",
        );

        let error = runtime_model_call_forward_for_project_with_store(
            Some(&project),
            true,
            model_call_forward_request(
                &claim_id,
                "claude-code",
                "local-cli",
                "claude-cli",
                serde_json::json!({}),
            ),
            250,
            &store,
            &client,
        )
        .await
        .expect_err("local-cli api mode has no HTTP transport");

        assert!(error.starts_with("model-call-api-mode-unsupported"));
        let _ = fs::remove_dir_all(project);
    }
}
