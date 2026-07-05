import { describe, expect, it } from "vitest"

import { apiConfigFromDraft, initialDraft } from "../settings-view"
import { API_ENDPOINTS, MCP_TOOL_CATALOG, buildMcpClientConfig, hasUnsavedApiConfig } from "./api-server-section"

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

const mineru = {
  enabled: false,
  token: "",
  modelVersion: "vlm",
  apiBaseUrl: "",
}

const agent = {
  maxTurns: 25,
  maxFilesChanged: 20,
  maxFilesChangedEnabled: false,
  maxWriteBytes: 256 * 1024,
  defaultPermissionPolicy: "default" as const,
}

function draftFor(apiConfig: {
  enabled: boolean
  allowUnauthenticated: boolean
  mcpEnabled?: boolean
  token: string
}) {
  return initialDraft(
    "auto" as never,
    proxy,
    scheduledImport,
    sourceWatch,
    mineru as never,
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

  it("lists OKF and Knowledge Wiki MCP tools", () => {
    expect(MCP_TOOL_CATALOG).toEqual([
      { name: "okf_validate", mode: "read", noteKey: "mcpToolOkfValidateNote" },
      { name: "okf_export", mode: "read", noteKey: "mcpToolOkfExportNote" },
      { name: "okf_import", mode: "write", noteKey: "mcpToolOkfImportNote" },
      { name: "taxonomy_preview", mode: "read", noteKey: "mcpToolTaxonomyPreviewNote" },
      { name: "taxonomy_apply", mode: "write", noteKey: "mcpToolTaxonomyApplyNote" },
      { name: "taxonomy_rollback", mode: "write", noteKey: "mcpToolTaxonomyRollbackNote" },
      { name: "synthesis_preview", mode: "read", noteKey: "mcpToolSynthesisPreviewNote" },
      { name: "get_knowledge_agents_config", mode: "read", noteKey: "mcpToolKnowledgeAgentsConfigNote" },
    ])
    expect(API_ENDPOINTS.map((endpoint) => endpoint.path)).not.toContain("/api/v1/projects/{id}/okf/export")
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
