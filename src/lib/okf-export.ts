import { createDirectory, writeFileAtomic } from "@/commands/fs"
import { joinPath, normalizePath } from "@/lib/path-utils"
import {
  okfTypeForLocalType,
  validateOkfBundle,
} from "@/lib/okf-validate"
import type {
  OkfExportBundle,
  OkfExportedFile,
  OkfTypeReport,
  OkfValidatedPage,
} from "@/lib/okf-types"

/**
 * Build an in-memory OKF-compatible export bundle from `<project>/wiki`.
 */
export async function buildOkfExportBundle(projectPath: string): Promise<OkfExportBundle> {
  const validation = await validateOkfBundle(projectPath)
  const files = validation.pages.map(toExportedFile)

  return {
    files,
    report: {
      validation,
      typeMappings: buildTypeMappings(files),
    },
  }
}

/**
 * Write an OKF-compatible export tree into the caller-specified output directory.
 */
export async function writeOkfExportBundle(
  projectPath: string,
  outputDir: string,
): Promise<OkfExportBundle> {
  const bundle = await buildOkfExportBundle(projectPath)
  const normalizedOutputDir = normalizePath(outputDir).replace(/\/+$/, "")
  await createDirectory(normalizedOutputDir)

  const dirs = new Set<string>()
  for (const file of bundle.files) {
    dirs.add(dirname(joinPath(normalizedOutputDir, file.relativePath)))
  }
  for (const dir of [...dirs].sort()) {
    await createDirectory(dir)
  }

  for (const file of bundle.files) {
    await writeFileAtomic(joinPath(normalizedOutputDir, file.relativePath), file.content)
  }
  await writeFileAtomic(
    joinPath(normalizedOutputDir, "okf-export-report.json"),
    `${JSON.stringify(bundle.report, null, 2)}\n`,
  )

  return bundle
}

function toExportedFile(page: OkfValidatedPage): OkfExportedFile {
  const localType = page.localType
  const okfType = okfTypeForLocalType(localType)
  const content = localType && okfType && okfType !== localType
    ? replaceFrontmatterType(page, okfType)
    : pageContentFromPage(page)

  return {
    relativePath: page.relativePath,
    content,
    frontmatter: page.frontmatter ? { ...page.frontmatter, type: okfType ?? page.frontmatter.type } : null,
    rawFrontmatterBlock: rawFrontmatterBlockFromContent(content),
    body: page.body,
    localType,
    okfType,
  }
}

function replaceFrontmatterType(page: OkfValidatedPage, okfType: string): string {
  if (!page.rawFrontmatterBlock) return pageContentFromPage(page)

  const rawFrontmatterBlock = page.rawFrontmatterBlock.replace(
    /^(\s*type\s*:\s*)(["']?)([^"'\n#]+?)\2(\s*(?:#.*)?)$/im,
    (_line, prefix: string, quote: string, _value: string, suffix: string) =>
      `${prefix}${quote}${okfType}${quote}${suffix}`,
  )
  return `${rawFrontmatterBlock}${page.body}`
}

function pageContentFromPage(page: OkfValidatedPage): string {
  return `${page.rawFrontmatterBlock}${page.body}`
}

function rawFrontmatterBlockFromContent(content: string): string {
  const match = content.match(/^---\s*\r?\n[\s\S]*?\r?\n---\s*(?:\r?\n|$)/)
  return match?.[0] ?? ""
}

function buildTypeMappings(files: readonly OkfExportedFile[]): OkfTypeReport[] {
  const reports = new Map<string, OkfTypeReport>()
  for (const file of files) {
    if (!file.localType || !file.okfType) continue
    const key = `${file.localType}\0${file.okfType}`
    const existing = reports.get(key) ?? {
      localType: file.localType,
      okfType: file.okfType,
      strategy: file.localType === file.okfType ? "passthrough" : "mapped",
      count: 0,
      paths: [],
    } satisfies OkfTypeReport
    existing.count++
    existing.paths.push(file.relativePath)
    reports.set(key, existing)
  }

  return [...reports.values()].sort((a, b) => a.localType.localeCompare(b.localType))
}

function dirname(path: string): string {
  const normalizedPath = normalizePath(path)
  const index = normalizedPath.lastIndexOf("/")
  return index >= 0 ? normalizedPath.slice(0, index) : "."
}
