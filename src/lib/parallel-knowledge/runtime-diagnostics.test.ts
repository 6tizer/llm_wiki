import { describe, expect, it } from "vitest"
import {
  captureRuntimeDiagnosticsSnapshot,
  type RuntimeDiagnosticsAdapters,
} from "./runtime-diagnostics"

describe("captureRuntimeDiagnosticsSnapshot", () => {
  it("returns a healthy empty snapshot", async () => {
    const snapshot = await captureRuntimeDiagnosticsSnapshot(makeAdapters())

    expect(snapshot).toEqual({
      status: "healthy",
      jobs: {
        data: { enabled: true, status: "healthy", jobs: [], leases: [] },
        error: null,
      },
      progress: {
        data: { enabled: true, status: "healthy", progress: [] },
        error: null,
      },
      timeline: {
        data: { enabled: true, status: "healthy", events: [] },
        error: null,
      },
      stagingArtifacts: {
        data: { enabled: true, status: "healthy", artifacts: [] },
        error: null,
      },
      summary: {
        queuedJobCount: 0,
        activeJobCount: 0,
        pausedJobCount: 0,
        retryWaitJobCount: 0,
        failedJobCount: 0,
        completedJobCount: 0,
        cancelledJobCount: 0,
        progressCount: 0,
        eventCount: 0,
        stagingArtifactCount: 0,
      },
    })
  })

  it("summarizes runtime rows from different list collection fields", async () => {
    const snapshot = await captureRuntimeDiagnosticsSnapshot(
      makeAdapters({
        jobs: {
          enabled: true,
          status: "healthy",
          jobs: [
            job("queued-1", "queued"),
            job("running-1", "running"),
            job("paused-1", "paused"),
            job("retry-1", "retry-wait"),
            job("failed-1", "failed"),
            job("completed-1", "completed"),
            job("cancelled-1", "cancelled"),
          ],
          leases: [],
        },
        progress: {
          enabled: true,
          status: "healthy",
          progress: [
            {
              jobId: "running-1",
              progressKey: "prepare",
              payload: "{}",
              updatedAtMs: 1,
              lastEventId: null,
            },
          ],
        },
        timeline: {
          enabled: true,
          status: "healthy",
          events: [
            {
              eventId: "event-1",
              jobId: "running-1",
              eventName: "job-runtime:progress-appended",
              payload: "{}",
              createdAtMs: 1,
            },
          ],
        },
        stagingArtifacts: {
          enabled: true,
          status: "healthy",
          artifacts: [
            {
              artifactId: "artifact-1",
              jobId: "running-1",
              artifactPath: "job/artifact.md",
              artifactHash: "sha256:abc",
              status: "pending",
              createdAtMs: 1,
              updatedAtMs: 1,
            },
          ],
        },
      }),
    )

    expect(snapshot.summary).toEqual({
      queuedJobCount: 1,
      activeJobCount: 1,
      pausedJobCount: 1,
      retryWaitJobCount: 1,
      failedJobCount: 1,
      completedJobCount: 1,
      cancelledJobCount: 1,
      progressCount: 1,
      eventCount: 1,
      stagingArtifactCount: 1,
    })
  })

  it("preserves disabled and no-project health states", async () => {
    await expect(
      captureRuntimeDiagnosticsSnapshot(
        makeAdapters({
          jobs: { enabled: false, status: "disabled", jobs: [], leases: [] },
        }),
      ),
    ).resolves.toMatchObject({ status: "disabled" })

    await expect(
      captureRuntimeDiagnosticsSnapshot(
        makeAdapters({
          jobs: { enabled: true, status: "no-project", jobs: [], leases: [] },
        }),
      ),
    ).resolves.toMatchObject({ status: "no-project" })
  })

  it("keeps successful sections when one list fails", async () => {
    const snapshot = await captureRuntimeDiagnosticsSnapshot({
      ...makeAdapters(),
      listProgress: () => Promise.reject(new Error("progress unavailable")),
    })

    expect(snapshot.status).toBe("partial-error")
    expect(snapshot.jobs.data?.status).toBe("healthy")
    expect(snapshot.progress).toEqual({
      data: null,
      error: "progress unavailable",
    })
    expect(snapshot.timeline.data?.events).toEqual([])
  })

  it("reports error when every section fails", async () => {
    const snapshot = await captureRuntimeDiagnosticsSnapshot({
      listJobs: () => Promise.reject(new Error("jobs failed")),
      listProgress: () => Promise.reject(new Error("progress failed")),
      listTimeline: () => Promise.reject(new Error("timeline failed")),
      listStagingArtifacts: () => Promise.reject(new Error("artifacts failed")),
    })

    expect(snapshot.status).toBe("error")
    expect(snapshot.jobs.error).toBe("jobs failed")
    expect(snapshot.summary).toEqual({
      queuedJobCount: 0,
      activeJobCount: 0,
      pausedJobCount: 0,
      retryWaitJobCount: 0,
      failedJobCount: 0,
      completedJobCount: 0,
      cancelledJobCount: 0,
      progressCount: 0,
      eventCount: 0,
      stagingArtifactCount: 0,
    })
  })
})

function makeAdapters(
  overrides: Partial<{
    jobs: Awaited<ReturnType<RuntimeDiagnosticsAdapters["listJobs"]>>
    progress: Awaited<ReturnType<RuntimeDiagnosticsAdapters["listProgress"]>>
    timeline: Awaited<ReturnType<RuntimeDiagnosticsAdapters["listTimeline"]>>
    stagingArtifacts: Awaited<ReturnType<RuntimeDiagnosticsAdapters["listStagingArtifacts"]>>
  }> = {},
): RuntimeDiagnosticsAdapters {
  return {
    listJobs: () =>
      Promise.resolve(overrides.jobs ?? { enabled: true, status: "healthy", jobs: [], leases: [] }),
    listProgress: () =>
      Promise.resolve(overrides.progress ?? { enabled: true, status: "healthy", progress: [] }),
    listTimeline: () =>
      Promise.resolve(overrides.timeline ?? { enabled: true, status: "healthy", events: [] }),
    listStagingArtifacts: () =>
      Promise.resolve(
        overrides.stagingArtifacts ?? { enabled: true, status: "healthy", artifacts: [] },
      ),
  }
}

function job(
  jobId: string,
  state:
    | "queued"
    | "running"
    | "paused"
    | "retry-wait"
    | "failed"
    | "completed"
    | "cancelled",
) {
  return {
    jobId,
    kind: "bulk-knowledge-prepare",
    payload: "{}",
    state,
    attempt: 0,
    maxAttempts: 3,
    priority: 0,
    createdAtMs: 1,
    updatedAtMs: 1,
  }
}
