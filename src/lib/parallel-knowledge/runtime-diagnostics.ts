import {
  runtimeJobList,
  runtimeProgressList,
  runtimeStagingArtifactList,
  runtimeTimelineList,
  type RuntimeDbHealthState,
  type RuntimeJobList,
  type RuntimeProgressList,
  type RuntimeStagingArtifactList,
  type RuntimeTimelineList,
} from "@/commands/runtime-db"

export type RuntimeDiagnosticsStatus =
  | RuntimeDbHealthState
  | "partial-error"
  | "error"

export interface RuntimeDiagnosticsAdapters {
  readonly listJobs: () => Promise<RuntimeJobList>
  readonly listProgress: () => Promise<RuntimeProgressList>
  readonly listTimeline: () => Promise<RuntimeTimelineList>
  readonly listStagingArtifacts: () => Promise<RuntimeStagingArtifactList>
}

export interface RuntimeDiagnosticsSection<T> {
  readonly data: T | null
  readonly error: string | null
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
}

export interface RuntimeDiagnosticsSnapshot {
  readonly status: RuntimeDiagnosticsStatus
  readonly jobs: RuntimeDiagnosticsSection<RuntimeJobList>
  readonly progress: RuntimeDiagnosticsSection<RuntimeProgressList>
  readonly timeline: RuntimeDiagnosticsSection<RuntimeTimelineList>
  readonly stagingArtifacts: RuntimeDiagnosticsSection<RuntimeStagingArtifactList>
  readonly summary: RuntimeDiagnosticsSummary
}

const DEFAULT_RUNTIME_DIAGNOSTICS_ADAPTERS: RuntimeDiagnosticsAdapters = {
  listJobs: runtimeJobList,
  listProgress: runtimeProgressList,
  listTimeline: runtimeTimelineList,
  listStagingArtifacts: runtimeStagingArtifactList,
}

/** Reads runtime diagnostics without mutating jobs, progress, timeline, or artifacts. */
export async function captureRuntimeDiagnosticsSnapshot(
  adapters: RuntimeDiagnosticsAdapters = DEFAULT_RUNTIME_DIAGNOSTICS_ADAPTERS,
): Promise<RuntimeDiagnosticsSnapshot> {
  const [jobs, progress, timeline, stagingArtifacts] = await Promise.all([
    readSection(adapters.listJobs),
    readSection(adapters.listProgress),
    readSection(adapters.listTimeline),
    readSection(adapters.listStagingArtifacts),
  ])

  return {
    status: resolveSnapshotStatus([jobs, progress, timeline, stagingArtifacts]),
    jobs,
    progress,
    timeline,
    stagingArtifacts,
    summary: summarizeRuntimeDiagnostics(jobs, progress, timeline, stagingArtifacts),
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
): RuntimeDiagnosticsSummary {
  const jobRows = jobs.data?.jobs ?? []

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
  }
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
