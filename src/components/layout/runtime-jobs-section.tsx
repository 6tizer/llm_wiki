import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import {
  AlertCircle,
  CheckCircle2,
  Clock,
  Loader2,
  Pause,
  Play,
  X,
} from "lucide-react"
import {
  runtimeJobCancel,
  runtimeJobPause,
  runtimeJobResume,
  type RuntimeJobList,
  type RuntimeJobRecord,
  type RuntimeJobState,
} from "@/commands/runtime-db"
import {
  captureRuntimeDiagnosticsSnapshot,
  type RuntimeDiagnosticsSnapshot,
} from "@/lib/parallel-knowledge/runtime-diagnostics"
import {
  BULK_KNOWLEDGE_PREPARE_JOB_KIND,
  type BulkKnowledgePrepareJobPayload,
} from "@/core-runtime/parallel-knowledge"
import { useWikiStore } from "@/stores/wiki-store"

const ACTIVE_POLL_INTERVAL_MS = 2_000
const IDLE_POLL_INTERVAL_MS = 10_000
const QUIET_POLL_INTERVAL_MS = 30_000
const ERROR_POLL_INTERVAL_MS = 30_000
const TERMINAL_STATES = new Set<RuntimeJobState>(["completed", "failed", "cancelled"])

export interface RuntimeJobsSummary {
  visible: boolean
  total: number
  active: number
  failed: number
  running: number
  queued: number
  paused: number
  retryWait: number
  error: string | null
}

export interface RuntimeJobsState {
  list: RuntimeJobList | null
  summary: RuntimeJobsSummary
  diagnostics: RuntimeJobsDiagnostics
  actionJobId: string | null
  refresh: () => Promise<void>
  pauseJob: (jobId: string) => Promise<void>
  resumeJob: (jobId: string) => Promise<void>
  cancelJob: (jobId: string) => Promise<void>
}

export const EMPTY_RUNTIME_JOBS_SUMMARY: RuntimeJobsSummary = {
  visible: false,
  total: 0,
  active: 0,
  failed: 0,
  running: 0,
  queued: 0,
  paused: 0,
  retryWait: 0,
  error: null,
}

export interface RuntimeJobsDiagnostics {
  visible: boolean
  prepareCompleted: number
  prepareTotal: number
  prepareSources: number
  prepareWaitingForWorker: boolean
  etaMs: number | null
  activeProfileClaims: number
  circuitBreakers: number
  stagingPending: number
  stagingFailed: number
  stagingCommitted: number
  latestProgressType: string | null
  sectionError: string | null
}

export const EMPTY_RUNTIME_JOBS_DIAGNOSTICS: RuntimeJobsDiagnostics = {
  visible: false,
  prepareCompleted: 0,
  prepareTotal: 0,
  prepareSources: 0,
  prepareWaitingForWorker: false,
  etaMs: null,
  activeProfileClaims: 0,
  circuitBreakers: 0,
  stagingPending: 0,
  stagingFailed: 0,
  stagingCommitted: 0,
  latestProgressType: null,
  sectionError: null,
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function summarizeRuntimeJobs(
  list: RuntimeJobList | null,
  error: string | null,
): RuntimeJobsSummary {
  if (error) {
    return { ...EMPTY_RUNTIME_JOBS_SUMMARY, visible: true, error }
  }
  if (!list || !list.enabled || list.status !== "healthy") {
    return EMPTY_RUNTIME_JOBS_SUMMARY
  }
  const running = list.jobs.filter((job) => job.state === "running").length
  const queued = list.jobs.filter((job) => job.state === "queued").length
  const paused = list.jobs.filter((job) => job.state === "paused").length
  const retryWait = list.jobs.filter((job) => job.state === "retry-wait").length
  const failed = list.jobs.filter((job) => job.state === "failed").length
  const active = running + queued
  return {
    visible: list.jobs.length > 0,
    total: list.jobs.length,
    active,
    failed,
    running,
    queued,
    paused,
    retryWait,
    error: null,
  }
}

export function useRuntimeJobsState(): RuntimeJobsState {
  const project = useWikiStore((state) => state.project)
  const [list, setList] = useState<RuntimeJobList | null>(null)
  const [snapshot, setSnapshot] = useState<RuntimeDiagnosticsSnapshot | null>(null)
  const [listError, setListError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [actionJobId, setActionJobId] = useState<string | null>(null)
  const pollDelayRef = useRef(IDLE_POLL_INTERVAL_MS)

  const refresh = useCallback(async () => {
    if (!project) {
      setList(null)
      setSnapshot(null)
      setListError(null)
      pollDelayRef.current = IDLE_POLL_INTERVAL_MS
      return
    }
    try {
      const next = await captureRuntimeDiagnosticsSnapshot()
      const nextListError = next.jobs.error ?? (next.status === "error" ? firstSectionError(next) : null)
      setSnapshot(next)
      setList(next.jobs.data)
      setListError(nextListError)
      pollDelayRef.current = pollIntervalMs(summarizeRuntimeJobs(next.jobs.data, nextListError))
    } catch (error) {
      setListError(errorText(error))
      pollDelayRef.current = ERROR_POLL_INTERVAL_MS
    }
  }, [project])

  const summary = useMemo(
    () => summarizeRuntimeJobs(list, listError ?? actionError),
    [list, listError, actionError],
  )
  const diagnostics = useMemo(
    () => summarizeRuntimeDiagnosticsView(snapshot),
    [snapshot],
  )

  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null

    async function poll(): Promise<void> {
      await refresh()
      if (cancelled || !project) return
      timer = setTimeout(() => {
        void poll()
      }, pollDelayRef.current)
    }

    void poll()

    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [project, refresh])

  async function runAction(jobId: string, action: (id: string) => Promise<RuntimeJobRecord>): Promise<void> {
    setActionJobId(jobId)
    setActionError(null)
    try {
      await action(jobId)
      await refresh()
    } catch (error) {
      setActionError(errorText(error))
    } finally {
      setActionJobId(null)
    }
  }

  return {
    list,
    summary,
    diagnostics,
    actionJobId,
    refresh,
    pauseJob: (jobId) => runAction(jobId, runtimeJobPause),
    resumeJob: (jobId) => runAction(jobId, runtimeJobResume),
    cancelJob: (jobId) => runAction(jobId, runtimeJobCancel),
  }
}

export function RuntimeJobsSection({ state }: { state: RuntimeJobsState }) {
  const { t } = useTranslation()
  const { list, summary, diagnostics } = state

  if (!summary.visible && !diagnostics.visible) return null

  const jobs = list?.jobs ?? []
  const visibleJobs = [...jobs]
    .sort((a, b) => b.updatedAtMs - a.updatedAtMs)
    .slice(0, 8)

  return (
    <div className="border-b border-border/50 px-3 py-1.5">
      <div className="mb-1 flex items-center justify-between gap-2 text-[10px] text-muted-foreground">
        <span>{t("runtimeJobs.title")}</span>
        <span className="flex-1 truncate text-right">
          {t("runtimeJobs.summary", {
            running: summary.running,
            queued: summary.queued,
            paused: summary.paused,
            failed: summary.failed,
          })}
        </span>
      </div>
      {summary.error && (
        <div className="mb-1 truncate text-[10px] text-destructive" data-testid="runtime-jobs-error">
          {summary.error}
        </div>
      )}
      {visibleJobs.length === 0 && !summary.error ? (
        <div className="text-[10px] text-muted-foreground">{t("runtimeJobs.empty")}</div>
      ) : (
        visibleJobs.map((job) => (
          <RuntimeJobRow
            key={job.jobId}
            job={job}
            actionJobId={state.actionJobId}
            onPause={state.pauseJob}
            onResume={state.resumeJob}
            onCancel={state.cancelJob}
          />
        ))
      )}
      {diagnostics.visible && <RuntimeDiagnosticsBlock diagnostics={diagnostics} />}
    </div>
  )
}

function RuntimeDiagnosticsBlock({ diagnostics }: { diagnostics: RuntimeJobsDiagnostics }) {
  const { t } = useTranslation()
  return (
    <div className="mt-1 space-y-0.5 border-t border-border/40 pt-1 text-[10px] text-muted-foreground">
      <div className="flex items-center justify-between gap-2">
        <span>{t("runtimeJobs.diagnostics.title")}</span>
        <span className="truncate text-right">
          {t("runtimeJobs.diagnostics.prepare", {
            completed: diagnostics.prepareCompleted,
            total: diagnostics.prepareTotal,
            sources: diagnostics.prepareSources,
          })}
        </span>
      </div>
      <div className="flex items-center justify-between gap-2">
        <span>
          {diagnostics.etaMs === null
            ? t("runtimeJobs.diagnostics.etaWaiting")
            : t("runtimeJobs.diagnostics.etaReady", {
              eta: formatDuration(diagnostics.etaMs),
            })}
        </span>
        <span>
          {t("runtimeJobs.diagnostics.profiles", {
            claims: diagnostics.activeProfileClaims,
            breakers: diagnostics.circuitBreakers,
          })}
        </span>
      </div>
      {diagnostics.prepareWaitingForWorker && (
        <div className="truncate" data-testid="runtime-diagnostics-worker-waiting">
          {t("runtimeJobs.diagnostics.awaitingWorker")}
        </div>
      )}
      <div className="truncate">
        {t("runtimeJobs.diagnostics.staging", {
          pending: diagnostics.stagingPending,
          failed: diagnostics.stagingFailed,
          committed: diagnostics.stagingCommitted,
        })}
      </div>
      {diagnostics.latestProgressType && (
        <div className="truncate">
          {t("runtimeJobs.diagnostics.latestProgress", {
            type: diagnostics.latestProgressType,
          })}
        </div>
      )}
      {diagnostics.sectionError && (
        <div className="truncate text-destructive" data-testid="runtime-diagnostics-error">
          {diagnostics.sectionError}
        </div>
      )}
    </div>
  )
}

function RuntimeJobRow({
  job,
  actionJobId,
  onPause,
  onResume,
  onCancel,
}: {
  job: RuntimeJobRecord
  actionJobId: string | null
  onPause: (jobId: string) => void
  onResume: (jobId: string) => void
  onCancel: (jobId: string) => void
}) {
  const { t } = useTranslation()
  const isBusy = actionJobId === job.jobId
  const canPause = job.state === "queued" || job.state === "running"
  const canResume = job.state === "paused"
  const canCancel = ["queued", "running", "paused", "retry-wait"].includes(job.state)
  const Icon = iconForJobState(job.state)

  return (
    <div className="py-1.5 text-xs" data-testid={`runtime-job-row-${job.jobId}`}>
      <div className="flex items-center gap-2">
        <div className="shrink-0">
          <Icon className={iconClassName(job.state)} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate font-medium">
            {job.kind} <span className="font-mono text-[10px] text-muted-foreground">{shortJobId(job.jobId)}</span>
          </div>
          <div className="truncate text-[10px] text-muted-foreground/70">
            {t(`runtimeJobs.state.${job.state}`)} - {t("runtimeJobs.attempt", {
              attempt: job.attempt,
              maxAttempts: job.maxAttempts,
            })}
          </div>
          {job.lastError && (
            <div className="mt-0.5 truncate text-[10px] text-destructive">{job.lastError}</div>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {isBusy && <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />}
          {canPause && (
            <button
              type="button"
              onClick={() => onPause(job.jobId)}
              disabled={isBusy}
              className="rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50"
              title={t("runtimeJobs.actions.pause")}
              aria-label={t("runtimeJobs.actions.pause")}
            >
              <Pause className="h-3 w-3" />
            </button>
          )}
          {canResume && (
            <button
              type="button"
              onClick={() => onResume(job.jobId)}
              disabled={isBusy}
              className="rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50"
              title={t("runtimeJobs.actions.resume")}
              aria-label={t("runtimeJobs.actions.resume")}
            >
              <Play className="h-3 w-3" />
            </button>
          )}
          {canCancel && (
            <button
              type="button"
              onClick={() => onCancel(job.jobId)}
              disabled={isBusy}
              className="rounded p-0.5 text-muted-foreground hover:bg-destructive/20 hover:text-destructive disabled:opacity-50"
              title={t("runtimeJobs.actions.cancel")}
              aria-label={t("runtimeJobs.actions.cancel")}
            >
              <X className="h-3 w-3" />
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

function shortJobId(jobId: string): string {
  return jobId.length <= 8 ? jobId : jobId.slice(0, 8)
}

function iconForJobState(state: RuntimeJobState) {
  if (state === "running") return Loader2
  if (state === "failed") return AlertCircle
  if (state === "completed") return CheckCircle2
  return Clock
}

function iconClassName(state: RuntimeJobState): string {
  if (state === "running") return "h-3 w-3 animate-spin text-primary"
  if (state === "failed") return "h-3 w-3 text-destructive"
  if (state === "completed") return "h-3 w-3 text-emerald-500"
  return "h-3 w-3 text-muted-foreground"
}

function summarizeRuntimeDiagnosticsView(
  snapshot: RuntimeDiagnosticsSnapshot | null,
): RuntimeJobsDiagnostics {
  if (!snapshot) {
    return EMPTY_RUNTIME_JOBS_DIAGNOSTICS
  }

  const jobs = snapshot.jobs.data?.jobs ?? []
  const prepareJobs = jobs.filter((job) => job.kind === BULK_KNOWLEDGE_PREPARE_JOB_KIND)
  const payloads = prepareJobs.map(parsePreparePayload).filter((payload) => payload !== null)
  const prepareTotal = payloads.reduce(
    (max, payload) => Math.max(max, payload.batchTotal),
    prepareJobs.length,
  )
  const prepareSources = payloads.reduce(
    (max, payload) => Math.max(max, payload.uniqueSourceTotal),
    0,
  )
  const prepareCompleted = prepareJobs.filter((job) => job.state === "completed").length
  const progressRows = snapshot.progress.data?.progress ?? []
  const stagingArtifacts = snapshot.stagingArtifacts.data?.artifacts ?? []
  const sectionError = firstSectionError(snapshot)
  const activeProfileClaims = snapshot.profilePool.data?.activeClaims.length ?? 0
  const circuitBreakers = snapshot.profilePool.data?.circuitBreakers.length ?? 0
  const prepareWaitingForWorker =
    prepareJobs.length > 0 &&
    prepareCompleted === 0 &&
    progressRows.length === 0 &&
    activeProfileClaims === 0 &&
    prepareJobs.some((job) => job.state === "queued" || job.state === "retry-wait")
  const diagnostics = {
    visible:
      prepareJobs.length > 0 ||
      progressRows.length > 0 ||
      stagingArtifacts.length > 0 ||
      activeProfileClaims > 0 ||
      circuitBreakers > 0 ||
      Boolean(sectionError),
    prepareCompleted,
    prepareTotal,
    prepareSources,
    prepareWaitingForWorker,
    etaMs: estimatePrepareEtaMs(prepareJobs, prepareTotal, prepareCompleted),
    activeProfileClaims,
    circuitBreakers,
    stagingPending: stagingArtifacts.filter((artifact) => artifact.status === "pending").length,
    stagingFailed: stagingArtifacts.filter((artifact) => artifact.status === "failed").length,
    stagingCommitted: stagingArtifacts.filter((artifact) => artifact.status === "committed").length,
    latestProgressType: latestProgressType(progressRows),
    sectionError,
  } satisfies RuntimeJobsDiagnostics

  return diagnostics.visible ? diagnostics : EMPTY_RUNTIME_JOBS_DIAGNOSTICS
}

function pollIntervalMs(summary: RuntimeJobsSummary): number {
  if (summary.error) {
    return ERROR_POLL_INTERVAL_MS
  }
  if (!summary.visible) {
    return QUIET_POLL_INTERVAL_MS
  }
  if (summary.running > 0 || summary.queued > 0) {
    return ACTIVE_POLL_INTERVAL_MS
  }
  return IDLE_POLL_INTERVAL_MS
}

function firstSectionError(snapshot: RuntimeDiagnosticsSnapshot): string | null {
  return (
    snapshot.jobs.error ??
    snapshot.progress.error ??
    snapshot.timeline.error ??
    snapshot.stagingArtifacts.error ??
    snapshot.profilePool.error
  )
}

function parsePreparePayload(job: RuntimeJobRecord): {
  readonly batchTotal: number
  readonly uniqueSourceTotal: number
} | null {
  try {
    const payload = JSON.parse(job.payload) as Partial<BulkKnowledgePrepareJobPayload>
    if (payload.kind !== BULK_KNOWLEDGE_PREPARE_JOB_KIND) {
      return null
    }
    const batchTotal = numberOrZero(payload.batchTotal)
    const uniqueSourceTotal = numberOrZero(payload.uniqueSourceTotal)
    return {
      batchTotal,
      uniqueSourceTotal: uniqueSourceTotal || sourceCountFromPayload(payload.sources),
    }
  } catch {
    return null
  }
}

function sourceCountFromPayload(sources: unknown): number {
  return Array.isArray(sources) ? sources.length : 0
}

function numberOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0
}

function estimatePrepareEtaMs(
  jobs: readonly RuntimeJobRecord[],
  total: number,
  completed: number,
): number | null {
  const remaining = total - completed
  if (remaining <= 0 || completed <= 0 || jobs.some((job) => job.state === "running")) {
    return null
  }
  const earliest = Math.min(...jobs.map((job) => job.createdAtMs))
  const terminalTimestamps = jobs
    .filter((job) => TERMINAL_STATES.has(job.state))
    .map((job) => job.completedAtMs ?? job.failedAtMs ?? job.cancelledAtMs ?? job.updatedAtMs)
  if (terminalTimestamps.length === 0) {
    return null
  }
  const latestTerminal = Math.max(...terminalTimestamps)
  if (!Number.isFinite(earliest) || !Number.isFinite(latestTerminal) || latestTerminal <= earliest) {
    return null
  }
  return Math.ceil(((latestTerminal - earliest) / completed) * remaining)
}

function latestProgressType(
  progressRows: readonly {
    readonly payload: string
    readonly progressKey: string
    readonly updatedAtMs: number
  }[],
): string | null {
  const [latest] = [...progressRows].sort((left, right) => right.updatedAtMs - left.updatedAtMs)
  if (!latest) return null
  try {
    const payload = JSON.parse(latest.payload) as { readonly type?: unknown }
    return typeof payload.type === "string" ? payload.type : latest.progressKey
  } catch {
    return latest.progressKey
  }
}

function formatDuration(ms: number): string {
  const seconds = Math.max(1, Math.ceil(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.ceil(seconds / 60)
  return `${minutes}m`
}
