import {
  planBulkKnowledgePrepare,
  type BulkKnowledgePreparePlan,
  type BulkKnowledgeSourceInput,
  type BulkKnowledgePlannerOptions,
} from "@/core-runtime/parallel-knowledge"
import {
  runtimeJobCreate,
  type RuntimeJobCreateRequest,
  type RuntimeJobRecord,
} from "@/commands/runtime-db"
import { isDuplicateRuntimeJobError } from "@/lib/parallel-knowledge/runtime-job-errors"

export interface BulkKnowledgePrepareRuntimeAdapter {
  readonly createJob: (request: RuntimeJobCreateRequest) => Promise<RuntimeJobRecord>
}

export interface BulkKnowledgePrepareEnqueueOptions extends BulkKnowledgePlannerOptions {
  readonly runtime?: BulkKnowledgePrepareRuntimeAdapter
}

export interface BulkKnowledgePrepareJobCreateFailure {
  readonly jobId: string
  readonly message: string
}

export interface BulkKnowledgePrepareEnqueueResult {
  readonly plan: BulkKnowledgePreparePlan
  readonly enqueuedJobs: readonly RuntimeJobRecord[]
  readonly skippedDuplicateJobIds: readonly string[]
  readonly failedJobs: readonly BulkKnowledgePrepareJobCreateFailure[]
}

const DEFAULT_RUNTIME_ADAPTER: BulkKnowledgePrepareRuntimeAdapter = {
  createJob: runtimeJobCreate,
}

/** Plans source batches and enqueues bulk prepare runtime jobs. */
export async function enqueueBulkKnowledgePrepareJobs(
  sources: readonly BulkKnowledgeSourceInput[],
  options: BulkKnowledgePrepareEnqueueOptions = {},
): Promise<BulkKnowledgePrepareEnqueueResult> {
  const plan = planBulkKnowledgePrepare(sources, options)
  const runtime = options.runtime ?? DEFAULT_RUNTIME_ADAPTER
  const enqueuedJobs: RuntimeJobRecord[] = []
  const skippedDuplicateJobIds: string[] = []
  const failedJobs: BulkKnowledgePrepareJobCreateFailure[] = []

  for (const job of plan.jobs) {
    try {
      const record = await runtime.createJob({
        jobId: job.jobKey,
        kind: job.kind,
        payload: JSON.stringify(job.payload),
        maxAttempts: 3,
      })
      enqueuedJobs.push(record)
    } catch (error) {
      if (isDuplicateRuntimeJobError(describeError(error))) {
        skippedDuplicateJobIds.push(job.jobKey)
      } else {
        failedJobs.push({ jobId: job.jobKey, message: describeError(error) })
      }
    }
  }

  return {
    plan,
    enqueuedJobs,
    skippedDuplicateJobIds,
    failedJobs,
  }
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }
  if (typeof error === "string") {
    return error
  }
  return "runtime-job-create-failed"
}
