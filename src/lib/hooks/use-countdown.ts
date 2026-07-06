import { useEffect, useRef, useState } from "react"

export interface UseCountdownOptions {
  tickMs?: number
  onExpire?: () => void
}

function remainingUntil(deadlineMs: number | null | undefined): number {
  if (!deadlineMs) return 0
  return Math.max(0, deadlineMs - Date.now())
}

/** Returns the remaining milliseconds until a deadline, updating on a fixed tick. */
export function useCountdown(
  deadlineMs: number | null | undefined,
  options: UseCountdownOptions = {},
): number {
  const tickMs = options.tickMs ?? 1_000
  const onExpireRef = useRef(options.onExpire)
  const expiredRef = useRef(false)
  const [remainingMs, setRemainingMs] = useState(() => remainingUntil(deadlineMs))

  useEffect(() => {
    onExpireRef.current = options.onExpire
  }, [options.onExpire])

  useEffect(() => {
    expiredRef.current = false

    const update = () => {
      const next = remainingUntil(deadlineMs)
      setRemainingMs(next)
      if (deadlineMs && next === 0 && !expiredRef.current) {
        expiredRef.current = true
        onExpireRef.current?.()
      }
    }

    update()
    if (!deadlineMs || deadlineMs <= Date.now()) return

    const interval = window.setInterval(update, tickMs)
    return () => window.clearInterval(interval)
  }, [deadlineMs, tickMs])

  return remainingMs
}
