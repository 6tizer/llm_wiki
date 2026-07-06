// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  AGENT_DEV_FIXTURE_SCENARIOS,
  runAgentDevFixture,
} from "./agent-dev-fixtures"
import { registerDevFixture } from "./dev-fixtures"
import { computeAgentRewindGateDecision } from "@/lib/agent/agent-rewind-gate"
import { classifyAgentError } from "@/lib/agent/agent-run-state"
import {
  useChatStore,
  type AgentRewindRequestRecord,
  type DisplayMessage,
} from "@/stores/chat-store"
import {
  resetReviewIdCounterForTest,
  useReviewStore,
} from "@/stores/review-store"

function resetChatStore(): void {
  useChatStore.getState().clearAgentPermissionRequests()
  useChatStore.setState({
    conversations: [],
    activeConversationId: null,
    messages: [],
    isStreaming: false,
    streamingConversationId: null,
    streamingAgentMessageId: null,
    streamingContent: "",
    ingestSource: null,
    activeRunModelByConversation: {},
    activeRunProfileByConversation: {},
    maxHistoryMessages: 10,
    activeAgentPermissionRequest: null,
    queuedAgentPermissionRequests: [],
    agentPermissionRequestsByConversation: {},
    agentRewindTargets: {},
    activeAgentRewindRequest: null,
    agentRewindRequestsByConversation: {},
    agentRewindLocks: {},
  })
}

function message(messageId: string | undefined): DisplayMessage {
  const found = useChatStore.getState().messages.find((item) => item.id === messageId)
  if (!found) throw new Error(`message not found: ${messageId}`)
  return found
}

function target(messageId: string | undefined): AgentRewindRequestRecord {
  const found = messageId ? useChatStore.getState().agentRewindTargets[messageId] : undefined
  if (!found) throw new Error(`rewind target not found: ${messageId}`)
  return found
}

function rewindGate(messageId: string | undefined) {
  const state = useChatStore.getState()
  const rewindTarget = target(messageId)
  return computeAgentRewindGateDecision({
    target: rewindTarget,
    conversation: state.conversations.find(
      (conversation) => conversation.id === rewindTarget.conversationId,
    ),
    messages: state.messages,
    isStreaming: state.isStreaming,
    streamingConversationId: state.streamingConversationId,
    rewindLocked: Boolean(state.agentRewindLocks[rewindTarget.conversationId]),
  })
}

beforeEach(() => {
  resetChatStore()
  resetReviewIdCounterForTest()
  useReviewStore.setState({ items: [] })
})

afterEach(() => {
  resetChatStore()
  useReviewStore.setState({ items: [] })
})

describe("agent dev fixtures", () => {
  it("keeps the fixture name list aligned with registered Agent scenarios", () => {
    expect(AGENT_DEV_FIXTURE_SCENARIOS).toEqual([
      "permission",
      "profileUnavailable",
      "modelRejected",
      "resourceLimit",
      "compact",
      "timeline",
      "pendingCorrection",
      "activeRewind",
      "doneRewind",
      "rewindLocked",
      "rewindCrossFork",
      "rewindWikiWrite",
      "agentWriteReview",
    ])
  })

  it("registers named fixtures on window in DEV", () => {
    const fn = () => "ok"
    registerDevFixture("sample", fn)
    expect(window.__llmwiki_fixtures?.sample).toBe(fn)
  })

  it("registers the agent fixture entrypoint on window", async () => {
    await import("./agent-dev-fixtures")
    expect(window.__llmwiki_fixtures?.agent).toBe(runAgentDevFixture)
  })

  it("injects the permission dialog state through requestAgentPermission", () => {
    runAgentDevFixture("permission")

    const state = useChatStore.getState()
    const active = state.activeAgentPermissionRequest
    expect(active).toMatchObject({
      toolName: "mcp__llm_wiki__update_page",
      streamId: "dev-fixture-stream-permission",
    })
    expect(active?.inputPreview.pathBytes).toEqual([
      119, 105, 107, 105, 47, 100, 101, 109, 111, 46, 109, 100,
    ])
    expect(active?.inputPreview.pathSha256).toBe("0".repeat(64))
    expect(
      state.agentPermissionRequestsByConversation[state.activeConversationId ?? ""]?.[0],
    ).toBe(active)
  })

  it("injects profile_unavailable with classifier-recognized detail", () => {
    const result = runAgentDevFixture("profileUnavailable")
    const item = message(result.messageId)

    expect(item).toMatchObject({
      content: "",
      agentErrorKind: "profile_unavailable",
      agentErrorDetail:
        "profile-unavailable: no-eligible-profile: no profile pool capacity is available",
    })
    expect(classifyAgentError(item.agentErrorDetail ?? "")).toBe("profile_unavailable")
    expect(useChatStore.getState().isStreaming).toBe(false)
  })

  it("injects an independent model_not_found error card", () => {
    const result = runAgentDevFixture("modelRejected")

    expect(message(result.messageId)).toMatchObject({
      content: "",
      agentErrorKind: "model_not_found",
      agentErrorDetail: "model not found: Dev QA simulated rejected model.",
    })
    expect(classifyAgentError(message(result.messageId).agentErrorDetail ?? "")).toBe(
      "model_not_found",
    )
    expect(useChatStore.getState().isStreaming).toBe(false)
  })

  it("injects the resource limit card fields through updateAgentStreamMessage", () => {
    const result = runAgentDevFixture("resourceLimit")
    expect(message(result.messageId).agentResourceLimit).toMatchObject({
      kind: "resource_limit",
      limitKind: "max_turns_exceeded",
      recovery: "split_task",
    })
  })

  it("injects the compact marker through updateAgentStreamMessage", () => {
    const result = runAgentDevFixture("compact")
    expect(message(result.messageId).sessionCompact).toBe(true)
  })

  it("injects timeline tool calls, summaries, and permission policy badges", () => {
    const result = runAgentDevFixture("timeline")
    const item = message(result.messageId)
    expect(item.toolCalls?.map((call) => [call.toolUseId, call.phase, call.ok])).toEqual([
      ["tool-pending", "pre", undefined],
      ["tool-done", "post", true],
      ["tool-failed", "failure", false],
    ])
    expect(item.progressSummaries).toHaveLength(2)
    expect(item.permissionEvents?.map((event) => event.permissionPolicy)).toEqual([
      "restricted",
      "bypassPermissions",
    ])
  })

  it("injects the pending-correction resume condition", () => {
    const result = runAgentDevFixture("pendingCorrection")
    const conversation = useChatStore
      .getState()
      .conversations.find((item) => item.id === result.conversationId)
    expect(message(result.messageId).content).toContain("确认执行吗")
    expect(conversation?.agentSessionId).toBe("dev-fixture-session-pending-correction")
    expect(useChatStore.getState().isStreaming).toBe(false)
  })

  it("injects an active rewind target that passes the rewind gate", () => {
    const result = runAgentDevFixture("activeRewind")
    const rewindTarget = target(result.messageId)
    const conversation = useChatStore
      .getState()
      .conversations.find((item) => item.id === result.conversationId)

    expect(rewindTarget).toMatchObject({
      streamId: "dev-fixture-stream-active-rewind",
      agentSessionId: "dev-fixture-session-active-rewind",
      conversationId: result.conversationId,
    })
    expect(rewindTarget.assistantMessageId).toBeUndefined()
    expect(conversation?.agentSessionId).toBe(rewindTarget.agentSessionId)
    expect(useChatStore.getState().isStreaming).toBe(false)
    expect(rewindGate(result.messageId)).toEqual({ allowed: true })
  })

  it("injects a done rewind target and model_not_found error card", () => {
    const result = runAgentDevFixture("doneRewind")
    const rewindTarget = target(result.messageId)
    const item = message(result.messageId)

    expect(rewindTarget.assistantMessageId).toBe("dev-fixture-assistant-done-rewind")
    expect(item).toMatchObject({
      agentErrorKind: "model_not_found",
      agentErrorDetail: "Dev QA simulated model_not_found.",
    })
    expect(rewindGate(result.messageId)).toEqual({ allowed: true })
  })

  it("injects a rewind target blocked by an active rewind lock", () => {
    const result = runAgentDevFixture("rewindLocked")
    const rewindTarget = target(result.messageId)

    expect(rewindTarget).toMatchObject({
      streamId: "dev-fixture-stream-rewind-locked",
      agentSessionId: "dev-fixture-session-rewind-locked",
    })
    expect(useChatStore.getState().agentRewindLocks[result.conversationId]).toBe(true)
    expect(rewindGate(result.messageId)).toEqual({ allowed: false, reason: "locked" })
  })

  it("clears a leftover rewind lock when running the next fixture scenario", () => {
    const locked = runAgentDevFixture("rewindLocked")
    expect(useChatStore.getState().agentRewindLocks[locked.conversationId]).toBe(true)

    const next = runAgentDevFixture("activeRewind")
    expect(next.conversationId).toBe(locked.conversationId)
    expect(useChatStore.getState().agentRewindLocks[locked.conversationId]).toBeFalsy()
    expect(rewindGate(next.messageId)).not.toEqual({ allowed: false, reason: "locked" })
  })

  it("injects a rewind target blocked after a session fork", () => {
    const result = runAgentDevFixture("rewindCrossFork")
    const rewindTarget = target(result.messageId)
    const conversation = useChatStore
      .getState()
      .conversations.find((item) => item.id === result.conversationId)

    expect(rewindTarget.agentSessionId).toBe("dev-fixture-session-rewind-before-fork")
    expect(conversation?.agentSessionId).toBe("dev-fixture-session-rewind-after-fork")
    expect(rewindGate(result.messageId)).toEqual({ allowed: false, reason: "cross_fork" })
  })

  it("injects a rewind target blocked by an uncovered wiki write after target", () => {
    const result = runAgentDevFixture("rewindWikiWrite")
    const laterWrite = useChatStore
      .getState()
      .messages.find((item) =>
        item.toolCalls?.some(
          (call) => call.toolUseId === "dev-fixture-tool-rewind-wiki-write",
        ),
      )

    expect(laterWrite?.id).not.toBe(result.messageId)
    expect(laterWrite?.toolCalls?.[0]).toMatchObject({
      toolName: "mcp__llm_wiki__update_page",
      toolUseId: "dev-fixture-tool-rewind-wiki-write",
      phase: "post",
      ok: true,
    })
    expect(laterWrite?.wikiChanges).toBeUndefined()
    expect(rewindGate(result.messageId)).toEqual({
      allowed: false,
      reason: "wiki_write_after_target",
      detail: "uncovered",
    })
  })

  it("injects agent write review state through appendAgentWikiChange and addItem", () => {
    const result = runAgentDevFixture("agentWriteReview")
    const item = message(result.messageId)
    const review = useReviewStore.getState().items[0]

    expect(item.wikiChanges?.[0]).toMatchObject({
      path: "wiki/entities/demo.md",
      operation: "update",
      toolUseId: "dev-fixture-tool-agent-write",
      snapshotted: false,
    })
    expect(review).toMatchObject({
      type: "agent-write",
      title: "更新 wiki/entities/demo.md",
      agentWrite: {
        path: "wiki/entities/demo.md",
        operation: "update",
        conversationId: result.conversationId,
        messageId: result.messageId,
        streamId: "dev-fixture-stream-agent-write-review",
        snapshotted: false,
      },
    })
    expect(review?.options.map((option) => option.action)).toEqual([
      "open:wiki/entities/demo.md",
      "__agent_write_accept__",
    ])
  })

  it("rejects unknown scenarios", () => {
    expect(() => runAgentDevFixture("unknown")).toThrow(
      "Unknown agent dev fixture scenario: unknown",
    )
  })
})
