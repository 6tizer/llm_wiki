// @vitest-environment jsdom

import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { beforeEach, describe, expect, it, vi } from "vitest"
import "@/i18n"
import { useWikiStore } from "@/stores/wiki-store"
import { ProviderMigrationBanner } from "./provider-migration-banner"
import type { RuntimeProfileRecord } from "@/commands/runtime-db"

const runtimeDbMocks = vi.hoisted(() => ({
  runtimeProfileCreate: vi.fn(),
  runtimeProfileDelete: vi.fn(),
  runtimeProfileList: vi.fn(),
  runtimeProfileProbe: vi.fn(),
  runtimeProfileUpdate: vi.fn(),
}))

const secretMocks = vi.hoisted(() => ({
  profileSecretWrite: vi.fn(),
  profileSecretDelete: vi.fn(),
}))

vi.mock("@/commands/runtime-db", () => runtimeDbMocks)
vi.mock("@/commands/profile-secrets", () => secretMocks)

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true

function runtimeProfile(patch: Partial<RuntimeProfileRecord> = {}): RuntimeProfileRecord {
  return {
    profileId: "profile-1",
    kind: "model-call",
    displayName: "Migrated: anthropic",
    providerId: "anthropic",
    modelId: "claude-test",
    agentSdkModelId: null,
    endpoint: null,
    apiMode: "anthropic-messages",
    authStyle: "x-api-key",
    secretRef: "llm-wiki-profile-secret:11111111-1111-4111-8111-111111111111",
    enabled: true,
    taskFamilies: ["chat"],
    maxConcurrency: 1,
    capabilityStatus: "unknown",
    capabilityJson: "{}",
    capabilityVersion: "spec-4-pr1",
    capabilityCheckedAtMs: null,
    probeBackoffUntilMs: null,
    lastCapabilityError: null,
    createdAtMs: 1,
    updatedAtMs: 1,
    ...patch,
  }
}

function renderBanner(): { container: HTMLDivElement; root: Root } {
  const container = document.createElement("div")
  document.body.appendChild(container)
  const root = createRoot(container)

  act(() => {
    root.render(<ProviderMigrationBanner />)
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

describe("ProviderMigrationBanner", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useWikiStore.setState({
      activePresetId: "anthropic",
      providerConfigs: {
        anthropic: {
          apiKey: "legacy-secret",
          model: "claude-test",
        },
      },
    })
    secretMocks.profileSecretWrite.mockResolvedValue({
      secretRef: "llm-wiki-profile-secret:22222222-2222-4222-8222-222222222222",
    })
    secretMocks.profileSecretDelete.mockResolvedValue({ ok: true })
  })

  it("creates a migrated profile from the active preset through the profile secret boundary", async () => {
    const saved = runtimeProfile({
      secretRef: "llm-wiki-profile-secret:22222222-2222-4222-8222-222222222222",
    })
    runtimeDbMocks.runtimeProfileList.mockResolvedValueOnce({
      enabled: true,
      status: "healthy",
      profiles: [],
    })
    runtimeDbMocks.runtimeProfileCreate.mockResolvedValueOnce(saved)

    const { container, root } = renderBanner()
    await flush()

    const create = container.querySelector("[data-testid='provider-migration-create']")
    if (!create) throw new Error("migration create button not found")
    await click(create)

    expect(secretMocks.profileSecretWrite).toHaveBeenCalledWith({ secretValue: "legacy-secret" })
    expect(runtimeDbMocks.runtimeProfileCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "model-call",
        displayName: "Migrated: anthropic",
        providerId: "anthropic",
        modelId: "claude-test",
        agentSdkModelId: null,
        apiMode: "anthropic-messages",
        authStyle: "x-api-key",
        secretRef: "llm-wiki-profile-secret:22222222-2222-4222-8222-222222222222",
        enabled: true,
        taskFamilies: ["chat"],
        maxConcurrency: 1,
      }),
    )
    expect(container.querySelector("[data-testid='provider-migration-complete']")).not.toBeNull()

    unmount(root)
  })

  it("corrects Anthropic-compatible legacy presets through provider access templates", async () => {
    useWikiStore.setState({
      activePresetId: "minimax-global",
      providerConfigs: {},
    })
    runtimeDbMocks.runtimeProfileList.mockResolvedValueOnce({
      enabled: true,
      status: "healthy",
      profiles: [],
    })
    runtimeDbMocks.runtimeProfileCreate.mockResolvedValueOnce(runtimeProfile({
      displayName: "Migrated: minimax-global",
      providerId: "minimax",
      modelId: "MiniMax-M2.7",
      endpoint: "https://api.minimaxi.com/anthropic",
      apiMode: "anthropic-messages",
      authStyle: "bearer",
      secretRef: null,
    }))

    const { container, root } = renderBanner()
    await flush()

    const create = container.querySelector("[data-testid='provider-migration-create']")
    if (!create) throw new Error("migration create button not found")
    await click(create)

    expect(runtimeDbMocks.runtimeProfileCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        displayName: "Migrated: minimax-global",
        providerId: "minimax",
        modelId: "MiniMax-M2.7",
        endpoint: "https://api.minimaxi.com/anthropic",
        apiMode: "anthropic-messages",
      }),
    )

    unmount(root)
  })

  it("keeps OpenAI templates and corrects mapped OpenAI-compatible legacy presets", async () => {
    runtimeDbMocks.runtimeProfileList.mockResolvedValue({
      enabled: true,
      status: "healthy",
      profiles: [],
    })
    runtimeDbMocks.runtimeProfileCreate.mockResolvedValue(runtimeProfile({ apiMode: "openai-chat-completions" }))

    useWikiStore.setState({ activePresetId: "openai", providerConfigs: {} })
    const openai = renderBanner()
    await flush()
    const openaiCreate = openai.container.querySelector("[data-testid='provider-migration-create']")
    if (!openaiCreate) throw new Error("openai create button not found")
    await click(openaiCreate)
    expect(runtimeDbMocks.runtimeProfileCreate).toHaveBeenLastCalledWith(
      expect.objectContaining({ providerId: "openai", apiMode: "openai-chat-completions" }),
    )
    unmount(openai.root)

    useWikiStore.setState({ activePresetId: "zhipu", providerConfigs: {} })
    const customOpenAi = renderBanner()
    await flush()
    const customCreate = customOpenAi.container.querySelector("[data-testid='provider-migration-create']")
    if (!customCreate) throw new Error("custom create button not found")
    await click(customCreate)
    expect(runtimeDbMocks.runtimeProfileCreate).toHaveBeenLastCalledWith(
      expect.objectContaining({
        providerId: "zhipu-glm",
        endpoint: "https://open.bigmodel.cn/api/anthropic",
        apiMode: "anthropic-messages",
      }),
    )
    unmount(customOpenAi.root)
  })

  it("migrates kimi through the template Anthropic-compatible endpoint", async () => {
    useWikiStore.setState({ activePresetId: "kimi", providerConfigs: {} })
    runtimeDbMocks.runtimeProfileList.mockResolvedValueOnce({
      enabled: true,
      status: "healthy",
      profiles: [],
    })
    runtimeDbMocks.runtimeProfileCreate.mockResolvedValueOnce(runtimeProfile({
      displayName: "Migrated: kimi",
      providerId: "kimi",
      endpoint: "https://api.moonshot.cn/anthropic",
      apiMode: "anthropic-messages",
    }))

    const { container, root } = renderBanner()
    await flush()

    expect(container.querySelector("[data-testid='provider-migration-template-note']")).not.toBeNull()
    const create = container.querySelector("[data-testid='provider-migration-create']")
    if (!create) throw new Error("migration create button not found")
    await click(create)

    expect(runtimeDbMocks.runtimeProfileCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        displayName: "Migrated: kimi",
        providerId: "kimi",
        endpoint: "https://api.moonshot.cn/anthropic",
        apiMode: "anthropic-messages",
      }),
    )
    unmount(root)
  })

  it("does not replace custom migration endpoints with template placeholders", async () => {
    useWikiStore.setState({
      activePresetId: "custom",
      providerConfigs: {
        custom: {
          apiKey: "custom-secret",
          model: "custom-model",
          baseUrl: "https://real-gateway.example.com/v1",
          apiMode: "anthropic_messages",
        },
      },
    })
    runtimeDbMocks.runtimeProfileList.mockResolvedValueOnce({
      enabled: true,
      status: "healthy",
      profiles: [],
    })
    runtimeDbMocks.runtimeProfileCreate.mockResolvedValueOnce(runtimeProfile({
      displayName: "Migrated: custom",
      providerId: "custom",
      endpoint: "https://real-gateway.example.com/v1",
      apiMode: "anthropic-messages",
    }))

    const { container, root } = renderBanner()
    await flush()

    expect(container.querySelector("[data-testid='provider-migration-template-note']")).toBeNull()
    const create = container.querySelector("[data-testid='provider-migration-create']")
    if (!create) throw new Error("migration create button not found")
    await click(create)

    expect(runtimeDbMocks.runtimeProfileCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: "custom",
        endpoint: "https://real-gateway.example.com/v1",
        apiMode: "anthropic-messages",
      }),
    )
    expect(runtimeDbMocks.runtimeProfileCreate).not.toHaveBeenCalledWith(
      expect.objectContaining({ endpoint: "https://your-provider.example.com/v1" }),
    )
    unmount(root)
  })

  it("does not replace azure migration endpoints with template placeholders", async () => {
    useWikiStore.setState({
      activePresetId: "azure",
      providerConfigs: {
        azure: {
          apiKey: "azure-secret",
          model: "prod-deployment",
          baseUrl: "https://prod-resource.openai.azure.com/openai/deployments/prod-deployment",
        },
      },
    })
    runtimeDbMocks.runtimeProfileList.mockResolvedValueOnce({
      enabled: true,
      status: "healthy",
      profiles: [],
    })
    runtimeDbMocks.runtimeProfileCreate.mockResolvedValueOnce(runtimeProfile({
      displayName: "Migrated: azure",
      providerId: "azure",
      endpoint: "https://prod-resource.openai.azure.com/openai/deployments/prod-deployment",
      apiMode: "openai-chat-completions",
    }))

    const { container, root } = renderBanner()
    await flush()

    expect(container.querySelector("[data-testid='provider-migration-template-note']")).toBeNull()
    const create = container.querySelector("[data-testid='provider-migration-create']")
    if (!create) throw new Error("migration create button not found")
    await click(create)

    expect(runtimeDbMocks.runtimeProfileCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: "azure",
        endpoint: "https://prod-resource.openai.azure.com/openai/deployments/prod-deployment",
        apiMode: "openai-chat-completions",
      }),
    )
    expect(runtimeDbMocks.runtimeProfileCreate).not.toHaveBeenCalledWith(
      expect.objectContaining({ endpoint: "https://your-resource.openai.azure.com/openai/deployments/your-deployment" }),
    )
    unmount(root)
  })

  it("can keep the resolved endpoint while applying template api/auth corrections", async () => {
    useWikiStore.setState({
      activePresetId: "kimi",
      providerConfigs: {
        kimi: {
          model: "kimi-k2.7-code",
          baseUrl: "https://legacy.moonshot.example/anthropic",
        },
      },
    })
    runtimeDbMocks.runtimeProfileList.mockResolvedValueOnce({
      enabled: true,
      status: "healthy",
      profiles: [],
    })
    runtimeDbMocks.runtimeProfileCreate.mockResolvedValueOnce(runtimeProfile({
      displayName: "Migrated: kimi",
      providerId: "kimi",
      endpoint: "https://legacy.moonshot.example/anthropic",
      apiMode: "anthropic-messages",
    }))

    const { container, root } = renderBanner()
    await flush()

    expect(container.querySelector("[data-testid='provider-migration-template-note']")?.textContent)
      .toContain("https://legacy.moonshot.example/anthropic")
    const keep = container.querySelector<HTMLInputElement>("[data-testid='provider-migration-keep-endpoint']")
    if (!keep) throw new Error("keep endpoint checkbox not found")
    await click(keep)
    const create = container.querySelector("[data-testid='provider-migration-create']")
    if (!create) throw new Error("migration create button not found")
    await click(create)

    expect(runtimeDbMocks.runtimeProfileCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: "kimi",
        endpoint: "https://legacy.moonshot.example/anthropic",
        apiMode: "anthropic-messages",
        authStyle: "bearer",
      }),
    )
    unmount(root)
  })

  it("cleans up a newly written secret and stays retryable when profile creation fails", async () => {
    runtimeDbMocks.runtimeProfileList.mockResolvedValueOnce({
      enabled: true,
      status: "healthy",
      profiles: [],
    })
    runtimeDbMocks.runtimeProfileCreate.mockRejectedValueOnce(new Error("db rejected"))

    const { container, root } = renderBanner()
    await flush()

    const create = container.querySelector<HTMLButtonElement>("[data-testid='provider-migration-create']")
    if (!create) throw new Error("migration create button not found")
    await click(create)

    expect(secretMocks.profileSecretDelete).toHaveBeenCalledWith({
      secretRef: "llm-wiki-profile-secret:22222222-2222-4222-8222-222222222222",
    })
    expect(container.textContent).toContain("Migration failed: db rejected")
    expect(container.querySelector("[data-testid='provider-migration-banner']")).not.toBeNull()
    expect(create.disabled).toBe(false)

    unmount(root)
  })

  it("is idempotent when a migrated profile with the active provider already exists", async () => {
    runtimeDbMocks.runtimeProfileList.mockResolvedValueOnce({
      enabled: true,
      status: "healthy",
      profiles: [runtimeProfile()],
    })

    const { container, root } = renderBanner()
    await flush()

    expect(container.querySelector("[data-testid='provider-migration-banner']")).toBeNull()
    expect(container.querySelector("[data-testid='provider-migration-complete']")).not.toBeNull()
    expect(runtimeDbMocks.runtimeProfileCreate).not.toHaveBeenCalled()
    expect(secretMocks.profileSecretWrite).not.toHaveBeenCalled()

    unmount(root)
  })

  it("hides without an active preset, when no project is open, or when runtime is unavailable", async () => {
    useWikiStore.setState({ activePresetId: null })
    const noActive = renderBanner()
    await flush()
    expect(noActive.container.querySelector("[data-testid='provider-migration-banner']")).toBeNull()
    unmount(noActive.root)

    useWikiStore.setState({ activePresetId: "anthropic" })
    runtimeDbMocks.runtimeProfileList.mockResolvedValueOnce({
      enabled: true,
      status: "no-project",
      profiles: [],
    })
    const noProject = renderBanner()
    await flush()
    expect(noProject.container.querySelector("[data-testid='provider-migration-banner']")).toBeNull()
    unmount(noProject.root)

    runtimeDbMocks.runtimeProfileList.mockResolvedValueOnce({
      enabled: false,
      status: "disabled",
      profiles: [],
    })
    const disabled = renderBanner()
    await flush()
    expect(disabled.container.querySelector("[data-testid='provider-migration-banner']")).toBeNull()
    unmount(disabled.root)
  })

  it("distinguishes kimi and kimi-cn migrated profiles for idempotency", async () => {
    useWikiStore.setState({ activePresetId: "kimi", providerConfigs: {} })
    runtimeDbMocks.runtimeProfileList.mockResolvedValueOnce({
      enabled: true,
      status: "healthy",
      profiles: [
        runtimeProfile({
          displayName: "Migrated: kimi-cn",
          providerId: "kimi-cn",
        }),
      ],
    })
    runtimeDbMocks.runtimeProfileCreate.mockResolvedValueOnce(runtimeProfile({
      displayName: "Migrated: kimi",
      providerId: "kimi",
    }))

    const { container, root } = renderBanner()
    await flush()

    expect(container.querySelector("[data-testid='provider-migration-banner']")).not.toBeNull()
    const create = container.querySelector("[data-testid='provider-migration-create']")
    if (!create) throw new Error("migration create button not found")
    await click(create)

    expect(runtimeDbMocks.runtimeProfileCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        displayName: "Migrated: kimi",
        providerId: "kimi",
      }),
    )

    unmount(root)
  })
})
