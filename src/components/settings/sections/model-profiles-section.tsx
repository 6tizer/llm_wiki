import { useEffect, useMemo, useRef, useState } from "react"
import { Loader2, Plus } from "lucide-react"
import { useTranslation } from "react-i18next"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  runtimeProfileCreate,
  runtimeProfileDelete,
  runtimeProfileList,
  runtimeProfilePoolList,
  runtimeProfileProbe,
  runtimeProfileUpdate,
  type RuntimeProfileApiMode,
  type RuntimeProfileAuthStyle,
  type RuntimeProfileCreateRequest,
  type RuntimeDbHealthState,
  type RuntimeProfileKind,
  type RuntimeProfileCircuitBreakerRecord,
  type RuntimeProfileProbeDraftRequest,
  type RuntimeProfileProbeResult,
  type RuntimeProfileRecord,
  type RuntimeProfileUpdateRequest,
} from "@/commands/runtime-db"
import {
  profileSecretBackendGet,
  profileSecretBackendSet,
  profileSecretDelete,
  profileSecretWrite,
  type ProfileSecretBackend,
} from "@/commands/profile-secrets"
import { LLM_PRESETS } from "@/lib/llm-presets"
import { ProviderAccessWizard } from "./provider-access-wizard"
import { ProfileCapabilityBadge, capabilityBadgeMeta } from "./profile-capability-badge"
import { groupProfilesByConnection } from "@/lib/profile-connections"
import { useCountdown } from "@/lib/hooks/use-countdown"
import { breakerDisplayReason, countdownSeconds } from "@/lib/hooks/breaker-display"

const MAX_PROFILE_CONCURRENCY = 128
// Keep these version strings aligned with src-tauri/src/commands/runtime_db.rs.
const PROFILE_PROBE_CAPABILITY_VERSION = "profile-probe.v1"
const STALE_PROFILE_CAPABILITY_VERSION = "spec-4-pr1"

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
  agentSdkModelId: string
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

type LoadState =
  | { kind: "loading" }
  | { kind: "ready"; enabled: boolean; status: RuntimeDbHealthState }
  | { kind: "error"; message: string }

type ProbeState =
  | { kind: "idle" }
  | { kind: "running" }
  | { kind: "done"; result: RuntimeProfileProbeResult }
  | { kind: "error"; message: string }

type SecretBackendState =
  | { kind: "loading"; backend: ProfileSecretBackend }
  | { kind: "ready"; backend: ProfileSecretBackend; message?: string }
  | { kind: "saving"; backend: ProfileSecretBackend }
  | { kind: "error"; backend: ProfileSecretBackend; message: string }

function presetForProviderId(providerId: string) {
  return LLM_PRESETS.find((preset) => preset.id === providerId)
}

export function defaultApiModeForProvider(providerId: string): RuntimeProfileApiMode {
  const preset = presetForProviderId(providerId)
  if (preset?.provider === "anthropic") return "anthropic-messages"
  if (preset?.provider === "google") return "google-generate-content"
  if (preset?.provider === "claude-code" || preset?.provider === "codex-cli") return "local-cli"
  return "openai-chat-completions"
}

export function defaultAuthStyleForProvider(providerId: string): RuntimeProfileAuthStyle {
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
    agentSdkModelId: "",
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
    agentSdkModelId: profile.agentSdkModelId ?? "",
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

function sameStringArray(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  return a.every((value, index) => value === b[index])
}

function draftHasUnsavedChanges(draft: ModelProfileDraft, profile: RuntimeProfileRecord): boolean {
  const clean = draftFromProfile(profile)
  return draft.kind !== clean.kind
    || draft.displayName !== clean.displayName
    || draft.providerId !== clean.providerId
    || draft.modelId !== clean.modelId
    || draft.agentSdkModelId !== clean.agentSdkModelId
    || draft.endpoint !== clean.endpoint
    || draft.apiMode !== clean.apiMode
    || draft.authStyle !== clean.authStyle
    || draft.enabled !== clean.enabled
    || !sameStringArray(normalizedTaskFamilies(draft.taskFamilies), clean.taskFamilies)
    || draft.maxConcurrency !== clean.maxConcurrency
    || (draft.secretRef ?? null) !== (clean.secretRef ?? null)
    || draft.rawSecret.trim().length > 0
    || draft.clearSecret
}

function reconcileDraftAfterProfileLoad(
  draft: ModelProfileDraft,
  nextProfiles: RuntimeProfileRecord[],
  previousProfiles: RuntimeProfileRecord[],
  isInitialLoad: boolean,
): ModelProfileDraft {
  if (isInitialLoad) {
    return nextProfiles[0] ? draftFromProfile(nextProfiles[0]) : createEmptyProfileDraft()
  }
  if (!draft.profileId) return draft

  const nextSelected = nextProfiles.find((profile) => profile.profileId === draft.profileId)
  if (!nextSelected) {
    return nextProfiles[0] ? draftFromProfile(nextProfiles[0]) : createEmptyProfileDraft()
  }

  const previousSelected = previousProfiles.find((profile) => profile.profileId === draft.profileId)
  if (previousSelected && draftHasUnsavedChanges(draft, previousSelected)) {
    return draft
  }
  return draftFromProfile(nextSelected)
}

function toCreateRequest(draft: ModelProfileDraft, secretRef?: string): RuntimeProfileCreateRequest {
  const agentSdkModelId = agentSdkModelIdForAgentRun(draft)
  return {
    kind: draft.kind,
    displayName: draft.displayName.trim(),
    providerId: draft.providerId.trim(),
    modelId: draft.modelId.trim(),
    agentSdkModelId: agentSdkModelId || null,
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
  existing: RuntimeProfileRecord,
  secretRef?: string,
): RuntimeProfileUpdateRequest {
  const resetCapability = profileProbeInputsChanged(draft, existing, secretRef)
  const agentSdkModelId = agentSdkModelIdForAgentRun(draft)
  return {
    profileId: draft.profileId ?? "",
    displayName: draft.displayName.trim(),
    providerId: draft.providerId.trim(),
    modelId: draft.modelId.trim(),
    agentSdkModelId: agentSdkModelId || null,
    ...(existing.agentSdkModelId || draft.kind === "agent-run"
      ? { clearAgentSdkModelId: agentSdkModelId.length === 0 }
      : {}),
    endpoint: draft.endpoint.trim() || null,
    clearEndpoint: draft.endpoint.trim().length === 0,
    apiMode: draft.apiMode,
    authStyle: draft.authStyle,
    secretRef: secretRef ?? undefined,
    clearSecretRef: draft.clearSecret && !secretRef,
    enabled: draft.enabled,
    taskFamilies: normalizedTaskFamilies(draft.taskFamilies),
    maxConcurrency: maybeNumber(draft.maxConcurrency),
    ...(resetCapability
      ? {
          capabilityStatus: "unknown" as const,
          capabilityJson: "{}",
          capabilityVersion: STALE_PROFILE_CAPABILITY_VERSION,
          capabilityCheckedAtMs: 0,
          clearLastCapabilityError: true,
        }
      : {}),
  }
}

function normalizedEndpoint(value: string | null | undefined): string | null {
  const trimmed = (value ?? "").trim()
  return trimmed || null
}

function agentSdkModelIdForAgentRun(draft: ModelProfileDraft): string {
  return draft.kind === "agent-run" ? draft.agentSdkModelId.trim() : ""
}

function profileHasModelAliasDrift(draft: ModelProfileDraft): boolean {
  const modelId = draft.modelId.trim()
  const agentSdkModelId = draft.agentSdkModelId.trim()
  return draft.kind === "agent-run" && agentSdkModelId !== "" && modelId !== agentSdkModelId
}

function profileProbeInputsChanged(
  draft: ModelProfileDraft,
  existing: RuntimeProfileRecord,
  newSecretRef?: string,
): boolean {
  // Provider changes flow through model/endpoint/API/auth defaults, which are the probe inputs.
  const nextSecretRef = draft.clearSecret && !newSecretRef
    ? null
    : newSecretRef ?? draft.secretRef ?? null
  const existingAgentSdkModelId = existing.kind === "agent-run" ? existing.agentSdkModelId ?? "" : ""
  const nextAgentSdkModelId = agentSdkModelIdForAgentRun(draft)
  return existing.modelId !== draft.modelId.trim()
    || existing.kind !== draft.kind
    || existingAgentSdkModelId !== nextAgentSdkModelId
    || normalizedEndpoint(existing.endpoint) !== normalizedEndpoint(draft.endpoint)
    || existing.apiMode !== draft.apiMode
    || existing.authStyle !== draft.authStyle
    || (existing.secretRef ?? null) !== nextSecretRef
}

function probeDraftRequest(draft: ModelProfileDraft): RuntimeProfileProbeDraftRequest {
  const agentSdkModelId = agentSdkModelIdForAgentRun(draft)
  return {
    kind: draft.kind,
    providerId: draft.providerId.trim(),
    modelId: draft.modelId.trim(),
    agentSdkModelId: agentSdkModelId || null,
    endpoint: normalizedEndpoint(draft.endpoint),
    apiMode: draft.apiMode,
    authStyle: draft.authStyle,
  }
}

function hasFreshCapability(profile: RuntimeProfileRecord | undefined): boolean {
  return profile?.capabilityVersion === PROFILE_PROBE_CAPABILITY_VERSION
}

function agentRunSupported(profile: RuntimeProfileRecord | undefined): boolean | null {
  if (!profile || !hasFreshCapability(profile)) return null
  try {
    const parsed = JSON.parse(profile.capabilityJson) as Record<string, unknown>
    const value = parsed.agentRunSupported
    return typeof value === "boolean" ? value : null
  } catch {
    return null
  }
}

async function deleteStaleProfileSecretRef(secretRef: string) {
  try {
    await profileSecretDelete({ secretRef })
  } catch (error) {
    console.warn("[model-profiles] failed to delete stale profile secretRef", { secretRef, error })
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
    if (existing) {
      const result = await runtimeProfileUpdate(toUpdateRequest(draft, existing, newRef))
      if (!result.profile) {
        console.warn("[model-profiles] runtime profile update omitted profile; keeping secrets untouched")
        return existing
      }
      if (result.staleSecretRef) {
        await deleteStaleProfileSecretRef(result.staleSecretRef)
      } else if ((newRef || draft.clearSecret) && oldRef && result.staleSecretRef === undefined) {
        console.warn("[model-profiles] runtime profile update omitted staleSecretRef; keeping old secretRef")
      }
      return result.profile
    }
    return await runtimeProfileCreate(toCreateRequest(draft, newRef))
  } catch (error) {
    if (newRef) {
      await deleteStaleProfileSecretRef(newRef)
    }
    throw error
  }
}

interface ModelProfilesSectionProps {
  refreshToken?: number
  onProfilesChanged?: () => void
  onNavigateFallback?: () => void
}

export function ModelProfilesSection({
  refreshToken = 0,
  onProfilesChanged,
  onNavigateFallback,
}: ModelProfilesSectionProps = {}) {
  const { t } = useTranslation()
  const [profiles, setProfiles] = useState<RuntimeProfileRecord[]>([])
  const [draft, setDraft] = useState<ModelProfileDraft>(() => createEmptyProfileDraft())
  const [loadState, setLoadState] = useState<LoadState>({ kind: "loading" })
  const [saveMessage, setSaveMessage] = useState<string | null>(null)
  const [deleteMessage, setDeleteMessage] = useState<string | null>(null)
  const [probeState, setProbeState] = useState<ProbeState>({ kind: "idle" })
  const [poolBreakers, setPoolBreakers] = useState<RuntimeProfileCircuitBreakerRecord[]>([])
  const [secretBackendState, setSecretBackendState] = useState<SecretBackendState>({
    kind: "loading",
    backend: "file",
  })
  const [capabilityDetailProfileId, setCapabilityDetailProfileId] = useState<string | null>(null)
  const profilesRef = useRef<RuntimeProfileRecord[]>([])
  const loadedOnceRef = useRef(false)
  const tRef = useRef(t)

  const selectedProfile = useMemo(
    () => profiles.find((profile) => profile.profileId === draft.profileId),
    [draft.profileId, profiles],
  )
  const profileGroups = useMemo(() => groupProfilesByConnection(profiles), [profiles])
  const breakersByProfileId = useMemo(
    () => new Map(poolBreakers.map((breaker) => [breaker.profileId, breaker])),
    [poolBreakers],
  )

  async function loadProfiles(shouldApply = () => true) {
    const isInitialLoad = !loadedOnceRef.current
    if (isInitialLoad) {
      setLoadState({ kind: "loading" })
    }
    try {
      const [result, poolResult] = await Promise.all([
        runtimeProfileList(),
        runtimeProfilePoolList().catch(() => null),
      ])
      if (!shouldApply()) return
      const nextProfiles = Array.isArray(result.profiles) ? result.profiles : []
      const previousProfiles = profilesRef.current
      profilesRef.current = nextProfiles
      setProfiles(nextProfiles)
      setPoolBreakers(poolResult?.circuitBreakers ?? [])
      setDraft((current) => reconcileDraftAfterProfileLoad(
        current,
        nextProfiles,
        previousProfiles,
        isInitialLoad,
      ))
      loadedOnceRef.current = true
      setLoadState({ kind: "ready", enabled: Boolean(result.enabled), status: result.status })
    } catch (error) {
      if (!shouldApply()) return
      if (!isInitialLoad) return
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

  useEffect(() => {
    tRef.current = t
  }, [t])

  useEffect(() => {
    // Secret backend is a global app setting; load it once on mount.
    let active = true
    void profileSecretBackendGet()
      .then((result) => {
        if (active) setSecretBackendState({ kind: "ready", backend: result.backend })
      })
      .catch((error) => {
        if (active) {
          setSecretBackendState({
            kind: "error",
            backend: "file",
            message: tRef.current("settings.sections.modelConfig.profiles.secretBackendLoadFailed", {
              message: errorMessage(error),
            }),
          })
        }
      })
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
      agentSdkModelId: next.agentSdkModelId,
      endpoint: next.endpoint,
      apiMode: next.apiMode,
      authStyle: next.authStyle,
      displayName: draft.profileId ? draft.displayName : next.displayName,
    })
  }

  async function selectSecretBackend(backend: ProfileSecretBackend) {
    const previous = secretBackendState.backend
    setSecretBackendState({ kind: "saving", backend })
    try {
      const result = await profileSecretBackendSet({ backend })
      setSecretBackendState({
        kind: "ready",
        backend: result.backend,
        message: t("settings.sections.modelConfig.profiles.secretBackendSaved"),
      })
    } catch (error) {
      setSecretBackendState({
        kind: "error",
        backend: previous,
        message: t("settings.sections.modelConfig.profiles.secretBackendSaveFailed", {
          message: errorMessage(error),
        }),
      })
    }
  }

  async function saveDraft() {
    setSaveMessage(null)
    setDeleteMessage(null)
    if (runtimeUnavailableMessage) {
      setSaveMessage(runtimeUnavailableMessage)
      return
    }
    try {
      const saved = await saveProfileDraft(draft, selectedProfile)
      const nextProfiles = [
        ...profilesRef.current.filter((profile) => profile.profileId !== saved.profileId),
        saved,
      ].sort((a, b) => a.displayName.localeCompare(b.displayName))
      profilesRef.current = nextProfiles
      setProfiles(nextProfiles)
      setDraft(draftFromProfile(saved))
      setSaveMessage(t("settings.sections.modelConfig.profiles.saved"))
      onProfilesChanged?.()
    } catch (error) {
      setSaveMessage(t("settings.sections.modelConfig.profiles.saveFailed", { message: errorMessage(error) }))
    }
  }

  function applyCreatedProfile(saved: RuntimeProfileRecord) {
    const nextProfiles = [
      ...profilesRef.current.filter((profile) => profile.profileId !== saved.profileId),
      saved,
    ].sort((a, b) => a.displayName.localeCompare(b.displayName))
    profilesRef.current = nextProfiles
    setProfiles(nextProfiles)
    setDraft(draftFromProfile(saved))
    setSaveMessage(t("settings.sections.modelConfig.profiles.wizard.created"))
    setProbeState({ kind: "idle" })
    onProfilesChanged?.()
  }

  async function deleteSelectedProfile() {
    setDeleteMessage(null)
    setSaveMessage(null)
    if (runtimeUnavailableMessage) {
      setDeleteMessage(runtimeUnavailableMessage)
      return
    }
    if (!selectedProfile) return
    const confirmed = window.confirm(
      t("settings.sections.modelConfig.profiles.deleteConfirm", {
        name: selectedProfile.displayName,
      }),
    )
    if (!confirmed) return

    try {
      const result = await runtimeProfileDelete({ profileId: selectedProfile.profileId })
      if (result.secretRef) {
        await deleteStaleProfileSecretRef(result.secretRef)
      }
      const nextProfiles = profilesRef.current.filter((profile) => profile.profileId !== result.profileId)
      profilesRef.current = nextProfiles
      setProfiles(nextProfiles)
      setDraft(nextProfiles[0] ? draftFromProfile(nextProfiles[0]) : createEmptyProfileDraft())
      setDeleteMessage(t("settings.sections.modelConfig.profiles.deleted"))
      setProbeState({ kind: "idle" })
      onProfilesChanged?.()
    } catch (error) {
      setDeleteMessage(t("settings.sections.modelConfig.profiles.deleteFailed", { message: errorMessage(error) }))
    }
  }

  async function runProbe() {
    if (runtimeUnavailableMessage) {
      setProbeState({ kind: "error", message: runtimeUnavailableMessage })
      return
    }
    setProbeState({ kind: "running" })
    const useStoredProfile = Boolean(
      draft.profileId
        && selectedProfile
        && !draft.rawSecret.trim()
        && !profileProbeInputsChanged(draft, selectedProfile),
    )
    try {
      const result = useStoredProfile
        // UI probes are explicit user re-tests, so they bypass backoff. Scheduler paths use force:false.
        ? await runtimeProfileProbe({ profileId: draft.profileId, force: true })
        : await runtimeProfileProbe({
            draft: probeDraftRequest(draft),
            rawSecret: draft.rawSecret.trim(),
            force: true,
          })
      const updatedProfile = result.profile
      if (updatedProfile) {
        const nextProfiles = profilesRef.current.map((profile) => (
          profile.profileId === updatedProfile.profileId ? updatedProfile : profile
        ))
        profilesRef.current = nextProfiles
        setProfiles(nextProfiles)
        setDraft(draftFromProfile(updatedProfile))
        onProfilesChanged?.()
      }
      setProbeState({ kind: "done", result })
    } catch (error) {
      setProbeState({ kind: "error", message: errorMessage(error) })
    }
  }

  const allTaskFamilies = taskFamiliesForRender(draft.taskFamilies)
  const draftProviderIsKnown = Boolean(presetForProviderId(draft.providerId))
  const selectedCapabilityIsFresh = Boolean(
    selectedProfile
      && hasFreshCapability(selectedProfile)
      && !profileProbeInputsChanged(draft, selectedProfile),
  )
  const capabilityStatus = selectedCapabilityIsFresh
    ? selectedProfile?.capabilityStatus ?? "unknown"
    : "unknown"
  const runtimeUnavailableMessage = loadState.kind === "ready" && loadState.status === "no-project"
    ? t("settings.sections.modelConfig.profiles.runtimeUnavailableNoProject")
    : null
  const agentKindWarning = draft.kind !== "agent-run" && draft.taskFamilies.includes("agent")
    ? t("settings.sections.modelConfig.profiles.agentKindWarning", { kind: draft.kind })
    : null
  const agentRunCapabilityWarning = draft.kind === "agent-run" && draft.taskFamilies.includes("agent")
    ? draft.apiMode !== "anthropic-messages"
      ? t("settings.sections.modelConfig.profiles.agentRunApiModeWarning")
      : selectedCapabilityIsFresh && agentRunSupported(selectedProfile) !== true
        ? t("settings.sections.modelConfig.profiles.agentRunCapabilityWarning")
        : null
    : null
  const modelAliasDrift = profileHasModelAliasDrift(draft)

  if (loadState.kind === "ready" && loadState.status === "disabled") {
    return null
  }

  return (
    <div className="space-y-3" data-testid="model-profiles-section">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-base font-semibold">{t("settings.sections.modelConfig.profiles.title")}</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            {t("settings.sections.modelConfig.profiles.description")}
          </p>
        </div>
        {loadState.kind === "ready" && (
          <ProviderAccessWizard
            disabled={Boolean(runtimeUnavailableMessage)}
            runtimeUnavailableMessage={runtimeUnavailableMessage}
            onProfileCreated={applyCreatedProfile}
          />
        )}
      </div>

      {loadState.kind === "loading" && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          {t("settings.sections.modelConfig.profiles.loading")}
        </div>
      )}
      {loadState.kind === "error" && (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">
          {loadState.message}
        </div>
      )}
      {runtimeUnavailableMessage && (
        <div
          className="rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-xs text-amber-700 dark:text-amber-300"
          data-testid="profile-runtime-unavailable"
        >
          {runtimeUnavailableMessage}
        </div>
      )}

      <div className="space-y-2 rounded-md border p-3" data-testid="profile-secret-backend-section">
        <div className="space-y-1">
          <Label>{t("settings.sections.modelConfig.profiles.secretBackendLabel")}</Label>
          <p className="text-xs text-muted-foreground">
            {t("settings.sections.modelConfig.profiles.secretBackendHint")}
          </p>
        </div>
        <select
          data-testid="profile-secret-backend"
          className="w-full rounded-md border bg-background px-3 py-2 text-sm"
          value={secretBackendState.backend}
          disabled={secretBackendState.kind === "loading" || secretBackendState.kind === "saving"}
          onChange={(event) => void selectSecretBackend(event.target.value as ProfileSecretBackend)}
        >
          <option value="file">{t("settings.sections.modelConfig.profiles.secretBackendFile")}</option>
          <option value="keychain">{t("settings.sections.modelConfig.profiles.secretBackendKeychain")}</option>
        </select>
        {secretBackendState.kind === "saving" && (
          <p className="text-xs text-muted-foreground">
            {t("settings.sections.modelConfig.profiles.secretBackendSaving")}
          </p>
        )}
        {"message" in secretBackendState && secretBackendState.message && (
          <p className={`text-xs ${
            secretBackendState.kind === "error" ? "text-destructive" : "text-muted-foreground"
          }`}
          >
            {secretBackendState.message}
          </p>
        )}
      </div>

      {loadState.kind === "ready" && (
        <div className="grid gap-4 lg:grid-cols-[220px_minmax(0,1fr)]">
          <div className="space-y-2">
            <button
              type="button"
              className="inline-flex w-full items-center justify-center gap-1.5 rounded-md border px-3 py-1.5 text-sm hover:bg-accent"
              data-testid="profile-new"
              onClick={() => setDraft(createEmptyProfileDraft())}
            >
              <Plus className="h-3.5 w-3.5" />
              {t("settings.sections.modelConfig.profiles.newProfile")}
            </button>
            {profileGroups.map((group) => (
              <section
                key={group.key}
                className="space-y-2 rounded-md border bg-muted/20 p-2"
                data-testid={`profile-group-${group.providerId}`}
              >
                <div className="space-y-2">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="truncate text-xs font-semibold">
                        {t("profileGroups.heading", {
                          provider: group.providerLabel,
                          count: group.profiles.length,
                        })}
                      </div>
                      <div className="truncate text-[11px] text-muted-foreground" title={group.endpoint}>
                        {group.endpoint || t("profileGroups.defaultEndpoint")}
                      </div>
                    </div>
                    <ProviderAccessWizard
                      disabled={Boolean(runtimeUnavailableMessage)}
                      runtimeUnavailableMessage={runtimeUnavailableMessage}
                      onProfileCreated={applyCreatedProfile}
                      initialConnection={{
                        providerId: group.providerId,
                        endpoint: group.endpoint || null,
                        secretRef: group.secretRef || null,
                      }}
                      triggerLabel={t("profileGroups.addModel")}
                    />
                  </div>
                </div>
                {group.profiles.map((profile) => {
                  const detailOpen = capabilityDetailProfileId === profile.profileId
                  const checkedAt = profile.capabilityCheckedAtMs
                    ? new Date(profile.capabilityCheckedAtMs).toLocaleString()
                    : t("settings.sections.modelConfig.profiles.capabilityNeverChecked")
                  const message = profile.lastCapabilityError
                    || (hasFreshCapability(profile)
                      ? t("settings.sections.modelConfig.profiles.capabilityMessageOk")
                      : t("settings.sections.modelConfig.profiles.capabilityStale"))
                  return (
                    <div
                      key={profile.profileId}
                      className={`rounded-md border bg-background ${
                        draft.profileId === profile.profileId ? "border-primary bg-primary/5" : "border-border"
                      }`}
                    >
                      <div className="flex items-start gap-2 px-3 py-2">
                        <button
                          type="button"
                          data-testid={`profile-select-${profile.profileId}`}
                          onClick={() => setDraft(draftFromProfile(profile))}
                          className="min-w-0 flex-1 text-left text-xs hover:text-primary"
                        >
                          <span className="block truncate font-medium">{profile.displayName}</span>
                          <span className="block truncate text-muted-foreground">
                            {profile.providerId} / {profile.modelId}
                          </span>
                        </button>
                        <ProfileCapabilityBadge
                          status={profile.capabilityStatus}
                          t={t}
                          as="button"
                          onClick={() => setCapabilityDetailProfileId(detailOpen ? null : profile.profileId)}
                        />
                      </div>
                      <ProfileBreakerStatus
                        breaker={breakersByProfileId.get(profile.profileId)}
                        onNavigateFallback={onNavigateFallback}
                        variant="list"
                      />
                      {detailOpen && (
                        <div
                          className="border-t px-3 py-2 text-[11px] text-muted-foreground"
                          data-testid={`profile-capability-detail-${profile.profileId}`}
                        >
                          <div>{message}</div>
                          <div>{t("settings.sections.modelConfig.profiles.capabilityChecked", { time: checkedAt })}</div>
                        </div>
                      )}
                    </div>
                  )
                })}
              </section>
            ))}
            {profiles.length === 0 && (
              <div className="rounded-md border px-3 py-2 text-xs text-muted-foreground">
                {t("profileGroups.empty")}
              </div>
            )}
          </div>

          <div className="space-y-4 rounded-md border p-3">
            <div className="grid gap-3 md:grid-cols-2">
              <div className="space-y-1.5">
                <Label>{t("settings.sections.modelConfig.profiles.displayName")}</Label>
                <Input
                  data-testid="profile-display-name"
                  value={draft.displayName}
                  onChange={(event) => updateDraft({ displayName: event.target.value })}
                />
              </div>
              <div className="space-y-1.5">
                <Label>{t("settings.sections.modelConfig.profiles.provider")}</Label>
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
                  onBlur={() => {
                    if (draft.kind === "agent-run" && draft.agentSdkModelId.trim() === "") {
                      updateDraft({ agentSdkModelId: draft.modelId.trim() })
                    }
                  }}
                />
              </div>
              {draft.kind === "agent-run" && (
                <div className="space-y-1.5">
                  <Label>{t("settings.sections.modelConfig.profiles.agentSdkModel")}</Label>
                  <Input
                    data-testid="profile-agent-sdk-model"
                    value={draft.agentSdkModelId}
                    onChange={(event) => updateDraft({ agentSdkModelId: event.target.value })}
                  />
                </div>
              )}
              {modelAliasDrift && (
                <div
                  className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-xs text-amber-800 dark:text-amber-200 md:col-span-2"
                  data-testid="profile-model-alias-drift-warning"
                >
                  <span>
                    {t("settings.sections.modelConfig.profiles.agentSdkModelDriftWarning", {
                      agentSdkModelId: draft.agentSdkModelId.trim(),
                      modelId: draft.modelId.trim(),
                    })}
                  </span>
                  <button
                    type="button"
                    className="rounded-md border border-amber-500/40 bg-background px-2 py-1 text-xs hover:bg-accent"
                    onClick={() => updateDraft({ agentSdkModelId: draft.modelId.trim() })}
                  >
                    {t("settings.sections.modelConfig.profiles.agentSdkModelSync")}
                  </button>
                </div>
              )}
              <div className="space-y-1.5">
                <Label>{t("settings.sections.modelConfig.profileFields.endpoint")}</Label>
                <Input
                  data-testid="profile-endpoint"
                  value={draft.endpoint}
                  onChange={(event) => updateDraft({ endpoint: event.target.value })}
                />
              </div>
              <div className="space-y-1.5">
                <Label>{t("settings.sections.modelConfig.profiles.kind")}</Label>
                <select
                  data-testid="profile-kind"
                  className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                  value={draft.kind}
                  onChange={(event) => {
                    const kind = event.target.value as RuntimeProfileKind
                    updateDraft({
                      kind,
                      ...(kind === "agent-run" ? {} : { agentSdkModelId: "" }),
                    })
                  }}
                >
                  {PROFILE_KIND_OPTIONS.map((value) => <option key={value} value={value}>{value}</option>)}
                </select>
              </div>
              <div className="space-y-1.5">
                <Label>{t("settings.sections.modelConfig.profileFields.apiMode")}</Label>
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
                <Label>{t("settings.sections.modelConfig.profiles.authStyle")}</Label>
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
                <Label>{t("settings.sections.modelConfig.profiles.maxConcurrency")}</Label>
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
              {t("settings.sections.modelConfig.profiles.enabled")}
            </label>

            <div className="space-y-2">
              <Label>{t("settings.sections.modelConfig.profiles.taskFamilies")}</Label>
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
              {agentKindWarning && (
                <p
                  className="rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-xs text-amber-700 dark:text-amber-300"
                  data-testid="profile-agent-kind-warning"
                >
                  {agentKindWarning}
                </p>
              )}
              {agentRunCapabilityWarning && (
                <p
                  className="rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-xs text-amber-700 dark:text-amber-300"
                  data-testid="profile-agent-run-capability-warning"
                >
                  {agentRunCapabilityWarning}
                </p>
              )}
            </div>

            <div className="space-y-2 rounded-md border p-3">
              <div className="flex flex-wrap items-center gap-2">
                <Label className="m-0">{t("settings.apiKey")}</Label>
                {draft.secretRef && !draft.clearSecret && (
                  <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">
                    {t("settings.sections.modelConfig.profiles.secretSaved")}
                  </span>
                )}
                {draft.clearSecret && (
                  <span className="rounded-full bg-amber-500/10 px-2 py-0.5 text-[10px] text-amber-700 dark:text-amber-300">
                    {t("settings.sections.modelConfig.profiles.secretWillClear")}
                  </span>
                )}
              </div>
              <Input
                data-testid="profile-secret"
                type="password"
                value={draft.rawSecret}
                onChange={(event) => updateDraft({ rawSecret: event.target.value, clearSecret: false })}
                placeholder={t("settings.sections.modelConfig.profiles.secretPlaceholder")}
              />
              {draft.secretRef && (
                <button
                  type="button"
                  data-testid="profile-clear-secret"
                  className="rounded-md border px-2 py-1 text-xs hover:bg-accent"
                  onClick={() => updateDraft({ clearSecret: true, rawSecret: "" })}
                >
                  {t("settings.sections.modelConfig.profiles.clearSecret")}
                </button>
              )}
            </div>

            <div className="space-y-1 rounded-md border px-3 py-2 text-xs">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{t("settings.sections.modelConfig.profiles.capability")}</span>
                <ProfileCapabilityBadge status={capabilityStatus} t={t} />
                <ProfileBreakerStatus
                  breaker={selectedProfile ? breakersByProfileId.get(selectedProfile.profileId) : undefined}
                  onNavigateFallback={onNavigateFallback}
                  variant="inline"
                />
                {!selectedCapabilityIsFresh && (
                  <span className="text-muted-foreground">
                    {t("settings.sections.modelConfig.profiles.capabilityStale")}
                  </span>
                )}
              </div>
              {selectedCapabilityIsFresh && selectedProfile?.capabilityCheckedAtMs && (
                <p className="text-muted-foreground">
                  {t("settings.sections.modelConfig.profiles.capabilityChecked", {
                    time: new Date(selectedProfile.capabilityCheckedAtMs).toLocaleString(),
                  })}
                </p>
              )}
              {selectedCapabilityIsFresh && selectedProfile?.probeBackoffUntilMs && (
                <p className="text-amber-700 dark:text-amber-300">
                  {t("settings.sections.modelConfig.profiles.capabilityBackoff", {
                    time: new Date(selectedProfile.probeBackoffUntilMs).toLocaleString(),
                  })}
                </p>
              )}
              {selectedCapabilityIsFresh && selectedProfile?.lastCapabilityError && (
                <p className="text-destructive">
                  {t("settings.sections.modelConfig.profiles.capabilityError", {
                    message: selectedProfile.lastCapabilityError,
                  })}
                </p>
              )}
            </div>

            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                data-testid="profile-save"
                onClick={() => void saveDraft()}
                disabled={Boolean(runtimeUnavailableMessage)}
                className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
              >
                {t("settings.sections.modelConfig.profiles.saveProfile")}
              </button>
              <button
                type="button"
                data-testid="profile-probe"
                onClick={() => void runProbe()}
                disabled={probeState.kind === "running" || Boolean(runtimeUnavailableMessage)}
                className="rounded-md border px-3 py-1.5 text-sm hover:bg-accent disabled:opacity-60"
              >
                {t("settings.sections.modelConfig.profiles.probe")}
              </button>
              {selectedProfile && (
                <button
                  type="button"
                  data-testid="profile-delete"
                  onClick={() => void deleteSelectedProfile()}
                  disabled={Boolean(runtimeUnavailableMessage)}
                  className="rounded-md border border-destructive/40 px-3 py-1.5 text-sm text-destructive hover:bg-destructive/5 disabled:opacity-60"
                >
                  {t("settings.sections.modelConfig.profiles.deleteProfile")}
                </button>
              )}
            </div>
            {saveMessage && <p className="text-xs text-muted-foreground">{saveMessage}</p>}
            {deleteMessage && <p className="text-xs text-muted-foreground">{deleteMessage}</p>}
            {probeState.kind === "running" && (
              <p className="text-xs text-muted-foreground">
                {t("settings.sections.modelConfig.profiles.probing")}
              </p>
            )}
            {probeState.kind === "error" && (
              <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">
                {probeState.message}
              </div>
            )}
            {probeState.kind === "done" && (() => {
              const meta = capabilityBadgeMeta(probeState.result.status, t)
              return (
                <div className={`rounded-md border px-3 py-2 text-xs ${meta.className}`}>
                  <span className="font-medium">{meta.label}</span>
                  {probeState.result.message && <span>: {probeState.result.message}</span>}
                </div>
              )
            })()}
          </div>
        </div>
      )}
    </div>
  )
}

function ProfileBreakerStatus({
  breaker,
  onNavigateFallback,
  variant = "inline",
  className = "",
}: {
  breaker?: RuntimeProfileCircuitBreakerRecord
  onNavigateFallback?: () => void
  variant?: "inline" | "list"
  className?: string
}) {
  const { t } = useTranslation()
  const remainingMs = useCountdown(breaker?.openUntilMs)
  if (!breaker) return null

  const reason = breakerDisplayReason(breaker)
  const cooled = remainingMs === 0
  const label = cooled
    ? t("settings.sections.modelConfig.profiles.breakerCooled")
    : t("settings.sections.modelConfig.profiles.breakerCooling", {
        seconds: countdownSeconds(remainingMs),
      })
  const spacingClassName = variant === "list" ? "px-3 pb-2" : ""

  return (
    <span
      className={`inline-flex flex-wrap items-center gap-1 text-[11px] text-amber-700 dark:text-amber-300 ${spacingClassName} ${className}`.trim()}
      title={reason || undefined}
      data-testid={`profile-breaker-status-${breaker.profileId}`}
    >
      <span>{label}</span>
      {onNavigateFallback && (
        <button
          type="button"
          className="underline underline-offset-2 hover:text-foreground"
          onClick={onNavigateFallback}
        >
          {t("settings.sections.modelConfig.profiles.breakerOpenFallback")}
        </button>
      )}
    </span>
  )
}
