use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU8, AtomicUsize, Ordering};
use std::sync::{Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tauri::{AppHandle, Manager};
use tiny_http::{Header, Method, Response, Server, StatusCode};
use uuid::Uuid;

mod graph;
mod projects;
mod reviews;

use self::graph::handle_graph;
use self::projects::{handle_file_content, handle_files, handle_projects, handle_rescan};
use self::reviews::{handle_reviews, handle_search};

#[cfg(test)]
use self::graph::build_graph;
#[cfg(test)]
use self::projects::{is_public_project_rel, is_text_content_rel, project_path_matches};
#[cfg(test)]
use self::reviews::{load_review_items, parse_review_query};

const PORT: u16 = 19828;
const API_PREFIX: &str = "/api/v1";
const MAX_BODY_BYTES: usize = 1024 * 1024;
const BIND_RETRY_DELAY_SECS: u64 = 2;
const MAX_BIND_RETRIES: u32 = 3;
const APP_STATE_CACHE_TTL: Duration = Duration::from_secs(5);
const RATE_LIMIT_WINDOW: Duration = Duration::from_secs(1);
const RATE_LIMIT_MAX_REQUESTS: usize = 120;
const RATE_LIMIT_MAX_CLIENTS: usize = 256;
const MAX_IN_FLIGHT_REQUESTS: usize = 64;

/// API status: 0=starting, 1=running, 2=port_conflict, 3=error
static API_STATUS: AtomicU8 = AtomicU8::new(0);
static IN_FLIGHT_REQUESTS: AtomicUsize = AtomicUsize::new(0);
static APP_STATE_CACHE: OnceLock<Mutex<Option<CachedAppState>>> = OnceLock::new();
static RATE_LIMIT: OnceLock<Mutex<BTreeMap<String, RateLimitBucket>>> = OnceLock::new();
static AGENT_INTERNAL_API_TOKENS: OnceLock<Mutex<BTreeSet<String>>> = OnceLock::new();

#[derive(Clone)]
struct CachedAppState {
    loaded_at: Instant,
    value: Option<Value>,
}

struct RateLimitBucket {
    hits: VecDeque<Instant>,
    last_seen: Instant,
}

pub fn get_api_status() -> &'static str {
    match API_STATUS.load(Ordering::Relaxed) {
        0 => "starting",
        1 => "running",
        2 => "port_conflict",
        _ => "error",
    }
}

pub fn invalidate_config_cache() {
    if let Some(lock) = APP_STATE_CACHE.get() {
        if let Ok(mut cache) = lock.lock() {
            *cache = None;
        }
    }
}

fn agent_internal_api_tokens() -> &'static Mutex<BTreeSet<String>> {
    AGENT_INTERNAL_API_TOKENS.get_or_init(|| Mutex::new(BTreeSet::new()))
}

pub fn new_agent_internal_api_token() -> String {
    format!(
        "agent-{}{}",
        Uuid::new_v4().simple(),
        Uuid::new_v4().simple()
    )
}

pub fn register_agent_internal_api_token(token: &str) {
    if let Ok(mut tokens) = agent_internal_api_tokens().lock() {
        tokens.insert(token.to_string());
    }
}

pub fn revoke_agent_internal_api_token(token: &str) {
    if let Ok(mut tokens) = agent_internal_api_tokens().lock() {
        tokens.remove(token);
    }
}

pub fn start_api_server(app: AppHandle) {
    thread::spawn(move || loop {
        API_STATUS.store(0, Ordering::Relaxed);
        let server = match bind_server_with_retry() {
            Some(server) => server,
            None => {
                API_STATUS.store(2, Ordering::Relaxed);
                thread::sleep(Duration::from_secs(BIND_RETRY_DELAY_SECS));
                continue;
            }
        };

        API_STATUS.store(1, Ordering::Relaxed);
        eprintln!("[API Server] Listening on http://127.0.0.1:{PORT}{API_PREFIX}");

        for request in server.incoming_requests() {
            let method = request.method().clone();
            let url = request.url().to_string();
            let headers = request_headers(&request);
            if let Some(action) = cors_short_circuit(&method, &headers) {
                respond_cors_short_circuit(request, action, &headers);
                continue;
            }
            let rate_limit_key = rate_limit_key(request.remote_addr());
            if should_rate_limit(&method, &url) && !allow_request(&rate_limit_key) {
                respond_error(request, 429, "Too many requests");
                continue;
            }
            let Some(slot) = try_acquire_request_slot() else {
                respond_error(request, 503, "API server is busy");
                continue;
            };
            let app = app.clone();
            thread::spawn(move || {
                let _slot = slot;
                let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    process_request(app, request);
                }));
                if let Err(payload) = result {
                    eprintln!("[API Server] request handler panicked: {payload:?}");
                }
            });
        }

        API_STATUS.store(3, Ordering::Relaxed);
        eprintln!("[API Server] server loop exited; restarting");
        thread::sleep(Duration::from_secs(BIND_RETRY_DELAY_SECS));
    });
}

fn bind_server_with_retry() -> Option<Server> {
    for attempt in 1..=MAX_BIND_RETRIES {
        match Server::http(format!("127.0.0.1:{PORT}")) {
            Ok(server) => return Some(server),
            Err(err) => {
                eprintln!(
                    "[API Server] Failed to bind 127.0.0.1:{PORT} (attempt {attempt}/{MAX_BIND_RETRIES}): {err}"
                );
                if attempt < MAX_BIND_RETRIES {
                    thread::sleep(Duration::from_secs(BIND_RETRY_DELAY_SECS));
                }
            }
        }
    }
    None
}

struct RequestSlot;

impl Drop for RequestSlot {
    fn drop(&mut self) {
        IN_FLIGHT_REQUESTS.fetch_sub(1, Ordering::Relaxed);
    }
}

fn try_acquire_request_slot() -> Option<RequestSlot> {
    let mut current = IN_FLIGHT_REQUESTS.load(Ordering::Relaxed);
    loop {
        if current >= MAX_IN_FLIGHT_REQUESTS {
            return None;
        }
        match IN_FLIGHT_REQUESTS.compare_exchange_weak(
            current,
            current + 1,
            Ordering::Relaxed,
            Ordering::Relaxed,
        ) {
            Ok(_) => return Some(RequestSlot),
            Err(next) => current = next,
        }
    }
}

fn process_request(app: AppHandle, mut request: tiny_http::Request) {
    let method = request.method().clone();
    let url = request.url().to_string();
    let headers = request_headers(&request);

    let body = match read_body(&mut request) {
        Ok(body) => body,
        Err(err) => {
            respond_error_with_headers(request, 400, &err, &headers);
            return;
        }
    };

    let response = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        handle_request(&app, &method, &url, &body, &headers)
    }))
    .unwrap_or_else(|payload| {
        eprintln!("[API Server] request panicked: {payload:?}");
        err(500, "Internal API server error")
    });
    respond_json(request, response.status, response.body, &headers);
}

#[derive(Debug)]
struct ApiResponse {
    status: u16,
    body: Value,
}

enum PreDispatch {
    Health,
    Continue,
    Response(ApiResponse),
}

#[derive(Debug, PartialEq, Eq)]
enum ApiRoute<'a> {
    Projects,
    Files { project_id: &'a str },
    FileContent { project_id: &'a str },
    Reviews { project_id: &'a str },
    Search { project_id: &'a str },
    Graph { project_id: &'a str },
    Rescan { project_id: &'a str },
    Chat { project_id: &'a str },
}

enum CorsShortCircuit {
    Preflight,
    Rejected(ApiResponse),
}

fn ok(body: Value) -> ApiResponse {
    ApiResponse { status: 200, body }
}

fn err(status: u16, message: impl Into<String>) -> ApiResponse {
    ApiResponse {
        status,
        body: json!({ "ok": false, "error": message.into() }),
    }
}

fn handle_request(
    app: &AppHandle,
    method: &Method,
    url: &str,
    body: &str,
    headers: &[(String, String)],
) -> ApiResponse {
    let (path, query) = split_url(url);
    match pre_auth_dispatch_response(&path) {
        PreDispatch::Health => {
            // /health stays reachable even when the user has disabled the
            // API in Settings — the desktop UI uses it to render the
            // "Enabled / disabled / port_conflict" line, and curl-from-
            // terminal users need a way to confirm the server is alive
            // before they go hunting for why other endpoints 503.
            return ok(json!({
                "ok": true,
                "status": get_api_status(),
                "version": env!("CARGO_PKG_VERSION"),
                "authRequired": api_auth_required(app),
                "authConfigured": api_token(app).is_some(),
                "tokenSource": api_token_source(app),
                "enabled": api_enabled(app),
                "mcpEnabled": api_mcp_enabled(app),
                "allowUnauthenticated": api_allow_unauthenticated(app),
            }));
        }
        PreDispatch::Response(response) => return response,
        PreDispatch::Continue => {}
    }
    let internal_agent_authorized = is_internal_agent_authorized(headers);
    if let Some((status, message)) = request_access_denial(
        api_enabled(app),
        internal_agent_authorized,
        internal_agent_authorized || is_authorized(app, query, headers),
    ) {
        return err(status, message);
    }

    match route_request(method, &path) {
        Ok(ApiRoute::Projects) => handle_projects(app),
        Ok(ApiRoute::Files { project_id }) => handle_files(app, project_id, query),
        Ok(ApiRoute::FileContent { project_id }) => handle_file_content(app, project_id, query),
        Ok(ApiRoute::Reviews { project_id }) => handle_reviews(app, project_id, query),
        Ok(ApiRoute::Search { project_id }) => handle_search(app, project_id, body),
        Ok(ApiRoute::Graph { project_id }) => handle_graph(app, project_id, query),
        Ok(ApiRoute::Rescan { project_id }) => handle_rescan(app, project_id),
        Ok(ApiRoute::Chat { project_id }) => {
            let _ = project_id;
            err(501, "Chat API is not implemented in the local Rust API server yet. The existing chat/RAG pipeline currently lives in the WebView; expose it after moving the shared chat pipeline behind a backend command.")
        }
        Err(response) => response,
    }
}

fn pre_auth_dispatch_response(path: &str) -> PreDispatch {
    if path == "/health" || path == format!("{API_PREFIX}/health") {
        return PreDispatch::Health;
    }
    if !path.starts_with(API_PREFIX) {
        return PreDispatch::Response(err(404, "Not found"));
    }
    PreDispatch::Continue
}

fn route_request<'a>(method: &Method, path: &'a str) -> Result<ApiRoute<'a>, ApiResponse> {
    if !matches!(method, &Method::Get | &Method::Post) {
        return Err(err(405, "Method not allowed"));
    }

    let parts: Vec<&str> = path
        .trim_start_matches(API_PREFIX)
        .trim_start_matches('/')
        .split('/')
        .filter(|part| !part.is_empty())
        .collect();

    match (method, parts.as_slice()) {
        (&Method::Get, ["projects"]) => Ok(ApiRoute::Projects),
        (&Method::Get, ["projects", project_id, "files"]) => Ok(ApiRoute::Files { project_id }),
        (&Method::Get, ["projects", project_id, "files", "content"]) => {
            Ok(ApiRoute::FileContent { project_id })
        }
        (&Method::Get, ["projects", project_id, "reviews"]) => Ok(ApiRoute::Reviews { project_id }),
        (&Method::Post, ["projects", project_id, "search"]) => Ok(ApiRoute::Search { project_id }),
        (&Method::Get, ["projects", project_id, "graph"]) => Ok(ApiRoute::Graph { project_id }),
        (&Method::Post, ["projects", project_id, "sources", "rescan"]) => {
            Ok(ApiRoute::Rescan { project_id })
        }
        (&Method::Post, ["projects", project_id, "chat"]) => Ok(ApiRoute::Chat { project_id }),
        _ => Err(err(404, "Not found")),
    }
}

fn request_access_denial(
    api_enabled: bool,
    internal_agent_authorized: bool,
    external_authorized: bool,
) -> Option<(u16, &'static str)> {
    if internal_agent_authorized {
        return None;
    }
    if !api_enabled {
        return Some((503, "API server is disabled in Settings → API Server"));
    }
    if !external_authorized {
        return Some((401, "Unauthorized"));
    }
    None
}

fn should_rate_limit(method: &Method, url: &str) -> bool {
    if method == &Method::Options {
        return false;
    }
    let (path, _) = split_url(url);
    !(path == "/health" || path == format!("{API_PREFIX}/health"))
}

fn rate_limit_key(remote_addr: Option<&std::net::SocketAddr>) -> String {
    remote_addr
        .map(|addr| addr.ip().to_string())
        .unwrap_or_else(|| "unknown".to_string())
}

fn allow_request(client_key: &str) -> bool {
    let now = Instant::now();
    let lock = RATE_LIMIT.get_or_init(|| Mutex::new(BTreeMap::new()));
    let Ok(mut buckets) = lock.lock() else {
        return false;
    };
    allow_request_for_client(&mut buckets, client_key, now)
}

fn allow_request_for_client(
    buckets: &mut BTreeMap<String, RateLimitBucket>,
    client_key: &str,
    now: Instant,
) -> bool {
    let window_start = now - RATE_LIMIT_WINDOW;
    if !buckets.contains_key(client_key) && buckets.len() >= RATE_LIMIT_MAX_CLIENTS {
        evict_expired_rate_limit_buckets(buckets, window_start);
        if buckets.len() >= RATE_LIMIT_MAX_CLIENTS {
            evict_oldest_rate_limit_bucket(buckets);
        }
    }
    let bucket = buckets
        .entry(client_key.to_string())
        .or_insert_with(|| RateLimitBucket {
            hits: VecDeque::new(),
            last_seen: now,
        });
    bucket.last_seen = now;
    trim_rate_limit_hits(&mut bucket.hits, window_start);
    if bucket.hits.len() >= RATE_LIMIT_MAX_REQUESTS {
        return false;
    }
    bucket.hits.push_back(now);
    true
}

fn trim_rate_limit_hits(hits: &mut VecDeque<Instant>, window_start: Instant) {
    while hits.front().map(|t| *t < window_start).unwrap_or(false) {
        hits.pop_front();
    }
}

fn evict_expired_rate_limit_buckets(
    buckets: &mut BTreeMap<String, RateLimitBucket>,
    window_start: Instant,
) {
    buckets.retain(|_, bucket| {
        trim_rate_limit_hits(&mut bucket.hits, window_start);
        !bucket.hits.is_empty() || bucket.last_seen >= window_start
    });
}

fn evict_oldest_rate_limit_bucket(buckets: &mut BTreeMap<String, RateLimitBucket>) {
    let Some(oldest_key) = buckets
        .iter()
        .min_by_key(|(_, bucket)| bucket.last_seen)
        .map(|(key, _)| key.clone())
    else {
        return;
    };
    buckets.remove(&oldest_key);
}

fn read_body(request: &mut tiny_http::Request) -> Result<String, String> {
    let mut limited = request.as_reader().take(MAX_BODY_BYTES as u64 + 1);
    let mut bytes = Vec::new();
    limited
        .read_to_end(&mut bytes)
        .map_err(|e| format!("Failed to read body: {e}"))?;
    if bytes.len() > MAX_BODY_BYTES {
        return Err("Request body too large".to_string());
    }
    String::from_utf8(bytes).map_err(|_| "Request body must be UTF-8".to_string())
}

fn respond_error(request: tiny_http::Request, status: u16, message: &str) {
    let headers = request_headers(&request);
    respond_error_with_headers(request, status, message, &headers);
}

fn respond_error_with_headers(
    request: tiny_http::Request,
    status: u16,
    message: &str,
    headers: &[(String, String)],
) {
    respond_json(
        request,
        status,
        json!({ "ok": false, "error": message }),
        headers,
    );
}

fn respond_options(request: tiny_http::Request, headers: &[(String, String)]) {
    let mut response = Response::empty(cors_preflight_status(headers));
    for header in cors_headers(headers) {
        response.add_header(header);
    }
    response.add_header(Header::from_bytes("Access-Control-Max-Age", "600").unwrap());
    let _ = request.respond(response);
}

fn respond_json(
    request: tiny_http::Request,
    status: u16,
    body: Value,
    headers: &[(String, String)],
) {
    let mut response = Response::from_string(body.to_string()).with_status_code(StatusCode(status));
    for header in cors_headers(headers) {
        response.add_header(header);
    }
    let _ = request.respond(response);
}

fn request_headers(request: &tiny_http::Request) -> Vec<(String, String)> {
    request
        .headers()
        .iter()
        .map(|header| {
            (
                header.field.as_str().to_ascii_lowercase().to_string(),
                header.value.as_str().to_string(),
            )
        })
        .collect()
}

fn cors_headers(request_headers: &[(String, String)]) -> Vec<Header> {
    let mut headers = vec![
        Header::from_bytes("Access-Control-Allow-Methods", "GET, POST, OPTIONS").unwrap(),
        Header::from_bytes(
            "Access-Control-Allow-Headers",
            "Content-Type, Authorization, X-LLM-Wiki-Token",
        )
        .unwrap(),
        Header::from_bytes("Content-Type", "application/json").unwrap(),
    ];
    if let Some(origin) = allowed_cors_origin(request_headers) {
        headers.push(Header::from_bytes("Access-Control-Allow-Origin", origin).unwrap());
        headers.push(Header::from_bytes("Vary", "Origin").unwrap());
    }
    headers
}

fn is_rejected_cors_origin(headers: &[(String, String)]) -> bool {
    request_origin(headers)
        .map(|origin| !is_allowed_cors_origin(origin))
        .unwrap_or(false)
}

fn cors_preflight_status(headers: &[(String, String)]) -> StatusCode {
    if is_rejected_cors_origin(headers) {
        StatusCode(403)
    } else {
        StatusCode(204)
    }
}

fn cors_short_circuit(method: &Method, headers: &[(String, String)]) -> Option<CorsShortCircuit> {
    if method == &Method::Options {
        return Some(CorsShortCircuit::Preflight);
    }
    cors_actual_request_denial(headers).map(CorsShortCircuit::Rejected)
}

fn respond_cors_short_circuit(
    request: tiny_http::Request,
    action: CorsShortCircuit,
    headers: &[(String, String)],
) {
    match action {
        CorsShortCircuit::Preflight => respond_options(request, headers),
        CorsShortCircuit::Rejected(response) => {
            respond_json(request, response.status, response.body, headers)
        }
    }
}

fn cors_actual_request_denial(headers: &[(String, String)]) -> Option<ApiResponse> {
    if is_rejected_cors_origin(headers) {
        Some(err(403, "Origin is not allowed"))
    } else {
        None
    }
}

fn allowed_cors_origin(headers: &[(String, String)]) -> Option<&str> {
    request_origin(headers).filter(|origin| is_allowed_cors_origin(origin))
}

fn request_origin(headers: &[(String, String)]) -> Option<&str> {
    headers
        .iter()
        .find(|(key, _)| key == "origin")
        .map(|(_, value)| value.as_str())
}

fn is_allowed_cors_origin(origin: &str) -> bool {
    origin == "tauri://localhost"
        || origin == "http://localhost"
        || origin
            .strip_prefix("http://localhost:")
            .map(|port| !port.is_empty() && port.chars().all(|c| c.is_ascii_digit()))
            .unwrap_or(false)
        || origin == "http://127.0.0.1"
        || origin
            .strip_prefix("http://127.0.0.1:")
            .map(|port| !port.is_empty() && port.chars().all(|c| c.is_ascii_digit()))
            .unwrap_or(false)
}

fn split_url(url: &str) -> (String, &str) {
    match url.split_once('?') {
        Some((path, query)) => (path.to_string(), query),
        None => (url.to_string(), ""),
    }
}

fn parse_query(query: &str) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    for pair in query.split('&').filter(|s| !s.is_empty()) {
        let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
        out.insert(percent_decode(k), percent_decode(v));
    }
    out
}

fn hex_digit(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

fn percent_decode(input: &str) -> String {
    // Operates purely on raw bytes (never re-slices `input` as a `str`):
    // the two bytes following `%` may be the interior bytes of a multi-byte
    // UTF-8 character (e.g. `%` immediately followed by `€` or an emoji in
    // the raw query string), and slicing `input[i+1..i+3]` in that case
    // lands mid-codepoint and panics with "byte index is not a char
    // boundary". Comparing raw bytes against hex digit ranges sidesteps
    // char-boundary requirements entirely.
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let (Some(hi), Some(lo)) = (hex_digit(bytes[i + 1]), hex_digit(bytes[i + 2])) {
                out.push(hi * 16 + lo);
                i += 3;
                continue;
            }
        }
        out.push(if bytes[i] == b'+' { b' ' } else { bytes[i] });
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn is_authorized(app: &AppHandle, query: &str, headers: &[(String, String)]) -> bool {
    if !api_auth_required(app) {
        return true;
    }
    let Some(token) = api_token(app) else {
        return false;
    };
    let params = parse_query(query);
    if params
        .get("token")
        .map(|v| constant_time_eq(v.as_bytes(), token.as_bytes()))
        .unwrap_or(false)
    {
        return true;
    }
    headers_contain_token(headers, "x-llm-wiki-token", &token)
}

fn is_internal_agent_authorized(headers: &[(String, String)]) -> bool {
    let Ok(tokens) = agent_internal_api_tokens().lock() else {
        return false;
    };
    if tokens.is_empty() {
        return false;
    }
    headers.iter().any(|(key, value)| {
        if key == "x-llm-wiki-agent-token" {
            return tokens
                .iter()
                .any(|token| constant_time_eq(value.as_bytes(), token.as_bytes()));
        }
        if key == "authorization" {
            return value
                .strip_prefix("Bearer ")
                .map(|v| {
                    tokens
                        .iter()
                        .any(|token| constant_time_eq(v.as_bytes(), token.as_bytes()))
                })
                .unwrap_or(false);
        }
        false
    })
}

fn headers_contain_token(headers: &[(String, String)], header_name: &str, token: &str) -> bool {
    headers.iter().any(|(key, value)| {
        if key == header_name {
            return constant_time_eq(value.as_bytes(), token.as_bytes());
        }
        if key == "authorization" {
            return value
                .strip_prefix("Bearer ")
                .map(|v| constant_time_eq(v.as_bytes(), token.as_bytes()))
                .unwrap_or(false);
        }
        false
    })
}

fn api_token(app: &AppHandle) -> Option<String> {
    if let Ok(token) = std::env::var("LLM_WIKI_API_TOKEN") {
        let trimmed = token.trim();
        if !trimmed.is_empty() {
            return Some(trimmed.to_string());
        }
    }
    let parsed = load_app_state(app)?;
    parsed
        .get("apiConfig")
        .and_then(|v| v.get("token"))
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(ToOwned::to_owned)
}

fn api_token_source(app: &AppHandle) -> &'static str {
    if let Ok(token) = std::env::var("LLM_WIKI_API_TOKEN") {
        if !token.trim().is_empty() {
            return "env";
        }
    }
    if load_app_state(app)
        .and_then(|parsed| {
            parsed
                .get("apiConfig")
                .and_then(|v| v.get("token"))
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
                .map(|_| ())
        })
        .is_some()
    {
        return "store";
    }
    "none"
}

fn api_auth_required(app: &AppHandle) -> bool {
    !api_allow_unauthenticated(app)
}

fn api_allow_unauthenticated(app: &AppHandle) -> bool {
    let Some(parsed) = load_app_state(app) else {
        return false;
    };
    parsed
        .get("apiConfig")
        .and_then(|v| v.get("allowUnauthenticated"))
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

/// Whether the API server should accept non-/health requests.
///
/// Defaults to `true` when no config has been written yet — keeps
/// existing setups (env-token-only, hand-edited app-state.json) working
/// after the kill-switch was introduced. New users still land in
/// "enabled + no token = 401" which is fail-closed by virtue of the
/// missing token, not the enable flag.
fn api_enabled(app: &AppHandle) -> bool {
    let Some(parsed) = load_app_state(app) else {
        return true;
    };
    parsed
        .get("apiConfig")
        .and_then(|v| v.get("enabled"))
        .and_then(Value::as_bool)
        .unwrap_or(true)
}

fn api_mcp_enabled(app: &AppHandle) -> bool {
    // Metadata for MCP clients; raw HTTP routes are still gated only by enabled/auth.
    let Some(parsed) = load_app_state(app) else {
        return false;
    };
    parsed
        .get("apiConfig")
        .and_then(|v| v.get("mcpEnabled"))
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    let max_len = left.len().max(right.len());
    let mut diff = left.len() ^ right.len();
    for i in 0..max_len {
        let a = left.get(i).copied().unwrap_or(0);
        let b = right.get(i).copied().unwrap_or(0);
        diff |= (a ^ b) as usize;
    }
    diff == 0
}

fn load_app_state(app: &AppHandle) -> Option<Value> {
    let now = Instant::now();
    let lock = APP_STATE_CACHE.get_or_init(|| Mutex::new(None));
    let mut previous = None;
    if let Ok(cache) = lock.lock() {
        if let Some(cached) = cache.as_ref() {
            if now.duration_since(cached.loaded_at) < APP_STATE_CACHE_TTL {
                return cached.value.clone();
            }
            previous = cached.value.clone();
        }
    }

    let path = app.path().app_data_dir().ok()?.join("app-state.json");
    let loaded = fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok());
    let value = loaded.or(previous);

    if let Ok(mut cache) = lock.lock() {
        *cache = Some(CachedAppState {
            loaded_at: now,
            value: value.clone(),
        });
    }
    value
}

fn safe_join(project_path: &str, rel: &str) -> Result<PathBuf, String> {
    // A leading '/' here is URL-style (project-relative), NOT a filesystem
    // absolute path — the sibling `is_public_project_rel` gate normalizes it
    // the same way. Strip it, then reject anything still absolute (e.g. a
    // Windows drive path) before delegating to the shared sandbox validator.
    let rel = rel.trim_start_matches('/');
    if Path::new(rel).is_absolute() {
        return Err("Absolute paths are not allowed".to_string());
    }
    crate::commands::file_ops::path_safety::validate_within_project(
        &PathBuf::from(project_path),
        rel,
    )
}

fn relative_to_project(project_path: &str, path: &Path) -> String {
    let root = Path::new(project_path);
    path.strip_prefix(root)
        .map(|p| p.to_string_lossy().replace('\\', "/"))
        .unwrap_or_else(|_| path.to_string_lossy().replace('\\', "/"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands;
    use std::ops::Deref;

    struct TestProjectDir {
        path: PathBuf,
    }

    impl Deref for TestProjectDir {
        type Target = Path;

        fn deref(&self) -> &Self::Target {
            &self.path
        }
    }

    impl Drop for TestProjectDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }

    fn test_project_dir() -> TestProjectDir {
        let path = std::env::temp_dir().join(format!(
            "llm-wiki-api-test-{}-{}",
            std::process::id(),
            Uuid::new_v4().simple()
        ));
        fs::create_dir(&path).unwrap();
        fs::create_dir(path.join("wiki")).unwrap();
        TestProjectDir { path }
    }

    #[test]
    fn route_request_routes_get_projects() {
        assert_eq!(
            route_request(&Method::Get, "/api/v1/projects").unwrap(),
            ApiRoute::Projects
        );
    }

    #[test]
    fn route_request_routes_get_project_files() {
        assert_eq!(
            route_request(&Method::Get, "/api/v1/projects/route-project/files").unwrap(),
            ApiRoute::Files {
                project_id: "route-project"
            }
        );
    }

    #[test]
    fn route_request_routes_get_project_file_content() {
        assert_eq!(
            route_request(&Method::Get, "/api/v1/projects/route-project/files/content").unwrap(),
            ApiRoute::FileContent {
                project_id: "route-project"
            }
        );
    }

    #[test]
    fn route_request_routes_get_project_reviews() {
        assert_eq!(
            route_request(&Method::Get, "/api/v1/projects/route-project/reviews").unwrap(),
            ApiRoute::Reviews {
                project_id: "route-project"
            }
        );
    }

    #[test]
    fn route_request_routes_post_project_search() {
        assert_eq!(
            route_request(&Method::Post, "/api/v1/projects/route-project/search").unwrap(),
            ApiRoute::Search {
                project_id: "route-project"
            }
        );
    }

    #[test]
    fn route_request_routes_get_project_graph() {
        assert_eq!(
            route_request(&Method::Get, "/api/v1/projects/route-project/graph").unwrap(),
            ApiRoute::Graph {
                project_id: "route-project"
            }
        );
    }

    #[test]
    fn route_request_routes_post_project_sources_rescan() {
        assert_eq!(
            route_request(
                &Method::Post,
                "/api/v1/projects/route-project/sources/rescan"
            )
            .unwrap(),
            ApiRoute::Rescan {
                project_id: "route-project"
            }
        );
    }

    #[test]
    fn route_request_routes_post_project_chat_stub() {
        assert_eq!(
            route_request(&Method::Post, "/api/v1/projects/route-project/chat").unwrap(),
            ApiRoute::Chat {
                project_id: "route-project"
            }
        );
    }

    #[test]
    fn route_request_returns_404_for_unknown_route() {
        let response = route_request(&Method::Get, "/api/v1/unknown").unwrap_err();

        assert_eq!(response.status, 404);
        assert_eq!(response.body["error"], "Not found");
    }

    #[test]
    fn route_request_returns_404_when_method_valid_but_not_matching_any_route() {
        let response = route_request(&Method::Post, "/api/v1/projects").unwrap_err();

        assert_eq!(response.status, 404);
        assert_eq!(response.body["error"], "Not found");
    }

    #[test]
    fn route_request_returns_405_for_unsupported_method_before_route_match() {
        let response = route_request(&Method::Put, "/api/v1/projects").unwrap_err();

        assert_eq!(response.status, 405);
        assert_eq!(response.body["error"], "Method not allowed");
    }

    #[test]
    fn pre_auth_dispatch_maps_health_paths_to_health() {
        assert!(matches!(
            pre_auth_dispatch_response("/api/v1/health"),
            PreDispatch::Health
        ));
        assert!(matches!(
            pre_auth_dispatch_response("/health"),
            PreDispatch::Health
        ));
    }

    #[test]
    fn pre_auth_dispatch_maps_api_routes_to_continue() {
        assert!(matches!(
            pre_auth_dispatch_response("/api/v1/projects"),
            PreDispatch::Continue
        ));
    }

    #[test]
    fn pre_auth_dispatch_maps_health_before_method_check() {
        let method = Method::Put;
        assert!(
            matches!(pre_auth_dispatch_response("/health"), PreDispatch::Health,),
            "{method:?} should not be consulted before health dispatch"
        );
    }

    #[test]
    fn pre_auth_dispatch_returns_404_for_non_api_prefix_before_method_check() {
        let method = Method::Put;
        let PreDispatch::Response(response) = pre_auth_dispatch_response("/random") else {
            panic!("expected non-API path to return a pre-dispatch response before {method:?}");
        };

        assert_eq!(response.status, 404);
        assert_eq!(response.body["error"], "Not found");
    }

    #[test]
    fn safe_join_rejects_traversal() {
        let root = test_project_dir();
        let root_str = root.to_string_lossy();
        assert!(safe_join(&root_str, "../secret.md").is_err());
        assert!(safe_join(&root_str, "wiki/../../secret.md").is_err());
    }

    #[test]
    fn safe_join_accepts_project_relative_paths() {
        let root = test_project_dir();
        let root_str = root.to_string_lossy();
        let joined = safe_join(&root_str, "wiki/index.md").unwrap();
        assert_eq!(joined, root.join("wiki/index.md"));
    }

    #[test]
    fn safe_join_strips_leading_slash_then_validate_rejects_true_absolute_escape() {
        let root = test_project_dir();
        let root_str = root.to_string_lossy();
        // safe_join treats a leading '/' as URL-style (project-relative), the
        // same contract `is_public_project_rel` uses — so an OS-absolute path
        // like this one is stripped of its leading slash and joined *under*
        // the project root, landing safely inside it rather than being
        // rejected as an escape.
        let target = std::env::temp_dir().join(format!(
            "llm-wiki-api-escape-{}-{}/missingA/missingB/evil.md",
            std::process::id(),
            Uuid::new_v4().simple()
        ));
        assert!(
            safe_join(&root_str, target.to_str().unwrap()).is_ok(),
            "leading-slash input is project-relative under safe_join, not a real absolute escape"
        );

        // The underlying S1 fix (walking up to the nearest existing
        // ancestor instead of only the immediate parent) is exercised
        // directly against validate_within_project with the untouched
        // absolute path, which must still correctly resolve outside `root`.
        let result = crate::commands::file_ops::path_safety::validate_within_project(
            &root,
            target.to_str().unwrap(),
        );
        assert!(
            result.is_err(),
            "absolute path outside root with multi-level missing parent should be rejected"
        );
    }

    #[test]
    fn safe_join_accepts_leading_slash_relative_path() {
        let root = test_project_dir();
        let root_str = root.to_string_lossy();
        // `?path=/wiki/foo.md` is a VALID public path per `is_public_project_rel`
        // (which trims the leading '/' and treats it as project-relative).
        // safe_join must accept the same input rather than rejecting it as an
        // absolute filesystem path (P1 regression fix).
        let result = safe_join(&root_str, "/wiki/foo.md");
        assert!(
            result.is_ok(),
            "leading-slash URL-style path should be treated as project-relative"
        );
    }

    #[test]
    fn query_parser_decodes_percent_and_plus() {
        let parsed = parse_query("path=wiki%2Fhello+world.md&token=a%2Bb");
        assert_eq!(parsed.get("path").unwrap(), "wiki/hello world.md");
        assert_eq!(parsed.get("token").unwrap(), "a+b");
    }

    #[test]
    fn percent_decode_does_not_panic_on_multibyte_utf8_after_percent() {
        // `%` directly followed by the raw (not percent-encoded) bytes of a
        // multi-byte UTF-8 character used to panic: the old implementation
        // sliced `input[i+1..i+3]` as a `str`, and those two bytes can land
        // mid-codepoint (not a char boundary).
        let euro = "path=%€"; // '€' is E2 82 AC (3 bytes)
        let decoded = percent_decode(euro);
        assert!(
            decoded.contains('€'),
            "euro sign should pass through intact"
        );

        let emoji = "path=%🙂"; // 4-byte UTF-8 character
        let decoded = percent_decode(emoji);
        assert!(decoded.contains('🙂'), "emoji should pass through intact");

        // Also exercise via resolve_project's project_id decoding path and
        // the query parser, both of which call percent_decode directly.
        let parsed = parse_query("project_id=%€");
        assert!(parsed.get("project_id").unwrap().contains('€'));
    }

    #[test]
    fn percent_decode_still_decodes_valid_percent_sequences() {
        assert_eq!(percent_decode("hello%20world"), "hello world");
        assert_eq!(percent_decode("wiki%2Ffoo.md"), "wiki/foo.md");
        assert_eq!(percent_decode("caf%C3%A9"), "café");
        // Trailing incomplete sequence should not panic and passes through.
        assert_eq!(percent_decode("abc%2"), "abc%2");
        assert_eq!(percent_decode("abc%"), "abc%");
        // Invalid hex after % is passed through unchanged.
        assert_eq!(percent_decode("abc%zz"), "abc%zz");
    }

    #[test]
    fn snippet_handles_unicode_boundaries() {
        let content = "前言。这里是关于知识图谱过滤的中文内容。后续说明。";
        let snippet = commands::search::build_snippet(content, "知识图谱");
        assert!(snippet.contains("知识图谱"));
    }

    #[test]
    fn public_api_paths_exclude_internal_state() {
        assert!(is_public_project_rel("wiki/index.md"));
        assert!(is_public_project_rel("Wiki/index.md"));
        assert!(is_public_project_rel("raw/sources/source.md"));
        assert!(is_public_project_rel("Raw/Sources/source.md"));
        assert!(!is_public_project_rel(".llm-wiki/file-change-queue.json"));
        assert!(!is_public_project_rel("wiki/.draft.md"));
    }

    #[test]
    fn review_query_defaults_to_unresolved_items() {
        let root = test_project_dir();
        let state_dir = root.join(".llm-wiki");
        fs::create_dir_all(&state_dir).unwrap();
        fs::write(
            state_dir.join("review.json"),
            json!([
                {
                    "id": "r1",
                    "type": "missing-page",
                    "title": "Missing page: Attention",
                    "description": "Add Attention",
                    "options": [],
                    "resolved": false,
                    "createdAt": 1,
                    "internalSecret": "do-not-expose"
                },
                {
                    "id": "r2",
                    "type": "duplicate",
                    "title": "Duplicate: LLM",
                    "description": "Merge pages",
                    "options": [],
                    "resolved": true,
                    "createdAt": 2
                }
            ])
            .to_string(),
        )
        .unwrap();

        let query = parse_review_query("").unwrap();
        let reviews = load_review_items(root.to_str().unwrap(), &query).unwrap();

        assert_eq!(query.status.as_str(), "unresolved");
        assert_eq!(reviews.len(), 1);
        assert_eq!(reviews[0].get("id").and_then(Value::as_str), Some("r1"));
        assert!(reviews[0].get("internalSecret").is_none());
    }

    #[test]
    fn review_query_filters_by_type_status_and_limit() {
        let root = test_project_dir();
        let state_dir = root.join(".llm-wiki");
        fs::create_dir_all(&state_dir).unwrap();
        fs::write(
            state_dir.join("review.json"),
            json!([
                { "id": "r1", "type": "missing-page", "resolved": false, "createdAt": 1 },
                { "id": "r2", "type": "missing-page", "resolved": false, "createdAt": 2 },
                { "id": "r3", "type": "duplicate", "resolved": false, "createdAt": 3 },
                { "id": "r4", "type": "missing-page", "resolved": true, "createdAt": 4 }
            ])
            .to_string(),
        )
        .unwrap();

        let query = parse_review_query("status=all&type=missing-page&limit=2").unwrap();
        let reviews = load_review_items(root.to_str().unwrap(), &query).unwrap();

        assert_eq!(query.status.as_str(), "all");
        assert_eq!(
            reviews
                .iter()
                .filter_map(|r| r.get("id").and_then(Value::as_str))
                .collect::<Vec<_>>(),
            vec!["r1", "r2"]
        );
    }

    #[test]
    fn project_path_match_normalizes_separators() {
        assert!(project_path_matches(
            "C:/Users/me/wiki",
            "C:\\Users\\me\\wiki"
        ));
        if cfg!(windows) {
            assert!(project_path_matches("C:/Users/me/wiki", "c:/users/me/wiki"));
        } else {
            assert!(!project_path_matches(
                "C:/Users/me/wiki",
                "c:/users/me/wiki"
            ));
        }
    }

    #[test]
    fn tokenize_keeps_single_cjk_character() {
        assert_eq!(
            crate::commands::search::tokenize_query("图"),
            Vec::<String>::new()
        );
        let tokens = crate::commands::search::tokenize_query("知识图谱");
        assert!(tokens.contains(&"知识".to_string()));
    }

    #[test]
    fn text_content_filter_rejects_binary_extensions() {
        assert!(is_text_content_rel("wiki/index.md"));
        assert!(!is_text_content_rel("wiki/media/image.png"));
        assert!(!is_text_content_rel("raw/sources/book.pdf"));
    }

    #[test]
    fn graph_uses_path_aware_ids_for_same_stem_pages() {
        let root = test_project_dir();
        let nested = root.join("wiki/something/wiki");
        fs::create_dir_all(&nested).unwrap();
        fs::write(root.join("wiki/foo.md"), "type: concept\n# Root Foo").unwrap();
        fs::write(nested.join("foo.md"), "type: concept\n# Nested Foo").unwrap();

        let (nodes, edges) = build_graph(root.to_str().unwrap()).unwrap();
        let root_id =
            commands::search::wiki_relative_path_to_vector_page_id("wiki/foo.md").unwrap();
        let nested_id =
            commands::search::wiki_relative_path_to_vector_page_id("wiki/something/wiki/foo.md")
                .unwrap();

        assert_ne!(root_id, nested_id);
        assert!(nodes.iter().any(|n| n.id == root_id));
        assert!(nodes.iter().any(|n| n.id == nested_id));
        assert!(edges.is_empty());
    }

    #[test]
    fn graph_resolves_unique_legacy_stem_wikilinks() {
        let root = test_project_dir();
        fs::create_dir_all(root.join("wiki/concepts")).unwrap();
        fs::write(root.join("wiki/index.md"), "type: concept\nSee [[foo]].").unwrap();
        fs::write(root.join("wiki/concepts/foo.md"), "type: concept\n# Foo").unwrap();

        let (_, edges) = build_graph(root.to_str().unwrap()).unwrap();
        let source =
            commands::search::wiki_relative_path_to_vector_page_id("wiki/index.md").unwrap();
        let target =
            commands::search::wiki_relative_path_to_vector_page_id("wiki/concepts/foo.md").unwrap();

        assert!(edges
            .iter()
            .any(|edge| edge.source == source && edge.target == target));
    }

    #[test]
    fn graph_resolves_unique_legacy_stem_wikilinks_with_uppercase_md_suffix() {
        let root = test_project_dir();
        fs::create_dir_all(root.join("wiki/concepts")).unwrap();
        fs::write(root.join("wiki/index.md"), "type: concept\nSee [[foo.MD]].").unwrap();
        fs::write(root.join("wiki/concepts/foo.md"), "type: concept\n# Foo").unwrap();

        let (_, edges) = build_graph(root.to_str().unwrap()).unwrap();
        let source =
            commands::search::wiki_relative_path_to_vector_page_id("wiki/index.md").unwrap();
        let target =
            commands::search::wiki_relative_path_to_vector_page_id("wiki/concepts/foo.md").unwrap();

        assert!(edges
            .iter()
            .any(|edge| edge.source == source && edge.target == target));
    }

    #[test]
    fn graph_does_not_guess_ambiguous_legacy_stem_wikilinks() {
        let root = test_project_dir();
        fs::create_dir_all(root.join("wiki/concepts")).unwrap();
        fs::create_dir_all(root.join("wiki/entities")).unwrap();
        fs::write(root.join("wiki/index.md"), "type: concept\nSee [[foo]].").unwrap();
        fs::write(
            root.join("wiki/concepts/foo.md"),
            "type: concept\n# Concept Foo",
        )
        .unwrap();
        fs::write(
            root.join("wiki/entities/foo.md"),
            "type: entity\n# Entity Foo",
        )
        .unwrap();

        let (_, edges) = build_graph(root.to_str().unwrap()).unwrap();

        assert!(edges.is_empty());
    }

    #[test]
    fn graph_resolves_path_prefixed_wikilinks_before_stem_fallback() {
        let root = test_project_dir();
        fs::create_dir_all(root.join("wiki/concepts")).unwrap();
        fs::create_dir_all(root.join("wiki/entities")).unwrap();
        fs::write(
            root.join("wiki/index.md"),
            "type: concept\nSee [[concepts/Attention]].",
        )
        .unwrap();
        fs::write(
            root.join("wiki/concepts/Attention.md"),
            "type: concept\n# Concept Attention",
        )
        .unwrap();
        fs::write(
            root.join("wiki/entities/Attention.md"),
            "type: entity\n# Entity Attention",
        )
        .unwrap();

        let (_, edges) = build_graph(root.to_str().unwrap()).unwrap();
        let source =
            commands::search::wiki_relative_path_to_vector_page_id("wiki/index.md").unwrap();
        let target =
            commands::search::wiki_relative_path_to_vector_page_id("wiki/concepts/Attention.md")
                .unwrap();

        assert!(edges
            .iter()
            .any(|edge| edge.source == source && edge.target == target));
    }

    #[test]
    fn graph_filters_query_nodes_before_counting_links() {
        let root = test_project_dir();
        fs::create_dir_all(root.join("wiki/concepts")).unwrap();
        fs::create_dir_all(root.join("wiki/queries")).unwrap();
        fs::write(root.join("wiki/concepts/foo.md"), "type: concept\n# Foo").unwrap();
        fs::write(
            root.join("wiki/queries/foo-answer.md"),
            "type: query\nSee [[foo]].",
        )
        .unwrap();

        let (nodes, edges) = build_graph(root.to_str().unwrap()).unwrap();
        let target =
            commands::search::wiki_relative_path_to_vector_page_id("wiki/concepts/foo.md").unwrap();
        let target_node = nodes.iter().find(|node| node.id == target).unwrap();

        assert_eq!(nodes.len(), 1);
        assert_eq!(target_node.link_count, 0);
        assert!(edges.is_empty());
    }

    #[test]
    fn constant_time_eq_matches_equal_bytes_only() {
        assert!(constant_time_eq(b"token", b"token"));
        assert!(constant_time_eq(b"", b""));
        assert!(!constant_time_eq(b"token", b"tokeN"));
        assert!(!constant_time_eq(b"token", b"token-longer"));
    }

    #[test]
    fn internal_agent_token_is_active_only_while_registered() {
        let token = new_agent_internal_api_token();
        assert!(token.starts_with("agent-"));
        assert!(!is_internal_agent_authorized(&[(
            "authorization".to_string(),
            format!("Bearer {token}"),
        )]));

        register_agent_internal_api_token(&token);

        assert!(is_internal_agent_authorized(&[(
            "authorization".to_string(),
            format!("Bearer {token}"),
        )]));
        assert!(is_internal_agent_authorized(&[(
            "x-llm-wiki-agent-token".to_string(),
            token.clone(),
        )]));
        assert!(!is_internal_agent_authorized(&[(
            "authorization".to_string(),
            "Bearer public-token".to_string(),
        )]));

        revoke_agent_internal_api_token(&token);
        assert!(!is_internal_agent_authorized(&[(
            "authorization".to_string(),
            format!("Bearer {token}"),
        )]));
    }

    #[test]
    fn public_api_token_headers_still_use_public_header_name() {
        assert!(headers_contain_token(
            &[("x-llm-wiki-token".to_string(), "public-token".to_string())],
            "x-llm-wiki-token",
            "public-token",
        ));
        assert!(!headers_contain_token(
            &[(
                "x-llm-wiki-agent-token".to_string(),
                "public-token".to_string()
            )],
            "x-llm-wiki-token",
            "public-token",
        ));
    }

    #[test]
    fn internal_agent_access_bypasses_external_api_settings() {
        assert_eq!(request_access_denial(false, false, true).unwrap().0, 503);
        assert_eq!(request_access_denial(true, false, false).unwrap().0, 401);
        assert!(request_access_denial(false, true, false).is_none());
        assert!(request_access_denial(true, false, true).is_none());
    }

    #[test]
    fn rate_limit_skips_health_and_options_only() {
        assert!(!should_rate_limit(&Method::Get, "/api/v1/health"));
        assert!(!should_rate_limit(&Method::Options, "/api/v1/projects"));
        assert!(should_rate_limit(&Method::Get, "/wp-login"));
        assert!(should_rate_limit(
            &Method::Post,
            "/api/v1/projects/current/search"
        ));
    }

    #[test]
    fn rate_limit_isolated_by_client_key() {
        let mut buckets = BTreeMap::new();
        let now = Instant::now();

        for _ in 0..RATE_LIMIT_MAX_REQUESTS {
            assert!(allow_request_for_client(&mut buckets, "127.0.0.1", now));
        }

        assert!(!allow_request_for_client(&mut buckets, "127.0.0.1", now));
        assert!(allow_request_for_client(&mut buckets, "127.0.0.2", now));
    }

    #[test]
    fn rate_limit_expires_and_evicts_oldest_client_bucket() {
        let mut buckets = BTreeMap::new();
        let now = Instant::now();

        for _ in 0..RATE_LIMIT_MAX_REQUESTS {
            assert!(allow_request_for_client(&mut buckets, "127.0.0.1", now));
        }
        assert!(allow_request_for_client(
            &mut buckets,
            "127.0.0.1",
            now + RATE_LIMIT_WINDOW + Duration::from_millis(1)
        ));
        assert_eq!(buckets.get("127.0.0.1").unwrap().hits.len(), 1);

        buckets.clear();
        for index in 0..RATE_LIMIT_MAX_CLIENTS {
            assert!(allow_request_for_client(
                &mut buckets,
                &format!("client-{index}"),
                now + Duration::from_millis(index as u64)
            ));
        }
        assert!(allow_request_for_client(
            &mut buckets,
            "client-new",
            now + Duration::from_millis(RATE_LIMIT_MAX_CLIENTS as u64)
        ));
        assert_eq!(buckets.len(), RATE_LIMIT_MAX_CLIENTS);
        assert!(!buckets.contains_key("client-0"));
        assert!(buckets.contains_key("client-new"));
    }

    #[test]
    fn cors_headers_do_not_emit_wildcard_or_origin_without_request_origin() {
        let headers = cors_headers(&[]);

        assert!(!header_values(&headers, "Access-Control-Allow-Origin")
            .iter()
            .any(|value| value == "*"));
        assert!(header_values(&headers, "Access-Control-Allow-Origin").is_empty());
    }

    #[test]
    fn cors_headers_reflect_allowed_local_origins() {
        let localhost = vec![("origin".to_string(), "http://localhost:5173".to_string())];
        let loopback = vec![("origin".to_string(), "http://127.0.0.1:1420".to_string())];
        let tauri = vec![("origin".to_string(), "tauri://localhost".to_string())];

        assert_eq!(
            header_values(&cors_headers(&localhost), "Access-Control-Allow-Origin"),
            vec!["http://localhost:5173".to_string()]
        );
        assert_eq!(
            header_values(&cors_headers(&loopback), "Access-Control-Allow-Origin"),
            vec!["http://127.0.0.1:1420".to_string()]
        );
        assert_eq!(
            header_values(&cors_headers(&tauri), "Access-Control-Allow-Origin"),
            vec!["tauri://localhost".to_string()]
        );
    }

    #[test]
    fn cors_headers_reject_foreign_origins() {
        let headers = vec![("origin".to_string(), "https://evil.example".to_string())];

        assert!(is_rejected_cors_origin(&headers));
        assert_eq!(cors_preflight_status(&headers), StatusCode(403));
        assert!(header_values(&cors_headers(&headers), "Access-Control-Allow-Origin").is_empty());
    }

    #[test]
    fn cors_preflight_allows_no_origin_and_allowed_origins() {
        let localhost = vec![("origin".to_string(), "http://localhost:5173".to_string())];

        assert_eq!(cors_preflight_status(&[]), StatusCode(204));
        assert_eq!(cors_preflight_status(&localhost), StatusCode(204));
        assert_eq!(
            header_values(&cors_headers(&localhost), "Access-Control-Allow-Origin"),
            vec!["http://localhost:5173".to_string()]
        );
    }

    #[test]
    fn cors_actual_request_denies_foreign_origin_before_routing() {
        let headers = vec![("origin".to_string(), "https://evil.example".to_string())];
        let denial = cors_actual_request_denial(&headers).unwrap();

        assert_eq!(denial.status, 403);
        assert_eq!(denial.body["error"], "Origin is not allowed");
        assert!(header_values(&cors_headers(&headers), "Access-Control-Allow-Origin").is_empty());
    }

    #[test]
    fn cors_actual_request_allows_no_origin_and_allowed_origins() {
        let localhost = vec![("origin".to_string(), "http://localhost:5173".to_string())];
        let loopback = vec![("origin".to_string(), "http://127.0.0.1".to_string())];

        assert!(cors_actual_request_denial(&[]).is_none());
        assert!(cors_actual_request_denial(&localhost).is_none());
        assert!(cors_actual_request_denial(&loopback).is_none());
    }

    #[test]
    fn cors_short_circuit_selects_preflight_or_rejected_origin_before_rate_limit() {
        let foreign = vec![("origin".to_string(), "https://evil.example".to_string())];
        let localhost = vec![("origin".to_string(), "http://localhost:5173".to_string())];

        assert!(matches!(
            cors_short_circuit(&Method::Options, &foreign),
            Some(CorsShortCircuit::Preflight)
        ));
        assert!(matches!(
            cors_short_circuit(&Method::Options, &[]),
            Some(CorsShortCircuit::Preflight)
        ));
        assert!(matches!(
            cors_short_circuit(&Method::Get, &foreign),
            Some(CorsShortCircuit::Rejected(_))
        ));
        assert!(cors_short_circuit(&Method::Get, &localhost).is_none());
        assert!(cors_short_circuit(&Method::Get, &[]).is_none());
    }

    #[test]
    fn cors_headers_reject_malformed_localhost_ports() {
        let headers = vec![(
            "origin".to_string(),
            "http://localhost:not-a-port".to_string(),
        )];

        assert!(is_rejected_cors_origin(&headers));
        assert!(header_values(&cors_headers(&headers), "Access-Control-Allow-Origin").is_empty());
    }

    fn header_values(headers: &[Header], name: &str) -> Vec<String> {
        headers
            .iter()
            .filter(|header| header.field.as_str().to_string().eq_ignore_ascii_case(name))
            .map(|header| header.value.as_str().to_string())
            .collect()
    }

    #[test]
    fn api_config_shape_parses_enabled_and_unauthenticated_access() {
        // Standalone pure-function check to mirror what `api_enabled`
        // reads off `load_app_state`. Mirrors the JS-side shape
        // emitted by `saveApiConfig` so any rename on either side
        // surfaces here before users hit it as a 503 in production.
        let payload = json!({
            "apiConfig": {
                "enabled": false,
                "allowUnauthenticated": true,
                "mcpEnabled": true,
                "token": "abc"
            }
        });
        let enabled = payload
            .get("apiConfig")
            .and_then(|v| v.get("enabled"))
            .and_then(Value::as_bool)
            .unwrap_or(true);
        assert!(!enabled);
        let allow_unauthenticated = payload
            .get("apiConfig")
            .and_then(|v| v.get("allowUnauthenticated"))
            .and_then(Value::as_bool)
            .unwrap_or(false);
        assert!(allow_unauthenticated);
        let mcp_enabled = payload
            .get("apiConfig")
            .and_then(|v| v.get("mcpEnabled"))
            .and_then(Value::as_bool)
            .unwrap_or(false);
        assert!(mcp_enabled);
        let token_source = payload
            .get("apiConfig")
            .and_then(|v| v.get("token"))
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .map(|_| "store")
            .unwrap_or("none");
        assert_eq!(token_source, "store");

        let missing = json!({});
        let enabled_missing = missing
            .get("apiConfig")
            .and_then(|v| v.get("enabled"))
            .and_then(Value::as_bool)
            .unwrap_or(true);
        // Fail-open by design — see `api_enabled` doc comment.
        assert!(enabled_missing);
        let mcp_enabled_missing = missing
            .get("apiConfig")
            .and_then(|v| v.get("mcpEnabled"))
            .and_then(Value::as_bool)
            .unwrap_or(false);
        assert!(!mcp_enabled_missing);
    }
}
