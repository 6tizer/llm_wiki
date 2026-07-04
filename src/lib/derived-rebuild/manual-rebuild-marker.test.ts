import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  runtimeJobCreate: vi.fn(),
  runtimeJobClaim: vi.fn(),
  runtimeJobClaimByKind: vi.fn(),
  runtimeJobComplete: vi.fn(),
  runtimeEventAppend: vi.fn(),
  runtimeDerivedStaleMarkerRecord: vi.fn(),
  listDirectory: vi.fn(),
}))

vi.mock("@/commands/runtime-db", () => ({
  runtimeJobCreate: mocks.runtimeJobCreate,
  runtimeJobClaim: mocks.runtimeJobClaim,
  runtimeJobClaimByKind: mocks.runtimeJobClaimByKind,
  runtimeJobComplete: mocks.runtimeJobComplete,
  runtimeEventAppend: mocks.runtimeEventAppend,
  runtimeDerivedStaleMarkerRecord: mocks.runtimeDerivedStaleMarkerRecord,
}))

vi.mock("@/commands/fs", () => ({
  listDirectory: mocks.listDirectory,
}))

import {
  mintDerivedStaleMarkerAnchorEvent,
  mintManualRebuildForLayer,
  mintManualRebuildMarker,
  TAXONOMY_MANUAL_REBUILD_AFFECTED_PATH,
} from "./manual-rebuild-marker"

function claimResult(jobId: string) {
  return {
    job: { jobId, kind: "manual-rebuild-marker-event", payload: "{}", state: "running", attempt: 1, maxAttempts: 1, priority: 0, createdAtMs: 0, updatedAtMs: 0 },
    lease: { leaseId: `${jobId}-lease`, jobId, holder: "h", acquiredAtMs: 0, heartbeatAtMs: 0, expiresAtMs: 0, status: "active" },
  }
}

function markerRecord(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    markerId: "marker-1",
    layer: "embedding",
    affectedPath: "wiki/a.md",
    baseVersion: "b",
    markedAtMs: 0,
    reason: "commit",
    sourceEventId: "event-1",
    status: "pending",
    updatedAtMs: 0,
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.runtimeJobCreate.mockResolvedValue({ jobId: "anchor-1" })
  mocks.runtimeJobClaim.mockImplementation(async (req: { jobId: string }) => claimResult(req.jobId))
  mocks.runtimeJobClaimByKind.mockResolvedValue(claimResult("anchor-1"))
  mocks.runtimeJobComplete.mockResolvedValue({ jobId: "anchor-1" })
  mocks.runtimeEventAppend.mockResolvedValue({ eventId: "event-1", jobId: "anchor-1", eventName: "job-runtime:event-appended", payload: "{}", createdAtMs: 0 })
  mocks.runtimeDerivedStaleMarkerRecord.mockResolvedValue(markerRecord())
})

describe("mintDerivedStaleMarkerAnchorEvent", () => {
  it("claims by id when claimMode is by-id", async () => {
    await mintDerivedStaleMarkerAnchorEvent({
      anchorKind: "test-anchor",
      holder: "holder-1",
      claimMode: "by-id",
      eventPayload: { kind: "test" },
      layer: "embedding",
      affectedPath: "wiki/a.md",
      inputHash: "hash",
      baseVersion: "hash",
      reason: "commit",
    })

    expect(mocks.runtimeJobClaim).toHaveBeenCalledWith({ holder: "holder-1", jobId: "anchor-1" })
    expect(mocks.runtimeJobClaimByKind).not.toHaveBeenCalled()
  })

  it("claims by kind when claimMode is by-kind", async () => {
    await mintDerivedStaleMarkerAnchorEvent({
      anchorKind: "test-anchor",
      holder: "holder-1",
      claimMode: "by-kind",
      eventPayload: { kind: "test" },
      layer: "embedding",
      affectedPath: "wiki/a.md",
      inputHash: "hash",
      baseVersion: "hash",
      reason: "commit",
    })

    expect(mocks.runtimeJobClaimByKind).toHaveBeenCalledWith({ kind: "test-anchor", holder: "holder-1" })
    expect(mocks.runtimeJobClaim).not.toHaveBeenCalled()
  })

  it("resolves baseVersion as a function of the minted event id", async () => {
    await mintDerivedStaleMarkerAnchorEvent({
      anchorKind: "test-anchor",
      holder: "holder-1",
      claimMode: "by-id",
      eventPayload: { kind: "test" },
      layer: "embedding",
      affectedPath: "wiki/a.md",
      inputHash: "hash",
      baseVersion: (eventId) => `custom:${eventId}`,
      reason: "commit",
    })

    expect(mocks.runtimeDerivedStaleMarkerRecord).toHaveBeenCalledWith(
      expect.objectContaining({ baseVersion: "custom:event-1", sourceEventId: "event-1" }),
    )
  })

  it("completes the anchor job before recording the marker", async () => {
    const order: string[] = []
    mocks.runtimeJobComplete.mockImplementation(async () => {
      order.push("complete")
      return { jobId: "anchor-1" }
    })
    mocks.runtimeDerivedStaleMarkerRecord.mockImplementation(async () => {
      order.push("record")
      return markerRecord()
    })

    await mintDerivedStaleMarkerAnchorEvent({
      anchorKind: "test-anchor",
      holder: "holder-1",
      claimMode: "by-id",
      eventPayload: { kind: "test" },
      layer: "embedding",
      affectedPath: "wiki/a.md",
      inputHash: "hash",
      baseVersion: "hash",
      reason: "commit",
    })

    expect(order).toEqual(["complete", "record"])
  })
})

describe("mintManualRebuildMarker", () => {
  it("mints a manual_rebuild marker and resolves 'recorded'", async () => {
    await expect(
      mintManualRebuildMarker({ layer: "embedding", affectedPath: "wiki/a.md", holder: "embedding-manual-rebuild" }),
    ).resolves.toBe("recorded")

    expect(mocks.runtimeDerivedStaleMarkerRecord).toHaveBeenCalledWith(
      expect.objectContaining({ layer: "embedding", affectedPath: "wiki/a.md", reason: "manual_rebuild" }),
    )
  })

  it("resolves 'runtime-disabled' without logging when the work runtime is off", async () => {
    mocks.runtimeJobCreate.mockRejectedValueOnce(new Error("runtime-disabled: work runtime is disabled"))
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})

    await expect(
      mintManualRebuildMarker({ layer: "embedding", affectedPath: "wiki/a.md", holder: "h" }),
    ).resolves.toBe("runtime-disabled")
    expect(warnSpy).not.toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it("resolves 'error' and logs on any other failure", async () => {
    mocks.runtimeDerivedStaleMarkerRecord.mockRejectedValueOnce(new Error("boom"))
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})

    await expect(
      mintManualRebuildMarker({ layer: "embedding", affectedPath: "wiki/a.md", holder: "h" }),
    ).resolves.toBe("error")
    expect(warnSpy).toHaveBeenCalled()
    warnSpy.mockRestore()
  })
})

describe("mintManualRebuildForLayer", () => {
  it("taxonomy mints exactly one marker at the sentinel affectedPath, regardless of the wiki tree", async () => {
    const result = await mintManualRebuildForLayer("taxonomy", "/project", "taxonomy-manual-rebuild")

    expect(mocks.listDirectory).not.toHaveBeenCalled()
    expect(mocks.runtimeDerivedStaleMarkerRecord).toHaveBeenCalledTimes(1)
    expect(mocks.runtimeDerivedStaleMarkerRecord).toHaveBeenCalledWith(
      expect.objectContaining({ layer: "taxonomy", affectedPath: TAXONOMY_MANUAL_REBUILD_AFFECTED_PATH }),
    )
    expect(result).toEqual({ mintedCount: 1, failedCount: 0, runtimeDisabled: false })
  })

  it("embedding mints one marker per wiki page found under the project's wiki/ tree", async () => {
    mocks.listDirectory.mockResolvedValue([
      { name: "a.md", path: "/project/wiki/a.md", is_dir: false, children: null },
      { name: "index.md", path: "/project/wiki/index.md", is_dir: false, children: null },
      {
        name: "concepts",
        path: "/project/wiki/concepts",
        is_dir: true,
        children: [{ name: "b.md", path: "/project/wiki/concepts/b.md", is_dir: false, children: null }],
      },
    ])

    const result = await mintManualRebuildForLayer("embedding", "/project", "embedding-manual-rebuild")

    // index.md is a root structural page — excluded, matching embedAllPages's own scan.
    const paths = mocks.runtimeDerivedStaleMarkerRecord.mock.calls.map((call) => call[0].affectedPath)
    expect(paths.sort()).toEqual(["wiki/a.md", "wiki/concepts/b.md"])
    expect(result).toEqual({ mintedCount: 2, failedCount: 0, runtimeDisabled: false })
  })

  it("embedding with an empty wiki tree mints nothing and reports zero counts", async () => {
    mocks.listDirectory.mockResolvedValue([])

    const result = await mintManualRebuildForLayer("embedding", "/project", "embedding-manual-rebuild")

    expect(mocks.runtimeDerivedStaleMarkerRecord).not.toHaveBeenCalled()
    expect(result).toEqual({ mintedCount: 0, failedCount: 0, runtimeDisabled: false })
  })

  it("short-circuits on the first runtime-disabled result instead of looping over every remaining page", async () => {
    mocks.listDirectory.mockResolvedValue([
      { name: "a.md", path: "/project/wiki/a.md", is_dir: false, children: null },
      { name: "b.md", path: "/project/wiki/b.md", is_dir: false, children: null },
      { name: "c.md", path: "/project/wiki/c.md", is_dir: false, children: null },
    ])
    mocks.runtimeJobCreate.mockRejectedValue(new Error("runtime-disabled: work runtime is disabled"))

    const result = await mintManualRebuildForLayer("embedding", "/project", "embedding-manual-rebuild")

    expect(mocks.runtimeJobCreate).toHaveBeenCalledTimes(1)
    expect(result).toEqual({ mintedCount: 0, failedCount: 0, runtimeDisabled: true })
  })

  it("counts per-page mint failures but keeps minting the rest", async () => {
    mocks.listDirectory.mockResolvedValue([
      { name: "a.md", path: "/project/wiki/a.md", is_dir: false, children: null },
      { name: "b.md", path: "/project/wiki/b.md", is_dir: false, children: null },
    ])
    mocks.runtimeDerivedStaleMarkerRecord
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce(markerRecord())
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})

    const result = await mintManualRebuildForLayer("embedding", "/project", "embedding-manual-rebuild")

    expect(result).toEqual({ mintedCount: 1, failedCount: 1, runtimeDisabled: false })
    warnSpy.mockRestore()
  })
})
