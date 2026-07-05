import { useEffect, useMemo, useRef, useState } from "react"
import { CheckCircle2, Loader2 } from "lucide-react"
import { useTranslation } from "react-i18next"
import { Button } from "@/components/ui/button"
import { runtimeProfileList, type RuntimeProfileApiMode, type RuntimeProfileRecord } from "@/commands/runtime-db"
import { useWikiStore } from "@/stores/wiki-store"
import { LLM_PRESETS } from "../llm-presets"
import { resolveConfig } from "../preset-resolver"
import { providerAccessTemplateById, type ProviderAccessTemplate } from "@/lib/provider-access-templates"
import {
  defaultApiModeForProvider,
  defaultAuthStyleForProvider,
  saveProfileDraft,
  type ModelProfileDraft,
} from "./model-profiles-section"

type LoadState =
  | { kind: "loading" }
  | { kind: "ready"; profiles: RuntimeProfileRecord[] }
  | { kind: "hidden" }
  | { kind: "error"; message: string }

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function migratedProfilePrefix(presetId: string): string {
  return `Migrated: ${presetId}`
}

function migrationTemplateIdForPreset(presetId: string): string | undefined {
  const mapped: Record<string, string> = {
    "kimi": "kimi",
    "kimi-cn": "kimi",
    "deepseek": "deepseek",
    "zhipu": "zhipu-glm",
    "minimax-global": "minimax",
    "minimax-cn": "minimax",
    "xiaomi-mimo": "xiaomi-mimo",
    "volcengine-ark": "volcengine-ark",
    "bailian-coding": "dashscope",
    "anthropic": "anthropic",
    "openai": "openai",
    "google": "google-gemini",
  }
  return mapped[presetId]
}

function migrationTemplateForPreset(presetId: string): ProviderAccessTemplate | undefined {
  const templateId = migrationTemplateIdForPreset(presetId)
  return templateId ? providerAccessTemplateById(templateId) : undefined
}

function endpointFromResolvedConfig(resolved: ReturnType<typeof resolveConfig>): string {
  if (resolved.provider === "ollama") return resolved.ollamaUrl ?? ""
  if (resolved.provider === "custom" || resolved.provider === "azure") return resolved.customEndpoint ?? ""
  return ""
}

function apiModeFromResolvedConfig(
  presetId: string,
  resolved: ReturnType<typeof resolveConfig>,
): RuntimeProfileApiMode {
  if (resolved.provider === "custom" && resolved.apiMode === "anthropic_messages") {
    return "anthropic-messages"
  }
  return defaultApiModeForProvider(presetId)
}

interface Props {
  onMigrated?: () => void
}

export function ProviderMigrationBanner({ onMigrated }: Props = {}) {
  const { t } = useTranslation()
  const providerConfigs = useWikiStore((s) => s.providerConfigs)
  const activePresetId = useWikiStore((s) => s.activePresetId)
  const llmConfig = useWikiStore((s) => s.llmConfig)
  const [loadState, setLoadState] = useState<LoadState>({ kind: "loading" })
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [keepResolvedEndpoint, setKeepResolvedEndpoint] = useState(false)
  const savingRef = useRef(false)

  const activePreset = useMemo(
    () => LLM_PRESETS.find((preset) => preset.id === activePresetId),
    [activePresetId],
  )
  const migrationPrefix = activePresetId ? migratedProfilePrefix(activePresetId) : ""
  const migrationTemplate = activePresetId ? migrationTemplateForPreset(activePresetId) : undefined
  const resolvedPreview = useMemo(
    () => activePreset && activePresetId
      ? resolveConfig(activePreset, providerConfigs[activePresetId], llmConfig)
      : null,
    [activePreset, activePresetId, providerConfigs, llmConfig],
  )
  const resolvedEndpoint = resolvedPreview ? endpointFromResolvedConfig(resolvedPreview) : ""
  const resolvedApiMode = activePreset && resolvedPreview
    ? apiModeFromResolvedConfig(activePreset.id, resolvedPreview)
    : undefined
  const resolvedAuthStyle = activePreset ? defaultAuthStyleForProvider(activePreset.id) : undefined
  const migrationEndpoint = migrationTemplate && !keepResolvedEndpoint
    ? migrationTemplate.endpoint
    : resolvedEndpoint
  const migrationApiMode = migrationTemplate?.apiMode ?? resolvedApiMode
  const migrationAuthStyle = migrationTemplate?.authStyle ?? resolvedAuthStyle
  const migrationCorrectsValues = Boolean(
    migrationTemplate
      && resolvedApiMode
      && resolvedAuthStyle
      && (
        migrationEndpoint !== resolvedEndpoint
          || migrationApiMode !== resolvedApiMode
          || migrationAuthStyle !== resolvedAuthStyle
      ),
  )
  // The displayName prefix is a one-click migration marker, not a durable
  // identity contract. If a user renames the generated profile, running the
  // convenience action again may create a second clean profile instead of
  // mutating legacy provider data.
  const migratedProfile = loadState.kind === "ready"
    ? loadState.profiles.find((profile) => {
        const providerMatches = profile.providerId === activePresetId
          || profile.providerId === migrationTemplate?.id
        return providerMatches && profile.displayName.startsWith(migrationPrefix)
      })
    : undefined

  useEffect(() => {
    let active = true
    async function load() {
      if (!activePresetId) {
        setLoadState({ kind: "hidden" })
        return
      }
      try {
        const result = await runtimeProfileList()
        if (!active) return
        if (!result.enabled || result.status !== "healthy") {
          setLoadState({ kind: "hidden" })
          return
        }
        setLoadState({
          kind: "ready",
          profiles: Array.isArray(result.profiles) ? result.profiles : [],
        })
      } catch (error) {
        if (!active) return
        setLoadState({ kind: "error", message: errorMessage(error) })
      }
    }
    void load()
    return () => {
      active = false
    }
  }, [activePresetId])

  useEffect(() => {
    setKeepResolvedEndpoint(false)
  }, [activePresetId])

  async function migrateActivePreset() {
    if (!activePreset || !activePresetId || loadState.kind !== "ready" || migratedProfile || savingRef.current) return
    savingRef.current = true
    setSaving(true)
    setMessage(null)
    const resolved = resolvedPreview ?? resolveConfig(activePreset, providerConfigs[activePresetId], llmConfig)
    const template = migrationTemplateForPreset(activePreset.id)
    const draft: ModelProfileDraft = {
      kind: "model-call",
      displayName: migrationPrefix,
      providerId: template?.id ?? activePreset.id,
      modelId: resolved.model,
      agentSdkModelId: "",
      endpoint: template && !keepResolvedEndpoint ? template.endpoint : endpointFromResolvedConfig(resolved),
      apiMode: template?.apiMode ?? apiModeFromResolvedConfig(activePreset.id, resolved),
      authStyle: template?.authStyle ?? defaultAuthStyleForProvider(activePreset.id),
      enabled: true,
      taskFamilies: ["chat"],
      maxConcurrency: 1,
      secretRef: null,
      rawSecret: resolved.apiKey ?? "",
      clearSecret: false,
    }

    try {
      const saved = await saveProfileDraft(draft, undefined)
      setLoadState((current) => current.kind === "ready"
        ? { kind: "ready", profiles: [...current.profiles, saved] }
        : current)
      setMessage(t("settings.sections.modelConfig.migration.created"))
      onMigrated?.()
    } catch (error) {
      setMessage(t("settings.sections.modelConfig.migration.failed", { message: errorMessage(error) }))
    } finally {
      savingRef.current = false
      setSaving(false)
    }
  }

  if (!activePresetId || !activePreset || loadState.kind === "hidden" || loadState.kind === "loading") {
    return null
  }

  if (loadState.kind === "error") {
    return null
  }

  if (migratedProfile) {
    return (
      <div
        className="flex items-start gap-2 rounded-md border border-emerald-500/30 bg-emerald-500/5 px-3 py-2 text-xs text-emerald-700 dark:text-emerald-300"
        data-testid="provider-migration-complete"
      >
        <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <span>{t("settings.sections.modelConfig.migration.complete", { name: migratedProfile.displayName })}</span>
      </div>
    )
  }

  return (
    <div
      className="flex flex-col gap-3 rounded-md border border-primary/30 bg-primary/5 px-3 py-3 text-sm"
      data-testid="provider-migration-banner"
    >
      <div>
        <p className="font-medium">{t("settings.sections.modelConfig.migration.title")}</p>
        <p className="mt-1 text-xs text-muted-foreground">
          {t("settings.sections.modelConfig.migration.description", { preset: activePreset.label })}
        </p>
        {migrationCorrectsValues && (
          <p className="mt-1 text-xs text-muted-foreground" data-testid="provider-migration-template-note">
            {t("settings.sections.modelConfig.migration.templateCorrected", {
              from: resolvedEndpoint || "∅",
              to: migrationEndpoint || "∅",
            })}
          </p>
        )}
        {migrationTemplate && resolvedEndpoint && migrationTemplate.endpoint !== resolvedEndpoint && (
          <label className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
            <input
              type="checkbox"
              checked={keepResolvedEndpoint}
              onChange={(event) => setKeepResolvedEndpoint(event.target.checked)}
              data-testid="provider-migration-keep-endpoint"
            />
            {t("settings.sections.modelConfig.migration.keepResolvedEndpoint")}
          </label>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="sm"
          onClick={() => void migrateActivePreset()}
          disabled={saving}
          data-testid="provider-migration-create"
        >
          {saving && <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />}
          {t("settings.sections.modelConfig.migration.create")}
        </Button>
        {message && <span className="text-xs text-muted-foreground">{message}</span>}
      </div>
    </div>
  )
}
