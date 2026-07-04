import type {
  AgentRewindRequestRecord,
  Conversation,
  DisplayMessage,
} from "@/stores/chat-store"
import { isWikiWriteToolCall } from "./wiki-tool-write-gate"

export type AgentRewindGateDecision =
  | { allowed: true }
  | { allowed: false; reason: "wiki_write_after_target" }
  | { allowed: false; reason: "cross_fork" }
  | { allowed: false; reason: "locked" }

/**
 * Fail-closed pre-flight gate for SPEC-7 PR2 rewind (matrix A2/A6/A9/A16/A17):
 *   - `locked`: a rewind is already in progress for this conversation, or a
 *     normal send is streaming — the two must never interleave (A6).
 *   - `cross_fork`: the target was captured against a session that is no
 *     longer the conversation's current session (a fork happened since) —
 *     the forked session has no undo history for this target (A9).
 *   - `wiki_write_after_target`: a wiki-write tool call landed on or after
 *     the target message — the SDK's native checkpoint does not cover wiki
 *     MCP tool writes (E2 probe), so rewinding here would silently leave
 *     those writes in place while reporting success (A2/A17). The A16 batch
 *     tool-event merge fix (chat-panel.tsx) is what makes this scan see
 *     every recorded tool call, not just the latest batch.
 */
export function computeAgentRewindGateDecision(args: {
  target: AgentRewindRequestRecord
  conversation: Conversation | undefined
  messages: DisplayMessage[]
  isStreaming: boolean
  streamingConversationId?: string | null
  rewindLocked: boolean
}): AgentRewindGateDecision {
  const {
    target,
    conversation,
    messages,
    isStreaming,
    streamingConversationId,
    rewindLocked,
  } = args

  // `isStreaming && streamingConversationId === null` should be unreachable
  // because store updates set/clear them together; if observed, fail open so
  // another conversation's rewind is not blocked by an unowned global flag.
  if (
    rewindLocked ||
    (isStreaming && streamingConversationId === target.conversationId)
  ) {
    return { allowed: false, reason: "locked" }
  }
  if (!conversation) {
    return { allowed: false, reason: "cross_fork" }
  }
  if (
    target.agentSessionId &&
    conversation.agentSessionId &&
    target.agentSessionId !== conversation.agentSessionId
  ) {
    return { allowed: false, reason: "cross_fork" }
  }

  const conversationMessages = messages
    .filter((m) => m.conversationId === conversation.id)
    .sort((a, b) => a.timestamp - b.timestamp)
  const targetIndex = conversationMessages.findIndex(
    (m) => m.id === target.chatMessageId
  )
  const from = targetIndex === -1 ? 0 : targetIndex
  const hasWikiWriteAfterTarget = conversationMessages
    .slice(from)
    .some((m) =>
      (m.toolCalls ?? []).some((call) => isWikiWriteToolCall(call.toolName))
    )
  if (hasWikiWriteAfterTarget) {
    return { allowed: false, reason: "wiki_write_after_target" }
  }

  return { allowed: true }
}
