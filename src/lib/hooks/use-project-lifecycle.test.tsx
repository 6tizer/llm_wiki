// @vitest-environment jsdom

import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { useWikiStore } from "@/stores/wiki-store"
import type { SourceWatchConfig } from "@/stores/wiki-store"
import type { WikiProject } from "@/types/wiki"
import type { ProjectLifecycleHandlers } from "./use-project-lifecycle"
import { useProjectLifecycle } from "./use-project-lifecycle"

const order = vi.hoisted(() => [] as string[])

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(async () => null),
}))

vi.mock("@/commands/fs", () => ({
  listDirectory: vi.fn(async () => []),
  openProject: vi.fn(async (path: string) => ({ id: path, name: path, path })),
}))

vi.mock("@/lib/reset-project-state", () => ({
  resetProjectState: vi.fn(async () => {
    order.push("resetProjectState")
  }),
}))

const agentSettingsMocks = vi.hoisted(() => ({
  loadAgentResourceConfig: vi.fn(),
}))
vi.mock("@/lib/agent/agent-settings", async () => {
  const actual = await vi.importActual<typeof import("@/lib/agent/agent-settings")>(
    "@/lib/agent/agent-settings",
  )
  agentSettingsMocks.loadAgentResourceConfig.mockImplementation(async (path: string) => {
    order.push(`loadAgentResourceConfig:${path}`)
    return actual.DEFAULT_AGENT_RESOURCE_CONFIG
  })
  return { ...actual, loadAgentResourceConfig: agentSettingsMocks.loadAgentResourceConfig }
})

vi.mock("@/lib/project-store", () => ({
  getRecentProjects: vi.fn(async () => []),
  saveLastProject: vi.fn(async () => undefined),
  loadOutputLanguage: vi.fn(async () => null),
  loadScheduledImportConfig: vi.fn(async () => null),
  saveScheduledImportConfig: vi.fn(async () => undefined),
  loadSourceWatchConfig: vi.fn(async (): Promise<SourceWatchConfig> => ({
    enabled: false,
    autoIngest: false,
    includeExtensions: [],
    excludeExtensions: [],
    excludeDirs: [],
    excludeGlobs: [],
    maxFileSizeMb: 10,
  })),
}))

vi.mock("@/lib/ingest-queue", () => ({
  restoreQueue: vi.fn(async (id: string) => {
    order.push(`restoreQueue:${id}`)
  }),
}))

vi.mock("@/lib/dedup-queue", () => ({
  restoreQueue: vi.fn(async () => undefined),
}))

vi.mock("@/lib/derived-rebuild/embedding-consumer", () => ({
  startEmbeddingConsumer: vi.fn(),
}))

vi.mock("@/lib/derived-rebuild/taxonomy-consumer", () => ({
  startTaxonomyConsumer: vi.fn(),
}))

vi.mock("@/lib/scheduled-import", () => ({
  startScheduledImport: vi.fn(),
  stopScheduledImport: vi.fn(),
}))

vi.mock("@/lib/project-file-sync", () => ({
  startProjectFileSync: vi.fn(async () => undefined),
  stopProjectFileSync: vi.fn(async () => undefined),
}))

vi.mock("@/lib/persist", () => ({
  cleanExpiredAgentSessions: vi.fn(async () => undefined),
  loadReviewItems: vi.fn(async () => []),
  loadLintItems: vi.fn(async () => []),
  loadChatHistory: vi.fn(async () => ({ conversations: [], messages: [] })),
}))

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true

const fetchMock = vi.fn(async () => new Response(null, { status: 204 }))
vi.stubGlobal("fetch", fetchMock)

function project(id: string, path: string): WikiProject {
  return { id, name: id, path }
}

function renderHookHarness(): { root: Root; getHandlers: () => ProjectLifecycleHandlers } {
  const container = document.createElement("div")
  document.body.appendChild(container)
  const root = createRoot(container)
  let handlers: ProjectLifecycleHandlers | null = null

  function Harness() {
    handlers = useProjectLifecycle()
    return null
  }

  act(() => {
    root.render(createElement(Harness))
  })

  return {
    root,
    getHandlers: () => {
      if (!handlers) throw new Error("hook did not render")
      return handlers
    },
  }
}

function unmount(root: Root): void {
  act(() => {
    root.unmount()
  })
}

describe("useProjectLifecycle", () => {
  const originalSetProject = useWikiStore.getState().setProject

  beforeEach(() => {
    vi.clearAllMocks()
    order.length = 0
    useWikiStore.setState({
      project: null,
      fileTree: [],
      setProject: (next) => {
        order.push(`setProject:${next?.id ?? "null"}`)
        originalSetProject(next)
      },
    })
  })

  afterEach(() => {
    useWikiStore.setState({
      project: null,
      fileTree: [],
      setProject: originalSetProject,
    })
    vi.restoreAllMocks()
  })

  it("runs resetProjectState before project population and queue restore", async () => {
    const { root, getHandlers } = renderHookHarness()
    const proj = project("a", "/tmp/a")

    await act(async () => {
      await getHandlers().handleProjectOpened(proj)
    })

    expect(order).toEqual(
      expect.arrayContaining([
        "resetProjectState",
        `loadAgentResourceConfig:${proj.path}`,
        `setProject:${proj.id}`,
        `restoreQueue:${proj.id}`,
      ]),
    )
    expect(order.indexOf("resetProjectState")).toBeLessThan(
      order.indexOf(`loadAgentResourceConfig:${proj.path}`),
    )
    expect(order.indexOf("resetProjectState")).toBeLessThan(
      order.indexOf(`setProject:${proj.id}`),
    )
    expect(order.indexOf("resetProjectState")).toBeLessThan(
      order.indexOf(`restoreQueue:${proj.id}`),
    )

    unmount(root)
  })
})
