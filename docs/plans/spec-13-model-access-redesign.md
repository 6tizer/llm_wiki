# SPEC-13: 模型接入一站式重设计（Model Access Redesign）

> 类型：阶段 SPEC | 状态：draft / 待用户确认交互稿 | 依赖：SPEC-4-FIX（profile 基座）、SPEC-12（设置 IA） | 吸收：SPEC-4 剩余范围（PR3 capability probe / PR4 scheduler 全量接入）、#310（运行时任务族路由）、#312（迁移密钥 staleness）

## 背景与病根（2026-07-05 用户实测反馈）

现状是三层叠加没有粘合层：「LLM 模型」（legacy 单模型配置，streamChat 十余消费方直读）→「Model Profiles」（新体系，仅 agent/ingest 消费）→「任务分配矩阵」（纯 UI）。用户体验：同一个 key 填两遍、概念对不上、配错无反馈、「填不好还用不了」，连测试路径都不清晰。这是 SPEC-4 计划的 PR3/PR4 未完成 + #310 未做在 UX 上的总暴露。

## 借鉴来源（借设计不引依赖）

- **CC Switch**（farion1231/cc-switch）：预置供应商模板库——添加供应商从模板选，endpoint/认证方式/可用模型预填，用户只填 API key，点测试即用；失败自动切换下一家（其 proxy mode 思路，我们 profile 池已有等价物）。
- **LiteLLM**：用途别名层——用户面对「这个用途用哪个模型」的映射（含 fallback 链），供应商细节与用途分配解耦。
- 明确不做：不内嵌 LiteLLM proxy（Python 重依赖不适合 Tauri 桌面）；不做本地透传代理进程（应用层 claim/failover 已覆盖）。

## 目标交互：傻瓜式三步

> **① 选供应商**（模板库：Anthropic / OpenAI / DeepSeek / 智谱 / Kimi / OpenRouter / Ollama / 自定义……，endpoint、auth style、推荐模型全预填）
> **② 填 API Key**（钥匙串存储，现有 secret reference 机制）
> **③ 点「测试」**（capability probe：连通/模型列表/streaming/tool-use/agent-capable，绿灯即用）

完成后自动生成该连接的默认 Profile 并接管全部用途——**「LLM 模型」与「Model Profiles」两页对用户合并为一页「模型接入」**，legacy 概念从 UI 消失。高级面板（默认折叠）才暴露：用途分配矩阵（任务族 → 连接/模型 + fallback 链）、并发/容量、熔断参数。

成功标准：
- 新用户从零到可用 ≤ 3 步、≤ 2 分钟，全程无需理解 profile 概念。
- 每个连接有明确的测试反馈（分项通过/失败原因/修复建议）。
- 全部 streamChat 调用点迁移到 profile 池按任务族 claim（#310），legacy llmConfig 只读兼容一个版本周期后删除。
- Agent-capable 判定由 probe 结果驱动（替代现静态 apiMode 推断），SPEC-4 canonical fallback policy 不变（不静默降级）。

## 范围与 PR 拆分（设计确认后细化）

1. **PR1 供应商模板库 + 「模型接入」合并页骨架**：模板数据（内置 JSON，含 endpoint/auth/常用模型/是否 agent-capable 先验）；三步向导 UI；连接=profile 的 1:1 自动生成；旧两页入口合并（legacy 页保留只读入口一个周期）。
2. **PR2 capability probe**（SPEC-4 PR3 落地）：用户触发、缓存、退避节流（SPEC-4 已定原则照抄）；分项结果 UI（messages/streaming/tool-use/auth/agent headers）；probe 结果驱动 agent-capable 与矩阵可勾选性。
3. **PR3 调用点全量迁移**（#310）：chat 主流/synthesis/lint/dedup/deep-research/vision/embedding 等全部走 pool claim + legacy fallback；矩阵行全部「已接入」。
4. **PR4 legacy 退役 + 迁移收尾**：legacy「LLM 模型」只读化→删除；迁移向导升级为「导入旧配置」一次性入口（吸收 #312 staleness 提示）；embedding/multimodal 页降为矩阵行（SPEC-12 deferred 项）。
5. **Closeout**：e2e（三步向导真机）、深度 review、docs。

## 非目标

- 不替换 Claude Agent SDK；不把 provider 体系缩成 OpenAI vs Claude（SPEC-4 non-goals 继承）。
- 不做多用户/云同步配置。
- UI IA 二轮（侧栏右移、深研归并等）归 SPEC-14，不混入。

## 开放问题（交互稿需用户拍板）

1. 模板库首发覆盖哪些供应商（建议：Anthropic/OpenAI/DeepSeek/智谱/Kimi/Moonshot/OpenRouter/Ollama/LM Studio/自定义）。
2. 「测试」失败时是否允许「仍然启用」（建议：允许但标黄，agent 用途仍按 probe 结果禁用）。
3. fallback 链首发做不做（建议：PR3 顺带，UI 上每任务族一条有序列表）。
