// @vitest-environment jsdom

import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { beforeEach, describe, expect, it, vi } from "vitest"
import i18n from "@/i18n"
import { invoke } from "@tauri-apps/api/core"
import { useWikiStore } from "@/stores/wiki-store"
import {
  saveApiConfig,
  saveEmbeddingConfig,
  saveLlmConfig,
  saveMineruConfig,
  saveProxyConfig,
  saveScheduledImportConfig,
  saveSourceWatchConfig,
} from "@/lib/project-store"
import { startProjectFileSync, stopProjectFileSync } from "@/lib/project-file-sync"
import { startScheduledImport, stopScheduledImport } from "@/lib/scheduled-import"

import {
  coerceSettingsCategory,
  describeFailedSettingsKeys,
  getSettingsCategories,
  isMacLikeRuntime,
  initialDraft,
  mineruConfigFromDraft,
  persistAppPreferences,
  SETTINGS_GROUPS,
  SettingsView,
  shouldShowGlobalSettingsSaveBar,
} from "./settings-view"

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => ""),
}))

vi.mock("@/lib/project-store", () => ({
  loadCloseBehavior: vi.fn(async () => "hide"),
  loadSourceWatchConfig: vi.fn(async () => undefined),
  loadTheme: vi.fn(async () => "system"),
  saveLanguage: vi.fn(async () => undefined),
  saveLlmConfig: vi.fn(async () => undefined),
  saveEmbeddingConfig: vi.fn(async () => undefined),
  saveMultimodalConfig: vi.fn(async () => undefined),
  saveOutputLanguage: vi.fn(async () => undefined),
  saveProxyConfig: vi.fn(async () => undefined),
  saveScheduledImportConfig: vi.fn(async () => undefined),
  saveSourceWatchConfig: vi.fn(async () => undefined),
  saveMineruConfig: vi.fn(async () => undefined),
  saveApiConfig: vi.fn(async () => undefined),
  saveZoomLevel: vi.fn(async () => undefined),
  saveTheme: vi.fn(async () => undefined),
  saveCloseBehavior: vi.fn(async () => undefined),
}))

vi.mock("@/lib/project-file-sync", () => ({
  startProjectFileSync: vi.fn(async () => undefined),
  stopProjectFileSync: vi.fn(async () => undefined),
}))

vi.mock("@/lib/scheduled-import", () => ({
  scanAndImport: vi.fn(async () => undefined),
  startScheduledImport: vi.fn(() => undefined),
  stopScheduledImport: vi.fn(() => undefined),
}))

vi.mock("./sections/synthesis-section", () => ({
  SynthesisSection: ({ project }: { project?: { path: string } | null }) =>
    `Mock Synthesis Section:${project?.path ?? "no-project"}`,
}))

vi.mock("./sections/model-profiles-section", () => ({
  ModelProfilesSection: () => "Mock Model Profiles Section",
}))

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true

function renderSettingsView(): { container: HTMLDivElement; root: Root } {
  const container = document.createElement("div")
  document.body.appendChild(container)
  const root = createRoot(container)

  act(() => {
    root.render(createElement(SettingsView))
  })

  return { container, root }
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

async function click(element: Element): Promise<void> {
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }))
    await Promise.resolve()
    await Promise.resolve()
  })
}

async function setStoreAndFlush(mutate: () => void): Promise<void> {
  await act(async () => {
    mutate()
    await Promise.resolve()
    await Promise.resolve()
  })
}

async function clickCategoryAndSave(container: HTMLDivElement, categoryTestId: string): Promise<void> {
  const tab = container.querySelector(`[data-testid='settings-category-${categoryTestId}']`)
  if (!tab) throw new Error(`${categoryTestId} category button not found`)
  await click(tab)
  await flush()

  const saveButton = Array.from(container.querySelectorAll("button")).find(
    (btn) => btn.textContent === "Save",
  )
  if (!saveButton) throw new Error("Save button not found")
  await click(saveButton)
  await flush()
}

function unmount(root: Root): void {
  act(() => {
    root.unmount()
  })
}

beforeEach(() => {
  useWikiStore.setState({
    project: { id: "p1", name: "Project", path: "/project" },
  })
})

describe("settings platform categories", () => {
  it("detects mac-like runtimes from browser navigator signals", () => {
    expect(isMacLikeRuntime({ platform: "MacIntel" })).toBe(true)
    expect(isMacLikeRuntime({ userAgentData: { platform: "macOS" } })).toBe(true)
    expect(isMacLikeRuntime({ userAgent: "Mozilla/5.0 (Darwin)" })).toBe(true)
    expect(isMacLikeRuntime({ platform: "Win32" })).toBe(false)
    expect(isMacLikeRuntime({ userAgentData: { platform: "Linux" } })).toBe(false)
  })

  it("hides General outside mac-like runtimes", () => {
    expect(getSettingsCategories(true).some((category) => category.id === "general")).toBe(true)
    expect(getSettingsCategories(false).some((category) => category.id === "general")).toBe(false)
  })

  it("places Model Profiles directly after LLM Models", () => {
    expect(getSettingsCategories(true).map((category) => category.id).slice(0, 2)).toEqual([
      "llm",
      "model-profiles",
    ])
  })

  it("keeps settings groups aligned with the flat category order", () => {
    const groupedIds = SETTINGS_GROUPS.flatMap((group) => group.categoryIds)
    const uniqueGroupedIds = new Set(groupedIds)

    expect(groupedIds).toEqual(getSettingsCategories(true).map((category) => category.id))
    expect(uniqueGroupedIds.size).toBe(groupedIds.length)

    const nonMacIds = getSettingsCategories(false).map((category) => category.id)
    expect(new Set(nonMacIds).size).toBe(nonMacIds.length)
    expect(nonMacIds).toEqual(groupedIds.filter((id) => id !== "general"))
  })

  it("falls back when active category is not available", () => {
    const nonMacCategories = getSettingsCategories(false)
    expect(coerceSettingsCategory("interface", nonMacCategories)).toBe("interface")
    expect(coerceSettingsCategory("general", nonMacCategories)).toBe("llm")
    for (const id of ["model-profiles", "knowledge-agents", "taxonomy", "synthesis"] as const) {
      expect(coerceSettingsCategory(id, nonMacCategories)).toBe(id)
      expect(nonMacCategories.some((category) => category.id === id)).toBe(true)
    }
  })

  it("migrates removed import-related category ids to Import", () => {
    const categories = getSettingsCategories(true)

    expect(coerceSettingsCategory("source-watch", categories)).toBe("import")
    expect(coerceSettingsCategory("scheduled-import", categories)).toBe("import")
    expect(coerceSettingsCategory("mineru", categories)).toBe("import")

    expect(coerceSettingsCategory("import", categories)).toBe("import")
    expect(coerceSettingsCategory("no-such-category", categories)).toBe("llm")
    expect(coerceSettingsCategory("MINERU", categories)).toBe("llm")
    expect(coerceSettingsCategory("source-watch", getSettingsCategories(false))).toBe("import")

    for (const legacyId of ["source-watch", "scheduled-import", "mineru"]) {
      expect(categories.some((category) => (category.id as string) === legacyId)).toBe(false)
    }
  })

  it("keeps renamed categories on their original ids and label keys", () => {
    const categories = getSettingsCategories(true)
    const agent = categories.find((category) => category.id === "agent")
    const knowledgeAgents = categories.find((category) => category.id === "knowledge-agents")

    expect(agent?.labelKey).toBe("settings.categories.agent")
    expect(knowledgeAgents?.labelKey).toBe("settings.categories.knowledgeAgents")
  })
})

describe("SettingsView category rendering", () => {
  it("renders grouped settings navigation with an accessible nav label", async () => {
    const { container, root } = renderSettingsView()
    await flush()

    expect(container.querySelector("nav[aria-label='Settings categories']")).not.toBeNull()
    expect(container.textContent).toContain("AI & Models")
    expect(container.textContent).toContain("Knowledge Pipeline")
    expect(container.textContent).toContain("Application")

    unmount(root)
  })

  it("renders ModelProfilesSection after clicking the Model Profiles sidebar category", async () => {
    const { container, root } = renderSettingsView()
    await flush()

    const modelProfilesButton = container.querySelector("[data-testid='settings-category-model-profiles']")
    if (!modelProfilesButton) throw new Error("model profiles category button not found")

    await click(modelProfilesButton)
    await flush()

    expect(container.textContent).toContain("Mock Model Profiles Section")

    unmount(root)
  })

  it("renders the merged Import page with source watch, scheduled import, and MinerU sections", async () => {
    const { container, root } = renderSettingsView()
    await flush()

    const importButton = container.querySelector("[data-testid='settings-category-import']")
    if (!importButton) throw new Error("import category button not found")

    await click(importButton)
    await flush()

    expect(container.textContent).toContain("Source Folder Auto Watch")
    // "Scan Now" is unique to ScheduledImportSection — the plain
    // "Scheduled Import" heading also exists on the import page shell.
    expect(container.textContent).toContain("Scan Now")
    expect(container.textContent).toContain("MinerU PDF Parser")

    unmount(root)
  })

  it("renders SynthesisSection after clicking the synthesis sidebar category", async () => {
    const { container, root } = renderSettingsView()
    await flush()

    const synthesisButton = container.querySelector("[data-testid='settings-category-synthesis']")
    if (!synthesisButton) throw new Error("synthesis category button not found")

    await click(synthesisButton)
    await flush()

    expect(container.textContent).toContain("Mock Synthesis Section:/project")

    unmount(root)
  })
})

describe("settings app preference save flow", () => {
  it("flushes theme, applies it, then saves close behavior", async () => {
    const calls: string[] = []
    const saved = {
      theme: "",
      closeBehavior: "",
    }

    await persistAppPreferences(
      { theme: "dark", closeBehavior: "quit" },
      {
        saveTheme: async (theme) => {
          calls.push(`saveTheme:${theme}`)
        },
        activateThemePreference: (theme) => {
          calls.push(`activateTheme:${theme}`)
        },
        saveCloseBehavior: async (behavior) => {
          calls.push(`saveCloseBehavior:${behavior}`)
        },
        setSavedTheme: (theme) => {
          saved.theme = theme
          calls.push(`setSavedTheme:${theme}`)
        },
        setSavedCloseBehavior: (behavior) => {
          saved.closeBehavior = behavior
          calls.push(`setSavedCloseBehavior:${behavior}`)
        },
      },
    )

    expect(calls).toEqual([
      "saveTheme:dark",
      "setSavedTheme:dark",
      "activateTheme:dark",
      "saveCloseBehavior:quit",
      "setSavedCloseBehavior:quit",
    ])
    expect(saved).toEqual({ theme: "dark", closeBehavior: "quit" })
  })
})

describe("settings global Save bar visibility", () => {
  it("hides for Model Profiles because runtime profiles persist inline", () => {
    expect(shouldShowGlobalSettingsSaveBar("model-profiles")).toBe(false)
  })

  it("hides for Knowledge Agents because it persists inline", () => {
    expect(shouldShowGlobalSettingsSaveBar("knowledge-agents")).toBe(false)
  })

  it("hides for Tag Taxonomy because it persists inline", () => {
    expect(shouldShowGlobalSettingsSaveBar("taxonomy")).toBe(false)
  })

  it("hides for Synthesis because generation persists inline", () => {
    expect(shouldShowGlobalSettingsSaveBar("synthesis")).toBe(false)
  })

  it("shows for shared draft categories", () => {
    expect(shouldShowGlobalSettingsSaveBar("interface")).toBe(true)
    expect(shouldShowGlobalSettingsSaveBar("agent")).toBe(true)
  })
})

const llm = {
  provider: "openai",
  apiKey: "",
  model: "",
  ollamaUrl: "http://localhost:11434",
  customEndpoint: "",
  maxContextSize: 204800,
}

const embedding = {
  enabled: false,
  endpoint: "",
  apiKey: "",
  model: "",
}

const multimodal = {
  enabled: false,
  useMainLlm: true,
  provider: "custom",
  apiKey: "",
  model: "",
  ollamaUrl: "http://localhost:11434",
  customEndpoint: "",
  concurrency: 4,
}

const proxy = {
  enabled: false,
  url: "",
  bypassLocal: true,
}

const scheduledImport = {
  enabled: false,
  path: "",
  interval: 60,
  lastScan: null,
}

const sourceWatch = {
  enabled: false,
  autoIngest: false,
  includeExtensions: [],
  excludeExtensions: [],
  excludeDirs: [],
  excludeGlobs: [],
  maxFileSizeMb: 10,
}

const apiConfig = {
  enabled: true,
  allowUnauthenticated: false,
  mcpEnabled: false,
  token: "",
}

const agent = {
  maxTurns: 25,
  maxFilesChanged: 20,
  maxFilesChangedEnabled: false,
  maxWriteBytes: 256 * 1024,
}

function draftWithMineru(mineru: {
  enabled: boolean
  token: string
  modelVersion: "pipeline" | "vlm"
  apiBaseUrl?: string
  pollIntervalMs?: number
  pollTimeoutMs?: number
}) {
  return initialDraft(
    llm as never,
    embedding as never,
    multimodal as never,
    "auto" as never,
    proxy,
    scheduledImport,
    sourceWatch,
    mineru,
    apiConfig,
    agent,
    20,
    "en",
  )
}

describe("settings MinerU polling draft", () => {
  it("does not put Knowledge Agents fields into the shared SettingsDraft", () => {
    const draft = draftWithMineru({ enabled: false, token: "", modelVersion: "vlm" })

    expect(Object.keys(draft).some((key) => key.toLowerCase().includes("knowledge"))).toBe(false)
    expect(Object.keys(draft).some((key) => key.toLowerCase().includes("taxonomy"))).toBe(false)
    expect(Object.keys(draft).some((key) => key.toLowerCase().includes("synthesis"))).toBe(false)
    expect(Object.keys(draft).some((key) => key.toLowerCase().includes("agent") && key !== "agentMaxTurns" && key !== "agentMaxFilesChanged" && key !== "agentMaxWriteKiB")).toBe(false)
  })

  it("hydrates MinerU polling fields from config and falls back for legacy configs", () => {
    expect(draftWithMineru({
      enabled: true,
      token: "token",
      modelVersion: "vlm",
      pollIntervalMs: 4500,
      pollTimeoutMs: 600000,
    })).toMatchObject({
      mineruPollIntervalSeconds: 4.5,
      mineruPollTimeoutMinutes: 10,
    })

    expect(draftWithMineru({
      enabled: true,
      token: "token",
      modelVersion: "vlm",
    })).toMatchObject({
      mineruPollIntervalSeconds: 3,
      mineruPollTimeoutMinutes: 5,
    })
  })

  it("saves MinerU polling fields as clamped millisecond config", () => {
    const tooLow = {
      ...draftWithMineru({ enabled: true, token: " token ", modelVersion: "vlm" }),
      mineruPollIntervalSeconds: 0,
      mineruPollTimeoutMinutes: 0,
    }
    const tooHigh = {
      ...tooLow,
      mineruPollIntervalSeconds: 999,
      mineruPollTimeoutMinutes: 999,
    }

    expect(mineruConfigFromDraft(tooLow)).toMatchObject({
      token: "token",
      pollIntervalMs: 500,
      pollTimeoutMs: 60000,
    })
    expect(mineruConfigFromDraft(tooHigh)).toMatchObject({
      pollIntervalMs: 30000,
      pollTimeoutMs: 1800000,
    })
  })
})

describe("describeFailedSettingsKeys", () => {
  it("labels each failed step with its settings category and flags Rust-locked keys", () => {
    const description = describeFailedSettingsKeys(["embedding", "proxy"], i18n.t.bind(i18n))
    expect(description).toContain("Embeddings")
    expect(description).toContain("Network")
    expect(description).toContain("may not take effect until the next launch")
  })
})

describe("SettingsView handleSave step isolation", () => {
  beforeEach(() => {
    vi.mocked(saveEmbeddingConfig).mockReset()
    vi.mocked(saveMineruConfig).mockReset().mockResolvedValue(undefined)
    vi.mocked(saveLlmConfig).mockReset().mockResolvedValue(undefined)
    vi.mocked(saveProxyConfig).mockReset().mockResolvedValue(undefined)
  })

  it("keeps running later save steps and reports a partial-error status when one step fails", async () => {
    vi.mocked(saveEmbeddingConfig).mockRejectedValueOnce(new Error("disk full"))

    const { container, root } = renderSettingsView()
    await flush()
    await clickCategoryAndSave(container, "network")

    // The embedding step failed, but MinerU (a later step in handleSave)
    // must still have run — proving the failure didn't abort the rest.
    expect(saveMineruConfig).toHaveBeenCalled()
    expect(container.textContent).toContain("Embeddings")

    unmount(root)
  })

  it("does not roll back an earlier successful step when a later step fails", async () => {
    vi.mocked(saveEmbeddingConfig).mockRejectedValueOnce(new Error("disk full"))
    // persistSetting only calls its `set` a second time (the revert) when
    // ITS OWN persist rejects. The llm step's own save (saveLlmConfig)
    // never rejects here, so setLlmConfig must be invoked exactly once —
    // the optimistic apply — regardless of the embedding step's failure.
    const setLlmConfigSpy = vi.spyOn(useWikiStore.getState(), "setLlmConfig")

    const { container, root } = renderSettingsView()
    await flush()
    await clickCategoryAndSave(container, "network")

    expect(setLlmConfigSpy).toHaveBeenCalledTimes(1)

    setLlmConfigSpy.mockRestore()
    unmount(root)
  })

  it("flags Rust-locked settings when their save fails, noting they may not apply until restart", async () => {
    vi.mocked(saveProxyConfig).mockRejectedValueOnce(new Error("disk full"))

    const { container, root } = renderSettingsView()
    await flush()
    await clickCategoryAndSave(container, "network")

    expect(container.textContent).toContain("Network")
    expect(container.textContent).toContain("may not take effect until the next launch")

    unmount(root)
  })
})

describe("SettingsView persist-gated live-apply side effects", () => {
  const enabledSourceWatch = {
    enabled: true,
    autoIngest: false,
    includeExtensions: [],
    excludeExtensions: [],
    excludeDirs: [],
    excludeGlobs: [],
    maxFileSizeMb: 10,
  }
  const enabledScheduledImport = {
    enabled: true,
    path: "/project/raw/sources",
    interval: 60,
    lastScan: null,
  }

  beforeEach(() => {
    vi.mocked(saveSourceWatchConfig).mockReset().mockResolvedValue(undefined)
    vi.mocked(saveScheduledImportConfig).mockReset().mockResolvedValue(undefined)
    vi.mocked(startProjectFileSync).mockReset().mockResolvedValue(undefined)
    vi.mocked(stopProjectFileSync).mockReset().mockResolvedValue(undefined)
    vi.mocked(startScheduledImport).mockReset()
    vi.mocked(stopScheduledImport).mockReset()
  })

  it("does not start the file watcher or scheduled import when their config fails to persist", async () => {
    vi.mocked(saveSourceWatchConfig).mockRejectedValueOnce(new Error("disk full"))
    vi.mocked(saveScheduledImportConfig).mockRejectedValueOnce(new Error("disk full"))

    const { container, root } = renderSettingsView()
    await flush()
    await setStoreAndFlush(() => {
      useWikiStore.setState({
        sourceWatchConfig: enabledSourceWatch,
        scheduledImportConfig: enabledScheduledImport,
      } as never)
    })

    await clickCategoryAndSave(container, "network")

    // ok === false for both steps, so the `if (ok && ...)` / `if (ok)`
    // gate must skip the live-apply entirely — neither start nor stop
    // should run against a config that never made it to disk.
    expect(startProjectFileSync).not.toHaveBeenCalled()
    expect(stopProjectFileSync).not.toHaveBeenCalled()
    expect(startScheduledImport).not.toHaveBeenCalled()
    expect(stopScheduledImport).not.toHaveBeenCalled()

    unmount(root)
  })

  it("starts the file watcher and scheduled import when their config persists successfully", async () => {
    const { container, root } = renderSettingsView()
    await flush()
    await setStoreAndFlush(() => {
      useWikiStore.setState({
        sourceWatchConfig: enabledSourceWatch,
        scheduledImportConfig: enabledScheduledImport,
      } as never)
    })

    await clickCategoryAndSave(container, "network")

    expect(startProjectFileSync).toHaveBeenCalledTimes(1)
    expect(startScheduledImport).toHaveBeenCalledTimes(1)

    unmount(root)
  })
})

describe("SettingsView proxy/apiConfig live-apply gating", () => {
  beforeEach(() => {
    vi.mocked(saveProxyConfig).mockReset().mockResolvedValue(undefined)
    vi.mocked(saveApiConfig).mockReset().mockResolvedValue(undefined)
    vi.mocked(invoke).mockReset().mockResolvedValue("")
  })

  it("does not push the live proxy env when saving the proxy config fails", async () => {
    vi.mocked(saveProxyConfig).mockRejectedValueOnce(new Error("disk full"))

    const { container, root } = renderSettingsView()
    await flush()
    await clickCategoryAndSave(container, "network")

    // set_proxy_env directly injects newProxy into this process's live
    // HTTP env — unlike a disk write, there's no "will apply on restart"
    // fallback, so pushing it after a failed save would leave the
    // running process on a value memory/disk both disagree with.
    expect(invoke).not.toHaveBeenCalledWith("set_proxy_env", expect.anything())

    unmount(root)
  })

  it("pushes the live proxy env when saving the proxy config succeeds", async () => {
    const { container, root } = renderSettingsView()
    await flush()
    await clickCategoryAndSave(container, "network")

    expect(invoke).toHaveBeenCalledWith("set_proxy_env", expect.anything())

    unmount(root)
  })

  it("does not reload the API server config cache when saving apiConfig fails", async () => {
    vi.mocked(saveApiConfig).mockRejectedValueOnce(new Error("disk full"))

    const { container, root } = renderSettingsView()
    await flush()
    await clickCategoryAndSave(container, "network")

    expect(invoke).not.toHaveBeenCalledWith("api_server_reload_config")

    unmount(root)
  })

  it("reloads the API server config cache when saving apiConfig succeeds", async () => {
    const { container, root } = renderSettingsView()
    await flush()
    await clickCategoryAndSave(container, "network")

    expect(invoke).toHaveBeenCalledWith("api_server_reload_config")

    unmount(root)
  })
})
