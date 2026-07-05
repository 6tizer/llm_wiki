import type { RuntimeProfileRecord } from "@/commands/runtime-db"
import { OPENAI_COMPATIBLE_NATIVE_PROVIDER_IDS } from "@/lib/llm-providers"
import type { LlmConfig } from "@/stores/wiki-store"

/**
 * Builds a minimal secretless `LlmConfig` from a claimed model-call profile.
 * It is only used to reuse provider wire helpers (`buildBody`/`parseStream`);
 * Rust re-derives the real URL and injects the stored secret server-side.
 */
export function syntheticLlmConfig(
  profile: RuntimeProfileRecord,
  maxContextSize = 128_000,
): LlmConfig {
  const baseConfig = {
    apiKey: "",
    model: profile.modelId,
    ollamaUrl: "",
    customEndpoint: profile.endpoint ?? "",
    maxContextSize,
    reasoning: { mode: "auto" as const },
  }

  if (profile.apiMode === "anthropic-messages") {
    return { ...baseConfig, provider: "custom", apiMode: "anthropic_messages" }
  }
  if (profile.apiMode === "google-generate-content") {
    return { ...baseConfig, provider: "google" }
  }
  if (profile.apiMode === "openai-chat-completions") {
    const provider = OPENAI_COMPATIBLE_NATIVE_PROVIDER_IDS.has(profile.providerId as LlmConfig["provider"])
      ? (profile.providerId as LlmConfig["provider"])
      : "custom"
    return { ...baseConfig, provider, apiMode: "chat_completions" }
  }

  throw new Error(
    "model-call-api-mode-unsupported: profile api mode has no HTTP model-call transport",
  )
}
