import { useCallback, useEffect, useMemo, useState } from "react"
import {
  Bot,
  Binary,
  Globe,
  Languages,
  Palette,
  Settings,
  Info,
  Image as ImageIcon,
  Network,
  History,
  Wrench,
  Clock,
  FileText,
  FolderSync,
  Server,
  SlidersHorizontal,
  BrainCircuit,
  Tags,
  GitMerge,
  Layers,
} from "lucide-react"
import { useTranslation } from "react-i18next"
import { invoke } from "@tauri-apps/api/core"
import i18n from "@/i18n"
import { Button } from "@/components/ui/button"
import { useWikiStore } from "@/stores/wiki-store"
import { useChatStore } from "@/stores/chat-store"
import { useAgentSettingsStore } from "@/stores/agent-settings-store"
import { useUpdateStore, hasAvailableUpdate } from "@/stores/update-store"
import { useZoomStore } from "@/stores/zoom-store"
import { loadCloseBehavior, loadSourceWatchConfig, loadTheme, saveLanguage, type CloseBehavior } from "@/lib/project-store"
import { saveAgentResourceConfig } from "@/lib/agent/agent-settings"
import { activateThemePreference, readThemeMirror, type AppTheme } from "@/lib/theme"
import type { SettingsDraft, DraftSetter } from "./settings-types"
import { normalizeSourceWatchConfig } from "@/lib/source-watch-config"
import { LlmProviderSection } from "./sections/llm-provider-section"
import { ModelProfilesSection } from "./sections/model-profiles-section"
import { EmbeddingSection } from "./sections/embedding-section"
import { MultimodalSection } from "./sections/multimodal-section"
import { WebSearchSection } from "./sections/web-search-section"
import { OutputSection } from "./sections/output-section"
import { InterfaceSection } from "./sections/interface-section"
import { GeneralSection } from "./sections/general-section"
import { NetworkSection } from "./sections/network-section"
import { ScheduledImportSection } from "./sections/scheduled-import-section"
import { SourceWatchSection } from "./sections/source-watch-section"
import { MineruSection } from "./sections/mineru-section"
import { ApiServerSection } from "./sections/api-server-section"
import { AgentSection } from "./sections/agent-section"
import { KnowledgeAgentsSection } from "./sections/knowledge-agents-section"
import { TagTaxonomySection } from "./sections/tag-taxonomy-section"
import { SynthesisSection } from "./sections/synthesis-section"
import { ChangelogSection } from "./sections/changelog-section"
import { MaintenanceSection } from "./sections/maintenance-section"
import { AboutSection } from "./sections/about-section"
import {
  clampMineruPollIntervalMs,
  clampMineruPollTimeoutMs,
  MINERU_DEFAULT_POLL_INTERVAL_MS,
  MINERU_DEFAULT_POLL_TIMEOUT_MS,
} from "@/lib/mineru-config"

export type CategoryId =
  | "llm"
  | "model-profiles"
  | "embedding"
  | "multimodal"
  | "web-search"
  | "network"
  | "source-watch"
  | "scheduled-import"
  | "mineru"
  | "api-server"
  | "agent"
  | "knowledge-agents"
  | "taxonomy"
  | "synthesis"
  | "general"
  | "output"
  | "interface"
  | "maintenance"
  | "changelog"
  | "about"

interface RuntimeNavigatorLike {
  platform?: string
  userAgent?: string
  userAgentData?: {
    platform?: string
  }
}

interface Category {
  id: CategoryId
  /** i18n key under settings.categories — resolved at render time so
   *  switching language in Settings → Interface takes effect without
   *  remounting this component (Bug #53). */
  labelKey: string
  icon: typeof Bot
}

const CATEGORIES: Category[] = [
  { id: "llm", labelKey: "settings.categories.llm", icon: Bot },
  { id: "model-profiles", labelKey: "settings.categories.modelProfiles", icon: Layers },
  { id: "embedding", labelKey: "settings.categories.embedding", icon: Binary },
  { id: "multimodal", labelKey: "settings.categories.multimodal", icon: ImageIcon },
  { id: "web-search", labelKey: "settings.categories.webSearch", icon: Globe },
  { id: "network", labelKey: "settings.categories.network", icon: Network },
  { id: "source-watch", labelKey: "settings.categories.sourceWatch", icon: FolderSync },
  { id: "scheduled-import", labelKey: "settings.categories.scheduledImport", icon: Clock },
  { id: "mineru", labelKey: "settings.categories.mineru", icon: FileText },
  { id: "api-server", labelKey: "settings.categories.apiServer", icon: Server },
  { id: "agent", labelKey: "settings.categories.agent", icon: SlidersHorizontal },
  { id: "knowledge-agents", labelKey: "settings.categories.knowledgeAgents", icon: BrainCircuit },
  { id: "taxonomy", labelKey: "settings.categories.taxonomy", icon: Tags },
  { id: "synthesis", labelKey: "settings.categories.synthesis", icon: GitMerge },
  { id: "general", labelKey: "settings.categories.general", icon: Settings },
  { id: "output", labelKey: "settings.categories.output", icon: Languages },
  { id: "interface", labelKey: "settings.categories.interface", icon: Palette },
  { id: "maintenance", labelKey: "settings.categories.maintenance", icon: Wrench },
  { id: "changelog", labelKey: "settings.categories.changelog", icon: History },
  { id: "about", labelKey: "settings.categories.about", icon: Info },
]

// These sections own their persistence instead of writing through SettingsDraft.
const INLINE_PERSIST_SETTINGS_CATEGORIES = new Set<CategoryId>([
  "about",
  "llm",
  "model-profiles",
  "knowledge-agents",
  "taxonomy",
  "synthesis",
])

export function isMacLikeRuntime(
  navigatorLike: RuntimeNavigatorLike =
    typeof globalThis.navigator === "undefined" ? {} : globalThis.navigator,
): boolean {
  const signals = [
    navigatorLike.userAgentData?.platform,
    navigatorLike.platform,
    navigatorLike.userAgent,
  ]
  return signals.some((signal) => /mac|darwin/i.test(signal ?? ""))
}

export function getSettingsCategories(isMacLike = isMacLikeRuntime()): Category[] {
  return isMacLike ? CATEGORIES : CATEGORIES.filter((category) => category.id !== "general")
}

export function coerceSettingsCategory(
  active: CategoryId,
  categories: Category[],
): CategoryId {
  return categories.some((category) => category.id === active)
    ? active
    : categories[0]?.id ?? "llm"
}

/** Returns whether the shared Settings draft Save bar should be shown. */
export function shouldShowGlobalSettingsSaveBar(activeCategory: CategoryId): boolean {
  return !INLINE_PERSIST_SETTINGS_CATEGORIES.has(activeCategory)
}

export function initialDraft(
  llm: ReturnType<typeof useWikiStore.getState>["llmConfig"],
  embed: ReturnType<typeof useWikiStore.getState>["embeddingConfig"],
  multimodal: ReturnType<typeof useWikiStore.getState>["multimodalConfig"],
  outputLanguage: ReturnType<typeof useWikiStore.getState>["outputLanguage"],
  proxy: ReturnType<typeof useWikiStore.getState>["proxyConfig"],
  scheduledImport: ReturnType<typeof useWikiStore.getState>["scheduledImportConfig"],
  sourceWatch: ReturnType<typeof useWikiStore.getState>["sourceWatchConfig"],
  mineru: ReturnType<typeof useWikiStore.getState>["mineruConfig"],
  apiConfig: ReturnType<typeof useWikiStore.getState>["apiConfig"],
  agentConfig: ReturnType<typeof useAgentSettingsStore.getState>["resourceConfig"],
  maxHistoryMessages: number,
  uiLanguage: string,
  projectPath?: string,
  zoomLevel?: number,
  theme: AppTheme = readThemeMirror(),
  closeBehavior: CloseBehavior = "hide",
): SettingsDraft {
  // Show absolute path: if stored path is empty, show default using project path
  // If stored path is relative (legacy), prepend project path
  // If stored path is absolute, show as-is
  let displayPath = scheduledImport.path || ""
  if (!displayPath && projectPath) {
    displayPath = `${projectPath}/raw/sources`
  } else if (displayPath && projectPath && !displayPath.startsWith("/") && !displayPath.match(/^[a-zA-Z]:[/\\]/)) {
    // Legacy relative path - prepend project path for display
    displayPath = `${projectPath}/${displayPath}`
  }

  return {
    provider: llm.provider,
    apiKey: llm.apiKey,
    model: llm.model,
    ollamaUrl: llm.ollamaUrl,
    customEndpoint: llm.customEndpoint,
    azureApiVersion: llm.azureApiVersion ?? "2024-10-21",
    azureModelFamily: llm.azureModelFamily ?? "auto",
    maxContextSize: llm.maxContextSize ?? 204800,
    apiMode: llm.apiMode,
    reasoning: llm.reasoning,
    localCliIsolation: llm.localCliIsolation ?? false,
    claudeCliTimeoutMinutes: llm.claudeCliTimeoutMinutes,
    codexCliTimeoutMinutes: llm.codexCliTimeoutMinutes ?? 10,
    embeddingEnabled: embed.enabled,
    embeddingEndpoint: embed.endpoint,
    embeddingApiKey: embed.apiKey,
    embeddingModel: embed.model,
    embeddingOutputDimensionality: embed.outputDimensionality,
    embeddingMaxChunkChars: embed.maxChunkChars,
    embeddingOverlapChunkChars: embed.overlapChunkChars,
    embeddingExtraHeaders: embed.extraHeaders,
    multimodalEnabled: multimodal.enabled,
    multimodalUseMainLlm: multimodal.useMainLlm,
    multimodalProvider: multimodal.provider,
    multimodalApiKey: multimodal.apiKey,
    multimodalModel: multimodal.model,
    multimodalOllamaUrl: multimodal.ollamaUrl,
    multimodalCustomEndpoint: multimodal.customEndpoint,
    multimodalAzureApiVersion: multimodal.azureApiVersion ?? "2024-10-21",
    multimodalAzureModelFamily: multimodal.azureModelFamily ?? "auto",
    multimodalApiMode: multimodal.apiMode,
    multimodalConcurrency: multimodal.concurrency,
    outputLanguage,
    maxHistoryMessages,
    proxyEnabled: proxy.enabled,
    proxyUrl: proxy.url,
    proxyBypassLocal: proxy.bypassLocal,
    scheduledImportEnabled: scheduledImport.enabled,
    scheduledImportPath: displayPath,
    scheduledImportInterval: scheduledImport.interval,
    sourceWatchConfig: normalizeSourceWatchConfig(sourceWatch),
    mineruEnabled: mineru.enabled,
    mineruToken: mineru.token,
    mineruModelVersion: mineru.modelVersion,
    mineruApiBaseUrl: mineru.apiBaseUrl ?? "",
    mineruPollIntervalSeconds: clampMineruPollIntervalMs(
      mineru.pollIntervalMs ?? MINERU_DEFAULT_POLL_INTERVAL_MS,
    ) / 1000,
    mineruPollTimeoutMinutes: clampMineruPollTimeoutMs(
      mineru.pollTimeoutMs ?? MINERU_DEFAULT_POLL_TIMEOUT_MS,
    ) / 60000,
    apiEnabled: apiConfig.enabled,
    apiAllowUnauthenticated: apiConfig.allowUnauthenticated,
    apiMcpEnabled: apiConfig.mcpEnabled ?? false,
    apiToken: apiConfig.token,
    agentMaxTurns: agentConfig.maxTurns,
    agentMaxFilesChanged: agentConfig.maxFilesChanged,
    agentMaxWriteKiB: Math.max(1, Math.round(agentConfig.maxWriteBytes / 1024)),
    uiLanguage,
    zoomLevel: zoomLevel ?? useZoomStore.getState().level,
    theme,
    closeBehavior,
  }
}

export function apiConfigFromDraft(draft: SettingsDraft) {
  return {
    enabled: draft.apiEnabled,
    allowUnauthenticated: draft.apiAllowUnauthenticated,
    mcpEnabled: draft.apiMcpEnabled,
    token: draft.apiToken.trim(),
  }
}

export function mineruConfigFromDraft(draft: SettingsDraft) {
  return {
    enabled: draft.mineruEnabled,
    token: draft.mineruToken.trim(),
    modelVersion: draft.mineruModelVersion,
    apiBaseUrl: draft.mineruApiBaseUrl.trim(),
    pollIntervalMs: clampMineruPollIntervalMs(draft.mineruPollIntervalSeconds * 1000),
    pollTimeoutMs: clampMineruPollTimeoutMs(draft.mineruPollTimeoutMinutes * 60000),
  }
}

export async function persistAppPreferences(
  draft: Pick<SettingsDraft, "theme" | "closeBehavior">,
  deps: {
    saveTheme: (theme: AppTheme) => Promise<void>
    saveCloseBehavior: (behavior: CloseBehavior) => Promise<void>
    activateThemePreference: (theme: AppTheme) => unknown
    setSavedTheme: (theme: AppTheme) => void
    setSavedCloseBehavior: (behavior: CloseBehavior) => void
  },
): Promise<void> {
  await deps.saveTheme(draft.theme)
  deps.setSavedTheme(draft.theme)
  deps.activateThemePreference(draft.theme)
  await deps.saveCloseBehavior(draft.closeBehavior)
  deps.setSavedCloseBehavior(draft.closeBehavior)
}

export function SettingsView() {
  const { t } = useTranslation()
  const project = useWikiStore((s) => s.project)
  const llmConfig = useWikiStore((s) => s.llmConfig)
  const setLlmConfig = useWikiStore((s) => s.setLlmConfig)
  const embeddingConfig = useWikiStore((s) => s.embeddingConfig)
  const setEmbeddingConfig = useWikiStore((s) => s.setEmbeddingConfig)
  const multimodalConfig = useWikiStore((s) => s.multimodalConfig)
  const setMultimodalConfig = useWikiStore((s) => s.setMultimodalConfig)
  const outputLanguage = useWikiStore((s) => s.outputLanguage)
  const setOutputLanguage = useWikiStore((s) => s.setOutputLanguage)
  const proxyConfig = useWikiStore((s) => s.proxyConfig)
  const setProxyConfig = useWikiStore((s) => s.setProxyConfig)
  const scheduledImportConfig = useWikiStore((s) => s.scheduledImportConfig)
  const setScheduledImportConfig = useWikiStore((s) => s.setScheduledImportConfig)
  const sourceWatchConfig = useWikiStore((s) => s.sourceWatchConfig)
  const setSourceWatchConfig = useWikiStore((s) => s.setSourceWatchConfig)
  const mineruConfig = useWikiStore((s) => s.mineruConfig)
  const setMineruConfig = useWikiStore((s) => s.setMineruConfig)
  const apiConfig = useWikiStore((s) => s.apiConfig)
  const setApiConfig = useWikiStore((s) => s.setApiConfig)
  const agentConfig = useAgentSettingsStore((s) => s.resourceConfig)
  const setAgentResourceConfig = useAgentSettingsStore((s) => s.setResourceConfig)
  const maxHistoryMessages = useChatStore((s) => s.maxHistoryMessages)
  const setMaxHistoryMessages = useChatStore((s) => s.setMaxHistoryMessages)
  const zoomLevel = useZoomStore((s) => s.level)
  // Drives the red dot next to the "About" row in the settings
  // sidebar. Uses `hasAvailableUpdate` (NOT `shouldShowUpdateBanner`)
  // so the indicator remains even after the user dismisses the
  // top banner — the user explicitly asked for the gear/About dots
  // to keep showing as a signpost so they can find the update
  // again later. The top banner stays gated by the dismiss
  // preference so the more aggressive interruption only fires once
  // per version.
  const updateAvailable = useUpdateStore((s) => hasAvailableUpdate(s))

  const [active, setActive] = useState<CategoryId>("llm")
  const [saved, setSaved] = useState(false)
  const [savedTheme, setSavedTheme] = useState<AppTheme>(() => readThemeMirror())
  const [savedCloseBehavior, setSavedCloseBehavior] = useState<CloseBehavior>("hide")
  const [draft, setDraftState] = useState<SettingsDraft>(() =>
    initialDraft(
      llmConfig,
      embeddingConfig,
      multimodalConfig,
      outputLanguage,
      proxyConfig,
      scheduledImportConfig,
      sourceWatchConfig,
      mineruConfig,
      apiConfig,
      agentConfig,
      maxHistoryMessages,
      i18n.language,
      project?.path,
      zoomLevel,
      savedTheme,
      savedCloseBehavior,
    ),
  )

  useEffect(() => {
    let cancelled = false
    Promise.all([loadTheme(), loadCloseBehavior()]).then(([theme, closeBehavior]) => {
      if (cancelled) return
      setDraftState((prev) => ({
        ...prev,
        theme: prev.theme === savedTheme ? theme : prev.theme,
        closeBehavior:
          prev.closeBehavior === savedCloseBehavior
            ? closeBehavior
            : prev.closeBehavior,
      }))
      setSavedTheme(theme)
      setSavedCloseBehavior(closeBehavior)
    }).catch(() => {
      // Keep defaults if global preferences cannot be read.
    })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    loadSourceWatchConfig(project?.id).then((config) => {
      if (cancelled) return
      const normalized = normalizeSourceWatchConfig(config)
      setSourceWatchConfig(normalized)
      setDraftState((prev) => ({ ...prev, sourceWatchConfig: normalized }))
    }).catch(() => {
      if (cancelled) return
      const fallback = normalizeSourceWatchConfig()
      setSourceWatchConfig(fallback)
      setDraftState((prev) => ({ ...prev, sourceWatchConfig: fallback }))
    })
    return () => {
      cancelled = true
    }
  }, [project?.id, setSourceWatchConfig])

  // Resync draft from store if it changes out-of-band (e.g. project switch).
  // IMPORTANT: keep the current draft.uiLanguage instead of re-reading
  // `i18n.language`. handleSave calls multiple zustand setters before it
  // calls `i18n.changeLanguage` at the end, and each setter triggers this
  // effect mid-save — which used to clobber the user's pending language
  // pick with the still-stale `i18n.language`. The next save would then
  // see draft.uiLanguage out of sync with i18n.language and silently
  // revert the UI to the previous language.
  // Preserve pending zoom edits the same way; unrelated store updates can
  // happen before the user presses Save.
  // Theme and close behavior are global app-state preferences; preserve
  // pending edits across the same mid-save resyncs.
  useEffect(() => {
    setDraftState((prev) =>
      initialDraft(
        llmConfig,
        embeddingConfig,
        multimodalConfig,
        outputLanguage,
        proxyConfig,
        scheduledImportConfig,
        sourceWatchConfig,
        mineruConfig,
        apiConfig,
        agentConfig,
        maxHistoryMessages,
        prev.uiLanguage,
        project?.path,
        prev.zoomLevel,
        prev.theme,
        prev.closeBehavior,
      ),
    )
  }, [
    llmConfig,
    embeddingConfig,
    multimodalConfig,
    outputLanguage,
    proxyConfig,
    scheduledImportConfig,
    sourceWatchConfig,
    mineruConfig,
    apiConfig,
    agentConfig,
    maxHistoryMessages,
    project,
  ])

  const setDraft: DraftSetter = useCallback((key, value) => {
    setDraftState((prev) => ({ ...prev, [key]: value }))
  }, [])

  const categories = useMemo(() => getSettingsCategories(), [])
  const activeCategory = coerceSettingsCategory(active, categories)

  useEffect(() => {
    if (active !== activeCategory) {
      setActive(activeCategory)
    }
  }, [active, activeCategory])

  const handleSave = useCallback(async () => {
    const {
      saveLlmConfig,
      saveEmbeddingConfig,
      saveMultimodalConfig,
      saveOutputLanguage,
      saveProxyConfig,
      saveScheduledImportConfig,
      saveSourceWatchConfig,
      saveMineruConfig,
      saveApiConfig,
      saveZoomLevel,
      saveTheme,
      saveCloseBehavior,
    } = await import("@/lib/project-store")

    const newLlm = {
      provider: draft.provider,
      apiKey: draft.apiKey,
      model: draft.model,
      ollamaUrl: draft.ollamaUrl,
      customEndpoint: draft.customEndpoint,
      azureApiVersion: draft.provider === "azure" ? draft.azureApiVersion.trim() : undefined,
      azureModelFamily: draft.provider === "azure" ? draft.azureModelFamily : undefined,
      maxContextSize: draft.maxContextSize,
      apiMode: draft.provider === "custom" ? draft.apiMode : undefined,
      reasoning: draft.reasoning,
      localCliIsolation: draft.localCliIsolation,
      claudeCliTimeoutMinutes: draft.claudeCliTimeoutMinutes,
      codexCliTimeoutMinutes: draft.codexCliTimeoutMinutes,
    }
    const newEmbed = {
      enabled: draft.embeddingEnabled,
      endpoint: draft.embeddingEndpoint,
      apiKey: draft.embeddingApiKey,
      model: draft.embeddingModel,
      outputDimensionality: draft.embeddingOutputDimensionality,
      maxChunkChars: draft.embeddingMaxChunkChars,
      overlapChunkChars: draft.embeddingOverlapChunkChars,
      extraHeaders: draft.embeddingExtraHeaders,
    }
    const newMultimodal = {
      enabled: draft.multimodalEnabled,
      useMainLlm: draft.multimodalUseMainLlm,
      provider: draft.multimodalProvider,
      apiKey: draft.multimodalApiKey,
      model: draft.multimodalModel,
      ollamaUrl: draft.multimodalOllamaUrl,
      customEndpoint: draft.multimodalCustomEndpoint,
      azureApiVersion: draft.multimodalProvider === "azure" ? draft.multimodalAzureApiVersion.trim() : undefined,
      azureModelFamily: draft.multimodalProvider === "azure" ? draft.multimodalAzureModelFamily : undefined,
      apiMode: draft.multimodalProvider === "custom" ? draft.multimodalApiMode : undefined,
      // Clamp at save time so a hand-edited persisted store with a
      // ridiculous concurrency value (e.g. someone setting 1000 in
      // the JSON) doesn't blow up the captioning pipeline. Caption
      // calls already share the LLM endpoint with everything else;
      // going wider than ~16 just queues behind the server's batch
      // slot.
      concurrency: Math.max(1, Math.min(16, draft.multimodalConcurrency || 4)),
    }

    const newProxy = {
      enabled: draft.proxyEnabled,
      url: draft.proxyUrl.trim(),
      bypassLocal: draft.proxyBypassLocal,
    }
    const newMineru = mineruConfigFromDraft(draft)

    setLlmConfig(newLlm)
    await saveLlmConfig(newLlm)
    setEmbeddingConfig(newEmbed)
    await saveEmbeddingConfig(newEmbed)
    setMultimodalConfig(newMultimodal)
    await saveMultimodalConfig(newMultimodal)
    setMineruConfig(newMineru)
    await saveMineruConfig(newMineru)
    setOutputLanguage(draft.outputLanguage as typeof outputLanguage)
    await saveOutputLanguage(draft.outputLanguage as typeof outputLanguage, project?.id)
    setProxyConfig(newProxy)
    await saveProxyConfig(newProxy)
    const newSourceWatch = normalizeSourceWatchConfig(draft.sourceWatchConfig)
    setSourceWatchConfig(newSourceWatch)
    await saveSourceWatchConfig(newSourceWatch, project?.id)
    if (project) {
      const { startProjectFileSync, stopProjectFileSync } = await import("@/lib/project-file-sync")
      if (newSourceWatch.enabled) {
        await startProjectFileSync(project, newSourceWatch).catch((err) =>
          console.error("Failed to start project file sync:", err)
        )
      } else {
        await stopProjectFileSync()
      }
    }
    // Apply the proxy env vars LIVE so the next outbound request
    // picks them up — no app restart needed. tauri-plugin-http
    // builds a fresh reqwest client per fetch and reqwest reads
    // env vars at build time, so changing them here is enough.
    try {
      await invoke<string>("set_proxy_env", { config: newProxy })
    } catch (err) {
      console.warn("[proxy] live update failed; restart will still apply:", err)
    }

    const newScheduledImport = {
      enabled: draft.scheduledImportEnabled,
      path: draft.scheduledImportPath,
      interval: Math.max(1, Math.min(1440, draft.scheduledImportInterval || 60)),
      lastScan: scheduledImportConfig.lastScan,
    }
    setScheduledImportConfig(newScheduledImport)
    if (project) {
      await saveScheduledImportConfig(project.path, newScheduledImport)
      const { startScheduledImport, stopScheduledImport } = await import("@/lib/scheduled-import")
      if (
        newScheduledImport.enabled &&
        newScheduledImport.path &&
        newScheduledImport.interval > 0
      ) {
        startScheduledImport(project, newScheduledImport)
      } else {
        stopScheduledImport()
      }
    }

    setMaxHistoryMessages(draft.maxHistoryMessages)
    useZoomStore.getState().setLevel(draft.zoomLevel)
    await saveZoomLevel(draft.zoomLevel)
    await persistAppPreferences(draft, {
      saveTheme,
      saveCloseBehavior,
      activateThemePreference,
      setSavedTheme,
      setSavedCloseBehavior,
    })

    // ── API server: persist + push to store. The Rust side reads
    // `apiConfig.{enabled,token,mcpEnabled}` from this same `app-state.json` on
    // every request via a 5s cache, so saved changes propagate
    // within that window without any IPC round-trip.
    const newApiConfig = apiConfigFromDraft(draft)
    setApiConfig(newApiConfig)
    await saveApiConfig(newApiConfig)
    try {
      await invoke<string>("api_server_reload_config")
    } catch (err) {
      console.warn("[api] failed to reload API server config cache:", err)
    }

    if (project) {
      const newAgentConfig = await saveAgentResourceConfig(project.path, {
        maxTurns: draft.agentMaxTurns,
        maxFilesChanged: draft.agentMaxFilesChanged,
        maxWriteBytes: draft.agentMaxWriteKiB * 1024,
        // The preflight toggle has no UI control yet (plumbing only, see
        // #119 P0-3). Preserve the current value so saving unrelated
        // settings doesn't silently reset a hand-edited flag to false.
        maxFilesChangedEnabled: agentConfig.maxFilesChangedEnabled,
      })
      setAgentResourceConfig(newAgentConfig)
    }

    if (draft.uiLanguage !== i18n.language) {
      await i18n.changeLanguage(draft.uiLanguage)
      await saveLanguage(draft.uiLanguage)
    }

    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }, [
    draft,
    project,
    setLlmConfig,
    setEmbeddingConfig,
    setMultimodalConfig,
    setMineruConfig,
    setOutputLanguage,
    setProxyConfig,
    setScheduledImportConfig,
    setSourceWatchConfig,
    setApiConfig,
    setAgentResourceConfig,
    scheduledImportConfig,
    setMaxHistoryMessages,
    outputLanguage,
  ])

  const body = useMemo(() => {
    switch (activeCategory) {
      case "llm":
        // The LLM section manages its own store state (per-provider
        // configs + active preset) and persists directly — it bypasses
        // the shared draft / global Save button.
        return <LlmProviderSection />
      case "model-profiles":
        return <ModelProfilesSection />
      case "embedding":
        return <EmbeddingSection draft={draft} setDraft={setDraft} />
      case "multimodal":
        return <MultimodalSection draft={draft} setDraft={setDraft} />
      case "web-search":
        return <WebSearchSection />
      case "network":
        return <NetworkSection draft={draft} setDraft={setDraft} />
      case "source-watch":
        return <SourceWatchSection draft={draft} setDraft={setDraft} projectReady={!!project} />
      case "scheduled-import":
        return <ScheduledImportSection draft={draft} setDraft={setDraft} />
      case "mineru":
        return <MineruSection draft={draft} setDraft={setDraft} />
      case "api-server":
        return <ApiServerSection draft={draft} setDraft={setDraft} />
      case "agent":
        return <AgentSection draft={draft} setDraft={setDraft} projectReady={!!project} />
      case "knowledge-agents":
        return <KnowledgeAgentsSection project={project} />
      case "taxonomy":
        return <TagTaxonomySection project={project} />
      case "synthesis":
        return <SynthesisSection project={project} />
      case "general":
        return <GeneralSection draft={draft} setDraft={setDraft} />
      case "output":
        return <OutputSection draft={draft} setDraft={setDraft} />
      case "interface":
        return <InterfaceSection draft={draft} setDraft={setDraft} />
      case "maintenance":
        return <MaintenanceSection />
      case "changelog":
        return <ChangelogSection />
      case "about":
        return <AboutSection />
    }
  }, [activeCategory, draft, project, setDraft])

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden md:flex-row">
      {/* Sidebar — category nav. Matches the IconSidebar's pill-on-accent
          pattern so the two navigational surfaces feel like one app. */}
      <aside className="flex max-h-24 w-full shrink-0 flex-col border-b bg-muted/30 md:min-h-0 md:max-h-none md:w-56 md:border-b-0 md:border-r">
        <div className="px-4 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground md:pb-2 md:pt-4">
          {t("settings.title")}
        </div>
        <nav className="flex min-h-0 flex-1 gap-1 overflow-x-auto overflow-y-hidden px-2 pb-2 md:block md:overflow-x-hidden md:overflow-y-auto md:pb-3">
          {categories.map((c) => {
            const Icon = c.icon
            const isActive = c.id === activeCategory
            // Mirror the gear-icon dot inside the settings sidebar
            // so the user can find which sub-section the update
            // notification is pointing at. Update info lives in
            // the About panel, so the dot follows the About row.
            // Same store, same gating — once dismissed, both
            // disappear together.
            const showUpdateDot =
              c.id === "about" && updateAvailable
            return (
              <button
                key={c.id}
                type="button"
                onClick={() => setActive(c.id)}
                aria-current={isActive ? "page" : undefined}
                data-testid={`settings-category-${c.id}`}
                className={`group mb-0 flex shrink-0 items-center gap-2 whitespace-nowrap rounded-md px-2.5 py-1.5 text-sm transition-colors md:mb-0.5 md:w-full md:gap-2.5 ${
                  isActive
                    ? "bg-foreground/[0.08] font-medium text-foreground ring-1 ring-border/70"
                    : "text-muted-foreground hover:bg-accent/50 hover:text-accent-foreground"
                }`}
              >
                <Icon
                  className={`h-4 w-4 shrink-0 transition-colors ${
                    isActive ? "text-primary" : "text-muted-foreground/80 group-hover:text-accent-foreground"
                  }`}
                />
                <span className="truncate">{t(c.labelKey)}</span>
                {showUpdateDot && (
                  <span
                    className="ml-auto h-2 w-2 shrink-0 rounded-full bg-red-500"
                    aria-label={t("nav.updateAvailable")}
                    title={t("nav.updateAvailable")}
                  />
                )}
              </button>
            )
          })}
        </nav>
      </aside>

      {/* Content */}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 md:px-8 md:py-6">
          <div className="mx-auto max-w-2xl">{body}</div>
        </div>

        {/* Global Save bar hidden for sections that persist inline or have no draft fields. */}
        {shouldShowGlobalSettingsSaveBar(activeCategory) && (
          <div className="shrink-0 border-t bg-background/80 px-4 py-3 backdrop-blur md:px-8">
            <div className="mx-auto flex max-w-2xl items-center justify-between gap-4">
              <p className="text-xs text-muted-foreground">
                {saved ? t("settings.savedTick") : t("settings.changeHint")}
              </p>
              <Button onClick={handleSave}>
                {saved ? t("settings.saved") : t("settings.save")}
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
