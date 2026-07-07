import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { enqueueAgentStructuralLint } from "@/lib/agent/agent-lint-queue"
import { sweepResolvedReviews } from "@/lib/sweep-reviews"
import {
  clearWikiChangeNotifications,
  notifyWikiPathsChanged,
} from "./wiki-change-notifier"

const notifierMocks = vi.hoisted(() => ({
  enqueueAgentStructuralLint: vi.fn(),
  sweepResolvedReviews: vi.fn(),
}))

vi.mock("@/lib/agent/agent-lint-queue", () => ({
  enqueueAgentStructuralLint: notifierMocks.enqueueAgentStructuralLint,
}))

vi.mock("@/lib/sweep-reviews", () => ({
  sweepResolvedReviews: notifierMocks.sweepResolvedReviews,
}))

const mockedEnqueueAgentStructuralLint = vi.mocked(enqueueAgentStructuralLint)
const mockedSweepResolvedReviews = vi.mocked(sweepResolvedReviews)

describe("wiki-change-notifier", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    clearWikiChangeNotifications()
    mockedEnqueueAgentStructuralLint.mockReset()
    mockedSweepResolvedReviews.mockReset()
    mockedSweepResolvedReviews.mockResolvedValue(0)
  })

  afterEach(() => {
    clearWikiChangeNotifications()
    vi.useRealTimers()
  })

  it("debounces same-project writes and forwards merged paths once", async () => {
    notifyWikiPathsChanged("/project", ["wiki/a.md"], 10)
    notifyWikiPathsChanged("/project", ["wiki/b.md", "wiki/a.md"], 10)

    await vi.advanceTimersByTimeAsync(9)
    expect(mockedSweepResolvedReviews).not.toHaveBeenCalled()
    expect(mockedEnqueueAgentStructuralLint).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1)

    expect(mockedEnqueueAgentStructuralLint).toHaveBeenCalledWith(
      "/project",
      ["a.md", "b.md"],
    )
    expect(mockedSweepResolvedReviews).toHaveBeenCalledWith("/project", expect.any(AbortSignal))
  })

  it("normalizes mixed wiki-prefixed and wiki-root-relative paths before enqueueing", async () => {
    notifyWikiPathsChanged("/project", ["concepts/LLM.md", "wiki/concepts/LLM.md"], 10)

    await vi.advanceTimersByTimeAsync(10)

    expect(mockedEnqueueAgentStructuralLint).toHaveBeenCalledWith(
      "/project",
      ["concepts/LLM.md"],
    )
    expect(mockedSweepResolvedReviews).toHaveBeenCalledWith("/project", expect.any(AbortSignal))
  })

  it("runs a follow-up batch when writes arrive during a sweep", async () => {
    let finishSweep: (value: number) => void = () => undefined
    mockedSweepResolvedReviews.mockReturnValueOnce(
      new Promise<number>((resolve) => {
        finishSweep = resolve
      }),
    )
    mockedSweepResolvedReviews.mockResolvedValue(0)

    notifyWikiPathsChanged("/project", ["wiki/a.md"], 1)
    await vi.advanceTimersByTimeAsync(1)

    notifyWikiPathsChanged("/project", ["wiki/b.md"], 1)
    await vi.advanceTimersByTimeAsync(1)
    expect(mockedSweepResolvedReviews).toHaveBeenCalledTimes(1)

    finishSweep(0)
    await Promise.resolve()
    await vi.runOnlyPendingTimersAsync()

    expect(mockedEnqueueAgentStructuralLint).toHaveBeenNthCalledWith(2, "/project", ["b.md"])
    expect(mockedSweepResolvedReviews).toHaveBeenCalledTimes(2)
  })

  it("clears a pending notification before the debounce fires", async () => {
    notifyWikiPathsChanged("/project", ["wiki/a.md"], 10)
    clearWikiChangeNotifications()

    await vi.advanceTimersByTimeAsync(10)

    expect(mockedEnqueueAgentStructuralLint).not.toHaveBeenCalled()
    expect(mockedSweepResolvedReviews).not.toHaveBeenCalled()
  })

  it("aborts an active sweep when notifications are cleared", async () => {
    let signal: AbortSignal | undefined
    let finishSweep: (value: number) => void = () => undefined
    mockedSweepResolvedReviews.mockImplementationOnce((_projectPath, sweepSignal) => {
      signal = sweepSignal
      return new Promise<number>((resolve) => {
        finishSweep = resolve
      })
    })

    notifyWikiPathsChanged("/project", ["wiki/a.md"], 1)
    await vi.advanceTimersByTimeAsync(1)

    expect(signal?.aborted).toBe(false)
    clearWikiChangeNotifications()

    expect(signal?.aborted).toBe(true)
    finishSweep(0)
    await Promise.resolve()
  })
})
