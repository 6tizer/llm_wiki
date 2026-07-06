import { beforeEach, describe, expect, it, vi } from "vitest"
import type { FileNode } from "@/types/wiki"
import { useWikiStore } from "@/stores/wiki-store"
import { useResearchStore } from "@/stores/research-store"
import { useReviewStore } from "@/stores/review-store"
import { AGENT_APP_TOOL_DESCRIPTORS, runAgentAppTool } from "./agent-app-tools"
import type { AutofillResult } from "./agent-autofill"

const fsMock = vi.hoisted(() => ({
  tree: [] as FileNode[],
  canonical: new Map<string, string>(),
  files: new Map<string, string>(),
}))

const ingestMock = vi.hoisted(() => ({
  autoIngest: vi.fn(),
  captionSourceImages: vi.fn(),
}))

const saveQueryPageMock = vi.hoisted(() => ({
  saveQueryPage: vi.fn(),
}))

const lintFixerMock = vi.hoisted(() => ({
  fixLintResult: vi.fn(),
  fixLintReport: vi.fn(),
  runLintAndReport: vi.fn(),
}))

const enrichMock = vi.hoisted(() => ({
  enrichWithWikilinks: vi.fn(),
}))

const deepResearchMock = vi.hoisted(() => ({
  collectResearchSources: vi.fn(),
  queueResearch: vi.fn(),
  rewriteAnyTxtQueries: vi.fn(),
}))

const dedupRunnerMock = vi.hoisted(() => ({
  buildDedupLlmCall: vi.fn(),
  executeMerge: vi.fn(),
  loadAllWikiPages: vi.fn(),
  runDuplicateDetection: vi.fn(),
}))

const dedupMock = vi.hoisted(() => ({
  mergeDuplicateGroup: vi.fn(),
}))

const optimizeResearchTopicMock = vi.hoisted(() => ({
  optimizeResearchTopic: vi.fn(),
}))

const sweepReviewsMock = vi.hoisted(() => ({
  sweepResolvedReviews: vi.fn(),
}))

const connectionTestsMock = vi.hoisted(() => ({
  testLlmConnection: vi.fn(),
}))

const autofillMock = vi.hoisted(() => ({
  runAutofill: vi.fn(async (_projectPath?: string, _options?: { dryRun?: boolean; taxonomyAware?: boolean; autoWriteHighConfidence?: boolean }) => ({
    pagesScanned: 0,
    statusPromoted: 0,
    tagsAssigned: 0,
    details: [] as Array<{ path: string; relativePath: string; action: "status" | "tags"; from: string; to: string }>,
  } as AutofillResult)),
}))

const wikiSynthesisMock = vi.hoisted(() => ({
  discoverSynthesisCandidates: vi.fn(async (): Promise<Record<string, unknown>> => ({
    dimension: 1,
    minClusterSize: 3,
    candidates: [] as Array<Record<string, unknown>>,
    totalCandidates: 0,
  })),
  runWikiSynthesis: vi.fn(async () => ({
    ok: true,
    topic: "test",
    clusterSize: 3,
    synthesisPath: "wiki/synthesis/test-synthesis.md",
    externalSources: 0,
  } as Awaited<ReturnType<typeof import("@/lib/wiki-synthesis").runWikiSynthesis>>)),
}))

const okfValidateMock = vi.hoisted(() => ({
  validateOkfBundle: vi.fn(async (): Promise<Record<string, unknown>> => ({ ok: true, issues: [] as Array<Record<string, unknown>>, summary: { totalPages: 0 } })),
}))

const okfExportMock = vi.hoisted(() => ({
  buildOkfExportBundle: vi.fn(async (): Promise<Record<string, unknown>> => ({ files: [] as Array<Record<string, unknown>>, report: { issues: [] as Array<Record<string, unknown>> } })),
}))

const okfImportMock = vi.hoisted(() => ({
  previewOkfImport: vi.fn(async () => ({
    applied: false,
    pages: [] as Array<{ targetRelativePath: string; action: "write" | "skip"; content?: string }>,
    issues: [] as Array<Record<string, unknown>>,
    summary: { totalPages: 0, writeCount: 0, skippedCount: 0, issueCount: 0 },
  })),
  importOkfBundle: vi.fn(async () => ({
    applied: true,
    pages: [] as Array<{ targetRelativePath: string; action: "write" | "skip"; content?: string }>,
    issues: [] as Array<Record<string, unknown>>,
    summary: { totalPages: 0, writeCount: 0, skippedCount: 0, issueCount: 0 },
  })),
}))

const tagTaxonomyMock = vi.hoisted(() => ({
  previewTagTaxonomyBootstrap: vi.fn(async () => ({ action: "bootstrap", dryRun: true, wrote: false, removed: 0 })),
  applyTagTaxonomyBootstrap: vi.fn(async () => ({ action: "bootstrap", dryRun: false, wrote: true, removed: 0 })),
  previewTagTaxonomyGrowth: vi.fn(async () => ({ action: "growth", dryRun: true, wrote: false, removed: 0 })),
  applyTagTaxonomyGrowth: vi.fn(async () => ({ action: "growth", dryRun: false, wrote: true, removed: 0 })),
  rollbackLastTagTaxonomyBatch: vi.fn(async () => ({ action: "rollback", dryRun: false, wrote: true, removed: 1 })),
}))

const knowledgeAgentsConfigMock = vi.hoisted(() => ({
  loadKnowledgeAgentsConfig: vi.fn(async () => ({
    config: {
      schemaVersion: 2,
      updatedAt: 0,
      agents: {
        compiler: { enabled: false, autoRun: false, guidance: "" },
        linter: { enabled: false, autoRun: false, guidance: "" },
        fixer: { enabled: false, autoRun: false, guidance: "" },
        synthesizer: { enabled: false, autoRun: false, guidance: "" },
        tagger: { enabled: false, autoRun: false, guidance: "" },
        "qa-saver": { enabled: false, autoRun: false, guidance: "" },
      },
    },
    issues: [],
    conflict: false,
  })),
}))

const pipelineMock = vi.hoisted(() => ({
  executePipeline: vi.fn(async (
    _schema?: unknown,
    _runner?: (toolName: string, args: Record<string, unknown>) => Promise<{
      ok: boolean
      changedPaths?: string[]
      wikiChanged?: Array<{ path: string; operation: "create" | "update" | "delete" }>
      resourceLimit?: unknown
    }>,
  ) => ({ pipelineName: "test", ok: true, steps: [] as unknown[], totalDurationMs: 0 })),
}))

vi.mock("@/commands/fs", () => ({
  canonicalizePath: vi.fn(async (path: string) => fsMock.canonical.get(path) ?? path),
  listDirectory: vi.fn(async () => fsMock.tree),
  readFile: vi.fn(async (path: string) => {
    const value = fsMock.files.get(path)
    if (value === undefined) throw new Error(`missing file: ${path}`)
    return value
  }),
}))

vi.mock("@/lib/ingest", () => ({
  autoIngest: ingestMock.autoIngest,
  captionSourceImages: ingestMock.captionSourceImages,
}))

vi.mock("@/lib/save-query-page", () => ({
  saveQueryPage: saveQueryPageMock.saveQueryPage,
}))

vi.mock("@/lib/lint-fixer", () => ({
  fixLintResult: lintFixerMock.fixLintResult,
  fixLintReport: lintFixerMock.fixLintReport,
  runLintAndReport: lintFixerMock.runLintAndReport,
}))

vi.mock("@/lib/enrich-wikilinks", () => ({
  enrichWithWikilinks: enrichMock.enrichWithWikilinks,
}))

vi.mock("@/lib/deep-research", () => ({
  collectResearchSources: deepResearchMock.collectResearchSources,
  queueResearch: deepResearchMock.queueResearch,
  rewriteAnyTxtQueries: deepResearchMock.rewriteAnyTxtQueries,
}))

vi.mock("@/lib/dedup-runner", () => ({
  buildDedupLlmCall: dedupRunnerMock.buildDedupLlmCall,
  executeMerge: dedupRunnerMock.executeMerge,
  loadAllWikiPages: dedupRunnerMock.loadAllWikiPages,
  runDuplicateDetection: dedupRunnerMock.runDuplicateDetection,
}))

vi.mock("@/lib/dedup", () => ({
  mergeDuplicateGroup: dedupMock.mergeDuplicateGroup,
}))

vi.mock("@/lib/optimize-research-topic", () => ({
  optimizeResearchTopic: optimizeResearchTopicMock.optimizeResearchTopic,
}))

vi.mock("@/lib/sweep-reviews", () => ({
  sweepResolvedReviews: sweepReviewsMock.sweepResolvedReviews,
}))

vi.mock("@/lib/connection-tests", () => ({
  testLlmConnection: connectionTestsMock.testLlmConnection,
}))

vi.mock("@/lib/agent/agent-autofill", () => ({
  runAutofill: autofillMock.runAutofill,
}))

vi.mock("@/lib/wiki-synthesis", () => ({
  discoverSynthesisCandidates: wikiSynthesisMock.discoverSynthesisCandidates,
  runWikiSynthesis: wikiSynthesisMock.runWikiSynthesis,
}))

vi.mock("@/lib/okf-validate", () => ({
  validateOkfBundle: okfValidateMock.validateOkfBundle,
}))

vi.mock("@/lib/okf-export", () => ({
  buildOkfExportBundle: okfExportMock.buildOkfExportBundle,
}))

vi.mock("@/lib/okf-import", () => ({
  previewOkfImport: okfImportMock.previewOkfImport,
  importOkfBundle: okfImportMock.importOkfBundle,
}))

vi.mock("@/lib/agent/tag-taxonomy", () => ({
  previewTagTaxonomyBootstrap: tagTaxonomyMock.previewTagTaxonomyBootstrap,
  applyTagTaxonomyBootstrap: tagTaxonomyMock.applyTagTaxonomyBootstrap,
  previewTagTaxonomyGrowth: tagTaxonomyMock.previewTagTaxonomyGrowth,
  applyTagTaxonomyGrowth: tagTaxonomyMock.applyTagTaxonomyGrowth,
  rollbackLastTagTaxonomyBatch: tagTaxonomyMock.rollbackLastTagTaxonomyBatch,
}))

vi.mock("@/lib/agent/knowledge-agents-config", () => ({
  loadKnowledgeAgentsConfig: knowledgeAgentsConfigMock.loadKnowledgeAgentsConfig,
}))

vi.mock("@/lib/agent/agent-pipeline", () => ({
  executePipeline: pipelineMock.executePipeline,
  BUILTIN_PIPELINES: { "full-ingest": { name: "full-ingest", stages: [] }, "lint-fix": { name: "lint-fix", stages: [] } },
}))

describe("runAgentAppTool ingest parity tools", () => {
  it("declares every supported app tool in the descriptor table", () => {
    expect(Object.keys(AGENT_APP_TOOL_DESCRIPTORS).sort()).toEqual([
      "autofill_properties",
      "build_answer_context",
      "caption_source_images",
      "collect_research_sources",
      "detect_duplicates",
      "enrich_wikilinks",
      "fix_lint_report",
      "fix_lint_result",
      "get_agent_task_status",
      "get_knowledge_agents_config",
      "ingest_source",
      "merge_duplicate_group",
      "okf_export",
      "okf_import",
      "okf_validate",
      "optimize_research_topic",
      "run_deep_research",
      "run_lint",
      "run_lint_and_report",
      "run_pipeline",
      "save_query_page",
      "sweep_reviews",
      "synthesis_preview",
      "taxonomy_apply",
      "taxonomy_preview",
      "taxonomy_rollback",
      "test_provider_connection",
      "wiki_synthesis",
    ])
  })

  it("uses a dedicated handler for each supported app tool", () => {
    const handlers = Object.values(AGENT_APP_TOOL_DESCRIPTORS).map((descriptor) => descriptor.handler)
    expect(new Set(handlers).size).toBe(handlers.length)
  })

  it("documents Knowledge Agents opt-in defaults in the descriptor", () => {
    expect(AGENT_APP_TOOL_DESCRIPTORS.get_knowledge_agents_config.description)
      .toContain("enabled:false is the designed opt-in default")
  })

  beforeEach(() => {
    fsMock.tree = [{ name: "wiki", path: "/project/wiki", is_dir: true }]
    fsMock.canonical = new Map([["/project/raw/sources", "/project/raw/sources"]])
    fsMock.files = new Map([
      ["/project/wiki/overview.md", "# Overview"],
      ["/project/purpose.md", "# Purpose"],
    ])
    ingestMock.autoIngest.mockReset()
    saveQueryPageMock.saveQueryPage.mockReset()
    lintFixerMock.fixLintResult.mockReset()
    lintFixerMock.fixLintResult.mockResolvedValue(true)
    lintFixerMock.fixLintReport.mockReset()
    lintFixerMock.fixLintReport.mockResolvedValue({ report: {}, reportPath: "wiki/lint-report.md" })
    lintFixerMock.runLintAndReport.mockReset()
    lintFixerMock.runLintAndReport.mockResolvedValue({ report: {}, reportPath: "wiki/lint-report.md", changedPaths: [] })
    enrichMock.enrichWithWikilinks.mockReset()
    autofillMock.runAutofill.mockClear()
    autofillMock.runAutofill.mockResolvedValue({ pagesScanned: 0, statusPromoted: 0, tagsAssigned: 0, details: [] })
    okfValidateMock.validateOkfBundle.mockClear()
    okfValidateMock.validateOkfBundle.mockResolvedValue({ ok: true, issues: [] as Array<Record<string, unknown>>, summary: { totalPages: 0 } })
    okfExportMock.buildOkfExportBundle.mockClear()
    okfExportMock.buildOkfExportBundle.mockResolvedValue({ files: [] as Array<Record<string, unknown>>, report: { issues: [] as Array<Record<string, unknown>> } })
    okfImportMock.previewOkfImport.mockClear()
    okfImportMock.previewOkfImport.mockResolvedValue({
      applied: false,
      pages: [] as Array<{ targetRelativePath: string; action: "write" | "skip"; content?: string }>,
      issues: [] as Array<Record<string, unknown>>,
      summary: { totalPages: 0, writeCount: 0, skippedCount: 0, issueCount: 0 },
    })
    okfImportMock.importOkfBundle.mockClear()
    okfImportMock.importOkfBundle.mockResolvedValue({
      applied: true,
      pages: [] as Array<{ targetRelativePath: string; action: "write" | "skip"; content?: string }>,
      issues: [] as Array<Record<string, unknown>>,
      summary: { totalPages: 0, writeCount: 0, skippedCount: 0, issueCount: 0 },
    })
    tagTaxonomyMock.previewTagTaxonomyBootstrap.mockClear()
    tagTaxonomyMock.previewTagTaxonomyBootstrap.mockResolvedValue({ action: "bootstrap", dryRun: true, wrote: false, removed: 0 })
    tagTaxonomyMock.applyTagTaxonomyBootstrap.mockClear()
    tagTaxonomyMock.applyTagTaxonomyBootstrap.mockResolvedValue({ action: "bootstrap", dryRun: false, wrote: true, removed: 0 })
    tagTaxonomyMock.previewTagTaxonomyGrowth.mockClear()
    tagTaxonomyMock.previewTagTaxonomyGrowth.mockResolvedValue({ action: "growth", dryRun: true, wrote: false, removed: 0 })
    tagTaxonomyMock.applyTagTaxonomyGrowth.mockClear()
    tagTaxonomyMock.applyTagTaxonomyGrowth.mockResolvedValue({ action: "growth", dryRun: false, wrote: true, removed: 0 })
    tagTaxonomyMock.rollbackLastTagTaxonomyBatch.mockClear()
    tagTaxonomyMock.rollbackLastTagTaxonomyBatch.mockResolvedValue({ action: "rollback", dryRun: false, wrote: true, removed: 1 })
    wikiSynthesisMock.discoverSynthesisCandidates.mockClear()
    wikiSynthesisMock.discoverSynthesisCandidates.mockResolvedValue({ dimension: 1, minClusterSize: 3, candidates: [] as Array<Record<string, unknown>>, totalCandidates: 0 })
    knowledgeAgentsConfigMock.loadKnowledgeAgentsConfig.mockClear()
    knowledgeAgentsConfigMock.loadKnowledgeAgentsConfig.mockResolvedValue({
      config: {
        schemaVersion: 2,
        updatedAt: 0,
        agents: {
          compiler: { enabled: false, autoRun: false, guidance: "" },
          linter: { enabled: false, autoRun: false, guidance: "" },
          fixer: { enabled: false, autoRun: false, guidance: "" },
          synthesizer: { enabled: false, autoRun: false, guidance: "" },
          tagger: { enabled: false, autoRun: false, guidance: "" },
          "qa-saver": { enabled: false, autoRun: false, guidance: "" },
        },
      },
      issues: [],
      conflict: false,
    })
    wikiSynthesisMock.runWikiSynthesis.mockClear()
    wikiSynthesisMock.runWikiSynthesis.mockResolvedValue({ ok: true, topic: "test", clusterSize: 3, synthesisPath: "wiki/synthesis/test-synthesis.md", externalSources: 0 })
    pipelineMock.executePipeline.mockClear()
    pipelineMock.executePipeline.mockResolvedValue({ pipelineName: "test", ok: true, steps: [], totalDurationMs: 0 })
    ingestMock.captionSourceImages.mockReset()
    deepResearchMock.collectResearchSources.mockReset()
    deepResearchMock.queueResearch.mockReset()
    deepResearchMock.rewriteAnyTxtQueries.mockReset()
    dedupRunnerMock.buildDedupLlmCall.mockReset()
    dedupRunnerMock.executeMerge.mockReset()
    dedupRunnerMock.loadAllWikiPages.mockReset()
    dedupRunnerMock.runDuplicateDetection.mockReset()
    dedupMock.mergeDuplicateGroup.mockReset()
    optimizeResearchTopicMock.optimizeResearchTopic.mockReset()
    sweepReviewsMock.sweepResolvedReviews.mockReset()
    connectionTestsMock.testLlmConnection.mockReset()
    dedupRunnerMock.buildDedupLlmCall.mockReturnValue(vi.fn())
    useResearchStore.setState({ tasks: [] })
    useReviewStore.setState({ items: [] })
    useWikiStore.setState({
      project: { id: "p1", name: "Project", path: "/project" },
      fileTree: [],
      dataVersion: 0,
      llmConfig: {
        provider: "openai",
        apiKey: "",
        maxContextSize: 204800,
        model: "gpt-test",
        ollamaUrl: "http://localhost:11434",
        customEndpoint: "",
        azureApiVersion: "2024-10-21",
        reasoning: { mode: "auto" },
      },
      searchApiConfig: {
        provider: "none",
        apiKey: "",
        deepResearchSource: "web",
      },
    })
  })

  it("runs ingest_source through autoIngest and reports changed wiki paths", async () => {
    ingestMock.autoIngest.mockImplementationOnce(async (
      _projectPath: string,
      _sourcePath: string,
      _llmConfig: unknown,
      _signal: unknown,
      _folderContext: unknown,
      onPageWritten?: (record: { path: string; wasCreated: boolean; previousContent: string | null }) => void,
    ) => {
      onPageWritten?.({ path: "wiki/sources/source.md", wasCreated: false, previousContent: "old source" })
      onPageWritten?.({ path: "wiki/entities/topic.md", wasCreated: true, previousContent: null })
      return ["wiki/sources/source.md", "wiki/entities/topic.md"]
    })

    const response = await runAgentAppTool("ingest_source", {
      sourcePath: "source.pdf",
      folderContext: "folder note",
    })

    expect(ingestMock.autoIngest).toHaveBeenCalledWith(
      "/project",
      "/project/raw/sources/source.pdf",
      expect.objectContaining({ model: "gpt-test" }),
      undefined,
      "folder note",
      expect.any(Function),
    )
    expect(response.result).toEqual({
      sourcePath: "/project/raw/sources/source.pdf",
      writtenPaths: ["wiki/sources/source.md", "wiki/entities/topic.md"],
      filesWritten: 2,
      autofill: { pagesScanned: 0, statusPromoted: 0, tagsAssigned: 0, details: [] },
    })
    expect(response.changedPaths).toBeUndefined()
    expect(response.wikiChanged).toEqual([
      {
        path: "wiki/sources/source.md",
        operation: "update",
        existedBefore: true,
        beforeText: "old source",
      },
      {
        path: "wiki/entities/topic.md",
        operation: "create",
        existedBefore: false,
        beforeText: "",
      },
    ])
    expect(autofillMock.runAutofill).toHaveBeenNthCalledWith(1, "/project", { dryRun: true })
    expect(autofillMock.runAutofill).toHaveBeenNthCalledWith(2, "/project")
    expect(useWikiStore.getState().fileTree).toEqual(fsMock.tree)
    expect(useWikiStore.getState().dataVersion).toBe(1)
  })

  it("runs save_query_page and emits one wikiChanged per successful file write", async () => {
    saveQueryPageMock.saveQueryPage.mockImplementationOnce(async (options: {
      onPageWritten?: (record: { path: string; wasCreated: boolean; previousContent: string | null }) => void
    }) => {
      options.onPageWritten?.({ path: "wiki/queries/saved.md", wasCreated: true, previousContent: null })
      options.onPageWritten?.({ path: "wiki/index.md", wasCreated: false, previousContent: "# Index\n" })
      options.onPageWritten?.({ path: "wiki/log.md", wasCreated: false, previousContent: "# Log\n" })
      return {
        path: "/project/wiki/queries/saved.md",
        relativePath: "wiki/queries/saved.md",
        title: "Saved",
        fileName: "saved.md",
        date: "2026-07-06",
        autoIngestStarted: false,
        fileTree: fsMock.tree,
      }
    })

    const response = await runAgentAppTool("save_query_page", {
      content: "# Saved",
      title: "Saved",
    })

    expect(saveQueryPageMock.saveQueryPage).toHaveBeenCalledWith(expect.objectContaining({
      projectPath: "/project",
      content: "# Saved",
      title: "Saved",
      onPageWritten: expect.any(Function),
    }))
    expect(response.wikiChanged).toEqual([
      { path: "wiki/queries/saved.md", operation: "create", existedBefore: false, beforeText: "" },
      { path: "wiki/index.md", operation: "update", existedBefore: true, beforeText: "# Index\n" },
      { path: "wiki/log.md", operation: "update", existedBefore: true, beforeText: "# Log\n" },
    ])
  })

  it("returns partial wikiChanged when save_query_page fails after a write", async () => {
    saveQueryPageMock.saveQueryPage.mockImplementationOnce(async (options: {
      onPageWritten?: (record: { path: string; wasCreated: boolean; previousContent: string | null }) => void
    }) => {
      options.onPageWritten?.({ path: "wiki/queries/saved.md", wasCreated: true, previousContent: null })
      throw new Error("index write failed")
    })

    const response = await runAgentAppTool("save_query_page", {
      content: "# Saved",
      title: "Saved",
    })

    expect(response.result).toEqual({
      ok: false,
      error: "index write failed",
      partial: true,
    })
    expect(response.wikiChanged).toEqual([
      { path: "wiki/queries/saved.md", operation: "create", existedBefore: false, beforeText: "" },
    ])
  })

  it("runs caption_source_images and rejects absolute paths outside project", async () => {
    fsMock.files.set("/project/wiki/sources/source.md", "old source summary")
    ingestMock.captionSourceImages.mockImplementationOnce(async (
      _projectPath: string,
      _sourcePath: string,
      _llmConfig: unknown,
      _signal: unknown,
      _forceRecaption: boolean,
      onPageWritten?: (record: { path: string; wasCreated: boolean; previousContent: string | null }) => void,
    ) => {
      onPageWritten?.({ path: "wiki/sources/source.md", wasCreated: false, previousContent: "old source summary" })
      return {
      sourcePath: "/project/raw/sources/source.pdf",
      sourceIdentity: "source.pdf",
      sourceSummaryPath: "wiki/sources/source.md",
      imagesFound: 2,
      freshCaptions: 1,
      cachedCaptions: 1,
      failed: 0,
      multimodalEnabled: true,
      sourceSummaryUpdated: true,
      embeddingRecommended: true,
      }
    })

    const response = await runAgentAppTool("caption_source_images", {
      sourcePath: "raw/sources/source.pdf",
      forceRecaption: true,
    })

    expect(ingestMock.captionSourceImages).toHaveBeenCalledWith(
      "/project",
      "/project/raw/sources/source.pdf",
      expect.objectContaining({ model: "gpt-test" }),
      undefined,
      true,
      expect.any(Function),
    )
    expect(response.wikiChanged).toEqual([
      {
        path: "wiki/sources/source.md",
        operation: "update",
        existedBefore: true,
        beforeText: "old source summary",
      },
    ])
    await expect(
      runAgentAppTool("caption_source_images", { sourcePath: "/tmp/source.pdf" }),
    ).rejects.toThrow(/inside the active project/)
    await expect(
      runAgentAppTool("ingest_source", { sourcePath: "../../../secrets.txt" }),
    ).rejects.toThrow(/traversal/)
    await expect(
      runAgentAppTool("ingest_source", { sourcePath: "/project/raw/sources/../secrets.txt" }),
    ).rejects.toThrow(/traversal/)
  })

  it("emits orphan fix_lint_result cascade wikiChanged records", async () => {
    lintFixerMock.fixLintResult.mockImplementationOnce(async (
      _projectPath: string,
      _result: unknown,
      _llmConfig: unknown,
      onWikiChanged?: (change: { path: string; operation: "create" | "update" | "delete"; existedBefore: boolean; beforeText: string }) => void,
    ) => {
      onWikiChanged?.({
        path: "wiki/entities/orphan.md",
        operation: "delete",
        existedBefore: true,
        beforeText: "# Orphan",
      })
      onWikiChanged?.({
        path: "wiki/index.md",
        operation: "update",
        existedBefore: true,
        beforeText: "[[entities/orphan|Orphan]]",
      })
      return true
    })

    const response = await runAgentAppTool("fix_lint_result", {
      result: { type: "orphan", severity: "info", page: "entities/orphan.md", detail: "orphan" },
    })

    expect(lintFixerMock.fixLintResult).toHaveBeenCalledWith(
      "/project",
      { type: "orphan", severity: "info", page: "entities/orphan.md", detail: "orphan", affectedPages: undefined },
      expect.objectContaining({ model: "gpt-test" }),
      expect.any(Function),
    )
    expect(response.result).toMatchObject({ fixed: true })
    expect(response.wikiChanged).toEqual([
      {
        path: "wiki/entities/orphan.md",
        operation: "delete",
        existedBefore: true,
        beforeText: "# Orphan",
      },
      {
        path: "wiki/index.md",
        operation: "update",
        existedBefore: true,
        beforeText: "[[entities/orphan|Orphan]]",
      },
    ])
  })

  it("emits enrich_wikilinks wikiChanged only after the write callback succeeds", async () => {
    enrichMock.enrichWithWikilinks.mockImplementationOnce(async (
      _projectPath: string,
      _filePath: string,
      _llmConfig: unknown,
      onPageWritten?: (record: { path: string; wasCreated: boolean; previousContent: string | null }) => void,
    ) => {
      onPageWritten?.({ path: "wiki/entities/topic.md", wasCreated: false, previousContent: "before links" })
    })

    const response = await runAgentAppTool("enrich_wikilinks", {
      path: "wiki/entities/topic.md",
    })

    expect(response.wikiChanged).toEqual([
      {
        path: "wiki/entities/topic.md",
        operation: "update",
        existedBefore: true,
        beforeText: "before links",
      },
    ])
  })

  it("does not emit fake enrich_wikilinks wikiChanged when enrichment fails before writing", async () => {
    enrichMock.enrichWithWikilinks.mockRejectedValueOnce(new Error("enrich failed"))

    await expect(
      runAgentAppTool("enrich_wikilinks", { path: "wiki/entities/topic.md" }),
    ).rejects.toThrow("enrich failed")
  })

  it("rejects source paths that canonicalize outside raw/sources", async () => {
    fsMock.canonical = new Map([
      ["/project/raw/sources", "/project/raw/sources"],
      ["/project/raw/sources/link.pdf", "/tmp/secret.pdf"],
    ])

    await expect(
      runAgentAppTool("ingest_source", { sourcePath: "link.pdf" }),
    ).rejects.toThrow(/resolve inside raw\/sources/)
  })

  it("collects research sources through configured app search services", async () => {
    deepResearchMock.rewriteAnyTxtQueries.mockResolvedValue(["local keywords"])
    deepResearchMock.collectResearchSources.mockResolvedValue({
      results: [{ title: "Source", url: "https://example.com", snippet: "hit", source: "web" }],
      errors: ["provider leaked search-key in body"],
    })
    useWikiStore.setState({
      searchApiConfig: {
        provider: "tavily",
        apiKey: "search-key",
        deepResearchSource: "both",
        anyTxt: { endpoint: "http://127.0.0.1:9920" },
      },
    })

    const response = await runAgentAppTool("collect_research_sources", {
      topic: "winter ammonia",
      sourceMode: "both",
    })

    expect(deepResearchMock.collectResearchSources).toHaveBeenCalledWith(
      ["winter ammonia"],
      expect.objectContaining({ deepResearchSource: "both" }),
      "/project",
      undefined,
      { llmConfig: expect.objectContaining({ model: "gpt-test" }) },
    )
    expect(response.result).toEqual({
      queries: ["winter ammonia"],
      sourceMode: "both",
      results: [{ title: "Source", url: "https://example.com", snippet: "hit", source: "web" }],
      errors: ["provider leaked REDACTED in body"],
    })
  })

  it("returns structured collect errors and falls back when AnyTXT rewrite fails", async () => {
    const unconfigured = await runAgentAppTool("collect_research_sources", {
      topic: "unconfigured",
    })
    expect(deepResearchMock.collectResearchSources).not.toHaveBeenCalled()
    expect(unconfigured.result).toEqual({
      queries: ["unconfigured"],
      sourceMode: "web",
      results: [],
      errors: ["Deep research source is not configured"],
    })

    deepResearchMock.rewriteAnyTxtQueries.mockRejectedValue(new Error("rewrite failed"))
    deepResearchMock.collectResearchSources.mockResolvedValue({ results: [], errors: [] })
    useWikiStore.setState({
      searchApiConfig: {
        provider: "none",
        apiKey: "",
        deepResearchSource: "anytxt",
        anyTxt: { endpoint: "http://127.0.0.1:9920" },
      },
    })

    await runAgentAppTool("collect_research_sources", {
      topic: "fallback",
      sourceMode: "anytxt",
    })

    expect(deepResearchMock.collectResearchSources).toHaveBeenLastCalledWith(
      ["fallback"],
      expect.objectContaining({ deepResearchSource: "anytxt" }),
      "/project",
      undefined,
      { llmConfig: expect.objectContaining({ model: "gpt-test" }) },
    )
  })

  it("passes the current llmConfig to AnyTXT source collection", async () => {
    deepResearchMock.collectResearchSources.mockResolvedValue({ results: [], errors: [] })
    const llmConfig = {
      ...useWikiStore.getState().llmConfig,
      apiKey: "llm-key",
      model: "gpt-anytxt",
    }
    useWikiStore.setState({
      llmConfig,
      searchApiConfig: {
        provider: "none",
        apiKey: "",
        deepResearchSource: "anytxt",
        anyTxt: { endpoint: "http://127.0.0.1:9920" },
      },
    })

    await runAgentAppTool("collect_research_sources", {
      topic: "local corpus",
      sourceMode: "anytxt",
    })

    expect(deepResearchMock.collectResearchSources).toHaveBeenCalledWith(
      ["local corpus"],
      expect.objectContaining({ deepResearchSource: "anytxt" }),
      "/project",
      undefined,
      { llmConfig },
    )
  })

  it("starts deep research and exposes task status", async () => {
    deepResearchMock.queueResearch.mockReturnValue("research-42")
    useWikiStore.setState({
      searchApiConfig: {
        provider: "tavily",
        apiKey: "search-key",
        deepResearchSource: "web",
      },
    })

    const started = await runAgentAppTool("run_deep_research", {
      topic: "membrane bioreactor",
      searchQueries: ["MBR winter"],
    })

    expect(deepResearchMock.queueResearch).toHaveBeenCalledWith(
      "/project",
      "membrane bioreactor",
      expect.objectContaining({ model: "gpt-test" }),
      expect.objectContaining({ provider: "tavily" }),
      ["MBR winter"],
    )
    expect(started.result).toEqual({
      taskId: "research-42",
      status: "queued",
      topic: "membrane bioreactor",
      searchQueries: ["MBR winter"],
      sourceMode: "web",
    })

    useResearchStore.setState({
      tasks: [{
        id: "research-42",
        projectPath: "/project",
        topic: "membrane bioreactor",
        status: "done",
        searchQueries: ["MBR winter"],
        webResults: [{ title: "Source", url: "https://example.com", snippet: "hit", source: "web" }],
        synthesis: "summary",
        savedPath: "wiki/queries/research-mbr.md",
        error: "failed with search-key",
        createdAt: 123,
      }],
    })

    const status = await runAgentAppTool("get_agent_task_status", {
      taskId: "research-42",
    })

    expect(status.result).toEqual({
      taskId: "research-42",
      topic: "membrane bioreactor",
      status: "done",
      searchQueries: ["MBR winter"],
      sourceCount: 1,
      synthesis: "summary",
      savedPath: "wiki/queries/research-mbr.md",
      error: "failed with REDACTED",
      createdAt: 123,
    })

    const missing = await runAgentAppTool("get_agent_task_status", {
      taskId: "missing-task",
    })

    expect(missing.result).toEqual({
      taskId: "missing-task",
      status: "missing",
      error: "Agent task not found",
    })

    deepResearchMock.queueResearch.mockClear()
    deepResearchMock.queueResearch.mockReturnValue("research-queries-only")
    const queriesOnly = await runAgentAppTool("run_deep_research", {
      queries: ["query topic", "extra query"],
    })

    expect(deepResearchMock.queueResearch).toHaveBeenCalledWith(
      "/project",
      "query topic",
      expect.objectContaining({ model: "gpt-test" }),
      expect.objectContaining({ provider: "tavily" }),
      ["query topic", "extra query"],
    )
    expect(queriesOnly.result).toEqual({
      taskId: "research-queries-only",
      status: "queued",
      topic: "query topic",
      searchQueries: ["query topic", "extra query"],
      sourceMode: "web",
    })
  })

  it("returns a structured error when deep research sources are not configured", async () => {
    const response = await runAgentAppTool("run_deep_research", {
      topic: "unconfigured",
    })

    expect(deepResearchMock.queueResearch).not.toHaveBeenCalled()
    expect(response.result).toEqual({
      taskId: null,
      status: "error",
      error: "Deep research source is not configured",
    })
  })

  it("rejects invalid sourceMode values in app tool args", async () => {
    await expect(
      runAgentAppTool("collect_research_sources", {
        topic: "bad mode",
        sourceMode: "files",
      }),
    ).rejects.toThrow(/sourceMode/)
  })

  it("rejects research tools without a topic or query seed", async () => {
    await expect(
      runAgentAppTool("collect_research_sources", {
        searchQueries: ["  "],
      }),
    ).rejects.toThrow(/topic or at least one searchQueries\/queries/)
    await expect(
      runAgentAppTool("run_deep_research", {
        queries: [],
      }),
    ).rejects.toThrow(/topic or at least one searchQueries\/queries/)
  })

  it("detects duplicate groups with a bounded result set", async () => {
    dedupRunnerMock.runDuplicateDetection.mockResolvedValue([
      { slugs: ["a", "b"], reason: "same", confidence: "high" },
      { slugs: ["c", "d"], reason: "same", confidence: "medium" },
    ])

    const response = await runAgentAppTool("detect_duplicates", { limit: 1 })

    expect(dedupRunnerMock.runDuplicateDetection).toHaveBeenCalledWith(
      "/project",
      expect.objectContaining({ model: "gpt-test" }),
    )
    expect(response.result).toEqual({
      groups: [{ slugs: ["a", "b"], reason: "same", confidence: "high" }],
      totalGroups: 2,
    })
  })

  it("dry-runs duplicate merge without writing and summarizes the plan", async () => {
    dedupRunnerMock.loadAllWikiPages.mockResolvedValue([
      { path: "wiki/entities/a.md", content: "---\ntitle: A\n---\nA" },
      { path: "wiki/entities/b.md", content: "---\ntitle: B\n---\nB" },
      { path: "wiki/index.md", content: "- [[a]]\n- [[b]]" },
    ])
    dedupMock.mergeDuplicateGroup.mockResolvedValue({
      canonicalPath: "wiki/entities/a.md",
      canonicalContent: "---\ntitle: A\n---\nMerged",
      rewrites: [{ path: "wiki/index.md", newContent: "- [[a]]" }],
      pagesToDelete: ["wiki/entities/b.md"],
      backup: [
        { path: "wiki/entities/a.md", content: "A" },
        { path: "wiki/entities/b.md", content: "B" },
      ],
    })

    const response = await runAgentAppTool("merge_duplicate_group", {
      group: { slugs: ["a", "b"], reason: "same", confidence: "high" },
      canonicalSlug: "a",
    })

    expect(dedupRunnerMock.executeMerge).not.toHaveBeenCalled()
    expect(dedupMock.mergeDuplicateGroup).toHaveBeenCalledWith(
      expect.objectContaining({
        canonicalSlug: "a",
        group: [
          { slug: "a", path: "wiki/entities/a.md", content: "---\ntitle: A\n---\nA" },
          { slug: "b", path: "wiki/entities/b.md", content: "---\ntitle: B\n---\nB" },
        ],
      }),
      expect.any(Function),
    )
    expect(response.wikiChanged).toEqual([])
    expect(response.result).toMatchObject({
      dryRun: true,
      canonicalPath: "wiki/entities/a.md",
      rewrites: [{ path: "wiki/index.md", bytes: 7 }],
      pagesToDelete: ["wiki/entities/b.md"],
      backupPaths: ["wiki/entities/a.md", "wiki/entities/b.md"],
    })
    expect(useWikiStore.getState().dataVersion).toBe(0)
  })

  it("executes duplicate merge only when dryRun is false and refreshes wiki state", async () => {
    dedupRunnerMock.executeMerge.mockResolvedValue({
      canonicalPath: "wiki/entities/a.md",
      canonicalContent: "Merged",
      rewrites: [{ path: "wiki/overview.md", newContent: "Overview" }],
      pagesToDelete: ["wiki/entities/b.md"],
      backup: [
        { path: "wiki/entities/a.md", content: "A before" },
        { path: "wiki/overview.md", content: "Overview before" },
        { path: "wiki/entities/b.md", content: "B before" },
      ],
    })

    const response = await runAgentAppTool("merge_duplicate_group", {
      slugs: ["a", "b"],
      canonicalSlug: "a",
      dryRun: false,
    })

    expect(dedupRunnerMock.executeMerge).toHaveBeenCalledWith(
      "/project",
      { slugs: ["a", "b"], reason: "", confidence: "low" },
      "a",
      expect.objectContaining({ model: "gpt-test" }),
      expect.objectContaining({ onWikiChanged: expect.any(Function) }),
    )
    expect(response.wikiChanged).toEqual([
      {
        path: "wiki/entities/a.md",
        operation: "update",
        existedBefore: true,
        beforeText: "A before",
      },
      {
        path: "wiki/overview.md",
        operation: "update",
        existedBefore: true,
        beforeText: "Overview before",
      },
      {
        path: "wiki/entities/b.md",
        operation: "delete",
        existedBefore: true,
        beforeText: "B before",
      },
    ])
    expect(useWikiStore.getState().fileTree).toEqual(fsMock.tree)
    expect(useWikiStore.getState().dataVersion).toBe(1)
  })

  it("optimizes research topics with project context files", async () => {
    optimizeResearchTopicMock.optimizeResearchTopic.mockResolvedValue({
      topic: "better topic",
      searchQueries: ["q1", "q2"],
    })

    const response = await runAgentAppTool("optimize_research_topic", {
      gapTitle: "gap",
      gapDescription: "desc",
      gapType: "missing-page",
    })

    expect(optimizeResearchTopicMock.optimizeResearchTopic).toHaveBeenCalledWith(
      expect.objectContaining({ model: "gpt-test" }),
      "gap",
      "desc",
      "missing-page",
      "# Overview",
      "# Purpose",
    )
    expect(response.result).toEqual({ topic: "better topic", searchQueries: ["q1", "q2"] })
  })

  it("sweeps reviews and reports before/after counts", async () => {
    useReviewStore.setState({
      items: [
        {
          id: "r1",
          type: "missing-page",
          title: "Missing",
          description: "",
          options: [],
          resolved: false,
          createdAt: 1,
        },
        {
          id: "r2",
          type: "duplicate",
          title: "Dup",
          description: "",
          options: [],
          resolved: true,
          createdAt: 2,
        },
      ],
    })
    sweepReviewsMock.sweepResolvedReviews.mockImplementation(async () => {
      useReviewStore.setState({
        items: useReviewStore.getState().items.map((item) =>
          item.id === "r1" ? { ...item, resolved: true, resolvedAction: "auto-resolved" } : item,
        ),
      })
      return 1
    })

    const response = await runAgentAppTool("sweep_reviews", {})

    expect(sweepReviewsMock.sweepResolvedReviews).toHaveBeenCalledWith("/project")
    expect(response.result).toEqual({
      resolvedCount: 1,
      pendingBefore: 1,
      pendingAfter: 0,
      totalReviews: 2,
    })
    expect(response.wikiChanged).toBeUndefined()
  })

  it("blocks fix_lint_report before writing when planned pages exceed budget", async () => {
    const response = await runAgentAppTool(
      "fix_lint_report",
      {
        reportPath: "wiki/lint-report-1.md",
        report: {
          healthScore: 80,
          autoFixItems: [
            { type: "broken-link", severity: "warning", page: "entities/a.md", detail: "a" },
            { type: "orphan", severity: "info", page: "entities/b.md", detail: "b" },
          ],
          humanItems: [],
        },
      },
      { budget: { maxFilesChanged: 1, maxFilesChangedEnabled: true, changedPaths: [] } },
    )

    expect(response.ok).toBe(false)
    if (response.ok) throw new Error("expected resource limit")
    expect(response.resourceLimit.limitKind).toBe("max_files_changed")
    expect(response.resourceLimit.attempted).toBe(3)
    expect(response.resourceLimit.changedPaths).toEqual([
      "wiki/entities/a.md",
      "wiki/entities/b.md",
      "wiki/lint-report-1.md",
    ])
  })

  it("previews autofill_properties and blocks before real writes when over budget", async () => {
    autofillMock.runAutofill.mockImplementation(async (_projectPath?: string, options?: { dryRun?: boolean }) => {
      if (options?.dryRun) {
        return {
          pagesScanned: 2,
          statusPromoted: 2,
          tagsAssigned: 0,
          details: [
            { path: "entities/a", relativePath: "wiki/entities/a.md", action: "status" as const, from: "Draft", to: "Reviewed" },
            { path: "entities/b", relativePath: "wiki/entities/b.md", action: "status" as const, from: "Draft", to: "Reviewed" },
          ],
        }
      }
      return { pagesScanned: 0, statusPromoted: 0, tagsAssigned: 0, details: [] }
    })

    const response = await runAgentAppTool(
      "autofill_properties",
      {},
      { budget: { maxFilesChanged: 1, maxFilesChangedEnabled: true, changedPaths: [] } },
    )

    expect(response.ok).toBe(false)
    if (response.ok) throw new Error("expected resource limit")
    expect(response.resourceLimit.attempted).toBe(2)
    expect(autofillMock.runAutofill).toHaveBeenCalledTimes(1)
    expect(autofillMock.runAutofill).toHaveBeenCalledWith("/project", { dryRun: true })
  })

  it("passes taxonomy-aware autofill options through the budget preview/apply path", async () => {
    autofillMock.runAutofill.mockImplementation(async (_projectPath?: string, options?: {
      dryRun?: boolean
      taxonomyAware?: boolean
      autoWriteHighConfidence?: boolean
      onWikiChanged?: (change: { path: string; operation: "update"; existedBefore: boolean; beforeText: string }) => void
    }) => {
      if (!options?.dryRun) {
        options?.onWikiChanged?.({
          path: "wiki/entities/topic.md",
          operation: "update",
          existedBefore: true,
          beforeText: "---\ntags: []\n---\n# Topic",
        })
      }
      return {
        pagesScanned: 1,
        statusPromoted: 0,
        tagsAssigned: options?.dryRun ? 0 : 1,
        details: [
          { path: "entities/topic", relativePath: "wiki/entities/topic.md", action: "tags" as const, from: "(empty)", to: "Artificial Intelligence" },
        ],
        taxonomy: {
          enabled: true,
          fallback: false,
          dryRun: options?.dryRun === true,
          autoWriteHighConfidence: options?.autoWriteHighConfidence === true,
          reports: [],
          proposalCount: 0,
          issues: [],
        },
      }
    })

    const response = await runAgentAppTool(
      "autofill_properties",
      { taxonomyAware: true, autoWriteHighConfidence: true },
      { budget: { maxFilesChanged: 1, maxFilesChangedEnabled: true, changedPaths: [] } },
    )

    expect(response.ok).toBe(true)
    expect(autofillMock.runAutofill).toHaveBeenNthCalledWith(1, "/project", {
      dryRun: true,
      taxonomyAware: true,
      autoWriteHighConfidence: true,
    })
    expect(autofillMock.runAutofill).toHaveBeenNthCalledWith(2, "/project", {
      dryRun: false,
      taxonomyAware: true,
      autoWriteHighConfidence: true,
      onWikiChanged: expect.any(Function),
    })
    expect(response.wikiChanged).toEqual([
      {
        path: "wiki/entities/topic.md",
        operation: "update",
        existedBefore: true,
        beforeText: "---\ntags: []\n---\n# Topic",
      },
    ])
  })

  it("blocks taxonomy-aware autofill auto-write before apply when preview exceeds budget", async () => {
    autofillMock.runAutofill.mockResolvedValue({
      pagesScanned: 1,
      statusPromoted: 0,
      tagsAssigned: 1,
      details: [
        { path: "entities/topic", relativePath: "wiki/entities/topic.md", action: "tags", from: "(empty)", to: "Artificial Intelligence" },
      ],
      taxonomy: {
        enabled: true,
        fallback: false,
        dryRun: true,
        autoWriteHighConfidence: true,
        reports: [],
        proposalCount: 0,
        issues: [],
      },
    })

    const response = await runAgentAppTool(
      "autofill_properties",
      { taxonomyAware: true, autoWriteHighConfidence: true },
      { budget: { maxFilesChanged: 0, maxFilesChangedEnabled: true, changedPaths: [] } },
    )

    expect(response.ok).toBe(false)
    if (response.ok) throw new Error("expected resource limit")
    expect(response.resourceLimit.attempted).toBe(1)
    expect(response.resourceLimit.path).toBe("wiki/entities/topic.md")
    expect(response.resourceLimit.changedPaths).toEqual(["wiki/entities/topic.md"])
    expect(autofillMock.runAutofill).toHaveBeenCalledTimes(1)
    expect(autofillMock.runAutofill).toHaveBeenCalledWith("/project", {
      dryRun: true,
      taxonomyAware: true,
      autoWriteHighConfidence: true,
    })
  })

  it("keeps taxonomy-aware autofill preview-only when high-confidence writes are not enabled", async () => {
    autofillMock.runAutofill.mockResolvedValue({
      pagesScanned: 1,
      statusPromoted: 1,
      tagsAssigned: 0,
      details: [
        { path: "entities/topic", relativePath: "wiki/entities/topic.md", action: "status", from: "Draft", to: "Reviewed" },
      ],
      taxonomy: {
        enabled: true,
        fallback: false,
        dryRun: true,
        autoWriteHighConfidence: false,
        reports: [],
        proposalCount: 1,
        issues: [],
      },
    })

    const response = await runAgentAppTool(
      "autofill_properties",
      { taxonomyAware: true },
      { budget: { maxFilesChanged: 0, maxFilesChangedEnabled: true, changedPaths: [] } },
    )

    expect(response.ok).toBe(true)
    expect(autofillMock.runAutofill).toHaveBeenNthCalledWith(1, "/project", {
      dryRun: true,
      taxonomyAware: true,
      autoWriteHighConfidence: false,
    })
    expect(autofillMock.runAutofill).toHaveBeenNthCalledWith(2, "/project", {
      dryRun: true,
      taxonomyAware: true,
      autoWriteHighConfidence: false,
      onWikiChanged: expect.any(Function),
    })
    expect(response.wikiChanged).toEqual([])
  })

  it("runs okf_validate and okf_export as read-only app tools", async () => {
    okfValidateMock.validateOkfBundle.mockResolvedValueOnce({ ok: false, issues: [{ code: "missing_type" }], summary: { totalPages: 1 } })
    okfExportMock.buildOkfExportBundle.mockResolvedValueOnce({ files: [{ path: "wiki/index.md" }], report: { issues: [] } })

    const validation = await runAgentAppTool("okf_validate", {})
    const bundle = await runAgentAppTool("okf_export", {})

    expect(validation.result).toEqual({ ok: false, issues: [{ code: "missing_type" }], summary: { totalPages: 1 } })
    expect(bundle.result).toEqual({ files: [{ path: "wiki/index.md" }], report: { issues: [] } })
    expect(okfValidateMock.validateOkfBundle).toHaveBeenCalledWith("/project")
    expect(okfExportMock.buildOkfExportBundle).toHaveBeenCalledWith("/project")
  })

  it("previews okf_import by default without writing", async () => {
    okfImportMock.previewOkfImport.mockResolvedValueOnce({
      applied: false,
      pages: [{ targetRelativePath: "wiki/entities/a.md", action: "write" }],
      issues: [],
      summary: { totalPages: 1, writeCount: 1, skippedCount: 0, issueCount: 0 },
    })

    const response = await runAgentAppTool("okf_import", { sourceDir: "/source" })

    expect(response.ok).toBe(true)
    expect(okfImportMock.previewOkfImport).toHaveBeenCalledWith("/source", "/project")
    expect(okfImportMock.importOkfBundle).not.toHaveBeenCalled()
    expect(response.wikiChanged).toEqual([])
  })

  it("applies okf_import only after preview budget passes", async () => {
    okfImportMock.previewOkfImport.mockResolvedValueOnce({
      applied: false,
      pages: [
        { targetRelativePath: "wiki/entities/a.md", action: "write" },
        { targetRelativePath: "wiki/entities/b.md", action: "skip" },
      ],
      issues: [],
      summary: { totalPages: 2, writeCount: 1, skippedCount: 1, issueCount: 0 },
    })
    okfImportMock.importOkfBundle.mockImplementationOnce(async (...callArgs: unknown[]) => {
      const options = callArgs[2] as {
        apply?: boolean
        onWikiChanged?: (change: { path: string; operation: "create"; existedBefore: boolean; beforeText: string }) => void
      } | undefined
      options?.onWikiChanged?.({
        path: "wiki/entities/a.md",
        operation: "create",
        existedBefore: false,
        beforeText: "",
      })
      return {
        applied: true,
        pages: [
          { targetRelativePath: "wiki/entities/a.md", action: "write" as const },
          { targetRelativePath: "wiki/entities/b.md", action: "skip" as const },
        ],
        issues: [],
        summary: { totalPages: 2, writeCount: 1, skippedCount: 1, issueCount: 0 },
      }
    })

    const response = await runAgentAppTool(
      "okf_import",
      { sourceDir: "/source", apply: true },
      { budget: { maxFilesChanged: 1, maxFilesChangedEnabled: true, changedPaths: [] } },
    )

    expect(response.ok).toBe(true)
    expect(okfImportMock.importOkfBundle).toHaveBeenCalledWith("/source", "/project", {
      apply: true,
      onWikiChanged: expect.any(Function),
    })
    expect(response.wikiChanged).toEqual([
      { path: "wiki/entities/a.md", operation: "create", existedBefore: false, beforeText: "" },
    ])
  })

  it("blocks okf_import apply before writing when preview exceeds budget", async () => {
    okfImportMock.previewOkfImport.mockResolvedValueOnce({
      applied: false,
      pages: [
        { targetRelativePath: "wiki/entities/a.md", action: "write" },
        { targetRelativePath: "wiki/entities/b.md", action: "write" },
      ],
      issues: [],
      summary: { totalPages: 2, writeCount: 2, skippedCount: 0, issueCount: 0 },
    })

    const response = await runAgentAppTool(
      "okf_import",
      { sourceDir: "/source", apply: true },
      { budget: { maxFilesChanged: 1, maxFilesChangedEnabled: true, changedPaths: [] } },
    )

    expect(response.ok).toBe(false)
    if (response.ok) throw new Error("expected resource limit")
    expect(response.resourceLimit.changedPaths).toEqual([
      "wiki/entities/a.md",
      "wiki/entities/b.md",
    ])
    expect(okfImportMock.importOkfBundle).not.toHaveBeenCalled()
  })

  it("blocks okf_import apply before writing when preview content exceeds maxWriteBytes", async () => {
    okfImportMock.previewOkfImport.mockResolvedValueOnce({
      applied: false,
      pages: [
        { targetRelativePath: "wiki/entities/a.md", action: "write", content: "hello world" },
      ],
      issues: [],
      summary: { totalPages: 1, writeCount: 1, skippedCount: 0, issueCount: 0 },
    })

    const response = await runAgentAppTool(
      "okf_import",
      { sourceDir: "/source", apply: true },
      { budget: { maxFilesChanged: 1, maxWriteBytes: 5, changedPaths: [] } },
    )

    expect(response.ok).toBe(false)
    if (response.ok) throw new Error("expected resource limit")
    expect(response.resourceLimit.limitKind).toBe("max_write_bytes")
    expect(response.resourceLimit.path).toBe("wiki/entities/a.md")
    expect(response.resourceLimit.bytes).toBe(11)
    expect(okfImportMock.importOkfBundle).not.toHaveBeenCalled()
  })

  it("rejects invalid okf_import sourceDir", async () => {
    await expect(runAgentAppTool("okf_import", { sourceDir: " " })).rejects.toThrow("Missing sourceDir")
    await expect(runAgentAppTool("okf_import", { sourceDir: "source" })).rejects.toThrow("absolute path")
    await expect(runAgentAppTool("okf_import", { sourceDir: "/tmp/../source" })).rejects.toThrow("path traversal")
    await expect(runAgentAppTool("okf_import", { sourceDir: "/tmp/source\0bad" })).rejects.toThrow("NUL")
    expect(okfImportMock.previewOkfImport).not.toHaveBeenCalled()
  })

  it("previews taxonomy bootstrap and growth without writing", async () => {
    const bootstrap = await runAgentAppTool("taxonomy_preview", { action: "bootstrap" })
    const growth = await runAgentAppTool("taxonomy_preview", { action: "growth" })

    expect(bootstrap.result).toEqual({ action: "bootstrap", dryRun: true, wrote: false, removed: 0 })
    expect(growth.result).toEqual({ action: "growth", dryRun: true, wrote: false, removed: 0 })
    expect(tagTaxonomyMock.previewTagTaxonomyBootstrap).toHaveBeenCalledWith("/project")
    expect(tagTaxonomyMock.previewTagTaxonomyGrowth).toHaveBeenCalledWith("/project")
  })

  it("applies taxonomy changes with sidecar snapshot metadata", async () => {
    fsMock.files.set("/project/.llm-wiki/tag-taxonomy.json", "{\"nodes\":[]}")

    const response = await runAgentAppTool(
      "taxonomy_apply",
      { action: "growth" },
      { budget: { maxFilesChanged: 1, maxFilesChangedEnabled: true, changedPaths: [] } },
    )

    expect(response.ok).toBe(true)
    expect(tagTaxonomyMock.applyTagTaxonomyGrowth).toHaveBeenCalledWith("/project")
    expect(response.changedPaths).toEqual([".llm-wiki/tag-taxonomy.json"])
    expect(response.wikiChanged).toEqual([
      {
        path: ".llm-wiki/tag-taxonomy.json",
        operation: "update",
        existedBefore: true,
        beforeText: "{\"nodes\":[]}",
      },
    ])
  })

  it("blocks taxonomy_apply before sidecar write when budget is exhausted", async () => {
    const response = await runAgentAppTool(
      "taxonomy_apply",
      { action: "bootstrap" },
      { budget: { maxFilesChanged: 1, maxFilesChangedEnabled: true, changedPaths: [".llm-wiki/tag-taxonomy.json"] } },
    )

    expect(response.ok).toBe(true)
    expect(tagTaxonomyMock.applyTagTaxonomyBootstrap).toHaveBeenCalled()
  })

  it("blocks taxonomy_apply before sidecar write when budget would grow", async () => {
    const response = await runAgentAppTool(
      "taxonomy_apply",
      { action: "bootstrap" },
      { budget: { maxFilesChanged: 1, maxFilesChangedEnabled: true, changedPaths: ["wiki/existing.md"] } },
    )

    expect(response.ok).toBe(false)
    if (response.ok) throw new Error("expected resource limit")
    expect(response.resourceLimit.changedPaths).toEqual([
      ".llm-wiki/tag-taxonomy.json",
      "wiki/existing.md",
    ])
    expect(tagTaxonomyMock.applyTagTaxonomyBootstrap).not.toHaveBeenCalled()
  })

  it("lets enumerated app writes pass when maxFilesChanged enforcement is disabled", async () => {
    const response = await runAgentAppTool(
      "taxonomy_apply",
      { action: "bootstrap" },
      { budget: { maxFilesChanged: 1, maxFilesChangedEnabled: false, changedPaths: ["wiki/existing.md"] } },
    )

    expect(response.ok).toBe(true)
    expect(tagTaxonomyMock.applyTagTaxonomyBootstrap).toHaveBeenCalled()
    expect(response.changedPaths).toEqual([".llm-wiki/tag-taxonomy.json"])
  })

  it("rolls back taxonomy batches with nested update snapshot semantics", async () => {
    fsMock.files.set("/project/.llm-wiki/tag-taxonomy.json", "{\"history\":[1]}")

    const response = await runAgentAppTool(
      "taxonomy_rollback",
      {},
      { budget: { maxFilesChanged: 1, maxFilesChangedEnabled: true, changedPaths: [] } },
    )

    expect(response.ok).toBe(true)
    expect(tagTaxonomyMock.rollbackLastTagTaxonomyBatch).toHaveBeenCalledWith("/project")
    expect(response.changedPaths).toEqual([".llm-wiki/tag-taxonomy.json"])
    expect(response.wikiChanged).toEqual([
      {
        path: ".llm-wiki/tag-taxonomy.json",
        operation: "update",
        existedBefore: true,
        beforeText: "{\"history\":[1]}",
      },
    ])
  })

  it("keeps taxonomy_rollback changedPaths empty when no nodes were removed", async () => {
    tagTaxonomyMock.rollbackLastTagTaxonomyBatch.mockResolvedValueOnce({ action: "rollback", dryRun: false, wrote: true, removed: 0 })

    const response = await runAgentAppTool("taxonomy_rollback", {})

    expect(response.ok).toBe(true)
    expect(response.changedPaths).toEqual([])
    expect(response.wikiChanged).toEqual([
      {
        path: ".llm-wiki/tag-taxonomy.json",
        operation: "update",
        existedBefore: false,
        beforeText: "",
      },
    ])
  })

  it("previews synthesis candidates without calling generation", async () => {
    wikiSynthesisMock.discoverSynthesisCandidates.mockResolvedValueOnce({ candidates: [{ slug: "ai" }], totalCandidates: 1 })

    const response = await runAgentAppTool("synthesis_preview", {
      dimension: 2,
      targetTag: "ai",
      targetTags: ["ai", "systems"],
      minClusterSize: 4,
      maxCandidates: 8,
    })

    expect(response.result).toEqual({ candidates: [{ slug: "ai" }], totalCandidates: 1 })
    expect(wikiSynthesisMock.discoverSynthesisCandidates).toHaveBeenCalledWith("/project", {
      dimension: 2,
      targetTag: "ai",
      targetTags: ["ai", "systems"],
      minClusterSize: 4,
      maxCandidates: 8,
    })
    expect(wikiSynthesisMock.runWikiSynthesis).not.toHaveBeenCalled()
  })

  it("loads knowledge agents config read-only", async () => {
    const response = await runAgentAppTool("get_knowledge_agents_config", {})

    expect(response.ok).toBe(true)
    expect(knowledgeAgentsConfigMock.loadKnowledgeAgentsConfig).toHaveBeenCalledWith("/project")
    expect(response.result).toMatchObject({
      config: {
        schemaVersion: 2,
        updatedAt: 0,
        agents: expect.objectContaining({
          compiler: { enabled: false, autoRun: false, guidance: "" },
        }),
      },
      issues: [],
      conflict: false,
      optIn: true,
      agents: expect.objectContaining({
        compiler: { enabled: false, status: "opt-in-disabled" },
      }),
    })
  })

  it("marks enabled Knowledge Agents as enabled in the read-only config response", async () => {
    knowledgeAgentsConfigMock.loadKnowledgeAgentsConfig.mockResolvedValueOnce({
      config: {
        schemaVersion: 2,
        updatedAt: 1,
        agents: {
          compiler: { enabled: true, autoRun: false, guidance: "" },
          linter: { enabled: false, autoRun: false, guidance: "" },
          fixer: { enabled: false, autoRun: false, guidance: "" },
          synthesizer: { enabled: false, autoRun: false, guidance: "" },
          tagger: { enabled: false, autoRun: false, guidance: "" },
          "qa-saver": { enabled: false, autoRun: false, guidance: "" },
        },
      },
      issues: [],
      conflict: false,
    })

    const response = await runAgentAppTool("get_knowledge_agents_config", {})

    expect(response.result).toMatchObject({
      optIn: true,
      agents: expect.objectContaining({
        compiler: { enabled: true, status: "enabled" },
        linter: { enabled: false, status: "opt-in-disabled" },
      }),
    })
  })

  it("passes multi-dimensional synthesis options to wiki_synthesis", async () => {
    wikiSynthesisMock.runWikiSynthesis.mockImplementationOnce(async (...callArgs: unknown[]) => {
      const options = callArgs[3] as {
        onWikiChanged?: (change: { path: string; operation: "create"; existedBefore: boolean; beforeText: string }) => void
      } | undefined
      options?.onWikiChanged?.({
        path: "wiki/synthesis/test-synthesis.md",
        operation: "create",
        existedBefore: false,
        beforeText: "",
      })
      return {
        ok: true,
        topic: "test",
        clusterSize: 3,
        synthesisPath: "wiki/synthesis/test-synthesis.md",
        externalSources: 0,
      } as Awaited<ReturnType<typeof import("@/lib/wiki-synthesis").runWikiSynthesis>>
    })

    const response = await runAgentAppTool("wiki_synthesis", {
      dimension: 2,
      targetTags: ["ai", "systems"],
      targetTag: "ai",
      minClusterSize: 4,
      maxCandidates: 12,
    })

    expect(response.ok).toBe(true)
    expect(wikiSynthesisMock.runWikiSynthesis).toHaveBeenCalledWith(
      "/project",
      expect.objectContaining({ model: "gpt-test" }),
      expect.objectContaining({ provider: "none" }),
      {
        dimension: 2,
        targetTag: "ai",
        targetTags: ["ai", "systems"],
        minClusterSize: 4,
        maxCandidates: 12,
        onWikiChanged: expect.any(Function),
      },
    )
    expect(response.wikiChanged).toEqual([
      {
        path: "wiki/synthesis/test-synthesis.md",
        operation: "create",
        existedBefore: false,
        beforeText: "",
      },
    ])
  })

  it("throws wiki_synthesis errors returned by runWikiSynthesis", async () => {
    wikiSynthesisMock.runWikiSynthesis.mockResolvedValueOnce({ ok: false, error: "synthesis failed" })

    await expect(runAgentAppTool("wiki_synthesis", {})).rejects.toThrow("synthesis failed")
  })

  it("blocks wiki_synthesis before calling runWikiSynthesis when unknown-write budget is full", async () => {
    const response = await runAgentAppTool(
      "wiki_synthesis",
      {},
      { budget: { maxFilesChanged: 1, maxFilesChangedEnabled: true, changedPaths: ["wiki/existing.md"] } },
    )

    expect(response.ok).toBe(false)
    if (response.ok) throw new Error("expected resource limit")
    expect(response.resourceLimit.toolName).toBe("wiki_synthesis")
    expect(response.resourceLimit.attempted).toBe(2)
    expect(response.resourceLimit.changedPaths).toEqual(["wiki/existing.md"])
    expect(wikiSynthesisMock.runWikiSynthesis).not.toHaveBeenCalled()
  })

  it("lets unknown-write app tools start when maxFilesChanged enforcement is disabled", async () => {
    const response = await runAgentAppTool(
      "wiki_synthesis",
      {},
      { budget: { maxFilesChanged: 1, maxFilesChangedEnabled: false, changedPaths: ["wiki/existing.md"] } },
    )

    expect(response.ok).toBe(true)
    expect(wikiSynthesisMock.runWikiSynthesis).toHaveBeenCalled()
  })

  it("exposes OKF validate/export as read-only app tools", async () => {
    okfValidateMock.validateOkfBundle.mockResolvedValueOnce({ ok: true, errors: [], warnings: [], pages: [] })
    okfExportMock.buildOkfExportBundle.mockResolvedValueOnce({
      files: [{ relativePath: "wiki/entities/topic.md", content: "content" }],
      report: { validation: { ok: true, errors: [], warnings: [], pages: [] }, typeMappings: [] },
    })

    const validate = await runAgentAppTool("okf_validate", {})
    const exported = await runAgentAppTool("okf_export", {})

    expect(okfValidateMock.validateOkfBundle).toHaveBeenCalledWith("/project")
    expect(okfExportMock.buildOkfExportBundle).toHaveBeenCalledWith("/project")
    expect(validate.result).toEqual({ ok: true, errors: [], warnings: [], pages: [] })
    expect(exported.result).toEqual({
      files: [{ relativePath: "wiki/entities/topic.md", content: "content" }],
      report: { validation: { ok: true, errors: [], warnings: [], pages: [] }, typeMappings: [] },
    })
    expect(validate.wikiChanged).toBeUndefined()
    expect(exported.wikiChanged).toBeUndefined()
  })

  it("previews OKF import by default without writing", async () => {
    okfImportMock.previewOkfImport.mockResolvedValueOnce({
      applied: false,
      pages: [{ action: "write", targetRelativePath: "wiki/entities/topic.md" }],
      issues: [],
      summary: { totalPages: 1, writeCount: 1, skippedCount: 0, issueCount: 0 },
    })

    const response = await runAgentAppTool("okf_import", { sourceDir: "/source-okf" })

    expect(okfImportMock.previewOkfImport).toHaveBeenCalledWith("/source-okf", "/project")
    expect(okfImportMock.importOkfBundle).not.toHaveBeenCalled()
    expect(response.wikiChanged).toEqual([])
    expect(response.result).toMatchObject({ applied: false, summary: { writeCount: 1 } })
  })

  it("blocks OKF import apply before writing when planned pages exceed budget", async () => {
    okfImportMock.previewOkfImport.mockResolvedValueOnce({
      applied: false,
      pages: [
        { action: "write", targetRelativePath: "wiki/entities/a.md" },
        { action: "write", targetRelativePath: "wiki/entities/b.md" },
        { action: "skip", targetRelativePath: "wiki/entities/c.md" },
      ],
      issues: [],
      summary: { totalPages: 3, writeCount: 2, skippedCount: 1, issueCount: 0 },
    })

    const response = await runAgentAppTool(
      "okf_import",
      { sourceDir: "/source-okf", apply: true },
      { budget: { maxFilesChanged: 1, maxFilesChangedEnabled: true, changedPaths: [] } },
    )

    expect(response.ok).toBe(false)
    if (response.ok) throw new Error("expected resource limit")
    expect(response.resourceLimit.changedPaths).toEqual([
      "wiki/entities/a.md",
      "wiki/entities/b.md",
    ])
    expect(okfImportMock.importOkfBundle).not.toHaveBeenCalled()
  })

  it("applies OKF import through the existing importer and reports wiki page changes", async () => {
    okfImportMock.previewOkfImport.mockResolvedValueOnce({
      applied: false,
      pages: [{ action: "write", targetRelativePath: "wiki/entities/topic.md" }],
      issues: [],
      summary: { totalPages: 1, writeCount: 1, skippedCount: 0, issueCount: 0 },
    })
    okfImportMock.importOkfBundle.mockImplementationOnce(async (...callArgs: unknown[]) => {
      const options = callArgs[2] as {
        apply?: boolean
        onWikiChanged?: (change: { path: string; operation: "create"; existedBefore: boolean; beforeText: string }) => void
      } | undefined
      options?.onWikiChanged?.({
        path: "wiki/entities/topic.md",
        operation: "create",
        existedBefore: false,
        beforeText: "",
      })
      return {
        applied: true,
        pages: [
          { action: "write" as const, targetRelativePath: "wiki/entities/topic.md" },
          { action: "skip" as const, targetRelativePath: "wiki/entities/same.md" },
        ],
        issues: [],
        summary: { totalPages: 2, writeCount: 1, skippedCount: 1, issueCount: 0 },
      }
    })

    const response = await runAgentAppTool(
      "okf_import",
      { sourceDir: "/source-okf", apply: true },
      { budget: { maxFilesChanged: 1, maxFilesChangedEnabled: true, changedPaths: [] } },
    )

    expect(okfImportMock.importOkfBundle).toHaveBeenCalledWith("/source-okf", "/project", {
      apply: true,
      onWikiChanged: expect.any(Function),
    })
    expect(response.wikiChanged).toEqual([
      { path: "wiki/entities/topic.md", operation: "create", existedBefore: false, beforeText: "" },
    ])
    expect(useWikiStore.getState().fileTree).toEqual(fsMock.tree)
    expect(useWikiStore.getState().dataVersion).toBe(1)
  })

  it("previews and applies taxonomy sidecar changes with wikiChanged", async () => {
    fsMock.files.set("/project/.llm-wiki/tag-taxonomy.json", "{\"before\":true}")

    const preview = await runAgentAppTool("taxonomy_preview", { action: "growth" })
    const apply = await runAgentAppTool(
      "taxonomy_apply",
      { action: "bootstrap" },
      { budget: { maxFilesChanged: 1, maxFilesChangedEnabled: true, changedPaths: [] } },
    )
    const rollback = await runAgentAppTool(
      "taxonomy_rollback",
      {},
      { budget: { maxFilesChanged: 1, maxFilesChangedEnabled: true, changedPaths: [] } },
    )

    expect(tagTaxonomyMock.previewTagTaxonomyGrowth).toHaveBeenCalledWith("/project")
    expect(preview.result).toMatchObject({ action: "growth", dryRun: true })
    expect(tagTaxonomyMock.applyTagTaxonomyBootstrap).toHaveBeenCalledWith("/project")
    expect(apply.changedPaths).toEqual([".llm-wiki/tag-taxonomy.json"])
    expect(apply.wikiChanged).toEqual([
      {
        path: ".llm-wiki/tag-taxonomy.json",
        operation: "update",
        existedBefore: true,
        beforeText: "{\"before\":true}",
      },
    ])
    expect(tagTaxonomyMock.rollbackLastTagTaxonomyBatch).toHaveBeenCalledWith("/project")
    expect(rollback.changedPaths).toEqual([".llm-wiki/tag-taxonomy.json"])
    expect(rollback.wikiChanged).toEqual([
      {
        path: ".llm-wiki/tag-taxonomy.json",
        operation: "update",
        existedBefore: true,
        beforeText: "{\"before\":true}",
      },
    ])
  })

  it("blocks taxonomy sidecar writes through the app budget", async () => {
    const response = await runAgentAppTool(
      "taxonomy_apply",
      { action: "growth" },
      { budget: { maxFilesChanged: 0, maxFilesChangedEnabled: true, changedPaths: [] } },
    )

    expect(response.ok).toBe(false)
    if (response.ok) throw new Error("expected resource limit")
    expect(response.resourceLimit.changedPaths).toEqual([".llm-wiki/tag-taxonomy.json"])
    expect(tagTaxonomyMock.applyTagTaxonomyGrowth).not.toHaveBeenCalled()
  })

  it("exposes synthesis_preview and Knowledge Agents config as read-only app tools", async () => {
    const synthesis = await runAgentAppTool("synthesis_preview", {
      dimension: 3,
      targetTags: ["ai", "infra"],
      minClusterSize: 4,
      maxCandidates: 9,
    })
    const config = await runAgentAppTool("get_knowledge_agents_config", {})

    expect(wikiSynthesisMock.discoverSynthesisCandidates).toHaveBeenCalledWith("/project", {
      dimension: 3,
      targetTags: ["ai", "infra"],
      minClusterSize: 4,
      maxCandidates: 9,
    })
    expect(synthesis.result).toMatchObject({ candidates: [], totalCandidates: 0 })
    expect(knowledgeAgentsConfigMock.loadKnowledgeAgentsConfig).toHaveBeenCalledWith("/project")
    expect(config.result).toMatchObject({ conflict: false, issues: [] })
  })

  it("rejects invalid unified exposure arguments", async () => {
    await expect(runAgentAppTool("taxonomy_preview", { action: "delete" })).rejects.toThrow(/bootstrap or growth/)
    await expect(runAgentAppTool("synthesis_preview", { dimension: 5 })).rejects.toThrow(/dimension/)
  })

  it("blocks duplicate merge before executeMerge when preview exceeds budget", async () => {
    dedupRunnerMock.loadAllWikiPages.mockResolvedValue([
      { path: "wiki/entities/a.md", content: "---\ntitle: A\n---\nA" },
      { path: "wiki/entities/b.md", content: "---\ntitle: B\n---\nB" },
      { path: "wiki/index.md", content: "- [[a]]\n- [[b]]" },
    ])
    dedupMock.mergeDuplicateGroup.mockResolvedValue({
      canonicalPath: "wiki/entities/a.md",
      canonicalContent: "Merged",
      rewrites: [{ path: "wiki/index.md", newContent: "- [[a]]" }],
      pagesToDelete: ["wiki/entities/b.md"],
      backup: [],
    })

    const response = await runAgentAppTool(
      "merge_duplicate_group",
      { slugs: ["a", "b"], canonicalSlug: "a", dryRun: false },
      { budget: { maxFilesChanged: 1, maxFilesChangedEnabled: true, changedPaths: [] } },
    )

    expect(response.ok).toBe(false)
    if (response.ok) throw new Error("expected resource limit")
    expect(response.resourceLimit.changedPaths).toEqual([
      "wiki/entities/a.md",
      "wiki/entities/b.md",
      "wiki/index.md",
    ])
    expect(dedupRunnerMock.executeMerge).not.toHaveBeenCalled()
  })

  it("returns post-flight resource limit for ingest_source after unknown batch writes exceed budget", async () => {
    ingestMock.autoIngest.mockImplementationOnce(async (
      _projectPath: string,
      _sourcePath: string,
      _llmConfig: unknown,
      _signal: unknown,
      _folderContext: unknown,
      onPageWritten?: (record: { path: string; wasCreated: boolean; previousContent: string | null }) => void,
    ) => {
      onPageWritten?.({ path: "wiki/sources/source.md", wasCreated: false, previousContent: "old source" })
      onPageWritten?.({ path: "wiki/entities/topic.md", wasCreated: true, previousContent: null })
      return ["wiki/sources/source.md", "wiki/entities/topic.md"]
    })

    const response = await runAgentAppTool(
      "ingest_source",
      { sourcePath: "source.pdf" },
      { budget: { maxFilesChanged: 1, maxFilesChangedEnabled: true, changedPaths: [] } },
    )

    expect(response.ok).toBe(false)
    if (response.ok) throw new Error("expected resource limit")
    expect(response.wikiChanged).toEqual([
      {
        path: "wiki/sources/source.md",
        operation: "update",
        existedBefore: true,
        beforeText: "old source",
      },
      {
        path: "wiki/entities/topic.md",
        operation: "create",
        existedBefore: false,
        beforeText: "",
      },
    ])
    expect(response.resourceLimit.message).toMatch(/exceeded maxFilesChanged/)
    expect(response.resourceLimit.attempted).toBe(2)
  })

  it("lets post-flight writes pass when maxFilesChanged enforcement is disabled", async () => {
    ingestMock.autoIngest.mockImplementationOnce(async (
      _projectPath: string,
      _sourcePath: string,
      _llmConfig: unknown,
      _signal: unknown,
      _folderContext: unknown,
      onPageWritten?: (record: { path: string; wasCreated: boolean; previousContent: string | null }) => void,
    ) => {
      onPageWritten?.({ path: "wiki/sources/source.md", wasCreated: false, previousContent: "old source" })
      onPageWritten?.({ path: "wiki/entities/topic.md", wasCreated: true, previousContent: null })
      return ["wiki/sources/source.md", "wiki/entities/topic.md"]
    })

    const response = await runAgentAppTool(
      "ingest_source",
      { sourcePath: "source.pdf" },
      { budget: { maxFilesChanged: 1, maxFilesChangedEnabled: false, changedPaths: [] } },
    )

    expect(response.ok).toBe(true)
    expect(response.wikiChanged).toEqual([
      {
        path: "wiki/sources/source.md",
        operation: "update",
        existedBefore: true,
        beforeText: "old source",
      },
      {
        path: "wiki/entities/topic.md",
        operation: "create",
        existedBefore: false,
        beforeText: "",
      },
    ])
    expect("resourceLimit" in response ? response.resourceLimit : undefined).toBeUndefined()
  })

  it("shares pipeline budget across internal steps and returns the blocking resource limit", async () => {
    ingestMock.autoIngest.mockImplementationOnce(async (
      _projectPath: string,
      _sourcePath: string,
      _llmConfig: unknown,
      _signal: unknown,
      _folderContext: unknown,
      onPageWritten?: (record: { path: string; wasCreated: boolean; previousContent: string | null }) => void,
    ) => {
      onPageWritten?.({ path: "wiki/sources/source.md", wasCreated: false, previousContent: "old source" })
      return ["wiki/sources/source.md"]
    })
    pipelineMock.executePipeline.mockImplementationOnce(async (
      _schema: unknown,
      runner?: (toolName: string, args: Record<string, unknown>) => Promise<{
        ok: boolean
        changedPaths?: string[]
        wikiChanged?: Array<{ path: string; operation: "create" | "update" | "delete" }>
        resourceLimit?: unknown
      }>,
    ) => {
      if (!runner) throw new Error("missing runner")
      const first = await runner("ingest_source", { sourcePath: "source.pdf" })
      const second = await runner("fix_lint_result", {
        result: { type: "orphan", severity: "info", page: "entities/topic.md", detail: "topic" },
      })
      return {
        pipelineName: "full-ingest",
        ok: false,
        steps: [],
        totalDurationMs: 0,
        changedPaths: [
          ...(first.changedPaths ?? []),
          ...(second.changedPaths ?? []),
        ],
        wikiChanged: [
          ...(first.wikiChanged ?? []),
          ...(second.wikiChanged ?? []),
        ],
        resourceLimit: second.resourceLimit,
      }
    })

    const response = await runAgentAppTool(
      "run_pipeline",
      { pipeline: "full-ingest" },
      { budget: { maxFilesChanged: 1, maxFilesChangedEnabled: true, changedPaths: [] } },
    )

    expect(response.ok).toBe(false)
    if (response.ok) throw new Error("expected resource limit")
    expect(response.resourceLimit.toolName).toBe("fix_lint_result")
    expect(response.resourceLimit.changedPaths).toEqual([
      "wiki/entities/topic.md",
      "wiki/sources/source.md",
    ])
  })

  it("shares maxWriteBytes budget across pipeline steps", async () => {
    okfImportMock.previewOkfImport.mockResolvedValueOnce({
      applied: false,
      pages: [
        { action: "write", targetRelativePath: "wiki/entities/topic.md", content: "hello world" },
      ],
      issues: [],
      summary: { totalPages: 1, writeCount: 1, skippedCount: 0, issueCount: 0 },
    })
    pipelineMock.executePipeline.mockImplementationOnce(async (
      _schema: unknown,
      runner?: (toolName: string, args: Record<string, unknown>) => Promise<{
        ok: boolean
        changedPaths?: string[]
        wikiChanged?: Array<{ path: string; operation: "create" | "update" | "delete" }>
        resourceLimit?: unknown
      }>,
    ) => {
      if (!runner) throw new Error("missing runner")
      const step = await runner("okf_import", { sourceDir: "/source-okf", apply: true })
      return {
        pipelineName: "full-ingest",
        ok: false,
        steps: [],
        totalDurationMs: 0,
        changedPaths: step.changedPaths ?? [],
        wikiChanged: step.wikiChanged ?? [],
        resourceLimit: step.resourceLimit,
      }
    })

    const response = await runAgentAppTool(
      "run_pipeline",
      { pipeline: "full-ingest" },
      { budget: { maxFilesChanged: 2, maxWriteBytes: 5, changedPaths: [] } },
    )

    expect(response.ok).toBe(false)
    if (response.ok) throw new Error("expected resource limit")
    expect(response.resourceLimit.limitKind).toBe("max_write_bytes")
    expect(response.resourceLimit.path).toBe("wiki/entities/topic.md")
    expect(okfImportMock.importOkfBundle).not.toHaveBeenCalled()
  })

  it("tests provider connection and redacts configured secrets", async () => {
    useWikiStore.setState({
      llmConfig: {
        ...useWikiStore.getState().llmConfig,
        apiKey: "llm-secret",
      },
      mineruConfig: {
        ...useWikiStore.getState().mineruConfig,
        token: "mineru-secret",
      },
    })
    connectionTestsMock.testLlmConnection.mockResolvedValue({
      ok: false,
      message: "provider rejected llm-secret and mineru-secret",
    })

    const response = await runAgentAppTool("test_provider_connection", {})

    expect(connectionTestsMock.testLlmConnection).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: "llm-secret" }),
    )
    expect(response.result).toEqual({
      ok: false,
      message: "provider rejected REDACTED and REDACTED",
    })
  })
})
