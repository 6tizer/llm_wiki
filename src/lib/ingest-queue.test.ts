import { describe, it, expect, beforeEach, vi } from "vitest"
import { flushMicrotasks } from "@/test-helpers/deferred"
import { wikiRelativePathToVectorPageId } from "./wiki-page-identity"

// Mock autoIngest so tests control success/failure timing.
vi.mock("./ingest", () => ({
  autoIngest: vi.fn(),
}))

// Mock fs so we don't hit the real filesystem.
vi.mock("@/commands/fs", () => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
  listDirectory: vi.fn(),
  deleteFile: vi.fn(),
}))

// Mock sweep-reviews since the queue drain dynamically imports it. The
// sweep itself has its own test file; here we just confirm it's triggered.
vi.mock("./sweep-reviews", () => ({
  sweepResolvedReviews: vi.fn().mockResolvedValue(0),
}))

// Mock embedding so cleanupWrittenFiles' cascade-delete to LanceDB is
// observable. The real module is over in `./embedding` but
// cleanupWrittenFiles dynamically imports it via `@/lib/embedding`,
// hence the absolute mock target.
const removePageEmbeddingMock = vi.fn<(projectPath: string, slug: string) => Promise<void>>(
  async () => {},
)
vi.mock("@/lib/embedding", () => ({
  removePageEmbedding: (projectPath: string, slug: string) =>
    removePageEmbeddingMock(projectPath, slug),
}))

// Mock wiki-page-delete so cleanupWrittenFiles is deterministic and
// side-effect-free across tests. The real cascade reads index.md,
// lists directories, rewrites frontmatter, and recursively removes
// media dirs — all coupled to mock-readFile/mock-listDirectory state,
// and its async settle timing leaks deleteFile calls across tests
// when invoked mid-test (e.g. from the abort-guard path). The mock
// reproduces the observable contract the cascade tests rely on:
// deleteFile(pagePath) then removePageEmbedding(projectPath, slug).
vi.mock("@/lib/wiki-page-delete", () => ({
  cascadeDeleteWikiPage: async (
    projectPath: string,
    pagePath: string,
  ): Promise<void> => {
    const { deleteFile } = await import("@/commands/fs")
    const { wikiPathToVectorPageId } = await import("@/lib/wiki-page-identity")
    const { getFileStem } = await import("@/lib/path-utils")
    await deleteFile(pagePath)
    const slug = getFileStem(pagePath)
    if (slug.length > 0) {
      const { removePageEmbedding } = await import("@/lib/embedding")
      await removePageEmbedding(projectPath, wikiPathToVectorPageId(projectPath, pagePath))
    }
  },
}))

// Mock project-identity — tests don't hit Tauri plugin-store. Maps the
// test UUIDs defined below back to their assigned paths.
const TEST_ID = "test-project-uuid"
const TEST_PATH = "/project"
const TEST_ID_B = "test-project-uuid-b"
const TEST_PATH_B = "/project-b"
const idToPath: Record<string, string> = {
  [TEST_ID]: TEST_PATH,
  [TEST_ID_B]: TEST_PATH_B,
}
vi.mock("@/lib/project-identity", () => ({
  ensureProjectId: vi.fn(),
  upsertProjectInfo: vi.fn(),
  getProjectPathById: vi.fn(async (id: string) => idToPath[id] ?? null),
  getProjectIdByPath: vi.fn(),
  loadRegistry: vi.fn(),
}))

import {
  enqueueIngest,
  enqueueBatch,
  retryTask,
  retryAllFailedTasks,
  cancelTask,
  cancelAllTasks,
  clearCompletedTasks,
  clearQueueState,
  cleanupWrittenFiles,
  getQueue,
  getQueueSummary,
  restoreQueue,
} from "./ingest-queue"
import { autoIngest } from "./ingest"
import { readFile, writeFile } from "@/commands/fs"
import { sweepResolvedReviews } from "./sweep-reviews"
import { useWikiStore } from "@/stores/wiki-store"

const mockAutoIngest = vi.mocked(autoIngest)
const mockReadFile = vi.mocked(readFile)
const mockWriteFile = vi.mocked(writeFile)
const mockSweep = vi.mocked(sweepResolvedReviews)

/** Simulate the app having opened `TEST_ID` at `TEST_PATH` so the queue
 *  module's `currentProjectId` / `currentProjectPath` are set. Most
 *  tests need this — enqueue / retry / cancel guard against inactive
 *  projects. */
async function activateProject(id: string = TEST_ID): Promise<void> {
  await restoreQueue(id, idToPath[id])
}

beforeEach(async () => {
  clearQueueState()
  mockAutoIngest.mockReset()
  mockReadFile.mockReset()
  mockWriteFile.mockReset()
  mockSweep.mockReset()
  mockSweep.mockResolvedValue(0)
  removePageEmbeddingMock.mockReset()
  // Reset deleteFile too — several tests trigger cleanupWrittenFiles
  // (cancel/cancelAll/pause/abort-guard) which dynamically imports
  // wiki-page-delete and calls deleteFile. Without a reset here, call
  // counts leak across tests.
  const { deleteFile } = await import("@/commands/fs")
  vi.mocked(deleteFile).mockReset()
  vi.mocked(deleteFile).mockResolvedValue(undefined)

  // Default: persisted queue file doesn't exist
  mockReadFile.mockRejectedValue(new Error("ENOENT"))
  mockWriteFile.mockResolvedValue(undefined as unknown as void)

  // Default: a valid LLM config so processNext doesn't reject.
  useWikiStore.getState().setLlmConfig({
    provider: "openai",
    apiKey: "test-key",
    model: "gpt-4",
    ollamaUrl: "",
    customEndpoint: "",
    maxContextSize: 128000,
  })

  await activateProject()
})

describe("ingest-queue — enqueue & basic processing", () => {
  it("enqueueIngest adds a pending task and triggers processing", async () => {
    mockAutoIngest.mockResolvedValue(["wiki/sources/foo.md"])

    const id = await enqueueIngest(TEST_ID, "raw/sources/a.md")
    expect(id).toMatch(/^ingest-/)

    // Let the async processing loop run
    await flushMicrotasks(10)

    // Task should have been processed and removed
    expect(mockAutoIngest).toHaveBeenCalledOnce()
    expect(getQueue()).toHaveLength(0)
    expect(getQueueSummary()).toMatchObject({ completed: 1, total: 1 })
  })

  it("persists queue to disk on enqueue", async () => {
    mockAutoIngest.mockImplementation(() => new Promise(() => {})) // never resolves
    await enqueueIngest(TEST_ID, "a.md")
    await flushMicrotasks(2)

    // writeFile should have been called to save the queue
    const calls = mockWriteFile.mock.calls
    expect(calls.length).toBeGreaterThan(0)
    const queuePath = calls[0][0]
    expect(queuePath).toContain(".llm-wiki/ingest-queue.json")
  })

  it("enqueueBatch queues multiple tasks and processes them serially", async () => {
    mockAutoIngest.mockResolvedValue(["wiki/sources/foo.md"])

    await enqueueBatch(TEST_ID, [
      { sourcePath: "a.md", folderContext: "" },
      { sourcePath: "b.md", folderContext: "" },
      { sourcePath: "c.md", folderContext: "" },
    ])

    await flushMicrotasks(50)

    expect(mockAutoIngest).toHaveBeenCalledTimes(3)
    expect(getQueue()).toHaveLength(0)
  })
})

describe("ingest-queue — retry & failure", () => {
  it("retries a failing task up to MAX_RETRIES=3 then marks failed", async () => {
    mockAutoIngest.mockRejectedValue(new Error("LLM error"))

    await enqueueIngest(TEST_ID, "bad.md")
    await flushMicrotasks(30)

    expect(mockAutoIngest).toHaveBeenCalledTimes(3)
    const queue = getQueue()
    expect(queue).toHaveLength(1)
    expect(queue[0].status).toBe("failed")
    expect(queue[0].error).toContain("LLM error")
    expect(queue[0].retryCount).toBe(3)
  })

  it("succeeds on retry after transient failure", async () => {
    mockAutoIngest
      .mockRejectedValueOnce(new Error("transient"))
      .mockRejectedValueOnce(new Error("transient"))
      .mockResolvedValueOnce(["wiki/sources/foo.md"])

    await enqueueIngest(TEST_ID, "flaky.md")
    await flushMicrotasks(30)

    expect(mockAutoIngest).toHaveBeenCalledTimes(3)
    expect(getQueue()).toHaveLength(0)
  })

  it("treats autoIngest resolving to an empty array as a failure (not silent success)", async () => {
    // Regression: a webview refresh could abort the LLM fetch, making
    // streamChat's error path fire, which historically caused autoIngest
    // to `return []` — processNext then removed the task from the queue
    // as if it had succeeded. The safety net in processNext now rejects
    // zero-output completions and keeps the task around to retry.
    mockAutoIngest.mockResolvedValue([])

    await enqueueIngest(TEST_ID, "refresh-abort.md")
    await flushMicrotasks(30)

    // Three retries were attempted — the task didn't just vanish.
    expect(mockAutoIngest).toHaveBeenCalledTimes(3)
    const queue = getQueue()
    expect(queue).toHaveLength(1)
    expect(queue[0].status).toBe("failed")
    expect(queue[0].error).toContain("no output files")
    expect(queue[0].retryCount).toBe(3)
  })

  it("retryTask resets a failed task to pending and reprocesses it", async () => {
    mockAutoIngest.mockRejectedValue(new Error("always fails"))

    await enqueueIngest(TEST_ID, "x.md")
    await flushMicrotasks(20)
    expect(getQueue()[0].status).toBe("failed")

    const taskId = getQueue()[0].id
    expect(getQueue()[0].retryCount).toBe(3)
    mockAutoIngest.mockResolvedValueOnce(["wiki/sources/foo.md"])
    await retryTask(taskId)
    await flushMicrotasks(10)

    expect(getQueue()).toHaveLength(0)
  })

  it("retryAllFailedTasks requeues every failed task and resumes processing", async () => {
    const saved = [
      {
        id: "ingest-failed-a",
        sourcePath: "a.md",
        folderContext: "",
        status: "failed",
        addedAt: 0,
        error: "rate limit",
        retryCount: 3,
      },
      {
        id: "ingest-failed-b",
        sourcePath: "b.md",
        folderContext: "",
        status: "failed",
        addedAt: 1,
        error: "timeout",
        retryCount: 3,
      },
    ]
    mockReadFile.mockResolvedValue(JSON.stringify(saved))
    mockAutoIngest.mockImplementation(() => new Promise(() => {}))

    await restoreQueue(TEST_ID, TEST_PATH)
    mockWriteFile.mockClear()

    const requeued = await retryAllFailedTasks()
    await flushMicrotasks(2)

    expect(requeued).toBe(2)
    expect(mockAutoIngest).toHaveBeenCalledOnce()
    expect(getQueue().map((task) => task.error)).toEqual([null, null])
    expect(getQueue().map((task) => task.retryCount)).toEqual([0, 0])
    expect(getQueue().map((task) => task.status)).toEqual(["processing", "pending"])
    expect(mockWriteFile).toHaveBeenCalled()
  })

  it("retryAllFailedTasks returns 0 when there are no failed tasks", async () => {
    mockAutoIngest.mockImplementation(() => new Promise(() => {}))

    const requeued = await retryAllFailedTasks()

    expect(requeued).toBe(0)
    expect(mockAutoIngest).not.toHaveBeenCalled()
  })
})

describe("ingest-queue — cancel", () => {
  it("cancelTask removes a pending task without calling autoIngest", async () => {
    mockAutoIngest.mockImplementation(() => new Promise(() => {})) // block first task

    await enqueueBatch(TEST_ID, [
      { sourcePath: "first.md", folderContext: "" },
      { sourcePath: "second.md", folderContext: "" },
    ])
    await flushMicrotasks(2)

    // first.md is processing; cancel second.md (still pending)
    const queue = getQueue()
    const second = queue.find((t) => t.sourcePath === "second.md")!
    await cancelTask(second.id)

    expect(getQueue().find((t) => t.sourcePath === "second.md")).toBeUndefined()
    expect(getQueue().find((t) => t.sourcePath === "first.md")).toBeDefined()
  })
})

describe("ingest-queue — cancelAllTasks", () => {
  it("drops all pending and processing tasks but keeps failed ones", async () => {
    // Block the processing task so it doesn't finish on its own.
    mockAutoIngest.mockImplementation(() => new Promise(() => {}))

    await enqueueBatch(TEST_ID, [
      { sourcePath: "a.md", folderContext: "" },
      { sourcePath: "b.md", folderContext: "" },
      { sourcePath: "c.md", folderContext: "" },
    ])
    await flushMicrotasks(2)

    // Manually set one task to "failed" so we can verify it survives.
    const failedTask = getQueue()[2]
    ;(failedTask as { status: string }).status = "failed"

    const removed = await cancelAllTasks()

    expect(removed).toBe(2) // a (processing) + b (pending) gone
    expect(getQueue()).toHaveLength(1)
    expect(getQueue()[0].sourcePath).toBe("c.md")
    expect(getQueue()[0].status).toBe("failed")
  })

  it("returns 0 when the queue is empty", async () => {
    const removed = await cancelAllTasks()
    expect(removed).toBe(0)
    expect(getQueue()).toHaveLength(0)
  })

  it("is safe to call after it has already cleared the queue", async () => {
    mockAutoIngest.mockImplementation(() => new Promise(() => {}))
    await enqueueIngest(TEST_ID, "only.md")
    await flushMicrotasks(2)

    await cancelAllTasks()
    const secondCall = await cancelAllTasks()
    expect(secondCall).toBe(0)
  })
})

describe("ingest-queue — clearCompletedTasks & summary", () => {
  it("getQueueSummary returns accurate counts", async () => {
    mockAutoIngest.mockRejectedValue(new Error("fail"))
    await enqueueIngest(TEST_ID, "fail.md")
    await flushMicrotasks(20)

    const summary = getQueueSummary()
    expect(summary.failed).toBe(1)
    expect(summary.completed).toBe(0)
    expect(summary.pending).toBe(0)
    expect(summary.total).toBe(1)
  })

  it("tracks successful completions until a new idle queue starts", async () => {
    mockAutoIngest.mockResolvedValue(["wiki/sources/foo.md"])
    await enqueueBatch(TEST_ID, [
      { sourcePath: "a.md", folderContext: "" },
      { sourcePath: "b.md", folderContext: "" },
    ])
    await flushMicrotasks(40)

    expect(getQueueSummary()).toMatchObject({ completed: 2, failed: 0, total: 2 })

    await enqueueIngest(TEST_ID, "c.md")
    await flushMicrotasks(20)

    expect(getQueueSummary()).toMatchObject({ completed: 1, failed: 0, total: 1 })
  })

  it("clearCompletedTasks drops failed tasks", async () => {
    mockAutoIngest.mockRejectedValue(new Error("fail"))
    await enqueueIngest(TEST_ID, "f.md")
    await flushMicrotasks(20)

    expect(getQueue()).toHaveLength(1)
    await clearCompletedTasks()
    expect(getQueue()).toHaveLength(0)
  })
})

describe("ingest-queue — queue-drain triggers review sweep", () => {
  it("calls sweepResolvedReviews once after a successful task drains the queue", async () => {
    mockAutoIngest.mockResolvedValue(["wiki/sources/foo.md"])

    await enqueueIngest(TEST_ID, "ok.md")
    await flushMicrotasks(30)

    expect(mockSweep).toHaveBeenCalledOnce()
    expect(mockSweep).toHaveBeenCalledWith("/project", expect.any(AbortSignal))
  })

  it("does NOT trigger sweep when no task has been processed since the last drain", async () => {
    // No tasks enqueued — processedSinceDrain flag stays false
    // (We simulate an idle condition by enqueueing, processing, draining once)
    mockAutoIngest.mockResolvedValue(["wiki/sources/foo.md"])
    await enqueueIngest(TEST_ID, "a.md")
    await flushMicrotasks(20)
    expect(mockSweep).toHaveBeenCalledTimes(1)

    // Now the queue is empty. Calling cancelTask on a nonexistent id is a
    // no-op but internally may call processNext → no drain fire (nothing
    // was processed since the last drain).
    await cancelTask("nonexistent")
    await flushMicrotasks(5)
    expect(mockSweep).toHaveBeenCalledTimes(1)
  })

  it("does NOT trigger sweep when all tasks fail (nothing was successfully ingested)", async () => {
    mockAutoIngest.mockRejectedValue(new Error("always fails"))

    await enqueueIngest(TEST_ID, "bad.md")
    await flushMicrotasks(30)

    expect(mockSweep).not.toHaveBeenCalled()
  })
})

describe("ingest-queue — clearQueueState", () => {
  it("clears pending tasks and resets processing flag", async () => {
    mockAutoIngest.mockImplementation(() => new Promise(() => {}))
    await enqueueBatch(TEST_ID, [
      { sourcePath: "a.md", folderContext: "" },
      { sourcePath: "b.md", folderContext: "" },
    ])
    await flushMicrotasks(2)

    expect(getQueue().length).toBeGreaterThan(0)

    clearQueueState()
    expect(getQueue()).toHaveLength(0)
  })

  it("processedSinceDrain flag resets so a post-switch no-op won't trigger sweep", async () => {
    mockAutoIngest.mockResolvedValue(["wiki/sources/foo.md"])
    await enqueueIngest(TEST_ID, "x.md")
    await flushMicrotasks(20)
    mockSweep.mockClear()

    clearQueueState()
    // Simulate new drain trigger on an empty queue — no sweep.
    await flushMicrotasks(5)
    expect(mockSweep).not.toHaveBeenCalled()
  })
})

describe("ingest-queue — restoreQueue", () => {
  it("resets in-memory state before loading, preventing cross-project bleed", async () => {
    // Seed in-memory state from project A
    mockAutoIngest.mockImplementation(() => new Promise(() => {}))
    await enqueueIngest(TEST_ID, "a.md")
    await flushMicrotasks(2)
    expect(getQueue().length).toBeGreaterThan(0)

    // Now restore project B — should reset and load B's saved queue (empty)
    mockReadFile.mockRejectedValue(new Error("ENOENT"))
    await restoreQueue(TEST_ID_B, TEST_PATH_B)
    expect(getQueue()).toHaveLength(0)
  })

  it("converts 'processing' tasks back to 'pending' on restore (interrupted by app close)", async () => {
    const saved = [
      {
        id: "ingest-abc",
        sourcePath: "a.md",
        folderContext: "",
        status: "processing",
        addedAt: 0,
        error: null,
        retryCount: 0,
      },
    ]
    mockReadFile.mockResolvedValue(JSON.stringify(saved))
    // Prevent the reprocessing kickoff from completing forever:
    mockAutoIngest.mockImplementation(() => new Promise(() => {}))

    await restoreQueue(TEST_ID, TEST_PATH)
    await flushMicrotasks(2)

    const queue = getQueue()
    expect(queue).toHaveLength(1)
    // After restore + kick-off of processNext, the task transitions back to
    // "processing" — but the RESTORED-from-disk value was "pending". We can
    // still assert it's not "failed" / "done".
    expect(["pending", "processing"]).toContain(queue[0].status)
  })

  it("leaves 'failed' tasks as failed on restore", async () => {
    const saved = [
      {
        id: "ingest-x",
        sourcePath: "x.md",
        folderContext: "",
        status: "failed",
        addedAt: 0,
        error: "prior failure",
        retryCount: 3,
      },
    ]
    mockReadFile.mockResolvedValue(JSON.stringify(saved))

    await restoreQueue(TEST_ID, TEST_PATH)
    const queue = getQueue()
    expect(queue).toHaveLength(1)
    expect(queue[0].status).toBe("failed")
    expect(queue[0].error).toBe("prior failure")
  })

  it("backfills projectId on older task files that predate the field", async () => {
    // Disk written before projectId was part of the schema.
    const savedLegacy = [
      {
        id: "ingest-legacy",
        sourcePath: "legacy.md",
        folderContext: "",
        status: "pending",
        addedAt: 0,
        error: null,
        retryCount: 0,
      },
    ]
    mockReadFile.mockResolvedValue(JSON.stringify(savedLegacy))
    mockAutoIngest.mockImplementation(() => new Promise(() => {}))

    await restoreQueue(TEST_ID, TEST_PATH)
    const queue = getQueue()
    expect(queue).toHaveLength(1)
    expect(queue[0].projectId).toBe(TEST_ID)
  })
})

import { pauseQueue } from "./ingest-queue"

describe("ingest-queue — pauseQueue & switch-project survival", () => {
  it("pauseQueue persists pending/processing tasks to the paused project's disk", async () => {
    mockAutoIngest.mockImplementation(() => new Promise(() => {}))
    await enqueueBatch(TEST_ID, [
      { sourcePath: "a.md", folderContext: "" },
      { sourcePath: "b.md", folderContext: "" },
    ])
    await flushMicrotasks(2)
    mockWriteFile.mockClear()

    await pauseQueue()

    // The last write call should contain BOTH tasks, with the processing
    // one demoted back to pending for resume-on-return.
    const writes = mockWriteFile.mock.calls
    expect(writes.length).toBeGreaterThan(0)
    const [pathArg, contentArg] = writes[writes.length - 1]
    expect(String(pathArg)).toContain("/project/.llm-wiki/ingest-queue.json")
    const persisted = JSON.parse(String(contentArg)) as Array<{ status: string }>
    expect(persisted).toHaveLength(2)
    for (const t of persisted) expect(t.status).toBe("pending")
  })

  it("pauseQueue then restoreQueue of SAME project brings tasks back", async () => {
    mockAutoIngest.mockImplementation(() => new Promise(() => {}))
    await enqueueIngest(TEST_ID, "first.md")
    await flushMicrotasks(2)

    // Capture what pauseQueue writes so restore can read it back.
    let lastWrittenContent = ""
    mockWriteFile.mockImplementation(async (_path: string, content: string) => {
      lastWrittenContent = content
    })
    await pauseQueue()

    // Simulate reloading that same project: disk returns what we just wrote.
    mockReadFile.mockResolvedValue(lastWrittenContent)
    await restoreQueue(TEST_ID, TEST_PATH)

    const queue = getQueue()
    expect(queue).toHaveLength(1)
    expect(queue[0].sourcePath).toBe("first.md")
  })

  it("processNext bails if currentProjectId changes mid-ingest (no cross-project writes)", async () => {
    // Block autoIngest so we can pause mid-flight. Then resolve it
    // AFTER pauseQueue completes to simulate the delayed return.
    let resolveAutoIngest: (files: string[]) => void = () => {}
    mockAutoIngest.mockImplementation(
      () => new Promise<string[]>((resolve) => { resolveAutoIngest = resolve }),
    )

    await enqueueIngest(TEST_ID, "long-running.md")
    await flushMicrotasks(2)
    // Ensure the task is processing
    expect(getQueue().find((t) => t.status === "processing")).toBeTruthy()

    // Switch projects: pause then restore a different one.
    mockWriteFile.mockClear()
    await pauseQueue()
    await restoreQueue(TEST_ID_B, TEST_PATH_B)

    // Now the orphaned autoIngest for TEST_ID returns late.
    resolveAutoIngest(["wiki/sources/foo.md"])
    await flushMicrotasks(10)

    // The orphan must not have written to the ACTIVE (B) project's file.
    // Inspect every post-pause write — the path should never contain the
    // project-B queue file getting mutated by the orphan's filter result.
    const writes = mockWriteFile.mock.calls
    // Confirm no write touched project B's queue from orphan completion.
    // (The only writes should be pauseQueue's flush to /project and
    // restoreQueue's initial save of B's empty queue.)
    const bWrites = writes.filter(([p]) => String(p).includes("/project-b/"))
    // B's queue should only have been written once (during restore), and
    // that write should show an empty array — not the orphan's filtered
    // result leaking in.
    for (const [, content] of bWrites) {
      const parsed = JSON.parse(String(content))
      expect(parsed).toEqual([])
    }
  })

  it("processNext routes an aborted (partial) resolve through the error branch, not success", async () => {
    // P1-1: if the run signal aborts mid-write but autoIngest still
    // resolves late with a PARTIAL file list, the success branch must
    // NOT consume it. The captured-signal abort guard throws
    // "Ingest aborted mid-write", routing through the catch branch so
    // the partial result is cleaned up and the task is retried, not
    // silently dropped as if complete.
    //
    // We drive the abort via cancelAllTasks (aborts the signal) but
    // keep a snapshot of the task id, then resolve autoIngest late.
    // Before the fix the late resolve would re-enter the success
    // branch and bump completedSinceIdle / corrupt accounting; after
    // the fix it throws into the catch branch (a no-op for an already-
    // removed task, but crucially does NOT register as success).
    // Reset the deleteFile mock so this test's cleanup cascade doesn't
    // leak call counts into the cleanupWrittenFiles describe block below.
    const { deleteFile } = await import("@/commands/fs")
    vi.mocked(deleteFile).mockReset()
    vi.mocked(deleteFile).mockResolvedValue(undefined)

    let resolveAutoIngest: (files: string[]) => void = () => {}
    mockAutoIngest.mockImplementation(
      () => new Promise<string[]>((resolve) => { resolveAutoIngest = resolve }),
    )

    const taskId = await enqueueIngest(TEST_ID, "aborted-mid.md")
    await flushMicrotasks(2)
    expect(getQueue().find((t) => t.id === taskId)?.status).toBe("processing")

    // Snapshot the summary BEFORE the late resolve. completedSinceIdle
    // is exposed via getQueueSummary — capturing it lets us prove the
    // late partial resolve does NOT register as a completion.
    const summaryBefore = getQueueSummary()

    const { cancelAllTasks } = await import("./ingest-queue")
    const cancelPromise = cancelAllTasks()
    // The signal is now aborted. Resolve autoIngest with a partial list
    // AFTER the abort — the success-branch guard must reject it. Use a
    // NON-source wiki path so cleanupWrittenFiles doesn't trigger the
    // extra media-directory cascade (which would couple this test to
    // mock-readFile state for index.md / media listing).
    resolveAutoIngest(["wiki/concepts/partial.md"])
    await cancelPromise
    // Drain generously: the abort guard's cleanupWrittenFiles runs an
    // async cascade (deleteFile + removePageEmbedding) that must fully
    // settle before the next test's beforeEach, or its mock calls leak
    // across tests. Drain generously: the mock chain does several
    // `await import`s + `await`s, each adding a microtask hop.
    await flushMicrotasks(40)
    await new Promise((r) => setTimeout(r, 0))

    // The partial result must NOT have bumped the completed counter —
    // that would mean the success branch ran on aborted/partial data.
    const summaryAfter = getQueueSummary()
    expect(summaryAfter.completed).toBe(summaryBefore.completed)
  })

  it("cleans up partial files even when the project switched before the late resolve", async () => {
    // Codex re-review P1: when pauseQueue aborts (project switch) and
    // autoIngest then resolves LATE with partial files, the abort guard
    // must clean up those partial pages against the OLD project path —
    // even though the stale-context bail (`currentProjectId !==
    // projectId`) would otherwise return before the guard. The guard
    // now runs FIRST, against the captured `pp`, so partial pages
    // written to the old project are not orphaned on disk.
    const { deleteFile } = await import("@/commands/fs")
    vi.mocked(deleteFile).mockReset()
    vi.mocked(deleteFile).mockResolvedValue(undefined)

    let resolveAutoIngest: (files: string[]) => void = () => {}
    mockAutoIngest.mockImplementation(
      () => new Promise<string[]>((resolve) => { resolveAutoIngest = resolve }),
    )

    const taskId = await enqueueIngest(TEST_ID, "switch-during.md")
    await flushMicrotasks(2)
    expect(getQueue().find((t) => t.id === taskId)?.status).toBe("processing")

    // Switch projects: pauseQueue aborts the captured runSignal, then
    // restore a different project. The orphaned autoIngest for TEST_ID
    // is still pending.
    await pauseQueue()
    await restoreQueue(TEST_ID_B, TEST_PATH_B)

    // Now the orphaned autoIngest for TEST_ID returns LATE with partial
    // files written to the OLD project (/project). The abort guard must
    // clean them up against /project (the captured pp), not bail early
    // on the stale-context check and leave them orphaned.
    resolveAutoIngest(["wiki/concepts/late-partial.md"])
    await flushMicrotasks(40)
    await new Promise((r) => setTimeout(r, 0))

    // The partial file written to the OLD project must have been deleted.
    const deletedPaths = vi.mocked(deleteFile).mock.calls.map(([p]) => String(p))
    expect(deletedPaths.some((p) => p.includes("/project/") && p.includes("late-partial.md"))).toBe(true)
    // And the active (project-B) queue must NOT have been mutated by the
    // orphan's partial result (it should remain empty / not gain the task).
    expect(getQueue().find((t) => t.sourcePath === "switch-during.md")).toBeUndefined()
  })

  it("cancelTask on a processing task does not stall the next pending task (P1 orphan guard)", async () => {
    // Exercises the exact race from the deep review P1 finding:
    // 1. Task A is processing, task B is pending.
    // 2. cancelTask(A) aborts, bumps the run token, starts processNext for B.
    // 3. A's autoIngest resolves late with partial files.
    // 4. The orphaned catch must NOT set processing = false (which would
    //    clobber the new run for B and permanently stall the queue).
    const { deleteFile } = await import("@/commands/fs")
    vi.mocked(deleteFile).mockReset()
    vi.mocked(deleteFile).mockResolvedValue(undefined)

    let resolveA: (files: string[]) => void = () => {}
    mockAutoIngest.mockImplementationOnce(
      () => new Promise<string[]>((resolve) => { resolveA = resolve }),
    )
    // Second call (for task B) succeeds immediately.
    mockAutoIngest.mockResolvedValueOnce(["wiki/sources/b-done.md"])

    await enqueueBatch(TEST_ID, [
      { sourcePath: "a.md", folderContext: "" },
      { sourcePath: "b.md", folderContext: "" },
    ])
    await flushMicrotasks(2)

    const queue = getQueue()
    const taskA = queue.find((t) => t.sourcePath === "a.md")!
    expect(taskA.status).toBe("processing")
    expect(queue.find((t) => t.sourcePath === "b.md")?.status).toBe("pending")

    // Cancel the processing task A. This aborts the signal, bumps the run
    // token, removes A, and calls processNext to start B.
    const cancelPromise = cancelTask(taskA.id)
    // Resolve A's autoIngest late with partial files AFTER the abort.
    resolveA(["wiki/concepts/partial-a.md"])
    await cancelPromise
    // Drain generously so the orphaned continuation's catch block and
    // the new run for B both settle.
    await flushMicrotasks(40)
    await new Promise((r) => setTimeout(r, 0))

    // B must have been processed successfully (not stuck in "processing"
    // or skipped due to a clobbered processing flag).
    expect(mockAutoIngest).toHaveBeenCalledTimes(2)
    // B's task should have been removed from the queue (success path).
    expect(getQueue().find((t) => t.sourcePath === "b.md")).toBeUndefined()
  })

  it("orphaned catch does not clobber the new run's currentAbortController", async () => {
    // P1 re-review finding: the orphaned catch's `currentAbortController
    // = null` must not run when the token is stale. Without the early
    // run-token guard in the catch block, A's orphan would null out B's
    // controller, making B impossible to cancel/pause.
    const { deleteFile } = await import("@/commands/fs")
    vi.mocked(deleteFile).mockReset()
    vi.mocked(deleteFile).mockResolvedValue(undefined)

    let resolveA: (files: string[]) => void = () => {}
    let resolveB: (files: string[]) => void = () => {}
    let bSignal: AbortSignal | undefined

    // A: controllable promise that captures the abort signal.
    mockAutoIngest.mockImplementationOnce(
      () => new Promise<string[]>((resolve) => { resolveA = resolve }),
    )
    // B: controllable promise that captures the abort signal.
    mockAutoIngest.mockImplementationOnce(
      (_pp: string, _src: string, _llm: unknown, signal?: AbortSignal) => {
        bSignal = signal
        return new Promise<string[]>((resolve) => { resolveB = resolve })
      },
    )

    await enqueueBatch(TEST_ID, [
      { sourcePath: "a.md", folderContext: "" },
      { sourcePath: "b.md", folderContext: "" },
    ])
    await flushMicrotasks(2)
    expect(getQueue().find((t) => t.sourcePath === "a.md")?.status).toBe("processing")

    // Cancel A: aborts A's signal, bumps run token, starts B.
    const cancelPromise = cancelTask(getQueue().find((t) => t.sourcePath === "a.md")!.id)
    // Resolve A late with partial files (abort guard path).
    resolveA(["wiki/concepts/partial-a.md"])
    await cancelPromise
    await flushMicrotasks(10)

    // B must now be processing.
    expect(getQueue().find((t) => t.sourcePath === "b.md")?.status).toBe("processing")
    expect(bSignal).toBeDefined()
    expect(bSignal!.aborted).toBe(false)

    // Now cancel B. If A's orphan clobbered currentAbortController, this
    // would be a no-op (controller is null) and B's signal would NOT be
    // aborted. If the guard works, B's signal gets aborted.
    await cancelTask(getQueue().find((t) => t.sourcePath === "b.md")!.id)
    await flushMicrotasks(5)

    expect(bSignal!.aborted).toBe(true)
    // Resolve B late — the abort guard should clean up and not register
    // as success.
    resolveB(["wiki/concepts/partial-b.md"])
    // Drain generously: two cleanupWrittenFiles cascades (from cancel-A's
    // orphan and cancel-B) each do dynamic imports + async deletes that
    // must fully settle before the next test's beforeEach, or their mock
    // calls leak across tests.
    await flushMicrotasks(60)
    await new Promise((r) => setTimeout(r, 0))
    expect(getQueueSummary().completed).toBe(0)
  })
})

// ── cleanupWrittenFiles — file delete + LanceDB chunk cascade ──────
describe("cleanupWrittenFiles — embedding cascade", () => {
  it("deletes each file AND drops its embedding chunks (relative paths)", async () => {
    const { deleteFile } = await import("@/commands/fs")
    const mockDeleteFile = vi.mocked(deleteFile)
    mockDeleteFile.mockReset()
    mockDeleteFile.mockResolvedValue(undefined)

    await cleanupWrittenFiles("/proj", [
      "wiki/concepts/rope.md",
      "wiki/entities/transformer.md",
    ])

    // File deletes use joined absolute paths.
    expect(mockDeleteFile).toHaveBeenCalledTimes(2)
    expect(mockDeleteFile).toHaveBeenNthCalledWith(1, "/proj/wiki/concepts/rope.md")
    expect(mockDeleteFile).toHaveBeenNthCalledWith(2, "/proj/wiki/entities/transformer.md")

    // Embedding cascade uses path-aware vector page ids.
    expect(removePageEmbeddingMock).toHaveBeenCalledTimes(2)
    expect(removePageEmbeddingMock).toHaveBeenNthCalledWith(
      1,
      "/proj",
      wikiRelativePathToVectorPageId("wiki/concepts/rope.md"),
    )
    expect(removePageEmbeddingMock).toHaveBeenNthCalledWith(
      2,
      "/proj",
      wikiRelativePathToVectorPageId("wiki/entities/transformer.md"),
    )
  })

  it("uses absolute paths verbatim and skips embeddings outside the project root", async () => {
    const { deleteFile } = await import("@/commands/fs")
    const mockDeleteFile = vi.mocked(deleteFile)
    mockDeleteFile.mockReset()
    mockDeleteFile.mockResolvedValue(undefined)

    await cleanupWrittenFiles("/proj", ["/abs/elsewhere/wiki/concepts/foo.md"])

    expect(mockDeleteFile).toHaveBeenCalledWith("/abs/elsewhere/wiki/concepts/foo.md")
    expect(removePageEmbeddingMock).not.toHaveBeenCalled()
  })

  it("continues to subsequent files when one delete throws", async () => {
    const { deleteFile } = await import("@/commands/fs")
    const mockDeleteFile = vi.mocked(deleteFile)
    mockDeleteFile.mockReset()
    // First file fails (e.g. already gone), second succeeds.
    mockDeleteFile
      .mockRejectedValueOnce(new Error("ENOENT"))
      .mockResolvedValueOnce(undefined)

    await cleanupWrittenFiles("/proj", [
      "wiki/concepts/missing.md",
      "wiki/concepts/present.md",
    ])

    // Both deleteFile attempts happened — the helper kept going.
    expect(mockDeleteFile).toHaveBeenCalledTimes(2)
    // First file's embedding cascade was skipped (deleteFile threw),
    // second file's cascade still ran.
    expect(removePageEmbeddingMock).toHaveBeenCalledTimes(1)
    expect(removePageEmbeddingMock).toHaveBeenCalledWith(
      "/proj",
      wikiRelativePathToVectorPageId("wiki/concepts/present.md"),
    )
  })

  it("swallows removePageEmbedding errors so a LanceDB issue doesn't abort cleanup", async () => {
    const { deleteFile } = await import("@/commands/fs")
    const mockDeleteFile = vi.mocked(deleteFile)
    mockDeleteFile.mockReset()
    mockDeleteFile.mockResolvedValue(undefined)

    // First page's embedding cascade throws; second succeeds.
    removePageEmbeddingMock
      .mockRejectedValueOnce(new Error("lancedb unavailable"))
      .mockResolvedValueOnce(undefined)

    await cleanupWrittenFiles("/proj", [
      "wiki/concepts/a.md",
      "wiki/concepts/b.md",
    ])

    // Both file deletes still happened.
    expect(mockDeleteFile).toHaveBeenCalledTimes(2)
    // Second cascade still attempted despite first throwing.
    expect(removePageEmbeddingMock).toHaveBeenCalledTimes(2)
  })

  it("handles Windows backslash paths via path-aware vector id", async () => {
    const { deleteFile } = await import("@/commands/fs")
    const mockDeleteFile = vi.mocked(deleteFile)
    mockDeleteFile.mockReset()
    mockDeleteFile.mockResolvedValue(undefined)

    // A path that's been rewritten with backslashes (Windows ingest
    // pipeline output before normalize). The cascade must still
    // derive the same path-aware vector id.
    await cleanupWrittenFiles("C:/proj", ["wiki\\concepts\\rope.md"])

    expect(removePageEmbeddingMock).toHaveBeenCalledWith(
      "C:/proj",
      wikiRelativePathToVectorPageId("wiki\\concepts\\rope.md"),
    )
  })
})

// ── saveQueue — error surfacing (P2-5) ──────────────────────────────
// saveQueue used to swallow ALL write errors silently. It now surfaces
// them to the activity panel (debounced) and logs to console. These
// tests drive it via enqueueIngest, which calls saveQueue on success.
describe("ingest-queue — saveQueue error surfacing", () => {
  beforeEach(async () => {
    // Clear any activity items carried over from prior tests so the
    // addItem assertions below start from a clean slate.
    const { useActivityStore } = await import("@/stores/activity-store")
    useActivityStore.setState({ items: [] })
  })

  it("surfaces a saveQueue write failure to the activity panel", async () => {
    const { useActivityStore } = await import("@/stores/activity-store")
    // Drive a successful ingest so processNext calls saveQueue, but make
    // writeFile reject to force the catch branch.
    mockAutoIngest.mockResolvedValue(["wiki/sources/foo.md"])
    mockWriteFile.mockRejectedValue(new Error("EACCES: permission denied"))

    await enqueueIngest(TEST_ID, "raw/sources/err.md")
    await flushMicrotasks(10)

    const errors = useActivityStore.getState().items.filter((i) => i.status === "error")
    expect(errors.length).toBeGreaterThanOrEqual(1)
    expect(errors[0].detail).toMatch(/Failed to save ingest queue/i)
    expect(errors[0].detail).toMatch(/permission denied/i)
  })

  it("debounces repeated saveQueue failures (one surface per window)", async () => {
    vi.useFakeTimers()
    try {
      const { useActivityStore } = await import("@/stores/activity-store")
      mockAutoIngest.mockResolvedValue(["wiki/sources/foo.md"])
      mockWriteFile.mockRejectedValue(new Error("ENOSPC: no space"))

      // Trigger several saveQueue calls in quick succession.
      await enqueueIngest(TEST_ID, "raw/sources/a.md")
      await flushMicrotasks(10)
      await enqueueIngest(TEST_ID, "raw/sources/b.md")
      await flushMicrotasks(10)
      await enqueueIngest(TEST_ID, "raw/sources/c.md")
      await flushMicrotasks(10)

      const errors = useActivityStore
        .getState()
        .items.filter((i) => i.status === "error" && /save ingest queue/i.test(i.detail))
      // All three enqueues happened within the debounce window, so only
      // ONE error item should have been added.
      expect(errors).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })
})
