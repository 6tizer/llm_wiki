import { describe, expect, it } from "vitest"
import {
  BULK_KNOWLEDGE_PREPARE_JOB_KIND,
  canonicalizeBulkKnowledgeSourcePath,
  planBulkKnowledgePrepare,
} from "./batch-planner"

describe("planBulkKnowledgePrepare", () => {
  it("builds a stable plan independent of input order", () => {
    const first = planBulkKnowledgePrepare([
      { sourcePath: "raw/sources/b.md" },
      { sourcePath: "raw/sources/a.md" },
      { sourcePath: "raw/sources/c.md" },
    ])
    const second = planBulkKnowledgePrepare([
      { sourcePath: "raw/sources/c.md" },
      { sourcePath: "raw/sources/b.md" },
      { sourcePath: "raw/sources/a.md" },
    ])

    expect(first).toEqual(second)
    expect(first.jobs[0]?.payload.sources.map((source) => source.sourcePath)).toEqual([
      "raw/sources/a.md",
      "raw/sources/b.md",
      "raw/sources/c.md",
    ])
    expect(first.jobs[0]?.payload).toMatchObject({
      planId: first.planId,
      batchIndex: 0,
      batchTotal: 1,
      sourceTotal: 3,
      uniqueSourceTotal: 3,
      duplicateSourceTotal: 0,
    })
  })

  it("sorts mixed case and non-ASCII source identities without locale collation", () => {
    const plan = planBulkKnowledgePrepare([
      { sourcePath: "raw/sources/中文.md" },
      { sourcePath: "raw/sources/a.md" },
      { sourcePath: "raw/sources/B.md" },
      { sourcePath: "raw/sources/é.md" },
    ])

    expect(plan.jobs[0]?.payload.sources.map((source) => source.sourcePath)).toEqual([
      "raw/sources/B.md",
      "raw/sources/a.md",
      "raw/sources/é.md",
      "raw/sources/中文.md",
    ])
  })

  it("dedupes canonical source paths and reports duplicate counts on the plan", () => {
    const plan = planBulkKnowledgePrepare([
      { sourcePath: " ./raw//sources/a.md " },
      { sourcePath: "raw/sources/a.md" },
      { sourcePath: "raw\\sources\\b.md" },
      { sourcePath: "raw/sources/b.md/" },
      { sourcePath: "raw/sources/b.md" },
    ])

    expect(plan.sourceCount).toBe(5)
    expect(plan.uniqueSourceCount).toBe(2)
    expect(plan.duplicateSourceCount).toBe(3)
    expect(plan.jobs[0]?.payload.sources).toEqual([
      {
        sourcePath: "raw/sources/a.md",
        sourceIdentity: "raw/sources/a.md",
        duplicateCount: 1,
      },
      {
        sourcePath: "raw/sources/b.md",
        sourceIdentity: "raw/sources/b.md",
        duplicateCount: 2,
      },
    ])
  })

  it("uses batches of 10 by default and preserves remainder batches", () => {
    const plan = planBulkKnowledgePrepare(makeSources(23))

    expect(plan.batchSize).toBe(10)
    expect(plan.jobs.map((job) => job.sourceCount)).toEqual([10, 10, 3])
    expect(plan.jobs.map((job) => job.batchIndex)).toEqual([0, 1, 2])
  })

  it("supports custom batch sizing", () => {
    const plan = planBulkKnowledgePrepare(makeSources(7), { batchSize: 3 })

    expect(plan.batchSize).toBe(3)
    expect(plan.jobs.map((job) => job.sourceCount)).toEqual([3, 3, 1])
  })

  it("derives plan ids from normalized source identities and batch size", () => {
    const first = planBulkKnowledgePrepare([
      { sourcePath: "./raw//sources/b.md" },
      { sourcePath: "raw/sources/a.md" },
      { sourcePath: "raw/sources/a.md/" },
    ], { batchSize: 2 })
    const second = planBulkKnowledgePrepare([
      { sourcePath: "raw\\sources\\a.md" },
      { sourcePath: "raw/sources/b.md" },
    ], { batchSize: 2 })
    const differentBatchSize = planBulkKnowledgePrepare([
      { sourcePath: "raw/sources/a.md" },
      { sourcePath: "raw/sources/b.md" },
    ], { batchSize: 1 })

    expect(second.planId).toBe(first.planId)
    expect(second.jobs.map((job) => job.jobKey)).toEqual(
      first.jobs.map((job) => job.jobKey),
    )
    expect(differentBatchSize.planId).not.toBe(first.planId)
  })

  it("handles empty and single-source inputs", () => {
    expect(planBulkKnowledgePrepare([])).toEqual({
      kind: "bulk-knowledge-prepare-plan",
      planId: "bulk-plan-485a67a1",
      batchSize: 10,
      sourceCount: 0,
      uniqueSourceCount: 0,
      duplicateSourceCount: 0,
      jobs: [],
    })

    const single = planBulkKnowledgePrepare([{ sourcePath: "raw/sources/solo.md" }])
    expect(single.jobs).toHaveLength(1)
    expect(single.jobs[0]).toMatchObject({
      kind: BULK_KNOWLEDGE_PREPARE_JOB_KIND,
      batchIndex: 0,
      sourceCount: 1,
    })
  })

  it("rejects empty paths and invalid batch sizes", () => {
    expect(() => canonicalizeBulkKnowledgeSourcePath(" ./ ")).toThrow(
      "bulk-knowledge-source-path-empty",
    )
    expect(() =>
      planBulkKnowledgePrepare([{ sourcePath: "raw/sources/a.md" }], {
        batchSize: 0,
      }),
    ).toThrow("bulk-knowledge-batch-size-invalid")
  })
})

function makeSources(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    sourcePath: `raw/sources/source-${String(index).padStart(2, "0")}.md`,
  }))
}
