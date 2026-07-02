//! Project-root path sandboxing for filesystem commands.
//!
//! The webview-facing fs commands (`write_file`, `delete_file`, `read_file`,
//! ...) take a raw path string. Without validation, a prompt-injected LLM
//! (or any webview code path) could read `~/.ssh/id_rsa` or write to
//! `~/.bashrc` by passing an absolute or `..`-escaping path.
//!
//! This module ports `api_server.rs::safe_join` into a reusable helper that
//! the fs command layer calls. The project root is obtained from
//! `FileSyncState` (set when the project file watcher starts).
//!
//! Policy when the project root is unknown (watcher not started):
//!   - read commands: allow (degrade to legacy behavior — the app may need to
//!     read before the watcher starts, e.g. during project open)
//!   - write/delete commands: deny (fail-closed — never write without a known
//!     sandbox root)

use std::path::{Component, Path, PathBuf};

/// Validate that `target` resolves to a path inside `project_root`.
///
/// Mirrors `api_server.rs::safe_join`: strips leading `/`, rejects absolute
/// paths and `..`/`Prefix`/`RootDir` components, then canonicalizes both root
/// and target (or target's parent for not-yet-existing paths) and checks
/// `starts_with`.
///
/// `target` may be absolute (must start with or be under `project_root`) or
/// relative (joined against `project_root`).
pub fn validate_within_project(project_root: &Path, target: &str) -> Result<PathBuf, String> {
    let target_path = Path::new(target);

    // If the target is absolute, it must already be inside the project root.
    // If relative, join it against the root.
    let joined = if target_path.is_absolute() {
        // Reject `..` traversal components in absolute paths too. RootDir and
        // Prefix (Windows drive/UNC) are structurally required for any absolute
        // path and are validated by the canonicalize + starts_with(root) check
        // below, so they are not rejected here.
        for component in target_path.components() {
            if matches!(component, Component::ParentDir) {
                return Err(format!("Path traversal is not allowed: '{target}'"));
            }
        }
        target_path.to_path_buf()
    } else {
        let rel = target.trim_start_matches('/');
        let rel_path = Path::new(rel);
        // Reject traversal components in relative paths before joining.
        for component in rel_path.components() {
            if matches!(
                component,
                Component::ParentDir | Component::Prefix(_) | Component::RootDir
            ) {
                return Err(format!(
                    "Path traversal is not allowed: '{target}'"
                ));
            }
        }
        project_root.join(rel_path)
    };

    // Canonicalize the root. If the root itself can't be resolved, we can't
    // safely validate anything.
    let root_canon = project_root.canonicalize().map_err(|e| {
        format!(
            "Failed to resolve project root '{}': {e}",
            project_root.display()
        )
    })?;

    if joined.exists() {
        let joined_canon = joined
            .canonicalize()
            .map_err(|e| format!("Failed to resolve path '{}': {e}", joined.display()))?;
        if !joined_canon.starts_with(&root_canon) {
            return Err(format!(
                "Resolved path '{}' escapes the project directory '{}'",
                joined_canon.display(),
                root_canon.display()
            ));
        }
        Ok(joined_canon)
    } else {
        // For not-yet-existing paths (e.g. a file about to be written),
        // walk up to the nearest existing ancestor and verify IT is inside
        // the root. Checking only the immediate parent let an absolute path
        // whose parent dirs also don't exist escape the sandbox (S1).
        let mut ancestor = joined.parent();
        loop {
            match ancestor {
                None => {
                    return Err(format!(
                        "Cannot resolve any existing ancestor of '{}'",
                        joined.display()
                    ));
                }
                Some(p) if p.exists() => {
                    let ancestor_canon = p.canonicalize().map_err(|e| {
                        format!("Failed to resolve ancestor '{}': {e}", p.display())
                    })?;
                    if !ancestor_canon.starts_with(&root_canon) {
                        return Err(format!(
                            "Resolved ancestor '{}' escapes the project directory '{}'",
                            ancestor_canon.display(),
                            root_canon.display()
                        ));
                    }
                    break;
                }
                Some(p) => ancestor = p.parent(),
            }
        }
        // Return the (non-canonical) joined path: its existing-ancestor prefix
        // has been canonicalized and confirmed inside the root, and the
        // non-existing tail contains no `..`/absolute escape. Callers use this
        // for I/O only — do NOT string-compare it against root without
        // re-canonicalizing, since the tail is not yet resolved.
        Ok(joined)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::env;

    // Unique per-call counter so parallel tests don't share the same temp dir
    // (which caused flaky canonicalize/remove_dir_all races — P1-A).
    static TEST_COUNTER: AtomicU64 = AtomicU64::new(0);

    fn tmp_root() -> PathBuf {
        let id = TEST_COUNTER.fetch_add(1, Ordering::SeqCst);
        let dir = env::temp_dir().join(format!(
            "llm-wiki-path-safety-test-{}-{}",
            std::process::id(),
            id
        ));
        std::fs::create_dir_all(&dir).ok();
        dir
    }

    #[test]
    fn relative_path_inside_root_is_allowed() {
        let root = tmp_root();
        let result = validate_within_project(&root, "wiki/concepts/foo.md");
        assert!(result.is_ok(), "relative wiki path should be allowed");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn absolute_path_inside_root_is_allowed() {
        let root = tmp_root();
        std::fs::create_dir_all(root.join("wiki")).ok();
        let abs = root.join("wiki/index.md");
        std::fs::write(&abs, "test").ok();
        // Canonicalize root first — on macOS /tmp symlinks to /private/tmp, so
        // comparing a non-canonical root against a canonicalized abs path fails.
        let root_canon = root.canonicalize().unwrap();
        let result = validate_within_project(&root_canon, abs.to_str().unwrap());
        assert!(result.is_ok(), "absolute path inside root should be allowed");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn parent_dir_traversal_is_rejected() {
        let root = tmp_root();
        let result = validate_within_project(&root, "../../../etc/passwd");
        assert!(result.is_err(), ".. traversal should be rejected");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn absolute_path_outside_root_is_rejected() {
        let root = tmp_root();
        // /etc/passwd is absolute and outside the temp root
        let result = validate_within_project(&root, "/etc/passwd");
        assert!(result.is_err(), "absolute path outside root should be rejected");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn nested_traversal_is_rejected() {
        let root = tmp_root();
        let result = validate_within_project(&root, "wiki/../../etc/passwd");
        assert!(result.is_err(), "nested .. traversal should be rejected");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn absolute_path_with_multilevel_missing_parent_outside_root_is_rejected() {
        let root = tmp_root();
        let id = TEST_COUNTER.fetch_add(1, Ordering::SeqCst);
        // The middle directories (missingA/missingB) are intentionally never
        // created, so the immediate-parent-only check (pre-fix) would fall
        // through and return Ok even though this path is outside `root`.
        let target = env::temp_dir().join(format!(
            "llm-wiki-escape-{}-{}/missingA/missingB/evil.md",
            std::process::id(),
            id
        ));
        let result = validate_within_project(&root, target.to_str().unwrap());
        assert!(
            result.is_err(),
            "absolute path outside root with multi-level missing parent should be rejected"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn relative_path_with_multilevel_missing_parent_inside_root_is_allowed() {
        let root = tmp_root();
        // Canonicalize root first — on macOS /tmp symlinks to /private/tmp, so
        // comparing a non-canonical root against a canonicalized ancestor fails.
        let root_canon = root.canonicalize().unwrap();
        let result = validate_within_project(&root_canon, "newdir/newsub/file.md");
        assert!(
            result.is_ok(),
            "relative path with missing intermediate dirs inside root should be allowed"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn absolute_path_with_dotdot_component_is_rejected() {
        let root = tmp_root();
        let target = format!("{}/../../../etc/passwd", root.display());
        let result = validate_within_project(&root, &target);
        assert!(
            result.is_err(),
            "absolute path with '..' component should be rejected"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[cfg(unix)]
    #[test]
    fn symlinked_ancestor_pointing_outside_root_is_rejected() {
        use std::os::unix::fs::symlink;
        let root = tmp_root();
        let root_canon = root.canonicalize().unwrap();
        // Create a real dir outside root, and a symlink inside root pointing to it.
        let outside = tmp_root(); // separate temp dir, outside `root`
        let link = root_canon.join("escape_link");
        let _ = std::fs::remove_file(&link);
        symlink(&outside, &link).unwrap();
        // A path under the symlink resolves outside root once canonicalized.
        let target = link.join("evil.md");
        let result = validate_within_project(&root_canon, target.to_str().unwrap());
        assert!(result.is_err(), "path under a symlink escaping root must be rejected");
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&outside);
    }
}
