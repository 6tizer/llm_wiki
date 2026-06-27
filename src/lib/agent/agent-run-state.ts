import type { LlmConfig } from "@/stores/wiki-store"
import type { WikiProject } from "@/types/wiki"

export type AgentErrorKind =
  | "unavailable"
  | "missing_api_key"
  | "timeout"
  | "max_turns_exceeded"
  | "failed"
export type AgentRunPhase = "idle" | "connecting" | "running"

const API_KEY_OPTIONAL_PROVIDERS = new Set<LlmConfig["provider"]>([
  "ollama",
  "claude-code",
  "codex-cli",
  "custom",
])

/** Return whether Agent should block before send when the provider has no API key. */
export function agentProviderNeedsApiKey(provider: LlmConfig["provider"]): boolean {
  return !API_KEY_OPTIONAL_PROVIDERS.has(provider)
}

/** Classify preflight Agent failures before opening a sidecar stream. */
export function getAgentPreflightError(
  project: WikiProject | null,
  llmConfig: LlmConfig,
): AgentErrorKind | null {
  if (!project) return "unavailable"
  if (agentProviderNeedsApiKey(llmConfig.provider) && !llmConfig.apiKey.trim()) {
    return "missing_api_key"
  }
  return null
}

/** Classify runtime Agent failures into UI-facing error categories. */
export function classifyAgentError(message: string): AgentErrorKind {
  const lower = message.toLowerCase()
  // Permission approval timeouts are denials, not sidecar/runtime timeouts.
  // Keep this check before the generic timeout bucket.
  if (lower.includes("permission") && lower.includes("timed out")) {
    return "failed"
  }
  if (
    lower.includes("timed out") ||
    lower.includes("timeout")
  ) {
    return "timeout"
  }
  if (
    lower.includes("reached maximum number of turns") ||
    lower.includes("max_turns_exceeded")
  ) {
    return "max_turns_exceeded"
  }
  if (
    lower.includes("sidecar dist missing") ||
    lower.includes("sidecar binary missing") ||
    lower.includes("failed to spawn agent sidecar") ||
    lower.includes("agent sidecar not available") ||
    lower.includes("cannot resolve sidecar path")
  ) {
    return "unavailable"
  }
  if (
    lower.includes("api key") ||
    lower.includes("anthropic_api_key") ||
    lower.includes("authentication")
  ) {
    return "missing_api_key"
  }
  return "failed"
}

/** Map an Agent error kind to the i18n key used for assistant error content. */
export function agentErrorI18nKey(kind: AgentErrorKind): string {
  if (kind === "unavailable") return "agent.error.unavailable"
  if (kind === "missing_api_key") return "agent.error.missingApiKey"
  if (kind === "timeout") return "agent.error.timeout"
  if (kind === "max_turns_exceeded") return "agent.error.maxTurnsExceeded"
  return "agent.error.failed"
}

/** Map the current runtime Agent phase to its status-line i18n key. */
export function agentRunPhaseI18nKey(phase: AgentRunPhase): string | null {
  if (phase === "connecting") return "agent.loading.connecting"
  if (phase === "running") return "agent.loading.running"
  return null
}
