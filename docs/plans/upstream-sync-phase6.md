# Phase 6: upstream sync to nashsu/llm_wiki v0.5.x

> 类型：Phase 实施计划 | 创建：2026-06-05 | 更新：2026-06-24 | 状态：active
> 上级：[Agent Sidecar 总规划](./agent-sidecar-roadmap.md)
> 计划索引：[Plans Index](./README.md)
> Delta 入口：[Upstream v0.5.x Delta](./upstream-0.5-delta.md)
> 后续：[Phase 7 Agent SDK productization](./agent-sidecar-phase6.1.md)
> 上游基线：`nashsu/llm_wiki` tag `v0.5.0@997db74`；截至 2026-06-24 已看到 `v0.5.1@cc4b98f`

## 结论

Phase 6 的当前目标从旧 `v0.4.25` 提升到 upstream `v0.5.x`。后续仍采用按功能手动 port，不直接 merge upstream。

不能直接 `git merge upstream/main`：上游会覆盖或删除本地 Agent sidecar、Agent UI、docs、Tauri resource、sidecar binary、产品定位和本地 Agent workflow 差异。Phase 6 的原则是吸收 upstream 功能与修复，同时保留本地 Agent 产品线。

本地已确认：

- upstream tag `v0.5.0@997db74`
- upstream tag/current main `v0.5.1@cc4b98f`
- Issue #88 已 CLOSED（2026-06-23），可作为 PR C 完成证据。

## Current State

| Item | Status |
|------|--------|
| PR A：MCP server + desktop bundling | completed |
| PR B：CLI resolver / active project root / connection test isolation | completed |
| PR C：Embedding + vector safety | completed; #88 closed on 2026-06-23 |
| PR D：LLM provider / dedup / deep research stability | completed |
| follow-up sweep | completed |
| v0.4.26 through latest v0.5.x delta assessment | required before every remaining implementation PR |

历史计划曾以 upstream `v0.4.25` 为目标；这只保留为 archive context。当前执行、PR body、review packet 和后续分流都以开工时最新 `v0.5.x` 为准。

## Required Pre-step: v0.5.x Delta Assessment

每个后续 PR 开工前必须先跑一次 delta assessment：

1. 确认 upstream remote、latest tag 和 `upstream/main` commit；若 upstream 已变化，记录新的 commit/tag 事实。
2. 查看 `v0.4.26` through latest `v0.5.x` 的 upstream delta，也可用 `v0.4.25..latest` range 抽取 commit/file 变化。
3. 标出会触碰本地 Agent sidecar、Agent UI、docs、Tauri resource、sidecar binary 或 Mac-only product positioning 的冲突点。
4. 按 [upstream-0.5-delta.md](./upstream-0.5-delta.md) 分流到 PR E / H-lite / G / F / I / J / K，或记录为 follow-up。
5. 在对应 PR plan、PR body 和 reviewer packet 写明 delta 结论。

## Remaining PR Order

后续顺序保持：

1. PR E：Ingest/schema/review-create-page safety
2. H-lite：zoom/layout/app visibility
3. PR G：聊天图片粘贴 + 多模态消息 + chat standalone
4. PR F：MinerU PDF 解析
5. PR I：主题、托盘、通用设置
6. PR J：图形渲染优化
7. PR K：AnyTXT、源文件导入、Lint 持久化和低风险杂项

每个 PR 都必须重新核对 upstream `v0.5.x` delta，不得沿用旧 `v0.4.25` 结论。

## Agent Boundary From Upstream v0.5.x

上游 `v0.5.x` 的 Agent 是 Chat Agent Router，不是本 fork 的 Agent SDK sidecar。

- Chat Agent Router：普通 Chat 内的 TypeScript planner，按 `fast / standard / deep / local_first` mode 调用只读 project/wiki/graph/web/AnyTXT 工具，最后通过当前 LLM provider 回答。
- Agent SDK sidecar：本 fork 的 Claude Agent SDK runtime，经 Rust/Tauri sidecar bridge 运行，支持可写 Wiki 工具、permission approval、session resume/fork/continue、resource limits 和 multi-agent pipeline。

同步原则：可以 port 上游 Chat Agent Router 的 query understanding、agent mode、tool progress、project file read 和 reasoning fallback；不能把它当成 sidecar 替代品，也不能因此删除或弱化本地 Agent permission/session/pipeline 设计。

## Remaining PR Charters

### PR E：Ingest/schema/review-create-page safety

目标：先把生成页面、写入路径、review create page 和 subject boundary 相关安全性补齐，再引入 MinerU。

重点：

- Schema routing / generated page type validation。
- Ingest parse、source identity、scheduled import、CJK filename、Q&A visible-title 加固。
- Rust fs 写入路径安全。
- Review preservation / missing-page create page。
- Markdown / Obsidian image resolver。
- v0.5.x delta 中所有 ingest/review/source safety 变更。

风险：HIGH。`ingest.ts` 与本地 Agent pipeline 有重叠，必须手动融合并补回归。

### H-lite：zoom/layout/app visibility

目标：先 port 用户可见但较独立的 zoom、layout 和 app visibility 修复，不把完整主题/托盘塞进同一 PR。

重点：

- Zoom settings 使用 root font size，避免 transform scale。
- Layout position / floating UI / click target 验收。
- Project open autosave hardening。
- Project creation required fields visibility。
- Language prompt technical names。
- App startup visibility 只按当前 Mac target 验收；旧 Windows startup 修复如果仍在 upstream delta 中，作为 legacy reference 分流，不扩大当前产品承诺。

### PR G：聊天图片粘贴 + 多模态消息 + chat standalone

目标：普通 Chat 支持图片和 multimodal message，同时重新评估 upstream Chat Agent Router 是否进入普通 Chat；不得破坏 Agent SDK sidecar stream UI。

重点：

- Paste / file picker / thumbnail / delete / size validation。
- User message image rendering。
- LLM message ContentBlock[] 转换。
- Chat standalone 迁移。
- 上游 Chat Agent Router 的 agent mode、tool progress、project file read、reasoning fallback 分流。
- 保留本地 Agent permission、timeline、rewind、resume、resource limit notice。

风险：HIGH。Chat 与 Agent UI 冲突最大，必须补 Agent 回归。

### PR F：MinerU PDF 解析

目标：引入可选 MinerU 云解析，默认 PDF 行为不变。

重点：

- MinerU API client、poll、download、ZIP/image handling。
- Settings / persist / i18n。
- Ingest 接入与失败回退。
- Token 不写仓库、日志、PR 描述或测试快照。

### PR I：主题、托盘、通用设置

目标：引入 theme、tray、close behavior 和 general settings，同时按 Mac-only product baseline 校正平台口径。

重点：

- light/dark/system theme。
- macOS tray / close behavior。
- native titlebar theme/background。
- Settings slice 与 Agent settings 保持边界。
- 不重新承诺 Linux/Windows active support。

### PR J：图形渲染优化

目标：对齐 upstream graph performance 和 rendering safety。

重点：

- Worker layout。
- 自适应 edge/label/layout 参数。
- HoverState 重构。
- 空搜索结果不卸载 Sigma。
- Layout fingerprint。
- 与 theme delta 的依赖关系在开工前重新判断。

### PR K：AnyTXT、源文件导入、Lint 持久化和低风险杂项

目标：收尾 upstream 用户功能和 P2/P3 delta，不污染 P0/P1 稳定性 PR。

重点：

- AnyTXT / web search chat integration。
- Source import extras。
- Lint persistence / lint link repair。
- Editor enhancements。
- Review view low-risk fixes。
- Provider preset、vision caption、Mermaid cache 等杂项。

## Phase 7 Boundary

Agent SDK sidecar 的 UX/session/permission/internal RPC 后续不再称为 Phase 6.1；它们进入 [Phase 7 Agent SDK productization](./agent-sidecar-phase6.1.md)。上游 Chat Agent Router 的普通 Chat 集成先在 PR G 评估，只有 sidecar session/permission/pipeline 相关项进入 Phase 7。#3 仍是内部 Rust-to-sidecar RPC 评估项，不默认实现。

## Mac-only Product Boundary

README 已改为 macOS-first / Mac-only active maintenance，但本 docs PR 不表示 CI/release 已经清理完成。CI/release pruning、app identity、原版 App 混淆和 release 策略由下一实现 PR [mac-product-baseline.md](./mac-product-baseline.md) 处理。

## Done When

- PR E / H-lite / G / F / I / J / K 都完成或明确路由。
- 每个 PR 都记录 v0.5.x delta assessment。
- 本地 Agent sidecar、Agent UI、Agent pipeline 行为不回退。
- Mac-only product baseline 完成 CI/release/app identity 清理。
- Phase 7 backlog 有独立入口，不再作为 Phase 6 尾项混入。

## Validation for Future Implementation PRs

- 修改函数、类或方法前跑 GitNexus impact。
- 提交前跑 `npx gitnexus detect_changes --repo llm_wiki`。
- 相关单测和 `pnpm lint` 通过。
- `git diff --check` 无输出。
- Reviewer gate 无未解决 P0/P1/P2。
