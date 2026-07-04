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
 *
 * `runtimeDisabled` (closeout hotfix P1 #5, corrected P1 gate-fix): an
 * explicit Work Runtime kill-switch is an expected steady state, not an
 * error.
 * `runtimeDerivedStaleMarkerList`/`fetchAllDerivedStaleMarkers` never
 * REJECTS for this case — `runtime_derived_stale_marker_list_for_project`
 * (`runtime_db/markers.rs`) resolves `Ok({ enabled: false, ... })`, same as
 * every other `_list` command in this codebase. Detection therefore has to
 * read `enabled` off the successful response (mirroring how
 * `runtime-jobs-section.tsx`'s `summarizeRuntimeJobs` already reads
 * `list.enabled`/`list.status` off `RuntimeJobList`), NOT a caught
 * rejection — an earlier version of this fix wrongly assumed a thrown
 * `runtime-disabled:`-prefixed error (copying `ingest-write.ts`'s
 * `recordEmbeddingStaleMarker`, a different command shape that legitimately
 * throws), which meant the check could never fire in production and the
 * disabled-state UI card was dead code covered only by a fake-shaped test
 * mock. `catch` below now only ever handles a REAL rejected promise (IPC
 * failure, DB corruption, etc.).
 */
export interface DerivedLayerStoreState {
  buckets: DerivedLayerBuckets | null
  capturedAtMs: number | null
  error: string | null
  runtimeDisabled: boolean
  loadSnapshot: () => Promise<void>
  setLayerBucket: (layer: DerivedStaleMarkerLayer, bucket: DerivedLayerBucket) => void
}

export const useDerivedLayerStore = create<DerivedLayerStoreState>((set) => ({
  buckets: null,
  capturedAtMs: null,
  error: null,
  runtimeDisabled: false,

  loadSnapshot: async () => {
    try {
      const { markers, enabled } = await fetchAllDerivedStaleMarkers({ list: runtimeDerivedStaleMarkerList })
      if (!enabled) {
        set({ error: null, runtimeDisabled: true })
        return
      }
      set({ buckets: bucketDerivedLayerStatus(markers), capturedAtMs: Date.now(), error: null, runtimeDisabled: false })
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err), runtimeDisabled: false })
    }
  },

  setLayerBucket: (layer, bucket) =>
    set((state) => ({
      buckets: { ...state.buckets, [layer]: bucket },
    })),
}))
