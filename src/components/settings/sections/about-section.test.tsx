// @vitest-environment jsdom

import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { beforeEach, describe, expect, it, vi } from "vitest"
import "@/i18n"
import { useUpdateStore } from "@/stores/update-store"
import { saveUpdateCheckState } from "@/lib/project-store"
import { AboutSection } from "./about-section"

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => ""),
}))

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn(async () => undefined),
}))

vi.mock("@/lib/project-store", () => ({
  saveUpdateCheckState: vi.fn(async () => undefined),
}))

vi.mock("@/lib/update-check", () => ({
  checkForUpdates: vi.fn(async () => ({ kind: "up-to-date", local: "1.0.0" })),
  formatAppVersion: (version: string, channel: string) =>
    channel === "stable" ? `v${version}` : `v${version}-${channel}`,
  toLatestReleaseUrl: (url: string) => url,
  UPDATE_REPO: "6tizer/llm_wiki",
}))

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true

function renderSection(): { container: HTMLDivElement; root: Root } {
  const container = document.createElement("div")
  document.body.appendChild(container)
  const root = createRoot(container)

  act(() => {
    root.render(<AboutSection />)
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

beforeEach(() => {
  useUpdateStore.setState({
    checking: false,
    lastResult: null,
    lastCheckedAt: null,
    dismissedVersion: null,
    enabled: true,
  })
  vi.mocked(saveUpdateCheckState).mockReset().mockResolvedValue(undefined)
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("network disabled in tests")
    }),
  )
})

describe("AboutSection auto-check toggle failure", () => {
  it("reverts the toggle and shows an error message when persisting fails", async () => {
    vi.mocked(saveUpdateCheckState).mockRejectedValueOnce(new Error("disk full"))

    const { container, root } = renderSection()
    await flush()

    const checkbox = container.querySelector("input[type='checkbox']") as HTMLInputElement | null
    if (!checkbox) throw new Error("auto-check checkbox not found")
    expect(checkbox.checked).toBe(true)

    await click(checkbox)
    await flush()

    // Reverted from the optimistic `false` back to the persisted `true`.
    expect(useUpdateStore.getState().enabled).toBe(true)
    expect(container.textContent).toContain("disk full")

    unmount(root)
  })

  it("keeps the toggle applied and shows no error when persisting succeeds", async () => {
    const { container, root } = renderSection()
    await flush()

    const checkbox = container.querySelector("input[type='checkbox']") as HTMLInputElement | null
    if (!checkbox) throw new Error("auto-check checkbox not found")

    await click(checkbox)
    await flush()

    expect(useUpdateStore.getState().enabled).toBe(false)
    expect(container.textContent).not.toContain("disk full")

    unmount(root)
  })
})
