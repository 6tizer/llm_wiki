import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { chatMessagesToLLM, useChatStore, type DisplayMessage } from "./chat-store"

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

function makeAssistantMessage(id: string, conversationId: string): DisplayMessage {
  return {
    id,
    role: "assistant",
    content: "working",
    timestamp: 0,
    conversationId,
    mode: "agent",
  }
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve()
}

describe("chat store agent data model", () => {
  beforeEach(() => {
    resetChatStore()
  })

  afterEach(() => {
    vi.useRealTimers()
    resetChatStore()
  })

  it("keeps addMessage backward compatible for ordinary messages", () => {
    const convId = useChatStore.getState().createConversation()

    useChatStore.getState().addMessage("user", "hello")

    expect(useChatStore.getState().messages).toMatchObject([
      {
        role: "user",
        content: "hello",
        conversationId: convId,
      },
    ])
    expect(useChatStore.getState().messages[0].mode).toBeUndefined()
  })

  it("stores images only for user messages", () => {
    useChatStore.getState().createConversation()
    const image = { mediaType: "image/png", dataBase64: "AAAA" }

    useChatStore.getState().addMessage("user", "look", { images: [image] })
    useChatStore.getState().addMessage("assistant", "assistant", {
      images: [image],
    })

    const messages = useChatStore.getState().messages
    expect(messages[0].images).toEqual([image])
    expect(messages[1].images).toBeUndefined()
  })

  it("stores Chat Router options only for user messages", () => {
    useChatStore.getState().createConversation()
    const chatOptions = {
      useWebSearch: true,
      useAnyTxtSearch: true,
    }

    useChatStore.getState().addMessage("user", "chat", { chatOptions })
    useChatStore.getState().addMessage("assistant", "assistant", {
      chatOptions,
    })

    const messages = useChatStore.getState().messages
    expect(messages[0].chatOptions).toEqual(chatOptions)
    expect(messages[1].chatOptions).toBeUndefined()
  })

  it("stores agent metadata when addMessage receives options", () => {
    const convId = useChatStore.getState().createConversation()

    useChatStore.getState().addMessage("user", "run task", {
      agentSessionId: "session-1",
    })

    expect(useChatStore.getState().messages[0]).toMatchObject({
      role: "user",
      content: "run task",
      conversationId: convId,
      agentSessionId: "session-1",
    })
    expect(useChatStore.getState().messages[0].mode).toBeUndefined()
  })

	  it("keeps finalizeStream ordinary assistant output free of agent metadata", () => {
    useChatStore.getState().createConversation()
    useChatStore.setState({ isStreaming: true, streamingContent: "partial" })

    useChatStore.getState().finalizeStream("done")

    const message = useChatStore.getState().messages[0]
    expect(message).toMatchObject({
      role: "assistant",
      content: "done",
    })
    expect(message.mode).toBeUndefined()
	    expect(message.agentSessionId).toBeUndefined()
	    expect(message.agentErrorKind).toBeUndefined()
	    expect(message.costUsd).toBeUndefined()
    expect(useChatStore.getState().isStreaming).toBe(false)
    expect(useChatStore.getState().streamingContent).toBe("")
  })

  it("finalizeStream binds the message to the conversation that started the stream, not the live active one (P1-6)", () => {
    // P1-6: finalizeStream previously read the live activeConversationId at
    // onDone time. If the user switched conversations mid-stream, the
    // assistant reply was injected into the wrong conversation. The new
    // optional conversationId param binds it to the stream's owner.
    const convA = useChatStore.getState().createConversation()
    const convB = useChatStore.getState().createConversation()
    // Stream started in convA (captured), but by onDone the user has
    // switched active to convB.
    useChatStore.setState({
      isStreaming: true,
      streamingContent: "partial",
      activeConversationId: convB,
    })

    useChatStore.getState().finalizeStream("done", undefined, convA)

    const state = useChatStore.getState()
    const message = state.messages[0]
    // Lands in convA (the stream owner), NOT convB (the live active).
    // This is the core P1-6 fix: the reply goes to the conversation that
    // owned the stream, not the one the user switched to.
    expect(message.conversationId).toBe(convA)
    expect(message.content).toBe("done")
    // No message was created in convB.
    expect(state.messages.filter((m) => m.conversationId === convB)).toHaveLength(0)
  })

  it("finalizeStream falls back to the live activeConversationId when no conversationId is passed", () => {
    // Backward compat: callers that don't pass the new arg keep the old
    // behavior (live activeConversationId).
    const convA = useChatStore.getState().createConversation()
    useChatStore.setState({ isStreaming: true, streamingContent: "p", activeConversationId: convA })

    useChatStore.getState().finalizeStream("done")

    expect(useChatStore.getState().messages[0].conversationId).toBe(convA)
  })

  it("finalizeAgentStream stores stats and updates conversation session", () => {
    const convId = useChatStore.getState().createConversation()
    useChatStore.setState({ isStreaming: true, streamingContent: "partial" })

    useChatStore.getState().finalizeAgentStream("agent done", {
      agentSessionId: "agent-session-1",
      costUsd: 0.12,
      inputTokens: 100,
      outputTokens: 40,
      durationMs: 2500,
      numTurns: 3,
    })

    expect(useChatStore.getState().messages[0]).toMatchObject({
      role: "assistant",
      content: "agent done",
      conversationId: convId,
      agentSessionId: "agent-session-1",
      costUsd: 0.12,
      inputTokens: 100,
      outputTokens: 40,
      durationMs: 2500,
      numTurns: 3,
    })
    expect(useChatStore.getState().conversations[0].agentSessionId).toBe("agent-session-1")
    expect(useChatStore.getState().isStreaming).toBe(false)
    expect(useChatStore.getState().streamingContent).toBe("")
    expect(useChatStore.getState().messages[0].mode).toBeUndefined()
  })

  it("forks only conversations with an agent session and marks fork pending", () => {
    const convId = useChatStore.getState().createConversation()
    expect(useChatStore.getState().forkAgentConversation(convId)).toBeNull()
    useChatStore.setState({
      conversations: [
        {
          id: convId,
          title: "Agent work",
          createdAt: 0,
          updatedAt: 1,
          agentSessionId: "session-1",
        },
      ],
      activeConversationId: convId,
    })

    const forkId = useChatStore.getState().forkAgentConversation(convId)

    expect(forkId).toEqual(expect.any(String))
    const fork = useChatStore.getState().conversations.find((conv) => conv.id === forkId)
    expect(fork).toMatchObject({
      agentSessionId: "session-1",
      agentForkSessionPending: true,
    })
    expect(useChatStore.getState().activeConversationId).toBe(forkId)
  })

  it("inherits conversation-level agent overrides when forking", () => {
    const convId = useChatStore.getState().createConversation()
    useChatStore.setState({
      conversations: [
        {
          id: convId,
          title: "Agent work",
          createdAt: 0,
          updatedAt: 1,
          agentSessionId: "session-1",
          agentProfileIdOverride: "profile-agent",
          agentPermissionPolicyOverride: "bypassPermissions",
        },
      ],
      activeConversationId: convId,
    })

    const forkId = useChatStore.getState().forkAgentConversation(convId)

    const fork = useChatStore.getState().conversations.find((conv) => conv.id === forkId)
    expect(fork).toMatchObject({
      agentProfileIdOverride: "profile-agent",
      agentPermissionPolicyOverride: "bypassPermissions",
    })
  })

  it("clears an inherited fork permission override when following the global default", () => {
    const convId = useChatStore.getState().createConversation()
    useChatStore.setState({
      conversations: [
        {
          id: convId,
          title: "Agent work",
          createdAt: 0,
          updatedAt: 1,
          agentSessionId: "session-1",
          agentPermissionPolicyOverride: "restricted",
        },
      ],
      activeConversationId: convId,
    })

    const forkId = useChatStore.getState().forkAgentConversation(convId)
    if (!forkId) throw new Error("expected fork id")

    useChatStore
      .getState()
      .setConversationAgentPermissionPolicyOverride(forkId, undefined)

    const fork = useChatStore.getState().conversations.find((conv) => conv.id === forkId)
    expect(fork?.agentPermissionPolicyOverride).toBeUndefined()
  })

  it("does not add agent overrides when forking a conversation without them", () => {
    const convId = useChatStore.getState().createConversation()
    useChatStore.setState({
      conversations: [
        {
          id: convId,
          title: "Agent work",
          createdAt: 0,
          updatedAt: 1,
          agentSessionId: "session-1",
        },
      ],
      activeConversationId: convId,
    })

    const forkId = useChatStore.getState().forkAgentConversation(convId)

    const fork = useChatStore.getState().conversations.find((conv) => conv.id === forkId)
    expect(fork?.agentProfileIdOverride).toBeUndefined()
    expect(fork?.agentPermissionPolicyOverride).toBeUndefined()
  })

  it("starts an agent stream placeholder message and returns its id", () => {
    const convId = useChatStore.getState().createConversation()

    const messageId = useChatStore.getState().startAgentStreamMessage({
      agentSessionId: "session-1",
    })

    expect(messageId).toEqual(expect.any(String))
    expect(useChatStore.getState().messages[0]).toMatchObject({
      id: messageId,
      role: "assistant",
      content: "",
      conversationId: convId,
      agentSessionId: "session-1",
    })
    expect(useChatStore.getState().messages[0].mode).toBeUndefined()
    expect(useChatStore.getState().isStreaming).toBe(true)
    expect(useChatStore.getState().streamingContent).toBe("")
  })

  it("tracks active run model per conversation", () => {
    const convId = useChatStore.getState().createConversation()
    const messageId = useChatStore.getState().startAgentStreamMessage()
    if (!messageId) throw new Error("expected agent message")

    expect(useChatStore.getState().activeRunModelByConversation[convId]).toBeNull()

    useChatStore.getState().setActiveRunModel(convId, "claude-test")

    expect(useChatStore.getState().activeRunModelByConversation[convId]).toBe("claude-test")

    useChatStore.getState().finishAgentStreamMessage(messageId, "done")

    expect(useChatStore.getState().activeRunModelByConversation[convId]).toBeNull()
  })

  it("tracks active resolved profile per conversation and clears it when the stream finishes", () => {
    const convId = useChatStore.getState().createConversation()
    const messageId = useChatStore.getState().startAgentStreamMessage()
    if (!messageId) throw new Error("expected agent message")

    expect(useChatStore.getState().activeRunProfileByConversation[convId]).toBeNull()

    useChatStore.getState().setActiveRunProfile(convId, {
      profileId: "profile-agent",
      claimId: "claim-agent",
      agentSdkModelId: "claude-runtime",
      authStyle: "x-api-key",
      endpoint: "https://agent.example/v1",
    })

    expect(useChatStore.getState().activeRunProfileByConversation[convId]).toMatchObject({
      profileId: "profile-agent",
      agentSdkModelId: "claude-runtime",
    })

    useChatStore.getState().finishAgentStreamMessage(messageId, "done")

    expect(useChatStore.getState().activeRunProfileByConversation[convId]).toBeNull()
  })

  it("persists normalized conversation-level agent overrides", () => {
    const convId = useChatStore.getState().createConversation()

    useChatStore.getState().setConversationAgentProfileOverride(convId, " profile-agent ")
    useChatStore.getState().setConversationAgentPermissionPolicyOverride(
      convId,
      "bypassPermissions",
    )

    expect(useChatStore.getState().conversations[0]).toMatchObject({
      agentProfileIdOverride: "profile-agent",
      agentPermissionPolicyOverride: "bypassPermissions",
    })

    useChatStore.getState().setConversationAgentProfileOverride(convId, undefined)
    useChatStore.getState().setConversationAgentPermissionPolicyOverride(
      convId,
      "default",
    )

    expect(useChatStore.getState().conversations[0].agentProfileIdOverride).toBeUndefined()
    expect(
      useChatStore.getState().conversations[0].agentPermissionPolicyOverride,
    ).toBeUndefined()

    useChatStore.getState().setConversationAgentPermissionPolicyOverride(
      convId,
      "bypass" as never,
    )

    expect(
      useChatStore.getState().conversations[0].agentPermissionPolicyOverride,
    ).toBeUndefined()
  })

  it("normalizes legacy conversations loaded without override fields", () => {
    useChatStore.getState().setConversations([
      {
        id: "conv-1",
        title: "Legacy",
        createdAt: 1,
        updatedAt: 1,
        agentPermissionPolicyOverride: "auto" as never,
      },
    ])

    expect(useChatStore.getState().conversations[0]).toMatchObject({
      id: "conv-1",
      title: "Legacy",
    })
    expect(
      useChatStore.getState().conversations[0].agentPermissionPolicyOverride,
    ).toBeUndefined()
  })

  it("updates one agent stream message without touching other messages", () => {
    const convId = useChatStore.getState().createConversation()
    useChatStore.setState({
      messages: [
        makeAssistantMessage("m1", convId),
        makeAssistantMessage("m2", convId),
      ],
    })

    useChatStore.getState().updateAgentStreamMessage("m1", {
      content: "partial",
      sessionCompact: true,
      agentResourceLimit: {
        kind: "resource_limit",
        limitKind: "max_files_changed",
        limit: 1,
        used: 1,
        attempted: 2,
        changedPaths: ["wiki/index.md"],
        message: "Write would exceed maxFilesChanged (1)",
        recovery: "split_task",
      },
      agentBlocks: [
        { type: "text", text: "partial" },
      ],
    })

    expect(useChatStore.getState().messages[0]).toMatchObject({
      id: "m1",
      content: "partial",
      sessionCompact: true,
      agentResourceLimit: {
        kind: "resource_limit",
        limitKind: "max_files_changed",
        limit: 1,
        used: 1,
        attempted: 2,
        changedPaths: ["wiki/index.md"],
        message: "Write would exceed maxFilesChanged (1)",
        recovery: "split_task",
      },
      agentBlocks: [
        { type: "text", text: "partial" },
      ],
    })
    expect(useChatStore.getState().messages[1]).toMatchObject({
      id: "m2",
      content: "working",
    })
  })

  it("finishes an existing agent stream message with stats and session", () => {
    const convId = useChatStore.getState().createConversation()
    useChatStore.setState({
      isStreaming: true,
      streamingContent: "partial",
      messages: [makeAssistantMessage("m1", convId)],
    })

    useChatStore.getState().finishAgentStreamMessage("m1", "done", {
      agentSessionId: "session-2",
      costUsd: 0.2,
      inputTokens: 12,
      outputTokens: 8,
      durationMs: 900,
      numTurns: 2,
    })

    expect(useChatStore.getState().messages[0]).toMatchObject({
      id: "m1",
      content: "done",
      mode: "agent",
      agentSessionId: "session-2",
      costUsd: 0.2,
      inputTokens: 12,
      outputTokens: 8,
      durationMs: 900,
      numTurns: 2,
    })
    expect(useChatStore.getState().conversations[0]).toMatchObject({
      id: convId,
      agentSessionId: "session-2",
    })
    expect(useChatStore.getState().isStreaming).toBe(false)
    expect(useChatStore.getState().streamingContent).toBe("")
  })

  it("finishes an agent stream message with optional error metadata", () => {
    const convId = useChatStore.getState().createConversation()
    useChatStore.setState({
      isStreaming: true,
      streamingContent: "partial",
      messages: [makeAssistantMessage("m1", convId)],
    })

    useChatStore.getState().finishAgentStreamMessage("m1", "Agent timed out", undefined, {
      agentErrorKind: "timeout",
    })

    expect(useChatStore.getState().messages[0]).toMatchObject({
      id: "m1",
      content: "",
      mode: "agent",
      agentErrorKind: "timeout",
    })
    expect(useChatStore.getState().isStreaming).toBe(false)
    expect(useChatStore.getState().streamingContent).toBe("")
  })

  it("preserves resource limit notice when a later error finishes the agent message", () => {
    const convId = useChatStore.getState().createConversation()
    useChatStore.setState({
      isStreaming: true,
      streamingContent: "",
      messages: [makeAssistantMessage("m1", convId)],
    })

    useChatStore.getState().updateAgentStreamMessage("m1", {
      agentResourceLimit: {
        kind: "resource_limit",
        limitKind: "max_turns_exceeded",
        limit: 10,
        used: 10,
        attempted: 10,
        message: "Reached maximum number of turns (10)",
        recovery: "settings_agent",
      },
    })
    useChatStore.getState().finishAgentStreamMessage(
      "m1",
      "Agent reached the max turn limit.",
      undefined,
      { agentErrorKind: "max_turns_exceeded" },
    )

    expect(useChatStore.getState().messages[0]).toMatchObject({
      id: "m1",
      content: "",
      agentErrorKind: "max_turns_exceeded",
      agentResourceLimit: {
        kind: "resource_limit",
        limitKind: "max_turns_exceeded",
        limit: 10,
        used: 10,
        attempted: 10,
      },
    })
  })

  it("clears fork pending and resumeSessionAt when an agent stream returns a new session (SPEC-7 PR2 A14)", () => {
    const convId = useChatStore.getState().createConversation()
    useChatStore.setState({
      isStreaming: true,
      streamingContent: "partial",
      conversations: [
        {
          id: convId,
          title: "Fork",
          createdAt: 0,
          updatedAt: 1,
          agentSessionId: "old-session",
          agentForkSessionPending: true,
          agentResumeSessionAt: "assistant-uuid-1",
        },
      ],
      activeConversationId: convId,
      messages: [makeAssistantMessage("m1", convId)],
    })

    useChatStore.getState().finishAgentStreamMessage("m1", "done", {
      agentSessionId: "new-session",
    })

    expect(useChatStore.getState().conversations[0]).toMatchObject({
      agentSessionId: "new-session",
    })
    expect(useChatStore.getState().conversations[0].agentForkSessionPending).toBeUndefined()
    expect(useChatStore.getState().conversations[0].agentResumeSessionAt).toBeUndefined()
  })

  it("finishAgentStreamMessage updates the message's conversation, not the live active one (P1-6)", () => {
    // P1-6: Codex review P2: the agent stream's conversation metadata
    // (agentSessionId / agentForkSessionPending / updatedAt) must update
    // the conversation the agent MESSAGE belongs to, not the live
    // activeConversationId. Switching conversations mid-agent-stream
    // previously corrupted the wrong conversation's agent session.
    const convA = useChatStore.getState().createConversation()
    const convB = useChatStore.getState().createConversation()
    // The agent message was created in convA; user has since switched to
    // convB (the live active).
    useChatStore.setState({
      conversations: [
        { id: convA, title: "A", createdAt: 0, updatedAt: 1 },
        { id: convB, title: "B", createdAt: 0, updatedAt: 1 },
      ],
      activeConversationId: convB,
      messages: [makeAssistantMessage("m1", convA)],
    })

    useChatStore.getState().finishAgentStreamMessage("m1", "agent done", {
      agentSessionId: "session-A",
    })

    // The agent session lands on convA (the message owner), NOT convB.
    const a = useChatStore.getState().conversations.find((c) => c.id === convA)!
    const b = useChatStore.getState().conversations.find((c) => c.id === convB)!
    expect(a.agentSessionId).toBe("session-A")
    expect(b.agentSessionId).toBeUndefined()
    // The message content + stats are keyed by messageId, so always correct.
    expect(useChatStore.getState().messages[0]).toMatchObject({
      id: "m1",
      content: "agent done",
      agentSessionId: "session-A",
      conversationId: convA,
    })
  })

  it("ignores a stale agent finish when a newer run is already streaming in the same conversation", () => {
    const convId = useChatStore.getState().createConversation()
    const oldMessageId = useChatStore.getState().startAgentStreamMessage()
    const newMessageId = useChatStore.getState().startAgentStreamMessage()
    if (!oldMessageId || !newMessageId) throw new Error("expected agent messages")

    expect(useChatStore.getState().streamingAgentMessageId).toBe(newMessageId)

    useChatStore.getState().finishAgentStreamMessage(oldMessageId, "old done")

    expect(useChatStore.getState().isStreaming).toBe(true)
    expect(useChatStore.getState().streamingConversationId).toBe(convId)
    expect(useChatStore.getState().streamingAgentMessageId).toBe(newMessageId)
    expect(
      useChatStore.getState().messages.find((message) => message.id === oldMessageId)?.content
    ).toBe("old done")
  })

  it("setStreaming keeps streaming conversation and agent message ids in sync", () => {
    const convId = useChatStore.getState().createConversation()
    const messageId = useChatStore.getState().startAgentStreamMessage()
    if (!messageId) throw new Error("expected agent message")

    expect(useChatStore.getState().isStreaming).toBe(true)
    expect(useChatStore.getState().streamingConversationId).toBe(convId)
    expect(useChatStore.getState().streamingAgentMessageId).toBe(messageId)

    useChatStore.getState().setStreaming(false)

    expect(useChatStore.getState().isStreaming).toBe(false)
    expect(useChatStore.getState().streamingConversationId).toBeNull()
    expect(useChatStore.getState().streamingAgentMessageId).toBeNull()
  })

  it("updateAgentProgress upserts by toolUseId and overwrites status fields", () => {
    const convId = useChatStore.getState().createConversation()
    useChatStore.setState({
      messages: [makeAssistantMessage("m1", convId)],
    })

    useChatStore.getState().updateAgentProgress("m1", {
      toolName: "wiki_read",
      toolUseId: "tool-1",
      phase: "pre",
      inputPreview: { path: "wiki/index.md" },
    })
    useChatStore.getState().updateAgentProgress("m1", {
      toolName: "wiki_read",
      toolUseId: "tool-1",
      phase: "post",
      ok: true,
      durationMs: 25,
    })

    expect(useChatStore.getState().messages[0].toolCalls).toEqual([
      {
        toolName: "wiki_read",
        toolUseId: "tool-1",
        phase: "post",
        inputPreview: { path: "wiki/index.md" },
        ok: true,
        durationMs: 25,
      },
    ])
  })

  it("updateAgentProgress falls back to toolName when toolUseId is missing", () => {
    const convId = useChatStore.getState().createConversation()
    useChatStore.setState({
      messages: [makeAssistantMessage("m1", convId)],
    })

    useChatStore.getState().updateAgentProgress("m1", {
      toolName: "wiki_search",
      phase: "pre",
    })
    useChatStore.getState().updateAgentProgress("m1", {
      toolName: "wiki_search",
      phase: "failure",
      error: "boom",
    })

    expect(useChatStore.getState().messages[0].toolCalls).toEqual([
      {
        toolName: "wiki_search",
        phase: "failure",
        ok: false,
        error: "boom",
      },
    ])
  })

  it("appends agent progress summaries to one message only", () => {
    const convId = useChatStore.getState().createConversation()
    useChatStore.setState({
      messages: [
        makeAssistantMessage("m1", convId),
        makeAssistantMessage("m2", convId),
      ],
    })

    useChatStore.getState().appendAgentProgressSummary("m1", {
      text: "Analyzing authentication module",
      timestamp: 123,
    })

    expect(useChatStore.getState().messages[0].progressSummaries).toEqual([
      {
        text: "Analyzing authentication module",
        timestamp: 123,
      },
    ])
    expect(useChatStore.getState().messages[1].progressSummaries).toBeUndefined()
  })

  it("appends redacted agent permission events to one message only", () => {
    const convId = useChatStore.getState().createConversation()
    useChatStore.setState({
      messages: [
        makeAssistantMessage("m1", convId),
        makeAssistantMessage("m2", convId),
      ],
    })

    useChatStore.getState().appendAgentPermissionEvent("m1", {
      toolName: "wiki_write",
      decision: "deny_interrupt",
      timestamp: 456,
      permissionPolicy: "restricted",
    })

    expect(useChatStore.getState().messages[0].permissionEvents).toEqual([
      {
        toolName: "wiki_write",
        decision: "deny_interrupt",
        timestamp: 456,
        permissionPolicy: "restricted",
      },
    ])
    expect(useChatStore.getState().messages[1].permissionEvents).toBeUndefined()
  })

  it("appends wiki changes to one agent message only", () => {
    const convId = useChatStore.getState().createConversation()
    useChatStore.setState({
      messages: [
        makeAssistantMessage("m1", convId),
        makeAssistantMessage("m2", convId),
      ],
    })

    useChatStore.getState().appendAgentWikiChange("m1", {
      path: "wiki/page.md",
      operation: "update",
      oldSha256: "old",
      newSha256: "new",
    })

    expect(useChatStore.getState().messages[0].wikiChanges).toMatchObject([
      {
        path: "wiki/page.md",
        operation: "update",
        oldSha256: "old",
        newSha256: "new",
      },
    ])
    expect(useChatStore.getState().messages[1].wikiChanges).toBeUndefined()
  })

  it("marks one agent wiki change as reverted by message, path, and toolUseId", () => {
    const convId = useChatStore.getState().createConversation()
    useChatStore.setState({
      messages: [
        {
          ...makeAssistantMessage("m1", convId),
          wikiChanges: [
            {
              path: "wiki/page.md",
              operation: "update",
              timestamp: 1,
              toolUseId: "tool-1",
              snapshotted: true,
            },
            {
              path: "wiki/page.md",
              operation: "update",
              timestamp: 2,
              toolUseId: "tool-2",
              snapshotted: true,
            },
          ],
        },
      ],
    })

    useChatStore.getState().markAgentWikiChangeReverted({
      messageId: "m1",
      path: "wiki/page.md",
      toolUseId: "tool-2",
    })

    const changes = useChatStore.getState().messages[0].wikiChanges
    expect(changes?.[0]?.toolUseId).toBe("tool-1")
    expect(changes?.[0]?.reverted).toBeUndefined()
    expect(changes?.[1]?.toolUseId).toBe("tool-2")
    expect(changes?.[1]?.reverted).toBe(true)
  })

  it("marks an agent message rewindable with runtime-only stream data", () => {
    const convId = useChatStore.getState().createConversation()
    useChatStore.setState({
      messages: [makeAssistantMessage("m1", convId)],
    })

    useChatStore.getState().markAgentMessageRewindable("m1", {
      streamId: "stream-1",
      userMessageId: "user-sdk-1",
      assistantMessageId: "assistant-sdk-1",
    })
    useChatStore.getState().requestAgentRewind("m1")

    expect(useChatStore.getState().messages[0]).toMatchObject({
      agentUserMessageId: "user-sdk-1",
      agentAssistantMessageId: "assistant-sdk-1",
    })
    expect(useChatStore.getState().activeAgentRewindRequest).toMatchObject({
      chatMessageId: "m1",
      streamId: "stream-1",
      userMessageId: "user-sdk-1",
      assistantMessageId: "assistant-sdk-1",
    })
  })

  it("clears an agent rewind target without removing message metadata", () => {
    const convId = useChatStore.getState().createConversation()
    useChatStore.setState({
      messages: [makeAssistantMessage("m1", convId)],
    })

    useChatStore.getState().markAgentMessageRewindable("m1", {
      streamId: "stream-1",
      userMessageId: "user-sdk-1",
      assistantMessageId: "assistant-sdk-1",
    })
    useChatStore.getState().clearAgentMessageRewindable("m1")

    expect(useChatStore.getState().agentRewindTargets.m1).toBeUndefined()
    expect(useChatStore.getState().messages[0]).toMatchObject({
      agentUserMessageId: "user-sdk-1",
      agentAssistantMessageId: "assistant-sdk-1",
    })
  })

  it("closes the active rewind request when clearing the same message target", () => {
    const convId = useChatStore.getState().createConversation()
    useChatStore.setState({
      messages: [makeAssistantMessage("m1", convId), makeAssistantMessage("m2", convId)],
    })

    useChatStore.getState().markAgentMessageRewindable("m1", {
      streamId: "stream-1",
      userMessageId: "user-sdk-1",
    })
    useChatStore.getState().markAgentMessageRewindable("m2", {
      streamId: "stream-2",
      userMessageId: "user-sdk-2",
    })
    useChatStore.getState().requestAgentRewind("m1")
    useChatStore.getState().clearAgentMessageRewindable("m1")

    expect(useChatStore.getState().activeAgentRewindRequest).toBeNull()
    expect(useChatStore.getState().agentRewindTargets.m1).toBeUndefined()
    expect(useChatStore.getState().agentRewindTargets.m2).toMatchObject({
      streamId: "stream-2",
      userMessageId: "user-sdk-2",
    })
  })

  it("can clear a rewind target while keeping the active rewind request open", () => {
    const convId = useChatStore.getState().createConversation()
    useChatStore.setState({
      messages: [makeAssistantMessage("m1", convId)],
    })

    useChatStore.getState().markAgentMessageRewindable("m1", {
      streamId: "stream-1",
      userMessageId: "user-sdk-1",
    })
    useChatStore.getState().requestAgentRewind("m1")
    useChatStore.getState().clearAgentMessageRewindable("m1", {
      keepActiveRequest: true,
    })

    expect(useChatStore.getState().agentRewindTargets.m1).toBeUndefined()
    expect(useChatStore.getState().activeAgentRewindRequest).toMatchObject({
      chatMessageId: "m1",
      streamId: "stream-1",
      userMessageId: "user-sdk-1",
    })
  })

  it("captures conversationId and agentSessionId on the rewind target (SPEC-7 PR2 A9/A12)", () => {
    const convId = useChatStore.getState().createConversation()
    useChatStore.setState({
      messages: [makeAssistantMessage("m1", convId)],
    })

    useChatStore.getState().markAgentMessageRewindable("m1", {
      streamId: "stream-1",
      agentSessionId: "session-1",
      userMessageId: "user-sdk-1",
      assistantMessageId: "assistant-sdk-1",
    })

    expect(useChatStore.getState().agentRewindTargets.m1).toMatchObject({
      conversationId: convId,
      agentSessionId: "session-1",
    })
  })

  it("keeps the previously captured agentSessionId when a later patch omits it", () => {
    const convId = useChatStore.getState().createConversation()
    useChatStore.setState({
      messages: [makeAssistantMessage("m1", convId)],
    })

    useChatStore.getState().markAgentMessageRewindable("m1", {
      streamId: "stream-1",
      agentSessionId: "session-1",
      userMessageId: "user-sdk-1",
    })
    useChatStore.getState().markAgentMessageRewindable("m1", {
      streamId: "stream-1",
      assistantMessageId: "assistant-sdk-1",
    })

    expect(useChatStore.getState().agentRewindTargets.m1).toMatchObject({
      agentSessionId: "session-1",
      assistantMessageId: "assistant-sdk-1",
    })
  })

  it("applyAgentRewindSuccess truncates the conversation timeline and sets delayed-fork pending fields (A3/A4)", () => {
    const convId = useChatStore.getState().createConversation()
    useChatStore.setState({
      messages: [
        makeAssistantMessage("m1", convId),
        makeAssistantMessage("m2", convId),
        makeAssistantMessage("m3", convId),
      ],
    })

    const applied = useChatStore.getState().applyAgentRewindSuccess(convId, {
      throughMessageId: "m2",
      resumeSessionAt: "assistant-sdk-1",
    })

    expect(applied).toBe(true)
    expect(useChatStore.getState().messages.map((m) => m.id)).toEqual(["m1", "m2"])
    const conversation = useChatStore
      .getState()
      .conversations.find((c) => c.id === convId)
    expect(conversation).toMatchObject({
      agentForkSessionPending: true,
      agentResumeSessionAt: "assistant-sdk-1",
    })
  })

  it("applyAgentRewindSuccess is a no-op when the target message is not found", () => {
    const convId = useChatStore.getState().createConversation()
    useChatStore.setState({
      messages: [makeAssistantMessage("m1", convId)],
    })

    const applied = useChatStore.getState().applyAgentRewindSuccess(convId, {
      throughMessageId: "does-not-exist",
      resumeSessionAt: "assistant-sdk-1",
    })

    expect(applied).toBe(false)
    expect(useChatStore.getState().messages).toHaveLength(1)
  })

  it("applyAgentRewindSuccess only touches the target conversation, not others (A12)", () => {
    const convId = useChatStore.getState().createConversation()
    const otherConvId = useChatStore.getState().createConversation()
    useChatStore.setState({
      messages: [
        makeAssistantMessage("m1", convId),
        makeAssistantMessage("m2", convId),
        makeAssistantMessage("other-1", otherConvId),
      ],
    })

    useChatStore.getState().applyAgentRewindSuccess(convId, {
      throughMessageId: "m1",
      resumeSessionAt: "assistant-sdk-1",
    })

    expect(
      useChatStore.getState().messages.some((m) => m.id === "other-1")
    ).toBe(true)
    const other = useChatStore
      .getState()
      .conversations.find((c) => c.id === otherConvId)
    expect(other?.agentForkSessionPending).toBeUndefined()
  })

  it("applyAgentRewindSuccess latest-wins when called again with a newer target (A19)", () => {
    const convId = useChatStore.getState().createConversation()
    useChatStore.setState({
      messages: [
        makeAssistantMessage("m1", convId),
        makeAssistantMessage("m2", convId),
      ],
    })

    useChatStore.getState().applyAgentRewindSuccess(convId, {
      throughMessageId: "m2",
      resumeSessionAt: "assistant-sdk-2",
    })
    useChatStore.getState().applyAgentRewindSuccess(convId, {
      throughMessageId: "m1",
      resumeSessionAt: "assistant-sdk-1",
    })

    const conversation = useChatStore
      .getState()
      .conversations.find((c) => c.id === convId)
    expect(conversation?.agentResumeSessionAt).toBe("assistant-sdk-1")
    expect(useChatStore.getState().messages.map((m) => m.id)).toEqual(["m1"])
  })

  it("setAgentRewindLock sets and clears a per-conversation lock", () => {
    useChatStore.getState().setAgentRewindLock("conv-1", true)
    expect(useChatStore.getState().agentRewindLocks["conv-1"]).toBe(true)

    useChatStore.getState().setAgentRewindLock("conv-1", false)
    expect(useChatStore.getState().agentRewindLocks["conv-1"]).toBeUndefined()
  })

  it("deleteConversation clears that conversation's rewind lock", () => {
    const convId = useChatStore.getState().createConversation()
    useChatStore.getState().setAgentRewindLock(convId, true)

    useChatStore.getState().deleteConversation(convId)

    expect(useChatStore.getState().agentRewindLocks[convId]).toBeUndefined()
  })

  it("chatMessagesToLLM drops agent metadata", () => {
    const messages: DisplayMessage[] = [
      {
        id: "m1",
        role: "assistant",
        content: "answer",
        timestamp: 0,
        conversationId: "conv-1",
        mode: "agent",
        agentSessionId: "session-1",
	        agentBlocks: [
	          { type: "tool_use", id: "tool-1", name: "wiki_read", input: { path: "wiki/index.md" } },
	        ],
        sessionCompact: true,
	        agentErrorKind: "timeout",
	        toolCalls: [{ toolName: "wiki_read", phase: "post", ok: true }],
        costUsd: 0.1,
        wikiChanges: [{ path: "wiki/page.md", operation: "update", timestamp: 1 }],
        agentUserMessageId: "user-sdk-1",
        agentAssistantMessageId: "assistant-sdk-1",
      },
    ]

    expect(chatMessagesToLLM(messages)).toEqual([
      {
        role: "assistant",
        content: "answer",
      },
    ])
  })

  it("chatMessagesToLLM skips compact-only agent status messages", () => {
    const messages: DisplayMessage[] = [
      {
        id: "m1",
        role: "assistant",
        content: "",
        timestamp: 0,
        conversationId: "conv-1",
        mode: "agent",
        sessionCompact: true,
      },
      {
        id: "m2",
        role: "user",
        content: "continue",
        timestamp: 1,
        conversationId: "conv-1",
      },
    ]

    expect(chatMessagesToLLM(messages)).toEqual([
      {
        role: "user",
        content: "continue",
      },
    ])
  })

  it("allows a compact boundary patch to land after the agent message has finished", () => {
    const convId = useChatStore.getState().createConversation()
    useChatStore.setState({
      isStreaming: true,
      streamingContent: "",
      messages: [makeAssistantMessage("m1", convId)],
    })
    useChatStore.getState().finishAgentStreamMessage("m1", "done")
    useChatStore.getState().updateAgentStreamMessage("m1", {
      sessionCompact: true,
    })

    expect(useChatStore.getState().messages[0]).toMatchObject({
      id: "m1",
      content: "done",
      sessionCompact: true,
    })
  })

  it("keeps sessionCompact idempotent when the same run receives multiple compact boundaries", () => {
    const convId = useChatStore.getState().createConversation()
    useChatStore.setState({
      messages: [makeAssistantMessage("m1", convId)],
    })

    useChatStore.getState().updateAgentStreamMessage("m1", { sessionCompact: true })
    useChatStore.getState().updateAgentStreamMessage("m1", { sessionCompact: true })

    expect(useChatStore.getState().messages).toHaveLength(1)
    expect(useChatStore.getState().messages[0]).toMatchObject({
      id: "m1",
      sessionCompact: true,
    })
  })

  it("starts with no pending agent permission request", () => {
    expect(useChatStore.getState().activeAgentPermissionRequest).toBeNull()
    expect(useChatStore.getState().queuedAgentPermissionRequests).toEqual([])
  })

  it("resolves the active agent permission request", async () => {
    useChatStore.getState().createConversation()
    const promise = useChatStore.getState().requestAgentPermission({
      requestId: "permission-1",
      toolName: "Bash",
      inputPreview: { command: "pwd" },
      toolUseID: "tool-1",
    })

    expect(useChatStore.getState().activeAgentPermissionRequest).toMatchObject({
      requestId: "permission-1",
      toolName: "Bash",
    })

    useChatStore.getState().resolveAgentPermission("permission-1", {
      behavior: "allow",
      decisionClassification: "user_temporary",
    })

    await expect(promise).resolves.toEqual({
      behavior: "allow",
      decisionClassification: "user_temporary",
    })
    expect(useChatStore.getState().activeAgentPermissionRequest).toBeNull()
  })

  it("queues concurrent agent permission requests per conversation and shows the active conversation first", async () => {
    const convA = useChatStore.getState().createConversation()
    const convB = useChatStore.getState().createConversation()
    useChatStore.getState().setActiveConversation(convB)
    const first = useChatStore.getState().requestAgentPermission({
      requestId: "permission-1",
      conversationId: convA,
      toolName: "Bash",
      inputPreview: {},
      toolUseID: "tool-1",
    })
    const second = useChatStore.getState().requestAgentPermission({
      requestId: "permission-2",
      conversationId: convB,
      toolName: "Edit",
      inputPreview: {},
      toolUseID: "tool-2",
    })

    expect(useChatStore.getState().activeAgentPermissionRequest?.requestId).toBe("permission-2")
    expect(useChatStore.getState().queuedAgentPermissionRequests).toHaveLength(0)

    useChatStore.getState().setActiveConversation(convA)
    expect(useChatStore.getState().activeAgentPermissionRequest?.requestId).toBe("permission-1")

    useChatStore.getState().resolveAgentPermission("permission-1", {
      behavior: "deny",
      message: "no",
    })

    await expect(first).resolves.toMatchObject({ behavior: "deny" })
    expect(useChatStore.getState().activeAgentPermissionRequest).toBeNull()

    useChatStore.getState().setActiveConversation(convB)
    expect(useChatStore.getState().activeAgentPermissionRequest?.requestId).toBe("permission-2")

    useChatStore.getState().resolveAgentPermission("permission-2", {
      behavior: "allow",
    })
    await expect(second).resolves.toMatchObject({ behavior: "allow" })
  })

  it("approving one conversation's request does not affect another conversation's display queue", async () => {
    const convA = useChatStore.getState().createConversation()
    const convB = useChatStore.getState().createConversation()
    const first = useChatStore.getState().requestAgentPermission({
      requestId: "a-1",
      conversationId: convA,
      toolName: "Bash",
      inputPreview: {},
      toolUseID: "tool-a",
    })
    const second = useChatStore.getState().requestAgentPermission({
      requestId: "b-1",
      conversationId: convB,
      toolName: "Edit",
      inputPreview: {},
      toolUseID: "tool-b",
    })

    useChatStore.getState().setActiveConversation(convA)
    useChatStore.getState().resolveAgentPermission("a-1", { behavior: "allow" })
    useChatStore.getState().setActiveConversation(convB)

    await expect(first).resolves.toMatchObject({ behavior: "allow" })
    expect(useChatStore.getState().activeAgentPermissionRequest?.requestId).toBe("b-1")
    expect(useChatStore.getState().queuedAgentPermissionRequests).toEqual([])
    useChatStore.getState().resolveAgentPermission("b-1", { behavior: "deny" })
    await expect(second).resolves.toMatchObject({ behavior: "deny" })
  })

  it("keeps a switched-away active permission request pending until resolved or timed out", async () => {
    vi.useFakeTimers()
    const convA = useChatStore.getState().createConversation()
    const convB = useChatStore.getState().createConversation()
    useChatStore.getState().setActiveConversation(convA)

    const first = useChatStore.getState().requestAgentPermission({
      requestId: "permission-1",
      conversationId: convA,
      toolName: "Bash",
      inputPreview: {},
      toolUseID: "tool-1",
    }, 1_000)

    expect(useChatStore.getState().activeAgentPermissionRequest?.requestId).toBe("permission-1")
    useChatStore.getState().setActiveConversation(convB)
    expect(useChatStore.getState().activeAgentPermissionRequest).toBeNull()
    let resolved = false
    first.then(() => {
      resolved = true
    })
    await flushMicrotasks()
    expect(resolved).toBe(false)
    expect(useChatStore.getState().agentPermissionRequestsByConversation[convA]).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(1_000)
    await expect(first).resolves.toMatchObject({ behavior: "deny" })
    expect(useChatStore.getState().agentPermissionRequestsByConversation[convA]).toBeUndefined()
  })

  it("starts the timeout for a same-conversation queued permission only after promotion", async () => {
    vi.useFakeTimers()
    const convId = useChatStore.getState().createConversation()
    const first = useChatStore.getState().requestAgentPermission({
      requestId: "permission-1",
      conversationId: convId,
      toolName: "Bash",
      inputPreview: {},
      toolUseID: "tool-1",
    }, 60_000)
    const second = useChatStore.getState().requestAgentPermission({
      requestId: "permission-2",
      conversationId: convId,
      toolName: "Edit",
      inputPreview: {},
      toolUseID: "tool-2",
    }, 60_000)

    await vi.advanceTimersByTimeAsync(50_000)
    useChatStore.getState().resolveAgentPermission("permission-1", {
      behavior: "allow",
    })
    await expect(first).resolves.toMatchObject({ behavior: "allow" })
    expect(useChatStore.getState().activeAgentPermissionRequest?.requestId).toBe("permission-2")

    await vi.advanceTimersByTimeAsync(59_999)
    let secondResolved = false
    second.then(() => {
      secondResolved = true
    })
    await flushMicrotasks()
    expect(secondResolved).toBe(false)

    await vi.advanceTimersByTimeAsync(1)
    await expect(second).resolves.toMatchObject({ behavior: "deny" })
  })

  it("allow_run resolves queued requests for the same stream and starts the next stream timer", async () => {
    vi.useFakeTimers()
    const convId = useChatStore.getState().createConversation()
    const first = useChatStore.getState().requestAgentPermission({
      requestId: "permission-1",
      conversationId: convId,
      streamId: "stream-a",
      toolName: "Bash",
      inputPreview: {},
      toolUseID: "tool-1",
    }, 60_000)
    const second = useChatStore.getState().requestAgentPermission({
      requestId: "permission-2",
      conversationId: convId,
      streamId: "stream-a",
      toolName: "Edit",
      inputPreview: {},
      toolUseID: "tool-2",
    }, 60_000)
    const other = useChatStore.getState().requestAgentPermission({
      requestId: "permission-3",
      conversationId: convId,
      streamId: "stream-b",
      toolName: "Read",
      inputPreview: {},
      toolUseID: "tool-3",
    }, 60_000)

    useChatStore.getState().resolveAgentPermission("permission-1", {
      behavior: "allow",
      decisionClassification: "user_permanent",
      scope: "run",
    })

    await expect(first).resolves.toMatchObject({ behavior: "allow", scope: "run" })
    await expect(second).resolves.toMatchObject({ behavior: "allow", scope: "run" })
    expect(useChatStore.getState().activeAgentPermissionRequest?.requestId).toBe("permission-3")

    await vi.advanceTimersByTimeAsync(59_999)
    let otherResolved = false
    other.then(() => {
      otherResolved = true
    })
    await flushMicrotasks()
    expect(otherResolved).toBe(false)

    await vi.advanceTimersByTimeAsync(1)
    await expect(other).resolves.toMatchObject({ behavior: "deny" })
  })

  it("non-head allow_run clears only the same conversation and stream", async () => {
    vi.useFakeTimers()
    const convId = useChatStore.getState().createConversation()
    const active = useChatStore.getState().requestAgentPermission({
      requestId: "active",
      conversationId: convId,
      streamId: "stream-a",
      toolName: "Bash",
      inputPreview: {},
      toolUseID: "tool-active",
    }, 60_000)
    const runAllowed = useChatStore.getState().requestAgentPermission({
      requestId: "queued-run",
      conversationId: convId,
      streamId: "stream-b",
      toolName: "Edit",
      inputPreview: {},
      toolUseID: "tool-run",
    }, 60_000)
    const sameStream = useChatStore.getState().requestAgentPermission({
      requestId: "queued-same-stream",
      conversationId: convId,
      streamId: "stream-b",
      toolName: "Write",
      inputPreview: {},
      toolUseID: "tool-same",
    }, 60_000)
    const otherStream = useChatStore.getState().requestAgentPermission({
      requestId: "queued-other-stream",
      conversationId: convId,
      streamId: "stream-c",
      toolName: "Read",
      inputPreview: {},
      toolUseID: "tool-other",
    }, 60_000)

    useChatStore.getState().resolveAgentPermission("queued-run", {
      behavior: "allow",
      decisionClassification: "user_permanent",
      scope: "run",
    })

    await expect(runAllowed).resolves.toMatchObject({ behavior: "allow", scope: "run" })
    await expect(sameStream).resolves.toMatchObject({ behavior: "allow", scope: "run" })
    expect(useChatStore.getState().activeAgentPermissionRequest?.requestId).toBe("active")
    expect(useChatStore.getState().queuedAgentPermissionRequests.map((request) => request.requestId))
      .toEqual(["queued-other-stream"])

    useChatStore.getState().resolveAgentPermission("active", { behavior: "deny" })
    await expect(active).resolves.toMatchObject({ behavior: "deny" })
    expect(useChatStore.getState().activeAgentPermissionRequest?.requestId).toBe("queued-other-stream")

    await vi.advanceTimersByTimeAsync(60_000)
    await expect(otherStream).resolves.toMatchObject({ behavior: "deny" })
  })

  it("allow_run while paused clears same-stream queue and starts the promoted request timer", async () => {
    vi.useFakeTimers()
    const convId = useChatStore.getState().createConversation()
    const first = useChatStore.getState().requestAgentPermission({
      requestId: "permission-1",
      conversationId: convId,
      streamId: "stream-a",
      toolName: "Bash",
      inputPreview: {},
      toolUseID: "tool-1",
    }, 60_000)
    const second = useChatStore.getState().requestAgentPermission({
      requestId: "permission-2",
      conversationId: convId,
      streamId: "stream-a",
      toolName: "Edit",
      inputPreview: {},
      toolUseID: "tool-2",
    }, 60_000)
    const other = useChatStore.getState().requestAgentPermission({
      requestId: "permission-3",
      conversationId: convId,
      streamId: "stream-b",
      toolName: "Read",
      inputPreview: {},
      toolUseID: "tool-3",
    }, 60_000)

    useChatStore.getState().pauseAgentPermissionTimer("permission-1")
    expect(useChatStore.getState().activeAgentPermissionRequest?.pausedRemainingMs).toBe(60_000)
    useChatStore.getState().resolveAgentPermission("permission-1", {
      behavior: "allow",
      decisionClassification: "user_permanent",
      scope: "run",
    })

    await expect(first).resolves.toMatchObject({ behavior: "allow", scope: "run" })
    await expect(second).resolves.toMatchObject({ behavior: "allow", scope: "run" })
    expect(useChatStore.getState().activeAgentPermissionRequest?.requestId).toBe("permission-3")
    expect(useChatStore.getState().activeAgentPermissionRequest?.pausedRemainingMs).toBeUndefined()

    await vi.advanceTimersByTimeAsync(60_000)
    await expect(other).resolves.toMatchObject({ behavior: "deny" })
  })

  it("pauses and resumes the active permission timeout with the remaining time", async () => {
    vi.useFakeTimers()
    useChatStore.getState().createConversation()
    const promise = useChatStore.getState().requestAgentPermission({
      requestId: "permission-1",
      toolName: "Bash",
      inputPreview: {},
      toolUseID: "tool-1",
    }, 1_000)

    await vi.advanceTimersByTimeAsync(400)
    useChatStore.getState().pauseAgentPermissionTimer("permission-1")
    expect(useChatStore.getState().activeAgentPermissionRequest?.pausedRemainingMs).toBe(600)

    let resolved = false
    promise.then(() => {
      resolved = true
    })
    await vi.advanceTimersByTimeAsync(500)
    await flushMicrotasks()
    expect(resolved).toBe(false)

    useChatStore.getState().resumeAgentPermissionTimer("permission-1")
    expect(useChatStore.getState().activeAgentPermissionRequest?.pausedRemainingMs).toBeUndefined()
    await vi.advanceTimersByTimeAsync(599)
    await flushMicrotasks()
    expect(resolved).toBe(false)

    await vi.advanceTimersByTimeAsync(1)
    await expect(promise).resolves.toMatchObject({
      behavior: "deny",
      autoTimeout: true,
    })
  })

  it("automatically resumes a long pause before the sidecar failsafe window", async () => {
    vi.useFakeTimers()
    useChatStore.getState().createConversation()
    const promise = useChatStore.getState().requestAgentPermission({
      requestId: "permission-1",
      toolName: "Bash",
      inputPreview: {},
      toolUseID: "tool-1",
    }, 60_000)

    useChatStore.getState().pauseAgentPermissionTimer("permission-1")
    expect(useChatStore.getState().activeAgentPermissionRequest?.pausedRemainingMs).toBe(60_000)

    await vi.advanceTimersByTimeAsync(30_000)
    expect(useChatStore.getState().activeAgentPermissionRequest?.pausedRemainingMs).toBeUndefined()

    let resolved = false
    promise.then(() => {
      resolved = true
    })
    await vi.advanceTimersByTimeAsync(59_999)
    await flushMicrotasks()
    expect(resolved).toBe(false)

    await vi.advanceTimersByTimeAsync(1)
    await expect(promise).resolves.toMatchObject({
      behavior: "deny",
      autoTimeout: true,
    })
  })

  it("shrinks the pause budget across multiple pause and resume cycles", async () => {
    vi.useFakeTimers()
    useChatStore.getState().createConversation()
    const promise = useChatStore.getState().requestAgentPermission({
      requestId: "permission-1",
      toolName: "Bash",
      inputPreview: {},
      toolUseID: "tool-1",
    }, 60_000)

    useChatStore.getState().pauseAgentPermissionTimer("permission-1")
    expect(useChatStore.getState().activeAgentPermissionRequest?.pausedRemainingMs).toBe(60_000)
    await vi.advanceTimersByTimeAsync(25_000)
    expect(useChatStore.getState().activeAgentPermissionRequest?.pausedRemainingMs).toBe(60_000)

    useChatStore.getState().resumeAgentPermissionTimer("permission-1")
    expect(useChatStore.getState().activeAgentPermissionRequest?.pausedRemainingMs).toBeUndefined()
    await vi.advanceTimersByTimeAsync(5_000)

    useChatStore.getState().pauseAgentPermissionTimer("permission-1")
    expect(useChatStore.getState().activeAgentPermissionRequest?.pausedRemainingMs).toBe(55_000)
    await vi.advanceTimersByTimeAsync(4_999)
    expect(useChatStore.getState().activeAgentPermissionRequest?.pausedRemainingMs).toBe(55_000)
    await vi.advanceTimersByTimeAsync(1)
    expect(useChatStore.getState().activeAgentPermissionRequest?.pausedRemainingMs).toBeUndefined()

    let resolved = false
    promise.then(() => {
      resolved = true
    })
    await vi.advanceTimersByTimeAsync(54_999)
    await flushMicrotasks()
    expect(resolved).toBe(false)

    await vi.advanceTimersByTimeAsync(1)
    await expect(promise).resolves.toMatchObject({
      behavior: "deny",
      autoTimeout: true,
    })
  })

  it("auto-denies an active agent permission request after the timeout", async () => {
    vi.useFakeTimers()
    const promise = useChatStore.getState().requestAgentPermission({
      requestId: "permission-1",
      toolName: "Bash",
      inputPreview: {},
      toolUseID: "tool-1",
    }, 1_000)

    await vi.advanceTimersByTimeAsync(1_000)

    await expect(promise).resolves.toMatchObject({
      behavior: "deny",
      decisionClassification: "user_reject",
      autoTimeout: true,
      message: expect.stringContaining("[permission_denied:timeout]"),
    })
    expect(useChatStore.getState().activeAgentPermissionRequest).toBeNull()
  })

  it("auto-denies a background conversation permission request after the timeout", async () => {
    vi.useFakeTimers()
    const convA = useChatStore.getState().createConversation()
    const convB = useChatStore.getState().createConversation()
    useChatStore.getState().setActiveConversation(convB)
    const promise = useChatStore.getState().requestAgentPermission({
      requestId: "permission-1",
      conversationId: convA,
      toolName: "Bash",
      inputPreview: {},
      toolUseID: "tool-1",
    }, 1_000)

    expect(useChatStore.getState().activeAgentPermissionRequest).toBeNull()
    await vi.advanceTimersByTimeAsync(1_000)

    await expect(promise).resolves.toMatchObject({
      behavior: "deny",
      decisionClassification: "user_reject",
    })
    expect(useChatStore.getState().agentPermissionRequestsByConversation[convA]).toBeUndefined()
  })

  it("clears active and queued permission requests without touching chat data", async () => {
    const convId = useChatStore.getState().createConversation()
    useChatStore.getState().addMessage("user", "hello")
    const first = useChatStore.getState().requestAgentPermission({
      requestId: "permission-1",
      toolName: "Bash",
      inputPreview: {},
      toolUseID: "tool-1",
    })
    const second = useChatStore.getState().requestAgentPermission({
      requestId: "permission-2",
      toolName: "Edit",
      inputPreview: {},
      toolUseID: "tool-2",
    })

    useChatStore.getState().clearAgentPermissionRequests({
      behavior: "deny",
      interrupt: true,
      message: "stopped",
    })

    await expect(first).resolves.toMatchObject({ behavior: "deny", interrupt: true })
    await expect(second).resolves.toMatchObject({ behavior: "deny", interrupt: true })
    expect(useChatStore.getState().activeAgentPermissionRequest).toBeNull()
    expect(useChatStore.getState().queuedAgentPermissionRequests).toEqual([])
    expect(useChatStore.getState().agentPermissionRequestsByConversation).toEqual({})
    expect(useChatStore.getState().conversations[0].id).toBe(convId)
    expect(useChatStore.getState().messages[0]).toMatchObject({
      role: "user",
      content: "hello",
    })
  })

  it("uses stopped fallback copy when clearing pending permissions without an explicit decision", async () => {
    useChatStore.getState().createConversation()
    const pending = useChatStore.getState().requestAgentPermission({
      requestId: "permission-1",
      toolName: "Bash",
      inputPreview: {},
      toolUseID: "tool-1",
    })

    useChatStore.getState().clearAgentPermissionRequests()

    await expect(pending).resolves.toMatchObject({
      behavior: "deny",
      interrupt: true,
      decisionClassification: "user_reject",
      message: "Agent run was stopped",
    })
    await expect(pending).resolves.not.toMatchObject({
      autoTimeout: true,
    })
  })

  it("clears only one conversation's permission requests and promotes that conversation's next request", async () => {
    const convA = useChatStore.getState().createConversation()
    const convB = useChatStore.getState().createConversation()
    useChatStore.getState().setActiveConversation(convA)
    const a1 = useChatStore.getState().requestAgentPermission({
      requestId: "a-1",
      conversationId: convA,
      toolName: "Bash",
      inputPreview: {},
      toolUseID: "tool-a-1",
    })
    const a2 = useChatStore.getState().requestAgentPermission({
      requestId: "a-2",
      conversationId: convA,
      toolName: "Edit",
      inputPreview: {},
      toolUseID: "tool-a-2",
    })
    const b1 = useChatStore.getState().requestAgentPermission({
      requestId: "b-1",
      conversationId: convB,
      toolName: "Read",
      inputPreview: {},
      toolUseID: "tool-b-1",
    })

    expect(useChatStore.getState().activeAgentPermissionRequest?.requestId).toBe("a-1")
    useChatStore.getState().resolveAgentPermission("a-1", { behavior: "deny" })
    await expect(a1).resolves.toMatchObject({ behavior: "deny" })
    expect(useChatStore.getState().activeAgentPermissionRequest?.requestId).toBe("a-2")

    useChatStore.getState().clearAgentPermissionRequestsForConversation(convA, {
      behavior: "deny",
      interrupt: true,
      message: "stopped",
    })
    await expect(a2).resolves.toMatchObject({ behavior: "deny", interrupt: true })
    expect(useChatStore.getState().activeAgentPermissionRequest).toBeNull()

    useChatStore.getState().setActiveConversation(convB)
    expect(useChatStore.getState().activeAgentPermissionRequest?.requestId).toBe("b-1")
    useChatStore.getState().resolveAgentPermission("b-1", { behavior: "allow" })
    await expect(b1).resolves.toMatchObject({ behavior: "allow" })
  })

  it("deleteConversation denies and clears only that conversation's pending permissions", async () => {
    vi.useFakeTimers()
    const convA = useChatStore.getState().createConversation()
    const convB = useChatStore.getState().createConversation()
    const a = useChatStore.getState().requestAgentPermission({
      requestId: "a-1",
      conversationId: convA,
      toolName: "Bash",
      inputPreview: {},
      toolUseID: "tool-a-1",
    })
    const b = useChatStore.getState().requestAgentPermission({
      requestId: "b-1",
      conversationId: convB,
      toolName: "Read",
      inputPreview: {},
      toolUseID: "tool-b-1",
    })

    useChatStore.getState().deleteConversation(convA)
    let aResolved = false
    a.then(() => {
      aResolved = true
    })
    await flushMicrotasks()

    expect(aResolved).toBe(true)
    await expect(a).resolves.toMatchObject({ behavior: "deny" })
    expect(useChatStore.getState().agentPermissionRequestsByConversation[convA]).toBeUndefined()
    useChatStore.getState().setActiveConversation(convB)
    expect(useChatStore.getState().activeAgentPermissionRequest?.requestId).toBe("b-1")
    useChatStore.getState().resolveAgentPermission("b-1", { behavior: "allow" })
    await expect(b).resolves.toMatchObject({ behavior: "allow" })
  })

  it("applyAgentRewindSuccess denies stale pending permissions for that conversation only", async () => {
    const convA = useChatStore.getState().createConversation()
    const convB = useChatStore.getState().createConversation()
    useChatStore.setState({
      messages: [
        makeAssistantMessage("m1", convA),
        makeAssistantMessage("m2", convA),
        makeAssistantMessage("other-1", convB),
      ],
    })
    const stale = useChatStore.getState().requestAgentPermission({
      requestId: "stale-1",
      conversationId: convA,
      streamId: "old-stream",
      toolName: "Bash",
      inputPreview: {},
      toolUseID: "tool-stale",
    })
    const other = useChatStore.getState().requestAgentPermission({
      requestId: "other-1",
      conversationId: convB,
      streamId: "other-stream",
      toolName: "Read",
      inputPreview: {},
      toolUseID: "tool-other",
    })

    expect(useChatStore.getState().applyAgentRewindSuccess(convA, {
      throughMessageId: "m1",
      resumeSessionAt: "assistant-sdk-1",
    })).toBe(true)

    await expect(stale).resolves.toMatchObject({ behavior: "deny", interrupt: true })
    const stateAfterCleanup = useChatStore.getState()
    useChatStore.getState().resolveAgentPermission("stale-1", { behavior: "allow" })
    expect(useChatStore.getState()).toMatchObject({
      agentPermissionRequestsByConversation: stateAfterCleanup.agentPermissionRequestsByConversation,
      activeAgentPermissionRequest: stateAfterCleanup.activeAgentPermissionRequest,
      queuedAgentPermissionRequests: stateAfterCleanup.queuedAgentPermissionRequests,
    })
    useChatStore.getState().setActiveConversation(convB)
    expect(useChatStore.getState().activeAgentPermissionRequest?.requestId).toBe("other-1")
    useChatStore.getState().resolveAgentPermission("other-1", { behavior: "allow" })
    await expect(other).resolves.toMatchObject({ behavior: "allow" })
  })

  it("clears old pending permissions at fork time before later cross-fork targets can be approved", async () => {
    const convId = useChatStore.getState().createConversation()
    useChatStore.setState({
      conversations: [
        {
          id: convId,
          title: "A",
          createdAt: 0,
          updatedAt: 1,
          agentSessionId: "session-old",
        },
      ],
      activeConversationId: convId,
      messages: [
        makeAssistantMessage("m1", convId),
        makeAssistantMessage("m2", convId),
      ],
    })
    const pending = useChatStore.getState().requestAgentPermission({
      requestId: "old-permission",
      conversationId: convId,
      streamId: "old-stream",
      toolName: "Bash",
      inputPreview: {},
      toolUseID: "tool-old",
    })

    expect(useChatStore.getState().applyAgentRewindSuccess(convId, {
      throughMessageId: "m1",
      resumeSessionAt: "assistant-sdk-1",
    })).toBe(true)

    await expect(pending).resolves.toMatchObject({ behavior: "deny", interrupt: true })
    expect(useChatStore.getState().agentPermissionRequestsByConversation[convId]).toBeUndefined()
  })
})
