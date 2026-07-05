# SPEC-13: 模型接入一站式重设计（Model Access Redesign）

> 类型：阶段 SPEC | 状态：**设计已拍板（2026-07-05 用户三项裁定）/ ready for PR split** | 依赖：SPEC-4 + SPEC-4-FIX（probe/pool/agent-adapter 基座，全部已交付）、SPEC-12（设置 IA） | 吸收：#310（运行时任务族路由 + legacy 退役）、#312（迁移密钥 staleness）

## 背景与病根（2026-07-05 用户实测反馈）

现状是三层叠加没有粘合层：「LLM 模型」（legacy 单模型配置，streamChat 十余消费方直读）→「Model Profiles」（新体系，仅 agent/ingest 消费）→「任务分配矩阵」（纯 UI）。用户体验：同一个 key 填两遍、概念对不上、配错无反馈、「填不好还用不了」，连测试路径都不清晰。

**机器基座并不缺**：SPEC-4 PR1-PR5 + SPEC-4-FIX 已交付 capability probe（cache/backoff/probe UI）、profile pool（claims/并发/熔断）、agent-run adapter。缺的是**用户层的粘合**——probe 埋在 Profiles 编辑深处而非「添加即测试」主动线；建 profile 要手填 endpoint/auth 而无模板；legacy 与 profile 双轨并存（#310 未做）导致概念翻倍。SPEC-13 是 UX 重设计 + 调用点收敛，不重造引擎。

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

1. **PR1 供应商模板库 + 三步向导**：模板数据文件（分组/endpoint/auth 字段/apiKeyUrl/endpointCandidates/默认模型映射/agent 先验，取代并扩展现有 LLM_PRESETS）；三步向导 UI（选模板→填 Key（profile-secrets 钥匙串）→测试）；完成自动 runtimeProfileCreate 生成默认 profile 并按 agent 先验设 task families。
2. **PR2 测试三色 + 卡片健康徽章**：probe 冒烟化（连通/key/模型/TTFB）、三色结果卡与修复建议、卡片常显徽章；agent 勾选性=模板先验 ∧ 冒烟（自定义端点走完整探测）。
3. **PR3 调用点全量迁移 + fallback 面板**（#310）：全部 streamChat 消费方走 pool claim；每任务族有序 fallback 队列 UI + 自动转移开关 + 熔断参数面板 + 转移事件日志/timeline 披露。
4. **PR4 legacy 退役 + 迁移收尾**：legacy「LLM 模型」只读化→删除；迁移向导升级为「导入旧配置」一次性入口（吸收 #312 staleness 提示）；embedding/multimodal 页降为矩阵行（SPEC-12 deferred 项）。
5. **Closeout**：e2e（三步向导真机）、深度 review、docs。

## 非目标

- 不替换 Claude Agent SDK；不把 provider 体系缩成 OpenAI vs Claude（SPEC-4 non-goals 继承）。
- 不做多用户/云同步配置。
- UI IA 二轮（侧栏右移、深研归并等）归 SPEC-14，不混入。

## 已拍板设计（2026-07-05 用户裁定 ×3）

### 1. 供应商模板库 v1（CC Switch official/cn_official/cloud ∪ LLM Wiki 现有，全量进首发）

| 分组 | 供应商 | agent 支持先验 |
|------|--------|----------------|
| 国际官方 | Anthropic、OpenAI、Google Gemini | Anthropic=native；OpenAI/Google=model-call only（无 Anthropic 兼容端点，无本地格式转换代理——与 CC Switch 的差异见下） |
| 国产官方 | DeepSeek、智谱 GLM、Kimi（月之暗面）、MiniMax、阿里百炼、字节火山方舟、百度千帆、阶跃 StepFun、美团 LongCat、蚂蚁百灵、小米 MiMo、快手 KAT-Coder | 均有 /anthropic 兼容端点（这正是它们进 CC Switch Claude 预设的原因）→ agent-capable=true 先验 + env 映射照抄 |
| 云厂商 | AWS Bedrock、Azure OpenAI | Bedrock=agent via CLAUDE_CODE_USE_BEDROCK env 族；Azure=model-call only |
| 本地 | Ollama、LM Studio | model-call only（首发） |
| 网关 | OpenRouter、NewAPI/自定义网关、完全自定义 | anthropic-compat 端点则 agent 可用，由冒烟测试判定 |

**照抄 CC Switch 的字段**：apiKeyUrl（「去拿 Key」直达链接）、endpointCandidates（多端点候选+测速）、默认模型三档映射（haiku/sonnet/opus alias——正好对上 SPEC-4-FIX PR3 的 SDK model alias 机制）、apiKeyField（AUTH_TOKEN vs API_KEY 差异）、icon/主题。
**必须调整的**：①CC Switch 靠本地转换代理支持 apiFormat≠anthropic（openai_chat/gemini_native 等），我们不建转换代理——此类供应商在我们这里走现有 streamChat 多协议层做 model-call，agent 用途不开放；②requiresOAuth 类（GitHub Copilot/Codex 反代）首发不做；③CC Switch 写配置文件+重启生效，我们是 per-run env 注入（SPEC-4 PR5 adapter 已交付），无接管/重启概念；④返佣类 aggregator/third_party 预设不进模板库。

### 2. 测试三色语义（照抄 Stream Check），agent 能力由模板先验决定

- 测试=真实小请求（廉价模型 + max_tokens 限制 + 流式测 TTFB），结果三色：🟢健康 / 🟡降级（延迟超阈值但可用）/ 🔴不可用。**测试失败不拦截启用**（CC Switch 手册明示假阴性存在），真正守门的是运行时熔断（池已有）。
- **agent 能力判定从「运行时探测猜测」换轨为「模板先验 ∧ 冒烟通过」**：模板里 anthropic-compat 端点的供应商 agent-capable 天然成立，probe 只做冒烟（连通/key 有效/模型存在），不再做易假阴的 tool-use 全量探测——这直接消解了「agent 工具调用能力探测不过」的易用性痛点（用户裁定 #2）。仅完全自定义端点保留完整探测路径。SPEC-4「不静默降级工具能力」红线不变：agent 不可用时禁用+给原因+修复入口。
- 现有 runtimeProfileProbe/ProbeDraft API 复用，三色为结果展示层新语义。

### 3. Fallback 可观测/可配置（照抄 CC Switch 故障转移面板）

- 每任务族**有序 fallback 队列**（拖拽排序）+「自动转移」总开关（关=只记录不切换）。
- 熔断参数暴露在高级面板（失败阈值/恢复等待/错误率阈值——池已有实现，补 UI）。
- **每次转移记录**：runtime 事件日志（时间/原 profile/新 profile/失败原因）+ 对话 timeline 状态行（复用 profile_resolved.requestedProfileId 披露机制）。
- 供应商卡片三色健康徽章常显。

## 开放问题（已全部裁定，留档原文）

1. 模板库首发覆盖哪些供应商（建议：Anthropic/OpenAI/DeepSeek/智谱/Kimi/Moonshot/OpenRouter/Ollama/LM Studio/自定义）。
2. 「测试」失败时是否允许「仍然启用」（建议：允许但标黄，agent 用途仍按 probe 结果禁用）。
3. fallback 链首发做不做（建议：PR3 顺带，UI 上每任务族一条有序列表）。
