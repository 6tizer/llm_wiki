import { useCallback, useEffect, useMemo, useState } from "react"
import {
  Bot,
  Languages,
  Palette,
  Settings,
  Info,
  Network,
  History,
  FolderSync,
  Server,
  SlidersHorizontal,
  BrainCircuit,
  Activity,
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
import { persistSetting } from "@/lib/store-helpers"
import type { SettingsDraft, DraftSetter } from "./settings-types"
import { normalizeSourceWatchConfig } from "@/lib/source-watch-config"
import { ModelConfigSection } from "./sections/model-config-section"
import { OutputSection } from "./sections/output-section"
import { InterfaceSection } from "./sections/interface-section"
import { GeneralSection } from "./sections/general-section"
import { NetworkSection } from "./sections/network-section"
import { ImportSection } from "./sections/import-section"
import { ApiServerSection } from "./sections/api-server-section"
import { AgentSection } from "./sections/agent-section"
import { KnowledgeAgentsSection } from "./sections/knowledge-agents-section"
import { DerivedStatusSection } from "./sections/derived-status-section"
import { ChangelogSection } from "./sections/changelog-section"
import { AboutSection } from "./sections/about-section"
import {
  clampMineruPollIntervalMs,
  clampMineruPollTimeoutMs,
  MINERU_DEFAULT_POLL_INTERVAL_MS,
  MINERU_DEFAULT_POLL_TIMEOUT_MS,
} from "@/lib/mineru-config"

export type CategoryId =
  | "model-config"
  | "import"
  | "network"
  | "api-server"
  | "agent"
  | "knowledge-agents"
  | "derived-status"
  | "general"
  | "output"
  | "interface"
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

interface SettingsGroup {
  id: "aiModels" | "pipeline" | "app"
  labelKey: string
  categoryIds: CategoryId[]
}

const CATEGORIES: Category[] = [
  { id: "model-config", labelKey: "settings.categories.modelConfig", icon: Bot },
  { id: "import", labelKey: "settings.categories.import", icon: FolderSync },
  { id: "knowledge-agents", labelKey: "settings.categories.knowledgeAgents", icon: BrainCircuit },
  { id: "derived-status", labelKey: "settings.categories.derivedStatus", icon: Activity },
  { id: "agent", labelKey: "settings.categories.agent", icon: SlidersHorizontal },
  { id: "api-server", labelKey: "settings.categories.apiServer", icon: Server },
  { id: "network", labelKey: "settings.categories.network", icon: Network },
  { id: "general", labelKey: "settings.categories.general", icon: Settings },
  { id: "output", labelKey: "settings.categories.output", icon: Languages },
  { id: "interface", labelKey: "settings.categories.interface", icon: Palette },
  { id: "changelog", labelKey: "settings.categories.changelog", icon: History },
  { id: "about", labelKey: "settings.categories.about", icon: Info },
]

/** Navigation grouping for Settings; category order is the group order flattened. */
export const SETTINGS_GROUPS: SettingsGroup[] = [
  {
    id: "aiModels",
    labelKey: "settings.groups.aiModels",
    categoryIds: ["model-config"],
  },
  {
    id: "pipeline",
    labelKey: "settings.groups.pipeline",
    categoryIds: ["import", "knowledge-agents", "derived-status"],
  },
  {
    id: "app",
    labelKey: "settings.groups.app",
    categoryIds: ["agent", "api-server", "network", "general", "output", "interface", "changelog", "about"],
  },
]

// These sections own their persistence instead of writing through SettingsDraft.
const INLINE_PERSIST_SETTINGS_CATEGORIES = new Set<CategoryId>([
  "about",
  "model-config",
  "knowledge-agents",
  "derived-status",
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
  active: CategoryId | string,
  categories: Category[],
): CategoryId {
  if (categories.some((category) => category.id === active)) {
    return active as CategoryId
  }
  const migratedActive = ["source-watch", "scheduled-import", "mineru"].includes(active)
    ? "import"
    : ["llm", "model-profiles", "web-search", "embedding", "multimodal"].includes(active)
      ? "model-config"
      // Governance operations moved to Wiki Health. Settings has no deep-link
      // path into that top-level view, so legacy settings ids land on the
      // closest remaining status surface.
      : ["taxonomy", "synthesis", "index-overview", "maintenance"].includes(active)
        ? "derived-status"
        : active
  if (categories.some((category) => category.id === migratedActive)) {
    return migratedActive as CategoryId
  }
  return categories[0]?.id ?? "model-config"
}

/** Returns whether the shared Settings draft Save bar should be shown. */
export function shouldShowGlobalSettingsSaveBar(activeCategory: CategoryId): boolean {
  return !INLINE_PERSIST_SETTINGS_CATEGORIES.has(activeCategory)
}

export function initialDraft(
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
    agentDefaultPermissionPolicy: agentConfig.defaultPermissionPolicy,
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

/**
 * Persists theme and close-behavior independently so a failure saving
 * one doesn't prevent the other from being tried — each is isolated in
 * its own try/catch and reported back via the returned failed-key list
 * instead of throwing and aborting the caller's remaining save steps.
 */
export async function persistAppPreferences(
  draft: Pick<SettingsDraft, "theme" | "closeBehavior">,
  deps: {
    saveTheme: (theme: AppTheme) => Promise<void>
    saveCloseBehavior: (behavior: CloseBehavior) => Promise<void>
    activateThemePreference: (theme: AppTheme) => unknown
    setSavedTheme: (theme: AppTheme) => void
    setSavedCloseBehavior: (behavior: CloseBehavior) => void
  },
): Promise<Array<"theme" | "closeBehavior">> {
  const failedKeys: Array<"theme" | "closeBehavior"> = []
  try {
    await deps.saveTheme(draft.theme)
    deps.setSavedTheme(draft.theme)
    deps.activateThemePreference(draft.theme)
  } catch {
    failedKeys.push("theme")
  }
  try {
    await deps.saveCloseBehavior(draft.closeBehavior)
    deps.setSavedCloseBehavior(draft.closeBehavior)
  } catch {
    failedKeys.push("closeBehavior")
  }
  return failedKeys
}

export type SaveStatus =
  | { kind: "idle" }
  | { kind: "saved" }
  | { kind: "partial-error"; failedKeys: string[] }

// Maps a handleSave step key to the settings category whose label best
// describes it, so the partial-error message reads as "LLM Models,
// Network" instead of raw internal step identifiers.
const SETTINGS_SAVE_STEP_LABEL_KEYS: Record<string, string> = {
  mineru: "settings.categories.mineru",
  outputLanguage: "settings.categories.output",
  proxy: "settings.categories.network",
  sourceWatch: "settings.categories.sourceWatch",
  scheduledImport: "settings.categories.scheduledImport",
  zoomLevel: "settings.categories.interface",
  theme: "settings.categories.interface",
  closeBehavior: "settings.categories.general",
  apiConfig: "settings.categories.apiServer",
  agent: "settings.categories.agent",
  language: "settings.categories.interface",
}

// Rust reads these three straight out of app-state.json on its own
// schedule (proxy env / API server cache / close behavior), so a JS-set
// that persists successfully in this session but fails to reach disk
// can silently diverge from what the next launch picks up.
const RUST_LOCKED_SAVE_KEYS = new Set(["proxy", "apiConfig", "closeBehavior"])

export function describeFailedSettingsKeys(
  keys: string[],
  t: (key: string, opts?: Record<string, unknown>) => string,
): string {
  return keys
    .map((key) => {
      const label = t(SETTINGS_SAVE_STEP_LABEL_KEYS[key] ?? key)
      return RUST_LOCKED_SAVE_KEYS.has(key)
        ? `${label} (${t("settings.saveFailedRustLockedNote")})`
        : label
    })
    .join(", ")
}

export function SettingsView() {
  const { t } = useTranslation()
  const project = useWikiStore((s) => s.project)
  const setActiveView = useWikiStore((s) => s.setActiveView)
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

  const [active, setActive] = useState<CategoryId>("model-config")
  const [saveStatus, setSaveStatus] = useState<SaveStatus>({ kind: "idle" })
  const [savedTheme, setSavedTheme] = useState<AppTheme>(() => readThemeMirror())
  const [savedCloseBehavior, setSavedCloseBehavior] = useState<CloseBehavior>("hide")
  const [draft, setDraftState] = useState<SettingsDraft>(() =>
    initialDraft(
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
  const categoriesById = useMemo(() => new Map(categories.map((category) => [category.id, category])), [categories])
  const categoryGroups = useMemo(
    () =>
      SETTINGS_GROUPS.map((group) => ({
        ...group,
        categories: group.categoryIds.flatMap((id) => {
          const category = categoriesById.get(id)
          return category ? [category] : []
        }),
      })).filter((group) => group.categories.length > 0),
    [categoriesById],
  )
  const activeCategory = coerceSettingsCategory(active, categories)

  useEffect(() => {
    if (active !== activeCategory) {
      setActive(activeCategory)
    }
  }, [active, activeCategory])

  const handleSave = useCallback(async () => {
    const {
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

    const newProxy = {
      enabled: draft.proxyEnabled,
      url: draft.proxyUrl.trim(),
      bypassLocal: draft.proxyBypassLocal,
    }
    const newMineru = mineruConfigFromDraft(draft)
    const newSourceWatch = normalizeSourceWatchConfig(draft.sourceWatchConfig)
    const newScheduledImport = {
      enabled: draft.scheduledImportEnabled,
      path: draft.scheduledImportPath,
      interval: Math.max(1, Math.min(1440, draft.scheduledImportInterval || 60)),
      lastScan: scheduledImportConfig.lastScan,
    }
    const newApiConfig = apiConfigFromDraft(draft)
    const failedKeys: string[] = []

    // Each step persists independently: a failure here only rolls back
    // and records that one step (via persistSetting's optimistic-set +
    // revert-on-error), it never aborts the steps that follow. That way
    // one bad write (e.g. disk full on proxy config) doesn't also
    // silently drop the user's MinerU/source/theme edits.
    const steps: Array<{ key: string; run: () => Promise<boolean> }> = [
      {
        key: "mineru",
        run: () =>
          persistSetting(
            mineruConfig,
            newMineru,
            setMineruConfig,
            saveMineruConfig,
            () => useWikiStore.getState().mineruConfig,
          ),
      },
      {
        key: "outputLanguage",
        run: () =>
          persistSetting(
            outputLanguage,
            draft.outputLanguage as typeof outputLanguage,
            setOutputLanguage,
            (value) => saveOutputLanguage(value, project?.id),
            () => useWikiStore.getState().outputLanguage,
          ),
      },
      {
        // Rust-locked: the setup hook reads proxyConfig straight from
        // app-state.json, so a failed persist here can diverge from
        // the live env vars applied below until the next launch.
        key: "proxy",
        run: async () => {
          const ok = await persistSetting(
            proxyConfig,
            newProxy,
            setProxyConfig,
            saveProxyConfig,
            () => useWikiStore.getState().proxyConfig,
          )
          // Apply the proxy env vars LIVE so the next outbound request
          // picks them up — no app restart needed. tauri-plugin-http
          // builds a fresh reqwest client per fetch and reqwest reads
          // env vars at build time, so changing them here is enough.
          // Gated on the persist succeeding: applying it after a failed
          // save would switch this process's live HTTP env to newProxy
          // while memory/disk still show the old value — a real
          // runtime/state split, not just a "will apply on restart" gap.
          if (ok) {
            try {
              await invoke<string>("set_proxy_env", { config: newProxy })
            } catch (err) {
              console.warn("[proxy] live update failed; restart will still apply:", err)
            }
          }
          return ok
        },
      },
      {
        key: "sourceWatch",
        run: async () => {
          const ok = await persistSetting(
            sourceWatchConfig,
            newSourceWatch,
            setSourceWatchConfig,
            (value) => saveSourceWatchConfig(value, project?.id),
            () => useWikiStore.getState().sourceWatchConfig,
          )
          // Only actually (re)start the watcher off a config that made
          // it to disk — otherwise the reverted in-memory config and a
          // live watcher on the failed config would disagree.
          if (ok && project) {
            const { startProjectFileSync, stopProjectFileSync } = await import("@/lib/project-file-sync")
            if (newSourceWatch.enabled) {
              await startProjectFileSync(project, newSourceWatch).catch((err) =>
                console.error("Failed to start project file sync:", err)
              )
            } else {
              await stopProjectFileSync()
            }
          }
          return ok
        },
      },
      {
        key: "scheduledImport",
        run: async () => {
          if (!project) {
            setScheduledImportConfig(newScheduledImport)
            return true
          }
          const ok = await persistSetting(
            scheduledImportConfig,
            newScheduledImport,
            setScheduledImportConfig,
            (value) => saveScheduledImportConfig(project.path, value),
            () => useWikiStore.getState().scheduledImportConfig,
          )
          if (ok) {
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
          return ok
        },
      },
      {
        key: "zoomLevel",
        run: () =>
          persistSetting(
            zoomLevel,
            draft.zoomLevel,
            (value) => useZoomStore.getState().setLevel(value),
            saveZoomLevel,
            () => useZoomStore.getState().level,
          ),
      },
      {
        // theme + closeBehavior are isolated from each other inside
        // persistAppPreferences; closeBehavior is Rust-locked (read
        // straight from app-state.json by the window-close handler).
        key: "app-preferences",
        run: async () => {
          const failed = await persistAppPreferences(draft, {
            saveTheme,
            saveCloseBehavior,
            activateThemePreference,
            setSavedTheme,
            setSavedCloseBehavior,
          })
          failed.forEach((key) => failedKeys.push(key))
          return true
        },
      },
      {
        // Rust-locked: the API server reads apiConfig from the same
        // app-state.json on a 5s cache; see the reload call below.
        key: "apiConfig",
        run: async () => {
          const ok = await persistSetting(
            apiConfig,
            newApiConfig,
            setApiConfig,
            saveApiConfig,
            () => useWikiStore.getState().apiConfig,
          )
          // Unlike set_proxy_env, this doesn't inject a JS-held value
          // into the live process — it just tells the Rust side "reread
          // app-state.json now". If the save above failed, disk still
          // has the old apiConfig, so reloading is a harmless no-op
          // rather than a real divergence risk; gated anyway so a
          // failed save never triggers pointless IPC work.
          if (ok) {
            try {
              await invoke<string>("api_server_reload_config")
            } catch (err) {
              console.warn("[api] failed to reload API server config cache:", err)
            }
          }
          return ok
        },
      },
      {
        key: "agent",
        run: async () => {
          if (!project) return true
          try {
            const newAgentConfig = await saveAgentResourceConfig(project.path, {
              maxTurns: draft.agentMaxTurns,
              maxFilesChanged: draft.agentMaxFilesChanged,
              maxWriteBytes: draft.agentMaxWriteKiB * 1024,
              defaultPermissionPolicy: draft.agentDefaultPermissionPolicy,
              // The preflight toggle has no UI control yet (plumbing only, see
              // #119 P0-3). Preserve the current value so saving unrelated
              // settings doesn't silently reset a hand-edited flag to false.
              maxFilesChangedEnabled: agentConfig.maxFilesChangedEnabled,
            })
            setAgentResourceConfig(newAgentConfig)
            return true
          } catch (err) {
            console.error("[settings] failed to save agent resource config:", err)
            return false
          }
        },
      },
      {
        key: "language",
        run: async () => {
          if (draft.uiLanguage === i18n.language) return true
          try {
            await i18n.changeLanguage(draft.uiLanguage)
            await saveLanguage(draft.uiLanguage)
            return true
          } catch (err) {
            console.error("[settings] failed to save UI language:", err)
            return false
          }
        },
      },
    ]

    setMaxHistoryMessages(draft.maxHistoryMessages)
    for (const step of steps) {
      const ok = await step.run()
      if (!ok) failedKeys.push(step.key)
    }

    setSaveStatus(failedKeys.length > 0 ? { kind: "partial-error", failedKeys } : { kind: "saved" })
    setTimeout(() => setSaveStatus((cur) => (cur.kind === "idle" ? cur : { kind: "idle" })), 2000)
  }, [
    draft,
    project,
    mineruConfig,
    setMineruConfig,
    outputLanguage,
    setOutputLanguage,
    proxyConfig,
    setProxyConfig,
    sourceWatchConfig,
    setSourceWatchConfig,
    scheduledImportConfig,
    setScheduledImportConfig,
    zoomLevel,
    apiConfig,
    setApiConfig,
    agentConfig,
    setAgentResourceConfig,
    setMaxHistoryMessages,
  ])

  const body = useMemo(() => {
    switch (activeCategory) {
      case "model-config":
        return <ModelConfigSection />
      case "network":
        return <NetworkSection draft={draft} setDraft={setDraft} />
      case "import":
        return <ImportSection draft={draft} setDraft={setDraft} projectReady={!!project} />
      case "api-server":
        return <ApiServerSection draft={draft} setDraft={setDraft} />
      case "agent":
        return <AgentSection draft={draft} setDraft={setDraft} projectReady={!!project} />
      case "knowledge-agents":
        return <KnowledgeAgentsSection project={project} />
      case "derived-status":
        return (
          <DerivedStatusSection
            project={project}
            onNavigate={() => setActiveView("wiki-health")}
          />
        )
      case "general":
        return <GeneralSection draft={draft} setDraft={setDraft} />
      case "output":
        return <OutputSection draft={draft} setDraft={setDraft} />
      case "interface":
        return <InterfaceSection draft={draft} setDraft={setDraft} />
      case "changelog":
        return <ChangelogSection />
      case "about":
        return <AboutSection />
    }
  }, [activeCategory, draft, project, setDraft, setActiveView])

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden md:flex-row">
      {/* Sidebar — category nav. Matches the IconSidebar's pill-on-accent
          pattern so the two navigational surfaces feel like one app. */}
      <aside className="flex max-h-24 w-full shrink-0 flex-col border-b bg-muted/30 md:min-h-0 md:max-h-none md:w-56 md:border-b-0 md:border-r">
        <div className="px-4 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground md:pb-2 md:pt-4">
          {t("settings.title")}
        </div>
        <nav
          aria-label={t("settings.navLabel")}
          className="flex min-h-0 flex-1 gap-3 overflow-x-auto overflow-y-hidden px-2 pb-2 md:block md:space-y-3 md:overflow-x-hidden md:overflow-y-auto md:pb-3"
        >
          {categoryGroups.map((group) => {
            const headingId = `settings-group-${group.id}`
            return (
              <section
                key={group.id}
                aria-labelledby={headingId}
                className="flex shrink-0 items-start gap-1 md:block"
              >
                <h3
                  id={headingId}
                  className="px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground md:pb-1 md:pt-2"
                >
                  {t(group.labelKey)}
                </h3>
                <div className="flex gap-1 md:block">
                  {group.categories.map((c) => {
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
                </div>
              </section>
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
              <p
                className={`min-w-0 flex-1 truncate text-xs ${
                  saveStatus.kind === "partial-error" ? "text-destructive" : "text-muted-foreground"
                }`}
                title={
                  saveStatus.kind === "partial-error"
                    ? t("settings.saveFailed", { keys: describeFailedSettingsKeys(saveStatus.failedKeys, t) })
                    : undefined
                }
              >
                {saveStatus.kind === "partial-error"
                  ? t("settings.saveFailed", { keys: describeFailedSettingsKeys(saveStatus.failedKeys, t) })
                  : saveStatus.kind === "saved"
                    ? t("settings.savedTick")
                    : t("settings.changeHint")}
              </p>
              <Button onClick={handleSave} className="shrink-0">
                {saveStatus.kind === "saved" ? t("settings.saved") : t("settings.save")}
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
