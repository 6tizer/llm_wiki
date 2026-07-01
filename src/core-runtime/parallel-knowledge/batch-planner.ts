export const DEFAULT_BULK_PREPARE_BATCH_SIZE = 10
export const BULK_KNOWLEDGE_PREPARE_JOB_KIND = "bulk-knowledge-prepare"

export interface BulkKnowledgeSourceInput {
  readonly sourcePath: string
}

export interface BulkKnowledgePlannerOptions {
  readonly batchSize?: number
}

export interface BulkKnowledgePlannedSource {
  readonly sourcePath: string
  readonly sourceIdentity: string
  readonly duplicateCount: number
}

export interface BulkKnowledgePrepareJobPayload {
  readonly kind: typeof BULK_KNOWLEDGE_PREPARE_JOB_KIND
  readonly batchIndex: number
  readonly sources: readonly BulkKnowledgePlannedSource[]
}

export interface BulkKnowledgePrepareJobSpec {
  readonly jobKey: string
  readonly kind: typeof BULK_KNOWLEDGE_PREPARE_JOB_KIND
  readonly batchIndex: number
  readonly sourceCount: number
  readonly payload: BulkKnowledgePrepareJobPayload
}

export interface BulkKnowledgePreparePlan {
  readonly kind: "bulk-knowledge-prepare-plan"
  readonly batchSize: number
  readonly sourceCount: number
  readonly uniqueSourceCount: number
  readonly duplicateSourceCount: number
  readonly jobs: readonly BulkKnowledgePrepareJobSpec[]
}

/** Builds a deterministic batched prepare plan without touching runtime storage. */
export function planBulkKnowledgePrepare(
  sources: readonly BulkKnowledgeSourceInput[],
  options: BulkKnowledgePlannerOptions = {},
): BulkKnowledgePreparePlan {
  const batchSize = normalizeBatchSize(options.batchSize)
  const plannedSources = collectUniqueSources(sources)
  const uniqueSources = plannedSources
    .sort((left, right) => compareCodeUnits(left.sourceIdentity, right.sourceIdentity))
  const jobs = chunkSources(uniqueSources, batchSize).map((batch, batchIndex) =>
    buildPrepareJob(batch, batchIndex),
  )

  return {
    kind: "bulk-knowledge-prepare-plan",
    batchSize,
    sourceCount: sources.length,
    uniqueSourceCount: uniqueSources.length,
    duplicateSourceCount: uniqueSources.reduce(
      (total, source) => total + source.duplicateCount,
      0,
    ),
    jobs,
  }
}

/** Canonicalizes source paths for stable planner identity and dedupe. */
export function canonicalizeBulkKnowledgeSourcePath(sourcePath: string): string {
  const normalized = sourcePath
    .trim()
    .replace(/\\/g, "/")
    .replace(/\/+/g, "/")
    .replace(/^(?:\.\/)+/, "")
    .replace(/\/$/, "")

  if (normalized.length === 0) {
    throw new Error("bulk-knowledge-source-path-empty")
  }

  return normalized
}

function collectUniqueSources(
  sources: readonly BulkKnowledgeSourceInput[],
): BulkKnowledgePlannedSource[] {
  const byIdentity = new Map<string, BulkKnowledgePlannedSource>()

  for (const source of sources) {
    const sourceIdentity = canonicalizeBulkKnowledgeSourcePath(source.sourcePath)
    const existing = byIdentity.get(sourceIdentity)
    if (existing) {
      byIdentity.set(sourceIdentity, {
        ...existing,
        duplicateCount: existing.duplicateCount + 1,
      })
      continue
    }

    byIdentity.set(sourceIdentity, {
      sourcePath: sourceIdentity,
      sourceIdentity,
      duplicateCount: 0,
    })
  }

  return [...byIdentity.values()]
}

function normalizeBatchSize(batchSize = DEFAULT_BULK_PREPARE_BATCH_SIZE): number {
  if (!Number.isInteger(batchSize) || batchSize < 1) {
    throw new Error("bulk-knowledge-batch-size-invalid")
  }
  return batchSize
}

function chunkSources(
  sources: readonly BulkKnowledgePlannedSource[],
  batchSize: number,
): BulkKnowledgePlannedSource[][] {
  const chunks: BulkKnowledgePlannedSource[][] = []
  for (let index = 0; index < sources.length; index += batchSize) {
    chunks.push(sources.slice(index, index + batchSize))
  }
  return chunks
}

function buildPrepareJob(
  sources: readonly BulkKnowledgePlannedSource[],
  batchIndex: number,
): BulkKnowledgePrepareJobSpec {
  const jobKey = `bulk-prepare-${batchIndex + 1}-${stableHash(
    sources.map((source) => source.sourceIdentity).join("\n"),
  )}`
  const payload = {
    kind: BULK_KNOWLEDGE_PREPARE_JOB_KIND,
    batchIndex,
    sources,
  } satisfies BulkKnowledgePrepareJobPayload

  return {
    jobKey,
    kind: payload.kind,
    batchIndex: payload.batchIndex,
    sourceCount: payload.sources.length,
    payload,
  }
}

function stableHash(value: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, "0")
}

function compareCodeUnits(left: string, right: string): number {
  if (left < right) {
    return -1
  }
  if (left > right) {
    return 1
  }
  return 0
}
