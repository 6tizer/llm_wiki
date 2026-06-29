# Plans Index

> 类型：计划索引 | 更新：2026-06-29 | owner：LLM Wiki commander / planner

## 当前有效计划

这些文档是当前计划的单一入口。已完成或历史计划已归档到 [`archive/`](./archive/)；归档文档若与本索引冲突，以本索引和根目录当前计划为准。

| Plan | Charter | Status |
|------|---------|--------|
| [spec-0-roadmap-baseline.md](./spec-0-roadmap-baseline.md) | 当前 roadmap / issue / archive 基线收口；后续 SPEC 的入口。 | active |
| [spec-1-app-architecture-decomposition.md](./spec-1-app-architecture-decomposition.md) | UI shell / Core Runtime / adapter 边界；为后续 runtime 和 Swift 回填铺路。 | completed |
| [SPEC-1/pr1-boundary-adr-plan.md](./SPEC-1/pr1-boundary-adr-plan.md) | SPEC-1 PR1 执行计划：shell/core boundary ADR、module boundary map、runtime command/event inventory。 | merged |
| [SPEC-1/adr-shell-core-boundary.md](./SPEC-1/adr-shell-core-boundary.md) | SPEC-1 PR1 ADR：UI Shell、Core Runtime、Platform Adapter、Agent Adapter、Storage Boundary、runtime command/event inventory。 | frozen for SPEC-2 |
| [SPEC-1/pr2-boundary-enforcement-plan.md](./SPEC-1/pr2-boundary-enforcement-plan.md) | SPEC-1 PR2 执行计划：headless contract 扩展、core runtime import/static boundary enforcement。 | merged |
| [SPEC-1/pr3-bootstrap-boundary-plan.md](./SPEC-1/pr3-bootstrap-boundary-plan.md) | SPEC-1 PR3 执行计划：App.tsx 非 UI bootstrap boundary inventory 和测试护栏。 | merged |
| [SPEC-1/pr4-store-boundary-plan.md](./SPEC-1/pr4-store-boundary-plan.md) | SPEC-1 PR4 执行计划：Store boundary inventory、Rust-locked app-state schema、Zustand mirror 分类。 | merged |
| [SPEC-1/pr5-adapter-contract-tests-plan.md](./SPEC-1/pr5-adapter-contract-tests-plan.md) | SPEC-1 PR5 执行计划：mock shell / platform / storage / agent adapter contract tests。 | merged |
| [spec-2-work-runtime.md](./spec-2-work-runtime.md) | Work Runtime、SQLite runtime ledger、job/lease/event/scheduler 底座。 | next |
| [SPEC-2/pr1-runtime-adr-plan.md](./SPEC-2/pr1-runtime-adr-plan.md) | SPEC-2 PR1 执行计划：runtime ADR、schema families、job state machine、single-writer hard gate。 | in progress |
| [SPEC-2/adr-work-runtime.md](./SPEC-2/adr-work-runtime.md) | SPEC-2 PR1 ADR：project-scoped runtime.db、kill switch、portable schema families、job transitions、SPEC-3/4 gates。 | accepted for PR1 gate |
| [spec-3-markdown-commit-layer.md](./spec-3-markdown-commit-layer.md) | Markdown commit layer、staging artifact、`index.md` / `overview.md` 去核心化。 | planned |
| [spec-4-model-profiles.md](./spec-4-model-profiles.md) | 用户选择的 Model/Profile、多供应商 capability probe、Model-call vs Agent-run Profile。 | planned |
| [spec-5-parallel-knowledge-pipeline.md](./spec-5-parallel-knowledge-pipeline.md) | #191 批量 prepare / commit / repair 的并行知识编译管线。 | planned |
| [spec-6-derived-knowledge-rebuild.md](./spec-6-derived-knowledge-rebuild.md) | embedding、graph、taxonomy、synthesis、optional index/overview 的异步派生重建。 | planned |
| [spec-7-unified-agentic-chat.md](./spec-7-unified-agentic-chat.md) | Unified Agentic Chat、Claude Agent SDK productization、session/permission/timeline。 | planned |
| [spec-8-maintainability-tooling.md](./spec-8-maintainability-tooling.md) | 维护性重构、GitNexus warning、QA fixture 和测试债收纳。 | planned |
| [spec-9-swift-shell-reentry.md](./spec-9-swift-shell-reentry.md) | Swift/SwiftUI native shell 回填锚点；等 core boundary 稳定后进入。 | deferred / gated |
| [upstream-0.5-delta.md](./upstream-0.5-delta.md) | v0.5.x delta 复核入口；不再承载完成证据，只用于后续 PR 开工前重新核对 upstream 并分流。 | active / recheck gate |
| [claude-agent-sdk-alignment.md](./claude-agent-sdk-alignment.md) | Claude Agent SDK alignment 背景资料；实际执行归入 SPEC-7 PR1。 | planned via SPEC-7 |
| [agent-sidecar-phase6.1.md](./agent-sidecar-phase6.1.md) | Phase 7 backlog：Agent SDK productization；文件名保留历史编号。 | backlog |
| [native-architecture.md](./native-architecture.md) | Swift/SwiftUI/iOS/native 架构 ADR；Swift 实现 deferred，但 native-ready boundary 已由 SPEC-1 纳入当前主线。 | active boundary / deferred implementation |

## Historical Archive

已完成内容已移动到 [`archive/`](./archive/)，用于追踪设计决策、验收证据和已完成工作。它们不是当前 roadmap 的权威来源。

归档范围包括：

- Agent Sidecar Phase 1-5.2、旧 roadmap 和 follow-up plan。
- Mac-only product baseline。
- Phase 6 upstream sync、Chat Agent Router alignment、PR K AnyTXT options。
- OKF compatibility 与 Knowledge Wiki business-layer completed baseline。
- Security review #119、#120、#126-A/B/C/D completed plan。

历史文档中的跨平台承诺、Windows/Linux release 口径、旧 Phase 6+ 命名、上游 `v0.4.25` 目标或后续 PR 顺序，如果与本索引或当前有效计划冲突，以本索引和当前根目录计划为准。

## Maintenance Rules

- 新计划先加入本索引，再作为 implementation PR 的依据。
- 每个 SPEC 的 PR 级执行计划放在 `docs/plans/SPEC-N/`，只在对应 PR 开始时创建或更新；阶段 SPEC 文档继续保留在 `docs/plans/spec-N-*.md`。
- 完成或废弃的计划保留原文，并移动到 `docs/plans/archive/`。
- Current Execution Order 以本索引为 canonical；其他计划文档中的顺序列表只是对应领域的镜像摘要，后续改序必须先改本索引，再同步必要镜像。
- `docs/plans/**` 已恢复默认可跟踪；新增计划文档正常 `git add docs/plans/<file>.md` 即可。`docs/` 下其他本地文档仍默认忽略。
- GitNexus CLI canonical command 使用连字符：`npx gitnexus detect-changes --repo llm_wiki`；MCP/tool 名称可能使用下划线 `detect_changes`，不要混写。
- 不在旧文档里反复改写历史事实；只修会误导当前执行的交叉引用。
- docs-only roadmap PR 不代表 CI/release 已完成清理；实际 pruning 由 `mac-product-baseline` 实现 PR 处理。

## Current Execution Order

截至 2026-06-29，当前 main/head 基线为 `f16210a chore: track planning docs by default`。Phase 6 的 PR A-K 主线 port 已完成到 #148，follow-up sweep 已完成到 #164，安全/质量 backlog #120/#126 系列已完成到 #170。OKF + Knowledge Wiki business-layer stream 已完成，并已归档；SPEC-0 到 SPEC-9 已由 #192 定稿，SPEC-1 已由 #194-#199 完成，#200 恢复 `docs/plans/**` 默认可跟踪。后续不再按旧 OKF/KW 队列或旧 Phase 7 队列执行。

已完成 OKF/KW 基线证据：

1. `f9f63c5` KW-QA：QA manual save baseline。
2. `e300cdd` OKF-A：validator/export。
3. `67f54f6` OKF-B：import/mapping。
4. `95e4bb9` KW-B1：Knowledge Agents 配置基座 + Settings 骨架。
5. `8ea2326` KW-B2：Prompt Registry。
6. `127fc9e` KW-C1：三层标签体系 schema + bootstrap/growth 基座。
7. `3a01730` KW-D：Synthesis 多维主题发现 + preview/generate UI。
8. `ad0b9d5` KW-C2：Tag Agent taxonomy-aware 自动打标/自动生长。
9. `248bd27` OKF-C：统一 Agent tools + MCP/local API 暴露。

Next execution sequence：SPEC-1 已完成；下一步是 SPEC-2 PR1（Runtime ADR + schema/state-machine hard gate），定义 tables、state machine、operation names、feature flag / kill switch、single-writer DB actor。SPEC-2 runtime DB/job API 必须落在已冻结的 shell/core boundary 内。SPEC-2 PR1 合并前，SPEC-3/4 只能做独立调研或草案，不能做依赖 runtime schema 的集成实现。允许的 parallel preparation 仅限 docs、ADR、接口草案和只读调研；任何触碰 shared runtime types/schema、持久化 runtime state 或 core API implementation 的代码 PR 必须等待对应 gate 合并。SPEC-2 PR1 合并后，再推进 SPEC-3/4 integration PR，随后进入 SPEC-5/6。SPEC-7 PR1（SDK alignment）可并行准备；SPEC-7 PR2 rewind 必须等 SDK alignment 完成，SPEC-7 PR4 unified input shell hard-blocked by SPEC-2 job ledger。SPEC-9 Swift shell re-entry deferred，只有 SPEC-1 到 SPEC-8 的 core boundary 和关键 runtime API 稳定后才进入实现。

当前主线不跳过 SPEC-2 直接进入 Phase 7 / Unified Agentic Chat 完整实现，也不继续按旧 OKF/KW 队列执行；Claude Agent SDK alignment 现在归入 SPEC-7 的前置 PR，可按依赖规则并行准备。

Swift/SwiftUI/iOS/native 实现继续 deferred；但 native-ready shell/core boundary 已进入 SPEC-1，后置 Swift 回填由 SPEC-9 承接。
