/**
 * SPEC-6 PR6: shared "mint a throwaway anchor job, then use it to append an
 * event and record a derived-stale marker" dance.
 *
 * `manual-rebuild.ts`'s `mintManualRebuildClaim` (SPEC-6 PR5) and
 * `ingest-write.ts`'s `recordEmbeddingStaleMarker` (SPEC-6 PR2) each
 * independently implemented the identical create → claim → event-append →
 * complete → record sequence. `mintDerivedStaleMarkerAnchorEvent` below is
 * that one sequence, factored out — the two pre-existing callers now call
 * it instead of repeating it, and this PR's new embedding/taxonomy
 * "Rebuild" buttons are the third call site (decision 5's "zero copies"
 * requirement), via `mintManualRebuildMarker`/`mintManualRebuildForLayer`.
 *
 * The callers differ only in:
 *   - which throwaway job `kind` they mint (`anchorKind`) — kept distinct
 *     per caller purely so runtime diagnostics can tell them apart; never
 *     `DERIVED_REBUILD_JOB_KIND` (see `manual-rebuild.ts`'s file doc
 *     comment for why a job of that kind with no `markerIds` payload would
 *     be an unrecoverable ghost row).
 *   - how they claim the anchor once created (`claimMode`): `"by-id"`
 *     claims the exact row just created; `"by-kind"` claims ANY queued job
 *     of `anchorKind` (`recordEmbeddingStaleMarker`'s pre-existing
 *     behavior) — safe either way because the anchor job is fungible, only
 *     ever used to mint a valid `sourceEventId` FK, never read back.
 *   - what they put in the anchor's event payload and the marker's
 *     `baseVersion` (the latter may need the just-minted event id, hence
 *     `baseVersion` accepts either a plain string or a function of the
 *     event id).
 */

import {
  runtimeDerivedStaleMarkerRecord,
  runtimeEventAppend,
  runtimeJobClaim,
  runtimeJobClaimByKind,
  runtimeJobComplete,
  runtimeJobCreate,
  type RuntimeDerivedStaleMarkerRecord,
} from "@/commands/runtime-db"
import type { DerivedStaleMarkerLayer, DerivedStaleMarkerReason } from "@/core-runtime/contract"

export type AnchorClaimMode = "by-id" | "by-kind"

export interface MintDerivedStaleMarkerAnchorOptions {
  anchorKind: string
  holder: string
  claimMode: AnchorClaimMode
  eventPayload: unknown
  layer: DerivedStaleMarkerLayer
  affectedPath: string
  inputHash: string | null
  baseVersion: string | ((eventId: string) => string)
  reason: DerivedStaleMarkerReason
  maxAttempts?: number
}

export async function mintDerivedStaleMarkerAnchorEvent(
  options: MintDerivedStaleMarkerAnchorOptions,
): Promise<RuntimeDerivedStaleMarkerRecord> {
  const anchor = await runtimeJobCreate({
    kind: options.anchorKind,
    payload: JSON.stringify({ layer: options.layer, affectedPath: options.affectedPath }),
    maxAttempts: options.maxAttempts ?? 1,
  })
  const claim =
    options.claimMode === "by-id"
      ? await runtimeJobClaim({ holder: options.holder, jobId: anchor.jobId })
      : await runtimeJobClaimByKind({ kind: options.anchorKind, holder: options.holder })
  const event = await runtimeEventAppend({
    jobId: claim.job.jobId,
    payload: JSON.stringify(options.eventPayload),
  })
  await runtimeJobComplete({ jobId: claim.job.jobId, leaseId: claim.lease.leaseId })

  const baseVersion =
    typeof options.baseVersion === "function" ? options.baseVersion(event.eventId) : options.baseVersion

  return runtimeDerivedStaleMarkerRecord({
    layer: options.layer,
    affectedPath: options.affectedPath,
    inputHash: options.inputHash,
    baseVersion,
    reason: options.reason,
    sourceEventId: event.eventId,
  })
}

/** Throwaway anchor job kind shared by every manual-rebuild-triggered marker (index_export/overview's mint-to-close loop AND the mint-only embedding/taxonomy buttons below). */
export const MANUAL_REBUILD_ANCHOR_JOB_KIND = "manual-rebuild-marker-event"

/** Sentinel `inputHash` for manual-rebuild markers — see `manual-rebuild.ts`'s file doc comment: neither layer has a single content hash to record for a whole-layer rebuild, and nothing reads this value back for equality. */
export const MANUAL_REBUILD_INPUT_HASH = "sha256:manual-rebuild"

const RUNTIME_DISABLED_ERROR_PREFIX = "runtime-disabled:"

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function isRuntimeDisabledError(err: unknown): boolean {
  return errorMessage(err).startsWith(RUNTIME_DISABLED_ERROR_PREFIX)
}

export type MintManualRebuildMarkerResult = "recorded" | "runtime-disabled" | "error"

export interface MintManualRebuildMarkerOptions {
  layer: DerivedStaleMarkerLayer
  affectedPath: string
  holder: string
}

/**
 * Mint-only manual-rebuild marker for layers WITH a background consumer
 * (`embedding`/`taxonomy`, SPEC-6 PR6 decision 5): records a
 * `"manual_rebuild"`-reason pending marker and returns — deliberately NOT
 * claiming/folding it into a job. The layer's own already-running consumer
 * (`embedding-consumer.ts`/`taxonomy-consumer.ts`) picks it up on its next
 * regular tick, indistinguishable from a normal commit-triggered marker
 * (neither consumer special-cases the `manual_rebuild` reason). Non-throwing
 * — same three-state contract as `recordEmbeddingStaleMarker`.
 */
export async function mintManualRebuildMarker(
  options: MintManualRebuildMarkerOptions,
): Promise<MintManualRebuildMarkerResult> {
  try {
    await mintDerivedStaleMarkerAnchorEvent({
      anchorKind: MANUAL_REBUILD_ANCHOR_JOB_KIND,
      holder: options.holder,
      claimMode: "by-id",
      eventPayload: { kind: "manual_rebuild", layer: options.layer, affectedPath: options.affectedPath },
      layer: options.layer,
      affectedPath: options.affectedPath,
      inputHash: MANUAL_REBUILD_INPUT_HASH,
      baseVersion: (eventId) => `manual-rebuild:${eventId}`,
      reason: "manual_rebuild",
    })
    return "recorded"
  } catch (err) {
    if (isRuntimeDisabledError(err)) return "runtime-disabled"
    console.warn(
      `[manual-rebuild-marker] failed to mint marker for ${options.layer}/${options.affectedPath}:`,
      errorMessage(err),
    )
    return "error"
  }
}

/**
 * Sentinel `affectedPath` for a whole-layer taxonomy manual rebuild.
 * `taxonomy-consumer.ts`'s `applyTagTaxonomyGrowth` is a single
 * deterministic full-wiki-tree rescan that ignores which `affectedPath`(s)
 * are pending (see that file's doc comment) — one marker is enough to make
 * the consumer's next tick run a fresh growth pass, so there is no reason
 * to enumerate every wiki page for this layer the way `embedding` needs to.
 */
export const TAXONOMY_MANUAL_REBUILD_AFFECTED_PATH = "wiki"

async function listWikiPageAffectedPaths(projectPath: string): Promise<string[]> {
  const [{ listDirectory }, { flattenMdFiles }, { isRootStructuralWikiPagePath }, { normalizePath, getRelativePath }] =
    await Promise.all([
      import("@/commands/fs"),
      import("@/lib/wiki-utils"),
      import("@/lib/wiki-page-identity"),
      import("@/lib/path-utils"),
    ])

  const pp = normalizePath(projectPath)
  let tree: Awaited<ReturnType<typeof listDirectory>>
  try {
    tree = await listDirectory(`${pp}/wiki`)
  } catch {
    return []
  }

  return flattenMdFiles(tree)
    .filter((file) => !isRootStructuralWikiPagePath(pp, file.path))
    .map((file) => getRelativePath(file.path, pp))
}

export interface MintManualRebuildForLayerResult {
  mintedCount: number
  failedCount: number
  runtimeDisabled: boolean
}

/** Derived layers supported by the mint-only manual rebuild path. */
export type RebuildableLayer = "embedding" | "taxonomy"

const REBUILDABLE_LAYERS = new Set<DerivedStaleMarkerLayer>(["embedding", "taxonomy"])

/** Whether a derived layer supports the mint-only manual rebuild path. */
export function isRebuildableLayer(layer: DerivedStaleMarkerLayer): layer is RebuildableLayer {
  return REBUILDABLE_LAYERS.has(layer)
}

/**
 * Whole-layer manual rebuild for `embedding`/`taxonomy` (SPEC-6 PR6 decision
 * 5/6's new Rebuild buttons). `embedding` mints one marker per current wiki
 * page (its consumer processes exactly one page per pending marker —
 * `embedding-consumer.ts`'s `foldPendingMarkers`); `taxonomy` mints exactly
 * one marker at `TAXONOMY_MANUAL_REBUILD_AFFECTED_PATH` since its consumer's
 * rescan is whole-tree regardless of how many/which paths are pending.
 *
 * The explicit Work Runtime kill-switch is process-wide, so if the FIRST
 * mint call reports `"runtime-disabled"` every subsequent one would too —
 * this returns immediately on that result instead of looping over
 * potentially hundreds of pages for the same foregone conclusion.
 */
export async function mintManualRebuildForLayer(
  layer: RebuildableLayer,
  projectPath: string,
  holder: string,
): Promise<MintManualRebuildForLayerResult> {
  const affectedPaths =
    layer === "embedding"
      ? await listWikiPageAffectedPaths(projectPath)
      : [TAXONOMY_MANUAL_REBUILD_AFFECTED_PATH]

  let mintedCount = 0
  let failedCount = 0
  for (const affectedPath of affectedPaths) {
    const result = await mintManualRebuildMarker({ layer, affectedPath, holder })
    if (result === "recorded") {
      mintedCount += 1
    } else if (result === "runtime-disabled") {
      return { mintedCount, failedCount, runtimeDisabled: true }
    } else {
      failedCount += 1
    }
  }
  return { mintedCount, failedCount, runtimeDisabled: false }
}
