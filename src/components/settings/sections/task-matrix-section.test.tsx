// @vitest-environment jsdom

import { act } from "react"
import type { ComponentProps } from "react"
import { createRoot, type Root } from "react-dom/client"
import { beforeEach, describe, expect, it, vi } from "vitest"
import "@/i18n"
import { TaskMatrixSection } from "./task-matrix-section"
import type { RuntimeProfileRecord } from "@/commands/runtime-db"

const runtimeDbMocks = vi.hoisted(() => ({
  runtimeProfileList: vi.fn(),
  runtimeProfileUpdate: vi.fn(),
}))

vi.mock("@/commands/runtime-db", () => runtimeDbMocks)

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true

function runtimeProfile(patch: Partial<RuntimeProfileRecord> = {}): RuntimeProfileRecord {
  return {
    profileId: "profile-1",
    kind: "model-call",
    displayName: "Primary profile",
    providerId: "anthropic",
    modelId: "claude-sonnet",
    agentSdkModelId: null,
    endpoint: null,
    apiMode: "anthropic-messages",
    authStyle: "x-api-key",
    secretRef: null,
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

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function renderSection(
  onNavigateToCategory = vi.fn(),
  props: Partial<ComponentProps<typeof TaskMatrixSection>> = {},
): { container: HTMLDivElement; root: Root } {
  const container = document.createElement("div")
  document.body.appendChild(container)
  const root = createRoot(container)

  act(() => {
    root.render(<TaskMatrixSection onNavigateToCategory={onNavigateToCategory} {...props} />)
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

describe("TaskMatrixSection", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("labels effective and not-yet-wired task families and links embedding and vision configuration", async () => {
    const onNavigate = vi.fn()
    runtimeDbMocks.runtimeProfileList.mockResolvedValueOnce({
      enabled: true,
      status: "healthy",
      profiles: [runtimeProfile()],
    })

    const { container, root } = renderSection(onNavigate)
    await flush()

    expect(container.querySelector("[data-testid='task-matrix-status-agent']")?.textContent).toContain("Effective")
    expect(container.querySelector("[data-testid='task-matrix-status-ingest']")?.textContent).toContain("Effective")
    expect(container.querySelector("[data-testid='task-matrix-status-review']")?.textContent).toContain("Not wired")

    const embeddingLink = container.querySelector("[data-testid='task-matrix-config-embedding']")
    const visionLink = container.querySelector("[data-testid='task-matrix-config-vision']")
    if (!embeddingLink || !visionLink) throw new Error("configuration links not found")

    await click(embeddingLink)
    await click(visionLink)

    expect(onNavigate).toHaveBeenNthCalledWith(1, "embedding")
    expect(onNavigate).toHaveBeenNthCalledWith(2, "multimodal")

    unmount(root)
  })

  it("updates only profileId and taskFamilies when toggling an assignment", async () => {
    const updated = runtimeProfile({ taskFamilies: ["chat", "ingest"] })
    runtimeDbMocks.runtimeProfileList.mockResolvedValueOnce({
      enabled: true,
      status: "healthy",
      profiles: [runtimeProfile()],
    })
    runtimeDbMocks.runtimeProfileUpdate.mockResolvedValueOnce(updated)

    const { container, root } = renderSection()
    await flush()

    const ingestToggle = container.querySelector("[data-testid='task-matrix-profile-1-ingest']")
    if (!ingestToggle) throw new Error("ingest toggle not found")

    await click(ingestToggle)

    expect(runtimeDbMocks.runtimeProfileUpdate).toHaveBeenCalledWith({
      profileId: "profile-1",
      taskFamilies: ["chat", "ingest"],
    })

    unmount(root)
  })

  it("disables every cell for the same profile while a toggle update is in flight", async () => {
    const pending = deferred<RuntimeProfileRecord>()
    runtimeDbMocks.runtimeProfileList.mockResolvedValueOnce({
      enabled: true,
      status: "healthy",
      profiles: [runtimeProfile()],
    })
    runtimeDbMocks.runtimeProfileUpdate.mockReturnValueOnce(pending.promise)

    const { container, root } = renderSection()
    await flush()

    const ingestToggle = container.querySelector<HTMLInputElement>("[data-testid='task-matrix-profile-1-ingest']")
    const reviewToggle = container.querySelector<HTMLInputElement>("[data-testid='task-matrix-profile-1-review']")
    if (!ingestToggle || !reviewToggle) throw new Error("matrix toggles not found")

    await click(ingestToggle)

    expect(reviewToggle.disabled).toBe(true)
    await click(reviewToggle)
    expect(runtimeDbMocks.runtimeProfileUpdate).toHaveBeenCalledTimes(1)

    await act(async () => {
      pending.resolve(runtimeProfile({ taskFamilies: ["chat", "ingest"] }))
      await Promise.resolve()
    })

    unmount(root)
  })

  it("rolls back the checkbox and shows a save failure when update rejects", async () => {
    runtimeDbMocks.runtimeProfileList.mockResolvedValueOnce({
      enabled: true,
      status: "healthy",
      profiles: [runtimeProfile()],
    })
    runtimeDbMocks.runtimeProfileUpdate.mockRejectedValueOnce(new Error("update rejected"))

    const { container, root } = renderSection()
    await flush()

    const ingestToggle = container.querySelector<HTMLInputElement>("[data-testid='task-matrix-profile-1-ingest']")
    if (!ingestToggle) throw new Error("ingest toggle not found")

    await click(ingestToggle)

    expect(ingestToggle.checked).toBe(false)
    expect(container.textContent).toContain("Save failed: update rejected")

    unmount(root)
  })

  it("keeps not-yet-wired labels visible and only updates taskFamilies", async () => {
    runtimeDbMocks.runtimeProfileList.mockResolvedValueOnce({
      enabled: true,
      status: "healthy",
      profiles: [runtimeProfile()],
    })
    runtimeDbMocks.runtimeProfileUpdate.mockResolvedValueOnce(runtimeProfile({ taskFamilies: ["chat", "review"] }))

    const { container, root } = renderSection()
    await flush()

    const reviewToggle = container.querySelector("[data-testid='task-matrix-profile-1-review']")
    if (!reviewToggle) throw new Error("review toggle not found")
    await click(reviewToggle)

    expect(runtimeDbMocks.runtimeProfileUpdate).toHaveBeenCalledWith({
      profileId: "profile-1",
      taskFamilies: ["chat", "review"],
    })
    expect(container.querySelector("[data-testid='task-matrix-status-review']")?.textContent).toContain("Not wired")

    unmount(root)
  })

  it("shows the model-call agent warning when agent is assigned outside an agent-run profile", async () => {
    runtimeDbMocks.runtimeProfileList.mockResolvedValueOnce({
      enabled: true,
      status: "healthy",
      profiles: [runtimeProfile({ kind: "model-call", taskFamilies: ["agent"] })],
    })

    const { container, root } = renderSection()
    await flush()

    expect(container.querySelector("[data-testid='task-matrix-agent-kind-warning-profile-1']")?.textContent)
      .toContain("agent-run")

    unmount(root)
  })

  it("hides when runtime is disabled and degrades when no project is open", async () => {
    runtimeDbMocks.runtimeProfileList.mockResolvedValueOnce({
      enabled: false,
      status: "disabled",
      profiles: [],
    })
    const disabled = renderSection()
    await flush()
    expect(disabled.container.querySelector("[data-testid='task-matrix-section']")).toBeNull()
    unmount(disabled.root)

    runtimeDbMocks.runtimeProfileList.mockResolvedValueOnce({
      enabled: true,
      status: "no-project",
      profiles: [],
    })
    const noProject = renderSection()
    await flush()
    expect(noProject.container.querySelector("[data-testid='task-matrix-runtime-unavailable']")).not.toBeNull()
    unmount(noProject.root)
  })
})
