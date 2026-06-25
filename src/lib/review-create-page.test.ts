import { describe, expect, it } from "vitest"
import type { ReviewItem } from "@/stores/review-store"
import {
  createReviewPageDrafts,
  reviewPageDestinationDir,
  type ReviewPageDraft,
} from "./review-create-page"

function review(overrides: Partial<ReviewItem>): ReviewItem {
  return {
    id: "review-1",
    type: "missing-page",
    title: "Missing page",
    description: "",
    options: [],
    resolved: false,
    createdAt: 0,
    ...overrides,
  }
}

describe("createReviewPageDrafts", () => {
  it("creates one entity page per missing entity named in Chinese review text", () => {
    const drafts = createReviewPageDrafts(
      review({
        title: "核心测试项实体页缺失：CallMethod、StartFunc、Print",
        description: "缺少 CallMethod、StartFunc、Print 等实体页面。",
      }),
      "Create Page",
    )

    expect(drafts).toEqual([
      { title: "CallMethod", pageType: "entity", dir: "entities" },
      { title: "StartFunc", pageType: "entity", dir: "entities" },
      { title: "Print", pageType: "entity", dir: "entities" },
    ])
  })

  it("keeps non-missing review creation as a single query page", () => {
    const drafts = createReviewPageDrafts(
      review({
        type: "suggestion",
        title: "Create: Policy version gap",
        description: "Review the policy changes.",
      }),
      "Create Page",
    )

    expect(drafts).toEqual([
      { title: "Policy version gap", pageType: "query", dir: "queries" },
    ])
  })
})

describe("reviewPageDestinationDir", () => {
  it("routes page types through schema directories when available", () => {
    const draft: ReviewPageDraft = {
      title: "Ada Lovelace",
      pageType: "entity",
      dir: "entities",
    }

    expect(
      reviewPageDestinationDir(draft, {
        typeDirs: { entity: "wiki/people" },
      }),
    ).toBe("people")
  })

  it("falls back to draft dir when schema has no route for the page type", () => {
    const draft: ReviewPageDraft = {
      title: "Policy gap",
      pageType: "query",
      dir: "queries",
    }

    expect(
      reviewPageDestinationDir(draft, {
        typeDirs: { entity: "wiki/people" },
      }),
    ).toBe("queries")
  })

  it("supports schema routes to the wiki root", () => {
    const draft: ReviewPageDraft = {
      title: "Home",
      pageType: "query",
      dir: "queries",
    }

    expect(
      reviewPageDestinationDir(draft, {
        typeDirs: { query: "wiki" },
      }),
    ).toBe("")
  })
})
