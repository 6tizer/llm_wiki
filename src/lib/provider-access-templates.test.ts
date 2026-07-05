import { describe, expect, it } from "vitest"
import {
  PROVIDER_ACCESS_TEMPLATES,
  providerAccessTemplateById,
  type ProviderAccessTemplateGroup,
} from "./provider-access-templates"

const GROUPS: ProviderAccessTemplateGroup[] = [
  "intl-official",
  "cn-official",
  "cloud",
  "local",
  "gateway",
]

const API_MODES = [
  "openai-chat-completions",
  "anthropic-messages",
  "google-generate-content",
  "local-cli",
]

const AUTH_STYLES = [
  "none",
  "bearer",
  "x-api-key",
  "api-key",
  "oauth-local-cli",
]

describe("provider access templates", () => {
  it("keeps ids unique and every group populated", () => {
    const ids = PROVIDER_ACCESS_TEMPLATES.map((template) => template.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(PROVIDER_ACCESS_TEMPLATES).toHaveLength(28)

    for (const group of GROUPS) {
      expect(PROVIDER_ACCESS_TEMPLATES.some((template) => template.group === group)).toBe(true)
    }
  })

  it("uses valid runtime api/auth values", () => {
    for (const template of PROVIDER_ACCESS_TEMPLATES) {
      expect(API_MODES).toContain(template.apiMode)
      expect(AUTH_STYLES).toContain(template.authStyle)
    }
  })

  it("keeps endpoints compatible with their transport", () => {
    for (const template of PROVIDER_ACCESS_TEMPLATES) {
      if (template.apiMode === "local-cli") {
        expect(template.endpoint).toBe("")
        continue
      }
      if (template.id === "ollama" || template.id === "lm-studio") {
        expect(template.endpoint).toMatch(/^http:\/\/localhost:/)
        continue
      }
      expect(template.endpoint).toMatch(/^https:\/\//)
    }
  })

  it("keeps agent presets consistent with Anthropic Messages mode", () => {
    for (const template of PROVIDER_ACCESS_TEMPLATES) {
      if (template.agentSupport === "anthropic-compat") {
        expect(template.apiMode).toBe("anthropic-messages")
        expect(template.agentSdkModelId).toBeTruthy()
      } else {
        expect(template.suggestedTaskFamilies).not.toContain("agent")
      }
    }
  })

  it("keeps source-verified model and endpoint corrections", () => {
    expect(providerAccessTemplateById("kuaishou-kat-coder")).toMatchObject({
      endpoint: "https://vanchin.streamlake.ai/api/gateway/v1/endpoints/{ENDPOINT_ID}/claude-code-proxy",
      defaultModelId: "KAT-Coder-Pro V1",
    })
    expect(providerAccessTemplateById("longcat")?.defaultModelId).toBe("LongCat-Flash-Chat")
    expect(providerAccessTemplateById("volcengine-ark")?.defaultModelId).toBe("doubao-seed-2-1-pro-260628")
    expect(providerAccessTemplateById("openrouter")?.defaultModelId).toBe("anthropic/claude-sonnet-5")
    expect(providerAccessTemplateById("aws-bedrock")?.notes).toContain("SigV4")
    expect(providerAccessTemplateById("deepseek")).toMatchObject({
      endpoint: "https://api.deepseek.com/anthropic",
      modelsUrl: "https://api.deepseek.com/models",
    })
  })

  it("includes legacy-only model-call providers and local CLI templates", () => {
    expect(providerAccessTemplateById("groq")).toMatchObject({
      group: "intl-official",
      endpoint: "https://api.groq.com/openai/v1",
      apiMode: "openai-chat-completions",
      agentSupport: "none",
    })
    expect(providerAccessTemplateById("xai")).toMatchObject({
      group: "intl-official",
      endpoint: "https://api.x.ai/v1",
      apiMode: "openai-chat-completions",
      agentSupport: "none",
    })
    expect(providerAccessTemplateById("nvidia-nim")).toMatchObject({
      group: "gateway",
      endpoint: "https://integrate.api.nvidia.com/v1",
      apiMode: "openai-chat-completions",
      agentSupport: "none",
    })
    expect(providerAccessTemplateById("ollama-cloud")).toMatchObject({
      group: "local",
      endpoint: "https://ollama.com/v1",
      apiMode: "openai-chat-completions",
      agentSupport: "none",
    })
    for (const id of ["claude-code-cli", "codex-cli"]) {
      expect(providerAccessTemplateById(id)).toMatchObject({
        group: "local",
        endpoint: "",
        apiMode: "local-cli",
        authStyle: "oauth-local-cli",
        agentSupport: "none",
      })
    }
  })

  it("folds legacy regional variants into endpoint candidates", () => {
    expect(providerAccessTemplateById("kimi")?.endpointCandidates)
      .toEqual(["https://api.moonshot.cn/anthropic", "https://api.moonshot.ai/anthropic"])
    expect(providerAccessTemplateById("minimax")?.endpointCandidates)
      .toEqual(["https://api.minimaxi.com/anthropic", "https://api.minimax.io/anthropic"])
    expect(providerAccessTemplateById("dashscope")?.endpointCandidates)
      .toContain("https://coding.dashscope.aliyuncs.com/apps/anthropic")
  })
})
