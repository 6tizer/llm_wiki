# Plans Index

> 类型：计划索引 | 更新：2026-06-24 | owner：LLM Wiki commander / planner

## 当前有效计划

这些文档是当前计划的单一入口。旧文档若与本索引冲突，以本索引和下列计划为准。

| Plan | Charter | Status |
|------|---------|--------|
| [mac-product-baseline.md](./mac-product-baseline.md) | 下一实现 PR：把产品、CI、release、app identity 口径收敛到 Mac-only active maintenance。 | active |
| [upstream-sync-phase6.md](./upstream-sync-phase6.md) | Phase 6：基于上游 `v0.5.0` 的手动同步路线，保留本地 Agent sidecar/docs/Agent UI 差异。 | active |
| [upstream-0.5-delta.md](./upstream-0.5-delta.md) | 每个后续实现 PR 前的 v0.5.0 delta 调研入口和分流规则。 | active |
| [agent-sidecar-phase6.1.md](./agent-sidecar-phase6.1.md) | Phase 7 backlog：Agent SDK productization；文件名保留历史编号。 | backlog |
| [native-architecture.md](./native-architecture.md) | Swift/SwiftUI/iOS/native 架构 ADR 入口；当前不改变 Tauri/Rust/TS 主线。 | ADR backlog |

## Historical Archive

Phase 1-5、Phase 3.x、旧 roadmap 和 follow-up 文档保留为历史记录，用于追踪设计决策、验收证据和已完成工作。它们不是当前 roadmap 的权威来源。

历史文档中的跨平台承诺、Windows/Linux release 口径、旧 Phase 6+ 命名、上游 `v0.4.25` 目标或后续 PR 顺序，如果与本索引或当前有效计划冲突，以本索引、`mac-product-baseline.md`、`upstream-sync-phase6.md` 和 `upstream-0.5-delta.md` 为准。

## Maintenance Rules

- 新计划先加入本索引，再作为 implementation PR 的依据。
- 完成或废弃的计划保留原文，但要在本索引移出 active 列表或标注为 archive。
- 不在旧文档里反复改写历史事实；只修会误导当前执行的交叉引用。
- docs-only roadmap PR 不代表 CI/release 已完成清理；实际 pruning 由 `mac-product-baseline` 实现 PR 处理。
