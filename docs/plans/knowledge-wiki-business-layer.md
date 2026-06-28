# Knowledge Wiki Business Layer

> 类型：business-layer roadmap | 创建：2026-06-28 | 状态：active
> 依赖：[OKF Compatibility](./okf-compatibility.md)

## 结论

OKF 是 `<project>/wiki/` 的底层格式/互操作规范。Knowledge Wiki Skill 是 OKF 之上的业务工作流层，负责把现有 compiler、linter、fixer、synthesizer、autofill、QA 和 Agent 配置能力收敛成可配置、可自动化、可治理的知识系统。

本层不追求 Notion UI 兼容。Notion Skill 文档只作为业务能力规范来源；LLM Wiki 保持本地 project、Obsidian-compatible wikilink、Tauri/Rust/TypeScript、Agent sidecar、MCP/local API 的产品形态。

## Existing Capability Mapping

当前代码已经具备业务层主体骨架，后续 PR 不应重做这些能力，而应补齐配置、治理和 UI/API 暴露：

| Skill capability | Current LLM Wiki capability | Notes |
|------------------|-----------------------------|-------|
| Wiki Compiler | `ingest_source` / `full-ingest` | Ingest 后已有 source summary、concept/entity 页面、dedup、autofill 接线。 |
| Wiki Linter | `run_lint_and_report` | 已有结构/语义 lint 和 lint report。 |
| Wiki Fixer | `fix_lint_report` | 已有 auto-fix / human item / repair log 闭环。 |
| Wiki Synthesizer | `wiki_synthesis` | 当前是单 tag cluster；后续扩展 multi-dimensional discovery + preview/generate。 |
| Property Autofill / Tag Agent | `autofill_properties` | 当前是快速启发式；后续接 taxonomy-aware auto-growth。 |
| Wiki QA | QA hook / `wiki/qa` | 后续改为显式手动保存，不再默认 conversation 自动触发。 |

## Vocabulary Boundary

Knowledge Wiki Skill 中的 `summary` 在本系统中映射为 `type: source` 和 `wiki/sources/`。后续 OKF import/export 可以在对外语义中使用 summary/source mapping，但本地不迁移既有 source page 命名和路径。

页面 frontmatter 的 `tags` 继续保持 `string[]`。三层 tag taxonomy 是 `.llm-wiki/tag-taxonomy.json` 中的 sidecar governance layer，不改变现有页面 frontmatter shape，也不强制批量迁移旧页面。

## Roadmap

### KW-QA：explicit QA saving

- 停止 conversation dirty / startup / switch 自动 QA flush。
- 手动保存 QA 直连现有 extraction、sanitizer、frontmatter 校验和 dedup。
- 清理 pending QA dirty queue、retry 和 localStorage 自动恢复机制。
- 删除 conversation 前的 QA 弹窗是否保留作为产品决策处理；它当前已经是显式确认，不属于静默自动触发。
- Done When：切换会话、启动 app 和普通 chat dirty 状态都不会写出 QA；只有用户明确点击或请求保存 QA 才会写 `wiki/qa`；旧 pending QA localStorage key 被清理或迁移；QA sanitizer/frontmatter/dedup 测试继续通过。

### KW-B1：Knowledge Agents config base

- 新增 `.llm-wiki/knowledge-agents.json`，包含 `schemaVersion`、`updatedAt`、per-agent `enabled` 和基础配置。
- Settings 增加 Knowledge Agents 页面骨架。
- 读写复用 `agent-settings.ts` 的 normalize、clamp、atomic write 和 bad JSON fallback 模式。
- UI 与 Agent 同源写冲突用 `updatedAt` dirty-check；本 PR 先不让 Agent 修改配置。

### KW-B2：Prompt Registry

- 建立 prompt registry，把业务 Agent prompt 拆为 `locked`、`guidance`、`runtimeInjected`。
- 用户只能编辑 `guidance`，不能覆盖 frontmatter、`type`、SKIP/no-fence 等解析契约。
- Compiler、Linter、Fixer、Synthesizer、Tag Agent、QA Saver 逐步接入 registry。
- Registry loader 必须校验 `locked` 契约不可被项目配置覆盖，`guidance` 有长度上限和 fallback，UI/Agent tool 只能写 guidance override；QA 和 synthesis 的格式校验测试必须证明用户 guidance 不会破坏 required frontmatter / no-fence contract。

### KW-C1：Tag taxonomy schema + bootstrap/growth base

- 新增 `.llm-wiki/tag-taxonomy.json`，包含三层 tree、`slug`、`label`、`evidence`、`confidence`、`createdBy`、`updatedAt`、`changeLog`。
- Settings 增加标签体系页面。
- Agent 可自动 bootstrap 初始标签树，扫描已有 wiki、flat tags、标题、页面类型和链接关系，并为每个自动标签记录证据页面。
- 增加 auto-grow 配置：是否允许自动新增、每次最多新增数、证据页阈值、L1/L2/L3 各自阈值。
- 支持 change log / rollback；本 PR 不改默认 ingest 自动打标逻辑。
- Safety bounds 必须在 KW-C1 SPEC 中给出硬默认值和 clamp，例如 per-run 新增标签上限、总标签上限、L1/L2/L3 最大数量、每层最小 evidence pages、自动新增 L1 的显式 opt-in，以及 rollback 覆盖最近一次 bootstrap/growth 批次。

### KW-D：Multi-dimensional synthesis

- 把 `runWikiSynthesis` 拆成 discovery preview 和 confirmed generation。
- 支持 single / dual / triple / quad 主题发现。
- 使用 page-based k-combination，避免全局 tag 组合爆炸。
- discovery 有 `minClusterSize` 和 `maxCandidates` 硬上限。
- UI 默认启用 single + dual；triple/quad 由用户手动开启。

### KW-C2：Taxonomy-aware Tag Agent

- Tag Agent 使用 taxonomy 自动打标。
- 默认快速路径不调用 LLM，不阻塞 ingest；embedding 可选，关闭时降级到字符串/结构匹配。
- 高置信自动写入页面 `tags`。
- 中置信按配置新增 L3 或进入候选区；低置信只进入候选区。
- 自动新增标签必须记录 evidence、confidence、createdBy 和 changeLog。
- 合并、删除、重命名、移动上层标签默认只建议，不自动执行。

### OKF-C：Unified exposure

- 在 OKF-A/B 和 KW-B/C/D 稳定后，统一暴露 Agent tools、MCP/local API 和 UI 入口。
- Agent tools 可受控读取/更新 Knowledge Agents guidance 和功能开关。
- Agent 不可改 locked prompt、resource limits、taxonomy 正式树的删除/合并/重命名。
- OKF-C 只做入口、权限边界和 transport/API contract；不新增 validator、taxonomy、synthesis、QA 或 prompt registry 的业务语义。

## Execution Order

1. Docs closeout + business-layer calibration.
2. KW-QA.
3. OKF-A.
4. OKF-B.
5. KW-B1.
6. KW-B2.
7. KW-C1.
8. KW-D.
9. KW-C2.
10. OKF-C.

## Non-goals

- 不替换 OKF 底层兼容路线。
- 不把 OKF 当 Agent runtime、MCP 或 local API 协议。
- 不做 Notion UI 复刻。
- 不改变页面 `tags: string[]` 的 frontmatter shape。
- 不自动执行不可逆 taxonomy 重构；上层标签的合并、删除、重命名和移动默认需要用户确认。
