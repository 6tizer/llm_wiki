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

  it("classifies mixed missing-page candidates by their local type labels", () => {
    const drafts = createReviewPageDrafts(
      review({
        title: "Missing pages",
        description: "entities: CallMethod, StartFunc; concepts: Policy version gap",
      }),
      "Create Page",
    )

    expect(drafts).toEqual([
      { title: "CallMethod", pageType: "entity", dir: "entities" },
      { title: "StartFunc", pageType: "entity", dir: "entities" },
      { title: "Policy version gap", pageType: "concept", dir: "concepts" },
    ])
  })

  it("applies a segment page type label to candidates without local labels", () => {
    const drafts = createReviewPageDrafts(
      review({
        title: "Missing pages",
        description: "Missing entity pages: CallMethod, StartFunc",
      }),
      "Create Page",
    )

    expect(drafts).toEqual([
      { title: "CallMethod", pageType: "entity", dir: "entities" },
      { title: "StartFunc", pageType: "entity", dir: "entities" },
    ])
  })

  it("falls back to the review-level page type when no candidate type label exists", () => {
    const drafts = createReviewPageDrafts(
      review({
        title: "Missing pages",
        description: "Missing pages: Policy version gap, Runtime checklist",
      }),
      "Create Page",
    )

    expect(drafts).toEqual([
      { title: "Policy version gap", pageType: "concept", dir: "concepts" },
      { title: "Runtime checklist", pageType: "concept", dir: "concepts" },
    ])
  })

  it("keeps the first classification when duplicate missing-page candidates repeat", () => {
    const drafts = createReviewPageDrafts(
      review({
        title: "Missing pages",
        description: "entities: Runtime; concepts: Runtime",
      }),
      "Create Page",
    )

    expect(drafts).toEqual([
      { title: "Runtime", pageType: "entity", dir: "entities" },
    ])
  })

  it("preserves title words that look like page type labels without an explicit label separator", () => {
    const drafts = createReviewPageDrafts(
      review({
        title: "Missing pages",
        description: "concepts:Concept drift; entities:Entity resolution",
      }),
      "Create Page",
    )

    expect(drafts).toEqual([
      { title: "Concept drift", pageType: "concept", dir: "concepts" },
      { title: "Entity resolution", pageType: "entity", dir: "entities" },
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

  it("does not strip page-type words from non-missing review titles", () => {
    const drafts = createReviewPageDrafts(
      review({
        type: "suggestion",
        title: "Query optimization",
        description: "Review query planning notes.",
      }),
      "Create Page",
    )

    expect(drafts).toEqual([
      { title: "Query optimization", pageType: "query", dir: "queries" },
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
