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
