# SPEC-15 — Agent 干活可用性收口（Agent Usability Hardening）

> 类型：SPEC charter | 状态：draft / 待用户确认波次 | 创建：2026-07-06
> 入口对账：[post-1.0-backlog-triage.md](./post-1.0-backlog-triage.md) 池子 A

## 1. 问题陈述

1.0 门槛验收证明了「Agent 连得上」（M 冒烟真实 API 全绿），但 2026-07-06 用户真机实测证明**「连得上 ≠ 干得动」**：一次普通的「修复 wiki 健康问题」请求被四个独立缺陷叠加击穿——

1. 批量修复写到第 10 个文件被默认限额腰斩（#372），且「关闭限制」开关是死旗
2. 权限弹窗风暴 + 31s 自动拒绝让 Agent 把连环拒绝误判为系统 bug 而放弃（#337，实测浪费 $0.40/17 轮）
3. model-call 池撞瞬时 429 后，健康呈现将其放大为「provider 级持久故障」（#376），而 agent-run 别名脱节（#340）让「同一 DeepSeek 一侧可用一侧 429」成为无人能解释的迷局
4. Runtime 面板全部显示「已取消」（#371），Agent 运行状态完全失真

再叠加两个「未配置被呈现为不可用」的空态误导（#377），用户与应用内 Agent 的一致结论是「系统坏了」——而 DB 实证系统底座（池 claim/断路器/修复路径）全部正常。**这是产品逻辑与呈现层的收口问题，不是底座问题。**

## 2. 目标

用户对 Agent 说「修复 Wiki 健康里的所有问题」，Agent 能在合理权限交互内一次跑完，且过程状态（Runtime 面板 / 健康 Dashboard / timeline）与事实一致。

## 3. 范围与波次

### P0 波（先修「干不动」）

| Issue | 内容 | 量级 |
|---|---|---|
| #371 | claim_by_kind 请求形状契约修复 + TS↔Rust deny_unknown_fields 契约测试 | XS，一行级 + 测试 |
| #372 | maxFilesChangedEnabled 五处执行点消费 + 设置补开关控件 + 默认值重评估 | S |
| #337 | 同一运行内同目标写操作合并授权 /「本次运行内允许」/ 自动拒绝返回明确 permission_denied 语义 / 倒计时暂停于交互 | M，需设计裁定 |
| #340 | model_id 变更联动 agent_sdk_model_id（UI 双字段显示 + 变更提示或同步） | S |

### P1 波（再修「状态不可信」）

| Issue | 内容 |
|---|---|
| #376 | 健康状态单源化/标注来源+时间戳；429 按瞬时事件呈现（retry-after 倒计时），断路器状态联动 UI |
| #352 | model-call 池降级接入对话 timeline 披露（设计 model-call 侧降级事件类型） |
| #377 | fallback 空态文案区分「未配置=自动选择」；一键生成默认队列；Knowledge Agents 启用引导入口 |

### 裁定波（需产品决定，随 P1 顺带）

| Issue | 决定点 |
|---|---|
| #362 | fork 会话是否继承 profile/权限 override |
| #84 | 权限设置双入口（与 #337 同一权限 UX 面，合并设计） |
| #66/#67 | resume/compact 语义（P3，若量级大则降级回池子 C） |

## 4. 非目标

- 不动池 claim/断路器/fallback 的底座语义（SPEC-4/13 已交付且实证正常）
- 不做新的权限模型（#337 是交互层修复，不是权限体系重设计）
- Swift/native 不涉及

## 5. 验收标准（closeout gate）

真机生产构建，测试项目一次性走查：

1. Agent 修复 15+ 个 wiki 健康问题：默认权限模式下权限交互次数可数（合并授权生效）、无 31s 竞态误判、无限额腰斩（或撞限后按 recovery 指引续跑）
2. Runtime 面板：该次运行显示 running → completed，无「已取消」幽灵
3. 人为触发一次 429（或 mock）：Dashboard 呈现为瞬时事件 + 倒计时，settings 页与 Dashboard 状态可相互解释；恢复后自动转绿
4. 新项目首开：fallback 空态与 Knowledge Agents 空态均有引导文案，Agent 健康检查输出不再把未配置报为 ❌
5. #340：改 model_id 后 SDK 实际调用模型与设置页显示一致（或有显式脱节提示）

## 6. 依赖与关联

- 依赖 SPEC-13 交付的池/断路器/fallback 基座（已 completed）
- #376/#352 共享「错误可见性」设计，应同 PR 或相邻 PR
- 与 SPEC-16 无代码耦合，可双轨并行（本 SPEC 偏 runtime/设置，SPEC-16 偏对话/图谱/健康页前端）
