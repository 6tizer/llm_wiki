import { describe, expect, it } from "vitest"
import { MAX_ZOOM_LEVEL, MIN_ZOOM_LEVEL } from "@/stores/zoom-store"
import { parseZoomPercentInput } from "./interface-section"

describe("parseZoomPercentInput", () => {
  const fallback = 1.1

  it("falls back for empty or non-numeric input", () => {
    expect(parseZoomPercentInput("", fallback)).toBe(fallback)
    expect(parseZoomPercentInput("abc", fallback)).toBe(fallback)
  })

  it("falls back for zero input", () => {
    expect(parseZoomPercentInput("0", fallback)).toBe(fallback)
  })

  it("parses valid percentages", () => {
    expect(parseZoomPercentInput("125", fallback)).toBe(1.25)
    expect(parseZoomPercentInput("125%", fallback)).toBe(1.25)
  })

  it("clamps out-of-range percentages", () => {
    expect(parseZoomPercentInput("1", fallback)).toBe(MIN_ZOOM_LEVEL)
    expect(parseZoomPercentInput("-20", fallback)).toBe(MIN_ZOOM_LEVEL)
    expect(parseZoomPercentInput("999", fallback)).toBe(MAX_ZOOM_LEVEL)
  })
})
