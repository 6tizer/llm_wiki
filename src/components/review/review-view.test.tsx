// @vitest-environment jsdom

import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import "@/i18n"
import { ReviewView } from "./review-view"
import { useReviewStore } from "@/stores/review-store"
import { useWikiStore } from "@/stores/wiki-store"

const researchMocks = vi.hoisted(() => ({
  queueResearch: vi.fn(),
}))

vi.mock("@/lib/deep-research", () => researchMocks)

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true

function renderReviewView(): { container: HTMLDivElement; root: Root } {
  const container = document.createElement("div")
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => {
    root.render(<ReviewView />)
  })
  return { container, root }
}

function unmount(root: Root): void {
  act(() => {
    root.unmount()
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  useWikiStore.setState({
    activeView: "wiki-health",
    project: { id: "p1", name: "Project", path: "/project" },
    searchApiConfig: {
      ...useWikiStore.getState().searchApiConfig,
      provider: "tavily",
      apiKey: "test-key",
      deepResearchSource: "web",
    },
  })
  useReviewStore.setState({
    items: [
      {
        id: "review-1",
        type: "missing-page",
        title: "Research: Alpha",
        description: "Alpha needs a page",
        searchQueries: ["alpha query"],
        options: [],
        resolved: false,
        createdAt: 1,
      },
    ],
  })
})

afterEach(() => {
  useWikiStore.setState({ activeView: "wiki", project: null })
  useReviewStore.setState({ items: [] })
  document.body.innerHTML = ""
})

describe("ReviewView deep research action", () => {
  it("queues research and switches to the research view", async () => {
    const { container, root } = renderReviewView()

    const researchButton = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Deep Research"),
    )
    if (!researchButton) throw new Error("Deep Research button not found")

    await act(async () => {
      researchButton.dispatchEvent(new MouseEvent("click", { bubbles: true }))
      await Promise.resolve()
    })

    expect(researchMocks.queueResearch).toHaveBeenCalledWith(
      "/project",
      "Alpha",
      expect.any(Object),
      expect.any(Object),
      ["alpha query"],
    )
    expect(useWikiStore.getState().activeView).toBe("research")

    unmount(root)
  })
})
