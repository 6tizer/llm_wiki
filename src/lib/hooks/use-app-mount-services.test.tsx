// @vitest-environment jsdom

import { StrictMode } from "react"
import { act } from "react"
import { createRoot } from "react-dom/client"
import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@/lib/auto-save", () => ({
  setupAutoSave: vi.fn(),
}))

vi.mock("@/lib/clip-watcher", () => ({
  startClipWatcher: vi.fn(),
}))

import { setupAutoSave } from "@/lib/auto-save"
import { startClipWatcher } from "@/lib/clip-watcher"
import { useAppMountServices } from "./use-app-mount-services"

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true

function Harness() {
  useAppMountServices()
  return null
}

describe("useAppMountServices", () => {
  beforeEach(() => {
    vi.mocked(setupAutoSave).mockClear()
    vi.mocked(startClipWatcher).mockClear()
  })

  it("starts auto-save and clip watcher on mount", async () => {
    const container = document.createElement("div")
    document.body.appendChild(container)
    const root = createRoot(container)

    await act(async () => {
      root.render(<Harness />)
      await Promise.resolve()
    })

    expect(setupAutoSave).toHaveBeenCalledTimes(1)
    expect(startClipWatcher).toHaveBeenCalledTimes(1)

    root.unmount()
    container.remove()
  })

  it("StrictMode double-mount keeps the existing double subscription behavior", async () => {
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

    // Characterization, not desired semantics: App had no cleanup and
    // setupAutoSave has no idempotency guard, so StrictMode calls both twice.
    expect(setupAutoSave).toHaveBeenCalledTimes(2)
    expect(startClipWatcher).toHaveBeenCalledTimes(2)

    root.unmount()
    container.remove()
  })
})
