// @vitest-environment jsdom

import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import "@/i18n"
import { ExploreView } from "./explore-view"
import { useResearchStore } from "@/stores/research-store"
import { useWikiStore } from "@/stores/wiki-store"

vi.mock("@/components/search/search-view", () => ({ SearchView: () => <div data-testid="search-view" /> }))
vi.mock("@/components/graph/graph-view", () => ({ GraphView: () => <div data-testid="graph-view" /> }))
vi.mock("@/components/layout/research-panel", () => ({ ResearchPanel: () => <div data-testid="research-panel" /> }))

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true

function renderExploreView(): { container: HTMLDivElement; root: Root } {
  const container = document.createElement("div")
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => {
    root.render(<ExploreView />)
  })
  return { container, root }
}

function unmount(root: Root): void {
  act(() => {
    root.unmount()
  })
}

beforeEach(() => {
  useWikiStore.setState({
    activeView: "wiki",
    project: null,
    pendingExploreTab: null,
  })
  useResearchStore.setState({ tasks: [], maxConcurrent: 3 })
})

afterEach(() => {
  document.body.innerHTML = ""
})

describe("ExploreView", () => {
  it("renders graph by default and switches to search with accessible tabs", async () => {
    const { container, root } = renderExploreView()

    expect(container.querySelector("[data-testid='graph-view']")).not.toBeNull()
    expect(container.querySelector("[data-testid='search-view']")).toBeNull()
    expect(container.querySelector("button[aria-label='Graph']")?.getAttribute("aria-current")).toBe("page")

    await act(async () => {
      container.querySelector("button[aria-label='Search']")!.dispatchEvent(new MouseEvent("click", { bubbles: true }))
      await Promise.resolve()
    })

    expect(container.querySelector("[data-testid='graph-view']")).toBeNull()
    expect(container.querySelector("[data-testid='search-view']")).not.toBeNull()
    expect(container.querySelector("button[aria-label='Search']")?.getAttribute("aria-current")).toBe("page")

    unmount(root)
  })

  it("renders the research tab and switches to ResearchPanel", async () => {
    const { container, root } = renderExploreView()

    await act(async () => {
      container.querySelector("button[aria-label='Deep Research']")!.dispatchEvent(new MouseEvent("click", { bubbles: true }))
      await Promise.resolve()
    })

    expect(container.querySelector("[data-testid='research-panel']")).not.toBeNull()
    expect(container.querySelector("[data-testid='graph-view']")).toBeNull()
    expect(container.querySelector("button[aria-label='Deep Research']")?.getAttribute("aria-current")).toBe("page")

    unmount(root)
  })

  it("consumes the research view alias after mount", () => {
    act(() => {
      useWikiStore.getState().setActiveView("research")
    })
    expect(useWikiStore.getState().pendingExploreTab).toBe("research")

    const { container, root } = renderExploreView()

    expect(container.querySelector("[data-testid='research-panel']")).not.toBeNull()
    expect(container.querySelector("button[aria-label='Deep Research']")?.getAttribute("aria-current")).toBe("page")
    expect(useWikiStore.getState().pendingExploreTab).toBeNull()

    unmount(root)
  })

  it("shows a running research badge on the research tab for the current project", () => {
    useWikiStore.setState({
      project: { id: "project-1", name: "Project", path: "/project" },
    })
    useResearchStore.setState({
      tasks: [
        {
          id: "queued",
          projectPath: "/project",
          topic: "Queued",
          status: "queued",
          webResults: [],
          synthesis: "",
          savedPath: null,
          error: null,
          createdAt: 1,
        },
        {
          id: "searching",
          projectPath: "/project",
          topic: "Searching",
          status: "searching",
          webResults: [],
          synthesis: "",
          savedPath: null,
          error: null,
          createdAt: 2,
        },
        {
          id: "done",
          projectPath: "/project",
          topic: "Done",
          status: "done",
          webResults: [],
          synthesis: "",
          savedPath: null,
          error: null,
          createdAt: 3,
        },
        {
          id: "other-project",
          projectPath: "/other",
          topic: "Other",
          status: "queued",
          webResults: [],
          synthesis: "",
          savedPath: null,
          error: null,
          createdAt: 4,
        },
      ],
      maxConcurrent: 3,
    })

    const { container, root } = renderExploreView()
    const getResearchBadge = () =>
      container.querySelector("button[aria-label='Deep Research'] span.bg-blue-500")

    expect(getResearchBadge()?.textContent).toBe("2")

    act(() => {
      useResearchStore.setState({
        tasks: useResearchStore.getState().tasks.map((task) => (
          task.projectPath === "/project" ? { ...task, status: "done" } : task
        )),
      })
    })

    expect(getResearchBadge()).toBeNull()

    unmount(root)
  })
})
