import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  runtimeDerivedStaleMarkerList,
  runtimeDerivedStaleMarkerRecord,
  runtimeCommitBudgetClaim,
  runtimeCommitBudgetRelease,
  runtimeEventAppend,
  runtimeJobCancel,
  runtimeJobCreate,
  runtimeJobList,
  runtimeJobPause,
  runtimeJobResume,
  runtimeProfileCreate,
  runtimeProfileDelete,
  runtimeProfileList,
  runtimeProfilePoolClaim,
  runtimeProfilePoolList,
  runtimeProfilePoolRelease,
  runtimeProfileProbe,
  runtimeProfileStatus,
  runtimeProfileUpdate,
  runtimeStagingArtifactRecord,
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

  it("sends runtime job create payloads", async () => {
    const response = { jobId: "repair-1" }
    tauriMocks.invoke.mockResolvedValue(response)

    await expect(
      runtimeJobCreate({
        kind: "markdown-conflict-repair",
        payload: "{\"kind\":\"markdown-conflict-repair\"}",
        maxAttempts: 3,
        priority: 5,
      }),
    ).resolves.toBe(response)

    expect(tauriMocks.invoke).toHaveBeenCalledWith("runtime_job_create", {
      request: {
        kind: "markdown-conflict-repair",
        payload: "{\"kind\":\"markdown-conflict-repair\"}",
        maxAttempts: 3,
        priority: 5,
      },
    })
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

  it("sends staging artifact record payloads", async () => {
    const response = { artifactId: "artifact-1", status: "failed" }
    tauriMocks.invoke.mockResolvedValue(response)

    await expect(
      runtimeStagingArtifactRecord({
        artifactId: "artifact-1",
        jobId: "job-1",
        artifactPath: "job-1/artifact.md",
        artifactHash: "sha256:artifact",
        status: "failed",
        lastError: "commit-conflict: base hash mismatch",
      }),
    ).resolves.toBe(response)

    expect(tauriMocks.invoke).toHaveBeenCalledWith(
      "runtime_staging_artifact_record",
      {
        request: {
          artifactId: "artifact-1",
          jobId: "job-1",
          artifactPath: "job-1/artifact.md",
          artifactHash: "sha256:artifact",
          status: "failed",
          lastError: "commit-conflict: base hash mismatch",
        },
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

  it("sends runtime profile create, update, list, status, and delete payloads", async () => {
    const created = { profileId: "profile-1", capabilityStatus: "unknown" }
    const updated = { profileId: "profile-1", capabilityStatus: "limited" }
    const probe = {
      status: "supported",
      capabilityJson: "{\"modelCallSupported\":true}",
      capabilityVersion: "profile-probe.v1",
      checkedAtMs: 123,
      backoffUntilMs: null,
      message: "Probe succeeded.",
    }
    const list = { enabled: true, status: "healthy", profiles: [updated] }
    const deleted = {
      profileId: "profile-1",
      deletedAtMs: 456,
      secretRef: "llm-wiki-profile-secret:550e8400-e29b-41d4-a716-446655440000",
    }
    tauriMocks.invoke
      .mockResolvedValueOnce(created)
      .mockResolvedValueOnce(updated)
      .mockResolvedValueOnce(probe)
      .mockResolvedValueOnce(list)
      .mockResolvedValueOnce(updated)
      .mockResolvedValueOnce(deleted)

    await expect(
      runtimeProfileCreate({
        profileId: "profile-1",
        kind: "model-call",
        displayName: "GPT-4.1",
        providerId: "openai",
        modelId: "gpt-4.1",
        agentSdkModelId: "deepseek-chat",
        apiMode: "openai-chat-completions",
        authStyle: "bearer",
        secretRef: "llm-wiki-profile-secret:550e8400-e29b-41d4-a716-446655440000",
        taskFamilies: ["summarize", "tag"],
        maxConcurrency: 2,
      }),
    ).resolves.toBe(created)
    await expect(
      runtimeProfileUpdate({
        profileId: "profile-1",
        clearSecretRef: true,
        agentSdkModelId: null,
        clearAgentSdkModelId: true,
        enabled: false,
        capabilityStatus: "limited",
        capabilityJson: "{\"reason\":\"manual\"}",
      }),
    ).resolves.toBe(updated)
    await expect(
      runtimeProfileProbe({
        profileId: "profile-1",
        force: true,
      }),
    ).resolves.toBe(probe)
    await expect(runtimeProfileList()).resolves.toBe(list)
    await expect(runtimeProfileStatus({ profileId: "profile-1" })).resolves.toBe(updated)
    await expect(runtimeProfileDelete({ profileId: "profile-1" })).resolves.toBe(deleted)

    expect(tauriMocks.invoke).toHaveBeenNthCalledWith(1, "runtime_profile_create", {
      request: {
        profileId: "profile-1",
        kind: "model-call",
        displayName: "GPT-4.1",
        providerId: "openai",
        modelId: "gpt-4.1",
        agentSdkModelId: "deepseek-chat",
        apiMode: "openai-chat-completions",
        authStyle: "bearer",
        secretRef: "llm-wiki-profile-secret:550e8400-e29b-41d4-a716-446655440000",
        taskFamilies: ["summarize", "tag"],
        maxConcurrency: 2,
      },
    })
    expect(tauriMocks.invoke).toHaveBeenNthCalledWith(2, "runtime_profile_update", {
      request: {
        profileId: "profile-1",
        clearSecretRef: true,
        agentSdkModelId: null,
        clearAgentSdkModelId: true,
        enabled: false,
        capabilityStatus: "limited",
        capabilityJson: "{\"reason\":\"manual\"}",
      },
    })
    expect(tauriMocks.invoke).toHaveBeenNthCalledWith(3, "runtime_profile_probe", {
      request: {
        profileId: "profile-1",
        force: true,
      },
    })
    expect(tauriMocks.invoke).toHaveBeenNthCalledWith(4, "runtime_profile_list")
    expect(tauriMocks.invoke).toHaveBeenNthCalledWith(5, "runtime_profile_status", {
      request: { profileId: "profile-1" },
    })
    expect(tauriMocks.invoke).toHaveBeenNthCalledWith(6, "runtime_profile_delete", {
      request: { profileId: "profile-1" },
    })
  })

  it("sends runtime profile pool claim, release, and list payloads", async () => {
    const claimed = {
      claimId: "claim-1",
      profileId: "profile-1",
      expiresAtMs: 123,
      claim: { claimId: "claim-1" },
    }
    const released = { claim: { claimId: "claim-1" }, circuitBreaker: null }
    const list = { enabled: true, status: "healthy", activeClaims: [], circuitBreakers: [] }
    tauriMocks.invoke
      .mockResolvedValueOnce(claimed)
      .mockResolvedValueOnce(released)
      .mockResolvedValueOnce(list)

    await expect(
      runtimeProfilePoolClaim({
        claimId: "claim-1",
        kind: "model-call",
        taskFamily: "summarize",
        holder: "worker-1",
        jobId: "job-1",
        ttlMs: 30000,
        preferredProfileIds: ["profile-2", "profile-1"],
      }),
    ).resolves.toBe(claimed)
    await expect(
      runtimeProfilePoolRelease({
        claimId: "claim-1",
        outcome: "rate-limited",
        retryAfterMs: 60000,
        reason: "provider 429",
      }),
    ).resolves.toBe(released)
    await expect(
      runtimeProfilePoolList({
        kind: "model-call",
        taskFamily: "summarize",
        jobId: "job-1",
      }),
    ).resolves.toBe(list)

    expect(tauriMocks.invoke).toHaveBeenNthCalledWith(1, "runtime_profile_pool_claim", {
      request: {
        claimId: "claim-1",
        kind: "model-call",
        taskFamily: "summarize",
        holder: "worker-1",
        jobId: "job-1",
        ttlMs: 30000,
        preferredProfileIds: ["profile-2", "profile-1"],
      },
    })
    expect(tauriMocks.invoke).toHaveBeenNthCalledWith(2, "runtime_profile_pool_release", {
      request: {
        claimId: "claim-1",
        outcome: "rate-limited",
        retryAfterMs: 60000,
        reason: "provider 429",
      },
    })
    expect(tauriMocks.invoke).toHaveBeenNthCalledWith(3, "runtime_profile_pool_list", {
      request: {
        kind: "model-call",
        taskFamily: "summarize",
        jobId: "job-1",
      },
    })
  })
})
