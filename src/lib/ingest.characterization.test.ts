/**
 * SPEC-11 PR4 — characterization tests for the ingest write pipeline.
 *
 * Gate PR: zero production changes. These tests pin down CURRENT
 * behavior (including known bugs) for `autoIngestImpl` (via the
 * exported `autoIngest`), the internal `writeFileBlocks` (driven
 * indirectly through `autoIngest`'s generation stage — it isn't
 * exported), and the exported `executeIngestWrites` (chat-mode write
 * path), so future refactors (SPEC-11 D5/D6, SPEC-5-FIX PR5) have a
 * safety net and an explicit list of "this used to work exactly like
 * THIS, on purpose or not."
 *
 * Mock surface: `@/commands/fs` (real fs via a temp dir), `./llm-client`
 * (branch-routed on system-prompt prefix), `@/lib/embedding` (stub).
 * Everything else — page-merge, ingest-write, wiki-schema, sources-merge,
 * ingest-cache — runs for real.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import fs from "node:fs/promises"
import path from "node:path"
import crypto from "node:crypto"
import {
  createTempProject,
  realFs,
  writeFileRaw,
  readFileRaw,
  fileExists,
} from "@/test-helpers/fs-temp"

vi.mock("@/commands/fs", () => ({
  ...realFs,
  // Only the MinerU cache-hit sub-branch (A1b) needs this; every other
  // test keeps `mineruConfig.enabled: false` so this is never exercised
  // there. Implemented for real (md5 of actual bytes) so it composes
  // correctly with `saveIngestCache`'s own sha256-of-string hashing.
  getFileMd5: async (p: string) => {
    const buf = await fs.readFile(p)
    return crypto.createHash("md5").update(buf).digest("hex")
  },
}))

type MergeMode = "success" | "no-frontmatter" | "shrink" | "error"

let analysisResponse = "## Analysis\nBasic analysis for characterization tests.\n"
let generationResponse = ""
let chatGenerationResponse = ""
let reviewResponse = ""
let mergeMode: MergeMode = "success"

vi.mock("./llm-client", () => ({
  streamChat: vi.fn(async (_cfg, messages, cb) => {
    const systemPrompt = String(messages?.[0]?.content ?? "")

    if (systemPrompt.startsWith("You are merging two versions")) {
      if (mergeMode === "error") {
        cb.onError(new Error("simulated merge failure"))
        return
      }
      if (mergeMode === "no-frontmatter") {
        cb.onToken(
          "Just prose with no frontmatter at all, describing the merged concept in a few words.",
        )
        cb.onDone()
        return
      }
      if (mergeMode === "shrink") {
        cb.onToken("---\ntype: concept\ntitle: shrink\ncreated: 2020-01-01\n---\n\nToo short.")
        cb.onDone()
        return
      }
      // success: valid frontmatter + long body. LOCKED_FIELDS (type/
      // title/created) are deliberately WRONG here so tests can prove
      // page-merge.ts forces them back to the existing values.
      cb.onToken(
        pageContent(
          ["type: wrong-type-from-llm", "title: LLM Overwritten Title", "created: 2099-12-31"],
          [
            "# Merged Result",
            "",
            "This is the LLM-produced merged body combining both the existing and incoming contributions into one coherent narrative. ".repeat(
              6,
            ),
          ],
        ),
      )
      cb.onDone()
      return
    }

    if (systemPrompt.startsWith("You are a wiki generation assistant")) {
      // executeIngestWrites' generation stage.
      cb.onToken(chatGenerationResponse)
      cb.onDone()
      return
    }

    if (systemPrompt.startsWith("You are a wiki maintainer")) {
      // autoIngestImpl Step 2 (writeFileBlocks driver).
      cb.onToken(generationResponse)
      cb.onDone()
      return
    }

    if (systemPrompt.startsWith("You are identifying high-value follow-up research items")) {
      cb.onToken(reviewResponse)
      cb.onDone()
      return
    }

    if (systemPrompt.startsWith("You are an expert research analyst")) {
      cb.onToken(analysisResponse)
      cb.onDone()
      return
    }

    // Fallback (e.g. long-source chunk analysis — unused here).
    cb.onToken("")
    cb.onDone()
  }),
}))

vi.mock("@/lib/embedding", () => ({
  embedPage: vi.fn(async () => ({ indexed: 0, failed: 0 })),
  removePageEmbedding: vi.fn(async () => {}),
}))

// SPEC-6 PR2: ingest records an "embedding" derived-stale marker instead of
// embedding inline WHEN the work-runtime feature flag is on — consumed
// later by embedding-consumer.ts. Default-mocked to "recorded" (flag on);
// individual tests override to "runtime-disabled" to exercise the P0
// regression-lock fallback (flag off, the actual default — see
// legacyInlineEmbedPage in ingest.ts). Stub only `recordEmbeddingStaleMarker`
// — every other ingest-write.ts export (buildPageMerger,
// injectImagesIntoSourceSummary, tryReadFile, reembedSourceSummary) keeps
// running for real, unchanged from before this mock existed.
vi.mock("./ingest-write", async () => {
  const actual = await vi.importActual<typeof import("./ingest-write")>("./ingest-write")
  return { ...actual, recordEmbeddingStaleMarker: vi.fn(async () => "recorded" as const) }
})

import { autoIngest, executeIngestWrites } from "./ingest"
import { streamChat } from "./llm-client"
import { embedPage } from "@/lib/embedding"
import { recordEmbeddingStaleMarker } from "./ingest-write"
import { wikiPathToVectorPageId } from "./wiki-page-identity"
import { saveIngestCache } from "@/lib/ingest-cache"
import { sourceSummarySlugFromIdentity } from "@/lib/source-identity"
import { useWikiStore } from "@/stores/wiki-store"
import { useActivityStore } from "@/stores/activity-store"
import { useReviewStore } from "@/stores/review-store"
import { useChatStore } from "@/stores/chat-store"

const mockStreamChat = vi.mocked(streamChat)
const mockEmbedPage = vi.mocked(embedPage)
const mockRecordEmbeddingStaleMarker = vi.mocked(recordEmbeddingStaleMarker)

const SUBSTANTIVE_SOURCE =
  "This is a detailed source document with enough substantive prose to avoid the low-quality-source guard. It discusses several important ideas across multiple sentences so the pipeline treats it as real content worth ingesting."
const SUBSTANTIVE_SOURCE_2 =
  "This is a second, differently-worded substantive source document that also carries enough real prose content to avoid being flagged as a low-quality placeholder or table-of-contents page."

function pageContent(frontmatterLines: string[], bodyLines: string[]): string {
  return ["---", ...frontmatterLines, "---", "", ...bodyLines].join("\n")
}

function fileBlock(filePath: string, frontmatterLines: string[], bodyLines: string[]): string {
  return `---FILE: ${filePath}---\n${pageContent(frontmatterLines, bodyLines)}\n---END FILE---`
}

function rawFileBlock(filePath: string, bodyLines: string[]): string {
  return [`---FILE: ${filePath}---`, ...bodyLines, "---END FILE---"].join("\n")
}

function sourceSummaryBlock(
  sourceId: string,
  bodyText = "Summary body describing the source in adequate detail.",
): string {
  return fileBlock(
    "wiki/sources/placeholder.md",
    ["type: \"source\"", `title: "Source: ${sourceId}"`, `sources: ["${sourceId}"]`, "tags: []", "related: []"],
    [`# Source: ${sourceId}`, "", bodyText],
  )
}

interface Tmp {
  path: string
  cleanup: () => Promise<void>
}

async function seedProject(label: string): Promise<Tmp> {
  const tmp = await createTempProject(label)
  await writeFileRaw(`${tmp.path}/purpose.md`, "# Purpose\n\nTest wiki purpose.\n")
  await writeFileRaw(`${tmp.path}/schema.md`, "")
  await writeFileRaw(`${tmp.path}/wiki/index.md`, "# Index\n")
  await writeFileRaw(`${tmp.path}/wiki/overview.md`, "# Overview\n")

  useWikiStore.setState({
    project: { name: "t", path: tmp.path, createdAt: 0, purposeText: "", fileTree: [] } as never,
    outputLanguage: "auto",
    mineruConfig: {
      enabled: false,
      token: "",
      modelVersion: "vlm",
      apiBaseUrl: "",
      pollIntervalMs: 3000,
      pollTimeoutMs: 300000,
    },
    multimodalConfig: {
      enabled: false,
      useMainLlm: true,
      provider: "custom",
      apiKey: "",
      model: "",
      ollamaUrl: "http://localhost:11434",
      customEndpoint: "",
      azureApiVersion: "2024-10-21",
      apiMode: "chat_completions",
      concurrency: 4,
    },
    embeddingConfig: { enabled: false, endpoint: "", apiKey: "", model: "" },
  })
  useWikiStore.getState().setLlmConfig({
    provider: "openai",
    apiKey: "test-key",
    model: "gpt-4",
    ollamaUrl: "",
    customEndpoint: "",
    maxContextSize: 128000,
  })
  useReviewStore.setState({ items: [] })
  useActivityStore.setState({ items: [] })
  useChatStore.setState({
    conversations: [],
    messages: [],
    activeConversationId: null,
    mode: "chat",
    ingestSource: null,
    isStreaming: false,
    streamingContent: "",
  })

  return tmp
}

async function setupChatIngest(tmp: Tmp, sourceRelPath = "raw/sources/doc.md"): Promise<void> {
  useChatStore.setState({
    conversations: [{ id: "c1", title: "t", createdAt: 0, updatedAt: 0 }],
    activeConversationId: "c1",
    messages: [
      { id: "u1", role: "user", content: "Please save the wiki files.", timestamp: Date.now(), conversationId: "c1" },
    ],
    ingestSource: `${tmp.path}/${sourceRelPath}`,
    mode: "ingest",
    isStreaming: false,
    streamingContent: "",
  })
}

function mergeCallCount(): number {
  return mockStreamChat.mock.calls.filter(([, messages]) =>
    String((messages as { content?: unknown }[] | undefined)?.[0]?.content ?? "").startsWith(
      "You are merging two versions",
    ),
  ).length
}

beforeEach(() => {
  analysisResponse = "## Analysis\nBasic analysis for characterization tests.\n"
  generationResponse = ""
  chatGenerationResponse = ""
  reviewResponse = ""
  mergeMode = "success"
  mockStreamChat.mockClear()
  mockEmbedPage.mockClear()
  // mockReset (not mockClear): A2c overrides this to "runtime-disabled" via
  // mockResolvedValue (a persistent override, unlike mockResolvedValueOnce)
  // to simulate the flag being off for every written page in that test —
  // reset the implementation back to the "flag on" default here so that
  // doesn't leak into later tests.
  mockRecordEmbeddingStaleMarker.mockReset()
  mockRecordEmbeddingStaleMarker.mockResolvedValue("recorded")
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

// ── A. autoIngestImpl ────────────────────────────────────────────────────

describe("A. autoIngestImpl", () => {
  it("A1: cache-hit short-circuits the pipeline (0 streamChat calls, returns cached filesWritten, 'Skipped (unchanged)' detail)", async () => {
    const tmp = track(await seedProject("a1"))
    await writeFileRaw(`${tmp.path}/raw/sources/doc.md`, SUBSTANTIVE_SOURCE)
    generationResponse = sourceSummaryBlock("doc.md")

    const first = await autoIngest(tmp.path, `${tmp.path}/raw/sources/doc.md`, useWikiStore.getState().llmConfig)
    expect(first.length).toBeGreaterThan(0)
    expect(mockStreamChat.mock.calls.length).toBeGreaterThan(0)

    mockStreamChat.mockClear()
    useActivityStore.setState({ items: [] })

    const second = await autoIngest(tmp.path, `${tmp.path}/raw/sources/doc.md`, useWikiStore.getState().llmConfig)
    // Image cascade still runs on cache-hit (per Step-caching comment in
    // ingest.ts) — for a plain .md source it finds zero images and is a
    // no-op, so its execution isn't independently observable here beyond
    // "the call still completes successfully and streamChat stays silent."
    expect(mockStreamChat).not.toHaveBeenCalled()
    expect(second).toEqual(first)
    const details = useActivityStore.getState().items.map((i) => i.detail)
    expect(details.some((d) => /^Skipped \(unchanged\)/.test(d))).toBe(true)
  })

  it("A1b: MinerU cache-hit with a missing parsed-Markdown side cache surfaces the 'skipped media repair' anchor text and never calls streamChat", async () => {
    const tmp = track(await seedProject("a1b"))
    const pdfSourcePath = `${tmp.path}/raw/sources/paper.pdf`
    await writeFileRaw(pdfSourcePath, "%PDF-1.4 fake pdf bytes for hashing purposes only\n")

    useWikiStore.setState({
      mineruConfig: {
        enabled: true,
        token: "t",
        modelVersion: "vlm",
        apiBaseUrl: "",
        pollIntervalMs: 3000,
        pollTimeoutMs: 300000,
      },
    })

    const sourceIdentity = "paper.pdf"
    const sourceSummarySlug = sourceSummarySlugFromIdentity(sourceIdentity)
    expect(sourceSummarySlug).toBe("paper")
    const cachedFileRel = `wiki/sources/${sourceSummarySlug}.md`
    await writeFileRaw(
      `${tmp.path}/${cachedFileRel}`,
      '---\ntype: source\ntitle: "Source: paper.pdf"\n---\n\n# cached\n',
    )

    const fileMd5 = crypto.createHash("md5").update(await fs.readFile(pdfSourcePath)).digest("hex")
    const cacheContent = `mineru-source-md5:${fileMd5}`
    await saveIngestCache(tmp.path, sourceIdentity, cacheContent, [cachedFileRel], "mineru:vlm")

    const result = await autoIngest(tmp.path, pdfSourcePath, useWikiStore.getState().llmConfig)
    expect(result).toEqual([cachedFileRel])
    expect(mockStreamChat).not.toHaveBeenCalled()
    const details = useActivityStore.getState().items.map((i) => i.detail)
    expect(details.some((d) => d.includes("MinerU parsed cache missing, skipped media repair"))).toBe(true)
  })

  it("A2: cache-miss runs the full pipeline (streamChat is called, every written path exists on disk)", async () => {
    const tmp = track(await seedProject("a2"))
    await writeFileRaw(`${tmp.path}/raw/sources/doc.md`, SUBSTANTIVE_SOURCE)
    generationResponse = [
      sourceSummaryBlock("doc.md"),
      fileBlock(
        "wiki/concepts/topic-a2.md",
        ["type: concept", 'title: "Topic A2"', "created: 2026-05-01", "updated: 2026-05-01", 'sources: ["doc.md"]', "tags: []", "related: []"],
        ["# Topic A2", "", "Body content generated for the cache-miss scenario."],
      ),
    ].join("\n\n")

    const written = await autoIngest(tmp.path, `${tmp.path}/raw/sources/doc.md`, useWikiStore.getState().llmConfig)
    expect(mockStreamChat.mock.calls.length).toBeGreaterThan(0)
    expect(written.length).toBeGreaterThan(0)
    for (const p of written) {
      expect(await fileExists(`${tmp.path}/${p}`)).toBe(true)
    }
  })

  it("A2b (SPEC-6 PR2): with embedding enabled, ingest marks each written page's embedding stale instead of embedding inline, and skips structural pages", async () => {
    const tmp = track(await seedProject("a2b"))
    useWikiStore.setState({
      embeddingConfig: { enabled: true, endpoint: "http://x", apiKey: "", model: "test-embed" },
    })
    await writeFileRaw(`${tmp.path}/raw/sources/doc.md`, SUBSTANTIVE_SOURCE)
    generationResponse = [
      sourceSummaryBlock("doc.md"),
      fileBlock(
        "wiki/concepts/topic-a2b.md",
        ["type: concept", 'title: "Topic A2b"', "created: 2026-05-01", "updated: 2026-05-01", 'sources: ["doc.md"]', "tags: []", "related: []"],
        ["# Topic A2b", "", "Body content generated for the embedding-marker scenario."],
      ),
    ].join("\n\n")

    const written = await autoIngest(tmp.path, `${tmp.path}/raw/sources/doc.md`, useWikiStore.getState().llmConfig)
    expect(written.length).toBeGreaterThan(0)

    // Ingest completion no longer waits on / calls embedding directly —
    // that's now the embedding-consumer job's job.
    expect(mockEmbedPage).not.toHaveBeenCalled()

    // Every non-structural written page got its embedding marked stale.
    expect(mockRecordEmbeddingStaleMarker).toHaveBeenCalledTimes(written.length)
    const markedPaths = mockRecordEmbeddingStaleMarker.mock.calls.map(([affectedPath]) => affectedPath)
    for (const p of written) {
      expect(markedPaths).toContain(p)
    }
    // Root structural pages are never marked even if somehow written.
    expect(markedPaths).not.toContain("wiki/index.md")
    expect(markedPaths).not.toContain("wiki/overview.md")
  })

  it("A2c (P0 regression lock): with the work-runtime flag off (the actual default), ingest still embeds every written page inline", async () => {
    const tmp = track(await seedProject("a2c"))
    useWikiStore.setState({
      embeddingConfig: { enabled: true, endpoint: "http://x", apiKey: "", model: "test-embed" },
    })
    // recordEmbeddingStaleMarker signals "runtime-disabled" exactly like it
    // does for real when LLM_WIKI_CORE_WORK_RUNTIME_ENABLED isn't set — the
    // actual out-of-the-box state for every user. Before this regression
    // lock, that silently meant zero embeddings ever happened.
    mockRecordEmbeddingStaleMarker.mockResolvedValue("runtime-disabled")
    await writeFileRaw(`${tmp.path}/raw/sources/doc.md`, SUBSTANTIVE_SOURCE)
    generationResponse = [
      sourceSummaryBlock("doc.md"),
      fileBlock(
        "wiki/concepts/topic-a2c.md",
        ["type: concept", 'title: "Topic A2c"', "created: 2026-05-01", "updated: 2026-05-01", 'sources: ["doc.md"]', "tags: []", "related: []"],
        ["# Topic A2c", "", "Body content generated for the runtime-disabled fallback scenario."],
      ),
    ].join("\n\n")

    const written = await autoIngest(tmp.path, `${tmp.path}/raw/sources/doc.md`, useWikiStore.getState().llmConfig)
    expect(written.length).toBeGreaterThan(0)

    // The marker attempt still happens (and still reports disabled)...
    expect(mockRecordEmbeddingStaleMarker).toHaveBeenCalledTimes(written.length)
    // ...but every one of those pages falls back to the legacy inline
    // embedPage call so the default-configuration user still gets
    // embeddings, exactly as before SPEC-6 PR2.
    expect(mockEmbedPage).toHaveBeenCalledTimes(written.length)
    const embeddedPaths = mockEmbedPage.mock.calls.map(([, pageId]) => pageId)
    for (const p of written) {
      expect(embeddedPaths).toContain(wikiPathToVectorPageId(tmp.path, p))
    }
  })

  it("A3: a low-quality source short-circuits before any LLM call", async () => {
    const tmp = track(await seedProject("a3"))
    // "readme" is on the placeholder-name list in isLowQualitySource.
    await writeFileRaw(`${tmp.path}/raw/sources/readme.md`, "Just a readme placeholder with some text.")

    const written = await autoIngest(tmp.path, `${tmp.path}/raw/sources/readme.md`, useWikiStore.getState().llmConfig)
    expect(written).toEqual([])
    expect(mockStreamChat).not.toHaveBeenCalled()
    const details = useActivityStore.getState().items.map((i) => i.detail)
    expect(details.some((d) => d.startsWith("Skipped: "))).toBe(true)
  })
})

// ── B. writeFileBlocks (driven indirectly via autoIngest) ───────────────

describe("B. writeFileBlocks", () => {
  it("4: root wiki/index.md and wiki/overview.md FILE blocks are always dropped, bytes on disk unchanged", async () => {
    const tmp = track(await seedProject("b4"))
    const originalIndex = "# Index\n"
    const originalOverview = "# Overview\n"
    await writeFileRaw(`${tmp.path}/wiki/index.md`, originalIndex)
    await writeFileRaw(`${tmp.path}/wiki/overview.md`, originalOverview)
    await writeFileRaw(`${tmp.path}/raw/sources/doc.md`, SUBSTANTIVE_SOURCE)
    generationResponse = [
      sourceSummaryBlock("doc.md"),
      rawFileBlock("wiki/index.md", ["# LLM Attempted Index Rewrite"]),
      rawFileBlock("wiki/overview.md", ["# LLM Attempted Overview Rewrite"]),
    ].join("\n\n")

    await autoIngest(tmp.path, `${tmp.path}/raw/sources/doc.md`, useWikiStore.getState().llmConfig)

    expect(await readFileRaw(`${tmp.path}/wiki/index.md`)).toBe(originalIndex)
    expect(await readFileRaw(`${tmp.path}/wiki/overview.md`)).toBe(originalOverview)
    const details = useActivityStore.getState().items.map((i) => i.detail).join("\n")
    expect(details).toContain("root index/overview are optional derived artifacts")
  })

  it("5: a schema-routing violation drops the page (warnings contain 'Dropped', nothing written to disk)", async () => {
    const tmp = track(await seedProject("b5"))
    await writeFileRaw(
      `${tmp.path}/schema.md`,
      [
        "# Schema",
        "",
        "## Page Types",
        "",
        "| Type | Directory | Purpose |",
        "| ---- | --------- | ------- |",
        "| source | wiki/sources/ | Source summaries |",
        "| concept | wiki/concepts/ | Concepts |",
      ].join("\n"),
    )
    await writeFileRaw(`${tmp.path}/raw/sources/doc.md`, SUBSTANTIVE_SOURCE)
    generationResponse = [
      sourceSummaryBlock("doc.md"),
      fileBlock(
        "wiki/concepts/bad-source.md",
        ["type: source", 'title: "Bad Source"', 'sources: ["doc.md"]'],
        ["# Bad Source", "", "Should not land under wiki/concepts/ per schema."],
      ),
    ].join("\n\n")

    await autoIngest(tmp.path, `${tmp.path}/raw/sources/doc.md`, useWikiStore.getState().llmConfig)

    expect(await fileExists(`${tmp.path}/wiki/concepts/bad-source.md`)).toBe(false)
    const details = useActivityStore.getState().items.map((i) => i.detail).join("\n")
    expect(details).toContain("Dropped")
  })

  it("6: the per-file language guard drops mismatched /concepts/ pages while exempting /sources/ and /entities/ pages", async () => {
    const tmp = track(await seedProject("b6"))
    useWikiStore.setState({ outputLanguage: "Chinese" })
    await writeFileRaw(`${tmp.path}/raw/sources/doc.md`, SUBSTANTIVE_SOURCE)

    const longEnglishSourceBody =
      "This source summary is intentionally written in English even though the wiki output language is configured as Chinese, to verify that sources pages are exempt from the per-file language guard applied to concepts pages."
    generationResponse = [
      sourceSummaryBlock("doc.md", longEnglishSourceBody),
      fileBlock(
        "wiki/entities/english-entity.md",
        ["type: entity", 'title: "English Entity"', 'sources: ["doc.md"]'],
        [
          "# English Entity",
          "",
          "This entity page is also written in English prose and should survive the language guard because entities are exempt.",
        ],
      ),
      fileBlock(
        "wiki/concepts/english-only.md",
        ["type: concept", 'title: "English Only Concept"', "created: 2026-01-01", "updated: 2026-01-01", 'sources: ["doc.md"]', "tags: []", "related: []"],
        [
          "# English Only Concept",
          "",
          "This concept page is written entirely in English prose, describing an important idea in significant detail so the language detector has enough signal to confidently classify it as English rather than Chinese.",
        ],
      ),
    ].join("\n\n")

    await autoIngest(tmp.path, `${tmp.path}/raw/sources/doc.md`, useWikiStore.getState().llmConfig)

    const sourceSummary = await readFileRaw(`${tmp.path}/wiki/sources/doc.md`)
    expect(sourceSummary).toContain(longEnglishSourceBody)
    expect(await fileExists(`${tmp.path}/wiki/entities/english-entity.md`)).toBe(true)
    expect(await fileExists(`${tmp.path}/wiki/concepts/english-only.md`)).toBe(false)
    const details = useActivityStore.getState().items.map((i) => i.detail).join("\n")
    expect(details).toContain('Dropped "wiki/concepts/english-only.md" — body language doesn\'t match target')
  })

  it("7: normalized-slug dedup redirects a variant path into the existing normalized page", async () => {
    const tmp = track(await seedProject("b7"))
    await writeFileRaw(`${tmp.path}/raw/sources/doc.md`, SUBSTANTIVE_SOURCE)
    const existingKvCache = pageContent(
      ["type: concept", 'title: "KV Cache"', "created: 2026-01-01", "updated: 2026-01-01", 'sources: ["old-source.md"]', "tags: []", "related: []"],
      ["# KV Cache", "", "Original description of the KV cache mechanism."],
    )
    await writeFileRaw(`${tmp.path}/wiki/concepts/kv-cache.md`, existingKvCache)

    mergeMode = "success"
    generationResponse = [
      sourceSummaryBlock("doc.md"),
      fileBlock(
        "wiki/concepts/KV_Cache.md",
        ["type: concept", 'title: "KV Cache"', "created: 2026-05-01", "updated: 2026-05-01", 'sources: ["doc.md"]', "tags: []", "related: []"],
        ["# KV Cache", "", "Additional detail about the KV cache contributed by the second source."],
      ),
    ].join("\n\n")

    const written = await autoIngest(tmp.path, `${tmp.path}/raw/sources/doc.md`, useWikiStore.getState().llmConfig)

    expect(await fileExists(`${tmp.path}/wiki/concepts/KV_Cache.md`)).toBe(false)
    expect(written).toContain("wiki/concepts/kv-cache.md")
    expect(written).not.toContain("wiki/concepts/KV_Cache.md")
    const details = useActivityStore.getState().items.map((i) => i.detail).join("\n")
    expect(details).toContain("Dedup")
  })

  describe("8. merge tiers", () => {
    it("8a: brand-new page takes the merge fast path — no LLM merge call", async () => {
      const tmp = track(await seedProject("b8a"))
      await writeFileRaw(`${tmp.path}/raw/sources/doc.md`, SUBSTANTIVE_SOURCE)
      generationResponse = [
        sourceSummaryBlock("doc.md"),
        fileBlock(
          "wiki/concepts/brand-new.md",
          ["type: concept", 'title: "Brand New"', "created: 2026-05-01", "updated: 2026-05-01", 'sources: ["doc.md"]', "tags: []", "related: []"],
          ["# Brand New", "", "A concept page with no prior on-disk version."],
        ),
      ].join("\n\n")

      await autoIngest(tmp.path, `${tmp.path}/raw/sources/doc.md`, useWikiStore.getState().llmConfig)

      expect(mergeCallCount()).toBe(0)
      expect(await fileExists(`${tmp.path}/wiki/concepts/brand-new.md`)).toBe(true)
    })

    it("8b: byte-identical re-ingest skips the merge LLM call entirely", async () => {
      const tmp = track(await seedProject("b8b"))
      await writeFileRaw(`${tmp.path}/raw/sources/doc.md`, SUBSTANTIVE_SOURCE)
      const fm = ["type: concept", 'title: "Same"', "created: 2026-01-01", "updated: 2026-01-01", 'sources: ["doc.md"]', "tags: []", "related: []"]
      const body = ["# Same", "", "Identical content on both sides."]
      // The exact raw page body writeFileBlocks would produce is the same
      // frontmatter+body pair the FILE block wraps — build both from the
      // same source so "identical" is guaranteed rather than derived by
      // string surgery on the wrapped block.
      const existingPageContent = pageContent(fm, body)
      await writeFileRaw(`${tmp.path}/wiki/concepts/same.md`, existingPageContent)

      generationResponse = [sourceSummaryBlock("doc.md"), fileBlock("wiki/concepts/same.md", fm, body)].join("\n\n")

      await autoIngest(tmp.path, `${tmp.path}/raw/sources/doc.md`, useWikiStore.getState().llmConfig)

      expect(mergeCallCount()).toBe(0)
      expect(await readFileRaw(`${tmp.path}/wiki/concepts/same.md`)).toBe(existingPageContent)
    })

    it("8c: only frontmatter array fields differ — array-union fast path, no LLM merge call", async () => {
      const tmp = track(await seedProject("b8c"))
      await writeFileRaw(`${tmp.path}/raw/sources/doc.md`, SUBSTANTIVE_SOURCE)
      const existingContent = pageContent(
        ["type: concept", 'title: "Array Fields"', "created: 2026-01-01", "updated: 2026-01-01", 'sources: ["old-source.md"]', "tags: [\"legacy\"]", "related: []"],
        ["# Array Fields", "", "Shared body text that does not change between ingests."],
      )
      await writeFileRaw(`${tmp.path}/wiki/concepts/array-fields.md`, existingContent)

      // Tripwire: if the fast path regresses and the LLM merge branch is
      // actually invoked, it errors — mergeCallCount() below is the real
      // assertion either way.
      mergeMode = "error"
      generationResponse = [
        sourceSummaryBlock("doc.md"),
        fileBlock(
          "wiki/concepts/array-fields.md",
          ["type: concept", 'title: "Array Fields"', "created: 2026-01-01", "updated: 2026-01-01", 'sources: ["doc.md"]', "tags: [\"fresh\"]", "related: []"],
          ["# Array Fields", "", "Shared body text that does not change between ingests."],
        ),
      ].join("\n\n")

      await autoIngest(tmp.path, `${tmp.path}/raw/sources/doc.md`, useWikiStore.getState().llmConfig)

      expect(mergeCallCount()).toBe(0)
      const result = await readFileRaw(`${tmp.path}/wiki/concepts/array-fields.md`)
      expect(result).toContain('"old-source.md"')
      expect(result).toContain('"doc.md"')
      expect(result).toContain('"legacy"')
      expect(result).toContain('"fresh"')
    })

    it("8d: body differs → LLM merge succeeds, LOCKED_FIELDS roll back to existing values, updated=today, arrays unioned", async () => {
      const tmp = track(await seedProject("b8d"))
      await writeFileRaw(`${tmp.path}/raw/sources/doc.md`, SUBSTANTIVE_SOURCE)
      const existingContent = pageContent(
        ["type: concept", 'title: "Existing Title"', "created: 2020-01-01", "updated: 2020-01-01", 'sources: ["old-source.md"]', "tags: [\"legacy\"]", "related: [\"old-related\"]"],
        ["# Existing Title", "", "Original body before any merge happened."],
      )
      await writeFileRaw(`${tmp.path}/wiki/concepts/merge-target.md`, existingContent)

      mergeMode = "success"
      generationResponse = [
        sourceSummaryBlock("doc.md"),
        fileBlock(
          "wiki/concepts/merge-target.md",
          ["type: concept", 'title: "Existing Title"', "created: 2020-01-01", "updated: 2026-05-01", 'sources: ["doc.md"]', "tags: [\"fresh\"]", "related: [\"new-related\"]"],
          ["# Existing Title", "", "Newly generated body contributed by the second source, materially different from the original."],
        ),
      ].join("\n\n")

      await autoIngest(tmp.path, `${tmp.path}/raw/sources/doc.md`, useWikiStore.getState().llmConfig)

      const merged = await readFileRaw(`${tmp.path}/wiki/concepts/merge-target.md`)
      const today = new Date().toISOString().slice(0, 10)
      expect(merged).toContain("type: concept")
      expect(merged).not.toContain("wrong-type-from-llm")
      expect(merged).toContain("title: Existing Title")
      expect(merged).not.toContain("LLM Overwritten Title")
      expect(merged).toContain("created: 2020-01-01")
      expect(merged).toContain(`updated: ${today}`)
      expect(merged).toContain('"legacy"')
      expect(merged).toContain('"fresh"')
      expect(merged).toContain('"old-related"')
      expect(merged).toContain('"new-related"')
    })

    it("8e: merge LLM failure falls back to incoming+array-union and backs up the old page", async () => {
      const tmp = track(await seedProject("b8e"))
      await writeFileRaw(`${tmp.path}/raw/sources/doc.md`, SUBSTANTIVE_SOURCE)
      const existingContent = pageContent(
        ["type: concept", 'title: "Fallback Target"', "created: 2020-01-01", "updated: 2020-01-01", 'sources: ["old-source.md"]', "tags: []", "related: []"],
        ["# Fallback Target", "", "Original body that must survive only in the backup file."],
      )
      await writeFileRaw(`${tmp.path}/wiki/concepts/fallback-target.md`, existingContent)

      mergeMode = "error"
      generationResponse = [
        sourceSummaryBlock("doc.md"),
        fileBlock(
          "wiki/concepts/fallback-target.md",
          ["type: concept", 'title: "Fallback Target"', "created: 2020-01-01", "updated: 2026-05-01", 'sources: ["doc.md"]', "tags: []", "related: []"],
          ["# Fallback Target", "", "Newly generated body that wins the fallback because the LLM merge failed."],
        ),
      ].join("\n\n")

      await autoIngest(tmp.path, `${tmp.path}/raw/sources/doc.md`, useWikiStore.getState().llmConfig)

      const result = await readFileRaw(`${tmp.path}/wiki/concepts/fallback-target.md`)
      expect(result).toContain("Newly generated body that wins the fallback")
      expect(result).not.toContain("Original body that must survive only in the backup file")

      const historyDir = `${tmp.path}/.llm-wiki/page-history`
      const files = await fs.readdir(historyDir)
      expect(files.length).toBeGreaterThan(0)
      const backupName = files.find((f) => f.includes("fallback-target"))
      expect(backupName).toBeTruthy()
      const backupContent = await fs.readFile(path.join(historyDir, backupName!), "utf-8")
      expect(backupContent).toBe(existingContent)
    })

    it("8f-i: merge output with no frontmatter is rejected — same fallback as an LLM error", async () => {
      const tmp = track(await seedProject("b8f1"))
      await writeFileRaw(`${tmp.path}/raw/sources/doc.md`, SUBSTANTIVE_SOURCE)
      const existingContent = pageContent(
        ["type: concept", 'title: "No Frontmatter Target"', "created: 2020-01-01", "updated: 2020-01-01", 'sources: ["old-source.md"]', "tags: []", "related: []"],
        ["# No Frontmatter Target", "", "Original body — must survive only in the backup."],
      )
      await writeFileRaw(`${tmp.path}/wiki/concepts/no-fm-target.md`, existingContent)

      mergeMode = "no-frontmatter"
      generationResponse = [
        sourceSummaryBlock("doc.md"),
        fileBlock(
          "wiki/concepts/no-fm-target.md",
          ["type: concept", 'title: "No Frontmatter Target"', "created: 2020-01-01", "updated: 2026-05-01", 'sources: ["doc.md"]', "tags: []", "related: []"],
          ["# No Frontmatter Target", "", "Incoming body that wins the fallback."],
        ),
      ].join("\n\n")

      await autoIngest(tmp.path, `${tmp.path}/raw/sources/doc.md`, useWikiStore.getState().llmConfig)

      const result = await readFileRaw(`${tmp.path}/wiki/concepts/no-fm-target.md`)
      expect(result).toContain("Incoming body that wins the fallback")
      const historyDir = `${tmp.path}/.llm-wiki/page-history`
      const files = await fs.readdir(historyDir).catch(() => [] as string[])
      expect(files.some((f) => f.includes("no-fm-target"))).toBe(true)
    })

    it("8f-ii: merge output below the 70% body-shrink threshold is rejected — same fallback", async () => {
      const tmp = track(await seedProject("b8f2"))
      await writeFileRaw(`${tmp.path}/raw/sources/doc.md`, SUBSTANTIVE_SOURCE)
      const existingContent = pageContent(
        ["type: concept", 'title: "Shrink Target"', "created: 2020-01-01", "updated: 2020-01-01", 'sources: ["old-source.md"]', "tags: []", "related: []"],
        ["# Shrink Target", "", "Original body long enough that a drastically shorter LLM output should trip the shrink-rejection threshold in page-merge.ts."],
      )
      await writeFileRaw(`${tmp.path}/wiki/concepts/shrink-target.md`, existingContent)

      mergeMode = "shrink"
      generationResponse = [
        sourceSummaryBlock("doc.md"),
        fileBlock(
          "wiki/concepts/shrink-target.md",
          ["type: concept", 'title: "Shrink Target"', "created: 2020-01-01", "updated: 2026-05-01", 'sources: ["doc.md"]', "tags: []", "related: []"],
          ["# Shrink Target", "", "Incoming body that wins the fallback because the LLM's merge output was too short."],
        ),
      ].join("\n\n")

      await autoIngest(tmp.path, `${tmp.path}/raw/sources/doc.md`, useWikiStore.getState().llmConfig)

      const result = await readFileRaw(`${tmp.path}/wiki/concepts/shrink-target.md`)
      expect(result).toContain("Incoming body that wins the fallback")
      const historyDir = `${tmp.path}/.llm-wiki/page-history`
      const files = await fs.readdir(historyDir).catch(() => [] as string[])
      expect(files.some((f) => f.includes("shrink-target"))).toBe(true)
    })
  })

  it("9: backup is created only on merge fallback, never on a successful merge", async () => {
    const tmp = track(await seedProject("b9"))
    await writeFileRaw(`${tmp.path}/raw/sources/doc.md`, SUBSTANTIVE_SOURCE)
    await writeFileRaw(`${tmp.path}/raw/sources/doc2.md`, SUBSTANTIVE_SOURCE_2)
    const existingContent = pageContent(
      ["type: concept", 'title: "Backup Check"', "created: 2020-01-01", "updated: 2020-01-01", 'sources: ["old-source.md"]', "tags: []", "related: []"],
      ["# Backup Check", "", "Original body."],
    )
    await writeFileRaw(`${tmp.path}/wiki/concepts/backup-check.md`, existingContent)

    mergeMode = "success"
    generationResponse = [
      sourceSummaryBlock("doc.md"),
      fileBlock(
        "wiki/concepts/backup-check.md",
        ["type: concept", 'title: "Backup Check"', "created: 2020-01-01", "updated: 2026-05-01", 'sources: ["doc.md"]', "tags: []", "related: []"],
        ["# Backup Check", "", "First differing body from doc.md."],
      ),
    ].join("\n\n")
    await autoIngest(tmp.path, `${tmp.path}/raw/sources/doc.md`, useWikiStore.getState().llmConfig)

    const historyDir = `${tmp.path}/.llm-wiki/page-history`
    expect(await fs.readdir(historyDir).catch(() => [])).toHaveLength(0)

    mergeMode = "error"
    generationResponse = [
      sourceSummaryBlock("doc2.md"),
      fileBlock(
        "wiki/concepts/backup-check.md",
        ["type: concept", 'title: "Backup Check"', "created: 2020-01-01", "updated: 2026-05-02", 'sources: ["doc2.md"]', "tags: []", "related: []"],
        ["# Backup Check", "", "Second differing body from doc2.md."],
      ),
    ].join("\n\n")
    await autoIngest(tmp.path, `${tmp.path}/raw/sources/doc2.md`, useWikiStore.getState().llmConfig)

    expect(await fs.readdir(historyDir)).not.toHaveLength(0)
  })

  it("10: wiki/log.md entries are appended, never overwritten", async () => {
    const tmp = track(await seedProject("b10"))
    await writeFileRaw(`${tmp.path}/raw/sources/doc.md`, SUBSTANTIVE_SOURCE)
    await writeFileRaw(`${tmp.path}/wiki/log.md`, "# Wiki Log\n\n## [2026-01-01] ingest | Old Entry\n\nOld entry body.\n")
    generationResponse = [
      sourceSummaryBlock("doc.md"),
      rawFileBlock("wiki/log.md", ["## [2026-05-01] ingest | New Entry", "", "New entry body."]),
    ].join("\n\n")

    await autoIngest(tmp.path, `${tmp.path}/raw/sources/doc.md`, useWikiStore.getState().llmConfig)

    const logContent = await readFileRaw(`${tmp.path}/wiki/log.md`)
    expect(logContent).toContain("Old Entry")
    expect(logContent).toContain("New Entry")
  })

  it("11: nested index.md pages get a full wholesale overwrite (legacy listing behavior), not a merge", async () => {
    const tmp = track(await seedProject("b11"))
    await writeFileRaw(`${tmp.path}/raw/sources/doc.md`, SUBSTANTIVE_SOURCE)
    await writeFileRaw(`${tmp.path}/wiki/projects/index.md`, "# Old Nested Index\n\nOld listing content that should be fully replaced.\n")

    // Confirmed via wiki-schema.ts / ingest.ts: isListingPath() matches
    // any path ending in /index.md or /overview.md, not just the root
    // ones — so this nested page takes the wholesale-write branch.
    mergeMode = "error" // tripwire — a real merge call here would be a regression
    generationResponse = [
      sourceSummaryBlock("doc.md"),
      rawFileBlock("wiki/projects/index.md", ["# New Nested Index", "", "Brand new listing content replacing the old one."]),
    ].join("\n\n")

    await autoIngest(tmp.path, `${tmp.path}/raw/sources/doc.md`, useWikiStore.getState().llmConfig)

    const result = await readFileRaw(`${tmp.path}/wiki/projects/index.md`)
    expect(result).toBe("# New Nested Index\n\nBrand new listing content replacing the old one.")
    expect(result).not.toContain("Old Nested Index")
    expect(mergeCallCount()).toBe(0)
  })

  it("12: a real writeFile rejection registers as a hard failure (not a soft warning) and blocks the cache save", async () => {
    const tmp = track(await seedProject("b12"))
    await writeFileRaw(`${tmp.path}/raw/sources/doc.md`, SUBSTANTIVE_SOURCE)
    // Force a real fs failure: make "wiki/concepts" a FILE instead of a
    // directory, so mkdir(recursive) for anything under it throws ENOTDIR.
    await writeFileRaw(`${tmp.path}/wiki/concepts`, "not a directory")
    generationResponse = [
      sourceSummaryBlock("doc.md"),
      fileBlock(
        "wiki/concepts/blocked.md",
        ["type: concept", 'title: "Blocked"', "created: 2026-05-01", "updated: 2026-05-01", 'sources: ["doc.md"]', "tags: []", "related: []"],
        ["# Blocked", "", "This page can never be written because its parent path collides with a file."],
      ),
    ].join("\n\n")

    const written = await autoIngest(tmp.path, `${tmp.path}/raw/sources/doc.md`, useWikiStore.getState().llmConfig)

    expect(written).not.toContain("wiki/concepts/blocked.md")
    const details = useActivityStore.getState().items.map((i) => i.detail).join("\n")
    expect(details).toContain('Failed to write "wiki/concepts/blocked.md"')

    // Actual behavior check (confirmed empirically): a hard failure
    // unconditionally skips saveIngestCache for this source, so the
    // cache file is never created in the first place.
    const cacheRaw = await fs.readFile(`${tmp.path}/.llm-wiki/ingest-cache.json`, "utf-8").catch(() => null)
    expect(cacheRaw).toBeNull()
  })
})

// ── C. executeIngestWrites vs writeFileBlocks contrast ───────────────────
//
// executeIngestWrites (chat-mode "Save to Wiki") is the OLDER write path.
// D5/PR5 intends to delegate it to writeFileBlocks; until then it has NONE
// of writeFileBlocks' guards (root-skip, schema routing, language guard,
// dedup, merge+backup). These tests pin the CURRENT gap down explicitly.

describe("C. executeIngestWrites vs writeFileBlocks", () => {
  it("13: executeIngestWrites now delegates to writeFileBlocks — root wiki/index.md is skipped by both paths (PR5 fix)", async () => {
    const tmp = track(await seedProject("c13"))
    await writeFileRaw(`${tmp.path}/wiki/index.md`, "# Old Index\n\nOriginal root index content.\n")
    await setupChatIngest(tmp)
    chatGenerationResponse = rawFileBlock("wiki/index.md", ["# New Root Index", "", "Chat-mode generated root index."])

    await executeIngestWrites(tmp.path, useWikiStore.getState().llmConfig)
    expect(await readFileRaw(`${tmp.path}/wiki/index.md`)).toBe("# Old Index\n\nOriginal root index content.\n")

    // Symmetric: writeFileBlocks (via autoIngest) skips the same block.
    await writeFileRaw(`${tmp.path}/raw/sources/other.md`, SUBSTANTIVE_SOURCE)
    generationResponse = [sourceSummaryBlock("other.md"), rawFileBlock("wiki/index.md", ["# Attempted Overwrite"])].join(
      "\n\n",
    )
    await autoIngest(tmp.path, `${tmp.path}/raw/sources/other.md`, useWikiStore.getState().llmConfig)
    expect(await readFileRaw(`${tmp.path}/wiki/index.md`)).toBe("# Old Index\n\nOriginal root index content.\n")
  })

  it("14: executeIngestWrites now runs the schema-routing check via writeFileBlocks — a type-violating page is dropped (PR5 fix)", async () => {
    const tmp = track(await seedProject("c14"))
    // loadProjectWikiSchemaRouting reads schema.md from the project ROOT
    // (not wiki/schema.md) — seed it there so schemaRouting isn't null.
    await writeFileRaw(
      `${tmp.path}/schema.md`,
      [
        "# Schema",
        "",
        "## Page Types",
        "",
        "| Type | Directory | Purpose |",
        "| ---- | --------- | ------- |",
        "| source | wiki/sources/ | Source summaries |",
        "| concept | wiki/concepts/ | Concepts |",
      ].join("\n"),
    )
    await setupChatIngest(tmp)
    chatGenerationResponse = fileBlock(
      "wiki/concepts/bad-source.md",
      ["type: source", 'title: "Bad Source"'],
      ["# Bad Source", "", "Violates schema routing — now enforced by the delegated writeFileBlocks check."],
    )

    await executeIngestWrites(tmp.path, useWikiStore.getState().llmConfig)
    expect(await fileExists(`${tmp.path}/wiki/concepts/bad-source.md`)).toBe(false)
    const messages = useChatStore.getState().messages.map((m) => m.content).join("\n")
    expect(messages).toContain("Dropped")
  })

  it("15: executeIngestWrites now runs the per-file language guard via writeFileBlocks — a mismatched page is dropped (PR5 fix)", async () => {
    const tmp = track(await seedProject("c15"))
    useWikiStore.setState({ outputLanguage: "Chinese" })
    await setupChatIngest(tmp)
    chatGenerationResponse = fileBlock(
      "wiki/concepts/english-chat.md",
      ["type: concept", 'title: "English Chat Page"'],
      [
        "# English Chat Page",
        "",
        "This entire page is written in English prose even though the target output language is Chinese, and the delegated writeFileBlocks language guard now catches it.",
      ],
    )

    await executeIngestWrites(tmp.path, useWikiStore.getState().llmConfig)
    expect(await fileExists(`${tmp.path}/wiki/concepts/english-chat.md`)).toBe(false)
    const messages = useChatStore.getState().messages.map((m) => m.content).join("\n")
    expect(messages).toContain("Dropped")
  })

  it("16: executeIngestWrites now runs the delegated normalized-slug dedup — a variant path merges into the existing page instead of duplicating (PR5 fix)", async () => {
    const tmp = track(await seedProject("c16"))
    await writeFileRaw(
      `${tmp.path}/wiki/concepts/kv-cache.md`,
      pageContent(
        ["type: concept", 'title: "KV Cache"', "created: 2026-01-01", "updated: 2026-01-01", 'sources: ["old-source.md"]', "tags: []", "related: []"],
        ["# KV Cache", "", "Existing body."],
      ),
    )
    await setupChatIngest(tmp)
    chatGenerationResponse = fileBlock(
      "wiki/concepts/KV_Cache.md",
      ["type: concept", 'title: "KV Cache"', "created: 2026-05-01", "updated: 2026-05-01", 'sources: ["doc.md"]', "tags: []", "related: []"],
      ["# KV Cache", "", "Chat-mode contributed body."],
    )

    const writtenPaths = await executeIngestWrites(tmp.path, useWikiStore.getState().llmConfig)

    expect(await fileExists(`${tmp.path}/wiki/concepts/kv-cache.md`)).toBe(true)
    expect(await fileExists(`${tmp.path}/wiki/concepts/KV_Cache.md`)).toBe(false)
    expect(writtenPaths).toContain("wiki/concepts/kv-cache.md")
    const messages = useChatStore.getState().messages.map((m) => m.content).join("\n")
    expect(messages).toContain("Dedup")
  })

  it("17: executeIngestWrites now merges into an existing page via the delegated writeFileBlocks instead of overwriting it — LOCKED_FIELDS roll back, no backup on a successful merge (PR5 fix)", async () => {
    const tmp = track(await seedProject("c17"))
    const oldContent = pageContent(
      ["type: concept", 'title: "Existing"', "created: 2020-01-01", "updated: 2020-01-01", 'sources: ["old-source.md"]', "tags: []", "related: []"],
      ["# Existing", "", "Original body that used to be destroyed without a trace."],
    )
    await writeFileRaw(`${tmp.path}/wiki/concepts/existing.md`, oldContent)
    await setupChatIngest(tmp)
    chatGenerationResponse = fileBlock(
      "wiki/concepts/existing.md",
      ["type: concept", 'title: "Existing"', "created: 2026-05-01", "updated: 2026-05-01", 'sources: ["doc.md"]', "tags: []", "related: []"],
      ["# Existing", "", "Completely different body from the chat-mode write."],
    )

    await executeIngestWrites(tmp.path, useWikiStore.getState().llmConfig)

    // Confirm the merge LLM was actually invoked (not a silent
    // overwrite) before asserting on its (mocked, fixed) output —
    // see the shared "success" mergeMode response at the top of this
    // file, also used by test 8d.
    expect(mergeCallCount()).toBe(1)
    const result = await readFileRaw(`${tmp.path}/wiki/concepts/existing.md`)
    const today = new Date().toISOString().slice(0, 10)
    expect(result).toContain("type: concept")
    expect(result).not.toContain("wrong-type-from-llm")
    expect(result).toContain("title: Existing")
    expect(result).not.toContain("LLM Overwritten Title")
    expect(result).toContain("created: 2020-01-01")
    expect(result).toContain(`updated: ${today}`)
    expect(result).toContain('"old-source.md"')
    expect(result).toContain('"doc.md"')

    const historyDir = `${tmp.path}/.llm-wiki/page-history`
    expect(await fs.readdir(historyDir).catch(() => [])).toHaveLength(0)
  })

  it("18: both writeFileBlocks and executeIngestWrites now return project-relative paths (PR5 fix — delegation)", async () => {
    const tmp = track(await seedProject("c18"))
    await writeFileRaw(`${tmp.path}/raw/sources/doc.md`, SUBSTANTIVE_SOURCE)
    generationResponse = [
      sourceSummaryBlock("doc.md"),
      fileBlock(
        "wiki/concepts/shape-a.md",
        ["type: concept", 'title: "Shape A"', "created: 2026-05-01", "updated: 2026-05-01", 'sources: ["doc.md"]', "tags: []", "related: []"],
        ["# Shape A", "", "Written via writeFileBlocks."],
      ),
    ].join("\n\n")
    const autoWritten = await autoIngest(tmp.path, `${tmp.path}/raw/sources/doc.md`, useWikiStore.getState().llmConfig)
    expect(autoWritten.every((p) => !p.startsWith(tmp.path))).toBe(true)
    expect(autoWritten).toContain("wiki/concepts/shape-a.md")

    await setupChatIngest(tmp)
    chatGenerationResponse = fileBlock(
      "wiki/concepts/shape-b.md",
      ["type: concept", 'title: "Shape B"', "created: 2026-05-01", "updated: 2026-05-01", 'sources: ["doc.md"]', "tags: []", "related: []"],
      ["# Shape B", "", "Written via executeIngestWrites."],
    )
    const chatWritten = await executeIngestWrites(tmp.path, useWikiStore.getState().llmConfig)
    expect(chatWritten.every((p) => !p.startsWith(tmp.path))).toBe(true)
    expect(chatWritten).toContain("wiki/concepts/shape-b.md")
  })

  it("19: both writeFileBlocks and executeIngestWrites append to wiki/log.md rather than overwrite (shared invariant)", async () => {
    const tmp = track(await seedProject("c19"))
    await writeFileRaw(`${tmp.path}/wiki/log.md`, "# Wiki Log\n\n## [2026-01-01] ingest | Seed Entry\n")
    await writeFileRaw(`${tmp.path}/raw/sources/doc.md`, SUBSTANTIVE_SOURCE)
    generationResponse = [
      sourceSummaryBlock("doc.md"),
      rawFileBlock("wiki/log.md", ["## [2026-05-01] ingest | Auto Entry"]),
    ].join("\n\n")
    await autoIngest(tmp.path, `${tmp.path}/raw/sources/doc.md`, useWikiStore.getState().llmConfig)

    let logContent = await readFileRaw(`${tmp.path}/wiki/log.md`)
    expect(logContent).toContain("Seed Entry")
    expect(logContent).toContain("Auto Entry")

    await setupChatIngest(tmp)
    chatGenerationResponse = rawFileBlock("wiki/log.md", ["## [2026-05-02] ingest | Chat Entry"])
    await executeIngestWrites(tmp.path, useWikiStore.getState().llmConfig)

    logContent = await readFileRaw(`${tmp.path}/wiki/log.md`)
    expect(logContent).toContain("Seed Entry")
    expect(logContent).toContain("Auto Entry")
    expect(logContent).toContain("Chat Entry")
  })
})
