// @vitest-environment jsdom

import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import i18n from "@/i18n"
import { ReviewView } from "./review-view"
import { useReviewStore } from "@/stores/review-store"
import { useWikiStore } from "@/stores/wiki-store"
import { useChatStore } from "@/stores/chat-store"

const researchMocks = vi.hoisted(() => ({
  queueResearch: vi.fn(),
}))

const fsMocks = vi.hoisted(() => ({
  listDirectory: vi.fn(),
  readFile: vi.fn(),
  writeFile: vi.fn(),
  deleteFile: vi.fn(),
}))

const snapshotMocks = vi.hoisted(() => ({
  restoreSingleAgentWikiSnapshot: vi.fn(),
}))

const lintMocks = vi.hoisted(() => ({
  enqueueAgentStructuralLint: vi.fn(),
}))

vi.mock("@/lib/deep-research", () => researchMocks)
vi.mock("@/commands/fs", () => fsMocks)
vi.mock("@/lib/agent/agent-wiki-snapshot-restore", () => snapshotMocks)
vi.mock("@/lib/agent/agent-lint-queue", () => lintMocks)

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

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
} {
  let resolve: (value: T) => void = () => undefined
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

beforeEach(() => {
  vi.clearAllMocks()
  window.alert = vi.fn()
  fsMocks.listDirectory.mockResolvedValue([])
  fsMocks.readFile.mockResolvedValue("restored content")
  fsMocks.writeFile.mockResolvedValue(undefined)
  fsMocks.deleteFile.mockResolvedValue(undefined)
  snapshotMocks.restoreSingleAgentWikiSnapshot.mockResolvedValue({
    ok: true,
    restoredPaths: ["wiki/page.md"],
    failures: [],
  })
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
  useChatStore.setState({
    messages: [],
    agentRewindLocks: {},
    isStreaming: false,
    streamingConversationId: null,
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

describe("ReviewView agent write action", () => {
  function setAgentWriteReviewItem(): void {
    useReviewStore.setState({
      items: [
        {
          id: "review-agent-1",
          type: "agent-write",
          title: "更新 wiki/page.md",
          description: "Agent 更新了 wiki/page.md。",
          sourcePath: "wiki/page.md",
          affectedPages: ["wiki/page.md"],
          agentWrite: {
            path: "wiki/page.md",
            operation: "update",
            conversationId: "conv-1",
            messageId: "m-agent-1",
            streamId: "stream-1",
            toolUseId: "tool-1",
            snapshotted: true,
            timestamp: 1,
          },
          options: [
            { label: "查看页面", action: "open:wiki/page.md" },
            { label: "撤销此写入", action: "__agent_write_undo__" },
            { label: "接受", action: "__agent_write_accept__" },
          ],
          resolved: false,
          createdAt: 1,
        },
      ],
    })
    useChatStore.setState({
      messages: [
        {
          id: "m-agent-1",
          role: "assistant",
          content: "",
          timestamp: 1,
          conversationId: "conv-1",
          mode: "agent",
          wikiChanges: [{
            path: "wiki/page.md",
            operation: "update",
            timestamp: 1,
            toolUseId: "tool-1",
            snapshotted: true,
          }],
        },
      ],
    })
  }

  it("restores a snapshotted write, resolves the item, and marks the message change reverted", async () => {
    setAgentWriteReviewItem()
    const { container, root } = renderReviewView()
    const undoButton = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("撤销此写入"),
    )
    if (!undoButton) throw new Error("undo button not found")

    await act(async () => {
      undoButton.dispatchEvent(new MouseEvent("click", { bubbles: true }))
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(snapshotMocks.restoreSingleAgentWikiSnapshot).toHaveBeenCalledWith({
      projectPath: "/project",
      streamId: "stream-1",
      path: "wiki/page.md",
      toolUseId: "tool-1",
    })
    expect(fsMocks.listDirectory).toHaveBeenCalledWith("/project")
    expect(lintMocks.enqueueAgentStructuralLint).toHaveBeenCalledWith(
      "/project",
      ["wiki/page.md"],
      0,
    )
    expect(useReviewStore.getState().items[0]).toMatchObject({
      resolved: true,
      resolvedAction: "Reverted",
    })
    expect(useChatStore.getState().messages[0].wikiChanges?.[0]?.reverted).toBe(true)

    unmount(root)
  })

  it("refuses undo while the conversation is rewinding and keeps the item pending", async () => {
    setAgentWriteReviewItem()
    useChatStore.setState({ agentRewindLocks: { "conv-1": true } })
    const { container, root } = renderReviewView()
    const undoButton = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("撤销此写入"),
    )
    if (!undoButton) throw new Error("undo button not found")

    await act(async () => {
      undoButton.dispatchEvent(new MouseEvent("click", { bubbles: true }))
      await Promise.resolve()
    })

    expect(snapshotMocks.restoreSingleAgentWikiSnapshot).not.toHaveBeenCalled()
    expect(window.alert).toHaveBeenCalledWith("该对话正在 rewind，暂不能撤销此写入。")
    expect(useReviewStore.getState().items[0]?.resolved).toBe(false)

    unmount(root)
  })

  it("holds the rewind lock while a single-write undo is in progress", async () => {
    setAgentWriteReviewItem()
    const pendingRestore = deferred<{
      ok: true
      restoredPaths: string[]
      failures: []
    }>()
    snapshotMocks.restoreSingleAgentWikiSnapshot.mockReturnValue(pendingRestore.promise)
    const { container, root } = renderReviewView()
    const undoButton = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("撤销此写入"),
    )
    if (!undoButton) throw new Error("undo button not found")

    await act(async () => {
      undoButton.dispatchEvent(new MouseEvent("click", { bubbles: true }))
      await Promise.resolve()
    })

    expect(useChatStore.getState().agentRewindLocks["conv-1"]).toBe(true)

    await act(async () => {
      pendingRestore.resolve({ ok: true, restoredPaths: ["wiki/page.md"], failures: [] })
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(useChatStore.getState().agentRewindLocks["conv-1"]).toBeUndefined()
    expect(useReviewStore.getState().items[0]).toMatchObject({
      resolved: true,
      resolvedAction: "Reverted",
    })

    unmount(root)
  })

  it("refuses undo while the same conversation is streaming", async () => {
    setAgentWriteReviewItem()
    useChatStore.setState({
      isStreaming: true,
      streamingConversationId: "conv-1",
    })
    const { container, root } = renderReviewView()
    const undoButton = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("撤销此写入"),
    )
    if (!undoButton) throw new Error("undo button not found")

    await act(async () => {
      undoButton.dispatchEvent(new MouseEvent("click", { bubbles: true }))
      await Promise.resolve()
    })

    expect(snapshotMocks.restoreSingleAgentWikiSnapshot).not.toHaveBeenCalled()
    expect(window.alert).toHaveBeenCalledWith(i18n.t("agent.writeReview.blockedRunning"))
    expect(useReviewStore.getState().items[0]?.resolved).toBe(false)

    unmount(root)
  })

  it("allows undo while another conversation is streaming", async () => {
    setAgentWriteReviewItem()
    useChatStore.setState({
      isStreaming: true,
      streamingConversationId: "conv-2",
    })
    const { container, root } = renderReviewView()
    const undoButton = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("撤销此写入"),
    )
    if (!undoButton) throw new Error("undo button not found")

    await act(async () => {
      undoButton.dispatchEvent(new MouseEvent("click", { bubbles: true }))
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(snapshotMocks.restoreSingleAgentWikiSnapshot).toHaveBeenCalled()
    expect(useReviewStore.getState().items[0]).toMatchObject({
      resolved: true,
      resolvedAction: "Reverted",
    })

    unmount(root)
  })
})
