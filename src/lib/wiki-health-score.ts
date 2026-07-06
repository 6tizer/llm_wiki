import { VISIBLE_DERIVED_LAYERS, type DerivedLayerBuckets } from "@/lib/derived-rebuild/status"
import { generateLintReport, type LintResult } from "@/lib/lint"
import type { ReviewItem } from "@/stores/review-store"

/** Inputs used to derive the Wiki Health dashboard score. */
export interface WikiHealthScoreInput {
  lintItems: LintResult[]
  totalPages: number
  derivedBuckets: DerivedLayerBuckets | null
  reviewItems: ReviewItem[]
}

/** Score breakdown rendered by the Wiki Health dashboard. */
export interface WikiHealthScore {
  score: number
  lintScore: number
  derivedPenalty: number
  reviewPenalty: number
  pendingReviewCount: number
}

function clampHealthScore(score: number): number {
  return Math.max(0, Math.min(100, score))
}

/**
 * Compute the Wiki Health dashboard score from lint, derived-layer, and review state.
 */
export function computeWikiHealthScore(input: WikiHealthScoreInput): WikiHealthScore {
  const lintScore = generateLintReport(input.lintItems, input.totalPages).healthScore
  const derivedPenalty = VISIBLE_DERIVED_LAYERS.reduce((penalty, layer) => {
    const bucket = input.derivedBuckets?.[layer]
    if (!bucket) return penalty
    if (bucket.status === "failed") return penalty + 10
    if (bucket.status === "dirty" || bucket.stale) return penalty + 5
    return penalty
  }, 0)
  const pendingReviewCount = input.reviewItems.filter((item) => !item.resolved).length
  const reviewPenalty = Math.min(pendingReviewCount, 20)

  return {
    score: clampHealthScore(lintScore - derivedPenalty - reviewPenalty),
    lintScore,
    derivedPenalty,
    reviewPenalty,
    pendingReviewCount,
  }
}
