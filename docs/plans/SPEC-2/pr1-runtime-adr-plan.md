# SPEC-2 PR1 Plan: Runtime ADR + Schema / State-Machine Hard Gate

> Type: PR execution plan | Status: in progress | Owner: Commander | Issue: #184 | Run: `a5d238a7-2880-4c66-9640-496d94912e5f`

## Branch

- `codex/spec-2-pr1-runtime-adr`

## Scope

PR1 creates the SPEC-2 hard gate for the local Work Runtime before any SQLite implementation lands.

Deliverables:

- Add a runtime ADR under `docs/plans/SPEC-2/` that defines:
  - project-scoped `runtime.db` ownership and location rules;
  - first-version kill switch / feature flag behavior;
  - portable SQLite schema families for jobs, leases, events, profile usage, derived stale markers, resource budgets, staging artifacts, and migrations;
  - job state machine and allowed transitions;
  - operation names for create / claim / heartbeat / complete / fail / retry / cancel / pause / resume / list;
  - single-writer runtime DB actor contract;
  - SPEC-3 / SPEC-4 gate conditions.
- Upgrade the inert `job-runtime` contract from generic placeholder naming to SPEC-2 operation/event inventory without binding it to SQLite code.
- Add focused tests that keep the ADR, frozen SPEC-1 family, and inert contract aligned.
- Update `docs/plans/README.md` only if needed to expose this PR plan / ADR in the plan index.

## Non-Goals

- No SQLite crate.
- No `runtime.db` creation.
- No migrations table implementation.
- No job ledger persistence.
- No ingest queue or file-sync queue migration.
- No production command wiring.
- No UI.
- The ADR may define portable schema/state-machine rules, but it must not lock in
  Rust crate APIs, TS runtime APIs, migration function signatures, or DB module
  implementation details. Those belong to PR2+.

## ADR Acceptance Criteria

The ADR must satisfy these checklist items before implementation continues.

### Runtime DB Location / Ownership

- `runtime.db` is project-scoped and tied to the SPEC-1 project identity boundary.
- The ADR names the project-local directory relationship between `runtime.db`,
  staging artifacts, vector/search indexes, and derived caches.
- `runtime.db` is runtime metadata only: not Markdown truth, not plugin-store
  truth, not Zustand truth, and not committed wiki content.
- Project delete / move / reopen semantics are stated at the ADR level, even if
  actual migration behavior is deferred.

### Kill Switch / Feature Flag

- The ADR states the first-version default and read timing.
- When the flag is disabled, the app keeps current JSON/store + Markdown paths.
- When the flag is disabled, an existing `runtime.db` is not read, written, or
  migrated by the runtime.
- A project that previously had `runtime.db` must still open with the flag off.
- The flag must not depend on React render, Zustand, or Tauri webview lifecycle.

### Portable Schema Families

- Schema families must include jobs, leases, events/progress, profile usage,
  derived stale markers, resource budgets, staging artifacts, and migrations.
- The ADR must use a portable SQLite subset: standard SQLite storage classes,
  portable constraints, and no dependency on Postgres/DuckDB types, JSON
  operators/functions, platform collation, or UDF semantics.
- The ADR must define schema family ownership and direction, not implementation
  modules or crate-level APIs.

### Job State Machine

- The state machine must use a closed-world state set and transition table.
- Required states: queued, running, paused, completed, failed, cancelled, and
  retry-wait.
- Required transitions:
  - create: none -> queued
  - claim: queued -> running
  - heartbeat: running -> running, idempotent lease renewal
  - complete: running -> completed
  - fail: running -> failed or retry-wait
  - retry: failed/retry-wait -> queued, bounded by retry max
  - cancel: queued/running/paused/retry-wait -> cancelled; failed may only leave through retry
  - pause: running/queued -> paused
  - resume: paused -> queued
  - lease timeout: running -> retry-wait or failed
- Any transition not explicitly listed must be rejected by the runtime contract.

### Single-Writer Actor

- Writes for claim, heartbeat, complete, fail, retry, cancel, pause, resume,
  lease renewal, event append, progress append, resource budget claim/release,
  artifact status update, and migration bookkeeping must go through one
  runtime DB writer actor.
- Worker code must not directly compete for SQLite write handles.
- Snapshot reads may use short read transactions.
- Heartbeat/progress min interval and actor backpressure/drop behavior must be
  named in the ADR.
- Writer actor queue size default must be named in the ADR; PR1 default is
  1000 entries.

### SPEC-3 / SPEC-4 Gate Conditions

- SPEC-3 may write derived stale markers and consume commit-path budget only
  through SPEC-2-owned schema families and operations.
- SPEC-3 must not own runtime state or create an alternate commit queue.
- SPEC-4 may record profile usage and capability status only through
  SPEC-2-owned profile usage / status schema families and operations.
- SPEC-3 / SPEC-4 code PRs that touch runtime schema names, persisted runtime
  state, or runtime write operations must wait for the corresponding SPEC-2
  implementation PR, not only PR1.

## Key Files / Symbols

- `docs/plans/SPEC-2/pr1-runtime-adr-plan.md`
- `docs/plans/SPEC-2/adr-work-runtime.md`
- `docs/plans/README.md`
- `src/core-runtime/contract/index.ts`
- `src/core-runtime/contract/headless-contract.test.ts`
- `src/core-runtime/contract/adapter-contract.test.ts`

## GitNexus Impact Summary

- `RuntimeContractMessage`: LOW risk; 3 direct importers in contract tests / adapter contract, 0 affected flows.
- `createMockCoreRuntimeContract`: LOW risk; 2 direct test callers, 0 affected flows.
- `RuntimeContractFamily`: target not indexed by GitNexus; guarded through focused contract tests.
- `StoreBoundaryEntry`: target not indexed by GitNexus; not expected to be edited in PR1.
- Implementation step 4 is expected to expand `src/core-runtime/contract/index.ts`
  and synchronize `headless-contract.test.ts` / `adapter-contract.test.ts`
  assertions. These are expected contract/test diffs.

No HIGH or CRITICAL impact found.

## Implementation Order

1. Write this PR plan.
2. Run Architect gate on the plan and scope.
3. Add `docs/plans/SPEC-2/adr-work-runtime.md`.
4. Update inert core contract metadata for `job-runtime` operations/events only.
5. Add or update tests that assert:
   - SPEC-1 family name stays `job-runtime`;
   - SPEC-2 operation/event names match the ADR;
   - SPEC-2 schema family names match the ADR;
   - SPEC-2 state machine states and required transitions match the ADR;
   - SPEC-2 single-writer operation set matches the ADR;
   - the ADR contains the portable SQLite subset guard;
   - payload details remain ADR/contract metadata, not DB implementation;
   - contract modules still import no React, Zustand, Tauri, plugin-store, or runtime persistence implementation.
6. Update `docs/plans/README.md` if the new ADR/plan needs index visibility.
7. Run verification and reviewer gates.

## Test Plan

- Focused:
  - `pnpm vitest run src/core-runtime/contract/headless-contract.test.ts src/core-runtime/contract/adapter-contract.test.ts src/core-runtime/contract/boundary-check.test.ts`
- Required:
  - `pnpm lint`
  - `git diff --check`
  - `npx gitnexus detect-changes --repo llm_wiki`
- Full `pnpm test` is not required for this ADR/contract-only PR unless gate feedback finds broader runtime risk.

## Gate Plan

- Architect: Claude Code / ACP first; fallback ZCode; fallback internal Architect.
- Tester: Kimi ACP first; fallback internal Tester.
- Reviewer: ZCode read-only plus internal Reviewer.
- External wait window: 10 minutes by default. Timeout or incomplete output is not PASS.
- Merge standard: no unresolved P0/P1/P2.

## Expected PR Metadata

- PR title: `docs: define SPEC-2 runtime hard gate`
- Commit message: `docs: define SPEC-2 runtime hard gate`
- PR body must include:
  - run id;
  - scope / non-goals;
  - GitNexus impact summary;
  - test results;
  - Architect / Tester / Reviewer gate outcomes;
  - final GitNexus detect summary.
