import { describe, it, expect, beforeEach, vi } from "vitest"
import { resetProjectState } from "./reset-project-state"
import { useChatStore } from "@/stores/chat-store"
import { useReviewStore } from "@/stores/review-store"
import { useActivityStore } from "@/stores/activity-store"
import { useResearchStore } from "@/stores/research-store"
import { getQueue, pauseQueue } from "./ingest-queue"

// Dynamic-import mocks: resetProjectState uses `import("@/lib/ingest-queue")`
// and `import("@/lib/graph-relevance")` at runtime. vi.mock hoists these
// so the promise resolves to our stub immediately.
vi.mock("./ingest-queue", async () => {
  const actual = await vi.importActual<typeof import("./ingest-queue")>("./ingest-queue")
  return {
    ...actual,
    pauseQueue: vi.fn(async () => {}),
  }
})

vi.mock("./graph-relevance", () => ({
  clearGraphCache: vi.fn(),
}))

// SPEC-6 PR2: resetProjectState must stop the embedding-consumer
// derived-rebuild job poller, same as it stops scheduled import — this is
// the centralized-cleanup wiring test the plan calls a "sabotage" guard
// for (see PR2 self-verification: removing the stopEmbeddingConsumer call
// from reset-project-state.ts's cleanup list turns this test red).
vi.mock("./derived-rebuild/embedding-consumer", () => ({
  stopEmbeddingConsumer: vi.fn(),
}))

// SPEC-6 PR3+4: resetProjectState must ALSO stop the taxonomy-consumer
// derived-rebuild job poller, same centralized-cleanup contract as the
// embedding consumer above.
vi.mock("./derived-rebuild/taxonomy-consumer", () => ({
  stopTaxonomyConsumer: vi.fn(),
}))

import { clearGraphCache } from "./graph-relevance"
import { stopEmbeddingConsumer } from "./derived-rebuild/embedding-consumer"
import { stopTaxonomyConsumer } from "./derived-rebuild/taxonomy-consumer"

const mockPauseQueue = vi.mocked(pauseQueue)
const mockClearGraphCache = vi.mocked(clearGraphCache)
const mockStopEmbeddingConsumer = vi.mocked(stopEmbeddingConsumer)
const mockStopTaxonomyConsumer = vi.mocked(stopTaxonomyConsumer)

beforeEach(() => {
  mockPauseQueue.mockReset()
  mockPauseQueue.mockImplementation(async () => {})
  mockClearGraphCache.mockReset()
  mockStopEmbeddingConsumer.mockReset()
  mockStopTaxonomyConsumer.mockReset()
})

describe("resetProjectState — Zustand stores", () => {
  it("clears chat store conversations and messages", async () => {
    useChatStore.setState({
      conversations: [{ id: "c1", title: "x", createdAt: 0, updatedAt: 0 }],
      messages: [
        { id: "m1", role: "user", content: "hi", timestamp: 0, conversationId: "c1" },
      ],
      activeConversationId: "c1",
      isStreaming: true,
      streamingConversationId: "c1",
      streamingAgentMessageId: "m2",
      streamingContent: "partial",
      ingestSource: "/some/file",
      activeRunModelByConversation: { c1: "claude-test" },
      agentRewindLocks: { c1: true },
    })

    await resetProjectState()

    const chat = useChatStore.getState()
    expect(chat.conversations).toEqual([])
    expect(chat.messages).toEqual([])
    expect(chat.activeConversationId).toBeNull()
    expect(chat.isStreaming).toBe(false)
    expect(chat.streamingConversationId).toBeNull()
    expect(chat.streamingAgentMessageId).toBeNull()
    expect(chat.streamingContent).toBe("")
    expect(chat.ingestSource).toBeNull()
    expect(chat.activeRunModelByConversation).toEqual({})
    expect(chat.agentRewindLocks).toEqual({})
  })

  it("clears pending agent permission requests immediately on project reset", async () => {
    let resolved = false
    const decision = useChatStore.getState().requestAgentPermission({
      requestId: "permission-1",
      conversationId: "conv-1",
      toolName: "Bash",
      inputPreview: {},
      toolUseID: "tool-1",
    })
    decision.then(() => {
      resolved = true
    })

    await resetProjectState()
    await Promise.resolve()

    expect(resolved).toBe(true)
    await expect(decision).resolves.toMatchObject({
      behavior: "deny",
      interrupt: true,
    })
    expect(useChatStore.getState().activeAgentPermissionRequest).toBeNull()
    expect(useChatStore.getState().queuedAgentPermissionRequests).toEqual([])
    expect(useChatStore.getState().agentPermissionRequestsByConversation).toEqual({})
  })

  it("clears review store items", async () => {
    useReviewStore.setState({
      items: [
        {
          id: "r1",
          type: "missing-page",
          title: "x",
          description: "",
          options: [],
          resolved: false,
          createdAt: 0,
        },
      ],
    })

    await resetProjectState()
    expect(useReviewStore.getState().items).toEqual([])
  })

  it("clears activity store items", async () => {
    useActivityStore.setState({
      items: [
        {
          id: "a1",
          type: "query",
          title: "t",
          status: "done",
          detail: "",
          filesWritten: [],
          createdAt: 0,
        },
      ],
    })

    await resetProjectState()
    expect(useActivityStore.getState().items).toEqual([])
  })

  it("clears research store tasks", async () => {
    useResearchStore.setState({
      tasks: [
        {
          id: "t1",
          type: "gap",
          topic: "x",
          searchQueries: [],
          status: "pending",
          createdAt: 0,
        } as unknown as ReturnType<typeof useResearchStore.getState>["tasks"][number],
      ],
    })

    await resetProjectState()
    expect(useResearchStore.getState().tasks).toEqual([])
  })
})

describe("resetProjectState — module-level caches are awaited", () => {
  it("calls pauseQueue before the returned promise resolves", async () => {
    await resetProjectState()
    expect(mockPauseQueue).toHaveBeenCalledOnce()
  })

  it("calls clearGraphCache before the returned promise resolves", async () => {
    await resetProjectState()
    expect(mockClearGraphCache).toHaveBeenCalledOnce()
  })

  it("calls stopEmbeddingConsumer before the returned promise resolves (SPEC-6 PR2)", async () => {
    await resetProjectState()
    expect(mockStopEmbeddingConsumer).toHaveBeenCalledOnce()
  })

  it("calls stopTaxonomyConsumer before the returned promise resolves (SPEC-6 PR3+4)", async () => {
    await resetProjectState()
    expect(mockStopTaxonomyConsumer).toHaveBeenCalledOnce()
  })

  it("ordering: when resolve() fires, ALL module-level pollers/caches are already cleared", async () => {
    // This is the regression guard against fire-and-forget resets.
    // By the time the outer await returns, every one of these must be done.
    await resetProjectState()
    expect(mockPauseQueue).toHaveBeenCalledOnce()
    expect(mockClearGraphCache).toHaveBeenCalledOnce()
    expect(mockStopEmbeddingConsumer).toHaveBeenCalledOnce()
    expect(mockStopTaxonomyConsumer).toHaveBeenCalledOnce()
  })

  it("does not throw when stopEmbeddingConsumer itself throws — logs and continues", async () => {
    mockStopEmbeddingConsumer.mockImplementationOnce(() => {
      throw new Error("boom")
    })
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})

    await expect(resetProjectState()).resolves.toBeUndefined()
    expect(warnSpy).toHaveBeenCalled()
    expect(mockClearGraphCache).toHaveBeenCalledOnce() // still runs despite sibling failure
    warnSpy.mockRestore()
  })

  it("does not throw when stopTaxonomyConsumer itself throws — logs and continues", async () => {
    mockStopTaxonomyConsumer.mockImplementationOnce(() => {
      throw new Error("boom")
    })
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})

    await expect(resetProjectState()).resolves.toBeUndefined()
    expect(warnSpy).toHaveBeenCalled()
    expect(mockClearGraphCache).toHaveBeenCalledOnce() // still runs despite sibling failure
    expect(mockStopEmbeddingConsumer).toHaveBeenCalledOnce() // still runs despite sibling failure
    warnSpy.mockRestore()
  })

  it("does not throw when pauseQueue itself throws — logs and continues", async () => {
    mockPauseQueue.mockImplementationOnce(async () => {
      throw new Error("boom")
    })
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})

    await expect(resetProjectState()).resolves.toBeUndefined()
    expect(warnSpy).toHaveBeenCalled()
    expect(mockClearGraphCache).toHaveBeenCalledOnce() // still runs despite sibling failure
    warnSpy.mockRestore()
  })

  it("does not throw when clearGraphCache itself throws", async () => {
    mockClearGraphCache.mockImplementationOnce(() => {
      throw new Error("boom")
    })
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})

    await expect(resetProjectState()).resolves.toBeUndefined()
    expect(warnSpy).toHaveBeenCalled()
    warnSpy.mockRestore()
  })
})

describe("resetProjectState — leaves unrelated store keys alone", () => {
  it("preserves maxHistoryMessages on chat store (config, not project data)", async () => {
    useChatStore.setState({ maxHistoryMessages: 42 })
    await resetProjectState()
    expect(useChatStore.getState().maxHistoryMessages).toBe(42)
  })
})

// Silence the "unused import" warning on getQueue (kept for potential future tests).
void getQueue
