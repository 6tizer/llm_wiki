import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  runtimeDerivedMarkerClaimBatch,
  runtimeDerivedMarkerCompleteBatch,
  runtimeDerivedMarkerReleaseBatch,
  runtimeDerivedStaleMarkerList,
  runtimeDerivedStaleMarkerRecord,
  runtimeCommitBudgetClaim,
  runtimeCommitBudgetRelease,
  runtimeEventAppend,
  runtimeJobCancel,
  runtimeJobClaimByKind,
  runtimeJobComplete,
  runtimeJobCreate,
  runtimeJobFail,
  runtimeJobHeartbeat,
  runtimeJobList,
  runtimeJobPause,
  runtimeJobResume,
  runtimeProfileCreate,
  runtimeProfileBreakerClear,
  runtimeProfileDelete,
  runtimeProfileList,
  runtimeProfileModelsList,
  runtimeProfilePoolClaim,
  runtimeProfilePoolEventsList,
  runtimeProfilePoolList,
  runtimeProfilePoolRelease,
  runtimeProfileProbe,
  runtimeProfileStatus,
  runtimeProfileUpdate,
  runtimeProgressAppend,
  runtimeProgressList,
  runtimeStagingArtifactRecord,
  runtimeStagingArtifactReadBody,
  runtimeStagingArtifactsClearPendingForJob,
  runtimeStagingArtifactCommitSuccess,
  runtimeStagingArtifactList,
  runtimeStagingArtifactStore,
  runtimeTaskPolicyList,
  runtimeTaskPolicySet,
  runtimeTimelineList,
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

  it("sends runtime job claim and lease lifecycle payloads", async () => {
    const claim = {
      job: { jobId: "job-1", kind: "bulk-knowledge-prepare" },
      lease: { leaseId: "lease-1", jobId: "job-1" },
    }
    const complete = { jobId: "job-1", state: "completed" }
    const failed = { jobId: "job-2", state: "retry-wait" }
    tauriMocks.invoke
      .mockResolvedValueOnce(claim)
      .mockResolvedValueOnce(claim)
      .mockResolvedValueOnce(complete)
      .mockResolvedValueOnce(failed)

    await expect(
      runtimeJobClaimByKind({
        kind: "bulk-knowledge-prepare",
        holder: "bulk-prepare:worker-1",
        leaseId: "lease-1",
      }),
    ).resolves.toBe(claim)
    await expect(
      runtimeJobHeartbeat({ jobId: "job-1", leaseId: "lease-1" }),
    ).resolves.toBe(claim)
    await expect(
      runtimeJobComplete({ jobId: "job-1", leaseId: "lease-1" }),
    ).resolves.toBe(complete)
    await expect(
      runtimeJobFail({
        jobId: "job-2",
        leaseId: "lease-2",
        error: "profile unavailable",
        retryAfterMs: 123456,
      }),
    ).resolves.toBe(failed)

    expect(tauriMocks.invoke).toHaveBeenNthCalledWith(1, "runtime_job_claim_by_kind", {
      request: {
        kind: "bulk-knowledge-prepare",
        holder: "bulk-prepare:worker-1",
        leaseId: "lease-1",
      },
    })
    expect(tauriMocks.invoke).toHaveBeenNthCalledWith(2, "runtime_job_heartbeat", {
      request: { jobId: "job-1", leaseId: "lease-1" },
    })
    expect(tauriMocks.invoke).toHaveBeenNthCalledWith(3, "runtime_job_complete", {
      request: { jobId: "job-1", leaseId: "lease-1" },
    })
    expect(tauriMocks.invoke).toHaveBeenNthCalledWith(4, "runtime_job_fail", {
      request: {
        jobId: "job-2",
        leaseId: "lease-2",
        error: "profile unavailable",
        retryAfterMs: 123456,
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

  it("sends staging artifact store payloads", async () => {
    const response = { artifactId: "artifact-1", artifactHash: "sha256:artifact" }
    tauriMocks.invoke.mockResolvedValue(response)

    await expect(
      runtimeStagingArtifactStore({
        artifactId: "artifact-1",
        jobId: "job-1",
        artifactPath: "job-1/artifact.md",
        targetPath: "Wiki/Page.md",
        operationIntent: "update",
        baseHash: "sha256:base",
        sourceKind: "ingest",
        markdown: "# Page\n",
      }),
    ).resolves.toBe(response)

    expect(tauriMocks.invoke).toHaveBeenCalledWith(
      "runtime_staging_artifact_store",
      {
        request: {
          artifactId: "artifact-1",
          jobId: "job-1",
          artifactPath: "job-1/artifact.md",
          targetPath: "Wiki/Page.md",
          operationIntent: "update",
          baseHash: "sha256:base",
          sourceKind: "ingest",
          markdown: "# Page\n",
        },
      },
    )
  })

  it("sends staging artifact read-body payloads", async () => {
    const response = {
      artifactId: "artifact-1",
      artifactPath: "job-1/page.md",
      markdown: "# Page",
    }
    tauriMocks.invoke.mockResolvedValue(response)

    await expect(
      runtimeStagingArtifactReadBody({ artifactId: "artifact-1" }),
    ).resolves.toBe(response)

    expect(tauriMocks.invoke).toHaveBeenCalledWith(
      "runtime_staging_artifact_read_body",
      {
        request: { artifactId: "artifact-1" },
      },
    )
  })

  it("sends staging artifact pending cleanup payloads", async () => {
    const response = { cleared: [] }
    tauriMocks.invoke.mockResolvedValue(response)

    await expect(
      runtimeStagingArtifactsClearPendingForJob({ jobId: "job-1" }),
    ).resolves.toBe(response)

    expect(tauriMocks.invoke).toHaveBeenCalledWith(
      "runtime_staging_artifacts_clear_pending_for_job",
      { request: { jobId: "job-1" } },
    )
  })

  it("sends staging artifact list payloads with exact Rust serde fields", async () => {
    const response = { enabled: true, status: "healthy", artifacts: [] }
    tauriMocks.invoke.mockResolvedValue(response)

    await expect(
      runtimeStagingArtifactList({
        jobId: "job-1",
        status: "pending",
        limit: 25,
      }),
    ).resolves.toBe(response)

    expect(tauriMocks.invoke).toHaveBeenCalledWith(
      "runtime_staging_artifact_list",
      {
        request: {
          jobId: "job-1",
          status: "pending",
          limit: 25,
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

  it("sends runtime progress append payloads with semantic payload in JSON", async () => {
    const response = {
      progress: {
        jobId: "job-1",
        progressKey: "bulk-prepare:worker:1",
        payload: "{\"type\":\"bulk-prepare:job-claimed\"}",
        updatedAtMs: 123,
        lastEventId: "event-1",
      },
      event: {
        eventId: "event-1",
        eventName: "job-runtime:progress-appended",
      },
    }
    tauriMocks.invoke.mockResolvedValue(response)

    await expect(
      runtimeProgressAppend({
        jobId: "job-1",
        progressKey: "bulk-prepare:worker:1",
        eventId: "event-1",
        payload: "{\"type\":\"bulk-prepare:job-claimed\"}",
        durable: true,
      }),
    ).resolves.toBe(response)

    expect(tauriMocks.invoke).toHaveBeenCalledWith("runtime_progress_append", {
      request: {
        jobId: "job-1",
        progressKey: "bulk-prepare:worker:1",
        eventId: "event-1",
        payload: "{\"type\":\"bulk-prepare:job-claimed\"}",
        durable: true,
      },
    })
  })

  it("sends runtime timeline and progress list payloads with exact Rust serde fields", async () => {
    const timeline = { enabled: true, status: "healthy", events: [] }
    const progress = { enabled: true, status: "healthy", progress: [] }
    tauriMocks.invoke.mockResolvedValueOnce(timeline).mockResolvedValueOnce(progress)

    await expect(runtimeTimelineList({ jobId: "job-1", limit: 10 })).resolves.toBe(
      timeline,
    )
    await expect(runtimeProgressList({ jobId: "job-1", limit: 20 })).resolves.toBe(
      progress,
    )

    expect(tauriMocks.invoke).toHaveBeenNthCalledWith(1, "runtime_timeline_list", {
      request: { jobId: "job-1", limit: 10 },
    })
    expect(tauriMocks.invoke).toHaveBeenNthCalledWith(2, "runtime_progress_list", {
      request: { jobId: "job-1", limit: 20 },
    })
  })

  it("uses empty request objects for runtime read-only list wrappers", async () => {
    tauriMocks.invoke
      .mockResolvedValueOnce({ enabled: true, status: "healthy", events: [] })
      .mockResolvedValueOnce({ enabled: true, status: "healthy", progress: [] })
      .mockResolvedValueOnce({ enabled: true, status: "healthy", artifacts: [] })

    await runtimeTimelineList()
    await runtimeProgressList()
    await runtimeStagingArtifactList()

    expect(tauriMocks.invoke).toHaveBeenNthCalledWith(1, "runtime_timeline_list", {
      request: {},
    })
    expect(tauriMocks.invoke).toHaveBeenNthCalledWith(2, "runtime_progress_list", {
      request: {},
    })
    expect(tauriMocks.invoke).toHaveBeenNthCalledWith(
      3,
      "runtime_staging_artifact_list",
      { request: {} },
    )
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

  it("sends derived stale marker list cursor payloads", async () => {
    const list = { enabled: true, status: "healthy", markers: [], nextCursor: null }
    tauriMocks.invoke.mockResolvedValue(list)

    await expect(
      runtimeDerivedStaleMarkerList({
        sinceMarkedAtMs: 123,
        sinceMarkerId: "marker-1",
      }),
    ).resolves.toBe(list)

    expect(tauriMocks.invoke).toHaveBeenCalledWith("runtime_derived_stale_marker_list", {
      request: {
        sinceMarkedAtMs: 123,
        sinceMarkerId: "marker-1",
      },
    })
  })

  it("sends derived marker claim/complete/release batch payloads", async () => {
    const claimed = {
      job: { jobId: "job-1", kind: "derived-rebuild", state: "queued" },
      markers: [{ markerId: "marker-1", status: "claimed" }],
    }
    const completed = {
      job: { jobId: "job-1", state: "completed" },
      markers: [{ markerId: "marker-1", status: "done" }],
    }
    const released = {
      job: { jobId: "job-2", state: "cancelled" },
      markers: [{ markerId: "marker-2", status: "cancelled" }],
    }
    tauriMocks.invoke
      .mockResolvedValueOnce(claimed)
      .mockResolvedValueOnce(completed)
      .mockResolvedValueOnce(released)

    await expect(
      runtimeDerivedMarkerClaimBatch({
        layer: "embedding",
        affectedPath: "wiki/Page.md",
      }),
    ).resolves.toBe(claimed)
    await expect(
      runtimeDerivedMarkerCompleteBatch({
        jobId: "job-1",
        leaseId: "lease-1",
        markerIds: ["marker-1"],
      }),
    ).resolves.toBe(completed)
    await expect(
      runtimeDerivedMarkerReleaseBatch({
        jobId: "job-2",
        markerIds: ["marker-2"],
        targetStatus: "cancelled",
      }),
    ).resolves.toBe(released)

    expect(tauriMocks.invoke).toHaveBeenNthCalledWith(1, "runtime_derived_marker_claim_batch", {
      request: {
        layer: "embedding",
        affectedPath: "wiki/Page.md",
      },
    })
    expect(tauriMocks.invoke).toHaveBeenNthCalledWith(2, "runtime_derived_marker_complete_batch", {
      request: {
        jobId: "job-1",
        leaseId: "lease-1",
        markerIds: ["marker-1"],
      },
    })
    expect(tauriMocks.invoke).toHaveBeenNthCalledWith(3, "runtime_derived_marker_release_batch", {
      request: {
        jobId: "job-2",
        markerIds: ["marker-2"],
        targetStatus: "cancelled",
      },
    })
  })

  it("propagates derived marker claim batch failures", async () => {
    tauriMocks.invoke.mockRejectedValue(new Error("claim failed"))

    await expect(
      runtimeDerivedMarkerClaimBatch({
        layer: "embedding",
        affectedPath: "wiki/Page.md",
      }),
    ).rejects.toThrow("claim failed")
  })

  it("propagates derived marker complete batch failures", async () => {
    tauriMocks.invoke.mockRejectedValue(new Error("complete failed"))

    await expect(
      runtimeDerivedMarkerCompleteBatch({
        jobId: "job-1",
        leaseId: "lease-1",
        markerIds: ["marker-1"],
      }),
    ).rejects.toThrow("complete failed")
  })

  it("propagates derived marker release batch failures", async () => {
    tauriMocks.invoke.mockRejectedValue(new Error("release failed"))

    await expect(
      runtimeDerivedMarkerReleaseBatch({
        jobId: "job-2",
        markerIds: ["marker-2"],
        targetStatus: "cancelled",
      }),
    ).rejects.toThrow("release failed")
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
    const models = { models: ["gpt-5.5"], sourceUrl: "https://api.openai.com/v1/models" }
    const list = { enabled: true, status: "healthy", profiles: [updated] }
    const deleted = {
      profileId: "profile-1",
      deletedAtMs: 456,
      secretRef: "llm-wiki-profile-secret:550e8400-e29b-41d4-a716-446655440000",
    }
    const updateResult = { profile: updated, staleSecretRef: null }
    tauriMocks.invoke
      .mockResolvedValueOnce(created)
      .mockResolvedValueOnce(updateResult)
      .mockResolvedValueOnce(probe)
      .mockResolvedValueOnce(models)
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
    ).resolves.toBe(updateResult)
    await expect(
      runtimeProfileProbe({
        profileId: "profile-1",
        force: true,
      }),
    ).resolves.toBe(probe)
    await expect(
      runtimeProfileModelsList({
        draft: {
          endpoint: "https://api.openai.com/v1",
          apiMode: "openai-chat-completions",
          authStyle: "bearer",
        },
        rawSecret: "sk-test",
      }),
    ).resolves.toBe(models)
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
    expect(tauriMocks.invoke).toHaveBeenNthCalledWith(4, "runtime_profile_models_list", {
      request: {
        draft: {
          endpoint: "https://api.openai.com/v1",
          apiMode: "openai-chat-completions",
          authStyle: "bearer",
        },
        rawSecret: "sk-test",
      },
    })
    expect(tauriMocks.invoke).toHaveBeenNthCalledWith(5, "runtime_profile_list")
    expect(tauriMocks.invoke).toHaveBeenNthCalledWith(6, "runtime_profile_status", {
      request: { profileId: "profile-1" },
    })
    expect(tauriMocks.invoke).toHaveBeenNthCalledWith(7, "runtime_profile_delete", {
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

  it("sends fallback policy and profile-pool observability commands", async () => {
    const policyList = { enabled: true, status: "healthy", policies: [] }
    const policySet = {
      policy: {
        taskFamily: "chat",
        profileOrder: ["profile-1"],
        autoFailover: true,
        updatedAtMs: 1,
      },
      removedProfileIds: [],
    }
    const events = { enabled: true, status: "healthy", events: [] }
    const cleared = { profileId: "profile-1", cleared: true }
    tauriMocks.invoke
      .mockResolvedValueOnce(policyList)
      .mockResolvedValueOnce(policySet)
      .mockResolvedValueOnce(events)
      .mockResolvedValueOnce(cleared)

    await expect(runtimeTaskPolicyList()).resolves.toBe(policyList)
    await expect(runtimeTaskPolicySet({
      taskFamily: "chat",
      profileOrder: ["profile-1"],
      autoFailover: true,
    })).resolves.toBe(policySet)
    await expect(runtimeProfilePoolEventsList({ limit: 20 })).resolves.toBe(events)
    await expect(runtimeProfileBreakerClear({ profileId: "profile-1" })).resolves.toBe(cleared)

    expect(tauriMocks.invoke).toHaveBeenNthCalledWith(1, "runtime_task_policy_list")
    expect(tauriMocks.invoke).toHaveBeenNthCalledWith(2, "runtime_task_policy_set", {
      request: {
        taskFamily: "chat",
        profileOrder: ["profile-1"],
        autoFailover: true,
      },
    })
    expect(tauriMocks.invoke).toHaveBeenNthCalledWith(3, "runtime_profile_pool_events_list", {
      request: { limit: 20 },
    })
    expect(tauriMocks.invoke).toHaveBeenNthCalledWith(4, "runtime_profile_breaker_clear", {
      request: { profileId: "profile-1" },
    })
  })
})
