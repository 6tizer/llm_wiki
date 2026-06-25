import { describe, expect, it } from "vitest"
import { getAppLayoutVisibility } from "./app-layout-visibility"

describe("getAppLayoutVisibility", () => {
  it("keeps settings full width even when preview or research state exists", () => {
    expect(getAppLayoutVisibility("settings", "/tmp/page.md", true)).toEqual({
      showLeftPanel: false,
      hasRightPanel: false,
    })
  })

  it("shows project chrome and preview for workspace views with a selected file", () => {
    expect(getAppLayoutVisibility("wiki", "/tmp/page.md", false)).toEqual({
      showLeftPanel: true,
      hasRightPanel: true,
    })
  })

  it("shows the research panel only outside standalone views", () => {
    expect(getAppLayoutVisibility("search", null, true)).toEqual({
      showLeftPanel: true,
      hasRightPanel: true,
    })
  })
})
