# Plans Index

> 类型：计划索引 | 更新：2026-06-28 | owner：LLM Wiki commander / planner

## 当前有效计划

这些文档是当前计划的单一入口。旧文档若与本索引冲突，以本索引和下列计划为准。

| Plan | Charter | Status |
|------|---------|--------|
| [mac-product-baseline.md](./mac-product-baseline.md) | 已完成基线：把产品、CI、release、app identity 口径收敛到 Mac-only active maintenance。 | completed |
| [upstream-sync-phase6.md](./upstream-sync-phase6.md) | Phase 6：PR A-K 主线已完成；现在只作为完成证据、follow-up 路由和后续 delta 校准入口。 | completed / routing |
| [upstream-0.5-delta.md](./upstream-0.5-delta.md) | v0.5.x delta 调研入口；PR E/H/G/F/I/J/K 已完成，后续用于 residual upstream delta 和新实现 PR 分流。 | active |
| [upstream-chat-agent-router-alignment.md](./upstream-chat-agent-router-alignment.md) | 普通 Chat 对齐 upstream `v0.5.x` Chat Agent Router；PR G 核心和 #135/#136 UI polish follow-up 已完成。 | completed |
| [claude-agent-sdk-alignment.md](./claude-agent-sdk-alignment.md) | Phase 7 前置：sidecar 对齐 Claude Agent SDK latest stable，并评估 SDK schema/permission/sandbox/hooks delta。 | active |
| [okf-compatibility.md](./okf-compatibility.md) | 把 `<project>/wiki/` 定位为 OKF-compatible knowledge bundle root，规划 validator/export/import/Agent tools。 | active |
| [knowledge-wiki-business-layer.md](./knowledge-wiki-business-layer.md) | 把 Knowledge Wiki Skill 定位为 OKF 之上的业务工作流层，规划 QA、Knowledge Agents、prompt registry、tag taxonomy、synthesis 和 Agent/API exposure。 | active |
| [security-review-119-fixes.md](./security-review-119-fixes.md) | issue #119 深度 review 的 4 个安全 PR、#120 和 #126-A/B/C/D 后续安全/质量串流均已完成；保留为历史证据。 | completed |
| [agent-sidecar-phase6.1.md](./agent-sidecar-phase6.1.md) | Phase 7 backlog：Agent SDK productization；文件名保留历史编号。 | backlog |
| [native-architecture.md](./native-architecture.md) | Swift/SwiftUI/iOS/native 架构 ADR 入口；当前不改变 Tauri/Rust/TS 主线。 | ADR backlog |
| [agent-sidecar-roadmap.md](./agent-sidecar-roadmap.md) | Agent Sidecar 历史总览入口；保留设计背景和已完成阶段，不作为当前执行顺序来源。 | historical |

## Historical Archive

Phase 1-5、Phase 3.x、旧 roadmap 和 follow-up 文档保留为历史记录，用于追踪设计决策、验收证据和已完成工作。它们不是当前 roadmap 的权威来源。

历史文档中的跨平台承诺、Windows/Linux release 口径、旧 Phase 6+ 命名、上游 `v0.4.25` 目标或后续 PR 顺序，如果与本索引或当前有效计划冲突，以本索引、`mac-product-baseline.md`、`upstream-sync-phase6.md` 和 `upstream-0.5-delta.md` 为准。

## Maintenance Rules

- 新计划先加入本索引，再作为 implementation PR 的依据。
- 完成或废弃的计划保留原文，但要在本索引移出 active 列表或标注为 archive。
- Current Execution Order 以本索引为 canonical；其他计划文档中的顺序列表只是对应领域的镜像摘要，后续改序必须先改本索引，再同步必要镜像。
- 本仓库 `.gitignore` 覆盖 `docs/`；新增计划文档必须使用 `git add -f docs/plans/<file>.md`，否则 PR 会出现断链或漏文件。
- 不在旧文档里反复改写历史事实；只修会误导当前执行的交叉引用。
- docs-only roadmap PR 不代表 CI/release 已完成清理；实际 pruning 由 `mac-product-baseline` 实现 PR 处理。

## Current Execution Order

截至 2026-06-28，Phase 6 的 PR A-K 主线 port 已完成到 #148，follow-up sweep 已完成到 #164，安全/质量 backlog #120/#126 系列也已完成到 #170。旧 PR E/H/G/F/I/J/K 顺序、旧 #143/#144/#139/#147/#146/#155 队列，以及 #156/#152/#135/#136/#128/#120/#126 后续队列都已完成或路由完毕。当前顺序改为 OKF + Knowledge Wiki 业务层串流：

1. Docs closeout + Knowledge Wiki business-layer calibration（当前 PR）。
2. KW-QA：QA 去自动化，改为显式手动保存。
3. OKF-A：validator/export。
4. OKF-B：import/mapping。
5. KW-B1：Knowledge Agents 配置基座 + Settings 骨架。
6. KW-B2：Prompt Registry 重构。
7. KW-C1：三层标签体系 schema + 自动 bootstrap/growth 基座。
8. KW-D：Synthesis 多维主题发现 + preview/generate UI。
9. KW-C2：Tag Agent taxonomy-aware 自动打标/自动生长。
10. OKF-C：统一 Agent tools + MCP/local API 暴露。
11. Claude Agent SDK alignment：Phase 7 前置 PR 7-0。
12. Phase 7 Agent SDK productization：#60、#65、#66、#67、#68、#84、#86、#3。
13. Swift/SwiftUI/iOS/native 架构继续作为远期 ADR，不进入近期实现队列。
