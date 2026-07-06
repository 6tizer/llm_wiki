import { useCallback } from "react"
import { create } from "zustand"
import { listDirectory } from "@/commands/fs"
import { fixAllLintResults, fixLintResult, isFixable } from "@/lib/lint-fixer"
import { lintFixMutex } from "@/lib/lint-fix-mutex"
import { normalizePath } from "@/lib/path-utils"
import { useLintStore, type LintItem } from "@/stores/lint-store"
import { useWikiStore } from "@/stores/wiki-store"

interface FixLintItemOptions {
  busyId?: string
  errorLabel?: string
}

interface FixAllLintItemsOptions {
  errorLabel?: string
}

interface LintFixActionState {
  fixingId: string | null
  fixingAll: boolean
  setFixingId: (fixingId: string | null) => void
  setFixingAll: (fixingAll: boolean) => void
}

export const useLintFixActionStore = create<LintFixActionState>((set) => ({
  fixingId: null,
  fixingAll: false,
  setFixingId: (fixingId) => set({ fixingId }),
  setFixingAll: (fixingAll) => set({ fixingAll }),
}))

/**
 * Shared auto-fix actions for LintView and Wiki Health Dashboard.
 */
export function useLintFixActions() {
  const project = useWikiStore((state) => state.project)
  const llmConfig = useWikiStore((state) => state.llmConfig)
  const setFileTree = useWikiStore((state) => state.setFileTree)
  const bumpDataVersion = useWikiStore((state) => state.bumpDataVersion)
  const items = useLintStore((state) => state.items)
  const removeLintItem = useLintStore((state) => state.removeItem)
  const setLintItems = useLintStore((state) => state.setItems)
  const fixingId = useLintFixActionStore((state) => state.fixingId)
  const fixingAll = useLintFixActionStore((state) => state.fixingAll)
  const setFixingId = useLintFixActionStore((state) => state.setFixingId)
  const setFixingAll = useLintFixActionStore((state) => state.setFixingAll)

  const refreshTree = useCallback(async () => {
    if (!project) return
    try {
      const tree = await listDirectory(project.path)
      setFileTree(tree)
      bumpDataVersion()
    } catch {
      // Best-effort UI refresh after existing fixer actions.
    }
  }, [bumpDataVersion, project, setFileTree])

  const fixLintItem = useCallback(async (
    item: LintItem,
    options: FixLintItemOptions = {},
  ): Promise<boolean> => {
    if (!project || !isFixable(item)) return false
    const busyId = options.busyId ?? item.id
    const currentBusy = useLintFixActionStore.getState()
    if (currentBusy.fixingAll || currentBusy.fixingId === busyId) return false
    const pp = normalizePath(project.path)
    setFixingId(busyId)

    const release = await lintFixMutex.acquire()
    try {
      const ok = await fixLintResult(pp, item, llmConfig)
      if (ok) {
        removeLintItem(item.id)
        await refreshTree()
      }
      return ok
    } catch (err) {
      console.error(options.errorLabel ?? "Auto fix failed:", err)
      return false
    } finally {
      release()
      setFixingId(null)
    }
  }, [llmConfig, project, refreshTree, removeLintItem, setFixingId])

  const fixAllLintItems = useCallback(async (
    options: FixAllLintItemsOptions = {},
  ): Promise<void> => {
    if (!project || useLintFixActionStore.getState().fixingAll) return
    const pp = normalizePath(project.path)
    setFixingAll(true)

    const release = await lintFixMutex.acquire()
    try {
      const fixableItems = items.filter(isFixable)
      const { fixed } = await fixAllLintResults(pp, fixableItems, llmConfig)
      if (fixed.length > 0) {
        const fixedPages = new Set(fixed.map((result) => `${result.type}:${result.page}`))
        setLintItems(items.filter((item) => !fixedPages.has(`${item.type}:${item.page}`)))
        await refreshTree()
      }
    } catch (err) {
      console.error(options.errorLabel ?? "Fix all failed:", err)
    } finally {
      release()
      setFixingAll(false)
    }
  }, [items, llmConfig, project, refreshTree, setFixingAll, setLintItems])

  return {
    fixingId,
    fixingAll,
    refreshTree,
    fixLintItem,
    fixAllLintItems,
  }
}
