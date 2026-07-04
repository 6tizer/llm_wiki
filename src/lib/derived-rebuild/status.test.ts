import { describe, expect, it } from "vitest"
import {
  bucketDerivedLayerStatus,
  fetchAllDerivedStaleMarkers,
  hasAutoConsumer,
  VISIBLE_DERIVED_LAYERS,
} from "./status"
import type { RuntimeDerivedStaleMarkerRecord } from "@/commands/runtime-db"

function marker(
  overrides: Partial<RuntimeDerivedStaleMarkerRecord> & { layer: string },
): RuntimeDerivedStaleMarkerRecord {
  return {
    markerId: overrides.markerId ?? `marker-${Math.random()}`,
    affectedPath: overrides.affectedPath ?? "wiki/foo.md",
    baseVersion: overrides.baseVersion ?? "base",
    markedAtMs: overrides.markedAtMs ?? 0,
    reason: overrides.reason ?? "commit",
    sourceEventId: overrides.sourceEventId ?? "event-1",
    status: overrides.status ?? "pending",
    updatedAtMs: overrides.updatedAtMs ?? 0,
    ...overrides,
  }
}

describe("VISIBLE_DERIVED_LAYERS", () => {
  it("hides graph and search (decision 2)", () => {
    expect(VISIBLE_DERIVED_LAYERS).not.toContain("graph")
    expect(VISIBLE_DERIVED_LAYERS).not.toContain("search")
    expect(VISIBLE_DERIVED_LAYERS).toEqual([
      "embedding",
      "taxonomy",
      "synthesis",
      "index_export",
      "overview",
    ])
  })
})

describe("hasAutoConsumer", () => {
  it("is true only for embedding/taxonomy", () => {
    expect(hasAutoConsumer("embedding")).toBe(true)
    expect(hasAutoConsumer("taxonomy")).toBe(true)
    expect(hasAutoConsumer("synthesis")).toBe(false)
    expect(hasAutoConsumer("index_export")).toBe(false)
    expect(hasAutoConsumer("overview")).toBe(false)
  })
})

describe("bucketDerivedLayerStatus", () => {
  it("returns ready with no lastRebuiltAtMs for a layer that never had a marker", () => {
    const buckets = bucketDerivedLayerStatus([])
    expect(buckets.embedding).toEqual({
      layer: "embedding",
      status: "ready",
      stale: false,
      lastRebuiltAtMs: null,
    })
  })

  it("classifies a pending-only layer as dirty", () => {
    const buckets = bucketDerivedLayerStatus([marker({ layer: "embedding", status: "pending" })])
    expect(buckets.embedding?.status).toBe("dirty")
  })

  it("classifies a claimed-only layer as building", () => {
    const buckets = bucketDerivedLayerStatus([marker({ layer: "embedding", status: "claimed" })])
    expect(buckets.embedding?.status).toBe("building")
  })

  it("classifies a failed-only layer as failed", () => {
    const buckets = bucketDerivedLayerStatus([marker({ layer: "embedding", status: "failed" })])
    expect(buckets.embedding?.status).toBe("failed")
  })

  it("classifies a layer with only done markers as ready and reports the latest done timestamp", () => {
    const buckets = bucketDerivedLayerStatus([
      marker({ layer: "embedding", status: "done", updatedAtMs: 100 }),
      marker({ layer: "embedding", status: "done", updatedAtMs: 300 }),
      marker({ layer: "embedding", status: "done", updatedAtMs: 200 }),
    ])
    expect(buckets.embedding).toEqual({
      layer: "embedding",
      status: "ready",
      stale: false,
      lastRebuiltAtMs: 300,
    })
  })

  it("priority: building beats failed and dirty when a layer has all three at once", () => {
    const buckets = bucketDerivedLayerStatus([
      marker({ layer: "embedding", status: "pending" }),
      marker({ layer: "embedding", status: "failed" }),
      marker({ layer: "embedding", status: "claimed" }),
    ])
    expect(buckets.embedding?.status).toBe("building")
  })

  it("priority: failed beats dirty when a layer has both pending and failed markers (decision 1's explicit adversarial case)", () => {
    const buckets = bucketDerivedLayerStatus([
      marker({ layer: "embedding", status: "pending" }),
      marker({ layer: "embedding", status: "failed" }),
    ])
    expect(buckets.embedding?.status).toBe("failed")
  })

  it("classifies a cancelled-only layer as dirty, not ready (Tester P1: cancelled means never consumed, not converged)", () => {
    const buckets = bucketDerivedLayerStatus([marker({ layer: "embedding", status: "cancelled" })])
    expect(buckets.embedding?.status).toBe("dirty")
  })

  it("priority: building beats a cancelled marker", () => {
    const buckets = bucketDerivedLayerStatus([
      marker({ layer: "embedding", status: "cancelled" }),
      marker({ layer: "embedding", status: "claimed" }),
    ])
    expect(buckets.embedding?.status).toBe("building")
  })

  it("priority: failed beats a cancelled marker", () => {
    const buckets = bucketDerivedLayerStatus([
      marker({ layer: "embedding", status: "cancelled" }),
      marker({ layer: "embedding", status: "failed" }),
    ])
    expect(buckets.embedding?.status).toBe("failed")
  })

  it("cancelled and pending together still classify as dirty (both group into the same bucket)", () => {
    const buckets = bucketDerivedLayerStatus([
      marker({ layer: "embedding", status: "cancelled" }),
      marker({ layer: "embedding", status: "pending" }),
    ])
    expect(buckets.embedding?.status).toBe("dirty")
  })

  it("marks a dirty layer with no automatic consumer as stale (synthesis/index_export/overview)", () => {
    const buckets = bucketDerivedLayerStatus([
      marker({ layer: "synthesis", status: "pending" }),
      marker({ layer: "index_export", status: "pending" }),
      marker({ layer: "overview", status: "pending" }),
    ])
    expect(buckets.synthesis?.stale).toBe(true)
    expect(buckets.index_export?.stale).toBe(true)
    expect(buckets.overview?.stale).toBe(true)
  })

  it("does not mark a dirty layer WITH an automatic consumer as stale", () => {
    const buckets = bucketDerivedLayerStatus([marker({ layer: "embedding", status: "pending" })])
    expect(buckets.embedding?.stale).toBe(false)
  })

  it("does not mark a building/failed/ready layer as stale even with no consumer", () => {
    const buckets = bucketDerivedLayerStatus([marker({ layer: "synthesis", status: "claimed" })])
    expect(buckets.synthesis?.stale).toBe(false)
  })

  it("keeps layers independent — markers for one layer never affect another's bucket", () => {
    const buckets = bucketDerivedLayerStatus([
      marker({ layer: "embedding", status: "failed" }),
      marker({ layer: "taxonomy", status: "pending" }),
    ])
    expect(buckets.embedding?.status).toBe("failed")
    expect(buckets.taxonomy?.status).toBe("dirty")
    expect(buckets.synthesis?.status).toBe("ready")
  })

  it("ignores markers for hidden layers (graph/search) entirely", () => {
    const buckets = bucketDerivedLayerStatus([
      marker({ layer: "graph", status: "failed" }),
      marker({ layer: "search", status: "failed" }),
    ])
    expect(buckets.graph).toBeUndefined()
    expect(buckets.search).toBeUndefined()
  })
})

describe("fetchAllDerivedStaleMarkers", () => {
  function list(markers: RuntimeDerivedStaleMarkerRecord[], nextCursor: { markedAtMs: number; markerId: string } | null = null) {
    return { enabled: true, status: "healthy" as const, markers, nextCursor }
  }

  it("returns everything from a single page when there is no cursor", async () => {
    let calls = 0
    const listFn = async () => {
      calls += 1
      return list([marker({ layer: "embedding" })])
    }
    const all = await fetchAllDerivedStaleMarkers({ list: listFn })
    expect(all).toHaveLength(1)
    expect(calls).toBe(1)
  })

  it("follows the cursor across multiple pages until nextCursor is null", async () => {
    const page1 = marker({ layer: "embedding", markerId: "m1" })
    const page2 = marker({ layer: "embedding", markerId: "m2" })
    let call = 0
    const listFn = async (request: { sinceMarkedAtMs?: number | null; sinceMarkerId?: string | null }) => {
      call += 1
      if (call === 1) {
        expect(request.sinceMarkedAtMs).toBeUndefined()
        return list([page1], { markedAtMs: 1, markerId: "m1" })
      }
      expect(request.sinceMarkedAtMs).toBe(1)
      expect(request.sinceMarkerId).toBe("m1")
      return list([page2])
    }
    const all = await fetchAllDerivedStaleMarkers({ list: listFn })
    expect(all.map((m) => m.markerId)).toEqual(["m1", "m2"])
    expect(call).toBe(2)
  })

  it("stops at maxPages even if the cursor never terminates (safety cap)", async () => {
    let call = 0
    const listFn = async () => {
      call += 1
      return list([marker({ layer: "embedding", markerId: `m${call}` })], { markedAtMs: call, markerId: `m${call}` })
    }
    const all = await fetchAllDerivedStaleMarkers({ list: listFn, maxPages: 3 })
    expect(call).toBe(3)
    expect(all).toHaveLength(3)
  })
})
