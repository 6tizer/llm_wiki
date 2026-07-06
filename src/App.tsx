import { useState, useEffect } from "react"
import { useWikiStore } from "@/stores/wiki-store"
import { BASE_FONT_SIZE_PX, useZoomStore } from "@/stores/zoom-store"
import { runInitConfigHydration } from "@/lib/bootstrap/init-config-hydration"
import { useAppMountServices } from "@/lib/hooks/use-app-mount-services"
import { useProjectLifecycle } from "@/lib/hooks/use-project-lifecycle"
import { useUpdateCheckBootstrap } from "@/lib/hooks/use-update-check-bootstrap"
import { UPDATE_REPO } from "@/lib/update-check"
import { AppLayout } from "@/components/layout/app-layout"
import { WelcomeScreen } from "@/components/project/welcome-screen"
import { CreateProjectDialog } from "@/components/project/create-project-dialog"

/** Apply app zoom through the root font size so pointer coordinates stay native. */
export function applyDocumentZoom(level: number): void {
  document.documentElement.style.fontSize = `${BASE_FONT_SIZE_PX * level}px`
}

function App() {
  const project = useWikiStore((s) => s.project)
  const zoomLevel = useZoomStore((s) => s.level)
  const [showCreateDialog, setShowCreateDialog] = useState(false)
  const [loading, setLoading] = useState(true)
  const {
    projectOpsBusy,
    handleProjectOpened,
    handleSwitchProject,
    handleSelectRecent,
    handleOpenProject,
    handleProjectCreated,
  } = useProjectLifecycle()

  useAppMountServices()

  useEffect(() => {
    applyDocumentZoom(zoomLevel)
  }, [zoomLevel])

  // Dev-only helper for visually testing the update-banner UX.
  // Open dev tools and run:
  //   __llmwiki_testUpdateBanner()
  // to inject a fake "available" result into the update store —
  // banner appears at the top + red dot lights up the gear icon.
  // Run again with arg `false` (or call setDismissed via the store)
  // to clear. Gated on `import.meta.env.DEV` so the helper never
  // ships in production builds.
  useEffect(() => {
    if (!import.meta.env.DEV) return
    ;(async () => {
      const storeMod = await import("@/stores/update-store")
      const { useUpdateStore } = storeMod
      // Expose the live store getter on window so you can inspect
      // state from devtools when debugging banner behavior.
      ;(window as unknown as { __llmwiki_updateStore?: typeof useUpdateStore }).__llmwiki_updateStore = useUpdateStore
      ;(window as unknown as { __llmwiki_testUpdateBanner?: (clear?: boolean) => void }).__llmwiki_testUpdateBanner = (clear = false) => {
        if (clear) {
          useUpdateStore.getState().setResult(
            { kind: "up-to-date", local: __APP_VERSION__, remote: __APP_VERSION__ },
            Date.now(),
          )
          useUpdateStore.getState().setDismissed(null)
          console.log("[test] update banner cleared")
          return
        }
        useUpdateStore.getState().setResult(
          {
            kind: "available",
            local: __APP_VERSION__,
            remote: "v999.0.0",
            release: {
              name: "v999.0.0 (test)",
              tag_name: "v999.0.0",
              body:
                "Test release for banner-UX verification.\n\n" +
                "- Bigger red dot on the Settings icon\n" +
                "- Top banner with one-click dismiss\n" +
                "- Once dismissed, won't reappear for this version",
              html_url: `https://github.com/${UPDATE_REPO}/releases`,
              published_at: new Date().toISOString(),
            },
          },
          Date.now(),
        )
        useUpdateStore.getState().setDismissed(null)
        console.log(
          "[test] update banner injected. Run __llmwiki_testUpdateBanner(true) to clear.",
        )
      }
    })()
  }, [])

  // Dev-only QA fixture registry.
  // Open dev tools and run:
  //   __llmwiki_fixtures.agent("permission")
  // Scenarios:
  //   permission, profileUnavailable, modelRejected, resourceLimit, compact,
  //   timeline, pendingCorrection, activeRewind, doneRewind, rewindLocked,
  //   rewindCrossFork, rewindWikiWrite, agentWriteReview
  // rewindLocked leaves the conversation lock engaged (composer disabled);
  // running any other fixture scenario clears it.
  // to inject SPEC-7 Agent QA states through real store actions.
  // Fixture shell owner=SPEC-8; Agent scenarios owner=SPEC-7.
  useEffect(() => {
    if (!import.meta.env.DEV) return
    ;(async () => {
      await import("@/lib/agent-dev-fixtures")
    })()
  }, [])

  useUpdateCheckBootstrap()

  // Auto-open last project on startup. Each load is its own isolated
  // step: previously one big try/catch wrapped all of them, so a single
  // failing load (e.g. a corrupted settings key) silently skipped every
  // step after it — INCLUDING re-opening the last project, even though
  // that step has no dependency on the ones before it. Isolating each
  // step means a bad zoom-level read no longer costs the user their
  // last-open project on the next launch.
  useEffect(() => {
    void runInitConfigHydration({
      handleProjectOpened,
      onDone: () => setLoading(false),
    })
  }, [])

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center bg-background text-muted-foreground">
        Loading...
      </div>
    )
  }

  if (!project) {
    return (
      <>
        <WelcomeScreen
          onCreateProject={() => setShowCreateDialog(true)}
          onOpenProject={handleOpenProject}
          onSelectProject={handleSelectRecent}
          disabled={projectOpsBusy}
        />
        <CreateProjectDialog
          open={showCreateDialog}
          onOpenChange={setShowCreateDialog}
          onCreated={handleProjectCreated}
        />
      </>
    )
  }

  return (
    <>
      <AppLayout onSwitchProject={handleSwitchProject} />
      <CreateProjectDialog
        open={showCreateDialog}
        onOpenChange={setShowCreateDialog}
        onCreated={handleProjectCreated}
      />
    </>
  )
}

export default App
