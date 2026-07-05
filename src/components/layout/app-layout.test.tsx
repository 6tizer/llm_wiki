// @vitest-environment jsdom

import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import "@/i18n"
import {
  SIDEBAR_COLLAPSED_STORAGE_KEY,
  useWikiStore,
} from "@/stores/wiki-store"
import { AppLayout } from "./app-layout"

const fsMocks = vi.hoisted(() => ({
  listDirectory: vi.fn(),
}))

vi.mock("@/commands/fs", () => fsMocks)
vi.mock("./icon-sidebar", () => ({
  IconSidebar: () => <nav data-testid="icon-sidebar" />,
}))
vi.mock("./update-banner", () => ({
  UpdateBanner: () => null,
}))
vi.mock("./sidebar-panel", () => ({
  SidebarPanel: () => <div data-testid="sidebar-panel" />,
}))
vi.mock("./content-area", () => ({
  ContentArea: () => <main data-testid="content-area" />,
}))
vi.mock("./preview-panel", () => ({
  PreviewPanel: () => <aside data-testid="preview-panel" />,
}))
vi.mock("./activity-panel", () => ({
  ActivityPanel: () => <div data-testid="activity-panel" />,
}))

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true

function stubLocalStorage(options: {
  initial?: Record<string, string>
  getItem?: (key: string) => string | null
  setItem?: (key: string, value: string) => void
} = {}) {
  const storage = new Map<string, string>(Object.entries(options.initial ?? {}))
  vi.stubGlobal("localStorage", {
    getItem: vi.fn((key: string) => options.getItem?.(key) ?? storage.get(key) ?? null),
    removeItem: vi.fn((key: string) => {
      storage.delete(key)
    }),
    setItem: vi.fn((key: string, value: string) => {
      if (options.setItem) {
        options.setItem(key, value)
        return
      }
      storage.set(key, value)
    }),
  })
  return storage
}

function renderLayout(): { container: HTMLDivElement; root: Root } {
  const container = document.createElement("div")
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => {
    root.render(<AppLayout onSwitchProject={vi.fn()} />)
  })
  return { container, root }
}

function unmount(root: Root): void {
  act(() => {
    root.unmount()
  })
}

async function click(element: Element | null): Promise<void> {
  if (!element) throw new Error("element not found")
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }))
    await Promise.resolve()
  })
}

function drag(element: Element, startX: number, moveX: number): void {
  act(() => {
    element.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, clientX: startX }))
    document.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: moveX }))
    document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }))
  })
}

function mockLayoutRect(width: number): void {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    right: width,
    bottom: 800,
    width,
    height: 800,
    toJSON: () => ({}),
  } as DOMRect)
}

async function importFreshWikiStore() {
  vi.resetModules()
  return import("@/stores/wiki-store")
}

beforeEach(() => {
  vi.clearAllMocks()
  stubLocalStorage()
  useWikiStore.setState({
    activeView: "wiki",
    selectedFile: null,
    sidebarCollapsed: false,
    project: null,
    fileTree: [],
  })
})

afterEach(() => {
  useWikiStore.setState({
    activeView: "wiki",
    selectedFile: null,
    sidebarCollapsed: false,
    project: null,
    fileTree: [],
  })
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  document.body.innerHTML = ""
})

describe("AppLayout sidebar placement and collapse", () => {
  it("renders center content and preview before the right-edge sidebar", () => {
    useWikiStore.setState({ selectedFile: "/project/wiki/page.md" })

    const { container, root } = renderLayout()
    const content = container.querySelector("[data-testid='content-area']")!
    const preview = container.querySelector("[data-testid='preview-panel']")!
    const sidebar = container.querySelector("[data-testid='sidebar-panel']")!

    expect(content.compareDocumentPosition(preview) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(preview.compareDocumentPosition(sidebar) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()

    unmount(root)
  })

  it("renders the collapsed strip from initial store state with content before it", () => {
    useWikiStore.setState({ sidebarCollapsed: true })

    const { container, root } = renderLayout()
    const content = container.querySelector("[data-testid='content-area']")!
    const strip = container.querySelector("[data-testid='sidebar-collapsed-strip']")!

    expect(strip).not.toBeNull()
    expect(container.querySelector("[data-testid='sidebar-panel']")).toBeNull()
    expect(container.querySelector("[data-testid='activity-panel']")).toBeNull()
    expect(container.querySelector("[data-testid='sidebar-resize-handle']")).toBeNull()
    expect(content.compareDocumentPosition(strip) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()

    unmount(root)
  })

  it("collapses and expands the right sidebar from the panel controls", async () => {
    const { container, root } = renderLayout()

    expect(container.querySelector("[data-testid='sidebar-panel']")).not.toBeNull()
    expect(container.querySelector("[data-testid='activity-panel']")).not.toBeNull()
    expect(container.querySelector("[data-testid='sidebar-resize-handle']")).not.toBeNull()

    await click(container.querySelector("button[aria-label='Collapse sidebar']"))

    expect(useWikiStore.getState().sidebarCollapsed).toBe(true)
    expect(container.querySelector("[data-testid='sidebar-panel']")).toBeNull()
    expect(container.querySelector("[data-testid='activity-panel']")).toBeNull()
    expect(container.querySelector("[data-testid='sidebar-resize-handle']")).toBeNull()
    expect(container.querySelector("[data-testid='sidebar-collapsed-strip']")).not.toBeNull()

    await click(container.querySelector("button[aria-label='Expand sidebar']"))

    expect(useWikiStore.getState().sidebarCollapsed).toBe(false)
    expect(container.querySelector("[data-testid='sidebar-panel']")).not.toBeNull()
    expect(container.querySelector("[data-testid='sidebar-resize-handle']")).not.toBeNull()

    unmount(root)
  })

  it("persists collapsed state changes to localStorage", async () => {
    const { container, root } = renderLayout()

    await click(container.querySelector("button[aria-label='Collapse sidebar']"))
    expect(window.localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY)).toBe("true")

    await click(container.querySelector("button[aria-label='Expand sidebar']"))
    expect(window.localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY)).toBe("false")

    unmount(root)
  })

  it("keeps UI state updated when localStorage writes fail", () => {
    stubLocalStorage({
      setItem: () => {
        throw new Error("quota exceeded")
      },
    })

    act(() => {
      useWikiStore.getState().setSidebarCollapsed(true)
    })

    expect(useWikiStore.getState().sidebarCollapsed).toBe(true)
  })

  it("keeps the preview handle near content and hides only the sidebar handle when collapsed", async () => {
    useWikiStore.setState({ selectedFile: "/project/wiki/page.md" })

    const { container, root } = renderLayout()

    expect(container.querySelector("[data-testid='preview-resize-handle']")).not.toBeNull()
    expect(container.querySelector("[data-testid='sidebar-resize-handle']")).not.toBeNull()

    await click(container.querySelector("button[aria-label='Collapse sidebar']"))

    expect(container.querySelector("[data-testid='preview-resize-handle']")).not.toBeNull()
    expect(container.querySelector("[data-testid='sidebar-resize-handle']")).toBeNull()

    unmount(root)
  })

  it("resizes the right-edge sidebar from its left handle in both directions", () => {
    const first = renderLayout()
    drag(first.container.querySelector("[data-testid='sidebar-resize-handle']")!, 100, 80)
    expect((first.container.querySelector("[data-testid='sidebar-panel-shell']") as HTMLElement).style.width).toBe("240px")
    unmount(first.root)

    const second = renderLayout()
    drag(second.container.querySelector("[data-testid='sidebar-resize-handle']")!, 100, 120)
    expect((second.container.querySelector("[data-testid='sidebar-panel-shell']") as HTMLElement).style.width).toBe("200px")
    unmount(second.root)
  })

  it("clamps sidebar resize at its minimum and maximum widths", () => {
    const min = renderLayout()
    drag(min.container.querySelector("[data-testid='sidebar-resize-handle']")!, 100, 1000)
    expect((min.container.querySelector("[data-testid='sidebar-panel-shell']") as HTMLElement).style.width).toBe("150px")
    unmount(min.root)

    const max = renderLayout()
    drag(max.container.querySelector("[data-testid='sidebar-resize-handle']")!, 100, -500)
    expect((max.container.querySelector("[data-testid='sidebar-panel-shell']") as HTMLElement).style.width).toBe("400px")
    unmount(max.root)
  })

  it("resizes preview from its left handle and clamps to the minimum width", () => {
    mockLayoutRect(1000)
    useWikiStore.setState({ selectedFile: "/project/wiki/page.md" })

    const first = renderLayout()
    drag(first.container.querySelector("[data-testid='preview-resize-handle']")!, 100, 80)
    expect((first.container.querySelector("[data-testid='preview-panel-shell']") as HTMLElement).style.width).toBe("420px")
    unmount(first.root)

    const min = renderLayout()
    drag(min.container.querySelector("[data-testid='preview-resize-handle']")!, 100, 400)
    expect((min.container.querySelector("[data-testid='preview-panel-shell']") as HTMLElement).style.width).toBe("250px")
    unmount(min.root)
  })

  it("does not render the sidebar chrome on settings", () => {
    useWikiStore.setState({ activeView: "settings", selectedFile: "/project/wiki/page.md" })

    const { container, root } = renderLayout()

    expect(container.querySelector("[data-testid='content-area']")).not.toBeNull()
    expect(container.querySelector("[data-testid='preview-panel']")).toBeNull()
    expect(container.querySelector("[data-testid='sidebar-panel']")).toBeNull()
    expect(container.querySelector("[data-testid='sidebar-collapsed-strip']")).toBeNull()

    unmount(root)
  })
})

describe("wiki-store sidebarCollapsed localStorage hydration", () => {
  it("hydrates collapsed=true from localStorage", async () => {
    stubLocalStorage({ initial: { [SIDEBAR_COLLAPSED_STORAGE_KEY]: "true" } })

    const { useWikiStore: freshStore } = await importFreshWikiStore()

    expect(freshStore.getState().sidebarCollapsed).toBe(true)
  })

  it.each(["1", "yes", "garbage"])("treats damaged value %s as expanded", async (value) => {
    stubLocalStorage({ initial: { [SIDEBAR_COLLAPSED_STORAGE_KEY]: value } })

    const { useWikiStore: freshStore } = await importFreshWikiStore()

    expect(freshStore.getState().sidebarCollapsed).toBe(false)
  })

  it("falls back to expanded when localStorage read throws", async () => {
    stubLocalStorage({
      getItem: () => {
        throw new Error("storage unavailable")
      },
    })

    const { useWikiStore: freshStore } = await importFreshWikiStore()

    expect(freshStore.getState().sidebarCollapsed).toBe(false)
  })
})
