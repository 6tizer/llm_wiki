import type { SDKMessage, SDKSystemMessage } from "./agent-types"

interface CompactOnlyAgentMessage {
  mode?: string
  sessionCompact?: boolean
  agentBlocks?: readonly unknown[]
}

/** Detect SDK compact/resume summaries that should not render as normal answers. */
export function isSdkCompactSummaryMessage(message: SDKMessage): message is SDKSystemMessage {
  return message.type === "system"
    && (message as SDKSystemMessage).subtype === "compact_boundary"
}

/** Return true for persisted Agent compact status rows with no real Agent output. */
export function isCompactOnlyAgentMessage(message: CompactOnlyAgentMessage): boolean {
  return message.mode === "agent"
    && Boolean(message.sessionCompact)
    && !(message.agentBlocks?.length)
}
