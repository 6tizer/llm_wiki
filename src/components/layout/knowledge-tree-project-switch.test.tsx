// @vitest-environment jsdom

import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import "@/i18n"
import { KnowledgeTree } from "./knowledge-tree"
import { useWikiStore } from "@/stores/wiki-store"
import type { FileNode } from "@/types/wiki"

// SPEC-11 follow-up S8: handleDeleteClick awaits cascadeDeleteWikiPagesWithRefs,
// then refreshes the page list / global file-tree / data version. If the user
// switches projects while that delete is still in flight, the refresh must
// not run — it would reload the OLD project's pages/tree into what's now the
// NEW project's view. Guard mirrors the project.id check used by
// rescanProjectFileSync in project-file-sync.ts (and the D1/PR8b
// stale-discard pattern).

const fsMocks = vi.hoisted(() => ({
  listDirectory: vi.fn(),
  readFile: vi.fn(),
}))

const wikiPageDeleteMocks = vi.hoisted(() => ({
  cascadeDeleteWikiPagesWithRefs: vi.fn(),
}))

vi.mock("@/commands/fs", () => fsMocks)
vi.mock("@/lib/wiki-page-delete", () => wikiPageDeleteMocks)

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true

const PROJECT_A = { id: "project-a", name: "A", path: "/project-a" }
const PROJECT_B = { id: "project-b", name: "B", path: "/project-b" }

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

function wikiTree(root: string): FileNode[] {
  return [{ name: "concept-a.md", path: `${root}/wiki/concept-a.md`, is_dir: false }]
}

describe("KnowledgeTree — project switch during delete", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    fsMocks.readFile.mockResolvedValue("---\ntype: concept\ntitle: Concept A\n---\n\nbody")
    act(() => {
      useWikiStore.getState().setProject(PROJECT_A)
      useWikiStore.getState().setFileTree([])
    })
  })

  afterEach(() => {
    act(() => {
      useWikiStore.getState().setProject(null)
      useWikiStore.getState().setFileTree([])
    })
    document.body.innerHTML = ""
  })

  it("discards the post-delete page-list/file-tree/dataVersion refresh when the project changes mid-delete", async () => {
    fsMocks.listDirectory.mockImplementation(async (dir: string) => {
      if (dir === `${PROJECT_A.path}/wiki`) return wikiTree(PROJECT_A.path)
      return []
    })
    const del = deferred<void>()
    wikiPageDeleteMocks.cascadeDeleteWikiPagesWithRefs.mockReturnValue(del.promise)

    const { container, root } = renderKnowledgeTree()
    await flush()

    expect(container.textContent).toContain("Concept A")

    await click(container.querySelector('button[title="Delete Concept A (and clean up references)"]')!)
    await flush()
    await click(
      container.querySelector('button[title="Click again to delete Concept A and clean up references"]')!,
    )
    await flush()

    expect(wikiPageDeleteMocks.cascadeDeleteWikiPagesWithRefs).toHaveBeenCalledWith(PROJECT_A.path, [
      `${PROJECT_A.path}/wiki/concept-a.md`,
    ])

    const versionBeforeResolve = useWikiStore.getState().dataVersion
    fsMocks.listDirectory.mockClear()

    // Switch projects while the delete is still in flight, then let it settle.
    await act(async () => {
      useWikiStore.getState().setProject(PROJECT_B)
    })
    await flush()

    await act(async () => {
      del.resolve()
      await Promise.resolve()
    })
    await flush()

    // The stale handler must not have bumped dataVersion or re-listed the
    // OLD project's directories after the switch.
    expect(useWikiStore.getState().dataVersion).toBe(versionBeforeResolve)
    expect(fsMocks.listDirectory).not.toHaveBeenCalledWith(PROJECT_A.path)
    expect(fsMocks.listDirectory).not.toHaveBeenCalledWith(`${PROJECT_A.path}/wiki`)

    unmount(root)
  })

  // Tester P1: without this, an inverted/always-true guard condition would
  // silently kill the refresh in the common (no project switch) case while
  // every "discards..." test kept passing.
  it("refreshes the page list, file tree, and dataVersion when the project does not change", async () => {
    fsMocks.listDirectory.mockImplementation(async (dir: string) => {
      if (dir === `${PROJECT_A.path}/wiki`) return wikiTree(PROJECT_A.path)
      return []
    })
    wikiPageDeleteMocks.cascadeDeleteWikiPagesWithRefs.mockResolvedValue(undefined)

    const { container, root } = renderKnowledgeTree()
    await flush()

    const versionBefore = useWikiStore.getState().dataVersion
    fsMocks.listDirectory.mockClear()

    await click(container.querySelector('button[title="Delete Concept A (and clean up references)"]')!)
    await flush()
    await click(
      container.querySelector('button[title="Click again to delete Concept A and clean up references"]')!,
    )
    await flush()

    expect(wikiPageDeleteMocks.cascadeDeleteWikiPagesWithRefs).toHaveBeenCalledWith(PROJECT_A.path, [
      `${PROJECT_A.path}/wiki/concept-a.md`,
    ])
    expect(fsMocks.listDirectory).toHaveBeenCalledWith(`${PROJECT_A.path}/wiki`)
    expect(fsMocks.listDirectory).toHaveBeenCalledWith(PROJECT_A.path)
    expect(useWikiStore.getState().dataVersion).toBeGreaterThan(versionBefore)

    unmount(root)
  })

  // Reviewer P1: the delete op itself can resolve before the switch — the
  // widest await window is inside `loadPages`, which lists the wiki dir and
  // then reads every page over IPC in a loop. Defer that inner listDirectory
  // call (rather than the delete op) to prove the second checkpoint (right
  // after `await loadPages()`) actually discards the refresh too.
  it("discards the setFileTree/bumpDataVersion refresh when the project changes while loadPages (not the delete) is in flight", async () => {
    let wikiListCallCount = 0
    let pendingWikiList: { promise: Promise<FileNode[]>; resolve: (v: FileNode[]) => void } | null = null
    fsMocks.listDirectory.mockImplementation(async (dir: string) => {
      if (dir === `${PROJECT_A.path}/wiki`) {
        wikiListCallCount++
        if (wikiListCallCount === 1) return wikiTree(PROJECT_A.path)
        pendingWikiList = deferred<FileNode[]>()
        return pendingWikiList.promise
      }
      return []
    })
    wikiPageDeleteMocks.cascadeDeleteWikiPagesWithRefs.mockResolvedValue(undefined)

    const { container, root } = renderKnowledgeTree()
    await flush()

    const setFileTreeSpy = vi.spyOn(useWikiStore.getState(), "setFileTree")
    const bumpDataVersionSpy = vi.spyOn(useWikiStore.getState(), "bumpDataVersion")
    const versionBeforeResolve = useWikiStore.getState().dataVersion

    await click(container.querySelector('button[title="Delete Concept A (and clean up references)"]')!)
    await flush()
    await click(
      container.querySelector('button[title="Click again to delete Concept A and clean up references"]')!,
    )
    await flush()

    // The delete has already resolved (mockResolvedValue), and
    // handleDeleteClick's `await loadPages()` is now blocked on the second,
    // deferred `listDirectory(".../wiki")` call.
    expect(wikiPageDeleteMocks.cascadeDeleteWikiPagesWithRefs).toHaveBeenCalled()
    expect(pendingWikiList).not.toBeNull()

    await act(async () => {
      useWikiStore.getState().setProject(PROJECT_B)
    })
    await flush()

    await act(async () => {
      pendingWikiList!.resolve(wikiTree(PROJECT_A.path))
      await Promise.resolve()
    })
    await flush()

    expect(setFileTreeSpy).not.toHaveBeenCalled()
    expect(bumpDataVersionSpy).not.toHaveBeenCalled()
    expect(useWikiStore.getState().dataVersion).toBe(versionBeforeResolve)

    setFileTreeSpy.mockRestore()
    bumpDataVersionSpy.mockRestore()
    unmount(root)
  })

  // Tester P2: closing the project entirely (not switching to another one)
  // mid-delete must be handled the same way as a switch — no throw, and the
  // stale refresh is dropped.
  it("does not throw and drops the refresh when the project is closed (set to null) mid-delete", async () => {
    fsMocks.listDirectory.mockImplementation(async (dir: string) => {
      if (dir === `${PROJECT_A.path}/wiki`) return wikiTree(PROJECT_A.path)
      return []
    })
    const del = deferred<void>()
    wikiPageDeleteMocks.cascadeDeleteWikiPagesWithRefs.mockReturnValue(del.promise)

    const { container, root } = renderKnowledgeTree()
    await flush()

    await click(container.querySelector('button[title="Delete Concept A (and clean up references)"]')!)
    await flush()
    await click(
      container.querySelector('button[title="Click again to delete Concept A and clean up references"]')!,
    )
    await flush()

    const versionBeforeResolve = useWikiStore.getState().dataVersion
    fsMocks.listDirectory.mockClear()

    await act(async () => {
      useWikiStore.getState().setProject(null)
    })
    await flush()

    // No throw: an unguarded null-project dereference (e.g. `project.name`
    // in the catch-block alert) would surface here as an unhandled
    // rejection/thrown error failing this `act`.
    await act(async () => {
      del.resolve()
      await Promise.resolve()
    })
    await flush()

    expect(useWikiStore.getState().dataVersion).toBe(versionBeforeResolve)
    expect(fsMocks.listDirectory).not.toHaveBeenCalledWith(PROJECT_A.path)
    expect(fsMocks.listDirectory).not.toHaveBeenCalledWith(`${PROJECT_A.path}/wiki`)

    unmount(root)
  })
})

function renderKnowledgeTree(): { container: HTMLDivElement; root: Root } {
  const container = document.createElement("div")
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => {
    root.render(<KnowledgeTree />)
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
  })
}

function unmount(root: Root): void {
  act(() => {
    root.unmount()
  })
}
