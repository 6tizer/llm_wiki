use std::collections::HashMap;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

const LOGIN_SHELL_PATH_TIMEOUT: Duration = Duration::from_secs(3);
const PATH_MARKER: char = '\x1e';

static RESOLVED_COMMANDS: OnceLock<Mutex<HashMap<String, PathBuf>>> = OnceLock::new();

#[cfg(not(windows))]
static RESOLVED_SHELL_PATH: OnceLock<Option<String>> = OnceLock::new();

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
        graceful_kill_process_group, kill_all_tracked_children, kill_process_group,
        GRACEFUL_KILL_GRACE_PERIOD, KillSignal,
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
        assert!(pid_is_alive(grandchild_pid), "grandchild should be alive before kill");

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
    async fn kill_all_tracked_children_kills_multiple_wedged_leaders_concurrently_without_orphans(
    ) {
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

            children
                .lock()
                .await
                .insert(format!("stream-{i}"), child);
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
