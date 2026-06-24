# Mac Product Baseline

> 类型：下一实现 PR 计划 | 创建：2026-06-24 | 状态：active candidate

## 结论

下一实现 PR 应把 LLM Wiki 的 active product target 收敛为 Mac-only maintained desktop app。README 可以先说明口径变化，但不能假装 CI、release、历史产物已经清理完成。

本地已确认：

- `upstream/main@997db74`
- upstream tag `v0.5.0`
- Issue #88 已 CLOSED（2026-06-23），可作为 Phase 6 PR C 完成证据。

## Scope

| Area | Target |
|------|--------|
| CI | 只保留主动维护所需的 macOS build/test/release gates；移除或降级非 Mac release matrix。 |
| App identity | 明确当前 fork 的 Mac app name、bundle id、icon、release naming 和 README 口径。 |
| Original app confusion | 避免用户把当前 Mac-maintained fork 和上游原版 cross-platform claim 混淆。 |
| Release strategy | Mac `.dmg` 是主动发布目标；旧 Windows/Linux artifacts 标注为 legacy/transitional。 |
| Docs | README、plans、release notes 口径一致；不承诺未维护平台。 |

## Non-goals

- 不迁移到 Swift/SwiftUI。
- 不引入 iOS target。
- 不删除 Tauri/Rust/TypeScript/Agent SDK 架构。
- 不在 docs-only roadmap PR 里改 CI 或 release workflow。

## Implementation Notes

1. 先审计 `.github/workflows/`、Tauri config、release scripts 和 README 下载说明。
2. 区分三类产物：actively maintained macOS、legacy Windows/Linux、transitional CI artifacts。
3. 更新 release matrix 前先确认签名、公证、bundle resources 和 Agent sidecar binary 是否仍完整。
4. PR body 必须说明 README 已提前改成 Mac-only active maintenance，但 CI/release pruning 是本 PR 才真正完成。

## Acceptance

- `README.md` / `README_CN.md` 不再承诺 Windows/Linux 主动支持。
- CI 和 release workflow 不再暗示所有桌面平台都是 active target。
- macOS Apple Silicon + Intel 构建路径清楚。
- Agent sidecar binary、MCP resources、Tauri resources 打包不回退。
- `pnpm lint`、相关测试、`git diff --check` 和 `npx gitnexus detect_changes --repo llm_wiki` 通过。
