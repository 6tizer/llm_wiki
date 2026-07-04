import {
  MARKDOWN_COMMIT_OPERATION_INTENTS,
  type DerivedStaleMarkerLayer,
  type DerivedStaleMarkerReason,
  type MarkdownCommitOperationIntent,
} from "@/core-runtime/contract"
import {
  commitMarkdownArtifact,
  hashMarkdownContent,
  type MarkdownCommitArtifact,
  type MarkdownCommitAuditPayload,
  type MarkdownCommitBudgetClaimReceipt,
  type MarkdownCommitConflictRepairContext,
  type MarkdownCommitOperationResult,
} from "@/core-runtime/markdown-commit"
import { normalizeCommitTargetPath } from "@/core-runtime/parallel-knowledge"
import { fnv1a64Hex } from "@/core-runtime/stable-hash"
import {
  deleteFile,
  fileExists,
  readFile,
  writeFileAtomic,
} from "@/commands/fs"
import { routeMarkdownConflictRepair } from "@/commands/markdown-commit-repair"
import {
  runtimeCommitBudgetClaim,
  runtimeCommitBudgetRelease,
  runtimeDerivedStaleMarkerRecord,
  runtimeEventAppend,
  runtimeProgressAppend,
  runtimeStagingArtifactCommitSuccess,
  runtimeStagingArtifactList,
  runtimeStagingArtifactRecord,
  runtimeStagingArtifactReadBody,
  type RuntimeCommitBudgetClaimRequest,
  type RuntimeDerivedStaleMarkerRecord,
  type RuntimeEventRecord,
  type RuntimeProgressAppend,
  type RuntimeProgressAppendRequest,
  type RuntimeResourceBudgetClaimRecord,
  type RuntimeStagingArtifactList,
  type RuntimeStagingArtifactReadBody,
  type RuntimeStagingArtifactRecord,
} from "@/commands/runtime-db"

const DEFAULT_COMMIT_LIMIT = 100
const DEFAULT_COMMIT_CONCURRENCY = 1
const DEFAULT_COMMIT_BUDGET_TTL_MS = 120_000
// Deliberately a strict subset of DERIVED_STALE_MARKER_LAYERS (SPEC-6 PR1
// decision 7, narrowed by PR3+4 decision 2): only layers with an actual
// job-backed consumer produce a marker on every commit, to avoid producing
// markers that would just pile up as pending rows forever (Wiring Gate
// philosophy). "graph" was removed here in PR3+4: the investigation that
// merged the original PR3 (graph/search job-ification) into this PR proved
// graph has no materialized artifact at all — wiki-graph.ts always recomputes
// live from the committed wiki tree (graph-relevance.ts's cache is an
// in-memory read-through, not a rebuild target) — so a "graph" marker would
// never have a consumer to fold it. "search" is likewise never marked here
// (real-time scan + vector search is covered by the "embedding" layer);
// "index_export"/"overview" are refreshed by PR5's explicit on-demand jobs
// (reason: "manual_rebuild") instead of on every commit. The remaining three
// layers ("embedding", "taxonomy", "synthesis") all have a
// runtime_derived_marker_claim_batch/complete/release-backed consumer
// (embedding-consumer.ts SPEC-6 PR2; taxonomy-consumer.ts + the
// synthesis-section.tsx manual-rebuild closeout, SPEC-6 PR3+4). Any already
// stale "graph" marker rows recorded before this change are left as-is
// (harmless pending rows, follow-up: PR6 diagnostics should filter
// no-artifact layers out of any pending-marker UI).
const COMMIT_DERIVED_STALE_MARKER_LAYERS = [
  "embedding",
  "taxonomy",
  "synthesis",
] as const satisfies readonly DerivedStaleMarkerLayer[]
const COMMIT_PROGRESS_PREFIX = "bulk-commit"
const COMMIT_PATH_ALREADY_CLAIMED_PREFIX = "commit-path-already-claimed"

export interface CommitIntegrationRuntimeAdapter {
  listStagingArtifacts(): Promise<RuntimeStagingArtifactList>
  readStagingArtifactBody(artifactId: string): Promise<RuntimeStagingArtifactReadBody>
  claimBudget(
    request: RuntimeCommitBudgetClaimRequest,
  ): Promise<MarkdownCommitBudgetClaimReceipt>
  releaseBudget(claimId: string): Promise<RuntimeResourceBudgetClaimRecord[]>
  appendEvent(request: {
    eventId: string
    jobId: string
    payload: MarkdownCommitAuditPayload
  }): Promise<RuntimeEventRecord>
  recordDerivedStaleMarker(request: {
    markerId: string
    layer: DerivedStaleMarkerLayer
    affectedPath: string
    inputHash: string | null
    baseVersion: string
    reason: DerivedStaleMarkerReason
    sourceEventId: string
  }): Promise<RuntimeDerivedStaleMarkerRecord>
  markArtifactCommitted(artifactId: string): Promise<RuntimeStagingArtifactRecord>
  markArtifactFailed(request: {
    artifactId: string
    jobId: string
    artifactPath: string
    artifactHash: string
    lastError: string
  }): Promise<RuntimeStagingArtifactRecord>
  routeConflictRepair(
    context: MarkdownCommitConflictRepairContext,
  ): Promise<{ repairJobId: string }>
  appendProgress(request: RuntimeProgressAppendRequest): Promise<RuntimeProgressAppend>
}

export interface CommitIntegrationFileAdapter {
  exists(path: string): Promise<boolean>
  read(path: string): Promise<string>
  writeAtomic(path: string, contents: string): Promise<void>
  delete(path: string): Promise<void>
}

export interface CommitPendingStagingArtifactsOptions {
  runtime?: CommitIntegrationRuntimeAdapter
  files?: CommitIntegrationFileAdapter
  holder?: string
  limit?: number
  concurrency?: number
  ttlMs?: number
  markerLayers?: readonly DerivedStaleMarkerLayer[]
}

export interface CommitPendingStagingArtifactsResult {
  listedArtifacts: number
  attemptedArtifacts: number
  committed: number
  merged: number
  conflicted: number
  rejected: number
  skipped: number
  retryable: number
  repairJobs: number
  cleanedArtifacts: number
  markersRecorded: number
  progressEvents: number
  errors: string[]
}

const defaultRuntime: CommitIntegrationRuntimeAdapter = {
  async listStagingArtifacts() {
    return runtimeStagingArtifactList({
      status: "pending",
      limit: DEFAULT_COMMIT_LIMIT,
    })
  },
  async readStagingArtifactBody(artifactId) {
    return runtimeStagingArtifactReadBody({ artifactId })
  },
  claimBudget: runtimeCommitBudgetClaim,
  releaseBudget: runtimeCommitBudgetRelease,
  async appendEvent(request) {
    return runtimeEventAppend({
      eventId: request.eventId,
      jobId: request.jobId,
      payload: JSON.stringify(request.payload),
    })
  },
  recordDerivedStaleMarker: runtimeDerivedStaleMarkerRecord,
  markArtifactCommitted: runtimeStagingArtifactCommitSuccess,
  async markArtifactFailed(request) {
    return runtimeStagingArtifactRecord({
      artifactId: request.artifactId,
      jobId: request.jobId,
      artifactPath: request.artifactPath,
      artifactHash: request.artifactHash,
      status: "failed",
      lastError: request.lastError,
    })
  },
  routeConflictRepair: routeMarkdownConflictRepair,
  appendProgress: runtimeProgressAppend,
}

const defaultFiles: CommitIntegrationFileAdapter = {
  exists: fileExists,
  read: readFile,
  writeAtomic: writeFileAtomic,
  delete: deleteFile,
}

/** Commits pending bulk knowledge staging artifacts through the Markdown commit layer. */
export async function commitPendingStagingArtifacts(
  options: CommitPendingStagingArtifactsOptions = {},
): Promise<CommitPendingStagingArtifactsResult> {
  const runtime = options.runtime ?? defaultRuntime
  const files = options.files ?? defaultFiles
  const holder = options.holder ?? "bulk-commit"
  const ttlMs = options.ttlMs ?? DEFAULT_COMMIT_BUDGET_TTL_MS
  const markerLayers = options.markerLayers ?? COMMIT_DERIVED_STALE_MARKER_LAYERS
  const result = emptyResult()

  const listed = await runtime.listStagingArtifacts()
  const artifacts = listed.artifacts.slice(0, normalizeLimit(options.limit))
  result.listedArtifacts = artifacts.length

  const activeResourceKeys = new Set<string>()
  const concurrency = normalizeConcurrency(options.concurrency)
  let cursor = 0

  async function nextArtifact(): Promise<RuntimeStagingArtifactRecord | null> {
    if (cursor >= artifacts.length) return null
    const artifact = artifacts[cursor]
    cursor += 1
    return artifact ?? null
  }

  const workers = Array.from({ length: concurrency }, async () => {
    for (;;) {
      const record = await nextArtifact()
      if (!record) return
      await processRecord(record, {
        runtime,
        files,
        holder,
        ttlMs,
        markerLayers,
        activeResourceKeys,
        result,
      })
    }
  })

  await Promise.all(workers)
  return result
}

interface ProcessContext {
  runtime: CommitIntegrationRuntimeAdapter
  files: CommitIntegrationFileAdapter
  holder: string
  ttlMs: number
  markerLayers: readonly DerivedStaleMarkerLayer[]
  activeResourceKeys: Set<string>
  result: CommitPendingStagingArtifactsResult
}

async function processRecord(
  record: RuntimeStagingArtifactRecord,
  context: ProcessContext,
): Promise<void> {
  const artifact = toCommitArtifact(record)
  if (!artifact.ok) {
    context.result.skipped += 1
    context.result.errors.push(artifact.error)
    return
  }

  const resourceKey = normalizeCommitTargetPath(artifact.value.targetPath).resourceKey
  if (context.activeResourceKeys.has(resourceKey)) {
    context.result.retryable += 1
    await appendProgress(context, artifact.value, "retryable", {
      reason: "same-path-already-scheduled",
    })
    return
  }

  context.activeResourceKeys.add(resourceKey)
  try {
    await commitArtifact(artifact.value, context)
  } catch (error) {
    const message = `commit-artifact-failed:${artifact.value.artifactId}: ${describeError(error)}`
    context.result.errors.push(message)
    await appendProgress(context, artifact.value, "error", { error: message })
  } finally {
    context.activeResourceKeys.delete(resourceKey)
  }
}

async function commitArtifact(
  artifact: MarkdownCommitArtifact,
  context: ProcessContext,
): Promise<void> {
  context.result.attemptedArtifacts += 1
  const commitResult = await commitMarkdownArtifact(
    {
      artifact,
      holder: context.holder,
      ttlMs: context.ttlMs,
    },
    buildCommitAdapters(context),
  )

  if (isRetryableBudgetRejection(commitResult)) {
    context.result.retryable += 1
    await appendProgress(context, artifact, "retryable", { error: commitResult.error })
    return
  }

  const reconciled = reconcileAlreadyCommitted(commitResult, artifact)
  await finalizeCommitResult(artifact, reconciled, context)
}

function buildCommitAdapters(context: ProcessContext) {
  return {
    claimBudget: context.runtime.claimBudget,
    async releaseBudget(claimId: string) {
      await context.runtime.releaseBudget(claimId)
    },
    async readStagedArtifactBody(artifact: MarkdownCommitArtifact) {
      const body = await context.runtime.readStagingArtifactBody(artifact.artifactId)
      return body.markdown
    },
    async readCommittedMarkdown(targetPath: string) {
      if (!(await context.files.exists(targetPath))) return null
      return context.files.read(targetPath)
    },
    writeCommittedMarkdownAtomic: context.files.writeAtomic,
    async deleteCommittedMarkdown(targetPath: string) {
      if (await context.files.exists(targetPath)) {
        await context.files.delete(targetPath)
      }
    },
    cleanupCommittedArtifact: async () => undefined,
    hashContent: hashMarkdownContent,
  }
}

async function finalizeCommitResult(
  artifact: MarkdownCommitArtifact,
  commitResult: MarkdownCommitOperationResult,
  context: ProcessContext,
): Promise<void> {
  if (commitResult.result === "conflicted") {
    const routed = await routeConflict(artifact, commitResult, context)
    context.result.conflicted += 1
    if (routed.repairJobId) context.result.repairJobs += 1
    await appendAuditEvent(context, artifact, routed)
    await appendProgress(context, artifact, "conflicted", {
      repairJobId: routed.repairJobId,
      repairError: routed.repairError,
    })
    return
  }

  if (
    commitResult.result === "committed" ||
    commitResult.result === "merged" ||
    (artifact.operationIntent === "delete" && commitResult.result === "skipped")
  ) {
    await appendEventMarkersAndCleanup(context, artifact, commitResult)
    context.result[commitResult.result] += 1
    return
  }

  if (isTerminalRejectedCommitResult(commitResult)) {
    const event = await appendAuditEvent(context, artifact, commitResult)
    await context.runtime.markArtifactFailed({
      artifactId: artifact.artifactId,
      jobId: artifact.jobId,
      artifactPath: artifact.artifactPath,
      artifactHash: artifact.artifactHash,
      lastError: commitResult.error ?? "commit-rejected",
    })
    context.result.rejected += 1
    await appendProgress(context, artifact, "rejected", {
      eventId: event.eventId,
      error: commitResult.error,
    })
    return
  }

  context.result[commitResult.result] += 1
  await appendAuditEvent(context, artifact, commitResult)
  await appendProgress(context, artifact, commitResult.result, {
    error: commitResult.error,
  })
}

function reconcileAlreadyCommitted(
  commitResult: MarkdownCommitOperationResult,
  artifact: MarkdownCommitArtifact,
): MarkdownCommitOperationResult {
  if (commitResult.result !== "conflicted") {
    return commitResult
  }

  if (
    (artifact.operationIntent === "create" || artifact.operationIntent === "update") &&
    commitResult.currentHash === commitResult.artifactHash
  ) {
    return {
      ...commitResult,
      result: "committed",
      finalHash: commitResult.currentHash,
      repairJobId: null,
    }
  }

  return commitResult
}

/**
 * SPEC-5-FIX PR5 append crash-window narrowing: unlike create/update (which
 * self-heal a crash-after-write retry by comparing currentHash===artifactHash
 * in `reconcileAlreadyCommitted`), an append re-run against an
 * already-merged target file has no safe content-level reconciliation --
 * `currentHash` reflects the merged result, never the staged-only hash, so
 * retrying `commitMarkdownArtifact` for append legitimately cannot tell
 * "already applied by us" apart from "changed by someone else" without
 * inspecting content (which the routes-append-conflicts-to-repair tests in
 * commit-integration.test.ts intentionally forbid -- a coincidental content
 * match must still go to repair, not self-heal).
 *
 * The real fix is to shrink the window during which the staging artifact is
 * still "pending" (and therefore re-processable) after the write succeeds.
 * For create/update/skipped-delete we keep audit+marker recording before the
 * commit-success mark (see the non-append branch below and the "keeps the
 * artifact pending when derived marker recording fails" regression test) --
 * that ordering lets a transient marker failure be retried safely because
 * those operations are idempotent to re-run. Append is not: leaving it
 * "pending" while audit/marker recording completes is exactly the window
 * that lets a crash (or transient marker failure) trigger a false
 * "conflicted" misjudgement on the next pass. So for append we flip
 * artifact-committed immediately after the write succeeds, before
 * audit/marker recording, collapsing the reprocessing window to nothing.
 *
 * Trade-off (documented per SPEC-5-FIX PR5 commander decision): if the
 * process crashes in the now-much-smaller gap between markArtifactCommitted
 * succeeding and the audit event / derived stale marker being recorded, that
 * marker is lost for this artifact (it will never be "pending" again). This
 * is accepted as a bounded, documented residual risk -- a single DB write's
 * width -- traded against eliminating the append false-conflict misjudgement
 * (which today additionally loses the marker via the "conflicted" branch,
 * which never records derived markers, *and* creates a spurious repair job).
 */
async function appendEventMarkersAndCleanup(
  context: ProcessContext,
  artifact: MarkdownCommitArtifact,
  commitResult: MarkdownCommitOperationResult,
): Promise<void> {
  if (artifact.operationIntent === "append") {
    await context.runtime.markArtifactCommitted(artifact.artifactId)
    context.result.cleanedArtifacts += 1
    const event = await appendAuditEvent(context, artifact, commitResult)
    await recordDerivedMarkers(context, artifact, commitResult, event.eventId)
    await appendProgress(context, artifact, commitResult.result, {
      eventId: event.eventId,
    })
    return
  }

  const event = await appendAuditEvent(context, artifact, commitResult)
  await recordDerivedMarkers(context, artifact, commitResult, event.eventId)
  await context.runtime.markArtifactCommitted(artifact.artifactId)
  context.result.cleanedArtifacts += 1
  await appendProgress(context, artifact, commitResult.result, {
    eventId: event.eventId,
  })
}

async function routeConflict(
  artifact: MarkdownCommitArtifact,
  commitResult: MarkdownCommitOperationResult,
  context: ProcessContext,
): Promise<MarkdownCommitOperationResult> {
  try {
    const receipt = await context.runtime.routeConflictRepair({
      artifactId: artifact.artifactId,
      jobId: artifact.jobId,
      artifactPath: artifact.artifactPath,
      artifactHash: artifact.artifactHash,
      targetPath: artifact.targetPath,
      operationIntent: artifact.operationIntent,
      result: "conflicted",
      baseHash: commitResult.baseHash,
      currentHash: commitResult.currentHash,
      affectedPaths: commitResult.affectedPaths,
      sourceKind: artifact.sourceKind,
      conflictReason: `commit-conflict: ${artifact.operationIntent} target does not match the expected base hash`,
    })
    return { ...commitResult, repairJobId: receipt.repairJobId }
  } catch (error) {
    return { ...commitResult, repairError: describeError(error) }
  }
}

async function appendAuditEvent(
  context: ProcessContext,
  artifact: MarkdownCommitArtifact,
  commitResult: MarkdownCommitOperationResult,
): Promise<RuntimeEventRecord> {
  const eventId = deterministicCommitEventId(artifact, commitResult)
  const payload: MarkdownCommitAuditPayload = {
    kind: "markdown-commit",
    artifactId: commitResult.artifactId,
    artifactHash: commitResult.artifactHash,
    targetPath: commitResult.targetPath,
    operationIntent: commitResult.operationIntent,
    result: commitResult.result,
    baseHash: commitResult.baseHash,
    currentHash: commitResult.currentHash,
    finalHash: commitResult.finalHash,
    affectedPaths: commitResult.affectedPaths,
    repairJobId: commitResult.repairJobId,
    ...(commitResult.repairError ? { repairError: commitResult.repairError } : {}),
    sourceKind: artifact.sourceKind,
  }
  try {
    return await context.runtime.appendEvent({
      eventId,
      jobId: artifact.jobId,
      payload,
    })
  } catch (error) {
    if (!isDuplicateRuntimeEventError(error)) throw error
    return {
      eventId,
      jobId: artifact.jobId,
      eventName: "job-runtime:event-appended",
      payload: JSON.stringify(payload),
      createdAtMs: 0,
    }
  }
}

async function recordDerivedMarkers(
  context: ProcessContext,
  artifact: MarkdownCommitArtifact,
  commitResult: MarkdownCommitOperationResult,
  sourceEventId: string,
): Promise<void> {
  const reason = markerReason(artifact.operationIntent)
  const inputHash = reason === "delete" ? null : requireFinalHash(commitResult)
  const baseVersion = commitResult.currentHash ?? commitResult.baseHash ?? "genesis"

  for (const layer of context.markerLayers) {
    try {
      await context.runtime.recordDerivedStaleMarker({
        markerId: deterministicMarkerId(artifact.artifactId, layer, artifact.targetPath),
        layer,
        affectedPath: artifact.targetPath,
        inputHash,
        baseVersion,
        reason,
        sourceEventId,
      })
      context.result.markersRecorded += 1
    } catch (error) {
      if (!isDuplicateDerivedMarkerError(error)) throw error
    }
  }
}

async function appendProgress(
  context: ProcessContext,
  artifact: MarkdownCommitArtifact,
  status: string,
  payload: Record<string, unknown>,
): Promise<void> {
  try {
    await context.runtime.appendProgress({
      jobId: artifact.jobId,
      progressKey: `${COMMIT_PROGRESS_PREFIX}:${artifact.artifactId}`,
      durable: true,
      payload: JSON.stringify({
        type: `${COMMIT_PROGRESS_PREFIX}:${status}`,
        artifactId: artifact.artifactId,
        targetPath: artifact.targetPath,
        status,
        ...payload,
      }),
    })
    context.result.progressEvents += 1
  } catch (error) {
    context.result.errors.push(`progress-append-failed: ${describeError(error)}`)
  }
}

function toCommitArtifact(
  record: RuntimeStagingArtifactRecord,
): { ok: true; value: MarkdownCommitArtifact } | { ok: false; error: string } {
  if (record.status !== "pending") {
    return { ok: false, error: `staging-artifact-not-pending: ${record.artifactId}` }
  }
  if (!record.targetPath || !record.operationIntent || !record.sourceKind) {
    return {
      ok: false,
      error: `staging-artifact-missing-commit-metadata: ${record.artifactId}`,
    }
  }
  if (!isMarkdownCommitOperationIntent(record.operationIntent)) {
    return {
      ok: false,
      error: `staging-artifact-operation-invalid: ${record.artifactId}`,
    }
  }

  return {
    ok: true,
    value: {
      artifactId: record.artifactId,
      jobId: record.jobId,
      artifactPath: record.artifactPath,
      artifactHash: record.artifactHash,
      targetPath: record.targetPath,
      baseHash: record.baseHash ?? null,
      operationIntent: record.operationIntent,
      sourceKind: record.sourceKind,
      createdAtMs: record.createdAtMs,
    },
  }
}

function isRetryableBudgetRejection(result: MarkdownCommitOperationResult): boolean {
  return (
    result.result === "rejected" &&
    typeof result.error === "string" &&
    result.error.startsWith(COMMIT_PATH_ALREADY_CLAIMED_PREFIX)
  )
}

function isTerminalRejectedCommitResult(result: MarkdownCommitOperationResult): boolean {
  const error = result.error ?? ""
  return (
    result.result === "rejected" &&
    (error.startsWith("artifact-hash-mismatch") ||
      error.startsWith("unsupported-operation"))
  )
}

function markerReason(
  intent: MarkdownCommitOperationIntent,
): DerivedStaleMarkerReason {
  return intent === "delete" ? "delete" : "commit"
}

function requireFinalHash(result: MarkdownCommitOperationResult): string {
  if (result.finalHash) return result.finalHash
  throw new Error("derived-marker-final-hash-missing")
}

function deterministicCommitEventId(
  artifact: MarkdownCommitArtifact,
  result: MarkdownCommitOperationResult,
): string {
  return `commit-event-${fnv1a64Hex(
    `${artifact.artifactId}\n${result.result}\n${artifact.targetPath}`,
  )}`
}

function deterministicMarkerId(
  artifactId: string,
  layer: DerivedStaleMarkerLayer,
  affectedPath: string,
): string {
  return `derived-marker-${fnv1a64Hex(`${artifactId}\n${layer}\n${affectedPath}`)}`
}

function isMarkdownCommitOperationIntent(
  raw: string,
): raw is MarkdownCommitOperationIntent {
  return MARKDOWN_COMMIT_OPERATION_INTENTS.includes(
    raw as MarkdownCommitOperationIntent,
  )
}

function normalizeLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_COMMIT_LIMIT
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error("bulk-commit-limit-invalid")
  }
  return limit
}

function normalizeConcurrency(concurrency = DEFAULT_COMMIT_CONCURRENCY): number {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error("bulk-commit-concurrency-invalid")
  }
  return concurrency
}

function emptyResult(): CommitPendingStagingArtifactsResult {
  return {
    listedArtifacts: 0,
    attemptedArtifacts: 0,
    committed: 0,
    merged: 0,
    conflicted: 0,
    rejected: 0,
    skipped: 0,
    retryable: 0,
    repairJobs: 0,
    cleanedArtifacts: 0,
    markersRecorded: 0,
    progressEvents: 0,
    errors: [],
  }
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

function isDuplicateRuntimeEventError(error: unknown): boolean {
  const message = describeError(error)
  return (
    message.includes("event-insert-failed") &&
    (message.includes("UNIQUE constraint failed") || message.includes("PRIMARY KEY"))
  )
}

function isDuplicateDerivedMarkerError(error: unknown): boolean {
  const message = describeError(error)
  return (
    message.includes("derived-marker-record-insert-failed") &&
    (message.includes("UNIQUE constraint failed") || message.includes("PRIMARY KEY"))
  )
}
