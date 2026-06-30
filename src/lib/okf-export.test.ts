import { beforeEach, describe, expect, it, vi } from "vitest"
import { buildOkfExportBundle, writeOkfExportBundle } from "./okf-export"
import type { FileNode } from "@/types/wiki"

const fsMock = vi.hoisted(() => ({
  files: new Map<string, string>(),
  tree: [] as FileNode[],
  writes: new Map<string, string>(),
  dirs: [] as string[],
}))

vi.mock("@/commands/fs", () => ({
  listDirectory: vi.fn(async (path: string) => {
    if (path !== "/project/wiki") throw new Error(`unexpected listDirectory: ${path}`)
    return fsMock.tree
  }),
  readFile: vi.fn(async (path: string) => {
    const content = fsMock.files.get(path)
    if (content === undefined) throw new Error(`missing: ${path}`)
    return content
  }),
  createDirectory: vi.fn(async (path: string) => {
    fsMock.dirs.push(path)
  }),
  writeFileAtomic: vi.fn(async (path: string, content: string) => {
    fsMock.writes.set(path, content)
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
  "| method | wiki/methods/ | Methods |",
].join("\n")

describe("OKF export", () => {
  beforeEach(() => {
    fsMock.files.clear()
    fsMock.tree = []
    fsMock.writes.clear()
    fsMock.dirs = []
    fsMock.files.set("/project/schema.md", SCHEMA)
  })

  it("maps source pages to OKF summary while preserving local fields and body", async () => {
    setWikiFiles({
      "wiki/sources/paper.md": [
        "---",
        "type: source",
        "title: Paper",
        "local_field: keep-me",
        "---",
        "",
        "# Paper",
        "",
        "Body stays here.",
      ].join("\n"),
    })

    const bundle = await buildOkfExportBundle("/project")
    const file = bundle.files[0]

    expect(file?.localType).toBe("source")
    expect(file?.okfType).toBe("summary")
    expect(file?.content).toContain("type: summary")
    expect(file?.content).toContain("local_field: keep-me")
    expect(file?.content).toContain("Body stays here.")
    expect(fsMock.files.get("/project/wiki/sources/paper.md")).toContain("type: source")
    expect(bundle.report.typeMappings).toEqual([
      {
        localType: "source",
        okfType: "summary",
        strategy: "mapped",
        count: 1,
        paths: ["wiki/sources/paper.md"],
      },
    ])
  })

  it("preserves raw source frontmatter comments, order, and complex fields while mapping only type", async () => {
    setWikiFiles({
      "wiki/sources/paper.md": [
        "---",
        "# keep this comment",
        "title: Paper",
        "type: source # local vocabulary",
        "aliases:",
        "  - Paper One",
        "meta:",
        "  author: Ada",
        "  year: 1843",
        "tags: [math, notes]",
        "---",
        "",
        "# Paper",
        "",
        "Body stays here.",
      ].join("\n"),
    })

    const bundle = await buildOkfExportBundle("/project")
    const content = bundle.files[0]?.content

    expect(content).toBe([
      "---",
      "# keep this comment",
      "title: Paper",
      "type: summary # local vocabulary",
      "aliases:",
      "  - Paper One",
      "meta:",
      "  author: Ada",
      "  year: 1843",
      "tags: [math, notes]",
      "---",
      "",
      "# Paper",
      "",
      "Body stays here.",
    ].join("\n"))
  })

  it("does not replace body type lines when mapping source pages", async () => {
    setWikiFiles({
      "wiki/sources/paper.md": [
        "---",
        "type: source",
        "title: Paper",
        "---",
        "",
        "# Paper",
        "",
        "type: source",
      ].join("\n"),
    })

    const bundle = await buildOkfExportBundle("/project")

    expect(bundle.files[0]?.content).toBe([
      "---",
      "type: summary",
      "title: Paper",
      "---",
      "",
      "# Paper",
      "",
      "type: source",
    ].join("\n"))
  })

  it("passes unknown local types through and reports them", async () => {
    setWikiFiles({
      "wiki/methods/retrieval.md": [
        "---",
        "type: method",
        "title: Retrieval",
        "---",
        "",
        "# Retrieval",
      ].join("\n"),
    })

    const bundle = await buildOkfExportBundle("/project")

    expect(bundle.files[0]?.content).toContain("type: method")
    expect(bundle.report.typeMappings).toEqual([
      {
        localType: "method",
        okfType: "method",
        strategy: "passthrough",
        count: 1,
        paths: ["wiki/methods/retrieval.md"],
      },
    ])
  })

  it("writes only the output tree and leaves the source project unchanged", async () => {
    setWikiFiles({
      "wiki/sources/paper.md": "---\ntype: source\ntitle: Paper\n---\n\n# Paper",
    })

    await writeOkfExportBundle("/project", "/out")

    expect([...fsMock.writes.keys()].sort()).toEqual([
      "/out/okf-export-report.json",
      "/out/wiki/sources/paper.md",
    ])
    expect([...fsMock.writes.keys()].some((path) => path.startsWith("/project/"))).toBe(false)
    expect(fsMock.files.get("/project/wiki/sources/paper.md")).toBe(
      "---\ntype: source\ntitle: Paper\n---\n\n# Paper",
    )
    expect(fsMock.writes.get("/out/wiki/sources/paper.md")).toContain("type: summary")
  })

  it("does not synthesize root index or overview pages when they are absent", async () => {
    setWikiFiles({
      "wiki/sources/paper.md": "---\ntype: source\ntitle: Paper\n---\n\n# Paper",
    })

    const bundle = await buildOkfExportBundle("/project")

    expect(bundle.files.map((file) => file.relativePath)).toEqual([
      "wiki/sources/paper.md",
    ])
  })

  it("ignores files outside the project wiki tree", async () => {
    setWikiFiles({
      "wiki/sources/paper.md": "---\ntype: source\ntitle: Paper\n---\n\n# Paper",
    })
    fsMock.tree.push({
      name: "outside.md",
      path: "/project/notes/outside.md",
      is_dir: false,
    })
    fsMock.files.set("/project/notes/outside.md", "---\ntype: source\ntitle: Outside\n---\n\n# Outside")

    const bundle = await buildOkfExportBundle("/project")

    expect(bundle.files.map((file) => file.relativePath)).toEqual(["wiki/sources/paper.md"])
  })

  it("preserves CJK filenames and titles", async () => {
    setWikiFiles({
      "wiki/sources/默会知识.md": [
        "---",
        "type: source",
        "title: 默会知识",
        "---",
        "",
        "# 默会知识",
      ].join("\n"),
    })

    const bundle = await buildOkfExportBundle("/project")

    expect(bundle.files[0]?.relativePath).toBe("wiki/sources/默会知识.md")
    expect(bundle.files[0]?.content).toContain("title: 默会知识")
    expect(bundle.files[0]?.content).toContain("# 默会知识")
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
