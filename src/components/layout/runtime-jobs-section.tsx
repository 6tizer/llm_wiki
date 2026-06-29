import { useCallback, useEffect, useMemo, useState } from "react"
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
  runtimeJobList,
  runtimeJobPause,
  runtimeJobResume,
  type RuntimeJobList,
  type RuntimeJobRecord,
  type RuntimeJobState,
} from "@/commands/runtime-db"
import { useWikiStore } from "@/stores/wiki-store"

const POLL_INTERVAL_MS = 2_000

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
  const [listError, setListError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [actionJobId, setActionJobId] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    if (!project) {
      setList(null)
      setListError(null)
      return
    }
    try {
      const next = await runtimeJobList()
      setList(next)
      setListError(null)
    } catch (error) {
      setListError(errorText(error))
    }
  }, [project])

  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setInterval> | null = null

    async function poll(): Promise<void> {
      if (cancelled) return
      await refresh()
    }

    if (!project) {
      setList(null)
      setListError(null)
      return undefined
    }

    void poll()
    timer = setInterval(() => {
      void poll()
    }, POLL_INTERVAL_MS)

    return () => {
      cancelled = true
      if (timer) clearInterval(timer)
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

  const summary = useMemo(
    () => summarizeRuntimeJobs(list, listError ?? actionError),
    [list, listError, actionError],
  )

  return {
    list,
    summary,
    actionJobId,
    refresh,
    pauseJob: (jobId) => runAction(jobId, runtimeJobPause),
    resumeJob: (jobId) => runAction(jobId, runtimeJobResume),
    cancelJob: (jobId) => runAction(jobId, runtimeJobCancel),
  }
}

export function RuntimeJobsSection({ state }: { state: RuntimeJobsState }) {
  const { t } = useTranslation()
  const { list, summary } = state

  if (!summary.visible) return null

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
