import type { BulkKnowledgeSourceInput } from "@/core-runtime/parallel-knowledge"
import {
  enqueueBulkKnowledgePrepareJobs,
  type BulkKnowledgePrepareEnqueueOptions,
  type BulkKnowledgePrepareEnqueueResult,
} from "./bulk-runtime-entry"
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
}

export interface BulkKnowledgePrepareDriverResult {
  readonly enqueue: BulkKnowledgePrepareEnqueueResult
  readonly workerPool: PrepareWorkerPoolResult
}

/**
 * Plans + enqueues bulk-prepare runtime jobs, then fires one pass of the
 * prepare worker pool to drain whatever prepare jobs are queued at that
 * moment (this call's own jobs, plus anything else already queued).
 *
 * KNOWN PR1 BOUNDARY: this is a single fire-and-forget pass, not a
 * scheduler — it does not poll for or automatically pick up prepare jobs
 * enqueued later by an unrelated call. Continuous background draining
 * (heartbeat-based lease renewal, a recurring drain loop) is out of scope
 * for PR1; see the SPEC-5-FIX PR1 design doc for the PR2+ plan.
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
  return { enqueue, workerPool }
}
