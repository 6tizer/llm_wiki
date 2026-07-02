import {
  BULK_KNOWLEDGE_MAP_REDUCE_REPAIR_JOB_KIND,
  BULK_KNOWLEDGE_PREPARE_JOB_KIND,
  BULK_KNOWLEDGE_ARTIFACT_REPAIR_JOB_KIND,
  canonicalizeBulkKnowledgeSourcePath,
  hashTextHex,
  sanitizeRepairError,
  validatePrepareArtifacts,
  type BulkKnowledgePrepareJobPayload,
  type BulkKnowledgeMapReduceRepairJobPayload,
  type LongDocumentReduceResult,
  type ValidatedPrepareArtifact,
} from "@/core-runtime/parallel-knowledge"
import {
  runtimeJobClaimByKind,
  runtimeJobComplete,
  runtimeJobCreate,
  runtimeJobFail,
  runtimeProfilePoolClaim,
  runtimeProfilePoolList,
  runtimeProfilePoolRelease,
  runtimeProgressAppend,
  runtimeStagingArtifactsClearPendingForJob,
  runtimeStagingArtifactStore,
  type RuntimeDbHealthState,
  type RuntimeJobClaim,
  type RuntimeJobClaimByKindRequest,
  type RuntimeJobCreateRequest,
  type RuntimeJobFailRequest,
  type RuntimeJobLeaseRequest,
  type RuntimeJobRecord,
  type RuntimeProfilePoolClaim,
  type RuntimeProfilePoolClaimRequest,
  type RuntimeProfilePoolList,
  type RuntimeProfilePoolListRequest,
  type RuntimeProfilePoolRelease,
  type RuntimeProfilePoolReleaseRequest,
  type RuntimeProgressAppend,
  type RuntimeProgressAppendRequest,
  type RuntimeStagingArtifactsClearPendingForJob,
  type RuntimeStagingArtifactsClearPendingForJobRequest,
  type RuntimeStagingArtifactRecord,
  type RuntimeStagingArtifactStoreRequest,
} from "@/commands/runtime-db"

export const PREPARE_PROFILE_TASK_FAMILY = "ingest"
export const DEFAULT_PREPARE_WORKER_CONCURRENCY = 2
export const DEFAULT_PREPARE_PROFILE_CLAIM_TTL_MS = 1_200_000
const NO_QUEUED_JOB_ERROR_PREFIX = "no-queued-job:"
const RUNTIME_DISABLED_ERROR_PREFIX = "runtime-disabled:"

export type PrepareModelCallOutcome =
  | {
      status: "success"
      artifacts?: readonly unknown[]
      mapReduceResults?: LongDocumentReduceResult | readonly LongDocumentReduceResult[]
      metadata?: Record<string, unknown>
    }
  | {
      status: "rate-limited"
      retryAfterMs: number
      error?: string
      jobRetryAfterMs?: number | null
    }
  | {
      status: "error"
      error: string
      circuitOpenMs?: number | null
      jobRetryAfterMs?: number | null
    }

export interface PrepareModelCallRequest {
  workerId: string
  job: RuntimeJobRecord
  leaseId: string
  payload: BulkKnowledgePrepareJobPayload
  profileClaim: RuntimeProfilePoolClaim
}

export type PrepareModelCallExecutor = (
  request: PrepareModelCallRequest,
) => Promise<PrepareModelCallOutcome>

export interface PrepareWorkerRuntimeAdapter {
  claimJobByKind(request: RuntimeJobClaimByKindRequest): Promise<RuntimeJobClaim>
  createJob(request: RuntimeJobCreateRequest): Promise<RuntimeJobRecord>
  completeJob(request: RuntimeJobLeaseRequest): Promise<RuntimeJobRecord>
  failJob(request: RuntimeJobFailRequest): Promise<RuntimeJobRecord>
  profilePoolList(request: RuntimeProfilePoolListRequest): Promise<RuntimeProfilePoolList>
  profilePoolClaim(request: RuntimeProfilePoolClaimRequest): Promise<RuntimeProfilePoolClaim>
  profilePoolRelease(request: RuntimeProfilePoolReleaseRequest): Promise<RuntimeProfilePoolRelease>
  progressAppend(request: RuntimeProgressAppendRequest): Promise<RuntimeProgressAppend>
  stagingArtifactStore(
    request: RuntimeStagingArtifactStoreRequest,
  ): Promise<RuntimeStagingArtifactRecord>
  stagingArtifactsClearPendingForJob(
    request: RuntimeStagingArtifactsClearPendingForJobRequest,
  ): Promise<RuntimeStagingArtifactsClearPendingForJob>
}

export interface RunPrepareWorkerPoolOptions {
  executor: PrepareModelCallExecutor
  runtime?: PrepareWorkerRuntimeAdapter
  concurrency?: number
  maxJobs?: number
  workerIdPrefix?: string
  signal?: AbortSignal
}

export interface PrepareWorkerPoolResult {
  claimedJobs: number
  completedJobs: number
  failedJobs: number
  storedArtifacts: number
  artifactStoreFailures: number
  repairJobs: number
  mapReduceRepairJobs: number
  partialMapReduceResults: number
  profileUnavailable: number
  rateLimited: number
  idleWorkers: number
  runtimeDisabled: boolean
  errors: string[]
}

const defaultRuntime: PrepareWorkerRuntimeAdapter = {
  claimJobByKind: runtimeJobClaimByKind,
  createJob: runtimeJobCreate,
  completeJob: runtimeJobComplete,
  failJob: runtimeJobFail,
  profilePoolList: runtimeProfilePoolList,
  profilePoolClaim: runtimeProfilePoolClaim,
  profilePoolRelease: runtimeProfilePoolRelease,
  progressAppend: runtimeProgressAppend,
  stagingArtifactStore: runtimeStagingArtifactStore,
  stagingArtifactsClearPendingForJob: runtimeStagingArtifactsClearPendingForJob,
}

/** Runs a bounded pool that prepares only bulk knowledge jobs through model-call profiles. */
export async function runPrepareWorkerPool(
  options: RunPrepareWorkerPoolOptions,
): Promise<PrepareWorkerPoolResult> {
  const runtime = options.runtime ?? defaultRuntime
  const concurrency = normalizeConcurrency(options.concurrency)
  const result: PrepareWorkerPoolResult = {
    claimedJobs: 0,
    completedJobs: 0,
    failedJobs: 0,
    storedArtifacts: 0,
    artifactStoreFailures: 0,
    repairJobs: 0,
    mapReduceRepairJobs: 0,
    partialMapReduceResults: 0,
    profileUnavailable: 0,
    rateLimited: 0,
    idleWorkers: 0,
    runtimeDisabled: false,
    errors: [],
  }
  let claimReservations = 0
  const reserveClaim = () => {
    if (options.signal?.aborted) return false
    if (options.maxJobs === undefined) return true
    if (claimReservations >= options.maxJobs) return false
    claimReservations += 1
    return true
  }

  const workers = Array.from({ length: concurrency }, (_, index) =>
    runPrepareWorker({
      runtime,
      executor: options.executor,
      workerId: `${options.workerIdPrefix ?? "bulk-prepare"}:${index + 1}`,
      reserveClaim,
      result,
      signal: options.signal,
    }),
  )
  await Promise.all(workers)
  return result
}

interface PrepareWorkerContext {
  runtime: PrepareWorkerRuntimeAdapter
  executor: PrepareModelCallExecutor
  workerId: string
  reserveClaim: () => boolean
  result: PrepareWorkerPoolResult
  signal?: AbortSignal
}

async function runPrepareWorker(context: PrepareWorkerContext): Promise<void> {
  while (!context.signal?.aborted && context.reserveClaim()) {
    const claim = await claimNextPrepareJob(context)
    if (!claim) return
    await processPrepareJob(context, claim)
  }
}

async function claimNextPrepareJob(
  context: PrepareWorkerContext,
): Promise<RuntimeJobClaim | null> {
  try {
    return await context.runtime.claimJobByKind({
      kind: BULK_KNOWLEDGE_PREPARE_JOB_KIND,
      holder: context.workerId,
    })
  } catch (err) {
    const message = errorMessage(err)
    if (message.startsWith(NO_QUEUED_JOB_ERROR_PREFIX)) {
      context.result.idleWorkers += 1
      return null
    }
    if (message.startsWith(RUNTIME_DISABLED_ERROR_PREFIX)) {
      context.result.runtimeDisabled = true
      return null
    }
    context.result.errors.push(message)
    return null
  }
}

async function processPrepareJob(
  context: PrepareWorkerContext,
  claim: RuntimeJobClaim,
): Promise<void> {
  context.result.claimedJobs += 1
  await appendWorkerProgress(context, claim, "bulk-prepare:job-claimed")

  let payload: BulkKnowledgePrepareJobPayload
  try {
    payload = parsePreparePayload(claim.job.payload)
  } catch (err) {
    await failClaimedJob(context, claim, `prepare-payload-invalid: ${errorMessage(err)}`)
    return
  }

  const poolStatus = await getHealthyProfilePool(context)
  if (poolStatus !== "healthy") {
    await failForProfileUnavailable(context, claim, `profile pool is ${poolStatus}`)
    return
  }

  let profileClaim: RuntimeProfilePoolClaim
  try {
    profileClaim = await context.runtime.profilePoolClaim({
      kind: "model-call",
      taskFamily: PREPARE_PROFILE_TASK_FAMILY,
      holder: context.workerId,
      jobId: claim.job.jobId,
      ttlMs: DEFAULT_PREPARE_PROFILE_CLAIM_TTL_MS,
    })
  } catch (err) {
    await failForProfileUnavailable(context, claim, errorMessage(err))
    return
  }

  const outcome = await runExecutor(context, claim, payload, profileClaim)
  if (outcome.status === "success") {
    const stored = await storeSuccessfulArtifacts(context, claim, outcome, profileClaim)
    if (!stored) return
    await context.runtime.profilePoolRelease({
      claimId: profileClaim.claimId,
      outcome: "success",
    })
    await context.runtime.completeJob(leaseRequest(claim))
    context.result.completedJobs += 1
    await appendWorkerProgress(context, claim, "bulk-prepare:job-completed", {
      profileId: profileClaim.profileId,
    })
    return
  }

  if (outcome.status === "rate-limited") {
    context.result.rateLimited += 1
    await context.runtime.profilePoolRelease({
      claimId: profileClaim.claimId,
      outcome: "rate-limited",
      retryAfterMs: outcome.retryAfterMs,
      reason: "bulk-prepare-rate-limited",
      error: outcome.error,
    })
    await failClaimedJob(context, claim, outcome.error ?? "profile rate limited", {
      retryAfterMs: outcome.jobRetryAfterMs,
      type: "bulk-prepare:profile-rate-limited",
      profileId: profileClaim.profileId,
    })
    return
  }

  await context.runtime.profilePoolRelease({
    claimId: profileClaim.claimId,
    outcome: "error",
    circuitOpenMs: outcome.circuitOpenMs,
    reason: "bulk-prepare-error",
    error: outcome.error,
  })
  await failClaimedJob(context, claim, outcome.error, {
    retryAfterMs: outcome.jobRetryAfterMs,
    type: "bulk-prepare:job-failed",
    profileId: profileClaim.profileId,
  })
}

async function storeSuccessfulArtifacts(
  context: PrepareWorkerContext,
  claim: RuntimeJobClaim,
  outcome: Extract<PrepareModelCallOutcome, { status: "success" }>,
  profileClaim: RuntimeProfilePoolClaim,
): Promise<boolean> {
  let artifacts: ValidatedPrepareArtifact[]
  try {
    artifacts = outcome.artifacts === undefined
      ? []
      : validatePrepareArtifacts(outcome.artifacts, { jobId: claim.job.jobId })
  } catch (err) {
    const error = `artifact-store-failed: ${sanitizeLocalArtifactError(err)}`
    await handleArtifactStoreFailure(context, claim, profileClaim, error)
    return false
  }

  const mapReduceResults = normalizeMapReduceResults(outcome.mapReduceResults)
  const committableArtifacts = filterCommittableArtifacts(artifacts, mapReduceResults)
  if (artifacts.length === 0 && mapReduceResults.length === 0) return true

  try {
    await context.runtime.stagingArtifactsClearPendingForJob({ jobId: claim.job.jobId })
    for (const artifact of committableArtifacts) {
      await context.runtime.stagingArtifactStore({
        artifactId: artifact.artifactId,
        jobId: claim.job.jobId,
        artifactPath: artifact.artifactPath,
        targetPath: artifact.targetPath,
        operationIntent: artifact.operationIntent,
        baseHash: artifact.baseHash,
        sourceKind: artifact.sourceKind,
        markdown: artifact.markdown,
      })
      context.result.storedArtifacts += 1
    }
  } catch (err) {
    const error = `artifact-store-failed: ${sanitizeLocalArtifactError(err)}`
    await handleArtifactStoreFailure(context, claim, profileClaim, error)
    return false
  }

  if (committableArtifacts.length > 0) {
    await appendWorkerProgress(context, claim, "bulk-prepare:artifacts-stored", {
      profileId: profileClaim.profileId,
      artifactCount: committableArtifacts.length,
      skippedRepairOnlyArtifactCount: artifacts.length - committableArtifacts.length,
    })
  }

  try {
    await createMapReduceRepairJobs(context, claim, profileClaim, mapReduceResults)
  } catch (err) {
    const error = `map-reduce-repair-failed: ${sanitizeLocalArtifactError(err)}`
    await handleMapReduceRepairFailure(context, claim, profileClaim, error)
    return false
  }

  return true
}

async function handleArtifactStoreFailure(
  context: PrepareWorkerContext,
  claim: RuntimeJobClaim,
  profileClaim: RuntimeProfilePoolClaim,
  error: string,
): Promise<void> {
  context.result.artifactStoreFailures += 1
  try {
    await context.runtime.stagingArtifactsClearPendingForJob({ jobId: claim.job.jobId })
  } catch (err) {
    context.result.errors.push(`artifact-cleanup-failed: ${errorMessage(err)}`)
  }
  await createArtifactRepairJob(context, claim, error)
  await context.runtime.profilePoolRelease({
    claimId: profileClaim.claimId,
    outcome: "success",
    reason: "bulk-prepare-local-artifact-store-failed",
    error,
  })
  await failClaimedJob(context, claim, error, {
    type: "bulk-prepare:artifact-store-failed",
    profileId: profileClaim.profileId,
  })
}

async function createArtifactRepairJob(
  context: PrepareWorkerContext,
  claim: RuntimeJobClaim,
  error: string,
): Promise<void> {
  try {
    await context.runtime.createJob({
      kind: BULK_KNOWLEDGE_ARTIFACT_REPAIR_JOB_KIND,
      payload: JSON.stringify({
        kind: BULK_KNOWLEDGE_ARTIFACT_REPAIR_JOB_KIND,
        jobId: claim.job.jobId,
        sourceJobKind: claim.job.kind,
        error,
        owner: "bulk-prepare",
        strategy: "validate-and-retry",
      }),
      maxAttempts: 3,
    })
    context.result.repairJobs += 1
  } catch (err) {
    context.result.errors.push(`artifact-repair-job-failed: ${errorMessage(err)}`)
  }
}

async function createMapReduceRepairJobs(
  context: PrepareWorkerContext,
  claim: RuntimeJobClaim,
  profileClaim: RuntimeProfilePoolClaim,
  mapReduceResults: readonly LongDocumentReduceResult[],
): Promise<void> {
  const repairPayloads = mapReduceResults.flatMap((result) => {
    if ((result.status === "partial" || result.status === "failed") && result.repairJobs.length > 0) {
      context.result.partialMapReduceResults += 1
    }
    return result.repairJobs.map((repairJob) =>
      withPrepareJobMetadata(repairJob, claim),
    )
  })
  if (repairPayloads.length === 0) return

  for (const payload of repairPayloads) {
    try {
      await context.runtime.createJob({
        jobId: mapReduceRepairJobId(claim, payload),
        kind: BULK_KNOWLEDGE_MAP_REDUCE_REPAIR_JOB_KIND,
        payload: JSON.stringify(payload),
        maxAttempts: 3,
      })
      context.result.mapReduceRepairJobs += 1
    } catch (err) {
      if (!isDuplicateRuntimeJobError(err)) throw err
    }
  }
  await appendWorkerProgress(context, claim, "bulk-prepare:map-reduce-repair-routed", {
    profileId: profileClaim.profileId,
    repairJobCount: repairPayloads.length,
  })
}

async function handleMapReduceRepairFailure(
  context: PrepareWorkerContext,
  claim: RuntimeJobClaim,
  profileClaim: RuntimeProfilePoolClaim,
  error: string,
): Promise<void> {
  try {
    await context.runtime.stagingArtifactsClearPendingForJob({ jobId: claim.job.jobId })
  } catch (err) {
    context.result.errors.push(`map-reduce-repair-cleanup-failed: ${errorMessage(err)}`)
  }
  await context.runtime.profilePoolRelease({
    claimId: profileClaim.claimId,
    outcome: "success",
    reason: "bulk-prepare-local-map-reduce-repair-failed",
    error,
  })
  await failClaimedJob(context, claim, error, {
    type: "bulk-prepare:map-reduce-repair-failed",
    profileId: profileClaim.profileId,
  })
}

async function getHealthyProfilePool(
  context: PrepareWorkerContext,
): Promise<RuntimeDbHealthState> {
  try {
    const pool = await context.runtime.profilePoolList({
      kind: "model-call",
      taskFamily: PREPARE_PROFILE_TASK_FAMILY,
    })
    if (!pool.enabled) return "disabled"
    return pool.status
  } catch (err) {
    if (errorMessage(err).startsWith(RUNTIME_DISABLED_ERROR_PREFIX)) return "disabled"
    throw err
  }
}

async function runExecutor(
  context: PrepareWorkerContext,
  claim: RuntimeJobClaim,
  payload: BulkKnowledgePrepareJobPayload,
  profileClaim: RuntimeProfilePoolClaim,
): Promise<PrepareModelCallOutcome> {
  try {
    return await context.executor({
      workerId: context.workerId,
      job: claim.job,
      leaseId: claim.lease.leaseId,
      payload,
      profileClaim,
    })
  } catch (err) {
    return { status: "error", error: errorMessage(err) }
  }
}

async function failForProfileUnavailable(
  context: PrepareWorkerContext,
  claim: RuntimeJobClaim,
  message: string,
): Promise<void> {
  context.result.profileUnavailable += 1
  await failClaimedJob(context, claim, `profile-unavailable: ${message}`, {
    type: "bulk-prepare:profile-claim-failed",
  })
}

async function failClaimedJob(
  context: PrepareWorkerContext,
  claim: RuntimeJobClaim,
  error: string,
  detail: {
    retryAfterMs?: number | null
    type?: string
    profileId?: string
  } = {},
): Promise<void> {
  const progressDetails: Record<string, unknown> = { error }
  if (detail.profileId) {
    progressDetails.profileId = detail.profileId
  }
  await appendWorkerProgress(context, claim, detail.type ?? "bulk-prepare:job-failed", {
    ...progressDetails,
  })
  await context.runtime.failJob({
    ...leaseRequest(claim),
    error,
    retryAfterMs: detail.retryAfterMs,
  })
  context.result.failedJobs += 1
}

function leaseRequest(claim: RuntimeJobClaim): RuntimeJobLeaseRequest {
  return {
    jobId: claim.job.jobId,
    leaseId: claim.lease.leaseId,
  }
}

function normalizeMapReduceResults(
  mapReduceResults: Extract<PrepareModelCallOutcome, { status: "success" }>["mapReduceResults"],
): readonly LongDocumentReduceResult[] {
  if (mapReduceResults === undefined) return []
  if (Array.isArray(mapReduceResults)) {
    return mapReduceResults as readonly LongDocumentReduceResult[]
  }
  return [mapReduceResults as LongDocumentReduceResult]
}

function filterCommittableArtifacts(
  artifacts: readonly ValidatedPrepareArtifact[],
  mapReduceResults: readonly LongDocumentReduceResult[],
): readonly ValidatedPrepareArtifact[] {
  const repairOnlySources = new Set(
    mapReduceResults
      .filter((result) => result.commitPolicy === "repair-only")
      .flatMap((result) => [
        sourceKey(result.sourcePath),
        sourceKey(result.sourceIdentity),
      ]),
  )
  if (repairOnlySources.size === 0) return artifacts
  return artifacts.filter((artifact) => !repairOnlySources.has(sourceKey(artifact.sourcePath)))
}

function sourceKey(sourcePath: string): string {
  try {
    return canonicalizeBulkKnowledgeSourcePath(sourcePath)
  } catch {
    return `__invalid-bulk-knowledge-source__:${hashTextHex(sourcePath)}`
  }
}

function withPrepareJobMetadata(
  repairJob: BulkKnowledgeMapReduceRepairJobPayload,
  claim: RuntimeJobClaim,
): BulkKnowledgeMapReduceRepairJobPayload {
  return {
    kind: BULK_KNOWLEDGE_MAP_REDUCE_REPAIR_JOB_KIND,
    jobId: claim.job.jobId,
    sourceJobKind: claim.job.kind,
    sourcePath: repairJob.sourcePath,
    sourceIdentity: repairJob.sourceIdentity,
    sourceHash: repairJob.sourceHash,
    chunkId: repairJob.chunkId,
    chunkIndex: repairJob.chunkIndex,
    chunkTotal: repairJob.chunkTotal,
    chunkHash: repairJob.chunkHash,
    headingPath: "",
    status: repairJob.status,
    error: sanitizeRepairError(repairJob.error),
    owner: "bulk-map-reduce",
    strategy: "reanalyze-chunk",
  }
}

function mapReduceRepairJobId(
  claim: RuntimeJobClaim,
  repairJob: BulkKnowledgeMapReduceRepairJobPayload,
): string {
  return `bulk-map-reduce-repair-${hashTextHex([
    claim.job.jobId,
    repairJob.sourceHash,
    repairJob.chunkId,
    repairJob.chunkHash,
  ].join("\n"))}`
}

function isDuplicateRuntimeJobError(err: unknown): boolean {
  const message = errorMessage(err).toLowerCase()
  const isJobIdConstraint = message.includes("runtime_jobs.job_id")
    || message.includes("runtime_jobs_job_id")
    || message.includes("runtime_jobs_pkey")
    || message.includes("runtime_jobs.primary")
    || message.includes("for key 'primary'")
  const isConstraintFailure = message.includes("unique constraint")
    || message.includes("duplicate")
  return isJobIdConstraint && isConstraintFailure
}

async function appendWorkerProgress(
  context: PrepareWorkerContext,
  claim: RuntimeJobClaim,
  type: string,
  details: Record<string, unknown> = {},
): Promise<void> {
  await context.runtime.progressAppend({
    jobId: claim.job.jobId,
    progressKey: `bulk-prepare:worker:${context.workerId}`,
    payload: JSON.stringify({
      type,
      workerId: context.workerId,
      jobId: claim.job.jobId,
      ...details,
    }),
    durable: true,
  })
}

function parsePreparePayload(payload: string): BulkKnowledgePrepareJobPayload {
  const parsed = JSON.parse(payload) as Partial<BulkKnowledgePrepareJobPayload>
  if (parsed.kind !== BULK_KNOWLEDGE_PREPARE_JOB_KIND) {
    throw new Error("bulk-prepare-payload-kind-invalid")
  }
  if (!Number.isInteger(parsed.batchIndex)) {
    throw new Error("bulk-prepare-payload-batch-index-invalid")
  }
  if (!Array.isArray(parsed.sources)) {
    throw new Error("bulk-prepare-payload-sources-invalid")
  }
  return parsed as BulkKnowledgePrepareJobPayload
}

function normalizeConcurrency(concurrency = DEFAULT_PREPARE_WORKER_CONCURRENCY): number {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error("bulk-prepare-concurrency-invalid")
  }
  return concurrency
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  if (err === null) return "null error thrown"
  if (err === undefined) return "undefined error thrown"
  return String(err)
}

function sanitizeLocalArtifactError(err: unknown): string {
  const code = errorMessage(err).split(":", 1)[0]?.trim()
  return code && /^[a-z0-9-]+$/.test(code) ? code : "local-artifact-store-error"
}
