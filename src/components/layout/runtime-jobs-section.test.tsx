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
import type { RuntimeJobList, RuntimeJobRecord, RuntimeJobState } from "@/commands/runtime-db"

const runtimeDbMocks = vi.hoisted(() => ({
  runtimeJobList: vi.fn(),
  runtimeJobCancel: vi.fn(),
  runtimeJobPause: vi.fn(),
  runtimeJobResume: vi.fn(),
  runtimeDbHealth: vi.fn(),
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

function list(jobs: RuntimeJobRecord[], enabled = true, status: RuntimeJobList["status"] = "healthy"): RuntimeJobList {
  return { enabled, status, jobs, leases: [] }
}

function setProject(open: boolean): void {
  useWikiStore.getState().setProject(open ? { id: "p1", name: "Project", path: "/project" } : null)
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

  it("renders compact list and action errors without calling runtime_db_health", async () => {
    runtimeDbMocks.runtimeJobList.mockRejectedValueOnce(new Error("db is damaged"))
    runtimeDbMocks.runtimeJobList.mockResolvedValue(list([job("job-queued", "queued")]))
    runtimeDbMocks.runtimeJobPause.mockRejectedValue(new Error("pause failed"))

    const { container, root } = renderHarness()
    await flush()

    expect(container.querySelector("[data-testid='runtime-jobs-error']")?.textContent).toContain("db is damaged")
    expect(runtimeDbMocks.runtimeDbHealth).not.toHaveBeenCalled()

    await act(async () => {
      vi.advanceTimersByTime(2_000)
      await Promise.resolve()
    })
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
})
