# SPEC-1 到 SPEC-4 完成后集成测试问题记录

> 日期：2026-07-01
> 状态：evidence / consumed by SPEC-4-FIX and SPEC-5/6/7/8 updates
> 范围：SPEC-1 shell/core boundary、SPEC-2 work runtime、SPEC-3 markdown commit layer、SPEC-4 model profiles 合并后的 Dev App 手测
> 原则：本文件只记录问题、证据和修复方案；暂不修改业务代码。

## 消化路由

- 问题 1、2、3 的 SPEC-4 基座缺口由 `spec-4-fix-model-profiles-closeout.md` 承接。
- 问题 4 的对话内 profile / permission 控制面由 `spec-7-unified-agentic-chat.md` 承接。
- 问题 5 的 Runtime / Commit / Scheduler 可观察性回灌到 SPEC-5、SPEC-6、SPEC-7、SPEC-8，不新增独立 Diagnostics SPEC。
- 问题 6 的 Settings 本地扩展归属由 SPEC-4-FIX Settings/Profile IA PR 承接。
- 问题 7 的补充测试清单作为后续触碰 SPEC-1 到 SPEC-4 范围时的验收检查输入。

## 测试环境

- App：`[DEV] LLM Wiki Agent`
- Work Runtime：已用 `LLM_WIKI_CORE_WORK_RUNTIME_ENABLED=true pnpm tauri dev` 启动。
- 测试项目：`/Users/mac-mini/wiki-migration/NotionDB导出/test`
- Runtime DB：`/Users/mac-mini/wiki-migration/NotionDB导出/test/.llm-wiki/runtime/runtime.db`

## 发现的问题

### 1. Model Profiles 只能创建/编辑，不能删除

现象：

- Settings > LLM 模型 > Model Profiles 可以新建、保存、探测、清除密钥。
- Profile 列表中没有删除入口。
- 手测中重复创建 DeepSeek profile 后无法从 UI 清理。

代码证据：

- `src/components/settings/sections/model-profiles-section.tsx` 只有 `saveProfileDraft`、`runtimeProfileCreate`、`runtimeProfileUpdate`、`runtimeProfileProbe` 和 secret clear UI。
- `src/commands/runtime-db.ts` 暴露 `runtimeProfileCreate`、`runtimeProfileUpdate`、`runtimeProfileList`、`runtimeProfileStatus`、`runtimeProfileProbe`、profile pool API；没有 `runtimeProfileDelete`。
- `src-tauri/src/lib.rs` 注册了 `runtime_profile_create/list/update/status/probe/pool_*`；没有 `runtime_profile_delete`。
- `profile_secret_delete` 只删除 Keychain secret，不删除 profile record。

根因：

- SPEC-4 PR2 实现了 create/edit/test/secret boundary，但没有补 profile 删除 contract。
- Runtime schema 中 `runtime_profile_claims`、`runtime_profile_circuit_breakers` 通过 FK 引用 `runtime_model_profiles(profile_id)`；删除语义需要先定义好 active claim、历史 claim、secret 清理的处理规则。

建议修复：

- 新增 `runtime_profile_delete` shell-neutral command：
  - request：`{ profileId: string }`；
  - 删除前读取 profile，拿到 `secretRef`；
  - 先 expire stale claims；
  - 如果有 active claim，返回 `profile-delete-blocked: active profile claim exists`；
  - 推荐做 soft delete：给 `runtime_model_profiles` 增加 `deleted_at_ms` 或 `status`，list/pool 默认过滤 deleted，保留 claim 历史；
  - 如果选择 hard delete，必须先清理 circuit breaker 和非 active claims，并明确接受历史 claim 丢失。
- 前端新增 Delete profile 按钮：
  - destructive 二次确认；
  - DB 删除成功后再 best-effort 删除对应 `secretRef`；
  - 删除失败时不得删除 secret；
  - 删除当前选中 profile 后选中下一个可见 profile 或空 draft。
- 测试：
  - Rust：active claim 阻止删除；deleted profile 不再 list/pool claim；secret ref 不从 command 返回；
  - TS/UI：点击删除后列表移除；删除失败不调用 `profileSecretDelete`；删除后选中态稳定。

### 2. Model Profiles 信息架构位置不对

现象：

- Model Profiles 现在放在 Settings > LLM 模型页面底部。
- 用户期望 Profile 和 LLM 模型是同级设置项，而不是 LLM 模型下面的子区块。
- 衍生问题：LLM 模型页文案表达的是“每次只能有一个当前活跃 provider”，容易让人误解为系统只能支持一种 LLM；但 runtime profile 的目标是同时支持多条可调度模型记录。

代码证据：

- `src/components/settings/sections/llm-provider-section.tsx` 直接 import 并渲染 `<ModelProfilesSection />`。
- `src/components/settings/settings-view.tsx` 的 `CategoryId` / `CATEGORIES` 只有 `llm`，没有独立 `model-profiles` category。
- GitNexus context 显示 `ModelProfilesSection` 的唯一生产调用方是 `LlmProviderSection`。

根因：

- SPEC-4 PR2 为了快速接入 Settings，把 profiles 作为 LLM provider section 的下半部分实现。
- 但产品模型上，LLM provider preset 和 runtime profile 是两个同级概念：前者是全局/legacy provider 配置，后者是 runtime scheduler 可调度记录。
- 当前代码也印证了这个分层：
  - `LlmProviderSection` 使用 `activePresetId` + `llmConfig`，同一时间只有一个 legacy active provider；
  - 多数旧 model-call 入口仍直接读 `llmConfig`；
  - runtime DB 已支持多条 `model-call` / `agent-run` profile 和 pool claim，但并非所有业务流都迁移到 profile pool。

建议修复：

- 新增 Settings category：`model-profiles` / `Model Profiles` / `模型 Profiles`。
- 从 `LlmProviderSection` 移除 `<ModelProfilesSection />`。
- 在 `settings-view.tsx` switch 中为 `model-profiles` 返回 `<ModelProfilesSection />`。
- i18n 增加 `settings.categories.modelProfiles`，中文建议“模型 Profiles”或“Model Profiles”保持术语一致。
- 调整 LLM 模型页语义：
  - 该页应定位为“供应商配置 / legacy default provider”，不是全部模型能力中心；
  - 可以保留一个“默认 provider”用于旧路径和 fallback，但不应暗示只能支持一种 LLM；
  - 已配置且测试通过的供应商，可以被创建为一条或多条 runtime profiles。
- 明确 runtime profile 的可用条件：
  - `enabled=true`；
  - `kind` 匹配调用类型：`model-call` 或 `agent-run`；
  - `taskFamilies` 覆盖具体任务；
  - capability probe fresh 且对应能力通过；
  - 具体业务流已经接入 profile pool 或显式 profile selector。
- 测试：
  - `settings-view.test.ts` 覆盖新 category 可渲染；
  - `llm-provider-section.test.tsx` 更新为不再包含 profile entry；
  - i18n parity。

### 3. Agent 对话仍失败：Claude Agent SDK 模型/网关兼容问题

现象：

- Agent 对话中先出现“没有可用的 Agent-run Profile”。
- 创建/探测 profile 后，错误变成：
  - `There's an issue with the selected model (deepseek-v4-flash). It may not exist or you may not have access to it. Run --model to pick a different model.`
- 用户反馈之前使用小米 MIMO 模型时 Agent 能力可用。
- 这不是单纯的“没有 profile”问题：第二类错误发生在 profile 已被 claim、sidecar 已启动之后，由 Claude Agent SDK / Claude Code 返回。

运行时证据：

Runtime DB 当前存在多个 agent-run profile：

```text
DeepSeek / deepseek-v4-flash / https://api.deepseek.com/anthropic / agentRunSupported=1
小米 MiMo (Xiaomi) / mimo-v2.5-pro / https://token-plan-sgp.xiaomimimo.com/anthropic / agentRunSupported=1
```

Dev 日志显示实际 Agent spawn 两次都 claim 到 DeepSeek：

```text
[agent_spawn] model=Some("deepseek-v4-flash"), base_url=Some("https://api.deepseek.com/anthropic")
[agent-sidecar stderr] Claude Code returned an error result:
There's an issue with the selected model (deepseek-v4-flash).
```

历史证据：

- README 仍记录 Agent sidecar 通过 `baseUrl` 透传可支持 Anthropic、OpenRouter、LiteLLM、Bedrock 等 Messages API 兼容后端。
- `docs/plans/archive/agent-sidecar-phase1.md` 记录 Phase 1 验证时：
  - LiteLLM proxy 在 `localhost:4000` 正常运行；
  - sidecar 手动测试通过；
  - dev app 点击 "Test Agent" 端到端通过。
- 早期 sidecar 协议测试使用：
  - `baseUrl: "http://localhost:4000"`；
  - `model: "claude-sonnet-4-20250514"`。
- 本地 `litellm/config.yaml` 已确认存在映射：
  - `claude-sonnet-4-20250514` -> `anthropic/mimo-v2.5-pro`；
  - `claude-sonnet-4-6` -> `anthropic/mimo-v2.5-pro`；
  - `api_base` 指向 Xiaomi MiMo Token Plan Anthropic gateway；
  - 该目录被 `.gitignore` 忽略，不在 Git 跟踪中。
- 也就是说，之前可用链路是“Claude Agent SDK + LiteLLM/兼容网关 + Claude alias 模型名 -> MIMO 后端模型”，不是“Claude Agent SDK 直接传 provider 原生模型名”。
- 当前本机没有发现 LiteLLM 进程，也没有 `:4000` 监听。
- 注意：本地 `litellm/config.yaml` 当前含明文 `api_key`。文档和 PR 不记录密钥值；后续应迁到 Keychain/env，并保留无密钥 example config。
- 外部调研补充：
  - MiMo、DeepSeek、Kimi 都提供了面向 Claude Code 的官方接入文档；
  - 这类供应商已经暴露 Anthropic-compatible endpoint 时，LiteLLM 不是强依赖；
  - 关键是 App 必须按 Claude Code / Agent SDK 预期注入正确 env，例如 `ANTHROPIC_BASE_URL`、`ANTHROPIC_AUTH_TOKEN`、`ANTHROPIC_MODEL`、`ANTHROPIC_DEFAULT_*_MODEL`，而不是只传一个 `model` 和 `ANTHROPIC_API_KEY`。

代码证据：

- `runtime_profile_pool_claim_for_project` 读取 profiles 后筛 eligible，再调用 `select_profile_pool_candidate`。
- `read_profiles` 排序为 `ORDER BY updated_at_ms ASC, profile_id ASC`。
- 没有 `preferredProfileIds` 时，`select_profile_pool_candidate` 返回 `eligible.first()`，因此旧的 DeepSeek profile 抢先被选中。
- `RuntimeProfilePoolClaimRequest` 已支持 `preferredProfileIds`。
- `claimAgentProfileForRun` 已支持 `options.agentProfileId` 并会转为 `preferredProfileIds: [options.agentProfileId]`。
- `buildAgentTransportOptionsFromState` 当前没有从 UI/state 填 `agentProfileId`。
- Agent footer 当前展示的是 `llmConfig.model`，不是实际 claim 到的 runtime profile，容易误导。
- `apply_agent_profile_config` 把 runtime profile 的 `config.model_id` 直接写入 Agent args 的 `model`。
- `src-tauri/sidecar/src/core.ts` 把 `apiKey` / `baseUrl` 写到 `ANTHROPIC_API_KEY` / `ANTHROPIC_BASE_URL`，同时把 `req.options.model` 原样传给 Claude Agent SDK。
- Claude Code env 语义中，`ANTHROPIC_API_KEY` 是 `X-Api-Key`，`ANTHROPIC_AUTH_TOKEN` 才是 `Authorization: Bearer`；当前 Agent sidecar 没有根据 profile `authStyle` 区分这两者。
- `src/lib/llm-providers.ts` 对 Xiaomi MiMo Token Plan Anthropic wire 做过专门适配，例如 Bearer auth；但 Agent sidecar 不走这套 `llm-providers.ts` model-call adapter。

根因：

- SPEC-4 PR5 将 profile pool 接入 Agent sidecar 时，默认把 provider profile 的原生 `model_id` 直接传给 Claude Agent SDK。
- Claude Agent SDK / Claude Code 对 `model` 参数有自己的兼容边界。历史可用路径依赖 LiteLLM/兼容网关把 Claude alias 映射到 MIMO 后端，而不是直接传 `mimo-v2.5-pro` 或 `deepseek-v4-flash`。
- 当前 Dev App 未启动 LiteLLM，且 runtime profile 直连 provider，因此原来的 alias bridge 没有参与 Agent run。
- 对已支持 Claude Code 的 Anthropic-compatible 供应商，当前更直接的问题是 sidecar profile config 不完整：
  - 未把 bearer auth 映射到 `ANTHROPIC_AUTH_TOKEN`；
  - 未设置 `ANTHROPIC_MODEL` / `ANTHROPIC_DEFAULT_*_MODEL`；
  - 未支持 provider-specific env，例如 DeepSeek 的 `CLAUDE_CODE_SUBAGENT_MODEL` / `CLAUDE_CODE_EFFORT_LEVEL`、Kimi 的 `CLAUDE_CODE_AUTO_COMPACT_WINDOW`。
- Capability probe 目前偏向“Messages API endpoint 可用”，不等价于“Claude Agent SDK 可以用该 `model + baseUrl` 正常 start/run”。
- Profile 自动选择 DeepSeek 是相关问题，会让用户更容易撞到错误；但它不是截图中第二类英文错误的唯一根因。

建议修复：

- 优先支持直连 Anthropic-compatible provider：
  - `authStyle=bearer` -> `ANTHROPIC_AUTH_TOKEN`；
  - `authStyle=x-api-key` / official Anthropic -> `ANTHROPIC_API_KEY`；
  - `endpoint` -> `ANTHROPIC_BASE_URL`；
  - `agentSdkModelId` -> `model` option + `ANTHROPIC_MODEL`；
  - 可选设置 `ANTHROPIC_DEFAULT_OPUS_MODEL`、`ANTHROPIC_DEFAULT_SONNET_MODEL`、`ANTHROPIC_DEFAULT_HAIKU_MODEL`、`CLAUDE_CODE_SUBAGENT_MODEL`、context / effort 相关 env。
- 先恢复可验证的本地桥接路径：
  - 提供无密钥 `litellm/config.example.yaml`；
  - `api_key` 从 Keychain/env 注入，不写入 repo、docs、PR；
  - 增加本地启动说明或脚本：启动 LiteLLM on `localhost:4000`，再启动 Dev App；
  - Agent-run profile 可配置为 `baseUrl=http://localhost:4000`，`agentSdkModelId=claude-sonnet-4-20250514`，由 LiteLLM 映射到 MIMO。
- 引入 Agent SDK 兼容层，避免把 provider 原生模型名盲传给 Claude Agent SDK：
  - 在 profile schema / config 中区分 `providerModelId` 和 `agentSdkModelId`；
  - 对 LiteLLM/OpenRouter/Bedrock/Token Plan 这类网关，允许 `agentSdkModelId` 使用 Claude Agent SDK 可接受的 alias；
  - 若继续使用 LiteLLM 支持 MIMO，应恢复明确的网关 contract：`ANTHROPIC_BASE_URL=http://localhost:4000` 或等价网关，`model` 使用网关可识别且 SDK 可接受的 Claude alias，再由网关映射到 `mimo-v2.5-pro`。
- LiteLLM 定位为可选网关：
  - 推荐用于 OpenAI/Gemini/本地模型等非 Anthropic Messages provider；
  - 推荐用于统一鉴权、预算、限额、fallback、usage tracking、模型列表治理；
  - 不应作为 MiMo/DeepSeek/Kimi 这类已支持 Claude Code 供应商的唯一方案。
- 重做 Agent-run capability 判断：
  - 现有 HTTP `/messages` probe 只能标记 endpoint/wire 可用；
  - 需要新增用户触发的 "Agent SDK test"，实际通过 sidecar 用 `model + baseUrl + auth` 跑一次最小 query；
  - 探测结果要区分 `messages-compatible`、`agent-sdk-compatible`、`sdk-model-rejected`、`gateway-auth-failed`。
- 将 sidecar 返回的 SDK model error 写回 profile diagnostic / circuit breaker：
  - 同一 profile 连续 SDK model rejected 后，短期退出 pool；
  - UI 显示“SDK 不接受该模型名/网关映射”，不要继续提示“没有 profile”。
- 在 Agent 对话区域增加 Agent-run Profile selector：
  - 列出 `kind=agent-run`、enabled、taskFamilies 含 `agent`、fresh `profile-probe.v1`、`agentRunSupported=true` 的 profiles；
  - 显示 display name、provider、model、capability status；
  - 默认选中最近一次成功/用户选择的 profile；没有选择时允许 fallback 但必须显示实际将使用的 profile；
  - 选择后写入 ChatPanel/ChatStore，并传给 `buildAgentTransportOptionsFromState`。
- 扩展 `buildAgentTransportOptionsFromState`：
  - 增加入参 `agentProfileId?: string`；
  - 返回 `agentProfileId`，让 `claimAgentProfileForRun` 走 `preferredProfileIds`。
- Agent footer 改成显示实际 profile：
  - 不再只显示 `llmConfig.model`；
  - runtime enabled 时显示 selected profile / claimed profile；
  - legacy fallback 时才显示 legacy `llmConfig.model`。

测试：

- Sidecar/profile integration test：profile 可配置 `agentSdkModelId`，传给 SDK 的是 SDK alias，不是 provider 原生模型名。
- Agent SDK preflight test：区分 HTTP probe pass 但 SDK model rejected 的情况。
- `agent-transport-options.test.ts`：selected profile id 会进入 `AgentTransportOptions.agentProfileId`。
- `agent-transport.test.ts`：`agentProfileId` 被转成 `preferredProfileIds`。
- Chat UI test：Agent mode 能看到 profile selector，选择 MIMO 后发送使用 MIMO profile id。
- Rust profile pool test 可补一例：无 preferred 时仍保持现状；有 preferred 时优先 preferred 且跳过 ineligible preferred。

### 4. Agent 对话中不能切换 profile/model，权限也不能切换

现象：

- Agent 对话底部只显示：
  - `模型: deepseek-v4-flash`
  - `权限: 默认`
- 没有 profile/model 下拉。
- 没有 permission policy 下拉。

代码证据：

- `src/components/chat/chat-panel.tsx` footer 中权限文本硬编码为 `t("agent.config.defaultPolicy")`。
- `src/components/chat/agent-transport-options.ts` 中 `permissionPolicy: "default"` 硬编码。
- `AgentTransportOptions` / sidecar 已支持 `permissionPolicy`。
- `src-tauri/sidecar/src/agent-policy.ts` 已支持 `default`、`restricted`、`bypass`、`acceptEdits`、`bypassPermissions` 等策略。
- `src/components/chat/chat-input.tsx` 只有 Chat Agent route selector：`fast`、`standard`、`deep`、`local_first`；这不是 Agent-run runtime profile/model selector。

根因：

- SPEC-4 接了 profile pool，但 SPEC-7 Unified Agentic Chat 的对话内控制面还没做。
- Agent runtime 的能力已经能接收 profile id 和 permission policy，但 UI/state 仍没有表达这些选择。

建议修复：

- 在 Agent mode toolbar 中增加两个控件：
  - Profile selector：选择 Agent-run profile；
  - Permission policy selector：至少暴露 `default`、`restricted`、`acceptEdits`，`bypass/bypassPermissions` 需要危险提示或二次确认。
- 将选择保存到 conversation-level state：
  - 新 conversation 继承最近一次选择；
  - 旧 conversation resume 时继续使用它自己的 profile/policy，避免 session 中途换模型导致不可预期；
  - streaming 中禁用切换。
- `buildAgentTransportOptionsFromState` 接受并传出：
  - `agentProfileId`;
  - `permissionPolicy`;
  - 可选：如果未来支持 model-call profile，则增加 `modelProfileId`，但本轮先聚焦 Agent-run。
- footer 展示真实配置：
  - `Profile: <displayName> / <modelId>`;
  - `Permission: <policy>`;
  - runtime unavailable 时显示 fallback/不可用原因。
- 测试：
  - Chat UI selector render / disabled during streaming；
  - selected permission policy 进入 `streamAgent` options；
  - selected profile id 进入 `streamAgent` options；
  - i18n parity。

### 5. Runtime / Commit / Scheduler 缺少清晰测试观察入口

现象：

- 手测时很难从 UI 直接找到以下能力的测试观察位置：
  - Runtime Jobs UI；
  - Markdown Commit Layer；
  - Profile Pool / Scheduler 行为。
- Runtime Jobs 不是独立主导航或 Settings 页，而是隐藏在底部 Activity Panel 中；只有有 runtime job、queue、file sync 或 activity 时才出现。
- Markdown Commit Layer 和 Profile Pool / Scheduler 目前主要是 backend/runtime command 能力，没有专门的 inspector / diagnostics UI。

代码证据：

- Runtime Jobs UI：
  - `src/components/layout/activity-panel.tsx` import 并渲染 `<RuntimeJobsSection state={runtimeJobs} />`；
  - `ActivityPanel` 在 `!hasItems && !hasQueue && !hasFileSync && !hasRuntime` 时直接 `return null`；
  - `src/components/layout/runtime-jobs-section.tsx` 只展示 job 列表、pause/resume/cancel，不负责创建测试 job 或展示 commit/profile pool 细节。
- Markdown Commit Layer：
  - `src/commands/runtime-db.ts` 暴露 `runtime_commit_budget_claim/release`、`runtime_staging_artifact_*`、`runtime_event_append`、`runtime_derived_stale_marker_*`；
  - 搜索结果未发现对应 React inspector 页面；
  - 当前主要通过 SPEC-3 command/API/tests 验证。
- Profile Pool / Scheduler：
  - `src/commands/runtime-db.ts` 暴露 `runtimeProfilePoolClaim/release/renew/list`；
  - Settings > Model Profiles 可以创建/探测 profile，但没有展示 active claims、circuit breakers、capacity、retry-after 的专门观察面板。

根因：

- SPEC-2/3/4 先完成 runtime/backend contract 和最小 UI 状态展示，未提供完整 Dev/QA inspector。
- Runtime Jobs 的入口是“有事才出现”的 activity footer，不适合做 SPEC 完成后的主动手测入口。
- Commit layer 和 profile scheduler 是底层平台能力，缺少面向开发/QA 的显式可观察性。

建议修复：

- 增加 Dev/Diagnostics 观察入口，建议放在 Settings > 维护 或独立 “Runtime Diagnostics”：
  - Runtime Jobs：展示 jobs、leases、events、pause/resume/cancel；
  - Commit Layer：展示 active commit budget claims、staging artifacts、derived stale markers、recent runtime events；
  - Profile Pool：展示 profiles、active claims、circuit breakers、capacity、retry-after/backoff、claim/release recent events。
- 提供 dev-only 测试动作：
  - create mock runtime job；
  - create/release commit budget claim；
  - record/list staging artifact；
  - list profile pool state；
  - 不默认写真实 wiki Markdown。
- SPEC-5 PR1 规划时必须明确：
  - 批量 pipeline 运行时用户如何看到 job DAG、worker profile assignment、progress/ETA；
  - Activity Panel 是否足够，还是需要 dedicated runtime panel。
- SPEC-7 timeline 规划时必须明确：
  - Agent run 与 runtime job/profile claim 的对应关系如何显示；
  - 用户如何区分 Agent stream、runtime job、profile claim、commit event。

测试：

- UI test：无 job 时入口可发现或 diagnostics 可打开；有 job 时 Activity Panel 显示 Runtime Jobs。
- Runtime diagnostics test：mock command 数据能展示 jobs/claims/artifacts/markers。
- i18n parity。

### 6. Settings 中存在非上游业务层配置，产品归属不清

现象：

- Settings 中出现以下上游原版 LLM Wiki 没有的本地扩展项：
  - Knowledge Agents；
  - 标签体系；
  - 综合；
  - 通用。
- 这些项本身有业务来源，但在 Settings 信息架构中没有明确标记“本 fork / Knowledge Wiki / OKF/KW 扩展”，容易被误判为 upstream 残留或同步异常。

代码/文档证据：

- `src/components/settings/settings-view.tsx` 的 `CATEGORIES` 包含：
  - `knowledge-agents`；
  - `taxonomy`；
  - `synthesis`；
  - `general`。
- `docs/plans/README.md` 记录 OKF/KW 基线已完成：
  - `95e4bb9` KW-B1：Knowledge Agents 配置基座 + Settings 骨架；
  - `127fc9e` KW-C1：三层标签体系 schema + bootstrap/growth 基座；
  - `3a01730` KW-D：Synthesis 多维主题发现 + preview/generate UI；
  - `248bd27` OKF-C：统一 Agent tools + MCP/local API 暴露。
- `docs/plans/archive/knowledge-wiki-business-layer.md` 说明这些属于 OKF 之上的 Knowledge Wiki business-layer，不是 upstream 原版设置项。
- `general` 是平台级偏好页，目前 `getSettingsCategories()` 在非 Mac-like 环境会过滤，但 Mac dev app 中显示。

根因：

- Phase 6 / OKF-KW stream 已把本地业务层入口合入 Settings，但后续并行 runtime 主线没有重新整理 Settings IA。
- 当前 Settings 把 upstream-ish provider/source/API 配置、本 fork Knowledge Wiki 扩展、平台偏好混在同一平级列表里。

建议修复：

- Settings 信息架构重排时，给本地扩展项明确分组：
  - Provider / Runtime：LLM provider、Model Profiles、Embedding、Agent、Runtime Diagnostics；
  - Knowledge Wiki：Knowledge Agents、标签体系、综合、输出偏好；
  - System：网络、API + MCP、通用、界面、维护、更新日志、关于。
- 或者增加 section header / badge，标明 “Knowledge Wiki 扩展”。
- 对 upstream sync 相关 PR，继续按 `upstream-0.5-delta.md` 做 delta 复核，不能把这些本地扩展误删或误判为冲突。
- 如果产品定位决定暂时弱化这些扩展，应通过 feature flag 或折叠分组处理，不应直接删除已完成 OKF/KW 数据路径。

测试：

- Settings category render test：本地扩展项仍可访问。
- i18n parity。
- upstream-delta checklist：触碰 Settings 时必须记录是否影响 OKF/KW entries。

### 7. SPEC-1 到 SPEC-4 漏测 / 补充测试清单

现状：

- 前 6 个问题主要来自 Settings、Agent 对话和可观察性手测。
- 对照 SPEC-1 到 SPEC-4 的成功标准后，仍有若干关键能力没有被前面的测试建议覆盖。

补充测试项：

#### SPEC-1：Shell/Core Boundary 与 Store Boundary

- App 启动 / 项目切换：
  - 启动后自动恢复 last project；
  - 切换项目后 runtime DB、profiles、source watch、scheduled import、output language 不串项目；
  - 关闭再打开后 Settings 状态、active view、recent projects 正常。
- Work Runtime feature flag：
  - 不带 `LLM_WIKI_CORE_WORK_RUNTIME_ENABLED=true` 启动时，旧路径仍可打开项目、普通 chat/ingest 不崩；
  - runtime-only UI 给出 disabled/no-project 状态，而不是隐式创建 DB 或报错刷屏。
- Store/secret boundary：
  - 新 profile secret 不出现在 `runtime.db`、项目文件、日志、PR 文档；
  - `app-state.json` 中仍存在的 legacy secret-bearing settings 要被识别为待迁移/兼容风险；
  - Rust 读取的 locked keys（language、proxy、apiConfig、recentProjects、embedding/sourceWatch 等）在 Settings 保存后仍兼容。
- Headless contract：
  - Core Runtime command wrappers 可以在 mock shell/headless test 下工作；
  - 新 runtime/profile/commit 能力不得新增 React/Zustand/Tauri plugin-store 依赖到 core 模块。

#### SPEC-2：Work Runtime / DB

- Runtime 状态矩阵：
  - disabled；
  - no-project；
  - healthy；
  - damaged runtime DB。
- Job lifecycle：
  - queued / running / paused / retry-wait / failed / completed / cancelled 都能被 UI 或 diagnostics 观察；
  - pause running 会释放 active lease，旧 worker result 不得落回成功；
  - resume paused 回到 queued；
  - cancel 非终态 job 后不可继续执行。
- 重启恢复：
  - app 重启后 pending/running/stale lease 状态可恢复或过期；
  - retry/backoff 不因重启丢失；
  - Activity/Diagnostics 能显示重启后的真实状态。
- DB 边界：
  - SQLite 不保存大段 LLM 输出 blob；
  - staging artifact 在磁盘，DB 只保存 path/hash/status/metadata；
  - failed/cancelled artifact TTL GC 可触发并可观察。
- 并发/单写：
  - 多 worker claim 同一 job 不重复执行；
  - 高频 progress/heartbeat 不刷爆事件表。

#### SPEC-3：Markdown Commit Layer

- Normal ingest 行为：
  - 新空项目或普通 ingest 不再强制生成/覆盖 `wiki/index.md` / `wiki/overview.md`；
  - 旧项目已有 `index.md` / `overview.md` 不被删除、不被自动覆盖。
- Commit operation：
  - create / update / append / delete happy path；
  - same-path serial write；
  - base hash mismatch 进入 conflict，不 silent overwrite；
  - append newline join 规则稳定；
  - delete missing 的 skipped 语义稳定。
- Repair/event/marker：
  - conflict 会创建 review/repair job 或明确可观察的 conflict 结果；
  - commit event 记录 artifact hash、base hash、result、affected paths；
  - commit 成功后写 derived stale marker；
  - SPEC-6 消费前，marker 处于 pending 且可 list。
- Staging artifact lifecycle：
  - committed/merged 后 cleanup；
  - conflicted/rejected/skipped 不误删 repair evidence；
  - failed/cancelled 到 TTL 后 GC。

#### SPEC-4：Model Profiles / Scheduler

- Profile secret/storage：
  - create/update/profile probe 不返回真实 secret；
  - 清除 secret 后 profile 状态和错误文案正确；
  - profile 复制/重复创建不会导致不可清理状态。
- Capability probe：
  - success / messages-only / streaming fail / tool-use fail / auth fail；
  - endpoint/model/auth/secretRef 改动后 cache invalid；
  - backoff 生效，force retest 可绕过；
  - HTTP `/messages` probe 与 Agent SDK preflight 结果分开展示。
- Scheduler/profile pool：
  - enabled、taskFamilies、kind、capability freshness 决定 eligibility；
  - maxConcurrency 生效；
  - preferredProfileIds 优先但不能选 ineligible profile；
  - retry-after / circuit breaker 能把失败 profile 暂时移出 pool；
  - release/renew/expired claim 状态可观察。
- Legacy fallback：
  - runtime disabled 时 Agent/Chat 旧路径仍可用；
  - runtime enabled 时 Agent-run 走 profile claim；
  - footer/diagnostic 显示真实 selected/claimed profile，而不是 legacy `llmConfig.model`。

后续规划要求：

- 以上补充测试项不要求全部在一个 cleanup PR 中完成。
- 但每个后续 PR 若触碰对应 SPEC 范围，必须把相关项标为 `in-scope` / `dependency` / `deferred`。
- SPEC-5 PR1 至少要覆盖 SPEC-2 job lifecycle、SPEC-3 staging/commit、SPEC-4 model-call profile assignment 的可观察测试路径。
- SPEC-7 PR1/PR4 至少要覆盖 SPEC-1 Agent adapter boundary、SPEC-4 Agent-run profile preflight/fallback，以及真实 profile/policy 展示。

## 建议统一修复拆分

建议拆 4 个小 PR，避免把 DB 删除、Settings IA、Agent control plane 和 diagnostics 混在一个大 diff 里：

1. **PR A：Profile 管理补全**
   - 增加 profile delete contract、UI 删除入口、secret cleanup。
   - 顺手处理 Profile 列表重复创建后的清理能力。

2. **PR B：Settings 信息架构调整**
   - Model Profiles 从 LLM 模型页面移出，成为同级 Settings category。
   - 重排 Settings 分组，明确 Knowledge Wiki / OKF-KW 本地扩展项归属。
   - 不改 runtime 行为。

3. **PR C：Agent SDK profile 兼容与对话控制面**
   - 区分 provider model id 与 Agent SDK model alias。
   - 先支持直连 Anthropic-compatible provider 的 env/auth/model 注入。
   - 将 LiteLLM gateway 作为可选路径产品化：example config、env/Keychain secret、启动与验证说明。
   - 增加 Agent SDK preflight / diagnostic，避免 HTTP probe 通过但 sidecar 实跑失败。
   - 增加 Agent-run profile selector 和 permission policy selector。
   - 将 selected profile id 接入现有 `preferredProfileIds`。
   - 修正 footer 展示和 DeepSeek/MIMO/网关 alias 选择问题。
   - 将 sidecar model rejected 写入 profile diagnostic / circuit breaker。

4. **PR D：Runtime Diagnostics / 可观察性**
   - 增加 Runtime Jobs、Commit Layer、Profile Pool / Scheduler 的可观察入口。
   - 提供 dev-only 安全测试动作，避免手测只能靠 DB/CLI。
   - 为 SPEC-5 worker pool 和 SPEC-7 timeline 提供观察基础。

## 后续规划消化规则

本文件是 SPEC-1 到 SPEC-4 合并后 Dev App 手测发现问题的收口记录。后续进入 SPEC-5、SPEC-7 或独立 cleanup PR 前，Commander 必须先回看本文件，并把相关问题显式消化到对应 PR 计划里。

规划要求：

- 不允许把本文件中的问题只当作聊天备注；每个问题必须在后续计划中落到以下三种状态之一：
  - `in-scope`：本 PR 修复；
  - `dependency`：本 PR 依赖它先被修复；
  - `deferred`：明确延后原因、目标 SPEC/PR、验收触发条件。
- SPEC-5 PR1 规划时必须处理多 LLM / `model-call` profile 路由问题：
  - 批量 prepare worker 不应默认继续依赖单活 `llmConfig`；
  - 如暂时保留 legacy fallback，PR 计划必须说明 fallback 边界和退出条件。
- SPEC-7 PR1/PR2/PR4 规划时必须处理 Agent-run profile 问题：
  - Claude Agent SDK direct provider env/auth/model 注入；
  - Agent SDK preflight / diagnostic；
  - Agent 对话中的 profile selector 和 permission policy selector；
  - footer 展示真实 selected/claimed profile。
- Settings cleanup PR 规划时必须处理：
  - Profile delete；
  - Model Profiles 从 LLM 模型页移出；
  - LLM 模型页降级为 legacy default/fallback provider 设置；
  - Knowledge Wiki / OKF-KW 本地扩展项的 Settings 分组和 upstream sync 保护；
  - 已测试通过 provider 到 runtime profile 的创建/迁移路径。
- Runtime diagnostics PR 或 SPEC-5 PR1 规划时必须处理：
  - Runtime Jobs 的主动观察入口；
  - Markdown Commit Layer 的 claims/artifacts/events/markers 观察；
  - Profile Pool / Scheduler active claims、capacity、retry/backoff、circuit breaker 观察。
- 后续触碰 SPEC-1 到 SPEC-4 任一范围的 PR，必须对照“SPEC-1 到 SPEC-4 漏测 / 补充测试清单”挑出相关项，不得只复用本轮手测截图。
- LiteLLM 只能作为可选 gateway 方案进入规划；对 MiMo、DeepSeek、Kimi 等已支持 Claude Code 的 Anthropic-compatible provider，优先规划直连方案。
- 每个后续 PR 的计划文档必须在 `Open Questions / Dependencies / Non-goals` 中引用本文件相关条目，避免同类问题再次散落。

## 当前结论

- 问题 1、2 是 Settings/Profile 产品完整性缺口。
- 问题 3 是 Agent SDK 兼容层缺口：当前 runtime profile 把 provider 原生模型名直传 Claude Agent SDK；历史可用路径已确认依赖本地 LiteLLM/兼容网关做 Claude alias 到 MIMO 的映射。
- 问题 4 是 SPEC-4 profile pool 已接入，但 SPEC-7 对话内控制面尚未实现导致的集成缺口。
- 问题 5 是 runtime/commit/profile scheduler 可观察性缺口；Activity Panel 只适合被动状态提示，不足以承担 SPEC-5/SPEC-7 手测入口。
- 问题 6 是 Settings 信息架构和 upstream/local extension 边界缺口；Knowledge Agents、标签体系、综合是本地 OKF/KW 扩展，不是 upstream 原版项。
- 问题 7 是补充测试覆盖缺口；前 6 个问题不足以证明 SPEC-1 到 SPEC-4 的全部成功标准在集成层面可观察、可恢复、可迁移。
- LLM 模型页的“单活 provider”应降级为 legacy default/fallback 概念；真正的多 LLM 并发/路由应该由 runtime profiles 表达。
- LiteLLM 不是必需依赖；它是统一网关选项。对官方支持 Claude Code 的 Anthropic-compatible provider，应优先直连并正确注入 Claude Code env。
- DeepSeek 自动被选中会放大问题，但不是截图中英文错误的唯一解释。
- 后端已有 `preferredProfileIds` 能力；后续修复重点是 Agent SDK model alias / gateway contract、SDK preflight diagnostic、UI/state/transport wiring。
