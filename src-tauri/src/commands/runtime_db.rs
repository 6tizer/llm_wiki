use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
use std::time::{SystemTime, UNIX_EPOCH};

use reqwest::header::{HeaderMap, HeaderValue, AUTHORIZATION, CONTENT_TYPE};
use reqwest::Client;
use rusqlite::{
    params, params_from_iter, Connection, OpenFlags, OptionalExtension, ToSql, Transaction,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::State;
use unicode_normalization::UnicodeNormalization;
use uuid::Uuid;

use crate::commands::file_sync::ProjectRootState;
use crate::commands::profile_secrets::{
    read_profile_secret, validate_profile_secret_ref, OsSecretStore, SecretStore,
    PROFILE_SECRET_REF_BYTES, PROFILE_SECRET_REF_SQL_GLOB,
};
use crate::panic_guard::run_guarded;

const RUNTIME_DIR: &str = ".llm-wiki/runtime";
const RUNTIME_DB_FILE: &str = "runtime.db";
const STAGING_DIR: &str = "staging";
const MIGRATIONS_FAMILY: &str = "migrations";
const MIGRATIONS_VERSION: i64 = 1;
const JOBS_FAMILY: &str = "jobs";
const JOBS_VERSION: i64 = 1;
const LEASES_FAMILY: &str = "leases";
const LEASES_VERSION: i64 = 1;
const RESOURCE_BUDGETS_FAMILY: &str = "resource-budgets";
const RESOURCE_BUDGETS_VERSION: i64 = 1;
const EVENTS_PROGRESS_FAMILY: &str = "events-progress";
const EVENTS_PROGRESS_VERSION: i64 = 1;
const STAGING_ARTIFACTS_FAMILY: &str = "staging-artifacts";
const STAGING_ARTIFACTS_VERSION: i64 = 2;
const DERIVED_STALE_MARKERS_FAMILY: &str = "derived-stale-markers";
const DERIVED_STALE_MARKERS_VERSION: i64 = 1;
const PROFILE_STATUS_FAMILY: &str = "profile-status";
const PROFILE_STATUS_VERSION: i64 = 1;
const PROFILE_POOL_FAMILY: &str = "profile-pool";
const PROFILE_POOL_VERSION: i64 = 1;
const WORK_RUNTIME_ENABLED_ENV: &str = "LLM_WIKI_CORE_WORK_RUNTIME_ENABLED";
const DEFAULT_MAX_ATTEMPTS: i64 = 3;
const DEFAULT_PRIORITY: i64 = 0;
const DEFAULT_LEASE_TTL_MS: i64 = 120_000;
const DEFAULT_RETRY_BACKOFF_MS: i64 = 30_000;
const DEFAULT_HEARTBEAT_MIN_INTERVAL_MS: i64 = 5_000;
const DEFAULT_PROGRESS_MIN_INTERVAL_MS: i64 = 2_000;
const MAX_EVENT_PAYLOAD_BYTES: usize = 16_384;
const DEFAULT_TIMELINE_LIMIT: i64 = 100;
const MAX_TIMELINE_LIMIT: i64 = 500;
const DEFAULT_PROGRESS_LIMIT: i64 = 100;
const MAX_PROGRESS_LIMIT: i64 = 500;
const DEFAULT_STAGING_ARTIFACT_LIMIT: i64 = 100;
const MAX_STAGING_ARTIFACT_LIMIT: i64 = 500;
const DEFAULT_DERIVED_MARKER_LIMIT: i64 = 100;
const MAX_DERIVED_MARKER_LIMIT: i64 = 500;
const DEFAULT_COMMIT_TOTAL_CAPACITY: i64 = 2;
const COMMIT_BUDGET_AMOUNT: i64 = 1;
const MIN_COMMIT_BUDGET_TTL_MS: i64 = 1_000;
const MAX_COMMIT_BUDGET_TTL_MS: i64 = 1_200_000;
const DEFAULT_FAILED_ARTIFACT_TTL_MS: i64 = 604_800_000;
const MAX_FAILED_ARTIFACT_TTL_MS: i64 = 2_592_000_000;
const MAX_STAGING_ARTIFACT_PATH_BYTES: usize = 1024;
const MAX_STAGING_ARTIFACT_HASH_BYTES: usize = 128;
const MAX_STAGING_ARTIFACT_ERROR_BYTES: usize = 4096;
const MAX_STAGING_ARTIFACT_BODY_BYTES: usize = 2_000_000;
const MAX_STAGING_ARTIFACT_SOURCE_KIND_BYTES: usize = 128;
const MAX_DERIVED_MARKER_BASE_VERSION_BYTES: usize = 256;
const MAX_PROFILE_ID_BYTES: usize = 128;
const MAX_PROFILE_DISPLAY_NAME_BYTES: usize = 256;
const MAX_PROFILE_PROVIDER_BYTES: usize = 128;
const MAX_PROFILE_MODEL_BYTES: usize = 256;
const MAX_PROFILE_SDK_MODEL_BYTES: usize = 256;
const MAX_PROFILE_ENDPOINT_BYTES: usize = 2048;
const MAX_PROFILE_TASK_FAMILIES_BYTES: usize = 4096;
const MAX_PROFILE_TASK_FAMILY_BYTES: usize = 128;
const MAX_PROFILE_CAPABILITY_JSON_BYTES: usize = 8192;
const MAX_PROFILE_CAPABILITY_VERSION_BYTES: usize = 64;
const MAX_PROFILE_CAPABILITY_ERROR_BYTES: usize = 4096;
const MAX_PROFILE_POOL_REASON_BYTES: usize = 1024;
// Keep these version strings aligned with src/components/settings/sections/model-profiles-section.tsx.
const DEFAULT_PROFILE_CAPABILITY_VERSION: &str = "spec-4-pr1";
const PROFILE_PROBE_CAPABILITY_VERSION: &str = "profile-probe.v1";
const DEFAULT_PROFILE_CAPABILITY_JSON: &str = "{}";
const DEFAULT_PROFILE_STATUS: &str = "unknown";
const PROFILE_PROBE_BACKOFF_MS: i64 = DEFAULT_RETRY_BACKOFF_MS;
const PROFILE_PROBE_MAX_TOKENS: i64 = 8;
const PROFILE_PROBE_TIMEOUT_SECS: u64 = 30;
const MAX_PROFILE_CONCURRENCY: i64 = 128;
const MIN_PROFILE_POOL_TTL_MS: i64 = 1_000;
// Keep this aligned with AGENT_PROFILE_CLAIM_TTL_MS in src/lib/agent/agent-transport.ts.
const MAX_PROFILE_POOL_TTL_MS: i64 = 1_200_000;
const MAX_PROFILE_POOL_BREAKER_MS: i64 = 3_600_000;
const ACTIVE_LEASE_STATUS: &str = "active";
const RELEASED_LEASE_STATUS: &str = "released";
const EXPIRED_LEASE_STATUS: &str = "expired";
const CANCELLED_LEASE_STATUS: &str = "cancelled";
const COMMIT_TOTAL_SCOPE: &str = "commit-total";
const COMMIT_PATH_SCOPE: &str = "commit-path";
const COMMIT_TOTAL_RESOURCE_KEY: &str = "*";
const ACTIVE_CLAIM_STATUS: &str = "active";
const RELEASED_CLAIM_STATUS: &str = "released";
const EXPIRED_CLAIM_STATUS: &str = "expired";
const EVENT_APPENDED_NAME: &str = "job-runtime:event-appended";
const PROGRESS_APPENDED_NAME: &str = "job-runtime:progress-appended";
const PROFILE_POOL_CLAIMED_NAME: &str = "profile-pool:claimed";
const PROFILE_POOL_RELEASED_NAME: &str = "profile-pool:released";
pub(crate) const PROFILE_CLAIM_INACTIVE_PREFIX: &str = "claim-inactive:";
const PROFILE_CLAIM_INACTIVE_ERROR: &str = "claim-inactive: profile pool claim is not active";
// Rust uses this after agent_spawn has accepted claim ownership.
const AGENT_PROFILE_RELEASE_REASON: &str = "agent-run-cleanup";
const AGENT_PROFILE_SDK_MODEL_REJECTED_REASON: &str = "agent-sdk-model-rejected";
const AGENT_PROFILE_GATEWAY_AUTH_FAILED_REASON: &str = "gateway-auth-failed";
const PENDING_ARTIFACT_STATUS: &str = "pending";
const COMMITTED_ARTIFACT_STATUS: &str = "committed";
const FAILED_ARTIFACT_STATUS: &str = "failed";
const CANCELLED_ARTIFACT_STATUS: &str = "cancelled";
const DELETED_ARTIFACT_STATUS: &str = "deleted";
const PENDING_MARKER_STATUS: &str = "pending";

static RUNTIME_DB_WRITE_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

/// Runtime DB health state returned by the shell-neutral health command.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum RuntimeDbHealthState {
    Disabled,
    NoProject,
    Healthy,
}

/// Applied migration bookkeeping entry for a runtime schema family.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeDbMigrationStatus {
    family: String,
    version: i64,
    applied_at_ms: i64,
}

/// Runtime DB health payload returned to Tauri callers.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeDbHealth {
    enabled: bool,
    status: RuntimeDbHealthState,
    project_path: Option<String>,
    runtime_dir: Option<String>,
    db_path: Option<String>,
    journal_mode: Option<String>,
    migrations: Vec<RuntimeDbMigrationStatus>,
}

/// Request payload for creating a queued runtime job.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeJobCreateRequest {
    job_id: Option<String>,
    kind: String,
    payload: String,
    max_attempts: Option<i64>,
    priority: Option<i64>,
}

/// Request payload for claiming the next queued runtime job.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeJobClaimRequest {
    holder: String,
    lease_id: Option<String>,
}

/// Request payload for claiming the next queued runtime job of one kind.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeJobClaimByKindRequest {
    holder: String,
    lease_id: Option<String>,
    kind: String,
}

/// Request payload for active-lease job operations.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeJobLeaseRequest {
    job_id: String,
    lease_id: String,
}

/// Request payload for failing a running runtime job.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeJobFailRequest {
    job_id: String,
    lease_id: String,
    error: Option<String>,
    retry_after_ms: Option<i64>,
}

/// Request payload for retrying a failed or retry-ready runtime job.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeJobRetryRequest {
    job_id: String,
}

/// Request payload for cancelling a non-terminal runtime job.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeJobCancelRequest {
    job_id: String,
}

/// Request payload for pausing a queued or running runtime job.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeJobPauseRequest {
    job_id: String,
}

/// Request payload for resuming a paused runtime job.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeJobResumeRequest {
    job_id: String,
}

/// Snapshot of one runtime job row.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeJobRecord {
    job_id: String,
    kind: String,
    payload: String,
    state: String,
    attempt: i64,
    max_attempts: i64,
    priority: i64,
    created_at_ms: i64,
    updated_at_ms: i64,
    queued_at_ms: Option<i64>,
    started_at_ms: Option<i64>,
    completed_at_ms: Option<i64>,
    failed_at_ms: Option<i64>,
    cancelled_at_ms: Option<i64>,
    retry_after_ms: Option<i64>,
    last_error: Option<String>,
}

/// Snapshot of one runtime job lease row.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeJobLeaseRecord {
    lease_id: String,
    job_id: String,
    holder: String,
    acquired_at_ms: i64,
    heartbeat_at_ms: i64,
    expires_at_ms: i64,
    released_at_ms: Option<i64>,
    status: String,
}

/// Response payload for a successful job claim.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeJobClaim {
    job: RuntimeJobRecord,
    lease: RuntimeJobLeaseRecord,
}

/// Snapshot response for runtime jobs and leases.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeJobList {
    enabled: bool,
    status: RuntimeDbHealthState,
    jobs: Vec<RuntimeJobRecord>,
    leases: Vec<RuntimeJobLeaseRecord>,
}

/// Request payload for claiming commit-path budget capacity.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeCommitBudgetClaimRequest {
    affected_path: String,
    holder: String,
    job_id: Option<String>,
    claim_id: Option<String>,
    ttl_ms: Option<i64>,
}

/// Request payload for releasing commit-path budget capacity.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeCommitBudgetReleaseRequest {
    claim_id: String,
}

/// Snapshot of one resource budget row.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeResourceBudgetRecord {
    scope: String,
    resource_key: String,
    display_key: String,
    capacity: i64,
    created_at_ms: i64,
    updated_at_ms: i64,
}

/// Snapshot of one resource budget claim row.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeResourceBudgetClaimRecord {
    claim_id: String,
    scope: String,
    resource_key: String,
    display_key: String,
    job_id: Option<String>,
    holder: String,
    amount: i64,
    acquired_at_ms: i64,
    expires_at_ms: i64,
    released_at_ms: Option<i64>,
    status: String,
}

/// Response payload for a successful commit budget claim.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeCommitBudgetClaim {
    claim_id: String,
    resource_key: String,
    display_key: String,
    expires_at_ms: i64,
    claims: Vec<RuntimeResourceBudgetClaimRecord>,
}

/// Snapshot response for commit budget rows and active claims.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeCommitBudgetList {
    enabled: bool,
    status: RuntimeDbHealthState,
    budgets: Vec<RuntimeResourceBudgetRecord>,
    claims: Vec<RuntimeResourceBudgetClaimRecord>,
}

/// Request payload for appending a durable runtime event.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeEventAppendRequest {
    job_id: Option<String>,
    event_id: Option<String>,
    payload: String,
}

/// Request payload for appending or coalescing a runtime progress fact.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeProgressAppendRequest {
    job_id: Option<String>,
    progress_key: String,
    event_id: Option<String>,
    payload: String,
    durable: Option<bool>,
}

/// Request payload for listing runtime events.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeTimelineListRequest {
    job_id: Option<String>,
    limit: Option<i64>,
}

/// Request payload for listing runtime progress facts.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeProgressListRequest {
    job_id: Option<String>,
    limit: Option<i64>,
}

/// Snapshot of one append-only runtime event row.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeEventRecord {
    event_id: String,
    job_id: String,
    event_name: String,
    payload: String,
    created_at_ms: i64,
}

/// Snapshot of one coalesced runtime progress fact.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeProgressRecord {
    job_id: String,
    progress_key: String,
    payload: String,
    updated_at_ms: i64,
    last_event_id: Option<String>,
}

/// Response payload for a progress append.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeProgressAppend {
    progress: RuntimeProgressRecord,
    event: Option<RuntimeEventRecord>,
}

/// Snapshot response for the runtime event timeline.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeTimelineList {
    enabled: bool,
    status: RuntimeDbHealthState,
    events: Vec<RuntimeEventRecord>,
}

/// Snapshot response for current runtime progress facts.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeProgressList {
    enabled: bool,
    status: RuntimeDbHealthState,
    progress: Vec<RuntimeProgressRecord>,
}

/// Request payload for recording or advancing staging artifact metadata.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeStagingArtifactRecordRequest {
    artifact_id: Option<String>,
    job_id: String,
    artifact_path: String,
    artifact_hash: String,
    status: Option<String>,
    ttl_ms: Option<i64>,
    last_error: Option<String>,
}

/// Request payload for writing a validated staging artifact body and metadata.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeStagingArtifactStoreRequest {
    artifact_id: String,
    job_id: String,
    artifact_path: String,
    target_path: String,
    operation_intent: String,
    base_hash: Option<String>,
    source_kind: String,
    markdown: String,
}

/// Request payload for marking a committed artifact and cleaning its staging file.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeStagingArtifactCommitSuccessRequest {
    artifact_id: String,
}

/// Request payload for clearing pending staging artifacts for one job.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeStagingArtifactsClearPendingForJobRequest {
    job_id: String,
}

/// Request payload for listing staging artifact metadata.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeStagingArtifactListRequest {
    job_id: Option<String>,
    status: Option<String>,
    limit: Option<i64>,
}

/// Snapshot of one runtime staging artifact metadata row.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeStagingArtifactRecord {
    artifact_id: String,
    job_id: String,
    artifact_path: String,
    artifact_hash: String,
    target_path: Option<String>,
    operation_intent: Option<String>,
    base_hash: Option<String>,
    source_kind: Option<String>,
    status: String,
    created_at_ms: i64,
    updated_at_ms: i64,
    expires_at_ms: Option<i64>,
    deleted_at_ms: Option<i64>,
    last_error: Option<String>,
}

/// Snapshot response for staging artifact metadata.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeStagingArtifactList {
    enabled: bool,
    status: RuntimeDbHealthState,
    artifacts: Vec<RuntimeStagingArtifactRecord>,
}

/// Response payload for clearing pending staging artifacts for one job.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeStagingArtifactsClearPendingForJob {
    cleared: Vec<RuntimeStagingArtifactRecord>,
}

/// Response payload for a staging artifact GC pass.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeStagingArtifactGc {
    deleted: Vec<RuntimeStagingArtifactRecord>,
}

/// Request payload for recording one derived stale marker.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeDerivedStaleMarkerRecordRequest {
    marker_id: Option<String>,
    layer: String,
    affected_path: String,
    input_hash: Option<String>,
    base_version: String,
    reason: String,
    source_event_id: String,
}

/// Request payload for listing derived stale marker snapshots.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeDerivedStaleMarkerListRequest {
    layer: Option<String>,
    affected_path: Option<String>,
    status: Option<String>,
    limit: Option<i64>,
}

/// Snapshot of one derived stale marker row.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeDerivedStaleMarkerRecord {
    marker_id: String,
    layer: String,
    affected_path: String,
    input_hash: Option<String>,
    base_version: String,
    marked_at_ms: i64,
    reason: String,
    source_event_id: String,
    status: String,
    updated_at_ms: i64,
    last_error: Option<String>,
}

/// Snapshot response for derived stale marker rows.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeDerivedStaleMarkerList {
    enabled: bool,
    status: RuntimeDbHealthState,
    markers: Vec<RuntimeDerivedStaleMarkerRecord>,
}

/// Request payload for creating a stored model profile.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeProfileCreateRequest {
    profile_id: Option<String>,
    kind: String,
    display_name: String,
    provider_id: String,
    model_id: String,
    agent_sdk_model_id: Option<String>,
    endpoint: Option<String>,
    api_mode: String,
    auth_style: String,
    secret_ref: Option<String>,
    enabled: Option<bool>,
    task_families: Vec<String>,
    max_concurrency: Option<i64>,
}

/// Request payload for updating non-secret model profile metadata.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeProfileUpdateRequest {
    profile_id: String,
    display_name: Option<String>,
    provider_id: Option<String>,
    model_id: Option<String>,
    agent_sdk_model_id: Option<String>,
    clear_agent_sdk_model_id: Option<bool>,
    endpoint: Option<String>,
    clear_endpoint: Option<bool>,
    api_mode: Option<String>,
    auth_style: Option<String>,
    secret_ref: Option<String>,
    clear_secret_ref: Option<bool>,
    enabled: Option<bool>,
    task_families: Option<Vec<String>>,
    max_concurrency: Option<i64>,
    capability_status: Option<String>,
    capability_json: Option<String>,
    capability_version: Option<String>,
    capability_checked_at_ms: Option<i64>,
    probe_backoff_until_ms: Option<i64>,
    last_capability_error: Option<String>,
    clear_last_capability_error: Option<bool>,
}

/// Request payload for reading one stored model profile.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeProfileStatusRequest {
    profile_id: String,
}

/// Request payload for soft-deleting one stored model profile.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeProfileDeleteRequest {
    profile_id: String,
}

/// Response payload for a soft-deleted model profile. It never contains a secret value.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeProfileDeleteResult {
    profile_id: String,
    deleted_at_ms: i64,
    secret_ref: Option<String>,
}

/// Snapshot of one stored model profile. It never contains a secret value.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeProfileRecord {
    profile_id: String,
    kind: String,
    display_name: String,
    provider_id: String,
    model_id: String,
    agent_sdk_model_id: Option<String>,
    endpoint: Option<String>,
    api_mode: String,
    auth_style: String,
    secret_ref: Option<String>,
    enabled: bool,
    task_families: Vec<String>,
    max_concurrency: i64,
    capability_status: String,
    capability_json: String,
    capability_version: String,
    capability_checked_at_ms: Option<i64>,
    probe_backoff_until_ms: Option<i64>,
    last_capability_error: Option<String>,
    created_at_ms: i64,
    updated_at_ms: i64,
}

/// Snapshot response for stored model profiles.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeProfileList {
    enabled: bool,
    status: RuntimeDbHealthState,
    profiles: Vec<RuntimeProfileRecord>,
}

/// Unsaved profile metadata used for one-request capability probes.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeProfileProbeDraftRequest {
    kind: String,
    provider_id: String,
    model_id: String,
    agent_sdk_model_id: Option<String>,
    endpoint: Option<String>,
    api_mode: String,
    auth_style: String,
}

/// Request payload for checking stored or draft model profile capabilities.
#[derive(Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeProfileProbeRequest {
    profile_id: Option<String>,
    draft: Option<RuntimeProfileProbeDraftRequest>,
    raw_secret: Option<String>,
    force: Option<bool>,
}

/// Non-secret profile capability probe result returned to Tauri callers.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeProfileProbeResult {
    profile: Option<RuntimeProfileRecord>,
    status: String,
    capability_json: String,
    capability_version: String,
    checked_at_ms: i64,
    backoff_until_ms: Option<i64>,
    message: String,
}

/// Request payload for claiming one eligible profile-pool slot.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeProfilePoolClaimRequest {
    claim_id: Option<String>,
    kind: String,
    task_family: String,
    holder: String,
    job_id: Option<String>,
    ttl_ms: Option<i64>,
    preferred_profile_ids: Option<Vec<String>>,
}

/// Request payload for releasing one active profile-pool claim.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeProfilePoolReleaseRequest {
    claim_id: String,
    outcome: String,
    retry_after_ms: Option<i64>,
    circuit_open_ms: Option<i64>,
    reason: Option<String>,
    error: Option<String>,
}

/// Request payload for renewing one active profile-pool claim.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeProfilePoolRenewRequest {
    claim_id: String,
    ttl_ms: Option<i64>,
}

/// Request payload for listing profile-pool observability rows.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeProfilePoolListRequest {
    kind: Option<String>,
    task_family: Option<String>,
    job_id: Option<String>,
}

/// Snapshot of one profile-pool claim. It never contains secret values.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeProfileClaimRecord {
    claim_id: String,
    profile_id: String,
    kind: String,
    task_family: String,
    job_id: Option<String>,
    holder: String,
    acquired_at_ms: i64,
    expires_at_ms: i64,
    released_at_ms: Option<i64>,
    status: String,
}

/// Snapshot of one profile circuit breaker. It never contains secret values.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeProfileCircuitBreakerRecord {
    profile_id: String,
    status: String,
    reason: Option<String>,
    error: Option<String>,
    opened_at_ms: i64,
    open_until_ms: i64,
    updated_at_ms: i64,
}

/// Response payload for a successful profile-pool claim.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeProfilePoolClaim {
    claim_id: String,
    profile_id: String,
    expires_at_ms: i64,
    claim: RuntimeProfileClaimRecord,
}

/// Response payload for a profile-pool release.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeProfilePoolRelease {
    claim: RuntimeProfileClaimRecord,
    circuit_breaker: Option<RuntimeProfileCircuitBreakerRecord>,
}

/// Response payload for a renewed profile-pool claim.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeProfilePoolRenew {
    claim_id: String,
    profile_id: String,
    expires_at_ms: i64,
    claim: RuntimeProfileClaimRecord,
}

/// Snapshot response for active profile claims and open circuit breakers.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeProfilePoolList {
    enabled: bool,
    status: RuntimeDbHealthState,
    active_claims: Vec<RuntimeProfileClaimRecord>,
    circuit_breakers: Vec<RuntimeProfileCircuitBreakerRecord>,
}

/// Sidecar-ready Agent profile config. This is crate-internal and may contain a
/// secret value, so it must never be exposed as a Tauri command response.
#[derive(Clone, PartialEq, Eq)]
pub(crate) struct AgentRunProfileConfig {
    pub(crate) profile_id: String,
    pub(crate) provider_model_id: String,
    pub(crate) agent_sdk_model_id: String,
    pub(crate) endpoint: Option<String>,
    pub(crate) auth_style: String,
    pub(crate) secret_value: Option<String>,
}

impl std::fmt::Debug for AgentRunProfileConfig {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("AgentRunProfileConfig")
            .field("profile_id", &self.profile_id)
            .field("provider_model_id", &self.provider_model_id)
            .field("agent_sdk_model_id", &self.agent_sdk_model_id)
            .field("endpoint", &self.endpoint)
            .field("auth_style", &self.auth_style)
            .field(
                "secret_value",
                &self.secret_value.as_ref().map(|_| "[REDACTED]"),
            )
            .finish()
    }
}

impl std::fmt::Debug for RuntimeProfileProbeRequest {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("RuntimeProfileProbeRequest")
            .field("profile_id", &self.profile_id)
            .field("draft", &self.draft)
            .field(
                "raw_secret",
                &self.raw_secret.as_ref().map(|_| "[REDACTED]"),
            )
            .field("force", &self.force)
            .finish()
    }
}

#[derive(Clone)]
struct RuntimeProfileProbeTarget {
    profile_id: Option<String>,
    kind: String,
    provider_id: String,
    model_id: String,
    agent_sdk_model_id: Option<String>,
    endpoint: Option<String>,
    api_mode: String,
    auth_style: String,
    secret_value: String,
}

impl std::fmt::Debug for RuntimeProfileProbeTarget {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("RuntimeProfileProbeTarget")
            .field("profile_id", &self.profile_id)
            .field("kind", &self.kind)
            .field("provider_id", &self.provider_id)
            .field("model_id", &self.model_id)
            .field("agent_sdk_model_id", &self.agent_sdk_model_id)
            .field("endpoint", &self.endpoint)
            .field("api_mode", &self.api_mode)
            .field("auth_style", &self.auth_style)
            .field("secret_value", &"[REDACTED]")
            .finish()
    }
}

#[derive(Debug, Clone)]
struct RuntimeProfileProbeOutcome {
    status: String,
    capability_json: String,
    message: String,
    backoff_until_ms: Option<i64>,
    last_capability_error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct NormalizedAffectedPath {
    display_key: String,
    resource_key: String,
}

fn runtime_db_path(project_root: &Path) -> PathBuf {
    project_root.join(RUNTIME_DIR).join(RUNTIME_DB_FILE)
}

fn staging_dir_path(project_root: &Path) -> PathBuf {
    project_root.join(RUNTIME_DIR).join(STAGING_DIR)
}

fn parse_work_runtime_enabled(value: Option<&str>) -> bool {
    value
        .map(str::trim)
        .map(str::to_ascii_lowercase)
        .is_some_and(|value| matches!(value.as_str(), "1" | "true" | "yes" | "on"))
}

fn read_work_runtime_flag_value() -> Option<String> {
    std::env::var(WORK_RUNTIME_ENABLED_ENV).ok()
}

fn resolve_work_runtime_enabled(adapter_flag_value: Option<String>) -> bool {
    parse_work_runtime_enabled(adapter_flag_value.as_deref())
}

pub(crate) fn work_runtime_enabled_from_env() -> bool {
    resolve_work_runtime_enabled(read_work_runtime_flag_value())
}

/// Return runtime DB health/status.
///
/// When enabled, this command is an idempotent initializer: it may create
/// `<project>/.llm-wiki/runtime/`, open `runtime.db`, enable WAL, and apply
/// migration bookkeeping. It is not a pure read-only probe. When disabled or
/// when no project root is available, it does not touch disk.
#[tauri::command]
pub fn runtime_db_health(
    root_state: State<'_, ProjectRootState>,
) -> Result<RuntimeDbHealth, String> {
    run_guarded("runtime_db_health", || {
        let runtime_enabled = resolve_work_runtime_enabled(read_work_runtime_flag_value());
        let fallback_root = root_state.get();

        runtime_db_health_for_project(fallback_root.as_deref(), runtime_enabled)
    })
}

/// Create a queued runtime job for the currently-open project.
#[tauri::command]
pub fn runtime_job_create(
    request: RuntimeJobCreateRequest,
    root_state: State<'_, ProjectRootState>,
) -> Result<RuntimeJobRecord, String> {
    run_guarded("runtime_job_create", || {
        let runtime_enabled = resolve_work_runtime_enabled(read_work_runtime_flag_value());
        let project_root = root_state.get();
        let now = now_for_enabled_project(project_root.as_deref(), runtime_enabled)?;
        runtime_job_create_for_project(project_root.as_deref(), runtime_enabled, request, now)
    })
}

/// Claim the next queued runtime job for the currently-open project.
#[tauri::command]
pub fn runtime_job_claim(
    request: RuntimeJobClaimRequest,
    root_state: State<'_, ProjectRootState>,
) -> Result<RuntimeJobClaim, String> {
    run_guarded("runtime_job_claim", || {
        let runtime_enabled = resolve_work_runtime_enabled(read_work_runtime_flag_value());
        let project_root = root_state.get();
        let now = now_for_enabled_project(project_root.as_deref(), runtime_enabled)?;
        runtime_job_claim_for_project(project_root.as_deref(), runtime_enabled, request, now)
    })
}

/// Claim the next queued runtime job for a specific job kind.
#[tauri::command]
pub fn runtime_job_claim_by_kind(
    request: RuntimeJobClaimByKindRequest,
    root_state: State<'_, ProjectRootState>,
) -> Result<RuntimeJobClaim, String> {
    run_guarded("runtime_job_claim_by_kind", || {
        let runtime_enabled = resolve_work_runtime_enabled(read_work_runtime_flag_value());
        let project_root = root_state.get();
        let now = now_for_enabled_project(project_root.as_deref(), runtime_enabled)?;
        runtime_job_claim_by_kind_for_project(
            project_root.as_deref(),
            runtime_enabled,
            request,
            now,
        )
    })
}

/// Renew the active lease for a running runtime job.
#[tauri::command]
pub fn runtime_job_heartbeat(
    request: RuntimeJobLeaseRequest,
    root_state: State<'_, ProjectRootState>,
) -> Result<RuntimeJobClaim, String> {
    run_guarded("runtime_job_heartbeat", || {
        let runtime_enabled = resolve_work_runtime_enabled(read_work_runtime_flag_value());
        let project_root = root_state.get();
        let now = now_for_enabled_project(project_root.as_deref(), runtime_enabled)?;
        runtime_job_heartbeat_for_project(project_root.as_deref(), runtime_enabled, request, now)
    })
}

/// Complete a running runtime job and release its active lease.
#[tauri::command]
pub fn runtime_job_complete(
    request: RuntimeJobLeaseRequest,
    root_state: State<'_, ProjectRootState>,
) -> Result<RuntimeJobRecord, String> {
    run_guarded("runtime_job_complete", || {
        let runtime_enabled = resolve_work_runtime_enabled(read_work_runtime_flag_value());
        let project_root = root_state.get();
        let now = now_for_enabled_project(project_root.as_deref(), runtime_enabled)?;
        runtime_job_complete_for_project(project_root.as_deref(), runtime_enabled, request, now)
    })
}

/// Fail a running runtime job and release its active lease.
#[tauri::command]
pub fn runtime_job_fail(
    request: RuntimeJobFailRequest,
    root_state: State<'_, ProjectRootState>,
) -> Result<RuntimeJobRecord, String> {
    run_guarded("runtime_job_fail", || {
        let runtime_enabled = resolve_work_runtime_enabled(read_work_runtime_flag_value());
        let project_root = root_state.get();
        let now = now_for_enabled_project(project_root.as_deref(), runtime_enabled)?;
        runtime_job_fail_for_project(project_root.as_deref(), runtime_enabled, request, now)
    })
}

/// Retry a failed or retry-ready runtime job.
#[tauri::command]
pub fn runtime_job_retry(
    request: RuntimeJobRetryRequest,
    root_state: State<'_, ProjectRootState>,
) -> Result<RuntimeJobRecord, String> {
    run_guarded("runtime_job_retry", || {
        let runtime_enabled = resolve_work_runtime_enabled(read_work_runtime_flag_value());
        let project_root = root_state.get();
        let now = now_for_enabled_project(project_root.as_deref(), runtime_enabled)?;
        runtime_job_retry_for_project(project_root.as_deref(), runtime_enabled, request, now)
    })
}

/// Cancel a non-terminal runtime job.
#[tauri::command]
pub fn runtime_job_cancel(
    request: RuntimeJobCancelRequest,
    root_state: State<'_, ProjectRootState>,
) -> Result<RuntimeJobRecord, String> {
    run_guarded("runtime_job_cancel", || {
        let runtime_enabled = resolve_work_runtime_enabled(read_work_runtime_flag_value());
        let project_root = root_state.get();
        let now = now_for_enabled_project(project_root.as_deref(), runtime_enabled)?;
        runtime_job_cancel_for_project(project_root.as_deref(), runtime_enabled, request, now)
    })
}

/// Pause a queued or running runtime job.
#[tauri::command]
pub fn runtime_job_pause(
    request: RuntimeJobPauseRequest,
    root_state: State<'_, ProjectRootState>,
) -> Result<RuntimeJobRecord, String> {
    run_guarded("runtime_job_pause", || {
        let runtime_enabled = resolve_work_runtime_enabled(read_work_runtime_flag_value());
        let project_root = root_state.get();
        let now = now_for_enabled_project(project_root.as_deref(), runtime_enabled)?;
        runtime_job_pause_for_project(project_root.as_deref(), runtime_enabled, request, now)
    })
}

/// Resume a paused runtime job back to the queued state.
#[tauri::command]
pub fn runtime_job_resume(
    request: RuntimeJobResumeRequest,
    root_state: State<'_, ProjectRootState>,
) -> Result<RuntimeJobRecord, String> {
    run_guarded("runtime_job_resume", || {
        let runtime_enabled = resolve_work_runtime_enabled(read_work_runtime_flag_value());
        let project_root = root_state.get();
        let now = now_for_enabled_project(project_root.as_deref(), runtime_enabled)?;
        runtime_job_resume_for_project(project_root.as_deref(), runtime_enabled, request, now)
    })
}

/// List runtime jobs and leases for the currently-open project.
#[tauri::command]
pub fn runtime_job_list(root_state: State<'_, ProjectRootState>) -> Result<RuntimeJobList, String> {
    run_guarded("runtime_job_list", || {
        runtime_job_list_for_project(
            root_state.get().as_deref(),
            resolve_work_runtime_enabled(read_work_runtime_flag_value()),
        )
    })
}

/// Claim commit-path budget capacity for the currently-open project.
#[tauri::command]
pub fn runtime_commit_budget_claim(
    request: RuntimeCommitBudgetClaimRequest,
    root_state: State<'_, ProjectRootState>,
) -> Result<RuntimeCommitBudgetClaim, String> {
    run_guarded("runtime_commit_budget_claim", || {
        let runtime_enabled = resolve_work_runtime_enabled(read_work_runtime_flag_value());
        let project_root = root_state.get();
        let now = now_for_enabled_project(project_root.as_deref(), runtime_enabled)?;
        runtime_commit_budget_claim_for_project(
            project_root.as_deref(),
            runtime_enabled,
            request,
            now,
        )
    })
}

/// Release an active commit-path budget claim.
#[tauri::command]
pub fn runtime_commit_budget_release(
    request: RuntimeCommitBudgetReleaseRequest,
    root_state: State<'_, ProjectRootState>,
) -> Result<Vec<RuntimeResourceBudgetClaimRecord>, String> {
    run_guarded("runtime_commit_budget_release", || {
        let runtime_enabled = resolve_work_runtime_enabled(read_work_runtime_flag_value());
        let project_root = root_state.get();
        let now = now_for_enabled_project(project_root.as_deref(), runtime_enabled)?;
        runtime_commit_budget_release_for_project(
            project_root.as_deref(),
            runtime_enabled,
            request,
            now,
        )
    })
}

/// List commit budget rows and active claims for the currently-open project.
#[tauri::command]
pub fn runtime_commit_budget_list(
    root_state: State<'_, ProjectRootState>,
) -> Result<RuntimeCommitBudgetList, String> {
    run_guarded("runtime_commit_budget_list", || {
        runtime_commit_budget_list_for_project(
            root_state.get().as_deref(),
            resolve_work_runtime_enabled(read_work_runtime_flag_value()),
        )
    })
}

/// Append a durable runtime event for the currently-open project.
#[tauri::command]
pub fn runtime_event_append(
    request: RuntimeEventAppendRequest,
    root_state: State<'_, ProjectRootState>,
) -> Result<RuntimeEventRecord, String> {
    run_guarded("runtime_event_append", || {
        let runtime_enabled = resolve_work_runtime_enabled(read_work_runtime_flag_value());
        let project_root = root_state.get();
        let now = now_for_enabled_project(project_root.as_deref(), runtime_enabled)?;
        runtime_event_append_for_project(project_root.as_deref(), runtime_enabled, request, now)
    })
}

/// Append or coalesce a runtime progress fact for the currently-open project.
#[tauri::command]
pub fn runtime_progress_append(
    request: RuntimeProgressAppendRequest,
    root_state: State<'_, ProjectRootState>,
) -> Result<RuntimeProgressAppend, String> {
    run_guarded("runtime_progress_append", || {
        let runtime_enabled = resolve_work_runtime_enabled(read_work_runtime_flag_value());
        let project_root = root_state.get();
        let now = now_for_enabled_project(project_root.as_deref(), runtime_enabled)?;
        runtime_progress_append_for_project(project_root.as_deref(), runtime_enabled, request, now)
    })
}

/// List runtime events for the currently-open project.
#[tauri::command]
pub fn runtime_timeline_list(
    request: Option<RuntimeTimelineListRequest>,
    root_state: State<'_, ProjectRootState>,
) -> Result<RuntimeTimelineList, String> {
    run_guarded("runtime_timeline_list", || {
        runtime_timeline_list_for_project(
            root_state.get().as_deref(),
            resolve_work_runtime_enabled(read_work_runtime_flag_value()),
            request.unwrap_or(RuntimeTimelineListRequest {
                job_id: None,
                limit: None,
            }),
        )
    })
}

/// List runtime progress facts for the currently-open project.
#[tauri::command]
pub fn runtime_progress_list(
    request: Option<RuntimeProgressListRequest>,
    root_state: State<'_, ProjectRootState>,
) -> Result<RuntimeProgressList, String> {
    run_guarded("runtime_progress_list", || {
        runtime_progress_list_for_project(
            root_state.get().as_deref(),
            resolve_work_runtime_enabled(read_work_runtime_flag_value()),
            request.unwrap_or(RuntimeProgressListRequest {
                job_id: None,
                limit: None,
            }),
        )
    })
}

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

/// Record one pending derived stale marker for the currently-open project.
#[tauri::command]
pub fn runtime_derived_stale_marker_record(
    request: RuntimeDerivedStaleMarkerRecordRequest,
    root_state: State<'_, ProjectRootState>,
) -> Result<RuntimeDerivedStaleMarkerRecord, String> {
    run_guarded("runtime_derived_stale_marker_record", || {
        let runtime_enabled = resolve_work_runtime_enabled(read_work_runtime_flag_value());
        let project_root = root_state.get();
        let now = now_for_enabled_project(project_root.as_deref(), runtime_enabled)?;
        runtime_derived_stale_marker_record_for_project(
            project_root.as_deref(),
            runtime_enabled,
            request,
            now,
        )
    })
}

/// List derived stale markers for the currently-open project.
#[tauri::command]
pub fn runtime_derived_stale_marker_list(
    request: Option<RuntimeDerivedStaleMarkerListRequest>,
    root_state: State<'_, ProjectRootState>,
) -> Result<RuntimeDerivedStaleMarkerList, String> {
    run_guarded("runtime_derived_stale_marker_list", || {
        runtime_derived_stale_marker_list_for_project(
            root_state.get().as_deref(),
            resolve_work_runtime_enabled(read_work_runtime_flag_value()),
            request.unwrap_or(RuntimeDerivedStaleMarkerListRequest {
                layer: None,
                affected_path: None,
                status: None,
                limit: None,
            }),
        )
    })
}

/// Create a stored model profile for the currently-open project.
#[tauri::command]
pub fn runtime_profile_create(
    request: RuntimeProfileCreateRequest,
    root_state: State<'_, ProjectRootState>,
) -> Result<RuntimeProfileRecord, String> {
    run_guarded("runtime_profile_create", || {
        let runtime_enabled = resolve_work_runtime_enabled(read_work_runtime_flag_value());
        let project_root = root_state.get();
        let now = now_for_enabled_project(project_root.as_deref(), runtime_enabled)?;
        runtime_profile_create_for_project(project_root.as_deref(), runtime_enabled, request, now)
    })
}

/// Update non-secret model profile metadata for the currently-open project.
#[tauri::command]
pub fn runtime_profile_update(
    request: RuntimeProfileUpdateRequest,
    root_state: State<'_, ProjectRootState>,
) -> Result<RuntimeProfileRecord, String> {
    run_guarded("runtime_profile_update", || {
        let runtime_enabled = resolve_work_runtime_enabled(read_work_runtime_flag_value());
        let project_root = root_state.get();
        let now = now_for_enabled_project(project_root.as_deref(), runtime_enabled)?;
        runtime_profile_update_for_project(project_root.as_deref(), runtime_enabled, request, now)
    })
}

/// Soft-delete one stored model profile for the currently-open project.
#[tauri::command]
pub fn runtime_profile_delete(
    request: RuntimeProfileDeleteRequest,
    root_state: State<'_, ProjectRootState>,
) -> Result<RuntimeProfileDeleteResult, String> {
    run_guarded("runtime_profile_delete", || {
        let runtime_enabled = resolve_work_runtime_enabled(read_work_runtime_flag_value());
        let project_root = root_state.get();
        let now = now_for_enabled_project(project_root.as_deref(), runtime_enabled)?;
        runtime_profile_delete_for_project(project_root.as_deref(), runtime_enabled, request, now)
    })
}

/// List stored model profiles for the currently-open project.
#[tauri::command]
pub fn runtime_profile_list(
    root_state: State<'_, ProjectRootState>,
) -> Result<RuntimeProfileList, String> {
    run_guarded("runtime_profile_list", || {
        runtime_profile_list_for_project(
            root_state.get().as_deref(),
            resolve_work_runtime_enabled(read_work_runtime_flag_value()),
        )
    })
}

/// Read one stored model profile/capability status for the currently-open project.
#[tauri::command]
pub fn runtime_profile_status(
    request: RuntimeProfileStatusRequest,
    root_state: State<'_, ProjectRootState>,
) -> Result<RuntimeProfileRecord, String> {
    run_guarded("runtime_profile_status", || {
        runtime_profile_status_for_project(
            root_state.get().as_deref(),
            resolve_work_runtime_enabled(read_work_runtime_flag_value()),
            request,
        )
    })
}

/// Probe stored or draft model profile capabilities without returning secrets.
#[tauri::command]
pub async fn runtime_profile_probe(
    request: RuntimeProfileProbeRequest,
    root_state: State<'_, ProjectRootState>,
) -> Result<RuntimeProfileProbeResult, String> {
    let (project_root, runtime_enabled, now) = run_guarded("runtime_profile_probe", || {
        let runtime_enabled = resolve_work_runtime_enabled(read_work_runtime_flag_value());
        let project_root = root_state.get();
        let now = now_for_enabled_project(project_root.as_deref(), runtime_enabled)?;
        Ok((project_root, runtime_enabled, now))
    })?;

    let client = Client::builder()
        .timeout(Duration::from_secs(PROFILE_PROBE_TIMEOUT_SECS))
        .build()
        .map_err(|err| format!("profile-probe-client-failed: {err}"))?;
    runtime_profile_probe_for_project_with_store(
        project_root.as_deref(),
        runtime_enabled,
        request,
        now,
        &OsSecretStore,
        &client,
    )
    .await
}

/// Claim one eligible profile-pool slot for the currently-open project.
#[tauri::command]
pub fn runtime_profile_pool_claim(
    request: RuntimeProfilePoolClaimRequest,
    root_state: State<'_, ProjectRootState>,
) -> Result<RuntimeProfilePoolClaim, String> {
    run_guarded("runtime_profile_pool_claim", || {
        let runtime_enabled = resolve_work_runtime_enabled(read_work_runtime_flag_value());
        let project_root = root_state.get();
        let now = now_for_enabled_project(project_root.as_deref(), runtime_enabled)?;
        runtime_profile_pool_claim_for_project(
            project_root.as_deref(),
            runtime_enabled,
            request,
            now,
        )
    })
}

/// Release one active profile-pool claim for the currently-open project.
#[tauri::command]
pub fn runtime_profile_pool_release(
    request: RuntimeProfilePoolReleaseRequest,
    root_state: State<'_, ProjectRootState>,
) -> Result<RuntimeProfilePoolRelease, String> {
    run_guarded("runtime_profile_pool_release", || {
        let runtime_enabled = resolve_work_runtime_enabled(read_work_runtime_flag_value());
        let project_root = root_state.get();
        let now = now_for_enabled_project(project_root.as_deref(), runtime_enabled)?;
        runtime_profile_pool_release_for_project(
            project_root.as_deref(),
            runtime_enabled,
            request,
            now,
        )
    })
}

/// Renew one active profile-pool claim for the currently-open project.
#[tauri::command]
pub fn runtime_profile_pool_renew(
    request: RuntimeProfilePoolRenewRequest,
    root_state: State<'_, ProjectRootState>,
) -> Result<RuntimeProfilePoolRenew, String> {
    run_guarded("runtime_profile_pool_renew", || {
        let runtime_enabled = resolve_work_runtime_enabled(read_work_runtime_flag_value());
        let project_root = root_state.get();
        let now = now_for_enabled_project(project_root.as_deref(), runtime_enabled)?;
        runtime_profile_pool_renew_for_project(
            project_root.as_deref(),
            runtime_enabled,
            request,
            now,
        )
    })
}

/// List active profile-pool claims and open circuit breakers for observability.
#[tauri::command]
pub fn runtime_profile_pool_list(
    request: Option<RuntimeProfilePoolListRequest>,
    root_state: State<'_, ProjectRootState>,
) -> Result<RuntimeProfilePoolList, String> {
    run_guarded("runtime_profile_pool_list", || {
        let runtime_enabled = resolve_work_runtime_enabled(read_work_runtime_flag_value());
        let now = now_ms()?;
        runtime_profile_pool_list_for_project(
            root_state.get().as_deref(),
            runtime_enabled,
            request.unwrap_or(RuntimeProfilePoolListRequest {
                kind: None,
                task_family: None,
                job_id: None,
            }),
            now,
        )
    })
}

#[cfg(test)]
fn runtime_db_health_with_fallback(
    explicit_root: Option<PathBuf>,
    fallback_root: Option<PathBuf>,
    enabled: bool,
) -> Result<RuntimeDbHealth, String> {
    if !enabled {
        return runtime_db_health_for_project(explicit_root.as_deref(), false);
    }

    let project_root = explicit_root.or(fallback_root);
    runtime_db_health_for_project(project_root.as_deref(), true)
}

fn runtime_db_health_for_project(
    project_root: Option<&Path>,
    enabled: bool,
) -> Result<RuntimeDbHealth, String> {
    let project_path = project_root.map(path_to_string);

    if !enabled {
        return Ok(RuntimeDbHealth {
            enabled: false,
            status: RuntimeDbHealthState::Disabled,
            project_path,
            runtime_dir: None,
            db_path: None,
            journal_mode: None,
            migrations: Vec::new(),
        });
    }

    let Some(project_root) = project_root else {
        return Ok(RuntimeDbHealth {
            enabled: true,
            status: RuntimeDbHealthState::NoProject,
            project_path: None,
            runtime_dir: None,
            db_path: None,
            journal_mode: None,
            migrations: Vec::new(),
        });
    };

    initialize_runtime_db(project_root)
}

fn initialize_runtime_db(project_root: &Path) -> Result<RuntimeDbHealth, String> {
    with_runtime_writer(|| initialize_runtime_db_locked(project_root))
}

fn initialize_runtime_db_locked(project_root: &Path) -> Result<RuntimeDbHealth, String> {
    let (connection, runtime_dir, db_path, journal_mode) =
        open_initialized_runtime_db_locked(project_root)?;

    connection
        .execute(
            "CREATE TABLE IF NOT EXISTS runtime_schema_migrations (
                family TEXT PRIMARY KEY,
                version INTEGER NOT NULL,
                applied_at_ms INTEGER NOT NULL
            )",
            [],
        )
        .map_err(|err| format!("Failed to initialize runtime migrations table: {err}"))?;

    connection
        .execute(
            "INSERT OR IGNORE INTO runtime_schema_migrations (
                family,
                version,
                applied_at_ms
            ) VALUES (?1, ?2, ?3)",
            params![MIGRATIONS_FAMILY, MIGRATIONS_VERSION, now_ms()?],
        )
        .map_err(|err| format!("Failed to record runtime migration family: {err}"))?;

    Ok(RuntimeDbHealth {
        enabled: true,
        status: RuntimeDbHealthState::Healthy,
        project_path: Some(path_to_string(project_root)),
        runtime_dir: Some(path_to_string(&runtime_dir)),
        db_path: Some(path_to_string(&db_path)),
        journal_mode: Some(journal_mode),
        migrations: read_migrations(&connection)?,
    })
}

fn open_initialized_runtime_db_locked(
    project_root: &Path,
) -> Result<(Connection, PathBuf, PathBuf, String), String> {
    let runtime_dir = project_root.join(RUNTIME_DIR);
    let db_path = runtime_db_path(project_root);

    std::fs::create_dir_all(&runtime_dir).map_err(|err| {
        format!(
            "Failed to create runtime directory '{}': {err}",
            runtime_dir.display()
        )
    })?;

    let connection = open_runtime_connection(&db_path)?;
    let journal_mode = connection
        .query_row("PRAGMA journal_mode = WAL", [], |row| {
            row.get::<_, String>(0)
        })
        .map_err(|err| format!("Failed to enable WAL for '{}': {err}", db_path.display()))?;

    Ok((connection, runtime_dir, db_path, journal_mode))
}

fn with_runtime_writer<T>(body: impl FnOnce() -> Result<T, String>) -> Result<T, String> {
    let lock = RUNTIME_DB_WRITE_LOCK.get_or_init(|| Mutex::new(()));
    let _guard = lock.lock().map_err(|_| {
        "runtime-db-writer-poisoned: runtime DB writer lock is poisoned".to_string()
    })?;
    body()
}

fn open_runtime_connection(db_path: &Path) -> Result<Connection, String> {
    let connection = Connection::open(db_path)
        .map_err(|err| format!("Failed to open runtime DB '{}': {err}", db_path.display()))?;
    enable_foreign_keys(&connection)?;
    Ok(connection)
}

fn enable_foreign_keys(connection: &Connection) -> Result<(), String> {
    connection
        .execute("PRAGMA foreign_keys = ON", [])
        .map_err(|err| format!("Failed to enable SQLite foreign keys: {err}"))?;
    let enabled = connection
        .query_row("PRAGMA foreign_keys", [], |row| row.get::<_, i64>(0))
        .map_err(|err| format!("Failed to verify SQLite foreign keys: {err}"))?;
    if enabled == 1 {
        Ok(())
    } else {
        Err("foreign-keys-disabled: SQLite foreign key enforcement is disabled".to_string())
    }
}

fn open_job_runtime_locked(project_root: &Path) -> Result<Connection, String> {
    initialize_runtime_db_locked(project_root)?;
    let connection = open_runtime_connection(&runtime_db_path(project_root))?;
    initialize_job_schema(&connection)?;
    Ok(connection)
}

fn initialize_job_schema(connection: &Connection) -> Result<(), String> {
    connection
        .execute(
            "CREATE TABLE IF NOT EXISTS runtime_jobs (
                job_id TEXT PRIMARY KEY,
                kind TEXT NOT NULL,
                payload TEXT NOT NULL,
                state TEXT NOT NULL CHECK (
                    state IN (
                        'queued',
                        'running',
                        'paused',
                        'completed',
                        'failed',
                        'cancelled',
                        'retry-wait'
                    )
                ),
                attempt INTEGER NOT NULL,
                max_attempts INTEGER NOT NULL,
                priority INTEGER NOT NULL,
                created_at_ms INTEGER NOT NULL,
                updated_at_ms INTEGER NOT NULL,
                queued_at_ms INTEGER,
                started_at_ms INTEGER,
                completed_at_ms INTEGER,
                failed_at_ms INTEGER,
                cancelled_at_ms INTEGER,
                retry_after_ms INTEGER,
                last_error TEXT
            )",
            [],
        )
        .map_err(|err| format!("Failed to initialize runtime jobs table: {err}"))?;

    connection
        .execute(
            "CREATE TABLE IF NOT EXISTS runtime_job_leases (
                lease_id TEXT PRIMARY KEY,
                job_id TEXT NOT NULL,
                holder TEXT NOT NULL,
                acquired_at_ms INTEGER NOT NULL,
                heartbeat_at_ms INTEGER NOT NULL,
                expires_at_ms INTEGER NOT NULL,
                released_at_ms INTEGER,
                status TEXT NOT NULL CHECK (
                    status IN ('active', 'released', 'expired', 'cancelled')
                ),
                FOREIGN KEY(job_id) REFERENCES runtime_jobs(job_id)
            )",
            [],
        )
        .map_err(|err| format!("Failed to initialize runtime job leases table: {err}"))?;

    connection
        .execute(
            "CREATE INDEX IF NOT EXISTS runtime_jobs_claim_idx
             ON runtime_jobs(state, priority DESC, queued_at_ms ASC, created_at_ms ASC)",
            [],
        )
        .map_err(|err| format!("Failed to initialize runtime jobs claim index: {err}"))?;
    connection
        .execute(
            "CREATE INDEX IF NOT EXISTS runtime_jobs_retry_idx
             ON runtime_jobs(state, retry_after_ms)",
            [],
        )
        .map_err(|err| format!("Failed to initialize runtime jobs retry index: {err}"))?;
    connection
        .execute(
            "CREATE INDEX IF NOT EXISTS runtime_job_leases_job_active_idx
             ON runtime_job_leases(job_id, status)",
            [],
        )
        .map_err(|err| format!("Failed to initialize runtime job lease index: {err}"))?;
    connection
        .execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS runtime_job_active_lease_unique_idx
             ON runtime_job_leases(job_id)
             WHERE status = 'active'",
            [],
        )
        .map_err(|err| format!("Failed to initialize runtime active lease index: {err}"))?;
    connection
        .execute(
            "CREATE INDEX IF NOT EXISTS runtime_job_leases_expiry_idx
             ON runtime_job_leases(status, expires_at_ms)",
            [],
        )
        .map_err(|err| format!("Failed to initialize runtime lease expiry index: {err}"))?;

    record_migration_family(connection, JOBS_FAMILY, JOBS_VERSION)?;
    record_migration_family(connection, LEASES_FAMILY, LEASES_VERSION)
}

fn open_resource_budget_runtime_locked(project_root: &Path) -> Result<Connection, String> {
    let connection = open_job_runtime_locked(project_root)?;
    initialize_resource_budget_schema(&connection)?;
    Ok(connection)
}

fn open_events_progress_runtime_locked(project_root: &Path) -> Result<Connection, String> {
    let connection = open_job_runtime_locked(project_root)?;
    initialize_events_progress_schema(&connection)?;
    Ok(connection)
}

fn open_staging_artifacts_runtime_locked(project_root: &Path) -> Result<Connection, String> {
    let connection = open_job_runtime_locked(project_root)?;
    initialize_staging_artifacts_schema(&connection)?;
    Ok(connection)
}

fn open_derived_stale_markers_runtime_locked(project_root: &Path) -> Result<Connection, String> {
    let connection = open_events_progress_runtime_locked(project_root)?;
    initialize_derived_stale_markers_schema(&connection)?;
    Ok(connection)
}

fn open_profile_runtime_locked(project_root: &Path) -> Result<Connection, String> {
    initialize_runtime_db_locked(project_root)?;
    let connection = open_runtime_connection(&runtime_db_path(project_root))?;
    initialize_profile_schema(&connection)?;
    Ok(connection)
}

fn open_profile_pool_runtime_locked(project_root: &Path) -> Result<Connection, String> {
    let connection = open_events_progress_runtime_locked(project_root)?;
    initialize_profile_schema(&connection)?;
    initialize_profile_pool_schema(&connection)?;
    Ok(connection)
}

fn initialize_resource_budget_schema(connection: &Connection) -> Result<(), String> {
    connection
        .execute(
            "CREATE TABLE IF NOT EXISTS runtime_resource_budgets (
                scope TEXT NOT NULL CHECK (scope IN ('commit-total', 'commit-path')),
                resource_key TEXT NOT NULL,
                display_key TEXT NOT NULL,
                capacity INTEGER NOT NULL CHECK (capacity >= 1),
                created_at_ms INTEGER NOT NULL,
                updated_at_ms INTEGER NOT NULL,
                PRIMARY KEY(scope, resource_key)
            )",
            [],
        )
        .map_err(|err| format!("Failed to initialize runtime resource budgets table: {err}"))?;

    connection
        .execute(
            "CREATE TABLE IF NOT EXISTS runtime_resource_budget_claims (
                claim_id TEXT NOT NULL,
                scope TEXT NOT NULL CHECK (scope IN ('commit-total', 'commit-path')),
                resource_key TEXT NOT NULL,
                display_key TEXT NOT NULL,
                job_id TEXT,
                holder TEXT NOT NULL,
                amount INTEGER NOT NULL CHECK (amount >= 1),
                acquired_at_ms INTEGER NOT NULL,
                expires_at_ms INTEGER NOT NULL,
                released_at_ms INTEGER,
                status TEXT NOT NULL CHECK (status IN ('active', 'released', 'expired')),
                PRIMARY KEY(claim_id, scope, resource_key),
                FOREIGN KEY(scope, resource_key)
                    REFERENCES runtime_resource_budgets(scope, resource_key),
                FOREIGN KEY(job_id) REFERENCES runtime_jobs(job_id)
            )",
            [],
        )
        .map_err(|err| {
            format!("Failed to initialize runtime resource budget claims table: {err}")
        })?;

    connection
        .execute(
            "CREATE INDEX IF NOT EXISTS runtime_resource_claims_active_idx
             ON runtime_resource_budget_claims(scope, resource_key, status, expires_at_ms)",
            [],
        )
        .map_err(|err| {
            format!("Failed to initialize runtime resource claim active index: {err}")
        })?;
    connection
        .execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS runtime_commit_path_active_unique_idx
             ON runtime_resource_budget_claims(resource_key)
             WHERE scope = 'commit-path' AND status = 'active'",
            [],
        )
        .map_err(|err| format!("Failed to initialize runtime commit path unique index: {err}"))?;
    connection
        .execute(
            "CREATE INDEX IF NOT EXISTS runtime_resource_claims_claim_idx
             ON runtime_resource_budget_claims(claim_id, status)",
            [],
        )
        .map_err(|err| format!("Failed to initialize runtime resource claim id index: {err}"))?;
    connection
        .execute(
            "CREATE INDEX IF NOT EXISTS runtime_resource_claims_job_idx
             ON runtime_resource_budget_claims(job_id, status)",
            [],
        )
        .map_err(|err| format!("Failed to initialize runtime resource claim job index: {err}"))?;

    connection
        .execute(
            "INSERT OR IGNORE INTO runtime_resource_budgets (
                scope,
                resource_key,
                display_key,
                capacity,
                created_at_ms,
                updated_at_ms
            ) VALUES (?1, ?2, ?2, ?3, ?4, ?4)",
            params![
                COMMIT_TOTAL_SCOPE,
                COMMIT_TOTAL_RESOURCE_KEY,
                DEFAULT_COMMIT_TOTAL_CAPACITY,
                now_ms()?
            ],
        )
        .map_err(|err| format!("Failed to initialize runtime commit total budget: {err}"))?;
    record_migration_family(
        connection,
        RESOURCE_BUDGETS_FAMILY,
        RESOURCE_BUDGETS_VERSION,
    )
}

fn initialize_events_progress_schema(connection: &Connection) -> Result<(), String> {
    connection
        .execute(
            &format!(
                "CREATE TABLE IF NOT EXISTS runtime_events (
                    event_id TEXT PRIMARY KEY CHECK(length(event_id) > 0),
                    job_id TEXT NOT NULL CHECK(length(job_id) > 0),
                    event_name TEXT NOT NULL CHECK(length(event_name) > 0),
                    payload TEXT NOT NULL CHECK(
                        length(CAST(payload AS BLOB)) > 0
                        AND length(CAST(payload AS BLOB)) <= {MAX_EVENT_PAYLOAD_BYTES}
                    ),
                    created_at_ms INTEGER NOT NULL CHECK(created_at_ms >= 0),
                    FOREIGN KEY(job_id) REFERENCES runtime_jobs(job_id)
                )"
            ),
            [],
        )
        .map_err(|err| format!("Failed to initialize runtime events table: {err}"))?;

    connection
        .execute(
            &format!(
                "CREATE TABLE IF NOT EXISTS runtime_progress (
                    job_id TEXT NOT NULL CHECK(length(job_id) > 0),
                    progress_key TEXT NOT NULL CHECK(length(progress_key) > 0),
                    payload TEXT NOT NULL CHECK(
                        length(CAST(payload AS BLOB)) > 0
                        AND length(CAST(payload AS BLOB)) <= {MAX_EVENT_PAYLOAD_BYTES}
                    ),
                    updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= 0),
                    last_event_id TEXT,
                    PRIMARY KEY(job_id, progress_key),
                    FOREIGN KEY(job_id) REFERENCES runtime_jobs(job_id),
                    FOREIGN KEY(last_event_id) REFERENCES runtime_events(event_id)
                )"
            ),
            [],
        )
        .map_err(|err| format!("Failed to initialize runtime progress table: {err}"))?;

    connection
        .execute(
            "CREATE INDEX IF NOT EXISTS runtime_events_job_time_idx
             ON runtime_events(job_id, created_at_ms, event_id)",
            [],
        )
        .map_err(|err| format!("Failed to initialize runtime events job-time index: {err}"))?;
    connection
        .execute(
            "CREATE INDEX IF NOT EXISTS runtime_events_time_idx
             ON runtime_events(created_at_ms, event_id)",
            [],
        )
        .map_err(|err| format!("Failed to initialize runtime events time index: {err}"))?;
    connection
        .execute(
            "CREATE INDEX IF NOT EXISTS runtime_progress_updated_idx
             ON runtime_progress(updated_at_ms, job_id, progress_key)",
            [],
        )
        .map_err(|err| format!("Failed to initialize runtime progress updated index: {err}"))?;

    record_migration_family(connection, EVENTS_PROGRESS_FAMILY, EVENTS_PROGRESS_VERSION)
}

fn initialize_staging_artifacts_schema(connection: &Connection) -> Result<(), String> {
    connection
        .execute(
            &format!(
                "CREATE TABLE IF NOT EXISTS runtime_staging_artifacts (
                    artifact_id TEXT PRIMARY KEY CHECK(length(artifact_id) > 0),
                    job_id TEXT NOT NULL CHECK(length(job_id) > 0),
                    artifact_path TEXT NOT NULL CHECK(
                        length(CAST(artifact_path AS BLOB)) > 0
                        AND length(CAST(artifact_path AS BLOB)) <= {MAX_STAGING_ARTIFACT_PATH_BYTES}
                    ),
                    artifact_hash TEXT NOT NULL CHECK(
                        length(CAST(artifact_hash AS BLOB)) > 0
                        AND length(CAST(artifact_hash AS BLOB)) <= {MAX_STAGING_ARTIFACT_HASH_BYTES}
                    ),
                    target_path TEXT CHECK(
                        target_path IS NULL
                        OR (
                            length(CAST(target_path AS BLOB)) > 0
                            AND length(CAST(target_path AS BLOB)) <= {MAX_STAGING_ARTIFACT_PATH_BYTES}
                        )
                    ),
                    operation_intent TEXT CHECK(
                        operation_intent IS NULL
                        OR operation_intent IN ('create', 'update', 'append', 'delete')
                    ),
                    base_hash TEXT CHECK(
                        base_hash IS NULL
                        OR (
                            length(CAST(base_hash AS BLOB)) > 0
                            AND length(CAST(base_hash AS BLOB)) <= {MAX_STAGING_ARTIFACT_HASH_BYTES}
                        )
                    ),
                    source_kind TEXT CHECK(
                        source_kind IS NULL
                        OR (
                            length(CAST(source_kind AS BLOB)) > 0
                            AND length(CAST(source_kind AS BLOB)) <= {MAX_STAGING_ARTIFACT_SOURCE_KIND_BYTES}
                        )
                    ),
                    status TEXT NOT NULL CHECK (
                        status IN ('pending', 'committed', 'failed', 'cancelled', 'deleted')
                    ),
                    created_at_ms INTEGER NOT NULL CHECK(created_at_ms >= 0),
                    updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= 0),
                    expires_at_ms INTEGER CHECK(expires_at_ms IS NULL OR expires_at_ms >= 0),
                    deleted_at_ms INTEGER CHECK(deleted_at_ms IS NULL OR deleted_at_ms >= 0),
                    last_error TEXT CHECK(
                        last_error IS NULL
                        OR length(CAST(last_error AS BLOB)) <= {MAX_STAGING_ARTIFACT_ERROR_BYTES}
                    ),
                    FOREIGN KEY(job_id) REFERENCES runtime_jobs(job_id)
                )"
            ),
            [],
        )
        .map_err(|err| format!("Failed to initialize runtime staging artifacts table: {err}"))?;

    ensure_column_exists(
        connection,
        "runtime_staging_artifacts",
        "target_path",
        &format!(
            "ALTER TABLE runtime_staging_artifacts
             ADD COLUMN target_path TEXT CHECK(
                 target_path IS NULL
                 OR (
                     length(CAST(target_path AS BLOB)) > 0
                     AND length(CAST(target_path AS BLOB)) <= {MAX_STAGING_ARTIFACT_PATH_BYTES}
                 )
             )"
        ),
        "runtime staging artifact target_path",
    )?;
    ensure_column_exists(
        connection,
        "runtime_staging_artifacts",
        "operation_intent",
        "ALTER TABLE runtime_staging_artifacts
         ADD COLUMN operation_intent TEXT CHECK(
             operation_intent IS NULL
             OR operation_intent IN ('create', 'update', 'append', 'delete')
         )",
        "runtime staging artifact operation_intent",
    )?;
    ensure_column_exists(
        connection,
        "runtime_staging_artifacts",
        "base_hash",
        &format!(
            "ALTER TABLE runtime_staging_artifacts
             ADD COLUMN base_hash TEXT CHECK(
                 base_hash IS NULL
                 OR (
                     length(CAST(base_hash AS BLOB)) > 0
                     AND length(CAST(base_hash AS BLOB)) <= {MAX_STAGING_ARTIFACT_HASH_BYTES}
                 )
             )"
        ),
        "runtime staging artifact base_hash",
    )?;
    ensure_column_exists(
        connection,
        "runtime_staging_artifacts",
        "source_kind",
        &format!(
            "ALTER TABLE runtime_staging_artifacts
             ADD COLUMN source_kind TEXT CHECK(
                 source_kind IS NULL
                 OR (
                     length(CAST(source_kind AS BLOB)) > 0
                     AND length(CAST(source_kind AS BLOB)) <= {MAX_STAGING_ARTIFACT_SOURCE_KIND_BYTES}
                 )
             )"
        ),
        "runtime staging artifact source_kind",
    )?;

    connection
        .execute(
            "CREATE INDEX IF NOT EXISTS runtime_staging_artifacts_job_idx
             ON runtime_staging_artifacts(job_id, status)",
            [],
        )
        .map_err(|err| {
            format!("Failed to initialize runtime staging artifacts job index: {err}")
        })?;
    connection
        .execute(
            "CREATE INDEX IF NOT EXISTS runtime_staging_artifacts_gc_idx
             ON runtime_staging_artifacts(status, expires_at_ms)",
            [],
        )
        .map_err(|err| format!("Failed to initialize runtime staging artifacts GC index: {err}"))?;

    record_migration_family(
        connection,
        STAGING_ARTIFACTS_FAMILY,
        STAGING_ARTIFACTS_VERSION,
    )
}

fn initialize_derived_stale_markers_schema(connection: &Connection) -> Result<(), String> {
    connection
        .execute(
            &format!(
                "CREATE TABLE IF NOT EXISTS runtime_derived_stale_markers (
                    marker_id TEXT PRIMARY KEY CHECK(length(marker_id) > 0),
                    layer TEXT NOT NULL CHECK (
                        layer IN (
                            'embedding',
                            'graph',
                            'taxonomy',
                            'synthesis',
                            'search',
                            'index_export',
                            'overview'
                        )
                    ),
                    affected_path TEXT NOT NULL CHECK(length(affected_path) > 0),
                    input_hash TEXT CHECK(
                        input_hash IS NULL
                        OR length(CAST(input_hash AS BLOB)) <= {MAX_STAGING_ARTIFACT_HASH_BYTES}
                    ),
                    base_version TEXT NOT NULL CHECK(
                        length(CAST(base_version AS BLOB)) > 0
                        AND length(CAST(base_version AS BLOB)) <= {MAX_DERIVED_MARKER_BASE_VERSION_BYTES}
                    ),
                    marked_at_ms INTEGER NOT NULL CHECK(marked_at_ms >= 0),
                    reason TEXT NOT NULL CHECK (
                        reason IN ('commit', 'delete', 'schema_change', 'manual_rebuild')
                    ),
                    source_event_id TEXT NOT NULL,
                    status TEXT NOT NULL CHECK (
                        status IN ('pending', 'claimed', 'done', 'failed', 'cancelled')
                    ),
                    updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= 0),
                    last_error TEXT CHECK(
                        last_error IS NULL
                        OR length(CAST(last_error AS BLOB)) <= {MAX_STAGING_ARTIFACT_ERROR_BYTES}
                    ),
                    FOREIGN KEY(source_event_id) REFERENCES runtime_events(event_id)
                )"
            ),
            [],
        )
        .map_err(|err| {
            format!("Failed to initialize runtime derived stale markers table: {err}")
        })?;

    connection
        .execute(
            "CREATE INDEX IF NOT EXISTS runtime_derived_markers_status_idx
             ON runtime_derived_stale_markers(status, layer, marked_at_ms, marker_id)",
            [],
        )
        .map_err(|err| {
            format!("Failed to initialize runtime derived marker status index: {err}")
        })?;
    connection
        .execute(
            "CREATE INDEX IF NOT EXISTS runtime_derived_markers_path_idx
             ON runtime_derived_stale_markers(affected_path, layer, status)",
            [],
        )
        .map_err(|err| format!("Failed to initialize runtime derived marker path index: {err}"))?;
    connection
        .execute(
            "CREATE INDEX IF NOT EXISTS runtime_derived_markers_event_idx
             ON runtime_derived_stale_markers(source_event_id)",
            [],
        )
        .map_err(|err| format!("Failed to initialize runtime derived marker event index: {err}"))?;

    record_migration_family(
        connection,
        DERIVED_STALE_MARKERS_FAMILY,
        DERIVED_STALE_MARKERS_VERSION,
    )
}

fn initialize_profile_schema(connection: &Connection) -> Result<(), String> {
    connection
        .execute(
            &format!(
                "CREATE TABLE IF NOT EXISTS runtime_model_profiles (
                    profile_id TEXT PRIMARY KEY CHECK(
                        length(CAST(profile_id AS BLOB)) > 0
                        AND length(CAST(profile_id AS BLOB)) <= {MAX_PROFILE_ID_BYTES}
                    ),
                    kind TEXT NOT NULL CHECK(kind IN ('model-call', 'agent-run')),
                    display_name TEXT NOT NULL CHECK(
                        length(CAST(display_name AS BLOB)) > 0
                        AND length(CAST(display_name AS BLOB)) <= {MAX_PROFILE_DISPLAY_NAME_BYTES}
                    ),
                    provider_id TEXT NOT NULL CHECK(
                        length(CAST(provider_id AS BLOB)) > 0
                        AND length(CAST(provider_id AS BLOB)) <= {MAX_PROFILE_PROVIDER_BYTES}
                    ),
                    model_id TEXT NOT NULL CHECK(
                        length(CAST(model_id AS BLOB)) > 0
                        AND length(CAST(model_id AS BLOB)) <= {MAX_PROFILE_MODEL_BYTES}
                    ),
                    agent_sdk_model_id TEXT CHECK(
                        agent_sdk_model_id IS NULL
                        OR (
                            length(CAST(agent_sdk_model_id AS BLOB)) > 0
                            AND length(CAST(agent_sdk_model_id AS BLOB)) <= {MAX_PROFILE_SDK_MODEL_BYTES}
                        )
                    ),
                    endpoint TEXT CHECK(
                        endpoint IS NULL
                        OR length(CAST(endpoint AS BLOB)) <= {MAX_PROFILE_ENDPOINT_BYTES}
                    ),
                    api_mode TEXT NOT NULL CHECK(
                        api_mode IN (
                            'openai-chat-completions',
                            'anthropic-messages',
                            'google-generate-content',
                            'local-cli'
                        )
                    ),
                    auth_style TEXT NOT NULL CHECK(
                        auth_style IN ('none', 'bearer', 'x-api-key', 'api-key', 'oauth-local-cli')
                    ),
                    secret_ref TEXT CHECK(
                        secret_ref IS NULL
                        OR (
                            length(CAST(secret_ref AS BLOB)) = {PROFILE_SECRET_REF_BYTES}
                            AND secret_ref GLOB '{PROFILE_SECRET_REF_SQL_GLOB}'
                        )
                    ),
                    enabled INTEGER NOT NULL CHECK(enabled IN (0, 1)),
                    task_families_json TEXT NOT NULL CHECK(
                        length(CAST(task_families_json AS BLOB)) > 0
                        AND length(CAST(task_families_json AS BLOB)) <= {MAX_PROFILE_TASK_FAMILIES_BYTES}
                    ),
                    max_concurrency INTEGER NOT NULL CHECK(
                        max_concurrency >= 1 AND max_concurrency <= {MAX_PROFILE_CONCURRENCY}
                    ),
                    capability_status TEXT NOT NULL CHECK(
                        capability_status IN ('unknown', 'supported', 'limited', 'unsupported', 'error')
                    ),
                    capability_json TEXT NOT NULL CHECK(
                        length(CAST(capability_json AS BLOB)) > 0
                        AND length(CAST(capability_json AS BLOB)) <= {MAX_PROFILE_CAPABILITY_JSON_BYTES}
                    ),
                    capability_version TEXT NOT NULL CHECK(
                        length(CAST(capability_version AS BLOB)) > 0
                        AND length(CAST(capability_version AS BLOB)) <= {MAX_PROFILE_CAPABILITY_VERSION_BYTES}
                    ),
                    capability_checked_at_ms INTEGER CHECK(
                        capability_checked_at_ms IS NULL OR capability_checked_at_ms >= 0
                    ),
                    probe_backoff_until_ms INTEGER CHECK(
                        probe_backoff_until_ms IS NULL OR probe_backoff_until_ms >= 0
                    ),
                    last_capability_error TEXT CHECK(
                        last_capability_error IS NULL
                        OR length(CAST(last_capability_error AS BLOB)) <= {MAX_PROFILE_CAPABILITY_ERROR_BYTES}
                    ),
                    created_at_ms INTEGER NOT NULL CHECK(created_at_ms >= 0),
                    updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= 0),
                    deleted_at_ms INTEGER CHECK(deleted_at_ms IS NULL OR deleted_at_ms >= 0)
                )"
            ),
            [],
        )
        .map_err(|err| format!("Failed to initialize runtime model profiles table: {err}"))?;
    ensure_column_exists(
        connection,
        "runtime_model_profiles",
        "deleted_at_ms",
        "ALTER TABLE runtime_model_profiles
         ADD COLUMN deleted_at_ms INTEGER CHECK(deleted_at_ms IS NULL OR deleted_at_ms >= 0)",
        "runtime model profile deleted_at_ms",
    )?;
    ensure_column_exists(
        connection,
        "runtime_model_profiles",
        "agent_sdk_model_id",
        &format!(
            "ALTER TABLE runtime_model_profiles
             ADD COLUMN agent_sdk_model_id TEXT CHECK(
                 agent_sdk_model_id IS NULL
                 OR (
                     length(CAST(agent_sdk_model_id AS BLOB)) > 0
                     AND length(CAST(agent_sdk_model_id AS BLOB)) <= {MAX_PROFILE_SDK_MODEL_BYTES}
                 )
             )"
        ),
        "runtime model profile agent_sdk_model_id",
    )?;

    connection
        .execute(
            "CREATE INDEX IF NOT EXISTS runtime_model_profiles_kind_idx
             ON runtime_model_profiles(kind, enabled, provider_id, model_id)",
            [],
        )
        .map_err(|err| format!("Failed to initialize runtime model profiles kind index: {err}"))?;
    connection
        .execute(
            "CREATE INDEX IF NOT EXISTS runtime_model_profiles_status_idx
             ON runtime_model_profiles(capability_status, updated_at_ms, profile_id)",
            [],
        )
        .map_err(|err| {
            format!("Failed to initialize runtime model profiles status index: {err}")
        })?;
    connection
        .execute(
            "CREATE INDEX IF NOT EXISTS runtime_model_profiles_visible_idx
             ON runtime_model_profiles(deleted_at_ms, kind, enabled, updated_at_ms, profile_id)",
            [],
        )
        .map_err(|err| {
            format!("Failed to initialize runtime model profiles visibility index: {err}")
        })?;

    record_migration_family(connection, PROFILE_STATUS_FAMILY, PROFILE_STATUS_VERSION)
}

fn initialize_profile_pool_schema(connection: &Connection) -> Result<(), String> {
    connection
        .execute(
            &format!(
                "CREATE TABLE IF NOT EXISTS runtime_profile_claims (
                    claim_id TEXT PRIMARY KEY CHECK(
                        length(CAST(claim_id AS BLOB)) > 0
                        AND length(CAST(claim_id AS BLOB)) <= {MAX_PROFILE_ID_BYTES}
                    ),
                    profile_id TEXT NOT NULL CHECK(
                        length(CAST(profile_id AS BLOB)) > 0
                        AND length(CAST(profile_id AS BLOB)) <= {MAX_PROFILE_ID_BYTES}
                    ),
                    kind TEXT NOT NULL CHECK(kind IN ('model-call', 'agent-run')),
                    task_family TEXT NOT NULL CHECK(
                        length(CAST(task_family AS BLOB)) > 0
                        AND length(CAST(task_family AS BLOB)) <= {MAX_PROFILE_TASK_FAMILY_BYTES}
                    ),
                    job_id TEXT,
                    holder TEXT NOT NULL CHECK(length(CAST(holder AS BLOB)) > 0),
                    acquired_at_ms INTEGER NOT NULL CHECK(acquired_at_ms >= 0),
                    expires_at_ms INTEGER NOT NULL CHECK(expires_at_ms >= 0),
                    released_at_ms INTEGER CHECK(released_at_ms IS NULL OR released_at_ms >= 0),
                    status TEXT NOT NULL CHECK(status IN ('active', 'released', 'expired')),
                    FOREIGN KEY(profile_id) REFERENCES runtime_model_profiles(profile_id),
                    FOREIGN KEY(job_id) REFERENCES runtime_jobs(job_id)
                )"
            ),
            [],
        )
        .map_err(|err| format!("Failed to initialize runtime profile claims table: {err}"))?;

    connection
        .execute(
            &format!(
                "CREATE TABLE IF NOT EXISTS runtime_profile_circuit_breakers (
                    profile_id TEXT PRIMARY KEY CHECK(
                        length(CAST(profile_id AS BLOB)) > 0
                        AND length(CAST(profile_id AS BLOB)) <= {MAX_PROFILE_ID_BYTES}
                    ),
                    status TEXT NOT NULL CHECK(status IN ('rate-limited', 'error')),
                    reason TEXT CHECK(
                        reason IS NULL
                        OR length(CAST(reason AS BLOB)) <= {MAX_PROFILE_POOL_REASON_BYTES}
                    ),
                    error TEXT CHECK(
                        error IS NULL
                        OR length(CAST(error AS BLOB)) <= {MAX_PROFILE_POOL_REASON_BYTES}
                    ),
                    opened_at_ms INTEGER NOT NULL CHECK(opened_at_ms >= 0),
                    open_until_ms INTEGER NOT NULL CHECK(open_until_ms >= 0),
                    updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= 0),
                    FOREIGN KEY(profile_id) REFERENCES runtime_model_profiles(profile_id)
                )"
            ),
            [],
        )
        .map_err(|err| {
            format!("Failed to initialize runtime profile circuit breakers table: {err}")
        })?;

    connection
        .execute(
            "CREATE INDEX IF NOT EXISTS runtime_profile_claims_active_idx
             ON runtime_profile_claims(profile_id, status, expires_at_ms)",
            [],
        )
        .map_err(|err| format!("Failed to initialize runtime profile active claim index: {err}"))?;
    connection
        .execute(
            "CREATE INDEX IF NOT EXISTS runtime_profile_claims_job_idx
             ON runtime_profile_claims(job_id, status)",
            [],
        )
        .map_err(|err| format!("Failed to initialize runtime profile claim job index: {err}"))?;
    connection
        .execute(
            "CREATE INDEX IF NOT EXISTS runtime_profile_breakers_open_idx
             ON runtime_profile_circuit_breakers(open_until_ms, profile_id)",
            [],
        )
        .map_err(|err| format!("Failed to initialize runtime profile breaker index: {err}"))?;

    record_migration_family(connection, PROFILE_POOL_FAMILY, PROFILE_POOL_VERSION)
}

fn record_migration_family(
    connection: &Connection,
    family: &str,
    version: i64,
) -> Result<(), String> {
    connection
        .execute(
            "INSERT OR IGNORE INTO runtime_schema_migrations (
                family,
                version,
                applied_at_ms
            ) VALUES (?1, ?2, ?3)",
            params![family, version, now_ms()?],
        )
        .map_err(|err| format!("Failed to record runtime migration family '{family}': {err}"))?;
    Ok(())
}

fn runtime_job_create_for_project(
    project_root: Option<&Path>,
    enabled: bool,
    request: RuntimeJobCreateRequest,
    now: i64,
) -> Result<RuntimeJobRecord, String> {
    let project_root = require_enabled_project(project_root, enabled)?;
    with_runtime_writer(|| {
        let connection = open_job_runtime_locked(project_root)?;
        let job_id = request.job_id.unwrap_or_else(|| Uuid::new_v4().to_string());
        connection
            .execute(
                "INSERT INTO runtime_jobs (
                    job_id,
                    kind,
                    payload,
                    state,
                    attempt,
                    max_attempts,
                    priority,
                    created_at_ms,
                    updated_at_ms,
                    queued_at_ms
                ) VALUES (?1, ?2, ?3, 'queued', 0, ?4, ?5, ?6, ?6, ?6)",
                params![
                    &job_id,
                    require_non_empty("invalid-kind", "kind", &request.kind)?,
                    require_non_empty("invalid-payload", "payload", &request.payload)?,
                    request.max_attempts.unwrap_or(DEFAULT_MAX_ATTEMPTS).max(1),
                    request.priority.unwrap_or(DEFAULT_PRIORITY),
                    now
                ],
            )
            .map_err(|err| format!("job-create-failed: {err}"))?;
        read_job(&connection, &job_id)
    })
}

fn runtime_job_claim_for_project(
    project_root: Option<&Path>,
    enabled: bool,
    request: RuntimeJobClaimRequest,
    now: i64,
) -> Result<RuntimeJobClaim, String> {
    runtime_job_claim_matching_kind_for_project(project_root, enabled, request, None, now)
}

fn runtime_job_claim_by_kind_for_project(
    project_root: Option<&Path>,
    enabled: bool,
    request: RuntimeJobClaimByKindRequest,
    now: i64,
) -> Result<RuntimeJobClaim, String> {
    let kind = require_non_empty("invalid-kind", "kind", &request.kind)?.to_string();
    runtime_job_claim_matching_kind_for_project(
        project_root,
        enabled,
        RuntimeJobClaimRequest {
            holder: request.holder,
            lease_id: request.lease_id,
        },
        Some(kind),
        now,
    )
}

fn runtime_job_claim_matching_kind_for_project(
    project_root: Option<&Path>,
    enabled: bool,
    request: RuntimeJobClaimRequest,
    kind_filter: Option<String>,
    now: i64,
) -> Result<RuntimeJobClaim, String> {
    let project_root = require_enabled_project(project_root, enabled)?;
    with_runtime_writer(|| {
        let mut connection = open_job_runtime_locked(project_root)?;
        let tx = connection.transaction().map_err(tx_err)?;
        let job_id = select_queued_job_id_tx(&tx, kind_filter.as_deref())?;

        ensure_no_active_lease(&tx, &job_id)?;
        tx.execute(
            "UPDATE runtime_jobs
             SET state = 'running',
                 attempt = attempt + 1,
                 started_at_ms = COALESCE(started_at_ms, ?2),
                 updated_at_ms = ?2
             WHERE job_id = ?1 AND state = 'queued'",
            params![job_id, now],
        )
        .map_err(|err| format!("job-claim-update-failed: {err}"))?;

        let lease_id = request
            .lease_id
            .unwrap_or_else(|| Uuid::new_v4().to_string());
        tx.execute(
            "INSERT INTO runtime_job_leases (
                lease_id,
                job_id,
                holder,
                acquired_at_ms,
                heartbeat_at_ms,
                expires_at_ms,
                status
            ) VALUES (?1, ?2, ?3, ?4, ?4, ?5, 'active')",
            params![
                lease_id,
                job_id,
                require_non_empty("invalid-holder", "holder", &request.holder)?,
                now,
                now + DEFAULT_LEASE_TTL_MS
            ],
        )
        .map_err(|err| format!("job-claim-lease-failed: {err}"))?;

        let job = read_job_tx(&tx, &job_id)?;
        let lease = read_lease_tx(&tx, &lease_id)?;
        tx.commit().map_err(tx_err)?;
        Ok(RuntimeJobClaim { job, lease })
    })
}

fn select_queued_job_id_tx(
    tx: &Transaction<'_>,
    kind_filter: Option<&str>,
) -> Result<String, String> {
    let mut sql = String::from(
        "SELECT job_id
         FROM runtime_jobs
         WHERE state = 'queued'",
    );
    let kind_value = kind_filter.map(str::to_string);
    let mut sql_params: Vec<&dyn ToSql> = Vec::new();
    if let Some(kind) = kind_value.as_ref() {
        sql.push_str(" AND kind = ?1");
        sql_params.push(kind);
    }
    sql.push_str(
        " ORDER BY priority DESC, queued_at_ms ASC, created_at_ms ASC
          LIMIT 1",
    );
    let result = tx
        .query_row(&sql, params_from_iter(sql_params), |row| row.get(0))
        .optional()
        .map_err(|err| format!("job-claim-select-failed: {err}"))?;
    result.ok_or_else(|| "no-queued-job: no queued runtime job is available".to_string())
}

fn runtime_job_heartbeat_for_project(
    project_root: Option<&Path>,
    enabled: bool,
    request: RuntimeJobLeaseRequest,
    now: i64,
) -> Result<RuntimeJobClaim, String> {
    let project_root = require_enabled_project(project_root, enabled)?;
    with_runtime_writer(|| {
        let mut connection = open_job_runtime_locked(project_root)?;
        let tx = connection.transaction().map_err(tx_err)?;
        ensure_active_running_lease(&tx, &request.job_id, &request.lease_id, Some(now))?;
        let existing_lease = read_lease_tx(&tx, &request.lease_id)?;
        let within_min_interval =
            now.saturating_sub(existing_lease.heartbeat_at_ms) < DEFAULT_HEARTBEAT_MIN_INTERVAL_MS;
        let has_safe_expiry_margin =
            existing_lease.expires_at_ms.saturating_sub(now) >= DEFAULT_HEARTBEAT_MIN_INTERVAL_MS;
        if within_min_interval && has_safe_expiry_margin {
            let job = read_job_tx(&tx, &request.job_id)?;
            tx.commit().map_err(tx_err)?;
            return Ok(RuntimeJobClaim {
                job,
                lease: existing_lease,
            });
        }
        tx.execute(
            "UPDATE runtime_job_leases
             SET heartbeat_at_ms = ?3,
                 expires_at_ms = ?4
             WHERE job_id = ?1 AND lease_id = ?2 AND status = 'active'",
            params![
                request.job_id,
                request.lease_id,
                now,
                now + DEFAULT_LEASE_TTL_MS
            ],
        )
        .map_err(|err| format!("job-heartbeat-failed: {err}"))?;
        tx.execute(
            "UPDATE runtime_jobs SET updated_at_ms = ?2 WHERE job_id = ?1",
            params![request.job_id, now],
        )
        .map_err(|err| format!("job-heartbeat-update-failed: {err}"))?;
        let job = read_job_tx(&tx, &request.job_id)?;
        let lease = read_lease_tx(&tx, &request.lease_id)?;
        tx.commit().map_err(tx_err)?;
        Ok(RuntimeJobClaim { job, lease })
    })
}

fn runtime_job_complete_for_project(
    project_root: Option<&Path>,
    enabled: bool,
    request: RuntimeJobLeaseRequest,
    now: i64,
) -> Result<RuntimeJobRecord, String> {
    terminal_running_operation(
        project_root,
        enabled,
        &request.job_id,
        &request.lease_id,
        now,
        |tx| {
            tx.execute(
                "UPDATE runtime_jobs
                 SET state = 'completed',
                     completed_at_ms = ?2,
                     updated_at_ms = ?2
                 WHERE job_id = ?1",
                params![request.job_id, now],
            )
            .map_err(|err| format!("job-complete-failed: {err}"))
        },
    )
}

fn runtime_job_fail_for_project(
    project_root: Option<&Path>,
    enabled: bool,
    request: RuntimeJobFailRequest,
    now: i64,
) -> Result<RuntimeJobRecord, String> {
    let project_root = require_enabled_project(project_root, enabled)?;
    with_runtime_writer(|| {
        let mut connection = open_job_runtime_locked(project_root)?;
        let tx = connection.transaction().map_err(tx_err)?;
        ensure_active_running_lease(&tx, &request.job_id, &request.lease_id, Some(now))?;
        let job = read_job_tx(&tx, &request.job_id)?;
        let retry_remaining = job.attempt < job.max_attempts;
        let next_state = if retry_remaining {
            "retry-wait"
        } else {
            "failed"
        };
        let retry_after_ms = retry_remaining.then_some(
            request
                .retry_after_ms
                .unwrap_or_else(|| now + DEFAULT_RETRY_BACKOFF_MS),
        );
        tx.execute(
            "UPDATE runtime_jobs
             SET state = ?2,
                 failed_at_ms = CASE WHEN ?2 = 'failed' THEN ?3 ELSE failed_at_ms END,
                 retry_after_ms = ?4,
                 last_error = ?5,
                 updated_at_ms = ?3
             WHERE job_id = ?1",
            params![
                request.job_id,
                next_state,
                now,
                retry_after_ms,
                request.error
            ],
        )
        .map_err(|err| format!("job-fail-update-failed: {err}"))?;
        release_lease(
            &tx,
            &request.job_id,
            &request.lease_id,
            RELEASED_LEASE_STATUS,
            now,
        )?;
        let job = read_job_tx(&tx, &request.job_id)?;
        tx.commit().map_err(tx_err)?;
        Ok(job)
    })
}

fn runtime_job_retry_for_project(
    project_root: Option<&Path>,
    enabled: bool,
    request: RuntimeJobRetryRequest,
    now: i64,
) -> Result<RuntimeJobRecord, String> {
    let project_root = require_enabled_project(project_root, enabled)?;
    with_runtime_writer(|| {
        let mut connection = open_job_runtime_locked(project_root)?;
        let tx = connection.transaction().map_err(tx_err)?;
        let job = read_job_tx(&tx, &request.job_id)?;
        if !matches!(job.state.as_str(), "failed" | "retry-wait") {
            return Err(format!(
                "invalid-transition: retry is not allowed from '{}'",
                job.state
            ));
        }
        if job.attempt >= job.max_attempts {
            return Err("retry-limit-exhausted: retry max is exhausted".to_string());
        }
        if job.state == "retry-wait" {
            let Some(retry_after) = job.retry_after_ms else {
                return Err("retry-not-ready: retry-wait job has no retry_after_ms".to_string());
            };
            if retry_after > now {
                return Err("retry-not-ready: retry-wait job is not eligible yet".to_string());
            }
        }
        tx.execute(
            "UPDATE runtime_jobs
             SET state = 'queued',
                 queued_at_ms = ?2,
                 retry_after_ms = NULL,
                 updated_at_ms = ?2
             WHERE job_id = ?1",
            params![request.job_id, now],
        )
        .map_err(|err| format!("job-retry-failed: {err}"))?;
        let job = read_job_tx(&tx, &request.job_id)?;
        tx.commit().map_err(tx_err)?;
        Ok(job)
    })
}

fn runtime_job_cancel_for_project(
    project_root: Option<&Path>,
    enabled: bool,
    request: RuntimeJobCancelRequest,
    now: i64,
) -> Result<RuntimeJobRecord, String> {
    let project_root = require_enabled_project(project_root, enabled)?;
    with_runtime_writer(|| {
        let mut connection = open_job_runtime_locked(project_root)?;
        let tx = connection.transaction().map_err(tx_err)?;
        let job = read_job_tx(&tx, &request.job_id)?;
        if !matches!(
            job.state.as_str(),
            "queued" | "running" | "paused" | "retry-wait"
        ) {
            return Err(format!(
                "invalid-transition: cancel is not allowed from '{}'",
                job.state
            ));
        }
        tx.execute(
            "UPDATE runtime_jobs
             SET state = 'cancelled',
                 cancelled_at_ms = ?2,
                 updated_at_ms = ?2
             WHERE job_id = ?1",
            params![request.job_id, now],
        )
        .map_err(|err| format!("job-cancel-failed: {err}"))?;
        tx.execute(
            "UPDATE runtime_job_leases
             SET status = ?2,
                 released_at_ms = ?3
             WHERE job_id = ?1 AND status = 'active'",
            params![request.job_id, CANCELLED_LEASE_STATUS, now],
        )
        .map_err(|err| format!("job-cancel-lease-failed: {err}"))?;
        let job = read_job_tx(&tx, &request.job_id)?;
        tx.commit().map_err(tx_err)?;
        Ok(job)
    })
}

fn runtime_job_pause_for_project(
    project_root: Option<&Path>,
    enabled: bool,
    request: RuntimeJobPauseRequest,
    now: i64,
) -> Result<RuntimeJobRecord, String> {
    let project_root = require_enabled_project(project_root, enabled)?;
    with_runtime_writer(|| {
        let mut connection = open_job_runtime_locked(project_root)?;
        let tx = connection.transaction().map_err(tx_err)?;
        let job = read_job_tx(&tx, &request.job_id)?;
        if !matches!(job.state.as_str(), "queued" | "running") {
            return Err(format!(
                "invalid-transition: pause is not allowed from '{}'",
                job.state
            ));
        }
        tx.execute(
            "UPDATE runtime_jobs
             SET state = 'paused',
                 updated_at_ms = ?2
             WHERE job_id = ?1",
            params![request.job_id, now],
        )
        .map_err(|err| format!("job-pause-failed: {err}"))?;
        if job.state == "running" {
            tx.execute(
                "UPDATE runtime_job_leases
                 SET status = ?2,
                     released_at_ms = ?3
                 WHERE job_id = ?1 AND status = 'active'",
                params![request.job_id, CANCELLED_LEASE_STATUS, now],
            )
            .map_err(|err| format!("job-pause-lease-failed: {err}"))?;
        }
        let job = read_job_tx(&tx, &request.job_id)?;
        tx.commit().map_err(tx_err)?;
        Ok(job)
    })
}

fn runtime_job_resume_for_project(
    project_root: Option<&Path>,
    enabled: bool,
    request: RuntimeJobResumeRequest,
    now: i64,
) -> Result<RuntimeJobRecord, String> {
    let project_root = require_enabled_project(project_root, enabled)?;
    with_runtime_writer(|| {
        let mut connection = open_job_runtime_locked(project_root)?;
        let tx = connection.transaction().map_err(tx_err)?;
        let job = read_job_tx(&tx, &request.job_id)?;
        if job.state != "paused" {
            return Err(format!(
                "invalid-transition: resume is not allowed from '{}'",
                job.state
            ));
        }
        tx.execute(
            "UPDATE runtime_jobs
             SET state = 'queued',
                 queued_at_ms = ?2,
                 updated_at_ms = ?2
             WHERE job_id = ?1",
            params![request.job_id, now],
        )
        .map_err(|err| format!("job-resume-failed: {err}"))?;
        let job = read_job_tx(&tx, &request.job_id)?;
        tx.commit().map_err(tx_err)?;
        Ok(job)
    })
}

fn runtime_job_list_for_project(
    project_root: Option<&Path>,
    enabled: bool,
) -> Result<RuntimeJobList, String> {
    if !enabled {
        return Ok(RuntimeJobList {
            enabled: false,
            status: RuntimeDbHealthState::Disabled,
            jobs: Vec::new(),
            leases: Vec::new(),
        });
    }
    let Some(project_root) = project_root else {
        return Ok(RuntimeJobList {
            enabled: true,
            status: RuntimeDbHealthState::NoProject,
            jobs: Vec::new(),
            leases: Vec::new(),
        });
    };
    let db_path = runtime_db_path(project_root);
    if !db_path.exists() {
        return Ok(RuntimeJobList {
            enabled: true,
            status: RuntimeDbHealthState::Healthy,
            jobs: Vec::new(),
            leases: Vec::new(),
        });
    }
    let connection = Connection::open_with_flags(
        db_path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|err| format!("job-list-open-failed: {err}"))?;
    if !table_exists(&connection, "runtime_jobs")?
        || !table_exists(&connection, "runtime_job_leases")?
    {
        return Ok(RuntimeJobList {
            enabled: true,
            status: RuntimeDbHealthState::Healthy,
            jobs: Vec::new(),
            leases: Vec::new(),
        });
    }
    Ok(RuntimeJobList {
        enabled: true,
        status: RuntimeDbHealthState::Healthy,
        jobs: read_jobs(&connection)?,
        leases: read_leases(&connection)?,
    })
}

fn runtime_profile_create_for_project(
    project_root: Option<&Path>,
    enabled: bool,
    request: RuntimeProfileCreateRequest,
    now: i64,
) -> Result<RuntimeProfileRecord, String> {
    let project_root = require_enabled_project(project_root, enabled)?;
    let profile_id = match request.profile_id {
        Some(profile_id) => normalize_profile_text(
            "invalid-profile-id",
            "profileId",
            &profile_id,
            MAX_PROFILE_ID_BYTES,
        )?,
        None => Uuid::new_v4().to_string(),
    };
    let kind = normalize_profile_kind(&request.kind)?;
    let display_name = normalize_profile_text(
        "invalid-display-name",
        "displayName",
        &request.display_name,
        MAX_PROFILE_DISPLAY_NAME_BYTES,
    )?;
    let provider_id = normalize_profile_text(
        "invalid-provider-id",
        "providerId",
        &request.provider_id,
        MAX_PROFILE_PROVIDER_BYTES,
    )?;
    let model_id = normalize_profile_text(
        "invalid-model-id",
        "modelId",
        &request.model_id,
        MAX_PROFILE_MODEL_BYTES,
    )?;
    let agent_sdk_model_id = normalize_optional_profile_text(
        request.agent_sdk_model_id,
        "invalid-agent-sdk-model-id",
        "agentSdkModelId",
        MAX_PROFILE_SDK_MODEL_BYTES,
    )?;
    let endpoint = normalize_optional_profile_text(
        request.endpoint,
        "invalid-endpoint",
        "endpoint",
        MAX_PROFILE_ENDPOINT_BYTES,
    )?;
    let api_mode = normalize_profile_api_mode(&request.api_mode)?;
    let auth_style = normalize_profile_auth_style(&request.auth_style)?;
    let secret_ref = normalize_profile_secret_ref(request.secret_ref)?;
    let task_families = normalize_profile_task_families(request.task_families)?;
    let task_families_json = serialize_profile_task_families(&task_families)?;
    let max_concurrency = normalize_profile_concurrency(request.max_concurrency)?;

    with_runtime_writer(|| {
        let connection = open_profile_runtime_locked(project_root)?;
        connection
            .execute(
                "INSERT INTO runtime_model_profiles (
                    profile_id,
                    kind,
                    display_name,
                    provider_id,
                    model_id,
                    agent_sdk_model_id,
                    endpoint,
                    api_mode,
                    auth_style,
                    secret_ref,
                    enabled,
                    task_families_json,
                    max_concurrency,
                    capability_status,
                    capability_json,
                    capability_version,
                    capability_checked_at_ms,
                    probe_backoff_until_ms,
                    last_capability_error,
                    created_at_ms,
                    updated_at_ms
                ) VALUES (
                    ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10,
                    ?11, ?12, ?13, ?14, ?15, ?16, NULL, NULL, NULL, ?17, ?17
                )",
                params![
                    profile_id,
                    kind,
                    display_name,
                    provider_id,
                    model_id,
                    agent_sdk_model_id,
                    endpoint,
                    api_mode,
                    auth_style,
                    secret_ref,
                    bool_to_i64(request.enabled.unwrap_or(true)),
                    task_families_json,
                    max_concurrency,
                    DEFAULT_PROFILE_STATUS,
                    DEFAULT_PROFILE_CAPABILITY_JSON,
                    DEFAULT_PROFILE_CAPABILITY_VERSION,
                    now
                ],
            )
            .map_err(|err| format!("profile-create-failed: {err}"))?;
        read_profile(&connection, &profile_id)
    })
}

fn runtime_profile_update_for_project(
    project_root: Option<&Path>,
    enabled: bool,
    request: RuntimeProfileUpdateRequest,
    now: i64,
) -> Result<RuntimeProfileRecord, String> {
    let project_root = require_enabled_project(project_root, enabled)?;
    let profile_id = normalize_profile_text(
        "invalid-profile-id",
        "profileId",
        &request.profile_id,
        MAX_PROFILE_ID_BYTES,
    )?;

    with_runtime_writer(|| {
        let mut connection = open_profile_runtime_locked(project_root)?;
        let tx = connection.transaction().map_err(tx_err)?;
        let existing = read_visible_profile_tx(&tx, &profile_id)?;
        let display_name = normalize_profile_text_update(
            request.display_name,
            existing.display_name,
            "invalid-display-name",
            "displayName",
            MAX_PROFILE_DISPLAY_NAME_BYTES,
        )?;
        let provider_id = normalize_profile_text_update(
            request.provider_id,
            existing.provider_id,
            "invalid-provider-id",
            "providerId",
            MAX_PROFILE_PROVIDER_BYTES,
        )?;
        let model_id = normalize_profile_text_update(
            request.model_id,
            existing.model_id,
            "invalid-model-id",
            "modelId",
            MAX_PROFILE_MODEL_BYTES,
        )?;
        let agent_sdk_model_id = if request.clear_agent_sdk_model_id.unwrap_or(false) {
            None
        } else {
            normalize_optional_profile_text(
                request.agent_sdk_model_id,
                "invalid-agent-sdk-model-id",
                "agentSdkModelId",
                MAX_PROFILE_SDK_MODEL_BYTES,
            )?
            .or(existing.agent_sdk_model_id)
        };
        let endpoint = if request.clear_endpoint.unwrap_or(false) {
            None
        } else {
            normalize_optional_profile_text(
                request.endpoint,
                "invalid-endpoint",
                "endpoint",
                MAX_PROFILE_ENDPOINT_BYTES,
            )?
            .or(existing.endpoint)
        };
        let api_mode = normalize_profile_enum_update(
            request.api_mode,
            existing.api_mode,
            normalize_profile_api_mode,
        )?;
        let auth_style = normalize_profile_enum_update(
            request.auth_style,
            existing.auth_style,
            normalize_profile_auth_style,
        )?;
        let secret_ref = if request.clear_secret_ref.unwrap_or(false) {
            None
        } else {
            normalize_profile_secret_ref(request.secret_ref)?.or(existing.secret_ref)
        };
        let task_families_json = match request.task_families {
            Some(value) => {
                serialize_profile_task_families(&normalize_profile_task_families(value)?)?
            }
            None => serialize_profile_task_families(&existing.task_families)?,
        };
        let max_concurrency = match request.max_concurrency {
            Some(value) => normalize_profile_concurrency(Some(value))?,
            None => existing.max_concurrency,
        };
        let capability_status = normalize_profile_enum_update(
            request.capability_status,
            existing.capability_status,
            normalize_profile_capability_status,
        )?;
        let capability_json = normalize_profile_json_update(
            request.capability_json,
            existing.capability_json,
            "invalid-capability-json",
            "capabilityJson",
            MAX_PROFILE_CAPABILITY_JSON_BYTES,
        )?;
        let capability_version = normalize_profile_text_update(
            request.capability_version,
            existing.capability_version,
            "invalid-capability-version",
            "capabilityVersion",
            MAX_PROFILE_CAPABILITY_VERSION_BYTES,
        )?;
        let capability_checked_at_ms = normalize_profile_ms_update(
            request.capability_checked_at_ms,
            existing.capability_checked_at_ms,
            "invalid-capability-checked-at",
            "capabilityCheckedAtMs",
        )?;
        let probe_backoff_until_ms = normalize_profile_ms_update(
            request.probe_backoff_until_ms,
            existing.probe_backoff_until_ms,
            "invalid-probe-backoff",
            "probeBackoffUntilMs",
        )?;
        let last_capability_error = if request.clear_last_capability_error.unwrap_or(false) {
            None
        } else {
            normalize_optional_profile_text(
                request.last_capability_error,
                "invalid-capability-error",
                "lastCapabilityError",
                MAX_PROFILE_CAPABILITY_ERROR_BYTES,
            )?
            .or(existing.last_capability_error)
        };

        tx.execute(
            "UPDATE runtime_model_profiles
             SET display_name = ?2,
                 provider_id = ?3,
                 model_id = ?4,
                 agent_sdk_model_id = ?5,
                 endpoint = ?6,
                 api_mode = ?7,
                 auth_style = ?8,
                 secret_ref = ?9,
                 enabled = ?10,
                 task_families_json = ?11,
                 max_concurrency = ?12,
                 capability_status = ?13,
                 capability_json = ?14,
                 capability_version = ?15,
                 capability_checked_at_ms = ?16,
                 probe_backoff_until_ms = ?17,
                 last_capability_error = ?18,
                 updated_at_ms = ?19
             WHERE profile_id = ?1",
            params![
                profile_id,
                display_name,
                provider_id,
                model_id,
                agent_sdk_model_id,
                endpoint,
                api_mode,
                auth_style,
                secret_ref,
                bool_to_i64(request.enabled.unwrap_or(existing.enabled)),
                task_families_json,
                max_concurrency,
                capability_status,
                capability_json,
                capability_version,
                capability_checked_at_ms,
                probe_backoff_until_ms,
                last_capability_error,
                now
            ],
        )
        .map_err(|err| format!("profile-update-failed: {err}"))?;
        let profile = read_visible_profile_tx(&tx, &profile_id)?;
        tx.commit().map_err(tx_err)?;
        Ok(profile)
    })
}

fn runtime_profile_delete_for_project(
    project_root: Option<&Path>,
    enabled: bool,
    request: RuntimeProfileDeleteRequest,
    now: i64,
) -> Result<RuntimeProfileDeleteResult, String> {
    let project_root = require_enabled_project(project_root, enabled)?;
    let profile_id = normalize_profile_text(
        "invalid-profile-id",
        "profileId",
        &request.profile_id,
        MAX_PROFILE_ID_BYTES,
    )?;

    with_runtime_writer(|| {
        let mut connection = open_profile_pool_runtime_locked(project_root)?;
        let tx = connection.transaction().map_err(tx_err)?;
        expire_profile_claims_tx(&tx, now)?;
        let secret_ref = read_visible_profile_secret_ref_tx(&tx, &profile_id)?;
        let active_claims = active_profile_claim_count_tx(&tx, &profile_id, now)?;
        if active_claims > 0 {
            return Err("profile-delete-blocked: active profile claim exists".to_string());
        }
        let changed = tx
            .execute(
                "UPDATE runtime_model_profiles
                 SET deleted_at_ms = ?2,
                     updated_at_ms = ?2
                 WHERE profile_id = ?1 AND deleted_at_ms IS NULL",
                params![profile_id, now],
            )
            .map_err(|err| format!("profile-delete-failed: {err}"))?;
        if changed == 0 {
            return Err("profile-not-found: runtime model profile does not exist".to_string());
        }
        tx.commit().map_err(tx_err)?;
        Ok(RuntimeProfileDeleteResult {
            profile_id,
            deleted_at_ms: now,
            secret_ref,
        })
    })
}

fn runtime_profile_list_for_project(
    project_root: Option<&Path>,
    enabled: bool,
) -> Result<RuntimeProfileList, String> {
    if !enabled {
        return Ok(RuntimeProfileList {
            enabled: false,
            status: RuntimeDbHealthState::Disabled,
            profiles: Vec::new(),
        });
    }
    let Some(project_root) = project_root else {
        return Ok(RuntimeProfileList {
            enabled: true,
            status: RuntimeDbHealthState::NoProject,
            profiles: Vec::new(),
        });
    };
    let db_path = runtime_db_path(project_root);
    if !db_path.exists() {
        return Ok(RuntimeProfileList {
            enabled: true,
            status: RuntimeDbHealthState::Healthy,
            profiles: Vec::new(),
        });
    }
    let connection = Connection::open_with_flags(
        db_path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|err| format!("profile-list-open-failed: {err}"))?;
    if !table_exists(&connection, "runtime_model_profiles")? {
        return Ok(RuntimeProfileList {
            enabled: true,
            status: RuntimeDbHealthState::Healthy,
            profiles: Vec::new(),
        });
    }
    Ok(RuntimeProfileList {
        enabled: true,
        status: RuntimeDbHealthState::Healthy,
        profiles: read_visible_profiles(&connection)?,
    })
}

fn runtime_profile_status_for_project(
    project_root: Option<&Path>,
    enabled: bool,
    request: RuntimeProfileStatusRequest,
) -> Result<RuntimeProfileRecord, String> {
    let project_root = require_enabled_project(project_root, enabled)?;
    let profile_id = normalize_profile_text(
        "invalid-profile-id",
        "profileId",
        &request.profile_id,
        MAX_PROFILE_ID_BYTES,
    )?;
    let db_path = runtime_db_path(project_root);
    if !db_path.exists() {
        return Err("profile-not-found: runtime model profile does not exist".to_string());
    }
    let connection = Connection::open_with_flags(
        db_path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|err| format!("profile-status-open-failed: {err}"))?;
    if !table_exists(&connection, "runtime_model_profiles")? {
        return Err("profile-not-found: runtime model profile does not exist".to_string());
    }
    read_visible_profile(&connection, &profile_id)
}

fn runtime_profile_pool_claim_for_project(
    project_root: Option<&Path>,
    enabled: bool,
    request: RuntimeProfilePoolClaimRequest,
    now: i64,
) -> Result<RuntimeProfilePoolClaim, String> {
    let project_root = require_enabled_project(project_root, enabled)?;
    let kind = normalize_profile_kind(&request.kind)?.to_string();
    let task_family = normalize_profile_text(
        "invalid-task-family",
        "taskFamily",
        &request.task_family,
        MAX_PROFILE_TASK_FAMILY_BYTES,
    )?;
    let holder = normalize_profile_text(
        "invalid-holder",
        "holder",
        &request.holder,
        MAX_PROFILE_DISPLAY_NAME_BYTES,
    )?;
    let claim_id = match request.claim_id {
        Some(claim_id) => normalize_profile_text(
            "invalid-claim-id",
            "claimId",
            &claim_id,
            MAX_PROFILE_ID_BYTES,
        )?,
        None => Uuid::new_v4().to_string(),
    };
    let job_id = normalize_optional_filter("invalid-job-id", "jobId", request.job_id)?;
    let ttl_ms = normalize_profile_pool_ttl(request.ttl_ms)?;
    let expires_at_ms = checked_profile_pool_deadline(now, ttl_ms, "invalid-ttl")?;
    let preferred_profile_ids = normalize_preferred_profile_ids(request.preferred_profile_ids)?;

    with_runtime_writer(|| {
        let mut connection = open_profile_pool_runtime_locked(project_root)?;
        let tx = connection.transaction().map_err(tx_err)?;
        ensure_profile_claim_id_available_tx(&tx, &claim_id)?;
        if let Some(job_id) = job_id.as_deref() {
            ensure_job_exists(&tx, job_id)?;
        }
        expire_profile_claims_tx(&tx, now)?;

        let profiles = read_visible_profiles_tx(&tx)?;
        let mut eligible = Vec::new();
        for profile in profiles {
            if profile_pool_profile_eligible(&tx, &profile, &kind, &task_family, now)? {
                eligible.push(profile);
            }
        }
        let selected = select_profile_pool_candidate(&eligible, &preferred_profile_ids)
            .ok_or_else(|| {
                "no-eligible-profile: no profile pool capacity is available".to_string()
            })?;

        tx.execute(
            "INSERT INTO runtime_profile_claims (
                claim_id,
                profile_id,
                kind,
                task_family,
                job_id,
                holder,
                acquired_at_ms,
                expires_at_ms,
                status
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                claim_id,
                selected.profile_id,
                kind,
                task_family,
                job_id,
                holder,
                now,
                expires_at_ms,
                ACTIVE_CLAIM_STATUS
            ],
        )
        .map_err(|err| format!("profile-pool-claim-insert-failed: {err}"))?;

        let event_id = if let Some(job_id) = job_id.as_deref() {
            let payload = profile_pool_claim_event_payload(
                &claim_id,
                &selected.profile_id,
                &kind,
                &task_family,
                &holder,
                expires_at_ms,
            )?;
            Some(insert_runtime_event_tx(
                &tx,
                None,
                job_id,
                PROFILE_POOL_CLAIMED_NAME,
                &payload,
                now,
            )?)
        } else {
            None
        };
        if let Some(job_id) = job_id.as_deref() {
            let payload = profile_pool_progress_payload(
                &claim_id,
                &selected.profile_id,
                "claimed",
                expires_at_ms,
                None,
            )?;
            upsert_runtime_progress_tx(
                &tx,
                job_id,
                &profile_pool_progress_key(&claim_id),
                &payload,
                now,
                event_id.as_deref(),
            )?;
        }

        let claim = read_profile_claim_tx(&tx, &claim_id)?;
        tx.commit().map_err(tx_err)?;
        Ok(RuntimeProfilePoolClaim {
            claim_id,
            profile_id: selected.profile_id.clone(),
            expires_at_ms,
            claim,
        })
    })
}

fn runtime_profile_pool_release_for_project(
    project_root: Option<&Path>,
    enabled: bool,
    request: RuntimeProfilePoolReleaseRequest,
    now: i64,
) -> Result<RuntimeProfilePoolRelease, String> {
    let project_root = require_enabled_project(project_root, enabled)?;
    let claim_id = normalize_profile_text(
        "invalid-claim-id",
        "claimId",
        &request.claim_id,
        MAX_PROFILE_ID_BYTES,
    )?;
    let outcome = normalize_profile_pool_outcome(&request.outcome)?;
    let retry_after_ms = request
        .retry_after_ms
        .map(|value| {
            normalize_profile_pool_breaker_duration("invalid-retry-after", "retryAfterMs", value)
        })
        .transpose()?;
    let circuit_open_ms = request
        .circuit_open_ms
        .map(|value| {
            normalize_profile_pool_breaker_duration("invalid-circuit-open", "circuitOpenMs", value)
        })
        .transpose()?;
    let reason = sanitize_profile_pool_optional_text(request.reason)?;
    let error = sanitize_profile_pool_optional_text(request.error)?;

    with_runtime_writer(|| {
        let mut connection = open_profile_pool_runtime_locked(project_root)?;
        let tx = connection.transaction().map_err(tx_err)?;
        let active = read_active_profile_claim_by_id_tx(&tx, &claim_id, now)?
            .ok_or_else(|| PROFILE_CLAIM_INACTIVE_ERROR.to_string())?;

        let breaker_until = match outcome {
            "success" => {
                clear_profile_circuit_breaker_tx(&tx, &active.profile_id)?;
                None
            }
            "rate-limited" => {
                let retry_after_ms = retry_after_ms.ok_or_else(|| {
                    "invalid-retry-after: retryAfterMs is required for rate-limited releases"
                        .to_string()
                })?;
                let open_until_ms =
                    checked_profile_pool_deadline(now, retry_after_ms, "invalid-retry-after")?;
                upsert_profile_circuit_breaker_tx(
                    &tx,
                    &active.profile_id,
                    "rate-limited",
                    reason.as_deref(),
                    error.as_deref(),
                    now,
                    open_until_ms,
                )?;
                Some(open_until_ms)
            }
            "error" => {
                if let Some(circuit_open_ms) = circuit_open_ms {
                    let open_until_ms = checked_profile_pool_deadline(
                        now,
                        circuit_open_ms,
                        "invalid-circuit-open",
                    )?;
                    upsert_profile_circuit_breaker_tx(
                        &tx,
                        &active.profile_id,
                        "error",
                        reason.as_deref(),
                        error.as_deref(),
                        now,
                        open_until_ms,
                    )?;
                    Some(open_until_ms)
                } else {
                    None
                }
            }
            _ => unreachable!("normalized profile pool outcome"),
        };

        let updated = tx
            .execute(
                "UPDATE runtime_profile_claims
                 SET status = ?2,
                     released_at_ms = ?3
                 WHERE claim_id = ?1
                   AND status = ?4
                   AND expires_at_ms > ?3",
                params![claim_id, RELEASED_CLAIM_STATUS, now, ACTIVE_CLAIM_STATUS],
            )
            .map_err(|err| format!("profile-pool-release-update-failed: {err}"))?;
        if updated != 1 {
            return Err(PROFILE_CLAIM_INACTIVE_ERROR.to_string());
        }

        let released = read_profile_claim_tx(&tx, &claim_id)?;
        let circuit_breaker = read_profile_circuit_breaker_optional_tx(&tx, &active.profile_id)?;
        if let Some(job_id) = active.job_id.as_deref() {
            let payload = profile_pool_release_event_payload(
                &released,
                outcome,
                breaker_until,
                reason.as_deref(),
            )?;
            let event_id = insert_runtime_event_tx(
                &tx,
                None,
                job_id,
                PROFILE_POOL_RELEASED_NAME,
                &payload,
                now,
            )?;
            let progress_payload = profile_pool_progress_payload(
                &released.claim_id,
                &released.profile_id,
                outcome,
                released.expires_at_ms,
                breaker_until,
            )?;
            upsert_runtime_progress_tx(
                &tx,
                job_id,
                &profile_pool_progress_key(&released.claim_id),
                &progress_payload,
                now,
                Some(&event_id),
            )?;
        }

        tx.commit().map_err(tx_err)?;
        Ok(RuntimeProfilePoolRelease {
            claim: released,
            circuit_breaker,
        })
    })
}

pub(crate) fn release_agent_profile_claim_for_project(
    project_root: Option<&Path>,
    enabled: bool,
    claim_id: &str,
    outcome: &str,
    error: Option<&str>,
) -> Result<(), String> {
    let now = now_ms()?;
    let diagnostic = error.and_then(classify_agent_profile_error);
    let release = RuntimeProfilePoolReleaseRequest {
        claim_id: claim_id.to_string(),
        outcome: outcome.to_string(),
        retry_after_ms: None,
        circuit_open_ms: diagnostic.map(|_| DEFAULT_RETRY_BACKOFF_MS),
        reason: Some(
            diagnostic
                .map(str::to_string)
                .unwrap_or_else(|| AGENT_PROFILE_RELEASE_REASON.to_string()),
        ),
        error: error.map(str::to_string),
    };
    match runtime_profile_pool_release_for_project(project_root, enabled, release, now) {
        Ok(_) => Ok(()),
        Err(err) if profile_claim_inactive_error(&err) => Ok(()),
        Err(err) => Err(err),
    }
}

fn classify_agent_profile_error(error: &str) -> Option<&'static str> {
    let normalized = error.to_ascii_lowercase();
    // Claude Agent SDK reports unavailable model aliases with these stable fragments.
    const SDK_MODEL_REJECTED_FRAGMENTS: &[&str] = &[
        "selected model",
        "model may not exist",
        "not have access to it",
        "run --model",
    ];
    // Gateway providers usually surface bad credentials as explicit HTTP auth failures.
    const GATEWAY_AUTH_FAILED_FRAGMENTS: &[&str] = &[
        "authentication failed",
        "authentication error",
        "authorization failed",
        "auth failed",
        "invalid api key",
        "invalid x-api-key",
    ];

    if SDK_MODEL_REJECTED_FRAGMENTS
        .iter()
        .any(|fragment| normalized.contains(fragment))
    {
        return Some(AGENT_PROFILE_SDK_MODEL_REJECTED_REASON);
    }
    if GATEWAY_AUTH_FAILED_FRAGMENTS
        .iter()
        .any(|fragment| normalized.contains(fragment))
        || contains_gateway_auth_status(&normalized)
    {
        return Some(AGENT_PROFILE_GATEWAY_AUTH_FAILED_REASON);
    }
    None
}

fn contains_gateway_auth_status(normalized_error: &str) -> bool {
    const AUTH_STATUS_FRAGMENTS: &[&str] = &[
        "http 401",
        "http 403",
        "status 401",
        "status 403",
        "status code 401",
        "status code 403",
        "401 unauthorized",
        "403 forbidden",
    ];
    AUTH_STATUS_FRAGMENTS
        .iter()
        .any(|fragment| normalized_error.contains(fragment))
}

pub(crate) fn renew_agent_profile_claim_for_project(
    project_root: Option<&Path>,
    enabled: bool,
    claim_id: &str,
) -> Result<RuntimeProfilePoolRenew, String> {
    let now = now_ms()?;
    runtime_profile_pool_renew_for_project(
        project_root,
        enabled,
        RuntimeProfilePoolRenewRequest {
            claim_id: claim_id.to_string(),
            ttl_ms: Some(MAX_PROFILE_POOL_TTL_MS),
        },
        now,
    )
}

fn runtime_profile_pool_renew_for_project(
    project_root: Option<&Path>,
    enabled: bool,
    request: RuntimeProfilePoolRenewRequest,
    now: i64,
) -> Result<RuntimeProfilePoolRenew, String> {
    let project_root = require_enabled_project(project_root, enabled)?;
    let claim_id = normalize_profile_text(
        "invalid-claim-id",
        "claimId",
        &request.claim_id,
        MAX_PROFILE_ID_BYTES,
    )?;
    let ttl_ms = normalize_profile_pool_ttl(request.ttl_ms)?;
    let expires_at_ms = checked_profile_pool_deadline(now, ttl_ms, "invalid-ttl")?;

    with_runtime_writer(|| {
        let mut connection = open_profile_pool_runtime_locked(project_root)?;
        let tx = connection.transaction().map_err(tx_err)?;
        expire_profile_claims_tx(&tx, now)?;
        let active = read_active_profile_claim_by_id_tx(&tx, &claim_id, now)?
            .ok_or_else(|| PROFILE_CLAIM_INACTIVE_ERROR.to_string())?;
        let updated = tx
            .execute(
                "UPDATE runtime_profile_claims
                 SET expires_at_ms = ?2
                 WHERE claim_id = ?1
                   AND status = ?3
                   AND released_at_ms IS NULL
                   AND expires_at_ms > ?4",
                params![claim_id, expires_at_ms, ACTIVE_CLAIM_STATUS, now],
            )
            .map_err(|err| format!("profile-pool-renew-update-failed: {err}"))?;
        if updated != 1 {
            return Err(PROFILE_CLAIM_INACTIVE_ERROR.to_string());
        }
        let claim = read_profile_claim_tx(&tx, &claim_id)?;
        tx.commit().map_err(tx_err)?;
        Ok(RuntimeProfilePoolRenew {
            claim_id,
            profile_id: active.profile_id,
            expires_at_ms,
            claim,
        })
    })
}

pub(crate) fn resolve_agent_run_profile_for_project_with_store(
    project_root: Option<&Path>,
    enabled: bool,
    profile_id: &str,
    claim_id: &str,
    store: &impl SecretStore,
) -> Result<AgentRunProfileConfig, String> {
    let now = now_ms()?;
    resolve_agent_run_profile_for_project_at_with_store(
        project_root,
        enabled,
        profile_id,
        claim_id,
        now,
        store,
    )
}

fn resolve_agent_run_profile_for_project_at_with_store(
    project_root: Option<&Path>,
    enabled: bool,
    profile_id: &str,
    claim_id: &str,
    now: i64,
    store: &impl SecretStore,
) -> Result<AgentRunProfileConfig, String> {
    let project_root = require_enabled_project(project_root, enabled)?;
    let profile_id = normalize_profile_text(
        "invalid-profile-id",
        "profileId",
        profile_id,
        MAX_PROFILE_ID_BYTES,
    )?;
    let claim_id = normalize_profile_text(
        "invalid-claim-id",
        "claimId",
        claim_id,
        MAX_PROFILE_ID_BYTES,
    )?;

    let (profile, claim) = with_runtime_writer(|| {
        let mut connection = open_profile_pool_runtime_locked(project_root)?;
        let tx = connection.transaction().map_err(tx_err)?;
        expire_profile_claims_tx(&tx, now)?;
        let claim = read_active_profile_claim_by_id_tx(&tx, &claim_id, now)?
            .ok_or_else(|| PROFILE_CLAIM_INACTIVE_ERROR.to_string())?;
        if claim.profile_id != profile_id {
            return Err(
                "profile-claim-mismatch: profileId does not match the active claim".to_string(),
            );
        }
        if claim.kind != "agent-run" || claim.task_family != "agent" {
            return Err("profile-unsupported: claim is not for an agent-run profile".to_string());
        }
        let profile = read_visible_profile_tx(&tx, &profile_id)?;
        if !profile_pool_profile_base_eligible(&tx, &profile, "agent-run", "agent", now)? {
            return Err(
                "profile-unsupported: profile is not eligible for Agent-run sidecar use"
                    .to_string(),
            );
        }
        tx.commit().map_err(tx_err)?;
        Ok((profile, claim))
    })?;

    if profile.profile_id != claim.profile_id {
        return Err(
            "profile-claim-mismatch: profileId does not match the active claim".to_string(),
        );
    }

    let secret_value = if profile_secret_required(&profile.auth_style) {
        let secret_ref = profile.secret_ref.as_deref().ok_or_else(|| {
            "profile-missing-secret: stored Agent-run profile has no secretRef".to_string()
        })?;
        Some(read_profile_secret(store, secret_ref)?)
    } else {
        None
    };

    Ok(AgentRunProfileConfig {
        profile_id: profile.profile_id,
        agent_sdk_model_id: profile
            .agent_sdk_model_id
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| profile.model_id.clone()),
        provider_model_id: profile.model_id,
        endpoint: profile.endpoint,
        auth_style: profile.auth_style,
        secret_value,
    })
}

fn runtime_profile_pool_list_for_project(
    project_root: Option<&Path>,
    enabled: bool,
    request: RuntimeProfilePoolListRequest,
    now: i64,
) -> Result<RuntimeProfilePoolList, String> {
    if !enabled {
        return Ok(RuntimeProfilePoolList {
            enabled: false,
            status: RuntimeDbHealthState::Disabled,
            active_claims: Vec::new(),
            circuit_breakers: Vec::new(),
        });
    }
    let Some(project_root) = project_root else {
        return Ok(RuntimeProfilePoolList {
            enabled: true,
            status: RuntimeDbHealthState::NoProject,
            active_claims: Vec::new(),
            circuit_breakers: Vec::new(),
        });
    };
    let kind = request
        .kind
        .as_deref()
        .map(normalize_profile_kind)
        .transpose()?;
    let task_family = request
        .task_family
        .map(|value| {
            normalize_profile_text(
                "invalid-task-family",
                "taskFamily",
                &value,
                MAX_PROFILE_TASK_FAMILY_BYTES,
            )
        })
        .transpose()?;
    let job_id = normalize_optional_filter("invalid-job-id", "jobId", request.job_id)?;
    let db_path = runtime_db_path(project_root);
    if !db_path.exists() {
        return Ok(RuntimeProfilePoolList {
            enabled: true,
            status: RuntimeDbHealthState::Healthy,
            active_claims: Vec::new(),
            circuit_breakers: Vec::new(),
        });
    }
    let connection = Connection::open_with_flags(
        db_path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|err| format!("profile-pool-list-open-failed: {err}"))?;
    if !table_exists(&connection, "runtime_profile_claims")?
        || !table_exists(&connection, "runtime_profile_circuit_breakers")?
    {
        return Ok(RuntimeProfilePoolList {
            enabled: true,
            status: RuntimeDbHealthState::Healthy,
            active_claims: Vec::new(),
            circuit_breakers: Vec::new(),
        });
    }
    Ok(RuntimeProfilePoolList {
        enabled: true,
        status: RuntimeDbHealthState::Healthy,
        active_claims: read_active_profile_claims(
            &connection,
            now,
            kind,
            task_family.as_deref(),
            job_id.as_deref(),
        )?,
        circuit_breakers: read_open_profile_circuit_breakers(&connection, now)?,
    })
}

async fn runtime_profile_probe_for_project_with_store(
    project_root: Option<&Path>,
    enabled: bool,
    request: RuntimeProfileProbeRequest,
    now: i64,
    store: &impl SecretStore,
    client: &Client,
) -> Result<RuntimeProfileProbeResult, String> {
    let project_root = require_enabled_project(project_root, enabled)?;
    let force = request.force.unwrap_or(false);
    let (cached, target) = resolve_profile_probe_target(project_root, request, now, force, store)?;
    if let Some(result) = cached {
        return Ok(result);
    }

    let target = target.expect("probe target should exist when no cached result is returned");
    let outcome = probe_profile_target(client, &target, now).await;
    let profile = if let Some(profile_id) = target.profile_id {
        Some(apply_profile_probe_outcome(
            project_root,
            &profile_id,
            &outcome,
            now,
        )?)
    } else {
        None
    };
    Ok(runtime_profile_probe_result(profile, outcome, now))
}

fn runtime_profile_probe_result(
    profile: Option<RuntimeProfileRecord>,
    outcome: RuntimeProfileProbeOutcome,
    now: i64,
) -> RuntimeProfileProbeResult {
    RuntimeProfileProbeResult {
        profile,
        status: outcome.status,
        capability_json: outcome.capability_json,
        capability_version: PROFILE_PROBE_CAPABILITY_VERSION.to_string(),
        checked_at_ms: now,
        backoff_until_ms: outcome.backoff_until_ms,
        message: outcome.message,
    }
}

fn resolve_profile_probe_target(
    project_root: &Path,
    request: RuntimeProfileProbeRequest,
    now: i64,
    force: bool,
    store: &impl SecretStore,
) -> Result<
    (
        Option<RuntimeProfileProbeResult>,
        Option<RuntimeProfileProbeTarget>,
    ),
    String,
> {
    match (request.profile_id, request.draft) {
        (Some(profile_id), None) => {
            let profile_id = normalize_profile_text(
                "invalid-profile-id",
                "profileId",
                &profile_id,
                MAX_PROFILE_ID_BYTES,
            )?;
            let connection = open_profile_runtime_locked(project_root)?;
            let profile = read_visible_profile(&connection, &profile_id)?;
            if !force
                && profile.capability_version == PROFILE_PROBE_CAPABILITY_VERSION
                && profile
                    .probe_backoff_until_ms
                    .is_some_and(|backoff| backoff > now)
            {
                let message = profile
                    .last_capability_error
                    .clone()
                    .unwrap_or_else(|| "Probe is waiting for retry backoff.".to_string());
                return Ok((
                    Some(RuntimeProfileProbeResult {
                        profile: Some(profile.clone()),
                        status: profile.capability_status.clone(),
                        capability_json: profile.capability_json.clone(),
                        capability_version: profile.capability_version.clone(),
                        checked_at_ms: profile.capability_checked_at_ms.unwrap_or(0),
                        backoff_until_ms: profile.probe_backoff_until_ms,
                        message,
                    }),
                    None,
                ));
            }
            let secret_value = match profile_secret_required(&profile.auth_style) {
                true => {
                    let secret_ref = profile.secret_ref.as_deref().ok_or_else(|| {
                        "profile-probe-missing-secret: stored profile has no secretRef".to_string()
                    })?;
                    read_profile_secret(store, secret_ref)?
                }
                false => String::new(),
            };
            Ok((
                None,
                Some(RuntimeProfileProbeTarget {
                    profile_id: Some(profile.profile_id),
                    kind: profile.kind,
                    provider_id: profile.provider_id,
                    model_id: profile.model_id,
                    agent_sdk_model_id: profile.agent_sdk_model_id,
                    endpoint: profile.endpoint,
                    api_mode: profile.api_mode,
                    auth_style: profile.auth_style,
                    secret_value,
                }),
            ))
        }
        (None, Some(draft)) => Ok((
            None,
            Some(probe_target_from_draft(draft, request.raw_secret)?),
        )),
        _ => Err(
            "invalid-profile-probe-request: provide exactly one of profileId or draft".to_string(),
        ),
    }
}

fn probe_target_from_draft(
    draft: RuntimeProfileProbeDraftRequest,
    raw_secret: Option<String>,
) -> Result<RuntimeProfileProbeTarget, String> {
    let kind = normalize_profile_kind(&draft.kind)?.to_string();
    let provider_id = normalize_profile_text(
        "invalid-provider-id",
        "providerId",
        &draft.provider_id,
        MAX_PROFILE_PROVIDER_BYTES,
    )?;
    let model_id = normalize_profile_text(
        "invalid-model-id",
        "modelId",
        &draft.model_id,
        MAX_PROFILE_MODEL_BYTES,
    )?;
    let agent_sdk_model_id = normalize_optional_profile_text(
        draft.agent_sdk_model_id,
        "invalid-agent-sdk-model-id",
        "agentSdkModelId",
        MAX_PROFILE_SDK_MODEL_BYTES,
    )?;
    let endpoint = normalize_optional_profile_text(
        draft.endpoint,
        "invalid-endpoint",
        "endpoint",
        MAX_PROFILE_ENDPOINT_BYTES,
    )?;
    let api_mode = normalize_profile_api_mode(&draft.api_mode)?.to_string();
    let auth_style = normalize_profile_auth_style(&draft.auth_style)?.to_string();
    let secret_value = if profile_secret_required(&auth_style) {
        raw_secret
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| {
                "profile-probe-missing-secret: draft probes require rawSecret".to_string()
            })?
            .to_string()
    } else {
        String::new()
    };
    Ok(RuntimeProfileProbeTarget {
        profile_id: None,
        kind,
        provider_id,
        model_id,
        agent_sdk_model_id,
        endpoint,
        api_mode,
        auth_style,
        secret_value,
    })
}

fn profile_secret_required(auth_style: &str) -> bool {
    matches!(auth_style, "bearer" | "x-api-key" | "api-key")
}

fn apply_profile_probe_outcome(
    project_root: &Path,
    profile_id: &str,
    outcome: &RuntimeProfileProbeOutcome,
    now: i64,
) -> Result<RuntimeProfileRecord, String> {
    let status = normalize_profile_capability_status(&outcome.status)?;
    let capability_json = normalize_profile_json(
        "invalid-capability-json",
        "capabilityJson",
        &outcome.capability_json,
        MAX_PROFILE_CAPABILITY_JSON_BYTES,
    )?;
    let capability_version = normalize_profile_text(
        "invalid-capability-version",
        "capabilityVersion",
        PROFILE_PROBE_CAPABILITY_VERSION,
        MAX_PROFILE_CAPABILITY_VERSION_BYTES,
    )?;
    let backoff = outcome
        .backoff_until_ms
        .map(|value| {
            normalize_non_negative_ms("invalid-probe-backoff", "probeBackoffUntilMs", value)
        })
        .transpose()?;
    let last_error = outcome
        .last_capability_error
        .clone()
        .map(|value| {
            normalize_profile_text(
                "invalid-capability-error",
                "lastCapabilityError",
                &value,
                MAX_PROFILE_CAPABILITY_ERROR_BYTES,
            )
        })
        .transpose()?;

    with_runtime_writer(|| {
        let mut connection = open_profile_runtime_locked(project_root)?;
        let tx = connection.transaction().map_err(tx_err)?;
        read_visible_profile_tx(&tx, profile_id)?;
        tx.execute(
            "UPDATE runtime_model_profiles
             SET capability_status = ?2,
                 capability_json = ?3,
                 capability_version = ?4,
                 capability_checked_at_ms = ?5,
                 probe_backoff_until_ms = ?6,
                 last_capability_error = ?7,
                 updated_at_ms = ?5
             WHERE profile_id = ?1",
            params![
                profile_id,
                status,
                capability_json,
                capability_version,
                now,
                backoff,
                last_error,
            ],
        )
        .map_err(|err| format!("profile-probe-cache-update-failed: {err}"))?;
        let profile = read_visible_profile_tx(&tx, profile_id)?;
        tx.commit().map_err(tx_err)?;
        Ok(profile)
    })
}

async fn probe_profile_target(
    client: &Client,
    target: &RuntimeProfileProbeTarget,
    now: i64,
) -> RuntimeProfileProbeOutcome {
    match target.api_mode.as_str() {
        "anthropic-messages" => probe_anthropic_messages(client, target, now).await,
        "openai-chat-completions" => probe_openai_chat(client, target, now).await,
        "google-generate-content" => probe_google_generate_content(client, target, now).await,
        _ => unsupported_probe_outcome(target, now, "Local CLI profiles are not HTTP-probed."),
    }
}

async fn probe_anthropic_messages(
    client: &Client,
    target: &RuntimeProfileProbeTarget,
    now: i64,
) -> RuntimeProfileProbeOutcome {
    let url = anthropic_messages_url(target.endpoint.as_deref());
    let headers = probe_headers(
        "anthropic-messages",
        &target.auth_style,
        &target.secret_value,
    );
    let message_body = serde_json::json!({
        "model": target.model_id,
        "max_tokens": PROFILE_PROBE_MAX_TOKENS,
        "system": "Reply with OK.",
        "messages": [{ "role": "user", "content": "Reply OK." }]
    });
    let message = post_probe_json(client, &url, headers.clone(), message_body, false).await;
    if !message.ok {
        return failed_primary_probe_outcome(target, now, message.message);
    }

    let stream_body = serde_json::json!({
        "model": target.model_id,
        "max_tokens": PROFILE_PROBE_MAX_TOKENS,
        "stream": true,
        "messages": [{ "role": "user", "content": "Reply OK." }]
    });
    let stream = post_probe_json(client, &url, headers.clone(), stream_body, true).await;
    let tool_body = serde_json::json!({
        "model": target.model_id,
        "max_tokens": PROFILE_PROBE_MAX_TOKENS,
        "tools": [{
            "name": "profile_probe_tool",
            "description": "A no-op tool used only to check tool schema support.",
            "input_schema": {
                "type": "object",
                "properties": {},
                "additionalProperties": false
            }
        }],
        "messages": [{ "role": "user", "content": "Reply OK." }]
    });
    let tool = post_probe_json(client, &url, headers, tool_body, false).await;
    let status = if stream.ok && tool.ok {
        "supported"
    } else {
        "limited"
    };
    let message = if status == "supported" {
        "Probe succeeded: messages, streaming, and tool schema are supported.".to_string()
    } else {
        "Probe completed with limited capabilities.".to_string()
    };
    probe_outcome(
        now,
        status,
        message,
        None,
        capability_json(
            target,
            serde_json::json!({
                "messages": message_check(true, None),
                "streaming": message_check(stream.ok, stream.error_code),
                "toolUse": message_check(tool.ok, tool.error_code),
                "systemPrompt": message_check(true, None)
            }),
            true,
            stream.ok && tool.ok,
            serde_json::json!({ "maxOutputTokens": PROFILE_PROBE_MAX_TOKENS }),
            "unknown",
        ),
    )
}

async fn probe_openai_chat(
    client: &Client,
    target: &RuntimeProfileProbeTarget,
    now: i64,
) -> RuntimeProfileProbeOutcome {
    let url = openai_chat_url(target.endpoint.as_deref());
    let body = serde_json::json!({
        "model": target.model_id,
        "max_tokens": PROFILE_PROBE_MAX_TOKENS,
        "messages": [{ "role": "user", "content": "Reply OK." }]
    });
    let result = post_probe_json(
        client,
        &url,
        probe_headers(
            "openai-chat-completions",
            &target.auth_style,
            &target.secret_value,
        ),
        body,
        false,
    )
    .await;
    if !result.ok {
        return failed_primary_probe_outcome(target, now, result.message);
    }
    let status = if target.kind == "agent-run" {
        "limited"
    } else {
        "supported"
    };
    probe_outcome(
        now,
        status,
        "Probe succeeded: chat completions model-call is supported.".to_string(),
        None,
        capability_json(
            target,
            serde_json::json!({
                "messages": message_check(true, None),
                "streaming": message_check(false, Some("not-probed".to_string())),
                "toolUse": message_check(false, Some("not-probed".to_string())),
                "systemPrompt": message_check(false, Some("not-probed".to_string()))
            }),
            true,
            false,
            serde_json::json!({ "maxOutputTokens": PROFILE_PROBE_MAX_TOKENS }),
            "unsupported",
        ),
    )
}

async fn probe_google_generate_content(
    client: &Client,
    target: &RuntimeProfileProbeTarget,
    now: i64,
) -> RuntimeProfileProbeOutcome {
    let url = google_generate_content_url(target.endpoint.as_deref(), &target.model_id);
    let body = serde_json::json!({
        "contents": [{
            "role": "user",
            "parts": [{ "text": "Reply OK." }]
        }]
    });
    let result = post_probe_json(
        client,
        &url,
        probe_headers(
            "google-generate-content",
            &target.auth_style,
            &target.secret_value,
        ),
        body,
        false,
    )
    .await;
    if !result.ok {
        return failed_primary_probe_outcome(target, now, result.message);
    }
    let status = if target.kind == "agent-run" {
        "limited"
    } else {
        "supported"
    };
    probe_outcome(
        now,
        status,
        "Probe succeeded: generateContent model-call is supported.".to_string(),
        None,
        capability_json(
            target,
            serde_json::json!({
                "messages": message_check(true, None),
                "streaming": message_check(false, Some("not-probed".to_string())),
                "toolUse": message_check(false, Some("not-probed".to_string())),
                "systemPrompt": message_check(false, Some("not-probed".to_string()))
            }),
            true,
            false,
            serde_json::json!({ "maxOutputTokens": PROFILE_PROBE_MAX_TOKENS }),
            "unsupported",
        ),
    )
}

fn unsupported_probe_outcome(
    target: &RuntimeProfileProbeTarget,
    now: i64,
    message: &str,
) -> RuntimeProfileProbeOutcome {
    probe_outcome(
        now,
        "unsupported",
        message.to_string(),
        None,
        capability_json(
            target,
            serde_json::json!({
                "messages": message_check(false, Some("unsupported-api-mode".to_string())),
                "streaming": message_check(false, Some("unsupported-api-mode".to_string())),
                "toolUse": message_check(false, Some("unsupported-api-mode".to_string())),
                "systemPrompt": message_check(false, Some("unsupported-api-mode".to_string()))
            }),
            false,
            false,
            serde_json::json!({}),
            "unsupported",
        ),
    )
}

fn failed_primary_probe_outcome(
    target: &RuntimeProfileProbeTarget,
    now: i64,
    message: String,
) -> RuntimeProfileProbeOutcome {
    let safe_message = bounded_profile_probe_error(&message);
    probe_outcome(
        now,
        "error",
        safe_message.clone(),
        Some(safe_message),
        capability_json(
            target,
            serde_json::json!({
                "messages": message_check(false, Some("primary-probe-failed".to_string())),
                "streaming": message_check(false, Some("not-run".to_string())),
                "toolUse": message_check(false, Some("not-run".to_string())),
                "systemPrompt": message_check(false, Some("not-run".to_string()))
            }),
            false,
            false,
            serde_json::json!({}),
            "unknown",
        ),
    )
}

fn probe_outcome(
    now: i64,
    status: &str,
    message: String,
    last_capability_error: Option<String>,
    capability: serde_json::Value,
) -> RuntimeProfileProbeOutcome {
    RuntimeProfileProbeOutcome {
        status: status.to_string(),
        capability_json: capability.to_string(),
        message,
        backoff_until_ms: if status == "error" {
            now.checked_add(PROFILE_PROBE_BACKOFF_MS)
        } else {
            None
        },
        last_capability_error,
    }
}

fn capability_json(
    target: &RuntimeProfileProbeTarget,
    checks: serde_json::Value,
    model_call_supported: bool,
    agent_run_supported: bool,
    context: serde_json::Value,
    sdk_state: &str,
) -> serde_json::Value {
    serde_json::json!({
        "version": PROFILE_PROBE_CAPABILITY_VERSION,
        "apiMode": target.api_mode,
        "providerId": target.provider_id,
        "modelId": target.model_id,
        "agentSdkModelId": target.agent_sdk_model_id,
        "authStyle": target.auth_style,
        "endpointKind": endpoint_kind(target.endpoint.as_deref()),
        "checks": checks,
        "modelCallSupported": model_call_supported,
        "agentRunSupported": agent_run_supported,
        "thinking": "unknown",
        "tokenCounting": "unknown",
        "context": context,
        "claudeAgentSdk": {
            "contextManagement": sdk_state,
            "checkpointing": sdk_state,
            "betaHeaders": sdk_state
        }
    })
}

#[derive(Debug)]
struct ProbeHttpResult {
    ok: bool,
    message: String,
    error_code: Option<String>,
}

async fn post_probe_json(
    client: &Client,
    url: &str,
    headers: HeaderMap,
    body: serde_json::Value,
    expect_stream: bool,
) -> ProbeHttpResult {
    let response = client.post(url).headers(headers).json(&body).send().await;
    let response = match response {
        Ok(response) => response,
        Err(_) => {
            return ProbeHttpResult {
                ok: false,
                message: "profile-probe-network-failed: request failed".to_string(),
                error_code: Some("network-failed".to_string()),
            };
        }
    };
    let status = response.status();
    if !status.is_success() {
        return ProbeHttpResult {
            ok: false,
            message: format!("profile-probe-http-failed: provider returned {status}"),
            error_code: Some(format!("http-{}", status.as_u16())),
        };
    }
    if !expect_stream {
        return ProbeHttpResult {
            ok: true,
            message: "ok".to_string(),
            error_code: None,
        };
    }
    let text = match response.text().await {
        Ok(text) => text,
        Err(_) => {
            return ProbeHttpResult {
                ok: false,
                message: "profile-probe-stream-read-failed: response stream failed".to_string(),
                error_code: Some("stream-read-failed".to_string()),
            };
        }
    };
    let ok = text.lines().any(|line| {
        let line = line.trim_start();
        line.starts_with("event:") || line.starts_with("data:")
    });
    ProbeHttpResult {
        ok,
        message: if ok {
            "ok".to_string()
        } else {
            "profile-probe-stream-format-failed: response was not SSE-like".to_string()
        },
        error_code: if ok {
            None
        } else {
            Some("stream-format-failed".to_string())
        },
    }
}

fn probe_headers(api_mode: &str, auth_style: &str, secret_value: &str) -> HeaderMap {
    let mut headers = HeaderMap::new();
    headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    if api_mode == "anthropic-messages" {
        headers.insert("anthropic-version", HeaderValue::from_static("2023-06-01"));
    }
    let Ok(secret) = HeaderValue::from_str(secret_value) else {
        return headers;
    };
    match (api_mode, auth_style) {
        (_, "none") | (_, "oauth-local-cli") => {}
        ("anthropic-messages", "x-api-key") => {
            headers.insert("x-api-key", secret);
        }
        ("google-generate-content", "api-key" | "x-api-key") => {
            headers.insert("x-goog-api-key", secret);
        }
        (_, "x-api-key") => {
            headers.insert("x-api-key", secret);
        }
        _ => {
            let bearer = format!("Bearer {secret_value}");
            if let Ok(value) = HeaderValue::from_str(&bearer) {
                headers.insert(AUTHORIZATION, value);
            }
        }
    }
    headers
}

fn anthropic_messages_url(endpoint: Option<&str>) -> String {
    // Keep these cases aligned with src/lib/llm-providers.ts buildAnthropicUrl.
    let base = endpoint_base(endpoint, "https://api.anthropic.com");
    if base.ends_with("/messages") {
        base.to_string()
    } else if has_version_suffix(base) {
        format!("{base}/messages")
    } else {
        format!("{base}/v1/messages")
    }
}

fn openai_chat_url(endpoint: Option<&str>) -> String {
    let base = endpoint_base(endpoint, "https://api.openai.com");
    if base.ends_with("/chat/completions") {
        base.to_string()
    } else if has_version_suffix(base) {
        format!("{base}/chat/completions")
    } else {
        format!("{base}/v1/chat/completions")
    }
}

fn google_generate_content_url(endpoint: Option<&str>, model_id: &str) -> String {
    let base = endpoint_base(endpoint, "https://generativelanguage.googleapis.com/v1beta");
    if base.ends_with(":generateContent") {
        base.to_string()
    } else {
        format!(
            "{base}/models/{}:generateContent",
            encode_url_path_segment(model_id)
        )
    }
}

fn encode_url_path_segment(value: &str) -> String {
    let mut encoded = String::new();
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                encoded.push(byte as char);
            }
            _ => encoded.push_str(&format!("%{byte:02X}")),
        }
    }
    encoded
}

fn endpoint_base<'a>(endpoint: Option<&'a str>, default: &'a str) -> &'a str {
    endpoint
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(default)
        .trim_end_matches('/')
}

fn has_version_suffix(value: &str) -> bool {
    let Some(segment) = value.rsplit('/').next() else {
        return false;
    };
    let Some(digits) = segment.strip_prefix('v') else {
        return false;
    };
    !digits.is_empty() && digits.chars().all(|value| value.is_ascii_digit())
}

fn endpoint_kind(endpoint: Option<&str>) -> &'static str {
    match endpoint.map(str::trim).filter(|value| !value.is_empty()) {
        Some(value)
            if value.starts_with("http://127.0.0.1") || value.starts_with("http://localhost") =>
        {
            "local"
        }
        Some(_) => "custom",
        None => "default",
    }
}

fn message_check(supported: bool, error_code: Option<String>) -> serde_json::Value {
    serde_json::json!({
        "supported": supported,
        "errorCode": error_code
    })
}

fn bounded_profile_probe_error(message: &str) -> String {
    if message.len() <= MAX_PROFILE_CAPABILITY_ERROR_BYTES {
        return message.to_string();
    }
    let mut end = MAX_PROFILE_CAPABILITY_ERROR_BYTES;
    while !message.is_char_boundary(end) {
        end -= 1;
    }
    message[..end].to_string()
}

fn runtime_commit_budget_claim_for_project(
    project_root: Option<&Path>,
    enabled: bool,
    request: RuntimeCommitBudgetClaimRequest,
    now: i64,
) -> Result<RuntimeCommitBudgetClaim, String> {
    let project_root = require_enabled_project(project_root, enabled)?;
    let affected_path = normalize_affected_path(&request.affected_path)?;
    let ttl_ms = normalize_commit_budget_ttl(request.ttl_ms)?;
    let expires_at_ms = now
        .checked_add(ttl_ms)
        .ok_or_else(|| "invalid-ttl: commit budget expiry overflow".to_string())?;
    let holder = require_non_empty("invalid-holder", "holder", &request.holder)?.to_string();
    let claim_id = match request.claim_id {
        Some(claim_id) => require_non_empty("invalid-claim-id", "claimId", &claim_id)?.to_string(),
        None => Uuid::new_v4().to_string(),
    };

    with_runtime_writer(|| {
        let mut connection = open_resource_budget_runtime_locked(project_root)?;
        let tx = connection.transaction().map_err(tx_err)?;
        ensure_claim_id_available(&tx, &claim_id)?;
        if let Some(job_id) = request.job_id.as_deref() {
            ensure_job_exists(&tx, job_id)?;
        }
        ensure_path_budget(&tx, &affected_path, now)?;
        ensure_commit_total_capacity(&tx)?;
        ensure_commit_path_available(&tx, &affected_path.resource_key)?;

        insert_commit_budget_claim_row(
            &tx,
            &claim_id,
            COMMIT_TOTAL_SCOPE,
            COMMIT_TOTAL_RESOURCE_KEY,
            COMMIT_TOTAL_RESOURCE_KEY,
            request.job_id.as_deref(),
            &holder,
            now,
            expires_at_ms,
        )?;
        insert_commit_budget_claim_row(
            &tx,
            &claim_id,
            COMMIT_PATH_SCOPE,
            &affected_path.resource_key,
            &affected_path.display_key,
            request.job_id.as_deref(),
            &holder,
            now,
            expires_at_ms,
        )?;

        let claims = read_claims_by_id_tx(&tx, &claim_id)?;
        ensure_claim_pair(&claims)?;
        tx.commit().map_err(tx_err)?;
        Ok(RuntimeCommitBudgetClaim {
            claim_id,
            resource_key: affected_path.resource_key,
            display_key: affected_path.display_key,
            expires_at_ms,
            claims,
        })
    })
}

fn runtime_commit_budget_release_for_project(
    project_root: Option<&Path>,
    enabled: bool,
    request: RuntimeCommitBudgetReleaseRequest,
    now: i64,
) -> Result<Vec<RuntimeResourceBudgetClaimRecord>, String> {
    let project_root = require_enabled_project(project_root, enabled)?;
    let claim_id = require_non_empty("invalid-claim-id", "claimId", &request.claim_id)?;
    with_runtime_writer(|| {
        let mut connection = open_resource_budget_runtime_locked(project_root)?;
        let tx = connection.transaction().map_err(tx_err)?;
        let active_claims = read_active_claims_by_id_tx(&tx, claim_id)?;
        if active_claims.is_empty() {
            return Err("claim-inactive: commit budget claim is not active".to_string());
        }
        ensure_claim_pair(&active_claims)?;
        let updated = update_claim_status(&tx, claim_id, RELEASED_CLAIM_STATUS, now)?;
        if updated != 2 {
            return Err(
                "claim-inconsistent: commit budget claim did not release exactly two rows"
                    .to_string(),
            );
        }
        let claims = read_claims_by_id_tx(&tx, claim_id)?;
        tx.commit().map_err(tx_err)?;
        Ok(claims)
    })
}

fn runtime_commit_budget_list_for_project(
    project_root: Option<&Path>,
    enabled: bool,
) -> Result<RuntimeCommitBudgetList, String> {
    if !enabled {
        return Ok(RuntimeCommitBudgetList {
            enabled: false,
            status: RuntimeDbHealthState::Disabled,
            budgets: Vec::new(),
            claims: Vec::new(),
        });
    }
    let Some(project_root) = project_root else {
        return Ok(RuntimeCommitBudgetList {
            enabled: true,
            status: RuntimeDbHealthState::NoProject,
            budgets: Vec::new(),
            claims: Vec::new(),
        });
    };
    let db_path = runtime_db_path(project_root);
    if !db_path.exists() {
        return Ok(RuntimeCommitBudgetList {
            enabled: true,
            status: RuntimeDbHealthState::Healthy,
            budgets: Vec::new(),
            claims: Vec::new(),
        });
    }
    let connection = Connection::open_with_flags(
        db_path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|err| format!("commit-budget-list-open-failed: {err}"))?;
    if !table_exists(&connection, "runtime_resource_budgets")?
        || !table_exists(&connection, "runtime_resource_budget_claims")?
    {
        return Ok(RuntimeCommitBudgetList {
            enabled: true,
            status: RuntimeDbHealthState::Healthy,
            budgets: Vec::new(),
            claims: Vec::new(),
        });
    }
    Ok(RuntimeCommitBudgetList {
        enabled: true,
        status: RuntimeDbHealthState::Healthy,
        budgets: read_resource_budgets(&connection)?,
        claims: read_active_resource_claims(&connection)?,
    })
}

fn runtime_event_append_for_project(
    project_root: Option<&Path>,
    enabled: bool,
    request: RuntimeEventAppendRequest,
    now: i64,
) -> Result<RuntimeEventRecord, String> {
    let project_root = require_enabled_project(project_root, enabled)?;
    let job_id = require_required_non_empty("invalid-job-id", "jobId", request.job_id.as_deref())?;
    let payload = require_event_payload(&request.payload)?;
    let event_id = normalize_optional_id("invalid-event-id", "eventId", request.event_id)?;

    with_runtime_writer(|| {
        let mut connection = open_events_progress_runtime_locked(project_root)?;
        let tx = connection.transaction().map_err(tx_err)?;
        ensure_job_exists(&tx, job_id)?;
        let event_id = insert_runtime_event_tx(
            &tx,
            event_id.as_deref(),
            job_id,
            EVENT_APPENDED_NAME,
            payload,
            now,
        )?;
        let event = read_event_tx(&tx, &event_id)?;
        tx.commit().map_err(tx_err)?;
        Ok(event)
    })
}

fn runtime_progress_append_for_project(
    project_root: Option<&Path>,
    enabled: bool,
    request: RuntimeProgressAppendRequest,
    now: i64,
) -> Result<RuntimeProgressAppend, String> {
    let project_root = require_enabled_project(project_root, enabled)?;
    let job_id = require_required_non_empty("invalid-job-id", "jobId", request.job_id.as_deref())?;
    let progress_key =
        require_non_empty("invalid-progress-key", "progressKey", &request.progress_key)?;
    let payload = require_event_payload(&request.payload)?;
    let event_id = normalize_optional_id("invalid-event-id", "eventId", request.event_id)?;
    let durable = request.durable.unwrap_or(false);

    with_runtime_writer(|| {
        let mut connection = open_events_progress_runtime_locked(project_root)?;
        let tx = connection.transaction().map_err(tx_err)?;
        ensure_job_exists(&tx, job_id)?;
        let previous = read_progress_optional_tx(&tx, job_id, progress_key)?;
        let should_append_event = durable
            || previous.as_ref().is_none_or(|progress| {
                now.saturating_sub(progress.updated_at_ms) >= DEFAULT_PROGRESS_MIN_INTERVAL_MS
            });
        let inserted_event_id = if should_append_event {
            Some(insert_runtime_event_tx(
                &tx,
                event_id.as_deref(),
                job_id,
                PROGRESS_APPENDED_NAME,
                payload,
                now,
            )?)
        } else {
            None
        };
        upsert_runtime_progress_tx(
            &tx,
            job_id,
            progress_key,
            payload,
            now,
            inserted_event_id.as_deref(),
        )?;
        let progress = read_progress_tx(&tx, job_id, progress_key)?;
        let event = match inserted_event_id {
            Some(event_id) => Some(read_event_tx(&tx, &event_id)?),
            None => None,
        };
        tx.commit().map_err(tx_err)?;
        Ok(RuntimeProgressAppend { progress, event })
    })
}

fn runtime_timeline_list_for_project(
    project_root: Option<&Path>,
    enabled: bool,
    request: RuntimeTimelineListRequest,
) -> Result<RuntimeTimelineList, String> {
    if !enabled {
        return Ok(RuntimeTimelineList {
            enabled: false,
            status: RuntimeDbHealthState::Disabled,
            events: Vec::new(),
        });
    }
    let Some(project_root) = project_root else {
        return Ok(RuntimeTimelineList {
            enabled: true,
            status: RuntimeDbHealthState::NoProject,
            events: Vec::new(),
        });
    };
    let limit = normalize_list_limit(request.limit, DEFAULT_TIMELINE_LIMIT, MAX_TIMELINE_LIMIT)?;
    let job_id = normalize_optional_filter("invalid-job-id", "jobId", request.job_id)?;
    let db_path = runtime_db_path(project_root);
    if !db_path.exists() {
        return Ok(RuntimeTimelineList {
            enabled: true,
            status: RuntimeDbHealthState::Healthy,
            events: Vec::new(),
        });
    }
    let connection = Connection::open_with_flags(
        db_path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|err| format!("timeline-list-open-failed: {err}"))?;
    if !table_exists(&connection, "runtime_events")? {
        return Ok(RuntimeTimelineList {
            enabled: true,
            status: RuntimeDbHealthState::Healthy,
            events: Vec::new(),
        });
    }
    Ok(RuntimeTimelineList {
        enabled: true,
        status: RuntimeDbHealthState::Healthy,
        events: read_events(&connection, job_id.as_deref(), limit)?,
    })
}

fn runtime_progress_list_for_project(
    project_root: Option<&Path>,
    enabled: bool,
    request: RuntimeProgressListRequest,
) -> Result<RuntimeProgressList, String> {
    if !enabled {
        return Ok(RuntimeProgressList {
            enabled: false,
            status: RuntimeDbHealthState::Disabled,
            progress: Vec::new(),
        });
    }
    let Some(project_root) = project_root else {
        return Ok(RuntimeProgressList {
            enabled: true,
            status: RuntimeDbHealthState::NoProject,
            progress: Vec::new(),
        });
    };
    let limit = normalize_list_limit(request.limit, DEFAULT_PROGRESS_LIMIT, MAX_PROGRESS_LIMIT)?;
    let job_id = normalize_optional_filter("invalid-job-id", "jobId", request.job_id)?;
    let db_path = runtime_db_path(project_root);
    if !db_path.exists() {
        return Ok(RuntimeProgressList {
            enabled: true,
            status: RuntimeDbHealthState::Healthy,
            progress: Vec::new(),
        });
    }
    let connection = Connection::open_with_flags(
        db_path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|err| format!("progress-list-open-failed: {err}"))?;
    if !table_exists(&connection, "runtime_progress")? {
        return Ok(RuntimeProgressList {
            enabled: true,
            status: RuntimeDbHealthState::Healthy,
            progress: Vec::new(),
        });
    }
    Ok(RuntimeProgressList {
        enabled: true,
        status: RuntimeDbHealthState::Healthy,
        progress: read_progress_rows(&connection, job_id.as_deref(), limit)?,
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

fn runtime_derived_stale_marker_record_for_project(
    project_root: Option<&Path>,
    enabled: bool,
    request: RuntimeDerivedStaleMarkerRecordRequest,
    now: i64,
) -> Result<RuntimeDerivedStaleMarkerRecord, String> {
    let project_root = require_enabled_project(project_root, enabled)?;
    let marker_id = normalize_optional_id("invalid-marker-id", "markerId", request.marker_id)?
        .unwrap_or_else(|| Uuid::new_v4().to_string());
    let layer = normalize_marker_layer(&request.layer)?;
    let affected_path = normalize_affected_path(&request.affected_path)?.display_key;
    let reason = normalize_marker_reason(&request.reason)?;
    let input_hash = normalize_marker_input_hash(request.input_hash, reason)?;
    let base_version = require_limited_non_empty(
        "invalid-base-version",
        "baseVersion",
        &request.base_version,
        MAX_DERIVED_MARKER_BASE_VERSION_BYTES,
    )?
    .to_string();
    let source_event_id = require_non_empty(
        "invalid-source-event-id",
        "sourceEventId",
        &request.source_event_id,
    )?
    .to_string();
    if base_version == source_event_id {
        return Err(
            "invalid-base-version: baseVersion must not duplicate sourceEventId".to_string(),
        );
    }

    with_runtime_writer(|| {
        let mut connection = open_derived_stale_markers_runtime_locked(project_root)?;
        let tx = connection.transaction().map_err(tx_err)?;
        read_event_tx(&tx, &source_event_id)?;
        tx.execute(
            "INSERT INTO runtime_derived_stale_markers (
                marker_id,
                layer,
                affected_path,
                input_hash,
                base_version,
                marked_at_ms,
                reason,
                source_event_id,
                status,
                updated_at_ms,
                last_error
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?6, NULL)",
            params![
                marker_id,
                layer,
                affected_path,
                input_hash,
                base_version,
                now,
                reason,
                source_event_id,
                PENDING_MARKER_STATUS
            ],
        )
        .map_err(|err| format!("derived-marker-record-insert-failed: {err}"))?;
        let marker = read_derived_marker_tx(&tx, &marker_id)?;
        tx.commit().map_err(tx_err)?;
        Ok(marker)
    })
}

fn runtime_derived_stale_marker_list_for_project(
    project_root: Option<&Path>,
    enabled: bool,
    request: RuntimeDerivedStaleMarkerListRequest,
) -> Result<RuntimeDerivedStaleMarkerList, String> {
    if !enabled {
        return Ok(RuntimeDerivedStaleMarkerList {
            enabled: false,
            status: RuntimeDbHealthState::Disabled,
            markers: Vec::new(),
        });
    }
    let Some(project_root) = project_root else {
        return Ok(RuntimeDerivedStaleMarkerList {
            enabled: true,
            status: RuntimeDbHealthState::NoProject,
            markers: Vec::new(),
        });
    };
    let limit = normalize_list_limit(
        request.limit,
        DEFAULT_DERIVED_MARKER_LIMIT,
        MAX_DERIVED_MARKER_LIMIT,
    )?;
    let layer = request
        .layer
        .as_deref()
        .map(normalize_marker_layer)
        .transpose()?;
    let affected_path = request
        .affected_path
        .as_deref()
        .map(normalize_affected_path)
        .transpose()?
        .map(|path| path.display_key);
    let status = request
        .status
        .as_deref()
        .map(normalize_marker_status)
        .transpose()?;
    let db_path = runtime_db_path(project_root);
    if !db_path.exists() {
        return Ok(RuntimeDerivedStaleMarkerList {
            enabled: true,
            status: RuntimeDbHealthState::Healthy,
            markers: Vec::new(),
        });
    }
    let connection = Connection::open_with_flags(
        db_path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|err| format!("derived-marker-list-open-failed: {err}"))?;
    if !table_exists(&connection, "runtime_derived_stale_markers")? {
        return Ok(RuntimeDerivedStaleMarkerList {
            enabled: true,
            status: RuntimeDbHealthState::Healthy,
            markers: Vec::new(),
        });
    }
    Ok(RuntimeDerivedStaleMarkerList {
        enabled: true,
        status: RuntimeDbHealthState::Healthy,
        markers: read_derived_markers(&connection, layer, affected_path.as_deref(), status, limit)?,
    })
}

#[allow(dead_code)]
fn runtime_commit_budget_expire_for_project(
    project_root: Option<&Path>,
    enabled: bool,
    claim_id: &str,
    now: i64,
) -> Result<Vec<RuntimeResourceBudgetClaimRecord>, String> {
    let project_root = require_enabled_project(project_root, enabled)?;
    let claim_id = require_non_empty("invalid-claim-id", "claimId", claim_id)?;
    with_runtime_writer(|| {
        let mut connection = open_resource_budget_runtime_locked(project_root)?;
        let tx = connection.transaction().map_err(tx_err)?;
        let active_claims = read_active_claims_by_id_tx(&tx, claim_id)?;
        if active_claims.is_empty() {
            return Err("claim-inactive: commit budget claim is not active".to_string());
        }
        ensure_claim_pair(&active_claims)?;
        if active_claims.iter().any(|claim| claim.expires_at_ms > now) {
            return Err("claim-not-expired: commit budget claim has not expired".to_string());
        }
        let updated = update_claim_status(&tx, claim_id, EXPIRED_CLAIM_STATUS, now)?;
        if updated != 2 {
            return Err(
                "claim-inconsistent: commit budget claim did not expire exactly two rows"
                    .to_string(),
            );
        }
        let claims = read_claims_by_id_tx(&tx, claim_id)?;
        tx.commit().map_err(tx_err)?;
        Ok(claims)
    })
}

fn terminal_running_operation(
    project_root: Option<&Path>,
    enabled: bool,
    job_id: &str,
    lease_id: &str,
    now: i64,
    update_job: impl FnOnce(&Transaction<'_>) -> Result<usize, String>,
) -> Result<RuntimeJobRecord, String> {
    let project_root = require_enabled_project(project_root, enabled)?;
    with_runtime_writer(|| {
        let mut connection = open_job_runtime_locked(project_root)?;
        let tx = connection.transaction().map_err(tx_err)?;
        ensure_active_running_lease(&tx, job_id, lease_id, Some(now))?;
        update_job(&tx)?;
        release_lease(&tx, job_id, lease_id, RELEASED_LEASE_STATUS, now)?;
        let job = read_job_tx(&tx, job_id)?;
        tx.commit().map_err(tx_err)?;
        Ok(job)
    })
}

/// Expire an active running lease for a future scheduler scan.
///
/// PR3 deliberately has no scheduler caller; without a later scanner, expired
/// active leases remain `running` and are not automatically recovered.
#[allow(dead_code)]
fn runtime_job_lease_timeout_for_project(
    project_root: Option<&Path>,
    enabled: bool,
    job_id: &str,
    lease_id: &str,
    now: i64,
) -> Result<RuntimeJobRecord, String> {
    let project_root = require_enabled_project(project_root, enabled)?;
    with_runtime_writer(|| {
        let mut connection = open_job_runtime_locked(project_root)?;
        let tx = connection.transaction().map_err(tx_err)?;
        ensure_active_running_lease(&tx, job_id, lease_id, None)?;
        let job = read_job_tx(&tx, job_id)?;
        let lease = read_lease_tx(&tx, lease_id)?;
        if lease.expires_at_ms > now {
            return Err("lease-not-expired: active lease has not expired".to_string());
        }
        let retry_remaining = job.attempt < job.max_attempts;
        let next_state = if retry_remaining {
            "retry-wait"
        } else {
            "failed"
        };
        let retry_after_ms = retry_remaining.then_some(now + DEFAULT_RETRY_BACKOFF_MS);
        tx.execute(
            "UPDATE runtime_jobs
             SET state = ?2,
                 failed_at_ms = CASE WHEN ?2 = 'failed' THEN ?3 ELSE failed_at_ms END,
                 retry_after_ms = ?4,
                 last_error = 'lease-timeout',
                 updated_at_ms = ?3
             WHERE job_id = ?1",
            params![job_id, next_state, now, retry_after_ms],
        )
        .map_err(|err| format!("job-lease-timeout-update-failed: {err}"))?;
        release_lease(&tx, job_id, lease_id, EXPIRED_LEASE_STATUS, now)?;
        let job = read_job_tx(&tx, job_id)?;
        tx.commit().map_err(tx_err)?;
        Ok(job)
    })
}

fn normalize_marker_layer(raw: &str) -> Result<&'static str, String> {
    match raw.trim() {
        "embedding" => Ok("embedding"),
        "graph" => Ok("graph"),
        "taxonomy" => Ok("taxonomy"),
        "synthesis" => Ok("synthesis"),
        "search" => Ok("search"),
        "index_export" => Ok("index_export"),
        "overview" => Ok("overview"),
        _ => Err("invalid-layer: unknown derived marker layer".to_string()),
    }
}

fn normalize_marker_reason(raw: &str) -> Result<&'static str, String> {
    match raw.trim() {
        "commit" => Ok("commit"),
        "delete" => Ok("delete"),
        "schema_change" => Ok("schema_change"),
        "manual_rebuild" => Ok("manual_rebuild"),
        _ => Err("invalid-reason: unknown derived marker reason".to_string()),
    }
}

fn normalize_marker_status(raw: &str) -> Result<&'static str, String> {
    match raw.trim() {
        "pending" => Ok("pending"),
        "claimed" => Ok("claimed"),
        "done" => Ok("done"),
        "failed" => Ok("failed"),
        "cancelled" => Ok("cancelled"),
        _ => Err("invalid-status: unknown derived marker status".to_string()),
    }
}

fn normalize_marker_input_hash(
    input_hash: Option<String>,
    reason: &str,
) -> Result<Option<String>, String> {
    let input_hash = normalize_optional_limited_text(
        "invalid-input-hash",
        "inputHash",
        input_hash,
        MAX_STAGING_ARTIFACT_HASH_BYTES,
    )?;
    if reason == "delete" {
        return if input_hash.is_none() {
            Ok(None)
        } else {
            Err("invalid-input-hash: inputHash must be null for delete markers".to_string())
        };
    }
    match input_hash {
        Some(input_hash) => Ok(Some(input_hash)),
        None => Err("invalid-input-hash: inputHash is required for non-delete markers".to_string()),
    }
}

fn normalize_profile_kind(raw: &str) -> Result<&'static str, String> {
    match raw.trim() {
        "model-call" => Ok("model-call"),
        "agent-run" => Ok("agent-run"),
        _ => Err("invalid-profile-kind: kind must be model-call or agent-run".to_string()),
    }
}

fn normalize_profile_api_mode(raw: &str) -> Result<&'static str, String> {
    match raw.trim() {
        "openai-chat-completions" => Ok("openai-chat-completions"),
        "anthropic-messages" => Ok("anthropic-messages"),
        "google-generate-content" => Ok("google-generate-content"),
        "local-cli" => Ok("local-cli"),
        _ => Err("invalid-api-mode: apiMode is not supported".to_string()),
    }
}

fn normalize_profile_auth_style(raw: &str) -> Result<&'static str, String> {
    match raw.trim() {
        "none" => Ok("none"),
        "bearer" => Ok("bearer"),
        "x-api-key" => Ok("x-api-key"),
        "api-key" => Ok("api-key"),
        "oauth-local-cli" => Ok("oauth-local-cli"),
        _ => Err("invalid-auth-style: authStyle is not supported".to_string()),
    }
}

fn normalize_profile_capability_status(raw: &str) -> Result<&'static str, String> {
    match raw.trim() {
        "unknown" => Ok("unknown"),
        "supported" => Ok("supported"),
        "limited" => Ok("limited"),
        "unsupported" => Ok("unsupported"),
        "error" => Ok("error"),
        _ => Err("invalid-capability-status: capabilityStatus is not supported".to_string()),
    }
}

fn normalize_profile_text(
    code: &str,
    field: &str,
    value: &str,
    max_bytes: usize,
) -> Result<String, String> {
    let value = require_limited_non_empty(code, field, value.trim(), max_bytes)?;
    Ok(value.to_string())
}

fn normalize_optional_profile_text(
    value: Option<String>,
    code: &str,
    field: &str,
    max_bytes: usize,
) -> Result<Option<String>, String> {
    value
        .map(|value| normalize_profile_text(code, field, &value, max_bytes))
        .transpose()
}

fn normalize_profile_text_update(
    value: Option<String>,
    existing: String,
    code: &str,
    field: &str,
    max_bytes: usize,
) -> Result<String, String> {
    value
        .map(|value| normalize_profile_text(code, field, &value, max_bytes))
        .transpose()
        .map(|value| value.unwrap_or(existing))
}

fn normalize_profile_enum_update(
    value: Option<String>,
    existing: String,
    normalize: fn(&str) -> Result<&'static str, String>,
) -> Result<String, String> {
    value
        .map(|value| normalize(&value).map(str::to_string))
        .transpose()
        .map(|value| value.unwrap_or(existing))
}

fn normalize_profile_json_update(
    value: Option<String>,
    existing: String,
    code: &str,
    field: &str,
    max_bytes: usize,
) -> Result<String, String> {
    value
        .map(|value| normalize_profile_json(code, field, &value, max_bytes))
        .transpose()
        .map(|value| value.unwrap_or(existing))
}

fn normalize_profile_ms_update(
    value: Option<i64>,
    existing: Option<i64>,
    code: &str,
    field: &str,
) -> Result<Option<i64>, String> {
    value
        .map(|value| normalize_non_negative_ms(code, field, value))
        .transpose()
        .map(|value| value.or(existing))
}

fn normalize_profile_secret_ref(value: Option<String>) -> Result<Option<String>, String> {
    value
        .map(|value| {
            let secret_ref = validate_profile_secret_ref(&value)?;
            Ok(secret_ref.to_string())
        })
        .transpose()
}

fn normalize_profile_task_families(value: Vec<String>) -> Result<Vec<String>, String> {
    if value.is_empty() {
        return Err("invalid-task-families: taskFamilies must not be empty".to_string());
    }
    let mut task_families = Vec::new();
    for task_family in value {
        let normalized = normalize_profile_text(
            "invalid-task-family",
            "taskFamilies",
            &task_family,
            MAX_PROFILE_TASK_FAMILY_BYTES,
        )?;
        if !task_families.contains(&normalized) {
            task_families.push(normalized);
        }
    }
    let serialized = serialize_profile_task_families(&task_families)?;
    if serialized.len() > MAX_PROFILE_TASK_FAMILIES_BYTES {
        Err(format!(
            "invalid-task-families: taskFamilies must serialize to at most {MAX_PROFILE_TASK_FAMILIES_BYTES} bytes"
        ))
    } else {
        Ok(task_families)
    }
}

fn serialize_profile_task_families(value: &[String]) -> Result<String, String> {
    serde_json::to_string(value).map_err(|err| format!("invalid-task-families: {err}"))
}

fn normalize_profile_concurrency(value: Option<i64>) -> Result<i64, String> {
    let value = value.unwrap_or(1);
    if (1..=MAX_PROFILE_CONCURRENCY).contains(&value) {
        Ok(value)
    } else {
        Err(format!(
            "invalid-max-concurrency: maxConcurrency must be between 1 and {MAX_PROFILE_CONCURRENCY}"
        ))
    }
}

fn normalize_profile_pool_ttl(ttl_ms: Option<i64>) -> Result<i64, String> {
    let ttl_ms = ttl_ms.unwrap_or(DEFAULT_LEASE_TTL_MS);
    if (MIN_PROFILE_POOL_TTL_MS..=MAX_PROFILE_POOL_TTL_MS).contains(&ttl_ms) {
        Ok(ttl_ms)
    } else {
        Err(format!(
            "invalid-ttl: ttlMs must be between {MIN_PROFILE_POOL_TTL_MS} and {MAX_PROFILE_POOL_TTL_MS}"
        ))
    }
}

fn normalize_profile_pool_breaker_duration(
    code: &str,
    field: &str,
    value: i64,
) -> Result<i64, String> {
    if (1..=MAX_PROFILE_POOL_BREAKER_MS).contains(&value) {
        Ok(value)
    } else {
        Err(format!(
            "{code}: {field} must be between 1 and {MAX_PROFILE_POOL_BREAKER_MS}"
        ))
    }
}

fn checked_profile_pool_deadline(now: i64, duration_ms: i64, code: &str) -> Result<i64, String> {
    now.checked_add(duration_ms)
        .ok_or_else(|| format!("{code}: profile pool deadline overflow"))
}

fn normalize_profile_pool_outcome(raw: &str) -> Result<&'static str, String> {
    match raw.trim() {
        "success" => Ok("success"),
        "rate-limited" => Ok("rate-limited"),
        "error" => Ok("error"),
        _ => Err("invalid-outcome: outcome must be success, rate-limited, or error".to_string()),
    }
}

fn profile_claim_inactive_error(err: &str) -> bool {
    err.starts_with(PROFILE_CLAIM_INACTIVE_PREFIX)
}

fn normalize_preferred_profile_ids(value: Option<Vec<String>>) -> Result<Vec<String>, String> {
    let mut ids = Vec::new();
    for raw in value.unwrap_or_default() {
        let Ok(profile_id) = normalize_profile_text(
            "invalid-profile-id",
            "preferredProfileIds",
            &raw,
            MAX_PROFILE_ID_BYTES,
        ) else {
            continue;
        };
        if !ids.contains(&profile_id) {
            ids.push(profile_id);
        }
    }
    Ok(ids)
}

fn sanitize_profile_pool_optional_text(value: Option<String>) -> Result<Option<String>, String> {
    let Some(value) = value else {
        return Ok(None);
    };
    let redacted = sanitize_profile_pool_text_for_log(&value);
    if redacted.is_empty() {
        return Ok(None);
    }
    Ok(Some(redacted))
}

/// Redacts profile-pool diagnostic text before it reaches logs or UI payloads.
pub(crate) fn sanitize_profile_pool_text_for_log(value: &str) -> String {
    let normalized = value
        .chars()
        .map(|value| if value.is_control() { ' ' } else { value })
        .collect::<String>();
    let trimmed = normalized.split_whitespace().collect::<Vec<_>>().join(" ");
    if trimmed.is_empty() {
        return String::new();
    }
    truncate_profile_pool_text(&redact_profile_pool_text(&trimmed))
}

fn redact_profile_pool_text(value: &str) -> String {
    let mut redact_next = false;
    value
        .split_whitespace()
        .map(|token| {
            let lower = token.to_ascii_lowercase();
            let has_secret_ref = lower.contains("llm-wiki-profile-secret:");
            let has_google_api_key = lower.starts_with("aiza")
                || lower.contains("=aiza")
                || lower.contains(":aiza")
                || lower.contains("\"aiza")
                || lower.contains("'aiza");
            let has_sk_secret = lower.starts_with("sk-")
                || lower.contains("=sk-")
                || lower.contains(":sk-")
                || lower.contains("\"sk-")
                || lower.contains("'sk-");
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
            let redacted = redact_next
                || has_secret_ref
                || has_google_api_key
                || has_sk_secret
                || has_bearer
                || has_authorization
                || has_api_key;
            redact_next = has_bearer || has_authorization || has_api_key;
            if redacted {
                "[REDACTED]"
            } else {
                token
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn truncate_profile_pool_text(value: &str) -> String {
    if value.len() <= MAX_PROFILE_POOL_REASON_BYTES {
        return value.to_string();
    }
    let mut end = MAX_PROFILE_POOL_REASON_BYTES;
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    value[..end].to_string()
}

fn profile_pool_profile_eligible(
    tx: &Transaction<'_>,
    profile: &RuntimeProfileRecord,
    kind: &str,
    task_family: &str,
    now: i64,
) -> Result<bool, String> {
    if !profile_pool_profile_base_eligible(tx, profile, kind, task_family, now)? {
        return Ok(false);
    }
    let active_count = active_profile_claim_count_tx(tx, &profile.profile_id, now)?;
    Ok(active_count < profile.max_concurrency)
}

fn profile_pool_profile_base_eligible(
    tx: &Transaction<'_>,
    profile: &RuntimeProfileRecord,
    kind: &str,
    task_family: &str,
    now: i64,
) -> Result<bool, String> {
    if !profile.enabled
        || profile.kind != kind
        || !profile
            .task_families
            .iter()
            .any(|value| value == task_family)
        || profile.capability_version != PROFILE_PROBE_CAPABILITY_VERSION
        || !matches!(profile.capability_status.as_str(), "supported" | "limited")
        || !capability_json_supports_kind(&profile.capability_json, kind)
        || profile
            .probe_backoff_until_ms
            .is_some_and(|value| value > now)
        || profile_circuit_breaker_open_tx(tx, &profile.profile_id, now)?
    {
        return Ok(false);
    }
    Ok(true)
}

fn capability_json_supports_kind(capability_json: &str, kind: &str) -> bool {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(capability_json) else {
        return false;
    };
    match kind {
        "model-call" => value
            .get("modelCallSupported")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false),
        "agent-run" => value
            .get("agentRunSupported")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false),
        _ => false,
    }
}

fn select_profile_pool_candidate<'a>(
    eligible: &'a [RuntimeProfileRecord],
    preferred_profile_ids: &[String],
) -> Option<&'a RuntimeProfileRecord> {
    for preferred_profile_id in preferred_profile_ids {
        if let Some(profile) = eligible
            .iter()
            .find(|profile| &profile.profile_id == preferred_profile_id)
        {
            return Some(profile);
        }
    }
    eligible.first()
}

fn profile_pool_progress_key(claim_id: &str) -> String {
    format!("profile-pool:{claim_id}")
}

fn profile_pool_claim_event_payload(
    claim_id: &str,
    profile_id: &str,
    kind: &str,
    task_family: &str,
    holder: &str,
    expires_at_ms: i64,
) -> Result<String, String> {
    profile_pool_payload(serde_json::json!({
        "claimId": claim_id,
        "profileId": profile_id,
        "kind": kind,
        "taskFamily": task_family,
        "holder": holder,
        "expiresAtMs": expires_at_ms
    }))
}

fn profile_pool_release_event_payload(
    claim: &RuntimeProfileClaimRecord,
    outcome: &str,
    breaker_until_ms: Option<i64>,
    reason: Option<&str>,
) -> Result<String, String> {
    profile_pool_payload(serde_json::json!({
        "claimId": claim.claim_id,
        "profileId": claim.profile_id,
        "kind": claim.kind,
        "taskFamily": claim.task_family,
        "outcome": outcome,
        "breakerUntilMs": breaker_until_ms,
        "reason": reason
    }))
}

fn profile_pool_progress_payload(
    claim_id: &str,
    profile_id: &str,
    status: &str,
    expires_at_ms: i64,
    breaker_until_ms: Option<i64>,
) -> Result<String, String> {
    profile_pool_payload(serde_json::json!({
        "claimId": claim_id,
        "profileId": profile_id,
        "status": status,
        "expiresAtMs": expires_at_ms,
        "breakerUntilMs": breaker_until_ms
    }))
}

fn profile_pool_payload(value: serde_json::Value) -> Result<String, String> {
    let payload = value.to_string();
    require_event_payload(&payload)?;
    Ok(payload)
}

fn normalize_profile_json(
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

fn normalize_non_negative_ms(code: &str, field: &str, value: i64) -> Result<i64, String> {
    if value >= 0 {
        Ok(value)
    } else {
        Err(format!("{code}: {field} must be non-negative"))
    }
}

fn bool_to_i64(value: bool) -> i64 {
    if value {
        1
    } else {
        0
    }
}

fn require_enabled_project(project_root: Option<&Path>, enabled: bool) -> Result<&Path, String> {
    if !enabled {
        return Err("runtime-disabled: work runtime is disabled".to_string());
    }
    project_root.ok_or_else(|| "no-project: no project root is open".to_string())
}

fn now_for_enabled_project(project_root: Option<&Path>, enabled: bool) -> Result<i64, String> {
    require_enabled_project(project_root, enabled)?;
    now_ms()
}

fn require_non_empty<'a>(code: &str, field: &str, value: &'a str) -> Result<&'a str, String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        Err(format!("{code}: {field} must not be empty"))
    } else {
        Ok(trimmed)
    }
}

fn require_required_non_empty<'a>(
    code: &str,
    field: &str,
    value: Option<&'a str>,
) -> Result<&'a str, String> {
    let value = value.ok_or_else(|| format!("{code}: {field} is required"))?;
    require_non_empty(code, field, value)
}

fn require_event_payload(value: &str) -> Result<&str, String> {
    let payload = require_non_empty("invalid-payload", "payload", value)?;
    if payload.len() > MAX_EVENT_PAYLOAD_BYTES {
        Err(format!(
            "invalid-payload: payload must be at most {MAX_EVENT_PAYLOAD_BYTES} bytes"
        ))
    } else {
        Ok(payload)
    }
}

fn require_limited_non_empty<'a>(
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

fn normalize_optional_limited_text(
    code: &str,
    field: &str,
    value: Option<String>,
    max_bytes: usize,
) -> Result<Option<String>, String> {
    value
        .map(|value| require_limited_non_empty(code, field, &value, max_bytes).map(str::to_string))
        .transpose()
}

fn normalize_optional_id(
    code: &str,
    field: &str,
    value: Option<String>,
) -> Result<Option<String>, String> {
    value
        .map(|value| require_non_empty(code, field, &value).map(str::to_string))
        .transpose()
}

fn normalize_optional_filter(
    code: &str,
    field: &str,
    value: Option<String>,
) -> Result<Option<String>, String> {
    normalize_optional_id(code, field, value)
}

fn normalize_list_limit(
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

fn normalize_commit_budget_ttl(ttl_ms: Option<i64>) -> Result<i64, String> {
    let ttl_ms = ttl_ms.unwrap_or(DEFAULT_LEASE_TTL_MS);
    if !(MIN_COMMIT_BUDGET_TTL_MS..=MAX_COMMIT_BUDGET_TTL_MS).contains(&ttl_ms) {
        Err(format!(
            "invalid-ttl: ttlMs must be between {MIN_COMMIT_BUDGET_TTL_MS} and {MAX_COMMIT_BUDGET_TTL_MS}"
        ))
    } else {
        Ok(ttl_ms)
    }
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

fn normalize_affected_path(raw: &str) -> Result<NormalizedAffectedPath, String> {
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

fn ensure_claim_id_available(tx: &Transaction<'_>, claim_id: &str) -> Result<(), String> {
    let existing = tx
        .query_row(
            "SELECT COUNT(*)
             FROM runtime_resource_budget_claims
             WHERE claim_id = ?1",
            [claim_id],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|err| format!("claim-id-check-failed: {err}"))?;
    if existing == 0 {
        Ok(())
    } else {
        Err("claim-id-conflict: commit budget claim id already exists".to_string())
    }
}

fn ensure_profile_claim_id_available_tx(
    tx: &Transaction<'_>,
    claim_id: &str,
) -> Result<(), String> {
    let existing = tx
        .query_row(
            "SELECT COUNT(*)
             FROM runtime_profile_claims
             WHERE claim_id = ?1",
            [claim_id],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|err| format!("profile-pool-claim-id-check-failed: {err}"))?;
    if existing == 0 {
        Ok(())
    } else {
        Err("claim-id-conflict: profile pool claim id already exists".to_string())
    }
}

fn expire_profile_claims_tx(tx: &Transaction<'_>, now: i64) -> Result<(), String> {
    tx.execute(
        "UPDATE runtime_profile_claims
         SET status = ?2
         WHERE status = ?1 AND expires_at_ms <= ?3",
        params![ACTIVE_CLAIM_STATUS, EXPIRED_CLAIM_STATUS, now],
    )
    .map_err(|err| format!("profile-pool-expire-claims-failed: {err}"))?;
    Ok(())
}

fn active_profile_claim_count_tx(
    tx: &Transaction<'_>,
    profile_id: &str,
    now: i64,
) -> Result<i64, String> {
    tx.query_row(
        "SELECT COUNT(*)
         FROM runtime_profile_claims
         WHERE profile_id = ?1
           AND status = ?2
           AND expires_at_ms > ?3",
        params![profile_id, ACTIVE_CLAIM_STATUS, now],
        |row| row.get(0),
    )
    .map_err(|err| format!("profile-pool-active-count-failed: {err}"))
}

fn profile_circuit_breaker_open_tx(
    tx: &Transaction<'_>,
    profile_id: &str,
    now: i64,
) -> Result<bool, String> {
    tx.query_row(
        "SELECT 1
         FROM runtime_profile_circuit_breakers
         WHERE profile_id = ?1 AND open_until_ms > ?2
         LIMIT 1",
        params![profile_id, now],
        |_| Ok(()),
    )
    .optional()
    .map(|value| value.is_some())
    .map_err(|err| format!("profile-pool-breaker-check-failed: {err}"))
}

fn clear_profile_circuit_breaker_tx(tx: &Transaction<'_>, profile_id: &str) -> Result<(), String> {
    tx.execute(
        "DELETE FROM runtime_profile_circuit_breakers WHERE profile_id = ?1",
        [profile_id],
    )
    .map_err(|err| format!("profile-pool-breaker-clear-failed: {err}"))?;
    Ok(())
}

fn upsert_profile_circuit_breaker_tx(
    tx: &Transaction<'_>,
    profile_id: &str,
    status: &str,
    reason: Option<&str>,
    error: Option<&str>,
    now: i64,
    open_until_ms: i64,
) -> Result<(), String> {
    tx.execute(
        "INSERT INTO runtime_profile_circuit_breakers (
            profile_id,
            status,
            reason,
            error,
            opened_at_ms,
            open_until_ms,
            updated_at_ms
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?5)
         ON CONFLICT(profile_id) DO UPDATE SET
            status = excluded.status,
            reason = excluded.reason,
            error = excluded.error,
            opened_at_ms = excluded.opened_at_ms,
            open_until_ms = excluded.open_until_ms,
            updated_at_ms = excluded.updated_at_ms",
        params![profile_id, status, reason, error, now, open_until_ms],
    )
    .map_err(|err| format!("profile-pool-breaker-upsert-failed: {err}"))?;
    Ok(())
}

fn ensure_job_exists(tx: &Transaction<'_>, job_id: &str) -> Result<(), String> {
    let exists = tx
        .query_row(
            "SELECT 1 FROM runtime_jobs WHERE job_id = ?1 LIMIT 1",
            [job_id],
            |_| Ok(()),
        )
        .optional()
        .map_err(|err| format!("job-check-failed: {err}"))?
        .is_some();
    if exists {
        Ok(())
    } else {
        Err("job-not-found: runtime job does not exist".to_string())
    }
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

fn ensure_path_budget(
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

fn ensure_commit_total_capacity(tx: &Transaction<'_>) -> Result<(), String> {
    let capacity = tx
        .query_row(
            "SELECT capacity
             FROM runtime_resource_budgets
             WHERE scope = ?1 AND resource_key = ?2",
            params![COMMIT_TOTAL_SCOPE, COMMIT_TOTAL_RESOURCE_KEY],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|err| format!("commit-total-budget-read-failed: {err}"))?;
    let active_amount = tx
        .query_row(
            "SELECT COALESCE(SUM(amount), 0)
             FROM runtime_resource_budget_claims
             WHERE scope = ?1 AND resource_key = ?2 AND status = ?3",
            params![
                COMMIT_TOTAL_SCOPE,
                COMMIT_TOTAL_RESOURCE_KEY,
                ACTIVE_CLAIM_STATUS
            ],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|err| format!("commit-total-budget-sum-failed: {err}"))?;
    if active_amount + COMMIT_BUDGET_AMOUNT <= capacity {
        Ok(())
    } else {
        Err("commit-total-budget-exhausted: commit total budget is exhausted".to_string())
    }
}

fn ensure_commit_path_available(tx: &Transaction<'_>, resource_key: &str) -> Result<(), String> {
    let active_count = tx
        .query_row(
            "SELECT COUNT(*)
             FROM runtime_resource_budget_claims
             WHERE scope = ?1 AND resource_key = ?2 AND status = ?3",
            params![COMMIT_PATH_SCOPE, resource_key, ACTIVE_CLAIM_STATUS],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|err| format!("commit-path-budget-check-failed: {err}"))?;
    if active_count == 0 {
        Ok(())
    } else {
        Err("commit-path-already-claimed: commit path budget is already claimed".to_string())
    }
}

fn insert_commit_budget_claim_row(
    tx: &Transaction<'_>,
    claim_id: &str,
    scope: &str,
    resource_key: &str,
    display_key: &str,
    job_id: Option<&str>,
    holder: &str,
    now: i64,
    expires_at_ms: i64,
) -> Result<(), String> {
    tx.execute(
        "INSERT INTO runtime_resource_budget_claims (
            claim_id,
            scope,
            resource_key,
            display_key,
            job_id,
            holder,
            amount,
            acquired_at_ms,
            expires_at_ms,
            status
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        params![
            claim_id,
            scope,
            resource_key,
            display_key,
            job_id,
            holder,
            COMMIT_BUDGET_AMOUNT,
            now,
            expires_at_ms,
            ACTIVE_CLAIM_STATUS
        ],
    )
    .map_err(|err| format!("commit-budget-claim-insert-failed: {err}"))?;
    Ok(())
}

fn ensure_claim_pair(claims: &[RuntimeResourceBudgetClaimRecord]) -> Result<(), String> {
    if claims.len() != 2 {
        return Err(
            "claim-inconsistent: commit budget claim must contain exactly two active rows"
                .to_string(),
        );
    }
    let has_total = claims.iter().any(|claim| {
        claim.scope == COMMIT_TOTAL_SCOPE && claim.resource_key == COMMIT_TOTAL_RESOURCE_KEY
    });
    let has_path = claims.iter().any(|claim| claim.scope == COMMIT_PATH_SCOPE);
    if has_total && has_path {
        Ok(())
    } else {
        Err("claim-inconsistent: commit budget claim must include total and path rows".to_string())
    }
}

fn update_claim_status(
    tx: &Transaction<'_>,
    claim_id: &str,
    status: &str,
    now: i64,
) -> Result<usize, String> {
    tx.execute(
        "UPDATE runtime_resource_budget_claims
         SET status = ?2,
             released_at_ms = CASE WHEN ?2 = 'released' THEN ?3 ELSE released_at_ms END
         WHERE claim_id = ?1 AND status = ?4",
        params![claim_id, status, now, ACTIVE_CLAIM_STATUS],
    )
    .map_err(|err| format!("commit-budget-claim-update-failed: {err}"))
}

fn ensure_no_active_lease(tx: &Transaction<'_>, job_id: &str) -> Result<(), String> {
    let active_count = tx
        .query_row(
            "SELECT COUNT(*)
             FROM runtime_job_leases
             WHERE job_id = ?1 AND status = 'active'",
            [job_id],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|err| format!("active-lease-check-failed: {err}"))?;
    if active_count == 0 {
        Ok(())
    } else {
        Err("active-lease-exists: job already has an active lease".to_string())
    }
}

fn ensure_active_running_lease(
    tx: &Transaction<'_>,
    job_id: &str,
    lease_id: &str,
    now: Option<i64>,
) -> Result<(), String> {
    let state: Option<String> = tx
        .query_row(
            "SELECT state FROM runtime_jobs WHERE job_id = ?1",
            [job_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|err| format!("job-state-check-failed: {err}"))?;
    let Some(state) = state else {
        return Err("job-not-found: runtime job does not exist".to_string());
    };
    if state != "running" {
        return Err(format!(
            "invalid-transition: active lease operation requires running job, got '{state}'"
        ));
    }

    let lease: Option<(String, i64)> = tx
        .query_row(
            "SELECT status, expires_at_ms
             FROM runtime_job_leases
             WHERE job_id = ?1 AND lease_id = ?2",
            params![job_id, lease_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(|err| format!("lease-status-check-failed: {err}"))?;
    match lease {
        Some((status, expires_at_ms)) if status == ACTIVE_LEASE_STATUS => {
            if now.is_some_and(|now| expires_at_ms <= now) {
                Err("lease-expired: active lease has already expired".to_string())
            } else {
                Ok(())
            }
        }
        Some((status, _)) => Err(format!(
            "inactive-lease: lease is '{status}' and cannot mutate the job"
        )),
        None => Err("lease-not-found: active lease does not exist".to_string()),
    }
}

fn release_lease(
    tx: &Transaction<'_>,
    job_id: &str,
    lease_id: &str,
    status: &str,
    now: i64,
) -> Result<(), String> {
    let updated = tx
        .execute(
            "UPDATE runtime_job_leases
             SET status = ?3,
                 released_at_ms = ?4
             WHERE job_id = ?1 AND lease_id = ?2 AND status = 'active'",
            params![job_id, lease_id, status, now],
        )
        .map_err(|err| format!("lease-release-failed: {err}"))?;
    if updated == 1 {
        Ok(())
    } else {
        Err("inactive-lease: active lease was not released".to_string())
    }
}

fn insert_runtime_event_tx(
    tx: &Transaction<'_>,
    event_id: Option<&str>,
    job_id: &str,
    event_name: &str,
    payload: &str,
    now: i64,
) -> Result<String, String> {
    let event_id = event_id
        .map(str::to_string)
        .unwrap_or_else(|| Uuid::new_v4().to_string());
    tx.execute(
        "INSERT INTO runtime_events (
            event_id,
            job_id,
            event_name,
            payload,
            created_at_ms
        ) VALUES (?1, ?2, ?3, ?4, ?5)",
        params![event_id, job_id, event_name, payload, now],
    )
    .map_err(|err| format!("event-insert-failed: {err}"))?;
    Ok(event_id)
}

fn upsert_runtime_progress_tx(
    tx: &Transaction<'_>,
    job_id: &str,
    progress_key: &str,
    payload: &str,
    now: i64,
    last_event_id: Option<&str>,
) -> Result<(), String> {
    tx.execute(
        "INSERT INTO runtime_progress (
            job_id,
            progress_key,
            payload,
            updated_at_ms,
            last_event_id
        ) VALUES (?1, ?2, ?3, ?4, ?5)
        ON CONFLICT(job_id, progress_key) DO UPDATE SET
            payload = excluded.payload,
            updated_at_ms = excluded.updated_at_ms,
            last_event_id = CASE
                WHEN excluded.last_event_id IS NULL
                THEN runtime_progress.last_event_id
                ELSE excluded.last_event_id
            END",
        params![job_id, progress_key, payload, now, last_event_id],
    )
    .map_err(|err| format!("progress-upsert-failed: {err}"))?;
    Ok(())
}

fn read_job(connection: &Connection, job_id: &str) -> Result<RuntimeJobRecord, String> {
    connection
        .query_row(&job_select_sql("WHERE job_id = ?1"), [job_id], map_job_row)
        .map_err(|err| format!("job-read-failed: {err}"))
}

fn read_job_tx(tx: &Transaction<'_>, job_id: &str) -> Result<RuntimeJobRecord, String> {
    tx.query_row(&job_select_sql("WHERE job_id = ?1"), [job_id], map_job_row)
        .map_err(|err| format!("job-read-failed: {err}"))
}

fn read_lease_tx(tx: &Transaction<'_>, lease_id: &str) -> Result<RuntimeJobLeaseRecord, String> {
    tx.query_row(
        &lease_select_sql("WHERE lease_id = ?1"),
        [lease_id],
        map_lease_row,
    )
    .map_err(|err| format!("lease-read-failed: {err}"))
}

fn read_jobs(connection: &Connection) -> Result<Vec<RuntimeJobRecord>, String> {
    let mut statement = connection
        .prepare(&job_select_sql("ORDER BY created_at_ms ASC, job_id ASC"))
        .map_err(|err| format!("jobs-read-prepare-failed: {err}"))?;
    let rows = statement
        .query_map([], map_job_row)
        .map_err(|err| format!("jobs-read-failed: {err}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|err| format!("jobs-read-failed: {err}"))
}

fn read_leases(connection: &Connection) -> Result<Vec<RuntimeJobLeaseRecord>, String> {
    let mut statement = connection
        .prepare(&lease_select_sql(
            "ORDER BY acquired_at_ms ASC, lease_id ASC",
        ))
        .map_err(|err| format!("leases-read-prepare-failed: {err}"))?;
    let rows = statement
        .query_map([], map_lease_row)
        .map_err(|err| format!("leases-read-failed: {err}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|err| format!("leases-read-failed: {err}"))
}

fn read_resource_budgets(
    connection: &Connection,
) -> Result<Vec<RuntimeResourceBudgetRecord>, String> {
    let mut statement = connection
        .prepare(&resource_budget_select_sql(
            "ORDER BY scope ASC, resource_key ASC",
        ))
        .map_err(|err| format!("resource-budgets-read-prepare-failed: {err}"))?;
    let rows = statement
        .query_map([], map_resource_budget_row)
        .map_err(|err| format!("resource-budgets-read-failed: {err}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|err| format!("resource-budgets-read-failed: {err}"))
}

fn read_active_resource_claims(
    connection: &Connection,
) -> Result<Vec<RuntimeResourceBudgetClaimRecord>, String> {
    let mut statement = connection
        .prepare(&resource_claim_select_sql(
            "WHERE status = 'active' ORDER BY acquired_at_ms ASC, claim_id ASC, scope ASC",
        ))
        .map_err(|err| format!("resource-claims-read-prepare-failed: {err}"))?;
    let rows = statement
        .query_map([], map_resource_claim_row)
        .map_err(|err| format!("resource-claims-read-failed: {err}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|err| format!("resource-claims-read-failed: {err}"))
}

fn read_claims_by_id_tx(
    tx: &Transaction<'_>,
    claim_id: &str,
) -> Result<Vec<RuntimeResourceBudgetClaimRecord>, String> {
    let mut statement = tx
        .prepare(&resource_claim_select_sql(
            "WHERE claim_id = ?1 ORDER BY scope ASC, resource_key ASC",
        ))
        .map_err(|err| format!("resource-claims-read-prepare-failed: {err}"))?;
    let rows = statement
        .query_map([claim_id], map_resource_claim_row)
        .map_err(|err| format!("resource-claims-read-failed: {err}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|err| format!("resource-claims-read-failed: {err}"))
}

fn read_active_claims_by_id_tx(
    tx: &Transaction<'_>,
    claim_id: &str,
) -> Result<Vec<RuntimeResourceBudgetClaimRecord>, String> {
    let mut statement = tx
        .prepare(&resource_claim_select_sql(
            "WHERE claim_id = ?1 AND status = 'active'
             ORDER BY scope ASC, resource_key ASC",
        ))
        .map_err(|err| format!("resource-claims-read-prepare-failed: {err}"))?;
    let rows = statement
        .query_map([claim_id], map_resource_claim_row)
        .map_err(|err| format!("resource-claims-read-failed: {err}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|err| format!("resource-claims-read-failed: {err}"))
}

fn read_event_tx(tx: &Transaction<'_>, event_id: &str) -> Result<RuntimeEventRecord, String> {
    tx.query_row(
        &event_select_sql("WHERE event_id = ?1"),
        [event_id],
        map_event_row,
    )
    .map_err(|err| format!("event-read-failed: {err}"))
}

fn read_progress_tx(
    tx: &Transaction<'_>,
    job_id: &str,
    progress_key: &str,
) -> Result<RuntimeProgressRecord, String> {
    tx.query_row(
        &progress_select_sql("WHERE job_id = ?1 AND progress_key = ?2"),
        params![job_id, progress_key],
        map_progress_row,
    )
    .map_err(|err| format!("progress-read-failed: {err}"))
}

fn read_progress_optional_tx(
    tx: &Transaction<'_>,
    job_id: &str,
    progress_key: &str,
) -> Result<Option<RuntimeProgressRecord>, String> {
    tx.query_row(
        &progress_select_sql("WHERE job_id = ?1 AND progress_key = ?2"),
        params![job_id, progress_key],
        map_progress_row,
    )
    .optional()
    .map_err(|err| format!("progress-read-failed: {err}"))
}

fn read_events(
    connection: &Connection,
    job_id: Option<&str>,
    limit: i64,
) -> Result<Vec<RuntimeEventRecord>, String> {
    let suffix = match job_id {
        Some(_) => "WHERE job_id = ?1 ORDER BY created_at_ms ASC, event_id ASC LIMIT ?2",
        None => "ORDER BY created_at_ms ASC, event_id ASC LIMIT ?1",
    };
    let mut statement = connection
        .prepare(&event_select_sql(suffix))
        .map_err(|err| format!("events-read-prepare-failed: {err}"))?;
    let rows = match job_id {
        Some(job_id) => statement
            .query_map(params![job_id, limit], map_event_row)
            .map_err(|err| format!("events-read-failed: {err}"))?,
        None => statement
            .query_map([limit], map_event_row)
            .map_err(|err| format!("events-read-failed: {err}"))?,
    };
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|err| format!("events-read-failed: {err}"))
}

fn read_progress_rows(
    connection: &Connection,
    job_id: Option<&str>,
    limit: i64,
) -> Result<Vec<RuntimeProgressRecord>, String> {
    let suffix = match job_id {
        Some(_) => {
            "WHERE job_id = ?1 ORDER BY updated_at_ms ASC, job_id ASC, progress_key ASC LIMIT ?2"
        }
        None => "ORDER BY updated_at_ms ASC, job_id ASC, progress_key ASC LIMIT ?1",
    };
    let mut statement = connection
        .prepare(&progress_select_sql(suffix))
        .map_err(|err| format!("progress-read-prepare-failed: {err}"))?;
    let rows = match job_id {
        Some(job_id) => statement
            .query_map(params![job_id, limit], map_progress_row)
            .map_err(|err| format!("progress-read-failed: {err}"))?,
        None => statement
            .query_map([limit], map_progress_row)
            .map_err(|err| format!("progress-read-failed: {err}"))?,
    };
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|err| format!("progress-read-failed: {err}"))
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

fn read_derived_marker_tx(
    tx: &Transaction<'_>,
    marker_id: &str,
) -> Result<RuntimeDerivedStaleMarkerRecord, String> {
    tx.query_row(
        &derived_marker_select_sql("WHERE marker_id = ?1"),
        [marker_id],
        map_derived_marker_row,
    )
    .map_err(|err| format!("derived-marker-read-failed: {err}"))
}

fn read_derived_markers(
    connection: &Connection,
    layer: Option<&str>,
    affected_path: Option<&str>,
    status: Option<&str>,
    limit: i64,
) -> Result<Vec<RuntimeDerivedStaleMarkerRecord>, String> {
    let mut filters = Vec::new();
    let mut values: Vec<Box<dyn ToSql>> = Vec::new();
    if let Some(layer) = layer {
        filters.push("layer = ?");
        values.push(Box::new(layer.to_string()));
    }
    if let Some(affected_path) = affected_path {
        filters.push("affected_path = ?");
        values.push(Box::new(affected_path.to_string()));
    }
    if let Some(status) = status {
        filters.push("status = ?");
        values.push(Box::new(status.to_string()));
    }
    let suffix = if filters.is_empty() {
        "ORDER BY marked_at_ms ASC, marker_id ASC LIMIT ?".to_string()
    } else {
        format!(
            "WHERE {} ORDER BY marked_at_ms ASC, marker_id ASC LIMIT ?",
            filters.join(" AND ")
        )
    };
    values.push(Box::new(limit));
    let params = values.iter().map(|value| value.as_ref());
    let mut statement = connection
        .prepare(&derived_marker_select_sql(&suffix))
        .map_err(|err| format!("derived-markers-read-prepare-failed: {err}"))?;
    let rows = statement
        .query_map(params_from_iter(params), map_derived_marker_row)
        .map_err(|err| format!("derived-markers-read-failed: {err}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|err| format!("derived-markers-read-failed: {err}"))
}

fn read_profile(connection: &Connection, profile_id: &str) -> Result<RuntimeProfileRecord, String> {
    let select_sql = profile_select_sql_for_connection(connection, "WHERE profile_id = ?1")?;
    connection
        .query_row(&select_sql, [profile_id], map_profile_row)
        .map_err(|err| format!("profile-read-failed: {err}"))
}

fn read_visible_profile(
    connection: &Connection,
    profile_id: &str,
) -> Result<RuntimeProfileRecord, String> {
    // List/status may inspect an old runtime DB read-only before any writer has migrated it.
    if !column_exists(connection, "runtime_model_profiles", "deleted_at_ms")? {
        return read_profile(connection, profile_id);
    }
    let select_sql = profile_select_sql_for_connection(
        connection,
        "WHERE profile_id = ?1 AND deleted_at_ms IS NULL",
    )?;
    connection
        .query_row(&select_sql, [profile_id], map_profile_row)
        .optional()
        .map_err(|err| format!("profile-read-failed: {err}"))
        .and_then(|profile| {
            profile.ok_or_else(|| {
                "profile-not-found: runtime model profile does not exist".to_string()
            })
        })
}

fn read_visible_profile_tx(
    tx: &Transaction<'_>,
    profile_id: &str,
) -> Result<RuntimeProfileRecord, String> {
    // Writer transactions run after schema initialization, so deleted_at_ms is guaranteed.
    tx.query_row(
        &profile_select_sql("WHERE profile_id = ?1 AND deleted_at_ms IS NULL"),
        [profile_id],
        map_profile_row,
    )
    .optional()
    .map_err(|err| format!("profile-read-failed: {err}"))
    .and_then(|profile| {
        profile.ok_or_else(|| "profile-not-found: runtime model profile does not exist".to_string())
    })
}

fn read_profiles(connection: &Connection) -> Result<Vec<RuntimeProfileRecord>, String> {
    let select_sql = profile_select_sql_for_connection(
        connection,
        "ORDER BY updated_at_ms ASC, profile_id ASC",
    )?;
    let mut statement = connection
        .prepare(&select_sql)
        .map_err(|err| format!("profiles-read-prepare-failed: {err}"))?;
    let rows = statement
        .query_map([], map_profile_row)
        .map_err(|err| format!("profiles-read-failed: {err}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|err| format!("profiles-read-failed: {err}"))
}

fn read_visible_profiles(connection: &Connection) -> Result<Vec<RuntimeProfileRecord>, String> {
    // List/status may inspect an old runtime DB read-only before any writer has migrated it.
    if !column_exists(connection, "runtime_model_profiles", "deleted_at_ms")? {
        return read_profiles(connection);
    }
    let select_sql = profile_select_sql_for_connection(
        connection,
        "WHERE deleted_at_ms IS NULL ORDER BY updated_at_ms ASC, profile_id ASC",
    )?;
    let mut statement = connection
        .prepare(&select_sql)
        .map_err(|err| format!("profiles-read-prepare-failed: {err}"))?;
    let rows = statement
        .query_map([], map_profile_row)
        .map_err(|err| format!("profiles-read-failed: {err}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|err| format!("profiles-read-failed: {err}"))
}

fn read_visible_profiles_tx(tx: &Transaction<'_>) -> Result<Vec<RuntimeProfileRecord>, String> {
    // Writer transactions run after schema initialization, so deleted_at_ms is guaranteed.
    let mut statement = tx
        .prepare(&profile_select_sql(
            "WHERE deleted_at_ms IS NULL ORDER BY updated_at_ms ASC, profile_id ASC",
        ))
        .map_err(|err| format!("profiles-read-prepare-failed: {err}"))?;
    let rows = statement
        .query_map([], map_profile_row)
        .map_err(|err| format!("profiles-read-failed: {err}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|err| format!("profiles-read-failed: {err}"))
}

fn read_visible_profile_secret_ref_tx(
    tx: &Transaction<'_>,
    profile_id: &str,
) -> Result<Option<String>, String> {
    tx.query_row(
        "SELECT secret_ref
         FROM runtime_model_profiles
         WHERE profile_id = ?1 AND deleted_at_ms IS NULL",
        [profile_id],
        |row| row.get(0),
    )
    .optional()
    .map_err(|err| format!("profile-read-failed: {err}"))?
    .ok_or_else(|| "profile-not-found: runtime model profile does not exist".to_string())
}

fn read_profile_claim_tx(
    tx: &Transaction<'_>,
    claim_id: &str,
) -> Result<RuntimeProfileClaimRecord, String> {
    tx.query_row(
        &profile_claim_select_sql("WHERE claim_id = ?1"),
        [claim_id],
        map_profile_claim_row,
    )
    .map_err(|err| format!("profile-pool-claim-read-failed: {err}"))
}

fn read_active_profile_claim_by_id_tx(
    tx: &Transaction<'_>,
    claim_id: &str,
    now: i64,
) -> Result<Option<RuntimeProfileClaimRecord>, String> {
    tx.query_row(
        &profile_claim_select_sql(
            "WHERE claim_id = ?1 AND status = 'active' AND expires_at_ms > ?2",
        ),
        params![claim_id, now],
        map_profile_claim_row,
    )
    .optional()
    .map_err(|err| format!("profile-pool-claim-read-failed: {err}"))
}

fn read_active_profile_claims(
    connection: &Connection,
    now: i64,
    kind: Option<&str>,
    task_family: Option<&str>,
    job_id: Option<&str>,
) -> Result<Vec<RuntimeProfileClaimRecord>, String> {
    let mut filters = vec!["status = ?", "expires_at_ms > ?"];
    let mut values: Vec<Box<dyn ToSql>> =
        vec![Box::new(ACTIVE_CLAIM_STATUS.to_string()), Box::new(now)];
    if let Some(kind) = kind {
        filters.push("kind = ?");
        values.push(Box::new(kind.to_string()));
    }
    if let Some(task_family) = task_family {
        filters.push("task_family = ?");
        values.push(Box::new(task_family.to_string()));
    }
    if let Some(job_id) = job_id {
        filters.push("job_id = ?");
        values.push(Box::new(job_id.to_string()));
    }
    let suffix = format!(
        "WHERE {} ORDER BY acquired_at_ms ASC, claim_id ASC",
        filters.join(" AND ")
    );
    let params = values.iter().map(|value| value.as_ref());
    let mut statement = connection
        .prepare(&profile_claim_select_sql(&suffix))
        .map_err(|err| format!("profile-pool-claims-read-prepare-failed: {err}"))?;
    let rows = statement
        .query_map(params_from_iter(params), map_profile_claim_row)
        .map_err(|err| format!("profile-pool-claims-read-failed: {err}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|err| format!("profile-pool-claims-read-failed: {err}"))
}

fn read_profile_circuit_breaker_optional_tx(
    tx: &Transaction<'_>,
    profile_id: &str,
) -> Result<Option<RuntimeProfileCircuitBreakerRecord>, String> {
    tx.query_row(
        &profile_circuit_breaker_select_sql("WHERE profile_id = ?1"),
        [profile_id],
        map_profile_circuit_breaker_row,
    )
    .optional()
    .map_err(|err| format!("profile-pool-breaker-read-failed: {err}"))
}

fn read_open_profile_circuit_breakers(
    connection: &Connection,
    now: i64,
) -> Result<Vec<RuntimeProfileCircuitBreakerRecord>, String> {
    let mut statement = connection
        .prepare(&profile_circuit_breaker_select_sql(
            "WHERE open_until_ms > ?1 ORDER BY open_until_ms ASC, profile_id ASC",
        ))
        .map_err(|err| format!("profile-pool-breakers-read-prepare-failed: {err}"))?;
    let rows = statement
        .query_map([now], map_profile_circuit_breaker_row)
        .map_err(|err| format!("profile-pool-breakers-read-failed: {err}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|err| format!("profile-pool-breakers-read-failed: {err}"))
}

fn table_exists(connection: &Connection, table: &str) -> Result<bool, String> {
    connection
        .query_row(
            "SELECT 1
             FROM sqlite_master
             WHERE type = 'table' AND name = ?1
             LIMIT 1",
            [table],
            |_| Ok(()),
        )
        .optional()
        .map(|value| value.is_some())
        .map_err(|err| format!("table-exists-check-failed: {err}"))
}

fn column_exists(connection: &Connection, table: &str, column: &str) -> Result<bool, String> {
    connection
        .query_row(
            &format!("SELECT 1 FROM pragma_table_info('{table}') WHERE name = ?1 LIMIT 1"),
            [column],
            |_| Ok(()),
        )
        .optional()
        .map(|value| value.is_some())
        .map_err(|err| format!("column-exists-check-failed: {err}"))
}

fn staging_artifact_commit_metadata_columns_exist(
    connection: &Connection,
) -> Result<bool, String> {
    for column in ["target_path", "operation_intent", "base_hash", "source_kind"] {
        if !column_exists(connection, "runtime_staging_artifacts", column)? {
            return Ok(false);
        }
    }
    Ok(true)
}

fn ensure_column_exists(
    connection: &Connection,
    table: &str,
    column: &str,
    alter_sql: &str,
    label: &str,
) -> Result<(), String> {
    if column_exists(connection, table, column)? {
        return Ok(());
    }
    connection
        .execute(alter_sql, [])
        .map_err(|err| format!("Failed to add {label} column: {err}"))?;
    Ok(())
}

fn job_select_sql(suffix: &str) -> String {
    format!(
        "SELECT job_id,
                kind,
                payload,
                state,
                attempt,
                max_attempts,
                priority,
                created_at_ms,
                updated_at_ms,
                queued_at_ms,
                started_at_ms,
                completed_at_ms,
                failed_at_ms,
                cancelled_at_ms,
                retry_after_ms,
                last_error
         FROM runtime_jobs {suffix}"
    )
}

fn lease_select_sql(suffix: &str) -> String {
    format!(
        "SELECT lease_id,
                job_id,
                holder,
                acquired_at_ms,
                heartbeat_at_ms,
                expires_at_ms,
                released_at_ms,
                status
         FROM runtime_job_leases {suffix}"
    )
}

fn resource_budget_select_sql(suffix: &str) -> String {
    format!(
        "SELECT scope,
                resource_key,
                display_key,
                capacity,
                created_at_ms,
                updated_at_ms
         FROM runtime_resource_budgets {suffix}"
    )
}

fn resource_claim_select_sql(suffix: &str) -> String {
    format!(
        "SELECT claim_id,
                scope,
                resource_key,
                display_key,
                job_id,
                holder,
                amount,
                acquired_at_ms,
                expires_at_ms,
                released_at_ms,
                status
         FROM runtime_resource_budget_claims {suffix}"
    )
}

fn event_select_sql(suffix: &str) -> String {
    format!(
        "SELECT event_id,
                job_id,
                event_name,
                payload,
                created_at_ms
         FROM runtime_events {suffix}"
    )
}

fn progress_select_sql(suffix: &str) -> String {
    format!(
        "SELECT job_id,
                progress_key,
                payload,
                updated_at_ms,
                last_event_id
         FROM runtime_progress {suffix}"
    )
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

fn derived_marker_select_sql(suffix: &str) -> String {
    format!(
        "SELECT marker_id,
                layer,
                affected_path,
                input_hash,
                base_version,
                marked_at_ms,
                reason,
                source_event_id,
                status,
                updated_at_ms,
                last_error
         FROM runtime_derived_stale_markers {suffix}"
    )
}

fn profile_select_sql(suffix: &str) -> String {
    profile_select_sql_with_sdk_alias("agent_sdk_model_id", suffix)
}

fn legacy_profile_select_sql_without_sdk_alias(suffix: &str) -> String {
    profile_select_sql_with_sdk_alias("NULL AS agent_sdk_model_id", suffix)
}

fn profile_select_sql_with_sdk_alias(sdk_alias_column: &str, suffix: &str) -> String {
    format!(
        "SELECT profile_id,
                kind,
                display_name,
                provider_id,
                model_id,
                {sdk_alias_column},
                endpoint,
                api_mode,
                auth_style,
                secret_ref,
                enabled,
                task_families_json,
                max_concurrency,
                capability_status,
                capability_json,
                capability_version,
                capability_checked_at_ms,
                probe_backoff_until_ms,
                last_capability_error,
                created_at_ms,
                updated_at_ms
         FROM runtime_model_profiles {suffix}"
    )
}

fn profile_select_sql_for_connection(
    connection: &Connection,
    suffix: &str,
) -> Result<String, String> {
    if column_exists(connection, "runtime_model_profiles", "agent_sdk_model_id")? {
        Ok(profile_select_sql(suffix))
    } else {
        Ok(legacy_profile_select_sql_without_sdk_alias(suffix))
    }
}

fn profile_claim_select_sql(suffix: &str) -> String {
    format!(
        "SELECT claim_id,
                profile_id,
                kind,
                task_family,
                job_id,
                holder,
                acquired_at_ms,
                expires_at_ms,
                released_at_ms,
                status
         FROM runtime_profile_claims {suffix}"
    )
}

fn profile_circuit_breaker_select_sql(suffix: &str) -> String {
    format!(
        "SELECT profile_id,
                status,
                reason,
                error,
                opened_at_ms,
                open_until_ms,
                updated_at_ms
         FROM runtime_profile_circuit_breakers {suffix}"
    )
}

fn map_job_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<RuntimeJobRecord> {
    Ok(RuntimeJobRecord {
        job_id: row.get(0)?,
        kind: row.get(1)?,
        payload: row.get(2)?,
        state: row.get(3)?,
        attempt: row.get(4)?,
        max_attempts: row.get(5)?,
        priority: row.get(6)?,
        created_at_ms: row.get(7)?,
        updated_at_ms: row.get(8)?,
        queued_at_ms: row.get(9)?,
        started_at_ms: row.get(10)?,
        completed_at_ms: row.get(11)?,
        failed_at_ms: row.get(12)?,
        cancelled_at_ms: row.get(13)?,
        retry_after_ms: row.get(14)?,
        last_error: row.get(15)?,
    })
}

fn map_lease_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<RuntimeJobLeaseRecord> {
    Ok(RuntimeJobLeaseRecord {
        lease_id: row.get(0)?,
        job_id: row.get(1)?,
        holder: row.get(2)?,
        acquired_at_ms: row.get(3)?,
        heartbeat_at_ms: row.get(4)?,
        expires_at_ms: row.get(5)?,
        released_at_ms: row.get(6)?,
        status: row.get(7)?,
    })
}

fn map_resource_budget_row(
    row: &rusqlite::Row<'_>,
) -> rusqlite::Result<RuntimeResourceBudgetRecord> {
    Ok(RuntimeResourceBudgetRecord {
        scope: row.get(0)?,
        resource_key: row.get(1)?,
        display_key: row.get(2)?,
        capacity: row.get(3)?,
        created_at_ms: row.get(4)?,
        updated_at_ms: row.get(5)?,
    })
}

fn map_resource_claim_row(
    row: &rusqlite::Row<'_>,
) -> rusqlite::Result<RuntimeResourceBudgetClaimRecord> {
    Ok(RuntimeResourceBudgetClaimRecord {
        claim_id: row.get(0)?,
        scope: row.get(1)?,
        resource_key: row.get(2)?,
        display_key: row.get(3)?,
        job_id: row.get(4)?,
        holder: row.get(5)?,
        amount: row.get(6)?,
        acquired_at_ms: row.get(7)?,
        expires_at_ms: row.get(8)?,
        released_at_ms: row.get(9)?,
        status: row.get(10)?,
    })
}

fn map_event_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<RuntimeEventRecord> {
    Ok(RuntimeEventRecord {
        event_id: row.get(0)?,
        job_id: row.get(1)?,
        event_name: row.get(2)?,
        payload: row.get(3)?,
        created_at_ms: row.get(4)?,
    })
}

fn map_progress_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<RuntimeProgressRecord> {
    Ok(RuntimeProgressRecord {
        job_id: row.get(0)?,
        progress_key: row.get(1)?,
        payload: row.get(2)?,
        updated_at_ms: row.get(3)?,
        last_event_id: row.get(4)?,
    })
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

fn map_derived_marker_row(
    row: &rusqlite::Row<'_>,
) -> rusqlite::Result<RuntimeDerivedStaleMarkerRecord> {
    Ok(RuntimeDerivedStaleMarkerRecord {
        marker_id: row.get(0)?,
        layer: row.get(1)?,
        affected_path: row.get(2)?,
        input_hash: row.get(3)?,
        base_version: row.get(4)?,
        marked_at_ms: row.get(5)?,
        reason: row.get(6)?,
        source_event_id: row.get(7)?,
        status: row.get(8)?,
        updated_at_ms: row.get(9)?,
        last_error: row.get(10)?,
    })
}

fn map_profile_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<RuntimeProfileRecord> {
    Ok(RuntimeProfileRecord {
        profile_id: row.get(0)?,
        kind: row.get(1)?,
        display_name: row.get(2)?,
        provider_id: row.get(3)?,
        model_id: row.get(4)?,
        agent_sdk_model_id: row.get(5)?,
        endpoint: row.get(6)?,
        api_mode: row.get(7)?,
        auth_style: row.get(8)?,
        secret_ref: row.get(9)?,
        enabled: row.get::<_, i64>(10)? == 1,
        task_families: parse_profile_task_families(row.get(11)?)?,
        max_concurrency: row.get(12)?,
        capability_status: row.get(13)?,
        capability_json: row.get(14)?,
        capability_version: row.get(15)?,
        capability_checked_at_ms: row.get(16)?,
        probe_backoff_until_ms: row.get(17)?,
        last_capability_error: row.get(18)?,
        created_at_ms: row.get(19)?,
        updated_at_ms: row.get(20)?,
    })
}

fn map_profile_claim_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<RuntimeProfileClaimRecord> {
    Ok(RuntimeProfileClaimRecord {
        claim_id: row.get(0)?,
        profile_id: row.get(1)?,
        kind: row.get(2)?,
        task_family: row.get(3)?,
        job_id: row.get(4)?,
        holder: row.get(5)?,
        acquired_at_ms: row.get(6)?,
        expires_at_ms: row.get(7)?,
        released_at_ms: row.get(8)?,
        status: row.get(9)?,
    })
}

fn map_profile_circuit_breaker_row(
    row: &rusqlite::Row<'_>,
) -> rusqlite::Result<RuntimeProfileCircuitBreakerRecord> {
    Ok(RuntimeProfileCircuitBreakerRecord {
        profile_id: row.get(0)?,
        status: row.get(1)?,
        reason: row.get(2)?,
        error: row.get(3)?,
        opened_at_ms: row.get(4)?,
        open_until_ms: row.get(5)?,
        updated_at_ms: row.get(6)?,
    })
}

fn parse_profile_task_families(value: String) -> rusqlite::Result<Vec<String>> {
    serde_json::from_str(&value).map_err(|err| {
        rusqlite::Error::FromSqlConversionFailure(10, rusqlite::types::Type::Text, Box::new(err))
    })
}

fn tx_err(err: rusqlite::Error) -> String {
    format!("runtime-db-transaction-failed: {err}")
}

fn read_migrations(connection: &Connection) -> Result<Vec<RuntimeDbMigrationStatus>, String> {
    let mut statement = connection
        .prepare(
            "SELECT family, version, applied_at_ms
             FROM runtime_schema_migrations
             ORDER BY family",
        )
        .map_err(|err| format!("Failed to read runtime migrations: {err}"))?;

    let rows = statement
        .query_map([], |row| {
            Ok(RuntimeDbMigrationStatus {
                family: row.get(0)?,
                version: row.get(1)?,
                applied_at_ms: row.get(2)?,
            })
        })
        .map_err(|err| format!("Failed to read runtime migrations: {err}"))?;

    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|err| format!("Failed to read runtime migrations: {err}"))
}

fn now_ms() -> Result<i64, String> {
    let duration = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|err| format!("System clock is before Unix epoch: {err}"))?;
    i64::try_from(duration.as_millis()).map_err(|_| "Current time is too large".to_string())
}

fn path_to_string(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::fs;
    use std::sync::{Arc, Barrier, Mutex};
    use wiremock::matchers::{header, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn temp_project(label: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock before Unix epoch")
            .as_nanos();
        std::env::temp_dir().join(format!(
            "llm-wiki-runtime-db-{label}-{}-{nanos}",
            std::process::id()
        ))
    }

    fn read_migration(project_root: &Path) -> RuntimeDbMigrationStatus {
        read_migration_family(project_root, MIGRATIONS_FAMILY)
    }

    fn read_migration_family(project_root: &Path, family: &str) -> RuntimeDbMigrationStatus {
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
    struct TestSecretStore {
        values: Mutex<HashMap<String, String>>,
    }

    impl TestSecretStore {
        fn insert(&self, secret_ref: String, secret_value: &str) {
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

    struct FailingReadSecretStore;

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

    #[test]
    fn runtime_db_path_is_project_scoped() {
        assert_eq!(
            runtime_db_path(Path::new("/tmp/project")),
            PathBuf::from("/tmp/project/.llm-wiki/runtime/runtime.db")
        );
    }

    #[test]
    fn parse_work_runtime_enabled_accepts_only_truthy_values() {
        for value in ["1", "true", "TRUE", " yes ", "on"] {
            assert!(parse_work_runtime_enabled(Some(value)));
        }

        for value in [None, Some(""), Some("0"), Some("false"), Some("enabled")] {
            assert!(!parse_work_runtime_enabled(value));
        }
    }

    #[test]
    fn resolve_work_runtime_enabled_defaults_disabled_without_adapter_value() {
        assert!(!resolve_work_runtime_enabled(None));
        assert!(!resolve_work_runtime_enabled(Some("false".to_string())));
        assert!(resolve_work_runtime_enabled(Some("true".to_string())));
    }

    #[test]
    fn now_for_enabled_project_returns_disabled_before_no_project() {
        let error = now_for_enabled_project(None, false).expect_err("disabled wins");

        assert!(error.starts_with("runtime-disabled"));
    }

    #[test]
    fn disabled_health_does_not_create_runtime_dir() {
        let project = temp_project("disabled-no-touch");
        fs::create_dir_all(&project).expect("create temp project");

        let health =
            runtime_db_health_for_project(Some(&project), false).expect("disabled health succeeds");

        assert_eq!(health.status, RuntimeDbHealthState::Disabled);
        assert!(!project.join(RUNTIME_DIR).exists());
        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn disabled_health_does_not_open_existing_runtime_db() {
        let project = temp_project("disabled-existing-db");
        let runtime_dir = project.join(RUNTIME_DIR);
        fs::create_dir_all(&runtime_dir).expect("create runtime dir");
        let db_path = runtime_dir.join(RUNTIME_DB_FILE);
        fs::write(&db_path, b"not sqlite").expect("write sentinel db");

        let health =
            runtime_db_health_for_project(Some(&project), false).expect("disabled health succeeds");

        assert_eq!(health.status, RuntimeDbHealthState::Disabled);
        assert_eq!(fs::read(&db_path).expect("read sentinel db"), b"not sqlite");
        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn enabled_health_without_project_returns_no_project_and_does_not_touch_disk() {
        let health = runtime_db_health_for_project(None, true).expect("no-project health succeeds");

        assert_eq!(health.status, RuntimeDbHealthState::NoProject);
        assert!(health.project_path.is_none());
        assert!(health.db_path.is_none());
    }

    #[test]
    fn enabled_health_without_explicit_or_fallback_project_returns_no_project() {
        let health =
            runtime_db_health_with_fallback(None, None, true).expect("no-project health succeeds");

        assert_eq!(health.status, RuntimeDbHealthState::NoProject);
        assert!(health.project_path.is_none());
        assert!(health.db_path.is_none());
    }

    #[test]
    fn enabled_health_uses_fallback_project_root_when_explicit_path_is_absent() {
        let project = temp_project("fallback-root");
        fs::create_dir_all(&project).expect("create temp project");

        let health = runtime_db_health_with_fallback(None, Some(project.clone()), true)
            .expect("fallback health succeeds");

        assert_eq!(health.status, RuntimeDbHealthState::Healthy);
        assert!(runtime_db_path(&project).is_file());
        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn disabled_health_with_fallback_project_root_does_not_touch_disk() {
        let project = temp_project("disabled-fallback-root");
        fs::create_dir_all(&project).expect("create temp project");

        let health = runtime_db_health_with_fallback(None, Some(project.clone()), false)
            .expect("disabled fallback health succeeds");

        assert_eq!(health.status, RuntimeDbHealthState::Disabled);
        assert!(!project.join(RUNTIME_DIR).exists());
        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn enabled_health_creates_runtime_db_with_wal_and_migration_row() {
        let project = temp_project("enabled-create");
        fs::create_dir_all(&project).expect("create temp project");

        let health =
            runtime_db_health_for_project(Some(&project), true).expect("enabled health succeeds");

        assert_eq!(health.status, RuntimeDbHealthState::Healthy);
        assert_eq!(health.journal_mode.as_deref(), Some("wal"));
        assert!(project.join(RUNTIME_DIR).is_dir());
        assert!(runtime_db_path(&project).is_file());
        assert!(health.migrations[0].applied_at_ms > 0);
        assert_eq!(
            health.migrations,
            vec![RuntimeDbMigrationStatus {
                family: MIGRATIONS_FAMILY.to_string(),
                version: MIGRATIONS_VERSION,
                applied_at_ms: health.migrations[0].applied_at_ms,
            }]
        );

        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn enabled_health_is_idempotent_and_preserves_applied_at_ms() {
        let project = temp_project("enabled-idempotent");
        fs::create_dir_all(&project).expect("create temp project");

        runtime_db_health_for_project(Some(&project), true).expect("first health succeeds");
        let first = read_migration(&project);

        runtime_db_health_for_project(Some(&project), true).expect("second health succeeds");
        let second = read_migration(&project);

        assert_eq!(first, second);
        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn enabled_health_preserves_existing_higher_migration_version() {
        let project = temp_project("enabled-higher-version");
        fs::create_dir_all(project.join(RUNTIME_DIR)).expect("create runtime dir");
        let connection = Connection::open(runtime_db_path(&project)).expect("open runtime db");
        connection
            .execute(
                "CREATE TABLE runtime_schema_migrations (
                    family TEXT PRIMARY KEY,
                    version INTEGER NOT NULL,
                    applied_at_ms INTEGER NOT NULL
                )",
                [],
            )
            .expect("create migrations table");
        connection
            .execute(
                "INSERT INTO runtime_schema_migrations (
                    family,
                    version,
                    applied_at_ms
                ) VALUES (?1, ?2, ?3)",
                params![MIGRATIONS_FAMILY, 2_i64, 42_i64],
            )
            .expect("seed higher migration");
        drop(connection);

        runtime_db_health_for_project(Some(&project), true).expect("enabled health succeeds");
        let migration = read_migration(&project);

        assert_eq!(
            migration,
            RuntimeDbMigrationStatus {
                family: MIGRATIONS_FAMILY.to_string(),
                version: 2,
                applied_at_ms: 42,
            }
        );
        let _ = fs::remove_dir_all(project);
    }

    fn create_request(job_id: &str) -> RuntimeJobCreateRequest {
        RuntimeJobCreateRequest {
            job_id: Some(job_id.to_string()),
            kind: "compile-page".to_string(),
            payload: "{}".to_string(),
            max_attempts: None,
            priority: None,
        }
    }

    fn create_request_with_max_attempts(
        job_id: &str,
        max_attempts: i64,
    ) -> RuntimeJobCreateRequest {
        RuntimeJobCreateRequest {
            max_attempts: Some(max_attempts),
            ..create_request(job_id)
        }
    }

    fn create_request_with_kind(
        job_id: &str,
        kind: &str,
        priority: i64,
    ) -> RuntimeJobCreateRequest {
        RuntimeJobCreateRequest {
            job_id: Some(job_id.to_string()),
            kind: kind.to_string(),
            payload: "{}".to_string(),
            max_attempts: None,
            priority: Some(priority),
        }
    }

    fn claim_request(holder: &str, lease_id: &str) -> RuntimeJobClaimRequest {
        RuntimeJobClaimRequest {
            holder: holder.to_string(),
            lease_id: Some(lease_id.to_string()),
        }
    }

    fn claim_by_kind_request(
        holder: &str,
        lease_id: &str,
        kind: &str,
    ) -> RuntimeJobClaimByKindRequest {
        RuntimeJobClaimByKindRequest {
            holder: holder.to_string(),
            lease_id: Some(lease_id.to_string()),
            kind: kind.to_string(),
        }
    }

    fn lease_request(job_id: &str, lease_id: &str) -> RuntimeJobLeaseRequest {
        RuntimeJobLeaseRequest {
            job_id: job_id.to_string(),
            lease_id: lease_id.to_string(),
        }
    }

    fn pause_request(job_id: &str) -> RuntimeJobPauseRequest {
        RuntimeJobPauseRequest {
            job_id: job_id.to_string(),
        }
    }

    fn resume_request(job_id: &str) -> RuntimeJobResumeRequest {
        RuntimeJobResumeRequest {
            job_id: job_id.to_string(),
        }
    }

    fn commit_claim_request(path: &str, claim_id: &str) -> RuntimeCommitBudgetClaimRequest {
        RuntimeCommitBudgetClaimRequest {
            affected_path: path.to_string(),
            holder: "tester:worker-a".to_string(),
            job_id: None,
            claim_id: Some(claim_id.to_string()),
            ttl_ms: None,
        }
    }

    fn commit_release_request(claim_id: &str) -> RuntimeCommitBudgetReleaseRequest {
        RuntimeCommitBudgetReleaseRequest {
            claim_id: claim_id.to_string(),
        }
    }

    fn event_request(
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

    fn progress_request(
        job_id: Option<&str>,
        progress_key: &str,
        event_id: &str,
        payload: &str,
        durable: bool,
    ) -> RuntimeProgressAppendRequest {
        RuntimeProgressAppendRequest {
            job_id: job_id.map(str::to_string),
            progress_key: progress_key.to_string(),
            event_id: Some(event_id.to_string()),
            payload: payload.to_string(),
            durable: Some(durable),
        }
    }

    fn timeline_request(job_id: Option<&str>) -> RuntimeTimelineListRequest {
        RuntimeTimelineListRequest {
            job_id: job_id.map(str::to_string),
            limit: None,
        }
    }

    fn progress_list_request(job_id: Option<&str>) -> RuntimeProgressListRequest {
        RuntimeProgressListRequest {
            job_id: job_id.map(str::to_string),
            limit: None,
        }
    }

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

    fn marker_record_request(
        marker_id: &str,
        layer: &str,
        affected_path: &str,
        source_event_id: &str,
    ) -> RuntimeDerivedStaleMarkerRecordRequest {
        RuntimeDerivedStaleMarkerRecordRequest {
            marker_id: Some(marker_id.to_string()),
            layer: layer.to_string(),
            affected_path: affected_path.to_string(),
            input_hash: Some("sha256:def456".to_string()),
            base_version: format!("event:200:{source_event_id}"),
            reason: "commit".to_string(),
            source_event_id: source_event_id.to_string(),
        }
    }

    fn marker_list_request(
        layer: Option<&str>,
        affected_path: Option<&str>,
        status: Option<&str>,
    ) -> RuntimeDerivedStaleMarkerListRequest {
        RuntimeDerivedStaleMarkerListRequest {
            layer: layer.map(str::to_string),
            affected_path: affected_path.map(str::to_string),
            status: status.map(str::to_string),
            limit: None,
        }
    }

    fn profile_secret_ref(id: &str) -> String {
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

    fn profile_create_request(profile_id: &str) -> RuntimeProfileCreateRequest {
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

    fn anthropic_profile_create_request(
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

    fn stored_probe_request(profile_id: &str, force: bool) -> RuntimeProfileProbeRequest {
        RuntimeProfileProbeRequest {
            profile_id: Some(profile_id.to_string()),
            draft: None,
            raw_secret: None,
            force: Some(force),
        }
    }

    fn setup_anthropic_probe_profile(
        label: &str,
        endpoint: &str,
    ) -> (PathBuf, TestSecretStore, Client) {
        let project = temp_project(label);
        fs::create_dir_all(&project).expect("create temp project");
        let created = runtime_profile_create_for_project(
            Some(&project),
            true,
            anthropic_profile_create_request("profile-1", endpoint),
            100,
        )
        .expect("create profile");
        let store = TestSecretStore::default();
        store.insert(created.secret_ref.expect("secret ref"), "stored-secret");
        let client = Client::builder().build().expect("client");
        (project, store, client)
    }

    #[test]
    fn profile_probe_debug_redacts_raw_secret_values() {
        let request = RuntimeProfileProbeRequest {
            profile_id: None,
            draft: None,
            raw_secret: Some("debug-secret".to_string()),
            force: Some(true),
        };
        let target = RuntimeProfileProbeTarget {
            profile_id: None,
            kind: "model-call".to_string(),
            provider_id: "openai".to_string(),
            model_id: "gpt-test".to_string(),
            agent_sdk_model_id: None,
            endpoint: None,
            api_mode: "openai-chat-completions".to_string(),
            auth_style: "bearer".to_string(),
            secret_value: "debug-secret".to_string(),
        };

        assert!(!format!("{request:?}").contains("debug-secret"));
        assert!(!format!("{target:?}").contains("debug-secret"));
    }

    fn profile_update_request(profile_id: &str) -> RuntimeProfileUpdateRequest {
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

    fn profile_pool_capability_json(
        model_call: serde_json::Value,
        agent_run: serde_json::Value,
    ) -> String {
        serde_json::json!({
            "modelCallSupported": model_call,
            "agentRunSupported": agent_run
        })
        .to_string()
    }

    fn create_profile_pool_profile(
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

    fn profile_pool_claim_request(
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

    fn agent_profile_pool_claim_request(
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

    fn profile_pool_release_request(
        claim_id: &str,
        outcome: &str,
    ) -> RuntimeProfilePoolReleaseRequest {
        RuntimeProfilePoolReleaseRequest {
            claim_id: claim_id.to_string(),
            outcome: outcome.to_string(),
            retry_after_ms: None,
            circuit_open_ms: None,
            reason: None,
            error: None,
        }
    }

    fn create_agent_profile_pool_profile(project: &Path, profile_id: &str) -> RuntimeProfileRecord {
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

    fn write_staging_file(project_root: &Path, relative_path: &str, contents: &[u8]) -> PathBuf {
        let path = staging_dir_path(project_root).join(relative_path);
        fs::create_dir_all(path.parent().expect("staging file has parent"))
            .expect("create staging parent");
        fs::write(&path, contents).expect("write staging file");
        path
    }

    fn migration_family_exists(project_root: &Path, family: &str) -> bool {
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

    #[test]
    fn pr5_request_shapes_reject_unknown_fields() {
        let event = serde_json::from_value::<RuntimeEventAppendRequest>(serde_json::json!({
            "jobId": "job-1",
            "eventId": "event-1",
            "payload": "{}",
            "dbPath": "/tmp/runtime.db"
        }))
        .expect_err("event request rejects dbPath");
        assert!(event.to_string().contains("unknown field"));

        let progress = serde_json::from_value::<RuntimeProgressAppendRequest>(serde_json::json!({
            "jobId": "job-1",
            "progressKey": "compile",
            "eventId": "event-2",
            "payload": "{}",
            "durable": false,
            "timestamp": 123
        }))
        .expect_err("progress request rejects timestamp");
        assert!(progress.to_string().contains("unknown field"));

        let timeline = serde_json::from_value::<RuntimeTimelineListRequest>(serde_json::json!({
            "jobId": "job-1",
            "limit": 10,
            "root": "/tmp/project"
        }))
        .expect_err("timeline request rejects root");
        assert!(timeline.to_string().contains("unknown field"));

        let progress_list =
            serde_json::from_value::<RuntimeProgressListRequest>(serde_json::json!({
                "jobId": "job-1",
                "limit": 10,
                "minIntervalMs": 1
            }))
            .expect_err("progress list request rejects minIntervalMs");
        assert!(progress_list.to_string().contains("unknown field"));
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
    fn job_pause_resume_request_shapes_reject_unknown_fields() {
        let pause = serde_json::from_value::<RuntimeJobPauseRequest>(serde_json::json!({
            "jobId": "job-1",
            "root": "/tmp/project"
        }))
        .expect_err("pause request rejects root");
        assert!(pause.to_string().contains("unknown field"));

        let resume = serde_json::from_value::<RuntimeJobResumeRequest>(serde_json::json!({
            "jobId": "job-1",
            "dbPath": "/tmp/runtime.db"
        }))
        .expect_err("resume request rejects dbPath");
        assert!(resume.to_string().contains("unknown field"));
    }

    #[test]
    fn profile_request_shapes_reject_unknown_fields() {
        let create = serde_json::from_value::<RuntimeProfileCreateRequest>(serde_json::json!({
            "profileId": "profile-1",
            "kind": "model-call",
            "displayName": "GPT-4.1",
            "providerId": "openai",
            "modelId": "gpt-4.1",
            "apiMode": "openai-chat-completions",
            "authStyle": "bearer",
            "taskFamilies": ["summarize"],
            "secretValue": "sk-test"
        }))
        .expect_err("create request rejects raw secret fields");
        assert!(create.to_string().contains("unknown field"));

        let update = serde_json::from_value::<RuntimeProfileUpdateRequest>(serde_json::json!({
            "profileId": "profile-1",
            "capabilityStatus": "limited",
            "dbPath": "/tmp/runtime.db"
        }))
        .expect_err("update request rejects dbPath");
        assert!(update.to_string().contains("unknown field"));
    }

    #[test]
    fn disabled_job_create_does_not_touch_disk() {
        let project = temp_project("disabled-job-create");
        fs::create_dir_all(&project).expect("create temp project");

        let error =
            runtime_job_create_for_project(Some(&project), false, create_request("job-1"), 10)
                .expect_err("disabled create should fail");

        assert!(error.starts_with("runtime-disabled"));
        assert!(!project.join(RUNTIME_DIR).exists());
        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn disabled_job_list_does_not_open_damaged_runtime_db() {
        let project = temp_project("disabled-job-list");
        let runtime_dir = project.join(RUNTIME_DIR);
        fs::create_dir_all(&runtime_dir).expect("create runtime dir");
        let db_path = runtime_dir.join(RUNTIME_DB_FILE);
        fs::write(&db_path, b"not sqlite").expect("write damaged db");

        let list = runtime_job_list_for_project(Some(&project), false).expect("disabled list");

        assert_eq!(list.status, RuntimeDbHealthState::Disabled);
        assert!(list.jobs.is_empty());
        assert_eq!(fs::read(&db_path).expect("read damaged db"), b"not sqlite");
        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn disabled_job_pause_resume_do_not_open_damaged_runtime_db() {
        let project = temp_project("disabled-job-pause-resume");
        let runtime_dir = project.join(RUNTIME_DIR);
        fs::create_dir_all(&runtime_dir).expect("create runtime dir");
        let db_path = runtime_dir.join(RUNTIME_DB_FILE);
        fs::write(&db_path, b"not sqlite").expect("write damaged db");

        let pause_error =
            runtime_job_pause_for_project(Some(&project), false, pause_request("job-1"), 100)
                .expect_err("disabled pause should fail before DB open");
        let resume_error =
            runtime_job_resume_for_project(Some(&project), false, resume_request("job-1"), 100)
                .expect_err("disabled resume should fail before DB open");

        assert!(pause_error.starts_with("runtime-disabled"));
        assert!(resume_error.starts_with("runtime-disabled"));
        assert_eq!(fs::read(&db_path).expect("read damaged db"), b"not sqlite");
        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn enabled_job_pause_resume_without_project_returns_no_project() {
        let pause_error = runtime_job_pause_for_project(None, true, pause_request("job-1"), 100)
            .expect_err("pause without project should fail");
        let resume_error = runtime_job_resume_for_project(None, true, resume_request("job-1"), 100)
            .expect_err("resume without project should fail");

        assert!(pause_error.starts_with("no-project"));
        assert!(resume_error.starts_with("no-project"));
    }

    #[test]
    fn disabled_commit_budget_commands_do_not_touch_disk() {
        let project = temp_project("disabled-commit-budget");
        let runtime_dir = project.join(RUNTIME_DIR);
        fs::create_dir_all(&runtime_dir).expect("create runtime dir");
        let db_path = runtime_dir.join(RUNTIME_DB_FILE);
        fs::write(&db_path, b"not sqlite").expect("write damaged db");

        let claim_error = runtime_commit_budget_claim_for_project(
            Some(&project),
            false,
            commit_claim_request("wiki/a.md", "claim-1"),
            100,
        )
        .expect_err("disabled claim should fail");
        assert!(claim_error.starts_with("runtime-disabled"));
        let release_error = runtime_commit_budget_release_for_project(
            Some(&project),
            false,
            commit_release_request("claim-1"),
            100,
        )
        .expect_err("disabled release should fail");
        assert!(release_error.starts_with("runtime-disabled"));
        let list = runtime_commit_budget_list_for_project(Some(&project), false)
            .expect("disabled list succeeds");
        assert_eq!(list.status, RuntimeDbHealthState::Disabled);
        assert_eq!(fs::read(&db_path).expect("read damaged db"), b"not sqlite");
        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn disabled_event_progress_commands_do_not_touch_damaged_runtime_db() {
        let project = temp_project("disabled-events-progress");
        let runtime_dir = project.join(RUNTIME_DIR);
        fs::create_dir_all(&runtime_dir).expect("create runtime dir");
        let db_path = runtime_dir.join(RUNTIME_DB_FILE);
        fs::write(&db_path, b"not sqlite").expect("write damaged db");

        let event_error = runtime_event_append_for_project(
            Some(&project),
            false,
            event_request(Some("job-1"), "event-1", "{}"),
            100,
        )
        .expect_err("disabled event append should fail");
        assert!(event_error.starts_with("runtime-disabled"));

        let progress_error = runtime_progress_append_for_project(
            Some(&project),
            false,
            progress_request(Some("job-1"), "compile", "event-2", "{}", false),
            100,
        )
        .expect_err("disabled progress append should fail");
        assert!(progress_error.starts_with("runtime-disabled"));

        let timeline = runtime_timeline_list_for_project(
            Some(&project),
            false,
            timeline_request(Some("job-1")),
        )
        .expect("disabled timeline list");
        assert_eq!(timeline.status, RuntimeDbHealthState::Disabled);
        assert!(timeline.events.is_empty());

        let progress = runtime_progress_list_for_project(
            Some(&project),
            false,
            progress_list_request(Some("job-1")),
        )
        .expect("disabled progress list");
        assert_eq!(progress.status, RuntimeDbHealthState::Disabled);
        assert!(progress.progress.is_empty());

        assert_eq!(fs::read(&db_path).expect("read damaged db"), b"not sqlite");
        let _ = fs::remove_dir_all(project);
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
    fn enabled_commit_budget_commands_without_project_are_no_touch() {
        let claim_error = runtime_commit_budget_claim_for_project(
            None,
            true,
            commit_claim_request("wiki/a.md", "claim-1"),
            100,
        )
        .expect_err("no-project claim should fail");
        assert!(claim_error.starts_with("no-project"));
        let release_error = runtime_commit_budget_release_for_project(
            None,
            true,
            commit_release_request("claim-1"),
            100,
        )
        .expect_err("no-project release should fail");
        assert!(release_error.starts_with("no-project"));
        let list = runtime_commit_budget_list_for_project(None, true).expect("no-project list");
        assert_eq!(list.status, RuntimeDbHealthState::NoProject);
        assert!(list.budgets.is_empty());
        assert!(list.claims.is_empty());
    }

    #[test]
    fn enabled_event_progress_commands_without_project_are_no_touch() {
        let event_error = runtime_event_append_for_project(
            None,
            true,
            event_request(Some("job-1"), "event-1", "{}"),
            100,
        )
        .expect_err("no-project event append should fail");
        assert!(event_error.starts_with("no-project"));

        let progress_error = runtime_progress_append_for_project(
            None,
            true,
            progress_request(Some("job-1"), "compile", "event-2", "{}", false),
            100,
        )
        .expect_err("no-project progress append should fail");
        assert!(progress_error.starts_with("no-project"));

        let timeline = runtime_timeline_list_for_project(None, true, timeline_request(None))
            .expect("timeline");
        assert_eq!(timeline.status, RuntimeDbHealthState::NoProject);
        assert!(timeline.events.is_empty());

        let progress = runtime_progress_list_for_project(None, true, progress_list_request(None))
            .expect("progress list");
        assert_eq!(progress.status, RuntimeDbHealthState::NoProject);
        assert!(progress.progress.is_empty());
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
    fn enabled_job_list_on_pr2_only_db_returns_empty_without_migration() {
        let project = temp_project("enabled-job-list-pr2-db");
        fs::create_dir_all(&project).expect("create temp project");
        runtime_db_health_for_project(Some(&project), true).expect("create PR2 runtime db");

        let list = runtime_job_list_for_project(Some(&project), true).expect("list jobs");

        assert_eq!(list.status, RuntimeDbHealthState::Healthy);
        assert!(list.jobs.is_empty());
        assert!(list.leases.is_empty());
        let connection = Connection::open(runtime_db_path(&project)).expect("open runtime db");
        assert!(!table_exists(&connection, "runtime_jobs").expect("check jobs table"));
        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn commit_budget_list_on_pr3_only_db_returns_empty_without_migration() {
        let project = temp_project("commit-budget-list-pr3-db");
        fs::create_dir_all(&project).expect("create temp project");
        runtime_job_create_for_project(Some(&project), true, create_request("job-1"), 100)
            .expect("create PR3 runtime db");

        let list = runtime_commit_budget_list_for_project(Some(&project), true)
            .expect("list commit budgets");

        assert_eq!(list.status, RuntimeDbHealthState::Healthy);
        assert!(list.budgets.is_empty());
        assert!(list.claims.is_empty());
        let connection = Connection::open(runtime_db_path(&project)).expect("open runtime db");
        assert!(!table_exists(&connection, "runtime_resource_budgets").expect("check budgets"));
        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn event_progress_lists_return_empty_without_migration_on_existing_runtime_dbs() {
        let pr4_project = temp_project("events-progress-pr4-db");
        fs::create_dir_all(&pr4_project).expect("create temp project");
        runtime_commit_budget_claim_for_project(
            Some(&pr4_project),
            true,
            commit_claim_request("wiki/a.md", "claim-1"),
            100,
        )
        .expect("create PR4 runtime db");

        let timeline =
            runtime_timeline_list_for_project(Some(&pr4_project), true, timeline_request(None))
                .expect("timeline list");
        let progress = runtime_progress_list_for_project(
            Some(&pr4_project),
            true,
            progress_list_request(None),
        )
        .expect("progress list");

        assert!(timeline.events.is_empty());
        assert!(progress.progress.is_empty());
        let connection = Connection::open(runtime_db_path(&pr4_project)).expect("open runtime db");
        assert!(!table_exists(&connection, "runtime_events").expect("check events"));
        assert!(!migration_family_exists(
            &pr4_project,
            EVENTS_PROGRESS_FAMILY
        ));
        drop(connection);
        let _ = fs::remove_dir_all(pr4_project);

        let pr3_project = temp_project("events-progress-pr3-db");
        fs::create_dir_all(&pr3_project).expect("create temp project");
        runtime_job_create_for_project(Some(&pr3_project), true, create_request("job-1"), 100)
            .expect("create PR3 runtime db");

        let timeline =
            runtime_timeline_list_for_project(Some(&pr3_project), true, timeline_request(None))
                .expect("timeline list");
        let progress = runtime_progress_list_for_project(
            Some(&pr3_project),
            true,
            progress_list_request(None),
        )
        .expect("progress list");
        assert!(timeline.events.is_empty());
        assert!(progress.progress.is_empty());
        let connection = Connection::open(runtime_db_path(&pr3_project)).expect("open runtime db");
        assert!(!table_exists(&connection, "runtime_events").expect("check events"));
        assert!(!table_exists(&connection, "runtime_progress").expect("check progress"));
        assert!(!migration_family_exists(
            &pr3_project,
            EVENTS_PROGRESS_FAMILY
        ));
        let _ = fs::remove_dir_all(pr3_project);
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
    fn derived_stale_marker_record_and_list_happy_path() {
        let project = temp_project("derived-marker-happy");
        fs::create_dir_all(&project).expect("create temp project");
        runtime_job_create_for_project(Some(&project), true, create_request("job-1"), 100)
            .expect("create parent job");
        let event = runtime_event_append_for_project(
            Some(&project),
            true,
            event_request(Some("job-1"), "event-1", "{}"),
            200,
        )
        .expect("append commit event");

        let marker = runtime_derived_stale_marker_record_for_project(
            Some(&project),
            true,
            marker_record_request("marker-1", "embedding", "Wiki\\Page.md", &event.event_id),
            300,
        )
        .expect("record marker");

        assert_eq!(marker.marker_id, "marker-1");
        assert_eq!(marker.layer, "embedding");
        assert_eq!(marker.affected_path, "Wiki/Page.md");
        assert_eq!(marker.input_hash.as_deref(), Some("sha256:def456"));
        assert_eq!(marker.base_version, "event:200:event-1");
        assert_eq!(marker.reason, "commit");
        assert_eq!(marker.source_event_id, "event-1");
        assert_eq!(marker.status, PENDING_MARKER_STATUS);
        assert_eq!(marker.marked_at_ms, 300);
        assert_eq!(marker.updated_at_ms, 300);
        assert!(marker.last_error.is_none());

        let all = runtime_derived_stale_marker_list_for_project(
            Some(&project),
            true,
            marker_list_request(None, None, None),
        )
        .expect("list all markers");
        assert_eq!(all.markers, vec![marker.clone()]);

        let filtered = runtime_derived_stale_marker_list_for_project(
            Some(&project),
            true,
            marker_list_request(Some("embedding"), Some("Wiki/Page.md"), Some("pending")),
        )
        .expect("list filtered markers");
        assert_eq!(filtered.markers, vec![marker]);
        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn derived_stale_marker_list_returns_empty_without_migration_on_existing_runtime_dbs() {
        let project = temp_project("derived-marker-list-pr5-db");
        fs::create_dir_all(&project).expect("create temp project");
        runtime_job_create_for_project(Some(&project), true, create_request("job-1"), 100)
            .expect("create parent job");
        runtime_event_append_for_project(
            Some(&project),
            true,
            event_request(Some("job-1"), "event-1", "{}"),
            200,
        )
        .expect("create events-progress runtime db");

        let list = runtime_derived_stale_marker_list_for_project(
            Some(&project),
            true,
            marker_list_request(None, None, None),
        )
        .expect("list derived markers");

        assert_eq!(list.status, RuntimeDbHealthState::Healthy);
        assert!(list.markers.is_empty());
        let connection = Connection::open(runtime_db_path(&project)).expect("open runtime db");
        assert!(!table_exists(&connection, "runtime_derived_stale_markers").expect("check table"));
        assert!(!migration_family_exists(
            &project,
            DERIVED_STALE_MARKERS_FAMILY
        ));
        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn derived_stale_marker_list_disabled_and_no_project_are_no_touch() {
        let disabled = runtime_derived_stale_marker_list_for_project(
            None,
            false,
            marker_list_request(None, None, None),
        )
        .expect("disabled list succeeds");
        assert_eq!(disabled.status, RuntimeDbHealthState::Disabled);
        assert!(disabled.markers.is_empty());

        let no_project = runtime_derived_stale_marker_list_for_project(
            None,
            true,
            marker_list_request(None, None, None),
        )
        .expect("no-project list succeeds");
        assert_eq!(no_project.status, RuntimeDbHealthState::NoProject);
        assert!(no_project.markers.is_empty());
    }

    #[test]
    fn profile_list_returns_empty_without_migration_on_existing_runtime_db() {
        let project = temp_project("profile-list-pr2-db");
        fs::create_dir_all(&project).expect("create temp project");
        runtime_db_health_for_project(Some(&project), true).expect("create base runtime db");

        let list = runtime_profile_list_for_project(Some(&project), true).expect("list profiles");

        assert_eq!(list.status, RuntimeDbHealthState::Healthy);
        assert!(list.profiles.is_empty());
        let connection = Connection::open(runtime_db_path(&project)).expect("open runtime db");
        assert!(!table_exists(&connection, "runtime_model_profiles").expect("check table"));
        assert!(!migration_family_exists(&project, PROFILE_STATUS_FAMILY));
        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn runtime_profile_persists_agent_sdk_model_alias() {
        let project = temp_project("profile-agent-sdk-alias");
        fs::create_dir_all(&project).expect("create temp project");
        let mut create = profile_create_request("profile-1");
        create.agent_sdk_model_id = Some("claude-code-alias".to_string());

        let created =
            runtime_profile_create_for_project(Some(&project), true, create, 100).expect("create");
        assert_eq!(
            created.agent_sdk_model_id.as_deref(),
            Some("claude-code-alias")
        );

        let mut update = profile_update_request("profile-1");
        update.agent_sdk_model_id = Some("deepseek-chat".to_string());
        let updated = runtime_profile_update_for_project(Some(&project), true, update, 200)
            .expect("update alias");
        assert_eq!(updated.agent_sdk_model_id.as_deref(), Some("deepseek-chat"));

        let listed = runtime_profile_list_for_project(Some(&project), true).expect("list");
        assert_eq!(
            listed.profiles[0].agent_sdk_model_id.as_deref(),
            Some("deepseek-chat")
        );
        let status = runtime_profile_status_for_project(
            Some(&project),
            true,
            RuntimeProfileStatusRequest {
                profile_id: "profile-1".to_string(),
            },
        )
        .expect("status");
        assert_eq!(status.agent_sdk_model_id.as_deref(), Some("deepseek-chat"));

        let mut clear = profile_update_request("profile-1");
        clear.clear_agent_sdk_model_id = Some(true);
        let cleared = runtime_profile_update_for_project(Some(&project), true, clear, 300)
            .expect("clear alias");
        assert!(cleared.agent_sdk_model_id.is_none());
        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn runtime_profile_list_reads_legacy_profile_table_without_deleted_marker() {
        let project = temp_project("profile-list-legacy-no-deleted-column");
        fs::create_dir_all(&project).expect("create temp project");
        runtime_db_health_for_project(Some(&project), true).expect("create base runtime db");
        let connection = Connection::open(runtime_db_path(&project)).expect("open runtime db");
        connection
            .execute(
                "CREATE TABLE runtime_model_profiles (
                    profile_id TEXT PRIMARY KEY,
                    kind TEXT NOT NULL,
                    display_name TEXT NOT NULL,
                    provider_id TEXT NOT NULL,
                    model_id TEXT NOT NULL,
                    endpoint TEXT,
                    api_mode TEXT NOT NULL,
                    auth_style TEXT NOT NULL,
                    secret_ref TEXT,
                    enabled INTEGER NOT NULL,
                    task_families_json TEXT NOT NULL,
                    max_concurrency INTEGER NOT NULL,
                    capability_status TEXT NOT NULL,
                    capability_json TEXT NOT NULL,
                    capability_version TEXT NOT NULL,
                    capability_checked_at_ms INTEGER,
                    probe_backoff_until_ms INTEGER,
                    last_capability_error TEXT,
                    created_at_ms INTEGER NOT NULL,
                    updated_at_ms INTEGER NOT NULL
                )",
                [],
            )
            .expect("create legacy profile table");
        connection
            .execute(
                "INSERT INTO runtime_model_profiles (
                    profile_id,
                    kind,
                    display_name,
                    provider_id,
                    model_id,
                    endpoint,
                    api_mode,
                    auth_style,
                    secret_ref,
                    enabled,
                    task_families_json,
                    max_concurrency,
                    capability_status,
                    capability_json,
                    capability_version,
                    capability_checked_at_ms,
                    probe_backoff_until_ms,
                    last_capability_error,
                    created_at_ms,
                    updated_at_ms
                ) VALUES (
                    ?1, 'model-call', 'Legacy profile', 'openai', 'gpt-4.1',
                    NULL, 'openai-chat-completions', 'bearer', NULL, 1,
                    '[\"chat\"]', 1, 'unknown', '{}', ?2,
                    NULL, NULL, NULL, 100, 100
                )",
                params!["profile-legacy", DEFAULT_PROFILE_CAPABILITY_VERSION],
            )
            .expect("insert legacy profile");
        assert!(
            !column_exists(&connection, "runtime_model_profiles", "deleted_at_ms")
                .expect("check missing deleted marker")
        );
        assert!(
            !column_exists(&connection, "runtime_model_profiles", "agent_sdk_model_id")
                .expect("check missing sdk alias")
        );
        drop(connection);

        let list = runtime_profile_list_for_project(Some(&project), true)
            .expect("legacy profile list works read-only");
        assert_eq!(list.profiles.len(), 1);
        assert_eq!(list.profiles[0].profile_id, "profile-legacy");
        assert!(list.profiles[0].agent_sdk_model_id.is_none());
        let status = runtime_profile_status_for_project(
            Some(&project),
            true,
            RuntimeProfileStatusRequest {
                profile_id: "profile-legacy".to_string(),
            },
        )
        .expect("legacy profile status works read-only");
        assert_eq!(status.display_name, "Legacy profile");
        assert!(status.agent_sdk_model_id.is_none());
        let connection = Connection::open(runtime_db_path(&project)).expect("reopen runtime db");
        assert!(
            !column_exists(&connection, "runtime_model_profiles", "deleted_at_ms")
                .expect("read-only paths did not migrate")
        );
        assert!(
            !column_exists(&connection, "runtime_model_profiles", "agent_sdk_model_id")
                .expect("read-only paths did not migrate sdk alias")
        );
        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn profile_schema_preserves_existing_higher_migration_version() {
        let project = temp_project("profile-higher-version");
        fs::create_dir_all(&project).expect("create temp project");
        runtime_db_health_for_project(Some(&project), true).expect("create base runtime db");
        let connection = Connection::open(runtime_db_path(&project)).expect("open runtime db");
        connection
            .execute(
                "INSERT INTO runtime_schema_migrations (
                    family,
                    version,
                    applied_at_ms
                ) VALUES (?1, ?2, ?3)",
                params![PROFILE_STATUS_FAMILY, 2_i64, 42_i64],
            )
            .expect("seed higher profile migration");
        drop(connection);

        runtime_profile_create_for_project(
            Some(&project),
            true,
            profile_create_request("profile-1"),
            100,
        )
        .expect("create profile");
        let migration = read_migration_family(&project, PROFILE_STATUS_FAMILY);

        assert_eq!(
            migration,
            RuntimeDbMigrationStatus {
                family: PROFILE_STATUS_FAMILY.to_string(),
                version: 2,
                applied_at_ms: 42,
            }
        );
        let _ = fs::remove_dir_all(project);
    }

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
    fn runtime_profile_delete_blocks_active_claims_without_soft_deleting() {
        let project = temp_project("profile-delete-active-claim");
        fs::create_dir_all(&project).expect("create temp project");
        create_profile_pool_profile(
            &project,
            "profile-1",
            "model-call",
            true,
            1,
            profile_pool_capability_json(serde_json::json!(true), serde_json::json!(false)),
        );
        runtime_profile_pool_claim_for_project(
            Some(&project),
            true,
            profile_pool_claim_request("claim-1", vec!["profile-1"]),
            200,
        )
        .expect("claim profile");

        let error = runtime_profile_delete_for_project(
            Some(&project),
            true,
            RuntimeProfileDeleteRequest {
                profile_id: "profile-1".to_string(),
            },
            300,
        )
        .expect_err("active claim blocks delete");

        assert!(error.contains("profile-delete-blocked"));
        let status = runtime_profile_status_for_project(
            Some(&project),
            true,
            RuntimeProfileStatusRequest {
                profile_id: "profile-1".to_string(),
            },
        )
        .expect("profile remains visible");
        assert_eq!(status.profile_id, "profile-1");
        let connection = Connection::open(runtime_db_path(&project)).expect("open runtime db");
        let deleted_at: Option<i64> = connection
            .query_row(
                "SELECT deleted_at_ms FROM runtime_model_profiles WHERE profile_id = ?1",
                ["profile-1"],
                |row| row.get(0),
            )
            .expect("read deleted marker");
        assert_eq!(deleted_at, None);
        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn runtime_profile_delete_sweeps_expired_claims_and_filters_default_reads() {
        let project = temp_project("profile-delete-expired-claim");
        fs::create_dir_all(&project).expect("create temp project");
        create_profile_pool_profile(
            &project,
            "profile-1",
            "model-call",
            true,
            1,
            profile_pool_capability_json(serde_json::json!(true), serde_json::json!(false)),
        );
        let mut claim = profile_pool_claim_request("claim-1", vec!["profile-1"]);
        claim.ttl_ms = Some(1_000);
        runtime_profile_pool_claim_for_project(Some(&project), true, claim, 200)
            .expect("claim profile");

        let deleted = runtime_profile_delete_for_project(
            Some(&project),
            true,
            RuntimeProfileDeleteRequest {
                profile_id: "profile-1".to_string(),
            },
            1_300,
        )
        .expect("delete after claim expiry");

        assert_eq!(deleted.profile_id, "profile-1");
        assert_eq!(deleted.deleted_at_ms, 1_300);
        assert_eq!(
            deleted.secret_ref.as_deref(),
            Some(profile_secret_ref("profile-1").as_str())
        );
        let list = runtime_profile_list_for_project(Some(&project), true).expect("list profiles");
        assert!(list.profiles.is_empty());
        let status_error = runtime_profile_status_for_project(
            Some(&project),
            true,
            RuntimeProfileStatusRequest {
                profile_id: "profile-1".to_string(),
            },
        )
        .expect_err("deleted profile is hidden from status");
        assert!(status_error.contains("profile-not-found"));
        let claim_error = runtime_profile_pool_claim_for_project(
            Some(&project),
            true,
            profile_pool_claim_request("claim-2", vec!["profile-1"]),
            1_350,
        )
        .expect_err("deleted profile cannot be claimed");
        assert!(claim_error.contains("no-eligible-profile"));
        let connection = Connection::open(runtime_db_path(&project)).expect("open runtime db");
        let (claim_count, claim_status): (i64, String) = connection
            .query_row(
                "SELECT COUNT(*), MAX(status)
                 FROM runtime_profile_claims
                 WHERE profile_id = ?1",
                ["profile-1"],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("read historical claim");
        assert_eq!(claim_count, 1);
        assert_eq!(claim_status, EXPIRED_CLAIM_STATUS);
        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn runtime_profile_deleted_agent_profile_is_not_resolved_for_active_claim() {
        let project = temp_project("profile-delete-agent-resolver");
        fs::create_dir_all(&project).expect("create temp project");
        let created = create_agent_profile_pool_profile(&project, "profile-1");
        runtime_profile_pool_claim_for_project(
            Some(&project),
            true,
            agent_profile_pool_claim_request("claim-1", vec!["profile-1"]),
            200,
        )
        .expect("claim agent profile");
        let connection = Connection::open(runtime_db_path(&project)).expect("open runtime db");
        connection
            .execute(
                "UPDATE runtime_model_profiles
                 SET deleted_at_ms = ?2, updated_at_ms = ?2
                 WHERE profile_id = ?1",
                params!["profile-1", 250_i64],
            )
            .expect("mark profile deleted");
        drop(connection);
        let store = TestSecretStore::default();
        store.insert(created.secret_ref.expect("secret ref"), "stored-secret");

        let error = resolve_agent_run_profile_for_project_at_with_store(
            Some(&project),
            true,
            "profile-1",
            "claim-1",
            300,
            &store,
        )
        .expect_err("deleted profile is not resolved");

        assert!(error.contains("profile-not-found"));
        assert!(!error.contains("stored-secret"));
        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn profile_update_preserves_nullable_fields_until_clear_flags_are_set() {
        let project = temp_project("profile-update-clear-flags");
        fs::create_dir_all(&project).expect("create temp project");
        let mut create = profile_create_request("profile-clear");
        create.endpoint = Some("https://api.openai.example/v1".to_string());
        runtime_profile_create_for_project(Some(&project), true, create, 100)
            .expect("create profile");

        let mut seed_error = profile_update_request("profile-clear");
        seed_error.last_capability_error = Some("temporary outage".to_string());
        runtime_profile_update_for_project(Some(&project), true, seed_error, 150)
            .expect("seed nullable fields");

        let mut rename_only = profile_update_request("profile-clear");
        rename_only.display_name = Some("Renamed profile".to_string());
        let preserved = runtime_profile_update_for_project(Some(&project), true, rename_only, 200)
            .expect("rename preserves nullable fields");

        assert_eq!(preserved.display_name, "Renamed profile");
        assert_eq!(
            preserved.endpoint.as_deref(),
            Some("https://api.openai.example/v1")
        );
        assert_eq!(
            preserved.secret_ref.as_deref(),
            Some(profile_secret_ref("profile-clear").as_str())
        );
        assert_eq!(
            preserved.last_capability_error.as_deref(),
            Some("temporary outage")
        );

        let mut clear_secret = profile_update_request("profile-clear");
        clear_secret.clear_secret_ref = Some(true);
        let secret_cleared =
            runtime_profile_update_for_project(Some(&project), true, clear_secret, 225)
                .expect("clear secret ref");

        assert_eq!(
            secret_cleared.endpoint.as_deref(),
            Some("https://api.openai.example/v1")
        );
        assert!(secret_cleared.secret_ref.is_none());
        assert_eq!(
            secret_cleared.last_capability_error.as_deref(),
            Some("temporary outage")
        );

        let mut clear = profile_update_request("profile-clear");
        clear.clear_endpoint = Some(true);
        clear.clear_last_capability_error = Some(true);
        let cleared = runtime_profile_update_for_project(Some(&project), true, clear, 250)
            .expect("clear nullable fields");

        assert!(cleared.endpoint.is_none());
        assert!(cleared.secret_ref.is_none());
        assert!(cleared.last_capability_error.is_none());
        let _ = fs::remove_dir_all(project);
    }

    #[tokio::test]
    async fn profile_probe_persists_supported_anthropic_capabilities_without_secret_values() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/messages"))
            .and(header("x-api-key", "stored-secret"))
            .respond_with(
                ResponseTemplate::new(200).set_body_string("event: message_start\ndata: {}\n"),
            )
            .mount(&server)
            .await;
        let (project, store, client) =
            setup_anthropic_probe_profile("profile-probe-supported", &server.uri());

        let result = runtime_profile_probe_for_project_with_store(
            Some(&project),
            true,
            stored_probe_request("profile-1", false),
            200,
            &store,
            &client,
        )
        .await
        .expect("probe profile");

        assert_eq!(result.status, "supported");
        assert_eq!(result.capability_version, PROFILE_PROBE_CAPABILITY_VERSION);
        assert_eq!(result.backoff_until_ms, None);
        let serialized = serde_json::to_string(&result).expect("serialize probe result");
        assert!(!serialized.contains("stored-secret"));
        assert!(!serialized.contains("Authorization"));
        let profile = result.profile.expect("updated profile");
        assert_eq!(profile.capability_status, "supported");
        assert_eq!(profile.capability_version, PROFILE_PROBE_CAPABILITY_VERSION);
        assert_eq!(profile.capability_checked_at_ms, Some(200));
        assert_eq!(profile.probe_backoff_until_ms, None);
        assert_eq!(profile.last_capability_error, None);
        assert!(!result.capability_json.contains("stored-secret"));
        let _ = fs::remove_dir_all(project);
    }

    #[tokio::test]
    async fn profile_probe_marks_messages_only_anthropic_as_limited() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/messages"))
            .respond_with(ResponseTemplate::new(200).set_body_string("{}"))
            .mount(&server)
            .await;
        let (project, store, client) =
            setup_anthropic_probe_profile("profile-probe-limited", &server.uri());

        let result = runtime_profile_probe_for_project_with_store(
            Some(&project),
            true,
            stored_probe_request("profile-1", true),
            200,
            &store,
            &client,
        )
        .await
        .expect("probe profile");

        assert_eq!(result.status, "limited");
        assert!(result
            .capability_json
            .contains("\"agentRunSupported\":false"));
        assert_eq!(result.backoff_until_ms, None);
        let _ = fs::remove_dir_all(project);
    }

    #[tokio::test]
    async fn profile_probe_auth_failure_sets_error_and_retry_backoff() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/messages"))
            .respond_with(ResponseTemplate::new(401))
            .mount(&server)
            .await;
        let (project, store, client) =
            setup_anthropic_probe_profile("profile-probe-auth-failure", &server.uri());

        let result = runtime_profile_probe_for_project_with_store(
            Some(&project),
            true,
            stored_probe_request("profile-1", false),
            200,
            &store,
            &client,
        )
        .await
        .expect("probe profile");

        assert_eq!(result.status, "error");
        assert_eq!(
            result.backoff_until_ms,
            Some(200 + PROFILE_PROBE_BACKOFF_MS)
        );
        let profile = result.profile.expect("updated profile");
        assert_eq!(profile.capability_status, "error");
        assert_eq!(
            profile.probe_backoff_until_ms,
            Some(200 + PROFILE_PROBE_BACKOFF_MS)
        );
        assert!(profile
            .last_capability_error
            .as_deref()
            .unwrap_or_default()
            .contains("401"));
        assert!(!profile
            .last_capability_error
            .as_deref()
            .unwrap_or_default()
            .contains("stored-secret"));
        let cached = runtime_profile_probe_for_project_with_store(
            Some(&project),
            true,
            stored_probe_request("profile-1", false),
            201,
            &store,
            &client,
        )
        .await
        .expect("cached backoff result");
        assert_eq!(cached.checked_at_ms, 200);
        assert_eq!(cached.status, "error");
        let serialized = serde_json::to_string(&cached).expect("serialize cached result");
        assert!(!serialized.contains("stored-secret"));
        assert!(!serialized.contains("Authorization"));
        let _ = fs::remove_dir_all(project);
    }

    #[tokio::test]
    async fn profile_probe_draft_openai_and_google_paths_do_not_persist_or_expose_secret() {
        let openai = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/chat/completions"))
            .and(header("authorization", "Bearer draft-secret"))
            .respond_with(ResponseTemplate::new(200).set_body_string("{}"))
            .mount(&openai)
            .await;
        let google = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/models/gemini%2Ftest:generateContent"))
            .and(header("x-goog-api-key", "draft-secret"))
            .respond_with(ResponseTemplate::new(200).set_body_string("{}"))
            .mount(&google)
            .await;
        let client = Client::builder().build().expect("client");

        let openai_result = runtime_profile_probe_for_project_with_store(
            Some(Path::new("/tmp")),
            true,
            RuntimeProfileProbeRequest {
                profile_id: None,
                draft: Some(RuntimeProfileProbeDraftRequest {
                    kind: "model-call".to_string(),
                    provider_id: "openai".to_string(),
                    model_id: "gpt-test".to_string(),
                    agent_sdk_model_id: None,
                    endpoint: Some(openai.uri()),
                    api_mode: "openai-chat-completions".to_string(),
                    auth_style: "bearer".to_string(),
                }),
                raw_secret: Some("draft-secret".to_string()),
                force: Some(true),
            },
            200,
            &TestSecretStore::default(),
            &client,
        )
        .await
        .expect("probe openai draft");
        assert_eq!(openai_result.status, "supported");
        assert!(openai_result.profile.is_none());
        assert!(!serde_json::to_string(&openai_result)
            .expect("serialize openai result")
            .contains("draft-secret"));

        let google_result = runtime_profile_probe_for_project_with_store(
            Some(Path::new("/tmp")),
            true,
            RuntimeProfileProbeRequest {
                profile_id: None,
                draft: Some(RuntimeProfileProbeDraftRequest {
                    kind: "model-call".to_string(),
                    provider_id: "google".to_string(),
                    model_id: "gemini/test".to_string(),
                    agent_sdk_model_id: None,
                    endpoint: Some(google.uri()),
                    api_mode: "google-generate-content".to_string(),
                    auth_style: "api-key".to_string(),
                }),
                raw_secret: Some("draft-secret".to_string()),
                force: Some(true),
            },
            200,
            &TestSecretStore::default(),
            &client,
        )
        .await
        .expect("probe google draft");
        assert_eq!(google_result.status, "supported");
        assert!(google_result.profile.is_none());
        assert!(!serde_json::to_string(&google_result)
            .expect("serialize google result")
            .contains("draft-secret"));
    }

    #[tokio::test]
    async fn profile_probe_saved_and_draft_no_auth_do_not_require_secret_refs() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/chat/completions"))
            .respond_with(ResponseTemplate::new(200).set_body_string("{}"))
            .mount(&server)
            .await;
        let project = temp_project("profile-probe-no-auth");
        fs::create_dir_all(&project).expect("create temp project");
        let mut create = profile_create_request("profile-1");
        create.endpoint = Some(server.uri());
        create.auth_style = "none".to_string();
        create.secret_ref = None;
        runtime_profile_create_for_project(Some(&project), true, create, 100)
            .expect("create no-auth profile");
        let client = Client::builder().build().expect("client");

        let stored = runtime_profile_probe_for_project_with_store(
            Some(&project),
            true,
            stored_probe_request("profile-1", false),
            200,
            &TestSecretStore::default(),
            &client,
        )
        .await
        .expect("probe saved no-auth profile");
        assert_eq!(stored.status, "supported");

        let draft = runtime_profile_probe_for_project_with_store(
            Some(Path::new("/tmp")),
            true,
            RuntimeProfileProbeRequest {
                profile_id: None,
                draft: Some(RuntimeProfileProbeDraftRequest {
                    kind: "model-call".to_string(),
                    provider_id: "openai".to_string(),
                    model_id: "gpt-test".to_string(),
                    agent_sdk_model_id: None,
                    endpoint: Some(server.uri()),
                    api_mode: "openai-chat-completions".to_string(),
                    auth_style: "none".to_string(),
                }),
                raw_secret: None,
                force: Some(true),
            },
            200,
            &TestSecretStore::default(),
            &client,
        )
        .await
        .expect("probe draft no-auth profile");
        assert_eq!(draft.status, "supported");
        let _ = fs::remove_dir_all(project);
    }

    #[tokio::test]
    async fn profile_probe_local_cli_returns_unsupported_without_backoff() {
        let project = temp_project("profile-probe-local-cli");
        fs::create_dir_all(&project).expect("create temp project");
        let mut create = profile_create_request("profile-1");
        create.provider_id = "claude-code".to_string();
        create.model_id = "claude-code".to_string();
        create.api_mode = "local-cli".to_string();
        create.auth_style = "oauth-local-cli".to_string();
        create.secret_ref = None;
        let created = runtime_profile_create_for_project(Some(&project), true, create, 100)
            .expect("create profile");
        assert!(created.secret_ref.is_none());
        let client = Client::builder().build().expect("client");

        let result = runtime_profile_probe_for_project_with_store(
            Some(&project),
            true,
            stored_probe_request("profile-1", false),
            200,
            &TestSecretStore::default(),
            &client,
        )
        .await
        .expect("probe local cli");

        assert_eq!(result.status, "unsupported");
        assert_eq!(result.backoff_until_ms, None);
        let profile = result.profile.expect("updated profile");
        assert_eq!(profile.capability_status, "unsupported");
        assert_eq!(profile.probe_backoff_until_ms, None);
        assert!(!serde_json::to_string(&profile)
            .expect("serialize local profile")
            .contains("stored-secret"));
        let _ = fs::remove_dir_all(project);
    }

    #[tokio::test]
    async fn profile_probe_ignores_old_version_backoff_once() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/messages"))
            .respond_with(
                ResponseTemplate::new(200).set_body_string("event: message_start\ndata: {}\n"),
            )
            .mount(&server)
            .await;
        let (project, store, client) =
            setup_anthropic_probe_profile("profile-probe-old-version", &server.uri());
        let mut stale = profile_update_request("profile-1");
        stale.probe_backoff_until_ms = Some(999_999);
        stale.last_capability_error = Some("old backoff".to_string());
        runtime_profile_update_for_project(Some(&project), true, stale, 150)
            .expect("seed stale backoff");
        let result = runtime_profile_probe_for_project_with_store(
            Some(&project),
            true,
            stored_probe_request("profile-1", false),
            200,
            &store,
            &client,
        )
        .await
        .expect("probe ignores old version backoff");

        assert_eq!(result.status, "supported");
        let profile = result.profile.expect("updated profile");
        assert_eq!(profile.capability_version, PROFILE_PROBE_CAPABILITY_VERSION);
        assert_eq!(profile.probe_backoff_until_ms, None);
        assert_eq!(profile.last_capability_error, None);
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
    fn profile_pool_list_disabled_no_project_and_missing_tables_are_no_touch() {
        let disabled = runtime_profile_pool_list_for_project(
            None,
            false,
            RuntimeProfilePoolListRequest {
                kind: None,
                task_family: None,
                job_id: None,
            },
            100,
        )
        .expect("disabled list");
        assert_eq!(disabled.status, RuntimeDbHealthState::Disabled);
        assert!(disabled.active_claims.is_empty());

        let no_project = runtime_profile_pool_list_for_project(
            None,
            true,
            RuntimeProfilePoolListRequest {
                kind: None,
                task_family: None,
                job_id: None,
            },
            100,
        )
        .expect("no-project list");
        assert_eq!(no_project.status, RuntimeDbHealthState::NoProject);

        let project = temp_project("profile-pool-missing-tables");
        fs::create_dir_all(&project).expect("create temp project");
        runtime_profile_create_for_project(
            Some(&project),
            true,
            profile_create_request("profile-1"),
            100,
        )
        .expect("create profile schema only");

        let list = runtime_profile_pool_list_for_project(
            Some(&project),
            true,
            RuntimeProfilePoolListRequest {
                kind: None,
                task_family: None,
                job_id: None,
            },
            200,
        )
        .expect("missing pool tables list");
        assert!(list.active_claims.is_empty());
        assert!(!migration_family_exists(&project, PROFILE_POOL_FAMILY));
        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn profile_pool_claim_uses_preferred_order_and_skips_ineligible_ids() {
        let project = temp_project("profile-pool-preferred");
        fs::create_dir_all(&project).expect("create temp project");
        create_profile_pool_profile(
            &project,
            "profile-1",
            "model-call",
            true,
            1,
            profile_pool_capability_json(serde_json::json!(true), serde_json::json!(false)),
        );
        create_profile_pool_profile(
            &project,
            "profile-2",
            "model-call",
            true,
            1,
            profile_pool_capability_json(serde_json::json!(true), serde_json::json!(false)),
        );
        create_profile_pool_profile(
            &project,
            "profile-disabled",
            "model-call",
            false,
            1,
            profile_pool_capability_json(serde_json::json!(true), serde_json::json!(false)),
        );
        create_profile_pool_profile(
            &project,
            "profile-ineligible",
            "model-call",
            true,
            1,
            profile_pool_capability_json(serde_json::json!(false), serde_json::json!(false)),
        );

        let claimed = runtime_profile_pool_claim_for_project(
            Some(&project),
            true,
            profile_pool_claim_request(
                "claim-1",
                vec![
                    "missing",
                    "profile-disabled",
                    "profile-ineligible",
                    "profile-2",
                    "profile-2",
                    "profile-1",
                ],
            ),
            200,
        )
        .expect("claim preferred profile");

        assert_eq!(claimed.profile_id, "profile-2");
        assert!(migration_family_exists(&project, PROFILE_POOL_FAMILY));
        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn profile_pool_rejects_bad_capability_facts_without_hard_parse_errors() {
        let project = temp_project("profile-pool-capability-facts");
        fs::create_dir_all(&project).expect("create temp project");
        create_profile_pool_profile(
            &project,
            "profile-missing",
            "model-call",
            true,
            1,
            "{}".to_string(),
        );
        create_profile_pool_profile(
            &project,
            "profile-non-bool",
            "model-call",
            true,
            1,
            profile_pool_capability_json(serde_json::json!("true"), serde_json::json!(false)),
        );
        create_profile_pool_profile(
            &project,
            "profile-false",
            "model-call",
            true,
            1,
            profile_pool_capability_json(serde_json::json!(false), serde_json::json!(false)),
        );
        create_profile_pool_profile(
            &project,
            "profile-malformed",
            "model-call",
            true,
            1,
            profile_pool_capability_json(serde_json::json!(true), serde_json::json!(false)),
        );
        let connection = Connection::open(runtime_db_path(&project)).expect("open runtime db");
        connection
            .execute(
                "UPDATE runtime_model_profiles
                 SET capability_json = '{bad json}'
                 WHERE profile_id = 'profile-malformed'",
                [],
            )
            .expect("seed malformed capability json");
        drop(connection);

        let error = runtime_profile_pool_claim_for_project(
            Some(&project),
            true,
            profile_pool_claim_request("claim-1", vec![]),
            200,
        )
        .expect_err("bad capability facts are ineligible");

        assert!(error.starts_with("no-eligible-profile"));
        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn profile_pool_capacity_uses_claim_time_sweep_and_list_filters_expired_active_claims() {
        let project = temp_project("profile-pool-capacity");
        fs::create_dir_all(&project).expect("create temp project");
        create_profile_pool_profile(
            &project,
            "profile-1",
            "model-call",
            true,
            1,
            profile_pool_capability_json(serde_json::json!(true), serde_json::json!(false)),
        );
        let mut first = profile_pool_claim_request("claim-1", vec![]);
        first.ttl_ms = Some(1_000);
        runtime_profile_pool_claim_for_project(Some(&project), true, first, 200)
            .expect("first claim");

        let exhausted = runtime_profile_pool_claim_for_project(
            Some(&project),
            true,
            profile_pool_claim_request("claim-2", vec![]),
            300,
        )
        .expect_err("capacity exhausted");
        assert!(exhausted.starts_with("no-eligible-profile"));

        let listed_before_sweep = runtime_profile_pool_list_for_project(
            Some(&project),
            true,
            RuntimeProfilePoolListRequest {
                kind: None,
                task_family: None,
                job_id: None,
            },
            1_300,
        )
        .expect("list filters expired active claim");
        assert!(listed_before_sweep.active_claims.is_empty());

        let claimed = runtime_profile_pool_claim_for_project(
            Some(&project),
            true,
            profile_pool_claim_request("claim-2", vec![]),
            1_300,
        )
        .expect("expired claim no longer consumes capacity");
        assert_eq!(claimed.profile_id, "profile-1");

        let connection = Connection::open(runtime_db_path(&project)).expect("open runtime db");
        let old_status: String = connection
            .query_row(
                "SELECT status FROM runtime_profile_claims WHERE claim_id = 'claim-1'",
                [],
                |row| row.get(0),
            )
            .expect("read expired claim status");
        assert_eq!(old_status, EXPIRED_CLAIM_STATUS);
        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn profile_pool_release_sets_and_clears_circuit_breakers() {
        let project = temp_project("profile-pool-breaker");
        fs::create_dir_all(&project).expect("create temp project");
        create_profile_pool_profile(
            &project,
            "profile-1",
            "model-call",
            true,
            1,
            profile_pool_capability_json(serde_json::json!(true), serde_json::json!(false)),
        );
        runtime_profile_pool_claim_for_project(
            Some(&project),
            true,
            profile_pool_claim_request("claim-1", vec![]),
            200,
        )
        .expect("claim");
        let mut release = profile_pool_release_request("claim-1", "rate-limited");
        release.retry_after_ms = Some(5_000);
        release.reason = Some("provider returned 429 sk-secret".to_string());
        let released = runtime_profile_pool_release_for_project(Some(&project), true, release, 300)
            .expect("release rate limited");
        let breaker = released.circuit_breaker.expect("breaker");
        assert_eq!(breaker.status, "rate-limited");
        assert_eq!(breaker.open_until_ms, 5_300);
        assert!(!breaker.reason.unwrap_or_default().contains("sk-secret"));

        let blocked = runtime_profile_pool_claim_for_project(
            Some(&project),
            true,
            profile_pool_claim_request("claim-2", vec![]),
            400,
        )
        .expect_err("breaker blocks profile");
        assert!(blocked.starts_with("no-eligible-profile"));

        runtime_profile_pool_claim_for_project(
            Some(&project),
            true,
            profile_pool_claim_request("claim-2", vec![]),
            5_400,
        )
        .expect("expired breaker no longer blocks");
        let success = runtime_profile_pool_release_for_project(
            Some(&project),
            true,
            profile_pool_release_request("claim-2", "success"),
            5_500,
        )
        .expect("success clears breaker");
        assert!(success.circuit_breaker.is_none());
        let list = runtime_profile_pool_list_for_project(
            Some(&project),
            true,
            RuntimeProfilePoolListRequest {
                kind: None,
                task_family: None,
                job_id: None,
            },
            5_600,
        )
        .expect("list after clear");
        assert!(list.circuit_breakers.is_empty());
        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn profile_pool_claim_and_release_invariants_are_strict() {
        let project = temp_project("profile-pool-invariants");
        fs::create_dir_all(&project).expect("create temp project");
        create_profile_pool_profile(
            &project,
            "profile-1",
            "model-call",
            true,
            2,
            profile_pool_capability_json(serde_json::json!(true), serde_json::json!(false)),
        );
        runtime_profile_pool_claim_for_project(
            Some(&project),
            true,
            profile_pool_claim_request("claim-1", vec![]),
            200,
        )
        .expect("claim");
        let duplicate = runtime_profile_pool_claim_for_project(
            Some(&project),
            true,
            profile_pool_claim_request("claim-1", vec![]),
            250,
        )
        .expect_err("duplicate claim rejected");
        assert!(duplicate.starts_with("claim-id-conflict"));

        runtime_profile_pool_release_for_project(
            Some(&project),
            true,
            profile_pool_release_request("claim-1", "success"),
            300,
        )
        .expect("release once");
        let released_again = runtime_profile_pool_release_for_project(
            Some(&project),
            true,
            profile_pool_release_request("claim-1", "success"),
            350,
        )
        .expect_err("already released is inactive");
        assert!(released_again.starts_with("claim-inactive"));

        let unknown = runtime_profile_pool_release_for_project(
            Some(&project),
            true,
            profile_pool_release_request("missing", "success"),
            350,
        )
        .expect_err("unknown is inactive");
        assert!(unknown.starts_with("claim-inactive"));

        let invalid_duration = RuntimeProfilePoolReleaseRequest {
            claim_id: "claim-1".to_string(),
            outcome: "error".to_string(),
            retry_after_ms: None,
            circuit_open_ms: Some(MAX_PROFILE_POOL_BREAKER_MS + 1),
            reason: None,
            error: None,
        };
        let duration_error =
            runtime_profile_pool_release_for_project(Some(&project), true, invalid_duration, 400)
                .expect_err("invalid duration rejected");
        assert!(duration_error.starts_with("invalid-circuit-open"));
        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn profile_pool_renew_extends_active_claim_and_rejects_inactive_claims() {
        let project = temp_project("profile-pool-renew");
        fs::create_dir_all(&project).expect("create temp project");
        create_profile_pool_profile(
            &project,
            "profile-1",
            "model-call",
            true,
            1,
            profile_pool_capability_json(serde_json::json!(true), serde_json::json!(false)),
        );
        let mut claim = profile_pool_claim_request("claim-1", vec![]);
        claim.ttl_ms = Some(1_000);
        runtime_profile_pool_claim_for_project(Some(&project), true, claim, 200)
            .expect("claim profile");

        let renewed = runtime_profile_pool_renew_for_project(
            Some(&project),
            true,
            RuntimeProfilePoolRenewRequest {
                claim_id: "claim-1".to_string(),
                ttl_ms: Some(10_000),
            },
            800,
        )
        .expect("renew active claim");
        assert_eq!(renewed.claim_id, "claim-1");
        assert_eq!(renewed.profile_id, "profile-1");
        assert_eq!(renewed.expires_at_ms, 10_800);
        assert_eq!(renewed.claim.expires_at_ms, 10_800);

        runtime_profile_pool_release_for_project(
            Some(&project),
            true,
            profile_pool_release_request("claim-1", "success"),
            900,
        )
        .expect("release claim");
        let released = runtime_profile_pool_renew_for_project(
            Some(&project),
            true,
            RuntimeProfilePoolRenewRequest {
                claim_id: "claim-1".to_string(),
                ttl_ms: Some(10_000),
            },
            1_000,
        )
        .expect_err("released claim is inactive");
        assert!(released.starts_with("claim-inactive"));

        let mut expired_claim = profile_pool_claim_request("claim-2", vec![]);
        expired_claim.ttl_ms = Some(1_000);
        runtime_profile_pool_claim_for_project(Some(&project), true, expired_claim, 2_000)
            .expect("claim second profile slot");
        let expired = runtime_profile_pool_renew_for_project(
            Some(&project),
            true,
            RuntimeProfilePoolRenewRequest {
                claim_id: "claim-2".to_string(),
                ttl_ms: Some(10_000),
            },
            3_000,
        )
        .expect_err("expired claim is inactive");
        assert!(expired.starts_with("claim-inactive"));

        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn agent_run_profile_resolver_uses_active_agent_claim_and_reads_secret() {
        let project = temp_project("agent-profile-resolver");
        fs::create_dir_all(&project).expect("create temp project");
        let profile = create_agent_profile_pool_profile(&project, "profile-agent");
        let mut update = profile_update_request("profile-agent");
        update.agent_sdk_model_id = Some("deepseek-chat".to_string());
        runtime_profile_update_for_project(Some(&project), true, update, 175)
            .expect("set agent sdk alias");
        runtime_profile_pool_claim_for_project(
            Some(&project),
            true,
            agent_profile_pool_claim_request("claim-agent", vec!["profile-agent"]),
            200,
        )
        .expect("claim agent profile");

        let store = TestSecretStore::default();
        store.insert(profile.secret_ref.expect("secret ref"), "agent-secret");
        let resolved = resolve_agent_run_profile_for_project_at_with_store(
            Some(&project),
            true,
            "profile-agent",
            "claim-agent",
            300,
            &store,
        )
        .expect("resolve agent profile");

        assert_eq!(resolved.profile_id, "profile-agent");
        assert_eq!(resolved.provider_model_id, "claude-test");
        assert_eq!(resolved.agent_sdk_model_id, "deepseek-chat");
        assert_eq!(
            resolved.endpoint.as_deref(),
            Some("https://agent.example/v1")
        );
        assert_eq!(resolved.auth_style, "x-api-key");
        assert_eq!(resolved.secret_value.as_deref(), Some("agent-secret"));
        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn agent_run_profile_resolver_falls_back_to_provider_model_without_sdk_alias() {
        let project = temp_project("agent-profile-resolver-fallback");
        fs::create_dir_all(&project).expect("create temp project");
        let profile = create_agent_profile_pool_profile(&project, "profile-agent");
        let now = now_ms().expect("now");
        runtime_profile_pool_claim_for_project(
            Some(&project),
            true,
            agent_profile_pool_claim_request("claim-agent", vec!["profile-agent"]),
            now,
        )
        .expect("claim agent profile");

        let store = TestSecretStore::default();
        store.insert(profile.secret_ref.expect("secret ref"), "agent-secret");
        let resolved = resolve_agent_run_profile_for_project_at_with_store(
            Some(&project),
            true,
            "profile-agent",
            "claim-agent",
            now + 1,
            &store,
        )
        .expect("resolve agent profile");

        assert_eq!(resolved.provider_model_id, "claude-test");
        assert_eq!(resolved.agent_sdk_model_id, "claude-test");
        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn agent_run_profile_resolver_falls_back_when_sdk_alias_is_blank() {
        let project = temp_project("agent-profile-resolver-blank-alias");
        fs::create_dir_all(&project).expect("create temp project");
        let profile = create_agent_profile_pool_profile(&project, "profile-agent");
        let connection = Connection::open(runtime_db_path(&project)).expect("open runtime db");
        connection
            .execute(
                "UPDATE runtime_model_profiles
                 SET agent_sdk_model_id = '   '
                 WHERE profile_id = ?1",
                ["profile-agent"],
            )
            .expect("write blank sdk alias fixture");
        let now = now_ms().expect("now");
        runtime_profile_pool_claim_for_project(
            Some(&project),
            true,
            agent_profile_pool_claim_request("claim-agent", vec!["profile-agent"]),
            now,
        )
        .expect("claim agent profile");

        let store = TestSecretStore::default();
        store.insert(profile.secret_ref.expect("secret ref"), "agent-secret");
        let resolved = resolve_agent_run_profile_for_project_at_with_store(
            Some(&project),
            true,
            "profile-agent",
            "claim-agent",
            now + 1,
            &store,
        )
        .expect("resolve agent profile");

        assert_eq!(resolved.provider_model_id, "claude-test");
        assert_eq!(resolved.agent_sdk_model_id, "claude-test");
        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn agent_profile_error_classifier_distinguishes_sdk_and_gateway_failures() {
        assert_eq!(
            classify_agent_profile_error("There's an issue with the selected model. Run --model.",),
            Some(AGENT_PROFILE_SDK_MODEL_REJECTED_REASON)
        );
        assert_eq!(
            classify_agent_profile_error("gateway returned 401 unauthorized"),
            Some(AGENT_PROFILE_GATEWAY_AUTH_FAILED_REASON)
        );
        assert_eq!(
            classify_agent_profile_error("gateway connection failed on port 4019"),
            None
        );
        assert_eq!(
            classify_agent_profile_error("tool mentioned authentication prerequisites"),
            None
        );
        assert_eq!(classify_agent_profile_error("process exited"), None);
    }

    #[test]
    fn agent_run_profile_sdk_model_rejection_opens_circuit() {
        let project = temp_project("agent-profile-sdk-rejected-circuit");
        fs::create_dir_all(&project).expect("create temp project");
        create_agent_profile_pool_profile(&project, "profile-agent");
        let now = now_ms().expect("now");
        runtime_profile_pool_claim_for_project(
            Some(&project),
            true,
            agent_profile_pool_claim_request("claim-agent", vec!["profile-agent"]),
            now,
        )
        .expect("claim agent profile");

        release_agent_profile_claim_for_project(
            Some(&project),
            true,
            "claim-agent",
            "error",
            Some(
                "There's an issue with the selected model (deepseek-v4-flash). \
                 ANTHROPIC_AUTH_TOKEN=profile-token {\"apiKey\":\"json-token\"} \
                 google=AIzaSyDummYKeyValue Run --model.",
            ),
        )
        .expect("release rejected agent profile");
        let list = runtime_profile_pool_list_for_project(
            Some(&project),
            true,
            RuntimeProfilePoolListRequest {
                kind: Some("agent-run".to_string()),
                task_family: Some("agent".to_string()),
                job_id: None,
            },
            now_ms().expect("now after release"),
        )
        .expect("list pool");
        assert_eq!(list.circuit_breakers.len(), 1);
        assert_eq!(
            list.circuit_breakers[0].reason.as_deref(),
            Some(AGENT_PROFILE_SDK_MODEL_REJECTED_REASON)
        );
        let breaker_error = list.circuit_breakers[0]
            .error
            .as_deref()
            .unwrap_or_default();
        assert!(!breaker_error.contains("profile-token"));
        assert!(!breaker_error.contains("json-token"));
        assert!(!breaker_error.contains("AIza"));
        let blocked = runtime_profile_pool_claim_for_project(
            Some(&project),
            true,
            agent_profile_pool_claim_request("claim-next", vec!["profile-agent"]),
            now_ms().expect("now before circuit expiry"),
        )
        .expect_err("circuit blocks immediate reuse");
        assert!(blocked.starts_with("no-eligible-profile"));
        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn agent_run_profile_resolver_rejects_wrong_claim_and_missing_secret() {
        let project = temp_project("agent-profile-resolver-rejects");
        fs::create_dir_all(&project).expect("create temp project");
        create_agent_profile_pool_profile(&project, "profile-agent");
        create_profile_pool_profile(
            &project,
            "profile-model",
            "model-call",
            true,
            1,
            profile_pool_capability_json(serde_json::json!(true), serde_json::json!(false)),
        );
        runtime_profile_pool_claim_for_project(
            Some(&project),
            true,
            profile_pool_claim_request("claim-model", vec!["profile-model"]),
            200,
        )
        .expect("claim model profile");
        let store = TestSecretStore::default();

        let wrong_kind = resolve_agent_run_profile_for_project_at_with_store(
            Some(&project),
            true,
            "profile-model",
            "claim-model",
            250,
            &store,
        )
        .expect_err("model-call claim is rejected");
        assert!(wrong_kind.starts_with("profile-unsupported"));

        runtime_profile_pool_claim_for_project(
            Some(&project),
            true,
            agent_profile_pool_claim_request("claim-agent", vec!["profile-agent"]),
            300,
        )
        .expect("claim agent profile");
        let missing_secret = resolve_agent_run_profile_for_project_at_with_store(
            Some(&project),
            true,
            "profile-agent",
            "claim-agent",
            350,
            &store,
        )
        .expect_err("missing stored secret is rejected");
        assert!(missing_secret.starts_with("profile-secret-not-found"));

        let read_failed = resolve_agent_run_profile_for_project_at_with_store(
            Some(&project),
            true,
            "profile-agent",
            "claim-agent",
            360,
            &FailingReadSecretStore,
        )
        .expect_err("secret store read failure is rejected");
        assert!(read_failed.starts_with("profile-secret-read-failed"));

        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn agent_run_profile_resolver_rechecks_pool_eligibility_after_claim() {
        let project = temp_project("agent-profile-resolver-eligibility");
        fs::create_dir_all(&project).expect("create temp project");
        create_agent_profile_pool_profile(&project, "profile-agent");
        runtime_profile_pool_claim_for_project(
            Some(&project),
            true,
            agent_profile_pool_claim_request("claim-agent", vec!["profile-agent"]),
            200,
        )
        .expect("claim agent profile");

        let mut unsupported = profile_update_request("profile-agent");
        unsupported.capability_status = Some("unsupported".to_string());
        runtime_profile_update_for_project(Some(&project), true, unsupported, 250)
            .expect("mark claimed profile unsupported");
        let rejected = resolve_agent_run_profile_for_project_at_with_store(
            Some(&project),
            true,
            "profile-agent",
            "claim-agent",
            300,
            &TestSecretStore::default(),
        )
        .expect_err("claimed profile is rechecked");
        assert!(rejected.starts_with("profile-unsupported"));
        let _ = fs::remove_dir_all(project);

        let project = temp_project("agent-profile-resolver-circuit");
        fs::create_dir_all(&project).expect("create temp project");
        create_agent_profile_pool_profile(&project, "profile-agent");
        let mut capacity = profile_update_request("profile-agent");
        capacity.max_concurrency = Some(2);
        runtime_profile_update_for_project(Some(&project), true, capacity, 180)
            .expect("raise agent profile capacity");
        runtime_profile_pool_claim_for_project(
            Some(&project),
            true,
            agent_profile_pool_claim_request("claim-agent", vec!["profile-agent"]),
            200,
        )
        .expect("claim agent profile");
        runtime_profile_pool_claim_for_project(
            Some(&project),
            true,
            agent_profile_pool_claim_request("claim-breaker", vec!["profile-agent"]),
            220,
        )
        .expect("claim breaker profile");
        let mut release = profile_pool_release_request("claim-breaker", "rate-limited");
        release.retry_after_ms = Some(5_000);
        runtime_profile_pool_release_for_project(Some(&project), true, release, 240)
            .expect("open profile circuit");

        let rejected = resolve_agent_run_profile_for_project_at_with_store(
            Some(&project),
            true,
            "profile-agent",
            "claim-agent",
            300,
            &TestSecretStore::default(),
        )
        .expect_err("claimed profile circuit is rechecked");
        assert!(rejected.starts_with("profile-unsupported"));
        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn profile_pool_breaker_bounds_and_sanitization_are_enforced() {
        let project = temp_project("profile-pool-breaker-bounds");
        fs::create_dir_all(&project).expect("create temp project");
        create_profile_pool_profile(
            &project,
            "profile-1",
            "model-call",
            true,
            1,
            profile_pool_capability_json(serde_json::json!(true), serde_json::json!(false)),
        );
        runtime_profile_pool_claim_for_project(
            Some(&project),
            true,
            profile_pool_claim_request("claim-1", vec![]),
            200,
        )
        .expect("claim");

        for invalid_retry_after_ms in [-1, 0, MAX_PROFILE_POOL_BREAKER_MS + 1, i64::MAX] {
            let mut release = profile_pool_release_request("claim-1", "rate-limited");
            release.retry_after_ms = Some(invalid_retry_after_ms);
            let error =
                runtime_profile_pool_release_for_project(Some(&project), true, release, 300)
                    .expect_err("invalid retryAfterMs is rejected before release");
            assert!(error.starts_with("invalid-retry-after"));
        }
        assert!(checked_profile_pool_deadline(i64::MAX, 1, "invalid-circuit-open").is_err());

        let mut release = profile_pool_release_request("claim-1", "rate-limited");
        release.retry_after_ms = Some(5_000);
        release.reason = Some(format!(
            "provider 429 bearer abc key=sk-embedded {}",
            "r".repeat(MAX_PROFILE_POOL_REASON_BYTES + 128)
        ));
        release.error = Some(format!(
            "authorization: secret apiKey=abc {} sk-secret",
            "e".repeat(MAX_PROFILE_POOL_REASON_BYTES + 128)
        ));
        let released = runtime_profile_pool_release_for_project(Some(&project), true, release, 300)
            .expect("sanitized release");
        let breaker = released.circuit_breaker.expect("breaker");
        let reason = breaker.reason.expect("reason");
        let error = breaker.error.expect("error");
        assert!(reason.len() <= MAX_PROFILE_POOL_REASON_BYTES);
        assert!(error.len() <= MAX_PROFILE_POOL_REASON_BYTES);
        assert!(!reason.contains("bearer"));
        assert!(!reason.contains("abc"));
        assert!(!reason.contains("sk-embedded"));
        assert!(!error.contains("authorization:"));
        assert!(!error.contains("apiKey"));
        assert!(!error.contains("sk-secret"));
        let agent_error = redact_profile_pool_text(
            "ANTHROPIC_AUTH_TOKEN=profile-token ANTHROPIC_API_KEY env-token \
             {\"apiKey\":\"json-token\"} google=AIzaSyDummYKeyValue",
        );
        assert!(!agent_error.contains("profile-token"));
        assert!(!agent_error.contains("env-token"));
        assert!(!agent_error.contains("json-token"));
        assert!(!agent_error.contains("AIza"));
        assert_eq!(
            redact_profile_pool_text("flask-error api-key-not-configured"),
            "flask-error api-key-not-configured"
        );
        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn profile_pool_concurrent_claims_do_not_exceed_capacity() {
        let project = temp_project("profile-pool-concurrent");
        fs::create_dir_all(&project).expect("create temp project");
        create_profile_pool_profile(
            &project,
            "profile-1",
            "model-call",
            true,
            1,
            profile_pool_capability_json(serde_json::json!(true), serde_json::json!(false)),
        );

        let shared_project = Arc::new(project.clone());
        let barrier = Arc::new(Barrier::new(4));
        let handles = (0..4)
            .map(|index| {
                let project = Arc::clone(&shared_project);
                let barrier = Arc::clone(&barrier);
                std::thread::spawn(move || {
                    barrier.wait();
                    runtime_profile_pool_claim_for_project(
                        Some(project.as_path()),
                        true,
                        profile_pool_claim_request(&format!("claim-{index}"), vec![]),
                        200,
                    )
                })
            })
            .collect::<Vec<_>>();
        let results = handles
            .into_iter()
            .map(|handle| handle.join().expect("claim thread"))
            .collect::<Vec<_>>();
        assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
        assert!(results
            .iter()
            .filter_map(|result| result.as_ref().err())
            .all(|error| error.starts_with("no-eligible-profile")));

        let list = runtime_profile_pool_list_for_project(
            Some(&project),
            true,
            RuntimeProfilePoolListRequest {
                kind: None,
                task_family: None,
                job_id: None,
            },
            300,
        )
        .expect("list active claims");
        assert_eq!(list.active_claims.len(), 1);
        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn profile_pool_job_linkage_rolls_back_when_audit_writes_fail() {
        let project = temp_project("profile-pool-audit-rollback");
        fs::create_dir_all(&project).expect("create temp project");
        runtime_job_create_for_project(Some(&project), true, create_request("job-1"), 100)
            .expect("create job");
        create_profile_pool_profile(
            &project,
            "profile-1",
            "model-call",
            true,
            2,
            profile_pool_capability_json(serde_json::json!(true), serde_json::json!(false)),
        );
        let connection =
            open_events_progress_runtime_locked(&project).expect("initialize audit tables");
        drop(connection);

        let connection = Connection::open(runtime_db_path(&project)).expect("open runtime db");
        connection
            .execute(
                "CREATE TRIGGER reject_profile_pool_events
                 BEFORE INSERT ON runtime_events
                 WHEN NEW.event_name = 'profile-pool:claimed'
                 BEGIN
                    SELECT RAISE(ABORT, 'forced event failure');
                 END",
                [],
            )
            .expect("create event trigger");
        drop(connection);
        let mut linked = profile_pool_claim_request("claim-event-fails", vec![]);
        linked.job_id = Some("job-1".to_string());
        let claim_error = runtime_profile_pool_claim_for_project(Some(&project), true, linked, 200)
            .expect_err("event failure rolls claim back");
        assert!(claim_error.starts_with("event-insert-failed"));
        let connection = Connection::open(runtime_db_path(&project)).expect("open runtime db");
        let claim_count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM runtime_profile_claims WHERE claim_id = 'claim-event-fails'",
                [],
                |row| row.get(0),
            )
            .expect("read claim count");
        assert_eq!(claim_count, 0);
        connection
            .execute("DROP TRIGGER reject_profile_pool_events", [])
            .expect("drop event trigger");
        drop(connection);

        let mut linked = profile_pool_claim_request("claim-progress-fails", vec![]);
        linked.job_id = Some("job-1".to_string());
        runtime_profile_pool_claim_for_project(Some(&project), true, linked, 300)
            .expect("claim before progress trigger");
        let connection = Connection::open(runtime_db_path(&project)).expect("open runtime db");
        connection
            .execute(
                "CREATE TRIGGER reject_profile_pool_progress
                 BEFORE INSERT ON runtime_progress
                 WHEN NEW.progress_key LIKE 'profile-pool:%'
                 BEGIN
                    SELECT RAISE(ABORT, 'forced progress failure');
                 END",
                [],
            )
            .expect("create progress trigger");
        drop(connection);
        let release_error = runtime_profile_pool_release_for_project(
            Some(&project),
            true,
            profile_pool_release_request("claim-progress-fails", "success"),
            400,
        )
        .expect_err("progress failure rolls release back");
        assert!(release_error.starts_with("progress-upsert-failed"));
        let connection = Connection::open(runtime_db_path(&project)).expect("open runtime db");
        let status: String = connection
            .query_row(
                "SELECT status FROM runtime_profile_claims WHERE claim_id = 'claim-progress-fails'",
                [],
                |row| row.get(0),
            )
            .expect("read claim status");
        assert_eq!(status, ACTIVE_CLAIM_STATUS);
        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn profile_pool_serde_contract_uses_camel_case_fields() {
        let claim_request: RuntimeProfilePoolClaimRequest =
            serde_json::from_value(serde_json::json!({
                "claimId": "claim-1",
                "kind": "model-call",
                "taskFamily": "summarize",
                "holder": "worker-1",
                "jobId": "job-1",
                "ttlMs": 30_000,
                "preferredProfileIds": ["profile-2", "profile-1"]
            }))
            .expect("deserialize claim request");
        assert_eq!(
            claim_request.preferred_profile_ids,
            Some(vec!["profile-2".to_string(), "profile-1".to_string()])
        );
        let release_request: RuntimeProfilePoolReleaseRequest =
            serde_json::from_value(serde_json::json!({
                "claimId": "claim-1",
                "outcome": "rate-limited",
                "retryAfterMs": 60_000,
                "reason": "provider 429"
            }))
            .expect("deserialize release request");
        assert_eq!(release_request.retry_after_ms, Some(60_000));
        let unknown = serde_json::from_value::<RuntimeProfilePoolListRequest>(serde_json::json!({
            "kind": "model-call",
            "unknownField": true
        }))
        .expect_err("deny unknown list fields");
        assert!(unknown.to_string().contains("unknown field"));

        let serialized = serde_json::to_value(RuntimeProfilePoolList {
            enabled: true,
            status: RuntimeDbHealthState::Healthy,
            active_claims: Vec::new(),
            circuit_breakers: Vec::new(),
        })
        .expect("serialize list response");
        assert!(serialized.get("activeClaims").is_some());
        assert!(serialized.get("circuitBreakers").is_some());
        assert!(serialized.get("active_claims").is_none());
    }

    #[test]
    fn profile_pool_job_linkage_writes_events_and_progress_only_when_requested() {
        let project = temp_project("profile-pool-job-linkage");
        fs::create_dir_all(&project).expect("create temp project");
        runtime_job_create_for_project(Some(&project), true, create_request("job-1"), 100)
            .expect("create job");
        create_profile_pool_profile(
            &project,
            "profile-1",
            "model-call",
            true,
            2,
            profile_pool_capability_json(serde_json::json!(true), serde_json::json!(false)),
        );
        let mut linked = profile_pool_claim_request("claim-linked", vec![]);
        linked.job_id = Some("job-1".to_string());
        runtime_profile_pool_claim_for_project(Some(&project), true, linked, 200)
            .expect("linked claim");
        runtime_profile_pool_release_for_project(
            Some(&project),
            true,
            profile_pool_release_request("claim-linked", "success"),
            300,
        )
        .expect("linked release");

        let timeline = runtime_timeline_list_for_project(
            Some(&project),
            true,
            timeline_request(Some("job-1")),
        )
        .expect("timeline");
        assert_eq!(timeline.events.len(), 2);
        assert_eq!(timeline.events[0].event_name, PROFILE_POOL_CLAIMED_NAME);
        assert_eq!(timeline.events[1].event_name, PROFILE_POOL_RELEASED_NAME);
        let progress = runtime_progress_list_for_project(
            Some(&project),
            true,
            progress_list_request(Some("job-1")),
        )
        .expect("progress");
        assert_eq!(progress.progress.len(), 1);
        assert_eq!(
            progress.progress[0].progress_key,
            "profile-pool:claim-linked"
        );

        runtime_profile_pool_claim_for_project(
            Some(&project),
            true,
            profile_pool_claim_request("claim-unlinked", vec![]),
            400,
        )
        .expect("unlinked claim");
        runtime_profile_pool_release_for_project(
            Some(&project),
            true,
            profile_pool_release_request("claim-unlinked", "success"),
            500,
        )
        .expect("unlinked release");
        let timeline_after =
            runtime_timeline_list_for_project(Some(&project), true, timeline_request(None))
                .expect("timeline after unlinked");
        assert_eq!(timeline_after.events.len(), 2);
        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn derived_stale_marker_validation_rejects_invalid_inputs() {
        let project = temp_project("derived-marker-validation");
        fs::create_dir_all(&project).expect("create temp project");
        runtime_job_create_for_project(Some(&project), true, create_request("job-1"), 100)
            .expect("create parent job");
        runtime_event_append_for_project(
            Some(&project),
            true,
            event_request(Some("job-1"), "event-1", "{}"),
            200,
        )
        .expect("append commit event");

        let mut missing_hash =
            marker_record_request("marker-no-hash", "embedding", "wiki/a.md", "event-1");
        missing_hash.input_hash = None;
        let missing_hash_error = runtime_derived_stale_marker_record_for_project(
            Some(&project),
            true,
            missing_hash,
            300,
        )
        .expect_err("non-delete marker requires input hash");
        assert!(missing_hash_error.starts_with("invalid-input-hash"));

        let mut duplicate_version = marker_record_request(
            "marker-duplicate-version",
            "embedding",
            "wiki/a.md",
            "event-1",
        );
        duplicate_version.base_version = "event-1".to_string();
        let duplicate_version_error = runtime_derived_stale_marker_record_for_project(
            Some(&project),
            true,
            duplicate_version,
            300,
        )
        .expect_err("baseVersion cannot duplicate sourceEventId");
        assert!(duplicate_version_error.starts_with("invalid-base-version"));

        let mut delete_marker =
            marker_record_request("marker-delete", "search", "wiki/a.md", "event-1");
        delete_marker.reason = "delete".to_string();
        delete_marker.input_hash = None;
        let deleted = runtime_derived_stale_marker_record_for_project(
            Some(&project),
            true,
            delete_marker,
            300,
        )
        .expect("delete marker allows null input hash");
        assert_eq!(deleted.reason, "delete");
        assert!(deleted.input_hash.is_none());

        let duplicate_id = marker_record_request("marker-delete", "search", "wiki/a.md", "event-1");
        let duplicate_error = runtime_derived_stale_marker_record_for_project(
            Some(&project),
            true,
            duplicate_id,
            300,
        )
        .expect_err("duplicate marker id rejected");
        assert!(duplicate_error.starts_with("derived-marker-record-insert-failed"));

        let mut delete_with_hash =
            marker_record_request("marker-delete-hash", "search", "wiki/a.md", "event-1");
        delete_with_hash.reason = "delete".to_string();
        let delete_hash_error = runtime_derived_stale_marker_record_for_project(
            Some(&project),
            true,
            delete_with_hash,
            300,
        )
        .expect_err("delete marker rejects input hash");
        assert!(delete_hash_error.starts_with("invalid-input-hash"));

        let invalid_layer =
            marker_record_request("marker-invalid-layer", "unknown", "wiki/a.md", "event-1");
        let layer_error = runtime_derived_stale_marker_record_for_project(
            Some(&project),
            true,
            invalid_layer,
            300,
        )
        .expect_err("invalid layer rejected");
        assert!(layer_error.starts_with("invalid-layer"));

        let missing_event =
            marker_record_request("marker-missing-event", "embedding", "wiki/a.md", "missing");
        let event_error = runtime_derived_stale_marker_record_for_project(
            Some(&project),
            true,
            missing_event,
            300,
        )
        .expect_err("missing source event rejected");
        assert!(event_error.starts_with("event-read-failed"));
        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn derived_stale_marker_migration_preserves_higher_version_and_enforces_fk() {
        let project = temp_project("derived-marker-migration");
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
                params![DERIVED_STALE_MARKERS_FAMILY, 2_i64, 42_i64],
            )
            .expect("seed higher migration");
        drop(connection);

        runtime_job_create_for_project(Some(&project), true, create_request("job-1"), 100)
            .expect("create parent job");
        runtime_event_append_for_project(
            Some(&project),
            true,
            event_request(Some("job-1"), "event-1", "{}"),
            200,
        )
        .expect("append event");
        runtime_derived_stale_marker_record_for_project(
            Some(&project),
            true,
            marker_record_request("marker-1", "embedding", "wiki/a.md", "event-1"),
            300,
        )
        .expect("record marker");

        assert_eq!(
            read_migration_family(&project, DERIVED_STALE_MARKERS_FAMILY),
            RuntimeDbMigrationStatus {
                family: DERIVED_STALE_MARKERS_FAMILY.to_string(),
                version: 2,
                applied_at_ms: 42,
            }
        );

        with_runtime_writer(|| {
            let connection = open_derived_stale_markers_runtime_locked(&project)?;
            let foreign_keys = connection
                .query_row("PRAGMA foreign_keys", [], |row| row.get::<_, i64>(0))
                .expect("read foreign key pragma");
            assert_eq!(foreign_keys, 1);
            let error = connection
                .execute(
                    "INSERT INTO runtime_derived_stale_markers (
                        marker_id,
                        layer,
                        affected_path,
                        input_hash,
                        base_version,
                        marked_at_ms,
                        reason,
                        source_event_id,
                        status,
                        updated_at_ms
                    ) VALUES (
                        'marker-orphan',
                        'embedding',
                        'wiki/a.md',
                        'sha256:def',
                        'event:1:missing',
                        1,
                        'commit',
                        'missing',
                        'pending',
                        1
                    )",
                    [],
                )
                .expect_err("orphan marker must fail");
            assert!(error.to_string().contains("FOREIGN KEY"));
            Ok(())
        })
        .expect("schema init succeeds");
        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn enabled_commit_budget_list_on_damaged_runtime_db_returns_error() {
        let project = temp_project("commit-budget-list-damaged-db");
        let runtime_dir = project.join(RUNTIME_DIR);
        fs::create_dir_all(&runtime_dir).expect("create runtime dir");
        fs::write(runtime_dir.join(RUNTIME_DB_FILE), b"not sqlite").expect("write damaged db");

        let error = runtime_commit_budget_list_for_project(Some(&project), true)
            .expect_err("enabled list should report damaged db");

        assert!(
            error.contains("commit-budget-list-open-failed")
                || error.contains("table-exists-check-failed")
        );
        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn commit_budget_claim_upgrades_pr2_db_and_rejects_missing_job_id() {
        let project = temp_project("commit-budget-pr2-upgrade");
        fs::create_dir_all(&project).expect("create temp project");
        runtime_db_health_for_project(Some(&project), true).expect("create PR2 runtime db");

        let mut request = commit_claim_request("wiki/a.md", "claim-1");
        request.job_id = Some("missing-job".to_string());
        let error = runtime_commit_budget_claim_for_project(Some(&project), true, request, 100)
            .expect_err("missing job should fail");

        assert!(error.starts_with("job-not-found"));
        assert_eq!(
            read_migration_family(&project, JOBS_FAMILY).version,
            JOBS_VERSION
        );
        assert_eq!(
            read_migration_family(&project, LEASES_FAMILY).version,
            LEASES_VERSION
        );
        assert_eq!(
            read_migration_family(&project, RESOURCE_BUDGETS_FAMILY).version,
            RESOURCE_BUDGETS_VERSION
        );
        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn resource_budget_migration_preserves_higher_version() {
        let project = temp_project("commit-budget-higher-version");
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
                params![RESOURCE_BUDGETS_FAMILY, 2_i64, 42_i64],
            )
            .expect("seed higher migration");
        drop(connection);

        runtime_commit_budget_claim_for_project(
            Some(&project),
            true,
            commit_claim_request("wiki/a.md", "claim-1"),
            100,
        )
        .expect("claim budget");
        let migration = read_migration_family(&project, RESOURCE_BUDGETS_FAMILY);

        assert_eq!(
            migration,
            RuntimeDbMigrationStatus {
                family: RESOURCE_BUDGETS_FAMILY.to_string(),
                version: 2,
                applied_at_ms: 42,
            }
        );
        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn events_progress_migration_preserves_higher_version_and_is_idempotent() {
        let project = temp_project("events-progress-higher-version");
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
                params![EVENTS_PROGRESS_FAMILY, 2_i64, 42_i64],
            )
            .expect("seed higher migration");
        drop(connection);

        runtime_job_create_for_project(Some(&project), true, create_request("job-1"), 100)
            .expect("create parent job");
        runtime_event_append_for_project(
            Some(&project),
            true,
            event_request(Some("job-1"), "event-1", "{}"),
            200,
        )
        .expect("append event");
        let first = read_migration_family(&project, EVENTS_PROGRESS_FAMILY);

        runtime_event_append_for_project(
            Some(&project),
            true,
            event_request(Some("job-1"), "event-2", "{}"),
            300,
        )
        .expect("append second event");
        let second = read_migration_family(&project, EVENTS_PROGRESS_FAMILY);

        assert_eq!(
            first,
            RuntimeDbMigrationStatus {
                family: EVENTS_PROGRESS_FAMILY.to_string(),
                version: 2,
                applied_at_ms: 42,
            }
        );
        assert_eq!(first, second);
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
    fn event_schema_enables_foreign_keys_and_rejects_orphan_event() {
        let project = temp_project("events-progress-fk");
        fs::create_dir_all(&project).expect("create temp project");

        with_runtime_writer(|| {
            let connection = open_events_progress_runtime_locked(&project)?;
            let foreign_keys = connection
                .query_row("PRAGMA foreign_keys", [], |row| row.get::<_, i64>(0))
                .expect("read foreign key pragma");
            assert_eq!(foreign_keys, 1);
            let error = connection
                .execute(
                    "INSERT INTO runtime_events (
                        event_id,
                        job_id,
                        event_name,
                        payload,
                        created_at_ms
                    ) VALUES ('event-orphan', 'missing-job', 'job-runtime:event-appended', '{}', 1)",
                    [],
                )
                .expect_err("orphan event must fail");
            assert!(error.to_string().contains("FOREIGN KEY"));
            Ok(())
        })
        .expect("schema init succeeds");

        let migration = read_migration_family(&project, EVENTS_PROGRESS_FAMILY);
        with_runtime_writer(|| {
            open_events_progress_runtime_locked(&project)?;
            Ok(())
        })
        .expect("schema init is idempotent");
        assert_eq!(
            migration,
            read_migration_family(&project, EVENTS_PROGRESS_FAMILY)
        );
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

    #[test]
    fn commit_budget_claim_release_and_list_happy_path() {
        let project = temp_project("commit-budget-happy");
        fs::create_dir_all(&project).expect("create temp project");

        let claim = runtime_commit_budget_claim_for_project(
            Some(&project),
            true,
            commit_claim_request("Wiki/A.md", "claim-1"),
            100,
        )
        .expect("claim commit budget");

        assert_eq!(claim.claim_id, "claim-1");
        assert_eq!(claim.display_key, "Wiki/A.md");
        assert_eq!(claim.resource_key, "wiki/a.md");
        assert_eq!(claim.expires_at_ms, 100 + DEFAULT_LEASE_TTL_MS);
        assert_eq!(claim.claims.len(), 2);
        assert!(claim
            .claims
            .iter()
            .all(|row| row.status == ACTIVE_CLAIM_STATUS));

        let list = runtime_commit_budget_list_for_project(Some(&project), true)
            .expect("list commit budgets");
        assert_eq!(list.budgets.len(), 2);
        assert_eq!(list.claims.len(), 2);

        let released = runtime_commit_budget_release_for_project(
            Some(&project),
            true,
            commit_release_request("claim-1"),
            200,
        )
        .expect("release commit budget");
        assert_eq!(released.len(), 2);
        assert!(released
            .iter()
            .all(|row| row.status == RELEASED_CLAIM_STATUS));
        assert!(released.iter().all(|row| row.released_at_ms == Some(200)));

        let released_again = runtime_commit_budget_release_for_project(
            Some(&project),
            true,
            commit_release_request("claim-1"),
            300,
        )
        .expect_err("repeated release is inactive");
        assert!(released_again.starts_with("claim-inactive"));

        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn commit_budget_claim_with_existing_job_id_persists_job_id() {
        let project = temp_project("commit-budget-job-id");
        fs::create_dir_all(&project).expect("create temp project");
        runtime_job_create_for_project(Some(&project), true, create_request("job-1"), 100)
            .expect("create job");
        let mut request = commit_claim_request("wiki/a.md", "claim-1");
        request.job_id = Some("job-1".to_string());

        let claim = runtime_commit_budget_claim_for_project(Some(&project), true, request, 200)
            .expect("claim with job id");

        assert_eq!(claim.claims.len(), 2);
        assert!(claim
            .claims
            .iter()
            .all(|row| row.job_id.as_deref() == Some("job-1")));
        let list = runtime_commit_budget_list_for_project(Some(&project), true).expect("list");
        assert!(list
            .claims
            .iter()
            .all(|row| row.job_id.as_deref() == Some("job-1")));
        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn event_append_requires_existing_job_and_timeline_is_stably_ordered() {
        let project = temp_project("events-progress-event-order");
        fs::create_dir_all(&project).expect("create temp project");

        let missing_job = runtime_event_append_for_project(
            Some(&project),
            true,
            event_request(Some("missing-job"), "event-missing", "{}"),
            100,
        )
        .expect_err("missing job is rejected");
        assert!(missing_job.starts_with("job-not-found"));

        let missing_job_id = runtime_event_append_for_project(
            Some(&project),
            true,
            event_request(None, "event-no-job", "{}"),
            100,
        )
        .expect_err("missing job id is rejected");
        assert!(missing_job_id.starts_with("invalid-job-id"));

        runtime_job_create_for_project(Some(&project), true, create_request("job-1"), 100)
            .expect("create job");
        let before = runtime_job_list_for_project(Some(&project), true).expect("list jobs");
        assert_eq!(before.jobs[0].state, "queued");
        assert_eq!(before.jobs[0].updated_at_ms, 100);
        let event_b = runtime_event_append_for_project(
            Some(&project),
            true,
            event_request(Some("job-1"), "event-b", "{\"step\":2}"),
            200,
        )
        .expect("append event b");
        let event_a = runtime_event_append_for_project(
            Some(&project),
            true,
            event_request(Some("job-1"), "event-a", "{\"step\":1}"),
            200,
        )
        .expect("append event a");

        assert_eq!(event_a.event_name, EVENT_APPENDED_NAME);
        assert_eq!(event_b.event_name, EVENT_APPENDED_NAME);
        let after = runtime_job_list_for_project(Some(&project), true).expect("list jobs");
        assert_eq!(after.jobs[0].state, "queued");
        assert_eq!(after.jobs[0].updated_at_ms, 100);
        let timeline = runtime_timeline_list_for_project(
            Some(&project),
            true,
            timeline_request(Some("job-1")),
        )
        .expect("timeline list");
        assert_eq!(
            timeline
                .events
                .iter()
                .map(|event| event.event_id.as_str())
                .collect::<Vec<_>>(),
            vec!["event-a", "event-b"]
        );
        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn progress_append_coalesces_by_key_and_preserves_last_event_id() {
        let project = temp_project("events-progress-coalesce");
        fs::create_dir_all(&project).expect("create temp project");
        runtime_job_create_for_project(Some(&project), true, create_request("job-1"), 100)
            .expect("create job");

        let first = runtime_progress_append_for_project(
            Some(&project),
            true,
            progress_request(Some("job-1"), "compile", "event-1", "{\"pct\":10}", false),
            1_000,
        )
        .expect("first progress append");
        assert_eq!(
            first.event.as_ref().map(|event| event.event_id.as_str()),
            Some("event-1")
        );
        assert_eq!(first.progress.last_event_id.as_deref(), Some("event-1"));

        let coalesced = runtime_progress_append_for_project(
            Some(&project),
            true,
            progress_request(Some("job-1"), "compile", "event-2", "{\"pct\":20}", false),
            1_000 + DEFAULT_PROGRESS_MIN_INTERVAL_MS - 1,
        )
        .expect("coalesced progress append");
        assert!(coalesced.event.is_none());
        assert_eq!(coalesced.progress.payload, "{\"pct\":20}");
        assert_eq!(coalesced.progress.last_event_id.as_deref(), Some("event-1"));

        let boundary = runtime_progress_append_for_project(
            Some(&project),
            true,
            progress_request(Some("job-1"), "compile", "event-3", "{\"pct\":30}", false),
            1_000 + DEFAULT_PROGRESS_MIN_INTERVAL_MS - 1 + DEFAULT_PROGRESS_MIN_INTERVAL_MS,
        )
        .expect("boundary progress append");
        assert_eq!(
            boundary.event.as_ref().map(|event| event.event_id.as_str()),
            Some("event-3")
        );
        assert_eq!(boundary.progress.last_event_id.as_deref(), Some("event-3"));

        let durable = runtime_progress_append_for_project(
            Some(&project),
            true,
            progress_request(Some("job-1"), "compile", "event-4", "{\"pct\":40}", true),
            1_000 + DEFAULT_PROGRESS_MIN_INTERVAL_MS - 1 + DEFAULT_PROGRESS_MIN_INTERVAL_MS + 1,
        )
        .expect("durable progress append");
        assert_eq!(
            durable.event.as_ref().map(|event| event.event_id.as_str()),
            Some("event-4")
        );
        assert_eq!(durable.progress.last_event_id.as_deref(), Some("event-4"));

        let durable_again = runtime_progress_append_for_project(
            Some(&project),
            true,
            progress_request(Some("job-1"), "compile", "event-5", "{\"pct\":45}", true),
            1_000 + DEFAULT_PROGRESS_MIN_INTERVAL_MS - 1 + DEFAULT_PROGRESS_MIN_INTERVAL_MS + 2,
        )
        .expect("second durable progress append");
        assert_eq!(
            durable_again
                .event
                .as_ref()
                .map(|event| event.event_id.as_str()),
            Some("event-5")
        );
        assert_eq!(
            durable_again.progress.last_event_id.as_deref(),
            Some("event-5")
        );

        let suppressed_after_durable = runtime_progress_append_for_project(
            Some(&project),
            true,
            progress_request(Some("job-1"), "compile", "event-6", "{\"pct\":50}", false),
            1_000 + DEFAULT_PROGRESS_MIN_INTERVAL_MS - 1 + DEFAULT_PROGRESS_MIN_INTERVAL_MS + 2,
        )
        .expect("suppressed after durable");
        assert!(suppressed_after_durable.event.is_none());
        assert_eq!(
            suppressed_after_durable.progress.last_event_id.as_deref(),
            Some("event-5")
        );

        let timeline = runtime_timeline_list_for_project(
            Some(&project),
            true,
            timeline_request(Some("job-1")),
        )
        .expect("timeline list");
        assert_eq!(
            timeline
                .events
                .iter()
                .map(|event| event.event_id.as_str())
                .collect::<Vec<_>>(),
            vec!["event-1", "event-3", "event-4", "event-5"]
        );
        let progress = runtime_progress_list_for_project(
            Some(&project),
            true,
            progress_list_request(Some("job-1")),
        )
        .expect("progress list");
        assert_eq!(progress.progress.len(), 1);
        assert_eq!(progress.progress[0].payload, "{\"pct\":50}");
        assert_eq!(
            progress.progress[0].last_event_id.as_deref(),
            Some("event-5")
        );
        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn event_progress_validation_rejects_blank_and_oversized_payloads() {
        let project = temp_project("events-progress-validation");
        fs::create_dir_all(&project).expect("create temp project");
        runtime_job_create_for_project(Some(&project), true, create_request("job-1"), 100)
            .expect("create job");

        let exact_payload = "x".repeat(MAX_EVENT_PAYLOAD_BYTES);
        let exact_event = runtime_event_append_for_project(
            Some(&project),
            true,
            event_request(Some("job-1"), "event-exact", &exact_payload),
            150,
        )
        .expect("exact max payload is allowed");
        assert_eq!(exact_event.payload.len(), MAX_EVENT_PAYLOAD_BYTES);

        let blank_event = runtime_event_append_for_project(
            Some(&project),
            true,
            event_request(Some("job-1"), "event-blank", "  "),
            200,
        )
        .expect_err("blank event payload rejected");
        assert!(blank_event.starts_with("invalid-payload"));

        let oversized = "x".repeat(MAX_EVENT_PAYLOAD_BYTES + 1);
        let oversized_progress = runtime_progress_append_for_project(
            Some(&project),
            true,
            progress_request(Some("job-1"), "compile", "event-large", &oversized, false),
            200,
        )
        .expect_err("oversized progress payload rejected");
        assert!(oversized_progress.starts_with("invalid-payload"));

        with_runtime_writer(|| {
            let connection = open_events_progress_runtime_locked(&project)?;
            let error = connection
                .execute(
                    "INSERT INTO runtime_events (
                        event_id,
                        job_id,
                        event_name,
                        payload,
                        created_at_ms
                    ) VALUES (?1, ?2, ?3, ?4, ?5)",
                    params![
                        "event-db-check",
                        "job-1",
                        EVENT_APPENDED_NAME,
                        oversized,
                        250_i64
                    ],
                )
                .expect_err("DB CHECK rejects oversized event payload");
            assert!(error.to_string().contains("CHECK"));

            let multibyte_oversized = "你".repeat((MAX_EVENT_PAYLOAD_BYTES / "你".len()) + 1);
            assert!(multibyte_oversized.chars().count() <= MAX_EVENT_PAYLOAD_BYTES);
            assert!(multibyte_oversized.len() > MAX_EVENT_PAYLOAD_BYTES);
            let multibyte_error = connection
                .execute(
                    "INSERT INTO runtime_progress (
                        job_id,
                        progress_key,
                        payload,
                        updated_at_ms
                    ) VALUES (?1, ?2, ?3, ?4)",
                    params!["job-1", "multibyte", multibyte_oversized, 260_i64],
                )
                .expect_err("DB CHECK rejects multibyte oversized progress payload");
            assert!(multibyte_error.to_string().contains("CHECK"));
            Ok(())
        })
        .expect("DB CHECK boundary test succeeds");

        let invalid_limit = runtime_timeline_list_for_project(
            Some(&project),
            true,
            RuntimeTimelineListRequest {
                job_id: None,
                limit: Some(MAX_TIMELINE_LIMIT + 1),
            },
        )
        .expect_err("invalid limit rejected");
        assert!(invalid_limit.starts_with("invalid-limit"));

        let list = runtime_progress_list_for_project(
            Some(&project),
            true,
            progress_list_request(Some("job-1")),
        )
        .expect("progress list");
        assert!(list.progress.is_empty());
        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn commit_budget_rejects_duplicate_claim_id_and_same_path() {
        let project = temp_project("commit-budget-duplicates");
        fs::create_dir_all(&project).expect("create temp project");
        runtime_commit_budget_claim_for_project(
            Some(&project),
            true,
            commit_claim_request("wiki/a.md", "claim-1"),
            100,
        )
        .expect("claim first path");

        let duplicate_id = runtime_commit_budget_claim_for_project(
            Some(&project),
            true,
            commit_claim_request("wiki/b.md", "claim-1"),
            100,
        )
        .expect_err("duplicate claim id is rejected");
        assert!(duplicate_id.starts_with("claim-id-conflict"));

        let duplicate_path = runtime_commit_budget_claim_for_project(
            Some(&project),
            true,
            commit_claim_request("WIKI/A.MD", "claim-2"),
            100,
        )
        .expect_err("same path identity is rejected");
        assert!(duplicate_path.starts_with("commit-path-already-claimed"));
        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn commit_budget_rejects_empty_claim_id_without_mutation() {
        let project = temp_project("commit-budget-empty-claim-id");
        fs::create_dir_all(&project).expect("create temp project");
        let mut request = commit_claim_request("wiki/a.md", "   ");
        request.claim_id = Some("   ".to_string());

        let error = runtime_commit_budget_claim_for_project(Some(&project), true, request, 100)
            .expect_err("empty claim id is rejected");

        assert!(error.starts_with("invalid-claim-id"));
        let list = runtime_commit_budget_list_for_project(Some(&project), true).expect("list");
        assert!(list.budgets.is_empty());
        assert!(list.claims.is_empty());
        assert!(!runtime_db_path(&project).exists());
        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn commit_budget_unique_index_rejects_duplicate_active_path_claim() {
        let project = temp_project("commit-budget-unique-index");
        fs::create_dir_all(&project).expect("create temp project");
        with_runtime_writer(|| {
            let connection = open_resource_budget_runtime_locked(&project)?;
            connection
                .execute(
                    "INSERT OR IGNORE INTO runtime_resource_budgets (
                        scope,
                        resource_key,
                        display_key,
                        capacity,
                        created_at_ms,
                        updated_at_ms
                    ) VALUES ('commit-path', 'wiki/a.md', 'wiki/a.md', 1, 100, 100)",
                    [],
                )
                .expect("insert path budget");
            connection
                .execute(
                    "INSERT INTO runtime_resource_budget_claims (
                        claim_id,
                        scope,
                        resource_key,
                        display_key,
                        holder,
                        amount,
                        acquired_at_ms,
                        expires_at_ms,
                        status
                    ) VALUES ('claim-1', 'commit-path', 'wiki/a.md', 'wiki/a.md', 'tester:a', 1, 100, 200, 'active')",
                    [],
                )
                .expect("insert first active path claim");
            let error = connection
                .execute(
                    "INSERT INTO runtime_resource_budget_claims (
                        claim_id,
                        scope,
                        resource_key,
                        display_key,
                        holder,
                        amount,
                        acquired_at_ms,
                        expires_at_ms,
                        status
                    ) VALUES ('claim-2', 'commit-path', 'wiki/a.md', 'wiki/a.md', 'tester:b', 1, 100, 200, 'active')",
                    [],
                )
                .expect_err("second active path claim must fail");
            assert!(error.to_string().contains("UNIQUE"));
            Ok(())
        })
        .expect("unique index test succeeds");
        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn commit_budget_total_capacity_rolls_back_path_claim() {
        let project = temp_project("commit-budget-total-capacity");
        fs::create_dir_all(&project).expect("create temp project");
        runtime_commit_budget_claim_for_project(
            Some(&project),
            true,
            commit_claim_request("wiki/a.md", "claim-1"),
            100,
        )
        .expect("claim first path");
        runtime_commit_budget_claim_for_project(
            Some(&project),
            true,
            commit_claim_request("wiki/b.md", "claim-2"),
            100,
        )
        .expect("claim second path");

        let exhausted = runtime_commit_budget_claim_for_project(
            Some(&project),
            true,
            commit_claim_request("wiki/c.md", "claim-3"),
            100,
        )
        .expect_err("total capacity exhausted");

        assert!(exhausted.starts_with("commit-total-budget-exhausted"));
        let list = runtime_commit_budget_list_for_project(Some(&project), true)
            .expect("list commit budgets");
        assert_eq!(list.claims.len(), 4);
        assert!(!list
            .claims
            .iter()
            .any(|claim| claim.resource_key == "wiki/c.md"));
        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn commit_budget_expire_releases_capacity_after_ttl() {
        let project = temp_project("commit-budget-expire");
        fs::create_dir_all(&project).expect("create temp project");
        runtime_commit_budget_claim_for_project(
            Some(&project),
            true,
            commit_claim_request("wiki/a.md", "claim-1"),
            100,
        )
        .expect("claim path");

        let early = runtime_commit_budget_expire_for_project(
            Some(&project),
            true,
            "claim-1",
            100 + DEFAULT_LEASE_TTL_MS - 1,
        )
        .expect_err("early expire is rejected");
        assert!(early.starts_with("claim-not-expired"));

        let expired = runtime_commit_budget_expire_for_project(
            Some(&project),
            true,
            "claim-1",
            100 + DEFAULT_LEASE_TTL_MS,
        )
        .expect("expire claim");
        assert_eq!(expired.len(), 2);
        assert!(expired.iter().all(|row| row.status == EXPIRED_CLAIM_STATUS));
        assert!(expired.iter().all(|row| row.released_at_ms.is_none()));

        let release_expired = runtime_commit_budget_release_for_project(
            Some(&project),
            true,
            commit_release_request("claim-1"),
            300,
        )
        .expect_err("expired claim cannot be released");
        assert!(release_expired.starts_with("claim-inactive"));

        let reclaimed = runtime_commit_budget_claim_for_project(
            Some(&project),
            true,
            commit_claim_request("wiki/a.md", "claim-2"),
            300,
        )
        .expect("reclaim expired path");
        assert_eq!(reclaimed.resource_key, "wiki/a.md");
        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn commit_budget_release_and_expire_reject_inconsistent_claim_pairs() {
        let project = temp_project("commit-budget-inconsistent");
        fs::create_dir_all(&project).expect("create temp project");
        runtime_commit_budget_claim_for_project(
            Some(&project),
            true,
            commit_claim_request("wiki/a.md", "claim-1"),
            100,
        )
        .expect("claim path");
        let connection = Connection::open(runtime_db_path(&project)).expect("open runtime db");
        connection
            .execute(
                "UPDATE runtime_resource_budget_claims
                 SET status = 'released'
                 WHERE claim_id = 'claim-1' AND scope = 'commit-path'",
                [],
            )
            .expect("damage claim pair");
        drop(connection);

        let release_error = runtime_commit_budget_release_for_project(
            Some(&project),
            true,
            commit_release_request("claim-1"),
            200,
        )
        .expect_err("inconsistent release is rejected");
        assert!(release_error.starts_with("claim-inconsistent"));

        let expire_error =
            runtime_commit_budget_expire_for_project(Some(&project), true, "claim-1", 500_000)
                .expect_err("inconsistent expire is rejected");
        assert!(expire_error.starts_with("claim-inconsistent"));
        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn commit_budget_release_rejects_extra_active_claim_rows() {
        let project = temp_project("commit-budget-extra-active-row");
        fs::create_dir_all(&project).expect("create temp project");
        runtime_commit_budget_claim_for_project(
            Some(&project),
            true,
            commit_claim_request("wiki/a.md", "claim-1"),
            100,
        )
        .expect("claim path");
        let connection = Connection::open(runtime_db_path(&project)).expect("open runtime db");
        connection
            .execute(
                "INSERT OR IGNORE INTO runtime_resource_budgets (
                    scope,
                    resource_key,
                    display_key,
                    capacity,
                    created_at_ms,
                    updated_at_ms
                ) VALUES ('commit-path', 'wiki/extra.md', 'wiki/extra.md', 1, 100, 100)",
                [],
            )
            .expect("insert extra budget");
        connection
            .execute(
                "INSERT INTO runtime_resource_budget_claims (
                    claim_id,
                    scope,
                    resource_key,
                    display_key,
                    holder,
                    amount,
                    acquired_at_ms,
                    expires_at_ms,
                    status
                ) VALUES ('claim-1', 'commit-path', 'wiki/extra.md', 'wiki/extra.md', 'tester:x', 1, 100, 200, 'active')",
                [],
            )
            .expect("insert extra active row");
        drop(connection);

        let error = runtime_commit_budget_release_for_project(
            Some(&project),
            true,
            commit_release_request("claim-1"),
            200,
        )
        .expect_err("extra active row is inconsistent");

        assert!(error.starts_with("claim-inconsistent"));
        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn commit_budget_ttl_bounds_are_enforced() {
        let project = temp_project("commit-budget-ttl");
        fs::create_dir_all(&project).expect("create temp project");

        for (claim_id, ttl_ms) in [("claim-low", Some(0)), ("claim-high", Some(1_200_001))] {
            let mut request = commit_claim_request("wiki/a.md", claim_id);
            request.ttl_ms = ttl_ms;
            let error = runtime_commit_budget_claim_for_project(Some(&project), true, request, 100)
                .expect_err("invalid ttl is rejected");
            assert!(error.starts_with("invalid-ttl"));
        }

        let mut overflow = commit_claim_request("wiki/a.md", "claim-overflow");
        overflow.ttl_ms = Some(MAX_COMMIT_BUDGET_TTL_MS);
        let error =
            runtime_commit_budget_claim_for_project(Some(&project), true, overflow, i64::MAX)
                .expect_err("ttl overflow is rejected");
        assert!(error.starts_with("invalid-ttl"));
        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn commit_budget_ttl_min_and_max_bounds_are_allowed() {
        let project = temp_project("commit-budget-ttl-bounds");
        fs::create_dir_all(&project).expect("create temp project");
        let mut min_request = commit_claim_request("wiki/min.md", "claim-min");
        min_request.ttl_ms = Some(MIN_COMMIT_BUDGET_TTL_MS);
        let min_claim =
            runtime_commit_budget_claim_for_project(Some(&project), true, min_request, 100)
                .expect("min ttl is allowed");
        assert_eq!(min_claim.expires_at_ms, 100 + MIN_COMMIT_BUDGET_TTL_MS);

        let mut max_request = commit_claim_request("wiki/max.md", "claim-max");
        max_request.ttl_ms = Some(MAX_COMMIT_BUDGET_TTL_MS);
        let max_claim =
            runtime_commit_budget_claim_for_project(Some(&project), true, max_request, 100)
                .expect("max ttl is allowed");
        assert_eq!(max_claim.expires_at_ms, 100 + MAX_COMMIT_BUDGET_TTL_MS);
        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn enabled_job_list_on_damaged_runtime_db_returns_error() {
        let project = temp_project("enabled-job-list-damaged-db");
        let runtime_dir = project.join(RUNTIME_DIR);
        fs::create_dir_all(&runtime_dir).expect("create runtime dir");
        fs::write(runtime_dir.join(RUNTIME_DB_FILE), b"not sqlite").expect("write damaged db");

        let error = runtime_job_list_for_project(Some(&project), true)
            .expect_err("enabled list should report damaged db");

        assert!(
            error.contains("job-list-open-failed") || error.contains("table-exists-check-failed")
        );
        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn job_schema_enables_foreign_keys_and_rejects_orphan_lease() {
        let project = temp_project("job-schema-fk");
        fs::create_dir_all(&project).expect("create temp project");

        with_runtime_writer(|| {
            let connection = open_job_runtime_locked(&project)?;
            let foreign_keys = connection
                .query_row("PRAGMA foreign_keys", [], |row| row.get::<_, i64>(0))
                .expect("read foreign key pragma");
            assert_eq!(foreign_keys, 1);
            let error = connection
                .execute(
                    "INSERT INTO runtime_job_leases (
                        lease_id,
                        job_id,
                        holder,
                        acquired_at_ms,
                        heartbeat_at_ms,
                        expires_at_ms,
                        status
                    ) VALUES ('lease-orphan', 'missing-job', 'holder', 1, 1, 2, 'active')",
                    [],
                )
                .expect_err("orphan lease must fail");
            assert!(error.to_string().contains("FOREIGN KEY"));
            Ok(())
        })
        .expect("schema init succeeds");

        let jobs_migration = read_migration_family(&project, JOBS_FAMILY);
        let leases_migration = read_migration_family(&project, LEASES_FAMILY);
        with_runtime_writer(|| {
            open_job_runtime_locked(&project)?;
            Ok(())
        })
        .expect("schema init is idempotent");
        assert_eq!(jobs_migration, read_migration_family(&project, JOBS_FAMILY));
        assert_eq!(
            leases_migration,
            read_migration_family(&project, LEASES_FAMILY)
        );

        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn active_lease_unique_index_rejects_duplicate_active_lease() {
        let project = temp_project("job-active-lease-unique");
        fs::create_dir_all(&project).expect("create temp project");

        with_runtime_writer(|| {
            let connection = open_job_runtime_locked(&project)?;
            connection
                .execute(
                    "INSERT INTO runtime_jobs (
                        job_id,
                        kind,
                        payload,
                        state,
                        attempt,
                        max_attempts,
                        priority,
                        created_at_ms,
                        updated_at_ms,
                        queued_at_ms
                    ) VALUES ('job-1', 'compile-page', '{}', 'running', 1, 3, 0, 100, 100, 100)",
                    [],
                )
                .expect("insert job");
            connection
                .execute(
                    "INSERT INTO runtime_job_leases (
                        lease_id,
                        job_id,
                        holder,
                        acquired_at_ms,
                        heartbeat_at_ms,
                        expires_at_ms,
                        status
                    ) VALUES ('lease-1', 'job-1', 'worker-a', 200, 200, 300, 'active')",
                    [],
                )
                .expect("insert first active lease");
            let error = connection
                .execute(
                    "INSERT INTO runtime_job_leases (
                        lease_id,
                        job_id,
                        holder,
                        acquired_at_ms,
                        heartbeat_at_ms,
                        expires_at_ms,
                        status
                    ) VALUES ('lease-2', 'job-1', 'worker-b', 200, 200, 300, 'active')",
                    [],
                )
                .expect_err("second active lease must fail");
            assert!(error.to_string().contains("UNIQUE"));
            Ok(())
        })
        .expect("unique index check succeeds");

        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn enabled_job_create_without_project_returns_no_project() {
        let error = runtime_job_create_for_project(None, true, create_request("job-1"), 100)
            .expect_err("no-project create should fail");

        assert!(error.starts_with("no-project"));
    }

    #[test]
    fn create_claim_heartbeat_and_complete_job() {
        let project = temp_project("job-happy-path");
        fs::create_dir_all(&project).expect("create temp project");

        let created =
            runtime_job_create_for_project(Some(&project), true, create_request("job-1"), 100)
                .expect("create job");
        assert_eq!(created.state, "queued");
        assert_eq!(created.attempt, 0);

        let claimed = runtime_job_claim_for_project(
            Some(&project),
            true,
            claim_request("worker-a", "lease-1"),
            200,
        )
        .expect("claim job");
        assert_eq!(claimed.job.state, "running");
        assert_eq!(claimed.job.attempt, 1);
        assert_eq!(claimed.lease.status, ACTIVE_LEASE_STATUS);
        assert_eq!(claimed.lease.expires_at_ms, 200 + DEFAULT_LEASE_TTL_MS);

        let early_heartbeat = runtime_job_heartbeat_for_project(
            Some(&project),
            true,
            lease_request("job-1", "lease-1"),
            250,
        )
        .expect("early heartbeat is idempotent");
        assert_eq!(early_heartbeat.lease.heartbeat_at_ms, 200);
        assert_eq!(
            early_heartbeat.lease.expires_at_ms,
            200 + DEFAULT_LEASE_TTL_MS
        );

        let heartbeat = runtime_job_heartbeat_for_project(
            Some(&project),
            true,
            lease_request("job-1", "lease-1"),
            200 + DEFAULT_HEARTBEAT_MIN_INTERVAL_MS,
        )
        .expect("heartbeat job after min interval");
        assert_eq!(
            heartbeat.lease.heartbeat_at_ms,
            200 + DEFAULT_HEARTBEAT_MIN_INTERVAL_MS
        );
        assert_eq!(
            heartbeat.lease.expires_at_ms,
            200 + DEFAULT_HEARTBEAT_MIN_INTERVAL_MS + DEFAULT_LEASE_TTL_MS
        );

        let completed = runtime_job_complete_for_project(
            Some(&project),
            true,
            lease_request("job-1", "lease-1"),
            200 + DEFAULT_HEARTBEAT_MIN_INTERVAL_MS + 100,
        )
        .expect("complete job");
        assert_eq!(completed.state, "completed");

        let list = runtime_job_list_for_project(Some(&project), true).expect("list jobs");
        assert_eq!(list.jobs.len(), 1);
        assert_eq!(list.leases[0].status, RELEASED_LEASE_STATUS);
        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn scoped_claim_only_claims_requested_job_kind() {
        let project = temp_project("job-claim-by-kind");
        fs::create_dir_all(&project).expect("create temp project");

        runtime_job_create_for_project(
            Some(&project),
            true,
            create_request_with_kind("job-other-high", "compile-page", 100),
            100,
        )
        .expect("create high-priority other job");
        runtime_job_create_for_project(
            Some(&project),
            true,
            create_request_with_kind("job-prepare-low", "bulk-knowledge-prepare", 10),
            110,
        )
        .expect("create lower-priority prepare job");
        runtime_job_create_for_project(
            Some(&project),
            true,
            create_request_with_kind("job-prepare-high", "bulk-knowledge-prepare", 20),
            120,
        )
        .expect("create higher-priority prepare job");

        let scoped = runtime_job_claim_by_kind_for_project(
            Some(&project),
            true,
            claim_by_kind_request("worker-a", "lease-scoped", "bulk-knowledge-prepare"),
            200,
        )
        .expect("claim prepare job");
        assert_eq!(scoped.job.job_id, "job-prepare-high");
        assert_eq!(scoped.job.kind, "bulk-knowledge-prepare");

        let unscoped = runtime_job_claim_for_project(
            Some(&project),
            true,
            claim_request("worker-b", "lease-unscoped"),
            220,
        )
        .expect("unscoped claim still sees global priority");
        assert_eq!(unscoped.job.job_id, "job-other-high");
        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn scoped_claim_rejects_missing_or_invalid_kind_without_changing_unscoped_claim() {
        let project = temp_project("job-claim-by-kind-missing");
        fs::create_dir_all(&project).expect("create temp project");
        runtime_job_create_for_project(
            Some(&project),
            true,
            create_request_with_kind("job-other", "compile-page", 100),
            100,
        )
        .expect("create non-prepare job");

        let missing = runtime_job_claim_by_kind_for_project(
            Some(&project),
            true,
            claim_by_kind_request("worker-a", "lease-missing", "bulk-knowledge-prepare"),
            200,
        )
        .expect_err("missing kind has no queued job");
        assert!(missing.starts_with("no-queued-job"));

        let invalid = runtime_job_claim_by_kind_for_project(
            Some(&project),
            true,
            claim_by_kind_request("worker-a", "lease-invalid", "  "),
            200,
        )
        .expect_err("empty kind is rejected");
        assert!(invalid.starts_with("invalid-kind"));

        let unscoped = runtime_job_claim_for_project(
            Some(&project),
            true,
            claim_request("worker-b", "lease-unscoped"),
            220,
        )
        .expect("unscoped claim remains available");
        assert_eq!(unscoped.job.job_id, "job-other");

        let unknown = serde_json::from_value::<RuntimeJobClaimByKindRequest>(serde_json::json!({
            "holder": "worker-a",
            "leaseId": "lease-unknown",
            "kind": "bulk-knowledge-prepare",
            "unknownField": true
        }))
        .expect_err("scoped claim rejects unknown fields");
        assert!(unknown.to_string().contains("unknown field"));
        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn scoped_claim_rejects_inconsistent_active_lease_on_matching_job() {
        let project = temp_project("job-claim-by-kind-active-lease");
        fs::create_dir_all(&project).expect("create temp project");
        runtime_job_create_for_project(
            Some(&project),
            true,
            create_request_with_kind("job-prepare-active", "bulk-knowledge-prepare", 100),
            100,
        )
        .expect("create prepare job");
        runtime_job_create_for_project(
            Some(&project),
            true,
            create_request_with_kind("job-prepare-next", "bulk-knowledge-prepare", 10),
            110,
        )
        .expect("create next prepare job");
        with_runtime_writer(|| {
            let connection = open_job_runtime_locked(&project)?;
            connection
                .execute(
                    "INSERT INTO runtime_job_leases (
                        lease_id,
                        job_id,
                        holder,
                        acquired_at_ms,
                        heartbeat_at_ms,
                        expires_at_ms,
                        status
                    ) VALUES ('lease-active', 'job-prepare-active', 'worker-old', 150, 150, 1000, 'active')",
                    [],
                )
                .expect("insert inconsistent active lease");
            Ok(())
        })
        .expect("seed active lease succeeds");

        let error = runtime_job_claim_by_kind_for_project(
            Some(&project),
            true,
            claim_by_kind_request("worker-new", "lease-new", "bulk-knowledge-prepare"),
            200,
        )
        .expect_err("matching active lease is rejected");
        assert!(error.starts_with("active-lease-exists"));
        let list = runtime_job_list_for_project(Some(&project), true).expect("list jobs");
        assert!(list.jobs.iter().all(|job| job.state == "queued"));
        assert_eq!(list.leases.len(), 1);
        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn heartbeat_near_expiry_bypasses_min_interval_noop() {
        let project = temp_project("job-heartbeat-near-expiry");
        fs::create_dir_all(&project).expect("create temp project");
        with_runtime_writer(|| {
            let connection = open_job_runtime_locked(&project)?;
            connection
                .execute(
                    "INSERT INTO runtime_jobs (
                        job_id,
                        kind,
                        payload,
                        state,
                        attempt,
                        max_attempts,
                        priority,
                        created_at_ms,
                        updated_at_ms,
                        queued_at_ms,
                        started_at_ms
                    ) VALUES ('job-1', 'compile-page', '{}', 'running', 1, 3, 0, 100, 100, 100, 100)",
                    [],
                )
                .expect("insert running job");
            connection
                .execute(
                    "INSERT INTO runtime_job_leases (
                        lease_id,
                        job_id,
                        holder,
                        acquired_at_ms,
                        heartbeat_at_ms,
                        expires_at_ms,
                        status
                    ) VALUES ('lease-1', 'job-1', 'worker-a', 100, 1000, 5999, 'active')",
                    [],
                )
                .expect("insert near-expiry active lease");
            Ok(())
        })
        .expect("seed near-expiry lease succeeds");

        let heartbeat = runtime_job_heartbeat_for_project(
            Some(&project),
            true,
            lease_request("job-1", "lease-1"),
            5000,
        )
        .expect("near-expiry heartbeat renews");

        assert_eq!(heartbeat.lease.heartbeat_at_ms, 5000);
        assert_eq!(heartbeat.lease.expires_at_ms, 5000 + DEFAULT_LEASE_TTL_MS);
        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn concurrent_claims_cannot_claim_same_job() {
        let project = temp_project("job-concurrent-claim");
        fs::create_dir_all(&project).expect("create temp project");
        runtime_job_create_for_project(Some(&project), true, create_request("job-1"), 100)
            .expect("create job");

        let first_project = project.clone();
        let first = std::thread::spawn(move || {
            runtime_job_claim_for_project(
                Some(&first_project),
                true,
                claim_request("worker-a", "lease-a"),
                200,
            )
        });
        let second_project = project.clone();
        let second = std::thread::spawn(move || {
            runtime_job_claim_for_project(
                Some(&second_project),
                true,
                claim_request("worker-b", "lease-b"),
                200,
            )
        });

        let results = vec![
            first.join().expect("first thread"),
            second.join().expect("second thread"),
        ];
        assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
        assert_eq!(results.iter().filter(|result| result.is_err()).count(), 1);

        let list = runtime_job_list_for_project(Some(&project), true).expect("list jobs");
        assert_eq!(
            list.leases
                .iter()
                .filter(|lease| lease.status == ACTIVE_LEASE_STATUS)
                .count(),
            1
        );
        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn fail_retry_and_retry_wait_eligibility_are_bounded() {
        let project = temp_project("job-retry");
        fs::create_dir_all(&project).expect("create temp project");
        runtime_job_create_for_project(Some(&project), true, create_request("job-1"), 100)
            .expect("create job");
        runtime_job_claim_for_project(
            Some(&project),
            true,
            claim_request("worker-a", "lease-1"),
            200,
        )
        .expect("claim job");

        let retry_wait = runtime_job_fail_for_project(
            Some(&project),
            true,
            RuntimeJobFailRequest {
                job_id: "job-1".to_string(),
                lease_id: "lease-1".to_string(),
                error: Some("provider-error".to_string()),
                retry_after_ms: Some(500),
            },
            300,
        )
        .expect("fail to retry wait");
        assert_eq!(retry_wait.state, "retry-wait");

        let early_retry = runtime_job_retry_for_project(
            Some(&project),
            true,
            RuntimeJobRetryRequest {
                job_id: "job-1".to_string(),
            },
            400,
        )
        .expect_err("retry before retry_after is rejected");
        assert!(early_retry.starts_with("retry-not-ready"));

        let retried = runtime_job_retry_for_project(
            Some(&project),
            true,
            RuntimeJobRetryRequest {
                job_id: "job-1".to_string(),
            },
            500,
        )
        .expect("retry after eligibility");
        assert_eq!(retried.state, "queued");
        assert_eq!(retried.attempt, 1);

        let claimed_again = runtime_job_claim_for_project(
            Some(&project),
            true,
            claim_request("worker-b", "lease-2"),
            600,
        )
        .expect("claim retried job");
        assert_eq!(claimed_again.job.state, "running");
        assert_eq!(claimed_again.job.attempt, 2);
        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn retry_wait_without_retry_after_is_not_eligible() {
        let project = temp_project("job-retry-wait-null");
        fs::create_dir_all(&project).expect("create temp project");

        with_runtime_writer(|| {
            let connection = open_job_runtime_locked(&project)?;
            connection
                .execute(
                    "INSERT INTO runtime_jobs (
                        job_id,
                        kind,
                        payload,
                        state,
                        attempt,
                        max_attempts,
                        priority,
                        created_at_ms,
                        updated_at_ms,
                        queued_at_ms,
                        retry_after_ms
                    ) VALUES ('job-1', 'compile-page', '{}', 'retry-wait', 1, 3, 0, 100, 100, 100, NULL)",
                    [],
                )
                .expect("insert retry-wait job");
            Ok(())
        })
        .expect("seed retry-wait job succeeds");

        let error = runtime_job_retry_for_project(
            Some(&project),
            true,
            RuntimeJobRetryRequest {
                job_id: "job-1".to_string(),
            },
            500,
        )
        .expect_err("retry-wait without retry_after is rejected");

        assert!(error.starts_with("retry-not-ready"));
        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn cancel_is_allowed_from_queued_and_retry_wait() {
        let project = temp_project("job-cancel-non-terminal");
        fs::create_dir_all(&project).expect("create temp project");
        runtime_job_create_for_project(Some(&project), true, create_request("job-queued"), 100)
            .expect("create queued job");
        let queued_cancel = runtime_job_cancel_for_project(
            Some(&project),
            true,
            RuntimeJobCancelRequest {
                job_id: "job-queued".to_string(),
            },
            150,
        )
        .expect("cancel queued job");
        assert_eq!(queued_cancel.state, "cancelled");

        runtime_job_create_for_project(Some(&project), true, create_request("job-retry"), 200)
            .expect("create retry job");
        runtime_job_claim_for_project(
            Some(&project),
            true,
            claim_request("worker-a", "lease-retry"),
            250,
        )
        .expect("claim retry job");
        let retry_wait = runtime_job_fail_for_project(
            Some(&project),
            true,
            RuntimeJobFailRequest {
                job_id: "job-retry".to_string(),
                lease_id: "lease-retry".to_string(),
                error: Some("provider-error".to_string()),
                retry_after_ms: Some(500),
            },
            300,
        )
        .expect("fail to retry wait");
        assert_eq!(retry_wait.state, "retry-wait");
        let retry_cancel = runtime_job_cancel_for_project(
            Some(&project),
            true,
            RuntimeJobCancelRequest {
                job_id: "job-retry".to_string(),
            },
            350,
        )
        .expect("cancel retry-wait job");
        assert_eq!(retry_cancel.state, "cancelled");

        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn invalid_inputs_and_wrong_lease_are_rejected() {
        let project = temp_project("job-invalid-inputs");
        fs::create_dir_all(&project).expect("create temp project");

        let empty_kind = runtime_job_create_for_project(
            Some(&project),
            true,
            RuntimeJobCreateRequest {
                job_id: Some("job-empty-kind".to_string()),
                kind: "  ".to_string(),
                payload: "{}".to_string(),
                max_attempts: None,
                priority: None,
            },
            100,
        )
        .expect_err("empty kind is rejected");
        assert!(empty_kind.starts_with("invalid-kind"));

        let empty_payload = runtime_job_create_for_project(
            Some(&project),
            true,
            RuntimeJobCreateRequest {
                job_id: Some("job-empty-payload".to_string()),
                kind: "compile-page".to_string(),
                payload: "  ".to_string(),
                max_attempts: None,
                priority: None,
            },
            100,
        )
        .expect_err("empty payload is rejected");
        assert!(empty_payload.starts_with("invalid-payload"));

        runtime_job_create_for_project(Some(&project), true, create_request("job-1"), 100)
            .expect("create job");
        let empty_holder = runtime_job_claim_for_project(
            Some(&project),
            true,
            RuntimeJobClaimRequest {
                holder: "  ".to_string(),
                lease_id: Some("lease-empty-holder".to_string()),
            },
            200,
        )
        .expect_err("empty holder is rejected");
        assert!(empty_holder.starts_with("invalid-holder"));

        let claim = runtime_job_claim_for_project(
            Some(&project),
            true,
            claim_request("worker-a", "lease-1"),
            200,
        )
        .expect("claim job");
        assert_eq!(claim.job.state, "running");

        let wrong_lease = runtime_job_complete_for_project(
            Some(&project),
            true,
            lease_request("job-1", "lease-wrong"),
            250,
        )
        .expect_err("wrong lease is rejected");
        assert!(wrong_lease.starts_with("lease-not-found"));

        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn paused_job_only_allows_cancel_in_pr3() {
        let project = temp_project("job-paused-boundary");
        fs::create_dir_all(&project).expect("create temp project");

        with_runtime_writer(|| {
            let connection = open_job_runtime_locked(&project)?;
            connection
                .execute(
                    "INSERT INTO runtime_jobs (
                        job_id,
                        kind,
                        payload,
                        state,
                        attempt,
                        max_attempts,
                        priority,
                        created_at_ms,
                        updated_at_ms,
                        queued_at_ms
                    ) VALUES ('job-paused', 'compile-page', '{}', 'paused', 1, 3, 0, 100, 100, 100)",
                    [],
                )
                .expect("insert paused job");
            connection
                .execute(
                    "INSERT INTO runtime_job_leases (
                        lease_id,
                        job_id,
                        holder,
                        acquired_at_ms,
                        heartbeat_at_ms,
                        expires_at_ms,
                        status
                    ) VALUES ('lease-paused', 'job-paused', 'worker-a', 200, 200, 300, 'active')",
                    [],
                )
                .expect("insert paused active lease");
            Ok(())
        })
        .expect("seed paused job succeeds");

        let retry_error = runtime_job_retry_for_project(
            Some(&project),
            true,
            RuntimeJobRetryRequest {
                job_id: "job-paused".to_string(),
            },
            250,
        )
        .expect_err("paused retry is rejected");
        assert!(retry_error.contains("invalid-transition"));

        let heartbeat_error = runtime_job_heartbeat_for_project(
            Some(&project),
            true,
            lease_request("job-paused", "lease-paused"),
            250,
        )
        .expect_err("paused heartbeat is rejected");
        assert!(heartbeat_error.contains("invalid-transition"));

        let complete_error = runtime_job_complete_for_project(
            Some(&project),
            true,
            lease_request("job-paused", "lease-paused"),
            250,
        )
        .expect_err("paused complete is rejected");
        assert!(complete_error.contains("invalid-transition"));

        let fail_error = runtime_job_fail_for_project(
            Some(&project),
            true,
            RuntimeJobFailRequest {
                job_id: "job-paused".to_string(),
                lease_id: "lease-paused".to_string(),
                error: None,
                retry_after_ms: None,
            },
            250,
        )
        .expect_err("paused fail is rejected");
        assert!(fail_error.contains("invalid-transition"));

        let claim_error = runtime_job_claim_for_project(
            Some(&project),
            true,
            claim_request("worker-b", "lease-other"),
            250,
        )
        .expect_err("paused claim is rejected");
        assert!(claim_error.starts_with("no-queued-job"));

        let cancelled = runtime_job_cancel_for_project(
            Some(&project),
            true,
            RuntimeJobCancelRequest {
                job_id: "job-paused".to_string(),
            },
            300,
        )
        .expect("paused cancel succeeds");
        assert_eq!(cancelled.state, "cancelled");
        let list = runtime_job_list_for_project(Some(&project), true).expect("list jobs");
        assert_eq!(list.leases[0].status, CANCELLED_LEASE_STATUS);

        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn queued_job_can_pause_and_resume() {
        let project = temp_project("job-pause-resume-queued");
        fs::create_dir_all(&project).expect("create temp project");
        runtime_job_create_for_project(Some(&project), true, create_request("job-1"), 100)
            .expect("create job");

        let paused =
            runtime_job_pause_for_project(Some(&project), true, pause_request("job-1"), 150)
                .expect("pause queued job");
        assert_eq!(paused.state, "paused");
        assert_eq!(paused.updated_at_ms, 150);

        let claim_error = runtime_job_claim_for_project(
            Some(&project),
            true,
            claim_request("worker-a", "lease-paused"),
            175,
        )
        .expect_err("paused job is not claimable");
        assert!(claim_error.starts_with("no-queued-job"));

        let resumed =
            runtime_job_resume_for_project(Some(&project), true, resume_request("job-1"), 200)
                .expect("resume paused job");
        assert_eq!(resumed.state, "queued");
        assert_eq!(resumed.queued_at_ms, Some(200));

        let list = runtime_job_list_for_project(Some(&project), true).expect("list jobs");
        assert_eq!(list.jobs[0].state, "queued");
        assert!(list.leases.is_empty());
        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn running_pause_invalidates_old_lease_results() {
        let project = temp_project("job-pause-running");
        fs::create_dir_all(&project).expect("create temp project");
        runtime_job_create_for_project(Some(&project), true, create_request("job-1"), 100)
            .expect("create job");
        runtime_job_claim_for_project(
            Some(&project),
            true,
            claim_request("worker-a", "lease-1"),
            200,
        )
        .expect("claim job");

        let paused =
            runtime_job_pause_for_project(Some(&project), true, pause_request("job-1"), 300)
                .expect("pause running job");
        assert_eq!(paused.state, "paused");

        for result in [
            runtime_job_heartbeat_for_project(
                Some(&project),
                true,
                lease_request("job-1", "lease-1"),
                400,
            )
            .map(|_| ()),
            runtime_job_complete_for_project(
                Some(&project),
                true,
                lease_request("job-1", "lease-1"),
                400,
            )
            .map(|_| ()),
            runtime_job_fail_for_project(
                Some(&project),
                true,
                RuntimeJobFailRequest {
                    job_id: "job-1".to_string(),
                    lease_id: "lease-1".to_string(),
                    error: None,
                    retry_after_ms: None,
                },
                400,
            )
            .map(|_| ()),
        ] {
            let error = result.expect_err("old lease result should be ignored");
            assert!(error.contains("invalid-transition") || error.contains("inactive-lease"));
        }

        let list = runtime_job_list_for_project(Some(&project), true).expect("list jobs");
        assert_eq!(list.jobs[0].state, "paused");
        assert_eq!(list.leases[0].status, CANCELLED_LEASE_STATUS);
        assert_eq!(list.leases[0].released_at_ms, Some(300));
        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn pause_and_resume_reject_invalid_states() {
        let project = temp_project("job-pause-resume-invalid");
        fs::create_dir_all(&project).expect("create temp project");

        runtime_job_create_for_project(Some(&project), true, create_request("job-completed"), 100)
            .expect("create completed job");
        runtime_job_claim_for_project(
            Some(&project),
            true,
            claim_request("worker-a", "lease-completed"),
            120,
        )
        .expect("claim completed job");
        runtime_job_complete_for_project(
            Some(&project),
            true,
            lease_request("job-completed", "lease-completed"),
            140,
        )
        .expect("complete job");

        runtime_job_create_for_project(Some(&project), true, create_request("job-cancelled"), 200)
            .expect("create cancelled job");
        runtime_job_cancel_for_project(
            Some(&project),
            true,
            RuntimeJobCancelRequest {
                job_id: "job-cancelled".to_string(),
            },
            220,
        )
        .expect("cancel job");

        runtime_job_create_for_project(
            Some(&project),
            true,
            create_request_with_max_attempts("job-failed", 1),
            300,
        )
        .expect("create failed job");
        runtime_job_claim_for_project(
            Some(&project),
            true,
            claim_request("worker-a", "lease-failed"),
            320,
        )
        .expect("claim failed job");
        runtime_job_fail_for_project(
            Some(&project),
            true,
            RuntimeJobFailRequest {
                job_id: "job-failed".to_string(),
                lease_id: "lease-failed".to_string(),
                error: None,
                retry_after_ms: None,
            },
            340,
        )
        .expect("fail job");

        runtime_job_create_for_project(Some(&project), true, create_request("job-retry-wait"), 400)
            .expect("create retry wait job");
        runtime_job_claim_for_project(
            Some(&project),
            true,
            claim_request("worker-a", "lease-retry-wait"),
            420,
        )
        .expect("claim retry wait job");
        runtime_job_fail_for_project(
            Some(&project),
            true,
            RuntimeJobFailRequest {
                job_id: "job-retry-wait".to_string(),
                lease_id: "lease-retry-wait".to_string(),
                error: None,
                retry_after_ms: Some(900),
            },
            440,
        )
        .expect("move to retry wait");

        for job_id in [
            "job-completed",
            "job-cancelled",
            "job-failed",
            "job-retry-wait",
        ] {
            let pause_error =
                runtime_job_pause_for_project(Some(&project), true, pause_request(job_id), 500)
                    .expect_err("pause rejects invalid state");
            let resume_error =
                runtime_job_resume_for_project(Some(&project), true, resume_request(job_id), 500)
                    .expect_err("resume rejects non-paused state");
            assert!(pause_error.starts_with("invalid-transition"));
            assert!(resume_error.starts_with("invalid-transition"));
        }

        runtime_job_create_for_project(Some(&project), true, create_request("job-queued"), 600)
            .expect("create queued job");
        let resume_queued =
            runtime_job_resume_for_project(Some(&project), true, resume_request("job-queued"), 650)
                .expect_err("resume rejects queued job");
        assert!(resume_queued.starts_with("invalid-transition"));

        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn fail_moves_to_failed_when_retry_max_is_exhausted() {
        let project = temp_project("job-fail-exhausted");
        fs::create_dir_all(&project).expect("create temp project");
        runtime_job_create_for_project(
            Some(&project),
            true,
            create_request_with_max_attempts("job-1", 1),
            100,
        )
        .expect("create job");
        runtime_job_claim_for_project(
            Some(&project),
            true,
            claim_request("worker-a", "lease-1"),
            200,
        )
        .expect("claim job");

        let failed = runtime_job_fail_for_project(
            Some(&project),
            true,
            RuntimeJobFailRequest {
                job_id: "job-1".to_string(),
                lease_id: "lease-1".to_string(),
                error: Some("still bad".to_string()),
                retry_after_ms: Some(500),
            },
            300,
        )
        .expect("fail exhausted job");

        assert_eq!(failed.state, "failed");
        assert_eq!(failed.retry_after_ms, None);
        let retry_error = runtime_job_retry_for_project(
            Some(&project),
            true,
            RuntimeJobRetryRequest {
                job_id: "job-1".to_string(),
            },
            500,
        )
        .expect_err("retry max exhausted");
        assert!(retry_error.starts_with("retry-limit-exhausted"));
        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn cancel_running_invalidates_old_lease_results() {
        let project = temp_project("job-cancel-running");
        fs::create_dir_all(&project).expect("create temp project");
        runtime_job_create_for_project(Some(&project), true, create_request("job-1"), 100)
            .expect("create job");
        runtime_job_claim_for_project(
            Some(&project),
            true,
            claim_request("worker-a", "lease-1"),
            200,
        )
        .expect("claim job");

        let cancelled = runtime_job_cancel_for_project(
            Some(&project),
            true,
            RuntimeJobCancelRequest {
                job_id: "job-1".to_string(),
            },
            300,
        )
        .expect("cancel job");
        assert_eq!(cancelled.state, "cancelled");

        for result in [
            runtime_job_heartbeat_for_project(
                Some(&project),
                true,
                lease_request("job-1", "lease-1"),
                400,
            )
            .map(|_| ()),
            runtime_job_complete_for_project(
                Some(&project),
                true,
                lease_request("job-1", "lease-1"),
                400,
            )
            .map(|_| ()),
            runtime_job_fail_for_project(
                Some(&project),
                true,
                RuntimeJobFailRequest {
                    job_id: "job-1".to_string(),
                    lease_id: "lease-1".to_string(),
                    error: None,
                    retry_after_ms: None,
                },
                400,
            )
            .map(|_| ()),
        ] {
            let error = result.expect_err("old lease result should be ignored");
            assert!(error.contains("invalid-transition") || error.contains("inactive-lease"));
        }

        let list = runtime_job_list_for_project(Some(&project), true).expect("list jobs");
        assert_eq!(list.jobs[0].state, "cancelled");
        assert_eq!(list.leases[0].status, CANCELLED_LEASE_STATUS);
        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn lease_timeout_moves_running_job_to_retry_wait_or_failed() {
        let project = temp_project("job-lease-timeout");
        fs::create_dir_all(&project).expect("create temp project");
        runtime_job_create_for_project(Some(&project), true, create_request("job-1"), 100)
            .expect("create job");
        runtime_job_claim_for_project(
            Some(&project),
            true,
            claim_request("worker-a", "lease-1"),
            200,
        )
        .expect("claim job");

        let early_timeout =
            runtime_job_lease_timeout_for_project(Some(&project), true, "job-1", "lease-1", 300)
                .expect_err("lease timeout before expiry is rejected");
        assert!(early_timeout.starts_with("lease-not-expired"));

        let expired_at = 200 + DEFAULT_LEASE_TTL_MS;
        for result in [
            runtime_job_heartbeat_for_project(
                Some(&project),
                true,
                lease_request("job-1", "lease-1"),
                expired_at,
            )
            .map(|_| ()),
            runtime_job_complete_for_project(
                Some(&project),
                true,
                lease_request("job-1", "lease-1"),
                expired_at,
            )
            .map(|_| ()),
            runtime_job_fail_for_project(
                Some(&project),
                true,
                RuntimeJobFailRequest {
                    job_id: "job-1".to_string(),
                    lease_id: "lease-1".to_string(),
                    error: None,
                    retry_after_ms: None,
                },
                expired_at,
            )
            .map(|_| ()),
        ] {
            let error = result.expect_err("expired lease operation should be rejected");
            assert!(error.starts_with("lease-expired"));
        }

        let timeout = runtime_job_lease_timeout_for_project(
            Some(&project),
            true,
            "job-1",
            "lease-1",
            expired_at,
        )
        .expect("lease timeout");
        assert_eq!(timeout.state, "retry-wait");
        let list = runtime_job_list_for_project(Some(&project), true).expect("list jobs");
        assert_eq!(list.leases[0].status, EXPIRED_LEASE_STATUS);
        let _ = fs::remove_dir_all(project);
    }
}
