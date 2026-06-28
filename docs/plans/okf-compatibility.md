# OKF Compatibility

> 类型：compatibility baseline | 创建：2026-06-25 | 状态：completed baseline
> 来源：GoogleCloudPlatform/knowledge-catalog OKF v0.1 Draft `d44368c`

## 结论

Google OKF 是知识包格式，不是 MCP 协议，也不是 Agent runtime 协议。LLM Wiki 的 `<project>/wiki/` 已明确定位为 **OKF-compatible knowledge bundle root**：继续保留本地 Wiki 工作流，同时让 validator、export、import、Agent tools 和本地 API 可以按 OKF 语义对外交换。

OKF 兼容不改变近期 Tauri/Rust/TypeScript 主线，也不替代 Claude Agent SDK sidecar、MCP tools 或 local HTTP API。Knowledge Wiki Skill 业务能力属于 OKF 之上的 workflow layer，详见 [Knowledge Wiki Business Layer](./knowledge-wiki-business-layer.md)。

## Verification Anchor

截至 2026-06-25，本计划用以下命令核验 OKF 来源仓库：

```bash
git ls-remote https://github.com/GoogleCloudPlatform/knowledge-catalog.git HEAD
```

核验结果显示 `GoogleCloudPlatform/knowledge-catalog` `HEAD` 指向 `d44368c15e38e7c92481c5992e4f9b5b421a801d`。OKF-A 已完成；后续若继续触碰 OKF 兼容、schema 或 import/export 行为，开工时仍需重新运行该命令，并在新的 plan、PR body 和 reviewer packet 记录当时看到的 OKF draft/tag/commit。

## Bundle Shape

本节描述的是当前 LLM Wiki 约定和兼容 shape，不是已经冻结的 OKF upstream 规范。`<project>/wiki/` 作为 bundle root 时，保留现有目录和保留文件：

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

后续触碰 OKF 行为时必须重新核对实际 wiki schema、project templates 和 sidecar `wiki-tools` 写入路径。如果本文档和代码或模板不一致，以代码和模板为准，并先更新本文档再实现新的行为变更。

## Link Compatibility

内部继续支持 wikilink，因为它是 Obsidian vault 和现有图谱的基础。

OKF import/export 需要提供标准 Markdown link 兼容：

- export 时把 `[[Page]]`、`[[Page|Label]]` 转为可交换的 Markdown link 或附带映射表。
- import 时接受标准 Markdown link，并在能确定目标页面时恢复 wikilink。
- 图谱和 search index 继续以本地 canonical page id 为单一真实来源。

## Completed Baseline

### OKF-A：validator / export

状态：completed by `e300cdd`.

- 已为 `<project>/wiki/` 增加 OKF validator。
- 已检查非 reserved `.md` frontmatter、`type`、必要字段和链接有效性。
- 已支持导出 OKF-compatible bundle，并保留本地扩展字段。
- 导出报告列出无法标准化的本地扩展。

### OKF-B：import / mapping

状态：completed by `67f54f6`.

- 已支持导入 OKF-compatible bundle 到现有 project。
- 已映射 OKF type 到 LLM Wiki page type。
- 已处理 slug、title、wikilink、Markdown link 和 asset path。
- 冲突处理走 review queue，不静默覆盖用户页面。

### OKF-C：UI + Agent tools + MCP/local API exposure

状态：completed by `248bd27`.

- UI 已增加 validator/export/import 入口。
- Agent tools 已支持验证、导出、导入草案和 mapping 预览。
- MCP/local API 已暴露 OKF validator/export/import 能力。
- 权限边界沿用现有 Agent 写入策略和 local API token。
- OKF 继续作为格式兼容层；Knowledge Wiki business-layer 继续承载业务工作流语义。

## Current Execution Position

截至 2026-06-29，OKF-A/B/C 均已完成，并合入当前 main/head `248bd27 feat: expose OKF and knowledge workflow tools`。OKF 不再作为当前待办队列，也不直接推动进入 Phase 7 / Claude Agent SDK alignment。

Next planning candidate：继续围绕并行加速 / Work Runtime / DB 选型 / provider profiles / work scheduler 讨论和规划。新的 OKF 增强需要先开 scoped tracking / plan，并继续保持 OKF 作为格式兼容层。

## Non-goals

- 不把 OKF 当成运行时协议。
- 不替换 MCP tools。
- 不替换 local HTTP API。
- 不要求一次性重写现有 wiki 页面。
- 不破坏 Obsidian 兼容和 wikilink 工作流。
