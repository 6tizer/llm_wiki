# Phase 7: Agent SDK productization

> 类型：Phase backlog | 创建：2026-06-12 | 更新：2026-06-24 | 状态：backlog
> 文件名说明：保留 `agent-sidecar-phase6.1.md` 作为历史兼容路径；当前定位是 Phase 7。
> 上级：[Agent Sidecar 总规划](./agent-sidecar-roadmap.md)
> 前置：[Phase 6 upstream sync](./upstream-sync-phase6.md)、[Mac Product Baseline](./mac-product-baseline.md)

## 结论

本文件不再表示 Phase 6 的尾项，而是 Phase 7 backlog：Agent SDK productization。等 Phase 6 upstream `v0.5.0` P0/P1 同步和 Mac-only baseline 稳定后，再集中处理 Agent UX、session continuity、permission entry、QA fixture 和内部 RPC 评估。

#3 仍是内部 Rust-to-sidecar RPC 评估项，不默认实现。

## Scope

| Issue | 标题 | Phase 7 处理方式 |
|-------|------|------------------|
| [#60](https://github.com/6tizer/llm_wiki/issues/60) | Agent rewind fails after stream completion because retained Query transport is closed | Rewind lifecycle |
| [#65](https://github.com/6tizer/llm_wiki/issues/65) | Clarify Ingest/提取 mode vs Agent session summary behavior | Product copy / mode semantics |
| [#66](https://github.com/6tizer/llm_wiki/issues/66) | Handle Agent compact/resume summaries as session state, not normal assistant replies | Session state model |
| [#67](https://github.com/6tizer/llm_wiki/issues/67) | Agent resume can ignore corrective user input and execute its own previous pending question | Resume intent protection |
| [#68](https://github.com/6tizer/llm_wiki/issues/68) | Add Notion AI-style Agent activity timeline for intermediate replies, tool calls, and progress | Activity timeline |
| [#84](https://github.com/6tizer/llm_wiki/issues/84) | Agent 权限设置入口不明确，需要支持对话框和 Settings 双入口 | Permission entry |
| [#86](https://github.com/6tizer/llm_wiki/issues/86) | Phase 5 Agent 场景需要可重复的 UI 验收入口或 QA fixture | QA fixture |
| [#3](https://github.com/6tizer/llm_wiki/issues/3) | Explore internal RPC channel for embedded Agent wiki tools | Evaluation only by default |

## Preconditions

- Phase 6 remaining PRs have completed or routed upstream `v0.5.0` P0/P1 delta.
- `mac-product-baseline` has cleaned up Mac-only CI/release/app identity.
- Agent sidecar binary, Agent settings, Chat Agent mode, MCP resources and local HTTP API are stable after upstream sync.
- GitNexus index is current.

## PR 7-A：Agent session continuity and activity timeline

目标：把 Agent 中间过程、compact/resume、pending confirmation、resource limit 和工具调用整理成可理解的活动历史。

Work items：

- #66 compact/resume summaries 渲染为 session state，不作为普通 assistant reply。
- #67 新用户纠正消息优先级高于 resumed pending task。
- #68 Agent turn 下方提供 activity timeline，可展开 tool calls、permissions、wiki changes、progress。
- #86 dev-only QA fixture 能稳定触发 compact summary、pending question、rewind、resource limit error。
- Streaming 期间关键 Agent 状态有持久化或明确不可恢复提示。

验收：

- 普通 Chat 不显示 Agent timeline。
- Agent message 有 tool/activity 时显示 timeline。
- Correction/rejection 不触发误 resume。
- Fixture 可重复构造目标状态。

## PR 7-B：Agent rewind lifecycle

目标：让 rewind 行为和 SDK 能力一致，不能做的场景不展示误导性入口。

Work items：

- #60 确认 SDK 是否支持 completed-stream rewind。
- Active stream rewind 可用。
- Done/error/stop 后隐藏或禁用 rewind，避免 `ProcessTransport is not ready for writing` 成为用户可触发路径。

## PR 7-C：Agent permission entry and Ingest wording

目标：把 Agent 权限和 Ingest mode 的产品语义讲清楚。

Work items：

- #84 Agent 输入区顶部权限区域可操作。
- #84 Settings > Agent 提供完整权限配置，并说明作用范围。
- #65 调整中文 `提取` 等文案，区分 source ingest/extraction 和 Agent session summary。

## PR 7-D：Internal RPC evaluation

目标：重新评估 #3 是否需要实现。默认只产出架构结论，不直接开工。

Evaluation questions：

- MCP Server、local HTTP API、Agent sidecar 三者边界是否已经足够清楚。
- 内部 Agent 能力是否不应暴露到 local HTTP API。
- HTTP loopback 是否成为真实瓶颈。
- 若需要 Rust-to-sidecar RPC，明确 transport、schema、auth、lifecycle、cancellation、测试策略。

## Non-goals

- 不回滚 Phase 6 upstream sync。
- 不重新设计整个 Chat 架构。
- 不暴露模型隐藏 chain-of-thought。
- 不默认实现内部 RPC。
- 不把 API key、LLM token、jsonl 私有路径或项目敏感内容写入日志、PR 描述或测试快照。
