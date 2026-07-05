// @vitest-environment jsdom

import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import "@/i18n"
import { SourcesView } from "./sources-view"
import { useWikiStore } from "@/stores/wiki-store"
import type { FileNode } from "@/types/wiki"

// SPEC-11 follow-up S8: handleDelete / handleDeleteFolder await a
// delete op, then refresh the source tree / global file-tree / data
// version. If the user switches projects while that delete is still
// in flight, the refresh must not run — it would reload the OLD
// project's tree into what's now the NEW project's view. Guard mirrors
// the project.id check used by rescanProjectFileSync in
// project-file-sync.ts (and the D1/PR8b stale-discard pattern).
//
// Deliberately a separate file from sources-view.test.tsx so the
// deferred-promise timing control here can't interact with that
// suite's mock setup.

const fsMocks = vi.hoisted(() => ({
  listDirectory: vi.fn(),
  readFile: vi.fn(),
}))

const sourceLifecycleMocks = vi.hoisted(() => ({
  deleteSourceFile: vi.fn(),
  deleteSourceFolder: vi.fn(),
  enqueueSourceIngest: vi.fn(),
  importSourceFiles: vi.fn(),
  importSourceFolder: vi.fn(),
}))

const projectFileSyncMocks = vi.hoisted(() => ({
  rescanProjectFileSync: vi.fn(),
}))

// Same wholesale mocks as sources-view.test.tsx: SourcesView imports
// runBulkKnowledgePrepare, whose real implementation reaches into
// @/commands/fs internals (fileExists etc.) this test's minimal fsMocks
// don't provide. Mocking these two out keeps the bulk-prepare path inert.
const bulkRuntimeEntryMocks = vi.hoisted(() => ({
  enqueueBulkKnowledgePrepareJobs: vi.fn(),
}))

const commitIntegrationMocks = vi.hoisted(() => ({
  commitPendingStagingArtifacts: vi.fn(),
}))

const ingestMocks = vi.hoisted(() => ({
  startIngest: vi.fn(),
}))

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }))
vi.mock("@/commands/fs", () => fsMocks)
vi.mock("@/lib/source-lifecycle", () => sourceLifecycleMocks)
vi.mock("@/lib/project-file-sync", () => projectFileSyncMocks)
vi.mock("@/lib/parallel-knowledge/bulk-runtime-entry", () => bulkRuntimeEntryMocks)
vi.mock("@/lib/parallel-knowledge/commit-integration", () => commitIntegrationMocks)
vi.mock("@/lib/ingest", () => ingestMocks)

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

function sourceTree(root: string): FileNode[] {
  return [{ name: "a.md", path: `${root}/raw/sources/a.md`, is_dir: false }]
}

function folderSourceTree(root: string): FileNode[] {
  return [
    {
      name: "sub",
      path: `${root}/raw/sources/sub`,
      is_dir: true,
      children: [{ name: "a.md", path: `${root}/raw/sources/sub/a.md`, is_dir: false }],
    },
  ]
}

describe("SourcesView — project switch during delete", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    fsMocks.readFile.mockResolvedValue("body")
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

  it("discards the post-delete file-tree/dataVersion refresh when the project changes mid-delete (file)", async () => {
    fsMocks.listDirectory.mockImplementation(async (dir: string) => {
      if (dir === `${PROJECT_A.path}/raw/sources`) return sourceTree(PROJECT_A.path)
      return []
    })
    const del = deferred<{ deletedWikiPaths: string[] }>()
    sourceLifecycleMocks.deleteSourceFile.mockReturnValue(del.promise)

    const { container, root } = renderSourcesView()
    await flush()

    await click(container.querySelector('button[title="Delete a.md"]')!)
    await flush()
    await click(container.querySelector('button[title="Click again to delete a.md"]')!)
    await flush()

    expect(sourceLifecycleMocks.deleteSourceFile).toHaveBeenCalledWith(
      PROJECT_A.path,
      `${PROJECT_A.path}/raw/sources/a.md`,
    )

    const versionBeforeResolve = useWikiStore.getState().dataVersion
    fsMocks.listDirectory.mockClear()

    // Switch projects while the delete is still in flight, then let it settle.
    await act(async () => {
      useWikiStore.getState().setProject(PROJECT_B)
    })
    await flush()

    await act(async () => {
      del.resolve({ deletedWikiPaths: [] })
      await Promise.resolve()
    })
    await flush()

    // The stale handler must not have bumped dataVersion or re-listed the
    // OLD project's directories after the switch.
    expect(useWikiStore.getState().dataVersion).toBe(versionBeforeResolve)
    expect(fsMocks.listDirectory).not.toHaveBeenCalledWith(PROJECT_A.path)
    expect(fsMocks.listDirectory).not.toHaveBeenCalledWith(`${PROJECT_A.path}/raw/sources`)

    unmount(root)
  })

  it("discards the post-delete file-tree/dataVersion refresh when the project changes mid-delete (folder)", async () => {
    fsMocks.listDirectory.mockImplementation(async (dir: string) => {
      if (dir === `${PROJECT_A.path}/raw/sources`) return folderSourceTree(PROJECT_A.path)
      return []
    })
    const del = deferred<{ deletedWikiPaths: string[] }>()
    sourceLifecycleMocks.deleteSourceFolder.mockReturnValue(del.promise)

    const { container, root } = renderSourcesView()
    await flush()

    await click(container.querySelector('button[title="Delete folder sub (recursive)"]')!)
    await flush()
    await click(container.querySelector('button[title="Click again to delete folder sub and ALL its contents"]')!)
    await flush()

    expect(sourceLifecycleMocks.deleteSourceFolder).toHaveBeenCalled()

    const versionBeforeResolve = useWikiStore.getState().dataVersion
    fsMocks.listDirectory.mockClear()

    await act(async () => {
      useWikiStore.getState().setProject(PROJECT_B)
    })
    await flush()

    await act(async () => {
      del.resolve({ deletedWikiPaths: [] })
      await Promise.resolve()
    })
    await flush()

    expect(useWikiStore.getState().dataVersion).toBe(versionBeforeResolve)
    expect(fsMocks.listDirectory).not.toHaveBeenCalledWith(PROJECT_A.path)
    expect(fsMocks.listDirectory).not.toHaveBeenCalledWith(`${PROJECT_A.path}/raw/sources`)

    unmount(root)
  })

  // Tester P1: without these, an inverted/always-true guard condition would
  // silently kill the refresh in the common (no project switch) case while
  // every "discards..." test above kept passing.
  it("refreshes the source tree and bumps dataVersion when the project does not change (file)", async () => {
    fsMocks.listDirectory.mockImplementation(async (dir: string) => {
      if (dir === `${PROJECT_A.path}/raw/sources`) return sourceTree(PROJECT_A.path)
      return []
    })
    sourceLifecycleMocks.deleteSourceFile.mockResolvedValue({ deletedWikiPaths: [] })

    const { container, root } = renderSourcesView()
    await flush()

    const versionBefore = useWikiStore.getState().dataVersion
    fsMocks.listDirectory.mockClear()

    await click(container.querySelector('button[title="Delete a.md"]')!)
    await flush()
    await click(container.querySelector('button[title="Click again to delete a.md"]')!)
    await flush()

    expect(sourceLifecycleMocks.deleteSourceFile).toHaveBeenCalledWith(
      PROJECT_A.path,
      `${PROJECT_A.path}/raw/sources/a.md`,
    )
    expect(fsMocks.listDirectory).toHaveBeenCalledWith(`${PROJECT_A.path}/raw/sources`)
    expect(fsMocks.listDirectory).toHaveBeenCalledWith(PROJECT_A.path)
    expect(useWikiStore.getState().dataVersion).toBeGreaterThan(versionBefore)

    unmount(root)
  })

  it("refreshes the source tree and bumps dataVersion when the project does not change (folder)", async () => {
    fsMocks.listDirectory.mockImplementation(async (dir: string) => {
      if (dir === `${PROJECT_A.path}/raw/sources`) return folderSourceTree(PROJECT_A.path)
      return []
    })
    sourceLifecycleMocks.deleteSourceFolder.mockResolvedValue({ deletedWikiPaths: [] })

    const { container, root } = renderSourcesView()
    await flush()

    const versionBefore = useWikiStore.getState().dataVersion
    fsMocks.listDirectory.mockClear()

    await click(container.querySelector('button[title="Delete folder sub (recursive)"]')!)
    await flush()
    await click(container.querySelector('button[title="Click again to delete folder sub and ALL its contents"]')!)
    await flush()

    expect(sourceLifecycleMocks.deleteSourceFolder).toHaveBeenCalled()
    expect(fsMocks.listDirectory).toHaveBeenCalledWith(`${PROJECT_A.path}/raw/sources`)
    expect(fsMocks.listDirectory).toHaveBeenCalledWith(PROJECT_A.path)
    expect(useWikiStore.getState().dataVersion).toBeGreaterThan(versionBefore)

    unmount(root)
  })
})

function renderSourcesView(): { container: HTMLDivElement; root: Root } {
  const container = document.createElement("div")
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => {
    root.render(<SourcesView />)
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
