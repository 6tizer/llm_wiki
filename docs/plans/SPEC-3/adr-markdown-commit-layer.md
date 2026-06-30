# ADR: SPEC-3 Markdown Commit Layer

> Status: frozen for SPEC-3 PR2+ | Owner: Commander | Scope: SPEC-3 PR1

## Context

SPEC-3 introduces the commit boundary between parallel workers and durable Markdown. Workers may prepare staged artifacts in parallel, but only the Markdown commit layer writes final Markdown files.

Markdown remains committed truth. `runtime.db` remains runtime metadata: jobs, leases, events/progress, resource budgets, staging artifact status, derived stale markers, and migration bookkeeping. Staged artifact bodies live under the project runtime staging directory (`<project>/.llm-wiki/runtime/staging/`); SQLite stores only status, paths, hashes, and bounded metadata.

## Decision

The commit layer is a Core Runtime capability in the `markdown-commit` family. It is shell-neutral and does not depend on React, Zustand, Tauri plugin APIs, or direct command wrappers.

Contract maturity for PR1 is `frozen` for names, ownership, and invariants only. PR1 does not implement final Markdown writes, runtime DB migrations, repair jobs, or ingest prompt changes.

Commands:

| Name | Meaning |
| --- | --- |
| `markdown-commit:submit-artifact` | Register that a worker produced a staged Markdown candidate. |
| `markdown-commit:commit-path` | Request commit processing for one normalized affected Markdown path. |
| `markdown-commit:report-conflict` | Record that a candidate cannot be committed without repair/review. |
| `markdown-commit:enqueue-repair` | Request a bounded repair/review job for a conflict. |

Events:

| Name | Meaning |
| --- | --- |
| `markdown-commit:artifact-ready` | A staged artifact is ready for commit processing. |
| `markdown-commit:commit-applied` | Final Markdown was created, updated, appended, or deleted. |
| `markdown-commit:conflict-detected` | Commit processing detected a base/content conflict. |
| `markdown-commit:repair-queued` | A repair/review job was queued for a conflict. |

These Core Runtime contract events are notification names. Durable audit facts are appended through SPEC-2 `events-progress` using `job-runtime:event-append`; SPEC-3 must not create a separate commit-events table.

## Artifact Contract

Staged artifact metadata contains:

| Field | Meaning |
| --- | --- |
| `artifact_id` | Stable artifact identity, matching SPEC-2 staging artifact metadata. |
| `job_id` | Runtime job that produced the artifact. |
| `artifact_path` | Runtime staging-root-relative file path. |
| `artifact_hash` | Hash of staged artifact content. |
| `target_path` | Normalized project-relative Markdown path to commit. |
| `base_hash` | Hash of the committed Markdown content observed during prepare, or `null` when the target was absent. |
| `operation_intent` | `create`, `update`, `append`, or `delete`. |
| `source_kind` | Worker/source category for diagnostics, such as ingest, repair, synthesis, or manual. |
| `created_at_ms` | Runtime timestamp for audit ordering. |

Operation intents:

| Intent | Meaning |
| --- | --- |
| `create` | Target is expected to be absent and should be created. |
| `update` | Target is expected to exist and should be replaced or merged with staged content. |
| `append` | Target should receive an append/merge-style addition, used for hotspot append pages such as logs. |
| `delete` | Target should be removed only when the base still matches. |

Large LLM output is not stored in SQLite. The artifact body is a file in runtime staging; runtime DB rows store bounded metadata only.

## Result Contract

Commit results:

| Result | Meaning |
| --- | --- |
| `committed` | The requested create, update, append, or delete was applied without needing a content merge. |
| `merged` | Existing committed content and staged content were merged before final write. |
| `conflicted` | The candidate is valid, but current committed content no longer matches the expected base or cannot be safely reconciled. |
| `rejected` | The candidate is invalid before write, such as invalid path, missing artifact, bad hash, unsupported operation, or schema violation. |
| `skipped` | No final Markdown mutation was needed, such as deleting an already-missing path whose base was also absent. |

Each commit result records affected paths, artifact hash, base hash, current hash, final hash when present, result, and the runtime event id used for audit.

## Base Hash Matrix

| Intent | Current target state | Required outcome |
| --- | --- | --- |
| `create` | missing and `base_hash = null` | `committed` create. |
| `create` | exists while `base_hash = null` | `conflicted`; do not overwrite. |
| `update` | exists and current hash equals `base_hash` | `committed` or `merged`. |
| `update` | missing while `base_hash` is present | `conflicted`. |
| `update` | exists and current hash differs from `base_hash` | `conflicted`. |
| `append` | missing and `base_hash = null` | `committed` create with append content. |
| `append` | exists and current hash equals `base_hash` | `committed` append or `merged` append strategy. |
| `append` | exists and current hash differs from `base_hash` | `conflicted` unless a future append strategy explicitly proves safe. |
| `delete` | exists and current hash equals `base_hash` | `committed` delete. |
| `delete` | missing and `base_hash = null` | `skipped`. |
| `delete` | missing while `base_hash` is present | `skipped` with audit record. |
| `delete` | exists and current hash differs from `base_hash` | `conflicted`; do not delete. |

Any state not listed is rejected or conflicted visibly. There is no silent overwrite.

## SPEC-2 Dependencies

SPEC-3 depends on SPEC-2 primitives and must not define competing runtime state.

| Need | SPEC-2 owner | SPEC-3 rule |
| --- | --- | --- |
| Per-path serialization | `resource-budgets`, jobs, leases | Claim/release commit-path capacity through SPEC-2 operations; no SPEC-3-local limiter and no alternate commit queue. |
| Durable audit facts | `events-progress` | Append bounded commit audit payloads through `job-runtime:event-append`; no SPEC-3 commit-events table and no `runtime_commit_events` table. |
| Staging artifact status and cleanup | `staging-artifacts` | Update status only through SPEC-2-owned artifact status operations. Successful commit calls commit-success cleanup after final Markdown write and marker enqueue. Failed/conflict artifacts remain until SPEC-2 TTL/GC. No new artifact schema family. |
| Derived stale markers | `derived-stale-markers` | SPEC-3 owns the logical marker field set and writes/diagnoses through SPEC-2 operations; SPEC-6 consumes markers for rebuild scheduling. No SPEC-3-owned runtime write operations. If a SPEC-3 PR implements missing marker storage/API, it does so as SPEC-2-owned Core Runtime support. |
| Migration bookkeeping | `migrations` | SPEC-3 PR1 adds no new schema family and no migration. |

Per-path serialization is layered on SPEC-2 jobs, leases, and resource-budget claims. The commit layer must not introduce another queue, lock table, or scheduler.

Failed/conflict artifact TTL is owned by SPEC-2 `staging-artifacts` GC configuration. SPEC-3 may provide failure status and bounded `lastError` metadata, but it does not own TTL policy.

## Durable Audit Payload

Durable commit audit records are SPEC-2 event payloads. They must be bounded metadata suitable for `events-progress`, not large content snapshots.

Required audit fields:

| Field | Meaning |
| --- | --- |
| `kind` | Payload discriminator. PR4 uses `markdown-commit` because the SPEC-2 event name is generic. |
| `artifact_id` | Staged artifact identity. |
| `artifact_hash` | Hash of staged artifact content. |
| `source_kind` | Source worker kind from the staged artifact metadata. |
| `target_path` | Normalized affected Markdown path. |
| `operation_intent` | Intent attempted by commit processing. |
| `result` | Commit result. |
| `base_hash` | Prepare-time committed hash or `null`. |
| `current_hash` | Hash observed immediately before commit, when present. |
| `final_hash` | Hash after successful final write, when present. |
| `affected_paths` | Paths touched by the operation. |
| `repair_job_id` | Repair/review job id for conflicts, when queued. |
| `repair_error` | Bounded repair-routing failure detail for conflicts that could not queue a repair job. Added in PR5; absent when routing succeeds or is not attempted. Current PR5 TypeScript operation bounds this field to 1024 characters before audit append. |

Audit records cover both applied mutations and visible non-applied outcomes. A `rejected`, `conflicted`, or `skipped` audit event records the attempted commit decision and diagnostics; it does not imply committed Markdown content changed or that derived marker rows exist.

Content rollback is not provided by runtime DB. Users rely on the project/worktree history for content-level rollback.

## Derived Stale Marker Boundary

Logical marker fields:

| Field | Meaning |
| --- | --- |
| `layer` | `embedding`, `graph`, `taxonomy`, `synthesis`, `search`, `index_export`, or `overview`. |
| `affected_path` | Committed Markdown path that dirtied the derived layer. |
| `input_hash` | Post-commit input content hash. |
| `base_version` | Commit/event version used to detect stale markers. |
| `marked_at` | Marker creation timestamp. |
| `reason` | `commit`, `delete`, `schema_change`, or `manual_rebuild`. |
| `source_event_id` | Runtime event id for the commit audit fact. |
| `status` | `pending`, `claimed`, `done`, `failed`, or `cancelled`. |

SPEC-3 PR1 freezes the logical marker field set. SPEC-2 owns the physical schema and write operation. SPEC-3 PR4 may add the missing physical schema/API only as SPEC-2-owned Core Runtime support, not as a SPEC-3-owned store. SPEC-6 owns rebuild scheduling and terminal marker consumption.

## Index / Overview Boundary

`wiki/index.md` is an optional export/directory view. `wiki/overview.md` is an optional synthesis or user-authored summary. They are not required runtime pages and are not automatically maintained by normal ingest.

Existing `index.md` and `overview.md` files remain user Markdown assets. SPEC-3 does not delete them.

## Consequences

- PR2 can remove mandatory `index.md` / `overview.md` from normal ingest without changing commit behavior yet.
- PR3 can implement shell-neutral commit operation against frozen artifact/result/base-hash semantics.
- PR4 must write audit facts through SPEC-2 `events-progress` and markers through SPEC-2 `derived-stale-markers`.
- PR5 can create repair jobs without inventing a separate conflict store. It records repair jobs through SPEC-2 `runtime_jobs`, marks the conflicted staging artifact `failed` through SPEC-2 staging artifact metadata, and reuses the default failed-artifact TTL window of 7 days. If repair routing fails, the conflict audit event is still appended with `repair_job_id = null` and bounded `repair_error`. PR5 provides the commit-operation adapter slot and shell helper, but does not migrate normal production ingest/write flows onto a production Markdown commit adapter assembly.
- SPEC-5/6 cannot bypass the commit-layer hard gate.
