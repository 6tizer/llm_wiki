// @vitest-environment jsdom

import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import "@/i18n"
import {
  RuntimeJobsSection,
  summarizeRuntimeJobs,
  useRuntimeJobsState,
} from "./runtime-jobs-section"
import { ActivityPanel, getRuntimeStatusText } from "./activity-panel"
import { useWikiStore } from "@/stores/wiki-store"
import type {
  RuntimeJobLeaseRecord,
  RuntimeJobList,
  RuntimeJobRecord,
  RuntimeJobState,
} from "@/commands/runtime-db"

const runtimeDbMocks = vi.hoisted(() => ({
  runtimeJobList: vi.fn(),
  runtimeProgressList: vi.fn(),
  runtimeTimelineList: vi.fn(),
  runtimeStagingArtifactList: vi.fn(),
  runtimeProfilePoolList: vi.fn(),
  runtimeJobCancel: vi.fn(),
  runtimeJobPause: vi.fn(),
  runtimeJobResume: vi.fn(),
  runtimeDbHealth: vi.fn(),
  runtimeDerivedMarkerReleaseBatch: vi.fn(),
}))

vi.mock("@/commands/runtime-db", () => runtimeDbMocks)

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true

function job(jobId: string, state: RuntimeJobState): RuntimeJobRecord {
  return {
    jobId,
    kind: "compile-page",
    payload: "{}",
    state,
    attempt: state === "running" ? 1 : 0,
    maxAttempts: 3,
    priority: 0,
    createdAtMs: 100,
    updatedAtMs: 200 + jobId.length,
    queuedAtMs: 100,
    startedAtMs: state === "running" ? 200 : null,
    completedAtMs: state === "completed" ? 300 : null,
    failedAtMs: state === "failed" ? 300 : null,
    cancelledAtMs: state === "cancelled" ? 300 : null,
    retryAfterMs: state === "retry-wait" ? 500 : null,
    lastError: state === "failed" ? "provider failed" : null,
  }
}

function bulkPrepareJob(
  jobId: string,
  state: RuntimeJobState,
  payload: Record<string, unknown>,
): RuntimeJobRecord {
  return {
    ...job(jobId, state),
    kind: "bulk-knowledge-prepare",
    payload: JSON.stringify({
      kind: "bulk-knowledge-prepare",
      ...payload,
    }),
  }
}

function list(
  jobs: RuntimeJobRecord[],
  enabled = true,
  status: RuntimeJobList["status"] = "healthy",
  leases: RuntimeJobLeaseRecord[] = [],
): RuntimeJobList {
  return { enabled, status, jobs, leases }
}

function lease(jobId: string, overrides: Partial<RuntimeJobLeaseRecord> = {}): RuntimeJobLeaseRecord {
  return {
    leaseId: `${jobId}-lease`,
    jobId,
    holder: "worker-1",
    acquiredAtMs: 100,
    heartbeatAtMs: 100,
    expiresAtMs: 100_000_000,
    releasedAtMs: null,
    status: "active",
    ...overrides,
  }
}

function stagingArtifact(artifactId: string, status: string) {
  return {
    artifactId,
    jobId: "bulk-1",
    artifactPath: `${artifactId}.md`,
    artifactHash: `sha256:${artifactId}`,
    status,
    createdAtMs: 1,
    updatedAtMs: 1,
  }
}

function setProject(open: boolean): void {
  act(() => {
    useWikiStore.getState().setProject(open ? { id: "p1", name: "Project", path: "/project" } : null)
  })
}

function Harness() {
  const state = useRuntimeJobsState()
  return <RuntimeJobsSection state={state} />
}

function renderHarness(): { container: HTMLDivElement; root: Root } {
  const container = document.createElement("div")
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => {
    root.render(<Harness />)
  })
  return { container, root }
}

function renderActivityPanel(): { container: HTMLDivElement; root: Root } {
  const container = document.createElement("div")
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => {
    root.render(<ActivityPanel />)
  })
  return { container, root }
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  })
}

async function click(element: Element): Promise<void> {
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }))
    await Promise.resolve()
  })
}

function unmount(root: Root): void {
  act(() => {
    root.unmount()
  })
}

describe("RuntimeJobsSection", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    setProject(true)
    runtimeDbMocks.runtimeProgressList.mockResolvedValue({
      enabled: true,
      status: "healthy",
      progress: [],
    })
    runtimeDbMocks.runtimeTimelineList.mockResolvedValue({
      enabled: true,
      status: "healthy",
      events: [],
    })
    runtimeDbMocks.runtimeStagingArtifactList.mockResolvedValue({
      enabled: true,
      status: "healthy",
      artifacts: [],
    })
    runtimeDbMocks.runtimeProfilePoolList.mockResolvedValue({
      enabled: true,
      status: "healthy",
      activeClaims: [],
      circuitBreakers: [],
    })
  })

  afterEach(() => {
    useWikiStore.getState().setProject(null)
    vi.useRealTimers()
    document.body.innerHTML = ""
  })

  it("polls job list and cleans up the polling timer", async () => {
    runtimeDbMocks.runtimeJobList.mockResolvedValue(list([job("job-running", "running")]))

    const { root } = renderHarness()
    await flush()
    expect(runtimeDbMocks.runtimeJobList).toHaveBeenCalledTimes(1)

    await act(async () => {
      vi.advanceTimersByTime(2_000)
      await Promise.resolve()
    })
    expect(runtimeDbMocks.runtimeJobList).toHaveBeenCalledTimes(2)

    unmount(root)
    await act(async () => {
      vi.advanceTimersByTime(2_000)
      await Promise.resolve()
    })
    expect(runtimeDbMocks.runtimeJobList).toHaveBeenCalledTimes(2)
  })

  it("resets the poll cadence after a user action instead of leaving the stale timer armed (SPEC-6 PR6 usePolling migration regression lock)", async () => {
    runtimeDbMocks.runtimeJobList.mockResolvedValue(list([job("job-running", "running")]))
    runtimeDbMocks.runtimeJobPause.mockResolvedValue(job("job-running", "paused"))

    const { container, root } = renderHarness()
    await flush()
    expect(runtimeDbMocks.runtimeJobList).toHaveBeenCalledTimes(1)

    // Halfway through the 2s "active" cadence, the user clicks Pause.
    await act(async () => {
      vi.advanceTimersByTime(1_000)
    })
    await click(container.querySelector("button[aria-label='Pause']")!)
    await flush()
    // The action's own refreshNow() call fetches immediately.
    expect(runtimeDbMocks.runtimeJobList).toHaveBeenCalledTimes(2)

    // The ORIGINAL timer (armed at mount for 2s, so due 1s from here) must
    // have been cleared by refreshNow — advancing only 1s must NOT re-fire
    // it. Pre-fix, calling refresh() directly here left this stale timer
    // running alongside the action's extra fetch, so it WOULD have fired.
    await act(async () => {
      vi.advanceTimersByTime(1_000)
      await Promise.resolve()
    })
    expect(runtimeDbMocks.runtimeJobList).toHaveBeenCalledTimes(2)

    // The NEW schedule (2s from the action's refreshNow call) fires next.
    await act(async () => {
      vi.advanceTimersByTime(1_000)
      await Promise.resolve()
    })
    expect(runtimeDbMocks.runtimeJobList).toHaveBeenCalledTimes(3)

    unmount(root)
  })

  it("shows only legal actions for each runtime job state", async () => {
    runtimeDbMocks.runtimeJobList.mockResolvedValue(list([
      job("job-queued", "queued"),
      job("job-running", "running"),
      job("job-paused", "paused"),
      job("job-retry", "retry-wait"),
      job("job-failed", "failed"),
      job("job-completed", "completed"),
    ]))

    const { container, root } = renderHarness()
    await flush()

    expect(container.querySelectorAll("button[aria-label='Pause']")).toHaveLength(2)
    expect(container.querySelectorAll("button[aria-label='Resume']")).toHaveLength(1)
    expect(container.querySelectorAll("button[aria-label='Cancel']")).toHaveLength(4)
    expect(container.querySelector("[data-testid='runtime-job-row-job-failed'] button")).toBeNull()
    expect(container.querySelector("[data-testid='runtime-job-row-job-completed'] button")).toBeNull()

    unmount(root)
  })

  it("renders agent chat run jobs read-only with their title", async () => {
    const agentJob: RuntimeJobRecord = {
      ...job("agent-job-1", "running"),
      kind: "agent-chat-run",
      payload: JSON.stringify({
        kind: "agent-chat-run",
        conversationId: "conv-1",
        streamId: "stream-1",
        title: "Summarize the source document",
      }),
    }
    runtimeDbMocks.runtimeJobList.mockResolvedValue(list([agentJob]))

    const { container, root } = renderHarness()
    await flush()

    const row = container.querySelector("[data-testid='runtime-job-row-agent-job-1']")
    expect(row?.textContent).toContain("Summarize the source document")
    expect(row?.querySelector("button[aria-label='Pause']")).toBeNull()
    expect(row?.querySelector("button[aria-label='Resume']")).toBeNull()
    expect(row?.querySelector("button[aria-label='Cancel']")).toBeNull()

    unmount(root)
  })

  it("releases a cancelled derived-rebuild job's claimed markers as cancelled (closeout hotfix P1 #3)", async () => {
    const derivedRebuildJob: RuntimeJobRecord = {
      ...job("rebuild-1", "running"),
      kind: "derived-rebuild",
      payload: JSON.stringify({
        layer: "embedding",
        affectedPath: "wiki/a.md",
        markerIds: ["marker-1", "marker-2"],
        baseVersion: "base",
        inputHash: null,
        reason: "commit",
      }),
    }
    runtimeDbMocks.runtimeJobList.mockResolvedValue(list([derivedRebuildJob]))
    runtimeDbMocks.runtimeJobCancel.mockResolvedValue({ ...derivedRebuildJob, state: "cancelled" })

    const { container, root } = renderHarness()
    await flush()

    await click(container.querySelector("button[aria-label='Cancel']")!)
    await flush()

    expect(runtimeDbMocks.runtimeJobCancel).toHaveBeenCalledWith("rebuild-1")
    expect(runtimeDbMocks.runtimeDerivedMarkerReleaseBatch).toHaveBeenCalledWith({
      jobId: "rebuild-1",
      markerIds: ["marker-1", "marker-2"],
      targetStatus: "cancelled",
    })

    unmount(root)
  })

  it("does not touch derived markers when cancelling a non derived-rebuild job", async () => {
    runtimeDbMocks.runtimeJobList.mockResolvedValue(list([job("job-queued", "queued")]))
    runtimeDbMocks.runtimeJobCancel.mockResolvedValue({ ...job("job-queued", "cancelled") })

    const { container, root } = renderHarness()
    await flush()

    await click(container.querySelector("button[aria-label='Cancel']")!)
    await flush()

    expect(runtimeDbMocks.runtimeJobCancel).toHaveBeenCalledWith("job-queued")
    expect(runtimeDbMocks.runtimeDerivedMarkerReleaseBatch).not.toHaveBeenCalled()

    unmount(root)
  })

  it("cancelling a derived-rebuild job with a corrupted/unparsable payload does not crash — release is skipped, a warning is logged, and the cancel itself still succeeds (closeout hotfix P2)", async () => {
    const corruptJob: RuntimeJobRecord = {
      ...job("rebuild-bad", "running"),
      kind: "derived-rebuild",
      payload: "{not-json",
    }
    runtimeDbMocks.runtimeJobList.mockResolvedValue(list([corruptJob]))
    runtimeDbMocks.runtimeJobCancel.mockResolvedValue({ ...corruptJob, state: "cancelled" })
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})

    const { container, root } = renderHarness()
    await flush()

    await click(container.querySelector("button[aria-label='Cancel']")!)
    await flush()

    expect(runtimeDbMocks.runtimeJobCancel).toHaveBeenCalledWith("rebuild-bad")
    expect(runtimeDbMocks.runtimeDerivedMarkerReleaseBatch).not.toHaveBeenCalled()
    expect(warnSpy).toHaveBeenCalled()
    // Cancel itself must not be treated as failed — no action error banner,
    // and refreshNow's own re-fetch went through (proves cancelJob's try
    // block ran to completion instead of throwing out of the payload parse).
    expect(container.querySelector("[data-testid='runtime-jobs-error']")).toBeNull()
    expect(runtimeDbMocks.runtimeJobList).toHaveBeenCalledTimes(2)

    warnSpy.mockRestore()
    unmount(root)
  })

  it("cancel itself still succeeds even when releasing the cancelled derived-rebuild markers rejects (closeout hotfix P2: best-effort release must not surface as a cancel failure)", async () => {
    const derivedRebuildJob: RuntimeJobRecord = {
      ...job("rebuild-2", "running"),
      kind: "derived-rebuild",
      payload: JSON.stringify({
        layer: "embedding",
        affectedPath: "wiki/a.md",
        markerIds: ["marker-1"],
        baseVersion: "base",
        inputHash: null,
        reason: "commit",
      }),
    }
    runtimeDbMocks.runtimeJobList.mockResolvedValue(list([derivedRebuildJob]))
    runtimeDbMocks.runtimeJobCancel.mockResolvedValue({ ...derivedRebuildJob, state: "cancelled" })
    runtimeDbMocks.runtimeDerivedMarkerReleaseBatch.mockRejectedValueOnce(new Error("release failed"))
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})

    const { container, root } = renderHarness()
    await flush()

    await click(container.querySelector("button[aria-label='Cancel']")!)
    await flush()

    expect(runtimeDbMocks.runtimeDerivedMarkerReleaseBatch).toHaveBeenCalledWith({
      jobId: "rebuild-2",
      markerIds: ["marker-1"],
      targetStatus: "cancelled",
    })
    expect(warnSpy).toHaveBeenCalled()
    expect(container.querySelector("[data-testid='runtime-jobs-error']")).toBeNull()
    expect(runtimeDbMocks.runtimeJobList).toHaveBeenCalledTimes(2)

    warnSpy.mockRestore()
    unmount(root)
  })

  it("hides the Cancel button for anchor job kinds (auto-ingest-marker-event / manual-rebuild-marker-event) even while queued", async () => {
    runtimeDbMocks.runtimeJobList.mockResolvedValue(list([
      { ...job("anchor-ingest", "queued"), kind: "auto-ingest-marker-event" },
      { ...job("anchor-manual", "queued"), kind: "manual-rebuild-marker-event" },
      job("job-queued", "queued"),
    ]))

    const { container, root } = renderHarness()
    await flush()

    expect(
      container.querySelector("[data-testid='runtime-job-row-anchor-ingest'] button[aria-label='Cancel']"),
    ).toBeNull()
    expect(
      container.querySelector("[data-testid='runtime-job-row-anchor-manual'] button[aria-label='Cancel']"),
    ).toBeNull()
    expect(
      container.querySelector("[data-testid='runtime-job-row-job-queued'] button[aria-label='Cancel']"),
    ).not.toBeNull()

    unmount(root)
  })

  it("backs off polling when no runtime jobs are visible", async () => {
    runtimeDbMocks.runtimeJobList.mockResolvedValue(list([]))

    const { root } = renderHarness()
    await flush()
    expect(runtimeDbMocks.runtimeJobList).toHaveBeenCalledTimes(1)

    await act(async () => {
      vi.advanceTimersByTime(10_000)
      await Promise.resolve()
    })
    expect(runtimeDbMocks.runtimeJobList).toHaveBeenCalledTimes(1)

    await act(async () => {
      vi.advanceTimersByTime(20_000)
      await Promise.resolve()
    })
    expect(runtimeDbMocks.runtimeJobList).toHaveBeenCalledTimes(2)

    unmount(root)
  })

  it("renders compact list and action errors without calling runtime_db_health", async () => {
    runtimeDbMocks.runtimeJobList.mockRejectedValueOnce(new Error("db is damaged"))
    runtimeDbMocks.runtimeJobList.mockResolvedValue(list([job("job-queued", "queued")]))
    runtimeDbMocks.runtimeJobPause.mockRejectedValue(new Error("pause failed"))

    const { container, root } = renderHarness()
    await flush()

    expect(container.querySelector("[data-testid='runtime-jobs-error']")?.textContent).toContain("db is damaged")
    expect(runtimeDbMocks.runtimeDbHealth).not.toHaveBeenCalled()

    await act(async () => {
      vi.advanceTimersByTime(30_000)
      await Promise.resolve()
    })
    await flush()
    await click(container.querySelector("button[aria-label='Pause']")!)
    await flush()

    expect(container.querySelector("[data-testid='runtime-jobs-error']")?.textContent).toContain("pause failed")
    expect(runtimeDbMocks.runtimeDbHealth).not.toHaveBeenCalled()

    unmount(root)
  })

  it("does not poll or show destructive controls without a project", async () => {
    setProject(false)

    const { container, root } = renderHarness()
    await flush()

    expect(runtimeDbMocks.runtimeJobList).not.toHaveBeenCalled()
    expect(container.querySelector("button[aria-label='Cancel']")).toBeNull()

    unmount(root)
  })

  it("hides destructive controls when runtime list reports disabled", async () => {
    runtimeDbMocks.runtimeJobList.mockResolvedValue(list([], false, "disabled"))

    const { container, root } = renderHarness()
    await flush()

    expect(container.querySelector("button[aria-label='Cancel']")).toBeNull()
    expect(container.textContent).not.toContain("Runtime Jobs")

    unmount(root)
  })

  it("renders bulk runtime diagnostics from snapshot sections", async () => {
    runtimeDbMocks.runtimeJobList.mockResolvedValue(list([
      bulkPrepareJob("bulk-1", "completed", {
        planId: "plan-1",
        batchTotal: 2,
        uniqueSourceTotal: 3,
      }),
      bulkPrepareJob("bulk-2", "queued", {
        planId: "plan-1",
        batchTotal: 2,
        uniqueSourceTotal: 3,
      }),
    ]))
    runtimeDbMocks.runtimeProgressList.mockResolvedValue({
      enabled: true,
      status: "healthy",
      progress: [
        {
          jobId: "bulk-1",
          progressKey: "bulk-prepare:worker:1",
          payload: JSON.stringify({ type: "bulk-prepare:job-completed" }),
          updatedAtMs: 300,
          lastEventId: null,
        },
      ],
    })
    runtimeDbMocks.runtimeStagingArtifactList.mockResolvedValue({
      enabled: true,
      status: "healthy",
      artifacts: [
        stagingArtifact("artifact-pending", "pending"),
        stagingArtifact("artifact-failed", "failed"),
        stagingArtifact("artifact-committed", "committed"),
      ],
    })
    runtimeDbMocks.runtimeProfilePoolList.mockResolvedValue({
      enabled: true,
      status: "healthy",
      activeClaims: [
        {
          claimId: "claim-1",
          profileId: "profile-1",
          kind: "model-call",
          taskFamily: "ingest",
          jobId: "bulk-2",
          holder: "bulk-prepare:worker-1",
          acquiredAtMs: 1,
          expiresAtMs: 2,
          releasedAtMs: null,
          status: "active",
        },
      ],
      circuitBreakers: [
        {
          profileId: "profile-2",
          status: "rate-limited",
          reason: "rate-limit",
          error: null,
          openedAtMs: 1,
          openUntilMs: Date.now() + 30_000,
          updatedAtMs: 1,
        },
      ],
    })

    const { container, root } = renderHarness()
    await flush()

    expect(container.textContent).toContain("Diagnostics")
    expect(container.textContent).toContain("1/2 prepare jobs")
    expect(container.textContent).toContain("3 sources")
    expect(container.textContent).toContain("1 profile claims / 1 backoff")
    expect(container.querySelector("[data-testid='runtime-diagnostics-profiles']")?.getAttribute("title"))
      .toContain("profile-2: rate-limit · 30s remaining")
    expect(container.textContent).toContain("1 pending / 1 failed / 1 committed artifacts")
    expect(container.textContent).toContain("Latest: bulk-prepare:job-completed")

    unmount(root)
  })

  it("shows queued prepare jobs as waiting for a worker when no progress or profile claim exists", async () => {
    runtimeDbMocks.runtimeJobList.mockResolvedValue(list([
      bulkPrepareJob("bulk-queued", "queued", {
        planId: "plan-solo",
        batchTotal: 1,
        uniqueSourceTotal: 2,
      }),
    ]))

    const { container, root } = renderHarness()
    await flush()

    expect(container.textContent).toContain("0/1 prepare jobs")
    expect(container.textContent).toContain("Queued; waiting for a prepare worker")
    expect(container.querySelector("[data-testid='runtime-diagnostics-worker-waiting']")).not.toBeNull()

    unmount(root)
  })

  it("feeds ActivityPanel collapsed status priority for runtime-only states", () => {
    expect(getRuntimeStatusText(summarizeRuntimeJobs(null, "db is damaged"))).toBe("Runtime failed")
    expect(getRuntimeStatusText(summarizeRuntimeJobs(list([job("job-failed", "failed")]), null))).toBe("Runtime: 1 failed")
    expect(getRuntimeStatusText(summarizeRuntimeJobs(list([job("job-running", "running")]), null))).toBe("Runtime: 1 active")
    expect(getRuntimeStatusText(summarizeRuntimeJobs(list([job("job-paused", "paused")]), null))).toBe("Runtime: 1 waiting")
  })

  it("renders paused runtime jobs as waiting instead of spinning active work", async () => {
    runtimeDbMocks.runtimeJobList.mockResolvedValue(list([job("job-paused", "paused")]))

    const { container, root } = renderActivityPanel()
    await flush()
    await flush()
    const toggle = container.querySelector("[data-testid='activity-panel-toggle']")!

    expect(container.textContent).toContain("Runtime: 1 waiting")
    expect(container.textContent).not.toContain("Runtime: 1 active")
    expect(toggle.querySelector("svg.animate-spin")).toBeNull()

    unmount(root)
  })

  it("renders failed runtime priority with an error icon even when another runtime job is active", async () => {
    runtimeDbMocks.runtimeJobList.mockResolvedValue(list([
      job("job-failed", "failed"),
      job("job-running", "running"),
    ]))

    const { container, root } = renderActivityPanel()
    await flush()
    await flush()
    const toggle = container.querySelector("[data-testid='activity-panel-toggle']")!

    expect(container.textContent).toContain("Runtime: 1 failed")
    expect(toggle.querySelector("svg.animate-spin")).toBeNull()
    expect(toggle.querySelector("svg.text-destructive")).not.toBeNull()

    unmount(root)
  })

  it("renders retry-wait runtime jobs as waiting without a collapsed spinner", async () => {
    runtimeDbMocks.runtimeJobList.mockResolvedValue(list([job("job-retry", "retry-wait")]))

    const { container, root } = renderActivityPanel()
    await flush()
    await flush()
    const toggle = container.querySelector("[data-testid='activity-panel-toggle']")!

    expect(container.textContent).toContain("Runtime: 1 waiting")
    expect(toggle.querySelector("svg.animate-spin")).toBeNull()

    unmount(root)
  })

  it("flags a running job with a stale heartbeat as suspected-stuck without triggering the worker-waiting text", async () => {
    const now = Date.now()
    runtimeDbMocks.runtimeJobList.mockResolvedValue(
      list(
        [bulkPrepareJob("bulk-stale", "running", { planId: "plan-stale", batchTotal: 1, uniqueSourceTotal: 1 })],
        true,
        "healthy",
        [lease("bulk-stale", { heartbeatAtMs: now - 20_000, expiresAtMs: now + 100_000 })],
      ),
    )

    const { container, root } = renderHarness()
    await flush()

    expect(container.querySelector("[data-testid='runtime-job-row-suspected-stuck-bulk-stale']")).not.toBeNull()
    expect(container.querySelector("[data-testid='runtime-diagnostics-worker-waiting']")).toBeNull()

    unmount(root)
  })

  it("flags a running job with a hard-expired lease as suspected-stuck", async () => {
    const now = Date.now()
    runtimeDbMocks.runtimeJobList.mockResolvedValue(
      list(
        [job("job-expired", "running")],
        true,
        "healthy",
        [lease("job-expired", { heartbeatAtMs: now - 1_000, expiresAtMs: now - 1_000 })],
      ),
    )

    const { container, root } = renderHarness()
    await flush()

    expect(container.querySelector("[data-testid='runtime-job-row-suspected-stuck-job-expired']")).not.toBeNull()

    unmount(root)
  })

  it("flags a running job with no lease record at all as suspected-stuck", async () => {
    runtimeDbMocks.runtimeJobList.mockResolvedValue(list([job("job-no-lease", "running")]))

    const { container, root } = renderHarness()
    await flush()

    expect(container.querySelector("[data-testid='runtime-job-row-suspected-stuck-job-no-lease']")).not.toBeNull()

    unmount(root)
  })

  it("treats a retry-wait job with only a released lease as awaiting a worker", async () => {
    runtimeDbMocks.runtimeJobList.mockResolvedValue(
      list(
        [bulkPrepareJob("bulk-retry", "retry-wait", { planId: "plan-retry", batchTotal: 1, uniqueSourceTotal: 1 })],
        true,
        "healthy",
        [lease("bulk-retry", { status: "released", releasedAtMs: 100 })],
      ),
    )

    const { container, root } = renderHarness()
    await flush()

    expect(container.querySelector("[data-testid='runtime-diagnostics-worker-waiting']")).not.toBeNull()

    unmount(root)
  })

  it("aggregates prepare totals per plan instead of across every prepare job (regression: old code returned 2/2)", async () => {
    runtimeDbMocks.runtimeJobList.mockResolvedValue(list([
      bulkPrepareJob("planA-1", "completed", { planId: "plan-a", batchTotal: 2, uniqueSourceTotal: 2 }),
      bulkPrepareJob("planA-2", "completed", { planId: "plan-a", batchTotal: 2, uniqueSourceTotal: 2 }),
      bulkPrepareJob("planB-1", "queued", { planId: "plan-b", batchTotal: 2, uniqueSourceTotal: 2 }),
    ]))

    const { container, root } = renderHarness()
    await flush()

    expect(container.textContent).toContain("2/4 prepare jobs")
    expect(container.textContent).not.toContain("2/2 prepare jobs")

    unmount(root)
  })

  it("still flags a queued job in one plan as awaiting a worker even when another plan already has progress", async () => {
    runtimeDbMocks.runtimeJobList.mockResolvedValue(list([
      bulkPrepareJob("planA-1", "running", { planId: "plan-a", batchTotal: 1, uniqueSourceTotal: 1 }),
      bulkPrepareJob("planB-1", "queued", { planId: "plan-b", batchTotal: 1, uniqueSourceTotal: 1 }),
    ]))
    runtimeDbMocks.runtimeProgressList.mockResolvedValue({
      enabled: true,
      status: "healthy",
      progress: [
        {
          jobId: "planA-1",
          progressKey: "bulk-prepare:worker:1",
          payload: "{}",
          updatedAtMs: 1,
          lastEventId: null,
        },
      ],
    })

    const { container, root } = renderHarness()
    await flush()

    expect(container.querySelector("[data-testid='runtime-diagnostics-worker-waiting']")).not.toBeNull()

    unmount(root)
  })

  it("counts unparseable prepare payloads separately without corrupting group totals", async () => {
    const badPayloadJob: RuntimeJobRecord = {
      ...job("bulk-bad", "queued"),
      kind: "bulk-knowledge-prepare",
      payload: "{not-json",
    }
    runtimeDbMocks.runtimeJobList.mockResolvedValue(list([
      bulkPrepareJob("plan-ok-1", "completed", { planId: "plan-ok", batchTotal: 1, uniqueSourceTotal: 1 }),
      badPayloadJob,
    ]))

    const { container, root } = renderHarness()
    await flush()

    expect(container.textContent).toContain("1/1 prepare jobs")
    const unparseableRow = container.querySelector("[data-testid='runtime-diagnostics-prepare-unparseable']")
    expect(unparseableRow).not.toBeNull()
    expect(unparseableRow?.textContent).toContain("1")

    unmount(root)
  })

  it("surfaces pending repair jobs with an honest no-consumer message", async () => {
    runtimeDbMocks.runtimeJobList.mockResolvedValue(list([
      { ...job("repair-1", "queued"), kind: "bulk-knowledge-artifact-repair" },
    ]))

    const { container, root } = renderHarness()
    await flush()

    const repairRow = container.querySelector("[data-testid='runtime-diagnostics-repair-pending']")
    expect(repairRow).not.toBeNull()
    expect(repairRow?.textContent).toContain("1")

    const kindRow = container.querySelector(
      "[data-testid='runtime-diagnostics-repair-pending-kind-bulk-knowledge-artifact-repair']",
    )
    expect(kindRow).not.toBeNull()
    expect(kindRow?.textContent).toContain("bulk-knowledge-artifact-repair")
    expect(kindRow?.textContent).toContain("1")
    expect(
      container.querySelector(
        "[data-testid='runtime-diagnostics-repair-pending-kind-bulk-knowledge-map-reduce-repair']",
      ),
    ).toBeNull()
    expect(
      container.querySelector("[data-testid='runtime-diagnostics-repair-pending-kind-markdown-conflict-repair']"),
    ).toBeNull()

    unmount(root)
  })

  it("renders a separate per-kind breakdown row for each repair kind with pending jobs", async () => {
    runtimeDbMocks.runtimeJobList.mockResolvedValue(list([
      { ...job("repair-1", "queued"), kind: "bulk-knowledge-artifact-repair" },
      { ...job("repair-2", "retry-wait"), kind: "bulk-knowledge-map-reduce-repair" },
      { ...job("repair-3", "queued"), kind: "bulk-knowledge-map-reduce-repair" },
    ]))

    const { container, root } = renderHarness()
    await flush()

    expect(container.querySelector("[data-testid='runtime-diagnostics-repair-pending']")?.textContent).toContain("3")
    expect(
      container.querySelector(
        "[data-testid='runtime-diagnostics-repair-pending-kind-bulk-knowledge-artifact-repair']",
      )?.textContent,
    ).toContain("1")
    expect(
      container.querySelector(
        "[data-testid='runtime-diagnostics-repair-pending-kind-bulk-knowledge-map-reduce-repair']",
      )?.textContent,
    ).toContain("2")

    unmount(root)
  })

  it("does not render the repair-pending row or per-kind breakdown when there are no pending repair jobs", async () => {
    runtimeDbMocks.runtimeJobList.mockResolvedValue(list([
      bulkPrepareJob("plan-ok-1", "completed", { planId: "plan-ok", batchTotal: 1, uniqueSourceTotal: 1 }),
    ]))

    const { container, root } = renderHarness()
    await flush()

    expect(container.querySelector("[data-testid='runtime-diagnostics-repair-pending']")).toBeNull()
    expect(container.querySelector("[data-testid^='runtime-diagnostics-repair-pending-kind-']")).toBeNull()

    unmount(root)
  })
})
