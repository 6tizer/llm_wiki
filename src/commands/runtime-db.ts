import { invoke } from "@tauri-apps/api/core"

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

export function runtimeJobList(): Promise<RuntimeJobList> {
  return invoke<RuntimeJobList>("runtime_job_list")
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
