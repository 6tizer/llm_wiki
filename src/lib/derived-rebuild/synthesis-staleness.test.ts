/**
 * Unit tests for SPEC-6 PR3+4's synthesis staleness query + manual-rebuild
 * marker closeout. Fake-runtime style (module-level `vi.mock`), same
 * convention as `embedding-consumer.test.ts`/`taxonomy-consumer.test.ts`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { SynthesisDiscoveryReport } from "@/lib/wiki-synthesis"

const mocks = vi.hoisted(() => ({
  runtimeDerivedStaleMarkerList: vi.fn(),
  runtimeDerivedMarkerClaimBatch: vi.fn(),
  runtimeDerivedMarkerCompleteBatch: vi.fn(),
  runtimeJobClaim: vi.fn(),
  discoverSynthesisCandidates: vi.fn(),
}))

vi.mock("@/commands/runtime-db", () => ({
  runtimeDerivedStaleMarkerList: mocks.runtimeDerivedStaleMarkerList,
  runtimeDerivedMarkerClaimBatch: mocks.runtimeDerivedMarkerClaimBatch,
  runtimeDerivedMarkerCompleteBatch: mocks.runtimeDerivedMarkerCompleteBatch,
  runtimeJobClaim: mocks.runtimeJobClaim,
}))

vi.mock("@/lib/wiki-synthesis", () => ({
  discoverSynthesisCandidates: mocks.discoverSynthesisCandidates,
}))

import { listSynthesisStaleness, markSynthesisRebuilt } from "./synthesis-staleness"

function marker(overrides: Partial<{ markerId: string; affectedPath: string }> = {}) {
  return {
    markerId: "m1",
    layer: "synthesis",
    affectedPath: "wiki/concept/a.md",
    baseVersion: "h",
    markedAtMs: 1,
    reason: "commit" as const,
    sourceEventId: "e1",
    status: "pending" as const,
    updatedAtMs: 1,
    ...overrides,
  }
}

function discoveryWith(candidates: SynthesisDiscoveryReport["candidates"]): SynthesisDiscoveryReport {
  return {
    dimension: 1,
    minClusterSize: 3,
    maxCandidates: 10,
    scannedPages: candidates.reduce((sum, c) => sum + c.pageCount, 0),
    eligiblePages: candidates.reduce((sum, c) => sum + c.pageCount, 0),
    totalCandidates: candidates.length,
    returnedCandidates: candidates.length,
    truncated: false,
    truncatedCount: 0,
    candidates,
  }
}

/** Simulates the job-runtime handing back a lease for the exact requested jobId. */
function claimResultFor(jobId: string) {
  return {
    job: {
      jobId,
      kind: "derived-rebuild",
      payload: "{}",
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
      holder: "synthesis-manual-rebuild",
      acquiredAtMs: 0,
      heartbeatAtMs: 0,
      expiresAtMs: 0,
      status: "active",
    },
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe("listSynthesisStaleness", () => {
  it("returns an empty report when there are no pending synthesis markers, without calling discovery at all", async () => {
    mocks.runtimeDerivedStaleMarkerList.mockResolvedValueOnce({ enabled: true, status: "healthy", markers: [] })

    const report = await listSynthesisStaleness("/proj")

    expect(report).toEqual({ pendingMarkerCount: 0, staleClusters: [] })
    expect(mocks.discoverSynthesisCandidates).not.toHaveBeenCalled()
  })

  it("correlates a pending marker's affectedPath to the cluster containing that page", async () => {
    mocks.runtimeDerivedStaleMarkerList.mockResolvedValueOnce({
      enabled: true,
      status: "healthy",
      markers: [marker({ markerId: "m1", affectedPath: "wiki/concept/a.md" })],
    })
    mocks.discoverSynthesisCandidates.mockResolvedValueOnce(
      discoveryWith([
        {
          tags: ["llm"],
          topic: "llm",
          slug: "llm",
          pageCount: 2,
          pages: [
            { slug: "concept/a", title: "A", type: "concept", tags: ["llm"], body: "" },
            { slug: "concept/b", title: "B", type: "concept", tags: ["llm"], body: "" },
          ],
        },
      ]),
    )

    const report = await listSynthesisStaleness("/proj", { dimension: 1 })

    expect(report.pendingMarkerCount).toBe(1)
    expect(report.staleClusters).toEqual([
      {
        slug: "llm",
        topic: "llm",
        tags: ["llm"],
        pageCount: 2,
        staleAffectedPaths: ["wiki/concept/a.md"],
        markerIds: ["m1"],
      },
    ])
    expect(mocks.discoverSynthesisCandidates).toHaveBeenCalledWith("/proj", { dimension: 1 })
  })

  it("excludes a cluster whose pages have no pending markers", async () => {
    mocks.runtimeDerivedStaleMarkerList.mockResolvedValueOnce({
      enabled: true,
      status: "healthy",
      markers: [marker({ markerId: "m1", affectedPath: "wiki/concept/unrelated.md" })],
    })
    mocks.discoverSynthesisCandidates.mockResolvedValueOnce(
      discoveryWith([
        {
          tags: ["llm"],
          topic: "llm",
          slug: "llm",
          pageCount: 1,
          pages: [{ slug: "concept/a", title: "A", type: "concept", tags: ["llm"], body: "" }],
        },
      ]),
    )

    const report = await listSynthesisStaleness("/proj")
    expect(report.staleClusters).toEqual([])
    expect(report.pendingMarkerCount).toBe(1)
  })

  it("aggregates multiple stale pages and marker ids within one cluster", async () => {
    mocks.runtimeDerivedStaleMarkerList.mockResolvedValueOnce({
      enabled: true,
      status: "healthy",
      markers: [
        marker({ markerId: "m1", affectedPath: "wiki/concept/a.md" }),
        marker({ markerId: "m2", affectedPath: "wiki/concept/b.md" }),
      ],
    })
    mocks.discoverSynthesisCandidates.mockResolvedValueOnce(
      discoveryWith([
        {
          tags: ["llm"],
          topic: "llm",
          slug: "llm",
          pageCount: 2,
          pages: [
            { slug: "concept/a", title: "A", type: "concept", tags: ["llm"], body: "" },
            { slug: "concept/b", title: "B", type: "concept", tags: ["llm"], body: "" },
          ],
        },
      ]),
    )

    const report = await listSynthesisStaleness("/proj")
    expect(report.staleClusters).toHaveLength(1)
    expect(report.staleClusters[0].staleAffectedPaths.sort()).toEqual(["wiki/concept/a.md", "wiki/concept/b.md"])
    expect(report.staleClusters[0].markerIds.sort()).toEqual(["m1", "m2"])
  })
})

describe("markSynthesisRebuilt", () => {
  const candidate = {
    slug: "llm",
    pages: [
      { slug: "concept/a", title: "A", type: "concept", tags: ["llm"], body: "" },
      { slug: "concept/b", title: "B", type: "concept", tags: ["llm"], body: "" },
    ],
  }

  it("folds each page's pending marker group via claim_batch WITHOUT a caller-chosen jobId (P0-1), claims the exact server-generated job id (P0-2a, no hunt loop), and completes it", async () => {
    // The fake here simulates the job runtime minting its OWN UUID per
    // claim_batch call (PR1 default) — the real regression this guards
    // against is a caller-supplied DETERMINISTIC jobId colliding on repeat
    // calls, so the mock deliberately returns a fresh, path-derived (but
    // NOT request-echoed) id to prove the code never assumes one.
    mocks.runtimeDerivedMarkerClaimBatch.mockImplementation(async (request: { layer: string; affectedPath: string }) => ({
      job: { jobId: `server-uuid-for-${request.affectedPath}` },
      markers: [{ markerId: `marker-for-${request.affectedPath}` }],
    }))
    mocks.runtimeJobClaim.mockImplementation(async (request: { holder: string; jobId: string }) =>
      claimResultFor(request.jobId),
    )

    const result = await markSynthesisRebuilt(candidate)

    expect(result.completedGroups).toBe(2)
    expect(result.skippedGroups).toBe(0)
    // P0-1: claim_batch is called with NO jobId field at all.
    expect(mocks.runtimeDerivedMarkerClaimBatch).toHaveBeenCalledWith({
      layer: "synthesis",
      affectedPath: "wiki/concept/a.md",
    })
    expect(mocks.runtimeDerivedMarkerClaimBatch).toHaveBeenCalledWith({
      layer: "synthesis",
      affectedPath: "wiki/concept/b.md",
    })
    // P0-2a: the exact server-returned job id is claimed directly — one
    // targeted call, not a claim-by-kind hunt.
    expect(mocks.runtimeJobClaim).toHaveBeenCalledWith({
      holder: "synthesis-manual-rebuild",
      jobId: "server-uuid-for-wiki/concept/a.md",
    })
    expect(mocks.runtimeJobClaim).toHaveBeenCalledWith({
      holder: "synthesis-manual-rebuild",
      jobId: "server-uuid-for-wiki/concept/b.md",
    })
    expect(mocks.runtimeDerivedMarkerCompleteBatch).toHaveBeenCalledWith({
      jobId: "server-uuid-for-wiki/concept/a.md",
      leaseId: "server-uuid-for-wiki/concept/a.md-lease",
      markerIds: ["marker-for-wiki/concept/a.md"],
    })
    expect(mocks.runtimeDerivedMarkerCompleteBatch).toHaveBeenCalledWith({
      jobId: "server-uuid-for-wiki/concept/b.md",
      leaseId: "server-uuid-for-wiki/concept/b.md-lease",
      markerIds: ["marker-for-wiki/concept/b.md"],
    })
  })

  it("P0-1 sabotage guard: the SAME candidate rebuilt twice in a row (overlapping/repeat manual rebuilds) both succeed — a deterministic jobId would collide on the second call's claim_batch insert", async () => {
    let call = 0
    mocks.runtimeDerivedMarkerClaimBatch.mockImplementation(async (request: { affectedPath: string }) => {
      call += 1
      // A fresh id every single call (including across the two top-level
      // markSynthesisRebuilt invocations below) — exactly what a real
      // server-generated UUID looks like, and exactly what a
      // (slug, affectedPath)-derived deterministic id would NOT produce.
      return {
        job: { jobId: `uuid-${call}-${request.affectedPath}` },
        markers: [{ markerId: `marker-${call}` }],
      }
    })
    mocks.runtimeJobClaim.mockImplementation(async (request: { jobId: string }) => claimResultFor(request.jobId))

    const first = await markSynthesisRebuilt(candidate)
    const second = await markSynthesisRebuilt(candidate)

    expect(first.completedGroups).toBe(2)
    expect(second.completedGroups).toBe(2)
    // Every claim_batch call across BOTH invocations omitted jobId — if a
    // deterministic id had been reused, the second call would need to
    // reuse the first's ids too (it doesn't: 4 distinct jobIds claimed).
    const claimedJobIds = mocks.runtimeJobClaim.mock.calls.map((call) => call[0].jobId)
    expect(new Set(claimedJobIds).size).toBe(4)
    for (const call of mocks.runtimeDerivedMarkerClaimBatch.mock.calls) {
      expect(call[0]).not.toHaveProperty("jobId")
    }
  })

  it("skips (without throwing) a page whose group has no pending markers to fold", async () => {
    mocks.runtimeDerivedMarkerClaimBatch.mockRejectedValue(
      new Error("derived-marker-claim-empty: no pending markers for layer 'synthesis' and affectedPath 'wiki/concept/a.md'"),
    )

    const result = await markSynthesisRebuilt({ slug: "llm", pages: [candidate.pages[0]] })

    expect(result.completedGroups).toBe(0)
    expect(result.skippedGroups).toBe(1)
    expect(mocks.runtimeJobClaim).not.toHaveBeenCalled()
    expect(mocks.runtimeDerivedMarkerCompleteBatch).not.toHaveBeenCalled()
  })

  it("skips a group (logs, does not throw) when runtimeJobClaim itself fails for the just-created job, and still processes a later page in the same call", async () => {
    mocks.runtimeDerivedMarkerClaimBatch.mockImplementation(async (request: { affectedPath: string }) => ({
      job: { jobId: `job-for-${request.affectedPath}` },
      markers: [{ markerId: `marker-for-${request.affectedPath}` }],
    }))
    mocks.runtimeJobClaim.mockImplementation(async (request: { jobId: string }) => {
      if (request.jobId === "job-for-wiki/concept/a.md") {
        throw new Error("job-claim-select-failed: unexpected")
      }
      return claimResultFor(request.jobId)
    })
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})

    const result = await markSynthesisRebuilt(candidate)

    expect(result.completedGroups).toBe(1)
    expect(result.skippedGroups).toBe(1)
    expect(warnSpy).toHaveBeenCalled()
    expect(mocks.runtimeDerivedMarkerCompleteBatch).toHaveBeenCalledWith({
      jobId: "job-for-wiki/concept/b.md",
      leaseId: "job-for-wiki/concept/b.md-lease",
      markerIds: ["marker-for-wiki/concept/b.md"],
    })
    expect(mocks.runtimeDerivedMarkerCompleteBatch).not.toHaveBeenCalledWith(
      expect.objectContaining({ jobId: "job-for-wiki/concept/a.md" }),
    )
    warnSpy.mockRestore()
  })

  it("does not throw when complete_batch itself rejects — the group is counted as skipped", async () => {
    mocks.runtimeDerivedMarkerClaimBatch.mockResolvedValueOnce({
      job: { jobId: "job-a" },
      markers: [{ markerId: "ma" }],
    })
    mocks.runtimeJobClaim.mockResolvedValueOnce(claimResultFor("job-a"))
    mocks.runtimeDerivedMarkerCompleteBatch.mockRejectedValueOnce(new Error("transient"))
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})

    const result = await markSynthesisRebuilt({ slug: "llm", pages: [candidate.pages[0]] })

    expect(result.completedGroups).toBe(0)
    expect(result.skippedGroups).toBe(1)
    expect(warnSpy).toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it("short-circuits immediately when the runtime is disabled, without throwing", async () => {
    mocks.runtimeDerivedMarkerClaimBatch.mockRejectedValueOnce(new Error("runtime-disabled: work runtime is disabled"))

    const result = await markSynthesisRebuilt(candidate)

    expect(result.completedGroups).toBe(0)
    expect(mocks.runtimeJobClaim).not.toHaveBeenCalled()
  })
})
