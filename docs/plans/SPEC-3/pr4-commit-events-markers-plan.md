# SPEC-3 PR4 Plan: Commit Events + Derived Stale Markers

> Type: PR execution plan | Status: reviewed / ready for implementation | Owner: Commander | Branch: `codex/spec-3-pr4-commit-events-markers` | Issues: #187, #188

## Goal

Persist bounded commit audit facts and derived stale markers after SPEC-3 PR3's shell-neutral commit operation.

PR4 turns PR3's `eventId: null` placeholder into a runtime event id and adds the SPEC-2-owned `derived-stale-markers` runtime schema/API needed by SPEC-6 rebuild scheduling.

## Scope

- Add Rust runtime DB support for the `derived-stale-markers` schema family.
- Add shell-neutral Tauri commands for:
  - recording derived stale markers;
  - listing marker snapshots for tests/diagnostics.
- Add TypeScript command wrappers for:
  - `runtime_event_append`;
  - derived marker record/list commands added in PR4.
- Extend the core markdown commit operation with injected side-effect adapters:
  - append bounded commit audit event through `events-progress`;
  - record derived stale markers after successful `committed` / `merged` Markdown mutation.
- Preserve PR3 fallback behavior when side-effect adapters are omitted, so existing tests remain narrow and integration stays opt-in.
- Update tests for event payload shape, marker writes, cleanup ordering, and runtime DB migration/list behavior.
- Update `docs/plans/README.md` to mark PR3 merged and PR4 in progress.

Ownership clarification:

- `derived-stale-markers` remains a SPEC-2-owned runtime schema/API family.
- PR4 may implement the missing SPEC-2-owned runtime support because SPEC-3 is the first consumer that can prove the required commit-event/marker contract.
- PR4 must update the SPEC-2 and SPEC-3 ADR wording so this cross-SPEC implementation does not become SPEC-3 ownership or a competing runtime write path.

## Non-Goals

- No conflict repair job creation; PR5 owns repair/review jobs.
- No normal ingest wiring or worker-pool integration.
- No UI timeline/marker UI.
- No semantic merge changes.
- No new SPEC-3 commit-events table; commit audit facts use SPEC-2 `events-progress`.
- No change to existing timeline/progress list semantics unless Architect requires it.
- No marker scheduler/claimer; SPEC-6 owns rebuild scheduling and terminal marker consumption.

## Key Files

- `docs/plans/SPEC-3/pr4-commit-events-markers-plan.md`
- `docs/plans/README.md`
- `src-tauri/src/commands/runtime_db.rs`
- `src-tauri/src/lib.rs`
- `src/commands/runtime-db.ts`
- `src/commands/runtime-db.test.ts`
- `src/core-runtime/markdown-commit/index.ts`
- `src/core-runtime/markdown-commit/commit-operation.test.ts`
- `src/core-runtime/contract/index.ts`
- `src/core-runtime/contract/headless-contract.test.ts`

## Current Facts

- PR1 froze durable audit fields and logical derived marker fields.
- PR2 removed root index/overview from normal ingest.
- PR3 added shell-neutral commit operation and intentionally left event id absent/null.
- Existing Rust runtime DB already has `events-progress` tables and `runtime_event_append`.
- Existing Rust runtime DB does not yet implement physical `derived-stale-markers` tables or commands.
- Existing `runtime_event_append` is job-scoped and requires an existing `jobId`.
- Existing `runtime_event_append` writes a generic `job-runtime:event-appended` event name; SPEC-3 commit event semantics must therefore live inside bounded JSON payload unless Architect requires a new event-name operation.
- `runtime_event_append` returns a `RuntimeEventRecord` with `eventId` and `createdAtMs`; PR4 uses that returned event record as the audit anchor for marker writes.

## GitNexus Impact Summary

- `runtime_event_append_for_project`: MEDIUM risk, 7 direct impacts, 2 affected processes. PR4 may use it through TS wrapper; avoid editing unless necessary.
- `initialize_events_progress_schema`: LOW risk, 13 impacted. PR4 should not modify events/progress schema.
- `runtime_timeline_list_for_project`: HIGH risk, 7 direct impacts and 4 processes. PR4 should not modify it.
- `commitMarkdownArtifact`: LOW risk, no current upstream callers. PR4 may extend it with optional adapters and focused tests.

Before implementation, rerun impact for every existing Rust/TS symbol actually edited.

## Proposed Derived Marker Schema

Physical table: `runtime_derived_stale_markers`

Portable columns:

- `marker_id TEXT PRIMARY KEY CHECK(length(marker_id) > 0)`
- `layer TEXT NOT NULL`
- `affected_path TEXT NOT NULL`
- `input_hash TEXT`
- `base_version TEXT NOT NULL`
- `marked_at_ms INTEGER NOT NULL CHECK(marked_at_ms >= 0)`
- `reason TEXT NOT NULL CHECK(reason IN ('commit', 'delete', 'schema_change', 'manual_rebuild'))`
- `source_event_id TEXT NOT NULL`
- `status TEXT NOT NULL CHECK(status IN ('pending', 'claimed', 'done', 'failed', 'cancelled'))`
- `updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= 0)`
- `last_error TEXT`
- `FOREIGN KEY(source_event_id) REFERENCES runtime_events(event_id)`

Indexes:

- `(status, layer, marked_at_ms, marker_id)`
- `(affected_path, layer, status)`
- `(source_event_id)`

Migration family:

- `derived-stale-markers` version `1`.
- Write paths initialize base runtime DB, jobs/leases, events-progress, then marker schema so `source_event_id` FK is valid.
- Higher existing marker family versions are preserved.
- Snapshot list returns empty on old DBs without migration.

Schema decisions:

- `input_hash` is nullable only for committed delete markers. Commit/merge markers require the final content hash.
- `base_version` must not be a duplicate of `source_event_id`.
- PR4 encodes `base_version` as `event:<createdAtMs>:<eventId>` from the returned `runtime_event_append` record. `source_event_id` remains the FK/trace pointer; `base_version` remains the opaque version token SPEC-6 can later replace with a real commit sequence through a forward migration if needed.
- `last_error` and non-`pending` statuses are reserved for SPEC-6. PR4 record commands write `status = pending` and `last_error = NULL`.
- PR4 marker record is insert-only. Duplicate `marker_id` fails visibly; PR4 does not update or advance existing marker rows.

## Marker Write Semantics

PR4 records markers only after a durable commit audit event exists.

PR4 does not hard-code global default marker layers inside `commitMarkdownArtifact`.

Callers pass explicit marker operations through the injected side-effect adapter. Tests may use a helper that expands normal content-page mutations to `embedding`, `graph`, `taxonomy`, `search`, and `synthesis`, but that helper is test/local integration support rather than a hidden commit-layer rule.

For marker operations supplied by the caller:

- `committed` create/update/append: record supplied layers with `reason = commit` and the final content hash.
- `merged`: record supplied layers with `reason = commit` and the final merged hash.
- `committed` delete: record supplied layers with `reason = delete` and `input_hash = null`.
- `skipped`, `conflicted`, `rejected`: no derived stale marker.

Audit events are not 1:1 with markers. `skipped`, `conflicted`, and `rejected` commit audit events have no marker rows. SPEC-6 must consume the marker table as the source of rebuild work, not infer required markers by reverse-scanning every commit audit event.

## Commit Audit Event Payload

Append through `runtime_event_append` with existing job id.

Payload JSON fields:

- `kind: "markdown-commit"`
- `artifactId`
- `artifactHash`
- `targetPath`
- `operationIntent`
- `result`
- `baseHash`
- `currentHash`
- `finalHash`
- `affectedPaths`
- `repairJobId: null`
- `sourceKind`

Payload must stay bounded and must not include Markdown body content.

PR4 updates the SPEC-3 ADR audit field table to explicitly bless `kind` and `source_kind` as additive bounded payload fields. `kind` is needed because the SPEC-2 event name remains generic; `source_kind` mirrors the staged artifact source metadata.

PR4 should record audit events for:

- `committed`
- `merged`
- `conflicted`
- `rejected`
- `skipped`

Rationale: ADR requires skipped delete-with-base-present to have audit visibility even when no final Markdown mutation occurs.

`rejected`, `conflicted`, and `skipped` audit events record an attempted commit decision and diagnostics. They do not imply Markdown content changed and do not imply marker rows exist.

## Cleanup Ordering

PR3 cleanup currently runs after release and only for `committed` / `merged`.

PR4 target order:

1. Claim budget.
2. Apply PR3 commit decision/write.
3. Release budget in `finally`.
4. Append commit audit event.
5. Record derived stale markers for committed/merged/delete mutations only.
6. Cleanup committed artifact only after event append and marker write succeed.

If release fails:

- Keep the commit result and surface `releaseError`.
- Do not append the commit audit event.
- Do not record derived stale markers.
- Do not call committed artifact cleanup.

Rationale: a failed release means the commit-path budget may still be active. PR4 should preserve evidence and avoid scheduling derived rebuild work until the runtime budget state is healthy.

If audit event append fails after a successful Markdown write:

- Keep the commit result as `committed` / `merged`.
- Do not cleanup the staged artifact, so debug/retry evidence remains.
- Surface `eventError`.

If marker write fails after event append:

- Keep the commit result.
- Do not cleanup the staged artifact.
- Surface `markerError`.

Side-effect failures after a final Markdown write do not rewrite the result to `rejected`; Markdown truth already changed. They surface as `releaseError`, `eventError`, or `markerError` fields on the committed/merged result.

`cleanupCommittedArtifact` is a SPEC-2 `staging-artifacts` status/cleanup adapter. PR4 only decides whether to call that adapter; artifact physical TTL/GC policy remains SPEC-2-owned.

## Architect Gate Notes

Claude ACP Architect gate failed before report with provider 402 credits; no PASS recorded.

Kimi Architect fallback was invalid because the packet contained literal shell substitutions instead of the file text; no PASS recorded.

ZCode Architect fallback completed with `WARN`. Accepted plan changes:

- Clarify that PR4 implements missing `derived-stale-markers` runtime support as SPEC-2-owned schema/API, and update both ADRs.
- Make `base_version` independent from `source_event_id`.
- Add `kind` and `source_kind` to the ADR audit payload table.
- Define release-failure behavior before event/marker side effects.
- State that audit events are not 1:1 with marker rows.
- Use caller-supplied marker operations instead of hard-coded default layer fanout inside the commit operation.
- Document that `last_error` and non-`pending` marker statuses are SPEC-6-reserved.

## Implementation Order

1. Add PR4 plan and README status update.
2. Run Architect gate before code.
3. Update SPEC-2/SPEC-3 ADRs for marker ownership clarification and audit payload fields.
4. Add marker Rust structs, schema, migration, record/list commands, registration, and focused Rust tests.
5. Add TS wrappers and invoke payload tests for event append and marker commands.
6. Extend core commit result with `eventId: string | null`, `releaseError`, `eventError`, and `markerError`.
7. Extend commit operation adapters with optional side effects:
   - `appendCommitEvent(result): Promise<{ eventId: string }>`;
   - `recordDerivedStaleMarkers(event, result, markerOperations): Promise<void>`.
8. Update cleanup ordering tests:
   - event append before cleanup;
   - marker write before cleanup;
   - release failure prevents event append, marker write, and cleanup but preserves commit result;
   - event failure prevents cleanup but preserves commit result;
   - marker failure prevents cleanup but preserves commit result;
   - conflict/rejected/skipped append event but do not marker or cleanup.
9. Run focused Rust/TS tests, Simplicity Gate, Tester Gate, Reviewer Gate.
10. Stage intentionally, run staged GitNexus detect, commit, push, PR, CI/review loop, merge, cleanup.

## Test Plan

Rust focused:

- `cargo test runtime_db --manifest-path src-tauri/Cargo.toml derived_stale`
- `cargo test runtime_db --manifest-path src-tauri/Cargo.toml event_progress`

TypeScript focused:

- `pnpm exec vitest run src/core-runtime/markdown-commit/commit-operation.test.ts src/commands/runtime-db.test.ts src/core-runtime/contract/headless-contract.test.ts`

General:

- `pnpm lint`
- `git diff --check`
- `npx gitnexus detect-changes --repo llm_wiki --scope staged`

If Rust schema changes are broad:

- `cargo test runtime_db --manifest-path src-tauri/Cargo.toml`

## Gate Plan

- Architect: Claude ACP first, timeout `600000`; fallback ZCode/Kimi/internal Architect.
- Simplicity: required. Use ZCode read-only simplicity reviewer because PR4 touches Rust DB/state-machine-adjacent runtime code.
- Tester: Kimi first; fallback Claude/ZCode/internal Tester.
- Reviewer: ZCode first; fallback Claude/internal Reviewer.
- P0/P1/P2 must be fixed before PR creation or explicitly routed only if Architect classifies it out of PR4 scope.

## Risks

- Event/marker side effects after final Markdown write can fail. PR4 must not pretend Markdown did not change; it should preserve committed result and keep artifact evidence when side effects fail.
- Marker layer defaults may over-invalidate. PR4 resolves this by requiring caller-supplied marker operations; no hidden commit-layer default fanout.
- `runtime_timeline_list_for_project` is HIGH impact; avoid touching it.
- Marker schema can become a scheduler prematurely. PR4 only records/list markers; SPEC-6 consumes/claims them later.
- Large payloads must not store Markdown body content in SQLite.

## Follow-up

- PR5 uses conflict audit events to enqueue repair jobs.
- SPEC-6 consumes `derived-stale-markers` for rebuild scheduling and terminal status transitions.
- Shell adapter integration should map PR3 commit results to PR4 side-effect adapters explicitly.

## PR Metadata

- PR title: `feat: record markdown commit events and stale markers`
- Commit message: `feat: record markdown commit events and stale markers`
