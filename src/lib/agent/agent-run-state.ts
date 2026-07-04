import type { LlmConfig } from "@/stores/wiki-store"
import type { WikiProject } from "@/types/wiki"

export type AgentErrorKind =
  | "unavailable"
  | "missing_api_key"
  | "profile_unavailable"
  | "timeout"
  | "max_turns_exceeded"
  | "model_not_found"
  | "network"
  | "failed"
export type AgentRunPhase = "idle" | "connecting" | "running"

export class AgentRunError extends Error {
  readonly kind: AgentErrorKind

  constructor(kind: AgentErrorKind, message: string) {
    super(message)
    this.name = "AgentRunError"
    this.kind = kind
  }
}

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
  options: { deferApiKeyCheck?: boolean } = {},
): AgentErrorKind | null {
  if (!project) return "unavailable"
  if (
    !options.deferApiKeyCheck &&
    agentProviderNeedsApiKey(llmConfig.provider) &&
    !llmConfig.apiKey.trim()
  ) {
    return "missing_api_key"
  }
  return null
}

/** Classify runtime Agent failures into UI-facing error categories. */
export function classifyAgentError(message: string): AgentErrorKind {
  const lower = message.toLowerCase()
  if (
    lower.includes("profile-unavailable") ||
    lower.includes("no-eligible-profile") ||
    lower.includes("profile circuit") ||
    lower.includes("profile capacity")
  ) {
    return "profile_unavailable"
  }
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
    lower.includes("model not found") ||
    lower.includes("unknown model") ||
    lower.includes("model is not supported") ||
    lower.includes("model not supported") ||
    lower.includes("not a supported model") ||
    (lower.includes("model") && lower.includes("does not exist")) ||
    // Claude Code CLI's own wording for a bad --model value — the exact
    // text observed in production (SPEC-12 audit A3, deepseek-v4-flash).
    lower.includes("issue with the selected model") ||
    (lower.includes("model") && lower.includes("may not exist")) ||
    lower.includes("no such model")
  ) {
    return "model_not_found"
  }
  if (
    lower.includes("econnrefused") ||
    lower.includes("fetch failed") ||
    lower.includes("etimedout") ||
    lower.includes("dns lookup") ||
    lower.includes("getaddrinfo") ||
    lower.includes("enotfound") ||
    lower.includes("network error") ||
    lower.includes("network request failed")
  ) {
    return "network"
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
    lower.includes("authentication") ||
    lower.includes("profile-missing-secret") ||
    lower.includes("profile-secret-read-failed") ||
    lower.includes("profile-secret-not-found")
  ) {
    return "missing_api_key"
  }
  return "failed"
}

/** Return an explicit Agent error kind when code raised a typed AgentRunError. */
export function agentErrorKindFromError(err: unknown): AgentErrorKind {
  if (err instanceof AgentRunError) return err.kind
  const message = err instanceof Error ? err.message : String(err)
  return classifyAgentError(message)
}

/** Map the current runtime Agent phase to its status-line i18n key. */
export function agentRunPhaseI18nKey(phase: AgentRunPhase): string | null {
  if (phase === "connecting") return "agent.loading.connecting"
  if (phase === "running") return "agent.loading.running"
  return null
}
