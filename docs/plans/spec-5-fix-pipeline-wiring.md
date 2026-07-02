# SPEC-5-FIX: Parallel Pipeline Wiring / 并行流水线接线与 Runtime Ledger Hardening

> 类型：阶段 SPEC | 状态：reviewed / ready for PR split | 覆盖：`spec-5-8-post-review-findings.md` 一 + 二（P0-pool / P0-budget）+ 三（并行流水线 / runtime P1）| 依赖：SPEC-2 runtime ledger、SPEC-3 commit layer、SPEC-5 parallel pipeline | 执行顺序：SPEC-6 硬前提，优先于 SPEC-6/7 实现

## 目标与成功标准

SPEC-5 PR1-PR6 已把 batch planner、prepare worker pool、staging validator、commit integration、long-document map-reduce、progress UI 各组件实现并单测覆盖，但深度 review 确认这些组件**在生产中从未端到端接线**：`enqueueBulkKnowledgePrepareJobs` 接到了 UI 按钮，`runPrepareWorkerPool` / `commitPendingStagingArtifacts` 却零生产调用点，也没有 `PrepareModelCallExecutor` 具体实现。本 SPEC 把流水线真正接通，并修复接通后必然暴露的 runtime ledger 崩溃/卡死缺陷。

成功标准：

- 点击 Sources "批量准备" 后，job 被真实 worker pool 认领、调用 model-call profile 执行 prepare、写入 staging、经 commit integration 提交为 Markdown，全链路无需手工触发。
- 存在生产级 `PrepareModelCallExecutor` 实现，通过 SPEC-4 model-call profile pool 路由，不再依赖测试 mock。
- worker 在长时 LLM 调用期间按 `heartbeatMinIntervalMs`（默认 5000ms）续租 job lease，慢调用（>120s job lease TTL）不再导致 `completeJob`/`failJob` 抛 `lease-expired`。
- `completeJob` / `failJob` / `progressAppend` 等 bookkeeping 调用被 try/catch 包裹并记入 `result.errors`，单点抖动不再 reject 整个 `runPrepareWorkerPool()`、不再丢弃全部 worker 汇总结果、不再泄露 lease / profile claim。
- 崩溃后过期 lease 有真实回收路径：`runtime_job_lease_timeout_for_project` 被提升出 dead-code，由注册的调度 tick 周期调用，卡在 `running` 的 job 能转 `retry-wait`/`failed` 并释放 lease。
- commit-path 预算 claim 崩溃后可自愈：容量检查过滤 `expires_at_ms > now`，或 `runtime_commit_budget_expire_for_project` 被真实调度接线，目标 Markdown 文件不再被孤儿 claim 永久锁死。
- prepare / map-reduce / conflict repair job 有真实消费者，或明确记录为下一阶段并从 pool 认领面移除，不再是结构性孤儿。
- UI 能区分"排队等待 worker"与"任务疑似卡死"，不再只显示一个永远转圈的 Loader。

## 关键设计决策

- 本 SPEC 是 SPEC-5 的补充收口（对齐 SPEC-4-FIX 模式），不改变 SPEC-5 的组件设计，只补接线 + 抗崩溃/抗卡死；不新增流水线能力。
- lease 续租机制照抄 job ledger 既有 `runtimeJobHeartbeat` API（`src/commands/runtime-db.ts:498`）和 contract `JobRuntimeDefaults.heartbeatMinIntervalMs`（`src/core-runtime/contract/index.ts:302-303`），不新造。
- 过期自愈优先采用 profile-pool 的 read-time `expires_at_ms > now` 过滤模式（`runtime_db.rs:7755`），避免 commit-budget 那套"声明过期却无 reader 过滤"的反模式。
- lease-timeout 回收调度器是 core-runtime 内部 tick，不绑定 React 组件生命周期，须 shell-neutral，供未来 Swift shell 复用（SPEC-9 触发条件）。
- 后台 prepare/commit 优先级低于用户前台触发的 ingest/repair/Agent run（与 SPEC-6 后台优先级约束一致）。
- repair job 消费者若本阶段不实现，必须显式记录并让 UI/诊断反映"repair pending 无消费者"，不留静默孤儿。

## 预期 PR 拆分

1. **worker pool driver + PrepareModelCallExecutor 接线**：把 `runPrepareWorkerPool` 接到 job 认领驱动，落地生产级 executor（走 model-call profile pool），Sources "批量准备" 端到端跑通。
2. **worker heartbeat + bookkeeping 抗崩溃**：worker 续租 lease；`completeJob`/`failJob`/`progressAppend` try/catch 化并记 `result.errors`；`processPrepareJob` while 循环容错，sibling worker 不被单点异常连带 reject；早失败路径释放 profile claim。
3. **lease 回收调度器**：提升 `runtime_job_lease_timeout_for_project` 出 dead-code，注册周期 tick，卡死 job 自动回收；补对应 headless contract test。
4. **commit budget 自愈**：容量检查过滤 expired claim（或接线 `runtime_commit_budget_expire_for_project`），孤儿 claim 不再永久锁死 targetPath；`isRetryableBudgetRejection` 对已自愈的 claim 行为正确。
5. **commit integration 接线 + append 自愈 + repair 消费者**：`commitPendingStagingArtifacts` 接入端到端；append 提交崩溃后可自愈或安全走 repair；prepare/map-reduce/conflict repair job 落地消费者或显式标记 pending。
6. **UI 卡死可见性**：Runtime Diagnostics / Runtime Jobs 区分"awaiting worker"与"疑似卡死"（基于 heartbeat/expiresAt 陈旧检测），修正 `prepareWaitingForWorker` 系统级 progress 误判和多 planId `Math.max` 进度失真。

## 验证策略

- integration fixture：Sources "批量准备" → job 被认领 → executor 调用（mock LLM）→ staging 写入 → commit 提交 Markdown，全链路无手工触发。
- fake worker + 慢 LLM 测试：LLM 调用跨越 job lease TTL，验证续租成功、complete/fail 不抛 lease-expired。
- 崩溃注入测试：bookkeeping 调用抛错时 pool 不整体 reject、返回汇总结果、无 lease/claim 泄露；worker 进程崩溃后 lease 被调度回收。
- commit budget 测试：release 失败后同 targetPath 可被重新 claim（自愈），不再无限 `commit-path-already-claimed`。
- repair path 测试：append 崩溃后重试可自愈或安全落 repair；repair job 有消费者或诊断反映其 pending。
- UI test：卡死 job 显示明确状态而非无限 Loader；多批次进度按 planId 正确聚合。

## Gate 结论摘要

本 SPEC 来自 `spec-5-8-post-review-findings.md` 的深度 review 证据。实现 PR 必须重新按 PR-level workflow 跑 GitNexus impact、focused tests、Simplicity、Tester、Reviewer 和 detect；不能复用本 docs PR 的 gate 作为代码验收。合并标准：无 unresolved P0/P1/P2、修复该 PR scoped P3、CI green 后由 Commander 合并。

## Non-goals / Follow-up

- 不新增流水线能力或改变 SPEC-5 组件设计。
- 不实现 SPEC-6 derived rebuild 调度；只保证 commit 会真实产生 derived stale marker 供 SPEC-6 消费。
- 不实现 SPEC-7 Unified Chat。
- 不把 profile secret / jsonl 私有路径写入日志、PR 或测试快照。
