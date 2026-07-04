/**
 * Frontend mirror of the sidecar's authoritative wiki-tool write classifier
 * (src-tauri/sidecar/src/wiki-tool-write-classifier.ts, which itself derives
 * from src-tauri/sidecar/src/agent-policy.ts's READ_WIKI_TOOLS/WRITE_WIKI_TOOLS).
 * Keep this list in sync with those two files — this codebase's established
 * pattern for sidecar/frontend shared constants is a synced duplicate (see
 * agent-types.ts's "Keep in sync with src-tauri/sidecar/src/types.ts"
 * comments) rather than a cross-package import, since the sidecar is a
 * separate Node package built independently of the Vite frontend bundle.
 *
 * Used by the SPEC-7 PR2 rewind fail-closed gate (matrix A2/A16/A17): a
 * wiki-write tool call recorded on or after the rewind target must disable
 * rewind for that target, because the SDK's native checkpoint mechanism does
 * not track the `llm_wiki` MCP server's direct filesystem writes (E2 probe).
 */

const WIKI_TOOL_PREFIX = "mcp__llm_wiki__";

const WRITE_WIKI_TOOLS = new Set<string>([
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
]);

/**
 * Conditional-write tools the READ_WIKI_TOOLS allowedTools list carries as
 * read (their default/no-arg SDK auto-approve case), but that can perform a
 * real write depending on call args (`dryRun`/`apply`). The rewind gate does
 * not parse args — it classifies these unconditionally as writes (A17).
 */
const CONDITIONAL_WRITE_WIKI_TOOLS = new Set<string>([
	"mcp__llm_wiki__merge_duplicate_group",
	"mcp__llm_wiki__okf_import",
]);

const VERIFIED_READ_ONLY_WIKI_TOOLS = new Set<string>([
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
	"mcp__llm_wiki__optimize_research_topic",
	"mcp__llm_wiki__test_provider_connection",
	"mcp__llm_wiki__okf_validate",
	"mcp__llm_wiki__okf_export",
	"mcp__llm_wiki__taxonomy_preview",
	"mcp__llm_wiki__synthesis_preview",
	"mcp__llm_wiki__get_knowledge_agents_config",
]);

/**
 * Returns true when `toolName` is a wiki-write tool call not covered by the
 * SDK's native rewindFiles checkpoint. Non-wiki tools (built-in Bash/Read/
 * Write/Edit, or any other MCP server) always return false — they're either
 * natively checkpointed or out of scope for this app. Any `mcp__llm_wiki__*`
 * name not yet classified in either list above fails closed as a write.
 */
export function isWikiWriteToolCall(toolName: string): boolean {
	if (!toolName.startsWith(WIKI_TOOL_PREFIX)) return false;
	if (CONDITIONAL_WRITE_WIKI_TOOLS.has(toolName)) return true;
	if (WRITE_WIKI_TOOLS.has(toolName)) return true;
	if (VERIFIED_READ_ONLY_WIKI_TOOLS.has(toolName)) return false;
	return true;
}
