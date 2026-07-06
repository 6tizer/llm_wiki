import { beforeEach, describe, expect, it, vi } from "vitest"
import { useChatStore, type AgentRewindRequestRecord, type DisplayMessage } from "@/stores/chat-store"
import type { AgentRewindFilesPayload, AgentTransportOptions } from "./agent-types"

const transportMocks = vi.hoisted(() => ({
  rewindAgentFiles: vi.fn<(streamId: string, messageId?: string) => Promise<AgentRewindFilesPayload>>(),
  rewindAgentSession: vi.fn<
    (
      options: AgentTransportOptions,
      rewindUserMessageId: string,
      fallbackAssistantMessageId?: string,
    ) => Promise<AgentRewindFilesPayload>
  >(),
}))

const persistMocks = vi.hoisted(() => ({
  saveChatHistory: vi.fn(async () => {}),
}))

const restoreMocks = vi.hoisted(() => ({
  restoreAgentWikiSnapshots: vi.fn<() => Promise<{
    ok: boolean
    restoredPaths: string[]
    failures: Array<{ path: string; error: string }>
  }>>(async () => ({ ok: true, restoredPaths: [], failures: [] })),
}))

vi.mock("./agent-transport", () => ({
  rewindAgentFiles: transportMocks.rewindAgentFiles,
  rewindAgentSession: transportMocks.rewindAgentSession,
}))

vi.mock("./agent-wiki-snapshot-restore", () => ({
  restoreAgentWikiSnapshots: restoreMocks.restoreAgentWikiSnapshots,
}))

vi.mock("@/lib/persist", () => ({
  saveChatHistory: persistMocks.saveChatHistory,
}))

import { runAgentRewind } from "./agent-rewind-orchestration"

function msg(id: string, conversationId: string, timestamp: number): DisplayMessage {
  return {
    id,
    role: "assistant",
    content: "",
    timestamp,
    conversationId,
    mode: "agent",
  }
}

function resetStore(): void {
  useChatStore.setState({
    conversations: [],
    messages: [],
    activeConversationId: null,
    isStreaming: false,
    agentRewindTargets: {},
    activeAgentRewindRequest: null,
    agentRewindLocks: {},
  })
}

function target(overrides: Partial<AgentRewindRequestRecord> = {}): AgentRewindRequestRecord {
  return {
    chatMessageId: "m1",
    conversationId: "conv-1",
    streamId: "stream-1",
    agentSessionId: "session-1",
    userMessageId: "user-uuid-1",
    assistantMessageId: "assistant-uuid-1",
    requestedAt: 1,
    ...overrides,
  }
}

const okPayload: AgentRewindFilesPayload = {
  ok: true,
  result: { canRewind: true, filesChanged: ["wiki/page.md"] },
}

describe("runAgentRewind", () => {
  beforeEach(() => {
    resetStore()
    transportMocks.rewindAgentFiles.mockReset()
    transportMocks.rewindAgentSession.mockReset()
    persistMocks.saveChatHistory.mockReset().mockResolvedValue(undefined)
    restoreMocks.restoreAgentWikiSnapshots.mockReset().mockResolvedValue({
      ok: true,
      restoredPaths: [],
      failures: [],
    })
  })

  it("uses the fast path when the stream is still active, truncates the timeline, and force-flushes (A3/A4)", async () => {
    useChatStore.setState({
      conversations: [{ id: "conv-1", title: "Agent", createdAt: 1, updatedAt: 1, agentSessionId: "session-1" }],
      messages: [msg("m1", "conv-1", 1), msg("m2", "conv-1", 2)],
    })
    transportMocks.rewindAgentFiles.mockResolvedValue(okPayload)

    const result = await runAgentRewind({
      target: target(),
      projectPath: "/wiki",
      buildOptions: () => ({ apiKey: "k" }),
    })

    expect(result.status).toBe("success")
    expect(transportMocks.rewindAgentFiles).toHaveBeenCalledWith("stream-1", "user-uuid-1")
    expect(transportMocks.rewindAgentSession).not.toHaveBeenCalled()
    expect(restoreMocks.restoreAgentWikiSnapshots).toHaveBeenCalledWith({
      projectPath: "/wiki",
      target: target(),
      messages: expect.any(Array),
    })
    expect(useChatStore.getState().messages.map((m) => m.id)).toEqual(["m1"])
    const conversation = useChatStore.getState().conversations[0]
    expect(conversation.agentForkSessionPending).toBe(true)
    expect(conversation.agentResumeSessionAt).toBe("assistant-uuid-1")
    expect(persistMocks.saveChatHistory).toHaveBeenCalledWith(
      "/wiki",
      expect.any(Array),
      expect.any(Array),
    )
    // Lock must be released after a successful run.
    expect(useChatStore.getState().agentRewindLocks["conv-1"]).toBeUndefined()
  })

  it("reports wiki_restore_failed and does not apply success when SDK rewind succeeds but wiki restore fails", async () => {
    useChatStore.setState({
      conversations: [{ id: "conv-1", title: "Agent", createdAt: 1, updatedAt: 1, agentSessionId: "session-1" }],
      messages: [msg("m1", "conv-1", 1), msg("m2", "conv-1", 2)],
    })
    transportMocks.rewindAgentFiles.mockResolvedValue(okPayload)
    restoreMocks.restoreAgentWikiSnapshots.mockResolvedValue({
      ok: false,
      restoredPaths: [],
      failures: [{ path: "wiki/a.md", error: "disk full" }],
    })

    const result = await runAgentRewind({
      target: target(),
      projectPath: "/wiki",
      buildOptions: () => ({ apiKey: "k" }),
    })

    expect(result.status).toBe("wiki_restore_failed")
    expect(result.wikiRestoreFailures).toEqual([{ path: "wiki/a.md", error: "disk full" }])
    expect(useChatStore.getState().messages.map((m) => m.id)).toEqual(["m1", "m2"])
    expect(useChatStore.getState().conversations[0].agentForkSessionPending).toBeUndefined()
    expect(persistMocks.saveChatHistory).not.toHaveBeenCalled()
  })

  it("falls back to the resume-only slow path when the fast path throws (turn already ended, fixes #60)", async () => {
    useChatStore.setState({
      conversations: [{ id: "conv-1", title: "Agent", createdAt: 1, updatedAt: 1, agentSessionId: "session-1" }],
      messages: [msg("m1", "conv-1", 1)],
    })
    transportMocks.rewindAgentFiles.mockRejectedValue(new Error("No running agent stream"))
    transportMocks.rewindAgentSession.mockResolvedValue(okPayload)

    const result = await runAgentRewind({
      target: target(),
      projectPath: "/wiki",
      buildOptions: () => ({ apiKey: "k" }),
    })

    expect(result.status).toBe("success")
    expect(transportMocks.rewindAgentSession).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: "conv-1", resume: "session-1" }),
      "user-uuid-1",
      "assistant-uuid-1",
    )
  })

  it("falls back to the slow path when the fast path resolves with any unavailableReason other than missing_message_id", async () => {
    useChatStore.setState({
      conversations: [{ id: "conv-1", title: "Agent", createdAt: 1, updatedAt: 1, agentSessionId: "session-1" }],
      messages: [msg("m1", "conv-1", 1)],
    })
    transportMocks.rewindAgentFiles.mockResolvedValue({
      ok: false,
      unavailableReason: "transport_closed",
    })
    transportMocks.rewindAgentSession.mockResolvedValue(okPayload)

    const result = await runAgentRewind({
      target: target(),
      projectPath: "/wiki",
      buildOptions: () => ({ apiKey: "k" }),
    })

    expect(result.status).toBe("success")
    expect(transportMocks.rewindAgentSession).toHaveBeenCalled()
  })

  it("does not fall back when missing_message_id — both paths would fail identically", async () => {
    useChatStore.setState({
      conversations: [{ id: "conv-1", title: "Agent", createdAt: 1, updatedAt: 1, agentSessionId: "session-1" }],
      messages: [msg("m1", "conv-1", 1)],
    })
    transportMocks.rewindAgentFiles.mockResolvedValue({
      ok: false,
      unavailableReason: "missing_message_id",
    })

    const result = await runAgentRewind({
      target: target(),
      projectPath: "/wiki",
      buildOptions: () => ({ apiKey: "k" }),
    })

    expect(result.status).toBe("rewind_failed")
    expect(transportMocks.rewindAgentSession).not.toHaveBeenCalled()
    // No truncation/pending state applied on failure (A5: no reverse half-state).
    expect(useChatStore.getState().messages).toHaveLength(1)
    expect(useChatStore.getState().conversations[0].agentForkSessionPending).toBeUndefined()
  })

  it("does not truncate or set pending fields when rewindFiles fails on both paths (A5)", async () => {
    useChatStore.setState({
      conversations: [{ id: "conv-1", title: "Agent", createdAt: 1, updatedAt: 1, agentSessionId: "session-1" }],
      messages: [msg("m1", "conv-1", 1)],
    })
    transportMocks.rewindAgentFiles.mockResolvedValue({ ok: false, unavailableReason: "inactive_stream" })
    transportMocks.rewindAgentSession.mockResolvedValue({ ok: false, error: "checkpoint gone" })

    const result = await runAgentRewind({
      target: target(),
      projectPath: "/wiki",
      buildOptions: () => ({ apiKey: "k" }),
    })

    expect(result.status).toBe("rewind_failed")
    expect(persistMocks.saveChatHistory).not.toHaveBeenCalled()
    expect(useChatStore.getState().messages).toHaveLength(1)
  })

  it("reports persist_failed (files already reverted) when the forced flush fails (A4)", async () => {
    useChatStore.setState({
      conversations: [{ id: "conv-1", title: "Agent", createdAt: 1, updatedAt: 1, agentSessionId: "session-1" }],
      messages: [msg("m1", "conv-1", 1)],
    })
    transportMocks.rewindAgentFiles.mockResolvedValue(okPayload)
    persistMocks.saveChatHistory.mockRejectedValue(new Error("disk full"))

    const result = await runAgentRewind({
      target: target(),
      projectPath: "/wiki",
      buildOptions: () => ({ apiKey: "k" }),
    })

    expect(result.status).toBe("persist_failed")
    expect(result.persistError).toBe("disk full")
    // Pending fields/truncation are still applied in memory even though the flush failed.
    expect(useChatStore.getState().conversations[0].agentForkSessionPending).toBe(true)
  })

  it("reports persist_failed when there is no project path to persist to, even though the in-memory rewind succeeded", async () => {
    useChatStore.setState({
      conversations: [{ id: "conv-1", title: "Agent", createdAt: 1, updatedAt: 1, agentSessionId: "session-1" }],
      messages: [msg("m1", "conv-1", 1)],
    })
    transportMocks.rewindAgentFiles.mockResolvedValue(okPayload)

    const result = await runAgentRewind({
      target: target(),
      projectPath: undefined,
      buildOptions: () => ({ apiKey: "k" }),
    })

    expect(result.status).toBe("persist_failed")
    expect(persistMocks.saveChatHistory).not.toHaveBeenCalled()
    expect(useChatStore.getState().conversations[0].agentForkSessionPending).toBe(true)
  })

  it("reports state_mismatch — not success — when rewindFiles succeeds but the target message is gone (review-round P2)", async () => {
    useChatStore.setState({
      conversations: [{ id: "conv-1", title: "Agent", createdAt: 1, updatedAt: 1, agentSessionId: "session-1" }],
      // Target message "m1" is NOT present — simulates the conversation
      // having been reset/changed shape between opening the rewind dialog
      // and the rewindFiles call actually completing.
      messages: [],
    })
    transportMocks.rewindAgentFiles.mockResolvedValue(okPayload)

    const result = await runAgentRewind({
      target: target(),
      projectPath: "/wiki",
      buildOptions: () => ({ apiKey: "k" }),
    })

    expect(result.status).toBe("state_mismatch")
    expect(result.payload).toEqual(okPayload)
    // Must NOT silently persist or report success — nothing to truncate.
    expect(persistMocks.saveChatHistory).not.toHaveBeenCalled()
    expect(useChatStore.getState().conversations[0].agentForkSessionPending).toBeUndefined()
  })

  it("blocks via the gate and never calls rewindFiles when a wiki write landed after the target (A2)", async () => {
    useChatStore.setState({
      conversations: [{ id: "conv-1", title: "Agent", createdAt: 1, updatedAt: 1, agentSessionId: "session-1" }],
      messages: [
        { ...msg("m1", "conv-1", 1) },
        {
          ...msg("m2", "conv-1", 2),
          toolCalls: [{ toolName: "mcp__llm_wiki__update_page", phase: "post", ok: true }],
        },
      ],
    })

    const result = await runAgentRewind({
      target: target(),
      projectPath: "/wiki",
      buildOptions: () => ({ apiKey: "k" }),
    })

    expect(result.status).toBe("gate_blocked")
    expect(result.gate).toEqual({
      allowed: false,
      reason: "wiki_write_after_target",
      detail: "uncovered",
    })
    expect(transportMocks.rewindAgentFiles).not.toHaveBeenCalled()
  })

  it("blocks via the gate when the conversation is mid-rewind already (A6)", async () => {
    useChatStore.setState({
      conversations: [{ id: "conv-1", title: "Agent", createdAt: 1, updatedAt: 1, agentSessionId: "session-1" }],
      messages: [msg("m1", "conv-1", 1)],
      agentRewindLocks: { "conv-1": true },
    })

    const result = await runAgentRewind({
      target: target(),
      projectPath: "/wiki",
      buildOptions: () => ({ apiKey: "k" }),
    })

    expect(result.status).toBe("gate_blocked")
    expect(result.gate).toEqual({ allowed: false, reason: "locked" })
    expect(transportMocks.rewindAgentFiles).not.toHaveBeenCalled()
  })

  it("fails closed when the assistant checkpoint uuid is missing (no fork anchor)", async () => {
    useChatStore.setState({
      conversations: [{ id: "conv-1", title: "Agent", createdAt: 1, updatedAt: 1, agentSessionId: "session-1" }],
      messages: [msg("m1", "conv-1", 1)],
    })

    const result = await runAgentRewind({
      target: target({ assistantMessageId: undefined }),
      projectPath: "/wiki",
      buildOptions: () => ({ apiKey: "k" }),
    })

    expect(result.status).toBe("rewind_failed")
    expect(transportMocks.rewindAgentFiles).not.toHaveBeenCalled()
  })

  it("releases the rewind lock even when the fast and slow paths both throw", async () => {
    useChatStore.setState({
      conversations: [{ id: "conv-1", title: "Agent", createdAt: 1, updatedAt: 1, agentSessionId: "session-1" }],
      messages: [msg("m1", "conv-1", 1)],
    })
    transportMocks.rewindAgentFiles.mockRejectedValue(new Error("dead"))
    transportMocks.rewindAgentSession.mockRejectedValue(new Error("also dead"))

    await expect(
      runAgentRewind({
        target: target(),
        projectPath: "/wiki",
        buildOptions: () => ({ apiKey: "k" }),
      }),
    ).rejects.toThrow("also dead")

    expect(useChatStore.getState().agentRewindLocks["conv-1"]).toBeUndefined()
  })
})
