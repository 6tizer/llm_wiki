import { useCallback, useEffect, useRef, useState } from "react"
import { useWikiStore } from "@/stores/wiki-store"
import { listDirectory } from "@/commands/fs"
import { normalizePath } from "@/lib/path-utils"
import { ChevronLeft, ChevronRight } from "lucide-react"
import { useTranslation } from "react-i18next"
import { IconSidebar } from "./icon-sidebar"
import { UpdateBanner } from "./update-banner"
import { SidebarPanel } from "./sidebar-panel"
import { ContentArea } from "./content-area"
import { PreviewPanel } from "./preview-panel"
import { ActivityPanel } from "./activity-panel"
import { ErrorBoundary } from "@/components/error-boundary"
import { getAppLayoutVisibility } from "./app-layout-visibility"

interface AppLayoutProps {
  onSwitchProject: () => void
}

export function AppLayout({ onSwitchProject }: AppLayoutProps) {
  const { t } = useTranslation()
  const project = useWikiStore((s) => s.project)
  const selectedFile = useWikiStore((s) => s.selectedFile)
  const activeView = useWikiStore((s) => s.activeView)
  const sidebarCollapsed = useWikiStore((s) => s.sidebarCollapsed)
  const setFileTree = useWikiStore((s) => s.setFileTree)
  const setSidebarCollapsed = useWikiStore((s) => s.setSidebarCollapsed)
  const [sidebarWidth, setSidebarWidth] = useState(220)
  const [rightWidth, setRightWidth] = useState(400)
  const isDraggingSidebar = useRef(false)
  const isDraggingRight = useRef(false)
  const containerRef = useRef<HTMLDivElement>(null)

  const loadFileTree = useCallback(async () => {
    if (!project) return
    try {
      const tree = await listDirectory(normalizePath(project.path))
      setFileTree(tree)
    } catch (err) {
      console.error("Failed to load file tree:", err)
    }
  }, [project, setFileTree])

  useEffect(() => {
    loadFileTree()
  }, [loadFileTree])

  const startDrag = useCallback(
    (side: "sidebar" | "right") => (e: React.MouseEvent) => {
      e.preventDefault()
      if (side === "sidebar") isDraggingSidebar.current = true
      else isDraggingRight.current = true
      const startX = e.clientX
      const startWidth = side === "sidebar" ? sidebarWidth : rightWidth
      document.body.style.cursor = "col-resize"
      document.body.style.userSelect = "none"
      document.body.dataset.panelResizing = "true"

      const handleMouseMove = (e: MouseEvent) => {
        if (!containerRef.current) return
        const rect = containerRef.current.getBoundingClientRect()
        const deltaX = e.clientX - startX

        if (isDraggingSidebar.current) {
          const newWidth = startWidth - deltaX
          // Right-edge sidebar is resized from its left handle: drag left widens.
          setSidebarWidth(Math.max(150, Math.min(400, newWidth)))
        }
        if (isDraggingRight.current) {
          const newWidth = startWidth - deltaX
          // Hard cap: 250 to 50% of container
          setRightWidth(Math.max(250, Math.min(rect.width * 0.5, newWidth)))
        }
      }

      const handleMouseUp = () => {
        isDraggingSidebar.current = false
        isDraggingRight.current = false
        document.body.style.cursor = ""
        document.body.style.userSelect = ""
        delete document.body.dataset.panelResizing
        document.removeEventListener("mousemove", handleMouseMove)
        document.removeEventListener("mouseup", handleMouseUp)
      }

      document.addEventListener("mousemove", handleMouseMove)
      document.addEventListener("mouseup", handleMouseUp)
    },
    [rightWidth, sidebarWidth]
  )

  const { showLeftPanel, hasRightPanel } = getAppLayoutVisibility(activeView, selectedFile)

  return (
    // Outer column layout: full-width update banner on top (when an
    // update is available AND not dismissed for this version), the
    // existing IconSidebar + content row below. Banner is shrink-0
    // so it doesn't compress the work area; main row is flex-1 so
    // it fills the rest of the viewport.
    <div className="flex h-screen flex-col bg-background text-foreground">
      <UpdateBanner />
      <div className="flex min-h-0 flex-1">
        <IconSidebar onSwitchProject={onSwitchProject} />
        <div ref={containerRef} className="flex min-w-0 flex-1 overflow-hidden">
          {/* Center: Chat or view (sources/settings/review) */}
          <div className="min-w-0 flex-1 overflow-hidden">
            <ErrorBoundary>
              <ContentArea />
            </ErrorBoundary>
          </div>

          {/* Right panels */}
          {hasRightPanel && (
            <>
              <div
                data-testid="preview-resize-handle"
                className="w-1.5 shrink-0 cursor-col-resize bg-border/40 transition-colors hover:bg-primary/30 active:bg-primary/40"
                onMouseDown={startDrag("right")}
              />
              <div
                data-testid="preview-panel-shell"
                className="flex shrink-0 flex-col overflow-hidden border-l"
                style={{ width: rightWidth }}
              >
                <ErrorBoundary>
                  <PreviewPanel />
                </ErrorBoundary>
              </div>
            </>
          )}

          {showLeftPanel && (
            sidebarCollapsed ? (
              <div
                data-testid="sidebar-collapsed-strip"
                className="flex w-9 shrink-0 flex-col items-center border-l bg-background"
              >
                <button
                  type="button"
                  title={t("sidebar.expand")}
                  aria-label={t("sidebar.expand")}
                  className="mt-2 rounded p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                  onClick={() => setSidebarCollapsed(false)}
                >
                  <ChevronLeft className="h-4 w-4" />
                </button>
              </div>
            ) : (
              <>
                <div
                  data-testid="sidebar-resize-handle"
                  className="w-1.5 shrink-0 cursor-col-resize bg-border/40 transition-colors hover:bg-primary/30 active:bg-primary/40"
                  onMouseDown={startDrag("sidebar")}
                />
                <div
                  data-testid="sidebar-panel-shell"
                  className="flex shrink-0 flex-col overflow-hidden border-l"
                  style={{ width: sidebarWidth }}
                >
                  <div className="flex h-8 shrink-0 items-center border-b px-2">
                    <button
                      type="button"
                      title={t("sidebar.collapse")}
                      aria-label={t("sidebar.collapse")}
                      className="ml-auto rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                      onClick={() => setSidebarCollapsed(true)}
                    >
                      <ChevronRight className="h-4 w-4" />
                    </button>
                  </div>
                  <div className="flex-1 overflow-hidden">
                    <SidebarPanel />
                  </div>
                  <ActivityPanel />
                </div>
              </>
            )
          )}
        </div>
      </div>
    </div>
  )
}
