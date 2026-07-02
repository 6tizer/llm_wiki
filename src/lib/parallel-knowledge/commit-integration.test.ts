import { describe, expect, it } from "vitest"
import { hashMarkdownContent } from "@/core-runtime/markdown-commit"
import {
  commitPendingStagingArtifacts,
  type CommitIntegrationRuntimeAdapter,
  type CommitIntegrationFileAdapter,
} from "./commit-integration"
import type {
  RuntimeDerivedStaleMarkerRecord,
  RuntimeEventRecord,
  RuntimeProgressAppend,
  RuntimeProgressRecord,
  RuntimeResourceBudgetClaimRecord,
  RuntimeStagingArtifactRecord,
} from "@/commands/runtime-db"

describe("parallel knowledge commit integration", () => {
  it("maps missing committed Markdown to null and commits a new artifact", async () => {
    const markdown = "# Page\n"
    const artifact = await stagingArtifact({
      artifactHash: await hashMarkdownContent(markdown),
      operationIntent: "create",
      baseHash: null,
    })
    const runtime = fakeRuntime([artifact], { [artifact.artifactId]: markdown })
    const files = fakeFiles()

    const result = await commitPendingStagingArtifacts({ runtime, files })

    expect(result.committed).toBe(1)
    expect(result.cleanedArtifacts).toBe(1)
    expect(result.markersRecorded).toBe(4)
    expect(files.files.get("Wiki/Page.md")).toBe(markdown)
    expect(runtime.calls.committedArtifacts).toEqual(["artifact-1"])
    expect(runtime.calls.repairs).toEqual([])
    expect(runtime.calls.markers).toHaveLength(4)
    expect(runtime.calls.markers[0]).toMatchObject({
      affectedPath: "Wiki/Page.md",
      inputHash: await hashMarkdownContent(markdown),
      baseVersion: "genesis",
      reason: "commit",
    })
  })

  it("routes base-hash conflicts to repair without cleaning staging", async () => {
    const markdown = "# Draft\n"
    const artifact = await stagingArtifact({
      artifactHash: await hashMarkdownContent(markdown),
      operationIntent: "update",
      baseHash: "old-hash",
    })
    const runtime = fakeRuntime([artifact], { [artifact.artifactId]: markdown })
    const files = fakeFiles({ "Wiki/Page.md": "# Changed\n" })

    const result = await commitPendingStagingArtifacts({ runtime, files })

    expect(result.conflicted).toBe(1)
    expect(result.repairJobs).toBe(1)
    expect(result.cleanedArtifacts).toBe(0)
    expect(runtime.calls.committedArtifacts).toEqual([])
    expect(runtime.calls.repairs).toHaveLength(1)
    expect(runtime.calls.repairs[0]).toMatchObject({
      artifactId: "artifact-1",
      targetPath: "Wiki/Page.md",
      operationIntent: "update",
    })
  })

  it("reconciles crash-after-write pending artifacts without creating repair jobs", async () => {
    const markdown = "# Already committed\n"
    const artifact = await stagingArtifact({
      artifactHash: await hashMarkdownContent(markdown),
      operationIntent: "create",
      baseHash: null,
    })
    const runtime = fakeRuntime([artifact], { [artifact.artifactId]: markdown })
    const files = fakeFiles({ "Wiki/Page.md": markdown })

    const result = await commitPendingStagingArtifacts({ runtime, files })

    expect(result.committed).toBe(1)
    expect(result.repairJobs).toBe(0)
    expect(result.cleanedArtifacts).toBe(1)
    expect(runtime.calls.repairs).toEqual([])
    expect(runtime.calls.committedArtifacts).toEqual(["artifact-1"])
  })

  it("routes append conflicts to repair even when the target ends with the staged segment", async () => {
    const base = "# Existing\n"
    const staged = "## Added\n"
    const changed = `# Concurrent change\n${staged}`
    const artifact = await stagingArtifact({
      artifactHash: await hashMarkdownContent(staged),
      operationIntent: "append",
      baseHash: await hashMarkdownContent(base),
    })
    const runtime = fakeRuntime([artifact], { [artifact.artifactId]: staged })
    const files = fakeFiles({ "Wiki/Page.md": changed })

    const result = await commitPendingStagingArtifacts({ runtime, files })

    expect(result.conflicted).toBe(1)
    expect(result.repairJobs).toBe(1)
    expect(result.cleanedArtifacts).toBe(0)
    expect(runtime.calls.repairs).toHaveLength(1)
    expect(runtime.calls.committedArtifacts).toEqual([])
  })

  it("routes append conflicts to repair when the current target equals the staged segment", async () => {
    const base = "# Existing\n"
    const staged = "## Added\n"
    const artifact = await stagingArtifact({
      artifactHash: await hashMarkdownContent(staged),
      operationIntent: "append",
      baseHash: await hashMarkdownContent(base),
    })
    const runtime = fakeRuntime([artifact], { [artifact.artifactId]: staged })
    const files = fakeFiles({ "Wiki/Page.md": staged })

    const result = await commitPendingStagingArtifacts({ runtime, files })

    expect(result.conflicted).toBe(1)
    expect(result.repairJobs).toBe(1)
    expect(result.cleanedArtifacts).toBe(0)
    expect(runtime.calls.repairs).toHaveLength(1)
    expect(runtime.calls.committedArtifacts).toEqual([])
  })

  it("treats missing-target delete skips as terminal cleanup", async () => {
    const markdown = "# Delete marker\n"
    const artifact = await stagingArtifact({
      artifactHash: await hashMarkdownContent(markdown),
      operationIntent: "delete",
      baseHash: "old-hash",
    })
    const runtime = fakeRuntime([artifact], { [artifact.artifactId]: markdown })

    const result = await commitPendingStagingArtifacts({
      runtime,
      files: fakeFiles(),
    })

    expect(result.skipped).toBe(1)
    expect(result.cleanedArtifacts).toBe(1)
    expect(runtime.calls.committedArtifacts).toEqual(["artifact-1"])
    expect(runtime.calls.markers[0]).toMatchObject({
      reason: "delete",
      inputHash: null,
      baseVersion: "old-hash",
    })
  })

  it("keeps external same-path budget losers pending and retryable", async () => {
    const markdown = "# Busy\n"
    const artifact = await stagingArtifact({
      artifactHash: await hashMarkdownContent(markdown),
      targetPath: "Wiki/Busy.md",
    })
    const runtime = fakeRuntime([artifact], { [artifact.artifactId]: markdown })
    runtime.claimBudget = async () => {
      throw new Error("commit-path-already-claimed: wiki/busy.md")
    }

    const result = await commitPendingStagingArtifacts({ runtime, files: fakeFiles() })

    expect(result.retryable).toBe(1)
    expect(result.rejected).toBe(0)
    expect(result.cleanedArtifacts).toBe(0)
    expect(runtime.calls.committedArtifacts).toEqual([])
    expect(runtime.calls.repairs).toEqual([])
  })

  it("uses normalized target keys to avoid same-pass same-path concurrency", async () => {
    const markdown = "# Page\n"
    const first = await stagingArtifact({
      artifactHash: await hashMarkdownContent(markdown),
      artifactId: "artifact-1",
      targetPath: "Wiki/Page.md",
      artifactPath: "job-1/a.md",
    })
    const second = await stagingArtifact({
      artifactHash: await hashMarkdownContent(markdown),
      artifactId: "artifact-2",
      targetPath: "wiki/page.md",
      artifactPath: "job-1/b.md",
    })
    const runtime = fakeRuntime(
      [first, second],
      { "artifact-1": markdown, "artifact-2": markdown },
      { delayClaimMs: 1 },
    )

    const result = await commitPendingStagingArtifacts({
      runtime,
      files: fakeFiles(),
      concurrency: 2,
    })

    expect(result.committed).toBe(1)
    expect(result.retryable).toBe(1)
    expect(runtime.calls.committedArtifacts).toEqual(["artifact-1"])
  })

  it("skips pending artifacts that lack commit metadata", async () => {
    const artifact = await stagingArtifact({
      targetPath: null,
      operationIntent: null,
      sourceKind: null,
    })
    const runtime = fakeRuntime([artifact], { [artifact.artifactId]: "# Page\n" })

    const result = await commitPendingStagingArtifacts({ runtime, files: fakeFiles() })

    expect(result.skipped).toBe(1)
    expect(result.errors).toEqual([
      "staging-artifact-missing-commit-metadata: artifact-1",
    ])
    expect(runtime.calls.repairs).toEqual([])
    expect(runtime.calls.committedArtifacts).toEqual([])
  })

  it("keeps the artifact pending when derived marker recording fails", async () => {
    const markdown = "# Page\n"
    const artifact = await stagingArtifact({
      artifactHash: await hashMarkdownContent(markdown),
      operationIntent: "create",
      baseHash: null,
    })
    const runtime = fakeRuntime([artifact], { [artifact.artifactId]: markdown })
    runtime.recordDerivedStaleMarker = async (request) => {
      if (request.layer === "graph") throw new Error("marker failed")
      return {
        ...request,
        markedAtMs: 1,
        status: "pending",
        updatedAtMs: 1,
        lastError: null,
      }
    }

    const result = await commitPendingStagingArtifacts({
      runtime,
      files: fakeFiles(),
    })

    expect(result.errors).toEqual([
      "commit-artifact-failed:artifact-1: marker failed",
    ])
    expect(result.cleanedArtifacts).toBe(0)
    expect(runtime.calls.committedArtifacts).toEqual([])
  })

  it("treats duplicate audit events as idempotent on crash retry", async () => {
    const markdown = "# Page\n"
    const artifact = await stagingArtifact({
      artifactHash: await hashMarkdownContent(markdown),
      operationIntent: "create",
      baseHash: null,
    })
    const runtime = fakeRuntime([artifact], { [artifact.artifactId]: markdown })
    runtime.appendEvent = async () => {
      throw new Error(
        "event-insert-failed: UNIQUE constraint failed: runtime_events.event_id",
      )
    }

    const result = await commitPendingStagingArtifacts({
      runtime,
      files: fakeFiles(),
    })

    expect(result.committed).toBe(1)
    expect(result.cleanedArtifacts).toBe(1)
    expect(result.errors).toEqual([])
    expect(runtime.calls.committedArtifacts).toEqual(["artifact-1"])
  })

  it("treats duplicate derived markers as idempotent on crash retry", async () => {
    const markdown = "# Page\n"
    const artifact = await stagingArtifact({
      artifactHash: await hashMarkdownContent(markdown),
      operationIntent: "create",
      baseHash: null,
    })
    const runtime = fakeRuntime([artifact], { [artifact.artifactId]: markdown })
    runtime.recordDerivedStaleMarker = async () => {
      throw new Error(
        "derived-marker-record-insert-failed: UNIQUE constraint failed: runtime_derived_stale_markers.marker_id",
      )
    }

    const result = await commitPendingStagingArtifacts({
      runtime,
      files: fakeFiles(),
    })

    expect(result.committed).toBe(1)
    expect(result.cleanedArtifacts).toBe(1)
    expect(result.markersRecorded).toBe(0)
    expect(result.errors).toEqual([])
    expect(runtime.calls.committedArtifacts).toEqual(["artifact-1"])
  })

  it("marks deterministic rejected artifacts failed instead of retrying forever", async () => {
    const markdown = "# Page\n"
    const artifact = await stagingArtifact({
      artifactHash: await hashMarkdownContent("# Different\n"),
      operationIntent: "create",
      baseHash: null,
    })
    const runtime = fakeRuntime([artifact], { [artifact.artifactId]: markdown })

    const result = await commitPendingStagingArtifacts({
      runtime,
      files: fakeFiles(),
    })

    expect(result.rejected).toBe(1)
    expect(result.cleanedArtifacts).toBe(0)
    expect(runtime.calls.failedArtifacts).toEqual(["artifact-1"])
    expect(runtime.calls.committedArtifacts).toEqual([])
    expect(runtime.calls.repairs).toEqual([])
  })
})

async function stagingArtifact(
  overrides: Partial<RuntimeStagingArtifactRecord> = {},
): Promise<RuntimeStagingArtifactRecord> {
  return {
    artifactId: "artifact-1",
    jobId: "job-1",
    artifactPath: "job-1/page.md",
    artifactHash: await hashMarkdownContent("# Page\n"),
    targetPath: "Wiki/Page.md",
    operationIntent: "create",
    baseHash: null,
    sourceKind: "ingest",
    status: "pending",
    createdAtMs: 100,
    updatedAtMs: 100,
    expiresAtMs: null,
    deletedAtMs: null,
    lastError: null,
    ...overrides,
  }
}

function fakeFiles(initial: Record<string, string> = {}): CommitIntegrationFileAdapter & {
  files: Map<string, string>
} {
  const files = new Map(Object.entries(initial))
  return {
    files,
    async exists(path) {
      return files.has(path)
    },
    async read(path) {
      const value = files.get(path)
      if (value === undefined) throw new Error(`File does not exist: '${path}'`)
      return value
    },
    async writeAtomic(path, contents) {
      files.set(path, contents)
    },
    async delete(path) {
      files.delete(path)
    },
  }
}

function fakeRuntime(
  artifacts: RuntimeStagingArtifactRecord[],
  bodies: Record<string, string>,
  options: { delayClaimMs?: number } = {},
): CommitIntegrationRuntimeAdapter & {
  calls: {
    committedArtifacts: string[]
    failedArtifacts: string[]
    repairs: unknown[]
    markers: unknown[]
  }
} {
  const calls = {
    committedArtifacts: [] as string[],
    failedArtifacts: [] as string[],
    repairs: [] as unknown[],
    markers: [] as unknown[],
  }
  let eventCount = 0

  return {
    calls,
    async listStagingArtifacts() {
      return { enabled: true, status: "healthy", artifacts }
    },
    async readStagingArtifactBody(artifactId) {
      return {
        artifactId,
        artifactPath:
          artifacts.find((artifact) => artifact.artifactId === artifactId)?.artifactPath ??
          `${artifactId}.md`,
        markdown: bodies[artifactId] ?? "",
      }
    },
    async claimBudget(request) {
      if (options.delayClaimMs) {
        await new Promise((resolve) => setTimeout(resolve, options.delayClaimMs))
      }
      return {
        claimId: request.claimId ?? `claim-${request.affectedPath}`,
        resourceKey: request.affectedPath.toLowerCase(),
        displayKey: request.affectedPath,
        expiresAtMs: Date.now() + 1000,
      }
    },
    async releaseBudget(claimId): Promise<RuntimeResourceBudgetClaimRecord[]> {
      return [
        {
          claimId,
          scope: "commit-path",
          resourceKey: "wiki/page.md",
          displayKey: "Wiki/Page.md",
          holder: "bulk-commit",
          amount: 1,
          acquiredAtMs: 1,
          expiresAtMs: 2,
          releasedAtMs: 3,
          status: "released",
        },
      ]
    },
    async appendEvent(request): Promise<RuntimeEventRecord> {
      eventCount += 1
      return {
        eventId: `event-${eventCount}`,
        jobId: request.jobId,
        eventName: "job-runtime:event-appended",
        payload: JSON.stringify(request.payload),
        createdAtMs: eventCount,
      }
    },
    async recordDerivedStaleMarker(request): Promise<RuntimeDerivedStaleMarkerRecord> {
      calls.markers.push(request)
      return {
        ...request,
        markedAtMs: 1,
        status: "pending",
        updatedAtMs: 1,
        lastError: null,
      }
    },
    async markArtifactCommitted(artifactId) {
      calls.committedArtifacts.push(artifactId)
      const artifact = artifacts.find((candidate) => candidate.artifactId === artifactId)
      if (!artifact) throw new Error("artifact missing")
      return { ...artifact, status: "committed", deletedAtMs: 1 }
    },
    async markArtifactFailed(request) {
      calls.failedArtifacts.push(request.artifactId)
      const artifact = artifacts.find(
        (candidate) => candidate.artifactId === request.artifactId,
      )
      if (!artifact) throw new Error("artifact missing")
      return { ...artifact, status: "failed", lastError: request.lastError }
    },
    async routeConflictRepair(context) {
      calls.repairs.push(context)
      return { repairJobId: `repair-${calls.repairs.length}` }
    },
    async appendProgress(request): Promise<RuntimeProgressAppend> {
      const progress: RuntimeProgressRecord = {
        jobId: request.jobId ?? "job-1",
        progressKey: request.progressKey,
        payload: request.payload,
        updatedAtMs: 1,
        lastEventId: null,
      }
      return { progress, event: null }
    },
  }
}
