import { useReviewStore } from "@/stores/review-store"
import { useLintStore } from "@/stores/lint-store"
import { useChatStore } from "@/stores/chat-store"
import { useWikiStore } from "@/stores/wiki-store"
import { saveReviewItems, saveLintItems, saveChatHistory } from "./persist"

const reviewTimers = new Map<string, ReturnType<typeof setTimeout>>()
const lintTimers = new Map<string, ReturnType<typeof setTimeout>>()
const chatTimers = new Map<string, ReturnType<typeof setTimeout>>()

function queueProjectAutoSave<Snapshot>(
  timers: Map<string, ReturnType<typeof setTimeout>>,
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
    save(projectPath, snapshot).catch(() => {})
  }, delayMs)
  timers.set(projectPath, timer)
}

export function setupAutoSave(): void {
  // Auto-save review items (debounced 1s)
  useReviewStore.subscribe((state) => {
    queueProjectAutoSave(reviewTimers, 1000, state.items, saveReviewItems)
  })

  // Auto-save lint items (debounced 1s)
  useLintStore.subscribe((state) => {
    queueProjectAutoSave(lintTimers, 1000, state.items, saveLintItems)
  })

  // Auto-save chat conversations and messages (debounced 2s, skip during streaming)
  useChatStore.subscribe((state) => {
    if (state.isStreaming) return
    queueProjectAutoSave(
      chatTimers,
      2000,
      { conversations: state.conversations, messages: state.messages },
      (projectPath, snapshot) => saveChatHistory(projectPath, snapshot.conversations, snapshot.messages)
    )
  })
}
