# SPEC-2 PR4 Plan: Commit-Path Concurrency Budget

> Type: PR execution plan | Status: in progress | Owner: Commander | Issue: #184 | Branch: `codex/spec-2-pr4-concurrency-budget`

## Scope

PR4 adds the SPEC-2 `resource-budgets` runtime ledger needed by SPEC-3 commit-path serialization and later worker scheduling.

Deliverables:

- Add portable SQLite schema for commit-path resource budgets and active claims.
- Add forward migration bookkeeping for the `resource-budgets` schema family.
- Add Rust runtime operations for:
  - claim a commit-path budget for one logical affected Markdown path;
  - release an active claim;
  - expire an active claim whose TTL has passed;
  - snapshot-list budget state for tests and shell-neutral inspection.
- Enforce per-path serial commit budget: one active claim per normalized affected path.
- Enforce a total commit budget: cross-path active commit claims must not exceed a conservative default until a later config surface exists.
- Keep all PR4 runtime writes under the existing process-local single-writer guard.
- Keep public command boundaries shell-neutral and project-scoped through `ProjectRootState` only.
- Update `docs/plans/README.md` to mark PR3 merged and PR4 in progress.

## Non-Goals

- No SPEC-3 Markdown commit operation.
- No final Markdown file writes.
- No staging artifact table or artifact GC.
- No event/progress table.
- No worker pool or scheduler loop.
- No UI wiring.
- No generic workflow engine.
- No cross-process SQLite lock. PR4 continues the PR3 process-local writer guard boundary.
- No config UI for budget capacities. Defaults are hard-coded until a later config/profile PR.

## PR1-PR3 Constraints

- `runtime.db` lives at `<project>/.llm-wiki/runtime/runtime.db`.
- Runtime remains disabled by default via `core.workRuntime.enabled` / `LLM_WIKI_CORE_WORK_RUNTIME_ENABLED` adapter flag.
- Disabled means no directory creation, no DB open, no migration, and no budget mutation.
- Public commands must not accept arbitrary project roots or filesystem paths.
- Logical affected paths are resource identities, not write targets. They must be relative, normalized, traversal-free, and Markdown-scoped before they become budget keys.
- SQLite schema must use portable SQLite storage classes and constraints only.
- Markdown remains committed truth. `runtime.db` stores runtime coordination metadata only.
- All writes go through the existing `with_runtime_writer` single-writer guard.
- Snapshot reads may use short read transactions and must not migrate a PR3-only DB.

## Proposed Schema

Preferred module:

- `src-tauri/src/commands/runtime_db.rs`

### `runtime_resource_budgets`

Portable columns:

- `scope TEXT NOT NULL CHECK (scope IN ('commit-total', 'commit-path'))`
- `resource_key TEXT NOT NULL`
- `display_key TEXT NOT NULL`
- `capacity INTEGER NOT NULL CHECK (capacity >= 1)`
- `created_at_ms INTEGER NOT NULL`
- `updated_at_ms INTEGER NOT NULL`
- `PRIMARY KEY(scope, resource_key)`

Initial keys:

- `('commit-total', '*')` with default capacity `2`, inserted by the PR4 migration with `INSERT OR IGNORE`.
- `('commit-path', <normalized affected path key>)` with capacity `1`, created lazily on first claim.

The default total capacity is a placeholder until a SPEC-2 config/profile surface lands, not a product SLA. SPEC-3 / SPEC-5 must re-check this capacity before wiring real worker pool concurrency.

### Normalized Path Key Algorithm

`affectedPath` produces two values:

- `display_key`: normalized for display and diagnostics, preserving case.
- `resource_key`: normalized for identity and budget uniqueness.

Algorithm:

- Replace `\` with `/`.
- Trim leading/trailing ASCII whitespace before normalization; reject if trim changes an internal empty path to empty.
- Reject empty paths, absolute paths, drive prefixes, root prefixes, empty segments, `.`, `..`, trailing slash, and non-`.md` suffixes.
- Accept `.md` suffix case-insensitively for caller tolerance, but store `resource_key` with lowercased identity. `a.MD` and `a.md` are the same resource key.
- Reject bare hidden-extension leaf names such as `a/.md`.
- Split on `/`.
- For `display_key`, join validated segments with `/`.
- For `resource_key`, normalize each segment with Unicode NFC and lowercase, then join with `/`.
- Rust implementation must use a real Unicode normalization helper such as `unicode-normalization`; do not approximate NFC with standard-library lowercase alone. If adding the crate is rejected during implementation review, drop NFC from PR4 explicitly rather than silently changing identity semantics.
- Do not parse identity from a `commit:path:` string prefix. Scope and `resource_key` columns are the identity; `budget_key`-style string prefixes are intentionally not used.
- The lowercase step is identity-only and does not depend on OS path collation. Stored `display_key` preserves caller casing for diagnostics.

The same normalized path identity must be reused by SPEC-3 derived marker `affected_path` planning so commit budget and derived invalidation do not define competing path identities.

Implementation anchor:

- PR4 must implement a single `normalize_affected_path` helper in the runtime layer and test it directly.
- PR4 claim logic must call that helper; SPEC-3 must reuse the same helper or a direct contract wrapper, not reimplement path identity.

### `runtime_resource_budget_claims`

Portable columns:

- `claim_id TEXT NOT NULL`
- `scope TEXT NOT NULL CHECK (scope IN ('commit-total', 'commit-path'))`
- `resource_key TEXT NOT NULL`
- `display_key TEXT NOT NULL`
- `job_id TEXT`
- `holder TEXT NOT NULL`
- `amount INTEGER NOT NULL CHECK (amount >= 1)`
- `acquired_at_ms INTEGER NOT NULL`
- `expires_at_ms INTEGER NOT NULL`
- `released_at_ms INTEGER`
- `status TEXT NOT NULL CHECK (status IN ('active', 'released', 'expired'))`
- `PRIMARY KEY(claim_id, scope, resource_key)`
- `FOREIGN KEY(scope, resource_key) REFERENCES runtime_resource_budgets(scope, resource_key)`
- `FOREIGN KEY(job_id) REFERENCES runtime_jobs(job_id)`

Indexes:

- `runtime_resource_claims_active_idx` on `(scope, resource_key, status, expires_at_ms)`.
- `runtime_commit_path_active_unique_idx` unique on `resource_key WHERE scope = 'commit-path' AND status = 'active'`.
- `runtime_resource_claims_claim_idx` on `(claim_id, status)`.
- `runtime_resource_claims_job_idx` on `(job_id, status)`.

Partial unique indexes are already used by PR3 and are accepted as part of the project's portable SQLite subset for the bundled SQLite version. PR4 tests must prove the DB-level unique index rejects a second active path claim.

Open design point for implementation:

- Use two active claim rows per successful commit-path claim: one against `('commit-total', '*')`, and one against `('commit-path', <resource_key>)`, tied by the same `claim_id`.
- Release / expire must update both rows atomically.

### Migration Family

- Keep `migrations`, `jobs`, and `leases` family versions unchanged.
- Add / advance `resource-budgets` family to version `1`.
- Migration must be idempotent and must not refresh `applied_at_ms` for already-applied versions.

## Operation Semantics

Public command candidates:

- `runtime_commit_budget_claim(request)`
- `runtime_commit_budget_release(request)`
- `runtime_commit_budget_list()`

Request shape:

- `claim`: `{ affectedPath, holder, jobId?, claimId?, ttlMs? }`
- `release`: `{ claimId }`
- `list`: no request payload

Rules:

- `affectedPath` must be a logical relative Markdown path:
  - non-empty;
  - normalize `\` to `/`;
  - reject absolute paths, drive prefixes, root prefixes, `.` / `..` traversal, empty segments, and non-`.md` suffixes;
  - preserve case in the stored display value but use a stable normalized key for budget identity.
- `holder` must be non-empty and should follow `<adapter-kind>:<instance-id>` when a caller has a durable worker identity. PR4 stores it as an opaque audit string and does not release by holder.
- `jobId` is optional because manual/test callers may reserve budget before a job exists. When supplied, it must reference `runtime_jobs(job_id)` and missing jobs must be rejected.
- `ttlMs` defaults to the PR3 lease TTL (`120000` ms). Values below `1000` ms or above `1200000` ms are rejected as `invalid-ttl`.
- `ttlMs` arithmetic must reject overflow before computing `expires_at_ms = now + ttlMs`.
- Caller-supplied `claimId` must be globally unique for active and historical claims. Duplicate `claimId` is not idempotent and must return typed `claim-id-conflict` without mutating budgets.
- Budget write initialization must first initialize the PR2 base runtime DB and PR3 `jobs` / `leases` schema, then initialize `resource-budgets`. In implementation terms, PR4 write open should reuse or wrap `open_job_runtime_locked` before creating budget tables so `job_id` FK parents exist on PR2-only upgrades.
- `claim` must run inside `with_runtime_writer` and one SQLite transaction. It creates/ensures `('commit-total', '*')` and `('commit-path', <resource_key>)` budgets, then atomically checks both:
  - active total amount + requested amount <= total capacity;
  - no active claim exists for the normalized path.
- `claim` succeeds by inserting both active claim rows with one `claim_id`.
- Capacity checks and both inserts must happen in one writer transaction. The implementation should use guarded `INSERT ... SELECT ... WHERE` or an equivalent transaction-local check so total exhaustion rolls back the path claim and leaves no partial active row.
- The transaction must include budget ensure, capacity check, path active check, both inserts, and readback. Any failure rolls back the whole claim.
- `claim` returns typed errors for:
  - runtime disabled;
  - no open project;
  - invalid affected path;
  - total budget exhausted;
  - path already claimed;
  - unknown job id when `jobId` is supplied.
- `release` only releases active claim rows with the same `claim_id`; repeated release should be rejected as inactive, not silently succeed.
- `release` must run in one writer transaction and first verify the active row set is exactly two rows whose scopes are `{commit-total, commit-path}`. It must update exactly two rows or rollback with `claim-inactive` / `claim-inconsistent`.
- `expire` is an internal helper only. It marks both active claim rows `expired` after `expires_at_ms <= now`.
- `expire` follows the same exact-two-row invariant as release and must rollback if the claim is partial or inconsistent.
- `list` is a snapshot read and must not create tables or migration rows on PR3-only DBs.
- `list` returns active claims by default plus budget rows; PR4 does not add `includeHistory`.

## Contract Surface For SPEC-3

PR4 does not implement SPEC-3 commit semantics, but it defines the budget lifecycle SPEC-3 should consume:

- claim success means SPEC-3 owns path-serial commit capacity for `affectedPath`;
- commit success releases the claim;
- commit conflict or validation failure releases the claim and records conflict/failure in SPEC-3 event/artifact state, not in PR4 budget state;
- worker crash or abandoned claim is recovered by a later scheduler through `expire`;
- PR4 does not add a separate budget cancel operation.

## Tauri Boundary

Public commands may only read project root from `ProjectRootState`.

They may accept logical affected paths, but these paths are resource identities only:

- no arbitrary project root;
- no absolute path;
- no file write;
- no canonicalization requirement against an existing file;
- no React/Zustand/plugin-store dependency.

## Tests / Verification

Focused Rust tests:

- disabled claim does not touch disk;
- enabled no-project claim returns `no-project`;
- PR3-only DB list returns empty without migration;
- PR2-only DB claim upgrades `migrations`, `jobs`, `leases`, and `resource-budgets` before enforcing `jobId` FK;
- migration creates budgets/claims tables and preserves migration timestamps;
- existing `resource-budgets` version `2` is not downgraded and does not refresh `applied_at_ms`;
- claim creates total + path budgets and two active claim rows;
- duplicate caller-supplied `claimId` returns `claim-id-conflict`;
- same path cannot be claimed twice;
- case-only variants of the same path cannot be claimed twice;
- different paths can be claimed until total capacity is exhausted;
- total exhaustion rolls back atomically and leaves no active path row;
- release frees both total and path claims;
- release / expire reject inconsistent claim sets that do not contain exactly total + path active rows;
- expire sets both total and path rows to `expired` when `expires_at_ms <= now`;
- expired claim cannot be released and expired path can be claimed again;
- `ttlMs` default and min/max bounds are enforced;
- TTL overflow is rejected before `expires_at_ms` calculation;
- invalid paths are rejected: absolute, `..`, empty, directory, non-Markdown, Windows prefix/root, `a//b.md`, `./a.md`, `C:\a.md`, `\a.md`, `/a.md`, `a/../b.md`, `a/.md`;
- `a.MD` is accepted and normalized to the same identity as `a.md`;
- supplied missing `jobId` is rejected by FK / typed check.
- disabled claim/release/list does not open damaged DBs or create directories;
- enabled no-project claim/release/list returns `no-project` / empty no-touch according to command semantics.

General verification:

- `cargo test runtime_db --manifest-path src-tauri/Cargo.toml`
- `pnpm lint`
- `git diff --check`
- `cargo build --release --manifest-path src-tauri/Cargo.toml`
- `npx gitnexus detect-changes --repo llm_wiki`

## Gate Plan

- Commander writes this PR plan at PR start.
- Architect gate reviews the plan before implementation.
- If Claude ACP is unavailable, use ZCode Architect; if ZCode fails, use internal Architect; if all external gates fail, Commander records failures and performs manual adversarial review before coding.
- Before code edits, run GitNexus impact on:
  - `runtime_db_health`
  - `runtime_job_list`
  - `run`
  - any contract constants if PR4 adds command/schema names to TypeScript contract metadata.
- After implementation, run Kimi Tester, ZCode Reviewer, internal Reviewer fallback, and GitNexus detect before commit.

## Known Risks

- Commit-path budget is easy to over-generalize into SPEC-3 commit semantics. PR4 must only reserve capacity, not decide merge/write/conflict behavior.
- Path identity must be stable and traversal-safe without treating logical paths as filesystem write authority.
- Total capacity must be enforced in the same writer transaction as path capacity; otherwise different-path claims can exceed the budget.
- Expiration without a scheduler remains helper-only in PR4, like PR3 lease-timeout. Later scheduler PR must scan expired claims.
- SPEC-3/SPEC-5 integration must revisit the placeholder total capacity and align it with the real worker pool before user-visible parallel commit is enabled.
- SPEC-5 implementation must explicitly re-check `commit-total` capacity against worker pool size before enabling bulk commit integration.
