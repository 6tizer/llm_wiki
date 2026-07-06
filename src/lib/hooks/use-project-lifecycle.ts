import { useRef, useState } from "react"
import { open } from "@tauri-apps/plugin-dialog"
import { listDirectory, openProject } from "@/commands/fs"
import { useAgentSettingsStore } from "@/stores/agent-settings-store"
import { useChatStore } from "@/stores/chat-store"
import { useLintStore } from "@/stores/lint-store"
import { useReviewStore } from "@/stores/review-store"
import { useWikiStore } from "@/stores/wiki-store"
import {
  getRecentProjects,
  loadOutputLanguage,
  loadScheduledImportConfig,
  loadSourceWatchConfig,
  saveLastProject,
  saveScheduledImportConfig,
} from "@/lib/project-store"
import { loadAgentResourceConfig } from "@/lib/agent/agent-settings"
import {
  cleanExpiredAgentSessions,
  loadChatHistory,
  loadLintItems,
  loadReviewItems,
} from "@/lib/persist"
import { CLIP_SERVER_BASE_URL } from "@/lib/clip-server-constants"
import { createSerialQueue } from "@/lib/serial-queue"
import type { WikiProject } from "@/types/wiki"

export type ProjectLifecycleHandlers = {
  projectOpsBusy: boolean
  handleProjectOpened: (proj: WikiProject) => Promise<void>
  handleSwitchProject: () => Promise<void>
  handleSelectRecent: (proj: WikiProject) => Promise<void>
  handleOpenProject: () => Promise<void>
  handleProjectCreated: (proj: WikiProject) => Promise<void>
}

/**
 * Coordinates project open/switch lifecycles and keeps each App instance's
 * concurrency guards isolated.
 */
export function useProjectLifecycle(): ProjectLifecycleHandlers {
  const setProject = useWikiStore((s) => s.setProject)
  const setFileTree = useWikiStore((s) => s.setFileTree)
  const setSelectedFile = useWikiStore((s) => s.setSelectedFile)
  const setActiveView = useWikiStore((s) => s.setActiveView)
  // UI-facing "an open is in flight" flag. This drives disabled states
  // only; correctness comes from `openQueueRef` and `openSeqRef` below.
  const [projectOpsBusy, setProjectOpsBusy] = useState(false)
  // Synchronous, always-current copy of the UI busy state. It is not
  // the project-open mutex: accepted opens may still enter while this
  // is true and then serialize through `openQueueRef`. We only use it
  // for UI affordance plus narrow duplicate-click suppression.
  const busyRef = useRef(false)
  const busyOpenCountRef = useRef(0)
  const sameTickDuplicateWindowRef = useRef(false)
  const acceptedOpenKeysRef = useRef(new Set<string>())
  // Bumped when an open is accepted/enqueued, not when its queued body
  // starts. That lets an older in-flight body observe that a newer open
  // has already superseded it and bail at the next checkpoint.
  const openSeqRef = useRef(0)
  // The correctness backstop: every handleProjectOpened call's body
  // runs through this FIFO queue (see src/lib/serial-queue.ts), so a
  // call's body only starts once every call enqueued before it has
  // fully settled — two opens' side effects can never interleave no
  // matter what calls handleProjectOpened or when. This matters beyond
  // the setters visible in this file: resetProjectState() unconditionally
  // clears the review/lint/chat stores, and auto-save persists whatever
  // is currently in those stores to the active project's disk files. If
  // two opens' bodies ever DID interleave, a slow one's resetProjectState()
  // could finish after a newer one had already loaded real data — wiping
  // that data in memory, with auto-save then writing the resulting empty
  // arrays to the NEWER project's own files. Per-step `isStale()` checks
  // inside handleProjectOpened cannot catch that on their own: the damage
  // would happen INSIDE resetProjectState, before this function's own
  // checkpoints run.
  const openQueueRef = useRef(createSerialQueue())

  async function handleProjectOpened(proj: WikiProject) {
    // handleSelectRecent / handleOpenProject / CreateProjectDialog.onCreated
    // (via handleProjectCreated) / init's auto-open of the last project can
    // all reach this function. `seq` is bumped immediately (call order, not
    // execution order) so `isStale()` can short-circuit wasted work once a
    // newer call is known to exist; see the comment on `openSeqRef` above
    // for why that's an optimization and not the correctness mechanism.
    const seq = ++openSeqRef.current
    const isStale = () => seq !== openSeqRef.current

    // The entire pipeline below runs inside `run`, which is queued behind
    // `openQueueRef` — see the comment on that ref above for why. Errors
    // still propagate to THIS call's own caller (handleSelectRecent's
    // try/catch etc.) via the returned promise; only the queue's internal
    // chain is normalized to never stay "poisoned" for whoever's next.
    const run = async () => {
      if (isStale()) return

      // Clear all per-project state BEFORE loading new project data
      // to prevent cross-project contamination. MUST be awaited so the
      // ingest queue / graph cache are actually cleared before the new
      // project's state is populated.
      const { resetProjectState } = await import("@/lib/reset-project-state")
      await resetProjectState()
      if (isStale()) return

      const agentConfig = await loadAgentResourceConfig(proj.path)
      if (isStale()) return
      useAgentSettingsStore.getState().setResourceConfig(agentConfig)
      setProject(proj)
      const projectOutputLang = await loadOutputLanguage(proj.id)
      if (isStale()) return
      useWikiStore.getState().setOutputLanguage(projectOutputLang ?? "auto")
      setSelectedFile(null)
      setActiveView("wiki")
      // Bump data version so any cached graphs/views invalidate
      useWikiStore.getState().bumpDataVersion()
      await saveLastProject(proj)
      if (isStale()) return

      // Restore ingest queue (resume interrupted tasks). Keyed by the
      // project's stable UUID so the queue still finds the right project
      // even if the filesystem path changed since the task was enqueued.
      // Await this before starting file sync: watcher events for raw/sources
      // may enqueue ingest tasks and require an active project queue.
      try {
        const { restoreQueue } = await import("@/lib/ingest-queue")
        if (isStale()) return
        await restoreQueue(proj.id, proj.path)
      } catch (err) {
        console.error("Failed to restore ingest queue:", err)
      }
      if (isStale()) return
      // Same handshake for the dedup-merge queue.
      try {
        const { restoreQueue } = await import("@/lib/dedup-queue")
        if (isStale()) return
        await restoreQueue(proj.id, proj.path)
      } catch (err) {
        console.error("Failed to restore dedup queue:", err)
      }
      if (isStale()) return
      // Start the embedding-consumer derived-rebuild job poller (SPEC-6
      // PR2). Unlike scheduled import this always runs (not gated by a
      // per-project enabled flag) — it only does work when there are
      // pending "embedding" markers, which requires embedding to be
      // configured in the first place. Must start after ingest queue
      // restore (above) so its ingest-busy backoff check has a live
      // module to query.
      try {
        const { startEmbeddingConsumer } = await import("@/lib/derived-rebuild/embedding-consumer")
        if (isStale()) return
        startEmbeddingConsumer(proj)
      } catch (err) {
        console.error("Failed to start embedding consumer:", err)
      }
      // Start the taxonomy-consumer derived-rebuild job poller (SPEC-6
      // PR3+4) — same always-on shape as the embedding consumer above; it
      // only does work when there are pending "taxonomy" markers, and never
      // bootstraps a taxonomy from scratch (growth only).
      try {
        const { startTaxonomyConsumer } = await import("@/lib/derived-rebuild/taxonomy-consumer")
        if (isStale()) return
        startTaxonomyConsumer(proj)
      } catch (err) {
        console.error("Failed to start taxonomy consumer:", err)
      }
      // Load per-project scheduled import config
      try {
        const savedScheduledImport = await loadScheduledImportConfig(proj.path)
        if (isStale()) return
        if (savedScheduledImport) {
          // Migrate relative path to absolute (backward compatibility)
          let path = savedScheduledImport.path
          if (path && !path.startsWith("/") && !path.match(/^[a-zA-Z]:[/\\]/)) {
            path = `${proj.path}/${path}`
          }
          useWikiStore.getState().setScheduledImportConfig({
            ...savedScheduledImport,
            path,
          })
        } else {
          // Reset to default for new projects
          useWikiStore.getState().setScheduledImportConfig({
            enabled: false,
            path: `${proj.path}/raw/sources`,
            interval: 60,
            lastScan: null,
          })
        }
      } catch {
        // ignore
      }
      // Start scheduled import if enabled
      const scheduledImportConfig = useWikiStore.getState().scheduledImportConfig
      if (scheduledImportConfig.enabled && scheduledImportConfig.path && scheduledImportConfig.interval > 0) {
        try {
          const { startScheduledImport } = await import("@/lib/scheduled-import")
          if (isStale()) return
          startScheduledImport(proj, scheduledImportConfig)
        } catch (err) {
          console.error("Failed to start scheduled import:", err)
        }
      }

      // Start project source watch if enabled
      try {
        const { startProjectFileSync, stopProjectFileSync } = await import("@/lib/project-file-sync")
        if (isStale()) return
        const config = await loadSourceWatchConfig(proj.id)
        if (isStale()) return
        useWikiStore.getState().setSourceWatchConfig(config)
        if (config.enabled) {
          await startProjectFileSync(proj, config)
        } else {
          await stopProjectFileSync()
        }
      } catch (err) {
        console.error("Failed to configure project file sync:", err)
      }
      // Notify local clip server of the current project + all recent projects
      void (async () => {
        if (isStale()) return
        await fetch(`${CLIP_SERVER_BASE_URL}/project`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path: proj.path }),
        }).catch(() => {})
      })()

      // Send all recent projects to clip server for extension project picker
      void (async () => {
        try {
          const recents = await getRecentProjects()
          if (isStale()) return
          const projects = recents.map((p) => ({ name: p.name, path: p.path }))
          await fetch(`${CLIP_SERVER_BASE_URL}/projects`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ projects }),
          }).catch(() => {})
        } catch {
          // ignore
        }
      })()
      try {
        const tree = await listDirectory(proj.path)
        if (isStale()) return
        setFileTree(tree)
      } catch (err) {
        console.error("Failed to load file tree:", err)
      }
      // Load persisted review items
      try {
        const savedReview = await loadReviewItems(proj.path)
        if (isStale()) return
        if (savedReview.length > 0) {
          useReviewStore.getState().setItems(savedReview)
        }
      } catch {
        // ignore, start fresh
      }
      // Load persisted lint items
      if (!isStale()) useLintStore.getState().setItems([])
      try {
        const savedLint = await loadLintItems(proj.path)
        if (isStale()) return
        useLintStore.getState().setItems(savedLint)
      } catch {
        if (!isStale()) useLintStore.getState().setItems([])
      }
      // Load persisted chat history
      try {
        await cleanExpiredAgentSessions(proj.path)
        const savedChat = await loadChatHistory(proj.path)
        if (isStale()) return
        if (savedChat.conversations.length > 0) {
          useChatStore.getState().setConversations(savedChat.conversations)
          useChatStore.getState().setMessages(savedChat.messages)
          // Set most recent conversation as active
          const sorted = [...savedChat.conversations].sort((a, b) => b.updatedAt - a.updatedAt)
          if (sorted[0]) {
            useChatStore.getState().setActiveConversation(sorted[0].id)
          }
        }
      } catch {
        // ignore, start fresh
      }
    }

    return openQueueRef.current(run)
  }

  function beginAcceptedOpen(key?: string): void {
    busyOpenCountRef.current += 1
    if (key) acceptedOpenKeysRef.current.add(key)
    if (!busyRef.current) {
      busyRef.current = true
      sameTickDuplicateWindowRef.current = true
      queueMicrotask(() => {
        sameTickDuplicateWindowRef.current = false
      })
      setProjectOpsBusy(true)
    }
  }

  function finishAcceptedOpen(key?: string): void {
    if (key) acceptedOpenKeysRef.current.delete(key)
    busyOpenCountRef.current = Math.max(0, busyOpenCountRef.current - 1)
    if (busyOpenCountRef.current === 0) {
      busyRef.current = false
      sameTickDuplicateWindowRef.current = false
      setProjectOpsBusy(false)
    }
  }

  // Shared entry-point wrapper. `busyRef` is UI state plus duplicate
  // suppression, not the open mutex: different accepted opens still run
  // and serialize inside `handleProjectOpened`. We drop only the same
  // macrotask's extra trigger (real double-click bounce) and an already
  // accepted identical project key while it is still pending.
  async function runGuardedOpen(
    fn: () => Promise<void>,
    options: { key?: string; allowWhileBusy?: boolean } = {},
  ): Promise<void> {
    const { key, allowWhileBusy = false } = options
    if (busyRef.current) {
      if (sameTickDuplicateWindowRef.current) return
      if (key && acceptedOpenKeysRef.current.has(key)) return
      if (!allowWhileBusy) return
    }

    beginAcceptedOpen(key)
    try {
      await fn()
    } finally {
      finishAcceptedOpen(key)
    }
  }

  async function handleSelectRecent(proj: WikiProject) {
    await runGuardedOpen(async () => {
      try {
        const validated = await openProject(proj.path)
        await handleProjectOpened(validated)
      } catch (err) {
        window.alert(`Failed to open project: ${err}`)
      }
    }, { key: proj.path, allowWhileBusy: true })
  }

  async function handleOpenProject() {
    await runGuardedOpen(async () => {
      try {
        const selected = await open({
          directory: true,
          multiple: false,
          title: "Open Wiki Project",
        })
        if (!selected) return
        const proj = await openProject(selected)
        await handleProjectOpened(proj)
      } catch (err) {
        window.alert(`Failed to open project: ${err}`)
      }
    }, { allowWhileBusy: true })
  }

  // Wraps handleProjectOpened for CreateProjectDialog so its "creating"
  // button-disable window (which now awaits this) also participates in
  // the shared guard, covering the cross-entry race with the other two
  // open paths above (see create-project-dialog.tsx for the matching fix
  // that stops the dialog being dismissed mid-creation).
  async function handleProjectCreated(proj: WikiProject) {
    await runGuardedOpen(async () => {
      await handleProjectOpened(proj)
    }, { key: proj.path, allowWhileBusy: true })
  }

  async function handleSwitchProject() {
    // Stop scheduled import before switching projects
    import("@/lib/scheduled-import").then(({ stopScheduledImport }) => {
      stopScheduledImport()
    }).catch(() => {})

    // Save current project's scheduled import config before clearing
    const currentProject = useWikiStore.getState().project
    if (currentProject) {
      const currentConfig = useWikiStore.getState().scheduledImportConfig
      saveScheduledImportConfig(currentProject.path, currentConfig).catch(() => {})
    }

    // Clear all per-project state BEFORE flipping back to the welcome screen
    // so old data cannot leak in via any async render pass.
    const { resetProjectState } = await import("@/lib/reset-project-state")
    await resetProjectState()
    setProject(null)
    setFileTree([])
    setSelectedFile(null)
  }

  return {
    projectOpsBusy,
    handleProjectOpened,
    handleSwitchProject,
    handleSelectRecent,
    handleOpenProject,
    handleProjectCreated,
  }
}
