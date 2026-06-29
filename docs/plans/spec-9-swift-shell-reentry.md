# SPEC-9: Swift Shell Re-entry / Native Shell

> 类型：阶段 SPEC | 状态：deferred / gated | 覆盖：Swift/SwiftUI 回填、native shell 接入

## 目标与成功标准

在 SPEC-1 到 SPEC-8 的 core boundary 稳定后，用 Swift/SwiftUI 接入同一套 Core Runtime，形成 native shell 回填路径。Swift 替换的是 UI shell，不重写 Markdown source of record、runtime DB、scheduler、commit layer、provider profiles 或 Agent orchestration。

成功标准：

- Swift shell 能通过 stable local API / IPC / runtime command contract 打开项目、读取状态、创建 job、订阅进度、调用 Agent run。
- 最小 native shell 覆盖核心流程：open project、Unified Agentic Chat、job timeline、settings/profile、Markdown read/write/status。
- Swift shell 与 Tauri/React shell 在同一 fixture project 上读写同一 Markdown vault 和 runtime state。
- 删除 Tauri/React 只能在 Swift shell 覆盖核心流程并通过验收后另开 pruning PR。

## 触发条件

进入实现前必须满足：

- SPEC-1 shell/core boundary 已落地，Core Runtime API 不依赖 React render、Zustand store 或 Tauri plugin-store。
- SPEC-2 runtime DB/job API 已稳定，并有 headless contract tests。
- SPEC-3 commit layer 不依赖 React/Tauri lifecycle。
- SPEC-4 profile/secret storage 有 shell-neutral contract，secret 存 OS Keychain / 系统安全存储。
- SPEC-5 parallel pipeline 通过 runtime job/timeline API 暴露进度，不依赖 React component lifecycle。
- SPEC-6 derived rebuild status、artifact links 和 repair actions 通过 Core Runtime event/command contract 暴露。
- SPEC-7 Unified Agentic Chat 的核心编排不绑定 React UI；进入 Swift shell 前必须有 headless contract tests 覆盖 chat job creation、permission event subscription、timeline status API 和 Agent-run preflight。
- SPEC-8 fixture/tooling 能在 headless core 与 shell adapter 两层分别验证，避免 Swift shell 变成唯一验收入口。

## 关键设计决策

- Swift re-entry 是后置实现锚点，不阻塞 SPEC-1 到 SPEC-8 的 core/runtime 工作。
- Swift shell 使用 Core Runtime 的稳定命令和事件，不直接读取内部 DB 表作为业务 API。
- native UI tests 验证 Swift adapter；core correctness 仍由 headless runtime tests 覆盖。
- Tauri/React 在 Swift shell 覆盖核心流程前继续作为 current shell adapter 保留。

## 预期 PR 拆分

1. Swift shell ADR + project scaffold decision。
2. Minimal runtime client：连接 local API / IPC，读取 health、project、job state。
3. Project open + Markdown reader shell。
4. Unified Agentic Chat native shell：输入、permission、timeline、job progress。
5. Settings/profile native shell：provider/model/profile、Keychain reference、capability status。
6. Cross-shell fixture validation：Tauri/React 与 Swift shell 读写同一项目。
7. Tauri/React pruning readiness review；只有通过后另开删除 PR。

## 验证策略

- `xcodebuild test` / XCTest 覆盖 shell adapter。
- Headless Core Runtime contract tests 继续作为业务正确性主验收。
- Cross-shell fixture：同一项目在 Tauri/React 和 Swift shell 下状态一致。
- Playwright 只用于 Tauri/React legacy shell；Swift 使用 XCTest / snapshot。

## Gate 结论摘要

本 SPEC 随当前 docs PR 通过 PR-level gate；详见 [SPEC-0](./spec-0-roadmap-baseline.md) 的统一 gate 摘要。进入实现前必须重新跑 Architect gate，重点审查是否满足触发条件。

## Non-goals / Follow-up

- 不在 SPEC-1 阶段实现 Swift。
- 不把 Swift shell 变成第二套业务 runtime。
- 不为了删除 Tauri/React 牺牲 Core Runtime contract 稳定性。
