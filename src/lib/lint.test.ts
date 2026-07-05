import { describe, it, expect, beforeEach, vi } from "vitest"
import type { LlmConfig } from "@/stores/wiki-store"
import type { FileNode } from "@/types/wiki"

// Mock LLM + Tauri FS — the lint runner also touches the activity store
// (we leave that real so we can assert status transitions).
vi.mock("./pool-chat", () => ({
  streamChatRouted: vi.fn(),
}))
vi.mock("@/commands/fs", () => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
  listDirectory: vi.fn(),
}))

import { runSemanticLint, runStructuralLint } from "./lint"
import { streamChatRouted } from "./pool-chat"
import { readFile, listDirectory } from "@/commands/fs"
import { useWikiStore } from "@/stores/wiki-store"
import { useActivityStore } from "@/stores/activity-store"

const mockStreamChat = vi.mocked(streamChatRouted)
const mockReadFile = vi.mocked(readFile)
const mockListDirectory = vi.mocked(listDirectory)

function fakeLlmConfig(): LlmConfig {
  return {
    provider: "openai",
    apiKey: "k",
    model: "m",
    ollamaUrl: "",
    customEndpoint: "",
    maxContextSize: 128000,
  }
}

function makeFileNode(name: string, content: string): { node: FileNode; content: string } {
  return {
    node: {
      name,
      path: `/project/wiki/${name}`,
      is_dir: false,
      children: [],
    } as FileNode,
    content,
  }
}

beforeEach(() => {
  mockStreamChat.mockReset()
  mockReadFile.mockReset()
  mockListDirectory.mockReset()
  useWikiStore.getState().setOutputLanguage("auto")
  useActivityStore.setState({ items: [] })
})

describe("runSemanticLint — language directive", () => {
  it("uses explicit user setting", async () => {
    const pages = [
      makeFileNode("a.md", "Page A content here"),
      makeFileNode("b.md", "Page B content here"),
    ]
    mockListDirectory.mockResolvedValue(pages.map((p) => p.node))
    mockReadFile.mockImplementation(async (path) => {
      const match = pages.find((p) => p.node.path === path)
      return match?.content ?? ""
    })
    mockStreamChat.mockImplementation(async (_family, _c, _m, cb) => {
      cb.onToken("")
      cb.onDone()
    })

    useWikiStore.getState().setOutputLanguage("Korean")
    await runSemanticLint("/project", fakeLlmConfig())

    const prompt = mockStreamChat.mock.calls[0][2][0].content
    expect(prompt).toContain("MANDATORY OUTPUT LANGUAGE: Korean")
  })

  it("auto mode detects from the concatenated page summaries", async () => {
    const cjkContent = "这是一篇关于注意力机制和神经网络的长中文页面"
    const pages = [
      makeFileNode("attention.md", cjkContent),
      makeFileNode("transformer.md", cjkContent),
    ]
    mockListDirectory.mockResolvedValue(pages.map((p) => p.node))
    mockReadFile.mockImplementation(async (path) => {
      const match = pages.find((p) => p.node.path === path)
      return match?.content ?? ""
    })
    mockStreamChat.mockImplementation(async (_family, _c, _m, cb) => {
      cb.onToken("")
      cb.onDone()
    })

    useWikiStore.getState().setOutputLanguage("auto")
    await runSemanticLint("/project", fakeLlmConfig())

    const prompt = mockStreamChat.mock.calls[0][2][0].content
    expect(prompt).toContain("MANDATORY OUTPUT LANGUAGE: Chinese")
  })

  it("explicit setting wins over source language", async () => {
    const pages = [makeFileNode("x.md", "これは日本語の内容です")]
    mockListDirectory.mockResolvedValue(pages.map((p) => p.node))
    mockReadFile.mockResolvedValue(pages[0].content)
    mockStreamChat.mockImplementation(async (_family, _c, _m, cb) => {
      cb.onToken("")
      cb.onDone()
    })

    useWikiStore.getState().setOutputLanguage("English")
    await runSemanticLint("/project", fakeLlmConfig())

    const prompt = mockStreamChat.mock.calls[0][2][0].content
    expect(prompt).toContain("MANDATORY OUTPUT LANGUAGE: English")
    expect(prompt).not.toContain("MANDATORY OUTPUT LANGUAGE: Japanese")
  })
})

describe("runSemanticLint — activity & early returns", () => {
  it("logs a running activity item and marks done", async () => {
    mockListDirectory.mockResolvedValue([makeFileNode("a.md", "content").node])
    mockReadFile.mockResolvedValue("content")
    mockStreamChat.mockImplementation(async (_family, _c, _m, cb) => {
      cb.onDone()
    })

    await runSemanticLint("/project", fakeLlmConfig())
    const items = useActivityStore.getState().items
    expect(items).toHaveLength(1)
    // Final state after run completes
    expect(items[0].type).toBe("lint")
    expect(["done", "error"]).toContain(items[0].status)
  })

  it("returns empty and marks done when wiki has no pages", async () => {
    mockListDirectory.mockResolvedValue([])

    const result = await runSemanticLint("/project", fakeLlmConfig())
    expect(result).toEqual([])
    expect(mockStreamChat).not.toHaveBeenCalled()

    const items = useActivityStore.getState().items
    expect(items[0].detail).toMatch(/no wiki pages/i)
  })

  it("marks error status when wiki directory read fails", async () => {
    mockListDirectory.mockRejectedValue(new Error("ENOENT"))
    await runSemanticLint("/project", fakeLlmConfig())
    const items = useActivityStore.getState().items
    expect(items[0].status).toBe("error")
  })
})

// SPEC-11 S5 self-heal (consumed by SPEC-6 PR3+4): the cross-file wikilink
// "reference sweep" (cleanupDeletedWikiPages, source-lifecycle.ts) is NOT
// transactional across the pages it edits — a crash partway through can
// leave a page with a dangling `[[wikilink]]` to a page that is already
// gone. Rather than adding transactional machinery to the sweep itself
// (out of scope), S5's self-heal is: the NEXT lint pass independently
// re-derives "does this link's target exist right now?" straight from the
// current wiki tree on disk, with zero dependency on the sweep having
// completed cleanly. `runStructuralLint`'s "broken-link" check already does
// exactly this (verified here: it had ZERO test coverage before this PR) —
// so S5 needed no new lint code, just this characterization proving the
// self-heal path is real, not aspirational.
describe("runStructuralLint — broken-link detection (baseline coverage)", () => {
  it("flags a wikilink whose target page does not exist anywhere in the wiki tree", async () => {
    const pages = [
      makeFileNode("a.md", "See [[missing-page]] for details."),
    ]
    mockListDirectory.mockResolvedValue(pages.map((p) => p.node))
    mockReadFile.mockImplementation(async (path) => {
      const match = pages.find((p) => p.node.path === path)
      return match?.content ?? ""
    })

    const results = await runStructuralLint("/project")

    const broken = results.filter((r) => r.type === "broken-link")
    expect(broken).toHaveLength(1)
    expect(broken[0].detail).toContain("[[missing-page]]")
  })

  it("does NOT flag a wikilink whose target page exists (slug or basename match)", async () => {
    const pages = [
      makeFileNode("a.md", "See [[b]] for details."),
      makeFileNode("b.md", "# B\n\nBack to [[a]]."),
    ]
    mockListDirectory.mockResolvedValue(pages.map((p) => p.node))
    mockReadFile.mockImplementation(async (path) => {
      const match = pages.find((p) => p.node.path === path)
      return match?.content ?? ""
    })

    const results = await runStructuralLint("/project")
    expect(results.filter((r) => r.type === "broken-link")).toHaveLength(0)
  })
})

describe("runStructuralLint — S5 self-heal characterization (SPEC-11 reference-sweep crash → dead link)", () => {
  it("flags the dangling wikilink left behind when the cross-file reference sweep crashes after deleting the target page but before it could scrub a surviving page's link to it", async () => {
    // Simulates the exact SPEC-11 chain-B scenario (see
    // source-lifecycle-cleanup-chains.characterization.test.ts's
    // `cleanupDeletedWikiPages` fixtures): "kv-cache.md" has already been
    // deleted from disk (the sweep's OWN target-removal step, or an
    // external deletion, already landed), but the sweep crashed before it
    // could reach "other-page.md" to strip its now-dangling `[[kv-cache]]`
    // reference. Note kv-cache.md is deliberately ABSENT from this
    // listDirectory snapshot — the sweep's job was to clean it up, and it
    // didn't finish.
    const pages = [
      makeFileNode(
        "other-page.md",
        [
          "---",
          "type: concept",
          'title: "Other Page"',
          "---",
          "",
          "# Other Page",
          "",
          "See [[kv-cache]] for the slug-form reference.",
        ].join("\n"),
      ),
    ]
    mockListDirectory.mockResolvedValue(pages.map((p) => p.node))
    mockReadFile.mockImplementation(async (path) => {
      const match = pages.find((p) => p.node.path === path)
      return match?.content ?? ""
    })

    const results = await runStructuralLint("/project")

    const broken = results.filter((r) => r.type === "broken-link")
    expect(broken).toHaveLength(1)
    expect(broken[0].page).toBe("other-page.md")
    expect(broken[0].detail).toContain("[[kv-cache]]")
    expect(broken[0].severity).toBe("warning")
  })
})
