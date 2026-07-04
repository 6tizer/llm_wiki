use crate::commands::file_sync::ProjectRootState;
use crate::panic_guard::run_guarded;
use rusqlite::params;
use std::path::Path;
use tauri::State;

use super::*;
use crate::commands::profile_secrets::{read_profile_secret, OsSecretStore, SecretStore};
use reqwest::header::{HeaderMap, HeaderValue, AUTHORIZATION, CONTENT_TYPE};
use reqwest::Client;
use serde::Deserialize;
use std::time::Duration;

/// Probe stored or draft model profile capabilities without returning secrets.
#[tauri::command]
pub async fn runtime_profile_probe(
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
    runtime_profile_probe_for_project_with_store(
        project_root.as_deref(),
        runtime_enabled,
        request,
        now,
        &OsSecretStore,
        &client,
    )
    .await
}

/// Secretless model-call plan forwarded from JS. `provider`/`apiMode`/
/// `model` are cross-checked against the claimed profile for a clearer
/// error message but are NEVER used to pick the request destination —
/// `runtime_model_call_forward_for_project_with_store` re-derives the URL
/// and auth header entirely from the server-stored profile so a buggy or
/// compromised caller cannot redirect the request or exfiltrate the
/// secret. `body` is the already-built provider request body (see
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

/// Forward one bulk-knowledge-prepare model-call through the profile pool.
///
/// Returns only the raw provider response body on success (2xx). On
/// failure this NEVER returns provider response bodies, request headers,
/// the destination URL, or raw reqwest error Debug output — see the
/// anti-leak notes on `runtime_model_call_forward_for_project_with_store`.
#[tauri::command]
pub async fn runtime_model_call_forward(
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
    runtime_model_call_forward_for_project_with_store(
        project_root.as_deref(),
        runtime_enabled,
        request,
        now,
        &OsSecretStore,
        &client,
    )
    .await
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

async fn runtime_profile_probe_for_project_with_store(
    project_root: Option<&Path>,
    enabled: bool,
    request: RuntimeProfileProbeRequest,
    now: i64,
    store: &impl SecretStore,
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
    store: &impl SecretStore,
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
            let secret_value = match profile_secret_required(&profile.auth_style) {
                true => {
                    let secret_ref = profile.secret_ref.as_deref().ok_or_else(|| {
                        "profile-probe-missing-secret: stored profile has no secretRef".to_string()
                    })?;
                    read_profile_secret(store, secret_ref)?
                }
                false => String::new(),
            };
            Ok((
                None,
                Some(RuntimeProfileProbeTarget {
                    profile_id: Some(profile.profile_id),
                    kind: profile.kind,
                    provider_id: profile.provider_id,
                    model_id: profile.model_id,
                    agent_sdk_model_id: profile.agent_sdk_model_id,
                    endpoint: profile.endpoint,
                    api_mode: profile.api_mode,
                    auth_style: profile.auth_style,
                    secret_value,
                }),
            ))
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

/// Core B+hybrid model-call forwarder. Re-reads the claimed profile
/// server-side (never trusting `request.provider`/`apiMode`/`model` as a
/// destination — those are only cross-checked for a clearer error),
/// builds the destination URL and auth header from the STORED profile,
/// injects the secret, and returns the raw provider response body.
///
/// Anti-leak constraints (verified in tests):
/// 1. No error path here ever interpolates request headers, a full
///    destination URL, raw reqwest Debug output, or a substring that could
///    contain `Authorization`/`x-api-key`/`api-key` — every error is a
///    fixed, static message or a fixed prefix + safe fields (status code,
///    clamped retry-after ms).
/// 2. Redirects are disabled entirely (`model_call_forward_client`), so no
///    redirect can ever carry the injected auth header anywhere.
/// 3. Non-2xx provider response bodies are never read into the returned
///    error — only the HTTP status is surfaced.
/// 4. The sanitized errors returned here are already safe before they ever
///    reach `runtime_profile_pool_release`'s breaker-error redactor; this
///    function does not rely on that redactor as a backstop.
/// 5. On success, only the raw provider response body is returned — no
///    envelope, no headers.
async fn runtime_model_call_forward_for_project_with_store(
    project_root: Option<&Path>,
    enabled: bool,
    request: RuntimeModelCallForwardRequest,
    now: i64,
    store: &impl SecretStore,
    client: &Client,
) -> Result<String, String> {
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
        if claim.kind != "model-call" || claim.task_family != PREPARE_PROFILE_TASK_FAMILY {
            return Err(
                "model-call-claim-unsupported: claim is not an ingest model-call claim".to_string(),
            );
        }
        let profile = read_visible_profile_tx(&tx, &claim.profile_id)?;
        if !profile_pool_profile_base_eligible(
            &tx,
            &profile,
            "model-call",
            PREPARE_PROFILE_TASK_FAMILY,
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

    // Anti-leak constraint #1: on network failure, do not interpolate the
    // underlying reqwest::Error (its Display can include the destination
    // URL). Mirrors `post_probe_json`'s existing pattern.
    let response = client
        .post(&url)
        .headers(headers)
        .json(&request.body)
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

/// Reads a provider's `Retry-After` header (seconds) and clamps it to a
/// sane range. Missing/unparseable headers fall back to a fixed default —
/// never `now` or another request-derived value, so a malicious/broken
/// provider cannot use this to smuggle unbounded delays.
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
