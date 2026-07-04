# SPEC-6 PR6 执行计划：per-layer 派生状态 UI + SPEC Closeout

> 类型：PR 级执行计划（SPEC-6 收口 PR）| 状态：design complete / ready for implementation | 轨道：derived | 分支：codex/spec6-pr6-derived-status | lane：full | 创建：2026-07-04（调查基线 = PR1-PR5 全合并，main ce362263）

## Commander 裁定（依据 PR6 前置调查）

1. **五态口径**：dirty（存在 pending marker）/ building（存在 claimed）/ failed（收敛 failed）/ ready（无 pending/claimed 且最近 done；从未有 marker 也算 ready）。**stale 不是第六态**——是「dirty 且该层无自动 consumer」（synthesis/index_export/overview）时的展示文案变体，不虚构 marker 表外状态。
2. **graph/search 在 UI 隐藏**（declared/no-artifact，展示无信息量；历史堆积的 graph pending marker 由此自然过滤——PR3+4 follow-up 闭环）。
3. **数据源 = 单次 `runtimeDerivedStaleMarkerList({})` 全量拉取**（合理 limit + 游标兜底）+ 客户端按 (layer, status) 分桶：同一快照时刻无层间错位。新 `src/lib/derived-rebuild/status.ts`（纯函数分桶可测）+ `src/stores/derived-layer-store.ts`（照 research-store.ts，`Record<layer, LayerState>`；含 updatedAtMs——「上次重建时间」从 done 行读，PR5 follow-up 闭环）。
4. **`usePolling<T>` 抽取**（`src/lib/hooks/use-polling.ts`）：timer handle useRef、`refreshNow()` 清旧 timer→立即执行→按新 delay 重排——修「外部触发不重置定时器」（spec-5-8-post-review-findings.md:108，runtime-jobs-section.tsx:175-206,434-456）。**只迁 runtime-jobs-section**（行为不变+修 bug，保留其 2s/10s/30s 分级 delay selector）+ 新 derived-status 轮询复用；其余 4 个轮询点不迁（爆炸半径，PR3+4 裁定先例）。
5. **手动 rebuild 补全**（spec 成功标准「用户可手动 rebuild 指定 derived layer」）：embedding/taxonomy = **只铸 marker 不 claim**（reason:"manual_rebuild"，后台 poller 下一 tick 自然拾取——两 consumer 不特判该 reason）。新 `manual-rebuild-marker.ts` 小 helper：从 manual-rebuild.ts 前半段抽出 anchor 铸造，并与 ingest-write.ts 的 recordEmbeddingStaleMarker **真去重**（后者改为调用共享 helper——这是 Simplicity 重点审查项，不许第三份复制）。
6. **UI 落点 = 新 `derived-status-section.tsx`**（Settings，与 index-overview 并列）：5 层状态卡片（状态徽标 + 上次重建时间 + stale 文案变体），embedding/taxonomy 卡片带 Rebuild 按钮（乐观写照 store-helpers persistSetting 模式：先标 building 铸造失败回滚）；synthesis/index_export/overview 卡片指引到既有 section（不重复按钮）。每层查询失败独立降级（复用 RuntimeDiagnosticsSection<T> 的 section 级降级思想）。
7. **搜索 fallback 明示**：search.ts `searchWiki` 透传后端已返回但被丢弃的 `mode`/`vectorHits`；search-view.tsx 在 mode 非 hybrid 或 embedding 层 dirty/building 时渲染提示条（「向量索引未就绪，当前关键词检索」）。
8. **Closeout Gate（本 PR 必须交付）**：a) 端到端 fixture 测试——fake runtime + consumer tick 拼接跑通 commit→marker pending→claim→consumer→done→UI 状态流转（无 LLM key；overview mock streamChat）；b) deferred wiring 处置表（调查报告第 6 节的 13 项逐项标注 已接线/本 PR 闭环/显式移交到哪）写入 prs-implementation-plan.md 收口节 + PR body；c) docs/plans/README.md 四处状态行更新（SPEC-6 → completed、PR5/PR6 行、顶部状态表、当前优先级段）；d) 合并后安排 SPEC-6 全子系统多代理深度 review（post-merge 步骤，不在 diff 内）。

## 改动面

调查报告第 7 节草案照单：status.ts / use-polling.ts / derived-layer-store.ts / manual-rebuild-marker.ts（+ingest-write.ts 去重改造）/ derived-status-section.tsx（+settings-view 注册+i18n）/ runtime-jobs-section.tsx 迁移 / search.ts + search-view.tsx / docs。

## 测试

- status.ts 分桶纯函数（各状态组合/空表/仅 no-artifact 层/failed 优先级——同层同时有 pending 和 failed 显示什么：裁定 building>failed>dirty>ready 的优先序）
- use-polling：refreshNow 重置定时器（修的 bug 的回归锁——旧 timer 被清、新 delay 生效）、卸载清理、fake timers
- runtime-jobs-section 迁移后既有测试全绿 + 「操作后立即 refresh 且节奏切换」新用例
- derived-layer-store 乐观写回滚；manual-rebuild-marker 去重后 ingest-write 既有测试不回归
- search fallback 透传 + 提示条条件渲染
- e2e fixture（Closeout 证据）
- sabotage：refreshNow 不清旧 timer → 回归锁转红；分桶优先序写反 → 对应用例转红

## Gate

full lane。主力：Codex（架构/接口一致性：store 形状、usePolling 接口、helper 去重）；内审 opus 为副但重点查 usePolling timer 竞态（封闭域，免完整对抗矩阵）+ runtime-jobs-section 迁移保行为。Simplicity 重点：helper 是否真去重、section 是否又复制骨架。runtime verify：真实驱动手动 rebuild 按钮观察状态流转 + 搜索 fallback 提示（fixture 级 + app 级步骤记录）。
