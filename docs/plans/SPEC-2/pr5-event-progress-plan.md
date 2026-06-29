# SPEC-2 PR5 Plan: Event Log / Progress API

> Type: PR execution plan | Status: in progress | Owner: Commander | Issue: #184 | Branch: `codex/spec-2-pr5-event-progress`

## Scope

PR5 adds the SPEC-2 `events-progress` runtime ledger on top of the PR2-PR4 runtime DB substrate.

Deliverables:

- Add portable SQLite schema for append-only runtime events and coalesced progress facts.
- Add forward migration bookkeeping for the `events-progress` schema family.
- Add Rust runtime operations for:
  - append durable job event;
  - append / coalesce progress fact;
  - snapshot-list job timeline;
  - snapshot-list active progress facts.
- Add heartbeat write throttling at the existing 5s minimum interval while keeping heartbeat renewals idempotent.
- Keep event/progress writes under the existing process-local single-writer guard.
- Keep public command boundaries shell-neutral and project-scoped through `ProjectRootState` only.
- Update `docs/plans/README.md` to mark PR4 merged and PR5 in progress.

## Non-Goals

- No UI timeline.
- No scheduler loop.
- No profile usage/status ledger.
- No derived stale marker schema.
- No staging artifact table or GC.
- No SPEC-3 Markdown commit operation.
- No worker pool integration.
- No cross-process writer lock.

## Constraints

- Disabled means no directory creation, DB open, migration, event append, or progress mutation.
- Public commands must not accept arbitrary project roots or filesystem paths.
- Event/progress payloads are metadata facts, not large LLM output blobs.
- Event append must not mutate job state; job state transitions remain PR3 operations.
- Heartbeat within 5s of the previous heartbeat is an idempotent no-op that returns the current job/lease snapshot without extending the lease.
- PR5 events are job-scoped only. Every event/progress write requires an existing `jobId`; runtime-scoped or artifact/resource-budget events remain out of scope.
- Progress may coalesce only optional progress event rows by `(job_id, progress_key)` within the configured min interval. Coalescing must never drop rows written through `runtime_event_append`, terminal events, state-transition events, migration writes, or resource-budget writes.
- Durable progress events bypass coalescing and must append a runtime event even when the same progress key was just updated.
- Snapshot reads must not migrate PR4-only DBs.
- Budget/job/lease/resource schema family versions remain unchanged.
- Runtime DB writes must keep foreign-key enforcement enabled and verified on the connection before inserting events/progress.
- Progress coalescing time comes from the Core Runtime single-writer's internal clock abstraction, never from public request fields. Tests may inject a single-writer test clock below the command boundary.
- Progress append, including durable progress, must complete in one single-writer transaction: optional `runtime_events` insert, `runtime_progress` upsert, and `last_event_id` update are atomic.

## Proposed Schema

### `runtime_events`

- `event_id TEXT PRIMARY KEY CHECK(length(event_id) > 0)`
- `job_id TEXT NOT NULL CHECK(length(job_id) > 0)`
- `event_name TEXT NOT NULL CHECK(length(event_name) > 0)`
- `payload TEXT NOT NULL CHECK(length(CAST(payload AS BLOB)) > 0 AND length(CAST(payload AS BLOB)) <= <literal max event payload bytes>)`
- `created_at_ms INTEGER NOT NULL CHECK(created_at_ms >= 0)`
- `FOREIGN KEY(job_id) REFERENCES runtime_jobs(job_id)`

Indexes:

- `runtime_events_job_time_idx` on `(job_id, created_at_ms, event_id)`.
- `runtime_events_time_idx` on `(created_at_ms, event_id)`.

### `runtime_progress`

- `job_id TEXT NOT NULL CHECK(length(job_id) > 0)`
- `progress_key TEXT NOT NULL CHECK(length(progress_key) > 0)`
- `payload TEXT NOT NULL CHECK(length(CAST(payload AS BLOB)) > 0 AND length(CAST(payload AS BLOB)) <= <literal max event payload bytes>)`
- `updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= 0)`
- `last_event_id TEXT`
- `PRIMARY KEY(job_id, progress_key)`
- `FOREIGN KEY(job_id) REFERENCES runtime_jobs(job_id)`
- `FOREIGN KEY(last_event_id) REFERENCES runtime_events(event_id)`

Indexes:

- `runtime_progress_updated_idx` on `(updated_at_ms, job_id, progress_key)`.

Validation constants:

- `MAX_EVENT_PAYLOAD_BYTES` is a conservative runtime metadata bound shared by event and progress payloads; the SQL migration must emit the literal numeric value in `CHECK` constraints because SQLite cannot reference the Rust constant name.
- Command-layer validation mirrors DB `CHECK` constraints so invalid requests fail before mutation where possible.
- Source of truth for the payload bound is the Rust `MAX_EVENT_PAYLOAD_BYTES` constant. SQL DDL literals and command-layer validation must be derived from or tested against that value so they cannot drift.

Migration rules:

- Add the `events-progress` schema family at version `1`.
- Migration is idempotent and must not refresh an existing `applied_at_ms` for version `1`.
- Higher existing `events-progress` family versions are preserved and never downgraded.
- Write paths may migrate only after PR2 base bookkeeping and PR3 `runtime_jobs` / `runtime_job_leases` parent tables are available, so event/progress foreign keys never point at missing tables.
- Snapshot list paths must be PR4-only compatible: if `events-progress` is absent, return an empty snapshot without creating tables or writing schema-family rows.

## Operation Semantics

Public command candidates:

- `runtime_event_append(request)`
- `runtime_progress_append(request)`
- `runtime_timeline_list(request?)`
- `runtime_progress_list(request?)`

Rules:

- Request shapes are shell-neutral metadata only: write requests require `jobId`; read requests may use optional `jobId`, bounded `limit` / cursor fields, event/progress names, payload, and a durable semantic flag.
- Requests must not include project root, runtime DB path, absolute filesystem path, relative filesystem path, shell command text, min interval override, timestamp override, or caller-provided clock override.
- PR5 writes only these event names:
  - `job-runtime:event-appended`: durable event append; never coalesced.
  - `job-runtime:progress-appended`: progress fact append or coalesce marker; coalescing may suppress only non-durable event rows.
- Additional event names require a plan update before implementation.
- Payload must be non-empty text and bounded by a conservative max size.
- `jobId` is required for writes and must reference an existing `runtime_jobs(job_id)`.
- Event append always inserts a durable row.
- Progress append may:
  - insert/update `runtime_progress`;
  - suppress only non-durable progress event rows within the min interval;
  - append a corresponding event when outside progress min interval or when caller marks it as durable;
  - leave `last_event_id` unchanged when a non-durable progress event row is suppressed;
  - update `last_event_id` to the newly inserted event when a progress event row is appended;
  - never coalesce terminal job events or state-transition events.
- Timeline list returns events ordered by `(created_at_ms, event_id)` and may filter by `jobId`.
- Timeline cursor, if implemented in PR5, is the ordered tuple `(created_at_ms, event_id)` so pagination cannot duplicate or skip rows with equal timestamps.
- Progress list returns current progress facts ordered by `(updated_at_ms, job_id, progress_key)` and may filter by `jobId`.
- If insertion order is required later, a separate monotonic sequence must be added; PR5 does not infer insertion order from timestamp alone.

## Tests / Verification

- disabled event/progress commands do not touch disk;
- disabled commands also do not open or migrate an existing corrupt `runtime.db` sentinel;
- enabled no-project write commands return `no-project`;
- enabled no-project read commands return an empty snapshot without creating directories or opening runtime DB;
- PR4-only DB timeline/progress list returns empty without migration;
- PR3 parent tables present but `events-progress` absent timeline/progress list returns empty without creating event/progress tables or schema-family rows;
- migration creates tables and preserves higher family version;
- migration is idempotent and does not refresh existing `applied_at_ms`;
- migration requires existing PR3 `runtime_jobs` parent table before creating FK-backed event/progress tables;
- append event with missing `jobId` is rejected;
- append event with existing `jobId` persists and timeline reads in order;
- append two events with the same `created_at_ms` and verify timeline sort by `(created_at_ms, event_id)`;
- heartbeat before 5s returns the existing lease snapshot without writing a new heartbeat/expires value;
- heartbeat at/after 5s updates heartbeat/expires values;
- progress append inserts then coalesces by `(job_id, progress_key)`;
- progress min interval boundary is tested through an internal single-writer test clock, not public request fields;
- durable progress bypasses coalescing;
- durable or terminal progress appended twice within the min interval still writes two `runtime_events` rows;
- durable progress followed by non-durable progress for the same key leaves `last_event_id` pointing to the durable event when the second event row is suppressed;
- payload size and blank field validation are tested;
- payload bound is tested at command validation and DB constraint boundaries against the same Rust source-of-truth constant;
- command-layer request shape rejects path-like fields and caller-provided clock overrides;
- `cargo test runtime_db --manifest-path src-tauri/Cargo.toml`;
- `pnpm lint`;
- `git diff --check`;
- `cargo build --release --manifest-path src-tauri/Cargo.toml`;
- `npx gitnexus detect-changes --repo llm_wiki`.

## Gate Plan

- Architect gate reviews this plan before implementation.
- If Claude ACP preflight fails, use ZCode Architect; if ZCode fails, use internal Architect.
- Before code edits, run GitNexus impact on:
  - `open_job_runtime_locked`
  - `runtime_job_list`
  - `runtime_commit_budget_list`
  - `run`
  - any contract constants if command/event metadata changes.
- After implementation, run Kimi Tester, ZCode Reviewer, internal Reviewer fallback, GitNexus detect, and CI before merge.

## Known Risks

- Progress coalescing can accidentally drop meaningful facts. PR5 must keep durable event append separate from progress coalescing.
- Payload size must remain bounded so SQLite does not become a large LLM-output store.
- Event ordering must be stable when multiple events share the same timestamp.
- Future UI/scheduler PRs must not treat progress rows as committed Markdown truth.
