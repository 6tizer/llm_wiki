import { beforeEach, describe, expect, it, vi } from "vitest"
import type { EmbeddingConfig } from "@/stores/wiki-store"
import type { EntitySummary } from "./dedup"
import {
  DEDUP_PREFILTER_MAX_NEIGHBORS_PER_PAGE,
  DEDUP_PREFILTER_MIN_SUMMARIES,
  prefilterDedupCandidates,
} from "./dedup_embedding"
import { fetchEmbedding } from "./embedding"

vi.mock("./embedding", () => ({
  fetchEmbedding: vi.fn(),
}))

const fetchEmbeddingMock = vi.mocked(fetchEmbedding)

const cfg: EmbeddingConfig = {
  enabled: true,
  endpoint: "http://127.0.0.1:1234/v1/embeddings",
  apiKey: "",
  model: "embed",
}

function summary(index: number): EntitySummary {
  return {
    slug: `page-${index}`,
    path: `wiki/entities/page-${index}.md`,
    type: "entity",
    title: `Page ${index}`,
    tags: [],
    description: `Description ${index}`,
  }
}

describe("prefilterDedupCandidates", () => {
  beforeEach(() => {
    fetchEmbeddingMock.mockReset()
  })

  it("keeps a small wiki on the full-scan path", async () => {
    const summaries = Array.from({ length: DEDUP_PREFILTER_MIN_SUMMARIES - 1 }, (_, i) => summary(i))

    const out = await prefilterDedupCandidates(summaries, cfg)

    expect(out.summaries).toBe(summaries)
    expect(out.usedEmbedding).toBe(false)
    expect(out.fallbackReason).toBe("too-small")
    expect(fetchEmbeddingMock).not.toHaveBeenCalled()
  })

  it("returns similar large-wiki candidates", async () => {
    const summaries = Array.from({ length: 10 }, (_, i) => summary(i))
    fetchEmbeddingMock.mockImplementation(async (text) => {
      if (String(text).includes("page-0") || String(text).includes("page-1")) return [1, 0]
      return [0, 1]
    })

    const out = await prefilterDedupCandidates(summaries, cfg)

    expect(out.usedEmbedding).toBe(true)
    expect(out.summaries.map((s) => s.slug)).toEqual(expect.arrayContaining(["page-0", "page-1"]))
  })

  it("does not fall back to an expensive full scan for a large wiki with no candidates", async () => {
    const summaries = Array.from({ length: 41 }, (_, i) => summary(i))
    fetchEmbeddingMock.mockImplementation(async (text) => {
      const match = String(text).match(/page-(\d+)/)
      const index = Number(match?.[1] ?? 0)
      return Array.from({ length: 41 }, (_, i) => (i === index ? 1 : 0))
    })

    const out = await prefilterDedupCandidates(summaries, cfg)

    expect(out.usedEmbedding).toBe(true)
    expect(out.summaries).toEqual([])
  })

  it("does not fall back to a full scan for a large wiki when embeddings fail", async () => {
    const summaries = Array.from({ length: 41 }, (_, i) => summary(i))
    fetchEmbeddingMock.mockResolvedValue(null)

    const out = await prefilterDedupCandidates(summaries, cfg)

    expect(out.usedEmbedding).toBe(false)
    expect(out.fallbackReason).toBe("embedding-failed")
    expect(out.summaries).toEqual([])
  })

  it("keeps full-scan fallback for a small wiki when embeddings fail", async () => {
    const summaries = Array.from({ length: 10 }, (_, i) => summary(i))
    fetchEmbeddingMock.mockResolvedValue(null)

    const out = await prefilterDedupCandidates(summaries, cfg)

    expect(out.usedEmbedding).toBe(false)
    expect(out.fallbackReason).toBe("embedding-failed")
    expect(out.summaries).toBe(summaries)
  })

  it("enforces the per-page neighbor limit as a hard cap", async () => {
    const summaries = Array.from({ length: 12 }, (_, i) => summary(i))
    const leafComponent = Math.sqrt(1 - 0.9 * 0.9)
    fetchEmbeddingMock.mockImplementation(async (text) => {
      const slug = String(text).match(/slug=page-(\d+)/)?.[1]
      const index = Number(slug ?? 0)
      const vector = Array.from({ length: summaries.length + 1 }, () => 0)
      if (index === 0) {
        vector[0] = 1
      } else {
        vector[0] = 0.9
        vector[index] = leafComponent
      }
      return vector
    })

    const out = await prefilterDedupCandidates(summaries, cfg)

    expect(out.summaries.map((s) => s.slug)).toContain("page-0")
    expect(out.summaries).toHaveLength(DEDUP_PREFILTER_MAX_NEIGHBORS_PER_PAGE + 1)
  })

  it("aborts between embedding calls", async () => {
    const controller = new AbortController()
    const summaries = Array.from({ length: 10 }, (_, i) => summary(i))
    fetchEmbeddingMock.mockImplementation(async () => {
      controller.abort(new Error("stop"))
      return [1, 0]
    })

    await expect(prefilterDedupCandidates(summaries, cfg, controller.signal)).rejects.toThrow("stop")
  })
})
