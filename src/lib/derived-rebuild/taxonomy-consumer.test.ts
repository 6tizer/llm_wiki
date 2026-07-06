/**
 * Unit tests for the SPEC-6 PR3+4 taxonomy-layer `derived-rebuild` job
 * consumer. Fake-runtime style (module-level `vi.mock`), mirroring
 * `embedding-consumer.test.ts`'s pattern — this consumer is the same kind
 * of module-level singleton poller (SPEC-6 PR2 decision 3), just with a
 * different, aggregating execution unit (SPEC-6 PR3+4 decision 3).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { WikiProject } from "@/types/wiki"
import { DERIVED_REBUILD_JOB_KIND } from "@/core-runtime/derived-rebuild"
import { JOB_RUNTIME_DEFAULTS } from "@/core-runtime/contract"
import type { TagTaxonomyOperationReport } from "@/lib/agent/tag-taxonomy"
import { withProjectLock, __resetProjectLocksForTesting } from "@/lib/project-mutex"

const mocks = vi.hoisted(() => ({
  getQueueSummary: vi.fn(),
  getDedupQueueSummary: vi.fn(),
  applyTagTaxonomyGrowth: vi.fn(),
  runtimeJobList: vi.fn(),
  runtimeJobRetry: vi.fn(),
  runtimeJobClaimByKind: vi.fn(),
  runtimeJobHeartbeat: vi.fn(),
  runtimeJobFail: vi.fn(),
  runtimeDerivedStaleMarkerList: vi.fn(),
  runtimeDerivedMarkerClaimBatch: vi.fn(),
  runtimeDerivedMarkerCompleteBatch: vi.fn(),
  runtimeDerivedMarkerReleaseBatch: vi.fn(),
}))

vi.mock("@/lib/ingest-queue", () => ({ getQueueSummary: mocks.getQueueSummary }))
vi.mock("@/lib/dedup-queue", () => ({ getQueueSummary: mocks.getDedupQueueSummary }))
vi.mock("@/lib/agent/tag-taxonomy", () => ({
  applyTagTaxonomyGrowth: mocks.applyTagTaxonomyGrowth,
}))
vi.mock("@/commands/runtime-db", () => ({
  runtimeJobList: mocks.runtimeJobList,
  runtimeJobRetry: mocks.runtimeJobRetry,
  runtimeJobClaimByKind: mocks.runtimeJobClaimByKind,
  runtimeJobHeartbeat: mocks.runtimeJobHeartbeat,
  runtimeJobFail: mocks.runtimeJobFail,
  runtimeDerivedStaleMarkerList: mocks.runtimeDerivedStaleMarkerList,
  runtimeDerivedMarkerClaimBatch: mocks.runtimeDerivedMarkerClaimBatch,
  runtimeDerivedMarkerCompleteBatch: mocks.runtimeDerivedMarkerCompleteBatch,
  runtimeDerivedMarkerReleaseBatch: mocks.runtimeDerivedMarkerReleaseBatch,
}))

import { startTaxonomyConsumer, stopTaxonomyConsumer } from "./taxonomy-consumer"

const PROJECT: WikiProject = { id: "p1", name: "P", path: "/proj" }
const NO_QUEUED_JOB = new Error("no-queued-job: no queued runtime job is available")

function defer<T = void>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (err: unknown) => void } {
  let resolve!: (value: T) => void
  let reject!: (err: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

// Taxonomy needs a deeper drain than embedding's 5 because its tick has
// claimBatch grouping, a claim loop, and then the locked growth call.
async function drainMicrotasks(times = 20): Promise<void> {
  for (let i = 0; i < times; i += 1) await Promise.resolve()
}

function emptyJobList() {
  return { enabled: true, status: "healthy" as const, jobs: [], leases: [] }
}
function emptyMarkerList() {
  return { enabled: true, status: "healthy" as const, markers: [] }
}

function claimFor(jobId: string, payload: Record<string, unknown>) {
  return {
    job: {
      jobId,
      kind: DERIVED_REBUILD_JOB_KIND,
      payload: JSON.stringify(payload),
      state: "running" as const,
      attempt: 1,
      maxAttempts: 3,
      priority: 0,
      createdAtMs: 0,
      updatedAtMs: 0,
    },
    lease: {
      leaseId: `${jobId}-lease`,
      jobId,
      holder: "taxonomy-consumer",
      acquiredAtMs: 0,
      heartbeatAtMs: 0,
      expiresAtMs: 0,
      status: "active",
    },
  }
}

function taxonomyPayload(affectedPath: string, markerIds: string[]) {
  return {
    layer: "taxonomy",
    affectedPath,
    markerIds,
    baseVersion: "h",
    inputHash: "h",
    reason: "commit",
  }
}

function successReport(overrides: Partial<TagTaxonomyOperationReport> = {}): TagTaxonomyOperationReport {
  return {
    action: "growth",
    dryRun: false,
    batchId: "taxonomy-growth-1",
    added: 1,
    removed: 0,
    truncated: 0,
    skipped: 0,
    wrote: true,
    counts: { pagesScanned: 1, pagesWithFrontmatter: 1, totalNodes: 1, batches: 1 },
    addedNodeSlugs: ["concept"],
    removedNodeSlugs: [],
    details: [],
    ...overrides,
  }
}

beforeEach(() => {
  __resetProjectLocksForTesting()
  vi.clearAllMocks()
  mocks.getQueueSummary.mockReturnValue({ pending: 0, processing: 0, failed: 0, completed: 0, total: 0 })
  mocks.getDedupQueueSummary.mockReturnValue({ pending: 0, processing: 0, failed: 0, total: 0 })
  mocks.runtimeJobList.mockResolvedValue(emptyJobList())
  mocks.runtimeDerivedStaleMarkerList.mockResolvedValue(emptyMarkerList())
  mocks.runtimeJobClaimByKind.mockRejectedValue(NO_QUEUED_JOB)
  mocks.runtimeJobHeartbeat.mockResolvedValue({})
  mocks.applyTagTaxonomyGrowth.mockResolvedValue(successReport())
})

afterEach(() => {
  stopTaxonomyConsumer()
  __resetProjectLocksForTesting()
  vi.useRealTimers()
})

describe("taxonomy-consumer — single group happy path", () => {
  it("folds a pending marker into a job, claims it, runs growth once, and completes via marker-batch", async () => {
    mocks.runtimeDerivedStaleMarkerList.mockResolvedValueOnce({
      enabled: true,
      status: "healthy",
      markers: [
        { markerId: "m1", layer: "taxonomy", affectedPath: "wiki/foo.md", baseVersion: "h1", markedAtMs: 1, reason: "commit", sourceEventId: "e1", status: "pending", updatedAtMs: 1 },
      ],
    })
    mocks.runtimeDerivedMarkerClaimBatch.mockResolvedValueOnce({ job: {}, markers: [] })
    const claim = claimFor("job-1", taxonomyPayload("wiki/foo.md", ["m1"]))
    mocks.runtimeJobClaimByKind.mockResolvedValueOnce(claim)

    startTaxonomyConsumer(PROJECT)
    await vi.waitFor(() => expect(mocks.runtimeDerivedMarkerCompleteBatch).toHaveBeenCalled())

    expect(mocks.runtimeDerivedMarkerClaimBatch).toHaveBeenCalledWith({ layer: "taxonomy", affectedPath: "wiki/foo.md" })
    // SPEC-6 PR3+4 P0-2b regression lock: the claim MUST be scoped to this
    // consumer's own layer server-side, not just kind — otherwise a
    // higher-priority sibling-layer job could win this claim instead.
    expect(mocks.runtimeJobClaimByKind).toHaveBeenCalledWith(
      expect.objectContaining({ kind: DERIVED_REBUILD_JOB_KIND, payloadLayer: "taxonomy" }),
    )
    expect(mocks.applyTagTaxonomyGrowth).toHaveBeenCalledTimes(1)
    expect(mocks.applyTagTaxonomyGrowth).toHaveBeenCalledWith("/proj")
    expect(mocks.runtimeDerivedMarkerCompleteBatch).toHaveBeenCalledWith({
      jobId: "job-1",
      leaseId: "job-1-lease",
      markerIds: ["m1"],
    })
  })

  it("completes as a no-op success when growth converges with nothing new to add (added: 0)", async () => {
    mocks.applyTagTaxonomyGrowth.mockResolvedValueOnce(successReport({ added: 0, addedNodeSlugs: [] }))
    const claim = claimFor("job-noop", taxonomyPayload("wiki/x.md", ["m-noop"]))
    mocks.runtimeJobClaimByKind.mockResolvedValueOnce(claim)

    startTaxonomyConsumer(PROJECT)
    await vi.waitFor(() => expect(mocks.runtimeDerivedMarkerCompleteBatch).toHaveBeenCalled())

    expect(mocks.runtimeDerivedMarkerCompleteBatch).toHaveBeenCalledWith({
      jobId: "job-noop",
      leaseId: "job-noop-lease",
      markerIds: ["m-noop"],
    })
    expect(mocks.runtimeJobFail).not.toHaveBeenCalled()
  })
})

describe("taxonomy-consumer — cross-affectedPath aggregation (SPEC-6 PR3+4 decision 3)", () => {
  it("folds THREE distinct affectedPath groups into three jobs, claims all three, but calls applyTagTaxonomyGrowth exactly ONCE, then completes all three groups", async () => {
    mocks.runtimeDerivedStaleMarkerList.mockResolvedValueOnce({
      enabled: true,
      status: "healthy",
      markers: [
        { markerId: "m1", layer: "taxonomy", affectedPath: "wiki/a.md", baseVersion: "h", markedAtMs: 1, reason: "commit", sourceEventId: "e1", status: "pending", updatedAtMs: 1 },
        { markerId: "m2", layer: "taxonomy", affectedPath: "wiki/b.md", baseVersion: "h", markedAtMs: 2, reason: "commit", sourceEventId: "e2", status: "pending", updatedAtMs: 2 },
        { markerId: "m3", layer: "taxonomy", affectedPath: "wiki/c.md", baseVersion: "h", markedAtMs: 3, reason: "commit", sourceEventId: "e3", status: "pending", updatedAtMs: 3 },
      ],
    })
    mocks.runtimeDerivedMarkerClaimBatch.mockResolvedValue({ job: {}, markers: [] })
    const claimA = claimFor("job-a", taxonomyPayload("wiki/a.md", ["m1"]))
    const claimB = claimFor("job-b", taxonomyPayload("wiki/b.md", ["m2"]))
    const claimC = claimFor("job-c", taxonomyPayload("wiki/c.md", ["m3"]))
    mocks.runtimeJobClaimByKind
      .mockResolvedValueOnce(claimA)
      .mockResolvedValueOnce(claimB)
      .mockResolvedValueOnce(claimC)
      .mockRejectedValue(NO_QUEUED_JOB)

    startTaxonomyConsumer(PROJECT)
    await vi.waitFor(() => expect(mocks.runtimeDerivedMarkerCompleteBatch).toHaveBeenCalledTimes(3))

    // The three distinct groups were each folded independently...
    expect(mocks.runtimeDerivedMarkerClaimBatch).toHaveBeenCalledWith({ layer: "taxonomy", affectedPath: "wiki/a.md" })
    expect(mocks.runtimeDerivedMarkerClaimBatch).toHaveBeenCalledWith({ layer: "taxonomy", affectedPath: "wiki/b.md" })
    expect(mocks.runtimeDerivedMarkerClaimBatch).toHaveBeenCalledWith({ layer: "taxonomy", affectedPath: "wiki/c.md" })
    // ...but converge through exactly ONE growth call, not three.
    expect(mocks.applyTagTaxonomyGrowth).toHaveBeenCalledTimes(1)
    // ...and each of the three jobs is completed with its OWN markerIds.
    expect(mocks.runtimeDerivedMarkerCompleteBatch).toHaveBeenCalledWith({ jobId: "job-a", leaseId: "job-a-lease", markerIds: ["m1"] })
    expect(mocks.runtimeDerivedMarkerCompleteBatch).toHaveBeenCalledWith({ jobId: "job-b", leaseId: "job-b-lease", markerIds: ["m2"] })
    expect(mocks.runtimeDerivedMarkerCompleteBatch).toHaveBeenCalledWith({ jobId: "job-c", leaseId: "job-c-lease", markerIds: ["m3"] })
  })

  it("sabotage guard: if aggregation were dropped (one growth call per job instead of per tick), this test would see 2 calls — asserting exactly 1 catches that regression", async () => {
    mocks.runtimeDerivedStaleMarkerList.mockResolvedValueOnce({
      enabled: true,
      status: "healthy",
      markers: [
        { markerId: "m1", layer: "taxonomy", affectedPath: "wiki/a.md", baseVersion: "h", markedAtMs: 1, reason: "commit", sourceEventId: "e1", status: "pending", updatedAtMs: 1 },
        { markerId: "m2", layer: "taxonomy", affectedPath: "wiki/b.md", baseVersion: "h", markedAtMs: 2, reason: "commit", sourceEventId: "e2", status: "pending", updatedAtMs: 2 },
      ],
    })
    mocks.runtimeDerivedMarkerClaimBatch.mockResolvedValue({ job: {}, markers: [] })
    mocks.runtimeJobClaimByKind
      .mockResolvedValueOnce(claimFor("job-a", taxonomyPayload("wiki/a.md", ["m1"])))
      .mockResolvedValueOnce(claimFor("job-b", taxonomyPayload("wiki/b.md", ["m2"])))
      .mockRejectedValue(NO_QUEUED_JOB)

    startTaxonomyConsumer(PROJECT)
    await vi.waitFor(() => expect(mocks.runtimeDerivedMarkerCompleteBatch).toHaveBeenCalledTimes(2))

    expect(mocks.applyTagTaxonomyGrowth).toHaveBeenCalledTimes(1)
  })

  it("Tester P2a: when job-a's complete_batch call itself rejects, job-b in the SAME tick still gets completed (per-group try/catch, not a shared failure)", async () => {
    mocks.runtimeDerivedStaleMarkerList.mockResolvedValueOnce({
      enabled: true,
      status: "healthy",
      markers: [
        { markerId: "m1", layer: "taxonomy", affectedPath: "wiki/a.md", baseVersion: "h", markedAtMs: 1, reason: "commit", sourceEventId: "e1", status: "pending", updatedAtMs: 1 },
        { markerId: "m2", layer: "taxonomy", affectedPath: "wiki/b.md", baseVersion: "h", markedAtMs: 2, reason: "commit", sourceEventId: "e2", status: "pending", updatedAtMs: 2 },
      ],
    })
    mocks.runtimeDerivedMarkerClaimBatch.mockResolvedValue({ job: {}, markers: [] })
    mocks.runtimeJobClaimByKind
      .mockResolvedValueOnce(claimFor("job-a", taxonomyPayload("wiki/a.md", ["m1"])))
      .mockResolvedValueOnce(claimFor("job-b", taxonomyPayload("wiki/b.md", ["m2"])))
      .mockRejectedValue(NO_QUEUED_JOB)
    mocks.runtimeDerivedMarkerCompleteBatch.mockImplementation(
      async (request: { jobId: string; leaseId: string; markerIds: string[] }) => {
        if (request.jobId === "job-a") throw new Error("transient network error")
        return { job: {}, markers: [] }
      },
    )
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})

    startTaxonomyConsumer(PROJECT)
    await vi.waitFor(() =>
      expect(mocks.runtimeDerivedMarkerCompleteBatch).toHaveBeenCalledWith({
        jobId: "job-b",
        leaseId: "job-b-lease",
        markerIds: ["m2"],
      }),
    )

    // job-a's own completion attempt did happen (and was the one that
    // rejected) — its failure is logged, not silently dropped, and it
    // must not have prevented job-b's completion in the same aggregated loop.
    expect(mocks.runtimeDerivedMarkerCompleteBatch).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: "job-a" }),
    )
    expect(warnSpy).toHaveBeenCalled()
    warnSpy.mockRestore()
  })
})

describe("taxonomy-consumer — project lock serialization", () => {
  it("holds the project lock across growth and marker completion, so a concurrent delete waits", async () => {
    const order: string[] = []
    const claim = claimFor("job-tax-lock-consumer-first", taxonomyPayload("wiki/racy.md", ["m-lock"]))
    const growthEntered = defer()
    const releaseGrowth = defer<TagTaxonomyOperationReport>()
    mocks.runtimeJobClaimByKind.mockResolvedValueOnce(claim)
    mocks.applyTagTaxonomyGrowth.mockImplementationOnce(async () => {
      order.push("consumer:growth:start")
      growthEntered.resolve(undefined)
      return releaseGrowth.promise
    })
    mocks.runtimeDerivedMarkerCompleteBatch.mockImplementationOnce(async () => {
      order.push("consumer:complete")
      return { job: {}, markers: [] }
    })

    startTaxonomyConsumer(PROJECT)
    await growthEntered.promise

    const deleteEntered = defer()
    const deleteCall = withProjectLock(PROJECT.path, async () => {
      order.push("delete:entered")
      deleteEntered.resolve(undefined)
    })

    const preCompleteRace = await Promise.race([
      deleteEntered.promise.then(() => "delete-entered" as const),
      new Promise<"still-blocked">((resolve) => setTimeout(() => resolve("still-blocked"), 50)),
    ])
    expect(preCompleteRace).toBe("still-blocked")
    expect(order).toEqual(["consumer:growth:start"])

    releaseGrowth.resolve(successReport())
    await deleteCall

    expect(order).toEqual(["consumer:growth:start", "consumer:complete", "delete:entered"])
    expect(mocks.runtimeDerivedMarkerCompleteBatch).toHaveBeenCalledWith({
      jobId: "job-tax-lock-consumer-first",
      leaseId: "job-tax-lock-consumer-first-lease",
      markerIds: ["m-lock"],
    })
  })

  it("waits behind an existing project lock after claiming jobs, before running taxonomy growth", async () => {
    const claim = claimFor("job-tax-lock-delete-first", taxonomyPayload("wiki/wait.md", ["m-wait"]))
    const holderEntered = defer()
    const releaseHolder = defer()
    const holder = withProjectLock(PROJECT.path, async () => {
      holderEntered.resolve(undefined)
      await releaseHolder.promise
    })
    await holderEntered.promise

    mocks.runtimeJobClaimByKind.mockResolvedValueOnce(claim)
    mocks.applyTagTaxonomyGrowth.mockResolvedValueOnce(successReport())

    startTaxonomyConsumer(PROJECT)
    await vi.waitFor(() => expect(mocks.runtimeJobClaimByKind).toHaveBeenCalled())
    await Promise.resolve()
    await Promise.resolve()
    expect(mocks.applyTagTaxonomyGrowth).not.toHaveBeenCalled()

    releaseHolder.resolve(undefined)
    await holder
    await vi.waitFor(() => expect(mocks.runtimeDerivedMarkerCompleteBatch).toHaveBeenCalled())

    expect(mocks.applyTagTaxonomyGrowth).toHaveBeenCalledWith("/proj")
    expect(mocks.runtimeDerivedMarkerCompleteBatch).toHaveBeenCalledWith({
      jobId: "job-tax-lock-delete-first",
      leaseId: "job-tax-lock-delete-first-lease",
      markerIds: ["m-wait"],
    })
  })

  it("keeps safeFailClaim under the project lock and releases the lock afterward when growth throws", async () => {
    const order: string[] = []
    const claim = claimFor("job-tax-lock-fail", taxonomyPayload("wiki/fail.md", ["m-fail"]))
    const growthEntered = defer()
    const releaseGrowthFailure = defer<TagTaxonomyOperationReport>()
    mocks.runtimeJobClaimByKind.mockResolvedValueOnce(claim)
    mocks.applyTagTaxonomyGrowth.mockImplementationOnce(async () => {
      order.push("consumer:growth:start")
      growthEntered.resolve(undefined)
      return releaseGrowthFailure.promise
    })
    mocks.runtimeJobFail.mockImplementationOnce(async () => {
      order.push("consumer:fail")
      return { state: "retry-wait" }
    })

    startTaxonomyConsumer(PROJECT)
    await growthEntered.promise

    const deleteEntered = defer()
    const deleteCall = withProjectLock(PROJECT.path, async () => {
      order.push("delete:entered")
      deleteEntered.resolve(undefined)
    })

    const preFailRace = await Promise.race([
      deleteEntered.promise.then(() => "delete-entered" as const),
      new Promise<"still-blocked">((resolve) => setTimeout(() => resolve("still-blocked"), 50)),
    ])
    expect(preFailRace).toBe("still-blocked")

    releaseGrowthFailure.reject(new Error("growth boom"))
    await deleteCall

    expect(order).toEqual(["consumer:growth:start", "consumer:fail", "delete:entered"])
    expect(mocks.runtimeJobFail).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: "job-tax-lock-fail",
        leaseId: "job-tax-lock-fail-lease",
        error: "taxonomy-growth-failed: growth boom",
      }),
    )
    expect(mocks.runtimeDerivedMarkerCompleteBatch).not.toHaveBeenCalled()
  })
})

describe("taxonomy-consumer — growth failure and conflict handling", () => {
  it("fails ALL claimed groups (not completes) when applyTagTaxonomyGrowth itself throws", async () => {
    mocks.applyTagTaxonomyGrowth.mockRejectedValueOnce(new Error("disk full"))
    const claimA = claimFor("job-a", taxonomyPayload("wiki/a.md", ["m1"]))
    const claimB = claimFor("job-b", taxonomyPayload("wiki/b.md", ["m2"]))
    mocks.runtimeJobClaimByKind
      .mockResolvedValueOnce(claimA)
      .mockResolvedValueOnce(claimB)
      .mockRejectedValue(NO_QUEUED_JOB)
    mocks.runtimeJobFail.mockResolvedValue({ state: "retry-wait" })

    startTaxonomyConsumer(PROJECT)
    await vi.waitFor(() => expect(mocks.runtimeJobFail).toHaveBeenCalledTimes(2))

    expect(mocks.runtimeJobFail).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: "job-a", error: expect.stringContaining("taxonomy-growth-failed") }),
    )
    expect(mocks.runtimeJobFail).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: "job-b", error: expect.stringContaining("taxonomy-growth-failed") }),
    )
    expect(mocks.runtimeDerivedMarkerCompleteBatch).not.toHaveBeenCalled()
  })

  it("fails ALL claimed groups (retry, not clobber) when growth reports a stale_updated_at save conflict against a concurrent manual bootstrap/growth", async () => {
    mocks.applyTagTaxonomyGrowth.mockResolvedValueOnce(
      successReport({
        wrote: false,
        added: 0,
        details: [{ code: "stale_updated_at", message: "Tag taxonomy changed on disk.", path: "updatedAt" }],
      }),
    )
    const claim = claimFor("job-conflict", taxonomyPayload("wiki/a.md", ["m1"]))
    mocks.runtimeJobClaimByKind.mockResolvedValueOnce(claim)
    mocks.runtimeJobFail.mockResolvedValueOnce({ state: "retry-wait" })

    startTaxonomyConsumer(PROJECT)
    await vi.waitFor(() => expect(mocks.runtimeJobFail).toHaveBeenCalled())

    expect(mocks.runtimeJobFail).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: "job-conflict", error: expect.stringContaining("taxonomy-growth-conflict") }),
    )
    expect(mocks.runtimeDerivedMarkerCompleteBatch).not.toHaveBeenCalled()
    // Tester P2b: runtimeJobFail here resolves "retry-wait" (non-terminal,
    // attempts remain) — markers must stay claimed under the same job with
    // NO explicit release call (PR1's orphan-marker fix), not be released.
    expect(mocks.runtimeDerivedMarkerReleaseBatch).not.toHaveBeenCalled()
  })

  it("releases claimed markers to failed when the job-fail call reports the job reached its terminal state", async () => {
    mocks.applyTagTaxonomyGrowth.mockRejectedValueOnce(new Error("boom"))
    const claim = claimFor("job-terminal", taxonomyPayload("wiki/a.md", ["m1"]))
    mocks.runtimeJobClaimByKind.mockResolvedValueOnce(claim)
    mocks.runtimeJobFail.mockResolvedValueOnce({ state: "failed" })

    startTaxonomyConsumer(PROJECT)
    await vi.waitFor(() => expect(mocks.runtimeDerivedMarkerReleaseBatch).toHaveBeenCalled())

    expect(mocks.runtimeDerivedMarkerReleaseBatch).toHaveBeenCalledWith({
      jobId: "job-terminal",
      markerIds: ["m1"],
      targetStatus: "failed",
      error: expect.any(String),
    })
  })

  it("fails a job with an unparseable payload (no marker ids to release) without crashing the tick loop", async () => {
    const claim = {
      job: {
        jobId: "job-bad",
        kind: DERIVED_REBUILD_JOB_KIND,
        payload: "not json",
        state: "running" as const,
        attempt: 1,
        maxAttempts: 3,
        priority: 0,
        createdAtMs: 0,
        updatedAtMs: 0,
      },
      lease: { leaseId: "job-bad-lease", jobId: "job-bad", holder: "taxonomy-consumer", acquiredAtMs: 0, heartbeatAtMs: 0, expiresAtMs: 0, status: "active" },
    }
    mocks.runtimeJobClaimByKind.mockResolvedValueOnce(claim)
    mocks.runtimeJobFail.mockResolvedValueOnce({ state: "retry-wait" })

    startTaxonomyConsumer(PROJECT)
    await vi.waitFor(() =>
      expect(mocks.runtimeJobFail).toHaveBeenCalledWith(
        expect.objectContaining({ jobId: "job-bad", error: expect.stringContaining("invalid-payload") }),
      ),
    )
    expect(mocks.runtimeDerivedMarkerReleaseBatch).not.toHaveBeenCalled()
    expect(mocks.applyTagTaxonomyGrowth).not.toHaveBeenCalled()
  })
})

describe("taxonomy-consumer — dual signal polling", () => {
  it("recovers an eligible retry-wait derived-rebuild job via runtimeJobRetry", async () => {
    mocks.runtimeJobList.mockResolvedValueOnce({
      enabled: true,
      status: "healthy",
      jobs: [
        {
          jobId: "job-2",
          kind: DERIVED_REBUILD_JOB_KIND,
          payload: JSON.stringify(taxonomyPayload("wiki/bar.md", ["m2"])),
          state: "retry-wait",
          attempt: 1,
          maxAttempts: 3,
          priority: 0,
          createdAtMs: 0,
          updatedAtMs: 0,
          retryAfterMs: 0,
        },
      ],
      leases: [],
    })
    mocks.runtimeJobRetry.mockResolvedValueOnce({})

    startTaxonomyConsumer(PROJECT)
    await vi.waitFor(() => expect(mocks.runtimeJobRetry).toHaveBeenCalledWith("job-2"))
  })

  it("Tester item 5 — retry-wait end-to-end: the recovered job actually gets re-claimed (with payloadLayer scoping), growth reruns, and completes with its ORIGINAL job id/markers (not just that runtimeJobRetry was called)", async () => {
    const retryPayload = taxonomyPayload("wiki/retry.md", ["m-retry"])
    mocks.runtimeJobList.mockResolvedValueOnce({
      enabled: true,
      status: "healthy",
      jobs: [
        {
          jobId: "job-retry",
          kind: DERIVED_REBUILD_JOB_KIND,
          payload: JSON.stringify(retryPayload),
          state: "retry-wait",
          attempt: 1,
          maxAttempts: 3,
          priority: 0,
          createdAtMs: 0,
          updatedAtMs: 0,
          retryAfterMs: 0,
        },
      ],
      leases: [],
    })
    mocks.runtimeJobRetry.mockResolvedValueOnce({})
    // The job runtime hands the SAME job back out once runtimeJobRetry has
    // re-queued it — simulated here since the fake here has no real
    // job-runtime state machine backing runtimeJobRetry/claimByKind.
    mocks.runtimeJobClaimByKind.mockResolvedValueOnce(claimFor("job-retry", retryPayload))

    startTaxonomyConsumer(PROJECT)
    await vi.waitFor(() => expect(mocks.runtimeDerivedMarkerCompleteBatch).toHaveBeenCalled())

    expect(mocks.runtimeJobRetry).toHaveBeenCalledWith("job-retry")
    // Recovery re-claims through the SAME payloadLayer-scoped call as
    // fresh-marker folding (SPEC-6 PR3+4 P0-2b) — both signals converge on
    // one claim site.
    expect(mocks.runtimeJobClaimByKind).toHaveBeenCalledWith(
      expect.objectContaining({ kind: DERIVED_REBUILD_JOB_KIND, payloadLayer: "taxonomy" }),
    )
    expect(mocks.applyTagTaxonomyGrowth).toHaveBeenCalledTimes(1)
    expect(mocks.runtimeDerivedMarkerCompleteBatch).toHaveBeenCalledWith({
      jobId: "job-retry",
      leaseId: "job-retry-lease",
      markerIds: ["m-retry"],
    })
  })

  it("does not retry a retry-wait job whose backoff has not elapsed yet", async () => {
    mocks.runtimeJobList.mockResolvedValueOnce({
      enabled: true,
      status: "healthy",
      jobs: [
        {
          jobId: "job-3",
          kind: DERIVED_REBUILD_JOB_KIND,
          payload: JSON.stringify(taxonomyPayload("wiki/bar.md", ["m3"])),
          state: "retry-wait",
          attempt: 1,
          maxAttempts: 3,
          priority: 0,
          createdAtMs: 0,
          updatedAtMs: 0,
          retryAfterMs: Date.now() + 60_000,
        },
      ],
      leases: [],
    })

    startTaxonomyConsumer(PROJECT)
    await vi.waitFor(() => expect(mocks.runtimeJobList).toHaveBeenCalled())
    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(mocks.runtimeJobRetry).not.toHaveBeenCalled()
  })

  it("ignores a retry-wait derived-rebuild job belonging to a different layer", async () => {
    mocks.runtimeJobList.mockResolvedValueOnce({
      enabled: true,
      status: "healthy",
      jobs: [
        {
          jobId: "job-4",
          kind: DERIVED_REBUILD_JOB_KIND,
          payload: JSON.stringify({ layer: "embedding", affectedPath: "wiki/bar.md", markerIds: ["m4"], baseVersion: "h4", inputHash: "h4", reason: "commit" }),
          state: "retry-wait",
          attempt: 1,
          maxAttempts: 3,
          priority: 0,
          createdAtMs: 0,
          updatedAtMs: 0,
          retryAfterMs: 0,
        },
      ],
      leases: [],
    })

    startTaxonomyConsumer(PROJECT)
    await vi.waitFor(() => expect(mocks.runtimeJobList).toHaveBeenCalled())
    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(mocks.runtimeJobRetry).not.toHaveBeenCalled()
  })
})

describe("taxonomy-consumer — busy backoff (SPEC-6 PR2 decision 2, reused)", () => {
  it("skips the entire tick when ingest is actively processing for this project", async () => {
    mocks.getQueueSummary.mockReturnValue({ pending: 0, processing: 1, failed: 0, completed: 0, total: 1 })

    startTaxonomyConsumer(PROJECT)
    await vi.waitFor(() => expect(mocks.getQueueSummary).toHaveBeenCalled())
    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(mocks.runtimeJobList).not.toHaveBeenCalled()
    expect(mocks.runtimeDerivedStaleMarkerList).not.toHaveBeenCalled()
    expect(mocks.runtimeJobClaimByKind).not.toHaveBeenCalled()
  })

  it("skips the entire tick when the dedup queue is actively processing for this project (closeout hotfix P1 #4)", async () => {
    mocks.getDedupQueueSummary.mockReturnValue({ pending: 0, processing: 1, failed: 0, total: 1 })

    startTaxonomyConsumer(PROJECT)
    await vi.waitFor(() => expect(mocks.getDedupQueueSummary).toHaveBeenCalled())
    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(mocks.runtimeJobList).not.toHaveBeenCalled()
    expect(mocks.runtimeDerivedStaleMarkerList).not.toHaveBeenCalled()
    expect(mocks.runtimeJobClaimByKind).not.toHaveBeenCalled()
  })
})

describe("taxonomy-consumer — defensive skips", () => {
  it("leaves a claimed job for a different derived-rebuild layer untouched (self-heals via lease timeout) and keeps looking for taxonomy jobs", async () => {
    const foreignClaim = claimFor("job-foreign", { layer: "embedding", affectedPath: "wiki/g.md", markerIds: ["mg"], baseVersion: "h", inputHash: "h", reason: "commit" })
    const taxonomyClaim = claimFor("job-tax", taxonomyPayload("wiki/tax.md", ["mt"]))
    mocks.runtimeJobClaimByKind
      .mockResolvedValueOnce(foreignClaim)
      .mockResolvedValueOnce(taxonomyClaim)
      .mockRejectedValue(NO_QUEUED_JOB)
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})

    startTaxonomyConsumer(PROJECT)
    await vi.waitFor(() => expect(mocks.runtimeDerivedMarkerCompleteBatch).toHaveBeenCalled())

    expect(warnSpy).toHaveBeenCalled()
    expect(mocks.runtimeDerivedMarkerCompleteBatch).toHaveBeenCalledWith({
      jobId: "job-tax",
      leaseId: "job-tax-lease",
      markerIds: ["mt"],
    })
    // The foreign job was never touched by this consumer's complete/fail path.
    expect(mocks.runtimeJobFail).not.toHaveBeenCalledWith(expect.objectContaining({ jobId: "job-foreign" }))
    warnSpy.mockRestore()
  })
})

describe("taxonomy-consumer — quiet error handling", () => {
  it("treats 'no-queued-job' as normal tick completion, not a warning", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})

    startTaxonomyConsumer(PROJECT)
    await vi.waitFor(() => expect(mocks.runtimeJobClaimByKind).toHaveBeenCalled())
    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(warnSpy).not.toHaveBeenCalled()
    expect(mocks.applyTagTaxonomyGrowth).not.toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it("treats 'runtime-disabled' as a quiet no-op across the whole tick (no fallback growth path)", async () => {
    mocks.runtimeJobList.mockRejectedValueOnce(new Error("runtime-disabled: work runtime is disabled"))
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})

    startTaxonomyConsumer(PROJECT)
    await vi.waitFor(() => expect(mocks.runtimeJobList).toHaveBeenCalled())
    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(warnSpy).not.toHaveBeenCalled()
    expect(mocks.applyTagTaxonomyGrowth).not.toHaveBeenCalled()
    warnSpy.mockRestore()
  })
})

describe("taxonomy-consumer — heartbeat rides along", () => {
  it("heartbeats every claimed job's lease while growth is slow, and stops heartbeating once complete", async () => {
    vi.useFakeTimers()
    const claimA = claimFor("job-slow-a", taxonomyPayload("wiki/a.md", ["ma"]))
    const claimB = claimFor("job-slow-b", taxonomyPayload("wiki/b.md", ["mb"]))
    mocks.runtimeJobClaimByKind
      .mockResolvedValueOnce(claimA)
      .mockResolvedValueOnce(claimB)
      .mockRejectedValue(NO_QUEUED_JOB)
    let resolveGrowth!: (report: TagTaxonomyOperationReport) => void
    mocks.applyTagTaxonomyGrowth.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveGrowth = resolve
      }),
    )

    startTaxonomyConsumer(PROJECT)
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(0)

    await vi.advanceTimersByTimeAsync(JOB_RUNTIME_DEFAULTS.heartbeatMinIntervalMs * 2 + 10)
    expect(mocks.runtimeJobHeartbeat).toHaveBeenCalledWith({ jobId: "job-slow-a", leaseId: "job-slow-a-lease" })
    expect(mocks.runtimeJobHeartbeat).toHaveBeenCalledWith({ jobId: "job-slow-b", leaseId: "job-slow-b-lease" })
    const heartbeatsWhileRunning = mocks.runtimeJobHeartbeat.mock.calls.length
    expect(heartbeatsWhileRunning).toBeGreaterThan(0)

    resolveGrowth(successReport())
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(0)
    expect(mocks.runtimeDerivedMarkerCompleteBatch).toHaveBeenCalledTimes(2)

    const heartbeatsAfterComplete = mocks.runtimeJobHeartbeat.mock.calls.length
    await vi.advanceTimersByTimeAsync(JOB_RUNTIME_DEFAULTS.heartbeatMinIntervalMs * 3)
    expect(mocks.runtimeJobHeartbeat.mock.calls.length).toBe(heartbeatsAfterComplete)
  })
})

describe("taxonomy-consumer — project switch / generation lifecycle (SPEC-11 PR8b/S8)", () => {
  it("abandons already-claimed jobs without completing/failing them once the project switches mid-growth", async () => {
    const claim = claimFor("job-switch", taxonomyPayload("wiki/switch.md", ["m14"]))
    mocks.runtimeJobClaimByKind.mockResolvedValueOnce(claim)
    let resolveGrowth!: (report: TagTaxonomyOperationReport) => void
    mocks.applyTagTaxonomyGrowth.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveGrowth = resolve
      }),
    )

    startTaxonomyConsumer(PROJECT)
    await vi.waitFor(() => expect(mocks.applyTagTaxonomyGrowth).toHaveBeenCalled())

    // The project switches away mid-flight — exactly what
    // reset-project-state.ts's centralized cleanup does.
    stopTaxonomyConsumer()

    resolveGrowth(successReport())
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(mocks.runtimeDerivedMarkerCompleteBatch).not.toHaveBeenCalled()
    expect(mocks.runtimeJobFail).not.toHaveBeenCalled()
  })

  it("a fresh start for a new project runs independently of a stopped previous run", async () => {
    startTaxonomyConsumer(PROJECT)
    await vi.waitFor(() => expect(mocks.runtimeJobList).toHaveBeenCalledTimes(1))
    stopTaxonomyConsumer()

    const otherProject: WikiProject = { id: "p2", name: "P2", path: "/proj2" }
    startTaxonomyConsumer(otherProject)
    await vi.waitFor(() => expect(mocks.runtimeJobList).toHaveBeenCalledTimes(2))
  })

  it("gate review P2 (sabotage-verified pattern reused): an old generation's dying tick cannot clear a new generation's reentrancy guard and cause a double-tick for the new generation", async () => {
    vi.useFakeTimers()

    // Generation 1 (old): claims a job and stalls on growth.
    const oldClaim = claimFor("job-old", taxonomyPayload("wiki/old.md", ["m-old"]))
    mocks.runtimeJobClaimByKind.mockResolvedValueOnce(oldClaim)
    let resolveOldGrowth!: (report: TagTaxonomyOperationReport) => void
    mocks.applyTagTaxonomyGrowth.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveOldGrowth = resolve
      }),
    )

    startTaxonomyConsumer(PROJECT)
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(0)
    expect(mocks.applyTagTaxonomyGrowth).toHaveBeenCalledTimes(1)

    // Generation 2 (new, same project): claims a DIFFERENT job, then waits
    // behind generation 1's still-held project lock before growth.
    stopTaxonomyConsumer()
    const newClaim = claimFor("job-new", taxonomyPayload("wiki/new.md", ["m-new"]))
    mocks.runtimeJobClaimByKind.mockReset()
    mocks.runtimeJobClaimByKind.mockResolvedValueOnce(newClaim).mockRejectedValue(NO_QUEUED_JOB)
    let resolveNewGrowth!: (report: TagTaxonomyOperationReport) => void
    mocks.applyTagTaxonomyGrowth.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveNewGrowth = resolve
      }),
    )

    startTaxonomyConsumer(PROJECT)
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(0)
    await drainMicrotasks()
    expect(mocks.runtimeJobClaimByKind).toHaveBeenCalledTimes(2)
    expect(mocks.applyTagTaxonomyGrowth).toHaveBeenCalledTimes(1)

    // Let generation 1's stalled growth resolve now — its tick hits
    // assertCurrentRun, self-aborts, and releases the project lock.
    // Under the pre-fix single shared boolean, this finally would have
    // cleared generation 2's reentrancy flag too.
    resolveOldGrowth(successReport())
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(0)
    await drainMicrotasks()
    expect(mocks.applyTagTaxonomyGrowth).toHaveBeenCalledTimes(2)
    expect(mocks.runtimeDerivedMarkerCompleteBatch).not.toHaveBeenCalled()
    expect(mocks.runtimeJobFail).not.toHaveBeenCalled()

    // Generation 2's FIRST tick is still stuck on its own growth call.
    // Advance past the next scheduled interval tick for generation 2 —
    // with a correctly per-generation guard this must be skipped (no
    // second overlapping claim call for generation 2).
    await vi.advanceTimersByTimeAsync(3_000)
    await vi.advanceTimersByTimeAsync(0)
    expect(mocks.runtimeJobClaimByKind.mock.calls.length).toBe(2)

    // Generation 2 finishes normally once its own growth resolves.
    resolveNewGrowth(successReport())
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(0)
    expect(mocks.runtimeDerivedMarkerCompleteBatch).toHaveBeenCalledWith({
      jobId: "job-new",
      leaseId: "job-new-lease",
      markerIds: ["m-new"],
    })
  })
})

describe("taxonomy-consumer — nested failure resilience (Tester items 7a/7b pattern reused)", () => {
  it("does not crash the tick loop when complete_batch itself rejects, and a later tick still processes a different job normally", async () => {
    vi.useFakeTimers()
    const claim1 = claimFor("job-nest-1", taxonomyPayload("wiki/nest1.md", ["mn1"]))
    mocks.runtimeJobClaimByKind.mockResolvedValueOnce(claim1).mockRejectedValue(NO_QUEUED_JOB)
    mocks.runtimeDerivedMarkerCompleteBatch.mockRejectedValueOnce(new Error("transient network error"))

    startTaxonomyConsumer(PROJECT)
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(0)
    await drainMicrotasks()
    expect(mocks.runtimeDerivedMarkerCompleteBatch).toHaveBeenCalledWith({
      jobId: "job-nest-1",
      leaseId: "job-nest-1-lease",
      markerIds: ["mn1"],
    })

    const claim2 = claimFor("job-nest-2", taxonomyPayload("wiki/nest2.md", ["mn2"]))
    mocks.runtimeJobClaimByKind.mockReset()
    mocks.runtimeJobClaimByKind.mockResolvedValueOnce(claim2).mockRejectedValue(NO_QUEUED_JOB)

    await vi.advanceTimersByTimeAsync(3_000)
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(0)

    expect(mocks.runtimeDerivedMarkerCompleteBatch).toHaveBeenCalledWith({
      jobId: "job-nest-2",
      leaseId: "job-nest-2-lease",
      markerIds: ["mn2"],
    })
  })

  it("does not crash the tick loop when runtimeJobFail itself rejects, and a later tick still processes a different job normally", async () => {
    vi.useFakeTimers()
    const claim1 = claimFor("job-nestf-1", taxonomyPayload("wiki/nestf1.md", ["mnf1"]))
    mocks.runtimeJobClaimByKind.mockResolvedValueOnce(claim1).mockRejectedValue(NO_QUEUED_JOB)
    mocks.applyTagTaxonomyGrowth.mockRejectedValueOnce(new Error("boom"))
    mocks.runtimeJobFail.mockRejectedValueOnce(new Error("transient network error"))

    startTaxonomyConsumer(PROJECT)
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(0)

    const claim2 = claimFor("job-nestf-2", taxonomyPayload("wiki/nestf2.md", ["mnf2"]))
    mocks.runtimeJobClaimByKind.mockReset()
    mocks.runtimeJobClaimByKind.mockResolvedValueOnce(claim2).mockRejectedValue(NO_QUEUED_JOB)
    mocks.applyTagTaxonomyGrowth.mockResolvedValueOnce(successReport())

    await vi.advanceTimersByTimeAsync(3_000)
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(0)

    expect(mocks.runtimeDerivedMarkerCompleteBatch).toHaveBeenCalledWith({
      jobId: "job-nestf-2",
      leaseId: "job-nestf-2-lease",
      markerIds: ["mnf2"],
    })
  })
})
