# SPEC-6 PR3+4（合并）执行计划：taxonomy/synthesis job 化 + 派生层契约收口 + S5 自愈

> 类型：PR 级执行计划 | 状态：design complete / ready for implementation | 轨道：derived | 分支：codex/spec6-pr34-taxonomy-synthesis | lane：full | 创建：2026-07-04（调查基线 main 9ea4ba54）
>
> 原计划的 PR3（graph/search job 化）与 PR4（taxonomy/synthesis）合并：调查证实 graph（wiki-graph.ts:150-289 现读现算零持久化，仅 graph-relevance.ts:55 内存缓存）与 search（search.rs:131-268 纯实时扫描；vector=embedding 层）**均无物化产物**，无 rebuild 目标；taxonomy（.llm-wiki/tag-taxonomy.json，tag-taxonomy.ts:8,459-491，纯手动触发）是唯一真实 rebuild 对象；synthesis（wiki-synthesis.ts:425-553 直写 wiki 页面）第二。

## Commander 裁定

1. **层契约收口**：`DERIVED_STALE_MARKER_LAYERS` 7 层值集不动（SPEC-3 契约）；contract 注释区分「materialized, job-backed」（embedding/taxonomy/synthesis/index_export/overview）与「declared, no materialized artifact」（graph/search——graph 永远现算、search=实时扫描+vector 归 embedding）。
2. **graph 从 `COMMIT_DERIVED_STALE_MARKER_LAYERS` 摘除**（commit-integration.ts:57-62 → embedding/taxonomy/synthesis 3 层）：无消费者的 marker 只会永久堆积 pending 行（表膨胀+诊断噪音），Wiring Gate 哲学优先。search 维持不产。既有已堆积的 pending graph marker：本 PR 不做迁移清理（量级极小、惰性行无害），记 follow-up 到 PR6 诊断面「显示时过滤 no-artifact 层」。
3. **taxonomy consumer**（job-backed，照 PR2 embedding-consumer 模式）：新增 `src/lib/derived-rebuild/taxonomy-consumer.ts`——claim taxonomy 层 marker（跨 affectedPath 聚合：一轮 tick 内多组 marker 合并成**一次** `applyTagTaxonomyGrowth` 增量调用，绝不用 bootstrap 以免覆盖用户已确认的 taxonomy）→ 成功后逐组 complete_batch。growth 是确定性扫描非 LLM 调用，成本低。复用 PR2 全套纪律：世代计数、每 await 复查、per-generation tick guard、忙退避、reset-project-state 接入、App 启动接线、心跳、双信号（retry-wait job 恢复）、runtime-disabled 时不回退（taxonomy 本就手动，禁用=维持现状）。注意 saveTagTaxonomy 的 expectedUpdatedAt 乐观并发：与用户手动 bootstrap/growth 并发冲突时让步重试（marker 保持 pending 下轮再试）。
4. **synthesis 不自动重生成**（LLM 成本 + 叙事覆盖风险 + SPEC-11 覆盖保护一致性）：不建 synthesis job consumer。交付「stale 查询」helper——`src/lib/derived-rebuild/synthesis-staleness.ts`：按 pending synthesis marker 聚合出「哪些 synthesis 输入簇已变化」的可查询状态（供 PR6 UI 渲染 stale 徽标）；`synthesis-section.tsx` 手动重跑成功后将对应 marker 走 claim_batch+complete_batch 闭环（消费者=手动动作本身）。**PR body 显式记录 deferred wiring：stale 徽标 UI 归 PR6**。
5. **S5 自愈（SPEC-11 遗留）**：跨文件 reference sweep 非事务、崩溃留死链。落地为 taxonomy consumer 同文件的轻量 dead-link 检查？——**否**，保持单一职责：在 lint 体系加一个确定性「死 wikilink 扫描」入口即可满足 S5 的自愈承诺（lint.ts 已有孤儿/断链类检查基建——先核实 lint 是否已含 dead-link 检查：若已有，S5 只需在 plan/文档里把「崩溃留死链→下次 lint 扫出」的自愈路径显式记录 + 补一个 characterization 用例证明 lint 能检出 sweep 半途的死链；若没有，加最小检查项）。不做自动修复（lint 的修复语义归既有 lint-fixer 流程）。
6. **架构 follow-up（记录不实现）**：synthesis 直写绕过 commit 管线（无 staging/base-hash 审计）——记入本计划 follow-ups + SPEC-6 收口清单，候选归 SPEC-7/8 或独立小 PR。

### S5 核实结论（实现落地时确认）

`src/lib/lint.ts:runStructuralLint` 已含确定性「broken-link」扫描（对每页 `[[wikilink]]` 与当前磁盘上的 wiki 页面集合做 slug/basename 匹配，命中失败即报 `broken-link`），且完全独立于 reference sweep 是否跑完——sweep 半途崩溃留下的死链，在链接目标页已不存在的前提下，下一次结构 lint 扫描会照常检出，不依赖 sweep 自身的完成状态。**该函数此前零测试覆盖**，故 S5 落地为：不新增检查代码，只在 `src/lib/lint.test.ts` 补两类用例——(a) `runStructuralLint` 的基线正/负向覆盖，(b) 一个直接对应 SPEC-11 chain-B 场景的 characterization（`other-page.md` 残留指向已删除 `kv-cache.md` 的 `[[kv-cache]]`，断言 lint 检出为 `broken-link`）。不做自动修复——修复语义仍归既有 lint-fixer 流程。

## 改动面

- `src/core-runtime/contract/index.ts`：层语义注释（值集不动）
- `src/lib/parallel-knowledge/commit-integration.ts`：COMMIT 层摘 graph（含既有测试断言更新）
- `src/lib/derived-rebuild/taxonomy-consumer.ts`（新）+ 测试
- `src/lib/derived-rebuild/synthesis-staleness.ts`（新）+ 测试
- `src/components/settings/sections/synthesis-section.tsx`：重跑成功后 marker 闭环（最小接线）
- `src/lib/reset-project-state.ts` + `src/App.tsx`：taxonomy consumer 生命周期
- lint 侧 S5 最小项（视核实结果）
- docs：本计划入 README 索引；prs-implementation-plan.md 更新 PR3/PR4 合并说明

## 测试

- taxonomy consumer：照 embedding-consumer.test.ts 全套模式（聚合成单次 growth、乐观并发冲突让步重试、生命周期/世代/双信号/嵌套失败），sabotage 自验（聚合去重、expectedUpdatedAt 冲突路径）
- synthesis-staleness：marker 聚合查询 + 手动重跑闭环（重跑后 pending 清零）
- commit-integration：graph 摘除后 marker 只产 3 层的断言更新 + 「graph 不再产生」的负向锁
- S5：lint 死链检出 characterization（构造 sweep 半途状态）
- runtime verify：fixture 级（同 PR2 口径）；app 级步骤记录（taxonomy growth 在 Settings 可见、synthesis stale 状态查询）

## Gate

full lane。主力：内审（并发/生命周期——已有 PR2 全套先例可对照）+ Tester（对称正负向、弱化参数检查）；副：Codex。Simplicity 重点：taxonomy consumer 是否照抄 PR2 模式而非重新发明、synthesis-staleness 是否最小。

## Follow-ups

- synthesis 直写绕过 commit 管线（staging/base-hash 审计缺失）——SPEC-6 收口清单项
- PR6 诊断面过滤 no-artifact 层的历史 pending marker（graph 既有堆积行）
- graph marker 若未来需要「重启后 graph 视图 stale 提示」可重新引入（当前 dataVersion 内存机制够用）
- **提取 `createDerivedRebuildConsumer(config)` 共享骨架**（Simplicity review P2，2026-07）：`embedding-consumer.ts` 与 `taxonomy-consumer.ts` 247 行逐字重复（世代计数、per-generation tick guard、忙退避、双信号轮询、心跳、safeComplete/safeFail marker 收敛全套），并发关键代码的双副本维护风险——改一处并发修复必须记得同步另一处。独立 PR，以两套既有测试（`embedding-consumer.test.ts` + `taxonomy-consumer.test.ts`）作为 characterization 基线。**裁定**：本 PR 内重构已上线的 embedding-consumer 会扩大爆炸半径（并发关键路径，PR2 已过 gate），独立小 PR 更安全——本 PR 只新增 taxonomy-consumer，不动 embedding-consumer。
