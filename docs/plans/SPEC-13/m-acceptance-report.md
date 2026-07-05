# SPEC-13 M 节点验收报告

- 日期：2026-07-05
- 环境：重建装机 llm-wiki 0.7.0（main=63c23586，含 K1 #331 / K2 #332 / P1 #333 / P2 #334 / K4 #336）
- 项目：test（`/Users/mac-mini/wiki-migration/NotionDB导出/test`）
- 真实 API：DeepSeek `https://api.deepseek.com/anthropic`，模型 `deepseek-chat`（探测 `supported~profile-probe.v1`）
- 执行者：Commander 通过 CUA 后台自动化操作真机 UI，用户在场协助（钥匙串授权、权限弹窗、模式切换）

## 结论：M 五项全部达成 ✅

| # | 验收项 | 结果 | 证据 |
|---|------|------|------|
| M1 | 三步向导接真实 provider，拉真实模型列表多选 | ✅（带 UX 缺陷） | 向导三步走通；复用既有 secretRef 经「添加模型」建 model-call profile（63861029，deepseek-chat）；「探测 profile」真实 API 往返 40s+ 返回 `capability_status=supported`、`capability_version=profile-probe.v1`、`modelCallSupported=true`、streaming supported |
| M2 | 全程无重复钥匙串弹窗 | ✅ | 迁移期首读弹一次系统授权（K1 MigratingSecretStore 设计内，用户「始终允许」）；此后跨两次应用重启 + 全新构建装机 + 探测/对话/agent/ingest 全程零弹窗；密钥落 `profile-secrets.json`（0600） |
| M3 | 正常对话流式响应（走 profile 池） | ✅ | K4 构建后发送「用一句话介绍知识图谱的核心组成」→ agent-run 池 claim（f7a91b48，12s 持锁）→ 真实流式回复；运行统计 $0.18 / 输入 27,371 / 输出 369 / 3 轮 / 9.8s（Agent 还读取了 M5 生成的 wiki 页作上下文） |
| M4 | Agent 运行读写 wiki | ✅ | 读：M3 轮 27k 输入含 wiki 页内容；写：「跳过确认」模式下追加『主流开源工具』小节 18 秒落盘（`wiki/concepts/知识图谱.md` 新增 Neo4j/NebulaGraph 两条带 wikilink，frontmatter updated 同步），claim 522632fc（19s） |
| M5 | 文档 ingest 成功 | ✅ | `test-ingest-m5.md` 放入 `raw/sources` + 刷新 → ingest 队列 processing→done；3 次 model-call 池 claim（63861029，task_family=ingest，持锁 4/9/14s 真实 API 往返）；生成 `wiki/concepts/{知识图谱,实体,关系,属性}.md` + sources 页，内容为真实 LLM 输出（含原文外扩展与 wikilink 网络） |

## 真实验收发现并修复的 P0

### K4（#336，验收期间发现→修复→合并→重建复测闭环）

**agent 子进程 provider env 被用户全局 Claude 配置静默覆盖。** Claude Code settings `env` 优先级高于进程 env，Agent SDK `settingSources` 省略时加载全部文件系统配置；本机 `~/.claude/settings.json` 有 cc-switch 遗留的空串 `ANTHROPIC_BASE_URL`/`AUTH_TOKEN`/`API_KEY`，把 sidecar 注入的 DeepSeek endpoint/凭证覆盖 → 子进程打官方 API 找 `deepseek-chat` → 「模型不存在」。复现：`ANTHROPIC_BASE_URL=http://127.0.0.1:1 claude -p hi --model test-x` 报官方 API 模型错而非连接错。影响所有装有 cc-switch/自定义 provider env 的用户（agent-run profile 全部失效）。

修复：sidecar 注入任何 provider env 时传 `settingSources: ["project","local"]`（`profileEnvInjected` 同源判定，主路径+rewind 桥接）。审查：内部 opus 初审 FIX_REQUIRED（抓到 Bedrock baseUrl-only 组合漏隔离）→ 修复轮 → 复核 APPROVE；zcode 外部 gate APPROVE；sidecar 测试 137/137。**这正是重编排直通 M 的价值实证：per-PR mock 测试永远暴露不了这个跨层配置冲突。**

## Follow-up（已建 issue）

- #337 P1：写权限弹窗风暴 + 31s 自动拒绝竞态 → Agent 误判「校验失败内部 bug」放弃写入（浪费 $0.40/234s 一轮；「跳过确认」后同写入 18s 成功，定性为权限流问题非写入门禁 bug）
- #338 P1：Agent 回复气泡文本溢出容器边界（用户实测）
- #339 P1：agent route 菜单选中项与按钮文案运行时不同步（用户实测；重启后同步）
- #340 P1：`agent_sdk_model_id` 别名与 `model_id` 脱节，错误只报别名难定位

其他观察（未单独立 issue，SPEC-13 后续 PR 面）：复用既有 secretRef 时向导「获取模型列表」「测试连接」要求明文 key 不可用，只能手输模型 id；探测长耗时（40s+）无进行中反馈。

## 验收夹具记录（runtime.db 直改，非产品改动，密钥零接触）

- 停用无效候选：LongCat-2.0（模型号错，#326 已知问题区）、MiMo、deepseek-v4-flash/v4-pro（真实 API 无此模型）、`/v1` 错误端点 profile
- DeepSeek agent-run profile 对齐 `model_id`=`agent_sdk_model_id`=`deepseek-chat`，其中 f7a91b48 复用已验证 secretRef（9adc8ef0）
- 明文密钥全程未进入任何上下文/文件；凭证守卫两次拦截（keychain 探查、secret 文件读取）均遵守未绕过

## M 后续（spec-13 doc「重编排」节既定）

PR4 legacy 退役 → closeout。本报告作为 M 达成凭据。
