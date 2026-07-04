// @vitest-environment jsdom

import { act, StrictMode } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { usePolling, type UsePollingResult } from "./use-polling"

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true

function renderPolling(
  poll: () => Promise<void>,
  getDelayMs: () => number,
  enabled = true,
): { root: Root; container: HTMLDivElement; getResult: () => UsePollingResult | null } {
  const container = document.createElement("div")
  document.body.appendChild(container)
  const root = createRoot(container)
  let result: UsePollingResult | null = null

  function Harness({ enabled }: { enabled: boolean }) {
    result = usePolling({ enabled, poll, getDelayMs })
    return null
  }

  act(() => {
    root.render(<Harness enabled={enabled} />)
  })

  return { root, container, getResult: () => result }
}

describe("usePolling", () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    document.body.innerHTML = ""
  })

  it("runs poll once on mount and schedules the next tick using getDelayMs", async () => {
    const poll = vi.fn().mockResolvedValue(undefined)
    const { root } = renderPolling(poll, () => 1_000)
    await act(async () => {
      await Promise.resolve()
    })
    expect(poll).toHaveBeenCalledTimes(1)

    await act(async () => {
      vi.advanceTimersByTime(1_000)
      await Promise.resolve()
    })
    expect(poll).toHaveBeenCalledTimes(2)

    root.unmount()
  })

  it("regression lock: refreshNow clears the pending timer instead of leaving a stale one armed alongside the extra fetch", async () => {
    const poll = vi.fn().mockResolvedValue(undefined)
    const { root, getResult } = renderPolling(poll, () => 2_000)
    await act(async () => {
      await Promise.resolve()
    })
    expect(poll).toHaveBeenCalledTimes(1)

    // Half way through the 2s cadence, an external action triggers a refresh.
    await act(async () => {
      vi.advanceTimersByTime(1_000)
    })
    await act(async () => {
      await getResult()!.refreshNow()
    })
    expect(poll).toHaveBeenCalledTimes(2)

    // The OLD timer (which would have fired 1s from here, at the original
    // 2s mark) must be cleared — advancing only 1s more must NOT fire it.
    await act(async () => {
      vi.advanceTimersByTime(1_000)
      await Promise.resolve()
    })
    expect(poll).toHaveBeenCalledTimes(2)

    // The NEW schedule (2s from the refreshNow call) fires next.
    await act(async () => {
      vi.advanceTimersByTime(1_000)
      await Promise.resolve()
    })
    expect(poll).toHaveBeenCalledTimes(3)

    root.unmount()
  })

  it("sabotage regression: calling poll directly (bypassing refreshNow) leaves the stale timer armed — documents exactly the bug this hook fixes", async () => {
    const poll = vi.fn().mockResolvedValue(undefined)
    const { root } = renderPolling(poll, () => 2_000)
    await act(async () => {
      await Promise.resolve()
    })
    expect(poll).toHaveBeenCalledTimes(1)

    await act(async () => {
      vi.advanceTimersByTime(1_000)
    })
    // Bypass refreshNow: call poll directly, mimicking the pre-fix bug shape.
    await act(async () => {
      await poll()
    })
    expect(poll).toHaveBeenCalledTimes(2)

    // The original timer (armed at mount for 2s) still fires 1s later,
    // proving a direct poll() call does NOT reset the cadence — this is the
    // exact bug usePolling's refreshNow fixes.
    await act(async () => {
      vi.advanceTimersByTime(1_000)
      await Promise.resolve()
    })
    expect(poll).toHaveBeenCalledTimes(3)

    root.unmount()
  })

  it("stops scheduling once enabled becomes false, and cleans up on unmount", async () => {
    const poll = vi.fn().mockResolvedValue(undefined)
    const container = document.createElement("div")
    document.body.appendChild(container)
    const root = createRoot(container)

    function Harness({ enabled }: { enabled: boolean }) {
      usePolling({ enabled, poll, getDelayMs: () => 1_000 })
      return null
    }

    act(() => {
      root.render(<Harness enabled={true} />)
    })
    await act(async () => {
      await Promise.resolve()
    })
    expect(poll).toHaveBeenCalledTimes(1)

    act(() => {
      root.render(<Harness enabled={false} />)
    })
    await act(async () => {
      await Promise.resolve()
    })
    // Effect re-ran once (enabled flipped) so poll ran one more time, but no further scheduling.
    expect(poll).toHaveBeenCalledTimes(2)

    await act(async () => {
      vi.advanceTimersByTime(10_000)
      await Promise.resolve()
    })
    expect(poll).toHaveBeenCalledTimes(2)

    act(() => {
      root.unmount()
    })
  })

  it("does not fire a scheduled tick after unmount", async () => {
    const poll = vi.fn().mockResolvedValue(undefined)
    const { root } = renderPolling(poll, () => 1_000)
    await act(async () => {
      await Promise.resolve()
    })
    expect(poll).toHaveBeenCalledTimes(1)

    root.unmount()

    await act(async () => {
      vi.advanceTimersByTime(5_000)
      await Promise.resolve()
    })
    expect(poll).toHaveBeenCalledTimes(1)
  })

  it("single-flight: refreshNow while a poll is in flight does not start a second concurrent poll, and coalesces into exactly one more run once it settles", async () => {
    let resolvePoll: (() => void) | null = null
    const poll = vi.fn().mockImplementation(
      () => new Promise<void>((resolve) => { resolvePoll = resolve }),
    )
    const { getResult } = renderPolling(poll, () => 5_000)
    await act(async () => {
      await Promise.resolve()
    })
    expect(poll).toHaveBeenCalledTimes(1) // initial poll started, still unresolved (in flight)

    // Two refreshNow calls land while the initial poll is still in flight.
    await act(async () => {
      void getResult()!.refreshNow()
      void getResult()!.refreshNow()
      await Promise.resolve()
    })
    // Single-flight: neither call started a second concurrent poll.
    expect(poll).toHaveBeenCalledTimes(1)

    // Settle the in-flight poll.
    const firstResolve = resolvePoll!
    await act(async () => {
      firstResolve()
      await Promise.resolve()
      await Promise.resolve()
    })
    // The two coalesced refreshNow calls produced exactly ONE extra run, not two.
    expect(poll).toHaveBeenCalledTimes(2)

    // Settle the coalesced run too, then confirm the loop still reschedules normally afterward.
    const secondResolve = resolvePoll!
    await act(async () => {
      secondResolve()
      await Promise.resolve()
    })
    await act(async () => {
      vi.advanceTimersByTime(5_000)
      await Promise.resolve()
    })
    expect(poll).toHaveBeenCalledTimes(3)
  })

  it("restartKey change abandons the old chain's schedule and starts a fresh one immediately", async () => {
    const poll = vi.fn().mockResolvedValue(undefined)
    const container = document.createElement("div")
    document.body.appendChild(container)
    const root = createRoot(container)

    function Harness({ restartKey }: { restartKey: string }) {
      usePolling({ enabled: true, restartKey, poll, getDelayMs: () => 5_000 })
      return null
    }

    act(() => {
      root.render(<Harness restartKey="project-a" />)
    })
    await act(async () => {
      await Promise.resolve()
    })
    expect(poll).toHaveBeenCalledTimes(1)

    // Halfway through the 5s cadence, the project switches — must restart NOW.
    await act(async () => {
      vi.advanceTimersByTime(2_000)
    })
    act(() => {
      root.render(<Harness restartKey="project-b" />)
    })
    await act(async () => {
      await Promise.resolve()
    })
    expect(poll).toHaveBeenCalledTimes(2)

    // The OLD schedule (due 3s from here, at the original 5s mark) must be cleared.
    await act(async () => {
      vi.advanceTimersByTime(3_000)
      await Promise.resolve()
    })
    expect(poll).toHaveBeenCalledTimes(2)

    // The NEW schedule (5s from the restartKey change) fires next.
    await act(async () => {
      vi.advanceTimersByTime(2_000)
      await Promise.resolve()
    })
    expect(poll).toHaveBeenCalledTimes(3)

    root.unmount()
  })

  it("StrictMode double-mount: only one polling chain survives (generation-counter regression lock for the shared cancelledRef bug)", async () => {
    const poll = vi.fn().mockResolvedValue(undefined)
    const container = document.createElement("div")
    document.body.appendChild(container)
    const root = createRoot(container)

    function Harness() {
      usePolling({ enabled: true, restartKey: "p", poll, getDelayMs: () => 2_000 })
      return null
    }

    act(() => {
      root.render(
        <StrictMode>
          <Harness />
        </StrictMode>,
      )
    })
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })
    // StrictMode double-invokes the effect (mount -> cleanup -> mount) in
    // dev. The throwaway first mount's poll may still fire once (its async
    // call was already started before cleanup could cancel it), so assert
    // on the POST-SETTLE schedule cadence rather than the raw call count.
    const callsAfterMount = poll.mock.calls.length
    expect(callsAfterMount).toBeGreaterThan(0)

    await act(async () => {
      vi.advanceTimersByTime(2_000)
      await Promise.resolve()
    })
    // If two chains had survived, both would independently reschedule and
    // fire on this tick, advancing the count by 2. Exactly one surviving
    // chain advances it by exactly 1.
    expect(poll.mock.calls.length).toBe(callsAfterMount + 1)

    root.unmount()
  })
})
