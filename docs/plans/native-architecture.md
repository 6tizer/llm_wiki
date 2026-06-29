# Native Architecture ADR Backlog

> 类型：ADR backlog | 创建：2026-06-24 | 状态：active boundary / deferred implementation

## 结论

Swift、SwiftUI、AppKit 和 iOS 的实现仍 deferred；但 native-ready boundary 不再只是远期 ADR。当前 roadmap 通过 [SPEC-1 App Architecture Decomposition](./spec-1-app-architecture-decomposition.md) 先拆 UI shell / Core Runtime / Platform Adapter / Agent Adapter 边界，后续 Swift shell 回填由 [SPEC-9 Swift Shell Re-entry](./spec-9-swift-shell-reentry.md) 承接。

Mac-only active maintenance 不等于立即 native rewrite。近期目标不是马上删除 Tauri/React，而是让新 runtime 能力不再绑定 Tauri/React webview lifecycle。

OKF 兼容、upstream `v0.5.x` Chat Agent Router 对齐和 Claude Agent SDK latest stable 对齐都不改变近期技术主线。它们分别属于知识包格式兼容、普通 Chat/RAG/UI 对齐和 sidecar SDK 维护，不是 native rewrite 触发条件。

## Current Architecture

| Layer | Current choice |
|-------|----------------|
| Desktop shell | Tauri v2 |
| Backend | Rust |
| Frontend | React + TypeScript + Vite |
| Agent | Claude Agent SDK through Node.js sidecar / bundled sidecar binary |
| Data | Markdown wiki on disk, Obsidian-compatible vault |

## Active Native-Ready Boundary

SPEC-1 现在负责近期边界拆分：

- Tauri/React 是 current UI shell adapter。
- Swift/SwiftUI 是 future UI shell adapter。
- Core Runtime 暴露 stable local API / IPC / runtime command contract。
- Platform Adapter 封装文件系统、Keychain、window/tray、dialog、open-url、local server、process lifecycle。
- Agent Adapter 封装 Claude Agent SDK sidecar / future Agent runtime。
- 旧 TS 业务逻辑采用 strangler migration；新能力先走 core boundary。

## Deferred Questions

- SwiftUI native shell 的实现排期和具体 app scaffold。
- 是否需要 iOS companion app。
- 是否需要把 Agent sidecar 能力下沉到 Rust-native runtime。
- 是否需要 AppKit-level integrations beyond Tauri capabilities。

## Decision Gate

只有当以下条件同时成立时，才进入 SPEC-9 Swift shell re-entry 实现：

- SPEC-1 shell/core boundary 已落地。
- SPEC-2 runtime DB/job API 已稳定，并有 headless contract tests。
- SPEC-3 commit layer 不依赖 React/Tauri lifecycle。
- SPEC-4 profile/secret storage 有 shell-neutral contract。
- SPEC-7 Unified Agentic Chat 的核心编排不绑定 React UI。

## Non-goals

- 不在近期规划 iOS。
- 不在 `mac-product-baseline` PR 引入 Swift/SwiftUI。
- 不为了品牌或平台口径重写成熟的 Rust/TS 功能。
- 不在 Swift shell 覆盖核心流程前删除 Tauri/React。
