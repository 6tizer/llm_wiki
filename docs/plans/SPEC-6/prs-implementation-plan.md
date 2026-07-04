# SPEC-6 PR1-PR6 连续执行总方案（Wave 3 derived 轨）

> 类型：SPEC 级执行计划 | 状态：approved for execution | 覆盖：#189 | 依赖：SPEC-5-FIX（已 closeout #269）| 创建：2026-07-04
>
> 本文档是 Wave 3 derived 轨的执行入口，供 Commander 在 GOAL 模式下一条龙推进。流程权威始终是 `.agent/workflows/`（pr-loop / commander / gates / external-agents / post-merge-cleanup），本文只记录 SPEC-6 特有的顺序、lane、gate 加权和跨轨协调，不复述通用规则。

## Wave 3 轨道布局（轨间并行、轨内串行）

| 轨 | worktree（复用 Wave 2） | SPEC | branchPrefix | 优先级 |
|----|------------------------|------|--------------|--------|
| derived | `../llm_wiki-pipeline` | SPEC-6 | `codex/spec6-` | 1（本文档） |
| agent | `../llm_wiki-security` | SPEC-7 PR1→PR2 | `codex/spec7-` | 2 |
| maint | `../llm_wiki-dataint` | SPEC-11 follow-ups + SPEC-8 PR10 | `codex/maint-` | 3（填缝） |

注册表：`.agent/tracks.json`（已更新为 Wave 3）。轨内严格串行：一个 PR merge → post-merge-cleanup → agent-loop STOPPED → 本轨下一 PR。轨间无 agent-loop 互斥，冲突检测用 GitNexus impact 查文件/模块重叠。

### 跨轨协调点（本 Wave 仅一个实质冲突面）

- **`runtime_db.rs` 窗口**：SPEC-6 PR1 向 `runtime_db.rs` 新增 marker 流转命令；SPEC-8 PR10（mod split）拆同一文件。**PR10 必须等 SPEC-6 PR1 merge 后、在 PR2（TS 侧为主）执行期间的窗口进行**。maint 轨开工 PR10 前先跑 impact 对照 derived 轨当前 PR 触碰面。
- SPEC-7 轨触碰面是 `src-tauri/sidecar/` + `agent_cli`，与 SPEC-6 天然隔离，无需协调。
- 任一轨 merge 后：本轨 worktree 内 `GITNEXUS_MAX_FILE_SIZE=1024 npx gitnexus analyze --name <gitnexusRepo>` + `.agent/scripts/track-sync.sh --exclude <本轨>`。

## 轨内串行顺序：PR1 → PR2 → PR3+4（合并）→ PR5 → PR6

范围基线是 `docs/plans/spec-6-derived-knowledge-rebuild.md`（含 2026-07 review 范围修正，必读）。PR1 是全 SPEC 硬闸门。

### PR1 — Marker 消费基础设施（闸门）

- **范围**：marker 状态流转 API（claim/complete/ack；现状只有 record/list）、marker-claim lease、按 `(layer, affectedPath)` 去重/合并 + debounce/merge window、增量/游标查询（`since marked_at_ms`）、7 层缺口处置、derived job lifecycle（retry/cancel/resume）。docs：本计划入 `docs/plans/README.md` 索引 + PR1 详细计划落 `SPEC-6/pr1-*.md`。
- **lane**：full。**对抗性问题域（并发/lease）→ 设计先行**：实现前派 adversary（`model: opus`，只读）产出场景矩阵（交错时序 × lease 过期/续租 × worker 崩溃 × poison × 重入 × 双 worker 认领同 marker），Coder 按全矩阵一次实现，Reviewer 逐格验证。
- **PR1 内需 Architect 裁定的设计决策**（写入 pr1 详细计划）：
  1. lease 载体：复用 `runtime_jobs`（新 `kind:"derived-rebuild"`，依赖 SPEC-5-FIX 已接线的 lease 回收调度器）vs 自建 marker-claim 带 `expires_at_ms > now` read-time 自愈（照 profile-pool 模式）。**两者都不得复制 commit-budget 反模式**。
  2. 3 个缺失层的处置：`index_export`/`overview` 明确改为按需触发（PR5 显式 job，contract 注明不随 commit 产 marker）；`search` 层是否随 commit 补齐由 Architect 结合消费者设计裁定。
  3. 去重语义：消费端按 `(layer, affectedPath)` 聚合取最新 `input_hash`，还是写入端改 `deterministicMarkerId`（后者动 SPEC-3 契约，默认不选）。
- **主力 gate**：内审 opus + 编译级 probe 复现（并发域）；Codex/外部 Architect 为副（接口一致性）。
- **验收**：dirty marking / dedupe / claim-complete-ack / lease 过期回收 / cursor 查询单测；fake worker 的 retry/cancel/resume。

### PR2 — Embedding rebuild job 化（唯一真正的 ingest 解耦）

- **范围**：`ingest.ts` 步骤 17（embedding 循环）移出主链路，改由 marker 驱动的后台 job；修复其错误被吞（findings P2）；ingest 完成不再等待 embedding。
- **lane**：full（碰 ingest 主链）。runtime verify 必做：真实 ingest 一个文档，观察页面先落盘、embedding 状态异步变化。
- **跨轨**：本 PR 执行期 = maint 轨 PR10（runtime_db split）的安全窗口。
- **验收**：ingest 不等 embedding 即结束；embedding 失败可见、可 retry；characterization（SPEC-11 已有的 ingest 测试）不回归。

### PR3+4（合并）— Taxonomy/synthesis rebuild job 化 + 派生层契约收口 + S5 自愈

> 详细计划：[SPEC-6/pr3-4-taxonomy-synthesis-plan.md](./pr3-4-taxonomy-synthesis-plan.md)。原计划的 PR3（graph/search job 化）与 PR4（taxonomy/synthesis）在实现前的调查阶段合并：graph（wiki-graph.ts 现读现算零持久化）与 search（实时扫描 + vector=embedding 层）均**无物化产物**，无 rebuild 目标可消费——继续把它们当独立 PR 只会产生「job 化了一个不存在的东西」。taxonomy（`.llm-wiki/tag-taxonomy.json`）是唯一真实 rebuild 对象，synthesis（直写 wiki 页面）第二，两者合并为一个 PR 一次性收口。

- **范围**：`COMMIT_DERIVED_STALE_MARKER_LAYERS` 摘除 `"graph"`（无消费者的 marker 只会永久堆积 pending 行）；新增 `taxonomy-consumer.ts`（照 PR2 embedding-consumer 模式，聚合多 `affectedPath` 组为一次 `applyTagTaxonomyGrowth` 调用）；新增 `synthesis-staleness.ts`（纯查询 + 手动重跑闭环，synthesis 本身不建自动 job）；**顺带消化 SPEC-11 遗留 S5**（跨文件 reference sweep 非事务崩溃留死链 → 核实 `lint.ts` 既有 `broken-link` 检查已覆盖自愈路径，补 characterization，不新增检查代码）。synthesis 整页覆盖保护 SPEC-11 已修，本 PR 不重复。
- **lane**：full。
- **结果**：merged。PR6 承接的 deferred wiring：synthesis stale 徽标 UI、诊断面过滤 no-artifact 层（历史 pending `"graph"` marker）。

**SPEC-6 收口清单追加项**（Simplicity review P2，2026-07；裁定不在本 PR 做）：提取 `createDerivedRebuildConsumer(config)` 共享骨架——`embedding-consumer.ts` 与 `taxonomy-consumer.ts` 247 行逐字重复（世代计数、per-generation tick guard、忙退避、双信号轮询、心跳、safeComplete/safeFail marker 收敛全套），并发关键代码的双副本维护风险。独立 PR，以两套既有测试（`embedding-consumer.test.ts` + `taxonomy-consumer.test.ts`）作为 characterization 基线。裁定理由：本 PR 内重构已上线的 embedding-consumer 会扩大爆炸半径，独立小 PR 更安全。

### PR5 — Optional index export / overview synthesis 显式 job

- **范围**：`index_export`/`overview` 两层按需触发的显式 job（不是 ingest 副作用）；清理 `autoIngestImpl` 遗留的 index/overview 空字符串死参数（原归 SPEC-11/SPEC-8，此处顺带）。
- **lane**：可评估 fast（若改动面收敛），拿不准走 full。

### PR6 — UI 状态（SPEC 收口 PR）

- **范围**：dirty/building/stale/ready/failed 状态展示 + 手动 rebuild 入口 + fallback keyword/file search 状态说明。复用 SPEC-5 PR6 `RuntimeDiagnosticsSection<T>` + section 级降级；轮询抽通用 `usePolling<T>`（顺带修「外部触发不重置定时器」）；per-layer store 照 `research-store.ts` 任务模式新建，复用 SPEC-11 乐观写 helper，不塞 `wiki-store.ts`。
- **lane**：full（UI 状态机）；Simplicity 用 ZCode read-only reviewer。
- **SPEC Closeout Gate**（`gates.md`）：端到端 integration fixture 跑通「commit → marker → 后台 rebuild → UI 状态流转 → 手动 rebuild」；deferred wiring 清零或显式移交；安排 SPEC-6 子系统多代理深度 review，发现分流 FIX/P3 backlog；`docs/plans/README.md` 状态行更新 + `.agent-loop/HANDOFF.md` 重写。

## SPEC-6 收口（PR6 Closeout Gate 交付物 b）

> PR6 实现完成，active / in review（分支 `codex/spec6-pr6-derived-status`，详细计划 [`pr6-derived-status-ui-plan.md`](./pr6-derived-status-ui-plan.md)，合并后回填 completed + PR 编号）：per-layer 派生状态 UI（`derived-status-section.tsx`，5 态 + stale 展示变体，`graph`/`search` 隐藏）+ `usePolling<T>`（修「外部触发不重置定时器」）+ `manual-rebuild-marker.ts`（`ingest-write.ts`/`manual-rebuild.ts`/新按钮三处调用点共享去重）+ embedding/taxonomy 手动 Rebuild 按钮 + 搜索 fallback 提示条（`search.ts` 透传 mode/vectorHits）+ 端到端 fixture（`derived-status.e2e.test.ts`：commit→pending→自动 consumer→done 与 手动按钮 mint-to-close 两条路径）。
>
> 本节是 PR1-PR6 全过程中每个计划文档、file doc comment 里散落记录的 deferred/follow-up/gap 条目的一次性盘点收口（未找到独立成文的「PR6 前置调查报告」——`.agent/` 与 `docs/plans/SPEC-6/*.md` 均未见此文件；本表由逐份计划文档 + 相关源码文件头注释重新审计得出，共 18 个去重后的独立条目，逐项标注处置）。

| # | 来源 | 条目 | 处置 |
|---|------|------|------|
| 1 | pr1 计划 `:26-27` | Marker 消费循环「宿主」（真正的后台 worker loop）PR1 未交付，只给了 claim/complete/release API | **已接线**（PR2 的 `embedding-consumer.ts`、PR3+4 的 `taxonomy-consumer.ts` 就是这个宿主，PR6 之前已闭环） |
| 2 | pr1 计划 `:26` | `search` 层 marker 生产延后到「PR3 若落消费者」 | **已闭环**：PR3+4 调查证实 `search` 无物化产物，永不会有消费者；PR6 决策 2 将 `search`（连同 `graph`）整层从 UI 隐藏（`VISIBLE_DERIVED_LAYERS` 过滤），不再生产/展示 |
| 3 | pr1 计划 `:26` | `index_export`/`overview` 延后到 PR5 按需触发 | **已接线**（PR5 落地；PR6 在 `derived-status-section.tsx` 加「前往对应 section」指引，不重复按钮） |
| 4 | pr1 计划 `:28`（设计决策 9） | `runtime_db.rs` mod split | **已完成**（#281 已合并——SPEC-8 PR10，maint 轨独立任务，非 PR6 范围但确认落地） |
| 5 | pr1 对抗矩阵 `:59` R2/R3/R4 等 | SPEC-11 `withProjectLock` 不覆盖 marker 消费期间的项目删除竞态；矩阵未列的 R2/R3/L2/L3 场景 | **显式移交**：issue #286（未在 PR1-PR6 任何一个 PR 中处理，遗留为后续并发加固候选） |
| 6 | pr2 计划 `:16,43` | `ingest.ts` 用非原子 `writeFile`（应为 `writeFileAtomic`） | **显式移交**：SPEC-8/11 域，PR6 未动；无独立 issue，SPEC-8/11 开工时再立 |
| 7 | pr2 计划 `:19,44` | `runtimeJobList` 无 kind/state 过滤参数，PR2 靠客户端过滤 workaround | **显式移交**：性能优化候选，PR6 未做（`status.ts` 的 `fetchAllDerivedStaleMarkers` 同样是全量拉取 + 客户端分桶，同一取舍，见计划决策 3） |
| 8 | pr2 计划 `:45` | `recordEmbeddingStaleMarker` 锚点 job 在 claim/event-append/complete 中途失败会留一行永久 `queued` 孤儿 | **显式移交**：issue #287（孤儿 marker/anchor 回收统一承接，见下方三条同类条目） |
| 9 | pr2 计划 `:46` | `embedding-consumer.ts`'s `safeFailClaim`：`runtimeJobFail` 与 `runtimeDerivedMarkerReleaseBatch` 非原子，中间崩溃会让 marker 永久卡 `claimed` | **显式移交**：issue #287（诊断层面，PR6 的状态 UI 会把这种 marker 展示为 `building` 卡死，但不会自动修复——需要一个「收敛终态 job 的孤儿 marker」扫描任务） |
| 10 | pr3-4 计划 `:10,46` | 历史遗留的 `"graph"` pending marker（摘除前产生的）未清理/迁移，标注「PR6 诊断层过滤」 | **已闭环**：与 #2 同一处置——PR6 把 `graph` 整层从 `VISIBLE_DERIVED_LAYERS` 过滤，历史堆积的 pending marker 自然不再展示 |
| 11 | pr3-4 计划 `:12`；prs-implementation-plan `:51` | Synthesis stale 徽标 UI 标注「归 PR6」 | **已闭环**：`derived-status-section.tsx` 对 synthesis 展示 stale 文案变体（dirty 且无自动 consumer） |
| 12 | pr3-4 计划 `:14,45` | Synthesis 直写 wiki 页面，绕过 commit/staging 审计链路 | **显式移交**：架构级改动，候选 SPEC-7/8 或独立 PR，PR6 不做；无独立 issue，SPEC-7/8 开工时再立 |
| 13 | pr3-4 计划 `:47` | 若未来需要「重启后 graph 视图 stale 提示」，可能重新引入 graph marker；当前判定内存 `dataVersion` 机制已够用 | **显式移交**：未规划，非 PR6 范围 |
| 14 | pr3-4 计划 `:48`；prs-implementation-plan `:53`（Simplicity P2） | 提取共享 `createDerivedRebuildConsumer(config)`——`embedding-consumer.ts`/`taxonomy-consumer.ts` 约 247 行逐字重复（世代计数/tick guard/双信号轮询/心跳/safeComplete-safeFail） | **显式移交**：独立 PR，以两份既有测试为 characterization 基线；PR6 未做（PR6 新增的 `manual-rebuild-marker.ts` 去重的是「锚点 job 铸造」这一块，是另一处重复面，不是这个 consumer tick-loop 骨架） |
| 15 | pr5 计划 `:19`（决策 6） | `ingest.ts` 里只读的 `index.md` 上下文注入 LLM prompt 未清理（并非死代码，删除会改变 prompt 行为） | **显式移交**：独立 SPEC-8 评估，PR6 未动 |
| 16 | pr5 计划 `:44` | 建议 PR6 若要展示「上次重建时间」，直接读 marker `done` 行的 `updated_at_ms`，无需新存储 | **已闭环**：`DerivedLayerBucket.lastRebuiltAtMs` 正是从 marker 的 done 行 `updatedAtMs` 取最大值算出（`status.ts`） |
| 17 | pr5 计划 `:45` | Overview 重建是盲覆盖，无 diff 预览/确认弹窗；建议留给「PR6+」 | **显式移交**：PR6 仍是「Rebuild」按钮直接触发，未加确认弹窗/diff 预览——原文本就标注给「PR6+」，继续移交到该按钮的下一次改进 |
| 18 | spec-6-derived-knowledge-rebuild.md `:77-81` | SPEC 级非目标：不做「所有高级 rebuild 调度策略」 | **显式移交**：开放性 SPEC 级非目标，无具体 PR 承接 |
| — | spec-5-8-post-review-findings.md `:108` | `runtime-jobs-section.tsx` 自适应轮询无法被外部触发重置定时器 | **已闭环**：`usePolling<T>` 的 `refreshNow` 正是修这个 bug，回归锁测试 + sabotage 自验证见 `use-polling.test.tsx`/`runtime-jobs-section.test.tsx` |
| — | manual-rebuild.ts 文件头注释「Residual gaps」 | (a) mint 锚点 job 与其 complete 之间崩溃留孤儿 `running` 锚点 job；(b) claim_batch 成功后到 execute/complete-or-fail 完成前崩溃，折叠 job 卡 `queued`/`retry-wait`，markers 卡 `claimed`，`index_export`/`overview` 无消费者可自愈——两处均标注「PR6 诊断候选」 | **显式移交**：issue #287（与 #8/#9 同一批孤儿 marker/anchor 回收；PR6 交付了「状态可见」——会展示成挂起的 building/dirty——但没有交付「自动诊断/reconcile 孤儿 job」的专门动作） |
| — | synthesis-staleness.ts 文件头注释（同类风险） | claim_batch 成功、complete_batch 之前崩溃，synthesis marker 卡 `claimed`，无 poller 收敛 | **显式移交**：issue #287（同上，统一批次回收；PR6 未建专门 reconcile 动作） |
| — | runtime-diagnostics.ts `REPAIR_JOB_KINDS` 注释 | 三个 bulk-knowledge repair job kind 是「设计上的结构性孤儿」，无消费者 | **不在 SPEC-6 范围**：SPEC-5-FIX 遗留项，诊断层已可见（`RuntimeDiagnosticsSection`），非 SPEC-6/PR6 承接对象，仅收录以确认未被误判为 SPEC-6 遗留 |

小结：18 个去重条目中，**7 个由 PR6 本次闭环或已确认完成**（#2/#3 部分、#4 已合并 #281、#10、#11、#16、`usePolling` bug），**2 个有明确 issue 号追踪**（#5 → issue #286；#8/#9/两条同类残余 gap → issue #287 统一承接），其余为**显式域移交**（部分明确「无独立 issue，SPEC-7/8/11 开工时再立」），无「静默消失」的遗留项。

## 每 PR 固定循环（权威见 pr-loop.md，此处仅列 SPEC-6 执行时的检查单）

1. **Start**：derived 轨 worktree 内 `agent-loop-preflight.sh` → bind（issue #189）→ `gitnexus status`（stale 则 analyze，必带 `GITNEXUS_MAX_FILE_SIZE=1024`）→ 切 `codex/spec6-<slug>` 分支。
2. **Plan**：落/更新 `SPEC-6/prN-*.md` 详细计划；改 symbol 前跑 impact，HIGH/CRITICAL 显式警示。
3. **实现**：派 Coder（显式 `model: opus`（并发/Rust DB）或 `sonnet`（一般），**禁 Fable**）；限流按 fallback 链：SendMessage 续接 → 退避 3 分钟 → Codex CLI rescue。
4. **Gate**：focused tests → Simplicity → Tester → Reviewer（按 gates.md 问题域加权）；P0/P1/P2 同 PR 修并重跑。
5. **提交前**：`npm run typecheck`（tsc --build）、`/usr/bin/git diff --check`（精确 diff 绕过 rtk）、`npx gitnexus detect-changes -r llm_wiki-pipeline --scope staged`、`orphan-check.sh main`（Wiring Gate：新导出符号必须有生产调用点，deferred wiring 显式记录）。
6. **Merge**：PR body 用 `.agent/templates/pr-body.md`；CI green + 无 unresolved P0/P1/P2 + scoped P3 全清 → merge → `post-merge-cleanup.md`（analyze --name llm_wiki-pipeline、track-sync --exclude derived、HANDOFF 三行刷新、agent-loop STOPPED）。

## 并行轨排程（GOAL 模式下 Commander 的填缝规则）

- derived 轨等外部 gate/CI 时，可推进 agent/maint 轨的当前 PR；不并发写同一文件区域。
- **maint 轨顺序**：SPEC-11 PR7b（title="" 快照设计先行）→ S8（project-id 护栏，fast lane 候选）→ **PR10（等 SPEC-6 PR1 merge 窗口）** → S10（**产品已裁定选 A**：`cleanupDeletedWikiPages` 补 `isSourcePage` 门禁，与 `cascadeDeleteWikiPage` 对齐，更新 characterization 21h；fast lane 候选）。
- **agent 轨顺序**：SPEC-7 PR1（SDK changelog 逐版核对 + 官方 rewind API 确认，产出决定 PR2 设计）→ PR2 rewind。PR4+ 本 Wave 不进（等 SPEC-6 marker/job 语义稳定）。
- 用户不在场时遇到需产品裁定的分歧：记录到 PR body 并按最保守选项继续，或标记 BLOCKED 转下一轨任务，不空转。
