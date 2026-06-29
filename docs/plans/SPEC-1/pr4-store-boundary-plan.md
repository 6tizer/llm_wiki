# SPEC-1 PR4: Store Boundary Cleanup Plan

> Status: gates PASS / ready for PR | Branch: `codex/spec-1-pr4-store-boundary` | Owner: Commander

## Goal

区分当前 `app-state.json` / Zustand / project-scoped settings 中混在一起的状态类别，形成 Store Boundary cleanup inventory 和测试护栏。PR4 仍是边界计划 + 纯 inventory，不迁移 `project-store.ts` 行为，不改变 `app-state.json` schema。

PR4 的重点不是重构 store，而是防止 SPEC-2 runtime DB 设计把 UI view state、persisted app settings、project runtime state、runtime/job truth 混到同一个真实来源。

## Inputs

- [`../spec-1-app-architecture-decomposition.md`](../spec-1-app-architecture-decomposition.md)
- [`adr-shell-core-boundary.md`](./adr-shell-core-boundary.md)
- [`pr3-bootstrap-boundary-plan.md`](./pr3-bootstrap-boundary-plan.md)
- `src/lib/project-store.ts`
- `src/lib/project-identity.ts`
- `src/stores/wiki-store.ts`
- `src/stores/update-store.ts`
- `src-tauri/src/api_server.rs`
- `src-tauri/src/lib.rs`
- `src-tauri/src/proxy.rs`
- `src/core-runtime/contract/boundary-check.ts`

## Current State

`src/lib/project-store.ts` uses Tauri plugin-store and the shared `app-state.json` file for multiple categories:

- app-global UI/runtime preferences: `language`, `theme`, `zoomLevel`, `closeBehavior`, update-check state.
- cross-language platform settings: `proxyConfig`, `apiConfig`, `apiConfig.mcpEnabled`, `closeBehavior`, `language`.
- model/profile-ish settings: `llmConfig`, `providerConfigs`, `activePresetId`, search/embedding/multimodal/MinerU configs.
- project list identity: `recentProjects`, `lastProject`.
- project-scoped preferences: `outputLanguage`, `projectOutputLanguages`, `projectFileSyncEnabled`, `sourceWatchConfig`, `scheduledImportConfig:<projectPath>`.
- migration/compatibility state: legacy global `scheduledImportConfig`.

`src/stores/wiki-store.ts` mirrors several persisted settings into Zustand alongside active project, file tree, selected file, active view, API config, proxy config, scheduled import config, and source watch config. This is useful for the current UI shell but must not become SPEC-2 runtime truth.

ADR PR1 minimum storage lock:

- `language`: Rust tray labels.
- `closeBehavior`: Rust close/hide behavior.
- `proxyConfig`: Rust live proxy behavior.
- `apiConfig`: local API auth/status.
- `apiConfig.mcpEnabled`: local API metadata for MCP clients.

PR4 discovered Rust-read app-state lock extends the PR1 minimum list:

- `apiConfig.enabled`
- `apiConfig.allowUnauthenticated`
- `apiConfig.token`
- `apiConfig.mcpEnabled`
- `projectRegistry`
- `recentProjects`
- `embeddingConfig`
- `sourceWatchConfig`
- `projectFileSyncEnabled`
- `proxyConfig`
- `language`
- `closeBehavior`

PR4 cannot rename, move, or delete these keys without a compatibility adapter. Tests must treat Rust reader tokens as the authority for discovered cross-language compatibility keys, not only the PR1 ADR list.

## Scope

1. Add a pure TypeScript store boundary inventory under `src/core-runtime/contract/`:
   - classify persisted keys and Zustand mirrors by owner/category.
   - record whether a key is Rust-locked, project-scoped, UI-only, runtime-derived, profile-ish, or SPEC-2 deferred.
   - record current storage surface (`app-state.json`, Zustand mirror, project path key, legacy key).
   - record migration rule and compatibility note.
   - no imports, no plugin-store calls, no store calls, no behavior changes.
   - not re-exported from `src/core-runtime/contract/index.ts`.
2. Add tests:
   - inventory remains pure and passes PR2 boundary checker.
   - inventory is not re-exported from the public contract index.
   - ADR PR1 minimum locked keys are a subset of inventory Rust-locked keys.
   - Rust reader tokens in `src-tauri/src/api_server.rs`, `src-tauri/src/lib.rs`, and `src-tauri/src/proxy.rs` are covered by inventory Rust/cross-language locked keys.
   - `project-store.ts` / `project-identity.ts` still contain the locked key constants / string literals.
   - legacy scheduled import key is recorded.
   - Zustand state is split into UI view/session state, persisted settings mirrors, and active project/session mirrors; none are canonical runtime truth.
3. Update docs:
   - add PR4 plan to `docs/plans/README.md`.
   - update SPEC-1 PR table: PR3 merged, PR4 active / pending Architect.
   - add ADR pointer only if additive; do not change frozen command/event families.

## Non-goals

- 不修改 `src/lib/project-store.ts` 的 behavior。
- 不 rename `app-state.json` key。
- 不迁移 plugin-store 到 runtime DB。
- 不迁移 secrets/Keychain。
- 不修改 Rust `src-tauri` reader。
- 不改变 Settings UI、project open、startup hydrate、local API/proxy behavior。
- 不实现 SPEC-2 runtime schema。

## Proposed Inventory Shape

预计新增：

- `src/core-runtime/contract/store-boundary.ts`
- `src/core-runtime/contract/store-boundary.test.ts`
- `docs/plans/SPEC-1/pr4-store-boundary-plan.md`

建议类型：

```ts
export type StoreBoundaryOwner =
  | "ui-shell"
  | "platform-adapter"
  | "storage-boundary"
  | "profiles"
  | "project-family"
  | "job-runtime-family"
  | "settings-status-family"
  | "derived-family";

export type StoreBoundaryCategory =
  | "rust-locked-app-setting"
  | "rust-locked-nested-setting"
  | "rust-locked-project-setting"
  | "app-ui-preference"
  | "profile-or-provider-setting"
  | "secret-bearing-setting"
  | "project-identity"
  | "project-scoped-setting"
  | "legacy-compatibility-key"
  | "zustand-ui-view-state"
  | "zustand-persisted-setting-mirror"
  | "zustand-project-session-mirror"
  | "zustand-update-session-state"
  | "runtime-state-deferred";

export type StoreBoundaryEntry = {
  readonly id: string;
  readonly currentSurface: "app-state.json" | "zustand" | "project-path-key";
  readonly currentKeys: readonly string[];
  readonly nestedKeys?: readonly string[];
  readonly owner: StoreBoundaryOwner;
  readonly category: StoreBoundaryCategory;
  readonly rustLocked: boolean;
  readonly crossLanguageReadByRust: boolean;
  readonly secretBearing: boolean;
  readonly projectScoped: boolean;
  readonly migrationRule: string;
  readonly compatibilityNote: string;
};
```

Required entries:

- `rust-language`
- `rust-close-behavior`
- `rust-proxy-config`
- `rust-api-config`
- `rust-api-config-enabled`
- `rust-api-config-allow-unauthenticated`
- `rust-api-config-token`
- `rust-api-config-mcp-enabled`
- `rust-project-registry`
- `rust-recent-projects`
- `rust-embedding-config`
- `rust-source-watch-config`
- `rust-project-file-sync-enabled`
- `ui-theme`
- `ui-zoom-level`
- `update-check-persisted-state`
- `update-check-session-state`
- `model-provider-config`
- `search-embedding-multimodal-mineru-config`
- `project-recents-last-project`
- `project-registry`
- `project-output-language`
- `project-file-sync-source-watch`
- `scheduled-import-project-config`
- `scheduled-import-legacy-global-key`
- `wiki-store-ui-view-state`
- `wiki-store-persisted-setting-mirrors`
- `wiki-store-project-session-mirrors`
- `runtime-job-state-deferred`

Hard invariants:

- Every PR1 ADR minimum locked key appears in at least one rust-locked entry.
- Every PR4 discovered Rust reader token appears in a rust-locked / cross-language entry.
- Nested Rust-read keys such as `apiConfig.token`, `apiConfig.enabled`, `apiConfig.allowUnauthenticated`, and `apiConfig.mcpEnabled` must be represented explicitly, not collapsed into only `apiConfig`.
- No Rust-locked entry may have migration rule "move to runtime DB".
- Runtime/job state is deferred to SPEC-2 and must not be modeled as plugin-store truth.
- Project-scoped keys must state their project identifier basis (`projectId`, normalized project path, or legacy default).
- Zustand state must be split into UI view state, persisted setting mirrors, and project/session mirrors; none may be labeled canonical runtime truth.
- Persisted secret-bearing settings (`llmConfig.apiKey`, `providerConfigs.*`, `searchApiConfig.apiKey`, `embeddingConfig.apiKey`, `mineruConfig.token`, `apiConfig.token`) must be flagged `secretBearing` and excluded from logs/reports.
- Update-check persisted state is limited to `enabled`, `lastCheckedAt`, and `dismissedVersion`; `checking` and `lastResult` are session/UI runtime state.

## GitNexus / Impact Rules

- Planning/docs stage does not modify code symbols; no impact required.
- Pure inventory + tests add new symbols only; run detect before commit.
- If PR4 changes `project-store.ts`, `wiki-store.ts`, Settings UI, or Rust readers, stop and run targeted impact first.
- Any change to locked keys requires explicit user warning and compatibility plan; default PR4 does not touch them.

Suggested impact commands if scope expands:

```bash
npx gitnexus impact saveApiConfig --repo llm_wiki --direction upstream --include-tests
npx gitnexus impact saveProxyConfig --repo llm_wiki --direction upstream --include-tests
npx gitnexus impact saveCloseBehavior --repo llm_wiki --direction upstream --include-tests
npx gitnexus impact saveLanguage --repo llm_wiki --direction upstream --include-tests
```

## Gate Plan

1. Commander writes this PR4 plan.
2. Architect adversarial review:
   - classification completeness;
   - Rust schema lock coverage;
   - whether inventory in `core-runtime/contract` is appropriate;
   - whether tests overfit strings or miss key drift;
   - whether PR4 is too weak/too broad.
   - whether Rust reader drift guard covers `api_server.rs`, `lib.rs`, and `proxy.rs`.
3. Coder implements only after P0/P1/P2 are resolved.
4. Tester verifies key coverage, Rust lock invariants, no behavior change.
5. Reviewer verifies final diff and test adequacy.

Fallback:

- Architect：Claude -> Kimi -> ZCode -> internal Architect。
- Tester：Kimi -> ZCode -> internal Tester。
- Reviewer：ZCode -> Claude/Kimi -> internal Reviewer。

Gate result:

- Architect: external fallbacks unavailable/incomplete; internal Architect PASS after P0/P1/P2 plan fixes.
- Tester: Kimi initial WARN, focused Kimi recheck PASS; internal Tester WARN with no P0/P1.
- Reviewer: ZCode PASS with provider-overload noise after complete verdict; internal Reviewer BLOCK, then focused PASS after fixes and forced staging of ignored plan doc.

## Validation

PR4 complete requires:

```bash
pnpm exec vitest run src/core-runtime/contract/headless-contract.test.ts src/core-runtime/contract/boundary-check.test.ts src/core-runtime/contract/bootstrap-boundary.test.ts src/core-runtime/contract/store-boundary.test.ts
pnpm test:mocks
pnpm lint
git diff --check
npx gitnexus detect-changes --repo llm_wiki --scope staged
```

If any existing store behavior changes, add focused store/settings tests and rerun impacted suites.

## Unlock Criteria

PR4合并后：

- Store boundary inventory 明确区分 UI mirror、app settings、project-scoped settings、Rust-locked schema、runtime/job deferred state。
- PR5 can add adapter contract tests against shell/platform/agent mocks using these storage categories.
- SPEC-2 runtime schema must not reuse plugin-store `app-state.json` as runtime job truth.
- 合并后回 `main`、`git pull --ff-only`、`npx gitnexus analyze`，确认 index up to date，再启动 PR5。
