# SPEC-1 PR2: Boundary Enforcement Plan

> Status: implemented / pending Tester + Reviewer gates | Branch: `codex/spec-1-pr2-boundary-enforcement` | Owner: Commander

## Goal

把 PR1 冻结的 shell/core boundary 变成可执行的静态契约：`src/core-runtime/**` 里的 core contract 代码不能直接依赖 React、Zustand stores、Tauri plugin APIs 或 plugin-store。PR2 只做边界 enforcement，不迁移 runtime 行为。

## Inputs

- [`../spec-1-app-architecture-decomposition.md`](../spec-1-app-architecture-decomposition.md)
- [`adr-shell-core-boundary.md`](./adr-shell-core-boundary.md)
- [`pr1-boundary-adr-plan.md`](./pr1-boundary-adr-plan.md)
- `src/core-runtime/contract/index.ts`
- `src/core-runtime/contract/headless-contract.test.ts`

## Scope

1. 增加纯 TypeScript 边界检查模块，优先放在 `src/core-runtime/contract/`：
   - 用 TypeScript AST 收集 static import、export-from、dynamic `import()`、`import type`、side-effect import、`import = require(...)`。
   - 输出结构化 violation，包含 file、specifier、reason。
   - 不读取真实文件系统，不依赖 React render、Zustand store 或 Tauri runtime。
   - 仅供 test-time enforcement 使用，不从 `src/core-runtime/contract/index.ts` re-export，不进入生产 contract surface。
2. 扩展 contract tests：
   - 扫描 `src/core-runtime/**/*.ts`，排除测试文件和声明文件。
   - 覆盖允许的纯 TS 相对 import。
   - 覆盖 forbidden negative fixtures：`react`、`react/*`、`zustand`、`zustand/*`、`@/stores/*`、`@/components/*`、`@/commands/*`、`@tauri-apps/*`、`@tauri-apps/plugin-store`、`@/lib/runtime.db`。
   - 覆盖动态 import、type-only import、re-export、import-equals 和 side-effect import。
3. 复用或收敛 PR1 `headless-contract.test.ts` 里的 import specifier AST helper，避免规则重复。
4. 更新 PR1 ADR 的 Enforcement Hooks 小节，标记 PR2 将静态规则落地；不改变 frozen command/event family。

## Non-goals

- 不迁移 `App.tsx` bootstrap。
- 不重构 `src/lib/ingest-queue.ts`、`src/lib/project-store.ts` 或 `src-tauri/src/lib.rs`。
- 不新增 lint 框架或外部依赖；优先用现有 TypeScript + Vitest。
- 不改变 runtime command/event inventory payload。
- 不把旧耦合模块一次性纳入阻断范围；PR2 只阻断新 core runtime 边界。

## Implementation Shape

预计新增或修改：

- `src/core-runtime/contract/boundary-check.ts`
- `src/core-runtime/contract/boundary-check.test.ts`
- `src/core-runtime/contract/headless-contract.test.ts`
- `docs/plans/SPEC-1/adr-shell-core-boundary.md`
- `docs/plans/SPEC-1/pr2-boundary-enforcement-plan.md`
- `docs/plans/README.md`

建议 API：

```ts
export type BoundarySourceFile = {
  readonly filePath: string;
  readonly sourceText: string;
};

export type BoundaryViolation = {
  readonly filePath: string;
  readonly specifier: string;
  readonly reason: string;
};

export function collectModuleSpecifiers(sourceText: string): readonly string[];
export function isForbiddenCoreImport(specifier: string): boolean;
export function checkCoreRuntimeBoundary(files: readonly BoundarySourceFile[]): readonly BoundaryViolation[];
```

这些 API 只由测试直接 import，不加入 `index.ts` 的 public export。`index.ts` 继续只暴露运行时契约符号，例如 `RUNTIME_CONTRACT_FAMILIES` 和 `createMockCoreRuntimeContract`。

扫描实现必须递归覆盖 `src/core-runtime/**/*.ts`，并排除：

- `**/*.test.ts`
- `**/*.spec.ts`
- `**/*.d.ts`
- `**/__fixtures__/**`

动态 `import()` 收集第一个参数即可，不能要求参数数量恰好为 1，避免漏掉带 options bag 的调用。

## GitNexus / Impact Rules

- PR2 计划文档阶段不触碰代码符号，无需 impact。
- 实现前如果修改 `src/core-runtime/contract/index.ts` 的导出符号，先跑：
  - `npx gitnexus impact --repo llm_wiki --target RUNTIME_CONTRACT_FAMILIES --direction upstream`
  - `npx gitnexus impact --repo llm_wiki --target createMockCoreRuntimeContract --direction upstream`
- 如果只新增 `boundary-check.ts` 并在测试中使用，仍在提交前跑 detect：
  - `npx gitnexus detect-changes --repo llm_wiki --scope staged`

## Gate Plan

1. Commander 落本计划。
2. Architect 对抗审查本计划：
   - rule scope 是否过宽或过窄；
   - forbidden specifier 是否覆盖 PR1 ADR；
   - AST parser 是否有 false negative；
   - `src/core-runtime/**/*.ts` 扫描是否会误伤测试或 fixture。
3. Coder 实现，必要时按 Architect 建议改计划。
4. Tester 独立验证：
   - 重点构造 forbidden import negative fixtures；
   - 确认旧 coupled modules 不被 PR2 误拦。
5. Reviewer 做最终 code review。

外部 gate fallback：

- Architect：Claude 优先；超时或不可用时 fallback Kimi，再 fallback ZCode，再 fallback 内部 Architect。
- Tester：Kimi 优先；若 plan-mode 行为异常或超时，fallback ZCode read-only tester，再 fallback 内部 Tester。
- Reviewer：ZCode 优先；失败时 fallback Claude/Kimi read-only reviewer，再 fallback 内部 Reviewer。

## Validation

PR2 完成前必须通过：

```bash
pnpm exec vitest run src/core-runtime/contract/headless-contract.test.ts src/core-runtime/contract/boundary-check.test.ts
pnpm test:mocks
pnpm lint
git diff --check
npx gitnexus detect-changes --repo llm_wiki --scope staged
```

## Unlock Criteria

PR2 合并后：

- `src/core-runtime/**` 的禁止依赖有自动化测试阻断。
- PR3 可以开始处理 `App.tsx` bootstrap boundary cleanup。
- 合并后必须回到 `main`，`git pull --ff-only`，运行 `npx gitnexus analyze` 并确认 index up to date。
