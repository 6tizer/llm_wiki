import {
  createAgentWriteReviewItem,
  useReviewStore,
} from "@/stores/review-store"
import { useChatStore, type DisplayMessage } from "@/stores/chat-store"
import { computeAgentRewindGateDecision } from "@/lib/agent/agent-rewind-gate"
import { registerDevFixture } from "./dev-fixtures"

export const AGENT_DEV_FIXTURE_SCENARIOS = [
  "permission",
  "resourceLimit",
  "compact",
  "timeline",
  "pendingCorrection",
  "activeRewind",
  "doneRewind",
  "agentWriteReview",
] as const

export type AgentDevFixtureScenario = typeof AGENT_DEV_FIXTURE_SCENARIOS[number]

interface FixtureContext {
  conversationId: string
  userMessageId: string
}

export interface AgentDevFixtureResult {
  scenario: AgentDevFixtureScenario
  conversationId: string
  messageId?: string
}

const scenarioSet = new Set<string>(AGENT_DEV_FIXTURE_SCENARIOS)

function now(): number {
  return Date.now()
}

function activeConversationExists(): boolean {
  const state = useChatStore.getState()
  return Boolean(
    state.activeConversationId &&
      state.conversations.some((conversation) => conversation.id === state.activeConversationId),
  )
}

function lastActiveUserMessage(conversationId: string): DisplayMessage | undefined {
  return [...useChatStore.getState().messages]
    .reverse()
    .find((message) => message.conversationId === conversationId && message.role === "user")
}

function ensureFixtureConversation(): FixtureContext {
  const store = useChatStore.getState()
  if (!activeConversationExists()) {
    store.createConversation()
    useChatStore.getState().addMessage("user", "Dev QA fixture seed")
  } else if (!lastActiveUserMessage(store.activeConversationId ?? "")) {
    store.addMessage("user", "Dev QA fixture seed")
  }

  const state = useChatStore.getState()
  const conversationId = state.activeConversationId
  if (!conversationId) {
    throw new Error("agent dev fixture could not create an active conversation")
  }
  const userMessageId = lastActiveUserMessage(conversationId)?.id
  if (!userMessageId) {
    throw new Error("agent dev fixture could not create a seed user message")
  }
  return { conversationId, userMessageId }
}

function startAgentMessage(agentSessionId?: string): string {
  const messageId = useChatStore.getState().startAgentStreamMessage({ agentSessionId })
  if (!messageId) throw new Error("agent dev fixture could not create an assistant message")
  return messageId
}

function permissionScenario(ctx: FixtureContext): AgentDevFixtureResult {
  const requestId = crypto.randomUUID()
  const toolUseID = `tool-${requestId}`
  void useChatStore.getState().requestAgentPermission({
    requestId,
    toolName: "mcp__llm_wiki__update_page",
    inputPreview: {
      pathBytes: [119, 105, 107, 105, 47, 100, 101, 109, 111, 46, 109, 100],
      pathSha256: "0".repeat(64),
      operation: "update",
    },
    toolUseID,
    streamId: "dev-fixture-stream-permission",
    conversationId: ctx.conversationId,
  })
  return { scenario: "permission", conversationId: ctx.conversationId }
}

function resourceLimitScenario(ctx: FixtureContext): AgentDevFixtureResult {
  const messageId = startAgentMessage()
  useChatStore.getState().updateAgentStreamMessage(messageId, {
    agentResourceLimit: {
      kind: "resource_limit",
      limitKind: "max_turns_exceeded",
      message: "Dev QA: maximum agent turns exceeded.",
      recovery: "split_task",
    },
  })
  return { scenario: "resourceLimit", conversationId: ctx.conversationId, messageId }
}

function compactScenario(ctx: FixtureContext): AgentDevFixtureResult {
  const messageId = startAgentMessage()
  useChatStore.getState().updateAgentStreamMessage(messageId, {
    sessionCompact: true,
  })
  return { scenario: "compact", conversationId: ctx.conversationId, messageId }
}

function timelineScenario(ctx: FixtureContext): AgentDevFixtureResult {
  const messageId = startAgentMessage()
  const store = useChatStore.getState()
  store.updateAgentProgress(messageId, {
    toolName: "mcp__llm_wiki__read_page",
    toolUseId: "tool-pending",
    phase: "pre",
    inputPreview: { path: "wiki/entities/demo.md" },
  })
  store.updateAgentProgress(messageId, {
    toolName: "mcp__llm_wiki__update_page",
    toolUseId: "tool-done",
    phase: "post",
    ok: true,
    durationMs: 42,
    inputPreview: { path: "wiki/entities/demo.md" },
  })
  store.updateAgentProgress(messageId, {
    toolName: "WebFetch",
    toolUseId: "tool-failed",
    phase: "failure",
    ok: false,
    error: "Dev QA simulated failure",
  })
  store.appendAgentProgressSummary(messageId, {
    text: "Read demo page and prepared an update.",
    timestamp: now(),
  })
  store.appendAgentProgressSummary(messageId, {
    text: "One external fetch failed; continuing with local context.",
    timestamp: now(),
  })
  store.appendAgentPermissionEvent(messageId, {
    toolName: "mcp__llm_wiki__update_page",
    decision: "allow_temporary",
    permissionPolicy: "restricted",
    timestamp: now(),
  })
  store.appendAgentPermissionEvent(messageId, {
    toolName: "WebFetch",
    decision: "deny_interrupt",
    permissionPolicy: "bypassPermissions",
    timestamp: now(),
  })
  store.finishAgentStreamMessage(messageId, "Dev QA timeline fixture ready.")
  return { scenario: "timeline", conversationId: ctx.conversationId, messageId }
}

function pendingCorrectionScenario(ctx: FixtureContext): AgentDevFixtureResult {
  const agentSessionId = "dev-fixture-session-pending-correction"
  const messageId = startAgentMessage(agentSessionId)
  useChatStore.getState().finishAgentStreamMessage(
    messageId,
    "我将更新 wiki/entities/demo.md。确认执行吗？",
    { agentSessionId },
  )
  // Verification: enter a next user message such as "不对" to exercise the
  // real resume override path against this conversation's agentSessionId.
  return { scenario: "pendingCorrection", conversationId: ctx.conversationId, messageId }
}

function activeRewindScenario(ctx: FixtureContext): AgentDevFixtureResult {
  const agentSessionId = "dev-fixture-session-active-rewind"
  const streamId = "dev-fixture-stream-active-rewind"
  const messageId = startAgentMessage(agentSessionId)
  useChatStore.getState().finishAgentStreamMessage(
    messageId,
    "Dev QA rewind target without wiki writes.",
    { agentSessionId },
  )
  useChatStore.getState().markAgentMessageRewindable(messageId, {
    streamId,
    agentSessionId,
    userMessageId: ctx.userMessageId,
  })
  return { scenario: "activeRewind", conversationId: ctx.conversationId, messageId }
}

function doneRewindScenario(ctx: FixtureContext): AgentDevFixtureResult {
  const agentSessionId = "dev-fixture-session-done-rewind"
  const streamId = "dev-fixture-stream-done-rewind"
  const assistantMessageId = "dev-fixture-assistant-done-rewind"
  const messageId = startAgentMessage(agentSessionId)
  useChatStore.getState().finishAgentStreamMessage(
    messageId,
    "Dev QA rewind target with completed assistant uuid.",
    { agentSessionId },
  )
  useChatStore.getState().markAgentMessageRewindable(messageId, {
    streamId,
    agentSessionId,
    userMessageId: ctx.userMessageId,
    assistantMessageId,
  })
  useChatStore.getState().finishAgentStreamMessage(
    messageId,
    "",
    { agentSessionId },
    {
      agentErrorKind: "model_not_found",
      agentErrorDetail: "Dev QA simulated model_not_found.",
    },
  )
  return { scenario: "doneRewind", conversationId: ctx.conversationId, messageId }
}

function agentWriteReviewScenario(ctx: FixtureContext): AgentDevFixtureResult {
  const messageId = startAgentMessage()
  const streamId = "dev-fixture-stream-agent-write-review"
  const payload = {
    path: "wiki/entities/demo.md",
    operation: "update" as const,
    oldSha256: "1".repeat(64),
    newSha256: "2".repeat(64),
    toolUseId: "dev-fixture-tool-agent-write",
    snapshotted: false,
  }
  useChatStore.getState().appendAgentWikiChange(messageId, payload)
  useReviewStore.getState().addItem(
    createAgentWriteReviewItem({
      payload,
      conversationId: ctx.conversationId,
      messageId,
      streamId,
    }),
  )
  useChatStore.getState().finishAgentStreamMessage(messageId, "Dev QA agent write review ready.")
  return { scenario: "agentWriteReview", conversationId: ctx.conversationId, messageId }
}

function assertRewindGateAllowed(messageId: string): void {
  const state = useChatStore.getState()
  const target = state.agentRewindTargets[messageId]
  if (!target) throw new Error("agent rewind fixture did not create a rewind target")
  const decision = computeAgentRewindGateDecision({
    target,
    conversation: state.conversations.find((conversation) => conversation.id === target.conversationId),
    messages: state.messages,
    isStreaming: state.isStreaming,
    streamingConversationId: state.streamingConversationId,
    rewindLocked: Boolean(state.agentRewindLocks[target.conversationId]),
  })
  if (!decision.allowed) {
    throw new Error(`agent rewind fixture gate blocked: ${decision.reason}`)
  }
}

/**
 * Inject one SPEC-7 Agent QA scenario into the live chat store.
 *
 * Scenario owner: SPEC-7. The fixture shell is intentionally minimal and
 * owned by SPEC-8 for later expansion.
 */
function isAgentDevFixtureScenario(scenario: unknown): scenario is AgentDevFixtureScenario {
  return typeof scenario === "string" && scenarioSet.has(scenario)
}

export function runAgentDevFixture(scenario: unknown): AgentDevFixtureResult {
  if (!isAgentDevFixtureScenario(scenario)) {
    throw new Error(`Unknown agent dev fixture scenario: ${String(scenario)}`)
  }
  const ctx = ensureFixtureConversation()
  let result: AgentDevFixtureResult
  switch (scenario) {
    case "permission":
      result = permissionScenario(ctx)
      break
    case "resourceLimit":
      result = resourceLimitScenario(ctx)
      break
    case "compact":
      result = compactScenario(ctx)
      break
    case "timeline":
      result = timelineScenario(ctx)
      break
    case "pendingCorrection":
      result = pendingCorrectionScenario(ctx)
      break
    case "activeRewind":
      result = activeRewindScenario(ctx)
      break
    case "doneRewind":
      result = doneRewindScenario(ctx)
      break
    case "agentWriteReview":
      result = agentWriteReviewScenario(ctx)
      break
  }

  if (scenario === "activeRewind" || scenario === "doneRewind") {
    assertRewindGateAllowed(result.messageId ?? "")
  }
  return result
}

registerDevFixture("agent", runAgentDevFixture)
