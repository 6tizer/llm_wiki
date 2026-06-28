import { beforeEach, describe, expect, it, vi } from "vitest"
import { importOkfBundle, previewOkfImport } from "./okf-import"
import type { FileNode } from "@/types/wiki"

const fsMock = vi.hoisted(() => ({
  files: new Map<string, string>(),
  tree: [] as FileNode[],
  reads: [] as string[],
  writes: new Map<string, string>(),
  dirs: [] as string[],
}))

vi.mock("@/commands/fs", () => ({
  listDirectory: vi.fn(async (path: string) => {
    if (path !== "/source/wiki") throw new Error(`unexpected listDirectory: ${path}`)
    return fsMock.tree
  }),
  readFile: vi.fn(async (path: string) => {
    fsMock.reads.push(path)
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
  "| source | wiki/source-notes/ | Source summaries |",
  "| method | wiki/methods/ | Methods |",
].join("\n")

describe("OKF import", () => {
  beforeEach(() => {
    fsMock.files.clear()
    fsMock.tree = []
    fsMock.reads = []
    fsMock.writes.clear()
    fsMock.dirs = []
  })

  it("maps OKF summary to local source and default wiki/sources routing", async () => {
    setSourceFiles({
      "wiki/summaries/paper.md": "---\ntype: summary\ntitle: Paper\n---\n\n# Paper",
    })

    const plan = await previewOkfImport("/source", "/project")

    expect(plan.pages[0]).toMatchObject({
      sourceRelativePath: "wiki/summaries/paper.md",
      targetRelativePath: "wiki/sources/paper.md",
      localType: "source",
      okfType: "summary",
      routingStrategy: "default",
      action: "write",
    })
    expect(plan.pages[0]?.content).toContain("type: source")
  })

  it("routes known schema types to the schema directory", async () => {
    fsMock.files.set("/project/schema.md", SCHEMA)
    setSourceFiles({
      "wiki/custom/retrieval.md": "---\ntype: method\ntitle: Retrieval\n---\n\n# Retrieval",
    })

    const plan = await previewOkfImport("/source", "/project")

    expect(plan.pages[0]).toMatchObject({
      targetRelativePath: "wiki/methods/retrieval.md",
      localType: "method",
      routingStrategy: "schema",
    })
  })

  it("canonicalizes mixed-case OKF types before schema routing", async () => {
    fsMock.files.set("/project/schema.md", SCHEMA)
    setSourceFiles({
      "wiki/custom/retrieval.md": "---\ntype: Method\ntitle: Retrieval\n---\n\n# Retrieval",
    })

    const plan = await previewOkfImport("/source", "/project")

    expect(plan.pages[0]).toMatchObject({
      targetRelativePath: "wiki/methods/retrieval.md",
      localType: "method",
      okfType: "Method",
      routingStrategy: "schema",
    })
    expect(plan.pages[0]?.content).toContain("type: method")
  })

  it("reports and skips unsafe schema routes without writing outside wiki", async () => {
    fsMock.files.set(
      "/project/schema.md",
      [
        "# Wiki Schema",
        "",
        "## Page Types",
        "",
        "| Type | Directory | Purpose |",
        "| ---- | --------- | ------- |",
        "| method | wiki/../outside/ | Unsafe route |",
      ].join("\n"),
    )
    setSourceFiles({
      "wiki/custom/retrieval.md": "---\ntype: method\ntitle: Retrieval\n---\n\n# Retrieval",
    })

    const preview = await previewOkfImport("/source", "/project")
    const applied = await importOkfBundle("/source", "/project", { apply: true })

    expect(preview.pages).toEqual([])
    expect(preview.issues).toEqual([
      expect.objectContaining({
        severity: "error",
        code: "invalid_target_path",
        path: "wiki/custom/retrieval.md",
      }),
    ])
    expect(applied.pages).toEqual([])
    expect(applied.issues.map((issue) => issue.code)).toEqual(["invalid_target_path"])
    expect(fsMock.dirs).toEqual([])
    expect(fsMock.writes.size).toBe(0)
  })

  it("preserves unknown types and routes them to wiki root when schema is absent", async () => {
    setSourceFiles({
      "wiki/custom/retrieval.md": "---\ntype: method\ntitle: Retrieval\n---\n\n# Retrieval",
    })

    const plan = await previewOkfImport("/source", "/project")

    expect(plan.pages[0]).toMatchObject({
      targetRelativePath: "wiki/retrieval.md",
      localType: "method",
      routingStrategy: "root",
    })
    expect(plan.pages[0]?.content).toContain("type: method")
  })

  it("does not create directories or write files during preview", async () => {
    setSourceFiles({
      "wiki/summaries/paper.md": "---\ntype: summary\ntitle: Paper\n---\n\n# Paper",
    })

    await previewOkfImport("/source", "/project")

    expect(fsMock.dirs).toEqual([])
    expect(fsMock.writes.size).toBe(0)
  })

  it("defaults importOkfBundle to preview without writing", async () => {
    setSourceFiles({
      "wiki/summaries/paper.md": "---\ntype: summary\ntitle: Paper\n---\n\n# Paper",
    })

    const plan = await importOkfBundle("/source", "/project")

    expect(plan.applied).toBe(false)
    expect(plan.summary.writeCount).toBe(1)
    expect(fsMock.dirs).toEqual([])
    expect(fsMock.writes.size).toBe(0)
  })

  it("writes expected directories and files when apply is true", async () => {
    setSourceFiles({
      "wiki/summaries/paper.md": "---\ntype: summary\ntitle: Paper\n---\n\n# Paper",
    })

    const plan = await importOkfBundle("/source", "/project", { apply: true })

    expect(plan.applied).toBe(true)
    expect(fsMock.dirs).toEqual(["/project/wiki/sources"])
    expect(fsMock.writes.get("/project/wiki/sources/paper.md")).toBe(
      "---\ntype: source\ntitle: Paper\n---\n\n# Paper",
    )
  })

  it("uses a deterministic suffix and reports conflict/renamed for differing target content", async () => {
    setSourceFiles({
      "wiki/summaries/paper.md": "---\ntype: summary\ntitle: Paper\n---\n\n# Paper",
    })
    fsMock.files.set("/project/wiki/sources/paper.md", "---\ntype: source\ntitle: Existing\n---\n\n# Existing")

    const plan = await previewOkfImport("/source", "/project")

    expect(plan.pages[0]).toMatchObject({
      targetRelativePath: "wiki/sources/paper-2.md",
      action: "write",
      conflict: true,
      renamed: true,
    })
  })

  it("writes a suffixed target when apply mode finds differing target content", async () => {
    setSourceFiles({
      "wiki/summaries/paper.md": "---\ntype: summary\ntitle: Paper\n---\n\n# Paper",
    })
    fsMock.files.set("/project/wiki/sources/paper.md", "---\ntype: source\ntitle: Existing\n---\n\n# Existing")

    const plan = await importOkfBundle("/source", "/project", { apply: true })

    expect(plan.pages[0]).toMatchObject({
      targetRelativePath: "wiki/sources/paper-2.md",
      action: "write",
      conflict: true,
      renamed: true,
    })
    expect(fsMock.writes.get("/project/wiki/sources/paper-2.md")).toBe(
      "---\ntype: source\ntitle: Paper\n---\n\n# Paper",
    )
    expect(fsMock.writes.has("/project/wiki/sources/paper.md")).toBe(false)
  })

  it("uses a deterministic suffix when two source pages target the same path with different content", async () => {
    setSourceFiles({
      "wiki/articles/paper.md": "---\ntype: summary\ntitle: First\n---\n\n# First",
      "wiki/summaries/paper.md": "---\ntype: summary\ntitle: Second\n---\n\n# Second",
    })

    const plan = await previewOkfImport("/source", "/project")

    expect(plan.pages).toHaveLength(2)
    expect(plan.pages[0]).toMatchObject({
      sourceRelativePath: "wiki/articles/paper.md",
      targetRelativePath: "wiki/sources/paper.md",
      action: "write",
      conflict: false,
      renamed: false,
    })
    expect(plan.pages[1]).toMatchObject({
      sourceRelativePath: "wiki/summaries/paper.md",
      targetRelativePath: "wiki/sources/paper-2.md",
      action: "write",
      conflict: true,
      renamed: true,
    })
  })

  it("skips byte-identical target content for idempotent repeated imports", async () => {
    setSourceFiles({
      "wiki/summaries/paper.md": "---\ntype: summary\ntitle: Paper\n---\n\n# Paper",
    })
    fsMock.files.set("/project/wiki/sources/paper.md", "---\ntype: source\ntitle: Paper\n---\n\n# Paper")

    const plan = await importOkfBundle("/source", "/project", { apply: true })

    expect(plan.pages[0]).toMatchObject({
      targetRelativePath: "wiki/sources/paper.md",
      action: "skip",
      reason: "identical",
      conflict: false,
      renamed: false,
    })
    expect(fsMock.dirs).toEqual([])
    expect(fsMock.writes.size).toBe(0)
  })

  it("skips identical content when two source pages target the same path", async () => {
    const content = "---\ntype: summary\ntitle: Paper\n---\n\n# Paper"
    setSourceFiles({
      "wiki/articles/paper.md": content,
      "wiki/summaries/paper.md": content,
    })

    const plan = await previewOkfImport("/source", "/project")

    expect(plan.pages).toHaveLength(2)
    expect(plan.pages[0]).toMatchObject({
      targetRelativePath: "wiki/sources/paper.md",
      action: "write",
      conflict: false,
      renamed: false,
    })
    expect(plan.pages[1]).toMatchObject({
      targetRelativePath: "wiki/sources/paper.md",
      action: "skip",
      reason: "identical",
      conflict: false,
      renamed: false,
    })
  })

  it("preserves CJK filenames and titles", async () => {
    setSourceFiles({
      "wiki/summaries/默会知识.md": "---\ntype: summary\ntitle: 默会知识\n---\n\n# 默会知识",
    })

    const plan = await previewOkfImport("/source", "/project")

    expect(plan.pages[0]?.targetRelativePath).toBe("wiki/sources/默会知识.md")
    expect(plan.pages[0]?.content).toContain("title: 默会知识")
  })

  it("does not replace body type lines when mapping summary to source", async () => {
    setSourceFiles({
      "wiki/summaries/paper.md": [
        "---",
        "type: summary",
        "title: Paper",
        "---",
        "",
        "# Paper",
        "",
        "type: summary",
      ].join("\n"),
    })

    const plan = await previewOkfImport("/source", "/project")

    expect(plan.pages[0]?.content).toBe([
      "---",
      "type: source",
      "title: Paper",
      "---",
      "",
      "# Paper",
      "",
      "type: summary",
    ].join("\n"))
  })

  it("replaces only the top-level frontmatter type line", async () => {
    setSourceFiles({
      "wiki/summaries/paper.md": [
        "---",
        "type: summary",
        "title: Paper",
        "notes: |",
        "  type: should-not-change",
        "---",
        "",
        "# Paper",
        "",
        "type: should-not-change",
      ].join("\n"),
    })

    const plan = await previewOkfImport("/source", "/project")

    expect(plan.pages[0]?.content).toBe([
      "---",
      "type: source",
      "title: Paper",
      "notes: |",
      "  type: should-not-change",
      "---",
      "",
      "# Paper",
      "",
      "type: should-not-change",
    ].join("\n"))
  })

  it("preserves an inline comment on the top-level frontmatter type line", async () => {
    setSourceFiles({
      "wiki/summaries/paper.md": [
        "---",
        "title: Paper",
        "type: summary # keep this comment",
        "---",
        "",
        "# Paper",
      ].join("\n"),
    })

    const plan = await previewOkfImport("/source", "/project")

    expect(plan.pages[0]?.content).toBe([
      "---",
      "title: Paper",
      "type: source # keep this comment",
      "---",
      "",
      "# Paper",
    ].join("\n"))
  })

  it("ignores or reports traversal and outside-wiki source paths safely", async () => {
    fsMock.tree = [
      { name: "evil.md", path: "/source/wiki/../evil.md", is_dir: false },
      { name: "outside.md", path: "/source/notes/outside.md", is_dir: false },
      { name: "abs.md", path: "/tmp/abs.md", is_dir: false },
    ]

    const plan = await previewOkfImport("/source", "/project")

    expect(plan.pages).toEqual([])
    expect(plan.issues.map((issue) => issue.code)).toEqual([
      "invalid_source_path",
      "invalid_source_path",
      "invalid_source_path",
    ])
    expect(fsMock.reads).toEqual(["/project/schema.md"])
  })

  it("reports missing source wiki directory", async () => {
    const plan = await previewOkfImport("/missing", "/project")

    expect(plan.pages).toEqual([])
    expect(plan.issues).toEqual([
      expect.objectContaining({
        severity: "error",
        code: "source_wiki_missing",
        path: "wiki",
      }),
    ])
  })

  it("reports read failures and skips unreadable source pages", async () => {
    fsMock.tree = [
      { name: "missing.md", path: "/source/wiki/summaries/missing.md", is_dir: false },
    ]

    const plan = await previewOkfImport("/source", "/project")

    expect(plan.pages).toEqual([])
    expect(plan.issues).toEqual([
      expect.objectContaining({
        severity: "error",
        code: "read_failed",
        path: "wiki/summaries/missing.md",
      }),
    ])
  })

  it("reports missing required frontmatter fields", async () => {
    setSourceFiles({
      "wiki/summaries/missing-title.md": "---\ntype: summary\n---\n\n# Missing Title",
      "wiki/summaries/missing-type.md": "---\ntitle: Missing Type\n---\n\n# Missing Type",
    })

    const plan = await previewOkfImport("/source", "/project")

    expect(plan.pages).toHaveLength(1)
    expect(plan.pages[0]?.sourceRelativePath).toBe("wiki/summaries/missing-title.md")
    expect(plan.issues).toEqual([
      expect.objectContaining({
        severity: "warn",
        code: "missing_title",
        path: "wiki/summaries/missing-title.md",
      }),
      expect.objectContaining({
        severity: "error",
        code: "missing_type",
        path: "wiki/summaries/missing-type.md",
      }),
    ])
  })
})

function setSourceFiles(files: Record<string, string>): void {
  for (const [relativePath, content] of Object.entries(files)) {
    fsMock.files.set(`/source/${relativePath}`, content)
  }
  fsMock.tree = buildTree(Object.keys(files))
}

function buildTree(relativePaths: string[]): FileNode[] {
  const root: FileNode[] = []
  for (const relativePath of relativePaths) {
    const parts = relativePath.replace(/^wiki\//, "").split("/")
    let children = root
    let currentPath = "/source/wiki"
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
