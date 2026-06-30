// @vitest-environment jsdom

import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { beforeEach, describe, expect, it, vi } from "vitest"
import "@/i18n"
import { useWikiStore } from "@/stores/wiki-store"

import {
  coerceSettingsCategory,
  getSettingsCategories,
  isMacLikeRuntime,
  initialDraft,
  mineruConfigFromDraft,
  persistAppPreferences,
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

  it("falls back when active category is not available", () => {
    const nonMacCategories = getSettingsCategories(false)
    expect(coerceSettingsCategory("interface", nonMacCategories)).toBe("interface")
    expect(coerceSettingsCategory("general", nonMacCategories)).toBe("llm")
    expect(coerceSettingsCategory("knowledge-agents", nonMacCategories)).toBe("knowledge-agents")
    expect(coerceSettingsCategory("taxonomy", nonMacCategories)).toBe("taxonomy")
    expect(coerceSettingsCategory("synthesis", nonMacCategories)).toBe("synthesis")
    expect(nonMacCategories.some((category) => category.id === "knowledge-agents")).toBe(true)
    expect(nonMacCategories.some((category) => category.id === "taxonomy")).toBe(true)
    expect(nonMacCategories.some((category) => category.id === "synthesis")).toBe(true)
  })
})

describe("SettingsView category rendering", () => {
  it("renders SynthesisSection after clicking the synthesis sidebar category", async () => {
    const { container, root } = renderSettingsView()
    await flush()

    const synthesisButton = [...container.querySelectorAll("button")]
      .find((button) => button.textContent?.includes("Synthesis"))
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
