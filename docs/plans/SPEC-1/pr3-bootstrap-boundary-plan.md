# SPEC-1 PR3: Bootstrap Boundary Cleanup Plan

> Status: architect PASS / ready for Coder implementation | Branch: `codex/spec-1-pr3-bootstrap-boundary` | Owner: Commander

## Goal

把 `src/App.tsx` 中的非 UI bootstrap 副作用标记为 runtime/bootstrap service 候选，并建立可测试的边界清单。PR3 的目标是让后续迁移有单一清单和护栏，不在本 PR 搬动启动语义。

PR3 不完成 SPEC-1 strangler Priority-1 的 extraction done-criteria。Priority-1 的最终完成条件是 bootstrap side effects 被表示为 runtime/bootstrap services 或 explicit shell adapter calls；PR3 只建立迁移 inventory 和 ordering invariants，实际 extraction 延后到 SPEC-2/runtime bootstrap PR。

## Inputs

- [`../spec-1-app-architecture-decomposition.md`](../spec-1-app-architecture-decomposition.md)
- [`adr-shell-core-boundary.md`](./adr-shell-core-boundary.md)
- [`pr2-boundary-enforcement-plan.md`](./pr2-boundary-enforcement-plan.md)
- `src/App.tsx`
- `src/core-runtime/contract/boundary-check.ts`
- `src/core-runtime/contract/index.ts`

## Current State

`App.tsx` 仍同时承载 UI shell 和 runtime/bootstrap 编排：

- mount-only side effects：`setupAutoSave()`、`startClipWatcher()`。
- UI-only shell effect：document zoom。
- dev-only shell helper：`__llmwiki_testUpdateBanner`。
- background update check：读取/写入 update persisted state、调用 GitHub release check、写入 update store。
- startup hydrate：LLM/provider/search/embedding/multimodal/MinerU/proxy/API/zoom/theme/language/last project。
- project open orchestration：reset project state、load agent resource config、restore ingest/dedup queues、scheduled import、project file sync、clip server notify、file tree、review/lint/chat persisted state。
- project switch cleanup：stop scheduled import、persist scheduled import config、reset project state、clear UI project/file state。

GitNexus evidence:

- `npx gitnexus context App --repo llm_wiki`：`App` 调用 `applyDocumentZoom`、`init`、`setupAutoSave`、`startClipWatcher`、stores 和 UI layout。
- `npx gitnexus context handleProjectOpened --repo llm_wiki`：上游 callers 是 `init`、`handleSelectRecent`、`handleOpenProject`；下游包括 `listDirectory`、`loadAgentResourceConfig`、persist loaders、project-store loaders。
- `npx gitnexus impact handleProjectOpened --repo llm_wiki --direction upstream --include-tests`：risk `HIGH`，direct callers 3，affected processes 2，affected modules 4。

## Scope

1. 新增纯 TypeScript bootstrap boundary inventory，优先放在 `src/core-runtime/contract/`：
   - 声明 bootstrap candidate family / owner / current App surface / target boundary / migration note。
   - 显式记录跨候选 ordering invariants，尤其是 reset-before-populate、ingest-queue-before-file-sync、switch-reset-before-welcome。
   - 不读取文件、不调用 stores、不 import React/Tauri/Zustand/commands。
   - 不从 `src/core-runtime/contract/index.ts` re-export，避免扩大 runtime contract public surface。
2. 增加 contract tests：
   - inventory 覆盖 `App.tsx` 当前非 UI bootstrap 候选，不能只做 hardcoded id 自比。
   - 测试必须锁定显式 call-site / responsibility 文本清单，例如 `setupAutoSave`、`startClipWatcher`、`loadUpdateCheckState`、`saveUpdateCheckState`、`loadLlmConfig`、`saveLlmConfig`、`loadAgentResourceConfig`、`cleanExpiredAgentSessions`、`restoreQueue`、`startProjectFileSync`、`fetch("http://127.0.0.1:19827/project")`、`listDirectory`、`loadReviewItems`、`loadLintItems`、`loadChatHistory`、`stopScheduledImport`、`saveScheduledImportConfig`、`resetProjectState`。
   - 增加 App drift guard：测试读取 `src/App.tsx`，确认上述 bootstrap call-site token 与所有 invariant `protectedCallSites` 的并集仍存在且被 inventory 覆盖；如果 App 新增/移动已知关键 bootstrap token，测试必须提示更新 inventory。全新未知 bootstrap token 只能靠 review 发现，不宣称全自动识别。
   - inventory family 与 ADR / SPEC-1 文档的 PR3 scope 对齐。
   - PR2 boundary checker 继续证明新 inventory 不 import shell/runtime forbidden specifier。
   - 额外断言 inventory module 不从 `index.ts` re-export，且 inventory 文件零 import 或仅 import contract-local type。
3. 更新 ADR / SPEC-1 状态：
   - 标记 PR2 已 merged。
   - 标记 PR3 active plan / pending Architect。
   - ADR 只允许 additive 指针，不能改变 frozen command/event family 或现有 coupling-map 行语义。

## Non-goals

- 不移动 `handleProjectOpened`、startup `init` 或 update-check 的执行位置。
- 不改变 React lifecycle 调用顺序。
- 不重构 Zustand stores、project-store、ingest queue、dedup queue、project-file-sync、scheduled import 或 clip server。
- 不新增 runtime DB/schema，不为 SPEC-2 预先实现 bootstrap service。
- 不修改 UI copy、layout、render behavior。
- 不把 App bootstrap 直接迁入 `src/core-runtime/**` 的可执行 runtime 逻辑；PR3 只建立纯 inventory 和测试护栏。

## Proposed Inventory Shape

预计新增：

- `src/core-runtime/contract/bootstrap-boundary.ts`
- `src/core-runtime/contract/bootstrap-boundary.test.ts`
- `docs/plans/SPEC-1/pr3-bootstrap-boundary-plan.md`

建议类型：

```ts
export type BootstrapBoundaryOwner =
  | "ui-shell"
  | "runtime-bootstrap"
  | "platform-adapter"
  | "agent-adapter"
  | "storage-boundary";

export type BootstrapTargetBoundary =
  | "ui-shell"
  | "runtime-bootstrap-service"
  | "platform-adapter"
  | "agent-adapter"
  | "storage-boundary"
  | "settings-status-family"
  | "project-family"
  | "job-runtime-family"
  | "file-platform-family";

export type BootstrapBoundaryCandidate = {
  readonly id: string;
  readonly currentSurface: "src/App.tsx";
  readonly owner: BootstrapBoundaryOwner;
  readonly targetBoundary: BootstrapTargetBoundary;
  readonly currentResponsibilities: readonly string[];
  readonly currentCallSites: readonly string[];
  readonly migrationNote: string;
};

export type BootstrapBoundaryInvariant = {
  readonly id: string;
  readonly description: string;
  readonly beforeCandidateId: BootstrapBoundaryCandidate["id"];
  readonly afterCandidateId: BootstrapBoundaryCandidate["id"];
  readonly protectedCallSites: readonly string[];
};
```

建议候选：

- `mount-background-services`：auto-save、clip watcher。
- `update-check-bootstrap`：1.5s deferred timer、cancellation lifecycle、update store hydrate、release fetch、persisted update metadata。
- `settings-hydration`：provider/search/embedding/multimodal/MinerU/proxy/API/zoom preference/theme/language；active preset path 会 re-resolve 并 `saveLlmConfig(resolved)` 写盘，migration note 必须保留该 write-back 副作用。`zoom preference` 只指 persisted setting hydrate，不包含 DOM font-size mutation。
- `last-project-open`：last project lookup and open.
- `project-open-runtime-handshake`：reset, set active project, output language, save last project.
- `project-queue-restore`：ingest queue + dedup queue restore.
- `project-periodic-work`：scheduled import + project file sync.
- `project-shell-notify`：clip server current project and recent projects notify.
- `project-file-tree-load`：`listDirectory` live platform file read and file tree store update.
- `project-persisted-ui-state`：review, lint, chat history.
- `project-agent-state`：agent resource config hydrate and expired agent session cleanup.
- `project-switch-cleanup`：stop scheduled import, persist config, reset project state, clear active project/file tree/selected file UI state.
- `ui-shell-excluded-effects`：`applyDocumentZoom` DOM font-size mutation and dev-only update banner helper stay UI-shell-owned and are intentionally excluded from runtime bootstrap migration.

Required top-level ordering invariants:

- `project-reset-before-populate`: `project-open-runtime-handshake` must precede `project-queue-restore`, `project-periodic-work`, `project-file-tree-load`, `project-persisted-ui-state`, and `project-agent-state`; protected call-sites include `resetProjectState`, `setProject`, `restoreQueue`, `listDirectory`.
- `ingest-restore-before-file-sync`: `project-queue-restore` must precede `project-periodic-work`; protected call-sites include `restoreQueue`, `startProjectFileSync`.
- `switch-reset-before-welcome`: `project-switch-cleanup` reset must precede clearing project/file UI state and returning to welcome/no-project UI; protected call-sites include `stopScheduledImport`, `saveScheduledImportConfig`, `resetProjectState`, `setProject(null)`, `setFileTree([])`.
- `update-timer-cancel-before-write`: `update-check-bootstrap` cancellation guard must protect delayed update-store writes; protected call-sites include `setTimeout`, `cancelled`, `setChecking`, `setResult`, `saveUpdateCheckState`.

Implementation may split `project-reset-before-populate` into pairwise invariant ids:

- `project-reset-before-queue-restore`
- `project-reset-before-periodic-work`
- `project-reset-before-file-tree-load`
- `project-reset-before-persisted-ui-state`
- `project-reset-before-agent-state`

Cross-candidate invariants 用 pairwise edge 表达；一对多关系拆成多条 invariant。Candidate 内部顺序允许 `beforeCandidateId === afterCandidateId`，真实顺序由 `protectedCallSites` 与 description 固定，测试不得强制 before/after 不相等。

## GitNexus / Impact Rules

- PR3 planning/docs stage 不改代码符号，无需 impact。
- 实现如果只新增 pure inventory + tests，不修改现有 symbols，提交前跑 detect 即可。
- 如果 Architect 要求修改 `App.tsx` 或现有 symbol，必须先跑：
  - `npx gitnexus impact App --repo llm_wiki --direction upstream --include-tests`
  - `npx gitnexus impact handleProjectOpened --repo llm_wiki --direction upstream --include-tests`
- 当前 `handleProjectOpened` impact 已是 `HIGH`。若本 PR 触碰其行为，必须先向用户报告 HIGH blast radius，再执行额外 gate；默认不触碰行为。

## Gate Plan

1. Commander 落本计划。
2. Architect 对抗审查本计划：
   - PR3 是否过度保守，还是足以满足 “bootstrap boundary cleanup”；
   - inventory 是否覆盖 `App.tsx` 的真实非 UI bootstrap 和 agent-adapter responsibilities；
   - 是否应避免把 inventory 放入 `src/core-runtime/contract/`；
   - 是否有 App startup 回归风险；
   - 是否需要在本 PR 加 App 行为测试。
3. Commander 吸收 P0/P1/P2 后再调 Coder 实现。
4. Tester gate：
   - 核查 inventory 覆盖矩阵；
   - 核查没有 runtime behavior change；
   - 核查 PR2 boundary checker 仍保护新增 core contract 文件。
5. Reviewer gate：ZCode external + internal Reviewer。

Fallback:

- Architect：Claude -> Kimi -> ZCode -> internal Architect。
- Tester：Kimi -> ZCode -> internal Tester。
- Reviewer：ZCode -> Claude/Kimi -> internal Reviewer。

## Validation

PR3 完成前至少通过：

```bash
pnpm exec vitest run src/core-runtime/contract/headless-contract.test.ts src/core-runtime/contract/boundary-check.test.ts src/core-runtime/contract/bootstrap-boundary.test.ts
pnpm test:mocks
pnpm lint
git diff --check
npx gitnexus detect-changes --repo llm_wiki --scope staged
```

如果 PR3 修改 `App.tsx` 行为，再追加相关 App/render/startup focused tests；没有现成 coverage 时，先补 mock-based test，再动行为。

## Unlock Criteria

PR3 合并后：

- `App.tsx` 非 UI bootstrap 候选有单一 inventory。
- PR4 可参考 inventory 中的 settings/storage/project-state 分类，但 PR4 的主 gate 仍是 ADR storage boundary lock 和 `app-state.json` schema lock。
- PR4/PR5 只做 re-categorize / contract tests，不做 `handleProjectOpened` extraction。
- `handleProjectOpened` 的高风险迁移保持 deferred 到 SPEC-2/runtime bootstrap extraction PR。
- 合并后回 `main`、`git pull --ff-only`、`npx gitnexus analyze`，确认 index up to date，再启动 PR4。
