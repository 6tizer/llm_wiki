# SPEC-5: Six-PR Continuous Delivery Plan

> 类型：SPEC 连续执行总方案 | 状态：completed by #236/#238/#240/#242/#244/#246 | tracking：#191 | closeout issue：#245 | closeout run：`37007d10-19ed-4a5f-84fb-d8b525ec155f`

## Summary

SPEC-5 按 6 个 PR 串行完成，不合并 scope，不跳 PR，不把后续 SPEC 的职责提前塞进本阶段。

执行粒度固定为 one issue / one branch / one PR。每个 PR 开始时再落对应 PR 级计划，完成后按 workflow 执行 gate、PR、CI、merge、post-merge cleanup，并停止当前 agent-loop run 后进入下一 PR。

完成事实：

- PR1-PR6 已合并到 `main`。
- PR6 由 #246 完成，issue #245 已交付。
- PR6 Architect gate 初始 BLOCK 已吸收：最终实现包含真实 bulk runtime entry / observable data path，不是空 UI 聚合。

## Continuous PR Sequence

| PR | Plan | GitHub | Status | Scope | Gate focus |
|----|------|--------|--------|-------|------------|
| PR1 | [pr1-batch-planner-plan.md](./pr1-batch-planner-plan.md) | #236 | merged | batch planner、batched prepare plan、runtime diagnostics wrappers/snapshot | planner idempotency、diagnostics partial error、core/runtime boundary |
| PR2 | [pr2-prepare-worker-pool-plan.md](./pr2-prepare-worker-pool-plan.md) | #238 | merged | bounded prepare worker pool、scoped job claim、model-call profile routing | job lease、profile claim/release、worker progress |
| PR3 | [pr3-staging-validator-plan.md](./pr3-staging-validator-plan.md) | #240 | merged | prepare output parser/validator、runtime staging store、repair route | schema safety、path safety、pending cleanup、repair payload redaction |
| PR4 | [pr4-commit-integration-plan.md](./pr4-commit-integration-plan.md) | #242 | merged | pending staging artifact -> SPEC-3 commit operation | commit budget、base-hash conflict、derived stale marker、resume reconciliation |
| PR5 | [pr5-long-document-map-reduce-plan.md](./pr5-long-document-map-reduce-plan.md) | #244 | merged | long-document chunk plan/map/reduce、partial repair route | partial draft not auto-commit、repair ordering、core helper boundary |
| PR6 | [pr6-progress-ui-plan.md](./pr6-progress-ui-plan.md) | #246 | merged | progress / ETA / pause / resume / cancel UI、Runtime Diagnostics closeout | real runtime entry, non-misleading ETA, polling cost, UI controls, diagnostics visibility |

## Workflow Per PR

每个 PR 都按同一循环执行：

1. Start guard：
   - `git status --short --branch`
   - `npx gitnexus status`
   - `pnpm agent-loop status --json`
   - `pnpm agent-loop hooks doctor --json`
   - `pnpm agent-loop observe --json`
2. 若上一 PR 已 merge：
   - 切回 `main`
   - `git pull --ff-only origin main`
   - `npx gitnexus analyze`
   - 确认 worktree clean
3. 绑定当前 issue 到 agent-loop run。
4. 查 SPEC、PR 级计划、GitHub issue/PR、相关代码路径。
5. 修改 symbol 前跑 GitNexus impact；HIGH / CRITICAL 必须在计划中记录 blast radius 和降险策略。
6. 写或更新当前 PR 级计划。
7. Architect Gate：
   - Claude ACP 优先，必须显式 provider/model preflight。
   - Claude 不可用时走 Kimi/ZCode fallback。
   - 外部 gate timeout `600000`。
8. Coder 实现：
   - Commander 可 inline 小 scope Coder。
   - 大范围、高风险、跨模块改动优先调度 Coder。
9. Focused tests 通过后跑 Simplicity Gate。
10. Tester Gate。
11. Reviewer Gate。
12. 修完 P0/P1/P2 和 scoped P3 后跑：
    - focused tests
    - 必要 full tests / lint
    - `git diff --check`
    - `npx gitnexus detect-changes --repo llm_wiki --scope staged`
13. commit / push / open PR。
14. 非 trivial PR 必须有外部 reviewer PR comment；所有 review/test report 发到 PR comment。
15. CI green 且无 unresolved P0/P1/P2，修复该 PR 已发现全部 scoped P3 后，Commander 可 merge。
16. Post-merge cleanup：
    - switch main
    - pull latest
    - `npx gitnexus analyze`
    - `npx gitnexus status`
    - 检查 docs/plans index 与 PR plan 状态
    - worktree clean
    - `pnpm agent-loop stop --json`
    - `pnpm agent-loop status --json`
    - `pnpm agent-loop hooks doctor --json`

## PR6 Correction Before Coding

PR6 不能只把 `runtime_jobs`、progress、timeline、staging、profile pool 聚合到 UI。ZCode Architect Gate 已指出：如果没有真实 bulk runtime entry，UI 会长期显示空状态，无法证明 SPEC-5 的 “scan、task planning、首批进度可见”。

PR6 编码前必须修正计划，至少满足一种真实可观察路径：

- 在 Sources / Runtime entry 增加显式 bulk prepare plan/enqueue 操作，调用 batch planner 并创建 `bulk-knowledge-prepare` runtime jobs；或
- 接入已有等价生产路径，能从 UI 操作或稳定命令产生 PR1-PR5 定义的 runtime jobs/progress。

PR6 不应做的事：

- 不静默替换 legacy ingest queue。
- 不在导入文件时暗中 enqueue bulk jobs。
- 不假装有 worker/profile/commit 进度；只能展示 runtime ledger 里真实存在的数据。
- 不给缺少样本的 ETA 伪造精确时间。

PR6 计划修正后，再跑 focused Architect recheck。若外部 agent 不可用，记录 fallback，并由 internal Architect 做只读审查。

## Merge Standard

合并标准固定：

- 无 unresolved P0/P1/P2。
- 该 PR 已发现的全部 scoped P3 必须修复。
- CI 通过。
- GitNexus detect scope 符合预期。
- Simplicity Gate 已 PASS/WARN 且 P2 清零。
- Tester / Reviewer gate 的真实 blocking finding 已修复或按 workflow 建 follow-up 并记录。

## Closeout

SPEC-5 六个实现 PR 已全部完成：

1. PR1 #236 Batch Planner。
2. PR2 #238 Prepare Worker Pool。
3. PR3 #240 Staging Artifact Parser / Validator。
4. PR4 #242 Commit Operation Integration。
5. PR5 #244 Long-document Map-reduce。
6. PR6 #246 Progress / ETA / Controls UI。

下一阶段进入 SPEC-6 Derived Knowledge Rebuild 的 PR 级规划。

## Test Plan For This Plan

- `rg "Six-PR|PR6 Correction|Closeout|SPEC-5 PR6" docs/plans/SPEC-5 docs/plans/README.md`
- `git diff --check`
- 本文件是 docs planning artifact，不代表 PR6 implementation gate 结论。
