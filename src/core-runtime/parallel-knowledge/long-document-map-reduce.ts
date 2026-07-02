import { fnv1a64Hex } from "../stable-hash"

export const BULK_KNOWLEDGE_MAP_REDUCE_REPAIR_JOB_KIND =
  "bulk-knowledge-map-reduce-repair"
export const LONG_DOCUMENT_MAP_REDUCE_PLAN_KIND =
  "bulk-knowledge-long-document-map-reduce-plan"
export const LONG_DOCUMENT_MAP_REDUCE_RESULT_KIND =
  "bulk-knowledge-long-document-map-reduce-result"

export const LONG_SOURCE_CHUNK_MIN = 12_000
export const LONG_SOURCE_CHUNK_MAX = 60_000
export const LONG_SOURCE_DIGEST_MAX = 15_000
export const LONG_SOURCE_CHUNK_ANALYSIS_MAX = 40_000
const LONG_SOURCE_REPAIR_ERROR_FALLBACK = "map-chunk-failed"
const LONG_SOURCE_REPAIR_HEADING_PATH = ""
const LONG_SOURCE_REPAIR_ERROR_CODES = new Set([
  LONG_SOURCE_REPAIR_ERROR_FALLBACK,
  "failed",
  "low-confidence",
  "map-analysis-empty",
  "map-result-missing",
  "map-timeout",
  "provider-error",
])

export interface SourceChunk {
  readonly id: string
  readonly index: number
  readonly total: number
  readonly headingPath: string
  readonly overlapBefore: string
  readonly main: string
}

export interface LongDocumentMapReduceInput {
  readonly sourcePath: string
  readonly sourceIdentity?: string
  readonly content: string
  readonly sourceBudget: number
  readonly targetChars?: number
  readonly overlapChars?: number
}

export interface LongDocumentMapReducePlan {
  readonly kind: typeof LONG_DOCUMENT_MAP_REDUCE_PLAN_KIND
  readonly sourcePath: string
  readonly sourceIdentity: string
  readonly sourceHash: string
  readonly sourceLength: number
  readonly sourceBudget: number
  readonly targetChars: number
  readonly overlapChars: number
  readonly chunked: boolean
  readonly chunks: readonly SourceChunk[]
}

export type LongDocumentMapResultStatus = "success" | "failed" | "low-confidence"

export interface LongDocumentMapResult {
  readonly chunkId: string
  readonly status: LongDocumentMapResultStatus
  readonly analysis?: string
  readonly digest?: string
  readonly error?: string
  readonly confidence?: number
}

export type LongDocumentReduceStatus = "complete" | "partial" | "failed"
export type LongDocumentCommitPolicy = "committable" | "repair-only"
export type LongDocumentChunkFailureStatus =
  | "failed"
  | "low-confidence"
  | "missing"

export interface LongDocumentChunkFailure {
  readonly chunkId: string
  readonly chunkIndex: number
  readonly chunkTotal: number
  readonly headingPath: string
  readonly chunkHash: string
  readonly status: LongDocumentChunkFailureStatus
  readonly error: string
}

export interface BulkKnowledgeMapReduceRepairJobPayload {
  readonly kind: typeof BULK_KNOWLEDGE_MAP_REDUCE_REPAIR_JOB_KIND
  readonly jobId?: string
  readonly sourceJobKind?: string
  readonly sourcePath: string
  readonly sourceIdentity: string
  readonly sourceHash: string
  readonly chunkId: string
  readonly chunkIndex: number
  readonly chunkTotal: number
  readonly chunkHash: string
  readonly headingPath: string
  readonly status: LongDocumentChunkFailureStatus
  readonly error: string
  readonly owner: "bulk-map-reduce"
  readonly strategy: "reanalyze-chunk"
}

export interface LongDocumentReduceResult {
  readonly kind: typeof LONG_DOCUMENT_MAP_REDUCE_RESULT_KIND
  readonly sourcePath: string
  readonly sourceIdentity: string
  readonly sourceHash: string
  readonly status: LongDocumentReduceStatus
  readonly commitPolicy: LongDocumentCommitPolicy
  readonly totalChunks: number
  readonly successfulChunkCount: number
  readonly failedChunkCount: number
  readonly lowConfidenceChunkCount: number
  readonly missingChunkCount: number
  readonly analysisMarkdown: string
  readonly sourceContext: string
  readonly failedChunks: readonly LongDocumentChunkFailure[]
  readonly repairJobs: readonly BulkKnowledgeMapReduceRepairJobPayload[]
}

export interface ReduceLongDocumentMapResultsOptions {
  readonly jobId?: string
  readonly sourceJobKind?: string
}

export function clampNumber(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

export function splitOversizedBlock(block: string, targetChars: number): string[] {
  if (block.length <= targetChars * 1.25) return [block]

  const pieces = block.match(/[^.!?。！？\n]+[.!?。！？]?|\n+/g) ?? [block]
  const out: string[] = []
  let current = ""
  for (const piece of pieces) {
    if (current && current.length + piece.length > targetChars) {
      out.push(current.trim())
      current = ""
    }
    if (piece.length > targetChars) {
      for (let i = 0; i < piece.length; i += targetChars) {
        const slice = piece.slice(i, i + targetChars).trim()
        if (slice) out.push(slice)
      }
    } else {
      current += piece
    }
  }
  if (current.trim()) out.push(current.trim())
  return out
}

export function semanticBlocks(
  content: string,
  targetChars: number,
): Array<{ text: string; headingPath: string }> {
  const blocks: Array<{ text: string; headingPath: string }> = []
  const headingStack: string[] = []
  let paragraph: string[] = []
  let paragraphHeading = ""

  const currentHeadingPath = () => headingStack.filter(Boolean).join(" > ")
  const flushParagraph = () => {
    const text = paragraph.join("\n").trim()
    if (text) {
      for (const piece of splitOversizedBlock(text, targetChars)) {
        blocks.push({ text: piece, headingPath: paragraphHeading })
      }
    }
    paragraph = []
  }

  for (const line of content.replace(/\r\n/g, "\n").split("\n")) {
    const heading = /^(#{1,6})\s+(.+?)\s*$/.exec(line)
    if (heading) {
      flushParagraph()
      const depth = heading[1].length
      headingStack.length = depth - 1
      headingStack[depth - 1] = heading[2].trim()
      blocks.push({ text: line.trim(), headingPath: currentHeadingPath() })
      paragraphHeading = currentHeadingPath()
      continue
    }

    if (line.trim() === "") {
      flushParagraph()
      paragraphHeading = currentHeadingPath()
      continue
    }

    if (paragraph.length === 0) paragraphHeading = currentHeadingPath()
    paragraph.push(line)
  }
  flushParagraph()

  return blocks
}

export function overlapSuffix(text: string, maxChars: number): string {
  if (!text || maxChars <= 0) return ""
  if (text.length <= maxChars) return text
  const raw = text.slice(-maxChars)
  const paragraphBreak = raw.search(/\n\s*\n/)
  if (paragraphBreak > 0 && raw.length - paragraphBreak > maxChars * 0.4) {
    return raw.slice(paragraphBreak).trim()
  }
  const sentenceBreak = raw.search(/[.!?。！？]\s+/)
  if (sentenceBreak > 0 && raw.length - sentenceBreak > maxChars * 0.4) {
    return raw.slice(sentenceBreak + 1).trim()
  }
  return raw.trim()
}

export function splitSourceIntoSemanticChunks(
  content: string,
  targetChars: number,
  overlapChars: number,
): SourceChunk[] {
  const target = Math.max(1_000, targetChars)
  const blocks = semanticBlocks(content, target)
  if (blocks.length === 0) return []

  const rawChunks: Array<{ main: string; headingPath: string }> = []
  let current: string[] = []
  let currentLength = 0
  let currentHeading = blocks[0]?.headingPath ?? ""

  const flush = () => {
    const main = current.join("\n\n").trim()
    if (main) rawChunks.push({ main, headingPath: currentHeading })
    current = []
    currentLength = 0
  }

  for (const block of blocks) {
    const nextLength = currentLength + block.text.length + (current.length > 0 ? 2 : 0)
    if (current.length > 0 && nextLength > target) {
      flush()
    }
    if (current.length === 0) currentHeading = block.headingPath
    current.push(block.text)
    currentLength += block.text.length + (current.length > 1 ? 2 : 0)
  }
  flush()

  return rawChunks.map((chunk, idx) => ({
    id: `chunk-${idx + 1}`,
    index: idx + 1,
    total: rawChunks.length,
    headingPath: chunk.headingPath,
    overlapBefore: idx > 0 ? overlapSuffix(rawChunks[idx - 1].main, overlapChars) : "",
    main: chunk.main,
  }))
}

export function hashTextHex(text: string): string {
  return fnv1a64Hex(text)
}

export function planLongDocumentMapReduce(
  input: LongDocumentMapReduceInput,
): LongDocumentMapReducePlan {
  const sourcePath = requireNonEmptyString(input.sourcePath, "sourcePath")
  const sourceIdentity = requireNonEmptyString(
    input.sourceIdentity ?? input.sourcePath,
    "sourceIdentity",
  )
  const sourceBudget = normalizePositiveInteger(input.sourceBudget, "sourceBudget")
  const targetChars = input.targetChars
    ? normalizePositiveInteger(input.targetChars, "targetChars")
    : clampNumber(Math.floor(sourceBudget * 0.55), LONG_SOURCE_CHUNK_MIN, LONG_SOURCE_CHUNK_MAX)
  const overlapChars = input.overlapChars
    ? normalizePositiveInteger(input.overlapChars, "overlapChars")
    : clampNumber(Math.floor(targetChars * 0.08), 800, 3_000)
  const chunks = splitSourceIntoSemanticChunks(input.content, targetChars, overlapChars)

  return {
    kind: LONG_DOCUMENT_MAP_REDUCE_PLAN_KIND,
    sourcePath,
    sourceIdentity,
    sourceHash: hashTextHex(input.content),
    sourceLength: input.content.length,
    sourceBudget,
    targetChars,
    overlapChars,
    chunked: chunks.length > 1,
    chunks,
  }
}

export function reduceLongDocumentMapResults(
  plan: LongDocumentMapReducePlan,
  rawResults: readonly LongDocumentMapResult[],
  options: ReduceLongDocumentMapResultsOptions = {},
): LongDocumentReduceResult {
  const results = indexMapResults(rawResults)
  const analyses: string[] = []
  const digests: string[] = []
  const failures: LongDocumentChunkFailure[] = []
  let successfulChunkCount = 0
  let failedChunkCount = 0
  let lowConfidenceChunkCount = 0
  let missingChunkCount = 0

  for (const chunk of plan.chunks) {
    const result = results.get(chunk.id)
    if (!result) {
      missingChunkCount += 1
      failures.push(buildChunkFailure(plan, chunk, "missing", "map-result-missing"))
      continue
    }
    if (result.status === "success") {
      const analysis = result.analysis?.trim()
      if (!analysis) {
        failedChunkCount += 1
        failures.push(buildChunkFailure(plan, chunk, "failed", "map-analysis-empty"))
        continue
      }
      successfulChunkCount += 1
      analyses.push(formatChunkAnalysis(chunk, analysis))
      if (result.digest?.trim()) digests.push(result.digest.trim())
      continue
    }

    if (result.status === "low-confidence") {
      lowConfidenceChunkCount += 1
    } else {
      failedChunkCount += 1
    }
    failures.push(buildChunkFailure(
      plan,
      chunk,
      result.status,
      result.error ?? result.status,
    ))
  }

  const status = resolveReduceStatus(plan.chunks.length, successfulChunkCount, failures.length)
  const finalDigest = trimLongText(digests[digests.length - 1] ?? analyses.join("\n\n"), LONG_SOURCE_DIGEST_MAX)
  const repairJobs = failures.map((failure) =>
    buildRepairPayload(plan, failure, options),
  )

  return {
    kind: LONG_DOCUMENT_MAP_REDUCE_RESULT_KIND,
    sourcePath: plan.sourcePath,
    sourceIdentity: plan.sourceIdentity,
    sourceHash: plan.sourceHash,
    status,
    commitPolicy: status === "complete" ? "committable" : "repair-only",
    totalChunks: plan.chunks.length,
    successfulChunkCount,
    failedChunkCount,
    lowConfidenceChunkCount,
    missingChunkCount,
    analysisMarkdown: buildAnalysisMarkdown(status, finalDigest, analyses, failures),
    sourceContext: buildSourceContext(plan, status, finalDigest, analyses, failures),
    failedChunks: failures,
    repairJobs,
  }
}

function indexMapResults(
  rawResults: readonly LongDocumentMapResult[],
): Map<string, LongDocumentMapResult> {
  const results = new Map<string, LongDocumentMapResult>()
  for (const result of rawResults) {
    const chunkId = requireNonEmptyString(result.chunkId, "chunkId")
    if (results.has(chunkId)) {
      throw new Error(`long-document-map-result-duplicate: ${chunkId}`)
    }
    results.set(chunkId, result)
  }
  return results
}

function buildChunkFailure(
  plan: LongDocumentMapReducePlan,
  chunk: SourceChunk,
  status: LongDocumentChunkFailureStatus,
  error: string,
): LongDocumentChunkFailure {
  return {
    chunkId: chunk.id,
    chunkIndex: chunk.index,
    chunkTotal: chunk.total,
    headingPath: chunk.headingPath,
    chunkHash: hashTextHex(`${plan.sourceHash}\n${chunk.id}\n${chunk.main}`),
    status,
    error: sanitizeRepairError(error),
  }
}

function buildRepairPayload(
  plan: LongDocumentMapReducePlan,
  failure: LongDocumentChunkFailure,
  options: ReduceLongDocumentMapResultsOptions,
): BulkKnowledgeMapReduceRepairJobPayload {
  return {
    kind: BULK_KNOWLEDGE_MAP_REDUCE_REPAIR_JOB_KIND,
    ...(options.jobId ? { jobId: options.jobId } : {}),
    ...(options.sourceJobKind ? { sourceJobKind: options.sourceJobKind } : {}),
    sourcePath: plan.sourcePath,
    sourceIdentity: plan.sourceIdentity,
    sourceHash: plan.sourceHash,
    chunkId: failure.chunkId,
    chunkIndex: failure.chunkIndex,
    chunkTotal: failure.chunkTotal,
    chunkHash: failure.chunkHash,
    headingPath: LONG_SOURCE_REPAIR_HEADING_PATH,
    status: failure.status,
    error: failure.error,
    owner: "bulk-map-reduce",
    strategy: "reanalyze-chunk",
  }
}

function formatChunkAnalysis(chunk: SourceChunk, analysis: string): string {
  return [
    `## Chunk ${chunk.index}/${chunk.total}${chunk.headingPath ? ` - ${chunk.headingPath}` : ""}`,
    trimLongText(analysis, LONG_SOURCE_CHUNK_ANALYSIS_MAX),
  ].join("\n")
}

function resolveReduceStatus(
  totalChunks: number,
  successfulChunkCount: number,
  failureCount: number,
): LongDocumentReduceStatus {
  if (failureCount === 0 && successfulChunkCount === totalChunks) return "complete"
  if (successfulChunkCount > 0) return "partial"
  return "failed"
}

function buildAnalysisMarkdown(
  status: LongDocumentReduceStatus,
  finalDigest: string,
  analyses: readonly string[],
  failures: readonly LongDocumentChunkFailure[],
): string {
  return [
    "# Consolidated Long-Document Analysis",
    "",
    "## Reduce Status",
    `Status: ${status}`,
    `Successful chunks: ${analyses.length}`,
    `Repair chunks: ${failures.length}`,
    "",
    "## Final Global Digest",
    finalDigest || "(No digest produced.)",
    "",
    "## Per-Chunk Analyses",
    analyses.length > 0 ? analyses.join("\n\n") : "(No chunk analysis succeeded.)",
    failures.length > 0 ? "\n## Chunks Requiring Repair\n" + formatFailures(failures) : "",
  ].filter(Boolean).join("\n")
}

function buildSourceContext(
  plan: LongDocumentMapReducePlan,
  status: LongDocumentReduceStatus,
  finalDigest: string,
  analyses: readonly string[],
  failures: readonly LongDocumentChunkFailure[],
): string {
  return [
    `# Long Source Context: ${plan.sourceIdentity}`,
    "",
    `The original source was analyzed with map-reduce status '${status}'.`,
    `Chunks: ${plan.chunks.length}; successful: ${analyses.length}; repair: ${failures.length}.`,
    "",
    "## Final Global Digest",
    finalDigest || "(No digest produced.)",
    "",
    "## Chunk Analysis Notes",
    trimLongText(analyses.join("\n\n"), Math.max(plan.sourceBudget, LONG_SOURCE_CHUNK_ANALYSIS_MAX)),
    failures.length > 0 ? "\n## Chunks Requiring Repair\n" + formatFailures(failures) : "",
  ].filter(Boolean).join("\n")
}

function formatFailures(failures: readonly LongDocumentChunkFailure[]): string {
  return failures
    .map((failure) =>
      `- ${failure.chunkId} (${failure.status}): ${failure.error}`,
    )
    .join("\n")
}

function trimLongText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  return text.slice(0, maxChars).trimEnd() + "\n...[truncated]"
}

function sanitizeRepairError(error: string): string {
  const code = error.split(":", 1)[0]?.trim()
  if (code && LONG_SOURCE_REPAIR_ERROR_CODES.has(code)) return code
  return LONG_SOURCE_REPAIR_ERROR_FALLBACK
}

function requireNonEmptyString(raw: string, field: string): string {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    throw new Error(`long-document-${field}-invalid`)
  }
  return raw.trim()
}

function normalizePositiveInteger(raw: number, field: string): number {
  if (!Number.isInteger(raw) || raw < 1) {
    throw new Error(`long-document-${field}-invalid`)
  }
  return raw
}
