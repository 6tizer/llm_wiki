# SPEC-4-FIX PR1: Profile Lifecycle Plan

> Type: PR implementation plan | Status: merged via #228 | Issue: #227 | Branch: `codex/spec-4-fix-pr1-profile-lifecycle` | Run: `cfb4239b-9c67-4135-acc4-55ec1689a2dd`

## Scope

Implement runtime profile deletion as a safe lifecycle operation:

- add profile soft delete with `deleted_at_ms INTEGER NULL`;
- add Rust command `runtime_profile_delete` and TS wrapper `runtimeProfileDelete`;
- block deletion when active, unexpired claims reference the profile;
- filter deleted profiles from list/status/pool claim/agent resolver paths;
- preserve historical claim and circuit-breaker rows;
- add Settings UI delete action with destructive confirmation;
- delete profile secrets only after DB delete succeeds, and never return secret values.

## Non-goals

- No profile restore UI.
- No hard-delete cleanup job.
- No Agent chat profile selector or permission controls.
- No legacy provider secret migration.
- No SPEC-4-FIX PR2 Settings IA move.
- No SPEC-4-FIX PR3 Agent SDK compatibility work.

## Key Files And Symbols

- `src-tauri/src/commands/runtime_db.rs`
  - `initialize_profile_schema`
  - `runtime_profile_list_for_project`
  - `runtime_profile_status_for_project`
  - `runtime_profile_pool_claim_for_project`
  - `resolve_agent_run_profile_for_project_at_with_store`
  - new `runtime_profile_delete`
- `src-tauri/src/lib.rs`
  - Tauri command registration.
- `src/commands/runtime-db.ts`
  - new delete request/result interface and wrapper.
- `src/components/settings/sections/model-profiles-section.tsx`
  - delete profile UI and post-delete selection.
- `src/components/settings/sections/model-profiles-section.test.tsx`
  - UI delete/secret cleanup coverage.
- `src/commands/runtime-db.test.ts`
  - wrapper coverage.

## GitNexus Impact

Pre-edit impact:

- `initialize_profile_schema`: HIGH, 43 impacted, 3 affected processes: `profile_pool_job_linkage_rolls_back_when_audit_writes_fail`, `profile_pool_job_linkage_writes_events_and_progress_only_when_requested`, `agent_spawn`.
- `runtime_profile_pool_claim_for_project`: MEDIUM, 14 impacted, 2 affected processes: profile pool job linkage flows.
- `runtime_profile_list_for_project`: LOW, 3 impacted, no affected processes.
- `runtime_profile_status_for_project`: LOW, 2 impacted, no affected processes.
- `resolve_agent_run_profile_for_project_at_with_store`: LOW, 6 impacted, affected process `agent_spawn`.
- `ModelProfilesSection` uid `Function:src/components/settings/sections/model-profiles-section.tsx:ModelProfilesSection`: LOW, 7 impacted, affected Settings body flow.
- `runtimeProfileList`: LOW, 1 impacted, no affected processes.

Risk note: schema is HIGH because it is a runtime profile hub used by pool and Agent spawn paths. This PR keeps storage shape backward-compatible by adding a nullable column and default filtering, then covers pool/agent resolver behavior with focused Rust tests.

## Implementation Order

1. Add `deleted_at_ms` schema evolution in `initialize_profile_schema`, including compatible `ALTER TABLE` for existing DBs and an index that keeps default visible-profile queries cheap.
2. Add delete request/result structs and `runtime_profile_delete_for_project`:
   - normalize `profileId`;
   - expire stale claims first;
   - fail if an active unexpired claim still exists;
   - read old `secret_ref`;
   - set `deleted_at_ms` and `updated_at_ms`;
   - return `profileId`, `deletedAtMs`, and opaque `secretRef`.
3. Add visible-profile read helpers so list/status/pool claim/resolver exclude deleted profiles by default.
4. Register the command in `src-tauri/src/lib.rs` and add TS types/wrapper/tests.
5. Add UI delete action:
   - available only for persisted selected profiles and healthy runtime;
   - confirm before destructive action;
   - call DB delete first;
   - best-effort delete returned `secretRef` only after DB success;
   - remove the profile locally and select the next visible profile or a clean draft.
6. Add Rust tests for active claim block, expired claim delete, list/status/claim/resolver filtering, preserved history, and no secret value exposure.
7. Add UI tests for delete success, DB failure no secret cleanup, and selection stability.

## Test Plan

Focused:

```bash
cargo test runtime_profile --manifest-path src-tauri/Cargo.toml
cargo test profile_pool --manifest-path src-tauri/Cargo.toml
pnpm exec vitest run src/commands/runtime-db.test.ts src/components/settings/sections/model-profiles-section.test.tsx
```

Broader verification before PR:

```bash
pnpm lint
pnpm test
git diff --check
npx gitnexus detect-changes --repo llm_wiki --scope unstaged
npx gitnexus detect-changes --repo llm_wiki --scope staged
```

## Gate Plan

- Architect: Claude ACP if available with confirmed provider/model; fallback ZCode/Kimi/internal.
- Coder: Commander inline Coder unless implementation expands beyond the files above.
- Simplicity: ZCode read-only simplicity reviewer with `--timeout-ms 600000` because this touches Rust DB/shared runtime; fallback internal Simplifier.
- Tester: Kimi read-only static/focused packet with `--timeout-ms 600000`; fallback internal Tester.
- Reviewer: ZCode external reviewer plus internal Reviewer.
- Any real P0/P1/P2 must be fixed in this PR and rechecked.
- Any scoped P3 found by gates must be fixed in this PR unless classified non-actionable or risk-increasing in the PR comment.

## Expected PR Metadata

- Title: `feat: add runtime profile deletion`
- Commit: `feat: add runtime profile deletion`
- PR body must include issue #227, run id, impact summary, focused/full tests, staged GitNexus detect, Simplicity result, Tester/Reviewer reports, and CI status.
