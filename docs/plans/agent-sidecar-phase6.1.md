# Phase 6.1: Agent UX 和架构后续，Phase 6 后开发

> 类型：Phase 实施计划 | 创建：2026-06-12 | 状态：候选
> 上级：[Agent Sidecar 总规划](./agent-sidecar-roadmap.md)
> 前置：[Phase 5.1 计划](./agent-sidecar-phase5.1.md)、[Phase 6 上游同步](./upstream-sync-phase6.md)

## 背景

Phase 5.1 先修安全边界和 QA 提取质量。Phase 6 再同步上游 v0.4.23 的 CLI、Embedding、MCP、Ingest、MinerU、Chat image、Theme、Graph 等改动。

剩下的开放 issues 多数是 Agent 体验和架构问题，集中在 Chat UI、resume/compact、rewind、权限设置和开发验收入口。这些区域会被 Phase 6 的 Chat、Settings、MCP、CLI 同步大幅触碰。提前做会增加冲突，也容易在同步后返工。

PR 5.1-A review 还发现一个非阻塞的持久化限制：当前 auto-save 在 streaming 期间跳过保存。如果应用在 `agent_action_required.resource_limit` 出现后、stream 结束前崩溃，`agentResourceLimit` 等临时状态可能丢失。这个问题属于 Agent streaming 状态持久化和崩溃恢复，不阻塞 Phase 5.1-A 的资源限制闭环，放到 Phase 6.1 的会话连续性工作里处理。

**结论**：Phase 6.1 等 Phase 6 完成后再开，基于同步后的稳定代码做 Agent UX 和架构补强。

---

## 纳入范围

| Issue | 标题 | 处理阶段 |
|-------|------|----------|
| [#60](https://github.com/6tizer/llm_wiki/issues/60) | Agent rewind fails after stream completion because retained Query transport is closed | Phase 6.1 |
| [#66](https://github.com/6tizer/llm_wiki/issues/66) | Handle Agent compact/resume summaries as session state, not normal assistant replies | Phase 6.1 |
| [#67](https://github.com/6tizer/llm_wiki/issues/67) | Agent resume can ignore corrective user input and execute its own previous pending question | Phase 6.1 |
| [#68](https://github.com/6tizer/llm_wiki/issues/68) | Add Notion AI-style Agent activity timeline for intermediate replies, tool calls, and progress | Phase 6.1 |
| [#86](https://github.com/6tizer/llm_wiki/issues/86) | Phase 5 Agent 场景需要可重复的 UI 验收入口或 QA fixture | Phase 6.1 |
| [#84](https://github.com/6tizer/llm_wiki/issues/84) | Agent 权限设置入口不明确，需要支持对话框和 Settings 双入口 | Phase 6.1 |
| [#65](https://github.com/6tizer/llm_wiki/issues/65) | Clarify Ingest/提取 mode vs Agent session summary behavior | Phase 6.1 |
| [#3](https://github.com/6tizer/llm_wiki/issues/3) | Explore internal RPC channel for embedded Agent wiki tools | Phase 6.1 评估项 |
| PR #93 Deep Review 4.3 | Streaming 期间 auto-save 跳过，崩溃可能丢失 `agentResourceLimit` 等临时状态 | Phase 6.1 |

---

## 前置条件

Phase 6.1 开始前应满足：

- Phase 5.1 已完成，资源限制和 QA 提取质量问题不再阻塞验收。
- Phase 6 的 P0/P1 同步已完成，尤其是 CLI resolver、MCP Server、Chat image、Settings、Ingest。
- Agent Sidecar binary、Agent settings、Chat Agent mode 在同步后可正常运行。
- 已有 Phase 6 后的 GitNexus 索引。

---

## PR 切分

Phase 6.1 建议最少 3 个 PR。#3 先做评估，不默认实现。

### PR 6.1-A：Agent 会话连续性和活动时间线

**目标**：把 Agent 的中间过程、compact/resume、pending confirmation 和工具调用整理成用户能理解的活动历史。

| Issue | 工作项 | 验收 |
|-------|--------|------|
| #66 | compact/resume summaries 渲染为 session 状态，不当作普通 assistant 回复 | 用户不会看到 raw jsonl、context exhausted 等内部细节作为普通回答 |
| #67 | 新用户消息优先级高于 resumed session pending task | “不对”“不是这个意思”等纠正消息不会被当成继续执行确认 |
| #68 | Agent activity timeline | Agent turn 下方有 compact timeline，可展开工具调用、权限、wiki changes、进度摘要 |
| #86 | dev-only QA fixture | 开发者能稳定触发 compact summary、pending question、rewind、resource limit error 等状态 |
| PR #93 Deep Review 4.3 | streaming 期间关键 Agent 状态持久化 | `agentResourceLimit`、pending action、compact summary 等关键状态在崩溃恢复后不会无声丢失，或有明确不可恢复提示 |

**建议实现点**：

- 定义 Agent activity event model，把 tool events、permission、wiki changes、summary/progress 收敛成一条 timeline。
- compact/resume 事件作为状态行，不直接混进 assistant prose。
- pending action 用显式 UI choice 表示，只有明确确认才继续 state-changing task。
- 评估 auto-save streaming skip 策略：可以对关键 Agent state 做轻量 snapshot，也可以在 action-required 时触发一次安全持久化。
- dev fixture 只在 DEV 模式暴露，不进入生产 UI。

**预计工时**：4-6 days
**风险**：HIGH
**优先级**：P0

**测试**：

- ordinary Chat 不显示 Agent timeline。
- Agent message 有 tool/activity 时显示 timeline。
- correction/rejection 不触发 resume continuation。
- fixture 能稳定构造目标状态。

---

### PR 6.1-B：Agent rewind 生命周期

**目标**：让 rewind 行为和 SDK 能力一致，不能做的场景不展示误导性入口。

| Issue | 工作项 | 验收 |
|-------|--------|------|
| #60 | 确认 SDK 是否支持 completed-stream rewind | 如果不支持，done/error/stop 后隐藏或禁用 rewind |
| #60 | 调整 sidecar `QueryControl` 生命周期 | active stream rewind 可用；completed stream 不再触发 `ProcessTransport is not ready for writing` |

**建议实现点**：

- 不假设保留 `QueryControl` 就能在完成后 rewind。
- 如果 SDK 有 checkpoint/session API，再设计 completed-stream rewind。
- 否则只支持 active stream rewind，并在 UI 上明确生命周期。

**预计工时**：1.5-2.5 days
**风险**：MEDIUM
**优先级**：P1

**测试**：

- active stream 显示 rewind，且请求能到达 sidecar。
- done/error/stop 后 rewind 隐藏或 disabled。
- 旧错误 `ProcessTransport is not ready for writing` 不再作为用户可触发路径出现。

---

### PR 6.1-C：Agent 权限入口和 Ingest 文案

**目标**：把 Agent 权限和 Ingest mode 的产品语义讲清楚，减少用户误解。

| Issue | 工作项 | 验收 |
|-------|--------|------|
| #84 | Agent 输入框顶部权限区域可操作 | 用户能看到并修改当前 Agent 权限策略 |
| #84 | Settings > Agent 增加权限配置 | 权限策略作用范围清楚：当前对话、项目或全局默认 |
| #65 | 调整 `提取` 文案和说明 | 用户能区分 Ingest/source extraction 和 Agent session summary |

**建议实现点**：

- 权限入口放在 Agent mode 输入区，同时在 Settings > Agent 提供完整配置。
- 高权限模式需要明确风险文案和确认。
- Ingest mode 中文名避免只写“提取”，可评估“资料提取”“导入准备”等。
- 如果 Phase 6 已引入 Chat image 或 Settings layout 改动，以同步后的 UI 结构为准。

**预计工时**：2-3 days
**风险**：MEDIUM
**优先级**：P1

**测试**：

- 权限选择器可读可改，持久化范围符合预期。
- 普通 Chat/Ingest 不受 Agent 权限设置影响。
- i18n key 覆盖中文和英文。

---

### PR 6.1-D：内部 RPC 通道评估

**目标**：重新评估 #3 是否还需要实现。默认先产出设计结论，不直接开工。

| Issue | 工作项 | 验收 |
|-------|--------|------|
| #3 | 评估 MCP Server、local HTTP API、Agent sidecar 三者边界 | 给出是否实现内部 RPC 的决策 |
| #3 | 如需实现，设计 Rust-to-sidecar RPC 协议 | 明确 transport、schema、auth、lifecycle、cancellation、测试策略 |

**建议判断标准**：

- 如果 Phase 6 后 MCP Server 和 Agent sidecar 能清晰分工，继续保留 HTTP loopback 或现有通道即可。
- 如果内部 Agent 能力不应暴露到 local HTTP API，或 HTTP loopback 成为真实瓶颈，再设计内部 RPC。
- 不为了架构洁癖引入新协议。

**预计工时**：0.5-1 day 评估；实现另立 Phase
**风险**：LOW for design, HIGH for implementation
**优先级**：P2

---

## 推荐执行顺序

1. PR 6.1-A：Agent 会话连续性和活动时间线。
2. PR 6.1-B：Agent rewind 生命周期。
3. PR 6.1-C：Agent 权限入口和 Ingest 文案。
4. PR 6.1-D：内部 RPC 通道评估。

先做会话连续性和 timeline，因为它会吸收 compact/resume、pending confirmation、fixture 等多个问题。rewind 可以单独修，避免被 timeline PR 拖太大。权限和文案等 Phase 6 Settings/Chat 稳定后再做。

---

## 验收标准

Phase 6.1 完成时应满足：

- #60、#65、#66、#67、#68、#84、#86 关闭或有明确不做结论。
- Agent compact/resume 不再以普通 assistant prose 暴露内部实现细节。
- 用户纠正消息不会被 resumed session 当成继续确认。
- Agent turn 有可展开的活动时间线。
- streaming 期间出现的关键 Agent 状态有崩溃恢复策略，或 UI 明确告知不可恢复边界。
- rewind 生命周期和 SDK 能力一致。
- Agent 权限入口清楚，Settings 中可配置。
- Ingest mode 和 Agent session summary 的产品语义分开。
- #3 形成清楚架构决策。
- `pnpm lint` 和相关测试通过。
- 提交前跑 `gitnexus detect_changes`。

---

## 边界

- 不回滚 Phase 6 的上游同步结果。
- 不重新设计整个 Chat 架构。
- 不暴露模型隐藏 chain-of-thought。
- 不默认实现内部 RPC，先评估。
- 不把 API key、LLM token、jsonl 私有路径或项目敏感内容写入日志、PR 描述或测试快照。
