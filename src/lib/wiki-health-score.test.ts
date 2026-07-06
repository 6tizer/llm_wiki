import { describe, expect, it } from "vitest"
import { computeWikiHealthScore } from "./wiki-health-score"
import type { DerivedLayerBuckets } from "@/lib/derived-rebuild/status"
import type { ReviewItem } from "@/stores/review-store"

function reviewItem(id: string, resolved = false): ReviewItem {
  return {
    id,
    type: "confirm",
    title: id,
    description: id,
    options: [],
    resolved,
    createdAt: 1,
  }
}

describe("computeWikiHealthScore", () => {
  it("uses generateLintReport as the lint sub-score and subtracts derived/review penalties", () => {
    const derivedBuckets: DerivedLayerBuckets = {
      embedding: { layer: "embedding", status: "dirty", stale: false, lastRebuiltAtMs: null },
      taxonomy: { layer: "taxonomy", status: "failed", stale: false, lastRebuiltAtMs: null },
      synthesis: { layer: "synthesis", status: "dirty", stale: true, lastRebuiltAtMs: null },
    }

    const result = computeWikiHealthScore({
      lintItems: [
        { type: "orphan", severity: "warning", page: "a.md", detail: "orphan" },
        { type: "broken-link", severity: "warning", page: "b.md", detail: "broken" },
      ],
      totalPages: 10,
      derivedBuckets,
      reviewItems: [reviewItem("pending-1"), reviewItem("pending-2"), reviewItem("done", true)],
    })

    expect(result.lintScore).toBe(92)
    expect(result.derivedPenalty).toBe(20)
    expect(result.reviewPenalty).toBe(2)
    expect(result.score).toBe(70)
  })

  it("caps review penalty at 20 and clamps the final score at zero", () => {
    const reviewItems = Array.from({ length: 30 }, (_, index) => reviewItem(`pending-${index}`))

    const result = computeWikiHealthScore({
      lintItems: Array.from({ length: 20 }, (_, index) => ({
        type: "semantic" as const,
        severity: "warning" as const,
        page: `${index}.md`,
        detail: "[contradiction] conflict",
      })),
      totalPages: 20,
      derivedBuckets: null,
      reviewItems,
    })

    expect(result.lintScore).toBe(0)
    expect(result.reviewPenalty).toBe(20)
    expect(result.score).toBe(0)
  })
})
