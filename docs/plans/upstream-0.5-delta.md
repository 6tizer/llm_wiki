# Upstream v0.5.x Delta

> 类型：调研入口 | 创建：2026-06-24 | 状态：active

## 结论

Phase 6 后续实现 PR 不再以 `v0.4.25` 为当前目标；每个 PR 开工前都要重新核对 upstream `v0.5.x` delta，并把发现分流到既有 PR E / H-lite / G / F / I / J / K 或后续计划。

本地已确认 upstream `v0.5.0@997db74`，且截至 2026-06-24 upstream `main` 已更新到 `v0.5.1@cc4b98f`。后续 PR 的计划、PR body 和 reviewer packet 必须记录开工时看到的最新 upstream tag/commit。

## Alignment Principles

- 上游优先对齐：普通 Chat、RAG、UI 和低风险用户体验尽量贴近 upstream `v0.5.x`，避免无理由 fork。
- fork 差异保留：Mac-only 产品定位、Claude Agent SDK sidecar、可写 Wiki 工具、permission/session/pipeline 和安全边界继续作为本 fork 的核心差异。
- OKF 兼容：`<project>/wiki/` 逐步明确为 OKF-compatible knowledge bundle root；OKF 只作为知识包格式兼容层，不替代 MCP、Agent runtime 或 local HTTP API。

## Agent Terminology Boundary

上游 `v0.5.x` 的 Agent 是 **Chat Agent Router**：

- 位置：普通 Chat 内部，核心在 `src/lib/chat-agent.ts`。
- 运行时：TypeScript planner，最终仍调用当前配置的 `streamChat` provider。
- 工具：`project_files`、`project_file_read`、`wiki_search`、`graph_search`、`web_search`、`anytxt_search`，以只读检索和上下文组装为主。
- UI：Chat 输入区的 `fast / standard / deep / local_first` mode，消息内保存 agent steps/tool progress。

本 fork 的 Agent 是 **Agent SDK sidecar**：

- 位置：`src-tauri/sidecar`、Rust `agent_spawn`、frontend `src/lib/agent/*`。
- 运行时：Claude Agent SDK sidecar，通过 stdin/stdout JSON-lines 与 Tauri/Rust 桥接。
- 工具：读写 Wiki MCP tools、app-level tools、permission bridge、resource limits、session resume/fork/continue、多 Agent pipeline。
- UI：Agent session、permission approval、tool/activity timeline、rewind/resume/compact 等 Phase 7 productization 项。

结论：上游 Chat Agent Router 是可吸收的 Chat/RAG 路由能力，不是 Agent SDK sidecar 的替代品。后续同步应把它分流到 PR G / Phase 7 边界评估，并避免直接覆盖本地 sidecar、permission、session 和 pipeline 设计。

## Delta Assessment Checklist

每个实现 PR 开工前先做：

1. 确认 upstream remote、latest tag、`upstream/main` commit；若已超过 `v0.5.0`，记录新事实。
2. 查看 `v0.4.26` through latest `v0.5.x` 的 upstream delta，也可用 `v0.4.25..latest` range 抽取 commit/file 变化。
3. 对照本地 main，标出直接 merge 会覆盖或删除的本地 Agent sidecar、Agent UI、docs、Tauri resource、sidecar binary 或 Mac-only product positioning 差异。
4. 把 delta 分流到下方 PR 映射；不确定项先放 follow-up sweep。
5. 在对应 PR plan / PR body 记录 delta 结论和未处理项。

## Routing Rules

| Delta type | Route |
|------------|-------|
| Ingest、schema、review create page、source path safety | PR E |
| Zoom、layout、app visibility、project open/create UX | H-lite |
| Chat image、multimodal message、chat standalone | PR G |
| Chat Agent Router、agent modes、agent steps/tool progress、reasoning fallback | PR G Chat Agent Router alignment + Phase 7 boundary decision |
| OKF-compatible wiki bundle、validator/export/import | OKF roadmap |
| MinerU / PDF parsing | PR F |
| Theme、tray、general settings、window close behavior | PR I |
| Graph rendering/performance | PR J |
| AnyTXT、source import extras、lint persistence、low-risk misc | PR K |
| CI/release/platform target cleanup | `mac-product-baseline` |
| Agent UX/session/permission/internal RPC | Phase 7 backlog |

## PR Mapping Placeholder

| PR | v0.5.x delta status | Notes |
|----|---------------------|-------|
| PR E | todo before start | Re-check ingest/schema/review delta. |
| H-lite | todo before start | Re-check zoom/layout/app visibility delta. |
| PR G | todo before start | Re-check chat image/chat standalone plus upstream Chat Agent Router delta. Decide what is ported into normal Chat and what remains Phase 7 sidecar work. |
| PR F | todo before start | Re-check MinerU/PDF delta. |
| PR I | todo before start | Re-check theme/tray/settings delta. |
| PR J | todo before start | Re-check graph delta. |
| PR K | todo before start | Re-check remaining low-risk misc delta. |

## Direct Merge Policy

Do not directly merge upstream into this fork. Direct merge would risk overwriting or deleting local Agent sidecar, docs, Agent UI, Tauri resource, and product-positioning differences. Continue manual port by feature batch.
