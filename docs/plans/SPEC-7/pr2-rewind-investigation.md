# SPEC-7 PR2 前置调查：会话级 rewind（2026-07-04，只读调查产出）

> 类型：调查证据 / PR2 计划基础 | 状态：investigation complete / **E1/E2 实证已完成（2026-07-05，见文末结果节）** | 基线：main 9a1f2fd6（含 PR1 SDK 0.3.201）

## 核心结论

1. **#60 根因是能力缺失非报错问题**：`rewindFiles` 绑定在单次 `query()` 返回的 Query 对象上；流结束 `core.ts:359-361` finally 无条件删 `activeSdkQueries` entry，且 `main.ts:27-55 scheduleExitIfIdle` 会让 sidecar 进程整体退出——旧 turn 的文件从此无任何代码路径可 rewind。
2. **`reinitialize()`（0.3.195）确证不适用**：其语义是「reattach 到仍在运行的 CLI」（transport gap 场景，sdk.d.ts:2322-2338）；rewind-after-done 时进程已正常退出，无 CLI 可 reattach。PR1 计划里的「PR2 评估」项就此关闭为否定。
3. **推荐路径 = resume-only-for-rewind**：复用生产日常已验证的 resume 模式（每条追问本来就是 `resume: agentSessionId` 起新 Query，agent-transport-options.ts:44），起一个**不产生真实回复**的一次性 Query（streaming-input 空 prompt + resume + enableFileCheckpointing）→ 拿 Query 句柄调 rewindFiles → close。
4. **顺序硬约束**：必须「先 rewindFiles（对原始 session）再 forkSession(upToMessageId)」——**fork 出的会话没有 undo history**（sdk.d.ts:657-658 "Forked sessions start without undo history"），顺序写反功能整体静默失效。
5. **前端时间线截断是完全空白**：`chat-panel.tsx:699-718 onRewindFiles` 只做 lint 排队+文件树刷新，不裁剪 messages、不更新 agentSessionId——文件回滚后续聊会带旧 sessionId resume，历史与展示脱节。
6. `resumeSessionAt` 的 UUID 必须是 **assistant** message uuid（sdk.d.ts:1766-1769），非 user id；不带 forkSession:true 时对原 session 文件是否破坏性未文档化，需实测。

## 两项 BLOCKING 实证（PR2 开工前必须，PR1 probe 同款手法，需真实 API key + 真实模型调用）

- **E1 checkpoint 跨进程存活性**：起 query → 写文件 → 流结束 → 等进程退出 → `resume` 起新 Query → `rewindFiles`，看 `canRewind` 是否为真。若 checkpoint 只在进程内存，整个 resume-only-for-rewind 方案不成立，PR2 需改走自建快照。
- **E2 wiki MCP 写工具覆盖面**：SDK 原生 checkpoint 主要覆盖内置工具（archive/agent-sidecar-phase3.6.md:292-294 遗留结论，oldSha256 follow-up 从未实现）；用 wiki 写工具改文件后 rewindFiles，检查文件是否真的回滚。若不覆盖 → rewind「假成功」= 静默数据不一致（高危），PR2 必须为 wiki 写工具补自建 checkpoint 或明确 UI 披露范围。

## 现状盘点（file:line 摘要）

- 链路：agent.rs:702-730 `agent_rewind_files`（broken pipe → poison_agent_sidecar）→ main.ts:87-95 → rewind-bridge.ts（116 行全量：inactive_stream/unsupported/missing_message_id/transport_closed 分支；transport regex 保留）→ 前端 agent-transport.ts:219-258 → agent-rewind-dialog.tsx。
- **已知 UX bug 候选**：dialog catch 分支（agent-rewind-dialog.tsx:48-51）对 invoke throw（进程已死）不清 `agentRewindTargets` → 按钮持续可点持续失败（中高，易修）。
- uuid 坐标系：完全是 SDK 的（SDKUserMessage/SDKAssistantMessage.uuid，chat-panel.tsx:626-640），同一显示气泡内多子消息后写覆盖前写 → 轮内中间检查点不可达（记为显式 non-goal）。
- forkSession 布尔 option 现有唯一消费者是「复制会话」功能（chat-store.ts:297-316），与 rewind 无关，可参考不共用。

## 风险矩阵候选（PR2 adversary 阶段的输入）

高：E2 假成功 / 顺序耦合写反 / 半态（文件已回滚时间线未截断）。中高：resumeSessionAt 无 forkSession 的破坏性未知 / sidecar 生命周期两条错误路径（Rust broken-pipe vs sidecar transport_closed）前端处理不统一 / dialog catch 不清 target。中：rewind 与 in-flight turn 无互斥 / 多次 rewind 叠加语义。低（non-goal）：轮内粒度。

## 建议 PR2 步骤

1. E1+E2 实证 probe（gate：否定则方案重议）。
2. sidecar「resume-only-for-rewind」路径（替换 activeSdkQueries 必须命中的假设）。
3. 统一两条失败路径的前端处理 + dialog catch 清 target。
4. 完整编排：rewindFiles 成功 → forkSession(upToMessageId=对应 assistant uuid) → 更新 Conversation.agentSessionId → 前端时间线裁剪。
5. 并发保护：rewind 期间禁止同 streamId 新 turn，反之亦然。

## E1/E2 实证结果（2026-07-05，DeepSeek anthropic 兼容端点 + Agent SDK 真实调用）

probe 脚本存档：session scratchpad `spec7-pr2-probe/`（e1-process-a/b.mjs、e1-control-same-process.mjs、e2-process-a/b.mjs）。密钥全程钥匙串内部读取，未进任何 transcript。

### E1 checkpoint 跨进程存活：**PASS**（resume-only-for-rewind 可行）

进程 A（enableFileCheckpointing + persistSession + 内置 Write 工具）写文件后 `process.exit(0)`；全新 node 进程 B 以 `resume: sessionId` 起 Query 调 `rewindFiles(userMessageUuid)` → `{canRewind:true}` 且**磁盘文件真实回滚**到基线内容。两项对原方案的修正：

1. **「空 streaming-input 零成本 resume」不成立**（推翻核心结论 3 的实现细节）：never-yield 的 async generator 导致 CLI 另起全新 session（sessionId 变化）并从头重放原 prompt。resume 必须带真实的最小 prompt（如 `"OK"`，非 streaming 空流）——与 agent-transport-options.ts 生产 resume 模式一致。
2. **rewind 锚点 uuid 必须取自持久化 session JSONL 的真实 human-turn uuid**（`file-history-snapshot.snapshot.messageId`），不能用 live 流上第一个 `type:"user"` 帧（常是合成的 tool-result user 帧）；纯字符串 prompt 的原始 turn 不会回显到 live 流。

同进程对照组：Query 流一旦 drain，`rewindFiles` 即报 "ProcessTransport is not ready for writing"——印证核心结论 1（core.ts 无条件清理）。

### E2 wiki MCP 写工具覆盖面：**FAIL（静默假成功，高危确证）**

用 `createSdkMcpServer`/`tool()` 自定义写工具（镜像 wiki-tools.ts `update_page` 的 `fs.writeFileSync` 模式）改文件后，进程 B `rewindFiles` 返回 `{canRewind:true}` **但文件未回滚**。transcript 层面确证：该 turn 的 `file-history-snapshot.snapshot.trackedFileBackups` 为空对象——SDK 原生 checkpoint 只挂在 CLI 内置 Write/Edit 机制上，绕过即不追踪。`canRewind:true` 是 vacuous 成功（无可回滚 → 平凡真），不是真实信号。

### 对 PR2 方案的落定

- 步骤 2（resume-only-for-rewind）**可行**，但实现须按 E1 两项修正执行。
- **wiki 写工具（update_page/create_entity/create_concept/run_pipeline 等）不被原生 rewind 覆盖**：PR2 不得把 rewind 呈现为覆盖 wiki 工具改动，否则 UI 报成功而 wiki 改动原样留存（信任级 bug）。处置需产品决策：fail-closed 门禁（该 turn 后存在 wiki 写工具调用 → 禁用/降级 rewind 入口并披露原因）vs 自建 oldSha256/backup 快照（archive/agent-sidecar-phase3.6.md 从未实现的 follow-up）。
- 步骤顺序「先 rewindFiles 再 forkSession」不受影响，且步骤 1 已有实证背书。
- probe 侧注：DeepSeek anthropic 端点拒绝 `deepseek-v4-flash` 模型名，`claude-sonnet-4-5` 别名可用。
