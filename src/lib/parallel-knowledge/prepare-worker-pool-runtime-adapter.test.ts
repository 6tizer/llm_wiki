import { beforeEach, describe, expect, it, vi } from "vitest"
import { BULK_KNOWLEDGE_PREPARE_JOB_KIND } from "@/core-runtime/parallel-knowledge"
import type {
  RuntimeJobClaim,
  RuntimeProfilePoolClaim,
  RuntimeProfilePoolList,
} from "@/commands/runtime-db"

const runtimeMocks = vi.hoisted(() => ({
  runtimeJobClaimByKind: vi.fn(),
  runtimeJobCreate: vi.fn(),
  runtimeJobComplete: vi.fn(),
  runtimeJobFail: vi.fn(),
  runtimeProfilePoolClaim: vi.fn(),
  runtimeProfilePoolList: vi.fn(),
  runtimeProfilePoolRelease: vi.fn(),
  runtimeProgressAppend: vi.fn(),
  runtimeStagingArtifactsClearPendingForJob: vi.fn(),
  runtimeStagingArtifactStore: vi.fn(),
}))

vi.mock("@/commands/runtime-db", () => runtimeMocks)

describe("prepare worker default runtime adapter", () => {
  beforeEach(() => {
    for (const mock of Object.values(runtimeMocks)) {
      mock.mockReset()
    }
  })

  it("routes prepare job claims and profile claims through runtime-db wrappers", async () => {
    const { PREPARE_PROFILE_TASK_FAMILY, runPrepareWorkerPool } = await import(
      "./prepare-worker-pool"
    )
    runtimeMocks.runtimeJobClaimByKind.mockResolvedValue(jobClaim("job-1"))
    runtimeMocks.runtimeProfilePoolList.mockResolvedValue(healthyPool())
    runtimeMocks.runtimeProfilePoolClaim.mockResolvedValue(profileClaim("job-1"))
    runtimeMocks.runtimeProfilePoolRelease.mockResolvedValue({
      claim: profileClaim("job-1").claim,
      circuitBreaker: null,
    })
    runtimeMocks.runtimeJobComplete.mockResolvedValue({
      ...jobClaim("job-1").job,
      state: "completed",
    })
    runtimeMocks.runtimeProgressAppend.mockImplementation(async (request) => ({
      progress: {
        jobId: request.jobId ?? "job-1",
        progressKey: request.progressKey,
        payload: request.payload,
        updatedAtMs: 1,
      },
      event: null,
    }))

    await runPrepareWorkerPool({
      concurrency: 1,
      maxJobs: 1,
      workerIdPrefix: "integration-worker",
      executor: async () => ({ status: "success" }),
    })

    expect(runtimeMocks.runtimeJobClaimByKind).toHaveBeenCalledWith({
      kind: BULK_KNOWLEDGE_PREPARE_JOB_KIND,
      holder: "integration-worker:1",
    })
    expect(runtimeMocks.runtimeProfilePoolClaim).toHaveBeenCalledWith({
      kind: "model-call",
      taskFamily: PREPARE_PROFILE_TASK_FAMILY,
      holder: "integration-worker:1",
      jobId: "job-1",
      ttlMs: 1_200_000,
    })
    expect(runtimeMocks.runtimeProfilePoolRelease).toHaveBeenCalledWith({
      claimId: "claim-job-1",
      outcome: "success",
    })
  })
})

const payload = JSON.stringify({
  kind: BULK_KNOWLEDGE_PREPARE_JOB_KIND,
  batchIndex: 0,
  sources: [{ sourcePath: "docs/a.md", sourceIdentity: "docs/a.md", duplicateCount: 0 }],
})

function jobClaim(jobId: string): RuntimeJobClaim {
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
      leaseId: `lease-${jobId}`,
      jobId,
      holder: "integration-worker:1",
      acquiredAtMs: 2,
      heartbeatAtMs: 2,
      expiresAtMs: 1_202,
      status: "active",
    },
  }
}

function profileClaim(jobId: string): RuntimeProfilePoolClaim {
  return {
    claimId: `claim-${jobId}`,
    profileId: "profile-ingest",
    expiresAtMs: 1_202,
    claim: {
      claimId: `claim-${jobId}`,
      profileId: "profile-ingest",
      kind: "model-call",
      taskFamily: "ingest",
      jobId,
      holder: "integration-worker:1",
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
