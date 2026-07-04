// @vitest-environment jsdom

import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { describe, expect, it, vi } from "vitest"
import { useProjectPersistedResource } from "./use-project-persisted-resource"

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (err: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

interface Snapshot {
  state: string
  loading: boolean
  error: string | null
}

function last(snapshots: Snapshot[]): Snapshot | undefined {
  return snapshots[snapshots.length - 1]
}

function renderHarness(
  initialPath: string | undefined,
  load: (path: string) => Promise<string>,
): {
  root: Root
  snapshots: Snapshot[]
  rerender: (path: string | undefined) => void
} {
  const container = document.createElement("div")
  document.body.appendChild(container)
  const root = createRoot(container)
  const snapshots: Snapshot[] = []

  function Harness({ path }: { path: string | undefined }) {
    const result = useProjectPersistedResource<string>(path, load, "fallback")
    snapshots.push({ ...result })
    return null
  }

  act(() => {
    root.render(createElement(Harness, { path: initialPath }))
  })

  return {
    root,
    snapshots,
    rerender: (path: string | undefined) => {
      act(() => {
        root.render(createElement(Harness, { path }))
      })
    },
  }
}

function unmount(root: Root): void {
  act(() => {
    root.unmount()
  })
}

describe("useProjectPersistedResource", () => {
  it("returns the fallback immediately when there is no project path", () => {
    const load = vi.fn(async (_path: string) => "loaded")
    const { root, snapshots } = renderHarness(undefined, load)

    expect(load).not.toHaveBeenCalled()
    expect(last(snapshots)).toEqual({ state: "fallback", loading: false, error: null })

    unmount(root)
  })

  it("loads for the given path and reports loading in between", async () => {
    const d = deferred<string>()
    const load = vi.fn(async (path: string) => {
      expect(path).toBe("/tmp/a")
      return d.promise
    })
    const { root, snapshots } = renderHarness("/tmp/a", load)

    expect(last(snapshots)).toMatchObject({ state: "fallback", loading: true })

    await act(async () => {
      d.resolve("data-for-a")
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(last(snapshots)).toEqual({ state: "data-for-a", loading: false, error: null })

    unmount(root)
  })

  it("discards a stale resolve when projectPath changes before the load lands", async () => {
    const pending: Record<string, ReturnType<typeof deferred<string>>> = {
      "/tmp/a": deferred<string>(),
      "/tmp/b": deferred<string>(),
    }
    const load = vi.fn(async (path: string) => pending[path].promise)

    const { root, snapshots, rerender } = renderHarness("/tmp/a", load)

    // Switch to project B before A's load resolves.
    rerender("/tmp/b")

    // A's stale load resolves AFTER the switch — must not land.
    await act(async () => {
      pending["/tmp/a"].resolve("data-for-a")
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(last(snapshots)?.state).not.toBe("data-for-a")

    // B's load resolving normally DOES land.
    await act(async () => {
      pending["/tmp/b"].resolve("data-for-b")
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(last(snapshots)).toEqual({ state: "data-for-b", loading: false, error: null })

    unmount(root)
  })

  it("falls back and reports an error string when the load rejects", async () => {
    const d = deferred<string>()
    const load = vi.fn(async (_path: string) => d.promise)
    const { root, snapshots } = renderHarness("/tmp/a", load)

    await act(async () => {
      d.reject(new Error("disk read failed"))
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(last(snapshots)).toEqual({
      state: "fallback",
      loading: false,
      error: "disk read failed",
    })

    unmount(root)
  })

  it("discards a stale resolve when the component unmounts before the load lands", async () => {
    const d = deferred<string>()
    const load = vi.fn(async (_path: string) => d.promise)
    const { root } = renderHarness("/tmp/a", load)

    unmount(root)

    // Resolving after unmount must not throw or warn about setting state
    // on an unmounted component.
    await expect(
      (async () => {
        d.resolve("too-late")
        await Promise.resolve()
        await Promise.resolve()
      })(),
    ).resolves.toBeUndefined()
  })
})
