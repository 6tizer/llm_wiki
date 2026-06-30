# SPEC-4 PR3 Plan: Capability Probe

> Type: PR execution plan | Status: in progress | Owner: Commander | Branch: `codex/spec-4-pr3-capability-probe` | Primary issue: #185 | Refs: #186 | Run: `6abcc134-1134-467d-a5f6-b1aebce2eb47`

## Goal

Replace PR2's draft-only smoke test with a real profile capability probe that can verify stored profiles without exposing stored secrets to the frontend.

PR3 must produce cached, scheduler-readable capability facts for later PR4/PR5 routing.

## Scope

Deliverables:

- Add a Rust-side profile probe command, tentatively `runtime_profile_probe`.
- Resolve stored profile secrets inside Rust using `read_profile_secret`; do not add a public secret read command.
- Support stored profile probes by `profileId`.
- Support draft probes with a one-request raw secret when the selected auth style requires a secret; no-auth/local CLI draft probes must not persist or return any secret.
- Persist cache updates for stored profiles through existing capability fields.
- Replace `ModelProfilesSection` PR2 smoke buttons with probe UI and cached status/backoff/error display.
- Invalidate cached capability when profile probe inputs change: endpoint, model, API mode, auth style, or secret reference.
- Add mock-provider tests for success, messages-only, streaming failure, tool-use failure, auth failure, and backoff.

## Non-Goals

- No scheduler pool / worker assignment.
- No Agent-run sidecar env injection.
- No global provider setting mutation.
- No profile table physical column changes.
- No automatic probe on render or scheduler tick.
- No frontend command that reads stored secret values.

## Current Facts

- `runtime_model_profiles` already stores capability status JSON/version/checked/backoff/error.
- `runtime_profile_update_for_project` preserves existing capability fields unless explicitly updated.
- `profile_secrets.rs` exposes internal `read_profile_secret` and public write/delete commands.
- `src/lib/llm-providers.ts` has TS-only helpers for Anthropic URL/auth/body/stream parsing; PR3 should duplicate only the minimum Rust probe logic needed to keep stored secrets out of the webview.
- `src-tauri/Cargo.toml` already includes `reqwest`.
- Rust has no existing HTTP fake transport pattern; PR3 will use a dev-only mock HTTP server rather than introducing a one-call trait abstraction.
- Settings currently uses `smokeConfigFromDraft`, `testLlmConnection`, and `testLlmFunction`; these are draft raw-secret smoke paths and should not become stored-secret certification.

## Planned Interface

TS wrapper:

```ts
interface RuntimeProfileProbeRequest {
  profileId?: string | null
  draft?: {
    kind: RuntimeProfileKind
    providerId: string
    modelId: string
    endpoint?: string | null
    apiMode: RuntimeProfileApiMode
    authStyle: RuntimeProfileAuthStyle
  } | null
  rawSecret?: string | null
  force?: boolean | null
}
```

Request invariants:

- Exactly one of `profileId` or `draft` must be present.
- Stored probes require an existing profile with non-empty `secretRef`; Rust resolves the secret internally through `read_profile_secret`.
- Draft probes require a non-empty one-request `rawSecret` only for `bearer`, `x-api-key`, or `api-key`; no-auth/local CLI draft probe results are not persisted.

Result:

```ts
interface RuntimeProfileProbeResult {
  profile?: RuntimeProfileRecord | null
  status: RuntimeProfileCapabilityStatus
  capabilityJson: string
  capabilityVersion: string
  checkedAtMs: number
  backoffUntilMs?: number | null
  message: string
}
```

Cache behavior:

- Stored probe writes `capability_status`, `capability_json`, `capability_version`, `capability_checked_at_ms`, `probe_backoff_until_ms`, and `last_capability_error`.
- Draft probe returns a result but does not write cache.
- `force` bypasses existing backoff for explicit user re-test.
- Non-forced probe during backoff returns cached status and message without network work only when `capability_version == "profile-probe.v1"`.
- Stored profiles with `capability_version != "profile-probe.v1"` are treated as cache misses; PR3 ignores any old backoff once and performs a user-triggered probe so PR4 never reads `spec-4-pr1` as fresh capability data.
- Successful stored probes clear `probe_backoff_until_ms` and `last_capability_error`; failed probes set a bounded error and retry backoff.

Capability JSON shape is versioned by `profile-probe.v1` and should include:

- protocol checks: `messages`, `streaming`, `toolUse`, `systemPrompt`;
- model-call support;
- agent-run support;
- auth style used;
- endpoint URL kind, redacted;
- thinking behavior: `disabled`, `supported`, `unknown`, or `unsupported`;
- token counting: `available`, `unavailable`, or `unknown`;
- context/max output facts if known from profile/preset/probe;
- Claude Agent SDK compatibility as static PR3 facts only: `agentRunSupported` is inferred from Anthropic Messages mode plus streaming and tool-use probe success; context-management/checkpointing/beta-header details stay `unknown` placeholders for PR5 sidecar preflight and are not network-probed in PR3.

`RuntimeProfileProbeResult.status` must use the existing enum values only: `unknown`, `supported`, `limited`, `unsupported`, or `error`.

`capability_version` will move stored probe payloads to `profile-probe.v1`. Existing `spec-4-pr1` rows are treated as old-format cache misses on the PR3 read path, including when they have stale backoff values.

Rust probe logic boundary:

- Auth headers are built only from the stored profile `authStyle`; Rust must not duplicate the TypeScript `requiresBearerAuth` host whitelist.
- URL normalization must preserve the TypeScript `buildAnthropicUrl` cases needed by the probe: existing `/messages` URL, existing `/v\\d+` base, and default append of `/v1/messages`. Add a comment pointing to the TypeScript provider helper as the UI-side source.
- Request bodies stay minimal: one non-streaming messages probe, one streaming probe when needed, and one single-tool probe when needed. Do not copy reasoning/thinking budget mapping from `llm-providers.ts`.
- Tests should inject `reqwest::Client` and point the profile endpoint at a local mock server. Add a dev-dependency such as `wiremock` for deterministic success/auth/stream/tool/backoff tests; do not add a bespoke one-call transport trait.
- PR3 also aligns the TS wrapper with Rust by exposing `clearLastCapabilityError?: boolean` on profile update requests.

## Implementation Order

1. Run Architect gate on this plan; Claude may be re-probed after 2026-07-01 02:00 CST, otherwise use ZCode/Kimi/internal fallback.
2. Add Rust probe request/result types and minimal pure helpers for URL normalization, auth headers from persisted `authStyle`, body construction, SSE classification, capability status mapping, and bounded error text.
3. Add stored profile resolution that reads profile metadata and `secretRef` internally.
4. Add network probe functions that accept a `reqwest::Client`; add a dev-only mock HTTP server dependency for deterministic tests instead of inventing a custom transport trait.
5. Persist stored probe results by reusing runtime profile capability fields.
6. Add TS wrapper and wrapper tests, including `clearLastCapabilityError`.
7. Replace Settings profile smoke UI with probe actions and cached status display.
8. Add UI tests for saved profile probe, draft raw-secret probe, backoff display, cache invalidation after metadata edits, and no secret read command.
9. Run focused tests, Simplicity Gate, Tester Gate, Reviewer Gate.
10. Fix every P0/P1/P2/P3 found in this PR, then run final verification and publish PR.

## GitNexus Impact Summary

Pre-edit checks already run:

- `runtime_profile_update_for_project`: LOW, direct callers are profile update command and profile tests.
- `runtime_profile_status_for_project`: LOW, direct callers are status command and profile round-trip test.
- `ModelProfilesSection`: LOW, affects Settings LLM section and profile UI tests.
- `read_profile_secret`: LOW, no current upstream callers.
- `src-tauri/src/lib.rs:run` command registration was identified through query/context and must be covered by command wrapper/Rust compile tests.

Risk notes:

- Any edit to profile cache invalidation must preserve clear flag behavior from PR1/PR2.
- Any new probe command must keep stored secret values out of command responses, logs, docs, tests, and PR comments.

## Gate Plan

- Architect: Claude ACP if available after provider/model preflight; fallback ZCode, then Kimi/internal. Timeout `600000`.
- Simplicity: ZCode read-only simplicity reviewer because this PR touches Rust runtime, HTTP probing, and UI state. Fallback internal Simplifier. Timeout `600000`.
- Tester: Kimi static packet; fallback internal Tester. Timeout `600000`.
- Reviewer: ZCode external reviewer plus internal Reviewer. Timeout `600000`.
- Merge standard: no unresolved P0/P1/P2, all scoped P3 fixed, CI green.

## Test Plan

Focused:

- `cargo test profile_probe --manifest-path src-tauri/Cargo.toml`
- `cargo test runtime_db --manifest-path src-tauri/Cargo.toml`
- `pnpm exec vitest run src/commands/runtime-db.test.ts src/components/settings/sections/model-profiles-section.test.tsx`

Rust probe tests will use a local mock HTTP server to cover success, messages-only limited support, streaming failure, tool-use failure, auth failure, and backoff without real provider calls.

Required before PR:

- `pnpm lint`
- `git diff --check`
- `npx gitnexus detect-changes --repo llm_wiki --scope staged`

Broader if registration or runtime risk expands:

- `cargo test --manifest-path src-tauri/Cargo.toml`
- `pnpm test`

## Expected PR Metadata

- PR title: `feat: add model profile capability probe`
- Commit message: `feat: add model profile capability probe`
- PR body must include:
  - run id;
  - scope/non-goals;
  - GitNexus impact/detect summary;
  - secret handling guarantee;
  - probe cache/backoff behavior;
  - focused tests and lint results;
  - Simplicity/Tester/Reviewer reports;
  - `Refs #185`.
