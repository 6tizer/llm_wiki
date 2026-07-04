import { describe, expect, it } from "vitest"
import type {
  AgentRewindRequestRecord,
  Conversation,
  DisplayMessage,
} from "@/stores/chat-store"
import { computeAgentRewindGateDecision } from "./agent-rewind-gate"

const conversation: Conversation = {
  id: "c1",
  title: "Agent",
  createdAt: 1,
  updatedAt: 1,
  agentSessionId: "session-1",
}

function msg(id: string, timestamp: number, toolCalls?: DisplayMessage["toolCalls"]): DisplayMessage {
  return {
    id,
    role: "assistant",
    content: "",
    timestamp,
    conversationId: "c1",
    mode: "agent",
    toolCalls,
  }
}

function target(overrides: Partial<AgentRewindRequestRecord> = {}): AgentRewindRequestRecord {
  return {
    chatMessageId: "m1",
    conversationId: "c1",
    streamId: "stream-1",
    agentSessionId: "session-1",
    userMessageId: "user-uuid-1",
    assistantMessageId: "assistant-uuid-1",
    requestedAt: 1,
    ...overrides,
  }
}

describe("computeAgentRewindGateDecision", () => {
  it("allows rewind when nothing blocks it", () => {
    const messages = [msg("m1", 1)]
    expect(
      computeAgentRewindGateDecision({
        target: target(),
        conversation,
        messages,
        isStreaming: false,
        rewindLocked: false,
      })
    ).toEqual({ allowed: true })
  })

  it("blocks when a wiki write tool call lands on the target message itself (A2/A17)", () => {
    const messages = [
      msg("m1", 1, [
        { toolName: "mcp__llm_wiki__update_page", phase: "post", ok: true },
      ]),
    ]
    expect(
      computeAgentRewindGateDecision({
        target: target(),
        conversation,
        messages,
        isStreaming: false,
        rewindLocked: false,
      })
    ).toEqual({ allowed: false, reason: "wiki_write_after_target" })
  })

  it("blocks when a wiki write tool call lands on a LATER message (A2)", () => {
    const messages = [
      msg("m1", 1),
      msg("m2", 2, [
        { toolName: "mcp__llm_wiki__create_entity", phase: "post", ok: true },
      ]),
    ]
    expect(
      computeAgentRewindGateDecision({
        target: target(),
        conversation,
        messages,
        isStreaming: false,
        rewindLocked: false,
      })
    ).toEqual({ allowed: false, reason: "wiki_write_after_target" })
  })

  it("allows rewind when the only wiki tool calls are read-only", () => {
    const messages = [
      msg("m1", 1, [
        { toolName: "mcp__llm_wiki__read_page", phase: "post", ok: true },
      ]),
      msg("m2", 2, [
        { toolName: "mcp__llm_wiki__search_pages", phase: "post", ok: true },
      ]),
    ]
    expect(
      computeAgentRewindGateDecision({
        target: target(),
        conversation,
        messages,
        isStreaming: false,
        rewindLocked: false,
      })
    ).toEqual({ allowed: true })
  })

  it("blocks on conditional-write tools regardless of args classification (A17)", () => {
    const messages = [
      msg("m1", 1, [
        {
          toolName: "mcp__llm_wiki__merge_duplicate_group",
          phase: "post",
          ok: true,
          inputPreview: { dryRun: true },
        },
      ]),
    ]
    expect(
      computeAgentRewindGateDecision({
        target: target(),
        conversation,
        messages,
        isStreaming: false,
        rewindLocked: false,
      })
    ).toEqual({ allowed: false, reason: "wiki_write_after_target" })
  })

  it("ignores wiki writes BEFORE the target message", () => {
    const messages = [
      msg("m0", 0, [
        { toolName: "mcp__llm_wiki__update_page", phase: "post", ok: true },
      ]),
      msg("m1", 1),
    ]
    expect(
      computeAgentRewindGateDecision({
        target: target(),
        conversation,
        messages,
        isStreaming: false,
        rewindLocked: false,
      })
    ).toEqual({ allowed: true })
  })

  it("blocks cross-fork targets whose session no longer matches the conversation's current session (A9)", () => {
    const messages = [msg("m1", 1)]
    expect(
      computeAgentRewindGateDecision({
        target: target({ agentSessionId: "session-OLD" }),
        conversation,
        messages,
        isStreaming: false,
        rewindLocked: false,
      })
    ).toEqual({ allowed: false, reason: "cross_fork" })
  })

  it("blocks when the conversation cannot be found (deleted/switched away)", () => {
    expect(
      computeAgentRewindGateDecision({
        target: target(),
        conversation: undefined,
        messages: [msg("m1", 1)],
        isStreaming: false,
        rewindLocked: false,
      })
    ).toEqual({ allowed: false, reason: "cross_fork" })
  })

  it("blocks while a rewind is already in progress for this conversation (A6)", () => {
    expect(
      computeAgentRewindGateDecision({
        target: target(),
        conversation,
        messages: [msg("m1", 1)],
        isStreaming: false,
        rewindLocked: true,
      })
    ).toEqual({ allowed: false, reason: "locked" })
  })

  it("locks only for rewind lock or a stream in the target conversation", () => {
    const cases = [
      { isStreaming: false, streamingConversationId: null, rewindLocked: false, allowed: true },
      { isStreaming: false, streamingConversationId: "c1", rewindLocked: false, allowed: true },
      { isStreaming: false, streamingConversationId: "c2", rewindLocked: false, allowed: true },
      { isStreaming: true, streamingConversationId: null, rewindLocked: false, allowed: true },
      { isStreaming: true, streamingConversationId: "c2", rewindLocked: false, allowed: true },
      { isStreaming: true, streamingConversationId: "c1", rewindLocked: false, allowed: false },
      { isStreaming: false, streamingConversationId: null, rewindLocked: true, allowed: false },
      { isStreaming: true, streamingConversationId: "c2", rewindLocked: true, allowed: false },
    ]

    for (const testCase of cases) {
      const decision = computeAgentRewindGateDecision({
        target: target(),
        conversation,
        messages: [msg("m1", 1)],
        isStreaming: testCase.isStreaming,
        streamingConversationId: testCase.streamingConversationId,
        rewindLocked: testCase.rewindLocked,
      })

      expect(decision, JSON.stringify(testCase)).toEqual(
        testCase.allowed ? { allowed: true } : { allowed: false, reason: "locked" }
      )
    }
  })
})
