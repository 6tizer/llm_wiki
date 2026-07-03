import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { LintResult } from "@/lib/lint"

// Adversarial coverage for SPEC-11 D1: the agent structural lint queue runs
// a real async scan (runStructuralLint) that can still be in flight when the
// user switches projects. Before the project-generation fix, drainQueue's
// `await` continuation had no way to tell the switch happened and would
// call replaceAgentItems() with project A's stale results after B was
// already active — auto-save would then persist those results into B's
// lint.json. This file exercises that exact race with a controllable
// (deferred) mock of runStructuralLint.
//
// Deliberately a separate file so its "@/lib/lint" mock and setupAutoSave()
// wiring can't leak into agent-lint-queue.test.ts or the other
// reset-project-state suites.

const persistMocks = vi.hoisted(() => ({
  saveReviewItems: vi.fn(async () => undefined),
  saveLintItems: vi.fn(async () => undefined),
  saveChatHistory: vi.fn(async () => undefined),
}))

vi.mock("./persist", () => persistMocks)

vi.mock("./ingest-queue", async () => {
  const actual = await vi.importActual<typeof import("./ingest-queue")>("./ingest-queue")
  return {
    ...actual,
    pauseQueue: vi.fn(async () => {}),
  }
})

vi.mock("./graph-relevance", () => ({
  clearGraphCache: vi.fn(),
}))

const lintMocks = vi.hoisted(() => ({
  runStructuralLint: vi.fn(),
}))

vi.mock("@/lib/lint", () => lintMocks)

function project(id: string, path: string) {
  return { id, name: id, path }
}

function staleResult(page: string): LintResult {
  return {
    type: "broken-link",
    severity: "warning",
    page,
    detail: "stale scan result",
  }
}

/** A promise whose resolution is controlled from the test body. */
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => { resolve = r })
  return { promise, resolve }
}

async function setupFreshLintRace() {
  vi.resetModules()
  const [
    { setupAutoSave },
    { resetProjectState },
    { useWikiStore },
    { useLintStore },
    { enqueueAgentStructuralLint },
  ] = await Promise.all([
    import("./auto-save"),
    import("./reset-project-state"),
    import("@/stores/wiki-store"),
    import("@/stores/lint-store"),
    import("@/lib/agent/agent-lint-queue"),
  ])

  useWikiStore.getState().setProject(null)
  useLintStore.getState().setItems([])
  setupAutoSave()

  return { resetProjectState, useWikiStore, useLintStore, enqueueAgentStructuralLint }
}

describe("agent-lint-queue + resetProjectState — in-flight scan race", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("discards an in-flight scan's results when the project switches before it resolves", async () => {
    const { resetProjectState, useWikiStore, useLintStore, enqueueAgentStructuralLint } =
      await setupFreshLintRace()

    const { promise: scanPromise, resolve: resolveScan } = deferred<LintResult[]>()
    lintMocks.runStructuralLint.mockReturnValue(scanPromise)

    useWikiStore.getState().setProject(project("A", "/tmp/a"))
    enqueueAgentStructuralLint("/tmp/a", ["wiki/a.md"], 0)

    // Let the debounce timer fire and drainQueue start the scan — it
    // suspends at `await runStructuralLint(...)`, i.e. genuinely in flight.
    await vi.advanceTimersByTimeAsync(0)
    expect(lintMocks.runStructuralLint).toHaveBeenCalledWith("/tmp/a")
    expect(useLintStore.getState().agentLint.status).toBe("running")

    // Switch projects while the scan is still pending. resetProjectState's
    // own store clears (unrelated to this scan) can legitimately queue and
    // flush an empty-array write for the outgoing project — clear the mock
    // afterward so the assertion below is scoped to what happens once the
    // stale scan itself resolves.
    await resetProjectState()
    useWikiStore.getState().setProject(project("B", "/tmp/b"))
    persistMocks.saveLintItems.mockClear()

    // Now the stale scan resolves with A's results.
    resolveScan([staleResult("stale-a.md")])
    await vi.advanceTimersByTimeAsync(0)
    // Give any remaining microtask continuations a chance to run.
    await Promise.resolve()
    await Promise.resolve()

    // The results must never have reached the lint store...
    expect(useLintStore.getState().items).toEqual([])
    // ...and the stale resolution must not have queued (or written) any
    // save at all — it's discarded before touching useLintStore, so no
    // subscriber fires and nothing new is queued for either project's
    // lint.json.
    await vi.advanceTimersByTimeAsync(2000)
    expect(persistMocks.saveLintItems).not.toHaveBeenCalled()
  })

  it("does not discard results when no project switch happens while the scan is in flight", async () => {
    const { useWikiStore, useLintStore, enqueueAgentStructuralLint } = await setupFreshLintRace()

    const { promise: scanPromise, resolve: resolveScan } = deferred<LintResult[]>()
    lintMocks.runStructuralLint.mockReturnValue(scanPromise)

    useWikiStore.getState().setProject(project("A", "/tmp/a"))
    enqueueAgentStructuralLint("/tmp/a", ["wiki/a.md"], 0)
    await vi.advanceTimersByTimeAsync(0)

    resolveScan([staleResult("fresh-a.md")])
    await vi.advanceTimersByTimeAsync(0)
    await Promise.resolve()
    await Promise.resolve()

    expect(useLintStore.getState().items).toMatchObject([{ page: "fresh-a.md", source: "agent" }])
    expect(useLintStore.getState().agentLint.status).toBe("done")

    await vi.advanceTimersByTimeAsync(1000)
    expect(persistMocks.saveLintItems).toHaveBeenCalledWith(
      "/tmp/a",
      expect.arrayContaining([expect.objectContaining({ page: "fresh-a.md" })])
    )
  })
})
