import i18n from "@/i18n"
import { openProject } from "@/commands/fs"
import { runtimeProfileList } from "@/commands/runtime-db"
import { hasModelCallProfileCandidate } from "@/lib/pool-chat"
import { DEFAULT_API_CONFIG, useWikiStore } from "@/stores/wiki-store"
import { useZoomStore } from "@/stores/zoom-store"
import {
  getLastProject,
  loadActivePresetId,
  loadApiConfig,
  loadEmbeddingConfig,
  loadLanguage,
  loadLlmConfig,
  loadMineruConfig,
  loadMultimodalConfig,
  loadProviderConfigs,
  loadProxyConfig,
  loadSearchApiConfig,
  loadTheme,
  loadZoomLevel,
} from "@/lib/project-store"
import { normalizeMineruConfig } from "@/lib/mineru-config"
import { activateThemePreference } from "@/lib/theme"
import type { WikiProject } from "@/types/wiki"

/** App-owned callbacks needed by the mount-only init hydration pipeline. */
export type InitConfigHydrationDeps = {
  handleProjectOpened: (project: WikiProject) => Promise<void>
  onDone: () => void
}

const runStep = async (label: string, fn: () => Promise<void>) => {
  try {
    await fn()
  } catch (err) {
    console.error(`[init] ${label} failed:`, err)
  }
}

/** Hydrate persisted startup settings and best-effort open the last project. */
export async function runInitConfigHydration({
  handleProjectOpened,
  onDone,
}: InitConfigHydrationDeps): Promise<void> {
  // Populated by the providerConfigs step; read by the activePreset
  // step for its per-preset override lookup. Stays null if that step
  // fails; in that case activePreset must not re-resolve and persist
  // a defaults-only LlmConfig over the user's last good snapshot.
  let savedProviderConfigs: Awaited<ReturnType<typeof loadProviderConfigs>> = null

  await runStep("llmConfig", async () => {
    const savedConfig = await loadLlmConfig()
    if (savedConfig) {
      useWikiStore.getState().setLlmConfig(savedConfig)
    }
  })

  await runStep("providerConfigs", async () => {
    savedProviderConfigs = await loadProviderConfigs()
    if (savedProviderConfigs) {
      useWikiStore.getState().setProviderConfigs(savedProviderConfigs)
    }
  })

  // Re-resolve the active preset's LlmConfig from (preset defaults +
  // saved overrides). Without this, preset default updates (e.g. a
  // corrected Anthropic model ID shipped in a release) never reach
  // users who are relying on defaults — their stored `llmConfig`
  // snapshot from a previous launch would keep the old value.
  // Overrides still win, so an explicit user choice is preserved.
  // Kept as a single step (not split further) since its sub-parts
  // depend on each other in sequence.
  await runStep("activePreset", async () => {
    const savedActivePreset = await loadActivePresetId()
    if (savedActivePreset) {
      useWikiStore.getState().setActivePresetId(savedActivePreset)
      if (!savedProviderConfigs) {
        return
      }
      let hasActiveModelCallProfile = false
      try {
        const profileList = await runtimeProfileList()
        hasActiveModelCallProfile =
          profileList.enabled &&
          profileList.status === "healthy" &&
          profileList.profiles.some((profile) => hasModelCallProfileCandidate(profile, "chat"))
      } catch {
        hasActiveModelCallProfile = false
      }
      // #351: profile pool is authoritative; legacy re-resolve/write-back only fills zero-profile installs.
      if (hasActiveModelCallProfile) {
        return
      }
      const { LLM_PRESETS } = await import("@/lib/llm-presets")
      const { resolveConfig } = await import("@/components/settings/preset-resolver")
      const preset = LLM_PRESETS.find((p) => p.id === savedActivePreset)
      if (preset) {
        const currentFallback = useWikiStore.getState().llmConfig
        const override = savedProviderConfigs[savedActivePreset]
        const resolved = resolveConfig(preset, override, currentFallback)
        useWikiStore.getState().setLlmConfig(resolved)
        const { saveLlmConfig } = await import("@/lib/project-store")
        await saveLlmConfig(resolved)
      }
    }
  })

  await runStep("searchApiConfig", async () => {
    const savedSearchConfig = await loadSearchApiConfig()
    if (savedSearchConfig) {
      useWikiStore.getState().setSearchApiConfig(savedSearchConfig)
    }
  })

  await runStep("embeddingConfig", async () => {
    const savedEmbeddingConfig = await loadEmbeddingConfig()
    if (savedEmbeddingConfig) {
      useWikiStore.getState().setEmbeddingConfig(savedEmbeddingConfig)
    }
  })

  await runStep("multimodalConfig", async () => {
    const savedMultimodalConfig = await loadMultimodalConfig()
    if (savedMultimodalConfig) {
      useWikiStore.getState().setMultimodalConfig(savedMultimodalConfig)
    }
  })

  await runStep("mineruConfig", async () => {
    const savedMineruConfig = await loadMineruConfig()
    if (savedMineruConfig) {
      useWikiStore.getState().setMineruConfig(normalizeMineruConfig(savedMineruConfig))
    }
  })

  await runStep("proxyConfig", async () => {
    const savedProxy = await loadProxyConfig()
    if (savedProxy) {
      useWikiStore.getState().setProxyConfig(savedProxy)
    }
  })

  await runStep("apiConfig", async () => {
    // Local HTTP API server config — global (single token + enable
    // flag for the whole install, not per-project). The Rust side
    // reads `apiConfig.{enabled,token,mcpEnabled}` from `app-state.json`
    // directly; this only hydrates the Zustand store so the
    // Settings UI reflects the persisted values.
    const savedApi = await loadApiConfig()
    if (savedApi) {
      useWikiStore.getState().setApiConfig({
        enabled: typeof savedApi.enabled === "boolean" ? savedApi.enabled : DEFAULT_API_CONFIG.enabled,
        allowUnauthenticated:
          typeof savedApi.allowUnauthenticated === "boolean"
            ? savedApi.allowUnauthenticated
            : DEFAULT_API_CONFIG.allowUnauthenticated,
        mcpEnabled: typeof savedApi.mcpEnabled === "boolean" ? savedApi.mcpEnabled : DEFAULT_API_CONFIG.mcpEnabled,
        token: typeof savedApi.token === "string" ? savedApi.token : DEFAULT_API_CONFIG.token,
      })
    }
  })

  await runStep("zoomLevel", async () => {
    useZoomStore.getState().setLevel(await loadZoomLevel())
  })

  await runStep("theme", async () => {
    activateThemePreference(await loadTheme())
  })

  await runStep("language", async () => {
    const savedLang = await loadLanguage()
    if (savedLang) {
      await i18n.changeLanguage(savedLang)
    }
  })

  // Independent of every step above — must run even if an earlier
  // load failed.
  await runStep("lastProject", async () => {
    const lastProject = await getLastProject()
    if (lastProject) {
      const proj = await openProject(lastProject.path)
      await handleProjectOpened(proj)
    }
  })

  onDone()
}
