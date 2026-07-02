import { describe, expect, it } from "vitest"
import {
  BULK_KNOWLEDGE_MAP_REDUCE_REPAIR_JOB_KIND,
  planLongDocumentMapReduce,
  reduceLongDocumentMapResults,
} from "./long-document-map-reduce"

function longContent(): string {
  return [
    "# Chapter One",
    "A".repeat(1_100),
    "## Section Two",
    "B".repeat(1_100),
    "## Section Three",
    "C".repeat(1_100),
    "## Section Four",
    "D".repeat(1_100),
  ].join("\n\n")
}

describe("long-document map-reduce core", () => {
  it("plans semantic chunks deterministically", () => {
    const input = {
      sourcePath: "docs/source.md",
      content: longContent(),
      sourceBudget: 8_000,
      targetChars: 1_000,
      overlapChars: 120,
    }

    const first = planLongDocumentMapReduce(input)
    const second = planLongDocumentMapReduce(input)

    expect(first).toEqual(second)
    expect(first.kind).toBe("bulk-knowledge-long-document-map-reduce-plan")
    expect(first.chunked).toBe(true)
    expect(first.chunks.length).toBeGreaterThan(1)
    expect(first.chunks.map((chunk) => chunk.id)).toEqual(
      first.chunks.map((_, index) => `chunk-${index + 1}`),
    )
    expect(first.chunks.some((chunk) => chunk.headingPath.includes("Section Two"))).toBe(true)
  })

  it("reduces complete map results into a committable draft", () => {
    const plan = planLongDocumentMapReduce({
      sourcePath: "docs/source.md",
      content: longContent(),
      sourceBudget: 8_000,
      targetChars: 1_000,
      overlapChars: 120,
    })

    const reduced = reduceLongDocumentMapResults(
      plan,
      plan.chunks.map((chunk) => ({
        chunkId: chunk.id,
        status: "success" as const,
        analysis: `Analysis for ${chunk.id}`,
        digest: `Digest for ${chunk.id}`,
      })),
    )

    expect(reduced.status).toBe("complete")
    expect(reduced.commitPolicy).toBe("committable")
    expect(reduced.successfulChunkCount).toBe(plan.chunks.length)
    expect(reduced.repairJobs).toEqual([])
    expect(reduced.analysisMarkdown).toContain("Analysis for chunk-1")
  })

  it("reduces failed, low-confidence, and missing chunks into repair-only output", () => {
    const plan = planLongDocumentMapReduce({
      sourcePath: "docs/source.md",
      sourceIdentity: "docs/source.md",
      content: "# sk-heading-secret\n\n" + longContent(),
      sourceBudget: 8_000,
      targetChars: 1_000,
      overlapChars: 120,
    })
    const secretLikeError = "provider-error: sk-test-secret should not be persisted"

    const reduced = reduceLongDocumentMapResults(
      plan,
      [
        {
          chunkId: plan.chunks[0].id,
          status: "success",
          analysis: "Safe analysis",
          digest: "Safe digest",
        },
        {
          chunkId: plan.chunks[1].id,
          status: "low-confidence",
          error: secretLikeError,
        },
        {
          chunkId: plan.chunks[2].id,
          status: "failed",
          error: "map-timeout: source text should stay out",
        },
      ],
      { jobId: "job-1", sourceJobKind: "bulk-knowledge-prepare" },
    )

    expect(reduced.status).toBe("partial")
    expect(reduced.commitPolicy).toBe("repair-only")
    expect(reduced.successfulChunkCount).toBe(1)
    expect(reduced.lowConfidenceChunkCount).toBe(1)
    expect(reduced.failedChunkCount).toBe(1)
    expect(reduced.missingChunkCount).toBe(plan.chunks.length - 3)
    expect(reduced.repairJobs).toHaveLength(plan.chunks.length - 1)
    expect(reduced.repairJobs[0]).toMatchObject({
      kind: BULK_KNOWLEDGE_MAP_REDUCE_REPAIR_JOB_KIND,
      jobId: "job-1",
      sourceJobKind: "bulk-knowledge-prepare",
      sourcePath: "docs/source.md",
      chunkId: plan.chunks[1].id,
      status: "low-confidence",
      error: "provider-error",
      owner: "bulk-map-reduce",
      strategy: "reanalyze-chunk",
    })

    const serialized = JSON.stringify(reduced.repairJobs)
    expect(reduced.repairJobs[0].headingPath).toBe("")
    expect(serialized).not.toContain("sk-test-secret")
    expect(serialized).not.toContain("sk-heading-secret")
    expect(serialized).not.toContain("source text should stay out")
    expect(serialized).not.toContain(plan.chunks[1].main)
    expect(serialized).not.toContain("Safe analysis")
  })

  it("does not persist secret-like repair error prefixes", () => {
    const plan = planLongDocumentMapReduce({
      sourcePath: "docs/source.md",
      sourceIdentity: "docs/source.md",
      content: longContent(),
      sourceBudget: 8_000,
      targetChars: 1_000,
      overlapChars: 120,
    })

    const reduced = reduceLongDocumentMapResults(plan, [
      {
        chunkId: plan.chunks[0].id,
        status: "failed",
        error: "sk-test-secret: provider error",
      },
      {
        chunkId: plan.chunks[1].id,
        status: "failed",
        error: "unknown-provider-code: provider error",
      },
    ])

    expect(reduced.repairJobs[0].error).toBe("map-chunk-failed")
    expect(reduced.repairJobs[1].error).toBe("map-chunk-failed")
    expect(reduced.repairJobs[0].headingPath).toBe("")
    expect(JSON.stringify(reduced.repairJobs)).not.toContain("sk-test-secret")
  })

  it("marks all-missing map results as failed", () => {
    const plan = planLongDocumentMapReduce({
      sourcePath: "docs/source.md",
      content: longContent(),
      sourceBudget: 8_000,
      targetChars: 1_000,
      overlapChars: 120,
    })

    const reduced = reduceLongDocumentMapResults(plan, [])

    expect(reduced.status).toBe("failed")
    expect(reduced.commitPolicy).toBe("repair-only")
    expect(reduced.successfulChunkCount).toBe(0)
    expect(reduced.missingChunkCount).toBe(plan.chunks.length)
    expect(reduced.analysisMarkdown).toContain("No chunk analysis succeeded")
  })

  it("rejects duplicate map results", () => {
    const plan = planLongDocumentMapReduce({
      sourcePath: "docs/source.md",
      content: longContent(),
      sourceBudget: 8_000,
      targetChars: 1_000,
      overlapChars: 120,
    })

    expect(() =>
      reduceLongDocumentMapResults(plan, [
        { chunkId: plan.chunks[0].id, status: "success", analysis: "one" },
        { chunkId: plan.chunks[0].id, status: "success", analysis: "two" },
      ]),
    ).toThrow("long-document-map-result-duplicate")
  })
})
