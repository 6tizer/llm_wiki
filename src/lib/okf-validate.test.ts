import { beforeEach, describe, expect, it, vi } from "vitest"
import { validateOkfBundle } from "./okf-validate"
import type { FileNode } from "@/types/wiki"

const fsMock = vi.hoisted(() => ({
  files: new Map<string, string>(),
  tree: [] as FileNode[],
  readPaths: [] as string[],
}))

vi.mock("@/commands/fs", () => ({
  listDirectory: vi.fn(async (path: string) => {
    if (path !== "/project/wiki") throw new Error(`unexpected listDirectory: ${path}`)
    return fsMock.tree
  }),
  readFile: vi.fn(async (path: string) => {
    fsMock.readPaths.push(path)
    const content = fsMock.files.get(path)
    if (content === undefined) throw new Error(`missing: ${path}`)
    return content
  }),
}))

const SCHEMA = [
  "# Wiki Schema",
  "",
  "## Page Types",
  "",
  "| Type | Directory | Purpose |",
  "| ---- | --------- | ------- |",
  "| source | wiki/sources/ | Source summaries |",
  "| concept | wiki/concepts/ | Concepts |",
  "| method | wiki/methods/ | Methods |",
].join("\n")

describe("validateOkfBundle", () => {
  beforeEach(() => {
    fsMock.files.clear()
    fsMock.tree = []
    fsMock.readPaths = []
    fsMock.files.set("/project/schema.md", SCHEMA)
  })

  it("returns no errors for a valid bundle", async () => {
    setWikiFiles({
      "wiki/sources/page.md": [
        "---",
        "type: source",
        "title: Page",
        "---",
        "",
        "See [[Concept]].",
      ].join("\n"),
      "wiki/concepts/Concept.md": [
        "---",
        "type: concept",
        "title: Concept",
        "---",
        "",
        "# Concept",
      ].join("\n"),
    })

    const result = await validateOkfBundle("/project")

    expect(result.ok).toBe(true)
    expect(result.errors).toEqual([])
    expect(result.warnings).toEqual([])
  })

  it("reports missing type and missing title on non-structural pages", async () => {
    setWikiFiles({
      "wiki/concepts/missing-type.md": "---\ntitle: Missing Type\n---\n\n# Missing Type",
      "wiki/concepts/missing-title.md": "---\ntype: concept\n---\n\n# Missing Title",
    })

    const result = await validateOkfBundle("/project")

    expect(result.errors.map((issue) => issue.code)).toEqual([
      "missing_title",
      "missing_type",
    ])
  })

  it("skips required frontmatter enforcement for structural pages", async () => {
    setWikiFiles({
      "wiki/index.md": "# Index",
      "wiki/log.md": "# Log",
      "wiki/overview.md": "# Overview",
    })

    const result = await validateOkfBundle("/project")

    expect(result.errors).toEqual([])
  })

  it("reports schema routing violations", async () => {
    setWikiFiles({
      "wiki/concepts/source-in-concepts.md": [
        "---",
        "type: source",
        "title: Source In Concepts",
        "---",
        "",
        "# Source",
      ].join("\n"),
    })

    const result = await validateOkfBundle("/project")

    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]?.code).toBe("schema_routing")
    expect(result.errors[0]?.message).toContain('type "source" must be under "wiki/sources/"')
  })

  it("reports malformed wikilink syntax as an error", async () => {
    setWikiFiles({
      "wiki/concepts/page.md": [
        "---",
        "type: concept",
        "title: Page",
        "---",
        "",
        "Broken [[wikilink.",
      ].join("\n"),
    })

    const result = await validateOkfBundle("/project")

    expect(result.errors.map((issue) => issue.code)).toContain("malformed_wikilink")
  })

  it("reports balanced but illegal wikilinks as malformed", async () => {
    setWikiFiles({
      "wiki/concepts/page.md": [
        "---",
        "type: concept",
        "title: Page",
        "---",
        "",
        "Broken empty target [[|Alias]].",
        "Broken cross-line target [[Bad",
        "Target]].",
      ].join("\n"),
    })

    const result = await validateOkfBundle("/project")

    expect(result.errors.map((issue) => issue.code)).toContain("malformed_wikilink")
  })

  it("reports well-formed unresolved wikilinks as warnings", async () => {
    setWikiFiles({
      "wiki/concepts/page.md": [
        "---",
        "type: concept",
        "title: Page",
        "---",
        "",
        "Missing [[Other Page]].",
      ].join("\n"),
    })

    const result = await validateOkfBundle("/project")

    expect(result.errors).toEqual([])
    expect(result.warnings.map((issue) => issue.code)).toEqual(["unresolved_wikilink"])
  })

  it("ignores wikilinks inside fenced and inline code", async () => {
    setWikiFiles({
      "wiki/concepts/page.md": [
        "---",
        "type: concept",
        "title: Page",
        "---",
        "",
        "Inline `[[missing-inline]]` and `[[|Alias]]` should be shown as code.",
        "",
        "```",
        "[[missing-fenced]]",
        "[[broken-fenced",
        "[[Bad",
        "Target]]",
        "[[|Alias]]",
        "```",
      ].join("\n"),
    })

    const result = await validateOkfBundle("/project")

    expect(result.errors.map((issue) => issue.code)).not.toContain("malformed_wikilink")
    expect(result.warnings.map((issue) => issue.code)).not.toContain("unresolved_wikilink")
  })

  it("does not report balanced array or matrix brackets as malformed wikilinks", async () => {
    setWikiFiles({
      "wiki/concepts/page.md": [
        "---",
        "type: concept",
        "title: Page",
        "---",
        "",
        "Use matrix[[0,1],[2,3]] in examples.",
      ].join("\n"),
    })

    const result = await validateOkfBundle("/project")

    expect(result.errors.map((issue) => issue.code)).not.toContain("malformed_wikilink")
    expect(result.warnings.map((issue) => issue.code)).not.toContain("unresolved_wikilink")
  })

  it("accepts resolved bare wikilinks", async () => {
    setWikiFiles({
      "wiki/concepts/page.md": "---\ntype: concept\ntitle: Page\n---\n\nSee [[Target]].",
      "wiki/concepts/Target.md": "---\ntype: concept\ntitle: Target\n---\n\n# Target",
    })

    const result = await validateOkfBundle("/project")

    expect(result.errors).toEqual([])
    expect(result.warnings).toEqual([])
  })

  it("accepts resolved alias wikilinks", async () => {
    setWikiFiles({
      "wiki/concepts/page.md": "---\ntype: concept\ntitle: Page\n---\n\nSee [[Target|Label]].",
      "wiki/concepts/Target.md": "---\ntype: concept\ntitle: Target\n---\n\n# Target",
    })

    const result = await validateOkfBundle("/project")

    expect(result.errors).toEqual([])
    expect(result.warnings).toEqual([])
  })

  it("ignores files outside the project wiki tree", async () => {
    setWikiFiles({
      "wiki/concepts/page.md": "---\ntype: concept\ntitle: Page\n---\n\n# Page",
    })
    fsMock.tree.push({
      name: "outside.md",
      path: "/project/notes/outside.md",
      is_dir: false,
    })
    fsMock.files.set("/project/notes/outside.md", "# no frontmatter")

    const result = await validateOkfBundle("/project")

    expect(result.errors).toEqual([])
    expect(fsMock.readPaths).not.toContain("/project/notes/outside.md")
  })
})

function setWikiFiles(files: Record<string, string>): void {
  for (const [relativePath, content] of Object.entries(files)) {
    fsMock.files.set(`/project/${relativePath}`, content)
  }
  fsMock.tree = buildTree(Object.keys(files))
}

function buildTree(relativePaths: string[]): FileNode[] {
  const root: FileNode[] = []
  for (const relativePath of relativePaths) {
    const parts = relativePath.replace(/^wiki\//, "").split("/")
    let children = root
    let currentPath = "/project/wiki"
    for (const part of parts.slice(0, -1)) {
      currentPath = `${currentPath}/${part}`
      let dir = children.find((node) => node.is_dir && node.name === part)
      if (!dir) {
        dir = { name: part, path: currentPath, is_dir: true, children: [] }
        children.push(dir)
      }
      children = dir.children ?? []
    }
    const name = parts[parts.length - 1]
    children.push({ name, path: `${currentPath}/${name}`, is_dir: false })
  }
  return root
}
