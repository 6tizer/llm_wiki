import { describe, it, expect, vi, beforeEach } from "vitest"
import type { LintResult } from "@/lib/lint"
import type { LlmConfig } from "@/stores/wiki-store"

/**
 * Correctness BLOCK follow-up to SPEC-11 D6 bug1: classifyFixability() in
 * lint.ts was fixed to route orphan results to humanItems (never
 * autoFixItems), but isFixable() in lint-fixer.ts -- the gate the UI's
 * single-item "Auto Fix" button uses (lint-view.tsx handleAutoFix, via
 * `hasUsableLlm(llmConfig) && isFixable(item)`) -- still returned `true`
 * for orphan. That meant an orphan lint card rendered both the confirmed
 * "Delete" button (handleDeleteOrphan, window.confirm-gated) *and* an
 * unconfirmed "Auto Fix" button whose click handler calls
 * fixLintResult -> fixOrphan -> cascadeDeleteWikiPagesWithRefs with zero
 * confirmation.
 *
 * These tests assert isFixable(orphan) is false (so the Auto Fix button
 * never renders for orphan items, matching classifyFixability), that the
 * other lint types are unaffected, and that the exact gating expression
 * lint-view.tsx evaluates for onAutoFix stays falsy for orphan even when
 * the user has a fully usable LLM configured.
 */
vi.mock("@/lib/wiki-page-delete", () => ({
  cascadeDeleteWikiPagesWithRefs: vi.fn(),
}))

import { isFixable } from "@/lib/lint-fixer"
import { hasUsableLlm } from "@/lib/has-usable-llm"
import { cascadeDeleteWikiPagesWithRefs } from "@/lib/wiki-page-delete"

const mockCascadeDelete = vi.mocked(cascadeDeleteWikiPagesWithRefs)

function orphanResult(): LintResult {
  return {
    type: "orphan",
    severity: "warning",
    page: "orphan.md",
    detail: "No pages link to orphan.md",
  }
}

function usableLlmConfig(): LlmConfig {
  return {
    provider: "openai",
    apiKey: "key",
    model: "gpt-4o",
    ollamaUrl: "",
    customEndpoint: "",
    maxContextSize: 128000,
  }
}

beforeEach(() => {
  mockCascadeDelete.mockReset()
})

describe("isFixable", () => {
  it("returns false for orphan (must only be removable via confirmed Delete)", () => {
    expect(isFixable(orphanResult())).toBe(false)
  })

  it("returns true for broken-link", () => {
    expect(
      isFixable({
        type: "broken-link",
        severity: "warning",
        page: "a.md",
        detail: "links to missing page",
      }),
    ).toBe(true)
  })

  it("returns true for no-outlinks", () => {
    expect(
      isFixable({
        type: "no-outlinks",
        severity: "info",
        page: "a.md",
        detail: "has no outbound links",
      }),
    ).toBe(true)
  })

  it("returns true for non-suggestion semantic issues", () => {
    expect(
      isFixable({
        type: "semantic",
        severity: "warning",
        page: "a.md",
        detail: "[contradiction] conflicts with b.md",
      }),
    ).toBe(true)
  })

  it("returns false for [suggestion] semantic issues (too vague to auto-fix)", () => {
    expect(
      isFixable({
        type: "semantic",
        severity: "info",
        page: "a.md",
        detail: "[suggestion] consider adding a diagram",
      }),
    ).toBe(false)
  })
})

describe("lint-view.tsx onAutoFix gate for orphan (correctness BLOCK regression)", () => {
  it("stays falsy for orphan even with a fully usable LLM config, so the single-item Auto Fix button is never wired to handleAutoFix", () => {
    const llmConfig = usableLlmConfig()
    const item = orphanResult()

    // This is the exact expression lint-view.tsx evaluates to decide
    // whether onAutoFix={handleAutoFix} gets passed to LintCard.
    const autoFixButtonWired = hasUsableLlm(llmConfig) && isFixable(item)

    expect(hasUsableLlm(llmConfig)).toBe(true)
    expect(autoFixButtonWired).toBe(false)
  })

  it("never reaches cascadeDeleteWikiPagesWithRefs for an orphan when only items passing isFixable are auto-fixed", async () => {
    const items = [orphanResult()]
    const fixableItems = items.filter(isFixable)

    expect(fixableItems).toHaveLength(0)
    expect(mockCascadeDelete).not.toHaveBeenCalled()
  })
})
