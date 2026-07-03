//! Codex CLI subprocess transport.
//!
//! This mirrors the Claude Code CLI transport, but treats `codex` as a
//! local completion engine via `codex exec --json`. The webview can only
//! spawn this fixed command; it cannot execute arbitrary shell commands.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::time::Duration;

use serde::Serialize;
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

pub struct CodexCliState {
    children: Arc<Mutex<HashMap<String, Child>>>,
    timeout_tasks: Arc<Mutex<HashMap<String, JoinHandle<()>>>>,
}

impl Default for CodexCliState {
    fn default() -> Self {
        Self {
            children: Arc::new(Mutex::new(HashMap::new())),
            timeout_tasks: Arc::new(Mutex::new(HashMap::new())),
        }
    }
}

#[derive(Serialize)]
pub struct DetectResult {
    installed: bool,
    version: Option<String>,
    path: Option<String>,
    error: Option<String>,
}

const DEFAULT_CODEX_SPAWN_TIMEOUT_MINUTES: u64 = 10;
const MIN_CODEX_SPAWN_TIMEOUT_MINUTES: u64 = 1;
const MAX_CODEX_SPAWN_TIMEOUT_MINUTES: u64 = 240;
const STDERR_LIMIT_BYTES: usize = 1024 * 1024;
const STDOUT_LIMIT_BYTES: usize = 1024 * 1024;

fn append_capped_line(collected: &mut String, line: &str, limit_bytes: usize) {
    if collected.len() >= limit_bytes {
        return;
    }
    for ch in line.chars() {
        if collected.len() + ch.len_utf8() > limit_bytes {
            break;
        }
        collected.push(ch);
    }
    if collected.len() < limit_bytes {
        collected.push('\n');
    }
}

async fn find_codex_command() -> Result<PathBuf, String> {
    find_cli_command("codex", &["codex.cmd", "codex.exe"]).await
}

fn suppress_windows_console(_cmd: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;

        const CREATE_NO_WINDOW: u32 = 0x08000000;
        _cmd.creation_flags(CREATE_NO_WINDOW);
    }
}

#[tauri::command]
pub async fn codex_cli_detect() -> Result<DetectResult, String> {
    let path = match find_codex_command().await {
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
    if let Some(path_env) = child_path_env().await {
        cmd.env("PATH", path_env);
    }
    let output = tokio::time::timeout(Duration::from_secs(3), cmd.arg("--version").output()).await;

    match output {
        Ok(Ok(out)) if out.status.success() => {
            let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
            Ok(DetectResult {
                installed: true,
                version: Some(stdout),
                path: Some(path_str),
                error: None,
            })
        }
        Ok(Ok(out)) => {
            let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
            Ok(DetectResult {
                installed: false,
                version: None,
                path: Some(path_str),
                error: Some(if stderr.is_empty() {
                    format!("`codex --version` exited with {}", out.status)
                } else {
                    stderr
                }),
            })
        }
        Ok(Err(e)) => Ok(DetectResult {
            installed: false,
            version: None,
            path: Some(path_str),
            error: Some(format!("Failed to spawn `codex`: {e}")),
        }),
        Err(_) => Ok(DetectResult {
            installed: false,
            version: None,
            path: Some(path_str),
            error: Some("`codex --version` timed out after 3s".to_string()),
        }),
    }
}

#[tauri::command]
pub async fn codex_cli_spawn(
    app: AppHandle,
    state: State<'_, CodexCliState>,
    stream_id: String,
    model: String,
    prompt: String,
    isolate_local_config: bool,
    timeout_minutes: Option<u64>,
    working_directory: Option<String>,
) -> Result<(), String> {
    if prompt.trim().is_empty() {
        return Err("No prompt to send to codex CLI".to_string());
    }

    let working_directory = resolve_codex_working_directory(working_directory).await?;
    let codex = find_codex_command().await?;
    let mut cmd = Command::new(&codex);
    suppress_windows_console(&mut cmd);
    if let Some(path_env) = child_path_env().await {
        cmd.env("PATH", path_env);
    }
    cmd.args(build_codex_cli_args(&model, isolate_local_config));
    cmd.current_dir(&working_directory);

    cmd.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    // Put `codex` in its OWN process group (setpgid(0,0)) on Unix so
    // codex_cli_kill, the spawn-timeout watchdog, and app-exit cleanup
    // can kill the whole tree — codex may spawn its own child
    // subprocesses that killing only the direct child would orphan.
    // Mirrors the same call in agent_spawn (commands/agent_cli/agent.rs).
    #[cfg(unix)]
    cmd.process_group(0);

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn codex: {e}"))?;

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

    stdin
        .write_all(prompt.as_bytes())
        .await
        .map_err(|e| format!("Failed to write to codex stdin: {e}"))?;
    stdin
        .flush()
        .await
        .map_err(|e| format!("Failed to flush codex stdin: {e}"))?;
    drop(stdin);

    state.children.lock().await.insert(stream_id.clone(), child);

    let children = Arc::clone(&state.children);
    let timeout_children = Arc::clone(&state.children);
    let timeout_tasks = Arc::clone(&state.timeout_tasks);
    let timeout_tasks_for_reader = Arc::clone(&state.timeout_tasks);
    let timed_out = Arc::new(AtomicBool::new(false));
    let timeout_flag = Arc::clone(&timed_out);
    let timeout_stream_id = stream_id.clone();
    let timeout_task_stream_id = stream_id.clone();
    let timeout_minutes = codex_spawn_timeout_minutes(timeout_minutes);
    let timeout_duration = Duration::from_secs(timeout_minutes * 60);
    let app_for_task = app.clone();
    let stream_id_task = stream_id.clone();
    let topic = format!("codex-cli:{stream_id}");
    let done_topic = format!("codex-cli:{stream_id}:done");

    let timeout_task = tokio::spawn(async move {
        tokio::time::sleep(timeout_duration).await;
        {
            let mut children = timeout_children.lock().await;
            if let Some(child) = children.get_mut(&timeout_stream_id) {
                timeout_flag.store(true, Ordering::SeqCst);
                // SIGKILL the whole process group, not just `codex` itself
                // — see the process_group(0) call above. A plain
                // start_kill() would orphan any tool subprocess codex
                // forked.
                let _ = kill_process_group(child, KillSignal::Kill);
            }
        }
        timeout_tasks.lock().await.remove(&timeout_task_stream_id);
    });
    state
        .timeout_tasks
        .lock()
        .await
        .insert(stream_id.clone(), timeout_task);

    tokio::spawn(async move {
        let mut reader = BufReader::new(stdout).lines();
        let mut stderr_reader = BufReader::new(stderr).lines();
        let app = app_for_task;

        let stderr_task = tokio::spawn(async move {
            let mut redactor = runtime_db::SecretRedactor::new();
            let mut collected = String::new();
            while let Ok(Some(line)) = stderr_reader.next_line().await {
                let sanitized = redactor.redact_line(&line);
                eprintln!("[codex-cli stderr] {sanitized}");
                append_capped_line(&mut collected, &sanitized, STDERR_LIMIT_BYTES);
            }
            collected
        });

        // `codex exec --json` emits one JSON object per stdout line, which
        // the frontend JSON.parses per line — whole-token redaction would
        // turn a secret-bearing minified line into a single unparseable
        // token, so this uses the JSON-aware, structural redactor instead.
        // `stdout_text` (used for the :done diagnostic payload) accumulates
        // the same sanitized value emitted to the frontend, not the raw
        // line.
        let mut stdout_redactor = runtime_db::SecretRedactor::new();
        let mut stdout_text = String::new();
        loop {
            match reader.next_line().await {
                Ok(Some(line)) => {
                    let sanitized = stdout_redactor.redact_json_line(&line);
                    append_capped_line(&mut stdout_text, &sanitized, STDOUT_LIMIT_BYTES);
                    if app.emit(&topic, sanitized).is_err() {
                        break;
                    }
                }
                Ok(None) => break,
                Err(e) => {
                    eprintln!("[codex-cli stdout] read error: {e}");
                    break;
                }
            }
        }

        let child_opt = children.lock().await.remove(&stream_id_task);
        abort_timeout_task(&timeout_tasks_for_reader, &stream_id_task).await;
        let exit_code = if let Some(mut child) = child_opt {
            match child.wait().await {
                Ok(status) => status.code(),
                Err(_) => None,
            }
        } else {
            None
        };

        let mut stderr_text = stderr_task.await.unwrap_or_default();
        if timed_out.load(Ordering::SeqCst) {
            if !stderr_text.is_empty() {
                stderr_text.push('\n');
            }
            stderr_text.push_str(&codex_timeout_message(timeout_minutes));
        } else if stderr_text.len() >= STDERR_LIMIT_BYTES {
            stderr_text.push_str("\n[stderr truncated]");
        }
        if stdout_text.len() >= STDOUT_LIMIT_BYTES {
            stdout_text.push_str("\n[stdout truncated]");
        }

        let timed_out = timed_out.load(Ordering::SeqCst);

        let _ = app.emit(
            &done_topic,
            codex_done_payload(exit_code, stderr_text, stdout_text, timed_out),
        );
    });

    Ok(())
}

fn codex_spawn_timeout_minutes(value: Option<u64>) -> u64 {
    value.unwrap_or(DEFAULT_CODEX_SPAWN_TIMEOUT_MINUTES).clamp(
        MIN_CODEX_SPAWN_TIMEOUT_MINUTES,
        MAX_CODEX_SPAWN_TIMEOUT_MINUTES,
    )
}

fn codex_timeout_message(timeout_minutes: u64) -> String {
    let unit = if timeout_minutes == 1 {
        "minute"
    } else {
        "minutes"
    };
    format!("Codex CLI timed out after {timeout_minutes} {unit}.")
}

async fn abort_timeout_task(
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

fn codex_done_payload(
    exit_code: Option<i32>,
    stderr: String,
    stdout: String,
    timed_out: bool,
) -> serde_json::Value {
    serde_json::json!({
        "code": if timed_out { Some(-1) } else { exit_code },
        "stderr": stderr,
        "stdout": stdout,
        "timedOut": timed_out,
    })
}

fn build_codex_cli_args(model: &str, isolate_local_config: bool) -> Vec<String> {
    let mut args = vec!["exec".to_string()];

    if isolate_local_config {
        args.extend([
            "--ignore-user-config".to_string(),
            "--ignore-rules".to_string(),
        ]);
    }

    args.extend([
        "--json".to_string(),
        "--skip-git-repo-check".to_string(),
        "--sandbox".to_string(),
        "read-only".to_string(),
        "--ephemeral".to_string(),
        "--model".to_string(),
        model.to_string(),
        "-".to_string(),
    ]);
    args
}

async fn resolve_codex_working_directory(value: Option<String>) -> Result<PathBuf, String> {
    let raw = value
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(str::to_string)
        .ok_or_else(|| "Codex CLI requires an active project working directory".to_string())?;
    let path = Path::new(raw.as_str());
    if !path.is_absolute() {
        return Err("Codex CLI working directory must be an absolute project path".to_string());
    }
    let path_meta = tokio::fs::metadata(path).await.map_err(|e| {
        eprintln!("[codex-cli] failed to read working directory metadata {raw}: {e}");
        format!("Codex CLI working directory does not exist or cannot be read: {raw}")
    })?;
    if !path_meta.is_dir() {
        return Err(format!(
            "Codex CLI working directory is not a directory: {raw}"
        ));
    }
    let index_path = path.join("wiki").join("index.md");
    let index_meta = tokio::fs::metadata(&index_path).await.map_err(|e| {
        eprintln!("[codex-cli] failed to read wiki/index.md metadata for {raw}: {e}");
        format!("Codex CLI working directory must be an LLM Wiki project containing wiki/index.md: {raw}")
    })?;
    if !index_meta.is_file() {
        return Err(format!(
            "Codex CLI working directory must be an LLM Wiki project containing wiki/index.md: {raw}"
        ));
    }
    tokio::fs::canonicalize(path)
        .await
        .map_err(|e| format!("Failed to canonicalize Codex CLI working directory {raw}: {e}"))
}

/// Kill a running child registered under `stream_id`. No-op if the id is
/// unknown (e.g. the process already exited). SIGTERMs codex's whole
/// process group first (a chance for it, and any tool subprocess it
/// spawned, to shut down cleanly), then escalates to SIGKILL if it's
/// still alive after GRACEFUL_KILL_GRACE_PERIOD.
#[tauri::command]
pub async fn codex_cli_kill(
    state: State<'_, CodexCliState>,
    stream_id: String,
) -> Result<(), String> {
    if let Some(mut child) = state.children.lock().await.remove(&stream_id) {
        graceful_kill_process_group(&mut child, GRACEFUL_KILL_GRACE_PERIOD).await;
    }
    abort_timeout_task(&state.timeout_tasks, &stream_id).await;
    Ok(())
}

impl CodexCliState {
    /// SIGTERM-then-SIGKILL every tracked `codex` child's process group,
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
    fn append_capped_line_appends_newline_when_space_remains() {
        let mut out = String::new();
        append_capped_line(&mut out, "hello", 16);
        assert_eq!(out, "hello\n");
    }

    #[test]
    fn append_capped_line_never_exceeds_limit() {
        let mut out = String::new();
        append_capped_line(&mut out, "abcdef", 4);
        assert_eq!(out, "abcd");
        assert_eq!(out.len(), 4);
        append_capped_line(&mut out, "ignored", 4);
        assert_eq!(out, "abcd");
    }

    #[test]
    fn append_capped_line_preserves_utf8_boundaries() {
        let mut out = String::new();
        append_capped_line(&mut out, "é水x", 5);
        assert_eq!(out, "é水");
        assert_eq!(out.len(), 5);
        assert!(std::str::from_utf8(out.as_bytes()).is_ok());
    }

    #[test]
    fn codex_spawn_timeout_minutes_defaults_and_clamps() {
        assert_eq!(
            codex_spawn_timeout_minutes(None),
            DEFAULT_CODEX_SPAWN_TIMEOUT_MINUTES
        );
        assert_eq!(
            codex_spawn_timeout_minutes(Some(0)),
            MIN_CODEX_SPAWN_TIMEOUT_MINUTES
        );
        assert_eq!(codex_spawn_timeout_minutes(Some(42)), 42);
        assert_eq!(
            codex_spawn_timeout_minutes(Some(999)),
            MAX_CODEX_SPAWN_TIMEOUT_MINUTES
        );
    }

    #[test]
    fn codex_done_payload_marks_timeout_and_keeps_legacy_code() {
        let payload = codex_done_payload(Some(0), codex_timeout_message(1), String::new(), true);

        assert_eq!(payload["timedOut"].as_bool(), Some(true));
        assert_eq!(payload["code"].as_i64(), Some(-1));
        assert_eq!(payload["stderr"], "Codex CLI timed out after 1 minute.");
    }

    #[test]
    fn codex_done_payload_preserves_non_timeout_exit_code() {
        let payload = codex_done_payload(Some(2), "bad flags".to_string(), String::new(), false);

        assert_eq!(payload["timedOut"].as_bool(), Some(false));
        assert_eq!(payload["code"].as_i64(), Some(2));
        assert_eq!(payload["stderr"], "bad flags");
    }

    #[test]
    fn codex_timeout_message_uses_singular_minute() {
        assert_eq!(
            codex_timeout_message(1),
            "Codex CLI timed out after 1 minute."
        );
        assert_eq!(
            codex_timeout_message(2),
            "Codex CLI timed out after 2 minutes."
        );
    }

    #[tokio::test]
    async fn abort_timeout_task_removes_task_without_running_timeout_body() {
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

        assert!(abort_timeout_task(&timeout_tasks, "stream-1").await);
        assert!(timeout_tasks.lock().await.is_empty());
        tokio::time::sleep(Duration::from_millis(75)).await;
        assert!(!timed_out.load(Ordering::SeqCst));
    }

    #[tokio::test]
    async fn kill_abort_cleanup_does_not_mark_done_payload_as_timed_out() {
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
        assert!(abort_timeout_task(&timeout_tasks, "stream-1").await);

        tokio::time::sleep(Duration::from_millis(75)).await;
        let payload = codex_done_payload(
            None,
            "Process was killed by user.".to_string(),
            String::new(),
            timed_out.load(Ordering::SeqCst),
        );

        assert_eq!(payload["timedOut"].as_bool(), Some(false));
        assert!(payload["code"].is_null());
        assert_eq!(payload["stderr"], "Process was killed by user.");
    }

    #[test]
    fn codex_args_do_not_isolate_local_config_by_default() {
        let args = build_codex_cli_args("gpt-5", false);

        assert_eq!(args.first().map(String::as_str), Some("exec"));
        assert!(!args.contains(&"-a".to_string()));
        assert!(!args.contains(&"--ask-for-approval".to_string()));
        assert!(!args.contains(&"never".to_string()));
        assert!(args.contains(&"--json".to_string()));
        assert!(args.contains(&"--skip-git-repo-check".to_string()));
        assert!(args
            .windows(2)
            .any(|pair| pair[0] == "--sandbox" && pair[1] == "read-only"));
        assert!(args.contains(&"--ephemeral".to_string()));
        assert!(args.contains(&"--model".to_string()));
        assert!(args.contains(&"gpt-5".to_string()));
        assert!(!args.contains(&"--ignore-user-config".to_string()));
        assert!(!args.contains(&"--ignore-rules".to_string()));
    }

    #[test]
    fn codex_args_can_isolate_user_config_and_rules() {
        let args = build_codex_cli_args("gpt-5", true);
        let exec_pos = args.iter().position(|arg| arg == "exec").expect("exec arg");
        let ignore_config_pos = args
            .iter()
            .position(|arg| arg == "--ignore-user-config")
            .expect("ignore-user-config arg");
        let ignore_rules_pos = args
            .iter()
            .position(|arg| arg == "--ignore-rules")
            .expect("ignore-rules arg");

        assert!(ignore_config_pos > exec_pos);
        assert!(ignore_rules_pos > exec_pos);
        assert!(args.windows(3).any(|pair| pair[0] == "--ignore-user-config"
            && pair[1] == "--ignore-rules"
            && pair[2] == "--json"));
    }

    struct TestDir(PathBuf);

    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[tokio::test]
    async fn codex_working_directory_requires_absolute_existing_project() {
        assert!(resolve_codex_working_directory(None)
            .await
            .unwrap_err()
            .contains("requires an active project"));
        assert!(resolve_codex_working_directory(Some("".to_string()))
            .await
            .unwrap_err()
            .contains("requires an active project"));
        assert!(resolve_codex_working_directory(Some("   ".to_string()))
            .await
            .unwrap_err()
            .contains("requires an active project"));
        assert!(
            resolve_codex_working_directory(Some("relative/project".to_string()))
                .await
                .unwrap_err()
                .contains("absolute")
        );

        let suffix = format!(
            "{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        );
        let missing = std::env::temp_dir().join(format!("llm-wiki-codex-missing-{suffix}"));
        let _ = std::fs::remove_dir_all(&missing);
        assert!(
            resolve_codex_working_directory(Some(missing.to_string_lossy().to_string()))
                .await
                .unwrap_err()
                .contains("does not exist or cannot be read")
        );

        let file_path = std::env::temp_dir().join(format!("llm-wiki-codex-file-{suffix}"));
        let _ = std::fs::remove_file(&file_path);
        std::fs::write(&file_path, "not a directory").expect("temp file");
        struct TestFile(PathBuf);
        impl Drop for TestFile {
            fn drop(&mut self) {
                let _ = std::fs::remove_file(&self.0);
            }
        }
        let _file_guard = TestFile(file_path.clone());
        assert!(
            resolve_codex_working_directory(Some(file_path.to_string_lossy().to_string()))
                .await
                .unwrap_err()
                .contains("not a directory")
        );

        let dir = std::env::temp_dir().join(format!("llm-wiki-codex-project-{suffix}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("tempdir");
        let _guard = TestDir(dir.clone());
        assert!(
            resolve_codex_working_directory(Some(dir.to_string_lossy().to_string()))
                .await
                .unwrap_err()
                .contains("wiki/index.md")
        );

        let wiki_dir = dir.join("wiki");
        std::fs::create_dir_all(&wiki_dir).expect("wiki dir");
        let index_dir = wiki_dir.join("index.md");
        std::fs::create_dir_all(&index_dir).expect("index dir");
        assert!(
            resolve_codex_working_directory(Some(dir.to_string_lossy().to_string()))
                .await
                .unwrap_err()
                .contains("wiki/index.md")
        );
        std::fs::remove_dir_all(&index_dir).expect("remove index dir");
        std::fs::write(wiki_dir.join("index.md"), "# Index\n").expect("index");
        let resolved = resolve_codex_working_directory(Some(dir.to_string_lossy().to_string()))
            .await
            .expect("valid project path");
        assert_eq!(resolved, dir.canonicalize().expect("canonical tempdir"));
    }

    /// Process-group symmetry for the app-shutdown path: a "codex"-shaped
    /// leader that forked a grandchild subprocess must have BOTH killed by
    /// `CodexCliState::kill_all`, not just the direct child.
    #[cfg(unix)]
    #[tokio::test]
    async fn codex_cli_state_kill_all_terminates_group_including_descendant() {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("system clock before Unix epoch")
            .as_nanos();
        let marker_path = std::env::temp_dir().join(format!(
            "llm-wiki-codex-kill-all-grandchild-{}-{nanos}",
            std::process::id()
        ));
        let _ = std::fs::remove_file(&marker_path);
        let script = format!(
            "sleep 30 & echo $! > {}; wait",
            marker_path.to_string_lossy()
        );
        let mut cmd = Command::new("sh");
        cmd.arg("-c")
            .arg(&script)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        cmd.process_group(0);
        let child = cmd.spawn().expect("spawn fake codex leader");

        let state = CodexCliState::default();
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
        assert!(!alive, "grandchild survived CodexCliState::kill_all");
        let _ = std::fs::remove_file(&marker_path);
    }
}
