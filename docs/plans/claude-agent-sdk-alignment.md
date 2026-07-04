# Claude Agent SDK Alignment

> 类型：alignment roadmap | 创建：2026-06-25 | 状态：active
> 上级：[Phase 7 Agent SDK productization](./agent-sidecar-phase6.1.md)

## 结论

Phase 7 前需要一个前置 PR 对齐 Claude Agent SDK latest stable。当前事实截至 2026-07-04（SPEC-7 PR1 落地时重新核验）：

- sidecar declared package range：`^0.3.201`
- locked version：`0.3.201`
- npm `latest`：`0.3.201`
- npm `next`：`0.3.201`

版本核验命令：

```bash
npm view @anthropic-ai/claude-agent-sdk dist-tags --json
```

PR 7-0 开工时必须重新运行该命令，并以当时 npm dist-tags 为准更新计划、PR body 和 reviewer packet。

本 docs PR 只记录路线，不升级依赖，不修改 sidecar，不改 package 或 lockfile。

## PR 7-0：Claude Agent SDK alignment

目标：在 timeline、rewind、permission 和 session productization 前，把 sidecar 跟进 SDK latest stable，并评估新旧 SDK 差异对现有 Agent 体验的影响。

Work items：

- 升级 `@anthropic-ai/claude-agent-sdk` 到 latest stable，并更新 sidecar lockfile。
- 重新验证 `query()` stream message schema、transport lifecycle 和 bundled sidecar build。
- 评估 `rewind_conversation` 对 #60 rewind lifecycle 的影响。
- 评估 `canUseTool` 是否新增或要求 `agent_id`，并同步 permission bridge。
- 评估 background/subagent permission 行为，确认本地 subagent/pipeline 权限边界不变。
- 评估 `tool_use_meta` / `icon_url` 是否可用于 tool timeline UI。
- 评估 structured rate-limit / credits / refusal errors，并映射到用户可理解的错误状态。
- 评估 `sandbox.credentials` 对本地 credential 注入、Keychain 读取和日志脱敏的影响。
- 对照 hooks、skills、plugins delta，确认现有透传、fallback 和 UI copy 是否需要调整。

## Non-goals

- 不在 docs PR 中升级依赖。
- 不在 docs PR 中改 sidecar。
- 不重新设计普通 Chat。
- 不把 upstream Chat Agent Router 和 Claude Agent SDK sidecar 合并。
- 不改变 token、API key、Keychain 和 sandbox 安全边界。

## Validation for Implementation PR

- `npm --prefix src-tauri/sidecar install` 或项目确认的包管理命令更新 lockfile。
- sidecar 单测和 smoke test 通过。
- Agent spawn、stop、permission approval、tool call、session resume/fork/continue 回归通过。
- Bundled sidecar build 通过。
- `git diff --check`、相关测试、`pnpm lint` 和 GitNexus detect changes 通过。
