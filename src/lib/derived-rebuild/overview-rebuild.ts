/**
 * SPEC-6 PR5: `"overview"` layer — manual, LLM-generated rebuild of
 * `wiki/overview.md` (plan decision 3). One button, one page — there is no
 * candidate preview the way `synthesis` has one, because there is only ever
 * a single overview page to (re)write. Never auto-triggered.
 *
 * Reuses `index-export.ts`'s scan/group/format pipeline to build the
 * page-listing context fed to the prompt, rather than scanning the wiki
 * tree a second time independently — the overview and the index then always
 * agree on what pages exist and how they're grouped.
 */

import { writeFileAtomic } from "@/commands/fs"
import { computeContextBudget } from "@/lib/context-budget"
import { parseFrontmatter } from "@/lib/frontmatter"
import { hasUsableLlm } from "@/lib/has-usable-llm"
import { streamChatRouted } from "@/lib/pool-chat"
import { normalizePath } from "@/lib/path-utils"
import type { LlmConfig } from "@/stores/wiki-store"
import { formatIndexExportMarkdown, groupIndexExportPages, scanIndexExportPages } from "./index-export"
import { runManualRebuild } from "./manual-rebuild"

const OVERVIEW_AFFECTED_PATH = "wiki/overview.md"
const HOLDER = "overview-manual-rebuild"

function buildOverviewPrompt(pageListing: string): string {
  return `You maintain the "Project Overview" page for a research wiki. Below is the current page index, grouped by type.

${pageListing}

Write (or rewrite) the overview page: summarize what this wiki covers, its key themes, and its current state, in 2-4 short paragraphs.

Write the page as a wiki page with YAML frontmatter. The first bytes of your response must be:
---
type: overview
title: Project Overview
tags: []
related: []
---

# Overview

[your summary]

Do not wrap the response in Markdown code fences.
Output ONLY the wiki page content, nothing else.`
}

export interface OverviewRebuildResult {
  path: string
  /** See `ManualRebuildResult.runtimeTracked` — false means the rebuild ran but marker bookkeeping was skipped. */
  runtimeTracked: boolean
}

/**
 * Manually regenerate `wiki/overview.md` via a single LLM call (SPEC-6 PR5
 * decision 3). Throws (before any marker bookkeeping starts) when the LLM
 * configuration isn't usable, so the caller can disable/clear-error the
 * button rather than mint a job for a call that can never succeed.
 */
export async function rebuildOverview(
  projectPath: string,
  llmConfig: LlmConfig,
): Promise<OverviewRebuildResult> {
  if (!hasUsableLlm(llmConfig)) {
    throw new Error("overview-rebuild: no usable LLM configured")
  }
  const pp = normalizePath(projectPath)

  const { runtimeTracked } = await runManualRebuild({
    layer: "overview",
    affectedPath: OVERVIEW_AFFECTED_PATH,
    holder: HOLDER,
    execute: async () => {
      const pages = await scanIndexExportPages(pp)
      const sections = groupIndexExportPages(pages)
      const listing = formatIndexExportMarkdown(sections)

      // `pageBudget` (~50% of maxCtx), not `indexBudget` (~5%): `indexBudget`
      // is context-budget.ts's allowance for a chat turn that ALSO carries
      // retrieved page content and history alongside the index summary, so
      // it's sized to stay small next to those. Here the page listing IS
      // the entire prompt payload — for a large wiki it can easily run
      // past a 5%-of-context allowance, so the much larger `pageBudget`
      // (the budget context-budget.ts itself reserves specifically for
      // page content) is the correct cap for this single-purpose prompt.
      const budget = computeContextBudget(llmConfig.maxContextSize)
      const truncatedListing = listing.length > budget.pageBudget
        ? `${listing.slice(0, budget.pageBudget)}\n... (truncated)`
        : listing

      const prompt = buildOverviewPrompt(truncatedListing)

      let accumulated = ""
      let streamError: unknown
      await streamChatRouted(
        "synthesis",
        llmConfig,
        [{ role: "user", content: prompt }],
        {
          onToken: (token) => { accumulated += token },
          onDone: () => {},
          onError: (err) => { streamError = err },
        },
        undefined,
        undefined,
        `synthesis:overview:${OVERVIEW_AFFECTED_PATH}`,
      )
      if (streamError) throw streamError

      const trimmed = accumulated.trim()
      if (!trimmed) throw new Error("overview-rebuild: LLM returned an empty response")

      // Validate before writing (mirrors wiki-synthesis.ts's synthesis
      // frontmatter check) — a malformed LLM response must fail the
      // rebuild job rather than silently overwrite overview.md with junk.
      const { frontmatter } = parseFrontmatter(trimmed)
      if (!frontmatter || String(frontmatter.type || "").toLowerCase() !== "overview") {
        throw new Error("overview-rebuild: LLM output missing valid overview frontmatter")
      }

      await writeFileAtomic(`${pp}/${OVERVIEW_AFFECTED_PATH}`, trimmed)
    },
  })

  return { path: OVERVIEW_AFFECTED_PATH, runtimeTracked }
}
