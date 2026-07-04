/**
 * Unit tests for SPEC-6 PR5's shared manual-rebuild mint-to-close loop.
 * Fake-runtime style (module-level `vi.mock`), same convention as
 * `embedding-consumer.test.ts`/`synthesis-staleness.test.ts`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest"
import { JOB_RUNTIME_DEFAULTS } from "@/core-runtime/contract"

const mocks = vi.hoisted(() => ({
  runtimeJobCreate: vi.fn(),
  runtimeJobClaim: vi.fn(),
  runtimeEventAppend: vi.fn(),
  runtimeJobComplete: vi.fn(),
  runtimeDerivedStaleMarkerRecord: vi.fn(),
  runtimeDerivedMarkerClaimBatch: vi.fn(),
  runtimeDerivedMarkerCompleteBatch: vi.fn(),
  runtimeJobFail: vi.fn(),
  runtimeDerivedMarkerReleaseBatch: vi.fn(),
  runtimeJobHeartbeat: vi.fn(),
}))

vi.mock("@/commands/runtime-db", () => ({
  runtimeJobCreate: mocks.runtimeJobCreate,
  runtimeJobClaim: mocks.runtimeJobClaim,
  runtimeEventAppend: mocks.runtimeEventAppend,
  runtimeJobComplete: mocks.runtimeJobComplete,
  runtimeDerivedStaleMarkerRecord: mocks.runtimeDerivedStaleMarkerRecord,
  runtimeDerivedMarkerClaimBatch: mocks.runtimeDerivedMarkerClaimBatch,
  runtimeDerivedMarkerCompleteBatch: mocks.runtimeDerivedMarkerCompleteBatch,
  runtimeJobFail: mocks.runtimeJobFail,
  runtimeDerivedMarkerReleaseBatch: mocks.runtimeDerivedMarkerReleaseBatch,
  runtimeJobHeartbeat: mocks.runtimeJobHeartbeat,
}))

import { runManualRebuild } from "./manual-rebuild"

/** Simulates the job-runtime handing back a lease for the exact requested jobId. */
function claimResultFor(jobId: string) {
  return {
    job: {
      jobId,
      kind: jobId.startsWith("anchor-") ? "manual-rebuild-marker-event" : "derived-rebuild",
      payload: "{}",
      state: "running" as const,
      attempt: 1,
      maxAttempts: 3,
      priority: 0,
      createdAtMs: 0,
      updatedAtMs: 0,
    },
    lease: {
      leaseId: `${jobId}-lease`,
      jobId,
      holder: "test-holder",
      acquiredAtMs: 0,
      heartbeatAtMs: 0,
      expiresAtMs: 0,
      status: "active",
    },
  }
}

/** Wires the full happy-path mint chain: fresh anchor id per call, fresh folded job id per call. */
function wireHappyMintChain(): void {
  let anchorSeq = 0
  let foldedSeq = 0
  mocks.runtimeJobCreate.mockImplementation(async () => {
    anchorSeq += 1
    return { jobId: `anchor-${anchorSeq}` }
  })
  mocks.runtimeJobClaim.mockImplementation(async (request: { jobId: string }) => claimResultFor(request.jobId))
  mocks.runtimeEventAppend.mockImplementation(async () => ({
    eventId: "event-1",
    jobId: "anchor-1",
    eventName: "appended",
    payload: "{}",
    createdAtMs: 0,
  }))
  mocks.runtimeJobComplete.mockResolvedValue({ jobId: "anchor-1", state: "completed" })
  mocks.runtimeDerivedStaleMarkerRecord.mockResolvedValue({ markerId: "marker-1" })
  mocks.runtimeDerivedMarkerClaimBatch.mockImplementation(async () => {
    foldedSeq += 1
    return {
      job: { jobId: `folded-${foldedSeq}` },
      markers: [{ markerId: `marker-${foldedSeq}` }],
    }
  })
  mocks.runtimeDerivedMarkerCompleteBatch.mockResolvedValue({ job: {}, markers: [] })
  mocks.runtimeJobHeartbeat.mockResolvedValue({ job: {}, lease: {} })
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe("runManualRebuild", () => {
  it("mints anchor job -> event -> marker -> folds a real job -> claims it -> runs execute -> completes the batch", async () => {
    wireHappyMintChain()

    const result = await runManualRebuild({
      layer: "index_export",
      affectedPath: "wiki/index.md",
      holder: "index-export-manual-rebuild",
      execute: async () => "generated",
    })

    expect(result).toEqual({ result: "generated", runtimeTracked: true })

    // Anchor job minted with a dedicated kind, NOT "derived-rebuild".
    expect(mocks.runtimeJobCreate).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "manual-rebuild-marker-event" }),
    )
    // Anchor claimed by its own id, then completed and discarded.
    expect(mocks.runtimeJobClaim).toHaveBeenCalledWith({ holder: "index-export-manual-rebuild", jobId: "anchor-1" })
    expect(mocks.runtimeEventAppend).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: "anchor-1" }),
    )
    expect(mocks.runtimeJobComplete).toHaveBeenCalledWith({ jobId: "anchor-1", leaseId: "anchor-1-lease" })

    // Marker recorded with reason manual_rebuild, backed by the anchor's event.
    expect(mocks.runtimeDerivedStaleMarkerRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        layer: "index_export",
        affectedPath: "wiki/index.md",
        reason: "manual_rebuild",
        sourceEventId: "event-1",
      }),
    )

    // claim_batch called with NO jobId (P0-1 lesson from synthesis-staleness.ts:
    // reusing the anchor's own id here would collide on INSERT), and with
    // maxAttempts: 1 (Codex gate P2 — see the file doc comment: neither
    // layer has a poller to ever recover a retry-wait job, so a single
    // failed attempt must go straight to terminal `failed`).
    expect(mocks.runtimeDerivedMarkerClaimBatch).toHaveBeenCalledWith({
      layer: "index_export",
      affectedPath: "wiki/index.md",
      maxAttempts: 1,
    })
    expect(mocks.runtimeDerivedMarkerClaimBatch.mock.calls[0][0]).not.toHaveProperty("jobId")

    // The folded (real) job is claimed by its exact server-returned id.
    expect(mocks.runtimeJobClaim).toHaveBeenCalledWith({ holder: "index-export-manual-rebuild", jobId: "folded-1" })

    expect(mocks.runtimeDerivedMarkerCompleteBatch).toHaveBeenCalledWith({
      jobId: "folded-1",
      leaseId: "folded-1-lease",
      markerIds: ["marker-1"],
    })
  })

  it("P0-1 sabotage regression lock: the SAME (layer, affectedPath) rebuilt twice in a row both succeed — a deterministic jobId would collide on the second claim_batch INSERT", async () => {
    wireHappyMintChain()

    const first = await runManualRebuild({
      layer: "index_export",
      affectedPath: "wiki/index.md",
      holder: "h",
      execute: async () => "first",
    })
    const second = await runManualRebuild({
      layer: "index_export",
      affectedPath: "wiki/index.md",
      holder: "h",
      execute: async () => "second",
    })

    expect(first.runtimeTracked).toBe(true)
    expect(second.runtimeTracked).toBe(true)
    // Every claim_batch call across BOTH invocations omitted jobId.
    for (const call of mocks.runtimeDerivedMarkerClaimBatch.mock.calls) {
      expect(call[0]).not.toHaveProperty("jobId")
    }
    // Two distinct folded job ids were actually claimed (not reused).
    const foldedJobIds = mocks.runtimeDerivedMarkerCompleteBatch.mock.calls.map((call) => call[0].jobId)
    expect(new Set(foldedJobIds).size).toBe(2)
  })

  it("runtime-disabled: bookkeeping is skipped silently and execute() still runs untracked, with NO downstream runtime-db call ever attempted", async () => {
    mocks.runtimeJobCreate.mockRejectedValue(new Error("runtime-disabled: work runtime is disabled"))
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
    let executed = false

    const result = await runManualRebuild({
      layer: "overview",
      affectedPath: "wiki/overview.md",
      holder: "h",
      execute: async () => {
        executed = true
        return "generated"
      },
    })

    expect(executed).toBe(true)
    expect(result).toEqual({ result: "generated", runtimeTracked: false })
    expect(warnSpy).not.toHaveBeenCalled()
    // Symmetric zero-call assertion (Tester gate P2): runtime-disabled fails
    // at the very first mint step, so NOTHING past it — not just
    // complete_batch — is ever attempted, including the fail/release/
    // heartbeat paths a later bug could wrongly wire up unconditionally.
    expect(mocks.runtimeEventAppend).not.toHaveBeenCalled()
    expect(mocks.runtimeDerivedStaleMarkerRecord).not.toHaveBeenCalled()
    expect(mocks.runtimeDerivedMarkerClaimBatch).not.toHaveBeenCalled()
    expect(mocks.runtimeDerivedMarkerCompleteBatch).not.toHaveBeenCalled()
    expect(mocks.runtimeJobFail).not.toHaveBeenCalled()
    expect(mocks.runtimeDerivedMarkerReleaseBatch).not.toHaveBeenCalled()
    expect(mocks.runtimeJobHeartbeat).not.toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it("a non-runtime-disabled bookkeeping error is logged but still falls back to running execute() untracked", async () => {
    mocks.runtimeJobCreate.mockRejectedValue(new Error("job-create-failed: db locked"))
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})

    const result = await runManualRebuild({
      layer: "overview",
      affectedPath: "wiki/overview.md",
      holder: "h",
      execute: async () => "generated",
    })

    expect(result).toEqual({ result: "generated", runtimeTracked: false })
    expect(warnSpy).toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it("a mid-chain failure at runtimeEventAppend (not just the first mint step) still falls back to untracked execute()", async () => {
    wireHappyMintChain()
    mocks.runtimeEventAppend.mockRejectedValueOnce(new Error("event-append-failed: db locked"))
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
    let executed = false

    const result = await runManualRebuild({
      layer: "overview",
      affectedPath: "wiki/overview.md",
      holder: "h",
      execute: async () => {
        executed = true
        return "generated"
      },
    })

    expect(executed).toBe(true)
    expect(result).toEqual({ result: "generated", runtimeTracked: false })
    expect(warnSpy).toHaveBeenCalled()
    // Chain aborted right after the failed event append — the anchor was
    // never completed, and nothing downstream (marker record, claim batch,
    // complete batch) was ever attempted.
    expect(mocks.runtimeJobComplete).not.toHaveBeenCalled()
    expect(mocks.runtimeDerivedStaleMarkerRecord).not.toHaveBeenCalled()
    expect(mocks.runtimeDerivedMarkerClaimBatch).not.toHaveBeenCalled()
    expect(mocks.runtimeDerivedMarkerCompleteBatch).not.toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it("a mid-chain failure at runtimeDerivedMarkerClaimBatch (the fold step, after the anchor job/event/marker already succeeded) still falls back to untracked execute()", async () => {
    wireHappyMintChain()
    mocks.runtimeDerivedMarkerClaimBatch.mockRejectedValueOnce(new Error("derived-marker-claim-empty: no pending markers"))
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
    let executed = false

    const result = await runManualRebuild({
      layer: "overview",
      affectedPath: "wiki/overview.md",
      holder: "h",
      execute: async () => {
        executed = true
        return "generated"
      },
    })

    expect(executed).toBe(true)
    expect(result).toEqual({ result: "generated", runtimeTracked: false })
    expect(warnSpy).toHaveBeenCalled()
    // The anchor job WAS completed (chain got that far) — but no real
    // rebuild job was ever folded/claimed, so no complete_batch either.
    expect(mocks.runtimeJobComplete).toHaveBeenCalledTimes(1)
    expect(mocks.runtimeDerivedMarkerCompleteBatch).not.toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it("execute() throwing fails the job (carrying the original error) and rethrows to the caller", async () => {
    wireHappyMintChain()
    mocks.runtimeJobFail.mockResolvedValue({ jobId: "folded-1", state: "retry-wait" })

    await expect(
      runManualRebuild({
        layer: "index_export",
        affectedPath: "wiki/index.md",
        holder: "h",
        execute: async () => {
          throw new Error("scan failed")
        },
      }),
    ).rejects.toThrow("scan failed")

    expect(mocks.runtimeJobFail).toHaveBeenCalledWith({
      jobId: "folded-1",
      leaseId: "folded-1-lease",
      error: "scan failed",
    })
    // retry-wait is non-terminal: markers stay claimed under the same job, no release call.
    expect(mocks.runtimeDerivedMarkerReleaseBatch).not.toHaveBeenCalled()
    expect(mocks.runtimeDerivedMarkerCompleteBatch).not.toHaveBeenCalled()
  })

  it("execute() throwing, and the job reaching terminal 'failed', releases the claimed markers to 'failed' too", async () => {
    wireHappyMintChain()
    mocks.runtimeJobFail.mockResolvedValue({ jobId: "folded-1", state: "failed" })

    await expect(
      runManualRebuild({
        layer: "index_export",
        affectedPath: "wiki/index.md",
        holder: "h",
        execute: async () => {
          throw new Error("scan failed")
        },
      }),
    ).rejects.toThrow("scan failed")

    expect(mocks.runtimeDerivedMarkerReleaseBatch).toHaveBeenCalledWith({
      jobId: "folded-1",
      markerIds: ["marker-1"],
      targetStatus: "failed",
      error: "scan failed",
    })
  })

  it("a complete_batch failure after a successful execute() is logged but does not turn a successful rebuild into a caller-visible failure", async () => {
    wireHappyMintChain()
    mocks.runtimeDerivedMarkerCompleteBatch.mockRejectedValueOnce(new Error("transient"))
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})

    const result = await runManualRebuild({
      layer: "index_export",
      affectedPath: "wiki/index.md",
      holder: "h",
      execute: async () => "generated",
    })

    expect(result).toEqual({ result: "generated", runtimeTracked: true })
    expect(warnSpy).toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it("Codex gate P1: heartbeats the folded job's lease while a long-running execute() outlives multiple heartbeat intervals, and still completes the batch once execute() resolves", async () => {
    vi.useFakeTimers()
    try {
      wireHappyMintChain()

      let resolveExecute: (value: string) => void = () => {}
      const executeGate = new Promise<string>((resolve) => {
        resolveExecute = resolve
      })

      const runPromise = runManualRebuild({
        layer: "index_export",
        affectedPath: "wiki/index.md",
        holder: "h",
        execute: () => executeGate,
      })

      // Flush the mint chain's own microtask awaits (job create -> claim ->
      // event append -> complete -> marker record -> claim batch -> claim)
      // so `startHeartbeat` is armed and `execute()` has actually been
      // invoked before advancing the fake clock.
      await vi.advanceTimersByTimeAsync(0)

      // Advance past three heartbeat intervals while execute() is STILL
      // pending — this is exactly the "overview LLM call outlives the
      // lease TTL" scenario the fix addresses.
      await vi.advanceTimersByTimeAsync(JOB_RUNTIME_DEFAULTS.heartbeatMinIntervalMs * 3)

      expect(mocks.runtimeJobHeartbeat).toHaveBeenCalledWith({ jobId: "folded-1", leaseId: "folded-1-lease" })
      expect(mocks.runtimeJobHeartbeat.mock.calls.length).toBeGreaterThanOrEqual(3)
      // The lease is still being kept alive — complete_batch hasn't run yet.
      expect(mocks.runtimeDerivedMarkerCompleteBatch).not.toHaveBeenCalled()

      resolveExecute("generated")
      const result = await runPromise

      expect(result).toEqual({ result: "generated", runtimeTracked: true })
      expect(mocks.runtimeDerivedMarkerCompleteBatch).toHaveBeenCalledWith({
        jobId: "folded-1",
        leaseId: "folded-1-lease",
        markerIds: ["marker-1"],
      })
    } finally {
      vi.useRealTimers()
    }
  })
})
