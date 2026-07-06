use std::fs;
use std::path::Path;

use serde::Deserialize;
use serde_json::{json, Map, Value};
use tauri::AppHandle;

use super::projects::resolve_project_or_404;
use super::{err, load_app_state, ok, parse_query, ApiResponse};
use crate::commands;

const DEFAULT_MAX_REVIEWS: usize = 200;
const HARD_MAX_REVIEWS: usize = 1_000;
const MAX_SEARCH_RESULTS: usize = 50;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum ReviewStatus {
    Unresolved,
    Resolved,
    All,
}

impl ReviewStatus {
    pub(super) fn as_str(self) -> &'static str {
        match self {
            ReviewStatus::Unresolved => "unresolved",
            ReviewStatus::Resolved => "resolved",
            ReviewStatus::All => "all",
        }
    }

    fn matches(self, resolved: bool) -> bool {
        match self {
            ReviewStatus::Unresolved => !resolved,
            ReviewStatus::Resolved => resolved,
            ReviewStatus::All => true,
        }
    }
}

#[derive(Debug, Clone)]
pub(super) struct ReviewQuery {
    pub(super) status: ReviewStatus,
    item_type: Option<String>,
    limit: usize,
}

pub(super) fn parse_review_query(query: &str) -> Result<ReviewQuery, String> {
    let params = parse_query(query);
    let status = match params
        .get("status")
        .map(|s| s.as_str())
        .unwrap_or("unresolved")
    {
        "unresolved" | "pending" => ReviewStatus::Unresolved,
        "resolved" => ReviewStatus::Resolved,
        "all" => ReviewStatus::All,
        value => {
            return Err(format!(
                "Invalid review status '{value}'. Expected unresolved, resolved, or all"
            ))
        }
    };
    let item_type = params
        .get("type")
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    let limit = params
        .get("limit")
        .and_then(|s| s.parse::<usize>().ok())
        .unwrap_or(DEFAULT_MAX_REVIEWS)
        .clamp(1, HARD_MAX_REVIEWS);

    Ok(ReviewQuery {
        status,
        item_type,
        limit,
    })
}

pub(super) fn load_review_items(
    project_path: &str,
    query: &ReviewQuery,
) -> Result<Vec<Value>, String> {
    let path = Path::new(project_path).join(".llm-wiki/review.json");
    let raw = match fs::read_to_string(&path) {
        Ok(raw) => raw,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(err) => return Err(format!("Failed to read review state: {err}")),
    };
    let parsed: Value =
        serde_json::from_str(&raw).map_err(|err| format!("Invalid review state JSON: {err}"))?;
    let items = parsed
        .as_array()
        .ok_or_else(|| "Invalid review state JSON: expected an array".to_string())?;

    let mut reviews = Vec::new();
    for item in items {
        let resolved = item
            .get("resolved")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        if !query.status.matches(resolved) {
            continue;
        }
        if let Some(item_type) = &query.item_type {
            if item.get("type").and_then(Value::as_str) != Some(item_type.as_str()) {
                continue;
            }
        }
        reviews.push(sanitize_review_item(item));
        if reviews.len() >= query.limit {
            break;
        }
    }

    Ok(reviews)
}

fn sanitize_review_item(item: &Value) -> Value {
    let mut out = Map::new();
    copy_string_field(item, &mut out, "id");
    copy_string_field(item, &mut out, "type");
    copy_string_field(item, &mut out, "title");
    copy_string_field(item, &mut out, "description");
    copy_string_field(item, &mut out, "sourcePath");
    copy_string_array_field(item, &mut out, "affectedPages");
    copy_string_array_field(item, &mut out, "searchQueries");
    copy_review_options(item, &mut out);
    copy_bool_field(item, &mut out, "resolved");
    copy_string_field(item, &mut out, "resolvedAction");
    copy_number_field(item, &mut out, "createdAt");
    Value::Object(out)
}

fn copy_string_field(item: &Value, out: &mut Map<String, Value>, key: &str) {
    if let Some(value) = item.get(key).and_then(Value::as_str) {
        out.insert(key.to_string(), Value::String(value.to_string()));
    }
}

fn copy_bool_field(item: &Value, out: &mut Map<String, Value>, key: &str) {
    if let Some(value) = item.get(key).and_then(Value::as_bool) {
        out.insert(key.to_string(), Value::Bool(value));
    }
}

fn copy_number_field(item: &Value, out: &mut Map<String, Value>, key: &str) {
    if let Some(value) = item.get(key).and_then(Value::as_f64) {
        if value.is_finite() {
            out.insert(key.to_string(), json!(value));
        }
    }
}

fn copy_string_array_field(item: &Value, out: &mut Map<String, Value>, key: &str) {
    let Some(values) = item.get(key).and_then(Value::as_array) else {
        return;
    };
    let strings = values
        .iter()
        .filter_map(Value::as_str)
        .map(|value| Value::String(value.to_string()))
        .collect::<Vec<_>>();
    out.insert(key.to_string(), Value::Array(strings));
}

fn copy_review_options(item: &Value, out: &mut Map<String, Value>) {
    let Some(values) = item.get("options").and_then(Value::as_array) else {
        return;
    };
    let options = values
        .iter()
        .filter_map(|option| {
            let option = option.as_object()?;
            let mut sanitized = Map::new();
            if let Some(label) = option.get("label").and_then(Value::as_str) {
                sanitized.insert("label".to_string(), Value::String(label.to_string()));
            }
            if let Some(action) = option.get("action").and_then(Value::as_str) {
                sanitized.insert("action".to_string(), Value::String(action.to_string()));
            }
            if sanitized.is_empty() {
                None
            } else {
                Some(Value::Object(sanitized))
            }
        })
        .collect::<Vec<_>>();
    out.insert("options".to_string(), Value::Array(options));
}

pub(super) fn handle_reviews(app: &AppHandle, project_id: &str, query: &str) -> ApiResponse {
    let project = match resolve_project_or_404(app, project_id) {
        Ok(project) => project,
        Err(response) => return response,
    };
    let query = match parse_review_query(query) {
        Ok(query) => query,
        Err(e) => return err(400, e),
    };
    match load_review_items(&project.path, &query) {
        Ok(reviews) => ok(json!({
            "ok": true,
            "projectId": project.id,
            "status": query.status.as_str(),
            "count": reviews.len(),
            "reviews": reviews,
        })),
        Err(e) => err(500, e),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SearchRequest {
    query: String,
    top_k: Option<usize>,
    include_content: Option<bool>,
    query_embedding: Option<Vec<f32>>,
}

pub(super) fn handle_search(app: &AppHandle, project_id: &str, body: &str) -> ApiResponse {
    let project = match resolve_project_or_404(app, project_id) {
        Ok(project) => project,
        Err(response) => return response,
    };
    let req: SearchRequest = match serde_json::from_str(body) {
        Ok(req) => req,
        Err(e) => return err(400, format!("Invalid JSON: {e}")),
    };
    if req.query.trim().is_empty() {
        return err(400, "query is required");
    }
    let top_k = req.top_k.unwrap_or(10).clamp(1, MAX_SEARCH_RESULTS);
    let query = req.query;
    let query_embedding =
        match tauri::async_runtime::block_on(commands::search::resolve_query_embedding(
            &query,
            req.query_embedding,
            load_embedding_config(app),
        )) {
            Ok(embedding) => embedding,
            Err(e) => return err(400, e),
        };
    match tauri::async_runtime::block_on(commands::search::search_project_inner(
        project.path.clone(),
        query,
        top_k,
        req.include_content.unwrap_or(false),
        query_embedding,
    )) {
        Ok(search) => ok(json!({
            "ok": true,
            "projectId": project.id,
            "mode": search.mode,
            "note": "Search uses the shared backend retrieval service. When embeddingConfig is enabled, the API automatically includes LanceDB vector results; clients may also pass queryEmbedding explicitly.",
            "tokenHits": search.token_hits,
            "vectorHits": search.vector_hits,
            "results": search.results,
        })),
        Err(e) => err(500, e),
    }
}

fn load_embedding_config(app: &AppHandle) -> Option<commands::search::SearchEmbeddingConfig> {
    let parsed = load_app_state(app)?;
    let value = parsed.get("embeddingConfig")?.clone();
    serde_json::from_value::<commands::search::SearchEmbeddingConfig>(value).ok()
}
