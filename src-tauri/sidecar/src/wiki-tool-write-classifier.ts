import { READ_WIKI_TOOLS, WRITE_WIKI_TOOLS } from "./agent-policy.js";

/** Prefix shared by every tool the `llm_wiki` MCP server registers. */
const WIKI_TOOL_PREFIX = "mcp__llm_wiki__";

/**
 * Wiki tools whose read/write behavior depends on call-time arguments
 * (`dryRun`/`apply`) rather than the tool name alone, AND that
 * `agent-policy.ts` carries in READ_WIKI_TOOLS (its `allowedTools`
 * bare-approve list only cares about the SDK's default no-arg case). The
 * rewind fail-closed gate (SPEC-7 PR2, matrix A17) cannot afford to parse
 * args to decide — a missed/misread arg would silently pass a real write —
 * so this overrides the READ classification to write unconditionally.
 *
 * `okf_import` is the same kind of conditional-write tool (`apply:true`
 * writes) but does NOT need an entry here: agent-policy.ts already lists it
 * in WRITE_WIKI_TOOLS, so KNOWN_WRITE_WIKI_TOOLS below already classifies it
 * as a write unconditionally — adding it here too would be a redundant
 * second source of truth for the same verdict (review-round P3).
 */
const CONDITIONAL_WRITE_WIKI_TOOLS = new Set<string>([
	"mcp__llm_wiki__merge_duplicate_group",
]);

const NON_WIKI_FILE_WRITE_TOOLS = new Set<string>([
	// Agent policy still requires write permission for review-state mutation;
	// rewind's wiki-file gate should ignore it until this tool mutates wiki files.
	"mcp__llm_wiki__sweep_reviews",
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
 * Every wiki tool name this module has an explicit, tested opinion about —
 * exported (only) so the frontend's drift-guard test
 * (src/lib/agent/wiki-tool-write-gate.test.ts) can assert its hand-copied
 * duplicate (wiki-tool-write-gate.ts — the frontend can't import sidecar
 * source in production, since it's a separately-built Node package) still
 * covers every name agent-policy.ts's READ/WRITE lists know about. Today
 * this always equals READ_WIKI_TOOLS ∪ WRITE_WIKI_TOOLS by construction
 * (VERIFIED_READ_ONLY_WIKI_TOOLS and KNOWN_WRITE_WIKI_TOOLS above are both
 * derived from those lists), but it's exported as its own concrete list —
 * not re-derived by the test from the same imports — so a future refactor
 * that de-derives one of those sets can't silently drift without the test
 * noticing.
 */
export const KNOWN_WIKI_TOOL_NAMES: readonly string[] = Array.from(
	new Set<string>([
		...KNOWN_WRITE_WIKI_TOOLS,
		...CONDITIONAL_WRITE_WIKI_TOOLS,
		...VERIFIED_READ_ONLY_WIKI_TOOLS,
	]),
);

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
	if (NON_WIKI_FILE_WRITE_TOOLS.has(toolName)) return false;
	if (CONDITIONAL_WRITE_WIKI_TOOLS.has(toolName)) return true;
	if (KNOWN_WRITE_WIKI_TOOLS.has(toolName)) return true;
	if (VERIFIED_READ_ONLY_WIKI_TOOLS.has(toolName)) return false;
	return true;
}
