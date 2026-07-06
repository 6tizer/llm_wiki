import { useEffect, useRef, useState } from "react"
import { Loader2 } from "lucide-react"
import { useTranslation } from "react-i18next"
import {
  runtimeProfileList,
  runtimeProfileUpdate,
  type RuntimeDbHealthState,
  type RuntimeProfileRecord,
} from "@/commands/runtime-db"
import { PROFILE_TASK_FAMILY_OPTIONS } from "./model-profiles-section"
import { EmbeddingInlineConfig, MultimodalInlineConfig } from "./task-matrix-inline-config"

type LoadState =
  | { kind: "loading" }
  | { kind: "ready"; enabled: boolean; status: RuntimeDbHealthState; profiles: RuntimeProfileRecord[] }
  | { kind: "error"; message: string }

const EFFECTIVE_TASK_FAMILIES = new Set(["agent", "ingest", "chat", "review", "synthesis", "vision"])
type InlineConfigTarget = "embedding" | "vision"
const CONFIG_TARGETS = new Set<InlineConfigTarget>(["embedding", "vision"])

interface Props {
  refreshToken?: number
  onProfilesChanged?: () => void
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function normalizedTaskFamilies(values: string[]): string[] {
  const out: string[] = []
  for (const value of values) {
    const trimmed = value.trim()
    if (trimmed && !out.includes(trimmed)) out.push(trimmed)
  }
  return out.length > 0 ? out : ["chat"]
}

function taskFamilyLabelKey(family: string): string {
  return `settings.sections.modelConfig.taskMatrix.families.${family}`
}

function taskFamilyStatusLabelKey(family: string): string {
  if (EFFECTIVE_TASK_FAMILIES.has(family)) {
    return "settings.sections.modelConfig.taskMatrix.effective"
  }
  if (family === "embedding") {
    return "settings.sections.modelConfig.taskMatrix.inlineOnly"
  }
  return "settings.sections.modelConfig.taskMatrix.notWired"
}

export function TaskMatrixSection({
  refreshToken = 0,
  onProfilesChanged,
}: Props) {
  const { t } = useTranslation()
  const [loadState, setLoadState] = useState<LoadState>({ kind: "loading" })
  const [updatingProfileIds, setUpdatingProfileIds] = useState<Set<string>>(() => new Set())
  const [message, setMessage] = useState<string | null>(null)
  const [expandedConfig, setExpandedConfig] = useState<InlineConfigTarget | null>(null)
  const profilesRef = useRef<RuntimeProfileRecord[]>([])

  async function loadProfiles(shouldApply = () => true) {
    setLoadState({ kind: "loading" })
    try {
      const result = await runtimeProfileList()
      if (!shouldApply()) return
      const profiles = Array.isArray(result.profiles) ? result.profiles : []
      profilesRef.current = profiles
      setLoadState({
        kind: "ready",
        enabled: Boolean(result.enabled),
        status: result.status,
        profiles,
      })
    } catch (error) {
      if (!shouldApply()) return
      setLoadState({ kind: "error", message: errorMessage(error) })
    }
  }

  useEffect(() => {
    let active = true
    void loadProfiles(() => active)
    return () => {
      active = false
    }
  }, [refreshToken])

  async function toggleTaskFamily(profile: RuntimeProfileRecord, family: string) {
    if (updatingProfileIds.has(profile.profileId)) return
    const latestProfile = profilesRef.current.find((item) => item.profileId === profile.profileId) ?? profile
    const hasFamily = latestProfile.taskFamilies.includes(family)
    const taskFamilies = normalizedTaskFamilies(
      hasFamily
        ? latestProfile.taskFamilies.filter((value) => value !== family)
        : [...latestProfile.taskFamilies, family],
    )
    setUpdatingProfileIds((current) => {
      const next = new Set(current)
      next.add(profile.profileId)
      return next
    })
    setMessage(null)
    try {
      const result = await runtimeProfileUpdate({
        profileId: profile.profileId,
        taskFamilies,
      })
      const updated = result.profile
      profilesRef.current = profilesRef.current.map((item) => (
        item.profileId === updated.profileId ? updated : item
      ))
      setLoadState((current) => current.kind === "ready"
        ? {
            ...current,
            profiles: current.profiles.map((item) => (
              item.profileId === updated.profileId ? updated : item
            )),
          }
        : current)
      setMessage(t("settings.sections.modelConfig.taskMatrix.saved"))
      onProfilesChanged?.()
    } catch (error) {
      setMessage(t("settings.sections.modelConfig.taskMatrix.saveFailed", { message: errorMessage(error) }))
    } finally {
      setUpdatingProfileIds((current) => {
        const next = new Set(current)
        next.delete(profile.profileId)
        return next
      })
    }
  }

  if (loadState.kind === "ready" && loadState.status === "disabled") {
    return null
  }

  return (
    <div className="space-y-3" data-testid="task-matrix-section">
      <div>
        <h3 className="text-base font-semibold">{t("settings.sections.modelConfig.taskMatrix.title")}</h3>
        <p className="mt-1 text-xs text-muted-foreground">
          {t("settings.sections.modelConfig.taskMatrix.description")}
        </p>
      </div>

      {loadState.kind === "loading" && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          {t("settings.sections.modelConfig.taskMatrix.loading")}
        </div>
      )}

      {loadState.kind === "error" && (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">
          {loadState.message}
        </div>
      )}

      {loadState.kind === "ready" && loadState.status === "no-project" && (
        <div
          className="rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-xs text-amber-700 dark:text-amber-300"
          data-testid="task-matrix-runtime-unavailable"
        >
          {t("settings.sections.modelConfig.profiles.runtimeUnavailableNoProject")}
        </div>
      )}

      {loadState.kind === "ready" && loadState.status === "healthy" && loadState.profiles.length === 0 && (
        <div className="rounded-md border px-3 py-2 text-xs text-muted-foreground">
          {t("settings.sections.modelConfig.taskMatrix.empty")}
        </div>
      )}

      {loadState.kind === "ready" && loadState.status === "healthy" && loadState.profiles.length > 0 && (
        <div className="overflow-x-auto rounded-md border">
          <table className="w-full min-w-[560px] border-collapse text-sm">
            <thead>
              <tr className="border-b bg-muted/40">
                <th className="w-52 px-3 py-2 text-left text-xs font-medium text-muted-foreground">
                  {t("settings.sections.modelConfig.taskMatrix.taskFamily")}
                </th>
                {loadState.profiles.map((profile) => (
                  <th key={profile.profileId} className="px-3 py-2 text-left text-xs font-medium text-muted-foreground">
                    <span className="block max-w-40 truncate" title={profile.displayName}>
                      {profile.displayName}
                    </span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {PROFILE_TASK_FAMILY_OPTIONS.map((family) => (
                <tr key={family} className="border-b last:border-b-0">
                  <th className="px-3 py-2 text-left align-top">
                    <div className="space-y-1">
                      <div className="font-medium">{t(taskFamilyLabelKey(family))}</div>
                      <div className="flex flex-wrap items-center gap-2">
                        <span
                          className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${
                            EFFECTIVE_TASK_FAMILIES.has(family)
                              ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                              : "bg-amber-500/10 text-amber-700 dark:text-amber-300"
                          }`}
                          data-testid={`task-matrix-status-${family}`}
                        >
                          {t(taskFamilyStatusLabelKey(family))}
                        </span>
                        {CONFIG_TARGETS.has(family as InlineConfigTarget) && (
                          <button
                            type="button"
                            className="text-[11px] text-primary underline-offset-2 hover:underline"
                            onClick={() => setExpandedConfig((current) => (
                              current === family ? null : family as InlineConfigTarget
                            ))}
                            data-testid={`task-matrix-config-${family}`}
                          >
                            {expandedConfig === family
                              ? t("settings.sections.modelConfig.taskMatrix.hideConfig")
                              : t("settings.sections.modelConfig.taskMatrix.configure")}
                          </button>
                        )}
                      </div>
                      {family === "embedding" && (
                        <p
                          className="max-w-52 text-[11px] text-muted-foreground"
                          data-testid="task-matrix-inline-note-embedding"
                        >
                          {t("settings.sections.modelConfig.taskMatrix.inlineConfigHint.embedding")}
                        </p>
                      )}
                      {family === "vision" && (
                        <p
                          className="max-w-52 text-[11px] text-muted-foreground"
                          data-testid="task-matrix-inline-note-vision"
                        >
                          {t("settings.sections.modelConfig.taskMatrix.inlineConfigHint.vision")}
                        </p>
                      )}
                    </div>
                  </th>
                  {loadState.profiles.map((profile) => {
                    const profilePending = updatingProfileIds.has(profile.profileId)
                    const checked = profile.taskFamilies.includes(family)
                    return (
                      <td key={profile.profileId} className="px-3 py-2 align-top">
                        <div className="space-y-1">
                          <label className="inline-flex h-7 w-7 items-center justify-center rounded-md border hover:bg-accent has-[:disabled]:opacity-60">
                            <input
                              type="checkbox"
                              className="h-4 w-4"
                              checked={checked}
                              disabled={profilePending}
                              aria-label={t("settings.sections.modelConfig.taskMatrix.toggle", {
                                family: t(taskFamilyLabelKey(family)),
                                profile: profile.displayName,
                              })}
                              data-testid={`task-matrix-${profile.profileId}-${family}`}
                              onChange={() => void toggleTaskFamily(profile, family)}
                            />
                          </label>
                          {family === "agent" && checked && profile.kind !== "agent-run" && (
                            <p
                              className="max-w-44 rounded-md border border-amber-500/40 bg-amber-500/5 px-2 py-1 text-[11px] text-amber-700 dark:text-amber-300"
                              data-testid={`task-matrix-agent-kind-warning-${profile.profileId}`}
                            >
                              {t("settings.sections.modelConfig.profiles.agentKindWarning", { kind: profile.kind })}
                            </p>
                          )}
                        </div>
                      </td>
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {expandedConfig === "embedding" && <EmbeddingInlineConfig />}
      {expandedConfig === "vision" && <MultimodalInlineConfig />}

      {message && <p className="text-xs text-muted-foreground">{message}</p>}
    </div>
  )
}
