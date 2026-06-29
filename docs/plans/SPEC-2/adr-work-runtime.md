# ADR: SPEC-2 Work Runtime Hard Gate

> Type: ADR | Status: accepted for PR1 gate | Owner: Core Runtime | Run: `a5d238a7-2880-4c66-9640-496d94912e5f`

## Decision

SPEC-2 introduces a project-scoped Work Runtime ledger, but PR1 only freezes the rules. It does not create `runtime.db`, add SQLite crates, implement migrations, move queues, connect UI, or wire production commands.

The runtime ledger belongs to Core Runtime. UI Shell, Zustand mirrors, plugin-store, Markdown files, and adapter code may observe or request runtime operations through the Core Runtime contract, but they do not own persisted runtime state.

## Runtime DB Location And Ownership

`runtime.db` is project-scoped and tied to the SPEC-1 project identity boundary. The logical location is the project-local runtime metadata directory:

- Markdown truth: project wiki Markdown files.
- Runtime metadata: `<project>/.llm-wiki/runtime/runtime.db`.
- Staging artifacts: `<project>/.llm-wiki/runtime/staging/`.
- Vector/search indexes: `<project>/.llm-wiki/runtime/indexes/`.
- Derived caches: `<project>/.llm-wiki/runtime/cache/`.

`runtime.db` is runtime metadata only. It is not Markdown truth, not committed wiki content, not plugin-store truth, and not Zustand truth. It stores job coordination, leases, events, progress, resource budgets, profile usage/status facts, stale markers, artifact status, and schema bookkeeping owned by SPEC-2.

Project lifecycle rules:

- Delete: deleting the project deletes project-local runtime metadata with the project.
- Move: moving the project moves `runtime.db`, staging artifacts, indexes, and caches together because all are under the project-local runtime directory.
- Reopen: reopening a project reuses existing runtime metadata only when the SPEC-2 kill switch is enabled.
- Disabled reopen: a project that already has `runtime.db` must still open when the kill switch is off; Core Runtime must not read, write, or migrate that file.

## Kill Switch And First Version Default

The first-version default is disabled. The feature flag is named `core.workRuntime.enabled`.

Read timing and source:

- Core Runtime reads the flag during runtime bootstrap before workers, schedulers, or adapters start.
- Opening a project reads the same flag before any project runtime metadata path is touched.
- The flag source is Core Runtime process configuration. It must not depend on React render, Zustand state, or Tauri webview lifecycle.
- The value is treated as a startup/project-open decision for PR1/PR2; live toggling is deferred.

Disabled behavior:

- Current JSON/store and Markdown paths remain authoritative.
- Existing `runtime.db` files are ignored.
- No runtime migration is attempted.
- No runtime read/write handle is opened.

Enabled behavior is gated by later SPEC-2 implementation PRs. PR1 only defines the contract.

## Defaults And Configuration Source

The following defaults are normative until a later SPEC-2 PR adds a config surface:

| Setting | Default | Source rule |
| --- | --- | --- |
| retry max | `3` attempts per job | `core.workRuntime.retry.max`, falling back to this ADR default |
| lease TTL | `120000` ms | `core.workRuntime.lease.ttlMs`, falling back to this ADR default |
| heartbeat min interval | `5000` ms | `core.workRuntime.heartbeat.minIntervalMs`, falling back to this ADR default |
| progress min interval | `2000` ms | `core.workRuntime.progress.minIntervalMs`, falling back to this ADR default |
| writer actor queue size | `1000` entries | `core.workRuntime.writer.maxQueueEntries`, falling back to this ADR default |

Heartbeat renewals are idempotent while the job is `running`. Progress appends may be coalesced by job and progress key when the writer queue is under backpressure; terminal events, state transitions, resource budget operations, artifact status updates, and migration bookkeeping must not be dropped.

## Portable SQLite Schema Families

PR1 freezes schema families and direction only. It does not define table DDL, migration function signatures, crate APIs, or TypeScript runtime APIs.

Schema family inventory:

| Family | Direction | Owner | Purpose |
| --- | --- | --- | --- |
| `jobs` | Core Runtime write, snapshot read | SPEC-2 | Job identity, current state, retry counters, timestamps, and ownership metadata. |
| `leases` | Core Runtime write, snapshot read | SPEC-2 | Lease holder, lease expiry, heartbeat renewal, and timeout inputs. |
| `events-progress` | append by Core Runtime writer, timeline read | SPEC-2 | Durable job events and throttled progress facts. |
| `profile-usage` | append/update by Core Runtime writer, read by SPEC-4 | SPEC-2 | Model/profile usage accounting for runtime work. |
| `profile-status` | update by Core Runtime writer, read by SPEC-4 | SPEC-2 | Capability/probe status facts for model/profile routing. |
| `derived-stale-markers` | write through SPEC-2 operations, read by SPEC-3 | SPEC-2 | Derived knowledge invalidation markers. |
| `resource-budgets` | claim/release by Core Runtime writer, read by schedulers | SPEC-2 | Commit-path and worker resource budget accounting. |
| `staging-artifacts` | status update by Core Runtime writer, read by SPEC-3 | SPEC-2 | Runtime-owned status for staged Markdown/materialized artifacts. |
| `migrations` | forward-only bookkeeping by Core Runtime writer | SPEC-2 | Schema family/version direction tracking only. |

Migrations are forward-only at the ADR level: family version `N` advances to `N+1`. Rollback behavior must be represented by a later forward migration. PR1 does not implement a migrations table or name any migration module.

Portable SQLite guard:

- Use standard SQLite storage classes: `NULL`, `INTEGER`, `REAL`, `TEXT`, and `BLOB`.
- Use portable constraints such as `PRIMARY KEY`, `UNIQUE`, `NOT NULL`, `CHECK`, and foreign keys only where later implementation proves enforcement timing.
- Store structured payloads as opaque text/blob facts when needed, but do not rely on JSON operators, JSON functions, generated JSON indexes, or UDF semantics.
- Do not depend on Postgres, DuckDB, enum, array, UUID, JSONB, platform collation, ICU collation, or custom extension types.
- Do not depend on platform-specific path collation or case folding for identity.

## Job Operation And Event Inventory

Commands:

| Name | Meaning |
| --- | --- |
| `job-runtime:create` | Create a queued job. |
| `job-runtime:claim` | Claim a queued job for one worker lease. |
| `job-runtime:heartbeat` | Renew a running job lease idempotently. |
| `job-runtime:complete` | Complete a running job. |
| `job-runtime:fail` | Fail a running job or move it to retry wait. |
| `job-runtime:retry` | Requeue a failed or retry-wait job within retry max. |
| `job-runtime:cancel` | Cancel a non-terminal job. |
| `job-runtime:pause` | Pause a queued or running job. |
| `job-runtime:resume` | Resume a paused job back to queued. |
| `job-runtime:list` | Snapshot-read jobs without writing runtime state. |

Events:

| Name | Meaning |
| --- | --- |
| `job-runtime:job-created` | A job entered `queued`. |
| `job-runtime:job-claimed` | A job entered `running`. |
| `job-runtime:heartbeat-recorded` | A running lease was renewed. |
| `job-runtime:job-completed` | A job entered `completed`. |
| `job-runtime:job-failed` | A job entered `failed`. |
| `job-runtime:job-retry-waiting` | A job entered `retry-wait`. |
| `job-runtime:job-retried` | A job was requeued from `failed` or `retry-wait`. |
| `job-runtime:job-cancelled` | A job entered `cancelled`. |
| `job-runtime:job-paused` | A job entered `paused`. |
| `job-runtime:job-resumed` | A job was resumed to `queued`. |
| `job-runtime:lease-timed-out` | A running lease timed out and moved to retry wait or failed. |
| `job-runtime:event-appended` | A runtime event fact was appended. |
| `job-runtime:progress-appended` | A progress fact was appended or coalesced. |

Payload details remain ADR/contract metadata in PR1. No DB rows, SQL schema, or persistence module is introduced.

## Closed-World Job State Machine

Closed-world states:

| State | Meaning |
| --- | --- |
| `queued` | Job is waiting for claim. |
| `running` | Job has an active worker lease. |
| `paused` | Job is intentionally stopped and not claimable. |
| `completed` | Job finished successfully. |
| `failed` | Job recorded a failed outcome; explicit retry may requeue while under retry max. |
| `cancelled` | Job was intentionally stopped and must not run again. |
| `retry-wait` | Job is waiting for retry eligibility after failure or lease timeout. |

Transition table:

| Operation | From | To | Rule |
| --- | --- | --- | --- |
| `create` | `none` | `queued` | New jobs start queued. |
| `claim` | `queued` | `running` | Creates or replaces one active lease through the writer actor. |
| `heartbeat` | `running` | `running` | Idempotent lease renewal. |
| `complete` | `running` | `completed` | Terminal success. |
| `fail` | `running` | `failed` | Terminal failed outcome when retry max is exhausted or retry is not allowed. |
| `fail` | `running` | `retry-wait` | Retryable failed attempt while under retry max. |
| `retry` | `failed` | `queued` | Explicit retry, bounded by retry max. |
| `retry` | `retry-wait` | `queued` | Retry eligibility reached, bounded by retry max. |
| `cancel` | `queued` | `cancelled` | Pending work is cancelled before claim. |
| `cancel` | `running` | `cancelled` | Active lease is invalidated and worker result must be ignored. |
| `cancel` | `paused` | `cancelled` | Paused work is permanently stopped; resume is no longer valid. |
| `cancel` | `retry-wait` | `cancelled` | Scheduled retry is suppressed; retry is no longer valid. |
| `pause` | `queued` | `paused` | Pending work is removed from claim eligibility. |
| `pause` | `running` | `paused` | Active lease is invalidated or allowed to drain per later worker policy. |
| `resume` | `paused` | `queued` | Paused work becomes claimable again. |
| `lease-timeout` | `running` | `retry-wait` | Lease expired while retry remains available. |
| `lease-timeout` | `running` | `failed` | Lease expired and retry max is exhausted or retry is disabled. |

`lease-timeout` is an internal writer actor transition, not an invokable command.

Any state or transition not listed here must be rejected by the runtime contract. `completed` and `cancelled` are final terminal states. `failed` is an outcome state that may only leave through explicit `retry` while bounded by retry max; it is not cancellable.

## Single-Writer Runtime DB Actor

All writes must go through one Core Runtime DB writer actor. Worker code must not compete for SQLite write handles.

Single-writer operation set:

| Operation |
| --- |
| `job-runtime:create` |
| `job-runtime:claim` |
| `job-runtime:heartbeat` |
| `job-runtime:complete` |
| `job-runtime:fail` |
| `job-runtime:retry` |
| `job-runtime:cancel` |
| `job-runtime:pause` |
| `job-runtime:resume` |
| `job-runtime:lease-renewal` |
| `job-runtime:event-append` |
| `job-runtime:progress-append` |
| `job-runtime:resource-budget-claim` |
| `job-runtime:resource-budget-release` |
| `job-runtime:artifact-status-update` |
| `job-runtime:migration-bookkeeping` |

`job-runtime:list` is intentionally absent because it is a snapshot read. Snapshot reads may use short read transactions. Later implementation may add read handles, but writes remain serialized through the actor.

Backpressure behavior:

- State transitions and terminal events wait for writer capacity or fail visibly.
- Heartbeats may coalesce only with newer heartbeat facts for the same job/lease.
- Progress may coalesce by job/progress key within the progress min interval.
- Resource budget, artifact status, and migration bookkeeping writes are never dropped.

## SPEC-3 And SPEC-4 Gates

SPEC-3 gates:

- SPEC-3 may write derived stale markers only through SPEC-2-owned `derived-stale-markers` operations.
- SPEC-3 may consume commit-path budget only through SPEC-2-owned `resource-budgets` operations.
- SPEC-3 may update staging artifact status only through SPEC-2-owned `staging-artifacts` operations.
- SPEC-3 must not own runtime state, create an alternate commit queue, or define competing runtime schema names.

SPEC-4 gates:

- SPEC-4 may record profile usage only through SPEC-2-owned `profile-usage` operations.
- SPEC-4 may record capability status only through SPEC-2-owned `profile-status` operations.
- SPEC-4 must not own runtime state or define an alternate model-call ledger.

Cross-SPEC gate:

- Any SPEC-3 or SPEC-4 code PR that touches runtime schema names, persisted runtime state, runtime write operations, or job state transitions must wait for the corresponding SPEC-2 implementation PR. PR1 is a hard design gate, not permission to implement runtime persistence.
