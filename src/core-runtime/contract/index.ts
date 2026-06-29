/**
 * Shell-agnostic Core Runtime contract skeleton.
 *
 * This file is intentionally limited to inert types and mockable interfaces.
 * It must not import React, Zustand stores, Tauri APIs, plugin-store, or any
 * runtime persistence implementation.
 */

export type RuntimeContractFamily =
  | "project"
  | "job-runtime"
  | "markdown-commit"
  | "profiles"
  | "derived"
  | "search-vector"
  | "file-platform"
  | "process-cli"
  | "agent-run"
  | "settings-status"

export type RuntimeDirection = "command" | "event"

export type JobRuntimeCommandName =
  | "job-runtime:create"
  | "job-runtime:claim"
  | "job-runtime:heartbeat"
  | "job-runtime:complete"
  | "job-runtime:fail"
  | "job-runtime:retry"
  | "job-runtime:cancel"
  | "job-runtime:pause"
  | "job-runtime:resume"
  | "job-runtime:list"

export type JobRuntimeEventName =
  | "job-runtime:job-created"
  | "job-runtime:job-claimed"
  | "job-runtime:heartbeat-recorded"
  | "job-runtime:job-completed"
  | "job-runtime:job-failed"
  | "job-runtime:job-retry-waiting"
  | "job-runtime:job-retried"
  | "job-runtime:job-cancelled"
  | "job-runtime:job-paused"
  | "job-runtime:job-resumed"
  | "job-runtime:lease-timed-out"
  | "job-runtime:event-appended"
  | "job-runtime:progress-appended"

export type JobRuntimeSchemaFamily =
  | "jobs"
  | "leases"
  | "events-progress"
  | "profile-usage"
  | "profile-status"
  | "derived-stale-markers"
  | "resource-budgets"
  | "staging-artifacts"
  | "migrations"

export type JobRuntimeState =
  | "queued"
  | "running"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled"
  | "retry-wait"

export type JobRuntimeTransition = {
  readonly operation:
    | "create"
    | "claim"
    | "heartbeat"
    | "complete"
    | "fail"
    | "retry"
    | "cancel"
    | "pause"
    | "resume"
    | "lease-timeout"
  readonly from: JobRuntimeState | "none"
  readonly to: JobRuntimeState
}

export type JobRuntimeSingleWriterOperation =
  | "job-runtime:create"
  | "job-runtime:claim"
  | "job-runtime:heartbeat"
  | "job-runtime:complete"
  | "job-runtime:fail"
  | "job-runtime:retry"
  | "job-runtime:cancel"
  | "job-runtime:pause"
  | "job-runtime:resume"
  | "job-runtime:lease-renewal"
  | "job-runtime:event-append"
  | "job-runtime:progress-append"
  | "job-runtime:resource-budget-claim"
  | "job-runtime:resource-budget-release"
  | "job-runtime:artifact-status-update"
  | "job-runtime:migration-bookkeeping"

export type JobRuntimeDefaults = {
  readonly retryMax: 3
  readonly leaseTtlMs: 120000
  readonly heartbeatMinIntervalMs: 5000
  readonly progressMinIntervalMs: 2000
  readonly writerMaxQueueEntries: 1000
}

export interface RuntimeContractMessage {
  family: RuntimeContractFamily
  direction: RuntimeDirection
  name: string
  payloadShape: "placeholder"
}

export interface RuntimeContractError {
  code: string
  message: string
  retryable?: boolean
}

export interface CoreRuntimeContract {
  readonly maturity: "frozen"
  listMessages(): readonly RuntimeContractMessage[]
  invokePlaceholder(
    message: RuntimeContractMessage,
  ): Promise<{ ok: true } | { ok: false; error: RuntimeContractError }>
}

export const RUNTIME_CONTRACT_FAMILIES: readonly RuntimeContractFamily[] = [
  "project",
  "job-runtime",
  "markdown-commit",
  "profiles",
  "derived",
  "search-vector",
  "file-platform",
  "process-cli",
  "agent-run",
  "settings-status",
]

export const JOB_RUNTIME_COMMAND_NAMES: readonly JobRuntimeCommandName[] = [
  "job-runtime:create",
  "job-runtime:claim",
  "job-runtime:heartbeat",
  "job-runtime:complete",
  "job-runtime:fail",
  "job-runtime:retry",
  "job-runtime:cancel",
  "job-runtime:pause",
  "job-runtime:resume",
  "job-runtime:list",
]

export const JOB_RUNTIME_EVENT_NAMES: readonly JobRuntimeEventName[] = [
  "job-runtime:job-created",
  "job-runtime:job-claimed",
  "job-runtime:heartbeat-recorded",
  "job-runtime:job-completed",
  "job-runtime:job-failed",
  "job-runtime:job-retry-waiting",
  "job-runtime:job-retried",
  "job-runtime:job-cancelled",
  "job-runtime:job-paused",
  "job-runtime:job-resumed",
  "job-runtime:lease-timed-out",
  "job-runtime:event-appended",
  "job-runtime:progress-appended",
]

export const JOB_RUNTIME_SCHEMA_FAMILIES: readonly JobRuntimeSchemaFamily[] = [
  "jobs",
  "leases",
  "events-progress",
  "profile-usage",
  "profile-status",
  "derived-stale-markers",
  "resource-budgets",
  "staging-artifacts",
  "migrations",
]

export const JOB_RUNTIME_STATES: readonly JobRuntimeState[] = [
  "queued",
  "running",
  "paused",
  "completed",
  "failed",
  "cancelled",
  "retry-wait",
]

export const JOB_RUNTIME_TRANSITIONS: readonly JobRuntimeTransition[] = [
  { operation: "create", from: "none", to: "queued" },
  { operation: "claim", from: "queued", to: "running" },
  { operation: "heartbeat", from: "running", to: "running" },
  { operation: "complete", from: "running", to: "completed" },
  { operation: "fail", from: "running", to: "failed" },
  { operation: "fail", from: "running", to: "retry-wait" },
  { operation: "retry", from: "failed", to: "queued" },
  { operation: "retry", from: "retry-wait", to: "queued" },
  { operation: "cancel", from: "queued", to: "cancelled" },
  { operation: "cancel", from: "running", to: "cancelled" },
  { operation: "cancel", from: "paused", to: "cancelled" },
  { operation: "cancel", from: "retry-wait", to: "cancelled" },
  { operation: "pause", from: "queued", to: "paused" },
  { operation: "pause", from: "running", to: "paused" },
  { operation: "resume", from: "paused", to: "queued" },
  { operation: "lease-timeout", from: "running", to: "retry-wait" },
  { operation: "lease-timeout", from: "running", to: "failed" },
]

export const JOB_RUNTIME_SINGLE_WRITER_OPERATIONS: readonly JobRuntimeSingleWriterOperation[] = [
  "job-runtime:create",
  "job-runtime:claim",
  "job-runtime:heartbeat",
  "job-runtime:complete",
  "job-runtime:fail",
  "job-runtime:retry",
  "job-runtime:cancel",
  "job-runtime:pause",
  "job-runtime:resume",
  "job-runtime:lease-renewal",
  "job-runtime:event-append",
  "job-runtime:progress-append",
  "job-runtime:resource-budget-claim",
  "job-runtime:resource-budget-release",
  "job-runtime:artifact-status-update",
  "job-runtime:migration-bookkeeping",
]

export const JOB_RUNTIME_DEFAULTS: JobRuntimeDefaults = {
  retryMax: 3,
  leaseTtlMs: 120000,
  heartbeatMinIntervalMs: 5000,
  progressMinIntervalMs: 2000,
  writerMaxQueueEntries: 1000,
}

export function createMockCoreRuntimeContract(): CoreRuntimeContract {
  const messages = RUNTIME_CONTRACT_FAMILIES.flatMap((family) => [
    ...(family === "job-runtime"
      ? JOB_RUNTIME_COMMAND_NAMES.map((name) => ({
          family,
          direction: "command" as const,
          name,
          payloadShape: "placeholder" as const,
        }))
      : [
          {
            family,
            direction: "command" as const,
            name: `${family}:placeholder-command`,
            payloadShape: "placeholder" as const,
          },
        ]),
    ...(family === "job-runtime"
      ? JOB_RUNTIME_EVENT_NAMES.map((name) => ({
          family,
          direction: "event" as const,
          name,
          payloadShape: "placeholder" as const,
        }))
      : [
          {
            family,
            direction: "event" as const,
            name: `${family}:placeholder-event`,
            payloadShape: "placeholder" as const,
          },
        ]),
  ])

  return {
    maturity: "frozen",
    listMessages: () => messages,
    invokePlaceholder: async (message) => {
      if (!RUNTIME_CONTRACT_FAMILIES.includes(message.family)) {
        return {
          ok: false,
          error: {
            code: "UNKNOWN_FAMILY",
            message: `Unknown runtime contract family: ${message.family}`,
            retryable: false,
          },
        }
      }
      return { ok: true }
    },
  }
}
