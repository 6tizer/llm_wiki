/**
 * SPEC-11 PR4 — characterization tests for chain B of the wiki-page
 * reference-cleanup sweep: `cleanupDeletedWikiPages` (source-lifecycle.ts).
 *
 * Chain A (`deleteSourceFiles` → `cascadeDeleteWikiPagesWithRefs` in
 * wiki-page-delete.ts) already has coverage in source-lifecycle-delete.test.ts
 * and source-lifecycle.test.ts — not duplicated here.
 *
 * `cleanupDeletedWikiPages` runs AFTER its caller (project-file-sync.ts)
 * has already removed the target page(s) from disk — it only sweeps the
 * REST of the wiki for dangling references. Since the page is already
 * gone, the function can't read its frontmatter `title` off disk; the
 * caller (project-file-sync.ts) must supply it out-of-band via the
 * optional `titles` map (sourced from the Rust file-sync snapshot's
 * `titleBefore`, SPEC-11 PR7b), or `buildDeletedKeys` falls back to the
 * slug-derived key only — see 21c below.
 *
 * Mock surface: `@/commands/fs` (real fs via temp dir, with
 * `listDirectory` wrapped so ONE test can inject a stale snapshot) and
 * `@/lib/embedding` (stub). `wiki-cleanup.ts` runs for real.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createTempProject, realFs, writeFileRaw, readFileRaw, fileExists } from "@/test-helpers/fs-temp"
import type { FileNode } from "@/types/wiki"

const mocks = vi.hoisted(() => ({
  listDirectory: vi.fn(),
  deleteFile: vi.fn(),
  removePageEmbedding: vi.fn(async () => {}),
}))

vi.mock("@/commands/fs", () => ({
  ...realFs,
  listDirectory: mocks.listDirectory,
  deleteFile: mocks.deleteFile,
}))

vi.mock("@/lib/embedding", () => ({
  removePageEmbedding: mocks.removePageEmbedding,
}))

import { cleanupDeletedWikiPages } from "./source-lifecycle"
import { wikiPathToVectorPageId } from "./wiki-page-identity"

interface Tmp {
  path: string
  cleanup: () => Promise<void>
}

beforeEach(() => {
  mocks.listDirectory.mockReset()
  mocks.listDirectory.mockImplementation(realFs.listDirectory)
  mocks.deleteFile.mockReset()
  mocks.deleteFile.mockImplementation(realFs.deleteFile)
  mocks.removePageEmbedding.mockClear()
})

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  while (cleanups.length > 0) {
    const fn = cleanups.pop()!
    await fn().catch(() => {})
  }
})

function track(tmp: Tmp): Tmp {
  cleanups.push(tmp.cleanup)
  return tmp
}

async function seed(label: string): Promise<Tmp> {
  const tmp = track(await createTempProject(label))
  await writeFileRaw(
    `${tmp.path}/wiki/index.md`,
    [
      "# Index",
      "",
      "- [[kv-cache]] KV cache implementation notes",
      "- [[other-page]] An unrelated surviving page",
      "",
    ].join("\n"),
  )
  await writeFileRaw(
    `${tmp.path}/wiki/concepts/other-page.md`,
    [
      "---",
      "type: concept",
      'title: "Other Page"',
      'related: ["kv-cache", "something-else"]',
      "---",
      "",
      "# Other Page",
      "",
      "See [[kv-cache]] for the slug-form reference, and see also [[Key-Value Cache]] for the title-form reference.",
    ].join("\n"),
  )
  return tmp
}

describe("cleanupDeletedWikiPages — reference sweep (chain B)", () => {
  it("21a: removes the deleted page's index.md listing entry", async () => {
    const tmp = await seed("d21a")
    await cleanupDeletedWikiPages(tmp.path, ["wiki/concepts/kv-cache.md"])

    const index = await readFileRaw(`${tmp.path}/wiki/index.md`)
    expect(index).not.toContain("[[kv-cache]]")
    expect(index).toContain("[[other-page]]")
  })

  it("21b: strips a surviving page's slug-form wikilink to the deleted page", async () => {
    const tmp = await seed("d21b")
    await cleanupDeletedWikiPages(tmp.path, ["wiki/concepts/kv-cache.md"])

    const other = await readFileRaw(`${tmp.path}/wiki/concepts/other-page.md`)
    expect(other).not.toContain("[[kv-cache]]")
    expect(other).toContain("the slug-form reference")
    // Regression guard: without a `titles` map, the title-form wikilink is
    // NOT recognized (no title-derived key to match against) and survives
    // untouched — this is the documented, still-current fallback behavior
    // for callers that can't supply a pre-deletion title (see 21c for the
    // case where the caller does supply one).
    expect(other).toContain("[[Key-Value Cache]]")
  })

  it("21c: a title-form wikilink whose title diverges from the slug is cleaned when the caller supplies the pre-deletion title", async () => {
    const tmp = await seed("d21c")
    const titles = new Map([["wiki/concepts/kv-cache.md", "Key-Value Cache"]])
    await cleanupDeletedWikiPages(tmp.path, ["wiki/concepts/kv-cache.md"], titles)

    const other = await readFileRaw(`${tmp.path}/wiki/concepts/other-page.md`)
    // "Key-Value Cache" normalizes to "keyvaluecache", matching the
    // title-derived key contributed by the `titles` map — so the
    // title-form wikilink is now recognized as a reference to the
    // deleted page and stripped.
    expect(other).not.toContain("[[Key-Value Cache]]")
    expect(other).toContain("the title-form reference")
  })

  it("21d: filters a deleted page's slug out of surviving pages' `related:` frontmatter, keeping other entries", async () => {
    const tmp = await seed("d21d")
    await cleanupDeletedWikiPages(tmp.path, ["wiki/concepts/kv-cache.md"])

    const other = await readFileRaw(`${tmp.path}/wiki/concepts/other-page.md`)
    expect(other).not.toMatch(/related:.*"kv-cache"/)
    expect(other).toContain('"something-else"')
  })

  it("21e: cleanIndexListing also runs on NESTED index.md pages, not just root wiki/index.md (safety net for PR7 — see source-lifecycle.ts:436, `file.path === pp/wiki/index.md || file.name === \"index.md\"`)", async () => {
    const tmp = await seed("d21e")
    await writeFileRaw(
      `${tmp.path}/wiki/projects/index.md`,
      [
        "# Project Index",
        "",
        "- [[kv-cache]] KV cache implementation notes",
        "- [[other-page]] An unrelated surviving page",
        "",
      ].join("\n"),
    )

    await cleanupDeletedWikiPages(tmp.path, ["wiki/concepts/kv-cache.md"])

    const nestedIndex = await readFileRaw(`${tmp.path}/wiki/projects/index.md`)
    expect(nestedIndex).not.toContain("[[kv-cache]]")
    expect(nestedIndex).toContain("[[other-page]]")
    // Root index.md is unaffected by this fixture — confirm it still
    // behaves the same way it does in 21a, so a future PR7 change that
    // narrows the check to root-only would fail HERE (nested), not there.
    const rootIndex = await readFileRaw(`${tmp.path}/wiki/index.md`)
    expect(rootIndex).not.toContain("[[kv-cache]]")
  })

  it("21f: a stale listDirectory snapshot entry (file already gone from disk) is caught and does not abort the sweep", async () => {
    const tmp = await seed("d21f")
    mocks.listDirectory.mockImplementationOnce(async (p: string) => {
      const real = await realFs.listDirectory(p)
      const ghost: FileNode = {
        name: "ghost.md",
        path: `${p}/ghost.md`,
        is_dir: false,
        children: [],
      }
      return [...real, ghost]
    })

    await expect(cleanupDeletedWikiPages(tmp.path, ["wiki/concepts/kv-cache.md"])).resolves.toBeUndefined()

    // The sweep still completed for the real files despite the ghost
    // entry's readFile throwing ENOENT internally.
    const index = await readFileRaw(`${tmp.path}/wiki/index.md`)
    expect(index).not.toContain("[[kv-cache]]")
  })

  it("21g: removes embeddings only for non-dotfile-prefixed deleted slugs (dotfile paths are silently dropped, no crash)", async () => {
    const tmp = await seed("d21g")
    await cleanupDeletedWikiPages(tmp.path, ["wiki/concepts/kv-cache.md", "wiki/concepts/.hidden.md"])

    expect(mocks.removePageEmbedding).toHaveBeenCalledTimes(1)
    expect(mocks.removePageEmbedding).toHaveBeenCalledWith(
      tmp.path,
      wikiPathToVectorPageId(tmp.path, "wiki/concepts/kv-cache.md"),
    )
  })

  it("21h: attempts to delete wiki/media/<slug> for ANY deleted page, not just source pages (unlike cascadeDeleteWikiPage's isSourcePage gate in wiki-page-delete.ts)", async () => {
    const tmp = await seed("d21h")
    // kv-cache.md is a CONCEPT page, not a wiki/sources/ page — yet
    // cleanupDeletedWikiPages unconditionally attempts to delete its
    // media directory (source-lifecycle.ts:417), unlike
    // cascadeDeleteWikiPage which gates that on isSourcePage.
    await writeFileRaw(`${tmp.path}/wiki/media/kv-cache/image.png`, "fake-bytes")
    expect(await fileExists(`${tmp.path}/wiki/media/kv-cache`)).toBe(true)

    await cleanupDeletedWikiPages(tmp.path, ["wiki/concepts/kv-cache.md"])

    // NOTE: the real fs adapter's deleteFile is `fs.unlink`, which can't
    // remove a non-empty directory (unlike the production Rust
    // `delete_file` command, which auto-detects directories and uses
    // remove_dir_all) — so the directory itself may still be present in
    // this test harness. The call itself is the behavior under test.
    expect(mocks.deleteFile).toHaveBeenCalledWith(`${tmp.path}/wiki/media/kv-cache`)
  })
})
