import type { SDKAssistantMessage, SDKMessage } from "./agent-types"

// Agent SDK compact/resume notices are English today; non-English text falls
// through as a normal assistant message instead of being hidden.
const CONTEXT_EXHAUSTED_RE =
  /\b(run(?:ning)? out of context|context\b[^.!?\n]{0,80}\b(?:has |is |it has |it is )?(?:run|running) out|context (?:window )?(?:is )?exhausted|context (?:window )?(?:was |has been |is )?(?:compact(?:ed|ing)?|summar(?:y|ize|ized|izing)))\b/i

interface CompactOnlyAgentMessage {
  mode?: string
  sessionCompact?: boolean
  agentBlocks?: readonly unknown[]
}

function assistantText(message: SDKAssistantMessage): string {
  return message.message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n")
}

/** Detect SDK compact/resume summaries that should not render as normal answers. */
export function isSdkCompactSummaryMessage(message: SDKMessage): message is SDKAssistantMessage {
  if (message.type !== "assistant") return false
  const content = (message as SDKAssistantMessage).message?.content
  if (!Array.isArray(content)) return false
  const text = assistantText(message as SDKAssistantMessage)
  return CONTEXT_EXHAUSTED_RE.test(text)
}

/** Return true for persisted Agent compact status rows with no real Agent output. */
export function isCompactOnlyAgentMessage(message: CompactOnlyAgentMessage): boolean {
  return message.mode === "agent"
    && Boolean(message.sessionCompact)
    && !(message.agentBlocks?.length)
}
