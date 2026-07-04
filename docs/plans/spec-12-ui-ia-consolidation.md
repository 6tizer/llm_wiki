# SPEC-12: UI 信息架构收敛（设置重组 · Wiki 健康中心 · Runtime 转正）

> 类型：阶段 SPEC | 状态：reviewed / ready for PR split | 依据：2026-07-04 生产 app 全页 UI 走查（`SPEC-12/ui-audit-2026-07.md`）+ 用户裁定 D1-D5 | 依赖：SPEC-4/4-FIX（profile 体系）、SPEC-5-FIX/6（runtime 与派生层）、与 SPEC-7 PR3-PR6 交错（见「与 SPEC-7 的接口」）

## 背景与三个病根

对生产 app（main 9b533cf0 构建）的 8 个主导航页、23 个设置页、对话 3 模式做了全量走查。功能都在，但 UI 是按代码路径长出来的，不是按用户任务设计的：

- **R1 配置、操作、状态混置**：设置里藏着 5 个「点了会干活」的工作台（标签体系/综合/索引/维护/派生状态），主导航里又有同类（Wiki 检查、待审阅）。
- **R2 「模型的事」散落五处且新旧两代同屏**：legacy「LLM 模型」（单活跃 provider ×15）与新「模型 Profiles」并存；新体系整页被 runtime 开关禁用，生产 UI 提示用户设 `LLM_WIKI_CORE_WORK_RUNTIME_ENABLED=true` 重启（dev 指令泄漏）。向量嵌入、图片描述、搜索 provider 又各占一页。
- **R3 实现细节直通 UI**：三模式=三条代码路径直接暴露；「Agent」与「Knowledge Agents」两个设置页无法从名字区分；主导航纯图标无标签无 AX 名称。

（R3 中对话侧的部分归 SPEC-7 修，见接口节。）

## 目标与成功标准

1. **Work Runtime 生产转正**：默认开启；模型 Profiles、派生状态等页在生产可用；任何「功能被禁用 + dev 指令」的 UI 不复存在。
2. **设置收敛为三组**：AI 与模型 / 知识流水线 / 应用。用户配置「一个能用的 AI」只需理解一个页面。
3. **模型配置合一**：Provider 连接（含搜索 provider）+ 任务分配矩阵（chat/agent/嵌入/视觉/搜索 各任务用哪个 profile）一页完成；legacy「LLM 模型」走完退役路径删除。
4. **Wiki 健康中心**：状态总览（派生状态）→ 待办（检查结果+待审阅）→ 操作（标签体系/综合/索引重建/查重）一个页面收拢；治理操作从设置中消失。
5. **主导航 8→5 并加文字标签与 AX 名称**：对话 · 资料 · 探索（搜索+图谱）· Wiki 健康 · 深度研究。

## 关键设计决策（用户已裁定）

- **D3 runtime 转正而非隐藏**：SPEC-5-FIX/SPEC-6 之后 runtime 路径已过全套 gate；转正是 legacy 退役的前提。
- **D2 独立 SPEC**：与 SPEC-7 PR 序列解耦，轨间并行。
- **D5 主导航五分法**认可。
- 设计范式参照 Notion AI 实机走查（N1-N8，见 audit 文档）：把选择后置、把过程前置；能力扩展做成可关闭的渐进披露引导，而非设置深处的一页。
- 「维护/查重」等低频操作进 Wiki 健康中心的「操作」区，不单独成导航项。
- 更名：「Knowledge Agents」→「流水线代理」；「Agent」→「Agent 运行限额」（归入「应用」组）。

## 预期 PR 拆分

1. **PR1 Runtime 转正**：`LLM_WIKI_CORE_WORK_RUNTIME_ENABLED` 默认 true（或移除 gate）；禁用态 UI 分支清理（模型 Profiles、派生状态页的禁用提示删除；若保留关闭能力则整块隐藏而非禁用+提示）；全套 runtime smoke（profile 保存/探测/调度、派生重建按钮）作为 Wiring Gate 证据。**前置于 SPEC-12 PR3 与 SPEC-7 PR4/PR6。**
2. **PR2 设置分组骨架**：设置侧栏三组导航（AI 与模型 / 知识流水线 / 应用）+ 现有页面归位迁移 + 两处更名 + 「资料监控/定时导入/MinerU」合并为「导入」一页。纯结构迁移，不改行为。**前置于 SPEC-7 PR6。**
3. **PR3 模型配置合并页**：连接层（合并 legacy 15 家 provider + 搜索 6 家的密钥/端点管理）+ 分配矩阵（任务族 × profile，向量嵌入/图片描述从独立页降为矩阵行）+ **权限默认值设置页 UI**（消费 SPEC-7 PR6 交付的契约——归属裁定见下节）；legacy「LLM 模型」转只读迁移向导（读取现有活跃 provider 生成对应 profile），一个版本周期后删除。依赖 PR1。
4. **PR4 Wiki 健康中心 + 主导航收敛**：新页面骨架（总览=派生状态组件复用 / 待办=检查+待审阅 / 操作=标签体系+综合+索引+查重迁入）；主导航 8→5、文字标签、AX 名称补全；「深度研究」从待审阅页的抽屉独立为导航项内容区。
5. **Closeout**：legacy 删除收尾、README/文档收口、全页面截图对照（light/dark/窄宽）。

## 与 SPEC-7 的接口（关键排序约束）

| 先后 | 原因 |
|------|------|
| SPEC-12 PR1 → SPEC-7 PR4/PR6 | 「自动 ▾」profile 选择器与权限默认值都要求 runtime 在生产活着 |
| SPEC-12 PR2 → SPEC-7 PR6 | PR6 的会话级权限 UI 引用的「设置修复入口」指向新「AI 与模型」分组 |
| SPEC-7 PR3 ∥ SPEC-12 PR1/PR2 | 会话状态隔离不依赖设置结构，双轨并行 |
| chat-store/chat 组件归 SPEC-7 轨独占；设置组件归 SPEC-12 轨独占 | 避免跨轨文件冲突 |
| **权限默认值归属裁定**：SPEC-7 PR6 交付契约/事件 + 会话级权限 UI + footer；**设置页 UI 由本 SPEC PR3 承接** | 与文件边界一致，消除双认领 |

对话侧的修订（四档路由删除 D4、提取双入口 D1、composer「自动 ▾ + ＋ + 来源」范式、空态建议卡、错误产品化）已作为 2026-07-04 修订节写入 `spec-7-unified-agentic-chat.md`，不在本 SPEC 范围。

## 验证策略

- PR1：runtime-on 全链路 smoke（profile CRUD/探测/任务调度/派生重建），生产构建验证（非 dev）。
- PR2/PR3/PR4：每页截图对照（light/dark/窄宽）；设置项迁移前后完整性清单（23 项一一对账，不许静默丢配置入口）；legacy 迁移向导的幂等与回退测试。
- 导航与 AX：每个主导航项与设置组有 AX 名称（自动化与无障碍双验）。
- 治理操作迁移后，原设置路径的深链/引用全部重定向或清除（orphan-check + 全文引用扫描）。

## Non-goals

- 对话区 composer 重构（SPEC-7 PR4）。
- profile 事件回传、会话级权限 UI 与 footer（SPEC-7 PR6）；权限默认值的**设置页 UI** 属本 SPEC PR3（见接口节裁定）。
- 新增任何流水线能力；本 SPEC 只动信息架构与 runtime 门。
- Swift shell（SPEC-9 deferred）。
