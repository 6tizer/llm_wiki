#![cfg(test)]

use super::*;
use crate::commands::profile_secrets::SecretStore;
use rusqlite::{Connection, OptionalExtension};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

pub(crate) fn temp_project(label: &str) -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system clock before Unix epoch")
        .as_nanos();
    std::env::temp_dir().join(format!(
        "llm-wiki-runtime-db-{label}-{}-{nanos}",
        std::process::id()
    ))
}

pub(crate) fn read_migration(project_root: &Path) -> RuntimeDbMigrationStatus {
    read_migration_family(project_root, MIGRATIONS_FAMILY)
}

pub(crate) fn read_migration_family(project_root: &Path, family: &str) -> RuntimeDbMigrationStatus {
    let connection = Connection::open(runtime_db_path(project_root)).expect("open runtime db");
    connection
        .query_row(
            "SELECT family, version, applied_at_ms
                 FROM runtime_schema_migrations
                 WHERE family = ?1",
            [family],
            |row| {
                Ok(RuntimeDbMigrationStatus {
                    family: row.get(0)?,
                    version: row.get(1)?,
                    applied_at_ms: row.get(2)?,
                })
            },
        )
        .expect("read migration row")
}

#[derive(Default)]
pub(crate) struct TestSecretStore {
    values: Mutex<HashMap<String, String>>,
}

impl TestSecretStore {
    pub(crate) fn insert(&self, secret_ref: String, secret_value: &str) {
        self.values
            .lock()
            .expect("lock secret store")
            .insert(secret_ref, secret_value.to_string());
    }
}

impl SecretStore for TestSecretStore {
    fn write(&self, secret_ref: &str, secret_value: &str) -> Result<(), String> {
        self.insert(secret_ref.to_string(), secret_value);
        Ok(())
    }

    fn read(&self, secret_ref: &str) -> Result<String, String> {
        self.values
            .lock()
            .expect("lock secret store")
            .get(secret_ref)
            .cloned()
            .ok_or_else(|| "profile-secret-not-found: test secret missing".to_string())
    }

    fn delete(&self, secret_ref: &str) -> Result<(), String> {
        self.values
            .lock()
            .expect("lock secret store")
            .remove(secret_ref);
        Ok(())
    }
}

pub(crate) struct FailingReadSecretStore;

impl SecretStore for FailingReadSecretStore {
    fn write(&self, _secret_ref: &str, _secret_value: &str) -> Result<(), String> {
        Ok(())
    }

    fn read(&self, _secret_ref: &str) -> Result<String, String> {
        Err("profile-secret-read-failed: test keychain locked".to_string())
    }

    fn delete(&self, _secret_ref: &str) -> Result<(), String> {
        Ok(())
    }
}

pub(crate) fn create_request(job_id: &str) -> RuntimeJobCreateRequest {
    RuntimeJobCreateRequest {
        job_id: Some(job_id.to_string()),
        kind: "compile-page".to_string(),
        payload: "{}".to_string(),
        max_attempts: None,
        priority: None,
    }
}

pub(crate) fn create_request_with_max_attempts(
    job_id: &str,
    max_attempts: i64,
) -> RuntimeJobCreateRequest {
    RuntimeJobCreateRequest {
        max_attempts: Some(max_attempts),
        ..create_request(job_id)
    }
}

pub(crate) fn claim_request(holder: &str, lease_id: &str) -> RuntimeJobClaimRequest {
    RuntimeJobClaimRequest {
        holder: holder.to_string(),
        lease_id: Some(lease_id.to_string()),
        job_id: None,
    }
}

/// SPEC-6 PR3+4 P0-2a: claim a specific queued job by id instead of "next
/// queued job of any kind".
pub(crate) fn claim_request_with_job_id(
    holder: &str,
    lease_id: &str,
    job_id: &str,
) -> RuntimeJobClaimRequest {
    RuntimeJobClaimRequest {
        job_id: Some(job_id.to_string()),
        ..claim_request(holder, lease_id)
    }
}

pub(crate) fn claim_by_kind_request(
    holder: &str,
    lease_id: &str,
    kind: &str,
) -> RuntimeJobClaimByKindRequest {
    RuntimeJobClaimByKindRequest {
        holder: holder.to_string(),
        lease_id: Some(lease_id.to_string()),
        kind: kind.to_string(),
        payload_layer: None,
    }
}

/// SPEC-6 PR3+4 P0-2b: claim the next queued job of `kind` whose JSON
/// `payload.layer` field also matches `payload_layer`.
pub(crate) fn claim_by_kind_request_with_layer(
    holder: &str,
    lease_id: &str,
    kind: &str,
    payload_layer: &str,
) -> RuntimeJobClaimByKindRequest {
    RuntimeJobClaimByKindRequest {
        payload_layer: Some(payload_layer.to_string()),
        ..claim_by_kind_request(holder, lease_id, kind)
    }
}

pub(crate) fn lease_request(job_id: &str, lease_id: &str) -> RuntimeJobLeaseRequest {
    RuntimeJobLeaseRequest {
        job_id: job_id.to_string(),
        lease_id: lease_id.to_string(),
    }
}

pub(crate) fn commit_claim_request(path: &str, claim_id: &str) -> RuntimeCommitBudgetClaimRequest {
    RuntimeCommitBudgetClaimRequest {
        affected_path: path.to_string(),
        holder: "tester:worker-a".to_string(),
        job_id: None,
        claim_id: Some(claim_id.to_string()),
        ttl_ms: None,
    }
}

pub(crate) fn event_request(
    job_id: Option<&str>,
    event_id: &str,
    payload: &str,
) -> RuntimeEventAppendRequest {
    RuntimeEventAppendRequest {
        job_id: job_id.map(str::to_string),
        event_id: Some(event_id.to_string()),
        payload: payload.to_string(),
    }
}

pub(crate) fn timeline_request(job_id: Option<&str>) -> RuntimeTimelineListRequest {
    RuntimeTimelineListRequest {
        job_id: job_id.map(str::to_string),
        limit: None,
    }
}

pub(crate) fn progress_list_request(job_id: Option<&str>) -> RuntimeProgressListRequest {
    RuntimeProgressListRequest {
        job_id: job_id.map(str::to_string),
        limit: None,
    }
}

pub(crate) fn profile_secret_ref(id: &str) -> String {
    let uuid = match id {
        "profile-1" => "550e8400-e29b-41d4-a716-446655440000",
        "profile-clear" => "550e8400-e29b-41d4-a716-446655440001",
        "profile-json" => "550e8400-e29b-41d4-a716-446655440002",
        _ => "550e8400-e29b-41d4-a716-446655440099",
    };
    format!(
        "{}{}",
        crate::commands::profile_secrets::PROFILE_SECRET_REF_PREFIX,
        uuid
    )
}

pub(crate) fn profile_create_request(profile_id: &str) -> RuntimeProfileCreateRequest {
    RuntimeProfileCreateRequest {
        profile_id: Some(profile_id.to_string()),
        kind: "model-call".to_string(),
        display_name: "GPT-4.1".to_string(),
        provider_id: "openai".to_string(),
        model_id: "gpt-4.1".to_string(),
        agent_sdk_model_id: None,
        endpoint: None,
        api_mode: "openai-chat-completions".to_string(),
        auth_style: "bearer".to_string(),
        secret_ref: Some(profile_secret_ref(profile_id)),
        enabled: None,
        task_families: vec!["summarize".to_string(), "tag".to_string()],
        max_concurrency: Some(2),
    }
}

pub(crate) fn anthropic_profile_create_request(
    profile_id: &str,
    endpoint: &str,
) -> RuntimeProfileCreateRequest {
    RuntimeProfileCreateRequest {
        provider_id: "anthropic".to_string(),
        model_id: "claude-test".to_string(),
        endpoint: Some(endpoint.to_string()),
        api_mode: "anthropic-messages".to_string(),
        auth_style: "x-api-key".to_string(),
        ..profile_create_request(profile_id)
    }
}

pub(crate) fn profile_update_request(profile_id: &str) -> RuntimeProfileUpdateRequest {
    RuntimeProfileUpdateRequest {
        profile_id: profile_id.to_string(),
        display_name: None,
        provider_id: None,
        model_id: None,
        agent_sdk_model_id: None,
        clear_agent_sdk_model_id: None,
        endpoint: None,
        clear_endpoint: None,
        api_mode: None,
        auth_style: None,
        secret_ref: None,
        clear_secret_ref: None,
        enabled: None,
        task_families: None,
        max_concurrency: None,
        capability_status: None,
        capability_json: None,
        capability_version: None,
        capability_checked_at_ms: None,
        probe_backoff_until_ms: None,
        last_capability_error: None,
        clear_last_capability_error: None,
    }
}

pub(crate) fn profile_pool_capability_json(
    model_call: serde_json::Value,
    agent_run: serde_json::Value,
) -> String {
    serde_json::json!({
        "modelCallSupported": model_call,
        "agentRunSupported": agent_run
    })
    .to_string()
}

pub(crate) fn create_profile_pool_profile(
    project: &Path,
    profile_id: &str,
    kind: &str,
    enabled: bool,
    max_concurrency: i64,
    capability_json: String,
) {
    let mut create = profile_create_request(profile_id);
    create.kind = kind.to_string();
    create.enabled = Some(enabled);
    create.max_concurrency = Some(max_concurrency);
    runtime_profile_create_for_project(Some(project), true, create, 100)
        .expect("create pool profile");
    let mut update = profile_update_request(profile_id);
    update.capability_status = Some("supported".to_string());
    update.capability_json = Some(capability_json);
    update.capability_version = Some(PROFILE_PROBE_CAPABILITY_VERSION.to_string());
    update.capability_checked_at_ms = Some(150);
    runtime_profile_update_for_project(Some(project), true, update, 150)
        .expect("mark pool profile capable");
}

pub(crate) fn profile_pool_claim_request(
    claim_id: &str,
    preferred_profile_ids: Vec<&str>,
) -> RuntimeProfilePoolClaimRequest {
    RuntimeProfilePoolClaimRequest {
        claim_id: Some(claim_id.to_string()),
        kind: "model-call".to_string(),
        task_family: "summarize".to_string(),
        holder: "tester:worker-a".to_string(),
        job_id: None,
        ttl_ms: Some(10_000),
        preferred_profile_ids: Some(
            preferred_profile_ids
                .into_iter()
                .map(str::to_string)
                .collect(),
        ),
    }
}

pub(crate) fn agent_profile_pool_claim_request(
    claim_id: &str,
    preferred_profile_ids: Vec<&str>,
) -> RuntimeProfilePoolClaimRequest {
    RuntimeProfilePoolClaimRequest {
        claim_id: Some(claim_id.to_string()),
        kind: "agent-run".to_string(),
        task_family: "agent".to_string(),
        holder: "agent:stream-1".to_string(),
        job_id: None,
        ttl_ms: Some(MAX_PROFILE_POOL_TTL_MS),
        preferred_profile_ids: Some(
            preferred_profile_ids
                .into_iter()
                .map(str::to_string)
                .collect(),
        ),
    }
}

pub(crate) fn create_agent_profile_pool_profile(
    project: &Path,
    profile_id: &str,
) -> RuntimeProfileRecord {
    let mut create = anthropic_profile_create_request(profile_id, "https://agent.example/v1");
    create.kind = "agent-run".to_string();
    create.task_families = vec!["agent".to_string()];
    create.max_concurrency = Some(1);
    let created = runtime_profile_create_for_project(Some(project), true, create, 100)
        .expect("create agent profile");
    let mut update = profile_update_request(profile_id);
    update.capability_status = Some("supported".to_string());
    update.capability_json = Some(profile_pool_capability_json(
        serde_json::json!(true),
        serde_json::json!(true),
    ));
    update.capability_version = Some(PROFILE_PROBE_CAPABILITY_VERSION.to_string());
    update.capability_checked_at_ms = Some(150);
    runtime_profile_update_for_project(Some(project), true, update, 150)
        .expect("mark agent profile capable");
    created
}

pub(crate) fn migration_family_exists(project_root: &Path, family: &str) -> bool {
    let connection = Connection::open(runtime_db_path(project_root)).expect("open runtime db");
    connection
        .query_row(
            "SELECT 1
                 FROM runtime_schema_migrations
                 WHERE family = ?1
                 LIMIT 1",
            [family],
            |_| Ok(()),
        )
        .optional()
        .expect("query migration family")
        .is_some()
}
