# SPEC-4 PR2 Plan: Settings Profiles UI + Secret Write Boundary

> Type: PR execution plan | Status: in progress | Owner: Commander | Branch: `codex/spec-4-pr2-settings-profiles` | Primary issue: #185 | Run: `84f61d0e-bf5c-4431-afee-87f6b0430e40`

## Goal

Add the first user-facing Model Profile management surface in Settings while keeping secret values out of runtime DB, project files, logs, command responses, and PR artifacts.

PR2 makes PR1's profile storage usable from the LLM Settings panel:

- create and edit runtime profiles;
- enable/disable profiles;
- set profile kind, provider, model, endpoint, auth style, task families, and max concurrency;
- write/delete profile secrets through Rust-side OS credential storage;
- run a form-level smoke test with the current unsaved raw secret.

## Scope

Deliverables:

- Add Settings LLM profile UI beside the existing preset configuration UI, reusing the LLM section's inline persistence pattern instead of the global Save bar.
- Add public Tauri commands for profile secret write/delete:
  - UI sends raw secret only to the write command;
  - Rust writes to OS credential storage and returns only `secretRef`;
  - delete accepts only a validated `secretRef`;
  - no list/status/create/update response returns a secret value.
- Add TS wrappers in `src/commands/profile-secrets.ts` and wrapper tests for the new secret commands. Secret write/delete are storage-boundary actions, not runtime DB metadata actions.
- Use `runtimeProfileCreate`, `runtimeProfileUpdate`, `runtimeProfileList`, and `runtimeProfileStatus` for profile metadata.
- Add form-level smoke test using existing `testLlmConnection` / `testLlmFunction` with the draft fields and raw secret currently in the form.
- Show cached capability status from PR1 fields, but do not perform capability certification in this PR.
- Add focused UI tests for load, create/update payloads, enable/disable, task-family/max-concurrency controls, secret write behavior, and smoke test behavior.

## Non-Goals

- No real stored-profile capability probe; that is PR3.
- No scheduler selection, concurrency budget enforcement, retry-after, or circuit breaker; that is PR4.
- No Agent-run sidecar/profile adapter or per-run env injection; that is PR5.
- No automatic migration from legacy `llmConfig` / `providerConfigs` API keys.
- No blocking of legacy `app-state.json` secret-bearing fields in PR2.
- No profile physical schema changes unless implementation proves PR1 fields are insufficient.
- No raw secret read command exposed to the frontend.

## Current Facts

- PR1 landed runtime profile schema/storage and command wrappers on `main@4ca772e`.
- Existing Settings LLM UI is `LlmProviderSection`; it uses inline persistence and is excluded from the global Settings Save bar.
- Existing preset config still stores `ProviderOverride.apiKey` in plugin-store; this dual-track state remains until PR5 or a dedicated closeout.
- Existing smoke tests live in `src/lib/connection-tests.ts` and already return non-secret result messages.
- Rust secret helpers exist in `src-tauri/src/commands/profile_secrets.rs`, but PR1 kept them internal; PR2 exposes only write/delete command boundaries.

## Planned Interface

TS wrapper shape:

```ts
interface ProfileSecretWriteRequest {
  secretValue: string
}

interface ProfileSecretWriteResult {
  secretRef: string
}

interface ProfileSecretDeleteRequest {
  secretRef: string
}
```

Rust commands:

- `profile_secret_write(request)` -> `{ secretRef }`
- `profile_secret_delete(request)` -> `{ ok: true }`

UI draft behavior:

- Existing profiles load from `runtimeProfileList`.
- New profile defaults: `enabled = true`, `maxConcurrency = 1`.
- Saving a draft with a new non-empty raw secret first calls `profile_secret_write`, then saves the returned `secretRef` through profile create/update.
- If profile create/update fails after `profile_secret_write` succeeds, the UI must best-effort call `profile_secret_delete(newRef)` before surfacing the save error.
- Updating an existing profile with a replacement raw secret keeps the old `secretRef` until `runtimeProfileUpdate({ secretRef: newRef })` succeeds. After success, the UI best-effort deletes `oldRef`; on failure, it best-effort deletes only `newRef`.
- Clearing/removing a saved secret first updates the profile with `clearSecretRef: true`. Only after that update succeeds does the UI best-effort call `profile_secret_delete(oldRef)`.
- A `secretRef` stored in runtime DB should correspond to an existing keychain entry; PR2 uses UI compensation to avoid known orphan or dangling refs. Crash/OS failure reconciliation is a follow-up, not a PR2 feature.
- `profile_secret_delete` is idempotent for already-missing profile refs: missing credential returns `{ ok: true }`; permission/IO errors remain failures.
- Smoke test uses draft fields plus current raw secret. If the draft has only `secretRef` and no raw secret, PR2 shows that stored-secret probe belongs to PR3 instead of reading the secret back to the frontend.

Profile draft to `LlmConfig` smoke mapping:

- `apiKey` is the draft raw secret only, kept in memory and never persisted by the profile UI.
- `model` comes from `modelId`; profile `endpoint` maps to the endpoint/base URL field used by the selected LLM provider.
- `apiMode = openai-chat-completions` maps to an OpenAI-compatible/custom `LlmConfig` path.
- `apiMode = anthropic-messages` maps to an Anthropic-compatible/custom `LlmConfig` path.
- `apiMode = google-generate-content` maps to the Google provider path when `providerId` is Google-compatible.
- `apiMode = local-cli` is not smoke-tested through raw API-key form fields in PR2; show an unsupported smoke message rather than using the wrong protocol.
- Unknown provider/apiMode combinations return an explicit unsupported smoke result; they must not silently fall back to a different protocol.

Task family options in PR2:

- `chat`
- `ingest`
- `review`
- `synthesis`
- `taxonomy`
- `agent`
- `vision`
- `embedding`

Rust accepts arbitrary bounded task-family strings. The UI offers the curated options above, but must preserve and render existing unknown task-family values as selected custom chips so future values are not dropped.

## GitNexus Impact Summary

Pre-edit impact checks:

- `LlmProviderSection`: LOW, 1 direct upstream caller, Settings body only.
- `runtimeProfileCreate`: LOW, 1 direct test caller.
- `runtimeProfileUpdate`: LOW, 1 direct test caller.
- `write_profile_secret`: LOW, 1 direct in-file test caller.
- `delete_profile_secret`: LOW, 1 direct in-file test caller.
- `testLlmConnection`: LOW, 5 impacted symbols across Settings and agent app tool smoke path. PR2 reuses it without changing its semantics.

No HIGH or CRITICAL impact found.

## Implementation Order

1. Write and index this PR plan; update the SPEC-4 rows in `docs/plans/README.md`.
2. Run Architect gate on this plan with Claude outage fallback to ZCode/Kimi/internal, then focused recheck after plan fixes.
3. Add Rust secret write/delete command request/result types, command functions, idempotent missing-ref delete behavior, registration, and in-memory tests.
4. Add TS secret command wrappers in `src/commands/profile-secrets.ts` and wrapper tests.
5. Add profile UI model helpers and Settings UI controls.
6. Wire create/update/enable/disable/task-family/max-concurrency/save flows, including safe secret compensation ordering.
7. Wire smoke test from draft config through the explicit draft-to-`LlmConfig` mapper, without reading saved `secretRef`.
8. Run focused tests, Simplicity Gate, Tester Gate, Reviewer Gate.
9. Fix every P0/P1/P2/P3 found in this PR, then run final lint/diff/detect and publish PR.

## Gate Plan

- Architect: Claude ACP was skipped due the known temporary outage window; use ZCode/Kimi fallback and focused recheck after plan fixes.
- Simplicity: PR2 touches UI state and Rust secret boundary, so use ZCode read-only simplicity reviewer if available; fallback internal Simplifier.
- Tester: Kimi static packet; fallback internal Tester.
- Reviewer: ZCode external reviewer plus internal Reviewer.
- External main gate timeout: `600000`; focused recheck timeout: `120000`.
- Merge standard: no unresolved P0/P1/P2, all PR2-discovered P3 fixed in PR2, CI green.

## Test Plan

Focused:

- `pnpm exec vitest run src/commands/runtime-db.test.ts src/components/settings/sections/llm-provider-section.test.tsx src/components/settings/sections/model-profiles-section.test.tsx`
- `pnpm exec vitest run src/commands/profile-secrets.test.ts`
- `cargo test profile_secret --manifest-path src-tauri/Cargo.toml`

Focused UI tests must include:

- secret write succeeds and profile create fails -> best-effort delete is called for the newly returned ref.
- replacement secret write succeeds and profile update fails -> only the new ref is deleted; the old ref stays attached.
- clearing an existing secret updates `clearSecretRef` first, then deletes the old ref.
- draft smoke test uses raw secret only; stored `secretRef` without raw secret does not trigger a secret read.
- unknown task-family values from DB remain visible/selected instead of being dropped.

Required before PR:

- `pnpm lint`
- `git diff --check`
- `npx gitnexus detect-changes --repo llm_wiki --scope staged`

Broader if command registration or UI risk expands:

- `cargo test --manifest-path src-tauri/Cargo.toml`
- `pnpm test:mocks`

## Expected PR Metadata

- PR title: `feat: add settings profile management`
- Commit message: `feat: add settings profile management`
- PR body must include:
  - run id;
  - scope/non-goals;
  - GitNexus impact/detect summary;
  - secret write/delete guarantee;
  - smoke test limitation: no stored-secret probe until PR3;
  - focused tests and lint results;
  - Simplicity/Tester/Reviewer reports;
  - `Refs #185`.
