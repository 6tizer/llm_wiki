use std::path::Path;
use unicode_normalization::UnicodeNormalization;

use super::*;

pub(crate) fn normalize_profile_json(
    code: &str,
    field: &str,
    value: &str,
    max_bytes: usize,
) -> Result<String, String> {
    let value = require_limited_non_empty(code, field, value.trim(), max_bytes)?;
    serde_json::from_str::<serde_json::Value>(value)
        .map_err(|err| format!("{code}: {field} must be valid JSON: {err}"))?;
    Ok(value.to_string())
}

pub(crate) fn normalize_non_negative_ms(
    code: &str,
    field: &str,
    value: i64,
) -> Result<i64, String> {
    if value >= 0 {
        Ok(value)
    } else {
        Err(format!("{code}: {field} must be non-negative"))
    }
}

pub(crate) fn bool_to_i64(value: bool) -> i64 {
    if value {
        1
    } else {
        0
    }
}

pub(crate) fn require_enabled_project(
    project_root: Option<&Path>,
    enabled: bool,
) -> Result<&Path, String> {
    if !enabled {
        return Err("runtime-disabled: work runtime is disabled".to_string());
    }
    project_root.ok_or_else(|| "no-project: no project root is open".to_string())
}

pub(crate) fn now_for_enabled_project(
    project_root: Option<&Path>,
    enabled: bool,
) -> Result<i64, String> {
    require_enabled_project(project_root, enabled)?;
    now_ms()
}

pub(crate) fn require_non_empty<'a>(
    code: &str,
    field: &str,
    value: &'a str,
) -> Result<&'a str, String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        Err(format!("{code}: {field} must not be empty"))
    } else {
        Ok(trimmed)
    }
}

pub(crate) fn require_required_non_empty<'a>(
    code: &str,
    field: &str,
    value: Option<&'a str>,
) -> Result<&'a str, String> {
    let value = value.ok_or_else(|| format!("{code}: {field} is required"))?;
    require_non_empty(code, field, value)
}

pub(crate) fn require_event_payload(value: &str) -> Result<&str, String> {
    let payload = require_non_empty("invalid-payload", "payload", value)?;
    if payload.len() > MAX_EVENT_PAYLOAD_BYTES {
        Err(format!(
            "invalid-payload: payload must be at most {MAX_EVENT_PAYLOAD_BYTES} bytes"
        ))
    } else {
        Ok(payload)
    }
}

pub(crate) fn require_limited_non_empty<'a>(
    code: &str,
    field: &str,
    value: &'a str,
    max_bytes: usize,
) -> Result<&'a str, String> {
    let value = require_non_empty(code, field, value)?;
    if value.len() > max_bytes {
        Err(format!("{code}: {field} must be at most {max_bytes} bytes"))
    } else {
        Ok(value)
    }
}

pub(crate) fn normalize_optional_limited_text(
    code: &str,
    field: &str,
    value: Option<String>,
    max_bytes: usize,
) -> Result<Option<String>, String> {
    value
        .map(|value| require_limited_non_empty(code, field, &value, max_bytes).map(str::to_string))
        .transpose()
}

pub(crate) fn normalize_optional_id(
    code: &str,
    field: &str,
    value: Option<String>,
) -> Result<Option<String>, String> {
    value
        .map(|value| require_non_empty(code, field, &value).map(str::to_string))
        .transpose()
}

pub(crate) fn normalize_optional_filter(
    code: &str,
    field: &str,
    value: Option<String>,
) -> Result<Option<String>, String> {
    normalize_optional_id(code, field, value)
}

pub(crate) fn normalize_list_limit(
    limit: Option<i64>,
    default_limit: i64,
    max_limit: i64,
) -> Result<i64, String> {
    let limit = limit.unwrap_or(default_limit);
    if (1..=max_limit).contains(&limit) {
        Ok(limit)
    } else {
        Err(format!(
            "invalid-limit: limit must be between 1 and {max_limit}"
        ))
    }
}

pub(crate) fn normalize_affected_path(raw: &str) -> Result<NormalizedAffectedPath, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("invalid-affected-path: affectedPath must not be empty".to_string());
    }
    let raw_bytes = trimmed.as_bytes();
    if raw_bytes.len() >= 2 && raw_bytes[1] == b':' && raw_bytes[0].is_ascii_alphabetic() {
        return Err("invalid-affected-path: drive-prefixed paths are not allowed".to_string());
    }

    let normalized_slashes = trimmed.replace('\\', "/");
    if normalized_slashes.starts_with('/') {
        return Err("invalid-affected-path: absolute paths are not allowed".to_string());
    }
    if normalized_slashes.ends_with('/') {
        return Err("invalid-affected-path: directory paths are not allowed".to_string());
    }

    let mut segments = Vec::new();
    for segment in normalized_slashes.split('/') {
        if segment.is_empty() {
            return Err("invalid-affected-path: empty path segments are not allowed".to_string());
        }
        if matches!(segment, "." | "..") {
            return Err("invalid-affected-path: traversal segments are not allowed".to_string());
        }
        segments.push(segment);
    }

    let leaf = segments
        .last()
        .ok_or_else(|| "invalid-affected-path: affectedPath must not be empty".to_string())?;
    let leaf_lower = leaf.to_ascii_lowercase();
    if leaf_lower == ".md" || !leaf_lower.ends_with(".md") {
        return Err(
            "invalid-affected-path: affectedPath must point to a Markdown file".to_string(),
        );
    }

    let display_key = segments.join("/");
    let resource_key = segments
        .iter()
        .map(|segment| segment.nfc().collect::<String>().to_lowercase())
        .collect::<Vec<_>>()
        .join("/");
    Ok(NormalizedAffectedPath {
        display_key,
        resource_key,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn now_for_enabled_project_returns_disabled_before_no_project() {
        let error = now_for_enabled_project(None, false).expect_err("disabled wins");

        assert!(error.starts_with("runtime-disabled"));
    }

    #[test]
    fn normalize_affected_path_rejects_unsafe_inputs_and_normalizes_identity() {
        let normalized = normalize_affected_path(" Wiki/Café.MD ").expect("normalize path");
        assert_eq!(normalized.display_key, "Wiki/Café.MD");
        assert_eq!(normalized.resource_key, "wiki/café.md");
        let decomposed = normalize_affected_path("wiki/Cafe\u{301}.md").expect("normalize nfc");
        assert_eq!(decomposed.resource_key, "wiki/café.md");

        for raw in [
            "",
            "/a.md",
            "\\a.md",
            "C:\\a.md",
            "a//b.md",
            "./a.md",
            "a/../b.md",
            "a/.md",
            "wiki/a.txt",
            "wiki/",
            "\\\\?\\C:\\a.md",
            "\\\\server\\share\\a.md",
        ] {
            assert!(
                normalize_affected_path(raw).is_err(),
                "{raw:?} should be rejected"
            );
        }
    }
}
