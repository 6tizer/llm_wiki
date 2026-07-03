import { beforeEach, describe, expect, it, vi } from "vitest"
import { BULK_KNOWLEDGE_PREPARE_JOB_KIND } from "@/core-runtime/parallel-knowledge"
import type { RuntimeJobClaim, RuntimeProfilePoolClaim, RuntimeProfilePoolList } from "@/commands/runtime-db"
import type { CommitIntegrationRuntimeAdapter } from "./commit-integration"

const runtimeMocks = vi.hoisted(() => ({
  runtimeJobClaimByKind: vi.fn(),
  runtimeJobCreate: vi.fn(),
  runtimeJobHeartbeat: vi.fn(),
  runtimeJobComplete: vi.fn(),
  runtimeJobFail: vi.fn(),
  runtimeProfilePoolClaim: vi.fn(),
  runtimeProfilePoolList: vi.fn(),
  runtimeProfilePoolRelease: vi.fn(),
  runtimeProgressAppend: vi.fn(),
  runtimeStagingArtifactsClearPendingForJob: vi.fn(),
  runtimeStagingArtifactStore: vi.fn(),
  // Referenced by commit-integration.ts's module-scope defaultRuntime object
  // (only constructed, never called, since every test below passes an
  // explicit commitRuntime override -- see emptyCommitRuntime()).
  runtimeCommitBudgetClaim: vi.fn(),
  runtimeCommitBudgetRelease: vi.fn(),
  runtimeDerivedStaleMarkerRecord: vi.fn(),
  runtimeEventAppend: vi.fn(),
  runtimeStagingArtifactCommitSuccess: vi.fn(),
  runtimeStagingArtifactList: vi.fn(),
  runtimeStagingArtifactRecord: vi.fn(),
  runtimeStagingArtifactReadBody: vi.fn(),
}))

vi.mock("@/commands/runtime-db", () => runtimeMocks)

const payload = JSON.stringify({
  kind: BULK_KNOWLEDGE_PREPARE_JOB_KIND,
  batchIndex: 0,
  sources: [{ sourcePath: "/project/raw/sources/a.md", sourceIdentity: "/project/raw/sources/a.md", duplicateCount: 0 }],
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
      holder: "bulk-prepare:1",
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
      holder: "bulk-prepare:1",
      acquiredAtMs: 2,
      expiresAtMs: 1_202,
      status: "active",
    },
  }
}

function healthyPool(): RuntimeProfilePoolList {
  return { enabled: true, status: "healthy", activeClaims: [], circuitBreakers: [] }
}

/**
 * The bulk-prepare-driver tests mock "@/commands/runtime-db" wholesale (see
 * runtimeMocks above), so commit-integration's own default runtime-db
 * adapter (which needs several exports that mock doesn't define) can't be
 * exercised here -- that's covered by commit-integration.test.ts directly.
 * This fake just proves the driver wires the commit stage in and surfaces
 * its result; it reports zero pending staging artifacts so none of the
 * other adapter methods are ever invoked.
 */
function emptyCommitRuntime(): CommitIntegrationRuntimeAdapter {
  return {
    listStagingArtifacts: async () => ({ enabled: true, status: "healthy", artifacts: [] }),
    readStagingArtifactBody: async () => {
      throw new Error("unexpected: readStagingArtifactBody")
    },
    claimBudget: async () => {
      throw new Error("unexpected: claimBudget")
    },
    releaseBudget: async () => {
      throw new Error("unexpected: releaseBudget")
    },
    appendEvent: async () => {
      throw new Error("unexpected: appendEvent")
    },
    recordDerivedStaleMarker: async () => {
      throw new Error("unexpected: recordDerivedStaleMarker")
    },
    markArtifactCommitted: async () => {
      throw new Error("unexpected: markArtifactCommitted")
    },
    markArtifactFailed: async () => {
      throw new Error("unexpected: markArtifactFailed")
    },
    routeConflictRepair: async () => {
      throw new Error("unexpected: routeConflictRepair")
    },
    appendProgress: async () => {
      throw new Error("unexpected: appendProgress")
    },
  }
}

describe("runBulkKnowledgePrepare", () => {
  beforeEach(() => {
    for (const mock of Object.values(runtimeMocks)) {
      mock.mockReset()
    }
  })

  it("enqueues then drives one worker-pool pass through the newly queued jobs", async () => {
    let claimed = false
    runtimeMocks.runtimeJobCreate.mockImplementation(async (request) => ({
      jobId: request.jobId ?? "bulk-prepare-job",
      kind: request.kind,
      payload: request.payload,
      state: "queued",
      attempt: 0,
      maxAttempts: request.maxAttempts ?? 3,
      priority: 0,
      createdAtMs: 1,
      updatedAtMs: 1,
    }))
    runtimeMocks.runtimeJobClaimByKind.mockImplementation(async () => {
      if (claimed) throw new Error("no-queued-job: no queued runtime job is available")
      claimed = true
      return jobClaim("bulk-prepare-job")
    })
    runtimeMocks.runtimeProfilePoolList.mockResolvedValue(healthyPool())
    runtimeMocks.runtimeProfilePoolClaim.mockResolvedValue(profileClaim("bulk-prepare-job"))
    runtimeMocks.runtimeProfilePoolRelease.mockResolvedValue({
      claim: profileClaim("bulk-prepare-job").claim,
      circuitBreaker: null,
    })
    runtimeMocks.runtimeJobComplete.mockResolvedValue({
      ...jobClaim("bulk-prepare-job").job,
      state: "completed",
    })
    runtimeMocks.runtimeProgressAppend.mockImplementation(async (request) => ({
      progress: {
        jobId: request.jobId ?? "bulk-prepare-job",
        progressKey: request.progressKey,
        payload: request.payload,
        updatedAtMs: 1,
      },
      event: null,
    }))

    const { runBulkKnowledgePrepare } = await import("./bulk-prepare-driver")
    const executor = vi.fn().mockResolvedValue({ status: "success" as const })

    const result = await runBulkKnowledgePrepare(
      [{ sourcePath: "/project/raw/sources/a.md" }],
      { executor, concurrency: 1, maxJobs: 1, commitRuntime: emptyCommitRuntime() },
    )

    expect(result.enqueue.enqueuedJobs).toHaveLength(1)
    expect(executor).toHaveBeenCalledTimes(1)
    expect(result.workerPool).toMatchObject({ claimedJobs: 1, completedJobs: 1 })
    expect(runtimeMocks.runtimeProfilePoolRelease).toHaveBeenCalledWith({
      claimId: "claim-bulk-prepare-job",
      outcome: "success",
    })
    expect(result.commit).toMatchObject({ listedArtifacts: 0, attemptedArtifacts: 0 })
  })

  it("does not automatically pick up jobs enqueued by a later, unrelated call (known PR1 boundary)", async () => {
    // Simulates the documented boundary: a single fire-and-forget pass only
    // drains what's queued when it runs, not future enqueues.
    runtimeMocks.runtimeJobCreate.mockResolvedValue({
      jobId: "bulk-prepare-job",
      kind: BULK_KNOWLEDGE_PREPARE_JOB_KIND,
      payload,
      state: "queued",
      attempt: 0,
      maxAttempts: 3,
      priority: 0,
      createdAtMs: 1,
      updatedAtMs: 1,
    })
    runtimeMocks.runtimeJobClaimByKind.mockRejectedValue(
      new Error("no-queued-job: no queued runtime job is available"),
    )

    const { runBulkKnowledgePrepare } = await import("./bulk-prepare-driver")
    const executor = vi.fn()

    const result = await runBulkKnowledgePrepare(
      [{ sourcePath: "/project/raw/sources/a.md" }],
      { executor, concurrency: 1, maxJobs: 1, commitRuntime: emptyCommitRuntime() },
    )

    // The pool ran but found nothing queued at the moment it looked (the
    // mock never actually queues), demonstrating the pool does not wait
    // or retry for later enqueues.
    expect(executor).not.toHaveBeenCalled()
    expect(result.workerPool.idleWorkers).toBe(1)
    // The commit stage inherits the same single-pass boundary: it only
    // drains what's pending staging at the moment this call's commit list
    // snapshot is taken.
    expect(result.commit).toMatchObject({ listedArtifacts: 0, attemptedArtifacts: 0 })
  })
})
