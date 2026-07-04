// @vitest-environment jsdom

import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import "@/i18n"
import { useWikiStore } from "@/stores/wiki-store"
import { useReviewStore } from "@/stores/review-store"
import { useLintStore } from "@/stores/lint-store"
import { useChatStore } from "@/stores/chat-store"
import type {
  ApiConfig,
  EmbeddingConfig,
  LlmConfig,
  MineruConfig,
  MultimodalConfig,
  OutputLanguage,
  ProviderConfigs,
  ProxyConfig,
  ScheduledImportConfig,
  SearchApiConfig,
  SourceWatchConfig,
} from "@/stores/wiki-store"
import type { WikiProject } from "@/types/wiki"
import type { FileNode } from "@/types/wiki"
import type { ReviewItem } from "@/stores/review-store"
import type { LintItem } from "@/stores/lint-store"
import type { Conversation, DisplayMessage } from "@/stores/chat-store"

// ---------------------------------------------------------------------
// Mocks — App.tsx's init() and handleProjectOpened() touch a lot of
// modules (settings persistence, ingest/dedup queues, scheduled import,
// file-sync watchers, the local clip server). None of that IO is what
// these tests are about, so everything below resolves instantly with an
// inert default; individual tests override the handful of calls they
// need to control.
// ---------------------------------------------------------------------

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(async () => null),
}))

const fsMocks = vi.hoisted(() => ({
  listDirectory: vi.fn(async (_path: string) => [] as FileNode[]),
  openProject: vi.fn(async (path: string) => ({ id: path, name: path, path }) as WikiProject),
}))
vi.mock("@/commands/fs", () => fsMocks)

const projectStoreMocks = vi.hoisted(() => ({
  getLastProject: vi.fn(async (): Promise<WikiProject | null> => null),
  getRecentProjects: vi.fn(async (): Promise<WikiProject[]> => []),
  saveLastProject: vi.fn(async () => undefined),
  loadLlmConfig: vi.fn<() => Promise<LlmConfig | null>>(async () => null),
  loadLanguage: vi.fn<() => Promise<string | null>>(async () => null),
  loadSearchApiConfig: vi.fn<() => Promise<SearchApiConfig | null>>(async () => null),
  loadEmbeddingConfig: vi.fn<() => Promise<EmbeddingConfig | null>>(async () => null),
  loadMineruConfig: vi.fn<() => Promise<MineruConfig | null>>(async () => null),
  loadMultimodalConfig: vi.fn<() => Promise<MultimodalConfig | null>>(async () => null),
  loadOutputLanguage: vi.fn<(projectId?: string) => Promise<OutputLanguage | null>>(
    async () => null,
  ),
  loadProviderConfigs: vi.fn<() => Promise<ProviderConfigs | null>>(async () => null),
  loadActivePresetId: vi.fn<() => Promise<string | null>>(async () => null),
  loadProxyConfig: vi.fn<() => Promise<ProxyConfig | null>>(async () => null),
  loadScheduledImportConfig: vi.fn<(projectPath: string) => Promise<ScheduledImportConfig | null>>(
    async () => null,
  ),
  saveScheduledImportConfig: vi.fn(async () => undefined),
  loadSourceWatchConfig: vi.fn<() => Promise<SourceWatchConfig>>(
    async () => ({
      enabled: false,
      autoIngest: false,
      includeExtensions: [],
      excludeExtensions: [],
      excludeDirs: [],
      excludeGlobs: [],
      maxFileSizeMb: 10,
    }),
  ),
  loadApiConfig: vi.fn<() => Promise<ApiConfig | null>>(async () => null),
  loadZoomLevel: vi.fn(async () => 1),
  loadTheme: vi.fn(async () => "system"),
  saveLlmConfig: vi.fn(async () => undefined),
}))
vi.mock("@/lib/project-store", () => projectStoreMocks)

const agentSettingsMocks = vi.hoisted(() => ({
  loadAgentResourceConfig: vi.fn(),
}))
vi.mock("@/lib/theme", () => ({ activateThemePreference: vi.fn() }))
vi.mock("@/lib/agent/agent-settings", async () => {
  const actual = await vi.importActual<typeof import("@/lib/agent/agent-settings")>(
    "@/lib/agent/agent-settings",
  )
  agentSettingsMocks.loadAgentResourceConfig.mockImplementation(
    async () => actual.DEFAULT_AGENT_RESOURCE_CONFIG,
  )
  return { ...actual, loadAgentResourceConfig: agentSettingsMocks.loadAgentResourceConfig }
})

const persistMocks = vi.hoisted(() => ({
  cleanExpiredAgentSessions: vi.fn(async () => undefined),
  loadReviewItems: vi.fn(async (_path: string) => [] as ReviewItem[]),
  loadLintItems: vi.fn(async (_path: string) => [] as LintItem[]),
  loadChatHistory: vi.fn(async (_path: string) => ({
    conversations: [] as Conversation[],
    messages: [] as DisplayMessage[],
  })),
}))
vi.mock("@/lib/persist", () => persistMocks)

vi.mock("@/lib/auto-save", () => ({
  setupAutoSave: vi.fn(),
  flushAutoSave: vi.fn(async () => undefined),
  cancelAutoSaveTimers: vi.fn(),
}))
vi.mock("@/lib/clip-watcher", () => ({ startClipWatcher: vi.fn() }))
vi.mock("@/lib/mineru-config", () => ({ normalizeMineruConfig: vi.fn((c: unknown) => c) }))

// `resetProjectState` itself is NOT mocked — the P0 regression below
// depends on its real, unconditional store-clearing actually running.
// Only ITS OWN dependencies are stubbed inert (or, for ingest-queue,
// made controllable) so it can execute for real without touching disk,
// the vector store, or file watchers.
const ingestQueueMocks = vi.hoisted(() => ({
  restoreQueue: vi.fn(async (_id: string, _path: string) => undefined),
  pauseQueue: vi.fn(async () => undefined),
}))
vi.mock("@/lib/ingest-queue", () => ingestQueueMocks)
vi.mock("@/lib/dedup-queue", () => ({
  restoreQueue: vi.fn(async () => undefined),
  pauseQueue: vi.fn(async () => undefined),
}))
vi.mock("@/lib/graph-relevance", () => ({ clearGraphCache: vi.fn() }))
vi.mock("@/lib/agent/agent-lint-queue", () => ({ clearAgentStructuralLintQueue: vi.fn() }))
const scheduledImportMocks = vi.hoisted(() => ({
  startScheduledImport: vi.fn(),
  stopScheduledImport: vi.fn(),
}))
vi.mock("@/lib/scheduled-import", () => scheduledImportMocks)
// SPEC-6 PR2: mirrors scheduledImportMocks above — without this mock,
// handleProjectOpened's dynamic `import("@/lib/derived-rebuild/
// embedding-consumer")` would load the REAL module and start a genuine
// setInterval poll loop that outlives individual tests in this file.
const embeddingConsumerMocks = vi.hoisted(() => ({
  startEmbeddingConsumer: vi.fn(),
  stopEmbeddingConsumer: vi.fn(),
}))
vi.mock("@/lib/derived-rebuild/embedding-consumer", () => embeddingConsumerMocks)
const projectFileSyncMocks = vi.hoisted(() => ({
  startProjectFileSync: vi.fn(async () => undefined),
  stopProjectFileSync: vi.fn(async () => undefined),
}))
vi.mock("@/lib/project-file-sync", () => projectFileSyncMocks)

// Heavy child trees replaced with prop-capturing stand-ins — these tests
// are about App's own open/init orchestration, not what WelcomeScreen,
// CreateProjectDialog, or AppLayout render. Capturing `.current` lets a
// test invoke a handler directly, which is what makes the concurrency
// tests below deterministic: calling a captured closure bypasses real
// click/render timing entirely, so two "calls" can be fired back to back
// from the exact same render's closures on purpose.
const welcomeScreenProps = vi.hoisted(() => ({
  current: null as null | {
    onCreateProject: () => void
    onOpenProject: () => Promise<void>
    onSelectProject: (project: WikiProject) => Promise<void>
    disabled?: boolean
  },
}))
vi.mock("@/components/project/welcome-screen", () => ({
  WelcomeScreen: (props: (typeof welcomeScreenProps)["current"]) => {
    welcomeScreenProps.current = props
    return null
  },
}))

const createDialogProps = vi.hoisted(() => ({
  current: null as null | {
    open: boolean
    onOpenChange: (open: boolean) => void
    onCreated: (project: WikiProject) => void | Promise<void>
  },
}))
vi.mock("@/components/project/create-project-dialog", () => ({
  CreateProjectDialog: (props: (typeof createDialogProps)["current"]) => {
    createDialogProps.current = props
    return null
  },
}))

vi.mock("@/components/layout/app-layout", () => ({
  AppLayout: () => null,
}))

import App from "./App"

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true

const fetchMock = vi.fn(async () => new Response(null, { status: 204 }))
vi.stubGlobal("fetch", fetchMock)

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (err: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function renderApp(): { root: Root } {
  const container = document.createElement("div")
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => {
    root.render(createElement(App))
  })
  return { root }
}

// handleProjectOpened chains many real awaits (dynamic imports, several
// sequential mocked IO calls) — a fixed microtask-tick count is fragile
// since each hop can itself take more than one tick. A real macrotask
// boundary (setTimeout) reliably drains every pending microtask first,
// so a handful of these flushes gets a chain to its next genuine
// suspension point (e.g. a manually-controlled deferred) regardless of
// exactly how many microtask hops are in between.
async function flush(rounds = 8): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }
}

function unmount(root: Root): void {
  act(() => {
    root.unmount()
  })
}

function project(id: string, path: string): WikiProject {
  return { id, name: id, path }
}

function reviewItem(id: string): ReviewItem {
  return {
    id,
    type: "suggestion",
    title: id,
    description: id,
    options: [],
    resolved: false,
    createdAt: Date.now(),
  }
}

function lintItem(id: string): LintItem {
  return {
    id,
    type: "orphan",
    severity: "warning",
    page: id,
    detail: id,
    createdAt: Date.now(),
  }
}

function conversation(id: string): Conversation {
  return { id, title: id, createdAt: Date.now(), updatedAt: Date.now() }
}

function chatMessage(id: string, conversationId: string): DisplayMessage {
  return { id, role: "user", content: id, timestamp: Date.now(), conversationId }
}

describe("App — init() step isolation", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useWikiStore.setState({ project: null, fileTree: [] })
    fsMocks.openProject.mockImplementation(async (path: string) => project(path, path))
    fsMocks.listDirectory.mockImplementation(async () => [])
    projectStoreMocks.getLastProject.mockResolvedValue(null)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("still opens the last project even when an earlier init step throws", async () => {
    const bootError = new Error("zoom level read failed")
    projectStoreMocks.loadZoomLevel.mockRejectedValueOnce(bootError)
    const lastProject = project("last", "/tmp/last-project")
    projectStoreMocks.getLastProject.mockResolvedValue(lastProject)
    const opened = deferred<void>()
    persistMocks.loadChatHistory.mockImplementationOnce(async () => {
      opened.resolve()
      return { conversations: [], messages: [] }
    })
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {})

    const { root } = renderApp()
    await flush()
    await opened.promise
    await flush(2)

    expect(useWikiStore.getState().project?.path).toBe(lastProject.path)
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining("[init] zoomLevel failed"),
      bootError,
    )

    unmount(root)
  })

  it("does not open a last project when there isn't one, without throwing", async () => {
    const lastProjectChecked = deferred<null>()
    projectStoreMocks.getLastProject.mockImplementationOnce(async () => {
      lastProjectChecked.resolve(null)
      return null
    })
    const { root } = renderApp()
    await flush()
    await lastProjectChecked.promise
    await flush(2)

    expect(useWikiStore.getState().project).toBeNull()
    expect(welcomeScreenProps.current).not.toBeNull()

    unmount(root)
  })

  it("does not rewrite llmConfig when provider configs fail to load", async () => {
    const savedLlmConfig = {
      provider: "anthropic" as const,
      apiKey: "sk-existing",
      model: "claude-existing",
      ollamaUrl: "http://localhost:11434",
      customEndpoint: "https://existing.example/v1",
      maxContextSize: 123456,
      reasoning: { mode: "auto" as const },
      localCliIsolation: false,
      codexCliTimeoutMinutes: 10,
    }
    const providerConfigError = new Error("provider configs read failed")
    const lastProject = project("last", "/tmp/last-project")
    const opened = deferred<void>()
    projectStoreMocks.loadLlmConfig.mockResolvedValueOnce(savedLlmConfig)
    projectStoreMocks.loadProviderConfigs.mockRejectedValueOnce(providerConfigError)
    projectStoreMocks.loadActivePresetId.mockResolvedValueOnce("anthropic")
    projectStoreMocks.getLastProject.mockResolvedValue(lastProject)
    persistMocks.loadChatHistory.mockImplementationOnce(async () => {
      opened.resolve()
      return { conversations: [], messages: [] }
    })
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {})

    const { root } = renderApp()
    await flush()
    await opened.promise
    await flush(2)

    expect(useWikiStore.getState().llmConfig).toEqual(savedLlmConfig)
    expect(projectStoreMocks.saveLlmConfig).not.toHaveBeenCalled()
    expect(useWikiStore.getState().project?.path).toBe(lastProject.path)
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining("[init] providerConfigs failed"),
      providerConfigError,
    )

    unmount(root)
  })
})

describe("App — handleProjectOpened concurrency guard", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useWikiStore.setState({ project: null, fileTree: [] })
    fsMocks.openProject.mockImplementation(async (path: string) => project(path, path))
    fsMocks.listDirectory.mockImplementation(async () => [])
    projectStoreMocks.getLastProject.mockResolvedValue(null)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("busy guard drops a second call fired synchronously through the same entry — only the first's project lands", async () => {
    const { root } = renderApp()
    await flush()
    expect(welcomeScreenProps.current).not.toBeNull()

    // Grab the handler from the current render, then invoke it twice
    // back to back without awaiting between calls — a fast double-click
    // on the same "recent project" row. `busyRef` is mutated
    // synchronously by the FIRST call (inside runGuardedOpen, before
    // any await), so the SECOND call sees it's already busy and is
    // dropped before it ever calls openProject — this is what actually
    // prevents the two-overlapping-opens scenario in practice; see
    // src/lib/serial-queue.test.ts for the deeper backstop this test
    // doesn't need to reach.
    const onSelectProject = welcomeScreenProps.current!.onSelectProject
    const projA = project("a", "/tmp/a")
    const projB = project("b", "/tmp/b")
    fsMocks.openProject.mockImplementation(async (path: string) =>
      path === projA.path ? projA : projB,
    )

    let pA!: Promise<void>
    let pB!: Promise<void>
    act(() => {
      pA = onSelectProject(projA)
      pB = onSelectProject(projB)
    })
    await flush()
    await Promise.allSettled([pA, pB])

    expect(fsMocks.openProject).toHaveBeenCalledTimes(1)
    expect(fsMocks.openProject).toHaveBeenCalledWith(projA.path)
    expect(useWikiStore.getState().project?.id).toBe("a")

    unmount(root)
  })

  it("busy guard blocks a DIFFERENT entry point for as long as an open is in flight, not just at the first tick", async () => {
    const { root } = renderApp()
    await flush()

    const projA = project("a", "/tmp/a")
    const projB = project("b", "/tmp/b")
    fsMocks.openProject.mockImplementation(async (path: string) =>
      path === projA.path ? projA : projB,
    )
    // Keep A parked deep inside its own run (past resetProjectState,
    // loadAgentResourceConfig, etc.) so this checks busyRef stays true
    // well after the first tick, not just at the very start.
    const aTreeDeferred = deferred<FileNode[]>()
    fsMocks.listDirectory.mockImplementationOnce(() => aTreeDeferred.promise)

    let pA!: Promise<void>
    act(() => {
      pA = welcomeScreenProps.current!.onSelectProject(projA)
    })
    await flush()
    expect(fsMocks.listDirectory).toHaveBeenCalledWith(projA.path)

    // Try a DIFFERENT entry point (the open-project button) while A is
    // still parked — must be dropped too, since busyRef is shared
    // across all three entries, not per-entry.
    await welcomeScreenProps.current!.onOpenProject()
    expect(fsMocks.openProject).not.toHaveBeenCalledWith(projB.path)

    await act(async () => {
      aTreeDeferred.resolve([{ name: "a.md", path: "/tmp/a/a.md", is_dir: false }])
    })
    await flush()
    await pA

    expect(useWikiStore.getState().project?.id).toBe("a")

    unmount(root)
  })

  it("busy flag blocks a re-invocation through the same entry once the first call has committed", async () => {
    const { root } = renderApp()
    await flush()

    const projA = project("a", "/tmp/a")
    fsMocks.openProject.mockImplementation(async () => projA)
    // Never resolves — keeps the first call "in flight" indefinitely.
    fsMocks.listDirectory.mockImplementation(() => new Promise<FileNode[]>(() => {}))

    await act(async () => {
      void welcomeScreenProps.current!.onSelectProject(projA)
      await Promise.resolve()
      await Promise.resolve()
    })

    // The busy-flag state update above should have re-rendered
    // WelcomeScreen with a fresh closure that now observes busy===true.
    expect(welcomeScreenProps.current!.disabled).toBe(true)

    fsMocks.openProject.mockClear()
    await welcomeScreenProps.current!.onSelectProject(projA)
    expect(fsMocks.openProject).not.toHaveBeenCalled()

    unmount(root)
  })
})

// P0/P1 regression coverage for the correctness bug a code-review probe
// found with a REAL (unmocked) resetProjectState: its unconditional
// store-clearing runs BEFORE handleProjectOpened's own isStale()
// checkpoints, so those checkpoints alone cannot stop a slow/stale
// open's resetProjectState from wiping a newer open's already-loaded
// review/lint/chat data (and auto-save would then persist the resulting
// empty arrays to the NEWER project's own disk files). The fix is
// `openChainRef` — see the comment on it in App.tsx — which serializes
// the ENTIRE open pipeline, resetProjectState included, so this window
// cannot open in the first place. `resetProjectState` is intentionally
// NOT mocked in this file (only ITS OWN dependencies are); the P0 test
// below asserts on real useReviewStore/useLintStore/useChatStore state,
// not mock call counts, so it actually exercises resetProjectState's
// real store-clearing logic.
describe("App — resetProjectState serialization (P0/P1 regression)", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useWikiStore.setState({ project: null, fileTree: [] })
    useReviewStore.getState().setItems([])
    useLintStore.getState().setItems([])
    useChatStore.setState({ conversations: [], messages: [] })
    fsMocks.openProject.mockImplementation(async (path: string) => project(path, path))
    fsMocks.listDirectory.mockImplementation(async () => [])
    projectStoreMocks.getLastProject.mockResolvedValue(null)
    persistMocks.loadReviewItems.mockImplementation(async () => [])
    persistMocks.loadLintItems.mockImplementation(async () => [])
    persistMocks.loadChatHistory.mockImplementation(async () => ({ conversations: [], messages: [] }))
    ingestQueueMocks.pauseQueue.mockImplementation(async () => undefined)
    agentSettingsMocks.loadAgentResourceConfig.mockImplementation(async () => {
      const actual = await vi.importActual<typeof import("@/lib/agent/agent-settings")>(
        "@/lib/agent/agent-settings",
      )
      return actual.DEFAULT_AGENT_RESOURCE_CONFIG
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("P0: a stale open's real resetProjectState cannot wipe a newer open's already-loaded review/lint/chat data", async () => {
    const { root } = renderApp()
    await flush()

    const onSelectProject = welcomeScreenProps.current!.onSelectProject
    const projA = project("a", "/tmp/a")
    const projB = project("b", "/tmp/b")
    fsMocks.openProject.mockImplementation(async (path: string) =>
      path === projA.path ? projA : projB,
    )
    persistMocks.loadReviewItems.mockImplementation(async (path: string) =>
      path === projB.path ? [reviewItem("r-b")] : [],
    )
    persistMocks.loadLintItems.mockImplementation(async (path: string) =>
      path === projB.path ? [lintItem("l-b")] : [],
    )
    persistMocks.loadChatHistory.mockImplementation(async (path: string) =>
      path === projB.path
        ? { conversations: [conversation("c-b")], messages: [chatMessage("m-b", "c-b")] }
        : { conversations: [], messages: [] },
    )

    // Stall A specifically inside its own (real) resetProjectState call,
    // at the ingest-queue pauseQueue step resetProjectState awaits
    // synchronously — this is what "A is slow inside resetProjectState"
    // (e.g. a slow flushAutoSave in the real bug report) looks like.
    const stall = deferred<undefined>()
    ingestQueueMocks.pauseQueue.mockImplementationOnce(() => stall.promise)

    let pA!: Promise<void>
    act(() => {
      pA = onSelectProject(projA)
    })
    await flush()

    let pB!: Promise<void>
    act(() => {
      pB = onSelectProject(projB)
    })
    await flush(30)

    // The mutex must block B entirely while A's resetProjectState is
    // still stalled — nothing of B's has landed yet.
    expect(useWikiStore.getState().project).toBeNull()
    expect(useReviewStore.getState().items).toEqual([])

    // Release A. Its real resetProjectState finishes (a no-op at this
    // point — nothing has been loaded yet for it to wipe), A discovers
    // it's stale and bails, and B's queued run starts: its OWN real
    // resetProjectState runs, then it loads and commits real data.
    await act(async () => {
      stall.resolve(undefined)
    })
    await flush(30)
    await Promise.allSettled([pA, pB])

    expect(useWikiStore.getState().project?.id).toBe("b")
    expect(useReviewStore.getState().items.map((i) => i.id)).toEqual(["r-b"])
    expect(useLintStore.getState().items.map((i) => i.id)).toEqual(["l-b"])
    expect(useChatStore.getState().conversations.map((c) => c.id)).toEqual(["c-b"])

    unmount(root)
  })

  it("P1: a call superseded mid-flight (right after loadAgentResourceConfig) does not commit setProject before the queued newer call runs", async () => {
    const { root } = renderApp()
    await flush()

    const onSelectProject = welcomeScreenProps.current!.onSelectProject
    const projA = project("a", "/tmp/a")
    const projC = project("c", "/tmp/c")
    fsMocks.openProject.mockImplementation(async (path: string) =>
      path === projA.path ? projA : projC,
    )

    const actual = await vi.importActual<typeof import("@/lib/agent/agent-settings")>(
      "@/lib/agent/agent-settings",
    )
    const stall = deferred<typeof actual.DEFAULT_AGENT_RESOURCE_CONFIG>()
    agentSettingsMocks.loadAgentResourceConfig.mockImplementationOnce(() => stall.promise)

    let pA!: Promise<void>
    act(() => {
      pA = onSelectProject(projA)
    })
    await flush()

    let pC!: Promise<void>
    act(() => {
      pC = onSelectProject(projC)
    })
    await flush()
    // C is queued behind A (mutex) — hasn't started yet.
    expect(useWikiStore.getState().project).toBeNull()

    // Release A's loadAgentResourceConfig. The very next line in
    // handleProjectOpened is the isStale() checkpoint this test targets
    // — it must catch that C has already been requested and bail out
    // BEFORE calling setProject(projA), even though C's own queued run
    // hasn't started executing yet (this is the transient-state window
    // a naive "assert only the final state" test would miss).
    await act(async () => {
      stall.resolve(actual.DEFAULT_AGENT_RESOURCE_CONFIG)
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(useWikiStore.getState().project).toBeNull()

    await flush(30)
    await Promise.allSettled([pA, pC])
    expect(useWikiStore.getState().project?.id).toBe("c")

    unmount(root)
  })

  it("P1: stale scheduled-import and file-sync startup work cannot land after a newer project is queued", async () => {
    const { root } = renderApp()
    await flush()

    const onSelectProject = welcomeScreenProps.current!.onSelectProject
    const projA = project("a", "/tmp/a")
    const projB = project("b", "/tmp/b")
    fsMocks.openProject.mockImplementation(async (path: string) =>
      path === projA.path ? projA : projB,
    )

    const delayedAConfig = deferred<{
      enabled: boolean
      path: string
      interval: number
      lastScan: null
    }>()
    projectStoreMocks.loadScheduledImportConfig.mockImplementation(async (path: string) => {
      if (path === projA.path) return delayedAConfig.promise
      return { enabled: true, path: `${path}/raw/sources`, interval: 10, lastScan: null }
    })
    projectStoreMocks.loadSourceWatchConfig.mockResolvedValue({
      enabled: true,
      autoIngest: false,
      includeExtensions: [],
      excludeExtensions: [],
      excludeDirs: [],
      excludeGlobs: [],
      maxFileSizeMb: 10,
    })

    let pA!: Promise<void>
    act(() => {
      pA = onSelectProject(projA)
    })
    await flush()
    expect(projectStoreMocks.loadScheduledImportConfig).toHaveBeenCalledWith(projA.path)

    let pB!: Promise<void>
    act(() => {
      pB = onSelectProject(projB)
    })
    await flush()

    await act(async () => {
      delayedAConfig.resolve({
        enabled: true,
        path: `${projA.path}/raw/sources`,
        interval: 10,
        lastScan: null,
      })
    })
    await flush(30)
    await Promise.allSettled([pA, pB])

    expect(scheduledImportMocks.startScheduledImport).not.toHaveBeenCalledWith(
      projA,
      expect.objectContaining({ path: `${projA.path}/raw/sources` }),
    )
    expect(projectFileSyncMocks.startProjectFileSync).not.toHaveBeenCalledWith(
      projA,
      expect.anything(),
    )
    expect(scheduledImportMocks.startScheduledImport).toHaveBeenCalledWith(
      projB,
      expect.objectContaining({ path: `${projB.path}/raw/sources` }),
    )
    expect(projectFileSyncMocks.startProjectFileSync).toHaveBeenCalledWith(
      projB,
      expect.objectContaining({ enabled: true }),
    )
    expect(useWikiStore.getState().project?.id).toBe("b")

    unmount(root)
  })

  it("P1c (SPEC-6 PR2): stale embedding-consumer startup work cannot land after a newer project is queued", async () => {
    const { root } = renderApp()
    await flush()

    const onSelectProject = welcomeScreenProps.current!.onSelectProject
    const projA = project("a", "/tmp/a")
    const projB = project("b", "/tmp/b")
    fsMocks.openProject.mockImplementation(async (path: string) =>
      path === projA.path ? projA : projB,
    )

    // startEmbeddingConsumer's own isStale() checkpoint sits right after
    // ingest-queue restoreQueue (App.tsx) — stall THAT for A specifically
    // so B can be queued while A is still short of reaching its own
    // startEmbeddingConsumer call, mirroring the loadScheduledImportConfig
    // stall the sibling scheduled-import test above uses for the same
    // checkpoint shape.
    const delayedARestore = deferred<undefined>()
    ingestQueueMocks.restoreQueue.mockImplementation(async (_id: string, path: string) =>
      path === projA.path ? delayedARestore.promise : undefined,
    )

    let pA!: Promise<void>
    act(() => {
      pA = onSelectProject(projA)
    })
    await flush()

    let pB!: Promise<void>
    act(() => {
      pB = onSelectProject(projB)
    })
    await flush()

    await act(async () => {
      delayedARestore.resolve(undefined)
    })
    await flush(30)
    await Promise.allSettled([pA, pB])

    expect(embeddingConsumerMocks.startEmbeddingConsumer).not.toHaveBeenCalledWith(projA)
    expect(embeddingConsumerMocks.startEmbeddingConsumer).toHaveBeenCalledWith(projB)
    expect(useWikiStore.getState().project?.id).toBe("b")

    unmount(root)
  })
})
