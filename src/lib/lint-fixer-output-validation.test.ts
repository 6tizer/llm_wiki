import { describe, it, expect, beforeEach, vi } from "vitest"
import type { LlmConfig } from "@/stores/wiki-store"

/**
 * SPEC-11 D6 bug2 (integration): fixBrokenLink, fixNoOutlinks and
 * applyLlmFix (the shared writer for fixContradiction/fixStale/
 * fixMissingPage/fixGenericSemantic) used to gate the LLM's full-page
 * rewrite on nothing but `!raw.trim()` before overwriting the page on
 * disk. A truncated stream or a short refusal would sail through. These
 * tests inject empty / truncated / garbage LLM responses at each of the
 * three write sites and assert the original file survives untouched and
 * the fix reports failure.
 */
vi.mock("@/lib/wiki-page-delete", () => ({
  cascadeDeleteWikiPagesWithRefs: vi.fn(),
}))

const { getMockResponse, setMockResponse } = vi.hoisted(() => {
  let response = ""
  return {
    getMockResponse: () => response,
    setMockResponse: (r: string) => {
      response = r
    },
  }
})

vi.mock("@/lib/llm-client", () => ({
  streamChat: vi.fn(async (_cfg, _messages, cb) => {
    const resp = getMockResponse()
    if (resp) cb.onToken(resp)
    cb.onDone()
  }),
}))

const files: Record<string, string> = {}

vi.mock("@/commands/fs", () => ({
  readFile: vi.fn(async (p: string) => {
    if (p in files) return files[p]
    throw new Error(`ENOENT: ${p}`)
  }),
  writeFile: vi.fn(async (p: string, content: string) => {
    files[p] = content
  }),
  listDirectory: vi.fn(async () => []),
}))

import { fixLintResult } from "./lint-fixer"
import { useActivityStore } from "@/stores/activity-store"
import type { LintResult } from "./lint"

const fakeLlmConfig: LlmConfig = {
  provider: "openai",
  apiKey: "test-key",
  model: "test-model",
  maxContextSize: 128000,
  ollamaUrl: "",
  customEndpoint: "",
}

const BROKEN_LINK_PAGE =
  "---\ntype: concept\ntitle: Test\n---\n\nThis page links to [[nonexistent]] which does not exist yet, among a good deal of other body text so the reference length is realistic."
const NO_OUTLINKS_PAGE =
  "---\ntype: concept\ntitle: Test\n---\n\nThis page has no links out to anywhere else in the wiki, just plain descriptive prose that goes on for a little while."

beforeEach(() => {
  setMockResponse("")
  useActivityStore.setState({ items: [] })
  for (const key of Object.keys(files)) delete files[key]
  files["/project/wiki/concepts/test.md"] = BROKEN_LINK_PAGE
})

describe("fixBrokenLink — rejects invalid LLM output before overwriting (bug2)", () => {
  const result: LintResult = {
    type: "broken-link",
    severity: "warning",
    page: "concepts/test.md",
    detail: "Broken link: [[nonexistent]] — target page not found.",
  }

  it("rejects an empty response and leaves the page untouched", async () => {
    setMockResponse("")
    const ok = await fixLintResult("/project", result, fakeLlmConfig)
    expect(ok).toBe(false)
    expect(files["/project/wiki/concepts/test.md"]).toBe(BROKEN_LINK_PAGE)
  })

  it("rejects a truncated response (no closing frontmatter) and leaves the page untouched", async () => {
    setMockResponse("---\ntype: concept\ntitle: Test\nthis got cut off mid-stream")
    const ok = await fixLintResult("/project", result, fakeLlmConfig)
    expect(ok).toBe(false)
    expect(files["/project/wiki/concepts/test.md"]).toBe(BROKEN_LINK_PAGE)
  })

  it("rejects garbage with no frontmatter and leaves the page untouched", async () => {
    setMockResponse("sorry, I can't help with that request")
    const ok = await fixLintResult("/project", result, fakeLlmConfig)
    expect(ok).toBe(false)
    expect(files["/project/wiki/concepts/test.md"]).toBe(BROKEN_LINK_PAGE)
  })

  it("accepts a well-formed, appropriately-sized rewrite", async () => {
    setMockResponse(
      "---\ntype: concept\ntitle: Test\n---\n\nThis page no longer links anywhere broken, but still has a good amount of descriptive body text to look genuine.",
    )
    const ok = await fixLintResult("/project", result, fakeLlmConfig)
    expect(ok).toBe(true)
    expect(files["/project/wiki/concepts/test.md"]).not.toBe(BROKEN_LINK_PAGE)
  })
})

describe("fixNoOutlinks — rejects invalid LLM output before overwriting (bug2)", () => {
  const result: LintResult = {
    type: "no-outlinks",
    severity: "info",
    page: "concepts/test.md",
    detail: "This page has no [[wikilink]] references to other pages.",
  }

  beforeEach(() => {
    files["/project/wiki/concepts/test.md"] = NO_OUTLINKS_PAGE
  })

  it("rejects an empty response and leaves the page untouched", async () => {
    setMockResponse("")
    const ok = await fixLintResult("/project", result, fakeLlmConfig)
    expect(ok).toBe(false)
    expect(files["/project/wiki/concepts/test.md"]).toBe(NO_OUTLINKS_PAGE)
  })

  it("rejects a truncated response and leaves the page untouched", async () => {
    setMockResponse("---\ntype: concept\ntitle: Test\nno closing fence")
    const ok = await fixLintResult("/project", result, fakeLlmConfig)
    expect(ok).toBe(false)
    expect(files["/project/wiki/concepts/test.md"]).toBe(NO_OUTLINKS_PAGE)
  })
})

describe("applyLlmFix (via fixSemantic) — rejects invalid FILE blocks before overwriting (bug2)", () => {
  const result: LintResult = {
    type: "semantic",
    severity: "warning",
    page: "concepts/test.md",
    detail: "[stale] The claims on this page appear outdated relative to current knowledge.",
    affectedPages: ["concepts/test.md"],
  }

  beforeEach(() => {
    files["/project/wiki/concepts/test.md"] = BROKEN_LINK_PAGE
  })

  it("rejects a FILE block with truncated content and leaves the page untouched", async () => {
    setMockResponse(
      "---FILE: concepts/test.md---\n---\ntype: concept\ntitle: Test\nthis never closes\n---END FILE---",
    )
    const ok = await fixLintResult("/project", result, fakeLlmConfig)
    expect(ok).toBe(false)
    expect(files["/project/wiki/concepts/test.md"]).toBe(BROKEN_LINK_PAGE)
  })

  it("rejects a FILE block with garbage content and leaves the page untouched", async () => {
    setMockResponse(
      "---FILE: concepts/test.md---\nnope, not a wiki page, just noise\n---END FILE---",
    )
    const ok = await fixLintResult("/project", result, fakeLlmConfig)
    expect(ok).toBe(false)
    expect(files["/project/wiki/concepts/test.md"]).toBe(BROKEN_LINK_PAGE)
  })

  it("rejects a FILE block that is implausibly short relative to the original page", async () => {
    setMockResponse("---FILE: concepts/test.md---\n---\ntype: concept\n---\nhi\n---END FILE---")
    const ok = await fixLintResult("/project", result, fakeLlmConfig)
    expect(ok).toBe(false)
    expect(files["/project/wiki/concepts/test.md"]).toBe(BROKEN_LINK_PAGE)
  })

  it("accepts a well-formed FILE block sized comparably to the original", async () => {
    setMockResponse(
      "---FILE: concepts/test.md---\n---\ntype: concept\ntitle: Test\n---\n\nUpdated content that reflects current knowledge, with enough body text to look like a genuine rewrite rather than a stub.\n---END FILE---",
    )
    const ok = await fixLintResult("/project", result, fakeLlmConfig)
    expect(ok).toBe(true)
    expect(files["/project/wiki/concepts/test.md"]).not.toBe(BROKEN_LINK_PAGE)
  })

  // Regression: originalPages is keyed by the bare page path (e.g.
  // "concepts/test.md"), but LLMs frequently echo back the `wiki/`-prefixed
  // form in FILE blocks even though the prompt asks for a bare path. The
  // lookup used to key strictly on `block.path`/`stripped`, both of which
  // still carry the `wiki/` prefix here, so it missed and fell back to
  // `block.content` as its own reference -- turning the length-ratio check
  // into a self-comparison that only rejects outputs under ~30 chars,
  // regardless of how drastically the page shrank.
  it("rejects a wiki/-prefixed FILE path whose content is truncated relative to the real original", async () => {
    setMockResponse(
      "---FILE: wiki/concepts/test.md---\n---\ntype: concept\ntitle: Test\n---\nShort update.\n---END FILE---",
    )
    const ok = await fixLintResult("/project", result, fakeLlmConfig)
    expect(ok).toBe(false)
    expect(files["/project/wiki/concepts/test.md"]).toBe(BROKEN_LINK_PAGE)
  })

  it("accepts a wiki/-prefixed FILE path when the rewrite is comparably sized to the original", async () => {
    setMockResponse(
      "---FILE: wiki/concepts/test.md---\n---\ntype: concept\ntitle: Test\n---\n\nUpdated content that reflects current knowledge, with enough body text to look like a genuine rewrite rather than a stub.\n---END FILE---",
    )
    const ok = await fixLintResult("/project", result, fakeLlmConfig)
    expect(ok).toBe(true)
    expect(files["/project/wiki/concepts/test.md"]).not.toBe(BROKEN_LINK_PAGE)
  })
})
