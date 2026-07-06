// @vitest-environment jsdom

import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import "@/i18n"
import { WikiHealthView } from "./wiki-health-view"
import { useDerivedLayerStore } from "@/stores/derived-layer-store"
import { useLintStore } from "@/stores/lint-store"
import { resetReviewIdCounterForTest, useReviewStore } from "@/stores/review-store"
import { useWikiStore } from "@/stores/wiki-store"

const mocks = vi.hoisted(() => ({
  listDirectory: vi.fn(async () => []),
  fixLintResult: vi.fn(async () => true),
  fixAllLintResults: vi.fn(async (_projectPath: string, results: unknown[]) => ({ fixed: results, failed: [] })),
  mintManualRebuildForLayer: vi.fn(async () => ({ mintedCount: 1, failedCount: 0, runtimeDisabled: false })),
}))

vi.mock("@/commands/fs", () => ({ listDirectory: mocks.listDirectory }))
vi.mock("@/lib/lint-fixer", () => ({
  fixLintResult: mocks.fixLintResult,
  fixAllLintResults: mocks.fixAllLintResults,
  isFixable: (result: { type: string; detail?: string }) => {
    if (result.type === "orphan") return false
    if (result.type !== "semantic") return true
    return !result.detail?.toLowerCase().startsWith("[suggestion]")
  }
}))
vi.mock("@/lib/derived-rebuild/manual-rebuild-marker", () => ({
  mintManualRebuildForLayer: mocks.mintManualRebuildForLayer,
  isRebuildableLayer: (layer: string) => layer === "embedding" || layer === "taxonomy",
}))
vi.mock("@/components/settings/sections/derived-status-section", () => ({
  DerivedStatusSection: ({ onNavigate }: { onNavigate?: () => void }) => (
    <div data-testid="derived-status-section">
      <button type="button" onClick={() => onNavigate?.()}>go governance</button>
    </div>
  ),
}))
vi.mock("@/components/lint/lint-view", () => ({ LintView: () => <div data-testid="lint-view" /> }))
vi.mock("@/components/review/review-view", () => ({ ReviewView: () => <div data-testid="review-view" /> }))
vi.mock("@/components/settings/sections/tag-taxonomy-section", () => ({ TagTaxonomySection: () => <div data-testid="taxonomy-section" /> }))
vi.mock("@/components/settings/sections/synthesis-section", () => ({ SynthesisSection: () => <div data-testid="synthesis-section" /> }))
vi.mock("@/components/settings/sections/index-overview-section", () => ({ IndexOverviewSection: () => <div data-testid="index-overview-section" /> }))
vi.mock("@/components/settings/sections/maintenance-section", () => ({ MaintenanceSection: () => <div data-testid="maintenance-section" /> }))

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true

function renderWikiHealthView(): { container: HTMLDivElement; root: Root } {
  const container = document.createElement("div")
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => {
    root.render(<WikiHealthView />)
  })
  return { container, root }
}

function unmount(root: Root): void {
  act(() => {
    root.unmount()
  })
}

function click(button: Element): Promise<void> {
  return act(async () => {
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }))
    await Promise.resolve()
  })
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  resetReviewIdCounterForTest()
  useWikiStore.setState({
    project: { id: "p1", name: "Project", path: "/project" },
    fileTree: [
      {
        name: "wiki",
        path: "/project/wiki",
        is_dir: true,
        children: [
          { name: "a.md", path: "/project/wiki/a.md", is_dir: false },
          { name: "b.md", path: "/project/wiki/b.md", is_dir: false },
        ],
      },
    ],
  })
  useLintStore.setState({
    items: [
      {
        id: "lint-1",
        type: "broken-link",
        severity: "warning",
        page: "a.md",
        detail: "Broken link: [[Missing]]",
        createdAt: 1,
      },
      {
        id: "lint-2",
        type: "orphan",
        severity: "info",
        page: "b.md",
        detail: "Orphan page",
        createdAt: 2,
      },
    ],
  })
  useReviewStore.setState({
    items: [
      {
        id: "review-1",
        type: "confirm",
        title: "Review pending",
        description: "Needs a decision",
        options: [],
        resolved: false,
        createdAt: 1,
      },
      {
        id: "review-2",
        type: "confirm",
        title: "Review done",
        description: "Done",
        options: [],
        resolved: true,
        createdAt: 2,
      },
    ],
  })
  useDerivedLayerStore.setState({
    buckets: {
      synthesis: { layer: "synthesis", status: "dirty", stale: true, lastRebuiltAtMs: null },
    },
    capturedAtMs: 1,
    error: null,
    runtimeDisabled: false,
  })
})

afterEach(() => {
  useWikiStore.setState({ project: null, fileTree: [] })
  useLintStore.setState({ items: [] })
  useReviewStore.setState({ items: [] })
  useDerivedLayerStore.setState({ buckets: null, capturedAtMs: null, error: null, runtimeDisabled: false })
  document.body.innerHTML = ""
})

describe("WikiHealthView", () => {
  it("renders the dashboard first with issue counts and tab badges", () => {
    const { container, root } = renderWikiHealthView()

    expect(container.querySelector("[data-testid='wiki-health-dashboard']")).not.toBeNull()
    expect(container.querySelector("[data-testid='lint-view']")).toBeNull()
    expect(container.querySelector("[data-testid='wiki-health-score']")?.textContent).toBe("86")
    expect(container.textContent).toContain("4 issues found")
    expect(container.querySelector("[data-testid='wiki-health-tab-lint']")?.textContent).toContain("2")
    expect(container.querySelector("[data-testid='wiki-health-tab-review']")?.textContent).toContain("1")

    unmount(root)
  })

  it("switches between management tabs and keeps lint/review panes fluid height", async () => {
    const { container, root } = renderWikiHealthView()

    await click(container.querySelector("[data-testid='wiki-health-tab-lint']")!)
    const lintPane = container.querySelector("[data-testid='lint-view']")?.parentElement
    expect(lintPane?.className).toContain("h-full")
    expect(lintPane?.className).not.toContain("h-[480px]")

    await click(container.querySelector("[data-testid='wiki-health-tab-review']")!)
    const reviewPane = container.querySelector("[data-testid='review-view']")?.parentElement
    expect(reviewPane?.className).toContain("h-full")
    expect(reviewPane?.className).not.toContain("h-[480px]")

    unmount(root)
  })

  it("routes derived navigation to the governance tab", async () => {
    const { container, root } = renderWikiHealthView()

    await click(container.querySelector("[data-testid='wiki-health-tab-derived']")!)
    expect(container.querySelector("[data-testid='derived-status-section']")).not.toBeNull()

    await click(container.querySelector("[data-testid='derived-status-section'] button")!)
    expect(container.querySelector("[data-testid='taxonomy-section']")).not.toBeNull()
    expect(container.querySelector("[data-testid='synthesis-section']")).not.toBeNull()
    expect(container.querySelector("[data-testid='index-overview-section']")).not.toBeNull()
    expect(container.querySelector("[data-testid='maintenance-section']")).not.toBeNull()

    unmount(root)
  })

  it("fixes a single fixable lint issue and removes it from the dashboard store", async () => {
    let resolveFix: (value: boolean) => void = () => undefined
    mocks.fixLintResult.mockImplementationOnce(() => new Promise<boolean>((resolve) => {
      resolveFix = resolve
    }))
    const { container, root } = renderWikiHealthView()
    const fixButton = container.querySelector("[data-testid='wiki-health-issue-action-lint-lint-1']") as HTMLButtonElement

    await click(fixButton)

    expect(mocks.fixLintResult).toHaveBeenCalledWith(
      "/project",
      expect.objectContaining({ id: "lint-1", type: "broken-link" }),
      expect.any(Object),
    )
    expect(fixButton.disabled).toBe(true)

    await act(async () => {
      resolveFix(true)
      await Promise.resolve()
    })
    await flush()

    expect(useLintStore.getState().items.map((item) => item.id)).toEqual(["lint-2"])
    expect(container.querySelector("[data-testid='wiki-health-issue-action-lint-lint-1']")).toBeNull()
    expect(mocks.listDirectory).toHaveBeenCalledWith("/project")

    unmount(root)
  })

  it("fixes all fixable lint issues through the shared bulk action", async () => {
    const { container, root } = renderWikiHealthView()

    await click(container.querySelector("[data-testid='wiki-health-fix-all-lint']")!)
    await flush()

    expect(mocks.fixAllLintResults).toHaveBeenCalledWith(
      "/project",
      [expect.objectContaining({ id: "lint-1" })],
      expect.any(Object),
    )
    expect(useLintStore.getState().items.map((item) => item.id)).toEqual(["lint-2"])

    unmount(root)
  })

  it("queues a rebuild for a rebuildable derived layer from the dashboard", async () => {
    useDerivedLayerStore.setState({
      buckets: {
        embedding: { layer: "embedding", status: "dirty", stale: false, lastRebuiltAtMs: null },
      },
      capturedAtMs: 1,
      error: null,
      runtimeDisabled: false,
    })
    const { container, root } = renderWikiHealthView()

    await click(container.querySelector("[data-testid='wiki-health-issue-action-derived-embedding']")!)
    await flush()

    expect(mocks.mintManualRebuildForLayer).toHaveBeenCalledWith(
      "embedding",
      "/project",
      "embedding-dashboard-rebuild",
    )

    unmount(root)
  })

  it("renders an all-clear dashboard with score 100 when there are no issues", () => {
    useLintStore.setState({ items: [] })
    useReviewStore.setState({ items: [] })
    useDerivedLayerStore.setState({ buckets: null, capturedAtMs: null, error: null, runtimeDisabled: false })

    const { container, root } = renderWikiHealthView()

    expect(container.querySelector("[data-testid='wiki-health-score']")?.textContent).toBe("100")
    expect(container.textContent).toContain("No issues found")

    unmount(root)
  })
})
