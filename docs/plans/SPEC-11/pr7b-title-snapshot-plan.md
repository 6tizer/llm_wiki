# SPEC-11 PR7b 执行计划：外部删除链 title 快照（chain B title-form wikilink 漏清修复）

> 类型：PR 级执行计划 | 状态：ready for implementation | 归属：SPEC-11 closeout follow-up | 轨道：maint | 分支：codex/maint-pr7b-title-snapshot | 创建：2026-07-04（只读调查完成后落此计划）

## 根因（调查已确认，file:line 为 main tip 13231884）

- `cleanupDeletedWikiPagesUnlocked`（`src/lib/source-lifecycle.ts:432-442`）对已删页面硬编码 `title: ""`，`buildDeletedKeys`（`src/lib/wiki-cleanup.ts:61-68`）因此永远只有 slug 形式 key，title 形式 wikilink（如 `[[Key-Value Cache]]`）漏清。
- 结构性缺口：删除事件链（`file_sync.rs:646 enqueue_rescan_changes` → `:735 enqueue_paths` → `:774 upsert_task` → Tauri 事件 → `project-file-sync.ts:238 cleanupDeletedFiles` → `source-lifecycle.ts:417`）中**没有任何一跳的数据结构存过 title**；`read_meta`（`file_sync.rs:996-1022`）对已删除文件返回 `Ok(None)`，内容早已不可读。
- 对照 chain A（`wiki-page-delete.ts:183-207`）：应用内删除是「先读 title 再删文件」，无此问题。

## 方案（选定：方案 1 — title 进 Rust snapshot 持久化）

唯一能覆盖「应用未运行期间外部删除、重启后 rescan 才检测到」场景的方案（snapshot 跨进程持久化）。已排除：从 derived 数据反查（LanceDB/搜索/图谱均为现读现算，无持久化 path→title 映射）；模糊匹配兜底（会重新引入 wiki-cleanup.ts:16-20 已修复的 Bug B 误伤）。

改动面：

1. `src-tauri/src/commands/file_ops/file_sync.rs`
   - `FileMeta`（L85-88）新增 `title: Option<String>`，**必须 `#[serde(default)]`** 保证旧 `.llm-wiki/file-snapshot.json` 向后兼容。
   - `read_meta`（L996）：仅对 `wiki/**/*.md` 且文件存在时，读内容提取 frontmatter title（复用/迁移 `search.rs:613 extract_title` 逻辑；注意 read_meta 已为 hash 读过文件字节，避免读两次）。
   - `upsert_task`（L774-828）：比照 `hash_before` 模式新增 `title_before: old.and_then(|m| m.title.clone())`，随 `FileChangeTask` 下发。
2. `src/commands/file-sync.ts`（L8-15）：`FileChangeTask` 类型加 `titleBefore?: string`。
3. `src/lib/project-file-sync.ts`（`cleanupDeletedFiles` L238-268）：按 path 组装 `Map<relPath, title>` 传入。
4. `src/lib/source-lifecycle.ts`（L417/426）：`cleanupDeletedWikiPages(Unlocked)` 增加可选 titles 入参，替换硬编码 `""`；不传则退化为现行为（其余调用点零改动）。

失效场景（可接受）：title 改动后未被重扫即删除 → 用稍旧 title（优于空串）；snapshot 损坏 → 退化为现状。

存量 snapshot 回填修复（gate 反馈后追加）：升级前已建立的 snapshot 条目没有 `title` 字段（反序列化为 `None`），若对应 wiki 页面升级后从未再被修改，`enqueue_paths` 的 hash/size-unchanged 分支永远不会生成任务，也就永远不会有机会把 `title` 写回 snapshot——外部删除时复现的正是本 PR 要修的 bug。修复：`enqueue_paths`（file_sync.rs `enqueue_paths`）在 hash/size 未变、判定"无需生成任务"的分支里，若 `new.title != old.title`（典型为 legacy `None` → 现读 `Some(...)`），记录待回填项；整轮 rescan 结束后在一次 `with_queue_lock` 事务里合并回填并调用既有的 `read_snapshot`/`write_snapshot` 落盘一次（不新增写路径、不逐文件落盘）。

剩余窗口（仍然接受）：升级后**第一次 rescan 之前**就被外部删除的页面——`read_meta` 对已删除路径返回 `None`，没有磁盘内容可读，也没有机会跑到上面的回填分支，`title_before` 只能沿用 legacy snapshot 里的 `None`，此时退化为仅按 slug 清理（即本 PR 修复前的行为）。这是持久化快照方案在“应用未运行期间外部删除、且此前从未做过带 title 字段的 rescan”这一交叉场景下的固有限制，非本次改动引入的新缺口。

## 测试

- `source-lifecycle-cleanup-chains.characterization.test.ts` 21c：从「断言 bug 存在」反转为正向用例（title-form wikilink 被清理），同步改写文件头 bug 说明注释。
- 21b 追加回归护栏：不传 `titles` 时 title-form wikilink 原样保留（锁住旧行为兜底路径）。
- 其余 21a、21d-21h 用例不动（可选参数不传即旧行为）。
- Rust 侧：`FileMeta` serde 向后兼容测试（旧 JSON 无 title 字段可反序列化）+ `read_meta` 对 wiki md 提取 title 的单测（`read_meta_extracts_frontmatter_title_for_wiki_markdown` / `read_meta_does_not_extract_title_for_non_wiki_markdown`）。
- Rust 侧（gate 反馈后追加）：`deleted_wiki_page_task_carries_title_before_from_snapshot`（Deleted 任务的 `title_before` 来自旧 snapshot 而非现读）、`upsert_task_merge_branch_preserves_title_before_from_first_insert`（merge 分支不覆盖首次插入时记录的 `title_before`）、`legacy_snapshot_title_is_backfilled_on_unchanged_rescan_then_survives_to_delete_task`（存量 legacy snapshot 回填 + 回填后删除仍带 title）。
- TS 侧（gate 反馈后追加）：`project-file-sync.test.ts` 新增一条走真实 wiring 的集成测试——`file-sync://changed` 派发 wiki 路径的 deleted 任务（带 `titleBefore`），断言兄弟页面的 title-form wikilink 被真实清理。
- `extract_title` 复用（gate 反馈后追加）：`file_sync.rs` 不再自建 `extract_wiki_title`，直接 `use crate::commands::search::extract_title`，避免与 `search.rs:613` 逐字节重复。

## Gate（lane 判定）

full lane（碰 Rust file_sync 持久化结构 + 跨 Rust/TS 契约）。主力 gate：内审 + focused tests；副：外部 reviewer。runtime verify：真实项目里外部删除一个带 title-form 引用的页面，观察引用被清理。

## 提交前

`npm run typecheck`（tsc --build）、`cargo test` file_sync 相关、`/usr/bin/git diff --check`、`npx gitnexus detect-changes -r llm_wiki-dataint --scope staged`、`orphan-check.sh main`。
