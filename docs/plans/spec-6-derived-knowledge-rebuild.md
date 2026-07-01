# SPEC-6: Derived Knowledge Rebuild / 派生知识异步化

> 类型：阶段 SPEC | 状态：reviewed / ready for PR split | 覆盖：#189 | 依赖：SPEC-1、SPEC-2、SPEC-3 | 执行顺序：SPEC-5 commit/profile/runtime 使用路径稳定后推进

## 目标与成功标准

把 embedding、graph、taxonomy、synthesis、review/lint、optional index/overview 从 ingest 主链路拆出，变成可重建后台任务。

成功标准：

- commit layer 只写 derived stale marker，不同步阻塞 derived rebuild。
- derived job 可 retry、cancel、resume。
- 每个 derived output 记录 input hash/version，可检测 stale。
- UI 可先显示 committed Markdown，再显示派生层同步状态。
- 用户可手动 rebuild 指定 derived layer。
- search/graph/derived layer 尚未 ready 时，UI 必须明确显示 stale/building 状态；搜索可 fallback 到 committed Markdown keyword/file search，不能假装 vector/graph 已完整。
- derived state 通过 Core Runtime status API 暴露，供当前 Tauri/React shell 和未来 Swift shell 复用。
- UI 必须有明确入口展示 `dirty`、`building`、`stale`、`ready`、`failed`，可放在 Runtime Diagnostics、搜索/图谱状态面板或对应 derived layer 设置页，但不能只依赖命令行验证。

## 关键设计决策

- Derived knowledge = materialized/rebuildable output。
- `index.md` export 和 `overview.md` synthesis 是显式 job，不是 ingest 副作用。
- taxonomy sidecar 是治理层，不改写页面 frontmatter 作为唯一事实。
- embedding/vector index 仍是可替换 derived index，不是 source of record。
- Derived stale marker schema 由 SPEC-3 定义、SPEC-2 存储；本 SPEC 负责消费 marker 并调度 rebuild。
- marker consumption 必须有 debounce / merge window：同一 path/layer 的连续 commit 合并成最新输入版本，避免 rebuild 风暴。
- derived rebuild priority 低于 foreground prepare/commit；后台任务不能抢占用户正在触发的 ingest/repair/Agent run。

## 预期 PR 拆分

1. Derived stale marker consumption + debounce/merge window + derived job lifecycle。
2. Embedding rebuild job 化。
3. Graph/search/materialized metadata rebuild job 化。
4. Taxonomy/synthesis rebuild job 化。
5. Optional index export / overview synthesis command。
6. UI 状态：dirty、building、stale、ready、failed，包含手动 rebuild 入口和 fallback search 状态说明。

## 验证策略

- 单测覆盖 dirty marking、dedupe、stale detection、manual rebuild。
- fake worker tests 覆盖 retry/cancel/resume。
- integration fixture：commit Markdown 后 UI 可见正文，derived state 异步更新。
- 确认 ingest 不再等待 embedding/overview/index 完成才结束。
- UI / diagnostics tests 覆盖 stale/building/ready/failed 状态、manual rebuild、fallback keyword/file search。

## Gate 结论摘要

本 SPEC 随当前 docs PR 通过 PR-level gate；详见 [SPEC-0](./spec-0-roadmap-baseline.md) 的 PR Gate 结论统一摘要。实现 PR 必须重新审查 stale/building UI、fallback search、marker debounce、后台优先级和 shell-neutral derived status。

## Non-goals / Follow-up

- 不重新引入 mandatory `index.md` / `overview.md`。
- 不把 derived outputs 当 committed truth。
- 不在第一版实现所有高级 rebuild scheduling 策略。
