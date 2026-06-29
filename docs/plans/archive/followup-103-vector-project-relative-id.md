# Follow-up #103: Project-relative vector page identity

## Summary

- Branch: `codex/followup-103-vector-project-relative-id`.
- Issue: #103.
- Goal: derive new vector page ids from project-root-relative `wiki/.../*.md` paths instead of searching for the last `wiki` segment.
- Architect gate: ZCode returned `WARN`; implementation must split absolute and wiki-relative helper semantics, keep legacy stem unchanged, and add TS/Rust parity coverage.

## Implementation

- TS identity helpers:
  - Add separate helpers for absolute project paths and wiki-relative paths.
  - Keep `wikiPathToLegacyStemId(path)` path-only because it is used for legacy media cleanup, not vector identity.
  - Keep a compatibility dispatcher only where existing call sites still pass mixed path shapes; new runtime code should pass `projectPath`.
- Runtime callers:
  - Update embedding, ingest re-embed, wiki page delete, and source lifecycle cleanup to derive vector ids with `projectPath`.
  - Preserve legacy stem fallback behavior; do not expand old basename fallback matching.
- Rust search:
  - Replace the standalone last-`wiki` heuristic with project-relative identity derivation in search indexing/materialization tests.
  - Preserve legacy stem fallback only when unique.

## Tests

- `cargo test --manifest-path src-tauri/Cargo.toml search`
- `cargo test --manifest-path src-tauri/Cargo.toml vectorstore`
- `pnpm test -- src/lib/embedding.test.ts src/lib/wiki-page-delete.test.ts src/lib/source-lifecycle.test.ts src/lib/ingest-queue.test.ts`
- `pnpm lint`
- `git diff --check`
- `npx gitnexus detect_changes --repo llm_wiki`

## Assumptions

- No vector storage schema change.
- No PR C rebuild-safety changes.
- No UI changes.
- Follow-up candidates from architect gate: eventual removal of legacy stem fallback and optional cross-language fuzz tests.
