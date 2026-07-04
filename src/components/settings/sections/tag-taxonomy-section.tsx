import { useEffect, useMemo, useState } from "react"
import { AlertTriangle, Loader2, Tags } from "lucide-react"
import { useTranslation } from "react-i18next"
import { Button } from "@/components/ui/button"
import {
  applyTagTaxonomyBootstrap,
  applyTagTaxonomyGrowth,
  defaultTagTaxonomy,
  loadTagTaxonomy,
  previewTagTaxonomyBootstrap,
  previewTagTaxonomyGrowth,
  rollbackLastTagTaxonomyBatch,
  type TagTaxonomyIssue,
  type TagTaxonomyOperationReport,
  type TagTaxonomyRoot,
} from "@/lib/agent/tag-taxonomy"
import { useProjectPersistedResource } from "@/lib/use-project-persisted-resource"
import type { WikiProject } from "@/types/wiki"

interface Props {
  project?: Pick<WikiProject, "path"> | null
  now?: () => number
}

interface TaxonomyResource {
  taxonomy: TagTaxonomyRoot
  issues: TagTaxonomyIssue[]
  conflict: boolean
}

function fallbackTaxonomyResource(): TaxonomyResource {
  return { taxonomy: defaultTagTaxonomy(), issues: [], conflict: false }
}

type ActionKind =
  | "previewBootstrap"
  | "applyBootstrap"
  | "previewGrowth"
  | "applyGrowth"
  | "rollback"

function statusDate(updatedAt: number): string {
  return updatedAt > 0 ? new Date(updatedAt).toLocaleString() : "-"
}

function warningText(
  t: ReturnType<typeof useTranslation>["t"],
  issues: TagTaxonomyIssue[],
  conflict: boolean,
): string {
  if (conflict) return t("settings.sections.tagTaxonomy.futureSchema")
  if (issues.some((issue) => issue.code === "bad_json")) {
    return t("settings.sections.tagTaxonomy.loadFailed")
  }
  if (issues.length > 0) return t("settings.sections.tagTaxonomy.configIssue")
  return ""
}

function actionLabelKey(action: ActionKind): string {
  return `settings.sections.tagTaxonomy.actions.${action}`
}

function reportActionLabelKey(action: TagTaxonomyOperationReport["action"]): string {
  return `settings.sections.tagTaxonomy.reportActions.${action}`
}

function reportStatusKey(report: TagTaxonomyOperationReport): string {
  if (report.dryRun) return "settings.sections.tagTaxonomy.report.preview"
  if (report.wrote) return "settings.sections.tagTaxonomy.report.wrote"
  if (report.added === 0 && report.removed === 0) {
    return "settings.sections.tagTaxonomy.report.noChanges"
  }
  return "settings.sections.tagTaxonomy.report.notWritten"
}

/** Settings page section for project-level tag taxonomy governance. */
export function TagTaxonomySection({ project, now }: Props) {
  const { t } = useTranslation()
  const projectPath = project?.path
  const { state: loaded, loading, error: loadError } = useProjectPersistedResource<TaxonomyResource>(
    projectPath,
    loadTagTaxonomy,
    fallbackTaxonomyResource(),
  )
  const [draft, setDraft] = useState<TaxonomyResource>(loaded)
  const [running, setRunning] = useState<ActionKind | null>(null)
  const [report, setReport] = useState<TagTaxonomyOperationReport | null>(null)
  const [errorMessage, setErrorMessage] = useState("")

  // Re-sync the editable draft every time the hook lands a fresh
  // load — project cleared, project switched, or the initial load for
  // the current project resolving/rejecting. `report` only resets on
  // "project cleared" and `errorMessage` only reflects a load failure
  // while a project is active, matching the hand-rolled effect this
  // hook replaced.
  useEffect(() => {
    setDraft(loaded)
    if (!projectPath) {
      setReport(null)
    }
    setErrorMessage(projectPath && loadError ? t("settings.sections.tagTaxonomy.loadFailed") : "")
  }, [loaded, loadError, projectPath, t])

  async function refresh(projectPath: string): Promise<void> {
    const result = await loadTagTaxonomy(projectPath)
    setDraft(result)
  }

  const disabled = !project || loading || draft.conflict || running !== null
  const alertMessage = errorMessage || warningText(t, draft.issues, draft.conflict)
  const nodeCount = useMemo(() => countNodes(draft.taxonomy.tree), [draft.taxonomy.tree])
  const batchCount = draft.taxonomy.changeLog.filter((entry) =>
    entry.action === "bootstrap" || entry.action === "growth"
  ).length

  async function runAction(action: ActionKind) {
    if (!project || disabled) return
    setRunning(action)
    setErrorMessage("")
    try {
      const options = { now }
      const result = action === "previewBootstrap"
        ? await previewTagTaxonomyBootstrap(project.path, options)
        : action === "applyBootstrap"
          ? await applyTagTaxonomyBootstrap(project.path, options)
          : action === "previewGrowth"
            ? await previewTagTaxonomyGrowth(project.path, options)
            : action === "applyGrowth"
              ? await applyTagTaxonomyGrowth(project.path, options)
              : await rollbackLastTagTaxonomyBatch(project.path, options)
      setReport(result)
      if (action === "applyBootstrap" || action === "applyGrowth" || action === "rollback") {
        await refresh(project.path)
      }
    } catch {
      setErrorMessage(t("settings.sections.tagTaxonomy.actionFailed"))
    } finally {
      setRunning(null)
    }
  }

  return (
    <div className="space-y-6" data-testid="tag-taxonomy-section">
      <div>
        <h2 className="text-xl font-semibold">
          {t("settings.sections.tagTaxonomy.title")}
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("settings.sections.tagTaxonomy.description")}
        </p>
      </div>

      {!project && (
        <div className="flex items-start gap-2 rounded-md border border-border/70 bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
          <Tags className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{t("settings.sections.tagTaxonomy.noProject")}</span>
        </div>
      )}

      {loading && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          <span>{t("settings.sections.tagTaxonomy.loading")}</span>
        </div>
      )}

      {alertMessage && (
        <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-800 dark:text-amber-200">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{alertMessage}</span>
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 text-sm">
        <div className="rounded-md border border-border/70 px-3 py-2">
          <div className="text-xs text-muted-foreground">{t("settings.sections.tagTaxonomy.nodes")}</div>
          <div className="font-medium" data-testid="tag-taxonomy-node-count">{nodeCount}</div>
        </div>
        <div className="rounded-md border border-border/70 px-3 py-2">
          <div className="text-xs text-muted-foreground">{t("settings.sections.tagTaxonomy.batches")}</div>
          <div className="font-medium" data-testid="tag-taxonomy-batch-count">{batchCount}</div>
        </div>
        <div className="rounded-md border border-border/70 px-3 py-2">
          <div className="text-xs text-muted-foreground">{t("settings.sections.tagTaxonomy.updatedAt")}</div>
          <div className="truncate font-medium" data-testid="tag-taxonomy-updated-at">
            {statusDate(draft.taxonomy.updatedAt)}
          </div>
        </div>
        <div className="rounded-md border border-border/70 px-3 py-2">
          <div className="text-xs text-muted-foreground">{t("settings.sections.tagTaxonomy.issues")}</div>
          <div className="font-medium" data-testid="tag-taxonomy-issue-count">{draft.issues.length}</div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2">
        {(["previewBootstrap", "applyBootstrap", "previewGrowth", "applyGrowth", "rollback"] as const).map((action) => (
          <Button
            key={action}
            type="button"
            variant={action.startsWith("apply") ? "default" : "outline"}
            disabled={disabled}
            onClick={() => void runAction(action)}
            data-testid={`tag-taxonomy-${action}`}
            className={action === "rollback" ? "col-span-2" : undefined}
          >
            {running === action ? t("settings.sections.tagTaxonomy.running") : t(actionLabelKey(action))}
          </Button>
        ))}
      </div>

      {report && (
        <div className="space-y-2 rounded-md border border-border/70 px-3 py-3 text-sm" data-testid="tag-taxonomy-report">
          <div className="font-medium">
            {t("settings.sections.tagTaxonomy.reportTitle", {
              action: t(reportActionLabelKey(report.action)),
            })}
          </div>
          <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-muted-foreground">
            <span>{t("settings.sections.tagTaxonomy.report.added", { count: report.added })}</span>
            <span>{t("settings.sections.tagTaxonomy.report.removed", { count: report.removed })}</span>
            <span>{t("settings.sections.tagTaxonomy.report.truncated", { count: report.truncated })}</span>
            <span>{t("settings.sections.tagTaxonomy.report.skipped", { count: report.skipped })}</span>
            <span>{t("settings.sections.tagTaxonomy.report.pages", { count: report.counts.pagesWithFrontmatter })}</span>
            <span>{t(reportStatusKey(report))}</span>
          </div>
          {report.details.length > 0 && (
            <ul className="max-h-36 space-y-1 overflow-auto text-xs text-muted-foreground">
              {report.details.slice(0, 8).map((item, index) => (
                <li key={`${item.code}-${index}`}>{item.path ? `${item.path}: ` : ""}{item.message}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}

function countNodes(nodes: readonly TagTaxonomyRoot["tree"][number][]): number {
  return nodes.reduce((sum, node) => sum + 1 + countNodes(node.children ?? []), 0)
}
