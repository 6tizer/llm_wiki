import { useCallback, useState } from "react"
import { useTranslation } from "react-i18next"
import { AlertTriangle, CheckCircle2, Clock, Loader2, RefreshCw, XCircle } from "lucide-react"
import { Button } from "@/components/ui/button"
import { usePolling } from "@/lib/hooks/use-polling"
import { persistSetting } from "@/lib/store-helpers"
import { useDerivedLayerStore } from "@/stores/derived-layer-store"
import { isRebuildableLayer, mintManualRebuildForLayer } from "@/lib/derived-rebuild/manual-rebuild-marker"
import { VISIBLE_DERIVED_LAYERS, type DerivedLayerBucket, type DerivedLayerBucketStatus } from "@/lib/derived-rebuild/status"
import type { DerivedStaleMarkerLayer } from "@/core-runtime/contract"
import type { WikiProject } from "@/types/wiki"

const POLL_INTERVAL_MS = 5_000

interface Props {
  project?: Pick<WikiProject, "id" | "path"> | null
  onNavigate?: () => void
}

function readyBucket(layer: DerivedStaleMarkerLayer): DerivedLayerBucket {
  return { layer, status: "ready", stale: false, lastRebuiltAtMs: null }
}

/**
 * SPEC-6 PR6 decision 6: one status card per visible derived layer, sourced
 * from `useDerivedLayerStore` (single full-snapshot fetch, decision 3).
 * `embedding`/`taxonomy` get a Rebuild button (decision 5's mint-only manual
 * rebuild); `synthesis`/`index_export`/`overview` point at the governance
 * workbench instead of duplicating rebuild controls.
 */
export function DerivedStatusSection({ project, onNavigate }: Props) {
  const { t } = useTranslation()
  const buckets = useDerivedLayerStore((state) => state.buckets)
  const error = useDerivedLayerStore((state) => state.error)
  const runtimeDisabled = useDerivedLayerStore((state) => state.runtimeDisabled)
  const loadSnapshot = useDerivedLayerStore((state) => state.loadSnapshot)

  // Mirror `runtime-jobs-section.tsx`'s `refresh`: without a project, clear
  // any stale snapshot instead of calling `loadSnapshot` (which has no
  // project to scope its fetch to).
  const poll = useCallback(async () => {
    if (!project) {
      useDerivedLayerStore.setState({ buckets: null, capturedAtMs: null, error: null, runtimeDisabled: false })
      return
    }
    await loadSnapshot()
  }, [project, loadSnapshot])

  usePolling({
    enabled: !!project,
    // Switching to a different project restarts polling immediately
    // instead of waiting out the outgoing project's cadence. `id` (not
    // `path`) matches `runtime-jobs-section.tsx` and stays stable if the
    // user moves/renames the project directory (types/wiki.ts:2-4).
    restartKey: project?.id ?? null,
    poll,
    getDelayMs: () => POLL_INTERVAL_MS,
  })

  if (project && runtimeDisabled) {
    return null
  }

  return (
    <div className="space-y-6" data-testid="derived-status-section">
      <div>
        <h2 className="text-xl font-semibold">{t("settings.sections.derivedStatus.title")}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{t("settings.sections.derivedStatus.description")}</p>
      </div>

      {!project && (
        <div className="flex items-start gap-2 rounded-md border border-border/70 bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{t("settings.sections.derivedStatus.noProject")}</span>
        </div>
      )}

      {project && error && (
        <div
          className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-800 dark:text-amber-200"
          data-testid="derived-status-error"
        >
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{t("settings.sections.derivedStatus.loadFailed", { error })}</span>
        </div>
      )}

      {project &&
        VISIBLE_DERIVED_LAYERS.map((layer) => (
          <LayerCard
            key={layer}
            layer={layer}
            bucket={buckets?.[layer] ?? readyBucket(layer)}
            projectPath={project.path}
            onNavigate={onNavigate}
          />
        ))}
    </div>
  )
}

function LayerCard({
  layer,
  bucket,
  projectPath,
  onNavigate,
}: {
  layer: DerivedStaleMarkerLayer
  bucket: DerivedLayerBucket
  projectPath: string
  onNavigate?: () => void
}) {
  const { t } = useTranslation()
  const [running, setRunning] = useState(false)
  const [resultText, setResultText] = useState("")
  const [errorText, setErrorText] = useState("")

  const canRebuild = isRebuildableLayer(layer)

  /**
   * Optimistic "building" badge (internal-review P2, accepted trade-off):
   * `mintManualRebuildForLayer` only mints `pending` markers (decision 5 —
   * embedding/taxonomy don't claim, the background poller does), so the
   * REAL status right after a successful mint is `dirty`, not `building`.
   * The next poll tick (`POLL_INTERVAL_MS`, well under `embedding-consumer`/
   * `taxonomy-consumer`'s own ~3s tick) will briefly correct the badge back
   * to `dirty` before the consumer actually claims the marker and it
   * flips to the REAL `building`. This click -> building -> (poll)
   * dirty -> (consumer tick) building sequence is a small, self-healing
   * flicker window, not a bug — kept as-is rather than suppressing the
   * optimistic badge, since instant feedback on click is worth a few
   * seconds of a "too early" badge that then self-corrects twice.
   */
  async function handleRebuild(): Promise<void> {
    if (running || !isRebuildableLayer(layer)) return
    setRunning(true)
    setResultText("")
    setErrorText("")
    const prevBucket = bucket
    const optimisticBucket: DerivedLayerBucket = { ...bucket, status: "building", stale: false }

    await persistSetting(
      prevBucket,
      optimisticBucket,
      (value) => useDerivedLayerStore.getState().setLayerBucket(layer, value),
      async () => {
        const result = await mintManualRebuildForLayer(layer, projectPath, `${layer}-manual-rebuild`)
        if (result.runtimeDisabled) {
          throw new Error(t("settings.sections.derivedStatus.rebuildFailed"))
        }
        if (result.mintedCount === 0 && result.failedCount > 0) {
          throw new Error(t("settings.sections.derivedStatus.rebuildFailed"))
        }
        setResultText(t("settings.sections.derivedStatus.rebuildQueued", { count: result.mintedCount }))
      },
      () => useDerivedLayerStore.getState().buckets?.[layer] ?? prevBucket,
      { onError: (err) => setErrorText(err instanceof Error ? err.message : String(err)) },
    )
    setRunning(false)
  }

  return (
    <div className="space-y-2 rounded-md border border-border/70 p-4" data-testid={`derived-status-card-${layer}`}>
      <div className="flex items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-medium">{t(`settings.sections.derivedStatus.layers.${layer}`)}</h3>
          <p className="mt-0.5 text-xs text-muted-foreground">{formatLastRebuilt(t, bucket.lastRebuiltAtMs)}</p>
        </div>
        <StatusBadge status={bucket.status} stale={bucket.stale} lastRebuiltAtMs={bucket.lastRebuiltAtMs} />
      </div>

      {canRebuild && (
        <div className="flex items-center gap-2">
          <Button
            type="button"
            size="sm"
            disabled={running}
            onClick={() => void handleRebuild()}
            data-testid={`derived-status-rebuild-${layer}`}
          >
            {running ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="mr-2 h-3.5 w-3.5" />}
            {t("settings.sections.derivedStatus.rebuild")}
          </Button>
        </div>
      )}

      {!canRebuild && onNavigate && (
        <button
          type="button"
          onClick={onNavigate}
          className="text-xs text-primary underline-offset-2 hover:underline"
          data-testid={`derived-status-navigate-${layer}`}
        >
          {t("settings.sections.derivedStatus.manageIn", { section: t("wikiHealth.tabs.governance") })}
        </button>
      )}

      {resultText && (
        <div className="rounded-md border border-border/70 px-3 py-2 text-xs" data-testid={`derived-status-result-${layer}`}>
          {resultText}
        </div>
      )}
      {errorText && (
        <div
          className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-200"
          data-testid={`derived-status-card-error-${layer}`}
        >
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{errorText}</span>
        </div>
      )}
    </div>
  )
}

function StatusBadge({
  status,
  stale,
  lastRebuiltAtMs,
}: {
  status: DerivedLayerBucketStatus
  stale: boolean
  lastRebuiltAtMs: number | null
}) {
  const { t } = useTranslation()
  const neverBuilt = status === "ready" && lastRebuiltAtMs === null
  const displayKey = neverBuilt ? "uninitialized" : stale ? "stale" : status
  const Icon = iconForStatus(status)
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ${colorForStatus(status)}`}
      data-testid={`derived-status-badge-${displayKey}`}
    >
      <Icon className={`h-3 w-3 ${status === "building" ? "animate-spin" : ""}`} />
      {t(`settings.sections.derivedStatus.status.${displayKey}`)}
    </span>
  )
}

function iconForStatus(status: DerivedLayerBucketStatus) {
  if (status === "building") return Loader2
  if (status === "failed") return XCircle
  if (status === "dirty") return Clock
  return CheckCircle2
}

function colorForStatus(status: DerivedLayerBucketStatus): string {
  if (status === "building") return "bg-blue-500/10 text-blue-700 dark:text-blue-300"
  if (status === "failed") return "bg-destructive/10 text-destructive"
  if (status === "dirty") return "bg-amber-500/10 text-amber-700 dark:text-amber-300"
  return "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
}

function formatLastRebuilt(t: (key: string, opts?: Record<string, unknown>) => string, atMs: number | null): string {
  if (atMs === null) return t("settings.sections.derivedStatus.neverRebuilt")
  return t("settings.sections.derivedStatus.lastRebuilt", { time: new Date(atMs).toLocaleString() })
}
