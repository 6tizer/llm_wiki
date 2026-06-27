import { beforeEach, describe, expect, it, vi } from "vitest"
import type { LintItem } from "@/stores/lint-store"

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

async function setupFreshAutoSave() {
  vi.resetModules()
  const [{ setupAutoSave }, { useWikiStore }, { useLintStore }, { useChatStore }] =
    await Promise.all([
      import("./auto-save"),
      import("@/stores/wiki-store"),
      import("@/stores/lint-store"),
      import("@/stores/chat-store"),
    ])

  useWikiStore.getState().setProject(null)
  useLintStore.getState().setItems([])
  useChatStore.getState().clearMessages()
  useChatStore.getState().setConversations([])
  useChatStore.getState().setStreaming(false)
  setupAutoSave()
  return { useWikiStore, useLintStore, useChatStore }
}

describe("setupAutoSave", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
  })

  it("writes debounced lint items to the project active when the lint state changed", async () => {
    const { useWikiStore, useLintStore } = await setupFreshAutoSave()
    const item = lintItem("lint-1")

    useWikiStore.getState().setProject(project("A", "/tmp/a"))
    useLintStore.getState().setItems([item])
    useWikiStore.getState().setProject(project("B", "/tmp/b"))

    await vi.advanceTimersByTimeAsync(1000)

    expect(persistMocks.saveLintItems).toHaveBeenCalledTimes(1)
    expect(persistMocks.saveLintItems).toHaveBeenCalledWith("/tmp/a", [item])
  })

  it("keeps pending debounced lint saves isolated by project path", async () => {
    const { useWikiStore, useLintStore } = await setupFreshAutoSave()
    const itemA = lintItem("lint-a")
    const itemB = lintItem("lint-b")

    useWikiStore.getState().setProject(project("A", "/tmp/a"))
    useLintStore.getState().setItems([itemA])
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

  it("skips chat auto-save while streaming", async () => {
    const { useWikiStore, useChatStore } = await setupFreshAutoSave()

    useWikiStore.getState().setProject(project("A", "/tmp/a"))
    useChatStore.getState().setStreaming(true)
    useChatStore.getState().addMessage("user", "hello")

    await vi.advanceTimersByTimeAsync(2000)

    expect(persistMocks.saveChatHistory).not.toHaveBeenCalled()
  })
})
