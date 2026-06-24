# OKF Compatibility

> 类型：compatibility roadmap | 创建：2026-06-25 | 状态：active
> 来源：GoogleCloudPlatform/knowledge-catalog OKF v0.1 Draft `d44368c`

## 结论

Google OKF 是知识包格式，不是 MCP 协议，也不是 Agent runtime 协议。LLM Wiki 的 `<project>/wiki/` 可以明确定位为 **OKF-compatible knowledge bundle root**：继续保留本地 Wiki 工作流，同时让后续 validator、export、import、Agent tools 和本地 API 可以按 OKF 语义对外交换。

OKF 兼容不改变近期 Tauri/Rust/TypeScript 主线，也不替代 Claude Agent SDK sidecar、MCP tools 或 local HTTP API。

## Verification Anchor

截至 2026-06-25，本计划用以下命令核验 OKF 来源仓库：

```bash
git ls-remote https://github.com/GoogleCloudPlatform/knowledge-catalog.git HEAD
```

核验结果显示 `GoogleCloudPlatform/knowledge-catalog` `HEAD` 指向 `d44368c15e38e7c92481c5992e4f9b5b421a801d`。OKF-A 开工时必须重新运行该命令；如果 OKF draft 已变化，以新核验结果更新本计划、PR body 和 reviewer packet。

## Bundle Shape

本节描述的是当前 LLM Wiki 约定和目标兼容 shape，不是已经冻结的 OKF 实现规范。`<project>/wiki/` 作为 bundle root 时，保留现有目录和保留文件：

- `index.md`
- `log.md`
- `overview.md`
- `entities/`
- `concepts/`
- `sources/`
- `queries/`
- `synthesis/`
- `comparisons/`

非 reserved `.md` 页面应有 frontmatter，并声明 `type`。现有 LLM Wiki page type 可以映射到 OKF 类型，不能映射的先保留本地扩展字段。

OKF-A 开工时必须重新核对实际 wiki schema、project templates 和 sidecar `wiki-tools` 写入路径。如果本文档和代码或模板不一致，以代码和模板为准，并先更新本文档再实现 validator/export。

## Link Compatibility

内部继续支持 wikilink，因为它是 Obsidian vault 和现有图谱的基础。

OKF import/export 需要提供标准 Markdown link 兼容：

- export 时把 `[[Page]]`、`[[Page|Label]]` 转为可交换的 Markdown link 或附带映射表。
- import 时接受标准 Markdown link，并在能确定目标页面时恢复 wikilink。
- 图谱和 search index 继续以本地 canonical page id 为单一真实来源。

## Roadmap

### OKF-A：validator / export

- 为 `<project>/wiki/` 增加 OKF validator。
- 检查非 reserved `.md` frontmatter、`type`、必要字段和链接有效性。
- 导出 OKF-compatible bundle，保留本地扩展字段。
- 导出报告列出无法标准化的本地扩展。

### OKF-B：import / mapping

- 导入 OKF-compatible bundle 到现有 project。
- 映射 OKF type 到 LLM Wiki page type。
- 处理 slug、title、wikilink、Markdown link 和 asset path。
- 冲突处理走 review queue，不静默覆盖用户页面。

### OKF-C：UI + Agent tools + MCP/local API exposure

- UI 增加 validator/export/import 入口。
- Agent tools 支持验证、导出、导入草案和 mapping 预览。
- MCP/local API 暴露 OKF validator/export/import 能力。
- 权限边界沿用现有 Agent 写入策略和 local API token。

## Non-goals

- 不把 OKF 当成运行时协议。
- 不替换 MCP tools。
- 不替换 local HTTP API。
- 不要求一次性重写现有 wiki 页面。
- 不破坏 Obsidian 兼容和 wikilink 工作流。
