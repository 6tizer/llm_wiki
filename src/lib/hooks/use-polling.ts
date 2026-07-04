import { useEffect, useRef } from "react"

export interface UsePollingOptions {
  /** Whether the loop keeps scheduling another tick after this one finishes. */
  enabled: boolean
  /**
   * When this changes (`Object.is`), any chain started before the change is
   * abandoned and a fresh one starts immediately — e.g. pass the active
   * project's id/path so switching projects restarts polling right away
   * instead of waiting out whatever cadence the OLD project's chain was on.
   * Mirrors the pre-extraction `[project, refresh]` effect dependency in
   * `runtime-jobs-section.tsx`. Optional: a hook with no restart-worthy
   * identity (rare) can omit it.
   */
  restartKey?: unknown
  /** Runs one poll iteration (fetch + apply side effects to caller state). */
  poll: () => Promise<void>
  /** Delay before the NEXT tick, read fresh right after `poll` resolves (so `poll` can update the value a caller-owned ref points at, e.g. a faster cadence while jobs are active). */
  getDelayMs: () => number
}

export interface UsePollingResult {
  /**
   * Resets the poll cadence: clears any pending timer, runs `poll`
   * immediately (or, if a poll is already in flight, exactly once more as
   * soon as it settles — see the single-flight note below), and reschedules
   * from the fresh delay. This is the fix for "external trigger doesn't
   * reset the timer" (SPEC-6 PR6 decision 4 /
   * spec-5-8-post-review-findings.md:108): calling `poll` directly
   * (bypassing this) left the ALREADY-SCHEDULED timer from the previous
   * tick armed alongside the ad-hoc extra fetch, so an action-triggered
   * refresh never actually changed the poll cadence.
   *
   * Single-flight (Tester P1#3 / Codex P2 fix round): if a poll is already
   * in flight when this is called, it does NOT start a second concurrent
   * one — it flags a pending refresh, and the in-flight poll's own
   * completion runs exactly one more time (for whatever is current at that
   * point) before falling back to the normal reschedule. Multiple
   * overlapping `refreshNow()` calls while busy coalesce into that single
   * follow-up run, never stack up N of them.
   */
  refreshNow: () => Promise<void>
}

/**
 * Timer-handle-based polling loop (SPEC-6 PR6 decision 4), extracted from
 * `runtime-jobs-section.tsx`'s bespoke poll effect so `derived-status`
 * polling can share it. `poll` runs once whenever `enabled`/`restartKey`
 * changes (including on mount), and the loop keeps rescheduling itself via
 * `setTimeout` (never `setInterval`, so a slow `poll` can't cause two ticks
 * to overlap) only while `enabled` stays true.
 *
 * Generation-counter design (internal-review P1 fix, chosen over a shared
 * `cancelledRef` boolean specifically because this app's root renders
 * under `StrictMode` — `main.tsx`): a boolean cancelled flag is flipped
 * back to `false` by the SECOND of StrictMode's synchronous
 * mount→cleanup→mount effect pair before the FIRST mount's in-flight
 * `poll()` promise ever gets a chance to resolve, so the first (throwaway)
 * chain's completion handler would incorrectly see itself as still
 * current and reschedule its own second, redundant timer — two live
 * chains instead of one. A monotonically increasing generation number
 * doesn't have this problem: each effect run captures its OWN generation,
 * and a poll's completion only reschedules when the CURRENT generation
 * still matches the one it started with. `refreshNow()` reuses the exact
 * same "generation still current + nothing in flight" plumbing to get
 * single-flight coalescing for free, rather than a separate mechanism.
 */
export function usePolling(options: UsePollingOptions): UsePollingResult {
  const optionsRef = useRef(options)
  optionsRef.current = options
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const generationRef = useRef(0)
  const inFlightRef = useRef(false)
  const pendingRef = useRef(false)

  function clearTimer(): void {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }

  async function runPoll(generation: number): Promise<void> {
    inFlightRef.current = true
    try {
      await optionsRef.current.poll()
    } finally {
      inFlightRef.current = false
    }
    if (pendingRef.current) {
      // Single-flight supersede: at least one `kick`/`refreshNow` landed
      // while this poll was in flight. Coalesce into exactly one more run
      // for whatever generation is current NOW, instead of stacking one
      // run per call that arrived while busy.
      pendingRef.current = false
      void kick(generationRef.current)
      return
    }
    if (generationRef.current !== generation) return // this chain was abandoned (unmount / restartKey change) while we awaited `poll()`
    if (!optionsRef.current.enabled) return
    clearTimer()
    timerRef.current = setTimeout(() => {
      void kick(generationRef.current)
    }, optionsRef.current.getDelayMs())
  }

  function kick(generation: number): Promise<void> {
    clearTimer()
    if (inFlightRef.current) {
      // Single-flight: don't start a second concurrent poll. `runPoll`'s
      // completion handler above checks `pendingRef` and runs again once
      // the in-flight call settles. Sole guard for this invariant —
      // `refreshNow` delegates here instead of repeating the check.
      pendingRef.current = true
      return Promise.resolve()
    }
    return runPoll(generation)
  }

  useEffect(() => {
    const generation = ++generationRef.current
    void kick(generation)
    return () => {
      clearTimer()
      // Invalidate this chain. If a poll from it is still in flight, its
      // completion handler's generation check will see the mismatch and
      // stop instead of rescheduling — UNLESS a same-tick `useEffect`
      // re-run (deps changed) also calls `kick` with the new generation
      // while that poll is still in flight, which flags `pendingRef` and
      // lets the in-flight poll's completion hand off to the new
      // generation once it settles (see `runPoll`).
      generationRef.current += 1
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `runPoll`/`kick` always read the latest options via optionsRef; only enabled/restartKey should restart the chain.
  }, [options.enabled, options.restartKey])

  function refreshNow(): Promise<void> {
    return kick(generationRef.current)
  }

  return { refreshNow }
}
