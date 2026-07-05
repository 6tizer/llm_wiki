import { describe, it, expect, beforeEach, vi } from "vitest"
import type { LlmConfig } from "@/stores/wiki-store"
import type { FileNode } from "@/types/wiki"

/**
 * SPEC-11 D6 bug1 (integration): runLintAndReport's autoFix flag drives
 * fixLintReport over report.autoFixItems. Before the fix, orphan results
 * landed in autoFixItems and fixLintReport would call fixLintResult ->
 * fixOrphan -> cascadeDeleteWikiPagesWithRefs with no confirmation. This
 * test runs the full pipeline against an in-memory wiki with one orphan
 * page and one auto-fixable broken link, and asserts the orphan page is
 * left untouched (never deleted) while the broken link is processed.
 */
vi.mock("./pool-chat", () => ({
  streamChatRouted: vi.fn(),
}))
vi.mock("@/lib/wiki-page-delete", () => ({
  cascadeDeleteWikiPagesWithRefs: vi.fn(),
}))

const ORPHAN_CONTENT =
  "---\ntype: concept\ntitle: Orphan\n---\n\nNobody links here, but it links to [[broken]]."
const BROKEN_CONTENT =
  "---\ntype: concept\ntitle: Broken\n---\n\nSee [[missing-page]] for more."

const files: Record<string, string> = {
  "/project/wiki/orphan.md": ORPHAN_CONTENT,
  "/project/wiki/broken.md": BROKEN_CONTENT,
}

vi.mock("@/commands/fs", () => ({
  readFile: vi.fn(async (p: string) => {
    if (p in files) return files[p]
    throw new Error(`ENOENT: ${p}`)
  }),
  writeFile: vi.fn(async (p: string, content: string) => {
    files[p] = content
  }),
  listDirectory: vi.fn(async () => [
    { name: "orphan.md", path: "/project/wiki/orphan.md", is_dir: false, children: [] },
    { name: "broken.md", path: "/project/wiki/broken.md", is_dir: false, children: [] },
  ] as FileNode[]),
}))

import { runLintAndReport } from "./lint-fixer"
import { streamChatRouted } from "./pool-chat"
import { cascadeDeleteWikiPagesWithRefs } from "@/lib/wiki-page-delete"
import { useActivityStore } from "@/stores/activity-store"

const mockStreamChat = vi.mocked(streamChatRouted)
const mockCascadeDelete = vi.mocked(cascadeDeleteWikiPagesWithRefs)

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

beforeEach(() => {
  mockStreamChat.mockReset()
  mockCascadeDelete.mockReset()
  useActivityStore.setState({ items: [] })
  files["/project/wiki/orphan.md"] = ORPHAN_CONTENT
  files["/project/wiki/broken.md"] = BROKEN_CONTENT
})

describe("runLintAndReport(autoFix) — orphan survives auto-fix (SPEC-11 D6 bug1)", () => {
  it("never calls cascadeDeleteWikiPagesWithRefs for the orphan and leaves the page on disk", async () => {
    mockStreamChat.mockImplementation(async (_family, _cfg, _messages, cb) => {
      cb.onToken(
        "---\ntype: concept\ntitle: Broken\n---\n\nNo longer references a missing page. Plenty of body content survives here so the length-sanity check passes comfortably.",
      )
      cb.onDone()
    })

    const fileTree: FileNode[] = [
      { name: "orphan.md", path: "/project/wiki/orphan.md", is_dir: false, children: [] },
      { name: "broken.md", path: "/project/wiki/broken.md", is_dir: false, children: [] },
    ]

    const { report } = await runLintAndReport(
      "/project",
      fakeLlmConfig(),
      fileTree,
      true,
      false,
      true,
    )

    // Orphan was classified human, never routed to the auto-fix / delete path.
    expect(mockCascadeDelete).not.toHaveBeenCalled()
    expect(files["/project/wiki/orphan.md"]).toBe(ORPHAN_CONTENT)
    expect(report.humanItems.some((i) => i.type === "orphan")).toBe(true)
    expect(report.repairLog?.skipped.some((s) => s.includes("orphan"))).toBe(true)

    // The broken-link issue (a real auto-fix item) was attempted.
    expect(report.autoFixItems.some((i) => i.type === "broken-link")).toBe(true)
  })
})
