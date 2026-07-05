use serde::{Deserialize, Serialize};
use std::sync::{Mutex, OnceLock};

mod commit_budget;
mod events_progress;
mod jobs;
mod markers;
mod probe;
mod profile_pool;
mod profiles;
mod redact;
mod scheduler;
mod schema;
mod staging;
#[cfg(test)]
mod test_support;
mod txhelpers;
mod validate;

pub use commit_budget::*;
pub use events_progress::*;
pub use jobs::*;
pub use markers::*;
pub use probe::*;
pub use profile_pool::*;
pub use profiles::*;
pub(crate) use redact::*;
pub use scheduler::*;
pub use schema::*;
pub use staging::*;
#[cfg(test)]
pub(crate) use test_support::*;
pub(crate) use txhelpers::*;
pub(crate) use validate::*;

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
// Job `kind` for the derived-rebuild consumption plumbing (SPEC-6 PR1). One
// `derived-rebuild` job = one folded (layer, affectedPath) batch of
// `runtime_derived_stale_markers` rows, created atomically by
// `runtime_derived_marker_claim_batch`. Reuses the existing `runtime_jobs` +
// lease-reclaim machinery instead of a bespoke marker-side lease (design
// decision 1/3 in docs/plans/SPEC-6/pr1-marker-consumption-infrastructure-plan.md).
// Keep aligned with `DERIVED_REBUILD_JOB_KIND` in
// src/core-runtime/derived-rebuild/index.ts.
pub(crate) const DERIVED_REBUILD_JOB_KIND: &str = "derived-rebuild";
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
// How often the core-runtime background scheduler (see
// `start_lease_reclaim_scheduler`) scans for `running` jobs whose active
// lease has expired. Comfortably below DEFAULT_LEASE_TTL_MS so a crashed
// worker's job is reclaimed promptly, but well above
// DEFAULT_HEARTBEAT_MIN_INTERVAL_MS so it never races a live heartbeat.
const LEASE_RECLAIM_TICK_INTERVAL_MS: u64 = 15_000;
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
const PROFILE_MODELS_LIST_TIMEOUT_SECS: u64 = 10;
// Keep aligned with PREPARE_PROFILE_TASK_FAMILY in
// src/lib/parallel-knowledge/prepare-worker-pool.ts.
const PREPARE_PROFILE_TASK_FAMILY: &str = "ingest";
const MODEL_CALL_FORWARD_TIMEOUT_SECS: u64 = 300;
const DEFAULT_MODEL_CALL_RATE_LIMIT_RETRY_MS: i64 = 30_000;
const MIN_MODEL_CALL_RATE_LIMIT_RETRY_MS: i64 = 1_000;
const MAX_MODEL_CALL_RATE_LIMIT_RETRY_MS: i64 = MAX_PROFILE_POOL_BREAKER_MS;
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
const CLAIMED_MARKER_STATUS: &str = "claimed";
const DONE_MARKER_STATUS: &str = "done";
const FAILED_MARKER_STATUS: &str = "failed";
const CANCELLED_MARKER_STATUS: &str = "cancelled";

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

/// Request payload for claiming the next queued runtime job. `job_id` is an
/// optional exact-match filter (SPEC-6 PR3+4 P0-2a): when present, claims
/// ONLY that specific job (still subject to the normal `state = 'queued'`
/// race-safe conditional UPDATE), instead of the default "next queued job of
/// any kind" behavior used by callers with no filter.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeJobClaimRequest {
    holder: String,
    lease_id: Option<String>,
    job_id: Option<String>,
}

/// Request payload for claiming the next queued runtime job of one kind.
/// `payload_layer` is an optional additional filter (SPEC-6 PR3+4 P0-2b):
/// when present, only a job whose JSON `payload.layer` field equals this
/// value is eligible — this is what lets two same-kind (`"derived-rebuild"`)
/// consumers each only ever claim their OWN layer's jobs, instead of racing
/// to claim (and burn an attempt off) a sibling consumer's job. `None`
/// preserves the exact prior behavior (no payload filtering) for backward
/// compatibility with any other `"kind"` that doesn't carry a `layer` field.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeJobClaimByKindRequest {
    holder: String,
    lease_id: Option<String>,
    kind: String,
    payload_layer: Option<String>,
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

/// Request payload for reading one pending staging artifact body.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeStagingArtifactReadBodyRequest {
    artifact_id: String,
}

/// Response payload for one pending staging artifact body.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeStagingArtifactReadBody {
    artifact_id: String,
    artifact_path: String,
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

/// Request payload for listing derived stale marker snapshots. `since_*`
/// implement a composite cursor matching the table's
/// `ORDER BY marked_at_ms ASC, marker_id ASC` (SPEC-6 PR1 decision 6): pass
/// both fields verbatim from a prior response's `nextCursor`, or omit both
/// for the original full-snapshot behavior (backward compatible).
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeDerivedStaleMarkerListRequest {
    layer: Option<String>,
    affected_path: Option<String>,
    status: Option<String>,
    limit: Option<i64>,
    since_marked_at_ms: Option<i64>,
    since_marker_id: Option<String>,
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

/// Opaque pagination cursor for `runtime_derived_stale_marker_list`, matching
/// the table's `ORDER BY marked_at_ms ASC, marker_id ASC` (SPEC-6 PR1
/// decision 6). Round-trip both fields verbatim as `sinceMarkedAtMs` /
/// `sinceMarkerId` on the next call to keep paging without gaps or repeats.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeDerivedMarkerCursor {
    marked_at_ms: i64,
    marker_id: String,
}

/// Snapshot response for derived stale marker rows. `next_cursor` is
/// populated only when the page came back full (`markers.len() == limit`),
/// signaling there may be more rows past it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeDerivedStaleMarkerList {
    enabled: bool,
    status: RuntimeDbHealthState,
    markers: Vec<RuntimeDerivedStaleMarkerRecord>,
    next_cursor: Option<RuntimeDerivedMarkerCursor>,
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
    layer: String,
    affected_path: String,
    job_id: Option<String>,
    max_attempts: Option<i64>,
    priority: Option<i64>,
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
    job_id: String,
    lease_id: String,
    marker_ids: Vec<String>,
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
    job_id: String,
    marker_ids: Vec<String>,
    target_status: String,
    error: Option<String>,
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
    job: RuntimeJobRecord,
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

/// Unsaved profile connection metadata used for listing provider models.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeProfileModelsListDraftRequest {
    endpoint: Option<String>,
    api_mode: String,
    auth_style: String,
}

/// Request payload for listing provider models from a stored or draft profile target.
#[derive(Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeProfileModelsListRequest {
    profile_id: Option<String>,
    draft: Option<RuntimeProfileModelsListDraftRequest>,
    raw_secret: Option<String>,
    models_url: Option<String>,
}

/// Non-secret provider models list response.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeProfileModelsListResult {
    models: Vec<String>,
    source_url: String,
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

impl std::fmt::Debug for RuntimeProfileModelsListRequest {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("RuntimeProfileModelsListRequest")
            .field("profile_id", &self.profile_id)
            .field("draft", &self.draft)
            .field(
                "raw_secret",
                &self.raw_secret.as_ref().map(|_| "[REDACTED]"),
            )
            .field("models_url", &self.models_url)
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
