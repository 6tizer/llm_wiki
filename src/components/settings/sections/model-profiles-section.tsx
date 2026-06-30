import { useEffect, useMemo, useState } from "react"
import { Loader2 } from "lucide-react"
import { useTranslation } from "react-i18next"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  runtimeProfileCreate,
  runtimeProfileList,
  runtimeProfileUpdate,
  type RuntimeProfileApiMode,
  type RuntimeProfileAuthStyle,
  type RuntimeProfileCreateRequest,
  type RuntimeProfileKind,
  type RuntimeProfileRecord,
  type RuntimeProfileUpdateRequest,
} from "@/commands/runtime-db"
import {
  profileSecretDelete,
  profileSecretWrite,
} from "@/commands/profile-secrets"
import { testLlmConnection, testLlmFunction, type ProviderTestResult } from "@/lib/connection-tests"
import type { LlmConfig } from "@/stores/wiki-store"
import { AZURE_OPENAI_API_VERSION } from "@/lib/azure-openai"
import { LLM_PRESETS } from "../llm-presets"

const DEFAULT_CONTEXT_SIZE = 131072
const DEFAULT_OLLAMA_URL = "http://localhost:11434"
const MAX_PROFILE_CONCURRENCY = 128

export const PROFILE_TASK_FAMILY_OPTIONS = [
  "chat",
  "ingest",
  "review",
  "synthesis",
  "taxonomy",
  "agent",
  "vision",
  "embedding",
] as const

const PROFILE_KIND_OPTIONS: RuntimeProfileKind[] = ["model-call", "agent-run"]
const API_MODE_OPTIONS: RuntimeProfileApiMode[] = [
  "openai-chat-completions",
  "anthropic-messages",
  "google-generate-content",
  "local-cli",
]
const AUTH_STYLE_OPTIONS: RuntimeProfileAuthStyle[] = [
  "bearer",
  "x-api-key",
  "api-key",
  "none",
  "oauth-local-cli",
]

export interface ModelProfileDraft {
  profileId?: string
  kind: RuntimeProfileKind
  displayName: string
  providerId: string
  modelId: string
  endpoint: string
  apiMode: RuntimeProfileApiMode
  authStyle: RuntimeProfileAuthStyle
  enabled: boolean
  taskFamilies: string[]
  maxConcurrency: number
  secretRef?: string | null
  rawSecret: string
  clearSecret: boolean
}

type SmokeConfigResult =
  | { ok: true; config: LlmConfig }
  | { ok: false; result: ProviderTestResult }

type LoadState =
  | { kind: "loading" }
  | { kind: "ready" }
  | { kind: "error"; message: string }

type TestState =
  | { kind: "idle" }
  | { kind: "running"; label: string }
  | { kind: "done"; result: ProviderTestResult }

function presetForProviderId(providerId: string) {
  return LLM_PRESETS.find((preset) => preset.id === providerId)
}

function defaultApiModeForProvider(providerId: string): RuntimeProfileApiMode {
  const preset = presetForProviderId(providerId)
  if (preset?.provider === "anthropic") return "anthropic-messages"
  if (preset?.provider === "google") return "google-generate-content"
  if (preset?.provider === "claude-code" || preset?.provider === "codex-cli") return "local-cli"
  return "openai-chat-completions"
}

function defaultAuthStyleForProvider(providerId: string): RuntimeProfileAuthStyle {
  const preset = presetForProviderId(providerId)
  if (preset?.provider === "ollama") return "none"
  if (preset?.provider === "claude-code" || preset?.provider === "codex-cli") {
    return "oauth-local-cli"
  }
  if (preset?.provider === "anthropic") return "x-api-key"
  return "bearer"
}

function normalizedTaskFamilies(values: string[]): string[] {
  const out: string[] = []
  for (const value of values) {
    const trimmed = value.trim()
    if (trimmed && !out.includes(trimmed)) out.push(trimmed)
  }
  return out.length > 0 ? out : ["chat"]
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function maybeNumber(value: number): number {
  return Number.isFinite(value) ? Math.max(1, Math.min(MAX_PROFILE_CONCURRENCY, Math.round(value))) : 1
}

/** Builds a new profile draft using provider defaults without persisting anything. */
export function createEmptyProfileDraft(providerId = "openai"): ModelProfileDraft {
  const preset = presetForProviderId(providerId) ?? LLM_PRESETS[0]
  return {
    kind: "model-call",
    displayName: preset?.label ?? "Model profile",
    providerId: preset?.id ?? providerId,
    modelId: preset?.defaultModel ?? "",
    endpoint: preset?.baseUrl ?? "",
    apiMode: defaultApiModeForProvider(preset?.id ?? providerId),
    authStyle: defaultAuthStyleForProvider(preset?.id ?? providerId),
    enabled: true,
    taskFamilies: ["chat"],
    maxConcurrency: 1,
    secretRef: null,
    rawSecret: "",
    clearSecret: false,
  }
}

/** Converts a runtime profile record into an editable UI draft. */
export function draftFromProfile(profile: RuntimeProfileRecord): ModelProfileDraft {
  return {
    profileId: profile.profileId,
    kind: profile.kind,
    displayName: profile.displayName,
    providerId: profile.providerId,
    modelId: profile.modelId,
    endpoint: profile.endpoint ?? "",
    apiMode: profile.apiMode,
    authStyle: profile.authStyle,
    enabled: profile.enabled,
    taskFamilies: normalizedTaskFamilies(profile.taskFamilies),
    maxConcurrency: profile.maxConcurrency,
    secretRef: profile.secretRef ?? null,
    rawSecret: "",
    clearSecret: false,
  }
}

/** Returns curated task families plus unknown persisted values so the UI never drops future data. */
export function taskFamiliesForRender(values: string[]): string[] {
  const known: string[] = [...PROFILE_TASK_FAMILY_OPTIONS]
  const unknown = normalizedTaskFamilies(values).filter((value) => !known.includes(value))
  return [...known, ...unknown]
}

/** Maps a profile draft into the legacy LlmConfig shape used by PR2 smoke tests. */
export function smokeConfigFromDraft(draft: ModelProfileDraft): SmokeConfigResult {
  const rawSecret = draft.rawSecret.trim()
  if (!draft.modelId.trim()) {
    return { ok: false, result: { ok: false, message: "Model id is required for this smoke test." } }
  }
  if (draft.authStyle !== "none" && draft.authStyle !== "oauth-local-cli" && !rawSecret) {
    return {
      ok: false,
      result: {
        ok: false,
        message: "Enter a raw secret in this draft to run a PR2 smoke test. Stored-secret probes arrive in PR3.",
      },
    }
  }

  const preset = presetForProviderId(draft.providerId)
  const provider = preset?.provider
  const base: Omit<LlmConfig, "provider"> = {
    apiKey: rawSecret,
    model: draft.modelId.trim(),
    ollamaUrl: DEFAULT_OLLAMA_URL,
    customEndpoint: draft.endpoint.trim(),
    maxContextSize: DEFAULT_CONTEXT_SIZE,
    reasoning: { mode: "off" },
  }

  if (draft.apiMode === "local-cli") {
    return {
      ok: false,
      result: {
        ok: false,
        message: "Local CLI profile smoke tests use the existing provider test, not the PR2 raw-secret profile smoke path.",
      },
    }
  }
  if (draft.apiMode === "google-generate-content") {
    if (provider !== "google") {
      return { ok: false, result: { ok: false, message: "This profile is not mapped to a Google smoke-test provider." } }
    }
    return { ok: true, config: { ...base, provider: "google" } }
  }
  if (draft.apiMode === "anthropic-messages") {
    if (provider === "anthropic") {
      return { ok: true, config: { ...base, provider: "anthropic" } }
    }
    // Keep Anthropic-compatible gateways ahead of the generic custom fallback.
    return {
      ok: true,
      config: {
        ...base,
        provider: "custom",
        apiMode: "anthropic_messages",
      },
    }
  }
  if (provider === "openai") return { ok: true, config: { ...base, provider: "openai" } }
  if (provider === "azure") {
    return {
      ok: true,
      config: {
        ...base,
        provider: "azure",
        azureApiVersion: AZURE_OPENAI_API_VERSION,
        azureModelFamily: "auto",
      },
    }
  }
  if (provider === "ollama") {
    return {
      ok: true,
      config: {
        ...base,
        provider: "ollama",
        apiKey: "",
        ollamaUrl: draft.endpoint.trim() || DEFAULT_OLLAMA_URL,
      },
    }
  }
  if (provider === "custom" || draft.endpoint.trim()) {
    return {
      ok: true,
      config: {
        ...base,
        provider: "custom",
        apiMode: "chat_completions",
      },
    }
  }
  return { ok: false, result: { ok: false, message: "This profile cannot be smoke-tested by PR2." } }
}

function toCreateRequest(draft: ModelProfileDraft, secretRef?: string): RuntimeProfileCreateRequest {
  return {
    kind: draft.kind,
    displayName: draft.displayName.trim(),
    providerId: draft.providerId.trim(),
    modelId: draft.modelId.trim(),
    endpoint: draft.endpoint.trim() || null,
    apiMode: draft.apiMode,
    authStyle: draft.authStyle,
    secretRef: secretRef ?? draft.secretRef ?? null,
    enabled: draft.enabled,
    taskFamilies: normalizedTaskFamilies(draft.taskFamilies),
    maxConcurrency: maybeNumber(draft.maxConcurrency),
  }
}

function toUpdateRequest(
  draft: ModelProfileDraft,
  secretRef?: string,
): RuntimeProfileUpdateRequest {
  return {
    profileId: draft.profileId ?? "",
    displayName: draft.displayName.trim(),
    providerId: draft.providerId.trim(),
    modelId: draft.modelId.trim(),
    endpoint: draft.endpoint.trim() || null,
    clearEndpoint: draft.endpoint.trim().length === 0,
    apiMode: draft.apiMode,
    authStyle: draft.authStyle,
    secretRef: secretRef ?? undefined,
    clearSecretRef: draft.clearSecret && !secretRef,
    enabled: draft.enabled,
    taskFamilies: normalizedTaskFamilies(draft.taskFamilies),
    maxConcurrency: maybeNumber(draft.maxConcurrency),
  }
}

/** Saves a profile draft and applies best-effort secret cleanup for failed writes or replacement. */
export async function saveProfileDraft(
  draft: ModelProfileDraft,
  existing: RuntimeProfileRecord | undefined,
): Promise<RuntimeProfileRecord> {
  const oldRef = existing?.secretRef ?? undefined
  let newRef: string | undefined
  if (draft.rawSecret.trim()) {
    newRef = (await profileSecretWrite({ secretValue: draft.rawSecret })).secretRef
  }

  try {
    const saved = existing
      ? await runtimeProfileUpdate(toUpdateRequest(draft, newRef))
      : await runtimeProfileCreate(toCreateRequest(draft, newRef))
    if (newRef && oldRef) {
      await profileSecretDelete({ secretRef: oldRef }).catch(() => undefined)
    }
    if (!newRef && draft.clearSecret && oldRef) {
      await profileSecretDelete({ secretRef: oldRef }).catch(() => undefined)
    }
    return saved
  } catch (error) {
    if (newRef) {
      await profileSecretDelete({ secretRef: newRef }).catch(() => undefined)
    }
    throw error
  }
}

export function ModelProfilesSection() {
  const { t } = useTranslation()
  const [profiles, setProfiles] = useState<RuntimeProfileRecord[]>([])
  const [draft, setDraft] = useState<ModelProfileDraft>(() => createEmptyProfileDraft())
  const [loadState, setLoadState] = useState<LoadState>({ kind: "loading" })
  const [saveMessage, setSaveMessage] = useState<string | null>(null)
  const [testState, setTestState] = useState<TestState>({ kind: "idle" })

  const selectedProfile = useMemo(
    () => profiles.find((profile) => profile.profileId === draft.profileId),
    [draft.profileId, profiles],
  )

  async function loadProfiles(shouldApply = () => true) {
    setLoadState({ kind: "loading" })
    try {
      const result = await runtimeProfileList()
      if (!shouldApply()) return
      const nextProfiles = Array.isArray(result.profiles) ? result.profiles : []
      setProfiles(nextProfiles)
      setDraft(nextProfiles[0] ? draftFromProfile(nextProfiles[0]) : createEmptyProfileDraft())
      setLoadState({ kind: "ready" })
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
  }, [])

  function updateDraft(patch: Partial<ModelProfileDraft>) {
    setDraft((current) => ({ ...current, ...patch }))
  }

  function selectProvider(providerId: string) {
    const next = createEmptyProfileDraft(providerId)
    updateDraft({
      providerId,
      modelId: next.modelId,
      endpoint: next.endpoint,
      apiMode: next.apiMode,
      authStyle: next.authStyle,
      displayName: draft.profileId ? draft.displayName : next.displayName,
    })
  }

  async function saveDraft() {
    setSaveMessage(null)
    try {
      const saved = await saveProfileDraft(draft, selectedProfile)
      setProfiles((current) => {
        const others = current.filter((profile) => profile.profileId !== saved.profileId)
        return [...others, saved].sort((a, b) => a.displayName.localeCompare(b.displayName))
      })
      setDraft(draftFromProfile(saved))
      setSaveMessage(t("settings.sections.llm.profiles.saved"))
    } catch (error) {
      setSaveMessage(t("settings.sections.llm.profiles.saveFailed", { message: errorMessage(error) }))
    }
  }

  async function runSmoke(kind: "connection" | "function") {
    const mapped = smokeConfigFromDraft(draft)
    if (!mapped.ok) {
      setTestState({ kind: "done", result: mapped.result })
      return
    }
    setTestState({
      kind: "running",
      label: kind === "connection"
        ? t("settings.sections.llm.testingConnection")
        : t("settings.sections.llm.testingFunction"),
    })
    const result = kind === "connection"
      ? await testLlmConnection(mapped.config)
      : await testLlmFunction(mapped.config)
    setTestState({ kind: "done", result })
  }

  const allTaskFamilies = taskFamiliesForRender(draft.taskFamilies)
  const draftProviderIsKnown = Boolean(presetForProviderId(draft.providerId))

  return (
    <div className="space-y-3 border-t pt-4" data-testid="model-profiles-section">
      <div>
        <h3 className="text-base font-semibold">{t("settings.sections.llm.profiles.title")}</h3>
        <p className="mt-1 text-xs text-muted-foreground">
          {t("settings.sections.llm.profiles.description")}
        </p>
      </div>

      {loadState.kind === "loading" && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          {t("settings.sections.llm.profiles.loading")}
        </div>
      )}
      {loadState.kind === "error" && (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">
          {loadState.message}
        </div>
      )}

      {loadState.kind === "ready" && (
        <div className="grid gap-4 lg:grid-cols-[220px_minmax(0,1fr)]">
          <div className="space-y-2">
            <button
              type="button"
              className="w-full rounded-md border px-3 py-1.5 text-sm hover:bg-accent"
              data-testid="profile-new"
              onClick={() => setDraft(createEmptyProfileDraft())}
            >
              {t("settings.sections.llm.profiles.newProfile")}
            </button>
            {profiles.map((profile) => (
              <button
                key={profile.profileId}
                type="button"
                data-testid={`profile-select-${profile.profileId}`}
                onClick={() => setDraft(draftFromProfile(profile))}
                className={`w-full rounded-md border px-3 py-2 text-left text-xs hover:bg-accent ${
                  draft.profileId === profile.profileId ? "border-primary bg-primary/5" : "border-border"
                }`}
              >
                <span className="block truncate font-medium">{profile.displayName}</span>
                <span className="block truncate text-muted-foreground">
                  {profile.providerId} / {profile.modelId}
                </span>
              </button>
            ))}
          </div>

          <div className="space-y-4 rounded-md border p-3">
            <div className="grid gap-3 md:grid-cols-2">
              <div className="space-y-1.5">
                <Label>{t("settings.sections.llm.profiles.displayName")}</Label>
                <Input
                  data-testid="profile-display-name"
                  value={draft.displayName}
                  onChange={(event) => updateDraft({ displayName: event.target.value })}
                />
              </div>
              <div className="space-y-1.5">
                <Label>{t("settings.sections.llm.profiles.provider")}</Label>
                <select
                  data-testid="profile-provider"
                  className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                  value={draft.providerId}
                  onChange={(event) => selectProvider(event.target.value)}
                >
                  {!draftProviderIsKnown && (
                    <option value={draft.providerId}>{draft.providerId}</option>
                  )}
                  {LLM_PRESETS.map((preset) => (
                    <option key={preset.id} value={preset.id}>{preset.label}</option>
                  ))}
                </select>
              </div>
              <div className="space-y-1.5">
                <Label>{t("settings.model")}</Label>
                <Input
                  data-testid="profile-model"
                  value={draft.modelId}
                  onChange={(event) => updateDraft({ modelId: event.target.value })}
                />
              </div>
              <div className="space-y-1.5">
                <Label>{t("settings.sections.llm.endpoint")}</Label>
                <Input
                  data-testid="profile-endpoint"
                  value={draft.endpoint}
                  onChange={(event) => updateDraft({ endpoint: event.target.value })}
                />
              </div>
              <div className="space-y-1.5">
                <Label>{t("settings.sections.llm.profiles.kind")}</Label>
                <select
                  data-testid="profile-kind"
                  className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                  value={draft.kind}
                  onChange={(event) => updateDraft({ kind: event.target.value as RuntimeProfileKind })}
                >
                  {PROFILE_KIND_OPTIONS.map((value) => <option key={value} value={value}>{value}</option>)}
                </select>
              </div>
              <div className="space-y-1.5">
                <Label>{t("settings.sections.llm.apiMode")}</Label>
                <select
                  data-testid="profile-api-mode"
                  className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                  value={draft.apiMode}
                  onChange={(event) => updateDraft({ apiMode: event.target.value as RuntimeProfileApiMode })}
                >
                  {API_MODE_OPTIONS.map((value) => <option key={value} value={value}>{value}</option>)}
                </select>
              </div>
              <div className="space-y-1.5">
                <Label>{t("settings.sections.llm.profiles.authStyle")}</Label>
                <select
                  data-testid="profile-auth-style"
                  className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                  value={draft.authStyle}
                  onChange={(event) => updateDraft({ authStyle: event.target.value as RuntimeProfileAuthStyle })}
                >
                  {AUTH_STYLE_OPTIONS.map((value) => <option key={value} value={value}>{value}</option>)}
                </select>
              </div>
              <div className="space-y-1.5">
                <Label>{t("settings.sections.llm.profiles.maxConcurrency")}</Label>
                <Input
                  data-testid="profile-max-concurrency"
                  type="number"
                  min={1}
                  max={MAX_PROFILE_CONCURRENCY}
                  value={draft.maxConcurrency}
                  onChange={(event) => updateDraft({ maxConcurrency: maybeNumber(Number(event.target.value)) })}
                />
              </div>
            </div>

            <label className="flex items-center gap-2 text-sm">
              <input
                data-testid="profile-enabled"
                type="checkbox"
                checked={draft.enabled}
                onChange={(event) => updateDraft({ enabled: event.target.checked })}
              />
              {t("settings.sections.llm.profiles.enabled")}
            </label>

            <div className="space-y-2">
              <Label>{t("settings.sections.llm.profiles.taskFamilies")}</Label>
              <div className="flex flex-wrap gap-2">
                {allTaskFamilies.map((family) => {
                  const checked = draft.taskFamilies.includes(family)
                  return (
                    <label key={family} className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs">
                      <input
                        data-testid={`profile-task-${family}`}
                        type="checkbox"
                        checked={checked}
                        onChange={(event) => {
                          const next = event.target.checked
                            ? normalizedTaskFamilies([...draft.taskFamilies, family])
                            : normalizedTaskFamilies(draft.taskFamilies.filter((value) => value !== family))
                          updateDraft({ taskFamilies: next })
                        }}
                      />
                      {family}
                    </label>
                  )
                })}
              </div>
            </div>

            <div className="space-y-2 rounded-md border p-3">
              <div className="flex flex-wrap items-center gap-2">
                <Label className="m-0">{t("settings.apiKey")}</Label>
                {draft.secretRef && !draft.clearSecret && (
                  <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">
                    {t("settings.sections.llm.profiles.secretSaved")}
                  </span>
                )}
                {draft.clearSecret && (
                  <span className="rounded-full bg-amber-500/10 px-2 py-0.5 text-[10px] text-amber-700 dark:text-amber-300">
                    {t("settings.sections.llm.profiles.secretWillClear")}
                  </span>
                )}
              </div>
              <Input
                data-testid="profile-secret"
                type="password"
                value={draft.rawSecret}
                onChange={(event) => updateDraft({ rawSecret: event.target.value, clearSecret: false })}
                placeholder={t("settings.sections.llm.profiles.secretPlaceholder")}
              />
              {draft.secretRef && (
                <button
                  type="button"
                  data-testid="profile-clear-secret"
                  className="rounded-md border px-2 py-1 text-xs hover:bg-accent"
                  onClick={() => updateDraft({ clearSecret: true, rawSecret: "" })}
                >
                  {t("settings.sections.llm.profiles.clearSecret")}
                </button>
              )}
            </div>

            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                data-testid="profile-save"
                onClick={() => void saveDraft()}
                className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground hover:bg-primary/90"
              >
                {t("settings.sections.llm.profiles.saveProfile")}
              </button>
              <button
                type="button"
                data-testid="profile-smoke-connection"
                onClick={() => void runSmoke("connection")}
                disabled={testState.kind === "running"}
                className="rounded-md border px-3 py-1.5 text-sm hover:bg-accent disabled:opacity-60"
              >
                {t("settings.sections.llm.testConnection")}
              </button>
              <button
                type="button"
                data-testid="profile-smoke-function"
                onClick={() => void runSmoke("function")}
                disabled={testState.kind === "running"}
                className="rounded-md border px-3 py-1.5 text-sm hover:bg-accent disabled:opacity-60"
              >
                {t("settings.sections.llm.testFunction")}
              </button>
            </div>
            {saveMessage && <p className="text-xs text-muted-foreground">{saveMessage}</p>}
            {testState.kind === "running" && <p className="text-xs text-muted-foreground">{testState.label}</p>}
            {testState.kind === "done" && (
              <div
                className={`rounded-md border px-3 py-2 text-xs ${
                  testState.result.ok
                    ? "border-emerald-500/40 bg-emerald-500/5 text-emerald-700 dark:text-emerald-400"
                    : "border-destructive/40 bg-destructive/5 text-destructive"
                }`}
              >
                {testState.result.message}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
