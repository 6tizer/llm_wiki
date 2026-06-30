# SPEC-4 PR1 Plan: Profile Schema + Runtime Storage + Secret Reference

> Type: PR execution plan | Status: merged via PR #217 | Owner: Commander | Branch: `codex/spec-4-pr1-profile-schema-storage` | Primary issue: #186 | Refs: #185 | Run: `f31f22ec-2971-44dd-b227-787712000a6c`

## Goal

Establish the shell-neutral Profile storage foundation for SPEC-4 before UI, probes, scheduling, or Agent-run wiring land.

PR1 creates the durable model/profile boundary:

- model-call and agent-run profiles are first-class runtime records.
- runtime DB and project files store only profile metadata and `secretRef`.
- secret values are written/read through a Rust-side OS credential adapter.
- Core Runtime `profiles` contract stops using placeholder command/event names.

## Scope

Deliverables:

- Add profile types for:
  - profile kind: `model-call` / `agent-run`;
  - provider id / model id / endpoint or base URL;
  - API mode / auth style / task-family enablement;
  - concurrency settings;
  - secret reference metadata.
- Add runtime DB profile schema families:
  - profile records;
  - capability/status fields broad enough for later probe writes without `ALTER TABLE`;
  - migration bookkeeping through existing runtime migration family rules.
- Add Tauri commands and TS command wrappers for profile list/create/update/read status, with profile delete deferred unless implementation proves a hard PR2 need. Disable/enable goes through update.
- Add a Rust-side secret adapter using OS credential storage with `keyring = "4.1.2"` behind a small trait so tests can use an in-memory backend.
- Ensure command responses never include secret values.
- Extend `src/core-runtime/contract/index.ts` profile command/event inventory using names aligned with the frozen SPEC-1 Profiles inventory.
- Add focused Rust and TS tests for validation, migration idempotence, secret redaction, and shell-neutral contract shape.
- Update `docs/plans/README.md` with this PR plan.

## Non-Goals

- No Settings UI profile management.
- No capability network probe.
- No scheduler profile pool.
- No Agent-run sidecar env injection.
- No automatic migration from legacy `llmConfig/providerConfigs` into active profiles.
- No real provider API calls.
- No storing API keys in runtime DB, `app-state.json`, logs, tests, PR comments, or docs.
- No claim that legacy secret-bearing settings are fixed. During PR1, legacy `llmConfig.apiKey`, `providerConfigs.*.apiKey`, embedding/search/multimodal/MinerU/API token settings can still exist in `app-state.json`; PR1 only guarantees the new Profile path stores secret references. This dual-track window must be recorded in the PR body, and SPEC-4 PR2/PR4/PR5 must either retire the legacy secret writes or create a dedicated follow-up issue before #185/#186 close.

## Current Facts

- Legacy provider truth currently lives in Tauri plugin-store:
  - `src/lib/project-store.ts` keys: `llmConfig`, `providerConfigs`, `activePresetId`.
  - `src/stores/wiki-store.ts` still models `apiKey` directly.
- Agent-run currently forwards `model`, `apiKey`, and `baseUrl` from `llmConfig` through:
  - `src/components/chat/agent-transport-options.ts`;
  - `src/lib/agent/agent-transport.ts`;
  - `src-tauri/src/commands/agent_cli/agent.rs`;
  - `src-tauri/sidecar/src/core.ts`.
- Runtime DB already owns jobs, leases, events/progress, resource budgets, staging artifacts, derived stale markers, and migrations in `src-tauri/src/commands/runtime_db.rs`.
- Core Runtime already has a `profiles` family but it still uses placeholder command/event names.
- There is no existing Keychain/credential crate; `keyring = "4.1.2"` is compatible with local Rust 1.95.

## Planned Interface

Runtime profile records should expose non-secret metadata only. Storage records are not event payloads; profile-changed events should carry a small identity/status payload, not the whole row.

```ts
type ModelProfileKind = "model-call" | "agent-run"
type ProfileAuthStyle = "none" | "bearer" | "x-api-key" | "api-key" | "oauth-local-cli"
type ProfileApiMode = "openai-chat-completions" | "anthropic-messages" | "google-generate-content" | "local-cli"

interface ModelProfileRecord {
  profileId: string
  kind: ModelProfileKind
  displayName: string
  providerId: string
  modelId: string
  endpoint?: string | null
  apiMode: ProfileApiMode
  authStyle: ProfileAuthStyle
  secretRef?: string | null
  enabled: boolean
  taskFamilies: string[]
  maxConcurrency: number
  capabilityStatus: "unknown" | "supported" | "limited" | "unsupported" | "error"
  capabilityJson: string
  capabilityVersion: string
  capabilityCheckedAtMs?: number | null
  probeBackoffUntilMs?: number | null
  lastCapabilityError?: string | null
  createdAtMs: number
  updatedAtMs: number
}
```

Secret adapter behavior:

- `secretRef` is a generated opaque reference, not a secret value. It must use the canonical `llm-wiki-profile-secret:<uuid>` format.
- profile create/update commands accept `secretRef`, not secret values.
- secret write/delete are Platform Adapter / storage-boundary actions, not Core Runtime `profiles:*` contract messages in PR1.
- internal secret read is covered by a write-read-delete round-trip test with an in-memory backend; production consumers arrive in PR5.
- delete profile is deferred; profile disable/update detaches a `secretRef` when requested.
- Update clear flags (`clearEndpoint`, `clearSecretRef`, `clearLastCapabilityError`) take precedence over same-name set fields when both are present.
- all logs/errors use bounded, redacted text.

Core Runtime profile command/event inventory should include:

- `profiles:list`
- `profiles:create`
- `profiles:update`
- `profiles:test`
- `profiles:resolve-secret-reference`
- `profiles:read-capability-status`
- `profiles:profile-changed`
- `profiles:capability-changed`

PR1 implements only the storage-safe subset. `profiles:test` and capability read/write behavior are frozen as contract names for PR3 but must not perform network probes in PR1. `profiles:resolve-secret-reference` must not return secret values to UI payloads; PR1 may implement it as internal adapter coverage only if no safe public command surface exists.

Runtime DB migration constraint:

- Existing migration bookkeeping uses family/version rows and `CREATE TABLE IF NOT EXISTS`; there is no general `ALTER TABLE` stepper today.
- PR1 must define a `runtime_model_profiles` schema under the `profile-status` migration family that later PRs can populate without schema changes, using bounded TEXT/JSON status fields where capability details may grow.
- If later work truly needs new physical columns, that must be a separate schema-evolution PR before the dependent feature lands.
- PR3/PR4/PR5 are not allowed to add profile physical columns opportunistically. They must either use PR1's `capabilityJson` / status fields or first land a focused runtime DB schema-evolution PR with idempotent tests.

Keyring / CI constraint:

- Use `keyring = "4.1.2"` with its default native backends; do not run CI tests against the real OS keychain.
- Wrap it behind a small `SecretStore` trait; unit tests use `InMemorySecretStore`.
- Runtime failures from unavailable OS credential storage must return bounded errors, not panic.
- The trait must be shaped for known future consumers: PR5 Agent-run env injection, PR4/PR5 Model-call request construction, and PR2 Settings validation. PR1 still does not wire those consumers.

## Follow-up Gates

- #185/#186 closeout requires a visible answer for legacy `app-state.json` secrets: migrated to profile `secretRef`, retired with compatibility fallback, or tracked in a dedicated follow-up issue linked from the closing PR.
- Any future profile table physical column change requires a dedicated schema-evolution PR before the feature PR that needs it.
- PR5 must prove `SecretStore` read is consumed by real profile resolution for Agent-run env/config injection; PR1's read path is only contract/test coverage.

## GitNexus Impact Summary

Pre-edit impact checks:

- `runtime_db_health`: LOW, 0 direct upstream impacts.
- `runtime_db_health_for_project`: MEDIUM, 14 direct callers, 1 affected process in runtime DB migration tests. This is expected because PR1 adds schema initialization and migration rows.
- `createMockCoreRuntimeContract`: LOW, 2 direct test callers.
- `RuntimeContractMessage`: LOW, 11 impacted symbols, contract/markdown-commit/runtime wrapper test surface only.
- `RUNTIME_CONTRACT_MESSAGES`: LOW, 0 upstream impacts.
- `RuntimeContractFamily`: not indexed as a standalone GitNexus target; covered through focused contract tests.
- `runtimeJobList`: LOW, 1 direct wrapper test caller, used as proxy for TS runtime command wrapper edits.

No HIGH or CRITICAL impact found.

## Implementation Order

1. Write and index this PR plan.
2. Run Architect gate on PR1 scope.
3. Add profile contract metadata aligned with SPEC-1 ADR names and focused contract tests.
4. Add runtime DB profile schema, migration rows, validation helpers, and Rust tests.
5. Add internal secret adapter with in-memory tests; keep secret write/delete out of Core Runtime profile contract.
6. Add TS command wrappers and wrapper tests for non-secret profile records/status.
7. Run focused tests, Simplicity Gate, Tester Gate, Reviewer Gate.
8. Run final lint/diff/detect, then commit/push/open PR.

## Gate Plan

- Architect: Claude ACP is temporarily unavailable until 2026-07-01 02:00 CST; record outage and use ZCode/Kimi/internal fallback.
- Simplicity: PR1 touches shared runtime/Rust DB, so use ZCode read-only simplicity reviewer if available; fallback internal Simplifier.
- Tester: Kimi static packet; fallback internal Tester.
- Reviewer: ZCode external reviewer plus internal Reviewer.
- External main gate timeout: `600000`; focused recheck timeout: `120000`.
- Merge standard: no unresolved P0/P1/P2.

## Test Plan

Focused:

- `pnpm exec vitest run src/core-runtime/contract/headless-contract.test.ts src/core-runtime/contract/adapter-contract.test.ts src/commands/runtime-db.test.ts`
- `cargo test runtime_db --manifest-path src-tauri/Cargo.toml`

Required before PR:

- `pnpm lint`
- `git diff --check`
- `npx gitnexus detect-changes --repo llm_wiki --scope staged`

Broader optional if schema/command registration risk expands:

- `cargo test --manifest-path src-tauri/Cargo.toml`
- `pnpm test:mocks`

## Expected PR Metadata

- PR title: `feat: add model profile runtime storage`
- Commit message: `feat: add model profile runtime storage`
- PR body must include:
  - run id;
  - scope/non-goals;
  - GitNexus impact/detect summary;
  - secret storage guarantee;
  - focused tests and lint results;
  - Simplicity/Tester/Reviewer reports;
  - #186 primary link and #185 reference.
