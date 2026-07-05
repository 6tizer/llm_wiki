import { useEffect, useMemo, useRef, useState } from "react"
import { AlertTriangle, Loader2 } from "lucide-react"
import { useTranslation } from "react-i18next"
import { Button } from "@/components/ui/button"
import { runtimeProfileList, type RuntimeProfileApiMode, type RuntimeProfileRecord } from "@/commands/runtime-db"
import { useWikiStore, type ProviderOverride } from "@/stores/wiki-store"
import { LLM_PRESETS, type LlmPreset } from "../llm-presets"
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

interface MigrationCandidate {
  preset: LlmPreset
  presetId: string
  resolved: ReturnType<typeof resolveConfig>
  template: ProviderAccessTemplate | undefined
  migrationPrefix: string
  resolvedEndpoint: string
  resolvedApiMode: RuntimeProfileApiMode
  migrationEndpoint: string
  migrationApiMode: RuntimeProfileApiMode
  migrationAuthStyle: ReturnType<typeof defaultAuthStyleForProvider>
}

interface StaleLegacyConfig {
  presetId: string
  label: string
}

const SNAPSHOT_STORAGE_KEY = "llm-wiki:legacy-provider-migration:v1"

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function migratedProfilePrefix(presetId: string): string {
  return `Migrated: ${presetId}`
}

function migrationTemplateIdForPreset(presetId: string): string | undefined {
  // Unmapped custom gateway presets (for example groq/xai/nvidia-nim) safely fall back through resolveConfig's provider:"custom"+baseUrl path.
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

function providerOverrideHasValue(override: ProviderOverride | undefined): boolean {
  if (!override) return false
  return [override.apiKey, override.baseUrl, override.model].some((value) => (
    typeof value === "string" && value.trim().length > 0
  ))
}

function configuredPresetIds(
  providerConfigs: Record<string, ProviderOverride>,
  activePresetId: string | null,
): string[] {
  const ids = new Set<string>()
  if (activePresetId) ids.add(activePresetId)
  for (const [presetId, override] of Object.entries(providerConfigs)) {
    if (providerOverrideHasValue(override)) ids.add(presetId)
  }
  return [...ids].filter((presetId) => LLM_PRESETS.some((preset) => preset.id === presetId))
}

function migratedProfileForCandidate(
  profiles: RuntimeProfileRecord[],
  candidate: Pick<MigrationCandidate, "presetId" | "template" | "migrationPrefix">,
): RuntimeProfileRecord | undefined {
  return profiles.find((profile) => {
    const providerMatches = profile.providerId === candidate.presetId
      || profile.providerId === candidate.template?.id
    return providerMatches && profile.displayName.startsWith(candidate.migrationPrefix)
  })
}

function readSnapshots(): Record<string, string> {
  if (typeof globalThis.localStorage === "undefined") return {}
  try {
    const raw = globalThis.localStorage.getItem(SNAPSHOT_STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== "object") return {}
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>).filter(([, value]) => typeof value === "string"),
    ) as Record<string, string>
  } catch {
    return {}
  }
}

function writeSnapshot(presetId: string, apiKeyHash: string) {
  if (typeof globalThis.localStorage === "undefined") return
  const next = { ...readSnapshots(), [presetId]: apiKeyHash }
  try {
    globalThis.localStorage.setItem(SNAPSHOT_STORAGE_KEY, JSON.stringify(next))
  } catch {
    // Staleness hints are best-effort UI state; profile migration itself is
    // already complete if this write fails.
  }
}

async function hashLegacyApiKey(apiKey: string): Promise<string | null> {
  try {
    const bytes = new TextEncoder().encode(apiKey)
    const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes)
    return `sha256:${Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("")}`
  } catch {
    return null
  }
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
  const [staleLegacyConfigs, setStaleLegacyConfigs] = useState<StaleLegacyConfig[]>([])
  const savingRef = useRef(false)

  const candidates = useMemo<MigrationCandidate[]>(() => {
    return configuredPresetIds(providerConfigs, activePresetId).flatMap((presetId) => {
      const preset = LLM_PRESETS.find((item) => item.id === presetId)
      if (!preset) return []
      const resolved = resolveConfig(preset, providerConfigs[presetId], llmConfig)
      const template = migrationTemplateForPreset(preset.id)
      const resolvedEndpoint = endpointFromResolvedConfig(resolved)
      const resolvedApiMode = apiModeFromResolvedConfig(preset.id, resolved)
      const resolvedAuthStyle = defaultAuthStyleForProvider(preset.id)
      const migrationEndpoint = template && !keepResolvedEndpoint
        ? template.endpoint
        : resolvedEndpoint
      return [{
        preset,
        presetId,
        resolved,
        template,
        migrationPrefix: migratedProfilePrefix(presetId),
        resolvedEndpoint,
        resolvedApiMode,
        migrationEndpoint,
        migrationApiMode: template?.apiMode ?? resolvedApiMode,
        migrationAuthStyle: template?.authStyle ?? resolvedAuthStyle,
      }]
    })
  }, [activePresetId, providerConfigs, llmConfig, keepResolvedEndpoint])
  const candidateIdentity = useMemo(
    () => candidates.map((candidate) => candidate.preset.id).join(","),
    [candidates],
  )

  const importableCandidates = loadState.kind === "ready"
    ? candidates.filter((candidate) => !migratedProfileForCandidate(loadState.profiles, candidate))
    : []

  const migrationCorrectsValues = importableCandidates.some((candidate) => (
    candidate.template
      && (
        candidate.migrationEndpoint !== candidate.resolvedEndpoint
          || candidate.migrationApiMode !== candidate.resolvedApiMode
          || candidate.migrationAuthStyle !== defaultAuthStyleForProvider(candidate.preset.id)
      )
  ))

  const canKeepResolvedEndpoint = importableCandidates.some((candidate) => (
    candidate.template
      && candidate.resolvedEndpoint
      && candidate.template.endpoint !== candidate.resolvedEndpoint
  ))

  useEffect(() => {
    let active = true
    async function load() {
      if (candidates.length === 0) {
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
  }, [candidateIdentity, candidates.length])

  useEffect(() => {
    let active = true
    async function detectStale() {
      if (loadState.kind !== "ready") {
        setStaleLegacyConfigs([])
        return
      }
      const snapshots = readSnapshots()
      const stale: StaleLegacyConfig[] = []
      for (const candidate of candidates) {
        const migrated = migratedProfileForCandidate(loadState.profiles, candidate)
        const previousHash = snapshots[candidate.presetId]
        if (!migrated || !previousHash) continue
        const currentHash = await hashLegacyApiKey(candidate.resolved.apiKey ?? "")
        if (!active) return
        if (currentHash && currentHash !== previousHash) {
          stale.push({ presetId: candidate.presetId, label: candidate.preset.label })
        }
      }
      if (active) setStaleLegacyConfigs(stale)
    }
    void detectStale()
    return () => {
      active = false
    }
  }, [candidates, loadState])

  useEffect(() => {
    setKeepResolvedEndpoint(false)
  }, [activePresetId])

  async function migrateLegacyConfigs() {
    if (loadState.kind !== "ready" || importableCandidates.length === 0 || savingRef.current) return
    savingRef.current = true
    setSaving(true)
    setMessage(null)
    const savedProfiles: RuntimeProfileRecord[] = []
    const failures: string[] = []

    for (const candidate of importableCandidates) {
      const draft: ModelProfileDraft = {
        kind: "model-call",
        displayName: candidate.migrationPrefix,
        providerId: candidate.template?.id ?? candidate.preset.id,
        modelId: candidate.resolved.model,
        agentSdkModelId: "",
        endpoint: candidate.template && !keepResolvedEndpoint
          ? candidate.template.endpoint
          : endpointFromResolvedConfig(candidate.resolved),
        apiMode: candidate.template?.apiMode ?? apiModeFromResolvedConfig(candidate.preset.id, candidate.resolved),
        authStyle: candidate.template?.authStyle ?? defaultAuthStyleForProvider(candidate.preset.id),
        enabled: true,
        taskFamilies: ["chat"],
        maxConcurrency: 1,
        secretRef: null,
        rawSecret: candidate.resolved.apiKey ?? "",
        clearSecret: false,
      }

      try {
        const saved = await saveProfileDraft(draft, undefined)
        savedProfiles.push(saved)
        const apiKeyHash = await hashLegacyApiKey(candidate.resolved.apiKey ?? "")
        if (apiKeyHash) writeSnapshot(candidate.presetId, apiKeyHash)
      } catch (error) {
        failures.push(`${candidate.preset.label}: ${errorMessage(error)}`)
      }
    }

    if (savedProfiles.length > 0) {
      setLoadState((current) => current.kind === "ready"
        ? { kind: "ready", profiles: [...current.profiles, ...savedProfiles] }
        : current)
      onMigrated?.()
    }
    setMessage(failures.length > 0
      ? t("settings.sections.modelConfig.migration.partialFailed", {
          count: savedProfiles.length,
          total: importableCandidates.length,
          message: failures.join("; "),
        })
      : t("settings.sections.modelConfig.migration.created", { count: savedProfiles.length }))
    savingRef.current = false
    setSaving(false)
  }

  if (loadState.kind === "hidden" || loadState.kind === "loading" || loadState.kind === "error") {
    return null
  }

  if (importableCandidates.length === 0) {
    if (staleLegacyConfigs.length === 0) return null
    return (
      <div
        className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-xs text-amber-700 dark:text-amber-300"
        data-testid="provider-migration-stale"
      >
        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <span>
          {t("settings.sections.modelConfig.migration.stale", {
            presets: staleLegacyConfigs.map((item) => item.label).join(", "),
          })}
        </span>
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
          {t("settings.sections.modelConfig.migration.description", {
            count: importableCandidates.length,
            presets: importableCandidates.map((candidate) => candidate.preset.label).join(", "),
          })}
        </p>
        {migrationCorrectsValues && (
          <p className="mt-1 text-xs text-muted-foreground" data-testid="provider-migration-template-note">
            {t("settings.sections.modelConfig.migration.templateCorrected")}
          </p>
        )}
        {canKeepResolvedEndpoint && (
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
      {staleLegacyConfigs.length > 0 && (
        <div
          className="rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-xs text-amber-700 dark:text-amber-300"
          data-testid="provider-migration-stale"
        >
          {t("settings.sections.modelConfig.migration.stale", {
            presets: staleLegacyConfigs.map((item) => item.label).join(", "),
          })}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="sm"
          onClick={() => void migrateLegacyConfigs()}
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
