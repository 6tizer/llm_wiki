// @vitest-environment jsdom

import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { beforeEach, describe, expect, it, vi } from "vitest"
import "@/i18n"
import {
  addProfileToOrder,
  FallbackPolicySection,
  moveProfileInOrder,
  removeProfileFromOrder,
} from "./fallback-policy-section"
import type { RuntimeProfileRecord } from "@/commands/runtime-db"

const runtimeDbMocks = vi.hoisted(() => ({
  runtimeProfileBreakerClear: vi.fn(),
  runtimeProfileList: vi.fn(),
  runtimeProfilePoolEventsList: vi.fn(),
  runtimeProfilePoolList: vi.fn(),
  runtimeTaskPolicyList: vi.fn(),
  runtimeTaskPolicySet: vi.fn(),
}))

vi.mock("@/commands/runtime-db", () => runtimeDbMocks)

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true

function runtimeProfile(patch: Partial<RuntimeProfileRecord> = {}): RuntimeProfileRecord {
  return {
    profileId: "profile-1",
    kind: "model-call",
    displayName: "Primary profile",
    providerId: "openai",
    modelId: "gpt-5.5",
    agentSdkModelId: null,
    endpoint: null,
    apiMode: "openai-chat-completions",
    authStyle: "bearer",
    secretRef: null,
    enabled: true,
    taskFamilies: ["chat"],
    maxConcurrency: 1,
    capabilityStatus: "supported",
    capabilityJson: "{\"modelCallSupported\":true}",
    capabilityVersion: "profile-probe.v1",
    capabilityCheckedAtMs: 1,
    probeBackoffUntilMs: null,
    lastCapabilityError: null,
    createdAtMs: 1,
    updatedAtMs: 1,
    ...patch,
  }
}

function renderSection(props: { refreshToken?: number } = {}): { container: HTMLDivElement; root: Root } {
  const container = document.createElement("div")
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => {
    root.render(<FallbackPolicySection {...props} />)
  })
  return { container, root }
}

async function rerenderSection(root: Root, props: { refreshToken?: number }): Promise<void> {
  await act(async () => {
    root.render(<FallbackPolicySection {...props} />)
    await Promise.resolve()
    await Promise.resolve()
  })
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

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function chatRowOrder(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll("[data-testid^='fallback-row-chat-']"))
    .map((element) => element.getAttribute("data-testid")?.replace("fallback-row-chat-", "") ?? "")
}

function unmount(root: Root): void {
  act(() => {
    root.unmount()
  })
}

describe("FallbackPolicySection helpers", () => {
  it("adds, removes, and moves profile ids without duplicating entries", () => {
    expect(addProfileToOrder(["profile-1"], "profile-2")).toEqual(["profile-1", "profile-2"])
    expect(addProfileToOrder(["profile-1"], "profile-1")).toEqual(["profile-1"])
    expect(removeProfileFromOrder(["profile-1", "profile-2"], "profile-1")).toEqual(["profile-2"])
    expect(moveProfileInOrder(["profile-1", "profile-2"], "profile-1", 1)).toEqual(["profile-2", "profile-1"])
    expect(moveProfileInOrder(["profile-1", "profile-2"], "profile-1", -1)).toEqual(["profile-1", "profile-2"])
  })
})

describe("FallbackPolicySection", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    runtimeDbMocks.runtimeProfileList.mockResolvedValue({
      enabled: true,
      status: "healthy",
      profiles: [
        runtimeProfile({ profileId: "profile-1", displayName: "Primary profile" }),
        runtimeProfile({ profileId: "profile-2", displayName: "Backup profile" }),
      ],
    })
    runtimeDbMocks.runtimeTaskPolicyList.mockResolvedValue({
      enabled: true,
      status: "healthy",
      policies: [{
        taskFamily: "chat",
        profileOrder: ["profile-1", "profile-2"],
        autoFailover: true,
        updatedAtMs: 1,
      }],
    })
    runtimeDbMocks.runtimeProfilePoolList.mockResolvedValue({
      enabled: true,
      status: "healthy",
      activeClaims: [],
      circuitBreakers: [],
    })
    runtimeDbMocks.runtimeProfilePoolEventsList.mockResolvedValue({
      enabled: true,
      status: "healthy",
      events: [],
    })
    runtimeDbMocks.runtimeTaskPolicySet.mockImplementation(async (request: {
      taskFamily: string
      profileOrder: string[]
      autoFailover?: boolean | null
    }) => ({
      policy: {
        taskFamily: request.taskFamily,
        profileOrder: request.profileOrder,
        autoFailover: request.autoFailover,
        updatedAtMs: 2,
      },
      removedProfileIds: [],
    }))
  })

  it("saves the reordered queue for one task family", async () => {
    const { container, root } = renderSection()
    await flush()

    const down = container.querySelector("[data-testid='fallback-down-chat-profile-1']")
    const save = container.querySelector("[data-testid='fallback-save-chat']")
    if (!down || !save) throw new Error("fallback controls not found")

    await click(down)
    await click(save)

    expect(runtimeDbMocks.runtimeTaskPolicySet).toHaveBeenCalledWith({
      taskFamily: "chat",
      profileOrder: ["profile-2", "profile-1"],
      autoFailover: true,
    })

    unmount(root)
  })

  it("keeps dirty edits during a save when an external refresh arrives", async () => {
    const pending = deferred<{
      policy: { taskFamily: string; profileOrder: string[]; autoFailover: boolean; updatedAtMs: number }
      removedProfileIds: string[]
    }>()
    runtimeDbMocks.runtimeTaskPolicySet.mockReturnValueOnce(pending.promise)
    const { container, root } = renderSection({ refreshToken: 0 })
    await flush()

    const down = container.querySelector("[data-testid='fallback-down-chat-profile-1']")
    const save = container.querySelector("[data-testid='fallback-save-chat']")
    const addSelect = container.querySelector<HTMLSelectElement>("[data-testid='fallback-add-select-chat']")
    if (!down || !save || !addSelect) throw new Error("fallback controls not found")

    await click(down)
    expect(chatRowOrder(container)).toEqual(["profile-2", "profile-1"])

    await click(save)
    const remove = container.querySelector<HTMLButtonElement>("[data-testid='fallback-remove-chat-profile-2']")
    expect(addSelect.disabled).toBe(true)
    expect(remove?.disabled).toBe(true)

    await rerenderSection(root, { refreshToken: 1 })
    await flush()

    expect(chatRowOrder(container)).toEqual(["profile-2", "profile-1"])

    await act(async () => {
      pending.resolve({
        policy: {
          taskFamily: "chat",
          profileOrder: ["profile-2", "profile-1"],
          autoFailover: true,
          updatedAtMs: 3,
        },
        removedProfileIds: [],
      })
      await Promise.resolve()
    })

    unmount(root)
  })

  it("keeps each family locked while multiple saves are in flight", async () => {
    runtimeDbMocks.runtimeProfileList.mockResolvedValueOnce({
      enabled: true,
      status: "healthy",
      profiles: [
        runtimeProfile({ profileId: "profile-1", displayName: "Primary profile", taskFamilies: ["chat", "ingest"] }),
        runtimeProfile({ profileId: "profile-2", displayName: "Backup profile", taskFamilies: ["chat", "ingest"] }),
      ],
    })
    runtimeDbMocks.runtimeTaskPolicyList.mockResolvedValueOnce({
      enabled: true,
      status: "healthy",
      policies: [
        {
          taskFamily: "chat",
          profileOrder: ["profile-1", "profile-2"],
          autoFailover: true,
          updatedAtMs: 1,
        },
        {
          taskFamily: "ingest",
          profileOrder: ["profile-2", "profile-1"],
          autoFailover: true,
          updatedAtMs: 1,
        },
      ],
    })
    const chatPending = deferred<{
      policy: { taskFamily: string; profileOrder: string[]; autoFailover: boolean; updatedAtMs: number }
      removedProfileIds: string[]
    }>()
    const ingestPending = deferred<{
      policy: { taskFamily: string; profileOrder: string[]; autoFailover: boolean; updatedAtMs: number }
      removedProfileIds: string[]
    }>()
    runtimeDbMocks.runtimeTaskPolicySet.mockImplementation((request: { taskFamily: string }) => (
      request.taskFamily === "chat" ? chatPending.promise : ingestPending.promise
    ))
    const { container, root } = renderSection()
    await flush()

    const chatSave = container.querySelector("[data-testid='fallback-save-chat']")
    const ingestSave = container.querySelector("[data-testid='fallback-save-ingest']")
    if (!chatSave || !ingestSave) throw new Error("fallback save controls not found")

    await click(chatSave)
    await click(ingestSave)

    const chatSelect = container.querySelector<HTMLSelectElement>("[data-testid='fallback-add-select-chat']")
    const ingestSelect = container.querySelector<HTMLSelectElement>("[data-testid='fallback-add-select-ingest']")
    expect(chatSelect?.disabled).toBe(true)
    expect(ingestSelect?.disabled).toBe(true)

    await act(async () => {
      ingestPending.resolve({
        policy: {
          taskFamily: "ingest",
          profileOrder: ["profile-2", "profile-1"],
          autoFailover: true,
          updatedAtMs: 3,
        },
        removedProfileIds: [],
      })
      await Promise.resolve()
    })

    expect(chatSelect?.disabled).toBe(true)
    expect(ingestSelect?.disabled).toBe(false)

    await act(async () => {
      chatPending.resolve({
        policy: {
          taskFamily: "chat",
          profileOrder: ["profile-1", "profile-2"],
          autoFailover: true,
          updatedAtMs: 4,
        },
        removedProfileIds: [],
      })
      await Promise.resolve()
    })

    expect(chatSelect?.disabled).toBe(false)
    unmount(root)
  })
})
