import { describe, expect, it } from "vitest"
import { createSerialQueue } from "./serial-queue"

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (err: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe("createSerialQueue", () => {
  it("does not start the next task until the previous one has settled", async () => {
    const enqueue = createSerialQueue()
    const order: string[] = []
    const gate = deferred<void>()

    const p1 = enqueue(async () => {
      order.push("1-start")
      await gate.promise
      order.push("1-end")
    })
    const p2 = enqueue(async () => {
      order.push("2-start")
    })

    // Let task 1 actually begin and suspend on the gate.
    await Promise.resolve()
    await Promise.resolve()
    expect(order).toEqual(["1-start"])

    gate.resolve()
    await p1
    await p2

    expect(order).toEqual(["1-start", "1-end", "2-start"])
  })

  it("runs three tasks strictly in enqueue order, never overlapping", async () => {
    const enqueue = createSerialQueue()
    const active: number[] = []
    const maxConcurrent: number[] = []
    const order: number[] = []

    function makeTask(id: number, gate: Promise<void>) {
      return async () => {
        active.push(id)
        maxConcurrent.push(active.length)
        order.push(id)
        await gate
        active.splice(active.indexOf(id), 1)
      }
    }

    const g1 = deferred<void>()
    const g2 = deferred<void>()
    const g3 = deferred<void>()

    const p1 = enqueue(makeTask(1, g1.promise))
    const p2 = enqueue(makeTask(2, g2.promise))
    const p3 = enqueue(makeTask(3, g3.promise))

    await Promise.resolve()
    await Promise.resolve()
    g1.resolve()
    await p1
    await Promise.resolve()
    g2.resolve()
    await p2
    await Promise.resolve()
    g3.resolve()
    await p3

    expect(order).toEqual([1, 2, 3])
    expect(Math.max(...maxConcurrent)).toBe(1)
  })

  it("still runs a later task after an earlier one rejects, and delivers the rejection to its own caller", async () => {
    const enqueue = createSerialQueue()
    const order: string[] = []

    const p1 = enqueue(async () => {
      order.push("1-ran")
      throw new Error("task 1 boom")
    })
    const p2 = enqueue(async () => {
      order.push("2-ran")
    })

    await expect(p1).rejects.toThrow("task 1 boom")
    await p2

    expect(order).toEqual(["1-ran", "2-ran"])
  })

  it("lets an unresolved task block an unbounded number of later tasks", async () => {
    const enqueue = createSerialQueue()
    const order: string[] = []
    const gate = deferred<void>()

    const p1 = enqueue(async () => {
      order.push("1-start")
      await gate.promise
    })
    const p2 = enqueue(async () => {
      order.push("2-start")
    })
    const p3 = enqueue(async () => {
      order.push("3-start")
    })

    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(order).toEqual(["1-start"])

    gate.resolve()
    await Promise.all([p1, p2, p3])
    expect(order).toEqual(["1-start", "2-start", "3-start"])
  })
})
