# Phase 6 PR K: AnyTXT Smart Search Options

Issue: #110

## Scope

- Convert `anyTxtSearchSmart(query, ...)` trailing parameters to a single options object.
- Keep `query` as the first positional parameter.
- Update production AnyTXT smart-search callers in deep research and chat agent code.
- Update focused tests that assert AnyTXT smart-search arguments.

## Non-goals

- Do not implement source import extras.
- Do not implement lint persistence.
- Do not include editor, review, or miscellaneous PR E/G/J work.
- Do not change whether `collect_research_sources` agent app tool passes `llmConfig` into `collectResearchSources`.

## Tests

- `pnpm test -- src/lib/anytxt-search.test.ts src/lib/deep-research.test.ts src/lib/chat-agent.test.ts src/lib/agent/agent-app-tools.test.ts`
- `npm run typecheck`
- `pnpm lint`
- `git diff --check`
- `npx gitnexus detect_changes --repo llm_wiki`

## Follow-up

- Decide in a separate issue/PR whether `collect_research_sources` should pass `llmConfig` for AnyTXT query rewrite support.
