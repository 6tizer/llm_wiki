// @vitest-environment jsdom

import { StrictMode } from "react"
import { act } from "react"
import { createRoot } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const projectStoreMocks = vi.hoisted(() => ({
  loadUpdateCheckState: vi.fn(async () => null),
  saveUpdateCheckState: vi.fn(async () => undefined),
}))

vi.mock("@/lib/project-store", () => projectStoreMocks)

const updateCheckMocks = vi.hoisted(() => ({
  UPDATE_REPO: "6tizer/llm_wiki",
  UPDATE_CHECK_CACHE_MS: 60 * 60 * 1000,
  checkForUpdates: vi.fn(async () => ({
    kind: "up-to-date" as const,
    local: "0.0.0",
    remote: "0.0.0",
  })),
}))

vi.mock("@/lib/update-check", () => updateCheckMocks)

const updateStoreMocks = vi.hoisted(() => {
  const state = {
    checking: false,
    lastResult: null as unknown,
    lastCheckedAt: null as number | null,
    dismissedVersion: null as string | null,
    enabled: true,
    setChecking: vi.fn(),
    setResult: vi.fn(),
    setDismissed: vi.fn(),
    setEnabled: vi.fn(),
    hydrate: vi.fn(),
  }

  state.setChecking.mockImplementation((checking: boolean) => {
    state.checking = checking
  })
  state.setResult.mockImplementation((lastResult: unknown, lastCheckedAt: number) => {
    state.lastResult = lastResult
    state.lastCheckedAt = lastCheckedAt
    state.checking = false
  })
  state.hydrate.mockImplementation((partial: Partial<typeof state>) => {
    Object.assign(state, partial)
  })

  return {
    state,
    useUpdateStore: {
      getState: vi.fn(() => state),
    },
  }
})

vi.mock("@/stores/update-store", () => ({
  useUpdateStore: updateStoreMocks.useUpdateStore,
}))

import { useUpdateCheckBootstrap } from "./use-update-check-bootstrap"

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true

function resetUpdateState(): void {
  updateStoreMocks.state.checking = false
  updateStoreMocks.state.lastResult = null
  updateStoreMocks.state.lastCheckedAt = null
  updateStoreMocks.state.dismissedVersion = null
  updateStoreMocks.state.enabled = true
  updateStoreMocks.state.setChecking.mockClear()
  updateStoreMocks.state.setResult.mockClear()
  updateStoreMocks.state.setDismissed.mockClear()
  updateStoreMocks.state.setEnabled.mockClear()
  updateStoreMocks.state.hydrate.mockClear()
  updateStoreMocks.useUpdateStore.getState.mockClear()
}

function Harness() {
  useUpdateCheckBootstrap()
  return null
}

describe("useUpdateCheckBootstrap", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    projectStoreMocks.loadUpdateCheckState.mockClear()
    projectStoreMocks.saveUpdateCheckState.mockClear()
    updateCheckMocks.checkForUpdates.mockClear()
    resetUpdateState()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("StrictMode double-mount performs one update check fetch and one persisted write", async () => {
    const container = document.createElement("div")
    document.body.appendChild(container)
    const root = createRoot(container)

    await act(async () => {
      root.render(
        <StrictMode>
          <Harness />
        </StrictMode>,
      )
      await Promise.resolve()
    })

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_499)
    })
    expect(updateCheckMocks.checkForUpdates).not.toHaveBeenCalled()
    expect(projectStoreMocks.saveUpdateCheckState).not.toHaveBeenCalled()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1)
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(updateCheckMocks.checkForUpdates).toHaveBeenCalledTimes(1)
    expect(projectStoreMocks.saveUpdateCheckState).toHaveBeenCalledTimes(1)

    root.unmount()
    container.remove()
  })
})
