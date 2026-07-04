# SPEC-6 PR5 执行计划：index export / overview 显式重建 job

> 类型：PR 级执行计划 | 状态：design complete / ready for implementation | 轨道：derived | 分支：codex/spec6-pr5-index-overview | lane：full（新功能从零实现；无并发面，gate 按比例配置、免对抗矩阵）| 创建：2026-07-04（调查基线 main 8db8dd7e）

## 调查关键事实

- **生成逻辑不存在**：唯一写入点是项目创建静态模板（project.rs:167-207）；SPEC-3 PR2 后 ingest 明确跳过 root index/overview 写入（ingest.ts:1599-1601, 1890-1895）。其余触点全是增量维护（dedup rewriteIndexMd、删页清理）或只读 context。PR5 从零实现生成本体。
- 最接近的可复用扫描：sweep-reviews.ts:51-84 buildWikiIndex（flattenMdFiles + frontmatter title）+ wiki-page-types 分类。
- marker 外键链硬约束：sourceEventId → runtime_events(event_id) → runtime_jobs(job_id) 真外键（schema.rs:691,457）——必须先 job 再 event 再 marker（PR2 的 recordEmbeddingStaleMarker anchor 链是同构参照，但本 PR 的 job 是真实执行 job 而非 anchor）。base_version 不透明 token 自由填。
- UI 无既有入口；synthesis-section.tsx 的 generate→markRebuilt 闭环模式可复刻。

## Commander 裁定

1. **marker = 自产自销闭环**（非仪式）：手动触发 = `runtimeJobCreate(kind:"derived-rebuild", payload 含 layer)` → `runtimeEventAppend` → `runtimeDerivedStaleMarkerRecord(layer, affectedPath, reason:"manual_rebuild", sourceEventId)` → `runtimeDerivedMarkerClaimBatch(layer, affectedPath, jobId:同一 job)` → `runtimeJobClaim({jobId})`（PR3+4 targeted 原语）→ 执行生成写盘 → `complete_batch`；失败走 runtimeJobFail/release 既有路径。价值：PR6 用同一 `runtimeDerivedStaleMarkerList` 查询面覆盖全部 5 个物化层的 building/done/failed 状态，零旁路状态存储。三步铸造 + 闭环提取为两层共享的小 helper（仅此可共享，不做 consumer 骨架）。
2. **index_export = 确定性同步执行**：扫 wiki/ 全树按 type 分组生成 `- [[slug]] — 描述` 列表（沿用 project.rs 模板标题结构），前台点击即完成，无成本提示。复用 sweep-reviews 扫描思路（不直接改它——review 匹配与 index 生成职责不同，允许小范围共享 helper 若形状吻合）。
3. **overview = LLM 手动生成**（照 synthesis 模式）：单按钮（无 candidate 预览——只有一份 overview.md），streamChat 调用，loading/error/disabled 态照抄 synthesis-section；**不自动触发**。
4. **UI = 独立 `index-overview-section.tsx`**（与 synthesis/taxonomy 并列，settings-view.tsx switch 注册）。
5. **不重开 COMMIT 层决策**：index_export/overview 保持不随 commit 产 marker（PR3+4 contract 注释既定）。
6. **不顺带清理 ingest.ts 的 index.md 只读 context 注入**：它把 index 内容喂给 LLM 当上下文，动它改变 ingest prompt 行为，非纯死码——归 SPEC-8 独立评估。
7. contract/index.ts 注释「not yet implemented」措辞收口为已实现。

## 改动面

- `src/lib/derived-rebuild/manual-rebuild.ts`（新）：三步铸造+闭环共享 helper
- `src/lib/derived-rebuild/index-export.ts`（新）：扫描+分组+格式化（纯函数可测）+ 写盘 + 闭环
- `src/lib/derived-rebuild/overview-rebuild.ts`（新）：LLM 生成 + 闭环
- `src/components/settings/sections/index-overview-section.tsx`（新）+ settings-view.tsx 注册
- `src/core-runtime/contract/index.ts`：注释收口
- docs：本计划入 README 索引

## 测试

- index-export 纯函数单测（分组/格式/空 wiki/type 边界）；两层闭环测试（成功路径 marker pending→claimed→done；生成失败/complete 失败的 release/fail 路径；连续两次重建都成功——PR3+4 P0-1 同形态回归锁）
- overview：mock streamChat 成功/报错
- section 交互测试照 synthesis-section.test.tsx
- runtime verify：fixture 级 marker 状态流转断言

## Gate

full lane（新功能），但无并发面：internal Simplicity + Tester + Reviewer（sonnet 级）+ Codex 副审；免 opus 对抗矩阵（无共享状态竞争——单次前台触发）。PR body 重点自检项：marker 的 job/event 外键链正确性。

## Follow-ups

- 若 PR6 需要「上次重建时间」展示，从 marker done 行的 updated_at_ms 读取（无需新存储）
- overview 重建是盲覆盖——点击 Rebuild 直接用 LLM 输出整体覆写 wiki/overview.md，无 diff 预览、无确认弹窗。当前判定可接受：按钮文案（"Rebuild"）语义本身即声明覆盖意图，且 overview 是单页非人工精修产物（不同于 synthesis 的"人工可能已编辑过"顾虑）。轻量确认弹窗、或按钮旁展示"上次生成时间"作为覆盖前提示，留作 PR6+ 候选（可与上一条的 updated_at_ms 展示合并实现）。
