# SPEC-5 PR1: Batch Planner / Batched Prepare Plan

> 类型：PR 执行计划 | 状态：merged via #236 | issue：#235 | tracking：#191 | branch：`codex/spec-5-pr1-batch-planner`

## Summary

本 PR 只交付批量知识编译的第一层：稳定 batch planner、最小 prepare plan payload、runtime diagnostics 所需的只读 TS wrapper 和只读 snapshot 聚合。它不创建/claim runtime jobs、不启动 worker、不调用 LLM、不写 staging artifact，也不改变 legacy `ingest-queue.ts` 行为。

## Scope

- 新增 shell-neutral bulk planner core 模块，把 source 列表规划为稳定 batched prepare plan。
- 默认 prepare batch size 为 10；输入顺序不同但 source identity 相同的列表应得到稳定 plan。
- Source identity 固定为 canonical source path；路径标准化为 `/` 分隔、去除首尾空白、折叠重复 `/`、移除前导 `./`。
- 对重复 source 做去重，并在 planner result 中保留 duplicate 计数；runtime diagnostics snapshot 不伪造 DB 中不存在的 duplicate 状态。
- 定义 PR1 级 prepare job spec / payload schema，供后续 PR2 worker pool adapter 序列化成 `RuntimeJobCreateRequest.payload`。
- Core planner payload types 必须自包含在 `src/core-runtime/parallel-knowledge/`，不得 import `@/commands/runtime-db` 或任何 Tauri wrapper 类型。
- 补齐 TS runtime wrapper：
  - `runtime_progress_list`
  - `runtime_timeline_list`
  - `runtime_staging_artifact_list`
- 新增 diagnostic snapshot 聚合，用于观察 jobs、progress、timeline、staging artifacts 的 empty/error states。
- 补 focused tests：planner idempotency、dedupe、batch sizing、wrapper payload、snapshot empty/error behavior。

## Non-goals

- 不启动 prepare worker pool。
- 不调用 `runtimeJobCreate` 或 `runtime_job_create`。
- 不持久化 planned jobs 到 runtime DB；PR2 负责持久化 adapter。
- 不 claim runtime jobs。
- 不 claim model-call profile。
- 不调用 LLM。
- 不写 staging artifact 内容。
- 不提交 final Markdown。
- 不修改 `src/lib/ingest-queue.ts` 的现有串行行为。
- 不重新定义 SPEC-3 commit operation 或 SPEC-4 profile pool eligibility。

## Key Files

- 新增：`src/core-runtime/parallel-knowledge/batch-planner.ts`
- 新增：`src/core-runtime/parallel-knowledge/batch-planner.test.ts`
- 新增：`src/lib/parallel-knowledge/runtime-diagnostics.ts`
- 新增：`src/lib/parallel-knowledge/runtime-diagnostics.test.ts`
- 修改：`src/commands/runtime-db.ts`
- 修改：`src/commands/runtime-db.test.ts`
- 修改：`docs/plans/README.md`
- 本计划：`docs/plans/SPEC-5/pr1-batch-planner-plan.md`

## GitNexus Impact

- `runtimeJobList`: LOW; direct affected test only `src/commands/runtime-db.test.ts`.
- `runtimeJobCreate`: LOW; direct affected test only `src/commands/runtime-db.test.ts`.
- `runtimeStagingArtifactRecord`: LOW; direct affected test only `src/commands/runtime-db.test.ts`.
- `RuntimeJobCreateRequest`: MEDIUM; many imports, but PR1 must not change this interface shape or import it from core-runtime.
- New planner and diagnostics symbols have no existing callers before this PR.

## Implementation Order

1. Add shell-neutral planner types and pure planning function. The output is a minimal flat prepare plan grouped by batch; it does not model explicit dependency edges until PR4/PR5 introduce commit/repair/map-reduce dependencies.
2. Add planner tests for stable source identity, duplicate handling, 10-source batch default, custom batch sizing, empty input, single source, and remainder batches such as 23 -> 10/10/3.
3. Add TS wrappers and typed request/response records for progress list, timeline list, and staging artifact list commands.
4. Add wrapper tests that assert exact Tauri command names and payload shape. Request types must match Rust serde field sets exactly:
   - progress/timeline list: `{ jobId?: string | null, limit?: number | null }`
   - staging artifact list: `{ jobId?: string | null, status?: string | null, limit?: number | null }`
5. Add diagnostics snapshot aggregation in `src/lib/parallel-knowledge/`, keeping Tauri command calls behind injected adapters for tests.
6. Add diagnostics tests for empty runtime, disabled/no-project states, partial failures, and artifact/progress/timeline aggregation. Partial list failure should return the successful lists plus a per-section error instead of failing the whole snapshot.

## Gate Plan

- Architect gate: Claude ACP preferred; Kimi/ZCode fallback; timeout `600000`.
  - Claude ACP session `92a3ecf6-5c6e-48ef-a5fa-af2a03f4a6c1` returned WARN; P1/P2 addressed by this plan revision.
- Coder: Commander may inline because PR1 is additive and avoids Rust DB / legacy ingest behavior changes.
- Focused tests:
  - `pnpm vitest run src/core-runtime/parallel-knowledge/batch-planner.test.ts src/lib/parallel-knowledge/runtime-diagnostics.test.ts src/commands/runtime-db.test.ts`
  - `pnpm vitest run src/core-runtime/contract/boundary-check.test.ts`
- Simplicity gate: internal Simplifier is acceptable; ZCode optional if diff grows beyond planned files.
- Tester gate: Kimi static packet, fallback ZCode/internal.
- Reviewer gate: ZCode external reviewer + internal reviewer.
- Merge standard: no unresolved P0/P1/P2; all scoped P3 fixed; CI green.

## PR Body Notes

- Record run id: `afc7c550-9cc7-407d-9178-a1ea657968df`.
- Record that Simplicity Gate ran because this is an implementation PR.
- Record that PR1 intentionally does not touch worker/profile routing; PR2 owns `model-call` profile pool usage.
- Record that PR1 intentionally does not persist jobs; PR2 owns converting planner output to runtime job creation.
