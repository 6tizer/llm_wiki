import { describe, expect, it } from "vitest"

import {
  coerceSettingsCategory,
  getSettingsCategories,
  isMacLikeRuntime,
  initialDraft,
  mineruConfigFromDraft,
  persistAppPreferences,
  shouldShowGlobalSettingsSaveBar,
} from "./settings-view"

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
    expect(nonMacCategories.some((category) => category.id === "knowledge-agents")).toBe(true)
    expect(nonMacCategories.some((category) => category.id === "taxonomy")).toBe(true)
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
