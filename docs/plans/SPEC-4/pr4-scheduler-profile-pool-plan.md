# SPEC-4 PR4 Plan: Scheduler Profile Pool

> Type: execution plan | Status: in progress | Owner: Commander | Branch: `codex/spec-4-pr4-scheduler-profile-pool` | Main baseline: `9dff202 feat: add model profile capability probe` | Run: `a4d26b56-03df-49ae-a800-14d03223a2a2`

## Decision

Implement PR4 as an independent, shell-neutral profile pool API. The scheduler can claim and release profile capacity without mutating job lease semantics, global provider settings, or the commit-path budget schema.

## Scope

- Add profile pool commands:
  - `runtime_profile_pool_claim`
  - `runtime_profile_pool_release`
  - `runtime_profile_pool_list`
- Add a profile-pool schema family with:
  - `runtime_profile_claims`
  - `runtime_profile_circuit_breakers`
  - migration family constants `PROFILE_POOL_FAMILY` / `PROFILE_POOL_VERSION`, recorded through `record_migration_family`.
- Select only eligible profiles:
  - `enabled = true`
  - matching `kind`
  - matching `taskFamily`
  - `capability_version = "profile-probe.v1"`
  - `capability_status` is `supported` or `limited`
  - capability JSON supports the requested kind:
    - model-call requires `modelCallSupported = true`
    - agent-run requires `agentRunSupported = true`
    - parse is defensive: malformed JSON, missing keys, non-boolean keys, or `false` values make the profile ineligible, not a hard claim error;
    - trust the `capability_version` column, not the embedded JSON `version`, for `profile-probe.v1` gating.
  - profile probe backoff is empty or expired
  - circuit breaker is empty or expired
  - active claim count is below `maxConcurrency`
- Enforce concurrency through active profile claims, not through `runtime_jobs`.
- Support scheduler/user preference with optional `preferredProfileIds`; selection uses the request order first, then stable profile order.
- Record optional job linkage:
  - if `jobId` is supplied, verify the job exists;
  - write `profile-pool:claimed` / `profile-pool:released` by calling `insert_runtime_event_tx` directly with those event names;
  - no event/progress rows are written when `jobId` is absent;
  - upsert progress under `profile-pool:<claimId>` so one job may hold multiple profile claims without overwriting a single status row;
  - verify existing event/timeline readers do not assume event names are only `job-runtime:event-appended` or `job-runtime:progress-appended`.
- Release outcomes:
  - `success`: release claim and clear the profile circuit breaker.
  - `rate-limited`: release claim and set a breaker using bounded `retryAfterMs`.
  - `error`: release claim and set a breaker only when bounded `circuitOpenMs` is supplied.
- Claim/release invariants:
  - duplicate `claimId` is rejected before inserting;
  - releasing an unknown, expired, or already released claim returns `claim-inactive` and is not idempotent;
  - stale active claims are expired during claim-time sweep before capacity checks;
  - breaker rows are keyed by `profile_id`, updated by upsert, and bounded to one row per profile.
- Breaker duration invariants:
  - reject negative durations;
  - reject durations outside PR4 constants;
  - guard `now + duration` overflow;
  - bound/sanitize breaker reason text and never persist secrets.
- List returns active claims and circuit breakers for runtime observability; because list is read-only, it must not mutate expired active claims and must filter expired active rows out of the usable `activeClaims` list so observability is not misleading.
- `preferredProfileIds` edge behavior: duplicate, unknown, disabled, or otherwise ineligible preferred ids are skipped, not hard errors.
- Add TS wrappers and wrapper tests.

## Non-goals

- Do not modify `runtime_job_claim_for_project`.
- Do not change job table schema or queued/running/retry semantics.
- Do not reuse or expand `runtime_resource_budgets`; its CHECK remains commit-only.
- Do not start a worker pool or bulk ingest scheduler.
- Do not add Settings UI beyond existing profile visibility.
- Do not read or return stored secret values.
- Do not close #185 in PR4; PR5 must still answer Agent-run adapter and legacy config closure.

## Key Files / Symbols

- `src-tauri/src/commands/runtime_db.rs`
  - new profile pool request/response structs;
  - profile pool schema init/read helpers;
  - claim/release/list commands and internal helpers;
  - focused Rust tests.
- `src-tauri/src/lib.rs`
  - register new Tauri commands.
- `src/commands/runtime-db.ts`
  - TS request/response types and wrappers.
- `src/commands/runtime-db.test.ts`
  - wrapper payload tests.
- `docs/plans/README.md`
  - current execution status.
- `docs/plans/SPEC-4/remaining-prs-implementation-plan.md`
  - mark PR3 done and PR4 current.

## GitNexus Impact Summary

- `runtime_profile_list_for_project`: LOW, 3 direct callers/tests.
- `runtime_profile_update_for_project`: MEDIUM, 5 direct callers/tests.
- `initialize_profile_schema`: LOW, 16 upstream symbols, profile command/test surface.
- `src-tauri/src/lib.rs:run`: LOW candidate for command registration.
- `runtimeProfileList` / `runtimeEventAppend` TS wrappers: LOW, wrapper test only.
- `runtime_job_claim_for_project`: CRITICAL, 13 direct callers/tests and 6 affected flows. PR4 must not edit this symbol.

## Implementation Order

1. Add schema constants and profile pool request/response structs.
2. Add `open_profile_pool_runtime_locked`, initializing job/events/profile schemas plus new profile pool schema.
3. Implement claim selection:
   - normalize request fields;
   - expire stale active claims before selection;
   - filter profiles by kind/task/capability/backoff/circuit/capacity using defensive capability JSON parsing;
   - honor `preferredProfileIds`, skipping duplicates and ineligible ids;
   - reject duplicate claim ids;
   - insert one active claim;
   - optionally write event/progress for `jobId`.
4. Implement release:
   - validate active claim;
   - mark released;
   - classify outcome and update or clear circuit breaker;
   - optionally write event/progress with a claim-scoped progress key.
5. Implement list with no disk touch when runtime is disabled/no project/no profile-pool tables; avoid mutation and avoid showing expired active claims as usable capacity.
6. Register commands and add TS wrappers.
7. Add focused tests.
8. Run focused tests before Simplicity Gate.

## Test Plan

Focused Rust:

- `cargo test profile_pool --manifest-path src-tauri/Cargo.toml`
- Cases:
  - disabled/no project behavior does not touch disk;
  - claim chooses enabled eligible profile by preferred order;
  - claim rejects unknown/unsupported/stale capability profiles;
  - maxConcurrency blocks when active claims reach capacity;
  - expired active claims no longer consume capacity;
  - probe backoff blocks until expired;
  - release with `rate-limited` sets retry-after circuit breaker;
  - expired breaker no longer blocks claims, with documented breaker-with-TTL behavior;
  - successful release clears breaker;
  - job-linked claim/release writes runtime event and progress.
  - duplicate claim id is rejected;
  - unknown/already-released release returns `claim-inactive`;
  - no event/progress is written without `jobId`;
  - profile-pool migration family is recorded;
  - malformed or missing capability JSON support keys make a profile ineligible;
  - breaker durations reject negative/overflow values and enforce bounds;
  - duplicate/unknown/ineligible preferred ids are skipped.
  - list filters expired active claims out of the active-claims response without mutating them.

Focused TS:

- `pnpm exec vitest run src/commands/runtime-db.test.ts`
- Cases:
  - claim/release/list wrapper payloads use Rust camelCase names.

Final:

- `pnpm lint`
- `pnpm test`
- `cargo test --manifest-path src-tauri/Cargo.toml`
- `git diff --check`
- `npx gitnexus detect-changes --repo llm_wiki --scope staged`
- GitHub CI green.

## Gate Plan

- Architect: Claude ACP if available after preflight; otherwise ZCode fallback with `--timeout-ms 600000`. Initial Claude ACP gate returned WARN with one P2 and scoped P3 plan tightenings; after this plan update, run focused Architect recheck before coding.
- Coder: Commander inline Coder is allowed because edits are scoped to existing runtime DB command patterns, but CRITICAL job claim symbol remains untouched.
- Simplicity: ZCode read-only simplicity reviewer with `--timeout-ms 600000`, because PR4 changes Rust DB/shared runtime.
- Tester: Kimi static packet, fallback internal tester.
- Reviewer: ZCode external reviewer plus internal reviewer.
- Merge standard: no unresolved P0/P1/P2; every scoped P3 found by gates fixed in PR; CI green.

## PR Metadata

- Commit message: `feat: add profile pool scheduler claims`
- PR title: `feat: add profile pool scheduler claims`
- Issue: `Refs #185`

## Architect Gate Fixes

Claude ACP Architect Gate session `c4a6982e-1ead-41ce-b34c-d843e515c51e` returned WARN:

- P2 fixed in plan: capability JSON is parsed defensively; missing/malformed/non-boolean support facts are ineligible and not hard errors; version gating uses the DB column.
- P3 fixed in plan: profile-pool migration family, direct custom event names, claim-scoped progress key, duplicate claim id/release validation, bounded breaker durations/reasons, breaker-with-TTL wording, read-only list expiry filtering, preferred-id skip semantics, and focused test coverage.
- Focused recheck session `801d560f-24ef-4ca6-a6f6-388a236536b6` returned PASS. Its non-blocking notes were resolved by choosing "reject out-of-bounds breaker durations" and "filter expired active claims from the list response".
