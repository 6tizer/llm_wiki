// @vitest-environment jsdom

import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import "@/i18n"
import { SourcesView } from "./sources-view"
import { useWikiStore } from "@/stores/wiki-store"
import { useChatStore } from "@/stores/chat-store"
import type { FileNode } from "@/types/wiki"

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

const bulkRuntimeEntryMocks = vi.hoisted(() => ({
  enqueueBulkKnowledgePrepareJobs: vi.fn(),
}))

// SPEC-5-FIX PR5: runBulkKnowledgePrepare now also drives a commit-integration
// pass. Mocked wholesale here (same pattern as bulk-runtime-entry above) so
// this component test doesn't need to stand up the runtime-db/fs surface
// commit-integration's default adapters touch -- that surface is exercised
// directly in commit-integration.test.ts.
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

describe("SourcesView bulk prepare entry", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    fsMocks.listDirectory.mockResolvedValue(sourceTree())
    fsMocks.readFile.mockResolvedValue("source body")
    bulkRuntimeEntryMocks.enqueueBulkKnowledgePrepareJobs.mockResolvedValue({
      plan: { jobs: [] },
      enqueuedJobs: [],
      skippedDuplicateJobIds: [],
      failedJobs: [],
    })
    commitIntegrationMocks.commitPendingStagingArtifacts.mockResolvedValue({
      listedArtifacts: 0,
      attemptedArtifacts: 0,
      committed: 0,
      merged: 0,
      conflicted: 0,
      rejected: 0,
      skipped: 0,
      retryable: 0,
      repairJobs: 0,
      cleanedArtifacts: 0,
      markersRecorded: 0,
      progressEvents: 0,
      errors: [],
    })
    ingestMocks.startIngest.mockImplementation(async (_projectPath, sourcePath) => {
      const store = useChatStore.getState()
      const id = store.createConversation()
      store.addMessage("user", `discussion:${sourcePath}`)
      store.finalizeStream("analysis", undefined, id)
      store.renameConversation(id, String(sourcePath).split("/").pop() || "source")
    })
    act(() => {
      useWikiStore.getState().setProject({
        id: "p1",
        name: "Project",
        path: "/project",
      })
    })
  })

  afterEach(() => {
    act(() => {
      useWikiStore.getState().setProject(null)
      useChatStore.setState({
        conversations: [],
        activeConversationId: null,
        messages: [],
        ingestSource: null,
        isStreaming: false,
        streamingContent: "",
      })
    })
    document.body.innerHTML = ""
  })

  it("enqueues bulk prepare jobs from the visible source tree without touching legacy ingest", async () => {
    const { container, root } = renderSourcesView()
    await flush()

    await click(container.querySelector("button[aria-label='Plan bulk prepare']")!)
    await flush()

    expect(bulkRuntimeEntryMocks.enqueueBulkKnowledgePrepareJobs).toHaveBeenCalledWith(
      [
        { sourcePath: "/project/raw/sources/a.md" },
        { sourcePath: "/project/raw/sources/nested/b.md" },
      ],
      {},
    )
    expect(sourceLifecycleMocks.enqueueSourceIngest).not.toHaveBeenCalled()
    expect(sourceLifecycleMocks.importSourceFiles).not.toHaveBeenCalled()
    expect(sourceLifecycleMocks.importSourceFolder).not.toHaveBeenCalled()

    unmount(root)
  })

  it("shows enqueue failures without clearing the source tree", async () => {
    bulkRuntimeEntryMocks.enqueueBulkKnowledgePrepareJobs.mockResolvedValue({
      plan: { jobs: [{ jobKey: "job-1" }, { jobKey: "job-2" }] },
      enqueuedJobs: [],
      skippedDuplicateJobIds: [],
      failedJobs: [{ jobId: "job-2", message: "failed" }],
    })

    const { container, root } = renderSourcesView()
    await flush()

    await click(container.querySelector("button[aria-label='Plan bulk prepare']")!)
    await flush()

    expect(container.textContent).toContain("1 of 2 runtime prepare jobs failed to enqueue")
    expect(container.textContent).toContain("a.md")

    unmount(root)
  })

  it("disables bulk prepare when the source tree has no files", async () => {
    fsMocks.listDirectory.mockResolvedValueOnce([])

    const { container, root } = renderSourcesView()
    await flush()

    const button = container.querySelector("button[aria-label='Plan bulk prepare']") as HTMLButtonElement
    expect(button.disabled).toBe(true)

    await click(button)
    await flush()

    expect(bulkRuntimeEntryMocks.enqueueBulkKnowledgePrepareJobs).not.toHaveBeenCalled()

    unmount(root)
  })

  it("starts an interactive source discussion without enqueueing automatic ingest", async () => {
    useChatStore.setState({
      conversations: [{ id: "old", title: "Old", createdAt: 1, updatedAt: 1 }],
      activeConversationId: "old",
      messages: [
        { id: "old-u", role: "user", content: "keep", timestamp: 1, conversationId: "old" },
      ],
      ingestSource: null,
      isStreaming: false,
      streamingContent: "",
    })
    const { container, root } = renderSourcesView()
    await flush()

    await click(container.querySelector("button[title='Discuss']")!)
    await flush()

    expect(ingestMocks.startIngest).toHaveBeenCalledWith(
      "/project",
      "/project/raw/sources/nested/b.md",
      expect.any(Object),
    )
    expect(useWikiStore.getState().activeView).toBe("wiki")
    expect(sourceLifecycleMocks.enqueueSourceIngest).not.toHaveBeenCalled()
    const chatState = useChatStore.getState()
    const activeConversationId = chatState.activeConversationId
    expect(chatState.messages.filter((message) => message.conversationId === "old")).toHaveLength(1)
    expect(activeConversationId).not.toBe("old")
    expect(chatState.messages.some((message) => (
      message.conversationId === activeConversationId &&
      message.content === "analysis"
    ))).toBe(true)

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

function sourceTree(): FileNode[] {
  return [
    {
      name: "a.md",
      path: "/project/raw/sources/a.md",
      is_dir: false,
    },
    {
      name: "nested",
      path: "/project/raw/sources/nested",
      is_dir: true,
      children: [
        {
          name: "b.md",
          path: "/project/raw/sources/nested/b.md",
          is_dir: false,
        },
      ],
    },
  ]
}
