# Phase 6: 上游同步，nashsu/llm_wiki v0.4.14 -> v0.4.23 功能对齐

> 类型：Phase 实施计划 | 创建：2026-06-05 | 更新：2026-06-12 | 状态：候选
> 上级：[Agent Sidecar 总规划](./agent-sidecar-roadmap.md)
> 前置：[Phase 5 计划](./agent-sidecar-phase5.md)（已完成）、[Phase 5.1 计划](./agent-sidecar-phase5.1.md)
> 后续：[Phase 6.1 Agent 后续计划](./agent-sidecar-phase6.1.md)
> 上游：`nashsu/llm_wiki` v0.4.23，2026-06-08

## 背景

Phase 1-5 期间，本地 fork 和上游 `nashsu/llm_wiki` 各自演进。本地主要做 Agent Sidecar、Agent UI、Agent pipeline；上游从 v0.4.15 到 v0.4.23 增加了普通用户功能、稳定性修复和 MCP/API 能力。

原计划基于 v0.4.20。2026-06-11 重新 fetch 后，上游已经到 v0.4.23。v0.4.20 之后又新增了 MinerU PDF、Schema-driven ingest、聊天图片粘贴、CLI PATH 修复、Embedding rebuild 安全、Doubao embedding、Dedup 超时修复和 Scheduled import 加固。

**双方分歧概览**：

| 维度 | 本地 main | 上游 v0.4.23 |
|------|-----------|--------------|
| 当前提交 | `f64118b` | `caff7f2` |
| 共同基线 | `ff84ee9`，上次同步到 v0.4.14 | 同左 |
| 本地新增重点 | Agent Sidecar、Agent UI、Agent Pipeline、Agent settings、sidecar binary | 无 Agent Sidecar |
| 上游新增重点 | 无 | MCP Server、主题、托盘、MinerU、Schema ingest、聊天图片、CLI/Embedding/ingest 加固 |
| `v0.4.20..v0.4.23` 规模 | - | 36 commits，100 files，+7688/-480 |
| `main..upstream/main` 规模 | - | 236 files，+19736/-32917 |
| 直接 merge 冲突 | - | 42 个冲突文件 |

**结论**：不能直接 `git merge upstream/main`。Rust 后端结构、Chat/Agent UI、ingest、settings、i18n 都有实质分歧。Phase 6 继续采用按功能手动 port，每批独立 PR。

---

## 上游 v0.4.14 -> v0.4.23 更新清单

### v0.4.15 - AnyTXT 集成、源文件导入、Lint 持久化

| # | 功能 | 描述 | 涉及文件 |
|---|------|------|----------|
| 1 | AnyTXT 聊天集成 | 聊天输入框新增 Web Search / AnyTXT 开关；外部搜索结果以 `[E1]` 引用注入 prompt | `chat-input.tsx`, `chat-message.tsx`, `chat-panel.tsx`, `preview-panel.tsx`, `anytxt-search.ts`, `deep-research.ts`, `chat-store.ts`, `wiki-store.ts` |
| 2 | 源文件导入增强 | Markdown 内联图片提取并复制到 `_images/`；支持直接导入图片文件 | `extract-source-images.ts`, `ingest.ts`, `ingest-sanitize.ts`, `source-lifecycle.ts`, `file-types.ts`, `wiki-page-types.ts` |
| 3 | 自定义 Embedding 请求头 | 支持网关认证；Rust 和 TS 双重校验，避免覆盖敏感头 | `search.rs`, `embedding.ts`, `embedding-section.tsx` |
| 4 | Lint 持久化 | 新增 `lint-store.ts`，持久化 lint 结果并接入 auto-save | `lint-store.ts`, `persist.ts`, `auto-save.ts`, `App.tsx`, `lint-view.tsx` |
| 5 | Mermaid SVG 缓存 | 缓存 Mermaid SVG，减少流式输出时重复 render | `mermaid-diagram.tsx`, `chat-message.tsx` |
| 6 | 图形 UX 改进 | 节点大小/间距滑块、密度自适应、自定义类型颜色、知识缺口关闭 | `graph-view.tsx` |
| 7 | 编辑器增强 | Cmd+S 立即保存，切换编辑/阅读模式时保存 | `wiki-editor.tsx`, `preview-panel.tsx` |
| 8 | 滚动溢出修复 | 修复 Sources 列表滚动容器 | `sources-view.tsx`, `scroll-area.tsx` |

### v0.4.16 - 图形渲染优化

| # | 功能 | 描述 | 涉及文件 |
|---|------|------|----------|
| 1 | Web Worker 布局 | 220+ 节点自动用 Worker 计算 ForceAtlas2，失败回退主线程 | `graph-layout-worker.ts`, `graph-view.tsx` |
| 2 | 自适应渲染参数 | 动态 layout iterations、边显示阈值、label 阈值、label 密度 | `graph-view.tsx` |
| 3 | 渲染策略重构 | `GraphRenderSettings`、`useSetSettings()`、`HoverState`、移动时隐藏边/标签 | `graph-view.tsx` |
| 4 | 搜索不卸载 Sigma | 空结果改成覆盖层，不卸载 `SigmaContainer` | `graph-view.tsx` |
| 5 | 布局指纹改进 | FNV-1a 哈希替代排序 join | `graph-view.tsx` |

### v0.4.17 - MCP Server、主题、托盘

| # | 功能 | 描述 | 涉及文件 |
|---|------|------|----------|
| 1 | MCP Server | 新增 `mcp-server/` npm 包，提供 status/projects/files/read/search/graph/rescan 等工具 | `mcp-server/` |
| 2 | 暗色/亮色主题 | light/dark/system 三模式，监听 OS 主题，原生窗口主题同步 | `theme.ts`, `index.css`, `main.tsx`, `interface-section.tsx`, `app-layout.tsx`, `graph-view.tsx` |
| 3 | 系统托盘 | 最小化到托盘，Show/Quit 菜单，Linux 无托盘时降级 | `tray.rs`, `lib.rs`, `Cargo.toml`, `capabilities/default.json` |
| 4 | 通用设置 | 开机自启、关闭行为 ask/minimize/exit | `general-section.tsx`, `wiki-store.ts`, `project-store.ts`, `App.tsx` |
| 5 | SSE 解析加固 | OpenAI/Anthropic/Google parser 兼容无空格 `data:` | `llm-providers.ts` |
| 6 | Anthropic Prompt 缓存 | system block 支持 `cache_control: { type: "ephemeral" }` | `llm-providers.ts` |
| 7 | Claude CLI Transport | 修复空结果等待 completion，支持图片 block | `claude-cli-transport.ts`, `claude_cli.rs` |
| 8 | Kimi Coding 预设 | 新增 `api.kimi.com/coding` 和 `kimi-for-coding` | `llm-presets.ts`, `llm-providers.ts` |
| 9 | MiniMax M3 | 默认模型从 M2.7 升到 M3 | `llm-presets.ts` |
| 10 | Review View 修复 | 使用 `makeQueryFileName()`，wikilink 用完整文件名 | `review-view.tsx`, `wiki-filename.ts` |
| 11 | 重复图片提取防护 | 用 Map 按 project/source/slug/fingerprint 去重 | `ingest.ts`, `fs.rs` |
| 12 | Vision Caption 修复 | reasoning 模型强制 off，Codex CLI 拒绝 caption | `vision-caption.ts` |
| 13 | Reader Mode 样式 | h1/h2/h3 组件覆盖 | `wiki-reader.tsx` |
| 14 | Korean README | 新增韩文 README | `README_KO.md` |

### v0.4.18 - 关闭行为修复

| # | 功能 | 描述 |
|---|------|------|
| 1 | 默认关闭行为 | 默认从 ask 改为 minimize |
| 2 | 托盘感知最小化 | 托盘可用时 `window.hide()`，不可用时 `window.minimize()` |
| 3 | Ask 对话框 | 用 Quit / Hide Window 替代通用 OK / Cancel |

### v0.4.19 - 标题栏拖拽修复

| # | 功能 | 描述 |
|---|------|------|
| 1 | MacTitlebarDragRegion | 增加 `data-tauri-drag-region` 和 fixed bar，v0.4.20 后被移除 |

### v0.4.20 - 原生标题栏主题

| # | 功能 | 描述 |
|---|------|------|
| 1 | Transparent titleBarStyle | 从 Overlay 切到 Transparent，移除自定义 drag region |
| 2 | 原生主题同步 | `syncNativeWindowTheme()` 调用 `win.setTheme()` 和 `win.setBackgroundColor()` |
| 3 | 新权限 | `core:window:allow-set-background-color`、`core:window:allow-set-theme` |

### v0.4.21 - PDF、Schema、CLI 和聊天能力扩展

| # | 功能 | 描述 | 涉及文件 |
|---|------|------|----------|
| 1 | MinerU PDF 解析 | 可选接入 MinerU v4 API，PDF 先转 Markdown，再进入 ingest；默认仍用内置 pdfium | `mineru.ts`, `mineru-section.tsx`, `ingest.ts`, `wiki-store.ts`, `project-store.ts`, `settings-view.tsx` |
| 2 | Schema-driven ingest | 读取 `schema.md` 的 Page Types，校验生成页面 type 与目录匹配 | `wiki-schema.ts`, `ingest.ts`, `ingest.prompt.test.ts`, `ingest.scenarios.test.ts` |
| 3 | 聊天粘贴截图 | 聊天输入支持粘贴图片、文件选择、缩略图、删除；用户消息支持 image block | `chat-image-utils.ts`, `chat-input.tsx`, `chat-message.tsx`, `chat-panel.tsx`, `chat-store.ts`, `llm-client.ts` |
| 4 | Markdown/Obsidian 图片渲染 | 支持 `![[target]]` / `![[target|alias]]` 转标准 Markdown 图片，按文件路径解析相对图片 | `markdown-image-resolver.ts`, `wikilink-transform.ts`, `wiki-reader.tsx`, `file-preview.tsx`, `preview-panel.tsx` |
| 5 | CLI 命令解析加固 | macOS/Linux GUI 启动时从 login shell PATH 解析 Claude/Codex CLI，fallback 到 `/bin/sh` | `cli_resolver.rs`, `claude_cli.rs`, `codex_cli.rs`, `commands/mod.rs` |
| 6 | 本地 CLI 隔离设置 | 增加本地 CLI 隔离控制 | `settings`, `wiki-store.ts`, CLI transport 相关文件 |
| 7 | Review API / MCP 扩展 | API 和 MCP 暴露 unresolved review items | `api_server.rs`, `mcp-server/src/api-client.ts`, `mcp-server/src/index.ts` |
| 8 | Ollama reasoning 修复 | Ollama OpenAI-compatible 路径映射 `reasoning_effort: "none"`，避免 thinking 模型空输出 | `llm-providers.ts`, `connection-tests.ts` |

### v0.4.22 - MinerU 和写入安全修复

| # | 功能 | 描述 | 涉及文件 |
|---|------|------|----------|
| 1 | MinerU 加固 | 处理 ZIP 图片资源、HTML 图片、超大文件、错误码、poll 超时和取消 | `mineru.ts`, `mineru.test.ts`, `ingest.ts` |
| 2 | 拒绝相对写路径 | Rust fs 写入命令拒绝相对路径，减少误写项目外路径风险 | `fs.rs`, `fs.ts`, `fs.test.ts` |
| 3 | 源摘要 slug 兼容 | 保持 source summary slug 兼容，避免旧项目路径漂移 | `ingest.ts`, `source-identity.ts` |

### v0.4.23 - 稳定性和 embedding 修复

| # | 功能 | 描述 | 涉及文件 |
|---|------|------|----------|
| 1 | Codex CLI child PATH | 运行 Codex 时把 login shell PATH 注入 child PATH，解决 `#!/usr/bin/env node` 找不到 node | `cli_resolver.rs`, `codex_cli.rs` |
| 2 | Dedup 超时修复 | dedup LLM 调用禁用 reasoning，并设置 max_tokens；stream backstop 错误转成人类可读 timeout | `dedup-runner.ts`, `llm-client.ts` |
| 3 | Embedding rebuild 安全 | rebuild 先准备 chunks，再清理旧索引；失败时保留旧索引或给出明确错误 | `embedding.ts`, `vectorstore.rs` |
| 4 | Doubao Embedding | 支持 Doubao multimodal embedding 请求 body 和配置提示 | `embedding.ts`, `search.rs`, `embedding-section.tsx` |
| 5 | Ingest / scheduled import 加固 | scheduled import、preset resolver、Markdown 图片解析和 ingest 解析边界修复 | `ingest.ts`, `scheduled-import.ts`, `preset-resolver.ts`, `markdown-image-resolver.ts` |

---

## 当前冲突判断

### 直接 merge 的冲突文件

`git merge-tree --name-only main upstream/main` 预估 42 个冲突文件：

| 区域 | 冲突文件 |
|------|----------|
| README | `README.md`, `README_CN.md`, `README_JA.md` |
| Rust 后端 | `src-tauri/src/commands/file_ops/fs.rs`, `src-tauri/src/commands/mod.rs`, `src-tauri/src/commands/search/search.rs`, `src-tauri/src/lib.rs`, `src-tauri/tauri.conf.json` |
| App / layout | `src/App.tsx`, `preview-panel.tsx` |
| Chat / Agent UI | `chat-input.tsx`, `chat-message.tsx`, `chat-panel.tsx`, `chat-store.ts` |
| Editor / reader | `wiki-editor.tsx`, `wiki-reader.tsx` |
| Graph | `graph-view.tsx` |
| Lint / review | `lint-view.tsx`, `lint-view.test.ts`, `lint-store.ts`, `review-view.tsx` |
| Settings / i18n | `embedding-section.tsx`, `settings-types.ts`, `settings-view.tsx`, `en.json`, `zh.json` |
| LLM / search | `claude-cli-transport.ts`, `codex-cli-transport.ts`, `deep-research.ts`, `web-search.ts`, `embedding.test.ts` |
| Ingest / persist | `extract-source-images.ts`, `ingest.ts`, `ingest.prompt.test.ts`, `ingest-source-path-collision.test.ts`, `persist.ts`, `persist.integration.test.ts`, `source-lifecycle.ts` |

### 结构性风险

| 风险 | 说明 | 处理方式 |
|------|------|----------|
| Rust 模块结构不同 | 上游是扁平 `commands/*.rs`，本地是 `agent_cli/`, `file_ops/`, `search/` 子模块 | 不能照搬路径，按本地模块手动映射 |
| Chat 和 Agent UI 重叠 | 上游改聊天图片、AnyTXT、Claude/Codex 图片 block；本地有 Agent permission、timeline、rewind、resume | 聊天相关功能独立 PR，逐函数融合 |
| Ingest 已大幅分叉 | 上游把 MinerU、schema routing、图片导入、scheduled import 都接到 ingest | 先 port 安全修复，再 port MinerU |
| Settings 状态膨胀 | 上游加 theme/general/mineru/local CLI；本地加 agent settings/resource settings | 每次只引入一个 state slice |
| Embedding 涉及数据安全 | rebuild 失败可能清空或损坏索引 | 优先 port rebuild safety，并补测试 |
| MCP 与本地 Agent sidecar 功能边界接近 | 上游 MCP Server 和本地 Agent sidecar 都暴露项目能力 | 先保持两套入口独立，避免互相耦合 |

### 开放 Issues 对齐

2026-06-11 检查 `6tizer/llm_wiki` 开放 issues，共 15 个；2026-06-12 在 PR 5.1-A 验证中新增 #92。Phase 6 只记录和上游同步强相关的 issue。Phase 6 前必须修的 Agent 稳定性和测试门禁问题放进 [Phase 5.1](./agent-sidecar-phase5.1.md)，Phase 6 后再做的 Agent UX/架构问题放进 [Phase 6.1](./agent-sidecar-phase6.1.md)。

Phase 6 内处理或跟踪两项：

| Issue | 关联计划 | 处理方式 |
|-------|----------|----------|
| [#88 Search index logs duplicate wiki page stem warnings during Chat](https://github.com/6tizer/llm_wiki/issues/88) | PR C：Embedding 安全修复 + Doubao | port embedding rebuild safety 时一起检查 page_id 生成策略。上游 v0.4.23 改了 rebuild 和 source identity 相关逻辑，但不假设它自动解决本地同 stem query/source 冲突。PR C 验收要加入同 stem 不共享 vector page_id 的回归测试或明确去重策略。 |
| [#3 Explore internal RPC channel for embedded Agent wiki tools](https://github.com/6tizer/llm_wiki/issues/3) | PR A：MCP Server + Review API | 引入上游 MCP Server 时保持它和本地 Agent sidecar 通道解耦。Phase 6 不实现内部 RPC，但 PR A 要明确 MCP Server、local HTTP API、Agent sidecar 工具三者边界，避免把上游 MCP 当成 Agent 内部通道替代品。 |

不在 Phase 6 主线修复的 issue：

- #62, #64, #85, #87, #89, #90, #92：Phase 5.1 前置修复。
- #60, #65, #66, #67, #68, #84, #86：Phase 6.1 后续开发。

---

## Phase 6 实施方案

### 策略

继续按功能分 PR 手动 port。不要直接 merge 上游分支，也不要一次性重放所有提交。

Phase 6 开始前先完成 Phase 5.1，至少保证 Agent 资源限制闭环、app bridge 批量写入预算、QA 提取质量和全量测试门禁问题不再污染后续同步验收。

每个 PR 的基本流程：

1. 用 GitNexus 查相关流程和影响面。
2. 从上游按功能取 patch，映射到本地结构。
3. 保留本地 Agent Sidecar 行为。
4. 跑对应单测、`pnpm lint`，必要时跑 `pnpm test`。
5. 提交前跑 `gitnexus detect_changes`。

---

## 新版 PR 切分

### PR A：MCP Server + Review API

**目标**：引入上游 MCP Server，并补齐 unresolved review items API。

| 功能 | 工作量 | 操作 |
|------|--------|------|
| MCP Server | 0.5 day | 复制 `mcp-server/`，接入 package scripts |
| Review API | 0.3 day | `api_server.rs` 增加 unresolved review endpoint |
| MCP reviews 工具 | 0.3 day | port `mcp-server/src/api-client.ts` 和 `index.ts` 中 reviews 支持 |
| README / settings 文档 | 0.2 day | 更新 API/MCP 文档，保留本地 Agent README 定位 |

**预计总工时**：1-1.5 days | **风险**：LOW-MEDIUM | **优先级**：P0

**注意**：本地没有 `mcp-server/`，目录本身可直接复制；`api_server.rs` 会冲突，需要手动融合。参考 #3，PR A 只引入上游 MCP Server，不把它改造成 Agent sidecar 内部 RPC。

---

### PR B：CLI Resolver 和本地 CLI 稳定性

**目标**：先修 CLI 启动问题，避免 macOS GUI 启动时 Claude/Codex 找不到 PATH 或 node。

| 功能 | 工作量 | 操作 |
|------|--------|------|
| `cli_resolver.rs` | 0.4 day | 新增 resolver，按本地 `agent_cli/` 模块结构接入 |
| Claude CLI detect/spawn | 0.3 day | port login shell PATH 解析和 `/bin/sh` fallback |
| Codex CLI child PATH | 0.3 day | spawn 时注入 login shell PATH，解决 Node shebang |
| 本地 CLI 隔离设置 | 0.3 day | 评估是否与 Agent resource settings 合并 |
| 测试 | 0.3 day | 更新 Rust/TS CLI transport 测试 |

**预计总工时**：1.5 days | **风险**：MEDIUM | **优先级**：P0

**注意**：上游路径是 `src-tauri/src/commands/codex_cli.rs`，本地路径是 `src-tauri/src/commands/agent_cli/codex_cli.rs`。不能直接覆盖。

---

### PR C：Embedding 安全修复 + Doubao

**目标**：优先处理索引安全和 provider 兼容。

| 功能 | 工作量 | 操作 |
|------|--------|------|
| Embedding rebuild safety | 0.8 day | 先准备 chunks，再清旧索引；失败时保留旧索引 |
| Doubao embedding | 0.5 day | 支持 Doubao multimodal body、Rust search 配置、UI 提示 |
| 自定义 Embedding 请求头 | 0.5 day | port v0.4.15 的 extra headers 安全校验 |
| 测试 | 0.6 day | 跑 `embedding.test.ts`，补 rebuild 失败场景；覆盖 #88，同 stem query/source 不能共享 vector page_id，或明确写出去重策略 |

**预计总工时**：2-2.6 days | **风险**：MEDIUM | **优先级**：P0

**注意**：这是数据安全 PR，优先级高于 UI 功能。

---

### PR D：LLM Provider 和 Dedup 稳定性

**目标**：对齐 SSE、Prompt cache、Ollama reasoning、Dedup timeout 等 LLM 核心修复。

| 功能 | 工作量 | 操作 |
|------|--------|------|
| SSE 解析加固 | 0.5 day | `data:` 无空格兼容，补 OpenAI/Anthropic/Google 测试 |
| Anthropic Prompt cache | 0.4 day | system block array + cache_control |
| Kimi/Moonshot Bearer 扩展 | 0.2 day | 扩展 `requiresBearerAuth()` |
| Ollama reasoning off | 0.4 day | 映射 `reasoning_effort: "none"` |
| Dedup timeout | 0.4 day | dedup 禁用 reasoning，设置 max_tokens，修正 request cancelled 文案 |

**预计总工时**：2 days | **风险**：MEDIUM | **优先级**：P0

---

### PR E：Ingest 安全修复 + Schema Routing

**目标**：先把生成页面和写入路径变稳，再引入 MinerU。

| 功能 | 工作量 | 操作 |
|------|--------|------|
| Schema routing | 0.7 day | 新增 `wiki-schema.ts`，ingest 生成结果按 `schema.md` 校验目录 |
| Ingest hardening | 0.8 day | port source summary slug、lone pipe line、parse 边界、scheduled import 修复 |
| 拒绝相对写路径 | 0.4 day | Rust fs 写入命令拒绝相对路径 |
| Markdown/Obsidian 图片解析 | 0.6 day | port image resolver 和 `![[...]]` 转换 |
| 测试 | 0.5 day | 跑 ingest/schema/markdown image/scheduled import 测试 |

**预计总工时**：3 days | **风险**：HIGH | **优先级**：P0/P1

**注意**：`ingest.ts` 是冲突核心。先 port 安全和 schema，不要和 MinerU 混在一个 PR。

---

### PR F：MinerU PDF 解析

**目标**：引入可选 MinerU 云解析，默认行为不变。

| 功能 | 工作量 | 操作 |
|------|--------|------|
| MinerU API client | 0.8 day | 新增 `mineru.ts`，包含 submit/upload/poll/download/extract |
| Settings UI | 0.5 day | 新增 `mineru-section.tsx`，接入 settings draft 和 i18n |
| Store / persist | 0.4 day | `wiki-store.ts`、`project-store.ts` 增加 MinerU config |
| Ingest 接入 | 0.8 day | PDF ingest 前可选 MinerU preprocess，失败回退 pdfium |
| 测试 | 0.8 day | port `mineru.test.ts` 和 ingest PDF 场景 |

**预计总工时**：3-3.5 days | **风险**：HIGH | **优先级**：P1

**注意**：需要确认 token 存储策略，不能把 MinerU token 写入仓库或日志。

---

### PR G：聊天图片粘贴 + 多模态消息

**目标**：让普通聊天支持图片，同时不破坏 Agent stream UI。

| 功能 | 工作量 | 操作 |
|------|--------|------|
| 图片工具 | 0.3 day | 新增 `chat-image-utils.ts` |
| 输入框图片 | 0.8 day | 支持 paste/file picker/缩略图/删除/大小数量校验 |
| 消息渲染 | 0.5 day | user bubble 渲染图片缩略图 |
| LLM message 转换 | 0.6 day | `chatMessagesToLLM` 支持 ContentBlock[] |
| Agent UI 融合 | 0.8 day | 保留 permission、timeline、rewind、resume 等本地 Agent 行为 |
| 测试 | 0.5 day | port `chat-messages-to-llm.test.ts`，补 Agent 回归 |

**预计总工时**：3.5 days | **风险**：HIGH | **优先级**：P1

**注意**：这是和本地 Agent UI 冲突最大的 PR 之一。只做聊天图片，不顺手 port AnyTXT。

---

### PR H：主题、托盘、通用设置

**目标**：引入暗色/亮色主题、系统托盘和关闭行为设置。

| 功能 | 工作量 | 操作 |
|------|--------|------|
| 主题引擎 | 1 day | 新增 `theme.ts`，接入 `main.tsx`、`index.css`、Interface settings |
| 系统托盘 | 0.6 day | port `tray.rs`，映射本地 Rust 模块 |
| 通用设置 | 0.5 day | `general-section.tsx`、`wiki-store.ts`、`project-store.ts` |
| 关闭行为 | 0.5 day | ask/minimize/exit，托盘可用时 hide |
| 原生标题栏主题 | 0.4 day | Transparent titleBarStyle、window theme/background 权限 |

**预计总工时**：3-4 days | **风险**：HIGH | **优先级**：P1

---

### PR I：图形渲染优化

**目标**：对齐 v0.4.16 的图形性能优化。

| 功能 | 工作量 | 操作 |
|------|--------|------|
| Web Worker 布局 | 0.5 day | 新增 `graph-layout-worker.ts` |
| 自适应参数 | 0.5 day | port layout/edge/label 参数函数 |
| HoverState 重构 | 1 day | 替换逐节点属性遍历 |
| 搜索覆盖层 | 0.3 day | 空结果不卸载 Sigma |
| 布局指纹 | 0.2 day | FNV-1a hash |
| 暗色主题色板 | 0.3 day | dark-aware palette |

**预计总工时**：2.5-3 days | **风险**：HIGH | **优先级**：P1

---

### PR J：AnyTXT、源文件导入和 Lint 持久化

**目标**：补齐 v0.4.15 的用户功能增强。

| 功能 | 工作量 | 操作 |
|------|--------|------|
| AnyTXT 聊天集成 | 1.5 days | chat 系列文件加 AnyTXT 开关和外部引用 |
| 源文件导入增强 | 1 day | Markdown 内联图片提取、图片文件导入、source export |
| Lint 持久化 | 0.5 day | `lint-store.ts`、persist、auto-save |
| 编辑器增强 | 0.3 day | Cmd+S 立即保存，切换模式保存 |
| Review View 修复 | 0.3 day | `makeQueryFileName()` 和 callback replace |

**预计总工时**：3-4 days | **风险**：HIGH | **优先级**：P2

---

### PR K：低风险杂项

| 功能 | 工作量 | 优先级 |
|------|--------|--------|
| Korean README | 0.1 day | P3 |
| Japanese README 恢复评估 | 0.2 day | P3 |
| MiniMax M3 | 0.1 day | P2 |
| Kimi Coding preset | 0.1 day | P2 |
| Vision Caption 修复 | 0.2 day | P1 |
| Wiki filename Unicode | 0.1 day | P2 |
| Mermaid SVG 缓存 | 0.2 day | P2 |
| `.doc` 支持 | 0.5 day | P3 |

---

## 工时与优先级总览

| PR | 内容 | 工时 | 风险 | 优先级 |
|----|------|------|------|--------|
| A | MCP Server + Review API | 1-1.5d | LOW-MED | P0 |
| B | CLI Resolver 和本地 CLI 稳定性 | 1.5d | MED | P0 |
| C | Embedding 安全修复 + Doubao | 2-2.6d | MED | P0 |
| D | LLM Provider 和 Dedup 稳定性 | 2d | MED | P0 |
| E | Ingest 安全修复 + Schema Routing | 3d | HIGH | P0/P1 |
| F | MinerU PDF 解析 | 3-3.5d | HIGH | P1 |
| G | 聊天图片粘贴 + 多模态消息 | 3.5d | HIGH | P1 |
| H | 主题、托盘、通用设置 | 3-4d | HIGH | P1 |
| I | 图形渲染优化 | 2.5-3d | HIGH | P1 |
| J | AnyTXT、源文件导入和 Lint 持久化 | 3-4d | HIGH | P2 |
| K | 低风险杂项 | 1-1.5d | LOW | P2/P3 |

**P0 总工时**：约 9.5-11 days
**P0 + P1 总工时**：约 21.5-25 days
**全量 Phase 6**：约 26-31.5 days

---

## 推荐执行顺序

0. Phase 5.1：完成 Agent 资源限制闭环、app bridge 批量写入预算闭环、QA 提取质量修复和 real-LLM 测试门禁修复。
1. PR B：CLI Resolver 和本地 CLI 稳定性
2. PR C：Embedding 安全修复 + Doubao
3. PR D：LLM Provider 和 Dedup 稳定性
4. PR A：MCP Server + Review API
5. PR E：Ingest 安全修复 + Schema Routing
6. PR F：MinerU PDF 解析
7. PR G：聊天图片粘贴 + 多模态消息
8. PR H：主题、托盘、通用设置
9. PR I：图形渲染优化
10. PR J/K：剩余功能和低风险杂项

这个顺序先处理运行稳定性和数据安全，再处理大 UI 功能。Agent Sidecar 相关路径贯穿 Chat、CLI、settings，相关 PR 都要保留本地行为并补 Agent 回归测试。

---

## 验收标准

每个 PR 至少满足：

- 相关单测通过。
- `pnpm lint` 通过。
- 涉及 Rust 命令时，至少跑对应 Rust build/test 或 Tauri compile check。
- `git diff --check` 无输出。
- 提交前 `gitnexus detect_changes` 风险符合预期。

Phase 6 完成标准：

- 上游 v0.4.23 的 P0/P1 功能完成手动 port。
- Agent Sidecar、Agent UI、Agent pipeline 行为不回退。
- 直接 merge 上游不再是目标；本地 fork 明确保留 Agent 差异。
- 文档列出仍未 port 的 P2/P3 项。

---

## 边界

- 不新增自有功能，只对齐上游已有改动。
- 不改变 Agent Sidecar 架构。
- 不移除 Agent sidecar binary 或本地 Agent 设置。
- 不把 MinerU、LLM、API token 写入仓库、日志、PR 描述或测试快照。
- 不做一次性大 merge。
