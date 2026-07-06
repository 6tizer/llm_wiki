/**
 * SPEC-6 PR3+4: the `"taxonomy"` layer's `derived-rebuild` job consumer.
 *
 * A module-level polling loop — same start/stop + generation-counter shape
 * as `embedding-consumer.ts` (SPEC-6 PR2), which this file deliberately
 * copies wholesale (tick cadence, dual-signal polling, per-generation
 * reentrancy guard, heartbeat-while-working, safeComplete/safeFail marker
 * bookkeeping) rather than reinventing it. The one real difference is the
 * execution unit: embedding processes ONE page per claimed job, but taxonomy
 * growth (`applyTagTaxonomyGrowth`) is a single deterministic full-wiki-tree
 * rescan that doesn't care which specific paths changed — running it once
 * per claimed job would be wasted, duplicated work, and would race itself
 * via `saveTagTaxonomy`'s own `expectedUpdatedAt` optimistic concurrency
 * (the second call's stale in-memory `updatedAt` would spuriously conflict
 * against the first call's own write). So one tick folds EVERY pending
 * `"taxonomy"` marker group (across however many distinct `affectedPath`s
 * changed) into however many `derived-rebuild` jobs `foldPendingMarkers`
 * creates, claims all of them, and then runs exactly ONE
 * `applyTagTaxonomyGrowth` call — completing (or failing) every claimed
 * group together, atomically with respect to *this* consumer's bookkeeping
 * (SPEC-6 PR3+4 decision 3).
 *
 * `applyTagTaxonomyGrowth` never bootstraps (that stays a manual, explicit
 * user action from Settings — this consumer must never risk clobbering a
 * user-confirmed taxonomy tree by inferring one from scratch). A concurrent
 * manual bootstrap/growth run (or a second growth call — defense in depth,
 * though this consumer never issues two in the same tick) can lose the
 * `saveTagTaxonomy` `expectedUpdatedAt` race; that surfaces as a
 * `stale_updated_at`/`future_schema_version` detail in the growth report,
 * which this consumer treats as a transient conflict — the claimed marker
 * groups fail (retry-wait) and try again on a later tick instead of losing
 * the growth's result.
 *
 * `runtime-disabled` errors are swallowed exactly like `embedding-consumer`
 * does: this consumer does nothing on a disabled work runtime and does NOT
 * fall back to any alternate path — taxonomy has always been a manual
 * feature, so "disabled" just means "stay manual" (SPEC-6 PR3+4 decision 3).
 *
 * Lifecycle: `startTaxonomyConsumer` must be called on project open and
 * `stopTaxonomyConsumer` on project close/switch — wired into
 * `reset-project-state.ts`'s centralized cleanup list, same as
 * `stopEmbeddingConsumer`. Every await inside a tick is followed by a
 * generation recheck, for the same SPEC-11 PR8b/S8 reason documented in
 * `embedding-consumer.ts`: `ProjectRootState` is a single global, so an
 * in-flight call issued for the outgoing project can resolve against a
 * newly-opened project if one lands while it's in flight. Abandoning a
 * stale generation's already-claimed jobs mid-loop is safe: they self-heal
 * via the existing lease-timeout reclaim scheduler (Rust-side, independent
 * of this consumer), same as embedding's contract.
 */

import {
  runtimeDerivedMarkerClaimBatch,
  runtimeDerivedMarkerCompleteBatch,
  runtimeDerivedMarkerReleaseBatch,
  runtimeDerivedStaleMarkerList,
  runtimeJobClaimByKind,
  runtimeJobFail,
  runtimeJobHeartbeat,
  runtimeJobList,
  runtimeJobRetry,
  type RuntimeJobClaim,
  type RuntimeJobRecord,
} from "@/commands/runtime-db"
import { JOB_RUNTIME_DEFAULTS } from "@/core-runtime/contract"
import {
  DERIVED_REBUILD_JOB_KIND,
  parseDerivedRebuildJobPayload,
  type DerivedRebuildJobPayload,
} from "@/core-runtime/derived-rebuild"
import { applyTagTaxonomyGrowth, type TagTaxonomyOperationReport } from "@/lib/agent/tag-taxonomy"
import { getQueueSummary as getIngestQueueSummary } from "@/lib/ingest-queue"
import { getQueueSummary as getDedupQueueSummary } from "@/lib/dedup-queue"
import { normalizePath } from "@/lib/path-utils"
import { withProjectLock } from "@/lib/project-mutex"
import type { WikiProject } from "@/types/wiki"

const TICK_INTERVAL_MS = 3_000
const MAX_JOBS_PER_TICK = 25
const HOLDER = "taxonomy-consumer"
const RUNTIME_DISABLED_ERROR_PREFIX = "runtime-disabled:"
const NO_QUEUED_JOB_ERROR_PREFIX = "no-queued-job:"
// Detail codes `runTaxonomyBuild`/`saveTagTaxonomy` surface when the sidecar
// changed under a concurrent write — see tag-taxonomy.ts's `markSaveConflict`
// (stale_updated_at / future_schema_version, with save_conflict as its own
// defensive fallback label) and the up-front future-schema-version check
// (future_schema_conflict). None of these are this consumer's fault; the
// claimed marker groups stay pending-via-retry and converge on a later tick
// once the conflicting write lands.
const TAXONOMY_GROWTH_CONFLICT_DETAIL_CODES = new Set([
  "stale_updated_at",
  "future_schema_version",
  "future_schema_conflict",
  "save_conflict",
])

let tickTimer: ReturnType<typeof setInterval> | null = null
let activeGeneration = 0
let currentProjectPath: string | null = null
// Generation-scoped reentrancy guard (mirrors embedding-consumer.ts's gate
// review P2 fix): keyed by generation number, not a single shared boolean,
// so an old generation's own `finally` can only ever clear ITS OWN entry.
const tickingGenerations = new Set<number>()

class ConsumerGenerationStaleError extends Error {}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function isRuntimeDisabledError(err: unknown): boolean {
  return errorMessage(err).startsWith(RUNTIME_DISABLED_ERROR_PREFIX)
}

function isNoQueuedJobError(err: unknown): boolean {
  return errorMessage(err).startsWith(NO_QUEUED_JOB_ERROR_PREFIX)
}

function assertCurrentRun(generation: number): void {
  if (generation !== activeGeneration) {
    throw new ConsumerGenerationStaleError("taxonomy-consumer: project generation changed mid-tick")
  }
}

/** Start polling for this project. Stops any previous run first (project switch). */
export function startTaxonomyConsumer(project: WikiProject): void {
  stopTaxonomyConsumer()
  const generation = ++activeGeneration
  currentProjectPath = normalizePath(project.path)

  void tick(generation)
  tickTimer = setInterval(() => {
    void tick(generation)
  }, TICK_INTERVAL_MS)
}

/** Stop polling. Safe to call when not running. MUST be called on project close/switch. */
export function stopTaxonomyConsumer(): void {
  activeGeneration += 1
  currentProjectPath = null
  if (tickTimer) {
    clearInterval(tickTimer)
    tickTimer = null
  }
  // Deliberately NOT touching tickingGenerations here — see
  // embedding-consumer.ts's identical comment: an in-flight tick for the
  // outgoing generation owns (and will remove) only its own entry.
}

async function tick(generation: number): Promise<void> {
  if (tickingGenerations.has(generation) || generation !== activeGeneration) return
  tickingGenerations.add(generation)
  try {
    await runTick(generation)
  } catch (err) {
    if (!(err instanceof ConsumerGenerationStaleError) && !isRuntimeDisabledError(err)) {
      console.warn("[taxonomy-consumer] tick failed:", err)
    }
  } finally {
    tickingGenerations.delete(generation)
  }
}

interface ClaimedTaxonomyJob {
  claim: RuntimeJobClaim
  payload: DerivedRebuildJobPayload
}

async function runTick(generation: number): Promise<void> {
  const projectPath = currentProjectPath
  if (!projectPath) return

  // Same busy backoff as embedding-consumer (SPEC-6 PR2 decision 2): growth
  // reads every wiki page's frontmatter, so back off the whole tick while
  // ingest is actively writing pages for this project rather than risk a
  // read mid non-atomic write. Markers stay pending and converge later.
  //
  // Closeout hotfix P1 #4: also back off while dedup merges are in
  // flight — same non-atomic-rewrite race, different queue.
  if (getIngestQueueSummary().processing > 0 || getDedupQueueSummary().processing > 0) return
  assertCurrentRun(generation)

  await recoverRetryWaitJobs(generation)
  assertCurrentRun(generation)

  await foldPendingMarkers(generation)
  assertCurrentRun(generation)

  const claimed: ClaimedTaxonomyJob[] = []
  for (let i = 0; i < MAX_JOBS_PER_TICK; i += 1) {
    assertCurrentRun(generation)
    let claim: RuntimeJobClaim
    try {
      claim = await runtimeJobClaimByKind({
        kind: DERIVED_REBUILD_JOB_KIND,
        holder: HOLDER,
        // SPEC-6 PR3+4 P0-2b: server-side filter so this consumer only ever
        // claims "taxonomy"-layer jobs. Without this, a higher-priority
        // sibling-layer (e.g. "embedding") job could win the claim here
        // every tick — and each such misclaim increments that job's
        // `attempt`, silently burning it to `failed` before its own poller
        // ever sees it (root-caused during 内审 review).
        payloadLayer: "taxonomy",
      })
    } catch (err) {
      if (isNoQueuedJobError(err) || isRuntimeDisabledError(err)) break
      throw err
    }
    assertCurrentRun(generation)

    let payload: DerivedRebuildJobPayload
    try {
      payload = parseDerivedRebuildJobPayload(claim.job.payload)
    } catch (err) {
      await safeFailClaim(claim, [], `invalid-payload: ${errorMessage(err)}`)
      continue
    }

    if (payload.layer !== "taxonomy") {
      // Defense-in-depth backstop only — theoretically unreachable now that
      // the claim above passes `payloadLayer: "taxonomy"` (SPEC-6 PR3+4
      // P0-2b), which filters this server-side. Kept in case that filter is
      // ever bypassed or a job predates it. Leave it untouched; the
      // lease-timeout reclaim scheduler recovers it.
      console.warn(
        `[taxonomy-consumer] claimed a non-taxonomy derived-rebuild job (layer="${payload.layer}"); leaving it for lease-timeout recovery.`,
      )
      continue
    }

    claimed.push({ claim, payload })
  }

  if (claimed.length === 0) return
  assertCurrentRun(generation)
  await runAggregatedGrowth(projectPath, claimed, generation)
}

/**
 * Signal 2 of the PR1 consumer contract: recover crashed/backed-off
 * rebuilds. Identical shape to embedding-consumer's version, filtered to
 * the `"taxonomy"` layer.
 */
async function recoverRetryWaitJobs(generation: number): Promise<void> {
  const list = await runtimeJobList()
  assertCurrentRun(generation)
  const now = Date.now()

  for (const job of list.jobs) {
    if (job.kind !== DERIVED_REBUILD_JOB_KIND || job.state !== "retry-wait") continue
    if (job.retryAfterMs == null || job.retryAfterMs > now) continue

    let payload: DerivedRebuildJobPayload
    try {
      payload = parseDerivedRebuildJobPayload(job.payload)
    } catch {
      continue // corrupt payload — not safely interpretable, leave for lease-timeout
    }
    if (payload.layer !== "taxonomy") continue

    try {
      await runtimeJobRetry(job.jobId)
    } catch (err) {
      if (isRuntimeDisabledError(err)) throw err
      // Benign race: another tick already retried it, or its attempts were
      // exhausted between list() and retry() landing — non-fatal.
      continue
    }
    assertCurrentRun(generation)
  }
}

/**
 * Signal 1 of the PR1 consumer contract: fold newly pending markers into
 * queued jobs, one job per distinct `affectedPath` group (identical shape
 * to embedding-consumer's version, filtered to the `"taxonomy"` layer).
 */
async function foldPendingMarkers(generation: number): Promise<void> {
  const list = await runtimeDerivedStaleMarkerList({ layer: "taxonomy", status: "pending" })
  assertCurrentRun(generation)
  const affectedPaths = Array.from(new Set(list.markers.map((marker) => marker.affectedPath)))

  for (const affectedPath of affectedPaths) {
    assertCurrentRun(generation)
    try {
      await runtimeDerivedMarkerClaimBatch({ layer: "taxonomy", affectedPath })
    } catch (err) {
      if (isRuntimeDisabledError(err)) throw err
      // Benign: another tick already folded this group, or the pending
      // snapshot changed between list() and claim_batch() landing.
      continue
    }
  }
}

/**
 * One tick's ENTIRE set of folded taxonomy marker groups converges through a
 * single `applyTagTaxonomyGrowth` call (SPEC-6 PR3+4 decision 3) — see the
 * file-level doc comment for why per-job growth calls would be wrong.
 */
async function runAggregatedGrowth(
  projectPath: string,
  claimed: readonly ClaimedTaxonomyJob[],
  generation: number,
): Promise<void> {
  const stopHeartbeats = claimed.map(({ claim }) => startHeartbeat(claim))
  try {
    return await withProjectLock(projectPath, () => runAggregatedGrowthUnlocked(projectPath, claimed, generation))
  } finally {
    stopHeartbeats.forEach((stop) => stop())
  }
}

// Split so withProjectLock covers the claimed growth/finalize window;
// heartbeat stays outside the lock to avoid lease expiry. Do not make this reentrant.
async function runAggregatedGrowthUnlocked(
  projectPath: string,
  claimed: readonly ClaimedTaxonomyJob[],
  generation: number,
): Promise<void> {
  try {
    let report: TagTaxonomyOperationReport | null = null
    let growthError: string | null = null
    try {
      report = await applyTagTaxonomyGrowth(projectPath)
    } catch (err) {
      growthError = errorMessage(err)
    }
    assertCurrentRun(generation)

    if (growthError !== null) {
      for (const { claim, payload } of claimed) {
        assertCurrentRun(generation)
        await safeFailClaim(claim, payload.markerIds, `taxonomy-growth-failed: ${growthError}`)
      }
      return
    }

    const conflictDetail = report!.details.find((detail) => TAXONOMY_GROWTH_CONFLICT_DETAIL_CODES.has(detail.code))
    if (conflictDetail) {
      // A concurrent manual bootstrap/growth won the saveTagTaxonomy
      // expectedUpdatedAt race — yield and retry on a later tick rather
      // than clobber (or lose to) the other write.
      for (const { claim, payload } of claimed) {
        assertCurrentRun(generation)
        await safeFailClaim(claim, payload.markerIds, `taxonomy-growth-conflict: ${conflictDetail.message}`)
      }
      return
    }

    for (const { claim, payload } of claimed) {
      assertCurrentRun(generation)
      await safeCompleteClaim(claim, payload.markerIds)
    }
  } catch (err) {
    if (err instanceof ConsumerGenerationStaleError) throw err
    for (const { claim, payload } of claimed) {
      await safeFailClaim(claim, payload.markerIds, errorMessage(err))
    }
  }
}

/** Complete the job + its whole marker batch in one atomic transition (PR1). */
async function safeCompleteClaim(claim: RuntimeJobClaim, markerIds: string[]): Promise<void> {
  try {
    await runtimeDerivedMarkerCompleteBatch({
      jobId: claim.job.jobId,
      leaseId: claim.lease.leaseId,
      markerIds,
    })
  } catch (err) {
    console.warn(`[taxonomy-consumer] failed to complete job ${claim.job.jobId}:`, err)
  }
}

/**
 * Fail the job (job runtime decides retry-wait vs terminal failed based on
 * attempts remaining). Mirrors embedding-consumer's `safeFailClaim`
 * (PR1 decision 4/5: poison-marker convergence) exactly.
 */
async function safeFailClaim(claim: RuntimeJobClaim, markerIds: string[], error: string): Promise<void> {
  let failedJob: RuntimeJobRecord
  try {
    failedJob = await runtimeJobFail({ jobId: claim.job.jobId, leaseId: claim.lease.leaseId, error })
  } catch (err) {
    console.warn(`[taxonomy-consumer] failed to fail job ${claim.job.jobId}:`, err)
    return
  }
  if (failedJob.state === "failed" && markerIds.length > 0) {
    try {
      await runtimeDerivedMarkerReleaseBatch({
        jobId: claim.job.jobId,
        markerIds,
        targetStatus: "failed",
        error,
      })
    } catch (err) {
      console.warn(`[taxonomy-consumer] failed to release terminal markers for job ${claim.job.jobId}:`, err)
    }
  }
}

/**
 * Heartbeats a claimed job's lease while the (potentially slow, full-tree)
 * growth call runs, so it doesn't outlive the lease TTL and get reclaimed
 * out from under this consumer mid-flight. Mirrors embedding-consumer's
 * `startHeartbeat` exactly — one instance per claimed job in the batch,
 * since each job has its own lease.
 */
function startHeartbeat(claim: RuntimeJobClaim): () => void {
  let stopped = false
  let pending: Promise<void> | null = null

  const beat = () => {
    if (stopped || pending) return
    pending = runtimeJobHeartbeat({ jobId: claim.job.jobId, leaseId: claim.lease.leaseId })
      .then(() => undefined)
      .catch((err) => {
        if (!stopped) {
          console.warn(`[taxonomy-consumer] heartbeat failed for job ${claim.job.jobId}:`, err)
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
