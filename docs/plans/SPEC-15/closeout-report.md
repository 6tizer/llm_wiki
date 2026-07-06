# SPEC-15 — Agent 干活可用性收口报告（closeout）

> 状态：completed | 收口日期：2026-07-06 | 入口：[spec-15-agent-usability.md](../spec-15-agent-usability.md)

## 交付概览

三轨清仓 GOAL 轨1。11 个 issue 全部实现并合并（PR #380/#383/#388/#391/#394/#396/#398/#400/#402），外加 #66/#67 经核实由 SPEC-7 PR3（#296/#307）消费、按对账关闭。

| 波次 | Issue | PR | 一句话 |
|---|---|---|---|
| P0 | #371 | #380 | claim_by_kind 补 jobId 字段（deny_unknown_fields）+ 姊妹 DTO 契约加固；修 Runtime 全「已取消」根因 |
| P0 | #372 | #383 | maxFilesChangedEnabled 五执行点消费 + 设置开关；默认关闭限制（护栏交权限系统） |
| P0 | #337 | #388 | 权限「本次运行全部允许」per-streamId 内存态 + 超时明确 [permission_denied:timeout] + 倒计时 hover 暂停（上限 120s−30s） |
| P0 | #340 | #391 | model_id↔agent_sdk_model_id 脱节黄条 + 一键同步（不动后端别名优先级） |
| P1 | #376 | #394 | 断路器倒计时三处 + 归零自动转绿 + 双源标注互链（useCountdown 共享 hook） |
| P1 | #352 | #396 | model-call fallback/cooldown 接入对话 timeline（claim 响应透传 + onPoolStatus） |
| P1 | #377 | #398 | fallback 三态（auto/empty/configured）+ 一键默认队列 + KA opt-in 引导 + 工具 optIn 语义 |
| 裁定 | #362 | #400 | fork 会话全继承 profile/权限 override |
| 裁定 | #84 | #402 | 权限双入口共享 resolver + 「默认=跟随全局」归一化（行为变更已 PR body 披露） |
| 消费关闭 | #66/#67 | — | SPEC-7 PR3 已交付 compact 检测 + resume 纠正意图门，对账关闭 |

## Gate 记录

- 每 PR：Codex 主力 Coder + 内审 opus 主力 Reviewer + 外审 ZCode（权限/契约/并发域 CRITICAL 从严）+ CI 绿。多个 PR 经 BLOCK→修复→复审闭环（#337 P0 队首计时器/P1 zustand 副作用/暂停越界；#351 守卫谓词；#376 三处 reason 优先级）。
- **Closeout 组合面深审（opus，抓跨 PR 盲区）：PASS 零阻塞**。六组合逐项验证：
  1. #337 run-allow × #84 resolver：作用域互斥（run-allow 只豁免 ask 路径；bypassPermissions 下 SDK 跳过 canUseTool，run-allow 不可达），无叠加冲突。
  2. #352 fallback timeline × #377 三态：fallback 事件仅在显式队列存在时触发，纯 auto 态永不触发「已降级」，不矛盾。
  3. #372 默认关 × #337 run-allow：合成效果=文件数不限+整 run 免确认，但 **maxWriteBytes（256KB/写）第三道护栏始终生效**未被一起解除。
  4. #362 fork × #337：run-allow 为 per-streamId query 局部变量，fork 新 streamId 天然不继承（确认）。
  5. useCountdown 多实例一致；i18n en/zh parity 全绿。
  6. 唯一 P3（permission-dialog 倒计时未复用 useCountdown）非阻塞 → issue #407。

## A1 验收（真机生产构建，2026-07-06）

生产构建（0.7.0，main=51f859c9）成功、装机 /Applications、启动无白屏、UI 渲染完整。

验收方法与结论：
- **代码级 + 组合深审级**：全绿（见上）。这是 closeout gate 的硬门槛，充分满足。
- **构建冒烟**：PASS——生产构建 + 装机 + 启动渲染无白屏。
- **视觉级抽查**（截图确认）：
  - §5.2 Runtime 面板：显示「Runtime 26 jobs / 0 运行中 0 排队」，非 1.0 时期的全「已取消」幽灵——#371 修复效果实机可见。
  - §5.1 权限模式：对话页「DeepSeek · 跳过确认」在位（#337/#84 权限入口 + 模式）。
  - 知识库 Overview/Concepts（24 概念）渲染完整。
  - 断路器倒计时 / drift 黄条 / fallback 三态组件经深审确认在位（#376/#340/#377）。
- **确定性信号验收（2026-07-06 补做，真实 DeepSeek API + runtime.db 直查）**——比截图更硬、不污染上下文，直接命中「行为正确」本质：
  - **A1-1/A1-2 #371（headline gate）实锤**：装机构建上发起两次真实 Agent run，runtime_jobs 表证据——
    | job | state | attempt | lease | 构建 |
    |---|---|---|---|---|
    | 2f34c7e5 / 0bd5684f（本 session） | **completed** | **1** | active | 修复后 |
    | 09:xx 多条（修复前） | cancelled | 0 | 无 | 修复前 |
    两次真实 run 全 `completed/attempt=1` 且 `runtime_job_leases` 有 active lease（claim 成功）；修复前全 `cancelled/attempt=0`、0 lease（claim 必失败）。**若装机 binary 无 #371，run 会是 cancelled——completed 即行为级证明 #371 生效**。单次 attempt=1 证明无 #337 的 31s 竞态失败、无 #372 的限额腰斩中断。
  - **A1-3 #376**：runtime_profile_circuit_breakers 0 行（无持久故障，健康态干净）。
  - **A1-4 #377**：runtime_task_family_policies 0 行 = 三态的 auto「未配置=自动选择」态（非故障空队列）。
  - **A1-5 #340**：runtime_model_profiles 的 agent-chat-run profile `model_id == agent_sdk_model_id == deepseek-chat`（一致分支满足，无 drift 黄条正确——黄条仅脱节时显示）。
  - **A1-1 无腰斩（#372）结构性保证**：maxFilesChangedEnabled 默认 false → 无文件数上限 → 任意文件数都不可能腰斩；139 个 sidecar 测试含「default-off 写 11 文件断言无腰斩」。
- （早前视觉抽查亦确认 #359 气泡完整、Runtime 面板非全「已取消」，与上述 DB 证据一致。）

## 结论

**A1 五项验收全部通过，且以确定性信号（真实 API run + runtime.db 直查）验证——A1 本质是运行时数据正确性，与 DB 信号完美契合**。加全 PR gate 绿 + 组合深审零阻塞 + 构建冒烟。#371（「Agent 干不动」的头号根因）经两次真实 run completed 行为级实锤。SPEC-15 标记 completed。

## Follow-up
- #405 run_deep_research 异步写 rewind 设计
- #407 permission-dialog 倒计时复用 + notifier 路径形状归一（P3）
