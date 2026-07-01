# SPEC-5: Parallel Knowledge Pipeline / 批量编译加速

> 类型：阶段 SPEC | 状态：reviewed / ready for PR split | 覆盖：#191 | 依赖：SPEC-1、SPEC-2、SPEC-3、SPEC-4

## 目标与成功标准

把逐篇串行 ingest 改造成批量并行 prepare + commit + repair 的知识编译管线。

成功标准：

- 支持按批次规划 jobs，例如 10 篇一组进入 prepare。
- source read / parse / chunk analysis / draft generation 可并行。
- final Markdown write 必须走 commit layer。
- commit integration 只把 validated staging artifacts 提交给 SPEC-3 commit operation；不在本 SPEC 重新定义 commit queue 或 Markdown write semantics。
- 大文档 chunk analysis 支持 map-reduce，而不是纯滚动 digest 串行依赖。
- 30 秒不是完整处理 2400 篇真实文档的 SLA；第一版只要求 scan、task planning、首批进度可见。完整处理时间按 source count、平均 token、profile concurrency、provider latency/rate limit 实测展示 ETA。
- batch planner、worker pool、progress/ETA 通过 Core Runtime API 暴露；UI shell 只订阅状态，不持有业务调度。
- PR2 起，prepare worker 的 LLM 调用必须走 `model-call` runtime profile pool；如临时保留 legacy `llmConfig` fallback，PR 计划必须写明 fallback 边界和退出条件。
- Runtime Diagnostics / progress UI 必须能观察 job DAG、worker profile assignment、profile claim/backoff、commit/staging 状态；不另开独立 Diagnostics SPEC。

## 关键设计决策

- bulk ingest 默认不更新 global pages。
- prepare jobs 只写 staging artifact。
- repair/review jobs 处理冲突、低置信度、schema 不合格、write failure。
- Agent-run Profile 用于异常修复，不默认一篇文档一个 Agent session。
- Model-call Profile 用于批量 prepare；worker pool 不直接依赖单活 legacy provider。
- map-reduce 长文分析允许 chunk 级部分成功；失败 chunk 产出 partial draft + repair job，而不是拖死整个 batch。

## 预期 PR 拆分

1. Batch planner：扫描 source，生成 job DAG，并定义 job/progress/diagnostic snapshot。
2. Prepare worker pool：bounded concurrency + `model-call` profile assignment，可观察 worker/profile claim。
3. Staging artifact parser/validator。
4. Commit operation integration：按 affected path 调用 SPEC-3 commit layer，不直接写 Markdown。
5. Long-document map-reduce analysis。
6. Progress / ETA / pause / resume / cancel UI，包含 Runtime Diagnostics 入口或等价可观察面。

## 验证策略

- 单测覆盖 DAG planning、batch sizing、idempotency、resume after restart。
- fake LLM tests 覆盖 parallel prepare、commit order、failed job retry。
- fault-injection tests 覆盖随机 LLM delay、worker kill/resume、same-path concurrent commit、provider rate-limit、partial map-reduce failure。
- conflict fixture 确认不会 silent overwrite。
- performance smoke：用 mock model 跑多文件批量，验证并发度和 progress。
- UI / diagnostics tests 覆盖 job DAG、worker profile assignment、profile claim/backoff、commit/staging 状态可见。

## Gate 结论摘要

本 SPEC 随当前 docs PR 通过 PR-level gate；详见 [SPEC-0](./spec-0-roadmap-baseline.md) 的统一 gate 摘要。实现 PR 必须重新审查 fault injection、resume/idempotency、partial map-reduce、commit-layer integration、model-call profile routing 和 shell-neutral progress/diagnostics API。

## Non-goals / Follow-up

- 不承诺固定分钟级处理完 2400 篇真实 LLM 编译。
- 不让 model-call worker 直接写 final Markdown。
- 不把 bulk ingest 与 derived rebuild 同步绑死。
