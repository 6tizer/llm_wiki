import { READ_WIKI_TOOLS, WRITE_WIKI_TOOLS } from "./agent-policy.js";

/** Prefix shared by every tool the `llm_wiki` MCP server registers. */
const WIKI_TOOL_PREFIX = "mcp__llm_wiki__";

/**
 * Wiki tools whose read/write behavior depends on call-time arguments
 * (`dryRun`/`apply`) rather than the tool name alone. `agent-policy.ts`'s
 * READ_WIKI_TOOLS list carries them as read (its `allowedTools` bare-approve
 * list only cares about the SDK's default no-arg case), but the rewind
 * fail-closed gate (SPEC-7 PR2, matrix A17) cannot afford to parse args to
 * decide — a missed/misread arg would silently pass a real write. Both are
 * therefore classified as write unconditionally here, regardless of the
 * actual dryRun/apply value in a given call.
 */
const CONDITIONAL_WRITE_WIKI_TOOLS = new Set<string>([
	"mcp__llm_wiki__merge_duplicate_group",
	"mcp__llm_wiki__okf_import",
]);

/**
 * Wiki tools verified (by reading each handler in agent-app-tools.ts) to
 * never write project files: collect_research_sources (network search only),
 * optimize_research_topic (reads overview/purpose + LLM call, no write),
 * taxonomy_preview (preview-only variant of taxonomy_apply, no write),
 * synthesis_preview (candidate discovery, no write) — plus the rest of
 * agent-policy's READ_WIKI_TOOLS, EXCLUDING merge_duplicate_group which is
 * conditional (see above).
 */
const VERIFIED_READ_ONLY_WIKI_TOOLS = new Set<string>(
	READ_WIKI_TOOLS.filter((name) => !CONDITIONAL_WRITE_WIKI_TOOLS.has(name)),
);

const KNOWN_WRITE_WIKI_TOOLS = new Set<string>(WRITE_WIKI_TOOLS);

/**
 * Single-authority classifier for the rewind fail-closed gate (SPEC-7 PR2):
 * does this tool call represent a wiki-file write that the SDK's native
 * checkpoint/rewindFiles mechanism does NOT cover? (E2 probe: native
 * checkpointing only tracks the CLI's own built-in Write/Edit tools; the
 * `llm_wiki` MCP server's write tools call `fs.writeFileSync` directly and
 * are invisible to it — rewindFiles reports `canRewind:true` vacuously and
 * leaves those files unchanged.)
 *
 * Built-in tools (Bash, Read, Write, Edit, ...) and any tool from an MCP
 * server other than `llm_wiki` are NOT this gate's concern — they're either
 * covered by native checkpointing or don't exist in this app — so they
 * return `false` (not a gated write).
 *
 * Fail-closed by construction: any `mcp__llm_wiki__*` name not on record in
 * either wiki-tool list (a future tool added to the MCP server before this
 * classifier is updated) is treated as a write, per r2 P3 in the design.
 */
export function isWikiWriteToolCall(toolName: string): boolean {
	if (!toolName.startsWith(WIKI_TOOL_PREFIX)) return false;
	if (CONDITIONAL_WRITE_WIKI_TOOLS.has(toolName)) return true;
	if (KNOWN_WRITE_WIKI_TOOLS.has(toolName)) return true;
	if (VERIFIED_READ_ONLY_WIKI_TOOLS.has(toolName)) return false;
	return true;
}
