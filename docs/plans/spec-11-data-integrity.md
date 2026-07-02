# SPEC-11: Data Integrity Hardening / 数据完整性加固

> 类型：阶段 SPEC | 状态：reviewed / ready for PR split | 覆盖：`spec-5-8-post-review-findings.md` 二（D1-D8 数据丢失 P0，D8 即 settings 静默保存）+ 三（数据丢失/一致性 P1） | 依赖：SPEC-1 store boundary、SPEC-3 commit layer | 执行顺序：与 SPEC-10 并行；D1-D3 建议高优先级，先于 SPEC-6/7 实现

## 目标与成功标准

修复深度 review 发现的用户可见数据丢失与一致性缺陷。这些 bug 分布在 ingest / lint / dedup / source-lifecycle / editor / settings 等"数据写入"路径，多数当前就会触发、且不在既有 SPEC 覆盖范围，会侵蚀"Markdown 是 source of record"这一核心承诺。SPEC-6/7 将在这些路径之上构建，必须先止血。

成功标准：

- 切换项目不再清空旧项目的 review 标注与会话历史；延迟保存要么在切项目前取消/flush，要么写入前重新校验目标仍是当前项目。
- 编辑器自动保存按文件隔离，切文件时不清理/串写；不同文件的防抖写入不再互相覆盖损坏。
- 恶意/异常输入（非表格 `|` 行）不再让分块死循环冻结渲染进程。
- 取消/暂停摄取任务只撤销本任务的贡献，不整页删除被合并进已有内容的页面。
- 聊天 "Save to Wiki" 走与正常 ingest 同等的合并/备份/slug 去重/schema 校验，不再整页覆盖用户手工编辑。
- lint / dedup 的 LLM 输出在整页覆盖或删除前经过完整性校验（非空、frontmatter 可解析、长度 sanity），空/截断/拒绝输出不再把页面清空或写垃圾；orphan（info 级）不再被自动删除；autofix 各入口共享同一把锁。
- 跨目录同名文件不再仅用裸文件名做 slug key，合并/删除作用到正确文件。
- `index.md`/`log.md` 的读改写通过 `withProjectLock` 协调，与 autoIngest 并发不再互相覆盖；删除失败不再执行引用清理、不再中止整批。
- Settings 保存失败有明确错误反馈（非静默 `catch(()=>{})` + 无条件"已保存"），含 Rust-locked 键的多步保存失败不产生内存态与磁盘真值分叉。
- App 启动 hydration 分步隔离失败，单步出错不再静默跳过"打开上次项目";项目打开有并发保护。

## 关键设计决策

- 只修数据一致性 bug，不改变 ingest/commit 的产品语义；不新增功能。
- **优先抽出统一的"乐观写 store + 可能失败的持久化 + 失败回滚/用户可见提示" helper**（如 `persistSetting(set, save, value, {onError})`）——review 确认这套模式在代码库无一处正确实现（18+ 处静默丢失即证据），且 SPEC-6 的 `building→ready/failed` 状态转换本质同型，先抽 helper 可一并堵住现有 bug 并为 SPEC-6 铺路。
- 涉及 `autoIngestImpl`、`writeFileBlocks`/`executeIngestWrites`、`sweepWikiReferences` 的改动**必须先合并 characterization tests 再动**（characterization tests 是独立 PR，不是重构顺手步骤）；测试目标聚焦 cache-hit / cache-miss / abort-mid-write / cancel-during-processing 四条路径，D4 与 cancelTask 竞态就藏在此。此约束与 SPEC-8 的 `autoIngestImpl` characterization tests 是同一批工作，需与 SPEC-8 协调 owner，避免重复或互相阻塞。
- `executeIngestWrites` 修复优先方式是委托给 `writeFileBlocks` 薄封装，一次改动同时消 D5 与重复实现。
- store 层为需要 per-item 异步状态的场景，参照 `research-store.ts` 的任务数组 + status 模式新建 store，不往扁平的 `wiki-store.ts` 塞（这也为 SPEC-6 derived-layer 状态提供落点）。
- editor 内容来源可信性（防抖串写、无 dataVersion 重同步）须先解决，否则 SPEC-6 在编辑器叠加"页面 stale/building"提示会显示在被污染内容上。

## 预期 PR 拆分

1. **D1 切项目清历史**：切项目前取消/flush 延迟保存，或写入前校验目标项目仍当前；`resetProjectState` 捕获 outgoing 项目路径；lint items 一致清理。
2. **D2 编辑器防抖串写**：自动保存按 `selectedFile` 隔离，切文件时清理定时器；`writeFile` 失败有 UI 反馈；评估 dataVersion 重同步避免光标/撤销历史丢失。
3. **D3 分块死循环**（独立小 hotfix）：`tokenizeAtoms` 非表格 `|` 行推进修复 + 回归测试（长段落含单行 `|`）。
4. **characterization tests**（独立先合）：`autoIngestImpl` 四路径、`writeFileBlocks`/`executeIngestWrites` 当前行为、`sweepWikiReferences` 两处当前行为——与 SPEC-8 同批，先合并。
5. **D4/D5 ingest 写入安全**（在 4 保护下）：取消清理区分新建 vs 合并页面；`executeIngestWrites` 委托 `writeFileBlocks`；`index`/`overview` 遗留死参数清理。
6. **D6 + lint/dedup 输出校验**：orphan 移出 auto 分类；LLM 输出整页覆盖/删除前完整性校验；autofix 各入口共享锁；跨目录 slug key 用完整路径。
7. **source-lifecycle / 删除一致性**：`index.md`/`log.md` 读改写接入 `withProjectLock`；删除失败不清引用、不中止整批；file-sync 启动路径 delete+create 合并策略对齐。
8. **settings 持久化 + App 启动**：抽 `persistSetting` helper 替换 18+ 处静默保存；`settings-view.handleSave` 多步失败有反馈/回滚；App `init()` 分步隔离；项目打开并发保护；Settings 六子面板抽 `useProjectPersistedResource` 加项目护栏与取消；search-view 请求序列号/AbortController。

## 验证策略

- D1：打开有 review/chat 的项目 A → 切到 B → 回 A，A 的 review/chat 完整（测试覆盖延迟保存窗口）。
- D2：编辑 A → 1 秒内切 B 编辑 → A/B 文件内容各自正确不串。
- D3：`chunkMarkdown` 喂 >1000 字符含单行非表格 `|` → 正常返回不挂起。
- D4：来源 B 合并进 A 的页面后取消 B → A 原始内容保留。
- D5：已编辑页面点 "Save to Wiki" → 走合并/备份，不整页覆盖。
- D6：agent 跑 lint autofix → orphan 页面不被删；空/截断 LLM 输出不清空页面；并发 autofix 不互相覆盖。
- source-lifecycle：autoIngest 持锁期间并发删除 → index.md 无静默覆盖；删除失败页面引用不被清理。
- settings：任一保存步骤注入失败 → UI 显示错误、无"已保存"假象、无内存/磁盘分叉。
- App：`init()` 某步抛错 → 仍尝试打开上次项目或明确提示；快速双击打开无 project/fileTree 错位。

## Gate 结论摘要

本 SPEC 来自 `spec-5-8-post-review-findings.md` 的深度 review 证据。涉及 `autoIngestImpl`/`writeFileBlocks`/`sweepWikiReferences` 的 PR 必须证明 behavior unchanged 且先合并 characterization tests。实现 PR 必须重新按 PR-level workflow 跑 GitNexus impact、focused tests、Simplicity、Tester、Reviewer 和 detect。

## Non-goals / Follow-up

- 不改变 ingest/commit 产品语义或新增功能。
- 不实现 SPEC-6 derived rebuild；但本 SPEC 抽出的 `persistSetting` helper 与 per-item 状态 store 模式是 SPEC-6 UI 状态机的前置基座。
- 不承担 SPEC-8 的 `autoIngestImpl` 拆分本身，只锁定其 characterization tests 与本 SPEC 数据安全修复的交集。
- 不把 secret 或私有路径写入日志、PR 或测试快照。
