// @vitest-environment jsdom

import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { beforeEach, describe, expect, it, vi } from "vitest"
import "@/i18n"
import {
  createEmptyProfileDraft,
  ModelProfilesSection,
  saveProfileDraft,
  smokeConfigFromDraft,
  taskFamiliesForRender,
  type ModelProfileDraft,
} from "./model-profiles-section"
import type { RuntimeProfileRecord } from "@/commands/runtime-db"

const runtimeDbMocks = vi.hoisted(() => ({
  runtimeProfileCreate: vi.fn(),
  runtimeProfileList: vi.fn(),
  runtimeProfileUpdate: vi.fn(),
}))

const secretMocks = vi.hoisted(() => ({
  profileSecretWrite: vi.fn(),
  profileSecretDelete: vi.fn(),
}))

const connectionMocks = vi.hoisted(() => ({
  testLlmConnection: vi.fn(),
  testLlmFunction: vi.fn(),
}))

vi.mock("@/commands/runtime-db", () => runtimeDbMocks)
vi.mock("@/commands/profile-secrets", () => secretMocks)
vi.mock("@/lib/connection-tests", () => connectionMocks)

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true

function runtimeProfile(
  patch: Partial<RuntimeProfileRecord> = {},
): RuntimeProfileRecord {
  return {
    profileId: "profile-1",
    kind: "model-call",
    displayName: "Primary profile",
    providerId: "openai",
    modelId: "gpt-4.1",
    endpoint: null,
    apiMode: "openai-chat-completions",
    authStyle: "bearer",
    secretRef: "llm-wiki-profile-secret:11111111-1111-4111-8111-111111111111",
    enabled: true,
    taskFamilies: ["chat"],
    maxConcurrency: 1,
    capabilityStatus: "unknown",
    capabilityJson: "{}",
    capabilityVersion: "profiles.v1",
    capabilityCheckedAtMs: null,
    probeBackoffUntilMs: null,
    lastCapabilityError: null,
    createdAtMs: 1,
    updatedAtMs: 1,
    ...patch,
  }
}

function renderProfiles(): { container: HTMLDivElement; root: Root } {
  const container = document.createElement("div")
  document.body.appendChild(container)
  const root = createRoot(container)

  act(() => {
    root.render(<ModelProfilesSection />)
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

async function input(element: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set
    setter?.call(element, value)
    element.dispatchEvent(new Event("input", { bubbles: true }))
    await Promise.resolve()
  })
}

function unmount(root: Root): void {
  act(() => {
    root.unmount()
  })
}

describe("ModelProfilesSection helpers", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("cleans up newly written secrets when profile create fails", async () => {
    const draft = createEmptyProfileDraft()
    draft.rawSecret = "new-secret"
    secretMocks.profileSecretWrite.mockResolvedValue({
      secretRef: "llm-wiki-profile-secret:22222222-2222-4222-8222-222222222222",
    })
    secretMocks.profileSecretDelete.mockResolvedValue({ ok: true })
    runtimeDbMocks.runtimeProfileCreate.mockRejectedValue(new Error("db rejected"))

    await expect(saveProfileDraft(draft, undefined)).rejects.toThrow("db rejected")

    expect(secretMocks.profileSecretDelete).toHaveBeenCalledWith({
      secretRef: "llm-wiki-profile-secret:22222222-2222-4222-8222-222222222222",
    })
  })

  it("keeps the old secret attached when replacement profile update fails", async () => {
    const existing = runtimeProfile()
    const draft: ModelProfileDraft = {
      ...createEmptyProfileDraft(),
      profileId: existing.profileId,
      rawSecret: "replacement",
      secretRef: existing.secretRef,
    }
    secretMocks.profileSecretWrite.mockResolvedValue({
      secretRef: "llm-wiki-profile-secret:33333333-3333-4333-8333-333333333333",
    })
    secretMocks.profileSecretDelete.mockResolvedValue({ ok: true })
    runtimeDbMocks.runtimeProfileUpdate.mockRejectedValue(new Error("update rejected"))

    await expect(saveProfileDraft(draft, existing)).rejects.toThrow("update rejected")

    expect(secretMocks.profileSecretDelete).toHaveBeenCalledTimes(1)
    expect(secretMocks.profileSecretDelete).toHaveBeenCalledWith({
      secretRef: "llm-wiki-profile-secret:33333333-3333-4333-8333-333333333333",
    })
  })

  it("clears the DB secretRef before deleting the old secret", async () => {
    const existing = runtimeProfile()
    const draft: ModelProfileDraft = {
      ...createEmptyProfileDraft(),
      profileId: existing.profileId,
      secretRef: existing.secretRef,
      clearSecret: true,
    }
    const calls: string[] = []
    secretMocks.profileSecretDelete.mockImplementation(async () => {
      calls.push("delete")
      return { ok: true }
    })
    runtimeDbMocks.runtimeProfileUpdate.mockImplementation(async (request) => {
      calls.push("update")
      expect(request.clearSecretRef).toBe(true)
      return runtimeProfile({ secretRef: null })
    })

    await expect(saveProfileDraft(draft, existing)).resolves.toMatchObject({
      secretRef: null,
    })

    expect(calls).toEqual(["update", "delete"])
  })

  it("uses raw draft secrets for smoke tests and preserves unknown task families", () => {
    const draft = createEmptyProfileDraft("custom")
    draft.apiMode = "anthropic-messages"
    draft.endpoint = "https://gateway.example/v1"
    draft.modelId = "claude-compatible"
    draft.rawSecret = "draft-only-secret"

    const mapped = smokeConfigFromDraft(draft)
    expect(mapped.ok).toBe(true)
    if (mapped.ok) {
      expect(mapped.config).toMatchObject({
        provider: "custom",
        apiKey: "draft-only-secret",
        customEndpoint: "https://gateway.example/v1",
        apiMode: "anthropic_messages",
      })
    }

    draft.rawSecret = ""
    const noRaw = smokeConfigFromDraft(draft)
    expect(noRaw.ok).toBe(false)
    if (!noRaw.ok) expect(noRaw.result.message).toContain("Stored-secret probes arrive in PR3")

    expect(taskFamiliesForRender(["chat", "future-family"])).toContain("future-family")
  })

  it("clamps profile concurrency before sending create payloads", async () => {
    runtimeDbMocks.runtimeProfileCreate.mockResolvedValue(runtimeProfile({ maxConcurrency: 128 }))
    const draft = createEmptyProfileDraft()
    draft.maxConcurrency = 999

    await expect(saveProfileDraft(draft, undefined)).resolves.toMatchObject({
      maxConcurrency: 128,
    })

    expect(runtimeDbMocks.runtimeProfileCreate).toHaveBeenCalledWith(
      expect.objectContaining({ maxConcurrency: 128 }),
    )
  })

  it("clamps invalid and below-minimum concurrency before sending create payloads", async () => {
    runtimeDbMocks.runtimeProfileCreate.mockResolvedValue(runtimeProfile({ maxConcurrency: 1 }))

    const belowMinimum = createEmptyProfileDraft()
    belowMinimum.maxConcurrency = -5
    await expect(saveProfileDraft(belowMinimum, undefined)).resolves.toMatchObject({
      maxConcurrency: 1,
    })

    const invalidNumber = createEmptyProfileDraft()
    invalidNumber.maxConcurrency = Number.NaN
    await expect(saveProfileDraft(invalidNumber, undefined)).resolves.toMatchObject({
      maxConcurrency: 1,
    })

    expect(runtimeDbMocks.runtimeProfileCreate).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ maxConcurrency: 1 }),
    )
    expect(runtimeDbMocks.runtimeProfileCreate).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ maxConcurrency: 1 }),
    )
  })
})

describe("ModelProfilesSection UI", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    runtimeDbMocks.runtimeProfileList.mockResolvedValue({
      enabled: true,
      status: "healthy",
      profiles: [runtimeProfile({ taskFamilies: ["chat", "future-family"] })],
    })
    runtimeDbMocks.runtimeProfileCreate.mockResolvedValue(runtimeProfile({ profileId: "profile-new" }))
    runtimeDbMocks.runtimeProfileUpdate.mockResolvedValue(runtimeProfile())
    secretMocks.profileSecretWrite.mockResolvedValue({
      secretRef: "llm-wiki-profile-secret:44444444-4444-4444-8444-444444444444",
    })
    secretMocks.profileSecretDelete.mockResolvedValue({ ok: true })
    connectionMocks.testLlmConnection.mockResolvedValue({ ok: true, message: "connected" })
    connectionMocks.testLlmFunction.mockResolvedValue({ ok: true, message: "ok" })
  })

  it("loads profiles and keeps unknown task family values visible", async () => {
    const { container, root } = renderProfiles()
    await flush()

    expect(container.textContent).toContain("Primary profile")
    expect(container.querySelector<HTMLInputElement>("[data-testid='profile-task-future-family']")?.checked).toBe(true)

    unmount(root)
  })

  it("keeps unknown provider ids selected and preserves them on save", async () => {
    runtimeDbMocks.runtimeProfileList.mockResolvedValueOnce({
      enabled: true,
      status: "healthy",
      profiles: [
        runtimeProfile({
          providerId: "future-provider",
          modelId: "future-model",
        }),
      ],
    })
    runtimeDbMocks.runtimeProfileUpdate.mockResolvedValueOnce(runtimeProfile({
      providerId: "future-provider",
      modelId: "future-model",
    }))
    const { container, root } = renderProfiles()
    await flush()

    expect(container.querySelector<HTMLSelectElement>("[data-testid='profile-provider']")?.value).toBe(
      "future-provider",
    )

    const save = container.querySelector<HTMLButtonElement>("[data-testid='profile-save']")
    if (!save) throw new Error("profile save button not found")
    await click(save)

    expect(runtimeDbMocks.runtimeProfileUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: "future-provider",
        modelId: "future-model",
      }),
    )

    unmount(root)
  })

  it("falls back to an empty draft when profile list returns a malformed profiles shape", async () => {
    runtimeDbMocks.runtimeProfileList.mockResolvedValueOnce({
      enabled: true,
      status: "healthy",
      profiles: null,
    })
    const { container, root } = renderProfiles()
    await flush()

    expect(container.querySelector("[data-testid='model-profiles-section']")).not.toBeNull()
    expect(container.querySelector("[data-testid='profile-save']")).not.toBeNull()
    expect(container.textContent).not.toContain("Cannot read")

    unmount(root)
  })

  it("creates profiles with a secretRef returned by the secret boundary", async () => {
    runtimeDbMocks.runtimeProfileList.mockResolvedValueOnce({
      enabled: true,
      status: "healthy",
      profiles: [],
    })
    const { container, root } = renderProfiles()
    await flush()

    const secret = container.querySelector<HTMLInputElement>("[data-testid='profile-secret']")
    const save = container.querySelector<HTMLButtonElement>("[data-testid='profile-save']")
    if (!secret || !save) throw new Error("profile form not found")

    await input(secret, "draft-secret")
    await click(save)

    expect(secretMocks.profileSecretWrite).toHaveBeenCalledWith({ secretValue: "draft-secret" })
    expect(runtimeDbMocks.runtimeProfileCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        secretRef: "llm-wiki-profile-secret:44444444-4444-4444-8444-444444444444",
        enabled: true,
        maxConcurrency: 1,
      }),
    )

    unmount(root)
  })
})
