import { useReviewStore } from "@/stores/review-store"
import { useLintStore } from "@/stores/lint-store"
import { useChatStore } from "@/stores/chat-store"
import { useWikiStore } from "@/stores/wiki-store"
import { useActivityStore } from "@/stores/activity-store"
import { saveReviewItems, saveLintItems, saveChatHistory } from "./persist"

type AutoSaveKind = "review" | "lint" | "chat"

/**
 * A pending debounced write. `generation` is the project generation token
 * (see wiki-store.projectGeneration) captured when this entry was queued;
 * `snapshot` is the data to write — captured at queue time, not re-read
 * from the live store when the timer fires or when flushed. Both guard
 * against the same failure mode: a project switch happening while this
 * entry is still sitting in its debounce window.
 */
interface AutoSaveEntry<Snapshot> {
  timer: ReturnType<typeof setTimeout>
  generation: number
  snapshot: Snapshot
}

/**
 * One save channel's state and behavior, type-erased to `unknown` so
 * flushAutoSave/cancelAutoSaveTimers can iterate all channels uniformly.
 * queueProjectAutoSave (called from setupAutoSave) still gets a fully
 * typed `timers` map per call site, so callers never see `unknown`.
 */
interface AutoSaveChannel {
  kind: AutoSaveKind
  timers: Map<string, AutoSaveEntry<unknown>>
  run: (projectPath: string, snapshot: unknown) => Promise<void>
}

const reviewTimers = new Map<string, AutoSaveEntry<ReturnType<typeof useReviewStore.getState>["items"]>>()
const lintTimers = new Map<string, AutoSaveEntry<ReturnType<typeof useLintStore.getState>["items"]>>()
interface ChatSnapshot {
  conversations: ReturnType<typeof useChatStore.getState>["conversations"]
  messages: ReturnType<typeof useChatStore.getState>["messages"]
}
const chatTimers = new Map<string, AutoSaveEntry<ChatSnapshot>>()

const saveErrorLastSeen = new Map<string, number>()
const SAVE_ERROR_DEBOUNCE_MS = 5000

function asUnknownEntryMap<Snapshot>(
  timers: Map<string, AutoSaveEntry<Snapshot>>
): Map<string, AutoSaveEntry<unknown>> {
  return timers as unknown as Map<string, AutoSaveEntry<unknown>>
}

const channels: AutoSaveChannel[] = [
  {
    kind: "review",
    timers: asUnknownEntryMap(reviewTimers),
    run: (projectPath, snapshot) => saveReviewItems(projectPath, snapshot as ReturnType<typeof useReviewStore.getState>["items"]),
  },
  {
    kind: "lint",
    timers: asUnknownEntryMap(lintTimers),
    run: (projectPath, snapshot) => saveLintItems(projectPath, snapshot as ReturnType<typeof useLintStore.getState>["items"]),
  },
  {
    kind: "chat",
    timers: asUnknownEntryMap(chatTimers),
    run: (projectPath, snapshot) => {
      const chatSnapshot = snapshot as ChatSnapshot
      return saveChatHistory(projectPath, chatSnapshot.conversations, chatSnapshot.messages)
    },
  },
]

function autoSaveKindLabel(kind: AutoSaveKind): string {
  if (kind === "review") return "Review"
  if (kind === "lint") return "Lint"
  return "Chat"
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function surfaceAutoSaveError(projectPath: string, kind: AutoSaveKind, err: unknown): void {
  const message = errorMessage(err)
  console.error(`[auto-save] ${kind} save failed for "${projectPath}": ${message}`)

  const throttleKey = `${projectPath}:${kind}`
  const now = Date.now()
  const lastSeen = saveErrorLastSeen.get(throttleKey)
  if (lastSeen !== undefined && now - lastSeen <= SAVE_ERROR_DEBOUNCE_MS) return
  saveErrorLastSeen.set(throttleKey, now)

  try {
    const label = autoSaveKindLabel(kind)
    useActivityStore.getState().addItem({
      type: "autosave",
      title: `${label} auto-save`,
      status: "error",
      detail: `Failed to auto-save ${label.toLowerCase()}: ${message}`,
      filesWritten: [],
    })
  } catch {
    // activity-store can be unavailable in headless tests; console.error
    // above still preserves the signal.
  }
}

function queueProjectAutoSave<Snapshot>(
  timers: Map<string, AutoSaveEntry<Snapshot>>,
  kind: AutoSaveKind,
  delayMs: number,
  snapshot: Snapshot,
  save: (projectPath: string, snapshot: Snapshot) => Promise<void>
): void {
  const projectPath = useWikiStore.getState().project?.path
  if (!projectPath) return

  const generation = useWikiStore.getState().projectGeneration

  const existing = timers.get(projectPath)
  if (existing) clearTimeout(existing.timer)

  const timer = setTimeout(() => {
    timers.delete(projectPath)
    // Guard against the project having switched between when this entry
    // was queued and when it fires. resetProjectState cancels timers for
    // the outgoing project synchronously, but this is the last line of
    // defense against any path that re-queues a write after that — and,
    // via the generation check, against the same project path being
    // closed and reopened (a plain path comparison would miss that).
    const current = useWikiStore.getState()
    if (current.project?.path !== projectPath || current.projectGeneration !== generation) {
      console.debug(
        `[auto-save] dropping stale ${kind} save for "${projectPath}" — project switched before the debounce fired`
      )
      return
    }
    save(projectPath, snapshot)
      .then(() => saveErrorLastSeen.delete(`${projectPath}:${kind}`))
      .catch((err) => surfaceAutoSaveError(projectPath, kind, err))
  }, delayMs)
  timers.set(projectPath, { timer, generation, snapshot })
}

/**
 * Immediately runs any pending debounced save for `projectPath` across all
 * three auto-save channels (review/lint/chat), bypassing the debounce
 * timer. Used by resetProjectState to flush the outgoing project's last
 * real edit to disk before its stores are cleared — otherwise that edit
 * would sit in a setTimeout that never fires with the right data (the
 * store it reads from is about to be reset to empty).
 *
 * Writes the snapshot captured when the entry was queued, not whatever
 * the live store holds at flush time — the two can differ (e.g. a
 * streaming chat update queued a snapshot, then more streaming content
 * landed in the live store before the flush ran).
 *
 * Only flushes timers that are actually pending for `projectPath`; other
 * projects' pending timers are left untouched.
 */
export async function flushAutoSave(projectPath: string): Promise<void> {
  const tasks: Promise<void>[] = []

  for (const channel of channels) {
    const entry = channel.timers.get(projectPath)
    if (!entry) continue
    clearTimeout(entry.timer)
    channel.timers.delete(projectPath)
    tasks.push(
      channel.run(projectPath, entry.snapshot)
        .then(() => { saveErrorLastSeen.delete(`${projectPath}:${channel.kind}`) })
        .catch((err) => surfaceAutoSaveError(projectPath, channel.kind, err))
    )
  }

  await Promise.allSettled(tasks)
}

/**
 * Cancels any pending debounced save timers for `projectPath` without
 * running them. Used by resetProjectState right after clearing the
 * Zustand stores: those clears look like real edits to auto-save's
 * subscribers and would otherwise re-queue an empty-array write for the
 * project that just left — this stops that write before it can fire.
 *
 * Only removes the entry for `projectPath`; other projects keep their
 * pending timers untouched.
 */
export function cancelAutoSaveTimers(projectPath: string): void {
  for (const channel of channels) {
    const entry = channel.timers.get(projectPath)
    if (!entry) continue
    clearTimeout(entry.timer)
    channel.timers.delete(projectPath)
  }
}

export function setupAutoSave(): void {
  // Auto-save review items (debounced 1s)
  useReviewStore.subscribe((state) => {
    queueProjectAutoSave(reviewTimers, "review", 1000, state.items, saveReviewItems)
  })

  // Auto-save lint items (debounced 1s)
  useLintStore.subscribe((state) => {
    queueProjectAutoSave(lintTimers, "lint", 1000, state.items, saveLintItems)
  })

  // Auto-save chat conversations and messages (debounced 2s, skip during streaming)
  useChatStore.subscribe((state) => {
    if (state.isStreaming) return
    queueProjectAutoSave(
      chatTimers,
      "chat",
      2000,
      { conversations: state.conversations, messages: state.messages },
      (projectPath, snapshot) => saveChatHistory(projectPath, snapshot.conversations, snapshot.messages)
    )
  })
}
