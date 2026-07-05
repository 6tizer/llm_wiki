import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

describe("GraphView layout key", () => {
  it("does not depend on the retired research panel state", () => {
    const source = readFileSync("src/components/graph/graph-view.tsx", "utf8")

    expect(source).not.toContain(`research${"Panel"}ForLayout`)
    expect(source).not.toContain(`panel${"Open"}`)
    expect(source).toContain("const layoutKey = `${!!selectedFileForLayout}-${showInsights}`")
  })

  it("switches to the research view after confirming graph research", () => {
    const source = readFileSync("src/components/graph/graph-view.tsx", "utf8")
    const handler = source.slice(
      source.indexOf("const handleResearchConfirm = useCallback"),
      source.indexOf("// Unmount sigma when panels resize or toggle"),
    )

    expect(handler).toContain("queueResearch(")
    expect(handler).toContain('useWikiStore.getState().setActiveView("research")')
    expect(handler.indexOf("queueResearch(")).toBeLessThan(
      handler.indexOf('useWikiStore.getState().setActiveView("research")'),
    )
  })
})
