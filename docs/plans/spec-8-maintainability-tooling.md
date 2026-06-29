# SPEC-8: Maintainability / Tooling / QA Fixture

> 类型：阶段 SPEC | 状态：reviewed / ready for PR split | 覆盖：#183、#182

## 目标与成功标准

收纳不会改变产品方向、但会提升后续开发可靠性的维护性重构、测试债和工具链问题。

成功标准：

- #183 的非安全维护尾项被拆成低风险 PR。
- #182 的 GitNexus TSX scope warning 有明确 root-cause 或非阻塞记录。
- QA fixture 入口/可重复性工具支撑 SPEC-7 的 Agent 场景回归；具体 Agent 场景 owner 仍是 SPEC-7。
- 维护 PR 不混入 runtime / provider / commit layer 行为变化。
- 维护 PR 支撑 SPEC-1 shell/core boundary：逐步清理 `App.tsx` bootstrap side effects、Zustand business coupling、Tauri plugin-store coupling。

## 关键设计决策

- 维护工作可以穿插，但不能阻塞 SPEC-1/2/3/4 架构收敛。
- `autoIngestImpl` 重构必须先锁行为测试；这些 characterization tests 是独立 PR，不是重构 PR 的顺手步骤。
- SPEC-5/6 如需触碰 `autoIngestImpl`，必须先等待 characterization tests 合并；否则 SPEC-8 相关 PR 应让路给 runtime 主线，不反向阻塞架构 PR。
- `api_server.rs` auth route 测试优先于无行为变化重构。
- GitNexus warning 先用 `npx gitnexus analyze --force` 复现；若当前版本不再复现，在 #182 记录并关闭/标记 resolved。若仍复现且 root cause 是 analyzer provider，记录/上游处理；不为了 silence warning 乱改测试结构。

## 预期 PR 拆分

1. P2-10：抽 `CLIP_SERVER_PORT` 常量。
2. P2-12：补 `api_server.rs` route dispatch + auth gating tests。
3. `autoIngestImpl` characterization tests：cache-hit、source-summary identity、index/overview current behavior、embedding side effects；先独立合并。
4. P2-8/P2-11：在 characterization tests 保护下拆 `autoIngestImpl`。
5. P2-9：`runAgentAppToolHandler` handler map 重构。
6. #182：先强制重建复现 GitNexus TSX warning；再决定 workaround / upstream note / close as resolved。
7. #86 QA fixture infrastructure：提供 dev-only 入口和可重复性工具；SPEC-7 负责具体 Agent 场景覆盖。
8. SPEC-1 cleanup candidates：拆 `App.tsx` 非 UI bootstrap、store/runtime state 混用、Tauri store 直接耦合；每项独立 PR，必须证明 behavior unchanged。

## 验证策略

- 每个维护 PR 单独 focused tests + lint + diff check + GitNexus detect。
- 重构 PR 必须证明 behavior unchanged。
- GitNexus warning PR 必须记录 analyzer result before/after。
- QA fixture PR 必须有 repeatable UI test 或 dev-only entry。

## Gate 结论摘要

本 SPEC 随当前 docs PR 通过 PR-level gate；详见 [SPEC-0](./spec-0-roadmap-baseline.md) 的统一 gate 摘要。实现 PR 必须重新审查 #182 是否仍可复现、`autoIngestImpl` characterization tests 是否先合并、QA fixture 与 SPEC-7 的 owner 边界，以及 SPEC-1 cleanup 是否无行为变化。

## Non-goals / Follow-up

- 不把 #183 与 runtime 大重构绑在一个 PR。
- 不把 #182 当作应用 bug 修，除非 root cause 指向本地文件结构。
- 不新增产品能力。
