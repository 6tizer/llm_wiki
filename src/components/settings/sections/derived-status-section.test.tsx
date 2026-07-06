// @vitest-environment jsdom

import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import "@/i18n"

const mocks = vi.hoisted(() => ({
  runtimeDerivedStaleMarkerList: vi.fn(),
  mintManualRebuildForLayer: vi.fn(),
}))

vi.mock("@/commands/runtime-db", () => ({
  runtimeDerivedStaleMarkerList: mocks.runtimeDerivedStaleMarkerList,
}))

vi.mock("@/lib/derived-rebuild/manual-rebuild-marker", () => ({
  mintManualRebuildForLayer: mocks.mintManualRebuildForLayer,
  isRebuildableLayer: (layer: string) => layer === "embedding" || layer === "taxonomy",
}))

import { DerivedStatusSection } from "./derived-status-section"
import { useDerivedLayerStore } from "@/stores/derived-layer-store"

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true

const project = { id: "p1", path: "/project" }

function emptyList() {
  return { enabled: true, status: "healthy" as const, markers: [], nextCursor: null }
}

function renderSection(
  props: Partial<React.ComponentProps<typeof DerivedStatusSection>> = {},
): { container: HTMLDivElement; root: Root } {
  const container = document.createElement("div")
  document.body.appendChild(container)
  const root = createRoot(container)

  act(() => {
    root.render(<DerivedStatusSection {...props} />)
  })

  return { container, root }
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
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

describe("DerivedStatusSection", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    mocks.runtimeDerivedStaleMarkerList.mockResolvedValue(emptyList())
    useDerivedLayerStore.setState({ buckets: null, capturedAtMs: null, error: null, runtimeDisabled: false })
  })

  afterEach(() => {
    vi.useRealTimers()
    document.body.innerHTML = ""
  })

  it("shows the no-project hint and no layer cards when no project is open", async () => {
    const { container, root } = renderSection()
    await flush()

    expect(container.querySelector("[data-testid='derived-status-card-embedding']")).toBeNull()
    expect(mocks.runtimeDerivedStaleMarkerList).not.toHaveBeenCalled()

    unmount(root)
  })

  it("keeps the no-project state visible even if runtimeDisabled is stale in the store", async () => {
    useDerivedLayerStore.setState({ runtimeDisabled: true })

    const { container, root } = renderSection()
    await flush()

    expect(container.querySelector("[data-testid='derived-status-section']")).not.toBeNull()
    expect(container.querySelector("[data-testid='derived-status-card-embedding']")).toBeNull()
    expect(mocks.runtimeDerivedStaleMarkerList).not.toHaveBeenCalled()

    unmount(root)
  })

  it("renders one card per visible layer, in order, all ready with no markers", async () => {
    const { container, root } = renderSection({ project })
    await flush()

    const cardIds = [
      "derived-status-card-embedding",
      "derived-status-card-taxonomy",
      "derived-status-card-synthesis",
      "derived-status-card-index_export",
      "derived-status-card-overview",
    ]
    for (const id of cardIds) {
      expect(container.querySelector(`[data-testid='${id}']`)).not.toBeNull()
    }
    expect(container.querySelector("[data-testid='derived-status-card-graph']")).toBeNull()
    expect(container.querySelector("[data-testid='derived-status-badge-ready']")).not.toBeNull()

    unmount(root)
  })

  it("shows a Rebuild button only for embedding/taxonomy, and a navigate link for the other three", async () => {
    const { container, root } = renderSection({ project })
    await flush()

    expect(container.querySelector("[data-testid='derived-status-rebuild-embedding']")).not.toBeNull()
    expect(container.querySelector("[data-testid='derived-status-rebuild-taxonomy']")).not.toBeNull()
    expect(container.querySelector("[data-testid='derived-status-rebuild-synthesis']")).toBeNull()
    expect(container.querySelector("[data-testid='derived-status-rebuild-index_export']")).toBeNull()
    expect(container.querySelector("[data-testid='derived-status-rebuild-overview']")).toBeNull()

    unmount(root)
  })

  it("clicking a navigate link calls onNavigate", async () => {
    const onNavigate = vi.fn()
    const { container, root } = renderSection({ project, onNavigate })
    await flush()

    await click(container.querySelector("[data-testid='derived-status-navigate-synthesis']")!)
    expect(onNavigate).toHaveBeenCalledTimes(1)

    await click(container.querySelector("[data-testid='derived-status-navigate-index_export']")!)
    expect(onNavigate).toHaveBeenCalledTimes(2)

    await click(container.querySelector("[data-testid='derived-status-navigate-overview']")!)
    expect(onNavigate).toHaveBeenCalledTimes(3)

    unmount(root)
  })

  it("reflects a pending marker as a dirty badge for embedding", async () => {
    mocks.runtimeDerivedStaleMarkerList.mockResolvedValue({
      enabled: true,
      status: "healthy",
      markers: [
        {
          markerId: "m1",
          layer: "embedding",
          affectedPath: "wiki/a.md",
          baseVersion: "b",
          inputHash: "h",
          markedAtMs: 0,
          reason: "commit",
          sourceEventId: "e1",
          status: "pending",
          updatedAtMs: 0,
          lastError: null,
        },
      ],
      nextCursor: null,
    })

    const { container, root } = renderSection({ project })
    await flush()

    const embeddingCard = container.querySelector("[data-testid='derived-status-card-embedding']")!
    expect(embeddingCard.querySelector("[data-testid='derived-status-badge-dirty']")).not.toBeNull()

    unmount(root)
  })

  it("shows a stale badge (not dirty) for synthesis when it has a pending marker (no automatic consumer)", async () => {
    mocks.runtimeDerivedStaleMarkerList.mockResolvedValue({
      enabled: true,
      status: "healthy",
      markers: [
        {
          markerId: "m1",
          layer: "synthesis",
          affectedPath: "wiki/synthesis/x.md",
          baseVersion: "b",
          inputHash: "h",
          markedAtMs: 0,
          reason: "commit",
          sourceEventId: "e1",
          status: "pending",
          updatedAtMs: 0,
          lastError: null,
        },
      ],
      nextCursor: null,
    })

    const { container, root } = renderSection({ project })
    await flush()

    const synthesisCard = container.querySelector("[data-testid='derived-status-card-synthesis']")!
    expect(synthesisCard.querySelector("[data-testid='derived-status-badge-stale']")).not.toBeNull()
    expect(synthesisCard.querySelector("[data-testid='derived-status-badge-dirty']")).toBeNull()

    unmount(root)
  })

  it("shows a section-level error banner when the marker list fails to load", async () => {
    mocks.runtimeDerivedStaleMarkerList.mockRejectedValue(new Error("db is damaged"))

    const { container, root } = renderSection({ project })
    await flush()

    expect(container.querySelector("[data-testid='derived-status-error']")?.textContent).toContain("db is damaged")

    unmount(root)
  })

  it("hides the section when the work runtime kill-switch is off, resolved (not rejected) with enabled:false", async () => {
    mocks.runtimeDerivedStaleMarkerList.mockResolvedValue({
      enabled: false,
      status: "disabled",
      markers: [],
      nextCursor: null,
    })

    const { container, root } = renderSection({ project })
    await flush()

    expect(container.querySelector("[data-testid='derived-status-section']")).toBeNull()
    expect(container.querySelector("[data-testid='derived-status-error']")).toBeNull()
    expect(container.querySelector("[data-testid='derived-status-card-embedding']")).toBeNull()
    expect(container.querySelector("[data-testid='derived-status-badge-ready']")).toBeNull()

    unmount(root)
  })

  it("optimistically flips the embedding card to building on click, then shows the queued-count result on success", async () => {
    let resolveMint: (value: unknown) => void = () => {}
    mocks.mintManualRebuildForLayer.mockImplementation(
      () => new Promise((resolve) => { resolveMint = resolve }),
    )

    const { container, root } = renderSection({ project })
    await flush()

    const button = container.querySelector<HTMLButtonElement>("[data-testid='derived-status-rebuild-embedding']")!
    await click(button)

    const embeddingCard = container.querySelector("[data-testid='derived-status-card-embedding']")!
    expect(embeddingCard.querySelector("[data-testid='derived-status-badge-building']")).not.toBeNull()

    await act(async () => {
      resolveMint({ mintedCount: 3, failedCount: 0, runtimeDisabled: false })
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(container.querySelector("[data-testid='derived-status-result-embedding']")?.textContent).toContain("3")

    unmount(root)
  })

  it("interleaving (internal-review P2): click -> optimistic building -> next poll corrects to the real dirty -> consumer claims -> building again, no crash and correct sequence", async () => {
    mocks.mintManualRebuildForLayer.mockResolvedValue({ mintedCount: 1, failedCount: 0, runtimeDisabled: false })

    const { container, root } = renderSection({ project })
    await flush()

    const embeddingCard = container.querySelector("[data-testid='derived-status-card-embedding']")!
    expect(embeddingCard.querySelector("[data-testid='derived-status-badge-ready']")).not.toBeNull()

    const button = container.querySelector<HTMLButtonElement>("[data-testid='derived-status-rebuild-embedding']")!
    await click(button)
    // Immediately: optimistic building (the mint hasn't even resolved yet).
    expect(embeddingCard.querySelector("[data-testid='derived-status-badge-building']")).not.toBeNull()

    await flush() // let the mint resolve and persistSetting settle

    // The next regular poll tick lands with the REAL snapshot: the marker
    // mint recorded is `pending` (embedding/taxonomy mint-only, no claim —
    // decision 5), so the honest status is `dirty`, correcting the
    // optimistic `building` guess.
    mocks.runtimeDerivedStaleMarkerList.mockResolvedValue({
      enabled: true,
      status: "healthy",
      markers: [
        {
          markerId: "m1",
          layer: "embedding",
          affectedPath: "wiki/a.md",
          baseVersion: "b",
          inputHash: "h",
          markedAtMs: 0,
          reason: "manual_rebuild",
          sourceEventId: "e1",
          status: "pending",
          updatedAtMs: 0,
          lastError: null,
        },
      ],
      nextCursor: null,
    })
    await act(async () => {
      vi.advanceTimersByTime(5_000)
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(embeddingCard.querySelector("[data-testid='derived-status-badge-dirty']")).not.toBeNull()

    // The background consumer's own tick then claims the marker — the
    // FOLLOWING poll observes the real `building` state.
    mocks.runtimeDerivedStaleMarkerList.mockResolvedValue({
      enabled: true,
      status: "healthy",
      markers: [
        {
          markerId: "m1",
          layer: "embedding",
          affectedPath: "wiki/a.md",
          baseVersion: "b",
          inputHash: "h",
          markedAtMs: 0,
          reason: "manual_rebuild",
          sourceEventId: "e1",
          status: "claimed",
          updatedAtMs: 0,
          lastError: null,
        },
      ],
      nextCursor: null,
    })
    await act(async () => {
      vi.advanceTimersByTime(5_000)
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(embeddingCard.querySelector("[data-testid='derived-status-badge-building']")).not.toBeNull()

    unmount(root)
  })

  it("reverts the optimistic building state and shows an error when minting fails entirely", async () => {
    mocks.mintManualRebuildForLayer.mockResolvedValue({ mintedCount: 0, failedCount: 2, runtimeDisabled: false })

    const { container, root } = renderSection({ project })
    await flush()

    const button = container.querySelector<HTMLButtonElement>("[data-testid='derived-status-rebuild-taxonomy']")!
    await click(button)
    await flush()

    const taxonomyCard = container.querySelector("[data-testid='derived-status-card-taxonomy']")!
    expect(taxonomyCard.querySelector("[data-testid='derived-status-badge-building']")).toBeNull()
    expect(taxonomyCard.querySelector("[data-testid='derived-status-card-error-taxonomy']")).not.toBeNull()

    unmount(root)
  })

  it("reverts to the REAL prior bucket (dirty), not a hardcoded ready, when minting fails from an already-dirty layer (P2: distinguishes real rollback from hardcoded ready)", async () => {
    mocks.runtimeDerivedStaleMarkerList.mockResolvedValue({
      enabled: true,
      status: "healthy",
      markers: [
        {
          markerId: "m1",
          layer: "taxonomy",
          affectedPath: "wiki/a.md",
          baseVersion: "b",
          inputHash: "h",
          markedAtMs: 0,
          reason: "commit",
          sourceEventId: "e1",
          status: "pending",
          updatedAtMs: 0,
          lastError: null,
        },
      ],
      nextCursor: null,
    })
    mocks.mintManualRebuildForLayer.mockResolvedValue({ mintedCount: 0, failedCount: 1, runtimeDisabled: false })

    const { container, root } = renderSection({ project })
    await flush()

    const taxonomyCardBefore = container.querySelector("[data-testid='derived-status-card-taxonomy']")!
    expect(taxonomyCardBefore.querySelector("[data-testid='derived-status-badge-dirty']")).not.toBeNull()

    const button = container.querySelector<HTMLButtonElement>("[data-testid='derived-status-rebuild-taxonomy']")!
    await click(button)
    await flush()

    const taxonomyCardAfter = container.querySelector("[data-testid='derived-status-card-taxonomy']")!
    expect(taxonomyCardAfter.querySelector("[data-testid='derived-status-badge-dirty']")).not.toBeNull()
    expect(taxonomyCardAfter.querySelector("[data-testid='derived-status-badge-ready']")).toBeNull()
    expect(taxonomyCardAfter.querySelector("[data-testid='derived-status-card-error-taxonomy']")).not.toBeNull()

    unmount(root)
  })

  it("shows a rebuild failure message and reverts when a rebuild races the work runtime kill-switch", async () => {
    mocks.mintManualRebuildForLayer.mockResolvedValue({ mintedCount: 0, failedCount: 0, runtimeDisabled: true })

    const { container, root } = renderSection({ project })
    await flush()

    const button = container.querySelector<HTMLButtonElement>("[data-testid='derived-status-rebuild-embedding']")!
    await click(button)
    await flush()

    const embeddingCard = container.querySelector("[data-testid='derived-status-card-embedding']")!
    expect(embeddingCard.querySelector("[data-testid='derived-status-badge-building']")).toBeNull()
    expect(embeddingCard.textContent).toContain("Rebuild failed")

    unmount(root)
  })
})
