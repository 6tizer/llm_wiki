# SPEC-6 PR1 执行计划：Derived Stale Marker 消费基础设施

> 类型：PR 级执行计划 | 状态：design complete / ready for implementation | 覆盖：#189 | 轨道：derived | 分支：codex/spec6-pr1-marker-infra | lane：full + Adversarial Domain（并发/lease）| 创建：2026-07-04
>
> 场景矩阵（gate 凭据）：[pr1-adversarial-matrix.md](./pr1-adversarial-matrix.md)。SPEC 级顺序：[prs-implementation-plan.md](./prs-implementation-plan.md)。

## 设计决策（Commander 裁定，依据 facts + adversary 矩阵）

1. **lease 载体 = 方案 A：复用 `runtime_jobs`（kind `"derived-rebuild"`）**。lease 回收调度器已生产接线（lib.rs:465-468），attempt/max_attempts/retry-wait/heartbeat/cancel 全部现成。不自建 marker 侧 lease 列。
2. **marker↔job 映射：一个 derived-rebuild job = 折叠后的一批 marker**（同 `(layer, affected_path)` 组）。job payload 记录 `{layer, affectedPath, markerIds[], baseVersion, inputHash, reason}`。
3. **claim 原子性**：「按 (layer,affected_path) 折叠 pending marker → 全组转 claimed → 创建 job（queued）」在**同一个 `with_runtime_writer` 事务**内完成，新命令 `runtime_derived_marker_claim_batch`。不得在 writer 闭包内嵌套调用其他 `with_runtime_writer` 函数（非重入 Mutex 死锁）。认领 job 本身仍走现有 `runtime_job_claim_by_kind`（两次顺序调用，非嵌套）。
4. **折叠语义**（矩阵 T2/T4/D1/D2/D3/D4）：
   - 分组键严格 `(layer, affected_path)`（D4）；只折叠事务内 SELECT 到的快照，晚到 marker 保持 pending（T2）。
   - 组的 `base_version`/`input_hash` 取 `marked_at_ms` 最大一条的**真实行值**（T4/D3，不自造复合值）。
   - 组内若最新一条 `reason="delete"`（input_hash null），job payload 标记 delete intent，消费者只做清理不 rebuild（D2）。
   - 被折叠的全部 marker_id 记入 job payload；complete/fail 按**该 id 集合**批量转移状态（T3）。
5. **状态流转命令**（marker 侧新增，均校验前置状态）：
   - `runtime_derived_marker_claim_batch`（pending→claimed + 建 job，见 3）
   - `runtime_derived_marker_complete_batch`（claimed→done，携带 job_id + marker_ids，校验 job 当前 state 与 holder 一致——僵尸完成 L5/P3 防线；job 侧本身走 runtime_job_complete）
   - `runtime_derived_marker_release_batch`（claimed→pending 或 →failed/cancelled，供 job fail/cancel 后的显式 marker 归位；不覆盖 lease-timeout 的自动路径，见下一条）
   - **孤儿 marker 自愈（修订，P0 fix）**（R1/L1/P1）：lease 回收调度器把 job 转 `retry-wait` 时，claimed marker **保持 claimed、归属不变**（不再归位 pending）——恢复路径是 `runtime_job_retry` 把**同一个 job_id** 拉回 queued 再 `runtime_job_claim_by_kind` 重新认领，attempt 计数在同一 job 上连续递增，`DEFAULT_MAX_ATTEMPTS` 才真正生效。job 达 max_attempts 转 `failed`（终态）时，同一事务内 marker 同步转 `failed`（毒 marker 收敛）。
     - **踩过的坑**：早期实现在 retry-wait 分支也把 marker 归位 pending，导致每次崩溃后 `claim_batch` 都为同一组铸造一个全新 attempt=0 的 job——毒 marker 永不收敛，且恢复中的旧 job 可能与新 job 同时持有对同一批 marker 的"认领"语义，产生覆盖竞争。
     - **PR2+ 消费者契约**：消费循环必须同时轮询两个信号——(a) 新出现的 pending marker（喂给 `claim_batch`）与 (b) 处于 `retry-wait` 的 `derived-rebuild` job（喂给 `runtime_job_retry` 恢复原 job）。只轮询 pending marker 永远看不到毒 marker 的重试过程（同一事务/文档见 `src/core-runtime/derived-rebuild/index.ts` payload 类型注释）。
   - **P2 半态（complete 写入失败留半态）的落地依赖**：本 PR 的 complete_batch 把 marker 状态转移与 job 完成绑在同一事务内，避免了"marker done 但 job 未完成"这类组合半态；但**两次调用之间**（产物已落盘、`complete_batch` 尚未调用/中途崩溃）产生的半态，本 PR 不提供额外事务保证——PR2+ 的 rebuild 实现**必须幂等**：崩溃后重新执行同一 job 必须能安全重新产出/覆盖同一份派生产物，再调用 `complete_batch` 收尾，而不能假设"产物已存在即代表已完成"。
6. **游标查询**：`_list` 请求增加 `sinceMarkedAtMs: Option<i64>` + `sinceMarkerId: Option<String>`（复合游标，匹配现有 ORDER BY marked_at_ms ASC, marker_id ASC），响应带 `nextCursor`。向后兼容（旧调用不传即全量）。
7. **7 层缺口处置**：本 PR **不**扩 `COMMIT_DERIVED_STALE_MARKER_LAYERS`（避免产生无消费者的 marker，Wiring Gate 哲学）。`search` 层随 PR3（消费者落地时）补；`index_export`/`overview` 由 PR5 显式 job 按需触发（reason=`manual_rebuild`）。在 contract 注释记录该口径。
8. **消费循环宿主不在本 PR**：PR1 只交付 API + TS 侧薄封装（`src/commands/runtime-db.ts` 增加对应 invoke + `src/core-runtime/derived-rebuild/` 常量与类型 `DERIVED_REBUILD_JOB_KIND`）。实际 worker 循环由 PR2+（embedding）落地。**PR body 必须显式记录该 deferred wiring** 并写入 SPEC-6 收口清单。
9. **不拆 runtime_db.rs**：mod split 归 SPEC-8 PR10（maint 轨，本 PR merge 后的窗口执行）。本 PR 按现有单文件分区惯例插入代码。

## 改动面

- `src-tauri/src/commands/runtime_db.rs`：3 个新命令 + request/response struct + 折叠/批量转移 SQL + `runtime_job_lease_timeout_for_project` 扩展 + `_list` 游标 + 测试。
- `src-tauri/src/lib.rs`：注册新命令。
- `src/commands/runtime-db.ts`：新命令 TS 封装 + 类型。
- `src/core-runtime/contract/index.ts`：层缺口口径注释（不改值集）。
- `src/core-runtime/derived-rebuild/`（新目录）：`DERIVED_REBUILD_JOB_KIND` 常量、payload 类型、折叠结果类型。
- migration：marker 表无新列（方案 A 不加 lease/attempt 列）→ **无 schema migration**，只有新命令。若实现中发现必须加列，停下来回报 Commander。

## 测试计划（矩阵映射，全部要求 sabotage 自验）

Rust（temp_project fixture + Arc<Barrier> 并发模式，模仿 :15495+）：
- T1 双线程并发 claim_batch 同组恰一成功；T2 折叠快照不吞晚到 marker；T3 complete 只动自己集合；T4/D3 组值取最新真实行；D1 一次 claim+complete 后 pending=0；D2 delete intent 折叠；D4 跨 layer 独立；L5/P3 迟到/取消后的 complete 被拒；L1 lease timeout → marker 归位 pending（不依赖手工 expire，照 :15337 先例）；P1 max_attempts 后 marker 收敛 failed；游标分页不重不漏。
- L4 时钟回拨：用显式 now 参数构造，断言不永久卡死。
- 每个并发测试须注明 sabotage 验证方式（见矩阵 6.2），并在实现期实际执行一次 sabotage 确认转红。

TS：runtime-db.ts 封装的 fake adapter 单测（模仿 commit-integration.test.ts 的 fakeRuntime calls 模式）。

## Gate 计划

- lane：full；对抗域主力 gate = **内审 opus + 编译级 probe 复现**（矩阵逐格），Codex/外部 Architect 为副（接口一致性）。
- Simplicity：internal Simplifier（Rust DB 大文件新增，重点查重复包装/单调用点抽象）。
- Wiring Gate：`orphan-check.sh main` + deferred wiring（消费循环归 PR2+）显式记录于 PR body。
- 提交前：`cargo test` runtime_db、`npm run typecheck`（tsc --build）、`/usr/bin/git diff --check`、`npx gitnexus detect-changes -r llm_wiki-pipeline --scope staged`。
- runtime verify：本 PR 无用户可见流程（纯 API 基座），E2E 栏记录「fixture 级验证 + PR2 接线时补真实路径 verify」。
