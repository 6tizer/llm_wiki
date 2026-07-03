import { describe, expect, it, vi } from "vitest"
import { persistMany, persistSetting } from "./store-helpers"

describe("persistSetting", () => {
  it("sets the next value immediately and keeps it when persist succeeds", async () => {
    let current = "old"
    const set = vi.fn((value: string) => {
      current = value
    })
    const persist = vi.fn(async () => {})

    const ok = await persistSetting("old", "new", set, persist, () => current)

    expect(ok).toBe(true)
    expect(current).toBe("new")
    expect(set).toHaveBeenCalledTimes(1)
    expect(set).toHaveBeenCalledWith("new")
    expect(persist).toHaveBeenCalledWith("new")
  })

  it("reverts to prevValue and calls onError when persist rejects", async () => {
    let current = "old"
    const set = vi.fn((value: string) => {
      current = value
    })
    const error = new Error("disk full")
    const persist = vi.fn(async () => {
      throw error
    })
    const onError = vi.fn()

    const ok = await persistSetting("old", "new", set, persist, () => current, { onError })

    expect(ok).toBe(false)
    expect(current).toBe("old")
    expect(set).toHaveBeenNthCalledWith(1, "new")
    expect(set).toHaveBeenNthCalledWith(2, "old")
    expect(onError).toHaveBeenCalledWith(error, "old")
  })

  it("works without an onError callback", async () => {
    const set = vi.fn()
    const persist = vi.fn(async () => {
      throw new Error("boom")
    })

    await expect(persistSetting(1, 2, set, persist, () => 2)).resolves.toBe(false)
  })

  it("does not revert when a later fire-and-forget call already applied a newer value", async () => {
    // Mirrors how UI sections call this: onChange handlers fire without
    // awaiting the previous call. opA's persist is slow and eventually
    // rejects; opB fires and succeeds in the meantime. opA's revert
    // must not stomp opB's already-applied (and saved) value.
    let current = "old"
    const set = (value: string) => {
      current = value
    }

    let releaseA: () => void = () => {}
    const gateA = new Promise<void>((resolve) => {
      releaseA = resolve
    })
    const persistA = vi.fn(async () => {
      await gateA
      throw new Error("opA persist failed")
    })
    const onErrorA = vi.fn()

    const promiseA = persistSetting("old", "A", set, persistA, () => current, { onError: onErrorA })

    // opB starts (and finishes) while opA's persist is still pending.
    const persistB = vi.fn(async () => {})
    const okB = await persistSetting("A", "B", set, persistB, () => current)
    expect(okB).toBe(true)
    expect(current).toBe("B")

    releaseA()
    const okA = await promiseA

    expect(okA).toBe(false)
    // opA's revert would set "old" — asserting it did NOT stomp opB's "B".
    expect(current).toBe("B")
    expect(onErrorA).toHaveBeenCalled()
  })
})

describe("persistMany", () => {
  it("applies all fields and keeps them when persist succeeds", async () => {
    const state = { a: "old-a", b: "old-b" }

    const ok = await persistMany(
      () => {
        state.a = "new-a"
        state.b = "new-b"
      },
      () => {
        state.a = "old-a"
        state.b = "old-b"
      },
      async () => {},
      () => state.a === "new-a" && state.b === "new-b",
    )

    expect(ok).toBe(true)
    expect(state).toEqual({ a: "new-a", b: "new-b" })
  })

  it("reverts every field it applied when persist rejects partway through", async () => {
    const state = { a: "old-a", b: "old-b" }
    const error = new Error("second write failed")
    const onError = vi.fn()

    const ok = await persistMany(
      () => {
        state.a = "new-a"
        state.b = "new-b"
      },
      () => {
        state.a = "old-a"
        state.b = "old-b"
      },
      async () => {
        // Simulates the first disk write succeeding and the second one
        // (a separate field entirely) failing — the whole action must
        // still be treated as failed and every applied field reverted,
        // not just the field tied to the write that rejected.
        await Promise.resolve()
        throw error
      },
      () => state.a === "new-a" && state.b === "new-b",
      { onError },
    )

    expect(ok).toBe(false)
    expect(state).toEqual({ a: "old-a", b: "old-b" })
    expect(onError).toHaveBeenCalledWith(error)
  })

  it("works without an onError callback", async () => {
    const apply = vi.fn()
    const revert = vi.fn()
    const persist = vi.fn(async () => {
      throw new Error("boom")
    })

    await expect(persistMany(apply, revert, persist, () => true)).resolves.toBe(false)
    expect(revert).toHaveBeenCalledTimes(1)
  })

  it("does not revert when a later fire-and-forget call already applied newer fields", async () => {
    const state = { value: "old" }

    let releaseA: () => void = () => {}
    const gateA = new Promise<void>((resolve) => {
      releaseA = resolve
    })
    const persistA = vi.fn(async () => {
      await gateA
      throw new Error("opA failed")
    })

    const promiseA = persistMany(
      () => {
        state.value = "A"
      },
      () => {
        state.value = "old"
      },
      persistA,
      () => state.value === "A",
    )

    const okB = await persistMany(
      () => {
        state.value = "B"
      },
      () => {
        state.value = "A"
      },
      async () => {},
      () => state.value === "B",
    )
    expect(okB).toBe(true)
    expect(state.value).toBe("B")

    releaseA()
    const okA = await promiseA

    expect(okA).toBe(false)
    expect(state.value).toBe("B")
  })
})
