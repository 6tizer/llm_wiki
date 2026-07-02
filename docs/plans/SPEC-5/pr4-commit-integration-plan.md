# SPEC-5 PR4: Commit Operation Integration

> 类型：PR 执行计划 | 状态：merged via #242 | issue：#241 | tracking：#191 | branch：`codex/spec-5-pr4-commit-integration` | run：`8a94310a-0e90-4af3-841a-42caf0a06902`

## Summary

本 PR 把 PR3 的 validated staging artifact 接入 SPEC-3 Markdown commit operation。它只做 commit integration：读取 pending staging artifact metadata/body，按 affected path claim commit budget，调用 `commitMarkdownArtifact`，冲突进入 markdown repair route，成功后清理 staging artifact 并记录 derived stale marker。

## Scope

- 新增 parallel-knowledge commit integration，消费 `runtime_staging_artifacts` 中带 commit metadata 的 `pending` artifact。
- 把 `RuntimeStagingArtifactRecord` 转成 `MarkdownCommitArtifact`，缺少 `targetPath` / `operationIntent` / `sourceKind` 时拒绝。
- 新增 narrow runtime command / TS wrapper：按已登记 artifact 读取 runtime staging body；不让前端自行拼 staging 文件路径。
- 默认 adapter 只通过 SPEC-3 commit layer 写 final Markdown：
  - `runtimeCommitBudgetClaim` / `runtimeCommitBudgetRelease`
  - `commitMarkdownArtifact`
  - `routeMarkdownConflictRepair`
  - `runtimeEventAppend`
  - `runtimeDerivedStaleMarkerRecord`
  - `runtimeStagingArtifactCommitSuccess`
- `readCommittedMarkdown` 必须用 `fileExists(targetPath)` guard；missing target 返回 `null`，不能让通用 `readFile` 的 missing-file error 把 create/append 误判为 `rejected`。
- 成功 commit 或 merge 后记录 derived stale marker，覆盖 `embedding`、`graph`、`taxonomy`、`synthesis`。
- derived marker 字段固定映射：
  - `reason = operationIntent === "delete" ? "delete" : "commit"`
  - `inputHash = null` for delete，其他 intent 使用 `result.finalHash`
  - `baseVersion = result.currentHash ?? result.baseHash ?? "genesis"`
  - 每个 layer 单独调用 `runtimeDerivedStaleMarkerRecord`
  - commit audit `eventId` 和 marker `markerId` 使用 deterministic key；crash retry 遇到 duplicate event / marker insert 时按幂等成功处理，避免重复 event / marker 堆积。
- commit conflict / base hash mismatch 不 silent overwrite，必须保留 staging artifact 并创建 repair job。
- resume reconciliation：
  - create/update conflict 时若 committed target 的 hash 已等于 staged artifact hash，视为 crash-after-write-before-cleanup 的 already-committed outcome；跳过 repair，继续 event / marker / `commit_success` 收尾。
  - append conflict 不做尾部内容启发式或 `currentHash === artifactHash` 自动合并；即使 target 已以 staged append body 结尾或刚好等于 staged segment，也走 repair，避免把并发写误判为 already-merged 并静默丢 append。
  - delete 对 missing target 返回 `skipped` 时视为终态 delete cleanup，避免 artifact 永久 pending。
- 同路径并发语义：
  - 本地 concurrency guard 使用 `normalizeCommitTargetPath(...).resourceKey`。
  - 若 DB commit budget 返回 `commit-path-already-claimed`，该 artifact 保持 `pending`，结果计入 retryable skip，后续 pass 可重试；不能 terminal fail，不能清 staging。
- 写 progress / result summary，供 PR6 Runtime Diagnostics 展示 commit/staging 状态。
- 缺少 commit metadata 的 pending artifact 只 skip-and-log，不进入 repair route。
- 确定性 rejected（如 `artifact-hash-mismatch` / `unsupported-operation`）标记 staging artifact 为 `failed`，避免每次 commit pass 无限重试；非确定性 rejected 保持 pending。

## Non-goals

- 不新增 commit queue。
- 不把 prepare worker 与 commit worker 强绑定。
- 不绕过 SPEC-3 commit operation 直接写 final Markdown。
- 不实现 map-reduce。
- 不做 UI。

## GitNexus Impact

- `commitMarkdownArtifact`: LOW；当前无上游调用，PR4 是首个实际 consumer。
- `runtimeStagingArtifactList`: LOW。
- `runtimeStagingArtifactCommitSuccess`: LOW。
- `runtimeCommitBudgetClaim`: LOW。
- `runtimeDerivedStaleMarkerRecord`: LOW。
- `routeMarkdownConflictRepair`: LOW。
- 未发现 HIGH / CRITICAL 风险。

## Implementation Plan

1. 增加 `runtime_staging_artifact_read_body` Rust command：只接受 `artifactId`，从 metadata 解析 artifact path，校验 pending 状态并复用 staging path safety 读取 body。
2. 在 `src/commands/runtime-db.ts` 增加 typed wrapper / request / response。
3. 新增 `src/lib/parallel-knowledge/commit-integration.ts`：
   - `commitPendingStagingArtifacts` 读取 pending artifacts。
   - bounded concurrency，默认串行，按 normalized target resource key 防同路径并发。
   - 对每个 artifact 调 `commitMarkdownArtifact`。
   - 汇总 committed / merged / conflicted / rejected / skipped / retryable / errors。
4. 增加默认 commit adapter：
   - 用 narrow staging body command 读 body。
   - 用 `fileExists` guard + `readFile` / `writeFileAtomic` / `deleteFile` 访问 committed Markdown。
   - 用 runtime event 和 derived marker wrappers 写审计/marker。
   - 用 markdown repair adapter 路由冲突。
5. 在 wrapper 层处理 already-committed reconciliation，不改 SPEC-3 commit operation 的 base-hash matrix。
6. 更新 docs index：PR3 merged，当前执行 PR4。
7. Focused tests 覆盖同路径并发、base hash conflict、repair job queued、commit-success cleanup、derived marker recorded、missing commit metadata skipped、missing file maps to null、already-committed resume。

## Architect Gate Notes

- Claude ACP Architect Gate session `49dc16c9-dcef-4dd3-9cc4-4091c8b19459` returned `BLOCK`.
- Absorbed P1/P2 before coding:
  - Missing-file `readFile` error must map to `null`.
  - Derived marker request fields must satisfy Rust validation.
  - Crash-after-write-before-`commit_success` must reconcile for full-content create/update equality; append conflicts must route repair instead of relying on ambiguous suffix matching.
  - Same-path contention must leave loser pending and retryable.
- P3 folded into tests:
  - Rust read-body command safety tests.
  - Explicit commit budget TTL.
  - Missing metadata pending artifact skip.
  - Deterministic marker id.

## Post-PR Review Notes

- Claude ACP post-PR review session `f34c4f7f-9643-4ccb-879c-dbdbc8a03d0b` returned `WARN`.
- P2 fixed in PR:
  - Removed append suffix-based and exact-hash auto reconciliation; append conflicts now route repair even if the current target ends with or equals the staged append segment.
- P3 fixed in PR:
  - Commit audit event id and derived marker id are stable across crash retries; duplicate insert errors are treated as idempotent.
  - Terminal rejected artifacts are marked `failed` instead of staying pending forever.

## Gate Plan

- Architect Gate：Claude ACP 优先；不可用时 ZCode/Kimi fallback，timeout `600000`。
- Focused tests 通过后跑 Simplicity Gate；本 PR 涉及 runtime/Rust + shared commit path，用 ZCode read-only simplicity reviewer。
- Tester Gate：Kimi read-only tester。
- Reviewer Gate：ZCode + internal Reviewer。
- 合并标准：无 unresolved P0/P1/P2，修复本 PR scoped P3，CI green。

## Test Plan

- `pnpm vitest run src/lib/parallel-knowledge/commit-integration.test.ts src/commands/runtime-db.test.ts src/commands/markdown-commit-repair.test.ts src/core-runtime/markdown-commit/commit-operation.test.ts`
- `cargo test staging_artifact --manifest-path src-tauri/Cargo.toml`
- `pnpm lint`
- `pnpm test`
- `cargo test --manifest-path src-tauri/Cargo.toml`
- `npx gitnexus detect-changes --repo llm_wiki --scope staged`
