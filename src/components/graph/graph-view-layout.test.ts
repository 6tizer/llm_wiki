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

  it("keeps the graph title on one truncated line under tight panel widths", () => {
    const source = readFileSync("src/components/graph/graph-view.tsx", "utf8")

    expect(source).toContain('className="flex min-w-0 items-center justify-between border-b px-4 py-2 shrink-0"')
    expect(source).toContain('className="flex min-w-0 items-center gap-3"')
    expect(source).toContain('className="flex min-w-0 items-center gap-2"')
    expect(source).toContain('className="h-4 w-4 shrink-0 text-muted-foreground"')
    expect(source).toContain('className="truncate text-sm font-medium"')
  })

  it("highlights a clicked node while preserving the existing click-to-open path", () => {
    const source = readFileSync("src/components/graph/graph-view.tsx", "utf8")
    const handler = source.slice(
      source.indexOf("const handleNodeClick = useCallback"),
      source.indexOf("const handleNodeContextMenu = useCallback"),
    )

    expect(handler).toContain("setHighlightedNodes(new Set([nodeId]))")
    expect(handler.indexOf("setHighlightedNodes(new Set([nodeId]))")).toBeLessThan(
      handler.indexOf("readFile(node.path)"),
    )
    expect(handler).toContain("setSelectedFile(node.path)")
  })
})
