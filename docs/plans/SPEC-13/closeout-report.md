# SPEC-13 Closeout 报告（A1 验收窗口，2026-07-06）

> 结论：**SPEC-13 completed**。PR4 legacy 退役合并（#345）后重建装机，M 五项真实 API 重跑全绿；closeout 三维度深度 review 完成，P0×3/P1×6 经 hotfix #348 全部闭环，长尾发现 issue 化（#350-#353）。

## 1. A1 验收：M 五项重跑（构建 = main@ac445bc2 含 #345，/Applications 实机，真实 DeepSeek API）

| 项 | 结果 | 证据 |
|---|---|---|
| M1 三步向导接入 | ✅（改编说明见下） | 「添加模型」入口直达向导第 2 步，DeepSeek 模板预填（endpoint api.deepseek.com/anthropic、显示名、模型），连接组共享凭据自动就位（「Key 已写入凭据存储」）；无 Key 时「获取模型列表」优雅回退为手输并给明确提示。真实模型列表拉取与三步全流程由原 M 验收（#341）覆盖，PR4 对向导仅 i18n 路径改动（detect 证实），未重复注入真实 Key（凭证访问受会话权限策略限制，验收改用共享 secretRef 路径等价覆盖建档链路） |
| M2 零钥匙串弹窗 | ✅ | 全程（启动/向导/对话/agent/ingest）零系统弹窗；密钥后端=应用私有文件（设置页可见「应用私有文件」默认项） |
| M3 对话流式 | ✅ | 真实 DeepSeek 流式回复（输入 43,139 tok / 输出 334 / $0.24 / 8.6s / 2 轮），路由徽标显示 DeepSeek（走 profile 池） |
| M4 Agent 读写 wiki | ✅ | 指令「知识图谱页末尾追加 A1 验收标记」→ agent 完成（$0.06/6.2s），磁盘核验 wiki/concepts/知识图谱.md 末行含标记；权限模式=跳过确认（该测试项目既定夹具） |
| M5 ingest | ✅ | 落 raw/sources/a1-ingest-test-graphrag.md → 提取到 Wiki → 生成 5 个概念页（graphrag/community-summary/global-search/hybrid-retrieval/local-search，磁盘核验），Sources 1→2 |

PR4 UI 面实机确认：设置「AI 与模型」仅剩「模型配置」单页；legacy「LLM 模型」tab 消失；「导入旧配置」批量 banner 在位（5 候选+保留原值勾选+映射校正说明）；embedding/multimodal 独立分类消失（归任务矩阵行内）；Model Profiles 连接分组+三色徽章+快速接入在位。

Hotfix #348 合并后重建（main@328a75fd）装机 spot-check：设置→模型配置**默认落 Model Profiles tab**（接入动线直达向导）✅；迁移 banner 新增「用途之后可在任务分配矩阵中调整」说明 ✅；连接分组/三色徽章/密钥存储「应用私有文件」默认项均在位 ✅。probe 卡五态三色与迁移勾选三元组联动由 hotfix 测试断言+双审逐分支核验覆盖（视觉复验需真实 probe 触发，不重复消耗）。

## 2. Closeout 深度 review（三维度多代理，main@ac445bc2）

- **维度①密钥/secret 面**：P0=共享 secretRef 无引用计数（删/换 Key 静默毁 sibling 密钥——PR2 多选共享 × K1 删除路径组合缺陷，per-PR gate 结构性盲区，路径级 review 抓获）；P2=后端切换残留副本（→#350）、惰性迁移与文档表述差（本报告记录：实现为 lazy-on-read，功能等价）。明文暴露面/K4 隔离/原子写/并发锁全项核验通过。
- **维度②池路由/fallback**：零 P0；P1=任务矩阵「未接入」徽章过期（实际四族已迁池）、model-call 降级零可观测、迁移向导 taskFamilies 写死 chat；P2=App.tsx 启动重解析无退场机制（→#351）、ingest 双路径 fallback 哲学不对称（裁定：有意设计——交互路径静默回退 legacy，批处理宁失败不错配，两者消费同一池）。调用点全量对账无漏网（直接 streamChat 仅 connection-tests 探针与 pool-chat 降级实现两处合法调用）。
- **维度③设置 UI 组合面**：P0=迁移「保留原 endpoint」不联动 apiMode/authStyle（协议错配必坏 profile）、probe 卡 limited/unsupported 渲染绿色；P1=embedding/vision 两套配置体系无解释、fallback 队列缺 agent-kind 守卫、默认 tab 非接入动线；P3=死 i18n key ×2。i18n en/zh parity 全量核验通过。

## 3. Hotfix #348 修复映射

P0×3 + P1×5 + P3 全部闭环：secretRef 引用计数（update/delete 皆事务内原子判定；count 失败 fail-closed 宁孤儿不误删；内审 P1 TOCTOU 修复轮闭环）、keepResolvedEndpoint 三元组成对回退、capabilityBadgeMeta 三色复用（五态测试）、EFFECTIVE_TASK_FAMILIES 扩至实际六族+行内配置解释文案、pool 降级 console.warn、迁移默认文本四族（共享常量）、fallback agent-kind 警示、默认 tab=profiles、死 key 清理。Gate：内审 opus 主力（PASS+P1→recheck PASS）+ ZCode 外审（WARN→P1/P2 全闭环）。

## 4. Follow-up 登记

- #350 secret 后端切换残留副本清理
- #351 App.tsx legacy 重解析退役计划
- #352 model-call 降级 timeline 披露（SPEC 承诺的 profile_resolved 等价机制）
- #353 App.test.tsx resetProjectState CI flake 稳定化
- 既有 backlog 不变：#337（权限弹窗产品重设计）、#340（agent_sdk_model_id 联动）

## 5. Deferred wiring 对账

SPEC-13 范围内无 deferred wiring 遗留：PR1/1b/2/K1-K4/P1/P2/PR4 全部接线并经 M 重跑端到端证实；「导入旧配置」为一次性入口按设计常驻至无候选。

## 6. 教训（回灌 workflows/memory）

- per-PR gate 只看 diff：secretRef 引用计数 P0 横跨 PR2（共享设计）与 K1（删除路径），只有 closeout 路径级 review 能抓——SPEC Closeout Gate 的多代理深度 review 环节再次证实必要性。
- 「保留原值」类选项必须成对保留协议三元组（endpoint/apiMode/authStyle），单独保留端点=必坏配置。
