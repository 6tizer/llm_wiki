// @vitest-environment jsdom

import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { beforeEach, describe, expect, it, vi } from "vitest"
import "@/i18n"
import { useWikiStore } from "@/stores/wiki-store"
import { SearchView } from "./search-view"
import type { SearchResult } from "@/lib/search"

const searchMocks = vi.hoisted(() => ({
  searchWiki: vi.fn(),
}))

vi.mock("@/lib/search", async () => {
  const actual = await vi.importActual<typeof import("@/lib/search")>("@/lib/search")
  return { ...actual, searchWiki: searchMocks.searchWiki }
})

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

function renderView(): { container: HTMLDivElement; root: Root } {
  const container = document.createElement("div")
  document.body.appendChild(container)
  const root = createRoot(container)

  act(() => {
    root.render(<SearchView />)
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

async function typeAndEnter(input: HTMLInputElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value",
  )?.set
  setter?.call(input, value)
  await act(async () => {
    input.dispatchEvent(new Event("input", { bubbles: true }))
  })
  await act(async () => {
    input.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    )
  })
}

function makeResult(path: string, title: string): SearchResult {
  return {
    path,
    title,
    snippet: `snippet for ${title}`,
    titleMatch: true,
    score: 1,
    images: [],
  }
}

describe("SearchView — stale search results", () => {
  beforeEach(() => {
    searchMocks.searchWiki.mockReset()
    useWikiStore.getState().setProject({ id: "p", name: "P", path: "/tmp/p" })
  })

  it("discards an older query's results when a newer query has already started", async () => {
    const first = deferred<SearchResult[]>()
    const second = deferred<SearchResult[]>()
    searchMocks.searchWiki
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise)

    const { container, root } = renderView()
    const input = container.querySelector("input") as HTMLInputElement

    await typeAndEnter(input, "alpha")
    await typeAndEnter(input, "beta")

    expect(searchMocks.searchWiki).toHaveBeenCalledTimes(2)

    // The OLDER query ("alpha") resolves AFTER the newer one ("beta") has
    // already started — its results must be discarded, not shown.
    await act(async () => {
      first.resolve([makeResult("/wiki/alpha.md", "Alpha Page")])
    })
    await flush()
    expect(container.textContent).not.toContain("Alpha Page")

    await act(async () => {
      second.resolve([makeResult("/wiki/beta.md", "Beta Page")])
    })
    await flush()
    expect(container.textContent).toContain("Beta Page")
    expect(container.textContent).not.toContain("Alpha Page")

    unmount(root)
  })

  it("invalidates an in-flight search when Enter is pressed with an empty query", async () => {
    const first = deferred<SearchResult[]>()
    searchMocks.searchWiki.mockImplementationOnce(() => first.promise)

    const { container, root } = renderView()
    const input = container.querySelector("input") as HTMLInputElement

    await typeAndEnter(input, "alpha")
    expect(container.textContent).toContain("Searching...")

    await typeAndEnter(input, "")

    expect(searchMocks.searchWiki).toHaveBeenCalledTimes(1)
    expect(container.textContent).not.toContain("Searching...")

    await act(async () => {
      first.resolve([makeResult("/wiki/alpha.md", "Alpha Page")])
    })
    await flush()

    expect(container.textContent).not.toContain("Alpha Page")
    expect(container.textContent).not.toContain("Searching...")

    unmount(root)
  })

  it("still shows a single query's results normally", async () => {
    const only = deferred<SearchResult[]>()
    searchMocks.searchWiki.mockImplementationOnce(() => only.promise)

    const { container, root } = renderView()
    const input = container.querySelector("input") as HTMLInputElement

    await typeAndEnter(input, "gamma")
    await act(async () => {
      only.resolve([makeResult("/wiki/gamma.md", "Gamma Page")])
    })
    await flush()

    expect(container.textContent).toContain("Gamma Page")

    unmount(root)
  })
})
