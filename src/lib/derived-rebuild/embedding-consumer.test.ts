/**
 * Unit tests for the SPEC-6 PR2 embedding-layer `derived-rebuild` job
 * consumer. Fake-runtime style (module-level `vi.mock`, matching
 * `scheduled-import.test.ts`'s pattern rather than commit-integration.ts's
 * injectable-adapter pattern, since embedding-consumer.ts is a
 * module-level singleton poller by design — SPEC-6 PR2 decision 3).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { WikiProject } from "@/types/wiki"
import { DERIVED_REBUILD_JOB_KIND } from "@/core-runtime/derived-rebuild"
import { JOB_RUNTIME_DEFAULTS } from "@/core-runtime/contract"
import { withProjectLock, __resetProjectLocksForTesting } from "@/lib/project-mutex"

const mocks = vi.hoisted(() => ({
  readFile: vi.fn(),
  getQueueSummary: vi.fn(),
  getDedupQueueSummary: vi.fn(),
  embedPage: vi.fn(),
  removePageEmbedding: vi.fn(),
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

vi.mock("@/commands/fs", () => ({ readFile: mocks.readFile }))
vi.mock("@/lib/ingest-queue", () => ({ getQueueSummary: mocks.getQueueSummary }))
vi.mock("@/lib/dedup-queue", () => ({ getQueueSummary: mocks.getDedupQueueSummary }))
vi.mock("@/lib/embedding", () => ({
  embedPage: mocks.embedPage,
  removePageEmbedding: mocks.removePageEmbedding,
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

import { startEmbeddingConsumer, stopEmbeddingConsumer } from "./embedding-consumer"
import { useWikiStore } from "@/stores/wiki-store"

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

async function drainMicrotasks(times = 5): Promise<void> {
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
      holder: "embedding-consumer",
      acquiredAtMs: 0,
      heartbeatAtMs: 0,
      expiresAtMs: 0,
      status: "active",
    },
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
  useWikiStore.setState({
    embeddingConfig: { enabled: true, endpoint: "http://x", apiKey: "", model: "test-embed" },
  })
})

afterEach(() => {
  stopEmbeddingConsumer()
  __resetProjectLocksForTesting()
  vi.useRealTimers()
})

describe("embedding-consumer — dual signal polling", () => {
  it("folds a pending marker into a job, claims it, embeds, and completes via marker-batch (no separate job-complete call)", async () => {
    mocks.runtimeDerivedStaleMarkerList.mockResolvedValueOnce({
      enabled: true,
      status: "healthy",
      markers: [
        { markerId: "m1", layer: "embedding", affectedPath: "wiki/foo.md", baseVersion: "h1", markedAtMs: 1, reason: "commit", sourceEventId: "e1", status: "pending", updatedAtMs: 1 },
      ],
    })
    mocks.runtimeDerivedMarkerClaimBatch.mockResolvedValueOnce({ job: {}, markers: [] })
    const claim = claimFor("job-1", {
      layer: "embedding",
      affectedPath: "wiki/foo.md",
      markerIds: ["m1"],
      baseVersion: "h1",
      inputHash: "h1",
      reason: "commit",
    })
    mocks.runtimeJobClaimByKind.mockResolvedValueOnce(claim)
    mocks.readFile.mockResolvedValueOnce("# Foo\n\nbody")
    mocks.embedPage.mockResolvedValueOnce({ indexed: 1, failed: 0 })

    startEmbeddingConsumer(PROJECT)
    await vi.waitFor(() => expect(mocks.runtimeDerivedMarkerCompleteBatch).toHaveBeenCalled())

    expect(mocks.runtimeDerivedMarkerClaimBatch).toHaveBeenCalledWith({ layer: "embedding", affectedPath: "wiki/foo.md" })
    // SPEC-6 PR3+4 P0-2b regression lock: the claim MUST be scoped to this
    // consumer's own layer server-side, not just kind — otherwise a
    // higher-priority sibling-layer (e.g. "taxonomy") job could win it.
    expect(mocks.runtimeJobClaimByKind).toHaveBeenCalledWith(
      expect.objectContaining({ kind: DERIVED_REBUILD_JOB_KIND, payloadLayer: "embedding" }),
    )
    expect(mocks.embedPage).toHaveBeenCalledWith(
      "/proj",
      expect.any(String),
      expect.any(String),
      "# Foo\n\nbody",
      expect.objectContaining({ enabled: true }),
    )
    expect(mocks.runtimeDerivedMarkerCompleteBatch).toHaveBeenCalledWith({
      jobId: "job-1",
      leaseId: "job-1-lease",
      markerIds: ["m1"],
    })
  })

  it("recovers an eligible retry-wait derived-rebuild job via runtimeJobRetry", async () => {
    mocks.runtimeJobList.mockResolvedValueOnce({
      enabled: true,
      status: "healthy",
      jobs: [
        {
          jobId: "job-2",
          kind: DERIVED_REBUILD_JOB_KIND,
          payload: JSON.stringify({ layer: "embedding", affectedPath: "wiki/bar.md", markerIds: ["m2"], baseVersion: "h2", inputHash: "h2", reason: "commit" }),
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

    startEmbeddingConsumer(PROJECT)
    await vi.waitFor(() => expect(mocks.runtimeJobRetry).toHaveBeenCalledWith("job-2"))
  })

  it("Tester item 4 — retry-wait end-to-end: the recovered job actually gets claimed, re-embedded, and completed with its ORIGINAL job id/markers (not just that runtimeJobRetry was called)", async () => {
    const retryPayload = {
      layer: "embedding",
      affectedPath: "wiki/retry.md",
      markerIds: ["m-retry"],
      baseVersion: "h-retry",
      inputHash: "h-retry",
      reason: "commit",
    }
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
    // The job runtime hands the SAME job back out once runtimeJobRetry
    // has re-queued it — simulated here since the fake here has no real
    // job-runtime state machine backing runtimeJobRetry/claimByKind.
    mocks.runtimeJobClaimByKind.mockResolvedValueOnce(claimFor("job-retry", retryPayload))
    mocks.readFile.mockResolvedValueOnce("# Retry\n\nrecovered body")
    mocks.embedPage.mockResolvedValueOnce({ indexed: 1, failed: 0 })

    startEmbeddingConsumer(PROJECT)
    await vi.waitFor(() => expect(mocks.runtimeDerivedMarkerCompleteBatch).toHaveBeenCalled())

    expect(mocks.runtimeJobRetry).toHaveBeenCalledWith("job-retry")
    // Recovery re-claims through the SAME payloadLayer-scoped call as
    // fresh-marker folding (SPEC-6 PR3+4 P0-2b) — both signals converge on
    // one claim site.
    expect(mocks.runtimeJobClaimByKind).toHaveBeenCalledWith(
      expect.objectContaining({ kind: DERIVED_REBUILD_JOB_KIND, payloadLayer: "embedding" }),
    )
    expect(mocks.embedPage).toHaveBeenCalledWith(
      "/proj",
      expect.any(String),
      expect.any(String),
      "# Retry\n\nrecovered body",
      expect.objectContaining({ enabled: true }),
    )
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
          payload: JSON.stringify({ layer: "embedding", affectedPath: "wiki/bar.md", markerIds: ["m3"], baseVersion: "h3", inputHash: "h3", reason: "commit" }),
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

    startEmbeddingConsumer(PROJECT)
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
          payload: JSON.stringify({ layer: "graph", affectedPath: "wiki/bar.md", markerIds: ["m4"], baseVersion: "h4", inputHash: "h4", reason: "commit" }),
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

    startEmbeddingConsumer(PROJECT)
    await vi.waitFor(() => expect(mocks.runtimeJobList).toHaveBeenCalled())
    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(mocks.runtimeJobRetry).not.toHaveBeenCalled()
  })
})

describe("embedding-consumer — delete intent", () => {
  it("removes the page's embedding and completes without ever reading disk", async () => {
    const claim = claimFor("job-5", {
      layer: "embedding",
      affectedPath: "wiki/gone.md",
      markerIds: ["m5"],
      baseVersion: "h5",
      inputHash: null,
      reason: "delete",
    })
    mocks.runtimeJobClaimByKind.mockResolvedValueOnce(claim)
    mocks.removePageEmbedding.mockResolvedValueOnce(undefined)

    startEmbeddingConsumer(PROJECT)
    await vi.waitFor(() => expect(mocks.runtimeDerivedMarkerCompleteBatch).toHaveBeenCalled())

    expect(mocks.removePageEmbedding).toHaveBeenCalledWith("/proj", expect.any(String))
    expect(mocks.readFile).not.toHaveBeenCalled()
    expect(mocks.embedPage).not.toHaveBeenCalled()
    expect(mocks.runtimeDerivedMarkerCompleteBatch).toHaveBeenCalledWith({
      jobId: "job-5",
      leaseId: "job-5-lease",
      markerIds: ["m5"],
    })
  })
})

describe("embedding-consumer — project lock serialization", () => {
  it("holds the project lock from claimed read through embedding completion, so a concurrent delete waits", async () => {
    const order: string[] = []
    const claim = claimFor("job-lock-consumer-first", {
      layer: "embedding",
      affectedPath: "wiki/racy.md",
      markerIds: ["m-lock"],
      baseVersion: "h-lock",
      inputHash: "h-lock",
      reason: "commit",
    })
    const embedEntered = defer()
    const releaseEmbed = defer<{ indexed: number; failed: number }>()
    mocks.runtimeJobClaimByKind.mockResolvedValueOnce(claim)
    mocks.readFile.mockImplementationOnce(async () => {
      order.push("consumer:read")
      return "# Racy\n\nbody"
    })
    mocks.embedPage.mockImplementationOnce(async () => {
      order.push("consumer:embed:start")
      embedEntered.resolve(undefined)
      return releaseEmbed.promise
    })
    mocks.runtimeDerivedMarkerCompleteBatch.mockImplementationOnce(async () => {
      order.push("consumer:complete")
      return { job: {}, markers: [] }
    })

    startEmbeddingConsumer(PROJECT)
    await embedEntered.promise

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
    expect(order).toEqual(["consumer:read", "consumer:embed:start"])

    releaseEmbed.resolve({ indexed: 1, failed: 0 })
    await deleteCall

    expect(order).toEqual(["consumer:read", "consumer:embed:start", "consumer:complete", "delete:entered"])
    expect(mocks.runtimeDerivedMarkerCompleteBatch).toHaveBeenCalledWith({
      jobId: "job-lock-consumer-first",
      leaseId: "job-lock-consumer-first-lease",
      markerIds: ["m-lock"],
    })
  })

  it("waits behind an existing project lock after claim, before reading the wiki file", async () => {
    const claim = claimFor("job-lock-delete-first", {
      layer: "embedding",
      affectedPath: "wiki/wait.md",
      markerIds: ["m-wait"],
      baseVersion: "h-wait",
      inputHash: "h-wait",
      reason: "commit",
    })
    const holderEntered = defer()
    const releaseHolder = defer()
    const holder = withProjectLock(PROJECT.path, async () => {
      holderEntered.resolve(undefined)
      await releaseHolder.promise
    })
    await holderEntered.promise

    mocks.runtimeJobClaimByKind.mockResolvedValueOnce(claim)
    mocks.readFile.mockResolvedValueOnce("# Wait\n\nbody")
    mocks.embedPage.mockResolvedValueOnce({ indexed: 1, failed: 0 })

    startEmbeddingConsumer(PROJECT)
    await vi.waitFor(() => expect(mocks.runtimeJobClaimByKind).toHaveBeenCalled())
    await Promise.resolve()
    await Promise.resolve()
    expect(mocks.readFile).not.toHaveBeenCalled()

    releaseHolder.resolve(undefined)
    await holder
    await vi.waitFor(() => expect(mocks.runtimeDerivedMarkerCompleteBatch).toHaveBeenCalled())

    expect(mocks.readFile).toHaveBeenCalledWith("/proj/wiki/wait.md")
    expect(mocks.runtimeDerivedMarkerCompleteBatch).toHaveBeenCalledWith({
      jobId: "job-lock-delete-first",
      leaseId: "job-lock-delete-first-lease",
      markerIds: ["m-wait"],
    })
  })

  it("keeps safeFailClaim under the project lock and releases the lock afterward when embedding throws", async () => {
    const order: string[] = []
    const claim = claimFor("job-lock-fail", {
      layer: "embedding",
      affectedPath: "wiki/fail.md",
      markerIds: ["m-fail"],
      baseVersion: "h-fail",
      inputHash: "h-fail",
      reason: "commit",
    })
    const embedEntered = defer()
    const releaseEmbedFailure = defer<{ indexed: number; failed: number }>()
    mocks.runtimeJobClaimByKind.mockResolvedValueOnce(claim)
    mocks.readFile.mockResolvedValueOnce("# Fail\n\nbody")
    mocks.embedPage.mockImplementationOnce(async () => {
      order.push("consumer:embed:start")
      embedEntered.resolve(undefined)
      return releaseEmbedFailure.promise
    })
    mocks.runtimeJobFail.mockImplementationOnce(async () => {
      order.push("consumer:fail")
      return { state: "retry-wait" }
    })

    startEmbeddingConsumer(PROJECT)
    await embedEntered.promise

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

    releaseEmbedFailure.reject(new Error("embed boom"))
    await deleteCall

    expect(order).toEqual(["consumer:embed:start", "consumer:fail", "delete:entered"])
    expect(mocks.runtimeJobFail).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: "job-lock-fail", leaseId: "job-lock-fail-lease", error: "embed boom" }),
    )
    expect(mocks.runtimeDerivedMarkerCompleteBatch).not.toHaveBeenCalled()
  })
})

describe("embedding-consumer — busy backoff (SPEC-6 PR2 decision 2)", () => {
  it("skips the entire tick when ingest is actively processing for this project", async () => {
    mocks.getQueueSummary.mockReturnValue({ pending: 0, processing: 1, failed: 0, completed: 0, total: 1 })

    startEmbeddingConsumer(PROJECT)
    await vi.waitFor(() => expect(mocks.getQueueSummary).toHaveBeenCalled())
    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(mocks.runtimeJobList).not.toHaveBeenCalled()
    expect(mocks.runtimeDerivedStaleMarkerList).not.toHaveBeenCalled()
    expect(mocks.runtimeJobClaimByKind).not.toHaveBeenCalled()
  })

  it("skips the entire tick when the dedup queue is actively processing for this project (closeout hotfix P1 #4)", async () => {
    mocks.getDedupQueueSummary.mockReturnValue({ pending: 0, processing: 1, failed: 0, total: 1 })

    startEmbeddingConsumer(PROJECT)
    await vi.waitFor(() => expect(mocks.getDedupQueueSummary).toHaveBeenCalled())
    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(mocks.runtimeJobList).not.toHaveBeenCalled()
    expect(mocks.runtimeDerivedStaleMarkerList).not.toHaveBeenCalled()
    expect(mocks.runtimeJobClaimByKind).not.toHaveBeenCalled()
  })

  it("Tester item 8 — recovers once ingest settles: busy on tick 1, settled by tick 2, claim_batch eventually runs", async () => {
    vi.useFakeTimers()
    // getQueueSummary is a synchronous accessor polled once per tick —
    // Once/then-default models "busy on the first call, settled after".
    mocks.getQueueSummary
      .mockReturnValueOnce({ pending: 0, processing: 1, failed: 0, completed: 0, total: 1 })
      .mockReturnValue({ pending: 0, processing: 0, failed: 0, completed: 0, total: 0 })
    mocks.runtimeDerivedStaleMarkerList.mockResolvedValueOnce({
      enabled: true,
      status: "healthy",
      markers: [
        { markerId: "m-busy", layer: "embedding", affectedPath: "wiki/busy.md", baseVersion: "h", markedAtMs: 1, reason: "commit", sourceEventId: "e", status: "pending", updatedAtMs: 1 },
      ],
    })
    const claim = claimFor("job-busy", {
      layer: "embedding",
      affectedPath: "wiki/busy.md",
      markerIds: ["m-busy"],
      baseVersion: "h",
      inputHash: "h",
      reason: "commit",
    })
    mocks.runtimeJobClaimByKind.mockResolvedValueOnce(claim)
    mocks.readFile.mockResolvedValueOnce("body")
    mocks.embedPage.mockResolvedValueOnce({ indexed: 1, failed: 0 })

    startEmbeddingConsumer(PROJECT)
    await vi.advanceTimersByTimeAsync(0)
    // Tick 1: busy — nothing beyond the queue-summary check happens.
    expect(mocks.runtimeDerivedMarkerClaimBatch).not.toHaveBeenCalled()

    // TICK_INTERVAL_MS in the source is 3_000 — advancing past it fires
    // tick 2, which now observes ingest as settled.
    await vi.advanceTimersByTimeAsync(3_000)
    await vi.advanceTimersByTimeAsync(0)

    expect(mocks.runtimeDerivedMarkerClaimBatch).toHaveBeenCalledWith({ layer: "embedding", affectedPath: "wiki/busy.md" })
    expect(mocks.runtimeDerivedMarkerCompleteBatch).toHaveBeenCalledWith({
      jobId: "job-busy",
      leaseId: "job-busy-lease",
      markerIds: ["m-busy"],
    })
  })
})

describe("embedding-consumer — partial failure", () => {
  it("fails (not completes) the job when embedPage reports a partial chunk failure, keeping markers claimed", async () => {
    const claim = claimFor("job-6", {
      layer: "embedding",
      affectedPath: "wiki/partial.md",
      markerIds: ["m6"],
      baseVersion: "h6",
      inputHash: "h6",
      reason: "commit",
    })
    mocks.runtimeJobClaimByKind.mockResolvedValueOnce(claim)
    mocks.readFile.mockResolvedValueOnce("body")
    mocks.embedPage.mockResolvedValueOnce({ indexed: 1, failed: 1 })
    mocks.runtimeJobFail.mockResolvedValueOnce({ state: "retry-wait" })

    startEmbeddingConsumer(PROJECT)
    await vi.waitFor(() => expect(mocks.runtimeJobFail).toHaveBeenCalled())

    expect(mocks.runtimeJobFail).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: "job-6", leaseId: "job-6-lease", error: expect.stringContaining("1/2") }),
    )
    expect(mocks.runtimeDerivedMarkerCompleteBatch).not.toHaveBeenCalled()
    // Non-terminal outcome (attempts remain): markers stay claimed under
    // the same job — no explicit release call (PR1's orphan-marker fix).
    expect(mocks.runtimeDerivedMarkerReleaseBatch).not.toHaveBeenCalled()
  })

  it("releases the claimed markers to failed when the job-fail call reports the job reached its terminal state", async () => {
    const claim = claimFor("job-7", {
      layer: "embedding",
      affectedPath: "wiki/partial.md",
      markerIds: ["m7"],
      baseVersion: "h7",
      inputHash: "h7",
      reason: "commit",
    })
    mocks.runtimeJobClaimByKind.mockResolvedValueOnce(claim)
    mocks.readFile.mockResolvedValueOnce("body")
    mocks.embedPage.mockResolvedValueOnce({ indexed: 0, failed: 1 })
    mocks.runtimeJobFail.mockResolvedValueOnce({ state: "failed" })

    startEmbeddingConsumer(PROJECT)
    await vi.waitFor(() => expect(mocks.runtimeDerivedMarkerReleaseBatch).toHaveBeenCalled())

    expect(mocks.runtimeDerivedMarkerReleaseBatch).toHaveBeenCalledWith({
      jobId: "job-7",
      markerIds: ["m7"],
      targetStatus: "failed",
      error: expect.any(String),
    })
  })

  it("fails a job with an unparseable payload (no marker ids to release) without crashing the tick loop", async () => {
    const claim = {
      job: {
        jobId: "job-8",
        kind: DERIVED_REBUILD_JOB_KIND,
        payload: "not json",
        state: "running" as const,
        attempt: 1,
        maxAttempts: 3,
        priority: 0,
        createdAtMs: 0,
        updatedAtMs: 0,
      },
      lease: { leaseId: "job-8-lease", jobId: "job-8", holder: "embedding-consumer", acquiredAtMs: 0, heartbeatAtMs: 0, expiresAtMs: 0, status: "active" },
    }
    mocks.runtimeJobClaimByKind.mockResolvedValueOnce(claim)
    mocks.runtimeJobFail.mockResolvedValueOnce({ state: "retry-wait" })

    startEmbeddingConsumer(PROJECT)
    await vi.waitFor(() =>
      expect(mocks.runtimeJobFail).toHaveBeenCalledWith(
        expect.objectContaining({ jobId: "job-8", error: expect.stringContaining("invalid-payload") }),
      ),
    )
    expect(mocks.runtimeDerivedMarkerReleaseBatch).not.toHaveBeenCalled()
  })

  it("Tester item 7a — does not crash the tick loop when complete_batch itself rejects, and a later tick still processes a different job normally", async () => {
    vi.useFakeTimers()
    const claim1 = claimFor("job-nest-1", {
      layer: "embedding",
      affectedPath: "wiki/nest1.md",
      markerIds: ["mn1"],
      baseVersion: "h",
      inputHash: "h",
      reason: "commit",
    })
    mocks.runtimeJobClaimByKind.mockResolvedValueOnce(claim1).mockRejectedValue(NO_QUEUED_JOB)
    mocks.readFile.mockResolvedValue("body")
    mocks.embedPage.mockResolvedValue({ indexed: 1, failed: 0 })
    mocks.runtimeDerivedMarkerCompleteBatch.mockRejectedValueOnce(new Error("transient network error"))

    startEmbeddingConsumer(PROJECT)
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(0)

    // The rejection above must not have propagated out of the tick loop
    // — proven not by "no throw" alone but by the consumer still being
    // alive and functional afterward: a second, unrelated job appears for
    // the next scheduled tick and completes normally. (job-nest-1's own
    // lease/claimed marker recovers independently via the existing
    // lease-timeout reclaim scheduler — this consumer does nothing
    // special to "retry" a failed complete_batch call itself.)
    const claim2 = claimFor("job-nest-2", {
      layer: "embedding",
      affectedPath: "wiki/nest2.md",
      markerIds: ["mn2"],
      baseVersion: "h",
      inputHash: "h",
      reason: "commit",
    })
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

  it("Tester item 7b — does not crash the tick loop when runtimeJobFail itself rejects, and a later tick still processes a different job normally", async () => {
    vi.useFakeTimers()
    const claim1 = claimFor("job-nestf-1", {
      layer: "embedding",
      affectedPath: "wiki/nestf1.md",
      markerIds: ["mnf1"],
      baseVersion: "h",
      inputHash: "h",
      reason: "commit",
    })
    mocks.runtimeJobClaimByKind.mockResolvedValueOnce(claim1).mockRejectedValue(NO_QUEUED_JOB)
    mocks.readFile.mockResolvedValueOnce("body")
    // Partial failure drives the safeFailClaim path, which itself rejects.
    mocks.embedPage.mockResolvedValueOnce({ indexed: 0, failed: 1 })
    mocks.runtimeJobFail.mockRejectedValueOnce(new Error("transient network error"))

    startEmbeddingConsumer(PROJECT)
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(0)

    const claim2 = claimFor("job-nestf-2", {
      layer: "embedding",
      affectedPath: "wiki/nestf2.md",
      markerIds: ["mnf2"],
      baseVersion: "h",
      inputHash: "h",
      reason: "commit",
    })
    mocks.runtimeJobClaimByKind.mockReset()
    mocks.runtimeJobClaimByKind.mockResolvedValueOnce(claim2).mockRejectedValue(NO_QUEUED_JOB)
    mocks.readFile.mockResolvedValueOnce("body")
    mocks.embedPage.mockResolvedValueOnce({ indexed: 1, failed: 0 })

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

describe("embedding-consumer — heartbeat rides along", () => {
  it("heartbeats the claimed lease while embedPage is slow, and stops heartbeating once the job is complete", async () => {
    vi.useFakeTimers()
    const claim = claimFor("job-9", {
      layer: "embedding",
      affectedPath: "wiki/slow.md",
      markerIds: ["m9"],
      baseVersion: "h9",
      inputHash: "h9",
      reason: "commit",
    })
    mocks.runtimeJobClaimByKind.mockResolvedValueOnce(claim)
    mocks.readFile.mockResolvedValueOnce("body")
    let resolveEmbed!: (value: { indexed: number; failed: number }) => void
    mocks.embedPage.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveEmbed = resolve
      }),
    )

    startEmbeddingConsumer(PROJECT)
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(0)

    await vi.advanceTimersByTimeAsync(JOB_RUNTIME_DEFAULTS.heartbeatMinIntervalMs * 2 + 10)
    expect(mocks.runtimeJobHeartbeat).toHaveBeenCalledWith({ jobId: "job-9", leaseId: "job-9-lease" })
    const heartbeatsWhileRunning = mocks.runtimeJobHeartbeat.mock.calls.length
    expect(heartbeatsWhileRunning).toBeGreaterThan(0)

    resolveEmbed({ indexed: 1, failed: 0 })
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(0)
    expect(mocks.runtimeDerivedMarkerCompleteBatch).toHaveBeenCalled()

    const heartbeatsAfterComplete = mocks.runtimeJobHeartbeat.mock.calls.length
    await vi.advanceTimersByTimeAsync(JOB_RUNTIME_DEFAULTS.heartbeatMinIntervalMs * 3)
    expect(mocks.runtimeJobHeartbeat.mock.calls.length).toBe(heartbeatsAfterComplete)
  })
})

describe("embedding-consumer — defensive skips", () => {
  it("leaves a claimed job for a different derived-rebuild layer untouched (self-heals via lease timeout)", async () => {
    const claim = claimFor("job-10", {
      layer: "graph",
      affectedPath: "wiki/g.md",
      markerIds: ["m10"],
      baseVersion: "h10",
      inputHash: "h10",
      reason: "commit",
    })
    mocks.runtimeJobClaimByKind.mockResolvedValueOnce(claim)
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})

    startEmbeddingConsumer(PROJECT)
    await vi.waitFor(() => expect(warnSpy).toHaveBeenCalled())

    expect(mocks.runtimeDerivedMarkerCompleteBatch).not.toHaveBeenCalled()
    expect(mocks.runtimeJobFail).not.toHaveBeenCalled()
    expect(mocks.embedPage).not.toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it("completes a structural-page marker as a no-op without ever embedding it", async () => {
    const claim = claimFor("job-11", {
      layer: "embedding",
      affectedPath: "wiki/index.md",
      markerIds: ["m11"],
      baseVersion: "h11",
      inputHash: "h11",
      reason: "commit",
    })
    mocks.runtimeJobClaimByKind.mockResolvedValueOnce(claim)

    startEmbeddingConsumer(PROJECT)
    await vi.waitFor(() => expect(mocks.runtimeDerivedMarkerCompleteBatch).toHaveBeenCalled())

    expect(mocks.readFile).not.toHaveBeenCalled()
    expect(mocks.embedPage).not.toHaveBeenCalled()
  })

  it("completes as a no-op when embedding is disabled, instead of failing/retrying forever", async () => {
    useWikiStore.setState({ embeddingConfig: { enabled: false, endpoint: "", apiKey: "", model: "" } })
    const claim = claimFor("job-12", {
      layer: "embedding",
      affectedPath: "wiki/x.md",
      markerIds: ["m12"],
      baseVersion: "h12",
      inputHash: "h12",
      reason: "commit",
    })
    mocks.runtimeJobClaimByKind.mockResolvedValueOnce(claim)

    startEmbeddingConsumer(PROJECT)
    await vi.waitFor(() => expect(mocks.runtimeDerivedMarkerCompleteBatch).toHaveBeenCalled())

    expect(mocks.embedPage).not.toHaveBeenCalled()
  })

  it("treats a page missing on disk (re-read, not payload snapshot) as an implicit delete", async () => {
    const claim = claimFor("job-13", {
      layer: "embedding",
      affectedPath: "wiki/missing.md",
      markerIds: ["m13"],
      baseVersion: "h13",
      inputHash: "h13",
      reason: "commit",
    })
    mocks.runtimeJobClaimByKind.mockResolvedValueOnce(claim)
    // Exact prefix fs.rs's read_file uses for "path doesn't exist" — the
    // only shape that should be treated as an implicit delete.
    mocks.readFile.mockRejectedValueOnce(new Error("File does not exist: '/proj/wiki/missing.md'"))

    startEmbeddingConsumer(PROJECT)
    await vi.waitFor(() => expect(mocks.runtimeDerivedMarkerCompleteBatch).toHaveBeenCalled())

    expect(mocks.removePageEmbedding).toHaveBeenCalled()
    expect(mocks.embedPage).not.toHaveBeenCalled()
  })

  it("gate review P1: a read failure on a page that DOES exist (binary/locked/non-UTF-8 — the shape a concurrent write window produces) fails the job instead of deleting its embedding", async () => {
    const claim = claimFor("job-14b", {
      layer: "embedding",
      affectedPath: "wiki/concurrent-write.md",
      markerIds: ["m14b"],
      baseVersion: "h14b",
      inputHash: "h14b",
      reason: "commit",
    })
    mocks.runtimeJobClaimByKind.mockResolvedValueOnce(claim)
    // fs.rs's OTHER read_file error shape — the path exists but isn't
    // readable as text right now. Must NOT be confused with "deleted".
    mocks.readFile.mockRejectedValueOnce(
      new Error("Failed to read file '/proj/wiki/concurrent-write.md' as text: stream did not contain valid UTF-8 (likely binary, locked, or non-UTF-8)"),
    )
    mocks.runtimeJobFail.mockResolvedValueOnce({ state: "retry-wait" })

    startEmbeddingConsumer(PROJECT)
    await vi.waitFor(() => expect(mocks.runtimeJobFail).toHaveBeenCalled())

    expect(mocks.removePageEmbedding).not.toHaveBeenCalled()
    expect(mocks.embedPage).not.toHaveBeenCalled()
    expect(mocks.runtimeDerivedMarkerCompleteBatch).not.toHaveBeenCalled()
    expect(mocks.runtimeJobFail).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: "job-14b", leaseId: "job-14b-lease", error: expect.stringContaining("read-failed") }),
    )
  })
})

describe("embedding-consumer — quiet error handling", () => {
  it("treats 'no-queued-job' as normal tick completion, not a warning", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})

    startEmbeddingConsumer(PROJECT)
    await vi.waitFor(() => expect(mocks.runtimeJobClaimByKind).toHaveBeenCalled())
    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(warnSpy).not.toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it("treats 'runtime-disabled' as a quiet no-op across the whole tick", async () => {
    mocks.runtimeJobList.mockRejectedValueOnce(new Error("runtime-disabled: work runtime is disabled"))
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})

    startEmbeddingConsumer(PROJECT)
    await vi.waitFor(() => expect(mocks.runtimeJobList).toHaveBeenCalled())
    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(warnSpy).not.toHaveBeenCalled()
    warnSpy.mockRestore()
  })
})

describe("embedding-consumer — project switch / generation lifecycle (SPEC-11 PR8b/S8)", () => {
  it("abandons an already-claimed job without completing/failing it once the project switches mid-flight", async () => {
    const claim = claimFor("job-14", {
      layer: "embedding",
      affectedPath: "wiki/switch.md",
      markerIds: ["m14"],
      baseVersion: "h14",
      inputHash: "h14",
      reason: "commit",
    })
    mocks.runtimeJobClaimByKind.mockResolvedValueOnce(claim)
    let resolveRead!: (value: string) => void
    mocks.readFile.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveRead = resolve
      }),
    )

    startEmbeddingConsumer(PROJECT)
    await vi.waitFor(() => expect(mocks.readFile).toHaveBeenCalled())

    // The project switches away mid-flight — exactly what
    // reset-project-state.ts's centralized cleanup does.
    stopEmbeddingConsumer()

    resolveRead("body")
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(mocks.embedPage).not.toHaveBeenCalled()
    expect(mocks.runtimeDerivedMarkerCompleteBatch).not.toHaveBeenCalled()
    expect(mocks.runtimeJobFail).not.toHaveBeenCalled()
  })

  it("a fresh start for a new project runs independently of a stopped previous run", async () => {
    startEmbeddingConsumer(PROJECT)
    await vi.waitFor(() => expect(mocks.runtimeJobList).toHaveBeenCalledTimes(1))
    stopEmbeddingConsumer()

    const otherProject: WikiProject = { id: "p2", name: "P2", path: "/proj2" }
    startEmbeddingConsumer(otherProject)
    await vi.waitFor(() => expect(mocks.runtimeJobList).toHaveBeenCalledTimes(2))
  })

  it("Tester item 5 — same-project close/reopen: the OLD tick's claimed job is never completed/failed, and the new run for the SAME project proceeds independently", async () => {
    const oldClaim = claimFor("job-old", {
      layer: "embedding",
      affectedPath: "wiki/old.md",
      markerIds: ["m-old"],
      baseVersion: "h-old",
      inputHash: "h-old",
      reason: "commit",
    })
    mocks.runtimeJobClaimByKind.mockResolvedValueOnce(oldClaim)
    let resolveRead!: (value: string) => void
    mocks.readFile.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveRead = resolve
      }),
    )

    startEmbeddingConsumer(PROJECT)
    await vi.waitFor(() => expect(mocks.readFile).toHaveBeenCalled())
    // The old tick's own recoverRetryWaitJobs call already landed before
    // it got as far as claiming/reading job-old.
    expect(mocks.runtimeJobList).toHaveBeenCalledTimes(1)

    // Close and immediately reopen the SAME project — not a switch to a
    // different one — while the old tick is still stuck mid-flight.
    stopEmbeddingConsumer()
    startEmbeddingConsumer(PROJECT)

    // The new run's own first tick must proceed independently, not be
    // blocked by the old (still unwinding) generation's reentrancy slot
    // (gate review P2).
    await vi.waitFor(() => expect(mocks.runtimeJobList).toHaveBeenCalledTimes(2))

    resolveRead("body")
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(mocks.embedPage).not.toHaveBeenCalled()
    expect(mocks.runtimeDerivedMarkerCompleteBatch).not.toHaveBeenCalled()
    expect(mocks.runtimeJobFail).not.toHaveBeenCalled()
  })

  it("Tester item 10 (gate review P2, sabotage-verified) — an old generation's dying tick cannot clear a new generation's reentrancy guard and cause a double-tick for the new generation", async () => {
    vi.useFakeTimers()

    // Generation 1 (old): claims a job and stalls on its readFile.
    const oldClaim = claimFor("job-old", {
      layer: "embedding",
      affectedPath: "wiki/old.md",
      markerIds: ["m-old"],
      baseVersion: "h",
      inputHash: "h",
      reason: "commit",
    })
    mocks.runtimeJobClaimByKind.mockResolvedValueOnce(oldClaim)
    let resolveOldRead!: (value: string) => void
    mocks.readFile.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveOldRead = resolve
      }),
    )

    startEmbeddingConsumer(PROJECT)
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(0)
    expect(mocks.readFile).toHaveBeenCalledTimes(1)

    // Generation 2 (new, same project): claims a DIFFERENT job, then waits
    // behind generation 1's still-held project lock before reading.
    stopEmbeddingConsumer()
    const newClaim = claimFor("job-new", {
      layer: "embedding",
      affectedPath: "wiki/new.md",
      markerIds: ["m-new"],
      baseVersion: "h",
      inputHash: "h",
      reason: "commit",
    })
    mocks.runtimeJobClaimByKind.mockReset()
    mocks.runtimeJobClaimByKind.mockResolvedValueOnce(newClaim).mockRejectedValue(NO_QUEUED_JOB)
    let resolveNewRead!: (value: string) => void
    mocks.readFile.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveNewRead = resolve
      }),
    )
    mocks.embedPage.mockResolvedValueOnce({ indexed: 1, failed: 0 })

    startEmbeddingConsumer(PROJECT)
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(0)
    await drainMicrotasks()
    expect(mocks.runtimeJobClaimByKind).toHaveBeenCalledTimes(1)
    expect(mocks.readFile).toHaveBeenCalledTimes(1)

    // Let generation 1's stalled read resolve now — its tick hits
    // assertCurrentRun, self-aborts, and releases the project lock.
    // Under the pre-fix single shared boolean, this finally would have
    // cleared generation 2's reentrancy flag too.
    resolveOldRead("old body")
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(0)
    await drainMicrotasks()
    expect(mocks.readFile).toHaveBeenCalledTimes(2)
    expect(mocks.runtimeDerivedMarkerCompleteBatch).not.toHaveBeenCalled()
    expect(mocks.runtimeJobFail).not.toHaveBeenCalled()

    // Generation 2's FIRST tick is still stuck on its own readFile
    // (resolveNewRead not called yet). Advance past the next scheduled
    // interval tick for generation 2 — with a correctly per-generation
    // guard this must be skipped (no second overlapping claim call for
    // generation 2); with the old shared-boolean design it would fire a
    // second, overlapping tick right now.
    await vi.advanceTimersByTimeAsync(3_000)
    await vi.advanceTimersByTimeAsync(0)
    expect(mocks.runtimeJobClaimByKind.mock.calls.length).toBe(1)

    // Generation 2 finishes normally once its own read resolves.
    resolveNewRead("new body")
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(0)
    expect(mocks.runtimeDerivedMarkerCompleteBatch).toHaveBeenCalledWith({
      jobId: "job-new",
      leaseId: "job-new-lease",
      markerIds: ["m-new"],
    })
  })
})
