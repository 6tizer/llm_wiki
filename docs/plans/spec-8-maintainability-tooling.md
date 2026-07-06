# SPEC-8: Maintainability / Tooling / QA Fixture

> 类型：阶段 SPEC | 状态：**completed（2026-07-06，11 PR：#343/#346/#349/#356/#358/#360/#364/#365/#366/#367/#368；closeout 报告见 [SPEC-8/closeout-report.md](./SPEC-8/closeout-report.md)，deferred 项与 P3 长尾随 #183 追踪）** | 覆盖：#183、#182 + `spec-5-8-post-review-findings.md` 五（精简清单）
>
> 范围勘误（closeout）：第 11 项 StatusPill 去重子项作废（组件已在更早重构中消失）；「需先补测试」5 项 deferred；第 10 项 schema init 缓存/事务内部收敛/profiles 引用计数 deferred（#356「语义存疑不动」裁定）。

## 2026-07 Review 补充（必读）

深度 review（见 `spec-5-8-post-review-findings.md`）对本 SPEC 有三处修正：

- **`api_server.rs` "重构"担忧被夸大**：`handle_request`（236-304）是干净的集中式路由表（8 分支 match），鉴权在 match 之前判定一次，无 handler 自带鉴权分支，结构上不存在"某条路由漏挂鉴权"。因此该项从"重构"**降级为保行为的机械 `mod` 拆分**（dispatch/auth/CORS 留 mod.rs，projects/graph/reviews 分文件），顺带修 percent_decode 字符边界 panic（新增路由测试会踩到）+ 抽 `resolve_project_or_404`（6 处重复）+ 413/500 改类型化错误。不重写已正确的鉴权设计。
- **`autoIngestImpl` characterization tests 与 SPEC-11 是同一批工作**：测试目标聚焦 cache-hit / cache-miss / abort-mid-write / cancel-during-processing 四条路径（D4 与 cancelTask 竞态藏在此），须与 SPEC-11 协调 owner，先合并、不重复。
- **新增大量机械精简项**（见下方新增 PR）：这些是 review 发现的重复/死代码，多数是安全机械替换，少数需先补测试。

## 关键决策补充

- 精简项按"安全机械替换"与"需先补特征化测试"分层：前者可直接做，后者（`autoIngestImpl`、`writeFileBlocks`/`executeIngestWrites`、`sweepWikiReferences`、lint fix 函数、web-search provider）先锁行为再动。
- `i18n-parity.test.ts` 只校验 en/zh 互相一致，缺"代码引用的 key 必须存在"断言（`common.dismiss` / `fileTree.*` 因此漏检）；补该断言归本 SPEC。

## 目标与成功标准

收纳不会改变产品方向、但会提升后续开发可靠性的维护性重构、测试债和工具链问题。

成功标准：

- #183 的非安全维护尾项被拆成低风险 PR。
- #182 的 GitNexus TSX scope warning 有明确 root-cause 或非阻塞记录。
- QA fixture 入口/可重复性工具支撑 SPEC-7 的 Agent 场景回归，至少覆盖 permission、profile unavailable、SDK model rejected、resource limit、timeline；具体 Agent 场景 owner 仍是 SPEC-7。
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
7. #86 QA fixture infrastructure：提供 dev-only 入口和可重复性工具；支持稳定触发 permission、profile unavailable、SDK model rejected、resource limit、timeline；SPEC-7 负责具体 Agent 场景覆盖。
8. SPEC-1 cleanup candidates：拆 `App.tsx` 非 UI bootstrap（`setupAutoSave`/`startClipWatcher`、update-check、`init()` 配置 hydration、`handleProjectOpened` 项目切换编排——对应 `bootstrap-boundary.ts` 已登记候选）、store/runtime state 混用、Tauri store 直接耦合；每项独立 PR，必须证明 behavior unchanged。
9. **`api_server.rs` 机械 mod 拆分**（保行为，非重写）：dispatch/auth/CORS 留 mod.rs，projects/graph/reviews 分文件；顺带修 percent_decode 字符边界 panic、抽 `resolve_project_or_404`、413/500 类型化错误、删 CORS 短路死代码。
10. **Rust 机械精简**（约省 500+ 行）：`runtime_db.rs` 命令包装 helper（`run_project_write`/`run_project_read`）+ 缓存 schema init + `read_rows_tx` 泛型 + staging 路径 helper；`vectorstore.rs` `open_table_if_exists`/`with_project_lock`；`codex_cli.rs`/`claude_cli.rs` 8 处重复合并到 `cli_resolver.rs` + 共享受管理子进程模块；`fs.rs` 拆 `office_extract.rs`；`path_safety.rs`/`extract_images.rs` 沙箱实现合并（与 SPEC-10 S1 同点）；`clip_server.rs` CORS 响应 helper。
11. **TS 机械精简**：`flattenMdFiles` 四处统一、dedup 规范化 key 三处统一、`fnv1a64Hex` 统一、`isDuplicateRuntimeJobError` 两处统一、`appendWorkerProgress`/`appendProgress` 统一、`apiConfig` 默认值常量、`boundary-check.ts:43-46` 死规则删除、`ClaudeCliStatusPill`/`CodexCliStatusPill` 与 ReactMarkdown 覆写去重。需先补测试的：`web-search.ts` `fetchSearchApi`、`mineru.ts` `pollUntilDone`、`lint-fixer.ts` `runMultiPageFix`/`withLintActivity`、`sweepWikiReferences`、`commit-integration` 与 `markdown-commit/index` 两套提交后处理二选一。
12. **i18n 修复 + parity 断言**：修 `common.dismiss`（`graph-view.tsx:1745`）、`fileTree.*`（`file-tree.tsx`）缺失 key；给 `i18n-parity.test.ts` 补"代码引用 key 必须存在于两个 bundle"断言。

13. **P3 known-minor backlog 收纳**：`spec-5-8-post-review-findings.md` 第八节的 P2/P3 长尾（健壮性/性能/死代码/资源泄露：vectorstore 锁淘汰与 optimize 阻塞、search 全量重扫、runtime_db migration 版本未分支、error 响应未转义、mineru/web-search/wiki-synthesis 未包裹解析、graph-view 缓存/RangeError、project-store 死代码等）。除标注归 SPEC-10（安全）/SPEC-11（数据）的项外，默认在本 SPEC 收纳——随相邻主 PR 顺带修，或按子系统单列低风险 PR；不要求一次清空，但每项须在对应主 PR 的 detect/review 中确认未回归。

> 注：`persistSetting` helper、`useProjectPersistedResource` hook、per-item 状态 store 虽也是"消重复"，但它们同时修复 SPEC-11 的数据丢失 bug，owner 归 SPEC-11，本 SPEC 不重复。

## 验证策略

- 每个维护 PR 单独 focused tests + lint + diff check + GitNexus detect。
- 重构 PR 必须证明 behavior unchanged。
- GitNexus warning PR 必须记录 analyzer result before/after。
- QA fixture PR 必须有 repeatable UI test 或 dev-only entry，且不得把真实 SDK secrets、jsonl 私有路径或 provider API key 写入快照。

## Gate 结论摘要

本 SPEC 随当前 docs PR 通过 PR-level gate；详见 [SPEC-0](./spec-0-roadmap-baseline.md) 的 PR Gate 结论统一摘要。实现 PR 必须重新审查 #182 是否仍可复现、`autoIngestImpl` characterization tests 是否先合并、QA fixture 与 SPEC-7 的 owner 边界，以及 SPEC-1 cleanup 是否无行为变化。

## Non-goals / Follow-up

- 不把 #183 与 runtime 大重构绑在一个 PR。
- 不把 #182 当作应用 bug 修，除非 root cause 指向本地文件结构。
- 不新增产品能力。
