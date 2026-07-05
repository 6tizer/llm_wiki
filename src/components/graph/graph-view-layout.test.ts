import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

describe("GraphView layout key", () => {
  it("does not depend on the retired research panel state", () => {
    const source = readFileSync("src/components/graph/graph-view.tsx", "utf8")

    expect(source).not.toContain(`research${"Panel"}ForLayout`)
    expect(source).not.toContain(`panel${"Open"}`)
    expect(source).toContain("const layoutKey = `${!!selectedFileForLayout}-${showInsights}`")
  })
})
