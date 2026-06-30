import { beforeEach, describe, expect, it, vi } from "vitest"
import { routeMarkdownConflictRepair } from "./markdown-commit-repair"
import {
  runtimeJobCreate,
  runtimeStagingArtifactRecord,
} from "./runtime-db"
import type { MarkdownCommitConflictRepairContext } from "@/core-runtime/markdown-commit"

vi.mock("./runtime-db", () => ({
  runtimeJobCreate: vi.fn(),
  runtimeStagingArtifactRecord: vi.fn(),
}))

const runtimeJobCreateMock = vi.mocked(runtimeJobCreate)
const runtimeStagingArtifactRecordMock = vi.mocked(runtimeStagingArtifactRecord)

function conflictContext(
  overrides: Partial<MarkdownCommitConflictRepairContext> = {},
): MarkdownCommitConflictRepairContext {
  return {
    artifactId: "artifact-1",
    jobId: "job-1",
    artifactPath: "job-1/artifact.md",
    artifactHash: "sha256:artifact",
    targetPath: "wiki/Page.md",
    operationIntent: "update",
    result: "conflicted",
    baseHash: "sha256:base",
    currentHash: "sha256:changed",
    affectedPaths: ["wiki/Page.md"],
    sourceKind: "ingest",
    conflictReason: "commit-conflict: update target does not match base hash",
    ...overrides,
  }
}

describe("markdown conflict repair adapter", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    runtimeStagingArtifactRecordMock.mockResolvedValue({
      artifactId: "artifact-1",
      jobId: "job-1",
      artifactPath: "job-1/artifact.md",
      artifactHash: "sha256:artifact",
      status: "failed",
      createdAtMs: 1,
      updatedAtMs: 2,
    })
    runtimeJobCreateMock.mockResolvedValue({
      jobId: "repair-1",
      kind: "markdown-conflict-repair",
      payload: "{}",
      state: "queued",
      attempt: 0,
      maxAttempts: 3,
      priority: 0,
      createdAtMs: 3,
      updatedAtMs: 3,
    })
  })

  it("marks the artifact failed before creating a repair job", async () => {
    await expect(
      routeMarkdownConflictRepair(conflictContext()),
    ).resolves.toEqual({ repairJobId: "repair-1" })

    expect(runtimeStagingArtifactRecordMock).toHaveBeenCalledWith({
      artifactId: "artifact-1",
      jobId: "job-1",
      artifactPath: "job-1/artifact.md",
      artifactHash: "sha256:artifact",
      status: "failed",
      lastError: "commit-conflict: update target does not match base hash",
    })
    expect(runtimeJobCreateMock).toHaveBeenCalledWith({
      kind: "markdown-conflict-repair",
      payload: expect.any(String),
      maxAttempts: 3,
    })
    expect(
      runtimeStagingArtifactRecordMock.mock.invocationCallOrder[0],
    ).toBeLessThan(runtimeJobCreateMock.mock.invocationCallOrder[0])
  })

  it("creates a bounded metadata repair payload without Markdown body or duplicate attempt limit", async () => {
    await routeMarkdownConflictRepair(
      conflictContext({
        conflictReason: "commit-conflict: PRIVATE BODY SHOULD NOT APPEAR",
      }),
    )

    const request = runtimeJobCreateMock.mock.calls[0]?.[0]
    const payload = JSON.parse(String(request?.payload))

    expect(request).toMatchObject({
      kind: "markdown-conflict-repair",
      maxAttempts: 3,
    })
    expect(payload).toEqual({
      kind: "markdown-conflict-repair",
      artifactId: "artifact-1",
      artifactHash: "sha256:artifact",
      targetPath: "wiki/Page.md",
      operationIntent: "update",
      result: "conflicted",
      baseHash: "sha256:base",
      currentHash: "sha256:changed",
      affectedPaths: ["wiki/Page.md"],
      sourceKind: "ingest",
      owner: "markdown-commit",
      strategy: "manual-review-first",
    })
    expect(JSON.stringify(payload)).not.toContain("PRIVATE BODY")
    expect(payload).not.toHaveProperty("attemptLimit")
  })

  it("does not create a repair job when marking the artifact failed fails", async () => {
    runtimeStagingArtifactRecordMock.mockRejectedValue(new Error("artifact failed"))

    await expect(
      routeMarkdownConflictRepair(conflictContext()),
    ).rejects.toThrow("artifact failed")

    expect(runtimeJobCreateMock).not.toHaveBeenCalled()
  })

  it("propagates job creation failures after marking the artifact failed", async () => {
    runtimeJobCreateMock.mockRejectedValue(new Error("job create failed"))

    await expect(
      routeMarkdownConflictRepair(conflictContext()),
    ).rejects.toThrow("job create failed")

    expect(runtimeStagingArtifactRecordMock).toHaveBeenCalledWith(
      expect.objectContaining({
        artifactId: "artifact-1",
        status: "failed",
      }),
    )
    expect(runtimeJobCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "markdown-conflict-repair",
        maxAttempts: 3,
      }),
    )
  })
})
