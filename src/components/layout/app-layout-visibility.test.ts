import { describe, expect, it } from "vitest"
import { getAppLayoutVisibility } from "./app-layout-visibility"

describe("getAppLayoutVisibility", () => {
  it("keeps settings full width even when preview or research state exists", () => {
    expect(getAppLayoutVisibility("settings", "/tmp/page.md")).toEqual({
      showLeftPanel: false,
      hasRightPanel: false,
    })
  })

  it("shows project chrome and preview for workspace views with a selected file", () => {
    expect(getAppLayoutVisibility("wiki", "/tmp/page.md")).toEqual({
      showLeftPanel: true,
      hasRightPanel: true,
    })
  })

  it("keeps sidebar visibility as layout chrome state, independent from collapsed rendering", () => {
    expect(getAppLayoutVisibility("wiki", null).showLeftPanel).toBe(true)
    expect(getAppLayoutVisibility("settings", null).showLeftPanel).toBe(false)
  })

  it.each(["sources", "explore", "wiki-health", "research"] as const)(
    "keeps %s as workspace chrome without a selected file",
    (activeView) => {
      expect(getAppLayoutVisibility(activeView, null)).toEqual({
        showLeftPanel: true,
        hasRightPanel: false,
      })
    },
  )
})
