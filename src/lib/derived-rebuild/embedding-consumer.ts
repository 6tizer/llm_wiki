/**
 * SPEC-6 PR2: the `"embedding"` layer's `derived-rebuild` job consumer.
 *
 * A module-level polling loop (mirrors `scheduled-import.ts`'s start/stop +
 * generation-counter shape) that keeps LanceDB vectors converged with what
 * committed to `wiki/**`, now that ingest no longer embeds inline. Every
 * tick polls BOTH signals required by the PR1 consumer contract (see
 * `@/core-runtime/derived-rebuild`'s `DerivedRebuildJobPayload` doc comment):
 *
 *   1. Newly pending `"embedding"` markers — folded into a fresh queued
 *      `derived-rebuild` job via `runtimeDerivedMarkerClaimBatch`.
 *   2. `retry-wait` `derived-rebuild` jobs whose backoff has elapsed —
 *      recovered onto the SAME job id via `runtimeJobRetry`.
 *
 * Either signal lands a job in `queued`; this loop then claims and executes
 * it. A partial embedding failure fails the job (retry-wait, backed off by
 * the job runtime) instead of completing it — a page indexed with missing
 * chunks is a silent search-quality regression, not success.
 *
 * Lifecycle: `startEmbeddingConsumer` must be called on project open and
 * `stopEmbeddingConsumer` on project close/switch — wired into
 * `reset-project-state.ts`'s centralized cleanup list, same as
 * `stopScheduledImport`. Every await inside a tick is followed by a
 * generation recheck (not just one check at tick start): the Rust backend's
 * `ProjectRootState` is a single global, so an in-flight call issued for
 * the outgoing project can resolve against a newly-opened project if one
 * lands while it's in flight (SPEC-11 PR8b/S8). `assertCurrentRun` throws a
 * dedicated, silently-swallowed error the instant that happens, and no
 * further runtime-db calls (which would otherwise touch the wrong
 * project's runtime db) are made for that tick — an already-claimed lease
 * is simply abandoned and self-heals via the existing lease-timeout
 * reclaim scheduler (Rust-side, independent of this consumer).
 */

import { readFile } from "@/commands/fs"
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
import { getQueueSummary as getIngestQueueSummary } from "@/lib/ingest-queue"
import { getQueueSummary as getDedupQueueSummary } from "@/lib/dedup-queue"
import { isAbsolutePath, normalizePath } from "@/lib/path-utils"
import { withProjectLock } from "@/lib/project-mutex"
import { extractPageTitle, isRootStructuralWikiPagePath, wikiPathToVectorPageId } from "@/lib/wiki-page-identity"
import { useWikiStore } from "@/stores/wiki-store"
import type { WikiProject } from "@/types/wiki"

const TICK_INTERVAL_MS = 3_000
const MAX_JOBS_PER_TICK = 25
const HOLDER = "embedding-consumer"
const RUNTIME_DISABLED_ERROR_PREFIX = "runtime-disabled:"
const NO_QUEUED_JOB_ERROR_PREFIX = "no-queued-job:"
// Exact prefix `read_file` (fs.rs) uses for the "path doesn't exist"
// branch — distinct from its "exists but unreadable as text (binary,
// locked, non-UTF-8)" branch, which uses a different message and is
// exactly the shape a concurrent write window can produce (gate review
// P1: a transient read failure must NOT be treated as "page deleted").
const FILE_NOT_FOUND_ERROR_PREFIX = "File does not exist:"

let tickTimer: ReturnType<typeof setInterval> | null = null
let activeGeneration = 0
let currentProjectPath: string | null = null
// Generation-scoped reentrancy guard (gate review P2): keyed by
// generation number, not a single shared boolean. A single boolean would
// let an old (about-to-self-abort) generation's `finally` clear the SAME
// flag a brand-new generation's tick just set, opening a window for the
// new generation's own interval to start a second, overlapping tick for
// itself. Scoping by generation means each generation's single-flight
// guard is independent of every other generation's — an old tick's own
// cleanup can only ever remove ITS OWN entry.
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

function isFileNotFoundError(err: unknown): boolean {
  return errorMessage(err).startsWith(FILE_NOT_FOUND_ERROR_PREFIX)
}

function assertCurrentRun(generation: number): void {
  if (generation !== activeGeneration) {
    throw new ConsumerGenerationStaleError("embedding-consumer: project generation changed mid-tick")
  }
}

/** Start polling for this project. Stops any previous run first (project switch). */
export function startEmbeddingConsumer(project: WikiProject): void {
  stopEmbeddingConsumer()
  const generation = ++activeGeneration
  currentProjectPath = normalizePath(project.path)

  void tick(generation)
  tickTimer = setInterval(() => {
    void tick(generation)
  }, TICK_INTERVAL_MS)
}

/** Stop polling. Safe to call when not running. MUST be called on project close/switch. */
export function stopEmbeddingConsumer(): void {
  activeGeneration += 1
  currentProjectPath = null
  if (tickTimer) {
    clearInterval(tickTimer)
    tickTimer = null
  }
  // Deliberately NOT touching tickingGenerations here: an in-flight tick
  // for the outgoing generation owns (and will remove) only its own entry
  // once it self-aborts at its next `assertCurrentRun` check. A brand-new
  // generation from an immediately-following start() gets its own fresh
  // entry and is never blocked by the outgoing one's still-unwinding tick.
}

async function tick(generation: number): Promise<void> {
  if (tickingGenerations.has(generation) || generation !== activeGeneration) return
  tickingGenerations.add(generation)
  try {
    await runTick(generation)
  } catch (err) {
    if (!(err instanceof ConsumerGenerationStaleError) && !isRuntimeDisabledError(err)) {
      console.warn("[embedding-consumer] tick failed:", err)
    }
  } finally {
    tickingGenerations.delete(generation)
  }
}

async function runTick(generation: number): Promise<void> {
  const projectPath = currentProjectPath
  if (!projectPath) return

  // Concurrency mitigation (SPEC-6 PR2 decision 2): back off the ENTIRE
  // tick if ingest is actively writing pages for this project, rather than
  // risk reading a wiki file mid non-atomic write. Coarse (project-wide,
  // not per-path) because ingest's source path and a marker's wiki
  // affectedPath live in different namespaces with no cheap correlation.
  // Markers stay pending and converge on a later tick.
  //
  // Closeout hotfix P1 #4: dedup merges (`dedup-runner.ts`, queued via
  // `dedup-queue.ts`) rewrite the SAME wiki pages non-atomically — same
  // race class as ingest, just a different queue — so the busy check must
  // cover both, not just ingest's.
  if (getIngestQueueSummary().processing > 0 || getDedupQueueSummary().processing > 0) return
  assertCurrentRun(generation)

  await recoverRetryWaitJobs(generation)
  assertCurrentRun(generation)

  await foldPendingMarkers(generation)
  assertCurrentRun(generation)

  for (let i = 0; i < MAX_JOBS_PER_TICK; i += 1) {
    assertCurrentRun(generation)
    let claim: RuntimeJobClaim
    try {
      claim = await runtimeJobClaimByKind({
        kind: DERIVED_REBUILD_JOB_KIND,
        holder: HOLDER,
        // SPEC-6 PR3+4 P0-2b: server-side filter so this consumer only ever
        // claims "embedding"-layer jobs, even though "derived-rebuild" is a
        // job kind shared by every layer (PR1 decision 2). Without this, a
        // higher-priority sibling-layer job could win the claim here every
        // tick — and each such misclaim increments that job's `attempt`,
        // silently burning it to `failed` before its own poller ever sees
        // it (root-caused during 内审 review).
        payloadLayer: "embedding",
      })
    } catch (err) {
      if (isNoQueuedJobError(err) || isRuntimeDisabledError(err)) return
      throw err
    }
    assertCurrentRun(generation)
    await processClaimedJob(projectPath, claim, generation)
  }
}

/** Signal 2 of the PR1 consumer contract: recover crashed/backed-off rebuilds. */
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
    if (payload.layer !== "embedding") continue

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

/** Signal 1 of the PR1 consumer contract: fold newly pending markers into queued jobs. */
async function foldPendingMarkers(generation: number): Promise<void> {
  const list = await runtimeDerivedStaleMarkerList({ layer: "embedding", status: "pending" })
  assertCurrentRun(generation)
  const affectedPaths = Array.from(new Set(list.markers.map((marker) => marker.affectedPath)))

  for (const affectedPath of affectedPaths) {
    assertCurrentRun(generation)
    try {
      await runtimeDerivedMarkerClaimBatch({ layer: "embedding", affectedPath })
    } catch (err) {
      if (isRuntimeDisabledError(err)) throw err
      // Benign: another tick already folded this group, or the pending
      // snapshot changed between list() and claim_batch() landing.
      continue
    }
  }
}

async function processClaimedJob(
  projectPath: string,
  claim: RuntimeJobClaim,
  generation: number,
): Promise<void> {
  const stopHeartbeat = startHeartbeat(claim)
  try {
    return await withProjectLock(projectPath, () => processClaimedJobUnlocked(projectPath, claim, generation))
  } finally {
    stopHeartbeat()
  }
}

// Split so withProjectLock covers the claimed read/write/finalize window;
// heartbeat stays outside the lock to avoid lease expiry. Do not make this reentrant.
async function processClaimedJobUnlocked(
  projectPath: string,
  claim: RuntimeJobClaim,
  generation: number,
): Promise<void> {
  let payload: DerivedRebuildJobPayload | null = null
  try {
    try {
      payload = parseDerivedRebuildJobPayload(claim.job.payload)
    } catch (err) {
      await safeFailClaim(claim, [], `invalid-payload: ${errorMessage(err)}`)
      return
    }

    if (payload.layer !== "embedding") {
      // Defense-in-depth backstop only — theoretically unreachable now that
      // the claim above passes `payloadLayer: "embedding"` (SPEC-6 PR3+4
      // P0-2b), which filters this server-side. Kept in case that filter is
      // ever bypassed (e.g. a future direct `claim_by_kind` caller omits
      // it) or a job predates the filter. Leave it untouched; the
      // lease-timeout reclaim scheduler recovers it back to retry-wait once
      // this lease expires.
      console.warn(
        `[embedding-consumer] claimed a non-embedding derived-rebuild job (layer="${payload.layer}"); leaving it for lease-timeout recovery.`,
      )
      return
    }

    assertCurrentRun(generation)

    if (payload.reason === "delete") {
      const { removePageEmbedding } = await import("@/lib/embedding")
      await removePageEmbedding(projectPath, wikiPathToVectorPageId(projectPath, payload.affectedPath))
      assertCurrentRun(generation)
      await safeCompleteClaim(claim, payload.markerIds)
      return
    }

    if (isRootStructuralWikiPagePath(projectPath, payload.affectedPath)) {
      // Should never have been marked (both producers skip structural
      // pages) — skip defensively rather than index one.
      await safeCompleteClaim(claim, payload.markerIds)
      return
    }

    const embCfg = useWikiStore.getState().embeddingConfig
    if (!embCfg.enabled || !embCfg.model) {
      // Nothing to index while embedding is off. Complete as a no-op
      // rather than fail/retry forever — a future write re-marks the page
      // stale, and turning embedding back on triggers a full rebuild from
      // Settings, not a backlog of these markers.
      await safeCompleteClaim(claim, payload.markerIds)
      return
    }

    let content: string
    try {
      const fullPath = isAbsolutePath(payload.affectedPath)
        ? normalizePath(payload.affectedPath)
        : `${projectPath}/${payload.affectedPath}`
      content = await readFile(fullPath)
    } catch (err) {
      assertCurrentRun(generation)
      if (!isFileNotFoundError(err)) {
        // The path EXISTS but couldn't be read as text — fs.rs's
        // read_file surfaces this as a distinct error shape (binary,
        // locked, non-UTF-8), which is exactly what a reader can observe
        // during a concurrent, non-atomic write to the same path (gate
        // review P1). That is NOT evidence the page was deleted — fail
        // (retry-wait) instead of silently wiping its embedding.
        await safeFailClaim(claim, payload.markerIds, `read-failed: ${errorMessage(err)}`)
        return
      }
      // The page no longer exists on disk (re-read, not payload snapshot,
      // per PR2 decision 6) — treat it like a delete so a removed page
      // doesn't leave orphaned vectors behind forever.
      const { removePageEmbedding } = await import("@/lib/embedding")
      await removePageEmbedding(projectPath, wikiPathToVectorPageId(projectPath, payload.affectedPath))
      assertCurrentRun(generation)
      await safeCompleteClaim(claim, payload.markerIds)
      return
    }
    assertCurrentRun(generation)

    const titleFallback = payload.affectedPath.replace(/^wiki\//, "").replace(/\.md$/, "")
    const title = extractPageTitle(content, titleFallback)
    const pageId = wikiPathToVectorPageId(projectPath, payload.affectedPath)

    const { embedPage } = await import("@/lib/embedding")
    const { indexed, failed } = await embedPage(projectPath, pageId, title, content, embCfg)
    assertCurrentRun(generation)

    if (failed > 0) {
      await safeFailClaim(
        claim,
        payload.markerIds,
        `embedding-partial-failure: ${failed}/${indexed + failed} chunks failed`,
      )
      return
    }

    await safeCompleteClaim(claim, payload.markerIds)
  } catch (err) {
    if (err instanceof ConsumerGenerationStaleError) throw err
    await safeFailClaim(claim, payload?.markerIds ?? [], errorMessage(err))
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
    console.warn(`[embedding-consumer] failed to complete job ${claim.job.jobId}:`, err)
  }
}

/**
 * Fail the job (job runtime decides retry-wait vs terminal failed based on
 * attempts remaining). `runtime_job_fail` itself is marker-agnostic — if
 * the job actually reached the terminal `failed` state, the claimed
 * markers must be explicitly released to `failed` too (PR1 decision 4/5:
 * poison-marker convergence), otherwise they stay `claimed` forever with
 * no owning job left to retry them. A non-terminal `retry-wait` outcome
 * needs no marker action — they stay `claimed` under this same job id
 * until `runtimeJobRetry` recovers it (PR1's orphan-marker fix).
 */
async function safeFailClaim(claim: RuntimeJobClaim, markerIds: string[], error: string): Promise<void> {
  let failedJob: RuntimeJobRecord
  try {
    failedJob = await runtimeJobFail({ jobId: claim.job.jobId, leaseId: claim.lease.leaseId, error })
  } catch (err) {
    console.warn(`[embedding-consumer] failed to fail job ${claim.job.jobId}:`, err)
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
      console.warn(`[embedding-consumer] failed to release terminal markers for job ${claim.job.jobId}:`, err)
    }
  }
}

/**
 * Heartbeats the claimed job's lease while a (potentially slow) embedding
 * call runs, so it doesn't outlive the lease TTL and get reclaimed out from
 * under this consumer mid-flight. Mirrors
 * `prepare-worker-pool.ts`'s `startJobHeartbeat`. Stops the instant the
 * caller settles, before any complete/fail bookkeeping runs.
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
          console.warn(`[embedding-consumer] heartbeat failed for job ${claim.job.jobId}:`, err)
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
