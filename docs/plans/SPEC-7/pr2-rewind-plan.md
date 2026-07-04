# SPEC-7 PR2：会话级 rewind（resume-only-for-rewind + wiki 工具 fail-closed 门禁）

> 状态：design r3（r1 BLOCK 3P0/5P1 + r2 BLOCK 1P0/2P1 均已吸收；r2 确认三大方向可落地）| 基线：main 9b533cf0 | 前置：pr2-rewind-investigation.md（E1 PASS / E2 FAIL 已实证）| 轨：agent（llm_wiki-security）
> 用户裁定（2026-07-05）：**拆两步 fail-closed**——本 PR 不做 wiki 写工具自建快照（PR2b follow-up），改为门禁禁用 + 披露。
> 路径勘误：调查文档部分 file:line 已漂移，现行真实路径以本文为准——`src-tauri/src/commands/agent_cli/agent.rs`、`src/components/chat/*`、`src/stores/chat-store.ts`。

## 目标

1. 修 #60 根因：turn 结束/进程退出后 rewind 不可用 → 新增可脱离活跃流调用的 rewind 通道。
2. rewind 成功后的完整编排：文件回滚 → 会话截断（复用延迟 fork 基建）→ 前端时间线裁剪（今天是完全空白）。
3. wiki 写工具改动的 fail-closed 门禁：目标点之后存在 wiki 写类工具调用 → 禁用 rewind 入口并披露原因（E2 假成功的产品处置）。

## Non-goals（显式）

- wiki 写工具自建 oldSha256/backup 快照 → **PR2b**（#292）。
- 轮内（同 turn 多写）粒度 rewind——uuid 坐标系限制，调查文档已记。
- rewind 历史多分支树 UI。
- app reload 后恢复 rewind 目标（现状 runtime-only，reload 即失效 = 天然 fail-closed，矩阵 A15 记录）。

## 设计要点（design r2，审查修正已吸收）

### 1. 新 rewind 通道：独立命令 + 完整 resume 上下文（修 P0-1/P0-2）

现有 `agent_rewind_files`（agent_cli/agent.rs:702-713）只能写活跃 child stdin，且请求只带 `streamId/userMessageId`——turn 结束即无入口。本 PR 新增：

- **Rust**：新命令 `agent_rewind_session`，不依赖活跃 stream，按需拉起/复用 sidecar 进程。
- **前端**：请求携带完整 resume 上下文——`agentSessionId + projectPath + profile/model/auth + targetUserMessageUuid`，用 agent-transport-options.ts 现有 builder 构造（与正常发消息同源，不另造形状）。
- **sidecar**：新 RPC `rewind_session`：起一次性 Query（`resume: agentSessionId` + `enableFileCheckpointing` + 真实最小 prompt "OK"）→ init 断言 → `rewindFiles(targetUserMessageUuid)` → interrupt/close。现有 rewind-bridge.ts 活跃流路径保留为快路径（流还活着时无需 resume）。

E1 实证硬约束（原样保留）：
- 不得用空 streaming-input（CLI 会另起新 session 重放原 prompt）。
- **init 校验安全闸**：`init.session_id !== 目标 sessionId` → 立即 abort，绝不 rewind。
- transport 就绪（收到 init）后才调 rewindFiles，超时 fail-closed（E1 对照组：流 drain 后调用报 "ProcessTransport is not ready for writing"）。

### 2. 一次性 Query 的无工具模式（修 P1-4）

core.ts:154 现在自行 `getAllowedWikiTools(...)` 生成 allowedTools 且不透传请求值——「传空 allowedTools」不成立。改为：rewind 桥的一次性 Query 走 **bridge 内部显式 no-tools 模式**，不经由普通请求路径，且必须**同时关死两层**（r2 P1）：不挂 wiki MCP server + `allowedTools: []` + **内置工具也显式禁用**（`tools: []`/disallowedTools，按 SDK 实际选项落地）+ `maxTurns: 1`——否则 "OK" turn 仍可能用内置 Write/Bash 产生新写入。测试断言两层 options。

每次 rewind 消耗一次最小 LLM turn（计入用户 profile），PR body 记录。

**profile claim 责任边界**（r2 P1）：现状是前端 `streamAgent`（agent-transport.ts:517 附近）获取 claim、Rust sidecar 生命周期负责释放。`agent_rewind_session` 不得绕过该边界：前端按 streamAgent 同款路径先获取 claim 再 invoke，Rust 命令按正常 stream 同款生命周期释放（含异常路径 finally）。Coder 开工先追一遍真实 claim 流再落实现（矩阵 A18）。

### 3. 锚点 uuid 解析

**双 uuid 硬约束（r2 P2，实现不得混用）**：`rewindFiles` 锚点 = **user**-turn uuid；`resumeSessionAt` 锚点 = 对应 **assistant** uuid（sdk.d.ts:1766-1769）。同一目标点两个坐标，编排层显式分开命名传递（如 `rewindUserUuid` / `forkAssistantUuid`），测试断言各自落位。

- 首选：前端消息流现有 uuid bookkeeping（chat-panel 记录的 SDK uuid，Coder 核实来源可靠性）。
- 兜底/校验：持久化 session JSONL 的 `file-history-snapshot.snapshot.messageId`（user uuid 侧）。
- 任一侧解析不到 → 现有 `missing_message_id` 分支（fail-closed）。

**实现终态（review round 实证修正，2026-07-05）**：真实 transcript 显示 checkpoint messageId **不总是** human-turn uuid——轮内后续写入的 snapshot（`isSnapshotUpdate:true`）键到 assistant uuid。最终算法（sidecar `rewind-anchor.ts`）：解析 session JSONL 收集 checkpoint messageId 集合 + uuid→parentUuid 链；client uuid 若在集合中直用；否则从目标 turn 的 assistant uuid（live 流可靠回显，经 `fallbackAssistantMessageId` 字段透传）沿 parent 链回溯至最近的 checkpoint 锚点；回溯不到 → missing_message_id fail-closed。三分支 + cycle guard 均有测试（rewind-anchor.node.ts）。

### 4. wiki 写工具 fail-closed 门禁（修 P1-1/P1-2/P1-3）

分类源与判定规则：
- 以 agent-policy.ts 的 READ/WRITE 名单为基础，但**条件写工具一律按写分类**：`merge_duplicate_group`（现被错误列入 READ，`dryRun:false` 时 requiresWrite）、`okf_import`（`apply:true` 写）。门禁分类表在 sidecar 侧导出为单一权威模块，前端消费。
- **名单外/未来新增工具默认按写**（fail-closed，不依赖 policy 名单同步及时性——P1-2 的穿透路径被此规则关死）。
- 误把只读参数调用当写只降低可用性、不降低安全性，可接受。

判定数据源修复：
- chat-store.ts:597-601 `batch` tool event **覆盖** `toolCalls` 的 bug 必须修为合并（否则同一 assistant 消息内前批 wiki 写调用被后批覆盖 → 门禁漏看，P1-1）。
- 门禁判定：候选目标点之后（含该 turn）任一写类 wiki tool_use → 禁用 + 披露「此回滚点之后有 wiki 工具改动，原生回滚不覆盖」。
- fork 产生新 session 后按 session 边界重算（跨 fork 锚点本就不可用）。

### 5. 会话截断：复用延迟 fork 基建（修 P0-3）

不新造 one-shot fork 编排。现有基建：`forkAgentConversation`（chat-store.ts:297-316）置 `agentForkSessionPending: true`，下一次发送时 agent-transport-options.ts:39 应用 forkSession。本 PR 扩展：

- conversation 增加 `agentResumeSessionAt?: string`（目标 assistant uuid），与 `agentForkSessionPending` 一起在**下一次发送**时应用 `forkSession + resumeSessionAt` → 新 session_id 回写 agentSessionId、清 pending 标记（沿用 chat-store.ts:500/587 现有回写路径）。
- rewind 成功即：置两个 pending 字段 + **立即裁剪前端 messages 到目标点** + **同步强制持久化**（见下）。fork 推迟到下次发送 = 零额外 LLM 成本、复用生产已验证路径。
- 顺序硬约束自动满足：rewindFiles 永远先于 fork（fork 发生在之后的发送）。junk "OK" turn 落在旧 session、resumeSessionAt 指向其之前，fork 天然剔除。
- **强制持久化闭环（r2 P0）**：聊天保存是 2s debounce（auto-save.ts:210）——若只依赖 debounce，rewindFiles 成功后立刻崩溃/reload = 文件已回滚但 pending/裁剪没落盘，续聊仍 resume 旧 session。处置：编排在置 pending + 裁剪后**绕过 debounce 立即 flush 落盘，落盘成功才向 UI 报 rewind 成功**；flush 失败 → 显式错误披露（「文件已回滚，会话截断可能在重启后丢失」）+ 保留重试 flush 入口。测试断言 flush 先于成功回报。
- **半态窗口收窄**：rewindFiles 成功 → 本地置 pending + 裁剪 + 同步 flush，无第二次网络调用。pending 未消费前再次 rewind：允许，目标只能更早（门禁保证），latest-wins 更新 resumeSessionAt（矩阵 A19）。
- **持久化卫生（r2 P2）**：persist.ts 过期 session 清理路径必须同时清 `agentResumeSessionAt`（与 `agentForkSessionPending` 一致），否则留孤儿锚点。builder 侧对「孤儿 resumeSessionAt（无 pending fork）」的处置为降级忽略 + console.warn（不外传孤儿字段）——注意 `agentForkSessionPending` 单独存在是合法态（既有「复制会话」功能），不能反向断言（实现裁定，2026-07-05 review round 对齐）。

### 6. 失败路径统一 + 已知 bug 修复

- Rust broken-pipe（poison）与 sidecar transport_closed 两条错误路径前端处理统一、文案一致。
- agent-rewind-dialog.tsx catch 不清 `agentRewindTargets` → 修复。

### 7. 并发保护（修 P1-5）

现状是全局 `isStreaming` + 每 run 新 `streamId`，表达不了会话级锁。新增 chat-store **per-conversation `agentRewindLock`**：rewind 编排中 → 该 conversation 禁止发送；`isStreaming` 时 → rewind 入口禁用。双向互斥、多次 rewind 串行。

## 测试策略

- **mock 形状必须对照真实 SDK/CLI 行为核实**（Wave 3 假绿 ×3 教训）：`canRewind:true` 的 vacuous 语义（E2）、init.session_id、resume 另起新 session 形状。probe 脚本（session scratchpad spec7-pr2-probe/）是权威参照。
- 单测：门禁分类（含未知工具/条件写工具 fail-closed、batch 合并后判定）、锚点解析三分支、pendingFork latest-wins、init 断言 abort、no-tools options 断言。
- 集成：mocked SDK 的完整编排 happy path + 矩阵 A1/A4/A5/A6/A16 场景；`test_provider_connection` 类测试不得真实外呼。
- 手动：复用 probe 脚本对真实端点端到端一次（用户已授权）。

## 门与流程

对抗矩阵（pr2-adversarial-matrix.md r2，19 行）已过一轮 Codex 设计审查（BLOCK → 本 r2 全部吸收）。开工前矩阵 r2 再过一次确认性 review。标准 gate：Simplifier / Tester / Reviewer + Codex 外审。commit 前 GitNexus impact（agent_cli/agent.rs、rewind-bridge.ts、core.ts、chat-store.ts、chat-panel.tsx、agent-rewind-dialog.tsx、agent-transport-options.ts、agent-policy.ts）+ detect-changes。

## Follow-ups（本 PR 显式不做）

- **PR2b**（#292）：wiki 写工具 oldSha256/backup 快照（挂 #60/#190）。
- agent-policy `merge_duplicate_group` 列入 READ 的上游修正（本 PR 只在门禁分类层纠正；policy 名单本身的语义修正另行小 PR，影响面是权限提示而非 rewind）。
- app reload 后 rewind 目标持久化恢复（目前 fail-closed 失效，体验增强另议）。
