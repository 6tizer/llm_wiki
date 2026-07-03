import { describe, expect, it } from "vitest"
import { JOB_RUNTIME_DEFAULTS } from "@/core-runtime/contract"
import type { RuntimeJobLeaseRecord, RuntimeJobRecord, RuntimeJobState } from "@/commands/runtime-db"
import {
  STUCK_HEARTBEAT_STALE_MULTIPLIER,
  classifyJobLeaseHealth,
  groupLeasesByJobId,
  isAwaitingWorker,
} from "./lease-health"

const NOW = 1_000_000

function job(jobId: string, state: RuntimeJobState): RuntimeJobRecord {
  return {
    jobId,
    kind: "bulk-knowledge-prepare",
    payload: "{}",
    state,
    attempt: 0,
    maxAttempts: 3,
    priority: 0,
    createdAtMs: NOW - 10_000,
    updatedAtMs: NOW,
  }
}

function lease(
  jobId: string,
  overrides: Partial<RuntimeJobLeaseRecord> = {},
): RuntimeJobLeaseRecord {
  return {
    leaseId: `${jobId}-lease`,
    jobId,
    holder: "worker-1",
    acquiredAtMs: NOW - 10_000,
    heartbeatAtMs: NOW,
    expiresAtMs: NOW + 100_000,
    releasedAtMs: null,
    status: "active",
    ...overrides,
  }
}

describe("classifyJobLeaseHealth", () => {
  it("returns no-lease for jobs that are not running", () => {
    expect(classifyJobLeaseHealth(job("j1", "queued"), [lease("j1")], NOW)).toBe("no-lease")
  })

  it("returns healthy for a running job with a fresh, unexpired active lease", () => {
    expect(classifyJobLeaseHealth(job("j1", "running"), [lease("j1")], NOW)).toBe("healthy")
  })

  it("returns suspected-stuck when the heartbeat is stale but the lease has not hard-expired", () => {
    const staleMs = STUCK_HEARTBEAT_STALE_MULTIPLIER * JOB_RUNTIME_DEFAULTS.heartbeatMinIntervalMs
    const staleLease = lease("j1", {
      heartbeatAtMs: NOW - staleMs - 1,
      expiresAtMs: NOW + 100_000,
    })
    expect(classifyJobLeaseHealth(job("j1", "running"), [staleLease], NOW)).toBe("suspected-stuck")
  })

  it("returns suspected-stuck when the lease has hard-expired even with a fresh heartbeat", () => {
    const expiredLease = lease("j1", {
      heartbeatAtMs: NOW - 1,
      expiresAtMs: NOW,
    })
    expect(classifyJobLeaseHealth(job("j1", "running"), [expiredLease], NOW)).toBe("suspected-stuck")
  })

  it("returns suspected-stuck for a running job with no lease record at all", () => {
    expect(classifyJobLeaseHealth(job("j1", "running"), [], NOW)).toBe("suspected-stuck")
  })

  it("ignores non-active historical leases and reports suspected-stuck instead of trusting stale released data", () => {
    const releasedLease = lease("j1", {
      status: "released",
      heartbeatAtMs: NOW,
      expiresAtMs: NOW + 100_000,
      releasedAtMs: NOW - 1,
    })
    expect(classifyJobLeaseHealth(job("j1", "running"), [releasedLease], NOW)).toBe("suspected-stuck")
  })
})

describe("isAwaitingWorker", () => {
  it("is true for queued/retry-wait jobs with no active lease", () => {
    expect(isAwaitingWorker(job("j1", "queued"), [])).toBe(true)
    expect(isAwaitingWorker(job("j2", "retry-wait"), [lease("j2", { status: "released" })])).toBe(true)
  })

  it("is false for a queued job that already has an active lease (claim race mid-transition)", () => {
    expect(isAwaitingWorker(job("j1", "queued"), [lease("j1")])).toBe(false)
  })
})

describe("groupLeasesByJobId", () => {
  it("groups leases by jobId and returns an empty map for empty input", () => {
    const leases = [lease("j1"), lease("j1", { leaseId: "j1-lease-2", status: "released" }), lease("j2")]
    const grouped = groupLeasesByJobId(leases)

    expect(grouped.get("j1")).toHaveLength(2)
    expect(grouped.get("j2")).toHaveLength(1)
    expect(grouped.get("missing")).toBeUndefined()
    expect(groupLeasesByJobId([]).size).toBe(0)
  })
})
