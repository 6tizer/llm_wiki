/**
 * SPEC-6 PR5: `"index_export"` layer — deterministic, synchronous rebuild of
 * `wiki/index.md` from the current `wiki/**` tree (plan decision 2). Unlike
 * `overview` (an LLM call) this is pure scan + group + format + write, so it
 * completes on click with no cost prompt.
 *
 * Split into three pure, IO-free pieces (grouping / formatting) plus one IO
 * scan and one closeout wrapper, so the interesting logic — which section a
 * page lands in, and the exact `- [[slug]] — title` line format — is unit
 * testable without a filesystem or a runtime db (plan's "index-export纯函数
 * 单测" requirement).
 */

import { listDirectory, readFile, writeFileAtomic } from "@/commands/fs"
import { parseFrontmatter } from "@/lib/frontmatter"
import { getRelativePath, normalizePath } from "@/lib/path-utils"
import { extractPageTitle, isRootStructuralWikiPagePath } from "@/lib/wiki-page-identity"
import { inferWikiTypeFromPath } from "@/lib/wiki-page-types"
import { flattenMdFiles } from "@/lib/wiki-utils"
import { runManualRebuild } from "./manual-rebuild"

const INDEX_EXPORT_AFFECTED_PATH = "wiki/index.md"
const HOLDER = "index-export-manual-rebuild"
const OTHER_HEADING = "Other"

/**
 * Section headings in the exact order `project.rs`'s fresh-project template
 * (`wiki/index.md`) uses, mapped from the wiki page `type`s that already
 * route to those directories (`wiki-page-types.ts`'s `WIKI_TYPE_DIRS`).
 */
const TEMPLATE_TYPE_SECTIONS: ReadonlyArray<{ type: string; heading: string }> = [
  { type: "entity", heading: "Entities" },
  { type: "concept", heading: "Concepts" },
  { type: "source", heading: "Sources" },
  { type: "query", heading: "Queries" },
  { type: "comparison", heading: "Comparisons" },
  { type: "synthesis", heading: "Synthesis" },
]

export interface IndexExportPage {
  slug: string
  title: string
  /** Lowercased frontmatter `type`, falling back to path-inferred type, or `""` when neither is known. */
  type: string
}

export interface IndexExportSection {
  heading: string
  pages: IndexExportPage[]
}

function sortPages(pages: readonly IndexExportPage[]): IndexExportPage[] {
  return [...pages].sort((a, b) => a.slug.localeCompare(b.slug))
}

/**
 * Group pages into the template's six known sections (always present, even
 * empty — matching the fresh-project template) plus a trailing "Other"
 * section for any type that doesn't map to one of them (unknown/custom
 * types, or pages with no discoverable type at all). Pure — no IO.
 */
export function groupIndexExportPages(pages: readonly IndexExportPage[]): IndexExportSection[] {
  const byType = new Map<string, IndexExportPage[]>()
  for (const page of pages) {
    const key = page.type
    const list = byType.get(key) ?? []
    list.push(page)
    byType.set(key, list)
  }

  const sections: IndexExportSection[] = TEMPLATE_TYPE_SECTIONS.map(({ type, heading }) => ({
    heading,
    pages: sortPages(byType.get(type) ?? []),
  }))

  const knownTypes = new Set(TEMPLATE_TYPE_SECTIONS.map((entry) => entry.type))
  const otherPages = [...byType.entries()]
    .filter(([type]) => !knownTypes.has(type))
    .flatMap(([, list]) => list)
  if (otherPages.length > 0) {
    sections.push({ heading: OTHER_HEADING, pages: sortPages(otherPages) })
  }

  return sections
}

function formatSection(section: IndexExportSection): string {
  const rows = section.pages.map((page) => `- [[${page.slug}]] — ${page.title}`).join("\n")
  return rows ? `## ${section.heading}\n\n${rows}` : `## ${section.heading}`
}

/**
 * Render grouped sections into the exact `wiki/index.md` shape: `# Wiki
 * Index` followed by each section's heading, a blank line, then its
 * `- [[slug]] — title` rows (or nothing, for an empty section) — matching
 * `project.rs`'s fresh-project template structure. Pure — no IO.
 */
export function formatIndexExportMarkdown(sections: readonly IndexExportSection[]): string {
  const body = sections.map(formatSection).join("\n\n")
  return `# Wiki Index\n\n${body}\n`
}

/**
 * Scan `wiki/**` for exportable pages: every `.md` file except the root
 * structural pages (`index.md`/`log.md`/`overview.md`/`purpose.md`/
 * `schema.md` — `isRootStructuralWikiPagePath`), which would otherwise
 * self-reference the index or duplicate the log/overview's own content.
 * `type` prefers frontmatter (`type:`), falling back to the page's
 * directory (`inferWikiTypeFromPath`) when frontmatter is missing/blank —
 * an unreadable file is skipped rather than failing the whole scan.
 */
export async function scanIndexExportPages(projectPath: string): Promise<IndexExportPage[]> {
  const pp = normalizePath(projectPath)
  const wikiRoot = `${pp}/wiki`

  let tree: Awaited<ReturnType<typeof listDirectory>>
  try {
    tree = await listDirectory(wikiRoot)
  } catch {
    return []
  }

  const files = flattenMdFiles(tree)
  const pages: IndexExportPage[] = []

  for (const file of files) {
    if (isRootStructuralWikiPagePath(pp, file.path)) continue

    let content: string
    try {
      content = await readFile(file.path)
    } catch {
      continue
    }

    const slug = getRelativePath(file.path, wikiRoot).replace(/\.md$/, "")
    const { frontmatter } = parseFrontmatter(content)
    const frontmatterType = frontmatter?.type
    const type = typeof frontmatterType === "string" && frontmatterType.trim()
      ? frontmatterType.trim().toLowerCase()
      : (inferWikiTypeFromPath(file.path) ?? "")
    const title = extractPageTitle(content, slug.split("/").pop() ?? slug)

    pages.push({ slug, title, type })
  }

  return pages
}

export interface IndexExportRebuildResult {
  path: string
  pageCount: number
  sectionCount: number
  /** See `ManualRebuildResult.runtimeTracked` — false means the rebuild ran but marker bookkeeping was skipped. */
  runtimeTracked: boolean
}

/**
 * Manually rebuild `wiki/index.md` from the current wiki tree (SPEC-6 PR5
 * decision 2). Synchronous and deterministic — no LLM call, no candidate
 * preview.
 */
export async function rebuildIndexExport(projectPath: string): Promise<IndexExportRebuildResult> {
  const pp = normalizePath(projectPath)

  const { result, runtimeTracked } = await runManualRebuild({
    layer: "index_export",
    affectedPath: INDEX_EXPORT_AFFECTED_PATH,
    holder: HOLDER,
    execute: async () => {
      const pages = await scanIndexExportPages(pp)
      const sections = groupIndexExportPages(pages)
      const markdown = formatIndexExportMarkdown(sections)
      await writeFileAtomic(`${pp}/${INDEX_EXPORT_AFFECTED_PATH}`, markdown)
      return { pageCount: pages.length, sectionCount: sections.length }
    },
  })

  return {
    path: INDEX_EXPORT_AFFECTED_PATH,
    pageCount: result.pageCount,
    sectionCount: result.sectionCount,
    runtimeTracked,
  }
}
