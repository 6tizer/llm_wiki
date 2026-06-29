# SPEC-4: Model Profiles / Provider Profiles / 多供应商并发

> 类型：阶段 SPEC | 状态：reviewed / ready for PR split | 覆盖：#185、#186 | 依赖：SPEC-1、SPEC-2

## 目标与成功标准

建立用户选择的 Profile 系统：用户决定 provider/model/profile，runtime 只在用户启用的 profiles 内调度，避免单供应商限流。

成功标准：

- Profile 绑定 provider、model、endpoint/base URL、auth、capability、concurrency budget。
- profile secret 必须存 OS Keychain / 系统安全存储；runtime DB 和项目文件只保存 secret reference、provider id、model id、非敏感配置。
- 区分 Model-call Profile 和 Agent-run Profile。
- Agent-run 仍基于 Claude Agent SDK，只有 Anthropic Messages compatible 或 gateway-adapted profile 可启用。
- profile capability probe 结果可缓存、可展示、可用于 scheduler。
- Agent-run Profile 当前绑定 Claude Agent SDK sidecar；若 native architecture ADR 重开并决定 sidecar 下沉 Rust，本 Profile 的 capability probe 必须同步修订。
- Profile schema、capability status 和 secret reference 通过 shell-neutral settings/runtime contract 暴露，供 Tauri/React 和未来 Swift shell 复用。

## 关键设计决策

- 不做自动替用户选模型；runtime 只做用户授权范围内的调度、限流、熔断。
- Model-call Profile 用于高并发、低副作用 prepare jobs。
- Agent-run Profile 用于工具、权限、文件修改、冲突修复、复杂探索。
- custom provider 不默认 Agent-capable，必须通过 probe。
- Agent-capable profile 不可用时，Unified Chat 不得静默降级成“看起来能执行工具但实际不能”的普通 Chat。允许的行为是：禁用工具/修改类动作、显示不可用原因和 Settings 修复入口；纯阅读/问答可走用户启用的 Model-call Profile。本条是 canonical fallback policy，SPEC-7 只引用不重定义。
- profile probe 是有成本的网络调用，必须受用户触发、缓存、退避和节流控制；不要在 Settings render 或每次 scheduler tick 自动探测。
- probe cache 失效条件至少包括：profile endpoint/model/auth 变更、用户显式 re-test、probe error 后退避到期、provider capability version 变更。

## 预期 PR 拆分

1. Profile schema + migration / storage，包括 Keychain secret reference。
2. Settings UI：profile create/edit/test、task family capability。
3. Capability probe：messages、streaming、tool use、system prompt、thinking block behavior、token counting、context/max output limits、auth style、Claude Agent SDK beta/context-management/checkpointing headers/options。
4. Scheduler integration：profile pool、concurrency、rate-limit、circuit-break。
5. Agent-run adapter：per-run env/config 注入，不改全局 provider。

## 验证策略

- 单测覆盖 profile validation、capability flags、task-family enablement。
- mock provider probe 覆盖 success、messages-only、stream-fail、tool-use-fail、auth-fail。
- scheduler tests 覆盖 user order/weight、concurrency budget、retry-after、circuit-break。
- Agent-run preflight 确认 unsupported profile 被禁用并给出原因。

## Gate 结论摘要

本 SPEC 随当前 docs PR 通过 PR-level gate；详见 [SPEC-0](./spec-0-roadmap-baseline.md) 的统一 gate 摘要。实现 PR 必须重新审查 secret storage、capability probe 成本、Agent-capable fallback、scheduler 限流和 Swift shell settings compatibility。

## Non-goals / Follow-up

- 不替换 Claude Agent SDK。
- 不把所有 LLM calls 包成 Agent run。
- 不把 provider 体系缩成 OpenAI vs Claude。
- 不把 profile secret 写进 repo、日志或 PR。
