# SPEC-6 PR2 执行计划：Embedding Rebuild Job 化

> 类型：PR 级执行计划 | 状态：design complete / ready for implementation | 轨道：derived | 分支：codex/spec6-pr2-embedding-job | lane：full | 创建：2026-07-04（只读调查完成后落此计划，file:line 基线 = main 9a1f2fd6）

## 调查关键事实

- 步骤 17 = `ingest.ts:1506-1534`（"Step 6: Generate embeddings"），双层 catch 全吞错误；`autoIngestImpl` 同步 await 完才标 done（:1541-1545）。次要内联 embed 点：`reembedRestoredWikiPage`（:1797-1820）、`captionSourceImagesImpl` 的 `reembedSourceSummary`（:857）。
- `embedPage`（embedding.ts:471-516）幂等：Rust `vector_upsert_chunks`（vectorstore.rs:487-550）同 page_id delete-then-add + 项目级互斥锁；delete intent 用 `removePageEmbedding`（:741-750）。
- **架构缺口**：embedding marker 只由 bulk 管线（`commitPendingStagingArtifacts`）产生；传统 `autoIngestImpl` 全程零 marker。
- **PR1 交付缺口**：Rust `runtime_job_retry` 已注册（lib.rs:515）但 TS 无 `runtimeJobRetry` 封装——消费者契约的第二信号（retry-wait job）无入口；retry 有 `retry_after_ms <= now` 前置校验（runtime_db.rs:3050-3055）。
- 免费可见性：`runtime-jobs-section.tsx`（Activity Panel 常驻，:419-431 渲染 job.lastError 红色高亮）无 kind 白名单——失败走 `runtimeJobFail` 即自动可见。

## Commander 裁定

1. **传统路径接线 = 方案 A**：`autoIngestImpl` 写盘成功后对每个 written wiki path 调 `recordDerivedStaleMarker`（embedding 层，reason="commit"；结构页跳过），删除内联步骤 17。理由：统一 marker 体系是 SPEC-6 本意（方案 C 与目标矛盾；方案 B 造第二套队列语义）。`reembedRestoredWikiPage`/`reembedSourceSummary` 两个次要点同样改为记 marker（best-effort，失败仅 console.warn，不阻塞其主流程）。
2. **并发缓解（风险 1）**：消费者处理某 `affectedPath` 前检查 ingest-queue 是否正在处理该路径/项目忙（processing 集合），忙则本 tick 跳过（marker 仍 pending，下轮收敛）。不在 PR2 内改 ingest 的非原子 writeFile（另记 follow-up）。
3. **宿主 = TS 模块级循环**：新增 `src/lib/derived-rebuild/embedding-consumer.ts`，照 `scheduled-import.ts:448-474` 的 start/stop + 忙标记 + 世代计数模式；heartbeat 陪跑照 `prepare-worker-pool.ts:511-561`；**必须接入 `reset-project-state.ts`（:79-99 stopScheduledImport 范式）**（SPEC-11 PR8b/S8 教训）。低优先级=tick 前检查前台忙则退避（DB priority 字段不能跨 kind 抢占）。
4. **部分失败语义（风险 3）**：`embedPage` 返回值扩展为 `{indexed, failed}`；`failed > 0` 时 job 走 `runtimeJobFail`（信息含 N/M chunks failed）→ retry-wait 由 job 自带退避重试；全成功才 `complete_batch`。
5. **补 `runtimeJobRetry(jobId)` TS 封装**；消费循环双信号：pending marker（claim_batch → claim_by_kind）+ retry-wait 且 `retryAfterMs <= now` 的 derived-rebuild job（runtimeJobRetry → claim_by_kind）。`runtimeJobList` 无 kind 过滤，先客户端 filter（follow-up 记录）。
6. **执行语义**：处理时从磁盘重读 affectedPath 当前内容（不信 payload 快照）；delete intent 只 removePageEmbedding；先落盘再 complete_batch（幂等重跑安全，PR1 契约）。

## 改动面

- `src/commands/runtime-db.ts`：+`runtimeJobRetry`
- `src/lib/embedding.ts`：`embedPage` 返回 `{indexed, failed}`（调用点同步适配）
- `src/lib/derived-rebuild/embedding-consumer.ts`（新）：start/stop、双信号轮询、heartbeat、忙退避、失败落 runtimeJobFail
- `src/lib/ingest.ts`：步骤 17 删除 → 记 marker；两个次要 embed 点改记 marker；ingest 完成不再等 embedding
- `src/lib/reset-project-state.ts` + 项目打开流程：consumer 生命周期接入
- `src/lib/parallel-knowledge/commit-integration.ts`：不改

## 测试

- consumer fake-runtime 单测：双信号轮询、delete intent、忙退避跳过、heartbeat 陪跑、部分失败→runtimeJobFail、complete 走 marker complete_batch、项目切换 stop/世代计数（含 sabotage：去掉 stop 接入应转红）
- embedPage 返回值单测；ingest characterization 确认「不再等待 embedding」不破坏既有断言；marker 记录调用点单测（含结构页跳过）
- runtime verify（必做）：真实 ingest 一个文档——页面先落盘、activity 完成不含 embedding、后台 job 出现并收敛；故意让 provider 报错，Activity Panel 可见 derived-rebuild job 的 lastError

## Gate

full lane。主力：内审（并发窗口 + 生命周期）+ runtime verify；副：Codex。风险矩阵维度：前台/后台同 path 撞车、项目切换/关闭、provider 限流叠加 job retry、消费循环崩溃恢复。

## Follow-ups（不在本 PR）

- ingest.ts 非原子 writeFile → writeFileAtomic（SPEC-8/11 域）
- runtimeJobList kind/state 过滤参数（job 量大时）
- Simplicity Gate 观察项：`recordEmbeddingStaleMarker` 的 anchor job（kind `"auto-ingest-marker-event"`）在 `runtimeJobCreate` 成功、但后续 claim/event-append/complete 任一步失败时，会留下一条 `queued` 孤儿行——不影响正确性（`runtimeJobClaimByKind` 之后可被随便一次调用顺带认领掉），但目前没有专门的 reaper；若此后同项目再无 ingest 触发同 kind 的 create+claim，这条孤儿行会永久残留在 `runtime_jobs` 表里（不会造成数据错误，只是表膨胀 + Activity Panel 里一条永远 "queued" 的噪音行）。
- 三 gate 合并修复轮观察项：`embedding-consumer.ts` 的 `safeFailClaim` 里 `runtimeJobFail`（job 转 terminal `failed`）→ `runtimeDerivedMarkerReleaseBatch`（markers 转 `failed`）是两次独立调用，非原子。若 job 已经落到 terminal `failed` 且 lease 已释放，但进程在两次调用之间崩溃、或恰好此时项目切换导致 `assertCurrentRun` 让第二次调用被跳过，该批 marker 会永久停在 `claimed`——已无 owning job（terminal，不会再被 `runtimeJobRetry` 捞回），也不再被 lease-timeout 回收调度器覆盖（那条路径只覆盖"job 本身状态转移"这单个事务内的场景，不覆盖"job 早已 terminal、只是 release 调用本身失败"这个后续步骤）。与 anchor-job 孤儿风险同一类别（accept + 记录，不在本 PR 修）：需要人工介入或未来一个显式的 "reconcile terminal jobs' still-claimed markers" 扫描任务来收敛。
