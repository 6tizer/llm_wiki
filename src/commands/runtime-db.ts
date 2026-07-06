import { invoke } from "@tauri-apps/api/core"
import type { MarkdownCommitOperationIntent } from "@/core-runtime/contract"
import type { MarkdownCommitBudgetClaimRequest } from "@/core-runtime/markdown-commit"

export type RuntimeDbHealthState = "disabled" | "no-project" | "healthy"
export type RuntimeJobState =
  | "queued"
  | "running"
  | "paused"
  | "retry-wait"
  | "failed"
  | "completed"
  | "cancelled"

export interface RuntimeJobRecord {
  jobId: string
  kind: string
  payload: string
  state: RuntimeJobState
  attempt: number
  maxAttempts: number
  priority: number
  createdAtMs: number
  updatedAtMs: number
  queuedAtMs?: number | null
  startedAtMs?: number | null
  completedAtMs?: number | null
  failedAtMs?: number | null
  cancelledAtMs?: number | null
  retryAfterMs?: number | null
  lastError?: string | null
}

export interface RuntimeJobCreateRequest {
  jobId?: string | null
  kind: string
  payload: string
  maxAttempts?: number | null
  priority?: number | null
}

export interface RuntimeJobClaimRequest {
  holder: string
  leaseId?: string | null
  /**
   * Exact-match filter (SPEC-6 PR3+4 P0-2a): when present, claims ONLY this
   * specific job id instead of the default "next queued job of any kind".
   * Errors with the same `no-queued-job:` prefix as the no-filter case when
   * the job isn't currently `queued` (already claimed, doesn't exist, or in
   * a terminal state) — it never silently falls back to claiming a
   * different job.
   */
  jobId?: string | null
}

export interface RuntimeJobClaimByKindRequest extends RuntimeJobClaimRequest {
  kind: string
  /**
   * Additional filter (SPEC-6 PR3+4 P0-2b): when present, only a queued job
   * of `kind` whose JSON `payload.layer` field also equals this value is
   * eligible. This is what lets two same-`kind` (`"derived-rebuild"`)
   * consumers each only ever claim their OWN layer's jobs — omitting it
   * preserves the exact prior "claim across all layers by priority"
   * behavior.
   */
  payloadLayer?: string | null
}

export interface RuntimeJobLeaseRecord {
  leaseId: string
  jobId: string
  holder: string
  acquiredAtMs: number
  heartbeatAtMs: number
  expiresAtMs: number
  releasedAtMs?: number | null
  status: string
}

export interface RuntimeJobList {
  enabled: boolean
  status: RuntimeDbHealthState
  jobs: RuntimeJobRecord[]
  leases: RuntimeJobLeaseRecord[]
}

export interface RuntimeJobClaim {
  job: RuntimeJobRecord
  lease: RuntimeJobLeaseRecord
}

export interface RuntimeJobLeaseRequest {
  jobId: string
  leaseId: string
}

export interface RuntimeJobFailRequest extends RuntimeJobLeaseRequest {
  error?: string | null
  retryAfterMs?: number | null
}

export type RuntimeCommitBudgetClaimRequest = MarkdownCommitBudgetClaimRequest

export interface RuntimeResourceBudgetClaimRecord {
  claimId: string
  scope: string
  resourceKey: string
  displayKey: string
  jobId?: string | null
  holder: string
  amount: number
  acquiredAtMs: number
  expiresAtMs: number
  releasedAtMs?: number | null
  status: string
}

export interface RuntimeCommitBudgetClaim {
  claimId: string
  resourceKey: string
  displayKey: string
  expiresAtMs: number
  claims: RuntimeResourceBudgetClaimRecord[]
}

export interface RuntimeStagingArtifactRecord {
  artifactId: string
  jobId: string
  artifactPath: string
  artifactHash: string
  targetPath?: string | null
  operationIntent?: MarkdownCommitOperationIntent | null
  baseHash?: string | null
  sourceKind?: string | null
  status: string
  createdAtMs: number
  updatedAtMs: number
  expiresAtMs?: number | null
  deletedAtMs?: number | null
  lastError?: string | null
}

export interface RuntimeStagingArtifactRecordRequest {
  artifactId?: string | null
  jobId: string
  artifactPath: string
  artifactHash: string
  status?: string | null
  ttlMs?: number | null
  lastError?: string | null
}

export interface RuntimeStagingArtifactListRequest {
  jobId?: string | null
  status?: string | null
  limit?: number | null
}

export interface RuntimeStagingArtifactList {
  enabled: boolean
  status: RuntimeDbHealthState
  artifacts: RuntimeStagingArtifactRecord[]
}

export interface RuntimeStagingArtifactStoreRequest {
  artifactId: string
  jobId: string
  artifactPath: string
  targetPath: string
  operationIntent: MarkdownCommitOperationIntent
  baseHash?: string | null
  sourceKind: string
  markdown: string
}

export interface RuntimeStagingArtifactReadBodyRequest {
  artifactId: string
}

export interface RuntimeStagingArtifactReadBody {
  artifactId: string
  artifactPath: string
  markdown: string
}

export interface RuntimeStagingArtifactsClearPendingForJobRequest {
  jobId: string
}

export interface RuntimeStagingArtifactsClearPendingForJob {
  cleared: RuntimeStagingArtifactRecord[]
}

export interface RuntimeEventAppendRequest {
  jobId?: string | null
  eventId?: string | null
  payload: string
}

export interface RuntimeEventRecord {
  eventId: string
  jobId: string
  eventName: string
  payload: string
  createdAtMs: number
}

export interface RuntimeTimelineListRequest {
  jobId?: string | null
  limit?: number | null
}

export interface RuntimeTimelineList {
  enabled: boolean
  status: RuntimeDbHealthState
  events: RuntimeEventRecord[]
}

export interface RuntimeProgressListRequest {
  jobId?: string | null
  limit?: number | null
}

export interface RuntimeProgressRecord {
  jobId: string
  progressKey: string
  payload: string
  updatedAtMs: number
  lastEventId?: string | null
}

export interface RuntimeProgressList {
  enabled: boolean
  status: RuntimeDbHealthState
  progress: RuntimeProgressRecord[]
}

export interface RuntimeProgressAppendRequest {
  jobId?: string | null
  progressKey: string
  eventId?: string | null
  payload: string
  durable?: boolean | null
}

export interface RuntimeProgressAppend {
  progress: RuntimeProgressRecord
  event?: RuntimeEventRecord | null
}

export interface RuntimeDerivedStaleMarkerRecordRequest {
  markerId?: string | null
  layer: string
  affectedPath: string
  inputHash?: string | null
  baseVersion: string
  reason: string
  sourceEventId: string
}

export interface RuntimeDerivedStaleMarkerListRequest {
  layer?: string | null
  affectedPath?: string | null
  status?: string | null
  limit?: number | null
  /** Composite cursor (SPEC-6 PR1 decision 6): must be provided together with `sinceMarkerId`, or omitted. */
  sinceMarkedAtMs?: number | null
  sinceMarkerId?: string | null
}

export interface RuntimeDerivedStaleMarkerRecord {
  markerId: string
  layer: string
  affectedPath: string
  inputHash?: string | null
  baseVersion: string
  markedAtMs: number
  reason: string
  sourceEventId: string
  status: string
  updatedAtMs: number
  lastError?: string | null
}

/** Round-trip verbatim as `sinceMarkedAtMs`/`sinceMarkerId` on the next `runtimeDerivedStaleMarkerList` call. */
export interface RuntimeDerivedMarkerCursor {
  markedAtMs: number
  markerId: string
}

export interface RuntimeDerivedStaleMarkerList {
  enabled: boolean
  status: RuntimeDbHealthState
  markers: RuntimeDerivedStaleMarkerRecord[]
  nextCursor?: RuntimeDerivedMarkerCursor | null
  truncated?: boolean
}

export interface RuntimeDerivedMarkerStatusCount {
  layer: string
  affectedPath: string
  pending: number
  claimed: number
  done: number
  failed: number
  cancelled: number
  total: number
}

export interface RuntimeDerivedMarkerStatusCounts {
  enabled: boolean
  status: RuntimeDbHealthState
  groups: RuntimeDerivedMarkerStatusCount[]
}

export interface RuntimeDerivedMarkerGc {
  deleted: RuntimeDerivedStaleMarkerRecord[]
}

export interface RuntimeDerivedMarkerReconcileRequest {
  layer?: string | null
  affectedPath?: string | null
}

/**
 * Request payload for atomically folding every pending derived stale marker
 * in one `(layer, affectedPath)` group into a single claimed batch backed by
 * one queued `derived-rebuild` runtime job (SPEC-6 PR1 decision 3). See
 * `DERIVED_REBUILD_JOB_KIND` in `@/core-runtime/derived-rebuild`.
 */
export interface RuntimeDerivedMarkerClaimBatchRequest {
  layer: string
  affectedPath: string
  jobId?: string | null
  maxAttempts?: number | null
  priority?: number | null
}

/**
 * Request payload for completing a derived-rebuild job's claimed marker
 * batch. Requires the still-active lease from `runtimeJobClaimByKind`.
 */
export interface RuntimeDerivedMarkerCompleteBatchRequest {
  jobId: string
  leaseId: string
  markerIds: string[]
}

/**
 * Request payload for releasing a derived-rebuild job's claimed marker batch
 * back to `pending`/`failed`/`cancelled` AFTER the job itself already
 * transitioned via `runtimeJobFail`/`runtimeJobCancel`.
 */
export interface RuntimeDerivedMarkerReleaseBatchRequest {
  jobId: string
  markerIds: string[]
  targetStatus: string
  error?: string | null
}

/**
 * Response payload shared by every derived marker batch transition —
 * claim/complete/release all return the same shape.
 */
export interface RuntimeDerivedMarkerBatchTransition {
  job: RuntimeJobRecord
  markers: RuntimeDerivedStaleMarkerRecord[]
}

export type RuntimeProfileKind = "model-call" | "agent-run"
export type RuntimeProfileApiMode =
  | "openai-chat-completions"
  | "anthropic-messages"
  | "google-generate-content"
  | "local-cli"
export type RuntimeProfileAuthStyle =
  | "none"
  | "bearer"
  | "x-api-key"
  | "api-key"
  | "oauth-local-cli"
export type RuntimeProfileCapabilityStatus =
  | "unknown"
  | "supported"
  | "limited"
  | "unsupported"
  | "error"

export interface RuntimeProfileCreateRequest {
  profileId?: string | null
  kind: RuntimeProfileKind
  displayName: string
  providerId: string
  modelId: string
  agentSdkModelId?: string | null
  endpoint?: string | null
  apiMode: RuntimeProfileApiMode
  authStyle: RuntimeProfileAuthStyle
  secretRef?: string | null
  enabled?: boolean | null
  taskFamilies: string[]
  maxConcurrency?: number | null
}

export interface RuntimeProfileUpdateRequest {
  profileId: string
  displayName?: string | null
  providerId?: string | null
  modelId?: string | null
  agentSdkModelId?: string | null
  clearAgentSdkModelId?: boolean | null
  endpoint?: string | null
  clearEndpoint?: boolean | null
  apiMode?: RuntimeProfileApiMode | null
  authStyle?: RuntimeProfileAuthStyle | null
  secretRef?: string | null
  clearSecretRef?: boolean | null
  enabled?: boolean | null
  taskFamilies?: string[] | null
  maxConcurrency?: number | null
  capabilityStatus?: RuntimeProfileCapabilityStatus | null
  capabilityJson?: string | null
  capabilityVersion?: string | null
  capabilityCheckedAtMs?: number | null
  probeBackoffUntilMs?: number | null
  lastCapabilityError?: string | null
  clearLastCapabilityError?: boolean | null
}

export interface RuntimeProfileUpdateResult {
  profile: RuntimeProfileRecord
  staleSecretRef?: string | null
}

export interface RuntimeProfileStatusRequest {
  profileId: string
}

export interface RuntimeProfileDeleteRequest {
  profileId: string
}

export interface RuntimeProfileDeleteResult {
  profileId: string
  deletedAtMs: number
  secretRef?: string | null
}

export interface RuntimeProfileProbeDraftRequest {
  kind: RuntimeProfileKind
  providerId: string
  modelId: string
  agentSdkModelId?: string | null
  endpoint?: string | null
  apiMode: RuntimeProfileApiMode
  authStyle: RuntimeProfileAuthStyle
}

export interface RuntimeProfileProbeRequest {
  profileId?: string | null
  draft?: RuntimeProfileProbeDraftRequest | null
  rawSecret?: string | null
  force?: boolean | null
}

export interface RuntimeProfileModelsListDraftRequest {
  endpoint?: string | null
  apiMode: RuntimeProfileApiMode
  authStyle: RuntimeProfileAuthStyle
}

export interface RuntimeProfileModelsListRequest {
  profileId?: string | null
  draft?: RuntimeProfileModelsListDraftRequest | null
  rawSecret?: string | null
  modelsUrl?: string | null
}

export interface RuntimeProfileModelsListResult {
  models: string[]
  sourceUrl: string
}

export interface RuntimeProfileRecord {
  profileId: string
  kind: RuntimeProfileKind
  displayName: string
  providerId: string
  modelId: string
  agentSdkModelId?: string | null
  endpoint?: string | null
  apiMode: RuntimeProfileApiMode
  authStyle: RuntimeProfileAuthStyle
  secretRef?: string | null
  enabled: boolean
  taskFamilies: string[]
  maxConcurrency: number
  capabilityStatus: RuntimeProfileCapabilityStatus
  capabilityJson: string
  capabilityVersion: string
  capabilityCheckedAtMs?: number | null
  probeBackoffUntilMs?: number | null
  lastCapabilityError?: string | null
  createdAtMs: number
  updatedAtMs: number
}

export interface RuntimeProfileList {
  enabled: boolean
  status: RuntimeDbHealthState
  profiles: RuntimeProfileRecord[]
}

export type RuntimeProfilePoolReleaseOutcome = "success" | "rate-limited" | "error"

export interface RuntimeProfilePoolClaimRequest {
  claimId?: string | null
  kind: RuntimeProfileKind
  taskFamily: string
  holder: string
  jobId?: string | null
  ttlMs?: number | null
  preferredProfileIds?: string[] | null
}

export interface RuntimeProfilePoolReleaseRequest {
  claimId: string
  outcome: RuntimeProfilePoolReleaseOutcome
  retryAfterMs?: number | null
  circuitOpenMs?: number | null
  reason?: string | null
  error?: string | null
}

export interface RuntimeProfilePoolRenewRequest {
  claimId: string
  ttlMs?: number | null
}

export interface RuntimeProfilePoolListRequest {
  kind?: RuntimeProfileKind | null
  taskFamily?: string | null
  jobId?: string | null
}

export interface RuntimeProfileClaimRecord {
  claimId: string
  profileId: string
  kind: RuntimeProfileKind
  taskFamily: string
  jobId?: string | null
  holder: string
  acquiredAtMs: number
  expiresAtMs: number
  releasedAtMs?: number | null
  status: string
}

export interface RuntimeProfileCircuitBreakerRecord {
  profileId: string
  status: "rate-limited" | "error"
  reason?: string | null
  error?: string | null
  openedAtMs: number
  openUntilMs: number
  updatedAtMs: number
}

export interface RuntimeProfilePoolClaim {
  claimId: string
  profileId: string
  expiresAtMs: number
  claim: RuntimeProfileClaimRecord
}

export interface RuntimeProfilePoolRelease {
  claim: RuntimeProfileClaimRecord
  circuitBreaker?: RuntimeProfileCircuitBreakerRecord | null
}

export interface RuntimeProfilePoolRenew {
  claimId: string
  profileId: string
  expiresAtMs: number
  claim: RuntimeProfileClaimRecord
}

export interface RuntimeProfilePoolList {
  enabled: boolean
  status: RuntimeDbHealthState
  activeClaims: RuntimeProfileClaimRecord[]
  circuitBreakers: RuntimeProfileCircuitBreakerRecord[]
}

export interface RuntimeTaskFamilyPolicyRecord {
  taskFamily: string
  profileOrder: string[]
  autoFailover: boolean
  updatedAtMs: number
}

export interface RuntimeTaskPolicyList {
  enabled: boolean
  status: RuntimeDbHealthState
  policies: RuntimeTaskFamilyPolicyRecord[]
}

export interface RuntimeTaskPolicySetRequest {
  taskFamily: string
  profileOrder: string[]
  autoFailover?: boolean | null
}

export interface RuntimeTaskPolicySetResult {
  policy: RuntimeTaskFamilyPolicyRecord
  removedProfileIds: string[]
}

export interface RuntimeProfilePoolEventsListRequest {
  limit?: number | null
}

export interface RuntimeProfilePoolEventsList {
  enabled: boolean
  status: RuntimeDbHealthState
  events: RuntimeEventRecord[]
}

export interface RuntimeProfileBreakerClearRequest {
  profileId: string
}

export interface RuntimeProfileBreakerClearResult {
  profileId: string
  cleared: boolean
}

/**
 * Secretless model-call plan forwarded to Rust. `provider`/`apiMode`/
 * `model` are cross-checked against the claimed profile server-side but
 * are NEVER used to pick the request destination — the Rust command
 * re-derives the URL and auth header entirely from the stored profile.
 * `body` is the already-built provider request body (see
 * `src/lib/llm-providers.ts`); it must never contain the secret or a
 * final destination URL.
 */
export interface RuntimeModelCallForwardRequest {
  claimId: string
  provider: string
  apiMode: RuntimeProfileApiMode
  model: string
  body: unknown
}

export interface RuntimeModelCallStreamRequest extends RuntimeModelCallForwardRequest {
  streamId: string
}

export interface RuntimeProfileProbeResult {
  profile?: RuntimeProfileRecord | null
  status: RuntimeProfileCapabilityStatus
  capabilityJson: string
  capabilityVersion: string
  checkedAtMs: number
  backoffUntilMs?: number | null
  message: string
}

export function runtimeJobList(): Promise<RuntimeJobList> {
  return invoke<RuntimeJobList>("runtime_job_list")
}

export function runtimeJobCreate(
  request: RuntimeJobCreateRequest,
): Promise<RuntimeJobRecord> {
  return invoke<RuntimeJobRecord>("runtime_job_create", { request })
}

export function runtimeJobClaim(request: RuntimeJobClaimRequest): Promise<RuntimeJobClaim> {
  return invoke<RuntimeJobClaim>("runtime_job_claim", { request })
}

export function runtimeJobClaimByKind(
  request: RuntimeJobClaimByKindRequest,
): Promise<RuntimeJobClaim> {
  return invoke<RuntimeJobClaim>("runtime_job_claim_by_kind", { request })
}

export function runtimeJobHeartbeat(
  request: RuntimeJobLeaseRequest,
): Promise<RuntimeJobClaim> {
  return invoke<RuntimeJobClaim>("runtime_job_heartbeat", { request })
}

export function runtimeJobComplete(
  request: RuntimeJobLeaseRequest,
): Promise<RuntimeJobRecord> {
  return invoke<RuntimeJobRecord>("runtime_job_complete", { request })
}

export function runtimeJobFail(
  request: RuntimeJobFailRequest,
): Promise<RuntimeJobRecord> {
  return invoke<RuntimeJobRecord>("runtime_job_fail", { request })
}

/**
 * Retry a `failed` or eligible `retry-wait` runtime job by pulling the SAME
 * `job_id` back to `queued` (attempt count preserved). For a
 * `derived-rebuild` job this is the recovery half of the PR2+ consumer
 * contract documented in `@/core-runtime/derived-rebuild` — polling only
 * newly-pending markers never surfaces a crashed rebuild's retries, since
 * its `claimed` markers stay claimed under this same job for its entire
 * retry lifetime.
 */
export function runtimeJobRetry(jobId: string): Promise<RuntimeJobRecord> {
  return invoke<RuntimeJobRecord>("runtime_job_retry", { request: { jobId } })
}

export function runtimeCommitBudgetClaim(
  request: RuntimeCommitBudgetClaimRequest,
): Promise<RuntimeCommitBudgetClaim> {
  return invoke<RuntimeCommitBudgetClaim>("runtime_commit_budget_claim", { request })
}

export function runtimeCommitBudgetRelease(
  claimId: string,
): Promise<RuntimeResourceBudgetClaimRecord[]> {
  return invoke<RuntimeResourceBudgetClaimRecord[]>("runtime_commit_budget_release", {
    request: { claimId },
  })
}

export function runtimeStagingArtifactCommitSuccess(
  artifactId: string,
): Promise<RuntimeStagingArtifactRecord> {
  return invoke<RuntimeStagingArtifactRecord>("runtime_staging_artifact_commit_success", {
    request: { artifactId },
  })
}

export function runtimeStagingArtifactRecord(
  request: RuntimeStagingArtifactRecordRequest,
): Promise<RuntimeStagingArtifactRecord> {
  return invoke<RuntimeStagingArtifactRecord>("runtime_staging_artifact_record", {
    request,
  })
}

export function runtimeStagingArtifactStore(
  request: RuntimeStagingArtifactStoreRequest,
): Promise<RuntimeStagingArtifactRecord> {
  return invoke<RuntimeStagingArtifactRecord>("runtime_staging_artifact_store", {
    request,
  })
}

export function runtimeStagingArtifactReadBody(
  request: RuntimeStagingArtifactReadBodyRequest,
): Promise<RuntimeStagingArtifactReadBody> {
  return invoke<RuntimeStagingArtifactReadBody>("runtime_staging_artifact_read_body", {
    request,
  })
}

export function runtimeStagingArtifactsClearPendingForJob(
  request: RuntimeStagingArtifactsClearPendingForJobRequest,
): Promise<RuntimeStagingArtifactsClearPendingForJob> {
  return invoke<RuntimeStagingArtifactsClearPendingForJob>(
    "runtime_staging_artifacts_clear_pending_for_job",
    { request },
  )
}

export function runtimeStagingArtifactList(
  request: RuntimeStagingArtifactListRequest = {},
): Promise<RuntimeStagingArtifactList> {
  return invoke<RuntimeStagingArtifactList>("runtime_staging_artifact_list", {
    request,
  })
}

export function runtimeEventAppend(
  request: RuntimeEventAppendRequest,
): Promise<RuntimeEventRecord> {
  return invoke<RuntimeEventRecord>("runtime_event_append", { request })
}

export function runtimeTimelineList(
  request: RuntimeTimelineListRequest = {},
): Promise<RuntimeTimelineList> {
  return invoke<RuntimeTimelineList>("runtime_timeline_list", { request })
}

export function runtimeProgressList(
  request: RuntimeProgressListRequest = {},
): Promise<RuntimeProgressList> {
  return invoke<RuntimeProgressList>("runtime_progress_list", { request })
}

export function runtimeProgressAppend(
  request: RuntimeProgressAppendRequest,
): Promise<RuntimeProgressAppend> {
  return invoke<RuntimeProgressAppend>("runtime_progress_append", { request })
}

export function runtimeDerivedStaleMarkerRecord(
  request: RuntimeDerivedStaleMarkerRecordRequest,
): Promise<RuntimeDerivedStaleMarkerRecord> {
  return invoke<RuntimeDerivedStaleMarkerRecord>("runtime_derived_stale_marker_record", {
    request,
  })
}

export function runtimeDerivedStaleMarkerList(
  request: RuntimeDerivedStaleMarkerListRequest = {},
): Promise<RuntimeDerivedStaleMarkerList> {
  return invoke<RuntimeDerivedStaleMarkerList>("runtime_derived_stale_marker_list", {
    request,
  })
}

export function runtimeDerivedMarkerStatusCounts(): Promise<RuntimeDerivedMarkerStatusCounts> {
  return invoke<RuntimeDerivedMarkerStatusCounts>("runtime_derived_marker_status_counts")
}

export function runtimeDerivedMarkerGc(): Promise<RuntimeDerivedMarkerGc> {
  return invoke<RuntimeDerivedMarkerGc>("runtime_derived_marker_gc")
}

export function runtimeDerivedMarkerReconcileTerminalJobs(
  request: RuntimeDerivedMarkerReconcileRequest = {},
): Promise<number> {
  return invoke<number>("runtime_derived_marker_reconcile_terminal_jobs", { request })
}

export function runtimeDerivedMarkerClaimBatch(
  request: RuntimeDerivedMarkerClaimBatchRequest,
): Promise<RuntimeDerivedMarkerBatchTransition> {
  return invoke<RuntimeDerivedMarkerBatchTransition>("runtime_derived_marker_claim_batch", {
    request,
  })
}

export function runtimeDerivedMarkerCompleteBatch(
  request: RuntimeDerivedMarkerCompleteBatchRequest,
): Promise<RuntimeDerivedMarkerBatchTransition> {
  return invoke<RuntimeDerivedMarkerBatchTransition>("runtime_derived_marker_complete_batch", {
    request,
  })
}

export function runtimeDerivedMarkerReleaseBatch(
  request: RuntimeDerivedMarkerReleaseBatchRequest,
): Promise<RuntimeDerivedMarkerBatchTransition> {
  return invoke<RuntimeDerivedMarkerBatchTransition>("runtime_derived_marker_release_batch", {
    request,
  })
}

export function runtimeProfileCreate(
  request: RuntimeProfileCreateRequest,
): Promise<RuntimeProfileRecord> {
  return invoke<RuntimeProfileRecord>("runtime_profile_create", { request })
}

export function runtimeProfileUpdate(
  request: RuntimeProfileUpdateRequest,
): Promise<RuntimeProfileUpdateResult> {
  return invoke<RuntimeProfileUpdateResult>("runtime_profile_update", { request })
}

export function runtimeProfileList(): Promise<RuntimeProfileList> {
  return invoke<RuntimeProfileList>("runtime_profile_list")
}

export function runtimeProfileStatus(
  request: RuntimeProfileStatusRequest,
): Promise<RuntimeProfileRecord> {
  return invoke<RuntimeProfileRecord>("runtime_profile_status", { request })
}

export function runtimeProfileDelete(
  request: RuntimeProfileDeleteRequest,
): Promise<RuntimeProfileDeleteResult> {
  return invoke<RuntimeProfileDeleteResult>("runtime_profile_delete", { request })
}

export function runtimeProfileProbe(
  request: RuntimeProfileProbeRequest,
): Promise<RuntimeProfileProbeResult> {
  return invoke<RuntimeProfileProbeResult>("runtime_profile_probe", { request })
}

export function runtimeProfileModelsList(
  request: RuntimeProfileModelsListRequest,
): Promise<RuntimeProfileModelsListResult> {
  return invoke<RuntimeProfileModelsListResult>("runtime_profile_models_list", { request })
}

export function runtimeModelCallForward(
  request: RuntimeModelCallForwardRequest,
): Promise<string> {
  return invoke<string>("runtime_model_call_forward", { request })
}

export function runtimeModelCallStream(
  request: RuntimeModelCallStreamRequest,
  onEvent: unknown,
): Promise<void> {
  return invoke<void>("runtime_model_call_stream", { request, onEvent })
}

export function runtimeModelCallStreamCancel(streamId: string): Promise<void> {
  return invoke<void>("runtime_model_call_stream_cancel", { streamId })
}

export function runtimeProfilePoolClaim(
  request: RuntimeProfilePoolClaimRequest,
): Promise<RuntimeProfilePoolClaim> {
  return invoke<RuntimeProfilePoolClaim>("runtime_profile_pool_claim", { request })
}

export function runtimeProfilePoolRelease(
  request: RuntimeProfilePoolReleaseRequest,
): Promise<RuntimeProfilePoolRelease> {
  return invoke<RuntimeProfilePoolRelease>("runtime_profile_pool_release", { request })
}

export function runtimeProfilePoolRenew(
  request: RuntimeProfilePoolRenewRequest,
): Promise<RuntimeProfilePoolRenew> {
  return invoke<RuntimeProfilePoolRenew>("runtime_profile_pool_renew", { request })
}

export function runtimeProfilePoolList(
  request: RuntimeProfilePoolListRequest = {},
): Promise<RuntimeProfilePoolList> {
  return invoke<RuntimeProfilePoolList>("runtime_profile_pool_list", { request })
}

export function runtimeProfilePoolEventsList(
  request: RuntimeProfilePoolEventsListRequest = {},
): Promise<RuntimeProfilePoolEventsList> {
  return invoke<RuntimeProfilePoolEventsList>("runtime_profile_pool_events_list", { request })
}

export function runtimeProfileBreakerClear(
  request: RuntimeProfileBreakerClearRequest,
): Promise<RuntimeProfileBreakerClearResult> {
  return invoke<RuntimeProfileBreakerClearResult>("runtime_profile_breaker_clear", { request })
}

export function runtimeTaskPolicyList(): Promise<RuntimeTaskPolicyList> {
  return invoke<RuntimeTaskPolicyList>("runtime_task_policy_list")
}

export function runtimeTaskPolicySet(
  request: RuntimeTaskPolicySetRequest,
): Promise<RuntimeTaskPolicySetResult> {
  return invoke<RuntimeTaskPolicySetResult>("runtime_task_policy_set", { request })
}

export function runtimeJobCancel(jobId: string): Promise<RuntimeJobRecord> {
  return invoke<RuntimeJobRecord>("runtime_job_cancel", { request: { jobId } })
}

export function runtimeJobPause(jobId: string): Promise<RuntimeJobRecord> {
  return invoke<RuntimeJobRecord>("runtime_job_pause", { request: { jobId } })
}

export function runtimeJobResume(jobId: string): Promise<RuntimeJobRecord> {
  return invoke<RuntimeJobRecord>("runtime_job_resume", { request: { jobId } })
}
