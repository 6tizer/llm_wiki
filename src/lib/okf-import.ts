import { createDirectory, listDirectory, readFile, writeFileAtomic } from "@/commands/fs"
import { parseFrontmatter, type FrontmatterValue } from "@/lib/frontmatter"
import { localTypeForOkfType } from "@/lib/okf-validate"
import { joinPath, normalizePath, isAbsolutePath } from "@/lib/path-utils"
import { loadProjectWikiSchemaRouting, type WikiSchemaRouting } from "@/lib/wiki-schema"
import { GENERATION_WIKI_TYPES, wikiDirectoryForType } from "@/lib/wiki-page-types"
import { flattenMdFiles } from "@/lib/wiki-utils"
import type {
  OkfImportIssue,
  OkfImportOptions,
  OkfImportPlan,
  OkfImportPlanPage,
  OkfImportRoutingStrategy,
} from "@/lib/okf-types"

interface LoadedOkfPage {
  relativePath: string
  content: string
  rawFrontmatterBlock: string
  body: string
  title: string | null
  okfType: string
  localType: string
}

interface RouteResult {
  targetDirectory: string
  routingStrategy: OkfImportRoutingStrategy
}

interface TargetResult {
  targetRelativePath: string
  action: OkfImportPlanPage["action"]
  renamed: boolean
  conflict: boolean
  reason?: OkfImportPlanPage["reason"]
}

/**
 * Build a deterministic OKF import plan without writing files.
 */
export async function previewOkfImport(
  sourceDir: string,
  targetProjectPath: string,
): Promise<OkfImportPlan> {
  return buildOkfImportPlan(sourceDir, targetProjectPath, false)
}

/**
 * Import an OKF-compatible bundle when `options.apply` is true; otherwise return a preview plan.
 */
export async function importOkfBundle(
  sourceDir: string,
  targetProjectPath: string,
  options: OkfImportOptions = {},
): Promise<OkfImportPlan> {
  return buildOkfImportPlan(sourceDir, targetProjectPath, options.apply === true, options.onWikiChanged)
}

async function buildOkfImportPlan(
  sourceDir: string,
  targetProjectPath: string,
  apply: boolean,
  onWikiChanged?: OkfImportOptions["onWikiChanged"],
): Promise<OkfImportPlan> {
  const normalizedSourceDir = normalizeRootPath(sourceDir)
  const normalizedTargetProjectPath = normalizeRootPath(targetProjectPath)
  const issues: OkfImportIssue[] = []
  const routing = await loadProjectWikiSchemaRouting(normalizedTargetProjectPath)
  const pages = await loadOkfSourcePages(normalizedSourceDir, routing, issues)
  const plannedTargetContent = new Map<string, string>()
  const existingTargetContent = new Map<string, string | null>()
  const planPages: OkfImportPlanPage[] = []

  for (const page of pages) {
    const route = routeLocalType(page.localType, routing)
    if (!isSafeWikiTargetDirectory(route.targetDirectory)) {
      issues.push({
        severity: "error",
        code: "invalid_target_path",
        path: page.relativePath,
        message: `Schema route for type "${page.localType}" points outside wiki: "${route.targetDirectory}".`,
      })
      continue
    }

    const baseRelativePath = joinPath(route.targetDirectory, safeMarkdownBasename(page.relativePath))
    if (!isSafeWikiTargetPath(baseRelativePath)) {
      issues.push({
        severity: "error",
        code: "invalid_target_path",
        path: page.relativePath,
        message: `Import target path for "${page.relativePath}" is unsafe: "${baseRelativePath}".`,
      })
      continue
    }

    const content = replaceFrontmatterType(page, page.localType)
    const target = await chooseTargetPath(
      normalizedTargetProjectPath,
      baseRelativePath,
      content,
      plannedTargetContent,
      existingTargetContent,
    )

    planPages.push({
      sourceRelativePath: page.relativePath,
      targetRelativePath: target.targetRelativePath,
      targetDirectory: route.targetDirectory,
      title: page.title,
      okfType: page.okfType,
      localType: page.localType,
      content,
      action: target.action,
      routingStrategy: route.routingStrategy,
      renamed: target.renamed,
      conflict: target.conflict,
      reason: target.reason,
    })
  }

  if (apply) {
    const dirs = new Set(
      planPages
        .filter((page) => page.action === "write")
        .map((page) => dirname(joinPath(normalizedTargetProjectPath, page.targetRelativePath))),
    )
    for (const dir of [...dirs].sort()) {
      await createDirectory(dir)
    }
    for (const page of planPages) {
      if (page.action !== "write") continue
      const targetPath = joinPath(normalizedTargetProjectPath, page.targetRelativePath)
      let beforeText = ""
      let existedBefore = false
      try {
        beforeText = await readFile(targetPath)
        existedBefore = true
      } catch {
        beforeText = ""
      }
      await writeFileAtomic(targetPath, page.content)
      onWikiChanged?.({
        path: page.targetRelativePath,
        operation: existedBefore ? "update" : "create",
        existedBefore,
        beforeText,
      })
    }
  }

  return {
    applied: apply,
    pages: planPages,
    issues,
    summary: {
      totalPages: planPages.length,
      writeCount: planPages.filter((page) => page.action === "write").length,
      skippedCount: planPages.filter((page) => page.action === "skip").length,
      issueCount: issues.length,
    },
  }
}

async function loadOkfSourcePages(
  sourceDir: string,
  routing: WikiSchemaRouting | null,
  issues: OkfImportIssue[],
): Promise<LoadedOkfPage[]> {
  let tree: Awaited<ReturnType<typeof listDirectory>>
  try {
    tree = await listDirectory(`${sourceDir}/wiki`)
  } catch {
    issues.push({
      severity: "error",
      code: "source_wiki_missing",
      path: "wiki",
      message: "Missing or unreadable OKF source wiki directory.",
    })
    return []
  }

  const pages: LoadedOkfPage[] = []
  for (const file of flattenMdFiles(tree)) {
    const relativePath = sourceRelativePath(sourceDir, file.path)
    if (!relativePath) {
      issues.push({
        severity: "warn",
        code: "invalid_source_path",
        path: file.path,
        message: `Ignored unsafe or unsupported OKF source path "${file.path}".`,
      })
      continue
    }

    let content = ""
    try {
      content = await readFile(file.path)
    } catch {
      issues.push({
        severity: "error",
        code: "read_failed",
        path: relativePath,
        message: `Could not read OKF source file "${relativePath}".`,
      })
      continue
    }

    const parsed = parseFrontmatter(content)
    const okfType = stringField(parsed.frontmatter, "type")
    const title = stringField(parsed.frontmatter, "title")
    if (!okfType) {
      issues.push({
        severity: "error",
        code: "missing_type",
        path: relativePath,
        message: `OKF page "${relativePath}" must declare frontmatter "type".`,
      })
      continue
    }
    if (!title) {
      issues.push({
        severity: "warn",
        code: "missing_title",
        path: relativePath,
        message: `OKF page "${relativePath}" does not declare frontmatter "title".`,
      })
    }

    pages.push({
      relativePath,
      content,
      rawFrontmatterBlock: parsed.rawBlock,
      body: parsed.body,
      title,
      okfType,
      localType: canonicalLocalType(okfType, routing),
    })
  }

  return pages.sort((a, b) => a.relativePath.localeCompare(b.relativePath))
}

function canonicalLocalType(okfType: string, routing: WikiSchemaRouting | null): string {
  const mappedType = localTypeForOkfType(okfType) ?? okfType
  const mappedLower = mappedType.toLowerCase()
  const schemaType = Object.keys(routing?.typeDirs ?? {}).find((type) => type.toLowerCase() === mappedLower)
  if (schemaType) return schemaType
  const builtInType = GENERATION_WIKI_TYPES.find((type) => type.toLowerCase() === mappedLower)
  return builtInType ?? mappedType
}

function routeLocalType(localType: string, routing: WikiSchemaRouting | null): RouteResult {
  const schemaDir = routing?.typeDirs[localType]
  if (schemaDir) {
    return {
      targetDirectory: schemaDir,
      routingStrategy: "schema",
    }
  }

  const defaultDir = defaultDirectoryForLocalType(localType)
  if (defaultDir) {
    return {
      targetDirectory: `wiki/${defaultDir}`,
      routingStrategy: "default",
    }
  }

  return {
    targetDirectory: "wiki",
    routingStrategy: "root",
  }
}

function defaultDirectoryForLocalType(localType: string): string | null {
  const type = GENERATION_WIKI_TYPES.find((candidate) => candidate.toLowerCase() === localType.toLowerCase())
  return type ? wikiDirectoryForType(type) : null
}

async function chooseTargetPath(
  targetProjectPath: string,
  baseRelativePath: string,
  content: string,
  plannedTargetContent: Map<string, string>,
  existingTargetContent: Map<string, string | null>,
): Promise<TargetResult> {
  let conflict = false
  for (let index = 1; ; index++) {
    const targetRelativePath = index === 1 ? baseRelativePath : suffixedMarkdownPath(baseRelativePath, index)
    const plannedContent = plannedTargetContent.get(targetRelativePath)
    if (plannedContent !== undefined) {
      if (plannedContent === content) {
        return {
          targetRelativePath,
          action: "skip",
          renamed: targetRelativePath !== baseRelativePath,
          conflict,
          reason: "identical",
        }
      }
      conflict = true
      continue
    }

    const absolutePath = joinPath(targetProjectPath, targetRelativePath)
    const existingContent = await readExistingFile(absolutePath, existingTargetContent)
    if (existingContent !== null) {
      plannedTargetContent.set(targetRelativePath, existingContent)
      if (existingContent === content) {
        return {
          targetRelativePath,
          action: "skip",
          renamed: targetRelativePath !== baseRelativePath,
          conflict,
          reason: "identical",
        }
      }
      conflict = true
      continue
    }

    plannedTargetContent.set(targetRelativePath, content)
    return {
      targetRelativePath,
      action: "write",
      renamed: targetRelativePath !== baseRelativePath,
      conflict,
    }
  }
}

async function readExistingFile(path: string, cache: Map<string, string | null>): Promise<string | null> {
  if (cache.has(path)) return cache.get(path) ?? null
  try {
    const content = await readFile(path)
    cache.set(path, content)
    return content
  } catch {
    cache.set(path, null)
    return null
  }
}

function replaceFrontmatterType(page: LoadedOkfPage, localType: string): string {
  if (!page.rawFrontmatterBlock) return page.content

  let replaced = false
  const rawFrontmatterBlock = page.rawFrontmatterBlock
    .split(/(?<=\n)/)
    .map((line) => {
      if (replaced) return line

      const lineEnding = line.match(/\r?\n$/)?.[0] ?? ""
      const body = lineEnding ? line.slice(0, -lineEnding.length) : line
      const match = body.match(/^(type\s*:\s*)(?:(["'])(.*?)\2|([^#\r\n]*?))(\s*(?:#.*)?)$/)
      if (!match) return line

      replaced = true
      const prefix = match[1]
      const quote = match[2] ?? ""
      const suffix = match[5] ?? ""
      return `${prefix}${quote}${localType}${quote}${suffix}${lineEnding}`
    })
    .join("")

  if (!replaced) return page.content
  return `${rawFrontmatterBlock}${page.body}`
}

function sourceRelativePath(sourceDir: string, filePath: string): string | null {
  const normalizedPath = normalizePath(filePath)
  const prefix = `${sourceDir}/`
  const relativePath = normalizedPath.startsWith(prefix) ? normalizedPath.slice(prefix.length) : normalizedPath
  const normalizedRelativePath = normalizePath(relativePath).replace(/^\/+/, "")
  if (isAbsolutePath(relativePath)) return null
  if (!normalizedRelativePath.startsWith("wiki/")) return null
  if (!normalizedRelativePath.endsWith(".md")) return null
  if (normalizedRelativePath.split("/").includes("..")) return null
  return normalizedRelativePath
}

function isSafeWikiTargetDirectory(value: string): boolean {
  const normalized = normalizePath(value)
  if (isAbsolutePath(value)) return false
  if (normalized !== "wiki" && !normalized.startsWith("wiki/")) return false
  return normalized.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..")
}

function isSafeWikiTargetPath(value: string): boolean {
  const normalized = normalizePath(value)
  if (isAbsolutePath(value)) return false
  if (!normalized.endsWith(".md")) return false
  return isSafeWikiTargetDirectory(dirname(normalized))
}

function safeMarkdownBasename(relativePath: string): string {
  const name = relativePath.split("/").pop() ?? "page.md"
  const sanitized = name.replace(/[\\/:\0]/g, "")
  return sanitized.endsWith(".md") && sanitized !== ".md" ? sanitized : "page.md"
}

function suffixedMarkdownPath(relativePath: string, index: number): string {
  const suffix = `-${index}`
  return relativePath.replace(/\.md$/i, `${suffix}.md`)
}

function stringField(
  frontmatter: Record<string, FrontmatterValue> | null,
  key: string,
): string | null {
  const value = frontmatter?.[key]
  return typeof value === "string" && value.trim() ? value.trim() : null
}

function dirname(path: string): string {
  const normalizedPath = normalizePath(path)
  const index = normalizedPath.lastIndexOf("/")
  return index >= 0 ? normalizedPath.slice(0, index) : "."
}

function normalizeRootPath(path: string): string {
  return normalizePath(path).replace(/\/+$/, "")
}
