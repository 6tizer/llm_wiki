import { useEffect, useMemo, useRef, useState } from "react"
import { AlertCircle, CheckCircle2, ExternalLink, KeyRound, Loader2, Search } from "lucide-react"
import { openUrl } from "@tauri-apps/plugin-opener"
import { useTranslation } from "react-i18next"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  runtimeProfileCreate,
  runtimeProfileModelsList,
  runtimeProfileProbe,
  type RuntimeProfileCreateRequest,
  type RuntimeProfileKind,
  type RuntimeProfileProbeDraftRequest,
  type RuntimeProfileProbeResult,
  type RuntimeProfileRecord,
} from "@/commands/runtime-db"
import {
  profileSecretDelete,
  profileSecretWrite,
} from "@/commands/profile-secrets"
import {
  PROVIDER_ACCESS_TEMPLATES,
  type ProviderAccessTemplate,
  type ProviderAccessTemplateGroup,
} from "@/lib/provider-access-templates"
import { ProfileCapabilityBadge, capabilityBadgeMeta } from "./profile-capability-badge"

const TEMPLATE_GROUPS: ProviderAccessTemplateGroup[] = [
  "intl-official",
  "cn-official",
  "cloud",
  "local",
  "gateway",
]

type WizardStep = 1 | 2 | 3

type WizardProbeState =
  | { kind: "idle" }
  | { kind: "running" }
  | { kind: "success"; result: RuntimeProfileProbeResult; latencyMs: number }
  | { kind: "error"; message: string; latencyMs?: number }

type WizardModelListState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ready"; models: string[]; sourceUrl: string }
  | { kind: "error"; message: string }

interface ProviderAccessWizardProps {
  disabled?: boolean
  runtimeUnavailableMessage?: string | null
  onProfileCreated: (profile: RuntimeProfileRecord) => void
  initialConnection?: ProviderAccessWizardInitialConnection | null
  triggerLabel?: string
}

interface WizardFormState {
  displayName: string
  endpoint: string
  modelId: string
  apiKey: string
}

export interface ProviderAccessWizardInitialConnection {
  providerId: string
  endpoint?: string | null
  secretRef?: string | null
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function nowMs(): number {
  return typeof performance === "undefined" ? Date.now() : performance.now()
}

function authStyleRequiresSecret(template: ProviderAccessTemplate): boolean {
  return template.authStyle !== "none" && template.authStyle !== "oauth-local-cli"
}

function customProviderTemplate(): ProviderAccessTemplate {
  return PROVIDER_ACCESS_TEMPLATES.find((template) => template.id === "custom")
    ?? PROVIDER_ACCESS_TEMPLATES[0]
}

function providerTemplateForInitialConnection(
  connection: ProviderAccessWizardInitialConnection | null,
): ProviderAccessTemplate {
  if (!connection) return PROVIDER_ACCESS_TEMPLATES[0]
  return PROVIDER_ACCESS_TEMPLATES.find((template) => template.id === connection.providerId)
    ?? customProviderTemplate()
}

function profileKindForTemplate(
  template: ProviderAccessTemplate,
  includeAgentTask: boolean,
): RuntimeProfileKind {
  return template.agentSupport === "anthropic-compat" && includeAgentTask ? "agent-run" : "model-call"
}

function normalizedTaskFamilies(template: ProviderAccessTemplate, includeAgentTask: boolean): string[] {
  const values = includeAgentTask
    ? template.suggestedTaskFamilies
    : template.suggestedTaskFamilies.filter((family) => family !== "agent")
  const out: string[] = []
  for (const value of values) {
    const trimmed = value.trim()
    if (trimmed && !out.includes(trimmed)) out.push(trimmed)
  }
  return out.length > 0 ? out : ["chat"]
}

function probePassed(state: WizardProbeState): boolean {
  return state.kind === "success" && state.result.status !== "error"
}

function draftRequestForTemplate(
  template: ProviderAccessTemplate,
  endpoint: string,
  modelId: string,
): RuntimeProfileProbeDraftRequest {
  const kind = profileKindForTemplate(template, template.agentSupport === "anthropic-compat")
  const resolvedModelId = modelId.trim() || template.defaultModelId
  return {
    kind,
    providerId: template.id,
    modelId: resolvedModelId,
    agentSdkModelId: kind === "agent-run"
      ? resolvedModelId
      : null,
    endpoint: endpoint.trim() || null,
    apiMode: template.apiMode,
    authStyle: template.authStyle,
  }
}

/** Builds the runtime profile create payload emitted by the quick connect wizard. */
export function buildQuickConnectCreateRequest(
  template: ProviderAccessTemplate,
  form: Pick<WizardFormState, "displayName" | "endpoint" | "modelId">,
  secretRef: string | null,
  includeAgentTask: boolean,
  modelIdOverride?: string,
  displayNameOverride?: string,
): RuntimeProfileCreateRequest {
  const kind = profileKindForTemplate(template, includeAgentTask)
  const resolvedModelId = modelIdOverride?.trim() || form.modelId.trim() || template.defaultModelId
  return {
    kind,
    displayName: displayNameOverride?.trim() || form.displayName.trim() || template.displayName,
    providerId: template.id,
    modelId: resolvedModelId,
    agentSdkModelId: kind === "agent-run"
      ? resolvedModelId
      : null,
    endpoint: form.endpoint.trim() || null,
    apiMode: template.apiMode,
    authStyle: template.authStyle,
    secretRef,
    enabled: true,
    taskFamilies: normalizedTaskFamilies(template, includeAgentTask),
    maxConcurrency: 1,
  }
}

/** Renders the SPEC-13 three-step provider quick connect wizard. */
export function ProviderAccessWizard({
  disabled = false,
  runtimeUnavailableMessage = null,
  onProfileCreated,
  initialConnection = null,
  triggerLabel,
}: ProviderAccessWizardProps) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [step, setStep] = useState<WizardStep>(1)
  const [search, setSearch] = useState("")
  const [selectedTemplateId, setSelectedTemplateId] = useState(PROVIDER_ACCESS_TEMPLATES[0]?.id ?? "")
  const selectedTemplate = useMemo(
    () => PROVIDER_ACCESS_TEMPLATES.find((template) => template.id === selectedTemplateId)
      ?? PROVIDER_ACCESS_TEMPLATES[0],
    [selectedTemplateId],
  )
  const [form, setForm] = useState<WizardFormState>(() => ({
    displayName: selectedTemplate?.displayName ?? "",
    endpoint: selectedTemplate?.endpoint ?? "",
    modelId: selectedTemplate?.defaultModelId ?? "",
    apiKey: "",
  }))
  const [secretRef, setSecretRef] = useState<string | null>(null)
  const [probeState, setProbeState] = useState<WizardProbeState>({ kind: "idle" })
  const [modelListState, setModelListState] = useState<WizardModelListState>({ kind: "idle" })
  const [selectedModelIds, setSelectedModelIds] = useState<string[]>(() => (
    selectedTemplate?.defaultModelId ? [selectedTemplate.defaultModelId] : []
  ))
  const [retestMessage, setRetestMessage] = useState<string | null>(null)
  const [createMessage, setCreateMessage] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const secretRefRef = useRef<string | null>(null)
  // true means the current ref came from an existing connection/profile and cleanup must not delete it.
  const secretRefProtectedRef = useRef(false)
  const createdModelIdsRef = useRef<Set<string>>(new Set())
  const profileCreatedRef = useRef(false)
  const creatingRef = useRef(false)

  const filteredTemplates = useMemo(() => {
    const query = search.trim().toLowerCase()
    if (!query) return PROVIDER_ACCESS_TEMPLATES
    return PROVIDER_ACCESS_TEMPLATES.filter((template) => (
      template.displayName.toLowerCase().includes(query)
        || template.id.toLowerCase().includes(query)
        || template.defaultModelId.toLowerCase().includes(query)
    ))
  }, [search])

  const groupedTemplates = useMemo(() => TEMPLATE_GROUPS.map((group) => ({
    group,
    templates: filteredTemplates.filter((template) => template.group === group),
  })), [filteredTemplates])

  function resetWizard(template = PROVIDER_ACCESS_TEMPLATES[0], connection = initialConnection) {
    const reusedSecretRef = connection?.secretRef ?? null
    secretRefRef.current = reusedSecretRef
    secretRefProtectedRef.current = Boolean(reusedSecretRef)
    createdModelIdsRef.current.clear()
    profileCreatedRef.current = false
    setStep(connection ? 2 : 1)
    setSearch("")
    setSelectedTemplateId(template.id)
    setForm({
      displayName: template.displayName,
      endpoint: connection?.endpoint ?? template.endpoint,
      modelId: template.defaultModelId,
      apiKey: "",
    })
    setSecretRef(reusedSecretRef)
    setProbeState({ kind: "idle" })
    setModelListState({ kind: "idle" })
    setSelectedModelIds([template.defaultModelId])
    setRetestMessage(null)
    setCreateMessage(null)
    setCreating(false)
    creatingRef.current = false
  }

  async function cleanupDraftSecret() {
    const ref = secretRefRef.current
    if (!ref || profileCreatedRef.current) return
    if (secretRefProtectedRef.current) {
      secretRefRef.current = null
      setSecretRef(null)
      return
    }
    secretRefRef.current = null
    setSecretRef(null)
    await profileSecretDelete({ secretRef: ref }).catch(() => undefined)
  }

  function handleOpenChange(nextOpen: boolean) {
    if (nextOpen) {
      const template = providerTemplateForInitialConnection(initialConnection)
      resetWizard(template)
      setOpen(true)
      return
    }
    setOpen(false)
    void cleanupDraftSecret()
  }

  useEffect(() => () => {
    void cleanupDraftSecret()
  }, [])

  function selectTemplate(template: ProviderAccessTemplate) {
    if (secretRefRef.current) {
      void cleanupDraftSecret()
    }
    setSelectedTemplateId(template.id)
    setForm({
      displayName: template.displayName,
      endpoint: template.endpoint,
      modelId: template.defaultModelId,
      apiKey: "",
    })
    setSecretRef(null)
    setProbeState({ kind: "idle" })
    setModelListState({ kind: "idle" })
    setSelectedModelIds([template.defaultModelId])
    setRetestMessage(null)
    setCreateMessage(null)
    setStep(2)
  }

  async function ensureSecretForCreate(): Promise<{ ref: string | null; rawSecret: string | null }> {
    if (!selectedTemplate || !authStyleRequiresSecret(selectedTemplate)) {
      return { ref: null, rawSecret: null }
    }
    if (secretRefRef.current && !form.apiKey.trim()) {
      return { ref: secretRefRef.current, rawSecret: null }
    }
    const rawSecret = form.apiKey.trim()
    if (!rawSecret) {
      throw new Error(t("settings.sections.llm.profiles.wizard.keyRequired"))
    }
    const previousRef = secretRefRef.current
    const previousRefProtected = secretRefProtectedRef.current
    const result = await profileSecretWrite({ secretValue: rawSecret })
    if (previousRef && !previousRefProtected) {
      await profileSecretDelete({ secretRef: previousRef }).catch(() => undefined)
    }
    secretRefRef.current = result.secretRef
    secretRefProtectedRef.current = false
    setSecretRef(result.secretRef)
    setForm((current) => ({ ...current, apiKey: "" }))
    return { ref: result.secretRef, rawSecret }
  }

  async function runWizardProbe() {
    if (!selectedTemplate) return
    if (runtimeUnavailableMessage) {
      setProbeState({ kind: "error", message: runtimeUnavailableMessage })
      return
    }
    setCreateMessage(null)
    setRetestMessage(null)
    setProbeState({ kind: "running" })
    const startedAt = nowMs()
    try {
      const { rawSecret } = await ensureSecretForCreate()
      if (authStyleRequiresSecret(selectedTemplate) && !rawSecret) {
        if (probeState.kind === "success") {
          setRetestMessage(t("settings.sections.llm.profiles.wizard.retestNeedsKey"))
          setProbeState(probeState)
          return
        }
        throw new Error(t("settings.sections.llm.profiles.wizard.reenterKeyForRetest"))
      }
      const result = await runtimeProfileProbe({
        draft: draftRequestForTemplate(selectedTemplate, form.endpoint, form.modelId),
        ...(rawSecret ? { rawSecret } : {}),
        force: true,
      })
      setProbeState({ kind: "success", result, latencyMs: Math.max(0, Math.round(nowMs() - startedAt)) })
    } catch (error) {
      setProbeState({
        kind: "error",
        message: errorMessage(error),
        latencyMs: Math.max(0, Math.round(nowMs() - startedAt)),
      })
    }
  }

  function selectedModelsForCreate(): string[] {
    const fallback = form.modelId.trim() || selectedTemplate?.defaultModelId || ""
    const values = modelListState.kind === "ready" ? selectedModelIds : [fallback]
    const out: string[] = []
    for (const value of values) {
      const trimmed = value.trim()
      if (trimmed && !createdModelIdsRef.current.has(trimmed) && !out.includes(trimmed)) {
        out.push(trimmed)
      }
    }
    return out
  }

  function toggleSelectedModel(modelId: string, checked: boolean) {
    setSelectedModelIds((current) => {
      const trimmed = modelId.trim()
      if (!trimmed) return current
      if (checked) return current.includes(trimmed) ? current : [...current, trimmed]
      return current.filter((value) => value !== trimmed)
    })
  }

  async function loadModelList() {
    if (!selectedTemplate) return
    if (runtimeUnavailableMessage) {
      setModelListState({ kind: "error", message: runtimeUnavailableMessage })
      return
    }
    setCreateMessage(null)
    setModelListState({ kind: "loading" })
    try {
      const { rawSecret } = await ensureSecretForCreate()
      if (authStyleRequiresSecret(selectedTemplate) && !rawSecret) {
        throw new Error(t("settings.sections.llm.profiles.wizard.reenterKeyForModels"))
      }
      const result = await runtimeProfileModelsList({
        draft: {
          endpoint: form.endpoint.trim() || null,
          apiMode: selectedTemplate.apiMode,
          authStyle: selectedTemplate.authStyle,
        },
        ...(rawSecret ? { rawSecret } : {}),
        ...(selectedTemplate.modelsUrl ? { modelsUrl: selectedTemplate.modelsUrl } : {}),
      })
      const defaultModel = selectedTemplate.defaultModelId
      const manualModel = form.modelId.trim() || defaultModel
      const models = result.models.filter((model, index, list) => (
        model.trim() && list.indexOf(model) === index
      ))
      const initialSelection = selectedModelIds.filter((model) => models.includes(model))
      if (models.includes(defaultModel) && !initialSelection.includes(defaultModel)) {
        initialSelection.push(defaultModel)
      }
      if (initialSelection.length === 0) {
        initialSelection.push(manualModel)
      }
      setSelectedModelIds(initialSelection)
      setModelListState({ kind: "ready", models, sourceUrl: result.sourceUrl })
    } catch (error) {
      setSelectedModelIds([form.modelId.trim() || selectedTemplate.defaultModelId])
      setModelListState({ kind: "error", message: errorMessage(error) })
    }
  }

  async function finishWizard() {
    if (!selectedTemplate) return
    if (creatingRef.current) return
    if (runtimeUnavailableMessage) {
      setCreateMessage(runtimeUnavailableMessage)
      return
    }
    creatingRef.current = true
    setCreating(true)
    setCreateMessage(null)
    const created: RuntimeProfileRecord[] = []
    try {
      const { ref } = await ensureSecretForCreate()
      const includeAgentTask = selectedTemplate.agentSupport === "anthropic-compat" && probePassed(probeState)
      const models = selectedModelsForCreate()
      if (models.length === 0) {
        profileCreatedRef.current = true
        secretRefRef.current = null
        secretRefProtectedRef.current = false
        setSecretRef(null)
        setOpen(false)
        return
      }
      for (const modelId of models) {
        const displayName = models.length === 1
          ? undefined
          : `${form.displayName.trim() || selectedTemplate.displayName} · ${modelId}`
        const saved = await runtimeProfileCreate(buildQuickConnectCreateRequest(
          selectedTemplate,
          form,
          ref,
          includeAgentTask,
          modelId,
          displayName,
        ))
        created.push(saved)
        createdModelIdsRef.current.add(modelId)
        if (ref) secretRefProtectedRef.current = true
        onProfileCreated(saved)
      }
      profileCreatedRef.current = true
      secretRefRef.current = null
      secretRefProtectedRef.current = false
      setSecretRef(null)
      setOpen(false)
    } catch (error) {
      if (created.length > 0) {
        profileCreatedRef.current = true
      }
      const createdProfiles = created.length > 0
        ? ` ${t("settings.sections.llm.profiles.wizard.createdBeforeFailure", {
            names: created.map((profile) => profile.displayName).join(", "),
          })}`
        : ""
      setCreateMessage(t("settings.sections.llm.profiles.wizard.createFailed", {
        message: `${errorMessage(error)}${createdProfiles}`,
      }))
    } finally {
      creatingRef.current = false
      setCreating(false)
    }
  }

  function openKeyUrl() {
    if (!selectedTemplate) return
    void openUrl(selectedTemplate.apiKeyUrl ?? selectedTemplate.websiteUrl).catch(() => undefined)
  }

  if (!selectedTemplate) return null

  return (
    <>
      <button
        type="button"
        className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
        data-testid="profile-quick-connect"
        disabled={disabled}
        onClick={() => handleOpenChange(true)}
      >
        <KeyRound className="h-3.5 w-3.5" />
        {triggerLabel ?? t("settings.sections.llm.profiles.wizard.open")}
      </button>
      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogContent
          className="flex max-h-[85vh] flex-col overflow-hidden sm:max-w-3xl"
          data-testid="provider-access-wizard"
        >
          <DialogHeader className="shrink-0">
            <DialogTitle>{t("settings.sections.llm.profiles.wizard.title")}</DialogTitle>
            <DialogDescription>
              {t("settings.sections.llm.profiles.wizard.description")}
            </DialogDescription>
          </DialogHeader>

          <div className="flex shrink-0 flex-wrap gap-2 text-xs">
            {[1, 2, 3].map((value) => (
              <span
                key={value}
                className={`rounded-full px-2 py-1 ${
                  step === value ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"
                }`}
                data-testid={`wizard-step-${value}`}
              >
                {t(`settings.sections.llm.profiles.wizard.steps.${value}`)}
              </span>
            ))}
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto pr-1">
            {step === 1 && (
              <div className="space-y-3" data-testid="wizard-provider-step">
                <div className="relative">
                  <Search className="pointer-events-none absolute left-2 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
                  <Input
                    data-testid="wizard-search"
                    className="pl-7"
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                    placeholder={t("settings.sections.llm.profiles.wizard.searchPlaceholder")}
                  />
                </div>
                <div className="space-y-4">
                  {groupedTemplates.map(({ group, templates }) => templates.length > 0 && (
                    <section key={group} className="space-y-2">
                      <h4 className="text-xs font-medium text-muted-foreground">
                        {t(`settings.sections.llm.profiles.wizard.groups.${group}`)}
                      </h4>
                      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                        {templates.map((template) => (
                          <button
                            key={template.id}
                            type="button"
                            data-testid={`wizard-template-${template.id}`}
                            onClick={() => selectTemplate(template)}
                            className={`rounded-md border px-3 py-2 text-left text-sm hover:bg-accent ${
                              selectedTemplateId === template.id ? "border-primary bg-primary/5" : "border-border"
                            }`}
                          >
                            <span className="block truncate font-medium">{template.displayName}</span>
                            <span className="mt-1 inline-flex rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">
                              {t(`settings.sections.llm.profiles.wizard.groups.${template.group}`)}
                            </span>
                          </button>
                        ))}
                      </div>
                    </section>
                  ))}
                </div>
              </div>
            )}

            {step === 2 && (
              <div className="grid gap-3 md:grid-cols-2" data-testid="wizard-key-step">
                <div className="space-y-1.5">
                  <Label>{t("settings.sections.llm.profiles.displayName")}</Label>
                  <Input
                    data-testid="wizard-display-name"
                    value={form.displayName}
                    onChange={(event) => setForm((current) => ({ ...current, displayName: event.target.value }))}
                  />
                </div>
                <div className="space-y-1.5">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <Label>{t("settings.model")}</Label>
                    <button
                      type="button"
                      data-testid="wizard-fetch-models"
                      onClick={() => void loadModelList()}
                      disabled={modelListState.kind === "loading" || Boolean(runtimeUnavailableMessage)}
                      className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs hover:bg-accent disabled:opacity-60"
                    >
                      {modelListState.kind === "loading" && <Loader2 className="h-3 w-3 animate-spin" />}
                      {t("settings.sections.llm.profiles.wizard.fetchModels")}
                    </button>
                  </div>
                  <Input
                    data-testid="wizard-model-id"
                    value={form.modelId}
                    onChange={(event) => {
                      const nextModel = event.target.value
                      const previousManual = form.modelId.trim() || selectedTemplate.defaultModelId
                      setForm((current) => ({ ...current, modelId: nextModel }))
                      setSelectedModelIds((current) => current.includes(previousManual)
                        ? current.map((model) => model === previousManual
                            ? (nextModel.trim() || selectedTemplate.defaultModelId)
                            : model)
                        : current)
                      setProbeState({ kind: "idle" })
                      setRetestMessage(null)
                    }}
                  />
                  {modelListState.kind === "ready" && (
                    <div className="space-y-2 rounded-md border p-2" data-testid="wizard-model-list">
                      <div className="text-[10px] text-muted-foreground">
                        {t("settings.sections.llm.profiles.wizard.modelsSource", {
                          url: modelListState.sourceUrl,
                        })}
                      </div>
                      <div className="max-h-36 space-y-1 overflow-y-auto pr-1">
                        {modelListState.models.map((model) => (
                          <label key={model} className="flex items-center gap-2 text-xs">
                            <input
                              data-testid={`wizard-model-option-${model}`}
                              type="checkbox"
                              checked={selectedModelIds.includes(model)}
                              onChange={(event) => toggleSelectedModel(model, event.target.checked)}
                            />
                            <span className="truncate">{model}</span>
                          </label>
                        ))}
                        <label className="flex items-center gap-2 text-xs">
                          <input
                            data-testid="wizard-model-option-manual"
                            type="checkbox"
                            checked={selectedModelIds.includes(form.modelId.trim() || selectedTemplate.defaultModelId)}
                            onChange={(event) => toggleSelectedModel(
                              form.modelId.trim() || selectedTemplate.defaultModelId,
                              event.target.checked,
                            )}
                          />
                          <span className="truncate">
                            {t("settings.sections.llm.profiles.wizard.manualModel", {
                              model: form.modelId.trim() || selectedTemplate.defaultModelId,
                            })}
                          </span>
                        </label>
                      </div>
                    </div>
                  )}
                  {modelListState.kind === "error" && (
                    <p
                      className="rounded-md border border-amber-500/40 bg-amber-500/5 px-2 py-1.5 text-xs text-amber-700 dark:text-amber-300"
                      data-testid="wizard-model-list-error"
                    >
                      {t("settings.sections.llm.profiles.wizard.modelsFallback", {
                        message: modelListState.message,
                      })}
                    </p>
                  )}
                </div>
                <div className="space-y-1.5 md:col-span-2">
                  <Label>{t("settings.sections.llm.endpoint")}</Label>
                  {selectedTemplate.endpointCandidates && selectedTemplate.endpointCandidates.length > 1 ? (
                    <select
                      data-testid="wizard-endpoint"
                      className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                      value={form.endpoint}
                      onChange={(event) => {
                        setForm((current) => ({ ...current, endpoint: event.target.value }))
                        setProbeState({ kind: "idle" })
                        setModelListState({ kind: "idle" })
                        setSelectedModelIds([form.modelId.trim() || selectedTemplate.defaultModelId])
                        setRetestMessage(null)
                      }}
                    >
                      {selectedTemplate.endpointCandidates.map((endpoint) => (
                        <option key={endpoint} value={endpoint}>{endpoint}</option>
                      ))}
                    </select>
                  ) : (
                    <Input
                      data-testid="wizard-endpoint"
                      value={form.endpoint}
                      onChange={(event) => {
                        setForm((current) => ({ ...current, endpoint: event.target.value }))
                        setProbeState({ kind: "idle" })
                        setModelListState({ kind: "idle" })
                        setSelectedModelIds([form.modelId.trim() || selectedTemplate.defaultModelId])
                        setRetestMessage(null)
                      }}
                    />
                  )}
                </div>
                {authStyleRequiresSecret(selectedTemplate) ? (
                  <div className="space-y-1.5 md:col-span-2">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <Label>{t("settings.apiKey")}</Label>
                      <button
                        type="button"
                        className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
                        data-testid="wizard-api-key-url"
                        onClick={openKeyUrl}
                      >
                        {t("settings.sections.llm.profiles.wizard.getApiKey")}
                        <ExternalLink className="h-3 w-3" />
                      </button>
                    </div>
                    <Input
                      data-testid="wizard-api-key"
                      type="password"
                      value={form.apiKey}
                      onChange={(event) => {
                        if (secretRefRef.current) {
                          void cleanupDraftSecret()
                        }
                        setForm((current) => ({ ...current, apiKey: event.target.value }))
                        setProbeState({ kind: "idle" })
                        setModelListState({ kind: "idle" })
                        setSelectedModelIds([form.modelId.trim() || selectedTemplate.defaultModelId])
                        setRetestMessage(null)
                      }}
                      placeholder={t("settings.sections.llm.profiles.wizard.keyPlaceholder")}
                    />
                    {secretRef && (
                      <p className="text-xs text-muted-foreground">
                        {t("settings.sections.llm.profiles.wizard.secretStored")}
                      </p>
                    )}
                  </div>
                ) : (
                  <p
                    className="rounded-md border bg-muted/40 px-3 py-2 text-xs text-muted-foreground md:col-span-2"
                    data-testid="wizard-no-key-note"
                  >
                    {selectedTemplate.notes ?? t("settings.sections.llm.profiles.wizard.noKeyRequired")}
                  </p>
                )}
                {selectedTemplate.notes && authStyleRequiresSecret(selectedTemplate) && (
                  <p className="rounded-md border bg-muted/40 px-3 py-2 text-xs text-muted-foreground md:col-span-2">
                    {selectedTemplate.notes}
                  </p>
                )}
              </div>
            )}

            {step === 3 && (
              <div className="space-y-3" data-testid="wizard-test-step">
                <div className="rounded-md border px-3 py-2 text-sm">
                  <div className="flex flex-wrap items-center gap-2">
                    <div className="font-medium">{form.displayName || selectedTemplate.displayName}</div>
                    {probeState.kind === "success" && (
                      <ProfileCapabilityBadge status={probeState.result.status} t={t} />
                    )}
                  </div>
                  <div className="mt-1 text-xs text-muted-foreground">
                    {selectedTemplate.displayName} / {selectedModelsForCreate().join(", ")}
                  </div>
                  <div className="mt-1 break-all text-xs text-muted-foreground">{form.endpoint}</div>
                </div>
                {selectedTemplate.notes && (
                  <p className="rounded-md border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
                    {selectedTemplate.notes}
                  </p>
                )}
                <button
                  type="button"
                  data-testid="wizard-test-connection"
                  onClick={() => void runWizardProbe()}
                  disabled={probeState.kind === "running" || Boolean(runtimeUnavailableMessage)}
                  className="inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm hover:bg-accent disabled:opacity-60"
                >
                  {probeState.kind === "running" && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                  {t("settings.sections.llm.profiles.wizard.test")}
                </button>
                {probeState.kind === "idle" && (
                  <p className="text-xs text-muted-foreground">
                    {t("settings.sections.llm.profiles.wizard.testHint")}
                  </p>
                )}
                {retestMessage && (
                  <p className="text-xs text-muted-foreground" data-testid="wizard-retest-message">
                    {retestMessage}
                  </p>
                )}
                {probeState.kind === "success" && (
                  <div
                    className={`flex items-start gap-2 rounded-md border px-3 py-2 text-xs ${
                      capabilityBadgeMeta(probeState.result.status, t).className
                    }`}
                    data-testid="wizard-probe-success"
                  >
                    <CheckCircle2 className="mt-0.5 h-3.5 w-3.5" />
                    <span>
                      {t("settings.sections.llm.profiles.wizard.testSuccess", {
                        latency: probeState.latencyMs,
                      })}
                      {probeState.result.message ? ` ${probeState.result.message}` : ""}
                    </span>
                  </div>
                )}
                {probeState.kind === "error" && (
                  <div
                    className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive"
                    data-testid="wizard-probe-error"
                  >
                    <AlertCircle className="mt-0.5 h-3.5 w-3.5" />
                    <span>{probeState.message}</span>
                  </div>
                )}
                {selectedTemplate.agentSupport === "none" && (
                  <p className="rounded-md border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
                    {t("settings.sections.llm.profiles.wizard.noAgentSupport")}
                  </p>
                )}
                {selectedTemplate.agentSupport === "anthropic-compat" && !probePassed(probeState) && (
                  <p className="rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
                    {t("settings.sections.llm.profiles.wizard.agentRequiresPassedTest")}
                  </p>
                )}
                {createMessage && (
                  <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">
                    {createMessage}
                  </div>
                )}
              </div>
            )}
          </div>

          <DialogFooter className="shrink-0 items-center">
            <button
              type="button"
              className="rounded-md border px-3 py-1.5 text-sm hover:bg-accent"
              data-testid="wizard-cancel"
              onClick={() => handleOpenChange(false)}
            >
              {t("common.cancel")}
            </button>
            {step > 1 && (
              <button
                type="button"
                className="rounded-md border px-3 py-1.5 text-sm hover:bg-accent"
                data-testid="wizard-back"
                onClick={() => setStep((current) => (current === 3 ? 2 : 1))}
              >
                {t("common.back")}
              </button>
            )}
            {step === 2 ? (
              <button
                type="button"
                className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground hover:bg-primary/90"
                data-testid="wizard-next"
                onClick={() => setStep(3)}
              >
                {t("common.next")}
              </button>
            ) : step === 3 ? (
              <button
                type="button"
                className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
                data-testid="wizard-finish"
                disabled={creating}
                onClick={() => void finishWizard()}
              >
                {creating && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                {probeState.kind === "error"
                  ? t("settings.sections.llm.profiles.wizard.createAnyway")
                  : t("settings.sections.llm.profiles.wizard.finish")}
              </button>
            ) : null}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
