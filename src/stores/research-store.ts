import { create } from "zustand"
import type { WebSearchResult } from "@/lib/web-search"

export interface ResearchTask {
  id: string
  projectPath: string
  topic: string
  searchQueries?: string[]
  status: "queued" | "searching" | "synthesizing" | "saving" | "done" | "error"
  webResults: WebSearchResult[]
  sourceErrors?: string[]
  synthesis: string
  savedPath: string | null
  error: string | null
  createdAt: number
}

interface ResearchState {
  tasks: ResearchTask[]
  maxConcurrent: number

  addTask: (topic: string, projectPath: string) => string
  updateTask: (id: string, updates: Partial<ResearchTask>) => void
  removeTask: (id: string) => void
  /** Active includes queued tasks; drives UI badges. */
  getActiveResearchCount: (projectPath: string) => number
  /** Running excludes queued tasks; drives the concurrency gate. */
  getRunningCount: (projectPath: string) => number
  getNextQueued: (projectPath: string) => ResearchTask | undefined
}

let counter = 0

export const useResearchStore = create<ResearchState>((set, get) => ({
  tasks: [],
  maxConcurrent: 3,

  addTask: (topic, projectPath) => {
    const id = `research-${++counter}`
    set((state) => ({
      tasks: [
        ...state.tasks,
        {
          id,
          projectPath,
          topic,
          status: "queued",
          webResults: [],
          synthesis: "",
          savedPath: null,
          error: null,
          createdAt: Date.now(),
        },
      ],
    }))
    return id
  },

  updateTask: (id, updates) =>
    set((state) => ({
      tasks: state.tasks.map((t) => (t.id === id ? { ...t, ...updates } : t)),
    })),

  removeTask: (id) =>
    set((state) => ({
      tasks: state.tasks.filter((t) => t.id !== id),
    })),

  getActiveResearchCount: (projectPath) => {
    const { tasks } = get()
    return tasks.filter((t) =>
      t.projectPath === projectPath &&
      t.status !== "done" &&
      t.status !== "error"
    ).length
  },

  getRunningCount: (projectPath) => {
    const { tasks } = get()
    return tasks.filter((t) =>
      t.projectPath === projectPath &&
      (t.status === "searching" || t.status === "synthesizing" || t.status === "saving")
    ).length
  },

  getNextQueued: (projectPath) => {
    const { tasks } = get()
    return tasks.find((t) =>
      t.status === "queued" &&
      t.projectPath === projectPath
    )
  },
}))
