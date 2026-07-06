import { beforeEach, describe, expect, it } from "vitest"
import { useResearchStore } from "./research-store"

describe("research store project-scoped queue helpers", () => {
  beforeEach(() => {
    useResearchStore.setState({ tasks: [], maxConcurrent: 3 })
  })

  it("counts running tasks only for the requested project", () => {
    const store = useResearchStore.getState()
    const taskA = store.addTask("alpha", "/project-a")
    const taskB = store.addTask("beta", "/project-b")

    store.updateTask(taskA, { status: "searching" })
    store.updateTask(taskB, { status: "saving" })

    expect(useResearchStore.getState().getRunningCount("/project-a")).toBe(1)
    expect(useResearchStore.getState().getRunningCount("/project-b")).toBe(1)
    expect(useResearchStore.getState().getRunningCount("/project-c")).toBe(0)
  })

  it("counts active tasks including queued for the requested project", () => {
    const store = useResearchStore.getState()
    const queued = store.addTask("queued", "/project-a")
    const searching = store.addTask("searching", "/project-a")
    const done = store.addTask("done", "/project-a")
    const error = store.addTask("error", "/project-a")
    store.addTask("other", "/project-b")

    store.updateTask(searching, { status: "searching" })
    store.updateTask(done, { status: "done" })
    store.updateTask(error, { status: "error" })

    expect(queued).toBeDefined()
    expect(useResearchStore.getState().getActiveResearchCount("/project-a")).toBe(2)
    expect(useResearchStore.getState().getActiveResearchCount("/project-b")).toBe(1)
    expect(useResearchStore.getState().getActiveResearchCount("/project-c")).toBe(0)
  })

  it("returns the next queued task only for the requested project", () => {
    const store = useResearchStore.getState()
    const taskA = store.addTask("alpha", "/project-a")
    const taskB = store.addTask("beta", "/project-b")

    expect(useResearchStore.getState().getNextQueued("/project-b")?.id).toBe(taskB)
    expect(useResearchStore.getState().getNextQueued("/project-a")?.id).toBe(taskA)
    expect(useResearchStore.getState().getNextQueued("/project-c")).toBeUndefined()
  })
})
