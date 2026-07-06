# Plans Index

> 类型：计划索引 | 更新：2026-07-04 | owner：LLM Wiki commander / planner

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
| [spec-4-fix-model-profiles-closeout.md](./spec-4-fix-model-profiles-closeout.md) | SPEC-4 完成后 Profile lifecycle、Settings/Profile IA、Agent-run profile compatibility 收口。 | completed |
| [SPEC-4-FIX/remaining-prs-implementation-plan.md](./SPEC-4-FIX/remaining-prs-implementation-plan.md) | SPEC-4-FIX PR1-PR3 连续执行计划：Profile lifecycle、Settings/Profile IA、Agent-run compatibility。 | completed |
| [SPEC-4-FIX/pr1-profile-lifecycle-plan.md](./SPEC-4-FIX/pr1-profile-lifecycle-plan.md) | SPEC-4-FIX PR1 执行计划：runtime profile soft delete、active claim block、visible profile filtering、UI 删除入口。 | merged |
| [SPEC-4-FIX/pr2-settings-profile-ia-plan.md](./SPEC-4-FIX/pr2-settings-profile-ia-plan.md) | SPEC-4-FIX PR2 执行计划：Model Profiles 同级 Settings 入口、LLM 模型 legacy/default 文案、本地扩展归属。 | merged |
| [SPEC-4-FIX/pr3-agent-run-profile-compatibility-plan.md](./SPEC-4-FIX/pr3-agent-run-profile-compatibility-plan.md) | SPEC-4-FIX PR3 执行计划：Agent-run profile SDK model alias、auth env 映射、SDK compatibility diagnostic。 | merged |
| [spec-1-4-post-test-findings.md](./spec-1-4-post-test-findings.md) | SPEC-1 到 SPEC-4 完成后 Dev App 手测问题证据；已被 SPEC-4-FIX 和 SPEC-5/6/7/8 回灌消费。 | evidence / consumed |
| [spec-5-parallel-knowledge-pipeline.md](./spec-5-parallel-knowledge-pipeline.md) | #191 批量 prepare / commit / repair 的并行知识编译管线。 | completed |
| [SPEC-5/remaining-prs-implementation-plan.md](./SPEC-5/remaining-prs-implementation-plan.md) | SPEC-5 六个 PR 连续执行总方案：PR1-PR6 顺序、gate、合并标准、PR6 closeout。 | completed |
| [SPEC-5/pr1-batch-planner-plan.md](./SPEC-5/pr1-batch-planner-plan.md) | SPEC-5 PR1 执行计划：Batch planner、batched prepare plan、runtime diagnostics wrapper/snapshot。 | merged |
| [SPEC-5/pr2-prepare-worker-pool-plan.md](./SPEC-5/pr2-prepare-worker-pool-plan.md) | SPEC-5 PR2 执行计划：Prepare worker pool、scoped job claim、model-call profile routing。 | merged |
| [SPEC-5/pr3-staging-validator-plan.md](./SPEC-5/pr3-staging-validator-plan.md) | SPEC-5 PR3 执行计划：Staging artifact parser、validator、runtime staging store。 | merged |
| [SPEC-5/pr4-commit-integration-plan.md](./SPEC-5/pr4-commit-integration-plan.md) | SPEC-5 PR4 执行计划：Commit operation integration、runtime staging body reader、repair route、derived stale marker。 | merged |
| [SPEC-5/pr5-long-document-map-reduce-plan.md](./SPEC-5/pr5-long-document-map-reduce-plan.md) | SPEC-5 PR5 执行计划：Long-document map-reduce analysis、partial draft、chunk repair route。 | merged |
| [SPEC-5/pr6-progress-ui-plan.md](./SPEC-5/pr6-progress-ui-plan.md) | SPEC-5 PR6 执行计划：Progress / ETA / pause / resume / cancel UI、Runtime Diagnostics closeout。 | merged |
| [spec-5-8-post-review-findings.md](./spec-5-8-post-review-findings.md) | 2026-07 全仓深度 review 证据（14 个 P0 + P1/P2 + 精简清单）；已分流到 SPEC-5-FIX/10/11 并回灌 SPEC-6/7/8。 | evidence / consumed |
| [spec-5-fix-pipeline-wiring.md](./spec-5-fix-pipeline-wiring.md) | SPEC-5 并行流水线生产接线 + worker heartbeat / lease 回收 / commit-budget 自愈 / repair 消费者。 | completed |
| [spec-10-security-hardening.md](./spec-10-security-hardening.md) | 安全加固：沙箱逃逸、clip server 鉴权、stdout 密钥泄露、权限绕过、子进程清理、能力面收敛。 | completed |
| [spec-11-data-integrity.md](./spec-11-data-integrity.md) | 数据完整性：切项目清历史、编辑器串写、分块死循环、ingest/lint/dedup 误删覆盖、settings 静默保存。 | completed |
| [spec-6-derived-knowledge-rebuild.md](./spec-6-derived-knowledge-rebuild.md) | embedding、graph、taxonomy、synthesis、optional index/overview 的异步派生重建；2026-07 review 已范围修正，依赖 SPEC-5-FIX。 | completed（PR1-PR6 merged #280/#283/#284/#285/#288 + closeout hotfix in review） |
| [SPEC-6/prs-implementation-plan.md](./SPEC-6/prs-implementation-plan.md) | Wave 3 derived 轨执行总方案：PR1-PR6 顺序、lane/gate 加权、三轨并行协调（runtime_db 窗口）。 | active |
| [SPEC-6/pr1-marker-consumption-infrastructure-plan.md](./SPEC-6/pr1-marker-consumption-infrastructure-plan.md) | SPEC-6 PR1 执行计划：marker 状态流转/claim 折叠/游标/毒 marker 收敛（含 P0 修订与 PR2+ 消费者契约）。 | merged |
| [SPEC-6/pr1-adversarial-matrix.md](./SPEC-6/pr1-adversarial-matrix.md) | SPEC-6 PR1 并发场景矩阵（design-first gate 凭据），Reviewer 逐格验证记录的依据。 | evidence |
| [SPEC-6/pr2-embedding-rebuild-plan.md](./SPEC-6/pr2-embedding-rebuild-plan.md) | SPEC-6 PR2 执行计划：embedding 移出 ingest 链、marker 驱动消费循环、方案 A 传统路径接线（含 work-runtime 禁用回退与 P0 教训）。 | merged |
| [SPEC-6/pr3-4-taxonomy-synthesis-plan.md](./SPEC-6/pr3-4-taxonomy-synthesis-plan.md) | SPEC-6 PR3+4（合并）执行计划：原 PR3（graph/search job 化）证实两者均无物化产物而并入 taxonomy consumer + COMMIT 层摘除 graph；taxonomy growth 聚合消费循环、synthesis 手动重跑闭环、SPEC-11 S5 死链自愈核实。 | merged |
| [SPEC-6/pr5-index-overview-plan.md](./SPEC-6/pr5-index-overview-plan.md) | SPEC-6 PR5 执行计划：index_export/overview 手动重建 job 化——自产自销 marker 闭环共享 helper、index 扫描+格式化纯函数、overview LLM 单页生成、独立 settings section。 | merged |
| [SPEC-6/pr6-derived-status-ui-plan.md](./SPEC-6/pr6-derived-status-ui-plan.md) | SPEC-6 PR6 执行计划（收口 PR）：per-layer 派生状态 UI（5 态 + stale 展示变体，graph/search 隐藏）、`usePolling` 抽取修 timer 重置 bug、`manual-rebuild-marker.ts` 共享去重 helper（三处调用点零复制）、embedding/taxonomy 手动 rebuild 按钮、搜索 fallback 提示条、端到端 fixture。 | merged（#288） |
| [SPEC-6/closeout-hotfix-plan.md](./SPEC-6/closeout-hotfix-plan.md) | SPEC-6 收口后（PR6 合并后）多代理深度 review 的 P0/P1 分流修复：per-path marker 状态归约、搜索 fallback banner 拆分、cancel 孤儿 marker 释放、dedup-queue 忙退避补齐、runtime-disabled 默认态 UI。 | active / in review |
| [spec-7-unified-agentic-chat.md](./spec-7-unified-agentic-chat.md) | Unified Agentic Chat、Claude Agent SDK productization、session/permission/timeline。 | completed（2026-07-05 closeout） |
| [SPEC-7/pr2-rewind-plan.md](./SPEC-7/pr2-rewind-plan.md) | SPEC-7 PR2 执行计划（design r3）：resume-only-for-rewind 桥、JSONL 锚点验证、wiki 写工具 fail-closed 门禁、延迟 fork 复用。 | merged（#291） |
| [SPEC-7/pr2-rewind-investigation.md](./SPEC-7/pr2-rewind-investigation.md) | SPEC-7 PR2 前置调查 + E1/E2 实证（E1 跨进程 checkpoint PASS；E2 wiki 工具假成功 FAIL）。 | merged（#291） |
| [SPEC-7/pr2-adversarial-matrix.md](./SPEC-7/pr2-adversarial-matrix.md) | SPEC-7 PR2 对抗矩阵（19 场景 + 裁定记录）。 | merged（#291） |
| [spec-12-ui-ia-consolidation.md](./spec-12-ui-ia-consolidation.md) | UI 信息架构收敛：Work Runtime 生产转正、设置三组重组、模型配置合并页 + legacy 退役、Wiki 健康中心、主导航 8→5。 | completed（2026-07-05 closeout） |
| [spec-13-model-access-redesign.md](./spec-13-model-access-redesign.md) | 模型接入一站式重设计：供应商模板库 + 三步向导，复用 SPEC-4 已交付的 probe/pool 基座做 UX 一站式；含 #310 调用点全迁移与 legacy 退役、#312；借鉴 CC Switch/LiteLLM。 | draft / 待用户确认交互稿 |
| [spec-14-ui-ia-round2.md](./spec-14-ui-ia-round2.md) | UI IA 二轮：知识库/文件面板右移可折叠、深度研究归并探索（已裁决）、Wiki 健康中心 Dashboard 化、Agent 设置最终形态。 | charter draft / SPEC-13 之后 |
| [SPEC-12/ui-audit-2026-07.md](./SPEC-12/ui-audit-2026-07.md) | 2026-07-04 生产 app 全页 UI 走查证据：三病根、问题清单 A/B/C、Notion AI 对照 N1-N8、用户裁定 D1-D5。SPEC-12 与 SPEC-7 修订的共同依据。 | evidence |
| [spec-8-maintainability-tooling.md](./spec-8-maintainability-tooling.md) | 维护性重构、GitNexus warning、QA fixture 和测试债收纳。 | in progress（PR10 先行） |
| [SPEC-8/pr10-runtime-db-mod-split-plan.md](./SPEC-8/pr10-runtime-db-mod-split-plan.md) | SPEC-8 PR10 执行计划：runtime_db.rs 保行为拆分为 runtime_db/ 15 模块（行号测绘、可见性纪律、characterization 验证）。 | merged |
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

历史 baseline 证据以 git history 为准。SPEC-4 implementation baseline 是 `285214c feat: wire agent runs to runtime profiles (#221)`；更早的 Phase 6、OKF/KW、安全/质量 backlog 已归档，不再在本节逐条维护。

| SPEC | 状态 | closeout PR |
|------|------|-------------|
| SPEC-0 | reviewed / ready for PR split | #192 |
| SPEC-1 | completed | #194-#199 |
| SPEC-2 | completed | #202-#208 |
| SPEC-3 | completed via PR1-PR6 | #210-#216 |
| SPEC-4 | completed（PR1-PR5 merged；收口见 SPEC-4-FIX） | #217-#221 |
| SPEC-4-FIX | completed via #228, #230, #232 | #228/#230/#232 |
| SPEC-5 | completed by #236/#238/#240/#242/#244/#246 | #236/#238/#240/#242/#244/#246 |
| SPEC-5-FIX | completed via #258/#259/#260/#264/#267/#269 | #258/#259/#260/#264/#267/#269 |
| SPEC-6 | completed（closeout hotfix merged #290） | #280/#283/#284/#285/#288/#290 |
| SPEC-7 | completed（2026-07-05 closeout；含 #292 阶段一） | #277/#291/#296/#298/#300/#301/#303/#304/#306/#307 + closeout hotfix |
| SPEC-8 | completed（2026-07-06 closeout：两维度深度 review 零 P0/P1 + 行为无变化抽查，报告见 SPEC-8/closeout-report.md；deferred/P3 长尾随 #183） | #343/#346/#349/#356/#358/#360/#364/#365/#366/#367/#368 |
| SPEC-9 | deferred / gated | deferred |
| SPEC-10 | completed via #250/#252/#254/#261/#265/#266/#271 | #250/#252/#254/#261/#265/#266/#271 |
| SPEC-11 | completed via #262/#263/#256/#270/#274/#268/#275/#272/#273 | #262/#263/#256/#270/#274/#268/#275/#272/#273 |
| SPEC-12 | completed（2026-07-05 closeout） | #295/#297/#299/#302/#305/#308 |
| SPEC-13 | completed（2026-07-06 closeout：A1=M 五项重跑全绿 + 三维度深度 review + hotfix，报告见 SPEC-13/closeout-report.md） | #324/#325/#326/#327/#328/#331-#336/#341/#345/#348 |
| SPEC-14 | completed（2026-07-06 closeout：A2 生产构建 IA 走查九项+两维度深度 review+hotfix，报告见 SPEC-14/closeout-report.md） | #344/#347/#355/#357/#361 |

2026-07-02 全仓深度 review 的证据见 `spec-5-8-post-review-findings.md`。它新增并完成了 SPEC-5-FIX、SPEC-10、SPEC-11，也回灌修正了 SPEC-6/7/8；旧 OKF/KW 队列和旧 Phase 7 队列不再作为当前执行入口。

当前优先级（2026-07-05 更新，基于用户实测反馈）：

0. **1.0 门槛已达成（2026-07-06）**：SPEC-13/14/8 全部 completed，F 终验三项（M 冒烟/IA 走查/SPEC-8 行为无变化抽查）真机通过——报告见 [release-1.0-final-acceptance.md](./release-1.0-final-acceptance.md)。后续入口=follow-up backlog：#309、#286/#287/#289、#311/#313/#314、#337/#340、#350-#353、#359/#362、#183 P3 长尾；SPEC-9 维持 deferred。

历史优先级记录：

1. SPEC-6：**收口完成**。PR1-PR6 全部 merged（#280/#283/#284/#285/#288）。PR6 merge 后按计划执行的 SPEC-6 全子系统多代理深度 review 已分流：本轮 closeout hotfix（`SPEC-6/closeout-hotfix-plan.md`）修复其中的 P0/P1（per-path marker 状态归约、搜索 fallback banner 拆分、cancel 孤儿 marker 释放、dedup-queue 忙退避、runtime-disabled 默认态 UI）；其余发现开新 issue 追踪——#286（marker 消费未被 `withProjectLock` 覆盖，可与项目/源删除竞态）、#287（孤儿 claimed marker / anchor job 崩溃窗口 reconcile + 诊断，扩展自 PR6 收口表 #8/#9）、#289（dedup 合并写入未接入 derived-rebuild marker 系统，向量索引在每次合并后漂移）；详见 `SPEC-6/prs-implementation-plan.md`「closeout 深度 review 结论」节。
2. SPEC-8 剩余：维护性精简穿插，`runtime_db` mod split PR10 按原计划推进（SPEC-6 PR1 merge 窗口已过，可正常推进）。
3. SPEC-7 / SPEC-9 门控：SPEC-7 PR1 SDK alignment 可并行准备，但不得替代 SPEC-4-FIX PR3 的 Agent-run profile 最小兼容基座；SPEC-7 PR2 rewind 必须等 SDK alignment 完成，SPEC-7 PR4 unified input shell hard-blocked by runtime job ledger 和 commit-layer clarity。
4. Swift/native：Swift/SwiftUI/iOS/native 实现继续 deferred；SPEC-9 只有在 SPEC-1 到 SPEC-8（含 SPEC-5-FIX/10/11）的 core boundary 和关键 runtime API 稳定后才进入实现。

每个后续 PR 开始时再落对应详细计划，并按合并标准要求无 unresolved P0/P1/P2、修复该 PR 已发现全部 scoped P3、CI green 后由 Commander 合并。当前主线不跳过 SPEC-2 直接进入 Phase 7 / Unified Agentic Chat 完整实现，也不继续按旧 OKF/KW 队列执行；Claude Agent SDK alignment 现在归入 SPEC-7 的前置 PR，可按依赖规则并行准备。
