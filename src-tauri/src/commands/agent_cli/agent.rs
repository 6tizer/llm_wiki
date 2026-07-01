//! Agent sidecar subprocess transport.
//!
//! Spawns a Node.js sidecar process that uses the Claude Agent SDK to
//! provide agentic capabilities (tool use, multi-turn, hooks, etc.).
//! Communication is via stdin/stdout JSON-lines, reusing the same
//! emit/listen pattern as claude_cli.rs.

use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::Mutex;

use crate::api_server;
use crate::commands::file_sync::ProjectRootState;
use crate::commands::profile_secrets::OsSecretStore;
use crate::commands::runtime_db;

const SIDECAR_PLACEHOLDER_PREFIX: &[u8] = b"Placeholder for Tauri resource validation.";
const AGENT_PROFILE_RENEW_INTERVAL: Duration = Duration::from_secs(60);

fn redact_url_userinfo_for_log(url: &str) -> String {
    let authority_start = url
        .find("://")
        .map(|scheme_end| scheme_end + 3)
        .unwrap_or(0);
    let rest = &url[authority_start..];
    let authority_end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let authority = &rest[..authority_end];
    let Some(userinfo_end) = authority.rfind('@') else {
        return url.to_string();
    };

    format!(
        "{}***@{}",
        &url[..authority_start],
        &url[authority_start + userinfo_end + 1..],
    )
}

/// Shared state holding running agent sidecar processes keyed by stream id.
#[derive(Default)]
pub struct AgentState {
    children: Arc<Mutex<HashMap<String, AgentProcess>>>,
}

struct AgentProcess {
    child: Child,
    stdin: Arc<Mutex<ChildStdin>>,
}

#[derive(Clone)]
struct AgentProfileClaimOwner {
    project_root: Option<PathBuf>,
    runtime_enabled: bool,
    claim_id: String,
}

#[derive(Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AgentSandboxOptions {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub auto_allow_bash_if_sandboxed: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fail_if_unavailable: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub network: Option<Value>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSpawnArgs {
    stream_id: String,
    prompt: String,
    system_prompt: Option<String>,
    cwd: Option<String>,
    model: Option<String>,
    max_turns: Option<u32>,
    max_budget_usd: Option<f64>,
    session_id: Option<String>,
    resume: Option<String>,
    continue_session: Option<bool>,
    fork_session: Option<bool>,
    resume_session_at: Option<String>,
    intent_override: Option<String>,
    persist_session: Option<bool>,
    title: Option<String>,
    api_key: Option<String>,
    base_url: Option<String>,
    agent_profile_auth_style: Option<String>,
    agent_profile_id: Option<String>,
    agent_profile_claim_id: Option<String>,
    permission_policy: Option<String>,
    project_id: Option<String>,
    project_path: Option<String>,
    api_server_base_url: Option<String>,
    api_token: Option<String>,
    enable_wiki_tools: Option<bool>,
    enable_write_tools: Option<bool>,
    max_write_bytes: Option<u32>,
    max_files_changed: Option<u32>,
    max_files_changed_enabled: Option<bool>,
    enable_file_checkpointing: Option<bool>,
    // PR E: subagents + skills + plugins
    agent_name: Option<String>,
    agents: Option<Value>,
    skills: Option<Value>,
    plugins: Option<Value>,
    // PR D: structured output
    output_format: Option<Value>,

    // PR D: thinking / effort / taskBudget
    thinking: Option<Value>,
    effort: Option<String>,
    task_budget: Option<Value>,

    // PR D: event passthrough
    include_partial_messages: Option<bool>,
    include_hook_events: Option<bool>,
    prompt_suggestions: Option<bool>,
    agent_progress_summaries: Option<bool>,
    forward_subagent_text: Option<bool>,
    sandbox: Option<AgentSandboxOptions>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentRequestOptions {
    #[serde(skip_serializing_if = "Option::is_none")]
    system_prompt: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    cwd: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    max_turns: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    max_budget_usd: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    resume: Option<String>,
    #[serde(rename = "continue", skip_serializing_if = "Option::is_none")]
    continue_session: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    fork_session: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    resume_session_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    intent_override: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    api_key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    base_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    agent_profile_auth_style: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    permission_policy: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    project_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    project_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    api_server_base_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    api_token: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    enable_wiki_tools: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    enable_write_tools: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    max_write_bytes: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    max_files_changed: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    max_files_changed_enabled: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    enable_file_checkpointing: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    sandbox: Option<AgentSandboxOptions>,
    // PR E: subagents + skills + plugins
    #[serde(skip_serializing_if = "Option::is_none")]
    agent_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    agents: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    skills: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    plugins: Option<Value>,
    // PR D: structured output
    #[serde(skip_serializing_if = "Option::is_none")]
    output_format: Option<Value>,

    // PR D: thinking / effort / taskBudget
    #[serde(skip_serializing_if = "Option::is_none")]
    thinking: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    effort: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    task_budget: Option<Value>,

    // PR D: event passthrough
    #[serde(skip_serializing_if = "Option::is_none")]
    include_partial_messages: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    include_hook_events: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    prompt_suggestions: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    agent_progress_summaries: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    forward_subagent_text: Option<bool>,
    persist_session: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentRequest {
    r#type: &'static str,
    stream_id: String,
    prompt: String,
    options: AgentRequestOptions,
}

fn build_agent_request(args: AgentSpawnArgs) -> AgentRequest {
    AgentRequest {
        r#type: "query",
        stream_id: args.stream_id,
        prompt: args.prompt,
        options: AgentRequestOptions {
            system_prompt: args.system_prompt,
            cwd: args.cwd,
            model: args.model,
            max_turns: args.max_turns,
            max_budget_usd: args.max_budget_usd,
            session_id: args.session_id,
            resume: args.resume,
            continue_session: args.continue_session,
            fork_session: args.fork_session,
            resume_session_at: args.resume_session_at,
            intent_override: args.intent_override,
            title: args.title,
            api_key: args.api_key,
            base_url: args.base_url,
            agent_profile_auth_style: args.agent_profile_auth_style,
            permission_policy: args.permission_policy,
            project_id: args.project_id,
            project_path: args.project_path,
            api_server_base_url: args.api_server_base_url,
            api_token: args.api_token,
            enable_wiki_tools: args.enable_wiki_tools,
            enable_write_tools: args.enable_write_tools,
            max_write_bytes: args.max_write_bytes,
            max_files_changed: args.max_files_changed,
            max_files_changed_enabled: args.max_files_changed_enabled,
            enable_file_checkpointing: args.enable_file_checkpointing,
            sandbox: args.sandbox,
            // PR E: subagents + skills + plugins
            agent_name: args.agent_name,
            agents: args.agents,
            skills: args.skills,
            plugins: args.plugins,
            // PR D: structured output
            output_format: args.output_format,
            // PR D: thinking / effort / taskBudget
            thinking: args.thinking,
            effort: args.effort,
            task_budget: args.task_budget,
            // PR D: event passthrough
            include_partial_messages: args.include_partial_messages,
            include_hook_events: args.include_hook_events,
            prompt_suggestions: args.prompt_suggestions,
            agent_progress_summaries: args.agent_progress_summaries,
            forward_subagent_text: args.forward_subagent_text,
            persist_session: args.persist_session.unwrap_or(false),
        },
    }
}

fn inject_internal_api_token(args: &mut AgentSpawnArgs) -> Option<String> {
    if args.enable_wiki_tools != Some(false) && args.project_path.is_some() {
        let token = api_server::new_agent_internal_api_token();
        args.api_token = Some(token.clone());
        return Some(token);
    }
    None
}

fn sanitize_agent_stderr_for_frontend(stderr: &str) -> String {
    runtime_db::sanitize_profile_pool_text_for_log(stderr)
}

fn apply_agent_profile_config(
    args: &mut AgentSpawnArgs,
    project_root: Option<&Path>,
    runtime_enabled: bool,
) -> Result<Option<AgentProfileClaimOwner>, String> {
    if args.agent_profile_id.is_none() && args.agent_profile_claim_id.is_none() {
        return Ok(None);
    }

    let (Some(profile_id), Some(claim_id)) = (
        args.agent_profile_id.as_deref(),
        args.agent_profile_claim_id.as_deref(),
    ) else {
        return Err(
            "agent-profile-invalid: agentProfileId and agentProfileClaimId are both required"
                .to_string(),
        );
    };

    let config = runtime_db::resolve_agent_run_profile_for_project_with_store(
        project_root,
        runtime_enabled,
        profile_id,
        claim_id,
        &OsSecretStore,
    )?;
    let owner = AgentProfileClaimOwner {
        project_root: project_root.map(Path::to_path_buf),
        runtime_enabled,
        claim_id: claim_id.to_string(),
    };
    args.model = Some(config.agent_sdk_model_id);
    args.base_url = config.endpoint;
    args.agent_profile_auth_style = Some(config.auth_style);
    args.api_key = config.secret_value;
    Ok(Some(owner))
}

fn start_agent_profile_claim_renewer(owner: AgentProfileClaimOwner) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(AGENT_PROFILE_RENEW_INTERVAL).await;
            if let Err(err) = runtime_db::renew_agent_profile_claim_for_project(
                owner.project_root.as_deref(),
                owner.runtime_enabled,
                &owner.claim_id,
            ) {
                eprintln!(
                    "[agent_spawn] profile claim renew failed for {}: {}",
                    owner.claim_id, err
                );
                if err.starts_with(runtime_db::PROFILE_CLAIM_INACTIVE_PREFIX) {
                    break;
                }
            }
        }
    })
}

fn release_agent_profile_claim(owner: &AgentProfileClaimOwner, exit_code: i32, stderr: &str) {
    let outcome = if exit_code == 0 { "success" } else { "error" };
    let error = if exit_code == 0 {
        None
    } else {
        let trimmed = stderr.trim();
        if trimmed.is_empty() {
            Some("agent sidecar exited before success".to_string())
        } else {
            Some(trimmed.to_string())
        }
    };
    if let Err(err) = runtime_db::release_agent_profile_claim_for_project(
        owner.project_root.as_deref(),
        owner.runtime_enabled,
        &owner.claim_id,
        outcome,
        error.as_deref(),
    ) {
        eprintln!(
            "[agent_spawn] profile claim release failed for {}: {}",
            owner.claim_id, err
        );
    }
}

#[tauri::command]
pub async fn agent_spawn(
    app: AppHandle,
    state: State<'_, AgentState>,
    root_state: State<'_, ProjectRootState>,
    mut args: AgentSpawnArgs,
) -> Result<(), String> {
    let runtime_enabled = runtime_db::work_runtime_enabled_from_env();
    let project_root = root_state.get();
    let profile_claim_owner =
        apply_agent_profile_config(&mut args, project_root.as_deref(), runtime_enabled)?;
    let logged_base_url = args.base_url.as_deref().map(redact_url_userinfo_for_log);
    eprintln!(
        "[agent_spawn] stream_id={}, model={:?}, base_url={:?}",
        args.stream_id, args.model, logged_base_url
    );
    let sidecar_cmd = find_sidecar_command(&app)?;

    let mut cmd = Command::new(&sidecar_cmd[0]);
    if sidecar_cmd.len() > 1 {
        cmd.args(&sidecar_cmd[1..]);
    }

    cmd.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    // Put the sidecar in its OWN process group (setpgid(0,0)) on Unix so
    // agent_kill can later killpg the whole tree — the sidecar spawns
    // grandchildren (tool subprocesses, e.g. the MCP/agent workers) that
    // `Child::kill` (SIGKILL on the direct child only) would orphan.
    #[cfg(unix)]
    cmd.process_group(0);

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn agent sidecar: {e}"))?;

    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| "Missing stdin handle".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Missing stdout handle".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "Missing stderr handle".to_string())?;

    let stream_id = args.stream_id.clone();
    let internal_api_token = inject_internal_api_token(&mut args);
    let request = build_agent_request(args);
    let request_line = format!(
        "{}\n",
        serde_json::to_string(&request)
            .map_err(|e| format!("Failed to serialize agent request: {e}"))?
    );
    if let Some(token) = &internal_api_token {
        api_server::register_agent_internal_api_token(token);
    }
    let stdin = Arc::new(Mutex::new(stdin));
    {
        let mut stdin_guard = stdin.lock().await;
        if let Err(e) = write_stdin_capped(&mut stdin_guard, &request_line).await {
            if let Some(token) = &internal_api_token {
                api_server::revoke_agent_internal_api_token(token);
            }
            return Err(format!("Failed to write to sidecar stdin: {e}"));
        }
    }

    state.children.lock().await.insert(
        stream_id.clone(),
        AgentProcess {
            child,
            stdin: Arc::clone(&stdin),
        },
    );

    let children = Arc::clone(&state.children);
    let app_for_task = app.clone();
    let stream_id_task = stream_id.clone();
    let internal_api_token_task = internal_api_token.clone();
    let profile_claim_owner_task = profile_claim_owner.clone();
    let profile_renew_task = profile_claim_owner
        .clone()
        .map(start_agent_profile_claim_renewer);
    let topic = format!("agent:{stream_id}");
    let done_topic = format!("agent:{stream_id}:done");

    tokio::spawn(async move {
        let mut reader = BufReader::new(stdout).lines();
        let mut stderr_reader = BufReader::new(stderr).lines();

        let stderr_task = tokio::spawn(async move {
            let mut collected = String::new();
            while let Ok(Some(line)) = stderr_reader.next_line().await {
                eprintln!("[agent-sidecar stderr] {line}");
                collected.push_str(&line);
                collected.push('\n');
            }
            collected
        });

        while let Ok(Some(line)) = reader.next_line().await {
            let _ = app_for_task.emit(&topic, &line);
        }

        let stderr_output = stderr_task.await.unwrap_or_default();

        let exit_code = {
            let mut map = children.lock().await;
            if let Some(mut process) = map.remove(&stream_id_task) {
                match process.child.try_wait() {
                    Ok(Some(status)) => status.code().unwrap_or(-1),
                    Ok(None) => {
                        // Child still running (e.g. stream ended before
                        // exit). Kill the whole tree and reap to avoid a
                        // zombie, then report non-zero (did not exit
                        // cleanly on its own).
                        let _ = kill_agent_tree(&mut process.child);
                        let _ = process.child.wait().await;
                        -1
                    }
                    Err(_) => -1,
                }
            } else {
                // Entry already removed (agent_kill ran). This stream was
                // explicitly killed — report non-zero, NOT 0 (false
                // success). Previously this returned 0, telling the
                // frontend a killed agent "succeeded".
                -1
            }
        };

        if let Some(token) = internal_api_token_task {
            api_server::revoke_agent_internal_api_token(&token);
        }
        if let Some(task) = profile_renew_task {
            task.abort();
        }
        if let Some(owner) = profile_claim_owner_task.as_ref() {
            release_agent_profile_claim(owner, exit_code, &stderr_output);
        }
        let frontend_stderr = sanitize_agent_stderr_for_frontend(&stderr_output);

        let done_payload = serde_json::json!({
            "code": exit_code,
            "stderr": frontend_stderr,
        });
        let _ = app_for_task.emit(&done_topic, &done_payload);
    });

    Ok(())
}

#[tauri::command]
pub async fn agent_tool_response(
    state: State<'_, AgentState>,
    stream_id: String,
    request_id: String,
    ok: bool,
    data: Option<Value>,
    error: Option<String>,
) -> Result<(), String> {
    let stdin = {
        let map = state.children.lock().await;
        map.get(&stream_id)
            .map(|process| Arc::clone(&process.stdin))
            .ok_or_else(|| format!("No running agent stream: {stream_id}"))?
    };
    let line = serde_json::json!({
        "type": "app_tool_response",
        "streamId": stream_id,
        "requestId": request_id,
        "ok": ok,
        "data": data,
        "error": error,
    })
    .to_string()
        + "\n";
    let mut guard = stdin.lock().await;
    if let Err(e) = write_stdin_capped(&mut guard, &line).await {
        let msg = format!("Failed to write app tool response: {e}");
        if is_stdin_pipe_poisoned(&msg) {
            // Pipe is wedged — partial bytes may corrupt further JSON.
            // Kill the sidecar so the next run spawns fresh.
            poison_agent_sidecar(&state, &stream_id).await;
        }
        return Err(msg);
    }
    Ok(())
}

#[tauri::command]
pub async fn agent_permission_response(
    state: State<'_, AgentState>,
    stream_id: String,
    request_id: String,
    ok: bool,
    decision: Option<Value>,
    error: Option<String>,
) -> Result<(), String> {
    let stdin = {
        let map = state.children.lock().await;
        map.get(&stream_id)
            .map(|process| Arc::clone(&process.stdin))
            .ok_or_else(|| format!("No running agent stream: {stream_id}"))?
    };
    let line = serde_json::json!({
        "type": "permission_response",
        "streamId": stream_id,
        "requestId": request_id,
        "ok": ok,
        "decision": decision,
        "error": error,
    })
    .to_string()
        + "\n";
    let mut guard = stdin.lock().await;
    if let Err(e) = write_stdin_capped(&mut guard, &line).await {
        let msg = format!("Failed to write permission response: {e}");
        if is_stdin_pipe_poisoned(&msg) {
            poison_agent_sidecar(&state, &stream_id).await;
        }
        return Err(msg);
    }
    Ok(())
}

#[tauri::command]
pub async fn agent_rewind_files(
    state: State<'_, AgentState>,
    stream_id: String,
    message_id: Option<String>,
) -> Result<(), String> {
    let stdin = {
        let map = state.children.lock().await;
        map.get(&stream_id)
            .map(|process| Arc::clone(&process.stdin))
            .ok_or_else(|| format!("No running agent stream: {stream_id}"))?
    };
    let line = serde_json::json!({
        "type": "rewind_files",
        "streamId": stream_id,
        "messageId": message_id,
    })
    .to_string()
        + "\n";
    let mut guard = stdin.lock().await;
    if let Err(e) = write_stdin_capped(&mut guard, &line).await {
        let msg = format!("Failed to write rewind request: {e}");
        if is_stdin_pipe_poisoned(&msg) {
            poison_agent_sidecar(&state, &stream_id).await;
        }
        return Err(msg);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    #[test]
    fn is_stdin_pipe_poisoned_detects_timeout_and_broken_pipe() {
        // A timed-out write_all may have left partial bytes in the OS
        // pipe — the sidecar must be killed, not reused.
        assert!(super::is_stdin_pipe_poisoned(
            "Failed to write app tool response: sidecar stdin write timed out after 10s"
        ));
        assert!(super::is_stdin_pipe_poisoned(
            "Failed to write rewind request: Broken pipe (os error 32)"
        ));
        // A size-cap rejection is NOT a pipe poison (no bytes were written).
        assert!(!super::is_stdin_pipe_poisoned(
            "Failed to write app tool response: sidecar stdin payload 99999999 bytes exceeds cap 8388608"
        ));
        // A transient non-pipe error is not fatal to the stream.
        assert!(!super::is_stdin_pipe_poisoned(
            "Failed to write app tool response: resource busy"
        ));
    }

    #[test]
    fn sanitize_agent_stderr_for_frontend_redacts_profile_secrets() {
        let redacted = super::sanitize_agent_stderr_for_frontend(
            "selected model failed\n\
             ANTHROPIC_AUTH_TOKEN=profile-token\n\
             authorization: gateway-token\n\
             {\"apiKey\":\"json-token\"}",
        );

        assert!(redacted.contains("selected model failed"));
        assert!(!redacted.contains("profile-token"));
        assert!(!redacted.contains("gateway-token"));
        assert!(!redacted.contains("json-token"));
        assert!(!redacted.contains("apiKey"));
    }

    #[test]
    fn agent_request_serializes_checkpoint_and_sandbox_options() {
        let mut args = args_with_optional_fields_none();
        args.enable_file_checkpointing = Some(true);
        args.sandbox = Some(AgentSandboxOptions {
            enabled: Some(true),
            auto_allow_bash_if_sandboxed: Some(false),
            fail_if_unavailable: Some(true),
            network: None,
        });

        let request = build_agent_request(args);
        let value: Value = serde_json::to_value(request).unwrap();
        let options = value.get("options").unwrap();

        assert_eq!(
            options
                .get("enableFileCheckpointing")
                .and_then(Value::as_bool),
            Some(true)
        );
        let sandbox = options.get("sandbox").unwrap();
        assert_eq!(sandbox.get("enabled").and_then(Value::as_bool), Some(true));
        assert_eq!(
            sandbox
                .get("autoAllowBashIfSandboxed")
                .and_then(Value::as_bool),
            Some(false)
        );
        assert_eq!(
            sandbox.get("failIfUnavailable").and_then(Value::as_bool),
            Some(true)
        );
        assert!(sandbox.get("network").is_none());
    }

    #[test]
    fn agent_request_omits_absent_checkpoint_and_sandbox() {
        let args = args_with_optional_fields_none();
        let request = build_agent_request(args);
        let value: Value = serde_json::to_value(request).unwrap();
        let options = value.get("options").unwrap();

        assert!(options.get("enableFileCheckpointing").is_none());
        assert!(options.get("sandbox").is_none());
    }

    use super::*;
    use serde_json::Value;
    use std::fs;
    use std::ops::Deref;
    use std::time::{SystemTime, UNIX_EPOCH};

    struct TempSidecarDir(PathBuf);

    impl TempSidecarDir {
        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Deref for TempSidecarDir {
        type Target = Path;

        fn deref(&self) -> &Self::Target {
            self.path()
        }
    }

    impl Drop for TempSidecarDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn temp_sidecar_dir(label: &str) -> TempSidecarDir {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "llm-wiki-agent-sidecar-{label}-{}-{unique}",
            std::process::id()
        ));
        fs::create_dir_all(&dir).unwrap();
        TempSidecarDir(dir)
    }

    fn write_file(path: &Path) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, "test").unwrap();
    }

    fn write_binary(path: &Path) {
        write_file(path);
        #[cfg(unix)]
        {
            let mut permissions = fs::metadata(path).unwrap().permissions();
            permissions.set_mode(0o755);
            fs::set_permissions(path, permissions).unwrap();
        }
    }

    fn write_empty_binary(path: &Path) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, "").unwrap();
        #[cfg(unix)]
        {
            let mut permissions = fs::metadata(path).unwrap().permissions();
            permissions.set_mode(0o755);
            fs::set_permissions(path, permissions).unwrap();
        }
    }

    #[test]
    fn redact_url_userinfo_for_log_masks_proxy_credentials() {
        assert_eq!(
            redact_url_userinfo_for_log("https://user:token@proxy.example.com/v1"),
            "https://***@proxy.example.com/v1"
        );
        assert_eq!(
            redact_url_userinfo_for_log("http://token@127.0.0.1:4000"),
            "http://***@127.0.0.1:4000"
        );
        assert_eq!(
            redact_url_userinfo_for_log("http://user:token@[::1]:4000/v1"),
            "http://***@[::1]:4000/v1"
        );
        assert_eq!(
            redact_url_userinfo_for_log("https://api.example.com/v1"),
            "https://api.example.com/v1"
        );
        assert_eq!(redact_url_userinfo_for_log("user:token@host"), "***@host");
    }

    fn args_with_optional_fields_none() -> AgentSpawnArgs {
        AgentSpawnArgs {
            stream_id: "stream-1".to_string(),
            prompt: "hello".to_string(),
            system_prompt: None,
            cwd: None,
            model: None,
            max_turns: None,
            max_budget_usd: None,
            session_id: None,
            resume: None,
            continue_session: None,
            fork_session: None,
            resume_session_at: None,
            intent_override: None,
            persist_session: None,
            title: None,
            api_key: None,
            base_url: None,
            agent_profile_auth_style: None,
            agent_profile_id: None,
            agent_profile_claim_id: None,
            permission_policy: None,
            project_id: None,
            project_path: None,
            api_server_base_url: None,
            api_token: None,
            enable_wiki_tools: None,
            enable_write_tools: None,
            max_write_bytes: None,
            max_files_changed: None,
            max_files_changed_enabled: None,
            enable_file_checkpointing: None,
            agent_name: None,
            agents: None,
            skills: None,
            plugins: None,
            output_format: None,
            thinking: None,
            effort: None,
            task_budget: None,
            include_partial_messages: None,
            include_hook_events: None,
            prompt_suggestions: None,
            agent_progress_summaries: None,
            forward_subagent_text: None,
            sandbox: None,
        }
    }

    #[test]
    fn agent_request_omits_absent_optional_fields() {
        let request = build_agent_request(args_with_optional_fields_none());
        let value: Value = serde_json::to_value(request).unwrap();
        let options = value.get("options").unwrap();

        assert_eq!(value.get("type").and_then(Value::as_str), Some("query"));
        assert_eq!(
            value.get("streamId").and_then(Value::as_str),
            Some("stream-1")
        );
        assert_eq!(
            options.get("persistSession").and_then(Value::as_bool),
            Some(false)
        );
        assert!(options.get("cwd").is_none());
        assert!(options.get("maxBudgetUsd").is_none());
        assert!(options.get("sessionId").is_none());
        assert!(options.get("resume").is_none());
        assert!(options.get("continue").is_none());
        assert!(options.get("forkSession").is_none());
        assert!(options.get("resumeSessionAt").is_none());
        assert!(options.get("intentOverride").is_none());
        assert!(options.get("title").is_none());
        assert!(options.get("apiKey").is_none());
    }

    #[test]
    fn agent_profile_claim_fields_are_not_serialized_to_sidecar_request() {
        let mut args = args_with_optional_fields_none();
        args.agent_profile_id = Some("profile-agent".to_string());
        args.agent_profile_claim_id = Some("claim-agent".to_string());
        args.model = Some("claude-test".to_string());
        args.api_key = Some("resolved-secret".to_string());
        args.agent_profile_auth_style = Some("x-api-key".to_string());

        let request = build_agent_request(args);
        let value: Value = serde_json::to_value(request).unwrap();
        let text = serde_json::to_string(&value).unwrap();

        assert!(!text.contains("agentProfileId"));
        assert!(!text.contains("agentProfileClaimId"));
        let options = value.get("options").unwrap();
        assert_eq!(
            options.get("model").and_then(Value::as_str),
            Some("claude-test")
        );
        assert_eq!(
            options.get("apiKey").and_then(Value::as_str),
            Some("resolved-secret")
        );
        assert_eq!(
            options.get("agentProfileAuthStyle").and_then(Value::as_str),
            Some("x-api-key")
        );
    }

    #[test]
    fn sidecar_command_uses_dev_node_fallback() {
        let cwd = temp_sidecar_dir("dev");
        let entry = cwd.join("sidecar").join("dist").join("main.js");
        write_file(&entry);

        let command = resolve_sidecar_command(None, &cwd, true).unwrap();

        assert_eq!(command[0], "node");
        assert_eq!(command[1], entry.to_string_lossy());
    }

    #[test]
    fn sidecar_command_prefers_dist_binary_over_node_fallback() {
        let cwd = temp_sidecar_dir("dist-bin");
        let binary = cwd
            .join("sidecar")
            .join("dist-bin")
            .join(sidecar_binary_name());
        let entry = cwd.join("sidecar").join("dist").join("main.js");
        write_binary(&binary);
        write_file(&entry);

        let command = resolve_sidecar_command(None, &cwd, true).unwrap();

        assert_eq!(command, vec![binary.to_string_lossy().to_string()]);
    }

    #[test]
    fn sidecar_command_prefers_bundled_resource_binary() {
        let resource_dir = temp_sidecar_dir("resource");
        let cwd = temp_sidecar_dir("resource-cwd");
        let bundled = resource_dir
            .join("sidecar")
            .join("dist-bin")
            .join(sidecar_binary_name());
        let local = cwd
            .join("sidecar")
            .join("dist-bin")
            .join(sidecar_binary_name());
        write_binary(&bundled);
        write_binary(&local);

        let command = resolve_sidecar_command(Some(&resource_dir), &cwd, true).unwrap();

        assert_eq!(command, vec![bundled.to_string_lossy().to_string()]);
        assert!(sidecar_available(Some(&resource_dir), &cwd, false));
    }

    #[test]
    fn sidecar_command_skips_non_executable_placeholder_on_unix() {
        let cwd = temp_sidecar_dir("placeholder");
        let placeholder = cwd
            .join("sidecar")
            .join("dist-bin")
            .join(sidecar_binary_name());
        let entry = cwd.join("sidecar").join("dist").join("main.js");
        write_file(&placeholder);
        write_file(&entry);

        let command = resolve_sidecar_command(None, &cwd, true).unwrap();

        assert_eq!(command[0], "node");
        assert_eq!(command[1], entry.to_string_lossy());
    }

    #[test]
    fn sidecar_command_skips_empty_binary_candidate() {
        let cwd = temp_sidecar_dir("empty-binary");
        let binary = cwd
            .join("sidecar")
            .join("dist-bin")
            .join(sidecar_binary_name());
        let entry = cwd.join("sidecar").join("dist").join("main.js");
        write_empty_binary(&binary);
        write_file(&entry);

        let command = resolve_sidecar_command(None, &cwd, true).unwrap();

        assert_eq!(command[0], "node");
        assert_eq!(command[1], entry.to_string_lossy());
    }

    #[test]
    fn sidecar_command_reports_missing_build_instead_of_release_unavailable() {
        let cwd = temp_sidecar_dir("missing");

        let error = resolve_sidecar_command(None, &cwd, false).unwrap_err();

        assert!(error.contains("Agent sidecar binary missing"));
        assert!(!error.contains("release mode"));
        assert!(!sidecar_available(None, &cwd, false));
    }

    #[test]
    fn sidecar_availability_requires_binary_or_dev_entry() {
        let cwd = temp_sidecar_dir("detect");

        assert!(!sidecar_available(None, &cwd, true));

        let entry = cwd.join("sidecar").join("dist").join("main.js");
        write_file(&entry);
        assert!(sidecar_available(None, &cwd, true));
        assert!(!sidecar_available(None, &cwd, false));
    }

    #[test]
    fn agent_request_serializes_present_optional_fields_as_camel_case() {
        let mut args = args_with_optional_fields_none();
        args.system_prompt = Some("system".to_string());
        args.cwd = Some("/tmp/wiki".to_string());
        args.model = Some("claude-sonnet-4-20250514".to_string());
        args.max_turns = Some(3);
        args.max_budget_usd = Some(0.25);
        args.session_id = Some("11111111-1111-4111-8111-111111111111".to_string());
        args.resume = Some("22222222-2222-4222-8222-222222222222".to_string());
        args.continue_session = Some(true);
        args.fork_session = Some(true);
        args.resume_session_at = Some("msg-1".to_string());
        args.intent_override = Some("Treat latest user message as primary.".to_string());
        args.persist_session = Some(true);
        args.title = Some("Wiki Agent".to_string());
        args.api_key = Some("test-key".to_string());
        args.base_url = Some("http://localhost:4000".to_string());
        args.permission_policy = Some("default".to_string());
        args.project_id = Some("project-1".to_string());
        args.project_path = Some("/tmp/wiki".to_string());
        args.api_server_base_url = Some("http://127.0.0.1:19828".to_string());
        args.api_token = Some("api-token".to_string());
        args.enable_wiki_tools = Some(true);
        args.enable_write_tools = Some(true);
        args.max_write_bytes = Some(262144);
        args.max_files_changed = Some(3);
        args.max_files_changed_enabled = Some(true);

        let request = build_agent_request(args);
        let value: Value = serde_json::to_value(request).unwrap();
        let options = value.get("options").unwrap();

        assert_eq!(
            options.get("systemPrompt").and_then(Value::as_str),
            Some("system")
        );
        assert_eq!(
            options.get("cwd").and_then(Value::as_str),
            Some("/tmp/wiki")
        );
        assert_eq!(options.get("maxTurns").and_then(Value::as_u64), Some(3));
        assert_eq!(
            options.get("maxBudgetUsd").and_then(Value::as_f64),
            Some(0.25)
        );
        assert_eq!(
            options.get("sessionId").and_then(Value::as_str),
            Some("11111111-1111-4111-8111-111111111111")
        );
        assert_eq!(
            options.get("resume").and_then(Value::as_str),
            Some("22222222-2222-4222-8222-222222222222")
        );
        assert_eq!(options.get("continue").and_then(Value::as_bool), Some(true));
        assert_eq!(
            options.get("forkSession").and_then(Value::as_bool),
            Some(true)
        );
        assert_eq!(
            options.get("resumeSessionAt").and_then(Value::as_str),
            Some("msg-1")
        );
        assert_eq!(
            options.get("intentOverride").and_then(Value::as_str),
            Some("Treat latest user message as primary.")
        );
        assert_eq!(
            options.get("persistSession").and_then(Value::as_bool),
            Some(true)
        );
        assert_eq!(
            options.get("title").and_then(Value::as_str),
            Some("Wiki Agent")
        );
        assert_eq!(
            options.get("baseUrl").and_then(Value::as_str),
            Some("http://localhost:4000")
        );
        assert_eq!(
            options.get("permissionPolicy").and_then(Value::as_str),
            Some("default")
        );
        assert_eq!(
            options.get("projectId").and_then(Value::as_str),
            Some("project-1")
        );
        assert_eq!(
            options.get("projectPath").and_then(Value::as_str),
            Some("/tmp/wiki")
        );
        assert_eq!(
            options.get("apiServerBaseUrl").and_then(Value::as_str),
            Some("http://127.0.0.1:19828")
        );
        assert_eq!(
            options.get("apiToken").and_then(Value::as_str),
            Some("api-token")
        );
        assert_eq!(
            options.get("enableWikiTools").and_then(Value::as_bool),
            Some(true)
        );
        assert_eq!(
            options.get("enableWriteTools").and_then(Value::as_bool),
            Some(true)
        );
        assert_eq!(
            options.get("maxWriteBytes").and_then(Value::as_u64),
            Some(262144)
        );
        assert_eq!(
            options.get("maxFilesChanged").and_then(Value::as_u64),
            Some(3)
        );
        // max_files_changed_enabled serializes camelCase (rename_all) and
        // forwards into the sidecar request options.
        assert_eq!(
            options
                .get("maxFilesChangedEnabled")
                .and_then(Value::as_bool),
            Some(true)
        );
    }

    #[test]
    fn agent_wiki_tools_use_internal_api_token() {
        let mut args = args_with_optional_fields_none();
        args.project_path = Some("/tmp/wiki".to_string());
        args.api_token = Some("user-configured-token".to_string());
        args.enable_wiki_tools = Some(true);

        let token = inject_internal_api_token(&mut args).unwrap();

        assert_eq!(args.api_token.as_deref(), Some(token.as_str()));
        assert_ne!(args.api_token.as_deref(), Some("user-configured-token"));
        api_server::revoke_agent_internal_api_token(&token);
    }

    #[test]
    fn agent_without_wiki_tools_does_not_receive_internal_api_token() {
        let mut args = args_with_optional_fields_none();
        args.project_path = Some("/tmp/wiki".to_string());
        args.enable_wiki_tools = Some(false);

        let token = inject_internal_api_token(&mut args);

        assert!(token.is_none());
        assert!(args.api_token.is_none());
    }
}

#[tauri::command]
pub async fn agent_kill(state: State<'_, AgentState>, stream_id: String) -> Result<(), String> {
    if let Some(mut process) = state.children.lock().await.remove(&stream_id) {
        kill_agent_tree(&mut process.child)
            .map_err(|e| format!("Failed to kill agent sidecar: {e}"))?;
        // Reap the killed child so it doesn't linger as a zombie. The
        // reader task can't reap here (the map entry is already removed),
        // so we do it inline. SIGKILL was just sent to the whole group,
        // so wait() returns quickly once stdout closes; bounded latency.
        let _ = process.child.wait().await;
    }
    Ok(())
}

/// Kill the agent sidecar AND its descendants.
///
/// On Unix the sidecar is spawned in its own process group (see the
/// `process_group(0)` call in agent_spawn, which makes the child the
/// leader of a new group whose pgid == child pid), so we send SIGKILL to
/// the whole group. We use `kill(-pgid, sig)` (the negative-pid form of
/// `kill(2)`, which targets the process group) rather than `killpg`:
/// `killpg(pgrp, sig)` expects a *positive* pgrp and internally negates
/// it — passing a negative value to `killpg` is undefined. The negative
/// form of `kill` is the documented, portable way to signal a group.
/// This reaps the sidecar + all its descendants (tool subprocesses) that
/// the direct-child `Child::kill` (SIGKILL on the leader only) would
/// orphan. On non-Unix we fall back to killing the direct child.
fn kill_agent_tree(child: &mut tokio::process::Child) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        if let Some(pid) = child.id() {
            // kill(-pgid, sig) → signal the process group whose pgid == pid.
            // Safe: a libc syscall. ESRCH just means the group already
            // exited, so we treat it as success.
            let rc = unsafe { libc::kill(-(pid as libc::pid_t), libc::SIGKILL) };
            if rc != 0 {
                let err = std::io::Error::last_os_error();
                if err.raw_os_error() != Some(libc::ESRCH) {
                    return Err(err);
                }
            }
            return Ok(());
        }
    }
    // Non-Unix, or Unix child with no pid (already gone): direct kill.
    child.start_kill()
}

/// Hard timeout for stdin writes to the sidecar. A blocked/full pipe would
/// otherwise hang the Tauri command indefinitely (and serialize all writes
/// behind the stuck one via the stdin mutex).
const STDIN_WRITE_TIMEOUT: Duration = Duration::from_secs(10);
/// Reject stdin payloads larger than this before writing — a runaway tool
/// response or malformed JSON shouldn't be megabytes. Generous ceiling to
/// avoid rejecting legitimate large diffs/context.
const STDIN_WRITE_MAX_BYTES: usize = 8 * 1024 * 1024;

/// Write a line to the sidecar stdin with a size guard + hard timeout.
/// A full/blocked pipe would otherwise hang the caller forever; the
/// timeout turns that into a clean error. The size guard rejects
/// pathological payloads before they hit the pipe.
async fn write_stdin_capped(
    stdin: &mut tokio::process::ChildStdin,
    line: &str,
) -> std::io::Result<()> {
    let bytes = line.as_bytes();
    if bytes.len() > STDIN_WRITE_MAX_BYTES {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            format!(
                "sidecar stdin payload {} bytes exceeds cap {}",
                bytes.len(),
                STDIN_WRITE_MAX_BYTES
            ),
        ));
    }
    use tokio::io::AsyncWriteExt;
    match tokio::time::timeout(STDIN_WRITE_TIMEOUT, stdin.write_all(bytes)).await {
        Ok(Ok(())) => stdin.flush().await,
        Ok(Err(e)) => Err(e),
        Err(_) => Err(std::io::Error::new(
            std::io::ErrorKind::TimedOut,
            format!(
                "sidecar stdin write timed out after {:?}",
                STDIN_WRITE_TIMEOUT
            ),
        )),
    }
}

/// Sentinel substring in a stdin-write error indicating the sidecar's
/// pipe is wedged (write timed out). A timed-out `write_all` may have
/// left partial bytes in the OS pipe buffer, which would corrupt the
/// sidecar's line-delimited JSON parsing for every subsequent write.
/// When detected, the caller MUST poison the sidecar (kill + remove it
/// so the next agent run spawns a fresh process) rather than continue.
fn is_stdin_pipe_poisoned(err: &str) -> bool {
    err.contains("timed out") || err.contains("Broken pipe") || err.contains("timed-out")
}

/// Remove + kill the sidecar for `stream_id` after a fatal stdin error.
/// The next agent_spawn will start a fresh process, so we don't try to
/// recover the poisoned pipe. Best-effort: a missing entry or a kill
/// failure is logged but not propagated (the caller already has a
/// fatal error to return).
async fn poison_agent_sidecar(state: &State<'_, AgentState>, stream_id: &str) {
    if let Some(mut process) = state.children.lock().await.remove(stream_id) {
        let _ = kill_agent_tree(&mut process.child);
        let _ = process.child.wait().await;
    }
}

#[tauri::command]
pub fn agent_detect(app: AppHandle) -> Result<bool, String> {
    let resource_dir = app.path().resource_dir().ok();
    let cwd = std::env::current_dir().map_err(|e| format!("Cannot resolve current dir: {e}"))?;
    Ok(sidecar_available(
        resource_dir.as_deref(),
        &cwd,
        which::which("node").is_ok(),
    ))
}

fn find_sidecar_command(app: &AppHandle) -> Result<Vec<String>, String> {
    let resource_dir = app.path().resource_dir().ok();
    let cwd = std::env::current_dir().map_err(|e| format!("Cannot resolve sidecar path: {e}"))?;
    resolve_sidecar_command(resource_dir.as_deref(), &cwd, which::which("node").is_ok())
}

fn sidecar_binary_name() -> &'static str {
    if cfg!(windows) {
        "sidecar.exe"
    } else {
        "sidecar"
    }
}

fn sidecar_binary_candidates(resource_dir: Option<&Path>, cwd: &Path) -> Vec<PathBuf> {
    let binary = sidecar_binary_name();
    let mut candidates = Vec::new();
    if let Some(dir) = resource_dir {
        candidates.push(dir.join("sidecar").join("dist-bin").join(binary));
    }
    candidates.push(cwd.join("sidecar").join("dist-bin").join(binary));
    candidates
}

fn resolve_sidecar_command(
    resource_dir: Option<&Path>,
    cwd: &Path,
    node_on_path: bool,
) -> Result<Vec<String>, String> {
    for candidate in sidecar_binary_candidates(resource_dir, cwd) {
        if is_sidecar_binary(&candidate) {
            return Ok(vec![candidate.to_string_lossy().to_string()]);
        }
    }

    let sidecar_entry = cwd.join("sidecar").join("dist").join("main.js");
    if sidecar_entry.is_file() {
        if node_on_path {
            return Ok(vec![
                "node".to_string(),
                sidecar_entry.to_string_lossy().to_string(),
            ]);
        }
        return Err("Agent sidecar dev fallback requires node on PATH".to_string());
    }

    Err(
        "Agent sidecar binary missing; run `npm --prefix src-tauri/sidecar run build:binary` for production or `npm --prefix src-tauri/sidecar run build` for development"
            .to_string(),
    )
}

fn sidecar_available(resource_dir: Option<&Path>, cwd: &Path, node_on_path: bool) -> bool {
    resolve_sidecar_command(resource_dir, cwd, node_on_path).is_ok()
}

fn is_sidecar_binary(path: &Path) -> bool {
    if !path.is_file() {
        return false;
    }
    if path
        .metadata()
        .map(|metadata| metadata.len() == 0)
        .unwrap_or(true)
    {
        return false;
    }
    if is_sidecar_placeholder(path) {
        return false;
    }
    #[cfg(unix)]
    {
        path.metadata()
            .map(|metadata| metadata.permissions().mode() & 0o111 != 0)
            .unwrap_or(false)
    }
    #[cfg(not(unix))]
    {
        true
    }
}

fn is_sidecar_placeholder(path: &Path) -> bool {
    let Ok(mut file) = std::fs::File::open(path) else {
        return false;
    };
    let mut bytes = vec![0; SIDECAR_PLACEHOLDER_PREFIX.len()];
    file.read_exact(&mut bytes).is_ok() && bytes == SIDECAR_PLACEHOLDER_PREFIX
}
