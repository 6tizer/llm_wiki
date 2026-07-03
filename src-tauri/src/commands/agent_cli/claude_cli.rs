//! Claude Code CLI subprocess transport.
//!
//! Users with a Claude Code subscription already have OAuth credentials
//! in ~/.claude/ and the `claude` binary on PATH. This module lets LLM
//! Wiki reuse that subscription instead of requiring a separate API key.
//! We treat `claude` purely as a text-completion engine — its agent
//! tools, MCPs, file-edit abilities, and --resume session state are all
//! out of scope. Multi-turn history is reconstructed from `messages`
//! on every call, symmetric with every other provider.
//!
//! Why tokio::process directly (not tauri-plugin-shell): the plugin's
//! scope model is designed for sidecars or fixed absolute paths; scoping
//! a user-installed PATH binary cleanly is awkward. A hardcoded Rust
//! command that always and only spawns `claude` provides the same
//! security property (the webview can't call this command to execute
//! anything else) without pulling in another plugin or editing
//! capabilities JSON.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::Mutex;
use tokio::task::JoinHandle;

use super::cli_resolver::{
    child_path_env, find_cli_command, graceful_kill_process_group, kill_all_tracked_children,
    kill_process_group, KillSignal, GRACEFUL_KILL_GRACE_PERIOD,
};
use crate::commands::runtime_db;

/// Shared state holding running `claude` child processes keyed by the
/// frontend-generated stream id. Registered via .manage() in lib.rs.
#[derive(Default)]
pub struct ClaudeCliState {
    children: Arc<Mutex<HashMap<String, Child>>>,
    timeout_tasks: Arc<Mutex<HashMap<String, JoinHandle<()>>>>,
}

const MIN_CLAUDE_SPAWN_TIMEOUT_MINUTES: u64 = 1;
const MAX_CLAUDE_SPAWN_TIMEOUT_MINUTES: u64 = 240;

#[derive(Serialize)]
pub struct DetectResult {
    installed: bool,
    version: Option<String>,
    path: Option<String>,
    /// When !installed, a short human-readable reason (missing from PATH,
    /// quarantined on macOS, spawn failed, etc). The frontend shows this
    /// verbatim in the status pill.
    error: Option<String>,
}

#[derive(Deserialize)]
pub struct ClaudeMessage {
    /// "system" | "user" | "assistant"
    role: String,
    content: ClaudeContent,
}

#[derive(Clone, Deserialize)]
#[serde(untagged)]
enum ClaudeContent {
    Text(String),
    Blocks(Vec<ClaudeContentBlock>),
}

#[derive(Clone, Deserialize)]
#[serde(tag = "type")]
enum ClaudeContentBlock {
    #[serde(rename = "text")]
    Text { text: String },
    #[serde(rename = "image")]
    Image {
        #[serde(rename = "mediaType")]
        media_type: String,
        #[serde(rename = "dataBase64")]
        data_base64: String,
    },
}

fn claude_content_text_only(content: &ClaudeContent) -> String {
    match content {
        ClaudeContent::Text(text) => text.clone(),
        ClaudeContent::Blocks(blocks) => blocks
            .iter()
            .filter_map(|block| match block {
                ClaudeContentBlock::Text { text } => Some(text.as_str()),
                ClaudeContentBlock::Image { .. } => None,
            })
            .collect::<Vec<_>>()
            .join(""),
    }
}

fn claude_content_blocks(content: &ClaudeContent) -> Vec<serde_json::Value> {
    match content {
        ClaudeContent::Text(text) => vec![serde_json::json!({ "type": "text", "text": text })],
        ClaudeContent::Blocks(blocks) => blocks
            .iter()
            .map(|block| match block {
                ClaudeContentBlock::Text { text } => {
                    serde_json::json!({ "type": "text", "text": text })
                }
                ClaudeContentBlock::Image {
                    media_type,
                    data_base64,
                } => serde_json::json!({
                    "type": "image",
                    "source": {
                        "type": "base64",
                        "media_type": media_type,
                        "data": data_base64,
                    },
                }),
            })
            .collect(),
    }
}

fn claude_stdin_event(role: &str, content: &[serde_json::Value]) -> serde_json::Value {
    serde_json::json!({
        "type": role,
        "message": {
            "role": role,
            "content": content,
        }
    })
}

fn child_path_env_override(path_env: Option<String>) -> Option<(&'static str, String)> {
    path_env.map(|value| ("PATH", value))
}

async fn find_claude_command() -> Result<PathBuf, String> {
    find_cli_command("claude", &["claude.cmd", "claude.exe"]).await
}

fn suppress_windows_console(_cmd: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;

        const CREATE_NO_WINDOW: u32 = 0x08000000;
        _cmd.creation_flags(CREATE_NO_WINDOW);
    }
}

/// Locate `claude` on PATH and confirm it's runnable by calling
/// `claude --version` with a short timeout. Cheap — safe to call on
/// mount of the settings panel.
#[tauri::command]
pub async fn claude_cli_detect() -> Result<DetectResult, String> {
    let path = match find_claude_command().await {
        Ok(p) => p,
        Err(error) => {
            return Ok(DetectResult {
                installed: false,
                version: None,
                path: None,
                error: Some(error),
            });
        }
    };

    let path_str = path.to_string_lossy().to_string();

    let mut cmd = Command::new(&path);
    suppress_windows_console(&mut cmd);
    if let Some((key, value)) = child_path_env_override(child_path_env().await) {
        cmd.env(key, value);
    }
    let output = tokio::time::timeout(Duration::from_secs(3), cmd.arg("--version").output()).await;

    match output {
        Ok(Ok(out)) if out.status.success() => {
            let version = String::from_utf8_lossy(&out.stdout).trim().to_string();
            Ok(DetectResult {
                installed: true,
                version: Some(version),
                path: Some(path_str),
                error: None,
            })
        }
        Ok(Ok(out)) => {
            let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
            // macOS Gatekeeper quarantines produce a predictable error. If
            // we detect it, surface the remediation hint directly; the UI
            // renders this string into an actionable message.
            let error = if stderr.contains("quarantine") || stderr.contains("damaged") {
                Some(format!(
                    "Binary quarantined — try: xattr -d com.apple.quarantine {path_str}"
                ))
            } else if stderr.is_empty() {
                Some(format!("`claude --version` exited with {}", out.status))
            } else {
                Some(stderr)
            };
            Ok(DetectResult {
                installed: false,
                version: None,
                path: Some(path_str),
                error,
            })
        }
        Ok(Err(e)) => Ok(DetectResult {
            installed: false,
            version: None,
            path: Some(path_str),
            error: Some(format!("Failed to spawn `claude`: {e}")),
        }),
        Err(_) => Ok(DetectResult {
            installed: false,
            version: None,
            path: Some(path_str),
            error: Some("`claude --version` timed out after 3s".to_string()),
        }),
    }
}

/// Spawn `claude -p --output-format stream-json --input-format stream-json
/// --verbose --model <model>` and pipe stdout back to the frontend as
/// `claude-cli:{stream_id}` events (one line per event). Closes stdin
/// after writing the serialized history so claude starts processing.
/// Emits a final `claude-cli:{stream_id}:done` event with `{ code }`
/// when the child exits.
#[tauri::command]
pub async fn claude_cli_spawn(
    app: AppHandle,
    state: State<'_, ClaudeCliState>,
    stream_id: String,
    model: String,
    messages: Vec<ClaudeMessage>,
    isolate_local_config: bool,
    working_directory: Option<String>,
    timeout_minutes: Option<u64>,
) -> Result<(), String> {
    // Build the turn list: fold any system messages into a preamble on
    // the first user turn rather than using a CLI flag, because
    // --system-prompt / --append-system-prompt availability varies
    // across claude CLI versions. Inlining works on every version.
    let system_preamble: String = messages
        .iter()
        .filter(|m| m.role == "system")
        .map(|m| claude_content_text_only(&m.content))
        .collect::<Vec<_>>()
        .join("\n\n");

    let conversation: Vec<&ClaudeMessage> = messages
        .iter()
        .filter(|m| m.role == "user" || m.role == "assistant")
        .collect();

    if conversation.is_empty() {
        return Err("No user/assistant messages to send to claude CLI".to_string());
    }

    // Synthesize turns with the preamble merged into the first user turn.
    let mut first_user_seen = false;
    let turns: Vec<(String, Vec<serde_json::Value>)> = conversation
        .iter()
        .map(|m| {
            let role = m.role.clone();
            let mut content = claude_content_blocks(&m.content);
            if !first_user_seen && role == "user" && !system_preamble.is_empty() {
                content.insert(
                    0,
                    serde_json::json!({ "type": "text", "text": format!("{system_preamble}\n\n") }),
                );
                first_user_seen = true;
            }
            (role, content)
        })
        .collect();

    let working_directory = resolve_claude_working_directory(working_directory).await?;
    let claude = find_claude_command().await?;
    let mut cmd = Command::new(&claude);
    suppress_windows_console(&mut cmd);
    if let Some((key, value)) = child_path_env_override(child_path_env().await) {
        cmd.env(key, value);
    }
    cmd.args(build_claude_cli_args(&model, isolate_local_config));
    cmd.current_dir(&working_directory);

    cmd.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    // Put `claude` in its OWN process group (setpgid(0,0)) on Unix so
    // claude_cli_kill, the spawn-timeout watchdog, and app-exit cleanup
    // can kill the whole tree — claude may spawn its own child
    // subprocesses that killing only the direct child would orphan.
    // Mirrors the same call in agent_spawn (commands/agent_cli/agent.rs).
    #[cfg(unix)]
    cmd.process_group(0);

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn claude: {e}"))?;

    let mut stdin = child
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

    // Serialize turns to stdin then close. stream-json input format
    // expects one JSON event per line. Conversation history is laid out
    // in order; the final user turn triggers claude's response.
    //
    // `content` MUST be an array of blocks, not a plain string. The CLI
    // iterates content blocks looking for `tool_use_id` and crashes with
    // `W is not an Object. (evaluating '"tool_use_id"in W')` if it
    // encounters a raw string. User turns silently tolerated a string
    // in light testing, but assistant turns reject it immediately, so
    // we normalize both roles to the block-array form.
    for (role, content) in &turns {
        let event = claude_stdin_event(role, content);
        let line = format!("{}\n", event);
        stdin
            .write_all(line.as_bytes())
            .await
            .map_err(|e| format!("Failed to write to claude stdin: {e}"))?;
    }
    stdin
        .flush()
        .await
        .map_err(|e| format!("Failed to flush claude stdin: {e}"))?;
    drop(stdin);

    // Register the child so `claude_cli_kill` can reach it.
    state.children.lock().await.insert(stream_id.clone(), child);

    let children = Arc::clone(&state.children);
    let timeout_tasks = Arc::clone(&state.timeout_tasks);
    let timeout_minutes = claude_spawn_timeout_minutes(timeout_minutes);
    let timed_out = Arc::new(AtomicBool::new(false));
    if let Some(timeout_minutes) = timeout_minutes {
        let children_for_timeout = Arc::clone(&children);
        let stream_id_for_timeout = stream_id.clone();
        let timed_out_for_timeout = Arc::clone(&timed_out);
        let task = tokio::spawn(async move {
            tokio::time::sleep(Duration::from_secs(timeout_minutes * 60)).await;
            kill_child_for_claude_timeout(
                &children_for_timeout,
                &stream_id_for_timeout,
                &timed_out_for_timeout,
            )
            .await;
        });
        timeout_tasks.lock().await.insert(stream_id.clone(), task);
    }

    let app_for_task = app.clone();
    let stream_id_task = stream_id.clone();
    let topic = format!("claude-cli:{stream_id}");
    let done_topic = format!("claude-cli:{stream_id}:done");

    // Drain stdout line-by-line in a background task, emitting each
    // line as an event. Completes when stdout closes (child exited).
    tokio::spawn(async move {
        let mut reader = BufReader::new(stdout).lines();
        let mut stderr_reader = BufReader::new(stderr).lines();
        let app = app_for_task;

        // Collect stderr in a background task so we can ship it with the
        // final :done event — otherwise a non-zero exit produces only
        // "exited with code N" with no diagnostic info on the frontend.
        // Also echo each line to the tauri dev terminal so the developer
        // can watch the CLI's stderr live while iterating.
        let stderr_task = tokio::spawn(async move {
            let mut redactor = runtime_db::SecretRedactor::new();
            let mut collected = String::new();
            while let Ok(Some(line)) = stderr_reader.next_line().await {
                let sanitized = redactor.redact_line(&line);
                eprintln!("[claude-cli stderr] {sanitized}");
                collected.push_str(&sanitized);
                collected.push('\n');
            }
            collected
        });

        // `claude -p --output-format stream-json` emits one JSON object per
        // stdout line, which the frontend JSON.parses per line — whole-token
        // redaction would turn a secret-bearing minified line into a single
        // unparseable token, so this uses the JSON-aware, structural
        // redactor instead.
        let mut stdout_redactor = runtime_db::SecretRedactor::new();
        loop {
            match reader.next_line().await {
                Ok(Some(line)) => {
                    let sanitized = stdout_redactor.redact_json_line(&line);
                    if app.emit(&topic, sanitized).is_err() {
                        break;
                    }
                }
                Ok(None) => break,
                Err(e) => {
                    eprintln!("[claude-cli stdout] read error: {e}");
                    break;
                }
            }
        }

        // Wait for the child to fully exit so we can report its code.
        // Don't hold the map lock across .wait() — kill could race.
        let child_opt = children.lock().await.remove(&stream_id_task);
        abort_claude_timeout_task(&timeout_tasks, &stream_id_task).await;
        let exit_code = if let Some(mut child) = child_opt {
            match child.wait().await {
                Ok(status) => status.code(),
                Err(_) => None,
            }
        } else {
            // Already removed by claude_cli_kill — leave code as None.
            None
        };

        let stderr_text = stderr_task.await.unwrap_or_default();
        let timed_out = timed_out.load(Ordering::SeqCst);
        let stderr_text = if timed_out {
            append_claude_timeout_message(stderr_text, timeout_minutes.unwrap_or(0))
        } else {
            stderr_text
        };

        let _ = app.emit(
            &done_topic,
            claude_done_payload(exit_code, stderr_text, timed_out),
        );
    });

    Ok(())
}

fn claude_spawn_timeout_minutes(value: Option<u64>) -> Option<u64> {
    value.map(|minutes| {
        minutes.clamp(
            MIN_CLAUDE_SPAWN_TIMEOUT_MINUTES,
            MAX_CLAUDE_SPAWN_TIMEOUT_MINUTES,
        )
    })
}

fn claude_timeout_message(timeout_minutes: u64) -> String {
    let unit = if timeout_minutes == 1 {
        "minute"
    } else {
        "minutes"
    };
    format!("Claude Code CLI timed out after {timeout_minutes} {unit}.")
}

fn append_claude_timeout_message(mut stderr: String, timeout_minutes: u64) -> String {
    if !stderr.is_empty() {
        stderr.push('\n');
    }
    stderr.push_str(&claude_timeout_message(timeout_minutes));
    stderr
}

async fn abort_claude_timeout_task(
    timeout_tasks: &Arc<Mutex<HashMap<String, JoinHandle<()>>>>,
    stream_id: &str,
) -> bool {
    if let Some(task) = timeout_tasks.lock().await.remove(stream_id) {
        task.abort();
        true
    } else {
        false
    }
}

async fn kill_child_for_claude_timeout(
    children: &Arc<Mutex<HashMap<String, Child>>>,
    stream_id: &str,
    timed_out: &AtomicBool,
) -> bool {
    let mut children = children.lock().await;
    let Some(child) = children.get_mut(stream_id) else {
        return false;
    };

    match child.try_wait() {
        Ok(Some(_status)) => false,
        Ok(None) => {
            // SIGKILL the whole process group, not just `claude` itself —
            // see the process_group(0) call in claude_cli_spawn. A plain
            // start_kill() would orphan any tool subprocess claude forked.
            let _ = kill_process_group(child, KillSignal::Kill);
            timed_out.store(true, Ordering::SeqCst);
            true
        }
        Err(e) => {
            eprintln!("[claude-cli] timeout watchdog failed to inspect child status: {e}");
            false
        }
    }
}

fn claude_done_payload(
    exit_code: Option<i32>,
    stderr: String,
    timed_out: bool,
) -> serde_json::Value {
    serde_json::json!({
        "code": if timed_out { Some(-1) } else { exit_code },
        "stderr": stderr,
        "timedOut": timed_out,
    })
}

fn build_claude_cli_args(model: &str, isolate_local_config: bool) -> Vec<String> {
    let mut args = vec![
        "-p".to_string(),
        "--output-format".to_string(),
        "stream-json".to_string(),
        "--input-format".to_string(),
        "stream-json".to_string(),
        "--verbose".to_string(),
    ];

    if isolate_local_config {
        args.extend([
            "--setting-sources".to_string(),
            "project".to_string(),
            "--strict-mcp-config".to_string(),
            "--mcp-config".to_string(),
            "{}".to_string(),
            "--disable-slash-commands".to_string(),
            "--tools".to_string(),
            "".to_string(),
            "--no-session-persistence".to_string(),
            "--prompt-suggestions".to_string(),
            "false".to_string(),
        ]);
    }

    args.extend(["--model".to_string(), model.to_string()]);
    args
}

async fn resolve_claude_working_directory(value: Option<String>) -> Result<PathBuf, String> {
    let raw = value
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(str::to_string)
        .ok_or_else(|| {
            "Claude Code CLI requires an active project working directory".to_string()
        })?;
    let path = Path::new(raw.as_str());
    if !path.is_absolute() {
        return Err(
            "Claude Code CLI working directory must be an absolute project path".to_string(),
        );
    }
    let path_meta = tokio::fs::metadata(path).await.map_err(|e| {
        eprintln!("[claude-cli] failed to read working directory metadata {raw}: {e}");
        format!("Claude Code CLI working directory does not exist or cannot be read: {raw}")
    })?;
    if !path_meta.is_dir() {
        return Err(format!(
            "Claude Code CLI working directory is not a directory: {raw}"
        ));
    }
    let index_path = path.join("wiki").join("index.md");
    let index_meta = tokio::fs::metadata(&index_path).await.map_err(|e| {
        eprintln!("[claude-cli] failed to read wiki/index.md metadata for {raw}: {e}");
        format!("Claude Code CLI working directory must be an LLM Wiki project containing wiki/index.md: {raw}")
    })?;
    if !index_meta.is_file() {
        return Err(format!(
            "Claude Code CLI working directory must be an LLM Wiki project containing wiki/index.md: {raw}"
        ));
    }
    tokio::fs::canonicalize(path)
        .await
        .map_err(|e| format!("Failed to canonicalize Claude Code CLI working directory {raw}: {e}"))
}

/// Kill a running child registered under `stream_id`. Called on
/// AbortSignal in the frontend. No-op if the id is unknown (e.g. the
/// process already exited). SIGTERMs claude's whole process group first
/// (a chance for it, and any tool subprocess it spawned, to shut down
/// cleanly), then escalates to SIGKILL if it's still alive after
/// GRACEFUL_KILL_GRACE_PERIOD. Doesn't need an explicit wait() after
/// that: `graceful_kill_process_group`'s own try_wait() polling already
/// reaps the child once it exits, and kill_on_drop covers the
/// non-Unix / already-exited fallback when `child` drops at the end of
/// this block.
#[tauri::command]
pub async fn claude_cli_kill(
    state: State<'_, ClaudeCliState>,
    stream_id: String,
) -> Result<(), String> {
    if let Some(mut child) = state.children.lock().await.remove(&stream_id) {
        graceful_kill_process_group(&mut child, GRACEFUL_KILL_GRACE_PERIOD).await;
    }
    abort_claude_timeout_task(&state.timeout_tasks, &stream_id).await;
    Ok(())
}

impl ClaudeCliState {
    /// SIGTERM-then-SIGKILL every tracked `claude` child's process group,
    /// concurrently (see `kill_all_tracked_children`). Used only during
    /// app shutdown (see `kill_all_agent_subprocesses` in lib.rs):
    /// `app.exit(0)` terminates immediately without running Rust `Drop`
    /// impls, so `kill_on_drop` never fires and these children — plus
    /// any grandchild tool subprocesses under their process groups —
    /// would otherwise become orphans.
    pub(crate) async fn kill_all(&self) {
        kill_all_tracked_children(&self.children).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn claude_content_blocks_maps_frontend_image_blocks_to_anthropic_shape() {
        let content: ClaudeContent = serde_json::from_value(serde_json::json!([
            { "type": "text", "text": "describe this" },
            { "type": "image", "mediaType": "image/png", "dataBase64": "abc123" }
        ]))
        .expect("content block payload should deserialize");

        let blocks = claude_content_blocks(&content);

        assert_eq!(
            blocks,
            vec![
                serde_json::json!({ "type": "text", "text": "describe this" }),
                serde_json::json!({
                    "type": "image",
                    "source": {
                        "type": "base64",
                        "media_type": "image/png",
                        "data": "abc123",
                    },
                }),
            ]
        );
    }

    #[test]
    fn system_text_drops_images_before_inlining_preamble() {
        let content: ClaudeContent = serde_json::from_value(serde_json::json!([
            { "type": "text", "text": "system rule" },
            { "type": "image", "mediaType": "image/png", "dataBase64": "abc123" }
        ]))
        .expect("content block payload should deserialize");

        assert_eq!(claude_content_text_only(&content), "system rule");
    }

    #[test]
    fn claude_stdin_event_sends_text_blocks_directly() {
        let content = ClaudeContent::Text("hello".to_string());
        let blocks = claude_content_blocks(&content);
        let event = claude_stdin_event("user", &blocks);

        assert_eq!(event["message"]["content"][0]["type"], "text");
        assert_eq!(event["message"]["content"][0]["text"], "hello");
        assert!(event["message"]["content"][0]["text"].is_string());
        assert!(!event["message"]["content"][0]["text"].is_array());
    }

    #[test]
    fn claude_stdin_event_preserves_image_blocks_directly() {
        let content: ClaudeContent = serde_json::from_value(serde_json::json!([
            { "type": "text", "text": "describe this" },
            { "type": "image", "mediaType": "image/png", "dataBase64": "abc123" }
        ]))
        .expect("content block payload should deserialize");
        let blocks = claude_content_blocks(&content);
        let event = claude_stdin_event("user", &blocks);

        assert_eq!(event["message"]["content"][0]["text"], "describe this");
        assert_eq!(event["message"]["content"][1]["type"], "image");
        assert_eq!(
            event["message"]["content"][1]["source"],
            serde_json::json!({
                "type": "base64",
                "media_type": "image/png",
                "data": "abc123",
            })
        );
    }

    #[test]
    fn claude_child_path_env_override_targets_path() {
        assert_eq!(
            child_path_env_override(Some("/opt/homebrew/bin:/usr/bin".to_string())),
            Some(("PATH", "/opt/homebrew/bin:/usr/bin".to_string()))
        );
        assert_eq!(child_path_env_override(None), None);
    }

    #[test]
    fn claude_args_do_not_isolate_local_config_by_default() {
        let args = build_claude_cli_args("sonnet", false);

        assert!(args.contains(&"--model".to_string()));
        assert!(args.contains(&"sonnet".to_string()));
        assert!(!args.contains(&"--setting-sources".to_string()));
        assert!(!args.contains(&"--strict-mcp-config".to_string()));
        assert!(!args.contains(&"--disable-slash-commands".to_string()));
    }

    #[test]
    fn claude_args_can_isolate_user_config_tools_and_mcp() {
        let args = build_claude_cli_args("sonnet", true);

        assert!(args
            .windows(2)
            .any(|pair| pair[0] == "--setting-sources" && pair[1] == "project"));
        assert!(args.contains(&"--strict-mcp-config".to_string()));
        assert!(args
            .windows(2)
            .any(|pair| pair[0] == "--mcp-config" && pair[1] == "{}"));
        assert!(args.contains(&"--disable-slash-commands".to_string()));
        assert!(args
            .windows(2)
            .any(|pair| pair[0] == "--tools" && pair[1].is_empty()));
        assert!(args.contains(&"--no-session-persistence".to_string()));
        assert!(args
            .windows(2)
            .any(|pair| pair[0] == "--prompt-suggestions" && pair[1] == "false"));
    }

    #[test]
    fn claude_spawn_timeout_minutes_is_disabled_by_default_and_clamps_when_set() {
        assert_eq!(claude_spawn_timeout_minutes(None), None);
        assert_eq!(claude_spawn_timeout_minutes(Some(0)), Some(1));
        assert_eq!(claude_spawn_timeout_minutes(Some(42)), Some(42));
        assert_eq!(claude_spawn_timeout_minutes(Some(999)), Some(240));
    }

    #[test]
    fn claude_done_payload_marks_timeout_and_keeps_legacy_code() {
        let payload = claude_done_payload(Some(0), claude_timeout_message(1), true);

        assert_eq!(payload["timedOut"].as_bool(), Some(true));
        assert_eq!(payload["code"].as_i64(), Some(-1));
        assert_eq!(
            payload["stderr"],
            "Claude Code CLI timed out after 1 minute."
        );
    }

    #[test]
    fn claude_done_payload_preserves_non_timeout_exit_code() {
        let payload = claude_done_payload(Some(-1), "bad flags".to_string(), false);

        assert_eq!(payload["timedOut"].as_bool(), Some(false));
        assert_eq!(payload["code"].as_i64(), Some(-1));
        assert_eq!(payload["stderr"], "bad flags");
    }

    #[test]
    fn claude_timeout_message_uses_singular_minute() {
        assert_eq!(
            claude_timeout_message(1),
            "Claude Code CLI timed out after 1 minute."
        );
        assert_eq!(
            claude_timeout_message(2),
            "Claude Code CLI timed out after 2 minutes."
        );
    }

    #[test]
    fn append_claude_timeout_message_keeps_stderr_diagnostics() {
        assert_eq!(
            append_claude_timeout_message("existing".to_string(), 2),
            "existing\nClaude Code CLI timed out after 2 minutes."
        );
        assert_eq!(
            append_claude_timeout_message(String::new(), 2),
            "Claude Code CLI timed out after 2 minutes."
        );
    }

    #[tokio::test]
    async fn abort_claude_timeout_task_removes_task_without_marking_timeout() {
        let timeout_tasks = Arc::new(Mutex::new(HashMap::new()));
        let timed_out = Arc::new(AtomicBool::new(false));
        let timed_out_for_task = Arc::clone(&timed_out);
        let task = tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(50)).await;
            timed_out_for_task.store(true, Ordering::SeqCst);
        });

        timeout_tasks
            .lock()
            .await
            .insert("stream-1".to_string(), task);

        assert!(abort_claude_timeout_task(&timeout_tasks, "stream-1").await);
        assert!(timeout_tasks.lock().await.is_empty());
        tokio::time::sleep(Duration::from_millis(75)).await;
        assert!(!timed_out.load(Ordering::SeqCst));
    }

    #[tokio::test]
    async fn manual_kill_cleanup_does_not_mark_done_payload_as_timed_out() {
        let timeout_tasks = Arc::new(Mutex::new(HashMap::new()));
        let timed_out = Arc::new(AtomicBool::new(false));
        let timed_out_for_task = Arc::clone(&timed_out);
        let task = tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(50)).await;
            timed_out_for_task.store(true, Ordering::SeqCst);
        });

        timeout_tasks
            .lock()
            .await
            .insert("stream-1".to_string(), task);
        assert!(abort_claude_timeout_task(&timeout_tasks, "stream-1").await);

        tokio::time::sleep(Duration::from_millis(75)).await;
        let payload = claude_done_payload(
            None,
            "Process was killed by user.".to_string(),
            timed_out.load(Ordering::SeqCst),
        );

        assert_eq!(payload["timedOut"].as_bool(), Some(false));
        assert!(payload["code"].is_null());
        assert_eq!(payload["stderr"], "Process was killed by user.");
    }

    #[tokio::test]
    async fn timeout_watchdog_without_child_does_not_mark_timed_out() {
        let children = Arc::new(Mutex::new(HashMap::new()));
        let timed_out = AtomicBool::new(false);

        assert!(!kill_child_for_claude_timeout(&children, "stream-1", &timed_out).await);
        assert!(!timed_out.load(Ordering::SeqCst));
    }

    #[tokio::test]
    async fn timeout_watchdog_exited_child_does_not_mark_timed_out() {
        let children = Arc::new(Mutex::new(HashMap::new()));
        let child = spawn_quick_exit_child().expect("spawn quick child");
        tokio::time::sleep(Duration::from_millis(50)).await;
        children.lock().await.insert("stream-1".to_string(), child);
        let timed_out = AtomicBool::new(false);

        assert!(!kill_child_for_claude_timeout(&children, "stream-1", &timed_out).await);
        assert!(!timed_out.load(Ordering::SeqCst));
        assert!(children.lock().await.contains_key("stream-1"));

        let mut child = children
            .lock()
            .await
            .remove("stream-1")
            .expect("child remains available for cleanup");
        let status = child.wait().await.expect("reap child");
        assert!(status.success());
    }

    #[tokio::test]
    async fn timeout_watchdog_kills_running_child_but_leaves_it_for_reap() {
        let children = Arc::new(Mutex::new(HashMap::new()));
        let child = spawn_sleep_child().expect("spawn sleep child");
        children.lock().await.insert("stream-1".to_string(), child);
        let timed_out = AtomicBool::new(false);

        assert!(kill_child_for_claude_timeout(&children, "stream-1", &timed_out).await);
        assert!(timed_out.load(Ordering::SeqCst));
        assert!(children.lock().await.contains_key("stream-1"));

        let mut child = children
            .lock()
            .await
            .remove("stream-1")
            .expect("child remains available for wait");
        let _ = child.wait().await.expect("reap killed child");
    }

    fn spawn_quick_exit_child() -> Result<Child, std::io::Error> {
        let mut cmd = platform_shell_command("exit 0");
        cmd.spawn()
    }

    fn spawn_sleep_child() -> Result<Child, std::io::Error> {
        let mut cmd = platform_shell_command(platform_sleep_command());
        cmd.spawn()
    }

    #[cfg(unix)]
    fn platform_shell_command(script: &str) -> Command {
        let mut cmd = Command::new("sh");
        cmd.arg("-c").arg(script);
        // Mirrors the process_group(0) call in claude_cli_spawn: the
        // timeout watchdog now kills the whole process group (see
        // kill_child_for_claude_timeout), which only reaches this test
        // child if it's the leader of its own group.
        cmd.process_group(0);
        cmd
    }

    #[cfg(windows)]
    fn platform_shell_command(script: &str) -> Command {
        let mut cmd = Command::new("cmd");
        cmd.arg("/C").arg(script);
        suppress_windows_console(&mut cmd);
        cmd
    }

    #[cfg(unix)]
    fn platform_sleep_command() -> &'static str {
        "sleep 5"
    }

    #[cfg(windows)]
    fn platform_sleep_command() -> &'static str {
        "ping -n 6 127.0.0.1 >NUL"
    }

    #[tokio::test]
    async fn claude_working_directory_requires_llm_wiki_project() {
        assert!(resolve_claude_working_directory(None)
            .await
            .unwrap_err()
            .contains("active project"));
        assert!(resolve_claude_working_directory(Some("".to_string()))
            .await
            .unwrap_err()
            .contains("active project"));
        assert!(resolve_claude_working_directory(Some("   ".to_string()))
            .await
            .unwrap_err()
            .contains("active project"));
        assert!(
            resolve_claude_working_directory(Some("relative/path".to_string()))
                .await
                .unwrap_err()
                .contains("absolute")
        );

        let dir = std::env::temp_dir().join(format!(
            "llm-wiki-claude-cwd-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).expect("temp dir");
        let raw = dir.to_string_lossy().to_string();

        assert!(resolve_claude_working_directory(Some(raw.clone()))
            .await
            .unwrap_err()
            .contains("wiki/index.md"));

        let wiki_dir = dir.join("wiki");
        std::fs::create_dir_all(&wiki_dir).expect("wiki dir");
        let index_dir = wiki_dir.join("index.md");
        std::fs::create_dir_all(&index_dir).expect("index dir");
        assert!(resolve_claude_working_directory(Some(raw.clone()))
            .await
            .unwrap_err()
            .contains("wiki/index.md"));
        std::fs::remove_dir_all(&index_dir).expect("remove index dir");
        std::fs::write(wiki_dir.join("index.md"), "# Index\n").expect("index");

        let resolved = resolve_claude_working_directory(Some(raw))
            .await
            .expect("valid project path");
        assert_eq!(resolved, dir.canonicalize().expect("canonical tempdir"));

        std::fs::remove_dir_all(&dir).expect("cleanup temp dir");
    }

    /// Process-group symmetry for the app-shutdown path: a "claude"-shaped
    /// leader that forked a grandchild subprocess must have BOTH killed by
    /// `ClaudeCliState::kill_all`, not just the direct child.
    #[cfg(unix)]
    #[tokio::test]
    async fn claude_cli_state_kill_all_terminates_group_including_descendant() {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("system clock before Unix epoch")
            .as_nanos();
        let marker_path = std::env::temp_dir().join(format!(
            "llm-wiki-claude-kill-all-grandchild-{}-{nanos}",
            std::process::id()
        ));
        let _ = std::fs::remove_file(&marker_path);
        let script = format!(
            "sleep 30 & echo $! > {}; wait",
            marker_path.to_string_lossy()
        );
        let mut cmd = platform_shell_command(&script);
        cmd.stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        let child = cmd.spawn().expect("spawn fake claude leader");

        let state = ClaudeCliState::default();
        state
            .children
            .lock()
            .await
            .insert("stream-1".to_string(), child);

        let deadline = std::time::Instant::now() + Duration::from_secs(2);
        let grandchild_pid: i32 = loop {
            if let Ok(contents) = std::fs::read_to_string(&marker_path) {
                if let Ok(pid) = contents.trim().parse::<i32>() {
                    break pid;
                }
            }
            assert!(
                std::time::Instant::now() < deadline,
                "grandchild pid marker file never appeared"
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        };

        state.kill_all().await;
        assert!(state.children.lock().await.is_empty());

        tokio::time::sleep(Duration::from_millis(200)).await;
        let alive = unsafe { libc::kill(grandchild_pid, 0) == 0 };
        assert!(!alive, "grandchild survived ClaudeCliState::kill_all");
        let _ = std::fs::remove_file(&marker_path);
    }
}
