# SPEC-5 PR2: Prepare Worker Pool / Model-call Profile Routing

> 类型：PR 执行计划 | 状态：merged via #238 | issue：#237 | tracking：#191 | branch：`codex/spec-5-pr2-prepare-worker-pool` | run：`df217dc3-8d7e-46d5-b55d-81144ede39e2`

## Summary

本 PR 交付批量 prepare 的执行底座：bounded worker pool、只 claim `bulk-knowledge-prepare` jobs、通过 `model-call` runtime profile pool 分配 `taskFamily=ingest` profile，并把 worker/profile claim/backoff 写入 runtime timeline/progress。

它不解析 staging artifact、不提交 Markdown、不做 map-reduce、不改 legacy 串行 ingest 队列。真实内容生成在本 PR 先通过可替换的 model-call executor contract 封装；后续 PR3/PR5 接入具体 artifact schema 和长文分析。

## Scope

- 新增 scoped runtime job claim command / TS wrapper，只 claim 指定 `kind` 的 queued job。
- 保持现有 `runtime_job_claim` 和 `RuntimeJobClaimRequest` 语义不变。
- 新增 prepare worker pool 模块，支持 bounded concurrency、worker id/holder、job lease lifecycle、profile claim/release。
- Prepare worker 只处理 `BULK_KNOWLEDGE_PREPARE_JOB_KIND`。
- Profile claim 固定使用：
  - `kind: "model-call"`
  - `taskFamily: "ingest"`
  - `jobId: claimed.job.jobId`
  - `holder: "bulk-prepare:<workerId>"`
- Worker 只写 worker lifecycle、job claimed、job completed/failed、profile claim failure/backoff 的观测 payload。
- Profile claim success / release success / release rate-limit / release error 由 Rust profile pool 在传入 `jobId` 时自动写 timeline/progress；PR2 不重复写这些 rows。
- `runtime_event_append` 的 event name 是固定的 `EVENT_APPENDED_NAME`；worker 自定义语义必须放在 payload JSON 中，供 PR6 diagnostics 解析。
- Model-call executor 使用 injectable interface；PR2 不实现真实 secretRef -> provider 调用。真实后端 secret 解析和 provider execution 必须由后续 Rust command 承接，secret 不进入 frontend worker。
- Tests 使用 fake executor / fake runtime adapter 覆盖并发、scoped claim、profile release success/error/rate-limit、job fail/retry path。

## Non-goals

- 不实现 staging artifact parser/validator；PR3 负责。
- 不写 final Markdown；PR4 负责 commit operation integration。
- 不实现 long-document map-reduce；PR5 负责。
- 不做 Runtime Diagnostics UI；PR6 负责展示和控制。
- 不把 legacy single-active provider 作为 prepare primary path。
- 不修改 `src/lib/ingest-queue.ts` 既有串行行为。
- 不扩展 `RuntimeJobClaimRequest`，避免影响老 job claim 语义和测试矩阵。
- 不重新定义 profile pool success/release/backoff 业务规则。
- 不承诺长时 model-call lease heartbeat 完整性；PR2 fake executor 必须是短任务，真实 executor PR 必须补 heartbeat/renew。

## Key Files

- 新增：`src/lib/parallel-knowledge/prepare-worker-pool.ts`
- 新增：`src/lib/parallel-knowledge/prepare-worker-pool.test.ts`
- 修改：`src/commands/runtime-db.ts`
- 修改：`src/commands/runtime-db.test.ts`
- 修改：`src-tauri/src/commands/runtime_db.rs`
- 修改：`src-tauri/src/lib.rs`
- 修改：`docs/plans/README.md`
- 本计划：`docs/plans/SPEC-5/pr2-prepare-worker-pool-plan.md`

## GitNexus Impact

- `runtime_job_claim`: LOW; direct affected callers/processes 0. PR2 will not change its semantics.
- `RuntimeJobClaimRequest`: CRITICAL; 13 impacted symbols / 5 runtime DB test processes. PR2 will not edit this struct.
- `runtimeJobCreate`: LOW; direct affected test only.
- `runtimeJobList`: LOW; direct affected test only.
- `runtimeProfilePoolClaim`: LOW; direct affected test only.
- `runtimeEventAppend`: LOW; direct affected test only.
- `BULK_KNOWLEDGE_PREPARE_JOB_KIND`: LOW; no existing callers beyond PR1 test surface.
- `planBulkKnowledgePrepare`: LOW; direct affected planner test only. PR2 consumes the PR1 output shape but does not modify planner behavior unless Architect Gate requires a small compatibility export.

## Implementation Order

1. Add Rust request/command for scoped claim, for example `RuntimeJobClaimByKindRequest` + `runtime_job_claim_by_kind`, and register it in Tauri command list.
2. Factor shared internal claim helper so unscoped claim remains byte-for-byte behavior compatible except through shared implementation.
3. Add Rust tests:
   - scoped claim skips other queued job kinds.
   - scoped claim preserves priority/queued ordering within the requested kind.
   - unscoped `runtime_job_claim_for_project` still claims the global highest-priority queued job.
   - scoped claim rejects empty/invalid kind and returns no queued job for missing kind.
4. Add TS wrapper types/functions for:
   - `runtimeJobClaimByKind`
   - `runtimeJobHeartbeat`
   - `runtimeJobComplete`
   - `runtimeJobFail`
   - `runtimeProgressAppend` if worker needs durable progress writes from frontend-side adapter.
   - Required interfaces: `RuntimeJobClaim`, `RuntimeJobLeaseRequest`, `RuntimeJobFailRequest`, `RuntimeJobClaimByKindRequest`, and `RuntimeProgressAppendRequest`.
5. Add `prepare-worker-pool.ts` with injected runtime adapter and injected model-call executor.
6. Implement bounded worker execution:
   - claim prepare job by kind.
   - claim `model-call`/`ingest` profile for that job.
   - treat runtime-disabled as graceful idle/no-op, and treat non-healthy profile pool status as profile unavailable.
   - execute fake-safe model-call contract.
   - release profile with `success`, `rate-limited`, or `error`; `rate-limited` must include `retryAfterMs`.
   - complete or fail runtime job based on executor result.
7. Add worker-owned progress/timeline payload helpers only for worker lifecycle, job claim, job terminal state, and profile claim failure/backoff. Do not duplicate profile claim success or release rows already emitted by Rust profile pool.
8. Add focused Vitest coverage for worker pool concurrency, no-job exit, profile unavailable handling, profile release outcome mapping, and lease completion/fail calls.
9. Update README execution order to show PR1 merged by #236 and PR2 current.

## Architect Gate Findings Absorbed

- Claude ACP session `8477fb55-0322-4dbd-81e3-65e1dbeefa9f` returned WARN.
- P1 absorbed: profile pool success/release events are backend-owned when `jobId` is supplied; worker must not re-emit them.
- P2 absorbed: worker timeline semantic names are encoded in payload JSON because `runtime_event_append` uses a fixed event name.
- P2 absorbed: fake executor path assumes short calls; heartbeat during long real execution is a follow-up for the real backend executor PR.
- P2 absorbed: runtime-disabled and non-healthy pool behavior must mirror the `agent-transport.ts` pattern.
- P2 absorbed: `rate-limited` release must include `retryAfterMs`.
- P2 absorbed: real secret resolution is not implemented in frontend TS; a later Rust command owns the real provider executor.
- P3 absorbed: Rust tests should include scoped claim interaction with active leases and make an explicit choice on `deny_unknown_fields`.

## Gate Plan

- Architect Gate：Claude ACP，timeout `600000`；fallback Kimi/ZCode/internal。
- Coder：Commander may inline only if Architect confirms the scope remains additive and bounded; Rust DB edits require extra focused tests.
- Focused tests before Simplicity:
  - `pnpm vitest run src/lib/parallel-knowledge/prepare-worker-pool.test.ts src/commands/runtime-db.test.ts`
  - `cd src-tauri && cargo test runtime_job_claim`
  - Rust focused tests must cover scoped claim filtering, priority ordering inside kind, unscoped compatibility, missing kind, and active-lease interaction.
  - TS focused tests must cover runtime-disabled no-op, non-healthy profile pool, rate-limited release with `retryAfterMs`, and fixed event-name payload encoding.
- Simplicity Gate：ZCode read-only simplicity reviewer because this PR touches Rust DB + shared runtime; fallback internal Simplifier.
- Tester Gate：Kimi static packet, timeout `600000`; fallback ZCode/internal.
- Reviewer Gate：ZCode external reviewer + internal reviewer.
- Final verification:
  - `pnpm lint`
  - `pnpm test`
  - `git diff --check`
  - `npx gitnexus detect-changes --repo llm_wiki --scope staged`

## PR Body Notes

- Record run id `df217dc3-8d7e-46d5-b55d-81144ede39e2`.
- Record CRITICAL impact on `RuntimeJobClaimRequest` and that PR2 avoided changing it.
- Record scoped claim command as additive compatibility path.
- Record Simplicity Gate result because this is implementation PR touching Rust DB/shared runtime.
- Record any fallback executor boundary and exit condition for later PR3/PR5 integration.
