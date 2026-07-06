// @vitest-environment jsdom

import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { useCountdown } from "./use-countdown"

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true

function renderCountdown(
  deadlineMs: number | null,
  onExpire = vi.fn(),
): { root: Root; getRemaining: () => number } {
  const container = document.createElement("div")
  document.body.appendChild(container)
  const root = createRoot(container)
  let remaining = -1

  function Harness({ deadlineMs }: { deadlineMs: number | null }) {
    remaining = useCountdown(deadlineMs, { onExpire })
    return null
  }

  act(() => {
    root.render(<Harness deadlineMs={deadlineMs} />)
  })

  return { root, getRemaining: () => remaining }
}

describe("useCountdown", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
  })

  afterEach(() => {
    vi.useRealTimers()
    document.body.innerHTML = ""
  })

  it("ticks down and calls onExpire once when the deadline reaches zero", async () => {
    const onExpire = vi.fn()
    const { root, getRemaining } = renderCountdown(Date.now() + 2_500, onExpire)

    expect(getRemaining()).toBe(2_500)

    await act(async () => {
      vi.advanceTimersByTime(1_000)
    })
    expect(getRemaining()).toBe(1_500)
    expect(onExpire).not.toHaveBeenCalled()

    await act(async () => {
      vi.advanceTimersByTime(2_000)
    })
    expect(getRemaining()).toBe(0)
    expect(onExpire).toHaveBeenCalledTimes(1)

    await act(async () => {
      vi.advanceTimersByTime(5_000)
    })
    expect(onExpire).toHaveBeenCalledTimes(1)

    act(() => {
      root.unmount()
    })
  })
})
