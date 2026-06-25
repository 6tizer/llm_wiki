import { beforeEach, describe, expect, it, vi } from "vitest"

const fsMocks = vi.hoisted(() => ({
  readFile: vi.fn<(path: string) => Promise<string>>(),
  writeFile: vi.fn<() => Promise<void>>(),
  fileExists: vi.fn<() => Promise<boolean>>(),
  deleteFile: vi.fn<() => Promise<void>>(),
  listDirectory: vi.fn<() => Promise<unknown[]>>(),
  getFileMd5: vi.fn<() => Promise<string>>(),
}))

const mineruMocks = vi.hoisted(() => ({
  parseWithMineru: vi.fn<() => Promise<string>>(),
}))

const cacheMocks = vi.hoisted(() => ({
  checkIngestCache: vi.fn<() => Promise<string[] | null>>(),
  saveIngestCache: vi.fn<() => Promise<void>>(),
}))

const imageMocks = vi.hoisted(() => ({
  extractAndSaveSourceImages: vi.fn<() => Promise<unknown[]>>(),
  extractAndSaveMarkdownImages: vi.fn<() => Promise<unknown[]>>(),
}))

const llmMocks = vi.hoisted(() => ({
  streamChat: vi.fn(),
}))

vi.mock("@/commands/fs", () => ({
  readFile: fsMocks.readFile,
  writeFile: fsMocks.writeFile,
  fileExists: fsMocks.fileExists,
  deleteFile: fsMocks.deleteFile,
  listDirectory: fsMocks.listDirectory,
  getFileMd5: fsMocks.getFileMd5,
}))

vi.mock("@/lib/mineru", () => ({
  parseWithMineru: mineruMocks.parseWithMineru,
}))

vi.mock("@/lib/ingest-cache", () => ({
  checkIngestCache: cacheMocks.checkIngestCache,
  saveIngestCache: cacheMocks.saveIngestCache,
}))

vi.mock("@/lib/extract-source-images", () => ({
  extractAndSaveSourceImages: imageMocks.extractAndSaveSourceImages,
  extractAndSaveMarkdownImages: imageMocks.extractAndSaveMarkdownImages,
}))

vi.mock("@/lib/llm-client", () => ({
  streamChat: llmMocks.streamChat,
}))

import { autoIngest } from "./ingest"
import { useActivityStore } from "@/stores/activity-store"
import { useWikiStore } from "@/stores/wiki-store"

const llmConfig = {
  provider: "openai",
  apiKey: "key",
  model: "model",
  ollamaUrl: "",
  customEndpoint: "",
  maxContextSize: 128000,
} as const

beforeEach(() => {
  vi.clearAllMocks()
  useActivityStore.setState({ items: [] })
  useWikiStore.getState().setMineruConfig({
    enabled: true,
    token: "mineru-token",
    modelVersion: "vlm",
    apiBaseUrl: "",
  })
  useWikiStore.getState().setMultimodalConfig({
    enabled: false,
    useMainLlm: true,
    provider: "custom",
    apiKey: "",
    model: "",
    ollamaUrl: "",
    customEndpoint: "",
    concurrency: 4,
  })
  fsMocks.readFile.mockImplementation(async (path: string) => {
    if (path.includes("/.llm-wiki/mineru/")) throw new Error("missing parsed MinerU cache")
    return ""
  })
  fsMocks.writeFile.mockResolvedValue(undefined)
  fsMocks.fileExists.mockResolvedValue(true)
  fsMocks.deleteFile.mockResolvedValue(undefined)
  fsMocks.listDirectory.mockResolvedValue([])
  fsMocks.getFileMd5.mockResolvedValue("pdf-md5")
  mineruMocks.parseWithMineru.mockResolvedValue("# MinerU markdown")
  cacheMocks.checkIngestCache.mockResolvedValue(["wiki/sources/paper.md"])
  cacheMocks.saveIngestCache.mockResolvedValue(undefined)
  imageMocks.extractAndSaveSourceImages.mockResolvedValue([])
  imageMocks.extractAndSaveMarkdownImages.mockResolvedValue([])
  llmMocks.streamChat.mockImplementation(async (_config, messages, callbacks) => {
    const prompt = JSON.stringify(messages)
    if (prompt.includes("Analyze this source document")) {
      callbacks.onToken("analysis")
    } else {
      callbacks.onToken("---FILE: wiki/sources/paper.md---\n# Paper\n\nBody\n---END FILE---")
    }
    callbacks.onDone?.()
  })
})

describe("autoIngest MinerU PDF strategy", () => {
  it("uses the local PDF fingerprint to hit MinerU cache before cloud parsing", async () => {
    await expect(
      autoIngest("/project", "/project/raw/sources/paper.pdf", llmConfig as never),
    ).resolves.toEqual(["wiki/sources/paper.md"])

    expect(mineruMocks.parseWithMineru).not.toHaveBeenCalled()
    expect(cacheMocks.checkIngestCache).toHaveBeenCalledWith(
      "/project",
      "paper.pdf",
      "mineru-source-md5:pdf-md5",
      "mineru:vlm",
    )
    expect(imageMocks.extractAndSaveSourceImages).not.toHaveBeenCalled()
    expect(imageMocks.extractAndSaveMarkdownImages).not.toHaveBeenCalled()
  })

  it("runs markdown image repair from the local MinerU parsed markdown cache on ingest cache hit", async () => {
    const cachedMarkdown = "# MinerU cached markdown\n\n![](media/paper/mineru/figure.png)"
    fsMocks.readFile.mockImplementation(async (path: string) => {
      if (path.includes("/.llm-wiki/mineru/")) return cachedMarkdown
      return ""
    })

    await expect(
      autoIngest("/project", "/project/raw/sources/paper.pdf", llmConfig as never),
    ).resolves.toEqual(["wiki/sources/paper.md"])

    expect(mineruMocks.parseWithMineru).not.toHaveBeenCalled()
    expect(imageMocks.extractAndSaveSourceImages).not.toHaveBeenCalled()
    expect(imageMocks.extractAndSaveMarkdownImages).toHaveBeenCalledWith(
      "/project",
      "/project/raw/sources/paper.pdf",
      cachedMarkdown,
      "paper",
      { baseDir: "/project/wiki", reuseExistingWikiMedia: true },
    )
    expect(cacheMocks.checkIngestCache).toHaveBeenCalledTimes(1)
  })

  it("stores MinerU parsed markdown after cloud parsing for later cache-hit repair", async () => {
    cacheMocks.checkIngestCache
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(["wiki/sources/paper.md"])

    await expect(
      autoIngest("/project", "/project/raw/sources/paper.pdf", llmConfig as never),
    ).resolves.toEqual(["wiki/sources/paper.md"])

    expect(mineruMocks.parseWithMineru).toHaveBeenCalledTimes(1)
    expect(fsMocks.writeFile).toHaveBeenCalledWith(
      "/project/.llm-wiki/mineru/paper-mineru_vlm.md",
      "# MinerU markdown",
    )
    expect(imageMocks.extractAndSaveMarkdownImages).toHaveBeenCalledWith(
      "/project",
      "/project/raw/sources/paper.pdf",
      "# MinerU markdown",
      "paper",
      { baseDir: "/project/wiki", reuseExistingWikiMedia: true },
    )
  })

  it("skips MinerU media repair without cloud upload when parsed markdown cache is missing", async () => {
    await expect(
      autoIngest("/project", "/project/raw/sources/paper.pdf", llmConfig as never),
    ).resolves.toEqual(["wiki/sources/paper.md"])

    const activity = useActivityStore.getState().items[0]
    expect(mineruMocks.parseWithMineru).not.toHaveBeenCalled()
    expect(imageMocks.extractAndSaveMarkdownImages).not.toHaveBeenCalled()
    expect(activity?.detail).toContain("MinerU parsed cache missing")
  })

  it("falls back to local PDF parsing on non-abort MinerU failure", async () => {
    cacheMocks.checkIngestCache
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(["wiki/sources/paper.md"])
    mineruMocks.parseWithMineru.mockRejectedValueOnce(new Error("quota reached"))
    fsMocks.readFile.mockImplementation(async (path: string) =>
      path.endsWith("paper.pdf") ? "local pdfium markdown" : "",
    )

    await expect(
      autoIngest("/project", "/project/raw/sources/paper.pdf", llmConfig as never),
    ).resolves.toEqual(["wiki/sources/paper.md"])

    expect(cacheMocks.checkIngestCache).toHaveBeenCalledWith(
      "/project",
      "paper.pdf",
      "mineru-source-md5:pdf-md5",
      "mineru:vlm",
    )
    expect(cacheMocks.checkIngestCache).toHaveBeenLastCalledWith(
      "/project",
      "paper.pdf",
      "local pdfium markdown",
      "local",
    )
    expect(imageMocks.extractAndSaveSourceImages).toHaveBeenCalledWith(
      "/project",
      "/project/raw/sources/paper.pdf",
      "paper",
    )
  })

  it("strips MinerU wiki media refs from the LLM prompt when multimodal is disabled", async () => {
    const mineruMarkdown = '# MinerU markdown\n\n![Chart](media/paper/mineru/images/chart.png "Figure 1")'
    cacheMocks.checkIngestCache.mockResolvedValue(null)
    mineruMocks.parseWithMineru.mockResolvedValueOnce(mineruMarkdown)
    imageMocks.extractAndSaveMarkdownImages.mockResolvedValueOnce([
      {
        index: 1,
        mimeType: "image/png",
        page: null,
        width: 0,
        height: 0,
        relPath: "media/paper/mineru/images/chart.png",
        absPath: "/project/wiki/media/paper/mineru/images/chart.png",
        sha256: "sha",
      },
    ])

    await expect(
      autoIngest("/project", "/project/raw/sources/paper.pdf", llmConfig as never),
    ).resolves.toEqual(["wiki/sources/paper.md"])

    expect(mineruMocks.parseWithMineru).toHaveBeenCalledTimes(1)
    expect(imageMocks.extractAndSaveMarkdownImages).toHaveBeenCalledWith(
      "/project",
      "/project/raw/sources/paper.pdf",
      mineruMarkdown,
      "paper",
      { baseDir: "/project/wiki", reuseExistingWikiMedia: true },
    )
    expect(llmMocks.streamChat).toHaveBeenCalled()
    const serializedPrompts = llmMocks.streamChat.mock.calls
      .map((call) => JSON.stringify(call[1]))
      .join("\n")
    expect(serializedPrompts).not.toContain("media/paper/mineru/images/chart.png")
  })
})
