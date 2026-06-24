import { describe, expect, it } from "vitest"

import { apiConfigFromDraft, initialDraft } from "../settings-view"
import { API_ENDPOINTS, buildMcpClientConfig, hasUnsavedApiConfig } from "./api-server-section"

const llm = {
  provider: "openai",
  apiKey: "",
  model: "",
  ollamaUrl: "http://localhost:11434",
  customEndpoint: "",
  maxContextSize: 204800,
}

const embedding = {
  enabled: false,
  endpoint: "",
  apiKey: "",
  model: "",
}

const multimodal = {
  enabled: false,
  useMainLlm: true,
  provider: "custom",
  apiKey: "",
  model: "",
  ollamaUrl: "http://localhost:11434",
  customEndpoint: "",
  concurrency: 4,
}

const proxy = {
  enabled: false,
  url: "",
  bypassLocal: true,
}

const scheduledImport = {
  enabled: false,
  path: "",
  interval: 60,
  lastScan: null,
}

const sourceWatch = {
  enabled: false,
  autoIngest: false,
  includeExtensions: [],
  excludeExtensions: [],
  excludeDirs: [],
  excludeGlobs: [],
  maxFileSizeMb: 10,
}

const agent = {
  maxTurns: 25,
  maxFilesChanged: 20,
  maxWriteBytes: 256 * 1024,
}

function draftFor(apiConfig: {
  enabled: boolean
  allowUnauthenticated: boolean
  mcpEnabled?: boolean
  token: string
}) {
  return initialDraft(
    llm as never,
    embedding as never,
    multimodal as never,
    "auto" as never,
    proxy,
    scheduledImport,
    sourceWatch,
    apiConfig as never,
    agent,
    20,
    "en",
  )
}

describe("API server endpoint documentation", () => {
  it("lists the project review endpoint", () => {
    expect(API_ENDPOINTS).toContainEqual({
      method: "GET",
      path: "/api/v1/projects/{id}/reviews",
      noteKey: "endpointReviewsNote",
    })
  })
})

describe("API server settings draft", () => {
  it("initializes mcpEnabled from saved config and defaults legacy configs to false", () => {
    expect(
      draftFor({
        enabled: true,
        allowUnauthenticated: false,
        mcpEnabled: true,
        token: "token",
      }).apiMcpEnabled,
    ).toBe(true)

    expect(
      draftFor({
        enabled: true,
        allowUnauthenticated: false,
        token: "legacy",
      }).apiMcpEnabled,
    ).toBe(false)
  })

  it("saves mcpEnabled and treats draft changes as unsaved", () => {
    const persisted = {
      enabled: true,
      allowUnauthenticated: false,
      mcpEnabled: false,
      token: " token ",
    }
    const draft = draftFor({
      enabled: true,
      allowUnauthenticated: false,
      mcpEnabled: true,
      token: " token ",
    })

    expect(apiConfigFromDraft(draft)).toEqual({
      enabled: true,
      allowUnauthenticated: false,
      mcpEnabled: true,
      token: "token",
    })
    expect(hasUnsavedApiConfig(persisted, draft)).toBe(true)
  })

  it("uses an environment placeholder instead of the real API token in MCP config", () => {
    const config = buildMcpClientConfig("/app/mcp-server/dist/src/index.js", false)

    expect(config).toContain('"LLM_WIKI_API_TOKEN": "<set-this-in-your-mcp-client-env>"')
    expect(config).not.toContain("super-secret-token")
  })
})
