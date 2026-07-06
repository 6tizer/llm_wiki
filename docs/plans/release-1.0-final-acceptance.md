# 1.0 门槛终验报告（F 验收窗口，2026-07-06）

> 结论：**1.0 门槛达成**。门槛三 SPEC（SPEC-13/14/8）全部 completed（各自 closeout 报告已入库），F 终验三项（M 冒烟 / IA 走查 / SPEC-8 行为无变化抽查）在 main@60882ffc 生产构建真机全部通过。

## 1. 门槛构成与达成状态

| SPEC | 状态 | PR | Closeout 报告 |
|---|---|---|---|
| SPEC-13 模型接入一站式 | completed | #324-#336/#341/#345/#348/#354（M 五项真实 API 验收全绿） | [SPEC-13/closeout-report.md](./SPEC-13/closeout-report.md) |
| SPEC-14 UI IA 二轮 | completed | #344/#347/#355/#357/#361/#363（A2 九项走查全过） | [SPEC-14/closeout-report.md](./SPEC-14/closeout-report.md) |
| SPEC-8 可维护性/工具/QA fixture | completed | #343/#346/#349/#356/#358/#360/#364-#369（两维度深审零 P0/P1） | [SPEC-8/closeout-report.md](./SPEC-8/closeout-report.md) |

三轨 GOAL 本轮共合并 **27 个 PR**（#343-#349、#354-#358、#360、#361、#363-#369），关闭 issue #86/#182/#312/#338/#339，#183 留言对账保持 open 追踪 P3 长尾。

## 2. F 终验证据（生产构建 main@60882ffc → /Applications 真机）

### 2.1 M 冒烟（真实 DeepSeek API）
- 对话页发送「总结 wiki 中向量检索与知识图谱互补性」→ Agent 流式回复 8.3s / 2 轮 / $0.13，回复内容准确引用 wiki「混合检索」「知识图谱」页面（agent 读 wiki 上下文成功）；活动时间线与回滚入口正常渲染。
- 全程零权限弹窗（测试项目保持「跳过确认」模式）、零钥匙串弹窗；composer「DeepSeek 跳过确认」标签正确。
- 截图：session scratchpad `f-02-sent.png`/`f-03-reply.png`。

### 2.2 IA 走查抽样
- 主导航 4 项（对话/资料/探索/Wiki 健康）+ 设置独立入口 ✅
- 探索：图谱/搜索/深度研究三 tabs，图谱默认渲染（11/14 页面、类型图例、洞察 6）✅（`f-04-explore.png`）
- Wiki 健康：五 tabs + Dashboard（健康分 97 自载、Lint 子分/派生惩罚/审阅惩罚分项、问题列表 3 条带「去处理」、审阅角标 3）✅（`f-05-health.png`）
- 资料视图 + 右侧知识库/文件面板（SPEC-14① 右移+折叠态展开/收起）✅（`f-06-library.png`/`f-07-knowledge-tree.png`）

### 2.3 SPEC-8 行为无变化抽查
- **真机全链路**：应用启动→init 配置 hydration→lastProject 自动打开→会话历史 38 条恢复→文件树/知识树/Runtime 任务列表加载——完整覆盖 PR9/PR10/PR11 抽取的 bootstrap 三段（useAppMountServices/runInitConfigHydration/useProjectLifecycle）在生产构建的真实执行路径 ✅
- **知识树**（closeout 顺带修的 flattenMdFiles dedup 消费路径）：Overview 1/Concepts 9/Sources 2 正常渲染，与图谱页面计数一致 ✅
- **套件级**（closeout 报告 §2 已记）：`cargo test --lib` 558/0；前端全量 2977 passed；契约断言破坏性验证有效。

## 3. 已知遗留（不阻塞 1.0 门槛）

- follow-up issues：#350-#353（SPEC-13 长尾）、#359（用户气泡长 token DOM 实检）、#362（fork override 语义）、#353（CI 时序 flake 族）
- SPEC-8 deferred/P3 长尾：见 SPEC-8 closeout §4/§5，随 #183 追踪
- 范围外 backlog（用户裁定不进门槛）：#337/#340/#309/#286/#287/#289/#311/#313/#314；SPEC-9 deferred

## 4. 方法论沉淀（三轨 GOAL 复盘要点）

- 三 worktree 轨间并行/轨内串行 + Codex 主力 Coder 全流程跑通 27 PR，双门（G1/G2）零冲突兑现；i18n「后合并轨 rebase」规则未触发实际冲突。
- closeout 深度 review 继续抓到 per-PR gate 盲区（本轮：rewindLocked 锁泄漏 P1、flattenMdFiles 第 4 处副本、deferred 决策未离开 PR body），「closeout 必做深审」纪律保持有效。
- 真机验收三次窗口（A1/A2/F）串行复用一次生产构建的策略成立，成本可控（F 冒烟 $0.13）。
