// @vitest-environment jsdom

import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import "@/i18n"
import { IconSidebar } from "./icon-sidebar"
import { useWikiStore } from "@/stores/wiki-store"
import { useLintStore } from "@/stores/lint-store"
import { useReviewStore } from "@/stores/review-store"
import { useResearchStore } from "@/stores/research-store"

vi.mock("@/commands/fs", () => ({
  clipServerStatus: vi.fn(async () => "running"),
}))

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true

function renderSidebar(): { container: HTMLDivElement; root: Root } {
  const container = document.createElement("div")
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => {
    root.render(<IconSidebar onSwitchProject={vi.fn()} />)
  })
  return { container, root }
}

async function flush(): Promise<void> {
  await act(async () => {
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
  useWikiStore.setState({ activeView: "wiki" })
  useLintStore.setState({
    items: [
      {
        id: "lint-1",
        type: "semantic",
        severity: "warning",
        page: "wiki/a.md",
        detail: "Needs work",
        createdAt: 1,
      },
    ],
  })
  useReviewStore.setState({
    items: [
      {
        id: "review-1",
        type: "missing-page",
        title: "Missing",
        description: "Missing page",
        options: [],
        resolved: false,
        createdAt: 1,
      },
      {
        id: "review-2",
        type: "confirm",
        title: "Done",
        description: "Resolved item",
        options: [],
        resolved: true,
        createdAt: 2,
      },
    ],
  })
  useResearchStore.setState({
    tasks: [
      {
        id: "research-1",
        projectPath: "/project",
        topic: "Topic",
        status: "queued",
        webResults: [],
        synthesis: "",
        savedPath: null,
        error: null,
        createdAt: 1,
      },
    ],
    maxConcurrent: 3,
  })
})

afterEach(() => {
  document.body.innerHTML = ""
})

describe("IconSidebar", () => {
  it("renders the five main nav items with visible labels and accessible names", async () => {
    const { container, root } = renderSidebar()
    await flush()

    for (const label of ["Chat", "Sources", "Explore", "Wiki Health", "Deep Research"]) {
      const button = container.querySelector(`button[aria-label='${label}']`)
      expect(button).not.toBeNull()
      expect(button?.textContent).toContain(label)
    }
    expect(container.querySelector("button[aria-label='Search']")).toBeNull()
    expect(container.querySelector("button[aria-label='Graph']")).toBeNull()
    expect(container.querySelector("button[aria-label='Lint']")).toBeNull()
    expect(container.querySelector("button[aria-label='Review']")).toBeNull()

    unmount(root)
  })

  it("marks the active view and changes activeView on click", async () => {
    const { container, root } = renderSidebar()
    await flush()

    const wikiButton = container.querySelector("button[aria-label='Chat']")!
    expect(wikiButton.getAttribute("aria-current")).toBe("page")

    await act(async () => {
      container.querySelector("button[aria-label='Wiki Health']")!.dispatchEvent(new MouseEvent("click", { bubbles: true }))
      await Promise.resolve()
    })

    expect(useWikiStore.getState().activeView).toBe("wiki-health")
    expect(container.querySelector("button[aria-label='Wiki Health']")?.getAttribute("aria-current")).toBe("page")

    unmount(root)
  })

  it("shows the health badge as lint items plus pending reviews", async () => {
    const { container, root } = renderSidebar()
    await flush()

    const healthButton = container.querySelector("button[aria-label='Wiki Health']")
    expect(healthButton?.textContent).toContain("2")

    unmount(root)
  })
})
