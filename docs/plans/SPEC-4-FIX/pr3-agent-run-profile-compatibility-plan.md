# SPEC-4-FIX PR3: Agent-run Profile Compatibility Plan

> Type: PR implementation plan | Status: active | Issue: #231 | Branch: `codex/spec-4-fix-pr3-agent-profile-compat` | Run: `8418656b-358e-4294-9610-4f1c74b64aae`

## Goal

Make stored `agent-run` runtime profiles usable by Claude Agent SDK / Claude Code compatible providers without forcing LiteLLM as the only path.

This PR separates provider-native model identity from the model alias passed to Agent SDK, maps profile auth style into the correct SDK environment, and records bounded diagnostics when SDK-level compatibility fails.

## Scope

- Add `agentSdkModelId` to runtime profile create/update/read/probe surfaces.
- Keep `modelId` as the provider-native model id used by HTTP probes and model-call routing.
- Use `agentSdkModelId` as the Agent SDK / Claude Code model option when present, with explicit fallback to `modelId` only when no SDK alias is configured.
- Extend Rust Agent profile resolution to return:
  - provider model id;
  - SDK model id;
  - endpoint;
  - auth style;
  - secret value.
- Extend Rust sidecar spawn args and sidecar request options so secrets stay Rust-side but auth style reaches sidecar env construction.
- Map auth env correctly:
  - `bearer` -> `ANTHROPIC_AUTH_TOKEN`;
  - `x-api-key` / `api-key` -> `ANTHROPIC_API_KEY`;
  - endpoint -> `ANTHROPIC_BASE_URL`;
  - SDK model -> sidecar `model`, and SDK model env if the repo standardizes one.
- Keep HTTP Messages probe `capabilityJson` distinct from Agent SDK acceptance; use `capabilityJson` only for non-secret probe inspection such as configured SDK alias.
- Record SDK rejected / gateway auth failed as bounded non-secret profile diagnostics and make affected profiles temporarily ineligible through profile-pool circuit behavior.
- Update Model Profiles UI to expose an optional SDK model alias for `agent-run` profiles and reset stale capability when it changes.
- Repair PR2 docs state now that #230 is merged:
  - PR2 plan status.
  - README plan index row.
  - README Current Execution Order.

## Non-Goals

- No SPEC-7 conversation-level profile selector.
- No permission selector in Agent chat.
- No Unified Chat or timeline work.
- No LiteLLM service manager or committed LiteLLM config.
- No frontend command that reads profile secret values.
- No broad provider preset redesign beyond fields required for Agent SDK compatibility.

## Current Facts

- `runtime_model_profiles` stores `model_id`, `endpoint`, `api_mode`, `auth_style`, capability fields, and `deleted_at_ms`, but has no SDK model alias column.
- `RuntimeProfileCreateRequest`, `RuntimeProfileUpdateRequest`, `RuntimeProfileRecord`, and TS mirrors do not contain `agentSdkModelId`.
- `AgentRunProfileConfig` currently returns only `profile_id`, `model_id`, `endpoint`, and `secret_value`.
- `apply_agent_profile_config` passes `config.model_id` as `args.model`.
- Sidecar `core.ts` currently maps every profile secret to `ANTHROPIC_API_KEY`.
- HTTP probe already sets `agentRunSupported` based on capability JSON, but it does not prove the Claude Agent SDK accepts the selected model alias/auth env.
- Existing pool eligibility already rejects profiles with unsupported capability JSON, probe backoff, or open circuit breaker.

## Key Files / Symbols

- `src-tauri/src/commands/runtime_db.rs`
  - `RuntimeProfileCreateRequest`
  - `RuntimeProfileUpdateRequest`
  - `RuntimeProfileRecord`
  - `RuntimeProfileProbeDraftRequest`
  - `AgentRunProfileConfig`
  - `initialize_profile_schema`
  - `runtime_profile_create_for_project`
  - `runtime_profile_update_for_project`
  - `resolve_agent_run_profile_for_project_at_with_store`
  - `runtime_profile_probe_for_project_with_store`
  - `probe_profile_target`
  - `capability_json`
  - `profile_select_sql`
  - `map_profile_row`
- `src-tauri/src/commands/agent_cli/agent.rs`
  - `AgentSpawnArgs`
  - `apply_agent_profile_config`
- `src-tauri/sidecar/src/types.ts`
  - `AgentRequest.options`
- `src-tauri/sidecar/src/core.ts`
  - `createRequestHandler`
- `src-tauri/sidecar/src/core.node.ts`
- `src/commands/runtime-db.ts`
- `src/components/settings/sections/model-profiles-section.tsx`
- `src/components/settings/sections/model-profiles-section.test.tsx`
- `src/lib/agent/agent-transport.test.ts`
- `src-tauri/src/lib.rs` only if a new Tauri command is needed.

## GitNexus Impact

To run before code edits:

```bash
npx gitnexus impact RuntimeProfileCreateRequest --repo llm_wiki --direction upstream --depth 3 --include-tests
npx gitnexus impact RuntimeProfileUpdateRequest --repo llm_wiki --direction upstream --depth 3 --include-tests
npx gitnexus impact RuntimeProfileRecord --repo llm_wiki --direction upstream --depth 3 --include-tests
npx gitnexus impact AgentRunProfileConfig --repo llm_wiki --direction upstream --depth 3 --include-tests
npx gitnexus impact resolve_agent_run_profile_for_project_at_with_store --repo llm_wiki --direction upstream --depth 3 --include-tests
npx gitnexus impact apply_agent_profile_config --repo llm_wiki --direction upstream --depth 3 --include-tests
npx gitnexus impact createRequestHandler --repo llm_wiki --direction upstream --depth 3 --include-tests
npx gitnexus impact ModelProfilesSection --repo llm_wiki --direction upstream --depth 3 --include-tests
```

Expected risk: high. The PR touches runtime DB schema/API, shared Agent spawn behavior, and sidecar SDK environment construction. Proceed only with focused Rust/TS/sidecar tests plus ZCode Simplicity and external review.

## Implementation Order

1. Add `agent_sdk_model_id` column to `runtime_model_profiles` with migration via `ensure_column_exists`.
2. Thread `agentSdkModelId` through Rust create/update/status/list/probe records and TS command types.
3. Update profile SQL select/map helpers and create/update paths.
4. Add optional SDK model alias field to Model Profiles UI draft/create/update/probe payloads.
5. Extend `AgentRunProfileConfig` and resolver to return `provider_model_id`, `agent_sdk_model_id`, `auth_style`, endpoint, and secret.
6. Update `AgentSpawnArgs` and `apply_agent_profile_config` so sidecar receives SDK model and auth style, not provider model by accident.
7. Update sidecar request types/env mapping:
   - bearer uses `ANTHROPIC_AUTH_TOKEN`;
   - x-api-key/api-key uses `ANTHROPIC_API_KEY`;
   - no secret env for `none` or local OAuth profiles.
8. Keep HTTP probe `capabilityJson` non-secret and include the configured Agent SDK model alias for inspection; do not treat HTTP probe success as proof that Claude Agent SDK accepted the alias.
9. Make SDK rejected/gateway auth failed mark the stored profile with bounded non-secret diagnostics and temporary ineligibility using existing profile-pool circuit behavior.
10. Update docs state drift from PR2.
11. Add or update focused tests.

## Test Plan

Focused Rust:

```bash
cargo test agent_run_profile --manifest-path src-tauri/Cargo.toml
cargo test runtime_profile --manifest-path src-tauri/Cargo.toml
cargo test profile_pool --manifest-path src-tauri/Cargo.toml
```

Focused TS / sidecar:

```bash
pnpm exec vitest run src/commands/runtime-db.test.ts src/lib/agent/agent-transport.test.ts src/components/settings/sections/model-profiles-section.test.tsx
pnpm --dir src-tauri/sidecar test
```

Required before PR:

```bash
pnpm lint
git diff --check
npx gitnexus detect-changes --repo llm_wiki --scope staged
```

Run broader tests if focused tests expose shared runtime or sidecar regressions:

```bash
pnpm test
```

## Required Cases

- `agentSdkModelId` persists through create/update/list/status.
- Missing `agentSdkModelId` falls back to `modelId` only when no SDK alias is configured.
- `agentSdkModelId` is passed as sidecar `model` for Agent SDK invocation.
- Provider-native `modelId` remains available for HTTP Messages/model-call probe.
- bearer auth does not populate `ANTHROPIC_API_KEY`.
- x-api-key/api-key auth does not populate `ANTHROPIC_AUTH_TOKEN`.
- SDK rejected is recorded as bounded diagnostic without secret leakage.
- SDK rejected or gateway auth failure makes the profile temporarily ineligible until backoff/circuit clears.
- Existing legacy Agent path remains available when work runtime is disabled.
- Settings UI does not drop unknown future profile fields and resets stale capability when SDK alias changes.

## Gate Expectations

- Architect: Claude ACP if provider/model preflight succeeds; fallback ZCode/Kimi/internal. Timeout `600000`.
- Simplicity: ZCode read-only main gate because this PR touches Rust DB, shared runtime, sidecar, and Agent SDK behavior. Timeout `600000`.
- Tester: Kimi static/focused packet, fallback internal Tester.
- Reviewer: ZCode external reviewer plus internal Reviewer.
- Any P0/P1/P2 must be fixed in this PR and rechecked.
- Any scoped P3 must be fixed in this PR unless classified as non-actionable or risk-increasing.

## PR Metadata

- Planned commit: `feat: add agent-run profile sdk compatibility`
- Planned PR title: `feat: add agent-run profile sdk compatibility`
- PR body must include issue #231, run id, GitNexus impact/detect, tests, Simplicity/Tester/Reviewer reports, and CI status.
