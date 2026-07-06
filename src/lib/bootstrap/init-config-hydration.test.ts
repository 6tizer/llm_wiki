// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest"
import { runInitConfigHydration } from "./init-config-hydration"
import { useWikiStore, type LlmConfig } from "@/stores/wiki-store"
import type { RuntimeProfileRecord } from "@/commands/runtime-db"

const fsMocks = vi.hoisted(() => ({
  openProject: vi.fn(),
}))

const projectStoreMocks = vi.hoisted(() => ({
  getLastProject: vi.fn(),
  loadActivePresetId: vi.fn(),
  loadApiConfig: vi.fn(),
  loadEmbeddingConfig: vi.fn(),
  loadLanguage: vi.fn(),
  loadLlmConfig: vi.fn(),
  loadMineruConfig: vi.fn(),
  loadMultimodalConfig: vi.fn(),
  loadProviderConfigs: vi.fn(),
  loadProxyConfig: vi.fn(),
  loadSearchApiConfig: vi.fn(),
  loadTheme: vi.fn(),
  loadZoomLevel: vi.fn(),
  saveLlmConfig: vi.fn(),
}))

const runtimeDbMocks = vi.hoisted(() => ({
  runtimeProfileList: vi.fn(),
}))

const presetResolverMocks = vi.hoisted(() => ({
  resolveConfig: vi.fn(),
}))

vi.mock("@tauri-apps/api/core", () => ({
  Channel: class<T> {
    onmessage?: (message: T) => void
  },
}))
vi.mock("@/commands/fs", () => fsMocks)
vi.mock("@/commands/runtime-db", () => runtimeDbMocks)
vi.mock("@/lib/project-store", () => projectStoreMocks)
vi.mock("@/lib/theme", () => ({ activateThemePreference: vi.fn() }))
vi.mock("@/lib/mineru-config", () => ({ normalizeMineruConfig: vi.fn((config: unknown) => config) }))
vi.mock("@/lib/llm-presets", () => ({
  LLM_PRESETS: [{ id: "anthropic", name: "Anthropic" }],
}))
vi.mock("@/components/settings/preset-resolver", () => presetResolverMocks)

const resolvedConfig: LlmConfig = {
  provider: "anthropic",
  apiKey: "resolved-key",
  model: "claude-resolved",
  ollamaUrl: "http://localhost:11434",
  customEndpoint: "",
  maxContextSize: 204800,
  reasoning: { mode: "auto" },
  localCliIsolation: false,
  codexCliTimeoutMinutes: 10,
}

function runtimeProfile(patch: Partial<RuntimeProfileRecord> = {}): RuntimeProfileRecord {
  return {
    profileId: "profile-1",
    kind: "model-call",
    displayName: "Primary profile",
    providerId: "anthropic",
    modelId: "claude-profile",
    agentSdkModelId: null,
    endpoint: null,
    apiMode: "anthropic-messages",
    authStyle: "x-api-key",
    secretRef: null,
    enabled: true,
    taskFamilies: ["chat"],
    maxConcurrency: 1,
    capabilityStatus: "supported",
    capabilityJson: JSON.stringify({ modelCallSupported: true }),
    capabilityVersion: "profile-probe.v1",
    capabilityCheckedAtMs: null,
    probeBackoffUntilMs: null,
    lastCapabilityError: null,
    createdAtMs: 1,
    updatedAtMs: 1,
    ...patch,
  }
}

async function runHydration(): Promise<void> {
  await runInitConfigHydration({
    handleProjectOpened: vi.fn(),
    onDone: vi.fn(),
  })
}

describe("runInitConfigHydration active preset legacy fallback", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useWikiStore.setState({
      activePresetId: null,
      llmConfig: {
        provider: "openai",
        apiKey: "",
        model: "",
        ollamaUrl: "http://localhost:11434",
        customEndpoint: "",
        maxContextSize: 204800,
        reasoning: { mode: "auto" },
        localCliIsolation: false,
        codexCliTimeoutMinutes: 10,
      },
      providerConfigs: {},
    })
    projectStoreMocks.getLastProject.mockResolvedValue(null)
    projectStoreMocks.loadActivePresetId.mockResolvedValue("anthropic")
    projectStoreMocks.loadApiConfig.mockResolvedValue(null)
    projectStoreMocks.loadEmbeddingConfig.mockResolvedValue(null)
    projectStoreMocks.loadLanguage.mockResolvedValue(null)
    projectStoreMocks.loadLlmConfig.mockResolvedValue(null)
    projectStoreMocks.loadMineruConfig.mockResolvedValue(null)
    projectStoreMocks.loadMultimodalConfig.mockResolvedValue(null)
    projectStoreMocks.loadProviderConfigs.mockResolvedValue({
      anthropic: {
        apiKey: "legacy-key",
        model: "claude-legacy",
      },
    })
    projectStoreMocks.loadProxyConfig.mockResolvedValue(null)
    projectStoreMocks.loadSearchApiConfig.mockResolvedValue(null)
    projectStoreMocks.loadTheme.mockResolvedValue("system")
    projectStoreMocks.loadZoomLevel.mockResolvedValue(1)
    projectStoreMocks.saveLlmConfig.mockResolvedValue(undefined)
    presetResolverMocks.resolveConfig.mockReturnValue(resolvedConfig)
  })

  it("keeps activePresetId but skips legacy re-resolve/write-back when a supported chat model-call profile exists", async () => {
    runtimeDbMocks.runtimeProfileList.mockResolvedValue({
      enabled: true,
      status: "healthy",
      profiles: [runtimeProfile()],
    })

    await runHydration()

    expect(useWikiStore.getState().activePresetId).toBe("anthropic")
    expect(runtimeDbMocks.runtimeProfileList).toHaveBeenCalledTimes(1)
    expect(presetResolverMocks.resolveConfig).not.toHaveBeenCalled()
    expect(projectStoreMocks.saveLlmConfig).not.toHaveBeenCalled()
  })

  it("runs the legacy re-resolve/write-back when enabled profiles are unprobed or unsupported", async () => {
    runtimeDbMocks.runtimeProfileList.mockResolvedValue({
      enabled: true,
      status: "healthy",
      profiles: [
        runtimeProfile({
          profileId: "profile-unknown",
          capabilityStatus: "unknown",
        }),
        runtimeProfile({
          profileId: "profile-unsupported",
          capabilityStatus: "unsupported",
        }),
      ],
    })

    await runHydration()

    expect(presetResolverMocks.resolveConfig).toHaveBeenCalledTimes(1)
    expect(useWikiStore.getState().llmConfig).toEqual(resolvedConfig)
    expect(projectStoreMocks.saveLlmConfig).toHaveBeenCalledWith(resolvedConfig)
  })

  it("runs the legacy re-resolve/write-back when profiles do not include the chat task family", async () => {
    runtimeDbMocks.runtimeProfileList.mockResolvedValue({
      enabled: true,
      status: "healthy",
      profiles: [runtimeProfile({ taskFamilies: ["ingest"] })],
    })

    await runHydration()

    expect(presetResolverMocks.resolveConfig).toHaveBeenCalledTimes(1)
    expect(useWikiStore.getState().llmConfig).toEqual(resolvedConfig)
    expect(projectStoreMocks.saveLlmConfig).toHaveBeenCalledWith(resolvedConfig)
  })

  it("runs the legacy re-resolve/write-back when no active model-call profile exists", async () => {
    runtimeDbMocks.runtimeProfileList.mockResolvedValue({
      enabled: true,
      status: "healthy",
      profiles: [],
    })

    await runHydration()

    expect(presetResolverMocks.resolveConfig).toHaveBeenCalledTimes(1)
    expect(useWikiStore.getState().llmConfig).toEqual(resolvedConfig)
    expect(projectStoreMocks.saveLlmConfig).toHaveBeenCalledWith(resolvedConfig)
  })

  it("fails open to the legacy re-resolve/write-back when profile listing fails", async () => {
    runtimeDbMocks.runtimeProfileList.mockRejectedValue(new Error("runtime profile list failed"))

    await runHydration()

    expect(presetResolverMocks.resolveConfig).toHaveBeenCalledTimes(1)
    expect(useWikiStore.getState().llmConfig).toEqual(resolvedConfig)
    expect(projectStoreMocks.saveLlmConfig).toHaveBeenCalledWith(resolvedConfig)
  })
})
