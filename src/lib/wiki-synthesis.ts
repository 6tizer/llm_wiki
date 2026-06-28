/**
 * Wiki Synthesis Tool (Phase 3.7 — Issue #33)
 *
 * Discovers thematic clusters in wiki concept/entity pages by tag analysis,
 * supplements with external web search (EXA.AI etc.), and generates
 * cross-article synthesis reports using LLM.
 */

import { readFile, listDirectory, writeFile, createDirectory } from "@/commands/fs"
import { parseFrontmatter } from "@/lib/frontmatter"
import { getRelativePath, normalizePath } from "@/lib/path-utils"
import { streamChat } from "@/lib/llm-client"
import { webSearch, type WebSearchResult } from "@/lib/web-search"
import { flattenMdFiles } from "@/lib/wiki-utils"
import { buildLanguageDirective } from "@/lib/output-language"
import { composeAgentPrompt } from "@/lib/agent/prompt-registry"
import type { FileNode } from "@/types/wiki"
import type { LlmConfig, SearchApiConfig } from "@/stores/wiki-store"

// ── Types ────────────────────────────────────────────────────────────────────

export interface TagCluster {
  /** Tags driving this cluster. Single-tag clusters have one item. */
  tags: string[]
  /** Backward-compatible primary tag for existing callers. */
  tag: string
  /** Human-readable topic label derived from tags. */
  topic: string
  /** Filesystem-safe topic slug derived from tags. */
  slug: string
  /** Pages in this cluster */
  pages: ClusterPage[]
}

/** Wiki page payload used as evidence for synthesis discovery and prompt generation. */
export interface ClusterPage {
  slug: string
  title: string
  type: string
  tags: string[]
  body: string
}

/** Result returned by synthesis generation, including success metadata or a no-write error. */
export interface SynthesisResult {
  ok: boolean
  topic?: string
  tags?: string[]
  clusterSize?: number
  synthesisPath?: string
  externalSources?: number
  discovery?: SynthesisDiscoveryReport
  error?: string
}

/** Number of tags that define a synthesis topic candidate. */
export type SynthesisDimension = 1 | 2 | 3 | 4

/** Read-only synthesis topic candidate discovered from page-local tag combinations. */
export interface SynthesisCandidate {
  tags: string[]
  topic: string
  slug: string
  pageCount: number
  pages: ClusterPage[]
}

/** Options for read-only synthesis discovery and candidate list truncation. */
export interface SynthesisDiscoveryOptions {
  dimension?: SynthesisDimension
  minClusterSize?: number
  maxCandidates?: number
}

/** Discovery report shown to callers; candidates are capped by maxCandidates. */
export interface SynthesisDiscoveryReport {
  dimension: SynthesisDimension
  minClusterSize: number
  maxCandidates: number
  scannedPages: number
  eligiblePages: number
  totalCandidates: number
  returnedCandidates: number
  truncated: boolean
  truncatedCount: number
  candidates: SynthesisCandidate[]
  suggestedDimension?: SynthesisDimension
  emptyReason?: "no_pages" | "not_enough_tagged_pages" | "no_cluster_meets_minimum"
}

/** Options for generation; targetTags/targetTag select the exact candidate to write. */
export interface RunWikiSynthesisOptions extends SynthesisDiscoveryOptions {
  targetTag?: string
  targetTags?: string[]
  guidance?: string
}

/** Default and hard upper bounds for synthesis discovery controls. */
export const DEFAULT_SYNTHESIS_LIMITS = {
  dimension: 1 as SynthesisDimension,
  minClusterSize: 3,
  maxClusterSizeLimit: 50,
  maxCandidates: 10,
  maxCandidatesLimit: 50,
}

// ── Helpers ──────────────────────────────────────────────────────────────────


async function scanConceptEntityPages(projectPath: string): Promise<ClusterPage[]> {
  const pp = normalizePath(projectPath)
  const wikiRoot = `${pp}/wiki`

  let tree: FileNode[]
  try {
    tree = await listDirectory(wikiRoot)
  } catch {
    return []
  }

  const allFiles = flattenMdFiles(tree)
  const pages: ClusterPage[] = []

  for (const f of allFiles) {
    try {
      const content = await readFile(f.path)
      const { frontmatter, body } = parseFrontmatter(content)
      if (!frontmatter) continue

      const type = String(frontmatter.type || "").toLowerCase()
      if (type !== "concept" && type !== "entity") continue

      const slug = getRelativePath(f.path, wikiRoot).replace(/\.md$/, "")
      const title = String(frontmatter.title || slug.split("/").pop() || "")
      const rawTags = frontmatter.tags
      const tags = Array.isArray(rawTags)
        ? rawTags.map((t) => String(t).toLowerCase().trim()).filter(Boolean)
        : typeof rawTags === "string"
          ? rawTags.split(",").map((t) => t.trim().toLowerCase()).filter(Boolean)
          : []

      pages.push({ slug, title, type, tags, body })
    } catch {
      // skip unreadable
    }
  }

  return pages
}

function normalizeTag(tag: string): string {
  return tag.toLowerCase().trim()
}

function normalizeTags(tags: readonly string[]): string[] {
  return [...new Set(tags.map(normalizeTag).filter(Boolean))].sort((a, b) => a.localeCompare(b))
}

function clampInteger(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : fallback
  return Math.min(max, Math.max(min, n))
}

function normalizeDimension(value: unknown): SynthesisDimension {
  return value === 2 || value === 3 || value === 4 ? value : DEFAULT_SYNTHESIS_LIMITS.dimension
}

function normalizeDiscoveryOptions(options: SynthesisDiscoveryOptions = {}) {
  return {
    dimension: normalizeDimension(options.dimension),
    minClusterSize: clampInteger(
      options.minClusterSize,
      DEFAULT_SYNTHESIS_LIMITS.minClusterSize,
      1,
      DEFAULT_SYNTHESIS_LIMITS.maxClusterSizeLimit,
    ),
    maxCandidates: clampInteger(
      options.maxCandidates,
      DEFAULT_SYNTHESIS_LIMITS.maxCandidates,
      1,
      DEFAULT_SYNTHESIS_LIMITS.maxCandidatesLimit,
    ),
  }
}

function tagTopic(tags: readonly string[]): string {
  return tags.join(" + ")
}

function slugifyTopic(tags: readonly string[]): string {
  return tags
    .join("-")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || "untagged"
}

function combinations(items: readonly string[], size: number): string[][] {
  if (size <= 0 || items.length < size) return []
  if (size === 1) return items.map((item) => [item])
  const out: string[][] = []
  const walk = (start: number, picked: string[]) => {
    if (picked.length === size) {
      out.push([...picked])
      return
    }
    for (let i = start; i <= items.length - (size - picked.length); i++) {
      picked.push(items[i])
      walk(i + 1, picked)
      picked.pop()
    }
  }
  walk(0, [])
  return out
}

function buildDiscoveryReport(
  pages: ClusterPage[],
  options: SynthesisDiscoveryOptions = {},
  includeSuggestion = true,
): SynthesisDiscoveryReport {
  const normalized = normalizeDiscoveryOptions(options)
  const groups = new Map<string, { tags: string[]; pages: Map<string, ClusterPage> }>()
  let eligiblePages = 0

  for (const page of pages) {
    const pageTags = normalizeTags(page.tags)
    if (pageTags.length < normalized.dimension) continue
    eligiblePages += 1
    for (const combo of combinations(pageTags, normalized.dimension)) {
      const key = combo.join("\u0000")
      const group = groups.get(key) ?? { tags: combo, pages: new Map<string, ClusterPage>() }
      group.pages.set(page.slug, page)
      groups.set(key, group)
    }
  }

  const candidates = [...groups.values()]
    .map((group): SynthesisCandidate => {
      const groupPages = [...group.pages.values()].sort((a, b) => a.slug.localeCompare(b.slug))
      return {
        tags: group.tags,
        topic: tagTopic(group.tags),
        slug: slugifyTopic(group.tags),
        pageCount: groupPages.length,
        pages: groupPages,
      }
    })
    .filter((candidate) => candidate.pageCount >= normalized.minClusterSize)
    .sort((a, b) => b.pageCount - a.pageCount || a.topic.localeCompare(b.topic))

  const returned = candidates.slice(0, normalized.maxCandidates)
  const emptyReason = pages.length === 0
    ? "no_pages"
    : eligiblePages === 0
      ? "not_enough_tagged_pages"
      : candidates.length === 0
        ? "no_cluster_meets_minimum"
        : undefined
  const suggestedDimension = includeSuggestion && candidates.length === 0
    ? findSuggestedDimension(pages, normalized)
    : undefined

  return {
    ...normalized,
    scannedPages: pages.length,
    eligiblePages,
    totalCandidates: candidates.length,
    returnedCandidates: returned.length,
    truncated: candidates.length > returned.length,
    truncatedCount: Math.max(0, candidates.length - returned.length),
    candidates: returned,
    suggestedDimension,
    emptyReason,
  }
}

function findSuggestedDimension(
  pages: ClusterPage[],
  options: ReturnType<typeof normalizeDiscoveryOptions>,
): SynthesisDimension | undefined {
  for (let dimension = options.dimension - 1; dimension >= 1; dimension--) {
    const report = buildDiscoveryReport(
      pages,
      {
        dimension: dimension as SynthesisDimension,
        minClusterSize: options.minClusterSize,
        maxCandidates: 1,
      },
      false,
    )
    if (report.totalCandidates > 0) return dimension as SynthesisDimension
  }
  return undefined
}

function candidateToCluster(candidate: SynthesisCandidate): TagCluster {
  return {
    tags: candidate.tags,
    tag: candidate.tags[0] ?? "",
    topic: candidate.topic,
    slug: candidate.slug,
    pages: candidate.pages,
  }
}

function findSelectedCandidate(
  pages: ClusterPage[],
  selectedTags: readonly string[],
  dimension: SynthesisDimension,
  minClusterSize: number,
): SynthesisCandidate | undefined {
  if (selectedTags.length !== dimension) return undefined
  const matches = pages
    .filter((page) => {
      const pageTags = normalizeTags(page.tags)
      return selectedTags.every((tag) => pageTags.includes(tag))
    })
    .sort((a, b) => a.slug.localeCompare(b.slug))
  if (matches.length < minClusterSize) return undefined
  return {
    tags: [...selectedTags],
    topic: tagTopic(selectedTags),
    slug: slugifyTopic(selectedTags),
    pageCount: matches.length,
    pages: matches,
  }
}

/** Discover deterministic page-based tag-combination synthesis candidates without writing files or calling LLM/search. */
export async function discoverSynthesisCandidates(
  projectPath: string,
  options: SynthesisDiscoveryOptions = {},
): Promise<SynthesisDiscoveryReport> {
  const pages = await scanConceptEntityPages(projectPath)
  return buildDiscoveryReport(pages, options)
}

/** Build a synthesis prompt from cluster pages + external search results. */
export function buildSynthesisPrompt(
  cluster: TagCluster,
  externalResults: WebSearchResult[],
  wikiIndex: string,
  languageHint: string,
  guidance?: string,
): string {
  const pageSummaries = cluster.pages
    .map((p) => {
      const excerpt = p.body.slice(0, 800)
      return `### ${p.title} (${p.slug})\nTags: ${p.tags.join(", ")}\n\n${excerpt}`
    })
    .join("\n\n---\n\n")

  const externalSection = externalResults.length > 0
    ? `\n\n## External Research Sources\n\n${externalResults
        .slice(0, 5)
        .map((r) => `- **${r.title}**: ${r.snippet} (${r.url})`)
        .join("\n")}`
    : ""

  return composeAgentPrompt({
    lockedPrelude: `You are a knowledge synthesis expert. Analyze the cluster of wiki pages about "${cluster.topic}" and produce a comprehensive synthesis report.

${languageHint}`,
    runtimeInjected: `## Wiki Pages in This Cluster (${cluster.pages.length} pages)

${pageSummaries}
${externalSection}

${wikiIndex ? `\n## Current Wiki Index\n\n${wikiIndex}\n` : ""}`,
    guidance,
    lockedOutputContract: `## Locked Output Contract

Produce a synthesis report with this structure:

1. **Research Question**: A clear question that this cluster of pages collectively addresses
2. **Cross-Article Analysis**: Identify patterns, connections, contradictions, and gaps across the pages
3. **Key Findings**: 3-7 major insights that emerge from combining these sources
4. **Source List**: Reference each wiki page using [[wikilink]] syntax
5. **Action Recommendations**: Suggested next steps or areas for further research

Write the report as a wiki page with YAML frontmatter. The first bytes of your response must be:
---
type: synthesis
title: "Synthesis: [your title]"
tags: [${cluster.tags.join(", ")}, synthesis]
created: ${new Date().toISOString().slice(0, 10)}
---

# [Title]

## Research Question
[question]

## Cross-Article Analysis
[analysis]

## Key Findings
[findings]

## Source List
[sources with [[wikilinks]]]

## Action Recommendations
[recommendations]

Do not wrap the response in Markdown code fences.
Output ONLY the wiki page content, nothing else.`,
  })
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Run wiki synthesis by rediscovering page-based tag candidates, optionally
 * selecting exact targetTags/targetTag, then generating and writing one
 * validated synthesis page. Supports the new options object and the legacy
 * `(targetTag, minClusterSize)` signature.
 *
 * @param projectPath - Wiki project root
 * @param llmConfig - LLM configuration for synthesis generation
 * @param searchConfig - Web search config (EXA etc.) for external sources
 * @param options - New options object, or legacy targetTag string
 * @param minClusterSize - Legacy minimum pages argument when options is a targetTag
 */
export async function runWikiSynthesis(
  projectPath: string,
  llmConfig: LlmConfig,
  searchConfig: SearchApiConfig,
  options?: RunWikiSynthesisOptions,
): Promise<SynthesisResult>
export async function runWikiSynthesis(
  projectPath: string,
  llmConfig: LlmConfig,
  searchConfig: SearchApiConfig,
  targetTag?: string,
  minClusterSize?: number,
): Promise<SynthesisResult>
export async function runWikiSynthesis(
  projectPath: string,
  llmConfig: LlmConfig,
  searchConfig: SearchApiConfig,
  optionsOrTargetTag?: RunWikiSynthesisOptions | string,
  legacyMinClusterSize?: number,
): Promise<SynthesisResult> {
  const pp = normalizePath(projectPath)
  const runOptions: RunWikiSynthesisOptions = typeof optionsOrTargetTag === "object" && optionsOrTargetTag !== null
    ? optionsOrTargetTag
    : { targetTag: optionsOrTargetTag, minClusterSize: legacyMinClusterSize }
  const selectedTags = normalizeTags(
    runOptions.targetTags?.length
      ? runOptions.targetTags
      : runOptions.targetTag
        ? [runOptions.targetTag]
        : [],
  )
  const dimension = normalizeDimension(runOptions.dimension ?? (selectedTags.length || undefined))
  const discoveryOptions = {
    dimension,
    minClusterSize: runOptions.minClusterSize,
    maxCandidates: runOptions.maxCandidates,
  }

  // Step 1: Scan wiki pages
  const pages = await scanConceptEntityPages(pp)
  if (pages.length === 0) {
    return { ok: false, error: "No concept/entity pages found in wiki" }
  }

  // Step 2: Discover clusters
  const discovery = buildDiscoveryReport(pages, discoveryOptions)
  if (discovery.candidates.length === 0) {
    return {
      ok: false,
      discovery,
      error: `No tag clusters found with ≥${discovery.minClusterSize} pages`,
    }
  }

  const candidate = selectedTags.length > 0
    ? findSelectedCandidate(pages, selectedTags, discovery.dimension, discovery.minClusterSize)
    : discovery.candidates[0]
  if (!candidate) {
    return {
      ok: false,
      discovery,
      error: `Selected synthesis candidate not found with ≥${discovery.minClusterSize} pages`,
    }
  }
  const cluster = candidateToCluster(candidate)

  // Step 3: External search supplement
  let externalResults: WebSearchResult[] = []
  try {
    const searchQuery = `${cluster.topic} ${cluster.pages.map((p) => p.title).slice(0, 3).join(" ")}`
    externalResults = await webSearch(searchQuery, searchConfig, 5)
  } catch (err) {
    // External search is supplementary — don't fail the whole synthesis
    console.warn("[Synthesis] external search failed:", err instanceof Error ? err.message : err)
  }

  // Step 4: Read wiki index for context
  let wikiIndex = ""
  try {
    wikiIndex = await readFile(`${pp}/wiki/index.md`)
  } catch {
    // optional
  }

  // Step 5: Generate synthesis via LLM
  const languageHint = buildLanguageDirective(cluster.pages.map((p) => p.body).join("\n"))
  const prompt = buildSynthesisPrompt(cluster, externalResults, wikiIndex, languageHint, runOptions.guidance)

  let accumulated = ""
  let streamError: unknown
  await streamChat(
    llmConfig,
    [{ role: "user", content: prompt }],
    {
      onToken: (token) => { accumulated += token },
      onDone: () => {},
      onError: (err) => { streamError = err },
    },
  )
  if (streamError) throw streamError
  if (!accumulated.trim()) {
    return { ok: false, error: "LLM returned empty response" }
  }

  // Validate LLM output has valid synthesis frontmatter (PR#35 finding #4)
  const { frontmatter: synthFm } = parseFrontmatter(accumulated.trim())
  if (!synthFm || String(synthFm.type || "").toLowerCase() !== "synthesis") {
    return { ok: false, error: "LLM output missing valid synthesis frontmatter" }
  }

  // Step 6: Save synthesis page
  const synthesisPath = `wiki/synthesis/${cluster.slug}-synthesis.md`
  const fullPath = `${pp}/${synthesisPath}`

  // Ensure synthesis directory exists (PR#35 finding #1)
  const synthesisDir = `${pp}/wiki/synthesis`
  await createDirectory(synthesisDir)
  await writeFile(fullPath, accumulated.trim())

  return {
    ok: true,
    topic: cluster.topic,
    tags: cluster.tags,
    clusterSize: cluster.pages.length,
    synthesisPath,
    externalSources: externalResults.length,
    discovery,
  }
}
