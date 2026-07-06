use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::Path;

use serde::Serialize;
use serde_json::json;
use tauri::AppHandle;
use walkdir::WalkDir;

use super::projects::resolve_project_or_404;
use super::{err, ok, parse_query, relative_to_project, ApiResponse};
use crate::commands;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ApiGraphNode {
    pub(super) id: String,
    label: String,
    node_type: String,
    path: String,
    pub(super) link_count: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ApiGraphEdge {
    pub(super) source: String,
    pub(super) target: String,
    weight: f64,
}

#[derive(Debug, Clone)]
struct RawGraphNode {
    label: String,
    node_type: String,
    // API/frontend open-file path. Currently equal to `wiki_path`, but kept
    // separate from resolver identity so future response-path changes do not
    // silently alter graph link matching.
    path: String,
    // Canonical wiki-relative markdown path used for resolver identity.
    wiki_path: String,
    legacy_stem: String,
    links: Vec<String>,
}

#[derive(Debug, Default)]
struct GraphLinkResolver {
    ids: BTreeSet<String>,
    by_path: BTreeMap<String, Vec<String>>,
    by_path_slug: BTreeMap<String, Vec<String>>,
    by_legacy_stem: BTreeMap<String, Vec<String>>,
    by_legacy_slug: BTreeMap<String, Vec<String>>,
}

impl GraphLinkResolver {
    fn from_nodes(nodes: &BTreeMap<String, RawGraphNode>) -> Self {
        let mut resolver = Self::default();
        for (id, node) in nodes {
            resolver.ids.insert(id.clone());
            resolver
                .by_path
                .entry(node.wiki_path.to_lowercase())
                .or_default()
                .push(id.clone());
            resolver
                .by_path_slug
                .entry(graph_ref_key(&node.wiki_path))
                .or_default()
                .push(id.clone());
            resolver
                .by_legacy_stem
                .entry(node.legacy_stem.to_lowercase())
                .or_default()
                .push(id.clone());
            resolver
                .by_legacy_slug
                .entry(graph_ref_key(&node.legacy_stem))
                .or_default()
                .push(id.clone());
        }
        resolver
    }

    fn unique(map: &BTreeMap<String, Vec<String>>, key: &str) -> Option<String> {
        let matches = map.get(key)?;
        if matches.len() == 1 {
            matches.first().cloned()
        } else {
            None
        }
    }

    fn resolve(&self, raw: &str) -> Option<String> {
        if self.ids.contains(raw) {
            return Some(raw.to_string());
        }

        if let Some(wiki_path) = wikilink_to_wiki_path(raw) {
            if let Some(id) = Self::unique(&self.by_path, &wiki_path.to_lowercase()) {
                return Some(id);
            }
            if let Some(id) = Self::unique(&self.by_path_slug, &graph_ref_key(&wiki_path)) {
                return Some(id);
            }
        }

        if raw.contains('/') || raw.contains('\\') {
            return None;
        }

        let stem = strip_markdown_extension(raw.trim());
        Self::unique(&self.by_legacy_stem, &stem.to_lowercase())
            .or_else(|| Self::unique(&self.by_legacy_slug, &graph_ref_key(stem)))
    }
}

pub(super) fn handle_graph(app: &AppHandle, project_id: &str, query: &str) -> ApiResponse {
    let project = match resolve_project_or_404(app, project_id) {
        Ok(project) => project,
        Err(response) => return response,
    };
    let params = parse_query(query);
    let q = params.get("q").map(|s| s.to_lowercase());
    let node_type = params.get("nodeType").map(|s| s.to_lowercase());
    let limit = params
        .get("limit")
        .and_then(|s| s.parse::<usize>().ok())
        .unwrap_or(200)
        .clamp(1, 1000);

    match build_graph(&project.path) {
        Ok((mut nodes, edges)) => {
            if let Some(ref q) = q {
                nodes.retain(|n| {
                    n.id.to_lowercase().contains(q) || n.label.to_lowercase().contains(q)
                });
            }
            if let Some(ref node_type) = node_type {
                nodes.retain(|n| n.node_type == *node_type);
            }
            nodes.truncate(limit);
            let ids: BTreeSet<String> = nodes.iter().map(|n| n.id.clone()).collect();
            let edges: Vec<ApiGraphEdge> = edges
                .into_iter()
                .filter(|e| ids.contains(&e.source) && ids.contains(&e.target))
                .collect();
            ok(json!({ "ok": true, "projectId": project.id, "nodes": nodes, "edges": edges }))
        }
        Err(e) => err(500, e),
    }
}

pub(super) fn build_graph(
    project_path: &str,
) -> Result<(Vec<ApiGraphNode>, Vec<ApiGraphEdge>), String> {
    let wiki_root = Path::new(project_path).join("wiki");
    let mut raw: BTreeMap<String, RawGraphNode> = BTreeMap::new();
    for entry in WalkDir::new(&wiki_root).into_iter().filter_map(Result::ok) {
        if !entry.file_type().is_file()
            || entry.path().extension().and_then(|s| s.to_str()) != Some("md")
        {
            continue;
        }
        let content = match fs::read_to_string(entry.path()) {
            Ok(content) => content,
            Err(_) => continue,
        };
        let path = relative_to_project(project_path, entry.path());
        let Some(id) = commands::search::wiki_relative_path_to_vector_page_id(&path) else {
            continue;
        };
        let title =
            commands::search::extract_title(&content, entry.file_name().to_string_lossy().as_ref());
        let node_type = extract_type(&content);
        if node_type == "query" {
            continue;
        }
        let legacy_stem = entry
            .path()
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_string();
        let links = extract_wikilinks(&content);
        raw.insert(
            id,
            RawGraphNode {
                label: title,
                node_type,
                wiki_path: path.clone(),
                path,
                legacy_stem,
                links,
            },
        );
    }
    let resolver = GraphLinkResolver::from_nodes(&raw);
    let mut link_count: BTreeMap<String, usize> = raw.keys().map(|id| (id.clone(), 0)).collect();
    let mut seen = BTreeSet::new();
    let mut edges = Vec::new();
    for (source, node) in &raw {
        for link in &node.links {
            let Some(target) = resolve_link(link, &resolver) else {
                continue;
            };
            if &target == source {
                continue;
            }
            let key = if source < &target {
                format!("{source}::{target}")
            } else {
                format!("{target}::{source}")
            };
            if seen.insert(key) {
                *link_count.entry(source.clone()).or_default() += 1;
                *link_count.entry(target.clone()).or_default() += 1;
                edges.push(ApiGraphEdge {
                    source: source.clone(),
                    target,
                    weight: 1.0,
                });
            }
        }
    }
    let nodes = raw
        .into_iter()
        .map(|(id, node)| ApiGraphNode {
            link_count: *link_count.get(&id).unwrap_or(&0),
            id,
            label: node.label,
            node_type: node.node_type,
            path: node.path,
        })
        .collect();
    Ok((nodes, edges))
}

fn extract_type(content: &str) -> String {
    for line in content.lines() {
        if let Some(value) = line.trim().strip_prefix("type:") {
            return value
                .trim()
                .trim_matches('"')
                .trim_matches('\'')
                .to_lowercase();
        }
    }
    "other".to_string()
}

fn extract_wikilinks(content: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut rest = content;
    while let Some(start) = rest.find("[[") {
        rest = &rest[start + 2..];
        let Some(end) = rest.find("]]") else {
            break;
        };
        let inner = &rest[..end];
        let target = inner.split('|').next().unwrap_or("").trim();
        if !target.is_empty() {
            out.push(target.to_string());
        }
        rest = &rest[end + 2..];
    }
    out
}

fn graph_ref_key(raw: &str) -> String {
    raw.trim()
        .to_lowercase()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join("-")
}

fn strip_markdown_extension(raw: &str) -> &str {
    raw.strip_suffix(".md")
        .or_else(|| raw.strip_suffix(".MD"))
        .or_else(|| raw.strip_suffix(".Md"))
        .or_else(|| raw.strip_suffix(".mD"))
        .unwrap_or(raw)
}

fn wikilink_to_wiki_path(raw: &str) -> Option<String> {
    let mut target = raw.trim().replace('\\', "/");
    if target.is_empty() || target.starts_with('/') || target.contains(':') {
        return None;
    }
    if !target.starts_with("wiki/") {
        target = format!("wiki/{target}");
    }
    if !target.ends_with(".md") {
        target.push_str(".md");
    }
    if target
        .split('/')
        .any(|segment| segment.is_empty() || segment == "." || segment == "..")
    {
        return None;
    }
    Some(target)
}

fn resolve_link(raw: &str, resolver: &GraphLinkResolver) -> Option<String> {
    resolver.resolve(raw)
}
