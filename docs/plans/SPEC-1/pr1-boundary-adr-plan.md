# SPEC-1 PR1 Plan: Shell/Core Boundary ADR + Runtime Inventory

> Type: PR execution plan | Status: Architect PASS / implementation in progress | Owner: Commander | Branch: `codex/spec-1-pr1-boundary-adr-plan`

## Goal

Create the first implementation-ready SPEC-1 artifact set: an Architecture ADR, a shell/core module boundary map, a runtime command/event inventory, and a minimal headless contract skeleton that freezes the contract required by SPEC-2/3/4/9.

This PR is a gate PR. It must make later runtime work harder to accidentally couple to React, Zustand, Tauri plugin-store, or webview lifecycle.

## Non-goals

- Do not implement SQLite runtime ledger, scheduler, job API, markdown commit layer, provider profiles, parallel ingest, or Swift UI.
- Do not migrate existing ingest/chat/file-sync behavior.
- Do not change persisted app state, project runtime state, existing command behavior, or runtime schema.
- Do not commit `.agent-loop/`, `.agent/workflows/`, local logs, generated artifacts, or secrets.

## Planned Changes

- Add a SPEC-1 ADR under `docs/plans/SPEC-1/` that defines:
  - UI Shell: React/Tauri today, Swift/SwiftUI future.
  - Core Runtime: shell-agnostic product capability boundary.
  - Platform Adapter: filesystem, Keychain, window/tray, dialog, open-url, local server, process lifecycle.
  - Agent Adapter: Claude Agent SDK sidecar and future agent runtime integration.
  - Storage Boundary: Markdown vault as long-term user asset; runtime DB/indexes/derived artifacts as local intermediate or rebuildable state.
- PR1 ADR path: `docs/plans/SPEC-1/adr-shell-core-boundary.md`.
- Add a boundary map that classifies current modules:
  - `src/App.tsx` bootstrap side effects.
  - `src/lib/ingest-queue.ts` global queue/persistence/activity coupling.
  - `src/lib/project-store.ts` plugin-store/app-state coupling.
  - Component/lib direct Tauri `invoke()` call sites outside `src/commands/*.ts`.
  - `src-tauri/src/lib.rs` mixed shell/bootstrap/command registry ownership.
  - `src/commands/*.ts` ad hoc invoke wrappers.
  - Local server/sidecar/process modules: clip server, API server, MCP server, proxy, Claude/Codex CLI transports, and Agent SDK sidecar.
- Add storage boundary notes that explicitly lock `app-state.json` as a cross-language schema read by both TypeScript and Rust, including at least `language`, `closeBehavior`, `proxyConfig`, `apiConfig`, and `apiConfig.mcpEnabled`.
- Add runtime command/event inventory with frozen family names:
  - Project.
  - Job runtime.
  - Markdown commit.
  - Profiles.
  - Derived.
  - Search/vector.
  - File/platform.
  - Process/CLI.
  - Agent run.
  - Settings/status.
- Split inventory entries by command vs event, and give each family a minimal payload/error-model placeholder so PR2 contract tests have an assertion target. These placeholders are not normative runtime schema; SPEC-2 owns the detailed schema/state-machine contract.
- Add a minimal headless contract skeleton:
  - Contract root: `src/core-runtime/contract/`.
  - Test path: `src/core-runtime/contract/headless-contract.test.ts`.
  - Core contract interfaces/types must be stub/mock only and must not import React, Zustand stores, Tauri plugin APIs, plugin-store, or real runtime persistence.
  - A mock-shell test proves the contract can be imported and exercised without rendering React, opening a Tauri webview, touching runtime schema, or changing persisted state.
  - This skeleton is intentionally thin; PR2 adds static import enforcement and expands negative coverage.
- Add PR-level gate notes:
  - SPEC-2 PR1 may depend on this inventory for runtime schema/state-machine ADR.
  - SPEC-3/4 may only do integration after their needed SPEC-2 gates.
  - SPEC-9 Swift shell remains deferred until contracts graduate beyond frozen.
- Update `docs/plans/README.md` to record that per-PR execution plans live under `docs/plans/SPEC-N/`.

## Commander Workflow

1. Start facts:
   - `git status --short --branch`.
   - `gh pr list --repo 6tizer/llm_wiki --state open --limit 20`.
   - `npx gitnexus status`.
2. Draft PR1 plan and ADR artifacts.
3. Run Architect adversarial review:
   - Primary: Claude Code headless or ACP, read-only.
   - Fallback 1: ZCode read-only architect review.
   - Fallback 2: internal Architect subagent.
4. Commander revises the plan/ADR from accepted findings.
5. If code symbols/interfaces are added or touched for the headless skeleton, run GitNexus impact on nearby existing symbols before editing and record why new symbols have no upstream callers yet.
6. Stage ignored plan/docs files before validation and PR creation:
   - `git add -f docs/plans/SPEC-1/<file>.md` for the PR plan and new ADR files.
   - `git diff --cached --name-only` must show the new `docs/plans/SPEC-1/` files before commit.
7. Run validation and gate:
   - Focused docs grep/link sanity.
   - Headless contract skeleton test: `pnpm exec vitest run src/core-runtime/contract/headless-contract.test.ts`.
   - `pnpm lint`.
   - `git diff --check`.
   - `npx gitnexus detect-changes --repo llm_wiki`.
   - Tester gate: Kimi ACP first, internal Tester fallback. Timeout or incomplete report is WARN/BLOCK, never PASS.
   - Reviewer gate: ZCode external reviewer + internal reviewer.
8. Commit, push, and open PR only after validation passes and staged diff contains the ignored docs.
   - If any ignored docs change after validation or gate feedback, rerun `git add -f` before commit.
9. Merge only with no unresolved P0/P1/P2.
10. Post-merge cleanup:
   - Switch to `main`.
   - `git pull --ff-only`.
   - `npx gitnexus analyze`.
   - `npx gitnexus status`.
   - Close completed internal subagents and report dirty state.

## Architect Review Packet

Architect should review adversarially:

- Does this PR freeze enough contract for SPEC-2 runtime schema/state-machine work?
- Does the minimal headless contract skeleton under `src/core-runtime/contract/` satisfy SPEC-1's frozen判据 without stealing PR2's static-enforcement scope?
- Are any inventory items too vague to implement against?
- Are any items over-specified before implementation evidence exists?
- Does the boundary map hide existing coupling that will block PR2-PR5?
- Does it cover direct `invoke()` call sites, `app-state.json` cross-language schema locks, local servers, search/vector, file/platform, and process/CLI surfaces?
- Does the ADR keep React/Tauri as adapter rather than product runtime owner?
- Is Swift re-entry represented as a future shell contract, not a premature rewrite?
- Are there missing enforcement hooks for PR2?

Expected output format:

```text
结论：PASS | BLOCK | WARN
P0:
P1:
P2:
P3:
follow-up:
non-actionable:
```

## Validation

- `rg -n "SPEC-1|Shell|Core Runtime|Platform Adapter|Agent Adapter|Storage Boundary|Project|Job runtime|Markdown commit|Profiles|Derived|Search/vector|File/platform|Process/CLI|Agent run|Settings/status|app-state.json|invoke" docs/plans docs/plans/SPEC-1`
- `pnpm exec vitest run src/core-runtime/contract/headless-contract.test.ts`
- `pnpm lint`
- `git diff --check`
- `npx gitnexus detect-changes --repo llm_wiki`

## Unlock Condition

PR1 unlocks PR2 only after:

- ADR, inventory, storage boundary notes, and minimal headless contract skeleton are merged.
- Architect/reviewer gates have no unresolved P0/P1/P2.
- GitNexus has been re-analyzed on merged `main`.
- The next PR plan is created under `docs/plans/SPEC-1/` at PR2 start.
- PR3-PR5 unlock conditions are intentionally defined only when each PR starts, after the previous PR's merged contract is observable.
