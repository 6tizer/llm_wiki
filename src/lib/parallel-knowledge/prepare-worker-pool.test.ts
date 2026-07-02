import { describe, expect, it } from "vitest"
import {
  BULK_KNOWLEDGE_ARTIFACT_REPAIR_JOB_KIND,
  BULK_KNOWLEDGE_PREPARE_JOB_KIND,
  BULK_KNOWLEDGE_PREPARE_OUTPUT_KIND,
  derivePrepareArtifactId,
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
