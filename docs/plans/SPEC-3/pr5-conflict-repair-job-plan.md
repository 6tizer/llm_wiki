# SPEC-3 PR5 Plan: Conflict Review / Repair Job Entry

> Branch: `codex/spec-3-pr5-conflict-repair-job`  
> Base: `508ff48 feat: record markdown commit events and stale markers`  
> Scope: SPEC-3 PR5 / #188, with #187 remaining for PR6 wording/template closeout

## Goal

Route Markdown commit conflicts into visible runtime repair work instead of silently overwriting or losing staging evidence.

PR5 completes the first repair/review job entry point:

- base hash / current hash mismatch returns `conflicted` and does not write final Markdown.
- a `markdown-conflict-repair` runtime job is created for each routed conflict.
- the conflicted staging artifact is advanced to `failed` with bounded `lastError=commit-conflict...`, reusing SPEC-2 staging TTL/GC.
- the commit audit event records the queued `repairJobId`.
- no new conflict SQLite table or fragile staging status migration is added.

## Non-goals

- No advanced semantic merge.
- No repair worker implementation.
- No new SQLite schema family.
- No change to SPEC-2 job retry state machine.
- No normal ingest shell migration to the commit layer.
- No production shell/runtime adapter wiring beyond the exported helper. PR5 adds the commit-operation adapter slot and shell helper; a later integration PR must bind `routeMarkdownConflictRepair`, event append, marker writes, and file IO into a production `MarkdownCommitAdapters` assembly.
- No PR6 template / OKF validator wording changes.

## Current Facts

- SPEC-3 PR3 already returns `conflicted` for safe base-hash failures and avoids cleanup.
- SPEC-3 PR4 already appends commit audit events for `conflicted`, with `repairJobId: null`.
- Rust runtime DB already exposes:
  - `runtime_job_create`
  - `runtime_staging_artifact_record`
  - `runtime_event_append`
- `src/commands/runtime-db.ts` exposes event/marker/budget/cleanup wrappers, but not job-create or staging-record wrappers yet.
- `runtime_staging_artifact_record` permits updating a pending artifact to `failed` and sets `expiresAtMs` through existing failed-artifact TTL logic.
- `runtime_job_create` already has `maxAttempts`, `priority`, `payload`, and queued state.

## GitNexus Impact

Current branch was re-indexed before planning:

- `npx gitnexus analyze`: success, 8,363 nodes / 21,042 edges / 300 flows.
- `commitMarkdownArtifact`: LOW, 0 direct upstream impacts.
- `buildAuditPayload`: LOW, 1 direct upstream caller, Markdown-commit module only.
- `MARKDOWN_COMMIT_AUDIT_FIELDS`: LOW, 0 upstream impacts.
- `runtimeJobList`: LOW, 0 upstream impacts. Used as a proxy for the TS runtime-db wrapper module; new wrappers are additive.

No HIGH/CRITICAL impact was found for the planned edits.

## Planned Design

### Commit Operation

Add one optional adapter to `MarkdownCommitAdapters`:

```ts
routeConflictRepair?: (
  context: MarkdownCommitConflictRepairContext,
) => Promise<MarkdownCommitConflictRepairReceipt>
```

The adapter is shell/runtime-owned. Core Runtime stays shell-neutral and does not import Tauri commands.

The context should include only bounded metadata:

```ts
interface MarkdownCommitConflictRepairContext {
  readonly artifactId: string
  readonly jobId: string
  readonly artifactPath: string
  readonly artifactHash: string
  readonly targetPath: string
  readonly operationIntent: MarkdownCommitOperationIntent
  readonly result: "conflicted"
  readonly baseHash: string | null
  readonly currentHash: string | null
  readonly affectedPaths: readonly string[]
  readonly sourceKind: string
  readonly conflictReason: string
}

interface MarkdownCommitConflictRepairReceipt {
  readonly repairJobId: string
}
```

It must not include Markdown body content.

On `conflicted` after successful budget release:

1. call `routeConflictRepair` if provided;
2. update operation result with `repairJobId`;
3. append the commit audit event with that same `repairJobId`;
4. do not record derived markers;
5. do not cleanup the staging artifact.

If no adapter is provided, preserve current PR4 behavior: `conflicted` + audit event with `repairJobId: null`.

If `routeConflictRepair` fails, keep the `conflicted` result, add bounded `repairError`, and still append the commit audit event with `repairJobId: null`. A conflict decision is a durable audit fact even when repair routing fails. The audit payload must not claim a repair job was queued unless the adapter returns a durable repair job id.

`repairError?: string` is a distinct result field. Do not overload the existing generic `error` field, because the commit decision can be valid `conflicted` while repair routing failed after the decision.

### Runtime DB Wrappers

Add additive wrappers in `src/commands/runtime-db.ts`:

- `runtimeJobCreate(request)`
- `runtimeStagingArtifactRecord(request)`

These call existing Tauri commands and preserve camelCase request casing.

### Conflict Repair Adapter Shape

PR5 will provide a small exported shell adapter helper that composes the wrappers into the new commit adapter. The helper must live outside `src/core-runtime/**` so Core Runtime stays shell-neutral. Proposed file:

- `src/commands/markdown-commit-repair.ts`

Proposed helper responsibility:

1. update the same staging artifact to `failed` with `lastError` starting with `commit-conflict:`;
2. create queued `markdown-conflict-repair` job with `maxAttempts` set on the runtime job row;
3. return `{ repairJobId }`.

This order avoids creating an orphan queued repair job that points at a still-pending artifact. If the artifact-failed update fails, do not create a repair job. If job creation fails after the artifact-failed update, surface `repairError`, append the conflict audit event with `repairJobId: null`, and leave the failed artifact for SPEC-2 TTL/GC and diagnosis.

Payload should be JSON, bounded, and body-free:

```json
{
  "kind": "markdown-conflict-repair",
  "artifactId": "...",
  "artifactHash": "...",
  "targetPath": "wiki/Page.md",
  "operationIntent": "update",
  "baseHash": "...",
  "currentHash": "...",
  "affectedPaths": ["wiki/Page.md"],
  "sourceKind": "ingest",
  "owner": "markdown-commit",
  "strategy": "manual-review-first"
}
```

Use existing job-row `maxAttempts` as the single source of truth for attempt limit. Do not duplicate the same value as `attemptLimit` in the free-form payload. Actual retry exhaustion to manual review remains a repair-worker concern; PR5 does not implement a failed-to-manual-review terminal event or UI.

### Staging Artifact Failure

Use existing `runtime_staging_artifact_record` rather than adding a new command.

Required payload:

- same `artifactId`
- same `jobId`
- same `artifactPath`
- same `artifactHash`
- `status: "failed"`
- `lastError: "commit-conflict: ..."`

This intentionally reuses SPEC-2 failed/cancelled TTL GC.

Before implementing the wrapper composition, verify the existing Rust command behavior and cite it in the PR:

- `runtime_staging_artifact_record_for_project` allows updating an existing `pending` artifact to `failed`.
- failed/cancelled status recomputes `expires_at_ms` from `ttlMs` or the default failed-artifact TTL.
- `lastError` is bounded by the existing staging artifact error byte limit.

If any of those checks are false, stop and update the plan before coding because PR5 would need a Rust-side adjustment.

Current source check before implementation found the expected behavior:

- existing rows must be `pending` before `runtime_staging_artifact_record_for_project` updates them.
- failed/cancelled record requests compute `expires_at_ms` from `ttlMs` or `DEFAULT_FAILED_ARTIFACT_TTL_MS`.
- `DEFAULT_FAILED_ARTIFACT_TTL_MS = 604_800_000` ms, i.e. 7 days.
- `lastError` is bounded by `MAX_STAGING_ARTIFACT_ERROR_BYTES`.

The helper must keep `repairError` short enough for the full event payload budget. Use a small local bound, for example 1024 characters, before including it in the operation result and audit payload. Do not assume the Rust `lastError` 4096-byte limit applies to the TS audit/result field.

## Files

Expected edits:

- `src/core-runtime/markdown-commit/index.ts`
- `src/core-runtime/markdown-commit/commit-operation.test.ts`
- `src/commands/markdown-commit-repair.ts`
- `src/commands/markdown-commit-repair.test.ts`
- `src/commands/runtime-db.ts`
- `src/commands/runtime-db.test.ts`
- `docs/plans/SPEC-3/adr-markdown-commit-layer.md`
- `src/core-runtime/contract/index.ts` only if payload field metadata needs an additive PR5 amendment
- `docs/plans/README.md`

Avoid Rust edits unless Architect requires additional validation. Existing Rust commands already support PR5.

## Implementation Order

1. Run Architect Gate on this plan.
2. Add TS wrappers and wrapper tests for `runtime_job_create` and `runtime_staging_artifact_record`.
3. Verify and cite SPEC-2 staging pending-to-failed TTL behavior in Rust.
4. Add conflict repair context/receipt/result fields in commit operation, including `repairError?: string`.
5. Add conflict routing order in `commitMarkdownArtifact`.
6. Add the minimal shell adapter helper in `src/commands/markdown-commit-repair.ts`.
7. Update ADR with PR5 repair job semantics and failure ordering.
8. Run focused tests.
9. Run Simplicity Gate, Tester Gate, Reviewer Gate.

## Test Plan

Focused tests:

- `pnpm exec vitest run src/core-runtime/markdown-commit/commit-operation.test.ts src/commands/runtime-db.test.ts src/core-runtime/contract/headless-contract.test.ts`
- `pnpm lint`
- `git diff --check`
- `npx gitnexus detect-changes --repo llm_wiki --scope staged` before commit.

Commit operation coverage:

- conflict creates repair routing before audit event.
- audit payload contains the returned `repairJobId`.
- conflict repair routing does not write Markdown, record markers, or cleanup staging artifact.
- `recordDerivedStaleMarkers` is not called on conflicted results, even when marker operations are present.
- no Markdown body appears in repair payload or audit payload.
- missing `routeConflictRepair` preserves PR4 behavior.
- repair-routing failure surfaces `repairError`, still appends an audit event with `repairJobId: null`, and does not cleanup.
- artifact-failed update failure prevents job creation.
- job creation failure after artifact-failed update leaves a failed artifact, returns `repairError`, and audits the conflict with `repairJobId: null`.
- committed / merged / rejected / skipped do not create repair jobs.

Wrapper coverage:

- `runtimeJobCreate` sends `runtime_job_create` with camelCase request.
- `runtimeStagingArtifactRecord` sends `runtime_staging_artifact_record` with failed conflict payload.

Shell adapter helper coverage:

- failed staging artifact record happens before runtime job creation.
- artifact-failed update failure prevents job creation.
- job create request uses `kind: "markdown-conflict-repair"` and job-row `maxAttempts`.
- repair job payload excludes Markdown body and does not include duplicate `attemptLimit`.
- job creation failure returns bounded `repairError` to the commit operation path.

## Gates

- Architect: Claude ACP first with confirmed provider/model; fallback to ZCode/Kimi/internal if unavailable.
- Simplicity: required. Use ZCode read-only simplicity reviewer because PR5 touches shared commit runtime flow and job/staging side effects.
- Tester: Kimi static packet; fallback ZCode/internal.
- Reviewer: ZCode external reviewer plus internal review.

All P0/P1/P2 must be fixed in PR5 before PR creation or explicitly routed only if Architect classifies them out of PR5 scope.

## Agent-loop Status

`pnpm agent-loop delivery bind --issue 188 ...` failed because another active run is already bound:

- existing run: `a8d8c88e-5393-432a-bb86-bb4e42cb2ac3`
- existing issue: `184`
- requested issue: `188`

Commander fallback: record gate/test/PR evidence in plan docs and PR body/comments until the stale active run is cleared.

## Risks

- Audit could claim repair was queued before job creation is durable. Mitigation: route repair before appending audit payload with `repairJobId`; routing failure still produces a conflict audit event with `repairJobId: null` and bounded `repairError`.
- Marking the artifact failed could remove evidence too early if TTL is too short. Mitigation: reuse SPEC-2 failed TTL and preserve body-free metadata in job payload.
- One adapter could become a future scheduler abstraction. Mitigation: keep the adapter specific to conflict repair routing and do not add generic hook chains.
- Job/artifact routing has partial failure risk. Mitigation: update artifact to `failed` before creating the repair job, never create a job after artifact-failed update fails, and audit job-creation failure with `repairJobId: null`.

## Follow-up

- PR6 updates project templates, OKF validator wording, and user-facing text for optional `index.md` / `overview.md`.
- A later repair-worker PR owns actual manual review UI / retry exhaustion behavior.
- A later shell/runtime integration PR wires `routeMarkdownConflictRepair` into the production Markdown commit adapter assembly. Until that wiring exists, PR5's repair routing is available to callers that pass the adapter explicitly, but normal production flows are not silently migrated.
