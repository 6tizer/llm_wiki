import { beforeEach, describe, expect, it, vi } from "vitest"
import { readFile } from "@/commands/fs"
import type { ChatMessage, StreamCallbacks } from "@/lib/llm-client"
import {
  buildChatAgentMessages,
  getChatAgentTools,
  parseDecision,
  parseUnderstanding,
  shouldBypassAgentPlanner,
} from "./chat-agent"
import type { LlmConfig, SearchApiConfig } from "@/stores/wiki-store"

vi.mock("@/commands/fs", () => ({
  listDirectory: vi.fn(async () => []),
  readFile: vi.fn(async () => ""),
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
})
