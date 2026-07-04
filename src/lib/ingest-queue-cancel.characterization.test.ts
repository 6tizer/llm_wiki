/**
 * SPEC-11 PR4/PR5 — characterization tests for the cancel-during-
 * processing cascade (D4): what actually happens on disk when a user
 * cancels an in-flight ingest task whose generation stage produced a
 * MERGE into a pre-existing page, versus one that only created
 * brand-new pages.
 *
 * Unlike ingest.characterization.test.ts, this file drives the REAL
 * `ingest.ts`, `ingest-queue.ts`, and `wiki-page-delete.ts` end to end —
 * only `@/commands/fs` (real fs via temp dir), `./llm-client` (deferred-
 * controlled mock), `@/lib/embedding`, `@/lib/project-identity` (Tauri
 * plugin-store isn't available in tests), and `./sweep-reviews` are
 * mocked.
 *
 * D4 fix verified here (PR5): `cleanupWrittenFiles` now receives a
 * per-page write-metadata map from `autoIngest`'s `onPageWritten`
 * callback, and distinguishes "newly created" from "merged into an
 * existing page" before deciding how to undo a cancelled task's
 * contribution. A merge target is restored to its pre-ingest content
 * instead of being deleted outright; only brand-new pages are still
 * cascade-deleted.
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
// Toggled per-test: false drives the LLM-merge-failure fallback path
// (page-merge.ts's tryBackup), true drives a successful LLM merge with
// no backup. Both are exercised against the PR5 restore fix below —
// restoration must not depend on which merge path produced the write.
let mergeShouldSucceed = false
let mergeSuccessContent = ""

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
      if (mergeShouldSucceed) {
        cb.onToken(mergeSuccessContent)
        cb.onDone()
        return
      }
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
import { enqueueIngest, cancelTask, getQueue, clearQueueState, restoreQueue, cleanupWrittenFiles } from "./ingest-queue"
import { useWikiStore } from "@/stores/wiki-store"
import { embedPage, removePageEmbedding } from "@/lib/embedding"
import { wikiPathToVectorPageId } from "./wiki-page-identity"

void _autoIngest

const mockRemovePageEmbedding = vi.mocked(removePageEmbedding)
const mockEmbedPage = vi.mocked(embedPage)

interface Tmp {
  path: string
  cleanup: () => Promise<void>
}

beforeEach(() => {
  clearQueueState()
  generationDeferred = createDeferred<void>()
  generationBlocks = ""
  capturedGenerationSignal = undefined
  mergeShouldSucceed = false
  mergeSuccessContent = ""
  activeProjectPath = ""
  mockRemovePageEmbedding.mockClear()
  mockEmbedPage.mockClear()
  useWikiStore.getState().setEmbeddingConfig({
    enabled: false,
    endpoint: "",
    apiKey: "",
    model: "",
  })
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
  // `vi.spyOn(realFs, "writeFile"/"readFile")` (used throughout this
  // file) reuses the SAME spy object on repeat calls rather than
  // nesting a new one, since `realFs` is a shared module-level object.
  // An un-restored spy from an earlier test — including its
  // accumulated `mock.calls` and, worse, any `mockImplementation`
  // override injecting a failure — leaks into every later test. Only
  // restoring `realFs`'s own methods here (not `vi.restoreAllMocks()`)
  // to avoid touching the module-level `vi.fn()` mocks from
  // `vi.mock("@/lib/embedding", ...)` etc., which have no "original"
  // implementation to restore to.
  vi.spyOn(realFs, "writeFile").mockRestore()
  vi.spyOn(realFs, "readFile").mockRestore()
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

/**
 * Wait for the "changed then restored" write cascade on `targetPath` to
 * FULLY SETTLE, not just be invoked.
 *
 * `vi.spyOn`'s `mock.calls` records a call's arguments SYNCHRONOUSLY at
 * invocation time — it does NOT wait for that call's own promise to
 * resolve. `fs.writeFile` is not atomic (open + truncate, then write
 * the new bytes, then close): a read landing between truncate and the
 * write completing observes a transient EMPTY file. So a predicate
 * that only checks `mock.calls` for a matching restore-write call can
 * return true WHILE that restore write is still mid-flight, letting
 * the caller's subsequent `readFileRaw` race an empty read.
 *
 * This bit CI intermittently before the disk-content check was added
 * here (2/45 observed failures with the mock.calls-only predicate;
 * 0/80 after adding it) — do not regress to a mock.calls-only check.
 */
async function waitForRestoreWriteToSettle(
  writeFileSpy: { mock: { calls: unknown[][] } },
  targetPath: string,
  originalContent: string,
): Promise<void> {
  await waitForDisk(async () => {
    const calls = writeFileSpy.mock.calls.filter(([p]) => p === targetPath)
    const hadChangingWrite = calls.some(([, c]) => c !== originalContent)
    const hadRestoreWriteCall = calls.some(([, c]) => c === originalContent)
    if (!hadChangingWrite || !hadRestoreWriteCall) return false
    return (await readFileRaw(targetPath)) === originalContent
  })
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
  it("22: PR5 fix restores the pre-existing page's original content when cancelling mid-write during a MERGE (LLM-merge-failure fallback path)", async () => {
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

    const writeFileSpy = vi.spyOn(realFs, "writeFile")

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
    // immediately after cancelTask returns. The orphaned generation call
    // is still in flight.
    expect(await readFileRaw(existingTopicPath)).toBe(originalExistingContent)

    // Let the orphaned generation stage complete late.
    generationDeferred.resolve()

    // PR5 fix no longer routes this page through
    // cascadeDeleteWikiPage/removePageEmbedding at all (it's restored
    // via a plain writeFile instead), so that's no longer a usable
    // completion signal for this path. Wait on the write cascade
    // itself: writeFileBlocks' merge write must land BEFORE the
    // cancel-triggered restore write, so require both — a write that
    // actually changed the content (proving the merge ran, not just
    // that cleanup no-op'd) followed by a write back to the original,
    // SETTLED on disk (see waitForRestoreWriteToSettle's docstring for
    // why a mock.calls-only check isn't enough) — to rule out a
    // false-positive pass.
    await waitForRestoreWriteToSettle(writeFileSpy, existingTopicPath, originalExistingContent)
    // Drain any trailing microtask/macrotask tail (the cleanup loop's
    // remaining iteration/return, the orphaned processNext catch-branch
    // bail) before assertions run.
    await flushMicrotasks(20)

    // PR5 fix: cancelling mid-write restores the pre-existing page's
    // original content instead of deleting the whole page.
    expect(await fileExists(existingTopicPath)).toBe(true)
    expect(await readFileRaw(existingTopicPath)).toBe(originalExistingContent)

    // The pre-cancel merge attempt went through the LLM-merge-failure
    // fallback path, which still backs up the existing content before
    // falling back (page-merge.ts's tryBackup) — kept here as evidence
    // the merge attempt actually ran, independent of the restore
    // assertion above.
    const historyDir = `${tmp.path}/.llm-wiki/page-history`
    const historyFiles = await fs.readdir(historyDir).catch(() => [] as string[])
    expect(historyFiles.length).toBeGreaterThan(0)
    const backupContent = await fs.readFile(path.join(historyDir, historyFiles[0]), "utf-8")
    expect(backupContent).toBe(originalExistingContent)
  })

  it("22b: PR5 fix also restores original content when the MERGE succeeds via the LLM (no page-history backup on this path)", async () => {
    const tmp = await seed("cancel-merge-success")
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

    // A real LLM merge success — well above the body-shrink sanity
    // threshold, valid frontmatter — so mergePageContent takes the
    // accepted-merge branch instead of the fallback branch that test
    // 22 exercises.
    mergeShouldSucceed = true
    mergeSuccessContent = [
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
      "",
      "Newly generated body contributed by the second source, now unified",
      "into one coherent section by the merge LLM.",
    ].join("\n")
    useWikiStore.getState().setEmbeddingConfig({
      enabled: true,
      endpoint: "http://127.0.0.1:1234/v1/embeddings",
      apiKey: "",
      model: "test-embedding-model",
    })

    const writeFileSpy = vi.spyOn(realFs, "writeFile")

    await restoreQueue(TEST_PROJECT_ID, tmp.path)
    const taskId = await enqueueIngest(TEST_PROJECT_ID, "raw/sources/new-doc.md")

    await waitFor(() => getQueue().find((t) => t.id === taskId)?.status === "processing")
    await waitForDisk(async () => capturedGenerationSignal !== undefined)
    expect(await readFileRaw(existingTopicPath)).toBe(originalExistingContent)

    await cancelTask(taskId)
    expect(capturedGenerationSignal?.aborted).toBe(true)
    expect(await readFileRaw(existingTopicPath)).toBe(originalExistingContent)

    generationDeferred.resolve()

    await waitForRestoreWriteToSettle(writeFileSpy, existingTopicPath, originalExistingContent)
    await flushMicrotasks(20)

    // Same restore behavior on the successful-merge path.
    expect(await fileExists(existingTopicPath)).toBe(true)
    expect(await readFileRaw(existingTopicPath)).toBe(originalExistingContent)
    expect(mockEmbedPage).toHaveBeenCalledWith(
      tmp.path,
      wikiPathToVectorPageId(tmp.path, existingTopicPath),
      "Existing Topic",
      originalExistingContent,
      expect.objectContaining({ enabled: true, model: "test-embedding-model" }),
    )

    // No LLM-merge failure occurred on this path, so tryBackup never
    // ran — page-history stays empty. Restoration here comes entirely
    // from the onPageWritten record's previousContent snapshot, not
    // from the (unused) page-history side channel.
    const historyDir = `${tmp.path}/.llm-wiki/page-history`
    expect(await fs.readdir(historyDir).catch(() => [])).toHaveLength(0)
  })

  it("22c: cancelling a write to a pre-existing empty page restores it as an empty page instead of deleting it", async () => {
    const tmp = await seed("cancel-empty-existing-page")
    activeProjectPath = tmp.path

    const emptyPagePath = `${tmp.path}/wiki/concepts/empty-placeholder.md`
    await writeFileRaw(emptyPagePath, "")
    await writeFileRaw(
      `${tmp.path}/raw/sources/new-doc.md`,
      "A substantive new source document with enough content to avoid the low-quality guard. It has several full sentences of real prose.",
    )

    generationBlocks = [
      sourceSummaryFileBlock("new-doc.md"),
      [
        "---FILE: wiki/concepts/empty-placeholder.md---",
        "---",
        "type: concept",
        'title: "Empty Placeholder"',
        "created: 2026-01-01",
        "updated: 2026-05-01",
        'sources: ["new-doc.md"]',
        "tags: []",
        "related: []",
        "---",
        "",
        "# Empty Placeholder",
        "",
        "New content that must be undone when the task is cancelled.",
        "---END FILE---",
      ].join("\n"),
    ].join("\n\n")

    const writeFileSpy = vi.spyOn(realFs, "writeFile")

    await restoreQueue(TEST_PROJECT_ID, tmp.path)
    const taskId = await enqueueIngest(TEST_PROJECT_ID, "raw/sources/new-doc.md")

    await waitFor(() => getQueue().find((t) => t.id === taskId)?.status === "processing")
    await waitForDisk(async () => capturedGenerationSignal !== undefined)
    expect(await fileExists(emptyPagePath)).toBe(true)
    expect(await readFileRaw(emptyPagePath)).toBe("")

    await cancelTask(taskId)
    expect(capturedGenerationSignal?.aborted).toBe(true)
    expect(await fileExists(emptyPagePath)).toBe(true)
    expect(await readFileRaw(emptyPagePath)).toBe("")

    generationDeferred.resolve()

    await waitForRestoreWriteToSettle(writeFileSpy, emptyPagePath, "")
    await flushMicrotasks(20)

    const emptyPageId = wikiPathToVectorPageId(tmp.path, emptyPagePath)
    expect(
      mockRemovePageEmbedding.mock.calls.some(([, pageId]) => pageId === emptyPageId),
    ).toBe(false)
    expect(await fileExists(emptyPagePath)).toBe(true)
    expect(await readFileRaw(emptyPagePath)).toBe("")
  })

  it("22d: duplicate writes to the same pre-existing page keep the earliest undo snapshot", async () => {
    const tmp = await seed("cancel-duplicate-existing")
    activeProjectPath = tmp.path

    const existingTopicPath = `${tmp.path}/wiki/concepts/duplicate-topic.md`
    const originalExistingContent = [
      "---",
      "type: concept",
      'title: "Duplicate Topic"',
      "created: 2026-01-01",
      "updated: 2026-01-01",
      'sources: ["old-source.md"]',
      "tags: []",
      "related: []",
      "---",
      "",
      "# Duplicate Topic",
      "",
      "Original body before either duplicate write from this cancelled task.",
    ].join("\n")
    await writeFileRaw(existingTopicPath, originalExistingContent)
    await writeFileRaw(
      `${tmp.path}/raw/sources/new-doc.md`,
      "A substantive source document with enough content to avoid the low-quality guard. It mentions the same target twice.",
    )

    generationBlocks = [
      sourceSummaryFileBlock("new-doc.md"),
      [
        "---FILE: wiki/concepts/duplicate-topic.md---",
        "---",
        "type: concept",
        'title: "Duplicate Topic"',
        "created: 2026-01-01",
        "updated: 2026-05-01",
        'sources: ["new-doc.md"]',
        "tags: []",
        "related: []",
        "---",
        "",
        "# Duplicate Topic",
        "",
        "First duplicate write from the cancelled task.",
        "---END FILE---",
      ].join("\n"),
      [
        "---FILE: wiki/concepts/duplicate-topic.md---",
        "---",
        "type: concept",
        'title: "Duplicate Topic"',
        "created: 2026-01-01",
        "updated: 2026-05-02",
        'sources: ["new-doc.md"]',
        "tags: []",
        "related: []",
        "---",
        "",
        "# Duplicate Topic",
        "",
        "Second duplicate write from the same cancelled task.",
        "---END FILE---",
      ].join("\n"),
    ].join("\n\n")

    const writeFileSpy = vi.spyOn(realFs, "writeFile")

    await restoreQueue(TEST_PROJECT_ID, tmp.path)
    const taskId = await enqueueIngest(TEST_PROJECT_ID, "raw/sources/new-doc.md")

    await waitFor(() => getQueue().find((t) => t.id === taskId)?.status === "processing")
    await waitForDisk(async () => capturedGenerationSignal !== undefined)

    await cancelTask(taskId)
    expect(capturedGenerationSignal?.aborted).toBe(true)

    generationDeferred.resolve()

    await waitForRestoreWriteToSettle(writeFileSpy, existingTopicPath, originalExistingContent)
    await flushMicrotasks(20)

    expect(await fileExists(existingTopicPath)).toBe(true)
    expect(await readFileRaw(existingTopicPath)).toBe(originalExistingContent)
  })

  it("22e: duplicate writes to the same brand-new page keep the created-page undo semantics", async () => {
    const tmp = await seed("cancel-duplicate-new")
    activeProjectPath = tmp.path

    const newTopicPath = `${tmp.path}/wiki/concepts/duplicate-new-topic.md`
    await writeFileRaw(
      `${tmp.path}/raw/sources/new-doc.md`,
      "A substantive source document with enough content to avoid the low-quality guard. It creates the same page twice.",
    )

    generationBlocks = [
      sourceSummaryFileBlock("new-doc.md"),
      [
        "---FILE: wiki/concepts/duplicate-new-topic.md---",
        "---",
        "type: concept",
        'title: "Duplicate New Topic"',
        "created: 2026-05-01",
        "updated: 2026-05-01",
        'sources: ["new-doc.md"]',
        "tags: []",
        "related: []",
        "---",
        "",
        "# Duplicate New Topic",
        "",
        "First content for a page that did not exist before this task.",
        "---END FILE---",
      ].join("\n"),
      [
        "---FILE: wiki/concepts/duplicate-new-topic.md---",
        "---",
        "type: concept",
        'title: "Duplicate New Topic"',
        "created: 2026-05-01",
        "updated: 2026-05-02",
        'sources: ["new-doc.md"]',
        "tags: []",
        "related: []",
        "---",
        "",
        "# Duplicate New Topic",
        "",
        "Second content for the same new page from this task.",
        "---END FILE---",
      ].join("\n"),
    ].join("\n\n")

    await restoreQueue(TEST_PROJECT_ID, tmp.path)
    const taskId = await enqueueIngest(TEST_PROJECT_ID, "raw/sources/new-doc.md")

    await waitFor(() => getQueue().find((t) => t.id === taskId)?.status === "processing")
    await waitForDisk(async () => capturedGenerationSignal !== undefined)
    expect(await fileExists(newTopicPath)).toBe(false)

    await cancelTask(taskId)
    expect(capturedGenerationSignal?.aborted).toBe(true)

    generationDeferred.resolve()

    const newTopicPageId = wikiPathToVectorPageId(tmp.path, newTopicPath)
    await waitForDisk(async () =>
      mockRemovePageEmbedding.mock.calls.some(([, pageId]) => pageId === newTopicPageId),
    )
    await flushMicrotasks(20)

    expect(await fileExists(newTopicPath)).toBe(false)
  })

  it("23: control — cancelling mid-write for a BRAND-NEW page deletes it cleanly (unaffected by the PR5 merge-restore fix)", async () => {
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

  it("24: cancelling mid-write during a wiki/log.md APPEND restores the pre-cancel log content (not deleted, not left with the new entry)", async () => {
    const tmp = await seed("cancel-log")
    activeProjectPath = tmp.path

    const logPath = `${tmp.path}/wiki/log.md`
    const originalLogContent = "# Wiki Log\n\n## [2026-01-01] ingest | Seed Entry\n"
    await writeFileRaw(logPath, originalLogContent)
    await writeFileRaw(
      `${tmp.path}/raw/sources/new-doc.md`,
      "A substantive new source document with enough content to avoid the low-quality guard, used to exercise a log append that gets cancelled mid-write.",
    )

    generationBlocks = [
      sourceSummaryFileBlock("new-doc.md"),
      ["---FILE: wiki/log.md---", "## [2026-05-01] ingest | New Entry From This Task", "---END FILE---"].join("\n"),
    ].join("\n\n")

    const writeFileSpy = vi.spyOn(realFs, "writeFile")

    await restoreQueue(TEST_PROJECT_ID, tmp.path)
    const taskId = await enqueueIngest(TEST_PROJECT_ID, "raw/sources/new-doc.md")

    await waitFor(() => getQueue().find((t) => t.id === taskId)?.status === "processing")
    await waitForDisk(async () => capturedGenerationSignal !== undefined)
    expect(await readFileRaw(logPath)).toBe(originalLogContent)

    await cancelTask(taskId)
    expect(capturedGenerationSignal?.aborted).toBe(true)
    // Nothing has been written yet — the orphaned generation call is
    // still in flight.
    expect(await readFileRaw(logPath)).toBe(originalLogContent)

    generationDeferred.resolve()

    // Same two-phase signal as test 22/22b: require BOTH an append
    // write (proving the log append actually landed on disk) and a
    // later write back to the EXACT pre-cancel content, SETTLED on
    // disk (proving cleanup restored it via the onPageWritten record's
    // previousContent, not that the append simply never happened).
    await waitForRestoreWriteToSettle(writeFileSpy, logPath, originalLogContent)
    await flushMicrotasks(20)

    // PR5 fix: log.md is restored to its pre-cancel content — neither
    // deleted (log.md is structural, not embedded, so the old
    // cascade-delete path would have just wiped the whole file) nor
    // left with the cancelled task's new entry appended.
    expect(await fileExists(logPath)).toBe(true)
    const finalLogContent = await readFileRaw(logPath)
    expect(finalLogContent).toBe(originalLogContent)
    expect(finalLogContent).not.toContain("New Entry From This Task")
  })

  it("24b: cancelling after overwriting a pre-existing nested listing page restores its original content", async () => {
    const tmp = await seed("cancel-nested-listing")
    activeProjectPath = tmp.path

    const listingPath = `${tmp.path}/wiki/projects/index.md`
    const originalListingContent = "# Old Nested Index\n\nOriginal listing content that existed before ingest.\n"
    await writeFileRaw(listingPath, originalListingContent)
    await writeFileRaw(
      `${tmp.path}/raw/sources/new-doc.md`,
      "A substantive source document with enough prose to avoid the low-quality guard, exercising nested listing overwrite cleanup.",
    )

    generationBlocks = [
      sourceSummaryFileBlock("new-doc.md"),
      [
        "---FILE: wiki/projects/index.md---",
        "# New Nested Index",
        "",
        "Cancelled listing content that must not survive cleanup.",
        "---END FILE---",
      ].join("\n"),
    ].join("\n\n")

    const writeFileSpy = vi.spyOn(realFs, "writeFile")

    await restoreQueue(TEST_PROJECT_ID, tmp.path)
    const taskId = await enqueueIngest(TEST_PROJECT_ID, "raw/sources/new-doc.md")

    await waitFor(() => getQueue().find((t) => t.id === taskId)?.status === "processing")
    await waitForDisk(async () => capturedGenerationSignal !== undefined)
    expect(await readFileRaw(listingPath)).toBe(originalListingContent)

    await cancelTask(taskId)
    expect(capturedGenerationSignal?.aborted).toBe(true)
    expect(await readFileRaw(listingPath)).toBe(originalListingContent)

    generationDeferred.resolve()

    await waitForRestoreWriteToSettle(writeFileSpy, listingPath, originalListingContent)
    await flushMicrotasks(20)

    expect(await fileExists(listingPath)).toBe(true)
    expect(await readFileRaw(listingPath)).toBe(originalListingContent)
  })

  it("24c: cleanup with missing write metadata preserves an existing page instead of deleting it", async () => {
    const tmp = await seed("cancel-missing-metadata-defense")
    activeProjectPath = tmp.path

    const listingPath = `${tmp.path}/wiki/projects/overview.md`
    const currentContent = "# Cancelled Overview\n\nContent is left in place when metadata is missing.\n"
    await writeFileRaw(listingPath, currentContent)

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})

    await cleanupWrittenFiles(tmp.path, ["wiki/projects/overview.md"], new Map())

    expect(await fileExists(listingPath)).toBe(true)
    expect(await readFileRaw(listingPath)).toBe(currentContent)
    expect(warnSpy.mock.calls.some(([msg]) => String(msg).includes("write metadata is missing"))).toBe(true)

    warnSpy.mockRestore()
  })

  it("25 (P2-2): a failed self-undo restore leaves the page in writtenPaths so the external cleanup fallback can retry it", async () => {
    const tmp = await seed("cancel-selfundo-fails")
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

    // Inject a failure into ONLY the first restore-write attempt for
    // this page (autoIngestImpl's in-lock self-undo) — every other
    // write, including the merge write itself and any SUBSEQUENT
    // restore attempt (the queue's external abort-guard cleanup,
    // acting as the documented fallback), goes through untouched.
    const originalWriteFile = realFs.writeFile
    let restoreAttempts = 0
    const writeFileSpy = vi
      .spyOn(realFs, "writeFile")
      .mockImplementation(async (p: string, contents: string) => {
        if (p === existingTopicPath && contents === originalExistingContent) {
          restoreAttempts++
          if (restoreAttempts === 1) {
            throw new Error("simulated disk failure during self-undo restore")
          }
        }
        return originalWriteFile(p, contents)
      })

    await restoreQueue(TEST_PROJECT_ID, tmp.path)
    const taskId = await enqueueIngest(TEST_PROJECT_ID, "raw/sources/new-doc.md")

    await waitFor(() => getQueue().find((t) => t.id === taskId)?.status === "processing")
    await waitForDisk(async () => capturedGenerationSignal !== undefined)
    expect(await readFileRaw(existingTopicPath)).toBe(originalExistingContent)

    await cancelTask(taskId)
    expect(capturedGenerationSignal?.aborted).toBe(true)

    generationDeferred.resolve()

    // The FIRST restore attempt (self-undo, still holding the
    // per-project lock) throws by design and is swallowed — if
    // `writtenPaths` were wrongly emptied regardless of that failure
    // (the P2-2 bug), no SECOND attempt would ever happen and this
    // wait would time out. A second attempt landing, with the content
    // settled on disk, proves the failed path survived in
    // `writtenPaths` all the way to the external cleanup's fallback.
    await waitForDisk(async () => {
      if (restoreAttempts < 2) return false
      return (await readFileRaw(existingTopicPath)) === originalExistingContent
    })
    await flushMicrotasks(20)

    expect(restoreAttempts).toBeGreaterThanOrEqual(2)
    expect(await fileExists(existingTopicPath)).toBe(true)
    expect(await readFileRaw(existingTopicPath)).toBe(originalExistingContent)

    writeFileSpy.mockRestore()
  })

  it("26: cancelling during fallback source-summary read/write restores it before releasing the project lock", async () => {
    // The fallback source-summary write happens after writeFileBlocks.
    // This test cancels after the fallback's `!signal?.aborted` gate has
    // passed but before its read await resumes. Correct behavior is no
    // longer to rely on processNext's external abort cleanup; autoIngest's
    // own self-undo must cover the fallback write while the per-project
    // lock is still held.
    const tmp = await seed("bug1-fallback-pause-race")
    activeProjectPath = tmp.path

    const fallbackSummaryPath = `${tmp.path}/wiki/sources/new-doc.md`
    const originalSummaryContent = [
      "---",
      'type: "source"',
      'title: "Source: new-doc.md"',
      'sources: ["new-doc.md"]',
      "tags: []",
      "related: []",
      "---",
      "",
      "# Source: new-doc.md",
      "",
      "Summary body from a prior ingest of this same source.",
    ].join("\n")
    await writeFileRaw(fallbackSummaryPath, originalSummaryContent)
    await writeFileRaw(
      `${tmp.path}/raw/sources/new-doc.md`,
      "A substantive source document with enough prose to avoid the low-quality guard, exercising the fallback source-summary write path.",
    )

    // No wiki/sources/ block in the generation output — writeFileBlocks
    // never touches the summary page; it's written ONLY via the
    // fallback (ingest.ts's "Ensure source summary exists" section),
    // which this test expects self-undo to see even when cancellation
    // happens during the fallback's own read/write awaits.
    generationBlocks = ""
    generationDeferred.resolve()

    const fallbackReadDeferred = createDeferred<void>()
    let fallbackReadCaptured = false
    const originalReadFile = realFs.readFile
    const readFileSpy = vi.spyOn(realFs, "readFile").mockImplementation(async (p: string) => {
      if (p === fallbackSummaryPath && !fallbackReadCaptured) {
        fallbackReadCaptured = true
        await fallbackReadDeferred.promise
      }
      return originalReadFile(p)
    })

    const writeFileSpy = vi.spyOn(realFs, "writeFile")

    await restoreQueue(TEST_PROJECT_ID, tmp.path)
    const taskId = await enqueueIngest(TEST_PROJECT_ID, "raw/sources/new-doc.md")

    await waitFor(() => getQueue().find((t) => t.id === taskId)?.status === "processing")
    await waitForDisk(async () => fallbackReadCaptured)
    expect(await readFileRaw(fallbackSummaryPath)).toBe(originalSummaryContent)

    await cancelTask(taskId)
    expect(await readFileRaw(fallbackSummaryPath)).toBe(originalSummaryContent)

    fallbackReadDeferred.resolve()

    await waitForRestoreWriteToSettle(writeFileSpy, fallbackSummaryPath, originalSummaryContent)
    await flushMicrotasks(50)

    const fallbackPageId = wikiPathToVectorPageId(tmp.path, fallbackSummaryPath)
    expect(
      mockRemovePageEmbedding.mock.calls.some(([, pageId]) => pageId === fallbackPageId),
    ).toBe(false)
    expect(await fileExists(fallbackSummaryPath)).toBe(true)
    expect(await readFileRaw(fallbackSummaryPath)).toBe(originalSummaryContent)

    readFileSpy.mockRestore()
    writeFileSpy.mockRestore()
  })
})
