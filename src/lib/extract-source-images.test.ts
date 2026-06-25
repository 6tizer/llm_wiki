import { beforeEach, describe, expect, it, vi } from "vitest"

const fsMocks = vi.hoisted(() => ({
  copyFile: vi.fn<() => Promise<void>>(),
  createDirectory: vi.fn<() => Promise<void>>(),
  fileExists: vi.fn<() => Promise<boolean>>(),
  readFileAsBase64: vi.fn<() => Promise<{ base64: string; mimeType: string }>>(),
}))

vi.mock("@/commands/fs", () => ({
  copyFile: fsMocks.copyFile,
  createDirectory: fsMocks.createDirectory,
  fileExists: fsMocks.fileExists,
  readFileAsBase64: fsMocks.readFileAsBase64,
}))

import { extractAndSaveMarkdownImages, findLocalMarkdownImageRefs } from "./extract-source-images"

beforeEach(() => {
  vi.clearAllMocks()
  fsMocks.copyFile.mockResolvedValue(undefined)
  fsMocks.createDirectory.mockResolvedValue(undefined)
  fsMocks.fileExists.mockResolvedValue(true)
  fsMocks.readFileAsBase64.mockResolvedValue({ base64: "aW1hZ2UtYnl0ZXM=", mimeType: "image/png" })
})

describe("findLocalMarkdownImageRefs", () => {
  it("extracts Obsidian and markdown local image references", () => {
    const refs = findLocalMarkdownImageRefs(`
![[attachments/chart.png]]
![Figure](images/plot%201.jpg "title")
![Remote](https://example.com/a.png)
![[attachments/chart.png|400]]
`)
    expect(refs).toEqual(["attachments/chart.png", "images/plot 1.jpg"])
  })

  it("ignores non-image links and remote/data references", () => {
    const refs = findLocalMarkdownImageRefs(`
![Doc](notes/page.md)
![Data](data:image/png;base64,abc)
![[draft.txt]]
`)
    expect(refs).toEqual([])
  })

  it("reuses MinerU wiki media refs resolved from the wiki root", async () => {
    const images = await extractAndSaveMarkdownImages(
      "/project",
      "/project/raw/sources/paper.pdf",
      "![Figure](media/paper/mineru/images/chart.png)",
      "paper",
      { baseDir: "/project/wiki", reuseExistingWikiMedia: true },
    )

    expect(fsMocks.fileExists).toHaveBeenCalledWith(
      "/project/wiki/media/paper/mineru/images/chart.png",
    )
    expect(fsMocks.copyFile).not.toHaveBeenCalled()
    expect(images).toHaveLength(1)
    expect(images[0]).toMatchObject({
      index: 1,
      mimeType: "image/png",
      page: null,
      width: 0,
      height: 0,
      relPath: "media/paper/mineru/images/chart.png",
      absPath: "/project/wiki/media/paper/mineru/images/chart.png",
    })
    expect(images[0]?.sha256).toMatch(/^[a-f0-9]{64}$/)
  })

  it("keeps default markdown image resolution relative to the source directory", async () => {
    await extractAndSaveMarkdownImages(
      "/project",
      "/project/raw/sources/paper.md",
      "![Figure](images/chart.png)",
      "paper",
    )

    expect(fsMocks.fileExists).toHaveBeenCalledWith("/project/raw/sources/images/chart.png")
  })
})
