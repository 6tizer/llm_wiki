import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  runtimeDerivedStaleMarkerList,
  runtimeDerivedStaleMarkerRecord,
  runtimeCommitBudgetClaim,
  runtimeCommitBudgetRelease,
  runtimeEventAppend,
  runtimeJobCancel,
  runtimeJobList,
  runtimeJobPause,
  runtimeJobResume,
  runtimeStagingArtifactCommitSuccess,
} from "./runtime-db"

const tauriMocks = vi.hoisted(() => ({
  invoke: vi.fn(),
}))

vi.mock("@tauri-apps/api/core", () => tauriMocks)

describe("runtime-db commands", () => {
  beforeEach(() => {
    tauriMocks.invoke.mockReset()
  })

  it("lists runtime jobs with the pure list command", async () => {
    const response = { enabled: true, status: "healthy", jobs: [], leases: [] }
    tauriMocks.invoke.mockResolvedValue(response)

    await expect(runtimeJobList()).resolves.toBe(response)

    expect(tauriMocks.invoke).toHaveBeenCalledWith("runtime_job_list")
  })

  it("sends cancel, pause, and resume request payloads by job id only", async () => {
    const cancelResponse = { jobId: "job-1" }
    const pauseResponse = { jobId: "job-2" }
    const resumeResponse = { jobId: "job-3" }
    tauriMocks.invoke
      .mockResolvedValueOnce(cancelResponse)
      .mockResolvedValueOnce(pauseResponse)
      .mockResolvedValueOnce(resumeResponse)

    await expect(runtimeJobCancel("job-1")).resolves.toBe(cancelResponse)
    await expect(runtimeJobPause("job-2")).resolves.toBe(pauseResponse)
    await expect(runtimeJobResume("job-3")).resolves.toBe(resumeResponse)

    expect(tauriMocks.invoke).toHaveBeenNthCalledWith(1, "runtime_job_cancel", {
      request: { jobId: "job-1" },
    })
    expect(tauriMocks.invoke).toHaveBeenNthCalledWith(2, "runtime_job_pause", {
      request: { jobId: "job-2" },
    })
    expect(tauriMocks.invoke).toHaveBeenNthCalledWith(3, "runtime_job_resume", {
      request: { jobId: "job-3" },
    })
  })

  it("sends commit budget claim payloads with Rust serde camelCase fields", async () => {
    tauriMocks.invoke.mockResolvedValue({ claimId: "claim-1" })

    await runtimeCommitBudgetClaim({
      affectedPath: "wiki/Page.md",
      holder: "tester:1",
      jobId: "job-1",
      claimId: "claim-1",
      ttlMs: 120000,
    })

    expect(tauriMocks.invoke).toHaveBeenCalledWith("runtime_commit_budget_claim", {
      request: {
        affectedPath: "wiki/Page.md",
        holder: "tester:1",
        jobId: "job-1",
        claimId: "claim-1",
        ttlMs: 120000,
      },
    })
  })

  it("sends minimal commit budget claim payloads without optional fields", async () => {
    const response = {
      claimId: "claim-1",
      resourceKey: "wiki/page.md",
      displayKey: "wiki/Page.md",
      expiresAtMs: 123,
      claims: [],
    }
    tauriMocks.invoke.mockResolvedValue(response)

    await expect(
      runtimeCommitBudgetClaim({
        affectedPath: "wiki/Page.md",
        holder: "tester:1",
      }),
    ).resolves.toBe(response)

    expect(tauriMocks.invoke).toHaveBeenCalledWith("runtime_commit_budget_claim", {
      request: {
        affectedPath: "wiki/Page.md",
        holder: "tester:1",
      },
    })
  })

  it("propagates commit budget claim failures", async () => {
    tauriMocks.invoke.mockRejectedValue(new Error("claim failed"))

    await expect(
      runtimeCommitBudgetClaim({
        affectedPath: "wiki/Page.md",
        holder: "tester:1",
      }),
    ).rejects.toThrow("claim failed")
  })

  it("sends commit budget release payloads", async () => {
    const response = [{ claimId: "claim-1" }]
    tauriMocks.invoke.mockResolvedValue(response)

    await expect(runtimeCommitBudgetRelease("claim-1")).resolves.toBe(response)

    expect(tauriMocks.invoke).toHaveBeenCalledWith("runtime_commit_budget_release", {
      request: { claimId: "claim-1" },
    })
  })

  it("propagates commit budget release failures", async () => {
    tauriMocks.invoke.mockRejectedValue(new Error("release failed"))

    await expect(runtimeCommitBudgetRelease("claim-1")).rejects.toThrow("release failed")
  })

  it("sends staging artifact cleanup payloads", async () => {
    const response = { artifactId: "artifact-1" }
    tauriMocks.invoke.mockResolvedValue(response)

    await expect(runtimeStagingArtifactCommitSuccess("artifact-1")).resolves.toBe(response)

    expect(tauriMocks.invoke).toHaveBeenCalledWith(
      "runtime_staging_artifact_commit_success",
      {
        request: { artifactId: "artifact-1" },
      },
    )
  })

  it("sends runtime event append payloads", async () => {
    const response = { eventId: "event-1", createdAtMs: 123 }
    tauriMocks.invoke.mockResolvedValue(response)

    await expect(
      runtimeEventAppend({
        jobId: "job-1",
        eventId: "event-1",
        payload: "{\"kind\":\"markdown-commit\"}",
      }),
    ).resolves.toBe(response)

    expect(tauriMocks.invoke).toHaveBeenCalledWith("runtime_event_append", {
      request: {
        jobId: "job-1",
        eventId: "event-1",
        payload: "{\"kind\":\"markdown-commit\"}",
      },
    })
  })

  it("sends derived stale marker record and list payloads", async () => {
    const record = { markerId: "marker-1" }
    const list = { enabled: true, status: "healthy", markers: [record] }
    tauriMocks.invoke.mockResolvedValueOnce(record).mockResolvedValueOnce(list)

    await expect(
      runtimeDerivedStaleMarkerRecord({
        markerId: "marker-1",
        layer: "embedding",
        affectedPath: "wiki/Page.md",
        inputHash: "sha256:abc",
        baseVersion: "event:123:event-1",
        reason: "commit",
        sourceEventId: "event-1",
      }),
    ).resolves.toBe(record)
    await expect(
      runtimeDerivedStaleMarkerList({
        layer: "embedding",
        affectedPath: "wiki/Page.md",
        status: "pending",
      }),
    ).resolves.toBe(list)

    expect(tauriMocks.invoke).toHaveBeenNthCalledWith(
      1,
      "runtime_derived_stale_marker_record",
      {
        request: {
          markerId: "marker-1",
          layer: "embedding",
          affectedPath: "wiki/Page.md",
          inputHash: "sha256:abc",
          baseVersion: "event:123:event-1",
          reason: "commit",
          sourceEventId: "event-1",
        },
      },
    )
    expect(tauriMocks.invoke).toHaveBeenNthCalledWith(
      2,
      "runtime_derived_stale_marker_list",
      {
        request: {
          layer: "embedding",
          affectedPath: "wiki/Page.md",
          status: "pending",
        },
      },
    )
  })
})
