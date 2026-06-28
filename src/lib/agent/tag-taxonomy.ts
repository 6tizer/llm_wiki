import { fileExists, listDirectory, readFile, writeFileAtomic } from "@/commands/fs"
import { parseFrontmatter, type FrontmatterValue } from "@/lib/frontmatter"
import { normalizePath } from "@/lib/path-utils"
import { flattenMdFiles } from "@/lib/wiki-utils"

export const TAG_TAXONOMY_SCHEMA_VERSION = 1

export const TAG_TAXONOMY_REL_PATH = ".llm-wiki/tag-taxonomy.json"

export const DEFAULT_TAG_TAXONOMY_SAFETY: TagTaxonomySafety = {
  maxL1: 12,
  maxL2PerL1: 12,
  maxL3PerL2: 16,
  maxTotalNodes: 500,
  maxNewNodesPerRun: 60,
  allowNewL1ByDefault: false,
}

export type TagTaxonomyLevel = 1 | 2 | 3
export type TagTaxonomyAction = "bootstrap" | "growth" | "rollback"
export type TagTaxonomyCreatedBy = "bootstrap" | "growth" | "rollback" | "unknown"

export interface TagTaxonomySafety {
  maxL1: number
  maxL2PerL1: number
  maxL3PerL2: number
  maxTotalNodes: number
  maxNewNodesPerRun: number
  allowNewL1ByDefault: boolean
}

export interface TagTaxonomyNode {
  slug: string
  label: string
  level: TagTaxonomyLevel
  evidence: string[]
  confidence: number
  createdBy: TagTaxonomyCreatedBy
  updatedAt: number
  batchId: string
  truncated?: boolean
  children?: TagTaxonomyNode[]
}

export interface TagTaxonomyChangeLogEntry {
  batchId: string
  action: TagTaxonomyAction
  updatedAt: number
  addedNodeSlugs: string[]
  removedNodeSlugs?: string[]
  truncated: boolean
  summary: string
}

export interface TagTaxonomyRoot {
  schemaVersion: typeof TAG_TAXONOMY_SCHEMA_VERSION
  updatedAt: number
  safety: TagTaxonomySafety
  tree: TagTaxonomyNode[]
  changeLog: TagTaxonomyChangeLogEntry[]
}

export interface TagTaxonomyIssue {
  code:
    | "bad_json"
    | "future_schema_version"
    | "invalid_root"
    | "invalid_schema_version"
    | "invalid_updated_at"
    | "invalid_safety"
    | "invalid_tree"
    | "invalid_node"
    | "invalid_change_log"
    | "stale_updated_at"
  path?: string
  message: string
}

export interface LoadTagTaxonomyResult {
  taxonomy: TagTaxonomyRoot
  issues: TagTaxonomyIssue[]
  conflict: boolean
}

export interface SaveTagTaxonomyOptions {
  expectedUpdatedAt?: unknown
  now?: () => number
}

export interface SaveTagTaxonomyResult extends LoadTagTaxonomyResult {
  saved: boolean
}

export interface TagTaxonomyReportDetail {
  code: string
  path?: string
  message: string
}

export interface TagTaxonomyOperationReport {
  action: "bootstrap" | "growth" | "rollback"
  dryRun: boolean
  batchId: string
  added: number
  removed: number
  truncated: number
  skipped: number
  wrote: boolean
  counts: {
    pagesScanned: number
    pagesWithFrontmatter: number
    totalNodes: number
    batches: number
  }
  addedNodeSlugs: string[]
  removedNodeSlugs: string[]
  details: TagTaxonomyReportDetail[]
}

export interface TagTaxonomyRunOptions {
  dryRun?: boolean
  now?: () => number
}

interface WikiPageFact {
  relativePath: string
  title: string
  type: string
  tags: string[]
  wikilinks: string[]
}

interface Candidate {
  l1Slug: string
  l1Label: string
  l2Slug: string
  l2Label: string
  l3Slug: string
  l3Label: string
  evidence: string[]
}

const DEFAULT_UPDATED_AT = 0
const UNCATEGORIZED_SLUG = "uncategorized"
const UNTAGGED_SLUG = "untagged"

function defaultNow(): number {
  return Date.now()
}

function projectRelativePath(projectPath: string, relativePath: string): string {
  const normalized = normalizePath(projectPath).replace(/\/+$/, "")
  return normalized ? `${normalized}/${relativePath}` : `/${relativePath}`
}

function issue(
  code: TagTaxonomyIssue["code"],
  message: string,
  path?: string,
): TagTaxonomyIssue {
  return { code, message, path }
}

function detail(code: string, message: string, path?: string): TagTaxonomyReportDetail {
  return { code, message, path }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function isValidUpdatedAt(value: unknown): value is number {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    Math.trunc(value) === value
}

function isValidLevel(value: unknown): value is TagTaxonomyLevel {
  return value === 1 || value === 2 || value === 3
}

function isValidConfidence(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback
  return Math.max(min, Math.min(max, Math.trunc(value)))
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return [...new Set(value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean))].sort()
}

function normalizeCreatedBy(value: unknown): TagTaxonomyCreatedBy {
  return value === "bootstrap" || value === "growth" || value === "rollback"
    ? value
    : "unknown"
}

function childrenFor(node: TagTaxonomyNode): TagTaxonomyNode[] {
  if (!node.children) node.children = []
  return node.children
}

function nodePath(parentPath: string, slug: string): string {
  return parentPath ? `${parentPath}/${slug}` : slug
}

function relativeWikiPath(projectPath: string, filePath: string): string {
  const root = `${normalizePath(projectPath).replace(/\/+$/, "")}/wiki/`
  const normalized = normalizePath(filePath)
  return normalized.startsWith(root) ? `wiki/${normalized.slice(root.length)}` : normalized
}

function slugify(value: string, fallback: string): string {
  const slug = value
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/['"]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
  return slug || fallback
}

function labelFromSlug(slug: string): string {
  return slug
    .split("-")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ")
}

function frontmatterString(value: FrontmatterValue | undefined): string {
  return typeof value === "string" ? value.trim() : ""
}

function frontmatterStringArray(value: FrontmatterValue | undefined): string[] {
  if (typeof value === "string") return value.trim() ? [value.trim()] : []
  if (Array.isArray(value)) return value.map((item) => item.trim()).filter(Boolean)
  return []
}

function extractWikilinks(content: string): string[] {
  const links = new Set<string>()
  for (const match of content.matchAll(/\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]/g)) {
    const value = match[1]?.trim()
    if (value) links.add(value)
  }
  return [...links].sort((a, b) => a.localeCompare(b))
}

function countNodes(nodes: readonly TagTaxonomyNode[]): number {
  return nodes.reduce((sum, node) => sum + 1 + countNodes(node.children ?? []), 0)
}

function batchCount(taxonomy: TagTaxonomyRoot): number {
  return taxonomy.changeLog.filter((entry) => entry.action === "bootstrap" || entry.action === "growth").length
}

function reportBase(
  action: TagTaxonomyOperationReport["action"],
  dryRun: boolean,
  batchId: string,
  taxonomy: TagTaxonomyRoot,
  details: TagTaxonomyReportDetail[] = [],
): TagTaxonomyOperationReport {
  return {
    action,
    dryRun,
    batchId,
    added: 0,
    removed: 0,
    truncated: 0,
    skipped: details.length,
    wrote: false,
    counts: {
      pagesScanned: 0,
      pagesWithFrontmatter: 0,
      totalNodes: countNodes(taxonomy.tree),
      batches: batchCount(taxonomy),
    },
    addedNodeSlugs: [],
    removedNodeSlugs: [],
    details,
  }
}

function cloneTaxonomy(taxonomy: TagTaxonomyRoot): TagTaxonomyRoot {
  return JSON.parse(JSON.stringify(taxonomy)) as TagTaxonomyRoot
}

/** Returns an empty, deterministic tag taxonomy document. */
export function defaultTagTaxonomy(updatedAt = DEFAULT_UPDATED_AT): TagTaxonomyRoot {
  return {
    schemaVersion: TAG_TAXONOMY_SCHEMA_VERSION,
    updatedAt,
    safety: { ...DEFAULT_TAG_TAXONOMY_SAFETY },
    tree: [],
    changeLog: [],
  }
}

/** Returns the project-relative tag taxonomy sidecar path. */
export function tagTaxonomyPath(projectPath: string): string {
  return projectRelativePath(projectPath, TAG_TAXONOMY_REL_PATH)
}

/** Checks whether an inline taxonomy write should be rejected for stale data. */
export function isTagTaxonomyStale(expectedUpdatedAt: unknown, currentUpdatedAt: unknown): boolean {
  return !isValidUpdatedAt(expectedUpdatedAt) ||
    !isValidUpdatedAt(currentUpdatedAt) ||
    expectedUpdatedAt !== currentUpdatedAt
}

/** Normalizes persisted tag taxonomy JSON without preserving invalid nodes. */
export function normalizeTagTaxonomy(raw: unknown): LoadTagTaxonomyResult {
  const issues: TagTaxonomyIssue[] = []
  const fallback = defaultTagTaxonomy()

  if (!isPlainObject(raw)) {
    return {
      taxonomy: fallback,
      issues: [issue("invalid_root", "Tag taxonomy must be an object.")],
      conflict: false,
    }
  }

  const schemaVersion = raw.schemaVersion
  if (typeof schemaVersion === "number" && schemaVersion > TAG_TAXONOMY_SCHEMA_VERSION) {
    return {
      taxonomy: fallback,
      issues: [issue("future_schema_version", `Tag taxonomy schemaVersion ${schemaVersion} is newer than this app supports.`, "schemaVersion")],
      conflict: true,
    }
  }
  if (schemaVersion !== TAG_TAXONOMY_SCHEMA_VERSION) {
    return {
      taxonomy: fallback,
      issues: [issue("invalid_schema_version", "Tag taxonomy schemaVersion must be 1.", "schemaVersion")],
      conflict: false,
    }
  }

  const updatedAt = isValidUpdatedAt(raw.updatedAt) ? raw.updatedAt : DEFAULT_UPDATED_AT
  if (!isValidUpdatedAt(raw.updatedAt)) {
    issues.push(issue("invalid_updated_at", "Tag taxonomy updatedAt must be an epoch-ms number.", "updatedAt"))
  }

  const safety = normalizeSafety(raw.safety, issues)
  const tree = normalizeTree(raw.tree, issues)
  const changeLog = normalizeChangeLog(raw.changeLog, issues)

  return {
    taxonomy: {
      schemaVersion: TAG_TAXONOMY_SCHEMA_VERSION,
      updatedAt,
      safety,
      tree,
      changeLog,
    },
    issues,
    conflict: false,
  }
}

/** Loads the project tag taxonomy sidecar with safe fallbacks. */
export async function loadTagTaxonomy(projectPath: string): Promise<LoadTagTaxonomyResult> {
  const configPath = tagTaxonomyPath(projectPath)
  try {
    if (!(await fileExists(configPath))) {
      return { taxonomy: defaultTagTaxonomy(), issues: [], conflict: false }
    }
    return normalizeTagTaxonomy(JSON.parse(await readFile(configPath)) as unknown)
  } catch {
    return {
      taxonomy: defaultTagTaxonomy(),
      issues: [issue("bad_json", "Tag taxonomy could not be parsed.")],
      conflict: false,
    }
  }
}

/** Saves a tag taxonomy sidecar with optional updatedAt conflict protection. */
export async function saveTagTaxonomy(
  projectPath: string,
  taxonomy: TagTaxonomyRoot,
  options: SaveTagTaxonomyOptions = {},
): Promise<SaveTagTaxonomyResult> {
  const current = await loadTagTaxonomy(projectPath)
  if (current.conflict) return { ...current, saved: false }

  if (
    options.expectedUpdatedAt !== undefined &&
    isTagTaxonomyStale(options.expectedUpdatedAt, current.taxonomy.updatedAt)
  ) {
    return {
      taxonomy: current.taxonomy,
      issues: [
        ...current.issues,
        issue("stale_updated_at", "Tag taxonomy changed on disk.", "updatedAt"),
      ],
      conflict: true,
      saved: false,
    }
  }

  const normalized = normalizeTagTaxonomy({
    schemaVersion: TAG_TAXONOMY_SCHEMA_VERSION,
    updatedAt: options.now?.() ?? defaultNow(),
    safety: taxonomy.safety,
    tree: taxonomy.tree,
    changeLog: taxonomy.changeLog,
  })
  await writeFileAtomic(tagTaxonomyPath(projectPath), `${JSON.stringify(normalized.taxonomy, null, 2)}\n`)
  return { ...normalized, conflict: false, saved: true }
}

/** Previews a deterministic taxonomy bootstrap without writing files. */
export async function previewTagTaxonomyBootstrap(
  projectPath: string,
  options: TagTaxonomyRunOptions = {},
): Promise<TagTaxonomyOperationReport> {
  return runTaxonomyBuild(projectPath, "bootstrap", { ...options, dryRun: true })
}

/**
 * Applies a deterministic taxonomy bootstrap to `.llm-wiki/tag-taxonomy.json`.
 *
 * This is not a global transaction across wiki scans and the sidecar write. It
 * re-reads the sidecar with `expectedUpdatedAt` immediately before saving; if
 * the sidecar changed, it returns a conflict detail and does not write.
 */
export async function applyTagTaxonomyBootstrap(
  projectPath: string,
  options: TagTaxonomyRunOptions = {},
): Promise<TagTaxonomyOperationReport> {
  return runTaxonomyBuild(projectPath, "bootstrap", { ...options, dryRun: false })
}

/** Previews taxonomy growth against the existing sidecar without writing files. */
export async function previewTagTaxonomyGrowth(
  projectPath: string,
  options: TagTaxonomyRunOptions = {},
): Promise<TagTaxonomyOperationReport> {
  return runTaxonomyBuild(projectPath, "growth", { ...options, dryRun: true })
}

/**
 * Applies taxonomy growth without creating new explicit L1 nodes unless safety opts in.
 *
 * This is not a global transaction across wiki scans and the sidecar write. It
 * re-reads the sidecar with `expectedUpdatedAt` immediately before saving; if
 * the sidecar changed, it returns a conflict detail and does not write.
 */
export async function applyTagTaxonomyGrowth(
  projectPath: string,
  options: TagTaxonomyRunOptions = {},
): Promise<TagTaxonomyOperationReport> {
  return runTaxonomyBuild(projectPath, "growth", { ...options, dryRun: false })
}

/**
 * Rolls back the most recent bootstrap/growth batch and never edits wiki pages.
 *
 * This is not a global transaction across the initial load and sidecar write.
 * It re-reads the sidecar with `expectedUpdatedAt` immediately before saving;
 * if the sidecar changed, it returns a conflict detail and does not write.
 */
export async function rollbackLastTagTaxonomyBatch(
  projectPath: string,
  options: TagTaxonomyRunOptions = {},
): Promise<TagTaxonomyOperationReport> {
  const now = options.now?.() ?? defaultNow()
  const batchId = `taxonomy-rollback-${now}`
  const loaded = await loadTagTaxonomy(projectPath)
  const report = reportBase("rollback", false, batchId, loaded.taxonomy)
  if (loaded.conflict) {
    report.skipped += 1
    report.details.push(detail("future_schema_conflict", "Tag taxonomy is newer than this app supports."))
    return report
  }

  const last = loaded.taxonomy.changeLog[loaded.taxonomy.changeLog.length - 1]
  if (!last || (last.action !== "bootstrap" && last.action !== "growth")) {
    report.details.push(detail("no_batch", "No bootstrap/growth batch is available for rollback."))
    report.skipped += 1
    return report
  }

  const next = cloneTaxonomy(loaded.taxonomy)
  const removed = removeNodePaths(next.tree, last.addedNodeSlugs)
  report.removedNodeSlugs = removed
  report.removed = removed.length
  report.counts.totalNodes = countNodes(next.tree)
  next.updatedAt = now
  next.changeLog.push({
    batchId,
    action: "rollback",
    updatedAt: now,
    addedNodeSlugs: [],
    removedNodeSlugs: removed,
    truncated: false,
    summary: `Rolled back ${last.batchId}.`,
  })

  if (options.dryRun) {
    report.dryRun = true
    report.counts.batches = batchCount(next)
    return report
  }

  const saved = await saveTagTaxonomy(projectPath, next, {
    expectedUpdatedAt: loaded.taxonomy.updatedAt,
    now: () => now,
  })
  if (!saved.saved) {
    markSaveConflict(report, saved.issues)
    report.counts.totalNodes = countNodes(loaded.taxonomy.tree)
    report.counts.batches = batchCount(loaded.taxonomy)
    return report
  }

  report.wrote = true
  report.counts.totalNodes = countNodes(saved.taxonomy.tree)
  report.counts.batches = batchCount(saved.taxonomy)
  return report
}

function normalizeSafety(raw: unknown, issues: TagTaxonomyIssue[]): TagTaxonomySafety {
  if (!isPlainObject(raw)) {
    issues.push(issue("invalid_safety", "Tag taxonomy safety must be an object.", "safety"))
    return { ...DEFAULT_TAG_TAXONOMY_SAFETY }
  }
  return {
    maxL1: clampInt(raw.maxL1, DEFAULT_TAG_TAXONOMY_SAFETY.maxL1, 1, 100),
    maxL2PerL1: clampInt(raw.maxL2PerL1, DEFAULT_TAG_TAXONOMY_SAFETY.maxL2PerL1, 1, 200),
    maxL3PerL2: clampInt(raw.maxL3PerL2, DEFAULT_TAG_TAXONOMY_SAFETY.maxL3PerL2, 0, 500),
    maxTotalNodes: clampInt(raw.maxTotalNodes, DEFAULT_TAG_TAXONOMY_SAFETY.maxTotalNodes, 1, 5000),
    maxNewNodesPerRun: clampInt(raw.maxNewNodesPerRun, DEFAULT_TAG_TAXONOMY_SAFETY.maxNewNodesPerRun, 0, 1000),
    allowNewL1ByDefault: raw.allowNewL1ByDefault === true,
  }
}

function normalizeTree(raw: unknown, issues: TagTaxonomyIssue[]): TagTaxonomyNode[] {
  if (!Array.isArray(raw)) {
    issues.push(issue("invalid_tree", "Tag taxonomy tree must be an array.", "tree"))
    return []
  }
  return raw
    .map((node, index) => normalizeNode(node, 1, `tree.${index}`, issues))
    .filter((node): node is TagTaxonomyNode => Boolean(node))
    .sort(compareNode)
}

function normalizeNode(
  raw: unknown,
  expectedLevel: TagTaxonomyLevel,
  path: string,
  issues: TagTaxonomyIssue[],
): TagTaxonomyNode | null {
  if (!isPlainObject(raw)) {
    issues.push(issue("invalid_node", "Tag taxonomy node must be an object.", path))
    return null
  }

  const slugRaw = typeof raw.slug === "string" ? raw.slug.trim() : ""
  const slug = slugify(slugRaw, "")
  if (!slug || !isValidLevel(raw.level) || raw.level !== expectedLevel) {
    issues.push(issue("invalid_node", "Tag taxonomy node has an invalid slug or level.", path))
    return null
  }

  const label = typeof raw.label === "string" && raw.label.trim()
    ? raw.label.trim()
    : labelFromSlug(slug)
  const updatedAt = isValidUpdatedAt(raw.updatedAt) ? raw.updatedAt : DEFAULT_UPDATED_AT
  const batchId = typeof raw.batchId === "string" ? raw.batchId : ""
  const childrenRaw = Array.isArray(raw.children) ? raw.children : []
  const nextLevel = (expectedLevel + 1) as TagTaxonomyLevel
  const children = expectedLevel < 3
    ? childrenRaw
      .map((child, index) => normalizeNode(child, nextLevel, `${path}.children.${index}`, issues))
      .filter((node): node is TagTaxonomyNode => Boolean(node))
      .sort(compareNode)
    : []

  return {
    slug,
    label,
    level: expectedLevel,
    evidence: normalizeStringArray(raw.evidence),
    confidence: isValidConfidence(raw.confidence) ? raw.confidence : 0,
    createdBy: normalizeCreatedBy(raw.createdBy),
    updatedAt,
    batchId,
    ...(raw.truncated === true ? { truncated: true } : {}),
    ...(children.length > 0 ? { children } : {}),
  }
}

function normalizeChangeLog(raw: unknown, issues: TagTaxonomyIssue[]): TagTaxonomyChangeLogEntry[] {
  if (!Array.isArray(raw)) {
    issues.push(issue("invalid_change_log", "Tag taxonomy changeLog must be an array.", "changeLog"))
    return []
  }
  return raw
    .filter(isPlainObject)
    .map((entry) => ({
      batchId: typeof entry.batchId === "string" ? entry.batchId : "",
      action: entry.action === "bootstrap" || entry.action === "growth" || entry.action === "rollback"
        ? entry.action
        : "rollback",
      updatedAt: isValidUpdatedAt(entry.updatedAt) ? entry.updatedAt : DEFAULT_UPDATED_AT,
      addedNodeSlugs: normalizeStringArray(entry.addedNodeSlugs),
      removedNodeSlugs: normalizeStringArray(entry.removedNodeSlugs),
      truncated: entry.truncated === true,
      summary: typeof entry.summary === "string" ? entry.summary : "",
    }))
}

function compareNode(a: TagTaxonomyNode, b: TagTaxonomyNode): number {
  return a.slug.localeCompare(b.slug)
}

async function runTaxonomyBuild(
  projectPath: string,
  action: "bootstrap" | "growth",
  options: TagTaxonomyRunOptions,
): Promise<TagTaxonomyOperationReport> {
  const now = options.now?.() ?? defaultNow()
  const dryRun = options.dryRun === true
  const batchId = `taxonomy-${action}-${now}`
  const loaded = await loadTagTaxonomy(projectPath)
  const report = reportBase(action, dryRun, batchId, loaded.taxonomy)
  if (loaded.conflict) {
    report.skipped += 1
    report.details.push(detail("future_schema_conflict", "Tag taxonomy is newer than this app supports."))
    return report
  }

  const scanned = await scanWikiPages(projectPath)
  report.counts.pagesScanned = scanned.pagesScanned
  report.counts.pagesWithFrontmatter = scanned.pages.length
  report.details.push(...scanned.details)
  report.skipped += scanned.skipped

  const next = cloneTaxonomy(loaded.taxonomy)
  const candidates = buildCandidates(scanned.pages)
  addCandidates(next, candidates, action, batchId, now, report)
  next.tree.sort(compareNode)
  report.counts.totalNodes = countNodes(next.tree)

  if (dryRun || report.added === 0) {
    return report
  }

  next.updatedAt = now
  next.changeLog.push({
    batchId,
    action,
    updatedAt: now,
    addedNodeSlugs: report.addedNodeSlugs,
    truncated: report.truncated > 0,
    summary: `${action} added ${report.added} taxonomy nodes.`,
  })
  const saved = await saveTagTaxonomy(projectPath, next, {
    expectedUpdatedAt: loaded.taxonomy.updatedAt,
    now: () => now,
  })
  if (!saved.saved) {
    markSaveConflict(report, saved.issues)
    report.counts.totalNodes = countNodes(loaded.taxonomy.tree)
    report.counts.batches = batchCount(loaded.taxonomy)
    return report
  }

  report.wrote = true
  report.counts.totalNodes = countNodes(saved.taxonomy.tree)
  report.counts.batches = batchCount(saved.taxonomy)
  return report
}

function markSaveConflict(
  report: TagTaxonomyOperationReport,
  issues: readonly TagTaxonomyIssue[],
): void {
  const stale = issues.find((item) => item.code === "stale_updated_at")
  const future = issues.find((item) => item.code === "future_schema_version")
  const selected = stale ?? future
  report.skipped += 1
  report.details.push(detail(
    selected?.code ?? "save_conflict",
    selected?.message ?? "Tag taxonomy changed on disk before save.",
    selected?.path,
  ))
}

async function scanWikiPages(projectPath: string): Promise<{
  pages: WikiPageFact[]
  pagesScanned: number
  skipped: number
  details: TagTaxonomyReportDetail[]
}> {
  const details: TagTaxonomyReportDetail[] = []
  let tree: Awaited<ReturnType<typeof listDirectory>>
  try {
    tree = await listDirectory(projectRelativePath(projectPath, "wiki"))
  } catch {
    return {
      pages: [],
      pagesScanned: 0,
      skipped: 1,
      details: [detail("wiki_missing", "Project wiki directory could not be read.", "wiki")],
    }
  }

  const files = flattenMdFiles(tree).sort((a, b) => a.path.localeCompare(b.path))
  const pages: WikiPageFact[] = []
  for (const file of files) {
    const content = await readFile(file.path)
    const parsed = parseFrontmatter(content)
    if (!parsed.frontmatter) {
      details.push(detail("no_frontmatter", "Markdown page has no frontmatter and was skipped.", relativeWikiPath(projectPath, file.path)))
      continue
    }
    const title = frontmatterString(parsed.frontmatter.title) ||
      file.name.replace(/\.md$/i, "")
    const type = frontmatterString(parsed.frontmatter.type) || UNCATEGORIZED_SLUG
    const tags = [...new Set(frontmatterStringArray(parsed.frontmatter.tags))].sort((a, b) => a.localeCompare(b))
    pages.push({
      relativePath: relativeWikiPath(projectPath, file.path),
      title,
      type,
      tags,
      wikilinks: extractWikilinks(content),
    })
  }
  return {
    pages,
    pagesScanned: files.length,
    skipped: details.length,
    details,
  }
}

function buildCandidates(pages: WikiPageFact[]): Candidate[] {
  const byKey = new Map<string, Candidate>()
  for (const page of pages) {
    const l1Slug = slugify(page.type, UNCATEGORIZED_SLUG)
    const l1Label = page.type === UNCATEGORIZED_SLUG ? "Uncategorized" : page.type
    const tags = page.tags.length > 0 ? page.tags : [UNTAGGED_SLUG]
    const l3Slug = slugify(page.title || page.relativePath.replace(/\.md$/i, ""), "page")
    const l3Label = page.title || labelFromSlug(l3Slug)
    for (const tag of tags) {
      const l2Slug = slugify(tag, UNTAGGED_SLUG)
      const l2Label = tag === UNTAGGED_SLUG ? "Untagged" : tag
      const key = `${l1Slug}/${l2Slug}/${l3Slug}`
      const existing = byKey.get(key)
      const evidence = evidenceFor(page)
      if (existing) {
        existing.evidence = [...new Set([...existing.evidence, ...evidence])].sort()
      } else {
        byKey.set(key, { l1Slug, l1Label, l2Slug, l2Label, l3Slug, l3Label, evidence })
      }
    }
  }
  return [...byKey.values()].sort((a, b) =>
    `${a.l1Slug}/${a.l2Slug}/${a.l3Slug}`.localeCompare(`${b.l1Slug}/${b.l2Slug}/${b.l3Slug}`),
  )
}

function evidenceFor(page: WikiPageFact): string[] {
  const hints = [
    page.relativePath,
    `title:${page.title}`,
    `type:${page.type}`,
    ...page.wikilinks.slice(0, 5).map((link) => `wikilink:${link}`),
  ]
  return [...new Set(hints)].sort()
}

function addCandidates(
  taxonomy: TagTaxonomyRoot,
  candidates: Candidate[],
  action: "bootstrap" | "growth",
  batchId: string,
  updatedAt: number,
  report: TagTaxonomyOperationReport,
): void {
  for (const candidate of candidates) {
    const l1 = ensureL1(taxonomy, candidate, action, batchId, updatedAt, report)
    if (!l1) continue
    const l2 = ensureL2(taxonomy, l1, candidate, action, batchId, updatedAt, report)
    if (!l2) continue
    ensureL3(taxonomy, l1, l2, candidate, action, batchId, updatedAt, report)
  }
}

function canAddNode(taxonomy: TagTaxonomyRoot, report: TagTaxonomyOperationReport): boolean {
  if (report.added >= taxonomy.safety.maxNewNodesPerRun) return false
  return countNodes(taxonomy.tree) < taxonomy.safety.maxTotalNodes
}

function ensureL1(
  taxonomy: TagTaxonomyRoot,
  candidate: Candidate,
  action: "bootstrap" | "growth",
  batchId: string,
  updatedAt: number,
  report: TagTaxonomyOperationReport,
): TagTaxonomyNode | null {
  const existing = taxonomy.tree.find((node) => node.slug === candidate.l1Slug)
  if (existing) {
    existing.evidence = [...new Set([...existing.evidence, ...candidate.evidence])].sort()
    return existing
  }

  if (
    action === "growth" &&
    !taxonomy.safety.allowNewL1ByDefault &&
    candidate.l1Slug !== UNCATEGORIZED_SLUG
  ) {
    report.details.push(detail("new_l1_disabled", `Skipped ${candidate.l1Slug} because new L1 creation is disabled.`))
    report.skipped += 1
    return null
  }

  if (taxonomy.tree.length >= taxonomy.safety.maxL1 || !canAddNode(taxonomy, report)) {
    const fallback = candidate.l1Slug === UNCATEGORIZED_SLUG
      ? taxonomy.tree.find((node) => node.slug === UNCATEGORIZED_SLUG)
      : undefined
    if (fallback) {
      fallback.truncated = true
      report.truncated += 1
      report.details.push(detail("l1_cap", "Mapped uncategorized page to existing uncategorized because the L1 cap was reached."))
      return fallback
    }
    report.truncated += 1
    report.skipped += 1
    report.details.push(detail("l1_cap", `Skipped ${candidate.l1Slug} because the L1 cap was reached.`))
    return null
  }

  const node: TagTaxonomyNode = {
    slug: candidate.l1Slug,
    label: candidate.l1Label,
    level: 1,
    evidence: candidate.evidence,
    confidence: 0.6,
    createdBy: action,
    updatedAt,
    batchId,
    children: [],
  }
  taxonomy.tree.push(node)
  taxonomy.tree.sort(compareNode)
  report.added += 1
  report.addedNodeSlugs.push(node.slug)
  return node
}

function ensureL2(
  taxonomy: TagTaxonomyRoot,
  l1: TagTaxonomyNode,
  candidate: Candidate,
  action: "bootstrap" | "growth",
  batchId: string,
  updatedAt: number,
  report: TagTaxonomyOperationReport,
): TagTaxonomyNode | null {
  const children = childrenFor(l1)
  const existing = children.find((node) => node.slug === candidate.l2Slug)
  if (existing) {
    existing.evidence = [...new Set([...existing.evidence, ...candidate.evidence])].sort()
    return existing
  }

  if (children.length >= taxonomy.safety.maxL2PerL1 || !canAddNode(taxonomy, report)) {
    l1.truncated = true
    report.truncated += 1
    report.skipped += 1
    report.details.push(detail("l2_cap", `Skipped ${l1.slug}/${candidate.l2Slug} because a safety cap was reached.`))
    return null
  }

  const node: TagTaxonomyNode = {
    slug: candidate.l2Slug,
    label: candidate.l2Label,
    level: 2,
    evidence: candidate.evidence,
    confidence: action === "bootstrap" ? 0.7 : 0.65,
    createdBy: action,
    updatedAt,
    batchId,
    children: [],
  }
  children.push(node)
  children.sort(compareNode)
  report.added += 1
  report.addedNodeSlugs.push(nodePath(l1.slug, node.slug))
  return node
}

function ensureL3(
  taxonomy: TagTaxonomyRoot,
  l1: TagTaxonomyNode,
  l2: TagTaxonomyNode,
  candidate: Candidate,
  action: "bootstrap" | "growth",
  batchId: string,
  updatedAt: number,
  report: TagTaxonomyOperationReport,
): void {
  const children = childrenFor(l2)
  const existing = children.find((node) => node.slug === candidate.l3Slug)
  if (existing) {
    existing.evidence = [...new Set([...existing.evidence, ...candidate.evidence])].sort()
    return
  }

  if (children.length >= taxonomy.safety.maxL3PerL2 || !canAddNode(taxonomy, report)) {
    l2.truncated = true
    report.truncated += 1
    report.skipped += 1
    report.details.push(detail("l3_cap", `Skipped ${l1.slug}/${l2.slug}/${candidate.l3Slug} because a safety cap was reached.`))
    return
  }

  const node: TagTaxonomyNode = {
    slug: candidate.l3Slug,
    label: candidate.l3Label,
    level: 3,
    evidence: candidate.evidence,
    confidence: action === "bootstrap" ? 0.75 : 0.7,
    createdBy: action,
    updatedAt,
    batchId,
  }
  children.push(node)
  children.sort(compareNode)
  report.added += 1
  report.addedNodeSlugs.push(nodePath(nodePath(l1.slug, l2.slug), node.slug))
}

function removeNodePaths(tree: TagTaxonomyNode[], paths: readonly string[]): string[] {
  const removed: string[] = []
  const sorted = [...paths].sort((a, b) => b.split("/").length - a.split("/").length)
  for (const path of sorted) {
    const parts = path.split("/").filter(Boolean)
    if (parts.length === 1 && removeChild(tree, parts[0])) removed.push(path)
    if (parts.length === 2) {
      const l1 = tree.find((node) => node.slug === parts[0])
      if (l1?.children && removeChild(l1.children, parts[1])) removed.push(path)
    }
    if (parts.length === 3) {
      const l1 = tree.find((node) => node.slug === parts[0])
      const l2 = l1?.children?.find((node) => node.slug === parts[1])
      if (l2?.children && removeChild(l2.children, parts[2])) removed.push(path)
    }
  }
  return removed.sort()
}

function removeChild(nodes: TagTaxonomyNode[], slug: string): boolean {
  const index = nodes.findIndex((node) => node.slug === slug)
  if (index < 0) return false
  nodes.splice(index, 1)
  return true
}
