// @vitest-environment jsdom

import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { useLintFixActions, useLintFixActionStore } from "./use-lint-fix-actions"
import { useLintStore, type LintItem } from "@/stores/lint-store"
import { useWikiStore } from "@/stores/wiki-store"

const mocks = vi.hoisted(() => ({
  listDirectory: vi.fn(async () => []),
  fixLintResult: vi.fn(),
  fixAllLintResults: vi.fn(async () => ({ fixed: [] as unknown[], failed: [] as unknown[] })),
  notifyWikiPathsChanged: vi.fn(),
}))

vi.mock("@/commands/fs", () => ({
  listDirectory: mocks.listDirectory,
}))

vi.mock("@/lib/lint-fixer", () => ({
  fixLintResult: mocks.fixLintResult,
  fixAllLintResults: mocks.fixAllLintResults,
  isFixable: () => true,
}))

vi.mock("@/lib/wiki-change-notifier", () => ({
  notifyWikiPathsChanged: mocks.notifyWikiPathsChanged,
}))

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true

const lintItem: LintItem = {
  id: "lint-1",
  type: "broken-link",
  severity: "warning",
  page: "wiki/a.md",
  detail: "Broken link",
  createdAt: 1,
}

function Harness({ label }: { label: string }) {
  const { fixingId, fixLintItem } = useLintFixActions()
  return (
    <button type="button" data-testid={label} onClick={() => void fixLintItem(lintItem)}>
      {fixingId ?? "idle"}
    </button>
  )
}

function FixAllHarness() {
  const { fixAllLintItems } = useLintFixActions()
  return (
    <button type="button" data-testid="fix-all" onClick={() => void fixAllLintItems()}>
      fix all
    </button>
  )
}

function renderHarnesses(): { container: HTMLDivElement; root: Root } {
  const container = document.createElement("div")
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => {
    root.render(
      <>
        <Harness label="a" />
        <Harness label="b" />
      </>,
    )
  })
  return { container, root }
}

describe("useLintFixActions", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useWikiStore.setState({
      project: { id: "project-1", name: "Project", path: "/project" },
    })
    useLintStore.setState({ items: [lintItem] })
    useLintFixActionStore.setState({ fixingId: null, fixingAll: false })
  })

  afterEach(() => {
    useWikiStore.setState({ project: null, fileTree: [] })
    useLintStore.setState({ items: [] })
    useLintFixActionStore.setState({ fixingId: null, fixingAll: false })
    document.body.innerHTML = ""
  })

  it("shares single-item busy state across hook consumers", async () => {
    let resolveFix: (value: boolean) => void = () => undefined
    mocks.fixLintResult.mockImplementationOnce(() => new Promise<boolean>((resolve) => {
      resolveFix = resolve
    }))
    const { container, root } = renderHarnesses()

    await act(async () => {
      container.querySelector<HTMLButtonElement>("[data-testid='a']")?.dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      )
      await Promise.resolve()
    })

    expect(container.querySelector("[data-testid='a']")?.textContent).toBe("lint-1")
    expect(container.querySelector("[data-testid='b']")?.textContent).toBe("lint-1")

    await act(async () => {
      container.querySelector<HTMLButtonElement>("[data-testid='b']")?.dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      )
      await Promise.resolve()
    })
    expect(mocks.fixLintResult).toHaveBeenCalledTimes(1)

    await act(async () => {
      resolveFix(true)
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(container.querySelector("[data-testid='a']")?.textContent).toBe("idle")
    expect(container.querySelector("[data-testid='b']")?.textContent).toBe("idle")
    expect(mocks.notifyWikiPathsChanged).toHaveBeenCalledWith("/project", ["wiki/a.md"])

    act(() => root.unmount())
    container.remove()
  })

  it("notifies all fixed pages after bulk lint fix", async () => {
    const secondItem: LintItem = { ...lintItem, id: "lint-2", page: "wiki/b.md" }
    useLintStore.setState({ items: [lintItem, secondItem] })
    mocks.fixAllLintResults.mockResolvedValueOnce({ fixed: [lintItem, secondItem], failed: [] })

    const container = document.createElement("div")
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => {
      root.render(<FixAllHarness />)
    })

    await act(async () => {
      container.querySelector<HTMLButtonElement>("[data-testid='fix-all']")?.dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      )
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(mocks.notifyWikiPathsChanged).toHaveBeenCalledWith(
      "/project",
      ["wiki/a.md", "wiki/b.md"],
    )

    act(() => root.unmount())
    container.remove()
  })
})
