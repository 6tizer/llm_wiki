import { AlertTriangle, CheckCircle2, ClipboardCheck, Gauge, RefreshCw, Wrench, Zap } from "lucide-react"
import { useCallback, useMemo, useState } from "react"
import { useTranslation } from "react-i18next"
import { Button } from "@/components/ui/button"
import { LintView } from "@/components/lint/lint-view"
import { useLintFixActions } from "@/components/lint/use-lint-fix-actions"
import { ReviewView } from "@/components/review/review-view"
import { DerivedStatusSection } from "@/components/settings/sections/derived-status-section"
import { IndexOverviewSection } from "@/components/settings/sections/index-overview-section"
import { MaintenanceSection } from "@/components/settings/sections/maintenance-section"
import { SynthesisSection } from "@/components/settings/sections/synthesis-section"
import { TagTaxonomySection } from "@/components/settings/sections/tag-taxonomy-section"
import { isRebuildableLayer, mintManualRebuildForLayer } from "@/lib/derived-rebuild/manual-rebuild-marker"
import { VISIBLE_DERIVED_LAYERS, type DerivedLayerBucketStatus } from "@/lib/derived-rebuild/status"
import { isFixable } from "@/lib/lint-fixer"
import { computeWikiHealthScore } from "@/lib/wiki-health-score"
import { flattenMdFiles } from "@/lib/wiki-utils"
import { useDerivedLayerStore } from "@/stores/derived-layer-store"
import { useLintStore } from "@/stores/lint-store"
import { useReviewStore } from "@/stores/review-store"
import { useWikiStore } from "@/stores/wiki-store"
import type { DerivedStaleMarkerLayer } from "@/core-runtime/contract"
import type { FileNode } from "@/types/wiki"

type WikiHealthTab = "dashboard" | "lint" | "review" | "derived" | "governance"

const WIKI_HEALTH_TABS: Array<{ id: WikiHealthTab; labelKey: string }> = [
  { id: "dashboard", labelKey: "wikiHealth.tabs.dashboard" },
  { id: "lint", labelKey: "wikiHealth.tabs.lint" },
  { id: "review", labelKey: "wikiHealth.tabs.review" },
  { id: "derived", labelKey: "wikiHealth.tabs.derived" },
  { id: "governance", labelKey: "wikiHealth.tabs.governance" },
]

interface DashboardIssue {
  id: string
  severity: "warning" | "info"
  title: string
  detail: string
  actionLabel: string
  onAction: () => void
  disabled?: boolean
}

function countWikiPages(nodes: readonly FileNode[]): number {
  const wikiRoot = nodes.find((node) => node.is_dir && node.name === "wiki")
  // `totalPages` only feeds lint report stats; a missing wiki/ tree yields a harmless 0.
  return flattenMdFiles(wikiRoot?.children ?? []).length
}

function issueBucketLabelKey(severity: DashboardIssue["severity"]): string {
  return severity === "warning" ? "wikiHealth.dashboard.severity.warning" : "wikiHealth.dashboard.severity.info"
}

function scoreTone(score: number): string {
  // Match lint report's green/yellow/red thresholds.
  if (score >= 80) return "text-emerald-600 dark:text-emerald-400"
  if (score >= 50) return "text-amber-600 dark:text-amber-400"
  return "text-destructive"
}

function layerNeedsAttention(status: DerivedLayerBucketStatus, stale: boolean): boolean {
  return status === "failed" || status === "dirty" || stale
}

export function WikiHealthView() {
  const { t } = useTranslation()
  const [activeTab, setActiveTab] = useState<WikiHealthTab>("dashboard")
  const [rebuildingLayer, setRebuildingLayer] = useState<DerivedStaleMarkerLayer | null>(null)

  const project = useWikiStore((state) => state.project)
  const fileTree = useWikiStore((state) => state.fileTree)
  const lintItems = useLintStore((state) => state.items)
  const reviewItems = useReviewStore((state) => state.items)
  const derivedBuckets = useDerivedLayerStore((state) => state.buckets)
  const {
    fixingId: fixingLintId,
    fixingAll: fixingAllLint,
    fixLintItem,
    fixAllLintItems,
  } = useLintFixActions()

  const totalPages = useMemo(() => countWikiPages(fileTree), [fileTree])
  const pendingReviewItems = useMemo(
    () => reviewItems.filter((item) => !item.resolved),
    [reviewItems],
  )
  const healthScore = useMemo(
    () => computeWikiHealthScore({
      lintItems,
      totalPages,
      derivedBuckets,
      reviewItems,
    }),
    [derivedBuckets, lintItems, reviewItems, totalPages],
  )
  const pendingReviewCount = healthScore.pendingReviewCount
  const fixableLintCount = useMemo(() => lintItems.filter(isFixable).length, [lintItems])

  const handleFixAllLint = useCallback(async () => {
    if (fixableLintCount === 0) {
      setActiveTab("lint")
      return
    }
    await fixAllLintItems({ errorLabel: "Dashboard lint fix all failed:" })
  }, [fixAllLintItems, fixableLintCount])

  const handleRebuildLayer = useCallback(async (layer: DerivedStaleMarkerLayer) => {
    if (!project || !isRebuildableLayer(layer)) {
      setActiveTab("governance")
      return
    }

    setRebuildingLayer(layer)
    try {
      const result = await mintManualRebuildForLayer(layer, project.path, `${layer}-dashboard-rebuild`)
      if (result.runtimeDisabled || (result.mintedCount === 0 && result.failedCount > 0)) {
        setActiveTab("derived")
      }
    } catch (err) {
      console.error("Dashboard derived rebuild failed:", err)
      setActiveTab("derived")
    } finally {
      setRebuildingLayer(null)
    }
  }, [project])

  const issues = useMemo<DashboardIssue[]>(() => {
    const lintIssues = lintItems.map((item): DashboardIssue => {
      const fixable = isFixable(item)
      return {
        id: `lint-${item.id}`,
        severity: item.severity,
        title: t("wikiHealth.dashboard.lintIssue", { page: item.page }),
        detail: item.detail,
        actionLabel: fixable ? t("wikiHealth.dashboard.fixNow") : t("wikiHealth.dashboard.goTo"),
        onAction: fixable
          ? () => void fixLintItem(item, { busyId: item.id, errorLabel: "Dashboard lint fix failed:" })
          : () => setActiveTab("lint"),
        disabled: fixingLintId === item.id || fixingAllLint,
      }
    })

    const derivedIssues = VISIBLE_DERIVED_LAYERS.flatMap((layer): DashboardIssue[] => {
      const bucket = derivedBuckets?.[layer]
      if (!bucket || !layerNeedsAttention(bucket.status, bucket.stale)) return []
      const rebuildable = isRebuildableLayer(layer)
      return [{
        id: `derived-${layer}`,
        severity: "warning",
        title: t("wikiHealth.dashboard.derivedIssue", {
          layer: t(`settings.sections.derivedStatus.layers.${layer}`),
          status: t(`settings.sections.derivedStatus.status.${bucket.stale ? "stale" : bucket.status}`),
        }),
        detail: t("wikiHealth.dashboard.derivedIssueDetail"),
        actionLabel: rebuildable ? t("wikiHealth.dashboard.rebuild") : t("wikiHealth.dashboard.goTo"),
        onAction: rebuildable ? () => void handleRebuildLayer(layer) : () => setActiveTab("governance"),
        disabled: rebuildingLayer === layer,
      }]
    })

    const reviewIssues = pendingReviewItems.map((item): DashboardIssue => ({
      id: `review-${item.id}`,
      severity: "info",
      title: item.title,
      detail: item.description,
      actionLabel: t("wikiHealth.dashboard.goTo"),
      onAction: () => setActiveTab("review"),
    }))

    return [...lintIssues, ...derivedIssues, ...reviewIssues]
  }, [derivedBuckets, fixLintItem, fixingAllLint, fixingLintId, handleRebuildLayer, lintItems, pendingReviewItems, rebuildingLayer, t])

  const groupedIssues = useMemo(
    () => ({
      warning: issues.filter((issue) => issue.severity === "warning"),
      info: issues.filter((issue) => issue.severity === "info"),
    }),
    [issues],
  )

  const lintBadge = lintItems.length
  const reviewBadge = pendingReviewCount

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden" data-testid="wiki-health-view">
      <div className="mx-auto flex h-full w-full max-w-6xl flex-col gap-5 px-4 py-5">
        <nav aria-label={t("wikiHealth.tabs.navLabel")} className="flex shrink-0 flex-wrap gap-1 border-b">
          {WIKI_HEALTH_TABS.map(({ id, labelKey }) => {
            const badge = id === "lint" ? lintBadge : id === "review" ? reviewBadge : 0
            return (
              <button
                key={id}
                type="button"
                aria-current={activeTab === id ? "page" : undefined}
                onClick={() => setActiveTab(id)}
                className={`inline-flex h-9 items-center gap-2 rounded-t-md px-3 text-sm transition-colors ${
                  activeTab === id
                    ? "border-b-2 border-primary text-foreground"
                    : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
                }`}
                data-testid={`wiki-health-tab-${id}`}
              >
                {t(labelKey)}
                {badge > 0 && (
                  <span className="rounded-full bg-amber-500/20 px-1.5 py-0.5 text-[11px] font-medium text-amber-700 dark:text-amber-300">
                    {badge}
                  </span>
                )}
              </button>
            )
          })}
        </nav>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {activeTab === "dashboard" && (
            <DashboardPanel
              score={healthScore.score}
              lintScore={healthScore.lintScore}
              derivedPenalty={healthScore.derivedPenalty}
              reviewPenalty={healthScore.reviewPenalty}
              totalIssues={issues.length}
              warningIssues={groupedIssues.warning}
              infoIssues={groupedIssues.info}
              fixingAll={fixingAllLint}
              fixableLintCount={fixableLintCount}
              onFixAllLint={() => void handleFixAllLint()}
              onGoLint={() => setActiveTab("lint")}
              t={t}
            />
          )}

          {activeTab === "lint" && (
            <div className="h-full min-h-0 overflow-hidden rounded-md border border-border/70">
              <LintView />
            </div>
          )}

          {activeTab === "review" && (
            <div className="h-full min-h-0 overflow-hidden rounded-md border border-border/70">
              <ReviewView />
            </div>
          )}

          {activeTab === "derived" && (
            <DerivedStatusSection project={project} onNavigate={() => setActiveTab("governance")} />
          )}

          {activeTab === "governance" && (
            <div className="space-y-8">
              <TagTaxonomySection project={project} />
              <SynthesisSection project={project} />
              <IndexOverviewSection project={project} />
              <MaintenanceSection />
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function DashboardPanel({
  score,
  lintScore,
  derivedPenalty,
  reviewPenalty,
  totalIssues,
  warningIssues,
  infoIssues,
  fixingAll,
  fixableLintCount,
  onFixAllLint,
  onGoLint,
  t,
}: {
  score: number
  lintScore: number
  derivedPenalty: number
  reviewPenalty: number
  totalIssues: number
  warningIssues: DashboardIssue[]
  infoIssues: DashboardIssue[]
  fixingAll: boolean
  fixableLintCount: number
  onFixAllLint: () => void
  onGoLint: () => void
  t: (key: string, options?: Record<string, unknown>) => string
}) {
  return (
    <div className="space-y-5" data-testid="wiki-health-dashboard">
      <section className="grid gap-4 lg:grid-cols-[280px_1fr]">
        <div className="rounded-md border border-border/70 p-5">
          <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
            <Gauge className="h-4 w-4" />
            {t("wikiHealth.dashboard.healthScore")}
          </div>
          <div className={`mt-4 text-5xl font-semibold ${scoreTone(score)}`} data-testid="wiki-health-score">
            {score}
          </div>
          <div className="mt-2 text-sm text-muted-foreground">/100</div>
        </div>

        <div className="grid gap-3 sm:grid-cols-3">
          <MetricCard label={t("wikiHealth.dashboard.lintScore")} value={lintScore} />
          <MetricCard label={t("wikiHealth.dashboard.derivedPenalty")} value={derivedPenalty} />
          <MetricCard label={t("wikiHealth.dashboard.reviewPenalty")} value={reviewPenalty} />
        </div>
      </section>

      <section className="rounded-md border border-border/70">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3">
          <div className="flex items-center gap-2">
            <ClipboardCheck className="h-4 w-4 text-muted-foreground" />
            <h2 className="text-sm font-semibold">{t("wikiHealth.dashboard.issuesFound", { count: totalIssues })}</h2>
          </div>
          <div className="flex items-center gap-2">
            {fixableLintCount > 0 && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-8 gap-1 text-xs"
                disabled={fixingAll}
                onClick={onFixAllLint}
                data-testid="wiki-health-fix-all-lint"
              >
                <Zap className="h-3.5 w-3.5" />
                {fixingAll ? t("wikiHealth.dashboard.fixing") : t("wikiHealth.dashboard.fixAll", { count: fixableLintCount })}
              </Button>
            )}
            <Button type="button" variant="ghost" size="sm" className="h-8 gap-1 text-xs" onClick={onGoLint}>
              <Wrench className="h-3.5 w-3.5" />
              {t("wikiHealth.dashboard.goToLint")}
            </Button>
          </div>
        </div>

        {totalIssues === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 px-4 py-10 text-center text-sm text-muted-foreground">
            <CheckCircle2 className="h-8 w-8 text-emerald-500/60" />
            <p className="font-medium text-emerald-600 dark:text-emerald-400">{t("wikiHealth.dashboard.noIssues")}</p>
          </div>
        ) : (
          <div className="divide-y">
            <IssueGroup severity="warning" issues={warningIssues} t={t} />
            <IssueGroup severity="info" issues={infoIssues} t={t} />
          </div>
        )}
      </section>
    </div>
  )
}

function MetricCard({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md border border-border/70 p-4">
      <div className="text-xs font-medium text-muted-foreground">{label}</div>
      <div className="mt-3 text-2xl font-semibold">{value}</div>
    </div>
  )
}

function IssueGroup({
  severity,
  issues,
  t,
}: {
  severity: DashboardIssue["severity"]
  issues: DashboardIssue[]
  t: (key: string, options?: Record<string, unknown>) => string
}) {
  if (issues.length === 0) return null
  const Icon = severity === "warning" ? AlertTriangle : ClipboardCheck
  return (
    <div className="p-4">
      <div className="mb-3 flex items-center gap-2 text-xs font-medium uppercase text-muted-foreground">
        <Icon className="h-3.5 w-3.5" />
        {t(issueBucketLabelKey(severity), { count: issues.length })}
      </div>
      <div className="space-y-2">
        {issues.map((issue) => (
          <div key={issue.id} className="flex items-start justify-between gap-3 rounded-md border border-border/60 px-3 py-2">
            <div className="min-w-0">
              <div className="truncate text-sm font-medium">{issue.title}</div>
              <div className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{issue.detail}</div>
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-8 shrink-0 gap-1 text-xs"
              disabled={issue.disabled}
              onClick={issue.onAction}
              data-testid={`wiki-health-issue-action-${issue.id}`}
            >
              {issue.disabled && <RefreshCw className="h-3.5 w-3.5 animate-spin" />}
              {issue.actionLabel}
            </Button>
          </div>
        ))}
      </div>
    </div>
  )
}
