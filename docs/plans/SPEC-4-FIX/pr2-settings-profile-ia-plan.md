# SPEC-4-FIX PR2: Settings/Profile IA Plan

> Type: PR implementation plan | Status: merged via #230 | Issue: #229 | Branch: `codex/spec-4-fix-pr2-settings-profile-ia` | Run: `b2d44c1a-e478-4558-881b-79803e215902`

## Goal

Make runtime Model Profiles a first-class Settings category next to LLM Models, and clarify that the LLM Models page is the legacy/default provider configuration surface rather than the whole system's LLM capacity.

This PR also clarifies that Knowledge Agents, Tag Taxonomy, and Synthesis are LLM Wiki local product capabilities, not upstream Settings drift.

## Scope

- Add Settings category `model-profiles`.
- Render `ModelProfilesSection` from `settings-view.tsx`.
- Remove `ModelProfilesSection` from `LlmProviderSection`.
- Keep LLM Models as the single-active legacy/default provider page.
- Adjust LLM provider copy so single-active-provider behavior is scoped to legacy/default paths.
- Add concise ownership copy for Knowledge Agents, Tag Taxonomy, and Synthesis.
- Preserve persistence behavior:
  - LLM provider config persists directly.
  - Model Profiles persist directly through runtime DB commands.
  - draft-backed settings keep the global save bar.
- Repair PR1 docs state now that #228 is merged:
  - PR1 plan status.
  - README plan index row.
  - README Current Execution Order.

## Non-Goals

- No profile lifecycle/runtime delete behavior; PR1 owns that.
- No Agent chat profile selector or permission selector; SPEC-7 owns conversation controls.
- No Agent SDK compatibility/env/model alias work; PR3 owns that.
- No broad Settings redesign, route restructuring, or visual overhaul.

## Key Files / Symbols

- `src/components/settings/settings-view.tsx`
  - `CategoryId`
  - `CATEGORIES`
  - `getSettingsCategories`
  - `coerceSettingsCategory`
  - `shouldShowGlobalSettingsSaveBar`
  - `SettingsView`
- `src/components/settings/sections/llm-provider-section.tsx`
  - `LlmProviderSection`
- `src/components/settings/sections/model-profiles-section.tsx`
  - `ModelProfilesSection`
- `src/components/settings/settings-view.test.ts`
- `src/components/settings/sections/llm-provider-section.test.tsx`
- `src/components/settings/sections/model-profiles-section.test.tsx`
- `src/i18n/en.json`
- `src/i18n/zh.json`
- `docs/plans/README.md`
- `docs/plans/SPEC-4-FIX/pr1-profile-lifecycle-plan.md`

## GitNexus Impact

- `SettingsView`: HIGH, 3 impacted, 1 affected process (`AppLayout`). Expected UI shell fanout.
- `shouldShowGlobalSettingsSaveBar`: HIGH, 4 impacted, 1 affected process (`AppLayout`). Expected Settings save-bar fanout.
- `coerceSettingsCategory`: HIGH, 4 impacted, 1 affected process (`AppLayout`). Expected Settings category routing fanout.
- `getSettingsCategories`: LOW, 2 impacted, no affected processes.
- `LlmProviderSection`: LOW, 3 impacted, 1 affected process (`body` in `settings-view.tsx`).
- `ModelProfilesSection`: LOW, 7 impacted, 1 affected process (`body` in `settings-view.tsx`).

Risk is acceptable because the PR is limited to Settings IA/rendering and copy, with focused Settings tests and UI smoke.

## Implementation Order

1. Add `model-profiles` to `CategoryId` and `CATEGORIES`.
2. Import and render `ModelProfilesSection` directly from `settings-view.tsx`.
3. Exclude `model-profiles` from the global Settings save bar.
4. Remove `ModelProfilesSection` import/rendering from `LlmProviderSection`.
5. Add i18n category key and adjust LLM page description.
6. Update Knowledge Agents, Tag Taxonomy, and Synthesis descriptions with local LLM Wiki ownership language.
7. Update focused tests:
   - Model Profiles category is visible and renders the section.
   - LLM provider section no longer renders Model Profiles.
   - non-mac category coercion keeps `model-profiles`, Knowledge Agents, taxonomy, and synthesis reachable.
   - global save bar hides for `model-profiles`.
8. Run UI smoke in Dev App or browser-equivalent Settings render if app smoke is not available in this turn.

## Test Plan

Focused:

```bash
pnpm exec vitest run src/components/settings/settings-view.test.ts src/components/settings/sections/llm-provider-section.test.tsx
pnpm exec vitest run src/components/settings/sections/model-profiles-section.test.tsx
```

Required before PR:

```bash
pnpm lint
git diff --check
npx gitnexus detect-changes --repo llm_wiki --scope staged
```

Run broader tests if focused tests expose shared Settings regressions or if reviewer asks:

```bash
pnpm test
```

## Gate Expectations

- Simplicity Gate: internal Simplifier is acceptable because this is UI IA/copy, not Rust DB/shared runtime. Use ZCode fallback if the diff grows beyond Settings routing/copy.
- Tester Gate: Kimi static tester, fallback ZCode/internal.
- Reviewer Gate: ZCode external reviewer plus internal reviewer.
- Merge standard: no unresolved P0/P1/P2, all scoped P3 fixed, CI green.

## PR Metadata

- Planned commit: `feat: move model profiles to settings category`
- Planned PR title: `feat: move model profiles to settings category`
- PR body must include issue #229, run id, impact summary, focused tests, GitNexus detect, Simplicity result, Tester/Reviewer reports, and CI status.
