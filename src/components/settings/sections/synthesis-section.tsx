import { useState } from "react"
import { AlertTriangle, Eye, FilePlus2, GitMerge, Loader2 } from "lucide-react"
import { useTranslation } from "react-i18next"
import { Button } from "@/components/ui/button"
import { markSynthesisRebuilt } from "@/lib/derived-rebuild/synthesis-staleness"
import {
  DEFAULT_SYNTHESIS_LIMITS,
  discoverSynthesisCandidates,
  runWikiSynthesis,
  type SynthesisCandidate,
  type SynthesisDimension,
  type SynthesisDiscoveryReport,
  type SynthesisResult,
} from "@/lib/wiki-synthesis"
import { useWikiStore } from "@/stores/wiki-store"
import type { WikiProject } from "@/types/wiki"

interface Props {
  project?: Pick<WikiProject, "path"> | null
}

type RunState = "idle" | "preview" | "generate"

const DIMENSIONS: SynthesisDimension[] = [1, 2, 3, 4]

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Number.isFinite(value) ? Math.floor(value) : min))
}

function parseDimension(value: string): SynthesisDimension {
  const parsed = Number(value)
  return parsed === 2 || parsed === 3 || parsed === 4 ? parsed : 1
}

function dimensionKey(dimension: SynthesisDimension): string {
  return `settings.sections.synthesis.dimensions.${dimension}`
}

function pageSample(candidate: SynthesisCandidate): string {
  return candidate.pages.slice(0, 3).map((page) => page.title).join(", ")
}

/** Settings section for read-only synthesis discovery and explicit candidate generation. */
export function SynthesisSection({ project }: Props) {
  const { t } = useTranslation()
  const llmConfig = useWikiStore((state) => state.llmConfig)
  const searchApiConfig = useWikiStore((state) => state.searchApiConfig)
  const [dimension, setDimension] = useState<SynthesisDimension>(DEFAULT_SYNTHESIS_LIMITS.dimension)
  const [minClusterSize, setMinClusterSize] = useState(DEFAULT_SYNTHESIS_LIMITS.minClusterSize)
  const [maxCandidates, setMaxCandidates] = useState(DEFAULT_SYNTHESIS_LIMITS.maxCandidates)
  const [running, setRunning] = useState<RunState>("idle")
  const [report, setReport] = useState<SynthesisDiscoveryReport | null>(null)
  const [result, setResult] = useState<SynthesisResult | null>(null)
  const [errorMessage, setErrorMessage] = useState("")

  const disabled = !project || running !== "idle"

  async function preview(): Promise<void> {
    if (!project || disabled) return
    setRunning("preview")
    setErrorMessage("")
    setResult(null)
    setReport(null)
    try {
      const next = await discoverSynthesisCandidates(project.path, {
        dimension,
        minClusterSize,
        maxCandidates,
      })
      setReport(next)
    } catch {
      setErrorMessage(t("settings.sections.synthesis.previewFailed"))
    } finally {
      setRunning("idle")
    }
  }

  async function generate(candidate: SynthesisCandidate): Promise<void> {
    if (!project || disabled) return
    setRunning("generate")
    setErrorMessage("")
    setResult(null)
    try {
      const next = await runWikiSynthesis(project.path, llmConfig, searchApiConfig, {
        dimension,
        targetTags: candidate.tags,
        minClusterSize,
        maxCandidates,
      })
      setResult(next)
      if (!next.ok) {
        setErrorMessage(next.error ?? t("settings.sections.synthesis.generateFailed"))
      } else {
        // SPEC-6 PR3+4 decision 4: close the pending "synthesis" derived
        // marker loop for this cluster's source pages now that the manual
        // regenerate succeeded (the consumer for this layer IS this manual
        // action — no background poller). Best-effort: a bookkeeping
        // failure here must never surface as a synthesis-generate failure,
        // since the wiki page was already written successfully. The stale
        // badge UI itself is deferred to PR6.
        try {
          await markSynthesisRebuilt(candidate)
        } catch (err) {
          console.warn("[SynthesisSection] markSynthesisRebuilt failed:", err)
        }
      }
    } catch {
      setErrorMessage(t("settings.sections.synthesis.generateFailed"))
    } finally {
      setRunning("idle")
    }
  }

  const emptyText = report && report.candidates.length === 0
    ? report.suggestedDimension
      ? t("settings.sections.synthesis.emptyDowngrade", {
          dimension: t(dimensionKey(report.suggestedDimension)),
        })
      : t(`settings.sections.synthesis.emptyReasons.${report.emptyReason ?? "no_cluster_meets_minimum"}`)
    : ""

  return (
    <div className="space-y-6" data-testid="synthesis-section">
      <div>
        <h2 className="text-xl font-semibold">
          {t("settings.sections.synthesis.title")}
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("settings.sections.synthesis.description")}
        </p>
      </div>

      {!project && (
        <div className="flex items-start gap-2 rounded-md border border-border/70 bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
          <GitMerge className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{t("settings.sections.synthesis.noProject")}</span>
        </div>
      )}

      <div className="grid gap-3 text-sm md:grid-cols-3">
        <label className="space-y-1">
          <span className="text-xs text-muted-foreground">{t("settings.sections.synthesis.dimension")}</span>
          <select
            value={dimension}
            disabled={disabled}
            onChange={(event) => setDimension(parseDimension(event.currentTarget.value))}
            data-testid="synthesis-dimension"
            className="h-9 w-full rounded-md border border-input bg-background px-2"
          >
            {DIMENSIONS.map((item) => (
              <option key={item} value={item}>{t(dimensionKey(item))}</option>
            ))}
          </select>
        </label>
        <label className="space-y-1">
          <span className="text-xs text-muted-foreground">{t("settings.sections.synthesis.minClusterSize")}</span>
          <input
            type="number"
            min={1}
            max={DEFAULT_SYNTHESIS_LIMITS.maxClusterSizeLimit}
            value={minClusterSize}
            disabled={disabled}
            onChange={(event) => setMinClusterSize(clampNumber(
              Number(event.currentTarget.value),
              1,
              DEFAULT_SYNTHESIS_LIMITS.maxClusterSizeLimit,
            ))}
            data-testid="synthesis-min-cluster-size"
            className="h-9 w-full rounded-md border border-input bg-background px-2"
          />
        </label>
        <label className="space-y-1">
          <span className="text-xs text-muted-foreground">{t("settings.sections.synthesis.maxCandidates")}</span>
          <input
            type="number"
            min={1}
            max={DEFAULT_SYNTHESIS_LIMITS.maxCandidatesLimit}
            value={maxCandidates}
            disabled={disabled}
            onChange={(event) => setMaxCandidates(clampNumber(
              Number(event.currentTarget.value),
              1,
              DEFAULT_SYNTHESIS_LIMITS.maxCandidatesLimit,
            ))}
            data-testid="synthesis-max-candidates"
            className="h-9 w-full rounded-md border border-input bg-background px-2"
          />
        </label>
      </div>

      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="outline"
          disabled={disabled}
          onClick={() => void preview()}
          data-testid="synthesis-preview"
        >
          {running === "preview" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Eye className="mr-2 h-4 w-4" />}
          {t("settings.sections.synthesis.preview")}
        </Button>
      </div>

      {errorMessage && (
        <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-800 dark:text-amber-200">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{errorMessage}</span>
        </div>
      )}

      {report && (
        <div className="space-y-3" data-testid="synthesis-report">
          <div className="grid grid-cols-2 gap-3 text-sm md:grid-cols-4">
            <div className="rounded-md border border-border/70 px-3 py-2">
              <div className="text-xs text-muted-foreground">{t("settings.sections.synthesis.pages")}</div>
              <div className="font-medium" data-testid="synthesis-scanned-pages">{report.scannedPages}</div>
            </div>
            <div className="rounded-md border border-border/70 px-3 py-2">
              <div className="text-xs text-muted-foreground">{t("settings.sections.synthesis.candidates")}</div>
              <div className="font-medium" data-testid="synthesis-total-candidates">{report.totalCandidates}</div>
            </div>
            <div className="rounded-md border border-border/70 px-3 py-2">
              <div className="text-xs text-muted-foreground">{t("settings.sections.synthesis.returned")}</div>
              <div className="font-medium" data-testid="synthesis-returned-candidates">{report.returnedCandidates}</div>
            </div>
            <div className="rounded-md border border-border/70 px-3 py-2">
              <div className="text-xs text-muted-foreground">{t("settings.sections.synthesis.truncated")}</div>
              <div className="font-medium" data-testid="synthesis-truncated-count">{report.truncatedCount}</div>
            </div>
          </div>

          {emptyText && (
            <div className="rounded-md border border-border/70 bg-muted/30 px-3 py-2 text-sm text-muted-foreground" data-testid="synthesis-empty">
              {emptyText}
            </div>
          )}

          {report.candidates.length > 0 && (
            <div className="space-y-2" data-testid="synthesis-candidates">
              {report.candidates.map((candidate, index) => (
                <div key={candidate.slug} className="flex items-center justify-between gap-3 rounded-md border border-border/70 px-3 py-2">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium" data-testid={`synthesis-candidate-topic-${index}`}>
                      {candidate.topic}
                    </div>
                    <div className="truncate text-xs text-muted-foreground">
                      {t("settings.sections.synthesis.candidateMeta", {
                        count: candidate.pageCount,
                        pages: pageSample(candidate),
                      })}
                    </div>
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    disabled={disabled}
                    onClick={() => void generate(candidate)}
                    data-testid={`synthesis-generate-${index}`}
                  >
                    {running === "generate" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <FilePlus2 className="mr-2 h-4 w-4" />}
                    {t("settings.sections.synthesis.generate")}
                  </Button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {result?.ok && (
        <div className="rounded-md border border-border/70 px-3 py-2 text-sm" data-testid="synthesis-generate-result">
          {t("settings.sections.synthesis.generated", { path: result.synthesisPath })}
        </div>
      )}
    </div>
  )
}
