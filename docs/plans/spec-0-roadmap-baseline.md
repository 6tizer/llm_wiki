# SPEC-0: Roadmap Baseline 收口

> 类型：阶段 SPEC | 状态：reviewed / ready for PR split | 覆盖：docs/plans、#184-#191、#182/#183

## 目标与成功标准

把当前 roadmap、计划文档和 GitHub issue 拓扑校准到真实基线，作为后续 SPEC 和实现 PR 的入口。

成功标准：

- `docs/plans/README.md` 是当前执行顺序的 canonical 入口。
- 完成/历史计划只作为 archive evidence，不再驱动后续开发。
- #190 替代 #3/#65 的旧 Phase 7 入口；#3/#65 不再出现在 active backlog。
- #184-#189/#191 进入并行 runtime 主线；#190 进入 Unified Agentic Chat 主线；#183/#182 进入维护主线。
- native-ready architecture boundary 进入当前主线；Swift shell 实现仍 deferred，由 SPEC-9 承接回填。

## 关键决策

- 当前不直接进入 Phase 7，也不重开 OKF/KW 串流。
- 后续主线从 “并行加速平台重构” 开始，先定 SPEC，再拆 PR。
- `index.md` / `overview.md`、旧 ingest runtime、旧 Chat/Agent/Ingest 三入口都不能作为默认新产品目标。
- SPEC-1 先拆 UI shell / Core Runtime / Platform Adapter 边界，避免后续 runtime 继续绑定 Tauri/React。
- Swift/native 实现不进入近期执行，但 SPEC-9 作为明确回填锚点；不是无限期空泛 deferred。
- 执行顺序的 canonical 来源是 `docs/plans/README.md` 的 Current Execution Order；本 SPEC 只描述 roadmap 基线，不复制维护另一套顺序。
- SPEC-1 PR1（shell/core boundary ADR + runtime command/event inventory）是后续 runtime/commit/profile integration 的硬门槛；SPEC-2 PR1（runtime schema + state-machine ADR）合并前，SPEC-3/4 只能做不依赖 runtime schema 的准备工作。
- 允许的 parallel preparation 仅限 docs、ADR、接口草案和只读调研；任何触碰 shared runtime types/schema、持久化 runtime state 或 core API implementation 的代码 PR 必须等待对应 gate 合并。

## 预期 PR 拆分

1. Docs closeout PR：归档历史 plans、更新 README、修正 `agent-sidecar-phase6.1.md` 的 #3/#65 旧状态。
2. SPEC docs PR：新增并定稿 SPEC-1 到 SPEC-9。
3. 后续每个 SPEC 再独立拆 implementation PR。

## 验证策略

- `rg -n "#3|#65" docs/plans --glob "!**/archive/**"`
- `rg -n "#184|#185|#186|#187|#188|#189|#190|#191|SPEC-|Current Execution Order|archive" docs/plans`
- `pnpm lint`
- `git diff --check`
- `npx gitnexus detect-changes --repo llm_wiki`

## PR Gate 结论统一摘要

- Architect：Claude ACP via CC Switch Pioneer / `claude-opus-4-8` 初审 WARN、focused recheck PASS；初审 P1/P3 已同 PR 清理，拒绝的写文件尝试记为 contract violation。
- Tester：Kimi 初审 WARN、focused recheck PASS；被拒绝的 `Write` / `ExitPlanMode` / `AskUserQuestion` 记为 WARN，不当作 PASS，实际 P1/P2/P3 已同 PR 清理。
- External Reviewer：ZCode 初审 PASS with P3、focused recheck PASS；P3 已同 PR 清理。
- Internal Reviewer：WARN with P3 only；P3 已同 PR 清理，无 unresolved P0/P1/P2。
- #192 docs PR 的 gate 是 PR-level gate；SPEC-1 到 SPEC-9 共享该 gate 结论。后续 implementation PR 必须重新按对应 SPEC 跑 impact、focused tests、detect 和 external/internal review，不能复用本 docs PR 的 gate 作为代码验收。

## Non-goals / Follow-up

- 不实现 runtime、provider、Agent UI 或 ingest 改造。
- 不关闭 #184-#191。
- 不实现 Swift shell；Swift 回填由 SPEC-9 作为 gated follow-up 承接。
