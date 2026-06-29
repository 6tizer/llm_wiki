# SPEC-1: App Architecture Decomposition / Native-Ready Core Boundary

> 类型：阶段 SPEC | 状态：reviewed / ready for PR split | 覆盖：desktop architecture、Swift readiness、#184-#191 的共同前置

## 目标与成功标准

把当前桌面应用从 “Tauri/React UI 里承载业务 runtime” 拆成 native-ready 的分层架构，让后续 Work Runtime、Markdown commit、profiles、parallel pipeline、Unified Agentic Chat 都落到 shell-agnostic core boundary。

成功标准：

- 新 runtime 能力不再新增到 React component、Zustand store、`App.tsx` lifecycle 或 Tauri UI glue。
- Tauri/React 被定义为 current UI shell adapter；Swift/SwiftUI 被定义为 future UI shell adapter。
- Core Runtime 通过稳定 local API / IPC / command contract 暴露能力；UI shell 只负责调用命令、订阅状态、渲染交互。
- Platform adapter 只封装文件系统、Keychain、window/tray、dialog、open-url、local server、process lifecycle 等平台能力。
- Agent adapter 只封装 Claude Agent SDK sidecar / future Agent runtime，不直接依赖 React UI state。
- 旧 TS 业务逻辑采用 strangler migration：旧路径可保留，新能力先走 core boundary，后续逐步迁移。
- SPEC-1 PR1 必须产出 runtime command/event inventory 和 boundary enforcement 方案，才能允许 SPEC-2/3/4 做依赖 core contract 的集成实现。

## 关键设计决策

- Markdown vault 仍是用户长期资产；`runtime.db`、vector/search index、derived artifacts 都是中间态或可重建状态。
- Core Runtime 是产品能力边界，不是当前桌面壳的 implementation detail。未来 Swift shell 必须复用同一套 core API，而不是重写知识编译逻辑。
- 当前代码现实：
  - `src/App.tsx` 承担 auto-save、clip watcher、update check、project/config hydrate、agent session cleanup 等非 UI bootstrap。
  - `src/lib/ingest-queue.ts` 是 TS 全局内存队列 + JSON persistence + Zustand activity side effect。
  - `src/lib/project-store.ts` 直接使用 Tauri plugin-store，并与 Rust `app-state.json` 读取耦合。
  - `src-tauri/src/lib.rs` 混合 desktop shell、tray/window、proxy/bootstrap、command registry、sidecar/process state。
  - `src/commands/*.ts` 是 Tauri invoke wrapper，但还不是稳定 shell/core contract。
- 近期不删除 Tauri/React；拆分目标是让 Tauri/React 降级为 adapter，避免后续能力继续绑定 webview lifecycle。
- Swift 回填接口从本 SPEC 开始定义：Swift shell 未来通过同一套 local API / IPC / runtime command contract 接入 Core Runtime。
- Contract stability ladder：`draft` 可用于讨论，`frozen` 可用于 SPEC-2/3/4 集成，`stable` 可用于 SPEC-9 Swift shell。PR1 目标至少是 `frozen`，判据是命令/事件 inventory 完整、headless contract test skeleton 存在、核心类型不依赖 React/Tauri。

Runtime command/event inventory draft：

| Family | Commands / events to define |
|--------|-----------------------------|
| Project | open/create/list/recent project, project health, project path identity |
| Job runtime | create job, claim/cancel/retry/pause/resume job, subscribe job progress/events |
| Markdown commit | submit artifact, commit path, report conflict, enqueue repair |
| Profiles | list/create/update/test profile, read capability status, resolve secret reference |
| Derived | mark stale, claim rebuild, report ready/stale/building/failed, manual rebuild |
| Agent run | start/stop/resume/rewind run, permission request/response, timeline/tool events |
| Settings/status | app/runtime health, feature flags, storage migration status, adapter capabilities |

Boundary enforcement draft：

- Add at least one headless contract test that calls Core Runtime without rendering React.
- Add an import-lint or static check for new core modules so they cannot import React components, Zustand stores, or Tauri plugin APIs directly.
- If a PR must touch old coupled modules, it must name the migration reason and prove behavior unchanged.

Strangler migration priority:

| Priority | Current coupling | Done criteria |
|----------|------------------|---------------|
| 1 | `App.tsx` non-UI bootstrap | bootstrap side effects represented as runtime/bootstrap services or explicit shell adapter calls |
| 2 | `src/lib/ingest-queue.ts` global queue + JSON + Zustand activity | queue state represented by runtime job API; UI reads events/status |
| 3 | `src/lib/project-store.ts` Tauri plugin-store coupling | settings API separates UI preferences, runtime state, secret references, and project state |
| 4 | `src-tauri/src/lib.rs` mixed shell/bootstrap/commands | command registry delegates to platform/core adapters with clear ownership |
| 5 | `src/commands/*.ts` ad hoc invoke wrappers | wrappers map to the stable command/event inventory |

## 预期 PR 拆分

1. Architecture ADR + module boundary map + runtime command/event inventory + minimal headless contract skeleton：定义 UI Shell、Core Runtime、Platform Adapter、Agent Adapter、Storage Boundary，并把 contract 提升到 `frozen`。
2. Boundary enforcement：扩展 headless contract tests，并加入 import/static check，防止新 core 模块依赖 React/Zustand/Tauri plugin-store。
3. Bootstrap boundary cleanup：把 `App.tsx` 中非 UI bootstrap 标记为 runtime/bootstrap service 候选，不在 UI lifecycle 新增业务副作用。
4. Store boundary cleanup plan：区分 UI view state、runtime state、persisted app settings、project runtime state。
5. Adapter contract tests：用 mock shell 调 Core Runtime API，证明 core 不依赖 React render 或 Tauri plugin-store。

## 验证策略

- 文档验收：SPEC-2 到 SPEC-9 都明确依赖本 SPEC 的 shell/core 边界；SPEC-9 只能在该边界稳定后进入 Swift shell re-entry。
- Contract tests：后续实现 PR 必须能在 headless/mock shell 下测试 core runtime API。
- UI 验收只验证 shell adapter 是否正确调用 core，不再把业务正确性绑在 Playwright UI 自动化里。
- `pnpm lint`、`git diff --check`、GitNexus detect。

## Gate 结论摘要

本 SPEC 随当前 docs PR 通过 PR-level gate；详见 [SPEC-0](./spec-0-roadmap-baseline.md) 的统一 gate 摘要。实现 PR 必须重新审查 shell/core API、storage boundary、Swift re-entry compatibility 和旧 TS 业务逻辑迁移顺序。

## Non-goals / Follow-up

- 不在本阶段删除 Tauri/React。
- 不立即实现 Swift UI。
- 不一次性搬完所有 `src/lib` 旧业务逻辑。
- 不把 Core Runtime 做成远程云服务；第一版仍是本地 desktop runtime。
