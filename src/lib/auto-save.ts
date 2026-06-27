import { useReviewStore } from "@/stores/review-store"
import { useLintStore } from "@/stores/lint-store"
import { useChatStore } from "@/stores/chat-store"
import { useWikiStore } from "@/stores/wiki-store"
import { useActivityStore } from "@/stores/activity-store"
import { saveReviewItems, saveLintItems, saveChatHistory } from "./persist"

const reviewTimers = new Map<string, ReturnType<typeof setTimeout>>()
const lintTimers = new Map<string, ReturnType<typeof setTimeout>>()
const chatTimers = new Map<string, ReturnType<typeof setTimeout>>()
const saveErrorLastSeen = new Map<string, number>()
const SAVE_ERROR_DEBOUNCE_MS = 5000

type AutoSaveKind = "review" | "lint" | "chat"

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
  timers: Map<string, ReturnType<typeof setTimeout>>,
  kind: AutoSaveKind,
  delayMs: number,
  snapshot: Snapshot,
  save: (projectPath: string, snapshot: Snapshot) => Promise<void>
): void {
  const projectPath = useWikiStore.getState().project?.path
  if (!projectPath) return

  const existingTimer = timers.get(projectPath)
  if (existingTimer) clearTimeout(existingTimer)

  const timer = setTimeout(() => {
    timers.delete(projectPath)
    save(projectPath, snapshot)
      .then(() => saveErrorLastSeen.delete(`${projectPath}:${kind}`))
      .catch((err) => surfaceAutoSaveError(projectPath, kind, err))
  }, delayMs)
  timers.set(projectPath, timer)
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
