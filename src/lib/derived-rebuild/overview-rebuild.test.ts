/**
 * Unit tests for SPEC-6 PR5's `overview` layer: LLM-config gating, prompt
 * budget truncation, frontmatter validation before write, and wiring into
 * the shared manual-rebuild closeout (mocked so these tests exercise only
 * this file's own logic — `manual-rebuild.ts` has its own test file).
 */
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { LlmConfig } from "@/stores/wiki-store"

const fsMocks = vi.hoisted(() => ({ writeFileAtomic: vi.fn() }))
vi.mock("@/commands/fs", () => ({ writeFileAtomic: fsMocks.writeFileAtomic }))

const hasUsableLlmMock = vi.hoisted(() => vi.fn())
vi.mock("@/lib/has-usable-llm", () => ({ hasUsableLlm: hasUsableLlmMock }))

const streamChatMock = vi.hoisted(() => vi.fn())
vi.mock("@/lib/pool-chat", () => ({ streamChatRouted: streamChatMock }))

const indexExportMocks = vi.hoisted(() => ({
  scanIndexExportPages: vi.fn(),
  groupIndexExportPages: vi.fn(),
  formatIndexExportMarkdown: vi.fn(),
}))
vi.mock("./index-export", () => indexExportMocks)

const manualRebuildMock = vi.hoisted(() => vi.fn())
vi.mock("./manual-rebuild", () => ({ runManualRebuild: manualRebuildMock }))

import { rebuildOverview } from "./overview-rebuild"

function llmConfig(overrides: Partial<LlmConfig> = {}): LlmConfig {
  return {
    provider: "openai",
    apiKey: "key",
    model: "gpt-test",
    ollamaUrl: "http://localhost:11434",
    customEndpoint: "",
    maxContextSize: 204800,
    reasoning: { mode: "auto" },
    ...overrides,
  } as LlmConfig
}

/** Runs the `execute` callback passed to `runManualRebuild` directly, mirroring rebuildIndexExport's test. */
function wireManualRebuildToRunExecuteDirectly(): void {
  manualRebuildMock.mockImplementation(async (options: { execute: () => Promise<unknown> }) => ({
    result: await options.execute(),
    runtimeTracked: true,
  }))
}

function mockAccumulatedTokens(text: string): void {
  streamChatMock.mockImplementation(async (_family: unknown, _config: unknown, _messages: unknown, callbacks: { onToken: (t: string) => void; onDone: () => void }) => {
    callbacks.onToken(text)
    callbacks.onDone()
  })
}

const validOverviewMarkdown = `---
type: overview
title: Project Overview
tags: []
related: []
---

# Overview

This wiki covers things.`

beforeEach(() => {
  vi.clearAllMocks()
  indexExportMocks.scanIndexExportPages.mockResolvedValue([])
  indexExportMocks.groupIndexExportPages.mockReturnValue([])
  indexExportMocks.formatIndexExportMarkdown.mockReturnValue("# Wiki Index\n\n## Entities\n")
})

describe("rebuildOverview", () => {
  it("throws before any bookkeeping starts when the LLM configuration isn't usable", async () => {
    hasUsableLlmMock.mockReturnValue(false)

    await expect(rebuildOverview("/proj", llmConfig())).rejects.toThrow("no usable LLM configured")
    expect(manualRebuildMock).not.toHaveBeenCalled()
  })

  it("streams the LLM response, validates overview frontmatter, and writes wiki/overview.md", async () => {
    hasUsableLlmMock.mockReturnValue(true)
    wireManualRebuildToRunExecuteDirectly()
    mockAccumulatedTokens(validOverviewMarkdown)

    const result = await rebuildOverview("/proj", llmConfig())

    expect(manualRebuildMock).toHaveBeenCalledWith(
      expect.objectContaining({ layer: "overview", affectedPath: "wiki/overview.md", holder: "overview-manual-rebuild" }),
    )
    expect(fsMocks.writeFileAtomic).toHaveBeenCalledWith("/proj/wiki/overview.md", validOverviewMarkdown.trim())
    expect(result).toEqual({ path: "wiki/overview.md", runtimeTracked: true })
  })

  it("includes the index-export page listing in the prompt sent to the LLM", async () => {
    hasUsableLlmMock.mockReturnValue(true)
    wireManualRebuildToRunExecuteDirectly()
    indexExportMocks.formatIndexExportMarkdown.mockReturnValue("## Concepts\n\n- [[concept/a]] — A")
    mockAccumulatedTokens(validOverviewMarkdown)

    await rebuildOverview("/proj", llmConfig())

    const [, , messages] = streamChatMock.mock.calls[0]
    expect(messages[0].content).toContain("- [[concept/a]] — A")
  })

  it("truncates an oversized page listing to the LLM's context budget instead of sending it whole", async () => {
    hasUsableLlmMock.mockReturnValue(true)
    wireManualRebuildToRunExecuteDirectly()
    const hugeListing = "x".repeat(5_000)
    indexExportMocks.formatIndexExportMarkdown.mockReturnValue(hugeListing)
    mockAccumulatedTokens(validOverviewMarkdown)

    // maxContextSize 1000 -> pageBudget = floor(1000 * 0.5) = 500 chars.
    await rebuildOverview("/proj", llmConfig({ maxContextSize: 1000 }))

    const [, , messages] = streamChatMock.mock.calls[0]
    const promptContent = messages[0].content as string
    expect(promptContent).not.toContain(hugeListing)
    expect(promptContent).toContain("x".repeat(500))
    expect(promptContent).toContain("(truncated)")
  })

  it("fails the rebuild when the LLM stream reports an error", async () => {
    hasUsableLlmMock.mockReturnValue(true)
    wireManualRebuildToRunExecuteDirectly()
    streamChatMock.mockImplementation(async (_family: unknown, _config: unknown, _messages: unknown, callbacks: { onError: (err: unknown) => void }) => {
      callbacks.onError(new Error("transport failed"))
    })

    await expect(rebuildOverview("/proj", llmConfig())).rejects.toThrow("transport failed")
    expect(fsMocks.writeFileAtomic).not.toHaveBeenCalled()
  })

  it("fails the rebuild when the LLM returns an empty response", async () => {
    hasUsableLlmMock.mockReturnValue(true)
    wireManualRebuildToRunExecuteDirectly()
    mockAccumulatedTokens("   ")

    await expect(rebuildOverview("/proj", llmConfig())).rejects.toThrow("empty response")
    expect(fsMocks.writeFileAtomic).not.toHaveBeenCalled()
  })

  it("fails the rebuild when the LLM output is missing valid overview frontmatter, without writing the file", async () => {
    hasUsableLlmMock.mockReturnValue(true)
    wireManualRebuildToRunExecuteDirectly()
    mockAccumulatedTokens("# Just a heading, no frontmatter at all")

    await expect(rebuildOverview("/proj", llmConfig())).rejects.toThrow("missing valid overview frontmatter")
    expect(fsMocks.writeFileAtomic).not.toHaveBeenCalled()
  })
})
