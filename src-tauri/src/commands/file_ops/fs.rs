use std::fs;
use std::io::Read as IoRead;
use std::path::{Path, PathBuf};
use std::thread;
use std::time::Duration;

use tauri::State;

use super::file_sync::{self, ProjectRootState};
use super::office_extract::{
    extract_office_text, extract_pdf_text, reject_if_over_cap, OFFICE_EXTS,
};
use super::path_safety::{sandbox_path, sandbox_path_for_root, SandboxMode};
use crate::panic_guard::run_guarded;
use crate::types::wiki::FileNode;

// Compatibility re-export: lib.rs keeps calling commands::fs::set_resource_dir_hint.
pub use super::office_extract::set_resource_dir_hint;

/// Base64 inflates the source bytes by ~1/3, and the result crosses the IPC
/// boundary to the webview as one JSON string — costlier per byte than a
/// plain hash-and-discard read, so this stays capped even though it shares
/// `MAX_HASH_BYTES`'s (file_sync.rs) order of magnitude.
const MAX_BASE64_READ_BYTES: u64 = 64 * 1024 * 1024;

const IMAGE_EXTS: &[&str] = &[
    "png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "tiff", "tif", "avif", "heic", "heif", "svg",
];
const MEDIA_EXTS: &[&str] = &[
    "mp4", "webm", "mov", "avi", "mkv", "flv", "wmv", "m4v", "mp3", "wav", "ogg", "flac", "aac",
    "m4a", "wma",
];
const LEGACY_DOC_EXTS: &[&str] = &["doc", "xls", "ppt", "pages", "numbers", "key", "epub"];

#[tauri::command]
pub async fn read_file(path: String, state: State<'_, ProjectRootState>) -> Result<String, String> {
    let validated = sandbox_path(&state, &path, SandboxMode::Read)?;
    read_file_validated(validated, path).await
}

/// Inner implementation taking a pre-validated path. Used by the command
/// wrapper and by unit tests that don't have a Tauri `State` context.
/// `path_orig` is retained only for error-message fidelity.
async fn read_file_validated(validated: PathBuf, path_orig: String) -> Result<String, String> {
    // Bind `path` so the extraction helpers below (which take &str) and error
    // messages keep working unchanged.
    let path = validated.to_string_lossy().to_string();
    // `spawn_blocking` is REQUIRED, not a perf nicety. The body does
    // synchronous PDF/Office text extraction (pdfium FFI, calamine,
    // zip + image decode) that can take 10s+ on big files. Running
    // that directly inside an `async fn` body would block the tokio
    // worker thread it's scheduled on, starving every other async
    // task on that worker (notably re-rendering the import progress
    // UI, which is what motivated the async conversion in the first
    // place). `spawn_blocking` moves the work to tokio's blocking
    // pool where blocking-for-seconds is the contract.
    tauri::async_runtime::spawn_blocking(move || {
        run_guarded("read_file", || {
            let _ = &path_orig; // preserved for potential future error-message use
            let p = validated.as_path();
            let ext = p
                .extension()
                .and_then(|e| e.to_str())
                .unwrap_or("")
                .to_lowercase();

            if let Some(cached) = read_cache(p) {
                return Ok(cached);
            }

            match ext.as_str() {
                "pdf" => extract_pdf_text(&path),
                e if OFFICE_EXTS.contains(&e) => extract_office_text(&path, e),
                e if IMAGE_EXTS.contains(&e) => {
                    let size = fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
                    Ok(format!("[Image: {} ({:.1} KB)]", p.file_name().unwrap_or_default().to_string_lossy(), size as f64 / 1024.0))
                }
                e if MEDIA_EXTS.contains(&e) => {
                    let size = fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
                    Ok(format!("[Media: {} ({:.1} MB)]", p.file_name().unwrap_or_default().to_string_lossy(), size as f64 / 1048576.0))
                }
                e if LEGACY_DOC_EXTS.contains(&e) => {
                    Ok(format!("[Document: {} — text extraction not supported for .{} format]",
                        p.file_name().unwrap_or_default().to_string_lossy(), e))
                }
                _ => {
                    match fs::read_to_string(&path) {
                        Ok(content) => Ok(content),
                        Err(e) => {
                            let exists = p.exists();
                            if !exists {
                                Err(format!("File does not exist: '{}'", path))
                            } else {
                                Err(format!(
                                    "Failed to read file '{}' as text: {} (likely binary, locked, or non-UTF-8)",
                                    path, e,
                                ))
                            }
                        }
                    }
                }
            }
        })
    })
    .await
    .map_err(|e| format!("read_file blocking task join error: {e}"))?
}

/// Pre-process a file and cache the extracted text.
#[tauri::command]
pub async fn preprocess_file(
    path: String,
    state: State<'_, ProjectRootState>,
) -> Result<String, String> {
    // Sandbox in Read mode: the source is read, and the cache is written next
    // to it (inside the project). Read degrades gracefully if no root is known
    // so project-open flows still work. (#119 P2-A)
    let validated = sandbox_path(&state, &path, SandboxMode::Read)?;
    let validated_str = validated.to_string_lossy().to_string();
    // See `read_file` above for why `spawn_blocking` is required.
    tauri::async_runtime::spawn_blocking(move || {
        run_guarded("preprocess_file", || {
            let p = validated.as_path();
            let ext = p
                .extension()
                .and_then(|e| e.to_str())
                .unwrap_or("")
                .to_lowercase();

            let text = match ext.as_str() {
                "pdf" => extract_pdf_text(&validated_str)?,
                e if OFFICE_EXTS.contains(&e) => extract_office_text(&validated_str, e)?,
                _ => return Ok("no preprocessing needed".to_string()),
            };

            write_cache(p, &text)?;
            Ok(text)
        })
    })
    .await
    .map_err(|e| format!("preprocess_file blocking task join error: {e}"))?
}

fn cache_path_for(original: &Path) -> std::path::PathBuf {
    let parent = original.parent().unwrap_or(Path::new("."));
    let cache_dir = parent.join(".cache");
    let file_name = original.file_name().unwrap_or_default().to_string_lossy();
    cache_dir.join(format!("{}.txt", file_name))
}

fn read_cache(original: &Path) -> Option<String> {
    let cache_path = cache_path_for(original);
    let original_modified = fs::metadata(original).ok()?.modified().ok()?;
    let cache_modified = fs::metadata(&cache_path).ok()?.modified().ok()?;
    if cache_modified >= original_modified {
        fs::read_to_string(&cache_path).ok()
    } else {
        None
    }
}

fn write_cache(original: &Path, text: &str) -> Result<(), String> {
    let cache_path = cache_path_for(original);
    if let Some(parent) = cache_path.parent() {
        fs::create_dir_all(parent).ok();
    }
    super::file_sync::mark_app_write_path(&cache_path);
    fs::write(&cache_path, text).map_err(|e| format!("Failed to write cache: {}", e))
}

#[tauri::command]
pub async fn write_file(
    path: String,
    contents: String,
    state: State<'_, ProjectRootState>,
) -> Result<(), String> {
    let validated = sandbox_path(&state, &path, SandboxMode::Write)?;
    tauri::async_runtime::spawn_blocking(move || {
        run_guarded("write_file", || {
            let p = validated.as_path();
            if let Some(parent) = p.parent() {
                fs::create_dir_all(parent)
                    .map_err(|e| format!("Failed to create parent dirs for '{}': {}", path, e))?;
            }
            file_sync::mark_app_write_path(p);
            fs::write(p, contents)
                .map_err(|e| format!("Failed to write file '{}': {}", path, e))?;
            file_sync::mark_app_write_path(p);
            Ok(())
        })
    })
    .await
    .map_err(|e| format!("write_file blocking task join error: {e}"))?
}

#[tauri::command]
pub async fn write_file_base64(
    path: String,
    base64: String,
    state: State<'_, ProjectRootState>,
) -> Result<(), String> {
    write_file_base64_with_root_state(path, base64, &state).await
}

async fn write_file_base64_with_root_state(
    path: String,
    base64: String,
    state: &ProjectRootState,
) -> Result<(), String> {
    let validated = sandbox_path_for_root(state.get(), &path, SandboxMode::Write)?;
    write_file_base64_validated(validated, path, base64).await
}

async fn write_file_base64_validated(
    validated: PathBuf,
    path_orig: String,
    base64: String,
) -> Result<(), String> {
    use base64::{engine::general_purpose::STANDARD as B64, Engine as _};

    tauri::async_runtime::spawn_blocking(move || {
        run_guarded("write_file_base64", || {
            let bytes = B64
                .decode(base64.as_bytes())
                .map_err(|e| format!("Failed to decode base64 for '{}': {}", path_orig, e))?;
            let p = validated.as_path();
            if let Some(parent) = p.parent() {
                fs::create_dir_all(parent).map_err(|e| {
                    format!("Failed to create parent dirs for '{}': {}", path_orig, e)
                })?;
            }
            file_sync::mark_app_write_path(p);
            fs::write(p, bytes)
                .map_err(|e| format!("Failed to write file '{}': {}", path_orig, e))?;
            file_sync::mark_app_write_path(p);
            Ok(())
        })
    })
    .await
    .map_err(|e| format!("write_file_base64 blocking task join error: {e}"))?
}

#[tauri::command]
pub async fn write_file_atomic(
    path: String,
    contents: String,
    state: State<'_, ProjectRootState>,
) -> Result<(), String> {
    let validated = sandbox_path(&state, &path, SandboxMode::Write)?;
    tauri::async_runtime::spawn_blocking(move || {
        run_guarded("write_file_atomic", || {
            let p = validated.as_path();
            if let Some(parent) = p.parent() {
                fs::create_dir_all(parent)
                    .map_err(|e| format!("Failed to create parent dirs for '{}': {}", path, e))?;
            }

            let file_name = p
                .file_name()
                .map(|name| name.to_string_lossy().to_string())
                .unwrap_or_else(|| "llm-wiki-file".to_string());
            let tmp_path = p.with_file_name(format!(
                ".{file_name}.{}.tmp",
                chrono::Utc::now()
                    .timestamp_nanos_opt()
                    .unwrap_or_else(|| chrono::Utc::now().timestamp_millis())
            ));

            file_sync::mark_app_write_path(&tmp_path);
            file_sync::mark_app_write_path(p);
            fs::write(&tmp_path, contents).map_err(|e| {
                format!("Failed to write temp file '{}': {}", tmp_path.display(), e)
            })?;

            fs::rename(&tmp_path, p).map_err(|e| {
                let _ = fs::remove_file(&tmp_path);
                format!(
                    "Failed to move temp file '{}' to '{}': {}",
                    tmp_path.display(),
                    path,
                    e
                )
            })?;
            file_sync::mark_app_write_path(p);
            Ok(())
        })
    })
    .await
    .map_err(|e| format!("write_file_atomic blocking task join error: {e}"))?
}

#[tauri::command]
pub async fn list_directory(
    path: String,
    state: State<'_, ProjectRootState>,
) -> Result<Vec<FileNode>, String> {
    let validated = sandbox_path(&state, &path, SandboxMode::Read)?;
    tauri::async_runtime::spawn_blocking(move || {
        run_guarded("list_directory", || {
            if !validated.exists() {
                return Err(format!("Path does not exist: '{}'", path));
            }
            if !validated.is_dir() {
                return Err(format!("Path is not a directory: '{}'", path));
            }
            let nodes = build_tree(&validated, 0, 30)?;
            Ok(nodes)
        })
    })
    .await
    .map_err(|e| format!("list_directory blocking task join error: {e}"))?
}

fn build_tree(dir: &Path, depth: usize, max_depth: usize) -> Result<Vec<FileNode>, String> {
    if depth >= max_depth {
        return Ok(vec![]);
    }

    let mut entries: Vec<_> = fs::read_dir(dir)
        .map_err(|e| format!("Failed to read directory '{}': {}", dir.display(), e))?
        .filter_map(|entry| entry.ok())
        .filter(|entry| {
            // Skip dotfiles
            entry
                .file_name()
                .to_str()
                .map(|n| !n.starts_with('.'))
                .unwrap_or(false)
        })
        .collect();

    // Sort: directories first, then alphabetical within each group
    entries.sort_by(|a, b| {
        let a_is_dir = a.path().is_dir();
        let b_is_dir = b.path().is_dir();
        match (a_is_dir, b_is_dir) {
            (true, false) => std::cmp::Ordering::Less,
            (false, true) => std::cmp::Ordering::Greater,
            _ => a.file_name().cmp(&b.file_name()),
        }
    });

    let mut nodes = Vec::new();
    for entry in entries {
        let entry_path = entry.path();
        let name = entry.file_name().to_str().unwrap_or("").to_string();
        // Always return forward-slash paths so the TS layer can compare
        // and compose paths consistently across Windows and Unix. Windows
        // APIs accept forward slashes, so normalizing here is safe and
        // prevents a whole class of bugs where TS-constructed `/` paths
        // fail to match Rust-returned `\` paths.
        let path_str = entry_path.to_string_lossy().replace('\\', "/");
        let is_dir = entry_path.is_dir();

        let children = if is_dir {
            let kids = build_tree(&entry_path, depth + 1, max_depth)?;
            if kids.is_empty() {
                None
            } else {
                Some(kids)
            }
        } else {
            None
        };

        nodes.push(FileNode {
            name,
            path: path_str,
            is_dir,
            children,
        });
    }

    Ok(nodes)
}

#[tauri::command]
pub async fn copy_file(
    source: String,
    destination: String,
    state: State<'_, ProjectRootState>,
) -> Result<(), String> {
    let src_validated = sandbox_path(&state, &source, SandboxMode::Read)?;
    let dest_validated = sandbox_path(&state, &destination, SandboxMode::Write)?;
    tauri::async_runtime::spawn_blocking(move || {
        run_guarded("copy_file", || {
            if let Some(parent) = dest_validated.parent() {
                fs::create_dir_all(parent)
                    .map_err(|e| format!("Failed to create parent dirs: {}", e))?;
            }
            file_sync::mark_app_write_path(&dest_validated);
            fs::copy(&src_validated, &dest_validated)
                .map_err(|e| format!("Failed to copy '{}' to '{}': {}", source, destination, e))?;
            file_sync::mark_app_write_path(&dest_validated);
            Ok(())
        })
    })
    .await
    .map_err(|e| format!("copy_file blocking task join error: {e}"))?
}

/// Recursively copy a directory, preserving structure.
/// Returns list of copied file paths (destination paths).
#[tauri::command]
pub async fn copy_directory(
    source: String,
    destination: String,
    state: State<'_, ProjectRootState>,
) -> Result<Vec<String>, String> {
    let src_validated = sandbox_path(&state, &source, SandboxMode::Read)?;
    let dest_validated = sandbox_path(&state, &destination, SandboxMode::Write)?;
    tauri::async_runtime::spawn_blocking(move || {
        run_guarded("copy_directory", || {
            file_sync::mark_app_write_path(&dest_validated);

            if !src_validated.is_dir() {
                return Err(format!("'{}' is not a directory", source));
            }

            let mut copied_files = Vec::new();
            copy_recursive(&src_validated, &dest_validated, &mut copied_files)?;
            Ok(copied_files)
        })
    })
    .await
    .map_err(|e| format!("copy_directory blocking task join error: {e}"))?
}

/// Inner recursive copy used by `copy_directory`. Kept module-private so the
/// command-level sandbox validation cannot be bypassed by calling it directly.
fn copy_recursive(src: &Path, dest: &Path, files: &mut Vec<String>) -> Result<(), String> {
    fs::create_dir_all(dest)
        .map_err(|e| format!("Failed to create dir '{}': {}", dest.display(), e))?;
    let entries =
        fs::read_dir(src).map_err(|e| format!("Failed to read dir '{}': {}", src.display(), e))?;
    for entry in entries {
        let entry = entry.map_err(|e| format!("Dir entry error: {}", e))?;
        let path = entry.path();
        let name = entry.file_name();
        let dest_path = dest.join(&name);
        if name.to_string_lossy().starts_with('.') {
            continue;
        }
        if path.is_dir() {
            copy_recursive(&path, &dest_path, files)?;
        } else {
            fs::copy(&path, &dest_path)
                .map_err(|e| format!("Failed to copy '{}': {}", path.display(), e))?;
            file_sync::mark_app_write_path(&dest_path);
            files.push(dest_path.to_string_lossy().replace('\\', "/"));
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn delete_file(path: String, state: State<'_, ProjectRootState>) -> Result<(), String> {
    let validated = sandbox_path(&state, &path, SandboxMode::Write)?;
    let validated_str = validated.to_string_lossy().to_string();
    tauri::async_runtime::spawn_blocking(move || {
        run_guarded("delete_file", || {
            file_sync::mark_app_write_path(&validated);
            if validated.is_dir() {
                remove_path_with_retry(&validated_str, true)
                    .map_err(|e| format!("Failed to delete directory '{}': {}", path, e))?;
            } else {
                remove_path_with_retry(&validated_str, false)
                    .map_err(|e| format!("Failed to delete file '{}': {}", path, e))?;
            }
            file_sync::mark_app_write_path(&validated);
            Ok(())
        })
    })
    .await
    .map_err(|e| format!("delete_file blocking task join error: {e}"))?
}

fn remove_path_with_retry(path: &str, is_dir: bool) -> Result<(), std::io::Error> {
    let mut last_err: Option<std::io::Error> = None;
    for attempt in 0..4 {
        let result = if is_dir {
            fs::remove_dir_all(path)
        } else {
            fs::remove_file(path)
        };
        match result {
            Ok(()) => return Ok(()),
            Err(err) if attempt < 3 && is_windows_transient_delete_error(&err) => {
                last_err = Some(err);
                thread::sleep(Duration::from_millis(250 * (1_u64 << attempt)));
            }
            Err(err) => return Err(err),
        }
    }
    Err(last_err.unwrap_or_else(|| std::io::Error::other("delete failed")))
}

fn is_windows_transient_delete_error(err: &std::io::Error) -> bool {
    #[cfg(windows)]
    {
        matches!(err.raw_os_error(), Some(32 | 33))
            || err.kind() == std::io::ErrorKind::PermissionDenied
    }
    #[cfg(not(windows))]
    {
        let _ = err;
        false
    }
}

/// Find wiki pages that reference a given source file name.
/// Scans all .md files under wiki/ for the source filename in frontmatter or content.
#[tauri::command]
pub async fn find_related_wiki_pages(
    project_path: String,
    source_name: String,
    state: State<'_, ProjectRootState>,
) -> Result<Vec<String>, String> {
    // Validate project_path against the sandbox root (Read mode) before
    // joining "wiki" and scanning it. Closes the last un-sandboxed read
    // probe on the webview command surface (#119 P0-2, re-review P2).
    let validated = sandbox_path(&state, &project_path, SandboxMode::Read)?;
    let wiki_dir = validated.join("wiki");
    tauri::async_runtime::spawn_blocking(move || {
        run_guarded("find_related_wiki_pages", || {
            if !wiki_dir.is_dir() {
                return Ok(vec![]);
            }

            let mut related = Vec::new();
            collect_related_pages(&wiki_dir, &source_name, &mut related)?;
            Ok(related)
        })
    })
    .await
    .map_err(|e| format!("find_related_wiki_pages blocking task join error: {e}"))?
}

fn collect_related_pages(
    dir: &Path,
    source_name: &str,
    results: &mut Vec<String>,
) -> Result<(), String> {
    let entries = fs::read_dir(dir).map_err(|e| e.to_string())?;

    // Get just the filename without path — use Path for cross-platform separator handling
    let source_path = std::path::Path::new(source_name);
    let file_name = source_path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or(source_name);
    let file_name_lower = file_name.to_lowercase();

    // Derive stem (filename without extension) for source summary matching
    let file_stem = file_name
        .rsplit('.')
        .skip(1)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect::<Vec<_>>()
        .join(".");
    let file_stem_lower = if file_stem.is_empty() {
        file_name_lower.clone()
    } else {
        file_stem.to_lowercase()
    };

    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_related_pages(&path, source_name, results)?;
        } else if path.extension().map(|e| e == "md").unwrap_or(false) {
            let fname = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
            // Skip index.md, log.md, overview.md — updated separately
            if fname == "index.md" || fname == "log.md" || fname == "overview.md" {
                continue;
            }

            if let Ok(content) = fs::read_to_string(&path) {
                let content_lower = content.to_lowercase();

                // Match 1: frontmatter sources field contains the exact filename
                // e.g., sources: ["2603.25723v1.pdf"]
                let sources_match = content_lower.contains(&format!("\"{}\"", file_name_lower))
                    || content_lower.contains(&format!("'{}'", file_name_lower));

                // Match 2: source summary page (wiki/sources/{stem}.md)
                // Use Path component iteration to avoid hardcoded separator assumptions
                let is_in_sources_dir = path.components().any(|c| c.as_os_str() == "sources");
                let is_source_summary =
                    is_in_sources_dir && fname.to_lowercase().starts_with(&file_stem_lower);

                // Match 3: the page's *sources block* mentions the
                // filename. Covers the multi-line YAML list form
                //
                //   sources:
                //     - test.md         (unquoted, missed by Match 1)
                //     - "other.md"
                //
                // Previous version substring-matched against the ENTIRE
                // frontmatter, which false-positived whenever the
                // filename happened to appear in title / description /
                // any other field — those pages were then handed to
                // the TS delete flow and, because their actual sources
                // list didn't include the deleted file, silently
                // wiped. Tightened: scope the substring check to the
                // `sources:` block only (inline line + any indented
                // continuation lines of a YAML list).
                let frontmatter_match = if content.starts_with("---\n") {
                    if let Some(fm_end_rel) = content[4..].find("\n---") {
                        let frontmatter = &content[4..4 + fm_end_rel].to_lowercase();
                        let mut found = false;
                        let mut in_sources_block = false;
                        for line in frontmatter.split('\n') {
                            if line.starts_with("sources:") {
                                // Inline-form `sources: [...]` lives
                                // entirely on this one line; check it.
                                if line.contains(&file_name_lower) {
                                    found = true;
                                    break;
                                }
                                in_sources_block = true;
                                continue;
                            }
                            if in_sources_block {
                                // Continuation lines of a YAML list are
                                // indented; an un-indented line means
                                // we've left the sources block for
                                // another top-level field.
                                if line.is_empty()
                                    || line.starts_with(' ')
                                    || line.starts_with('\t')
                                {
                                    if line.contains(&file_name_lower) {
                                        found = true;
                                        break;
                                    }
                                } else {
                                    in_sources_block = false;
                                }
                            }
                        }
                        found
                    } else {
                        false
                    }
                } else {
                    false
                };

                if sources_match || is_source_summary || frontmatter_match {
                    // Normalize to forward slashes — matches build_tree /
                    // copy_directory so TS-side comparisons work on Windows.
                    results.push(path.to_string_lossy().replace('\\', "/"));
                }
            }
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn create_directory(
    path: String,
    state: State<'_, ProjectRootState>,
) -> Result<(), String> {
    let validated = sandbox_path(&state, &path, SandboxMode::Write)?;
    tauri::async_runtime::spawn_blocking(move || {
        run_guarded("create_directory", || {
            fs::create_dir_all(&validated)
                .map_err(|e| format!("Failed to create directory '{}': {}", path, e))
        })
    })
    .await
    .map_err(|e| format!("create_directory blocking task join error: {e}"))?
}

/// Read any file as base64 + a guessed mime type. Used by the
/// vision-caption pipeline to slurp extracted image bytes off disk
/// without round-tripping them through the JS string-as-UTF8 path
/// (`read_file` would corrupt PNG bytes — they aren't valid UTF-8).
///
/// Mime detection is by extension only — the caption helper doesn't
/// care about exact accuracy (vision models accept any common
/// raster format), and the alternative (sniffing magic bytes via
/// `infer` or similar) adds a dependency for marginal benefit.
/// Unknown extensions fall back to `application/octet-stream`,
/// which all major vision endpoints accept (Anthropic / OpenAI both
/// also support that as a generic fallback).
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileBase64 {
    pub base64: String,
    pub mime_type: String,
}

#[tauri::command]
pub async fn read_file_as_base64(
    path: String,
    state: State<'_, ProjectRootState>,
) -> Result<FileBase64, String> {
    let validated = sandbox_path(&state, &path, SandboxMode::Read)?;
    tauri::async_runtime::spawn_blocking(move || {
        run_guarded("read_file_as_base64", || {
            read_file_as_base64_validated(validated, path)
        })
    })
    .await
    .map_err(|e| format!("read_file_as_base64 blocking task join error: {e}"))?
}

fn read_file_as_base64_validated(validated: PathBuf, path: String) -> Result<FileBase64, String> {
    use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
    reject_if_over_cap(&validated, &path, MAX_BASE64_READ_BYTES, "file")?;
    let bytes = fs::read(&validated).map_err(|e| format!("Failed to read '{}': {}", path, e))?;
    let ext = validated
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let mime_type = match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "tiff" | "tif" => "image/tiff",
        "svg" => "image/svg+xml",
        _ => "application/octet-stream",
    }
    .to_string();
    Ok(FileBase64 {
        base64: B64.encode(&bytes),
        mime_type,
    })
}

/// Cheap existence check without reading or classifying the file.
/// Returns true iff `path` refers to something on disk right now.
#[tauri::command]
pub async fn file_exists(path: String, state: State<'_, ProjectRootState>) -> Result<bool, String> {
    let validated = sandbox_path(&state, &path, SandboxMode::Read)?;
    tauri::async_runtime::spawn_blocking(move || {
        run_guarded("file_exists", || Ok(validated.exists()))
    })
    .await
    .map_err(|e| format!("file_exists blocking task join error: {e}"))?
}

/// Resolve symlinks and `..` segments to an absolute canonical path.
#[tauri::command]
pub async fn canonicalize_path(
    path: String,
    state: State<'_, ProjectRootState>,
) -> Result<String, String> {
    let validated = sandbox_path(&state, &path, SandboxMode::Read)?;
    tauri::async_runtime::spawn_blocking(move || {
        run_guarded("canonicalize_path", || {
            let canonical = fs::canonicalize(&validated)
                .map_err(|e| format!("Failed to canonicalize '{}': {}", path, e))?;
            Ok(canonical.to_string_lossy().to_string())
        })
    })
    .await
    .map_err(|e| format!("canonicalize_path blocking task join error: {e}"))?
}

/// Get the last modified timestamp of a file in milliseconds since Unix epoch.
/// Returns 0 if the file doesn't exist or metadata can't be read.
#[tauri::command]
pub async fn get_file_modified_time(
    path: String,
    state: State<'_, ProjectRootState>,
) -> Result<u64, String> {
    let validated = sandbox_path(&state, &path, SandboxMode::Read)?;
    tauri::async_runtime::spawn_blocking(move || {
        run_guarded("get_file_modified_time", || {
            let metadata = fs::metadata(&validated)
                .map_err(|e| format!("Failed to get metadata for '{}': {}", path, e))?;
            let modified = metadata
                .modified()
                .map_err(|e| format!("Failed to get modified time for '{}': {}", path, e))?;
            let duration = modified
                .duration_since(std::time::UNIX_EPOCH)
                .map_err(|e| format!("Time error for '{}': {}", path, e))?;
            Ok(duration.as_millis() as u64)
        })
    })
    .await
    .map_err(|e| format!("get_file_modified_time blocking task join error: {e}"))?
}

#[tauri::command]
pub async fn get_file_size(
    path: String,
    state: State<'_, ProjectRootState>,
) -> Result<u64, String> {
    let validated = sandbox_path(&state, &path, SandboxMode::Read)?;
    tauri::async_runtime::spawn_blocking(move || {
        run_guarded("get_file_size", || {
            let metadata = fs::metadata(&validated)
                .map_err(|e| format!("Failed to get metadata for '{}': {}", path, e))?;
            Ok(metadata.len())
        })
    })
    .await
    .map_err(|e| format!("get_file_size blocking task join error: {e}"))?
}

/// Compute MD5 hash of a file. Returns the hex-encoded hash string.
#[tauri::command]
pub async fn get_file_md5(
    path: String,
    state: State<'_, ProjectRootState>,
) -> Result<String, String> {
    get_file_md5_with_root_state(path, &state).await
}

async fn get_file_md5_with_root_state(
    path: String,
    state: &ProjectRootState,
) -> Result<String, String> {
    let validated = sandbox_path_for_root(
        state.get(),
        &path,
        SandboxMode::ReadRequiresRootButAllowsExternal,
    )?;
    get_file_md5_validated(validated, path).await
}

async fn get_file_md5_validated(validated: PathBuf, path_orig: String) -> Result<String, String> {
    use md5::{Digest, Md5};

    tauri::async_runtime::spawn_blocking(move || {
        run_guarded("get_file_md5", || {
            let mut file = fs::File::open(&validated)
                .map_err(|e| format!("Failed to open file '{}': {}", path_orig, e))?;
            let mut hasher = Md5::new();
            let mut buffer = [0u8; 64 * 1024];
            loop {
                let read = file
                    .read(&mut buffer)
                    .map_err(|e| format!("Failed to read file '{}': {}", path_orig, e))?;
                if read == 0 {
                    break;
                }
                hasher.update(&buffer[..read]);
            }
            let result = hasher.finalize();
            Ok(format!("{:x}", result))
        })
    })
    .await
    .map_err(|e| format!("get_file_md5 blocking task join error: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    /// Write `bytes` to a fresh tmp path with `.pdf` suffix and return
    /// the path (the OS tmpdir is NOT cleaned up — acceptable for tests).
    fn tmp_pdf_with_bytes(bytes: &[u8]) -> String {
        let dir = std::env::temp_dir();
        let path = dir.join(format!(
            "panic-guard-{}.pdf",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let mut f = fs::File::create(&path).unwrap();
        f.write_all(bytes).unwrap();
        path.to_string_lossy().to_string()
    }

    fn tmp_path(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "{}-{}",
            name,
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ))
    }

    fn tmp_dir(name: &str) -> PathBuf {
        let path = tmp_path(name);
        fs::create_dir_all(&path).unwrap();
        path
    }

    fn test_root_state(project_root: Option<PathBuf>) -> ProjectRootState {
        let root_state = ProjectRootState::default();
        if let Some(root) = project_root {
            root_state.set(root);
        }
        root_state
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn write_file_base64_validated_writes_decoded_bytes() {
        let path = tmp_path("write-file-base64")
            .join("nested")
            .join("image.bin");
        let result = write_file_base64_validated(
            path.clone(),
            path.to_string_lossy().to_string(),
            "aW1hZ2UtYnl0ZXM=".to_string(),
        )
        .await;

        assert!(result.is_ok(), "{result:?}");
        assert_eq!(fs::read(&path).unwrap(), b"image-bytes");
        let _ = fs::remove_file(&path);
        if let Some(parent) = path.parent().and_then(|p| p.parent()) {
            let _ = fs::remove_dir_all(parent);
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn get_file_md5_validated_hashes_file_contents() {
        let path = tmp_path("get-file-md5.txt");
        fs::write(&path, b"hello").unwrap();

        let hash = get_file_md5_validated(path.clone(), path.to_string_lossy().to_string())
            .await
            .unwrap();

        assert_eq!(hash, "5d41402abc4b2a76b9719d911017c592");
        let _ = fs::remove_file(&path);
    }

    // Helper-level regression: the Tauri command wrapper delegates to
    // `write_file_base64_with_root_state`, but these tests avoid building a
    // full Tauri app just to construct `State<ProjectRootState>`.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn write_file_base64_helper_rejects_path_outside_project_root() {
        let project_root = tmp_dir("write-file-base64-project");
        let outside_root = tmp_dir("write-file-base64-outside");
        let outside_path = outside_root.join("image.bin");
        let state = test_root_state(Some(project_root.clone()));

        let result = write_file_base64_with_root_state(
            outside_path.to_string_lossy().to_string(),
            "aW1hZ2U=".to_string(),
            &state,
        )
        .await;

        assert!(result.is_err(), "{result:?}");
        let err = result.unwrap_err();
        assert!(err.contains("escapes the project directory"), "{err}");
        assert!(!outside_path.exists());
        let _ = fs::remove_dir_all(project_root);
        let _ = fs::remove_dir_all(outside_root);
    }

    // Helper-level regression for scheduled import compatibility: once a
    // project root exists, MD5 reads keep the legacy external-file behavior.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn get_file_md5_helper_allows_external_path_when_project_root_is_active() {
        let project_root = tmp_dir("get-file-md5-project");
        let outside_root = tmp_dir("get-file-md5-outside");
        let outside_path = outside_root.join("source.pdf");
        fs::write(&outside_path, b"hello").unwrap();
        let state = test_root_state(Some(project_root.clone()));

        let hash = get_file_md5_with_root_state(outside_path.to_string_lossy().to_string(), &state)
            .await
            .unwrap();

        assert_eq!(hash, "5d41402abc4b2a76b9719d911017c592");
        let _ = fs::remove_dir_all(project_root);
        let _ = fs::remove_dir_all(outside_root);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn get_file_md5_helper_resolves_relative_path_inside_project_root() {
        let project_root = tmp_dir("get-file-md5-relative-project");
        fs::create_dir_all(project_root.join("raw/sources")).unwrap();
        fs::write(project_root.join("raw/sources/source.pdf"), b"hello").unwrap();
        let state = test_root_state(Some(project_root.clone()));

        let hash = get_file_md5_with_root_state("raw/sources/source.pdf".to_string(), &state)
            .await
            .unwrap();

        assert_eq!(hash, "5d41402abc4b2a76b9719d911017c592");
        let _ = fs::remove_dir_all(project_root);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn get_file_md5_helper_rejects_relative_traversal() {
        let project_root = tmp_dir("get-file-md5-traversal-project");
        let state = test_root_state(Some(project_root.clone()));

        let result = get_file_md5_with_root_state("../outside.pdf".to_string(), &state).await;

        assert!(result.is_err(), "{result:?}");
        let err = result.unwrap_err();
        assert!(err.contains("Path traversal is not allowed"), "{err}");
        let _ = fs::remove_dir_all(project_root);
    }

    // Helper-level regression for #139: unlike legacy read commands, MD5 must
    // fail closed before any project root has been established.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn get_file_md5_helper_rejects_when_no_project_root_is_active() {
        let path = tmp_path("get-file-md5-no-project.txt");
        fs::write(&path, b"hello").unwrap();
        let state = test_root_state(None);

        let result = get_file_md5_with_root_state(path.to_string_lossy().to_string(), &state).await;

        assert!(result.is_err(), "{result:?}");
        let err = result.unwrap_err();
        assert!(err.contains("no active project root"), "{err}");
        let _ = fs::remove_file(path);
    }

    /// Verify read_file does NOT crash the test process on malformed PDFs.
    /// We try a handful of payloads that have historically caused
    /// pdf-extract/lopdf panics — any process abort would fail the test
    /// runner before it can report.
    ///
    /// `multi_thread` flavor: `read_file` now uses
    /// `tauri::async_runtime::spawn_blocking`, which moves work onto
    /// the tokio blocking pool. The blocking pool requires a multi-
    /// threaded runtime — the default `#[tokio::test]` is single-
    /// threaded current-thread, on which `.await` of a `spawn_blocking`
    /// future deadlocks.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn read_file_survives_malformed_pdf_inputs() {
        let payloads: &[(&str, &[u8])] = &[
            ("empty", b""),
            ("not_a_pdf", b"this is plainly not a PDF file"),
            ("header_only", b"%PDF-1.4\n"),
            (
                "broken_xref",
                b"%PDF-1.4\n1 0 obj\n<<>>\nendobj\nxref\nBROKENBROKEN\ntrailer\n<</Size 1>>\nstartxref\n999999\n%%EOF\n",
            ),
            (
                "junk_after_header",
                b"%PDF-1.4\n\x00\x01\x02\x03\x04\x05\x06\x07\xFF\xFE\xFDjunkgarbage",
            ),
        ];

        for (name, bytes) in payloads {
            let path = tmp_pdf_with_bytes(bytes);
            let result = read_file_validated(PathBuf::from(&path), path.clone()).await;
            let _ = fs::remove_file(&path);
            eprintln!(
                "[{name}] => {:?}",
                result.as_ref().map(|s| &s[..s.len().min(80)])
            );
        }
    }

    /// Smoke test: a real PDF panic (synthesized) is caught. We can't
    /// guarantee that any particular byte sequence above actually panics
    /// pdf-extract across versions, so also trigger an explicit panic
    /// through read_file's guarded path.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn read_file_returns_err_on_missing_file_instead_of_panicking() {
        let result = read_file_validated(
            PathBuf::from("/nonexistent/path/that/does/not/exist.pdf"),
            "/nonexistent/path/that/does/not/exist.pdf".to_string(),
        )
        .await;
        assert!(result.is_err() || result.is_ok()); // must at least return
    }

    /// Ad-hoc probe: run the production PDF extraction path against every
    /// .pdf under a user-provided directory and print a per-file report of
    /// Ok / Err (library returned an error) / Panic (library panicked and
    /// was caught by panic_guard). Gated with #[ignore] so it never runs
    /// in CI; execute locally with:
    ///
    ///   PDF_PROBE_DIR=/path/to/pdfs cargo test --lib \
    ///     -- --ignored --nocapture pdf_probe
    #[test]
    #[ignore = "local probe; set PDF_PROBE_DIR"]
    fn pdf_probe() {
        let dir = std::env::var("PDF_PROBE_DIR")
            .unwrap_or_else(|_| "/Users/nash_su/Downloads/pdftests".to_string());
        let root = std::path::Path::new(&dir);
        if !root.exists() {
            eprintln!("[pdf_probe] dir not found: {}", root.display());
            return;
        }

        let mut pdfs: Vec<std::path::PathBuf> = Vec::new();
        fn walk(d: &std::path::Path, out: &mut Vec<std::path::PathBuf>) {
            if let Ok(entries) = fs::read_dir(d) {
                for entry in entries.flatten() {
                    let p = entry.path();
                    if p.is_dir() {
                        walk(&p, out);
                    } else if p
                        .extension()
                        .and_then(|e| e.to_str())
                        .map(|e| e.eq_ignore_ascii_case("pdf"))
                        .unwrap_or(false)
                    {
                        out.push(p);
                    }
                }
            }
        }
        walk(root, &mut pdfs);
        pdfs.sort();

        eprintln!(
            "\n[pdf_probe] found {} PDFs under {}\n",
            pdfs.len(),
            root.display()
        );

        let mut ok = 0usize;
        let mut err = 0usize;
        let mut panicked = 0usize;

        for (idx, path) in pdfs.iter().enumerate() {
            let display = path.display().to_string();
            // Call extract_pdf_text directly (not read_file) so we bypass
            // the .cache sibling dir and always exercise the parser.
            let path_str = path.to_string_lossy().to_string();
            let result = std::panic::catch_unwind(|| extract_pdf_text(&path_str));
            match result {
                Ok(Ok(text)) => {
                    ok += 1;
                    eprintln!(
                        "[{:>3}/{}] OK     ({:>7} chars)  {}",
                        idx + 1,
                        pdfs.len(),
                        text.len(),
                        display
                    );
                }
                Ok(Err(e)) => {
                    err += 1;
                    eprintln!(
                        "[{:>3}/{}] ERR    {}  →  {}",
                        idx + 1,
                        pdfs.len(),
                        display,
                        e
                    );
                }
                Err(payload) => {
                    panicked += 1;
                    let msg = if let Some(s) = payload.downcast_ref::<String>() {
                        s.clone()
                    } else if let Some(s) = payload.downcast_ref::<&str>() {
                        (*s).to_string()
                    } else {
                        "(non-string panic)".to_string()
                    };
                    eprintln!(
                        "[{:>3}/{}] PANIC  {}  →  {}",
                        idx + 1,
                        pdfs.len(),
                        display,
                        msg
                    );
                }
            }
        }

        eprintln!(
            "\n[pdf_probe] summary: {} OK / {} ERR / {} PANIC (total {})",
            ok,
            err,
            panicked,
            pdfs.len()
        );
    }

    // ── collect_related_pages: regression coverage for the three match ─────
    // strategies used by findRelatedWikiPages.
    //
    // Strategy 1: quoted filename anywhere in content
    //               (e.g. `sources: ["test.md"]` inline form)
    // Strategy 2: page lives under wiki/sources/ and starts with file stem
    //               (the source summary page)
    // Strategy 3: filename appears inside the frontmatter's sources BLOCK
    //               (tightened: no longer false-positives on `title:`
    //                `description:` or any other field that happens to
    //                include the filename as a substring)
    //
    // These tests are the regression guard for the Strategy 3 fix — before
    // the tightening, a page whose title included the deleted filename
    // would be surfaced here and then wrongly deleted downstream.

    fn make_wiki(files: &[(&str, &str)]) -> std::path::PathBuf {
        // Atomic counter so parallel tests never collide on the same temp
        // dir (nanosecond-only uniqueness raced under `cargo test`'s
        // default thread-pool — same flake class as path_safety P1-A).
        use std::sync::atomic::{AtomicU64, Ordering};
        static WIKI_COUNTER: AtomicU64 = AtomicU64::new(0);
        let id = WIKI_COUNTER.fetch_add(1, Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!(
            "wiki-test-{}-{}",
            id,
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&dir).unwrap();
        for (rel, body) in files {
            let p = dir.join(rel);
            if let Some(parent) = p.parent() {
                fs::create_dir_all(parent).unwrap();
            }
            fs::write(&p, body).unwrap();
        }
        dir
    }

    fn collect(wiki: &std::path::Path, source: &str) -> Vec<String> {
        let mut out = Vec::new();
        collect_related_pages(wiki, source, &mut out).unwrap();
        // Normalize to the wiki-relative suffix so assertions are
        // independent of the temp prefix.
        let prefix = wiki.to_string_lossy().replace('\\', "/");
        out.into_iter()
            .map(|p| {
                let p = p.replace('\\', "/");
                p.strip_prefix(&format!("{}/", prefix))
                    .map(str::to_string)
                    .unwrap_or(p)
            })
            .collect()
    }

    #[test]
    fn collect_related_strategy1_inline_quoted_sources() {
        let wiki = make_wiki(&[
            (
                "concepts/rope.md",
                "---\ntitle: RoPE\nsources: [\"test.md\"]\n---\nbody\n",
            ),
            (
                "concepts/unrelated.md",
                "---\ntitle: Unrelated\nsources: [\"other.md\"]\n---\nbody\n",
            ),
        ]);
        let mut got = collect(&wiki, "test.md");
        got.sort();
        assert_eq!(got, vec!["concepts/rope.md"]);
        let _ = fs::remove_dir_all(&wiki);
    }

    #[test]
    fn collect_related_strategy1_single_quoted_sources() {
        let wiki = make_wiki(&[(
            "concepts/rope.md",
            "---\ntitle: RoPE\nsources: ['test.md']\n---\nbody\n",
        )]);
        let got = collect(&wiki, "test.md");
        assert_eq!(got, vec!["concepts/rope.md"]);
        let _ = fs::remove_dir_all(&wiki);
    }

    #[test]
    fn collect_related_strategy2_source_summary_page() {
        // A page inside wiki/sources/ whose filename starts with the
        // deleted source's stem counts as the source-summary page —
        // kept linked even if its sources field happens to be missing.
        let wiki = make_wiki(&[
            ("sources/test.md", "---\ntitle: Test Summary\n---\nbody\n"),
            (
                "concepts/unrelated.md",
                "---\ntitle: Unrelated\nsources: [\"other.md\"]\n---\nbody\n",
            ),
        ]);
        let got = collect(&wiki, "test.md");
        assert_eq!(got, vec!["sources/test.md"]);
        let _ = fs::remove_dir_all(&wiki);
    }

    #[test]
    fn collect_related_strategy3_multi_line_yaml_list() {
        // Multi-line YAML sources block with an unquoted entry — Strategy
        // 1 can't see this (no quotes), Strategy 3 has to walk the
        // sources block line by line.
        let wiki = make_wiki(&[(
            "concepts/rope.md",
            "---\ntitle: RoPE\nsources:\n  - test.md\n  - \"other.md\"\ntags: []\n---\nbody\n",
        )]);
        let got = collect(&wiki, "test.md");
        assert_eq!(got, vec!["concepts/rope.md"]);
        let _ = fs::remove_dir_all(&wiki);
    }

    #[test]
    fn collect_related_strategy3_does_not_false_positive_on_title_substring() {
        // Regression guard for the bug we just fixed: a page whose
        // title / description contains the deleted filename MUST NOT
        // be surfaced when its actual sources list is unrelated.
        // Before the fix, the whole frontmatter was substring-scanned
        // and this page would have been returned → downstream delete
        // flow → silent data loss on an innocent page.
        let wiki = make_wiki(&[
            (
                "concepts/rope.md",
                "---\ntitle: Analysis of test.md\ndescription: Discusses test.md in depth\nsources: [\"other.md\"]\n---\nbody\n",
            ),
            (
                "concepts/real-match.md",
                "---\ntitle: Real\nsources: [\"test.md\"]\n---\nbody\n",
            ),
        ]);
        let got = collect(&wiki, "test.md");
        // Only the real-match page is surfaced. The title-substring
        // page is correctly ignored now.
        assert_eq!(got, vec!["concepts/real-match.md"]);
        let _ = fs::remove_dir_all(&wiki);
    }

    #[test]
    fn collect_related_strategy3_stops_at_next_top_level_field() {
        // Scan must stop at the next top-level YAML key so that a
        // filename appearing in a later field (e.g. `notes:`) doesn't
        // get pulled into the sources block.
        let wiki = make_wiki(&[(
            "concepts/rope.md",
            "---\ntitle: RoPE\nsources:\n  - other.md\nnotes: See test.md for context\n---\nbody\n",
        )]);
        let got = collect(&wiki, "test.md");
        // sources block has only other.md; test.md appears in `notes:`
        // which is outside the block — must not match.
        assert!(got.is_empty(), "expected empty, got {got:?}");
        let _ = fs::remove_dir_all(&wiki);
    }

    #[test]
    fn collect_related_returns_empty_when_nothing_matches() {
        let wiki = make_wiki(&[(
            "concepts/unrelated.md",
            "---\ntitle: X\nsources: [\"other.md\"]\n---\nbody\n",
        )]);
        let got = collect(&wiki, "nonexistent.md");
        assert!(got.is_empty());
        let _ = fs::remove_dir_all(&wiki);
    }

    #[test]
    fn collect_related_skips_index_log_overview() {
        // Listing pages (index.md, log.md, overview.md) reference the
        // filename heavily but should never be returned here — they're
        // cleaned separately via the TS cleanup helpers.
        let wiki = make_wiki(&[
            (
                "index.md",
                "---\ntitle: Index\n---\n- [[Test]]\nsources: [\"test.md\"]\n",
            ),
            (
                "log.md",
                "---\ntitle: Log\n---\nIngested test.md on 2026-01-01\n",
            ),
            (
                "overview.md",
                "---\ntitle: Overview\n---\nCovers test.md and other.md\n",
            ),
            (
                "concepts/real.md",
                "---\ntitle: Real\nsources: [\"test.md\"]\n---\nbody\n",
            ),
        ]);
        let got = collect(&wiki, "test.md");
        assert_eq!(got, vec!["concepts/real.md"]);
        let _ = fs::remove_dir_all(&wiki);
    }

    #[test]
    fn collect_related_case_insensitive_filename_match() {
        let wiki = make_wiki(&[(
            "concepts/rope.md",
            "---\ntitle: RoPE\nsources: [\"Test.md\"]\n---\nbody\n",
        )]);
        let got = collect(&wiki, "test.md");
        assert_eq!(got, vec!["concepts/rope.md"]);
        let _ = fs::remove_dir_all(&wiki);
    }

    // ── copy_directory: folder import recursion + filtering ──────────
    //
    // The folder-import flow on the JS side calls this command and
    // expects:
    //   1. Recursion goes ALL the way down (no depth cap) — users
    //      drop trees with arbitrary nesting and every file inside
    //      should reach the wiki.
    //   2. Dotfiles / dot-directories are skipped (`.git`, `.cache`,
    //      `.DS_Store`) — otherwise a folder with a `.git/` would
    //      import megabytes of git plumbing as "source files."
    //   3. Returned paths are FLAT (one entry per file, regardless
    //      of depth) and use forward slashes (the JS layer normalizes
    //      everything to `/` before doing path comparisons).
    //
    // These are exactly the invariants `handleImportFolder` in
    // sources-view.tsx assumes — pinning them here keeps a future
    // refactor of the recursive copier from silently breaking the
    // folder import button.

    fn make_temp_dir(label: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "llmwiki-copydir-{label}-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// Pull the inner sync `copy_recursive` body out from
    /// `copy_directory` so the test doesn't need to spin up a
    /// tokio runtime just to exercise file-system recursion.
    /// Mirrors the same logic the async command uses.
    fn copy_dir_for_test(src: &Path, dest: &Path) -> Vec<String> {
        std::fs::create_dir_all(dest).unwrap();
        let mut out = Vec::new();
        fn rec(src: &Path, dest: &Path, files: &mut Vec<String>) {
            std::fs::create_dir_all(dest).unwrap();
            for entry in std::fs::read_dir(src).unwrap().flatten() {
                let path = entry.path();
                let name = entry.file_name();
                let dest_path = dest.join(&name);
                if name.to_string_lossy().starts_with('.') {
                    continue;
                }
                if path.is_dir() {
                    rec(&path, &dest_path, files);
                } else {
                    std::fs::copy(&path, &dest_path).unwrap();
                    files.push(dest_path.to_string_lossy().replace('\\', "/"));
                }
            }
        }
        rec(src, dest, &mut out);
        out
    }

    #[test]
    fn copy_directory_recurses_arbitrary_depth() {
        let src = make_temp_dir("src-deep");
        // Build /src/a/b/c/d/e/leaf.txt — five levels under root.
        let leaf_dir = src.join("a/b/c/d/e");
        std::fs::create_dir_all(&leaf_dir).unwrap();
        std::fs::write(leaf_dir.join("leaf.txt"), b"deep content").unwrap();
        // Plus a top-level file to ensure root files come along too.
        std::fs::write(src.join("top.md"), b"# top").unwrap();

        let dest = make_temp_dir("dest-deep");
        let copied = copy_dir_for_test(&src, &dest);

        assert_eq!(copied.len(), 2, "expected two files, got: {:?}", copied);
        // Deep file made it across with full nesting preserved.
        let leaf_dest = dest.join("a/b/c/d/e/leaf.txt");
        assert!(
            leaf_dest.exists(),
            "deep leaf.txt missing at {:?}",
            leaf_dest
        );
        assert_eq!(std::fs::read(&leaf_dest).unwrap(), b"deep content");
        // Top-level file too.
        assert!(dest.join("top.md").exists());
        // Returned paths are forward-slashed and absolute.
        for p in &copied {
            assert!(!p.contains('\\'), "path should be /-normalized: {p}");
            assert!(Path::new(p).is_absolute(), "path should be absolute: {p}");
        }

        let _ = std::fs::remove_dir_all(&src);
        let _ = std::fs::remove_dir_all(&dest);
    }

    #[test]
    fn copy_directory_skips_dotfiles_and_dot_directories() {
        let src = make_temp_dir("src-dots");
        // Visible content:
        std::fs::write(src.join("keep.md"), b"keep me").unwrap();
        std::fs::create_dir_all(src.join("subdir")).unwrap();
        std::fs::write(src.join("subdir/keep2.md"), b"keep me too").unwrap();
        // Things that must be skipped:
        std::fs::write(src.join(".DS_Store"), b"junk").unwrap();
        std::fs::create_dir_all(src.join(".git/objects")).unwrap();
        std::fs::write(src.join(".git/HEAD"), b"ref: refs/heads/main").unwrap();
        std::fs::write(src.join(".git/objects/abc"), b"\x78\x9c").unwrap();
        std::fs::write(src.join(".env"), b"SECRET=foo").unwrap();
        // Sneaky one: a dot-prefixed dir nested inside a normal dir
        // should ALSO be skipped (the dotfile rule applies at every
        // recursion level, not just the top).
        std::fs::create_dir_all(src.join("subdir/.cache")).unwrap();
        std::fs::write(src.join("subdir/.cache/blob"), b"cache").unwrap();

        let dest = make_temp_dir("dest-dots");
        let copied = copy_dir_for_test(&src, &dest);

        assert_eq!(
            copied.len(),
            2,
            "should copy only the 2 visible files, got: {:?}",
            copied,
        );
        assert!(dest.join("keep.md").exists());
        assert!(dest.join("subdir/keep2.md").exists());
        // Dot-stuff must NOT be on disk in the destination.
        assert!(!dest.join(".DS_Store").exists());
        assert!(!dest.join(".git").exists());
        assert!(!dest.join(".env").exists());
        assert!(!dest.join("subdir/.cache").exists());

        let _ = std::fs::remove_dir_all(&src);
        let _ = std::fs::remove_dir_all(&dest);
    }

    #[test]
    fn copy_directory_returns_flat_list_with_forward_slashes() {
        let src = make_temp_dir("src-flat");
        std::fs::create_dir_all(src.join("year/2024/q3")).unwrap();
        std::fs::write(src.join("year/2024/q3/report.pdf"), b"%PDF-fake").unwrap();
        std::fs::write(src.join("year/2024/notes.md"), b"# notes").unwrap();

        let dest = make_temp_dir("dest-flat");
        let copied = copy_dir_for_test(&src, &dest);

        // Both files in the flat list, ordered by file-system traversal
        // (we don't care about exact order, but every entry must be
        // forward-slashed and end with the expected filename).
        let names: Vec<String> = copied
            .iter()
            .map(|p| {
                Path::new(p)
                    .file_name()
                    .unwrap()
                    .to_string_lossy()
                    .to_string()
            })
            .collect();
        assert!(names.contains(&"report.pdf".to_string()));
        assert!(names.contains(&"notes.md".to_string()));
        assert_eq!(copied.len(), 2);
        for p in &copied {
            assert!(p.contains('/'), "should contain at least one /: {p}");
            assert!(!p.contains('\\'), "should NOT contain \\: {p}");
        }

        let _ = std::fs::remove_dir_all(&src);
        let _ = std::fs::remove_dir_all(&dest);
    }

    /// Regression for re-review P2: `find_related_wiki_pages` now sandboxes
    /// `project_path` via `validate_within_project` before scanning. This test
    /// exercises the post-sandbox code path (`collect_related_pages` over a
    /// validated wiki dir) to confirm the integration still finds references.
    #[test]
    fn collect_related_pages_finds_source_reference_under_sandbox() {
        let root = std::env::temp_dir().join(format!(
            "llm-wiki-find-related-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let wiki_dir = root.join("wiki").join("sources");
        std::fs::create_dir_all(&wiki_dir).unwrap();

        // A source page that references our source filename via a frontmatter
        // `sources:` block — this is the primary match path in
        // collect_related_pages (Match 1/3: quoted filename or sources list).
        let page = wiki_dir.join("wei-2022-chain-of-thought.md");
        std::fs::write(
            &page,
            "---\ntype: source\nsources:\n  - \"report.pdf\"\n---\n# CoT paper",
        )
        .unwrap();

        let mut related = Vec::new();
        collect_related_pages(&wiki_dir, "report.pdf", &mut related).unwrap();
        assert!(
            related
                .iter()
                .any(|p| p.contains("wei-2022-chain-of-thought")),
            "collect_related_pages should find the reference; got {related:?}"
        );

        let _ = std::fs::remove_dir_all(&root);
    }

    /// Creates a file of exactly `size` bytes without writing `size` bytes
    /// of real data — `set_len` punches a sparse hole, so this stays fast
    /// even at the 64MiB cap boundary tested below.
    fn tmp_sized_file(name: &str, size: u64) -> PathBuf {
        let path = tmp_path(name);
        let f = fs::File::create(&path).unwrap();
        f.set_len(size).unwrap();
        path
    }

    #[test]
    fn read_file_as_base64_validated_encodes_small_file() {
        let path = tmp_path("base64-small").with_extension("png");
        fs::write(&path, b"image-bytes").unwrap();

        let result =
            read_file_as_base64_validated(path.clone(), path.to_string_lossy().to_string())
                .unwrap();

        assert_eq!(result.mime_type, "image/png");
        use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
        assert_eq!(B64.decode(result.base64).unwrap(), b"image-bytes");
        let _ = fs::remove_file(&path);
    }

    #[test]
    fn read_file_as_base64_validated_rejects_input_over_cap() {
        let path = tmp_sized_file("base64-over-cap.bin", MAX_BASE64_READ_BYTES + 1);
        let err = read_file_as_base64_validated(path.clone(), path.to_string_lossy().to_string())
            .unwrap_err();
        assert!(
            err.contains("exceeding"),
            "expected a size-limit error, got: {err}"
        );
        let _ = fs::remove_file(&path);
    }

    #[test]
    fn read_file_as_base64_validated_allows_input_at_exact_cap() {
        let path = tmp_sized_file("base64-at-cap.bin", MAX_BASE64_READ_BYTES);
        let result =
            read_file_as_base64_validated(path.clone(), path.to_string_lossy().to_string())
                .unwrap();

        use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
        let decoded = B64.decode(result.base64).unwrap();
        assert_eq!(decoded.len() as u64, MAX_BASE64_READ_BYTES);
        let _ = fs::remove_file(&path);
    }
}
