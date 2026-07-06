# SPEC-8 Closeout 报告（2026-07-06）

> 结论：**SPEC-8 completed**。11 个实现 PR 全部合并（#343/#346/#349/#356/#358/#360/#364/#365/#366/#367/#368）；closeout 深度 review 两维度（范围完备性对账 + 跨 PR 组合面）零 P0/P1；行为无变化抽查全绿。deferred 项与 P3 长尾见 §4/§5。

## 1. PR 清单与范围映射

| PR | 内容 | SPEC 项 |
|---|---|---|
| #343 | api_server 路由/鉴权 characterization tests（51） | 2 |
| #346 | api_server 机械 mod 拆分 + percent_decode panic 修复 + resolve_project_or_404 + 413/500 类型化 | 9 |
| #349 | CLIP_SERVER_PORT 单一真源 + CORS helper | 1、10（部分） |
| #356 | runtime_db/vectorstore 机械收敛（−91 行） | 10（部分） |
| #358 | cli_resolver 合并、fs.rs 拆 office_extract、沙箱实现统一 | 10（部分） |
| #360 | autoIngestImpl 五段拆分（含 characterization tests）+ TS 机械精简批 | 3、4、11（部分） |
| #364 | runAgentAppToolHandler 28-handler map + i18n 缺 key + parity 断言 | 5、12 |
| #365 | #86 QA fixture 五场景（含 rewind gate 三真实拒绝态） | 7 |
| #366/#367/#368 | App.tsx bootstrap 三段抽取（mount services+update-check / init hydration / useProjectLifecycle） | 8 |

相关 issue：#86 closed（fixture 落地）；#182 closed（复核不复现）；#183 保持 open 追踪 P3 长尾（已留言对账）。

## 2. 跨 PR 组合面深审（main@34c902ae，零 P0/P1）

- **App.tsx 三段抽取叠加**：useProjectLifecycle 不含 useEffect，effect 注册顺序（mount-services→zoom→dev-banner→dev-fixture→update-check→init）与拆分前逐位一致；init effect 首渲染闭包捕获语义等价。
- **契约测试真实性**：52 tests 全绿；**破坏性验证**——刻意对调 resetProjectState/loadAgentResourceConfig 顺序，顺序不变量断言真实变红（已还原），证明迁移后断言非空转。
- **#364×#365**：fixture 只操作 store，与 handler map 运行时解耦；28 工具名迁移前后逐一比对一致。
- **i18n parity**：AST 全仓扫描式断言，天然覆盖后续 PR 新增 t() 调用，全绿。
- **Rust 锁域**：vectorstore with_project_lock（tokio，按项目分片）与 runtime_db 全局写锁（std）完全独立，无嵌套调用，无锁序组合面。
- **行为无变化**：`cargo test --lib` 558 passed / 0 failed；前端全量 2977 passed（12 个"失败"文件均为 target/dist 构建产物误扫 + provider-migration-banner 已知时序 flake #353，单跑 20/20 绿，且该文件未被任何 SPEC-8 commit 触碰）。

## 3. Closeout 顺带修复

- `flattenMdFiles` 第 4 处残留副本（knowledge-tree.tsx，与 wiki-utils.ts 逐字相同）——范围对账新发现的第 11 项遗漏，本 PR 内 dedup（改 import 共享真源），组件测试 79/79 绿。

## 4. Deferred 项（正式记录，原先只在 PR body）

1. **「需先补测试」5 项**（web-search `fetchSearchApi`、mineru `pollUntilDone`、lint-fixer `runMultiPageFix`/`withLintActivity`、`sweepWikiReferences`、commit-integration 与 markdown-commit 两套二选一）：deferred——改动前需先补 characterization tests（SPEC 关键决策预判的分层）；#360 Non-goals 已声明，本报告为正式记录，随 #183 追踪。
2. **Rust 精简剩余**（schema init 缓存、`*_for_project` 事务内部收敛、profiles.rs 引用计数）：deferred——#356 裁定「语义存疑一律不动（宁少精简）」。
3. **StatusPill 去重**（ClaudeCliStatusPill/CodexCliStatusPill）：陈旧记录——组件已在更早重构中消失，非本轮工作，SPEC 第 11 项该子项作废。
4. **api_server `"truncated"` 恒为 false**：部分修复澄清——413/500 类型化已做，truncated 字段本身未修（归 P3 长尾）。
5. **setupAutoSave StrictMode 双订阅**、**update-check `checking` 可能 stuck**：存量行为有意保留（#366 保行为纪律），归 P3 长尾。

## 5. P3 长尾对账（已知悉、有意搁置、非本轮回归）

来源=spec-5-8-post-review-findings.md 第八节，仍开放项（风险较高的前三项 #356 body 已明示知悉不动）：

- **较高关注**：vectorstore `PROJECT_LOCKS` 永不淘汰；`vector_optimize_chunks` 持锁全量 optimize 阻塞；runtime_db migration 版本未分支决定步骤
- Rust 侧：search MAX_SEARCH_FILES 只计 .md、tokenize_query 无上限、legacy vector_upsert 空 embedding、top_k 无 cap、job_id 空串、staging TOCTOU、set_proxy_env 未走 run_guarded
- TS 侧：mineru/web-search/wiki-synthesis 未包裹 JSON 解析（与 deferred-1 同批）、lint-fixer 错误对象未绑、project-file-sync 重复清理、dedup-storage 非原子读改写、App update-check stuck、handleSwitchProject 冗余调用、project-store 疑似死代码、graph-view 缓存/RangeError/worker onerror、wiki-editor 空编辑写盘、runtime-jobs-section 卸载后 setState
- 归属他 SPEC：source-lifecycle TOCTOU、normalizeWikiRefKey 别名冲突（SPEC-11）

## 6. 教训

- **机械 dedup 的「第 N 处」要用全仓 grep 收口**，不能依赖清单列出的处数（flattenMdFiles 列了「四处」，实际漏了第 4 处的副本判定）。
- **deferred 决策必须离开 PR body 落到 SPEC/issue**，否则 closeout 前技术债无主（本次 5+3 项全部在 closeout 补记）。
- 契约测试迁移类改动，closeout 应做一次破坏性验证（改 token 看红）防断言空转——本次实证有效。
