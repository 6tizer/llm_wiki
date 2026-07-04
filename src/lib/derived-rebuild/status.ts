/**
 * SPEC-6 PR6 decision 1/2/3: pure client-side bucketing of derived-layer
 * status from a single full `runtimeDerivedStaleMarkerList({})` snapshot.
 *
 * Five-state contract (decision 1): `dirty` (a pending marker exists) /
 * `building` (a claimed marker exists) / `failed` (converged failed) /
 * `ready` (no pending/claimed marker — including a layer that has never
 * had one at all). `stale` is NOT a sixth state stored anywhere — it is a
 * display-only variant of `dirty` for layers with no automatic background
 * consumer (`synthesis`/`index_export`/`overview`; see `hasAutoConsumer`),
 * applied by the caller when rendering, never persisted as its own status.
 *
 * Priority when a layer has markers in more than one status at once
 * (decision 1's explicit adversarial case: pending AND failed together —
 * e.g. a previous batch failed and a newer commit created a fresh pending
 * marker before the consumer re-tried): `building > failed > dirty > ready`.
 *
 * `cancelled` markers count toward `dirty` too (Tester P1 fix round): a
 * cancelled marker means the change it represents was NEVER actually
 * consumed — the layer is still exactly as stale as it was before the
 * cancel, "cancelled" describes the abandoned job, not the content's
 * freshness. Grouping it with `pending` (rather than treating it as some
 * "resolved" terminal state that would wrongly read as `ready`) keeps the
 * status honest: only a real `done` marker means the layer converged.
 *
 * `graph`/`search` are excluded from `VISIBLE_DERIVED_LAYERS` (decision 2):
 * both are declared-but-no-artifact layers (no consumer, no materialized
 * output), so showing their status would be pure noise — this also
 * naturally hides the historical `graph` pending-marker backlog left over
 * from before PR3+4's follow-up closed that gap.
 */

import type { RuntimeDerivedStaleMarkerRecord, RuntimeDerivedStaleMarkerList, RuntimeDerivedStaleMarkerListRequest } from "@/commands/runtime-db"
import { DERIVED_STALE_MARKER_LAYERS, type DerivedStaleMarkerLayer } from "@/core-runtime/contract"

const HIDDEN_LAYERS = new Set<DerivedStaleMarkerLayer>(["graph", "search"])

/** Layers surfaced in the derived-status UI (decision 2). */
export const VISIBLE_DERIVED_LAYERS: readonly DerivedStaleMarkerLayer[] = DERIVED_STALE_MARKER_LAYERS.filter(
  (layer) => !HIDDEN_LAYERS.has(layer),
)

/** Layers with a background job consumer that folds/claims pending markers on its own tick. */
const AUTO_CONSUMER_LAYERS = new Set<DerivedStaleMarkerLayer>(["embedding", "taxonomy"])

/** Whether `layer` has a background consumer — used to pick the `dirty` vs `stale` display text, never to change the underlying status. */
export function hasAutoConsumer(layer: DerivedStaleMarkerLayer): boolean {
  return AUTO_CONSUMER_LAYERS.has(layer)
}

export type DerivedLayerBucketStatus = "building" | "failed" | "dirty" | "ready"

export interface DerivedLayerBucket {
  readonly layer: DerivedStaleMarkerLayer
  readonly status: DerivedLayerBucketStatus
  /** `true` when `status === "dirty"` and this layer has no automatic consumer (display as "stale", not "dirty"). */
  readonly stale: boolean
  /** Most recent `done` marker's `updatedAtMs` for this layer, or `null` if none has ever converged. */
  readonly lastRebuiltAtMs: number | null
}

export type DerivedLayerBuckets = Readonly<Partial<Record<DerivedStaleMarkerLayer, DerivedLayerBucket>>>

/**
 * Bucket a flat marker snapshot into one status per visible layer. Pure —
 * no IO, same-snapshot-instant by construction since the caller fetches
 * markers for every layer in a single list call (decision 3), so there is
 * no cross-layer time skew the way there would be with one list call per
 * layer.
 */
export function bucketDerivedLayerStatus(
  markers: readonly RuntimeDerivedStaleMarkerRecord[],
): DerivedLayerBuckets {
  const buckets: Partial<Record<DerivedStaleMarkerLayer, DerivedLayerBucket>> = {}
  for (const layer of VISIBLE_DERIVED_LAYERS) {
    const layerMarkers = markers.filter((marker) => marker.layer === layer)
    const status = classifyLayerStatus(layerMarkers)
    buckets[layer] = {
      layer,
      status,
      stale: status === "dirty" && !hasAutoConsumer(layer),
      lastRebuiltAtMs: lastDoneAtMs(layerMarkers),
    }
  }
  return buckets
}

function classifyLayerStatus(
  markers: readonly RuntimeDerivedStaleMarkerRecord[],
): DerivedLayerBucketStatus {
  if (markers.some((marker) => marker.status === "claimed")) return "building"
  if (markers.some((marker) => marker.status === "failed")) return "failed"
  if (markers.some((marker) => marker.status === "pending" || marker.status === "cancelled")) return "dirty"
  return "ready"
}

function lastDoneAtMs(markers: readonly RuntimeDerivedStaleMarkerRecord[]): number | null {
  const doneTimestamps = markers
    .filter((marker) => marker.status === "done")
    .map((marker) => marker.updatedAtMs)
  return doneTimestamps.length > 0 ? Math.max(...doneTimestamps) : null
}

export interface FetchAllDerivedStaleMarkersOptions {
  readonly list: (request: RuntimeDerivedStaleMarkerListRequest) => Promise<RuntimeDerivedStaleMarkerList>
  /** Rows requested per page (default 500). */
  readonly pageLimit?: number
  /** Safety cap on pages fetched, in case of a cursor that never terminates (default 20 — 10k rows at the default page limit). */
  readonly maxPages?: number
}

/**
 * Single logical "list every derived-stale marker" read (decision 3),
 * paging through `nextCursor` when the backend caps a single response
 * short of the full table. `maxPages` is a hard safety stop, not an
 * expected case — a healthy project converges within one or two pages.
 */
export async function fetchAllDerivedStaleMarkers(
  options: FetchAllDerivedStaleMarkersOptions,
): Promise<RuntimeDerivedStaleMarkerRecord[]> {
  const pageLimit = options.pageLimit ?? 500
  const maxPages = options.maxPages ?? 20
  const all: RuntimeDerivedStaleMarkerRecord[] = []
  let sinceMarkedAtMs: number | undefined
  let sinceMarkerId: string | undefined

  for (let page = 0; page < maxPages; page += 1) {
    const response = await options.list({
      limit: pageLimit,
      sinceMarkedAtMs,
      sinceMarkerId,
    })
    all.push(...response.markers)
    if (!response.nextCursor) break
    sinceMarkedAtMs = response.nextCursor.markedAtMs
    sinceMarkerId = response.nextCursor.markerId
  }

  return all
}
