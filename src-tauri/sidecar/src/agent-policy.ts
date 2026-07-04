import { createHash } from "node:crypto";

export type AgentPermissionPolicy =
	| "default"
	| "restricted"
	| "bypass"
	| "acceptEdits"
	| "bypassPermissions"
	| "plan"
	| "dontAsk"
	| "auto";

export const READ_WIKI_TOOLS = [
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
] as const;

export const WRITE_WIKI_TOOLS = [
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
] as const;

const WIKI_TOOL_NAMES = new Set<string>([
	...READ_WIKI_TOOLS,
	...WRITE_WIKI_TOOLS,
]);

const WRITE_TOOL_NAMES = new Set<string>(WRITE_WIKI_TOOLS);

/**
 * Returns the tool names safe to pass in the SDK's `allowedTools` option
 * (bare, unconditional auto-approval, no `canUseTool` involvement).
 *
 * Write tools are always excluded, regardless of write-tool enablement:
 * confirmed against the SDK 0.3.201 runtime (`sdk.mjs`, function that
 * emits the `CLAUDE_SDK_CAN_USE_TOOL_SHADOWED` warning), a bare entry in
 * `allowedTools` "auto-approve[s] the whole tool before the callback is
 * consulted" — i.e. it would skip `canUseTool` entirely and make the
 * "default" policy's write-tool approval prompt unreachable. Write-tool
 * gating is handled exclusively by `resolveWikiToolDecision`, invoked from
 * both `canUseTool` (core.ts) and the PreToolUse hook (agent-hooks.ts).
 */
export function getAllowedWikiTools(args: {
	wikiToolsEnabled: boolean;
}): string[] {
	if (!args.wikiToolsEnabled) return [];
	return [...READ_WIKI_TOOLS];
}

export function buildPermissionOptions(policy: AgentPermissionPolicy = "default") {
	if (policy === "restricted") {
		return {
			tools: [] as string[],
			permissionMode: "dontAsk" as const,
		};
	}
	if (policy === "bypass" || policy === "bypassPermissions") {
		return {
			permissionMode: "bypassPermissions" as const,
			allowDangerouslySkipPermissions: true,
		};
	}
	if (
		policy === "acceptEdits" ||
		policy === "plan" ||
		policy === "dontAsk" ||
		policy === "auto"
	) {
		return {
			permissionMode: policy,
		};
	}
	return {
		permissionMode: "default" as const,
	};
}

export function isWikiToolName(toolName: string): boolean {
	return WIKI_TOOL_NAMES.has(toolName);
}

export function isWriteWikiToolName(toolName: string): boolean {
	return WRITE_TOOL_NAMES.has(toolName);
}

/**
 * Single-point decision for whether a Wiki tool call may proceed.
 *
 * - "allow": fast-path approve, no user prompt (read tools, or write tools
 *   under a policy that explicitly bypasses approval).
 * - "deny": fast-path reject, no user prompt (not a Wiki tool, writes
 *   disabled, or policy is "restricted").
 * - "ask": must be routed through the permission bridge / approval dialog
 *   before proceeding (the "default" policy for write tools).
 *
 * Both canUseTool (core.ts) and the PreToolUse hook (agent-hooks.ts) must
 * call this instead of duplicating the policy logic, so the two gates can
 * never disagree.
 */
export type WikiToolDecision =
	| { decision: "allow" }
	| { decision: "deny"; reason: string }
	| { decision: "ask" };

export function resolveWikiToolDecision(args: {
	toolName: string;
	enableWriteTools: boolean;
	permissionPolicy: AgentPermissionPolicy;
}): WikiToolDecision {
	if (!isWikiToolName(args.toolName)) {
		return { decision: "deny", reason: "Tool is not an LLM Wiki tool" };
	}
	if (!isWriteWikiToolName(args.toolName)) {
		return { decision: "allow" };
	}
	if (!args.enableWriteTools) {
		return { decision: "deny", reason: "Wiki write tools are disabled" };
	}
	if (args.permissionPolicy === "restricted") {
		return { decision: "deny", reason: "Wiki write tools are restricted" };
	}
	if (
		args.permissionPolicy === "bypass" ||
		args.permissionPolicy === "bypassPermissions"
	) {
		return { decision: "allow" };
	}
	return { decision: "ask" };
}

export function previewToolInput(input: unknown): Record<string, unknown> {
	if (!input || typeof input !== "object" || Array.isArray(input)) return {};
	const source = input as Record<string, unknown>;
	const preview: Record<string, unknown> = {};
	for (const key of [
		"path",
		"root",
		"recursive",
		"maxFiles",
		"query",
		"topK",
		"includeContent",
		"q",
		"limit",
		"name",
		"pathHint",
		"mode",
		"expectedSha256",
		"dryRun",
		"includeSemantic",
		"taskId",
		"topic",
		"searchQueries",
		"queries",
		"sourceMode",
		"sourcePath",
		"folderContext",
		"forceRecaption",
		"slugs",
		"canonicalSlug",
		"gapTitle",
		"gapType",
		"sourceDir",
		"apply",
		"action",
		"dimension",
		"targetTag",
		"targetTags",
		"minClusterSize",
		"maxCandidates",
	]) {
		if (source[key] !== undefined) preview[key] = source[key];
	}
	if (source.group && typeof source.group === "object" && !Array.isArray(source.group)) {
		const group = source.group as Record<string, unknown>;
		preview.group = {
			slugs: group.slugs,
			confidence: group.confidence,
		};
	}
	if (typeof source.contents === "string") {
		addTextDigest(preview, "contents", source.contents);
	}
	if (typeof source.overview === "string") {
		addTextDigest(preview, "overview", source.overview);
	}
	if (typeof source.purpose === "string") {
		addTextDigest(preview, "purpose", source.purpose);
	}
	return preview;
}

function addTextDigest(
	preview: Record<string, unknown>,
	key: string,
	value: string,
): void {
	preview[`${key}Bytes`] = Buffer.byteLength(value, "utf8");
	preview[`${key}Sha256`] = createHash("sha256")
		.update(value)
		.digest("hex");
}
