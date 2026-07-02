# SPEC-6: Derived Knowledge Rebuild / 派生知识异步化

> 类型：阶段 SPEC | 状态：reviewed / rescoped by 2026-07 review / ready for PR split | 覆盖：#189 | 依赖：SPEC-1、SPEC-2、SPEC-3、**SPEC-5-FIX（硬前提）** | 执行顺序：SPEC-5-FIX 让 commit 真实产生 derived stale marker 后推进

## 2026-07 Review 范围修正（必读）

深度 review（见 `spec-5-8-post-review-findings.md`）确认本 SPEC 的实际改动面与原计划有实质出入，实现前必须据此重排 PR：

- **graph / taxonomy / synthesis 本就不在 ingest 主链路里**：`runWikiSynthesis`、lint 等都是独立的、只读扫描已有 wiki 的事后任务，从未被 `autoIngestImpl` 调用。它们已经天然可异步调度，SPEC-6 对它们无需"解耦"，只需加 job 调度 + marker 消费。
- **root `index.md`/`overview.md` 生成 SPEC-3 已拿掉**：`autoIngestImpl` 内已无聚合根页面写入路径，只遗留 `index`/`overview` 空字符串死参数（清理归 SPEC-11/SPEC-8）。
- **真正需从 ingest 链移出的只剩 embedding 一步**（`ingest.ts` 步骤 17，已是独立循环，错误被吞——见 findings P2）。
- **前提未就绪**：commit integration 在生产中从未接线（SPEC-5-FIX 修复前），因此**当前没有任何 derived stale marker 被真实产生**，SPEC-6 不能对着空数据构建；必须等 SPEC-5-FIX 让 commit 端到端跑通。
- **marker 消费端严重不全**，实现前需先补基础设施（详见下方"关键设计决策"新增项）。

因此本 SPEC 的重心从"把派生层从 ingest 解耦"转为"**补齐 marker 消费基础设施 + 让已独立的派生任务 job 化并消费 marker**"。

## 目标与成功标准

把 embedding、graph、taxonomy、synthesis、review/lint、optional index/overview 从 ingest 主链路拆出，变成可重建后台任务。

成功标准：

- commit layer 只写 derived stale marker，不同步阻塞 derived rebuild。
- derived job 可 retry、cancel、resume。
- 每个 derived output 记录 input hash/version，可检测 stale。
- UI 可先显示 committed Markdown，再显示派生层同步状态。
- 用户可手动 rebuild 指定 derived layer。
- search/graph/derived layer 尚未 ready 时，UI 必须明确显示 stale/building 状态；搜索可 fallback 到 committed Markdown keyword/file search，不能假装 vector/graph 已完整。
- derived state 通过 Core Runtime status API 暴露，供当前 Tauri/React shell 和未来 Swift shell 复用。
- UI 必须有明确入口展示 `dirty`、`building`、`stale`、`ready`、`failed`，可放在 Runtime Diagnostics、搜索/图谱状态面板或对应 derived layer 设置页，但不能只依赖命令行验证。

## 关键设计决策

- Derived knowledge = materialized/rebuildable output。
- `index.md` export 和 `overview.md` synthesis 是显式 job，不是 ingest 副作用。
- taxonomy sidecar 是治理层，不改写页面 frontmatter 作为唯一事实。
- embedding/vector index 仍是可替换 derived index，不是 source of record。
- Derived stale marker schema 由 SPEC-3 定义、SPEC-2 存储；本 SPEC 负责消费 marker 并调度 rebuild。
- marker consumption 必须有 debounce / merge window：同一 path/layer 的连续 commit 合并成最新输入版本，避免 rebuild 风暴。
- derived rebuild priority 低于 foreground prepare/commit；后台任务不能抢占用户正在触发的 ingest/repair/Agent run。

### 2026-07 Review 补充的消费端就绪度要求

marker schema（`runtime_derived_stale_markers`）本身对 SPEC-6 大体友好（`status` CHECK 已含 `pending|claimed|done|failed|cancelled`，forward-compatible；`marker_id` 确定性；delete intent 用 `reason:"delete"` + `input_hash:null` 与 commit 区分），但一个可用的消费者还缺以下，须在派生层 job 化之前先补：

- **完全没有状态流转 API**：当前只有 `runtime_derived_stale_marker_record`（插入）和 `_list`（查询），**没有 claim/complete/ack 命令**。SPEC-6 无法标记"这条 marker 已处理"，须先补一个流转 PR。
- **没有 claim/lease 原语**：不像 job（`runtime_job_leases`）/ profile（`runtime_profile_claims`），marker 表无 holder/lease/expires。多 rebuild worker 安全认领需新增 lease（可照 job 模式），但**不得复制 job/lease 的崩溃回收缺陷**——SPEC-5-FIX 修好前 job lease 无 live 回收；SPEC-6 若复用 `runtime_jobs`（新 `kind:"derived-rebuild"`）则继承该缺陷，须确保 SPEC-5-FIX 的 lease 回收调度器已接线，或自建带 `expires_at_ms > now` read-time 自愈的 marker-claim（照 profile-pool 模式，避开 commit-budget 反模式）。
- **marker 写入不去重**：`deterministicMarkerId` 按 `(artifactId, layer, affectedPath)`，而 `artifactId` 每次提交都是新的，同页反复提交产生永不合并的 pending 行。消费者须自行按 `(layer, affectedPath)` 去重/聚合，否则重复触发重建。
- **默认只接了 7 层中的 4 层**：contract `DERIVED_STALE_MARKER_LAYERS` 声明 7 层（embedding/graph/taxonomy/synthesis/search/index_export/overview），但 `COMMIT_DERIVED_STALE_MARKER_LAYERS`（`commit-integration.ts:49-54`）只接了前 4 层，`search`/`index_export`/`overview` 永远为空。SPEC-6 若预期这三层随提交自动产生 marker，需显式补齐或明确改为按需触发。
- **没有增量/游标查询**：`_list` 只支持 layer/path/status/limit，无 `since marked_at_ms` 或 cursor，轮询者每次只能全量拉 pending。
- **修复路径是桩**：`markdown-conflict-repair` job 无消费者（归 SPEC-5-FIX），SPEC-6 不能假设冲突/半提交产物会被自动修复。
- `base_version` 是不透明 token（当前 `event:<createdAtMs>:<eventId>`），只做等值比较，不解析格式。

## 预期 PR 拆分

> 2026-07 review 后重排：把"消费基础设施"提前为 PR1（原计划把它和 debounce 混在一起），且明确 embedding 是唯一真正的 ingest 解耦项，graph/taxonomy/synthesis 只是给已独立的任务加 job 调度 + marker 消费。

1. **Marker 消费基础设施**：状态流转 API（claim/complete/ack）、marker-claim lease（自愈式，或依赖 SPEC-5-FIX 的 lease 回收）、按 `(layer, affectedPath)` 去重/合并 + debounce/merge window、增量/游标查询、补齐或明确 7 层中缺的 3 层。derived job lifecycle（retry/cancel/resume）。
2. **Embedding rebuild job 化**：把 `autoIngestImpl` 步骤 17 移出主链路，改由 marker 驱动的后台 job；修复其错误被吞（findings P2）。这是本 SPEC 唯一真正的 ingest 解耦。
3. **Graph/search/materialized metadata rebuild job 化**：已独立的扫描任务接入 marker 消费与 job 调度。
4. **Taxonomy/synthesis rebuild job 化**：同上；注意 synthesis 页整页覆盖保护由 SPEC-11 修，本 PR 不重复。
5. **Optional index export / overview synthesis command**：显式 job，不是 ingest 副作用（补齐 `index_export`/`overview` 两层的按需触发）。
6. **UI 状态**：dirty、building、stale、ready、failed，含手动 rebuild 入口和 fallback search 状态说明。复用 SPEC-5 PR6 的 `RuntimeDiagnosticsSection<T>` + section 级降级 fan-out；轮询引擎先抽成通用 `usePolling<T>`（顺带修 SPEC-5-FIX/findings 的"外部触发不重置定时器"）；per-layer 状态 store 参照 `research-store.ts` 任务模式新建、复用 SPEC-11 抽出的乐观写 helper，不塞进扁平 `wiki-store.ts`。

## 验证策略

- 单测覆盖 dirty marking、dedupe、stale detection、manual rebuild。
- fake worker tests 覆盖 retry/cancel/resume。
- integration fixture：commit Markdown 后 UI 可见正文，derived state 异步更新。
- 确认 ingest 不再等待 embedding/overview/index 完成才结束。
- UI / diagnostics tests 覆盖 stale/building/ready/failed 状态、manual rebuild、fallback keyword/file search。

## Gate 结论摘要

本 SPEC 随当前 docs PR 通过 PR-level gate；详见 [SPEC-0](./spec-0-roadmap-baseline.md) 的 PR Gate 结论统一摘要。实现 PR 必须重新审查 stale/building UI、fallback search、marker debounce、后台优先级和 shell-neutral derived status。

## Non-goals / Follow-up

- 不重新引入 mandatory `index.md` / `overview.md`。
- 不把 derived outputs 当 committed truth。
- 不在第一版实现所有高级 rebuild scheduling 策略。
