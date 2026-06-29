import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  runtimeJobCancel,
  runtimeJobList,
  runtimeJobPause,
  runtimeJobResume,
} from "./runtime-db"

const tauriMocks = vi.hoisted(() => ({
  invoke: vi.fn(),
}))

vi.mock("@tauri-apps/api/core", () => tauriMocks)

describe("runtime-db commands", () => {
  beforeEach(() => {
    tauriMocks.invoke.mockReset()
  })

  it("lists runtime jobs with the pure list command", async () => {
    tauriMocks.invoke.mockResolvedValue({ enabled: true, status: "healthy", jobs: [], leases: [] })

    await runtimeJobList()

    expect(tauriMocks.invoke).toHaveBeenCalledWith("runtime_job_list")
  })

  it("sends cancel, pause, and resume request payloads by job id only", async () => {
    tauriMocks.invoke.mockResolvedValue({ jobId: "job-1" })

    await runtimeJobCancel("job-1")
    await runtimeJobPause("job-2")
    await runtimeJobResume("job-3")

    expect(tauriMocks.invoke).toHaveBeenNthCalledWith(1, "runtime_job_cancel", {
      request: { jobId: "job-1" },
    })
    expect(tauriMocks.invoke).toHaveBeenNthCalledWith(2, "runtime_job_pause", {
      request: { jobId: "job-2" },
    })
    expect(tauriMocks.invoke).toHaveBeenNthCalledWith(3, "runtime_job_resume", {
      request: { jobId: "job-3" },
    })
  })
})
