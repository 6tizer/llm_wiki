# SPEC-3 PR6 Plan: Project Template / OKF Wording Closeout

> Branch: `codex/spec-3-pr6-template-okf-wording`  
> Base: `b58b324 feat: route markdown commit conflicts to repair jobs (#214)`  
> Scope: SPEC-3 PR6 / #187 closeout, with #188 confirmation after SPEC-3 PR1-PR5

## Goal

Finish SPEC-3 wording and template cleanup so `wiki/index.md` and `wiki/overview.md` are consistently optional derived/user-authored assets, not required runtime pages.

PR6 should make new project templates and OKF-facing wording match the post-PR2/PR5 runtime model:

- no template language says root `wiki/index.md` is mandatory or auto-maintained by normal ingest.
- no template language says every entity/concept must appear in root `wiki/index.md`.
- `overview` remains a valid local page type, but root `wiki/overview.md` is described as optional synthesis/user-authored summary, not required runtime truth.
- OKF validation/export tests explicitly prove missing root `wiki/index.md` and `wiki/overview.md` are valid.
- docs/plans status marks SPEC-3 PR5 merged and PR6 active.

## Non-goals

- Do not delete or hide existing user-authored `wiki/index.md` / `wiki/overview.md`.
- Do not remove import/export support for existing files.
- Do not migrate Agent context away from optional index/overview reads in `chat-agent`; that belongs to a later Agent context integration PR.
- Do not change normal ingest write path; PR2 already removed root index/overview writes.
- Do not change review/lint manual tools that explicitly update `wiki/index.md`; those are not normal ingest.
- Do not implement SPEC-6 derived rebuild jobs for optional index/export or overview.

## Current Facts

- SPEC-3 PR2 already removed root index/overview from normal ingest generation/write path.
- SPEC-3 PR5 merged at `b58b324` and leaves production MarkdownCommitAdapters wiring to a later integration PR.
- `src/lib/templates.ts` still says:
  - `wiki/index.md` lists all pages grouped by type.
  - every entity and concept should appear in `wiki/index.md`.
  - `overview` is "High-level project summary (one per project)".
- Template wording changes are not pure docs: they are written into new projects as `schema.md` / `purpose.md` and can later enter ingest prompts. PR6 must keep this limited to new-project template text and must not rewrite existing project files.
- `src/lib/okf-validate.ts` already treats `wiki/index.md`, `wiki/log.md`, and `wiki/overview.md` as structural pages when present, so they do not require frontmatter.
- Existing OKF validation/export tests already pass without root index/overview in some fixtures, but PR6 should add explicit assertions named for the SPEC-3 rule.
- i18n strings like API endpoint examples and "Hide index / overview / log" describe UI affordances, not mandatory runtime semantics; PR6 should avoid churn unless Architect marks wording misleading.

## GitNexus Impact

Current branch starts from GitNexus-indexed `main` commit `b58b324`.

- `validateOkfBundle`: LOW, 2 direct upstream callers, 1 affected Agent process through `runAgentAppToolHandler`.
- `isStructuralWikiPage`: LOW, 1 direct caller, same Agent process indirectly.
- `buildOkfExportBundle`: LOW, 2 direct upstream callers, 1 affected Agent process.
- `WikiTemplate`: LOW, direct imports from template picker and create-project dialog.

No HIGH/CRITICAL impact was found for the planned edits.

## Planned Edits

### Templates

Edit only template wording in `src/lib/templates.ts`:

- Change overview type purpose to optional project synthesis/user-authored summary.
- Change `BASE_INDEX_FORMAT` to describe root `wiki/index.md` as optional export/directory view, not required runtime state.
- Change cross-reference guidance from "Every entity and concept should appear in `wiki/index.md`" to local wikilink/frontmatter guidance that does not require root index membership.
- Keep all template ids, directories, page types, and frontmatter examples stable.

### OKF Validation / Export Tests

Add explicit tests:

- `validateOkfBundle` accepts a valid wiki with no root `wiki/index.md` and no root `wiki/overview.md`.
- `validateOkfBundle` keeps existing root structural pages valid without frontmatter when they are present.
- `buildOkfExportBundle` does not synthesize `wiki/index.md` or `wiki/overview.md` when absent.

Avoid changing validator behavior unless tests reveal a real mismatch. The current code already supports the target semantics.

### Docs

- Update `docs/plans/README.md`: PR5 merged, PR6 in progress, main/head baseline `b58b324`.
- This PR plan remains the observable PR6 execution record.

## Files

Expected edits:

- `docs/plans/SPEC-3/pr6-template-okf-wording-plan.md`
- `docs/plans/README.md`
- `src/lib/templates.ts`
- `src/lib/okf-validate.test.ts`
- `src/lib/okf-export.test.ts`

Avoid broad i18n/UI churn unless Architect Gate finds a concrete misleading string in PR6 scope.

## Implementation Order

1. Write this plan and update README.
2. Run Architect Gate.
3. Update template wording only.
4. Add explicit OKF validation/export tests.
5. Run focused tests.
6. Run Simplicity Gate, Tester Gate, Reviewer Gate.
7. Publish PR and close #187 if gates agree the remaining acceptance criteria are covered.

## Test Plan

Focused tests:

- `pnpm exec vitest run src/lib/okf-validate.test.ts src/lib/okf-export.test.ts`
- `src/lib/templates.test.ts`
- `pnpm lint`
- `git diff --check`
- staged `npx gitnexus detect-changes --repo llm_wiki --scope staged`

## Gates

- Architect: Claude ACP first; fallback ZCode/Kimi/internal if Claude remains unavailable.
- Simplicity: required. Default internal is acceptable if diff stays template/tests only; use ZCode if Architect expands scope to validator behavior.
- Tester: Kimi static packet; fallback ZCode/internal.
- Reviewer: ZCode external reviewer plus internal review.

All P0/P1/P2 must be fixed before PR creation.

## Agent-loop Status

`pnpm agent-loop delivery bind --issue 187 ...` failed because another active run is already bound:

- existing run: `a8d8c88e-5393-432a-bb86-bb4e42cb2ac3`
- existing issue: `184`
- requested issue: `187`

Commander fallback: record gate/test/PR evidence in plan docs and PR body/comments until the stale active run is cleared.

## Risks

- Over-scoping PR6 into Agent context migration. Mitigation: keep `chat-agent` reads out of scope unless a gate classifies them as necessary for #187 closeout.
- Removing support for existing root index/overview files. Mitigation: tests keep existing structural pages valid.
- Treating `overview` type as invalid. Mitigation: wording changes only; no schema/type removal.
- Template wording is runtime-relevant for new projects because it becomes `schema.md` / `purpose.md` and later LLM prompt context. Mitigation: add a focused template test that locks the optional index/overview wording and rejects the old "Every entity and concept should appear in wiki/index.md" requirement.

## Follow-up

- Later Agent context integration can replace optional index/overview reads with runtime/filetree/frontmatter/search/graph context.
- SPEC-6 owns explicit rebuild/export jobs for optional index/export and overview synthesis.
