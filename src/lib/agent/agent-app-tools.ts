import { canonicalizePath, listDirectory, readFile } from "@/commands/fs"
import { buildWikiAnswerContext } from "@/lib/wiki-answer-context"
import { saveQueryPage } from "@/lib/save-query-page"
import { runSemanticLint, runStructuralLint, type LintResult, type LintReport } from "@/lib/lint"
import { fixLintResult, fixLintReport, runLintAndReport } from "@/lib/lint-fixer"
import { lintFixMutex } from "@/lib/lint-fix-mutex"
import { enrichWithWikilinks } from "@/lib/enrich-wikilinks"
import { hasUsableLlm } from "@/lib/has-usable-llm"
import { autoIngest, captionSourceImages } from "@/lib/ingest"
import { collectResearchSources, queueResearch } from "@/lib/deep-research"
import { buildDedupLlmCall, executeMerge, loadAllWikiPages, runDuplicateDetection } from "@/lib/dedup-runner"
import { mergeDuplicateGroup, type DuplicateGroup, type MergeResult } from "@/lib/dedup"
import { optimizeResearchTopic } from "@/lib/optimize-research-topic"
import { sweepResolvedReviews } from "@/lib/sweep-reviews"
import { executePipeline, BUILTIN_PIPELINES } from "@/lib/agent/agent-pipeline"
import { discoverSynthesisCandidates, runWikiSynthesis } from "@/lib/wiki-synthesis"
import { runAutofill } from "@/lib/agent/agent-autofill"
import { loadKnowledgeAgentsConfig } from "@/lib/agent/knowledge-agents-config"
import {
  applyTagTaxonomyBootstrap,
  applyTagTaxonomyGrowth,
  previewTagTaxonomyBootstrap,
  previewTagTaxonomyGrowth,
  rollbackLastTagTaxonomyBatch,
} from "@/lib/agent/tag-taxonomy"
import { testLlmConnection } from "@/lib/connection-tests"
import { buildOkfExportBundle } from "@/lib/okf-export"
import { importOkfBundle, previewOkfImport } from "@/lib/okf-import"
import { validateOkfBundle } from "@/lib/okf-validate"
import { isAbsolutePath, normalizePath } from "@/lib/path-utils"
import { hasConfiguredDeepResearchSources, resolveSearchConfig } from "@/lib/web-search"
import { useResearchStore } from "@/stores/research-store"
import { useReviewStore } from "@/stores/review-store"
import { useWikiStore } from "@/stores/wiki-store"
import type { SearchApiConfig } from "@/stores/wiki-store"
import type { AgentAppToolBudget, AgentResourceLimitPayload, AgentWikiChangedPayload } from "./agent-types"

export type AgentAppToolResponse = AgentAppToolSuccessResponse | AgentAppToolResourceLimitResponse

interface AgentAppToolSuccessResponse {
  ok: true
  result: unknown
  changedPaths?: string[]
  wikiChanged?: AgentWikiChangedPayload[]
}

/** Resource-limit response returned from app tools before or after a write attempt. */
export interface AgentAppToolResourceLimitResponse {
  ok: false
  result: { ok: false; error: string }
  changedPaths?: string[]
  wikiChanged?: AgentWikiChangedPayload[]
  resourceLimit: AgentResourceLimitPayload
}

/** Runtime options for app-level Agent tools. */
export interface AgentAppToolRunOptions {
  budget?: AgentAppToolBudget
}

type ToolArgs = Record<string, unknown>

interface AgentAppToolContext {
  toolName: string
  args: ToolArgs
  options: AgentAppToolRunOptions
  project: ReturnType<typeof currentProject>
  state: ReturnType<typeof useWikiStore.getState>
  projectPath: string
  budget: AgentAppToolBudget | undefined
}

type AgentAppToolHandler = (toolContext: AgentAppToolContext) => Promise<AgentAppToolResponse>

interface AgentAppToolDescriptor {
  name: string
  handler: AgentAppToolHandler
  description?: string
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter((item) => item.length > 0))].sort()
}

function wikiPathForPage(page: string): string {
  return page.startsWith("wiki/") ? page : `wiki/${page}`
}

function changedPathsFromWikiChanged(wikiChanged: AgentWikiChangedPayload[] = []): string[] {
  return uniqueStrings(wikiChanged.map((item) => item.path))
}

function budgetUnion(budget: AgentAppToolBudget, attemptedPaths: string[]): string[] {
  return uniqueStrings([...budget.changedPaths, ...attemptedPaths])
}

function resourceLimitResponse(
  toolName: string,
  budget: AgentAppToolBudget,
  attemptedPaths: string[],
  message: string,
  actualChanges?: {
    changedPaths?: string[]
    wikiChanged?: AgentWikiChangedPayload[]
  },
): AgentAppToolResourceLimitResponse {
  const changedPaths = budgetUnion(budget, attemptedPaths)
  return {
    ok: false,
    result: { ok: false, error: message },
    ...(actualChanges?.changedPaths ? { changedPaths: actualChanges.changedPaths } : {}),
    ...(actualChanges?.wikiChanged ? { wikiChanged: actualChanges.wikiChanged } : {}),
    resourceLimit: {
      kind: "resource_limit",
      limitKind: "max_files_changed",
      limit: budget.maxFilesChanged,
      used: uniqueStrings(budget.changedPaths).length,
      attempted: changedPaths.length,
      changedPaths,
      path: attemptedPaths[0] ?? "wiki",
      toolName,
      message,
      recovery: "split_task",
    },
  }
}

function preflightBudget(
  toolName: string,
  budget: AgentAppToolBudget | undefined,
  attemptedPaths: string[],
): AgentAppToolResourceLimitResponse | undefined {
  if (!budget || budget.maxFilesChangedEnabled !== true) return undefined
  const cleanPaths = uniqueStrings(attemptedPaths)
  if (budgetUnion(budget, cleanPaths).length <= budget.maxFilesChanged) return undefined
  return resourceLimitResponse(
    toolName,
    budget,
    cleanPaths,
    `Write would exceed maxFilesChanged (${budget.maxFilesChanged})`,
  )
}

function normalizedOptionalLimit(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined
  return Math.max(0, Math.floor(value))
}

function preflightWriteBytes(
  toolName: string,
  budget: AgentAppToolBudget | undefined,
  pages: Array<{ action: string; targetRelativePath: string; content?: string }>,
): AgentAppToolResourceLimitResponse | undefined {
  const maxWriteBytes = normalizedOptionalLimit(budget?.maxWriteBytes)
  if (maxWriteBytes === undefined) return undefined

  for (const page of pages) {
    if (page.action !== "write") continue
    const bytes = new TextEncoder().encode(page.content ?? "").length
    if (bytes <= maxWriteBytes) continue
    const message = `Write exceeds maxWriteBytes (${bytes} > ${maxWriteBytes})`
    return {
      ok: false,
      result: { ok: false, error: message },
      resourceLimit: {
        kind: "resource_limit",
        limitKind: "max_write_bytes",
        limit: maxWriteBytes,
        bytes,
        path: page.targetRelativePath,
        toolName,
        message,
        recovery: "settings_agent",
      },
    }
  }
  return undefined
}

function preflightUnknownWriteBudget(
  toolName: string,
  budget: AgentAppToolBudget | undefined,
): AgentAppToolResourceLimitResponse | undefined {
  if (!budget || budget.maxFilesChangedEnabled !== true) return undefined
  const changedPaths = uniqueStrings(budget.changedPaths)
  // Fan-out tools don't know how many files they'll write up front, so
  // a true path-enumerating preflight isn't possible — this is a "last
  // seat" guard: block once the run is already at/over the limit, so
  // a fan-out cannot START when there's no budget headroom left.
  // maxFilesChangedEnabled gates this guard too: when the file-count
  // budget is off, fan-out tools are allowed to start and finish without
  // a max_files_changed resource_limit.
  if (changedPaths.length < budget.maxFilesChanged) return undefined
  const message = `Write would exceed maxFilesChanged (${budget.maxFilesChanged})`
  return {
    ok: false,
    result: { ok: false, error: message },
    resourceLimit: {
      kind: "resource_limit",
      limitKind: "max_files_changed",
      limit: budget.maxFilesChanged,
      used: changedPaths.length,
      attempted: changedPaths.length + 1,
      changedPaths,
      path: "wiki",
      toolName,
      message,
      recovery: "split_task",
    },
  }
}

function postflightBudget(
  toolName: string,
  budget: AgentAppToolBudget | undefined,
  changedPaths: string[],
  wikiChanged: AgentWikiChangedPayload[],
): AgentAppToolResourceLimitResponse | undefined {
  if (!budget || budget.maxFilesChangedEnabled !== true) return undefined
  const actualPaths = uniqueStrings([...changedPaths, ...changedPathsFromWikiChanged(wikiChanged)])
  if (budgetUnion(budget, actualPaths).length <= budget.maxFilesChanged) return undefined
  return resourceLimitResponse(
    toolName,
    budget,
    actualPaths,
    `Write exceeded maxFilesChanged (${budget.maxFilesChanged})`,
    { changedPaths: actualPaths, wikiChanged },
  )
}

function currentProject() {
  const project = useWikiStore.getState().project
  if (!project) throw new Error("No active project")
  return project
}

function stringArg(args: ToolArgs, key: string): string {
  const value = args[key]
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Missing ${key}`)
  }
  return value
}

function sourceDirArg(args: ToolArgs): string {
  const sourceDir = stringArg(args, "sourceDir").trim()
  const normalized = normalizePath(sourceDir)
  if (sourceDir.includes("\0")) throw new Error("sourceDir must not contain NUL bytes")
  if (!isAbsolutePath(sourceDir)) throw new Error("sourceDir must be an absolute path")
  if (normalized.split("/").some((segment) => segment === "..")) {
    throw new Error("sourceDir must not contain path traversal")
  }
  return sourceDir
}

function optionalStringArg(args: ToolArgs, key: string): string | undefined {
  const value = args[key]
  if (value === undefined) return undefined
  if (typeof value !== "string") throw new Error(`${key} must be a string`)
  const clean = value.trim()
  return clean.length > 0 ? clean : undefined
}

function optionalStringArray(args: ToolArgs, key: string): string[] | undefined {
  const value = args[key]
  if (value === undefined) return undefined
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new Error(`${key} must be a string array`)
  }
  return value
}

function optionalNonEmptyStringArray(args: ToolArgs, key: string): string[] | undefined {
  const values = optionalStringArray(args, key)
  if (!values) return undefined
  const clean = values.map((item) => item.trim()).filter(Boolean)
  return clean.length > 0 ? clean : undefined
}

function taxonomyActionArg(args: ToolArgs): "bootstrap" | "growth" {
  const action = args.action
  if (action === "bootstrap" || action === "growth") return action
  throw new Error("action must be bootstrap or growth")
}

function optionalNumberArg(args: ToolArgs, key: string): number | undefined {
  const value = args[key]
  if (value === undefined) return undefined
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${key} must be a number`)
  return value
}

function optionalSynthesisDimension(args: ToolArgs): 1 | 2 | 3 | 4 | undefined {
  const dimension = optionalNumberArg(args, "dimension")
  if (dimension === undefined) return undefined
  if (dimension === 1 || dimension === 2 || dimension === 3 || dimension === 4) return dimension
  throw new Error("dimension must be 1, 2, 3, or 4")
}

function synthesisDiscoveryOptions(args: ToolArgs) {
  const options: {
    dimension?: 1 | 2 | 3 | 4
    targetTag?: string
    targetTags?: string[]
    minClusterSize?: number
    maxCandidates?: number
  } = {}
  const dimension = optionalSynthesisDimension(args)
  const targetTag = optionalStringArg(args, "targetTag")
  const targetTags = optionalNonEmptyStringArray(args, "targetTags")
  const minClusterSize = optionalNumberArg(args, "minClusterSize")
  const maxCandidates = optionalNumberArg(args, "maxCandidates")
  if (dimension !== undefined) options.dimension = dimension
  if (targetTag !== undefined) options.targetTag = targetTag
  if (targetTags !== undefined) options.targetTags = targetTags
  if (minClusterSize !== undefined) options.minClusterSize = minClusterSize
  if (maxCandidates !== undefined) options.maxCandidates = maxCandidates
  return options
}

function searchQueriesArg(args: ToolArgs): string[] {
  const queries = optionalNonEmptyStringArray(args, "searchQueries")
    ?? optionalNonEmptyStringArray(args, "queries")
  if (queries) return queries
  const topic = optionalStringArg(args, "topic")
  if (topic) return [topic]
  throw new Error("Provide topic or at least one searchQueries/queries item")
}

function researchRequestArg(args: ToolArgs): { topic: string; searchQueries?: string[] } {
  const topic = optionalStringArg(args, "topic")
  const searchQueries = optionalNonEmptyStringArray(args, "searchQueries")
    ?? optionalNonEmptyStringArray(args, "queries")
  if (!topic && !searchQueries) {
    throw new Error("Provide topic or at least one searchQueries/queries item")
  }
  return {
    topic: topic ?? searchQueries![0],
    searchQueries,
  }
}

function searchConfigWithSourceMode(
  searchConfig: SearchApiConfig,
  sourceMode: unknown,
): SearchApiConfig {
  if (sourceMode === undefined) return searchConfig
  if (sourceMode !== "web" && sourceMode !== "anytxt" && sourceMode !== "both") {
    throw new Error("sourceMode must be web, anytxt, or both")
  }
  return { ...searchConfig, deepResearchSource: sourceMode }
}

function redactConfiguredSecrets(text: string, state: ReturnType<typeof useWikiStore.getState>): string {
  const secrets = [
    state.llmConfig.apiKey,
    state.searchApiConfig.apiKey,
    state.mineruConfig.token,
    ...Object.values(state.searchApiConfig.providerConfigs ?? {}).map((config) => config?.apiKey ?? ""),
  ].filter((secret) => secret.length >= 6)

  let redacted = text
  for (const secret of secrets) {
    redacted = redacted.split(secret).join("REDACTED")
  }
  return redacted
}

function redactErrors(errors: string[], state: ReturnType<typeof useWikiStore.getState>): string[] {
  return errors.map((error) => redactConfiguredSecrets(error, state))
}

function normalizePagePath(projectPath: string, input: string): string {
  const pp = normalizePath(projectPath)
  const path = normalizePath(input)
  if (path.startsWith(`${pp}/`)) return path
  if (path.startsWith("wiki/")) return `${pp}/${path}`
  return `${pp}/wiki/${path}`
}

async function normalizeSourcePath(projectPath: string, input: string): Promise<string> {
  const pp = normalizePath(projectPath).replace(/\/+$/, "")
  const rawSourcesRoot = `${pp}/raw/sources/`
  const rawSourcesPrefix = "raw/sources/"
  const sourcesPrefix = "sources/"
  let path: string
  try {
    path = normalizePath(decodeURIComponent(input.trim()))
  } catch {
    throw new Error("sourcePath has invalid URI encoding")
  }

  const assertSafeRelativeSource = (relPath: string): string => {
    const segments = relPath.split("/")
    if (
      relPath.length === 0 ||
      segments.some((segment) => segment === ".." || segment === "." || segment === "")
    ) {
      throw new Error("sourcePath must not contain traversal segments")
    }
    return relPath
  }

  let candidate: string
  if (path.startsWith(rawSourcesRoot)) {
    assertSafeRelativeSource(path.slice(rawSourcesRoot.length))
    candidate = path
  } else if (path.startsWith(`${pp}/`) || isAbsolutePath(path)) {
    throw new Error("sourcePath must be inside the active project")
  } else if (path.startsWith(rawSourcesPrefix)) {
    assertSafeRelativeSource(path.slice(rawSourcesPrefix.length))
    candidate = `${pp}/${path}`
  } else if (path.startsWith(sourcesPrefix)) {
    const relPath = assertSafeRelativeSource(path.slice(sourcesPrefix.length))
    candidate = `${rawSourcesRoot}${relPath}`
  } else {
    candidate = `${rawSourcesRoot}${assertSafeRelativeSource(path)}`
  }

  const canonicalRoot = normalizePath(await canonicalizePath(`${pp}/raw/sources`)).replace(/\/+$/, "")
  const canonicalCandidate = normalizePath(await canonicalizePath(candidate))
  if (canonicalCandidate !== canonicalRoot && !canonicalCandidate.startsWith(`${canonicalRoot}/`)) {
    throw new Error("sourcePath must resolve inside raw/sources")
  }
  return canonicalCandidate
}

function wikiChangedFromPaths(paths: string[]): AgentWikiChangedPayload[] {
  return paths
    .filter((path) => path.startsWith("wiki/"))
    .map((path) => ({ path, operation: "update" as const }))
}

function lintResultArg(args: ToolArgs): LintResult {
  const value = args.result
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("result must be a lint result object")
  }
  const result = value as Partial<LintResult>
  if (
    !["orphan", "broken-link", "no-outlinks", "source-unlinked", "semantic"].includes(String(result.type)) ||
    !["warning", "info"].includes(String(result.severity)) ||
    typeof result.page !== "string" ||
    typeof result.detail !== "string"
  ) {
    throw new Error("Invalid lint result")
  }
  return {
    type: result.type as LintResult["type"],
    severity: result.severity as LintResult["severity"],
    page: result.page,
    detail: result.detail,
    affectedPages: Array.isArray(result.affectedPages)
      ? result.affectedPages.filter((item): item is string => typeof item === "string")
      : undefined,
  }
}

function duplicateGroupArg(args: ToolArgs): DuplicateGroup {
  const rawGroup = args.group
  const source = rawGroup && typeof rawGroup === "object" && !Array.isArray(rawGroup)
    ? rawGroup as Record<string, unknown>
    : args
  const slugs = Array.isArray(source.slugs)
    ? source.slugs.map((slug) => typeof slug === "string" ? slug.trim() : "").filter(Boolean)
    : []
  if (slugs.length < 2) throw new Error("merge_duplicate_group requires at least two slugs")
  const confidence = source.confidence === "high" || source.confidence === "medium" || source.confidence === "low"
    ? source.confidence
    : "low"
  return {
    slugs,
    reason: typeof source.reason === "string" ? source.reason : "",
    confidence,
  }
}

async function previewDuplicateMerge(
  projectPath: string,
  group: DuplicateGroup,
  canonicalSlug: string,
  llmConfig: ReturnType<typeof useWikiStore.getState>["llmConfig"],
): Promise<MergeResult> {
  const pp = normalizePath(projectPath)
  const allPages = await loadAllWikiPages(pp)
  const pathBySlug = new Map<string, string>()
  for (const page of allPages) {
    const base = page.path.split("/").pop() ?? ""
    if (base.endsWith(".md")) pathBySlug.set(base.slice(0, -3), page.path)
  }
  const groupPages = group.slugs.map((slug) => {
    const relPath = pathBySlug.get(slug)
    if (!relPath) throw new Error(`Slug "${slug}" not found on disk`)
    const page = allPages.find((item) => item.path === relPath)
    if (!page) throw new Error(`Internal: page lookup miss for ${relPath}`)
    return { slug, path: relPath, content: page.content }
  })
  const groupPaths = new Set(groupPages.map((page) => page.path))
  const otherWikiPages = allPages.filter((page) => !groupPaths.has(page.path))
  return mergeDuplicateGroup(
    { group: groupPages, canonicalSlug, otherWikiPages },
    buildDedupLlmCall(llmConfig),
  )
}

function summarizeMergeResult(result: MergeResult, dryRun: boolean): Record<string, unknown> {
  return {
    dryRun,
    canonicalPath: result.canonicalPath,
    canonicalBytes: new TextEncoder().encode(result.canonicalContent).length,
    canonicalPreview: result.canonicalContent.slice(0, 2000),
    rewrites: result.rewrites.map((rewrite) => ({
      path: rewrite.path,
      bytes: new TextEncoder().encode(rewrite.newContent).length,
    })),
    pagesToDelete: result.pagesToDelete,
    backupPaths: result.backup.map((item) => item.path),
  }
}

function mergeWikiChanged(result: MergeResult): AgentWikiChangedPayload[] {
  const updates = [
    result.canonicalPath,
    ...result.rewrites.map((rewrite) => rewrite.path),
  ]
  const uniqueUpdates = [...new Set(updates.filter((path) => path.startsWith("wiki/")))]
  return [
    ...uniqueUpdates.map((path) => ({ path, operation: "update" as const })),
    ...result.pagesToDelete.map((path) => ({ path, operation: "delete" as const })),
  ]
}

/**
 * Runs app-level Agent tools inside the WebView, where existing LLM Wiki
 * business services and Tauri commands are available.
 */
export async function runAgentAppTool(
  toolName: string,
  args: ToolArgs,
  options: AgentAppToolRunOptions = {},
): Promise<AgentAppToolResponse> {
  const project = currentProject()
  const state = useWikiStore.getState()
  const projectPath = project.path
  const budget = options.budget
  const descriptor = AGENT_APP_TOOL_DESCRIPTORS[toolName]

  if (!descriptor) throw new Error(`Unknown app tool: ${toolName}`)
  return descriptor.handler({ toolName, args, options, project, state, projectPath, budget })
}

async function handleBuildAnswerContext(toolContext: AgentAppToolContext): Promise<AgentAppToolResponse> {
  const { args, project, state } = toolContext

    const maxContextSize =
      typeof args.maxContextSize === "number" ? args.maxContextSize : state.llmConfig.maxContextSize
    const context = await buildWikiAnswerContext({
      project,
      query: stringArg(args, "query"),
      maxContextSize,
      dataVersion: state.dataVersion,
    })
    return { ok: true, result: context }
}

async function handleSaveQueryPage(toolContext: AgentAppToolContext): Promise<AgentAppToolResponse> {
  const { args, state, projectPath } = toolContext

    const result = await saveQueryPage({
      projectPath,
      content: stringArg(args, "content"),
      title: typeof args.title === "string" ? args.title : undefined,
      tags: optionalStringArray(args, "tags"),
      autoIngest: args.autoIngest === true,
      llmConfig: state.llmConfig,
    })
    state.setFileTree(result.fileTree)
    useWikiStore.getState().bumpDataVersion()
    return {
      ok: true,
      result: {
        path: result.path,
        relativePath: result.relativePath,
        title: result.title,
        fileName: result.fileName,
        date: result.date,
        autoIngestStarted: result.autoIngestStarted,
      },
      wikiChanged: [{ path: result.relativePath, operation: "create" }],
    }
}

async function handleRunLint(toolContext: AgentAppToolContext): Promise<AgentAppToolResponse> {
  const { args, state, projectPath } = toolContext

    const includeStructural = args.includeStructural !== false
    const includeSemantic = args.includeSemantic === true
    const structural = includeStructural ? await runStructuralLint(projectPath) : []
    const semantic =
      includeSemantic && hasUsableLlm(state.llmConfig)
        ? await runSemanticLint(projectPath, state.llmConfig)
        : []
    return {
      ok: true,
      result: {
        results: [...structural, ...semantic],
        structuralCount: structural.length,
        semanticCount: semantic.length,
        semanticSkipped: includeSemantic && !hasUsableLlm(state.llmConfig),
      },
    }
}

async function handleCollectResearchSources(toolContext: AgentAppToolContext): Promise<AgentAppToolResponse> {
  const { args, state, projectPath } = toolContext

    const queries = searchQueriesArg(args)
    const searchConfig = searchConfigWithSourceMode(state.searchApiConfig, args.sourceMode)
    const resolved = resolveSearchConfig(searchConfig)
    if (!hasConfiguredDeepResearchSources(searchConfig)) {
      return {
        ok: true,
        result: {
          queries,
          sourceMode: resolved.deepResearchSource ?? "web",
          results: [],
          errors: ["Deep research source is not configured"],
        },
      }
    }
    const collected = await collectResearchSources(
      queries,
      searchConfig,
      projectPath,
      undefined,
      { llmConfig: state.llmConfig },
    )
    return {
      ok: true,
      result: {
        queries,
        sourceMode: resolved.deepResearchSource ?? "web",
        results: collected.results,
        errors: redactErrors(collected.errors, state),
      },
    }
}

async function handleRunDeepResearch(toolContext: AgentAppToolContext): Promise<AgentAppToolResponse> {
  const { args, state, projectPath } = toolContext

    const { topic, searchQueries } = researchRequestArg(args)
    const searchConfig = searchConfigWithSourceMode(state.searchApiConfig, args.sourceMode)
    if (!hasConfiguredDeepResearchSources(searchConfig)) {
      return {
        ok: true,
        result: {
          taskId: null,
          status: "error",
          error: "Deep research source is not configured",
        },
      }
    }
    const taskId = queueResearch(
      normalizePath(projectPath),
      topic,
      state.llmConfig,
      searchConfig,
      searchQueries,
    )
    return {
      ok: true,
      result: {
        taskId,
        status: "queued",
        topic,
        searchQueries,
        sourceMode: resolveSearchConfig(searchConfig).deepResearchSource ?? "web",
      },
    }
}

async function handleGetAgentTaskStatus(toolContext: AgentAppToolContext): Promise<AgentAppToolResponse> {
  const { args, state } = toolContext

    const taskId = stringArg(args, "taskId")
    const task = useResearchStore.getState().tasks.find((item) => item.id === taskId)
    if (!task) {
      return {
        ok: true,
        result: {
          taskId,
          status: "missing",
          error: "Agent task not found",
        },
      }
    }
    return {
      ok: true,
      result: {
        taskId: task.id,
        topic: task.topic,
        status: task.status,
        searchQueries: task.searchQueries,
        sourceCount: task.webResults.length,
        synthesis: task.synthesis,
          savedPath: task.savedPath,
        error: task.error ? redactConfiguredSecrets(task.error, state) : null,
        createdAt: task.createdAt,
      },
    }
}

async function handleDetectDuplicates(toolContext: AgentAppToolContext): Promise<AgentAppToolResponse> {
  const { args, state, projectPath } = toolContext

    const limit = typeof args.limit === "number" ? Math.max(1, Math.min(50, Math.floor(args.limit))) : 20
    const groups = await runDuplicateDetection(projectPath, state.llmConfig)
    return {
      ok: true,
      result: {
        groups: groups.slice(0, limit),
        totalGroups: groups.length,
      },
    }
}

async function handleMergeDuplicateGroup(toolContext: AgentAppToolContext): Promise<AgentAppToolResponse> {
  const { toolName, args, state, projectPath, budget } = toolContext

    const group = duplicateGroupArg(args)
    const canonicalSlug = stringArg(args, "canonicalSlug")
    const dryRun = args.dryRun !== false
    if (!dryRun && budget) {
      const preview = await previewDuplicateMerge(projectPath, group, canonicalSlug, state.llmConfig)
      const plannedChanges = mergeWikiChanged(preview)
      const blocked = preflightBudget(toolName, budget, changedPathsFromWikiChanged(plannedChanges))
      if (blocked) return blocked
    }
    const result = dryRun
      ? await previewDuplicateMerge(projectPath, group, canonicalSlug, state.llmConfig)
      : await executeMerge(projectPath, group, canonicalSlug, state.llmConfig)
    if (!dryRun) {
      state.setFileTree(await listDirectory(projectPath))
      useWikiStore.getState().bumpDataVersion()
    }
    return {
      ok: true,
      result: summarizeMergeResult(result, dryRun),
      wikiChanged: dryRun ? [] : mergeWikiChanged(result),
    }
}

async function handleOptimizeResearchTopic(toolContext: AgentAppToolContext): Promise<AgentAppToolResponse> {
  const { args, state, projectPath } = toolContext

    const pp = normalizePath(projectPath)
    const overview = typeof args.overview === "string"
      ? args.overview
      : await readFile(`${pp}/wiki/overview.md`).catch(() => "")
    const purpose = typeof args.purpose === "string"
      ? args.purpose
      : await readFile(`${pp}/purpose.md`).catch(() => "")
    const result = await optimizeResearchTopic(
      state.llmConfig,
      stringArg(args, "gapTitle"),
      typeof args.gapDescription === "string" ? args.gapDescription : "",
      typeof args.gapType === "string" ? args.gapType : "suggestion",
      overview,
      purpose,
    )
    return { ok: true, result }
}

async function handleSweepReviews(toolContext: AgentAppToolContext): Promise<AgentAppToolResponse> {
  const { projectPath } = toolContext

    const before = useReviewStore.getState().items
    const pendingBefore = before.filter((item) => !item.resolved).length
    const resolvedCount = await sweepResolvedReviews(projectPath)
    const after = useReviewStore.getState().items
    return {
      ok: true,
      result: {
        resolvedCount,
        pendingBefore,
        pendingAfter: after.filter((item) => !item.resolved).length,
        totalReviews: after.length,
      },
    }
}

async function handleTestProviderConnection(toolContext: AgentAppToolContext): Promise<AgentAppToolResponse> {
  const { state } = toolContext

    const result = await testLlmConnection(state.llmConfig)
    return {
      ok: true,
      result: {
        ok: result.ok,
        message: redactConfiguredSecrets(result.message, state),
      },
    }
}

async function handleIngestSource(toolContext: AgentAppToolContext): Promise<AgentAppToolResponse> {
  const { toolName, args, state, projectPath, budget } = toolContext

    const blocked = preflightUnknownWriteBudget(toolName, budget)
    if (blocked) return blocked
    const sourcePath = await normalizeSourcePath(projectPath, stringArg(args, "sourcePath"))
    const folderContext = typeof args.folderContext === "string" ? args.folderContext : undefined
    const writtenPaths = await autoIngest(projectPath, sourcePath, state.llmConfig, undefined, folderContext)
    // Run property autofill after ingest completes
    const autofillResult = await runAutofill(projectPath)
    state.setFileTree(await listDirectory(projectPath))
    useWikiStore.getState().bumpDataVersion()
    const wikiChanged = wikiChangedFromPaths([
      ...writtenPaths,
      ...autofillResult.details.map((detail) => detail.relativePath),
    ])
    const overBudget = postflightBudget(toolName, budget, [], wikiChanged)
    if (overBudget) return overBudget
    return {
      ok: true,
      result: {
        sourcePath,
        writtenPaths,
        filesWritten: writtenPaths.length,
        autofill: autofillResult,
      },
      wikiChanged,
    }
}

async function handleCaptionSourceImages(toolContext: AgentAppToolContext): Promise<AgentAppToolResponse> {
  const { toolName, args, state, projectPath, budget } = toolContext

    const blocked = preflightUnknownWriteBudget(toolName, budget)
    if (blocked) return blocked
    const sourcePath = await normalizeSourcePath(projectPath, stringArg(args, "sourcePath"))
    const result = await captionSourceImages(
      projectPath,
      sourcePath,
      state.llmConfig,
      undefined,
      args.forceRecaption === true,
    )
    state.setFileTree(await listDirectory(projectPath))
    useWikiStore.getState().bumpDataVersion()
    const wikiChanged = result.sourceSummaryUpdated
      ? [{ path: result.sourceSummaryPath, operation: "update" as const }]
      : []
    const overBudget = postflightBudget(toolName, budget, [], wikiChanged)
    if (overBudget) return overBudget
    return {
      ok: true,
      result,
      wikiChanged,
    }
}

async function handleFixLintResult(toolContext: AgentAppToolContext): Promise<AgentAppToolResponse> {
  const { toolName, args, state, projectPath, budget } = toolContext

    const result = lintResultArg(args)
    const changedPath = wikiPathForPage(result.page)
    const blocked = preflightBudget(toolName, budget, [changedPath])
    if (blocked) return blocked
    const ok = await fixLintResult(projectPath, result, state.llmConfig)
    if (ok) {
      state.setFileTree(await listDirectory(projectPath))
      useWikiStore.getState().bumpDataVersion()
    }
    return {
      ok: true,
      result: { fixed: ok, result },
      wikiChanged: ok ? [{ path: changedPath, operation: "update" }] : [],
    }
}

async function handleRunLintAndReport(toolContext: AgentAppToolContext): Promise<AgentAppToolResponse> {
  const { toolName, args, state, projectPath, budget } = toolContext

    const blocked = preflightUnknownWriteBudget(toolName, budget)
    if (blocked) return blocked
    const fileTree = state.fileTree
    const includeStructural = args.includeStructural !== false
    const includeSemantic = args.includeSemantic === true
    const autoFix = args.autoFix === true
    const { report, reportPath, changedPaths } = await runLintAndReport(projectPath, state.llmConfig, fileTree, includeStructural, includeSemantic, autoFix)
    state.setFileTree(await listDirectory(projectPath))
    useWikiStore.getState().bumpDataVersion()
    const wikiChanged = changedPaths.map((path) => ({
      path,
      operation: path === reportPath ? "create" as const : "update" as const,
    }))
    const overBudget = postflightBudget(toolName, budget, [], wikiChanged)
    if (overBudget) return overBudget
    return {
      ok: true,
      result: { report, reportPath },
      wikiChanged,
    }
}

async function handleFixLintReport(toolContext: AgentAppToolContext): Promise<AgentAppToolResponse> {
  const { toolName, args, state, projectPath, budget } = toolContext

    const release = await lintFixMutex.acquire()
    try {
      const report = args.report as LintReport
      const reportPath = stringArg(args, "reportPath")
      const plannedPaths = uniqueStrings([
        reportPath,
        ...(report.autoFixItems ?? []).map((item) => wikiPathForPage(item.page)),
      ])
      const blocked = preflightBudget(toolName, budget, plannedPaths)
      if (blocked) return blocked
      const { report: updatedReport, reportPath: updatedPath } = await fixLintReport(
        projectPath,
        report,
        reportPath,
        state.llmConfig,
      )
      state.setFileTree(await listDirectory(projectPath))
      useWikiStore.getState().bumpDataVersion()
      return {
        ok: true,
        result: { report: updatedReport, reportPath: updatedPath },
        wikiChanged: plannedPaths.map((path) => ({ path, operation: "update" as const })),
      }
    } finally {
      release()
    }
}

async function handleEnrichWikilinks(toolContext: AgentAppToolContext): Promise<AgentAppToolResponse> {
  const { toolName, args, state, projectPath, budget } = toolContext

    const filePath = normalizePagePath(projectPath, stringArg(args, "path"))
    const relativePath = filePath.replace(`${normalizePath(projectPath)}/`, "")
    const blocked = preflightBudget(toolName, budget, [relativePath])
    if (blocked) return blocked
    await enrichWithWikilinks(projectPath, filePath, state.llmConfig)
    state.setFileTree(await listDirectory(projectPath))
    return {
      ok: true,
      result: { path: relativePath },
      wikiChanged: [{ path: relativePath, operation: "update" }],
    }
}

async function handleAutofillProperties(toolContext: AgentAppToolContext): Promise<AgentAppToolResponse> {
  const { toolName, args, state, projectPath, budget } = toolContext

    const taxonomyAware = args.taxonomyAware === true
    const autoWriteHighConfidence = args.autoWriteHighConfidence === true
    const previewOptions = taxonomyAware
      ? { dryRun: true, taxonomyAware, autoWriteHighConfidence }
      : { dryRun: true }
    const preview = await runAutofill(projectPath, previewOptions)
    const plannedPaths = taxonomyAware && !autoWriteHighConfidence
      ? []
      : uniqueStrings(preview.details.map((detail) => detail.relativePath))
    const blocked = preflightBudget(toolName, budget, plannedPaths)
    if (blocked) return blocked
    const result = taxonomyAware
      ? await runAutofill(projectPath, {
          dryRun: !autoWriteHighConfidence,
          taxonomyAware,
          autoWriteHighConfidence,
        })
      : await runAutofill(projectPath)
    state.setFileTree(await listDirectory(projectPath))
    useWikiStore.getState().bumpDataVersion()
    const wikiChanged = taxonomyAware && !autoWriteHighConfidence
      ? []
      : wikiChangedFromPaths(result.details.map((detail) => detail.relativePath))
    return {
      ok: true,
      result,
      wikiChanged,
    }
}

async function handleOkfValidate(toolContext: AgentAppToolContext): Promise<AgentAppToolResponse> {
  const { projectPath } = toolContext

    return { ok: true, result: await validateOkfBundle(projectPath) }
}

async function handleOkfExport(toolContext: AgentAppToolContext): Promise<AgentAppToolResponse> {
  const { projectPath } = toolContext

    return { ok: true, result: await buildOkfExportBundle(projectPath) }
}

async function handleOkfImport(toolContext: AgentAppToolContext): Promise<AgentAppToolResponse> {
  const { toolName, args, state, projectPath, budget } = toolContext

    const sourceDir = sourceDirArg(args)
    const apply = args.apply === true
    const preview = await previewOkfImport(sourceDir, projectPath)
    if (!apply) return { ok: true, result: preview, wikiChanged: [] }

    const plannedPaths = preview.pages
      .filter((page) => page.action === "write")
      .map((page) => page.targetRelativePath)
    const blocked = preflightBudget(toolName, budget, plannedPaths)
    if (blocked) return blocked
    const bytesBlocked = preflightWriteBytes(toolName, budget, preview.pages)
    if (bytesBlocked) return bytesBlocked

    const result = await importOkfBundle(sourceDir, projectPath, { apply: true })
    state.setFileTree(await listDirectory(projectPath))
    useWikiStore.getState().bumpDataVersion()
    const writtenPaths = result.pages
      .filter((page) => page.action === "write")
      .map((page) => page.targetRelativePath)
    return {
      ok: true,
      result,
      wikiChanged: writtenPaths.map((path) => ({ path, operation: "create" as const })),
    }
}

async function handleTaxonomyPreview(toolContext: AgentAppToolContext): Promise<AgentAppToolResponse> {
  const { args, projectPath } = toolContext

    const action = taxonomyActionArg(args)
    const result = action === "bootstrap"
      ? await previewTagTaxonomyBootstrap(projectPath)
      : await previewTagTaxonomyGrowth(projectPath)
    return { ok: true, result }
}

async function handleTaxonomyApply(toolContext: AgentAppToolContext): Promise<AgentAppToolResponse> {
  const { toolName, args, state, projectPath, budget } = toolContext

    const sidecarPath = ".llm-wiki/tag-taxonomy.json"
    const blocked = preflightBudget(toolName, budget, [sidecarPath])
    if (blocked) return blocked
    const action = taxonomyActionArg(args)
    const result = action === "bootstrap"
      ? await applyTagTaxonomyBootstrap(projectPath)
      : await applyTagTaxonomyGrowth(projectPath)
    if (result.wrote) {
      state.setFileTree(await listDirectory(projectPath))
      useWikiStore.getState().bumpDataVersion()
    }
    return {
      ok: true,
      result,
      changedPaths: result.wrote ? [sidecarPath] : [],
    }
}

async function handleTaxonomyRollback(toolContext: AgentAppToolContext): Promise<AgentAppToolResponse> {
  const { toolName, state, projectPath, budget } = toolContext

    const sidecarPath = ".llm-wiki/tag-taxonomy.json"
    const blocked = preflightBudget(toolName, budget, [sidecarPath])
    if (blocked) return blocked
    const result = await rollbackLastTagTaxonomyBatch(projectPath)
    if (result.wrote) {
      state.setFileTree(await listDirectory(projectPath))
      useWikiStore.getState().bumpDataVersion()
    }
    return {
      ok: true,
      result,
      changedPaths: result.wrote && result.removed > 0 ? [sidecarPath] : [],
    }
}

async function handleSynthesisPreview(toolContext: AgentAppToolContext): Promise<AgentAppToolResponse> {
  const { args, projectPath } = toolContext

    return {
      ok: true,
      result: await discoverSynthesisCandidates(projectPath, synthesisDiscoveryOptions(args)),
    }
}

async function handleGetKnowledgeAgentsConfig(toolContext: AgentAppToolContext): Promise<AgentAppToolResponse> {
  const { projectPath } = toolContext

    const loaded = await loadKnowledgeAgentsConfig(projectPath)
    return {
      ok: true,
      result: {
        ...loaded,
        optIn: true,
        agents: Object.fromEntries(
          Object.entries(loaded.config.agents).map(([id, settings]) => [
            id,
            {
              enabled: settings.enabled,
              status: settings.enabled ? "enabled" : "opt-in-disabled",
            },
          ]),
        ),
      },
    }
}

async function handleRunPipeline(toolContext: AgentAppToolContext): Promise<AgentAppToolResponse> {
  const { args, state, projectPath, budget } = toolContext

    const pipelineName = stringArg(args, "pipeline")
    const schema = BUILTIN_PIPELINES[pipelineName]
    if (!schema) throw new Error(`Unknown pipeline: ${pipelineName}. Available: ${Object.keys(BUILTIN_PIPELINES).join(", ")}`)
    const pipelineBudget = budget
      ? {
          maxFilesChanged: budget.maxFilesChanged,
          maxWriteBytes: budget.maxWriteBytes,
          changedPaths: [...budget.changedPaths],
          maxFilesChangedEnabled: budget.maxFilesChangedEnabled,
        }
      : undefined
    const result = await executePipeline(schema, async (stepToolName, stepArgs) => {
      const response = pipelineBudget
        ? await runAgentAppTool(stepToolName, stepArgs, { budget: pipelineBudget })
        : await runAgentAppTool(stepToolName, stepArgs)
      const actualPaths = uniqueStrings([
        ...(response.changedPaths ?? []),
        ...changedPathsFromWikiChanged(response.wikiChanged ?? []),
      ])
      if (pipelineBudget) {
        pipelineBudget.changedPaths = budgetUnion(pipelineBudget, actualPaths)
      }
      return response
    })
    state.setFileTree(await listDirectory(projectPath))
    useWikiStore.getState().bumpDataVersion()
    if (result.resourceLimit) {
      return {
        ok: false,
        result: { ok: false, error: result.resourceLimit.message },
        changedPaths: result.changedPaths,
        wikiChanged: result.wikiChanged,
        resourceLimit: result.resourceLimit,
      }
    }
    return {
      ok: true as const,
      result,
      changedPaths: result.changedPaths,
      wikiChanged: result.wikiChanged ?? [],
    }
}

async function handleWikiSynthesis(toolContext: AgentAppToolContext): Promise<AgentAppToolResponse> {
  const { toolName, args, state, projectPath, budget } = toolContext

    const blocked = preflightUnknownWriteBudget(toolName, budget)
    if (blocked) return blocked
    const targetTag = typeof args.targetTag === "string" ? args.targetTag : undefined
    const targetTags = Array.isArray(args.targetTags)
      ? args.targetTags.filter((tag): tag is string => typeof tag === "string")
      : undefined
    const dimension = typeof args.dimension === "number" ? args.dimension : undefined
    const minClusterSize = typeof args.minClusterSize === "number" ? args.minClusterSize : undefined
    const maxCandidates = typeof args.maxCandidates === "number" ? args.maxCandidates : undefined
    const result = await runWikiSynthesis(projectPath, state.llmConfig, state.searchApiConfig, {
      dimension: dimension === 1 || dimension === 2 || dimension === 3 || dimension === 4 ? dimension : undefined,
      targetTag,
      targetTags,
      minClusterSize,
      maxCandidates,
    })
    if (!result.ok) throw new Error(result.error)
    state.setFileTree(await listDirectory(projectPath))
    useWikiStore.getState().bumpDataVersion()
    const wikiChanged = result.synthesisPath ? [{ path: result.synthesisPath, operation: "create" as const }] : []
    const overBudget = postflightBudget(toolName, budget, [], wikiChanged)
    if (overBudget) return overBudget
    return {
      ok: true,
      result,
      wikiChanged,
    }
}

const AGENT_APP_TOOL_HANDLERS: Record<string, AgentAppToolHandler> = {
  build_answer_context: handleBuildAnswerContext,
  save_query_page: handleSaveQueryPage,
  run_lint: handleRunLint,
  collect_research_sources: handleCollectResearchSources,
  run_deep_research: handleRunDeepResearch,
  get_agent_task_status: handleGetAgentTaskStatus,
  detect_duplicates: handleDetectDuplicates,
  merge_duplicate_group: handleMergeDuplicateGroup,
  optimize_research_topic: handleOptimizeResearchTopic,
  sweep_reviews: handleSweepReviews,
  test_provider_connection: handleTestProviderConnection,
  ingest_source: handleIngestSource,
  caption_source_images: handleCaptionSourceImages,
  fix_lint_result: handleFixLintResult,
  run_lint_and_report: handleRunLintAndReport,
  fix_lint_report: handleFixLintReport,
  enrich_wikilinks: handleEnrichWikilinks,
  autofill_properties: handleAutofillProperties,
  okf_validate: handleOkfValidate,
  okf_export: handleOkfExport,
  okf_import: handleOkfImport,
  taxonomy_preview: handleTaxonomyPreview,
  taxonomy_apply: handleTaxonomyApply,
  taxonomy_rollback: handleTaxonomyRollback,
  synthesis_preview: handleSynthesisPreview,
  get_knowledge_agents_config: handleGetKnowledgeAgentsConfig,
  run_pipeline: handleRunPipeline,
  wiki_synthesis: handleWikiSynthesis,
}

export const AGENT_APP_TOOL_DESCRIPTORS: Record<string, AgentAppToolDescriptor> = Object.fromEntries(
  Object.entries(AGENT_APP_TOOL_HANDLERS).map(([name, handler]) => [name, {
    name,
    handler,
    ...(name === "get_knowledge_agents_config"
      ? { description: "Read Knowledge Agents config, issues, and conflict status. enabled:false is the designed opt-in default, not a fault." }
      : {}),
  }]),
) as Record<string, AgentAppToolDescriptor>
