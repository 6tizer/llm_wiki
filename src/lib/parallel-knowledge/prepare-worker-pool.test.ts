import { describe, expect, it, vi } from "vitest"
import {
  BULK_KNOWLEDGE_ARTIFACT_REPAIR_JOB_KIND,
  BULK_KNOWLEDGE_MAP_REDUCE_REPAIR_JOB_KIND,
  BULK_KNOWLEDGE_PREPARE_JOB_KIND,
  BULK_KNOWLEDGE_PREPARE_OUTPUT_KIND,
  derivePrepareArtifactId,
  type BulkKnowledgeMapReduceRepairJobPayload,
  type LongDocumentReduceResult,
} from "@/core-runtime/parallel-knowledge"
import {
  PREPARE_PROFILE_TASK_FAMILY,
  runPrepareWorkerPool,
  type PrepareModelCallExecutor,
  type PrepareWorkerRuntimeAdapter,
} from "./prepare-worker-pool"
import type {
  RuntimeJobClaim,
  RuntimeProfilePoolClaim,
  RuntimeProfilePoolList,
} from "@/commands/runtime-db"

const payload = JSON.stringify({
  kind: BULK_KNOWLEDGE_PREPARE_JOB_KIND,
  batchIndex: 0,
  sources: [{ sourcePath: "docs/a.md", sourceIdentity: "docs/a.md", duplicateCount: 0 }],
})

function jobClaim(jobId: string, leaseId = `lease-${jobId}`): RuntimeJobClaim {
  return {
    job: {
      jobId,
      kind: BULK_KNOWLEDGE_PREPARE_JOB_KIND,
      payload,
      state: "running",
      attempt: 1,
      maxAttempts: 3,
      priority: 0,
      createdAtMs: 1,
      updatedAtMs: 2,
      queuedAtMs: 1,
      startedAtMs: 2,
    },
    lease: {
      leaseId,
      jobId,
      holder: "bulk-prepare:1",
      acquiredAtMs: 2,
      heartbeatAtMs: 2,
      expiresAtMs: 1_202,
      status: "active",
    },
  }
}

function profileClaim(jobId: string, claimId = `claim-${jobId}`): RuntimeProfilePoolClaim {
  return {
    claimId,
    profileId: "profile-ingest",
    expiresAtMs: 1_202,
    claim: {
      claimId,
      profileId: "profile-ingest",
      kind: "model-call",
      taskFamily: PREPARE_PROFILE_TASK_FAMILY,
      jobId,
      holder: "bulk-prepare:1",
      acquiredAtMs: 2,
      expiresAtMs: 1_202,
      status: "active",
    },
  }
}

function healthyPool(): RuntimeProfilePoolList {
  return {
    enabled: true,
    status: "healthy",
    activeClaims: [],
    circuitBreakers: [],
  }
}

function partialMapReduceResult(): LongDocumentReduceResult {
  return {
    kind: "bulk-knowledge-long-document-map-reduce-result",
    sourcePath: "docs/a.md",
    sourceIdentity: "docs/a.md",
    sourceHash: "source-hash-a",
    status: "partial",
    commitPolicy: "repair-only",
    totalChunks: 2,
    successfulChunkCount: 1,
    failedChunkCount: 1,
    lowConfidenceChunkCount: 0,
    missingChunkCount: 0,
    analysisMarkdown: "# Partial draft with private details",
    sourceContext: "chunk text must not be routed",
    failedChunks: [
      {
        chunkId: "chunk-2",
        chunkIndex: 2,
        chunkTotal: 2,
        headingPath: "Private Section",
        chunkHash: "chunk-hash-2",
        status: "failed",
        error: "provider-error",
      },
    ],
    repairJobs: [
      {
        kind: BULK_KNOWLEDGE_MAP_REDUCE_REPAIR_JOB_KIND,
        sourcePath: "docs/a.md",
        sourceIdentity: "docs/a.md",
        sourceHash: "source-hash-a",
        chunkId: "chunk-2",
        chunkIndex: 2,
        chunkTotal: 2,
        chunkHash: "chunk-hash-2",
        headingPath: "Private Section",
        status: "failed",
        error: "provider-error",
        owner: "bulk-map-reduce",
        strategy: "reanalyze-chunk",
        markdown: "# private repair draft",
        analysisMarkdown: "# private analysis",
        sourceContext: "private source context",
      } as BulkKnowledgeMapReduceRepairJobPayload,
    ],
  }
}

function partialMapReduceResultWithTwoRepairs(): LongDocumentReduceResult {
  const base = partialMapReduceResult()
  const secondFailure = {
    ...base.failedChunks[0],
    chunkId: "chunk-3",
    chunkIndex: 3,
    chunkTotal: 3,
    chunkHash: "chunk-hash-3",
  }
  const secondRepair = {
    ...base.repairJobs[0],
    chunkId: "chunk-3",
    chunkIndex: 3,
    chunkTotal: 3,
    chunkHash: "chunk-hash-3",
  }

  return {
    ...base,
    totalChunks: 3,
    failedChunkCount: 2,
    failedChunks: [...base.failedChunks, secondFailure],
    repairJobs: [...base.repairJobs, secondRepair],
  }
}

function failedMapReduceResult(): LongDocumentReduceResult {
  const base = partialMapReduceResult()
  return {
    ...base,
    status: "failed",
    successfulChunkCount: 0,
    failedChunkCount: 2,
    lowConfidenceChunkCount: 0,
  }
}

function progressPayloadTypes(
  calls: unknown[],
  options: { withProfileId?: boolean } = {},
): string[] {
  return calls.map((call) => {
    const payload = JSON.parse((call as { payload: string }).payload) as {
      type: string
      profileId?: string
    }
    if (options.withProfileId) {
      return `${payload.type}:${payload.profileId ?? "none"}`
    }
    return payload.type
  })
}

function createRuntime(claims: RuntimeJobClaim[]): PrepareWorkerRuntimeAdapter & {
  calls: Record<string, unknown[]>
} {
  const calls: Record<string, unknown[]> = {
    claimJobByKind: [],
    createJob: [],
    heartbeat: [],
    completeJob: [],
    failJob: [],
    profilePoolList: [],
    profilePoolClaim: [],
    profilePoolRelease: [],
    progressAppend: [],
    stagingArtifactStore: [],
    stagingArtifactsClearPendingForJob: [],
    sequence: [],
  }
  return {
    calls,
    async claimJobByKind(request) {
      calls.sequence.push("claimJobByKind")
      calls.claimJobByKind.push(request)
      const claim = claims.shift()
      if (!claim) throw new Error("no-queued-job: no queued runtime job is available")
      return claim
    },
    async createJob(request) {
      calls.sequence.push("createJob")
      calls.createJob.push(request)
      return { ...jobClaim("repair-1").job, kind: request.kind, payload: request.payload }
    },
    async heartbeat(request) {
      calls.sequence.push("heartbeat")
      calls.heartbeat.push(request)
      return jobClaim(request.jobId, request.leaseId)
    },
    async completeJob(request) {
      calls.sequence.push("completeJob")
      calls.completeJob.push(request)
      return { ...jobClaim(request.jobId).job, state: "completed" }
    },
    async failJob(request) {
      calls.sequence.push("failJob")
      calls.failJob.push(request)
      return { ...jobClaim(request.jobId).job, state: "retry-wait", lastError: request.error }
    },
    async profilePoolList(request) {
      calls.sequence.push("profilePoolList")
      calls.profilePoolList.push(request)
      return healthyPool()
    },
    async profilePoolClaim(request) {
      calls.sequence.push("profilePoolClaim")
      calls.profilePoolClaim.push(request)
      return profileClaim(request.jobId ?? "job")
    },
    async profilePoolRelease(request) {
      calls.sequence.push("profilePoolRelease")
      calls.profilePoolRelease.push(request)
      return {
        claim: profileClaim("job", request.claimId).claim,
        circuitBreaker: null,
      }
    },
    async progressAppend(request) {
      calls.sequence.push("progressAppend")
      calls.progressAppend.push(request)
      return {
        progress: {
          jobId: request.jobId ?? "job",
          progressKey: request.progressKey,
          payload: request.payload,
          updatedAtMs: 1,
          lastEventId: "event-1",
        },
        event: {
          eventId: "event-1",
          jobId: request.jobId ?? "job",
          eventName: "job-runtime:progress-appended",
          payload: request.payload,
          createdAtMs: 1,
        },
      }
    },
    async stagingArtifactStore(request) {
      calls.sequence.push("stagingArtifactStore")
      calls.stagingArtifactStore.push(request)
      return {
        artifactId: request.artifactId,
        jobId: request.jobId,
        artifactPath: request.artifactPath,
        artifactHash: "sha256:artifact",
        targetPath: request.targetPath,
        operationIntent: request.operationIntent,
        baseHash: request.baseHash,
        sourceKind: request.sourceKind,
        status: "pending",
        createdAtMs: 1,
        updatedAtMs: 1,
      }
    },
    async stagingArtifactsClearPendingForJob(request) {
      calls.sequence.push("stagingArtifactsClearPendingForJob")
      calls.stagingArtifactsClearPendingForJob.push(request)
      return { cleared: [] }
    },
  }
}

it("claims only prepare jobs and routes them through model-call ingest profiles", async () => {
  const runtime = createRuntime([jobClaim("job-1"), jobClaim("job-2")])
  let active = 0
  let maxActive = 0
  const executor: PrepareModelCallExecutor = async () => {
    active += 1
    maxActive = Math.max(maxActive, active)
    await new Promise((resolve) => setTimeout(resolve, 0))
    active -= 1
    return { status: "success" }
  }

  const result = await runPrepareWorkerPool({
    runtime,
    executor,
    concurrency: 2,
    maxJobs: 2,
    workerIdPrefix: "test-worker",
  })

  expect(result).toMatchObject({ claimedJobs: 2, completedJobs: 2, failedJobs: 0 })
  expect(maxActive).toBe(2)
  expect(runtime.calls.claimJobByKind).toEqual(expect.arrayContaining([
    { kind: BULK_KNOWLEDGE_PREPARE_JOB_KIND, holder: "test-worker:1" },
    { kind: BULK_KNOWLEDGE_PREPARE_JOB_KIND, holder: "test-worker:2" },
  ]))
  expect(runtime.calls.profilePoolClaim).toEqual(expect.arrayContaining([
    {
      kind: "model-call",
      taskFamily: PREPARE_PROFILE_TASK_FAMILY,
      holder: "test-worker:1",
      jobId: "job-1",
      ttlMs: 1_200_000,
    },
    {
      kind: "model-call",
      taskFamily: PREPARE_PROFILE_TASK_FAMILY,
      holder: "test-worker:2",
      jobId: "job-2",
      ttlMs: 1_200_000,
    },
  ]))
  expect(runtime.calls.profilePoolRelease).toEqual(expect.arrayContaining([
    { claimId: "claim-job-1", outcome: "success" },
    { claimId: "claim-job-2", outcome: "success" },
  ]))
})

it("exits as no-op when runtime job claim reports runtime disabled", async () => {
  const runtime = createRuntime([])
  runtime.claimJobByKind = async () => {
    throw new Error("runtime-disabled: work runtime is disabled")
  }

  const result = await runPrepareWorkerPool({
    runtime,
    executor: async () => ({ status: "success" }),
    concurrency: 1,
  })

  expect(result).toMatchObject({
    claimedJobs: 0,
    completedJobs: 0,
    failedJobs: 0,
    runtimeDisabled: true,
  })
  expect(runtime.calls.profilePoolClaim).toEqual([])
})

it("treats no queued prepare jobs as idle without recording worker errors", async () => {
  const runtime = createRuntime([])

  const result = await runPrepareWorkerPool({
    runtime,
    executor: async () => ({ status: "success" }),
    concurrency: 2,
  })

  expect(result).toMatchObject({
    claimedJobs: 0,
    completedJobs: 0,
    failedJobs: 0,
    idleWorkers: 2,
    errors: [],
  })
  expect(runtime.calls.profilePoolClaim).toEqual([])
})

it("fails a claimed job when the model-call profile pool is not healthy", async () => {
  const runtime = createRuntime([jobClaim("job-1")])
  runtime.profilePoolList = async (request) => {
    runtime.calls.profilePoolList.push(request)
    return { ...healthyPool(), status: "no-project" }
  }

  const result = await runPrepareWorkerPool({
    runtime,
    executor: async () => ({ status: "success" }),
    concurrency: 1,
    maxJobs: 1,
  })

  expect(result).toMatchObject({
    claimedJobs: 1,
    failedJobs: 1,
    profileUnavailable: 1,
  })
  expect(runtime.calls.profilePoolClaim).toEqual([])
  expect(runtime.calls.failJob).toEqual([
    {
      jobId: "job-1",
      leaseId: "lease-job-1",
      error: "profile-unavailable: profile pool is no-project",
      retryAfterMs: undefined,
    },
  ])
})

it("releases rate-limited profiles with retryAfterMs before failing the job", async () => {
  const runtime = createRuntime([jobClaim("job-1")])

  const result = await runPrepareWorkerPool({
    runtime,
    executor: async () => ({
      status: "rate-limited",
      retryAfterMs: 60_000,
      error: "provider 429",
    }),
    concurrency: 1,
    maxJobs: 1,
  })

  expect(result).toMatchObject({ failedJobs: 1, rateLimited: 1 })
  expect(runtime.calls.profilePoolRelease).toEqual([
    {
      claimId: "claim-job-1",
      outcome: "rate-limited",
      retryAfterMs: 60_000,
      reason: "bulk-prepare-rate-limited",
      error: "provider 429",
    },
  ])
  expect(runtime.calls.failJob).toEqual([
    {
      jobId: "job-1",
      leaseId: "lease-job-1",
      error: "provider 429",
      retryAfterMs: undefined,
    },
  ])
})

it("releases errored profiles with circuit hints before failing the job", async () => {
  const runtime = createRuntime([jobClaim("job-1")])

  const result = await runPrepareWorkerPool({
    runtime,
    executor: async () => ({
      status: "error",
      error: "provider 500",
      circuitOpenMs: 45_000,
      jobRetryAfterMs: 30_000,
    }),
    concurrency: 1,
    maxJobs: 1,
    workerIdPrefix: "test-worker",
  })

  expect(result).toMatchObject({ failedJobs: 1 })
  expect(runtime.calls.profilePoolRelease).toEqual([
    {
      claimId: "claim-job-1",
      outcome: "error",
      circuitOpenMs: 45_000,
      reason: "bulk-prepare-error",
      error: "provider 500",
    },
  ])
  expect(runtime.calls.failJob).toEqual([
    {
      jobId: "job-1",
      leaseId: "lease-job-1",
      error: "provider 500",
      retryAfterMs: 30_000,
    },
  ])
  expect(progressPayloadTypes(runtime.calls.progressAppend, { withProfileId: true })).toEqual([
    "bulk-prepare:job-claimed:none",
    "bulk-prepare:job-failed:profile-ingest",
  ])
})

it("records profile claim failure as worker-owned progress without releasing a profile", async () => {
  const runtime = createRuntime([jobClaim("job-1")])
  runtime.profilePoolClaim = async (request) => {
    runtime.calls.profilePoolClaim.push(request)
    throw new Error("no-eligible-profile: no profile pool capacity is available")
  }

  const result = await runPrepareWorkerPool({
    runtime,
    executor: async () => ({ status: "success" }),
    concurrency: 1,
    maxJobs: 1,
    workerIdPrefix: "test-worker",
  })

  expect(result).toMatchObject({
    claimedJobs: 1,
    failedJobs: 1,
    profileUnavailable: 1,
  })
  expect(runtime.calls.profilePoolRelease).toEqual([])
  expect(runtime.calls.failJob).toEqual([
    {
      jobId: "job-1",
      leaseId: "lease-job-1",
      error:
        "profile-unavailable: no-eligible-profile: no profile pool capacity is available",
      retryAfterMs: undefined,
    },
  ])
  expect(progressPayloadTypes(runtime.calls.progressAppend)).toEqual([
    "bulk-prepare:job-claimed",
    "bulk-prepare:profile-claim-failed",
  ])
})

it("keeps worker timeline semantics in progress payload JSON", async () => {
  const runtime = createRuntime([jobClaim("job-1")])

  await runPrepareWorkerPool({
    runtime,
    executor: async () => ({ status: "success" }),
    concurrency: 1,
    maxJobs: 1,
    workerIdPrefix: "test-worker",
  })

  expect(progressPayloadTypes(runtime.calls.progressAppend)).toEqual([
    "bulk-prepare:job-claimed",
    "bulk-prepare:job-completed",
  ])
})

it("validates and stores successful prepare artifacts before completing a job", async () => {
  const runtime = createRuntime([jobClaim("job-1")])

  const result = await runPrepareWorkerPool({
    runtime,
    executor: async () => ({
      status: "success",
      artifacts: [
        {
          kind: BULK_KNOWLEDGE_PREPARE_OUTPUT_KIND,
          sourcePath: "docs/a.md",
          targetPath: "Wiki/Page.md",
          artifactPath: "job-1/page.md",
          operationIntent: "create",
          sourceKind: "ingest",
          markdown: "# Page\n",
          baseHash: null,
        },
      ],
    }),
    concurrency: 1,
    maxJobs: 1,
  })

  expect(result).toMatchObject({
    completedJobs: 1,
    storedArtifacts: 1,
    artifactStoreFailures: 0,
  })
  expect(runtime.calls.stagingArtifactsClearPendingForJob).toEqual([{ jobId: "job-1" }])
  expect(runtime.calls.stagingArtifactStore).toEqual([
    expect.objectContaining({
      artifactId: derivePrepareArtifactId("job-1", "wiki/page.md"),
      jobId: "job-1",
      targetPath: "Wiki/Page.md",
      artifactPath: "job-1/page.md",
      operationIntent: "create",
      sourceKind: "ingest",
      markdown: "# Page\n",
    }),
  ])
  expect(runtime.calls.completeJob).toEqual([{ jobId: "job-1", leaseId: "lease-job-1" }])
  expect(progressPayloadTypes(runtime.calls.progressAppend)).toEqual([
    "bulk-prepare:job-claimed",
    "bulk-prepare:artifacts-stored",
    "bulk-prepare:job-completed",
  ])
})

it("routes partial map-reduce chunks to repair and skips repair-only source artifacts", async () => {
  const runtime = createRuntime([jobClaim("job-1")])

  const result = await runPrepareWorkerPool({
    runtime,
    executor: async () => ({
      status: "success",
      mapReduceResults: partialMapReduceResult(),
      artifacts: [
        {
          kind: BULK_KNOWLEDGE_PREPARE_OUTPUT_KIND,
          sourcePath: "docs/a.md",
          targetPath: "Wiki/Partial.md",
          artifactPath: "job-1/partial.md",
          operationIntent: "create",
          sourceKind: "ingest",
          markdown: "# Partial draft with secret sk-test-secret\n",
          baseHash: null,
        },
        {
          kind: BULK_KNOWLEDGE_PREPARE_OUTPUT_KIND,
          sourcePath: "docs/b.md",
          targetPath: "Wiki/Complete.md",
          artifactPath: "job-1/complete.md",
          operationIntent: "create",
          sourceKind: "ingest",
          markdown: "# Complete\n",
          baseHash: null,
        },
      ],
    }),
    concurrency: 1,
    maxJobs: 1,
  })

  expect(result).toMatchObject({
    completedJobs: 1,
    storedArtifacts: 1,
    mapReduceRepairJobs: 1,
    partialMapReduceResults: 1,
  })
  expect(runtime.calls.stagingArtifactStore).toHaveLength(1)
  expect(runtime.calls.stagingArtifactStore[0]).toMatchObject({
    targetPath: "Wiki/Complete.md",
    artifactPath: "job-1/complete.md",
    markdown: "# Complete\n",
  })
  expect(runtime.calls.createJob).toEqual([
    expect.objectContaining({
      jobId: expect.stringMatching(/^bulk-map-reduce-repair-[0-9a-f]{16}$/),
      kind: BULK_KNOWLEDGE_MAP_REDUCE_REPAIR_JOB_KIND,
      maxAttempts: 3,
    }),
  ])
  const repairPayload = JSON.parse((runtime.calls.createJob[0] as { payload: string }).payload)
  expect(repairPayload).toMatchObject({
    kind: BULK_KNOWLEDGE_MAP_REDUCE_REPAIR_JOB_KIND,
    jobId: "job-1",
    sourceJobKind: BULK_KNOWLEDGE_PREPARE_JOB_KIND,
    sourcePath: "docs/a.md",
    chunkId: "chunk-2",
    headingPath: "",
    error: "provider-error",
  })
  expect(repairPayload).not.toHaveProperty("markdown")
  expect(repairPayload).not.toHaveProperty("artifactPath")
  expect(repairPayload).not.toHaveProperty("analysisMarkdown")
  expect(repairPayload).not.toHaveProperty("sourceContext")
  expect(JSON.stringify(repairPayload)).not.toContain("Private Section")
  expect(JSON.stringify(repairPayload)).not.toContain("sk-test-secret")
  expect(JSON.stringify(repairPayload)).not.toContain("chunk text must not be routed")
  expect(runtime.calls.sequence).toEqual([
    "claimJobByKind",
    "progressAppend",
    "profilePoolList",
    "profilePoolClaim",
    "stagingArtifactsClearPendingForJob",
    "stagingArtifactStore",
    "progressAppend",
    "createJob",
    "progressAppend",
    "profilePoolRelease",
    "completeJob",
    "progressAppend",
  ])
  expect(progressPayloadTypes(runtime.calls.progressAppend)).toEqual([
    "bulk-prepare:job-claimed",
    "bulk-prepare:artifacts-stored",
    "bulk-prepare:map-reduce-repair-routed",
    "bulk-prepare:job-completed",
  ])
})

it("sanitizes executor-provided map-reduce repair errors before creating repair jobs", async () => {
  const runtime = createRuntime([jobClaim("job-1")])
  const unsafe = partialMapReduceResult()
  const unsafeRepairResult: LongDocumentReduceResult = {
    ...unsafe,
    repairJobs: [
      {
        ...unsafe.repairJobs[0],
        error: "sk-worker-secret: provider error",
      },
    ],
  }

  const result = await runPrepareWorkerPool({
    runtime,
    executor: async () => ({
      status: "success",
      mapReduceResults: unsafeRepairResult,
    }),
    concurrency: 1,
    maxJobs: 1,
  })

  expect(result).toMatchObject({
    completedJobs: 1,
    mapReduceRepairJobs: 1,
  })
  const repairPayload = JSON.parse((runtime.calls.createJob[0] as { payload: string }).payload)
  expect(repairPayload.error).toBe("map-chunk-failed")
  expect(JSON.stringify(repairPayload)).not.toContain("sk-worker-secret")
})

it("uses deterministic map-reduce repair job ids so retries can skip already-created jobs", async () => {
  const firstRuntime = createRuntime([jobClaim("job-1")])
  let firstCreateCount = 0
  firstRuntime.createJob = async (request) => {
    firstRuntime.calls.sequence.push("createJob")
    firstRuntime.calls.createJob.push(request)
    firstCreateCount += 1
    if (firstCreateCount === 2) {
      throw new Error("job-create-failed: queue unavailable")
    }
    return { ...jobClaim(request.jobId ?? "repair-1").job, kind: request.kind, payload: request.payload }
  }

  const executor = async () => ({
    status: "success" as const,
    mapReduceResults: partialMapReduceResultWithTwoRepairs(),
  })
  const firstResult = await runPrepareWorkerPool({
    runtime: firstRuntime,
    executor,
    concurrency: 1,
    maxJobs: 1,
  })

  expect(firstResult).toMatchObject({
    completedJobs: 0,
    failedJobs: 1,
    mapReduceRepairJobs: 1,
  })
  const firstRepairJobId = (firstRuntime.calls.createJob[0] as { jobId?: string }).jobId
  expect(firstRepairJobId).toMatch(/^bulk-map-reduce-repair-[0-9a-f]{16}$/)

  const retryRuntime = createRuntime([jobClaim("job-1")])
  retryRuntime.createJob = async (request) => {
    retryRuntime.calls.sequence.push("createJob")
    retryRuntime.calls.createJob.push(request)
    if (request.jobId === firstRepairJobId) {
      throw new Error("UNIQUE constraint failed: runtime_jobs.job_id")
    }
    return { ...jobClaim(request.jobId ?? "repair-2").job, kind: request.kind, payload: request.payload }
  }

  const retryResult = await runPrepareWorkerPool({
    runtime: retryRuntime,
    executor,
    concurrency: 1,
    maxJobs: 1,
  })

  expect(retryResult).toMatchObject({
    completedJobs: 1,
    failedJobs: 0,
    mapReduceRepairJobs: 1,
  })
  expect(retryRuntime.calls.createJob).toHaveLength(2)
  expect((retryRuntime.calls.createJob[0] as { jobId?: string }).jobId).toBe(firstRepairJobId)
  expect((retryRuntime.calls.createJob[1] as { jobId?: string }).jobId).not.toBe(firstRepairJobId)
  expect(retryRuntime.calls.completeJob).toEqual([{ jobId: "job-1", leaseId: "lease-job-1" }])
})

it("recognizes common duplicate job-id error shapes across database dialects", async () => {
  const duplicateMessages = [
    "duplicate key value violates unique constraint \"runtime_jobs_job_id_key\"",
    "duplicate key value violates unique constraint \"runtime_jobs_pkey\"",
    "Duplicate entry 'repair-1' for key 'PRIMARY'",
  ]

  for (const duplicateMessage of duplicateMessages) {
    const runtime = createRuntime([jobClaim("job-1")])
    runtime.createJob = async (request) => {
      runtime.calls.sequence.push("createJob")
      runtime.calls.createJob.push(request)
      throw new Error(duplicateMessage)
    }

    const result = await runPrepareWorkerPool({
      runtime,
      executor: async () => ({
        status: "success",
        mapReduceResults: partialMapReduceResult(),
      }),
      concurrency: 1,
      maxJobs: 1,
    })

    expect(result).toMatchObject({
      completedJobs: 1,
      failedJobs: 0,
      mapReduceRepairJobs: 0,
    })
  }
})

it("does not swallow non-duplicate runtime job create failures", async () => {
  const runtime = createRuntime([jobClaim("job-1")])
  runtime.createJob = async (request) => {
    runtime.calls.sequence.push("createJob")
    runtime.calls.createJob.push(request)
    throw new Error("CHECK constraint failed: runtime_jobs.job_id")
  }

  const result = await runPrepareWorkerPool({
    runtime,
    executor: async () => ({
      status: "success",
      mapReduceResults: partialMapReduceResult(),
    }),
    concurrency: 1,
    maxJobs: 1,
  })

  expect(result).toMatchObject({
    completedJobs: 0,
    failedJobs: 1,
    mapReduceRepairJobs: 0,
  })
  expect(runtime.calls.failJob).toHaveLength(1)
})

it("counts failed map-reduce results that route repair jobs", async () => {
  const runtime = createRuntime([jobClaim("job-1")])

  const result = await runPrepareWorkerPool({
    runtime,
    executor: async () => ({
      status: "success",
      mapReduceResults: failedMapReduceResult(),
    }),
    concurrency: 1,
    maxJobs: 1,
  })

  expect(result).toMatchObject({
    completedJobs: 1,
    mapReduceRepairJobs: 1,
    partialMapReduceResults: 1,
  })
})

it("clears pending artifacts and fails the job when map-reduce repair routing fails", async () => {
  const runtime = createRuntime([jobClaim("job-1")])
  runtime.createJob = async (request) => {
    runtime.calls.sequence.push("createJob")
    runtime.calls.createJob.push(request)
    throw new Error("runtime-create-job-failed: queue unavailable")
  }

  const result = await runPrepareWorkerPool({
    runtime,
    executor: async () => ({
      status: "success",
      mapReduceResults: partialMapReduceResult(),
      artifacts: [
        {
          kind: BULK_KNOWLEDGE_PREPARE_OUTPUT_KIND,
          sourcePath: "docs/b.md",
          targetPath: "Wiki/Complete.md",
          artifactPath: "job-1/complete.md",
          operationIntent: "create",
          sourceKind: "ingest",
          markdown: "# Complete\n",
          baseHash: null,
        },
      ],
    }),
    concurrency: 1,
    maxJobs: 1,
  })

  expect(result).toMatchObject({
    completedJobs: 0,
    failedJobs: 1,
    storedArtifacts: 1,
    mapReduceRepairJobs: 0,
  })
  expect(runtime.calls.stagingArtifactsClearPendingForJob).toEqual([
    { jobId: "job-1" },
    { jobId: "job-1" },
  ])
  expect(runtime.calls.completeJob).toEqual([])
  expect(runtime.calls.profilePoolRelease).toEqual([
    {
      claimId: "claim-job-1",
      outcome: "success",
      reason: "bulk-prepare-local-map-reduce-repair-failed",
      error: "map-reduce-repair-failed: runtime-create-job-failed",
    },
  ])
  expect(runtime.calls.failJob).toEqual([
    {
      jobId: "job-1",
      leaseId: "lease-job-1",
      error: "map-reduce-repair-failed: runtime-create-job-failed",
      retryAfterMs: undefined,
    },
  ])
  expect(progressPayloadTypes(runtime.calls.progressAppend)).toEqual([
    "bulk-prepare:job-claimed",
    "bulk-prepare:artifacts-stored",
    "bulk-prepare:map-reduce-repair-failed",
  ])
})

it("cleans pending artifacts and releases profile as success on local artifact failure", async () => {
  const runtime = createRuntime([jobClaim("job-1")])
  runtime.stagingArtifactStore = async (request) => {
    runtime.calls.sequence.push("stagingArtifactStore")
    runtime.calls.stagingArtifactStore.push(request)
    throw new Error("staging-artifact-write-failed: failed to write /tmp/job-1/page.md # Page")
  }

  const result = await runPrepareWorkerPool({
    runtime,
    executor: async () => ({
      status: "success",
      artifacts: [
        {
          kind: BULK_KNOWLEDGE_PREPARE_OUTPUT_KIND,
          sourcePath: "docs/a.md",
          targetPath: "Wiki/Page.md",
          artifactPath: "job-1/page.md",
          operationIntent: "create",
          sourceKind: "ingest",
          markdown: "# Page\n",
          baseHash: null,
        },
      ],
    }),
    concurrency: 1,
    maxJobs: 1,
  })

  expect(result).toMatchObject({
    failedJobs: 1,
    artifactStoreFailures: 1,
    repairJobs: 1,
  })
  expect(runtime.calls.stagingArtifactsClearPendingForJob).toEqual([
    { jobId: "job-1" },
    { jobId: "job-1" },
  ])
  expect(runtime.calls.profilePoolRelease).toEqual([
    {
      claimId: "claim-job-1",
      outcome: "success",
      reason: "bulk-prepare-local-artifact-store-failed",
      error: "artifact-store-failed: staging-artifact-write-failed",
    },
  ])
  expect(runtime.calls.createJob).toEqual([
    expect.objectContaining({
      kind: BULK_KNOWLEDGE_ARTIFACT_REPAIR_JOB_KIND,
      maxAttempts: 3,
    }),
  ])
  const repairPayload = JSON.parse((runtime.calls.createJob[0] as { payload: string }).payload)
  expect(repairPayload).toMatchObject({
    kind: BULK_KNOWLEDGE_ARTIFACT_REPAIR_JOB_KIND,
    jobId: "job-1",
  })
  expect(repairPayload).not.toHaveProperty("markdown")
  expect(repairPayload).not.toHaveProperty("artifactPath")
  expect(repairPayload).not.toHaveProperty("artifactHash")
  expect(JSON.stringify(repairPayload)).not.toContain("# Page")
  expect(JSON.stringify(repairPayload)).not.toContain("job-1/page.md")
  expect(runtime.calls.sequence).toEqual([
    "claimJobByKind",
    "progressAppend",
    "profilePoolList",
    "profilePoolClaim",
    "stagingArtifactsClearPendingForJob",
    "stagingArtifactStore",
    "stagingArtifactsClearPendingForJob",
    "createJob",
    "profilePoolRelease",
    "progressAppend",
    "failJob",
  ])
  expect(runtime.calls.failJob).toEqual([
    {
      jobId: "job-1",
      leaseId: "lease-job-1",
      error: "artifact-store-failed: staging-artifact-write-failed",
      retryAfterMs: undefined,
    },
  ])
})

it("fails local staging when prepare artifacts are not an array", async () => {
  const runtime = createRuntime([jobClaim("job-1")])

  const result = await runPrepareWorkerPool({
    runtime,
    executor: async () =>
      ({
        status: "success",
        artifacts: { kind: BULK_KNOWLEDGE_PREPARE_OUTPUT_KIND },
      }) as unknown as Awaited<ReturnType<PrepareModelCallExecutor>>,
    concurrency: 1,
    maxJobs: 1,
  })

  expect(result).toMatchObject({
    failedJobs: 1,
    artifactStoreFailures: 1,
    repairJobs: 1,
  })
  expect(runtime.calls.stagingArtifactStore).toEqual([])
  expect(runtime.calls.profilePoolRelease).toEqual([
    {
      claimId: "claim-job-1",
      outcome: "success",
      reason: "bulk-prepare-local-artifact-store-failed",
      error: "artifact-store-failed: prepare-artifacts-invalid",
    },
  ])
})

describe("runPrepareWorkerPool validation", () => {
  it("rejects invalid concurrency", async () => {
    await expect(
      runPrepareWorkerPool({
        runtime: createRuntime([]),
        executor: async () => ({ status: "success" }),
        concurrency: 0,
      }),
    ).rejects.toThrow("bulk-prepare-concurrency-invalid")
  })
})

describe("job heartbeat during long model-call executor runs", () => {
  it("renews the claimed job lease on a fixed interval while the executor is running, and stops once it settles", async () => {
    vi.useFakeTimers()
    try {
      const runtime = createRuntime([jobClaim("job-1")])
      let resolveExecutor: (() => void) | undefined
      const executor: PrepareModelCallExecutor = () =>
        new Promise((resolve) => {
          resolveExecutor = () => resolve({ status: "success" })
        })

      const poolPromise = runPrepareWorkerPool({
        runtime,
        executor,
        concurrency: 1,
        maxJobs: 1,
      })

      // Let the worker claim the job, claim a profile, and reach the
      // (still-pending) executor call.
      await vi.advanceTimersByTimeAsync(0)
      expect(runtime.calls.heartbeat).toEqual([])

      await vi.advanceTimersByTimeAsync(5_000)
      expect(runtime.calls.heartbeat).toEqual([{ jobId: "job-1", leaseId: "lease-job-1" }])

      await vi.advanceTimersByTimeAsync(5_000)
      expect(runtime.calls.heartbeat).toHaveLength(2)

      // Simulate the slow LLM call spanning the 120s lease TTL: keep
      // heartbeating well past it, and completeJob must still succeed.
      await vi.advanceTimersByTimeAsync(115_000)
      expect(runtime.calls.heartbeat.length).toBeGreaterThanOrEqual(23)

      resolveExecutor?.()
      const result = await poolPromise
      expect(result).toMatchObject({ completedJobs: 1, failedJobs: 0, errors: [] })
      expect(runtime.calls.completeJob).toEqual([{ jobId: "job-1", leaseId: "lease-job-1" }])

      const heartbeatCountAtCompletion = runtime.calls.heartbeat.length
      await vi.advanceTimersByTimeAsync(30_000)
      expect(runtime.calls.heartbeat).toHaveLength(heartbeatCountAtCompletion)
    } finally {
      vi.useRealTimers()
    }
  })

  it("stops heartbeating immediately when the executor fails, before the job is marked failed", async () => {
    vi.useFakeTimers()
    try {
      const runtime = createRuntime([jobClaim("job-1")])
      let rejectExecutor: ((err: Error) => void) | undefined
      const executor: PrepareModelCallExecutor = () =>
        new Promise((_resolve, reject) => {
          rejectExecutor = reject
        })

      const poolPromise = runPrepareWorkerPool({
        runtime,
        executor,
        concurrency: 1,
        maxJobs: 1,
      })

      await vi.advanceTimersByTimeAsync(5_000)
      expect(runtime.calls.heartbeat).toHaveLength(1)

      rejectExecutor?.(new Error("provider timeout"))
      const result = await poolPromise
      expect(result).toMatchObject({ failedJobs: 1, completedJobs: 0 })

      const heartbeatCountAtFailure = runtime.calls.heartbeat.length
      await vi.advanceTimersByTimeAsync(20_000)
      expect(runtime.calls.heartbeat).toHaveLength(heartbeatCountAtFailure)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe("bookkeeping resilience", () => {
  it("does not reject the pool and still counts the job complete when completeJob bookkeeping throws", async () => {
    const runtime = createRuntime([jobClaim("job-1")])
    runtime.completeJob = async (request) => {
      runtime.calls.sequence.push("completeJob")
      runtime.calls.completeJob.push(request)
      throw new Error("lease-expired: job-1")
    }

    const result = await runPrepareWorkerPool({
      runtime,
      executor: async () => ({ status: "success" }),
      concurrency: 1,
      maxJobs: 1,
    })

    expect(result.completedJobs).toBe(1)
    expect(result.errors).toEqual([
      expect.stringContaining("complete-job-failed: lease-expired: job-1"),
    ])
    expect(runtime.calls.profilePoolRelease).toEqual([
      { claimId: "claim-job-1", outcome: "success" },
    ])
  })

  it("does not reject the pool when profilePoolRelease bookkeeping throws on the success path", async () => {
    const runtime = createRuntime([jobClaim("job-1")])
    runtime.profilePoolRelease = async (request) => {
      runtime.calls.sequence.push("profilePoolRelease")
      runtime.calls.profilePoolRelease.push(request)
      throw new Error("profile-pool-release-unavailable")
    }

    const result = await runPrepareWorkerPool({
      runtime,
      executor: async () => ({ status: "success" }),
      concurrency: 1,
      maxJobs: 1,
    })

    expect(result.completedJobs).toBe(1)
    expect(result.errors).toEqual([
      expect.stringContaining("profile-pool-release-failed: profile-pool-release-unavailable"),
    ])
    expect(runtime.calls.completeJob).toEqual([{ jobId: "job-1", leaseId: "lease-job-1" }])
  })

  it("does not reject the pool when progress-append bookkeeping throws", async () => {
    const runtime = createRuntime([jobClaim("job-1")])
    runtime.progressAppend = async (request) => {
      runtime.calls.sequence.push("progressAppend")
      runtime.calls.progressAppend.push(request)
      throw new Error("progress-append-unavailable")
    }

    const result = await runPrepareWorkerPool({
      runtime,
      executor: async () => ({ status: "success" }),
      concurrency: 1,
      maxJobs: 1,
    })

    expect(result.completedJobs).toBe(1)
    expect(result.errors.filter((e) => e.startsWith("progress-append-failed"))).toHaveLength(2)
  })

  it("does not reject the pool when failJob bookkeeping throws on the failure path", async () => {
    const runtime = createRuntime([jobClaim("job-1")])
    runtime.failJob = async (request) => {
      runtime.calls.sequence.push("failJob")
      runtime.calls.failJob.push(request)
      throw new Error("lease-expired: job-1")
    }

    const result = await runPrepareWorkerPool({
      runtime,
      executor: async () => ({ status: "error", error: "provider 500" }),
      concurrency: 1,
      maxJobs: 1,
    })

    expect(result.failedJobs).toBe(1)
    expect(result.errors).toEqual([
      expect.stringContaining("fail-job-failed: lease-expired: job-1"),
    ])
  })

  it("fails the job instead of crashing the pool when the profile pool health check throws unexpectedly", async () => {
    const runtime = createRuntime([jobClaim("job-1")])
    runtime.profilePoolList = async (request) => {
      runtime.calls.profilePoolList.push(request)
      throw new Error("profile-pool-list-unavailable")
    }

    const result = await runPrepareWorkerPool({
      runtime,
      executor: async () => ({ status: "success" }),
      concurrency: 1,
      maxJobs: 1,
    })

    expect(result).toMatchObject({ claimedJobs: 1, failedJobs: 1, profileUnavailable: 1 })
    expect(runtime.calls.profilePoolClaim).toEqual([])
    expect(runtime.calls.failJob).toEqual([
      {
        jobId: "job-1",
        leaseId: "lease-job-1",
        error: "profile-unavailable: profile-pool-list-unavailable",
        retryAfterMs: undefined,
      },
    ])
  })
})

describe("sibling worker isolation", () => {
  it("keeps one worker's unexpected job failure from crashing or discarding results from sibling workers", async () => {
    const runtime = createRuntime([jobClaim("job-1"), jobClaim("job-2")])
    let call = 0
    runtime.profilePoolList = async (request) => {
      runtime.calls.profilePoolList.push(request)
      call += 1
      if (call === 1) throw new Error("profile-pool-list-unavailable")
      return healthyPool()
    }

    const result = await runPrepareWorkerPool({
      runtime,
      executor: async () => ({ status: "success" }),
      concurrency: 2,
      maxJobs: 2,
    })

    expect(result.claimedJobs).toBe(2)
    expect(result.completedJobs).toBe(1)
    expect(result.failedJobs).toBe(1)
    expect(result.profileUnavailable).toBe(1)
    // The pool must still return the full aggregated result rather than
    // reject or drop the sibling worker's outcome.
    expect(result.errors).toEqual([])
  })
})
