import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { LintItem } from "@/stores/lint-store"
import type { ReviewItem } from "@/stores/review-store"
import type { Conversation } from "@/stores/chat-store"
import type { ActivityItem } from "@/stores/activity-store"

const persistMocks = vi.hoisted(() => ({
  saveReviewItems: vi.fn(async () => undefined),
  saveLintItems: vi.fn(async () => undefined),
  saveChatHistory: vi.fn(async () => undefined),
}))

vi.mock("./persist", () => persistMocks)

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

async function setupFreshAutoSave() {
  vi.resetModules()
  const [{ setupAutoSave, flushAutoSave }, { useWikiStore }, { useLintStore }, { useReviewStore }, { useChatStore }, { useActivityStore }] =
    await Promise.all([
      import("./auto-save"),
      import("@/stores/wiki-store"),
      import("@/stores/lint-store"),
      import("@/stores/review-store"),
      import("@/stores/chat-store"),
      import("@/stores/activity-store"),
    ])

  useWikiStore.getState().setProject(null)
  useLintStore.getState().setItems([])
  useReviewStore.getState().setItems([])
  useChatStore.getState().clearMessages()
  useChatStore.getState().setConversations([])
  useChatStore.getState().setStreaming(false)
  useActivityStore.setState({ items: [] })
  setupAutoSave()
  return { useWikiStore, useLintStore, useReviewStore, useChatStore, useActivityStore, flushAutoSave }
}

function autoSaveErrors(items: ActivityItem[]): ActivityItem[] {
  return items.filter((item) => item.type === "autosave" && item.status === "error")
}

describe("setupAutoSave", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("writes debounced lint items to the project active when the lint state changed", async () => {
    const { useWikiStore, useLintStore } = await setupFreshAutoSave()
    const item = lintItem("lint-1")

    useWikiStore.getState().setProject(project("A", "/tmp/a"))
    useLintStore.getState().setItems([item])

    await vi.advanceTimersByTimeAsync(1000)

    expect(persistMocks.saveLintItems).toHaveBeenCalledTimes(1)
    expect(persistMocks.saveLintItems).toHaveBeenCalledWith("/tmp/a", [item])
  })

  it("keeps pending debounced lint saves isolated by project path", async () => {
    const { useWikiStore, useLintStore, flushAutoSave } = await setupFreshAutoSave()
    const itemA = lintItem("lint-a")
    const itemB = lintItem("lint-b")

    useWikiStore.getState().setProject(project("A", "/tmp/a"))
    useLintStore.getState().setItems([itemA])
    await flushAutoSave("/tmp/a")
    useWikiStore.getState().setProject(project("B", "/tmp/b"))
    useLintStore.getState().setItems([])
    useLintStore.getState().setItems([itemB])

    await vi.advanceTimersByTimeAsync(1000)

    expect(persistMocks.saveLintItems).toHaveBeenCalledTimes(2)
    expect(persistMocks.saveLintItems).toHaveBeenCalledWith("/tmp/a", [itemA])
    expect(persistMocks.saveLintItems).toHaveBeenCalledWith("/tmp/b", [itemB])
  })

  it("does not write empty lint state while no project is active", async () => {
    const { useWikiStore, useLintStore } = await setupFreshAutoSave()

    useWikiStore.getState().setProject(project("A", "/tmp/a"))
    useWikiStore.getState().setProject(null)
    useLintStore.getState().setItems([])

    await vi.advanceTimersByTimeAsync(1000)

    expect(persistMocks.saveLintItems).not.toHaveBeenCalled()
  })

  it("writes debounced review items to the project active when the review state changed", async () => {
    const { useWikiStore, useReviewStore } = await setupFreshAutoSave()
    const item = reviewItem("review-1")

    useWikiStore.getState().setProject(project("A", "/tmp/a"))
    useReviewStore.getState().setItems([item])

    await vi.advanceTimersByTimeAsync(1000)

    expect(persistMocks.saveReviewItems).toHaveBeenCalledTimes(1)
    expect(persistMocks.saveReviewItems).toHaveBeenCalledWith("/tmp/a", [item])
  })

  it("keeps pending debounced review saves isolated by project path", async () => {
    const { useWikiStore, useReviewStore, flushAutoSave } = await setupFreshAutoSave()
    const itemA = reviewItem("review-a")
    const itemB = reviewItem("review-b")

    useWikiStore.getState().setProject(project("A", "/tmp/a"))
    useReviewStore.getState().setItems([itemA])
    await flushAutoSave("/tmp/a")
    useWikiStore.getState().setProject(project("B", "/tmp/b"))
    useReviewStore.getState().setItems([itemB])

    await vi.advanceTimersByTimeAsync(1000)

    expect(persistMocks.saveReviewItems).toHaveBeenCalledTimes(2)
    expect(persistMocks.saveReviewItems).toHaveBeenCalledWith("/tmp/a", [itemA])
    expect(persistMocks.saveReviewItems).toHaveBeenCalledWith("/tmp/b", [itemB])
  })

  it("writes debounced chat history to the project active when the chat state changed", async () => {
    const { useWikiStore, useChatStore } = await setupFreshAutoSave()
    const conv = conversation("conv-1")

    useWikiStore.getState().setProject(project("A", "/tmp/a"))
    useChatStore.getState().setConversations([conv])

    await vi.advanceTimersByTimeAsync(2000)

    expect(persistMocks.saveChatHistory).toHaveBeenCalledTimes(1)
    expect(persistMocks.saveChatHistory).toHaveBeenCalledWith("/tmp/a", [conv], [])
  })

  it("keeps pending debounced chat saves isolated by project path", async () => {
    const { useWikiStore, useChatStore, flushAutoSave } = await setupFreshAutoSave()
    const convA = conversation("conv-a")
    const convB = conversation("conv-b")

    useWikiStore.getState().setProject(project("A", "/tmp/a"))
    useChatStore.getState().setConversations([convA])
    await flushAutoSave("/tmp/a")
    useWikiStore.getState().setProject(project("B", "/tmp/b"))
    useChatStore.getState().setConversations([convB])

    await vi.advanceTimersByTimeAsync(2000)

    expect(persistMocks.saveChatHistory).toHaveBeenCalledTimes(2)
    expect(persistMocks.saveChatHistory).toHaveBeenCalledWith("/tmp/a", [convA], [])
    expect(persistMocks.saveChatHistory).toHaveBeenCalledWith("/tmp/b", [convB], [])
  })

  it("skips chat auto-save while streaming", async () => {
    const { useWikiStore, useChatStore } = await setupFreshAutoSave()

    useWikiStore.getState().setProject(project("A", "/tmp/a"))
    useChatStore.getState().setStreaming(true)
    useChatStore.getState().addMessage("user", "hello")

    await vi.advanceTimersByTimeAsync(2000)

    expect(persistMocks.saveChatHistory).not.toHaveBeenCalled()
  })

  it("keeps a pending chat auto-save scheduled before streaming starts", async () => {
    const { useWikiStore, useChatStore } = await setupFreshAutoSave()
    const conv = conversation("conv-before-stream")

    useWikiStore.getState().setProject(project("A", "/tmp/a"))
    useChatStore.getState().setConversations([conv])
    useChatStore.getState().setStreaming(true)

    await vi.advanceTimersByTimeAsync(2000)

    expect(persistMocks.saveChatHistory).toHaveBeenCalledTimes(1)
    expect(persistMocks.saveChatHistory).toHaveBeenCalledWith("/tmp/a", [conv], [])
  })

  it("surfaces review auto-save failures to the activity store", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {})
    const { useWikiStore, useReviewStore, useActivityStore } = await setupFreshAutoSave()
    const item = reviewItem("review-fail")
    persistMocks.saveReviewItems.mockRejectedValueOnce(new Error("EACCES: permission denied"))

    useWikiStore.getState().setProject(project("A", "/tmp/a"))
    useReviewStore.getState().setItems([item])

    await vi.advanceTimersByTimeAsync(1000)

    const errors = autoSaveErrors(useActivityStore.getState().items)
    expect(errors).toHaveLength(1)
    expect(errors[0].title).toBe("Review auto-save")
    expect(errors[0].detail).toMatch(/Failed to auto-save review/i)
    expect(errors[0].detail).toMatch(/permission denied/i)
    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining("[auto-save] review save failed"))
  })

  it("surfaces lint auto-save failures to the activity store", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    const { useWikiStore, useLintStore, useActivityStore } = await setupFreshAutoSave()
    const item = lintItem("lint-fail")
    persistMocks.saveLintItems.mockRejectedValueOnce(new Error("ENOSPC: no space"))

    useWikiStore.getState().setProject(project("A", "/tmp/a"))
    useLintStore.getState().setItems([item])

    await vi.advanceTimersByTimeAsync(1000)

    const errors = autoSaveErrors(useActivityStore.getState().items)
    expect(errors).toHaveLength(1)
    expect(errors[0].title).toBe("Lint auto-save")
    expect(errors[0].detail).toMatch(/Failed to auto-save lint/i)
    expect(errors[0].detail).toMatch(/no space/i)
  })

  it("surfaces chat auto-save failures to the activity store", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    const { useWikiStore, useChatStore, useActivityStore } = await setupFreshAutoSave()
    const conv = conversation("chat-fail")
    persistMocks.saveChatHistory.mockRejectedValueOnce(new Error("disk offline"))

    useWikiStore.getState().setProject(project("A", "/tmp/a"))
    useChatStore.getState().setConversations([conv])

    await vi.advanceTimersByTimeAsync(2000)

    const errors = autoSaveErrors(useActivityStore.getState().items)
    expect(errors).toHaveLength(1)
    expect(errors[0].title).toBe("Chat auto-save")
    expect(errors[0].detail).toMatch(/Failed to auto-save chat/i)
    expect(errors[0].detail).toMatch(/disk offline/i)
  })

  it("does not surface activity errors when auto-save succeeds", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    const { useWikiStore, useReviewStore, useActivityStore } = await setupFreshAutoSave()

    useWikiStore.getState().setProject(project("A", "/tmp/a"))
    useReviewStore.getState().setItems([reviewItem("review-ok")])

    await vi.advanceTimersByTimeAsync(1000)

    expect(autoSaveErrors(useActivityStore.getState().items)).toHaveLength(0)
  })

  it("debounces repeated failures for the same project and save kind", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    const { useWikiStore, useReviewStore, useActivityStore } = await setupFreshAutoSave()
    persistMocks.saveReviewItems.mockRejectedValue(new Error("EIO"))

    useWikiStore.getState().setProject(project("A", "/tmp/a"))
    useReviewStore.getState().setItems([reviewItem("review-a")])
    await vi.advanceTimersByTimeAsync(1000)
    useReviewStore.getState().setItems([reviewItem("review-b")])
    await vi.advanceTimersByTimeAsync(1000)

    expect(persistMocks.saveReviewItems).toHaveBeenCalledTimes(2)
    expect(autoSaveErrors(useActivityStore.getState().items)).toHaveLength(1)
  })

  it("keeps failure debounce isolated by save kind", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    const { useWikiStore, useReviewStore, useLintStore, useActivityStore } = await setupFreshAutoSave()
    persistMocks.saveReviewItems.mockRejectedValue(new Error("review failed"))
    persistMocks.saveLintItems.mockRejectedValue(new Error("lint failed"))

    useWikiStore.getState().setProject(project("A", "/tmp/a"))
    useReviewStore.getState().setItems([reviewItem("review-a")])
    useLintStore.getState().setItems([lintItem("lint-a")])

    await vi.advanceTimersByTimeAsync(1000)

    const errors = autoSaveErrors(useActivityStore.getState().items)
    expect(errors).toHaveLength(2)
    expect(errors.map((error) => error.title).sort()).toEqual(["Lint auto-save", "Review auto-save"])
  })

  it("keeps failure debounce isolated by project path", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    const { useWikiStore, useReviewStore, useActivityStore, flushAutoSave } = await setupFreshAutoSave()
    persistMocks.saveReviewItems.mockRejectedValue(new Error("review failed"))

    useWikiStore.getState().setProject(project("A", "/tmp/a"))
    useReviewStore.getState().setItems([reviewItem("review-a")])
    await flushAutoSave("/tmp/a")
    useWikiStore.getState().setProject(project("B", "/tmp/b"))
    useReviewStore.getState().setItems([reviewItem("review-b")])

    await vi.advanceTimersByTimeAsync(1000)

    const errors = autoSaveErrors(useActivityStore.getState().items)
    expect(errors).toHaveLength(2)
    expect(errors.every((error) => error.title === "Review auto-save")).toBe(true)
  })

  it("surfaces the same project and save kind again after the debounce window", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    const { useWikiStore, useReviewStore, useActivityStore } = await setupFreshAutoSave()
    persistMocks.saveReviewItems.mockRejectedValue(new Error("review failed"))

    useWikiStore.getState().setProject(project("A", "/tmp/a"))
    useReviewStore.getState().setItems([reviewItem("review-a")])
    await vi.advanceTimersByTimeAsync(1000)
    await vi.advanceTimersByTimeAsync(5001)
    useReviewStore.getState().setItems([reviewItem("review-b")])
    await vi.advanceTimersByTimeAsync(1000)

    const errors = autoSaveErrors(useActivityStore.getState().items)
    expect(errors).toHaveLength(2)
  })

  it("clears the failure debounce after a successful save", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    const { useWikiStore, useReviewStore, useActivityStore } = await setupFreshAutoSave()
    persistMocks.saveReviewItems
      .mockRejectedValueOnce(new Error("first failure"))
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("second failure"))

    useWikiStore.getState().setProject(project("A", "/tmp/a"))
    useReviewStore.getState().setItems([reviewItem("review-a")])
    await vi.advanceTimersByTimeAsync(1000)
    useReviewStore.getState().setItems([reviewItem("review-ok")])
    await vi.advanceTimersByTimeAsync(1000)
    useReviewStore.getState().setItems([reviewItem("review-b")])
    await vi.advanceTimersByTimeAsync(1000)

    const errors = autoSaveErrors(useActivityStore.getState().items)
    expect(errors).toHaveLength(2)
    expect(errors.map((error) => error.detail).join("\n")).toContain("second failure")
  })
})
