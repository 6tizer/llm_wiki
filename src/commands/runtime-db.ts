import { invoke } from "@tauri-apps/api/core"
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

export interface RuntimeDerivedStaleMarkerList {
  enabled: boolean
  status: RuntimeDbHealthState
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

export interface RuntimeProfileStatusRequest {
  profileId: string
}

export interface RuntimeProfileRecord {
  profileId: string
  kind: RuntimeProfileKind
  displayName: string
  providerId: string
  modelId: string
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

export function runtimeJobList(): Promise<RuntimeJobList> {
  return invoke<RuntimeJobList>("runtime_job_list")
}

export function runtimeJobCreate(
  request: RuntimeJobCreateRequest,
): Promise<RuntimeJobRecord> {
  return invoke<RuntimeJobRecord>("runtime_job_create", { request })
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

export function runtimeEventAppend(
  request: RuntimeEventAppendRequest,
): Promise<RuntimeEventRecord> {
  return invoke<RuntimeEventRecord>("runtime_event_append", { request })
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

export function runtimeProfileCreate(
  request: RuntimeProfileCreateRequest,
): Promise<RuntimeProfileRecord> {
  return invoke<RuntimeProfileRecord>("runtime_profile_create", { request })
}

export function runtimeProfileUpdate(
  request: RuntimeProfileUpdateRequest,
): Promise<RuntimeProfileRecord> {
  return invoke<RuntimeProfileRecord>("runtime_profile_update", { request })
}

export function runtimeProfileList(): Promise<RuntimeProfileList> {
  return invoke<RuntimeProfileList>("runtime_profile_list")
}

export function runtimeProfileStatus(
  request: RuntimeProfileStatusRequest,
): Promise<RuntimeProfileRecord> {
  return invoke<RuntimeProfileRecord>("runtime_profile_status", { request })
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
