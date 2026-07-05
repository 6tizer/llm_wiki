import { create } from "zustand"
import { normalizeReviewTitle } from "@/lib/review-utils"

export interface ReviewOption {
  label: string
  action: string // identifier for the action
}

export interface ReviewItem {
  id: string
  type: "contradiction" | "duplicate" | "missing-page" | "confirm" | "suggestion" | "agent-write"
  title: string
  description: string
  sourcePath?: string
  affectedPages?: string[]
  searchQueries?: string[]
  agentWrite?: {
    path: string
    operation: "update" | "create" | "delete"
    conversationId: string
    messageId: string
    streamId: string
    toolUseId?: string
    snapshotted: boolean
    timestamp: number
  }
  options: ReviewOption[]
  resolved: boolean
  resolvedAction?: string
  createdAt: number
}

interface ReviewState {
  items: ReviewItem[]
  addItem: (item: Omit<ReviewItem, "id" | "resolved" | "createdAt">) => void
  addItems: (items: Omit<ReviewItem, "id" | "resolved" | "createdAt">[]) => void
  setItems: (items: ReviewItem[]) => void
  resolveItem: (id: string, action: string) => void
  dismissItem: (id: string) => void
  clearResolved: () => void
}

let counter = 0

const reviewIdPattern = /^review-(\d+)$/

export function resetReviewIdCounterForTest() {
  counter = 0
}

function syncCounterFromItems(items: ReviewItem[]) {
  for (const item of items) {
    const match = reviewIdPattern.exec(item.id)
    if (!match) continue
    counter = Math.max(counter, Number(match[1]))
  }
}

function nextReviewId(existingItems: ReviewItem[] = []) {
  const existingIds = new Set(existingItems.map((item) => item.id))
  let id = ""
  do {
    id = `review-${++counter}`
  } while (existingIds.has(id))
  return id
}

function ensureUniqueReviewIds(items: ReviewItem[]) {
  syncCounterFromItems(items)
  const usedIds = new Set<string>()
  const result: ReviewItem[] = []

  for (const item of items) {
    if (!usedIds.has(item.id)) {
      usedIds.add(item.id)
      result.push(item)
      continue
    }

    const nextId = nextReviewId(result)
    usedIds.add(nextId)
    result.push({ ...item, id: nextId })
  }

  return result
}

export const useReviewStore = create<ReviewState>((set) => ({
  items: [],

  addItem: (item) =>
    set((state) => ({
      items: [
        ...state.items,
        {
          ...item,
          id: nextReviewId(state.items),
          resolved: false,
          createdAt: Date.now(),
        },
      ],
    })),

  addItems: (items) =>
    set((state) => {
      // De-dupe against pending items with same type + normalized title (all
      // 5 types — bulk ingest can re-surface the same contradiction/confirm
      // from multiple files).
      // Merge affectedPages / searchQueries / sourcePath instead of duplicating.
      const result = [...state.items]
      const keyFor = (t: string, title: string) => `${t}::${normalizeReviewTitle(title)}`

      // Build index of existing pending items for fast lookup
      const pendingIndex = new Map<string, number>()
      result.forEach((it, idx) => {
        if (!it.resolved) {
          pendingIndex.set(keyFor(it.type, it.title), idx)
        }
      })

      for (const incoming of items) {
        const k = keyFor(incoming.type, incoming.title)
        const existingIdx = pendingIndex.get(k)

        if (existingIdx !== undefined) {
          // Merge into existing
          const old = result[existingIdx]
          const mergedPages = Array.from(new Set([...(old.affectedPages ?? []), ...(incoming.affectedPages ?? [])]))
          const mergedQueries = Array.from(new Set([...(old.searchQueries ?? []), ...(incoming.searchQueries ?? [])]))
          result[existingIdx] = {
            ...old,
            description: incoming.description || old.description, // prefer newer description
            sourcePath: incoming.sourcePath ?? old.sourcePath,
            affectedPages: mergedPages.length > 0 ? mergedPages : undefined,
            searchQueries: mergedQueries.length > 0 ? mergedQueries : undefined,
          }
        } else {
          const newItem = {
            ...incoming,
            id: nextReviewId(result),
            resolved: false,
            createdAt: Date.now(),
          }
          result.push(newItem)
          pendingIndex.set(k, result.length - 1)
        }
      }

      return { items: result }
    }),

  setItems: (items) => {
    set({ items: ensureUniqueReviewIds(items) })
  },

  resolveItem: (id, action) =>
    set((state) => ({
      items: state.items.map((item) =>
        item.id === id ? { ...item, resolved: true, resolvedAction: action } : item
      ),
    })),

  dismissItem: (id) =>
    set((state) => ({
      items: state.items.filter((item) => item.id !== id),
    })),

  clearResolved: () =>
    set((state) => ({
      items: state.items.filter((item) => !item.resolved),
    })),
}))
