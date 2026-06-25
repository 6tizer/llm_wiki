import { beforeEach, describe, expect, it, vi } from "vitest"
import { DEFAULT_ZOOM_LEVEL, MAX_ZOOM_LEVEL, MIN_ZOOM_LEVEL } from "@/stores/zoom-store"

const mocks = vi.hoisted(() => ({
  store: {
    get: vi.fn(),
    set: vi.fn(),
    save: vi.fn(),
    delete: vi.fn(),
  },
  invoke: vi.fn(),
}))

vi.mock("@tauri-apps/plugin-store", () => ({
  load: vi.fn(async () => mocks.store),
}))

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mocks.invoke,
}))

import { __projectStoreTest, saveCloseBehavior, saveTheme } from "./project-store"

beforeEach(() => {
  vi.clearAllMocks()
  mocks.store.get.mockResolvedValue(undefined)
  mocks.store.set.mockResolvedValue(undefined)
  mocks.store.save.mockResolvedValue(undefined)
  mocks.store.delete.mockResolvedValue(undefined)
  mocks.invoke.mockResolvedValue("ok")
})

describe("project-store zoom persistence helpers", () => {
  it("normalizes persisted zoom values before use", () => {
    expect(__projectStoreTest.normalizeZoomLevel(undefined)).toBe(DEFAULT_ZOOM_LEVEL)
    expect(__projectStoreTest.normalizeZoomLevel(Number.NaN)).toBe(DEFAULT_ZOOM_LEVEL)
    expect(__projectStoreTest.normalizeZoomLevel(0.1)).toBe(MIN_ZOOM_LEVEL)
    expect(__projectStoreTest.normalizeZoomLevel(10)).toBe(MAX_ZOOM_LEVEL)
    expect(__projectStoreTest.normalizeZoomLevel(1.25)).toBe(1.25)
  })
})

describe("project-store app preference helpers", () => {
  it("normalizes theme values", () => {
    expect(__projectStoreTest.normalizeTheme("light")).toBe("light")
    expect(__projectStoreTest.normalizeTheme("dark")).toBe("dark")
    expect(__projectStoreTest.normalizeTheme("system")).toBe("system")
    expect(__projectStoreTest.normalizeTheme("sepia")).toBe("system")
  })

  it("normalizes close behavior values", () => {
    expect(__projectStoreTest.normalizeCloseBehavior("hide")).toBe("hide")
    expect(__projectStoreTest.normalizeCloseBehavior("quit")).toBe("quit")
    expect(__projectStoreTest.normalizeCloseBehavior("ask")).toBe("hide")
    expect(__projectStoreTest.normalizeCloseBehavior(undefined)).toBe("hide")
  })

  it("force-flushes theme saves to avoid app-state debounce races", async () => {
    await saveTheme("dark")

    expect(mocks.store.set).toHaveBeenCalledWith("theme", "dark")
    expect(mocks.store.save).toHaveBeenCalledTimes(1)
  })

  it("flushes close behavior before best-effort Rust cache sync", async () => {
    const calls: string[] = []
    mocks.store.save.mockImplementation(async () => {
      calls.push("save")
    })
    mocks.invoke.mockImplementation(async () => {
      calls.push("invoke")
      return "quit"
    })

    await saveCloseBehavior("quit")

    expect(mocks.store.set).toHaveBeenCalledWith("closeBehavior", "quit")
    expect(mocks.invoke).toHaveBeenCalledWith("set_close_behavior", { behavior: "quit" })
    expect(calls).toEqual(["save", "invoke"])
  })
})
