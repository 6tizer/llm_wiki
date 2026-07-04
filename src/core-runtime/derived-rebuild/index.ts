import type { DerivedStaleMarkerLayer, DerivedStaleMarkerReason } from "@/core-runtime/contract"

/**
 * Job `kind` shared by every derived-rebuild consumer (SPEC-6 PR1+). One
 * `derived-rebuild` runtime job = one folded `(layer, affectedPath)` batch of
 * `runtime_derived_stale_markers` rows, created atomically by
 * `runtimeDerivedMarkerClaimBatch`. Actually claiming/leasing the job for
 * execution is a separate call to the existing `runtimeJobClaimByKind`.
 *
 * Keep aligned with `DERIVED_REBUILD_JOB_KIND` in
 * src-tauri/src/commands/runtime_db.rs.
 */
export const DERIVED_REBUILD_JOB_KIND = "derived-rebuild" as const

/**
 * Shape of a `derived-rebuild` job's `payload` JSON, written atomically by
 * `runtimeDerivedMarkerClaimBatch` (SPEC-6 PR1 decision 2/4). `baseVersion` /
 * `inputHash` / `reason` are copied verbatim from the most-recently-marked
 * real `runtime_derived_stale_markers` row in the folded group — never
 * synthesized from the whole group.
 *
 * `reason: "delete"` (with `inputHash: null`) means the consumer should skip
 * rebuilding and only clean up the derived artifact for `affectedPath`
 * (SPEC-6 PR1 decision 4, adversarial matrix D2) — interpreting that is a
 * PR2+ consumer concern; PR1 only guarantees the payload carries it through
 * verbatim.
 *
 * ## Consumer contract: poll BOTH queue signals (P0, decision 5)
 *
 * A `derived-rebuild` job's `markerIds` stay `claimed` for its ENTIRE
 * lifetime, including every `retry-wait` bounce after a crashed/timed-out
 * lease — they only ever leave `claimed` via this same job's own terminal
 * `completed`/`failed` transition (or an explicit release after
 * `cancelled`). A `runtime_derived_marker_claim_batch` call therefore never
 * sees those markers again as `pending` while the job is still retryable.
 *
 * A PR2+ consumer MUST therefore watch two independent signals, not one:
 * 1. **New pending markers** — `runtimeDerivedStaleMarkerList({ status:
 *    "pending" })`, folded into a fresh job via
 *    `runtimeDerivedMarkerClaimBatch`.
 * 2. **`retry-wait` `derived-rebuild` jobs** — recovered via
 *    `runtimeJobRetry` (which re-queues the SAME `job_id`, preserving its
 *    `attempt` count) and then re-claimed via `runtimeJobClaimByKind`.
 *
 * A consumer that only polls (1) will never observe a crashed rebuild's
 * retries at all — the job (and its claimed markers) simply sits in
 * `retry-wait` forever, invisible to a marker-only poll, until an operator
 * notices nothing is converging.
 */
export interface DerivedRebuildJobPayload {
  layer: DerivedStaleMarkerLayer
  affectedPath: string
  markerIds: string[]
  baseVersion: string
  inputHash: string | null
  reason: DerivedStaleMarkerReason
}

/** Parse a `derived-rebuild` job's `payload` JSON into its typed shape. */
export function parseDerivedRebuildJobPayload(payload: string): DerivedRebuildJobPayload {
  return JSON.parse(payload) as DerivedRebuildJobPayload
}
