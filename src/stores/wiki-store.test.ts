import { describe, expect, it } from "vitest"
import { useWikiStore } from "./wiki-store"

describe("useWikiStore navigation handoffs", () => {
  it("keeps pending settings category independent from explore cleanup", () => {
    useWikiStore.setState({
      activeView: "explore",
      selectedFile: "wiki/page.md",
      fileContent: "content",
      externalPreview: {
        title: "Preview",
        source: "search",
        path: "wiki/page.md",
        url: "https://example.com",
        snippet: "snippet",
      },
      pendingExploreTab: "search",
      pendingSettingsCategory: null,
    })

    useWikiStore.getState().setPendingSettingsCategory("knowledge-agents")
    useWikiStore.getState().setActiveView("settings")

    expect(useWikiStore.getState().pendingSettingsCategory).toBe("knowledge-agents")
    expect(useWikiStore.getState().pendingExploreTab).toBeNull()
    expect(useWikiStore.getState().selectedFile).toBeNull()
    expect(useWikiStore.getState().fileContent).toBe("")
    expect(useWikiStore.getState().externalPreview).toBeNull()
  })

  it("keeps research alias behavior unchanged", () => {
    useWikiStore.setState({ activeView: "wiki", pendingExploreTab: null, pendingSettingsCategory: null })

    useWikiStore.getState().setActiveView("research")

    expect(useWikiStore.getState().activeView).toBe("research")
    expect(useWikiStore.getState().pendingExploreTab).toBe("research")
    expect(useWikiStore.getState().pendingSettingsCategory).toBeNull()
  })
})
