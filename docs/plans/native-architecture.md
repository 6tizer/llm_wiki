# Native Architecture ADR Backlog

> 类型：ADR backlog | 创建：2026-06-24 | 状态：deferred

## 结论

Swift、SwiftUI、AppKit 和 iOS 只作为远期 native architecture ADR 议题。当前 roadmap 继续使用 Tauri v2、Rust backend、React/TypeScript frontend 和 Claude Agent SDK sidecar。

Mac-only active maintenance 不等于立即 native rewrite。近期目标是把现有 Mac desktop app 打磨稳定，而不是拆掉 Tauri 架构。

## Current Architecture

| Layer | Current choice |
|-------|----------------|
| Desktop shell | Tauri v2 |
| Backend | Rust |
| Frontend | React + TypeScript + Vite |
| Agent | Claude Agent SDK through Node.js sidecar / bundled sidecar binary |
| Data | Markdown wiki on disk, Obsidian-compatible vault |

## Deferred Questions

- 是否需要 SwiftUI native shell。
- 是否需要 iOS companion app。
- 是否需要把 Agent sidecar 能力下沉到 Rust-native runtime。
- 是否需要 AppKit-level integrations beyond Tauri capabilities。

## Decision Gate

只有当以下条件同时成立时，才重新打开 native rewrite ADR：

- Mac-only baseline 已完成。
- Phase 6 upstream v0.5.0 P0/P1 手动同步完成。
- Phase 7 Agent SDK productization 的核心体验稳定。
- Tauri 架构出现明确、可量化、无法局部修复的产品限制。

## Non-goals

- 不在近期规划 iOS。
- 不在 `mac-product-baseline` PR 引入 Swift/SwiftUI。
- 不为了品牌或平台口径重写成熟的 Rust/TS 功能。
