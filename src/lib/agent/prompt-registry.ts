import type { KnowledgeAgentId } from "./knowledge-agents-config"

export const GUIDANCE_MAX_LENGTH = 4000

export const PROMPT_CAPABLE_AGENT_IDS = [
  "compiler",
  "linter",
  "fixer",
  "synthesizer",
  "qa-saver",
] as const satisfies readonly KnowledgeAgentId[]

export type PromptCapableAgentId = typeof PROMPT_CAPABLE_AGENT_IDS[number]

export interface KnowledgeAgentPromptMetadata {
  id: KnowledgeAgentId
  promptCapable: boolean
}

export const KNOWLEDGE_AGENT_PROMPT_METADATA = {
  compiler: { id: "compiler", promptCapable: true },
  linter: { id: "linter", promptCapable: true },
  fixer: { id: "fixer", promptCapable: true },
  synthesizer: { id: "synthesizer", promptCapable: true },
  tagger: { id: "tagger", promptCapable: false },
  "qa-saver": { id: "qa-saver", promptCapable: true },
} as const satisfies Record<KnowledgeAgentId, KnowledgeAgentPromptMetadata>

export interface ComposeAgentPromptOptions {
  lockedPrelude: string
  runtimeInjected?: string
  guidance?: unknown
  lockedOutputContract: string
}

export function isPromptCapableAgent(id: KnowledgeAgentId): id is PromptCapableAgentId {
  return KNOWLEDGE_AGENT_PROMPT_METADATA[id].promptCapable
}

/** Returns safe persisted guidance text, falling back to empty string. */
export function clampAgentGuidance(
  guidance: unknown,
  maxLength = GUIDANCE_MAX_LENGTH,
): string {
  if (typeof guidance !== "string") return ""
  const codePoints = Array.from(guidance)
  if (codePoints.length <= maxLength) return guidance
  return codePoints.slice(0, maxLength).join("")
}

/** Composes an agent prompt while keeping locked output requirements last. */
export function composeAgentPrompt({
  lockedPrelude,
  runtimeInjected = "",
  guidance,
  lockedOutputContract,
}: ComposeAgentPromptOptions): string {
  return [
    lockedPrelude,
    runtimeInjected,
    clampAgentGuidance(guidance),
    lockedOutputContract,
  ]
    .filter((section) => section.trim().length > 0)
    .join("\n\n")
}
