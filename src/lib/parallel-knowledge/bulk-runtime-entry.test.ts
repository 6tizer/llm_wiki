import { describe, expect, it, vi } from "vitest"
import {
  enqueueBulkKnowledgePrepareJobs,
  type BulkKnowledgePrepareRuntimeAdapter,
} from "./bulk-runtime-entry"
import type { RuntimeJobCreateRequest, RuntimeJobRecord } from "@/commands/runtime-db"

describe("enqueueBulkKnowledgePrepareJobs", () => {
  it("creates one runtime job per planned batch with string payload", async () => {
    const createJob = vi.fn(async (request: RuntimeJobCreateRequest) =>
      runtimeJob(request.jobId ?? "generated", request.kind, request.payload),
    )

    const result = await enqueueBulkKnowledgePrepareJobs(makeSources(11), {
      runtime: { createJob },
    })

    expect(result.plan.jobs).toHaveLength(2)
    expect(result.enqueuedJobs).toHaveLength(2)
    expect(createJob).toHaveBeenCalledTimes(2)
    const first = createJob.mock.calls[0]?.[0]
    expect(first?.kind).toBe("bulk-knowledge-prepare")
    expect(first?.maxAttempts).toBe(3)
    expect(typeof first?.payload).toBe("string")
    expect(JSON.parse(first?.payload ?? "{}")).toMatchObject({
      kind: "bulk-knowledge-prepare",
      planId: result.plan.planId,
      batchIndex: 0,
      batchTotal: 2,
      sourceTotal: 11,
      uniqueSourceTotal: 11,
      duplicateSourceTotal: 0,
    })
  })

  it("uses deterministic plan and job ids for the same source set and batch size", async () => {
    const first = await enqueueBulkKnowledgePrepareJobs([
      { sourcePath: "raw/b.md" },
      { sourcePath: "raw/a.md" },
    ], { runtime: fakeRuntime() })
    const second = await enqueueBulkKnowledgePrepareJobs([
      { sourcePath: "raw/a.md" },
      { sourcePath: "raw/b.md" },
    ], { runtime: fakeRuntime() })

    expect(second.plan.planId).toBe(first.plan.planId)
    expect(second.plan.jobs.map((job) => job.jobKey)).toEqual(
      first.plan.jobs.map((job) => job.jobKey),
    )
  })

  it("treats duplicate runtime jobs as idempotent skips", async () => {
    const runtime = fakeRuntime({
      createJob: async (request) => {
        throw new Error(`runtime job already exists: ${request.jobId}`)
      },
    })

    const result = await enqueueBulkKnowledgePrepareJobs(makeSources(2), { runtime })

    expect(result.enqueuedJobs).toEqual([])
    expect(result.skippedDuplicateJobIds).toEqual([result.plan.jobs[0]?.jobKey])
    expect(result.failedJobs).toEqual([])
  })

  it("reports non-duplicate create failures without hiding successful jobs", async () => {
    const createJob = vi.fn(async (request: RuntimeJobCreateRequest) => {
      if (request.jobId?.endsWith("-2")) {
        throw new Error("runtime db unavailable")
      }
      return runtimeJob(request.jobId ?? "generated", request.kind, request.payload)
    })

    const result = await enqueueBulkKnowledgePrepareJobs(makeSources(11), {
      runtime: { createJob },
    })

    expect(result.enqueuedJobs).toHaveLength(1)
    expect(result.failedJobs).toEqual([
      { jobId: result.plan.jobs[1]?.jobKey, message: "runtime db unavailable" },
    ])
  })
})

function fakeRuntime(
  overrides: Partial<BulkKnowledgePrepareRuntimeAdapter> = {},
): BulkKnowledgePrepareRuntimeAdapter {
  return {
    createJob: async (request) =>
      runtimeJob(request.jobId ?? "generated", request.kind, request.payload),
    ...overrides,
  }
}

function runtimeJob(jobId: string, kind: string, payload: string): RuntimeJobRecord {
  return {
    jobId,
    kind,
    payload,
    state: "queued",
    attempt: 0,
    maxAttempts: 3,
    priority: 0,
    createdAtMs: 1,
    updatedAtMs: 1,
  }
}

function makeSources(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    sourcePath: `raw/source-${String(index).padStart(2, "0")}.md`,
  }))
}
