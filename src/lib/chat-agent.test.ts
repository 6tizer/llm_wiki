import { beforeEach, describe, expect, it, vi } from "vitest"
import { listDirectory, readFile } from "@/commands/fs"
import type { ChatMessage, StreamCallbacks } from "@/lib/llm-client"
import type { SearchWikiResponse } from "@/lib/search"
import {
  buildChatAgentMessages,
  getChatAgentTools,
  parseDecision,
  parseUnderstanding,
  shouldBypassAgentPlanner,
} from "./chat-agent"
import type { AnyTxtSearchSmartOptions } from "./anytxt-search"
import type { LlmConfig, SearchApiConfig } from "@/stores/wiki-store"
import type { FileNode } from "@/types/wiki"

const fsMock = vi.hoisted(() => ({
  tree: [] as FileNode[],
  files: new Map<string, string>(),
}))

vi.mock("@/commands/fs", () => ({
  listDirectory: vi.fn(async () => fsMock.tree),
  readFile: vi.fn(async (path: string) => fsMock.files.get(path) ?? ""),
}))

const llmConfig: LlmConfig = {
  provider: "custom",
  apiKey: "",
  model: "test-model",
  ollamaUrl: "",
  customEndpoint: "http://127.0.0.1:9999/v1/chat/completions",
  maxContextSize: 32_000,
}

const searchApiConfig: SearchApiConfig = {
  provider: "none",
  apiKey: "",
}

describe("chat agent router", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    fsMock.tree = []
    fsMock.files.clear()
  })

  it("filters tools by project availability, external toggles, and mode", () => {
    expect(
      getChatAgentTools({
        hasProject: false,
        webSearchEnabled: true,
        anyTxtSearchEnabled: true,
        mode: "standard",
      }).map((tool) => tool.name),
    ).toEqual(["web_search", "anytxt_search"])

    expect(
      getChatAgentTools({
        hasProject: true,
        webSearchEnabled: true,
        anyTxtSearchEnabled: true,
        mode: "fast",
      }).map((tool) => tool.name),
    ).not.toContain("project_file_read")

    expect(
      getChatAgentTools({
        hasProject: true,
        webSearchEnabled: true,
        anyTxtSearchEnabled: false,
        mode: "local_first",
      }).map((tool) => tool.name),
    ).not.toContain("web_search")
  })

  it("bypasses retrieval for greetings and short follow-ups", () => {
    expect(shouldBypassAgentPlanner("你好")?.action).toBe("answer")
    expect(shouldBypassAgentPlanner("continue")?.action).toBe("answer")
    expect(shouldBypassAgentPlanner("explain the graph relationships")).toBeNull()
  })

  it("parses understanding and decision JSON with deterministic fallbacks", () => {
    expect(
      parseUnderstanding(
        '```json\n{"intent":"mixed","rewrittenQuery":"router","needsWiki":true,"needsExternal":true,"wikiQueries":["chat"],"externalQueries":["docs"]}\n```',
        "fallback",
        { hasProject: true, webSearchEnabled: true, anyTxtSearchEnabled: false },
      ),
    ).toMatchObject({
      intent: "mixed",
      rewrittenQuery: "router",
      needsWiki: true,
      needsExternal: true,
      wikiQueries: ["chat"],
      externalQueries: ["docs"],
    })

    expect(parseDecision("not json", "fallback")).toEqual({
      action: "wiki_search",
      queries: ["fallback"],
      reason: "router fallback",
    })
  })

  it("does not call the planner LLM for direct greeting turns", async () => {
    const streamChat = vi.fn()
    const result = await buildChatAgentMessages({
      project: { name: "Demo", path: "/tmp/demo" },
      llmConfig,
      searchApiConfig,
      text: "hello",
      historyMessages: [{ role: "user", content: "hello" }],
      dataVersion: 1,
      options: {
        useWebSearch: false,
        useAnyTxtSearch: false,
        mode: "standard",
      },
      deps: { streamChat },
    })

    expect(streamChat).not.toHaveBeenCalled()
    expect(result.references).toEqual([])
    expect(result.steps.map((step) => step.type)).toEqual(["understanding", "final"])
    expect(result.messages[0]).toMatchObject({ role: "system" })
  })

  it("does not build historical observations for direct turns", async () => {
    const streamChat = vi.fn()
    const searchWiki = vi.fn()
    const result = await buildChatAgentMessages({
      project: { name: "Demo", path: "/tmp/demo" },
      llmConfig,
      searchApiConfig,
      text: "hello",
      historyMessages: [{ role: "user", content: "hello" }],
      retrievalHistory: [
        {
          title: "Prior page",
          path: "/tmp/demo/wiki/prior.md",
          kind: "wiki",
        },
      ],
      dataVersion: 1,
      options: {
        useWebSearch: false,
        useAnyTxtSearch: false,
        mode: "standard",
      },
      deps: { streamChat, searchWiki },
    })

    expect(streamChat).not.toHaveBeenCalled()
    expect(searchWiki).not.toHaveBeenCalled()
    expect(readFile).not.toHaveBeenCalled()
    expect(result.references).toEqual([])
  })

  it("does not run another planner or tool round when understanding returns follow_up", async () => {
    const streamChat = vi.fn(async (
      _config: LlmConfig,
      _messages: ChatMessage[],
      callbacks: StreamCallbacks,
    ) => {
      callbacks.onToken(JSON.stringify({
        intent: "follow_up",
        rewrittenQuery: "same topic",
        wikiQueries: [],
        graphQueries: [],
        externalQueries: [],
        needsWiki: false,
        needsGraph: false,
        needsExternal: false,
        isFollowUp: true,
        reason: "uses prior context",
      }))
      callbacks.onDone()
    })
    const searchWiki = vi.fn()
    const webSearch = vi.fn()

    const result = await buildChatAgentMessages({
      project: null,
      llmConfig,
      searchApiConfig,
      text: "How does that connect to the previous source?",
      historyMessages: [{ role: "user", content: "previous question" }],
      retrievalHistory: [
        {
          title: "Prior external",
          path: "https://example.test",
          kind: "external",
          source: "web",
          url: "https://example.test",
          snippet: "prior context",
        },
      ],
      dataVersion: 1,
      options: {
        useWebSearch: true,
        useAnyTxtSearch: false,
        mode: "standard",
      },
      deps: { streamChat, searchWiki, webSearch },
    })

    expect(streamChat).toHaveBeenCalledTimes(1)
    expect(searchWiki).not.toHaveBeenCalled()
    expect(webSearch).not.toHaveBeenCalled()
    expect(result.plan).toEqual([
      { action: "finish", queries: [], reason: "uses prior context" },
    ])
    expect(result.references).toEqual([
      {
        title: "Prior external",
        path: "https://example.test",
        kind: "external",
        source: "web",
        url: "https://example.test",
        snippet: "prior context",
      },
    ])
  })

  it("forwards abort signal to external tool calls", async () => {
    const controller = new AbortController()
    const streamChat = vi.fn(async (
      _config: LlmConfig,
      _messages: ChatMessage[],
      callbacks: StreamCallbacks,
    ) => {
      callbacks.onToken(JSON.stringify({
        intent: "external",
        rewrittenQuery: "latest docs",
        wikiQueries: [],
        graphQueries: [],
        externalQueries: ["latest docs"],
        needsWiki: false,
        needsGraph: false,
        needsExternal: true,
        isFollowUp: false,
        reason: "needs current source",
      }))
      callbacks.onDone()
    })
    const webSearch = vi.fn(async (
      _query: string,
      _config: SearchApiConfig,
      _maxResults?: number,
      signal?: AbortSignal,
    ) => {
      expect(signal).toBe(controller.signal)
      return [
        {
          title: "Docs",
          url: "https://example.test/docs",
          snippet: "current docs",
          source: "web",
        },
      ]
    })

    await buildChatAgentMessages({
      project: null,
      llmConfig,
      searchApiConfig,
      text: "latest docs",
      historyMessages: [{ role: "user", content: "latest docs" }],
      dataVersion: 1,
      options: {
        useWebSearch: true,
        useAnyTxtSearch: false,
        mode: "standard",
      },
      signal: controller.signal,
      deps: { streamChat, webSearch },
    })

    expect(webSearch).toHaveBeenCalledTimes(1)
  })

  it("passes AnyTXT search settings as named options", async () => {
    const controller = new AbortController()
    const streamChat = vi.fn(async (
      _config: LlmConfig,
      _messages: ChatMessage[],
      callbacks: StreamCallbacks,
    ) => {
      callbacks.onToken(JSON.stringify({
        intent: "external",
        rewrittenQuery: "local docs",
        wikiQueries: [],
        graphQueries: [],
        externalQueries: ["local docs"],
        needsWiki: false,
        needsGraph: false,
        needsExternal: true,
        isFollowUp: false,
        reason: "needs local source",
      }))
      callbacks.onDone()
    })
    const anyTxtSearchSmart = vi.fn(async (
      _query: string | string[],
      options?: AnyTxtSearchSmartOptions,
    ) => {
      expect(options).toMatchObject({
        config: { endpoint: "http://127.0.0.1:9920" },
        llmConfig,
        maxResults: 5,
        projectPath: "",
        signal: controller.signal,
      })
      return [
        {
          title: "Local Docs",
          url: "file:///tmp/local.md",
          snippet: "local docs",
          source: "AnyTXT",
        },
      ]
    })

    await buildChatAgentMessages({
      project: null,
      llmConfig,
      searchApiConfig: {
        ...searchApiConfig,
        anyTxt: { endpoint: "http://127.0.0.1:9920" },
      },
      text: "local docs",
      historyMessages: [{ role: "user", content: "local docs" }],
      dataVersion: 1,
      options: {
        useWebSearch: false,
        useAnyTxtSearch: true,
        mode: "standard",
      },
      signal: controller.signal,
      deps: { streamChat, anyTxtSearchSmart },
    })

    expect(anyTxtSearchSmart).toHaveBeenCalledTimes(1)
    expect(anyTxtSearchSmart.mock.calls[0][0]).toBe("local docs")
  })

  it("answers directly when no project or external retrieval source is available", async () => {
    const streamChat = vi.fn()
    const result = await buildChatAgentMessages({
      project: null,
      llmConfig,
      searchApiConfig,
      text: "explain TypeScript closures",
      historyMessages: [{ role: "user", content: "explain TypeScript closures" }],
      dataVersion: 1,
      options: {
        useWebSearch: false,
        useAnyTxtSearch: false,
        mode: "deep",
      },
      deps: { streamChat },
    })

    expect(streamChat).not.toHaveBeenCalled()
    expect(result.plan).toEqual([
      { action: "answer", queries: [], reason: "no retrieval sources" },
    ])
  })

  it("graph_search expands same-stem search hits through path-aware graph ids", async () => {
    setWikiFiles({
      "wiki/foo.md": page("Root Foo", "Root page."),
      "wiki/something/wiki/foo.md": page("Nested Foo", "Nested page links to [[related]]."),
      "wiki/concepts/related.md": page("Related Concept", "Related page."),
    })
    const streamChat = vi.fn(async (
      _config: LlmConfig,
      _messages: ChatMessage[],
      callbacks: StreamCallbacks,
    ) => {
      callbacks.onToken(JSON.stringify({
        intent: "graph",
        rewrittenQuery: "nested foo graph",
        wikiQueries: [],
        graphQueries: ["nested foo graph"],
        externalQueries: [],
        needsWiki: false,
        needsGraph: true,
        needsExternal: false,
        isFollowUp: false,
        reason: "graph relationship",
      }))
      callbacks.onDone()
    })
    const searchWiki = vi.fn(async (): Promise<SearchWikiResponse> => ({
      mode: "hybrid",
      vectorHits: 0,
      results: [
        {
          path: "/tmp/demo/wiki/something/wiki/foo.md",
          title: "Nested Foo",
          snippet: "Nested Foo",
          titleMatch: true,
          score: 1,
          images: [],
        },
      ],
    }))

    const result = await buildChatAgentMessages({
      project: { name: "Demo", path: "/tmp/demo" },
      llmConfig,
      searchApiConfig,
      text: "nested foo graph",
      historyMessages: [{ role: "user", content: "nested foo graph" }],
      dataVersion: 2,
      options: {
        useWebSearch: false,
        useAnyTxtSearch: false,
        mode: "standard",
      },
      deps: { streamChat, searchWiki },
    })

    expect(result.references.map((ref) => ref.path)).toContain("/tmp/demo/wiki/concepts/related.md")
    expect(result.queryPages.map((page) => page.title)).toContain("Related Concept")
    expect(listDirectory).toHaveBeenCalledWith("/tmp/demo/wiki")
  })

  it("wiki_search executes with a real non-empty wikiQueries and materializes results through collectSearchResults' {results,mode,vectorHits} destructuring (Tester P1 regression lock)", async () => {
    setWikiFiles({
      "wiki/foo.md": page("Foo Page", "Foo body."),
    })
    const streamChat = vi.fn(async (
      _config: LlmConfig,
      _messages: ChatMessage[],
      callbacks: StreamCallbacks,
    ) => {
      callbacks.onToken(JSON.stringify({
        intent: "kb_search",
        rewrittenQuery: "foo topic",
        wikiQueries: ["foo topic"],
        graphQueries: [],
        externalQueries: [],
        needsWiki: true,
        needsGraph: false,
        needsExternal: false,
        isFollowUp: false,
        reason: "local wiki question",
      }))
      callbacks.onDone()
    })
    const searchWiki = vi.fn(async (): Promise<SearchWikiResponse> => ({
      mode: "hybrid",
      vectorHits: 1,
      results: [
        {
          path: "/tmp/demo/wiki/foo.md",
          title: "Foo Page",
          snippet: "Foo body.",
          titleMatch: true,
          score: 1,
          images: [],
        },
      ],
    }))

    const result = await buildChatAgentMessages({
      project: { name: "Demo", path: "/tmp/demo" },
      llmConfig,
      searchApiConfig,
      text: "foo topic",
      historyMessages: [{ role: "user", content: "foo topic" }],
      dataVersion: 3,
      options: {
        useWebSearch: false,
        useAnyTxtSearch: false,
        mode: "standard",
      },
      deps: { streamChat, searchWiki },
    })

    expect(searchWiki).toHaveBeenCalledWith("/tmp/demo", "foo topic")
    expect(result.references.map((ref) => ref.path)).toContain("/tmp/demo/wiki/foo.md")
    expect(result.queryPages.map((page) => page.title)).toContain("Foo Page")
  })
})

function page(title: string, body = "", type = "concept"): string {
  return `---\ntitle: ${title}\ntype: ${type}\n---\n# ${title}\n${body}\n`
}

function setWikiFiles(files: Record<string, string>): void {
  fsMock.files.clear()
  fsMock.files.set("/tmp/demo/wiki/index.md", "# Index\n")
  fsMock.files.set("/tmp/demo/purpose.md", "")
  for (const [relPath, content] of Object.entries(files)) {
    fsMock.files.set(`/tmp/demo/${relPath}`, content)
  }
  fsMock.tree = buildTree(Object.keys(files))
}

function buildTree(paths: string[]): FileNode[] {
  const root: FileNode[] = []
  for (const relPath of paths) {
    const wikiRel = relPath.replace(/^wiki\//, "")
    const parts = wikiRel.split("/")
    let children = root
    let currentPath = "/tmp/demo/wiki"
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
