# LLM Wiki

<p align="center">
  <img src="logo.jpg" width="128" height="128" style="border-radius: 22%;" alt="LLM Wiki Logo">
</p>

<p align="center">
  <strong>一个会自我构建和维护的个人知识库。</strong><br>
  把文档喂给它，LLM 阅读、编译成结构化互联的 Wiki，并持续保持更新。
</p>

<p align="center">
  <a href="#这是什么">这是什么？</a> •
  <a href="#核心亮点">核心亮点</a> •
  <a href="#工作原理">工作原理</a> •
  <a href="#功能特性">功能特性</a> •
  <a href="#安装">安装</a> •
  <a href="#agent--api">Agent &amp; API</a> •
  <a href="#致谢">致谢</a>
</p>

<p align="center">
  <a href="README.md">English</a> | 中文
</p>

---

<p align="center">
  <img src="assets/overview.jpg" width="100%" alt="概览">
</p>

## 这是什么？

LLM Wiki 是一个跨平台桌面应用，把一堆文档自动变成有组织、互相链接的知识库。

大多数"LLM + 文档"的玩法都是 RAG：上传文件，模型在查询时检索相关片段，每次都从零生成答案——知识不会沉淀。LLM Wiki 走相反的路线：LLM **增量构建并维护一个持久化的 Wiki**——一个互相交叉引用的 markdown 页面目录，矛盾被标记出来，综合判断不断演进。知识**编译一次**就保持更新，而不是每次提问都重新推导。

Wiki 就是磁盘上的 markdown：一个 git 仓库、一个 Obsidian 库，完全归你所有。你负责筛选源文件、提出问题；LLM 负责阅读、总结、交叉引用和繁琐的维护工作。

它最初是 [Andrej Karpathy 的 LLM Wiki 模式](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f)的一个实现，如今已成长为一个完整应用，带有知识图谱、向量搜索、网络研究、Chrome 剪藏插件，以及一个能自主研究和更新 Wiki 的内置 Agent。

<p align="center">
  <img src="assets/llm_wiki_arch.jpg" width="100%" alt="LLM Wiki 架构">
</p>

## 核心亮点

- **内置 Agent** —— 基于 Claude Agent SDK 的 Agent 运行在应用内，配有专属 Wiki 工具、多轮对话、工具调用时间线、权限审批、session resume/fork。它能搜索、读取、写入 Wiki 页面，执行研究，并驱动多 Agent 流水线（compiler → linter → fixer → synthesizer → qa）。
- **两步 ingest** —— LLM 先分析源文档，再生成页面，带源文件溯源和 SHA-256 增量缓存。
- **知识图谱** —— 4 信号相关性引擎 + Louvain 社区检测，呈现知识簇、惊喜连接和知识缺口。
- **混合搜索** —— 分词关键词搜索（英文 + 中文 CJK）配合可选的 LanceDB 向量语义搜索。
- **深度研究** —— 发现知识缺口，执行多查询网络搜索（Tavily / SerpApi / SearXNG），并自动 ingest 结果。
- **本地优先** —— 一切都是磁盘上的 markdown；可直接作为 Obsidian 库打开；除了你自己配置的 LLM/搜索 API 调用外，数据不离开本机。

## 工作原理

三层结构、三个操作——LLM 拥有 Wiki，你拥有源文件和问题。

```
原始源文件  →  Wiki  →  Schema + Purpose
（不可变）    （LLM 拥有）   （你的规则与意图）
```

- **Ingest（摄入）** —— 放入一份文档，LLM 阅读它，写出源摘要，更新实体/概念页面，刷新 index 和 overview，并记录操作。单个源文件可能触及 10–15 个页面。
- **Query（查询）** —— 提问；应用检索相关页面（关键词 + 向量 + 图谱扩展），组装受预算控制的上下文，LLM 带引用作答。好的答案可以回存进 Wiki。
- **Lint（体检）** —— 定期检查 Wiki 的矛盾、过时论断、孤立页面、缺失的交叉引用——并由 Agent 驱动自动修复。

磁盘上的 Wiki 项目结构：

```
my-wiki/
├── purpose.md            # 目标、关键问题、演进中的论点
├── schema.md             # 页面类型与结构规则
├── raw/
│   ├── sources/          # 你的文档（不可变）
│   └── assets/           # 本地图片
├── wiki/
│   ├── index.md          # 内容目录（LLM 导航入口）
│   ├── log.md            # 时间线操作记录
│   ├── overview.md       # 全局摘要（自动更新）
│   ├── entities/         # 人物、组织、产品
│   ├── concepts/         # 理论、方法、概念
│   ├── sources/          # 源摘要
│   ├── queries/          # 保存的答案 + 研究
│   ├── synthesis/        # 跨源分析
│   └── comparisons/      # 并排对比
├── .obsidian/            # Obsidian 库配置（自动生成）
└── .llm-wiki/            # 应用配置、聊天历史、Review 条目
```

## 功能特性

### 摄入与源文件
- **两步链式思维 ingest** —— 先分析再生成，页面质量更高
- **SHA-256 增量缓存** —— 未变化的源文件自动跳过，节省 token
- **持久化 ingest 队列** —— 串行处理，支持崩溃恢复、取消、自动重试
- **文件夹导入** —— 递归导入并保留目录结构；文件夹路径作为分类提示
- **源文件夹自动监听** —— `raw/sources/` 的外部变更保持同步（ingest + 级联删除）
- **多格式支持** —— PDF、DOCX、PPTX、XLSX/ODS、图片、音视频、网页剪藏
- **多模态图片** —— 从 PDF 提取内嵌图片，用视觉 LLM 生成描述，并在搜索中呈现
- **级联删除** —— 删除源文件会清理其页面、index 条目和失效 wikilink，同时保留被多源共享的实体

### 知识图谱
- **4 信号相关性模型** —— 直接链接（×3）、源重叠（×4）、Adamic-Adar（×1.5）、类型亲和（×1）
- **Louvain 社区检测** —— 自动发现知识簇并评估内聚度
- **图谱洞察** —— 惊喜的跨社区连接、孤立页面、稀疏社区、桥接节点
- **交互式可视化** —— sigma.js + ForceAtlas2，按类型/社区着色，悬停高亮，从知识缺口一键深度研究

### 搜索与查询
- **混合检索** —— 分词搜索（英文单词 + 中文 CJK bigram）配合可选向量搜索（LanceDB）
- **图谱扩展上下文** —— 用 top 命中作为种子做 2 跳相关性遍历
- **可配置上下文窗口** —— 4K → 1M tokens，按比例分配预算
- **多会话对话** —— 持久化 session、引用来源面板、重新生成、保存到 Wiki
- **思考过程显示** —— 为 DeepSeek / QwQ 类模型折叠展示 `<think>` 推理块
- **KaTeX 数学渲染** —— 各视图均支持行内与块级 LaTeX

### 研究与审核
- **深度研究** —— LLM 优化的研究主题，多查询网络搜索（Tavily / SerpApi / SearXNG），自动 ingest 结果
- **异步审核队列** —— LLM 标记需人工判断的条目，附受限的预定义动作和预生成搜索查询
- **Chrome 剪藏插件** —— 一键抓取网页（Readability + Turndown）并自动 ingest

### Agent
- **内置 Agent（Claude Agent SDK）** —— 专属 Wiki MCP 工具（`read_page`、`search_pages`、`update_page`、`create_entity` / `create_concept`、`get_graph`），基于 hooks 的权限控制，session resume / fork / continue，成本上限
- **工具调用时间线与权限审批** —— 实时看到 Agent 在做什么，并就地审批敏感操作
- **多 Agent 流水线** —— 5 个内置角色（compiler / linter / fixer / synthesizer / qa）按串行或并行编排
- **属性自动填充** —— ingest 时自动为概念/实体填充状态和标签
- **Lint 闭环** —— Agent 驱动的检测与自动修复，带并发控制

### 平台
- **跨平台** —— 基于 Tauri v2 的原生桌面应用，支持 macOS（ARM + Intel）、Windows、Linux
- **多 LLM 提供商** —— OpenAI、Anthropic、Google、Ollama、Azure，或任意 OpenAI 兼容端点
- **本地 HTTP API** —— token 保护的 `127.0.0.1` JSON API，供外部工具和 Agent 使用
- **国际化** —— 中英文界面
- **Obsidian 原生** —— Wiki 目录即开即用的 Obsidian 库

## 技术栈

| 层 | 技术 |
|-------|-----------|
| 桌面 | Tauri v2（Rust 后端） |
| 前端 | React 19 + TypeScript + Vite |
| UI | shadcn/ui + Tailwind CSS v4 |
| 编辑器 | Milkdown（基于 ProseMirror 的所见即所得） |
| 图谱 | sigma.js + graphology + ForceAtlas2 |
| 搜索 | 分词 + 图谱相关性 + 可选向量（LanceDB） |
| 文档解析 | pdf-extract、docx-rs、calamine |
| 状态 / 国际化 | Zustand · react-i18next |
| LLM | 流式 fetch —— OpenAI、Anthropic、Google、Ollama、Azure、Custom |
| 网络搜索 | Tavily、SerpApi、SearXNG |
| Agent | 通过 Node.js sidecar 调用 Claude Agent SDK |

## 安装

### 预编译二进制

从 [Releases](https://github.com/6tizer/llm_wiki/releases) 下载：
- **macOS** —— `.dmg`（Apple Silicon + Intel）
- **Windows** —— `.msi`
- **Linux** —— `.deb` / `.AppImage`

### 从源码构建

```bash
# 前置条件：Node.js 20+、Rust 1.70+
git clone https://github.com/6tizer/llm_wiki.git
cd llm_wiki
npm install
npm run tauri dev      # 开发模式
npm run tauri build    # 生产构建
```

### Chrome 扩展

1. 打开 `chrome://extensions`
2. 启用 **开发者模式**
3. 点击 **加载已解压的扩展程序**，选择 `extension/` 目录

## 快速开始

1. 启动应用并创建项目（选一个场景模板——研究、阅读、个人成长、商业、通用）
2. **设置** → 配置你的 LLM 提供商（API key + 模型）
3. *（可选）* 配置网络搜索提供商、向量嵌入、源文件夹自动监听
4. **源文件** → 导入文档（PDF、DOCX、MD……）
5. 观察 **活动面板**，LLM 自动构建 Wiki 页面
6. 用 **对话** 查询知识库（或切换到 **Agent** 模式）
7. 浏览 **知识图谱**，处理 **审核** 条目，运行 **Lint** 保持健康

## Agent & API

### 内置 Agent Sidecar

LLM Wiki 内置一个基于 **Claude Agent SDK** 的 Agent，以 Node.js sidecar 进程运行，通过 stdin/stdout JSON-lines 与 Rust 后端通信。

- **Wiki MCP 工具** —— `read_page`、`search_pages`、`update_page`、`create_entity` / `create_concept`、`get_graph`
- **Hooks 与权限** —— Wiki 工具在安全边界内自动允许（写入限制在 `wiki/**/*.md`）；内置工具走 SDK 权限审批
- **Session 管理** —— resume / fork / continue，带成本控制（`maxTurns`、`maxBudgetUsd`）
- **多 Agent 流水线** —— 编排 compiler / linter / fixer / synthesizer / qa 各角色

通过 `baseUrl` 透传，任意兼容 Messages API 的后端都能用——Anthropic、OpenRouter、LiteLLM、Bedrock 等。

### 本地 HTTP API

`http://127.0.0.1:19828` 上有一个 token 保护的 JSON API（仅 localhost），让外部工具——Claude Code、Codex 或任意 HTTP 客户端——查询你的 Wiki：

- `GET  /api/v1/health` —— 服务状态（无需鉴权）
- `GET  /api/v1/projects` —— 列出项目
- `GET  /api/v1/projects/{id}/files` · `files/content` —— 读取文件
- `POST /api/v1/projects/{id}/search` —— 混合检索（关键词 + 向量），含每条结果的分数
- `GET  /api/v1/projects/{id}/graph` —— wikilinks 图谱
- `POST /api/v1/projects/{id}/sources/rescan` —— 触发后端重新扫描

在 **设置 → API Server** 中启用并生成 token。也提供现成的 agent skill：

```bash
npx skills add https://github.com/nashsu/llm_wiki_skill.git --skill llm_wiki_skill
```

## 代码结构

```
src-tauri/                  # Rust 后端（Tauri v2）
├── src/
│   ├── commands/
│   │   ├── file_ops/       # 文件同步、图片提取、文件系统
│   │   ├── search/         # 关键词 / 向量 / 混合搜索、向量库
│   │   └── agent_cli/      # Agent sidecar 桥接、Claude CLI、Codex CLI
│   ├── api_server.rs       # 本地 HTTP API 服务
│   └── lib.rs              # 入口
└── sidecar/                # Agent Sidecar（Node.js）
    └── src/
        ├── main.ts         # Sidecar 入口 / stdin-stdout 循环
        ├── core.ts         # SDK query() 处理器
        ├── wiki-tools.ts   # 自定义 MCP 工具定义
        ├── agent-hooks.ts  # PreToolUse / PostToolUse / Stop hooks
        └── permission-bridge.ts

src/                        # 前端（React + TypeScript）
├── components/             # UI（布局、对话、图谱、搜索、设置）
├── lib/                    # 核心逻辑
│   ├── agent/              # Agent transport、流水线、autofill、QA hooks
│   └── ingest*.ts          # 两步 ingest 管道
├── stores/                 # Zustand 状态
└── i18n/                   # 国际化
```

## 路线图

Agent 是当前活跃的开发方向。Phase 1–4（sidecar、自定义 MCP 工具、hooks/权限、工具能力对齐、UI 集成）已完成；Phase 5 聚焦 session 行为修复、资源限制配置化、sidecar 单文件打包。详见 [`docs/plans/`](docs/plans/) 中各阶段计划。

## 致谢

基础方法论来自 **Andrej Karpathy** 的 [llm-wiki.md](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f)——用 LLM 增量构建并维护个人 Wiki 的模式。本项目是其具体实现，最初 fork 自 [nashsu/llm_wiki](https://github.com/nashsu/llm_wiki)，并扩展了 Agent 系统、知识图谱、向量搜索等能力。

## 许可证

基于 **GNU General Public License v3.0** 授权——详见 [LICENSE](LICENSE)。

## Star History

<a href="https://www.star-history.com/?repos=6tizer/llm_wiki&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=6tizer/llm_wiki&type=date&theme=dark&legend=top-left" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=6tizer/llm_wiki&type=date&legend=top-left" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=6tizer/llm_wiki&type=date&legend=top-left" />
 </picture>
</a>
