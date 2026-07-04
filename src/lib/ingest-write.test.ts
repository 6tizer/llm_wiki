/**
 * Unit tests for the SPEC-6 PR2 embedding-marker-recording helpers added to
 * ingest-write.ts: `recordEmbeddingStaleMarker` (the throwaway
 * create → claim → event-append → complete anchor-job dance that mints a
 * valid `sourceEventId` for the traditional ingest path, which has no
 * pre-existing runtime job/event unlike the bulk-commit pipeline) and
 * `reembedSourceSummary` (the cache-hit caption-refresh equivalent).
 */
import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  readFile: vi.fn(),
  runtimeJobCreate: vi.fn(),
  runtimeJobClaimByKind: vi.fn(),
  runtimeJobComplete: vi.fn(),
  runtimeEventAppend: vi.fn(),
  runtimeDerivedStaleMarkerRecord: vi.fn(),
  embedPage: vi.fn(),
}))

vi.mock("@/commands/fs", () => ({
  readFile: mocks.readFile,
  writeFile: vi.fn(),
}))

vi.mock("@/commands/runtime-db", () => ({
  runtimeJobCreate: mocks.runtimeJobCreate,
  runtimeJobClaimByKind: mocks.runtimeJobClaimByKind,
  runtimeJobComplete: mocks.runtimeJobComplete,
  runtimeEventAppend: mocks.runtimeEventAppend,
  runtimeDerivedStaleMarkerRecord: mocks.runtimeDerivedStaleMarkerRecord,
}))

vi.mock("@/lib/embedding", () => ({
  embedPage: mocks.embedPage,
}))

import { recordEmbeddingStaleMarker, reembedSourceSummary } from "./ingest-write"
import { useWikiStore } from "@/stores/wiki-store"
import { wikiPathToVectorPageId } from "@/lib/wiki-page-identity"

const RUNTIME_DISABLED_ERROR = "runtime-disabled: work runtime is disabled"

function defaultClaim() {
  return {
    job: { jobId: "job-1", kind: "auto-ingest-marker-event", payload: "{}", state: "running", attempt: 1, maxAttempts: 1, priority: 0, createdAtMs: 0, updatedAtMs: 0 },
    lease: { leaseId: "lease-1", jobId: "job-1", holder: "auto-ingest", acquiredAtMs: 0, heartbeatAtMs: 0, expiresAtMs: 0, status: "active" },
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.runtimeJobCreate.mockResolvedValue({ jobId: "job-1" })
  mocks.runtimeJobClaimByKind.mockResolvedValue(defaultClaim())
  mocks.runtimeJobComplete.mockResolvedValue({ jobId: "job-1" })
  mocks.runtimeEventAppend.mockResolvedValue({ eventId: "event-1", jobId: "job-1", eventName: "job-runtime:event-appended", payload: "{}", createdAtMs: 0 })
  mocks.runtimeDerivedStaleMarkerRecord.mockResolvedValue({
    markerId: "marker-1",
    layer: "embedding",
    affectedPath: "wiki/foo.md",
    baseVersion: "abc",
    markedAtMs: 0,
    reason: "commit",
    sourceEventId: "event-1",
    status: "pending",
    updatedAtMs: 0,
  })
  mocks.embedPage.mockResolvedValue({ indexed: 1, failed: 0 })
  useWikiStore.setState({
    embeddingConfig: { enabled: true, endpoint: "http://x", apiKey: "", model: "m" },
  })
})

describe("recordEmbeddingStaleMarker", () => {
  it("mints a throwaway anchor job to get a sourceEventId, then records the marker", async () => {
    await recordEmbeddingStaleMarker("wiki/foo.md", "# Foo\n\nbody")

    expect(mocks.runtimeJobCreate).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "auto-ingest-marker-event" }),
    )
    expect(mocks.runtimeJobClaimByKind).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "auto-ingest-marker-event" }),
    )
    expect(mocks.runtimeEventAppend).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: "job-1" }),
    )
    expect(mocks.runtimeJobComplete).toHaveBeenCalledWith({ jobId: "job-1", leaseId: "lease-1" })

    expect(mocks.runtimeDerivedStaleMarkerRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        layer: "embedding",
        affectedPath: "wiki/foo.md",
        reason: "commit",
        sourceEventId: "event-1",
      }),
    )
    const call = mocks.runtimeDerivedStaleMarkerRecord.mock.calls[0][0]
    expect(call.inputHash).toBeTruthy()
    expect(call.baseVersion).toBe(call.inputHash)
  })

  it("completes the anchor job before recording the marker (event id available first)", async () => {
    const order: string[] = []
    mocks.runtimeEventAppend.mockImplementation(async () => {
      order.push("event")
      return { eventId: "event-1", jobId: "job-1", eventName: "job-runtime:event-appended", payload: "{}", createdAtMs: 0 }
    })
    mocks.runtimeDerivedStaleMarkerRecord.mockImplementation(async () => {
      order.push("marker")
      return {
        markerId: "marker-1",
        layer: "embedding",
        affectedPath: "wiki/foo.md",
        baseVersion: "abc",
        markedAtMs: 0,
        reason: "commit",
        sourceEventId: "event-1",
        status: "pending",
        updatedAtMs: 0,
      }
    })

    await recordEmbeddingStaleMarker("wiki/foo.md", "body")

    expect(order).toEqual(["event", "marker"])
  })

  it("resolves 'recorded' on success", async () => {
    await expect(recordEmbeddingStaleMarker("wiki/foo.md", "body")).resolves.toBe("recorded")
  })

  it("resolves 'runtime-disabled' (and swallows it silently, no console.warn) when the Work Runtime kill-switch is off", async () => {
    mocks.runtimeJobCreate.mockRejectedValueOnce(new Error(RUNTIME_DISABLED_ERROR))
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})

    await expect(recordEmbeddingStaleMarker("wiki/foo.md", "body")).resolves.toBe("runtime-disabled")

    expect(warnSpy).not.toHaveBeenCalled()
    expect(mocks.runtimeDerivedStaleMarkerRecord).not.toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it("resolves 'error' and logs (but does not throw) on any other failure", async () => {
    mocks.runtimeDerivedStaleMarkerRecord.mockRejectedValueOnce(new Error("boom"))
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})

    await expect(recordEmbeddingStaleMarker("wiki/foo.md", "body")).resolves.toBe("error")

    expect(warnSpy).toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  describe("Tester item 9 — anchor job dance mid-step failures", () => {
    it("resolves 'error' (not throw) when runtimeJobClaimByKind rejects", async () => {
      mocks.runtimeJobClaimByKind.mockRejectedValueOnce(new Error("claim boom"))
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})

      await expect(recordEmbeddingStaleMarker("wiki/foo.md", "body")).resolves.toBe("error")

      expect(warnSpy).toHaveBeenCalled()
      expect(mocks.runtimeEventAppend).not.toHaveBeenCalled()
      expect(mocks.runtimeJobComplete).not.toHaveBeenCalled()
      expect(mocks.runtimeDerivedStaleMarkerRecord).not.toHaveBeenCalled()
      warnSpy.mockRestore()
    })

    it("resolves 'error' (not throw) when runtimeEventAppend rejects", async () => {
      mocks.runtimeEventAppend.mockRejectedValueOnce(new Error("event boom"))
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})

      await expect(recordEmbeddingStaleMarker("wiki/foo.md", "body")).resolves.toBe("error")

      expect(warnSpy).toHaveBeenCalled()
      expect(mocks.runtimeJobComplete).not.toHaveBeenCalled()
      expect(mocks.runtimeDerivedStaleMarkerRecord).not.toHaveBeenCalled()
      warnSpy.mockRestore()
    })

    it("resolves 'error' (not throw) when runtimeJobComplete rejects", async () => {
      mocks.runtimeJobComplete.mockRejectedValueOnce(new Error("complete boom"))
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})

      await expect(recordEmbeddingStaleMarker("wiki/foo.md", "body")).resolves.toBe("error")

      expect(warnSpy).toHaveBeenCalled()
      // The anchor job never got marked complete, but the marker record
      // call already had its sourceEventId by this point — current
      // behavior does NOT attempt it once the anchor job's own dance
      // fails, since the whole anchor+marker sequence lives in one try.
      expect(mocks.runtimeDerivedStaleMarkerRecord).not.toHaveBeenCalled()
      warnSpy.mockRestore()
    })
  })
})

describe("reembedSourceSummary", () => {
  it("reads the source-summary page and records its embedding marker", async () => {
    mocks.readFile.mockResolvedValue("---\ntitle: My Source\n---\n\nbody")

    await reembedSourceSummary("/proj", "My Source", "my-source")

    expect(mocks.readFile).toHaveBeenCalledWith("/proj/wiki/sources/my-source.md")
    expect(mocks.runtimeDerivedStaleMarkerRecord).toHaveBeenCalledWith(
      expect.objectContaining({ affectedPath: "wiki/sources/my-source.md" }),
    )
  })

  it("no-ops when embedding is disabled", async () => {
    useWikiStore.setState({
      embeddingConfig: { enabled: false, endpoint: "", apiKey: "", model: "" },
    })

    await reembedSourceSummary("/proj", "My Source", "my-source")

    expect(mocks.readFile).not.toHaveBeenCalled()
    expect(mocks.runtimeDerivedStaleMarkerRecord).not.toHaveBeenCalled()
  })

  it("logs but does not throw when the source-summary file can't be read", async () => {
    mocks.readFile.mockRejectedValueOnce(new Error("ENOENT"))
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})

    await expect(reembedSourceSummary("/proj", "My Source", "my-source")).resolves.toBeUndefined()

    expect(warnSpy).toHaveBeenCalled()
    expect(mocks.runtimeDerivedStaleMarkerRecord).not.toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it("P0 regression guard: falls back to the legacy inline embedPage call when the Work Runtime kill-switch is off", async () => {
    mocks.readFile.mockResolvedValue("---\ntitle: My Source\n---\n\nbody")
    mocks.runtimeJobCreate.mockRejectedValueOnce(new Error(RUNTIME_DISABLED_ERROR))

    await reembedSourceSummary("/proj", "My Source", "my-source")

    expect(mocks.runtimeDerivedStaleMarkerRecord).not.toHaveBeenCalled()
    expect(mocks.embedPage).toHaveBeenCalledWith(
      "/proj",
      wikiPathToVectorPageId("/proj", "wiki/sources/my-source.md"),
      "My Source",
      "---\ntitle: My Source\n---\n\nbody",
      expect.objectContaining({ enabled: true }),
    )
  })
})
