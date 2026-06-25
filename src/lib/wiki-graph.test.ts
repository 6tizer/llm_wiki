import { beforeEach, describe, expect, it, vi } from "vitest"
import type { FileNode } from "@/types/wiki"
import { wikiPathToVectorPageId } from "@/lib/wiki-page-identity"

const fsMock = vi.hoisted(() => ({
  tree: [] as FileNode[],
  files: new Map<string, string>(),
}))

vi.mock("@/commands/fs", () => ({
  listDirectory: vi.fn(async () => fsMock.tree),
  readFile: vi.fn(async (path: string) => {
    const content = fsMock.files.get(path)
    if (content === undefined) throw new Error(`missing mock file: ${path}`)
    return content
  }),
}))

vi.mock("@/stores/wiki-store", () => ({
  useWikiStore: {
    getState: () => ({ dataVersion: fsMock.files.size }),
  },
}))

import { clearGraphCache } from "./graph-relevance"
import { buildWikiGraph } from "./wiki-graph"

const PROJECT_PATH = "/tmp/project"

describe("buildWikiGraph path-aware identity", () => {
  beforeEach(() => {
    fsMock.files.clear()
    fsMock.tree = []
    clearGraphCache()
  })

  it("uses distinct wp_ ids for same-stem pages in different wiki folders", async () => {
    setWikiFiles({
      "wiki/foo.md": page("Root Foo"),
      "wiki/something/wiki/foo.md": page("Nested Foo"),
    })

    const graph = await buildWikiGraph(PROJECT_PATH)
    const rootId = wikiPathToVectorPageId(PROJECT_PATH, `${PROJECT_PATH}/wiki/foo.md`)
    const nestedId = wikiPathToVectorPageId(PROJECT_PATH, `${PROJECT_PATH}/wiki/something/wiki/foo.md`)

    expect(rootId).not.toBe(nestedId)
    expect(graph.nodes.map((node) => node.id)).toEqual(expect.arrayContaining([rootId, nestedId]))
  })

  it("resolves unique legacy stem wikilinks", async () => {
    setWikiFiles({
      "wiki/index.md": page("Index", "See [[foo]]."),
      "wiki/concepts/foo.md": page("Foo"),
    })

    const graph = await buildWikiGraph(PROJECT_PATH)
    const source = wikiPathToVectorPageId(PROJECT_PATH, `${PROJECT_PATH}/wiki/index.md`)
    const target = wikiPathToVectorPageId(PROJECT_PATH, `${PROJECT_PATH}/wiki/concepts/foo.md`)

    expect(graph.edges).toContainEqual(expect.objectContaining({ source, target }))
  })

  it("does not guess ambiguous legacy stem wikilinks", async () => {
    setWikiFiles({
      "wiki/index.md": page("Index", "See [[foo]]."),
      "wiki/concepts/foo.md": page("Concept Foo"),
      "wiki/entities/foo.md": page("Entity Foo", "", "entity"),
    })

    const graph = await buildWikiGraph(PROJECT_PATH)

    expect(graph.edges).toHaveLength(0)
  })

  it("resolves path-prefixed wikilinks before legacy stem fallback", async () => {
    setWikiFiles({
      "wiki/index.md": page("Index", "See [[concepts/Attention]]."),
      "wiki/concepts/Attention.md": page("Concept Attention"),
      "wiki/entities/Attention.md": page("Entity Attention", "", "entity"),
    })

    const graph = await buildWikiGraph(PROJECT_PATH)
    const source = wikiPathToVectorPageId(PROJECT_PATH, `${PROJECT_PATH}/wiki/index.md`)
    const target = wikiPathToVectorPageId(PROJECT_PATH, `${PROJECT_PATH}/wiki/concepts/Attention.md`)

    expect(graph.edges).toContainEqual(expect.objectContaining({ source, target }))
  })

  it("filters query nodes before counting links", async () => {
    setWikiFiles({
      "wiki/concepts/foo.md": page("Foo"),
      "wiki/queries/foo-answer.md": page("Query Answer", "See [[foo]].", "query"),
    })

    const graph = await buildWikiGraph(PROJECT_PATH)
    const target = wikiPathToVectorPageId(PROJECT_PATH, `${PROJECT_PATH}/wiki/concepts/foo.md`)

    expect(graph.nodes).toHaveLength(1)
    expect(graph.nodes[0]).toEqual(expect.objectContaining({ id: target, linkCount: 0 }))
    expect(graph.edges).toHaveLength(0)
  })
})

function page(title: string, body = "", type = "concept"): string {
  return `---\ntitle: ${title}\ntype: ${type}\n---\n# ${title}\n${body}\n`
}

function setWikiFiles(files: Record<string, string>): void {
  fsMock.files.clear()
  for (const [relPath, content] of Object.entries(files)) {
    fsMock.files.set(`${PROJECT_PATH}/${relPath}`, content)
  }
  fsMock.tree = buildTree(Object.keys(files))
}

function buildTree(paths: string[]): FileNode[] {
  const root: FileNode[] = []
  for (const relPath of paths) {
    const wikiRel = relPath.replace(/^wiki\//, "")
    const parts = wikiRel.split("/")
    let children = root
    let currentPath = `${PROJECT_PATH}/wiki`
    for (let i = 0; i < parts.length; i++) {
      const name = parts[i]
      currentPath = `${currentPath}/${name}`
      const isFile = i === parts.length - 1
      if (isFile) {
        children.push({ name, path: currentPath, is_dir: false })
        continue
      }
      let dir = children.find((node) => node.is_dir && node.name === name)
      if (!dir) {
        dir = { name, path: currentPath, is_dir: true, children: [] }
        children.push(dir)
      }
      children = dir.children ?? []
    }
  }
  return root
}
