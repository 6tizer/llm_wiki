# Upstream v0.5.0 Delta

> 类型：调研入口 | 创建：2026-06-24 | 状态：active

## 结论

Phase 6 后续实现 PR 不再以 `v0.4.25` 为当前目标；每个 PR 开工前都要重新核对 upstream `v0.5.0` delta，并把发现分流到既有 PR E / H-lite / G / F / I / J / K 或后续计划。

本地已确认 upstream `main@997db74` 和 tag `v0.5.0`。该事实可用于后续 PR 的计划、PR body 和 reviewer packet。

## Delta Assessment Checklist

每个实现 PR 开工前先做：

1. 确认 upstream remote、`upstream/main@997db74`、tag `v0.5.0` 仍是当前基准，若变化则记录新事实。
2. 查看 `v0.4.26` through `v0.5.0` 的 upstream delta，也可用 `v0.4.25..v0.5.0` range 抽取 commit/file 变化。
3. 对照本地 main，标出直接 merge 会覆盖或删除的本地 Agent sidecar、Agent UI、docs、Tauri resource、sidecar binary 或 Mac-only product positioning 差异。
4. 把 delta 分流到下方 PR 映射；不确定项先放 follow-up sweep。
5. 在对应 PR plan / PR body 记录 delta 结论和未处理项。

## Routing Rules

| Delta type | Route |
|------------|-------|
| Ingest、schema、review create page、source path safety | PR E |
| Zoom、layout、app visibility、project open/create UX | H-lite |
| Chat image、multimodal message、chat standalone | PR G |
| MinerU / PDF parsing | PR F |
| Theme、tray、general settings、window close behavior | PR I |
| Graph rendering/performance | PR J |
| AnyTXT、source import extras、lint persistence、low-risk misc | PR K |
| CI/release/platform target cleanup | `mac-product-baseline` |
| Agent UX/session/permission/internal RPC | Phase 7 backlog |

## PR Mapping Placeholder

| PR | v0.5.0 delta status | Notes |
|----|---------------------|-------|
| PR E | todo before start | Re-check ingest/schema/review delta. |
| H-lite | todo before start | Re-check zoom/layout/app visibility delta. |
| PR G | todo before start | Re-check chat image/chat standalone delta. |
| PR F | todo before start | Re-check MinerU/PDF delta. |
| PR I | todo before start | Re-check theme/tray/settings delta. |
| PR J | todo before start | Re-check graph delta. |
| PR K | todo before start | Re-check remaining low-risk misc delta. |

## Direct Merge Policy

Do not directly merge upstream into this fork. Direct merge would risk overwriting or deleting local Agent sidecar, docs, Agent UI, Tauri resource, and product-positioning differences. Continue manual port by feature batch.
