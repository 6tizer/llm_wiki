use std::sync::{Mutex, OnceLock};
use serde::{Deserialize, Serialize};

mod schema;
mod validate;
mod txhelpers;
mod jobs;
mod scheduler;
mod commit_budget;
mod events_progress;
mod staging;
mod markers;
mod profiles;
mod profile_pool;
mod probe;
mod redact;
#[cfg(test)]
mod test_support;

pub use schema::*;
pub(crate) use validate::*;
pub(crate) use txhelpers::*;
pub use jobs::*;
pub use scheduler::*;
pub use commit_budget::*;
pub use events_progress::*;
pub use staging::*;
pub use markers::*;
pub use profiles::*;
pub use profile_pool::*;
pub use probe::*;
pub(crate) use redact::*;
#[cfg(test)]
pub(crate) use test_support::*;


pub(crate) const RUNTIME_DIR: &str = ".llm-wiki/runtime";
pub(crate) const RUNTIME_DB_FILE: &str = "runtime.db";
pub(crate) const STAGING_DIR: &str = "staging";
pub(crate) const MIGRATIONS_FAMILY: &str = "migrations";
pub(crate) const MIGRATIONS_VERSION: i64 = 1;
pub(crate) const JOBS_FAMILY: &str = "jobs";
pub(crate) const JOBS_VERSION: i64 = 1;
pub(crate) const LEASES_FAMILY: &str = "leases";
pub(crate) const LEASES_VERSION: i64 = 1;
pub(crate) const RESOURCE_BUDGETS_FAMILY: &str = "resource-budgets";
pub(crate) const RESOURCE_BUDGETS_VERSION: i64 = 1;
pub(crate) const EVENTS_PROGRESS_FAMILY: &str = "events-progress";
pub(crate) const EVENTS_PROGRESS_VERSION: i64 = 1;
pub(crate) const STAGING_ARTIFACTS_FAMILY: &str = "staging-artifacts";
pub(crate) const STAGING_ARTIFACTS_VERSION: i64 = 2;
pub(crate) const DERIVED_STALE_MARKERS_FAMILY: &str = "derived-stale-markers";
pub(crate) const DERIVED_STALE_MARKERS_VERSION: i64 = 1;
// Job `kind` for the derived-rebuild consumption plumbing (SPEC-6 PR1). One
// `derived-rebuild` job = one folded (layer, affectedPath) batch of
// `runtime_derived_stale_markers` rows, created atomically by
// `runtime_derived_marker_claim_batch`. Reuses the existing `runtime_jobs` +
// lease-reclaim machinery instead of a bespoke marker-side lease (design
// decision 1/3 in docs/plans/SPEC-6/pr1-marker-consumption-infrastructure-plan.md).
// Keep aligned with `DERIVED_REBUILD_JOB_KIND` in
// src/core-runtime/derived-rebuild/index.ts.
pub(crate) const DERIVED_REBUILD_JOB_KIND: &str = "derived-rebuild";
pub(crate) const PROFILE_STATUS_FAMILY: &str = "profile-status";
pub(crate) const PROFILE_STATUS_VERSION: i64 = 1;
pub(crate) const PROFILE_POOL_FAMILY: &str = "profile-pool";
pub(crate) const PROFILE_POOL_VERSION: i64 = 1;
pub(crate) const WORK_RUNTIME_ENABLED_ENV: &str = "LLM_WIKI_CORE_WORK_RUNTIME_ENABLED";
pub(crate) const DEFAULT_MAX_ATTEMPTS: i64 = 3;
pub(crate) const DEFAULT_PRIORITY: i64 = 0;
pub(crate) const DEFAULT_LEASE_TTL_MS: i64 = 120_000;
pub(crate) const DEFAULT_RETRY_BACKOFF_MS: i64 = 30_000;
pub(crate) const DEFAULT_HEARTBEAT_MIN_INTERVAL_MS: i64 = 5_000;
// How often the core-runtime background scheduler (see
// `start_lease_reclaim_scheduler`) scans for `running` jobs whose active
// lease has expired. Comfortably below DEFAULT_LEASE_TTL_MS so a crashed
// worker's job is reclaimed promptly, but well above
// DEFAULT_HEARTBEAT_MIN_INTERVAL_MS so it never races a live heartbeat.
pub(crate) const LEASE_RECLAIM_TICK_INTERVAL_MS: u64 = 15_000;
pub(crate) const DEFAULT_PROGRESS_MIN_INTERVAL_MS: i64 = 2_000;
pub(crate) const MAX_EVENT_PAYLOAD_BYTES: usize = 16_384;
pub(crate) const DEFAULT_TIMELINE_LIMIT: i64 = 100;
pub(crate) const MAX_TIMELINE_LIMIT: i64 = 500;
pub(crate) const DEFAULT_PROGRESS_LIMIT: i64 = 100;
pub(crate) const MAX_PROGRESS_LIMIT: i64 = 500;
pub(crate) const DEFAULT_STAGING_ARTIFACT_LIMIT: i64 = 100;
pub(crate) const MAX_STAGING_ARTIFACT_LIMIT: i64 = 500;
pub(crate) const DEFAULT_DERIVED_MARKER_LIMIT: i64 = 100;
pub(crate) const MAX_DERIVED_MARKER_LIMIT: i64 = 500;
pub(crate) const DEFAULT_COMMIT_TOTAL_CAPACITY: i64 = 2;
pub(crate) const COMMIT_BUDGET_AMOUNT: i64 = 1;
pub(crate) const MIN_COMMIT_BUDGET_TTL_MS: i64 = 1_000;
pub(crate) const MAX_COMMIT_BUDGET_TTL_MS: i64 = 1_200_000;
pub(crate) const DEFAULT_FAILED_ARTIFACT_TTL_MS: i64 = 604_800_000;
pub(crate) const MAX_FAILED_ARTIFACT_TTL_MS: i64 = 2_592_000_000;
pub(crate) const MAX_STAGING_ARTIFACT_PATH_BYTES: usize = 1024;
pub(crate) const MAX_STAGING_ARTIFACT_HASH_BYTES: usize = 128;
pub(crate) const MAX_STAGING_ARTIFACT_ERROR_BYTES: usize = 4096;
pub(crate) const MAX_STAGING_ARTIFACT_BODY_BYTES: usize = 2_000_000;
pub(crate) const MAX_STAGING_ARTIFACT_SOURCE_KIND_BYTES: usize = 128;
pub(crate) const MAX_DERIVED_MARKER_BASE_VERSION_BYTES: usize = 256;
pub(crate) const MAX_PROFILE_ID_BYTES: usize = 128;
pub(crate) const MAX_PROFILE_DISPLAY_NAME_BYTES: usize = 256;
pub(crate) const MAX_PROFILE_PROVIDER_BYTES: usize = 128;
pub(crate) const MAX_PROFILE_MODEL_BYTES: usize = 256;
pub(crate) const MAX_PROFILE_SDK_MODEL_BYTES: usize = 256;
pub(crate) const MAX_PROFILE_ENDPOINT_BYTES: usize = 2048;
pub(crate) const MAX_PROFILE_TASK_FAMILIES_BYTES: usize = 4096;
pub(crate) const MAX_PROFILE_TASK_FAMILY_BYTES: usize = 128;
pub(crate) const MAX_PROFILE_CAPABILITY_JSON_BYTES: usize = 8192;
pub(crate) const MAX_PROFILE_CAPABILITY_VERSION_BYTES: usize = 64;
pub(crate) const MAX_PROFILE_CAPABILITY_ERROR_BYTES: usize = 4096;
pub(crate) const MAX_PROFILE_POOL_REASON_BYTES: usize = 1024;
// Keep these version strings aligned with src/components/settings/sections/model-profiles-section.tsx.
pub(crate) const DEFAULT_PROFILE_CAPABILITY_VERSION: &str = "spec-4-pr1";
pub(crate) const PROFILE_PROBE_CAPABILITY_VERSION: &str = "profile-probe.v1";
pub(crate) const DEFAULT_PROFILE_CAPABILITY_JSON: &str = "{}";
pub(crate) const DEFAULT_PROFILE_STATUS: &str = "unknown";
pub(crate) const PROFILE_PROBE_BACKOFF_MS: i64 = DEFAULT_RETRY_BACKOFF_MS;
pub(crate) const PROFILE_PROBE_MAX_TOKENS: i64 = 8;
pub(crate) const PROFILE_PROBE_TIMEOUT_SECS: u64 = 30;
// Keep aligned with PREPARE_PROFILE_TASK_FAMILY in
// src/lib/parallel-knowledge/prepare-worker-pool.ts.
pub(crate) const PREPARE_PROFILE_TASK_FAMILY: &str = "ingest";
pub(crate) const MODEL_CALL_FORWARD_TIMEOUT_SECS: u64 = 300;
pub(crate) const DEFAULT_MODEL_CALL_RATE_LIMIT_RETRY_MS: i64 = 30_000;
pub(crate) const MIN_MODEL_CALL_RATE_LIMIT_RETRY_MS: i64 = 1_000;
pub(crate) const MAX_MODEL_CALL_RATE_LIMIT_RETRY_MS: i64 = MAX_PROFILE_POOL_BREAKER_MS;
pub(crate) const MAX_PROFILE_CONCURRENCY: i64 = 128;
pub(crate) const MIN_PROFILE_POOL_TTL_MS: i64 = 1_000;
// Keep this aligned with AGENT_PROFILE_CLAIM_TTL_MS in src/lib/agent/agent-transport.ts.
pub(crate) const MAX_PROFILE_POOL_TTL_MS: i64 = 1_200_000;
pub(crate) const MAX_PROFILE_POOL_BREAKER_MS: i64 = 3_600_000;
pub(crate) const ACTIVE_LEASE_STATUS: &str = "active";
pub(crate) const RELEASED_LEASE_STATUS: &str = "released";
pub(crate) const EXPIRED_LEASE_STATUS: &str = "expired";
pub(crate) const CANCELLED_LEASE_STATUS: &str = "cancelled";
pub(crate) const COMMIT_TOTAL_SCOPE: &str = "commit-total";
pub(crate) const COMMIT_PATH_SCOPE: &str = "commit-path";
pub(crate) const COMMIT_TOTAL_RESOURCE_KEY: &str = "*";
pub(crate) const ACTIVE_CLAIM_STATUS: &str = "active";
pub(crate) const RELEASED_CLAIM_STATUS: &str = "released";
pub(crate) const EXPIRED_CLAIM_STATUS: &str = "expired";
pub(crate) const EVENT_APPENDED_NAME: &str = "job-runtime:event-appended";
pub(crate) const PROGRESS_APPENDED_NAME: &str = "job-runtime:progress-appended";
pub(crate) const PROFILE_POOL_CLAIMED_NAME: &str = "profile-pool:claimed";
pub(crate) const PROFILE_POOL_RELEASED_NAME: &str = "profile-pool:released";
pub(crate) const PROFILE_CLAIM_INACTIVE_PREFIX: &str = "claim-inactive:";
pub(crate) const PROFILE_CLAIM_INACTIVE_ERROR: &str = "claim-inactive: profile pool claim is not active";
// Rust uses this after agent_spawn has accepted claim ownership.
pub(crate) const AGENT_PROFILE_RELEASE_REASON: &str = "agent-run-cleanup";
pub(crate) const AGENT_PROFILE_SDK_MODEL_REJECTED_REASON: &str = "agent-sdk-model-rejected";
pub(crate) const AGENT_PROFILE_GATEWAY_AUTH_FAILED_REASON: &str = "gateway-auth-failed";
pub(crate) const PENDING_ARTIFACT_STATUS: &str = "pending";
pub(crate) const COMMITTED_ARTIFACT_STATUS: &str = "committed";
pub(crate) const FAILED_ARTIFACT_STATUS: &str = "failed";
pub(crate) const CANCELLED_ARTIFACT_STATUS: &str = "cancelled";
pub(crate) const DELETED_ARTIFACT_STATUS: &str = "deleted";
pub(crate) const PENDING_MARKER_STATUS: &str = "pending";
pub(crate) const CLAIMED_MARKER_STATUS: &str = "claimed";
pub(crate) const DONE_MARKER_STATUS: &str = "done";
pub(crate) const FAILED_MARKER_STATUS: &str = "failed";
pub(crate) const CANCELLED_MARKER_STATUS: &str = "cancelled";

pub(crate) static RUNTIME_DB_WRITE_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

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
    pub(crate) family: String,
    pub(crate) version: i64,
    pub(crate) applied_at_ms: i64,
}

/// Runtime DB health payload returned to Tauri callers.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeDbHealth {
    pub(crate) enabled: bool,
    pub(crate) status: RuntimeDbHealthState,
    pub(crate) project_path: Option<String>,
    pub(crate) runtime_dir: Option<String>,
    pub(crate) db_path: Option<String>,
    pub(crate) journal_mode: Option<String>,
    pub(crate) migrations: Vec<RuntimeDbMigrationStatus>,
}

/// Request payload for creating a queued runtime job.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeJobCreateRequest {
    pub(crate) job_id: Option<String>,
    pub(crate) kind: String,
    pub(crate) payload: String,
    pub(crate) max_attempts: Option<i64>,
    pub(crate) priority: Option<i64>,
}

/// Request payload for claiming the next queued runtime job.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeJobClaimRequest {
    pub(crate) holder: String,
    pub(crate) lease_id: Option<String>,
}

/// Request payload for claiming the next queued runtime job of one kind.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeJobClaimByKindRequest {
    pub(crate) holder: String,
    pub(crate) lease_id: Option<String>,
    pub(crate) kind: String,
}

/// Request payload for active-lease job operations.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeJobLeaseRequest {
    pub(crate) job_id: String,
    pub(crate) lease_id: String,
}

/// Request payload for failing a running runtime job.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeJobFailRequest {
    pub(crate) job_id: String,
    pub(crate) lease_id: String,
    pub(crate) error: Option<String>,
    pub(crate) retry_after_ms: Option<i64>,
}

/// Request payload for retrying a failed or retry-ready runtime job.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeJobRetryRequest {
    pub(crate) job_id: String,
}

/// Request payload for cancelling a non-terminal runtime job.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeJobCancelRequest {
    pub(crate) job_id: String,
}

/// Request payload for pausing a queued or running runtime job.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeJobPauseRequest {
    pub(crate) job_id: String,
}

/// Request payload for resuming a paused runtime job.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeJobResumeRequest {
    pub(crate) job_id: String,
}

/// Snapshot of one runtime job row.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeJobRecord {
    pub(crate) job_id: String,
    pub(crate) kind: String,
    pub(crate) payload: String,
    pub(crate) state: String,
    pub(crate) attempt: i64,
    pub(crate) max_attempts: i64,
    pub(crate) priority: i64,
    pub(crate) created_at_ms: i64,
    pub(crate) updated_at_ms: i64,
    pub(crate) queued_at_ms: Option<i64>,
    pub(crate) started_at_ms: Option<i64>,
    pub(crate) completed_at_ms: Option<i64>,
    pub(crate) failed_at_ms: Option<i64>,
    pub(crate) cancelled_at_ms: Option<i64>,
    pub(crate) retry_after_ms: Option<i64>,
    pub(crate) last_error: Option<String>,
}

/// Snapshot of one runtime job lease row.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeJobLeaseRecord {
    pub(crate) lease_id: String,
    pub(crate) job_id: String,
    pub(crate) holder: String,
    pub(crate) acquired_at_ms: i64,
    pub(crate) heartbeat_at_ms: i64,
    pub(crate) expires_at_ms: i64,
    pub(crate) released_at_ms: Option<i64>,
    pub(crate) status: String,
}

/// Response payload for a successful job claim.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeJobClaim {
    pub(crate) job: RuntimeJobRecord,
    pub(crate) lease: RuntimeJobLeaseRecord,
}

/// Snapshot response for runtime jobs and leases.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeJobList {
    pub(crate) enabled: bool,
    pub(crate) status: RuntimeDbHealthState,
    pub(crate) jobs: Vec<RuntimeJobRecord>,
    pub(crate) leases: Vec<RuntimeJobLeaseRecord>,
}

/// Request payload for claiming commit-path budget capacity.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeCommitBudgetClaimRequest {
    pub(crate) affected_path: String,
    pub(crate) holder: String,
    pub(crate) job_id: Option<String>,
    pub(crate) claim_id: Option<String>,
    pub(crate) ttl_ms: Option<i64>,
}

/// Request payload for releasing commit-path budget capacity.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeCommitBudgetReleaseRequest {
    pub(crate) claim_id: String,
}

/// Snapshot of one resource budget row.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeResourceBudgetRecord {
    pub(crate) scope: String,
    pub(crate) resource_key: String,
    pub(crate) display_key: String,
    pub(crate) capacity: i64,
    pub(crate) created_at_ms: i64,
    pub(crate) updated_at_ms: i64,
}

/// Snapshot of one resource budget claim row.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeResourceBudgetClaimRecord {
    pub(crate) claim_id: String,
    pub(crate) scope: String,
    pub(crate) resource_key: String,
    pub(crate) display_key: String,
    pub(crate) job_id: Option<String>,
    pub(crate) holder: String,
    pub(crate) amount: i64,
    pub(crate) acquired_at_ms: i64,
    pub(crate) expires_at_ms: i64,
    pub(crate) released_at_ms: Option<i64>,
    pub(crate) status: String,
}

/// Response payload for a successful commit budget claim.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeCommitBudgetClaim {
    pub(crate) claim_id: String,
    pub(crate) resource_key: String,
    pub(crate) display_key: String,
    pub(crate) expires_at_ms: i64,
    pub(crate) claims: Vec<RuntimeResourceBudgetClaimRecord>,
}

/// Snapshot response for commit budget rows and active claims.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeCommitBudgetList {
    pub(crate) enabled: bool,
    pub(crate) status: RuntimeDbHealthState,
    pub(crate) budgets: Vec<RuntimeResourceBudgetRecord>,
    pub(crate) claims: Vec<RuntimeResourceBudgetClaimRecord>,
}

/// Request payload for appending a durable runtime event.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeEventAppendRequest {
    pub(crate) job_id: Option<String>,
    pub(crate) event_id: Option<String>,
    pub(crate) payload: String,
}

/// Request payload for appending or coalescing a runtime progress fact.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeProgressAppendRequest {
    pub(crate) job_id: Option<String>,
    pub(crate) progress_key: String,
    pub(crate) event_id: Option<String>,
    pub(crate) payload: String,
    pub(crate) durable: Option<bool>,
}

/// Request payload for listing runtime events.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeTimelineListRequest {
    pub(crate) job_id: Option<String>,
    pub(crate) limit: Option<i64>,
}

/// Request payload for listing runtime progress facts.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeProgressListRequest {
    pub(crate) job_id: Option<String>,
    pub(crate) limit: Option<i64>,
}

/// Snapshot of one append-only runtime event row.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeEventRecord {
    pub(crate) event_id: String,
    pub(crate) job_id: String,
    pub(crate) event_name: String,
    pub(crate) payload: String,
    pub(crate) created_at_ms: i64,
}

/// Snapshot of one coalesced runtime progress fact.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeProgressRecord {
    pub(crate) job_id: String,
    pub(crate) progress_key: String,
    pub(crate) payload: String,
    pub(crate) updated_at_ms: i64,
    pub(crate) last_event_id: Option<String>,
}

/// Response payload for a progress append.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeProgressAppend {
    pub(crate) progress: RuntimeProgressRecord,
    pub(crate) event: Option<RuntimeEventRecord>,
}

/// Snapshot response for the runtime event timeline.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeTimelineList {
    pub(crate) enabled: bool,
    pub(crate) status: RuntimeDbHealthState,
    pub(crate) events: Vec<RuntimeEventRecord>,
}

/// Snapshot response for current runtime progress facts.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeProgressList {
    pub(crate) enabled: bool,
    pub(crate) status: RuntimeDbHealthState,
    pub(crate) progress: Vec<RuntimeProgressRecord>,
}

/// Request payload for recording or advancing staging artifact metadata.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeStagingArtifactRecordRequest {
    pub(crate) artifact_id: Option<String>,
    pub(crate) job_id: String,
    pub(crate) artifact_path: String,
    pub(crate) artifact_hash: String,
    pub(crate) status: Option<String>,
    pub(crate) ttl_ms: Option<i64>,
    pub(crate) last_error: Option<String>,
}

/// Request payload for writing a validated staging artifact body and metadata.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeStagingArtifactStoreRequest {
    pub(crate) artifact_id: String,
    pub(crate) job_id: String,
    pub(crate) artifact_path: String,
    pub(crate) target_path: String,
    pub(crate) operation_intent: String,
    pub(crate) base_hash: Option<String>,
    pub(crate) source_kind: String,
    pub(crate) markdown: String,
}

/// Request payload for reading one pending staging artifact body.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeStagingArtifactReadBodyRequest {
    pub(crate) artifact_id: String,
}

/// Response payload for one pending staging artifact body.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeStagingArtifactReadBody {
    pub(crate) artifact_id: String,
    pub(crate) artifact_path: String,
    pub(crate) markdown: String,
}

/// Request payload for marking a committed artifact and cleaning its staging file.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeStagingArtifactCommitSuccessRequest {
    pub(crate) artifact_id: String,
}

/// Request payload for clearing pending staging artifacts for one job.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeStagingArtifactsClearPendingForJobRequest {
    pub(crate) job_id: String,
}

/// Request payload for listing staging artifact metadata.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeStagingArtifactListRequest {
    pub(crate) job_id: Option<String>,
    pub(crate) status: Option<String>,
    pub(crate) limit: Option<i64>,
}

/// Snapshot of one runtime staging artifact metadata row.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeStagingArtifactRecord {
    pub(crate) artifact_id: String,
    pub(crate) job_id: String,
    pub(crate) artifact_path: String,
    pub(crate) artifact_hash: String,
    pub(crate) target_path: Option<String>,
    pub(crate) operation_intent: Option<String>,
    pub(crate) base_hash: Option<String>,
    pub(crate) source_kind: Option<String>,
    pub(crate) status: String,
    pub(crate) created_at_ms: i64,
    pub(crate) updated_at_ms: i64,
    pub(crate) expires_at_ms: Option<i64>,
    pub(crate) deleted_at_ms: Option<i64>,
    pub(crate) last_error: Option<String>,
}

/// Snapshot response for staging artifact metadata.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeStagingArtifactList {
    pub(crate) enabled: bool,
    pub(crate) status: RuntimeDbHealthState,
    pub(crate) artifacts: Vec<RuntimeStagingArtifactRecord>,
}

/// Response payload for clearing pending staging artifacts for one job.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeStagingArtifactsClearPendingForJob {
    pub(crate) cleared: Vec<RuntimeStagingArtifactRecord>,
}

/// Response payload for a staging artifact GC pass.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeStagingArtifactGc {
    pub(crate) deleted: Vec<RuntimeStagingArtifactRecord>,
}

/// Request payload for recording one derived stale marker.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeDerivedStaleMarkerRecordRequest {
    pub(crate) marker_id: Option<String>,
    pub(crate) layer: String,
    pub(crate) affected_path: String,
    pub(crate) input_hash: Option<String>,
    pub(crate) base_version: String,
    pub(crate) reason: String,
    pub(crate) source_event_id: String,
}

/// Request payload for listing derived stale marker snapshots. `since_*`
/// implement a composite cursor matching the table's
/// `ORDER BY marked_at_ms ASC, marker_id ASC` (SPEC-6 PR1 decision 6): pass
/// both fields verbatim from a prior response's `nextCursor`, or omit both
/// for the original full-snapshot behavior (backward compatible).
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeDerivedStaleMarkerListRequest {
    pub(crate) layer: Option<String>,
    pub(crate) affected_path: Option<String>,
    pub(crate) status: Option<String>,
    pub(crate) limit: Option<i64>,
    pub(crate) since_marked_at_ms: Option<i64>,
    pub(crate) since_marker_id: Option<String>,
}

/// Snapshot of one derived stale marker row.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeDerivedStaleMarkerRecord {
    pub(crate) marker_id: String,
    pub(crate) layer: String,
    pub(crate) affected_path: String,
    pub(crate) input_hash: Option<String>,
    pub(crate) base_version: String,
    pub(crate) marked_at_ms: i64,
    pub(crate) reason: String,
    pub(crate) source_event_id: String,
    pub(crate) status: String,
    pub(crate) updated_at_ms: i64,
    pub(crate) last_error: Option<String>,
}

/// Opaque pagination cursor for `runtime_derived_stale_marker_list`, matching
/// the table's `ORDER BY marked_at_ms ASC, marker_id ASC` (SPEC-6 PR1
/// decision 6). Round-trip both fields verbatim as `sinceMarkedAtMs` /
/// `sinceMarkerId` on the next call to keep paging without gaps or repeats.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeDerivedMarkerCursor {
    pub(crate) marked_at_ms: i64,
    pub(crate) marker_id: String,
}

/// Snapshot response for derived stale marker rows. `next_cursor` is
/// populated only when the page came back full (`markers.len() == limit`),
/// signaling there may be more rows past it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeDerivedStaleMarkerList {
    pub(crate) enabled: bool,
    pub(crate) status: RuntimeDbHealthState,
    pub(crate) markers: Vec<RuntimeDerivedStaleMarkerRecord>,
    pub(crate) next_cursor: Option<RuntimeDerivedMarkerCursor>,
}

/// Request payload for atomically folding every pending derived stale marker
/// in one `(layer, affectedPath)` group into a single claimed batch backed by
/// one `derived-rebuild` runtime job (SPEC-6 PR1 decision 3). The created job
/// starts `queued`; actually claiming/leasing it for execution is a separate,
/// later call to the existing `runtime_job_claim_by_kind` — two sequential
/// top-level calls, never nested inside this command's writer transaction
/// (`RUNTIME_DB_WRITE_LOCK` is not reentrant).
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeDerivedMarkerClaimBatchRequest {
    pub(crate) layer: String,
    pub(crate) affected_path: String,
    pub(crate) job_id: Option<String>,
    pub(crate) max_attempts: Option<i64>,
    pub(crate) priority: Option<i64>,
}

/// Request payload for completing a derived-rebuild job's claimed marker
/// batch (`claimed` -> `done`). Requires the still-active lease acquired via
/// `runtime_job_claim_by_kind` for `job_id`: holder/lease verification is the
/// zombie-completion defense (adversarial matrix L5 / P3). `marker_ids` must
/// match the job payload's `markerIds` set exactly, so a stray id belonging
/// to a different job/holder can never be swept up by this call.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeDerivedMarkerCompleteBatchRequest {
    pub(crate) job_id: String,
    pub(crate) lease_id: String,
    pub(crate) marker_ids: Vec<String>,
}

/// Request payload for releasing a derived-rebuild job's claimed marker batch
/// back to `pending`/`failed`/`cancelled` after the JOB itself already
/// transitioned via `runtime_job_fail`/`runtime_job_cancel` (two sequential
/// top-level calls). The automatic lease-timeout self-heal path does its own
/// inline reconciliation instead — see
/// `runtime_job_lease_timeout_for_project` — so this command is for the
/// explicit fail/cancel path, not the crash-recovery path.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeDerivedMarkerReleaseBatchRequest {
    pub(crate) job_id: String,
    pub(crate) marker_ids: Vec<String>,
    pub(crate) target_status: String,
    pub(crate) error: Option<String>,
}

/// Response payload shared by every derived marker batch transition —
/// claim/complete/release all return the same shape: the `derived-rebuild`
/// job (`queued` after claim, `completed` after complete, unchanged after
/// release) and the specific marker rows the call touched, ordered
/// `marked_at_ms ASC, marker_id ASC`. For a claim-batch response, the last
/// marker is the real row whose `baseVersion`/`inputHash`/`reason` were
/// copied verbatim into the job payload.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeDerivedMarkerBatchTransition {
    pub(crate) job: RuntimeJobRecord,
    pub(crate) markers: Vec<RuntimeDerivedStaleMarkerRecord>,
}

/// Request payload for creating a stored model profile.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeProfileCreateRequest {
    pub(crate) profile_id: Option<String>,
    pub(crate) kind: String,
    pub(crate) display_name: String,
    pub(crate) provider_id: String,
    pub(crate) model_id: String,
    pub(crate) agent_sdk_model_id: Option<String>,
    pub(crate) endpoint: Option<String>,
    pub(crate) api_mode: String,
    pub(crate) auth_style: String,
    pub(crate) secret_ref: Option<String>,
    pub(crate) enabled: Option<bool>,
    pub(crate) task_families: Vec<String>,
    pub(crate) max_concurrency: Option<i64>,
}

/// Request payload for updating non-secret model profile metadata.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeProfileUpdateRequest {
    pub(crate) profile_id: String,
    pub(crate) display_name: Option<String>,
    pub(crate) provider_id: Option<String>,
    pub(crate) model_id: Option<String>,
    pub(crate) agent_sdk_model_id: Option<String>,
    pub(crate) clear_agent_sdk_model_id: Option<bool>,
    pub(crate) endpoint: Option<String>,
    pub(crate) clear_endpoint: Option<bool>,
    pub(crate) api_mode: Option<String>,
    pub(crate) auth_style: Option<String>,
    pub(crate) secret_ref: Option<String>,
    pub(crate) clear_secret_ref: Option<bool>,
    pub(crate) enabled: Option<bool>,
    pub(crate) task_families: Option<Vec<String>>,
    pub(crate) max_concurrency: Option<i64>,
    pub(crate) capability_status: Option<String>,
    pub(crate) capability_json: Option<String>,
    pub(crate) capability_version: Option<String>,
    pub(crate) capability_checked_at_ms: Option<i64>,
    pub(crate) probe_backoff_until_ms: Option<i64>,
    pub(crate) last_capability_error: Option<String>,
    pub(crate) clear_last_capability_error: Option<bool>,
}

/// Request payload for reading one stored model profile.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeProfileStatusRequest {
    pub(crate) profile_id: String,
}

/// Request payload for soft-deleting one stored model profile.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeProfileDeleteRequest {
    pub(crate) profile_id: String,
}

/// Response payload for a soft-deleted model profile. It never contains a secret value.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeProfileDeleteResult {
    pub(crate) profile_id: String,
    pub(crate) deleted_at_ms: i64,
    pub(crate) secret_ref: Option<String>,
}

/// Snapshot of one stored model profile. It never contains a secret value.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeProfileRecord {
    pub(crate) profile_id: String,
    pub(crate) kind: String,
    pub(crate) display_name: String,
    pub(crate) provider_id: String,
    pub(crate) model_id: String,
    pub(crate) agent_sdk_model_id: Option<String>,
    pub(crate) endpoint: Option<String>,
    pub(crate) api_mode: String,
    pub(crate) auth_style: String,
    pub(crate) secret_ref: Option<String>,
    pub(crate) enabled: bool,
    pub(crate) task_families: Vec<String>,
    pub(crate) max_concurrency: i64,
    pub(crate) capability_status: String,
    pub(crate) capability_json: String,
    pub(crate) capability_version: String,
    pub(crate) capability_checked_at_ms: Option<i64>,
    pub(crate) probe_backoff_until_ms: Option<i64>,
    pub(crate) last_capability_error: Option<String>,
    pub(crate) created_at_ms: i64,
    pub(crate) updated_at_ms: i64,
}

/// Snapshot response for stored model profiles.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeProfileList {
    pub(crate) enabled: bool,
    pub(crate) status: RuntimeDbHealthState,
    pub(crate) profiles: Vec<RuntimeProfileRecord>,
}

/// Unsaved profile metadata used for one-request capability probes.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeProfileProbeDraftRequest {
    pub(crate) kind: String,
    pub(crate) provider_id: String,
    pub(crate) model_id: String,
    pub(crate) agent_sdk_model_id: Option<String>,
    pub(crate) endpoint: Option<String>,
    pub(crate) api_mode: String,
    pub(crate) auth_style: String,
}

/// Request payload for checking stored or draft model profile capabilities.
#[derive(Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeProfileProbeRequest {
    pub(crate) profile_id: Option<String>,
    pub(crate) draft: Option<RuntimeProfileProbeDraftRequest>,
    pub(crate) raw_secret: Option<String>,
    pub(crate) force: Option<bool>,
}

/// Non-secret profile capability probe result returned to Tauri callers.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeProfileProbeResult {
    pub(crate) profile: Option<RuntimeProfileRecord>,
    pub(crate) status: String,
    pub(crate) capability_json: String,
    pub(crate) capability_version: String,
    pub(crate) checked_at_ms: i64,
    pub(crate) backoff_until_ms: Option<i64>,
    pub(crate) message: String,
}

/// Request payload for claiming one eligible profile-pool slot.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeProfilePoolClaimRequest {
    pub(crate) claim_id: Option<String>,
    pub(crate) kind: String,
    pub(crate) task_family: String,
    pub(crate) holder: String,
    pub(crate) job_id: Option<String>,
    pub(crate) ttl_ms: Option<i64>,
    pub(crate) preferred_profile_ids: Option<Vec<String>>,
}

/// Request payload for releasing one active profile-pool claim.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeProfilePoolReleaseRequest {
    pub(crate) claim_id: String,
    pub(crate) outcome: String,
    pub(crate) retry_after_ms: Option<i64>,
    pub(crate) circuit_open_ms: Option<i64>,
    pub(crate) reason: Option<String>,
    pub(crate) error: Option<String>,
}

/// Request payload for renewing one active profile-pool claim.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeProfilePoolRenewRequest {
    pub(crate) claim_id: String,
    pub(crate) ttl_ms: Option<i64>,
}

/// Request payload for listing profile-pool observability rows.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeProfilePoolListRequest {
    pub(crate) kind: Option<String>,
    pub(crate) task_family: Option<String>,
    pub(crate) job_id: Option<String>,
}

/// Snapshot of one profile-pool claim. It never contains secret values.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeProfileClaimRecord {
    pub(crate) claim_id: String,
    pub(crate) profile_id: String,
    pub(crate) kind: String,
    pub(crate) task_family: String,
    pub(crate) job_id: Option<String>,
    pub(crate) holder: String,
    pub(crate) acquired_at_ms: i64,
    pub(crate) expires_at_ms: i64,
    pub(crate) released_at_ms: Option<i64>,
    pub(crate) status: String,
}

/// Snapshot of one profile circuit breaker. It never contains secret values.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeProfileCircuitBreakerRecord {
    pub(crate) profile_id: String,
    pub(crate) status: String,
    pub(crate) reason: Option<String>,
    pub(crate) error: Option<String>,
    pub(crate) opened_at_ms: i64,
    pub(crate) open_until_ms: i64,
    pub(crate) updated_at_ms: i64,
}

/// Response payload for a successful profile-pool claim.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeProfilePoolClaim {
    pub(crate) claim_id: String,
    pub(crate) profile_id: String,
    pub(crate) expires_at_ms: i64,
    pub(crate) claim: RuntimeProfileClaimRecord,
}

/// Response payload for a profile-pool release.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeProfilePoolRelease {
    pub(crate) claim: RuntimeProfileClaimRecord,
    pub(crate) circuit_breaker: Option<RuntimeProfileCircuitBreakerRecord>,
}

/// Response payload for a renewed profile-pool claim.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeProfilePoolRenew {
    pub(crate) claim_id: String,
    pub(crate) profile_id: String,
    pub(crate) expires_at_ms: i64,
    pub(crate) claim: RuntimeProfileClaimRecord,
}

/// Snapshot response for active profile claims and open circuit breakers.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeProfilePoolList {
    pub(crate) enabled: bool,
    pub(crate) status: RuntimeDbHealthState,
    pub(crate) active_claims: Vec<RuntimeProfileClaimRecord>,
    pub(crate) circuit_breakers: Vec<RuntimeProfileCircuitBreakerRecord>,
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
pub(crate) struct RuntimeProfileProbeTarget {
    pub(crate) profile_id: Option<String>,
    pub(crate) kind: String,
    pub(crate) provider_id: String,
    pub(crate) model_id: String,
    pub(crate) agent_sdk_model_id: Option<String>,
    pub(crate) endpoint: Option<String>,
    pub(crate) api_mode: String,
    pub(crate) auth_style: String,
    pub(crate) secret_value: String,
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
pub(crate) struct RuntimeProfileProbeOutcome {
    pub(crate) status: String,
    pub(crate) capability_json: String,
    pub(crate) message: String,
    pub(crate) backoff_until_ms: Option<i64>,
    pub(crate) last_capability_error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct NormalizedAffectedPath {
    pub(crate) display_key: String,
    pub(crate) resource_key: String,
}
