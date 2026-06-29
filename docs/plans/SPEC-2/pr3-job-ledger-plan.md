# SPEC-2 PR3 Plan: Job Ledger / Lease / Heartbeat / Retry / Cancel

> Type: PR execution plan | Status: in progress | Owner: Commander | Issue: #184 | Branch: `codex/spec-2-pr3-job-ledger`

## Scope

PR3 turns the inert PR2 runtime DB substrate into the first job ledger implementation.

Deliverables:

- Add portable SQLite schema for `jobs` and `leases`.
- Add forward migration bookkeeping for `jobs` and `leases` schema families.
- Add Rust job runtime operations for:
  - create queued job;
  - claim one queued job with one active lease;
  - heartbeat an active lease;
  - complete a running job;
  - fail a running job into `failed` or `retry-wait`;
  - retry a `failed` / retry-eligible `retry-wait` job;
  - cancel non-terminal jobs.
- Add a process-local single-writer guard for all PR3 runtime writes: jobs/leases DDL, migration bookkeeping, create, claim, heartbeat, complete, fail, retry, cancel, and lease-timeout.
- Add snapshot list/read support for tests and shell-neutral inspection.
- Register shell-neutral Tauri commands for PR3 operations, scoped through `ProjectRootState` only.
- Keep the kill switch default disabled and preserve PR2 no-touch behavior when disabled.
- Update `docs/plans/README.md` to mark PR2 merged and PR3 in progress.

## Non-Goals

- No event/progress log table.
- No profile usage/status ledger.
- No derived stale marker table.
- No resource budget table.
- No staging artifact table or GC.
- No scheduler loop.
- No worker integration.
- No ingest queue migration.
- No React/Zustand/UI wiring.
- No TypeScript wrapper unless a non-test caller is introduced in this PR.
- No public pause/resume commands. PR3 persists the frozen `paused` state for contract compatibility, but no PR3 operation creates it; `paused` rows may only appear from seeded tests or future PRs.
- No lease-timeout scheduler. PR3 provides only the internal helper and schema/index support; expired active leases are not automatically recovered until a later SPEC-2 scheduler PR scans them.

## PR1 / PR2 Constraints

- `runtime.db` lives at `<project>/.llm-wiki/runtime/runtime.db`.
- Public Tauri commands must not accept arbitrary webview-supplied project paths.
- `core.workRuntime.enabled` defaults to disabled. PR3 may continue using `LLM_WIKI_CORE_WORK_RUNTIME_ENABLED` only as the temporary command adapter source for that ADR flag.
- Disabled means no directory creation, no DB open, no migration, and no job mutation.
- SQLite schema must use portable SQLite storage classes and constraints only.
- Markdown remains committed truth. `runtime.db` is runtime coordination metadata only.
- Worker code must not compete for SQLite write handles. PR3 write operations must go through a single writer guard.
- Snapshot reads may use short read transactions and do not need to go through the writer guard.

## Schema Design

Preferred module:

- `src-tauri/src/commands/runtime_db.rs`

PR3 should keep PR2 health/init behavior and extend it carefully.

### `runtime_jobs`

Portable columns:

- `job_id TEXT PRIMARY KEY`
- `kind TEXT NOT NULL`
- `payload TEXT NOT NULL`
- `state TEXT NOT NULL CHECK (state IN ('queued', 'running', 'paused', 'completed', 'failed', 'cancelled', 'retry-wait'))`
- `attempt INTEGER NOT NULL`
- `max_attempts INTEGER NOT NULL`
- `priority INTEGER NOT NULL`
- `created_at_ms INTEGER NOT NULL`
- `updated_at_ms INTEGER NOT NULL`
- `queued_at_ms INTEGER`
- `started_at_ms INTEGER`
- `completed_at_ms INTEGER`
- `failed_at_ms INTEGER`
- `cancelled_at_ms INTEGER`
- `retry_after_ms INTEGER`
- `last_error TEXT`

Indexes:

- `runtime_jobs_claim_idx` on `(state, priority DESC, queued_at_ms ASC, created_at_ms ASC)`.
- `runtime_jobs_retry_idx` on `(state, retry_after_ms)`.

### `runtime_job_leases`

Portable columns:

- `lease_id TEXT PRIMARY KEY`
- `job_id TEXT NOT NULL`
- `holder TEXT NOT NULL`
- `acquired_at_ms INTEGER NOT NULL`
- `heartbeat_at_ms INTEGER NOT NULL`
- `expires_at_ms INTEGER NOT NULL`
- `released_at_ms INTEGER`
- `status TEXT NOT NULL CHECK (status IN ('active', 'released', 'expired', 'cancelled'))`
- `FOREIGN KEY(job_id) REFERENCES runtime_jobs(job_id)`

Indexes:

- `runtime_job_leases_job_active_idx` on `(job_id, status)`.
- `runtime_job_active_lease_unique_idx` unique on `job_id WHERE status = 'active'`.
- `runtime_job_leases_expiry_idx` on `(status, expires_at_ms)`.

Foreign key hard gate:

- Every PR3 write connection must execute `PRAGMA foreign_keys = ON` before schema or mutation work.
- Implementation must verify `PRAGMA foreign_keys` returns `1`; otherwise return a visible error before writing.
- Tests must prove orphan leases are rejected.

Active lease hard gate:

- Use the SQLite partial unique index above as the DB-level invariant.
- Keep an equivalent writer-transaction check before inserting a new active lease so errors are explicit and tests are readable.
- Concurrent claim tests must prove only one active lease can exist for a job.

### Migration Families

- Keep PR2 `migrations` family at version `1`.
- Add / advance `jobs` family to version `1`.
- Add / advance `leases` family to version `1`.
- Migration must be idempotent and must not refresh `applied_at_ms` for already-applied versions.

## Operation Semantics

Use ADR state names exactly:

- `queued`
- `running`
- `paused`
- `completed`
- `failed`
- `cancelled`
- `retry-wait`

PR3 operations:

- `create`: insert a `queued` job with `attempt = 0`, default `max_attempts = 3`, default priority `0`, and required `kind` / `payload`.
- `claim`: atomically select one `queued` job, mark it `running`, create exactly one `active` lease, set `started_at_ms`, and increment `attempt`.
- `heartbeat`: only for `running` jobs with an unexpired `active` matching lease; renew `heartbeat_at_ms` / `expires_at_ms`; idempotent for the same active lease.
- `complete`: only for `running` jobs with an unexpired `active` matching lease; mark job `completed`, release lease.
- `fail`: only for `running` jobs with an unexpired `active` matching lease; if retry remains, mark `retry-wait` and set `retry_after_ms`; otherwise mark `failed`; release lease.
- `retry`: only for `failed` or retry-eligible `retry-wait`; bounded by `max_attempts`; `retry-wait` is retry-eligible only when `retry_after_ms <= now`; move back to `queued`.
- `cancel`: allowed from `queued`, `running`, `paused`, or `retry-wait`; terminal `cancelled`; active lease becomes `cancelled`; any later heartbeat/complete/fail using the old lease must be rejected without changing `cancelled`.
- `lease-timeout`: internal helper, not public command; expired active leases move `running` jobs to `retry-wait` or `failed` and mark lease `expired`.
- `list`: snapshot read; no mutation.
- `pause` / `resume`: not implemented or exposed in PR3. PR3 must not remove or change the frozen ADR/TypeScript contract names. If a `paused` row exists, PR3 supports only `cancel` from that state and rejects claim/retry/complete/fail/heartbeat.

Rejected transitions must return typed errors and must not partially write.

## Single-Writer Coverage

PR3 must introduce one process-local writer guard and route every write through it:

- PR2 base runtime init that creates `.llm-wiki/runtime`, opens DB, sets WAL, and writes `migrations`;
- PR3 jobs/leases DDL;
- PR3 `runtime_schema_migrations` writes for `jobs` and `leases`;
- `create`;
- `claim`;
- `heartbeat`;
- `complete`;
- `fail`;
- `retry`;
- `cancel`;
- internal `lease-timeout`.

Snapshot `list` reads are the only PR3 operation explicitly outside the writer guard.

The plan accepts a process-local mutex as the PR3 hard gate. Cross-process locking, durable actor queues, worker scheduling, and backpressure policy remain later SPEC-2 work.

## Tauri Command Boundary

Public commands must be added for the PR3 operations and may only:

- read project root exclusively from `ProjectRootState`;
- honor disabled/no-project no-touch behavior;
- do not accept arbitrary filesystem paths;
- do not depend on React render, Zustand, plugin-store, or webview lifecycle;
- do not expose internal test-only clock or project path controls.

Expected command surface:

- `runtime_job_create(request)`
- `runtime_job_claim(request)`
- `runtime_job_heartbeat(request)`
- `runtime_job_complete(request)`
- `runtime_job_fail(request)`
- `runtime_job_retry(request)`
- `runtime_job_cancel(request)`
- `runtime_job_list()`

Request/response structs must be serializable, documented when public, and avoid opaque filesystem paths. Internal helper functions may accept an explicit project root and deterministic clock for tests; public commands must not.

## Key Files / Symbols

- `docs/plans/SPEC-2/pr3-job-ledger-plan.md`
- `docs/plans/README.md`
- `src-tauri/src/commands/runtime_db.rs`
- `src-tauri/src/lib.rs`
- `src-tauri/src/commands/mod.rs`
- optional: focused TypeScript contract tests only if contract metadata changes

## GitNexus Impact Targets Before Implementation

Run before code edits:

- `runtime_db_health`
- `run`
- `ProjectRootState`
- `JOB_RUNTIME_TRANSITIONS` only if TypeScript contract metadata changes
- `JOB_RUNTIME_COMMAND_NAMES` only if TypeScript contract metadata changes

Expected initial risk:

- `runtime_db_health`: now indexed after PR2, likely low/medium depending command registration flows.
- `run`: medium because command registration participates in app startup flows.
- `ProjectRootState`: expected low if read-only.
- Contract constants: expected test-only / contract-flow risk if unchanged.

Any HIGH/CRITICAL impact must pause for explicit Commander review.

## Implementation Order

1. Write this PR plan.
2. Run Architect gate on schema, operation semantics, and single-writer approach.
3. Run GitNexus impact on target symbols.
4. Add job/lease migrations and idempotency tests.
5. Add job operation helpers with explicit typed errors.
6. Add process-local single-writer guard around all mutations.
7. Register only safe Tauri commands.
8. Add focused Rust tests for transitions, leases, retries, cancel, timeout, disabled/no-project behavior, and concurrent claim.
9. Run local verification and GitNexus detect.
10. Run Tester / Reviewer gates.

## Test Plan

Focused Rust tests:

- disabled job operations do not create/open/migrate runtime DB;
- no-project enabled job operations return no-project/error and do not touch disk;
- migration creates `runtime_jobs` and `runtime_job_leases`;
- migrations are idempotent and preserve `applied_at_ms`;
- write connections enable and verify SQLite foreign key enforcement;
- orphan lease insertion is rejected;
- create inserts queued job with defaults;
- claim atomically moves one queued job to running and creates one active lease;
- two concurrent claims cannot claim the same job;
- active lease uniqueness is enforced by SQLite partial unique index and explicit writer-transaction check;
- heartbeat renews only the active matching lease;
- complete requires running + active matching lease;
- fail moves to retry-wait while attempts remain;
- fail moves to failed when retry max is exhausted;
- retry moves failed / eligible retry-wait back to queued, rejects `retry-wait` before `retry_after_ms`, and rejects over-limit retry;
- cancel works from queued/running/paused/retry-wait and rejects completed/failed/cancelled;
- cancel running marks the active lease `cancelled`; old lease heartbeat/complete/fail are rejected and do not change terminal `cancelled`;
- lease-timeout helper marks lease expired and moves running job to retry-wait or failed;
- list is snapshot read and does not mutate timestamps.
- disabled `list` does not open, write, or migrate an existing damaged `runtime.db` sentinel.

Commands:

- `cargo test runtime_db --manifest-path src-tauri/Cargo.toml`
- broader Rust test command if command registration or shared runtime helpers change;
- `cargo build --release --manifest-path src-tauri/Cargo.toml`
- `pnpm lint`
- `git diff --check`
- `npx gitnexus detect-changes --repo llm_wiki --scope staged`

## Gate Plan

- Architect: Claude Code / ACP first; fallback ZCode; fallback internal Architect.
- Tester: Kimi static packet first; fallback internal Tester.
- Reviewer: ZCode read-only plus internal Reviewer; if either external/internal transport fails, use Kimi reviewer fallback and Commander manual review.
- External wait window: 10 minutes by default. Timeout or incomplete output is not PASS.
- Merge standard: no unresolved P0/P1/P2.

## Expected PR Metadata

- PR title: `feat: add SPEC-2 job runtime ledger`
- Commit message: `feat: add SPEC-2 job runtime ledger`
- PR body must include:
  - scope / non-goals;
  - GitNexus impact and detect summaries;
  - local Rust test results;
  - release build / lint / diff check results;
  - Architect / Tester / Reviewer gate outcomes.
