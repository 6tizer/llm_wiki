import { describe, expect, it } from "vitest"
import { DEFAULT_ZOOM_LEVEL, MAX_ZOOM_LEVEL, MIN_ZOOM_LEVEL } from "@/stores/zoom-store"
import { __projectStoreTest } from "./project-store"

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
})
