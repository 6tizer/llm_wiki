import { JOB_RUNTIME_DEFAULTS } from "@/core-runtime/contract"
import type { RuntimeJobLeaseRecord, RuntimeJobRecord } from "@/commands/runtime-db"

/**
 * Heartbeats are written at most every `heartbeatMinIntervalMs`. A lease is
 * only worth flagging once it has missed several beats -- one missed tick can
 * just be scheduler jitter, not a stuck worker.
 */
export const STUCK_HEARTBEAT_STALE_MULTIPLIER = 3

export type LeaseHealth = "no-lease" | "healthy" | "suspected-stuck"

function findActiveLease(
  leasesForJob: readonly RuntimeJobLeaseRecord[],
): RuntimeJobLeaseRecord | null {
  return leasesForJob.find((lease) => lease.status === "active") ?? null
}

export function classifyJobLeaseHealth(
  job: RuntimeJobRecord,
  leasesForJob: readonly RuntimeJobLeaseRecord[],
  now: number,
): LeaseHealth {
  if (job.state !== "running") {
    return "no-lease"
  }
  const activeLease = findActiveLease(leasesForJob)
  if (!activeLease) {
    return "suspected-stuck"
  }
  const heartbeatStaleMs = STUCK_HEARTBEAT_STALE_MULTIPLIER * JOB_RUNTIME_DEFAULTS.heartbeatMinIntervalMs
  if (now - activeLease.heartbeatAtMs > heartbeatStaleMs || activeLease.expiresAtMs <= now) {
    return "suspected-stuck"
  }
  return "healthy"
}

export function isAwaitingWorker(
  job: RuntimeJobRecord,
  leasesForJob: readonly RuntimeJobLeaseRecord[],
): boolean {
  if (job.state !== "queued" && job.state !== "retry-wait") {
    return false
  }
  return findActiveLease(leasesForJob) === null
}

export function groupLeasesByJobId(
  leases: readonly RuntimeJobLeaseRecord[],
): Map<string, RuntimeJobLeaseRecord[]> {
  const groups = new Map<string, RuntimeJobLeaseRecord[]>()
  for (const lease of leases) {
    const existing = groups.get(lease.jobId)
    if (existing) {
      existing.push(lease)
    } else {
      groups.set(lease.jobId, [lease])
    }
  }
  return groups
}
