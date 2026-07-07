# 三轨清仓 GOAL 总验收报告

> 类型：final acceptance | 日期：2026-07-06 | owner：LLM Wiki commander
> 入口对账：[post-1.0-backlog-triage.md](./post-1.0-backlog-triage.md)（四池全清）

## GOAL 定义与达成

**GOAL（2026-07-06 用户拍板）**：三轨并行、轨内串行，完整完成 SPEC-15（Agent 可用性）、SPEC-16（UI 交互质量）、池 C+池 D 长尾清仓；三轨收口 + 总报告合并 = 达成，backlog 只剩 SPEC-9（Swift，deferred）。

**✅ 达成**：27 PR（#380–#406）全部合并；四池全清；backlog 净剩 SPEC-9（deferred）+ 本 GOAL 新拆的两个 follow-up（#405/#407）。

> **2026-07-07 收尾**：两个 follow-up 也已双轨清掉（#410 关 #405 rewind 方案 B、#411 关 #407 两条 P3），main=`7a971ffc`。**open backlog 彻底清零，仅剩 SPEC-9（deferred，charter spec-9-swift-shell-reentry.md，deferred/gated，非 open issue）**。详见 §「follow-up 收尾」。

## 三轨交付

| 轨 | 范围 | Issue/PR | 状态 |
|---|---|---|---|
| 轨1 | SPEC-15 Agent 可用性 | #371/#372/#337/#340/#376/#352/#377/#362/#84（9 PR #380–#402）+ #66/#67 对账关闭 | [completed](./SPEC-15/closeout-report.md) |
| 轨2 | SPEC-16 UI 交互质量 | #373/#374/#359/#375/#378+#335（5 PR #382–#395） | [completed](./SPEC-16/closeout-report.md) |
| 轨3 | 池 C 长尾 | #286/#287/#289/#350/#351/#353/#313/#314/#311/#309（10 issue，PR #381–#406） | 全合并 |
| 轨3 | 池 D 维护性 | #183（PR #399） | 收口关闭 |

## Gate 纪律（全程一致）

- **Codex 主力 Coder**（六条工作流）：base_instructions 净化 + --json 事件流 + resume 修复轮；commit 权在 Commander。
- **内审 opus 主力 Reviewer**（厂商交叉：OpenAI 写、Anthropic 审）；**外审 ZCode** 副 gate（权限/契约/并发/rewind 完整性域 CRITICAL 从严）。
- **BLOCK→修复→复审闭环实证**：#337（P0 队首计时器/P1 zustand 副作用+暂停越界）、#373（内外双审 P1×2 项目切换竞态/多 draft 丢兄弟页）、#287（P0 anchor 误杀）、#351（P0 守卫谓词弱于运行时）、#313（P1 孤儿 job 无出口）、#309a（P0 orphan 级联假覆盖）、#309b（P2 gate .some 覆盖间隙）——外审抓到的组合/边界盲区若无对抗性审查会漏网。
- **CI**：每 PR 绿后合并；App.test.tsx 时序 flake 由 #353 稳定化；store-boundary 契约测试 CI 红一次经守护语义不弱化的方式适配（#183）。
- 每 merge 后：sync main → GitNexus 重索引 → track-sync → 本轨 agent-loop STOP。

## Closeout 组合面深审（抓跨 PR 盲区，单 PR gate 之外）

- **SPEC-15**：PASS 零阻塞。六组合验证——run-allow×resolver 作用域互斥；fallback timeline×三态非矛盾；**maxWriteBytes 第三护栏未随「默认关+run-allow」一起解除**；fork 不继承 run-allow；i18n parity。
- **SPEC-16**：PASS 零阻塞。notifier 五入口 debounce 合并无双触发；清预览×settings 跳转无冲突；气泡/pre 样式永不作用同元素；健康分公式与新 lint scope 同 commit 一致。
- 两 P3（permission-dialog 倒计时复用、notifier 路径形状）非阻塞 → #407。

## 真机验收（生产构建 0.7.0，main=51f859c9）

- 生产构建成功、装机 /Applications、启动**无白屏**、UI 渲染完整。
- 视觉级抽查确认：#359 长 token 气泡完整未左裁（A2 核心复现项）；#371 Runtime 26 jobs 非全「已取消」（A1 核心效果）；权限「跳过确认」模式在位；知识库/断路器/drift/三态 UI 在位。
- 真实 API 端到端操作走查（A1 §5.1 / A2 触控板+多窗口）因显示器睡眠+窗口焦点环境限制（HANDOFF 记录的已知非代码问题）降级为「组合深审 + 构建冒烟 + 视觉抽查」覆盖，如实记录不假报（详见各 closeout 报告 A1/A2 节）。

## backlog 终态

- **SPEC-9**（Swift/native）：按用户裁定继续 deferred，唯一剩余门槛外项。
- **新拆 follow-up**（本 GOAL 产出，非未清 backlog）：#405（run_deep_research 异步写 rewind 设计）、#407（P3 倒计时复用 + notifier 路径归一）——**均已于 2026-07-07 双轨清掉，见下节**。
- 四池对账文档翻转完成（[triage §3/§4](./post-1.0-backlog-triage.md)）。

## follow-up 收尾（2026-07-07 双轨）

#407（纯前端）与 #405（纯 sidecar/rewind gate）文件零交集 → 双 worktree 并行、墙钟减半；gate 纪律按域分级。

- **#410 关 #405**（rewind 完整性 CRITICAL 域，内审 opus + 外审 ZCode 双 PASS）：调查证实 `run_deep_research` 工具完成=任务入队，真实写入发生在 `deep-research.ts` `executeResearch` 的异步 `writeFile`（+ autoIngest fire-and-forget），**不走** appTool wikiChanges / sidecar snapshot 通道 → 方案 A（造异步快照锚点）不安全且性价比低，**用户拍板 rewind 略鸡肋 → 选方案 B**：gate 显式承认该通道不参与 rewind，新增 `deep_research_async` 专用 detail + en/zh 文案，保持 fail-closed。优先级 `mixed > ambiguous > uncovered > deep_research_async > allowed`——deep_research + 任意普通 uncovered 仍按 uncovered 阻断，不弱化任何现有判定；仍留写工具名单（drift guard 双侧一致）。
- **#411 关 #407**（P3，内审 opus PASS）：① permission-dialog 复用 `useCountdown`（保留暂停语义：暂停态传 `deadlineMs=null` 显示冻结 `pausedRemainingMs`，朴素替换会破坏暂停）；② wiki-change-notifier 边界归一 paths 为 wiki 根相对（去 `wiki/` 前缀），此前 inert，防未来按 path 过滤 / 渲染 `agentLint.paths` 触雷。

## 结论

三轨清仓 GOAL 达成。27 PR 全 gate 绿 + 两 closeout 组合深审零阻塞 + 生产构建冒烟通过。本报告合并即 GOAL 完成——backlog 只剩 SPEC-9（deferred）。
