// @vitest-environment jsdom

import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { beforeEach, describe, expect, it, vi } from "vitest"
import "@/i18n"
import { useWikiStore } from "@/stores/wiki-store"
import { SynthesisSection } from "./synthesis-section"
import type { SynthesisCandidate, SynthesisDiscoveryReport } from "@/lib/wiki-synthesis"

const synthesisMocks = vi.hoisted(() => ({
  discoverSynthesisCandidates: vi.fn(),
  runWikiSynthesis: vi.fn(),
}))

vi.mock("@/lib/wiki-synthesis", async () => {
  const actual = await vi.importActual<typeof import("@/lib/wiki-synthesis")>("@/lib/wiki-synthesis")
  return {
    ...actual,
    discoverSynthesisCandidates: synthesisMocks.discoverSynthesisCandidates,
    runWikiSynthesis: synthesisMocks.runWikiSynthesis,
  }
})

// SPEC-6 PR3+4: the section's post-generate marker closeout call — mocked so
// these tests exercise the section's own wiring in isolation from the real
// runtime-db/Tauri invoke plumbing (covered separately by
// synthesis-staleness.test.ts).
const markSynthesisRebuiltMock = vi.hoisted(() => vi.fn())
vi.mock("@/lib/derived-rebuild/synthesis-staleness", () => ({
  markSynthesisRebuilt: markSynthesisRebuiltMock,
}))

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true

const project = { path: "/project" }

const candidate: SynthesisCandidate = {
  tags: ["ai", "systems"],
  topic: "ai + systems",
  slug: "ai-systems",
  pageCount: 3,
  pages: [
    { slug: "a", title: "A", type: "concept", tags: ["ai", "systems"], body: "A" },
    { slug: "b", title: "B", type: "concept", tags: ["ai", "systems"], body: "B" },
    { slug: "c", title: "C", type: "concept", tags: ["ai", "systems"], body: "C" },
  ],
}

function report(overrides: Partial<SynthesisDiscoveryReport> = {}): SynthesisDiscoveryReport {
  return {
    dimension: 1,
    minClusterSize: 3,
    maxCandidates: 10,
    scannedPages: 3,
    eligiblePages: 3,
    totalCandidates: 1,
    returnedCandidates: 1,
    truncated: false,
    truncatedCount: 0,
    candidates: [candidate],
    ...overrides,
  }
}

function renderSection(
  props: Partial<React.ComponentProps<typeof SynthesisSection>> = {},
): { container: HTMLDivElement; root: Root } {
  const container = document.createElement("div")
  document.body.appendChild(container)
  const root = createRoot(container)

  act(() => {
    root.render(<SynthesisSection {...props} />)
  })

  return { container, root }
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

async function click(element: Element): Promise<void> {
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }))
    await Promise.resolve()
    await Promise.resolve()
  })
}

async function change(element: Element, value: string): Promise<void> {
  await act(async () => {
    Object.defineProperty(element, "value", { value, configurable: true })
    element.dispatchEvent(new Event("change", { bubbles: true }))
    await Promise.resolve()
    await Promise.resolve()
  })
}

function unmount(root: Root): void {
  act(() => {
    root.unmount()
  })
}

describe("SynthesisSection", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    markSynthesisRebuiltMock.mockResolvedValue({ affectedPaths: [], completedGroups: 0, skippedGroups: 0 })
    synthesisMocks.discoverSynthesisCandidates.mockResolvedValue(report())
    synthesisMocks.runWikiSynthesis.mockResolvedValue({
      ok: true,
      topic: "ai + systems",
      tags: ["ai", "systems"],
      clusterSize: 3,
      synthesisPath: "wiki/synthesis/ai-systems-synthesis.md",
      externalSources: 0,
    })
    useWikiStore.setState({
      llmConfig: {
        provider: "openai",
        apiKey: "",
        model: "gpt-test",
        ollamaUrl: "http://localhost:11434",
        customEndpoint: "",
        maxContextSize: 204800,
        reasoning: { mode: "auto" },
      },
      searchApiConfig: {
        provider: "none",
        apiKey: "",
        deepResearchSource: "web",
      },
    })
  })

  it("defaults to single dimension", async () => {
    const { container, root } = renderSection({ project })
    await flush()

    expect(container.querySelector<HTMLSelectElement>("[data-testid='synthesis-dimension']")?.value).toBe("1")

    unmount(root)
  })

  it("disables preview when no project is open", async () => {
    const { container, root } = renderSection()
    await flush()

    expect(container.textContent).toContain("Open a project first")
    expect(container.querySelector<HTMLButtonElement>("[data-testid='synthesis-preview']")?.disabled).toBe(true)

    unmount(root)
  })

  it("previews rows without generating", async () => {
    const { container, root } = renderSection({ project })
    await flush()

    const preview = container.querySelector<HTMLButtonElement>("[data-testid='synthesis-preview']")
    if (!preview) throw new Error("preview button not found")
    await click(preview)
    await flush()

    expect(synthesisMocks.discoverSynthesisCandidates).toHaveBeenCalledWith("/project", {
      dimension: 1,
      minClusterSize: 3,
      maxCandidates: 10,
    })
    expect(synthesisMocks.runWikiSynthesis).not.toHaveBeenCalled()
    expect(container.querySelector("[data-testid='synthesis-candidate-topic-0']")?.textContent).toBe("ai + systems")

    unmount(root)
  })

  it("shows empty downgrade advice", async () => {
    synthesisMocks.discoverSynthesisCandidates.mockResolvedValue(report({
      dimension: 3,
      totalCandidates: 0,
      returnedCandidates: 0,
      candidates: [],
      suggestedDimension: 2,
      emptyReason: "no_cluster_meets_minimum",
    }))
    const { container, root } = renderSection({ project })
    await flush()

    const select = container.querySelector<HTMLSelectElement>("[data-testid='synthesis-dimension']")
    const preview = container.querySelector<HTMLButtonElement>("[data-testid='synthesis-preview']")
    if (!select || !preview) throw new Error("controls not found")
    await change(select, "3")
    await click(preview)
    await flush()

    expect(synthesisMocks.discoverSynthesisCandidates).toHaveBeenCalledWith("/project", {
      dimension: 3,
      minClusterSize: 3,
      maxCandidates: 10,
    })
    expect(container.querySelector("[data-testid='synthesis-empty']")?.textContent).toContain("Try Dual")

    unmount(root)
  })

  it("generates only after a candidate click", async () => {
    const { container, root } = renderSection({ project })
    await flush()

    const preview = container.querySelector<HTMLButtonElement>("[data-testid='synthesis-preview']")
    if (!preview) throw new Error("preview button not found")
    await click(preview)
    await flush()
    expect(synthesisMocks.runWikiSynthesis).not.toHaveBeenCalled()

    const generate = container.querySelector<HTMLButtonElement>("[data-testid='synthesis-generate-0']")
    if (!generate) throw new Error("generate button not found")
    await click(generate)
    await flush()

    expect(synthesisMocks.runWikiSynthesis).toHaveBeenCalledWith(
      "/project",
      expect.objectContaining({ model: "gpt-test" }),
      expect.objectContaining({ provider: "none" }),
      {
        dimension: 1,
        targetTags: ["ai", "systems"],
        minClusterSize: 3,
        maxCandidates: 10,
      },
    )
    expect(container.querySelector("[data-testid='synthesis-generate-result']")?.textContent).toContain("wiki/synthesis/ai-systems-synthesis.md")
    // SPEC-6 PR3+4 decision 4 wiring: a successful regenerate closes the
    // pending "synthesis" marker loop for the exact candidate just used.
    expect(markSynthesisRebuiltMock).toHaveBeenCalledWith(candidate)

    unmount(root)
  })

  it("does not call markSynthesisRebuilt when the synthesis result reports failure", async () => {
    synthesisMocks.runWikiSynthesis.mockResolvedValueOnce({
      ok: false,
      error: "Selected synthesis candidate not found with ≥3 pages",
    })
    const { container, root } = renderSection({ project })
    await flush()

    const preview = container.querySelector<HTMLButtonElement>("[data-testid='synthesis-preview']")
    if (!preview) throw new Error("preview button not found")
    await click(preview)
    await flush()

    const generate = container.querySelector<HTMLButtonElement>("[data-testid='synthesis-generate-0']")
    if (!generate) throw new Error("generate button not found")
    await click(generate)
    await flush()

    expect(markSynthesisRebuiltMock).not.toHaveBeenCalled()

    unmount(root)
  })

  it("a markSynthesisRebuilt failure is swallowed (logged) and does not turn a successful generate into a UI failure", async () => {
    markSynthesisRebuiltMock.mockRejectedValueOnce(new Error("boom"))
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
    const { container, root } = renderSection({ project })
    await flush()

    const preview = container.querySelector<HTMLButtonElement>("[data-testid='synthesis-preview']")
    if (!preview) throw new Error("preview button not found")
    await click(preview)
    await flush()

    const generate = container.querySelector<HTMLButtonElement>("[data-testid='synthesis-generate-0']")
    if (!generate) throw new Error("generate button not found")
    await click(generate)
    await flush()

    expect(container.querySelector("[data-testid='synthesis-generate-result']")?.textContent).toContain("wiki/synthesis/ai-systems-synthesis.md")
    expect(container.textContent).not.toContain("Generate failed")
    expect(warnSpy).toHaveBeenCalled()
    warnSpy.mockRestore()

    unmount(root)
  })

  it("shows generate failure from the synthesis result", async () => {
    synthesisMocks.runWikiSynthesis.mockResolvedValueOnce({
      ok: false,
      error: "Selected synthesis candidate not found with ≥3 pages",
    })
    const { container, root } = renderSection({ project })
    await flush()

    const preview = container.querySelector<HTMLButtonElement>("[data-testid='synthesis-preview']")
    if (!preview) throw new Error("preview button not found")
    await click(preview)
    await flush()

    const generate = container.querySelector<HTMLButtonElement>("[data-testid='synthesis-generate-0']")
    if (!generate) throw new Error("generate button not found")
    await click(generate)
    await flush()

    expect(container.textContent).toContain("Selected synthesis candidate not found")
    expect(container.querySelector("[data-testid='synthesis-generate-result']")).toBeNull()

    unmount(root)
  })

  it("shows a generic generate failure when runWikiSynthesis rejects", async () => {
    synthesisMocks.runWikiSynthesis.mockRejectedValueOnce(new Error("transport failed"))
    const { container, root } = renderSection({ project })
    await flush()

    const preview = container.querySelector<HTMLButtonElement>("[data-testid='synthesis-preview']")
    if (!preview) throw new Error("preview button not found")
    await click(preview)
    await flush()

    const generate = container.querySelector<HTMLButtonElement>("[data-testid='synthesis-generate-0']")
    if (!generate) throw new Error("generate button not found")
    await click(generate)
    await flush()

    expect(container.textContent).toContain("Generate failed")
    expect(container.textContent).not.toContain("transport failed")

    unmount(root)
  })

  it("clears stale preview rows while a new preview is loading", async () => {
    const { container, root } = renderSection({ project })
    await flush()

    const preview = container.querySelector<HTMLButtonElement>("[data-testid='synthesis-preview']")
    if (!preview) throw new Error("preview button not found")
    await click(preview)
    await flush()
    expect(container.querySelector("[data-testid='synthesis-candidates']")).not.toBeNull()

    synthesisMocks.discoverSynthesisCandidates.mockImplementationOnce(() => new Promise(() => undefined))
    await click(preview)
    await flush()

    expect(container.querySelector("[data-testid='synthesis-candidates']")).toBeNull()

    unmount(root)
  })
})
