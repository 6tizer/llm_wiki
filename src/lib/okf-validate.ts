import { listDirectory, readFile } from "@/commands/fs"
import { parseFrontmatter, type FrontmatterValue } from "@/lib/frontmatter"
import { createGraphWikilinkResolver } from "@/lib/graph-page-identity"
import { normalizePath } from "@/lib/path-utils"
import type { FileNode } from "@/types/wiki"
import { loadProjectWikiSchemaRouting, validateWikiPageRouting } from "@/lib/wiki-schema"
import { flattenMdFiles } from "@/lib/wiki-utils"
import { splitMarkdownCodeAware, WIKILINK_RE } from "@/lib/wikilink-transform"
import type {
  OkfValidatedPage,
  OkfValidationIssue,
  OkfValidationResult,
} from "@/lib/okf-types"

const STRUCTURAL_WIKI_PAGES = new Set([
  "wiki/index.md",
  "wiki/log.md",
  "wiki/overview.md",
])

interface LoadedWikiPage {
  relativePath: string
  absolutePath: string
  content: string
  parsed: ReturnType<typeof parseFrontmatter>
}

/**
 * Validate the OKF-compatible markdown bundle rooted at `<project>/wiki`.
 */
export async function validateOkfBundle(projectPath: string): Promise<OkfValidationResult> {
  const issues: OkfValidationIssue[] = []
  const pages = await loadWikiPages(projectPath, issues)
  const routing = await loadProjectWikiSchemaRouting(normalizeProjectPath(projectPath))
  const resolver = buildWikilinkResolver(pages)

  for (const page of pages) {
    validateRequiredFrontmatter(page, issues)
    validateSchemaRouting(page, routing, issues)
    validateWikilinks(page, resolver, issues)
  }

  const errors = issues.filter((issue) => issue.severity === "error")
  const warnings = issues.filter((issue) => issue.severity === "warn")

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    pages: pages.map(toValidatedPage),
  }
}

/** Map the local wiki type vocabulary to the small OKF-compatible type surface. */
export function okfTypeForLocalType(localType: string | null): string | null {
  if (!localType) return null
  return localType.toLowerCase() === "source" ? "summary" : localType
}

/** Return true for root structural wiki pages that do not require page frontmatter. */
export function isStructuralWikiPage(relativePath: string): boolean {
  return STRUCTURAL_WIKI_PAGES.has(normalizeRelativePath(relativePath))
}

async function loadWikiPages(
  projectPath: string,
  issues: OkfValidationIssue[],
): Promise<LoadedWikiPage[]> {
  const normalizedProjectPath = normalizeProjectPath(projectPath)
  let tree: FileNode[]
  try {
    tree = await listDirectory(`${normalizedProjectPath}/wiki`)
  } catch {
    issues.push({
      severity: "error",
      code: "wiki_missing",
      path: "wiki",
      message: "Missing or unreadable wiki directory.",
    })
    return []
  }

  const pages: LoadedWikiPage[] = []
  for (const file of flattenMdFiles(tree)) {
    const relativePath = projectRelativeWikiPath(normalizedProjectPath, file.path)
    if (!relativePath) continue

    try {
      const content = await readFile(file.path)
      pages.push({
        relativePath,
        absolutePath: normalizePath(file.path),
        content,
        parsed: parseFrontmatter(content),
      })
    } catch {
      issues.push({
        severity: "error",
        code: "read_failed",
        path: relativePath,
        message: `Could not read "${relativePath}".`,
      })
    }
  }

  return pages.sort((a, b) => a.relativePath.localeCompare(b.relativePath))
}

function validateRequiredFrontmatter(page: LoadedWikiPage, issues: OkfValidationIssue[]): void {
  if (isStructuralWikiPage(page.relativePath)) return

  const type = stringField(page.parsed.frontmatter, "type")
  const title = stringField(page.parsed.frontmatter, "title")
  if (!type) {
    issues.push({
      severity: "error",
      code: "missing_type",
      path: page.relativePath,
      message: `Non-structural wiki page "${page.relativePath}" must declare frontmatter "type".`,
    })
  }
  if (!title) {
    issues.push({
      severity: "error",
      code: "missing_title",
      path: page.relativePath,
      message: `Non-structural wiki page "${page.relativePath}" must declare frontmatter "title".`,
    })
  }
}

function validateSchemaRouting(
  page: LoadedWikiPage,
  routing: Awaited<ReturnType<typeof loadProjectWikiSchemaRouting>>,
  issues: OkfValidationIssue[],
): void {
  if (!routing) return
  const routingIssue = validateWikiPageRouting(page.relativePath, page.content, routing)
  if (!routingIssue) return

  issues.push({
    severity: "error",
    code: "schema_routing",
    path: page.relativePath,
    message: routingIssue.message,
  })
}

function validateWikilinks(
  page: LoadedWikiPage,
  resolver: ReturnType<typeof buildWikilinkResolver>,
  issues: OkfValidationIssue[],
): void {
  const regex = new RegExp(WIKILINK_RE.source, "g")
  for (const segment of splitMarkdownCodeAware(page.content)) {
    if (segment.kind === "code") continue

    let match: RegExpExecArray | null
    regex.lastIndex = 0
    while ((match = regex.exec(segment.text)) !== null) {
      const target = match[1].trim()
      if (!resolver.resolve(target)) {
        issues.push({
          severity: "warn",
          code: "unresolved_wikilink",
          path: page.relativePath,
          message: `Wikilink target "${target}" could not be resolved.`,
        })
      }
    }
  }

  if (hasUnmatchedWikilinkBrackets(page.content) || hasBalancedIllegalWikilinks(page.content)) {
    issues.push({
      severity: "error",
      code: "malformed_wikilink",
      path: page.relativePath,
      message: `Malformed wikilink syntax in "${page.relativePath}".`,
    })
  }
}

function buildWikilinkResolver(pages: readonly LoadedWikiPage[]): { resolve(raw: string): string | null } {
  const graphResolver = createGraphWikilinkResolver(
    pages.map((page) => ({
      id: page.relativePath,
      wikiPath: page.relativePath,
      legacyStem: fileStem(page.relativePath),
    })),
  )
  const byTitle = uniqueMap(
    pages
      .map((page) => [stringField(page.parsed.frontmatter, "title"), page.relativePath] as const)
      .filter((entry): entry is readonly [string, string] => !!entry[0]),
  )

  return {
    resolve(raw: string): string | null {
      return graphResolver.resolve(raw) ?? byTitle.get(raw.trim().toLowerCase()) ?? null
    },
  }
}

function hasUnmatchedWikilinkBrackets(content: string): boolean {
  const markerRe = /\[\[|\]\]/g

  for (const segment of splitMarkdownCodeAware(content)) {
    if (segment.kind === "code") continue

    let depth = 0
    let match: RegExpExecArray | null
    markerRe.lastIndex = 0
    while ((match = markerRe.exec(segment.text)) !== null) {
      if (match[0] === "[[") {
        depth++
      } else if (depth === 0) {
        return true
      } else {
        depth--
      }
    }
    if (depth > 0) return true
  }

  return false
}

function hasBalancedIllegalWikilinks(content: string): boolean {
  const balancedWikilinkRe = /\[\[([\s\S]*?)\]\]/g

  for (const segment of splitMarkdownCodeAware(content)) {
    if (segment.kind === "code") continue

    let match: RegExpExecArray | null
    balancedWikilinkRe.lastIndex = 0
    while ((match = balancedWikilinkRe.exec(segment.text)) !== null) {
      const rawTargetAndAlias = match[1]
      if (rawTargetAndAlias.includes("[") || rawTargetAndAlias.includes("]")) continue
      if (isIllegalWikilinkTarget(rawTargetAndAlias)) return true
    }
  }

  return false
}

function isIllegalWikilinkTarget(rawTargetAndAlias: string): boolean {
  const pipeIndex = rawTargetAndAlias.indexOf("|")
  const rawTarget = pipeIndex === -1 ? rawTargetAndAlias : rawTargetAndAlias.slice(0, pipeIndex)
  return !rawTarget.trim() || rawTarget.includes("\n") || rawTarget.includes("\r")
}

function toValidatedPage(page: LoadedWikiPage): OkfValidatedPage {
  const localType = stringField(page.parsed.frontmatter, "type")
  return {
    relativePath: page.relativePath,
    absolutePath: page.absolutePath,
    title: stringField(page.parsed.frontmatter, "title"),
    localType,
    okfType: okfTypeForLocalType(localType),
    body: page.parsed.body,
    frontmatter: page.parsed.frontmatter,
    rawFrontmatterBlock: page.parsed.rawBlock,
  }
}

function stringField(
  frontmatter: Record<string, FrontmatterValue> | null,
  key: string,
): string | null {
  const value = frontmatter?.[key]
  return typeof value === "string" && value.trim() ? value.trim() : null
}

function uniqueMap(entries: readonly (readonly [string, string])[]): Map<string, string> {
  const all = new Map<string, string[]>()
  for (const [key, value] of entries) {
    const normalizedKey = key.trim().toLowerCase()
    all.set(normalizedKey, [...(all.get(normalizedKey) ?? []), value])
  }

  const unique = new Map<string, string>()
  for (const [key, values] of all) {
    if (values.length === 1) unique.set(key, values[0])
  }
  return unique
}

function projectRelativeWikiPath(projectPath: string, filePath: string): string | null {
  const normalizedPath = normalizePath(filePath)
  const prefix = `${projectPath}/`
  const relativePath = normalizedPath.startsWith(prefix) ? normalizedPath.slice(prefix.length) : normalizedPath
  const normalizedRelativePath = normalizeRelativePath(relativePath)
  if (!normalizedRelativePath.startsWith("wiki/")) return null
  if (!normalizedRelativePath.endsWith(".md")) return null
  if (normalizedRelativePath.includes("../") || normalizedRelativePath.includes("/../")) return null
  return normalizedRelativePath
}

function normalizeProjectPath(projectPath: string): string {
  return normalizePath(projectPath).replace(/\/+$/, "")
}

function normalizeRelativePath(relativePath: string): string {
  return normalizePath(relativePath).replace(/^\/+/, "")
}

function fileStem(relativePath: string): string {
  const name = relativePath.split("/").pop() ?? relativePath
  return name.replace(/\.md$/i, "")
}
