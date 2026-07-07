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
- **验证方法本质说明（2026-07-06 确定性验收原则复盘）**：A2 五项验收标准（滚动物理只滚 pre、气泡不裁切、单击选中反馈、面板不残留、标题不竖排、resize 不破版）**本质是渲染层/交互层的像素与事件属性——不存在数据库/文件系统的确定性信号可查**（与 A1「全是运行时数据正确性」根本不同，A1 完美契合 DB 信号）。因此 A2 的可确定性验证部分与不可验证部分需分开如实记录：
  - **数据行为类修复**（#373 Create Page 逐 draft 防呆 / #378 lint 重扫接线 / #335 orphan 目录 scope + source-unlinked）：产生的是 review-store/lint 数据变化，由单 PR 单测（93+ 用例真实断言）+ 两个 closeout 组合深审零阻塞验证。
  - **纯渲染类修复**（#374 scroll chaining / #359 气泡裁切 / #375 面板布局）：**无任何 DB/FS 确定性信号**——由单 PR 的 class/渲染断言 + 组合深审 + #359 气泡的一次视觉抽查（已确认完整）验证；其运行时像素行为在 WKWebView 中不可用确定性信号复验，如实记录。
  - **溯源确定性**：装机 binary（本 session 从 main 构建，17:33 mtime）源自含全部 6 个 SPEC-16 squash 合并 commit 的 main（git log 确认 d3bd831d #373 / 1f8fd5f1 #374 / f8f089a8 #359 / 3cffddc1 #375 / a68cb608 #395），故 bundle 必然含修复。

## 结论

代码质量维度完全满足（全 gate 绿 + 组合深审零阻塞）；#359 核心复现项实机视觉确认修复；装机溯源确定性确认 bundle 含全部修复。**A2 验收标准的纯渲染部分无 DB 确定性信号可查（区别于 A1）——由单测 + 组合深审 + 溯源覆盖，如实记录不假报**。SPEC-16 标记 completed。

## Follow-up
- ~~#407 notifier 路径形状归一（P3，当前 inert）~~ → **已交付（#411，2026-07-07）**：notifier 边界归一 paths 为 wiki 根相对（去 `wiki/` 前缀）+ permission-dialog useCountdown 复用。
