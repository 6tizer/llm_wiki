# SPEC-3 PR1 Plan: Markdown Commit Layer ADR + Artifact Format

> Type: PR execution plan | Status: ready for PR | Owner: Commander | Branch: `codex/spec-3-pr1-commit-layer-adr` | Issues: #187, #188

## Goal

Create the SPEC-3 hard gate for staged Markdown commits before any final write-path migration lands.

This PR freezes the commit layer invariants, artifact/result shapes, conflict routing, event/marker responsibilities, and shell-neutral Core Runtime contract metadata needed by SPEC-3 PR2-PR5.

## Scope

Deliverables:

- Add `docs/plans/SPEC-3/adr-markdown-commit-layer.md`.
- Define staging artifact contract:
  - artifact id, job id, artifact path/hash;
  - target Markdown path;
  - base hash / missing-base semantics;
  - operation intent: create, update, append, delete;
  - source worker metadata without storing large LLM output in SQLite.
- Define commit result contract:
  - committed, merged, conflicted, rejected, skipped;
  - affected paths;
  - base/current/final hash fields;
  - cleanup handoff to SPEC-2 staging artifact GC.
- Define conflict routing:
  - base hash mismatch becomes repair/review job;
  - no silent overwrite;
  - conflict artifact stays available until TTL.
- Define derived stale marker boundary:
  - SPEC-3 writes marker facts only through SPEC-2-owned operations;
  - SPEC-6 consumes markers.
- Freeze SPEC-2 dependency boundaries:
  - per-path serialization consumes `resource-budgets`; no SPEC-3-local limiter;
  - durable commit audit records append through `events-progress`; no SPEC-3 commit-events table;
  - staging artifact status changes use `staging-artifacts`; no new artifact schema family;
  - derived marker physical storage remains SPEC-2-owned.
- Extend inert Core Runtime contract metadata for `markdown-commit` commands/events without implementing commit behavior.
- Add focused contract tests so the ADR and inert contract stay aligned.
- Update `docs/plans/README.md` with the PR1 plan/ADR entries.

## Non-Goals

- No ingest prompt/write-path changes; PR2 owns `index.md` / `overview.md` removal.
- No production commit operation.
- No runtime DB migration.
- No derived stale marker table implementation.
- No conflict repair job implementation.
- No UI.
- No large artifact blob storage in SQLite.
- No semantic merge algorithm beyond ADR-level boundaries.
- No deletion of existing user `wiki/index.md` or `wiki/overview.md`.

## Key Files / Symbols

- `docs/plans/SPEC-3/pr1-commit-layer-adr-plan.md`
- `docs/plans/SPEC-3/adr-markdown-commit-layer.md`
- `docs/plans/README.md`
- `src/core-runtime/contract/index.ts`
- `src/core-runtime/contract/headless-contract.test.ts`
- `src/core-runtime/contract/adapter-contract.test.ts`

## GitNexus Impact Summary

Pre-edit impact checks:

- `RuntimeContractMessage`: LOW risk; 3 direct upstream references; 0 affected processes.
- `CoreRuntimeContract`: LOW risk; 3 direct upstream references; 0 affected processes.
- `createMockCoreRuntimeContract`: LOW risk; 2 direct upstream references; 0 affected processes.
- `RuntimeContractFamily`: not indexed as a standalone GitNexus target; covered through focused contract tests.

No HIGH or CRITICAL impact found.

## Implementation Order

1. Write this PR plan and index it.
2. Run Architect adversarial review on the plan before implementation.
3. Add the SPEC-3 ADR.
4. Extend `markdown-commit` inert contract command/event names and lightweight type unions.
5. Update headless/adapter contract tests:
   - `markdown-commit` family remains shell-neutral;
   - commands/events match ADR names;
   - special-family tests become data-driven for `job-runtime` and `markdown-commit`, not chained ternaries;
   - artifact/result/conflict/marker terms are represented as contract metadata only;
   - no React, Zustand, Tauri APIs, command wrappers, or runtime persistence imports enter `src/core-runtime`.
6. Run focused verification, Simplicity Gate, Tester Gate, and Reviewer Gate.
7. Stage intentionally, run staged GitNexus detect, commit, push, and open PR.

## Architect Review Packet

Architect should review adversarially:

- Does PR1 freeze enough commit-layer contract for PR2-PR5 without implementing behavior too early?
- Are artifact/result/conflict/event/marker boundaries specific enough to prevent later ambiguity?
- Does the ADR clearly preserve Markdown as committed truth and runtime DB as metadata only?
- Does it correctly depend on SPEC-2 resource budgets, event/progress, staging artifact GC, and future derived marker operations?
- Does it avoid competing runtime state, alternate commit queues, or a Git replacement design?
- Does the inert Core Runtime contract stay shell-neutral and testable headlessly?
- Is any part of PR1 actually PR2/PR3 implementation scope and should be deferred?

Expected output:

```text
PASS | BLOCK | WARN
P0:
P1:
P2:
P3:
follow-up:
non-actionable:
```

## Architect Gate Notes

Claude ACP Architect gate completed with `WARN`.

Accepted P1/P2 requirements for PR1:

- ADR must state commit-path concurrency uses SPEC-2 `resource-budgets` claim/release; no SPEC-3-local limiter.
- ADR must distinguish Core Runtime `markdown-commit:*` contract events from durable audit records appended through SPEC-2 `events-progress`.
- ADR must state per-path serialization is layered on SPEC-2 jobs/leases/resource budgets; no alternate commit queue or new schema family.
- ADR and contract tests must enumerate exact `markdown-commit:*` command/event names and reconcile them with SPEC-1 frozen inventory.
- ADR must reconcile derived marker ownership: SPEC-3 defines logical marker fields and writes/diagnoses through SPEC-2 operations; SPEC-6 consumes markers for rebuild scheduling.
- ADR must define result enum semantics, missing-base x operation-intent matrix, delete semantics, TTL owner, and logical-vs-physical schema ownership.

## Test Plan

Focused:

- `pnpm exec vitest run src/core-runtime/contract/headless-contract.test.ts src/core-runtime/contract/adapter-contract.test.ts src/core-runtime/contract/boundary-check.test.ts`

Required before PR:

- `pnpm lint`
- `git diff --check`
- `npx gitnexus detect-changes --repo llm_wiki --scope staged`

Full `pnpm test:mocks` is optional for PR1 unless gate feedback finds broader contract risk.

## Gate Plan

- Architect: Claude ACP with confirmed provider/model; fallback Kimi/ZCode; fallback internal Architect.
- Simplicity: internal Simplifier after focused tests; if contract diff grows beyond inert metadata, use ZCode read-only simplicity reviewer.
- Tester: Kimi static packet; fallback ZCode/internal Tester.
- Reviewer: ZCode read-only reviewer plus internal Reviewer.
- External main gate timeout: `600000`; focused recheck timeout: `120000`.
- Merge standard: no unresolved P0/P1/P2.

## Follow-up Routing

- PR3 must decide whether future append strategies can safely handle current-hash drift for hotspot pages; until then the frozen PR1 matrix keeps drift as `conflicted`.
- PR5 must route unresolved append/hotspot conflicts through repair/review jobs rather than silently overwriting.

## Expected PR Metadata

- PR title: `docs: define SPEC-3 markdown commit layer`
- Commit message: `docs: define SPEC-3 markdown commit layer`
- PR body must include:
  - scope and non-goals;
  - GitNexus impact/detect summary;
  - test results;
  - Simplicity / Tester / Reviewer gate outcomes;
  - fallback notes, if any.
