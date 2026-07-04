import type { SDKMessage, SDKSystemMessage } from "./agent-types"

interface CompactOnlyAgentMessage {
  role?: string
  mode?: string
  sessionCompact?: boolean
  agentBlocks?: readonly unknown[]
  agentSessionId?: string
  toolCalls?: readonly unknown[]
  agentErrorKind?: unknown
  agentResourceLimit?: unknown
  wikiChanges?: readonly unknown[]
  costUsd?: number
  inputTokens?: number
  outputTokens?: number
  durationMs?: number
  numTurns?: number
}

/** Detect SDK compact/resume summaries that should not render as normal answers. */
export function isSdkCompactSummaryMessage(message: SDKMessage): message is SDKSystemMessage {
  return message.type === "system"
    && (message as SDKSystemMessage).subtype === "compact_boundary"
}

/** Return true for persisted Agent compact status rows with no real Agent output. */
export function isCompactOnlyAgentMessage(message: CompactOnlyAgentMessage): boolean {
  return Boolean(message.sessionCompact)
    && !(message.agentBlocks?.length)
}

/** Return true for assistant messages that carry Agent-era metadata. */
export function isAgentAssistantMessage(message: CompactOnlyAgentMessage): boolean {
  return message.role === "assistant"
    && (
      message.mode === "agent"
      || Boolean(message.agentSessionId)
      || Boolean(message.agentBlocks?.length)
      || Boolean(message.toolCalls?.length)
      || Boolean(message.agentErrorKind)
      || Boolean(message.agentResourceLimit)
      || Boolean(message.wikiChanges?.length)
      || message.costUsd !== undefined
      || message.inputTokens !== undefined
      || message.outputTokens !== undefined
      || message.durationMs !== undefined
      || message.numTurns !== undefined
    )
}
