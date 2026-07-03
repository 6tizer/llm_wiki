import {
  runtimeJobList,
  runtimeProgressList,
  runtimeProfilePoolList,
  runtimeStagingArtifactList,
  runtimeTimelineList,
  type RuntimeDbHealthState,
  type RuntimeJobList,
  type RuntimeJobRecord,
  type RuntimeJobState,
  type RuntimeProgressList,
  type RuntimeProfilePoolList,
  type RuntimeStagingArtifactList,
  type RuntimeTimelineList,
} from "@/commands/runtime-db"
import { MARKDOWN_CONFLICT_REPAIR_KIND } from "@/commands/markdown-commit-repair"
import {
  BULK_KNOWLEDGE_ARTIFACT_REPAIR_JOB_KIND,
  BULK_KNOWLEDGE_MAP_REDUCE_REPAIR_JOB_KIND,
} from "@/core-runtime/parallel-knowledge"

/**
 * SPEC-5-FIX PR5: these three job kinds are produced by the bulk-knowledge
 * pipeline (staging artifact repair, long-document map-reduce repair, and
 * Markdown commit conflict repair) but have no registered consumer yet --
 * they are structural orphans by design (see spec-5-fix-pipeline-wiring.md
 * PR5). Rather than leaving them silently invisible, runtime diagnostics
 * surfaces how many are pending/failed per kind so the gap is queryable
 * instead of a silent black hole.
 */
export const REPAIR_JOB_KINDS = [
  BULK_KNOWLEDGE_ARTIFACT_REPAIR_JOB_KIND,
  BULK_KNOWLEDGE_MAP_REDUCE_REPAIR_JOB_KIND,
  MARKDOWN_CONFLICT_REPAIR_KIND,
] as const

const PENDING_REPAIR_JOB_STATES: readonly RuntimeJobState[] = [
  "queued",
  "running",
  "paused",
  "retry-wait",
]

export type RuntimeDiagnosticsStatus =
  | RuntimeDbHealthState
  | "partial-error"
  | "error"

export interface RuntimeDiagnosticsAdapters {
  readonly listJobs: () => Promise<RuntimeJobList>
  readonly listProgress: () => Promise<RuntimeProgressList>
  readonly listTimeline: () => Promise<RuntimeTimelineList>
  readonly listStagingArtifacts: () => Promise<RuntimeStagingArtifactList>
  readonly listProfilePool: () => Promise<RuntimeProfilePoolList>
}

export interface RuntimeDiagnosticsSection<T> {
  readonly data: T | null
  readonly error: string | null
}

export interface RuntimeRepairJobKindSummary {
  readonly kind: string
  readonly pendingCount: number
  readonly failedCount: number
}

export interface RuntimeDiagnosticsSummary {
  readonly queuedJobCount: number
  readonly activeJobCount: number
  readonly pausedJobCount: number
  readonly retryWaitJobCount: number
  readonly failedJobCount: number
  readonly completedJobCount: number
  readonly cancelledJobCount: number
  readonly progressCount: number
  readonly eventCount: number
  readonly stagingArtifactCount: number
  readonly activeProfileClaimCount: number
  readonly circuitBreakerCount: number
  /** Total pending (queued/running/paused/retry-wait) repair jobs across all unconsumed repair kinds. */
  readonly repairJobPendingCount: number
  /** Per-kind breakdown for the unconsumed repair job kinds (see REPAIR_JOB_KINDS). */
  readonly repairJobsByKind: readonly RuntimeRepairJobKindSummary[]
}

export interface RuntimeDiagnosticsSnapshot {
  readonly status: RuntimeDiagnosticsStatus
  readonly capturedAtMs: number
  readonly jobs: RuntimeDiagnosticsSection<RuntimeJobList>
  readonly progress: RuntimeDiagnosticsSection<RuntimeProgressList>
  readonly timeline: RuntimeDiagnosticsSection<RuntimeTimelineList>
  readonly stagingArtifacts: RuntimeDiagnosticsSection<RuntimeStagingArtifactList>
  readonly profilePool: RuntimeDiagnosticsSection<RuntimeProfilePoolList>
  readonly summary: RuntimeDiagnosticsSummary
}

const DEFAULT_RUNTIME_DIAGNOSTICS_ADAPTERS: RuntimeDiagnosticsAdapters = {
  listJobs: runtimeJobList,
  listProgress: runtimeProgressList,
  listTimeline: runtimeTimelineList,
  listStagingArtifacts: runtimeStagingArtifactList,
  listProfilePool: () =>
    runtimeProfilePoolList({ kind: "model-call", taskFamily: "ingest" }),
}

/** Reads runtime diagnostics without mutating jobs, progress, timeline, or artifacts. */
export async function captureRuntimeDiagnosticsSnapshot(
  adapters: RuntimeDiagnosticsAdapters = DEFAULT_RUNTIME_DIAGNOSTICS_ADAPTERS,
): Promise<RuntimeDiagnosticsSnapshot> {
  const capturedAtMs = Date.now()
  const [jobs, progress, timeline, stagingArtifacts, profilePool] = await Promise.all([
    readSection(adapters.listJobs),
    readSection(adapters.listProgress),
    readSection(adapters.listTimeline),
    readSection(adapters.listStagingArtifacts),
    readSection(adapters.listProfilePool),
  ])

  return {
    status: resolveSnapshotStatus([jobs, progress, timeline, stagingArtifacts, profilePool]),
    capturedAtMs,
    jobs,
    progress,
    timeline,
    stagingArtifacts,
    profilePool,
    summary: summarizeRuntimeDiagnostics(jobs, progress, timeline, stagingArtifacts, profilePool),
  }
}

function readSection<T>(load: () => Promise<T>): Promise<RuntimeDiagnosticsSection<T>> {
  return load()
    .then((data) => ({ data, error: null }))
    .catch((error: unknown) => ({ data: null, error: describeError(error) }))
}

function resolveSnapshotStatus(
  sections: readonly RuntimeDiagnosticsSection<{
    readonly enabled: boolean
    readonly status: RuntimeDbHealthState
  }>[],
): RuntimeDiagnosticsStatus {
  const errors = sections.filter((section) => section.error)
  if (errors.length === sections.length) {
    return "error"
  }
  if (errors.length > 0) {
    return "partial-error"
  }
  if (sections.some((section) => section.data?.status === "disabled")) {
    return "disabled"
  }
  if (sections.some((section) => section.data?.status === "no-project")) {
    return "no-project"
  }
  return "healthy"
}

function summarizeRuntimeDiagnostics(
  jobs: RuntimeDiagnosticsSection<RuntimeJobList>,
  progress: RuntimeDiagnosticsSection<RuntimeProgressList>,
  timeline: RuntimeDiagnosticsSection<RuntimeTimelineList>,
  stagingArtifacts: RuntimeDiagnosticsSection<RuntimeStagingArtifactList>,
  profilePool: RuntimeDiagnosticsSection<RuntimeProfilePoolList>,
): RuntimeDiagnosticsSummary {
  const jobRows = jobs.data?.jobs ?? []
  const repairJobsByKind = summarizeRepairJobsByKind(jobRows)

  return {
    queuedJobCount: jobRows.filter((job) => job.state === "queued").length,
    activeJobCount: jobRows.filter((job) => job.state === "running").length,
    pausedJobCount: jobRows.filter((job) => job.state === "paused").length,
    retryWaitJobCount: jobRows.filter((job) => job.state === "retry-wait").length,
    failedJobCount: jobRows.filter((job) => job.state === "failed").length,
    completedJobCount: jobRows.filter((job) => job.state === "completed").length,
    cancelledJobCount: jobRows.filter((job) => job.state === "cancelled").length,
    progressCount: progress.data?.progress.length ?? 0,
    eventCount: timeline.data?.events.length ?? 0,
    stagingArtifactCount: stagingArtifacts.data?.artifacts.length ?? 0,
    activeProfileClaimCount: profilePool.data?.activeClaims.length ?? 0,
    circuitBreakerCount: profilePool.data?.circuitBreakers.length ?? 0,
    repairJobPendingCount: repairJobsByKind.reduce(
      (sum, entry) => sum + entry.pendingCount,
      0,
    ),
    repairJobsByKind,
  }
}

function summarizeRepairJobsByKind(
  jobRows: readonly RuntimeJobRecord[],
): RuntimeRepairJobKindSummary[] {
  return REPAIR_JOB_KINDS.map((kind) => {
    const rows = jobRows.filter((job) => job.kind === kind)
    return {
      kind,
      pendingCount: rows.filter((job) => PENDING_REPAIR_JOB_STATES.includes(job.state))
        .length,
      failedCount: rows.filter((job) => job.state === "failed").length,
    }
  })
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }
  if (typeof error === "string") {
    return error
  }
  return "runtime-diagnostics-error"
}
