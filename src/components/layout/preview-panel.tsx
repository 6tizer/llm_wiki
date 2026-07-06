import { useEffect, useCallback, useRef } from "react"
import { X } from "lucide-react"
import { useTranslation } from "react-i18next"
import { useWikiStore } from "@/stores/wiki-store"
import { useActivityStore } from "@/stores/activity-store"
import { readFile, writeFile } from "@/commands/fs"
import { getFileCategory, isBinary } from "@/lib/file-types"
import { WikiEditor } from "@/components/editor/wiki-editor"
import { FilePreview } from "@/components/editor/file-preview"
import { getFileName } from "@/lib/path-utils"

/**
 * Per-file debounced-save bookkeeping. This component is mounted once for
 * the lifetime of the app (app-layout.tsx) and never remounts on file (or
 * project) switch, so a single-entry ref keyed by absolute file path — not
 * a single shared ref — is required: otherwise a pending debounce timer or
 * "last loaded from disk" snapshot for one file leaks into another file
 * (or another project, since paths are absolute) that gets selected while
 * the timer is still pending.
 */
interface FileSaveEntry {
  timer: ReturnType<typeof setTimeout> | null
  /**
   * Snapshot of what was most recently loaded from (or written to) disk
   * for this file. Milkdown re-emits `markdownUpdated` on initial parse
   * (before the user types anything), which used to trigger an auto-save
   * that could write back a placeholder marker if read_file had returned
   * one for a missing/locked file. We skip save when the incoming
   * markdown equals this snapshot.
   */
  lastLoaded: string
  /** Content queued for the pending debounce timer, if any. */
  pendingSnapshot: string | null
}

export function PreviewPanel() {
  const { t } = useTranslation()
  const selectedFile = useWikiStore((s) => s.selectedFile)
  const fileContent = useWikiStore((s) => s.fileContent)
  const externalPreview = useWikiStore((s) => s.externalPreview)
  const setFileContent = useWikiStore((s) => s.setFileContent)
  const setSelectedFile = useWikiStore((s) => s.setSelectedFile)
  const fileEntriesRef = useRef<Map<string, FileSaveEntry>>(new Map())

  const getEntry = useCallback((path: string): FileSaveEntry => {
    let entry = fileEntriesRef.current.get(path)
    if (!entry) {
      entry = { timer: null, lastLoaded: "", pendingSnapshot: null }
      fileEntriesRef.current.set(path, entry)
    }
    return entry
  }, [])

  const writeNow = useCallback((path: string, markdown: string, syncStore: boolean) => {
    writeFile(path, markdown)
      .then(() => {
        getEntry(path).lastLoaded = markdown
        // Only push the write into the display store if this file is
        // still the one on screen — writeFile is async, and the user may
        // have switched to a different file while it was in flight. Doing
        // this unconditionally is what let a delayed write for file A
        // clobber file B's already-loaded content.
        if (syncStore && useWikiStore.getState().selectedFile === path) {
          setFileContent(markdown)
        }
      })
      .catch((err) => {
        const message = err instanceof Error ? err.message : String(err)
        useActivityStore.getState().addItem({
          type: "autosave",
          title: "File auto-save",
          status: "error",
          detail: `Failed to save "${getFileName(path)}": ${message}`,
          filesWritten: [],
        })
      })
  }, [getEntry, setFileContent])

  useEffect(() => {
    const path = selectedFile

    if (!path) {
      setFileContent("")
    } else if (externalPreview?.path === path) {
      getEntry(path).lastLoaded = fileContent
    } else {
      const category = getFileCategory(path)
      if (isBinary(category)) {
        setFileContent("")
        getEntry(path).lastLoaded = ""
      } else {
        readFile(path)
          .then((content) => {
            getEntry(path).lastLoaded = content
            // Guard against a stale readFile resolving after the user has
            // already switched to a different file (same pattern as
            // writeNow below) — without this, a slow load for a file the
            // user navigated away from can clobber the currently
            // displayed file's content when it finally resolves.
            if (useWikiStore.getState().selectedFile === path) {
              setFileContent(content)
            }
          })
          .catch((err) => {
            getEntry(path).lastLoaded = ""
            if (useWikiStore.getState().selectedFile === path) {
              setFileContent(`Error loading file: ${err}`)
            }
          })
      }
    }

    // Flush — not just cancel — any pending debounced write for the file
    // we are navigating away from. This runs before the effect body above
    // executes for the newly selected file (React runs the previous
    // render's cleanup before the next render's effect), so the outgoing
    // file's last edit reaches disk before anything else touches the
    // shared fileContent/selectedFile store. A plain clearTimeout here
    // (the old behavior) silently dropped that edit.
    return () => {
      if (!path) return
      const entry = fileEntriesRef.current.get(path)
      if (!entry?.timer) return
      clearTimeout(entry.timer)
      entry.timer = null
      const snapshot = entry.pendingSnapshot
      entry.pendingSnapshot = null
      // syncStore=true: writeNow's own selectedFile===path guard decides
      // whether to push this flushed write into the display store. If the
      // user has quickly switched back to this file before the write
      // resolves, the guard is true and the flushed content correctly
      // syncs the display; if they're still elsewhere, the guard is false
      // and nothing is clobbered.
      if (snapshot !== null) writeNow(path, snapshot, true)
    }
  }, [selectedFile, setFileContent, getEntry, writeNow])

  const handleSave = useCallback(
    (markdown: string, options?: { immediate?: boolean }) => {
      if (!selectedFile) return
      const path = selectedFile
      const entry = getEntry(path)
      // Ignore no-op saves from the editor's initial re-emit. Only write
      // when the user has actually changed the content relative to the
      // last disk read.
      if (markdown === entry.lastLoaded) return
      if (entry.timer) clearTimeout(entry.timer)
      entry.pendingSnapshot = null
      if (options?.immediate) {
        writeNow(path, markdown, true)
        return
      }
      entry.pendingSnapshot = markdown
      entry.timer = setTimeout(() => {
        entry.timer = null
        entry.pendingSnapshot = null
        writeNow(path, markdown, true)
      }, 1000)
    },
    [selectedFile, getEntry, writeNow]
  )

  if (!selectedFile) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        Select a file to preview
      </div>
    )
  }

  const category = getFileCategory(selectedFile)
  const fileName = externalPreview?.path === selectedFile
    ? externalPreview.title
    : getFileName(selectedFile)

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b px-3 py-1.5">
        <span className="truncate text-xs text-muted-foreground" title={selectedFile}>
          {fileName}
        </span>
        <button
          type="button"
          aria-label={t("common.close")}
          onClick={() => setSelectedFile(null)}
          className="-m-0.5 shrink-0 rounded p-1.5 text-muted-foreground hover:bg-accent"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="flex-1 min-w-0 overflow-auto">
        {externalPreview?.path === selectedFile ? (
          <ExternalReferencePreview
            source={externalPreview.source}
            title={externalPreview.title}
            path={externalPreview.url}
            snippet={externalPreview.snippet || fileContent}
          />
        ) : category === "markdown" ? (
          <WikiEditor
            key={selectedFile}
            content={fileContent}
            onSave={handleSave}
          />
        ) : (
          <FilePreview
            key={selectedFile}
            filePath={selectedFile}
            textContent={fileContent}
          />
        )}
      </div>
    </div>
  )
}

function ExternalReferencePreview({
  source,
  title,
  path,
  snippet,
}: {
  source: string
  title: string
  path: string
  snippet: string
}) {
  return (
    <div className="flex h-full flex-col overflow-auto p-6">
      <div className="mb-4 space-y-2">
        <div className="flex items-center gap-2">
          <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase text-muted-foreground">
            {source}
          </span>
          <h3 className="truncate text-sm font-medium" title={title}>{title}</h3>
        </div>
        <div className="break-all rounded-md border border-border/60 bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
          {path}
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-auto rounded-lg border border-border/60 bg-background p-4">
        <pre className="whitespace-pre-wrap break-words font-sans text-sm leading-6">
          {snippet || "(No preview fragment returned.)"}
        </pre>
      </div>
    </div>
  )
}
