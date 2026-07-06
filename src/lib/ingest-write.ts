/**
 * Write-layer functions for the ingest pipeline.
 *
 * Page merging, backup, image injection, and re-embedding.
 * Extracted from ingest.ts (Phase 3.7, PR 2). No logic changes.
 * Re-exported by ingest.ts so external callers are unaffected.
 */

import { readFile, writeFile } from "@/commands/fs"
import type { LlmConfig } from "@/stores/wiki-store"
import { useWikiStore } from "@/stores/wiki-store"
import { streamChatRouted } from "@/lib/pool-chat"
import { loadCaptionCache } from "@/lib/image-caption-pipeline"
import { buildImageMarkdownSection } from "@/lib/extract-source-images"
import type { MergeFn } from "@/lib/page-merge"

export async function tryReadFile(path: string): Promise<string | null> {
  try {
    return await readFile(path)
  } catch {
    return null
  }
}

/** Snapshot metadata for a wiki page write completed by ingest write helpers. */
export interface IngestWrittenPageRecord {
  path: string
  wasCreated: boolean
  previousContent: string | null
}

export function buildPageMerger(llmConfig: LlmConfig): MergeFn {
  return async (existingContent, incomingContent, sourceFileName, signal) => {
    const systemPrompt = [
      "You are merging two versions of the same wiki page into one coherent document.",
      "Both versions describe the same entity / concept; one is already on disk,",
      "the other was just generated from a different source document.",
      "",
      "Output ONE merged version that:",
      "- Preserves every factual claim from both versions (do not drop content)",
      "- Eliminates redundancy when both versions state the same fact",
      "- Reorganizes sections so the structure is logical for the merged topic,",
      "  not just a concatenation of the two inputs",
      "- Uses consistent markdown structure (headings, tables, lists, callouts)",
      "- Keeps `[[wikilink]]` references intact",
      "",
      "Output requirements:",
      "- The FIRST character of your response MUST be `-` (the opening of `---`)",
      "- Output the COMPLETE file: YAML frontmatter + body",
      "- No preamble (no \"Here is the merged version:\"), no analysis prose",
      "- The caller will overwrite `sources`/`tags`/`related`/`updated` with",
      "  deterministic values — your job is the body and any other fields",
    ].join("\n")

    const userMessage = [
      `## Existing version on disk`,
      "",
      existingContent,
      "",
      "---",
      "",
      `## Newly generated version (from ${sourceFileName})`,
      "",
      incomingContent,
      "",
      "---",
      "",
      "Now output the merged file. Start with `---` on the first line.",
    ].join("\n")

    let result = ""
    let streamError: Error | null = null
    await new Promise<void>((resolve) => {
      streamChatRouted(
        "ingest",
        llmConfig,
        [
          { role: "system", content: systemPrompt },
          { role: "user", content: userMessage },
        ],
        {
          onToken: (token) => {
            result += token
          },
          onDone: () => resolve(),
          onError: (err) => {
            streamError = err
            resolve()
          },
        },
        signal,
        { temperature: 0.1 },
        `ingest:${sourceFileName}:merge`,
      ).catch((err) => {
        // Defensive: streamChat returns a Promise<void>; if it rejects
        // (instead of going through onError), surface that too.
        streamError = err instanceof Error ? err : new Error(String(err))
        resolve()
      })
    })
    if (streamError) throw streamError
    return result
  }
}

/**
 * Best-effort snapshot of a page before a fallback merge overwrites
 * it. Saved to `.llm-wiki/page-history/<sanitized-path>-<timestamp>.md`
 * so a user who later notices content lost in a merge can recover it.
 * Errors are swallowed by the caller (page-merge's tryBackup).
 */
export async function backupExistingPage(
  projectPath: string,
  relativePath: string,
  existingContent: string,
): Promise<void> {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-")
  const sanitized = relativePath.replace(/[/\\]/g, "_")
  const backupPath = `${projectPath}/.llm-wiki/page-history/${sanitized}-${stamp}`
  await writeFile(backupPath, existingContent)
}

/**
 * Append (or replace) the embedded-images section on the source-
 * summary page. Idempotent — paired marker comments bracket our
 * injection, so re-running this for the same source either:
 *   - replaces an existing injection in-place (image set changed), or
 *   - leaves an existing injection untouched (image set unchanged).
 *
 * Falls back to creating a minimal source-summary stub if the
 * page doesn't exist yet (covers the cache-hit path where the
 * original LLM-written page may have been deleted by the user but
 * extracted images are still salvageable, and the rare case where
 * the LLM wrote the source page under a slightly-different slug
 * that didn't match `${sourceBaseName}.md`).
 */
export async function injectImagesIntoSourceSummary(
  pp: string,
  sourceIdentity: string,
  sourceSummarySlug: string,
  savedImages: { relPath: string; page: number | null; sha256?: string }[],
  onPageWritten?: (record: IngestWrittenPageRecord) => void,
): Promise<boolean> {
  if (savedImages.length === 0) return false
  const sourceSummaryPath = `wiki/sources/${sourceSummarySlug}.md`
  const sourceSummaryFullPath = `${pp}/${sourceSummaryPath}`
  console.log(`[ingest:diag] injectImagesIntoSourceSummary: target=${sourceSummaryFullPath}, images=${savedImages.length}`)
  try {
    const existing = await tryReadFile(sourceSummaryFullPath)
    console.log(`[ingest:diag] injectImagesIntoSourceSummary: existing file ${existing !== null ? `read OK (${existing.length} chars)` : "MISSING (will write stub)"}`)
    // Load captions from the on-disk cache so the safety-net
    // section embeds caption text as alt — the embedding pipeline
    // indexes whatever's in the wiki page, so without this, search
    // by image content (e.g. "find the chart with revenue data")
    // never matches because alt text was empty.
    const captionsBySha = await loadCaptionCache(pp)
    const newSection = buildImageMarkdownSection(savedImages as never, captionsBySha)
    const marker = "<!-- llm-wiki:embedded-images -->"
    const wrapped = `\n\n${marker}\n${newSection.trim()}\n${marker}\n`
    if (existing !== null) {
      // Strip any prior injection (paired markers) so re-ingest
      // doesn't accumulate stale references when images change.
      const stripped = existing.replace(
        new RegExp(`\\n*${marker}[\\s\\S]*?${marker}\\n*`, "g"),
        "",
      )
      await writeFile(sourceSummaryFullPath, stripped.trimEnd() + wrapped)
    } else {
      // Page is missing — write a minimal stub so the user actually
      // sees the images in the file tree. Without this fallback, the
      // images sit in wiki/media/<slug>/ with no .md page referencing
      // them, which means the lint view's orphan-page sweep eventually
      // reaps the media directory (cascadeDeleteWikiPage triggered by
      // a missing source page) — silent loss of extracted images.
      const date = new Date().toISOString().slice(0, 10)
      const stubFrontmatter = [
        "---",
        "type: source",
        `title: "Source: ${sourceIdentity}"`,
        `created: ${date}`,
        `updated: ${date}`,
        `sources: ["${sourceIdentity}"]`,
        "tags: []",
        "related: []",
        "---",
        "",
        `# Source: ${sourceIdentity}`,
        "",
      ].join("\n")
      await writeFile(sourceSummaryFullPath, stubFrontmatter + wrapped)
    }
    onPageWritten?.({
      path: sourceSummaryPath,
      wasCreated: existing === null,
      previousContent: existing,
    })
    console.log(
      `[ingest:images] injected ${savedImages.length} image reference(s) into ${sourceSummaryPath}`,
    )
    return true
  } catch (err) {
    console.warn(
      `[ingest:images] failed to append images to ${sourceSummaryPath}:`,
      err instanceof Error ? err.message : err,
    )
    return false
  }
}

/**
 * Runtime job `kind` for the ingest pipeline's own throwaway anchor jobs
 * (SPEC-6 PR2, see `recordEmbeddingStaleMarker`). Distinct from
 * `DERIVED_REBUILD_JOB_KIND` — these jobs never carry rebuild work, they
 * exist only long enough to give a `runtime_event_append` call a valid
 * `job_id` FK, and are completed inline in the same async tick they're
 * created in.
 */
const INGEST_MARKER_EVENT_JOB_KIND = "auto-ingest-marker-event"
const INGEST_MARKER_EVENT_HOLDER = "auto-ingest"
const RUNTIME_DISABLED_ERROR_PREFIX = "runtime-disabled:"

function isRuntimeDisabledError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err)
  return message.startsWith(RUNTIME_DISABLED_ERROR_PREFIX)
}

/** Outcome of {@link recordEmbeddingStaleMarker} — see its doc comment for what each means to the caller. */
export type RecordEmbeddingStaleMarkerResult = "recorded" | "runtime-disabled" | "error"

/**
 * Records the `"embedding"` layer derived-stale marker for one written wiki
 * page (SPEC-6 PR2 decision 1). The traditional auto-ingest path has no
 * pre-existing runtime job/event to hang the marker's required
 * `sourceEventId` FK on — unlike the bulk-commit pipeline, which already
 * has one per staged artifact — so this mints a tiny throwaway
 * create → claim → event-append → complete anchor job purely to mint a
 * valid event id, then discards it.
 *
 * Non-throwing: the actual embedding rebuild normally happens later,
 * entirely off the ingest path, in the `embedding-consumer` job consumer
 * (`src/lib/derived-rebuild/embedding-consumer.ts`). But an explicit
 * disabled Work Runtime still means no marker was recorded and no consumer
 * will ever pick this page up, so a caller MUST treat `"runtime-disabled"`
 * as a signal to fall back to embedding inline itself (see `ingest.ts`'s
 * `legacyInlineEmbedPage` and `reembedSourceSummary` below). Any other
 * failure is logged and treated as best-effort
 * (matches the old inline call's own try/catch) — it does not trigger the
 * legacy fallback, since it's not the same intentional disabled-runtime
 * path.
 */
export async function recordEmbeddingStaleMarker(
  affectedPath: string,
  content: string,
): Promise<RecordEmbeddingStaleMarkerResult> {
  try {
    // SPEC-6 PR6: the anchor create -> claim -> event-append -> complete ->
    // record sequence lives in manual-rebuild-marker.ts's
    // `mintDerivedStaleMarkerAnchorEvent`, shared with `manual-rebuild.ts`
    // and the new embedding/taxonomy Rebuild buttons — see that file's doc
    // comment. Dynamically imported (like the rest of this function's
    // runtime-db access) to keep it out of the eagerly-loaded ingest path.
    const { mintDerivedStaleMarkerAnchorEvent } = await import(
      "@/lib/derived-rebuild/manual-rebuild-marker"
    )
    const { hashMarkdownContent } = await import("@/core-runtime/markdown-commit")

    const inputHash = await hashMarkdownContent(content)

    await mintDerivedStaleMarkerAnchorEvent({
      anchorKind: INGEST_MARKER_EVENT_JOB_KIND,
      holder: INGEST_MARKER_EVENT_HOLDER,
      claimMode: "by-kind",
      eventPayload: { kind: "auto-ingest", affectedPath },
      layer: "embedding",
      affectedPath,
      inputHash,
      baseVersion: inputHash,
      reason: "commit",
    })
    return "recorded"
  } catch (err) {
    if (isRuntimeDisabledError(err)) return "runtime-disabled"
    console.warn(
      `[ingest] Failed to record embedding stale marker for "${affectedPath}":`,
      err instanceof Error ? err.message : err,
    )
    return "error"
  }
}

/**
 * Marks the source-summary page's embedding stale after we've rewritten its
 * `## Embedded Images` safety-net section with captions. The full
 * autoIngest pipeline marks step-6-written pages stale unconditionally;
 * this is the cache-hit equivalent (where that step is skipped) and exists
 * specifically to keep the search index eventually in sync after a caption
 * refresh — the actual re-embedding normally happens later in the
 * embedding-consumer job (SPEC-6 PR2).
 *
 * Falls back to the pre-PR2 inline `embedPage` call when Work Runtime is
 * explicitly disabled — see `recordEmbeddingStaleMarker`'s doc comment for
 * why that fallback is mandatory, not optional.
 */
export async function reembedSourceSummary(
  pp: string,
  sourceIdentity: string,
  sourceSummarySlug: string,
): Promise<void> {
  const embCfg = useWikiStore.getState().embeddingConfig
  if (!embCfg.enabled || !embCfg.model) return
  const affectedPath = `wiki/sources/${sourceSummarySlug}.md`
  const sourceSummaryFullPath = `${pp}/${affectedPath}`
  try {
    const content = await readFile(sourceSummaryFullPath)
    const status = await recordEmbeddingStaleMarker(affectedPath, content)
    if (status === "runtime-disabled") {
      const { embedPage } = await import("@/lib/embedding")
      const { wikiPathToVectorPageId, extractPageTitle } = await import("@/lib/wiki-page-identity")
      const title = extractPageTitle(content, sourceIdentity)
      await embedPage(pp, wikiPathToVectorPageId(pp, affectedPath), title, content, embCfg)
      console.log(`[ingest:caption] re-embedded ${sourceSummarySlug} with captioned alt text (runtime disabled, legacy inline fallback)`)
    } else {
      console.log(`[ingest:caption] marked ${sourceSummarySlug} embedding stale after caption refresh`)
    }
  } catch (err) {
    console.warn(
      `[ingest:caption] re-embed failed for ${sourceSummarySlug}:`,
      err instanceof Error ? err.message : err,
    )
  }
}
