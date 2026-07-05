import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { realFs, createTempProject, readFileRaw, fileExists } from "@/test-helpers/fs-temp"
import type { LlmConfig } from "@/stores/wiki-store"
import type { DuplicateGroup } from "./dedup"

/**
 * SPEC-11 D6 bug4: executeMerge resolves DuplicateGroup.slugs (bare
 * filenames) back to on-disk paths via a slug -> path lookup built from
 * every .md file in the wiki. Before the fix, that lookup was a
 * Map<string, string> — a same-named file in a different directory
 * (wiki/entities/x.md vs wiki/concepts/x.md) would silently overwrite the
 * earlier entry, so the merge could resolve "x" to the WRONG file and
 * merge/delete a page that was never part of the intended group. The fix
 * collects every candidate path per slug and refuses to proceed when more
 * than one exists, instead of guessing.
 */
vi.mock("@/commands/fs", () => realFs)

const { getMockMergeResponse, setMockMergeResponse } = vi.hoisted(() => {
  let response = "---\ntype: entity\ntitle: Merged\n---\n\nMerged body with enough content to look like a real page after merging two inputs together."
  return {
    getMockMergeResponse: () => response,
    setMockMergeResponse: (r: string) => {
      response = r
    },
  }
})

vi.mock("@/lib/pool-chat", () => ({
  streamChatRouted: vi.fn(async (_family, _cfg, _messages, cb) => {
    cb.onToken(getMockMergeResponse())
    cb.onDone()
  }),
}))

const fakeLlmConfig: LlmConfig = {
  provider: "openai",
  apiKey: "test-key",
  model: "test-model",
  maxContextSize: 128000,
  ollamaUrl: "",
  customEndpoint: "",
}

describe("executeMerge — same-basename collision across directories (bug4)", () => {
  let projectDir: string
  let cleanup: () => Promise<void>

  const ENTITIES_X = "---\ntype: entity\ntitle: X Entity\n---\n\nThe entity page named x, with a reasonable amount of body content."
  const CONCEPTS_X = "---\ntype: concept\ntitle: X Concept\n---\n\nAn unrelated concept page that happens to share the filename x.md."
  const ENTITIES_Y = "---\ntype: entity\ntitle: Y Entity\n---\n\nA genuine duplicate of the x entity, with a reasonable amount of body content."

  beforeEach(async () => {
    setMockMergeResponse(
      "---\ntype: entity\ntitle: Merged\n---\n\nMerged body with enough content to look like a real page after merging two inputs together.",
    )
    const tmp = await createTempProject("dedup-collision")
    projectDir = tmp.path
    cleanup = tmp.cleanup
    await realFs.writeFile(`${projectDir}/wiki/entities/x.md`, ENTITIES_X)
    await realFs.writeFile(`${projectDir}/wiki/concepts/x.md`, CONCEPTS_X)
    await realFs.writeFile(`${projectDir}/wiki/entities/y.md`, ENTITIES_Y)
  })

  afterEach(async () => {
    await cleanup()
  })

  it("refuses to merge when a group slug matches files in two different directories", async () => {
    const { executeMerge } = await import("./dedup-runner")
    const group: DuplicateGroup = { slugs: ["x", "y"], reason: "same", confidence: "high" }

    await expect(
      executeMerge(projectDir, group, "x", fakeLlmConfig),
    ).rejects.toThrow(/matches multiple files/i)

    // Nothing was touched — all three original files survive untouched.
    expect(await readFileRaw(`${projectDir}/wiki/entities/x.md`)).toBe(ENTITIES_X)
    expect(await readFileRaw(`${projectDir}/wiki/concepts/x.md`)).toBe(CONCEPTS_X)
    expect(await readFileRaw(`${projectDir}/wiki/entities/y.md`)).toBe(ENTITIES_Y)
  })

  it("still merges normally when there is no collision", async () => {
    const { executeMerge } = await import("./dedup-runner")
    // Remove the colliding concepts/x.md so entities/x + entities/y is
    // an unambiguous, ordinary merge.
    const fs = await import("node:fs/promises")
    await fs.unlink(`${projectDir}/wiki/concepts/x.md`)

    const group: DuplicateGroup = { slugs: ["x", "y"], reason: "same", confidence: "high" }
    const result = await executeMerge(projectDir, group, "x", fakeLlmConfig)

    expect(result.canonicalPath).toBe("wiki/entities/x.md")
    expect(result.pagesToDelete).toEqual(["wiki/entities/y.md"])
    expect(await readFileRaw(`${projectDir}/wiki/entities/x.md`)).toContain("Merged body")
    expect(await fileExists(`${projectDir}/wiki/entities/y.md`)).toBe(false)
  })
})
