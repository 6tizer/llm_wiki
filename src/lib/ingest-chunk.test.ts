import { describe, expect, it } from "vitest"
import { buildChunkAnalysisSystemPrompt } from "./ingest-chunk"
import { splitSourceIntoSemanticChunks as splitFromIngestChunk } from "./ingest-chunk"
import { splitSourceIntoSemanticChunks as splitFromIngest } from "./ingest"

describe("buildChunkAnalysisSystemPrompt", () => {
  it("omits root index context when normal ingest passes no existing wiki context", () => {
    const prompt = buildChunkAnalysisSystemPrompt("purpose", "schema", "", "source text")

    expect(prompt).not.toContain("## Current Wiki Index")
    expect(prompt).not.toContain("wiki/index.md")
  })

  it("keeps optional existing wiki context available for future context providers", () => {
    const prompt = buildChunkAnalysisSystemPrompt("purpose", "schema", "Existing page: [[attention]]", "source text")

    expect(prompt).toContain("## Current Wiki Index")
    expect(prompt).toContain("[[attention]]")
  })

  it("keeps chunk helper exports stable after core extraction", () => {
    const content = [
      "# One",
      "A".repeat(1_100),
      "## Two",
      "B".repeat(1_100),
    ].join("\n\n")

    expect(splitFromIngestChunk(content, 1_000, 120)).toEqual(
      splitFromIngest(content, 1_000, 120),
    )
  })
})
