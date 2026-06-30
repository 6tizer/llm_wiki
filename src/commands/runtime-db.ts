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

export function runtimeJobCancel(jobId: string): Promise<RuntimeJobRecord> {
  return invoke<RuntimeJobRecord>("runtime_job_cancel", { request: { jobId } })
}

export function runtimeJobPause(jobId: string): Promise<RuntimeJobRecord> {
  return invoke<RuntimeJobRecord>("runtime_job_pause", { request: { jobId } })
}

export function runtimeJobResume(jobId: string): Promise<RuntimeJobRecord> {
  return invoke<RuntimeJobRecord>("runtime_job_resume", { request: { jobId } })
}
