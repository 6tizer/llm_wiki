// @vitest-environment jsdom

import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, describe, expect, it, vi } from "vitest"
import "@/i18n"
import { ExploreView } from "./explore-view"

vi.mock("@/components/search/search-view", () => ({ SearchView: () => <div data-testid="search-view" /> }))
vi.mock("@/components/graph/graph-view", () => ({ GraphView: () => <div data-testid="graph-view" /> }))

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

afterEach(() => {
  document.body.innerHTML = ""
})

describe("ExploreView", () => {
  it("renders search by default and switches to graph with accessible tabs", async () => {
    const { container, root } = renderExploreView()

    expect(container.querySelector("[data-testid='search-view']")).not.toBeNull()
    expect(container.querySelector("[data-testid='graph-view']")).toBeNull()
    expect(container.querySelector("button[aria-label='Search']")?.getAttribute("aria-current")).toBe("page")

    await act(async () => {
      container.querySelector("button[aria-label='Graph']")!.dispatchEvent(new MouseEvent("click", { bubbles: true }))
      await Promise.resolve()
    })

    expect(container.querySelector("[data-testid='search-view']")).toBeNull()
    expect(container.querySelector("[data-testid='graph-view']")).not.toBeNull()
    expect(container.querySelector("button[aria-label='Graph']")?.getAttribute("aria-current")).toBe("page")

    unmount(root)
  })
})
