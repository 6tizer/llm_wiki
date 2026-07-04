# SPEC-7 PR2 对抗矩阵：rewind 编排

> design-first 输入，r3（r1 审查：A4/A6/A12 修订、A15-A19 新增；r2 审查：A4 强制 flush、A18 claim 边界、READ 名单补注；r3 定点确认 PASS 2026-07-05）。每行 = 一个必须有明确处置且被测试覆盖（或显式裁定不测并给理由）的场景。
> 图例：处置列「设计」= 结构上不可能发生；「测试」= 需断言；「披露」= UI/文档说明。

| # | 场景 | 触发 | 错误后果（若不处置） | 处置 | 覆盖 |
|---|------|------|---------------------|------|------|
| A1 | resume 静默另起新 session | CLI 对无效/过期 sessionId 或空流 resume 的行为（E1 实证） | rewind 作用于错误 session / 重放原 prompt 烧钱 | init.session_id 断言，不匹配 abort | 测试（mock init 形状） |
| A2 | 目标点之后有 wiki 写工具调用 | E2 FAIL：原生快照不覆盖 | UI 报成功、wiki 改动留存（信任级） | fail-closed 门禁禁用 + 披露 | 测试（含未知工具视为写） |
| A3 | 编排顺序写反（先 fork 后 rewind） | 实现失误 | fork 无 undo history → rewind 静默失效 | 设计（fork 延迟至下次发送，结构上必后于 rewind） | 测试 |
| A4 | 半态：rewindFiles 成功、pendingFork 未生效前异常 | 置 pending/裁剪后、debounce 落盘（auto-save 2s）前崩溃或 reload | 文件已回滚但会话未截断，续聊带旧上下文 | 置 pending+裁剪后**同步强制 flush 落盘，flush 成功才报 rewind 成功**；flush 失败显式披露+可重试（r2 P0 处置） | 测试 |
| A5 | rewindFiles 失败（canRewind:false / transport error） | checkpoint 缺失、session 文件损坏 | 若继续截断 = 会话截断但文件没回滚（反向半态） | 失败即停，不置 pending 不裁剪 | 测试 |
| A6 | rewind 与 in-flight turn 竞争 | 用户在生成中点 rewind / rewind 中发新消息 | 文件回滚与正在写入交错，状态不可预测 | 新增 per-conversation agentRewindLock（全局 isStreaming 表达不了会话级锁——审查 P1 实证） | 测试 |
| A7 | dialog catch 不清 agentRewindTargets（现有 bug） | invoke throw（sidecar 已死） | 按钮持续可点持续失败 | 修复：catch 清 target + 错误披露 | 测试 |
| A8 | resume 的最小 prompt 触发工具调用/新写入 | 模型对 "OK" 自主调工具 | rewind 前又产生新文件改动 | 一次性 Query 禁用全部工具 + maxTurns:1 | 测试（options 断言） |
| A9 | fork 后二次 rewind 锚点跨 fork 边界 | 用户连续两次回滚，第二次选 fork 前的点 | fork session 无 undo history → 假成功或报错不明 | 门禁按当前 session 边界重算，跨界目标禁用+披露 | 测试 |
| A10 | Rust broken-pipe vs sidecar transport_closed 双路径分叉 | sidecar 死的时机不同 | 前端两种错误形状，一条会 poison 一条不会 | 前端统一处理 + 一致的用户文案 | 测试 |
| A11 | 锚点 uuid 解析失败 | session JSONL 缺 snapshot / 内存 bookkeeping 为空 | 传错 uuid → rewind 到错误点 | 解析不到走 missing_message_id fail-closed | 测试 |
| A12 | 项目/会话切换竞态 | rewind 编排中用户切 conversation 或 project | pending/agentSessionId 更新写到错对象 | 编排按 conversationId 寻址写回（非"当前活跃会话"），完成时校验 id 匹配再刷 UI | 测试 |
| A13 | rewindFiles 在 transport 未就绪时调用 | resume Query 尚未收到 init | "ProcessTransport is not ready for writing"（E1 对照组实证） | 等 init 到达后再调；超时 fail-closed | 测试 |
| A14 | 旧 session 残留 junk "OK" turn 被后续误 resume | 异常路径下 pending 标记丢失 | 续聊 resume 回未截断旧 session（含 junk turn） | A4 持久化覆盖；成功发送路径断言 agentSessionId=fork 产物且 pending 已清 | 测试 |
| A15 | app reload 后 rewind 目标/toolCall 记录丢失 | rewind targets 为 runtime-only 状态 | 凭残缺数据判定门禁 → 穿透 | 数据缺失 = 目标不可用（fail-closed）；pending 字段例外——随 conversation 持久化 | 测试 |
| A16 | batch tool event 覆盖 toolCalls | chat-store.ts:597-601 直接赋值，同一 assistant 消息多批事件 | 前批 wiki 写调用被后批覆盖 → 门禁漏看（审查 P1 实证） | 修为合并语义 + 多批场景断言 | 测试 |
| A17 | 条件写工具被名单误判只读 | merge_duplicate_group（policy 列 READ 但 dryRun:false 写）、okf_import（apply:true 写） | 门禁放行 → 假成功回归 | 门禁分类层条件写一律按写；名单外工具默认写 | 测试 |
| A18 | 一次性 resume Query 泄漏 profile/secret claim | rewind 桥 Query 异常退出未走正常清理 | claim 占用累积，后续正常 turn 受影响 | claim 责任边界镜像现状：前端 streamAgent 同款路径获取（agent-transport.ts:517），Rust 命令按正常 stream 生命周期释放（含 finally）；Coder 先追真实 claim 流（r2 P1 处置） | 测试 |
| A19 | pending 未消费时二次 rewind | 用户连续回滚且中间不发消息 | resumeSessionAt 新旧值冲突语义不明 | latest-wins 覆盖 pending（门禁保证目标只能更早）；断言最终 fork 用最新值 | 测试 |

## 裁定已定项（design r2）

1. READ_ONLY 名单核实完毕（Codex 逐 handler）：list_projects/list_pages/read_page/search_pages/get_graph/build_answer_context/run_lint/get_agent_task_status/detect_duplicates/test_provider_connection/okf_validate/okf_export/get_knowledge_agents_config 确认只读；merge_duplicate_group、okf_import 为条件写 → 按写分类（A17）。policy READ 名单其余成员（collect_research_sources/optimize_research_topic/taxonomy_preview/synthesis_preview）本轮未逐 handler 核实 → **Coder 开工时核实，核实前按写分类**（fail-closed 只降可用性，r2 P3）。
2. fork 编排：不新造 one-shot 入口，复用 agentForkSessionPending 延迟 fork 基建 + 新增 agentResumeSessionAt（plan 设计要点 5）。
3. 互斥：不复用全局 isStreaming（表达不了会话级），新增 per-conversation agentRewindLock。
