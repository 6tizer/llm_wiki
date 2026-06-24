import assert from "node:assert/strict"
import { test } from "node:test"
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js"
import {
  handleToolCall,
  type LlmWikiClientLike,
} from "../src/index.js"

function disabledClient(): LlmWikiClientLike {
  const blocked = async () => {
    throw new Error("protected API method should not be called while MCP is disabled")
  }
  return {
    health: async () => ({ ok: true, status: "running", mcpEnabled: false }),
    projects: blocked,
    files: blocked,
    fileContent: blocked,
    reviews: blocked,
    search: blocked,
    graph: blocked,
    rescan: blocked,
  }
}

test("llm_wiki_status works even when MCP access is disabled", async () => {
  const result = await handleToolCall("llm_wiki_status", {}, disabledClient())
  const text = result.content[0]?.text ?? ""

  assert.match(text, /"mcpEnabled": false/)
  assert.doesNotMatch(text, /"projects"/)
  assert.doesNotMatch(text, /"currentProject"/)
})

test("protected MCP tools reject when MCP access is disabled", async () => {
  const protectedTools = [
    "llm_wiki_projects",
    "llm_wiki_files",
    "llm_wiki_read_file",
    "llm_wiki_reviews",
    "llm_wiki_search",
    "llm_wiki_graph",
    "llm_wiki_rescan_sources",
  ]

  for (const toolName of protectedTools) {
    await assert.rejects(
      () => handleToolCall(toolName, {}, disabledClient()),
      (err) =>
        err instanceof McpError &&
        err.code === ErrorCode.InvalidRequest &&
        err.message.includes("MCP access is disabled"),
      toolName,
    )
  }
})
