// @vitest-environment jsdom

import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { beforeEach, describe, expect, it, vi } from "vitest"
import "@/i18n"
import { useWikiStore } from "@/stores/wiki-store"
import { SearchView } from "./search-view"
import type { SearchResult } from "@/lib/search"
import { useDerivedLayerStore } from "@/stores/derived-layer-store"

const searchMocks = vi.hoisted(() => ({
  searchWiki: vi.fn(),
}))

vi.mock("@/lib/search", async () => {
  const actual = await vi.importActual<typeof import("@/lib/search")>("@/lib/search")
  return { ...actual, searchWiki: searchMocks.searchWiki }
})

// SearchView does a one-shot best-effort refresh of the embedding layer's
// derived status (for the fallback banner) — stub the runtime-db call so
// that fire-and-forget effect never hits the real (non-Tauri) `invoke`.
vi.mock("@/commands/runtime-db", () => ({
  runtimeDerivedStaleMarkerList: vi.fn(async () => ({
    enabled: true,
    status: "healthy",
    markers: [],
    nextCursor: null,
  })),
}))

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

function response(
  results: SearchResult[],
  overrides: Partial<{ mode: "keyword" | "vector" | "hybrid"; vectorHits: number }> = {},
) {
  return { results, mode: overrides.mode ?? "hybrid", vectorHits: overrides.vectorHits ?? 0 }
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
    useDerivedLayerStore.setState({ buckets: null, capturedAtMs: null, error: null })
  })

  it("discards an older query's results when a newer query has already started", async () => {
    const first = deferred<ReturnType<typeof response>>()
    const second = deferred<ReturnType<typeof response>>()
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
      first.resolve(response([makeResult("/wiki/alpha.md", "Alpha Page")]))
    })
    await flush()
    expect(container.textContent).not.toContain("Alpha Page")

    await act(async () => {
      second.resolve(response([makeResult("/wiki/beta.md", "Beta Page")]))
    })
    await flush()
    expect(container.textContent).toContain("Beta Page")
    expect(container.textContent).not.toContain("Alpha Page")

    unmount(root)
  })

  it("invalidates an in-flight search when Enter is pressed with an empty query", async () => {
    const first = deferred<ReturnType<typeof response>>()
    searchMocks.searchWiki.mockImplementationOnce(() => first.promise)

    const { container, root } = renderView()
    const input = container.querySelector("input") as HTMLInputElement

    await typeAndEnter(input, "alpha")
    expect(container.textContent).toContain("Searching...")

    await typeAndEnter(input, "")

    expect(searchMocks.searchWiki).toHaveBeenCalledTimes(1)
    expect(container.textContent).not.toContain("Searching...")

    await act(async () => {
      first.resolve(response([makeResult("/wiki/alpha.md", "Alpha Page")]))
    })
    await flush()

    expect(container.textContent).not.toContain("Alpha Page")
    expect(container.textContent).not.toContain("Searching...")

    unmount(root)
  })

  it("still shows a single query's results normally", async () => {
    const only = deferred<ReturnType<typeof response>>()
    searchMocks.searchWiki.mockImplementationOnce(() => only.promise)

    const { container, root } = renderView()
    const input = container.querySelector("input") as HTMLInputElement

    await typeAndEnter(input, "gamma")
    await act(async () => {
      only.resolve(response([makeResult("/wiki/gamma.md", "Gamma Page")]))
    })
    await flush()

    expect(container.textContent).toContain("Gamma Page")

    unmount(root)
  })
})

describe("SearchView — vector fallback banner (SPEC-6 PR6 decision 7)", () => {
  beforeEach(() => {
    searchMocks.searchWiki.mockReset()
    useWikiStore.getState().setProject({ id: "p", name: "P", path: "/tmp/p" })
    useDerivedLayerStore.setState({ buckets: null, capturedAtMs: null, error: null })
  })

  it("does not show the banner for a hybrid-mode search with no embedding staleness", async () => {
    searchMocks.searchWiki.mockResolvedValue(response([makeResult("/wiki/a.md", "A")], { mode: "hybrid" }))

    const { container, root } = renderView()
    const input = container.querySelector("input") as HTMLInputElement
    await typeAndEnter(input, "alpha")
    await flush()

    expect(container.querySelector("[data-testid='search-fallback-banner']")).toBeNull()

    unmount(root)
  })

  it("clearing the query and pressing Enter resets hasSearched/retrievalMode so the banner does not linger (Codex P3)", async () => {
    searchMocks.searchWiki.mockResolvedValue(response([makeResult("/wiki/a.md", "A")], { mode: "keyword" }))

    const { container, root } = renderView()
    const input = container.querySelector("input") as HTMLInputElement
    await typeAndEnter(input, "alpha")
    await flush()
    expect(container.querySelector("[data-testid='search-fallback-banner']")).not.toBeNull()

    await typeAndEnter(input, "")
    await flush()

    expect(container.querySelector("[data-testid='search-fallback-banner']")).toBeNull()
    expect(container.textContent).toContain("Press Enter to search")

    unmount(root)
  })

  it("shows the banner when the backend reports a non-hybrid mode", async () => {
    searchMocks.searchWiki.mockResolvedValue(response([makeResult("/wiki/a.md", "A")], { mode: "keyword" }))

    const { container, root } = renderView()
    const input = container.querySelector("input") as HTMLInputElement
    await typeAndEnter(input, "alpha")
    await flush()

    expect(container.querySelector("[data-testid='search-fallback-banner']")).not.toBeNull()

    unmount(root)
  })

  it("shows the banner when mode is hybrid but the embedding layer is dirty", async () => {
    searchMocks.searchWiki.mockResolvedValue(response([makeResult("/wiki/a.md", "A")], { mode: "hybrid" }))

    const { container, root } = renderView()
    // Let the component's own mount-effect refresh (mocked to an empty,
    // all-ready snapshot) land BEFORE overriding — otherwise it would
    // resolve after this override and clobber it back to "ready".
    await flush()
    useDerivedLayerStore.setState({
      buckets: { embedding: { layer: "embedding", status: "dirty", stale: false, lastRebuiltAtMs: null } },
    })

    const input = container.querySelector("input") as HTMLInputElement
    await typeAndEnter(input, "alpha")
    await flush()

    expect(container.querySelector("[data-testid='search-fallback-banner']")).not.toBeNull()

    unmount(root)
  })

  it("shows the banner when mode is hybrid but the embedding layer is building", async () => {
    searchMocks.searchWiki.mockResolvedValue(response([makeResult("/wiki/a.md", "A")], { mode: "hybrid" }))

    const { container, root } = renderView()
    await flush()
    useDerivedLayerStore.setState({
      buckets: { embedding: { layer: "embedding", status: "building", stale: false, lastRebuiltAtMs: null } },
    })

    const input = container.querySelector("input") as HTMLInputElement
    await typeAndEnter(input, "alpha")
    await flush()

    expect(container.querySelector("[data-testid='search-fallback-banner']")).not.toBeNull()

    unmount(root)
  })

  it("shows the banner when mode is hybrid but the embedding layer is failed (Tester P3: a failed rebuild is just as incomplete as dirty)", async () => {
    searchMocks.searchWiki.mockResolvedValue(response([makeResult("/wiki/a.md", "A")], { mode: "hybrid" }))

    const { container, root } = renderView()
    await flush()
    useDerivedLayerStore.setState({
      buckets: { embedding: { layer: "embedding", status: "failed", stale: false, lastRebuiltAtMs: null } },
    })

    const input = container.querySelector("input") as HTMLInputElement
    await typeAndEnter(input, "alpha")
    await flush()

    expect(container.querySelector("[data-testid='search-fallback-banner']")).not.toBeNull()

    unmount(root)
  })

  it("does not show the banner while a search is still in flight", async () => {
    const pending = deferred<ReturnType<typeof response>>()
    searchMocks.searchWiki.mockImplementationOnce(() => pending.promise)

    const { container, root } = renderView()
    await flush()
    useDerivedLayerStore.setState({
      buckets: { embedding: { layer: "embedding", status: "dirty", stale: false, lastRebuiltAtMs: null } },
    })

    const input = container.querySelector("input") as HTMLInputElement
    await typeAndEnter(input, "alpha")

    expect(container.querySelector("[data-testid='search-fallback-banner']")).toBeNull()

    await act(async () => {
      pending.resolve(response([makeResult("/wiki/a.md", "A")], { mode: "hybrid" }))
    })
    await flush()
    expect(container.querySelector("[data-testid='search-fallback-banner']")).not.toBeNull()

    unmount(root)
  })
})
