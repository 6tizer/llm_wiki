import { useState } from "react"
import { AlertTriangle, FileText, Layers, Loader2 } from "lucide-react"
import { useTranslation } from "react-i18next"
import { Button } from "@/components/ui/button"
import { hasUsableLlm } from "@/lib/has-usable-llm"
import { rebuildIndexExport, type IndexExportRebuildResult } from "@/lib/derived-rebuild/index-export"
import { rebuildOverview, type OverviewRebuildResult } from "@/lib/derived-rebuild/overview-rebuild"
import { useWikiStore } from "@/stores/wiki-store"
import type { WikiProject } from "@/types/wiki"

interface Props {
  project?: Pick<WikiProject, "path"> | null
}

type RunState = "idle" | "index" | "overview"

/**
 * SPEC-6 PR5 decision 4: settings section for the two manual-rebuild
 * layers with no background consumer — `index_export` (deterministic wiki
 * index scan) and `overview` (single LLM call). Two independent cards, one
 * shared `running` lock (both write into the wiki tree, so only one runs
 * at a time) — loading/error/disabled conventions照 synthesis-section.tsx.
 */
export function IndexOverviewSection({ project }: Props) {
  const { t } = useTranslation()
  const llmConfig = useWikiStore((state) => state.llmConfig)
  const [running, setRunning] = useState<RunState>("idle")
  const [indexResult, setIndexResult] = useState<IndexExportRebuildResult | null>(null)
  const [indexError, setIndexError] = useState("")
  const [overviewResult, setOverviewResult] = useState<OverviewRebuildResult | null>(null)
  const [overviewError, setOverviewError] = useState("")

  const disabled = !project || running !== "idle"
  const llmUsable = hasUsableLlm(llmConfig)

  async function runIndexExport(): Promise<void> {
    if (!project || disabled) return
    setRunning("index")
    setIndexError("")
    setIndexResult(null)
    try {
      const next = await rebuildIndexExport(project.path)
      setIndexResult(next)
    } catch {
      setIndexError(t("settings.sections.indexOverview.indexFailed"))
    } finally {
      setRunning("idle")
    }
  }

  async function runOverview(): Promise<void> {
    if (!project || disabled || !llmUsable) return
    setRunning("overview")
    setOverviewError("")
    setOverviewResult(null)
    try {
      const next = await rebuildOverview(project.path, llmConfig)
      setOverviewResult(next)
    } catch {
      setOverviewError(t("settings.sections.indexOverview.overviewFailed"))
    } finally {
      setRunning("idle")
    }
  }

  return (
    <div className="space-y-6" data-testid="index-overview-section">
      <div>
        <h2 className="text-xl font-semibold">{t("settings.sections.indexOverview.title")}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{t("settings.sections.indexOverview.description")}</p>
      </div>

      {!project && (
        <div className="flex items-start gap-2 rounded-md border border-border/70 bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{t("settings.sections.indexOverview.noProject")}</span>
        </div>
      )}

      <div className="space-y-3 rounded-md border border-border/70 p-4" data-testid="index-export-card">
        <div>
          <h3 className="text-sm font-medium">{t("settings.sections.indexOverview.indexTitle")}</h3>
          <p className="mt-1 text-xs text-muted-foreground">{t("settings.sections.indexOverview.indexDescription")}</p>
        </div>
        <Button
          type="button"
          disabled={disabled}
          onClick={() => void runIndexExport()}
          data-testid="index-export-rebuild"
        >
          {running === "index" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Layers className="mr-2 h-4 w-4" />}
          {t("settings.sections.indexOverview.rebuild")}
        </Button>
        {indexError && (
          <div
            className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-800 dark:text-amber-200"
            data-testid="index-export-error"
          >
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{indexError}</span>
          </div>
        )}
        {indexResult && (
          <div className="rounded-md border border-border/70 px-3 py-2 text-sm" data-testid="index-export-result">
            {t("settings.sections.indexOverview.indexRebuilt", { count: indexResult.pageCount })}
          </div>
        )}
      </div>

      <div className="space-y-3 rounded-md border border-border/70 p-4" data-testid="overview-card">
        <div>
          <h3 className="text-sm font-medium">{t("settings.sections.indexOverview.overviewTitle")}</h3>
          <p className="mt-1 text-xs text-muted-foreground">{t("settings.sections.indexOverview.overviewDescription")}</p>
        </div>
        {!llmUsable && (
          <div
            className="flex items-start gap-2 rounded-md border border-border/70 bg-muted/30 px-3 py-2 text-sm text-muted-foreground"
            data-testid="overview-no-llm"
          >
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{t("settings.sections.indexOverview.noLlm")}</span>
          </div>
        )}
        <Button
          type="button"
          disabled={disabled || !llmUsable}
          onClick={() => void runOverview()}
          data-testid="overview-rebuild"
        >
          {running === "overview" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <FileText className="mr-2 h-4 w-4" />}
          {t("settings.sections.indexOverview.rebuild")}
        </Button>
        {overviewError && (
          <div
            className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-800 dark:text-amber-200"
            data-testid="overview-error"
          >
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{overviewError}</span>
          </div>
        )}
        {overviewResult && (
          <div className="rounded-md border border-border/70 px-3 py-2 text-sm" data-testid="overview-result">
            {t("settings.sections.indexOverview.overviewRebuilt", { path: overviewResult.path })}
          </div>
        )}
      </div>
    </div>
  )
}
