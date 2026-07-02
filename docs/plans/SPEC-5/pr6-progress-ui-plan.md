# SPEC-5 PR6: Progress / ETA / Controls UI

> 类型：PR 执行计划 | 状态：focused architect WARN absorbed / implementation ready | issue：#245 | tracking：#191 | branch：`codex/spec-5-pr6-progress-ui` | run：`37007d10-19ed-4a5f-84fb-d8b525ec155f`

## Summary

本 PR 收口 SPEC-5 的运行时可观察面，并补上一个显式 bulk runtime entry：用户从 Sources / Runtime 可见入口触发 bulk prepare planning/enqueue，系统把 source 列表规划成 `bulk-knowledge-prepare` runtime jobs，Activity Panel / Runtime Jobs UI 展示真实 runtime ledger 中的 jobs、progress、timeline、staging artifacts、profile claims / circuit breakers，并保留 pause / resume / cancel 控制。

重点修正：PR6 不能只做空 UI 聚合。必须能从 UI 或稳定命令产生 PR1-PR5 定义的 runtime jobs/progress，证明 SPEC-5 的 “scan、task planning、首批进度可见”。

## Scope

- Runtime entry：
  - 新增显式 bulk prepare plan/enqueue 操作。
  - 输入来自当前 project source tree，不静默替换 legacy ingest queue。
  - 调用 `planBulkKnowledgePrepare`，为每个 batch 创建 `bulk-knowledge-prepare` runtime job。
  - job payload 增加 bounded plan metadata：`planId`、`batchTotal`、`sourceTotal`、`uniqueSourceTotal`、`duplicateSourceTotal`，供 UI 计算 job/source 粒度进度。
  - duplicate runtime job create 可被识别为 idempotent skip；非 duplicate 错误向 UI 显示。
- Runtime Diagnostics snapshot：
  - 继续只读读取 job/progress/timeline/staging artifact。
  - 新增 model-call ingest profile pool snapshot，用于显示 active claims 和 circuit breakers。
  - 解析 SPEC-5 progress payload，不把业务调度状态机搬进 UI。
- Activity Panel / Runtime Jobs UI：
  - 展示 bulk prepare / commit / repair job 进度。
  - 展示 source/job/artifact 粗粒度完成度。
  - ETA 只在有足够 terminal sample 时显示近似值；缺少样本时显示 calculating / waiting。
  - 展示 worker/profile/backoff/rate-limit/error 信息，但只展示 ledger 中真实存在的数据。
  - 展示 staging pending / failed / committed summary 和最近 commit progress。
  - pause / resume / cancel 继续调用 SPEC-2 runtime job commands；UI shell 不持有 scheduler 状态机。
- Docs closeout：
  - `docs/plans/README.md` 标记 PR5 merged、PR6 active。
  - 本 PR 完成后把 SPEC-5 文档、SPEC-5 continuous plan 和 README 标记为 completed / PR6 merged。

## Non-goals

- 不承诺 30 秒处理 2400 篇真实文档。
- 不实现完整真实 provider producer；第一版只补显式 runtime enqueue + 可观察面。已有 worker pool 的 executor 仍按既有 contract 消费。
- 不自动启动 worker，也不假装 worker/profile/commit 进度存在。
- 不在导入文件时暗中 enqueue bulk jobs。
- 不改变 runtime job state machine、profile pool eligibility、claim/release/circuit-break 规则。
- 不新增 Settings IA；Runtime Diagnostics 当前仍消费 Activity Panel / Sources 显式入口。
- 不改 legacy ingest queue 的既有行为。

## GitNexus Impact

- `SourcesView`：HIGH。影响 `ContentArea -> AppLayout -> App`，3 个 process、3 个模块。风险来自主内容页 UI 入口；降险方式是新增显式按钮/状态，不改变现有 import / re-ingest 行为。
- `RuntimeJobsSection`：HIGH。影响 `ActivityPanel -> AppLayout -> App`，3 个 process、2 个模块。风险来自 runtime UI hub；降险方式是保留 compact job list 和 action contract，新增 diagnostics block。
- `useRuntimeJobsState`：HIGH。影响同上。PR6 会从单一 job polling 扩展为 diagnostics polling；必须覆盖 no-project、disabled、error、action refresh、poll interval。
- `ActivityPanel`：LOW。仅消费 summary 文案和展开状态。
- `summarizeRuntimeJobs`：LOW。直接影响 hook summary 和组件测试。
- `captureRuntimeDiagnosticsSnapshot`：LOW。当前无生产上游；PR6 扩展 profile pool section。
- `planBulkKnowledgePrepare`：LOW。当前无上游；PR6 消费 planner。
- `BulkKnowledgePrepareJobPayload`：LOW。5 个受影响符号；PR6 只追加可选/兼容 metadata，不删除既有字段。
- `runtimeJobCreate`：LOW。当前无上游；PR6 通过新 helper 调用。

HIGH 风险处理：不改 Rust runtime transition，不改 legacy ingest queue，不复用导入按钮做隐式 enqueue；新增 runtime entry helper 和 focused UI tests。

## Architect Gate Notes

- Claude ACP Architect Gate：provider/model preflight 后失败，未形成可用 report；记录为 incomplete，不算 PASS。
- ZCode Architect fallback 返回 `BLOCK`。已吸收：
  - P0：原计划没有真实 bulk runtime entry，UI 会空转。修正为显式 bulk prepare plan/enqueue。
  - P1：ETA 数据源不足。修正为只基于 job payload metadata + observed terminal progress；样本不足显示 fallback，不伪造 SLA。
  - P2：diagnostics polling 成本。修正为 adaptive polling：active 2s、idle 10s、section/all-error 30s。
  - P2：`useRuntimeJobsState` contract 必须保留 `list` 和 `summary`。修正为追加 `snapshot/diagnostics`，不替换旧字段。
  - P2：`runtime-diagnostics.test.ts` deep expected object 必须更新 profile pool section。
  - P3：workerId/profile holder/circuit breaker label 必须准确。修正为 UI 用 `holder` / `profileId`，不把 circuit breaker 假称 worker assignment。
  - P3：原 non-goal “不启动真实 bulk worker” 与“显示 bulk progress”冲突。修正为不自动启动 worker，但必须显式 enqueue runtime jobs；worker/profile/commit progress 只显示真实 ledger 数据。

修正后需要跑 focused Architect recheck。

Focused recheck result:

- ZCode focused Architect recheck returned `WARN` with no P0/P1/P2.
- Absorbed P3 before coding:
  - `runtimeJobCreate` accepts `payload: string`; enqueue helper must explicitly construct `BulkKnowledgePrepareJobPayload` per job and `JSON.stringify` it.
  - `runtime-diagnostics.test.ts` has exact `toEqual` expected objects; adding `profilePool` requires updating the healthy snapshot top-level expected object and summary counters.
  - `planId` deterministic input domain is `sorted normalized source paths + batchSize`; the same source set and batch size produce the same plan id for idempotent duplicate handling.

## Implementation Plan

1. 扩展 planner payload metadata：
   - 在 `BulkKnowledgePrepareJobPayload` 中追加 `planId`、`batchTotal`、`sourceTotal`、`uniqueSourceTotal`、`duplicateSourceTotal`。
   - `planBulkKnowledgePrepare` 生成 deterministic `planId`，输入为 `sorted normalized source paths + batchSize`，不使用时间或随机数。
   - 更新 planner tests。
2. 新增 runtime enqueue helper：
   - 新增 `src/lib/parallel-knowledge/bulk-runtime-entry.ts`。
   - `enqueueBulkKnowledgePrepareJobs(sources, options)` 调用 planner，并通过 `runtimeJobCreate` 创建 batch jobs。
   - helper 对每个 job spec 显式构造 `BulkKnowledgePrepareJobPayload`，包含 `batchIndex`、`sources` 和新增 metadata；调用 `runtimeJobCreate` 前必须 `JSON.stringify(payload)`。
   - 返回 enqueued / skipped duplicate / failed summary。
   - tests 覆盖 empty input、stable job ids、duplicate create skip、non-duplicate error。
3. 增加 Sources / Runtime 显式入口：
   - 在 `SourcesView` 增加 icon button 或 compact action。
   - 入口只读取当前 source tree 的文件路径，不改变 import / re-ingest 逻辑。
   - 显示 planning/enqueue 错误；成功后由 Activity Panel polling 展示 jobs。
4. 扩展 `runtime-diagnostics.ts`：
   - 增加 `profilePool` section，默认调用 `runtimeProfilePoolList({ kind: "model-call", taskFamily: "ingest" })`。
   - summary 增加 active profile claim / circuit breaker count。
   - partial-error 语义保持：单 section 失败不遮蔽其它 section。
5. 扩展 `useRuntimeJobsState`：
   - 用 `captureRuntimeDiagnosticsSnapshot` 读取 snapshot。
   - 保留 `list`、`summary`、pause/resume/cancel action。
   - 只暴露 `diagnostics` view model，不把 raw snapshot 泄漏给 UI consumer。
   - polling：active 2s、idle 10s、empty/quiet 30s、error 30s。
6. 扩展 `RuntimeJobsSection`：
   - 保留 compact job list 和合法控制按钮。
   - 增加 Diagnostics block：prepare jobs/source progress、worker waiting、ETA fallback、profile claim/backoff、staging/commit summary、recent progress。
   - payload parse failure 不抛出，只降级为 job 粒度展示。
7. 更新 i18n 和 tests：
   - `runtime-diagnostics.test.ts` 覆盖 profile pool success / partial failure。
   - 更新 healthy snapshot 的 exact `toEqual` expected object，追加 `profilePool: { data, error }` section，并更新 summary 计数断言。
   - `runtime-jobs-section.test.tsx` 覆盖 empty/loading/error、bulk progress、ETA fallback、profile assignment/backoff、pause/resume/cancel、poll interval。
   - `batch-planner.test.ts` / `bulk-runtime-entry.test.ts` 覆盖 runtime entry。
   - 必要时补 SourcesView focused test。
8. 更新 docs index / SPEC-5 状态。

## Gate Plan

- Focused Architect recheck：ZCode 或 Kimi read-only，timeout `600000`；若外部 agent 不可用，记录 incomplete 并跑 internal Architect fallback。
- Focused tests 后跑 Simplicity Gate；本 PR 涉及 UI + shared runtime diagnostics，默认 ZCode read-only simplicity reviewer，timeout `600000`。
- Tester Gate：Kimi read-only tester，重点看真实 runtime entry、UI 状态、ETA 误导、profile/backoff 可观察性、pause/resume/cancel 边界。
- Reviewer Gate：ZCode external reviewer + internal reviewer。
- UI validation：本地 dev app/browser 验证 Sources 显式 enqueue 入口、Activity Panel 展开态、Runtime Diagnostics 视觉状态；若真实 worker/profile 数据不足，不伪造，通过 tests fixture 覆盖状态。

## Reviewer Findings Absorbed

- ZCode Reviewer returned `WARN` with one real P1: PR6 creates bulk prepare jobs but does not start a worker, so UI could imply progress that will never advance. Absorbed by showing explicit `Queued; waiting for a prepare worker` diagnostics when queued prepare jobs have no progress rows or active profile claims, and by updating the Sources tooltip.
- P2 ETA fragility absorbed by materializing terminal timestamps before `Math.max`, avoiding hidden empty-array assumptions.
- P3 polling cost absorbed by backing off empty/quiet runtime polling to 30s.
- P3 duplicate job text matching absorbed with an inline boundary comment; a structured Rust duplicate code remains a future improvement, not a PR6 blocker.
- Low-cost follow-ups absorbed: `maxAttempts: 3` enqueue assertion and empty source tree disabled-button test.

## Test Plan

- `pnpm vitest run src/core-runtime/parallel-knowledge/batch-planner.test.ts src/lib/parallel-knowledge/bulk-runtime-entry.test.ts src/lib/parallel-knowledge/runtime-diagnostics.test.ts src/components/layout/runtime-jobs-section.test.tsx src/components/sources/sources-view.test.tsx`
- `pnpm lint`
- `pnpm test`
- `git diff --check`
- `npx gitnexus detect-changes --repo llm_wiki --scope staged`
- Browser desktop validation for Sources runtime entry / Activity Panel / Runtime Diagnostics.

## PR Title / Commit

- PR title：`SPEC-5 PR6: add bulk runtime progress UI`
- Commit：`feat: add bulk runtime progress ui`
