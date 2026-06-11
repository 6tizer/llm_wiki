# Phase 5.1: Agent 稳定性补丁，Phase 6 前置修复

> 类型：Phase 实施计划 | 创建：2026-06-12 | 状态：候选
> 上级：[Agent Sidecar 总规划](./agent-sidecar-roadmap.md)
> 前置：[Phase 5 计划](./agent-sidecar-phase5.md)（已完成）
> 后续：[Phase 6 上游同步](./upstream-sync-phase6.md)

## 背景

Phase 5 已经把 Agent Sidecar 主链路推进到可用状态，但 UI 验收暴露了两类必须在 Phase 6 前处理的问题：

1. Agent 资源限制没有形成完整闭环。`maxFilesChanged` 既有漏拦截路径，也缺少用户能看懂的前端提示。
2. 删除 Agent conversation 前的 QA 提取会写出质量不合格的 wiki 页面，比如整篇被包在 Markdown 代码围栏里，或 delete-only 会话仍弹 QA 提取确认。
3. 全量测试门禁有一处历史漂移：v0.4.3 已把本地 LLM Origin 策略改成固定 `http://localhost`，但 real-TCP 测试仍期待 same-origin，导致 `pnpm test` 失败。

Phase 6 会同步上游大量 Chat、Settings、Ingest、MCP 和 Rust 后端改动。上面这些问题如果不先修，会在同步期间继续污染测试项目，资源限制和测试失败也会变成后续大 PR 的噪音。

**结论**：Phase 5.1 只修安全边界和会写坏数据的问题。Agent 体验类大改放到 Phase 6.1。

---

## 纳入范围

| Issue | 标题 | 处理阶段 |
|-------|------|----------|
| [#89](https://github.com/6tizer/llm_wiki/issues/89) | Agent maxFilesChanged does not block multiple save_query_page writes | Phase 5.1 |
| [#85](https://github.com/6tizer/llm_wiki/issues/85) | Agent 资源限制超限需要明确的前端提示和恢复路径 | Phase 5.1 |
| [#64](https://github.com/6tizer/llm_wiki/issues/64) | Agent wiki writes hit maxFilesChanged=3 and require awkward manual continuation | Phase 5.1 |
| [#62](https://github.com/6tizer/llm_wiki/issues/62) | Agent can fail mid-task after reaching max turns limit | Phase 5.1 |
| [#90](https://github.com/6tizer/llm_wiki/issues/90) | QA extraction can save generated markdown wrapped in code fences | Phase 5.1 |
| [#87](https://github.com/6tizer/llm_wiki/issues/87) | Agent delete-only conversation still prompts QA extraction | Phase 5.1 |
| [#92](https://github.com/6tizer/llm_wiki/issues/92) | Real LLM Ollama Origin test still expects same-origin after localhost strategy | Phase 5.1 |

---

## 不纳入范围

| Issue | 原因 | 去向 |
|-------|------|------|
| #60, #66, #67, #68, #86 | 都涉及 Agent Chat UI、resume/compact/rewind/timeline，Phase 6 会改 Chat 和 transport，先做会冲突 | Phase 6.1 |
| #84 | Settings 和 Agent 权限入口会和 Phase 6 settings 同步冲突 | Phase 6.1 |
| #65 | Ingest 文案和上游 Ingest/Chat 同步有接触点，不阻塞 Phase 6 | Phase 6.1 |
| #88 | Embedding/source identity 与上游 v0.4.23 同步强相关 | Phase 6 PR C |
| #3 | MCP/Agent sidecar 边界与上游 MCP Server 同步强相关 | Phase 6 PR A；真正内部 RPC 设计放 Phase 6.1 或更后 |

---

## PR 切分

Phase 5.1 最少用 3 个 PR 完成。主线边界保持清楚：一个修资源限制，一个修 QA 提取，一个修全量测试门禁。

### PR 5.1-A：Agent 资源限制闭环

**目标**：让 `maxFilesChanged` / `maxWriteBytes` / `maxTurns` 变成用户能理解、系统能可靠执行的安全边界。

| Issue | 工作项 | 验收 |
|-------|--------|------|
| #89 | 找出 `save_query_page` 或对应 wiki 写入路径为什么没计入 `maxFilesChanged`，把所有 Agent wiki 写入统一纳入同一计数 | 设置 `maxFilesChanged=1` 后，Agent 尝试写两个不同 wiki 文件时，第二个写入被阻止 |
| #85 | 将资源限制错误映射成前端友好提示 | UI 显示触发的限制、当前 limit、已改路径摘要和下一步建议 |
| #64 | 给 `max_files_changed` 返回结构化 metadata，保留安全边界但减少用户困惑 | Agent 能提示“已达到本批文件上限”，而不是只展示内部错误字符串 |
| #62 | 审计 `maxTurns` 默认值和配置来源，补专门错误分类 | 达到 max turns 时显示清楚原因和可恢复路径 |

**建议实现点**：

- 统一 sidecar wiki tool 写入入口的 resource context，避免 `save_query_page` 绕过 `changedPaths`。
- 错误形态统一为结构化 kind，例如 `max_files_changed`、`max_write_bytes`、`max_turns_exceeded`。
- 前端 Agent message 或 tool timeline 显示 product-level 文案，不把原始 JSON 当主文案。
- Settings 中已有 Agent resource config 时，只补必要提示和链接，不扩展大 UI。

**预计工时**：2-3 days
**风险**：MEDIUM
**优先级**：P0

**测试**：

- sidecar wiki tool 单测覆盖同一 run 写多个不同路径。
- Agent transport/UI 单测覆盖结构化资源错误展示。
- maxTurns 错误分类单测。
- 跑 `npm --prefix src-tauri/sidecar test`、相关 Vitest、`pnpm lint`。

---

### PR 5.1-B：Agent QA 提取质量修复

**目标**：删除 conversation 前的 QA 提取只在有新知识时触发，写出的 QA 页面必须是正常 wiki Markdown。

| Issue | 工作项 | 验收 |
|-------|--------|------|
| #90 | 保存 QA 前剥离外层 ```markdown / ``` 代码围栏 | 新建 `wiki/qa/*.md` 以 frontmatter `---` 开头，不被包在代码块里 |
| #87 | delete-only / cleanup-only Agent conversation 跳过 QA 提取 | 删除清理类 conversation 时不弹“删除前提炼成 QA?”，或默认不推荐提取 |

**建议实现点**：

- 复用已有 Markdown 清洗逻辑，新增 `stripMarkdownCodeFence()` 或放到更通用的 sanitize helper。
- QA 写入前校验 frontmatter。不能识别为 `type: qa` 时阻止写入并显示错误。
- delete-only 判断保持保守：删除、清理、移除、无需删除、权限拒绝中断等场景不推荐 QA。
- 不引入新的 Agent timeline 或 session UX，这些留给 Phase 6.1。

**预计工时**：1-1.5 days
**风险**：LOW-MEDIUM
**优先级**：P0

**测试**：

- QA markdown sanitizer 单测。
- `readExistingQa()` 或 frontmatter 解析回归。
- delete-only conversation 判断单测。
- 关键 UI 路径可用 DEV fixture 或轻量组件测试覆盖。

---

### PR 5.1-C：Real LLM 测试门禁修复

**目标**：让全量 `pnpm test` 跟当前本地 LLM Origin 策略一致，避免 Phase 6 前测试噪音。

| Issue | 工作项 | 验收 |
|-------|--------|------|
| #92 | 更新 `llm-client.real-llm.test.ts` 的 fake Ollama CORS 预期 | real-TCP 测试接受 `Origin: http://localhost`，不再期待 `server.url` |
| #92 | 同步测试标题和注释 | 文案从 same-origin 改为 fixed localhost Origin，和 `llm-providers.ts` 保持一致 |
| #92 | 保留负例 | server 只接受 impossible origin 时仍返回 403，证明测试不是 trivially green |

**建议实现点**：

- 不改 `llm-providers.ts` 的产品策略。v0.4.3 已明确固定发送 `Origin: http://localhost` 是为了支持 Ollama LAN 部署。
- 只修 real-TCP 测试和注释。mock provider tests 已经是正确预期。
- 修复后跑 `pnpm test`，确认 mock 和 real-LLM suite 都通过或按环境显式 skip。

**预计工时**：0.3-0.5 day
**风险**：LOW
**优先级**：P0

---

## 推荐执行顺序

1. PR 5.1-A：Agent 资源限制闭环。
2. PR 5.1-C：Real LLM 测试门禁修复。
3. PR 5.1-B：Agent QA 提取质量修复。
4. 完成后进入 Phase 6 上游同步。

这个顺序先修安全边界，再清掉全量测试噪音，最后修写入质量。QA 提取修复比较小，但资源限制涉及 sidecar、transport、UI，先处理能减少后续 Agent 验收噪音。

---

## 验收标准

Phase 5.1 完成时应满足：

- #89、#85、#64、#62、#90、#87、#92 全部关闭或有明确剩余项。
- 低资源限制配置下，Agent 不再能绕过 `maxFilesChanged` 写多个不同 wiki 文件。
- 资源限制错误有清楚前端提示和恢复路径。
- QA 提取保存的 Markdown 能被 frontmatter 正常解析。
- delete-only / cleanup-only conversation 不再默认触发 QA 提取。
- `pnpm lint` 通过。
- `pnpm test` 通过，或 real-LLM 测试按环境条件显式 skip。
- 相关 sidecar 和 Vitest 测试通过。
- 提交前跑 `gitnexus detect_changes`，确认影响面符合预期。

---

## 边界

- 不做 Agent activity timeline。
- 不改 Agent compact/resume 策略。
- 不改 Agent 权限设置入口。
- 不实现内部 RPC。
- 不做上游同步。
- 不把测试 API key、LLM token 或项目私有内容写入仓库、日志、PR 描述或快照。
