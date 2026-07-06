# SPEC-14 Closeout 报告（A2 验收窗口，2026-07-06）

> 结论：**SPEC-14 completed**。四项功能 PR（① #344 / ② #347 / ③ #355 / ④ #357）+ closeout hotfix #361 全部合并；A2 生产构建 IA 走查九项完成；两维度深度 review 发现（P0×2/P1×3）经 #361 闭环。

## 1. A2 验收：生产构建 IA 走查（构建 = main@b6d1db32，/Applications 实机）

| 项 | 结果 |
|---|---|
| 对话视图：面板右移展开态 + 折叠窄条态（①） | ✅ 截图对照；折叠偏好跨视图保持 |
| 资料视图 × 折叠态回归（①） | ✅ |
| 探索 tabs：图谱→搜索→深度研究；深研 tab 渲染 ResearchPanel（②） | ✅ |
| 主导航 4 项 + 设置独立入口（②） | ✅ |
| Wiki 健康五 tabs + Dashboard（健康分 97/100、Lint 子分/派生惩罚/审阅惩罚分项、问题列表带一键跳转，审阅 tab 计数角标）（③） | ✅ |
| composer「自动 ▾」连接分组（连接标题/自动顶置/DEEPSEEK 组含 endpoint/权限策略+「仅作用于本对话」提示）（④） | ✅ |
| #339 复验：选「自动」→ label 即时变，重选 DeepSeek → 即时恢复，全程不发消息（④） | ✅ |
| #338 复验：真实 API 触发长行 bash 代码块回复 → 气泡内 pre 约束生效不外溢（④） | ✅ |
| A2 新发现：用户消息气泡不可断长 token 溢出（agent 侧已修的同族 user 纯文本路径） | → **#359**（独立跟踪，需 DOM 实检） |

## 2. Closeout 深度 review（两维度多代理，main@6f1e74d4）

- **维度① UI 路径级组合面**：P1=「去审阅」跳转在 ③ tabs 化后 scrollIntoView 静默落空（跨 PR 组合回归，类型不报错）；P2=设置侧 Manage-in-Governance 落 Dashboard、健康中心 tab 不跨挂载保持；P3=research.emptyHint 陈旧文案。②×③三段跳转链（审阅深研→别名→pendingExploreTab）与 ③×④ lint 修复池路由（review 族 streamChatRouted）路径级验证通过；i18n en/zh 1102 键全 parity 零死键。
- **维度② store/状态机生命周期**：P0=derivedLayerStore 项目切换不重置且 Dashboard 不自载（健康分可跨项目串数据/null 伪满分——SPEC-11 S8 教训的未覆盖 store）；P0=agentProfileIdOverride 悬挂（label/勾选/transport 三面不一致，stale id 持续发往后端）；P1=lint 忙态跨实例不共享、pendingExploreTab 漏 store-boundary 契约账；P2=fork 不继承 override（产品语义确认→issue）。

## 3. Closeout hotfix #361 修复映射

六项全闭环：derivedLayerStore reset+自载+未知态；悬挂 override 加载成功即清（**复查 BLOCK 抓到修复自身残留**：空候选列表分支不清——Commander 修正裁定「空列表=合法已加载态」，四场景测试钉死）；pendingWikiHealthTab 镜像模式（去审阅跳转+滚动恢复、Manage-in-Governance 落点）；lint 忙态模块级共享 store；契约补账；文案更新。

## 4. Follow-up 登记

- #359 用户气泡长 token 溢出（DOM 实检）
- fork 会话不继承 profile/权限 override 的产品语义确认（新 issue）
- ZCode ④ P2：override 指向已删 profile 的勾选态边缘（#361 自动清除后基本消解，残留=清除前一帧展示）——随 #359 观察

## 5. Deferred wiring 对账

无 deferred wiring：四项功能全部接线并经 A2 实机走查；pendingWikiHealthTab/pendingExploreTab 均有双端（设/消费）生产调用。

## 6. 教训

- 跨视图跳转 + 视图内部 tabs 化 = per-PR gate 盲区的典型形态（调用方类型不变、静默 no-op）——「跳转类调用点全仓 grep」应进 tabs 化改动的 checklist。
- 新增 store 必须同步问「项目切换要不要重置」（reset-project-state 名单）与「进不进 store-boundary 账」。
