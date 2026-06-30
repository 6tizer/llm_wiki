# Plans Index

> 类型：计划索引 | 更新：2026-07-01 | owner：LLM Wiki commander / planner

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
| [spec-2-work-runtime.md](./spec-2-work-runtime.md) | Work Runtime、SQLite runtime ledger、job/lease/event/scheduler 底座。 | completed |
| [SPEC-2/pr1-runtime-adr-plan.md](./SPEC-2/pr1-runtime-adr-plan.md) | SPEC-2 PR1 执行计划：runtime ADR、schema families、job state machine、single-writer hard gate。 | merged |
| [SPEC-2/adr-work-runtime.md](./SPEC-2/adr-work-runtime.md) | SPEC-2 PR1 ADR：project-scoped runtime.db、kill switch、portable schema families、job transitions、SPEC-3/4 gates。 | accepted for PR1 gate |
| [SPEC-2/pr2-sqlite-init-plan.md](./SPEC-2/pr2-sqlite-init-plan.md) | SPEC-2 PR2 执行计划：SQLite init、migration bookkeeping、runtime DB health check。 | merged |
| [SPEC-2/pr3-job-ledger-plan.md](./SPEC-2/pr3-job-ledger-plan.md) | SPEC-2 PR3 执行计划：job ledger、lease / heartbeat / retry / cancel。 | merged |
| [SPEC-2/pr4-commit-budget-plan.md](./SPEC-2/pr4-commit-budget-plan.md) | SPEC-2 PR4 执行计划：commit-path concurrency budget、resource claim/release ledger。 | merged |
| [SPEC-2/pr5-event-progress-plan.md](./SPEC-2/pr5-event-progress-plan.md) | SPEC-2 PR5 执行计划：event log、progress API、timeline snapshot。 | merged |
| [SPEC-2/pr6-staging-gc-plan.md](./SPEC-2/pr6-staging-gc-plan.md) | SPEC-2 PR6 执行计划：staging artifact metadata、commit-success cleanup、failed/cancelled TTL GC。 | merged |
| [SPEC-2/pr7-runtime-ui-plan.md](./SPEC-2/pr7-runtime-ui-plan.md) | SPEC-2 PR7 执行计划：minimal runtime UI、job queue status、pause/resume/cancel controls。 | merged |
| [spec-3-markdown-commit-layer.md](./spec-3-markdown-commit-layer.md) | Markdown commit layer、staging artifact、`index.md` / `overview.md` 去核心化。 | completed |
| [SPEC-3/pr1-commit-layer-adr-plan.md](./SPEC-3/pr1-commit-layer-adr-plan.md) | SPEC-3 PR1 执行计划：Markdown commit layer ADR、artifact/result/conflict/event/marker boundary、inert core contract metadata。 | merged |
| [SPEC-3/adr-markdown-commit-layer.md](./SPEC-3/adr-markdown-commit-layer.md) | SPEC-3 PR1 ADR：staged artifact、commit result、base hash matrix、SPEC-2 dependency boundary、derived stale marker ownership。 | frozen for SPEC-3 PR2+ |
| [SPEC-3/pr2-optional-index-overview-plan.md](./SPEC-3/pr2-optional-index-overview-plan.md) | SPEC-3 PR2 执行计划：normal ingest 不再默认读、生成或覆盖 root `wiki/index.md` / `wiki/overview.md`。 | merged |
| [SPEC-3/pr3-commit-operation-plan.md](./SPEC-3/pr3-commit-operation-plan.md) | SPEC-3 PR3 执行计划：shell-neutral Markdown commit operation、base-hash matrix、commit-path budget claim/release。 | merged |
| [SPEC-3/pr4-commit-events-markers-plan.md](./SPEC-3/pr4-commit-events-markers-plan.md) | SPEC-3 PR4 执行计划：commit audit event、derived stale marker schema/API、commit side-effect ordering。 | merged |
| [SPEC-3/pr5-conflict-repair-job-plan.md](./SPEC-3/pr5-conflict-repair-job-plan.md) | SPEC-3 PR5 执行计划：conflict review / repair job 入口、staging artifact conflict failure、repair audit id。 | merged |
| [SPEC-3/pr6-template-okf-wording-plan.md](./SPEC-3/pr6-template-okf-wording-plan.md) | SPEC-3 PR6 执行计划：project template / OKF validator wording 收口，确认 root index/overview optional。 | merged |
| [spec-4-model-profiles.md](./spec-4-model-profiles.md) | 用户选择的 Model/Profile、多供应商 capability probe、Model-call vs Agent-run Profile。 | completed |
| [SPEC-4/pr1-profile-schema-storage-plan.md](./SPEC-4/pr1-profile-schema-storage-plan.md) | SPEC-4 PR1 执行计划：Profile schema、runtime storage、OS secret reference、Core Runtime profile contract。 | merged |
| [SPEC-4/pr2-settings-profiles-plan.md](./SPEC-4/pr2-settings-profiles-plan.md) | SPEC-4 PR2 执行计划：Settings profile create/edit/test、task-family capability、secret write boundary。 | merged |
| [SPEC-4/remaining-prs-implementation-plan.md](./SPEC-4/remaining-prs-implementation-plan.md) | SPEC-4 余下 PR3-PR5 实施路线：Capability Probe、Scheduler Profile Pool、Agent-run Adapter。 | completed |
| [SPEC-4/pr3-capability-probe-plan.md](./SPEC-4/pr3-capability-probe-plan.md) | SPEC-4 PR3 执行计划：stored-profile capability probe、cache/backoff、Settings probe UI。 | merged |
| [SPEC-4/pr4-scheduler-profile-pool-plan.md](./SPEC-4/pr4-scheduler-profile-pool-plan.md) | SPEC-4 PR4 执行计划：profile pool selector、claims、concurrency、retry-after/circuit-break。 | merged |
| [SPEC-4/pr5-agent-run-adapter-plan.md](./SPEC-4/pr5-agent-run-adapter-plan.md) | SPEC-4 PR5 执行计划：Agent-run profile claim、Rust-side secret resolution、per-run sidecar env/config injection。 | merged |
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
- Current Execution Order 是 planning route 入口，不是实时执行状态数据库；若与 git main、GitHub PR 状态或 git log 冲突，以 git/GitHub 为执行真相，并开 docs consistency 修正本索引。
- `docs/plans/**` 已恢复默认可跟踪；新增计划文档正常 `git add docs/plans/<file>.md` 即可。`docs/` 下其他本地文档仍默认忽略。
- GitNexus CLI canonical command 使用连字符；commit 前 staged 检查使用 `npx gitnexus detect-changes --repo llm_wiki --scope staged`，未 stage 工作区检查才使用 `--scope unstaged`。MCP/tool 名称可能使用下划线 `detect_changes`，不要混写。
- 不在旧文档里反复改写历史事实；只修会误导当前执行的交叉引用。
- docs-only roadmap PR 不代表 CI/release 已完成清理；实际 pruning 由 `mac-product-baseline` 实现 PR 处理。

## Current Execution Order

截至 2026-07-01，当前 main/head 基线为 `285214c feat: wire agent runs to runtime profiles (#221)`。Phase 6 的 PR A-K 主线 port 已完成到 #148，follow-up sweep 已完成到 #164，安全/质量 backlog #120/#126 系列已完成到 #170。OKF + Knowledge Wiki business-layer stream 已完成，并已归档；SPEC-0 到 SPEC-9 已由 #192 定稿，SPEC-1 已由 #194-#199 完成，#200 恢复 `docs/plans/**` 默认可跟踪，SPEC-2 已由 #202-#208 完成，SPEC-3 已由 #210-#216 完成 PR1-PR6，SPEC-4 PR1 已由 #217 完成，SPEC-4 PR2 已由 #218 完成，SPEC-4 PR3 已由 #219 完成，SPEC-4 PR4 已由 #220 完成，SPEC-4 PR5 已由 #221 完成。后续不再按旧 OKF/KW 队列或旧 Phase 7 队列执行。

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

Next execution sequence：SPEC-1、SPEC-2、SPEC-3、SPEC-4 已完成。当前下一候选是 SPEC-5 PR1 Parallel Knowledge Pipeline；每个后续 PR 开始时再落对应详细计划，并按合并标准要求无 unresolved P0/P1/P2、修复该 PR 已发现全部 scoped P3、CI green 后由 Commander 合并。SPEC-6 在 SPEC-5 commit/profile/runtime 使用路径稳定后推进。SPEC-7 PR1（SDK alignment）可并行准备；SPEC-7 PR2 rewind 必须等 SDK alignment 完成，SPEC-7 PR4 unified input shell hard-blocked by runtime job ledger 和 commit-layer clarity。SPEC-9 Swift shell re-entry deferred，只有 SPEC-1 到 SPEC-8 的 core boundary 和关键 runtime API 稳定后才进入实现。

当前主线不跳过 SPEC-2 直接进入 Phase 7 / Unified Agentic Chat 完整实现，也不继续按旧 OKF/KW 队列执行；Claude Agent SDK alignment 现在归入 SPEC-7 的前置 PR，可按依赖规则并行准备。

Swift/SwiftUI/iOS/native 实现继续 deferred；但 native-ready shell/core boundary 已进入 SPEC-1，后置 Swift 回填由 SPEC-9 承接。
