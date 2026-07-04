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

/** Frozen profile command names from SPEC-4 PR1. */
export const PROFILE_COMMAND_NAMES = [
  "profiles:list",
  "profiles:create",
  "profiles:update",
  "profiles:test",
  "profiles:resolve-secret-reference",
  "profiles:read-capability-status",
] as const

/** Frozen profile event names from SPEC-4 PR1. */
export const PROFILE_EVENT_NAMES = [
  "profiles:profile-changed",
  "profiles:capability-changed",
] as const

/** Frozen markdown commit command names from SPEC-3 PR1. */
export const MARKDOWN_COMMIT_COMMAND_NAMES = [
  "markdown-commit:submit-artifact",
  "markdown-commit:commit-path",
  "markdown-commit:report-conflict",
  "markdown-commit:enqueue-repair",
] as const

/** Frozen markdown commit event names from SPEC-3 PR1. */
export const MARKDOWN_COMMIT_EVENT_NAMES = [
  "markdown-commit:artifact-ready",
  "markdown-commit:commit-applied",
  "markdown-commit:conflict-detected",
  "markdown-commit:repair-queued",
] as const

/** Commit-layer operation intents represented as inert contract metadata. */
export const MARKDOWN_COMMIT_OPERATION_INTENTS = [
  "create",
  "update",
  "append",
  "delete",
] as const

/** Commit-layer result names represented as inert contract metadata. */
export const MARKDOWN_COMMIT_RESULTS = [
  "committed",
  "merged",
  "conflicted",
  "rejected",
  "skipped",
] as const

/** Staged artifact metadata fields frozen by SPEC-3 PR1. */
export const MARKDOWN_COMMIT_ARTIFACT_FIELDS = [
  "artifact_id",
  "job_id",
  "artifact_path",
  "artifact_hash",
  "target_path",
  "base_hash",
  "operation_intent",
  "source_kind",
  "created_at_ms",
] as const

/** Durable audit payload fields frozen by SPEC-3 PR1 and amended by PR4/PR5. */
export const MARKDOWN_COMMIT_AUDIT_FIELDS = [
  "kind",
  "artifact_id",
  "artifact_hash",
  "source_kind",
  "target_path",
  "operation_intent",
  "result",
  "base_hash",
  "current_hash",
  "final_hash",
  "affected_paths",
  "repair_job_id",
  "repair_error",
] as const

/** Base-hash decision matrix rows frozen as inert contract metadata. */
export const MARKDOWN_COMMIT_BASE_HASH_CASES = [
  {
    intent: "create",
    currentState: "missing and base_hash = null",
    requiredOutcome: "committed create.",
  },
  {
    intent: "create",
    currentState: "exists while base_hash = null",
    requiredOutcome: "conflicted; do not overwrite.",
  },
  {
    intent: "update",
    currentState: "exists and current hash equals base_hash",
    requiredOutcome: "committed or merged.",
  },
  {
    intent: "update",
    currentState: "missing while base_hash is present",
    requiredOutcome: "conflicted.",
  },
  {
    intent: "update",
    currentState: "exists and current hash differs from base_hash",
    requiredOutcome: "conflicted.",
  },
  {
    intent: "append",
    currentState: "missing and base_hash = null",
    requiredOutcome: "committed create with append content.",
  },
  {
    intent: "append",
    currentState: "exists and current hash equals base_hash",
    requiredOutcome: "committed append or merged append strategy.",
  },
  {
    intent: "append",
    currentState: "exists and current hash differs from base_hash",
    requiredOutcome: "conflicted unless a future append strategy explicitly proves safe.",
  },
  {
    intent: "delete",
    currentState: "exists and current hash equals base_hash",
    requiredOutcome: "committed delete.",
  },
  {
    intent: "delete",
    currentState: "missing and base_hash = null",
    requiredOutcome: "skipped.",
  },
  {
    intent: "delete",
    currentState: "missing while base_hash is present",
    requiredOutcome: "skipped with audit record.",
  },
  {
    intent: "delete",
    currentState: "exists and current hash differs from base_hash",
    requiredOutcome: "conflicted; do not delete.",
  },
] as const

/**
 * Logical derived marker layers dirtied by committed Markdown changes
 * (SPEC-3 contract; value set frozen — SPEC-6 PR3+4 investigation only
 * clarified which members are wired to a real consumer, it did not change
 * this list). Two groups:
 *
 * - **Materialized, job-backed**: `"embedding"`, `"taxonomy"`, `"synthesis"`,
 *   `"index_export"`, `"overview"`. Each has (or, for `"synthesis"`, is
 *   deliberately given a manual-action-as-consumer instead of an automatic
 *   job — see synthesis-staleness.ts) a real derived artifact and a
 *   `runtime_derived_marker_claim_batch`/`complete`/`release`-backed
 *   consumer that converges it: `embedding-consumer.ts` (SPEC-6 PR2),
 *   `taxonomy-consumer.ts` (SPEC-6 PR3+4); `index_export`/`overview` will
 *   get PR5's on-demand manual-rebuild jobs (not yet implemented — until
 *   PR5 lands, these two layers accumulate markers with no consumer yet,
 *   which is the accepted interim state, not a bug).
 * - **Declared, no materialized artifact**: `"graph"`, `"search"`. `"graph"`
 *   (wiki-graph.ts) always recomputes live from the committed wiki tree —
 *   graph-relevance.ts's cache is an in-memory read-through, not a rebuild
 *   target — so there is nothing for a consumer to converge; SPEC-6 PR3+4
 *   removed it from `COMMIT_DERIVED_STALE_MARKER_LAYERS`
 *   (commit-integration.ts) so it stops accumulating pending marker rows
 *   with no consumer (Wiring Gate philosophy). `"search"` is real-time
 *   scan + vector search, and vector search is already covered by the
 *   `"embedding"` layer, so it is likewise never marked on commit. Both
 *   remain valid, storable layer values (a caller CAN still record a
 *   marker for them) in case a future materialized artifact reintroduces
 *   the need — see this file's `follow-ups` in
 *   docs/plans/SPEC-6/pr3-4-taxonomy-synthesis-plan.md.
 */
export const DERIVED_STALE_MARKER_LAYERS = [
  "embedding",
  "graph",
  "taxonomy",
  "synthesis",
  "search",
  "index_export",
  "overview",
] as const

/** Logical reasons a derived stale marker exists. */
export const DERIVED_STALE_MARKER_REASONS = [
  "commit",
  "delete",
  "schema_change",
  "manual_rebuild",
] as const

/** Frozen markdown commit command names from SPEC-3 PR1. */
export type MarkdownCommitCommandName = (typeof MARKDOWN_COMMIT_COMMAND_NAMES)[number]

/** Frozen markdown commit event names from SPEC-3 PR1. */
export type MarkdownCommitEventName = (typeof MARKDOWN_COMMIT_EVENT_NAMES)[number]

/** Frozen profile command names from SPEC-4 PR1. */
export type ProfileCommandName = (typeof PROFILE_COMMAND_NAMES)[number]

/** Frozen profile event names from SPEC-4 PR1. */
export type ProfileEventName = (typeof PROFILE_EVENT_NAMES)[number]

/** Commit-layer operation intents represented as inert contract metadata. */
export type MarkdownCommitOperationIntent = (typeof MARKDOWN_COMMIT_OPERATION_INTENTS)[number]

/** Commit-layer result names represented as inert contract metadata. */
export type MarkdownCommitResult = (typeof MARKDOWN_COMMIT_RESULTS)[number]

/** Staged artifact metadata field names frozen by SPEC-3 PR1. */
export type MarkdownCommitArtifactField = (typeof MARKDOWN_COMMIT_ARTIFACT_FIELDS)[number]

/** Durable audit payload field names frozen by SPEC-3 PR1. */
export type MarkdownCommitAuditField = (typeof MARKDOWN_COMMIT_AUDIT_FIELDS)[number]

/** Base-hash decision matrix row frozen by SPEC-3 PR1. */
export type MarkdownCommitBaseHashCase = (typeof MARKDOWN_COMMIT_BASE_HASH_CASES)[number]

/** Logical derived marker layers dirtied by committed Markdown changes. */
export type DerivedStaleMarkerLayer = (typeof DERIVED_STALE_MARKER_LAYERS)[number]

/** Logical reasons a derived stale marker exists. */
export type DerivedStaleMarkerReason = (typeof DERIVED_STALE_MARKER_REASONS)[number]

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

/** Frozen message names by runtime family; non-special families stay placeholder-only. */
export const RUNTIME_CONTRACT_MESSAGES: Readonly<Record<
  RuntimeContractFamily,
  {
    readonly commandNames: readonly string[]
    readonly eventNames: readonly string[]
  }
>> = {
  project: {
    commandNames: ["project:placeholder-command"],
    eventNames: ["project:placeholder-event"],
  },
  "job-runtime": {
    commandNames: JOB_RUNTIME_COMMAND_NAMES,
    eventNames: JOB_RUNTIME_EVENT_NAMES,
  },
  "markdown-commit": {
    commandNames: MARKDOWN_COMMIT_COMMAND_NAMES,
    eventNames: MARKDOWN_COMMIT_EVENT_NAMES,
  },
  profiles: {
    commandNames: PROFILE_COMMAND_NAMES,
    eventNames: PROFILE_EVENT_NAMES,
  },
  derived: {
    commandNames: ["derived:placeholder-command"],
    eventNames: ["derived:placeholder-event"],
  },
  "search-vector": {
    commandNames: ["search-vector:placeholder-command"],
    eventNames: ["search-vector:placeholder-event"],
  },
  "file-platform": {
    commandNames: ["file-platform:placeholder-command"],
    eventNames: ["file-platform:placeholder-event"],
  },
  "process-cli": {
    commandNames: ["process-cli:placeholder-command"],
    eventNames: ["process-cli:placeholder-event"],
  },
  "agent-run": {
    commandNames: ["agent-run:placeholder-command"],
    eventNames: ["agent-run:placeholder-event"],
  },
  "settings-status": {
    commandNames: ["settings-status:placeholder-command"],
    eventNames: ["settings-status:placeholder-event"],
  },
}

export function createMockCoreRuntimeContract(): CoreRuntimeContract {
  const messages = RUNTIME_CONTRACT_FAMILIES.flatMap((family) => [
    ...RUNTIME_CONTRACT_MESSAGES[family].commandNames.map((name) => ({
      family,
      direction: "command" as const,
      name,
      payloadShape: "placeholder" as const,
    })),
    ...RUNTIME_CONTRACT_MESSAGES[family].eventNames.map((name) => ({
      family,
      direction: "event" as const,
      name,
      payloadShape: "placeholder" as const,
    })),
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
