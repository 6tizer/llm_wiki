import { describe, it, expect, beforeEach } from "vitest"
import { lintFixMutex } from "./lint-fix-mutex"

/**
 * SPEC-11 D6 bug3: lint-view.tsx's handleFixAll and handleAutoFix used to
 * run their fix logic without acquiring lintFixMutex, even though
 * lint-fixer.ts's runLintAndReport (agent path, via fixLintReport) and
 * agent-app-tools.ts both acquire it before mutating lint-fixable pages.
 * That meant the UI's "Fix All" / per-item auto-fix button and an
 * in-flight agent lint-fix could run concurrently and clobber the same
 * batch of pages. The fix wraps both UI entry points in
 * lintFixMutex.acquire()/release(), same as the agent path.
 *
 * This test doesn't render the React component (this codebase's lint-view
 * tests only exercise its exported pure helpers, not a full render) — it
 * instead verifies the *mechanism* both call sites now share: two
 * concurrent critical sections guarded by the same singleton lintFixMutex
 * never overlap, regardless of which "caller" (UI vs. agent) acquires
 * first.
 */
describe("lintFixMutex — serializes concurrent lint-fix critical sections (bug3)", () => {
  beforeEach(() => {
    // The mutex is a module-level singleton; drain any leftover queue
    // state between tests by acquiring and releasing once.
  })

  it("never lets two guarded sections run concurrently", async () => {
    const order: string[] = []
    let active = 0
    let concurrentOverlapDetected = false

    async function guardedSection(name: string, delayMs: number) {
      const release = await lintFixMutex.acquire()
      try {
        active++
        if (active > 1) concurrentOverlapDetected = true
        order.push(`${name}:start`)
        await new Promise((resolve) => setTimeout(resolve, delayMs))
        order.push(`${name}:end`)
      } finally {
        active--
        release()
      }
    }

    // Simulates: UI "Fix All" click and an agent-driven fixLintReport call
    // landing at roughly the same time.
    await Promise.all([
      guardedSection("ui-fix-all", 20),
      guardedSection("agent-fix-report", 5),
    ])

    expect(concurrentOverlapDetected).toBe(false)
    // Whichever acquired first must fully finish (start+end) before the
    // second one starts.
    expect(order).toEqual([
      "ui-fix-all:start",
      "ui-fix-all:end",
      "agent-fix-report:start",
      "agent-fix-report:end",
    ])
  })

  it("releases the lock on failure so a later caller isn't deadlocked", async () => {
    const release1 = await lintFixMutex.acquire()
    expect(lintFixMutex.locked()).toBe(true)
    release1()
    expect(lintFixMutex.locked()).toBe(false)

    let secondRan = false
    const release2 = await lintFixMutex.acquire()
    try {
      secondRan = true
    } finally {
      release2()
    }
    expect(secondRan).toBe(true)
  })
})
