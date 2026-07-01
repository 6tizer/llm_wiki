// @vitest-environment jsdom

import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { beforeEach, describe, expect, it, vi } from "vitest"
import "@/i18n"
import {
  createEmptyProfileDraft,
  draftFromProfile,
  ModelProfilesSection,
  saveProfileDraft,
  taskFamiliesForRender,
  type ModelProfileDraft,
} from "./model-profiles-section"
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

function runtimeProfile(
  patch: Partial<RuntimeProfileRecord> = {},
): RuntimeProfileRecord {
  return {
    profileId: "profile-1",
    kind: "model-call",
    displayName: "Primary profile",
    providerId: "openai",
    modelId: "gpt-4.1",
    agentSdkModelId: null,
    endpoint: null,
    apiMode: "openai-chat-completions",
    authStyle: "bearer",
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

function renderProfiles(): { container: HTMLDivElement; root: Root } {
  const container = document.createElement("div")
  document.body.appendChild(container)
  const root = createRoot(container)

  act(() => {
    root.render(<ModelProfilesSection />)
  })

  return { container, root }
}

async function renderProfilesWithList(result: {
  enabled: boolean
  status: "disabled" | "healthy" | "no-project"
  profiles: RuntimeProfileRecord[] | null
}): Promise<{ container: HTMLDivElement; root: Root }> {
  runtimeDbMocks.runtimeProfileList.mockResolvedValueOnce(result)
  const rendered = renderProfiles()
  await flush()
  return rendered
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
    const existing = runtimeProfile({
      capabilityStatus: "supported",
      capabilityVersion: "profile-probe.v1",
      lastCapabilityError: "old error",
    })
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
      expect(request).toMatchObject({
        capabilityStatus: "unknown",
        capabilityJson: "{}",
        capabilityVersion: "spec-4-pr1",
        capabilityCheckedAtMs: 0,
        clearLastCapabilityError: true,
      })
      return runtimeProfile({ secretRef: null })
    })

    await expect(saveProfileDraft(draft, existing)).resolves.toMatchObject({
      secretRef: null,
    })

    expect(calls).toEqual(["update", "delete"])
  })

  it("preserves unknown task families in render options", () => {
    const draft = createEmptyProfileDraft("custom")

    expect(draft.providerId).toBe("custom")
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

  it("sends agent SDK model aliases in create payloads", async () => {
    runtimeDbMocks.runtimeProfileCreate.mockResolvedValue(runtimeProfile({
      kind: "agent-run",
      agentSdkModelId: "deepseek-chat",
    }))
    const draft = createEmptyProfileDraft()
    draft.kind = "agent-run"
    draft.agentSdkModelId = "deepseek-chat"

    await expect(saveProfileDraft(draft, undefined)).resolves.toMatchObject({
      agentSdkModelId: "deepseek-chat",
    })

    expect(runtimeDbMocks.runtimeProfileCreate).toHaveBeenCalledWith(
      expect.objectContaining({ agentSdkModelId: "deepseek-chat" }),
    )
  })

  it("does not send SDK alias clear flags for plain model-call updates", async () => {
    const existing = runtimeProfile({ kind: "model-call", agentSdkModelId: null })
    runtimeDbMocks.runtimeProfileUpdate.mockResolvedValue(runtimeProfile())

    await saveProfileDraft(draftFromProfile(existing), existing)

    expect(runtimeDbMocks.runtimeProfileUpdate).toHaveBeenCalledWith(
      expect.not.objectContaining({ clearAgentSdkModelId: expect.any(Boolean) }),
    )
  })

  it("clears stale SDK aliases from model-call updates when one already exists", async () => {
    const existing = runtimeProfile({ kind: "model-call", agentSdkModelId: "stale-alias" })
    runtimeDbMocks.runtimeProfileUpdate.mockResolvedValue(runtimeProfile({ agentSdkModelId: null }))

    await saveProfileDraft(draftFromProfile(existing), existing)

    expect(runtimeDbMocks.runtimeProfileUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        agentSdkModelId: null,
        clearAgentSdkModelId: true,
      }),
    )
  })

  it("clears SDK aliases when switching agent-run profiles back to model-call", async () => {
    const existing = runtimeProfile({ kind: "agent-run", agentSdkModelId: "deepseek-chat" })
    const draft = {
      ...draftFromProfile(existing),
      kind: "model-call" as const,
      agentSdkModelId: "",
    }
    runtimeDbMocks.runtimeProfileUpdate.mockResolvedValue(runtimeProfile({ agentSdkModelId: null }))

    await saveProfileDraft(draft, existing)

    expect(runtimeDbMocks.runtimeProfileUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        agentSdkModelId: null,
        clearAgentSdkModelId: true,
      }),
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
    runtimeDbMocks.runtimeProfileDelete.mockResolvedValue({
      profileId: "profile-1",
      deletedAtMs: 456,
      secretRef: "llm-wiki-profile-secret:11111111-1111-4111-8111-111111111111",
    })
    runtimeDbMocks.runtimeProfileUpdate.mockResolvedValue(runtimeProfile())
    runtimeDbMocks.runtimeProfileProbe.mockResolvedValue({
      profile: runtimeProfile({
        capabilityStatus: "supported",
        capabilityVersion: "profile-probe.v1",
        capabilityCheckedAtMs: 123,
      }),
      status: "supported",
      capabilityJson: "{\"modelCallSupported\":true}",
      capabilityVersion: "profile-probe.v1",
      checkedAtMs: 123,
      backoffUntilMs: null,
      message: "Probe succeeded.",
    })
    secretMocks.profileSecretWrite.mockResolvedValue({
      secretRef: "llm-wiki-profile-secret:44444444-4444-4444-8444-444444444444",
    })
    secretMocks.profileSecretDelete.mockResolvedValue({ ok: true })
  })

  it("loads profiles and keeps unknown task family values visible", async () => {
    const { container, root } = renderProfiles()
    await flush()

    expect(container.textContent).toContain("Primary profile")
    expect(container.querySelector<HTMLInputElement>("[data-testid='profile-task-future-family']")?.checked).toBe(true)

    unmount(root)
  })

  it("deletes the selected profile after confirmation and then cleans up its secret", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true)
    const { container, root } = await renderProfilesWithList({
      enabled: true,
      status: "healthy",
      profiles: [
        runtimeProfile(),
        runtimeProfile({
          profileId: "profile-2",
          displayName: "Second profile",
          secretRef: null,
        }),
      ],
    })

    await click(container.querySelector("[data-testid='profile-delete']") as HTMLButtonElement)

    expect(confirmSpy).toHaveBeenCalledWith(expect.stringContaining("Primary profile"))
    expect(runtimeDbMocks.runtimeProfileDelete).toHaveBeenCalledWith({ profileId: "profile-1" })
    expect(secretMocks.profileSecretDelete).toHaveBeenCalledWith({
      secretRef: "llm-wiki-profile-secret:11111111-1111-4111-8111-111111111111",
    })
    expect(container.textContent).not.toContain("Primary profile")
    expect(container.textContent).toContain("Second profile")

    confirmSpy.mockRestore()
    unmount(root)
  })

  it("does not delete profile secrets when DB delete fails", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true)
    runtimeDbMocks.runtimeProfileDelete.mockRejectedValueOnce(new Error("active profile claim exists"))
    const { container, root } = await renderProfilesWithList({
      enabled: true,
      status: "healthy",
      profiles: [runtimeProfile()],
    })

    await click(container.querySelector("[data-testid='profile-delete']") as HTMLButtonElement)

    expect(runtimeDbMocks.runtimeProfileDelete).toHaveBeenCalledWith({ profileId: "profile-1" })
    expect(secretMocks.profileSecretDelete).not.toHaveBeenCalled()
    expect(container.textContent).toContain("active profile claim exists")
    expect(container.textContent).toContain("Primary profile")

    confirmSpy.mockRestore()
    unmount(root)
  })

  it("warns when an agent task profile is still model-call kind", async () => {
    const { container, root } = await renderProfilesWithList({
      enabled: true,
      status: "healthy",
      profiles: [runtimeProfile({ kind: "model-call", taskFamilies: ["agent"] })],
    })

    expect(container.querySelector("[data-testid='profile-agent-kind-warning']")?.textContent).toContain(
      "agent-run",
    )

    unmount(root)
  })

  it("warns when an Agent-run profile uses a non-Anthropic API mode", async () => {
    const { container, root } = await renderProfilesWithList({
      enabled: true,
      status: "healthy",
      profiles: [
        runtimeProfile({
          kind: "agent-run",
          taskFamilies: ["agent"],
          apiMode: "openai-chat-completions",
        }),
      ],
    })

    expect(container.querySelector("[data-testid='profile-agent-run-capability-warning']")?.textContent).toContain(
      "Anthropic Messages",
    )

    unmount(root)
  })

  it("warns when a fresh Agent-run probe does not support Agent-run selection", async () => {
    const { container, root } = await renderProfilesWithList({
      enabled: true,
      status: "healthy",
      profiles: [
        runtimeProfile({
          kind: "agent-run",
          taskFamilies: ["agent"],
          apiMode: "anthropic-messages",
          capabilityStatus: "limited",
          capabilityJson: "{\"modelCallSupported\":true,\"agentRunSupported\":false}",
          capabilityVersion: "profile-probe.v1",
        }),
      ],
    })

    expect(container.querySelector("[data-testid='profile-agent-run-capability-warning']")?.textContent).toContain(
      "agentRunSupported=true",
    )

    unmount(root)
  })

  it("warns when a fresh Agent-run probe omits Agent-run support", async () => {
    const { container, root } = await renderProfilesWithList({
      enabled: true,
      status: "healthy",
      profiles: [
        runtimeProfile({
          kind: "agent-run",
          taskFamilies: ["agent"],
          apiMode: "anthropic-messages",
          capabilityStatus: "limited",
          capabilityJson: "{\"modelCallSupported\":true}",
          capabilityVersion: "profile-probe.v1",
        }),
      ],
    })

    expect(container.querySelector("[data-testid='profile-agent-run-capability-warning']")?.textContent).toContain(
      "agentRunSupported=true",
    )

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
    const { container, root } = await renderProfilesWithList({
      enabled: true,
      status: "healthy",
      profiles: null,
    })

    expect(container.querySelector("[data-testid='model-profiles-section']")).not.toBeNull()
    expect(container.querySelector("[data-testid='profile-save']")).not.toBeNull()
    expect(container.textContent).not.toContain("Cannot read")

    unmount(root)
  })

  it("disables save and probe when work runtime is disabled", async () => {
    const { container, root } = await renderProfilesWithList({
      enabled: false,
      status: "disabled",
      profiles: [],
    })

    expect(container.querySelector("[data-testid='profile-runtime-unavailable']")?.textContent).toContain(
      "Work Runtime",
    )
    expect(container.querySelector<HTMLButtonElement>("[data-testid='profile-save']")?.disabled).toBe(true)
    expect(container.querySelector<HTMLButtonElement>("[data-testid='profile-probe']")?.disabled).toBe(true)

    unmount(root)
  })

  it("asks for a project instead of a runtime restart when no project is open", async () => {
    const { container, root } = await renderProfilesWithList({
      enabled: true,
      status: "no-project",
      profiles: [],
    })

    const message = container.querySelector("[data-testid='profile-runtime-unavailable']")?.textContent ?? ""
    expect(message).toContain("project")
    expect(message).not.toContain("LLM_WIKI_CORE_WORK_RUNTIME_ENABLED")
    expect(container.querySelector<HTMLButtonElement>("[data-testid='profile-save']")?.disabled).toBe(true)
    expect(container.querySelector<HTMLButtonElement>("[data-testid='profile-probe']")?.disabled).toBe(true)

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

  it("hides Agent SDK model alias for model-call profiles", async () => {
    runtimeDbMocks.runtimeProfileList.mockResolvedValueOnce({
      enabled: true,
      status: "healthy",
      profiles: [runtimeProfile({ kind: "model-call" })],
    })
    const { container, root } = renderProfiles()
    await flush()

    expect(container.querySelector("[data-testid='profile-agent-sdk-model']")).toBeNull()

    unmount(root)
  })

  it("marks cached capability stale after unsaved probe input edits", async () => {
    runtimeDbMocks.runtimeProfileList.mockResolvedValueOnce({
      enabled: true,
      status: "healthy",
      profiles: [
        runtimeProfile({
          capabilityStatus: "supported",
          capabilityVersion: "profile-probe.v1",
          capabilityCheckedAtMs: 123,
        }),
      ],
    })
    const { container, root } = renderProfiles()
    await flush()

    expect(container.textContent).toContain("supported")

    const model = container.querySelector<HTMLInputElement>("[data-testid='profile-model']")
    if (!model) throw new Error("profile model input not found")
    await input(model, "gpt-new")

    expect(container.textContent).toContain("not probed")
    expect(container.textContent).not.toContain("supported")

    unmount(root)
  })

  it("marks cached capability stale after unsaved SDK model edits", async () => {
    runtimeDbMocks.runtimeProfileList.mockResolvedValueOnce({
      enabled: true,
      status: "healthy",
      profiles: [
        runtimeProfile({
          kind: "agent-run",
          capabilityStatus: "supported",
          capabilityVersion: "profile-probe.v1",
          capabilityCheckedAtMs: 123,
        }),
      ],
    })
    const { container, root } = renderProfiles()
    await flush()

    const sdkModel = container.querySelector<HTMLInputElement>("[data-testid='profile-agent-sdk-model']")
    if (!sdkModel) throw new Error("profile agent sdk model input not found")
    await input(sdkModel, "deepseek-chat")

    expect(container.textContent).toContain("not probed")
    expect(container.textContent).not.toContain("supported")

    unmount(root)
  })

  it("resets cached capability fields when saved probe inputs change", async () => {
    const existing = runtimeProfile({
      kind: "agent-run",
      capabilityStatus: "supported",
      capabilityVersion: "profile-probe.v1",
      capabilityCheckedAtMs: 123,
      lastCapabilityError: "old error",
    })
    runtimeDbMocks.runtimeProfileList.mockResolvedValueOnce({
      enabled: true,
      status: "healthy",
      profiles: [existing],
    })
    runtimeDbMocks.runtimeProfileUpdate.mockResolvedValueOnce(runtimeProfile({
      kind: "agent-run",
      modelId: "gpt-new",
      agentSdkModelId: "deepseek-chat",
      capabilityStatus: "unknown",
      capabilityVersion: "spec-4-pr1",
      capabilityCheckedAtMs: 0,
      lastCapabilityError: null,
    }))
    const { container, root } = renderProfiles()
    await flush()

    const model = container.querySelector<HTMLInputElement>("[data-testid='profile-model']")
    const sdkModel = container.querySelector<HTMLInputElement>("[data-testid='profile-agent-sdk-model']")
    const save = container.querySelector<HTMLButtonElement>("[data-testid='profile-save']")
    if (!model || !sdkModel || !save) throw new Error("profile edit form not found")

    await input(model, "gpt-new")
    await input(sdkModel, "deepseek-chat")
    await click(save)

    expect(runtimeDbMocks.runtimeProfileUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        modelId: "gpt-new",
        agentSdkModelId: "deepseek-chat",
        capabilityStatus: "unknown",
        capabilityJson: "{}",
        capabilityVersion: "spec-4-pr1",
        capabilityCheckedAtMs: 0,
        clearLastCapabilityError: true,
      }),
    )

    unmount(root)
  })

  it("probes saved profiles by profileId without reading stored secrets in the UI", async () => {
    const { container, root } = renderProfiles()
    await flush()

    const probe = container.querySelector<HTMLButtonElement>("[data-testid='profile-probe']")
    if (!probe) throw new Error("profile probe button not found")
    await click(probe)

    expect(runtimeDbMocks.runtimeProfileProbe).toHaveBeenCalledWith({
      profileId: "profile-1",
      force: true,
    })
    expect(container.textContent).toContain("Probe succeeded.")

    unmount(root)
  })

  it("probes unsaved drafts with a one-request raw secret", async () => {
    runtimeDbMocks.runtimeProfileList.mockResolvedValueOnce({
      enabled: true,
      status: "healthy",
      profiles: [],
    })
    const { container, root } = renderProfiles()
    await flush()

    const secret = container.querySelector<HTMLInputElement>("[data-testid='profile-secret']")
    const probe = container.querySelector<HTMLButtonElement>("[data-testid='profile-probe']")
    if (!secret || !probe) throw new Error("profile probe form not found")

    await input(secret, "draft-only-secret")
    await click(probe)

    expect(runtimeDbMocks.runtimeProfileProbe).toHaveBeenCalledWith({
      draft: expect.objectContaining({
        providerId: "openai",
        modelId: "gpt-4o",
      }),
      rawSecret: "draft-only-secret",
      force: true,
    })

    unmount(root)
  })
})
