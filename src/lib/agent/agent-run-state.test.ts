import { describe, expect, it } from "vitest"
import {
  AgentRunError,
  agentErrorKindFromError,
  agentRunPhaseI18nKey,
  agentProviderNeedsApiKey,
  classifyAgentError,
  getAgentPreflightError,
} from "./agent-run-state"
import type { LlmConfig } from "@/stores/wiki-store"
import type { WikiProject } from "@/types/wiki"

function llmConfig(overrides: Partial<LlmConfig> = {}): LlmConfig {
  return {
    provider: "anthropic",
    apiKey: "test-key",
    model: "claude-sonnet",
    ollamaUrl: "http://localhost:11434",
    customEndpoint: "",
    maxContextSize: 200000,
    ...overrides,
  }
}

const project: WikiProject = {
  id: "project-1",
  name: "Test",
  path: "/tmp/wiki",
}

describe("agent run state helpers", () => {
  it("requires API keys only for hosted providers", () => {
    expect(agentProviderNeedsApiKey("anthropic")).toBe(true)
    expect(agentProviderNeedsApiKey("openai")).toBe(true)
    expect(agentProviderNeedsApiKey("ollama")).toBe(false)
    expect(agentProviderNeedsApiKey("claude-code")).toBe(false)
    expect(agentProviderNeedsApiKey("codex-cli")).toBe(false)
    expect(agentProviderNeedsApiKey("custom")).toBe(false)
  })

  it("classifies preflight failures", () => {
    expect(getAgentPreflightError(null, llmConfig())).toBe("unavailable")
    expect(getAgentPreflightError(project, llmConfig({ apiKey: "" }))).toBe("missing_api_key")
    expect(
      getAgentPreflightError(project, llmConfig({ apiKey: "" }), {
        deferApiKeyCheck: true,
      }),
    ).toBeNull()
    expect(getAgentPreflightError(project, llmConfig({ provider: "custom", apiKey: "" }))).toBeNull()
    expect(getAgentPreflightError(project, llmConfig({ provider: "ollama", apiKey: "" }))).toBeNull()
  })

  it("classifies runtime errors", () => {
    expect(classifyAgentError("Agent sidecar dist missing")).toBe("unavailable")
    expect(classifyAgentError("Agent sidecar binary missing")).toBe("unavailable")
    expect(classifyAgentError("Failed to spawn agent sidecar: denied")).toBe("unavailable")
    expect(classifyAgentError("Timed out waiting for Agent rewind result")).toBe("timeout")
    expect(classifyAgentError("Request timeout")).toBe("timeout")
    expect(classifyAgentError("Permission request timed out: wiki_write")).toBe("failed")
    expect(classifyAgentError("Reached maximum number of turns (10)")).toBe("max_turns_exceeded")
    expect(classifyAgentError("model not found: deepseek-chat")).toBe("model_not_found")
    expect(classifyAgentError("Unknown model 'deepseek-reasoner'")).toBe("model_not_found")
    expect(
      classifyAgentError(
        "There's an issue with the selected model (deepseek-v4-flash). It may not exist or you may not have access to it. Run --model to pick a different model.",
      ),
    ).toBe("model_not_found")
    expect(classifyAgentError("session does not exist")).toBe("failed")
    expect(classifyAgentError("file does not exist")).toBe("failed")
    expect(classifyAgentError("TypeError: fetch failed")).toBe("network")
    expect(classifyAgentError("connect ECONNREFUSED 127.0.0.1:11434")).toBe("network")
    expect(classifyAgentError("failed to open /tmp/dns-cache.json")).toBe("failed")
    expect(classifyAgentError("ANTHROPIC_API_KEY is missing")).toBe("missing_api_key")
    expect(classifyAgentError("profile-secret-not-found: test secret missing")).toBe("missing_api_key")
    expect(classifyAgentError("no-eligible-profile: no profile pool capacity is available")).toBe("profile_unavailable")
    expect(classifyAgentError("boom")).toBe("failed")
  })

  it("prefers typed Agent run errors over string classification", () => {
    const err = new AgentRunError("profile_unavailable", "provider timeout")

    expect(agentErrorKindFromError(err)).toBe("profile_unavailable")
    expect(agentErrorKindFromError(new Error("Request timeout"))).toBe("timeout")
  })

  it("maps run phases to loading i18n keys", () => {
    expect(agentRunPhaseI18nKey("connecting")).toBe("agent.loading.connecting")
    expect(agentRunPhaseI18nKey("running")).toBe("agent.loading.running")
    expect(agentRunPhaseI18nKey("idle")).toBeNull()
  })
})
