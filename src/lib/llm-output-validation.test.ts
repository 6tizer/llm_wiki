import { describe, it, expect } from "vitest"
import { validateLlmPageOutput } from "./llm-output-validation"

const VALID_PAGE =
  "---\ntype: concept\ntitle: Foo\n---\n\nA reasonably long body paragraph describing the concept in enough detail to look like a genuine page."

describe("validateLlmPageOutput (SPEC-11 D6 bug2)", () => {
  it("accepts a well-formed full-page rewrite similar in size to the reference", () => {
    const result = validateLlmPageOutput(VALID_PAGE, VALID_PAGE)
    expect(result.ok).toBe(true)
  })

  it("rejects an empty response", () => {
    const result = validateLlmPageOutput("", VALID_PAGE)
    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(/empty/i)
  })

  it("rejects a whitespace-only response", () => {
    const result = validateLlmPageOutput("   \n\t  ", VALID_PAGE)
    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(/empty/i)
  })

  it("rejects a truncated response with no closing frontmatter fence", () => {
    const truncated = "---\ntype: concept\ntitle: Foo\nEverything cuts off here"
    const result = validateLlmPageOutput(truncated, VALID_PAGE)
    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(/frontmatter/i)
  })

  it("rejects garbage with no frontmatter at all", () => {
    const garbage = "asdkjhasdkjh this is not a wiki page at all, just noise"
    const result = validateLlmPageOutput(garbage, VALID_PAGE)
    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(/frontmatter/i)
  })

  it("rejects output that is implausibly short relative to the reference", () => {
    const reference = VALID_PAGE.repeat(5)
    const tinyButValidFrontmatter = "---\ntype: concept\ntitle: X\n---\n\nHi."
    const result = validateLlmPageOutput(tinyButValidFrontmatter, reference)
    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(/short/i)
  })

  it("does not penalize length when the reference is the output itself (new-page case)", () => {
    // fixMissingPage has no prior content to compare against; callers pass
    // the block's own content as the reference to skip the ratio check
    // while still enforcing the absolute floor.
    const newPage = "---\ntype: concept\ntitle: New\n---\n\nBrand new page body."
    const result = validateLlmPageOutput(newPage, newPage)
    expect(result.ok).toBe(true)
  })

  it("still enforces the absolute floor even when self-referential", () => {
    const tiny = "---\na: 1\n---\nhi"
    const result = validateLlmPageOutput(tiny, tiny)
    expect(result.ok).toBe(false)
  })
})
