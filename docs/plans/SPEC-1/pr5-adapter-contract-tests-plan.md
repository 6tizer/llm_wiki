# SPEC-1 PR5: Adapter Contract Tests Plan

> Status: gates PASS / ready for PR | Branch: `codex/spec-1-pr5-adapter-contract-tests` | Owner: Commander

## Goal

证明 Core Runtime contract 可以被 mock UI shell / platform adapter / storage boundary / agent adapter 在 headless 环境下调用，不依赖 React render、Zustand store、Tauri plugin-store 或真实平台 side effects。

PR5 是 SPEC-1 的收口 PR：它不实现 SPEC-2 runtime DB，不迁移旧业务逻辑，只把 PR1-PR4 的边界产物连成一组 adapter contract tests，让后续 SPEC-2/3/4 能以这些 contract tests 作为入口。

## Inputs

- [`../spec-1-app-architecture-decomposition.md`](../spec-1-app-architecture-decomposition.md)
- [`adr-shell-core-boundary.md`](./adr-shell-core-boundary.md)
- [`pr3-bootstrap-boundary-plan.md`](./pr3-bootstrap-boundary-plan.md)
- [`pr4-store-boundary-plan.md`](./pr4-store-boundary-plan.md)
- `src/core-runtime/contract/index.ts`
- `src/core-runtime/contract/boundary-check.ts`
- `src/core-runtime/contract/bootstrap-boundary.ts`
- `src/core-runtime/contract/store-boundary.ts`
- Existing contract tests under `src/core-runtime/contract/*.test.ts`

## Current State

PR1 froze the runtime family names and the minimal `createMockCoreRuntimeContract()` skeleton.

PR2 added static import enforcement so core contract modules cannot import React, Zustand, Tauri APIs, command wrappers, UI stores, components, or runtime persistence directly.

PR3 recorded current `App.tsx` bootstrap responsibilities and target adapter/family ownership without moving behavior.

PR4 recorded store boundary ownership, Rust-locked `app-state.json` keys, Zustand mirror categories, secret-bearing settings, and SPEC-2 deferred runtime/job truth.

What is still missing:

- Adapter role matrix tests that prove which runtime families each mock role may drive or must not own.
- A mock shell adapter that invokes frozen runtime families without rendering React, without re-testing PR1's exact placeholder names.
- Mock platform / storage / agent adapter ports that prove adapter-facing tests can be written without Tauri plugin-store or real sidecars.
- Cross-checks that PR3 bootstrap candidates and PR4 store categories can be consumed by adapter contract tests without turning inventory docs into runtime behavior.

## Scope

1. Add adapter contract test support under `src/core-runtime/contract/`.
   - Prefer pure TypeScript types/constants/helpers.
   - No React, Zustand, Tauri, plugin-store, command wrapper, runtime DB, filesystem side effect, network side effect, or real sidecar dependency.
   - Keep helpers inert and deterministic.
2. Add adapter contract tests:
   - define a role/family matrix that is not covered by PR1/PR2.
   - mock shell can drive every runtime family through the core contract without React render, but tests must assert family/direction capability rather than exact placeholder message names.
   - mock platform adapter surface is limited to `file-platform` and `process-cli`.
   - `settings-status` remains Core Runtime / UI Shell visible status, not Platform Adapter ownership.
   - mock storage boundary imports PR4 `STORE_BOUNDARY_ENTRIES` directly as metadata only; it must not treat plugin-store `app-state.json` as runtime/job truth.
   - mock agent adapter is limited to `agent-run` and does not own `process-cli`; sidecar process needs are represented as cross-adapter coordination through Core Runtime.
   - all new contract files pass `checkCoreRuntimeBoundary`.
3. Update docs:
   - add this PR5 plan to `docs/plans/README.md`.
   - update SPEC-1 PR table: PR4 merged, PR5 active / pending Architect.

## Non-goals

- 不实现真实 adapter。
- 不修改 `src/App.tsx`。
- 不修改 `src/lib/project-store.ts`、Zustand stores、`src/commands/*.ts` 或 Rust 代码。
- 不引入 runtime DB schema。
- 不定义 SPEC-2 job state machine。
- 不把 placeholder payload 升级成 stable wire schema。
- 不读取/写入真实 `app-state.json`、project files、Keychain、network、sidecar process。

## Proposed Shape

Files:

- `src/core-runtime/contract/adapter-contract.ts`
- `src/core-runtime/contract/adapter-contract.test.ts`

Export policy:

- `adapter-contract.ts` may export test-support types/helpers for direct test imports.
- `src/core-runtime/contract/index.ts` must not re-export adapter mock helpers.
- PR5 must add a guard that `index.ts` does not contain `adapter-contract`.

Role-specific type shape:

```ts
export type AdapterContractRole =
  | "ui-shell"
  | "platform-adapter"
  | "storage-boundary"
  | "agent-adapter";

export type AdapterFamilyMatrix = {
  readonly "ui-shell": readonly RuntimeContractFamily[];
  readonly "platform-adapter": readonly ("file-platform" | "process-cli")[];
  readonly "storage-boundary": readonly ("settings-status" | "project" | "job-runtime")[];
  readonly "agent-adapter": readonly ["agent-run"];
};

export type MockAdapterContract<Role extends AdapterContractRole> = {
  readonly role: Role;
  /** RuntimeContractFamily values this adapter role may drive or expose. */
  readonly allowedFamilies: AdapterFamilyMatrix[Role];
  readonly forbiddenFamilies: readonly RuntimeContractFamily[];
  /** Import path globs or exact specifiers forbidden for this adapter test helper. */
  readonly forbiddenDependencies: readonly string[];
};
```

Helper behavior:

- `createMockShellAdapter(contract)` calls `contract.listMessages()` and drives each family/direction pair by capability, without asserting exact placeholder names.
- `createMockPlatformAdapterContract()` declares only platform-owned families (`file-platform`, `process-cli`) as capabilities.
- `createMockStorageBoundaryContract()` references PR4 `STORE_BOUNDARY_ENTRIES` as metadata and asserts runtime/job entries stay `runtime-db-deferred`; its `allowedFamilies` are `RuntimeContractFamily` values, not PR4 `StoreBoundaryOwner` names.
- `createMockAgentAdapterContract()` declares only `agent-run`.
- `createAdapterCoordinationMatrix()` can describe allowed cross-adapter coordination, for example `agent-run` may require Core Runtime to call `process-cli`, but Agent Adapter must not own `process-cli`.

PR5-specific evidence not already covered by PR1/PR2:

- role/family matrix blocks wrong ownership such as Platform Adapter owning `settings-status`.
- mock helper not re-exported from public frozen contract index.
- storage mock consumes PR4 metadata directly and keeps runtime/job truth deferred.
- agent mock cannot claim `process-cli`.
- shell mock drives families by capability instead of placeholder name strings.
- coordination matrix proves `agent-run` may coordinate with `process-cli` through Core Runtime while Agent Adapter still forbids direct `process-cli` ownership.

## Hard Invariants

- New implementation files must pass `checkCoreRuntimeBoundary`.
- New tests must not render React and must not import `@/stores/*`, `@/commands/*`, `@tauri-apps/*`, `zustand`, `react`, or `@/lib/runtime.db`.
- Mock shell must exercise every `RUNTIME_CONTRACT_FAMILIES` family by family/direction, not by exact placeholder message names.
- Adapter roles must be explicit; do not collapse UI shell, platform adapter, storage boundary, and agent adapter into one generic mock.
- Adapter mock helpers are test-support only and must not be re-exported from `src/core-runtime/contract/index.ts`.
- The no-re-export guard should check the public index surface semantically where practical, not rely only on a comment-sensitive string check.
- Platform Adapter mock must not include `settings-status`.
- Agent Adapter mock must not include `process-cli`.
- Storage mock must import PR4 store metadata directly and consume it as metadata only.
- Runtime/job truth remains SPEC-2 deferred.
- Secret-bearing PR4 entries must remain metadata references only; tests must not contain secret values.
- PR5 must not modify existing runtime behavior files.

## GitNexus / Impact Rules

- Planning/docs stage does not modify code symbols; no impact required.
- Adding new pure contract/test files does not require upstream impact; run GitNexus detect before commit.
- If implementation changes existing exported contract symbols in `src/core-runtime/contract/index.ts`, run:

```bash
npx gitnexus impact createMockCoreRuntimeContract --repo llm_wiki --direction upstream --include-tests
```

- If implementation touches `project-store.ts`, `wiki-store.ts`, `App.tsx`, `src/commands/*`, or Rust, stop and run targeted impact plus user warning.

## Gate Plan

1. Commander writes this PR5 plan.
2. Architect adversarial review:
   - whether adapter contract tests prove the PR5 goal or merely duplicate PR1/PR2 tests;
   - whether the test-support helper file is safely excluded from `index.ts`;
   - whether direct import of PR4 store-boundary metadata stays metadata-only;
   - whether platform/storage/agent mock roles are too broad;
   - whether tests overfit placeholder names and block SPEC-2 evolution.
3. Coder implements only after P0/P1/P2 are resolved.
4. Tester verifies headless adapter coverage and no forbidden imports.
5. Reviewer verifies final diff, scope, and test adequacy.

Fallback:

- Architect: Claude -> Kimi -> ZCode -> internal Architect.
- Tester: Kimi -> ZCode -> internal Tester.
- Reviewer: ZCode -> Claude/Kimi -> internal Reviewer.

Gate result:

- Architect: Claude failed due unavailable selected model; Kimi WARN with P1/P2 plan findings; ZCode focused recheck PASS after plan fixes.
- Tester: Kimi PASS with tool-safety WARN; internal Tester WARN with no P0/P1/P2.
- Reviewer: ZCode PASS with provider-overload noise after complete verdict; internal Reviewer BLOCK on untracked/ignored files and stale status, resolved by forced staging and status update.

External gate wait rule:

- Real external PR gates use at least `600000 ms / 10 minutes` wait windows unless they complete with a full verdict earlier.
- Timeout, provider overload, unsafe tool request, or incomplete/no verdict is WARN/BLOCK and must trigger fallback; it is never PASS.

## Validation

PR5 complete requires:

```bash
pnpm exec vitest run src/core-runtime/contract/headless-contract.test.ts src/core-runtime/contract/boundary-check.test.ts src/core-runtime/contract/bootstrap-boundary.test.ts src/core-runtime/contract/store-boundary.test.ts src/core-runtime/contract/adapter-contract.test.ts
pnpm test:mocks
pnpm lint
git diff --check
git diff --check --cached
npx gitnexus detect-changes --repo llm_wiki --scope staged
```

If PR5 changes existing exported contract behavior, add compatibility assertions for existing tests and rerun affected suites.

## Unlock Criteria

PR5 合并后：

- SPEC-1 的 five-PR boundary sequence 完成。
- Core Runtime contract 有 mock shell/adapter 级 headless tests。
- SPEC-2 Work Runtime 可以基于 mock adapter contract 开始设计 job/runtime DB，而不依赖 React render 或 Tauri plugin-store。
- 合并后回 `main`、`git pull --ff-only`、`npx gitnexus analyze`，确认 index up to date。
