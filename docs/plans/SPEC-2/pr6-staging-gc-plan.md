# SPEC-2 PR6: Staging Artifact GC Plan

> 类型：PR 执行计划 | 状态：in progress | 分支：`codex/spec-2-pr6-staging-gc` | 基线：`c8d728c` | Commander：Codex

## 目标

为 SPEC-2 Work Runtime 增加 `staging-artifacts` schema family：记录 staged artifact 的 project-local 路径、hash、状态和 TTL 元数据，并提供 commit-success cleanup 与 failed/cancelled TTL GC。

成功标准：

- DB 只保存 artifact metadata，不保存大段 LLM 输出 blob。
- staging artifact 必须位于 `<project>/.llm-wiki/runtime/staging/` 下，拒绝绝对路径、drive-prefixed path、UNC path、`..`、空 segment、symlink/canonical escape。
- SPEC-3 已完成 final Markdown commit 后，显式调用 SPEC-2 cleanup；SPEC-2 只清理 runtime staging 目录内文件并记录 cleanup fact，不承担 commit 语义。
- failed/cancelled artifact 在默认 7d TTL 前保留，TTL 后由 GC 删除；commit-success cleanup 和 TTL GC 都幂等。
- disabled/no-project/旧 runtime DB 行为和 PR2-PR5 一致。

## 范围

实现范围：

- `src-tauri/src/commands/runtime_db.rs`
  - 新增 `staging-artifacts` family/version。
  - 新增 `runtime_staging_artifacts` 表、索引、migration bookkeeping。
  - 新增 artifact record/status/GC 相关 Tauri command 和内部 `*_for_project` 函数。
  - 新增 path normalization 与 staging-root containment 校验；删除前必须二次校验当前 canonical path 仍在 staging root 内。
  - 新增 Rust 单测覆盖 cleanup/TTL/GC/path/legacy DB 行为。
- `src-tauri/src/lib.rs`
  - 注册新增 Tauri commands。
- `docs/plans/README.md`
  - 更新 PR5 merged，登记 PR6 plan in progress。

不做：

- 不写 final Markdown commit layer；SPEC-3 仍负责 commit 语义。
- 不由 SPEC-2 判断 commit 是否成功；SPEC-2 只响应 SPEC-3 的 explicit cleanup request。
- 不存 artifact 内容或 LLM 输出 blob 到 SQLite。
- 不实现后台 scheduler；PR6 暴露显式 GC operation，后续 maintenance job 调用。
- 不改 UI；PR7 才做 minimal runtime UI。
- 不物理 purge `deleted` DB rows；PR6 保留逻辑删除记录供审计，后续 maintenance PR 再定期 purge。

## 数据模型草案

`runtime_staging_artifacts`：

- `artifact_id TEXT PRIMARY KEY`
- `job_id TEXT NOT NULL`，FK `runtime_jobs(job_id)`
- `artifact_path TEXT NOT NULL`，staging-root-relative display path；DB CHECK 限制 UTF-8 byte length，不超过 `1024` bytes。
- `artifact_hash TEXT NOT NULL`；DB CHECK 限制 UTF-8 byte length，不超过 `128` bytes。
- `status TEXT NOT NULL CHECK(status IN ('pending', 'committed', 'failed', 'cancelled', 'deleted'))`
- `created_at_ms INTEGER NOT NULL`
- `updated_at_ms INTEGER NOT NULL`
- `expires_at_ms INTEGER`
- `deleted_at_ms INTEGER`
- `last_error TEXT`；DB CHECK 限制 UTF-8 byte length，不超过 `4096` bytes。

DDL guard：

- `artifact_path`、`artifact_hash`、`last_error` 都使用 `length(CAST(... AS BLOB))` 做 byte-length CHECK，和 PR5 event/progress payload 规则一致。
- `MAX_STAGING_ARTIFACT_PATH_BYTES = 1024`，`MAX_STAGING_ARTIFACT_HASH_BYTES = 128`，`MAX_STAGING_ARTIFACT_ERROR_BYTES = 4096`。
- `job_id` 带 `FOREIGN KEY(job_id) REFERENCES runtime_jobs(job_id)`；record insert/update 前在同一事务内调用 `ensure_job_exists`。
- `STAGING_ARTIFACTS_FAMILY = "staging-artifacts"`，`STAGING_ARTIFACTS_VERSION = 1`。

索引：

- `runtime_staging_artifacts_job_idx(job_id, status)`
- `runtime_staging_artifacts_gc_idx(status, expires_at_ms)`

TTL：

- 常量 `DEFAULT_FAILED_ARTIFACT_TTL_MS = 604_800_000`，来自 SPEC 表格的 7d 默认值；当前 ADR 尚无 artifact TTL config key，PR6 不新增 config surface。
- 可选 TTL 只允许正数到 `MAX_FAILED_ARTIFACT_TTL_MS = 2_592_000_000` 范围内，使用 `checked_add` 计算 `expires_at_ms`，溢出返回 `invalid-ttl`。
- `failed` / `cancelled` 写入时设置 `expires_at_ms = now + ttl`。
- `pending` / `committed` 不设置 TTL。
- `committed + deleted_at_ms` 表示 commit-success cleanup 已删除文件；`deleted` 表示 failed/cancelled artifact 经 GC 删除或文件已不存在且 GC 幂等完成。

状态转移：

| From | Allowed To | Owner | Notes |
| --- | --- | --- | --- |
| absent | `pending` | `record` | 插入新 artifact；`artifactId` 可省略并由 Runtime 生成。 |
| `pending` | `failed` / `cancelled` | `record` | 必须设置 `expires_at_ms`。 |
| `pending` | `committed` | `commit_success` | SPEC-3 已完成 commit 后调用；cleanup 文件不存在也视为成功。 |
| `failed` / `cancelled` | `deleted` | `gc` | 仅 `expires_at_ms <= now` 后允许。 |
| `committed` | `committed` | `commit_success` | 幂等返回当前 committed row。 |
| `deleted` | `deleted` | `gc` | 幂等返回/计数，不复活。 |

禁止：

- `record` 不允许直接写 `committed` 或 `deleted`。
- `committed` / `deleted` 是终态；禁止回退到 `pending`、`failed`、`cancelled`。
- `commit_success` 只允许处理 `pending` 或已 `committed` row；对 `failed` / `cancelled` / `deleted` 返回 `invalid-state`，不删文件、不改 DB。
- 已存在行 update 必须带稳定 `artifactId`；不得通过相同 path/hash 隐式覆盖终态。

## API / 命令草案

- `runtime_staging_artifact_record(request)`
  - 记录或推进 artifact metadata 状态。
  - request: `artifactId?`, `jobId`, `artifactPath`, `artifactHash`, `status?`, `ttlMs?`, `lastError?`。
  - 新建默认状态 `pending`；`failed/cancelled` 可带 TTL，默认 7d。
  - Tauri command 内部取 `now_ms()`；测试走 `runtime_staging_artifact_record_for_project(..., now)` 注入 now。
- `runtime_staging_artifact_commit_success(request)`
  - request: `artifactId`。
  - 表示 SPEC-3 已完成 final Markdown commit，Runtime 删除 staging 文件并把状态推进到 `committed` + `deletedAtMs`。
  - 这是 explicit cleanup request，不表示 SPEC-2 执行或验证 commit；删除范围仅限 runtime staging root。
  - 重复调用 committed row 时幂等返回当前 row。
- `runtime_staging_artifact_gc(request?)`
  - Tauri request 不暴露 `nowMs`；Tauri command 内部取当前时间，测试走 `runtime_staging_artifact_gc_for_project(..., now)` 注入 now。
  - 删除 `failed/cancelled` 且 `expires_at_ms <= now` 的 artifact 文件，状态更新为 `deleted`。
- `runtime_staging_artifact_list(request?)`
  - request: `jobId?`, `status?`, `limit?`。
  - 默认 limit `100`，最大 `500`，按 `updated_at_ms ASC, artifact_id ASC` 稳定排序。
  - 旧 DB 或无表返回空，不触发 migration；必须使用 read-only open + `table_exists("runtime_staging_artifacts")` 模式。

所有 request 使用 `deny_unknown_fields`。

写命令行为：

- `record` / `commit_success` / `gc` 走 `with_runtime_writer` 和 `open_staging_artifacts_runtime_locked`，会按现有 forward-only 模式初始化 `jobs` 与 `staging-artifacts` schema。
- `list` 是 snapshot read，不迁移旧 DB。
- PR5-only DB 上 `record` 会 forward migrate 并写入；`commit_success` 若无 artifact row 返回 `artifact-not-found`；`gc` 会初始化 schema 后 no-op 返回空结果。

## 数据流

1. Worker 生成 staged materialized artifact 到 `<project>/.llm-wiki/runtime/staging/<safe-relative-path>`。
2. Worker 调用 `record` 写入 path/hash/status metadata。
3. SPEC-3 commit 成功后调用 `commit_success`；Runtime 在 staging root 内删除对应 staging 文件并记录 cleanup fact。
4. Job failed/cancelled 时调用 `record` 更新 status 和 TTL；文件保留排障。
5. 后续 maintenance job 调用 `gc`；Runtime 删除过期 failed/cancelled 文件并把记录标为 `deleted`。
6. UI/diagnostic 通过 `list` 读 metadata snapshot。

删除顺序与恢复：

- record 时在 `runtime_db.rs` 内新增 `normalize_staging_artifact_path`：复用 `normalize_affected_path` 的 segment-based 拒绝策略（drive prefix、绝对路径、UNC、尾斜杠、空 segment、`.`、`..`），但不强制 `.md` 后缀；输出 staging-root-relative display path。
- 每次删除前用 `staging_root.join(artifact_path)` 重新解析目标，并做 canonical containment 校验，确认当前 canonical path 仍在 `<project>/.llm-wiki/runtime/staging/` 内。删除路径校验作为 runtime_db 本地 helper 实现；若后续要抽共享 helper，先做 GitNexus impact 再移动。
- staging root 由 `record` / schema write path `create_dir_all` 创建；`remove_file` 返回 `io::ErrorKind::NotFound` 视为删除成功，其他 IO 错误返回可见错误。
- 删除操作先 `fs::remove_file`，文件不存在视为成功；删除成功后再在 DB 中更新 `status` / `deleted_at_ms`。
- 若删除成功但 DB 更新前崩溃，下一次 cleanup/GC 看到文件不存在后继续更新 DB，完成收敛。
- 若删除失败，不更新 DB 状态，返回可见错误；下一次 cleanup/GC 可重试。
- 不删除目录；artifact path 必须指向文件路径。

## 测试计划

- disabled write/list/GC 不触碰 damaged `runtime.db`。
- enabled no-project write/GC 报 `no-project`，list 返回 `NoProject`。
- PR5-only DB list 返回空，且不创建 `runtime_staging_artifacts` / migration。
- migration idempotent，保留 higher `staging-artifacts` migration version。
- path guard 拒绝绝对路径、Windows drive path、UNC path、`..`、空 segment、目录路径、staging root 外 canonical path。
- delete-time guard 覆盖 symlink swap / parent replacement / canonical escape，不删除 staging 外文件。
- record happy path：保存 metadata，不保存 file blob。
- metadata 过大：`artifactPath`、`artifactHash`、`lastError` 超 byte 上限被应用层和 DB CHECK 拒绝。
- commit-success cleanup：删除 artifact 文件、更新状态和 `deleted_at_ms`，重复调用幂等。
- failed/cancelled TTL：TTL 前 GC 保留文件，TTL 后删除并标记 `deleted`；TTL 负数、0、超上限、溢出都拒绝。
- GC idempotent：文件已不存在或重复 GC 不报错。
- orphan job FK：拒绝不存在 job 的 artifact。
- status resurrection rejected：`committed` / `deleted` 不能被 `record` 复活。

## Gate / 调度

PR6 开工 gate：

- Commander 先写本计划。
- Architect 对抗审查本计划，重点查 path containment、status machine、TTL/GC 幂等、旧 DB migration 行为、SQLite blob 风险。
- 外部 agent 优先 Claude ACP；若 preflight/tool 失败或 10 分钟无完整结论，fallback 到 ZCode/Kimi + 内部 Architect。
- timeout/incomplete 不算 PASS；只可作为 advisory。

实现前：

- 对将修改的 existing symbols 跑 GitNexus impact，记录 blast radius。
- HIGH/CRITICAL 先说明风险再继续。

合并前：

- `cargo test runtime_db --manifest-path src-tauri/Cargo.toml`
- `pnpm lint`
- `git diff --check`
- `cargo build --release --manifest-path src-tauri/Cargo.toml`
- `npx gitnexus detect-changes --repo llm_wiki`
- Tester/Reviewer gates；外部 gate timeout 时走内部 fallback，但必须留下证据。

## 当前 Commander 判断

建议把 PR6 控制在 runtime metadata + explicit cleanup/GC API，不接 scheduler 和 UI。这样能让 SPEC-3 只依赖一个稳定的 staging artifact contract，PR7 再读这些状态做 minimal runtime UI。
