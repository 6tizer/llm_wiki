# SPEC-3 PR3 Plan: Markdown Commit Operation

> Type: PR execution plan | Status: reviewed / ready for implementation | Owner: Commander | Branch: `codex/spec-3-pr3-commit-operation` | Issues: #187, #188

## Goal

Add the first shell-neutral Markdown commit operation: read current committed Markdown, compare the artifact base hash, apply create/update/append/delete when safe, and return a visible conflict/rejection result when unsafe.

PR3 moves commit decision logic behind a Core Runtime module, but it does not wire normal ingest to the new path yet.

## Scope

- Add a shell-neutral commit module under `src/core-runtime/markdown-commit/`.
- Define typed request/result shapes for:
  - staged artifact metadata;
  - operation intent: `create`, `update`, `append`, `delete`;
  - commit result: `committed`, `merged`, `conflicted`, `rejected`, `skipped`.
- Inject adapters for:
  - committed Markdown read/write/delete;
  - staged artifact body read;
  - content hash;
  - commit-path budget claim/release;
  - staging artifact commit-success cleanup.
- Add TypeScript command wrappers in `src/commands/runtime-db.ts` only for existing SPEC-2 commands PR3 needs.
- Ensure same-path serialization by claiming SPEC-2 commit-path budget before final Markdown mutation and releasing it in success, conflict, rejection, skip, and error paths.
- Use atomic final writes through the injected file adapter.
- Freeze one reusable content hash helper and require future prepare code to reuse the same algorithm and canonicalization.
- Keep all production behavior opt-in: no normal ingest path migration in PR3.
- Add focused unit tests for the commit operation and command wrapper payload shapes.
- Update `docs/plans/README.md` to mark PR2 merged and PR3 in progress.

## Non-Goals

- No durable commit event append; PR4 owns event records.
- No derived stale marker write; PR4 owns marker operations/schema.
- No conflict repair job creation; PR5 owns repair/review jobs.
- No normal ingest integration; later PR wires staging prepare -> commit.
- No advanced semantic merge or LLM merge.
- No new Rust DB schema or new SQLite table.
- No changes to `runtime_db.rs` budget/staging internals unless Architect explicitly blocks the TS-only plan.
- No changes to `writeFileAtomic`; it is a CRITICAL shared write helper and must stay behind an adapter.
- No production shell adapter that composes runtime wrappers + fs commands + the core operation; PR3 defines the core operation and narrow wrappers only.

## Key Files

- `docs/plans/SPEC-3/pr3-commit-operation-plan.md`
- `docs/plans/README.md`
- `src/core-runtime/markdown-commit/index.ts` (new)
- `src/core-runtime/markdown-commit/commit-operation.test.ts` (new)
- `src/commands/runtime-db.ts`
- `src/commands/runtime-db.test.ts`
- Existing contract metadata in `src/core-runtime/contract/index.ts` should be reused, not duplicated.

## Current Facts

- PR1 froze the ADR, command/event names, artifact fields, result enum, and base-hash matrix.
- PR2 removed root `wiki/index.md` / `wiki/overview.md` from normal ingest only.
- SPEC-2 already exposes Rust commands for:
  - `runtime_commit_budget_claim`;
  - `runtime_commit_budget_release`;
  - `runtime_staging_artifact_commit_success`;
  - `runtime_staging_artifact_record/list/gc`;
  - `runtime_event_append` for PR4.
- `src/commands/runtime-db.ts` currently wraps only job list/cancel/pause/resume, so PR3 needs narrow wrappers before a shell adapter can call existing SPEC-2 commands.
- `writeFileAtomic` exists in `src/commands/fs.ts`, but PR3 must not import it from core runtime; the shell adapter may pass it in.
- Existing Rust `delete_file` is sandboxed, but missing files currently surface as an error from `remove_file`; future shell adapter must catch NotFound and converge allowed deletes to success.

## GitNexus Impact Summary

- `runtime_commit_budget_claim_for_project`: HIGH risk, 16 direct impacts in Rust command/tests. PR3 should not edit it; use existing command through TS wrapper.
- `runtime_commit_budget_release_for_project`: MEDIUM risk, 7 direct impacts. PR3 should not edit it.
- `runtime_staging_artifact_commit_success_for_project`: HIGH risk, 7 direct impacts and staging cleanup path-safety flows. PR3 should not edit it.
- `writeFileAtomic`: CRITICAL risk, 21 impacted symbols / 3 execution flows. PR3 should not edit it and should only depend on an injected writer interface.

Before implementation, rerun impact for any existing symbol that becomes an edit target.

Architect Gate result:

- Claude ACP session `bb572f4d-88f7-47f2-a9d1-82e72015c401`, audit `/Users/mac-mini/.codex/acp-runs/2026-06-30T08-33-12-392Z-47169.jsonl`, provider `9fe03136-4e72-42e3-855a-447b68e61916`, model `claude-opus-4-8`, verification `provider-export`.
- Verdict: WARN.
- Accepted P1/P2 requirements are reflected below: budget is serialization-only, skip does not cleanup, release runs in `finally`, content hash is pinned, newline append is exact, release-on-error tests are broadened, delete NotFound must converge, PR3 event id is deferred, staged-body read is staging-root contained, and runtime wrapper tests must assert serde field casing.

## Commit Operation Semantics

Input:

- `artifactId`
- `jobId`
- `artifactPath`
- `artifactHash`
- `targetPath`
- `baseHash`
- `operationIntent`
- `sourceKind`

Adapter calls:

1. Claim commit-path budget for `targetPath`.
2. Read staged artifact body through a staging-root-contained adapter and verify `hash(stagedBody) === artifactHash`.
3. Read current committed target content, if present.
4. Compute `currentHash` when current content exists.
5. Apply the ADR base-hash matrix:
   - `create` with missing target and `baseHash = null` writes staged body.
   - `create` with existing target conflicts.
   - `update` with matching current hash replaces with staged body.
   - `update` with missing or mismatched current hash conflicts.
   - `append` with missing target and `baseHash = null` creates staged body.
   - `append` with matching current hash appends staged body using a deterministic newline join.
   - `append` with mismatched current hash conflicts.
   - `delete` with matching current hash deletes.
   - `delete` missing with `baseHash = null` or present base hash returns `skipped`.
   - `delete` existing with mismatched current hash conflicts.
6. Atomic write/delete through the committed-Markdown file adapter.
7. Compute `finalHash` for applied create/update/append results.
8. Always release the budget claim in `finally` after a successful claim, even when the operation rejects/conflicts/throws.
9. After release, call staging commit-success cleanup only for `committed` and `merged`.

Ordering rule:

- `claim -> read staged + verify hash -> read current + hash -> decide -> atomic write/delete -> compute final hash -> finally release -> best-effort cleanup`.
- Cleanup failure must not downgrade or throw over an already-applied `committed` / `merged` result. Surface cleanup failure as diagnostic metadata for caller/logging, but keep the commit result.
- If a write/delete adapter throws before final mutation is known to be durable, return/throw a visible adapter error after releasing the claim; tests must cover this.

Path authority:

- SPEC-2 budget claim is serialization authority only. It does not prove filesystem containment and must not be treated as write authority.
- The committed-Markdown write/delete adapters must be project-sandboxed operations equivalent to existing Tauri `write_file_atomic` / `delete_file`.
- The exact `targetPath` passed to the write/delete adapter must equal the `affectedPath` passed to budget claim. Do not claim path A and write/delete path B.
- PR3 must not add a second logical Markdown path validator in core runtime; adapter tests should assert same target path propagation, while the shell adapter later owns project sandboxing.

Staged body authority:

- The staged-body read adapter must resolve `artifactPath` against `<project>/.llm-wiki/runtime/staging/` and containment-check to that staging root.
- A generic project file read is not sufficient for staged artifact body reads.

Hash contract:

- PR3 must define one reusable content hash helper for staged/current/final Markdown content.
- Algorithm: SHA-256 hex over UTF-8 bytes of the exact string passed to commit operation, after canonicalizing CRLF and CR to LF and without trimming or adding trailing newline.
- Future prepare/staging code must reuse this helper for `artifactHash` and `baseHash`; otherwise every update/append/delete-of-existing can spuriously conflict.

Append join:

- Append-to-missing writes the staged body verbatim and returns `committed`.
- Append-to-existing with matching base returns `merged`.
- Deterministic join rule: normalize existing/staged strings through the hash canonicalization first; if existing is empty, final content is staged; otherwise final content is `existing` with exactly one trailing `\n`, followed by staged with leading `\n` stripped. Do not invoke semantic merge.
- Append-to-existing with an empty staged body preserves existing content and still returns `merged`; this is treated as a valid empty append artifact, not semantic merge.

Conflict/rejection path:

- Return `conflicted` for valid candidates blocked by base/current state.
- Return `rejected` for invalid artifact hash, invalid path from budget claim, missing staged artifact, unsupported intent, or adapter validation errors before write.
- Do not mark artifact failed or create repair jobs in PR3; PR5 owns that routing.
- Do not call staging commit-success cleanup on `skipped`, `conflicted`, or `rejected`.
- `skipped` artifacts remaining `pending` exposes a SPEC-2 lifecycle gap because TTL GC currently reaps only `failed` / `cancelled`. Record this as follow-up instead of falsely marking skipped artifacts committed.

Event/audit boundary:

- PR3 results carry `currentHash` / `finalHash` but no durable runtime event id. Event id is absent/null until PR4 appends commit audit records through `events-progress`.

## Implementation Order

1. Add PR3 plan and README status update.
2. Run Architect gate before code.
3. Add core runtime commit operation types and helper functions.
4. Add fake-adapter focused tests for:
   - create missing;
   - create conflict when target exists;
   - update base match;
   - update base mismatch;
   - append missing;
   - append base match with newline join;
   - append mismatch conflict;
   - delete base match;
   - delete missing skip;
   - staged hash mismatch rejected;
   - budget released on committed/conflicted/rejected/write error;
   - budget released when staged-body read throws;
   - budget released when current read throws;
   - budget released when hash adapter throws;
   - cleanup throws after a successful write and result remains `committed` / `merged`;
   - update writes staged body verbatim and does not call semantic merge;
   - append uses the exact deterministic join and does not call semantic merge;
   - delete missing with present base hash returns `skipped` and does not cleanup;
   - write/delete adapter receives the exact same target path that budget claim received;
   - staged-body read adapter is required to be staging-root-contained.
5. Verify existing `delete_file` missing-file behavior before relying on it. If it errors on NotFound, the future shell adapter must catch NotFound and treat missing-at-delete as success after the commit operation has already decided delete is allowed.
6. Add narrow TS wrappers for existing runtime DB commands used by future shell integration:
   - `runtime_commit_budget_claim`;
   - `runtime_commit_budget_release`;
   - `runtime_staging_artifact_commit_success`.
7. Add wrapper tests that mock `invoke` payload names/shapes and assert exact Rust serde field casing.
8. Run focused tests, Simplicity Gate, Tester Gate, Reviewer Gate.
9. Stage intentionally, run staged GitNexus detect, commit, push, PR, CI/review loop, merge, cleanup.

## Test Plan

- `pnpm exec vitest run src/core-runtime/markdown-commit/commit-operation.test.ts src/commands/runtime-db.test.ts`
- `pnpm exec vitest run src/core-runtime/contract/boundary-check.test.ts src/core-runtime/contract/headless-contract.test.ts`
- `pnpm lint`
- `git diff --check`
- `npx gitnexus detect-changes --repo llm_wiki --scope staged`

If Architect requires Rust command changes:

- `cargo test runtime_db --manifest-path src-tauri/Cargo.toml`

## Gate Plan

- Architect: Claude ACP first, timeout `600000`; fallback ZCode/Kimi/internal Architect.
- Simplicity: run because PR3 is an implementation PR touching shared commit behavior; use ZCode read-only simplicity reviewer if the diff touches runtime wrappers or shared state-machine code.
- Tester: Kimi first; fallback Claude/ZCode/internal Tester.
- Reviewer: ZCode first; fallback Claude/internal Reviewer.
- Any P0/P1/P2 must be fixed in PR3 before PR creation or explicitly routed only if Architect classifies it out of scope.

## Risks

- Accidentally duplicating SPEC-2 path normalization. Mitigation: use budget claim as serialization authority only; do not invent a separate filesystem path validator in PR3 core.
- Serializing one path while writing another. Mitigation: treat budget as serialization-only and assert the write/delete adapter receives the same target path.
- Losing repair evidence by cleaning artifacts too early. Mitigation: cleanup only after `committed` / `merged`; never cleanup `skipped`, `conflicted`, or `rejected`.
- Leaking shell dependencies into core runtime. Mitigation: core module uses injected adapters only and must pass existing boundary tests.
- Over-generalizing merge. Mitigation: deterministic append join only; semantic merge remains non-goal.
- Releasing budget inconsistently on thrown errors. Mitigation: tests cover release on all post-claim exits.
- Integration-time conflict storm from hash drift. Mitigation: freeze and reuse one SHA-256/LF canonicalization helper.

## Follow-up

- Base-hash safety is advisory until all existing Markdown writers route through the commit layer; current ingest/write/delete flows still bypass commit budget.
- Resolve skipped artifact lifecycle after PR3. SPEC-2 TTL GC currently reaps `failed` / `cancelled`, not `pending`.
- Re-check `commit-total` default capacity before real worker-pool integration in SPEC-5.

## PR Metadata

- PR title: `feat: add markdown commit operation`
- Commit message: `feat: add markdown commit operation`
