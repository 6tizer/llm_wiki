import { useCallback, useState } from "react"
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
  const [fixingId, setFixingId] = useState<string | null>(null)
  const [fixingAll, setFixingAll] = useState(false)

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
    const pp = normalizePath(project.path)
    setFixingId(options.busyId ?? item.id)

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
  }, [llmConfig, project, refreshTree, removeLintItem])

  const fixAllLintItems = useCallback(async (
    options: FixAllLintItemsOptions = {},
  ): Promise<void> => {
    if (!project || fixingAll) return
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
  }, [fixingAll, items, llmConfig, project, refreshTree, setLintItems])

  return {
    fixingId,
    fixingAll,
    refreshTree,
    fixLintItem,
    fixAllLintItems,
  }
}
