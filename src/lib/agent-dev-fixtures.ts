import {
  createAgentWriteReviewItem,
  useReviewStore,
} from "@/stores/review-store"
import { useChatStore, type DisplayMessage } from "@/stores/chat-store"
import { computeAgentRewindGateDecision } from "@/lib/agent/agent-rewind-gate"
import { registerDevFixture } from "./dev-fixtures"

export const AGENT_DEV_FIXTURE_SCENARIOS = [
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

function finishAgentErrorMessage(
  messageId: string,
  agentErrorKind: NonNullable<DisplayMessage["agentErrorKind"]>,
  agentErrorDetail: string,
  agentSessionId?: string,
): void {
  useChatStore.getState().finishAgentStreamMessage(
    messageId,
    "",
    agentSessionId ? { agentSessionId } : undefined,
    { agentErrorKind, agentErrorDetail },
  )
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

function profileUnavailableScenario(ctx: FixtureContext): AgentDevFixtureResult {
  const messageId = startAgentMessage()
  finishAgentErrorMessage(
    messageId,
    "profile_unavailable",
    "profile-unavailable: no-eligible-profile: no profile pool capacity is available",
  )
  return { scenario: "profileUnavailable", conversationId: ctx.conversationId, messageId }
}

function modelRejectedScenario(ctx: FixtureContext): AgentDevFixtureResult {
  const messageId = startAgentMessage()
  finishAgentErrorMessage(
    messageId,
    "model_not_found",
    "model not found: Dev QA simulated rejected model.",
  )
  return { scenario: "modelRejected", conversationId: ctx.conversationId, messageId }
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
  const messageId = createRewindTarget(ctx, {
    agentSessionId,
    streamId,
    content: "Dev QA rewind target without wiki writes.",
  })
  return { scenario: "activeRewind", conversationId: ctx.conversationId, messageId }
}

function createRewindTarget(
  ctx: FixtureContext,
  args: {
    agentSessionId: string
    streamId: string
    content: string
    assistantMessageId?: string
  },
): string {
  const messageId = startAgentMessage(args.agentSessionId)
  useChatStore.getState().finishAgentStreamMessage(
    messageId,
    args.content,
    { agentSessionId: args.agentSessionId },
  )
  useChatStore.getState().markAgentMessageRewindable(messageId, {
    streamId: args.streamId,
    agentSessionId: args.agentSessionId,
    userMessageId: ctx.userMessageId,
    assistantMessageId: args.assistantMessageId,
  })
  return messageId
}

function doneRewindScenario(ctx: FixtureContext): AgentDevFixtureResult {
  const agentSessionId = "dev-fixture-session-done-rewind"
  const streamId = "dev-fixture-stream-done-rewind"
  const assistantMessageId = "dev-fixture-assistant-done-rewind"
  const messageId = createRewindTarget(ctx, {
    streamId,
    agentSessionId,
    content: "Dev QA rewind target with completed assistant uuid.",
    assistantMessageId,
  })
  finishAgentErrorMessage(
    messageId,
    "model_not_found",
    "Dev QA simulated model_not_found.",
    agentSessionId,
  )
  return { scenario: "doneRewind", conversationId: ctx.conversationId, messageId }
}

function rewindLockedScenario(ctx: FixtureContext): AgentDevFixtureResult {
  const messageId = createRewindTarget(ctx, {
    agentSessionId: "dev-fixture-session-rewind-locked",
    streamId: "dev-fixture-stream-rewind-locked",
    content: "Dev QA rewind target blocked by an active rewind lock.",
  })
  useChatStore.getState().setAgentRewindLock(ctx.conversationId, true)
  return { scenario: "rewindLocked", conversationId: ctx.conversationId, messageId }
}

function rewindCrossForkScenario(ctx: FixtureContext): AgentDevFixtureResult {
  const messageId = createRewindTarget(ctx, {
    agentSessionId: "dev-fixture-session-rewind-before-fork",
    streamId: "dev-fixture-stream-rewind-cross-fork",
    content: "Dev QA rewind target captured before a session fork.",
  })
  const forkMessageId = startAgentMessage("dev-fixture-session-rewind-after-fork")
  useChatStore.getState().finishAgentStreamMessage(
    forkMessageId,
    "Dev QA later session fork blocks the earlier rewind target.",
    { agentSessionId: "dev-fixture-session-rewind-after-fork" },
  )
  return { scenario: "rewindCrossFork", conversationId: ctx.conversationId, messageId }
}

function rewindWikiWriteScenario(ctx: FixtureContext): AgentDevFixtureResult {
  const agentSessionId = "dev-fixture-session-rewind-wiki-write"
  const messageId = createRewindTarget(ctx, {
    agentSessionId,
    streamId: "dev-fixture-stream-rewind-wiki-write",
    content: "Dev QA rewind target before an uncovered wiki write.",
  })
  const writeMessageId = startAgentMessage(agentSessionId)
  useChatStore.getState().updateAgentProgress(writeMessageId, {
    toolName: "mcp__llm_wiki__update_page",
    toolUseId: "dev-fixture-tool-rewind-wiki-write",
    phase: "post",
    ok: true,
    inputPreview: { path: "wiki/entities/demo.md", operation: "update" },
  })
  useChatStore.getState().finishAgentStreamMessage(
    writeMessageId,
    "Dev QA later uncovered wiki write blocks rewind.",
    { agentSessionId },
  )
  return { scenario: "rewindWikiWrite", conversationId: ctx.conversationId, messageId }
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

function assertRewindGateBlocked(
  messageId: string,
  expectedReason: Exclude<
    ReturnType<typeof computeAgentRewindGateDecision>,
    { allowed: true }
  >["reason"],
): void {
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
  if (decision.allowed || decision.reason !== expectedReason) {
    throw new Error(
      `agent rewind fixture gate expected ${expectedReason}, got ${
        decision.allowed ? "allowed" : decision.reason
      }`,
    )
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
  // rewindLocked leaves the conversation lock engaged on purpose (that IS the scenario);
  // clear it here so the next fixture run — or normal dev chat use — is not permanently blocked.
  // Note: fixtures reuse the active conversation, so this also clears a genuine in-flight
  // rewind lock if one exists — acceptable for a dev-only console entry point.
  useChatStore.getState().setAgentRewindLock(ctx.conversationId, false)
  let result: AgentDevFixtureResult
  switch (scenario) {
    case "permission":
      result = permissionScenario(ctx)
      break
    case "profileUnavailable":
      result = profileUnavailableScenario(ctx)
      break
    case "modelRejected":
      result = modelRejectedScenario(ctx)
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
    case "rewindLocked":
      result = rewindLockedScenario(ctx)
      break
    case "rewindCrossFork":
      result = rewindCrossForkScenario(ctx)
      break
    case "rewindWikiWrite":
      result = rewindWikiWriteScenario(ctx)
      break
    case "agentWriteReview":
      result = agentWriteReviewScenario(ctx)
      break
  }

  if (scenario === "activeRewind" || scenario === "doneRewind") {
    assertRewindGateAllowed(result.messageId ?? "")
  }
  if (scenario === "rewindLocked") {
    assertRewindGateBlocked(result.messageId ?? "", "locked")
  }
  if (scenario === "rewindCrossFork") {
    assertRewindGateBlocked(result.messageId ?? "", "cross_fork")
  }
  if (scenario === "rewindWikiWrite") {
    assertRewindGateBlocked(result.messageId ?? "", "wiki_write_after_target")
  }
  return result
}

registerDevFixture("agent", runAgentDevFixture)
