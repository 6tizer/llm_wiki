# SPEC-5 PR5: Long-document Map-reduce Analysis

> 类型：PR 执行计划 | 状态：architect gate absorbed / implementation active | issue：#243 | tracking：#191 | branch：`codex/spec-5-pr5-map-reduce` | run：`c6d25219-1397-4744-bbb1-404bcbaf20b4`

## Summary

本 PR 为批量知识编译补上长文 map-reduce 分析基座。它让长文 source 可以先拆成稳定 semantic chunks，chunk 级 map 结果再 reduce 成完整或 partial draft；失败或低置信度 chunk 不拖死整个 batch，而是生成 runtime repair/review job。

## Scope

- 新增 shell-neutral long-document map-reduce core：
  - 稳定 semantic chunk plan。
  - chunk map result schema。
  - complete / partial / failed reduce result。
  - 默认 commit policy：complete 才可进入 staging commit；partial / failed 为 repair-only。
  - failed / low-confidence / missing chunk repair payload。
- 只把纯 chunking helper 提取到 core runtime；`ingest-chunk.ts` 继续保留 checkpoint / LLM / fs / activity-store 逻辑，并从 core 导入 + 再导出纯 helper，保持既有 import surface 不变。
- prepare worker pool 消费 executor success outcome 中的 map-reduce result：
  - complete result 的 artifacts 可继续 staging artifact validation/store。
  - partial / failed source 的 artifacts 默认不进入 `pending` staging，避免 PR4 commit pass 提前提交低置信度 draft。
  - 同一 batch 内其它 complete source 的 artifacts 不被 partial source 阻塞。
  - failed / low-confidence / missing chunks 创建 bounded repair job。
  - repair payload 不包含 Markdown body、chunk 原文或 secret。
- worker progress 记录 map-reduce repair routing，供 PR6 Runtime Diagnostics 展示。
- 当前 PR 不引入非 committable staging status；若未来需要保留 partial draft body 给人工审阅，应另开 runtime-db/staging status PR。
- 第一版没有真实 `PrepareModelCallExecutor` producer；worker 消费路径用 fake executor 覆盖，真实 producer 后续接入。
- 更新 SPEC-5 执行状态：PR4 merged，PR5 active。

## Non-goals

- 不做 PR6 的 Progress / ETA / pause / resume / cancel UI。
- 不把 map-reduce worker 直接写 final Markdown；final write 仍走 PR4 commit integration。
- 不重写 legacy `analyzeLongSourceInChunks` 的串行 ingest 行为。
- 不实现 repair job consumer。
- 不改变 model-call profile pool eligibility / claim / circuit-break 规则。

## GitNexus Impact

- `runPrepareWorkerPool`：LOW；无已索引上游调用，PR5 增加 success outcome 后处理和统计字段。
- `storeSuccessfulArtifacts`：LOW；直接影响限定在 parallel-knowledge worker pool 内。
- `parsePreparePayload`：LOW；若需要读取 extended payload metadata，影响限定在 worker pool 内。
- `splitSourceIntoSemanticChunks`：LOW；直接上游为 `analyzeLongSourceInChunks`。
- `analyzeLongSourceInChunks`：CRITICAL；直接牵到 ingest、Agent tools、deep research、App 流程。本 PR 不改变其行为，只允许为复用 chunking helper 做等价导入/再导出；若 Architect Gate 要求修改函数体，必须重新评估并单独记录风险。

## Architect Gate Notes

- Claude ACP Architect Gate session `409ec099-5ef9-4496-bf2d-033734448863` returned `WARN`.
- P1 absorbed before coding:
  - Partial draft auto-commit hazard：PR4 commit integration 只按 `status = pending` 选 staging artifact，不 join prepare job state。PR5 默认不把 partial / failed source artifact 存成 pending；core reduce 仍产出 partial draft metadata，但 worker 只创建 repair job。
  - Repair/store ordering：worker 先 validate/filter artifacts，再 clear pending、store committable artifacts、创建 map-reduce repair jobs；若 repair creation 失败，必须 clear pending 并 fail job，不能留下 orphan pending artifact。
  - Shell-neutral helper extraction：只能移动纯 helper 到 core runtime；`core-runtime` 不得 import / re-export `@/lib/ingest-chunk`。
- P2 absorbed:
  - 使用独立 `bulk-knowledge-map-reduce-repair` kind，并在 core runtime 集中定义 payload schema。
  - 明确真实 producer 不在本 PR；本 PR交付 core reduce + worker consumption contract。
  - core plan/reduce 不使用 `Date.now()` / `Math.random()`。
- P3 absorbed:
  - `pnpm lint` 存在，实际执行 `npm run typecheck`。
  - 新增 core-runtime import boundary guard。
  - 新增 repair payload redaction tests，覆盖 Markdown body、artifact path、chunk text、secret-like field。

## Implementation Plan

1. 新增 `src/core-runtime/parallel-knowledge/long-document-map-reduce.ts`：
   - 定义 chunk plan / map result / reduce result / repair payload types。
   - 提供 `planLongDocumentMapReduce`、`reduceLongDocumentMapResults`。
   - 输出 deterministic source hash、chunk hash、status counts。
   - 不使用 wall-clock time 或随机数。
2. 把既有 semantic chunking 纯 helper 提取到 core runtime：
   - `splitSourceIntoSemanticChunks`
   - `semanticBlocks`
   - `overlapSuffix`
   - `splitOversizedBlock`
   - `clampNumber`
   - `hashTextHex`
   - `SourceChunk`
   `src/lib/ingest-chunk.ts` 导入并再导出这些 helper，保持 `./ingest-chunk` 和 `./ingest` 的对外 API 不变。
3. 扩展 `PrepareModelCallOutcome` success variant：
   - 支持 `mapReduceResults`。
   - worker 根据 map-reduce status 过滤 repair-only source artifacts，只 store complete/committable artifacts。
   - worker 在 committable artifacts store 后创建 map-reduce repair jobs。
   - repair 创建失败时 clear pending artifacts for job 并 fail 当前 prepare job。
4. 增加 bounded repair job kind：`bulk-knowledge-map-reduce-repair`：
   - payload 只包含 job/source/chunk/status/error/hash metadata。
   - 不包含 chunk 原文、artifact body、Markdown body。
   - `maxAttempts` 采用现有 artifact repair job 的 bounded pattern。
5. 增加 worker result counters：
   - partial map-reduce result count。
   - map-reduce repair job count。
6. 增加 core-runtime boundary guard，防止 core 反向依赖 `@/lib` / `@/commands` / `@/stores`。
7. 更新计划索引和 PR4 计划状态。

## Gate Plan

- Architect Gate：Claude ACP 优先，timeout `600000`；不可用时 ZCode/Kimi fallback。
- Focused tests 后跑 Simplicity Gate；本 PR 涉及 shared runtime / worker state，用 ZCode read-only simplicity reviewer，timeout `600000`。
- Tester Gate：Kimi read-only tester，关注 chunk partial success、repair routing、artifact validation sequencing。
- Reviewer Gate：ZCode external reviewer + internal reviewer。
- 合并标准：无 unresolved P0/P1/P2，修复本 PR scoped P3，CI green。

## Test Plan

- `pnpm vitest run src/core-runtime/parallel-knowledge/long-document-map-reduce.test.ts src/lib/parallel-knowledge/prepare-worker-pool.test.ts src/lib/ingest-chunk.test.ts`
- `pnpm vitest run src/core-runtime/parallel-knowledge/long-document-map-reduce.test.ts src/core-runtime/contract/headless-contract.test.ts src/lib/parallel-knowledge/prepare-worker-pool.test.ts src/lib/ingest-chunk.test.ts src/lib/ingest.prompt.test.ts`
- `pnpm lint`
- `pnpm test`
- `npx gitnexus detect-changes --repo llm_wiki --scope staged`

Focused coverage must include:

- Deterministic chunk plan and stable hash/order.
- complete / partial / failed reduce status counts.
- failed / low-confidence / missing chunk repair payloads.
- partial / failed source artifacts are not stored as pending.
- repair creation failure clears pending artifacts and fails the job.
- map-reduce repair payload redacts Markdown body, artifact paths, chunk text, and secret-like fields.
- `splitSourceIntoSemanticChunks` remains importable from `./ingest-chunk` and `./ingest`.

## PR Title / Commit

- PR title：`feat: add long-document map-reduce prepare support`
- Commit：`feat: add long-document map-reduce prepare support`
