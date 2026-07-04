# SPEC-7 PR1 执行计划：Claude Agent SDK 对齐（0.3.150 → 0.3.201）

> 类型：PR 级执行计划 | 状态：investigation complete / ready for implementation | 轨道：agent | 分支：codex/spec7-pr1-sdk-alignment | 创建：2026-07-04（只读调查完成后落此计划）

## 调查结论（2026-07-04，证据：npm pack diff 0.3.150 vs 0.3.201 sdk.d.ts + 官方 CHANGELOG 全文）

- 当前锁定 0.3.150（package.json `^0.3.148`），最新 0.3.201，区间 42 个 release。peerDependencies 完全不变，无 peer 升级。
- **升级目标：0.3.201**（无更优的中间锚点；唯一实质风险项 0.3.198 与版本锚点无关，是我方用法问题）。开工时重跑 `npm view` 确认最新版。
- **rewind 结论（PR2 blocking question）**：官方**没有**公开的会话级 rewind/checkpoint API。`Query.rewindFiles(userMessageId, {dryRun})` 在 0.3.150/0.3.201 完全一致（我方 rewind-bridge.ts 已正确使用）；0.3.186 的 `rewind_conversation` 只是内部 control-request wire 类型，**未暴露为 Query 公开方法**。PR2 必须继续在 host 侧基于 `rewindFiles` + `resume`/`forkSession`/`resumeSessionAt` 自建会话 rewind。
- **transport-closed 错误无 typed class**（导出错误类型仅 `AbortError`；0.3.201 runtime 仍含字面量 "not ready for writing"）→ rewind-bridge.ts 的 regex matcher **必须保留**，无需改动。

## 风险分级的适配项

1. **P0 级验证（0.3.198）**：`core.ts` 同时传 `allowedTools`（含 `WRITE_WIKI_TOOLS`，只看 enableWriteTools 不看 permissionPolicy）和 `canUseTool`；0.3.198 新增的运行时警告表明 `allowedTools` 会**遮蔽** callback。升级后必须实证：default("ask") 策略下 wiki 写工具审批是否仍走 permission-bridge 弹窗。若遮蔽为真：`agent-policy.ts getAllowedWikiTools()` 停止把 WRITE_WIKI_TOOLS 放进 allowedTools，写工具门禁完全交给 canUseTool + PreToolUse hook。
2. **行为面回归（0.3.186）**：background/subagent 工具调用从「自动拒绝」改为「路由到 canUseTool」——permission-bridge 的调用面变宽，需回归 subagent 权限弹窗。
3. **确认无影响（0.3.162）**：native build 默认不再注册 Grep/Glob 专用工具；我方不在 canUseTool/hooks 拦截 Grep/Glob，预期无影响，需显式确认。
4. 受益修复（无需适配）：0.3.160 hook abort、0.3.176 resume 状态恢复、0.3.196 长会话 dedup。可选采纳：0.3.179 tool_use_meta（时间线 UI）、0.3.195 `Query.reinitialize()`（transport gap 恢复，PR2 评估）、0.3.199 canUseTool requestId。

## 改动文件清单

- `src-tauri/sidecar/package.json` + lockfile（bump 0.3.201）
- `src-tauri/sidecar/src/agent-policy.ts` + `core.ts`（0.3.198 遮蔽修复，视实证结果）
- `src-tauri/sidecar/src/permission-bridge.ts`（0.3.186 回归覆盖）
- `src-tauri/sidecar/src/rewind-bridge.ts`（仅确认注释，无功能改动）
- `docs/plans/claude-agent-sdk-alignment.md`（刷新 stale 的 "npm latest: 0.3.190" 记录）
- sidecar 单测：新增写工具 ask-flow 遮蔽场景覆盖（agent-policy.node.ts / permission-bridge.node.ts / core.node.ts）

## Gate

full lane（权限/安全面）。主力 gate：内审 opus + **实证验证**（真实跑 sidecar 验证写工具审批回路，0.3.198 项不许只靠单测推断）；副：外部 reviewer。属对抗域（权限绕过），实现前用本文档第「风险分级」节作为场景清单，Coder 按全清单实现测试。

## Closeout follow-ups

内审 + probe 已 PASS（getAllowedWikiTools 遮蔽修复实证有效），以下两项留给后续 PR / 下次升级处理，不在本 PR 范围内：

1. **子代理级 tools/allowedTools 遮蔽面未核实**：`types.ts` 的 `SubagentConfig.tools`/`allowedTools` 经 `core.ts:280`（`req.options.agents`）直通 SDK，当前无任何调用方构造该字段，是死代码，因此本 PR 未触发实测。PR E（子代理落地）开工前，必须用本 PR 同款 probe 手法（参考 `scratchpad/probe-can-use-tool-shadowing.mjs` 的实测方式：真实起一个带 `agents` 配置且子代理声明了裸 `tools`/`allowedTools` 的 query，观察是否触发 `CLAUDE_SDK_CAN_USE_TOOL_SHADOWED` 或子代理工具调用绕过顶层 `canUseTool`）核实子代理级 `tools`/`allowedTools` 是否会同样遮蔽顶层 `canUseTool`。若遮蔽，需要在子代理配置组装处套用与 `getAllowedWikiTools` 一致的策略（写工具/敏感工具不进裸 allowedTools）。
2. **rewind-bridge.ts 正则死分支**：`isTransportClosedError` 的 `"transport is closed"` alternative，在 SDK 0.3.201 的 `sdk.mjs` 中已无对应字面量（WebSocket transport 已改用与 ProcessTransport 一致的 "not ready for writing" 措辞，被另一个 alternative 覆盖）。当前无害（不会漏判，只是多余分支），下次升级 SDK 时顺手清理，无需单独立项。
