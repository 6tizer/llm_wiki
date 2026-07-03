import type {
  MarkdownCommitConflictRepairContext,
  MarkdownCommitConflictRepairReceipt,
} from "@/core-runtime/markdown-commit"
import {
  runtimeJobCreate,
  runtimeStagingArtifactRecord,
} from "./runtime-db"

export const MARKDOWN_CONFLICT_REPAIR_KIND = "markdown-conflict-repair"
const MARKDOWN_CONFLICT_REPAIR_MAX_ATTEMPTS = 3
const MARKDOWN_CONFLICT_REPAIR_OWNER = "markdown-commit"
const MARKDOWN_CONFLICT_REPAIR_STRATEGY = "manual-review-first"

/** Routes a conflicted Markdown commit into SPEC-2 runtime repair primitives. */
export async function routeMarkdownConflictRepair(
  context: MarkdownCommitConflictRepairContext,
): Promise<MarkdownCommitConflictRepairReceipt> {
  await runtimeStagingArtifactRecord({
    artifactId: context.artifactId,
    jobId: context.jobId,
    artifactPath: context.artifactPath,
    artifactHash: context.artifactHash,
    status: "failed",
    lastError: context.conflictReason,
  })

  const job = await runtimeJobCreate({
    kind: MARKDOWN_CONFLICT_REPAIR_KIND,
    payload: JSON.stringify(buildRepairPayload(context)),
    maxAttempts: MARKDOWN_CONFLICT_REPAIR_MAX_ATTEMPTS,
  })

  return { repairJobId: job.jobId }
}

function buildRepairPayload(context: MarkdownCommitConflictRepairContext) {
  return {
    kind: MARKDOWN_CONFLICT_REPAIR_KIND,
    artifactId: context.artifactId,
    artifactHash: context.artifactHash,
    targetPath: context.targetPath,
    operationIntent: context.operationIntent,
    result: context.result,
    baseHash: context.baseHash,
    currentHash: context.currentHash,
    affectedPaths: context.affectedPaths,
    sourceKind: context.sourceKind,
    owner: MARKDOWN_CONFLICT_REPAIR_OWNER,
    strategy: MARKDOWN_CONFLICT_REPAIR_STRATEGY,
  }
}
