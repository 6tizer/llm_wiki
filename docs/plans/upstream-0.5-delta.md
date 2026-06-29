# Upstream v0.5.x Delta

> 类型：调研入口 | 创建：2026-06-24 | 更新：2026-06-29 | 状态：active / recheck gate

## 结论

本文只保留为后续实现 PR 的 upstream delta 复核入口，不再承载 Phase 6、follow-up sweep、OKF/KW 或安全串流的完成证据。

当前历史完成证据已归档：

- Phase 6 PR A-K、follow-up sweep、OKF/KW baseline：[archive/upstream-sync-phase6.md](./archive/upstream-sync-phase6.md)
- Chat Agent Router alignment：[archive/upstream-chat-agent-router-alignment.md](./archive/upstream-chat-agent-router-alignment.md)
- OKF compatibility baseline：[archive/okf-compatibility.md](./archive/okf-compatibility.md)
- Knowledge Wiki business-layer baseline：[archive/knowledge-wiki-business-layer.md](./archive/knowledge-wiki-business-layer.md)
- Security / quality follow-ups：[archive/security-review-119-fixes.md](./archive/security-review-119-fixes.md)

当前 active SPEC stream 不是继续执行旧 upstream/OKF/KW 队列，而是围绕并行加速平台架构收敛：

- #184 Work Runtime / SQLite runtime ledger / Markdown source of record
- #185 User-selected Model Profiles + Runtime Scheduling
- #186 Model-call Profile vs Agent-run Profile / Unified Agentic Chat control plane
- #187 `index.md` / `overview.md` 去核心化
- #188 Markdown commit layer
- #189 Derived knowledge rebuild lifecycle
- #191 Parallel Knowledge Pipeline / bulk prepare-commit-repair

## Current Baseline

截至 2026-06-29：

- 本地 OKF/KW stream 已完成到 `248bd27 feat: expose OKF and knowledge workflow tools`。
- Phase 6 upstream `v0.5.x` 主线和 follow-up sweep 已完成并归档。
- 后续实现 PR 若触碰 upstream-overlapping area，仍必须重新核对当时最新 upstream tag/commit。

旧结论不得直接复用为当前事实；开工时必须重新跑 delta assessment。

## Delta Assessment Checklist

每个可能触碰 upstream-overlapping area 的实现 PR，开工前先做：

1. 确认 upstream remote、latest tag、`upstream/main` commit。
2. 查看从本地已知基线到 latest upstream 的 commit/file delta。
3. 标出会触碰本地差异的风险点：
   - Claude Agent SDK sidecar
   - Agent UI / permission / session / pipeline
   - Tauri resource、sidecar binary、Mac-only product positioning
   - docs/plans 当前架构方向
   - OKF/KW 本地业务层语义
4. 将发现分流到新的 scoped issue / plan，不混入无关 PR。
5. 在对应 PR plan、PR body 和 reviewer packet 记录当时看到的 upstream tag/commit 和 delta 结论。

## Routing Rules

| Delta type | Route |
|------------|-------|
| 普通 Chat / RAG / 低风险 UI polish | 可考虑手动 port；必须保护 Unified Agentic Chat 方向 |
| Chat Agent Router residual | 先开 scoped issue；不要替代 Claude Agent SDK sidecar |
| Agent SDK sidecar / permission / session / pipeline | 执行入口以 [spec-7-unified-agentic-chat.md](./spec-7-unified-agentic-chat.md) 为准；[claude-agent-sdk-alignment.md](./claude-agent-sdk-alignment.md) 和 [agent-sidecar-phase6.1.md](./agent-sidecar-phase6.1.md) 是背景资料 |
| Ingest / queue / review / synthesis / taxonomy / embedding | 先对齐并行 runtime 架构 issues #184-#189/#191 |
| OKF / Knowledge Wiki 增强 | 新 scoped issue；不得重开已完成 OKF/KW 串流 |
| Mac product identity / CI / release | 先确认是否仍符合 Mac-only active maintenance |
| Native Swift / SwiftUI / iOS | [native-architecture.md](./native-architecture.md)、[spec-1-app-architecture-decomposition.md](./spec-1-app-architecture-decomposition.md)、[spec-9-swift-shell-reentry.md](./spec-9-swift-shell-reentry.md)；Swift 实现 deferred，native-ready boundary active |

## Direct Merge Policy

不要直接 merge upstream into this fork。直接 merge 仍可能覆盖或删除本地 Agent sidecar、Agent UI、docs、Tauri resource、sidecar binary、产品定位和本地 workflow 差异。

后续吸收 upstream 功能时继续按 feature batch 手动 port，并以当前产品方向为准。
