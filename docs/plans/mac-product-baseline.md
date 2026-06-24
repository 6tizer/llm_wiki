# Mac Product Baseline

> 类型：实现 PR 计划 | 创建：2026-06-24 | 状态：implementation/current | Issue/PR：#117 Mac-only CI + app identity cleanup

## 结论

本 PR 把 active product target 收敛为 Apple Silicon Mac-only maintained desktop app，并把产品身份改为 `LLM Wiki Agent`。

当前实现决策：

- App name：`LLM Wiki Agent`
- Bundle identifier：`com.6tizer.llmwiki.agent`
- Bundle targets：`app` + `dmg`。README/release 只承诺 DMG；保留 `app` target 避免 dev/app bundle 行为意外回退。
- Active CI：macOS only。
- Active release：`macos-latest` + `aarch64-apple-darwin`，只上传 Apple Silicon DMG。
- Bundle id 从旧 `com.llmwiki.app` 变为 `com.6tizer.llmwiki.agent`；启动时若新 `app-state.json` 不存在，会从旧 bundle id / 旧 product name 路径复制一次，避免用户设置静默消失。
- `tauri.linux.conf.json`、`tauri.windows.conf.json`、`windows-app-manifest.xml` 和非 Mac PDFium assets 保留为 legacy reference，不是 active target。

本地已确认：

- upstream tag `v0.5.0@997db74`
- upstream tag/current main `v0.5.1@cc4b98f`
- Issue #88 已 CLOSED（2026-06-23），可作为 Phase 6 PR C 完成证据。

## Scope

| Area | Target |
|------|--------|
| CI | 只保留主动维护所需的 macOS build/test/release gates；移除或降级非 Mac release matrix。 |
| App identity | 明确当前 fork 的 Mac app name、bundle id、release naming 和 README 口径；不重画 icon。 |
| Original app confusion | 避免用户把当前 Mac-maintained fork 和上游原版 cross-platform claim 混淆。 |
| Release strategy | Mac `.dmg` 是主动发布目标；旧 Windows/Linux artifacts 标注为 legacy/transitional。 |
| Docs | README、plans、release notes 口径一致；不承诺未维护平台。 |

## Non-goals

- 不迁移到 Swift/SwiftUI。
- 不引入 iOS target。
- 不删除 Tauri/Rust/TypeScript/Agent SDK 架构。
- 不删除 Linux/Windows Tauri 配置或 legacy assets。
- 不做复杂双向同步或旧状态清理；只做一次性 legacy app-state copy。

## Implementation Notes

1. 审计 `.github/workflows/`、Tauri config、release scripts 和 README 下载说明。
2. 区分两类产物：actively maintained Apple Silicon macOS、legacy Windows/Linux。
3. Release matrix 只保留 `macos-latest` + `aarch64-apple-darwin`，同时保留 Agent sidecar binary、MCP resources、Tauri resources 的 build/test 步骤。
4. `bundle.targets` 使用 `["app", "dmg"]`，不是仅 `["dmg"]`。
5. PR body 必须说明 bundle id 改变和一次性 app-state migration 行为。

## Acceptance

- `README.md` / `README_CN.md` 不再承诺 Windows/Linux 主动支持。
- CI 和 release workflow 不再暗示所有桌面平台都是 active target。
- macOS Apple Silicon 构建路径清楚，不承诺 Intel。
- Agent sidecar binary、MCP resources、Tauri resources 打包不回退。
- `git diff --check`、相关测试和 `npx gitnexus detect_changes --repo llm_wiki` 通过。
