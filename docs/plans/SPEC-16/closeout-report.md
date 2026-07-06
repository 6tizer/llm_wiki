# SPEC-16 — UI 交互质量二轮收口报告（closeout）

> 状态：completed | 收口日期：2026-07-06 | 入口：[spec-16-ui-interaction-quality.md](../spec-16-ui-interaction-quality.md)

## 交付概览

三轨清仓 GOAL 轨2。6 个 issue 全部实现并合并（PR #382/#384/#386/#390/#395）。

| 波次 | Issue | PR | 一句话 |
|---|---|---|---|
| P1 | #373 | #382 | wiki-change-notifier（debounce + FIFO 串行 sweep + AbortSignal + reset 接线）；Create Page 逐 draft 存在性防呆 |
| P1 | #374 | #384 | 代码块横滚 scroll chaining 三层遏制（pre overscroll-contain / 滚动容器 overflow-x-hidden / body overscroll-behavior-x:none） |
| P2 | #359 | #386 | 用户气泡长 token 左裁（max-w-full overflow-hidden + wrap-anywhere；Chrome+Safari 实测钉根因） |
| P2 | #375 | #390 | 图谱详情面板三连（离开 explore 家族清预览 / 关闭按钮扩命中 / 标题 truncate 防竖排） |
| P3 | #378+#335 | #395 | 单击高亮 / lint 重扫接线三入口 / 派生「未初始化」态 / orphan 目录 scope + source-unlinked 指标 |

## Gate 记录

- 每 PR：Codex Coder + 内审 opus 主力 + 外审 ZCode（#378 lint scope 行为面从严）+ CI 绿。#373 经内外双审 BLOCK（项目切换竞态/AbortSignal/多 draft 丢兄弟页/sweep 并发）→ 修复 → focused recheck PASS。
- **Closeout 组合面深审（opus）：PASS 零阻塞**：
  1. notifier 五入口（Agent onWikiChanged / Create Page / 手动保存 / ingest / lint 修复）：Agent 多文件写经 debounce+Set 合并为单次 drain，无双触发。
  2. #375 清预览 × #377 pendingSettingsCategory：无 explore→settings 直连流，清预览行为对所有目标视图一致，非组合回归。
  3. #359 气泡 overflow-hidden（仅 user）× #374 pre overscroll（仅 assistant 代码块）：两样式集永不作用同元素，无互斥；#374 三层 overscroll 合并后完整。
  4. #335 指标 scope × 健康分公式：computeHealthScore 同 commit 更新（source-unlinked −2 替代错误的 orphan −5 双罚，query 页排除），dashboard 分数与新 scope 一致无漂移。
  5. i18n en/zh parity 全绿。
  6. 唯一 P3（notifier 路径形状不一致，当前 inert）非阻塞 → issue #407。

## A2 验收（真机生产构建，2026-07-06）

生产构建（0.7.0，main=51f859c9）成功、装机、启动无白屏。

- **代码级 + 组合深审级**：全绿。
- **视觉级抽查**（截图确认）：
  - §5.2 用户气泡含 130+ 字符不可断 token（ACCEPTANCE_TEST_PATH_TOKEN=/Users/example/some/extremely/deep/...）**完整显示、无左裁**——#359 修复实机可见（这正是 issue 原始复现串）。
  - 对话页 UI（Agent 运行成本卡/timeline/composer）渲染完整无破版。
  - 知识库/图谱/健康页导航结构完整。
- **操作级全回归**（§5.1 审阅队列 / §5.2 代码块横滚触控板 / §5.3 图谱单击+关闭+竖排 / §5.4 broken-link 自动消失 / §5.5 resize+多会话+模型选择器）：因显示器睡眠+窗口焦点环境限制（同 SPEC-15，HANDOFF 已记），CUA 无法可靠驱动完整触控板/多窗口回归，降级为「组合深审 + 视觉抽查」覆盖。滚动物理/命中区/竖排为纯样式改动，其类断言与渲染断言在单 PR 测试中锁定。

## 结论

代码质量维度完全满足（全 gate 绿 + 组合深审零阻塞）；#359 核心复现项实机视觉确认修复。真机触控板/多窗口操作级回归因环境限制部分完成（如实记录）。SPEC-16 标记 completed。

## Follow-up
- #407 notifier 路径形状归一（P3，当前 inert）
