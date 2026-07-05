/**
 * SPEC-6 PR6 Closeout Gate (a): end-to-end fixture — a stateful fake
 * runtime db (in-memory jobs/markers, NOT canned per-call responses) wired
 * up to REAL production code across three modules, proving the full
 * marker lifecycle the UI depends on actually converges:
 *
 *   commit -> marker "pending" -> layer consumer claims -> "done"
 *   -> bucketDerivedLayerStatus flips dirty -> ready
 *
 * Two derived-rebuild wiring styles are exercised, matching SPEC-6's two
 * consumer shapes:
 *   1. `embedding` — automatic background consumer
 *      (`embedding-consumer.ts`'s real tick loop, started via
 *      `startEmbeddingConsumer`) picks up a marker `ingest-write.ts`'s real
 *      `recordEmbeddingStaleMarker` recorded.
 *   2. `overview` — manual, mint-to-close-in-one-call
 *      (`overview-rebuild.ts`'s real `rebuildOverview`, no background
 *      consumer). No LLM key is available in this environment, so
 *      `streamChat` is mocked to return a valid overview page.
 *
 * `bucketDerivedLayerStatus`/`fetchAllDerivedStaleMarkers` (status.ts) read
 * the SAME fake marker table at each checkpoint, so the assertions are the
 * real UI-status derivation, not a hand-rolled substitute.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { WikiProject } from "@/types/wiki"
import type { RuntimeJobState } from "@/commands/runtime-db"

interface FakeJob {
  jobId: string
  kind: string
  payload: string
  state: RuntimeJobState
  attempt: number
  maxAttempts: number
  priority: number
  createdAtMs: number
  updatedAtMs: number
}

interface FakeMarker {
  markerId: string
  layer: string
  affectedPath: string
  inputHash: string | null
  baseVersion: string
  markedAtMs: number
  reason: string
  sourceEventId: string
  status: string
  updatedAtMs: number
  lastError?: string | null
}

const fake = vi.hoisted(() => {
  let jobSeq = 0
  let eventSeq = 0
  let markerSeq = 0
  let clock = 0
  const jobs: FakeJob[] = []
  const markers: FakeMarker[] = []

  function now(): number {
    clock += 1
    return clock
  }

  function findJob(jobId: string): FakeJob {
    const job = jobs.find((j) => j.jobId === jobId)
    if (!job) throw new Error(`fake-runtime: job not found: ${jobId}`)
    return job
  }

  function payloadLayerOf(job: FakeJob): string | undefined {
    try {
      return (JSON.parse(job.payload) as { layer?: string }).layer
    } catch {
      return undefined
    }
  }

  return {
    jobs,
    markers,
    reset(): void {
      jobs.length = 0
      markers.length = 0
      jobSeq = 0
      eventSeq = 0
      markerSeq = 0
      clock = 0
    },

    async runtimeJobCreate({ kind, payload, maxAttempts }: { kind: string; payload: string; maxAttempts?: number | null }) {
      const job: FakeJob = {
        jobId: `job-${++jobSeq}`,
        kind,
        payload,
        state: "queued",
        attempt: 0,
        maxAttempts: maxAttempts ?? 3,
        priority: 0,
        createdAtMs: now(),
        updatedAtMs: now(),
      }
      jobs.push(job)
      return { ...job }
    },

    async runtimeJobClaim({ holder, jobId }: { holder: string; jobId: string }) {
      const job = findJob(jobId)
      job.state = "running"
      job.attempt += 1
      job.updatedAtMs = now()
      const leaseId = `${job.jobId}-lease-${job.attempt}`
      return {
        job: { ...job },
        lease: { leaseId, jobId: job.jobId, holder, acquiredAtMs: now(), heartbeatAtMs: now(), expiresAtMs: now() + 120_000, status: "active" as const },
      }
    },

    async runtimeJobClaimByKind({ kind, holder, payloadLayer }: { kind: string; holder: string; payloadLayer?: string }) {
      const candidate = jobs.find(
        (j) => j.kind === kind && j.state === "queued" && (!payloadLayer || payloadLayerOf(j) === payloadLayer),
      )
      if (!candidate) throw new Error("no-queued-job: no queued runtime job is available")
      return this.runtimeJobClaim({ holder, jobId: candidate.jobId })
    },

    async runtimeJobComplete({ jobId }: { jobId: string; leaseId: string }) {
      const job = findJob(jobId)
      job.state = "completed"
      job.updatedAtMs = now()
      return { ...job }
    },

    async runtimeJobFail({ jobId, error }: { jobId: string; leaseId: string; error: string }) {
      const job = findJob(jobId)
      job.state = job.attempt >= job.maxAttempts ? "failed" : "retry-wait"
      job.updatedAtMs = now()
      void error
      return { ...job }
    },

    async runtimeJobHeartbeat({ jobId, leaseId }: { jobId: string; leaseId: string }) {
      const job = findJob(jobId)
      return {
        job: { ...job },
        lease: { leaseId, jobId, holder: "x", acquiredAtMs: now(), heartbeatAtMs: now(), expiresAtMs: now() + 120_000, status: "active" as const },
      }
    },

    async runtimeJobRetry(jobId: string) {
      const job = findJob(jobId)
      job.state = "queued"
      job.updatedAtMs = now()
      return { ...job }
    },

    async runtimeJobList() {
      return { enabled: true, status: "healthy" as const, jobs: jobs.map((j) => ({ ...j })), leases: [] }
    },

    async runtimeEventAppend({ jobId, payload }: { jobId: string; payload: string }) {
      return { eventId: `event-${++eventSeq}`, jobId, eventName: "job-runtime:event-appended", payload, createdAtMs: now() }
    },

    async runtimeDerivedStaleMarkerRecord(request: {
      layer: string
      affectedPath: string
      inputHash?: string | null
      baseVersion: string
      reason: string
      sourceEventId: string
    }) {
      const marker: FakeMarker = {
        markerId: `marker-${++markerSeq}`,
        layer: request.layer,
        affectedPath: request.affectedPath,
        inputHash: request.inputHash ?? null,
        baseVersion: request.baseVersion,
        markedAtMs: now(),
        reason: request.reason,
        sourceEventId: request.sourceEventId,
        status: "pending",
        updatedAtMs: now(),
      }
      markers.push(marker)
      return { ...marker }
    },

    async runtimeDerivedStaleMarkerList(request: { layer?: string | null; affectedPath?: string | null; status?: string | null; limit?: number | null }) {
      let rows = markers.slice()
      if (request.layer) rows = rows.filter((m) => m.layer === request.layer)
      if (request.affectedPath) rows = rows.filter((m) => m.affectedPath === request.affectedPath)
      if (request.status) rows = rows.filter((m) => m.status === request.status)
      const limited = typeof request.limit === "number" ? rows.slice(0, request.limit) : rows
      return { enabled: true, status: "healthy" as const, markers: limited.map((m) => ({ ...m })), nextCursor: null }
    },

    async runtimeDerivedMarkerClaimBatch({ layer, affectedPath, jobId, maxAttempts, priority }: {
      layer: string
      affectedPath: string
      jobId?: string | null
      maxAttempts?: number | null
      priority?: number | null
    }) {
      const pending = markers.filter((m) => m.layer === layer && m.affectedPath === affectedPath && m.status === "pending")
      if (pending.length === 0) throw new Error("no-pending-markers: nothing to fold")
      const latest = pending.reduce((a, b) => (a.markedAtMs >= b.markedAtMs ? a : b))
      const payload = JSON.stringify({
        layer,
        affectedPath,
        markerIds: pending.map((m) => m.markerId),
        baseVersion: latest.baseVersion,
        inputHash: latest.inputHash,
        reason: latest.reason,
      })
      const job: FakeJob = {
        jobId: jobId ?? `job-${++jobSeq}`,
        kind: "derived-rebuild",
        payload,
        state: "queued",
        attempt: 0,
        maxAttempts: maxAttempts ?? 3,
        priority: priority ?? 0,
        createdAtMs: now(),
        updatedAtMs: now(),
      }
      jobs.push(job)
      pending.forEach((m) => {
        m.status = "claimed"
        m.updatedAtMs = now()
      })
      return { job: { ...job }, markers: pending.map((m) => ({ ...m })) }
    },

    async runtimeDerivedMarkerCompleteBatch({ jobId, markerIds }: { jobId: string; leaseId: string; markerIds: string[] }) {
      const job = findJob(jobId)
      job.state = "completed"
      job.updatedAtMs = now()
      const affected = markers.filter((m) => markerIds.includes(m.markerId))
      affected.forEach((m) => {
        m.status = "done"
        m.updatedAtMs = now()
      })
      return { job: { ...job }, markers: affected.map((m) => ({ ...m })) }
    },

    async runtimeDerivedMarkerReleaseBatch({ markerIds, targetStatus, error }: { jobId: string; markerIds: string[]; targetStatus: string; error?: string | null }) {
      const affected = markers.filter((m) => markerIds.includes(m.markerId))
      affected.forEach((m) => {
        m.status = targetStatus
        m.lastError = error ?? null
        m.updatedAtMs = now()
      })
      return { markers: affected.map((m) => ({ ...m })) }
    },
  }
})

vi.mock("@/commands/runtime-db", () => ({
  runtimeJobCreate: (...args: Parameters<typeof fake.runtimeJobCreate>) => fake.runtimeJobCreate(...args),
  runtimeJobClaim: (...args: Parameters<typeof fake.runtimeJobClaim>) => fake.runtimeJobClaim(...args),
  runtimeJobClaimByKind: (...args: Parameters<typeof fake.runtimeJobClaimByKind>) => fake.runtimeJobClaimByKind(...args),
  runtimeJobComplete: (...args: Parameters<typeof fake.runtimeJobComplete>) => fake.runtimeJobComplete(...args),
  runtimeJobFail: (...args: Parameters<typeof fake.runtimeJobFail>) => fake.runtimeJobFail(...args),
  runtimeJobHeartbeat: (...args: Parameters<typeof fake.runtimeJobHeartbeat>) => fake.runtimeJobHeartbeat(...args),
  runtimeJobRetry: (...args: Parameters<typeof fake.runtimeJobRetry>) => fake.runtimeJobRetry(...args),
  runtimeJobList: (...args: Parameters<typeof fake.runtimeJobList>) => fake.runtimeJobList(...args),
  runtimeEventAppend: (...args: Parameters<typeof fake.runtimeEventAppend>) => fake.runtimeEventAppend(...args),
  runtimeDerivedStaleMarkerRecord: (...args: Parameters<typeof fake.runtimeDerivedStaleMarkerRecord>) =>
    fake.runtimeDerivedStaleMarkerRecord(...args),
  runtimeDerivedStaleMarkerList: (...args: Parameters<typeof fake.runtimeDerivedStaleMarkerList>) =>
    fake.runtimeDerivedStaleMarkerList(...args),
  runtimeDerivedMarkerClaimBatch: (...args: Parameters<typeof fake.runtimeDerivedMarkerClaimBatch>) =>
    fake.runtimeDerivedMarkerClaimBatch(...args),
  runtimeDerivedMarkerCompleteBatch: (...args: Parameters<typeof fake.runtimeDerivedMarkerCompleteBatch>) =>
    fake.runtimeDerivedMarkerCompleteBatch(...args),
  runtimeDerivedMarkerReleaseBatch: (...args: Parameters<typeof fake.runtimeDerivedMarkerReleaseBatch>) =>
    fake.runtimeDerivedMarkerReleaseBatch(...args),
}))

const fsMocks = vi.hoisted(() => ({
  readFile: vi.fn(),
  writeFileAtomic: vi.fn(),
  listDirectory: vi.fn(),
}))
vi.mock("@/commands/fs", () => ({
  readFile: fsMocks.readFile,
  writeFileAtomic: fsMocks.writeFileAtomic,
  listDirectory: fsMocks.listDirectory,
}))

const ingestQueueMocks = vi.hoisted(() => ({ getQueueSummary: vi.fn() }))
vi.mock("@/lib/ingest-queue", () => ({ getQueueSummary: ingestQueueMocks.getQueueSummary }))

const embeddingMocks = vi.hoisted(() => ({ embedPage: vi.fn(), removePageEmbedding: vi.fn() }))
vi.mock("@/lib/embedding", () => ({
  embedPage: embeddingMocks.embedPage,
  removePageEmbedding: embeddingMocks.removePageEmbedding,
}))

const llmMocks = vi.hoisted(() => ({ streamChat: vi.fn() }))
vi.mock("@/lib/pool-chat", () => ({ streamChatRouted: llmMocks.streamChat }))

import { recordEmbeddingStaleMarker } from "@/lib/ingest-write"
import { startEmbeddingConsumer, stopEmbeddingConsumer } from "./embedding-consumer"
import { rebuildOverview } from "./overview-rebuild"
import { bucketDerivedLayerStatus, fetchAllDerivedStaleMarkers } from "./status"
import { useWikiStore } from "@/stores/wiki-store"
import { runtimeDerivedStaleMarkerList } from "@/commands/runtime-db"

const PROJECT: WikiProject = { id: "p1", name: "P", path: "/proj" }

async function snapshot() {
  const { markers } = await fetchAllDerivedStaleMarkers({ list: runtimeDerivedStaleMarkerList })
  return bucketDerivedLayerStatus(markers)
}

describe("SPEC-6 PR6 Closeout Gate (a): derived-status end-to-end fixture", () => {
  beforeEach(() => {
    fake.reset()
    vi.clearAllMocks()
    ingestQueueMocks.getQueueSummary.mockReturnValue({ pending: 0, processing: 0, failed: 0, completed: 0, total: 0 })
    fsMocks.listDirectory.mockResolvedValue([])
    useWikiStore.setState({
      embeddingConfig: { enabled: true, endpoint: "http://x", apiKey: "", model: "test-embed" },
      llmConfig: {
        provider: "openai",
        apiKey: "key",
        model: "gpt-test",
        ollamaUrl: "http://localhost:11434",
        customEndpoint: "",
        maxContextSize: 204800,
        reasoning: { mode: "auto" },
      },
    })
  })

  afterEach(() => {
    stopEmbeddingConsumer()
  })

  it("embedding: commit -> pending -> automatic consumer claims -> done -> UI flips dirty to ready", async () => {
    // 1. Commit path records the marker (no LLM, no runtime job pre-exists).
    const recorded = await recordEmbeddingStaleMarker("wiki/foo.md", "# Foo\n\nbody")
    expect(recorded).toBe("recorded")

    // 2. UI-facing snapshot: dirty (a pending marker exists for embedding).
    const beforeConsumer = await snapshot()
    expect(beforeConsumer.embedding?.status).toBe("dirty")
    expect(beforeConsumer.embedding?.stale).toBe(false) // embedding has an automatic consumer
    expect(beforeConsumer.embedding?.lastRebuiltAtMs).toBeNull()

    // 3. The REAL embedding-consumer tick loop claims and processes it.
    fsMocks.readFile.mockResolvedValueOnce("# Foo\n\nbody")
    embeddingMocks.embedPage.mockResolvedValueOnce({ indexed: 1, failed: 0 })

    startEmbeddingConsumer(PROJECT)
    await vi.waitFor(() => {
      const marker = fake.markers.find((m) => m.affectedPath === "wiki/foo.md")
      expect(marker?.status).toBe("done")
    })
    stopEmbeddingConsumer()

    expect(embeddingMocks.embedPage).toHaveBeenCalledWith(
      "/proj",
      expect.any(String),
      expect.any(String),
      "# Foo\n\nbody",
      expect.objectContaining({ enabled: true }),
    )

    // 4. UI-facing snapshot: ready, with a last-rebuilt timestamp now set.
    const afterConsumer = await snapshot()
    expect(afterConsumer.embedding?.status).toBe("ready")
    expect(afterConsumer.embedding?.lastRebuiltAtMs).not.toBeNull()
  })

  it("overview: manual rebuild button mints, claims, executes (mocked LLM), and completes in one call -> UI flips dirty to ready", async () => {
    // Before any rebuild, overview has never had a marker at all -> ready (never rebuilt), matching decision 1.
    const initial = await snapshot()
    expect(initial.overview?.status).toBe("ready")
    expect(initial.overview?.lastRebuiltAtMs).toBeNull()

    llmMocks.streamChat.mockImplementation(async (_family, _config, _messages, handlers) => {
      const page = "---\ntype: overview\ntitle: Project Overview\ntags: []\nrelated: []\n---\n\n# Overview\n\nSummary."
      handlers.onToken(page)
      handlers.onDone()
    })

    const result = await rebuildOverview(PROJECT.path, useWikiStore.getState().llmConfig)

    expect(result.runtimeTracked).toBe(true)
    expect(fsMocks.writeFileAtomic).toHaveBeenCalledWith(
      "/proj/wiki/overview.md",
      expect.stringContaining("Project Overview"),
    )

    const marker = fake.markers.find((m) => m.layer === "overview")
    expect(marker?.status).toBe("done")

    const after = await snapshot()
    expect(after.overview?.status).toBe("ready")
    expect(after.overview?.stale).toBe(false)
    expect(after.overview?.lastRebuiltAtMs).not.toBeNull()
  })

  it("overview: rebuildOverview failure (bad LLM output) converges the marker to failed -> UI shows failed (P2 e2e failure branch)", async () => {
    // Embedding's multi-page PARTIAL-failure case is already covered by
    // manual-rebuild-marker.test.ts's per-page unit tests — this is
    // specifically the whole-call failure path for a mint-to-close layer
    // (overview), which the happy-path e2e test above doesn't exercise.
    llmMocks.streamChat.mockImplementation(async (_family, _config, _messages, handlers) => {
      handlers.onToken("") // empty response -> rebuildOverview's execute() throws before writing anything
      handlers.onDone()
    })

    await expect(rebuildOverview(PROJECT.path, useWikiStore.getState().llmConfig)).rejects.toThrow(
      "overview-rebuild: LLM returned an empty response",
    )

    expect(fsMocks.writeFileAtomic).not.toHaveBeenCalled()

    // maxAttempts: 1 on the folded job (no consumer to ever retry it) means
    // the single failed attempt converges straight to terminal `failed`,
    // which in turn releases the claimed marker to `failed` too (mirrors
    // `embedding-consumer.ts`'s `safeFailClaim` — see manual-rebuild.ts).
    const marker = fake.markers.find((m) => m.layer === "overview")
    expect(marker?.status).toBe("failed")

    const after = await snapshot()
    expect(after.overview?.status).toBe("failed")
  })
})
