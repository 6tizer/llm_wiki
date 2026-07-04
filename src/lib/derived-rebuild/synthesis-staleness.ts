/**
 * SPEC-6 PR3+4: `"synthesis"` layer stale-marker bookkeeping.
 *
 * Unlike `embedding`/`taxonomy`, synthesis deliberately gets NO automatic
 * background job consumer (SPEC-6 PR3+4 decision 4) — an LLM call per
 * cluster is expensive, and auto-regenerating a synthesis page risks
 * silently overwriting a human-curated narrative the moment any one of its
 * source pages changes (the same "don't clobber a human's work" instinct
 * SPEC-11's source-lifecycle overwrite protections apply elsewhere). So this
 * file provides two independent pieces instead of a poller:
 *
 * 1. `listSynthesisStaleness` — a pure, read-only query correlating pending
 *    `"synthesis"` derived markers (which are recorded per SOURCE wiki page,
 *    same as every other layer — see commit-integration.ts's
 *    `recordDerivedMarkers`) against the tag-combination clusters
 *    `discoverSynthesisCandidates` (wiki-synthesis.ts) already knows how to
 *    build, so a future UI (PR6) can badge "this synthesis topic has stale
 *    inputs" without this file needing its own clustering logic.
 * 2. `markSynthesisRebuilt` — the manual-rebuild closeout. The "consumer" for
 *    the synthesis layer IS the manual "regenerate this cluster" action
 *    itself (SPEC-6 PR3+4 decision 4): once `runWikiSynthesis` has
 *    successfully regenerated a cluster, this closes the loop for every
 *    pending `"synthesis"` marker on that cluster's source pages via
 *    claim_batch → `runtimeJobClaim(jobId)` → complete_batch (SPEC-6 PR1's
 *    machinery), invoked once on-demand instead of from a poller.
 *
 * Deviation from the plan's shorthand `markSynthesisRebuilt(projectPath,
 * slug)`: a bare slug is not sufficient to resolve back to the exact set of
 * source pages a cluster covers, because `slugifyTopic` collapses tags with
 * `-` and is not guaranteed injective across different `dimension`s (e.g. a
 * 2-tag cluster and an unrelated 1-tag cluster could coincidentally slugify
 * to the same string). `synthesis-section.tsx` already holds the full
 * `SynthesisCandidate` (slug + tags + pages) it just generated from, at zero
 * extra cost — so `markSynthesisRebuilt` takes that instead, and uses
 * `candidate.pages` directly rather than re-running discovery (which could
 * observe a different snapshot of the wiki tree than the one the just-
 * completed synthesis actually used). `projectPath` is intentionally NOT a
 * parameter here (Simplicity review P2, post-implementation): every
 * `runtime-db` command this file calls operates on the single currently-open
 * project implicitly (same as `runtimeJobClaimByKind`/`claim_batch`
 * elsewhere) — there is no per-call path argument to thread through, so
 * carrying an unused `projectPath` forward would just be speculative
 * future-proofing.
 *
 * P0 fixes from the 内审/Tester gate round (post-implementation, before this
 * comment was written):
 * - `claim_batch` is called WITHOUT a caller-chosen `jobId` — a deterministic
 *   id derived from `(slug, affectedPath)` collided across repeated/
 *   overlapping `markSynthesisRebuilt` calls for the same cluster (INSERT
 *   into `runtime_jobs` on an existing primary key fails outright). The
 *   returned `folded.job.jobId` (server-generated UUID, PR1's default) is
 *   used for every following step instead.
 * - The just-folded job is claimed by its now-known exact id via
 *   `runtimeJobClaim({ jobId })` (SPEC-6 PR3+4 P0-2a) — a single targeted
 *   IPC call, not a bounded "claim-by-kind and hope it's ours, else leave it
 *   and retry" hunt loop. The hunt loop had a real correctness cost: every
 *   misclaim of an unrelated job (which the loop had to do repeatedly under
 *   contention) increments that job's `attempt` counter, and three
 *   misclaims are enough to burn a sibling consumer's job to `failed` before
 *   its own poller ever sees it (root-caused during 内审 review of
 *   embedding-consumer.ts/taxonomy-consumer.ts's shared job kind).
 *
 * Residual crash window (documented, not eliminated — PR6 diagnostics
 * candidate, same class of risk as an orphaned anchor job): if the process
 * crashes between `claim_batch` succeeding and `complete_batch` running (two
 * single-IPC-width gaps: claim_batch → runtimeJobClaim, and runtimeJobClaim
 * → complete_batch), the affected markers are left `claimed` under a job
 * that nothing will ever converge — either still `queued` (nobody re-claims
 * it: embedding-consumer/taxonomy-consumer now filter `payloadLayer` to
 * their own layer, SPEC-6 PR3+4 P0-2b) or `running` until its lease expires
 * and the lease-timeout scheduler moves it to `retry-wait` (where it also
 * sits forever, since synthesis intentionally has no background poller to
 * recover `retry-wait` jobs). The next `markSynthesisRebuilt` call for the
 * SAME cluster/path cannot self-heal this — `claim_batch` only ever folds
 * `pending` markers, and these are stuck `claimed`. Recovery today requires
 * either the job's eventual lease-timeout-driven reclaim (bounded but not
 * automatic further than that) or a future PR6 diagnostics action.
 */

import {
  runtimeDerivedMarkerClaimBatch,
  runtimeDerivedMarkerCompleteBatch,
  runtimeDerivedStaleMarkerList,
  runtimeJobClaim,
  type RuntimeDerivedStaleMarkerRecord,
} from "@/commands/runtime-db"
import {
  discoverSynthesisCandidates,
  type ClusterPage,
  type SynthesisCandidate,
  type SynthesisDiscoveryOptions,
} from "@/lib/wiki-synthesis"

const HOLDER = "synthesis-manual-rebuild"
const RUNTIME_DISABLED_ERROR_PREFIX = "runtime-disabled:"
const CLAIM_EMPTY_ERROR_PREFIX = "derived-marker-claim-empty"

/** One synthesis-input cluster with at least one stale (pending-marker) source page. */
export interface SynthesisStaleCluster {
  slug: string
  topic: string
  tags: string[]
  pageCount: number
  staleAffectedPaths: string[]
  markerIds: string[]
}

/** Read-only synthesis staleness snapshot for a project. */
export interface SynthesisStalenessReport {
  pendingMarkerCount: number
  staleClusters: SynthesisStaleCluster[]
}

function pageAffectedPath(page: Pick<ClusterPage, "slug">): string {
  return `wiki/${page.slug}.md`
}

/**
 * Lists pending `"synthesis"` derived markers grouped by which
 * `discoverSynthesisCandidates` cluster they fall under. Pure query — never
 * claims or mutates a marker. Intended for a future PR6 UI stale badge.
 */
export async function listSynthesisStaleness(
  projectPath: string,
  options: SynthesisDiscoveryOptions = {},
): Promise<SynthesisStalenessReport> {
  const markerList = await runtimeDerivedStaleMarkerList({ layer: "synthesis", status: "pending" })
  if (markerList.markers.length === 0) {
    return { pendingMarkerCount: 0, staleClusters: [] }
  }

  const markersByPath = groupMarkersByAffectedPath(markerList.markers)
  const discovery = await discoverSynthesisCandidates(projectPath, options)
  const staleClusters: SynthesisStaleCluster[] = []

  for (const candidate of discovery.candidates) {
    const staleAffectedPaths: string[] = []
    const markerIds: string[] = []
    for (const page of candidate.pages) {
      const affectedPath = pageAffectedPath(page)
      const markers = markersByPath.get(affectedPath)
      if (!markers || markers.length === 0) continue
      staleAffectedPaths.push(affectedPath)
      markerIds.push(...markers.map((marker) => marker.markerId))
    }
    if (staleAffectedPaths.length > 0) {
      staleClusters.push({
        slug: candidate.slug,
        topic: candidate.topic,
        tags: candidate.tags,
        pageCount: candidate.pageCount,
        staleAffectedPaths,
        markerIds,
      })
    }
  }

  return { pendingMarkerCount: markerList.markers.length, staleClusters }
}

function groupMarkersByAffectedPath(
  markers: readonly RuntimeDerivedStaleMarkerRecord[],
): Map<string, RuntimeDerivedStaleMarkerRecord[]> {
  const map = new Map<string, RuntimeDerivedStaleMarkerRecord[]>()
  for (const marker of markers) {
    const list = map.get(marker.affectedPath) ?? []
    list.push(marker)
    map.set(marker.affectedPath, list)
  }
  return map
}

/** Result of closing out a cluster's pending synthesis markers after a manual regenerate. */
export interface MarkSynthesisRebuiltResult {
  affectedPaths: string[]
  completedGroups: number
  skippedGroups: number
}

/**
 * Closes the pending `"synthesis"` marker loop for a cluster that was just
 * manually regenerated via `runWikiSynthesis` — the "consumer" for this
 * layer is this call itself (SPEC-6 PR3+4 decision 4), not a background
 * poller. Best-effort: a failure here does not (and must not) undo the
 * synthesis page that was already written; it only means those markers stay
 * pending and get folded again on the next manual rebuild for this cluster.
 */
export async function markSynthesisRebuilt(
  candidate: Pick<SynthesisCandidate, "slug" | "pages">,
): Promise<MarkSynthesisRebuiltResult> {
  const affectedPaths = candidate.pages.map(pageAffectedPath)
  let completedGroups = 0
  let skippedGroups = 0

  for (const affectedPath of affectedPaths) {
    // No caller-chosen jobId (P0-1): letting claim_batch mint its own UUID
    // (PR1 default) means a repeated/overlapping markSynthesisRebuilt call
    // for the same cluster can never collide on a deterministic id derived
    // from (slug, affectedPath).
    let folded: Awaited<ReturnType<typeof runtimeDerivedMarkerClaimBatch>>
    try {
      folded = await runtimeDerivedMarkerClaimBatch({ layer: "synthesis", affectedPath })
    } catch (err) {
      if (isClaimEmptyError(err)) {
        skippedGroups += 1
        continue
      }
      if (isRuntimeDisabledError(err)) return { affectedPaths, completedGroups, skippedGroups }
      throw err
    }

    const jobId = folded.job.jobId
    const markerIds = folded.markers.map((marker) => marker.markerId)

    // Claim the EXACT job just folded by id (P0-2a) — a single targeted IPC
    // call, not a claim-by-kind hunt loop. See the file doc comment for why
    // the hunt loop was a real correctness hazard (attempt-count burn on
    // misclaimed sibling jobs), not just an inefficiency.
    let claim: Awaited<ReturnType<typeof runtimeJobClaim>>
    try {
      claim = await runtimeJobClaim({ holder: HOLDER, jobId })
    } catch (err) {
      if (isRuntimeDisabledError(err)) return { affectedPaths, completedGroups, skippedGroups }
      // The job we just created is somehow not claimable (should not
      // happen absent a runtime-disabled race) — leave it for the
      // lease-timeout scheduler / a future PR6 diagnostics action rather
      // than throwing out of a best-effort closeout call.
      console.warn(`[synthesis-staleness] failed to claim job ${jobId} for ${affectedPath}:`, err)
      skippedGroups += 1
      continue
    }

    try {
      await runtimeDerivedMarkerCompleteBatch({ jobId, leaseId: claim.lease.leaseId, markerIds })
      completedGroups += 1
    } catch (err) {
      console.warn(`[synthesis-staleness] failed to complete marker batch for ${affectedPath}:`, err)
      skippedGroups += 1
    }
  }

  return { affectedPaths, completedGroups, skippedGroups }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function isRuntimeDisabledError(err: unknown): boolean {
  return errorMessage(err).startsWith(RUNTIME_DISABLED_ERROR_PREFIX)
}

function isClaimEmptyError(err: unknown): boolean {
  return errorMessage(err).startsWith(CLAIM_EMPTY_ERROR_PREFIX)
}
