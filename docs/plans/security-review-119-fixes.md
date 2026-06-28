# Security Review #119 Fixes

> 类型：实现 PR 计划 | 创建：2026-06-25 | 更新：2026-06-28 | 状态：completed / historical
> 计划索引：[Plans Index](./README.md)
> 关联 issue：[#119 Security & quality review](https://github.com/6tizer/llm_wiki/issues/119)

## 结论

issue #119 深度 review 的 4 个安全 PR 已完成合入。后续 #120 sidecar npm audit high vulnerability 和 #126-A/B/C/D 安全/质量串流也已完成到 #170。

历史交付顺序按安全 > 数据完整性 > 功能 > 健壮性串行执行。4 个 #119 PR、#120 和 #126-A/B/C/D 均保留为完成证据，不再作为当前 follow-up queue。当前真实基线是 OKF/KW stream 已完成到 248bd27；后续不再按旧 OKF/KW 队列执行，next 是继续围绕并行加速 / Work Runtime / DB 选型 / provider profiles / work scheduler 讨论和规划。

当时 gate 规则为：以用户批准的 Commander 计划为准；若旧 AGENTS fallback 链或历史计划与本节冲突，则该 6-PR 历史串流按本节执行。Architect 首选 Claude Code，失败 fallback ZCode -> 内部子代理；Tester 首选 Kimi，失败 fallback 内部子代理；Reviewer 必须有 ZCode 外部 review 和内部子代理 review。ZCode 连续两次失败时记录到 PR comment，但不阻塞，改以内审意见作为 merge gate。所有 gate 需要输出 `PASS | BLOCK | WARN` 和 P0/P1/P2/P3/follow-up/non-actionable 分组。当前执行/路由以 [Plans Index](./README.md) 和新的 tracking/plan 为准。

## PR 划分

| PR | 分支 | 范围 (#119) | 依赖 | 风险 |
|----|------|-------------|------|------|
| PR1 | `codex/security-path-traversal-fix` | P0-1 + P1-3 + P0-2 + P2-2 + P1-8 | 无 | MEDIUM |
| PR2 | `codex/ingest-data-integrity` | P1-1 + P2-4 + P2-5 | 无 | MEDIUM-HIGH |
| PR3 | `codex/agent-budget-preflight` | P0-3 + P1-7 | PR1 | MEDIUM |
| PR4 | `codex/agent-robustness` | P1-2 + P1-5 + P1-6 + P2-6 | 无 | LOW-MEDIUM; merged by #125 |

## Completed Follow-up Evidence

- #120：sidecar npm audit high vulnerability completed by Hono lockfile update commits `eb8c702` / `4c9aa5c`.
- #126-A：local API hardening completed by #167 `85cf4da`.
- #126-B：autosave error surfacing completed by #168 `6ea9488`.
- #126-C：Agent / Ingest maintainability refactor completed by #169 `de1fbaf`.
- #126-D：P3 hardening completed by #170 `7d3bda5`.
- #119：保留 umbrella reference，用于追踪安全/质量 review 背景。

## Gate 架构

| 角色 | 执行方式 |
|------|----------|
| Commander | Codex commander（规划、决策、最终验证） |
| Architect | Claude Code 只读 plan/review；不可用或输出不完整时 fallback ZCode -> 内部子代理 |
| Tester | Kimi 只读 tester gate；不可用或输出不完整时 fallback 内部子代理 |
| Internal reviewer | Agent(Explore) 只读子代理（fork_context 等价） |
| External reviewer | ZCode review-only session；连续两次失败时记录到 PR comment，但不作为阻塞 |

关键原则：review-only session 不改文件、不 commit、不 push、不评论 PR、不派生子代理；报告使用 `PASS | BLOCK | WARN` 和 P0/P1/P2/P3/follow-up/non-actionable 分组。无 unresolved P0/P1/P2 才能合并；P3 尽量同 PR 清理，确实不适合当前 PR 的需在 PR comment 记录原因和归属。

## PR1 — 路径穿越攻击链

### Scope
- **P0-1**: `executeIngestWrites`（`src/lib/ingest.ts:1629-1668`）的 `FILE_BLOCK_REGEX` 循环改为 `parseFileBlocks()`，自动获得 `isSafeIngestPath` 守卫。保留 chat-mode 特有行为（绝对路径返回、log append、source-summary 重写）。
- **P1-3**: `applyLlmFix`（`src/lib/lint-fixer.ts:682`）构造 targetPath 前加 `isSafeIngestPath(block.path)` 守卫。
- **P0-2 / P2-2**: Rust `fs.rs` 所有变异 + 读取命令加 `validate_within_project`（移植 `api_server.rs:837` 的 `safe_join`）。通过 `State<FileSyncState>` 注入取 project root；root None 时读降级、写 fail-closed。
- **P1-8**: `.gitignore` 加 `pnpm-lock.yaml`（npm 是 canonical）。

### Done When
- `grep -rn "FILE_BLOCK_REGEX" src/lib/ingest.ts` 无实际写入调用
- Rust 所有变异命令经过 `validate_within_project`
- 4 个穿越向量（绝对路径/`..`/UNC/控制字符）在 ingest + lint 两路径有测试
- GitNexus detect_changes 仅预期 symbol

## PR2 — Ingest 数据完整性

### Scope
- **P1-1**: abort 时不缓存部分结果。`ingest-queue.ts:575` autoIngest 返回后加 abort 检查（路由到 catch 保留 retry）；`ingest.ts:1068` saveIngestCache 前 `if (signal?.aborted) return`。
- **P2-4**: `project-mutex.ts:36` 锁 key 内部 `normalizePath`。
- **P2-5**: `ingest-queue.ts:56` saveQueue 错误 surface 到 activity panel（带防刷屏守卫）。

## PR3 — Agent 预算事前拦截 + 默认关闭

### Scope
- **P0-3**: `AgentResourceConfig` 加 `maxFilesChangedEnabled`（默认 false），4 层穿透（agent-settings → transport-options → agent.rs → core.ts/wiki-tools）。
- 3 个易改工具真 preflight：wiki_synthesis（平凡）、run_lint_and_report（复用 fix_lint_report）、caption_source_images（中等）。
- ingest_source 保留事后 + 默认关（不拆 autoIngestImpl）。
- **P1-7**: agent-qa-hook.ts finally 标记改为成功才清；写入纳入预算。

## PR4 — Agent 健壮性

### Scope
- **P1-2**: `agent.rs` `process_group(0)` + `killpg`（Unix-only，`#[cfg(unix)]`）。
- **P1-5**: `sidecar/main.ts` scheduleExitIfIdle 检查桥 `hasPending()`。
- **P1-6**: chat-store finalizeStream 绑定会话 id（stream start 时捕获）。
- **P2-6**: `agent.rs` stdin 写包 `tokio::time::timeout`。

## 不在范围（follow-up）
P1-4（allowUnauthenticated UI 警告）、P2-1/P2-3（CORS/限流）、P2-7/P2-8/P2-9（重构）、大部分 P3。4 个 PR 完成后按需另开 issue。

## Stale agent-loop run 处理
沿用 PR #118 先例：不触碰 `.agent-loop/`（受保护路径），每个 PR body 手动记录 "delivery bind blocked by stale run 0c8f67ec, evidence recorded manually"。
