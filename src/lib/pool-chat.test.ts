import { beforeEach, describe, expect, it, vi } from "vitest"
import type { RuntimeProfilePoolClaim, RuntimeProfileRecord } from "@/commands/runtime-db"

const runtimeDbMocks = vi.hoisted(() => ({
  runtimeModelCallStream: vi.fn(),
  runtimeModelCallStreamCancel: vi.fn(),
  runtimeProfileList: vi.fn(),
  runtimeProfilePoolClaim: vi.fn(),
  runtimeProfilePoolList: vi.fn(),
  runtimeProfilePoolRelease: vi.fn(),
}))

const llmClientMocks = vi.hoisted(() => ({
  streamChat: vi.fn(),
}))

vi.mock("@tauri-apps/api/core", () => ({
  Channel: class<T> {
    onmessage?: (message: T) => void
  },
}))

vi.mock("@/commands/runtime-db", () => runtimeDbMocks)
vi.mock("@/lib/llm-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/llm-client")>()
  return {
    ...actual,
    streamChat: llmClientMocks.streamChat,
  }
})

function profile(overrides: Partial<RuntimeProfileRecord> = {}): RuntimeProfileRecord {
  return {
    profileId: "profile-chat",
    kind: "model-call",
    displayName: "Chat Profile",
    providerId: "openai",
    modelId: "gpt-test",
    endpoint: null,
    apiMode: "openai-chat-completions",
    authStyle: "bearer",
    secretRef: "llm-wiki-profile-secret:00000000-0000-4000-8000-000000000000",
    enabled: true,
    taskFamilies: ["chat"],
    maxConcurrency: 1,
    capabilityStatus: "supported",
    capabilityJson: JSON.stringify({ modelCallSupported: true }),
    capabilityVersion: "profile-probe.v1",
    createdAtMs: 1,
    updatedAtMs: 1,
    ...overrides,
  }
}

function claim(overrides: Partial<RuntimeProfilePoolClaim> = {}): RuntimeProfilePoolClaim {
  return {
    claimId: "claim-chat",
    profileId: "profile-chat",
    expiresAtMs: 1_202,
    claim: {
      claimId: "claim-chat",
      profileId: "profile-chat",
      kind: "model-call",
      taskFamily: "chat",
      holder: "chat:1",
      acquiredAtMs: 2,
      expiresAtMs: 1_202,
      status: "active",
    },
    ...overrides,
  }
}

describe("claimModelCallProfileForFamily", () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    runtimeDbMocks.runtimeProfilePoolList.mockResolvedValue({
      enabled: true,
      status: "healthy",
      activeClaims: [],
      circuitBreakers: [],
    })
    runtimeDbMocks.runtimeProfileList.mockResolvedValue({
      enabled: true,
      status: "healthy",
      profiles: [profile()],
    })
    runtimeDbMocks.runtimeProfilePoolClaim.mockResolvedValue(claim())
    runtimeDbMocks.runtimeModelCallStreamCancel.mockResolvedValue(undefined)
    runtimeDbMocks.runtimeProfilePoolRelease.mockResolvedValue({
      claim: claim().claim,
      circuitBreaker: null,
    })
    llmClientMocks.streamChat.mockResolvedValue(undefined)
  })

  it("returns null when the pool is disabled", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined)
    runtimeDbMocks.runtimeProfilePoolList.mockResolvedValue({
      enabled: false,
      status: "disabled",
      activeClaims: [],
      circuitBreakers: [],
    })
    const { claimModelCallProfileForFamily } = await import("./pool-chat")

    await expect(claimModelCallProfileForFamily("chat", "chat:1")).resolves.toBeNull()
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("taskFamily=chat"))
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("pool disabled/no candidates"))
    expect(runtimeDbMocks.runtimeProfileList).not.toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it("throws when the pool is enabled but unhealthy", async () => {
    runtimeDbMocks.runtimeProfilePoolList.mockResolvedValue({
      enabled: true,
      status: "error",
      activeClaims: [],
      circuitBreakers: [],
    })
    const { claimModelCallProfileForFamily } = await import("./pool-chat")

    await expect(claimModelCallProfileForFamily("chat", "chat:1")).rejects.toThrow(
      "profile-unavailable: profile pool is error",
    )
  })

  it("returns null when no model-call profile candidate exists", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined)
    runtimeDbMocks.runtimeProfileList.mockResolvedValue({
      enabled: true,
      status: "healthy",
      profiles: [profile({ taskFamilies: ["ingest"] })],
    })
    const { claimModelCallProfileForFamily } = await import("./pool-chat")

    await expect(claimModelCallProfileForFamily("chat", "chat:1")).resolves.toBeNull()
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("taskFamily=chat"))
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("pool disabled/no candidates"))
    expect(runtimeDbMocks.runtimeProfilePoolClaim).not.toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it("returns null for unprobed model-call profiles", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined)
    runtimeDbMocks.runtimeProfileList.mockResolvedValue({
      enabled: true,
      status: "healthy",
      profiles: [profile({
        capabilityStatus: "unknown",
        capabilityJson: "{}",
        capabilityVersion: "",
      })],
    })
    const { claimModelCallProfileForFamily } = await import("./pool-chat")

    await expect(claimModelCallProfileForFamily("chat", "chat:1")).resolves.toBeNull()
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("pool disabled/no candidates"))
    expect(runtimeDbMocks.runtimeProfilePoolClaim).not.toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it("throws when candidates exist but claim fails", async () => {
    runtimeDbMocks.runtimeProfilePoolClaim.mockRejectedValue(new Error("capacity exhausted"))
    const { claimModelCallProfileForFamily } = await import("./pool-chat")

    await expect(claimModelCallProfileForFamily("chat", "chat:1")).rejects.toThrow(
      "profile-unavailable: capacity exhausted",
    )
  })

  it("releases the claim when the claimed profile is missing from the listed profiles", async () => {
    runtimeDbMocks.runtimeProfilePoolClaim.mockResolvedValue({
      ...claim(),
      profileId: "profile-missing",
    })
    const { claimModelCallProfileForFamily } = await import("./pool-chat")

    await expect(claimModelCallProfileForFamily("chat", "chat:1")).rejects.toThrow(
      "profile-unavailable: claimed profile is not present in profile list",
    )
    expect(runtimeDbMocks.runtimeProfilePoolRelease).toHaveBeenCalledWith({
      claimId: "claim-chat",
      outcome: "error",
      error: "claimed profile is not present in profile list",
    })
  })
})

describe("streamChatRouted", () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    runtimeDbMocks.runtimeProfilePoolList.mockResolvedValue({
      enabled: true,
      status: "healthy",
      activeClaims: [],
      circuitBreakers: [],
    })
    runtimeDbMocks.runtimeProfileList.mockResolvedValue({
      enabled: true,
      status: "healthy",
      profiles: [profile()],
    })
    runtimeDbMocks.runtimeProfilePoolClaim.mockResolvedValue(claim())
    runtimeDbMocks.runtimeModelCallStreamCancel.mockResolvedValue(undefined)
    runtimeDbMocks.runtimeProfilePoolRelease.mockResolvedValue({
      claim: claim().claim,
      circuitBreaker: null,
    })
    llmClientMocks.streamChat.mockResolvedValue(undefined)
  })

  it("falls back to legacy streamChat when claim returns null", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined)
    runtimeDbMocks.runtimeProfilePoolList.mockResolvedValue({
      enabled: false,
      status: "disabled",
      activeClaims: [],
      circuitBreakers: [],
    })
    const { streamChatRouted } = await import("./pool-chat")
    const callbacks = {
      onToken: vi.fn(),
      onDone: vi.fn(),
      onError: vi.fn(),
    }
    const llmConfig = {
      provider: "openai" as const,
      apiKey: "legacy-key",
      model: "legacy",
      ollamaUrl: "",
      customEndpoint: "",
      maxContextSize: 128_000,
      reasoning: { mode: "auto" as const },
    }
    const messages = [{ role: "user" as const, content: "hello" }]

    await streamChatRouted("chat", llmConfig, messages, callbacks)

    expect(llmClientMocks.streamChat).toHaveBeenCalledWith(
      llmConfig,
      messages,
      callbacks,
      undefined,
      undefined,
    )
    expect(runtimeDbMocks.runtimeProfilePoolRelease).not.toHaveBeenCalled()
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("taskFamily=chat"))
    warnSpy.mockRestore()
  })

  it("falls back to legacy streamChat when only unknown chat profiles exist", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined)
    runtimeDbMocks.runtimeProfileList.mockResolvedValue({
      enabled: true,
      status: "healthy",
      profiles: [profile({
        capabilityStatus: "unknown",
        capabilityJson: "{}",
        capabilityVersion: "",
      })],
    })
    const { streamChatRouted } = await import("./pool-chat")
    const callbacks = {
      onToken: vi.fn(),
      onDone: vi.fn(),
      onError: vi.fn(),
    }
    const llmConfig = {
      provider: "openai" as const,
      apiKey: "legacy-key",
      model: "legacy",
      ollamaUrl: "",
      customEndpoint: "",
      maxContextSize: 128_000,
      reasoning: { mode: "auto" as const },
    }

    await streamChatRouted(
      "chat",
      llmConfig,
      [{ role: "user", content: "hello" }],
      callbacks,
      undefined,
      undefined,
      "chat:1",
    )

    expect(runtimeDbMocks.runtimeProfilePoolClaim).not.toHaveBeenCalled()
    expect(llmClientMocks.streamChat).toHaveBeenCalledTimes(1)
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("pool disabled/no candidates"))
    warnSpy.mockRestore()
  })

  it("emits a fallback pool status when claim reports a requested profile fallback", async () => {
    runtimeDbMocks.runtimeProfileList.mockResolvedValue({
      enabled: true,
      status: "healthy",
      profiles: [
        profile({ profileId: "profile-primary", displayName: "Primary" }),
        profile({ profileId: "profile-fallback", displayName: "Fallback" }),
      ],
    })
    runtimeDbMocks.runtimeProfilePoolClaim.mockResolvedValue(claim({
      profileId: "profile-fallback",
      requestedProfileId: "profile-primary",
      fallbackReason: "disabled",
      claim: {
        ...claim().claim,
        profileId: "profile-fallback",
      },
    }))
    const { streamChatRouted } = await import("./pool-chat")
    const callbacks = {
      onToken: vi.fn(),
      onDone: vi.fn(),
      onError: vi.fn(),
    }
    const onPoolStatus = vi.fn()

    await streamChatRouted(
      "chat",
      {
        provider: "openai",
        apiKey: "",
        model: "legacy",
        ollamaUrl: "",
        customEndpoint: "",
        maxContextSize: 128_000,
        reasoning: { mode: "auto" },
      },
      [{ role: "user", content: "hello" }],
      callbacks,
      undefined,
      undefined,
      "chat:1",
      onPoolStatus,
    )

    expect(onPoolStatus).toHaveBeenCalledWith({
      type: "fallback",
      requestedProfileId: "profile-primary",
      profileId: "profile-fallback",
      reason: "disabled",
    })
  })

  it("releases rate-limited streams in finally", async () => {
    runtimeDbMocks.runtimeModelCallStream.mockImplementation(async (_request, onEvent) => {
      onEvent.onmessage?.({
        type: "error",
        status: 429,
        message: "model-call-rate-limited: retryAfterMs=12000 provider returned 429 Too Many Requests",
      })
    })
    const { streamChatRouted } = await import("./pool-chat")
    const callbacks = {
      onToken: vi.fn(),
      onDone: vi.fn(),
      onError: vi.fn(),
    }

    await streamChatRouted(
      "chat",
      {
        provider: "openai",
        apiKey: "",
        model: "legacy",
        ollamaUrl: "",
        customEndpoint: "",
        maxContextSize: 128_000,
        reasoning: { mode: "auto" },
      },
      [{ role: "user", content: "hello" }],
      callbacks,
      undefined,
      undefined,
      "chat:1",
    )

    expect(callbacks.onError).toHaveBeenCalledTimes(1)
    expect(runtimeDbMocks.runtimeProfilePoolRelease).toHaveBeenCalledWith({
      claimId: "claim-chat",
      outcome: "rate-limited",
      retryAfterMs: 12000,
      error: "model-call-rate-limited: retryAfterMs=12000 provider returned 429 Too Many Requests",
    })
  })

  it("emits a cooldown pool status when release returns a circuit breaker", async () => {
    runtimeDbMocks.runtimeModelCallStream.mockImplementation(async (_request, onEvent) => {
      onEvent.onmessage?.({
        type: "error",
        status: 429,
        message: "model-call-rate-limited: retryAfterMs=12000 provider returned 429 Too Many Requests",
      })
    })
    runtimeDbMocks.runtimeProfilePoolRelease.mockResolvedValue({
      claim: claim().claim,
      circuitBreaker: {
        profileId: "profile-chat",
        status: "rate-limited",
        reason: "provider returned 429",
        error: "model-call-rate-limited",
        openedAtMs: 1_000,
        openUntilMs: 13_000,
        updatedAtMs: 1_000,
      },
    })
    const { streamChatRouted } = await import("./pool-chat")
    const callbacks = {
      onToken: vi.fn(),
      onDone: vi.fn(),
      onError: vi.fn(),
    }
    const onPoolStatus = vi.fn()

    await streamChatRouted(
      "chat",
      {
        provider: "openai",
        apiKey: "",
        model: "legacy",
        ollamaUrl: "",
        customEndpoint: "",
        maxContextSize: 128_000,
        reasoning: { mode: "auto" },
      },
      [{ role: "user", content: "hello" }],
      callbacks,
      undefined,
      undefined,
      "chat:1",
      onPoolStatus,
    )

    expect(onPoolStatus).toHaveBeenCalledWith({
      type: "cooldown",
      profileId: "profile-chat",
      reason: "provider returned 429",
      openUntilMs: 13_000,
    })
  })

  it("releases successful streams after done", async () => {
    runtimeDbMocks.runtimeModelCallStream.mockImplementation(async (_request, onEvent) => {
      onEvent.onmessage?.({
        type: "chunk",
        data: `data: ${JSON.stringify({ choices: [{ delta: { content: "hi" } }] })}\n`,
      })
      onEvent.onmessage?.({ type: "done" })
    })
    const { streamChatRouted } = await import("./pool-chat")
    const callbacks = {
      onToken: vi.fn(),
      onDone: vi.fn(),
      onError: vi.fn(),
    }

    await streamChatRouted(
      "chat",
      {
        provider: "openai",
        apiKey: "",
        model: "legacy",
        ollamaUrl: "",
        customEndpoint: "",
        maxContextSize: 128_000,
        reasoning: { mode: "auto" },
      },
      [{ role: "user", content: "hello" }],
      callbacks,
    )

    expect(callbacks.onToken).toHaveBeenCalledWith("hi")
    expect(callbacks.onDone).toHaveBeenCalledTimes(1)
    expect(runtimeDbMocks.runtimeProfilePoolRelease).toHaveBeenCalledWith({
      claimId: "claim-chat",
      outcome: "success",
      retryAfterMs: undefined,
      error: undefined,
    })
  })

  it("does not release twice when an active pool stream is aborted", async () => {
    const controller = new AbortController()
    runtimeDbMocks.runtimeModelCallStream.mockImplementation(async (_request, onEvent) => {
      controller.abort()
      onEvent.onmessage?.({ type: "done" })
    })
    const { streamChatRouted } = await import("./pool-chat")
    const callbacks = {
      onToken: vi.fn(),
      onDone: vi.fn(),
      onError: vi.fn(),
    }

    await streamChatRouted(
      "chat",
      {
        provider: "openai",
        apiKey: "",
        model: "legacy",
        ollamaUrl: "",
        customEndpoint: "",
        maxContextSize: 128_000,
        reasoning: { mode: "auto" },
      },
      [{ role: "user", content: "hello" }],
      callbacks,
      controller.signal,
      undefined,
      "chat:1",
    )

    expect(callbacks.onDone).toHaveBeenCalledTimes(1)
    expect(runtimeDbMocks.runtimeModelCallStreamCancel).toHaveBeenCalledTimes(1)
    expect(runtimeDbMocks.runtimeProfilePoolRelease).toHaveBeenCalledTimes(1)
  })
})
