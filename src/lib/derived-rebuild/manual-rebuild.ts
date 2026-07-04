/**
 * SPEC-6 PR5: shared self-produced/self-consumed manual-rebuild marker loop
 * for the two derived layers with NO recorder and NO background consumer —
 * `"index_export"` and `"overview"`. Unlike `embedding`/`taxonomy` (whose
 * markers are recorded on commit and picked up by a poller) and unlike
 * `synthesis` (whose markers ARE recorded on commit and only *closed* by a
 * manual action — see `synthesis-staleness.ts`), SPEC-6 PR3+4 decision 5
 * deliberately keeps `index_export`/`overview` OUT of
 * `COMMIT_DERIVED_STALE_MARKER_LAYERS`: nothing ever records a pending
 * marker for either layer except this helper, at the exact moment a manual
 * rebuild button is clicked. So the "mark stale" and "consume" halves both
 * live here, mint-to-close in one call:
 *
 *   1. Mint a throwaway anchor job (dedicated kind, NOT `derived-rebuild` —
 *      see {@link MANUAL_REBUILD_ANCHOR_JOB_KIND}) purely to give
 *      `runtimeEventAppend` a valid `job_id` FK, the same anchor-job trick
 *      `ingest-write.ts`'s `recordEmbeddingStaleMarker` uses. The anchor is
 *      claimed, used, completed, and discarded — it never carries rebuild
 *      work.
 *   2. Record a `"manual_rebuild"`-reason pending marker for
 *      `(layer, affectedPath)`, backed by that event.
 *   3. Fold it into a queued `derived-rebuild` job via
 *      `runtimeDerivedMarkerClaimBatch` — deliberately with NO caller-chosen
 *      `jobId`. `runtime_derived_marker_claim_batch_for_project` always does
 *      a bare `INSERT INTO runtime_jobs`, so passing an existing id
 *      (including the anchor job's own id) is a primary-key collision, not
 *      a reuse — this is the exact P0-1 lesson documented in
 *      `synthesis-staleness.ts`'s file doc comment, just encountered one
 *      call earlier in the chain here.
 *   4. Claim that exact folded job by id (PR3+4's targeted
 *      `runtimeJobClaim({ jobId })` primitive — a single IPC call, not a
 *      claim-by-kind hunt loop).
 *   5. Run the caller's `execute()` (the actual scan+write or LLM
 *      generation) while the job's lease is held.
 *   6. Success -> `runtimeDerivedMarkerCompleteBatch`. Failure ->
 *      `runtimeJobFail` (carrying the original error message) then, if the
 *      job reached the terminal `failed` state, `runtimeDerivedMarkerRelease
 *      Batch` to converge the markers too — mirrors
 *      `embedding-consumer.ts`'s `safeFailClaim`.
 *
 * Runtime-disabled / bookkeeping-failure handling (plan decision 1's
 * "生成照常执行" requirement): steps 1-4 are entirely best-effort. ANY
 * failure minting the job/event/marker/claim chain — not just the
 * `runtime-disabled:` case — falls back to running `execute()` untracked
 * (`runtimeTracked: false` in the result), mirroring
 * `recordEmbeddingStaleMarker`'s two non-throwing branches: the manual
 * rebuild button is a user-requested action whose entire point is
 * `execute()`, and a marker-bookkeeping hiccup must never block it. Only
 * the `runtime-disabled:` case is silent (expected: the work-runtime flag
 * defaults off); any other bookkeeping error is logged so it doesn't vanish
 * unnoticed. Once bookkeeping IS established, `execute()` itself throwing
 * both fails the job and rethrows to the caller.
 *
 * Lease heartbeat (Codex gate P1): `execute()` can run long — `overview`'s
 * single LLM call in particular can easily exceed the job runtime's
 * `leaseTtlMs` (120s, `JOB_RUNTIME_DEFAULTS`). Without a heartbeat, a slow
 * generation's lease can expire mid-flight; the generation itself still
 * succeeds and writes the file, but the FOLLOWING
 * `runtimeDerivedMarkerCompleteBatch` call would then be rejected (it
 * requires the exact still-active lease — `ensure_active_running_lease` in
 * `markers.rs`), silently leaving the job/markers stuck while the UI
 * reports success. So the folded job's lease is heartbeated for the entire
 * `execute()` + complete/fail window, mirroring
 * `embedding-consumer.ts`/`prepare-worker-pool.ts`'s `startHeartbeat`/
 * `startJobHeartbeat`.
 *
 * `maxAttempts: 1` on the folded job (Codex gate P2): `index_export`/
 * `overview` have no background poller to ever recover a `retry-wait` job
 * (unlike `embedding`/`taxonomy`, whose consumers explicitly poll for
 * elapsed-backoff `retry-wait` jobs of their own layer — see
 * `derived-rebuild/index.ts`'s consumer-contract doc comment). A failed
 * single-attempt job goes straight to the terminal `failed` state instead
 * of sitting in `retry-wait` forever, so `safeFailClaim` can release its
 * markers to `failed` immediately — the NEXT manual click then mints a
 * brand-new marker/job pair from a clean slate rather than ever needing to
 * resurrect an orphaned retry.
 *
 * Residual gaps (documented, not eliminated — PR6 diagnostics candidates,
 * same class of risk `synthesis-staleness.ts`'s doc comment calls out for
 * its own crash window):
 * - If the process crashes between minting the anchor job and completing
 *   it (`mintManualRebuildClaim`'s steps 1-2), the anchor is left
 *   `running` under a lease nothing will ever explicitly complete. It is
 *   never retried (no poller watches `manual-rebuild-marker-event` jobs)
 *   and carries no rebuild work, so the only recovery is the existing
 *   lease-timeout scheduler eventually reclaiming its expired lease — it
 *   just stays a harmless `running` row until then.
 * - If the process crashes between `runtimeDerivedMarkerClaimBatch`
 *   succeeding and the following `runtimeJobClaim`/`execute()`/
 *   complete-or-fail sequence finishing, the folded job is left `queued`
 *   (nobody re-claims it: `index_export`/`overview` have no consumer
 *   poller of their own) or `running` until its lease expires and the
 *   lease-timeout scheduler moves it to `retry-wait` — where, per the
 *   `maxAttempts: 1` note above, it then has no attempts left and is
 *   already effectively dead, just not yet marked `failed`. The next
 *   manual click for the SAME `(layer, affectedPath)` cannot self-heal
 *   this: `claimBatch` only ever folds `pending` markers, and these are
 *   stuck `claimed` under the orphaned job. Recovery today requires either
 *   the lease-timeout scheduler's eventual reclaim or a future PR6
 *   diagnostics action.
 */

import {
  runtimeDerivedMarkerClaimBatch,
  runtimeDerivedMarkerCompleteBatch,
  runtimeDerivedMarkerReleaseBatch,
  runtimeJobClaim,
  runtimeJobFail,
  runtimeJobHeartbeat,
  type RuntimeJobClaim,
  type RuntimeJobRecord,
} from "@/commands/runtime-db"
import { JOB_RUNTIME_DEFAULTS, type DerivedStaleMarkerLayer } from "@/core-runtime/contract"
import {
  mintDerivedStaleMarkerAnchorEvent,
  MANUAL_REBUILD_ANCHOR_JOB_KIND,
  MANUAL_REBUILD_INPUT_HASH,
} from "./manual-rebuild-marker"

const RUNTIME_DISABLED_ERROR_PREFIX = "runtime-disabled:"

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function isRuntimeDisabledError(err: unknown): boolean {
  return errorMessage(err).startsWith(RUNTIME_DISABLED_ERROR_PREFIX)
}

export interface RunManualRebuildOptions<T> {
  layer: DerivedStaleMarkerLayer
  affectedPath: string
  /** Job/lease holder identity, e.g. `"index-export-manual-rebuild"`. */
  holder: string
  execute: () => Promise<T>
}

export interface ManualRebuildResult<T> {
  result: T
  /**
   * Whether the derived-marker bookkeeping loop actually ran end to end.
   * `false` means the work runtime is disabled or bookkeeping hit an error
   * — `execute()` still ran either way.
   */
  runtimeTracked: boolean
}

interface MintedClaim {
  job: RuntimeJobRecord
  lease: RuntimeJobClaim["lease"]
  markerIds: string[]
}

async function mintManualRebuildClaim(
  layer: DerivedStaleMarkerLayer,
  affectedPath: string,
  holder: string,
): Promise<MintedClaim> {
  // SPEC-6 PR6: the anchor create -> claim -> event-append -> complete ->
  // record sequence lives in manual-rebuild-marker.ts's
  // `mintDerivedStaleMarkerAnchorEvent`, shared with `ingest-write.ts`'s
  // `recordEmbeddingStaleMarker` and this PR's new embedding/taxonomy
  // Rebuild buttons — see that file's doc comment.
  await mintDerivedStaleMarkerAnchorEvent({
    anchorKind: MANUAL_REBUILD_ANCHOR_JOB_KIND,
    holder,
    claimMode: "by-id",
    eventPayload: { kind: "manual_rebuild", layer, affectedPath },
    layer,
    affectedPath,
    inputHash: MANUAL_REBUILD_INPUT_HASH,
    // Opaque token (SPEC-6 PR1 investigation: base_version is caller-free
    // form) — just needs to differ from sourceEventId, which the Rust side
    // rejects a duplicate of.
    baseVersion: (eventId) => `manual-rebuild:${Date.now()}:${eventId}`,
    reason: "manual_rebuild",
  })

  // maxAttempts: 1 (Codex gate P2) — see the file doc comment: neither
  // layer has a poller to ever recover a retry-wait job, so a single
  // failed attempt should go straight to terminal `failed` instead of
  // sitting unrecoverable in `retry-wait` forever.
  //
  // Sabotage self-verification performed during the Codex-gate fix round
  // (manual-rebuild.test.ts's "mints anchor job -> ... -> completes the
  // batch"): temporarily dropped `maxAttempts: 1` from this call — the
  // test's exact-match `toHaveBeenCalledWith` assertion on the claim_batch
  // request went red (extra/missing `maxAttempts` field). Restoring it
  // turned the test back green.
  const folded = await runtimeDerivedMarkerClaimBatch({ layer, affectedPath, maxAttempts: 1 })
  const claim = await runtimeJobClaim({ holder, jobId: folded.job.jobId })
  return {
    job: claim.job,
    lease: claim.lease,
    markerIds: folded.markers.map((marker) => marker.markerId),
  }
}

/**
 * Fail the job; if it reached the terminal `failed` state, release its
 * claimed markers too (PR1 decision 4/5 convergence — mirrors
 * `embedding-consumer.ts`'s `safeFailClaim`).
 *
 * Sabotage self-verification performed during implementation
 * (manual-rebuild.test.ts's "execute() throwing, and the job reaching
 * terminal 'failed', releases the claimed markers to 'failed' too"):
 * temporarily short-circuited this `if` to `false`, so a terminally-failed
 * job's markers were left `claimed` forever with no owning job left to
 * retry them — the test went red (`runtimeDerivedMarkerReleaseBatch` never
 * called). Restoring the real condition turned it back green.
 */
async function safeFailClaim(claim: MintedClaim, affectedPath: string, error: string): Promise<void> {
  let failedJob: RuntimeJobRecord
  try {
    failedJob = await runtimeJobFail({ jobId: claim.job.jobId, leaseId: claim.lease.leaseId, error })
  } catch (err) {
    console.warn(`[manual-rebuild] failed to fail job ${claim.job.jobId} for ${affectedPath}:`, err)
    return
  }
  if (failedJob.state === "failed" && claim.markerIds.length > 0) {
    try {
      await runtimeDerivedMarkerReleaseBatch({
        jobId: claim.job.jobId,
        markerIds: claim.markerIds,
        targetStatus: "failed",
        error,
      })
    } catch (err) {
      console.warn(`[manual-rebuild] failed to release terminal markers for job ${claim.job.jobId}:`, err)
    }
  }
}

/**
 * Heartbeats the folded job's lease while `execute()` (and the following
 * complete/fail bookkeeping) runs, so a slow generation — `overview`'s LLM
 * call in particular — doesn't outlive the lease TTL and get reclaimed out
 * from under this call mid-flight (Codex gate P1). Mirrors
 * `embedding-consumer.ts`'s `startHeartbeat` /
 * `prepare-worker-pool.ts`'s `startJobHeartbeat`. Stops the instant the
 * caller settles, before any complete/fail bookkeeping runs there — but is
 * itself stopped only once this whole call's `finally` runs, so it keeps
 * beating through that bookkeeping too.
 */
function startHeartbeat(claim: MintedClaim): () => void {
  let stopped = false
  let pending: Promise<void> | null = null

  const beat = () => {
    if (stopped || pending) return
    pending = runtimeJobHeartbeat({ jobId: claim.job.jobId, leaseId: claim.lease.leaseId })
      .then(() => undefined)
      .catch((err) => {
        if (!stopped) {
          console.warn(`[manual-rebuild] heartbeat failed for job ${claim.job.jobId}:`, err)
        }
      })
      .finally(() => {
        pending = null
      })
  }

  const timer = setInterval(beat, JOB_RUNTIME_DEFAULTS.heartbeatMinIntervalMs)
  const unrefable = timer as unknown as { unref?: () => void }
  unrefable.unref?.()

  return () => {
    stopped = true
    clearInterval(timer)
  }
}

/**
 * Run a manual rebuild for a marker-bookkept, no-background-consumer layer.
 * See the file doc comment for the full mint-to-close loop, the
 * runtime-disabled fallback contract, and the lease-heartbeat rationale.
 */
export async function runManualRebuild<T>(
  options: RunManualRebuildOptions<T>,
): Promise<ManualRebuildResult<T>> {
  const { layer, affectedPath, holder, execute } = options

  let claim: MintedClaim | null = null
  try {
    claim = await mintManualRebuildClaim(layer, affectedPath, holder)
  } catch (err) {
    if (!isRuntimeDisabledError(err)) {
      console.warn(
        `[manual-rebuild] marker bookkeeping unavailable for ${layer}/${affectedPath} (generation proceeds untracked):`,
        errorMessage(err),
      )
    }
  }

  if (!claim) {
    const result = await execute()
    return { result, runtimeTracked: false }
  }

  // Sabotage self-verification performed during the Codex-gate fix round
  // (manual-rebuild.test.ts's "Codex gate P1: heartbeats the folded job's
  // lease..."): temporarily replaced this call with a no-op
  // `() => {}` (i.e. no interval ever armed) — the test went red
  // (`runtimeJobHeartbeat` never called across three simulated intervals
  // of a still-pending `execute()`). Restoring the real `startHeartbeat`
  // call turned it back green.
  const stopHeartbeat = startHeartbeat(claim)
  try {
    try {
      const result = await execute()
      try {
        await runtimeDerivedMarkerCompleteBatch({
          jobId: claim.job.jobId,
          leaseId: claim.lease.leaseId,
          markerIds: claim.markerIds,
        })
      } catch (err) {
        console.warn(`[manual-rebuild] failed to complete job ${claim.job.jobId} for ${affectedPath}:`, err)
      }
      return { result, runtimeTracked: true }
    } catch (err) {
      await safeFailClaim(claim, affectedPath, errorMessage(err))
      throw err
    }
  } finally {
    stopHeartbeat()
  }
}
