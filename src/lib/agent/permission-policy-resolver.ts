import type { Conversation } from "@/stores/chat-store"
import type { AgentPermissionPolicy } from "@/lib/agent/agent-types"

const FALLBACK_AGENT_PERMISSION_POLICY: AgentPermissionPolicy = "default"

const CONVERSATION_AGENT_PERMISSION_POLICY_OVERRIDES = new Set<AgentPermissionPolicy>([
  "restricted",
  "bypassPermissions",
])

export type ConversationPermissionPolicySource = "conversation" | "global" | "fallback"

export interface ResolvedConversationPermissionPolicy {
  policy: AgentPermissionPolicy
  source: ConversationPermissionPolicySource
}

/** Normalize persisted conversation permission overrides; "default" means inherit. */
export function normalizeConversationPermissionPolicyOverride(
  value: unknown,
): AgentPermissionPolicy | undefined {
  return typeof value === "string" &&
    CONVERSATION_AGENT_PERMISSION_POLICY_OVERRIDES.has(value as AgentPermissionPolicy)
    ? (value as AgentPermissionPolicy)
    : undefined
}

/** Resolve the effective conversation permission policy and the layer it came from. */
export function resolveConversationPermissionPolicy(
  conversation: Pick<Conversation, "agentPermissionPolicyOverride"> | null | undefined,
  resourceConfig: { defaultPermissionPolicy?: AgentPermissionPolicy },
): ResolvedConversationPermissionPolicy {
  const conversationOverride = normalizeConversationPermissionPolicyOverride(
    conversation?.agentPermissionPolicyOverride,
  )
  if (conversationOverride) {
    return { policy: conversationOverride, source: "conversation" }
  }

  if (resourceConfig.defaultPermissionPolicy) {
    return { policy: resourceConfig.defaultPermissionPolicy, source: "global" }
  }

  return { policy: FALLBACK_AGENT_PERMISSION_POLICY, source: "fallback" }
}
