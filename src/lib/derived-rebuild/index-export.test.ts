/**
 * Unit tests for SPEC-6 PR5's `index_export` layer: the pure grouping/
 * formatting functions (no IO), the wiki-tree scan (mocked `@/commands/fs`),
 * and the manual-rebuild closeout wrapper (mocked `manual-rebuild.ts`).
 */
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { FileNode } from "@/types/wiki"

const fsMocks = vi.hoisted(() => ({
  listDirectory: vi.fn(),
  readFile: vi.fn(),
  writeFileAtomic: vi.fn(),
}))
vi.mock("@/commands/fs", () => ({
  listDirectory: fsMocks.listDirectory,
  readFile: fsMocks.readFile,
  writeFileAtomic: fsMocks.writeFileAtomic,
}))

const manualRebuildMock = vi.hoisted(() => vi.fn())
vi.mock("./manual-rebuild", () => ({
  runManualRebuild: manualRebuildMock,
}))

import {
  formatIndexExportMarkdown,
  groupIndexExportPages,
  rebuildIndexExport,
  scanIndexExportPages,
  type IndexExportPage,
} from "./index-export"

function page(overrides: Partial<IndexExportPage> = {}): IndexExportPage {
  return { slug: "concept/a", title: "A", type: "concept", ...overrides }
}

function mdFile(path: string): FileNode {
  return { name: path.split("/").pop() ?? path, path, is_dir: false }
}

function dir(name: string, children: FileNode[]): FileNode {
  return { name, path: name, is_dir: true, children }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe("groupIndexExportPages", () => {
  it("always emits the six template sections, in template order, even when every one is empty", () => {
    const sections = groupIndexExportPages([])
    expect(sections.map((s) => s.heading)).toEqual([
      "Entities",
      "Concepts",
      "Sources",
      "Queries",
      "Comparisons",
      "Synthesis",
    ])
    expect(sections.every((s) => s.pages.length === 0)).toBe(true)
  })

  it("routes each known type to its matching section and sorts pages by slug within a section", () => {
    const sections = groupIndexExportPages([
      page({ slug: "concept/b", title: "B", type: "concept" }),
      page({ slug: "concept/a", title: "A", type: "concept" }),
      page({ slug: "entity/x", title: "X", type: "entity" }),
    ])
    const concepts = sections.find((s) => s.heading === "Concepts")
    const entities = sections.find((s) => s.heading === "Entities")
    expect(concepts?.pages.map((p) => p.slug)).toEqual(["concept/a", "concept/b"])
    expect(entities?.pages.map((p) => p.slug)).toEqual(["entity/x"])
  })

  it("groups an unknown/custom type into a trailing 'Other' section", () => {
    const sections = groupIndexExportPages([page({ slug: "findings/f1", title: "F1", type: "finding" })])
    expect(sections[sections.length - 1]).toEqual({ heading: "Other", pages: [page({ slug: "findings/f1", title: "F1", type: "finding" })] })
  })

  it("groups a page with no discoverable type (empty string) into 'Other' rather than dropping it", () => {
    const sections = groupIndexExportPages([page({ slug: "misc/x", title: "X", type: "" })])
    const other = sections.find((s) => s.heading === "Other")
    expect(other?.pages.map((p) => p.slug)).toEqual(["misc/x"])
  })

  it("omits the 'Other' section entirely when every page maps to a known type", () => {
    const sections = groupIndexExportPages([page({ type: "concept" })])
    expect(sections.some((s) => s.heading === "Other")).toBe(false)
  })
})

describe("formatIndexExportMarkdown", () => {
  it("matches project.rs's fresh-project wiki/index.md template exactly when there are no pages", () => {
    const markdown = formatIndexExportMarkdown(groupIndexExportPages([]))
    expect(markdown).toBe(
      "# Wiki Index\n\n## Entities\n\n## Concepts\n\n## Sources\n\n## Queries\n\n## Comparisons\n\n## Synthesis\n",
    )
  })

  it("renders '- [[slug]] — title' rows under a populated section, with blank lines separating sections", () => {
    const sections = groupIndexExportPages([
      page({ slug: "concept/a", title: "A", type: "concept" }),
      page({ slug: "concept/b", title: "B", type: "concept" }),
    ])
    const markdown = formatIndexExportMarkdown(sections)
    expect(markdown).toContain("## Concepts\n\n- [[concept/a]] — A\n- [[concept/b]] — B")
    // Empty sections around it keep the bare-heading (no dangling blank rows).
    expect(markdown).toContain("## Entities\n\n## Concepts")
    expect(markdown).toContain("## Sources\n\n## Queries")
  })
})

describe("scanIndexExportPages", () => {
  it("returns an empty list when there is no wiki/ directory yet", async () => {
    fsMocks.listDirectory.mockRejectedValueOnce(new Error("File does not exist"))
    const pages = await scanIndexExportPages("/proj")
    expect(pages).toEqual([])
  })

  it("skips the root structural pages (index/log/overview/purpose/schema)", async () => {
    fsMocks.listDirectory.mockResolvedValueOnce([
      mdFile("/proj/wiki/index.md"),
      mdFile("/proj/wiki/log.md"),
      mdFile("/proj/wiki/overview.md"),
      mdFile("/proj/wiki/purpose.md"),
      mdFile("/proj/wiki/schema.md"),
      dir("concept", [mdFile("/proj/wiki/concept/a.md")]),
    ])
    fsMocks.readFile.mockResolvedValueOnce("---\ntitle: A\ntype: concept\n---\nbody")

    const pages = await scanIndexExportPages("/proj")
    expect(pages).toEqual([{ slug: "concept/a", title: "A", type: "concept" }])
  })

  it("prefers frontmatter type over the path-inferred type, and falls back to path when frontmatter has none", async () => {
    fsMocks.listDirectory.mockResolvedValueOnce([
      dir("entities", [mdFile("/proj/wiki/entities/weird.md")]),
      dir("concept", [mdFile("/proj/wiki/concept/untyped.md")]),
    ])
    fsMocks.readFile
      .mockResolvedValueOnce("---\ntitle: Weird\ntype: comparison\n---\nbody")
      .mockResolvedValueOnce("no frontmatter here")

    const pages = await scanIndexExportPages("/proj")
    expect(pages).toContainEqual({ slug: "entities/weird", title: "Weird", type: "comparison" })
    // No frontmatter type -> falls back to the directory-inferred type, and
    // title falls back to the filename stem.
    expect(pages).toContainEqual({ slug: "concept/untyped", title: "untyped", type: "concept" })
  })

  it("skips a file that fails to read instead of failing the whole scan", async () => {
    fsMocks.listDirectory.mockResolvedValueOnce([
      mdFile("/proj/wiki/concept/a.md"),
      mdFile("/proj/wiki/concept/b.md"),
    ])
    fsMocks.readFile
      .mockRejectedValueOnce(new Error("locked"))
      .mockResolvedValueOnce("---\ntitle: B\ntype: concept\n---\nbody")

    const pages = await scanIndexExportPages("/proj")
    expect(pages).toEqual([{ slug: "concept/b", title: "B", type: "concept" }])
  })

  it("returns an empty list when the wiki tree contains only root structural pages", async () => {
    fsMocks.listDirectory.mockResolvedValueOnce([
      mdFile("/proj/wiki/index.md"),
      mdFile("/proj/wiki/log.md"),
      mdFile("/proj/wiki/overview.md"),
      mdFile("/proj/wiki/purpose.md"),
      mdFile("/proj/wiki/schema.md"),
    ])

    const pages = await scanIndexExportPages("/proj")
    expect(pages).toEqual([])
    // Every file was skipped by path alone — never even read.
    expect(fsMocks.readFile).not.toHaveBeenCalled()
  })
})

describe("rebuildIndexExport", () => {
  it("scans, formats, writes wiki/index.md atomically, and reports counts through the manual-rebuild closeout", async () => {
    fsMocks.listDirectory.mockResolvedValueOnce([mdFile("/proj/wiki/concept/a.md")])
    fsMocks.readFile.mockResolvedValueOnce("---\ntitle: A\ntype: concept\n---\nbody")
    manualRebuildMock.mockImplementation(async (options: { execute: () => Promise<unknown> }) => ({
      result: await options.execute(),
      runtimeTracked: true,
    }))

    const result = await rebuildIndexExport("/proj")

    expect(manualRebuildMock).toHaveBeenCalledWith(
      expect.objectContaining({
        layer: "index_export",
        affectedPath: "wiki/index.md",
        holder: "index-export-manual-rebuild",
      }),
    )
    expect(fsMocks.writeFileAtomic).toHaveBeenCalledWith(
      "/proj/wiki/index.md",
      expect.stringContaining("- [[concept/a]] — A"),
    )
    expect(result).toEqual({
      path: "wiki/index.md",
      pageCount: 1,
      sectionCount: 6,
      runtimeTracked: true,
    })
  })
})
