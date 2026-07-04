const SECRET_REDACTION_MARKER: &str = "[REDACTED]";

// Bare scheme/keyword tokens that, when themselves consumed as a carried-over
// secret value (i.e. they immediately follow "Authorization:"/"Bearer"/an
// api-key field name), mean the actual credential is one token further along
// ("Authorization: Basic <credential>"), so the carry must be extended by one
// more token instead of ending on the scheme word.
const AUTH_SCHEME_WORDS: &[&str] = &["basic", "digest", "negotiate", "ntlm", "token", "bearer"];

// JSON-object key / URL-query-param names that name a credential field
// beyond the header/scheme-style names AUTH_SCHEME_WORDS and
// classify_secret_token's api_key/authorization/bearer checks already
// cover. Exact-name matching only — same rationale as AUTH_SCHEME_WORDS —
// so `secretary`/`token_count`/`max_tokens` are never caught by substring
// match.
const CREDENTIAL_FIELD_NAMES: &[&str] = &[
    "password",
    "passwd",
    "secret",
    "api_secret",
    "client_secret",
    "access_token",
    "refresh_token",
    "id_token",
    "session_token",
    "private_key",
    "api_keys",
];

struct SecretTokenClass {
    is_secret: bool,
    next_token_is_secret_value: bool,
}

// True when `needle` occurs in `lower` at a position not preceded by an
// alphanumeric char (or at the very start of the token). This is what lets
// `key=[sk-...]` / `[AIza...]` be caught by a single check instead of an
// enumeration of delimiter chars, while `risk-`/`task-` (needle preceded by a
// letter) stay unmatched.
fn token_has_boundary_match(lower: &str, needle: &str) -> bool {
    let mut search_from = 0;
    while let Some(rel_idx) = lower[search_from..].find(needle) {
        let idx = search_from + rel_idx;
        let boundary = idx == 0
            || lower[..idx]
                .chars()
                .next_back()
                .map(|c| !c.is_ascii_alphanumeric())
                .unwrap_or(true);
        if boundary {
            return true;
        }
        search_from = idx + needle.len();
    }
    false
}

// Real gateway keys (see litellm/config.yaml) look like
// `tp-sw0ia7x8u1f6q2alk14bw5613jith6io0yjefem02tzniq6z` — a long run of
// lowercase alphanumerics with no internal separators. The `[A-Za-z0-9_-]`
// run + alnum-count-only-of-≥12 rule below is deliberately a superset of
// that shape (it also matches dash/underscore-segmented keys such as
// `tp-ab12cd34-ef56-gh78`) while still keeping short real-world words like
// `tp-link`/`tp-1a2b` unredacted. The boundary check kills the `http-...`
// false positive (`http-` contains `tp-` but preceded by an alphanumeric
// char).
fn token_has_tp_secret(lower: &str) -> bool {
    let mut search_from = 0;
    while let Some(rel_idx) = lower[search_from..].find("tp-") {
        let idx = search_from + rel_idx;
        let boundary = idx == 0
            || lower[..idx]
                .chars()
                .next_back()
                .map(|c| !c.is_ascii_alphanumeric())
                .unwrap_or(true);
        if boundary {
            let after = &lower[idx + 3..];
            let run: String = after
                .chars()
                .take_while(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '-')
                .collect();
            let alnum_count = run.chars().filter(|c| c.is_ascii_alphanumeric()).count();
            if alnum_count >= 12 {
                return true;
            }
        }
        search_from = idx + 3;
    }
    false
}

// True when `lower` names one of CREDENTIAL_FIELD_NAMES at the START of the
// token followed by a `:`/`=` separator, or as a quoted JSON/py-literal key
// anywhere in the token (`"password"`/`'password'`) — the same
// starts_with/contains separator idiom `has_api_key` above uses, applied to
// this second name list. Deliberately anchored to the token START (unlike
// `token_has_boundary_match`, which the sk-/tp- detectors use to find a
// marker anywhere inside a token): a name+separator match anywhere inside a
// longer compound token (e.g. an unredacted `access_token=...` query param
// sitting inside a whole URL that is itself one whitespace token) must not
// condemn the entire surrounding token. Several of these names (`secret`,
// `password`) are also ordinary English words, so unlike `has_api_key`
// there is no bare exact-match case here: a lone `secret` token in prose
// ("the secret is safe") must not arm redaction — only
// `secret=`/`secret:`/quoted-key forms do.
fn token_has_credential_field_separator(lower: &str) -> bool {
    CREDENTIAL_FIELD_NAMES.iter().any(|name| {
        lower.starts_with(format!("{name}:").as_str())
            || lower.starts_with(format!("{name}=").as_str())
            || lower.contains(format!("\"{name}\"").as_str())
            || lower.contains(format!("'{name}'").as_str())
    })
}

fn classify_secret_token(lower: &str) -> SecretTokenClass {
    let has_secret_ref = lower.contains("llm-wiki-profile-secret:");
    let has_google_api_key = token_has_boundary_match(lower, "aiza");
    let has_sk_secret = token_has_boundary_match(lower, "sk-");
    let has_tp_secret = token_has_tp_secret(lower);
    let has_bearer =
        lower == "bearer" || lower.starts_with("bearer:") || lower.starts_with("bearer=");
    let has_authorization = lower == "authorization"
        || lower.starts_with("authorization:")
        || lower.starts_with("authorization=");
    let has_api_key = lower == "x-api-key"
        || lower == "api-key"
        || lower == "apikey"
        || lower == "api_key"
        || lower == "x-goog-api-key"
        || lower == "google_api_key"
        || lower == "anthropic_api_key"
        || lower == "anthropic_auth_token"
        || lower.starts_with("x-api-key:")
        || lower.starts_with("x-api-key=")
        || lower.starts_with("api-key:")
        || lower.starts_with("api-key=")
        || lower.starts_with("apikey:")
        || lower.starts_with("apikey=")
        || lower.starts_with("api_key:")
        || lower.starts_with("api_key=")
        || lower.starts_with("x-goog-api-key:")
        || lower.starts_with("x-goog-api-key=")
        || lower.starts_with("google_api_key:")
        || lower.starts_with("google_api_key=")
        || lower.starts_with("anthropic_api_key:")
        || lower.starts_with("anthropic_api_key=")
        || lower.starts_with("anthropic_auth_token:")
        || lower.starts_with("anthropic_auth_token=")
        || lower.contains("\"apikey\"")
        || lower.contains("\"api_key\"")
        || lower.contains("\"api-key\"")
        || lower.contains("\"anthropic_api_key\"")
        || lower.contains("\"anthropic_auth_token\"")
        || lower.contains("'apikey'")
        || lower.contains("'api_key'")
        || lower.contains("'api-key'")
        || lower.contains("'anthropic_api_key'")
        || lower.contains("'anthropic_auth_token'");
    let has_credential_field = token_has_credential_field_separator(lower);
    let is_secret = has_secret_ref
        || has_google_api_key
        || has_sk_secret
        || has_tp_secret
        || has_bearer
        || has_authorization
        || has_api_key
        || has_credential_field;
    let next_token_is_secret_value =
        has_bearer || has_authorization || has_api_key || has_credential_field;
    SecretTokenClass {
        is_secret,
        next_token_is_secret_value,
    }
}

// True when `lower` itself looks like a secret VALUE (an embedded secret
// reference, a Google API key, or an sk-/tp- prefixed key) — as opposed to
// a bare field NAME like `api_key`/`authorization`/`bearer`, which merely
// names a credential field and is not itself secret. `classify_secret_token`
// conflates the two (both make `is_secret` true, since both mean "redact
// the associated value"), which is correct for token-stream redaction but
// wrong for deciding whether a JSON object KEY string is the leaked secret.
fn token_looks_like_secret_value(lower: &str) -> bool {
    lower.contains("llm-wiki-profile-secret:")
        || token_has_boundary_match(lower, "aiza")
        || token_has_boundary_match(lower, "sk-")
        || token_has_tp_secret(lower)
}

// Carries `redact_next` state across multiple `redact_line` calls so a
// scheme/key-name token that ends one line (e.g. a bare "Authorization:")
// still redacts the credential that arrives as the first token of the next
// line, instead of resetting per call like the stateless wrapper below.
pub(crate) struct SecretRedactor {
    redact_next: bool,
    // Path-scoped carry for the JSON structural path (`redact_json_line`):
    // the set of length-prefixed JSON paths from the document root (e.g.
    // "5:delta4:text" for ["delta","text"]) whose most recently redacted
    // string value ended armed (e.g. a bare "Authorization:" split across
    // two streamed events). Each segment is encoded as `{len}:{key}`, which
    // is collision-free by construction — no two distinct key sequences can
    // produce the same path string, unlike a plain dotted join. Scoped by
    // full path — not bare leaf key name, and not global.
    // Streaming agent output interleaves protocol fields (e.g.
    // "type":"content_block_delta") between text deltas on the same event;
    // a global carry would consume itself on those unrelated fields and
    // corrupt them (the exact P1 regression an earlier round fixed). A bare
    // leaf-name carry (an earlier round) would instead let unrelated
    // top-level/nested fields that happen to share a leaf name (e.g.
    // top-level "text" vs. "delta.text") steal or falsely arm each other's
    // carry — a second, subtler P1/P2 this round's path-scoping fixes.
    // Independent of `redact_next`, which only serves the
    // plain-text/parse-failure fallback path.
    json_carry: std::collections::HashSet<String>,
}

// Defensive cap on `json_carry` growth: a pathological/adversarial stream
// with an unbounded number of distinct armed JSON paths would otherwise
// grow the carry set for the lifetime of the reader loop. 128 distinct
// concurrently-armed paths is far beyond any realistic credential-split
// pattern, so once the cap is reached, arming a NEW path is skipped
// (fail-open toward *less* carry, not toward leaking — the in-line
// same-event redaction pass still applies regardless of carry state).
// Re-arming/removing a path already tracked is unaffected by the cap.
const JSON_CARRY_MAX_KEYS: usize = 128;

impl SecretRedactor {
    pub(crate) fn new() -> Self {
        Self {
            redact_next: false,
            json_carry: std::collections::HashSet::new(),
        }
    }

    // Scratch instance for a single seeded `redact_line` pass over one JSON
    // string value (see `redact_json_value_inner`) — reuses `redact_line`'s
    // consume/re-arm token semantics without a second copy of its loop.
    fn with_redact_next(redact_next: bool) -> Self {
        Self {
            redact_next,
            json_carry: std::collections::HashSet::new(),
        }
    }

    // Redacts secret-looking tokens in `line` while preserving all original
    // whitespace exactly (multiple spaces, indentation, tabs), so it is safe
    // to use on JSONL/chat lines where whitespace inside string values is
    // literal content.
    pub(crate) fn redact_line(&mut self, line: &str) -> String {
        let mut out = String::with_capacity(line.len());
        for piece in line.split_inclusive(char::is_whitespace) {
            let trailing_ws = piece
                .chars()
                .last()
                .filter(|c| c.is_whitespace())
                .map(|c| c.len_utf8());
            let (word, ws) = match trailing_ws {
                Some(ws_len) => piece.split_at(piece.len() - ws_len),
                None => (piece, ""),
            };
            if word.is_empty() {
                out.push_str(ws);
                continue;
            }
            let lower = word.to_ascii_lowercase();
            let entered_with_carry = self.redact_next;
            let class = classify_secret_token(&lower);
            let redacted = entered_with_carry || class.is_secret;
            let is_scheme_word = AUTH_SCHEME_WORDS.contains(&lower.as_str());
            self.redact_next =
                class.next_token_is_secret_value || (entered_with_carry && is_scheme_word);
            if redacted {
                out.push_str(SECRET_REDACTION_MARKER);
            } else {
                out.push_str(word);
            }
            out.push_str(ws);
        }
        out
    }

    // JSON-aware line redaction for a stateful stream (stdout/stderr reader
    // loops): a successfully parsed JSON line is redacted structurally (per
    // key/value, see `try_redact_json_line`) and does NOT touch
    // `self.redact_next` — the structural pass doesn't participate in (and
    // must not consume) cross-line carry-over, so a stranded trigger from an
    // earlier malformed line (e.g. a bare "Authorization:") stays armed for
    // the next non-JSON line. A line that fails to parse as JSON falls back
    // to `redact_line` on `self`, which both reads and updates the carry.
    //
    // The structural path has its own, separate carry: `self.json_carry`,
    // scoped per dotted JSON path so a credential split across two streamed
    // JSON events (e.g. `{"text":"Authorization:"}` then
    // `{"text":"Basic <token>"}`) still gets caught — see
    // `redact_json_value_inner`.
    pub(crate) fn redact_json_line(&mut self, line: &str) -> String {
        match try_redact_json_line(line, &mut self.json_carry) {
            Some(redacted) => redacted,
            None => self.redact_line(line),
        }
    }
}

/// Redacts secret-looking tokens in `line` while preserving all original
/// whitespace exactly (multiple spaces, indentation, tabs), so it is safe to
/// use on JSONL/chat lines where whitespace inside string values is literal
/// content. Stateless convenience wrapper over `SecretRedactor` for
/// single-string use; streaming callers that need carry-over across lines
/// (e.g. an `Authorization:` header split across reader lines) should hold
/// their own `SecretRedactor` instead.
pub(crate) fn redact_secrets_preserving_format(line: &str) -> String {
    SecretRedactor::new().redact_line(line)
}

// Attempts JSON-aware redaction: parses `line` (minus any trailing
// newline/carriage-return) as a JSON value and redacts every JSON *string*
// value in place (keys and non-string values are left untouched), then
// re-serializes. Returns `None` on parse failure so callers can fall back to
// token-level redaction (using their own stateful `SecretRedactor` when one
// is available, since a parse failure means the JSON contract broke and we
// no longer have structural boundaries to reset state on). `carry` is the
// caller's key-scoped cross-event carry (see `SecretRedactor::json_carry`);
// it is read and updated in place by `redact_json_value`.
fn try_redact_json_line(
    line: &str,
    carry: &mut std::collections::HashSet<String>,
) -> Option<String> {
    let trimmed = line.trim_end_matches(['\r', '\n']);
    let trailing = &line[trimmed.len()..];
    let mut value: serde_json::Value = serde_json::from_str(trimmed).ok()?;
    let mut changed = false;
    redact_json_value(&mut value, &mut changed, carry);
    if !changed {
        return Some(line.to_string());
    }
    let mut serialized = serde_json::to_string(&value).ok()?;
    serialized.push_str(trailing);
    Some(serialized)
}

// True when a JSON object key (or, via `redact_url_userinfo_for_log`'s
// query-param redaction, a URL query-param name) names a credential-bearing
// field, so its direct value should be redacted unconditionally rather than
// token-scanned (a value like a base64 blob or opaque ID has no sk-/tp-/aiza
// marker for the token scanner to catch). Exact-name matching only — no
// substring match — so `token_count`/`max_tokens`/`tokenizer`/`secretary`
// are never caught by the bare `token`/`secret` scheme words.
pub(crate) fn key_is_credential_bearing(key: &str) -> bool {
    let lower = key.to_ascii_lowercase();
    if AUTH_SCHEME_WORDS.contains(&lower.as_str())
        || CREDENTIAL_FIELD_NAMES.contains(&lower.as_str())
    {
        return true;
    }
    let class = classify_secret_token(&lower);
    class.is_secret || class.next_token_is_secret_value
}

fn redact_json_value(
    value: &mut serde_json::Value,
    changed: &mut bool,
    carry: &mut std::collections::HashSet<String>,
) {
    redact_json_value_inner(value, changed, false, None, carry);
}

// `enclosing_path` is the length-prefixed JSON path (from the document
// root) of the object key whose value this string/array/etc. is (or, for a
// string nested inside an array, the path of the key that owns the array —
// array levels do NOT append a path segment, so items in an array under
// "delta"."text" all share that same path) — `None` for values with no
// enclosing key (top-level scalars). It scopes `carry`: a string value
// seeds its stateful redaction pass from `carry.contains(enclosing_path)`
// and updates that same entry afterward, so a credential split across two
// streamed JSON events under the SAME path (e.g. `{"text":"Authorization:"}`
// then `{"text":"Basic <token>"}`, or `{"delta":{"text":"Authorization:"}}`
// then `{"delta":{"text":"Basic <token>"}}`) is still caught, while a
// different path — including one that merely shares a bare leaf key name
// (e.g. top-level "text" vs. "delta"."text") — on an intervening or later
// event never consumes or touches it. Scoping by bare leaf key name instead
// of full path (an earlier round) let unrelated paths steal/falsely-arm
// each other's carry; this is the fix for that. Each path segment is
// encoded as `{len}:{key}` (see `redact_json_value_inner`'s Object arm)
// rather than joined with a plain ".", so a literal key containing "." can
// no longer alias a different structural path — the encoding is
// collision-free by construction.
fn redact_json_value_inner(
    value: &mut serde_json::Value,
    changed: &mut bool,
    force_redact: bool,
    enclosing_path: Option<&str>,
    carry: &mut std::collections::HashSet<String>,
) {
    match value {
        serde_json::Value::String(text) => {
            if force_redact {
                if text.as_str() != SECRET_REDACTION_MARKER {
                    *changed = true;
                    *text = SECRET_REDACTION_MARKER.to_string();
                }
            } else {
                let armed = enclosing_path.is_some_and(|path| carry.contains(path));
                let mut redactor = SecretRedactor::with_redact_next(armed);
                let redacted = redactor.redact_line(text);
                if let Some(path) = enclosing_path {
                    if redactor.redact_next {
                        // Re-arming a path already tracked is always
                        // allowed; only a brand-new path is subject to the
                        // cap (see `JSON_CARRY_MAX_KEYS`).
                        if carry.contains(path) || carry.len() < JSON_CARRY_MAX_KEYS {
                            carry.insert(path.to_string());
                        }
                    } else {
                        carry.remove(path);
                    }
                }
                if redacted != *text {
                    *changed = true;
                    *text = redacted;
                }
            }
        }
        serde_json::Value::Array(items) => {
            for item in items {
                redact_json_value_inner(item, changed, force_redact, enclosing_path, carry);
            }
        }
        serde_json::Value::Number(_) | serde_json::Value::Bool(_) if force_redact => {
            *changed = true;
            *value = serde_json::Value::String(SECRET_REDACTION_MARKER.to_string());
        }
        serde_json::Value::Object(map) => {
            // Profile pools key data by credential in a few places, so a
            // dumped map can leak a secret through the KEY, not just the
            // value (`{"sk-live...":"ok"}`). Keys can't be renamed via
            // `iter_mut` (only values are mutable there), so this rebuilds
            // the object: a key that itself looks like a secret VALUE
            // (`token_looks_like_secret_value`, not merely a credential
            // field NAME like `api_key`/`authorization`/`token`) is swapped
            // for the marker and its value is force-redacted too;
            // everything else keeps today's key-context behavior.
            //
            // Two distinct secret keys in one object both become the same
            // literal marker key, so the second `insert` silently drops the
            // first entry. That's an acceptable lossy outcome for a
            // redaction path — the goal is "no secret survives", not
            // "every original entry survives".
            let mut rebuilt = serde_json::Map::with_capacity(map.len());
            for (key, mut entry) in std::mem::take(map) {
                let key_is_secret = token_looks_like_secret_value(&key.to_ascii_lowercase());
                let force_redact = force_redact || key_is_secret || key_is_credential_bearing(&key);
                // Build this key's full path from its parent's path (`None`
                // at the document root). Each segment is length-prefixed
                // (`{len}:{key}`) rather than dot-joined, so no two distinct
                // key sequences can ever produce the same path string — a
                // literal key containing "." cannot alias a nested path
                // (e.g. ["delta","text"] encodes as "5:delta4:text", never
                // colliding with a literal "delta.text" key, which encodes
                // as "10:delta.text").
                let child_path = match enclosing_path {
                    Some(parent) => format!("{parent}{}:{key}", key.len()),
                    None => format!("{}:{key}", key.len()),
                };
                redact_json_value_inner(
                    &mut entry,
                    changed,
                    force_redact,
                    Some(&child_path),
                    carry,
                );
                let key = if key_is_secret {
                    *changed = true;
                    SECRET_REDACTION_MARKER.to_string()
                } else {
                    key
                };
                rebuilt.insert(key, entry);
            }
            *map = rebuilt;
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::runtime_db::*;

    use rusqlite::Connection;

    use std::fs;

    #[test]
    fn profile_create_update_list_and_status_round_trip_without_secret_values() {
        let project = temp_project("profile-round-trip");
        fs::create_dir_all(&project).expect("create temp project");

        let created = runtime_profile_create_for_project(
            Some(&project),
            true,
            profile_create_request("profile-1"),
            100,
        )
        .expect("create profile");

        assert_eq!(created.profile_id, "profile-1");
        assert_eq!(created.kind, "model-call");
        assert_eq!(created.display_name, "GPT-4.1");
        assert_eq!(created.provider_id, "openai");
        assert_eq!(created.model_id, "gpt-4.1");
        assert_eq!(created.auth_style, "bearer");
        assert_eq!(created.capability_status, DEFAULT_PROFILE_STATUS);
        assert_eq!(created.capability_json, DEFAULT_PROFILE_CAPABILITY_JSON);
        assert!(created.enabled);
        assert_eq!(created.max_concurrency, 2);
        assert_eq!(
            created.secret_ref.as_deref(),
            Some(profile_secret_ref("profile-1").as_str())
        );
        assert!(!created
            .secret_ref
            .as_deref()
            .unwrap_or_default()
            .contains("sk-"));
        assert!(migration_family_exists(&project, PROFILE_STATUS_FAMILY));
        let secret_value = "sk-test-secret-never-stored";
        let connection = Connection::open(runtime_db_path(&project)).expect("open runtime db");
        let stored_secret_ref: Option<String> = connection
            .query_row(
                "SELECT secret_ref FROM runtime_model_profiles WHERE profile_id = ?1",
                ["profile-1"],
                |row| row.get(0),
            )
            .expect("read stored secret ref");
        assert_eq!(stored_secret_ref.as_deref(), created.secret_ref.as_deref());
        let stored_text: String = connection
            .query_row(
                "SELECT profile_id
                    || display_name
                    || provider_id
                    || model_id
                    || COALESCE(endpoint, '')
                    || api_mode
                    || auth_style
                    || COALESCE(secret_ref, '')
                    || task_families_json
                    || capability_json
                    || capability_version
                    || COALESCE(last_capability_error, '')
                 FROM runtime_model_profiles
                 WHERE profile_id = ?1",
                ["profile-1"],
                |row| row.get(0),
            )
            .expect("read stored profile text");
        let created_payload = serde_json::to_string(&created).expect("serialize profile");
        assert!(!stored_text.contains(secret_value));
        assert!(!created_payload.contains(secret_value));

        let mut update = profile_update_request("profile-1");
        update.display_name = Some("GPT-4.1 compact".to_string());
        update.endpoint = Some("https://api.openai.example/v1".to_string());
        update.clear_secret_ref = Some(true);
        update.enabled = Some(false);
        update.task_families = Some(vec!["summarize".to_string(), "summarize".to_string()]);
        update.capability_status = Some("limited".to_string());
        update.capability_json = Some("{\"contextWindow\":8192}".to_string());
        update.capability_version = Some("probe-v1".to_string());
        update.capability_checked_at_ms = Some(200);
        update.probe_backoff_until_ms = Some(300);
        update.last_capability_error = Some("rate limited".to_string());

        let updated = runtime_profile_update_for_project(Some(&project), true, update, 250)
            .expect("update profile");

        assert_eq!(updated.display_name, "GPT-4.1 compact");
        assert_eq!(
            updated.endpoint.as_deref(),
            Some("https://api.openai.example/v1")
        );
        assert!(updated.secret_ref.is_none());
        assert!(!updated.enabled);
        assert_eq!(updated.task_families, vec!["summarize".to_string()]);
        assert_eq!(updated.capability_status, "limited");
        assert_eq!(updated.capability_json, "{\"contextWindow\":8192}");
        assert_eq!(updated.capability_version, "probe-v1");
        assert_eq!(updated.capability_checked_at_ms, Some(200));
        assert_eq!(updated.probe_backoff_until_ms, Some(300));
        assert_eq!(
            updated.last_capability_error.as_deref(),
            Some("rate limited")
        );
        assert_eq!(updated.created_at_ms, 100);
        assert_eq!(updated.updated_at_ms, 250);

        let list = runtime_profile_list_for_project(Some(&project), true).expect("list profiles");
        assert_eq!(list.profiles, vec![updated.clone()]);
        let status = runtime_profile_status_for_project(
            Some(&project),
            true,
            RuntimeProfileStatusRequest {
                profile_id: "profile-1".to_string(),
            },
        )
        .expect("profile status");
        assert_eq!(status, updated);
        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn profile_validation_rejects_plain_secret_refs_and_bad_json() {
        let project = temp_project("profile-validation");
        fs::create_dir_all(&project).expect("create temp project");

        let mut raw_secret = profile_create_request("profile-plain-secret");
        raw_secret.secret_ref = Some("sk-test-secret".to_string());
        let raw_secret_error =
            runtime_profile_create_for_project(Some(&project), true, raw_secret, 100)
                .expect_err("plain secret ref rejected");
        assert!(raw_secret_error.starts_with("invalid-secret-ref"));

        let mut prefixed_secret = profile_create_request("profile-prefixed-secret");
        prefixed_secret.secret_ref = Some("llm-wiki-profile-secret:sk-test-secret".to_string());
        let prefixed_secret_error =
            runtime_profile_create_for_project(Some(&project), true, prefixed_secret, 100)
                .expect_err("prefixed secret value rejected");
        assert!(prefixed_secret_error.starts_with("invalid-secret-ref"));

        runtime_profile_create_for_project(
            Some(&project),
            true,
            profile_create_request("profile-json"),
            100,
        )
        .expect("create profile");
        let mut disguised_secret = profile_update_request("profile-json");
        disguised_secret.secret_ref = Some("llm-wiki-profile-secret:sk-test-secret".to_string());
        let disguised_secret_error =
            runtime_profile_update_for_project(Some(&project), true, disguised_secret, 150)
                .expect_err("prefixed secret value rejected on update");
        assert!(disguised_secret_error.starts_with("invalid-secret-ref"));
        let mut bad_json = profile_update_request("profile-json");
        bad_json.capability_json = Some("{bad json}".to_string());
        let bad_json_error =
            runtime_profile_update_for_project(Some(&project), true, bad_json, 200)
                .expect_err("invalid capability JSON rejected");
        assert!(bad_json_error.starts_with("invalid-capability-json"));
        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn redact_secrets_preserving_format_keeps_whitespace_layout() {
        let line = "  indented   line with sk-test000aaaabbbbccccdddd embedded\ttab";
        let redacted = redact_secrets_preserving_format(line);
        assert!(!redacted.contains("sk-test000aaaabbbbccccdddd"));
        assert!(redacted.contains("[REDACTED]"));
        assert!(redacted.starts_with("  indented   line with "));
        assert!(redacted.ends_with("embedded\ttab"));
        // sk- tokens do not carry over to the next token, so only the
        // secret token itself is swapped for the marker; every other byte
        // (including whitespace) is unchanged.
        assert_eq!(
            redacted.len(),
            line.len() - "sk-test000aaaabbbbccccdddd".len() + "[REDACTED]".len()
        );
    }

    #[test]
    fn redact_secrets_preserving_format_redacts_jsonl_chat_line() {
        // ANTHROPIC_AUTH_TOKEN=... is a key=value pair, so the existing
        // carry-over behavior also redacts the following token ("ok"); the
        // tp- token is independently detected and does not carry over, so
        // "done" survives untouched.
        let line = "  {\"text\":\"Set ANTHROPIC_AUTH_TOKEN=sk-test000aaaabbbbccccdddd  ok  tp-test000aaaabbbbccccdddd  done\"}\n";
        let redacted = redact_secrets_preserving_format(line);
        assert!(!redacted.contains("sk-test000aaaabbbbccccdddd"));
        assert!(!redacted.contains("tp-test000aaaabbbbccccdddd"));
        assert!(redacted.starts_with("  {\"text\":\"Set "));
        assert!(redacted.ends_with("  done\"}\n"));
        assert!(redacted.contains("[REDACTED]"));
    }

    #[test]
    fn redact_secrets_preserving_format_roundtrips_when_no_secrets() {
        let line = "  no secrets here,\tjust  plain   text\n";
        assert_eq!(redact_secrets_preserving_format(line), line);
    }

    #[test]
    fn redact_secrets_in_json_line_redacts_nested_minified_string_value() {
        let line = "{\"type\":\"tool_call\",\"input\":{\"apiKey\":\"sk-test000aaaabbbbccccdddd\",\"note\":\"ok\"}}\n";
        let redacted = SecretRedactor::new().redact_json_line(line);
        assert!(!redacted.contains("sk-test000aaaabbbbccccdddd"));
        let trimmed = redacted.trim_end_matches(['\r', '\n']);
        let parsed: serde_json::Value =
            serde_json::from_str(trimmed).expect("redacted line must still be valid JSON");
        assert_eq!(parsed["type"], "tool_call");
        assert_eq!(parsed["input"]["apiKey"], "[REDACTED]");
        assert_eq!(parsed["input"]["note"], "ok");
        assert!(redacted.ends_with('\n'));
    }

    #[test]
    fn redact_secrets_in_json_line_returns_no_secret_json_byte_identical() {
        let line = "{\"type\":\"status\",\"input\":{\"note\":\"ok\"}}\n";
        assert_eq!(SecretRedactor::new().redact_json_line(line), line);
    }

    #[test]
    fn redact_secrets_in_json_line_falls_back_to_token_redaction_for_non_json() {
        let line = "not json at all key=sk-test000aaaabbbbccccdddd trailing\n";
        let redacted = SecretRedactor::new().redact_json_line(line);
        assert!(!redacted.contains("sk-test000aaaabbbbccccdddd"));
        assert!(redacted.contains("[REDACTED]"));
        assert!(redacted.starts_with("not json at all "));
        assert!(redacted.ends_with("trailing\n"));
    }

    #[test]
    fn redact_secrets_in_json_line_redacts_opaque_api_key_value_by_key_context() {
        let line = "{\"api_key\":\"opaquevalue000\"}\n";
        let redacted = SecretRedactor::new().redact_json_line(line);
        assert!(!redacted.contains("opaquevalue000"));
        let trimmed = redacted.trim_end_matches(['\r', '\n']);
        let parsed: serde_json::Value =
            serde_json::from_str(trimmed).expect("redacted line must still be valid JSON");
        assert_eq!(parsed["api_key"], "[REDACTED]");
    }

    #[test]
    fn redact_secrets_in_json_line_redacts_opaque_authorization_value_by_key_context() {
        let line = "{\"Authorization\":\"Basic opaquevalue000\"}\n";
        let redacted = SecretRedactor::new().redact_json_line(line);
        assert!(!redacted.contains("opaquevalue000"));
        let trimmed = redacted.trim_end_matches(['\r', '\n']);
        let parsed: serde_json::Value =
            serde_json::from_str(trimmed).expect("redacted line must still be valid JSON");
        assert_eq!(parsed["Authorization"], "[REDACTED]");
    }

    #[test]
    fn redact_secrets_in_json_line_redacts_opaque_token_value_by_key_context() {
        let line = "{\"token\":\"opaquevalue000\"}\n";
        let redacted = SecretRedactor::new().redact_json_line(line);
        assert!(!redacted.contains("opaquevalue000"));
        let trimmed = redacted.trim_end_matches(['\r', '\n']);
        let parsed: serde_json::Value =
            serde_json::from_str(trimmed).expect("redacted line must still be valid JSON");
        assert_eq!(parsed["token"], "[REDACTED]");
    }

    #[test]
    fn redact_secrets_in_json_line_keeps_token_lookalike_keys_untouched() {
        let line = "{\"token_count\":42,\"max_tokens\":\"1000\",\"tokenizer\":\"gpt2\"}\n";
        assert_eq!(SecretRedactor::new().redact_json_line(line), line);
    }

    #[test]
    fn redact_secrets_in_json_line_keeps_secretary_key_untouched() {
        let line = "{\"secretary\":\"alice\"}\n";
        assert_eq!(SecretRedactor::new().redact_json_line(line), line);
    }

    #[test]
    fn redact_secrets_in_json_line_redacts_nested_array_under_credential_key() {
        let line = "{\"api_key\":[\"opaque-item-one\",\"opaque-item-two\"]}\n";
        let redacted = SecretRedactor::new().redact_json_line(line);
        assert!(!redacted.contains("opaque-item-one"));
        assert!(!redacted.contains("opaque-item-two"));
        let trimmed = redacted.trim_end_matches(['\r', '\n']);
        let parsed: serde_json::Value =
            serde_json::from_str(trimmed).expect("redacted line must still be valid JSON");
        assert_eq!(parsed["api_key"][0], "[REDACTED]");
        assert_eq!(parsed["api_key"][1], "[REDACTED]");
    }

    #[test]
    fn redact_secrets_in_json_line_redacts_nested_object_under_authorization_key() {
        let line = "{\"authorization\":{\"value\":\"opaquevalue000\",\"scheme\":\"basic\"}}\n";
        let redacted = SecretRedactor::new().redact_json_line(line);
        assert!(!redacted.contains("opaquevalue000"));
        let trimmed = redacted.trim_end_matches(['\r', '\n']);
        let parsed: serde_json::Value =
            serde_json::from_str(trimmed).expect("redacted line must still be valid JSON");
        assert_eq!(parsed["authorization"]["value"], "[REDACTED]");
        assert_eq!(parsed["authorization"]["scheme"], "[REDACTED]");
    }

    #[test]
    fn redact_secrets_in_json_line_redacts_array_of_objects_under_credential_key() {
        let line = "{\"api_key\":[{\"k\":\"opaquevalue000\"}],\"note\":\"ok\"}\n";
        let redacted = SecretRedactor::new().redact_json_line(line);
        assert!(!redacted.contains("opaquevalue000"));
        let trimmed = redacted.trim_end_matches(['\r', '\n']);
        let parsed: serde_json::Value =
            serde_json::from_str(trimmed).expect("redacted line must still be valid JSON");
        assert_eq!(parsed["api_key"][0]["k"], "[REDACTED]");
        // The sibling "note" key sits outside the credential-bearing
        // subtree, so it must be unaffected by the propagated force flag.
        assert_eq!(parsed["note"], "ok");
    }

    #[test]
    fn redact_secrets_in_json_line_redacts_common_credential_field_names() {
        for key in ["password", "secret", "access_token", "client_secret"] {
            let line = format!("{{\"{key}\":\"opaquevalue000\"}}\n");
            let redacted = SecretRedactor::new().redact_json_line(&line);
            assert!(
                !redacted.contains("opaquevalue000"),
                "key {key} should have redacted its value"
            );
            let trimmed = redacted.trim_end_matches(['\r', '\n']);
            let parsed: serde_json::Value =
                serde_json::from_str(trimmed).expect("redacted line must still be valid JSON");
            assert_eq!(parsed[key], "[REDACTED]", "key {key} should be [REDACTED]");
        }
    }

    #[test]
    fn redact_secrets_in_json_line_redacts_non_string_primitives_under_credential_keys() {
        for (line, key) in [
            ("{\"password\":123456}\n", "password"),
            ("{\"api_key\":12345}\n", "api_key"),
            ("{\"secret\":true}\n", "secret"),
        ] {
            let redacted = SecretRedactor::new().redact_json_line(line);
            assert_ne!(redacted, line, "line {line} should have been redacted");
            let trimmed = redacted.trim_end_matches(['\r', '\n']);
            let parsed: serde_json::Value =
                serde_json::from_str(trimmed).expect("redacted line must still be valid JSON");
            assert_eq!(parsed[key], "[REDACTED]", "key {key} should be [REDACTED]");
        }
    }

    #[test]
    fn redact_secrets_in_json_line_leaves_non_credential_number_untouched() {
        let line = "{\"count\":123}\n";
        assert_eq!(SecretRedactor::new().redact_json_line(line), line);
    }

    #[test]
    fn redact_secrets_in_json_line_redacts_api_keys_plural_field_name() {
        let line = "{\"api_keys\":[{\"key\":\"opaque_secret_test_777\"}]}\n";
        let redacted = SecretRedactor::new().redact_json_line(line);
        assert!(!redacted.contains("opaque_secret_test_777"));
        let trimmed = redacted.trim_end_matches(['\r', '\n']);
        let parsed: serde_json::Value =
            serde_json::from_str(trimmed).expect("redacted line must still be valid JSON");
        assert_eq!(parsed["api_keys"][0]["key"], "[REDACTED]");
    }

    #[test]
    fn redact_secrets_in_json_line_keeps_null_under_credential_key_as_null() {
        let line = "{\"password\":null}\n";
        assert_eq!(SecretRedactor::new().redact_json_line(line), line);
    }

    #[test]
    fn redact_secrets_preserving_format_redacts_token_stream_password_assignment() {
        // The name=value pair is a single whitespace token, so (matching
        // the existing ANTHROPIC_AUTH_TOKEN=... precedent above) the whole
        // token is swapped for the marker and, since the separator form
        // also arms next_token_is_secret_value, so is the token after it —
        // this test only asserts the credential itself never survives.
        let redacted = redact_secrets_preserving_format("set password=hunter2opaque now");
        assert!(!redacted.contains("hunter2opaque"));
        assert!(redacted.contains("[REDACTED]"));
        assert!(redacted.starts_with("set "));
    }

    #[test]
    fn redact_secrets_preserving_format_keeps_bare_secret_word_in_prose() {
        assert_eq!(
            redact_secrets_preserving_format("the secret is safe"),
            "the secret is safe"
        );
    }

    #[test]
    fn redact_secrets_in_json_line_redacts_nested_credential_key() {
        let line = "{\"config\":{\"anthropic_auth_token\":\"opaquevalue000\"}}\n";
        let redacted = SecretRedactor::new().redact_json_line(line);
        assert!(!redacted.contains("opaquevalue000"));
        let trimmed = redacted.trim_end_matches(['\r', '\n']);
        let parsed: serde_json::Value =
            serde_json::from_str(trimmed).expect("redacted line must still be valid JSON");
        assert_eq!(parsed["config"]["anthropic_auth_token"], "[REDACTED]");
    }

    #[test]
    fn redact_secrets_in_json_line_redacts_secret_object_key() {
        let line = "{\"sk-test000aaaabbbbccccdddd\":\"v1\"}\n";
        let redacted = SecretRedactor::new().redact_json_line(line);
        assert!(!redacted.contains("sk-test000aaaabbbbccccdddd"));
        let trimmed = redacted.trim_end_matches(['\r', '\n']);
        let parsed: serde_json::Value =
            serde_json::from_str(trimmed).expect("redacted line must still be valid JSON");
        assert_eq!(parsed["[REDACTED]"], "[REDACTED]");
    }

    #[test]
    fn redact_secrets_in_json_line_two_secret_keys_do_not_panic_and_leak_nothing() {
        let line =
            "{\"sk-test000aaaabbbbccccdddd\":\"v1\",\"sk-other111aaaabbbbccccdddd\":\"v2\"}\n";
        let redacted = SecretRedactor::new().redact_json_line(line);
        assert!(!redacted.contains("sk-test000aaaabbbbccccdddd"));
        assert!(!redacted.contains("sk-other111aaaabbbbccccdddd"));
        let trimmed = redacted.trim_end_matches(['\r', '\n']);
        // Both original keys collapse to the same marker key, so the second
        // insert silently drops the first entry — acceptable for a
        // redaction sink (see the comment on the object branch). What
        // matters here is that this doesn't panic and no secret survives.
        let _parsed: serde_json::Value =
            serde_json::from_str(trimmed).expect("redacted line must still be valid JSON");
    }

    #[test]
    fn redact_secrets_in_json_line_keeps_credential_field_name_keys_literal() {
        // The key name "api_key" merely NAMES a credential field; it is not
        // itself a secret pattern, so only its value is force-redacted
        // (existing key-context behavior) — the key string stays literal.
        let line = "{\"api_key\":\"x\"}\n";
        let redacted = SecretRedactor::new().redact_json_line(line);
        let trimmed = redacted.trim_end_matches(['\r', '\n']);
        let parsed: serde_json::Value =
            serde_json::from_str(trimmed).expect("redacted line must still be valid JSON");
        assert!(parsed.as_object().unwrap().contains_key("api_key"));
        assert_eq!(parsed["api_key"], "[REDACTED]");
    }

    #[test]
    fn secret_redactor_json_line_does_not_consume_carry_from_prior_malformed_line() {
        let mut redactor = SecretRedactor::new();
        // Line 1: non-JSON, ends with a bare "authorization:" trigger.
        let line1 = redactor.redact_json_line("stray authorization:\n");
        assert_eq!(line1, "stray [REDACTED]\n");

        // Line 2: valid JSON with no secrets. Must NOT consume/reset the
        // carry armed by line 1 (Fix B: JSON success path leaves
        // `redact_next` untouched).
        let json_line = "{\"note\":\"ok\"}\n";
        let line2 = redactor.redact_json_line(json_line);
        assert_eq!(line2, json_line);

        // Line 3: non-JSON bare credential value — still redacted because
        // the carry from line 1 survived line 2.
        let line3 = redactor.redact_json_line("bearecredentialvalue\n");
        assert_eq!(line3, "[REDACTED]\n");
    }

    #[test]
    fn secret_redactor_json_line_carries_credential_across_split_events_same_key() {
        let mut redactor = SecretRedactor::new();
        redactor.redact_json_line("{\"text\":\"Authorization:\"}\n");
        let second = redactor.redact_json_line("{\"text\":\"Basic opaquevalue1234\"}\n");
        assert!(!second.contains("opaquevalue1234"));
    }

    #[test]
    fn secret_redactor_json_line_carries_api_key_assignment_across_split_events() {
        let mut redactor = SecretRedactor::new();
        redactor.redact_json_line("{\"text\":\"api_key=\"}\n");
        let second = redactor.redact_json_line("{\"text\":\"opaquevalue5678\"}\n");
        assert!(!second.contains("opaquevalue5678"));
    }

    #[test]
    fn secret_redactor_json_line_key_scoped_carry_survives_unrelated_protocol_event() {
        let mut redactor = SecretRedactor::new();
        redactor.redact_json_line("{\"text\":\"Authorization:\"}\n");

        // An intervening streaming-protocol event that never touches the
        // "text" key must round-trip byte-identical: the carry is scoped to
        // "text", so "type"/"index" (unarmed keys) are untouched.
        let protocol_line = "{\"type\":\"content_block_delta\",\"index\":0}\n";
        let protocol_out = redactor.redact_json_line(protocol_line);
        assert_eq!(protocol_out, protocol_line);

        // The "text" carry must still be armed after the intervening event.
        let third = redactor.redact_json_line("{\"text\":\"Basic opaquevalue9999\"}\n");
        assert!(!third.contains("opaquevalue9999"));
    }

    #[test]
    fn secret_redactor_json_line_carry_does_not_cross_into_a_different_key() {
        let mut redactor = SecretRedactor::new();
        redactor.redact_json_line("{\"text\":\"Authorization:\"}\n");

        // A sibling key on a later event must not be consumed by the "text"
        // carry — the opaque value under "other" survives untouched.
        let other_line = "{\"other\":\"opaquevalueAAAA\"}\n";
        let other_out = redactor.redact_json_line(other_line);
        assert_eq!(other_out, other_line);

        // The "text" carry must still be armed afterward.
        let third = redactor.redact_json_line("{\"text\":\"Basic opaquevalueBBBB\"}\n");
        assert!(!third.contains("opaquevalueBBBB"));
    }

    #[test]
    fn secret_redactor_json_line_no_arm_control_round_trips_byte_identical() {
        let mut redactor = SecretRedactor::new();
        let line = "{\"text\":\"hello world\"}\n";
        assert_eq!(redactor.redact_json_line(line), line);
        assert_eq!(redactor.redact_json_line(line), line);
    }

    #[test]
    fn secret_redactor_json_line_arming_value_itself_gets_redacted_not_silently_dropped() {
        // A bare "Authorization:" value is itself classified as a secret
        // token by `classify_secret_token` (pre-existing, tested behavior —
        // see `secret_redactor_carries_state_across_lines` below), so this
        // is NOT a byte-identical round trip: the trigger word is replaced
        // by the marker in addition to arming the "text" carry for the next
        // event. `changed` tracking must reflect that real text mutation.
        let mut redactor = SecretRedactor::new();
        let redacted = redactor.redact_json_line("{\"text\":\"Authorization:\"}\n");
        assert_ne!(redacted, "{\"text\":\"Authorization:\"}\n");
        assert!(redacted.contains("[REDACTED]"));

        // Arming still carries into the next event under the same key.
        let second = redactor.redact_json_line("{\"text\":\"Basic opaquevalueCCCC\"}\n");
        assert!(!second.contains("opaquevalueCCCC"));
    }

    #[test]
    fn secret_redactor_json_line_carries_credential_across_split_events_same_nested_path() {
        // Same-path nested carry: `delta.text` -> `delta.text` must still be
        // caught, same as the flat `text` -> `text` case above.
        let mut redactor = SecretRedactor::new();
        redactor.redact_json_line("{\"delta\":{\"text\":\"Authorization:\"}}\n");
        let second = redactor.redact_json_line("{\"delta\":{\"text\":\"Basic opaqueNESTED\"}}\n");
        assert!(!second.contains("opaqueNESTED"));
    }

    #[test]
    fn secret_redactor_json_line_path_scoped_carry_not_stolen_by_leaf_name_collision() {
        // Reproduces the round-6 P1/P2 regression: a bare leaf-name carry
        // (keyed on "text" alone, ignoring structural path) lets an
        // unrelated top-level "text" field steal and consume the carry
        // armed by a nested "delta.text" field, so the true continuation
        // under "delta.text" then leaks verbatim. Path-scoped carry must
        // keep "text" and "delta.text" independent.
        let mut redactor = SecretRedactor::new();

        // evt1: arms the carry for path "delta.text".
        redactor.redact_json_line("{\"delta\":{\"text\":\"Authorization:\"}}\n");

        // evt2: unrelated TOP-LEVEL "text" field (path "text", not
        // "delta.text") must round-trip byte-identical — it must not steal
        // or consume the "delta.text" carry.
        let evt2_line = "{\"text\":\"ordinary benign sentence.\"}\n";
        let evt2_out = redactor.redact_json_line(evt2_line);
        assert_eq!(evt2_out, evt2_line);

        // evt3: the true continuation under "delta.text" — the carry must
        // still be armed (untouched by evt2) and redact the split secret.
        let evt3_out =
            redactor.redact_json_line("{\"delta\":{\"text\":\"Basic opaqueSECRETXYZ\"}}\n");
        assert!(!evt3_out.contains("opaqueSECRETXYZ"));
    }

    #[test]
    fn secret_redactor_json_line_top_level_text_does_not_over_redact_after_nested_arm() {
        // Companion to the leak repro above: after a nested "delta.text"
        // arm, an unrelated top-level "text" event with its own would-be
        // credential value must not be over-redacted by the nested carry
        // (the P2 half of the round-6 regression).
        let mut redactor = SecretRedactor::new();
        redactor.redact_json_line("{\"delta\":{\"text\":\"Authorization:\"}}\n");

        let evt2_line = "{\"text\":\"Basic opaqueTOPLEVEL\"}\n";
        let evt2_out = redactor.redact_json_line(evt2_line);
        assert_eq!(evt2_out, evt2_line);
    }

    #[test]
    fn secret_redactor_json_line_json_carry_growth_is_capped() {
        // Arm exactly JSON_CARRY_MAX_KEYS (128) distinct top-level paths —
        // fills the carry to capacity without exceeding it.
        let mut redactor = SecretRedactor::new();
        for i in 0..128 {
            let line = format!("{{\"k{i:03}\":\"Authorization:\"}}\n");
            redactor.redact_json_line(&line);
        }

        // A 129th distinct path arrives once the cap is already full: its
        // arming insert is skipped (fail-open toward less carry), so its
        // continuation is NOT redacted.
        redactor.redact_json_line("{\"k128\":\"Authorization:\"}\n");
        let over_cap_continuation =
            redactor.redact_json_line("{\"k128\":\"Basic opaqueOVERCAP\"}\n");
        assert!(over_cap_continuation.contains("opaqueOVERCAP"));

        // An early path armed before the cap was reached is unaffected by
        // the later skipped insert — still armed, still redacts.
        let early_continuation = redactor.redact_json_line("{\"k000\":\"Basic opaqueEARLY\"}\n");
        assert!(!early_continuation.contains("opaqueEARLY"));
    }

    #[test]
    fn secret_redactor_json_line_dotted_literal_key_does_not_alias_nested_path() {
        // Reproduces the round-7 P1 regression: a plain dotted join
        // (`format!("{parent}.{key}")`) makes the path for nested
        // ["delta","text"] identical to the path for a literal top-level
        // key "delta.text" ("delta.text" == "delta" + "." + "text"). A
        // length-prefixed encoding must keep them distinct.
        let mut redactor = SecretRedactor::new();

        // evt1: arms the carry for the NESTED path ["delta","text"].
        redactor.redact_json_line("{\"delta\":{\"text\":\"Authorization:\"}}\n");

        // evt2: a LITERAL "delta.text" key — a different path under the new
        // encoding — must round-trip byte-identical: it must not steal the
        // nested arm, and its own benign value must not falsely arm or
        // consume anything.
        let evt2_line = "{\"delta.text\":\"benign\"}\n";
        let evt2_out = redactor.redact_json_line(evt2_line);
        assert_eq!(evt2_out, evt2_line);

        // evt3: the true nested continuation must still be armed (untouched
        // by evt2) and redact the split secret.
        let evt3_out =
            redactor.redact_json_line("{\"delta\":{\"text\":\"Basic opaqueCHAINLEAK\"}}\n");
        assert!(!evt3_out.contains("opaqueCHAINLEAK"));
    }

    #[test]
    fn secret_redactor_json_line_literal_dotted_key_carry_is_path_isolated() {
        // Reverse direction of the above: arming via the LITERAL "delta.text"
        // key must not be consumable by the NESTED ["delta","text"] path —
        // they are different carry slots by construction, so the nested
        // event's own credential-looking value is untouched (that is
        // correct path isolation, not a leak: the nested path was never
        // armed), while a further literal-key continuation still redacts.
        let mut redactor = SecretRedactor::new();

        // evt1: arms the carry for the LITERAL "delta.text" path.
        redactor.redact_json_line("{\"delta.text\":\"Authorization:\"}\n");

        // evt2: the NESTED path is a different slot, so it is not armed —
        // "Basic opaqueREV1" is not preceded by an armed "Authorization:"
        // under its own path, so it is left untouched.
        let evt2_out = redactor.redact_json_line("{\"delta\":{\"text\":\"Basic opaqueREV1\"}}\n");
        assert!(evt2_out.contains("opaqueREV1"));

        // evt3: the literal-key continuation is still the armed path from
        // evt1 and must redact.
        let evt3_out = redactor.redact_json_line("{\"delta.text\":\"Basic opaqueREV2\"}\n");
        assert!(!evt3_out.contains("opaqueREV2"));
    }

    #[test]
    fn redact_secrets_preserving_format_redacts_bracket_wrapped_sk_and_aiza() {
        let redacted_sk = redact_secrets_preserving_format("key=[sk-test000aaaabbbbccccdddd] end");
        assert!(!redacted_sk.contains("sk-test000aaaabbbbccccdddd"));
        assert!(redacted_sk.contains("[REDACTED]"));

        let redacted_google = redact_secrets_preserving_format("[AIzaTest000aaaabbbbccccdddd] end");
        assert!(!redacted_google.contains("AIzaTest000aaaabbbbccccdddd"));
        assert!(redacted_google.contains("[REDACTED]"));
    }

    #[test]
    fn redact_secrets_preserving_format_redacts_authorization_basic_scheme_credential() {
        let redacted = redact_secrets_preserving_format("Authorization: Basic dGVzdDAwMA== next");
        assert!(!redacted.contains("dGVzdDAwMA=="));
        assert!(redacted.contains("[REDACTED]"));
        assert!(redacted.ends_with(" next"));
    }

    #[test]
    fn redact_secrets_preserving_format_keeps_lookalike_hyphen_words() {
        assert_eq!(
            redact_secrets_preserving_format("risk-assessment"),
            "risk-assessment"
        );
        assert_eq!(redact_secrets_preserving_format("task-list"), "task-list");
        assert_eq!(
            redact_secrets_preserving_format("http-keepaliveconnectionmanager"),
            "http-keepaliveconnectionmanager"
        );
    }

    #[test]
    fn secret_redactor_carries_state_across_lines() {
        let mut redactor = SecretRedactor::new();
        let first = redactor.redact_line("set authorization:\n");
        assert_eq!(first, "set [REDACTED]\n");
        let second = redactor.redact_line("gatewaycredentialvalue\n");
        assert_eq!(second, "[REDACTED]\n");
    }

    #[test]
    fn redact_secrets_preserving_format_redacts_hyphen_segmented_tp_key() {
        // Real litellm gateway keys (litellm/config.yaml) are a single
        // unbroken alnum run after "tp-", e.g.
        // tp-sw0ia7x8u1f6q2alk14bw5613jith6io0yjefem02tzniq6z. The rule here
        // is deliberately a superset that also catches dash/underscore
        // segmented forms (UUID-like keys) by counting alnum chars across
        // the whole run.
        let redacted = redact_secrets_preserving_format("tp-ab12cd34-ef56-gh78 tail");
        assert!(!redacted.contains("tp-ab12cd34-ef56-gh78"));
        assert!(redacted.contains("[REDACTED]"));
        assert!(redacted.ends_with(" tail"));

        // "tp-link-archer-c7" (a router model name) has exactly 12
        // alphanumeric chars across its dash segments (link=4, archer=6,
        // c7=2), which crosses the >=12 threshold under the same rule. This
        // is an accepted false positive: the real gateway key format has no
        // dashes at all, so favoring over-redaction of rare hyphenated
        // product names over under-redacting a real key is the safer
        // tradeoff.
        let router_redacted = redact_secrets_preserving_format("tp-link-archer-c7 tail");
        assert!(!router_redacted.contains("tp-link-archer-c7"));
        assert!(router_redacted.contains("[REDACTED]"));
    }

    #[test]
    fn redact_secrets_preserving_format_detects_later_tp_occurrence_in_one_token() {
        // Single whitespace-delimited token with two "tp-" occurrences. The
        // first occurrence's run is cut short by the ":" delimiter (only 2
        // alnum chars, "ab" -- below the 12 threshold); the second
        // occurrence, right after the ":", has a long unbroken alnum run.
        // token_has_tp_secret must keep scanning past the first
        // non-matching occurrence instead of stopping there.
        let token = "tp-ab:tp-longenoughsecretvalue123";
        let redacted = redact_secrets_preserving_format(token);
        assert_eq!(redacted, "[REDACTED]");
    }
}
