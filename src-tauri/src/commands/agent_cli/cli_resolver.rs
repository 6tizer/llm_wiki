use std::collections::HashMap;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use serde::Serialize;
use tokio::task::JoinHandle;

const LOGIN_SHELL_PATH_TIMEOUT: Duration = Duration::from_secs(3);
const PATH_MARKER: char = '\x1e';

static RESOLVED_COMMANDS: OnceLock<Mutex<HashMap<String, PathBuf>>> = OnceLock::new();

#[cfg(not(windows))]
static RESOLVED_SHELL_PATH: OnceLock<Option<String>> = OnceLock::new();

pub(crate) type TimeoutTaskMap = Arc<tokio::sync::Mutex<HashMap<String, JoinHandle<()>>>>;

/// Common CLI detection payload returned by provider-specific detect commands.
#[derive(Serialize)]
pub struct DetectResult {
    pub(crate) installed: bool,
    pub(crate) version: Option<String>,
    pub(crate) path: Option<String>,
    /// When !installed, a short human-readable reason rendered by the UI.
    pub(crate) error: Option<String>,
}

pub(crate) fn suppress_windows_console(_cmd: &mut tokio::process::Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;

        const CREATE_NO_WINDOW: u32 = 0x08000000;
        _cmd.creation_flags(CREATE_NO_WINDOW);
    }
}

pub(crate) async fn apply_child_path_env(cmd: &mut tokio::process::Command) {
    let (path_key, path_value) = child_path_env_override(child_path_env().await);
    cmd.env(path_key, path_value);
}

pub(crate) async fn abort_timeout_task(timeout_tasks: &TimeoutTaskMap, stream_id: &str) -> bool {
    if let Some(task) = timeout_tasks.lock().await.remove(stream_id) {
        task.abort();
        true
    } else {
        false
    }
}

/// PATH to hand a spawned CLI so its interpreter resolves.
///
/// On macOS a GUI launch (Finder/Dock) inherits launchd's minimal PATH, which
/// omits version-manager dirs. Locating the binary already falls back to the
/// login shell PATH; node-shim CLIs like `codex` additionally need that PATH
/// at run time so their shebang finds `node`.
#[cfg(not(windows))]
pub(crate) async fn child_path_env() -> Option<String> {
    let shell_path = tokio::task::spawn_blocking(|| {
        RESOLVED_SHELL_PATH
            .get_or_init(|| login_shell_path(LOGIN_SHELL_PATH_TIMEOUT))
            .clone()
    })
    .await
    .ok()
    .flatten()?;
    Some(merge_child_path_env(
        &shell_path,
        std::env::var("PATH").ok().as_deref(),
    ))
}

#[cfg(windows)]
pub(crate) async fn child_path_env() -> Option<String> {
    None
}

/// `child_path_env()` returns `None` when it can't improve on the ambient
/// PATH — on Windows always, and on non-Windows whenever the login-shell
/// PATH probe times out. Those are exactly the cases where falling back to
/// the ambient PATH the app process already inherited is correct: PATH is
/// deliberately excluded from `BASE_ENV_ALLOWLIST` (it needs this dedicated
/// resolution, not the raw ambient copy `apply_env_allowlist` would give
/// unrelated allowlisted vars), so without this fallback a spawned CLI
/// would end up with no PATH at all after `apply_env_allowlist`'s
/// `env_clear` — a functional regression, not a security tightening (PATH
/// was always meant to pass through).
pub(crate) fn child_path_env_override(path_env: Option<String>) -> (&'static str, String) {
    (
        "PATH",
        path_env.unwrap_or_else(|| std::env::var("PATH").unwrap_or_default()),
    )
}

#[cfg(not(windows))]
fn merge_child_path_env(shell_path: &str, inherited_path: Option<&str>) -> String {
    match inherited_path {
        Some(current) if !current.is_empty() => format!("{shell_path}:{current}"),
        _ => shell_path.to_string(),
    }
}

pub(crate) async fn find_cli_command(
    command: &str,
    windows_candidates: &[&str],
) -> Result<PathBuf, String> {
    if let Some(path) = cached_command(command) {
        return Ok(path);
    }

    let command = command.to_string();
    let cache_key = command.clone();
    let windows_candidates = windows_candidates
        .iter()
        .map(|candidate| (*candidate).to_string())
        .collect::<Vec<_>>();
    let path = tokio::task::spawn_blocking(move || {
        find_cli_command_uncached(&command, &windows_candidates)
    })
    .await
    .map_err(|e| format!("Failed to resolve CLI command: {e}"))??;

    cache_command(cache_key, path.clone());
    Ok(path)
}

fn command_cache() -> &'static Mutex<HashMap<String, PathBuf>> {
    RESOLVED_COMMANDS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn cached_command(command: &str) -> Option<PathBuf> {
    let mut cache = command_cache().lock().ok()?;
    let path = cache.get(command)?.clone();
    if path.exists() {
        Some(path)
    } else {
        cache.remove(command);
        None
    }
}

fn cache_command(command: String, path: PathBuf) {
    if let Ok(mut cache) = command_cache().lock() {
        cache.insert(command, path);
    }
}

#[cfg_attr(not(windows), allow(unused_variables))]
fn find_cli_command_uncached(
    command: &str,
    windows_candidates: &[String],
) -> Result<PathBuf, String> {
    #[cfg(windows)]
    {
        for candidate in windows_candidates
            .iter()
            .map(String::as_str)
            .chain(std::iter::once(command))
        {
            if let Ok(path) = which::which(candidate) {
                return Ok(path);
            }
        }
        return Err(format!("`{command}` not found on PATH"));
    }

    #[cfg(not(windows))]
    {
        if let Ok(path) = which::which(command) {
            return Ok(path);
        }

        if let Some(full_path) = login_shell_path(LOGIN_SHELL_PATH_TIMEOUT) {
            if let Ok(path) = which::which_in(command, Some(&full_path), ".") {
                return Ok(path);
            }
        }

        Err(format!("`{command}` not found on PATH"))
    }
}

#[cfg(not(windows))]
fn login_shell_path(timeout: Duration) -> Option<String> {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string());
    let shell_name = PathBuf::from(&shell)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    let shell_args = if matches!(shell_name.as_str(), "sh" | "dash" | "ash") {
        vec!["-ic", r#"printf '\036PATH=%s\036\n' "$PATH""#]
    } else {
        vec!["-ilc", r#"printf '\036PATH=%s\036\n' "$PATH""#]
    };
    let mut child = Command::new(&shell)
        .args(shell_args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;

    let start = std::time::Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => {
                let output = child.wait_with_output().ok()?;
                let stdout = String::from_utf8_lossy(&output.stdout);
                return parse_shell_path_output(&stdout);
            }
            Ok(None) if start.elapsed() >= timeout => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(25)),
            Err(_) => return None,
        }
    }
}

#[cfg(not(windows))]
fn parse_shell_path_output(stdout: &str) -> Option<String> {
    for line in stdout.lines() {
        if let Some(rest) = line.strip_prefix(PATH_MARKER) {
            if let Some(val) = rest.strip_suffix(PATH_MARKER) {
                if let Some(path) = val.strip_prefix("PATH=") {
                    if !path.is_empty() {
                        return Some(path.to_string());
                    }
                }
            }
        }
    }
    None
}

// ── Ambient env allowlist for spawned dev CLIs (claude/codex/sidecar) ──
//
// `apply_env_allowlist` (below) `env_clear`s the child and repopulates it
// ONLY from the categories enumerated across this section, so a spawned
// CLI can't see whatever the user has stashed in their shell for unrelated
// tools (`AWS_SECRET_ACCESS_KEY`, `GITHUB_TOKEN`, `GH_TOKEN`, any other
// `*_TOKEN`/`*_KEY`/`*_SECRET`, cloud-provider `*_*` blocks, etc.) — those
// are exactly what this allowlist exists to keep OUT.
//
// What IS covered, and why each category is a legitimate ambient need for
// a locally-installed dev CLI (not a caller-supplied secret this app is
// responsible for gating):
//   - **OS baseline** (`BASE_ENV_ALLOWLIST`, platform-specific): shell/user
//     identity, temp dir, locale — needed for the CLI's own config/cache
//     lookup and to not break entirely post-`env_clear`.
//   - **SSH agent** (`SSH_AGENT_ENV_ALLOWLIST`): `git` operations the CLI
//     shells out to (pull/push over SSH) need to reach the user's running
//     ssh-agent, or they hang on a publickey/passphrase prompt with no
//     interactive terminal to answer it.
//   - **XDG base directories** (`XDG_ENV_ALLOWLIST`, Unix only): some CLIs
//     and their Node dependencies read config/cache from an XDG override
//     rather than assuming `$HOME/.config`; without these, HOME alone
//     doesn't reproduce the user's actual config location.
//   - **Terminal** (`TERMINAL_ENV_ALLOWLIST`): output formatting / color
//     capability detection — cosmetic, not sensitive.
//   - **Network / TLS-CA** (`NETWORK_TLS_ENV_ALLOWLIST`): corporate proxy
//     and custom-CA trust config the CLI's (or its Node runtime's) own HTTP
//     client needs to reach the network at all.
//
// Explicitly and permanently excluded, not just "not yet added":
//   - `NODE_OPTIONS` — a code/flag injection vector (`--require`,
//     `--inspect`, etc.), not a passive setting; passing it through would
//     let ambient env execute arbitrary code in the spawned Node process.
//   - `GIT_SSH_COMMAND` — lets the value replace the SSH invocation
//     entirely, i.e. run an arbitrary command; `SSH_AUTH_SOCK` gets the
//     legitimate agent-forwarding need without this.
//   - Any credential-shaped ambient var (`*_TOKEN`, `*_KEY`, `*_SECRET`,
//     `AWS_*`, `GITHUB_*`, `GH_*`, …) — these are precisely the unrelated
//     secrets this allowlist is designed to keep from leaking into an
//     LLM-driven subprocess.
//
// When something new needs to pass through, it belongs in one of the
// categories above (or a new, equally-explicit one) — not tacked on ad hoc.

/// OS/locale variables every spawned CLI needs regardless of provider —
/// split by platform because POSIX and Windows use entirely disjoint sets
/// of baseline env vars for config/cache/temp-dir resolution. A POSIX-only
/// list applied under `env_clear` on Windows would silently strip
/// `claude.cmd`/`codex.cmd` (and the Node runtime backing them) of
/// `SystemRoot`/`APPDATA`/etc., breaking config lookup, temp dirs, and in
/// some cases process startup entirely — this was PR6b's original gap
/// (allowlist design never accounted for Windows). Deliberately excludes
/// `PATH` on both platforms — callers set that separately via
/// `child_path_env`/`child_path_env_override` since it needs a computed
/// value (login-shell-resolved on non-Windows), not a raw ambient copy.
#[cfg(not(windows))]
pub(crate) const BASE_ENV_ALLOWLIST: &[&str] = &[
    "HOME", "TMPDIR", "LANG", "LC_ALL", "LC_CTYPE", "SHELL", "USER", "LOGNAME",
];

#[cfg(windows)]
pub(crate) const BASE_ENV_ALLOWLIST: &[&str] = &[
    "SystemRoot",
    "ComSpec",
    "USERPROFILE",
    "APPDATA",
    "LOCALAPPDATA",
    "TEMP",
    "TMP",
    "PATHEXT",
    "windir",
    "HOMEDRIVE",
    "HOMEPATH",
    "USERNAME",
    "NUMBER_OF_PROCESSORS",
];

/// SSH agent socket/PID. Not platform-cfg'd — OpenSSH for Windows uses the
/// same `SSH_AUTH_SOCK` convention (a named pipe path rather than a Unix
/// socket path, but the same env var), so one shared list covers both.
/// Without this, a `git` pull/push over SSH that `claude`/`codex` shells
/// out to can't reach the user's running ssh-agent and hangs waiting for
/// an interactive publickey/passphrase prompt that never comes.
const SSH_AGENT_ENV_ALLOWLIST: &[&str] = &["SSH_AUTH_SOCK", "SSH_AGENT_PID"];

/// XDG base-directory overrides — Unix-only convention (no Windows
/// equivalent, hence the empty `#[cfg(windows)]` arm). Some CLIs and their
/// Node dependencies resolve config/cache/data dirs from these rather than
/// assuming `$HOME/.config` etc.; `HOME` alone doesn't reproduce the user's
/// actual config location when they've set an XDG override.
#[cfg(not(windows))]
const XDG_ENV_ALLOWLIST: &[&str] = &[
    "XDG_CONFIG_HOME",
    "XDG_CACHE_HOME",
    "XDG_DATA_HOME",
    "XDG_RUNTIME_DIR",
];

#[cfg(windows)]
const XDG_ENV_ALLOWLIST: &[&str] = &[];

/// Terminal capability detection for CLI output formatting — cosmetic
/// (colors/box-drawing fallback), not a sensitive or configuration value.
const TERMINAL_ENV_ALLOWLIST: &[&str] = &["TERM", "COLORTERM"];

/// Corporate-proxy / TLS-CA env every spawned CLI can use — this is network
/// transport configuration, not a provider secret, so unlike
/// `CLAUDE_PROVIDER_ENV_ALLOWLIST`/`CODEX_PROVIDER_ENV_ALLOWLIST` it belongs
/// here once rather than duplicated in each provider-specific list. The
/// agent sidecar benefits too — its own HTTP calls to the LLM API need the
/// same proxy/CA config even though it gets provider credentials a
/// different way (stdin JSON).
///
/// - **Proxy** (`HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY`/`ALL_PROXY` + their
///   lowercase Unix-convention variants): plenty of real corporate-proxy
///   setups export ONLY the lowercase form, which is a different env var
///   name than its uppercase counterpart, not a fallback for it — omitting
///   either case would silently break `claude`/`codex`/the sidecar behind
///   such a proxy the moment `env_clear` took over.
/// - **TLS/CA**: `SSL_CERT_FILE`/`SSL_CERT_DIR` (OpenSSL-family single-file
///   vs. directory-of-certs forms, in case `claude`/`codex` ever do native
///   TLS) + `NODE_EXTRA_CA_CERTS`/`NODE_TLS_REJECT_UNAUTHORIZED` —
///   **all three spawn targets (`claude`, `codex`, the agent sidecar) are
///   Node or Node-backed processes, and Node does NOT read
///   `SSL_CERT_FILE`/`SSL_CERT_DIR`** to extend its trust store; it reads
///   `NODE_EXTRA_CA_CERTS` instead. Without it, a corporate TLS-inspecting
///   proxy or self-signed internal CA breaks cert validation for all three
///   even though the OpenSSL-style vars are set. `NODE_TLS_REJECT_UNAUTHORIZED`
///   is included for the (less common, but real) environments that need it
///   to disable strict validation entirely.
const NETWORK_TLS_ENV_ALLOWLIST: &[&str] = &[
    // Proxy — uppercase
    "NO_PROXY",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    // Proxy — lowercase Unix convention
    "no_proxy",
    "http_proxy",
    "https_proxy",
    "all_proxy",
    // TLS/CA
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "NODE_EXTRA_CA_CERTS",
    "NODE_TLS_REJECT_UNAUTHORIZED",
];

/// Wipes the child's inherited environment and repopulates it from the
/// explicit, categorized allowlist above instead. Spawned CLIs (`claude`,
/// `codex`, the agent sidecar) run arbitrary user-directed tool calls, so
/// blindly inheriting the whole app-process environment would hand them
/// every secret any other part of the app (or its own launch environment)
/// happens to have stashed in env vars. `extra_passthrough` layers
/// provider-specific keys (API keys, base URLs) on top of this common set.
pub(crate) fn apply_env_allowlist(cmd: &mut tokio::process::Command, extra_passthrough: &[&str]) {
    cmd.env_clear();
    for key in BASE_ENV_ALLOWLIST
        .iter()
        .chain(SSH_AGENT_ENV_ALLOWLIST.iter())
        .chain(XDG_ENV_ALLOWLIST.iter())
        .chain(TERMINAL_ENV_ALLOWLIST.iter())
        .chain(NETWORK_TLS_ENV_ALLOWLIST.iter())
        .chain(extra_passthrough.iter())
    {
        if let Ok(val) = std::env::var(key) {
            cmd.env(key, val);
        }
    }
}

/// Signal to send when killing a child's process group. Kept name-agnostic
/// (rather than raw `libc::c_int`) so callers on non-Unix — where
/// `kill_process_group` always falls back to `Child::start_kill()` — don't
/// need libc signal constants that don't exist on that platform.
#[derive(Clone, Copy)]
pub(crate) enum KillSignal {
    Term,
    Kill,
}

#[cfg(unix)]
fn signal_process_group(pid: u32, signal: KillSignal) -> std::io::Result<()> {
    let sig = match signal {
        KillSignal::Term => libc::SIGTERM,
        KillSignal::Kill => libc::SIGKILL,
    };
    // kill(-pgid, sig) — the negative-pid form of kill(2) — targets the
    // whole process group rather than a single process. Requires the
    // child to have been spawned with `process_group(0)`
    // (setpgid(0, 0)), which makes it the leader of a new group whose
    // pgid == its own pid, so any descendants it forks (tool
    // subprocesses etc.) inherit that same group and are reached by this
    // signal too — unlike `Child::kill`, which only signals the direct
    // child and orphans its descendants. ESRCH means the group already
    // exited; treated as success.
    let rc = unsafe { libc::kill(-(pid as libc::pid_t), sig) };
    if rc != 0 {
        let err = std::io::Error::last_os_error();
        if err.raw_os_error() != Some(libc::ESRCH) {
            return Err(err);
        }
    }
    Ok(())
}

/// Signal `child`'s entire process group (Unix, requires the child to have
/// been spawned with `process_group(0)`) or fall back to killing just the
/// direct child (non-Unix, or a Unix child with no OS pid because it
/// already exited). Non-Unix ignores `signal` — `Child::start_kill()` is a
/// hard terminate; there's no separate "polite" signal available there.
pub(crate) fn kill_process_group(
    child: &mut tokio::process::Child,
    signal: KillSignal,
) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        if let Some(pid) = child.id() {
            return signal_process_group(pid, signal);
        }
    }
    #[cfg(not(unix))]
    let _ = signal;
    child.start_kill()
}

/// How long `graceful_kill_process_group` waits after SIGTERM before
/// escalating to SIGKILL.
pub(crate) const GRACEFUL_KILL_GRACE_PERIOD: Duration = Duration::from_secs(2);
const GRACEFUL_KILL_POLL_INTERVAL: Duration = Duration::from_millis(50);

/// Terminate `child`'s process group gracefully: SIGTERM first, poll for
/// exit up to `grace_period`, then escalate to SIGKILL if it's still
/// running. On non-Unix, `kill_process_group`'s first call already
/// hard-kills (no separate SIGTERM there), so this returns almost
/// immediately. Does not `wait()`/reap the child — `try_wait` below reaps
/// it once it exits, and callers that need the exit status still call
/// `wait()` themselves; a still-alive `Child` is left for `kill_on_drop`
/// (or the caller's own drain loop) to finish reaping.
///
/// Leader exiting is NOT the same as the group being empty: a tool
/// subprocess the leader forked before it exited stays in the same pgid
/// and, if it's ignoring SIGTERM, would otherwise survive as an orphan.
/// So the pgid is captured up front (before `try_wait`/`wait` can reap
/// the leader and invalidate `Child::id()`) and the final SIGKILL is
/// always sent to that whole recorded group — even when the loop above
/// broke because the leader itself already exited — rather than only on
/// the timeout path. `signal_process_group`/`kill_process_group` both
/// treat ESRCH (group already fully empty) as success, so this is a
/// no-op for the common case where the leader really was the only
/// member.
pub(crate) async fn graceful_kill_process_group(
    child: &mut tokio::process::Child,
    grace_period: Duration,
) {
    let _ = kill_process_group(child, KillSignal::Term);
    #[cfg(unix)]
    let pgid = child.id();
    let deadline = tokio::time::Instant::now() + grace_period;
    loop {
        match child.try_wait() {
            Ok(Some(_)) | Err(_) => break,
            Ok(None) => {}
        }
        if tokio::time::Instant::now() >= deadline {
            break;
        }
        tokio::time::sleep(GRACEFUL_KILL_POLL_INTERVAL).await;
    }
    #[cfg(unix)]
    {
        if let Some(pid) = pgid {
            let _ = signal_process_group(pid, KillSignal::Kill);
            return;
        }
    }
    let _ = kill_process_group(child, KillSignal::Kill);
}

/// SIGTERM-then-SIGKILL every child tracked in `children`'s process
/// group, concurrently rather than one at a time. `graceful_kill_process_group`
/// can take up to its `grace_period` per child; draining and awaiting
/// them one by one would make the whole call scale linearly with the
/// number of tracked children (3 wedged children at a 2s grace period
/// == 6s), which blows through callers' own overall shutdown timeout
/// (see `AGENT_SHUTDOWN_TIMEOUT` in lib.rs) before the last children are
/// even signaled — leaving their process groups, and any descendants
/// under them, as orphans. Running them concurrently bounds the whole
/// call to ~O(grace period) regardless of how many children are
/// tracked.
pub(crate) async fn kill_all_tracked_children(
    children: &tokio::sync::Mutex<HashMap<String, tokio::process::Child>>,
) {
    // Drain under the lock, then kill without holding it — killing
    // doesn't touch the map again, so there's no reason to hold the
    // Mutex guard across the awaits below.
    let drained: Vec<tokio::process::Child> = children
        .lock()
        .await
        .drain()
        .map(|(_, child)| child)
        .collect();
    futures::future::join_all(drained.into_iter().map(|mut child| async move {
        graceful_kill_process_group(&mut child, GRACEFUL_KILL_GRACE_PERIOD).await;
    }))
    .await;
}

#[cfg(test)]
mod env_allowlist_tests {
    use super::{apply_env_allowlist, child_path_env_override};

    // Serializes the tests below since `std::env::set_var`/`remove_var`
    // mutate process-wide state and `cargo test` runs tests in the same
    // binary concurrently by default. Mirrors the pattern in proxy.rs.
    static ENV_MUTEX: std::sync::Mutex<()> = std::sync::Mutex::new(());

    fn env_keys(cmd: &tokio::process::Command) -> std::collections::HashSet<String> {
        cmd.as_std()
            .get_envs()
            .filter_map(|(k, v)| v.map(|_| k.to_string_lossy().to_string()))
            .collect()
    }

    #[test]
    fn drops_non_allowlisted_vars() {
        let _guard = ENV_MUTEX.lock().unwrap_or_else(|p| p.into_inner());
        let canary_key = "LLM_WIKI_TEST_CANARY_NOT_ALLOWLISTED";
        std::env::set_var(canary_key, "leak-me");

        let mut cmd = tokio::process::Command::new("true");
        apply_env_allowlist(&mut cmd, &[]);

        let keys = env_keys(&cmd);
        std::env::remove_var(canary_key);
        assert!(
            !keys.contains(canary_key),
            "non-allowlisted var must not reach the child"
        );
    }

    #[test]
    fn passes_through_base_allowlist_hit() {
        let _guard = ENV_MUTEX.lock().unwrap_or_else(|p| p.into_inner());
        // `HOME`/`USERPROFILE` is in BASE_ENV_ALLOWLIST on every platform
        // (see the `#[cfg(windows)]`/`#[cfg(not(windows))]` split there) —
        // picking the platform-appropriate key keeps this test meaningful
        // instead of just failing outright on a hypothetical Windows run.
        #[cfg(not(windows))]
        let key = "HOME";
        #[cfg(windows)]
        let key = "USERPROFILE";
        let prior = std::env::var(key).ok();
        std::env::set_var(key, "/tmp/llm-wiki-allowlist-test-home");

        let mut cmd = tokio::process::Command::new("true");
        apply_env_allowlist(&mut cmd, &[]);

        match prior {
            Some(v) => std::env::set_var(key, v),
            None => std::env::remove_var(key),
        }

        let envs: std::collections::HashMap<String, String> = cmd
            .as_std()
            .get_envs()
            .filter_map(|(k, v)| {
                Some((
                    k.to_string_lossy().to_string(),
                    v?.to_string_lossy().to_string(),
                ))
            })
            .collect();
        assert_eq!(
            envs.get(key).map(String::as_str),
            Some("/tmp/llm-wiki-allowlist-test-home"),
            "allowlisted var must pass through with its current value"
        );
    }

    /// Regression (Codex external-review P2-2): PR6b's original
    /// `BASE_ENV_ALLOWLIST` was POSIX-only (`HOME`/`SHELL`/`USER`/...),
    /// which under `env_clear` would strip Windows CLIs of `SystemRoot`,
    /// `APPDATA`, etc. entirely. This only compiles/runs on an actual
    /// Windows target, but it pins the platform-specific list's shape so a
    /// future edit can't silently drop the Windows baseline again.
    #[cfg(windows)]
    #[test]
    fn windows_base_allowlist_covers_windows_baseline_vars() {
        use super::BASE_ENV_ALLOWLIST;
        for expected in [
            "SystemRoot",
            "ComSpec",
            "USERPROFILE",
            "APPDATA",
            "LOCALAPPDATA",
            "TEMP",
            "TMP",
        ] {
            assert!(
                BASE_ENV_ALLOWLIST.contains(&expected),
                "Windows BASE_ENV_ALLOWLIST must include {expected}"
            );
        }
    }

    /// Proxy env is shared across all callers (BASE, not per-provider) so
    /// `apply_env_allowlist(cmd, &[])` — used verbatim by the agent
    /// sidecar — must still pass it through with no `extra_passthrough`.
    #[test]
    fn passes_through_network_proxy_allowlist_hit_with_no_extra_passthrough() {
        let _guard = ENV_MUTEX.lock().unwrap_or_else(|p| p.into_inner());
        let key = "HTTP_PROXY";
        let prior = std::env::var(key).ok();
        std::env::set_var(key, "http://proxy.test:8080");

        let mut cmd = tokio::process::Command::new("true");
        apply_env_allowlist(&mut cmd, &[]);

        match prior {
            Some(v) => std::env::set_var(key, v),
            None => std::env::remove_var(key),
        }

        let envs: std::collections::HashMap<String, String> = cmd
            .as_std()
            .get_envs()
            .filter_map(|(k, v)| {
                Some((
                    k.to_string_lossy().to_string(),
                    v?.to_string_lossy().to_string(),
                ))
            })
            .collect();
        assert_eq!(
            envs.get(key).map(String::as_str),
            Some("http://proxy.test:8080"),
            "network-proxy allowlist entries must pass through even with an empty extra_passthrough"
        );
    }

    /// Regression (Codex external-review P2): the lowercase Unix proxy
    /// convention (`http_proxy`/`https_proxy`/`no_proxy`/`all_proxy`) is a
    /// DIFFERENT env var name than its uppercase counterpart — plenty of
    /// real setups export only the lowercase form — so it needs its own
    /// allowlist entry, not just the uppercase one.
    #[test]
    fn passes_through_lowercase_network_proxy_allowlist_hit() {
        let _guard = ENV_MUTEX.lock().unwrap_or_else(|p| p.into_inner());
        let key = "http_proxy";
        let prior = std::env::var(key).ok();
        std::env::set_var(key, "http://lowercase-proxy.test:8080");

        let mut cmd = tokio::process::Command::new("true");
        apply_env_allowlist(&mut cmd, &[]);

        match prior {
            Some(v) => std::env::set_var(key, v),
            None => std::env::remove_var(key),
        }

        let envs: std::collections::HashMap<String, String> = cmd
            .as_std()
            .get_envs()
            .filter_map(|(k, v)| {
                Some((
                    k.to_string_lossy().to_string(),
                    v?.to_string_lossy().to_string(),
                ))
            })
            .collect();
        assert_eq!(
            envs.get(key).map(String::as_str),
            Some("http://lowercase-proxy.test:8080"),
            "lowercase proxy env must pass through as its own allowlist entry"
        );
    }

    /// Regression (Codex external-review P2): `claude`/`codex`/the sidecar
    /// are all Node or Node-backed processes, and Node reads
    /// `NODE_EXTRA_CA_CERTS` (not `SSL_CERT_FILE`) to extend its trust
    /// store — a corporate TLS-inspecting proxy or self-signed internal CA
    /// would otherwise break cert validation even with `SSL_CERT_FILE` set.
    #[test]
    fn passes_through_node_extra_ca_certs_allowlist_hit() {
        let _guard = ENV_MUTEX.lock().unwrap_or_else(|p| p.into_inner());
        let key = "NODE_EXTRA_CA_CERTS";
        let prior = std::env::var(key).ok();
        std::env::set_var(key, "/etc/ssl/corp-ca-bundle.pem");

        let mut cmd = tokio::process::Command::new("true");
        apply_env_allowlist(&mut cmd, &[]);

        match prior {
            Some(v) => std::env::set_var(key, v),
            None => std::env::remove_var(key),
        }

        let envs: std::collections::HashMap<String, String> = cmd
            .as_std()
            .get_envs()
            .filter_map(|(k, v)| {
                Some((
                    k.to_string_lossy().to_string(),
                    v?.to_string_lossy().to_string(),
                ))
            })
            .collect();
        assert_eq!(
            envs.get(key).map(String::as_str),
            Some("/etc/ssl/corp-ca-bundle.pem"),
            "NODE_EXTRA_CA_CERTS must pass through — Node's actual custom-CA env var"
        );
    }

    /// Regression (Codex external-review P2, allowlist enumeration round
    /// 5): a `git` pull/push over SSH that `claude`/`codex` shells out to
    /// needs to reach the user's running ssh-agent via `SSH_AUTH_SOCK`, or
    /// it hangs on a publickey/passphrase prompt with no terminal to answer
    /// it.
    #[test]
    fn passes_through_ssh_auth_sock_allowlist_hit() {
        let _guard = ENV_MUTEX.lock().unwrap_or_else(|p| p.into_inner());
        let key = "SSH_AUTH_SOCK";
        let prior = std::env::var(key).ok();
        std::env::set_var(key, "/tmp/ssh-agent.sock");

        let mut cmd = tokio::process::Command::new("true");
        apply_env_allowlist(&mut cmd, &[]);

        match prior {
            Some(v) => std::env::set_var(key, v),
            None => std::env::remove_var(key),
        }

        let envs: std::collections::HashMap<String, String> = cmd
            .as_std()
            .get_envs()
            .filter_map(|(k, v)| {
                Some((
                    k.to_string_lossy().to_string(),
                    v?.to_string_lossy().to_string(),
                ))
            })
            .collect();
        assert_eq!(
            envs.get(key).map(String::as_str),
            Some("/tmp/ssh-agent.sock"),
            "SSH_AUTH_SOCK must pass through so shelled-out git-over-SSH can reach the agent"
        );
    }

    /// XDG base-directory override — Unix-only category (`XDG_ENV_ALLOWLIST`
    /// is empty on Windows, which has no XDG convention).
    #[cfg(not(windows))]
    #[test]
    fn passes_through_xdg_config_home_allowlist_hit() {
        let _guard = ENV_MUTEX.lock().unwrap_or_else(|p| p.into_inner());
        let key = "XDG_CONFIG_HOME";
        let prior = std::env::var(key).ok();
        std::env::set_var(key, "/tmp/xdg-config-override");

        let mut cmd = tokio::process::Command::new("true");
        apply_env_allowlist(&mut cmd, &[]);

        match prior {
            Some(v) => std::env::set_var(key, v),
            None => std::env::remove_var(key),
        }

        let envs: std::collections::HashMap<String, String> = cmd
            .as_std()
            .get_envs()
            .filter_map(|(k, v)| {
                Some((
                    k.to_string_lossy().to_string(),
                    v?.to_string_lossy().to_string(),
                ))
            })
            .collect();
        assert_eq!(
            envs.get(key).map(String::as_str),
            Some("/tmp/xdg-config-override"),
            "XDG_CONFIG_HOME must pass through — HOME alone doesn't reproduce an XDG override"
        );
    }

    /// Pins the security boundary this whole allowlist exists for: unrelated
    /// cloud/VCS credentials the user has in their shell for OTHER tools
    /// must never reach an LLM-driven subprocess, regardless of how many
    /// legitimate categories get added to the allowlist over time. If this
    /// ever starts failing, something added a credential-shaped var to the
    /// allowlist by mistake.
    #[test]
    fn drops_credential_shaped_canary_vars_even_with_extra_passthrough() {
        let _guard = ENV_MUTEX.lock().unwrap_or_else(|p| p.into_inner());
        let canaries = ["AWS_SECRET_ACCESS_KEY", "GITHUB_TOKEN", "GH_TOKEN"];
        for key in canaries {
            std::env::set_var(key, "leak-me");
        }

        let mut cmd = tokio::process::Command::new("true");
        // Even with an unrelated extra_passthrough entry, the canaries
        // themselves are never in any list, so they must still be dropped.
        apply_env_allowlist(&mut cmd, &["ANTHROPIC_API_KEY"]);

        let keys = env_keys(&cmd);
        for key in canaries {
            std::env::remove_var(key);
        }
        for key in canaries {
            assert!(
                !keys.contains(key),
                "credential-shaped canary '{key}' must never pass through the allowlist"
            );
        }
    }

    #[test]
    fn extra_passthrough_is_additive_to_base_allowlist() {
        let _guard = ENV_MUTEX.lock().unwrap_or_else(|p| p.into_inner());
        let key = "LLM_WIKI_TEST_PROVIDER_KEY";
        std::env::set_var(key, "provider-secret");

        let mut cmd = tokio::process::Command::new("true");
        apply_env_allowlist(&mut cmd, &[key]);

        let keys = env_keys(&cmd);
        std::env::remove_var(key);
        assert!(
            keys.contains(key),
            "extra_passthrough entries must pass through alongside the base allowlist"
        );
    }

    /// Provider env (allowlist) must be applied before the caller's own PATH
    /// override, so a later explicit `.env("PATH", ..)` call always wins —
    /// `env_clear` only needs to run once, up front.
    #[test]
    fn allowlist_then_path_override_preserves_explicit_path() {
        let _guard = ENV_MUTEX.lock().unwrap_or_else(|p| p.into_inner());
        let mut cmd = tokio::process::Command::new("true");
        apply_env_allowlist(&mut cmd, &[]);
        cmd.env("PATH", "/custom/bin");

        let envs: std::collections::HashMap<String, String> = cmd
            .as_std()
            .get_envs()
            .filter_map(|(k, v)| {
                Some((
                    k.to_string_lossy().to_string(),
                    v?.to_string_lossy().to_string(),
                ))
            })
            .collect();
        assert_eq!(envs.get("PATH").map(String::as_str), Some("/custom/bin"));
    }

    #[test]
    fn child_path_env_override_targets_path() {
        assert_eq!(
            child_path_env_override(Some("/opt/homebrew/bin:/usr/bin".to_string())),
            ("PATH", "/opt/homebrew/bin:/usr/bin".to_string())
        );
    }

    /// Regression (PR6b gate P1): `child_path_env()` returns `None` on
    /// Windows always, and on non-Windows whenever the login-shell PATH
    /// probe times out. Post-`apply_env_allowlist` (which `env_clear`s and
    /// deliberately excludes PATH from its allowlist), that `None` MUST
    /// fall back to the ambient PATH rather than leaving the child with no
    /// PATH at all — this is the shared helper `claude_cli.rs` and
    /// `codex_cli.rs` both call for their PATH override.
    #[test]
    fn child_path_env_override_falls_back_to_ambient_path_when_none() {
        let ambient = std::env::var("PATH").unwrap_or_default();
        assert_eq!(child_path_env_override(None), ("PATH", ambient));
    }
}

#[cfg(all(test, not(windows)))]
mod tests {
    use super::{merge_child_path_env, parse_shell_path_output};

    #[test]
    fn parse_shell_path_output_ignores_banners() {
        let output = "Welcome\n\x1ePATH=/opt/homebrew/bin:/usr/bin\x1e\nGoodbye\n";
        assert_eq!(
            parse_shell_path_output(output).as_deref(),
            Some("/opt/homebrew/bin:/usr/bin")
        );
    }

    #[test]
    fn parse_shell_path_output_rejects_missing_or_empty_markers() {
        assert_eq!(parse_shell_path_output("PATH=/usr/bin"), None);
        assert_eq!(parse_shell_path_output("\x1ePATH=\x1e"), None);
        assert_eq!(parse_shell_path_output("\x1eOTHER=/usr/bin\x1e"), None);
    }

    #[test]
    fn merge_child_path_env_prepends_shell_path_when_inherited_path_exists() {
        assert_eq!(
            merge_child_path_env("/opt/homebrew/bin:/usr/local/bin", Some("/usr/bin:/bin")),
            "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin",
        );
    }

    #[test]
    fn merge_child_path_env_uses_shell_path_when_inherited_path_is_empty() {
        assert_eq!(
            merge_child_path_env("/opt/homebrew/bin", Some("")),
            "/opt/homebrew/bin"
        );
        assert_eq!(
            merge_child_path_env("/opt/homebrew/bin", None),
            "/opt/homebrew/bin"
        );
    }
}

#[cfg(all(test, unix))]
mod process_group_tests {
    use super::{
        graceful_kill_process_group, kill_all_tracked_children, kill_process_group, KillSignal,
        GRACEFUL_KILL_GRACE_PERIOD,
    };
    use std::collections::HashMap;
    use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
    use tokio::process::Command;

    fn unique_marker_path(label: &str) -> std::path::PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock before Unix epoch")
            .as_nanos();
        std::env::temp_dir().join(format!(
            "llm-wiki-pgkill-{label}-{}-{nanos}",
            std::process::id()
        ))
    }

    /// Spawns a shell "leader" that backgrounds a `sleep 30` grandchild
    /// and writes the grandchild's own pid to `marker_path` before
    /// waiting on it. A non-interactive `sh -c` has job control off, so
    /// the backgrounded job stays in the leader's process group rather
    /// than getting its own — exactly the shape `claude`/`codex`/the
    /// agent sidecar produce when they fork tool subprocesses.
    fn spawn_leader_with_group_grandchild(marker_path: &std::path::Path) -> tokio::process::Child {
        let script = format!(
            "sleep 30 & echo $! > {}; wait",
            marker_path.to_string_lossy()
        );
        let mut cmd = Command::new("sh");
        cmd.arg("-c").arg(script);
        cmd.stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .kill_on_drop(true);
        cmd.process_group(0);
        cmd.spawn().expect("spawn process-group test leader")
    }

    async fn read_grandchild_pid(marker_path: &std::path::Path, timeout: Duration) -> i32 {
        let deadline = Instant::now() + timeout;
        loop {
            if let Ok(contents) = std::fs::read_to_string(marker_path) {
                if let Ok(pid) = contents.trim().parse::<i32>() {
                    return pid;
                }
            }
            assert!(
                Instant::now() < deadline,
                "grandchild pid marker file never appeared"
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }

    fn pid_is_alive(pid: i32) -> bool {
        unsafe { libc::kill(pid, 0) == 0 }
    }

    /// Orphan regression: killing only the direct child (as
    /// `Child::start_kill` does) would leave the backgrounded `sleep`
    /// grandchild running. `kill_process_group` must reach it too.
    #[tokio::test]
    async fn kill_process_group_kills_group_leader_and_descendant() {
        let marker_path = unique_marker_path("descendant");
        let _ = std::fs::remove_file(&marker_path);
        let mut child = spawn_leader_with_group_grandchild(&marker_path);
        let grandchild_pid = read_grandchild_pid(&marker_path, Duration::from_secs(2)).await;
        assert!(
            pid_is_alive(grandchild_pid),
            "grandchild should be alive before kill"
        );

        kill_process_group(&mut child, KillSignal::Kill).expect("kill process group");
        let _ = child.wait().await;
        tokio::time::sleep(Duration::from_millis(200)).await;

        assert!(
            !pid_is_alive(grandchild_pid),
            "grandchild `sleep` survived a process-group SIGKILL"
        );
        let _ = std::fs::remove_file(&marker_path);
    }

    /// A group whose leader already exited (no OS pid) must not error —
    /// ESRCH / start_kill-on-dead-child are both treated as success.
    #[tokio::test]
    async fn kill_process_group_is_a_no_op_success_for_already_exited_child() {
        let mut cmd = Command::new("sh");
        cmd.arg("-c")
            .arg("exit 0")
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .kill_on_drop(true);
        cmd.process_group(0);
        let mut child = cmd.spawn().expect("spawn quick-exit child");
        let _ = child.wait().await;

        assert!(kill_process_group(&mut child, KillSignal::Kill).is_ok());
    }

    /// Timeout fallback: a child that ignores SIGTERM must still be
    /// reaped (via escalation to SIGKILL) rather than hanging forever.
    #[tokio::test]
    async fn graceful_kill_process_group_escalates_to_sigkill_when_sigterm_is_ignored() {
        let marker_path = unique_marker_path("ignores-sigterm-ready");
        let _ = std::fs::remove_file(&marker_path);
        let mut cmd = Command::new("sh");
        cmd.arg("-c")
            // `exec` (rather than a plain trailing `sleep 30`) matters: a
            // POSIX-ignored (SIG_IGN) signal disposition is guaranteed to
            // survive exec, but relying on the shell's own optional
            // "replace myself for the last command" tail-call
            // optimization is not — some shells skip that optimization
            // once a trap has been set, in which case `sleep` would run
            // as a plain forked child with SIGTERM reset to its default
            // (terminate) disposition and die immediately, defeating the
            // point of this test. The marker file (written only after
            // `trap` has actually run) avoids a startup race where the
            // test would signal the child before it installed the trap.
            .arg(format!(
                "trap '' TERM; touch {}; exec sleep 30",
                marker_path.to_string_lossy()
            ))
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .kill_on_drop(true);
        cmd.process_group(0);
        let mut child = cmd.spawn().expect("spawn sigterm-ignoring child");

        let ready_deadline = Instant::now() + Duration::from_secs(2);
        while !marker_path.exists() {
            assert!(
                Instant::now() < ready_deadline,
                "child never installed its SIGTERM trap"
            );
            tokio::time::sleep(Duration::from_millis(10)).await;
        }

        let start = Instant::now();
        graceful_kill_process_group(&mut child, Duration::from_millis(300)).await;
        let elapsed = start.elapsed();

        let status = tokio::time::timeout(Duration::from_secs(2), child.wait())
            .await
            .expect("child did not exit after SIGKILL escalation")
            .expect("wait succeeded");
        assert!(!status.success());
        assert!(
            elapsed >= Duration::from_millis(300),
            "escalation must not fire before the grace period elapses"
        );
        let _ = std::fs::remove_file(&marker_path);
    }

    /// A well-behaved child should exit on SIGTERM alone and not force
    /// the caller to wait out the entire grace period.
    #[tokio::test]
    async fn graceful_kill_process_group_returns_promptly_when_sigterm_is_honored() {
        let mut cmd = Command::new("sh");
        cmd.arg("-c")
            .arg("sleep 30")
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .kill_on_drop(true);
        cmd.process_group(0);
        let mut child = cmd.spawn().expect("spawn default-sigterm child");

        let start = Instant::now();
        graceful_kill_process_group(&mut child, Duration::from_secs(2)).await;
        let elapsed = start.elapsed();

        assert!(
            elapsed < Duration::from_secs(1),
            "should not wait out the full grace period when SIGTERM is honored promptly"
        );
        let _ = child.wait().await;
    }

    /// Correctness regression: a leader that exits on its own (`try_wait`
    /// observes `Ok(Some(_))`) used to make `graceful_kill_process_group`
    /// `return` immediately, never sending the group SIGKILL at all. A
    /// descendant forked before the leader exited — here, a nested `sh`
    /// that ignores SIGTERM and `exec`s into `sleep` — stays in the same
    /// pgid and must still be reached once the leader is gone.
    #[tokio::test]
    async fn graceful_kill_process_group_reaches_descendant_after_leader_exits_early() {
        let marker_path = unique_marker_path("leader-exits-descendant-pid");
        let ready_path = unique_marker_path("leader-exits-descendant-ready");
        let _ = std::fs::remove_file(&marker_path);
        let _ = std::fs::remove_file(&ready_path);
        let script = format!(
            "sh -c 'trap \"\" TERM; touch {}; exec sleep 30' & echo $! > {}; exit 0",
            ready_path.to_string_lossy(),
            marker_path.to_string_lossy(),
        );
        let mut cmd = Command::new("sh");
        cmd.arg("-c")
            .arg(script)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .kill_on_drop(true);
        cmd.process_group(0);
        let mut child = cmd
            .spawn()
            .expect("spawn leader that exits early, leaving a group descendant");

        let descendant_pid = read_grandchild_pid(&marker_path, Duration::from_secs(2)).await;

        let ready_deadline = Instant::now() + Duration::from_secs(2);
        while !ready_path.exists() {
            assert!(
                Instant::now() < ready_deadline,
                "descendant never installed its SIGTERM trap"
            );
            tokio::time::sleep(Duration::from_millis(10)).await;
        }

        // Give the leader shell time to exit on its own (it has nothing
        // left to do but `exit 0` right after backgrounding the
        // descendant) *without* this test polling `try_wait` itself —
        // doing so would reap the child here and invalidate `Child::id()`
        // before `graceful_kill_process_group` gets a chance to capture
        // it, which would defeat the very race this test exists to catch.
        // `graceful_kill_process_group`'s own first `try_wait` call is
        // what must observe the already-exited leader.
        tokio::time::sleep(Duration::from_millis(150)).await;
        assert!(
            pid_is_alive(descendant_pid),
            "descendant should still be alive while the leader has exited but the group hasn't been killed yet"
        );

        graceful_kill_process_group(&mut child, Duration::from_millis(300)).await;
        tokio::time::sleep(Duration::from_millis(200)).await;

        assert!(
            !pid_is_alive(descendant_pid),
            "descendant survived graceful_kill_process_group after its leader had already exited"
        );
        let _ = std::fs::remove_file(&marker_path);
        let _ = std::fs::remove_file(&ready_path);
    }

    /// Concurrency regression reproducing the correctness probe: multiple
    /// wedged children (leader ignores SIGTERM, each with its own
    /// backgrounded descendant that also ignores SIGTERM) must all be
    /// cleaned up within ~one grace period, not one grace period *per*
    /// child — and none of their descendants may be left as orphans.
    #[tokio::test]
    async fn kill_all_tracked_children_kills_multiple_wedged_leaders_concurrently_without_orphans()
    {
        const WEDGED_CHILD_COUNT: usize = 3;
        let children: tokio::sync::Mutex<HashMap<String, tokio::process::Child>> =
            tokio::sync::Mutex::new(HashMap::new());
        let mut descendant_pids = Vec::with_capacity(WEDGED_CHILD_COUNT);
        let mut marker_paths = Vec::with_capacity(WEDGED_CHILD_COUNT);

        for i in 0..WEDGED_CHILD_COUNT {
            let marker_path = unique_marker_path(&format!("kill-all-wedged-{i}"));
            let _ = std::fs::remove_file(&marker_path);
            let script = format!(
                "trap '' TERM; sh -c 'trap \"\" TERM; exec sleep 30' & echo $! > {}; wait",
                marker_path.to_string_lossy()
            );
            let mut cmd = Command::new("sh");
            cmd.arg("-c")
                .arg(script)
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .kill_on_drop(true);
            cmd.process_group(0);
            let child = cmd.spawn().expect("spawn wedged leader");

            let descendant_pid = read_grandchild_pid(&marker_path, Duration::from_secs(2)).await;
            assert!(
                pid_is_alive(descendant_pid),
                "descendant {i} should be alive before kill_all_tracked_children"
            );
            descendant_pids.push(descendant_pid);
            marker_paths.push(marker_path);

            children.lock().await.insert(format!("stream-{i}"), child);
        }

        let start = Instant::now();
        kill_all_tracked_children(&children).await;
        let elapsed = start.elapsed();

        assert!(
            children.lock().await.is_empty(),
            "kill_all_tracked_children must drain every tracked child"
        );
        assert!(
            elapsed < GRACEFUL_KILL_GRACE_PERIOD + Duration::from_secs(1),
            "kill_all_tracked_children took {elapsed:?} for {WEDGED_CHILD_COUNT} wedged children \
             — should bound to ~O(grace period) via concurrent kill, not serialize per child"
        );

        tokio::time::sleep(Duration::from_millis(200)).await;
        for (i, pid) in descendant_pids.into_iter().enumerate() {
            assert!(
                !pid_is_alive(pid),
                "descendant {i} (pid {pid}) survived concurrent kill_all_tracked_children"
            );
        }
        for marker_path in marker_paths {
            let _ = std::fs::remove_file(&marker_path);
        }
    }
}
