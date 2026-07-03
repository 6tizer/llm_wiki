/**
 * SPEC-11 PR4 — characterization tests for the cancel-during-processing
 * cascade (D4): what actually happens on disk when a user cancels an
 * in-flight ingest task whose generation stage produced a MERGE into a
 * pre-existing page, versus one that only created brand-new pages.
 *
 * Unlike ingest.characterization.test.ts, this file drives the REAL
 * `ingest.ts`, `ingest-queue.ts`, and `wiki-page-delete.ts` end to end —
 * only `@/commands/fs` (real fs via temp dir), `./llm-client` (deferred-
 * controlled mock), `@/lib/embedding`, `@/lib/project-identity` (Tauri
 * plugin-store isn't available in tests), and `./sweep-reviews` are
 * mocked.
 *
 * Known bug pinned down here (D4): `cleanupWrittenFiles` — called from
 * ingest-queue's abort guard — deletes every path `autoIngest` reports as
 * "written", including a page that already existed and was only MERGED
 * into. Cancelling mid-write deletes that pre-existing page ENTIRELY,
 * not just the newly-merged contribution. PR5 is expected to distinguish
 * "newly created" from "merged" before this cleanup runs.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import fs from "node:fs/promises"
import path from "node:path"
import { createTempProject, realFs, writeFileRaw, readFileRaw, fileExists } from "@/test-helpers/fs-temp"
import { createDeferred, flushMicrotasks, waitFor, type Deferred } from "@/test-helpers/deferred"

vi.mock("@/commands/fs", () => realFs)

vi.mock("@/lib/embedding", () => ({
  embedPage: vi.fn(async () => {}),
  removePageEmbedding: vi.fn(async () => {}),
}))

const TEST_PROJECT_ID = "cancel-cascade-project"
let activeProjectPath = ""
vi.mock("@/lib/project-identity", () => ({
  ensureProjectId: vi.fn(async () => TEST_PROJECT_ID),
  upsertProjectInfo: vi.fn(async () => {}),
  getProjectPathById: vi.fn(async (id: string) => (id === TEST_PROJECT_ID ? activeProjectPath : null)),
  getProjectIdByPath: vi.fn(async () => null),
  loadRegistry: vi.fn(async () => ({})),
}))

vi.mock("./sweep-reviews", () => ({
  sweepResolvedReviews: vi.fn(async () => 0),
}))

let generationDeferred: Deferred<void> = createDeferred<void>()
let generationBlocks = ""
let capturedGenerationSignal: AbortSignal | undefined

vi.mock("./llm-client", () => ({
  streamChat: vi.fn(async (_cfg, messages, cb, signal) => {
    const systemPrompt = String(messages?.[0]?.content ?? "")

    if (systemPrompt.startsWith("You are a wiki maintainer")) {
      // Step 2/2 generation — the stage the test pauses on.
      capturedGenerationSignal = signal
      await generationDeferred.promise
      cb.onToken(generationBlocks)
      cb.onDone()
      return
    }

    if (systemPrompt.startsWith("You are merging two versions")) {
      // Force the merge to go through the backup+fallback path so the
      // pre-cancel merge itself is observable via the page-history
      // snapshot, independent of the cancellation cascade.
      cb.onError(new Error("simulated merge failure for cancellation test"))
      return
    }

    cb.onToken("## Analysis\nMinimal analysis for the cancellation characterization test.\n")
    cb.onDone()
  }),
}))

import { autoIngest as _autoIngest } from "./ingest" // referenced only to keep the real module in the graph
import { enqueueIngest, cancelTask, getQueue, clearQueueState, restoreQueue } from "./ingest-queue"
import { useWikiStore } from "@/stores/wiki-store"
import { removePageEmbedding } from "@/lib/embedding"
import { wikiPathToVectorPageId } from "./wiki-page-identity"

void _autoIngest

const mockRemovePageEmbedding = vi.mocked(removePageEmbedding)

interface Tmp {
  path: string
  cleanup: () => Promise<void>
}

beforeEach(() => {
  clearQueueState()
  generationDeferred = createDeferred<void>()
  generationBlocks = ""
  capturedGenerationSignal = undefined
  activeProjectPath = ""
  mockRemovePageEmbedding.mockClear()
  useWikiStore.getState().setLlmConfig({
    provider: "openai",
    apiKey: "test-key",
    model: "gpt-4",
    ollamaUrl: "",
    customEndpoint: "",
    maxContextSize: 128000,
  })
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

async function seed(label: string): Promise<Tmp> {
  const tmp = track(await createTempProject(label))
  await writeFileRaw(`${tmp.path}/purpose.md`, "")
  await writeFileRaw(`${tmp.path}/schema.md`, "")
  await writeFileRaw(`${tmp.path}/wiki/index.md`, "# Index\n")
  return tmp
}

/**
 * `waitFor` (test-helpers/deferred.ts) polls via `setImmediate`, which
 * advances event-loop TICKS, not wall-clock TIME. That's fine for
 * conditions gated only by in-memory microtask hops, but every wait in
 * this file that's downstream of a real fs read/write (source file,
 * schema.md, purpose.md, ingest-cache.json, the merge/backup write, the
 * cascade-delete + embedding-removal chain) is bound by actual libuv
 * threadpool completion time. Under CI's parallel/loaded execution, a
 * fixed tick budget (`waitFor`'s default 100 attempts) can exhaust
 * itself well before that real I/O lands, causing exactly the kind of
 * intermittent CI-only failure this helper exists to avoid. Poll with a
 * real timer instead, and prefer a POSITIVE completion signal (e.g. a
 * mock call) over a disk-state check where one is available, since a
 * disk-state predicate can start out vacuously true/false and return
 * before the awaited work has actually run at all.
 */
async function waitForDisk(
  predicate: () => Promise<boolean>,
  timeoutMs: number = 3000,
  intervalMs: number = 10,
): Promise<void> {
  const start = Date.now()
  for (;;) {
    if (await predicate()) return
    if (Date.now() - start >= timeoutMs) {
      throw new Error("waitForDisk: predicate never became true before timeout")
    }
    await new Promise<void>((resolve) => setTimeout(resolve, intervalMs))
  }
}

function sourceSummaryFileBlock(sourceId: string): string {
  return [
    "---FILE: wiki/sources/placeholder.md---",
    "---",
    'type: "source"',
    `title: "Source: ${sourceId}"`,
    `sources: ["${sourceId}"]`,
    "tags: []",
    "related: []",
    "---",
    "",
    `# Source: ${sourceId}`,
    "",
    "Summary body.",
    "---END FILE---",
  ].join("\n")
}

describe("ingest-queue cancel cascade (D4)", () => {
  it("22: cancelling mid-write during a MERGE deletes the pre-existing page entirely (D4 bug) but its pre-merge content survives in page-history", async () => {
    const tmp = await seed("cancel-merge")
    activeProjectPath = tmp.path

    const existingTopicPath = `${tmp.path}/wiki/concepts/existing-topic.md`
    const originalExistingContent = [
      "---",
      "type: concept",
      'title: "Existing Topic"',
      "created: 2026-01-01",
      "updated: 2026-01-01",
      'sources: ["old-source.md"]',
      "tags: []",
      "related: []",
      "---",
      "",
      "# Existing Topic",
      "",
      "Original body describing the existing topic before any merge.",
    ].join("\n")
    await writeFileRaw(existingTopicPath, originalExistingContent)
    await writeFileRaw(
      `${tmp.path}/raw/sources/new-doc.md`,
      "A substantive new source document with enough content to avoid the low-quality guard. It has several full sentences of real prose.",
    )

    generationBlocks = [
      sourceSummaryFileBlock("new-doc.md"),
      [
        "---FILE: wiki/concepts/existing-topic.md---",
        "---",
        "type: concept",
        'title: "Existing Topic"',
        "created: 2026-01-01",
        "updated: 2026-05-01",
        'sources: ["new-doc.md"]',
        "tags: []",
        "related: []",
        "---",
        "",
        "# Existing Topic",
        "",
        "Newly generated body contributed by the second source.",
        "---END FILE---",
      ].join("\n"),
    ].join("\n\n")

    await restoreQueue(TEST_PROJECT_ID, tmp.path)
    const taskId = await enqueueIngest(TEST_PROJECT_ID, "raw/sources/new-doc.md")

    // "processing" is set synchronously (in-memory, before any real fs
    // await) once the mocked `getProjectPathById` microtask resolves —
    // no real disk I/O gates it, so the shared setImmediate-based
    // `waitFor` is fine here.
    await waitFor(() => getQueue().find((t) => t.id === taskId)?.status === "processing")
    // "processing" only means the task has been picked up — it doesn't
    // guarantee the (fast, unblocked) analysis stage has already run.
    // Reaching the generation stage requires several REAL fs reads first
    // (source file, schema.md, purpose.md, ingest-cache.json), which are
    // wall-clock-bound (libuv threadpool) — under CI's parallel/loaded
    // execution, `setImmediate`-tick polling (`waitFor`) can exhaust its
    // attempt budget before those reads land, even though no *time* has
    // meaningfully passed from the event loop's point of view. Poll with
    // a real timer instead.
    await waitForDisk(async () => capturedGenerationSignal !== undefined)
    // Generation is now blocked on generationDeferred. Nothing has been
    // written yet — the pre-existing page is untouched.
    expect(await readFileRaw(existingTopicPath)).toBe(originalExistingContent)

    await cancelTask(taskId)
    expect(capturedGenerationSignal?.aborted).toBe(true)
    expect(getQueue().find((t) => t.id === taskId)).toBeUndefined()
    // cancelTask's OWN lastWrittenFiles cleanup branch does not fire here
    // — nothing had been written yet, so the file is still untouched
    // immediately after cancelTask returns. This is the race D4 lives in:
    // the orphaned generation call is still in flight.
    expect(await readFileRaw(existingTopicPath)).toBe(originalExistingContent)

    // Let the orphaned generation stage complete late.
    generationDeferred.resolve()

    // Same technique as test 23: polling `!(await fileExists(...))` is
    // ALSO a real-fs-completion wait (the write + cascade-delete chain
    // spans writeFileBlocks' merge/backup, then cleanupWrittenFiles'
    // dynamically-imported cascade delete + embedding removal) — wait
    // for a POSITIVE, unambiguous signal instead of racing disk polls.
    // `cascadeDeleteWikiPage` (real, unmocked) always `await`s
    // `deleteFile(pagePath)` BEFORE calling `removePageEmbedding`, so
    // observing the mocked `removePageEmbedding` call for this page's
    // vector id proves the delete has already completed on disk.
    const existingTopicPageId = wikiPathToVectorPageId(tmp.path, existingTopicPath)
    await waitForDisk(async () =>
      mockRemovePageEmbedding.mock.calls.some(([, pageId]) => pageId === existingTopicPageId),
    )
    // Drain any trailing microtask/macrotask tail (the cleanup loop's
    // remaining iteration/return, the orphaned processNext catch-branch
    // bail) before assertions run.
    await flushMicrotasks(20)

    // D4 bug: cancelling mid-write deletes the ENTIRE pre-existing page,
    // not just the newly-merged contribution.
    expect(await fileExists(existingTopicPath)).toBe(false)

    const historyDir = `${tmp.path}/.llm-wiki/page-history`
    const historyFiles = await fs.readdir(historyDir).catch(() => [] as string[])
    expect(historyFiles.length).toBeGreaterThan(0)
    const backupContent = await fs.readFile(path.join(historyDir, historyFiles[0]), "utf-8")
    expect(backupContent).toBe(originalExistingContent)
  })

  it("23: control — cancelling mid-write for a BRAND-NEW page deletes it cleanly (correct behavior; guards PR5 against regressing this case)", async () => {
    const tmp = await seed("cancel-new")
    activeProjectPath = tmp.path

    const newTopicPath = `${tmp.path}/wiki/concepts/new-topic.md`
    await writeFileRaw(
      `${tmp.path}/raw/sources/new-doc.md`,
      "Another substantive new source document with enough content to avoid the low-quality guard, describing a brand-new topic.",
    )

    generationBlocks = [
      sourceSummaryFileBlock("new-doc.md"),
      [
        "---FILE: wiki/concepts/new-topic.md---",
        "---",
        "type: concept",
        'title: "New Topic"',
        "created: 2026-05-01",
        "updated: 2026-05-01",
        'sources: ["new-doc.md"]',
        "tags: []",
        "related: []",
        "---",
        "",
        "# New Topic",
        "",
        "Body for a page that has no prior on-disk version.",
        "---END FILE---",
      ].join("\n"),
    ].join("\n\n")

    await restoreQueue(TEST_PROJECT_ID, tmp.path)
    const taskId = await enqueueIngest(TEST_PROJECT_ID, "raw/sources/new-doc.md")

    await waitFor(() => getQueue().find((t) => t.id === taskId)?.status === "processing")
    // See test 22's comment: reaching the generation stage requires
    // several REAL fs reads first — wall-clock-bound, not tick-bound —
    // so this needs `waitForDisk`, not the setImmediate-based `waitFor`.
    await waitForDisk(async () => capturedGenerationSignal !== undefined)
    expect(await fileExists(newTopicPath)).toBe(false)

    await cancelTask(taskId)
    expect(capturedGenerationSignal?.aborted).toBe(true)

    generationDeferred.resolve()

    // NOTE: polling `!(await fileExists(newTopicPath))` here would be
    // vacuously true from the very first check — the page doesn't exist
    // YET (write hasn't happened), not because cleanup already ran. That
    // would let this control test pass even if the cleanup cascade never
    // executed at all. Instead, wait for a POSITIVE, unambiguous signal
    // that the cascade actually ran: `cascadeDeleteWikiPage` (real,
    // unmocked) always `await`s `deleteFile(pagePath)` BEFORE calling
    // `removePageEmbedding` — so observing the mocked
    // `removePageEmbedding` call for this page's vector id proves the
    // delete has already completed on disk, with no polling race.
    const newTopicPageId = wikiPathToVectorPageId(tmp.path, newTopicPath)
    await waitForDisk(async () =>
      mockRemovePageEmbedding.mock.calls.some(([, pageId]) => pageId === newTopicPageId),
    )
    // Drain any trailing microtask/macrotask tail (the cleanup loop's
    // remaining iteration/return, the orphaned processNext catch-branch
    // bail) before the test — and its temp-dir cleanup — ends.
    await flushMicrotasks(20)

    expect(await fileExists(newTopicPath)).toBe(false)

    const historyDir = `${tmp.path}/.llm-wiki/page-history`
    expect(await fs.readdir(historyDir).catch(() => [])).toHaveLength(0)
  })
})
