import type { RuntimeProgressAppendRequest } from "@/commands/runtime-db"

/** Builds the shared durable runtime progress append request shape. */
export function buildRuntimeProgressAppendRequest(args: {
  jobId: string
  progressKey: string
  type: string
  payload: Record<string, unknown>
}): RuntimeProgressAppendRequest {
  return {
    jobId: args.jobId,
    progressKey: args.progressKey,
    durable: true,
    payload: JSON.stringify({
      type: args.type,
      ...args.payload,
    }),
  }
}
