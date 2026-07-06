use std::collections::BTreeMap;
use std::fs;
use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::AppHandle;

use super::{
    err, load_app_state, ok, parse_query, percent_decode, relative_to_project, safe_join,
    ApiResponse,
};
use crate::{clip_server, commands};

const MAX_FILE_CONTENT_BYTES: u64 = 2 * 1024 * 1024;
const DEFAULT_MAX_FILES: usize = 2_000;
const HARD_MAX_FILES: usize = 10_000;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(super) struct ProjectEntry {
    pub(super) id: String,
    name: String,
    pub(super) path: String,
    current: bool,
}

#[derive(Debug)]
enum FileListingError {
    TooManyFiles(String),
    Other(String),
}

impl FileListingError {
    fn into_api_response(self) -> ApiResponse {
        match self {
            FileListingError::TooManyFiles(message) => err(413, message),
            FileListingError::Other(message) => err(500, message),
        }
    }
}

pub(super) fn handle_projects(app: &AppHandle) -> ApiResponse {
    let projects = load_projects(app);
    let current_project = projects.iter().find(|project| project.current).cloned();
    ok(json!({
        "ok": true,
        "projects": projects,
        "currentProject": current_project,
    }))
}

fn load_projects(app: &AppHandle) -> Vec<ProjectEntry> {
    let current = normalize_path(&clip_server::current_project_path());
    let mut by_path: BTreeMap<String, ProjectEntry> = BTreeMap::new();

    if let Some(parsed) = load_app_state(app) {
        if let Some(registry) = parsed.get("projectRegistry").and_then(Value::as_object) {
            for (id, value) in registry {
                let path = value.get("path").and_then(Value::as_str).unwrap_or("");
                if path.is_empty() {
                    continue;
                }
                let path = normalize_path(path);
                let name = value
                    .get("name")
                    .and_then(Value::as_str)
                    .map(ToOwned::to_owned)
                    .unwrap_or_else(|| project_name_from_path(&path));
                by_path.insert(
                    path.clone(),
                    ProjectEntry {
                        id: id.clone(),
                        name,
                        current: path == current,
                        path,
                    },
                );
            }
        }
        if let Some(recents) = parsed.get("recentProjects").and_then(Value::as_array) {
            for value in recents {
                let path = value.get("path").and_then(Value::as_str).unwrap_or("");
                if path.is_empty() {
                    continue;
                }
                let path = normalize_path(path);
                by_path.entry(path.clone()).or_insert_with(|| {
                    let id = read_project_id(&path).unwrap_or_else(|| path.clone());
                    let name = value
                        .get("name")
                        .and_then(Value::as_str)
                        .map(ToOwned::to_owned)
                        .unwrap_or_else(|| project_name_from_path(&path));
                    ProjectEntry {
                        id,
                        name,
                        current: path == current,
                        path,
                    }
                });
            }
        }
    }

    for (name, path) in clip_server::all_projects() {
        let path = normalize_path(&path);
        by_path.entry(path.clone()).or_insert_with(|| ProjectEntry {
            id: read_project_id(&path).unwrap_or_else(|| path.clone()),
            name: if name.is_empty() {
                project_name_from_path(&path)
            } else {
                name
            },
            current: path == current,
            path,
        });
    }

    if !current.is_empty() {
        by_path
            .entry(current.clone())
            .or_insert_with(|| ProjectEntry {
                id: read_project_id(&current).unwrap_or_else(|| current.clone()),
                name: project_name_from_path(&current),
                current: true,
                path: current.clone(),
            });
    }

    by_path.into_values().collect()
}

fn resolve_project(app: &AppHandle, project_id: &str) -> Result<ProjectEntry, String> {
    let project_id = percent_decode(project_id);
    let wants_current = project_id.eq_ignore_ascii_case("current");
    load_projects(app)
        .into_iter()
        .find(|p| {
            p.id == project_id
                || project_path_matches(&p.path, &project_id)
                || (wants_current && p.current)
        })
        .ok_or_else(|| format!("Unknown project: {project_id}"))
}

pub(super) fn resolve_project_or_404(
    app: &AppHandle,
    project_id: &str,
) -> Result<ProjectEntry, ApiResponse> {
    resolve_project(app, project_id).map_err(|e| err(404, e))
}

pub(super) fn project_path_matches(stored_path: &str, candidate: &str) -> bool {
    let stored = normalize_path(stored_path);
    let candidate = normalize_path(candidate);
    if cfg!(windows) {
        stored.eq_ignore_ascii_case(&candidate)
    } else {
        stored == candidate
    }
}

fn read_project_id(path: &str) -> Option<String> {
    let raw = fs::read_to_string(Path::new(path).join(".llm-wiki/project.json")).ok()?;
    let parsed: Value = serde_json::from_str(&raw).ok()?;
    parsed
        .get("id")
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
}

fn project_name_from_path(path: &str) -> String {
    Path::new(path)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("Project")
        .to_string()
}

fn normalize_path(path: &str) -> String {
    path.replace('\\', "/").trim_end_matches('/').to_string()
}

pub(super) fn handle_files(app: &AppHandle, project_id: &str, query: &str) -> ApiResponse {
    let project = match resolve_project_or_404(app, project_id) {
        Ok(project) => project,
        Err(response) => return response,
    };
    let params = parse_query(query);
    let root = params.get("root").map(String::as_str).unwrap_or("wiki");
    let recursive = params
        .get("recursive")
        .map(|v| v != "false")
        .unwrap_or(true);
    let max_files = params
        .get("maxFiles")
        .and_then(|v| v.parse::<usize>().ok())
        .unwrap_or(DEFAULT_MAX_FILES)
        .clamp(1, HARD_MAX_FILES);
    let rel = match root {
        "wiki" => "wiki",
        "sources" | "raw" | "raw/sources" => "raw/sources",
        "all" | "" => "",
        _ => return err(400, "root must be wiki, sources, or all"),
    };
    if rel.is_empty() {
        return match list_public_roots(&project.path, recursive, max_files) {
            Ok(files) => ok(json!({
                "ok": true,
                "projectId": project.id,
                "root": "all",
                "files": files,
                "truncated": false,
            })),
            Err(e) => e.into_api_response(),
        };
    }
    let dir = match safe_join(&project.path, rel) {
        Ok(path) => path,
        Err(e) => return err(400, e),
    };
    let mut count = 0;
    match list_tree(&project.path, &dir, recursive, max_files, &mut count) {
        Ok(files) => ok(json!({
            "ok": true,
            "projectId": project.id,
            "root": rel,
            "files": files,
            "truncated": false,
        })),
        Err(e) => e.into_api_response(),
    }
}

pub(super) fn handle_file_content(app: &AppHandle, project_id: &str, query: &str) -> ApiResponse {
    let project = match resolve_project_or_404(app, project_id) {
        Ok(project) => project,
        Err(response) => return response,
    };
    let params = parse_query(query);
    let Some(rel) = params.get("path") else {
        return err(400, "Missing path query parameter");
    };
    if !is_public_project_rel(rel) {
        return err(403, "Path is not exposed by the local API");
    }
    if !is_text_content_rel(rel) {
        return err(
            415,
            "Only text-like project files can be read via this endpoint",
        );
    }
    let path = match safe_join(&project.path, rel) {
        Ok(path) => path,
        Err(e) => return err(400, e),
    };
    let meta = match fs::metadata(&path) {
        Ok(meta) => meta,
        Err(e) => return err(404, format!("File not found: {e}")),
    };
    if meta.len() > MAX_FILE_CONTENT_BYTES {
        return err(413, "File is too large to return via API");
    }
    match fs::read_to_string(&path) {
        Ok(content) => ok(json!({
            "ok": true,
            "projectId": project.id,
            "path": rel,
            "content": content,
        })),
        Err(_) => err(415, "File is not valid UTF-8 text"),
    }
}

pub(super) fn is_public_project_rel(rel: &str) -> bool {
    let rel = normalize_path(rel).trim_start_matches('/').to_string();
    if rel
        .split('/')
        .any(|part| part.is_empty() || part.starts_with('.'))
    {
        return false;
    }
    let lower = rel.to_lowercase();
    lower == "purpose.md"
        || lower == "schema.md"
        || lower.starts_with("wiki/")
        || lower.starts_with("raw/sources/")
}

pub(super) fn is_text_content_rel(rel: &str) -> bool {
    let rel = normalize_path(rel).to_lowercase();
    let ext = Path::new(&rel)
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("");
    matches!(
        ext,
        "md" | "mdx"
            | "txt"
            | "csv"
            | "json"
            | "yaml"
            | "yml"
            | "xml"
            | "html"
            | "htm"
            | "rtf"
            | "log"
    )
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ApiFileNode {
    name: String,
    path: String,
    is_dir: bool,
    size: Option<u64>,
    children: Option<Vec<ApiFileNode>>,
}

fn list_public_roots(
    project_path: &str,
    recursive: bool,
    max_files: usize,
) -> Result<Vec<ApiFileNode>, FileListingError> {
    let mut count = 0;
    let mut roots = Vec::new();
    for rel in ["purpose.md", "schema.md", "wiki", "raw/sources"] {
        let path = safe_join(project_path, rel).map_err(FileListingError::Other)?;
        if !path.exists() {
            continue;
        }
        push_file_node(
            project_path,
            &path,
            recursive,
            max_files,
            &mut count,
            &mut roots,
        )?;
    }
    Ok(roots)
}

fn list_tree(
    project_path: &str,
    path: &Path,
    recursive: bool,
    max_files: usize,
    count: &mut usize,
) -> Result<Vec<ApiFileNode>, FileListingError> {
    let mut out = Vec::new();
    let entries = fs::read_dir(path)
        .map_err(|e| FileListingError::Other(format!("Failed to list directory: {e}")))?;
    for entry in entries {
        let entry = entry
            .map_err(|e| FileListingError::Other(format!("Failed to read directory entry: {e}")))?;
        push_file_node(
            project_path,
            &entry.path(),
            recursive,
            max_files,
            count,
            &mut out,
        )?;
    }
    out.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then_with(|| a.name.cmp(&b.name)));
    Ok(out)
}

fn push_file_node(
    project_path: &str,
    path: &Path,
    recursive: bool,
    max_files: usize,
    count: &mut usize,
    out: &mut Vec<ApiFileNode>,
) -> Result<(), FileListingError> {
    let name = path
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_string();
    if name.starts_with('.') {
        return Ok(());
    }
    let meta = fs::symlink_metadata(path)
        .map_err(|e| FileListingError::Other(format!("Failed to read metadata: {e}")))?;
    let file_type = meta.file_type();
    if file_type.is_symlink() {
        return Ok(());
    }
    *count += 1;
    if *count > max_files {
        return Err(FileListingError::TooManyFiles(format!(
            "File listing exceeds maxFiles limit ({max_files})"
        )));
    }
    let is_dir = file_type.is_dir();
    let children = if recursive && is_dir {
        Some(list_tree(project_path, path, true, max_files, count)?)
    } else {
        None
    };
    out.push(ApiFileNode {
        name,
        path: relative_to_project(project_path, path),
        is_dir,
        size: if is_dir { None } else { Some(meta.len()) },
        children,
    });
    Ok(())
}

pub(super) fn handle_rescan(app: &AppHandle, project_id: &str) -> ApiResponse {
    let project = match resolve_project_or_404(app, project_id) {
        Ok(project) => project,
        Err(response) => return response,
    };
    let source_watch_config = load_source_watch_config(app, &project.id);
    match commands::file_sync::rescan_project_files(
        app.clone(),
        project.id.clone(),
        project.path.clone(),
        source_watch_config,
    ) {
        Ok(result) => ok(json!({ "ok": true, "projectId": project.id, "result": result })),
        Err(e) => err(500, e),
    }
}

fn load_source_watch_config(
    app: &AppHandle,
    project_id: &str,
) -> Option<commands::file_sync::SourceWatchConfig> {
    let parsed = load_app_state(app)?;
    let settings = parsed.get("sourceWatchConfig").and_then(Value::as_object);
    if let Some(value) = settings
        .and_then(|s| s.get(project_id).or_else(|| s.get("default")))
        .cloned()
    {
        if let Ok(config) = serde_json::from_value::<commands::file_sync::SourceWatchConfig>(value)
        {
            return Some(config);
        }
    }
    let legacy_enabled = parsed
        .get("projectFileSyncEnabled")
        .and_then(Value::as_object)
        .and_then(|settings| {
            settings
                .get(project_id)
                .or_else(|| settings.get("default"))
                .and_then(Value::as_bool)
        });
    legacy_enabled.and_then(|enabled| {
        serde_json::from_value::<commands::file_sync::SourceWatchConfig>(
            json!({ "enabled": enabled }),
        )
        .ok()
    })
}
