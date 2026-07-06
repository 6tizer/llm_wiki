import { useCallback, useMemo, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  Clock,
  Loader2,
  Pause,
  Play,
  X,
} from "lucide-react"
import {
  runtimeDerivedMarkerReleaseBatch,
  runtimeJobCancel,
  runtimeJobPause,
  runtimeJobResume,
  type RuntimeJobList,
  type RuntimeJobRecord,
  type RuntimeJobState,
  type RuntimeProfileCircuitBreakerRecord,
} from "@/commands/runtime-db"
import { DERIVED_REBUILD_JOB_KIND, parseDerivedRebuildJobPayload } from "@/core-runtime/derived-rebuild"
import {
  captureRuntimeDiagnosticsSnapshot,
  type RuntimeDiagnosticsSnapshot,
  type RuntimeRepairJobKindSummary,
} from "@/lib/parallel-knowledge/runtime-diagnostics"
import {
  classifyJobLeaseHealth,
  groupLeasesByJobId,
  isAwaitingWorker,
  type LeaseHealth,
} from "@/lib/parallel-knowledge/lease-health"
import {
  BULK_KNOWLEDGE_PREPARE_JOB_KIND,
  type BulkKnowledgePrepareJobPayload,
} from "@/core-runtime/parallel-knowledge"
import {
  AGENT_CHAT_RUN_JOB_KIND,
  parseAgentChatRunJobPayload,
} from "@/lib/agent/agent-chat-run-job"
import { AGENT_REWIND_SESSION_JOB_KIND } from "@/lib/agent/agent-rewind-session-job"
import { useWikiStore } from "@/stores/wiki-store"
import { usePolling } from "@/lib/hooks/use-polling"
import { useCountdown } from "@/lib/hooks/use-countdown"
import { breakerDisplayReason, countdownSeconds } from "@/lib/hooks/breaker-display"

const ACTIVE_POLL_INTERVAL_MS = 2_000
const IDLE_POLL_INTERVAL_MS = 10_000
const QUIET_POLL_INTERVAL_MS = 30_000
const ERROR_POLL_INTERVAL_MS = 30_000
const TERMINAL_STATES = new Set<RuntimeJobState>(["completed", "failed", "cancelled"])

/**
 * Closeout hotfix P1 #3: the two throwaway "anchor" job kinds minted purely
 * to give a `runtime_event_append` call a valid `job_id` FK (see
 * `mintDerivedStaleMarkerAnchorEvent` in
 * `@/lib/derived-rebuild/manual-rebuild-marker.ts`) are completed inline in
 * the same tick they're created — by the time this panel could ever render
 * one, cancelling it does nothing useful and only risks confusing a user
 * into thinking they stopped a rebuild that was never theirs to cancel.
 * Kept as local string literals (not imported) to avoid pulling in
 * `@/lib/ingest-write.ts`'s much heavier dependency graph just for one
 * constant; must stay in sync with `INGEST_MARKER_EVENT_JOB_KIND`
 * (ingest-write.ts) and `MANUAL_REBUILD_ANCHOR_JOB_KIND`
 * (manual-rebuild-marker.ts).
 */
const ANCHOR_JOB_KINDS = new Set<string>(["auto-ingest-marker-event", "manual-rebuild-marker-event"])

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
  capturedAtMs: number | null
  actionJobId: string | null
  /** Clears any pending poll timer, refreshes immediately, and reschedules from the fresh delay — see `usePolling`. */
  refreshNow: () => Promise<void>
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
  prepareSuspectedStuckCount: number
  prepareUnparseableJobCount: number
  etaMs: number | null
  activeProfileClaims: number
  circuitBreakers: number
  circuitBreakerDetails: readonly RuntimeProfileCircuitBreakerRecord[]
  stagingPending: number
  stagingFailed: number
  stagingCommitted: number
  latestProgressType: string | null
  repairPendingCount: number
  repairJobsByKind: readonly RuntimeRepairJobKindSummary[]
  sectionError: string | null
}

export const EMPTY_RUNTIME_JOBS_DIAGNOSTICS: RuntimeJobsDiagnostics = {
  visible: false,
  prepareCompleted: 0,
  prepareTotal: 0,
  prepareSources: 0,
  prepareWaitingForWorker: false,
  prepareSuspectedStuckCount: 0,
  prepareUnparseableJobCount: 0,
  etaMs: null,
  activeProfileClaims: 0,
  circuitBreakers: 0,
  circuitBreakerDetails: [],
  stagingPending: 0,
  stagingFailed: 0,
  stagingCommitted: 0,
  latestProgressType: null,
  repairPendingCount: 0,
  repairJobsByKind: [],
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

  // SPEC-6 PR6 decision 4: shared timer-handle poll loop (`usePolling`) —
  // `refreshNow` clears any pending timer, refreshes immediately, and
  // reschedules from the fresh delay, fixing the pre-existing bug where an
  // action-triggered refresh (pause/resume/cancel below) left the
  // already-scheduled timer armed alongside the extra fetch instead of
  // resetting the poll cadence (spec-5-8-post-review-findings.md:108).
  const { refreshNow } = usePolling({
    enabled: !!project,
    // Restores the pre-extraction `[project, refresh]` effect-dependency
    // behavior: switching to a DIFFERENT project restarts polling
    // immediately instead of waiting out the outgoing project's cadence.
    restartKey: project?.id ?? null,
    poll: refresh,
    getDelayMs: () => pollDelayRef.current,
  })

  async function runAction(jobId: string, action: (id: string) => Promise<RuntimeJobRecord>): Promise<void> {
    setActionJobId(jobId)
    setActionError(null)
    try {
      await action(jobId)
      await refreshNow()
    } catch (error) {
      setActionError(errorText(error))
    } finally {
      setActionJobId(null)
    }
  }

  async function cancelJob(jobId: string): Promise<void> {
    setActionJobId(jobId)
    setActionError(null)
    try {
      const cancelledJob = await runtimeJobCancel(jobId)
      if (cancelledJob.kind === DERIVED_REBUILD_JOB_KIND) {
        await releaseCancelledDerivedRebuildMarkers(cancelledJob)
      }
      await refreshNow()
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
    capturedAtMs: snapshot?.capturedAtMs ?? null,
    actionJobId,
    refreshNow,
    pauseJob: (jobId) => runAction(jobId, runtimeJobPause),
    resumeJob: (jobId) => runAction(jobId, runtimeJobResume),
    cancelJob,
  }
}

/**
 * Closeout hotfix P1 #3: cancelling a `derived-rebuild` job via
 * `runtimeJobCancel` transitions the JOB to `cancelled` but leaves its
 * claimed `runtime_derived_stale_markers` batch orphaned in `claimed`
 * forever — no consumer will ever poll a job id that no longer exists, and
 * `bucketDerivedLayerStatus` (`status.ts`) has no "claimed but abandoned"
 * state to fall back to. Release the batch to `cancelled` right after
 * (mirrors the existing `safeFailClaim` pattern in
 * `embedding-consumer.ts`/`taxonomy-consumer.ts`, but from the UI action
 * side instead of a consumer's own failure path). Best-effort: a failure
 * here must not surface as a cancel failure to the user — the job DID
 * cancel; the markers being stuck `claimed` a while longer is a lesser,
 * silently-logged problem, not a reason to make Cancel itself look broken.
 */
async function releaseCancelledDerivedRebuildMarkers(job: RuntimeJobRecord): Promise<void> {
  try {
    const { markerIds } = parseDerivedRebuildJobPayload(job.payload)
    if (markerIds.length === 0) return
    await runtimeDerivedMarkerReleaseBatch({
      jobId: job.jobId,
      markerIds,
      targetStatus: "cancelled",
    })
  } catch (err) {
    console.warn(
      `[runtime-jobs-section] failed to release cancelled derived-rebuild markers for job ${job.jobId}:`,
      err,
    )
  }
}

export function RuntimeJobsSection({ state }: { state: RuntimeJobsState }) {
  const { t } = useTranslation()
  const { list, summary, diagnostics, capturedAtMs } = state

  if (!summary.visible && !diagnostics.visible) return null

  const jobs = list?.jobs ?? []
  const visibleJobs = [...jobs]
    .sort((a, b) => b.updatedAtMs - a.updatedAtMs)
    .slice(0, 8)
  const now = capturedAtMs ?? Date.now()
  const leasesByJobId = groupLeasesByJobId(list?.leases ?? [])
  const leaseHealthByJobId = new Map<string, LeaseHealth>(
    jobs.map((job) => [job.jobId, classifyJobLeaseHealth(job, leasesByJobId.get(job.jobId) ?? [], now)]),
  )

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
            leaseHealth={leaseHealthByJobId.get(job.jobId) ?? "no-lease"}
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
  const nextBreakerDeadlineMs = diagnostics.circuitBreakerDetails.length > 0
    ? Math.min(...diagnostics.circuitBreakerDetails.map((breaker) => breaker.openUntilMs))
    : null
  const breakerCountdownMs = useCountdown(nextBreakerDeadlineMs)
  const breakerTooltip = diagnostics.circuitBreakerDetails
    .map((breaker) => {
      const remainingMs = Math.max(0, breaker.openUntilMs - Date.now())
      return t("runtimeJobs.diagnostics.breakerTooltip", {
        profile: breaker.profileId,
        reason: breakerDisplayReason(breaker),
        seconds: countdownSeconds(remainingMs),
      })
    })
    .join("\n")
  void breakerCountdownMs
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
        <span title={breakerTooltip || undefined} data-testid="runtime-diagnostics-profiles">
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
      {diagnostics.prepareSuspectedStuckCount > 0 && (
        <div className="truncate text-amber-600" data-testid="runtime-diagnostics-prepare-suspected-stuck">
          {t("runtimeJobs.diagnostics.suspectedStuck", {
            count: diagnostics.prepareSuspectedStuckCount,
          })}
        </div>
      )}
      {diagnostics.prepareUnparseableJobCount > 0 && (
        <div className="truncate text-destructive" data-testid="runtime-diagnostics-prepare-unparseable">
          {t("runtimeJobs.diagnostics.prepareUnparseable", {
            count: diagnostics.prepareUnparseableJobCount,
          })}
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
      {diagnostics.repairPendingCount > 0 && (
        <div className="truncate" data-testid="runtime-diagnostics-repair-pending">
          {t("runtimeJobs.diagnostics.repairPending", {
            count: diagnostics.repairPendingCount,
          })}
        </div>
      )}
      {diagnostics.repairJobsByKind
        .filter((entry) => entry.pendingCount > 0)
        .map((entry) => (
          <div
            key={entry.kind}
            className="truncate pl-2 text-muted-foreground/80"
            data-testid={`runtime-diagnostics-repair-pending-kind-${entry.kind}`}
          >
            {t("runtimeJobs.diagnostics.repairPendingKind", {
              kind: entry.kind,
              count: entry.pendingCount,
            })}
          </div>
        ))}
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
  leaseHealth,
  actionJobId,
  onPause,
  onResume,
  onCancel,
}: {
  job: RuntimeJobRecord
  leaseHealth: LeaseHealth
  actionJobId: string | null
  onPause: (jobId: string) => void
  onResume: (jobId: string) => void
  onCancel: (jobId: string) => void
}) {
  const { t } = useTranslation()
  const isBusy = actionJobId === job.jobId
  const isAgentChatRun = job.kind === AGENT_CHAT_RUN_JOB_KIND
  const isAgentRewindSession = job.kind === AGENT_REWIND_SESSION_JOB_KIND
  const isAgentReadOnly = isAgentChatRun || isAgentRewindSession
  const canPause = !isAgentReadOnly && (job.state === "queued" || job.state === "running")
  const canResume = !isAgentReadOnly && job.state === "paused"
  // Anchor jobs (closeout hotfix P1 #3) complete inline the same tick
  // they're created — this panel showing a Cancel button for one at all
  // would be a UI ghost, not a real action.
  const canCancel =
    !isAgentReadOnly &&
    !ANCHOR_JOB_KINDS.has(job.kind) &&
    ["queued", "running", "paused", "retry-wait"].includes(job.state)
  const isSuspectedStuck = job.state === "running" && leaseHealth === "suspected-stuck"
  const suspectedStuckLabel = isSuspectedStuck ? t("runtimeJobs.state.suspectedStuck") : null
  const Icon = isSuspectedStuck ? AlertTriangle : iconForJobState(job.state)
  const agentPayload = isAgentChatRun ? parseAgentChatRunJobPayload(job.payload) : null
  const title = isAgentRewindSession ? t("runtimeJobs.rewindTitle") : agentPayload?.title ?? job.kind

  return (
    <div className="py-1.5 text-xs" data-testid={`runtime-job-row-${job.jobId}`}>
      <div className="flex items-center gap-2">
        <div
          className="shrink-0"
          data-testid={isSuspectedStuck ? `runtime-job-row-suspected-stuck-${job.jobId}` : undefined}
          title={suspectedStuckLabel ?? undefined}
        >
          <Icon className={isSuspectedStuck ? "h-3 w-3 text-amber-500" : iconClassName(job.state)} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate font-medium">
            {title} <span className="font-mono text-[10px] text-muted-foreground">{shortJobId(job.jobId)}</span>
          </div>
          <div className="truncate text-[10px] text-muted-foreground/70">
            {t(`runtimeJobs.state.${job.state}`)}
            {suspectedStuckLabel ? ` · ${suspectedStuckLabel}` : ""} - {t("runtimeJobs.attempt", {
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
  const leasesByJobId = groupLeasesByJobId(snapshot.jobs.data?.leases ?? [])
  const now = snapshot.capturedAtMs
  const prepareJobs = jobs.filter((job) => job.kind === BULK_KNOWLEDGE_PREPARE_JOB_KIND)
  const { groups: prepareGroups, unparseable: prepareUnparseableJobs } = groupPrepareJobsByPlan(prepareJobs)
  const prepareTotal = prepareGroups.reduce((sum, group) => sum + group.batchTotal, 0)
  const prepareSources = prepareGroups.reduce((sum, group) => sum + group.uniqueSourceTotal, 0)
  const prepareCompleted = prepareGroups.reduce(
    (sum, group) => sum + Math.min(group.completed, group.batchTotal),
    0,
  )
  const prepareSuspectedStuckCount = prepareJobs.filter(
    (job) => classifyJobLeaseHealth(job, leasesByJobId.get(job.jobId) ?? [], now) === "suspected-stuck",
  ).length
  const progressRows = snapshot.progress.data?.progress ?? []
  const stagingArtifacts = snapshot.stagingArtifacts.data?.artifacts ?? []
  const sectionError = firstSectionError(snapshot)
  const activeProfileClaims = snapshot.profilePool.data?.activeClaims.length ?? 0
  const circuitBreakerDetails = snapshot.profilePool.data?.circuitBreakers ?? []
  const circuitBreakers = circuitBreakerDetails.length
  const prepareWaitingForWorker = prepareJobs.some((job) =>
    isAwaitingWorker(job, leasesByJobId.get(job.jobId) ?? []),
  )
  const repairPendingCount = snapshot.summary.repairJobPendingCount
  const repairJobsByKind = snapshot.summary.repairJobsByKind
  const diagnostics = {
    visible:
      prepareJobs.length > 0 ||
      progressRows.length > 0 ||
      stagingArtifacts.length > 0 ||
      activeProfileClaims > 0 ||
      circuitBreakers > 0 ||
      repairPendingCount > 0 ||
      Boolean(sectionError),
    prepareCompleted,
    prepareTotal,
    prepareSources,
    prepareWaitingForWorker,
    prepareSuspectedStuckCount,
    prepareUnparseableJobCount: prepareUnparseableJobs.length,
    etaMs: estimatePrepareEtaMs(prepareJobs, prepareTotal, prepareCompleted),
    activeProfileClaims,
    circuitBreakers,
    circuitBreakerDetails,
    stagingPending: stagingArtifacts.filter((artifact) => artifact.status === "pending").length,
    stagingFailed: stagingArtifacts.filter((artifact) => artifact.status === "failed").length,
    stagingCommitted: stagingArtifacts.filter((artifact) => artifact.status === "committed").length,
    latestProgressType: latestProgressType(progressRows),
    repairPendingCount,
    repairJobsByKind,
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
  readonly planId: string
  readonly batchTotal: number
  readonly uniqueSourceTotal: number
} | null {
  try {
    const payload = JSON.parse(job.payload) as Partial<BulkKnowledgePrepareJobPayload>
    if (payload.kind !== BULK_KNOWLEDGE_PREPARE_JOB_KIND || !payload.planId) {
      return null
    }
    const batchTotal = numberOrZero(payload.batchTotal)
    const uniqueSourceTotal = numberOrZero(payload.uniqueSourceTotal)
    return {
      planId: payload.planId,
      batchTotal,
      uniqueSourceTotal: uniqueSourceTotal || sourceCountFromPayload(payload.sources),
    }
  } catch {
    return null
  }
}

interface PreparePlanGroup {
  readonly planId: string
  readonly batchTotal: number
  readonly uniqueSourceTotal: number
  readonly completed: number
}

function groupPrepareJobsByPlan(prepareJobs: readonly RuntimeJobRecord[]): {
  readonly groups: readonly PreparePlanGroup[]
  readonly unparseable: readonly RuntimeJobRecord[]
} {
  const byPlanId = new Map<string, { batchTotal: number; uniqueSourceTotal: number; completed: number }>()
  const unparseable: RuntimeJobRecord[] = []

  for (const job of prepareJobs) {
    const payload = parsePreparePayload(job)
    if (!payload) {
      unparseable.push(job)
      continue
    }
    const completedDelta = job.state === "completed" ? 1 : 0
    const existing = byPlanId.get(payload.planId)
    if (existing) {
      existing.batchTotal = Math.max(existing.batchTotal, payload.batchTotal)
      existing.uniqueSourceTotal = Math.max(existing.uniqueSourceTotal, payload.uniqueSourceTotal)
      existing.completed += completedDelta
    } else {
      byPlanId.set(payload.planId, {
        batchTotal: payload.batchTotal,
        uniqueSourceTotal: payload.uniqueSourceTotal,
        completed: completedDelta,
      })
    }
  }

  const groups = Array.from(byPlanId.entries()).map(([planId, group]) => ({ planId, ...group }))
  return { groups, unparseable }
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
