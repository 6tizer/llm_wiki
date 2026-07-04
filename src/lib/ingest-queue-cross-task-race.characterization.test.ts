/**
 * SPEC-11 PR5 — cross-task concurrent-cancel regression test.
 *
 * Scenario: task A and task B both merge into the SAME wiki page. Task
 * A gets cancelled while its generation stage is still blocked
 * (orphaned, but still holding the per-project lock). Task B's
 * processNext starts immediately afterward, well before task A's
 * orphaned generation resolves late and writes its (soon-to-be-
 * cancelled) merge.
 *
 * This test caught TWO distinct bugs during PR5 hardening, both now
 * fixed:
 *
 *  1. `lastWrittenFileMeta` module-map reassignment: task B's
 *     processNext used to reset the shared module-level map before
 *     even attempting the project lock; task A's `onPageWritten`
 *     callback + abort-guard cleanup, via a live binding to that same
 *     module variable, could then read/write whatever map happened to
 *     be current at the time — not necessarily task A's own. Fixed by
 *     giving each `processNext` run its own closure-local `runMeta`
 *     (ingest-queue.ts).
 *
 *  2. TOCTOU on the page content itself: even with (1) fixed, task A's
 *     abort-guard cleanup runs in `ingest-queue.ts`, AFTER
 *     `autoIngest`'s per-project lock has already been released. If
 *     task B's own read-merge-write of the same page happened to land
 *     in the window between task A's write and task A's cleanup, task
 *     B would either incorporate task A's soon-to-be-cancelled
 *     contribution into its own output, or have its own legitimate
 *     write clobbered by task A's delayed restore. Fixed by adding a
 *     self-undo inside `autoIngestImpl` itself — while STILL holding
 *     the per-project lock — so an aborted run's writes are undone
 *     before any other task for the same project can ever observe
 *     them (see the `undoWrittenPage` call site in ingest.ts).
 *
 * Correct behavior: task A's cancelled contribution must never survive
 * in the final on-disk state, and task B's legitimate merge must land
 * intact — deterministically, not just "usually."
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { createTempProject, realFs, writeFileRaw, readFileRaw } from "@/test-helpers/fs-temp"
import { createDeferred, flushMicrotasks, waitFor, type Deferred } from "@/test-helpers/deferred"
import { vi } from "vitest"

vi.mock("@/commands/fs", () => realFs)

vi.mock("@/lib/embedding", () => ({
  embedPage: vi.fn(async () => {}),
  removePageEmbedding: vi.fn(async () => {}),
}))

const TEST_PROJECT_ID = "p1-race-probe-project"
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

let deferredA: Deferred<void> = createDeferred<void>()
let deferredB: Deferred<void> = createDeferred<void>()
let signalA: AbortSignal | undefined
let signalB: AbortSignal | undefined

function sourceSummaryBlock(sourceId: string): string {
  return [
    `---FILE: wiki/sources/placeholder-${sourceId.replace(/\W+/g, "-")}.md---`,
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

function sharedPageBlock(marker: string): string {
  return [
    "---FILE: wiki/concepts/shared-topic.md---",
    "---",
    "type: concept",
    'title: "Shared Topic"',
    "created: 2026-05-01",
    "updated: 2026-05-01",
    'sources: ["placeholder.md"]',
    "tags: []",
    "related: []",
    "---",
    "",
    "# Shared Topic",
    "",
    marker,
    "---END FILE---",
  ].join("\n")
}

vi.mock("./llm-client", () => ({
  streamChat: vi.fn(async (_cfg, messages, cb, signal) => {
    const systemPrompt = String(messages?.[0]?.content ?? "")
    const userPrompt = String(messages?.[1]?.content ?? "")

    if (systemPrompt.startsWith("You are a wiki maintainer")) {
      if (userPrompt.includes("doc-a.md")) {
        signalA = signal
        await deferredA.promise
        cb.onToken([sourceSummaryBlock("doc-a.md"), sharedPageBlock("Contribution from doc-a, task A.")].join("\n\n"))
        cb.onDone()
        return
      }
      if (userPrompt.includes("doc-b.md")) {
        signalB = signal
        await deferredB.promise
        cb.onToken([sourceSummaryBlock("doc-b.md"), sharedPageBlock("Contribution from doc-b, task B.")].join("\n\n"))
        cb.onDone()
        return
      }
    }

    if (systemPrompt.startsWith("You are merging two versions")) {
      // Match the "Newly generated version (from X)" heading
      // specifically — NOT a bare substring check for "doc-a.md",
      // which would false-positive once the EXISTING content (the
      // other version being merged against) already mentions doc-a.md
      // in its own `sources` frontmatter after task A's write lands.
      const mergingA = userPrompt.includes("Newly generated version (from doc-a.md)")
      const mergingB = userPrompt.includes("Newly generated version (from doc-b.md)")
      if (!mergingA && !mergingB) {
        throw new Error(`probe mock: could not determine which task's merge call this is:\n${userPrompt.slice(0, 400)}`)
      }
      cb.onToken(
        [
          "---",
          "type: concept",
          'title: "Shared Topic"',
          "created: 2020-01-01",
          "updated: 2020-01-01",
          'sources: ["seed.md"]',
          "tags: []",
          "related: []",
          "---",
          "",
          "# Shared Topic",
          "",
          mergingA ? "MERGED_RESULT_CONTAINS_TASK_A_CONTRIBUTION" : "MERGED_RESULT_CONTAINS_TASK_B_CONTRIBUTION",
          "This merged body is long enough to clear the body-shrink sanity threshold in page-merge.ts. ".repeat(4),
        ].join("\n"),
      )
      cb.onDone()
      return
    }

    // Analysis / review stages — generic, resolved immediately.
    cb.onToken("## Analysis\nProbe analysis.\n")
    cb.onDone()
  }),
}))

import { enqueueIngest, cancelTask, getQueue, clearQueueState, restoreQueue } from "./ingest-queue"
import { useWikiStore } from "@/stores/wiki-store"

interface Tmp {
  path: string
  cleanup: () => Promise<void>
}

beforeEach(() => {
  clearQueueState()
  deferredA = createDeferred<void>()
  deferredB = createDeferred<void>()
  signalA = undefined
  signalB = undefined
  activeProjectPath = ""
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

async function waitForDisk(predicate: () => Promise<boolean>, timeoutMs = 3000, intervalMs = 5): Promise<void> {
  const start = Date.now()
  for (;;) {
    if (await predicate()) return
    if (Date.now() - start >= timeoutMs) throw new Error("waitForDisk: predicate never became true")
    await new Promise<void>((r) => setTimeout(r, intervalMs))
  }
}

const ORIGINAL_CONTENT = [
  "---",
  "type: concept",
  'title: "Shared Topic"',
  "created: 2020-01-01",
  "updated: 2020-01-01",
  'sources: ["seed.md"]',
  "tags: []",
  "related: []",
  "---",
  "",
  "# Shared Topic",
  "",
  "ORIGINAL_PRE_EXISTING_CONTENT",
  "",
].join("\n")

describe("ingest-queue cross-task race — concurrent cancel on a shared page (PR5 D4/TOCTOU fix)", () => {
  it("task A's cancelled contribution must never survive after task B (same page) completes", async () => {
    const tmp = await seed("p1-probe")
    activeProjectPath = tmp.path
    const sharedPath = `${tmp.path}/wiki/concepts/shared-topic.md`
    await writeFileRaw(sharedPath, ORIGINAL_CONTENT)
    await writeFileRaw(
      `${tmp.path}/raw/sources/doc-a.md`,
      "Substantive content for task A, enough prose to avoid the low-quality guard and exercise a real merge into the shared page.",
    )
    await writeFileRaw(
      `${tmp.path}/raw/sources/doc-b.md`,
      "Substantive content for task B, enough prose to avoid the low-quality guard and exercise a real merge into the shared page.",
    )

    await restoreQueue(TEST_PROJECT_ID, tmp.path)
    const taskA = await enqueueIngest(TEST_PROJECT_ID, "raw/sources/doc-a.md")
    const taskB = await enqueueIngest(TEST_PROJECT_ID, "raw/sources/doc-b.md")

    await waitFor(() => getQueue().find((t) => t.id === taskA)?.status === "processing")
    await waitForDisk(async () => signalA !== undefined)

    await cancelTask(taskA)
    expect(signalA?.aborted).toBe(true)

    // Task B's processNext has now kicked off — this is the exact
    // point where, in the pre-fix code, the module-level map got reset
    // before task B could even attempt the project lock (task A's
    // orphaned generation still holds it).
    await waitFor(() => getQueue().find((t) => t.id === taskB)?.status === "processing")

    // Let task A's orphaned generation resolve LATE.
    deferredA.resolve()

    // Task A's write + cleanup now race task B's lock acquisition and
    // pipeline (schema/purpose reads, analysis). Let task B run all
    // the way to its own generation stage, then release it too — no
    // further artificial synchronization between A's cleanup and B's
    // write, deliberately, to let real interleaving occur.
    await waitForDisk(async () => signalB !== undefined)
    deferredB.resolve()

    // Terminal signal: queue fully drains once task B is done.
    await waitForDisk(async () => getQueue().length === 0, 5000)
    await flushMicrotasks(50)

    const finalContent = await readFileRaw(sharedPath)
    // The bug: task A's cancelled contribution non-deterministically
    // leaks into the final page (survives cleanup), potentially
    // clobbering task B's legitimate merge in the process.
    expect(finalContent).not.toContain("Contribution from doc-a")
    expect(finalContent).not.toContain("MERGED_RESULT_CONTAINS_TASK_A_CONTRIBUTION")
    // Task B's legitimate merge must have landed.
    expect(finalContent).toContain("MERGED_RESULT_CONTAINS_TASK_B_CONTRIBUTION")
  })
})
