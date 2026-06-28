# Phase 6: upstream sync to nashsu/llm_wiki v0.5.x

> 类型：Phase 实施计划 | 创建：2026-06-05 | 更新：2026-06-28 | 状态：completed / follow-up routing
> 上级：[Agent Sidecar 总规划](./agent-sidecar-roadmap.md)
> 计划索引：[Plans Index](../README.md)
> Delta 入口：[Upstream v0.5.x Delta](../upstream-0.5-delta.md)
> Chat 对齐：[Upstream Chat Agent Router Alignment](./upstream-chat-agent-router-alignment.md)
> 后续：[Phase 7 Agent SDK productization](../agent-sidecar-phase6.1.md)
> 上游基线：`nashsu/llm_wiki` tag `v0.5.0@997db74`；截至 2026-06-24 已看到 `v0.5.1@cc4b98f`

## 结论

Phase 6 的目标从旧 `v0.4.25` 提升到 upstream `v0.5.x` 后，PR A-K 主线已经完成到 #148。后续不再按旧 PR E/H/G/F/I/J/K 顺序开新主线 PR；OKF + Knowledge Wiki business-layer stream 也已完成。本文件现在用于记录完成证据、follow-up 路由和后续 implementation PR 的 upstream delta 校准规则。

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
| PR E：Ingest / schema / review-create-page safety | completed; #129 `d22f401`; review missing-page per-title classification #128 completed by #164 |
| H-lite：zoom / layout / app visibility | completed; #131 `087b135` |
| PR G：Chat Agent Router alignment + multimodal chat | completed; #137 `5765200` + #134 `1183710`; UI polish #135/#136 completed by #162 |
| PR F：MinerU PDF parsing | completed; #140 `87c7caf`; regression fix #153 merged; large PDF / side-cache polish #152 completed by #161 |
| PR I：theme / tray / general settings | completed; #142 `c343b2a`; tray localization #151 merged |
| PR J：graph rendering / path-aware graph identity | completed; #145 `c5403f7`; hover label contrast #158 merged |
| PR K：AnyTXT smart search options cleanup | completed; #148 `0fd1d95`; #110 closed; residual llmConfig/lint/review-chat autosave follow-ups #154/#157/#160 merged |
| follow-up sweep | completed through #164; #120/#126 safety and quality follow-ups completed through #170 |
| OKF + Knowledge Wiki business-layer stream | completed through current main/head `248bd27 feat: expose OKF and knowledge workflow tools` |
| v0.4.26 through latest v0.5.x delta assessment | still required before new implementation PRs that touch upstream-overlapping areas |

历史计划曾以 upstream `v0.4.25` 为目标；这只保留为 archive context。当前执行、PR body、review packet 和后续分流都以开工时最新 `v0.5.x` 为准。

## Required Pre-step: v0.5.x Delta Assessment

每个后续 PR 开工前必须先跑一次 delta assessment：

1. 确认 upstream remote、latest tag 和 `upstream/main` commit；若 upstream 已变化，记录新的 commit/tag 事实。
2. 查看 `v0.4.26` through latest `v0.5.x` 的 upstream delta，也可用 `v0.4.25..latest` range 抽取 commit/file 变化。
3. 标出会触碰本地 Agent sidecar、Agent UI、docs、Tauri resource、sidecar binary 或 Mac-only product positioning 的冲突点。
4. 按 [upstream-0.5-delta.md](../upstream-0.5-delta.md) 分流到 residual follow-up、并行加速平台架构讨论、Claude Agent SDK alignment、Phase 7 backlog，或记录为新的 tracking issue。
5. 在对应 PR plan、PR body 和 reviewer packet 写明 delta 结论。

## Completed Phase 6 Order

Phase 6 主线的实际完成顺序：

1. PR E：Ingest/schema/review-create-page safety
2. H-lite：zoom/layout/app visibility
3. PR G：Chat Agent Router alignment + multimodal chat
4. PR F：MinerU PDF 解析
5. PR I：主题、托盘、通用设置
6. PR J：图形渲染优化
7. PR K：AnyTXT、源文件导入、Lint 持久化和低风险杂项

这些条目保留为完成记录，不再作为“剩余开发顺序”。新的实现 PR 若触碰相同区域，仍必须重新核对 upstream `v0.5.x` delta，不得沿用旧 `v0.4.25` 结论。

## OKF/KW Completed Baseline

当前 main/head：`248bd27 feat: expose OKF and knowledge workflow tools`。

| Stream | Status | Evidence |
|--------|--------|----------|
| KW-QA | completed | `f9f63c5` |
| OKF-A：validator/export | completed | `e300cdd` |
| OKF-B：import/mapping | completed | `67f54f6` |
| KW-B1：Knowledge Agents config base | completed | `95e4bb9` |
| KW-B2：Prompt Registry | completed | `8ea2326` |
| KW-C1：Tag taxonomy schema + bootstrap/growth base | completed | `127fc9e` |
| KW-D：Multi-dimensional synthesis | completed | `3a01730` |
| KW-C2：Taxonomy-aware Tag Agent | completed | `ad0b9d5` |
| OKF-C：Unified Agent tools + MCP/local API exposure | completed | `248bd27` |

## Current Follow-up Routing

截至 2026-06-29，follow-up sweep 已完成到 #164，安全/质量 backlog #120/#126 系列已完成到 #170，OKF/KW stream 已完成到 `248bd27`。后续不继续按旧 OKF/KW 队列执行，也不从本文直接进入 Phase 7 / Claude Agent SDK alignment 实现。

后续分流：

1. 并行加速平台架构讨论：Work Runtime、DB 选型、provider profiles、work scheduler，以及相关 plan/tracking。
2. Claude Agent SDK alignment：保留为候选规划入口，等待新的 tracking / plan 明确范围。
3. Phase 7 Agent SDK productization：保留 backlog，不从本队列自动启动。
4. 新 tracking issue：承接 residual upstream delta、OKF/KW 增强或尚未定范围的平台架构项。
5. Native Swift/SwiftUI/iOS：仍为远期 ADR，不进入近期实现。

本文不承诺具体并发 runtime 实现。

已完成的收口证据：

- Plans/delta queue calibration completed by #159 `cebfc88`.
- #156 review/chat autosave project-path isolation completed by #160 `334c382`.
- #152 MinerU large PDF / parsed side-cache polish completed by #161 `7d1b044`.
- #135/#136 Chat UI polish completed by #162 `ac797ee`.
- #128 review missing-page per-title classification completed by #164 `b273c85`.
- #120 sidecar npm audit high vulnerability completed by Hono lockfile update commits `eb8c702` / `4c9aa5c`.
- #126-A local API hardening completed by #167 `85cf4da`.
- #126-B autosave error surfacing completed by #168 `6ea9488`.
- #126-C Agent / Ingest maintainability refactor completed by #169 `de1fbaf`.
- #126-D P3 hardening completed by #170 `7d3bda5`.
- OKF/KW stream completed by `f9f63c5`, `e300cdd`, `67f54f6`, `95e4bb9`, `8ea2326`, `127fc9e`, `3a01730`, `ad0b9d5`, `248bd27`.

## Agent Boundary From Upstream v0.5.x

上游 `v0.5.x` 的 Agent 是 Chat Agent Router，不是本 fork 的 Agent SDK sidecar。

- Chat Agent Router：普通 Chat 内的 TypeScript planner，按 `fast / standard / deep / local_first` mode 调用只读 project/wiki/graph/web/AnyTXT 工具，最后通过当前 LLM provider 回答。
- Agent SDK sidecar：本 fork 的 Claude Agent SDK runtime，经 Rust/Tauri sidecar bridge 运行，支持可写 Wiki 工具、permission approval、session resume/fork/continue、resource limits 和 multi-agent pipeline。

同步原则：可以 port 上游 Chat Agent Router 的 query understanding、agent mode、tool progress、project file read 和 reasoning fallback；不能把它当成 sidecar 替代品，也不能因此删除或弱化本地 Agent permission/session/pipeline 设计。

## Completed PR Charters

以下 charter 保留为完成记录和 future regression checklist。它们不再表示未开工范围。

### PR E：Ingest/schema/review-create-page safety

状态：completed by #129 `d22f401`。

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

状态：completed by #131 `087b135`。

目标：先 port 用户可见但较独立的 zoom、layout 和 app visibility 修复，不把完整主题/托盘塞进同一 PR。

重点：

- Zoom settings 使用 root font size，避免 transform scale。
- Layout position / floating UI / click target 验收。
- Project open autosave hardening。
- Project creation required fields visibility。
- Language prompt technical names。
- App startup visibility 只按当前 Mac target 验收；旧 Windows startup 修复如果仍在 upstream delta 中，作为 legacy reference 分流，不扩大当前产品承诺。

### PR G：Chat Agent Router alignment + multimodal chat

状态：completed by #137 `5765200` and #134 `1183710`；UI polish follow-up #135/#136 completed by #162 `ac797ee`。

目标：普通 Chat 对齐 upstream `v0.5.x` Chat Agent Router，并支持图片和 multimodal message；不得破坏 Agent SDK sidecar stream UI。

重点：

- Paste / file picker / thumbnail / delete / size validation。
- User message image rendering。
- LLM message ContentBlock[] 转换。
- Chat standalone 迁移。
- 上游 Chat Agent Router 的 query understanding、`fast / standard / deep / local_first`、project files/read file、agent steps 持久化、tool progress UI、reasoning fallback 分流。
- 保留本地 Agent permission、timeline、rewind、resume、resource limit notice。

风险：HIGH。Chat 与 Agent UI 冲突最大，必须补 Agent 回归。

### PR F：MinerU PDF 解析

状态：completed by #140 `87c7caf`；regression fix #153 已合并；large PDF / side-cache polish #152 completed by #161 `7d1b044`。

目标：引入可选 MinerU 云解析，默认 PDF 行为不变。

重点：

- MinerU API client、poll、download、ZIP/image handling。
- Settings / persist / i18n。
- Ingest 接入与失败回退。
- Token 不写仓库、日志、PR 描述或测试快照。

### PR I：主题、托盘、通用设置

状态：completed by #142 `c343b2a`；tray label localization completed by #151。

目标：引入 theme、tray、close behavior 和 general settings，同时按 Mac-only product baseline 校正平台口径。

重点：

- light/dark/system theme。
- macOS tray / close behavior。
- native titlebar theme/background。
- Settings slice 与 Agent settings 保持边界。
- 不重新承诺 Linux/Windows active support。

### PR J：图形渲染优化

状态：completed by #145 `c5403f7`；hover label contrast follow-up completed by #158。

目标：对齐 upstream graph performance 和 rendering safety。

重点：

- Worker layout。
- 自适应 edge/label/layout 参数。
- HoverState 重构。
- 空搜索结果不卸载 Sigma。
- Layout fingerprint。
- 与 theme delta 的依赖关系在开工前重新判断。

### PR K：AnyTXT、源文件导入、Lint 持久化和低风险杂项

状态：completed by #148 `0fd1d95` for AnyTXT smart search options cleanup；`collect_research_sources` llmConfig forwarding completed by #154；lint autosave isolation completed by #157；review/chat autosave isolation #156 completed by #160 `334c382`。

目标：收尾 upstream 用户功能和 P2/P3 delta，不污染 P0/P1 稳定性 PR。

重点：

- AnyTXT / web search chat integration。
- Source import extras。
- Lint persistence / lint link repair。
- Editor enhancements。
- Review view low-risk fixes。
- Provider preset、vision caption、Mermaid cache 等杂项。

## Phase 7 Boundary

Agent SDK sidecar 的 UX/session/permission/internal RPC 后续不再称为 Phase 6.1；它们进入 [Phase 7 Agent SDK productization](../agent-sidecar-phase6.1.md)。上游 Chat Agent Router 的普通 Chat 集成核心已由 PR G 完成；未来只处理 residual Chat Router delta、scoped follow-up 或 Phase 7 sidecar 边界问题。#3 仍是内部 Rust-to-sidecar RPC 评估项，不默认实现。

## Mac-only Product Boundary

README 已改为 macOS-first / Mac-only active maintenance，但本 docs PR 不表示 CI/release 已经清理完成。CI/release pruning、app identity、原版 App 混淆和 release 策略由下一实现 PR [mac-product-baseline.md](./mac-product-baseline.md) 处理。

## Done When

- PR E / H-lite / G / F / I / J / K 都完成或明确路由。
- 每个 PR 都记录 v0.5.x delta assessment。
- 本地 Agent sidecar、Agent UI、Agent pipeline 行为不回退。
- Mac-only product baseline 完成 CI/release/app identity 清理。
- Phase 7 backlog 有独立入口，不再作为 Phase 6 尾项混入。
- Follow-up issues #156/#152/#135/#136/#128 已完成；#120/#126 系列已完成到 #170；#143/#144/#139/#147/#146/#155 已完成、替代或路由。

## Validation for Future Implementation PRs

- 修改函数、类或方法前跑 GitNexus impact。
- 提交前跑 `npx gitnexus detect_changes --repo llm_wiki`。
- 相关单测和 `pnpm lint` 通过。
- `git diff --check` 无输出。
- Reviewer gate 无未解决 P0/P1/P2。
