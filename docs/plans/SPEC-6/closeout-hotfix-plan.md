# SPEC-6 closeout hotfix — 执行计划

> 类型：PR 级执行计划 | 状态：active / in review | 分支：`codex/spec6-closeout-hotfix` | 基线：`main` `29456dd4`（SPEC-6 PR1-PR6 全部落地，PR6 `#288`）| 依赖：SPEC-6 PR1-PR6（已 merged）

## 背景

PR6（`#288`，per-layer 派生状态 UI + SPEC closeout）合并后，按其 Closeout Gate 交付物 d 的承诺执行了一次 SPEC-6 全子系统多代理深度 review。三维度 verdict 摘要和完整分流表见 [`prs-implementation-plan.md`](./prs-implementation-plan.md) 的「SPEC-6 closeout 深度 review 结论」节；本文档只记录本 PR（Tester/正确性维度 BLOCK 的 5 项 P0/P1，判定可安全内联修复、无需独立设计 PR）的执行细节。其余发现（架构级收敛工作）分流到 issue `#286`/`#287`（追加 7 项）/`#289`（新建），不在本 PR 范围。

## 修复范围（5 项，均为本次深度 review 的直接产物）

### 1. P0 — `classifyLayerStatus` 全历史 `.some()` 误判（`src/lib/derived-rebuild/status.ts`）

- **问题**：`runtime_derived_stale_markers` 无终态行 GC，层状态分类却对该层**全部历史** marker 跑 `.some(status === X)`。一条很久以前失败、从未被清理的 `failed` marker，会永久把整层压制在 `failed`，哪怕同一路径后来已经有更新的 `done` marker。
- **修复**：分类前先按 `(layer 已在调用方过滤, affectedPath)` 分组，每组只取 `marked_at_ms`/`marker_id` 意义下最新的一条（tie-break 对齐后端游标序 `ORDER BY marked_at_ms ASC, marker_id ASC`，见 `runtime_db/markers.rs`），再对这些「每路径最新」跑既有的 `building > failed > dirty > ready` 优先级聚合。`lastRebuiltAtMs`（done 行 `updatedAtMs` 最大值）语义不变。
- **测试**：新增「同路径旧 failed + 新 done → ready」「不同路径旧 failed + 新 done → 仍 failed」「跨路径归约后 building 盖过 failed」「归约 tie-break 对齐游标序」4 条；改造 4 条既有「优先级」测试（原用例把不同状态堆在同一默认路径上，归约后会被 tie-break 随机吞掉一半，现按语义拆到不同路径）。
- **Sabotage**：改回全历史 `.some()`，2 条新用例转红，确认后复原。

### 2. P1 — 搜索 fallback banner 文案与触发条件拆分（`src/components/search/search-view.tsx` + `src/i18n/{en,zh}.json`）

- **问题**：`showFallbackBanner = retrievalMode !== "hybrid" || embeddingNotReady` 把两种不同情况合并成一句「仅展示关键词结果」——但当 `retrievalMode === "hybrid"` 而 embedding 层 `dirty`/`building`/`failed` 时，这句话是假的：本次查询明明已经拿到了 hybrid 结果。
- **修复**：拆成两个独立信号，都要求 `embeddingConfig.enabled` 为真（用户从未打开过 embedding 时，两个 banner 都不显示——这是持续性的主动选择，不是临时降级）：
  - a) `retrievalMode !== "hybrid"`（本次查询真降级为关键词）→ 复用原 `search.fallbackBanner` 文案。
  - b) `retrievalMode === "hybrid"` 但 embedding 层 `dirty`/`building`/`failed`（本次是 hybrid，但索引可能过期/重建中/不完整）→ 新文案 `search.staleIndexBanner`，新 `data-testid="search-stale-index-banner"`。
- **测试**：三条「hybrid 但 dirty/building/failed」既有用例改断言到新 testid；新增「embedding 未启用时两个 banner 都不显示（即使 mode 非 hybrid 且 embedding dirty）」。

### 3. P1 — `derived-rebuild` job cancel 孤儿 marker（`src/components/layout/runtime-jobs-section.tsx`）

- **问题**：`cancelJob` 只调 `runtimeJobCancel`，job 转 `cancelled` 后其 claimed 的 marker batch 无人释放，永久卡 `claimed`——`bucketDerivedLayerStatus` 没有「claimed 但已废弃」这个状态可以退回,该层状态会一直显示成假的 `building`。
- **修复**：`cancelJob` 在 `runtimeJobCancel` 成功后，若返回 job 的 `kind === DERIVED_REBUILD_JOB_KIND`，best-effort 解析其 `payload.markerIds` 并调 `runtimeDerivedMarkerReleaseBatch({ jobId, markerIds, targetStatus: "cancelled" })`（失败仅 `console.warn`，不影响 cancel 本身的成功语义，镜像 `embedding-consumer.ts`/`taxonomy-consumer.ts` 里 `safeFailClaim` 的既有模式）。另外两个「锚点」job kind（`auto-ingest-marker-event`/`manual-rebuild-marker-event`，同一 tick 内自行铸造并 complete，从不会真的停留到能被这个面板 cancel）在面板上隐藏 Cancel 按钮——展示了也无意义，点了也不会有真实效果。
- **测试**：cancel 一个 `derived-rebuild` job → 断言 `runtimeDerivedMarkerReleaseBatch` 以正确参数被调用；cancel 非 `derived-rebuild` job → 断言不调用；两个锚点 kind 在 `queued` 态下也不渲染 Cancel 按钮。

### 4. P1 — 忙退避漏看 dedup-queue（`src/lib/derived-rebuild/embedding-consumer.ts` + `taxonomy-consumer.ts`）

- **问题**：两个 consumer 的忙退避只查 `getQueueSummary()`（ingest-queue）的 `processing`，但 `dedup-queue.ts`（`dedup-runner.ts` 的去重合并任务）会用同样非原子的方式重写同一批 wiki 页面——同一个竞态类别，退避条件却漏掉了它。
- **修复**：两个 consumer 各自显式别名导入两个队列的 `getQueueSummary`（`getIngestQueueSummary` / `getDedupQueueSummary`），退避条件改为两者 `.processing` 之和 `> 0`（即任一队列忙都退避整个 tick）。
- **测试**：两个 consumer 各补一条「dedup 队列忙 → tick 跳过（不调 `runtimeJobList`/`runtimeDerivedStaleMarkerList`/`runtimeJobClaimByKind`）」。
- **Sabotage**：`embedding-consumer.ts` 改回只查 ingest-queue，新用例转红，确认后复原。

### 5. P1 — `runtime-disabled` 默认态 UI（`src/stores/derived-layer-store.ts` + `src/components/settings/sections/derived-status-section.tsx`）

- **问题**：工作运行时功能标志（`LLM_WIKI_CORE_WORK_RUNTIME_ENABLED`）**默认关闭**，这是大多数用户的持续稳态，不是错误。但 `derived-status-section.tsx` 曾经把这个状态当成普通 error 处理——既渲染刺眼的「加载失败」amber 横幅，又渲染五张硬编码 `ready` 徽标的假卡片，双重误导。
- **修复（合并 gate 后修正版）**：`runtime_derived_stale_marker_list_for_project`（`runtime_db/markers.rs`）在功能标志关闭时是**成功返回** `Ok({ enabled: false, status: "disabled", markers: [], nextCursor: null })`，**从不 reject**——和这个仓库其它所有 `_list` 命令同一惯例（如 `runtime_job_list_for_project`，`runtime-jobs-section.tsx` 的 `summarizeRuntimeJobs` 一直是这么读的）。初版修复照抄了 `ingest-write.ts`「`recordEmbeddingStaleMarker`」那种铸造锚点 job 的命令会 reject 一个 `runtime-disabled:` 前缀错误的模式，装了一个 `catch` 里的字符串前缀判断——这个判断在生产环境永远不会触发（因为这个 API 根本不 reject），只是被一个手工构造成 reject 形状的假 mock 掩盖成了绿的。合并 gate（Tester 维度 P1）当场抓出。修正：`fetchAllDerivedStaleMarkers`（`status.ts`）不再只返回 markers 数组，改为返回 `{ markers, enabled, status }`——把首页响应本身携带的 `enabled`/`status` 一并透传出去（disabled/no-project 响应必然只有一页、markers 恒空、无游标，首页即全部答案）；`derived-layer-store.ts` 的 `loadSnapshot` 从这个**成功响应**里读 `enabled === false` 置 `runtimeDisabled: true`（`error` 保持 `null`），`catch` 分支现在只处理真实的 reject（IPC 失败、DB 损坏等），不再做任何 `runtime-disabled:` 字符串判断。`derived-status-section.tsx` 侧的中性说明卡渲染逻辑不变（复用 Rebuild 按钮已有的 `settings.sections.derivedStatus.runtimeDisabled` 文案）。
- **测试**：`status.test.ts` 补「`fetchAllDerivedStaleMarkers` 透传首页 `enabled:true/status:healthy`」+「透传 `enabled:false/status:disabled` 且不因此继续翻页」；store/section 侧原有两条测试的 mock 从 `mockRejectedValue(new Error("runtime-disabled: ..."))` 改为 `mockResolvedValue({enabled:false, status:"disabled", markers:[], nextCursor:null})`——即用真实响应形状驱动同一断言（`runtimeDisabled: true`、`error: null`、说明卡渲染、无 error 横幅、无 `ready` 徽标）。
- **Sabotage**：改回「`catch` 里判断 `err.message` 是否以 `runtime-disabled:` 开头」的旧检测方式（`fetchAllDerivedStaleMarkers` 正常 resolve、不再 reject），store 和 section 两条真实形状测试转红（`expected false to be true` / `expected null not to be null`），确认后复原。

## 验证

- `npm run typecheck`：干净。
- 受影响文件逐个 `npx vitest run`：`status.test.ts`（27 用例）、`search-view.test.tsx`（11）、`runtime-jobs-section.test.tsx`（28）、`embedding-consumer.test.ts`（26）、`taxonomy-consumer.test.ts`（24）、`derived-layer-store.test.ts`（5）、`derived-status-section.test.tsx`（13）、`derived-status.e2e.test.ts`（3，`fetchAllDerivedStaleMarkers` 返回形状变化后的解构点同步更新）——全绿。
- `npm run test:mocks` 全量：207 files / 2612 tests 全绿。
- Sabotage 验证：第 1 项 marker 归约、第 4 项 dedup 忙退避、第 5 项 runtime-disabled 检测信号（合并 gate 修正版）——均转红后确认修复点、复原后重新转绿。

## 合并 gate 反馈轮（P1 + P2 + P3，收到后当轮修完）

- **P1（检测信号错误，已按上文第 5 项修正）**：`fetchAllDerivedStaleMarkerList` disabled 响应是 resolve 不是 reject，原 catch-based 检测是死代码，测试 mock 形状是假绿——见上文第 5 项「修复（合并 gate 后修正版）」。
- **P2**：`runtime-jobs-section.test.tsx` 补两条：「cancel 一个 `derived-rebuild` job 但其 `payload` 是损坏 JSON」→ 不崩溃、`runtimeDerivedMarkerReleaseBatch` 不被调用、`console.warn` 被调用、cancel 本身仍成功（无 error 横幅、`refreshNow` 正常触发第二次 `runtimeJobList`）；「`runtimeDerivedMarkerReleaseBatch` reject」→ 同样不影响 cancel 本身的成功语义。两条都验证了 `releaseCancelledDerivedRebuildMarkers` 的 best-effort 边界（该函数内部已有 try/catch，本轮补的是端到端断言）。
- **P3**：`status.ts` 里 `isNewerMarker` 的 doc comment 改准确——`markerId` 在生产环境是随机 `Uuid::new_v4()`（未显式传入时），`markedAtMs` 相同时的 tie-break 只保证「确定性、和后端游标序一致」，不代表任何「更新」的语义；同一毫秒记录的两条 marker 在这个 schema 里没有真实的先后信号。

## Non-goals（本 PR 不做）

- issue `#286`/`#287`/`#289` 列出的架构级收敛工作（withProjectLock 覆盖、孤儿 marker/anchor reconcile 扫描任务、dedup 合并接入 marker 系统）——都需要独立设计和独立 PR，不安全内联进一次 hotfix。
- `createDerivedRebuildConsumer(config)` 共享骨架提取（既有 P2 backlog，本次 review 复核后维持独立 PR 级判断）。
