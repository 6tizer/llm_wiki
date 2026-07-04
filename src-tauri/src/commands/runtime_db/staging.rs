use std::path::Path;
use rusqlite::{params, Connection, OpenFlags, OptionalExtension, Transaction};
use tauri::State;
use crate::commands::file_sync::ProjectRootState;
use crate::panic_guard::run_guarded;

use super::*;
use uuid::Uuid;
use sha2::{Digest, Sha256};


/// Record or advance staging artifact metadata for the currently-open project.
#[tauri::command]
pub fn runtime_staging_artifact_record(
    request: RuntimeStagingArtifactRecordRequest,
    root_state: State<'_, ProjectRootState>,
) -> Result<RuntimeStagingArtifactRecord, String> {
    run_guarded("runtime_staging_artifact_record", || {
        let runtime_enabled = resolve_work_runtime_enabled(read_work_runtime_flag_value());
        let project_root = root_state.get();
        let now = now_for_enabled_project(project_root.as_deref(), runtime_enabled)?;
        runtime_staging_artifact_record_for_project(
            project_root.as_deref(),
            runtime_enabled,
            request,
            now,
        )
    })
}

/// Store a validated staging artifact body and commit-intent metadata.
#[tauri::command]
pub fn runtime_staging_artifact_store(
    request: RuntimeStagingArtifactStoreRequest,
    root_state: State<'_, ProjectRootState>,
) -> Result<RuntimeStagingArtifactRecord, String> {
    run_guarded("runtime_staging_artifact_store", || {
        let runtime_enabled = resolve_work_runtime_enabled(read_work_runtime_flag_value());
        let project_root = root_state.get();
        let now = now_for_enabled_project(project_root.as_deref(), runtime_enabled)?;
        runtime_staging_artifact_store_for_project(
            project_root.as_deref(),
            runtime_enabled,
            request,
            now,
        )
    })
}

/// Read a pending staging artifact body by registered artifact id.
#[tauri::command]
pub fn runtime_staging_artifact_read_body(
    request: RuntimeStagingArtifactReadBodyRequest,
    root_state: State<'_, ProjectRootState>,
) -> Result<RuntimeStagingArtifactReadBody, String> {
    run_guarded("runtime_staging_artifact_read_body", || {
        let runtime_enabled = resolve_work_runtime_enabled(read_work_runtime_flag_value());
        let project_root = root_state.get();
        runtime_staging_artifact_read_body_for_project(
            project_root.as_deref(),
            runtime_enabled,
            request,
        )
    })
}

/// Clear pending staging artifacts and files for one runtime job.
#[tauri::command]
pub fn runtime_staging_artifacts_clear_pending_for_job(
    request: RuntimeStagingArtifactsClearPendingForJobRequest,
    root_state: State<'_, ProjectRootState>,
) -> Result<RuntimeStagingArtifactsClearPendingForJob, String> {
    run_guarded("runtime_staging_artifacts_clear_pending_for_job", || {
        let runtime_enabled = resolve_work_runtime_enabled(read_work_runtime_flag_value());
        let project_root = root_state.get();
        let now = now_for_enabled_project(project_root.as_deref(), runtime_enabled)?;
        runtime_staging_artifacts_clear_pending_for_job_for_project(
            project_root.as_deref(),
            runtime_enabled,
            request,
            now,
        )
    })
}

/// Mark a committed staging artifact and clean up its runtime staging file.
#[tauri::command]
pub fn runtime_staging_artifact_commit_success(
    request: RuntimeStagingArtifactCommitSuccessRequest,
    root_state: State<'_, ProjectRootState>,
) -> Result<RuntimeStagingArtifactRecord, String> {
    run_guarded("runtime_staging_artifact_commit_success", || {
        let runtime_enabled = resolve_work_runtime_enabled(read_work_runtime_flag_value());
        let project_root = root_state.get();
        let now = now_for_enabled_project(project_root.as_deref(), runtime_enabled)?;
        runtime_staging_artifact_commit_success_for_project(
            project_root.as_deref(),
            runtime_enabled,
            request,
            now,
        )
    })
}

/// Delete expired failed/cancelled staging artifacts for the currently-open project.
#[tauri::command]
pub fn runtime_staging_artifact_gc(
    root_state: State<'_, ProjectRootState>,
) -> Result<RuntimeStagingArtifactGc, String> {
    run_guarded("runtime_staging_artifact_gc", || {
        let runtime_enabled = resolve_work_runtime_enabled(read_work_runtime_flag_value());
        let project_root = root_state.get();
        let now = now_for_enabled_project(project_root.as_deref(), runtime_enabled)?;
        runtime_staging_artifact_gc_for_project(project_root.as_deref(), runtime_enabled, now)
    })
}

/// List staging artifact metadata for the currently-open project.
#[tauri::command]
pub fn runtime_staging_artifact_list(
    request: Option<RuntimeStagingArtifactListRequest>,
    root_state: State<'_, ProjectRootState>,
) -> Result<RuntimeStagingArtifactList, String> {
    run_guarded("runtime_staging_artifact_list", || {
        runtime_staging_artifact_list_for_project(
            root_state.get().as_deref(),
            resolve_work_runtime_enabled(read_work_runtime_flag_value()),
            request.unwrap_or(RuntimeStagingArtifactListRequest {
                job_id: None,
                status: None,
                limit: None,
            }),
        )
    })
}

fn runtime_staging_artifact_record_for_project(
    project_root: Option<&Path>,
    enabled: bool,
    request: RuntimeStagingArtifactRecordRequest,
    now: i64,
) -> Result<RuntimeStagingArtifactRecord, String> {
    let project_root = require_enabled_project(project_root, enabled)?;
    let job_id = require_non_empty("invalid-job-id", "jobId", &request.job_id)?.to_string();
    let artifact_path = normalize_staging_artifact_path(&request.artifact_path)?;
    let artifact_hash = require_limited_non_empty(
        "invalid-artifact-hash",
        "artifactHash",
        &request.artifact_hash,
        MAX_STAGING_ARTIFACT_HASH_BYTES,
    )?
    .to_string();
    let status = normalize_record_artifact_status(request.status.as_deref())?;
    let ttl_ms = normalize_failed_artifact_ttl(request.ttl_ms)?;
    let expires_at_ms = if matches!(status, FAILED_ARTIFACT_STATUS | CANCELLED_ARTIFACT_STATUS) {
        Some(
            now.checked_add(ttl_ms)
                .ok_or_else(|| "invalid-ttl: staging artifact expiry overflow".to_string())?,
        )
    } else {
        None
    };
    let last_error = normalize_optional_limited_text(
        "invalid-last-error",
        "lastError",
        request.last_error,
        MAX_STAGING_ARTIFACT_ERROR_BYTES,
    )?;
    let artifact_id = match request.artifact_id {
        Some(artifact_id) => {
            require_non_empty("invalid-artifact-id", "artifactId", &artifact_id)?.to_string()
        }
        None => Uuid::new_v4().to_string(),
    };

    with_runtime_writer(|| {
        let mut connection = open_staging_artifacts_runtime_locked(project_root)?;
        std::fs::create_dir_all(staging_dir_path(project_root)).map_err(|err| {
            format!("staging-dir-create-failed: failed to create staging directory: {err}")
        })?;
        let tx = connection.transaction().map_err(tx_err)?;
        ensure_job_exists(&tx, &job_id)?;
        match read_staging_artifact_optional_tx(&tx, &artifact_id)? {
            Some(existing) => {
                if existing.status != PENDING_ARTIFACT_STATUS {
                    return Err(format!(
                        "invalid-state: record is not allowed from '{}'",
                        existing.status
                    ));
                }
                tx.execute(
                    "UPDATE runtime_staging_artifacts
                     SET job_id = ?2,
                         artifact_path = ?3,
                         artifact_hash = ?4,
                         status = ?5,
                         updated_at_ms = ?6,
                         expires_at_ms = ?7,
                         last_error = ?8
                     WHERE artifact_id = ?1 AND status = 'pending'",
                    params![
                        artifact_id,
                        job_id,
                        artifact_path,
                        artifact_hash,
                        status,
                        now,
                        expires_at_ms,
                        last_error
                    ],
                )
                .map_err(|err| format!("staging-artifact-record-update-failed: {err}"))?;
            }
            None => {
                if status != PENDING_ARTIFACT_STATUS {
                    return Err(format!(
                        "invalid-state: new staging artifacts must start as '{PENDING_ARTIFACT_STATUS}'"
                    ));
                }
                tx.execute(
                    "INSERT INTO runtime_staging_artifacts (
                        artifact_id,
                        job_id,
                        artifact_path,
                        artifact_hash,
                        status,
                        created_at_ms,
                        updated_at_ms,
                        expires_at_ms,
                        last_error
                    ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6, ?7, ?8)",
                    params![
                        artifact_id,
                        job_id,
                        artifact_path,
                        artifact_hash,
                        status,
                        now,
                        expires_at_ms,
                        last_error
                    ],
                )
                .map_err(|err| format!("staging-artifact-record-insert-failed: {err}"))?;
            }
        }
        let artifact = read_staging_artifact_tx(&tx, &artifact_id)?;
        tx.commit().map_err(tx_err)?;
        Ok(artifact)
    })
}

fn runtime_staging_artifact_store_for_project(
    project_root: Option<&Path>,
    enabled: bool,
    request: RuntimeStagingArtifactStoreRequest,
    now: i64,
) -> Result<RuntimeStagingArtifactRecord, String> {
    let project_root = require_enabled_project(project_root, enabled)?;
    let artifact_id =
        require_non_empty("invalid-artifact-id", "artifactId", &request.artifact_id)?.to_string();
    let job_id = require_non_empty("invalid-job-id", "jobId", &request.job_id)?.to_string();
    let artifact_path = normalize_staging_artifact_path(&request.artifact_path)?;
    ensure_staging_artifact_path_scoped_to_job(&job_id, &artifact_path)?;
    let target_path = normalize_affected_path(&request.target_path)?.display_key;
    let operation_intent = normalize_markdown_operation_intent(&request.operation_intent)?;
    let base_hash = normalize_staging_base_hash(request.base_hash)?;
    validate_operation_base_hash(&operation_intent, base_hash.as_deref())?;
    let source_kind = normalize_staging_source_kind(&request.source_kind)?;
    let markdown = normalize_staging_markdown_body(&request.markdown)?;
    let artifact_hash = hash_staging_markdown(&markdown);

    let mut wrote_file = false;
    let result = with_runtime_writer(|| {
        let mut connection = open_staging_artifacts_runtime_locked(project_root)?;
        let tx = connection.transaction().map_err(tx_err)?;
        ensure_job_exists(&tx, &job_id)?;
        let existing = read_staging_artifact_optional_tx(&tx, &artifact_id)?;
        if let Some(existing) = existing.as_ref() {
            if existing.status != PENDING_ARTIFACT_STATUS {
                return Err(format!(
                    "invalid-state: store is not allowed from '{}'",
                    existing.status
                ));
            }
        }
        ensure_staging_artifact_path_available_tx(&tx, &artifact_id, &artifact_path)?;
        write_normalized_staging_artifact_file(project_root, &artifact_path, &markdown)?;
        wrote_file = true;

        match existing {
            Some(_existing) => {
                tx.execute(
                    "UPDATE runtime_staging_artifacts
                     SET job_id = ?2,
                         artifact_path = ?3,
                         artifact_hash = ?4,
                         target_path = ?5,
                         operation_intent = ?6,
                         base_hash = ?7,
                         source_kind = ?8,
                         status = ?9,
                         updated_at_ms = ?10,
                         expires_at_ms = NULL,
                         last_error = NULL
                     WHERE artifact_id = ?1 AND status = 'pending'",
                    params![
                        artifact_id,
                        job_id,
                        artifact_path,
                        artifact_hash,
                        target_path,
                        operation_intent,
                        base_hash,
                        source_kind,
                        PENDING_ARTIFACT_STATUS,
                        now,
                    ],
                )
                .map_err(|err| format!("staging-artifact-store-update-failed: {err}"))?;
            }
            None => {
                tx.execute(
                    "INSERT INTO runtime_staging_artifacts (
                        artifact_id,
                        job_id,
                        artifact_path,
                        artifact_hash,
                        target_path,
                        operation_intent,
                        base_hash,
                        source_kind,
                        status,
                        created_at_ms,
                        updated_at_ms,
                        expires_at_ms,
                        last_error
                    ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10, NULL, NULL)",
                    params![
                        artifact_id,
                        job_id,
                        artifact_path,
                        artifact_hash,
                        target_path,
                        operation_intent,
                        base_hash,
                        source_kind,
                        PENDING_ARTIFACT_STATUS,
                        now,
                    ],
                )
                .map_err(|err| format!("staging-artifact-store-insert-failed: {err}"))?;
            }
        }
        let artifact = read_staging_artifact_tx(&tx, &artifact_id)?;
        tx.commit().map_err(tx_err)?;
        Ok(artifact)
    });
    if result.is_err() && wrote_file {
        let _ = remove_staging_artifact_file(project_root, &artifact_path);
    }
    result
}

fn runtime_staging_artifact_read_body_for_project(
    project_root: Option<&Path>,
    enabled: bool,
    request: RuntimeStagingArtifactReadBodyRequest,
) -> Result<RuntimeStagingArtifactReadBody, String> {
    let project_root = require_enabled_project(project_root, enabled)?;
    let artifact_id = require_non_empty("invalid-artifact-id", "artifactId", &request.artifact_id)?;
    let connection = open_staging_artifacts_runtime_locked(project_root)?;
    let artifact = read_staging_artifact_tx_unchecked(&connection, artifact_id)?;
    if artifact.status != PENDING_ARTIFACT_STATUS {
        return Err(format!(
            "invalid-state: read_body is not allowed from '{}'",
            artifact.status
        ));
    }
    ensure_staging_artifact_path_scoped_to_job(&artifact.job_id, &artifact.artifact_path)?;
    let markdown = read_staging_artifact_file(project_root, &artifact.artifact_path)?;
    Ok(RuntimeStagingArtifactReadBody {
        artifact_id: artifact.artifact_id,
        artifact_path: artifact.artifact_path,
        markdown,
    })
}

fn runtime_staging_artifacts_clear_pending_for_job_for_project(
    project_root: Option<&Path>,
    enabled: bool,
    request: RuntimeStagingArtifactsClearPendingForJobRequest,
    _now: i64,
) -> Result<RuntimeStagingArtifactsClearPendingForJob, String> {
    let project_root = require_enabled_project(project_root, enabled)?;
    let job_id = require_non_empty("invalid-job-id", "jobId", &request.job_id)?.to_string();
    with_runtime_writer(|| {
        let mut connection = open_staging_artifacts_runtime_locked(project_root)?;
        let tx = connection.transaction().map_err(tx_err)?;
        ensure_job_exists(&tx, &job_id)?;
        let pending = read_pending_staging_artifacts_for_job_tx(&tx, &job_id)?;
        for artifact in &pending {
            remove_staging_artifact_file(project_root, &artifact.artifact_path)?;
            tx.execute(
                "DELETE FROM runtime_staging_artifacts
                 WHERE artifact_id = ?1 AND status = ?2",
                params![artifact.artifact_id, PENDING_ARTIFACT_STATUS],
            )
            .map_err(|err| format!("staging-artifact-clear-pending-failed: {err}"))?;
        }
        tx.commit().map_err(tx_err)?;
        Ok(RuntimeStagingArtifactsClearPendingForJob { cleared: pending })
    })
}

fn runtime_staging_artifact_commit_success_for_project(
    project_root: Option<&Path>,
    enabled: bool,
    request: RuntimeStagingArtifactCommitSuccessRequest,
    now: i64,
) -> Result<RuntimeStagingArtifactRecord, String> {
    let project_root = require_enabled_project(project_root, enabled)?;
    let artifact_id = require_non_empty("invalid-artifact-id", "artifactId", &request.artifact_id)?;
    with_runtime_writer(|| {
        let mut connection = open_staging_artifacts_runtime_locked(project_root)?;
        let tx = connection.transaction().map_err(tx_err)?;
        let artifact = read_staging_artifact_tx(&tx, artifact_id)?;
        match artifact.status.as_str() {
            COMMITTED_ARTIFACT_STATUS => {
                tx.commit().map_err(tx_err)?;
                return Ok(artifact);
            }
            PENDING_ARTIFACT_STATUS => {}
            status => {
                return Err(format!(
                    "invalid-state: commit_success is not allowed from '{status}'"
                ));
            }
        }
        remove_staging_artifact_file(project_root, &artifact.artifact_path)?;
        tx.execute(
            "UPDATE runtime_staging_artifacts
             SET status = ?2,
                 updated_at_ms = ?3,
                 expires_at_ms = NULL,
                 deleted_at_ms = ?3
             WHERE artifact_id = ?1 AND status = ?4",
            params![
                artifact_id,
                COMMITTED_ARTIFACT_STATUS,
                now,
                PENDING_ARTIFACT_STATUS
            ],
        )
        .map_err(|err| format!("staging-artifact-commit-update-failed: {err}"))?;
        let updated = read_staging_artifact_tx(&tx, artifact_id)?;
        tx.commit().map_err(tx_err)?;
        Ok(updated)
    })
}

fn runtime_staging_artifact_gc_for_project(
    project_root: Option<&Path>,
    enabled: bool,
    now: i64,
) -> Result<RuntimeStagingArtifactGc, String> {
    let project_root = require_enabled_project(project_root, enabled)?;
    with_runtime_writer(|| {
        let mut connection = open_staging_artifacts_runtime_locked(project_root)?;
        let tx = connection.transaction().map_err(tx_err)?;
        let expired = read_expired_staging_artifacts_tx(&tx, now)?;
        let mut deleted = Vec::with_capacity(expired.len());
        for artifact in expired {
            remove_staging_artifact_file(project_root, &artifact.artifact_path)?;
            tx.execute(
                "UPDATE runtime_staging_artifacts
                 SET status = ?2,
                     updated_at_ms = ?3,
                     deleted_at_ms = ?3
                 WHERE artifact_id = ?1
                   AND status IN ('failed', 'cancelled')
                   AND expires_at_ms IS NOT NULL
                   AND expires_at_ms <= ?3",
                params![artifact.artifact_id, DELETED_ARTIFACT_STATUS, now],
            )
            .map_err(|err| format!("staging-artifact-gc-update-failed: {err}"))?;
            deleted.push(read_staging_artifact_tx(&tx, &artifact.artifact_id)?);
        }
        tx.commit().map_err(tx_err)?;
        Ok(RuntimeStagingArtifactGc { deleted })
    })
}

fn runtime_staging_artifact_list_for_project(
    project_root: Option<&Path>,
    enabled: bool,
    request: RuntimeStagingArtifactListRequest,
) -> Result<RuntimeStagingArtifactList, String> {
    if !enabled {
        return Ok(RuntimeStagingArtifactList {
            enabled: false,
            status: RuntimeDbHealthState::Disabled,
            artifacts: Vec::new(),
        });
    }
    let Some(project_root) = project_root else {
        return Ok(RuntimeStagingArtifactList {
            enabled: true,
            status: RuntimeDbHealthState::NoProject,
            artifacts: Vec::new(),
        });
    };
    let limit = normalize_list_limit(
        request.limit,
        DEFAULT_STAGING_ARTIFACT_LIMIT,
        MAX_STAGING_ARTIFACT_LIMIT,
    )?;
    let job_id = normalize_optional_filter("invalid-job-id", "jobId", request.job_id)?;
    let status = normalize_artifact_status_filter(request.status.as_deref())?;
    let db_path = runtime_db_path(project_root);
    if !db_path.exists() {
        return Ok(RuntimeStagingArtifactList {
            enabled: true,
            status: RuntimeDbHealthState::Healthy,
            artifacts: Vec::new(),
        });
    }
    let connection = Connection::open_with_flags(
        db_path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|err| format!("staging-artifact-list-open-failed: {err}"))?;
    if !table_exists(&connection, "runtime_staging_artifacts")? {
        return Ok(RuntimeStagingArtifactList {
            enabled: true,
            status: RuntimeDbHealthState::Healthy,
            artifacts: Vec::new(),
        });
    }
    let include_commit_metadata = staging_artifact_commit_metadata_columns_exist(&connection)?;
    Ok(RuntimeStagingArtifactList {
        enabled: true,
        status: RuntimeDbHealthState::Healthy,
        artifacts: read_staging_artifacts(
            &connection,
            job_id.as_deref(),
            status,
            limit,
            include_commit_metadata,
        )?,
    })
}

fn normalize_failed_artifact_ttl(ttl_ms: Option<i64>) -> Result<i64, String> {
    let ttl_ms = ttl_ms.unwrap_or(DEFAULT_FAILED_ARTIFACT_TTL_MS);
    if !(1..=MAX_FAILED_ARTIFACT_TTL_MS).contains(&ttl_ms) {
        Err(format!(
            "invalid-ttl: ttlMs must be between 1 and {MAX_FAILED_ARTIFACT_TTL_MS}"
        ))
    } else {
        Ok(ttl_ms)
    }
}

fn normalize_record_artifact_status(value: Option<&str>) -> Result<&str, String> {
    let status = value.unwrap_or(PENDING_ARTIFACT_STATUS).trim();
    match status {
        PENDING_ARTIFACT_STATUS | FAILED_ARTIFACT_STATUS | CANCELLED_ARTIFACT_STATUS => Ok(status),
        COMMITTED_ARTIFACT_STATUS | DELETED_ARTIFACT_STATUS => Err(format!(
            "invalid-status: record cannot write '{status}' staging artifact status"
        )),
        _ => Err("invalid-status: unknown staging artifact status".to_string()),
    }
}

fn normalize_artifact_status_filter(value: Option<&str>) -> Result<Option<&str>, String> {
    value
        .map(|status| {
            let status = require_non_empty("invalid-status", "status", status)?;
            match status {
                PENDING_ARTIFACT_STATUS
                | COMMITTED_ARTIFACT_STATUS
                | FAILED_ARTIFACT_STATUS
                | CANCELLED_ARTIFACT_STATUS
                | DELETED_ARTIFACT_STATUS => Ok(status),
                _ => Err("invalid-status: unknown staging artifact status".to_string()),
            }
        })
        .transpose()
}

fn normalize_staging_artifact_path(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("invalid-artifact-path: artifactPath must not be empty".to_string());
    }
    if trimmed.len() > MAX_STAGING_ARTIFACT_PATH_BYTES {
        return Err(format!(
            "invalid-artifact-path: artifactPath must be at most {MAX_STAGING_ARTIFACT_PATH_BYTES} bytes"
        ));
    }
    let raw_bytes = trimmed.as_bytes();
    if raw_bytes.len() >= 2 && raw_bytes[1] == b':' && raw_bytes[0].is_ascii_alphabetic() {
        return Err("invalid-artifact-path: drive-prefixed paths are not allowed".to_string());
    }

    let normalized_slashes = trimmed.replace('\\', "/");
    if normalized_slashes.starts_with('/') {
        return Err("invalid-artifact-path: absolute paths are not allowed".to_string());
    }
    if normalized_slashes.ends_with('/') {
        return Err("invalid-artifact-path: directory paths are not allowed".to_string());
    }

    let mut segments = Vec::new();
    for segment in normalized_slashes.split('/') {
        if segment.is_empty() {
            return Err("invalid-artifact-path: empty path segments are not allowed".to_string());
        }
        if matches!(segment, "." | "..") {
            return Err("invalid-artifact-path: traversal segments are not allowed".to_string());
        }
        segments.push(segment);
    }

    if segments.is_empty() {
        Err("invalid-artifact-path: artifactPath must not be empty".to_string())
    } else {
        Ok(segments.join("/"))
    }
}

fn normalize_markdown_operation_intent(raw: &str) -> Result<String, String> {
    let value = require_non_empty("invalid-operation-intent", "operationIntent", raw)?;
    match value {
        "create" | "update" | "append" | "delete" => Ok(value.to_string()),
        _ => Err(format!("invalid-operation-intent: unsupported operationIntent '{value}'")),
    }
}

fn normalize_staging_base_hash(raw: Option<String>) -> Result<Option<String>, String> {
    normalize_optional_limited_text(
        "invalid-base-hash",
        "baseHash",
        raw,
        MAX_STAGING_ARTIFACT_HASH_BYTES,
    )
}

fn validate_operation_base_hash(
    operation_intent: &str,
    base_hash: Option<&str>,
) -> Result<(), String> {
    if operation_intent == "create" && base_hash.is_some() {
        return Err("invalid-base-hash: create requires null baseHash".to_string());
    }
    if matches!(operation_intent, "update" | "delete") && base_hash.is_none() {
        return Err(format!(
            "invalid-base-hash: {operation_intent} requires baseHash"
        ));
    }
    Ok(())
}

fn normalize_staging_source_kind(raw: &str) -> Result<String, String> {
    require_limited_non_empty(
        "invalid-source-kind",
        "sourceKind",
        raw,
        MAX_STAGING_ARTIFACT_SOURCE_KIND_BYTES,
    )
    .map(str::to_string)
}

fn normalize_staging_markdown_body(raw: &str) -> Result<String, String> {
    if raw.is_empty() {
        return Err("invalid-markdown: markdown must not be empty".to_string());
    }
    if raw.as_bytes().len() > MAX_STAGING_ARTIFACT_BODY_BYTES {
        return Err(format!(
            "invalid-markdown: markdown must be at most {MAX_STAGING_ARTIFACT_BODY_BYTES} bytes"
        ));
    }
    Ok(raw.to_string())
}

fn canonicalize_staging_markdown_for_hash(markdown: &str) -> String {
    markdown.replace("\r\n", "\n").replace('\r', "\n")
}

fn hash_staging_markdown(markdown: &str) -> String {
    let canonical = canonicalize_staging_markdown_for_hash(markdown);
    let mut hasher = Sha256::new();
    hasher.update(canonical.as_bytes());
    format!("{:x}", hasher.finalize())
}

fn write_normalized_staging_artifact_file(
    project_root: &Path,
    artifact_path: &str,
    markdown: &str,
) -> Result<(), String> {
    let staging_root = staging_dir_path(project_root);
    std::fs::create_dir_all(&staging_root).map_err(|err| {
        format!(
            "staging-dir-create-failed: failed to create staging directory '{}': {err}",
            staging_root.display()
        )
    })?;
    let target = staging_root.join(&artifact_path);
    let parent = target
        .parent()
        .ok_or_else(|| "invalid-artifact-path: artifact path has no parent".to_string())?;
    ensure_existing_staging_ancestors_safe(&staging_root, parent)?;
    std::fs::create_dir_all(parent).map_err(|err| {
        format!(
            "staging-dir-create-failed: failed to create staging artifact parent '{}': {err}",
            parent.display()
        )
    })?;
    ensure_staging_parent_inside_root(&staging_root, parent)?;
    if let Ok(metadata) = std::fs::symlink_metadata(&target) {
        if metadata.is_dir() {
            return Err(
                "invalid-artifact-path: staging artifact path points to a directory".to_string(),
            );
        }
        if metadata.file_type().is_symlink() {
            return Err(
                "invalid-artifact-path: staging artifact path points to a symlink".to_string(),
            );
        }
    }

    let file_name = target
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "invalid-artifact-path: artifact path has no file name".to_string())?;
    let temp = parent.join(format!(".{file_name}.tmp-{}", Uuid::new_v4()));
    std::fs::write(&temp, markdown.as_bytes()).map_err(|err| {
        format!(
            "staging-artifact-write-failed: failed to write '{}': {err}",
            temp.display()
        )
    })?;
    std::fs::rename(&temp, &target).map_err(|err| {
        let _ = std::fs::remove_file(&temp);
        format!(
            "staging-artifact-rename-failed: failed to move '{}' to '{}': {err}",
            temp.display(),
            target.display()
        )
    })
}

fn ensure_existing_staging_ancestors_safe(
    staging_root: &Path,
    parent: &Path,
) -> Result<(), String> {
    let relative = parent.strip_prefix(staging_root).map_err(|_| {
        "invalid-artifact-path: staging artifact parent is outside the runtime staging directory"
            .to_string()
    })?;
    let mut cursor = staging_root.to_path_buf();
    for component in relative.components() {
        cursor.push(component);
        match std::fs::symlink_metadata(&cursor) {
            Ok(metadata) => {
                if metadata.file_type().is_symlink() {
                    return Err(
                        "invalid-artifact-path: staging artifact parent contains a symlink"
                            .to_string(),
                    );
                }
                if !metadata.is_dir() {
                    return Err(
                        "invalid-artifact-path: staging artifact parent contains a file"
                            .to_string(),
                    );
                }
            }
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => break,
            Err(err) => {
                return Err(format!(
                    "staging-parent-stat-failed: failed to inspect '{}': {err}",
                    cursor.display()
                ))
            }
        }
    }
    Ok(())
}

fn ensure_staging_parent_inside_root(staging_root: &Path, parent: &Path) -> Result<(), String> {
    let canonical_root = std::fs::canonicalize(staging_root).map_err(|err| {
        format!(
            "staging-root-canonicalize-failed: failed to canonicalize '{}': {err}",
            staging_root.display()
        )
    })?;
    let canonical_parent = std::fs::canonicalize(parent).map_err(|err| {
        format!(
            "staging-parent-canonicalize-failed: failed to canonicalize '{}': {err}",
            parent.display()
        )
    })?;
    if canonical_parent.starts_with(&canonical_root) {
        Ok(())
    } else {
        Err("invalid-artifact-path: staging artifact escapes the runtime staging directory"
            .to_string())
    }
}

fn remove_staging_artifact_file(project_root: &Path, artifact_path: &str) -> Result<(), String> {
    let artifact_path = normalize_staging_artifact_path(artifact_path)?;
    let staging_root = staging_dir_path(project_root);
    std::fs::create_dir_all(&staging_root).map_err(|err| {
        format!(
            "staging-dir-create-failed: failed to create staging directory '{}': {err}",
            staging_root.display()
        )
    })?;
    let target = staging_root.join(artifact_path);
    let metadata = match std::fs::symlink_metadata(&target) {
        Ok(metadata) => metadata,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(err) => {
            return Err(format!(
                "staging-artifact-stat-failed: failed to inspect '{}': {err}",
                target.display()
            ))
        }
    };
    if metadata.is_dir() {
        return Err(
            "invalid-artifact-path: staging artifact path points to a directory".to_string(),
        );
    }
    if metadata.file_type().is_symlink() {
        return Err("invalid-artifact-path: staging artifact path points to a symlink".to_string());
    }
    let canonical_root = std::fs::canonicalize(&staging_root).map_err(|err| {
        format!(
            "staging-root-canonicalize-failed: failed to canonicalize '{}': {err}",
            staging_root.display()
        )
    })?;
    let canonical_target = std::fs::canonicalize(&target).map_err(|err| {
        format!(
            "staging-artifact-canonicalize-failed: failed to canonicalize '{}': {err}",
            target.display()
        )
    })?;
    if !canonical_target.starts_with(&canonical_root) {
        return Err(
            "invalid-artifact-path: staging artifact escapes the runtime staging directory"
                .to_string(),
        );
    }
    match std::fs::remove_file(&canonical_target) {
        Ok(()) => Ok(()),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(err) => Err(format!(
            "staging-artifact-delete-failed: failed to delete '{}': {err}",
            canonical_target.display()
        )),
    }
}

fn read_staging_artifact_file(project_root: &Path, artifact_path: &str) -> Result<String, String> {
    let artifact_path = normalize_staging_artifact_path(artifact_path)?;
    let staging_root = staging_dir_path(project_root);
    let target = staging_root.join(artifact_path);
    let metadata = std::fs::symlink_metadata(&target).map_err(|err| {
        format!(
            "staging-artifact-stat-failed: failed to inspect '{}': {err}",
            target.display()
        )
    })?;
    if metadata.is_dir() {
        return Err(
            "invalid-artifact-path: staging artifact path points to a directory".to_string(),
        );
    }
    if metadata.file_type().is_symlink() {
        return Err("invalid-artifact-path: staging artifact path points to a symlink".to_string());
    }
    let canonical_root = std::fs::canonicalize(&staging_root).map_err(|err| {
        format!(
            "staging-root-canonicalize-failed: failed to canonicalize '{}': {err}",
            staging_root.display()
        )
    })?;
    let canonical_target = std::fs::canonicalize(&target).map_err(|err| {
        format!(
            "staging-artifact-canonicalize-failed: failed to canonicalize '{}': {err}",
            target.display()
        )
    })?;
    if !canonical_target.starts_with(&canonical_root) {
        return Err(
            "invalid-artifact-path: staging artifact escapes the runtime staging directory"
                .to_string(),
        );
    }
    let markdown = std::fs::read_to_string(&canonical_target).map_err(|err| {
        format!(
            "staging-artifact-read-failed: failed to read '{}': {err}",
            canonical_target.display()
        )
    })?;
    normalize_staging_markdown_body(&markdown)
}

fn ensure_staging_artifact_path_scoped_to_job(
    job_id: &str,
    artifact_path: &str,
) -> Result<(), String> {
    let scope = artifact_path.split('/').next().unwrap_or_default();
    if scope == job_id {
        Ok(())
    } else {
        Err("invalid-artifact-path: artifactPath must start with jobId".to_string())
    }
}

fn ensure_staging_artifact_path_available_tx(
    tx: &Transaction<'_>,
    artifact_id: &str,
    artifact_path: &str,
) -> Result<(), String> {
    let existing = tx
        .query_row(
            "SELECT COUNT(*)
             FROM runtime_staging_artifacts
             WHERE artifact_path = ?1
               AND artifact_id <> ?2
               AND status NOT IN ('committed', 'deleted')",
            params![artifact_path, artifact_id],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|err| format!("staging-artifact-path-check-failed: {err}"))?;
    if existing == 0 {
        Ok(())
    } else {
        Err("artifact-path-conflict: staging artifact path is already in use".to_string())
    }
}

pub(crate) fn ensure_path_budget(
    tx: &Transaction<'_>,
    affected_path: &NormalizedAffectedPath,
    now: i64,
) -> Result<(), String> {
    tx.execute(
        "INSERT OR IGNORE INTO runtime_resource_budgets (
            scope,
            resource_key,
            display_key,
            capacity,
            created_at_ms,
            updated_at_ms
        ) VALUES (?1, ?2, ?3, 1, ?4, ?4)",
        params![
            COMMIT_PATH_SCOPE,
            affected_path.resource_key,
            affected_path.display_key,
            now
        ],
    )
    .map_err(|err| format!("commit-path-budget-create-failed: {err}"))?;
    Ok(())
}

fn read_staging_artifact_tx(
    tx: &Transaction<'_>,
    artifact_id: &str,
) -> Result<RuntimeStagingArtifactRecord, String> {
    tx.query_row(
        &staging_artifact_select_sql("WHERE artifact_id = ?1"),
        [artifact_id],
        map_staging_artifact_row,
    )
        .map_err(|err| format!("staging-artifact-read-failed: {err}"))
}

fn read_staging_artifact_tx_unchecked(
    connection: &Connection,
    artifact_id: &str,
) -> Result<RuntimeStagingArtifactRecord, String> {
    connection
        .query_row(
            &staging_artifact_select_sql("WHERE artifact_id = ?1"),
            [artifact_id],
            map_staging_artifact_row,
        )
        .map_err(|err| format!("staging-artifact-read-failed: {err}"))
}

fn read_staging_artifact_optional_tx(
    tx: &Transaction<'_>,
    artifact_id: &str,
) -> Result<Option<RuntimeStagingArtifactRecord>, String> {
    tx.query_row(
        &staging_artifact_select_sql("WHERE artifact_id = ?1"),
        [artifact_id],
        map_staging_artifact_row,
    )
    .optional()
        .map_err(|err| format!("staging-artifact-read-failed: {err}"))
}

fn read_pending_staging_artifacts_for_job_tx(
    tx: &Transaction<'_>,
    job_id: &str,
) -> Result<Vec<RuntimeStagingArtifactRecord>, String> {
    let mut statement = tx
        .prepare(&staging_artifact_select_sql(
            "WHERE job_id = ?1 AND status = 'pending'
             ORDER BY created_at_ms, artifact_id",
        ))
        .map_err(|err| format!("staging-artifacts-pending-query-prepare-failed: {err}"))?;
    let artifacts = statement
        .query_map([job_id], map_staging_artifact_row)
        .map_err(|err| format!("staging-artifacts-pending-query-failed: {err}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| format!("staging-artifacts-pending-row-failed: {err}"))?;
    Ok(artifacts)
}

fn read_expired_staging_artifacts_tx(
    tx: &Transaction<'_>,
    now: i64,
) -> Result<Vec<RuntimeStagingArtifactRecord>, String> {
    let mut statement = tx
        .prepare(&staging_artifact_select_sql(
            "WHERE status IN ('failed', 'cancelled')
               AND expires_at_ms IS NOT NULL
               AND expires_at_ms <= ?1
             ORDER BY expires_at_ms ASC, artifact_id ASC",
        ))
        .map_err(|err| format!("staging-artifacts-gc-prepare-failed: {err}"))?;
    let rows = statement
        .query_map([now], map_staging_artifact_row)
        .map_err(|err| format!("staging-artifacts-gc-read-failed: {err}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|err| format!("staging-artifacts-gc-read-failed: {err}"))
}

fn read_staging_artifacts(
    connection: &Connection,
    job_id: Option<&str>,
    status: Option<&str>,
    limit: i64,
    include_commit_metadata: bool,
) -> Result<Vec<RuntimeStagingArtifactRecord>, String> {
    match (job_id, status) {
        (Some(job_id), Some(status)) => {
            let mut statement = connection
                .prepare(&staging_artifact_select_sql_with_metadata(
                    "WHERE job_id = ?1 AND status = ?2
                     ORDER BY updated_at_ms ASC, artifact_id ASC LIMIT ?3",
                    include_commit_metadata,
                ))
                .map_err(|err| format!("staging-artifacts-read-prepare-failed: {err}"))?;
            let rows = statement
                .query_map(params![job_id, status, limit], map_staging_artifact_row)
                .map_err(|err| format!("staging-artifacts-read-failed: {err}"))?;
            rows.collect::<Result<Vec<_>, _>>()
                .map_err(|err| format!("staging-artifacts-read-failed: {err}"))
        }
        (Some(job_id), None) => {
            let mut statement = connection
                .prepare(&staging_artifact_select_sql_with_metadata(
                    "WHERE job_id = ?1 ORDER BY updated_at_ms ASC, artifact_id ASC LIMIT ?2",
                    include_commit_metadata,
                ))
                .map_err(|err| format!("staging-artifacts-read-prepare-failed: {err}"))?;
            let rows = statement
                .query_map(params![job_id, limit], map_staging_artifact_row)
                .map_err(|err| format!("staging-artifacts-read-failed: {err}"))?;
            rows.collect::<Result<Vec<_>, _>>()
                .map_err(|err| format!("staging-artifacts-read-failed: {err}"))
        }
        (None, Some(status)) => {
            let mut statement = connection
                .prepare(&staging_artifact_select_sql_with_metadata(
                    "WHERE status = ?1 ORDER BY updated_at_ms ASC, artifact_id ASC LIMIT ?2",
                    include_commit_metadata,
                ))
                .map_err(|err| format!("staging-artifacts-read-prepare-failed: {err}"))?;
            let rows = statement
                .query_map(params![status, limit], map_staging_artifact_row)
                .map_err(|err| format!("staging-artifacts-read-failed: {err}"))?;
            rows.collect::<Result<Vec<_>, _>>()
                .map_err(|err| format!("staging-artifacts-read-failed: {err}"))
        }
        (None, None) => {
            let mut statement = connection
                .prepare(&staging_artifact_select_sql_with_metadata(
                    "ORDER BY updated_at_ms ASC, artifact_id ASC LIMIT ?1",
                    include_commit_metadata,
                ))
                .map_err(|err| format!("staging-artifacts-read-prepare-failed: {err}"))?;
            let rows = statement
                .query_map([limit], map_staging_artifact_row)
                .map_err(|err| format!("staging-artifacts-read-failed: {err}"))?;
            rows.collect::<Result<Vec<_>, _>>()
                .map_err(|err| format!("staging-artifacts-read-failed: {err}"))
        }
    }
}

fn staging_artifact_select_sql(suffix: &str) -> String {
    staging_artifact_select_sql_with_metadata(suffix, true)
}

fn staging_artifact_select_sql_with_metadata(suffix: &str, include_commit_metadata: bool) -> String {
    let target_path = if include_commit_metadata {
        "target_path"
    } else {
        "NULL AS target_path"
    };
    let operation_intent = if include_commit_metadata {
        "operation_intent"
    } else {
        "NULL AS operation_intent"
    };
    let base_hash = if include_commit_metadata {
        "base_hash"
    } else {
        "NULL AS base_hash"
    };
    let source_kind = if include_commit_metadata {
        "source_kind"
    } else {
        "NULL AS source_kind"
    };
    format!(
        "SELECT artifact_id,
                job_id,
                artifact_path,
                artifact_hash,
                {target_path},
                {operation_intent},
                {base_hash},
                {source_kind},
                status,
                created_at_ms,
                updated_at_ms,
                expires_at_ms,
                deleted_at_ms,
                last_error
         FROM runtime_staging_artifacts {suffix}"
    )
}

fn map_staging_artifact_row(
    row: &rusqlite::Row<'_>,
) -> rusqlite::Result<RuntimeStagingArtifactRecord> {
    Ok(RuntimeStagingArtifactRecord {
        artifact_id: row.get(0)?,
        job_id: row.get(1)?,
        artifact_path: row.get(2)?,
        artifact_hash: row.get(3)?,
        target_path: row.get(4)?,
        operation_intent: row.get(5)?,
        base_hash: row.get(6)?,
        source_kind: row.get(7)?,
        status: row.get(8)?,
        created_at_ms: row.get(9)?,
        updated_at_ms: row.get(10)?,
        expires_at_ms: row.get(11)?,
        deleted_at_ms: row.get(12)?,
        last_error: row.get(13)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    
    use std::path::{Path, PathBuf};
    use rusqlite::{params, Connection};
    
    use std::fs;
    
    
    
    
    
    
    
    


    fn staging_record_request(
        artifact_id: Option<&str>,
        job_id: &str,
        artifact_path: &str,
        status: Option<&str>,
    ) -> RuntimeStagingArtifactRecordRequest {
        RuntimeStagingArtifactRecordRequest {
            artifact_id: artifact_id.map(str::to_string),
            job_id: job_id.to_string(),
            artifact_path: artifact_path.to_string(),
            artifact_hash: "sha256:abc123".to_string(),
            status: status.map(str::to_string),
            ttl_ms: None,
            last_error: None,
        }
    }

    fn staging_store_request(
        artifact_id: &str,
        job_id: &str,
        artifact_path: &str,
        target_path: &str,
        operation_intent: &str,
        base_hash: Option<&str>,
        markdown: &str,
    ) -> RuntimeStagingArtifactStoreRequest {
        RuntimeStagingArtifactStoreRequest {
            artifact_id: artifact_id.to_string(),
            job_id: job_id.to_string(),
            artifact_path: artifact_path.to_string(),
            target_path: target_path.to_string(),
            operation_intent: operation_intent.to_string(),
            base_hash: base_hash.map(str::to_string),
            source_kind: "ingest".to_string(),
            markdown: markdown.to_string(),
        }
    }

    fn staging_commit_request(artifact_id: &str) -> RuntimeStagingArtifactCommitSuccessRequest {
        RuntimeStagingArtifactCommitSuccessRequest {
            artifact_id: artifact_id.to_string(),
        }
    }

    fn staging_list_request(
        job_id: Option<&str>,
        status: Option<&str>,
    ) -> RuntimeStagingArtifactListRequest {
        RuntimeStagingArtifactListRequest {
            job_id: job_id.map(str::to_string),
            status: status.map(str::to_string),
            limit: None,
        }
    }

    fn staging_clear_pending_request(
        job_id: &str,
    ) -> RuntimeStagingArtifactsClearPendingForJobRequest {
        RuntimeStagingArtifactsClearPendingForJobRequest {
            job_id: job_id.to_string(),
        }
    }

    fn write_staging_file(project_root: &Path, relative_path: &str, contents: &[u8]) -> PathBuf {
        let path = staging_dir_path(project_root).join(relative_path);
        fs::create_dir_all(path.parent().expect("staging file has parent"))
            .expect("create staging parent");
        fs::write(&path, contents).expect("write staging file");
        path
    }

    #[test]
    fn staging_artifact_request_shapes_reject_unknown_fields() {
        let record =
            serde_json::from_value::<RuntimeStagingArtifactRecordRequest>(serde_json::json!({
                "artifactId": "artifact-1",
                "jobId": "job-1",
                "artifactPath": "wiki/a.md",
                "artifactHash": "sha256:abc",
                "root": "/tmp/project"
            }))
            .expect_err("record request rejects root");
        assert!(record.to_string().contains("unknown field"));

        let commit = serde_json::from_value::<RuntimeStagingArtifactCommitSuccessRequest>(
            serde_json::json!({
                "artifactId": "artifact-1",
                "delete": true
            }),
        )
        .expect_err("commit request rejects delete");
        assert!(commit.to_string().contains("unknown field"));

        let store =
            serde_json::from_value::<RuntimeStagingArtifactStoreRequest>(serde_json::json!({
                "artifactId": "artifact-1",
                "jobId": "job-1",
                "artifactPath": "wiki/a.md",
                "targetPath": "wiki/a.md",
                "operationIntent": "create",
                "baseHash": null,
                "sourceKind": "ingest",
                "markdown": "# A",
                "rawSecret": "nope"
            }))
            .expect_err("store request rejects rawSecret");
        assert!(store.to_string().contains("unknown field"));

        let clear = serde_json::from_value::<RuntimeStagingArtifactsClearPendingForJobRequest>(
            serde_json::json!({
                "jobId": "job-1",
                "deleteCommitted": true
            }),
        )
        .expect_err("clear request rejects deleteCommitted");
        assert!(clear.to_string().contains("unknown field"));

        let list = serde_json::from_value::<RuntimeStagingArtifactListRequest>(serde_json::json!({
            "jobId": "job-1",
            "status": "pending",
            "limit": 10,
            "dbPath": "/tmp/runtime.db"
        }))
        .expect_err("list request rejects dbPath");
        assert!(list.to_string().contains("unknown field"));
    }

    #[test]
    fn disabled_staging_artifact_commands_do_not_touch_damaged_runtime_db() {
        let project = temp_project("disabled-staging-artifacts");
        let runtime_dir = project.join(RUNTIME_DIR);
        fs::create_dir_all(&runtime_dir).expect("create runtime dir");
        let db_path = runtime_dir.join(RUNTIME_DB_FILE);
        fs::write(&db_path, b"not sqlite").expect("write damaged db");

        let record_error = runtime_staging_artifact_record_for_project(
            Some(&project),
            false,
            staging_record_request(Some("artifact-1"), "job-1", "wiki/a.md", None),
            100,
        )
        .expect_err("disabled record should fail");
        assert!(record_error.starts_with("runtime-disabled"));

        let commit_error = runtime_staging_artifact_commit_success_for_project(
            Some(&project),
            false,
            staging_commit_request("artifact-1"),
            200,
        )
        .expect_err("disabled commit cleanup should fail");
        assert!(commit_error.starts_with("runtime-disabled"));

        let gc_error = runtime_staging_artifact_gc_for_project(Some(&project), false, 300)
            .expect_err("disabled GC should fail");
        assert!(gc_error.starts_with("runtime-disabled"));

        let list = runtime_staging_artifact_list_for_project(
            Some(&project),
            false,
            staging_list_request(None, None),
        )
        .expect("disabled list succeeds");
        assert_eq!(list.status, RuntimeDbHealthState::Disabled);
        assert!(list.artifacts.is_empty());
        assert_eq!(fs::read(&db_path).expect("read damaged db"), b"not sqlite");
        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn enabled_staging_artifact_commands_without_project_are_no_touch() {
        let record_error = runtime_staging_artifact_record_for_project(
            None,
            true,
            staging_record_request(Some("artifact-1"), "job-1", "wiki/a.md", None),
            100,
        )
        .expect_err("no-project record should fail");
        assert!(record_error.starts_with("no-project"));

        let commit_error = runtime_staging_artifact_commit_success_for_project(
            None,
            true,
            staging_commit_request("artifact-1"),
            200,
        )
        .expect_err("no-project commit cleanup should fail");
        assert!(commit_error.starts_with("no-project"));

        let gc_error = runtime_staging_artifact_gc_for_project(None, true, 300)
            .expect_err("no-project GC should fail");
        assert!(gc_error.starts_with("no-project"));

        let list =
            runtime_staging_artifact_list_for_project(None, true, staging_list_request(None, None))
                .expect("no-project list succeeds");
        assert_eq!(list.status, RuntimeDbHealthState::NoProject);
        assert!(list.artifacts.is_empty());
    }

    #[test]
    fn staging_artifact_list_returns_empty_without_migration_on_existing_runtime_dbs() {
        let project = temp_project("staging-list-pr5-db");
        fs::create_dir_all(&project).expect("create temp project");
        runtime_job_create_for_project(Some(&project), true, create_request("job-1"), 100)
            .expect("create parent job");
        runtime_event_append_for_project(
            Some(&project),
            true,
            event_request(Some("job-1"), "event-1", "{}"),
            200,
        )
        .expect("create PR5 runtime db");

        let list = runtime_staging_artifact_list_for_project(
            Some(&project),
            true,
            staging_list_request(None, None),
        )
        .expect("list staging artifacts");

        assert_eq!(list.status, RuntimeDbHealthState::Healthy);
        assert!(list.artifacts.is_empty());
        let connection = Connection::open(runtime_db_path(&project)).expect("open runtime db");
        assert!(!table_exists(&connection, "runtime_staging_artifacts").expect("check table"));
        assert!(!migration_family_exists(&project, STAGING_ARTIFACTS_FAMILY));
        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn staging_artifact_list_reads_v1_rows_without_migration() {
        let project = temp_project("staging-list-v1-table");
        fs::create_dir_all(&project).expect("create temp project");
        runtime_job_create_for_project(Some(&project), true, create_request("job-1"), 100)
            .expect("create parent job");
        let connection = Connection::open(runtime_db_path(&project)).expect("open runtime db");
        connection
            .execute(
                "CREATE TABLE runtime_staging_artifacts (
                    artifact_id TEXT PRIMARY KEY CHECK(length(artifact_id) > 0),
                    job_id TEXT NOT NULL CHECK(length(job_id) > 0),
                    artifact_path TEXT NOT NULL CHECK(length(CAST(artifact_path AS BLOB)) > 0),
                    artifact_hash TEXT NOT NULL CHECK(length(CAST(artifact_hash AS BLOB)) > 0),
                    status TEXT NOT NULL CHECK (
                        status IN ('pending', 'committed', 'failed', 'cancelled', 'deleted')
                    ),
                    created_at_ms INTEGER NOT NULL CHECK(created_at_ms >= 0),
                    updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= 0),
                    expires_at_ms INTEGER CHECK(expires_at_ms IS NULL OR expires_at_ms >= 0),
                    deleted_at_ms INTEGER CHECK(deleted_at_ms IS NULL OR deleted_at_ms >= 0),
                    last_error TEXT,
                    FOREIGN KEY(job_id) REFERENCES runtime_jobs(job_id)
                )",
                [],
            )
            .expect("create v1 staging table");
        connection
            .execute(
                "INSERT INTO runtime_staging_artifacts (
                    artifact_id,
                    job_id,
                    artifact_path,
                    artifact_hash,
                    status,
                    created_at_ms,
                    updated_at_ms
                ) VALUES ('artifact-1', 'job-1', 'job-1/page.md', 'sha256:abc', 'pending', 1, 2)",
                [],
            )
            .expect("insert v1 staging row");
        drop(connection);

        let list = runtime_staging_artifact_list_for_project(
            Some(&project),
            true,
            staging_list_request(Some("job-1"), Some(PENDING_ARTIFACT_STATUS)),
        )
        .expect("list v1 staging rows");

        assert_eq!(list.artifacts.len(), 1);
        assert_eq!(list.artifacts[0].artifact_path, "job-1/page.md");
        assert_eq!(list.artifacts[0].target_path, None);
        assert_eq!(list.artifacts[0].operation_intent, None);
        assert_eq!(list.artifacts[0].base_hash, None);
        assert_eq!(list.artifacts[0].source_kind, None);
        let connection = Connection::open(runtime_db_path(&project)).expect("open runtime db");
        assert!(
            !column_exists(&connection, "runtime_staging_artifacts", "target_path")
                .expect("check target column")
        );
        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn staging_artifacts_migration_preserves_higher_version_and_is_idempotent() {
        let project = temp_project("staging-artifacts-higher-version");
        fs::create_dir_all(&project).expect("create temp project");
        runtime_db_health_for_project(Some(&project), true).expect("create PR2 runtime db");
        let connection = Connection::open(runtime_db_path(&project)).expect("open runtime db");
        connection
            .execute(
                "INSERT INTO runtime_schema_migrations (
                    family,
                    version,
                    applied_at_ms
                ) VALUES (?1, ?2, ?3)",
                params![STAGING_ARTIFACTS_FAMILY, 2_i64, 42_i64],
            )
            .expect("seed higher migration");
        drop(connection);

        runtime_job_create_for_project(Some(&project), true, create_request("job-1"), 100)
            .expect("create parent job");
        runtime_staging_artifact_record_for_project(
            Some(&project),
            true,
            staging_record_request(Some("artifact-1"), "job-1", "wiki/a.md", None),
            200,
        )
        .expect("record staging artifact");
        let first = read_migration_family(&project, STAGING_ARTIFACTS_FAMILY);

        runtime_staging_artifact_record_for_project(
            Some(&project),
            true,
            staging_record_request(Some("artifact-1"), "job-1", "wiki/a.md", None),
            300,
        )
        .expect("record staging artifact again");
        let second = read_migration_family(&project, STAGING_ARTIFACTS_FAMILY);

        assert_eq!(
            first,
            RuntimeDbMigrationStatus {
                family: STAGING_ARTIFACTS_FAMILY.to_string(),
                version: 2,
                applied_at_ms: 42,
            }
        );
        assert_eq!(first, second);
        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn staging_artifact_schema_enables_foreign_keys_and_rejects_orphan_artifact() {
        let project = temp_project("staging-artifacts-fk");
        fs::create_dir_all(&project).expect("create temp project");

        with_runtime_writer(|| {
            let connection = open_staging_artifacts_runtime_locked(&project)?;
            let foreign_keys = connection
                .query_row("PRAGMA foreign_keys", [], |row| row.get::<_, i64>(0))
                .expect("read foreign key pragma");
            assert_eq!(foreign_keys, 1);
            let error = connection
                .execute(
                    "INSERT INTO runtime_staging_artifacts (
                        artifact_id,
                        job_id,
                        artifact_path,
                        artifact_hash,
                        status,
                        created_at_ms,
                        updated_at_ms
                    ) VALUES ('artifact-orphan', 'missing-job', 'wiki/a.md', 'sha256:abc', 'pending', 1, 1)",
                    [],
                )
                .expect_err("orphan artifact must fail");
            assert!(error.to_string().contains("FOREIGN KEY"));
            Ok(())
        })
        .expect("schema init succeeds");

        let migration = read_migration_family(&project, STAGING_ARTIFACTS_FAMILY);
        with_runtime_writer(|| {
            open_staging_artifacts_runtime_locked(&project)?;
            Ok(())
        })
        .expect("schema init is idempotent");
        assert_eq!(
            migration,
            read_migration_family(&project, STAGING_ARTIFACTS_FAMILY)
        );
        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn normalize_staging_artifact_path_rejects_unsafe_inputs_without_md_requirement() {
        assert_eq!(
            normalize_staging_artifact_path(" Artifacts/Page.tmp ").expect("normalize artifact"),
            "Artifacts/Page.tmp"
        );
        assert_eq!(
            normalize_staging_artifact_path("wiki/a.bin").expect("non-md is allowed"),
            "wiki/a.bin"
        );

        for raw in [
            "",
            "/a.md",
            "\\a.md",
            "C:\\a.md",
            "a//b.md",
            "./a.md",
            "a/../b.md",
            "wiki/",
            "\\\\?\\C:\\a.md",
            "\\\\server\\share\\a.md",
        ] {
            assert!(
                normalize_staging_artifact_path(raw).is_err(),
                "{raw:?} should be rejected"
            );
        }

        let too_long = "a".repeat(MAX_STAGING_ARTIFACT_PATH_BYTES + 1);
        assert!(normalize_staging_artifact_path(&too_long).is_err());
    }

    #[test]
    fn staging_artifact_record_commit_cleanup_and_list_happy_path() {
        let project = temp_project("staging-commit-cleanup");
        fs::create_dir_all(&project).expect("create temp project");
        runtime_job_create_for_project(Some(&project), true, create_request("job-1"), 100)
            .expect("create parent job");
        let artifact_file = write_staging_file(&project, "wiki/a.md", b"draft");

        let recorded = runtime_staging_artifact_record_for_project(
            Some(&project),
            true,
            staging_record_request(Some("artifact-1"), "job-1", "wiki/a.md", None),
            200,
        )
        .expect("record staging artifact");

        assert_eq!(recorded.status, PENDING_ARTIFACT_STATUS);
        assert_eq!(recorded.artifact_path, "wiki/a.md");
        assert!(artifact_file.exists());

        let committed = runtime_staging_artifact_commit_success_for_project(
            Some(&project),
            true,
            staging_commit_request("artifact-1"),
            300,
        )
        .expect("commit cleanup");
        assert_eq!(committed.status, COMMITTED_ARTIFACT_STATUS);
        assert_eq!(committed.deleted_at_ms, Some(300));
        assert!(!artifact_file.exists());

        let repeated = runtime_staging_artifact_commit_success_for_project(
            Some(&project),
            true,
            staging_commit_request("artifact-1"),
            400,
        )
        .expect("repeated commit cleanup is idempotent");
        assert_eq!(repeated.status, COMMITTED_ARTIFACT_STATUS);
        assert_eq!(repeated.deleted_at_ms, Some(300));

        let list = runtime_staging_artifact_list_for_project(
            Some(&project),
            true,
            staging_list_request(Some("job-1"), Some(COMMITTED_ARTIFACT_STATUS)),
        )
        .expect("list committed artifacts");
        assert_eq!(list.artifacts, vec![committed]);
        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn staging_artifact_store_writes_body_metadata_hash_and_cleanup() {
        let project = temp_project("staging-store-happy");
        fs::create_dir_all(&project).expect("create temp project");
        runtime_job_create_for_project(Some(&project), true, create_request("job-1"), 100)
            .expect("create parent job");
        let markdown = "# Title\r\nBody\rEnd\n";

        let stored = runtime_staging_artifact_store_for_project(
            Some(&project),
            true,
            staging_store_request(
                "artifact-1",
                "job-1",
                "job-1/page.md",
                "Wiki/Page.md",
                "update",
                Some("sha256:base"),
                markdown,
            ),
            200,
        )
        .expect("store staging artifact");

        assert_eq!(stored.artifact_hash, hash_staging_markdown(markdown));
        assert_eq!(
            hash_staging_markdown("line1\r\nline2\rline3\n"),
            hash_staging_markdown("line1\nline2\nline3\n")
        );
        assert_eq!(stored.target_path.as_deref(), Some("Wiki/Page.md"));
        assert_eq!(stored.operation_intent.as_deref(), Some("update"));
        assert_eq!(stored.base_hash.as_deref(), Some("sha256:base"));
        assert_eq!(stored.source_kind.as_deref(), Some("ingest"));
        assert_eq!(
            fs::read_to_string(staging_dir_path(&project).join("job-1/page.md"))
                .expect("read stored body"),
            markdown
        );

        let listed = runtime_staging_artifact_list_for_project(
            Some(&project),
            true,
            staging_list_request(Some("job-1"), Some(PENDING_ARTIFACT_STATUS)),
        )
        .expect("list stored artifact");
        assert_eq!(listed.artifacts, vec![stored.clone()]);

        let committed = runtime_staging_artifact_commit_success_for_project(
            Some(&project),
            true,
            staging_commit_request("artifact-1"),
            300,
        )
        .expect("commit cleanup");
        assert_eq!(committed.status, COMMITTED_ARTIFACT_STATUS);
        assert_eq!(committed.target_path.as_deref(), Some("Wiki/Page.md"));
        assert!(!staging_dir_path(&project).join("job-1/page.md").exists());
        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn staging_artifact_read_body_returns_pending_body() {
        let project = temp_project("staging-read-body-happy");
        fs::create_dir_all(&project).expect("create temp project");
        runtime_job_create_for_project(Some(&project), true, create_request("job-1"), 100)
            .expect("create parent job");

        runtime_staging_artifact_store_for_project(
            Some(&project),
            true,
            staging_store_request(
                "artifact-1",
                "job-1",
                "job-1/page.md",
                "Wiki/Page.md",
                "create",
                None,
                "# Page\n",
            ),
            200,
        )
        .expect("store staging artifact");

        let body = runtime_staging_artifact_read_body_for_project(
            Some(&project),
            true,
            RuntimeStagingArtifactReadBodyRequest {
                artifact_id: "artifact-1".to_string(),
            },
        )
        .expect("read body");

        assert_eq!(body.artifact_id, "artifact-1");
        assert_eq!(body.artifact_path, "job-1/page.md");
        assert_eq!(body.markdown, "# Page\n");
        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn staging_artifact_read_body_requires_pending_status() {
        let project = temp_project("staging-read-body-pending-only");
        fs::create_dir_all(&project).expect("create temp project");
        runtime_job_create_for_project(Some(&project), true, create_request("job-1"), 100)
            .expect("create parent job");
        runtime_staging_artifact_store_for_project(
            Some(&project),
            true,
            staging_store_request(
                "artifact-1",
                "job-1",
                "job-1/page.md",
                "Wiki/Page.md",
                "create",
                None,
                "# Page\n",
            ),
            200,
        )
        .expect("store staging artifact");
        runtime_staging_artifact_commit_success_for_project(
            Some(&project),
            true,
            staging_commit_request("artifact-1"),
            300,
        )
        .expect("mark committed");

        let error = runtime_staging_artifact_read_body_for_project(
            Some(&project),
            true,
            RuntimeStagingArtifactReadBodyRequest {
                artifact_id: "artifact-1".to_string(),
            },
        )
        .expect_err("committed body read is rejected");

        assert!(error.starts_with("invalid-state"));
        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn staging_artifact_read_body_rejects_unscoped_record_paths() {
        let project = temp_project("staging-read-body-unscoped");
        fs::create_dir_all(&project).expect("create temp project");
        runtime_job_create_for_project(Some(&project), true, create_request("job-1"), 100)
            .expect("create parent job");
        write_staging_file(&project, "wiki/page.md", b"# Page\n");
        runtime_staging_artifact_record_for_project(
            Some(&project),
            true,
            staging_record_request(Some("artifact-1"), "job-1", "wiki/page.md", None),
            200,
        )
        .expect("record unscoped artifact");

        let error = runtime_staging_artifact_read_body_for_project(
            Some(&project),
            true,
            RuntimeStagingArtifactReadBodyRequest {
                artifact_id: "artifact-1".to_string(),
            },
        )
        .expect_err("unscoped body read is rejected");

        assert!(error.contains("artifactPath must start with jobId"));
        let _ = fs::remove_dir_all(project);
    }

    #[cfg(unix)]
    #[test]
    fn staging_artifact_read_body_rejects_symlink_target() {
        let project = temp_project("staging-read-body-symlink");
        fs::create_dir_all(&project).expect("create temp project");
        runtime_job_create_for_project(Some(&project), true, create_request("job-1"), 100)
            .expect("create parent job");
        let outside = temp_project("staging-read-outside-file");
        fs::write(&outside, b"outside").expect("write outside file");
        let link = staging_dir_path(&project).join("job-1/link.md");
        fs::create_dir_all(link.parent().expect("link has parent")).expect("create link parent");
        std::os::unix::fs::symlink(&outside, &link).expect("create symlink");
        runtime_staging_artifact_record_for_project(
            Some(&project),
            true,
            staging_record_request(Some("artifact-1"), "job-1", "job-1/link.md", None),
            200,
        )
        .expect("record symlink artifact");

        let error = runtime_staging_artifact_read_body_for_project(
            Some(&project),
            true,
            RuntimeStagingArtifactReadBodyRequest {
                artifact_id: "artifact-1".to_string(),
            },
        )
        .expect_err("symlink body read is rejected");

        assert!(error.starts_with("invalid-artifact-path"));
        assert!(outside.exists());
        let _ = fs::remove_file(outside);
        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn staging_artifact_store_rejects_invalid_body_and_base_hash() {
        let project = temp_project("staging-store-validation");
        fs::create_dir_all(&project).expect("create temp project");
        runtime_job_create_for_project(Some(&project), true, create_request("job-1"), 100)
            .expect("create parent job");

        let mut create_with_base = staging_store_request(
            "artifact-1",
            "job-1",
            "job-1/page.md",
            "Wiki/Page.md",
            "create",
            Some("sha256:base"),
            "# Page\n",
        );
        let base_error = runtime_staging_artifact_store_for_project(
            Some(&project),
            true,
            create_with_base.clone(),
            200,
        )
        .expect_err("create with base hash is rejected");
        assert!(base_error.starts_with("invalid-base-hash"));

        create_with_base.base_hash = None;
        create_with_base.markdown = "x".repeat(MAX_STAGING_ARTIFACT_BODY_BYTES + 1);
        let body_error = runtime_staging_artifact_store_for_project(
            Some(&project),
            true,
            create_with_base,
            200,
        )
        .expect_err("oversized body is rejected");
        assert!(body_error.starts_with("invalid-markdown"));
        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn staging_artifact_store_cleans_file_when_metadata_write_fails() {
        let project = temp_project("staging-store-db-failure-cleanup");
        fs::create_dir_all(&project).expect("create temp project");

        let error = runtime_staging_artifact_store_for_project(
            Some(&project),
            true,
            staging_store_request(
                "artifact-1",
                "missing-job",
                "missing-job/page.md",
                "Wiki/Page.md",
                "create",
                None,
                "# Page\n",
            ),
            200,
        )
        .expect_err("missing job is rejected");

        assert!(error.starts_with("job-not-found"));
        assert!(!staging_dir_path(&project)
            .join("missing-job/page.md")
            .exists());
        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn staging_artifact_store_cleans_file_after_post_write_insert_failure() {
        let project = temp_project("staging-store-post-write-failure");
        fs::create_dir_all(&project).expect("create temp project");
        runtime_job_create_for_project(Some(&project), true, create_request("job-1"), 100)
            .expect("create parent job");
        let connection = Connection::open(runtime_db_path(&project)).expect("open runtime db");
        connection
            .execute(
                "CREATE TABLE runtime_staging_artifacts (
                    artifact_id TEXT PRIMARY KEY CHECK(length(artifact_id) > 0),
                    job_id TEXT NOT NULL CHECK(length(job_id) > 0),
                    artifact_path TEXT NOT NULL CHECK(length(CAST(artifact_path AS BLOB)) > 0),
                    artifact_hash TEXT NOT NULL CHECK(length(CAST(artifact_hash AS BLOB)) > 0),
                    target_path TEXT,
                    operation_intent TEXT,
                    base_hash TEXT,
                    source_kind TEXT CHECK(source_kind = 'blocked'),
                    status TEXT NOT NULL CHECK (
                        status IN ('pending', 'committed', 'failed', 'cancelled', 'deleted')
                    ),
                    created_at_ms INTEGER NOT NULL CHECK(created_at_ms >= 0),
                    updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= 0),
                    expires_at_ms INTEGER CHECK(expires_at_ms IS NULL OR expires_at_ms >= 0),
                    deleted_at_ms INTEGER CHECK(deleted_at_ms IS NULL OR deleted_at_ms >= 0),
                    last_error TEXT,
                    FOREIGN KEY(job_id) REFERENCES runtime_jobs(job_id)
                )",
                [],
            )
            .expect("create constrained staging table");
        drop(connection);

        let error = runtime_staging_artifact_store_for_project(
            Some(&project),
            true,
            staging_store_request(
                "artifact-1",
                "job-1",
                "job-1/page.md",
                "Wiki/Page.md",
                "create",
                None,
                "# Page\n",
            ),
            200,
        )
        .expect_err("insert check failure is reported");

        assert!(error.starts_with("staging-artifact-store-insert-failed"));
        assert!(!staging_dir_path(&project).join("job-1/page.md").exists());
        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn staging_artifact_store_rejects_unscoped_and_conflicting_paths() {
        let project = temp_project("staging-store-path-scope");
        fs::create_dir_all(&project).expect("create temp project");
        runtime_job_create_for_project(Some(&project), true, create_request("job-1"), 100)
            .expect("create first job");
        runtime_job_create_for_project(Some(&project), true, create_request("job-2"), 110)
            .expect("create second job");

        runtime_staging_artifact_store_for_project(
            Some(&project),
            true,
            staging_store_request(
                "artifact-1",
                "job-1",
                "job-1/page.md",
                "Wiki/Page.md",
                "create",
                None,
                "# Page\n",
            ),
            200,
        )
        .expect("store first artifact");

        let unscoped = runtime_staging_artifact_store_for_project(
            Some(&project),
            true,
            staging_store_request(
                "artifact-2",
                "job-2",
                "job-1/page.md",
                "Wiki/Other.md",
                "create",
                None,
                "# Other\n",
            ),
            210,
        )
        .expect_err("artifact path must be scoped to job");
        assert!(unscoped.starts_with("invalid-artifact-path"));
        assert_eq!(
            fs::read_to_string(staging_dir_path(&project).join("job-1/page.md"))
                .expect("first artifact still exists"),
            "# Page\n"
        );

        let conflict = runtime_staging_artifact_store_for_project(
            Some(&project),
            true,
            staging_store_request(
                "artifact-3",
                "job-1",
                "job-1/page.md",
                "Wiki/Third.md",
                "create",
                None,
                "# Third\n",
            ),
            220,
        )
        .expect_err("same active path must be rejected");
        assert!(conflict.starts_with("artifact-path-conflict"));
        assert_eq!(
            fs::read_to_string(staging_dir_path(&project).join("job-1/page.md"))
                .expect("first artifact remains unchanged"),
            "# Page\n"
        );
        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn staging_artifacts_clear_pending_for_job_removes_files_and_rows() {
        let project = temp_project("staging-clear-pending");
        fs::create_dir_all(&project).expect("create temp project");
        runtime_job_create_for_project(Some(&project), true, create_request("job-1"), 100)
            .expect("create parent job");

        for artifact_id in ["artifact-1", "artifact-2"] {
            runtime_staging_artifact_store_for_project(
                Some(&project),
                true,
                staging_store_request(
                    artifact_id,
                    "job-1",
                    &format!("job-1/{artifact_id}.md"),
                    &format!("Wiki/{artifact_id}.md"),
                    "create",
                    None,
                    "# Page\n",
                ),
                200,
            )
            .expect("store pending artifact");
        }

        let cleared = runtime_staging_artifacts_clear_pending_for_job_for_project(
            Some(&project),
            true,
            staging_clear_pending_request("job-1"),
            300,
        )
        .expect("clear pending artifacts");

        assert_eq!(cleared.cleared.len(), 2);
        assert!(!staging_dir_path(&project).join("job-1/artifact-1.md").exists());
        let list = runtime_staging_artifact_list_for_project(
            Some(&project),
            true,
            staging_list_request(Some("job-1"), Some(PENDING_ARTIFACT_STATUS)),
        )
        .expect("list pending");
        assert!(list.artifacts.is_empty());

        let repeated = runtime_staging_artifacts_clear_pending_for_job_for_project(
            Some(&project),
            true,
            staging_clear_pending_request("job-1"),
            400,
        )
        .expect("repeated clear is idempotent");
        assert!(repeated.cleared.is_empty());
        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn staging_artifacts_clear_pending_tolerates_missing_files() {
        let project = temp_project("staging-clear-missing-file");
        fs::create_dir_all(&project).expect("create temp project");
        runtime_job_create_for_project(Some(&project), true, create_request("job-1"), 100)
            .expect("create parent job");
        runtime_staging_artifact_store_for_project(
            Some(&project),
            true,
            staging_store_request(
                "artifact-1",
                "job-1",
                "job-1/page.md",
                "Wiki/Page.md",
                "create",
                None,
                "# Page\n",
            ),
            200,
        )
        .expect("store pending artifact");
        fs::remove_file(staging_dir_path(&project).join("job-1/page.md"))
            .expect("remove file before cleanup");

        let cleared = runtime_staging_artifacts_clear_pending_for_job_for_project(
            Some(&project),
            true,
            staging_clear_pending_request("job-1"),
            300,
        )
        .expect("clear missing file");
        assert_eq!(cleared.cleared.len(), 1);
        let list = runtime_staging_artifact_list_for_project(
            Some(&project),
            true,
            staging_list_request(Some("job-1"), Some(PENDING_ARTIFACT_STATUS)),
        )
        .expect("list pending");
        assert!(list.artifacts.is_empty());
        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn staging_artifact_store_migrates_existing_runtime_db_columns() {
        let project = temp_project("staging-store-migration");
        fs::create_dir_all(&project).expect("create temp project");
        runtime_job_create_for_project(Some(&project), true, create_request("job-1"), 100)
            .expect("create parent job");
        let connection = Connection::open(runtime_db_path(&project)).expect("open runtime db");
        connection
            .execute(
                "CREATE TABLE IF NOT EXISTS runtime_staging_artifacts (
                    artifact_id TEXT PRIMARY KEY CHECK(length(artifact_id) > 0),
                    job_id TEXT NOT NULL CHECK(length(job_id) > 0),
                    artifact_path TEXT NOT NULL CHECK(length(CAST(artifact_path AS BLOB)) > 0),
                    artifact_hash TEXT NOT NULL CHECK(length(CAST(artifact_hash AS BLOB)) > 0),
                    status TEXT NOT NULL CHECK (
                        status IN ('pending', 'committed', 'failed', 'cancelled', 'deleted')
                    ),
                    created_at_ms INTEGER NOT NULL CHECK(created_at_ms >= 0),
                    updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= 0),
                    expires_at_ms INTEGER CHECK(expires_at_ms IS NULL OR expires_at_ms >= 0),
                    deleted_at_ms INTEGER CHECK(deleted_at_ms IS NULL OR deleted_at_ms >= 0),
                    last_error TEXT,
                    FOREIGN KEY(job_id) REFERENCES runtime_jobs(job_id)
                )",
                [],
            )
            .expect("seed old staging table");
        drop(connection);

        let stored = runtime_staging_artifact_store_for_project(
            Some(&project),
            true,
            staging_store_request(
                "artifact-1",
                "job-1",
                "job-1/page.md",
                "Wiki/Page.md",
                "create",
                None,
                "# Page\n",
            ),
            200,
        )
        .expect("store after migration");

        assert_eq!(stored.target_path.as_deref(), Some("Wiki/Page.md"));
        let connection = Connection::open(runtime_db_path(&project)).expect("open runtime db");
        assert!(column_exists(&connection, "runtime_staging_artifacts", "target_path")
            .expect("check target column"));
        assert!(column_exists(&connection, "runtime_staging_artifacts", "operation_intent")
            .expect("check intent column"));
        let _ = fs::remove_dir_all(project);
    }

    #[cfg(unix)]
    #[test]
    fn staging_artifact_store_rejects_parent_symlink_escape() {
        let project = temp_project("staging-store-parent-symlink");
        fs::create_dir_all(&project).expect("create temp project");
        runtime_job_create_for_project(Some(&project), true, create_request("job-1"), 100)
            .expect("create parent job");
        let outside_dir = temp_project("staging-store-outside-dir");
        fs::create_dir_all(&outside_dir).expect("create outside dir");
        fs::create_dir_all(staging_dir_path(&project)).expect("create staging dir");
        std::os::unix::fs::symlink(&outside_dir, staging_dir_path(&project).join("job-1"))
            .expect("create parent symlink");

        let error = runtime_staging_artifact_store_for_project(
            Some(&project),
            true,
            staging_store_request(
                "artifact-1",
                "job-1",
                "job-1/nested/page.md",
                "Wiki/Page.md",
                "create",
                None,
                "# Page\n",
            ),
            200,
        )
        .expect_err("parent symlink is rejected");

        assert!(error.starts_with("invalid-artifact-path"));
        assert!(!outside_dir.join("nested").exists());
        assert!(!outside_dir.join("page.md").exists());
        let _ = fs::remove_dir_all(outside_dir);
        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn failed_and_cancelled_staging_artifacts_are_gc_after_ttl() {
        let project = temp_project("staging-gc-ttl");
        fs::create_dir_all(&project).expect("create temp project");
        runtime_job_create_for_project(Some(&project), true, create_request("job-1"), 100)
            .expect("create parent job");
        let failed_file = write_staging_file(&project, "wiki/failed.md", b"failed");
        let cancelled_file = write_staging_file(&project, "wiki/cancelled.md", b"cancelled");

        for (artifact_id, path, status) in [
            ("artifact-failed", "wiki/failed.md", FAILED_ARTIFACT_STATUS),
            (
                "artifact-cancelled",
                "wiki/cancelled.md",
                CANCELLED_ARTIFACT_STATUS,
            ),
        ] {
            runtime_staging_artifact_record_for_project(
                Some(&project),
                true,
                staging_record_request(Some(artifact_id), "job-1", path, None),
                200,
            )
            .expect("record pending artifact");
            runtime_staging_artifact_record_for_project(
                Some(&project),
                true,
                staging_record_request(Some(artifact_id), "job-1", path, Some(status)),
                300,
            )
            .expect("mark terminal with TTL");
        }

        let early = runtime_staging_artifact_gc_for_project(
            Some(&project),
            true,
            300 + DEFAULT_FAILED_ARTIFACT_TTL_MS - 1,
        )
        .expect("early GC succeeds");
        assert!(early.deleted.is_empty());
        assert!(failed_file.exists());
        assert!(cancelled_file.exists());

        let deleted = runtime_staging_artifact_gc_for_project(
            Some(&project),
            true,
            300 + DEFAULT_FAILED_ARTIFACT_TTL_MS,
        )
        .expect("expired GC succeeds");
        assert_eq!(deleted.deleted.len(), 2);
        assert!(deleted
            .deleted
            .iter()
            .all(|artifact| artifact.status == DELETED_ARTIFACT_STATUS));
        assert!(!failed_file.exists());
        assert!(!cancelled_file.exists());

        let repeated = runtime_staging_artifact_gc_for_project(
            Some(&project),
            true,
            300 + DEFAULT_FAILED_ARTIFACT_TTL_MS + 1,
        )
        .expect("repeated GC succeeds");
        assert!(repeated.deleted.is_empty());
        let _ = fs::remove_dir_all(project);
    }

    #[cfg(unix)]
    #[test]
    fn staging_artifact_cleanup_rejects_symlink_escape() {
        let project = temp_project("staging-symlink-escape");
        fs::create_dir_all(&project).expect("create temp project");
        runtime_job_create_for_project(Some(&project), true, create_request("job-1"), 100)
            .expect("create parent job");
        let outside = temp_project("staging-outside-file");
        fs::write(&outside, b"outside").expect("write outside file");
        let link = staging_dir_path(&project).join("wiki/link.md");
        fs::create_dir_all(link.parent().expect("link has parent")).expect("create link parent");
        std::os::unix::fs::symlink(&outside, &link).expect("create symlink");

        runtime_staging_artifact_record_for_project(
            Some(&project),
            true,
            staging_record_request(Some("artifact-1"), "job-1", "wiki/link.md", None),
            200,
        )
        .expect("record symlink artifact");
        let error = runtime_staging_artifact_commit_success_for_project(
            Some(&project),
            true,
            staging_commit_request("artifact-1"),
            300,
        )
        .expect_err("symlink escape is rejected");

        assert!(error.starts_with("invalid-artifact-path"));
        assert!(outside.exists());
        assert!(link.exists());
        let _ = fs::remove_file(outside);
        let _ = fs::remove_dir_all(project);
    }

    #[cfg(unix)]
    #[test]
    fn staging_artifact_cleanup_rejects_parent_symlink_replacement() {
        let project = temp_project("staging-parent-symlink");
        fs::create_dir_all(&project).expect("create temp project");
        runtime_job_create_for_project(Some(&project), true, create_request("job-1"), 100)
            .expect("create parent job");
        let original = write_staging_file(&project, "wiki/a.md", b"inside");

        runtime_staging_artifact_record_for_project(
            Some(&project),
            true,
            staging_record_request(Some("artifact-1"), "job-1", "wiki/a.md", None),
            200,
        )
        .expect("record artifact");

        let outside_dir = temp_project("staging-outside-dir");
        fs::create_dir_all(&outside_dir).expect("create outside dir");
        let outside_file = outside_dir.join("a.md");
        fs::write(&outside_file, b"outside").expect("write outside file");
        fs::remove_file(&original).expect("remove original file");
        fs::remove_dir(staging_dir_path(&project).join("wiki")).expect("remove original parent");
        std::os::unix::fs::symlink(&outside_dir, staging_dir_path(&project).join("wiki"))
            .expect("replace parent with symlink");

        let error = runtime_staging_artifact_commit_success_for_project(
            Some(&project),
            true,
            staging_commit_request("artifact-1"),
            300,
        )
        .expect_err("parent symlink escape is rejected");

        assert!(error.starts_with("invalid-artifact-path"));
        assert!(outside_file.exists());
        let _ = fs::remove_dir_all(outside_dir);
        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn staging_artifact_validation_rejects_invalid_state_ttl_and_metadata() {
        let project = temp_project("staging-validation");
        fs::create_dir_all(&project).expect("create temp project");
        runtime_job_create_for_project(Some(&project), true, create_request("job-1"), 100)
            .expect("create parent job");

        let missing_job = runtime_staging_artifact_record_for_project(
            Some(&project),
            true,
            staging_record_request(Some("artifact-missing"), "missing-job", "wiki/a.md", None),
            200,
        )
        .expect_err("missing job is rejected");
        assert!(missing_job.starts_with("job-not-found"));

        let mut committed_request =
            staging_record_request(Some("artifact-committed"), "job-1", "wiki/a.md", None);
        committed_request.status = Some(COMMITTED_ARTIFACT_STATUS.to_string());
        let committed_error = runtime_staging_artifact_record_for_project(
            Some(&project),
            true,
            committed_request,
            200,
        )
        .expect_err("record cannot write committed status");
        assert!(committed_error.starts_with("invalid-status"));

        let mut failed_insert =
            staging_record_request(Some("artifact-failed-insert"), "job-1", "wiki/a.md", None);
        failed_insert.status = Some(FAILED_ARTIFACT_STATUS.to_string());
        let failed_insert_error =
            runtime_staging_artifact_record_for_project(Some(&project), true, failed_insert, 200)
                .expect_err("new artifact cannot start failed");
        assert!(failed_insert_error.starts_with("invalid-state"));

        for (artifact_id, ttl_ms) in [
            ("artifact-ttl-low", Some(0)),
            ("artifact-ttl-high", Some(MAX_FAILED_ARTIFACT_TTL_MS + 1)),
        ] {
            runtime_staging_artifact_record_for_project(
                Some(&project),
                true,
                staging_record_request(Some(artifact_id), "job-1", "wiki/a.md", None),
                200,
            )
            .expect("record pending artifact");
            let mut request =
                staging_record_request(Some(artifact_id), "job-1", "wiki/a.md", Some("failed"));
            request.ttl_ms = ttl_ms;
            let error =
                runtime_staging_artifact_record_for_project(Some(&project), true, request, 300)
                    .expect_err("invalid TTL is rejected");
            assert!(error.starts_with("invalid-ttl"));
        }

        let mut overflow =
            staging_record_request(Some("artifact-overflow"), "job-1", "wiki/a.md", None);
        overflow.ttl_ms = Some(MAX_FAILED_ARTIFACT_TTL_MS);
        runtime_staging_artifact_record_for_project(Some(&project), true, overflow, 200)
            .expect("record pending artifact");
        let mut overflow_fail = staging_record_request(
            Some("artifact-overflow"),
            "job-1",
            "wiki/a.md",
            Some("failed"),
        );
        overflow_fail.ttl_ms = Some(MAX_FAILED_ARTIFACT_TTL_MS);
        let overflow_error = runtime_staging_artifact_record_for_project(
            Some(&project),
            true,
            overflow_fail,
            i64::MAX,
        )
        .expect_err("TTL overflow rejected");
        assert!(overflow_error.starts_with("invalid-ttl"));

        let mut long_hash =
            staging_record_request(Some("artifact-long-hash"), "job-1", "wiki/a.md", None);
        long_hash.artifact_hash = "h".repeat(MAX_STAGING_ARTIFACT_HASH_BYTES + 1);
        let hash_error =
            runtime_staging_artifact_record_for_project(Some(&project), true, long_hash, 200)
                .expect_err("long hash rejected");
        assert!(hash_error.starts_with("invalid-artifact-hash"));

        let mut long_error =
            staging_record_request(Some("artifact-long-error"), "job-1", "wiki/a.md", None);
        long_error.last_error = Some("e".repeat(MAX_STAGING_ARTIFACT_ERROR_BYTES + 1));
        let error_error =
            runtime_staging_artifact_record_for_project(Some(&project), true, long_error, 200)
                .expect_err("long last error rejected");
        assert!(error_error.starts_with("invalid-last-error"));

        with_runtime_writer(|| {
            let connection = open_staging_artifacts_runtime_locked(&project)?;
            let too_long_path = "p".repeat(MAX_STAGING_ARTIFACT_PATH_BYTES + 1);
            let db_error = connection
                .execute(
                    "INSERT INTO runtime_staging_artifacts (
                        artifact_id,
                        job_id,
                        artifact_path,
                        artifact_hash,
                        status,
                        created_at_ms,
                        updated_at_ms
                    ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)",
                    params![
                        "artifact-db-check",
                        "job-1",
                        too_long_path,
                        "sha256:abc",
                        PENDING_ARTIFACT_STATUS,
                        400_i64
                    ],
                )
                .expect_err("DB CHECK rejects long path");
            assert!(db_error.to_string().contains("CHECK"));
            Ok(())
        })
        .expect("DB CHECK test succeeds");

        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn staging_artifact_terminal_statuses_do_not_resurrect() {
        let project = temp_project("staging-terminal-status");
        fs::create_dir_all(&project).expect("create temp project");
        runtime_job_create_for_project(Some(&project), true, create_request("job-1"), 100)
            .expect("create parent job");
        write_staging_file(&project, "wiki/committed.md", b"committed");
        runtime_staging_artifact_record_for_project(
            Some(&project),
            true,
            staging_record_request(
                Some("artifact-committed"),
                "job-1",
                "wiki/committed.md",
                None,
            ),
            200,
        )
        .expect("record committed artifact");
        runtime_staging_artifact_commit_success_for_project(
            Some(&project),
            true,
            staging_commit_request("artifact-committed"),
            300,
        )
        .expect("commit cleanup");
        let resurrect_committed = runtime_staging_artifact_record_for_project(
            Some(&project),
            true,
            staging_record_request(
                Some("artifact-committed"),
                "job-1",
                "wiki/committed.md",
                None,
            ),
            400,
        )
        .expect_err("committed artifact cannot resurrect");
        assert!(resurrect_committed.starts_with("invalid-state"));

        write_staging_file(&project, "wiki/failed.md", b"failed");
        runtime_staging_artifact_record_for_project(
            Some(&project),
            true,
            staging_record_request(Some("artifact-failed"), "job-1", "wiki/failed.md", None),
            500,
        )
        .expect("record failed artifact");
        runtime_staging_artifact_record_for_project(
            Some(&project),
            true,
            staging_record_request(
                Some("artifact-failed"),
                "job-1",
                "wiki/failed.md",
                Some(FAILED_ARTIFACT_STATUS),
            ),
            600,
        )
        .expect("mark failed");
        let commit_failed = runtime_staging_artifact_commit_success_for_project(
            Some(&project),
            true,
            staging_commit_request("artifact-failed"),
            700,
        )
        .expect_err("commit cleanup from failed is invalid");
        assert!(commit_failed.starts_with("invalid-state"));
        runtime_staging_artifact_gc_for_project(
            Some(&project),
            true,
            600 + DEFAULT_FAILED_ARTIFACT_TTL_MS,
        )
        .expect("GC failed artifact");
        let resurrect_deleted = runtime_staging_artifact_record_for_project(
            Some(&project),
            true,
            staging_record_request(Some("artifact-failed"), "job-1", "wiki/failed.md", None),
            800,
        )
        .expect_err("deleted artifact cannot resurrect");
        assert!(resurrect_deleted.starts_with("invalid-state"));

        let _ = fs::remove_dir_all(project);
    }
}
