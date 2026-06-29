# SPEC-2 PR7: Minimal Runtime UI Plan

> 类型：PR 执行计划 | 状态：in progress | 分支：`codex/spec-2-pr7-runtime-ui` | 基线：`1df54d7` | Commander：Codex

## 目标

为 SPEC-2 Work Runtime 增加最小可见 UI：显示 runtime job 队列状态，并提供符合 ADR 状态机的 pause / resume / cancel 操作。UI 只观察和请求 Core Runtime/Tauri 命令，不拥有 runtime state。

成功标准：

- Runtime UI 在 `core.workRuntime.enabled` 关闭或无项目时不触碰 `runtime.db`，显示轻量 disabled/no-project 状态或不显示。
- 启用 runtime 后，UI 能读取 `runtime_job_list`，展示 queued / running / paused / retry-wait / failed / completed / cancelled 概览。
- UI 支持 cancel 非终态 job；支持 pause queued/running job；支持 resume paused job。
- pause/resume/cancel 都走 SPEC-2-owned runtime commands，不直接写 Zustand 或 SQLite。
- 旧 PR2-PR6 DB 正常打开；list 不迁移旧 DB，写操作按对应 command forward migrate。
- UI 不阻塞主工作区，不做复杂 scheduler，不承诺 worker 已接入 runtime。

## 范围

实现范围：

- `src-tauri/src/commands/runtime_db.rs`
  - 新增 `runtime_job_pause` / `runtime_job_resume` Tauri command。
  - pause transition：
    - `queued -> paused`
    - `running -> paused`，同时释放 active lease，后续 worker result must be ignored。
  - resume transition：
    - `paused -> queued`
  - 继续复用 `with_runtime_writer`、`open_job_runtime_locked`、closed-world state validation。
  - 补 Rust tests：pause/resume happy path、invalid transitions、running pause releases lease、disabled/no-project no-touch、existing list behavior不变。
- `src-tauri/src/lib.rs`
  - 注册新增 pause/resume commands。
- `src/commands/runtime-db.ts`
  - 新增 shell-side typed wrappers：job list、cancel、pause、resume。
  - 不把 `runtime_db_health` 放入 UI polling wrapper；该命令是 initializer，不是纯读探针。
- `src/components/layout/runtime-jobs-section.tsx`
  - 新增 Runtime Jobs section：summary、job rows、pause/resume/cancel icon buttons。
  - 封装 polling、action handlers、compact error state，避免继续膨胀 `ActivityPanel`。
- `src/components/layout/activity-panel.tsx`
  - 只接入 RuntimeJobsSection 和 summary，不内联 runtime job polling/action 逻辑。
  - 保持 compact operational UI；不做营销页，不新增全屏页面。
- `src/i18n/en.json` / `src/i18n/zh.json`
  - 新增 runtime UI 文案，保持 parity。
- `docs/plans/README.md`
  - 更新 PR6 merged，登记 PR7 plan in progress。

不做：

- 不实现 scheduler / worker claim loop。
- 不把旧 ingest queue 迁到 runtime DB。
- 不实现 profile usage、derived stale marker、resource budget UI。
- 不做 Swift UI。
- 不新增 runtime DB live toggle；继续遵守 startup/project-open feature flag。

## UI 设计

落点：`ActivityPanel` 底部，因为它已经承载 ingest queue、file-sync queue、activity items，是最贴近“后台工作状态”的工作面。

结构：

- Collapsed bar status：
  - ingest queue 和 file-sync 仍是最高优先级。
  - 当 ingest/file-sync idle 且 runtime 有 active/failed jobs 时，显示 runtime 文案，避免 icon 与文字不一致。
  - 优先级：ingest active/failed > file-sync active/failed > runtime list error > runtime failed > runtime active > activity items done。
  - runtime list error 使用 compact error 文案，不 toast；expanded section 与 collapsed bar 共用同一 error source。
- Expanded panel：
  - Section title：`Runtime Jobs`
  - Summary：`running / queued / paused / failed`
  - Rows：
    - kind + short job id
    - state badge
    - attempt/maxAttempts
    - updated time or retry_after_ms
    - actions：pause、resume、cancel，只有合法状态显示对应 icon button。

交互规则：

- Poll interval 初版 2s，只在 project 存在时开启；组件 unmount 清理 timer。
- Poll 只调用 `runtime_job_list`。禁止在 mount/poll 中调用 `runtime_db_health`，因为 health 会在 enabled + project 时创建/打开 DB、启用 WAL、写 migration。
- `runtime_job_list` 抛错时，RuntimeJobsSection catch 并显示一行 compact error；不 toast，不让错误刷屏。
- command 失败显示一行 compact error，不 toast flood。
- cancel 只对 queued/running/paused/retry-wait 显示。
- pause 只对 queued/running 显示。
- resume 只对 paused 显示。
- failed 的 retry 先不暴露到 UI，避免和旧 ingest retry 混淆；后续可补。
- completed/cancelled 默认不作为 collapsed bar active 来源；expanded rows 可按 limit 显示最近 jobs，避免历史终态让 ActivityPanel 常驻。

## 后端状态机补齐

ADR 已冻结 pause/resume：

| Operation | From | To | Rule |
| --- | --- | --- | --- |
| `pause` | `queued` | `paused` | Pending work is removed from claim eligibility. |
| `pause` | `running` | `paused` | Active lease is invalidated; worker result must be ignored. |
| `resume` | `paused` | `queued` | Paused work becomes claimable again. |

实现规则：

- `runtime_job_pause_for_project(project, enabled, request, now)`
  - request: `{ jobId }`，新增 request struct 必须 `deny_unknown_fields`；旧 job request structs 不在 PR7 中回改。
  - allowed states: `queued`, `running`。
  - queued pause: update `state='paused'`, `updated_at_ms=now`。
  - running pause: update `state='paused'`, `updated_at_ms=now`；active lease `status='cancelled'`, `released_at_ms=now`。
  - running 分支镜像现有 cancel 语义：在同一事务内将该 job 当前 active lease 更新为 `cancelled`；唯一索引保证最多 1 条，若历史不一致导致 0 条 active lease，也不回滚 job pause。
  - pause 后使用旧 `leaseId` 调 complete/fail/heartbeat 必须被 `ensure_active_running_lease` 路径拒绝：正常路径会因 lease inactive 被拒；历史不一致路径也会因 job state 已是 `paused` 被拒，保证 worker result must be ignored。
  - terminal states / failed / retry-wait reject `invalid-transition`。
- `runtime_job_resume_for_project(project, enabled, request, now)`
  - request: `{ jobId }`，新增 request struct 必须 `deny_unknown_fields`。
  - allowed state: `paused`。
  - update `state='queued'`, `queued_at_ms=now`, `updated_at_ms=now`。
  - other states reject `invalid-transition`。

## Tests

Rust:

- disabled pause/resume do not touch damaged runtime DB。
- enabled no-project pause/resume return `no-project`。
- queued pause -> paused -> resume -> queued。
- running pause releases active lease as cancelled and old lease complete/fail/heartbeat is rejected。
- pause rejects completed / failed / cancelled / retry-wait。
- resume rejects non-paused states。
- job list after pause/resume shows expected states and leases。
- pause/resume request shapes reject unknown fields such as `root` / `dbPath` / `projectPath`。

TS/React:

- `src/commands/runtime-db.ts` wrappers call expected Tauri command names and preserve typed request shape。
- RuntimeJobsSection component tests are required, not optional helper-only tests。
- Component tests cover poll cleanup, legal action visibility by state, command failure compact error, disabled/no-project no destructive controls, and no `runtime_db_health` call during mount/poll。
- ActivityPanel integration test or focused render test verifies collapsed status priority when runtime is the only active/error source。
- Component tests cover runtime list error in both expanded compact error row and collapsed priority text/icon。
- i18n parity passes for new keys。

UI verification:

- Run relevant component tests if present; otherwise add focused Vitest tests around rendering helpers.
- If visual interaction becomes non-trivial, run local dev server + Playwright screenshot for ActivityPanel expanded state.

## Gate / 调度

PR7 开工 gate：

- Commander 先写本计划。
- Architect 对抗审查重点：
  - pause/resume 是否越过 PR7 UI 范围。
  - running pause lease invalidation 是否与 cancel 语义冲突。
  - UI 是否违反 SPEC-1 shell/core boundary。
  - polling 是否会在 runtime disabled/no-project 时触碰 DB。
  - ActivityPanel 是否变得过载。
- 外部 agent 优先 Claude ACP；Claude preflight 失败则 fallback 到 ZCode/Kimi + 内部 Architect。
- timeout/incomplete 不算 PASS。

实现前：

- GitNexus impact 必跑：
  - `runtime_job_cancel_for_project`（复用 state validation/lease invalidation 模式）
- `runtime_job_list_for_project`
- `open_job_runtime_locked`
- `run` in `src-tauri/src/lib.rs`
- `ActivityPanel`
- `RuntimeJobsSection` is new; upstream impact empty/unknown is expected.
- HIGH/CRITICAL 记录 blast radius，再实现。

合并前：

- `cargo test runtime_db --manifest-path src-tauri/Cargo.toml`
- focused TS/Vitest tests for runtime command wrappers and ActivityPanel UI。
- `pnpm lint`
- `git diff --check`
- `cargo build --release --manifest-path src-tauri/Cargo.toml`
- `npx gitnexus detect-changes --repo llm_wiki`
- Tester/Reviewer gates；UI 改动如有可视状态，保留截图或 DOM evidence。

## 当前 Commander 判断

PR7 应该是“最小可操作 runtime visibility”，不是完整 scheduler UI。为了满足 SPEC 的 pause/resume/cancel，后端必须补齐 pause/resume；但 UI 只调用 runtime commands，不引入新 store ownership。ActivityPanel 是最小落点，避免新增一个大页面。

## Follow-up

- 统一审查既有 job-lifecycle request structs 是否全部加 `deny_unknown_fields`；PR7 只对新增 pause/resume 收严，不回改旧 request。
- 后续维护 PR 可把 ActivityPanel collapsed head 的 status/icon/error 优先级收敛为单一 helper；PR7 只为 runtime error/active 增加最小 priority path。
