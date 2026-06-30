# SPEC-2: Work Runtime / DB / 并行调度底座

> 类型：阶段 SPEC | 状态：completed | 覆盖：#184 | 依赖：SPEC-1 shell/core boundary

## 目标与成功标准

建立本地 Work Runtime：用 SQLite `runtime.db` 做中间态调度账本，Markdown 继续是用户长期资产和 source of record。

成功标准：

- runtime 能记录 job、lease、heartbeat、retry、cancel、event、profile usage、derived stale marker 存储。
- app 重启后能恢复 pending/running/failed/cancelled 状态。
- worker 不在 prepare 阶段写 final Markdown。
- SQLite 只承担短事务 metadata，不保存大段 LLM 输出 blob。
- SQLite 写入统一经过 runtime DB actor / single-writer channel；worker claim、heartbeat、event append、retry update 都不直接多线程写 DB。
- `runtime.db` 第一版必须有 kill switch / feature flag；禁用后回退到当前 JSON/store + Markdown 路径，且不破坏已有项目打开。
- runtime DB / scheduler / event API 不依赖 React render、Zustand store 或 Tauri webview lifecycle；Tauri/React 和未来 Swift shell 都通过同一 contract 使用。

## 关键设计决策

- 采用 SQLite + WAL；不引入本地 Postgres/PGlite/DuckDB 作为第一版 runtime ledger。
- staging artifact 放磁盘，DB 保存 path/hash/status/metadata。
- staging artifact commit 成功后删除；failed/cancelled artifact 按可配置 TTL 由 maintenance job 回收，DB 记录 GC 状态。
- 运行模型是固定领域 DAG，不做通用 workflow 产品。
- dirty/stale 命名边界：SPEC-2 负责存储 derived stale marker；SPEC-3 负责 commit 后写入；SPEC-6 负责消费并调度 rebuild。
- commit-path concurrency budget 是 runtime 调度资源之一：per-path serial、跨 path 总预算由 SPEC-2 暴露给 SPEC-3/SPEC-5。
- Swift 可用判据：schema 只使用 SQLite 标准 SQL 类型和 portable constraints，不依赖 Postgres/DuckDB 专有类型或 JSON 操作符。
- SQLite 并发模型：WAL 允许多读单写，但本系统不让 worker 直接竞争写锁。所有写操作通过单写 actor 串行提交，读操作可走短事务 snapshot。
- heartbeat / progress 写入必须有最小间隔，避免高频进度事件把 SQLite 单写锁打满。第一版默认值见下表，可在后续实现 PR 中按实测调整。
- consistency model：
  - Markdown = committed truth。
  - `runtime.db` = job/event truth。
  - staging artifacts = uncommitted candidates。
  - derived indexes = disposable caches。

第一版调度默认值：

| Setting | Default | Reason |
|---------|---------|--------|
| lease duration | 120s | 给长 LLM call 留足空间，靠 heartbeat 延长。 |
| heartbeat min interval | 5s | 降低 DB 写放大。 |
| progress event min interval | 2s per job | UI 可见但不刷爆 event log。 |
| retry max | 3 | 避免坏输入无限重试。 |
| retry backoff | 30s, 2m, 10m | 区分瞬时 provider 抖动和持续失败。 |
| failed artifact TTL | 7d | 保留排障窗口，避免无限增长。 |

## 预期 PR 拆分

1. Runtime ADR + schema/state-machine hard gate：定义 tables、state machine、operation names、feature flag / kill switch、single-writer DB actor；该 PR 合并前，SPEC-3/4 不做依赖 runtime schema 的集成实现。
2. SQLite init / migration / health check。
3. Job ledger + lease / heartbeat / retry / cancel。
4. Commit-path concurrency budget。
5. Event log + progress API。
6. Staging artifact GC：commit-success cleanup、failed/cancelled TTL cleanup。
7. Minimal runtime UI：队列状态、暂停/恢复/取消。

## 验证策略

- Rust/TS 单测覆盖 job state transition、lease timeout、retry limit、cancel、restart recovery。
- 并发测试覆盖多个 worker claim 同一 job 不重复执行。
- migration 测试保证空项目和已有项目均可创建 `runtime.db`。
- `pnpm lint`、相关 Rust tests、`git diff --check`、GitNexus impact/detect。

## Gate 结论摘要

本 SPEC 随当前 docs PR 通过 PR-level gate；详见 [SPEC-0](./spec-0-roadmap-baseline.md) 的统一 gate 摘要。实现 PR1-PR7 已合并至 `156f9db`，后续依赖进入 SPEC-3 Markdown commit layer。后续修改 runtime DB / scheduler / event API 仍必须重新审查 SQLite 单写 actor、migration rollback、kill switch、scheduler state machine 和 SPEC-1 shell/core boundary。

## Non-goals / Follow-up

- 不替换 Markdown 为数据库 wiki。
- 不实现 full parallel ingest。
- 不重写 vector store。
- 不做 Swift UI rewrite；但 schema 和 API contract 必须保持 SPEC-9 Swift shell 可用。
