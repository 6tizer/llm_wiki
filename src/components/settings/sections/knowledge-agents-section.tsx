import { useEffect, useState } from "react"
import { AlertTriangle, Bot, Loader2 } from "lucide-react"
import { useTranslation } from "react-i18next"
import { Button } from "@/components/ui/button"
import {
  KNOWLEDGE_AGENT_IDS,
  type KnowledgeAgentsConfig,
  type KnowledgeAgentsConfigIssue,
  defaultKnowledgeAgentsConfig,
  loadKnowledgeAgentsConfig,
  saveKnowledgeAgentsConfig,
} from "@/lib/agent/knowledge-agents-config"
import { GUIDANCE_MAX_LENGTH, isPromptCapableAgent } from "@/lib/agent/prompt-registry"
import { useProjectPersistedResource } from "@/lib/use-project-persisted-resource"
import type { WikiProject } from "@/types/wiki"

interface Props {
  project?: Pick<WikiProject, "path"> | null
  now?: () => number
}

interface KnowledgeAgentsResource {
  config: KnowledgeAgentsConfig
  issues: KnowledgeAgentsConfigIssue[]
  conflict: boolean
}

function fallbackKnowledgeAgentsResource(): KnowledgeAgentsResource {
  return { config: defaultKnowledgeAgentsConfig(), issues: [], conflict: false }
}

function warningText(
  t: ReturnType<typeof useTranslation>["t"],
  issues: KnowledgeAgentsConfigIssue[],
  conflict: boolean,
): string {
  if (conflict) return t("settings.sections.knowledgeAgents.futureSchema")
  if (issues.length > 0) return t("settings.sections.knowledgeAgents.configIssue")
  return ""
}

function hasIssueCode(
  issues: KnowledgeAgentsConfigIssue[],
  code: KnowledgeAgentsConfigIssue["code"],
): boolean {
  return issues.some((issue) => issue.code === code)
}

/** Settings page section for project-level Knowledge Agents config. */
export function KnowledgeAgentsSection({ project, now }: Props) {
  const { t } = useTranslation()
  const { state: loaded, loading } = useProjectPersistedResource<KnowledgeAgentsResource>(
    project?.path,
    loadKnowledgeAgentsConfig,
    fallbackKnowledgeAgentsResource(),
  )
  const [draft, setDraft] = useState<KnowledgeAgentsResource>(loaded)
  const [loadedUpdatedAt, setLoadedUpdatedAt] = useState<number>(0)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [conflictMessage, setConflictMessage] = useState("")
  const [saveErrorMessage, setSaveErrorMessage] = useState("")

  // Re-sync the editable draft every time the hook lands a fresh load
  // — project cleared, project switched, or the initial load for the
  // current project resolving/rejecting — discarding any in-progress
  // edit, exactly like the hand-rolled effect this hook replaced.
  useEffect(() => {
    setDraft(loaded)
    setLoadedUpdatedAt(loaded.config.updatedAt)
    setConflictMessage("")
    setSaveErrorMessage("")
  }, [loaded])

  const disabled = !project || loading || draft.conflict || saving
  const configWarning = warningText(t, draft.issues, draft.conflict)
  const alertMessage = conflictMessage || (draft.conflict ? configWarning : saveErrorMessage || configWarning)

  function patchAgent(
    id: typeof KNOWLEDGE_AGENT_IDS[number],
    patch: Partial<{ enabled: boolean; autoRun: boolean; guidance: string }>,
  ) {
    setSaved(false)
    setConflictMessage("")
    setSaveErrorMessage("")
    setDraft((prev) => ({
      ...prev,
      config: {
        ...prev.config,
        agents: {
          ...prev.config.agents,
          [id]: {
            ...prev.config.agents[id],
            ...patch,
          },
        },
      },
    }))
  }

  async function handleSave() {
    if (!project || disabled) return

    setSaving(true)
    setSaved(false)
    setConflictMessage("")
    setSaveErrorMessage("")

    try {
      const result = await saveKnowledgeAgentsConfig(project.path, draft.config, {
        expectedUpdatedAt: loadedUpdatedAt,
        now,
      })

      if (!result.saved) {
        const stale = hasIssueCode(result.issues, "stale_updated_at")
        setDraft({
          config: result.config,
          issues: result.issues,
          conflict: stale ? false : result.conflict,
        })
        if (stale) {
          setLoadedUpdatedAt(result.config.updatedAt)
          setConflictMessage(t("settings.sections.knowledgeAgents.staleConflict"))
        } else {
          setConflictMessage("")
        }
        return
      }

      setDraft({ config: result.config, issues: result.issues, conflict: result.conflict })
      setLoadedUpdatedAt(result.config.updatedAt)
      setSaved(true)
    } catch {
      setSaveErrorMessage(t("settings.sections.knowledgeAgents.saveFailed"))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold">
          {t("settings.sections.knowledgeAgents.title")}
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("settings.sections.knowledgeAgents.description")}
        </p>
      </div>

      {!project && (
        <div className="flex items-start gap-2 rounded-md border border-border/70 bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
          <Bot className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{t("settings.sections.knowledgeAgents.noProject")}</span>
        </div>
      )}

      {loading && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          <span>{t("settings.sections.knowledgeAgents.loading")}</span>
        </div>
      )}

      {alertMessage && (
        <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-800 dark:text-amber-200">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{alertMessage}</span>
        </div>
      )}

      <div className="space-y-2">
        {KNOWLEDGE_AGENT_IDS.map((id) => {
          const agent = draft.config.agents[id]
          return (
            <div
              key={id}
              data-testid={`knowledge-agent-row-${id}`}
              className="grid grid-cols-[1fr_auto_auto] items-start gap-3 rounded-md border border-border/70 px-3 py-2"
            >
              <div className="min-w-0">
                <div className="truncate text-sm font-medium">
                  {t(`settings.sections.knowledgeAgents.agents.${id}`)}
                </div>
                <div className="text-xs text-muted-foreground">{id}</div>
                {isPromptCapableAgent(id) && (
                  <label className="mt-3 block text-xs text-muted-foreground">
                    <span className="mb-1 block">
                      {t("settings.sections.knowledgeAgents.guidance")}
                    </span>
                    <textarea
                      data-testid={`knowledge-agent-guidance-${id}`}
                      value={agent.guidance}
                      disabled={disabled}
                      maxLength={GUIDANCE_MAX_LENGTH}
                      onChange={(event) => patchAgent(id, { guidance: event.target.value })}
                      placeholder={t("settings.sections.knowledgeAgents.guidancePlaceholder")}
                      className="min-h-20 w-full resize-y rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus:ring-2 focus:ring-ring disabled:cursor-not-allowed disabled:opacity-60"
                    />
                  </label>
                )}
              </div>

              <label className="flex items-center gap-2 text-xs text-muted-foreground">
                <input
                  data-testid={`knowledge-agent-enabled-${id}`}
                  type="checkbox"
                  checked={agent.enabled}
                  disabled={disabled}
                  onChange={(event) => patchAgent(id, { enabled: event.target.checked })}
                  className="h-4 w-4"
                />
                {t("settings.sections.knowledgeAgents.enabled")}
              </label>

              <label className="flex items-center gap-2 text-xs text-muted-foreground">
                <input
                  data-testid={`knowledge-agent-auto-run-${id}`}
                  type="checkbox"
                  checked={agent.autoRun}
                  disabled={disabled}
                  onChange={(event) => patchAgent(id, { autoRun: event.target.checked })}
                  className="h-4 w-4"
                />
                {t("settings.sections.knowledgeAgents.autoRun")}
              </label>
            </div>
          )
        })}
      </div>

      <div className="flex items-center justify-between gap-4 border-t pt-3">
        <p className="text-xs text-muted-foreground">
          {saved ? t("settings.savedTick") : t("settings.changeHint")}
        </p>
        <Button onClick={handleSave} disabled={disabled} data-testid="knowledge-agents-save">
          {saving ? t("settings.sections.knowledgeAgents.saving") : t("settings.save")}
        </Button>
      </div>
    </div>
  )
}
