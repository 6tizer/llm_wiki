import { fetchEmbedding } from "@/lib/embedding"
import type { EmbeddingConfig } from "@/stores/wiki-store"
import type { EntitySummary } from "./dedup"

export const DEDUP_PREFILTER_MIN_SUMMARIES = 8
export const DEDUP_PREFILTER_SMALL_WIKI_FULL_SCAN_LIMIT = 40
export const DEDUP_PREFILTER_COSINE_THRESHOLD = 0.82
export const DEDUP_PREFILTER_MAX_NEIGHBORS_PER_PAGE = 8
export const DEDUP_PREFILTER_MAX_CANDIDATES = 80

export interface DedupEmbeddingPrefilterResult {
  summaries: EntitySummary[]
  usedEmbedding: boolean
  fallbackReason?: "embedding-disabled" | "too-small" | "embedding-failed" | "small-wiki-empty"
}

/**
 * Use embedding similarity as a cheap candidate prefilter before the
 * expensive LLM duplicate detector. The LLM still performs the final
 * decision, and not-duplicates are still filtered after detection.
 */
export async function prefilterDedupCandidates(
  summaries: EntitySummary[],
  cfg: EmbeddingConfig,
  signal?: AbortSignal,
): Promise<DedupEmbeddingPrefilterResult> {
  if (!cfg.enabled || !cfg.endpoint || !cfg.model) {
    return { summaries, usedEmbedding: false, fallbackReason: "embedding-disabled" }
  }
  if (summaries.length < DEDUP_PREFILTER_MIN_SUMMARIES) {
    return { summaries, usedEmbedding: false, fallbackReason: "too-small" }
  }

  const embedded: Array<{ summary: EntitySummary; embedding: number[] }> = []
  for (const summary of summaries) {
    throwIfAborted(signal)
    const embedding = await fetchEmbedding(summaryToEmbeddingText(summary), cfg, undefined, { signal })
    throwIfAborted(signal)
    if (embedding) embedded.push({ summary, embedding })
  }

  if (embedded.length < 2) {
    return {
      summaries: summaries.length <= DEDUP_PREFILTER_SMALL_WIKI_FULL_SCAN_LIMIT ? summaries : [],
      usedEmbedding: false,
      fallbackReason: "embedding-failed",
    }
  }

  const pairs: Array<{ score: number; left: EntitySummary; right: EntitySummary }> = []
  const perSlugCounts = new Map<string, number>()
  for (let i = 0; i < embedded.length; i++) {
    for (let j = i + 1; j < embedded.length; j++) {
      const score = cosineSimilarity(embedded[i].embedding, embedded[j].embedding)
      if (score < DEDUP_PREFILTER_COSINE_THRESHOLD) continue
      pairs.push({ score, left: embedded[i].summary, right: embedded[j].summary })
    }
  }

  pairs.sort((a, b) => b.score - a.score)
  const selected = new Map<string, EntitySummary>()
  for (const pair of pairs) {
    if (selected.size >= DEDUP_PREFILTER_MAX_CANDIDATES) break
    const leftCount = perSlugCounts.get(pair.left.slug) ?? 0
    const rightCount = perSlugCounts.get(pair.right.slug) ?? 0
    if (
      leftCount >= DEDUP_PREFILTER_MAX_NEIGHBORS_PER_PAGE ||
      rightCount >= DEDUP_PREFILTER_MAX_NEIGHBORS_PER_PAGE
    ) {
      continue
    }
    selected.set(pair.left.slug, pair.left)
    selected.set(pair.right.slug, pair.right)
    perSlugCounts.set(pair.left.slug, leftCount + 1)
    perSlugCounts.set(pair.right.slug, rightCount + 1)
  }

  const candidates = [...selected.values()]
  if (candidates.length < 2 && summaries.length <= DEDUP_PREFILTER_SMALL_WIKI_FULL_SCAN_LIMIT) {
    return { summaries, usedEmbedding: true, fallbackReason: "small-wiki-empty" }
  }
  return { summaries: candidates, usedEmbedding: true }
}

function summaryToEmbeddingText(summary: EntitySummary): string {
  return [
    `type=${summary.type}`,
    `slug=${summary.slug}`,
    `title=${summary.title}`,
    summary.tags.length > 0 ? `tags=${summary.tags.join(", ")}` : "",
    summary.description ?? "",
  ].filter(Boolean).join("\n")
}

function cosineSimilarity(a: number[], b: number[]): number {
  const len = Math.min(a.length, b.length)
  if (len === 0) return 0
  let dot = 0
  let normA = 0
  let normB = 0
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }
  if (normA === 0 || normB === 0) return 0
  return dot / (Math.sqrt(normA) * Math.sqrt(normB))
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return
  throw signal.reason instanceof Error ? signal.reason : new Error("Duplicate scan aborted")
}
