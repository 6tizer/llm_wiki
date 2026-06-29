# SPEC-2 PR2 Plan: SQLite Init / Migration / Health Check

> Type: PR execution plan | Status: in progress | Owner: Commander | Issue: #184 | Run: `a8d8c88e-5393-432a-bb86-bb4e42cb2ac3`

## Branch

- `codex/spec-2-pr2-sqlite-init`

## Scope

PR2 turns the PR1 runtime hard gate into the first inert SQLite runtime substrate.

Deliverables:

- Add `rusqlite` with the `bundled` feature in `src-tauri/Cargo.toml`.
- Add a Rust runtime DB module under the Tauri backend that can:
  - resolve project-scoped path `<project>/.llm-wiki/runtime/runtime.db`;
  - honor the first-version kill switch default-off behavior;
  - create the runtime metadata directory only when enabled;
  - open SQLite with WAL enabled;
  - initialize a migrations bookkeeping table;
  - return a shell-neutral health/status payload.
- Register a Tauri command for runtime DB health/status.
- Add a thin TypeScript command wrapper only if needed for shell-neutral API visibility.
- Submit updated `Cargo.lock` with the dependency change.
- Update `docs/plans/README.md` to mark PR1 merged and PR2 in progress.

## Non-Goals

- No jobs table.
- No leases table.
- No events/progress table.
- No staging artifact table.
- No resource budget table.
- No job claim / heartbeat / retry / cancel behavior.
- No runtime scheduler.
- No production migration of `src/lib/ingest-queue.ts`.
- No replacement of file-sync JSON queue.
- No UI wiring.

## PR1 ADR Constraints

- `runtime.db` lives at `<project>/.llm-wiki/runtime/runtime.db`.
- The first-version feature flag is `core.workRuntime.enabled` and defaults to disabled.
- Disabled means: do not create directories, do not open `runtime.db`, do not migrate existing DBs.
- Enabled means PR2 may create/open only runtime metadata and migrations bookkeeping.
- SQLite schema must stay portable: standard SQLite storage classes and constraints only.
- `runtime.db` is intermediate runtime metadata. Markdown remains committed truth.
- PR2 does not define the permanent config surface. Any process/env read is an adapter-only temporary source for the ADR flag, not a second source of truth.

## Implementation Design

### Rust Module

Preferred file:

- `src-tauri/src/commands/runtime_db.rs`

Responsibilities:

- Pure path helper:
  - input: project root path;
  - output: `<project>/.llm-wiki/runtime/runtime.db`.
- Feature flag parser:
  - pure parser input: explicit string/value supplied by the caller;
  - PR2 command adapter may read env var `LLM_WIKI_CORE_WORK_RUNTIME_ENABLED` as a temporary override for ADR flag `core.workRuntime.enabled`;
  - env var truthy: `1`, `true`, `yes`, `on`;
  - default: disabled.
  - tests must exercise the pure parser / explicit enabled state and must not depend on process-wide `set_env`.
- Health status command:
  - command docstring must state that enabled health is an idempotent initializer, not a read-only probe;
  - public command accepts no path/config override parameters and uses only `ProjectRootState`; explicit paths are limited to internal helpers/tests;
  - when disabled: return disabled status and do not touch disk;
  - when enabled but no project path/root: return no-project status and do not touch disk;
  - when enabled with project root: create runtime directory, open DB, set WAL, apply migration table, return healthy status.
  - WAL `-wal` / `-shm` sidecar files stay under `.llm-wiki/runtime/`, which is ignored by source-watch/file-sync.
- Migrations table:
  - `runtime_schema_migrations`;
  - columns: `family TEXT PRIMARY KEY`, `version INTEGER NOT NULL`, `applied_at_ms INTEGER NOT NULL`;
  - PR2 records the `migrations` family at version `1`;
  - no other schema families are implemented in PR2.
  - idempotency: if `migrations` already exists at version `1` or higher, health must not update `applied_at_ms`.
  - implementation preference: `INSERT ... ON CONFLICT DO NOTHING` or equivalent first-apply-only behavior.

### Tauri Command Boundary

- Register the command in `src-tauri/src/lib.rs`.
- Command must not depend on React/Zustand/webview lifecycle.
- Public command must use `ProjectRootState` only and must not accept arbitrary webview-supplied paths.
- Command must not expose direct `enabled` / `flag_value` override parameters; PR2 tests should use internal helpers for explicit enabled/disabled states.
- `ProjectRootState` fallback is only valid after `open_project` or `create_project` has set a root.
- If no `ProjectRootState` root is available, return no-project and do not attempt project discovery.
- Runtime directory creation must be strictly limited to `<root>/.llm-wiki/runtime/`.
- PR2 must not write or clear `ProjectRootState`, and must not modify `open_project` behavior.

### TypeScript Wrapper

Add only when PR2 includes a non-test TypeScript call site. Otherwise defer it to the first PR that actually needs a TS caller.

Preferred file:

- `src/commands/runtime-db.ts`

It should be a thin `invoke` wrapper and should not connect UI.

## Key Files / Symbols

- `docs/plans/SPEC-2/pr2-sqlite-init-plan.md`
- `docs/plans/README.md`
- `src-tauri/Cargo.toml`
- `src-tauri/Cargo.lock`
- `src-tauri/src/commands/mod.rs`
- `src-tauri/src/commands/runtime_db.rs`
- `src-tauri/src/lib.rs`
- optional: `src/commands/runtime-db.ts`

## GitNexus Impact Summary

- `ProjectRootState` struct/impl: LOW risk, 0 affected flows. PR2 intends read-only fallback use, not semantic changes.
- `open_project`: LOW risk, 0 affected flows. PR2 does not modify project-open behavior.
- Representative existing Tauri commands `clip_server_status` and `set_close_behavior`: LOW risk, 0 affected flows. PR2 only follows command registration pattern.
- New runtime DB module symbols will be introduced by this PR and covered by focused Rust tests.

No HIGH or CRITICAL impact found.

## Implementation Order

1. Write this PR plan.
2. Run Architect gate on scope and design.
3. Add `rusqlite` bundled dependency.
4. Add runtime DB Rust module with pure helpers and tests.
5. Register runtime health command.
6. Add optional TypeScript wrapper if needed.
7. Update README plan index status.
8. Run focused Rust tests and standard verification.
9. Run Tester / Reviewer gates.

## Test Plan

Focused Rust tests:

- kill switch disabled does not create `.llm-wiki/runtime` or `runtime.db`;
- enabled health creates runtime directory and DB;
- enabled health sets WAL;
- enabled health creates `runtime_schema_migrations`;
- enabled health is idempotent on an existing DB;
- enabled health called twice does not change `applied_at_ms` for the existing `migrations` row;
- enabled health preserves an existing `migrations` row at version `2` and does not refresh `applied_at_ms`;
- missing project path/root returns no-project and does not touch disk.
- disabled with an explicit project path and a pre-existing `runtime.db` returns disabled and does not open, write, or migrate that DB.
- disabled with fallback `ProjectRootState` already set still returns disabled and does not create/open/migrate runtime DB.
- command adapter flag resolution is covered by a pure helper test without using process-wide `set_env`.

Commands:

- `cargo test runtime_db --manifest-path src-tauri/Cargo.toml`
- `cargo build --release --manifest-path src-tauri/Cargo.toml`
- `pnpm lint`
- `git diff --check`
- `npx gitnexus detect-changes --repo llm_wiki`

Broader checks:

- Run `cargo test --manifest-path src-tauri/Cargo.toml` if focused Rust tests or command registration indicates broader Rust risk.
- Full `pnpm test` is not required unless gate feedback finds cross-UI behavior risk.

## Gate Plan

- Architect: Claude Code / ACP first; fallback ZCode; fallback internal Architect.
- Tester: Kimi ACP first; fallback internal Tester.
- Reviewer: ZCode read-only plus internal Reviewer.
- External wait window: 10 minutes by default. Timeout or incomplete output is not PASS.
- Merge standard: no unresolved P0/P1/P2.

## Expected PR Metadata

- PR title: `feat: initialize SPEC-2 runtime db`
- Commit message: `feat: initialize SPEC-2 runtime db`
- PR body must include:
  - run id;
  - scope / non-goals;
  - GitNexus impact and detect summaries;
  - Rust focused test results;
  - lint / diff check results;
  - Architect / Tester / Reviewer gate outcomes.
