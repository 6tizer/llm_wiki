# SPEC-7: Unified Agentic Chat / Claude Agent SDK 产品化

> 类型：阶段 SPEC | 状态：PR1/PR2 completed（#277/#291），PR3-PR7 ready | 覆盖：#190、#60、#66、#67、#68、#84、#86 | 依赖：SPEC-1 shell/core boundary、SPEC-2 job creation API、SPEC-4 Agent-run Profile preflight、**SPEC-10（权限绕过/密钥泄露修复）**、**SPEC-12 PR1/PR2（runtime 转正 + 设置分组，前置于本 SPEC PR4/PR6）**

## 2026-07-05 UI 走查修订（必读，约束 PR3-PR6 范围）

依据：`SPEC-12/ui-audit-2026-07.md`（生产 app 全页走查 + Notion AI 实机对照 + 用户裁定 D1-D5）。

- **PR4 范围修订**：
  - 路由四档（fast/standard/deep/local_first）**删除而非下沉**（裁定 D4，取代下文「下沉为高级控制」的旧表述）：统一 Agent 化后，深度=profile 选择的结果、本地优先=profile 隐私属性，全部收进模型选择器语义。
  - composer 目标范式（Notion N1-N3）：输入框 + 「＋」（文件/图片，拖入等价）+ 「来源 ▾」（网页搜索/AnyTXT 收纳）+ 「**自动 ▾**」（模型/profile/权限选择器，默认自动路由，运行中显示真实 claimed profile）。不再有平铺 checkbox 与模式切换。
  - 「提取」双入口（裁定 D1）：资料页「选文件→讨论→写入」+ 对话页拖入/「＋」触发，同一条 ingest 流程；chat 顶层「提取」模式移除。
  - 空态建议卡（N5）与任务向文案（N7）并入本 PR。
- **PR3 范围追加**：错误产品化——模型/权限/限额类错误映射为可操作卡片（换模型/去设置），CLI 原文进详情折叠（走查 A5；实证 A3：用户遭遇 deepseek-v4-flash CLI 报错原文透传、无从预判用哪个模型）。
- **PR6 调整**：profile 事件回传（Core→shell）同时服务 PR4 的「自动 ▾」运行态显示，事件管道提前至 PR4 之前或并入 PR4；权限默认值页落进 SPEC-12 PR2 的「AI 与模型」分组（依赖 SPEC-12 PR2）。
- **PR5 追加**：Agent 写操作接入待审阅动线（变更预览 accept/reject，Notion N8），与 rewind（#291）同屏。

## 2026-07 Review 补充（必读）

深度 review（见 `spec-5-8-post-review-findings.md`）对本 SPEC 的三处 PR 有实质影响：

- **SDK 落差是实质性的，PR1 不是例行 `npm update`**：`src-tauri/sidecar/package.json` 声明 `^0.3.148`，lock 锁定 `0.3.150`，最新稳定约 `0.3.198`（落后约 48 个 patch）。0.x 无稳定性保证，这个跨度足以让 `rewind-bridge.ts` 依赖的报错文案、`SDKMessage` 结构变化。PR1 必须先核对这些版本变更日志，**重点确认 SDK 是否已提供官方 rewind 状态 / typed unavailable reason**——若已提供，直接改变 PR2 范围（去掉正则 fallback）。
- **PR3 范围应扩大到 per-run 状态隔离**：`chat-store.ts` 的权限请求队列（`163-164`，全局单例不按 streamId）和 rewind target 都是"本该按 run 隔离却放全局槽位"，与 compact/resume 是同类问题，应显式并入 PR3，不要拖到 PR6 才发现耦合。compact/resume 检测当前是脆弱纯英文正则（`agent-summary.ts`），SDK 对齐后换结构化字段而非继续打补丁。
- **PR6 一项成功标准当前完全没打通**：footer/timeline 显示真实 selected/claimed profile —— resolved model 目前只打到 `agent.rs:404-408` 的 Rust stderr，从未经事件回传前端。PR6 需新增一条 profile 事件，不只是 UI 改动。
- **权限绕过与密钥泄露先由 SPEC-10 修**：wiki 写工具绕过审批（S4）、SDK 异常经 stdout 泄露密钥（S3）是当前就存在的安全问题，SPEC-10 先收口；SPEC-7 的 permission UI 在其上做产品化，复用同一 permission bridge，不新造第二套。

## 目标与成功标准

统一用户入口，去掉可见的 Chat / Agent / Ingest 三模式割裂，用 Unified Agentic Chat 作为控制面。

成功标准：

- 用户从一个输入入口发起普通对话、工具任务、ingest job、review、repair、background workflow。
- Claude Agent SDK 升级并验证 latest stable。
- rewind 修复顺序：先完成 Claude Agent SDK alignment，再实现 official resume-then-`rewindFiles(userMessageId)` 路径；done/error/stopped 流的 rewind 入口必须禁用或隐藏，不能触发 `ProcessTransport is not ready for writing`。
- compact/resume summary 是 session state，不是普通 assistant message。
- 最新用户纠正消息优先于 stale pending intent。
- 权限入口同时存在于对话区和 Settings。
- 对话区必须能选择 Agent-run profile 和 permission policy；footer / timeline 显示真实 selected/claimed profile，而不是 legacy `llmConfig.model`。
- activity timeline 显示 tool calls、permissions、progress、recovery。
- Unified Chat 的核心编排通过 Core Runtime / Agent Adapter 暴露；React 或 Swift shell 只负责输入、权限确认和 timeline 渲染。

## 关键设计决策

- Unified Agentic Chat 是用户入口；Model-call/Profile workers 是内部执行能力。
- Claude Agent SDK 仍是 Agent-run 基础，不替换为 upstream Chat Agent Router。
- SPEC-7 消费 SPEC-4-FIX PR3 的 Agent-run compatibility 基座，不重新定义 provider auth env、`agentSdkModelId` 或 LiteLLM gateway contract。
- 代码现实：当前 `src/components/chat/chat-panel.tsx` 仍有可见顶层 `chat` / `agent` / `ingest` mode；`src/components/chat/chat-input.tsx` 另有 `fast` / `standard` / `deep` / `local_first` Agent route selector。目标不是删除所有路由能力，而是取消顶层入口割裂，把 route/profile 选择下沉为高级控制。
- 普通对话可以走 model-call，但用户不需要先选 Chat/Agent/Ingest 模式。需要工具/文件修改时，系统必须在同一个入口内引导到 Agent-capable Profile 或解释不可用原因。
- 如果当前没有可用 Agent-capable Profile，Unified Chat 按 SPEC-4 canonical fallback policy 处理：工具/修改动作禁用并显示 Settings 修复入口，纯阅读/问答可继续走 Model-call Profile。
- #3/#65 已 superseded，不作为 active implementation issue。
- PR1（SDK alignment）可与 SPEC-1/2/3/4 并行准备；PR2 rewind hard-depends on PR1，优先使用 SDK official state / typed unavailable reason。若 SDK 仍没有 typed state，才保留受测试保护的 transport error matcher fallback。PR4 unified input shell hard-blocked by SPEC-2 job ledger。

## 预期 PR 拆分

1. Claude Agent SDK alignment：升级依赖（当前落后约 48 patch，须逐版本核对变更日志，确认是否已有官方 rewind 状态/typed unavailable reason），验证 schema、transport、permissions、sessions；以 SPEC-4-FIX PR3 的 profile compatibility 为前置基座。
2. Official rewind/resume flow：修 #60；依赖 PR1 SDK alignment；PR1 若确认官方 typed rewind 状态可用，则移除 `rewind-bridge.ts` 的报错文案正则 fallback。
3. Session state + per-run 状态隔离：compact summary、pending confirmation、latest user correction；**并入权限请求队列、rewind target 按 streamId/conversationId 隔离**（当前是全局单例，findings P2）；compact/resume 检测改用 SDK 结构化字段替代脆弱英文正则。
4. Unified input shell：移除三入口产品目标，接入 SPEC-2 runtime job creation，并接入 Agent-run profile selector 与 permission policy selector；此 PR blocked by SPEC-2 job ledger，并必须遵守 SPEC-1 shell/core boundary。
5. Activity timeline：tool/progress/permission/recovery。
6. Permission UI：conversation-level + Settings defaults；footer / timeline 展示真实 selected/claimed profile 和 permission policy。**注意：resolved profile 当前只在 `agent.rs:404-408` 打 Rust stderr，从未回传前端；本 PR 需先新增一条 profile 事件（Core Runtime → shell），否则 footer 无数据可显示。** 复用 SPEC-10 修正后的现有 permission bridge，不新造第二套审批路径。
7. Dev QA fixture 场景接入：稳定触发 active/done rewind、compact summary、pending correction、permission、resource limit、timeline；fixture infrastructure owner 是 SPEC-8，SPEC-7 owner 是 Agent 场景覆盖。

## 验证策略

- sidecar smoke：spawn、stop、permission approval、tool call、resume、rewind。
- rewind-disabled-on-completed-stream：done/error/stopped 后不能触发 closed transport rewind。
- UI tests 覆盖 unified entry、profile selector、permission selector、pending confirmation、真实 selected/claimed profile footer、timeline render。
- QA fixture 可重复构造 #60/#66/#67/#68/#84/#86 场景，包括 compact summary、pending correction、active/done rewind、resource limit、dev-only/生产不可见。
- Playwright 截图覆盖 light/dark、窄宽度、权限弹窗、timeline。

## Gate 结论摘要

本 SPEC 随当前 docs PR 通过 PR-level gate；详见 [SPEC-0](./spec-0-roadmap-baseline.md) 的 PR Gate 结论统一摘要。实现 PR 必须重新审查当前三入口代码迁移、SDK rewind 顺序、Agent-capable fallback、QA fixture owner 边界和 Swift shell re-entry compatibility。

## Non-goals / Follow-up

- 不暴露隐藏 chain-of-thought。
- 不把所有 bulk model work 变成 Agent session。
- 不保留旧三入口作为长期产品目标。
- 不把 SDK secrets 或 jsonl 私有路径写入日志/PR/测试快照。
