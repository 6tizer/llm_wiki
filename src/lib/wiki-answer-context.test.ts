import { beforeEach, describe, expect, it, vi } from "vitest"
import type { FileNode } from "@/types/wiki"
import type { SearchResult } from "@/lib/search"

const fsMock = vi.hoisted(() => ({
  tree: [] as FileNode[],
  files: new Map<string, string>(),
  searchResults: [] as SearchResult[],
}))

vi.mock("@/commands/fs", () => ({
  listDirectory: vi.fn(async () => fsMock.tree),
  readFile: vi.fn(async (path: string) => fsMock.files.get(path) ?? ""),
}))

vi.mock("@/lib/search", () => ({
  searchWiki: vi.fn(async () => ({ results: fsMock.searchResults, mode: "hybrid", vectorHits: 0 })),
  tokenizeQuery: vi.fn((query: string) => query.toLowerCase().split(/\s+/).filter(Boolean)),
}))

import { buildWikiAnswerContext } from "./wiki-answer-context"
import { clearGraphCache } from "./graph-relevance"

const PROJECT_PATH = "/project"

describe("buildWikiAnswerContext", () => {
  beforeEach(() => {
    fsMock.tree = []
    fsMock.files.clear()
    fsMock.searchResults = []
    clearGraphCache()
  })

  it("keeps greeting handling on the short deterministic chat path", async () => {
    const context = await buildWikiAnswerContext({
      project: { name: "Demo Wiki", path: PROJECT_PATH },
      query: "你好",
      maxContextSize: 50000,
      dataVersion: 0,
    })

    expect(context.queryRefs).toEqual([])
    expect(context.languageReminder).toBeUndefined()
    expect(context.systemMessages).toHaveLength(1)
    expect(context.systemMessages[0]).toMatchObject({ role: "system" })
    expect(context.systemMessages[0].content).toContain('project "Demo Wiki"')
    expect(context.systemMessages[0].content).toContain("casual greeting")
  })

  it("expands graph results using path-aware ids for same-stem pages", async () => {
    setWikiFiles({
      "wiki/foo.md": page("Root Foo", "Root page."),
      "wiki/something/wiki/foo.md": page("Nested Foo", "Nested page links to [[related]]."),
      "wiki/concepts/related.md": page("Related Concept", "Related page."),
    })
    fsMock.searchResults = [
      searchResult(`${PROJECT_PATH}/wiki/something/wiki/foo.md`, "Nested Foo"),
    ]

    const context = await buildWikiAnswerContext({
      project: { name: "Demo Wiki", path: PROJECT_PATH },
      query: "nested foo graph",
      maxContextSize: 50000,
      dataVersion: 1,
    })

    expect(context.queryRefs.map((ref) => ref.path)).toEqual([
      "wiki/something/wiki/foo.md",
      "wiki/concepts/related.md",
    ])
    expect(context.queryRefs.map((ref) => ref.title)).toContain("Related Concept")
  })
})

function page(title: string, body = "", type = "concept"): string {
  return `---\ntitle: ${title}\ntype: ${type}\n---\n# ${title}\n${body}\n`
}

function searchResult(path: string, title: string): SearchResult {
  return {
    path,
    title,
    snippet: title,
    titleMatch: true,
    score: 1,
    images: [],
  }
}

function setWikiFiles(files: Record<string, string>): void {
  fsMock.files.clear()
  fsMock.files.set(`${PROJECT_PATH}/wiki/index.md`, "# Index\n")
  fsMock.files.set(`${PROJECT_PATH}/purpose.md`, "")
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
