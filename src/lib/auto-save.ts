import { useReviewStore } from "@/stores/review-store"
import { useLintStore } from "@/stores/lint-store"
import { useChatStore } from "@/stores/chat-store"
import { useWikiStore } from "@/stores/wiki-store"
import { saveReviewItems, saveLintItems, saveChatHistory } from "./persist"

const reviewTimers = new Map<string, ReturnType<typeof setTimeout>>()
const lintTimers = new Map<string, ReturnType<typeof setTimeout>>()
const chatTimers = new Map<string, ReturnType<typeof setTimeout>>()

export function setupAutoSave(): void {
  // Auto-save review items (debounced 1s)
  useReviewStore.subscribe((state) => {
    const projectPath = useWikiStore.getState().project?.path
    if (!projectPath) return

    const existingTimer = reviewTimers.get(projectPath)
    if (existingTimer) clearTimeout(existingTimer)

    const timer = setTimeout(() => {
      reviewTimers.delete(projectPath)
      saveReviewItems(projectPath, state.items).catch(() => {})
    }, 1000)
    reviewTimers.set(projectPath, timer)
  })

  // Auto-save lint items (debounced 1s)
  useLintStore.subscribe((state) => {
    const projectPath = useWikiStore.getState().project?.path
    if (!projectPath) return

    const existingTimer = lintTimers.get(projectPath)
    if (existingTimer) clearTimeout(existingTimer)

    const timer = setTimeout(() => {
      lintTimers.delete(projectPath)
      saveLintItems(projectPath, state.items).catch(() => {})
    }, 1000)
    lintTimers.set(projectPath, timer)
  })

  // Auto-save chat conversations and messages (debounced 2s, skip during streaming)
  useChatStore.subscribe((state) => {
    if (state.isStreaming) return
    const projectPath = useWikiStore.getState().project?.path
    if (!projectPath) return

    const existingTimer = chatTimers.get(projectPath)
    if (existingTimer) clearTimeout(existingTimer)

    const timer = setTimeout(() => {
      chatTimers.delete(projectPath)
      saveChatHistory(projectPath, state.conversations, state.messages).catch(() => {})
    }, 2000)
    chatTimers.set(projectPath, timer)
  })
}
