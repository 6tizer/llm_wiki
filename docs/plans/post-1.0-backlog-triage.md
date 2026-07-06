# Post-1.0 Backlog 全量对账（2026-07-06）

> 类型：triage / 单一入口 | owner：LLM Wiki commander
>
> 1.0 门槛达成（[release-1.0-final-acceptance.md](./release-1.0-final-acceptance.md)）后，对全部 open issues、验收发现、真机根因追查结论做一次性归位。**本文档是 post-1.0 工作的唯一入口**：每个 open issue 都能在下面四个池子之一找到；不在池子里的 issue 应当已关闭（见 §5 关闭清单）。

## 0. 触发背景

2026-07-06 用户真机实测反馈「Agent 可以连上但没办法干活」。完整 UI 操作验收（10 项发现）+ runtime DB 根因追查把体感问题分解为五个独立根因（#371/#372/#340/#376/#377），并暴露了 backlog 散落在 30+ 个 issue、无 SPEC 归属、关键节点不可寻的管理问题。本次对账：新建 8 个 issue（#371-#378）、关闭 12 个已消费/已交付的陈旧 issue、把剩余全部 open issues 归入四个池子、新立 SPEC-15/SPEC-16。

## 1. 池子 A：SPEC-15 Agent 干活可用性（新立，最高优先级）

主题：**「连得上 → 干得动 → 状态可信」**。用户实测的核心痛点，全部条目见 [spec-15-agent-usability.md](./spec-15-agent-usability.md)。

| Issue | 级别 | 一句话 |
|---|---|---|
| #371 | P1 | agent-chat-run claim 必失败（deny_unknown_fields 拒 jobId）→ Runtime 全「已取消」 |
| #372 | P1 | maxFilesChangedEnabled 死开关 + 默认 10 截断批量修复 |
| #337 | P1 | 写权限弹窗风暴 + 31s 自动拒绝竞态误导 Agent 放弃 |
| #340 | P1 | agent_sdk_model_id 别名与 model_id 脱节（双模型配额迷局的根源） |
| #376 | P2 | Provider 健康状态双源矛盾；瞬时 429 呈现为持久故障 |
| #352 | P2 | model-call 池降级缺 timeline 披露 |
| #377 | P2 | 「未配置」被呈现为「不可用」（fallback 空态 + Knowledge Agents 零引导） |
| #362 | P2 | fork 会话不继承 profile/权限 override 的产品语义裁定 |
| #84 | P2 | Agent 权限设置双入口（与 #337 同一权限 UX 面） |
| #66 | P3 | compact/resume 摘要被当普通回复处理 |
| #67 | P3 | resume 忽略纠正性输入、执行自己上一轮的 pending 问题 |

## 2. 池子 B：SPEC-16 UI 交互质量二轮（新立）

主题：**验收发现的交互 bug 群**，全部有截图和复现步骤。见 [spec-16-ui-interaction-quality.md](./spec-16-ui-interaction-quality.md)。

| Issue | 级别 | 一句话 |
|---|---|---|
| #373 | P1 | 审阅队列自相矛盾（「无此页/Create Page」与「已创建」同屏） |
| #374 | P1 | 代码块横向滚动推走整个消息面板 |
| #359 | P2 | 用户气泡长 token 左裁（生产构建已复现确认） |
| #375 | P2 | 图谱详情面板三连（跨 tab 残留/关闭命中失败/标题竖排） |
| #378 | P3 | 三件套：图谱单击无反馈 / lint 不随内容重扫 / 派生状态口径矛盾 |
| #335 | P3 | lint orphan 指标错配（按目录区分指标） |

## 3. 池子 C：Runtime 数据与生命周期长尾（暂不立 SPEC，按 P2 波次穿插）

主题：closeout 深审留下的 crash-window / 竞态 / 生命周期治理，均无用户可感知的日常影响，适合作为功能间隙的加固波次。凑齐一个执行波次时再立 SPEC 或直接按 issue 串行。

| Issue | 来源 | 一句话 |
|---|---|---|
| #286 | SPEC-6 closeout | marker 消费未被 withProjectLock 覆盖，可与项目/源删除竞态 |
| #287 | SPEC-6 closeout | 孤儿 claimed marker / anchor job 崩溃窗口 reconcile + 诊断 |
| #289 | SPEC-6 closeout | dedup 合并写入绕过 derived-rebuild marker，向量索引漂移 |
| #309 | SPEC-7 follow-up | appTool 通道 wiki 写快照（15+1 工具，#292 阶段二） |
| #311 | SPEC-7 follow-up | abortRef 全局单槽按 run 隔离 |
| #313 | SPEC-7 follow-up | rewind 会话纳入 job ledger |
| #314 | SPEC-7 follow-up | rewind-snapshots 目录生命周期治理 |
| #350 | SPEC-13 closeout | secret 后端切换不清理旧副本 |
| #351 | SPEC-13 closeout | App.tsx legacy 重解析路径退役 |
| #353 | CI | App.test.tsx 时序套件 macos runner flake |

## 4. 池子 D：维护性长尾（既有轨道，不变）

| Issue | 一句话 |
|---|---|
| #183 | #119 P2-8~P2-12 纯重构 + 测试覆盖（autoIngestImpl 拆分等），随功能开发穿插 |

Swift/native（SPEC-9 + native-architecture.md）按用户裁定继续 deferred，不入本对账的执行池。

## 5. 本次关闭清单（2026-07-06，均留关闭理由于 issue）

| Issue | 关闭理由 |
|---|---|
| #294 / #330 / #342 | SPEC-12/13/14 tracking issue，SPEC 已 completed |
| #310 | 主体由 SPEC-13 K2+P2（#334）交付，残留=#351 |
| #227 / #229 / #243 | SPEC-4-FIX PR1/PR2、SPEC-5 PR5 已 merged |
| #184 / #189 / #190 / #191 | 架构锚点，分别被 SPEC-2/6/7/5 实现消费 |
| #68 | SPEC-7 时间线已交付并经生产验收确认 |

## 6. 验收发现 ↔ issue 对照（2026-07-06 UI 操作验收，10 项）

| 验收发现 | Issue |
|---|---|
| ① 审阅队列自相矛盾 | #373 |
| ② 代码块横滚推走面板 | #374 |
| ③ 用户气泡长 token 左裁 | #359（补证据） |
| ④⑤ 图谱详情面板跨 tab 残留/关闭失败/标题竖排 | #375 |
| ⑥ 健康状态双源矛盾 | #376 |
| ⑦ fallback 队列空态误导 | #377 |
| ⑧ Runtime 任务全「已取消」 | #371（根因实锤） |
| ⑨ 图谱单击无反馈 | #378 |
| ⑩ lint 不随内容重扫 | #378 |
| （D）派生状态口径矛盾 | #378 |

验收未覆盖面（如实记录）：窗口 resize、多会话切换、模型选择器实操、权限模式区块——SPEC-16 验收时补测。

## 7. 建议执行顺序

1. **SPEC-15 P0 波**（#371 → #372 → #337 → #340）：#371 是一行级契约修复；#372/#337/#340 直接决定「Agent 能不能干活」
2. **SPEC-16 P1 波**（#373/#374）+ SPEC-15 P1 波（#376/#352/#377）可并行（前端 UI 轨 vs 状态/池轨）
3. 两 SPEC closeout 后，池子 C 凑波次执行
4. #183 持续穿插
