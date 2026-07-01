# SPEC-4-FIX Remaining PRs Implementation Plan

> Type: execution plan | Status: completed via #228, #230, #232 | Owner: Commander | Baseline: `103bd3b fix: clarify agent profile availability` | Source: [`../spec-4-fix-model-profiles-closeout.md`](../spec-4-fix-model-profiles-closeout.md) and [`../spec-1-4-post-test-findings.md`](../spec-1-4-post-test-findings.md)

## Decision

SPEC-4-FIX was executed as three focused implementation PRs before SPEC-5 starts:

1. PR1 Profile lifecycle: merged via #228.
2. PR2 Settings/Profile IA: merged via #230.
3. PR3 Agent-run profile compatibility minimum: merged via #232.

Each implementation PR must get its own GitHub issue before coding starts, then bind that issue to a fresh agent-loop run. Do not reuse the docs planning PR as implementation evidence.

Merge standard for every SPEC-4-FIX implementation PR:

- no unresolved P0/P1/P2;
- every scoped P3 found by that PR's gates is fixed in the same PR;
- CI is green;
- Commander may merge once the findings gate and CI gate both pass.

## Current Facts

- `runtime_model_profiles` has profile metadata, capability cache fields, `secret_ref`, and `max_concurrency`, but no profile-level delete marker.
- Existing `deleted_at_ms` in `runtime_db.rs` belongs to staging artifacts, not model profiles.
- `runtime_profile_claims` and `runtime_profile_circuit_breakers` reference `runtime_model_profiles(profile_id)`, so lifecycle deletion must preserve claim history and avoid hard deletes.
- `runtime_profile_list_for_project`, `runtime_profile_status_for_project`, `runtime_profile_pool_claim_for_project`, and `resolve_agent_run_profile_for_project_with_store` currently read normal profile rows without a deleted-profile filter.
- `ModelProfilesSection` is rendered inside `LlmProviderSection`; Settings has no `model-profiles` category.
- `Knowledge Agents`, `taxonomy`, and `synthesis` are local LLM Wiki extensions and remain valid Settings categories.
- Agent transport already accepts `agentProfileId` and `permissionPolicy`, and profile pool claim already supports `preferredProfileIds`, but Chat UI does not yet expose profile or permission selectors.
- `resolve_agent_run_profile_for_project_with_store` returns only `model_id`, `endpoint`, and `secret_value`; `apply_agent_profile_config` passes `model_id` to the sidecar as the SDK model.
- The sidecar currently maps any profile secret to `ANTHROPIC_API_KEY`; it does not distinguish bearer token auth from x-api-key auth.
- Local historical evidence shows MiMo worked through a LiteLLM/Claude-alias bridge, but MiMo, DeepSeek, and Kimi also document direct Claude Code / Anthropic-compatible routes. LiteLLM is therefore optional, not mandatory.

## Cross-PR Guardrails

- Do not expose a frontend command that reads profile secret values.
- Do not hard-delete profile rows while profile claims or circuit-breaker history can reference them.
- Do not make LiteLLM a required dependency for providers that already support Claude Code / Anthropic-compatible endpoints.
- Do not move SPEC-7 controls into SPEC-4-FIX: conversation-level profile selector, permission selector, Unified Chat, and timeline remain SPEC-7.
- Do not start SPEC-5 worker pool work until PR1-PR3 are merged.
- Do not use this plan as a replacement for PR-level plans. Each PR still needs a dedicated `docs/plans/SPEC-4-FIX/prN-*.md` plan at PR start.

## PR1: Profile Lifecycle

Planned branch: `codex/spec-4-fix-pr1-profile-lifecycle`.

Planned issue: create a dedicated issue titled `SPEC-4-FIX PR1: Profile lifecycle`.

Scope:

- Add a profile soft-delete schema evolution for `runtime_model_profiles`, using `deleted_at_ms INTEGER NULL`.
- Add `runtime_profile_delete` and `runtimeProfileDelete`.
- Default profile list/status/pool claim/resolver paths must filter deleted profiles.
- Delete flow:
  - normalize `profileId`;
  - expire stale claims first;
  - block deletion when any active, unexpired claim still references the profile;
  - set `deleted_at_ms` and `updated_at_ms`;
  - leave historical claims and circuit-breaker rows intact;
  - return the deleted profile id, delete time, and previous `secretRef` only as an opaque ref for post-DB cleanup.
- UI adds a delete profile action with destructive confirmation.
- UI deletes a secret ref only after DB delete succeeds; if DB delete fails, secret cleanup must not run.
- Deleted current selection chooses the next visible profile or a clean draft.

Planned interface:

```ts
interface RuntimeProfileDeleteRequest {
  profileId: string
}

interface RuntimeProfileDeleteResult {
  profileId: string
  deletedAtMs: number
  secretRef?: string | null
}
```

Non-goals:

- No profile restore UI.
- No hard-delete cleanup job.
- No Agent chat selector or permission controls.
- No migration of legacy provider secrets.

Focused tests:

- `cargo test runtime_profile --manifest-path src-tauri/Cargo.toml`
- `cargo test profile_pool --manifest-path src-tauri/Cargo.toml`
- `pnpm exec vitest run src/commands/runtime-db.test.ts src/components/settings/sections/model-profiles-section.test.tsx`

Required cases:

- active claim blocks delete;
- expired claim does not block after claim expiry sweep;
- deleted profile is not returned by list/status and cannot be claimed;
- historical claim rows remain queryable for observability;
- delete result never returns a secret value;
- UI does not call `profileSecretDelete` when DB delete fails;
- UI removes deleted profile from the list and stabilizes selection.

## PR2: Settings/Profile IA

Planned branch: `codex/spec-4-fix-pr2-settings-profile-ia`.

Planned issue: create a dedicated issue titled `SPEC-4-FIX PR2: Settings Profile IA`.

Scope:

- Add Settings category `model-profiles`.
- Move `ModelProfilesSection` out of `LlmProviderSection` and render it from `settings-view.tsx`.
- Keep `LLM 模型` / `LLM Models` as legacy/default provider configuration.
- Adjust LLM provider page copy so it does not imply the whole system can use only one LLM. The single-active-provider behavior is only for legacy/default provider paths.
- Add short local-extension ownership copy for `Knowledge Agents`, `标签体系` / taxonomy, and `综合` / synthesis so these categories read as LLM Wiki product capabilities rather than upstream drift.
- Preserve current Settings global save behavior: LLM provider and Model Profiles keep their direct persistence behavior; draft-backed settings keep the global save bar.

Planned interface:

- `CategoryId` adds `"model-profiles"`.
- i18n adds `settings.categories.modelProfiles`.
- `LlmProviderSection` no longer imports or renders `ModelProfilesSection`.

Non-goals:

- No profile lifecycle work; PR1 owns delete semantics.
- No Agent chat profile/permission selector; SPEC-7 owns conversation controls.
- No broad Settings redesign.

Focused tests:

- `pnpm exec vitest run src/components/settings/settings-view.test.ts src/components/settings/sections/llm-provider-section.test.tsx`
- `pnpm exec vitest run src/components/settings/sections/model-profiles-section.test.tsx`

Required cases:

- Model Profiles appears as its own Settings category.
- LLM provider section no longer renders the model profiles entry.
- non-mac Settings category coercion keeps local extension categories reachable.
- i18n keys exist in English and Chinese.
- Dev App smoke confirms Model Profiles and LLM Models are sibling entries.

## PR3: Agent-Run Profile Compatibility Minimum

Planned branch: `codex/spec-4-fix-pr3-agent-profile-compat`.

Planned issue: create a dedicated issue titled `SPEC-4-FIX PR3: Agent-run profile compatibility`.

Scope:

- Add `agentSdkModelId` to runtime profile create/update/read surfaces.
- Keep `modelId` as provider-native model id; use `agentSdkModelId` for Claude Agent SDK / Claude Code invocation when present.
- Extend Rust profile resolver so it returns profile auth style, provider model id, SDK model id, endpoint, and secret value.
- Extend Agent request/sidecar option shape to carry auth style without exposing profile secrets to frontend state.
- Map auth env correctly:
  - `bearer` -> `ANTHROPIC_AUTH_TOKEN`;
  - `x-api-key` / `api-key` -> `ANTHROPIC_API_KEY`;
  - endpoint -> `ANTHROPIC_BASE_URL`;
  - SDK model -> sidecar `model` plus SDK model env where supported.
- Add stored-profile Agent SDK preflight that is distinct from HTTP Messages probe.
- Capability/diagnostic facts must distinguish:
  - Messages-compatible endpoint;
  - Agent SDK-compatible run;
  - SDK model rejected;
  - gateway auth failed.
- SDK rejected / gateway auth failed must write bounded non-secret diagnostic text and make the profile temporarily ineligible through existing backoff/circuit-break mechanisms.
- Add a no-secret LiteLLM example/gateway note only if implementation needs a fixture or developer doc. Do not commit local `litellm/config.yaml` or any API key.

Planned interface:

```ts
interface RuntimeProfileCreateRequest {
  agentSdkModelId?: string | null
}

interface RuntimeProfileUpdateRequest {
  agentSdkModelId?: string | null
  clearAgentSdkModelId?: boolean | null
}

interface RuntimeProfileRecord {
  agentSdkModelId?: string | null
}
```

Non-goals:

- No SPEC-7 profile selector or permission selector.
- No Unified Chat.
- No LiteLLM service manager.
- No provider-specific secret migration beyond the runtime profile path.

Focused tests:

- `cargo test agent_run_profile --manifest-path src-tauri/Cargo.toml`
- `cargo test runtime_profile --manifest-path src-tauri/Cargo.toml`
- `cargo test profile_pool --manifest-path src-tauri/Cargo.toml`
- `pnpm exec vitest run src/lib/agent/agent-transport.test.ts src/components/settings/sections/model-profiles-section.test.tsx`

Required cases:

- `agentSdkModelId` is persisted and used for Agent SDK model invocation.
- missing `agentSdkModelId` falls back to current `modelId` only when the profile explicitly has no SDK alias.
- bearer auth does not populate `ANTHROPIC_API_KEY`.
- x-api-key/api-key auth does not populate `ANTHROPIC_AUTH_TOKEN`.
- sidecar request/env tests assert the SDK model contract explicitly: `agentSdkModelId` is passed as the sidecar `model` option and, where the SDK env path is used, `ANTHROPIC_MODEL` or the repo's chosen equivalent is populated with the same SDK model id.
- SDK rejected is recorded as bounded diagnostic without secret leakage.
- profile pool excludes fresh SDK-rejected profiles until backoff/circuit state clears.
- existing legacy Agent path remains available when work runtime is disabled.

## Gate Plan

For each implementation PR:

- Start with `git status --short --branch`, `npx gitnexus status`, and the agent-loop stale active run guard.
- Create/bind the PR-specific GitHub issue before coding.
- Run GitNexus impact before editing symbols; HIGH/CRITICAL findings must be recorded before implementation continues.
- Architect: Claude ACP first after provider/model preflight; fallback ZCode, then Kimi/internal. Timeout `600000`.
- Coder/focused tests.
- Simplicity:
  - PR1 and PR3 use ZCode read-only simplicity reviewer because they touch Rust DB/shared runtime/sidecar behavior.
  - PR2 may use internal Simplifier unless Settings state churn expands; external focused recheck still uses `600000` if used.
- Tester: Kimi static/focused packet; fallback internal Tester.
- Reviewer: ZCode external reviewer plus internal Reviewer.
- If any P0/P1/P2 appears, fix in the same PR and run focused recheck.
- If any scoped P3 appears, fix in the same PR unless classified as non-actionable or risk-increasing.
- Before commit, stage intentionally and run `npx gitnexus detect-changes --repo llm_wiki --scope staged`.
- PR body/comment must record final changed files/symbols, risk level, affected flows/processes, and why any HIGH/CRITICAL scope is expected and covered.
- Merge readiness requires focused/full verification, staged GitNexus detect, findings gate, and CI green in that order unless a PR-level plan documents a narrower docs-only exception.

## Docs-Only Planning PR Verification

This document's own PR is docs-only:

- no symbol impact is required;
- Simplicity Gate may be skipped with reason `docs-only roadmap/spec execution plan`;
- Tester and Reviewer still run as read-only gates; because this is docs-only roadmap planning, internal read-only gates are acceptable unless the PR owner escalates.

Required checks for this docs-only planning PR:

```bash
rg "SPEC-4-FIX|runtime_profile_delete|agentSdkModelId|Model Profiles|ANTHROPIC_AUTH_TOKEN|LiteLLM" docs/plans
rg -n "SPEC-4-FIX|remaining-prs-implementation-plan" docs/plans/README.md docs/plans/SPEC-4-FIX/remaining-prs-implementation-plan.md
git diff --check
npx gitnexus detect-changes --repo llm_wiki --scope staged
```

## Expected PR Metadata

Docs planning PR:

- branch: `codex/spec-4-fix-execution-plan`
- commit: `docs: add SPEC-4-FIX execution plan`
- title: `docs: add SPEC-4-FIX execution plan`
- body note: `Simplicity Gate skipped: docs-only roadmap/spec execution plan`

Implementation PR titles:

- `feat: add runtime profile deletion`
- `feat: move model profiles to settings category`
- `feat: add agent profile compatibility fields`
