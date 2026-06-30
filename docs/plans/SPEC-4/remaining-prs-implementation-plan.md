# SPEC-4 Remaining PRs Implementation Plan

> Type: execution plan | Status: active | Owner: Commander | Current branch: `codex/spec-4-pr3-capability-probe` | Current main: `500cb3c feat: add settings model profiles` | Run: `6abcc134-1134-467d-a5f6-b1aebce2eb47`

## Decision

Continue SPEC-4 as three implementation PRs:

1. PR3 Capability Probe.
2. PR4 Scheduler Profile Pool.
3. PR5 Agent-run Adapter.

Merge standard for every remaining PR:

- no unresolved P0/P1/P2;
- every scoped P3 found by that PR's gates is fixed in the same PR;
- CI is green;
- Commander may merge once the findings gate and CI gate both pass.

PR4 and PR5 must get their own detailed PR plans when each PR starts. This document records the researched route, boundaries, and cross-PR risks so the sequence stays stable.

## Current Facts

- PR1 merged via #217 at `4ca772e`; it added runtime profile schema, profile capability fields, and the internal `SecretStore` read path.
- PR2 merged via #218 at `500cb3c`; it added Settings profile management and secret write/delete boundaries.
- `runtime_model_profiles` already has `capability_status`, `capability_json`, `capability_version`, `capability_checked_at_ms`, `probe_backoff_until_ms`, and `last_capability_error`.
- `profile_secrets.rs` has `read_profile_secret`, but there is intentionally no frontend read command.
- Settings profile tests still use the PR2 raw-secret smoke path; the UI text explicitly says stored-secret probes arrive in PR3.
- Existing provider request construction is TypeScript in `llm-providers.ts`, but stored-profile probes must not read secrets back into the webview.
- `reqwest` is already available in `src-tauri/Cargo.toml`, so PR3 can implement a Rust-side network probe without adding a new HTTP dependency.
- Agent mode currently builds sidecar options from global `llmConfig` and forwards `model`, `apiKey`, and `baseUrl`; it does not carry `profileId`, `apiMode`, auth style, or cached capability.
- `runtime_resource_budgets` is commit-only today; its SQLite `CHECK` only allows `commit-total` and `commit-path`.
- `runtime_job_claim_for_project` is CRITICAL by GitNexus impact. PR4 must not change its semantics unless a later Architect gate explicitly accepts that risk.

## Cross-PR Guardrails

- Do not add profile table columns opportunistically. Use existing capability fields unless a dedicated schema-evolution PR is approved.
- Do not expose a profile secret read command to the frontend.
- Do not mutate global provider settings to run an Agent profile.
- Do not silently mark OpenAI/Gemini/native non-Anthropic endpoints as Agent-capable. They can be model-call capable, but Agent-run needs Anthropic Messages / Claude Agent SDK compatibility.
- Do not duplicate the TypeScript provider host whitelist in Rust. Stored-profile probes must use the persisted `authStyle`; provider host inference remains UI-side profile setup behavior.
- Do not auto-probe on Settings render or scheduler tick. Probes are user-triggered, cached, and subject to backoff.
- Do not fold PR4 scheduler work into PR3 probe UI, and do not fold PR5 sidecar injection into PR4 pool claims.

## PR3: Capability Probe

Status: current.

Detailed plan: [`pr3-capability-probe-plan.md`](./pr3-capability-probe-plan.md).

Scope:

- Add a Rust-side `runtime_profile_probe` command that resolves stored `profileId` secrets internally and returns only non-secret capability results.
- Allow an unsaved draft probe with a one-request raw secret when the auth style requires one; no-auth/local CLI drafts must not persist or echo any secret.
- Persist probe cache only for stored profiles.
- Replace Settings PR2 smoke buttons with probe actions and cached capability display.
- Reset stale cached capability when probe inputs change: endpoint, model, API mode, auth style, or secret reference.

Expected command behavior:

- Anthropic Messages profiles: test basic `/v1/messages`, streaming SSE, tool use, system prompt behavior, thinking disabled/known behavior, token counting availability when supported, context/max output facts, auth style, and Claude Agent SDK compatibility flags.
- OpenAI/Gemini/local-cli profiles: record model-call capability where supported, but mark Agent-run compatibility unsupported unless the profile exposes Anthropic Messages semantics.
- Network/auth failures set `capability_status = error` and a bounded `last_capability_error`; retry/backoff is stored.
- Messages-only success with failed streaming/tool use is `limited`, not Agent-run supported.
- PR3 does not network-probe Claude Agent SDK beta/context-management/checkpointing behavior. It records static `unknown` placeholders and leaves runtime SDK preflight to PR5.
- `capability_version != "profile-probe.v1"` is old-format cache and must be treated as a cache miss by PR3; PR4 should only trust cached capability facts written with `profile-probe.v1`.

PR3 non-goals:

- No scheduler profile selection.
- No runtime worker assignment.
- No Agent sidecar env/config injection.
- No migration from legacy `llmConfig` secrets.

## PR4: Scheduler Profile Pool

Status: next after PR3 merge.

Planned scope:

- Add a SPEC-2-owned profile usage/claim layer for model-call and agent-run profile capacity.
- Select only enabled profiles whose `kind`, `taskFamilies`, `profile-probe.v1` cached capability, and backoff state match the requested work.
- Enforce `maxConcurrency` with active profile claims.
- Record retry-after / circuit-break facts through profile status or profile usage records, without redefining the job ledger.
- Expose shell-neutral TS wrappers for profile pool claim/release/status.
- Add focused tests for capacity exhaustion, expired claims, retry-after/backoff, disabled profiles, unsupported capability, and concurrent claims.

PR4 hard boundary:

- Prefer new profile-pool claim APIs or composed helper commands.
- Do not modify `runtime_job_claim_for_project`; GitNexus marks it CRITICAL and it owns queued/running/paused/retry lease semantics.
- Do not expand commit-path `resource_budgets` CHECK in a drive-by way. If profile resource budgets must reuse that table, stop and split a schema-evolution plan first.

PR4 non-goals:

- No actual bulk ingest worker pool from SPEC-5.
- No Agent sidecar injection.
- No Settings UI overhaul beyond small read-only status if needed for verification.

## PR5: Agent-run Adapter

Status: after PR4 merge.

Planned scope:

- Add per-run Agent profile resolution: frontend passes `profileId` or a selected Agent-run profile reference, not raw secrets.
- Resolve `secretRef` in Rust before spawning the sidecar, then inject per-run `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`, and model without mutating global provider settings.
- Gate Agent runs on cached PR3 capability: no streaming/tool-use/SDK-compatible profile means Agent actions are disabled with a Settings repair path.
- Preserve legacy Chat/model-call behavior separately from Agent-run behavior.
- Keep sidecar protocol minimal: it can continue receiving `apiKey`, `baseUrl`, and `model` internally, but the webview should not receive stored secret values.
- Add tests around preflight, profile resolution, missing secret, unsupported profile, and sidecar request serialization.

PR5 non-goals:

- No replacement of Claude Agent SDK.
- No unified chat entrypoint from SPEC-7.
- No model-call worker pool from SPEC-5.
- No broad migration of all legacy provider settings unless a small compatibility shim is required.

## Gate Plan

For each remaining implementation PR:

- Architect: Claude ACP if provider/model preflight succeeds; otherwise ZCode/Kimi/internal fallback. External gate timeout is `600000`.
- Coder/focused tests.
- Simplicity: required. Use ZCode read-only simplicity reviewer for Rust DB, shared runtime, UI state machine, or sidecar changes; otherwise internal Simplifier. Timeout `600000` for external checks.
- Tester: Kimi static packet; fallback ZCode/internal.
- Reviewer: ZCode external reviewer plus internal reviewer.
- Any P0/P1/P2 blocks merge. Any scoped P3 must be fixed in the PR. Non-actionable or risk-increasing simplification candidates must be explicitly classified in the PR body/comment.

## Research Evidence

GitNexus impact checks from PR3 planning:

- `runtime_profile_update_for_project`: LOW, 4 impacted symbols.
- `runtime_profile_status_for_project`: LOW, 2 impacted symbols.
- `ModelProfilesSection`: LOW, Settings body/test surface.
- `read_profile_secret`: LOW, no current upstream callers.
- `buildAgentTransportOptionsFromState`: LOW, affects Agent send paths.
- `getAgentPreflightError`: LOW, affects Agent send paths.
- `initialize_resource_budget_schema`: LOW but broad commit-budget test surface.
- `runtime_job_claim_for_project`: CRITICAL; avoid semantic edits in PR4.
- `build_agent_request`: MEDIUM; sidecar request serialization tests are required in PR5.

Required final verification for each implementation PR:

- focused tests named in the PR plan;
- `pnpm lint`;
- `git diff --check`;
- `npx gitnexus detect-changes --repo llm_wiki --scope staged`;
- GitHub CI green before merge.
