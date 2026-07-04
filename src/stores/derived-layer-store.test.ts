import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  runtimeDerivedStaleMarkerList: vi.fn(),
}))

vi.mock("@/commands/runtime-db", () => ({
  runtimeDerivedStaleMarkerList: mocks.runtimeDerivedStaleMarkerList,
}))

import { useDerivedLayerStore } from "./derived-layer-store"

describe("derived layer store", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useDerivedLayerStore.setState({ buckets: null, capturedAtMs: null, error: null, runtimeDisabled: false })
  })

  it("loadSnapshot fetches all markers in one call and buckets them per layer", async () => {
    mocks.runtimeDerivedStaleMarkerList.mockResolvedValue({
      enabled: true,
      status: "healthy",
      markers: [
        {
          markerId: "m1",
          layer: "embedding",
          affectedPath: "wiki/a.md",
          baseVersion: "b",
          markedAtMs: 0,
          reason: "commit",
          sourceEventId: "e1",
          status: "pending",
          updatedAtMs: 0,
        },
      ],
      nextCursor: null,
    })

    await useDerivedLayerStore.getState().loadSnapshot()

    expect(mocks.runtimeDerivedStaleMarkerList).toHaveBeenCalledTimes(1)
    const state = useDerivedLayerStore.getState()
    expect(state.buckets?.embedding?.status).toBe("dirty")
    expect(state.error).toBeNull()
    expect(state.capturedAtMs).not.toBeNull()
  })

  it("loadSnapshot records the error message on failure without touching buckets", async () => {
    mocks.runtimeDerivedStaleMarkerList.mockRejectedValue(new Error("db is damaged"))

    await useDerivedLayerStore.getState().loadSnapshot()

    const state = useDerivedLayerStore.getState()
    expect(state.error).toBe("db is damaged")
    expect(state.buckets).toBeNull()
    expect(state.runtimeDisabled).toBe(false)
  })

  it("loadSnapshot sets runtimeDisabled (not error) when the work runtime feature flag is off — reading it off the SUCCESSFUL response's enabled:false, not a rejection (closeout hotfix P1 gate-fix: runtime_derived_stale_marker_list_for_project resolves Ok({enabled:false}), it never rejects for this case)", async () => {
    mocks.runtimeDerivedStaleMarkerList.mockResolvedValue({
      enabled: false,
      status: "disabled",
      markers: [],
      nextCursor: null,
    })

    await useDerivedLayerStore.getState().loadSnapshot()

    const state = useDerivedLayerStore.getState()
    expect(state.runtimeDisabled).toBe(true)
    expect(state.error).toBeNull()
    expect(state.buckets).toBeNull()
  })

  it("loadSnapshot clears a stale runtimeDisabled flag once the runtime becomes enabled and a snapshot succeeds", async () => {
    useDerivedLayerStore.setState({ runtimeDisabled: true })
    mocks.runtimeDerivedStaleMarkerList.mockResolvedValue({
      enabled: true,
      status: "healthy",
      markers: [],
      nextCursor: null,
    })

    await useDerivedLayerStore.getState().loadSnapshot()

    expect(useDerivedLayerStore.getState().runtimeDisabled).toBe(false)
  })

  it("setLayerBucket replaces only the targeted layer's bucket", () => {
    useDerivedLayerStore.setState({
      buckets: {
        embedding: { layer: "embedding", status: "ready", stale: false, lastRebuiltAtMs: null },
        taxonomy: { layer: "taxonomy", status: "ready", stale: false, lastRebuiltAtMs: null },
      },
    })

    useDerivedLayerStore.getState().setLayerBucket("embedding", {
      layer: "embedding",
      status: "building",
      stale: false,
      lastRebuiltAtMs: null,
    })

    const state = useDerivedLayerStore.getState()
    expect(state.buckets?.embedding?.status).toBe("building")
    expect(state.buckets?.taxonomy?.status).toBe("ready")
  })
})
