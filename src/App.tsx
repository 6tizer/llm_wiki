import { useState, useEffect, useRef } from "react"
import { open } from "@tauri-apps/plugin-dialog"
import i18n from "@/i18n"
import { DEFAULT_API_CONFIG, useWikiStore } from "@/stores/wiki-store"
import { useReviewStore } from "@/stores/review-store"
import { useLintStore } from "@/stores/lint-store"
import { useChatStore } from "@/stores/chat-store"
import { useAgentSettingsStore } from "@/stores/agent-settings-store"
import { BASE_FONT_SIZE_PX, useZoomStore } from "@/stores/zoom-store"
import { listDirectory, openProject } from "@/commands/fs"
import { getLastProject, getRecentProjects, saveLastProject, loadLlmConfig, loadLanguage, loadSearchApiConfig, loadEmbeddingConfig, loadMineruConfig, loadMultimodalConfig, loadOutputLanguage, loadProviderConfigs, loadActivePresetId, loadProxyConfig, loadScheduledImportConfig, saveScheduledImportConfig, loadSourceWatchConfig, loadApiConfig, loadZoomLevel, loadTheme } from "@/lib/project-store"
import { activateThemePreference } from "@/lib/theme"
import { loadAgentResourceConfig } from "@/lib/agent/agent-settings"
import { cleanExpiredAgentSessions, loadReviewItems, loadLintItems, loadChatHistory } from "@/lib/persist"
import { setupAutoSave } from "@/lib/auto-save"
import { startClipWatcher } from "@/lib/clip-watcher"
import { CLIP_SERVER_BASE_URL } from "@/lib/clip-server-constants"
import { normalizeMineruConfig } from "@/lib/mineru-config"
import { createSerialQueue } from "@/lib/serial-queue"
import { UPDATE_REPO } from "@/lib/update-check"
import { AppLayout } from "@/components/layout/app-layout"
import { WelcomeScreen } from "@/components/project/welcome-screen"
import { CreateProjectDialog } from "@/components/project/create-project-dialog"
import type { WikiProject } from "@/types/wiki"

/** Apply app zoom through the root font size so pointer coordinates stay native. */
export function applyDocumentZoom(level: number): void {
  document.documentElement.style.fontSize = `${BASE_FONT_SIZE_PX * level}px`
}

function App() {
  const project = useWikiStore((s) => s.project)
  const setProject = useWikiStore((s) => s.setProject)
  const setFileTree = useWikiStore((s) => s.setFileTree)
  const setSelectedFile = useWikiStore((s) => s.setSelectedFile)
  const setActiveView = useWikiStore((s) => s.setActiveView)
  const zoomLevel = useZoomStore((s) => s.level)
  const [showCreateDialog, setShowCreateDialog] = useState(false)
  const [loading, setLoading] = useState(true)
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

  // Set up auto-save and clip watcher once on mount
  useEffect(() => {
    setupAutoSave()
    startClipWatcher()
  }, [])

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

  // Background update check — hydrate persisted user preferences, then
  // hit GitHub at most once every UPDATE_CHECK_CACHE_MS. Runs 1.5 s
  // after mount so it doesn't contend with the heaviest startup work
  // (project load, file tree, vector store init) but still surfaces
  // a new release in time for the user to notice it during their
  // first interaction. Silent on failure; the UI in Settings → About
  // lets the user retry manually.
  useEffect(() => {
    let cancelled = false
    const timer = setTimeout(async () => {
      if (cancelled) return
      try {
        const { loadUpdateCheckState, saveUpdateCheckState } = await import(
          "@/lib/project-store"
        )
        const { useUpdateStore } = await import("@/stores/update-store")
        const { checkForUpdates, UPDATE_CHECK_CACHE_MS } = await import(
          "@/lib/update-check"
        )

        const persisted = await loadUpdateCheckState()
        if (persisted) useUpdateStore.getState().hydrate(persisted)

        const state = useUpdateStore.getState()
        if (!state.enabled) {
          console.log("[update-check] skipped: user disabled auto-check in settings")
          return
        }

        const now = Date.now()
        // Cache hit requires BOTH the timestamp AND the in-memory
        // result to be present. `lastCheckedAt` is persisted to
        // disk but `lastResult` deliberately is not — keeping the
        // GitHub payload out of the persisted store keeps disk
        // size + privacy footprint small. The downside: a fresh
        // cold start has `lastResult === null` even when
        // `lastCheckedAt` is recent, in which case we MUST refetch
        // — otherwise we'd skip the check AND have no result to
        // display, leaving the banner permanently stuck off.
        // (This was the user-reported bug: "kind=none, no banner".)
        const fresh =
          state.lastCheckedAt !== null &&
          state.lastResult !== null &&
          now - state.lastCheckedAt < UPDATE_CHECK_CACHE_MS
        if (fresh) {
          const ageMin = Math.round((now - (state.lastCheckedAt ?? 0)) / 60_000)
          console.log(
            `[update-check] skipped: cache hit (last check ${ageMin} min ago, ` +
              `cache window ${UPDATE_CHECK_CACHE_MS / 60_000} min). ` +
              `Last result: kind=${state.lastResult?.kind ?? "none"}`,
          )
          return
        }

        useUpdateStore.getState().setChecking(true)
        console.log(
          `[update-check] fetching GitHub releases (local=${__APP_VERSION__})`,
        )
        const result = await checkForUpdates({
          currentVersion: __APP_VERSION__,
          repo: UPDATE_REPO,
        })
        if (cancelled) return
        useUpdateStore.getState().setResult(result, Date.now())
        if (result.kind === "available") {
          console.log(
            `[update-check] update available: local=${result.local} → remote=${result.remote}`,
          )
        } else if (result.kind === "up-to-date") {
          console.log(
            `[update-check] up to date: local=${result.local}, remote latest=${result.remote}`,
          )
        } else if (result.kind === "error") {
          console.log(`[update-check] error: ${result.message}`)
        } else {
          console.log(`[update-check] no release published yet: local=${result.local}`)
        }
        await saveUpdateCheckState({
          enabled: useUpdateStore.getState().enabled,
          lastCheckedAt: Date.now(),
          dismissedVersion: useUpdateStore.getState().dismissedVersion,
        })
      } catch {
        // Silent — Settings → About lets the user retry manually.
      }
    }, 1500)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [])

  // Auto-open last project on startup. Each load is its own isolated
  // step: previously one big try/catch wrapped all of them, so a single
  // failing load (e.g. a corrupted settings key) silently skipped every
  // step after it — INCLUDING re-opening the last project, even though
  // that step has no dependency on the ones before it. Isolating each
  // step means a bad zoom-level read no longer costs the user their
  // last-open project on the next launch.
  useEffect(() => {
    const runStep = async (label: string, fn: () => Promise<void>) => {
      try {
        await fn()
      } catch (err) {
        console.error(`[init] ${label} failed:`, err)
      }
    }

    async function init() {
      // Populated by the providerConfigs step; read by the activePreset
      // step for its per-preset override lookup. Stays null if that step
      // fails; in that case activePreset must not re-resolve and persist
      // a defaults-only LlmConfig over the user's last good snapshot.
      let savedProviderConfigs: Awaited<ReturnType<typeof loadProviderConfigs>> = null

      await runStep("llmConfig", async () => {
        const savedConfig = await loadLlmConfig()
        if (savedConfig) {
          useWikiStore.getState().setLlmConfig(savedConfig)
        }
      })

      await runStep("providerConfigs", async () => {
        savedProviderConfigs = await loadProviderConfigs()
        if (savedProviderConfigs) {
          useWikiStore.getState().setProviderConfigs(savedProviderConfigs)
        }
      })

      // Re-resolve the active preset's LlmConfig from (preset defaults +
      // saved overrides). Without this, preset default updates (e.g. a
      // corrected Anthropic model ID shipped in a release) never reach
      // users who are relying on defaults — their stored `llmConfig`
      // snapshot from a previous launch would keep the old value.
      // Overrides still win, so an explicit user choice is preserved.
      // Kept as a single step (not split further) since its sub-parts
      // depend on each other in sequence.
      await runStep("activePreset", async () => {
        const savedActivePreset = await loadActivePresetId()
        if (savedActivePreset) {
          useWikiStore.getState().setActivePresetId(savedActivePreset)
          if (!savedProviderConfigs) {
            return
          }
          const { LLM_PRESETS } = await import("@/lib/llm-presets")
          const { resolveConfig } = await import("@/components/settings/preset-resolver")
          const preset = LLM_PRESETS.find((p) => p.id === savedActivePreset)
          if (preset) {
            const currentFallback = useWikiStore.getState().llmConfig
            const override = savedProviderConfigs[savedActivePreset]
            const resolved = resolveConfig(preset, override, currentFallback)
            useWikiStore.getState().setLlmConfig(resolved)
            const { saveLlmConfig } = await import("@/lib/project-store")
            await saveLlmConfig(resolved)
          }
        }
      })

      await runStep("searchApiConfig", async () => {
        const savedSearchConfig = await loadSearchApiConfig()
        if (savedSearchConfig) {
          useWikiStore.getState().setSearchApiConfig(savedSearchConfig)
        }
      })

      await runStep("embeddingConfig", async () => {
        const savedEmbeddingConfig = await loadEmbeddingConfig()
        if (savedEmbeddingConfig) {
          useWikiStore.getState().setEmbeddingConfig(savedEmbeddingConfig)
        }
      })

      await runStep("multimodalConfig", async () => {
        const savedMultimodalConfig = await loadMultimodalConfig()
        if (savedMultimodalConfig) {
          useWikiStore.getState().setMultimodalConfig(savedMultimodalConfig)
        }
      })

      await runStep("mineruConfig", async () => {
        const savedMineruConfig = await loadMineruConfig()
        if (savedMineruConfig) {
          useWikiStore.getState().setMineruConfig(normalizeMineruConfig(savedMineruConfig))
        }
      })

      await runStep("proxyConfig", async () => {
        const savedProxy = await loadProxyConfig()
        if (savedProxy) {
          useWikiStore.getState().setProxyConfig(savedProxy)
        }
      })

      await runStep("apiConfig", async () => {
        // Local HTTP API server config — global (single token + enable
        // flag for the whole install, not per-project). The Rust side
        // reads `apiConfig.{enabled,token,mcpEnabled}` from `app-state.json`
        // directly; this only hydrates the Zustand store so the
        // Settings UI reflects the persisted values.
        const savedApi = await loadApiConfig()
        if (savedApi) {
          useWikiStore.getState().setApiConfig({
            enabled: typeof savedApi.enabled === "boolean" ? savedApi.enabled : DEFAULT_API_CONFIG.enabled,
            allowUnauthenticated:
              typeof savedApi.allowUnauthenticated === "boolean"
                ? savedApi.allowUnauthenticated
                : DEFAULT_API_CONFIG.allowUnauthenticated,
            mcpEnabled: typeof savedApi.mcpEnabled === "boolean" ? savedApi.mcpEnabled : DEFAULT_API_CONFIG.mcpEnabled,
            token: typeof savedApi.token === "string" ? savedApi.token : DEFAULT_API_CONFIG.token,
          })
        }
      })

      await runStep("zoomLevel", async () => {
        useZoomStore.getState().setLevel(await loadZoomLevel())
      })

      await runStep("theme", async () => {
        activateThemePreference(await loadTheme())
      })

      await runStep("language", async () => {
        const savedLang = await loadLanguage()
        if (savedLang) {
          await i18n.changeLanguage(savedLang)
        }
      })

      // Independent of every step above — must run even if an earlier
      // load failed.
      await runStep("lastProject", async () => {
        const lastProject = await getLastProject()
        if (lastProject) {
          const proj = await openProject(lastProject.path)
          await handleProjectOpened(proj)
        }
      })

      setLoading(false)
    }
    init()
  }, [])

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
