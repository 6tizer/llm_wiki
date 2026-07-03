import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { LintItem } from "@/stores/lint-store"
import type { ReviewItem } from "@/stores/review-store"
import type { Conversation } from "@/stores/chat-store"

// Adversarial coverage for the SPEC-11 PR1/D1 fix: switching the active
// project must not let auto-save's debounced writers clobber the outgoing
// project's review/chat/lint history with an empty-array snapshot, and
// must not silently drop a real edit that was still in flight when the
// switch happened.
//
// This is deliberately a separate file (not appended to
// reset-project-state.test.ts or auto-save.test.ts) so its persist-module
// mock and setupAutoSave() wiring can't leak into either of those
// existing suites.

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

function project(id: string, path: string) {
  return { id, name: id, path }
}

function lintItem(id: string): LintItem {
  return {
    id,
    type: "broken-link",
    severity: "warning",
    page: "wiki/a.md",
    detail: "Broken link",
    createdAt: 1,
  }
}

function reviewItem(id: string): ReviewItem {
  return {
    id,
    type: "confirm",
    title: id,
    description: "Confirm item",
    options: [],
    resolved: false,
    createdAt: 1,
  }
}

function conversation(id: string): Conversation {
  return {
    id,
    title: id,
    createdAt: 1,
    updatedAt: 1,
  }
}

async function setupFreshRace() {
  vi.resetModules()
  const [
    { setupAutoSave },
    { resetProjectState },
    { useWikiStore },
    { useLintStore },
    { useReviewStore },
    { useChatStore },
  ] = await Promise.all([
    import("./auto-save"),
    import("./reset-project-state"),
    import("@/stores/wiki-store"),
    import("@/stores/lint-store"),
    import("@/stores/review-store"),
    import("@/stores/chat-store"),
  ])

  useWikiStore.getState().setProject(null)
  useLintStore.getState().setItems([])
  useReviewStore.getState().setItems([])
  useChatStore.getState().clearMessages()
  useChatStore.getState().setConversations([])
  useChatStore.getState().setStreaming(false)
  setupAutoSave()

  return { resetProjectState, useWikiStore, useLintStore, useReviewStore, useChatStore }
}

describe("resetProjectState + auto-save — project switch race", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("① does not overwrite the outgoing project's review/lint/chat history with an empty-array snapshot", async () => {
    const { resetProjectState, useWikiStore, useLintStore, useReviewStore, useChatStore } = await setupFreshRace()

    useWikiStore.getState().setProject(project("A", "/tmp/a"))
    useReviewStore.getState().setItems([reviewItem("r1")])
    useLintStore.getState().setItems([lintItem("l1")])
    useChatStore.getState().setConversations([conversation("c1")])

    // Let the real edits actually land on disk before switching, so an
    // empty-array overwrite is distinguishable from "never wrote at all".
    await vi.advanceTimersByTimeAsync(2000)
    expect(persistMocks.saveReviewItems).toHaveBeenCalledWith("/tmp/a", [expect.objectContaining({ id: "r1" })])
    expect(persistMocks.saveLintItems).toHaveBeenCalledWith("/tmp/a", [expect.objectContaining({ id: "l1" })])
    expect(persistMocks.saveChatHistory).toHaveBeenCalledWith("/tmp/a", [expect.objectContaining({ id: "c1" })], [])

    persistMocks.saveReviewItems.mockClear()
    persistMocks.saveLintItems.mockClear()
    persistMocks.saveChatHistory.mockClear()

    // Switch away. resetProjectState clears the stores, which looks like a
    // real edit to auto-save's subscribers — still keyed to the outgoing
    // path, since useWikiStore.project hasn't flipped yet at this point.
    await resetProjectState()
    useWikiStore.getState().setProject(project("B", "/tmp/b"))

    // Let any spuriously re-queued empty-array timer run its course.
    await vi.advanceTimersByTimeAsync(3000)

    expect(persistMocks.saveReviewItems).not.toHaveBeenCalledWith("/tmp/a", [])
    expect(persistMocks.saveLintItems).not.toHaveBeenCalledWith("/tmp/a", [])
    expect(persistMocks.saveChatHistory).not.toHaveBeenCalledWith("/tmp/a", [], [])
  })

  it("② flushes a real edit made 300ms before switching instead of dropping it", async () => {
    const { resetProjectState, useWikiStore, useReviewStore } = await setupFreshRace()

    useWikiStore.getState().setProject(project("A", "/tmp/a"))
    useReviewStore.getState().setItems([reviewItem("late-edit")])

    // The edit is still sitting in its 1s debounce timer when the user
    // switches projects.
    await vi.advanceTimersByTimeAsync(300)
    expect(persistMocks.saveReviewItems).not.toHaveBeenCalled()

    await resetProjectState()

    expect(persistMocks.saveReviewItems).toHaveBeenCalledWith("/tmp/a", [
      expect.objectContaining({ id: "late-edit" }),
    ])
  })

  it("③ the TOCTOU guard alone (bypassing resetProjectState) still blocks a stale write", async () => {
    const { useWikiStore, useReviewStore } = await setupFreshRace()

    useWikiStore.getState().setProject(project("A", "/tmp/a"))
    useReviewStore.getState().setItems([reviewItem("stale")])

    // Simulate a bypass of resetProjectState's flush/cancel: the active
    // project changes directly out from under the pending timer.
    useWikiStore.getState().setProject(project("B", "/tmp/b"))

    await vi.advanceTimersByTimeAsync(1000)

    expect(persistMocks.saveReviewItems).not.toHaveBeenCalled()
  })

  it("④ three consecutive fast switches (A→B→C) leave no cross-project contamination", async () => {
    const { resetProjectState, useWikiStore, useReviewStore } = await setupFreshRace()

    useWikiStore.getState().setProject(project("A", "/tmp/a"))
    useReviewStore.getState().setItems([reviewItem("a-item")])
    await resetProjectState()
    useWikiStore.getState().setProject(project("B", "/tmp/b"))

    useReviewStore.getState().setItems([reviewItem("b-item")])
    await resetProjectState()
    useWikiStore.getState().setProject(project("C", "/tmp/c"))

    useReviewStore.getState().setItems([reviewItem("c-item")])
    await vi.advanceTimersByTimeAsync(1000)

    expect(persistMocks.saveReviewItems).toHaveBeenCalledWith("/tmp/a", [
      expect.objectContaining({ id: "a-item" }),
    ])
    expect(persistMocks.saveReviewItems).toHaveBeenCalledWith("/tmp/b", [
      expect.objectContaining({ id: "b-item" }),
    ])
    expect(persistMocks.saveReviewItems).toHaveBeenCalledWith("/tmp/c", [
      expect.objectContaining({ id: "c-item" }),
    ])
    expect(persistMocks.saveReviewItems).not.toHaveBeenCalledWith("/tmp/a", [])
    expect(persistMocks.saveReviewItems).not.toHaveBeenCalledWith("/tmp/b", [])
  })
})
