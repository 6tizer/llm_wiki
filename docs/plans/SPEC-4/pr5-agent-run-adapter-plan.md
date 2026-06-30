# SPEC-4 PR5 Plan: Agent-run Adapter

> Type: implementation plan | Status: merged | Owner: Commander | Completed by PR #221 at `285214c feat: wire agent runs to runtime profiles` | Run: `bc558559-9178-4dda-ad0e-dccaa5701cdf`

## Decision

Implement the Agent-run profile adapter as the final SPEC-4 PR. The Agent sidecar should run from a claimed `agent-run` profile, resolve stored secrets only inside Rust, inject per-run SDK environment/config, and leave global provider settings untouched.

Completion: PR #221 merged this scope at `285214c`. CI, focused gates, full verification, staged GitNexus detect, post-merge `npx gitnexus analyze`, and agent-loop stop all passed.

Merge standard:

- no unresolved P0/P1/P2;
- fix every scoped P3 found by this PR's gates in this PR;
- CI green;
- Commander may merge once gate findings and CI are clean.

## Scope

- Add an Agent transport option for profile-backed runs. The frontend passes a non-secret profile reference/claim result, never a stored secret value.
- Claim an eligible profile through the PR4 profile pool before spawning the sidecar:
  - `kind = "agent-run"`;
  - `taskFamily = "agent"`;
  - holder tied to the Agent stream/run;
  - bounded TTL.
- Release the profile claim on success, sidecar error, invoke failure, and abort/kill.
- Add a profile-claim renewal path so long Agent runs do not outlive the pool claim TTL:
  - keep the initial claim TTL bounded by the existing pool constants;
  - renew active claims while the Rust sidecar reader task is alive;
  - release once the reader task reaches its terminal cleanup block.
- Resolve the selected profile inside Rust before sidecar spawn:
  - require `kind = "agent-run"`;
  - require enabled profile and fresh `profile-probe.v1` capability cache;
  - require `agentRunSupported === true`;
  - read `secretRef` through `SecretStore` only when the auth style requires a secret;
  - set request `model`, `baseUrl`, and per-run auth fields from the profile.
- Keep the sidecar protocol minimal. The sidecar can still receive `apiKey`, `baseUrl`, and `model` from Rust, but it must not receive `profileId` as a frontend-resolvable secret handle unless needed for non-secret diagnostics.
- Preserve model-call behavior and legacy Chat settings outside Agent-run.
- Preserve today's legacy Agent path when work runtime is disabled. Runtime-enabled projects use the profile-claim route; runtime-disabled projects keep the existing global `llmConfig` route until a later migration PR removes it intentionally.

## Non-goals

- No Claude Agent SDK replacement.
- No SPEC-7 unified chat entrypoint.
- No default-profile Settings UI or migration of every legacy provider setting.
- No model-call worker pool from SPEC-5.
- No profile schema evolution unless Architect explicitly blocks without it.
- No frontend command that reads profile secrets.

## Data Flow

1. Chat Agent send creates a stream id.
2. Agent transport checks whether runtime/profile pool is enabled.
3. If runtime is disabled, transport uses the existing legacy global-config Agent path.
4. If runtime is enabled, transport claims a profile from `runtimeProfilePoolClaim`.
5. Transport passes `agentProfileId` and `agentProfileClaimId` to `agent_spawn`.
6. Rust validates the profile against runtime DB facts and reads the secret internally when needed.
7. Rust builds the sidecar JSON request with only runtime-ready options: model, base URL, and auth material.
8. Rust starts claim renewal while the sidecar reader task is alive.
9. Sidecar maps runtime-ready options into per-process env/config for the Claude Agent SDK.
10. Rust releases the profile claim in the same terminal cleanup block that revokes the internal API token.
11. TypeScript releases only when the claim was created but `agent_spawn` never successfully hands ownership to Rust.
12. Duplicate or expired release errors such as `claim-inactive` are treated as terminal-safe cleanup results, not user-facing run failures.

## Architect Questions

Claude ACP Architect Gate session `0b06718a-3e04-4608-a25c-a6e4f30e8d8e` returned `BLOCK` on the initial plan. Required plan fixes are applied here:

- Runtime-disabled behavior: preserve the current legacy Agent path when runtime/profile pool is disabled; use the profile route only when runtime is enabled.
- Claim TTL: add profile-claim renewal for long Agent runs. Do not rely on a single bounded TTL.
- Claim ownership: TypeScript may claim before spawn, but Rust owns renewal and terminal release after `agent_spawn` accepts the claim.
- Release idempotency: backend release can continue returning `claim-inactive`; callers must swallow duplicate/expired cleanup results.
- Error UX: add one typed `profile_unavailable` Agent error for no eligible profile, busy capacity, backoff, or circuit-open. Missing stored secret remains `missing_api_key`.
- Capability gate: rely on PR4 pool eligibility for `profile-probe.v1` and `agentRunSupported === true`; Rust resolver reasserts the support flag but does not reimplement provider/host eligibility.
- Rust helper: profile resolver must be generic over `SecretStore` so unit tests can use an in-memory store.

Focused Claude ACP recheck session `30e95be9-07e2-4722-851a-9d29c191a5a9` returned `PASS`. Follow-ups are coding-time checks only:

- choose a renewal cadence safely below claim TTL and add bounded retry for transient renewal failure;
- ensure the claim handoff from TypeScript to Rust has no gap where neither side releases;
- confirm `agentRunSupported` is populated by the merged PR3/PR4 path for claimable `agent-run` profiles.

## Implementation Route

1. Update PR5 planning/docs state and record Agent-loop evidence.
2. Run Architect Gate on this plan. Claude ACP first if provider/model preflight succeeds; fallback ZCode/Kimi/internal if Claude still fails. Timeout `600000`.
3. Apply plan fixes from Architect findings before coding.
4. Run GitNexus impact for each symbol before edits and record blast radius.
5. Implement transport claim/release:
   - extend `AgentTransportOptions` / invoke payload with non-secret profile claim fields;
   - detect runtime disabled and use the legacy path without claiming;
   - claim before `agent_spawn` when runtime is enabled;
   - release from TypeScript only if the claim never transfers to Rust;
   - treat duplicate/expired cleanup errors as safe cleanup results.
6. Implement Rust profile resolution:
   - add non-Tauri helper with tests;
   - wire `agent_spawn` to resolve profile config before `build_agent_request`;
   - start profile-claim renewal after the sidecar is accepted;
   - release the profile claim in the reader task terminal cleanup block;
   - keep log redaction for URLs and never log secrets.
7. Implement a narrow profile-claim renew helper/API without schema changes:
   - renew only active, unreleased claims;
   - bound renewed TTL with the existing pool constants;
   - test active renew, released/inactive reject, and expired behavior.
8. Update sidecar types/tests only if request shape changes; otherwise leave sidecar env behavior unchanged.
9. Update preflight/error UX for typed `profile_unavailable`.
10. Run focused tests before Simplicity Gate.
11. Run Simplicity Gate, Tester Gate, and Reviewer Gate. Fix all P0/P1/P2 and scoped P3, then re-run focused tests and focused rechecks.
12. Run full verification and open PR.

## GitNexus Impact Evidence

Initial PR5 planning impact checks already run:

- `agent_spawn`: LOW.
- `build_agent_request`: MEDIUM; sidecar request serialization tests required.
- `buildAgentTransportOptionsFromState`: LOW; affects Agent send option construction.
- `getAgentPreflightError`: LOW; affects Agent send preflight.
- `agentProviderNeedsApiKey`: LOW; affects preflight and tests.
- `runtime_profile_status_for_project`: LOW; candidate helper dependency.
- `read_profile_secret`: LOW; secret read stays Rust-only.
- `runtime_job_claim_for_project`: CRITICAL from prior SPEC-4 research; PR5 must not edit job-lease semantics.

If implementation touches additional symbols, run fresh impact first.

## Test Plan

Focused tests:

- `pnpm exec vitest run src/lib/agent/agent-transport.test.ts`
- `pnpm exec vitest run src/components/chat/agent-transport-options.test.ts`
- `pnpm exec vitest run src/lib/agent/agent-run-state.test.ts`
- `cargo test --manifest-path src-tauri/Cargo.toml agent_`
- `cargo test --manifest-path src-tauri/Cargo.toml runtime_profile`

Required focused cases:

- runtime disabled preserves the legacy global-config Agent path and does not claim a profile;
- runtime enabled claims an `agent-run` / `agent` profile before spawn;
- no eligible profile, capacity exhausted, backoff, and circuit-open map to `profile_unavailable`;
- missing stored secret maps to `missing_api_key`;
- claim renewal extends a live Agent run before TTL expiry;
- expired/released claim renewal is rejected without corrupting the run;
- Rust releases the claim on clean exit, sidecar error, and abort/kill;
- duplicate or expired release cleanup is swallowed as terminal-safe cleanup;
- TypeScript releases if `agent_spawn` fails before Rust accepts ownership;
- resolver rejects non-agent-run or non-Agent-capable profiles without exposing secrets.

Full verification before PR:

- `pnpm lint`
- `pnpm test`
- `cargo test --manifest-path src-tauri/Cargo.toml`
- `git diff --check`
- `npx gitnexus detect-changes --repo llm_wiki --scope staged`

## Gate Plan

- Architect: Claude ACP read-only gate if provider/model preflight succeeds; fallback ZCode, then Kimi/internal. Timeout `600000`.
- Coder: implement only after Architect has no blocking findings.
- Simplicity: required. Use ZCode read-only simplicity reviewer because PR5 touches Rust DB/runtime, sidecar adapter, and Agent transport state. Timeout `600000`.
- Tester: Kimi static/focused packet; fallback ZCode/internal.
- Reviewer: ZCode external reviewer plus internal reviewer.

Gate output must use:

```text
PASS | BLOCK | WARN
P0:
P1:
P2:
P3:
follow-up:
non-actionable:
```

## Risks

- Profile pool depends on work runtime being enabled. PR5 must preserve the legacy Agent path when runtime is disabled, otherwise default installs would regress.
- Profile claims have bounded TTL. PR5 must add renewal or long Agent runs can oversubscribe profile capacity after expiry.
- Secret handling crosses Rust to sidecar process. Stored secrets must never enter frontend state, logs, PR comments, tests, or docs.
- Claim release must be Rust-owned after spawn acceptance and robust on abort, sidecar failure, duplicate release, and expired release cleanup.
- Adding helper APIs in `runtime_db.rs` risks broad shared-runtime churn; keep helper narrow and heavily tested.
