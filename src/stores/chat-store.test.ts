import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { chatMessagesToLLM, useChatStore, type DisplayMessage } from "./chat-store"

function resetChatStore(): void {
  useChatStore.getState().clearAgentPermissionRequests()
  useChatStore.setState({
    conversations: [],
    activeConversationId: null,
    messages: [],
    isStreaming: false,
    streamingContent: "",
    mode: "chat",
    ingestSource: null,
    maxHistoryMessages: 10,
    activeAgentPermissionRequest: null,
    queuedAgentPermissionRequests: [],
    agentRewindTargets: {},
    activeAgentRewindRequest: null,
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

describe("chat store agent data model", () => {
  beforeEach(() => {
    resetChatStore()
  })

  afterEach(() => {
    vi.useRealTimers()
    resetChatStore()
  })

  it("defaults to chat mode and accepts agent mode", () => {
    expect(useChatStore.getState().mode).toBe("chat")

    useChatStore.getState().setMode("agent")

    expect(useChatStore.getState().mode).toBe("agent")
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

  it("stores images only for ordinary chat user messages", () => {
    useChatStore.getState().createConversation()
    const image = { mediaType: "image/png", dataBase64: "AAAA" }

    useChatStore.getState().addMessage("user", "look", { images: [image] })
    useChatStore.getState().addMessage("user", "agent", {
      mode: "agent",
      images: [image],
    })
    useChatStore.getState().addMessage("user", "ingest", {
      mode: "ingest",
      images: [image],
    })
    useChatStore.getState().addMessage("assistant", "assistant", {
      images: [image],
    })

    const messages = useChatStore.getState().messages
    expect(messages[0].images).toEqual([image])
    expect(messages[1].images).toBeUndefined()
    expect(messages[2].images).toBeUndefined()
    expect(messages[3].images).toBeUndefined()
  })

  it("stores Chat Router options only for ordinary chat user messages", () => {
    useChatStore.getState().createConversation()
    const chatOptions = {
      useWebSearch: true,
      useAnyTxtSearch: true,
      agentMode: "deep" as const,
    }

    useChatStore.getState().addMessage("user", "chat", { chatOptions })
    useChatStore.getState().addMessage("user", "agent", {
      mode: "agent",
      chatOptions,
    })
    useChatStore.getState().addMessage("user", "ingest", {
      mode: "ingest",
      chatOptions,
    })
    useChatStore.getState().addMessage("assistant", "assistant", {
      chatOptions,
    })

    const messages = useChatStore.getState().messages
    expect(messages[0].chatOptions).toEqual(chatOptions)
    expect(messages[1].chatOptions).toBeUndefined()
    expect(messages[2].chatOptions).toBeUndefined()
    expect(messages[3].chatOptions).toBeUndefined()
  })

  it("stores agent metadata when addMessage receives options", () => {
    const convId = useChatStore.getState().createConversation()

    useChatStore.getState().addMessage("user", "run task", {
      mode: "agent",
      agentSessionId: "session-1",
    })

    expect(useChatStore.getState().messages[0]).toMatchObject({
      role: "user",
      content: "run task",
      conversationId: convId,
      mode: "agent",
      agentSessionId: "session-1",
    })
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
      mode: "agent",
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
      mode: "agent",
      agentSessionId: "session-1",
    })
    expect(useChatStore.getState().isStreaming).toBe(true)
    expect(useChatStore.getState().streamingContent).toBe("")
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
      content: "Agent timed out",
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
      content: "Agent reached the max turn limit.",
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

  it("starts with no pending agent permission request", () => {
    expect(useChatStore.getState().activeAgentPermissionRequest).toBeNull()
    expect(useChatStore.getState().queuedAgentPermissionRequests).toEqual([])
  })

  it("resolves the active agent permission request", async () => {
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

  it("queues concurrent agent permission requests serially", async () => {
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

    expect(useChatStore.getState().activeAgentPermissionRequest?.requestId).toBe("permission-1")
    expect(useChatStore.getState().queuedAgentPermissionRequests).toHaveLength(1)

    useChatStore.getState().resolveAgentPermission("permission-1", {
      behavior: "deny",
      message: "no",
    })

    await expect(first).resolves.toMatchObject({ behavior: "deny" })
    expect(useChatStore.getState().activeAgentPermissionRequest?.requestId).toBe("permission-2")

    useChatStore.getState().resolveAgentPermission("permission-2", {
      behavior: "allow",
    })
    await expect(second).resolves.toMatchObject({ behavior: "allow" })
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
    })
    expect(useChatStore.getState().activeAgentPermissionRequest).toBeNull()
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
    expect(useChatStore.getState().conversations[0].id).toBe(convId)
    expect(useChatStore.getState().messages[0]).toMatchObject({
      role: "user",
      content: "hello",
    })
  })
})
