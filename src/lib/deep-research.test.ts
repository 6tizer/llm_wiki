import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { collectResearchSources, queueResearch } from "./deep-research"
import { useResearchStore } from "@/stores/research-store"
import { useWikiStore } from "@/stores/wiki-store"
import type { SearchApiConfig } from "@/stores/wiki-store"
import type { WebSearchResult } from "./web-search"

const webResult: WebSearchResult = {
  title: "Web",
  url: "https://example.com/web",
  snippet: "web snippet",
  source: "example.com",
}

const localResult: WebSearchResult = {
  title: "Local",
  url: "file:///C:/docs/local.md",
  snippet: "local snippet",
  source: "AnyTXT",
}

function config(patch: Partial<SearchApiConfig>): SearchApiConfig {
  return {
    provider: "none",
    apiKey: "",
    ...patch,
  }
}

describe("collectResearchSources", () => {
  beforeEach(() => {
    vi.useRealTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    useResearchStore.setState({ tasks: [], panelOpen: false })
    useWikiStore.getState().setProject(null)
  })

  it("uses only Web Search when source mode is web", async () => {
    const webSearch = vi.fn().mockResolvedValue([webResult])
    const anyTxtSearch = vi.fn().mockResolvedValue([localResult])

    const out = await collectResearchSources(
      ["alpha"],
      config({ deepResearchSource: "web", provider: "tavily", apiKey: "tvly" }),
      "/project",
      { webSearch, anyTxtSearch },
    )

    expect(webSearch).toHaveBeenCalledTimes(1)
    expect(anyTxtSearch).not.toHaveBeenCalled()
    expect(out.results).toEqual([webResult])
  })

  it("uses only AnyTXT when source mode is anytxt", async () => {
    const webSearch = vi.fn().mockResolvedValue([webResult])
    const anyTxtSearch = vi.fn().mockResolvedValue([localResult])

    const out = await collectResearchSources(
      ["alpha"],
      config({
        deepResearchSource: "anytxt",
        provider: "tavily",
        apiKey: "tvly",
        anyTxt: { endpoint: "http://127.0.0.1:9920" },
      }),
      "/project",
      { webSearch, anyTxtSearch },
    )

    expect(webSearch).not.toHaveBeenCalled()
    expect(anyTxtSearch).toHaveBeenCalledTimes(1)
    expect(anyTxtSearch.mock.calls[0][0]).toEqual(["alpha"])
    expect(out.results).toEqual([localResult])
  })

  it("uses both sources concurrently and deduplicates by URL", async () => {
    const duplicate = { ...localResult, url: webResult.url }
    const webSearch = vi.fn().mockResolvedValue([webResult])
    const anyTxtSearch = vi.fn().mockResolvedValue([duplicate, localResult])

    const out = await collectResearchSources(
      ["alpha"],
      config({
        deepResearchSource: "both",
        provider: "tavily",
        apiKey: "tvly",
        anyTxt: { endpoint: "http://127.0.0.1:9920" },
      }),
      "/project",
      { webSearch, anyTxtSearch },
    )

    expect(webSearch).toHaveBeenCalledTimes(1)
    expect(anyTxtSearch).toHaveBeenCalledTimes(1)
    expect(out.results).toEqual([webResult, localResult])
  })

  it("keeps web results when AnyTXT fails and exposes the source error", async () => {
    const webSearch = vi.fn().mockResolvedValue([webResult])
    const anyTxtSearch = vi.fn().mockRejectedValue(new Error("Check that ATGUI.exe is running"))

    const out = await collectResearchSources(
      ["alpha"],
      config({
        deepResearchSource: "both",
        provider: "tavily",
        apiKey: "tvly",
        anyTxt: { endpoint: "http://127.0.0.1:9920" },
      }),
      "/project",
      { webSearch, anyTxtSearch },
    )

    expect(out.results).toEqual([webResult])
    expect(out.errors).toEqual(["Check that ATGUI.exe is running"])
  })

  it("exposes errors when all selected sources fail", async () => {
    const webSearch = vi.fn().mockRejectedValue(new Error("web failed"))
    const anyTxtSearch = vi.fn().mockRejectedValue(new Error("local failed"))

    const out = await collectResearchSources(
      ["alpha"],
      config({
        deepResearchSource: "both",
        provider: "tavily",
        apiKey: "tvly",
        anyTxt: { endpoint: "http://127.0.0.1:9920", enabled: true },
      }),
      "/project",
      { webSearch, anyTxtSearch },
    )

    expect(out.results).toEqual([])
    expect(out.errors).toEqual(["web failed", "local failed"])
  })

  it("does not start a queued task after the active project changes", async () => {
    vi.useFakeTimers()
    useResearchStore.setState({ tasks: [], panelOpen: false })
    useWikiStore.getState().setProject({ id: "a", name: "A", path: "/project-a" })

    const taskId = queueResearch(
      "/project-a",
      "alpha",
      {
        provider: "openai",
        apiKey: "",
        model: "gpt",
        ollamaUrl: "",
        customEndpoint: "",
        maxContextSize: 8192,
      },
      config({ provider: "none", apiKey: "" }),
    )
    useWikiStore.getState().setProject({ id: "b", name: "B", path: "/project-b" })

    await vi.advanceTimersByTimeAsync(60)

    const task = useResearchStore.getState().tasks.find((item) => item.id === taskId)
    expect(task?.status).toBe("queued")
    expect(task?.webResults).toEqual([])
  })

  it("does not let a new project consume another project's queued task", async () => {
    vi.useFakeTimers()
    useResearchStore.setState({ tasks: [], panelOpen: false })
    const llmConfig = {
      provider: "openai" as const,
      apiKey: "",
      model: "gpt",
      ollamaUrl: "",
      customEndpoint: "",
      maxContextSize: 8192,
    }

    useWikiStore.getState().setProject({ id: "a", name: "A", path: "/project-a" })
    const taskA = queueResearch(
      "/project-a",
      "alpha",
      llmConfig,
      config({ provider: "none", apiKey: "" }),
    )

    useWikiStore.getState().setProject({ id: "b", name: "B", path: "/project-b" })
    const taskB = queueResearch(
      "/project-b",
      "beta",
      llmConfig,
      config({ provider: "none", apiKey: "" }),
    )

    await vi.advanceTimersByTimeAsync(80)

    const tasks = useResearchStore.getState().tasks
    const a = tasks.find((item) => item.id === taskA)
    const b = tasks.find((item) => item.id === taskB)
    expect(a).toMatchObject({ projectPath: "/project-a", status: "queued", webResults: [] })
    expect(b).toMatchObject({
      projectPath: "/project-b",
      status: "done",
      synthesis: "No research sources found.",
    })
  })

  it("skips Web Search in both mode when no web provider is configured", async () => {
    const webSearch = vi.fn().mockResolvedValue([webResult])
    const anyTxtSearch = vi.fn().mockResolvedValue([localResult])

    const out = await collectResearchSources(
      ["alpha"],
      config({
        deepResearchSource: "both",
        provider: "none",
        anyTxt: { endpoint: "http://127.0.0.1:9920" },
      }),
      "/project",
      { webSearch, anyTxtSearch },
    )

    expect(webSearch).not.toHaveBeenCalled()
    expect(anyTxtSearch).toHaveBeenCalledTimes(1)
    expect(out.results).toEqual([localResult])
  })

  it("returns no results for blank queries", async () => {
    const webSearch = vi.fn().mockResolvedValue([webResult])
    const anyTxtSearch = vi.fn().mockResolvedValue([localResult])

    const out = await collectResearchSources(
      [" ", ""],
      config({ deepResearchSource: "both", provider: "tavily", apiKey: "tvly" }),
      "/project",
      { webSearch, anyTxtSearch },
    )

    expect(webSearch).not.toHaveBeenCalled()
    expect(anyTxtSearch).not.toHaveBeenCalled()
    expect(out.results).toEqual([])
  })

  it("logs once when research sources are capped", async () => {
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {})
    const webSearch = vi.fn().mockResolvedValue(
      Array.from({ length: 25 }, (_, index) => ({
        title: `Result ${index}`,
        url: `https://example.com/${index}`,
        snippet: "snippet",
        source: "example.com",
      })),
    )
    const anyTxtSearch = vi.fn().mockResolvedValue([])

    const out = await collectResearchSources(
      ["alpha", "beta"],
      config({ deepResearchSource: "web", provider: "tavily", apiKey: "tvly" }),
      "/project",
      { webSearch, anyTxtSearch },
    )

    expect(out.results).toHaveLength(20)
    expect(infoSpy).toHaveBeenCalledTimes(1)
    infoSpy.mockRestore()
  })
})
