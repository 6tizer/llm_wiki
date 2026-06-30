import type {
  DerivedStaleMarkerLayer,
  MarkdownCommitOperationIntent,
  MarkdownCommitResult,
} from "../contract"

export interface MarkdownCommitArtifact {
  readonly artifactId: string
  readonly jobId: string
  readonly artifactPath: string
  readonly artifactHash: string
  readonly targetPath: string
  readonly baseHash: string | null
  readonly operationIntent: MarkdownCommitOperationIntent
  readonly sourceKind: string
  readonly createdAtMs?: number
}

export interface MarkdownCommitBudgetClaimRequest {
  readonly affectedPath: string
  readonly holder: string
  readonly jobId?: string
  readonly claimId?: string
  readonly ttlMs?: number
}

/** Minimal receipt the core operation needs after claiming commit-path budget. */
export interface MarkdownCommitBudgetClaimReceipt {
  readonly claimId: string
  readonly resourceKey?: string
  readonly displayKey?: string
  readonly expiresAtMs?: number
}

export interface MarkdownCommitAuditPayload {
  readonly kind: "markdown-commit"
  readonly artifactId: string
  readonly artifactHash: string
  readonly targetPath: string
  readonly operationIntent: MarkdownCommitOperationIntent
  readonly result: MarkdownCommitResult
  readonly baseHash: string | null
  readonly currentHash: string | null
  readonly finalHash: string | null
  readonly affectedPaths: readonly string[]
  readonly repairJobId: string | null
  readonly sourceKind: string
}

export interface MarkdownCommitEventReceipt {
  readonly eventId: string
  readonly createdAtMs?: number
}

export interface MarkdownCommitDerivedMarkerOperation {
  readonly layer: DerivedStaleMarkerLayer
  readonly affectedPath: string
}

export interface MarkdownCommitDerivedMarkerContext {
  readonly event: MarkdownCommitEventReceipt
  readonly result: MarkdownCommitOperationResult
  readonly markerOperations: readonly MarkdownCommitDerivedMarkerOperation[]
}

export interface MarkdownCommitAdapters {
  readonly claimBudget: (
    request: MarkdownCommitBudgetClaimRequest,
  ) => Promise<MarkdownCommitBudgetClaimReceipt>
  readonly releaseBudget: (claimId: string) => Promise<void>
  /**
   * Must resolve artifact paths under the runtime staging root, not the whole
   * project root.
   */
  readonly readStagedArtifactBody: (artifact: MarkdownCommitArtifact) => Promise<string>
  readonly readCommittedMarkdown: (targetPath: string) => Promise<string | null>
  readonly writeCommittedMarkdownAtomic: (
    targetPath: string,
    contents: string,
  ) => Promise<void>
  readonly deleteCommittedMarkdown: (targetPath: string) => Promise<void>
  readonly cleanupCommittedArtifact: (artifactId: string) => Promise<void>
  readonly appendCommitEvent?: (
    payload: MarkdownCommitAuditPayload,
  ) => Promise<MarkdownCommitEventReceipt>
  readonly recordDerivedStaleMarkers?: (
    context: MarkdownCommitDerivedMarkerContext,
  ) => Promise<void>
  readonly hashContent?: (content: string) => Promise<string> | string
}

export interface MarkdownCommitRequest {
  readonly artifact: MarkdownCommitArtifact
  readonly holder: string
  readonly claimId?: string
  readonly ttlMs?: number
  readonly markerOperations?: readonly MarkdownCommitDerivedMarkerOperation[]
}

export interface MarkdownCommitOperationResult {
  readonly artifactId: string
  readonly artifactHash: string
  readonly targetPath: string
  readonly operationIntent: MarkdownCommitOperationIntent
  readonly result: MarkdownCommitResult
  readonly baseHash: string | null
  readonly currentHash: string | null
  readonly finalHash: string | null
  readonly affectedPaths: readonly string[]
  readonly eventId: string | null
  readonly error?: string
  readonly cleanupError?: string
  readonly releaseError?: string
  readonly eventError?: string
  readonly markerError?: string
}

export function canonicalizeMarkdownContentForHash(content: string): string {
  return content.replace(/\r\n/g, "\n").replace(/\r/g, "\n")
}

export async function hashMarkdownContent(content: string): Promise<string> {
  const canonical = canonicalizeMarkdownContentForHash(content)
  const bytes = new TextEncoder().encode(canonical)
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes)
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("")
}

export function appendMarkdownContent(existing: string, staged: string): string {
  const canonicalExisting = canonicalizeMarkdownContentForHash(existing)
  const canonicalStaged = canonicalizeMarkdownContentForHash(staged)
  if (canonicalStaged.length === 0) {
    return canonicalExisting
  }
  if (canonicalExisting.length === 0) {
    return canonicalStaged
  }
  return `${canonicalExisting.replace(/\n*$/, "\n")}${canonicalStaged.replace(/^\n+/, "")}`
}

export async function commitMarkdownArtifact(
  request: MarkdownCommitRequest,
  adapters: MarkdownCommitAdapters,
): Promise<MarkdownCommitOperationResult> {
  const { artifact } = request
  let claim: MarkdownCommitBudgetClaimReceipt | null = null
  let outcome: MarkdownCommitOperationResult | null = null
  let releaseError: string | undefined

  try {
    claim = await adapters.claimBudget({
      affectedPath: artifact.targetPath,
      holder: request.holder,
      jobId: artifact.jobId,
      claimId: request.claimId,
      ttlMs: request.ttlMs,
    })
  } catch (error) {
    return buildResult(artifact, "rejected", null, null, describeError(error))
  }

  try {
    outcome = await decideAndApplyCommit(artifact, adapters)
  } catch (error) {
    outcome = buildResult(artifact, "rejected", null, null, describeError(error))
  } finally {
    try {
      await adapters.releaseBudget(claim.claimId)
    } catch (error) {
      releaseError = describeError(error)
    }
  }

  if (releaseError) {
    outcome = { ...outcome, releaseError }
    return outcome
  }

  const event = await appendCommitEventIfAvailable(outcome, artifact, adapters)
  if (!event.ok) {
    return { ...outcome, eventError: event.eventError }
  }
  if (event.receipt) {
    outcome = { ...outcome, eventId: event.receipt.eventId }
  }

  if (shouldRecordMarkers(outcome) && event.receipt && request.markerOperations?.length) {
    try {
      await adapters.recordDerivedStaleMarkers?.({
        event: event.receipt,
        result: outcome,
        markerOperations: request.markerOperations,
      })
    } catch (error) {
      return { ...outcome, markerError: describeError(error) }
    }
  }

  if (outcome.result === "committed" || outcome.result === "merged") {
    try {
      await adapters.cleanupCommittedArtifact(artifact.artifactId)
    } catch (error) {
      outcome = { ...outcome, cleanupError: describeError(error) }
    }
  }

  return outcome
}

async function appendCommitEventIfAvailable(
  outcome: MarkdownCommitOperationResult,
  artifact: MarkdownCommitArtifact,
  adapters: MarkdownCommitAdapters,
): Promise<
  | { readonly ok: true; readonly receipt: MarkdownCommitEventReceipt | null }
  | { readonly ok: false; readonly eventError: string }
> {
  if (!adapters.appendCommitEvent) {
    return { ok: true, receipt: null }
  }
  try {
    return {
      ok: true,
      receipt: await adapters.appendCommitEvent(buildAuditPayload(artifact, outcome)),
    }
  } catch (error) {
    return { ok: false, eventError: describeError(error) }
  }
}

function buildAuditPayload(
  artifact: MarkdownCommitArtifact,
  outcome: MarkdownCommitOperationResult,
): MarkdownCommitAuditPayload {
  return {
    kind: "markdown-commit",
    artifactId: outcome.artifactId,
    artifactHash: outcome.artifactHash,
    targetPath: outcome.targetPath,
    operationIntent: outcome.operationIntent,
    result: outcome.result,
    baseHash: outcome.baseHash,
    currentHash: outcome.currentHash,
    finalHash: outcome.finalHash,
    affectedPaths: outcome.affectedPaths,
    repairJobId: null,
    sourceKind: artifact.sourceKind,
  }
}

function shouldRecordMarkers(outcome: MarkdownCommitOperationResult): boolean {
  return outcome.result === "committed" || outcome.result === "merged"
}

async function decideAndApplyCommit(
  artifact: MarkdownCommitArtifact,
  adapters: MarkdownCommitAdapters,
): Promise<MarkdownCommitOperationResult> {
  const stagedBody = await adapters.readStagedArtifactBody(artifact)
  const stagedHash = await hashWith(adapters, stagedBody)
  if (stagedHash !== artifact.artifactHash) {
    return buildResult(
      artifact,
      "rejected",
      null,
      null,
      "artifact-hash-mismatch: staged artifact body does not match artifactHash",
    )
  }

  const currentBody = await adapters.readCommittedMarkdown(artifact.targetPath)
  const currentHash = currentBody === null ? null : await hashWith(adapters, currentBody)

  switch (artifact.operationIntent) {
    case "create":
      return commitCreate(artifact, adapters, stagedBody, currentHash)
    case "update":
      return commitUpdate(artifact, adapters, stagedBody, currentHash)
    case "append":
      return commitAppend(artifact, adapters, stagedBody, currentBody, currentHash)
    case "delete":
      return commitDelete(artifact, adapters, currentBody, currentHash)
    default:
      return buildResult(
        artifact,
        "rejected",
        currentHash,
        null,
        `unsupported-operation: ${String(artifact.operationIntent)}`,
      )
  }
}

async function commitCreate(
  artifact: MarkdownCommitArtifact,
  adapters: MarkdownCommitAdapters,
  stagedBody: string,
  currentHash: string | null,
): Promise<MarkdownCommitOperationResult> {
  if (currentHash === null && artifact.baseHash === null) {
    await adapters.writeCommittedMarkdownAtomic(artifact.targetPath, stagedBody)
    return buildResult(
      artifact,
      "committed",
      currentHash,
      await hashWith(adapters, stagedBody),
    )
  }
  return buildResult(artifact, "conflicted", currentHash, null)
}

async function commitUpdate(
  artifact: MarkdownCommitArtifact,
  adapters: MarkdownCommitAdapters,
  stagedBody: string,
  currentHash: string | null,
): Promise<MarkdownCommitOperationResult> {
  if (artifact.baseHash && currentHash === artifact.baseHash) {
    await adapters.writeCommittedMarkdownAtomic(artifact.targetPath, stagedBody)
    return buildResult(
      artifact,
      "committed",
      currentHash,
      await hashWith(adapters, stagedBody),
    )
  }
  return buildResult(artifact, "conflicted", currentHash, null)
}

async function commitAppend(
  artifact: MarkdownCommitArtifact,
  adapters: MarkdownCommitAdapters,
  stagedBody: string,
  currentBody: string | null,
  currentHash: string | null,
): Promise<MarkdownCommitOperationResult> {
  if (currentBody === null && artifact.baseHash === null) {
    await adapters.writeCommittedMarkdownAtomic(artifact.targetPath, stagedBody)
    return buildResult(
      artifact,
      "committed",
      currentHash,
      await hashWith(adapters, stagedBody),
    )
  }
  if (currentBody !== null && artifact.baseHash && currentHash === artifact.baseHash) {
    const merged = appendMarkdownContent(currentBody, stagedBody)
    await adapters.writeCommittedMarkdownAtomic(artifact.targetPath, merged)
    return buildResult(artifact, "merged", currentHash, await hashWith(adapters, merged))
  }
  return buildResult(artifact, "conflicted", currentHash, null)
}

async function commitDelete(
  artifact: MarkdownCommitArtifact,
  adapters: MarkdownCommitAdapters,
  currentBody: string | null,
  currentHash: string | null,
): Promise<MarkdownCommitOperationResult> {
  if (currentBody === null) {
    return buildResult(artifact, "skipped", currentHash, null)
  }
  if (artifact.baseHash && currentHash === artifact.baseHash) {
    await adapters.deleteCommittedMarkdown(artifact.targetPath)
    return buildResult(artifact, "committed", currentHash, null)
  }
  return buildResult(artifact, "conflicted", currentHash, null)
}

async function hashWith(
  adapters: MarkdownCommitAdapters,
  content: string,
): Promise<string> {
  const hashContent = adapters.hashContent ?? hashMarkdownContent
  return hashContent(content)
}

function buildResult(
  artifact: MarkdownCommitArtifact,
  result: MarkdownCommitResult,
  currentHash: string | null,
  finalHash: string | null,
  error?: string,
): MarkdownCommitOperationResult {
  return {
    artifactId: artifact.artifactId,
    artifactHash: artifact.artifactHash,
    targetPath: artifact.targetPath,
    operationIntent: artifact.operationIntent,
    result,
    baseHash: artifact.baseHash,
    currentHash,
    finalHash,
    affectedPaths: [artifact.targetPath],
    eventId: null,
    ...(error ? { error } : {}),
  }
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }
  return String(error)
}
