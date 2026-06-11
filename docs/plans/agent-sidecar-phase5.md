# Phase 5: Agent 稳定性、资源控制与打包优化

> 类型：Phase 实施计划 | 创建：2026-06-04 | 状态：开发完成，待 UI 验证
> 上级：[Agent Sidecar 总规划](./agent-sidecar-roadmap.md)
> 前置：[Phase 4 计划](./agent-sidecar-phase4.md)（已完成）

## 目标

Phase 4 完成了 Agent UI 集成，用户可以在 Chat 面板中使用 Agent 对话、工具调用 timeline、权限审批、session resume/fork。但 DEV QA 发现了多个影响稳定性的问题：session 行为不直观、资源限制过硬、rewind 生命周期缺陷。

Phase 5 的目标是：
1. 修复 Agent session 行为，使 compact/resume 对用户透明、纠正输入可靠传递
2. 资源限制可配置化，消除硬编码瓶颈
3. 修复 Agent 生命周期 bug（rewind、max turns、maxFilesChanged）
4. Sidecar 打包为单文件 binary，消除冷启动
5. 清理遗留 bug（React key warnings、Tauri resource id、QA hook）

边界：

- Phase 5 **不新增 Agent 能力**，只修复和优化已有能力
- Phase 5 **不重做 UI 设计**，只修正行为和增加配置入口
- Phase 5 **不做 Multi-Agent Pipeline UI**（放 Phase 6+）
- Phase 5 **不做移动端适配**

## 当前代码与数据流分析

### Agent 完整数据流

```
[用户输入 text]
    ↓
chat-panel.tsx :: handleAgentSend(text)
    ↓ 读取 conversation.agentSessionId
    ↓ 构建 AgentTransportOptions（含 resume/maxTurns/maxFilesChanged 等）
    ↓
agent-transport.ts :: streamAgent(prompt, options, callbacks)
    ↓ 生成 streamId = crypto.randomUUID()
    ↓ invoke("agent_spawn", {args: payload})
    ↓
agent.rs :: agent_spawn(app, state, args)
    ↓ inject_internal_api_token()
    ↓ build_agent_request(args) → AgentRequest{type:"query", stream_id, prompt, options}
    ↓ spawn sidecar process (Command::new)
    ↓ write request JSON-line to stdin
    ↓ spawn tokio task: read stdout lines → app.emit("agent:{streamId}", line)
    ↓
main.ts (sidecar) :: readline stdin → handleRequest(parsed)
    ↓
core.ts :: createRequestHandler()
    ↓ 构建 MCP servers (wiki-tools.ts :: createLlmWikiMcpServer)
    ↓ 构建 hooks (agent-hooks.ts :: createLlmWikiHooks)
    ↓ 构建 canUseTool (permission-bridge)
    ↓ queryFn({prompt, options}) → SDK query()
    ↓ for await (message of q) → send({streamId, type, data})
    ↓
[事件流回前端]
    onToken → streamingContent
    onToolEvent → toolCalls[] → AgentToolTimeline
    onPermissionRequest → AgentPermissionDialog → AgentPermissionDecision
    onWikiChanged → refreshFileTree + toast
    onDone → finishAgentStreamMessage + session persist
```

### Session 生命周期现状

| 层 | 文件 | 行为 |
|---|---|---|
| 前端 Store | `chat-store.ts:17` | `Conversation.agentSessionId?: string` — 持久化到 `.llm-wiki/chats/` |
| 前端 Store | `chat-store.ts:400-442` | `finalizeAgentStream` → 从 `result.session_id` 提取存入 conversation |
| 前端 Store | `chat-store.ts:258-276` | `forkAgentConversation` → 新 conversation + 复制 sessionId + `agentForkSessionPending` |
| 前端 Transport | `agent-transport.ts:169-411` | `streamAgent` → 传递 `resume`/`forkSession`/`resumeSessionAt` 到 Rust |
| Rust | `agent.rs:252-382` | `agent_spawn` → 每次 spawn 新 sidecar 进程，stdin 写入 request |
| Sidecar Core | `core.ts:198-241` | `rawOptions` → `sessionId`/`resume`/`continue`/`forkSession`/`persistSession` 透传 SDK |
| Sidecar Core | `core.ts:73-91` | `retainActiveSdkQuery` / `scheduleActiveSdkQueryRelease` — 保留 QueryControl 5 分钟用于 rewind |
| SDK | Claude Agent SDK | `query()` 接收 session 参数，内部管理 session 文件 |

**关键问题**：每个 `agent_spawn` 创建新的 sidecar 进程。Session 恢复依赖 SDK 的 session 文件（磁盘），不依赖 sidecar 进程存活。

### 资源限制现状（硬编码）

| 限制 | 文件:行 | 当前值 | 问题 |
|---|---|---|---|
| `maxTurns` | `core.ts:202` | `req.options.maxTurns ?? 10` | 多步任务容易耗尽 |
| `DEFAULT_MAX_FILES_CHANGED` | `wiki-tools.ts:27` | `3` | 批量修复 3 个文件就中断 |
| `DEFAULT_MAX_WRITE_BYTES` | `wiki-tools.ts:26` | `256KB` | 单文件写入上限 |
| `activeSdkQueryRetentionMs` | `core.ts:60` | `5 * 60_000` (5 分钟) | rewind 窗口 |
| `DEFAULT_AGENT_PERMISSION_TIMEOUT_MS` | `chat-store.ts:194` | `60_000` (60 秒) | 权限 dialog 超时 |

### Rewind 生命周期现状

```
stream 完成 → sidecar send("done")
    ↓
core.ts finally: scheduleActiveSdkQueryRelease(streamId, q)
    ↓ 5 分钟后 delete activeSdkQueries[streamId]
    ↓
用户点击 Rewind → invoke("agent_rewind_files")
    ↓
sidecar: handleRewindFilesRequest → activeSdkQueries.get(streamId)
    ↓ 如果 QueryControl 还在 → q.rewindFiles(messageId)
    ↓ 如果已过期 → "ProcessTransport is not ready for writing"
```

**#60 Bug 根因**：SDK 的 `QueryControl` 保留了但底层 `ProcessTransport` 已关闭。`rewindFiles()` 尝试写入已关闭的 transport 导致失败。

### Compact/Resume 摘要现状（#66）

当 SDK session context 耗尽时，SDK 内部会 compact 并生成摘要。这个摘要是 `SDKAssistantMessage`，内容包含 "run out of context" 等内部细节。当前 `agent-transport.ts:336` 对所有 `SDKAssistantMessage` 走 `onMessage` → `onToken`，摘要被当作正常回复展示给用户。

### 用户输入被忽略的根因（#67）

`handleAgentSend` 中 `resume: agentSessionId` 使 SDK 恢复上次 session。SDK 内部保留了上次的 pending question/task state。用户新的输入（如 "不对"）被 SDK 视为对 pending question 的回答，而非纠正。没有 intent gate 区分纠正 vs 确认。

## Issues 与 Phase 5 映射

| Issue | 标题 | 归属子阶段 | 修复策略 |
|---|---|---|---|
| #66 | compact/resume 摘要暴露给用户 | 5a | 检测 SDK summary 事件，渲染为折叠状态行 |
| #67 | Agent resume 忽略用户纠正 | 5a | 在 resume 时注入系统指令覆盖 pending state |
| #65 | Ingest vs Agent session 行为混淆 | 5a | 明确模式边界，session summary 不进对话流 |
| #60 | rewind 流完成后失败 | 5a | 修复 QueryControl 生命周期或仅在流存活时暴露 rewind |
| #62 | max turns 太低 | 5b | 默认值提高 + 配置化 |
| #64 | maxFilesChanged=3 太少 | 5b | 默认值提高 + 配置化 + 结构化错误 |
| #63 | Tauri resource id 错误 | 5c | 调查并修复 |
| #59 | React key warnings | 5c | 修复 key 属性 |
| #69 | QA hook topic 提取错误 | 5c | 修复删除时的 topic 提取逻辑 |
| #3 | RPC 通道探索 | 5d | 评估现有 stdin/stdout 是否满足需求 |
| #68 | Notion AI 风格 timeline | Phase 6 | 不在 Phase 5 范围 |

## PR 拆分计划

Phase 5 拆 7 个 PR，分 4 个子阶段。子阶段之间有依赖，子阶段内可并行。

### 子阶段 5a：Session 行为修复

#### PR A：Compact/Resume 摘要过滤

**范围**：
- `agent-transport.ts`：在 `onMessage` 回调中检测 SDK compact/resume 摘要
  - 检测条件：`SDKAssistantMessage` 的 content 中包含 "context" + ("summary" | "exhausted" | "run out") 等模式
  - 或检测 SDK 的 `session_update` / `compact` 系统事件（如果 SDK 暴露）
  - 摘要不走 `onToken`，改为 `onAgentSummary` 或新的 `onSessionCompact` 回调
- `chat-panel.tsx`：`onAgentSummary` / `onSessionCompact` 渲染为折叠状态行
  - 使用现有 UI primitive（collapsible separator）
  - 文案：i18n key `agent.session.contextSummarized`
  - 不显示 SDK 内部细节（jsonl 路径、session 结构等）
- `chat-store.ts`：新增 `DisplayMessage.sessionCompact?: boolean` 标记
  - 持久化，重启后仍显示为折叠状态
- i18n：新增 session compact 相关标签

**影响分析**：
- `streamAgent` 的 `onMessage` 回调 — 增加摘要检测逻辑
- `ChatMessageImpl` — 增加 compact 消息渲染分支
- 不影响 Chat/Ingest 模式

**风险**：LOW。纯 UI 展示层变更，不影响 Agent 执行逻辑。

**验证**：
- `pnpm test` / `pnpm lint` / `npm run typecheck`
- UI 手动验证：
  - 正常 Agent 回复不受影响（回归）
  - 触发 SDK compact 后，摘要显示为折叠状态行
  - 折叠/展开正常工作
  - 重启 app 后 compact 消息仍显示为折叠

#### PR B：Session Resume 意图保护

**范围**：
- `chat-panel.tsx` `handleAgentSend()`：
  - 在 resume 场景下，检测用户输入是否为纠正/拒绝
  - 如果 conversation 最后一条 assistant 消息是 pending question（包含 "?" 或 "要...吗" 等模式），且用户输入不匹配确认模式
  - 注入 system prompt 前缀：`[System: User's latest message is a correction or new topic. Do NOT continue previous pending actions. Treat the latest user message as the primary instruction.]`
  - 或：在 `AgentTransportOptions.systemPrompt` 中追加意图保护指令
- `agent-types.ts`：`AgentTransportOptions` 新增 `intentOverride?: string` 字段
  - 传递到 sidecar，sidecar 在 `rawOptions.systemPrompt` 中注入
- `core.ts`：如果 `req.options.intentOverride` 存在，追加到 systemPrompt

**影响分析**：
- `handleAgentSend` — 增加 intent 检测
- `AgentTransportOptions` — 新增可选字段
- `core.ts` — systemPrompt 拼接
- 不影响非 resume 场景

**风险**：MEDIUM。Intent 检测可能误判（false positive：用户确认被当成纠正）。需要保守策略：只在明确纠正词（"不对"、"不是"、"错了"、"重新"）时注入保护。

**验证**：
- `pnpm test` / `pnpm lint` / `npm run typecheck`
- UI 手动验证：
  - Agent 问 "要继续吗？" → 用户说 "不对，这个是手动触发的" → Agent 不继续旧任务
  - Agent 问 "要继续吗？" → 用户说 "是的" → Agent 继续（回归）
  - 新话题不受影响
  - 非 resume 场景不受影响

#### PR C：Rewind 生命周期修复

**范围**：
- `core.ts`：
  - 方案 A（推荐）：保留 `QueryControl` 的 `rewindFiles` 方法但不依赖底层 transport
    - 检查 SDK 是否支持 post-stream rewind
    - 如果不支持，仅在 stream 存活时暴露 rewind
  - 方案 B：在 `scheduleActiveSdkQueryRelease` 之前，检查 rewind 是否可用
    - 如果 `query.rewindFiles` 会失败，提前标记 `canRewind = false`
- `agent-transport.ts` `rewindAgentFiles()`：
  - 增加超时和错误分类
  - 如果 rewind 失败因为 transport 关闭，显示 "rewind 不可用" 而非通用错误
- `chat-panel.tsx`：
  - 在 stream 完成后，如果 rewind 不可用，隐藏 "Rewind files" 按钮
  - 或显示为 disabled + tooltip "Rewind unavailable after stream completion"
- `chat-store.ts`：
  - `markAgentMessageRewindable` 增加 `canRewind` 标记
  - rewind 按钮根据 `canRewind` 决定是否显示

**影响分析**：
- `core.ts` — `retainActiveSdkQuery` / `scheduleActiveSdkQueryRelease` 逻辑
- `agent-transport.ts` — `rewindAgentFiles` 错误处理
- `chat-panel.tsx` — rewind 按钮显示逻辑
- `chat-store.ts` — `AgentRewindRequestRecord` 增加 `canRewind`

**风险**：MEDIUM。需要确认 SDK 的 rewind 能力边界。

**验证**：
- `pnpm test` / `pnpm lint` / `npm run typecheck`
- UI 手动验证：
  - Stream 存活时 rewind 正常工作
  - Stream 完成后 rewind 按钮不可用或给出明确提示
  - 5 分钟后 rewind 按钮消失

### 子阶段 5b：资源限制与配置

#### PR D：maxTurns / maxFilesChanged 配置化

**范围**：
- `wiki-tools.ts`：
  - `DEFAULT_MAX_FILES_CHANGED` 从 `3` 提高到 `10`
  - `writePage()` 返回结构化错误：`{ kind: "max_files_changed", limit, changedCount, changedPaths }` 而非纯字符串
  - `LlmWikiToolContext.maxFilesChanged` 已有字段，无需新增
- `core.ts`：
  - `maxTurns` 默认值从 `10` 提高到 `30`
  - `req.options.maxTurns` 已透传，无需新增字段
- `agent-types.ts`：
  - `AgentTransportOptions.maxTurns` 已有
  - `AgentTransportOptions.maxFilesChanged` 已有
- `chat-panel.tsx` `buildAgentTransportOptions()`：
  - 从 wiki-store 读取用户配置的 `maxTurns` / `maxFilesChanged`
  - 如果用户未配置，使用新默认值
- `wiki-store.ts` 或新增 `agent-settings.ts`：
  - 新增 Agent 配置：`agentMaxTurns`, `agentMaxFilesChanged`, `agentMaxWriteBytes`
  - 持久化到 `.llm-wiki/agent-settings.json`
- Settings UI：
  - 新增 Agent 配置面板（简单表单）
  - 或复用现有 settings view

**影响分析**：
- `wiki-tools.ts` — 默认值 + 错误格式
- `core.ts` — 默认值
- `wiki-store.ts` — 新增配置字段
- `chat-panel.tsx` — 读取配置
- Settings UI — 新增配置入口

**风险**：LOW。默认值提高 + 可选配置，向后兼容。

**验证**：
- `pnpm test` / `pnpm lint` / `npm run typecheck`
- UI 手动验证：
  - Agent 默认 maxTurns=30，多步任务不再中途失败
  - Agent 默认 maxFilesChanged=10，批量修复不再 3 个文件就中断
  - PR D 已返回结构化 MCP error（`kind: "max_files_changed"`）；专门的前端状态提示留到后续 UI PR
  - Settings 中可修改 Agent 配置
  - 修改后重启 app 配置保留

#### PR E：Session 存储整理

**范围**：
- `persist.ts`：
  - `saveChatHistory` 已序列化 `Conversation.agentSessionId`
  - [x] 新增清理逻辑：超过 30 天未更新的 conversation 的 `agentSessionId` 清空
  - [x] 新增 `cleanExpiredAgentSessions(projectPath)` 函数
- `chat-store.ts`：
  - [x] app 启动时调用 `cleanExpiredAgentSessions`
  - [x] `loadChatHistory` 后清理过期 session
- SDK session 文件管理：
  - [x] 不主动删除 SDK session 文件（SDK 自行管理）
  - [x] 只清理前端的 `agentSessionId` 引用

**影响分析**：
- `persist.ts` — 新增清理函数
- `chat-store.ts` — 启动时清理
- 不影响 Agent 执行逻辑

**风险**：LOW。清理逻辑保守执行，只清引用不清 SDK 文件。

**验证**：
- `pnpm test` / `pnpm lint`
- 手动验证：
  - 新 conversation 的 agentSessionId 正常持久化
  - 30 天前的 conversation 的 agentSessionId 被清空
  - 清空后 resume 降级为新 session（不报错）

### 子阶段 5c：Bug 修复

#### PR F：遗留 Bug 修复

**范围**：
- **#59 React key warnings**：
  - [x] `chat-message.tsx` 和 `agent-block-list.tsx` 中列表渲染 key 唯一且稳定
  - [x] SDK `tool_use` / `tool_result` 共享 id 时不产生 duplicate key warning
- **#63 Tauri resource id 错误**：
  - [x] `agent_spawn` 仍保持 `listen` 先于 `invoke`
  - [x] listener cleanup 捕获 stale Tauri resource 的 sync/async error，避免 unhandled rejection
- **#69 QA hook topic 提取**：
  - [x] 删除 conversation 触发 QA 时优先最后几轮用户观察和新知识
  - [x] 删除/移除型无新知识对话跳过 QA
  - [x] 近重复中文 topic 在 LLM 调用前/写入前被 dedup

**影响分析**：
- 三个独立 bug，互不耦合
- 每个修复范围小

**风险**：LOW。

**验证**：
- `pnpm test` / `pnpm lint` / `npm run typecheck`
- UI 手动验证：
  - #59：控制台无 React key warnings
  - #63：DEV app 控制台无 "invalid Tauri resource id" 错误
  - #69：删除 wiki 页面后 QA hook 不提取已删内容的 topic

### 子阶段 5d：打包优化（可选）

#### PR G：Sidecar 单文件打包

**范围**：
- `src-tauri/sidecar/`：
  - [x] 添加 `bun build --compile` 构建脚本
  - [x] 输出单文件 binary `sidecar` (或 `sidecar.exe` on Windows)
  - [x] 确保所有依赖（`@anthropic-ai/claude-agent-sdk`、`zod` 等）打包进 binary
- `agent.rs`：
  - [x] `find_sidecar_command()` 优先查找编译后的 binary
  - [x] fallback 到 `node sidecar/dist/main.js`（开发模式）
- `package.json`（sidecar）：
  - [x] 新增 `build:binary` script
  - [x] 新增安全 `postinstall` 自动编译（无 Bun 时不阻塞普通 install）
- CI/CD：
  - [x] 构建时自动编译 sidecar binary
  - [x] Tauri bundler 包含 sidecar binary

**影响分析**：
- Sidecar 构建流程
- `agent.rs` sidecar 查找逻辑
- 不影响 Agent 运行时行为

**风险**：MEDIUM。Bun compile 可能有平台兼容性问题（macOS arm64/x64、Windows、Linux）。

**验证**：
- `bun build --compile` 成功生成 binary
- Binary 可独立运行：`./sidecar` → "[sidecar] ready"
- `agent_spawn` 使用 binary 正常工作
- Tauri app 打包后 sidecar binary 正确包含

## 依赖关系

```
子阶段 5a（Session 修复）
  PR A (compact 摘要) ← 可独立
  PR B (resume 意图保护) ← 可独立
  PR C (rewind 修复) ← 可独立

子阶段 5b（资源控制）
  PR D (配置化) ← 可独立
  PR E (存储整理) ← 依赖 PR D 的配置结构

子阶段 5c（Bug 修复）
  PR F (遗留 bug) ← 可独立

子阶段 5d（打包优化）
  PR G (sidecar binary) ← 可独立
```

5a / 5b / 5c / 5d 之间无强依赖，可并行开发。PR A/B/C 之间无文件重叠，可并行。

## 不纳入 Phase 5

- **Multi-Agent Pipeline UI** — `agent-pipeline.ts` 已就绪但 UI 入口放 Phase 6
- **#68 Notion AI 风格 Agent activity timeline** — 新功能，放 Phase 6
- **CPU/内存/时间限制** — 需要 sidecar 层面的资源监控，复杂度高，放 Phase 6
- **并发 Agent 支持（多 streamId）** — 当前架构已支持多 streamId（`AgentState.children` 是 HashMap），但前端 UI 一次只允许一个 Agent 运行。并发 UI 放 Phase 6
- **`startup()` 预热** — SDK 的 `startup()` 需要 sidecar 常驻进程模式，与当前 spawn-per-query 模式冲突。放 Phase 6 评估
- **Agent 对话导出/分享/搜索** — 放 Phase 6+

## 验收标准

Phase 5 完成时：

- [x] Agent compact/resume 摘要显示为折叠状态行，不暴露 SDK 内部细节
- [x] 用户纠正输入（"不对"、"不是"）在 resume 场景下被 Agent 正确识别
- [x] Agent rewind 在 stream 完成后隐藏不可用入口，避免调用已关闭 transport
- [x] Agent 默认 maxTurns 提高到 30，多步任务不中途失败
- [x] Agent 默认 maxFilesChanged 提高到 10，批量修复不 3 个文件就中断
- [ ] maxFilesChanged 超限时显示前端状态提示（PR D 已完成结构化 MCP error）
- [x] Agent 配置（maxTurns/maxFilesChanged/maxWriteBytes）可在 Settings 中修改
- [x] 过期的 agentSessionId 在启动时自动清理
- [x] React duplicate key warnings 消除（#59）
- [x] Tauri resource id 错误消除（#63）
- [x] QA hook 删除时不提取已删内容的 topic（#69）
- [x] Sidecar 可编译为单文件 binary（可选）
- [x] 普通 Chat/Ingest 模式完全不受影响（回归测试）
- [ ] `pnpm test` 全绿
- [x] `pnpm lint` 无新增错误
- [x] `npm run typecheck` 通过
- [x] `npx gitnexus detect_changes` 确认仅涉及预期符号

## 风险与缓解

| 风险 | 等级 | 缓解 |
|---|---|---|
| Intent 检测误判（用户确认被当成纠正） | MEDIUM | 保守策略：只在明确纠正词时注入保护，其他情况不干预 |
| SDK compact 事件格式变化 | LOW | 检测逻辑使用多模式匹配，不依赖单一字段 |
| maxTurns 提高导致成本增加 | LOW | 默认 30 仍有限制，用户可在 Settings 调低 |
| Bun compile 平台兼容性 | MEDIUM | 先支持 macOS，Windows/Linux 后续迭代 |
| Session 清理误删活跃 session | LOW | 只清引用（前端 agentSessionId），不清 SDK session 文件 |
| #60 rewind 根因需要 SDK 层面修复 | MEDIUM | 如果 SDK 不支持 post-stream rewind，降级为仅在流存活时暴露 |

## GitNexus 使用要求

- PR A 前：`gitnexus impact({target: "onMessage", direction: "upstream"})` 确认 onMessage 回调的所有消费者
- PR B 前：`gitnexus impact({target: "handleAgentSend", direction: "downstream"})` 确认 intent 保护的影响链
- PR D 前：`gitnexus impact({target: "writePage", direction: "upstream"})` 确认 maxFilesChanged 的所有传递路径
- 每个 PR 提交前：`gitnexus detect_changes` 验证仅涉及预期符号
