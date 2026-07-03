/**
 * Shared sanity gate for LLM-produced full-page rewrites (SPEC-11 D6 bug2).
 *
 * lint-fixer.ts and dedup.ts both let an LLM rewrite (or merge) whole wiki
 * pages and then write the result straight to disk -- in dedup's case, also
 * deleting the merged-away pages. Before this guard existed, the only check
 * was `!raw.trim()`, so a truncated stream (cut off mid-frontmatter) or a
 * short refusal ("I can't help with that.") would sail through and either
 * clobber a page with garbage or, worse, trigger a merge that deletes real
 * content backed by nothing but junk.
 *
 * Three checks, cheapest/most-certain first:
 *   1. Non-empty after trimming.
 *   2. Frontmatter parses (`parseFrontmatter` returns a non-null object) --
 *      catches truncation, since a cut-off stream almost always drops the
 *      closing `---` fence before the response ends.
 *   3. Length sanity relative to a reference document -- catches responses
 *      that are technically well-formed (valid frontmatter) but far too
 *      short to be a genuine full-page rewrite, e.g. a one-line refusal
 *      wrapped in minimal frontmatter.
 */
import { parseFrontmatter } from "./frontmatter"

export interface LlmOutputValidation {
  ok: boolean
  reason?: string
}

/**
 * `referenceContent` should be the content the LLM was asked to rewrite (or,
 * for a merge, the largest/most representative input). Passing the LLM
 * output itself as the reference is a valid way to opt out of the
 * length-ratio check while still enforcing the absolute floor -- useful for
 * brand-new pages that have no prior content to compare against.
 */
export function validateLlmPageOutput(
  raw: string,
  referenceContent: string,
): LlmOutputValidation {
  const trimmed = raw.trim()
  if (!trimmed) {
    return { ok: false, reason: "LLM returned an empty response." }
  }

  const { frontmatter } = parseFrontmatter(trimmed)
  if (!frontmatter) {
    return {
      ok: false,
      reason: "LLM output has no parseable frontmatter (likely truncated or malformed).",
    }
  }

  const referenceLen = referenceContent.trim().length
  const minLen = Math.max(30, referenceLen * 0.3)
  if (trimmed.length < minLen) {
    return {
      ok: false,
      reason: `LLM output (${trimmed.length} chars) is implausibly short relative to the input (${referenceLen} chars).`,
    }
  }

  return { ok: true }
}
