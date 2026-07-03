// @vitest-environment jsdom

import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import "@/i18n"
import { PreviewPanel } from "./preview-panel"
import { useWikiStore } from "@/stores/wiki-store"
import { useActivityStore } from "@/stores/activity-store"

const fsMocks = vi.hoisted(() => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
}))

vi.mock("@/commands/fs", () => fsMocks)

// WikiEditor pulls in the real Milkdown/ProseMirror stack, which isn't
// meaningful to exercise here — this test is about PreviewPanel's own
// per-file debounce/flush bookkeeping, not the editor internals (those
// are covered by wiki-editor's own usage). Stub it with a thin harness
// that exposes onSave directly so tests can drive it deterministically.
vi.mock("@/components/editor/wiki-editor", () => ({
  WikiEditor: ({
    content,
    onSave,
  }: {
    content: string
    onSave: (markdown: string, options?: { immediate?: boolean }) => void
  }) => {
    return (
      <div data-testid="wiki-editor" data-content={content}>
        <button
          data-testid="type"
          onClick={() => onSave(`${content}-edited`)}
        >
          type
        </button>
        <button
          data-testid="save-now"
          onClick={() => onSave(`${content}-edited`, { immediate: true })}
        >
          save-now
        </button>
        <button
          data-testid="reemit"
          onClick={() => onSave(content)}
        >
          reemit
        </button>
      </div>
    )
  },
}))

vi.mock("@/components/editor/file-preview", () => ({
  FilePreview: ({ filePath }: { filePath: string }) => (
    <div data-testid="file-preview" data-path={filePath} />
  ),
}))

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true

function resetStore(): void {
  useWikiStore.setState({
    selectedFile: null,
    fileContent: "",
    externalPreview: null,
  })
  useActivityStore.setState({ items: [] })
}

function selectFile(path: string | null): void {
  act(() => {
    useWikiStore.getState().setSelectedFile(path)
  })
}

function renderPanel(): { container: HTMLDivElement; root: Root } {
  const container = document.createElement("div")
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => {
    root.render(<PreviewPanel />)
  })
  return { container, root }
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  })
}

async function click(element: Element | null): Promise<void> {
  if (!element) throw new Error("element not found")
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }))
    await Promise.resolve()
  })
}

function unmount(root: Root): void {
  act(() => {
    root.unmount()
  })
}

describe("PreviewPanel per-file debounced save", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    resetStore()
    fsMocks.readFile.mockImplementation(async (path: string) => `content:${path}`)
    fsMocks.writeFile.mockResolvedValue(undefined)
  })

  afterEach(() => {
    resetStore()
    vi.useRealTimers()
    document.body.innerHTML = ""
  })

  it("writes debounced edits to disk for the selected file after 1s", async () => {
    const { container, root } = renderPanel()
    selectFile("/proj/a.md")
    await flush()

    await click(container.querySelector("[data-testid='type']"))
    expect(fsMocks.writeFile).not.toHaveBeenCalled()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
    })

    expect(fsMocks.writeFile).toHaveBeenCalledTimes(1)
    expect(fsMocks.writeFile).toHaveBeenCalledWith("/proj/a.md", "content:/proj/a.md-edited")

    unmount(root)
  })

  it("keeps concurrent edits to two files isolated on disk (edit A, switch to B within 1s, edit B)", async () => {
    const { container, root } = renderPanel()
    selectFile("/proj/a.md")
    await flush()
    await click(container.querySelector("[data-testid='type']"))

    // Switch to B before A's debounce fires. A must be flushed immediately.
    selectFile("/proj/b.md")
    await flush()
    expect(fsMocks.writeFile).toHaveBeenCalledWith("/proj/a.md", "content:/proj/a.md-edited")

    await click(container.querySelector("[data-testid='type']"))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
    })

    expect(fsMocks.writeFile).toHaveBeenCalledWith("/proj/b.md", "content:/proj/b.md-edited")
    expect(fsMocks.writeFile).toHaveBeenCalledTimes(2)

    unmount(root)
  })

  it("flushes a pending write when switching away without editing the new file, and does not pollute the new file's display", async () => {
    const { container, root } = renderPanel()
    selectFile("/proj/a.md")
    await flush()
    await click(container.querySelector("[data-testid='type']"))

    selectFile("/proj/b.md")
    await flush()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500)
    })

    expect(fsMocks.writeFile).toHaveBeenCalledTimes(1)
    expect(fsMocks.writeFile).toHaveBeenCalledWith("/proj/a.md", "content:/proj/a.md-edited")
    // B's displayed content must remain B's own loaded content, not A's.
    expect(useWikiStore.getState().fileContent).toBe("content:/proj/b.md")

    unmount(root)
  })

  it("does not silently drop A's pending edit when switching to B and editing B (no plain clearTimeout)", async () => {
    const { container, root } = renderPanel()
    selectFile("/proj/a.md")
    await flush()
    await click(container.querySelector("[data-testid='type']"))

    selectFile("/proj/b.md")
    await flush()
    await click(container.querySelector("[data-testid='type']"))

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500)
    })

    const calls = fsMocks.writeFile.mock.calls.map((c: unknown[]) => c[0])
    expect(calls).toContain("/proj/a.md")
    expect(calls).toContain("/proj/b.md")

    unmount(root)
  })

  it("surfaces writeFile failures to the activity store instead of only console.error", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {})
    fsMocks.writeFile.mockRejectedValueOnce(new Error("EACCES: permission denied"))

    const { container, root } = renderPanel()
    selectFile("/proj/a.md")
    await flush()
    await click(container.querySelector("[data-testid='type']"))

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
    })
    await flush()

    const errors = useActivityStore.getState().items.filter(
      (item) => item.type === "autosave" && item.status === "error"
    )
    expect(errors).toHaveLength(1)
    expect(errors[0].detail).toMatch(/a\.md/)
    expect(errors[0].detail).toMatch(/permission denied/i)

    consoleError.mockRestore()
    unmount(root)
  })

  it("keeps multiple files isolated across a rapid A -> B -> C -> A switch sequence", async () => {
    const { container, root } = renderPanel()

    selectFile("/proj/a.md")
    await flush()
    await click(container.querySelector("[data-testid='type']"))

    selectFile("/proj/b.md")
    await flush()
    await click(container.querySelector("[data-testid='type']"))

    selectFile("/proj/c.md")
    await flush()
    await click(container.querySelector("[data-testid='type']"))

    selectFile("/proj/a.md")
    await flush()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500)
    })

    const calls = fsMocks.writeFile.mock.calls as [string, string][]
    const aWrites = calls.filter(([path]) => path === "/proj/a.md")
    const bWrites = calls.filter(([path]) => path === "/proj/b.md")
    const cWrites = calls.filter(([path]) => path === "/proj/c.md")

    expect(aWrites).toHaveLength(1)
    expect(aWrites[0][1]).toBe("content:/proj/a.md-edited")
    expect(bWrites).toHaveLength(1)
    expect(bWrites[0][1]).toBe("content:/proj/b.md-edited")
    expect(cWrites).toHaveLength(1)
    expect(cWrites[0][1]).toBe("content:/proj/c.md-edited")

    unmount(root)
  })

  it("saves immediately on Cmd/Ctrl+S (immediate option) without waiting for the debounce", async () => {
    const { container, root } = renderPanel()
    selectFile("/proj/a.md")
    await flush()

    await click(container.querySelector("[data-testid='save-now']"))

    expect(fsMocks.writeFile).toHaveBeenCalledTimes(1)
    expect(fsMocks.writeFile).toHaveBeenCalledWith("/proj/a.md", "content:/proj/a.md-edited")

    unmount(root)
  })

  it("does not double-write when an immediate save follows a pending debounce", async () => {
    const { container, root } = renderPanel()
    selectFile("/proj/a.md")
    await flush()

    await click(container.querySelector("[data-testid='type']"))
    await click(container.querySelector("[data-testid='save-now']"))

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500)
    })

    expect(fsMocks.writeFile).toHaveBeenCalledTimes(1)

    unmount(root)
  })

  it("does not write for a read-only externalPreview file", async () => {
    act(() => {
      useWikiStore.getState().setSelectedFile("https://example.com/ref")
      useWikiStore.getState().setExternalPreview({
        title: "Ref",
        path: "https://example.com/ref",
        source: "web",
        url: "https://example.com/ref",
        snippet: "snippet text",
      })
    })
    const { root } = renderPanel()
    await flush()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000)
    })

    expect(fsMocks.writeFile).not.toHaveBeenCalled()
    expect(fsMocks.readFile).not.toHaveBeenCalled()

    unmount(root)
  })

  it("skips saving Milkdown's initial no-op re-emit (markdown equals last-loaded snapshot) per file", async () => {
    const { container, root } = renderPanel()
    selectFile("/proj/a.md")
    await flush()

    await click(container.querySelector("[data-testid='reemit']"))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500)
    })

    expect(fsMocks.writeFile).not.toHaveBeenCalled()

    unmount(root)
  })

  it("does not let a stale readFile resolution for a file the user has navigated away from clobber the currently displayed file (load-path race)", async () => {
    let resolveB: ((content: string) => void) | undefined
    fsMocks.readFile.mockImplementation((path: string) => {
      if (path === "/proj/b.md") {
        return new Promise<string>((resolve) => {
          resolveB = resolve
        })
      }
      return Promise.resolve(`content:${path}`)
    })

    const { root } = renderPanel()

    // Select B first — its readFile call hangs.
    selectFile("/proj/b.md")
    await flush()

    // Switch to C before B's readFile resolves. C loads immediately.
    selectFile("/proj/c.md")
    await flush()
    expect(useWikiStore.getState().fileContent).toBe("content:/proj/c.md")

    // B's readFile now resolves late — it must not overwrite C's display.
    await act(async () => {
      resolveB?.("content:/proj/b.md")
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(useWikiStore.getState().selectedFile).toBe("/proj/c.md")
    expect(useWikiStore.getState().fileContent).toBe("content:/proj/c.md")

    unmount(root)
  })

  it("resyncs the display when the user switches back to a file before its flush-on-switch write resolves", async () => {
    let resolveWriteA: (() => void) | undefined
    fsMocks.writeFile.mockImplementation((path: string) => {
      if (path === "/proj/a.md") {
        return new Promise<void>((resolve) => {
          resolveWriteA = resolve
        })
      }
      return Promise.resolve(undefined)
    })

    const { container, root } = renderPanel()
    selectFile("/proj/a.md")
    await flush()
    await click(container.querySelector("[data-testid='type']"))

    // Switch to B before A's debounce fires — this flushes A's pending
    // edit via writeNow, but the write is still in flight.
    selectFile("/proj/b.md")
    await flush()
    expect(fsMocks.writeFile).toHaveBeenCalledWith("/proj/a.md", "content:/proj/a.md-edited")

    // Switch back to A quickly, before A's flush write resolves.
    selectFile("/proj/a.md")
    await flush()

    // Now let A's flush write resolve. Since the user is back on A, the
    // flushed content must sync into the display.
    await act(async () => {
      resolveWriteA?.()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(useWikiStore.getState().selectedFile).toBe("/proj/a.md")
    expect(useWikiStore.getState().fileContent).toBe("content:/proj/a.md-edited")

    unmount(root)
  })
})
