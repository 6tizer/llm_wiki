# Plans Index

> 类型：计划索引 | 更新：2026-06-25 | owner：LLM Wiki commander / planner

## 当前有效计划

这些文档是当前计划的单一入口。旧文档若与本索引冲突，以本索引和下列计划为准。

| Plan | Charter | Status |
|------|---------|--------|
| [mac-product-baseline.md](./mac-product-baseline.md) | 已完成基线：把产品、CI、release、app identity 口径收敛到 Mac-only active maintenance。 | completed |
| [upstream-sync-phase6.md](./upstream-sync-phase6.md) | Phase 6：基于上游 `v0.5.x` 的手动同步路线，保留本地 Agent SDK sidecar/docs/Agent UI 差异。 | active |
| [upstream-0.5-delta.md](./upstream-0.5-delta.md) | 每个后续实现 PR 前的 v0.5.x delta 调研入口和分流规则，含上游 Chat Agent Router 与本地 Agent SDK sidecar 边界。 | active |
| [upstream-chat-agent-router-alignment.md](./upstream-chat-agent-router-alignment.md) | 普通 Chat 对齐 upstream `v0.5.x` Chat Agent Router，并把 PR G 升级为 Chat Agent Router alignment + multimodal chat。 | active |
| [claude-agent-sdk-alignment.md](./claude-agent-sdk-alignment.md) | Phase 7 前置：sidecar 对齐 Claude Agent SDK latest stable，并评估 SDK schema/permission/sandbox/hooks delta。 | active |
| [okf-compatibility.md](./okf-compatibility.md) | 把 `<project>/wiki/` 定位为 OKF-compatible knowledge bundle root，规划 validator/export/import/Agent tools。 | active |
| [agent-sidecar-phase6.1.md](./agent-sidecar-phase6.1.md) | Phase 7 backlog：Agent SDK productization；文件名保留历史编号。 | backlog |
| [native-architecture.md](./native-architecture.md) | Swift/SwiftUI/iOS/native 架构 ADR 入口；当前不改变 Tauri/Rust/TS 主线。 | ADR backlog |
| [agent-sidecar-roadmap.md](./agent-sidecar-roadmap.md) | Agent Sidecar 历史总览入口；保留设计背景和已完成阶段，不作为当前执行顺序来源。 | historical |

## Historical Archive

Phase 1-5、Phase 3.x、旧 roadmap 和 follow-up 文档保留为历史记录，用于追踪设计决策、验收证据和已完成工作。它们不是当前 roadmap 的权威来源。

历史文档中的跨平台承诺、Windows/Linux release 口径、旧 Phase 6+ 命名、上游 `v0.4.25` 目标或后续 PR 顺序，如果与本索引或当前有效计划冲突，以本索引、`mac-product-baseline.md`、`upstream-sync-phase6.md` 和 `upstream-0.5-delta.md` 为准。

## Maintenance Rules

- 新计划先加入本索引，再作为 implementation PR 的依据。
- 完成或废弃的计划保留原文，但要在本索引移出 active 列表或标注为 archive。
- 不在旧文档里反复改写历史事实；只修会误导当前执行的交叉引用。
- docs-only roadmap PR 不代表 CI/release 已完成清理；实际 pruning 由 `mac-product-baseline` 实现 PR 处理。
