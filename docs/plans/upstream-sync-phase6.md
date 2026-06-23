# Phase 6: 上游同步，nashsu/llm_wiki v0.4.14 -> v0.4.25 功能对齐

> 类型：Phase 实施计划 | 创建：2026-06-05 | 更新：2026-06-23 | 状态：候选
> 上级：[Agent Sidecar 总规划](./agent-sidecar-roadmap.md)
> 前置：[Phase 5 计划](./agent-sidecar-phase5.md)（已完成）、[Phase 5.1 计划](./agent-sidecar-phase5.1.md)
> 后续：[Phase 6.1 Agent 后续计划](./agent-sidecar-phase6.1.md)
> 上游：`nashsu/llm_wiki` v0.4.25，2026-06-23

## 背景

Phase 1-5 期间，本地 fork 和上游 `nashsu/llm_wiki` 各自演进。本地主要做 Agent Sidecar、Agent UI、Agent pipeline 和 Agent 安全闭环；上游从 v0.4.15 到 v0.4.25 增加了普通用户功能、稳定性修复、MCP/API 能力、桌面打包能力和索引安全修复。

原计划基于 v0.4.20；2026-06-11 重新 fetch 后上游到 v0.4.23；2026-06-23 再次核对后上游已经到 v0.4.25。v0.4.24 / v0.4.25 又新增了 zoom/layout/chat standalone、lint link repair、review preservation / review-create-page、vector cleanup / unicode page ids / chunk prune、Firecrawl provider、MCP desktop bundling、Claude/Codex active project root、CJK ingest filenames、Q&A visible-title、subject boundary preservation 和 deep research failed-source errors。

**双方分歧概览**：

| 维度 | 本地 main | 上游 v0.4.25 |
|------|-----------|--------------|
| 当前提交 | `e574ae5` | `95175ae` |
| 共同基线 | `ff84ee9`，上次同步到 v0.4.14 | 同左 |
| 本地新增重点 | Agent Sidecar、Agent UI、Agent Pipeline、Agent settings、sidecar binary、Agent 资源限制闭环 | 无 Agent Sidecar |
| 上游新增重点 | 无 | MCP Server、桌面打包 MCP、主题/托盘/zoom、MinerU、Schema ingest、聊天图片、Firecrawl、CLI/Embedding/ingest/deep research 加固 |
| `v0.4.23..v0.4.25` 规模 | - | 38 commits，93 files，+4606/-558 |
| 直接 merge 冲突 | - | 51 files / 51 个冲突文件 |

**结论**：不能直接 `git merge upstream/main`。Rust 后端结构、Chat/Agent UI、ingest、settings、i18n、MCP 打包和索引相关逻辑都有实质分歧。Phase 6 继续采用按功能手动 port，每批独立 PR。

---

## 上游 v0.4.14 -> v0.4.25 更新清单

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

### v0.4.18 - v0.4.20：关闭行为、标题栏和原生主题

| 版本 | 功能 | 描述 |
|------|------|------|
| v0.4.18 | 关闭行为修复 | 默认关闭行为改为 minimize；托盘可用时 `window.hide()`，不可用时 `window.minimize()`；Ask 对话框改用 Quit / Hide Window |
| v0.4.19 | 标题栏拖拽修复 | 增加 `data-tauri-drag-region` 和 fixed bar，v0.4.20 后被移除 |
| v0.4.20 | 原生标题栏主题 | `titleBarStyle` 从 Overlay 切到 Transparent；同步 native window theme/background；新增 window theme/background 权限 |

### v0.4.21 - PDF、Schema、CLI 和聊天能力扩展

| # | 功能 | 描述 | 涉及文件 |
|---|------|------|----------|
| 1 | MinerU PDF 解析 | 可选接入 MinerU v4 API，PDF 先转 Markdown，再进入 ingest；默认仍用内置 pdfium | `mineru.ts`, `mineru-section.tsx`, `ingest.ts`, `wiki-store.ts`, `project-store.ts`, `settings-view.tsx` |
| 2 | Schema-driven ingest | 读取 `schema.md` 的 Page Types，校验生成页面 type 与目录匹配 | `wiki-schema.ts`, `ingest.ts`, `ingest.prompt.test.ts`, `ingest.scenarios.test.ts` |
| 3 | 聊天粘贴截图 | 聊天输入支持粘贴图片、文件选择、缩略图、删除；用户消息支持 image block | `chat-image-utils.ts`, `chat-input.tsx`, `chat-message.tsx`, `chat-panel.tsx`, `chat-store.ts`, `llm-client.ts` |
| 4 | Markdown/Obsidian 图片渲染 | 支持 `![[target]]` / `![[target|alias]]` 转标准 Markdown 图片，按文件路径解析相对图片 | `markdown-image-resolver.ts`, `wikilink-transform.ts`, `wiki-reader.tsx`, `file-preview.tsx`, `preview-panel.tsx` |
| 5 | CLI 命令解析加固 | macOS/Linux GUI 启动时从 login shell PATH 解析 Claude/Codex CLI，fallback 到 `/bin/sh` | `cli_resolver.rs`, `claude_cli.rs`, `codex_cli.rs`, `commands/mod.rs` |
| 6 | 本地 CLI 隔离设置 | 增加本地 CLI 隔离控制 | settings、`wiki-store.ts`、CLI transport 相关文件 |
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

### v0.4.24 - Zoom、Chat standalone、Review/Vector 加固

| # | 功能 | 描述 | 涉及文件 |
|---|------|------|----------|
| 1 | Zoom 设置 | 新增 zoom button，并迁移到 Settings / Interface；使用 root font size 替代 transform scale，修复定位错乱 | `interface-section.tsx`, `settings-view.tsx`, layout / style 相关文件 |
| 2 | Chat standalone view | 将 chat 重构为独立 view，减少 preview panel 绑定 | `App.tsx`, `chat-panel.tsx`, layout 相关文件 |
| 3 | Lint link repair | lint 提供链接修复建议 | `lint-view.tsx`, lint 相关 store/test |
| 4 | Review preservation | 切换项目时保留 review items；restore 后 review id 保持唯一 | `review-store.ts`, `review-store.test.ts` |
| 5 | Vector cleanup | reindex 后清理 legacy vector table；索引后 prune LanceDB chunk versions | `embedding.ts`, `vectorstore.rs` |
| 6 | Unicode vector page ids | 允许 Unicode vector page id，降低 CJK/非 ASCII 项目的索引漂移 | `embedding.ts`, `search.rs` |
| 7 | Embedding prefilter / origin override | duplicate scan 接入 embedding prefilter；local embeddings 支持 origin override | `embedding.ts`, dedup / duplicate scan 相关文件 |
| 8 | CLI provider test isolation | 隔离 CLI provider connection tests，降低环境依赖噪音 | `connection-tests.ts`, CLI transport tests |
| 9 | Codex project root | Codex CLI 从 project root 运行 | `codex-cli-transport.ts`, Rust CLI command |
| 10 | Autosave / project create / language prompt | project open autosave 加固；project creation required fields 可见；语言 prompt 保留技术名 | store / settings / prompt 相关文件 |
| 11 | Windows startup | 修复 Windows startup blank screen | Tauri / app startup 相关文件 |

### v0.4.25 - MCP 桌面打包、Firecrawl、Ingest/QA/Deep Research 加固

| # | 功能 | 描述 | 涉及文件 |
|---|------|------|----------|
| 1 | MCP desktop bundling | 将 MCP server 随 desktop app 打包，并映射 bundled MCP resources 到 app resources | `mcp-server/`, `src-tauri/`, tauri config / build 相关文件 |
| 2 | MCP resources CI prep | CI Rust build 前准备 MCP resources，避免 desktop bundle 缺资源 | `.github/workflows/`, build scripts |
| 3 | Firecrawl provider | 新增 Firecrawl web search provider | `web-search.ts`, `web-search.test.ts`, settings i18n |
| 4 | Claude active project dir | Claude CLI 从 active project directory 运行 | `claude-cli-transport.ts`, Rust CLI command |
| 5 | CJK ingest filenames | ingest filename 保持目标语言，避免 CJK 标题被错误转写 | `ingest.ts`, filename / source identity 相关文件 |
| 6 | Q&A visible-title | 保存的 Q&A title 从 visible content 推导 | QA / ingest 相关文件 |
| 7 | Review create page | missing-page reviews 可创建具体页面 | `review-view.tsx`, `review-store.ts` |
| 8 | Deep research failed sources | deep research failed source 标记为 error，而不是被静默吞掉 | `deep-research.ts`, `deep-research.test.ts` |
| 9 | Subject boundary preservation | generated context 保留 subject boundaries | context / ingest / prompt 相关文件 |

---

## 当前冲突判断

### 直接 merge 的冲突文件

`git merge-tree HEAD upstream/main` 预估 51 files / 51 个冲突文件：

| 区域 | 冲突文件 |
|------|----------|
| CI / README | `.github/workflows/build.yml`, `.github/workflows/ci.yml`, `README.md`, `README_CN.md`, `README_JA.md` |
| Rust 后端 / Tauri | `src-tauri/src/commands/file_ops/fs.rs`, `src-tauri/src/commands/mod.rs`, `src-tauri/src/commands/search/search.rs`, `src-tauri/src/lib.rs`, `src-tauri/tauri.conf.json`, `src-tauri/tauri.linux.conf.json`, `src-tauri/tauri.macos.conf.json`, `src-tauri/tauri.windows.conf.json` |
| App / layout | `src/App.tsx`, `src/components/layout/preview-panel.tsx` |
| Chat / Agent UI | `src/components/chat/chat-input.tsx`, `src/components/chat/chat-message.tsx`, `src/components/chat/chat-panel.tsx`, `src/stores/chat-store.ts` |
| Editor / reader / graph | `src/components/editor/wiki-editor.tsx`, `src/components/editor/wiki-reader.tsx`, `src/components/graph/graph-view.tsx` |
| Lint / review | `src/components/lint/lint-view.test.ts`, `src/components/lint/lint-view.tsx`, `src/components/review/review-view.tsx`, `src/stores/lint-store.ts`, `src/stores/review-store.test.ts`, `src/stores/review-store.ts` |
| Settings / i18n | `src/components/settings/sections/embedding-section.tsx`, `src/components/settings/sections/web-search-section.tsx`, `src/components/settings/settings-types.ts`, `src/components/settings/settings-view.tsx`, `src/i18n/en.json`, `src/i18n/zh.json` |
| CLI / LLM / search | `src/lib/claude-cli-transport.ts`, `src/lib/codex-cli-transport.test.ts`, `src/lib/codex-cli-transport.ts`, `src/lib/deep-research.test.ts`, `src/lib/deep-research.ts`, `src/lib/embedding.test.ts`, `src/lib/web-search.test.ts`, `src/lib/web-search.ts` |
| Ingest / persist / source lifecycle | `src/lib/extract-source-images.ts`, `src/lib/ingest-source-path-collision.test.ts`, `src/lib/ingest.prompt.test.ts`, `src/lib/ingest.ts`, `src/lib/persist.integration.test.ts`, `src/lib/persist.ts`, `src/lib/source-lifecycle.test.ts`, `src/lib/source-lifecycle.ts`, `src/stores/wiki-store.ts` |

### 结构性风险

| 风险 | 说明 | 处理方式 |
|------|------|----------|
| Rust 模块结构不同 | 上游是扁平 `commands/*.rs`，本地是 `agent_cli/`, `file_ops/`, `search/` 子模块 | 不能照搬路径，按本地模块手动映射 |
| Chat 和 Agent UI 重叠 | 上游改 chat standalone、聊天图片、AnyTXT、Claude/Codex 图片 block；本地有 Agent permission、timeline、rewind、resume 和 resource limit notice | 聊天相关功能拆小 PR，逐函数融合并补 Agent 回归 |
| Ingest 已大幅分叉 | 上游把 MinerU、schema routing、图片导入、scheduled import、CJK filename、visible-title 都接到 ingest | 先 port 安全修复，再 port MinerU 和 UX 能力 |
| Settings 状态膨胀 | 上游加 theme/general/mineru/local CLI/Firecrawl/zoom；本地加 agent settings/resource settings | 每次只引入一个 state slice，避免设置页大冲突 |
| Embedding 涉及数据安全 | rebuild 失败、legacy table、unicode id、chunk prune 都影响索引完整性 | 优先 port rebuild/vector safety，并补测试 |
| MCP 与本地 Agent sidecar 功能边界接近 | 上游 MCP Server 和本地 Agent sidecar 都暴露项目能力 | 先保持两套入口独立，避免互相耦合 |
| Desktop bundle / CI 与本地 sidecar 打包相邻 | 上游 MCP bundle 和本地 agent sidecar binary 都影响 Tauri resources | 单独 PR 处理 resources 和 CI，避免和业务代码混杂 |

### 开放 Issues 对齐

Phase 6 只记录和上游同步强相关的 issue。Phase 6 前必须修的 Agent 稳定性和测试门禁问题放进 [Phase 5.1](./agent-sidecar-phase5.1.md)，Phase 6 后再做的 Agent UX/架构问题放进 [Phase 6.1](./agent-sidecar-phase6.1.md)。

Phase 6 内处理或跟踪两项：

| Issue | 关联计划 | 处理方式 |
|-------|----------|----------|
| [#88 Search index logs duplicate wiki page stem warnings during Chat](https://github.com/6tizer/llm_wiki/issues/88) | PR C：Embedding + vector safety | port rebuild safety、unicode page ids、legacy table cleanup、chunk prune、embedding prefilter 时一起检查 page_id 生成策略。PR C 验收要加入同 stem query/source 不共享 vector page_id 的回归测试，或明确写出去重策略。 |
| [#3 Explore internal RPC channel for embedded Agent wiki tools](https://github.com/6tizer/llm_wiki/issues/3) | PR A：MCP server + desktop bundling | 引入上游 MCP Server 时保持它和本地 Agent sidecar 通道解耦。Phase 6 不实现内部 RPC，但 PR A 要明确 MCP Server、local HTTP API、Agent sidecar 工具三者边界。 |

不在 Phase 6 主线修复的 issue：

- #62, #64, #85, #87, #89, #90, #92：Phase 5.1 前置修复或 issue sweep。
- #60, #65, #66, #67, #68, #84, #86：Phase 6.1 后续开发。

---

## Phase 6 实施方案

### 策略

继续按功能分 PR 手动 port。不要直接 merge 上游分支，也不要一次性重放所有提交。

Phase 6 开始前先确认 Phase 5.1 已完成并完成 issue sweep，至少保证 Agent 资源限制闭环、app bridge 批量写入预算、QA 提取质量和全量测试门禁问题不再污染后续同步验收。

每个实现 PR 的基本流程：

1. 用 GitNexus 查相关流程和影响面；修改函数、类或方法前必须跑 impact。
2. 从上游按功能取 patch，映射到本地结构。
3. 保留本地 Agent Sidecar 行为。
4. 跑对应单测、`pnpm lint`，必要时跑 `pnpm test`。
5. 提交前跑 `gitnexus detect_changes`。
6. 按 PR 风险选择 Codex 自查和 Claude ACP 深度审查。

---

## Phase 6 PR 切分

### PR A：MCP server + desktop bundling

**目标**：引入上游 MCP Server、unresolved review items API、desktop app bundling 和 MCP resources CI prep。

| 功能 | 工作量 | 操作 |
|------|--------|------|
| MCP Server | 0.5 day | 复制 `mcp-server/`，接入 package scripts |
| Review API | 0.3 day | `api_server.rs` 增加 unresolved review endpoint |
| MCP reviews 工具 | 0.3 day | port `mcp-server/src/api-client.ts` 和 `index.ts` 中 reviews 支持 |
| Desktop bundling | 0.6 day | 映射 bundled MCP resources 到 Tauri app resources |
| CI resources prep | 0.3 day | CI Rust build 前准备 MCP resources |
| README / settings 文档 | 0.2 day | 更新 API/MCP 文档，保留本地 Agent README 定位 |

**预计总工时**：2-2.5 days | **风险**：MEDIUM | **优先级**：P0

**注意**：本地没有 `mcp-server/`，目录本身可直接复制；Tauri resources 和 sidecar binary 打包相邻，必须手动融合。参考 #3，PR A 只引入上游 MCP Server，不把它改造成 Agent sidecar 内部 RPC。

---

### PR B：CLI resolver / active project root / connection test isolation

**目标**：先修 CLI 启动问题，避免 macOS GUI 启动时 Claude/Codex 找不到 PATH、node 或运行在错误目录。

| 功能 | 工作量 | 操作 |
|------|--------|------|
| `cli_resolver.rs` | 0.4 day | 新增 resolver，按本地 `agent_cli/` 模块结构接入 |
| Claude CLI detect/spawn | 0.4 day | port login shell PATH 解析、`/bin/sh` fallback、active project directory |
| Codex CLI child PATH/root | 0.4 day | spawn 时注入 login shell PATH，并从 project root 运行 |
| 本地 CLI 隔离设置 | 0.3 day | 评估是否与 Agent resource settings 合并 |
| Connection test isolation | 0.3 day | 隔离 CLI provider connection tests，降低环境依赖噪音 |
| 测试 | 0.3 day | 更新 Rust/TS CLI transport 测试 |

**预计总工时**：1.8-2.1 days | **风险**：MEDIUM | **优先级**：P0

**注意**：上游路径是 `src-tauri/src/commands/codex_cli.rs`，本地路径是 `src-tauri/src/commands/agent_cli/codex_cli.rs`。不能直接覆盖。

---

### PR C：Embedding + vector safety

**目标**：优先处理索引安全、vector cleanup 和 provider 兼容。

| 功能 | 工作量 | 操作 |
|------|--------|------|
| Embedding rebuild safety | 0.8 day | 先准备 chunks，再清旧索引；失败时保留旧索引 |
| Legacy vector cleanup | 0.5 day | reindex 后清理 legacy vector table |
| Chunk prune | 0.4 day | indexing 后 prune LanceDB chunk versions |
| Unicode vector page ids | 0.4 day | 允许 Unicode page id，覆盖 CJK/非 ASCII 场景 |
| Duplicate scan prefilter | 0.4 day | duplicate scan 接入 embedding prefilter |
| Local embedding origin override | 0.3 day | port origin override |
| Doubao embedding | 0.5 day | 支持 Doubao multimodal body、Rust search 配置、UI 提示 |
| 自定义 Embedding 请求头 | 0.5 day | port extra headers 安全校验 |
| 测试 | 0.8 day | 跑 `embedding.test.ts`，补 rebuild 失败、unicode id、chunk prune、#88 同 stem 场景 |

**预计总工时**：4-4.6 days | **风险**：MEDIUM-HIGH | **优先级**：P0

**注意**：这是数据安全 PR，优先级高于 UI 功能。

---

### PR D：LLM provider / dedup / deep research stability

**目标**：对齐 SSE、Prompt cache、Ollama reasoning、Dedup timeout、Firecrawl 和 deep research failed-source errors。

| 功能 | 工作量 | 操作 |
|------|--------|------|
| SSE 解析加固 | 0.5 day | `data:` 无空格兼容，补 OpenAI/Anthropic/Google 测试 |
| Anthropic Prompt cache | 0.4 day | system block array + cache_control |
| Kimi/Moonshot Bearer 扩展 | 0.2 day | 扩展 `requiresBearerAuth()` |
| Ollama reasoning off | 0.4 day | 映射 `reasoning_effort: "none"` |
| Dedup timeout | 0.4 day | dedup 禁用 reasoning，设置 max_tokens，修正 request cancelled 文案 |
| Firecrawl provider | 0.7 day | 接入 Web Search provider、settings 和 i18n |
| Deep research failed-source errors | 0.5 day | failed source 标记为 error，并补测试 |
| 测试 | 0.6 day | 跑 provider/dedup/web-search/deep-research 相关测试 |

**预计总工时**：3.5-4 days | **风险**：MEDIUM | **优先级**：P0

---

### PR E：Ingest/schema/review-create-page safety

**目标**：先把生成页面和写入路径变稳，再引入 MinerU。

| 功能 | 工作量 | 操作 |
|------|--------|------|
| Schema routing | 0.7 day | 新增 `wiki-schema.ts`，ingest 生成结果按 `schema.md` 校验目录 |
| Ingest hardening | 0.8 day | port source summary slug、lone pipe line、parse 边界、scheduled import 修复 |
| 拒绝相对写路径 | 0.4 day | Rust fs 写入命令拒绝相对路径 |
| Markdown/Obsidian 图片解析 | 0.6 day | port image resolver 和 `![[...]]` 转换 |
| CJK ingest filenames | 0.4 day | 保持目标语言 filename，避免 CJK 标题被错误转写 |
| Q&A visible-title | 0.3 day | 保存 Q&A title 从 visible content 推导 |
| Missing-page review create page | 0.4 day | review missing-page 可创建具体页面 |
| Review preservation | 0.4 day | 切换项目时保留 review items，restore 后保持 review id 唯一 |
| Subject boundary preservation | 0.4 day | generated context 保留 subject boundaries |
| 测试 | 0.7 day | 跑 ingest/schema/markdown image/review/deep context 相关测试 |

**预计总工时**：5-5.4 days | **风险**：HIGH | **优先级**：P0/P1

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
| Chat standalone 完整迁移 | 0.8 day | 完成 chat 独立 view 迁移，减少 preview panel 绑定 |
| Agent UI 融合 | 0.8 day | 保留 permission、timeline、rewind、resume、resource limit notice 等本地 Agent 行为 |
| 测试 | 0.5 day | port `chat-messages-to-llm.test.ts`，补 Agent 回归 |

**预计总工时**：4.2-4.5 days | **风险**：HIGH | **优先级**：P1

**注意**：这是和本地 Agent UI 冲突最大的 PR 之一。只做聊天图片和 chat standalone，不顺手 port AnyTXT。

---

### PR H-lite：zoom/layout/app visibility

**目标**：先 port 用户可见但较独立的 zoom、layout 和 app visibility 修复，不把完整主题/托盘塞进同一 PR。

| 功能 | 工作量 | 操作 |
|------|--------|------|
| Zoom button / settings | 0.6 day | 接入 Interface settings，避免 transform scale |
| Layout position 修复 | 0.5 day | 用 root font size 处理 zoom，验证浮层和点击定位 |
| Chat standalone 预备 | 0.6 day | 只做必要的 layout 解耦，不在本 PR 完整迁移 chat |
| Project open autosave hardening | 0.3 day | port project open 期间 autosave 加固 |
| Project creation visibility | 0.2 day | required fields 可见性修复 |
| Language prompt technical names | 0.2 day | language prompt 保留技术名 |
| Windows startup blank screen | 0.3 day | port app startup 可见性修复 |
| 测试 / 手动验收 | 0.5 day | Settings、preview、chat、window startup 验收 |

**预计总工时**：3-3.5 days | **风险**：MEDIUM-HIGH | **优先级**：P1

---

### PR I：主题、托盘、通用设置

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

### PR J：图形渲染优化

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

### PR K：AnyTXT、源文件导入、Lint 持久化和低风险杂项

**目标**：补齐剩余用户功能增强，避免污染 P0/P1 稳定性 PR。

| 功能 | 工作量 | 优先级 |
|------|--------|--------|
| AnyTXT 聊天集成 | 1.5 days | P2 |
| 源文件导入增强 | 1 day | P2 |
| Lint 持久化 | 0.5 day | P2 |
| Lint link repair | 0.4 day | P2 |
| 编辑器增强 | 0.3 day | P2 |
| Review View 修复 | 0.3 day | P2 |
| Korean README | 0.1 day | P3 |
| Japanese README 恢复评估 | 0.2 day | P3 |
| MiniMax M3 / Kimi Coding preset | 0.2 day | P2 |
| Vision Caption 修复 | 0.2 day | P1 |
| Mermaid SVG 缓存 | 0.2 day | P2 |
| `.doc` 支持 | 0.5 day | P3 |

**预计总工时**：5-6 days | **风险**：MEDIUM-HIGH | **优先级**：P2/P3

---

## 工时与优先级总览

| PR | 内容 | 工时 | 风险 | 优先级 |
|----|------|------|------|--------|
| A | MCP server + desktop bundling | 2-2.5d | MED | P0 |
| B | CLI resolver / active project root / connection test isolation | 1.8-2.1d | MED | P0 |
| C | Embedding + vector safety | 4-4.6d | MED-HIGH | P0 |
| D | LLM provider / dedup / deep research stability | 3.5-4d | MED | P0 |
| E | Ingest/schema/review-create-page safety | 5-5.4d | HIGH | P0/P1 |
| F | MinerU PDF 解析 | 3-3.5d | HIGH | P1 |
| G | 聊天图片粘贴 + 多模态消息 + chat standalone | 4.2-4.5d | HIGH | P1 |
| H-lite | zoom/layout/app visibility | 3-3.5d | MED-HIGH | P1 |
| I | 主题、托盘、通用设置 | 3-4d | HIGH | P1 |
| J | 图形渲染优化 | 2.5-3d | HIGH | P1 |
| K | AnyTXT、源文件导入、Lint 持久化和低风险杂项 | 5-6d | MED-HIGH | P2/P3 |

**P0 总工时**：约 16.3-18.6 days
**P0 + P1 总工时**：约 32.0-37.1 days
**全量 Phase 6**：约 37.0-43.1 days

汇总按各 PR 区间端点相加估算；PR E 作为 P0/P1 过渡项只计入 P0/P1 主线一次。

---

## 推荐执行顺序

0. Phase 5.1：完成 Agent 资源限制闭环、app bridge 批量写入预算闭环、QA 提取质量修复、real-LLM 测试门禁修复和 issue sweep。
1. PR B：CLI resolver / active project root / connection test isolation。
2. PR C：Embedding + vector safety。
3. PR D：LLM provider / dedup / deep research stability。
4. PR A：MCP server + desktop bundling。
5. PR E：Ingest/schema/review-create-page safety。
6. PR H-lite：zoom/layout/app visibility。
7. PR G：聊天图片粘贴 + 多模态消息 + chat standalone。
8. PR F：MinerU PDF 解析。
9. PR I：主题、托盘、通用设置。
10. PR J：图形渲染优化。
11. PR K：AnyTXT、源文件导入、Lint 持久化和低风险杂项。

这个顺序先处理运行稳定性、数据安全、provider/deep research 错误可见性和 MCP 打包，再处理大 UI 功能。Agent Sidecar 相关路径贯穿 Chat、CLI、settings，相关 PR 都要保留本地行为并补 Agent 回归测试。

---

## Claude ACP 文档审查 Gate

Phase 6 计划更新 PR 和后续 Phase 6 实现 PR 都必须按风险使用独立审查。本计划更新 PR 额外要求：**每个被改动文档必须单独跑 Claude Code ACP 严格审查，不允许只做总览审查。**

### 适用范围

- 本 PR 预计只改 `docs/plans/upstream-sync-phase6.md`。
- 如果额外改 `docs/plans/agent-sidecar-phase6.1.md`、roadmap、handoff、README 或其他 `.md` 文档，每个文件都必须独立审查一次。
- Claude 审查是证据，不是最终裁决；Codex 仍负责核实、修正文档、最终判断和 PR comment。

### 调用方式

先取文档列表：

```bash
git diff --name-only -- '*.md' 'docs/**/*.md'
```

对列表中每个文档分别运行：

```bash
/Users/mac-mini/.codex/skills/dispatch-claude-acp/scripts/claude-acp-dispatch.mjs \
  --cwd /Users/mac-mini/claude-workspace/projects/llm_wiki \
  --mode plan \
  --permission reject \
  --prompt "..."
```

Prompt 必须包含：

- 被审文档路径。
- 该文档的完整 diff。
- 上游 commit/tag 事实：本地 `e574ae5`，上游 `95175ae / v0.4.25`，共同基线 `ff84ee9 / v0.4.14`。
- `v0.4.23..v0.4.25` 统计：38 commits，93 files，+4606/-558。
- 直接 merge 冲突统计：51 files。
- 本 PR 目标：只更新计划文档，不改产品代码。
- 非目标：不实现 Phase 6 功能、不关闭 issues、不提交 `.agent-loop/` 或 `.gitignore` 本地改动。

Claude 审查必须只读，禁止 edit/commit/push/PR comment。输出必须包含：

- 结论：`PASS | BLOCK | WARN`。
- 分组：`P0/P1/P2/P3/follow-up/non-actionable`。
- 每条 finding 的文件或表面、准确问题、影响、建议修复或路由。
- 明确声明未尝试编辑、提交、推送、合并或评论 PR。

如果 Claude 返回 `BLOCK` 或 P0/P1/P2：

1. Codex 核实 finding 是否成立。
2. 成立则修正文档。
3. 对同一个文档重新运行 Claude ACP review。
4. 未修复或未明确路由前，PR 不可 ready。

PR comment 必须记录每个文档的 Claude ACP session id、audit log path、结论和 findings 摘要。

---

## 验收标准

### 本计划更新 PR

- 只修改 `docs/plans/upstream-sync-phase6.md`。
- 静态检查通过：

```bash
rg -n "^# Phase 6: .*v0\\.4\\.14 -> v0\\.4\\.25" docs/plans/upstream-sync-phase6.md
! rg -n "^# Phase 6: .*v0\\.4\\.14 -> v0\\.4\\.2[3]|42[ ]*个冲突|v0\\.4\\.20\\.\\.v0\\.4\\.2[3]" docs/plans/upstream-sync-phase6.md
rg -n "v0\\.4\\.25|51 files|dispatch-claude-acp|claude-acp-dispatch|P0/P1/P2" docs/plans/upstream-sync-phase6.md
```

- 对 `v0.4.23` 的命中必须逐条人工确认：只能出现在历史说明、版本章节、`v0.4.23..v0.4.25` range 或 Claude ACP prompt 要求里，不能作为当前目标。
- 每个改动文档都有独立 Claude ACP review 证据。
- 不跑 `pnpm test` / `pnpm lint`，原因是 docs-only，不改源码、配置或锁文件。
- `git status --short` 确认只 stage 计划文档；不 stage `.gitignore` 的 `.agent-loop/` 本地改动。
- 提交前跑 `gitnexus detect_changes`。

### 每个后续实现 PR

- 相关单测通过。
- `pnpm lint` 通过。
- 涉及 Rust 命令时，至少跑对应 Rust build/test 或 Tauri compile check。
- `git diff --check` 无输出。
- 修改函数、类或方法前跑 GitNexus impact。
- 提交前跑 `gitnexus detect_changes` 风险符合预期。
- 必要时通过 Claude ACP reviewer gate，且 P0/P1/P2 已修复或明确路由。

Phase 6 完成标准：

- 上游 v0.4.25 的 P0/P1 功能完成手动 port。
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
- 不把 HOLO-Codex 初始化产生的 `.agent-loop/` 运行态或 `.gitignore` 本地改动混入 Phase 6 计划更新 PR。
