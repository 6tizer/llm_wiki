import type { BulkKnowledgeSourceInput } from "@/core-runtime/parallel-knowledge"
import {
  enqueueBulkKnowledgePrepareJobs,
  type BulkKnowledgePrepareEnqueueOptions,
  type BulkKnowledgePrepareEnqueueResult,
} from "./bulk-runtime-entry"
import {
  commitPendingStagingArtifacts,
  type CommitIntegrationFileAdapter,
  type CommitIntegrationRuntimeAdapter,
  type CommitPendingStagingArtifactsResult,
} from "./commit-integration"
import { createPrepareModelCallExecutor } from "./prepare-model-call-executor"
import {
  runPrepareWorkerPool,
  type PrepareModelCallExecutor,
  type PrepareWorkerPoolResult,
  type PrepareWorkerRuntimeAdapter,
} from "./prepare-worker-pool"

export interface BulkKnowledgePrepareDriverOptions extends BulkKnowledgePrepareEnqueueOptions {
  /** Defaults to `createPrepareModelCallExecutor()`; override for tests. */
  readonly executor?: PrepareModelCallExecutor
  readonly workerRuntime?: PrepareWorkerRuntimeAdapter
  readonly concurrency?: number
  readonly maxJobs?: number
  readonly workerIdPrefix?: string
  readonly signal?: AbortSignal
  /** Overrides for the commit-integration pass; override for tests. */
  readonly commitRuntime?: CommitIntegrationRuntimeAdapter
  readonly commitFiles?: CommitIntegrationFileAdapter
  readonly commitHolder?: string
  readonly commitLimit?: number
  readonly commitConcurrency?: number
  readonly commitTtlMs?: number
}

export interface BulkKnowledgePrepareDriverResult {
  readonly enqueue: BulkKnowledgePrepareEnqueueResult
  readonly workerPool: PrepareWorkerPoolResult
  readonly commit: CommitPendingStagingArtifactsResult
}

/**
 * Plans + enqueues bulk-prepare runtime jobs, fires one pass of the prepare
 * worker pool to drain whatever prepare jobs are queued at that moment
 * (this call's own jobs, plus anything else already queued), then fires one
 * pass of commit integration to commit whatever staging artifacts the
 * worker pool (or an earlier pass) left pending as real Markdown.
 *
 * KNOWN PR1 BOUNDARY: this is a single fire-and-forget pass through all
 * three stages, not a scheduler — it does not poll for or automatically
 * pick up prepare jobs or staging artifacts that show up later from an
 * unrelated call. Continuous background draining (heartbeat-based lease
 * renewal, a recurring drain loop) is out of scope for PR1; see the
 * SPEC-5-FIX PR1 design doc for the PR2+ plan. SPEC-5-FIX PR5 adds the
 * commit stage itself (previously `commitPendingStagingArtifacts` had zero
 * production call sites) — it inherits the same single-pass boundary: a
 * staging artifact that only becomes pending after this pass's commit list
 * snapshot is taken won't be committed until the next call.
 */
export async function runBulkKnowledgePrepare(
  sources: readonly BulkKnowledgeSourceInput[],
  options: BulkKnowledgePrepareDriverOptions = {},
): Promise<BulkKnowledgePrepareDriverResult> {
  const enqueue = await enqueueBulkKnowledgePrepareJobs(sources, options)
  const workerPool = await runPrepareWorkerPool({
    executor: options.executor ?? createPrepareModelCallExecutor(),
    runtime: options.workerRuntime,
    concurrency: options.concurrency,
    maxJobs: options.maxJobs,
    workerIdPrefix: options.workerIdPrefix,
    signal: options.signal,
  })
  const commit = await commitPendingStagingArtifacts({
    runtime: options.commitRuntime,
    files: options.commitFiles,
    holder: options.commitHolder,
    limit: options.commitLimit,
    concurrency: options.commitConcurrency,
    ttlMs: options.commitTtlMs,
  })
  return { enqueue, workerPool, commit }
}
