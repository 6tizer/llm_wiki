# SPEC-5 到 SPEC-8 阶段全仓深度 Review 问题记录

> 类型：证据 / 待消化 | 状态：evidence — 已分流到 SPEC-5-FIX、SPEC-10、SPEC-11 并回灌 SPEC-6/7/8 | 日期：2026-07-02 | 覆盖：全仓库（Rust 后端 + core-runtime + ingest 管线 + chat/agent 层 + UI shell）

本文件是 2026-07-02 一次全仓深度 code review 的完整证据来源，作用等同 `spec-1-4-post-test-findings.md`：承载 file:line 级 bug 与精简清单，供 SPEC-5-FIX / SPEC-10 / SPEC-11 以及改后的 SPEC-6/7/8 引用。所有条目均由 review 时读实际代码路径确认（非猜测），部分 P0 已由多条独立审查线交叉印证或本人 grep + GitNexus 复核。

Review 范围与方法：10 份并行子 Agent 分工审查 core-runtime + SPEC-5 流水线、Rust 后端（api_server / runtime_db / file_ops / agent_cli / search）、ingest 知识管线、chat/agent 层、UI shell / stores / 组件、commands / i18n / mcp-server / extension。行号来自 review 当时的工作区快照，实现 PR 开工前须以当时代码为准重新定位。

**总判断**：架构底座质量高——runtime DB 事务边界、集中式鉴权、密钥 keychain 流转均验证干净，无 SQL 注入、命令注入、鉴权绕过、可达 panic。但"数据写入 + 并行执行"路径上散布 14 个 P0，其中 1 个（S2 clip server）可被任意外部网页直接触发，另 1 个（S1）是经应用自身文件操作/图片导出/LLM 工具路径可达的真实沙箱逃逸（未证明外部网页能直接打到 Tauri fs command），且 SPEC-5 并行流水线虽标记 completed 却在生产中从未端到端接线。

---

## 一、最关键结论：SPEC-5 流水线从未接线（已 grep + GitNexus 双重确认）

- 生产者 `enqueueBulkKnowledgePrepareJobs`（`src/lib/parallel-knowledge/bulk-runtime-entry.ts:38`）**已接到真实 UI 按钮** `src/components/sources/sources-view.tsx:109`（"批量准备"），会把 job 写入 `runtime_jobs`（state=queued）。
- 消费端 `runPrepareWorkerPool`（`src/lib/parallel-knowledge/prepare-worker-pool.ts:140`）与 `commitPendingStagingArtifacts`（`src/lib/parallel-knowledge/commit-integration.ts:169`）**在 `src/` 里只有定义、零生产调用点**；GitNexus 确认 `runPrepareWorkerPool` 唯一调用方是其 `.test.ts`。
- 没有 `PrepareModelCallExecutor` 的具体实现，只有测试 mock。
- 结果：点"批量准备" → job 永远 queued / awaiting worker → 无人认领、处理、提交。组件各自单测充分（故能过 PR gate），但"组件级完成" ≠ "功能可用"。

→ 该结论直接决定 SPEC-5-FIX 的存在，并使 SPEC-6（消费 derived stale marker）当前无数据可消费。

---

## 二、P0 清单（14 项）

### 安全（可被外部利用 / 权限与密钥）— 归 SPEC-10

- **[S1] 沙箱逃逸 `src-tauri/src/commands/file_ops/path_safety.rs:74-93`**：`validate_within_project` 在"目标路径及其父目录都不存在"时完全跳过 root 包含校验，绝对路径分支又无 `..`/前缀拒绝。场景：`create_directory`/`write_file`/`copy_file` 传一个父目录尚不存在的项目外绝对路径，即可在沙箱外任意建目录/写文件，无需符号链接或 `..`。`extract_images.rs:922-969` 图片导出正常流程即命中该分支。测试 `path_safety.rs:148-154` 只测了已存在的 `/etc/passwd`，走安全分支，未覆盖漏洞分支。
- **[S2] clip server 无鉴权 `src-tauri/src/clip_server.rs`（90-106, 160-187, 317-432）**：`127.0.0.1:19827` 剪藏服务每个响应 `Access-Control-Allow-Origin: *`，无 Origin 校验、无 token；`handle_clip` 的 `dir_path` 直接取自请求体 `projectPath` 且不校验是否属于已知项目。场景：用户开着应用时访问任意网页，页面 `fetch` 即可向磁盘任意可写目录写 markdown、`GET /projects` 枚举全部项目名与完整路径，并形成间接 prompt injection 通道。
- **[S3] 密钥经 stdout 泄露落盘 `sidecar/src/core.ts:334-341` + `src-tauri/src/commands/agent_cli/agent.rs:500-502`**：SDK 异常 message/stack 走 `{type:"error"}` 经 stdout 原样 emit 前端，脱敏 `sanitize_agent_stderr_for_frontend`（`agent.rs:304-306,540`）只作用于 stderr/`:done` 通道。密钥经 env 注入子进程后常被网关 HTTP 报错带进 `err.message`（本仓库 `litellm/config.yaml` 就是这类网关）→ 未脱敏写入前端会话记录并持久化。
- **[S4] wiki 写工具绕过权限审批 `sidecar/src/core.ts:203-229`**：`canUseTool` 对 `mcp__llm_wiki__*` 直接调 `shouldAllowWikiTool`（`agent-policy.ts:109-120`），不经 `permissionBridge.requestPermission`，只看默认 true 的 `enableWriteTools`，与 `permissionPolicy` 档位无关。场景：默认设置下 `update_page`/`create_entity`/`run_pipeline` 直接改写 wiki，用户看不到审批弹窗，收紧权限策略也无效。
- （相关 P1）**stderr 脱敏前打日志 `agent.rs:490-498`（及 `codex_cli.rs:241`/`claude_cli.rs:378`）**：`eprintln!("[agent-sidecar stderr] {line}")` 在脱敏前逐行执行，密钥可进本地日志/Console.app。测试 `agent.rs:678-692` 证明 stderr 可含 `ANTHROPIC_AUTH_TOKEN=...`。

### 数据丢失 — 归 SPEC-11

- **[D1] 切换项目清空历史 `src/App.tsx:450-470` + `src/lib/auto-save.ts:51-71`**：`handleSwitchProject` 中 `resetProjectState()` 在 `setProject(null)` 之前清空 review/chat store；清空同步触发 auto-save 订阅，此刻读到的仍是旧项目路径 → 1-2 秒后把空数组写进旧项目 `review.json`、`conversations.json` 及 `chats/`。**每次切换项目都永久清掉旧项目的 review 标注和会话历史**，无守卫、无取消。启动路径因 project 仍为 null 而不受影响。
- **[D2] 编辑器防抖保存串文件 `src/components/layout/preview-panel.tsx:16,54-80`**：1000ms 防抖自动保存定时器绑组件级、不按 `selectedFile` 隔离、只在卸载时清理。场景：编辑文件 A → 1 秒内切到 B 编辑 → A 的延迟写回调用 A 内容覆盖 store `fileContent` → B 随后自动保存把被污染内容落盘 → **B 文件被 A 内容覆盖/损坏**。
- **[D3] 分块死循环冻结进程 `src/lib/text-chunker.ts:315-364`（`tokenizeAtoms`）**：长 heading 段落中混入一行以 `|` 开头但不构成 ≥2 行表格的行时，段落累积循环条件（352-357）恒 false，`i`/`cursor` 永不前进，外层 `while` 无限重跑同一行。同步循环无 await，**冻结整个 Tauri 渲染进程**。实测复现（被截断的 LLM 表格 / OCR 产物 / 未加围栏的管道命令示例）。该路径无测试覆盖（现有测试输入过短走了 `chunkSection` 短路）。
- **[D4] 取消任务误删合并页面 `src/lib/ingest-queue.ts:200-215`（`cleanupWrittenFiles`）+ `ingest.ts:1656-1807`（`writeFileBlocks`）**：`writtenPaths` 不区分"新建页面"与"被 `mergePageContent` 合并进已存在内容的页面"，取消清理时 `cascadeDeleteWikiPage` 一律整页删除。场景：来源 A 已生成 `concepts/foo.md`；来源 B 摄取时 FILE 块经 slug 命中同路径被合并进 foo.md；用户取消 B（或切项目触发 `pauseQueue()`，456-458）→ 整个 foo.md 被删，连 A 的原始内容一起清空。
- **[D5] 聊天 Save to Wiki 绕过全部防护 `src/lib/ingest.ts:1910-2106`（`executeIngestWrites`）**：对比 `writeFileBlocks` 具备的 `mergePageContent`/`sanitizeIngestedFileContent`/slug 去重/`validateWikiPageRouting`/`isRootIngestAggregatePath` 保护，`executeIngestWrites`（第 2054 行 `writeFile(fullPath, content)`）一个都没有。场景：用户已有 `entities/acme-corp.md`（含手工编辑），聊天讨论 Acme Corp 后点 "Save to Wiki" → 整页覆盖，原内容永久丢失。`sources-view.tsx:269-286` 注释显示团队已把"重新摄取"从这条路径移走，但聊天面板仍在用。
- **[D6] lint autofix 删除孤儿页面 `src/lib/lint-fixer.ts:749-763` + `src/lib/lint.ts:326-333`**：`classifyFixability` 把 `type:"orphan"`（severity info，仅表示"无别的页面链接到它"）无条件归为 `"auto"` → `fixOrphan` → `cascadeDeleteWikiPagesWithRefs` 整页删除。同文件 `fixAllLintResults`（65 行）显式排除了 orphan，说明作者知道危险，但 `runLintAndReport(autoFix=true)`（被 chat-agent 工具 `agent-app-tools.ts:870` 调用）无防护。场景：用户让 agent "跑 lint 并自动修复" → 所有暂未被引用的合法页面被整页删除。
- **[D7] 流式回合崩溃丢整轮 `src/stores/chat-store.ts` + `src/lib/auto-save.ts:86`**：持久化订阅在 `state.isStreaming === true` 时直接 return 不排队任何延迟保存；`isStreaming` 从 `startAgentStreamMessage`（`chat-store.ts:532`）到 `finishAgentStreamMessage`/`finishAgentError`（564）期间全程为真。场景：多工具 agent 运行数分钟后强杀/崩溃 → 重启后该轮完全消失（非"卡在 streaming 态"，是整轮记录彻底丢失）。
- **[D8] settings 静默保存失败（系统性）**：`llm-provider-section.tsx:51,64`、`web-search-section.tsx:95,104,110,121`、`settings-view.tsx:461-628`（`handleSave` 8 组 setX+saveX 无 try/catch、无回滚，任一步失败后前几项内存已标"已保存"、后几项含 Rust-locked 键未落盘、无错误提示）、`about-section.tsx:55-93`、`update-banner.tsx:57-60` —— 共 18+ 处系统性 `persist().catch(()=>{})` 后无条件 `setSaved`，保存失败对用户完全不可见，重启后配置静默回退旧值。修复统一走 `persistSetting` helper（SPEC-11 PR8）。

### 并行流水线 / runtime ledger — 归 SPEC-5-FIX

- **[P0-pool] worker pool 从不续租，慢 LLM 崩掉整个 pool `src/lib/parallel-knowledge/prepare-worker-pool.ts`**：全文件无 `runtimeJobHeartbeat` 调用（grep 确认）。job 租约 TTL `DEFAULT_LEASE_TTL_MS = 120_000`（2 分钟，`runtime_db.rs:48`），profile claim TTL 却 `DEFAULT_PREPARE_PROFILE_CLAIM_TTL_MS = 1_200_000`（20 分钟）——为慢 LLM 预留却没给 job 租约对应续租。崩溃点：`prepare-worker-pool.ts:266`（`completeJob` 无 try/catch）、536-540（`failJob` 无 try/catch）、`runPrepareWorker` while 循环（192-198）对 `processPrepareJob` 无 try/catch。后端 `ensure_active_running_lease`（`runtime_db.rs:7114-7151`）在租约过期时抛 `lease-expired`，complete/fail 都走该检查。场景：一个 ≤10 源文档的 batch，LLM 调用 >120s（多文档生成很容易）→ staging 已写、profile claim 已释放，但 `completeJob` 抛 `lease-expired` → 未捕获 → 冒泡到 `Promise.all(workers)` → 整个 `runPrepareWorkerPool()` reject，丢弃所有 worker 的汇总结果；该 job 永远停在 `state='running'`。
- **[P0-budget] commit-path 预算永不过期锁死文件 `src-tauri/src/commands/runtime_db.rs:6975-7020`（`ensure_commit_total_capacity`/`ensure_commit_path_available`）**：容量检查按 `COUNT(*) WHERE status='active'` 计数，**不过滤 `expires_at_ms > now`**（对比 profile pool `runtime_db.rs:7755` 带 `AND expires_at_ms > ?2` 能自愈）。唯一能把 claim 转 `expired` 的 `runtime_commit_budget_expire_for_project`（5603-5641）是 `#[allow(dead_code)]`，`lib.rs` 未注册、无 TS 绑定。配合唯一索引 `runtime_commit_path_active_unique_idx`（每路径上限 1）。场景：`commitMarkdownArtifact`（`src/core-runtime/markdown-commit/index.ts:191-201`）`finally` 里 `releaseBudget` 失败（应用被杀 / IPC 抖动 / 磁盘满，`commit-operation.test.ts:622-645` 已覆盖"release 失败但仍返回 committed"）→ claim 永留 active → 之后该 targetPath 每次提交都拿 `commit-path-already-claimed`，被 `commit-integration.ts:546-552` 的 `isRetryableBudgetRejection` 判为可重试 → **无限重试永远失败**，无任何 UI/命令能释放孤儿 claim。

---

## 三、P1 清单（择要）

### 数据丢失 / 一致性（归 SPEC-11，除标注外）

- **LLM 输出未校验即整页覆盖**：`lint-fixer.ts:216-217,311-312`（`fixBrokenLink`/`fixNoOutlinks` 要求"FULL corrected page"却不做长度/frontmatter/非空校验直接 `writeFile`）、`lint-fixer.ts:680-712`（`applyLlmFix` 空 FILE 块把页面清成空文件、仍记入 `filesWritten` 显示"修复成功"）、`dedup.ts:376-434`（`mergeDuplicateGroup` 未校验 llmOutput 即写 canonical 并触发删除其余成员）、`wiki-synthesis.ts:536-542`（synthesis 页无条件整页覆盖，不读已有内容、无合并保护）。changelog.ts 记录 0.4.5 曾为 entity/concept 合并加过 length/structure sanity check + fallback 备份，这些路径无等价保护。
- **跨目录同名文件用裸文件名做 slug key**：`lint.ts:52-65`（`buildSlugMap` 入链计数互相覆盖，放大 D6 误删）、`dedup-runner.ts:186-207` + `dedup.ts:120-138`（`executeMerge` 的 `pathBySlug` 后遍历目录覆盖先遍历，合并/删除作用到错误文件）。
- **index.md/log.md 读改写无锁 `src/lib/source-lifecycle.ts` 全文件**：`project-mutex.ts` 注释明确 autoIngest 读 index.md → 长 LLM 调用 → 覆写需 `withProjectLock`，但 source-lifecycle、`wiki-page-delete.ts`、`project-file-sync.ts`、`wiki-cleanup.ts` 零处获取该锁。场景：autoIngest 持锁读 index.md 做 10-30s LLM 期间，用户从 Sources 删另一文件未持锁地读改写 index.md，autoIngest 完成后用旧快照覆写，静默撤销删除并复活悬空条目。锁只在一侧生效等于形同虚设。
- **删除失败仍执行引用清理 `wiki-page-delete.ts:165-249`**：`cascadeDeleteWikiPagesWithRefs` 对每页删除的 try/catch 只记日志，不把失败页从 `infos`/`deletedKeys` 剔除，仍剥离其余页面对它的 `[[wikilink]]`/`related:`/index 列表行 → 删除失败的页面本身仍在磁盘但已在 UI 中不可达。
- **删除循环遇错中止整批 `source-lifecycle.ts:279-283`**：`deleteFile` 无 try/catch，第 3 个失败即抛，前 2 个已删但从未走缓存清理/wiki 级联/日志追加，第 4/5 个未尝试 → 残留指向不存在文件的 `sources:` 条目。
- **cancelTask 竞态 `ingest-queue.ts:601-635`（归 SPEC-5-FIX/SPEC-8）**：`currentAbortController` 到 628 行才创建，晚于 603 行置 `processing`；此窗口内调 `cancelTask` 时 `.abort()` 因 controller 为 null 被跳过，任务从队列移除、UI 显示已取消，但 `autoIngest()` 继续后台跑完写未追踪文件 → 孤儿页面/缓存。
- **lint mutex 只护一半 `lint-fixer.ts`**：锁只在 `runLintAndReport`（833，chat-agent）获取，UI "Fix All" 走 `fixAllLintResults`（`lint-view.tsx:239`）不获取 → agent autofix 与 UI Fix All 并发覆盖同一批页面，last-writer-wins。

### 并行流水线 / runtime（归 SPEC-5-FIX）

- **repair job 无消费者 `prepare-worker-pool.ts:397-408,431-443`**：创建 `BULK_KNOWLEDGE_ARTIFACT_REPAIR_JOB_KIND`/`BULK_KNOWLEDGE_MAP_REDUCE_REPAIR_JOB_KIND` job，但 pool claim 循环（205）只认领 prepare kind，全仓无任何代码认领这两种 repair kind（grep 确认）。`markdown-conflict-repair` job 同样无消费者（`markdown-commit-repair.ts`）。
- **append 提交崩溃无自愈 `commit-integration.ts:356-377`（`reconcileAlreadyCommitted`）**：只对 create/update 做"当前哈希已等于产物哈希"自愈，append 被有意排除（`commit-integration.test.ts:88-127`）。append 写盘成功后进程在 `appendEventMarkersAndCleanup`（379-391）前崩溃 → 重试被判 conflicted → 走 `routeMarkdownConflictRepair` 标 failed 退出 pending → 但 repair job 无消费者 → 文件已变但对应层 derived stale marker 永久缺失。
- **lease 超时回收是死代码 `runtime_db.rs:5656-5701`（`runtime_job_lease_timeout_for_project`）**：`#[allow(dead_code)]`，非 tauri command，只有单测调用（15100/15137）。job 持有进程崩溃后，其 lease 因 `runtime_job_active_lease_unique_idx` + `ensure_no_active_lease` 卡在 `running` 永远无法重新认领/重试/失败。
- **profile pool renew 存在却从不调用 `runtime_db.rs:3760`（`runtime_profile_pool_renew_for_project`）**：已注册 + 有 TS 绑定（`runtime-db.ts:665`），但 `src/lib/parallel-knowledge/*` 无调用。20 分钟 TTL 让触发概率低于 pool heartbeat，但同类"声明续约却没接线"。
- **app.exit(0) 不清理 sidecar 子进程 `src-tauri/src/lib.rs:278,524`**：Tauri `AppHandle::exit()` 走 `std::process::exit` 不运行析构，`kill_on_drop(true)`（`agent.rs:419`）失效；托盘退出/窗口关闭两条路径均硬退出、不遍历 `AgentState`/`ClaudeCliState`/`CodexCliState` 杀子进程 → 孤儿 sidecar 继续跑，若正在写工具则孤儿进程继续改 wiki 文件。
- **优雅取消是死代码，停止永远 SIGKILL `sidecar/core.ts:127-138`**：sidecar 收到 `{type:"kill"}` 后 `abortController.abort()` + 拒绝挂起请求的逻辑只在 sidecar 自测出现，Rust 侧从未写该消息；`agent_kill`（`agent.rs:1195-1206`）直接对进程组 SIGKILL → 若命中文件写入可截断损坏 wiki。

### Rust 后端其他 P1（归 SPEC-10 或 SPEC-8）

- **percent_decode 字符边界 panic `api_server.rs:566-582`**：`input[i+1..i+3]` 对 `&str` 切片，`%` 后紧跟多字节 UTF-8（如"水"）跨边界时 panic；`parse_query`/`resolve_project` 均调用，`?path=%水`（curl/nc 原始 UTF-8）触发 per-request panic（外层 `catch_unwind` 兜底不致命）。SPEC-8 拆 api_server 时应顺带修。
- **staging 先删文件后提交事务 `runtime_db.rs:5314-5323,5352-5369,5385-5401`**：commit-success / clear-pending / gc 三处先 `remove_staging_artifact_file` 再 `tx.execute` + `tx.commit()`，事务因磁盘满/BUSY/崩溃回滚但文件已删 → DB 行仍 `pending`，`read_body` 因文件缺失报困惑错误。

### chat/agent 其他 P1（归 SPEC-7）

- **compact/resume 检测是脆弱纯英文正则 `sidecar/agent-summary.ts:3-6,22-28`**：注释自认"非英文文本会当普通助手消息";检测失败时摘要经普通消息路径落入 `chat-panel.tsx:646` 当正文渲染写入历史，且 `isCompactOnlyAgentMessage`（`chat-store.ts:805-807`）对它失效（`sessionCompact` 标记没打上），污染后续轮次上下文。
- **stale pending intent 官方修复不完整 `src/components/chat/agent-resume-intent.ts:9-10`**：`CORRECTION_OR_NEW_TOPIC_RE`/`ENGLISH_NEGATIVE_RE` 是固定关键词白名单，任何不在词表的纠正表达都不识别为纠正，旧 intent 原样带入下轮，已文档化的 bug 在多数真实措辞下仍复现。`PENDING_QUESTION_RE:7` 上条助手消息含裸问号（代码/URL）即误判"有待处理问题"。
- **同 stream_id 并发 spawn 静默互覆 `agent.rs:467-473`（及 `claude_cli.rs:336`/`codex_cli.rs:199`）**：无检查的 `HashMap::insert`；`agent.rs:508` 读取任务清理会在旧进程 stdout 关闭时错误摘除 map 中（可能是新进程的）条目 → 后续 `agent_tool_response`/`agent_permission_response` 报 "No running agent stream"，挂起权限审批永远送不达。
- **profile claim 早失败路径泄露 `agent.rs:402-464`**：`release_agent_profile_claim` 只在 spawn 之后的后台任务（537-539）调用，spawn 前的失败路径（sidecar 缺失、stdio 附着失败、首次 stdin 写失败）return Err 时不释放已 active 的 claim，只能等 TTL 过期。

---

## 四、P2 / P3 高频项（长尾完整清单见第八节）

- **profile 错误分类子串误判 `runtime_db.rs:3692-3741`**（P2）：`"oauth failed"` 含 `"auth failed"`，把 OAuth profile 误判网关认证失败开熔断 30s；agent 工具输出含 "401 Unauthorized" 的网页内容也误触发。
- **api_mode/auth_style 无组合校验 `runtime_db.rs:4600-4628`**（P2）：`anthropic-messages + api-key` 落到 `Authorization: Bearer` 兜底，而 Anthropic 要求 `x-api-key`，创建无报错、probe 必 401。
- **profile 软删除不释放 profile_id + 熔断器孤儿行 `runtime_db.rs:3279-3321`**（P2）。
- **staging 写入不内部 normalize + 先 mkdir 后校验 `runtime_db.rs:6556-6612`**（P1/纵深防御）：当前唯一调用方已预 normalize（`runtime_db.rs:5175`）故不可利用，但函数名暗示"已 normalize"却不自证，未来新调用方会重新引入路径穿越建目录。
- **staging record 不做 job 范围检查 `runtime_db.rs:5050-5157`**（P2）：仅 DB 的 record 路径不调 `ensure_staging_artifact_path_scoped_to_job`，一个 job 可占用另一 job 的 artifact 命名空间致后者 store 冲突。
- **embedding 部分失败清空已有索引 `embedding.ts:487-516`**（P2）：`vector_upsert_chunks` 先删该 page_id 全部旧行再插入本次；部分 chunk 失败仍传不完整 rows → 该页此前完整向量索引被"先清空再只插成功部分"，失败 chunk 内容在索引中永久消失，仅一条 console.log。
- **embedding 全库重建单 chunk 失败即中止 `embedding.ts:559-630`**（P2，clearExisting 路径无 try/catch，与非 clearExisting 路径不一致）。
- **dedup 后端故障与"无重复"无法区分 `dedup_embedding.ts:22-48` + `dedup-runner.ts:139-158`**（P2）：`fallbackReason:"embedding-failed"` 被 `runDuplicateDetection` 长度检查丢弃，UI 误显示"无重复"。
- **MinerU 多 md 文件无 full.md 时静默取 [0] `mineru.ts:592-599`**（P2）；`assertMineruSuccess` 只检查 code 不检查 data（P3，407-518）。
- **lint 语义解析失败静默返回 0 问题 `lint.ts:263-299`**（P2）。
- **image-caption 缓存整读整写并发丢条目 `image-caption-pipeline.ts:315,438-446`**（P2）。
- **project-file-sync 启动/重连路径 delete+create 合并策略不一致 `project-file-sync.ts:128-166 vs 42-84`**（P2）：启动路径按 `id:version` 去重不按路径去重，同路径旧 deleted + 新 created 同时入队 → 对存在的路径执行级联删除。
- **搜索无索引全表暴力扫描 `vectorstore.rs`（无 create_index）+ 关键词每次全量重扫 `search.rs:152-185,424-488`**（P2 性能）。
- **项目锁 key 未规范化 `vectorstore.rs:108-115`**（P2）：尾斜杠/大小写不同产生两把锁守同一 LanceDB 目录，并发写有损坏风险（`search.rs:1079-1081` 已知该 hazard 但此处未应用）。
- **zip/office 解压无大小上限 `fs.rs:614-619`、`extract_images.rs:425-429,822-826`、`read_file_as_base64` `fs.rs:1536-1571`**（P2）：信任 zip 头声明大小，恶意 .docx 触发 OOM；对照 `file_sync.rs` 已有 `MAX_HASH_BYTES=32MB` 模式明显遗漏。
- **clip_server 单线程无 panic 防护 + 裸 unwrap `clip_server.rs:120,161,162,193,212`**（P2）：持锁 panic 跳出循环绕过重启逻辑，`DAEMON_STATUS` 永停"运行中"误报健康；错误响应体手写 format! 未转义（P3，138-140 等）。
- **tauri.conf.json `assetProtocol.scope:["**"]`**（P2）：`asset://` 可服务任意绝对路径，叠加 `connect-src http:/https:`，前端 XSS 时可读任意本地文件外传。
- **i18n 缺失 key `graph-view.tsx:1745`（`common.dismiss` 渲染成原始 key tooltip）、`file-tree.tsx:70,74,112`（中文永久显示英文兜底）**（P2/P3）：现有 `i18n-parity.test.ts` 只校验 en/zh 互相一致，无"代码引用的 key 必须存在"断言。
- **App.tsx init 一个大 try/catch 吞一切 `App.tsx:192-284`**（P1）：15+ 顺序 await 任一步抛错则 zoom/theme/language 恢复和"自动打开上次项目"全跳过、无提示；`handleProjectOpened`/`handleSelectRecent`（286-448）无并发保护，快速双击可致 project=B 但 fileTree=A 错位。
- **runtime-jobs-section 轮询/进度问题 `runtime-jobs-section.tsx:175-206,434-456`**（P1/P2）：自适应轮询无外部触发点重置定时器（enqueue/resume 后最多等 30s 才刷新）；`prepareJobs` 不按 planId 分组，`Math.max` 汇总多批次致总进度/ETA 失真；`prepareWaitingForWorker` 用系统级 `progressRows.length===0`（`runtime-diagnostics.ts:60` 无 jobId 过滤）会 false-negative。
- **Settings 六子面板项目切换不取消进行中异步**（P1）：`knowledge-agents-section.tsx:124-163`、`tag-taxonomy-section.tsx:131-155`、`synthesis-section.tsx:43-98`、`maintenance-section.tsx:53-115`、`source-watch-section.tsx:32-60`、`model-profiles-section.tsx:347-353` —— 慢操作 resolve 时用旧项目数据覆盖新项目设置。
- **search-view 无请求序列号/AbortController `search-view.tsx:45-64,117-125,155-183`**（P1）：慢请求后到覆盖快请求结果。
- **project-store 读改写无锁 `project-store.ts:36-44,205-222,288-297,247-254`**（P2）：两次独立 IPC 之间无锁，并发 recentProjects 修改互相丢弃。
- **graph-view MutationObserver setTimeout 未清理 `graph-view.tsx:927-947`**（P2，反复 remount Sigma 画布闪烁）。
- **wiki 写工具 permission 相关补充**（chat/agent P2）：权限队列全局单例不按 streamId 隔离（`chat-store.ts:163-164`）；"允许永久" suggestions 为空时静默写空白名单（`agent-permission.ts:24-29`）；`agent-block-list.tsx:16-22` 畸形 tool_result.content 抛 TypeError 崩渲染；权限弹窗 Enter 默认走 allow_temporary（`agent-permission-dialog.tsx:141-147`）。

---

## 五、精简清单（file:line + 建议）

### Rust（约省 500+ 行）

- `runtime_db.rs:982-1591` ~35 处命令包装样板 → 抽 `run_project_write`/`run_project_read` 两个泛型 helper（省 120-150 行）。
- `runtime_db.rs:1733-1871` 每次命令全量重跑 schema init + 开两个 Connection → 缓存已初始化标记。
- `runtime_db.rs:7240-7828` ~10 个 `read_*` prepare→query_map→collect 样板 → 泛型 `read_rows_tx`（省 150+ 行）；`read_staging_artifacts:7508-7570` 四分支 match → 动态 WHERE。
- `runtime_db.rs:6673-6772` `remove/read_staging_artifact_file` 重复"stat→拒目录/符号链接→canonicalize→containment" → 抽 `resolve_staging_artifact_target`（顺带修 P2 TOCTOU）；`normalize_affected_path`/`normalize_staging_artifact_path`（6399-6489）~35 行重复。
- `runtime_db.rs:2738-2748 vs 5678-5684` retry/fail transition 逻辑重复 → `compute_retry_transition`。
- `vectorstore.rs:167-993` 12 处 connect→lock→开表样板 → `open_table_if_exists` + `with_project_lock`（省 150+ 行）；`vector_count*` 三处 → `count_rows_in_table`；`validate_page_id`/`validate_page_id_for_v2` 两个冗余 wrapper。
- `api_server.rs:192-195` CORS 短路检查是死代码（外层 `start_api_server:114-117` 已处理）；`resolve_project` + 404 样板 6 处 → `resolve_project_or_404`；413/500 靠字符串匹配 `e.contains("exceeds")` → 类型化错误。
- `codex_cli.rs`/`claude_cli.rs` 8 处逐字重复（working dir 校验 364-397/535-572、`suppress_windows_console`、`DetectResult`、`abort_*_timeout_task`、`*_timeout_message`、stderr drain、`*_cli_kill`、`*_done_payload`）→ 合并到 `cli_resolver.rs`；三处 `HashMap<String,Child>`+超时任务+done-payload 管理 → 共享"受管理子进程"模块（顺带修进程组不对称）。
- `fs.rs`（2437 行）office/PDF 抽取（700+ 行）→ 拆 `office_extract.rs`；两套 DOCX 解析器（docx_rs + 手写 XML 632-815）评估合并。
- `path_safety.rs` 与 `extract_images.rs` 两套沙箱模式实现 → 合并到 `path_safety.rs` 唯一实现（这正是 S1 在两处都没被发现的原因）。
- `clip_server.rs:99-271` CORS 响应头拼装重复 ~10 次 → `respond(request, body, status, cors)`；5 处 `.lock().unwrap()` → 容忍中毒模式。

### TS（最高价值：修 bug + 消重复一体）

- **抽 `persistSetting(set, save, value, {onError})` helper** → 一次修掉 18+ 处静默保存丢失（S-settings P0/P1）+ 消除重复。最高优先级。
- `flattenMdFiles`/`flattenMd` 四处重复（`lint.ts:19-29`、`wiki-utils.ts:11-21`、`sweep-reviews.ts`、`wiki-page-delete.ts:113-126`、`source-lifecycle.ts:504-517`）→ 统一 import `wiki-utils.ts`（安全机械替换）。
- dedup "规范化 key" 三处（`dedup.ts:326-328`、`dedup-queue.ts:88-90`、`dedup-storage.ts:66-68`）→ 统一纯函数。
- `stableHash128`（`staging-artifact.ts`）、`batch-planner.ts:181-188` 的 32 位 FNV-1a、`long-document-map-reduce.ts:257-259` → 统一复用 `src/core-runtime/stable-hash.ts` 的 `fnv1a64Hex`。
- `isDuplicateRuntimeJobError` 两处发散实现（`prepare-worker-pool.ts:620-630 vs bulk-runtime-entry.ts:74-82`）→ 一个共享 helper。
- `appendWorkerProgress`（`prepare-worker-pool.ts:632-649`，无 try/catch）与 `appendProgress`（`commit-integration.ts:486-509`，有 catch）→ 统一 best-effort append（顺带修 P0-pool 崩溃）。
- `executeIngestWrites` → 委托给 `writeFileBlocks` 薄封装（同时消重复 + 修 D5）。
- `web-search.ts` 六 provider fetch/错误样板 → 抽 `fetchSearchApi`（省 90 行，建议先补测试）。
- `mineru.ts:469-530` `pollTask`/`pollBatchTask` 结构相同 → `pollUntilDone`。
- `lint-fixer.ts:346-641` 四个 fix 函数（`fixContradiction`/`fixStale`/`fixMissingPage`/`fixGenericSemantic`）结构一致 → `runMultiPageFix`（先锁 prompt 特征化测试）；12+ 处 activity-item 样板 → `withLintActivity`。
- `wiki-page-delete.ts:165-249` 与 `source-lifecycle.ts:393-457` ~50 行"扫描 wiki 剥离 index/wikilink/related" → `sweepWikiReferences`（合并同时修 P1/P2，先补特征化测试）。
- `commit-integration.ts:280-303`（`buildCommitAdapters` 把 adapter 钩子全设 no-op 再自己重实现）与 `markdown-commit/index.ts:170-317` 两套并行提交后处理 → 二选一（`buildConflictReason` 在 `index.ts:465-467` 和 `commit-integration.ts:411` 逐字重复）。
- `apiConfig` 默认值重复声明（`wiki-store.ts:485-490` 与 `App.tsx:252-260`）→ `DEFAULT_API_CONFIG` 常量。
- `boundary-check.ts:43-46` 死规则（`@/lib/runtime.db` 从不存在，且会被 `@/lib/` 前缀规则先捕获）→ 删除。
- Settings 六子面板"项目感知加载 + 取消" → `useProjectPersistedResource` hook（堵 6 处跨项目脏写）。
- `llm-provider-section.tsx:721-904` `ClaudeCliStatusPill`/`CodexCliStatusPill` ~90 行重复；`wiki-reader.tsx:75-183` 与 `file-preview.tsx:204-256` ~80 行 ReactMarkdown 覆写重复。

### 需先补特征化测试（SPEC-8）

- `autoIngestImpl`（`ingest.ts:872-1467`，595 行 god-function）：5 段边界清晰（缓存预检/图片+分块/三阶段 LLM/写入+兜底/嵌入），但步骤 8-16 通过可变闭包变量高度纠缠、零测试护栏，D4 与 cancelTask 竞态就藏在此。特征化测试目标应聚焦 **cache-hit / cache-miss / abort-mid-write / cancel-during-processing** 四条路径。
- `index`/`overview` 参数是 SPEC-3 遗留死代码信号：`ingest.ts:900` 硬编码 `const index = ""`，参数贯穿多个签名传空字符串，只有两个 legacy chat-mode 函数还真正用；`executeIngestWrites`/`writeFileBlocks` 合并后应直接删参数。

---

## 六、消化路由

| 证据 | 分流目标 |
|------|----------|
| SPEC-5 流水线从未接线（一）；P0-pool、P0-budget、repair job 无消费者、append 无自愈、lease 回收死代码、profile renew 未接线、cancelTask 竞态 | **SPEC-5-FIX** |
| S1 沙箱逃逸、S2 clip server 鉴权、S3 stdout 密钥泄露、S4 权限绕过、stderr 脱敏、app.exit 孤儿进程、优雅取消死代码、percent_decode panic、staging 先删后提交、tauri asset scope、assorted Rust P2 安全项 | **SPEC-10** |
| D1-D8 数据丢失（含 settings 静默保存）、LLM 输出未校验覆盖、跨目录 slug 冲突、index.md 无锁、删除失败仍清引用、App.tsx init 吞错、Settings 六面板不取消、search-view 无序列号、editor 相关 | **SPEC-11** |
| SPEC-6 范围修正与 marker 消费就绪度、SPEC-7 SDK 落差与 session state 隔离与 PR6 footer profile、SPEC-8 api_server 降级为机械拆分 + i18n parity 补断言 + 全部精简项归属 | **回灌 SPEC-6 / SPEC-7 / SPEC-8** |
| 第八节 P2/P3 长尾（健壮性/性能/死代码/资源泄露）——除标注归 SPEC-10/11 的安全或数据项外，默认作为 **SPEC-8 known-minor backlog** 收纳，随相邻主 PR 顺带修或单列低风险 PR | **SPEC-8（默认）/ SPEC-10 / SPEC-11** |

## 八、P2/P3 完整补录（长尾）

第四节只列了高频/高影响的 P2/P3；本节补齐子 Agent 报告中其余全部 P2/P3，确保无遗漏。默认归 SPEC-8 known-minor backlog，标注了 [SPEC-10]/[SPEC-11] 的按对应 SPEC 处理。

### Rust — 搜索子系统（vectorstore.rs / search.rs）

- **P3** `vectorstore.rs:105-115`：`PROJECT_LOCKS` 条目永不淘汰，一个 session 打开 N 个项目路径泄露 N 个 `Arc<Mutex<()>>` 到进程结束。
- **P3** `vectorstore.rs:960-993`：`vector_optimize_chunks` 持项目锁跑完整 `table.optimize(All)`，大表期间阻塞该项目所有并发 search/upsert（大 wiki 上 UI 冻结风险）。
- **P3** `search.rs:154-167`：`MAX_SEARCH_FILES` 只对 `.md` 计数，`WalkDir` 仍 stat 所有非 md 文件/大媒体目录，cap 不 bound 总文件系统开销。
- **P3** `search.rs:490-522`：超长/CJK query 的 `tokenize_query` 无 token 数上限，`token_match_score` O(tokens×content) 逐文件逐 token `contains` 扫描。
- **P3** `vectorstore.rs:167-223 vs 487-504`：legacy v1 `vector_upsert` 不拒绝空 embedding（v2 `vector_upsert_chunks` 会），零维 `FixedSizeListArray` 可经仍 public 的 tauri 命令创建。
- **P3** `vectorstore.rs`：public `vector_search`/`vector_search_chunks` 的 `top_k` 无内部 cap，search.rs 实际 bound 到 ~150，但命令本身接受任意 top_k（防御性缺口）。

### Rust — runtime_db

- **P2/脆弱** `runtime_db.rs:2700-2777`：`complete`/`fail` 的终态 `UPDATE ... WHERE job_id=?1` 无 `WHERE state='running'` 守卫，正确性完全依赖同事务前置 `ensure_active_running_lease`。当前单写锁 + 同事务下安全，但属 check-then-act；未来若拆事务/跨 await 复用检查结果会静默重引入 double-completion race（对比 claim UPDATE `2584-2593` 内嵌 `AND state='queued'`）。
- **P3** `runtime_db.rs:2258-2398, 2037-2177`：migration `*_VERSION` 常量被 `record_migration_family` 记录但从不据"已记录版本"分支决定跑哪些步骤，`ensure_column_exists` 每次无条件重跑。只因迄今全是 nullable additive `ALTER` 才幸存，不能安全扩展到需 transform/backfill 的迁移。
- **P2** `runtime_db.rs:2504-2540`：`job_id` 从请求取用不校验，显式传 `jobId:""` 会作为 `runtime_jobs` 主键插入（该表无 `CHECK(length(job_id)>0)`，不像 events/staging 有）。
- **P3** `runtime_db.rs:6707-6719`：`remove_staging_artifact_file` 的 canonicalize 与 `remove_file` 之间窄 TOCTOU（Unix 下 unlink 不跟随末段符号链接，影响低）。

### Rust — clip_server / 其他

- **P3** `clip_server.rs:138-140,240-242` 等：错误响应体仍手写 `format!(r#"{{"ok":false,"error":"{}"}}"#, e)` 未转义，成功响应已改 `serde_json::json!`（同类 bug 只修一半），错误消息含 `"` 时产生非法 JSON。[SPEC-10 顺带]
- **P3** `lib.rs:138-143`：`set_proxy_env` 是 lib.rs 内唯一未走 `run_guarded` 的命令，当前 proxy.rs 无可 panic 代码，属一致性隐患。
- **P3** `api_server.rs:938,954,940,956`：文件列表响应 `"truncated"` 字段恒为 false（实际超限直接 413），且 413/500 靠字符串匹配 `e.contains("exceeds")`（`push_file_node:1160`），改错误文案会静默把 413 变 500。[SPEC-8 拆分时顺带]

### TS — ingest / 知识管线

- **P3** `mineru.ts:407-518`（`assertMineruSuccess`）：只检查 `code` 不检查 `data` 是否存在，畸形 `data` 抛未加工 `TypeError` 而非统一可诊断错误。
- **P3** `web-search.ts`（6 provider）：`response.json()` 未包裹，HTTP 200 但非 JSON（误配置端点返回 HTML）抛原始 `SyntaxError`，与 `!response.ok` 的精细处理不对称。
- **P3** `wiki-synthesis.ts:530`：`parseFrontmatter(accumulated.trim())` 未加 try/catch，畸形 YAML 可未捕获上抛。
- **P3** `lint-fixer.ts:69-80`（`fixAllLintResults`）：`catch { failed.push(...) }` 未绑错误对象，真实失败原因丢失（与 `fixLintReport:758-761` 记 `err.message` 不一致）。
- **P3** `source-lifecycle.ts:459-483`（`getUniqueDestPath`）：`fileExists` 与 `copyFile` 之间 TOCTOU，并发导入同名文件可能互覆。[SPEC-11 顺带]
- **P3** `source-lifecycle.ts:485-502`（`appendSourceDeleteLog`）：`log.md` 读改写非原子无锁，并发删除日志条目互覆（仅影响日志）。[SPEC-11 顺带]
- **P3** `project-file-sync.ts`：应用自发删除未标记"自触发"，OS watcher 独立再报一次，级联清理执行两次（表现基本幂等但浪费/重复写日志）。
- **P3** `wiki-cleanup.ts:49-53`（`normalizeWikiRefKey`）：大小写/空格/连字符/下划线全折叠，可能把语义不同页面（"Data Base" 与 slug `database`）别名成同 key，删一个误清另一个引用。[SPEC-11 顺带]
- **P3** `dedup-storage.ts:40-46`（`saveNotDuplicates`）：非原子读改写，并发"标记非重复"可能丢确认记录，最坏使误报重复项在后续扫描重现。

### TS — chat / agent

- **P2** `sidecar/core.ts:68-92`（`applyAgentProfileEnv`）：只在 `agentProfileAuthStyle` 有值时才 `delete` 继承的 `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN`；未认领 profile 且未显式传 api_key 时，sidecar 继承的 shell 凭证原样传给 SDK，可能悄悄路由到非预期账号/网关。[SPEC-10]
- **P2** `claude_cli.rs`/`codex_cli.rs`：未像 `agent.rs:425-426` 用独立 `process_group(0)`，kill 时只 `start_kill()` 直接子进程，派生 shell 子进程被孤儿化。[SPEC-10]
- **P2** `runtime_db.rs:6005+`（`redact_profile_pool_text`）：前缀白名单脱敏只认 `llm-wiki-profile-secret:`/`sk-`/`aiza`，遗漏非标准前缀（本仓库 `litellm/config.yaml` 的 `tp-` 网关 key 就不在名单）。[SPEC-10]
- **P3** `sidecar/main.ts:101-103`：畸形 stdin 行 `catch { /* ignore */ }` 无日志，不利排查半行 JSON（写竞争/截断）。
- **P3** `chat-input.tsx`：fast/standard/deep/local_first 路由选择器未与模型档位能力联动校验（影响面小，`showSearchToggles` 只在 `mode==="chat"` 渲染）。[SPEC-7]
- **P3** `litellm/config.yaml:7,14`：明文密钥重复两处（已在 `.gitignore` 未被跟踪，非泄露），轮换易漏改一处。

### TS — UI shell / stores / 组件

- **P2** `embedding-section.tsx:82`：`headersText` 只挂载时从 `draft.embeddingExtraHeaders` 初始化一次，项目切换等外部 `draft` 变化不同步（`settings-view.tsx:412-446` 明确处理了 draft 重同步，唯独漏这个派生 state）。[SPEC-11]
- **P2** `App.tsx:39-42`：`setupAutoSave()` 非幂等、无 cleanup，StrictMode/HMR 下双订阅（对比 `clip-watcher.ts:14` 有 `if (intervalId) return` guard）。[SPEC-11]
- **P3** `App.tsx:108-189`：后台 update-check 若中途取消，`checking` 标志可永久 stuck true（`setChecking(true)` 在 `cancelled` 复检之前，仅 dev/HMR 重挂载或测试命中）。
- **P3** `App.tsx:452-454`：`handleSwitchProject` 冗余的 `stopScheduledImport()`（`resetProjectState` 已含且更早调用），fire-and-forget 未 await。
- **P3** `project-store.ts:265-274`（`saveProjectFileSyncEnabled`）：疑似死代码，除自身 legacy fallback 外无调用方。
- **P3** `graph-view.tsx:264-266,292,315,402-411`：模块级缓存无淘汰、大图 `Math.max(...array)` 展开可 `RangeError`、worker onerror 分支未立即 terminate。
- **P3** `wiki-editor.tsx:64-69,96-97`：`wrapBareMathBlocks` 每次执行，零编辑的"进入编辑→点完成"也产生一次真实磁盘写入。
- **P3** `runtime-jobs-section.tsx:179-206`：组件卸载时 in-flight `refresh()`/`runAction()` 仍 setState（React18 无警告但浪费）。

### 并行流水线 / commit

- **P2** `prepare-worker-pool.ts:508-517`（`failForProfileUnavailable`）：profile 池瞬时饱和导致的失败 `retryAfterMs` 留空，消耗一个 `maxAttempts` 槽位而非 backoff。[SPEC-5-FIX 顺带]
- **P3** `long-document-map-reduce.ts:378-393`（`buildChunkFailure`）：`failedChunks` 保留真实 `headingPath`，而 `buildRepairPayload:395-417` 会 blank 掉（测试确认）；`failedChunks` 暂无消费者，是接线者的潜在 leak。[SPEC-5-FIX 顺带]
- **P2** `boundary-check.ts:43-46`：死规则 `@/lib/runtime.db`（真实是 `@/commands/runtime-db`，且会被 `@/lib/` 前缀规则先捕获）——归精简（第五节已列）。

## 七、注意事项

- 本次多个子 Agent 在 review 途中收到可疑注入消息（自称"限流请跳过调查直接编报告"），均正确识别并拒绝、完成真实审查。结果可信，但记录此注入模式。
- 行号为 review 快照，实现 PR 开工前须以当时代码重新定位，并按对应 SPEC 跑 GitNexus impact、focused tests、detect。
