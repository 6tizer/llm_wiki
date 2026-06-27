# Upstream Chat Agent Router Alignment

> 类型：alignment roadmap | 创建：2026-06-25 | 更新：2026-06-27 | 状态：completed / follow-up
> 上级：[Phase 6 upstream sync](./upstream-sync-phase6.md)
> Delta 入口：[Upstream v0.5.x Delta](./upstream-0.5-delta.md)
> 上游基线：`nashsu/llm_wiki` `v0.5.1@cc4b98f`

## 结论

上游 `v0.5.1@cc4b98f` 的 Agent 是普通 Chat 内的 **Chat Agent Router**。它是 TypeScript planner，负责 query understanding、只读工具路由、agent steps/tool progress 和最终 `streamChat` provider 调用。

它不替代本 fork 的 **Claude Agent SDK sidecar**。Sidecar 仍负责可写 Wiki 工具、permission/session/pipeline、resource limit、rewind/resume/continue/fork 和安全边界。

Phase 6 的 PR G 已完成核心 **Chat Agent Router alignment + multimodal chat**：普通 Chat 尽量贴近 upstream `v0.5.x`，同时保留本 fork 的 Agent SDK sidecar 高级能力。剩余 UI polish 已拆到 #135/#136，sidecar lifecycle 和 permission/session/pipeline 继续进入 Phase 7。

## Verification Anchor

截至 2026-06-25，本计划用以下命令核验上游基线：

```bash
git ls-remote --tags https://github.com/nashsu/llm_wiki.git 'refs/tags/v0.5*'
git ls-remote https://github.com/nashsu/llm_wiki.git HEAD
```

核验结果显示 upstream `v0.5.1` tag 和 `HEAD` 都指向 `cc4b98fc33be11216973ec128e9281d8c2f06b79`。未来 Chat Router follow-up 或相关实现 PR 开工时必须重新运行这两个命令，记录当时最新 tag/commit；如果 upstream 已变化，以新核验结果更新 PR plan、PR body 和 reviewer packet。

## Scope

PR G 已评估并按风险分批 port。以下条目保留为 regression checklist：

- query understanding：普通 Chat 里的查询理解、上下文规划和工具选择。
- mode routing：`fast / standard / deep / local_first` 的行为、默认值、UI 文案和 provider 调用路径。
- project files / read file：`project_files`、`project_file_read` 等只读项目文件工具。
- agent steps persistence：消息内保存 agent steps，刷新和重开会话后可恢复。
- tool progress UI：普通 Chat 内的工具进度、错误、取消和空结果展示。
- reasoning fallback：模型不支持 reasoning 或 reasoning block 异常时的降级路径。
- Chat multimodal：图片粘贴、文件选择、thumbnail、删除、大小校验、消息渲染和 ContentBlock[] 转换。

## Fork Boundary

保留本 fork 差异：

- Mac-only active maintenance。
- Claude Agent SDK sidecar。
- 可写 Wiki MCP tools 和 app-level tools。
- permission approval、session lifecycle、resource limits。
- Agent timeline、rewind/resume/continue/fork、compact state。
- multi-agent pipeline。
- 安全边界：写入限制、路径限制、权限桥、token 不落日志。

Chat Agent Router 进入普通 Chat 后，不能删除或弱化 sidecar 的权限、session、pipeline 和写入治理设计。

## Implementation Notes

- 未来相关实现 PR 先做 upstream `v0.5.x` delta assessment。
- 普通 Chat alignment 走 upstream-first：能直接贴近 upstream 行为的，优先保持一致。
- 涉及 sidecar UI 或 Agent session 的部分走 fork boundary：只做兼容和视觉协调，不把两个 Agent 运行时合并。
- Multimodal chat 与 Chat Agent Router 同 PR 评估，因为两者都触碰 chat message schema、stream UI 和 provider adapter。

## Done When

- PR G plan 和 PR body 已记录开工时最新 upstream tag/commit；未来相关 PR 继续记录当时最新 upstream tag/commit。
- 普通 Chat 对齐 upstream Chat Agent Router 的核心行为，或明确列出 deferred 项。
- Agent SDK sidecar 回归通过，permission/session/pipeline 行为不回退。
- Chat multimodal message 在普通 Chat 可用，不污染 Agent SDK sidecar stream。
- #135/#136 承接剩余 Chat UI polish；Phase 7 承接 sidecar lifecycle/permission/session/pipeline。
