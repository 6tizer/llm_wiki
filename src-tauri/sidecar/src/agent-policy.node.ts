import assert from "node:assert/strict";
import test from "node:test";
import {
	buildPermissionOptions,
	getAllowedWikiTools,
	previewToolInput,
	resolveWikiToolDecision,
} from "./agent-policy.js";

test("default permission policy keeps built-in Claude Code tools available", () => {
	assert.deepEqual(buildPermissionOptions("default"), {
		permissionMode: "default",
	});
});

test("restricted permission policy only allows pre-approved tools", () => {
	assert.deepEqual(buildPermissionOptions("restricted"), {
		tools: [],
		permissionMode: "dontAsk",
	});
});

test("bypass permission policy requires explicit dangerous flag", () => {
	assert.deepEqual(buildPermissionOptions("bypass"), {
		permissionMode: "bypassPermissions",
		allowDangerouslySkipPermissions: true,
	});
	assert.deepEqual(buildPermissionOptions("bypassPermissions"), {
		permissionMode: "bypassPermissions",
		allowDangerouslySkipPermissions: true,
	});
});

test("SDK-native permission policies pass through", () => {
	assert.deepEqual(buildPermissionOptions("acceptEdits"), {
		permissionMode: "acceptEdits",
	});
	assert.deepEqual(buildPermissionOptions("plan"), {
		permissionMode: "plan",
	});
	assert.deepEqual(buildPermissionOptions("dontAsk"), {
		permissionMode: "dontAsk",
	});
	assert.deepEqual(buildPermissionOptions("auto"), {
		permissionMode: "auto",
	});
});

test("allowed Wiki tools follow write mode", () => {
	assert.deepEqual(
		getAllowedWikiTools({ wikiToolsEnabled: false }),
		[],
	);
	assert.deepEqual(
		getAllowedWikiTools({ wikiToolsEnabled: true }),
		[
			"mcp__llm_wiki__list_projects",
			"mcp__llm_wiki__list_pages",
			"mcp__llm_wiki__read_page",
			"mcp__llm_wiki__search_pages",
			"mcp__llm_wiki__get_graph",
			"mcp__llm_wiki__build_answer_context",
			"mcp__llm_wiki__run_lint",
			"mcp__llm_wiki__collect_research_sources",
			"mcp__llm_wiki__get_agent_task_status",
			"mcp__llm_wiki__detect_duplicates",
			"mcp__llm_wiki__merge_duplicate_group",
			"mcp__llm_wiki__optimize_research_topic",
			"mcp__llm_wiki__test_provider_connection",
			"mcp__llm_wiki__okf_validate",
			"mcp__llm_wiki__okf_export",
			"mcp__llm_wiki__taxonomy_preview",
			"mcp__llm_wiki__synthesis_preview",
			"mcp__llm_wiki__get_knowledge_agents_config",
		],
	);
});

test("allowed Wiki tools never bare-allow write tools, even with writes enabled (SDK 0.3.198+ canUseTool shadowing)", () => {
	// A bare entry in the SDK's `allowedTools` auto-approves the tool call
	// and skips `canUseTool` entirely (SDK 0.3.201 `CLAUDE_SDK_CAN_USE_TOOL_SHADOWED`
	// warning). Write tools must therefore never appear here regardless of
	// `enableWriteTools`, or the "default" policy's ask-approval for writes
	// would be silently bypassed. Gating instead happens exclusively via
	// `resolveWikiToolDecision` in canUseTool (core.ts) and the PreToolUse
	// hook (agent-hooks.ts).
	const allowed = getAllowedWikiTools({ wikiToolsEnabled: true });
	for (const writeTool of [
		"mcp__llm_wiki__update_page",
		"mcp__llm_wiki__create_entity",
		"mcp__llm_wiki__create_concept",
		"mcp__llm_wiki__save_query_page",
		"mcp__llm_wiki__run_deep_research",
		"mcp__llm_wiki__ingest_source",
		"mcp__llm_wiki__caption_source_images",
		"mcp__llm_wiki__fix_lint_result",
		"mcp__llm_wiki__fix_lint_report",
		"mcp__llm_wiki__run_lint_and_report",
		"mcp__llm_wiki__enrich_wikilinks",
		"mcp__llm_wiki__wiki_synthesis",
		"mcp__llm_wiki__run_pipeline",
		"mcp__llm_wiki__autofill_properties",
		"mcp__llm_wiki__sweep_reviews",
		"mcp__llm_wiki__okf_import",
		"mcp__llm_wiki__taxonomy_apply",
		"mcp__llm_wiki__taxonomy_rollback",
	]) {
		assert.ok(
			!allowed.includes(writeTool),
			`${writeTool} must not be bare-allowed; it would shadow canUseTool`,
		);
	}
	// Read tools are still bare-allowed (no approval prompt needed for them).
	assert.ok(allowed.includes("mcp__llm_wiki__read_page"));
});

test("wiki tool decision denies non-wiki tools and disabled writes", () => {
	assert.deepEqual(
		resolveWikiToolDecision({
			toolName: "Bash",
			enableWriteTools: true,
			permissionPolicy: "default",
		}),
		{ decision: "deny", reason: "Tool is not an LLM Wiki tool" },
	);
	for (const toolName of [
		"mcp__llm_wiki__update_page",
		"mcp__llm_wiki__ingest_source",
		"mcp__llm_wiki__run_deep_research",
		"mcp__llm_wiki__sweep_reviews",
		"mcp__llm_wiki__okf_import",
	]) {
		assert.deepEqual(
			resolveWikiToolDecision({
				toolName,
				enableWriteTools: false,
				permissionPolicy: "default",
			}),
			{ decision: "deny", reason: "Wiki write tools are disabled" },
		);
	}
});

test("wiki tool decision fast-path allows read tools regardless of policy", () => {
	for (const permissionPolicy of [
		"default",
		"restricted",
		"bypass",
		"bypassPermissions",
	] as const) {
		assert.deepEqual(
			resolveWikiToolDecision({
				toolName: "mcp__llm_wiki__read_page",
				enableWriteTools: false,
				permissionPolicy,
			}),
			{ decision: "allow" },
		);
		assert.deepEqual(
			resolveWikiToolDecision({
				toolName: "mcp__llm_wiki__merge_duplicate_group",
				enableWriteTools: true,
				permissionPolicy,
			}),
			{ decision: "allow" },
		);
	}
});

test("wiki tool decision routes write tools through the permission bridge under the default and SDK-native ask-style policies", () => {
	// The SDK only skips canUseTool entirely for "bypassPermissions" — every
	// other permissionMode (including acceptEdits/plan/dontAsk/auto) still
	// invokes canUseTool, so resolveWikiToolDecision's "ask" fallthrough is
	// live code for all of them, not just "default".
	for (const permissionPolicy of [
		"default",
		"acceptEdits",
		"plan",
		"dontAsk",
		"auto",
	] as const) {
		assert.deepEqual(
			resolveWikiToolDecision({
				toolName: "mcp__llm_wiki__update_page",
				enableWriteTools: true,
				permissionPolicy,
			}),
			{ decision: "ask" },
		);
		assert.deepEqual(
			resolveWikiToolDecision({
				toolName: "mcp__llm_wiki__run_pipeline",
				enableWriteTools: true,
				permissionPolicy,
			}),
			{ decision: "ask" },
		);
	}
});

test("wiki tool decision denies write tools under the restricted policy even when writes are enabled", () => {
	assert.deepEqual(
		resolveWikiToolDecision({
			toolName: "mcp__llm_wiki__update_page",
			enableWriteTools: true,
			permissionPolicy: "restricted",
		}),
		{ decision: "deny", reason: "Wiki write tools are restricted" },
	);
});

test("wiki tool decision allows write tools without prompting under bypass policies", () => {
	for (const permissionPolicy of ["bypass", "bypassPermissions"] as const) {
		assert.deepEqual(
			resolveWikiToolDecision({
				toolName: "mcp__llm_wiki__update_page",
				enableWriteTools: true,
				permissionPolicy,
			}),
			{ decision: "allow" },
		);
	}
});

test("tool input preview omits raw contents", () => {
	const preview = previewToolInput({
		path: "wiki/entities/example.md",
		contents: "hello",
		overview: "# Private overview",
		purpose: "# Private purpose",
		mode: "replace",
	});

	assert.equal(preview.path, "wiki/entities/example.md");
	assert.equal(preview.mode, "replace");
	assert.equal(preview.contents, undefined);
	assert.equal(preview.contentsBytes, 5);
	assert.equal(typeof preview.contentsSha256, "string");
	assert.equal(preview.overview, undefined);
	assert.equal(preview.purpose, undefined);
	assert.equal(preview.overviewBytes, 18);
	assert.equal(preview.purposeBytes, 17);
	assert.equal(typeof preview.overviewSha256, "string");
	assert.equal(typeof preview.purposeSha256, "string");
});
