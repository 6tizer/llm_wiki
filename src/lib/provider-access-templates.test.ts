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
    expect(PROVIDER_ACCESS_TEMPLATES).toHaveLength(22)

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

  it("keeps non-local endpoints on https and local endpoints on localhost", () => {
    for (const template of PROVIDER_ACCESS_TEMPLATES) {
      if (template.group === "local") {
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
    expect(providerAccessTemplateById("longcat")?.defaultModelId).toBe("LongCat-2.0")
    expect(providerAccessTemplateById("volcengine-ark")?.defaultModelId).toBe("doubao-seed-2-1-pro-260628")
    expect(providerAccessTemplateById("openrouter")?.defaultModelId).toBe("anthropic/claude-sonnet-5")
    expect(providerAccessTemplateById("aws-bedrock")?.notes).toContain("SigV4")
  })
})
