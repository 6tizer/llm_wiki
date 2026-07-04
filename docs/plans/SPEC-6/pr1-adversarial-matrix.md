# SPEC-6 PR1 对抗场景矩阵（design-first gate 凭据）

> 类型：Adversarial Domain 场景矩阵（gates.md 设计先行阶段产出）| 生成：2026-07-04，adversary agent（opus，只读）| grounding：main tip 13231884 实码核实 | Coder 必须按全矩阵一次实现，Reviewer 逐格验证

## 0. Grounding 关键事实

- marker 表**无 holder/lease/expires/attempt 列**，status 的 claimed/done/failed/cancelled 无写入路径，_list 无 cursor。
- `deterministicMarkerId` 含每次提交都新的 artifactId → 同 (layer,path) 多条永不合并的 pending。
- `RUNTIME_DB_WRITE_LOCK`（runtime_db.rs:139, with_runtime_writer :1779-1785）进程级**非重入** Mutex：writer 闭包内嵌套调用另一个 with_runtime_writer 函数 = 同线程死锁；body panic → 锁中毒 → 全部写路径失败到进程重启。
- profile-pool/commit-budget 自愈模式：claim 事务开头物理 UPDATE flip 过期行（expire_claims_by_ttl_tx :7662-7674）+ 读时 expires 过滤，**双保险缺一不可**（只过滤会撞不含 expiry 的 UNIQUE 部分索引，SPEC-5-FIX PR4 教训）。
- job lease 回收调度器已生产接线（lib.rs:465-468，15s tick，每 tick 重读 ProjectRootState）。
- `runtime_job_cancel_for_project`（:2916-2957）纯 DB 翻转不触达 worker → cancel 语义依赖 complete 侧校验。
- SPEC-11 PR7 的 withProjectLock 未覆盖 marker 消费。

## 1. 交错时序

| # | 场景 | 预期正确行为 | 可能怎么错 | 攻击/复现样例 |
|---|------|------------|-----------|--------------|
| T1 | 双 worker 同时 claim 同一 marker | 恰一个成功（条件 UPDATE affected_rows==1），另一个得 already-claimed | SELECT-再-UPDATE 两步实现：第二个 worker 误判成功（须复刻 :2668-2687 loop-and-reexclude 原子模式） | 并发 claim(X, w1)/(X, w2)，断言恰一成功恰一 already-claimed |
| T2 | claim 与新 commit 写同 (layer,path) 交错 | claim 折叠的是 claim 时刻的 pending 快照；折叠 SELECT 之后到达的新 marker 保持 pending | 折叠 UPDATE 把「晚到未纳入 base_version 计算」的新 marker 一并标 claimed → 该变更从未被真正消费 | claim 事务前一刻另一进程提交新版本，断言晚到 marker 仍 pending |
| T3 | complete 与 re-mark 交错 | complete 只影响本次 claim 认领的具体 marker_id 集合 | complete 按 (path,layer,status='claimed') 定位会误伤别人（另一 holder）新认领的行 | A claim 后 B 认领同 path 新 marker，断言 A 的 complete 只动 A 的集合 |
| T4 | debounce window 内连续 commit 合并 | 合并结果的 base_version/input_hash 取 window 内**最新**（marked_at_ms 最大）一条 | 取最早一条 → rebuild 针对过期输入 → 假 ready 后立刻又 stale 抖动 | 100ms 内提交 3 次(hash1→2→3)，断言合并结果 base_version==hash3 |
| T5 | cursor 读取与并发写入 | 增量拉取不重不漏；无 cursor 时消费必须幂等 | 无 cursor+无去重 → 堆积超 MAX_LIMIT=500 时忙 worker 永远只见抢不到的头部 500 条，忙等放大 | 600 条 pending，两个 poll 循环并发，断言吞吐不退化为忙等 |

## 2. lease 生命周期

| # | 场景 | 预期正确行为 | 可能怎么错 | 攻击/复现样例 |
|---|------|------------|-----------|--------------|
| L1 | worker 崩溃回收（方案 A：runtime_jobs） | 回收调度器 15s tick 自动 job→retry-wait/failed，lease→expired | 调度器只在进程存活+项目打开时跑：app 整体崩溃 → 冷启动窗口到下次启动首个 tick | job 停 running lease 不续：a) 进程存活 >15s 自动回收；b) 进程重启后首 tick 即回收 |
| L2 | worker 崩溃回收（方案 B：自建 read-time expires） | 后续任意 claim 尝试在事务开头 flip 过期行 | 低频 layer 无人再 claim → 过期 claimed 永久滞留，_list(status=claimed) 误导 UI | 制造过期 claimed 且无后续 claim，检查 UI/诊断显示 |
| L3 | 续租失败/TTL 不足 | 心跳宽限（5s min interval vs 120s TTL 比例）；单次延迟不误回收 | embedding 大文件 rebuild >120s → 正常 worker 被误判过期 → 触发 L5 | 模拟 150s rebuild，断言心跳续租覆盖或 TTL 安全边际有测试卡住 |
| L4 | 时钟回拨 | expires 比较不产生永久死锁/永久误回收 | 回拨使本该过期的 claim 被判有效，阻止合法回收 | 用显式 now 参数构造回拨（now=T claim 后回拨到 T-1e6），断言不永久卡死 |
| L5 | 僵尸完成（lease 过期瞬间 worker 仍在写） | complete 校验 holder/lease token/status='claimed'，迟到 complete 被拒 | complete 只按 marker_id 定位 → 迟到 complete 覆盖新 worker 的正确结果或把 retry 中的行错标 done | A claim(token T1)→过期回收→B 重新认领跑完→A 迟到 complete(T1)，断言失败(stale-lease) |

## 3. poison/失败路径

| # | 场景 | 预期正确行为 | 可能怎么错 | 攻击/复现样例 |
|---|------|------------|-----------|--------------|
| P1 | 毒 marker 无限重试 | attempt 计数+上限（照 runtime_jobs.attempt/max_attempts），超限转 failed 不再被 claim | marker 表无 attempt 列；只加 lease 不加计数 → claim→崩溃→回收→再 claim 永久空转，每轮抢占全局写锁 | 必然 panic 的 affected_path 跑 20 轮，断言 N 轮后收敛 failed |
| P2 | complete 写入失败留半态 | 状态转移+产物落盘+下游通知单事务/明确恢复路径 | 两次调用间崩溃 →「产物已生成但 marker 仍 claimed/pending」无判定依据 | 两调用间 kill 进程，重启后断言组合合法且有恢复路径 |
| P3 | cancel 与 in-flight rebuild 竞争 | cancel 后 DB 立即 cancelled；complete 拒绝对非 claimed 行写入 | cancel 纯 DB 翻转不触达 worker；complete 不检查当前状态 → cancel 被 complete 覆盖回 done | claim→cancel→complete 顺序调用，断言 complete 被拒、终态 cancelled |

## 4. 重复与去重

| # | 场景 | 预期正确行为 | 可能怎么错 | 攻击/复现样例 |
|---|------|------------|-----------|--------------|
| D1 | 同 (layer,path) 多条 pending | claim 折叠认领**整组**，complete 整组转 done | 只处理最新一条 → 其余永久 pending，污染 pending 计数/告警/UI | 同路径提交 5 次产 5 条 pending，一次 claim+complete 后断言 pending=0 |
| D2 | delete-intent 与 commit marker 共存 | 识别最新是 delete → 跳过 rebuild 只清理；不得先清理又因旧 commit 行重新生成 | 统一按 commit 语义处理 → delete 后幽灵条目重新写回 | 提交→立即删除同文件，断言消费后不重新产生派生条目 |
| D3 | stale input_hash 判定 | 完成记录落盘的 base_version 必须是真实存在行的值（保持纯等值比较契约），且为最新 | 合并逻辑自造复合 base_version 字符串 → 破坏不透明 token 等值契约；物理删除旧行 → 丢审计 | 合并 3 条(hash1→2→3) complete，断言落盘 base_version==hash3 |
| D4 | 同 path 不同 layer 独立 | (embedding,/a.md) 与 (graph,/a.md) 状态机完全独立 | 折叠 SQL 漏 layer 于 GROUP BY/WHERE → 跨 layer 误伤 | 同路径产 embedding+graph 两条，只处理 embedding，断言 graph 仍 pending |

## 5. 重入/边界

| # | 场景 | 预期正确行为 | 可能怎么错 | 攻击/复现样例 |
|---|------|------------|-----------|--------------|
| R1 | 应用重启时 claimed 未 complete | 孤儿 claimed 有明确重新可认领路径；诊断不永久显示"处理中" | 方案 B 若 _list 不做懒惰翻转 → UI 永久假"building"（原 holder 进程已不存在，expires 是唯一真相） | claim 后无 complete 模拟重启，断言 TTL 后可被重新 claim 且诊断不误导 |
| R2 | 项目切换 | 消费循环每周期重读当前项目（照调度器 :6120 模式）；前端轮询须对齐 SPEC-11 PR8b stale/unmount 丢弃 | project_root 启动时捕获一次 → 切项目后继续对旧项目 claim/complete 跨项目串扰 | 打开 A 启动轮询→切到 B，断言无针对 A 的后续调用 |
| R3 | 同 holder 重复 claim（重入） | 幂等返回或错误可辨识「自己已持有」vs「被别人拿走」 | already-claimed 一律当真错误 → 误报失败 | 同 holder 连续两次 claim 同 marker，断言第二次处理路径清晰区分 |
| R4 | 与项目删除锁交互 | rebuild 不对「正被删除」路径写回派生数据；删除后遗留 marker 被清理 | marker 消费不感知 withProjectLock → 文件已删但索引重新写回（幽灵条目，D2 的另一触发路径） | 级联删除同时 claim 同路径 embedding rebuild，断言终态无死索引 |

## 6. 结论

### 6.1 lease 方案对比与推荐

**推荐方案 A：复用 `runtime_jobs`（kind:"derived-rebuild"）**。前提（lease 回收调度器已生产接线 lib.rs:465-468）已核实满足。理由：崩溃回收/心跳续租/attempt-retry 状态机全是 SPEC-5-FIX 多轮对抗审查加固过的现成设施；R1 孤儿有明确兜底（调度器首 tick）；方案 B 的「无人认领则永不自愈」对低频 layer（search/index_export/overview）风险更大。代价与硬约束：
- marker↔job 映射必须清楚：**一个 job 对应折叠后的一批 marker**，D1/D4 去重发生在 job 创建时；
- 「折叠 marker 转 claimed + 创建 job + 建 lease」必须在**同一个 with_runtime_writer 事务**内原子完成（防 T2/T3），且不得嵌套调用其他 with_runtime_writer 函数（非重入死锁）；
- 若实测单层 rebuild 常超 DEFAULT_LEASE_TTL_MS=120s（L3），为 derived-rebuild kind 单独配置 TTL 或依赖心跳，不改全局默认。

### 6.2 必须显式 gate 写法 + sabotage 自验的并发回归测试

（先例：SPEC-11 锁互斥安慰剂测试教训——测试必须证明「去掉修复会转红」）

- **T1**：sabotage=改回 SELECT-后-无条件-UPDATE 应转红（检出双 worker 都"成功"）。
- **T2/T3**：sabotage=折叠 SQL 去掉 layer/时间窗约束，应捕获晚到 marker 被误纳。
- **L1**：不依赖手工 expire 调用的自愈验证（照 SPEC-5-FIX PR4 四个测试先例），sabotage=去掉调度器注册应转红。
- **L5**：sabotage=去掉 complete 的 holder/token/status 校验，「过期→被重新 claim→原 holder 迟到 complete」全链路应转红。
- **P1**：真实跑 N 轮 claim→失败→回收，断言收敛 failed；sabotage=去掉 attempt 上限。
- **P3**：sabotage=去掉 complete 的 claimed 前置校验，cancel-后-complete 应转红。
- **D1/D2**：sabotage=去掉 (layer,affected_path) 分组折叠，应捕获残留 pending / 幽灵条目。
- **R2**：sabotage=project_root 改回启动时捕获一次，应捕获切项目后对旧项目的调用。
