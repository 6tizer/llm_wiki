import { describe, expect, it } from "vitest"
import {
  isRootStructuralWikiPagePath,
  normalizeProjectWikiMarkdownPath,
  normalizeWikiMarkdownPath,
  wikiRelativePathToVectorPageId,
  wikiPathToLegacyStemId,
  wikiPathToVectorPageId,
} from "./wiki-page-identity"

describe("wiki page identity helpers", () => {
  it("normalizes project absolute paths through the active project root", () => {
    expect(normalizeProjectWikiMarkdownPath("/tmp/wiki/proj", "/tmp/wiki/proj/wiki/foo.md")).toBe("wiki/foo.md")
    expect(normalizeProjectWikiMarkdownPath("/tmp/wiki/proj", "/tmp/wiki/proj/wiki/something/wiki/foo.md")).toBe(
      "wiki/something/wiki/foo.md",
    )
  })

  it("keeps nested wiki folders distinct from the project wiki root", () => {
    const rootPage = wikiPathToVectorPageId("/tmp/proj", "/tmp/proj/wiki/foo.md")
    const nestedPage = wikiPathToVectorPageId("/tmp/proj", "/tmp/proj/wiki/something/wiki/foo.md")

    expect(rootPage).not.toBe(nestedPage)
  })

  it("matches absolute and wiki-relative ids for the same page", () => {
    expect(wikiRelativePathToVectorPageId("wiki/a/b.md")).toBe("wp_d2lraS9hL2I")
    expect(wikiPathToVectorPageId("/tmp/proj", "/tmp/proj/wiki/a/b.md")).toBe("wp_d2lraS9hL2I")
    expect(wikiPathToVectorPageId("C:/tmp/proj", "C:\\tmp\\proj\\wiki\\a\\b.md")).toBe("wp_d2lraS9hL2I")
  })

  it("uses fixed base64url vectors for Unicode wiki paths", () => {
    expect(wikiPathToVectorPageId("/tmp/proj", "/tmp/proj/wiki/sources/默会 知识.v1.md")).toBe(
      "wp_d2lraS9zb3VyY2VzL-m7mOS8miDnn6Xor4YudjE",
    )
  })

  it("treats only root wiki structural markdown paths as structural", () => {
    expect(isRootStructuralWikiPagePath("/tmp/proj", "/tmp/proj/wiki/log.md")).toBe(true)
    expect(isRootStructuralWikiPagePath("/tmp/proj", "wiki/index.md")).toBe(true)
    expect(isRootStructuralWikiPagePath("/tmp/proj", "/tmp/proj/wiki/projects/log.md")).toBe(false)
  })

  it("rejects absolute paths outside the active project", () => {
    expect(() => wikiPathToVectorPageId("/tmp/proj", "/tmp/other/wiki/foo.md")).toThrow(
      "inside the active project",
    )
  })

  it("does not accept arbitrary absolute paths without a project root", () => {
    expect(() => normalizeWikiMarkdownPath("/tmp/proj/wiki/foo.md")).toThrow("project-relative")
  })

  it("rejects invalid wiki-relative path segments", () => {
    expect(() => normalizeWikiMarkdownPath("wiki//foo.md")).toThrow("Invalid wiki page path")
    expect(() => normalizeWikiMarkdownPath("wiki/../foo.md")).toThrow("Invalid wiki page path")
    expect(() => normalizeWikiMarkdownPath("wiki/./foo.md")).toThrow("Invalid wiki page path")
    expect(() => normalizeWikiMarkdownPath("wiki/.md")).toThrow("Invalid wiki page path")
  })

  it("keeps legacy stem identity path-only", () => {
    expect(wikiPathToLegacyStemId("/tmp/wiki/proj/wiki/something/wiki/foo.bar.md")).toBe("foo.bar")
  })
})
