// @vitest-environment jsdom

import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { beforeEach, describe, expect, it, vi } from "vitest"
import "@/i18n"
import { useWikiStore } from "@/stores/wiki-store"
import { IndexOverviewSection } from "./index-overview-section"

const indexExportMock = vi.hoisted(() => vi.fn())
vi.mock("@/lib/derived-rebuild/index-export", () => ({ rebuildIndexExport: indexExportMock }))

const overviewMock = vi.hoisted(() => vi.fn())
vi.mock("@/lib/derived-rebuild/overview-rebuild", () => ({ rebuildOverview: overviewMock }))

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true

const project = { path: "/project" }

function renderSection(
  props: Partial<React.ComponentProps<typeof IndexOverviewSection>> = {},
): { container: HTMLDivElement; root: Root } {
  const container = document.createElement("div")
  document.body.appendChild(container)
  const root = createRoot(container)

  act(() => {
    root.render(<IndexOverviewSection {...props} />)
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

describe("IndexOverviewSection", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useWikiStore.setState({
      llmConfig: {
        provider: "openai",
        apiKey: "key",
        model: "gpt-test",
        ollamaUrl: "http://localhost:11434",
        customEndpoint: "",
        maxContextSize: 204800,
        reasoning: { mode: "auto" },
      },
    })
  })

  it("disables both rebuild buttons when no project is open", async () => {
    const { container, root } = renderSection()
    await flush()

    expect(container.textContent).toContain("Open a project first")
    expect(container.querySelector<HTMLButtonElement>("[data-testid='index-export-rebuild']")?.disabled).toBe(true)
    expect(container.querySelector<HTMLButtonElement>("[data-testid='overview-rebuild']")?.disabled).toBe(true)

    unmount(root)
  })

  it("rebuilds the index and shows the resulting page count", async () => {
    indexExportMock.mockResolvedValue({ path: "wiki/index.md", pageCount: 3, sectionCount: 6, runtimeTracked: true })
    const { container, root } = renderSection({ project })
    await flush()

    const button = container.querySelector<HTMLButtonElement>("[data-testid='index-export-rebuild']")
    if (!button) throw new Error("index-export-rebuild button not found")
    await click(button)
    await flush()

    expect(indexExportMock).toHaveBeenCalledWith("/project")
    expect(container.querySelector("[data-testid='index-export-result']")?.textContent).toContain("3")
    expect(container.querySelector("[data-testid='index-export-error']")).toBeNull()

    unmount(root)
  })

  it("shows an error banner when the index rebuild rejects", async () => {
    indexExportMock.mockRejectedValue(new Error("scan failed"))
    const { container, root } = renderSection({ project })
    await flush()

    const button = container.querySelector<HTMLButtonElement>("[data-testid='index-export-rebuild']")
    if (!button) throw new Error("index-export-rebuild button not found")
    await click(button)
    await flush()

    expect(container.querySelector("[data-testid='index-export-error']")).not.toBeNull()
    expect(container.querySelector("[data-testid='index-export-result']")).toBeNull()

    unmount(root)
  })

  it("rebuilds the overview and shows the written path", async () => {
    overviewMock.mockResolvedValue({ path: "wiki/overview.md", runtimeTracked: true })
    const { container, root } = renderSection({ project })
    await flush()

    const button = container.querySelector<HTMLButtonElement>("[data-testid='overview-rebuild']")
    if (!button) throw new Error("overview-rebuild button not found")
    await click(button)
    await flush()

    expect(overviewMock).toHaveBeenCalledWith("/project", expect.objectContaining({ model: "gpt-test" }))
    expect(container.querySelector("[data-testid='overview-result']")?.textContent).toContain("wiki/overview.md")

    unmount(root)
  })

  it("shows an error banner when the overview rebuild rejects", async () => {
    overviewMock.mockRejectedValue(new Error("no usable LLM configured"))
    const { container, root } = renderSection({ project })
    await flush()

    const button = container.querySelector<HTMLButtonElement>("[data-testid='overview-rebuild']")
    if (!button) throw new Error("overview-rebuild button not found")
    await click(button)
    await flush()

    expect(container.querySelector("[data-testid='overview-error']")).not.toBeNull()

    unmount(root)
  })

  it("locks BOTH rebuild buttons while the index rebuild is in flight, and unlocks them once it settles (Tester gate P1a: cross-card mutex)", async () => {
    let resolveIndex: (value: unknown) => void = () => {}
    indexExportMock.mockImplementation(() => new Promise((resolve) => { resolveIndex = resolve }))
    const { container, root } = renderSection({ project })
    await flush()

    const indexButton = container.querySelector<HTMLButtonElement>("[data-testid='index-export-rebuild']")
    const overviewButton = container.querySelector<HTMLButtonElement>("[data-testid='overview-rebuild']")
    if (!indexButton || !overviewButton) throw new Error("rebuild buttons not found")

    await click(indexButton)
    // index-export rebuild is now in flight (its promise deliberately unresolved).
    expect(indexButton.disabled).toBe(true)
    expect(overviewButton.disabled).toBe(true)

    await act(async () => {
      resolveIndex({ path: "wiki/index.md", pageCount: 1, sectionCount: 6, runtimeTracked: true })
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(indexButton.disabled).toBe(false)
    expect(overviewButton.disabled).toBe(false)

    unmount(root)
  })

  it("locks BOTH rebuild buttons while the overview rebuild is in flight, and unlocks them once it settles (Tester gate P1a: cross-card mutex, reverse direction)", async () => {
    let resolveOverview: (value: unknown) => void = () => {}
    overviewMock.mockImplementation(() => new Promise((resolve) => { resolveOverview = resolve }))
    const { container, root } = renderSection({ project })
    await flush()

    const indexButton = container.querySelector<HTMLButtonElement>("[data-testid='index-export-rebuild']")
    const overviewButton = container.querySelector<HTMLButtonElement>("[data-testid='overview-rebuild']")
    if (!indexButton || !overviewButton) throw new Error("rebuild buttons not found")

    await click(overviewButton)
    // overview rebuild is now in flight (its promise deliberately unresolved).
    expect(overviewButton.disabled).toBe(true)
    expect(indexButton.disabled).toBe(true)

    await act(async () => {
      resolveOverview({ path: "wiki/overview.md", runtimeTracked: true })
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(overviewButton.disabled).toBe(false)
    expect(indexButton.disabled).toBe(false)

    unmount(root)
  })

  it("clears the index error banner and shows the new result after a retry succeeds", async () => {
    indexExportMock.mockRejectedValueOnce(new Error("scan failed"))
    indexExportMock.mockResolvedValueOnce({ path: "wiki/index.md", pageCount: 5, sectionCount: 6, runtimeTracked: true })
    const { container, root } = renderSection({ project })
    await flush()

    const button = container.querySelector<HTMLButtonElement>("[data-testid='index-export-rebuild']")
    if (!button) throw new Error("index-export-rebuild button not found")
    await click(button)
    await flush()
    expect(container.querySelector("[data-testid='index-export-error']")).not.toBeNull()

    await click(button)
    await flush()

    expect(container.querySelector("[data-testid='index-export-error']")).toBeNull()
    expect(container.querySelector("[data-testid='index-export-result']")?.textContent).toContain("5")

    unmount(root)
  })

  it("clears the overview error banner and shows the new result after a retry succeeds", async () => {
    overviewMock.mockRejectedValueOnce(new Error("transport failed"))
    overviewMock.mockResolvedValueOnce({ path: "wiki/overview.md", runtimeTracked: true })
    const { container, root } = renderSection({ project })
    await flush()

    const button = container.querySelector<HTMLButtonElement>("[data-testid='overview-rebuild']")
    if (!button) throw new Error("overview-rebuild button not found")
    await click(button)
    await flush()
    expect(container.querySelector("[data-testid='overview-error']")).not.toBeNull()

    await click(button)
    await flush()

    expect(container.querySelector("[data-testid='overview-error']")).toBeNull()
    expect(container.querySelector("[data-testid='overview-result']")?.textContent).toContain("wiki/overview.md")

    unmount(root)
  })

  it("disables the overview button and shows a hint when no LLM is configured", async () => {
    useWikiStore.setState({
      llmConfig: {
        provider: "openai",
        apiKey: "",
        model: "",
        ollamaUrl: "http://localhost:11434",
        customEndpoint: "",
        maxContextSize: 204800,
        reasoning: { mode: "auto" },
      },
    })
    const { container, root } = renderSection({ project })
    await flush()

    expect(container.querySelector<HTMLButtonElement>("[data-testid='overview-rebuild']")?.disabled).toBe(true)
    expect(container.querySelector("[data-testid='overview-no-llm']")).not.toBeNull()
    // Index export is unaffected by the LLM config — it never calls the LLM.
    expect(container.querySelector<HTMLButtonElement>("[data-testid='index-export-rebuild']")?.disabled).toBe(false)

    unmount(root)
  })
})
