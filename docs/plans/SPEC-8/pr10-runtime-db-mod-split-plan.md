# SPEC-8 PR10 执行计划：runtime_db.rs 保行为 mod 拆分

> 类型：PR 级执行计划 | 状态：plan complete / ready for implementation | 轨道：maint | 分支：codex/maint-pr10-runtime-db-split | lane：full（机械但触碰 shared runtime）| 创建：2026-07-04 | 窗口：SPEC-6 PR1 已 merge（9a1f2fd6）、PR2 为 TS 侧——**必须在 SPEC-6 PR3 前合并**

## 目标与原则

`src-tauri/src/commands/runtime_db.rs`（19956 行，含 mod tests 10061 行）拆为 `runtime_db/` 目录 13+1 模块。**保行为零语义变化**：不改任何函数体逻辑、不改 schema、不改错误码；只做物理移动 + 最小可见性提升。

## 模块划分（行号测绘见调查，基线 9a1f2fd6）

`mod.rs`（常量+全部 DTO struct+RUNTIME_DB_WRITE_LOCK+子模块声明+`pub use *` 回导）；`schema.rs`（连接/init/migration/health ~890）；`validate.rs`（通用校验 helper ~150）；`txhelpers.rs`（claim/lease tx 原语 ~150）；`jobs.rs`（~950+测试~1750，含 terminal_running_operation/ensure_job_exists）；`scheduler.rs`（lease 超时/回收 ~300+~500）；`commit_budget.rs`（~450+~900）；`events_progress.rs`（~350+~450）；`staging.rs`（~1170+~1050）；`markers.rs`（~700+~1750）；`profiles.rs`（~550+~900）；`profile_pool.rs`（~920+~1900）；`probe.rs`（probe+model-call-forward ~1060+~830）；`redact.rs`（~510+~600）；`test_support.rs`（#[cfg(test)]：temp_project/read_migration/fake SecretStore/跨域 request-builder，pub(crate)）。

兼容机制 = 仓库既有先例（commands/search、file_ops、agent_cli）：`mod.rs` 里 `pub use submodule::*;` 通配回导，`commands/mod.rs` 的 `pub mod runtime_db;` 与 lib.rs 40+ 处 `generate_handler!` 引用、agent_cli 三文件的 `runtime_db::SecretRedactor` 等 pub(crate) 引用全部零改动。

## 执行规则（Coder 硬约束）

1. **用行号范围的 shell 提取（awk/sed）做物理移动，不要靠重新输入代码**——20k 行靠手写必然引入意外改动。移动后编译驱动补 `use`/可见性。
2. 可见性最小化：只有被 ≥2 业务域跨文件调用的才 `pub(crate)`（预计 60-80 个）；单域自用 SQL/mapper/read 保持 private 随域走；`#[tauri::command]` 保持 `pub` 原样；既有 pub(crate) 项（SecretRedactor/AgentRunProfileConfig/DERIVED_REBUILD_JOB_KIND 等）原样保留且必须在回导覆盖内。
3. 跨域共享一律进 schema/validate/txhelpers/redact 四个基础设施文件；业务域文件之间不得出现同名 pub(crate) 项（通配回导会撞）。
4. `#[allow(dead_code)]` 标注（runtime_commit_budget_expire_for_project 等）随函数一起搬，不许漏。
5. tests：先把共享 fixture 下沉 test_support.rs，再按域边界（调查已测绘：测试本就按域连续排列）切给各域文件的 `mod tests`；**不许复制多份 temp_project**。
6. 分步 commit 同一 PR：基础设施三件套 → 逐业务域 → struct/const 收尾 → tests。
7. 搜索用 `/usr/bin/grep`（rtk 会重排/丢 grep 输出，本轮实证）。

## 验证（characterization 纪律）

- 拆分前记录 `cargo test --manifest-path src-tauri/Cargo.toml` 的**完整测试名单**（~490 lib，含本文件 211）存到文件作基线。
- 拆分后：`cargo build` 零新 warning；`cargo test` **名单逐一比对**（不只总数）；`cargo fmt --check`；`npm run typecheck`（应零影响）。
- diff 审查：`git diff --color-moved=zebra --color-moved-ws=allow-indentation-change`（一拆多无 rename 标记是预期）；净增行应很小（use/mod 声明 + pub(crate) 关键字）。
- `detect-changes` 预期形态：大量符号 file 属性变化（移动噪声）+ 零调用边/签名变化；出现任何签名/调用边变化即真回归。合并后需全量 reanalyze（非增量）重建基线。

## Gate

lane：full。主力 gate：Codex Architect（机械拆分/接口一致性域）+ characterization 名单比对；Simplicity 重点卡「可见性开得比需要宽」；内审抽查 3-4 个模块的移动保真度（color-moved）。
