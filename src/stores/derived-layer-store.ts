import { create } from "zustand"
import { runtimeDerivedStaleMarkerList } from "@/commands/runtime-db"
import {
  bucketDerivedLayerStatus,
  fetchAllDerivedStaleMarkers,
  type DerivedLayerBucket,
  type DerivedLayerBuckets,
} from "@/lib/derived-rebuild/status"
import type { DerivedStaleMarkerLayer } from "@/core-runtime/contract"

/**
 * SPEC-6 PR6 decision 3/6: holds the per-layer status snapshot the
 * `derived-status-section.tsx` UI renders, refreshed by a single
 * `fetchAllDerivedStaleMarkers` read (never one list call per layer, so
 * every layer's bucket reflects the SAME snapshot instant).
 *
 * `setLayerBucket` is intentionally the only mutator besides `loadSnapshot`
 * — the Rebuild button's optimistic "building" write goes through
 * `@/lib/store-helpers`'s `persistSetting` (same pattern
 * `settings-view.tsx` uses), calling `setLayerBucket` as its `set` and
 * reading `useDerivedLayerStore.getState().buckets?.[layer]` as its
 * `current`, rather than this store growing its own bespoke
 * optimistic-write/rollback method.
 */
export interface DerivedLayerStoreState {
  buckets: DerivedLayerBuckets | null
  capturedAtMs: number | null
  error: string | null
  loadSnapshot: () => Promise<void>
  setLayerBucket: (layer: DerivedStaleMarkerLayer, bucket: DerivedLayerBucket) => void
}

export const useDerivedLayerStore = create<DerivedLayerStoreState>((set) => ({
  buckets: null,
  capturedAtMs: null,
  error: null,

  loadSnapshot: async () => {
    try {
      const markers = await fetchAllDerivedStaleMarkers({ list: runtimeDerivedStaleMarkerList })
      set({ buckets: bucketDerivedLayerStatus(markers), capturedAtMs: Date.now(), error: null })
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) })
    }
  },

  setLayerBucket: (layer, bucket) =>
    set((state) => ({
      buckets: { ...state.buckets, [layer]: bucket },
    })),
}))
