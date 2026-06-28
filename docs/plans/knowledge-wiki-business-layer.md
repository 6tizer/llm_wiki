# Knowledge Wiki Business Layer

> 类型：business-layer baseline | 创建：2026-06-28 | 状态：completed baseline
> 依赖：[OKF Compatibility](./okf-compatibility.md)

## 结论

OKF 是 `<project>/wiki/` 的底层格式/互操作规范。Knowledge Wiki Skill 是 OKF 之上的业务工作流层，负责把现有 compiler、linter、fixer、synthesizer、autofill、QA 和 Agent 配置能力收敛成可配置、可自动化、可治理的知识系统。该业务层基线已完成，本文保留为能力说明和后续增强边界。

本层不追求 Notion UI 兼容。Notion Skill 文档只作为业务能力规范来源；LLM Wiki 保持本地 project、Obsidian-compatible wikilink、Tauri/Rust/TypeScript、Agent sidecar、MCP/local API 的产品形态。

## Existing Capability Mapping

当前代码已经具备业务层主体骨架和已完成的配置、治理、UI/API 暴露基线；后续 PR 不应重做这些能力，而应围绕明确的新平台/runtime 方向做 scoped 增强：

| Skill capability | Current LLM Wiki capability | Notes |
|------------------|-----------------------------|-------|
| Wiki Compiler | `ingest_source` / `full-ingest` | Ingest 后已有 source summary、concept/entity 页面、dedup、autofill 接线。 |
| Wiki Linter | `run_lint_and_report` | 已有结构/语义 lint 和 lint report。 |
| Wiki Fixer | `fix_lint_report` | 已有 auto-fix / human item / repair log 闭环。 |
| Wiki Synthesizer | `wiki_synthesis` | 当前是单 tag cluster；后续扩展 multi-dimensional discovery + preview/generate。 |
| Property Autofill / Tag Agent | `autofill_properties` | 当前是快速启发式；后续接 taxonomy-aware auto-growth。 |
| Wiki QA | QA hook / `wiki/qa` | 已改为显式手动保存，不再默认 conversation 自动触发。 |

## Vocabulary Boundary

Knowledge Wiki Skill 中的 `summary` 在本系统中映射为 `type: source` 和 `wiki/sources/`。后续 OKF import/export 可以在对外语义中使用 summary/source mapping，但本地不迁移既有 source page 命名和路径。

页面 frontmatter 的 `tags` 继续保持 `string[]`。三层 tag taxonomy 是 `.llm-wiki/tag-taxonomy.json` 中的 sidecar governance layer，不改变现有页面 frontmatter shape，也不强制批量迁移旧页面。

## Completed Baseline

### KW-QA：explicit QA saving

状态：completed by `f9f63c5`.

- 已停止 conversation dirty / startup / switch 自动 QA flush。
- 手动保存 QA 直连现有 extraction、sanitizer、frontmatter 校验和 dedup。
- 已清理 pending QA dirty queue、retry 和 localStorage 自动恢复机制。
- 删除 conversation 前的 QA 弹窗保留为显式确认，不属于静默自动触发。
- Done：切换会话、启动 app 和普通 chat dirty 状态都不会写出 QA；只有用户明确点击或请求保存 QA 才会写 `wiki/qa`。

### KW-B1：Knowledge Agents config base

状态：completed by `95e4bb9`.

- 已新增 `.llm-wiki/knowledge-agents.json`，包含 `schemaVersion`、`updatedAt`、per-agent `enabled` 和基础配置。
- Settings 已增加 Knowledge Agents 页面骨架。
- 读写复用 normalize、clamp、atomic write 和 bad JSON fallback 模式。
- UI 与 Agent 同源写冲突使用 `updatedAt` dirty-check。

### KW-B2：Prompt Registry

状态：completed by `8ea2326`.

- 已建立 prompt registry，把业务 Agent prompt 拆为 `locked`、`guidance`、`runtimeInjected`。
- 用户只能编辑 `guidance`，不能覆盖 frontmatter、`type`、SKIP/no-fence 等解析契约。
- Compiler、Linter、Fixer、Synthesizer、Tag Agent、QA Saver 已接入 registry baseline。
- Registry loader 校验 `locked` 契约不可被项目配置覆盖，`guidance` 有长度上限和 fallback，UI/Agent tool 只能写 guidance override。

### KW-C1：Tag taxonomy schema + bootstrap/growth base

状态：completed by `127fc9e`.

- 已新增 `.llm-wiki/tag-taxonomy.json`，包含三层 tree、`slug`、`label`、`evidence`、`confidence`、`createdBy`、`updatedAt`、`changeLog`。
- Settings 已增加标签体系页面。
- Agent 可自动 bootstrap 初始标签树，扫描已有 wiki、flat tags、标题、页面类型和链接关系，并为每个自动标签记录证据页面。
- 已增加 auto-grow 配置：是否允许自动新增、每次最多新增数、证据页阈值、L1/L2/L3 各自阈值。
- 已支持 change log / rollback，并保留默认 ingest 自动打标边界。
- Safety bounds 已纳入基线，包括 per-run 新增标签上限、总标签上限、L1/L2/L3 最大数量、每层最小 evidence pages、自动新增 L1 的显式 opt-in，以及 rollback 批次边界。

### KW-D：Multi-dimensional synthesis

状态：completed by `3a01730`.

- 已把 `runWikiSynthesis` 拆成 discovery preview 和 confirmed generation。
- 已支持 single / dual / triple / quad 主题发现。
- 使用 page-based k-combination，避免全局 tag 组合爆炸。
- discovery 有 `minClusterSize` 和 `maxCandidates` 硬上限。
- UI 默认启用 single + dual；triple/quad 由用户手动开启。

### KW-C2：Taxonomy-aware Tag Agent

状态：completed by `ad0b9d5`.

- Tag Agent 已使用 taxonomy 自动打标。
- 默认快速路径不调用 LLM，不阻塞 ingest；embedding 可选，关闭时降级到字符串/结构匹配。
- 高置信自动写入页面 `tags`。
- 中置信按配置新增 L3 或进入候选区；低置信只进入候选区。
- 自动新增标签记录 evidence、confidence、createdBy 和 changeLog。
- 合并、删除、重命名、移动上层标签默认只建议，不自动执行。

### OKF-C：Unified exposure

状态：completed by `248bd27`.

- 已统一暴露 Agent tools、MCP/local API 和 UI 入口。
- Agent tools 可受控读取/更新 Knowledge Agents guidance 和功能开关。
- Agent 不可改 locked prompt、resource limits、taxonomy 正式树的删除/合并/重命名。
- OKF-C 只做入口、权限边界和 transport/API contract；不新增 validator、taxonomy、synthesis、QA 或 prompt registry 的业务语义。

## Current Position

截至 2026-06-29，KW-QA / KW-B1 / KW-B2 / KW-C1 / KW-D / KW-C2 与 OKF-C 均已完成，并合入当前 main/head `248bd27 feat: expose OKF and knowledge workflow tools`。本文不再表示当前串流队列。

后续增强等待并行 runtime 方向明确：并行加速 / Work Runtime / DB 选型 / provider profiles / work scheduler。任何新增能力应先形成 scoped tracking / plan，再判断是否落在 Knowledge Wiki business-layer、OKF compatibility、Claude Agent SDK alignment 或 Phase 7 backlog。

## Non-goals

- 不替换 OKF 底层兼容路线。
- 不把 OKF 当 Agent runtime、MCP 或 local API 协议。
- 不做 Notion UI 复刻。
- 不改变页面 `tags: string[]` 的 frontmatter shape。
- 不自动执行不可逆 taxonomy 重构；上层标签的合并、删除、重命名和移动默认需要用户确认。
