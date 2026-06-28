# SPEC-3: Markdown Commit Layer / 去全局阻塞

> 类型：阶段 SPEC | 状态：reviewed / ready for PR split | 覆盖：#187、#188 | 依赖：SPEC-1、SPEC-2

## 目标与成功标准

建立 Markdown commit layer，让并行 worker 只产出 staging artifact，最终 Markdown 写入统一经过 commit layer。

成功标准：

- normal ingest 不再默认生成或覆盖 `wiki/index.md` / `wiki/overview.md`。
- commit layer 负责 create / merge / conflict。
- 写入按 affected Markdown path 串行，不用项目级长锁包住 LLM 调用。
- base hash / content version 冲突转 review/repair job，不 silent overwrite。
- 每次 commit 写入 commit/event record，记录 artifact hash、base hash、result、affected paths，并保留 audit/conflict diagnosis 所需事件数据。
- commit 成功后写入 derived stale marker；marker schema 由本 SPEC 定义，SPEC-2 存储，SPEC-6 消费。
- commit operation 通过 Core Runtime API 暴露，不绑定 Tauri/React shell。

## 关键设计决策

- `index.md` 是 optional export/directory view；`overview.md` 是 optional synthesis/user-authored summary。
- 新空项目不依赖 `wiki/index.md` / `wiki/overview.md`。
- 旧项目只保证 Markdown asset 可打开、可搜索、可导入；不保留旧 runtime 语义。
- Agent 默认读 committed Markdown；staging 只通过明确 runtime view/tool 暴露。
- commit layer 按 normalized affected Markdown path 串行；不同 path 的 commit 可并发，受 SPEC-2 worker pool 总并发预算约束。
- rollback 语义：Markdown 内容级 rollback 依赖用户项目自己的 git/worktree 历史；commit layer 第一版不默认保存完整内容快照。commit event 用于审计、冲突诊断和 repair tracing，不承诺替代 Git 做内容回滚。
- staging artifact 删除边界：commit event 已写入、final Markdown 已落盘、derived marker 已入队后，成功 artifact 可删除；失败/冲突 artifact 保留到 TTL 供 repair/debug。
- conflict repair job 必须记录 owner、attempt limit、strategy 和 affected paths；超过限制转人工 review，不能 silent overwrite。
- hotspot pages（例如 log、schema registry、可选 index/export）默认走 append/merge 专用策略或更低并发预算，不能和普通 content page 一样盲写。
- 不保留的旧 runtime 语义包括：normal ingest 自动生成/覆盖 `index.md` / `overview.md`、project-level LLM 长锁串行、ingest 完成时同步触发所有 derived side effects。

Derived stale marker schema draft：

| Field | Meaning |
|-------|---------|
| `layer` | `embedding` / `graph` / `taxonomy` / `synthesis` / `search` / `index_export` / `overview` 等派生层。 |
| `affected_path` | 触发该派生层变脏的 committed Markdown path。 |
| `input_hash` | commit 后输入内容 hash。 |
| `base_version` | commit/event version，用于判断 marker 是否过期。 |
| `marked_at` | marker 创建时间。 |
| `reason` | `commit` / `delete` / `schema_change` / `manual_rebuild` 等原因。 |
| `source_event_id` | 对应 commit/event id，方便追踪。 |
| `status` | `pending` / `claimed` / `done` / `failed` / `cancelled`，由 SPEC-6 消费更新。 |

## 预期 PR 拆分

1. Commit layer ADR + artifact format。
2. `index.md` / `overview.md` 从 ingest prompt 和 write path 移除。
3. Commit operation：read current -> compare base hash -> write/merge/conflict。
4. Commit event record + derived stale marker 写入，包括 marker schema migration。
5. Conflict review/repair job 入口。
6. Project template / OKF validator wording 更新。

## 验证策略

- 单测覆盖 create、same-path serial write、base hash mismatch、conflict job creation。
- ingest prompt snapshot / parser tests 确认不再要求 global pages。
- 空项目创建测试确认没有 mandatory `index.md` / `overview.md`。
- 旧项目 fixture 确认已有文件不被删除、不被自动覆盖。

## Gate 结论摘要

本 SPEC 随当前 docs PR 通过 PR-level gate；详见 [SPEC-0](./spec-0-roadmap-baseline.md) 的统一 gate 摘要。实现 PR 必须重新审查 rollback 语义、same-path serial write、conflict repair job、derived marker schema 和 shell-neutral commit API。

## Non-goals / Follow-up

- 不删除用户已有 `index.md` / `overview.md`。
- 不实现高级 semantic merge。
- 不把 commit layer 做成通用 Git 替代品。
