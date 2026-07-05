// @vitest-environment jsdom

import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { beforeEach, describe, expect, it, vi } from "vitest"
import "@/i18n"
import { useWikiStore } from "@/stores/wiki-store"
import { ModelConfigSection } from "./model-config-section"
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

function renderSection(): { container: HTMLDivElement; root: Root } {
  const container = document.createElement("div")
  document.body.appendChild(container)
  const root = createRoot(container)

  act(() => {
    root.render(<ModelConfigSection />)
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

describe("ModelConfigSection", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useWikiStore.setState({ activePresetId: null })
    runtimeDbMocks.runtimeProfileList.mockResolvedValue({
      enabled: true,
      status: "healthy",
      profiles: [runtimeProfile()],
    })
  })

  it("renders the three merged regions with real child components", async () => {
    const { container, root } = renderSection()
    await flush()

    expect(container.querySelector("[data-testid='model-config-section']")).not.toBeNull()
    expect(container.textContent).toContain("Connections")
    expect(container.textContent).toContain("LLM Models")
    expect(container.textContent).toContain("External Information Sources")
    expect(container.textContent).toContain("Model profiles")
    expect(container.textContent).toContain("Task assignment matrix")

    unmount(root)
  })

  it("refreshes Profiles after a matrix update succeeds", async () => {
    const updated = runtimeProfile({ taskFamilies: ["chat", "ingest"] })
    runtimeDbMocks.runtimeProfileUpdate.mockResolvedValueOnce(updated)
    const { container, root } = renderSection()
    await flush()

    expect(runtimeDbMocks.runtimeProfileList).toHaveBeenCalledTimes(2)
    const ingestToggle = container.querySelector("[data-testid='task-matrix-profile-1-ingest']")
    if (!ingestToggle) throw new Error("ingest toggle not found")

    await click(ingestToggle)
    await flush()

    expect(runtimeDbMocks.runtimeProfileList).toHaveBeenCalledTimes(4)

    unmount(root)
  })
})
