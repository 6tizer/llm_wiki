import { describe, expect, it } from "vitest"
import {
  DEFAULT_ZOOM_LEVEL,
  MAX_ZOOM_LEVEL,
  MIN_ZOOM_LEVEL,
  clampZoomLevel,
  roundZoomLevel,
  useZoomStore,
} from "./zoom-store"

describe("zoom store", () => {
  it("clamps zoom levels to the supported range", () => {
    expect(clampZoomLevel(0.1)).toBe(MIN_ZOOM_LEVEL)
    expect(clampZoomLevel(1.25)).toBe(1.25)
    expect(clampZoomLevel(4)).toBe(MAX_ZOOM_LEVEL)
  })

  it("rounds zoom levels to two decimal places", () => {
    expect(roundZoomLevel(1.234)).toBe(1.23)
    expect(roundZoomLevel(1.235)).toBe(1.24)
  })

  it("stores clamped zoom levels", () => {
    useZoomStore.setState({ level: DEFAULT_ZOOM_LEVEL })
    useZoomStore.getState().setLevel(10)
    expect(useZoomStore.getState().level).toBe(MAX_ZOOM_LEVEL)
  })
})
