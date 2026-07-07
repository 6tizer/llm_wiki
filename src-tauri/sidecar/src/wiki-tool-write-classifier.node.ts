import assert from "node:assert/strict";
import test from "node:test";
import { isWikiWriteToolCall } from "./wiki-tool-write-classifier.js";

test("known write wiki tools are classified as writes", () => {
	assert.equal(isWikiWriteToolCall("mcp__llm_wiki__update_page"), true);
	assert.equal(isWikiWriteToolCall("mcp__llm_wiki__create_entity"), true);
	assert.equal(isWikiWriteToolCall("mcp__llm_wiki__run_deep_research"), true);
	assert.equal(isWikiWriteToolCall("mcp__llm_wiki__run_pipeline"), true);
});

test("verified read-only wiki tools are classified as reads (A17 verification set)", () => {
	assert.equal(isWikiWriteToolCall("mcp__llm_wiki__collect_research_sources"), false);
	assert.equal(isWikiWriteToolCall("mcp__llm_wiki__optimize_research_topic"), false);
	assert.equal(isWikiWriteToolCall("mcp__llm_wiki__taxonomy_preview"), false);
	assert.equal(isWikiWriteToolCall("mcp__llm_wiki__synthesis_preview"), false);
	assert.equal(isWikiWriteToolCall("mcp__llm_wiki__sweep_reviews"), false);
	assert.equal(isWikiWriteToolCall("mcp__llm_wiki__list_pages"), false);
	assert.equal(isWikiWriteToolCall("mcp__llm_wiki__read_page"), false);
});

test("conditional-write wiki tools are always classified as writes regardless of policy READ listing (A17)", () => {
	assert.equal(isWikiWriteToolCall("mcp__llm_wiki__merge_duplicate_group"), true);
	assert.equal(isWikiWriteToolCall("mcp__llm_wiki__okf_import"), true);
});

test("unknown wiki tool names fail closed as writes", () => {
	assert.equal(isWikiWriteToolCall("mcp__llm_wiki__some_future_tool"), true);
});

test("non-wiki tool calls (built-in or other MCP servers) are not this gate's concern", () => {
	assert.equal(isWikiWriteToolCall("Bash"), false);
	assert.equal(isWikiWriteToolCall("Write"), false);
	assert.equal(isWikiWriteToolCall("Read"), false);
	assert.equal(isWikiWriteToolCall("mcp__other_server__write_thing"), false);
});
