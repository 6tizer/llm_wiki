# SPEC-4-FIX: Model Profiles Closeout

> 类型：阶段 SPEC | 状态：planned / ready for PR split | 覆盖：SPEC-1 到 SPEC-4 完成后 Dev App 手测问题 | 依赖：SPEC-1、SPEC-2、SPEC-3、SPEC-4

## 目标与成功标准

收口 SPEC-4 合并后暴露的 Profile / Settings / Agent-run Profile 基座问题，让后续 SPEC-5 并行 pipeline 和 SPEC-7 Unified Agentic Chat 能可靠建立在 runtime profiles 之上。

成功标准：

- Model Profiles 支持完整 lifecycle：创建、编辑、探测、禁用、删除。
- 删除 profile 不破坏 active claim、历史 claim、circuit breaker 和 secret boundary。
- Model Profiles 在 Settings 中成为 LLM 模型的同级入口；LLM 模型页只表达 legacy/default provider，不再暗示系统只能支持一个 LLM。
- OKF/KW 本地扩展项在 Settings 信息架构中有清楚归属，不被误判为 upstream 残留。
- Agent-run profile 能正确表达 Claude Agent SDK 兼容配置：auth env、base URL、SDK model alias、direct provider 或 optional gateway。
- Capability UI 能区分 HTTP Messages probe 与 Agent SDK preflight；SDK model rejected / gateway auth failed 进入 profile diagnostic 和 pool 熔断/退避。
- 本 SPEC 只补 SPEC-4 基座，不实现 SPEC-5 worker pool、SPEC-7 Unified Chat 产品控制面或 SPEC-8 QA fixture。

## 关键设计决策

- 只新增这一个补充 SPEC；Runtime Diagnostics、Agent controls、QA fixture 分别回灌到 SPEC-5、SPEC-6、SPEC-7、SPEC-8。
- Profile 删除默认使用 soft delete：list/pool 默认过滤 deleted profile，claim 历史保留。
- active claim 阻止删除；删除成功后才 best-effort 清理 secret reference。
- `providerModelId` 和 `agentSdkModelId` 必须分开表达，避免把 provider 原生模型名盲传给 Claude Agent SDK。
- MiMo、DeepSeek、Kimi 等官方支持 Claude Code 的 Anthropic-compatible provider 优先走直连；LiteLLM 是 optional gateway，不是唯一方案。
- 不新增前端 profile secret read command；secret 仍只在 Rust / platform adapter 内解析。

## 预期 PR 拆分

1. Profile lifecycle：`runtime_profile_delete`、soft delete schema/migration、active claim block、list/pool 过滤、secret cleanup、UI 删除入口。
2. Settings/Profile IA：Model Profiles 独立入口、LLM 模型页 legacy/default provider 文案、OKF/KW Settings 分组、provider 到 runtime profile 创建路径说明。
3. Agent-run profile compatibility minimum：bearer/x-api-key env 映射、`agentSdkModelId`、direct Anthropic-compatible provider、LiteLLM optional gateway、Agent SDK preflight/diagnostic、SDK rejected 写入 profile diagnostic / circuit breaker。

## 验证策略

- Rust tests 覆盖 soft delete、active claim 阻止、deleted profile 不可 claim、secret 不从 command 返回。
- TS/UI tests 覆盖删除按钮、删除失败不清 secret、删除后选中态稳定、Model Profiles 新 Settings category。
- Sidecar/profile tests 覆盖 bearer -> `ANTHROPIC_AUTH_TOKEN`、x-api-key -> `ANTHROPIC_API_KEY`、`agentSdkModelId` 传给 SDK。
- Probe tests 区分 `messages-compatible`、`agent-sdk-compatible`、`sdk-model-rejected`、`gateway-auth-failed`。
- Dev App smoke 覆盖至少一个 direct Anthropic-compatible provider 和一个 optional gateway profile。

## Gate 结论摘要

本 SPEC 来自 `spec-1-4-post-test-findings.md` 的 SPEC-1 到 SPEC-4 完成后手测证据。实现 PR 必须重新按 PR-level workflow 跑 GitNexus impact、focused tests、Simplicity、Tester、Reviewer 和 detect；不能复用本 docs PR 的 gate 作为代码验收。

## Non-goals / Follow-up

- 不实现 SPEC-5 parallel worker pool。
- 不实现 SPEC-7 Unified Chat、profile selector、permission selector 或 timeline；SPEC-7 只消费本 SPEC 的 Agent-run compatibility 基座。
- 不新增独立 Runtime Diagnostics SPEC；可观察性要求回灌到 SPEC-5/6/7/8。
- 不把 LiteLLM 设为必需依赖。
- 不把 profile secret 写入 repo、runtime DB、日志、PR 或测试快照。
