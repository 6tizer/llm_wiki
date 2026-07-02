# SPEC-10: Security Hardening / 安全加固

> 类型：阶段 SPEC | 状态：reviewed / ready for PR split | 覆盖：`spec-5-8-post-review-findings.md` 二（S1-S4 安全 P0）+ 相关 Rust/chat 安全 P1/P2 | 依赖：无硬前置（可与 SPEC-5-FIX 并行）| 执行顺序：S1/S2 建议作为最高优先级独立 hotfix，先于 SPEC-6/7 实现

## 目标与成功标准

修复深度 review 发现的可被外部利用的安全漏洞、密钥泄露路径和权限绕过。这些问题独立于任何新功能，属于当前就存在的真实攻击面，不应被 SPEC-6/7 的功能工作阻塞。其中 S2 可被用户在使用应用期间访问的任意网页直接触发；S1 是真实沙箱逃逸，经应用自身文件操作/图片导出/LLM 工具（webview → Tauri fs command）路径即可命中——尚未证明外部网页能直接打到 Tauri fs command，但间接触发面（如 S2 的 prompt injection 通道 → agent 文件工具）真实存在。

成功标准：

- 沙箱路径校验在任何情况下都不放行未经 canonicalize 祖先校验的写路径；父目录不存在时不再跳过 root 包含检查。
- 本地剪藏 HTTP 服务不再无差别信任任意 Origin：新增来源校验 / token / 已知项目路径白名单，任意网页无法向磁盘任意目录写文件或枚举全部项目路径。
- Agent sidecar 的 stdout 与 stderr 在到达前端或本地日志前都经过密钥脱敏，SDK 异常/网关报错不再把注入的凭证回显进会话记录或 Console.app。
- wiki 写工具（`update_page`/`create_entity`/`run_pipeline` 等）受 `permissionPolicy` 档位约束，默认策略下改写 wiki 前会经过权限审批入口，收紧策略确实生效。
- 应用退出（托盘 Quit / 窗口关闭）会清理已跟踪的 sidecar/CLI 子进程，不留孤儿进程继续改写 wiki 或消耗 API 额度。
- 用户可控输入不再触发 per-request panic（percent_decode 字符边界）。
- 缩小过宽的能力面：`assetProtocol.scope`、子进程 env 继承、zip/office 解压大小上限等按最小权限收敛。

## 关键设计决策

- 只做安全收敛与漏洞修复，不改变产品功能语义；权限审批入口复用现有 permission bridge（`permissionBridge.requestPermission`），并保持接口与后续 SPEC-7 的 permission UI 产品化对齐，不新造第二套。本 SPEC 先于 SPEC-7 执行，不依赖 SPEC-7 的统一工作。
- S1 修复方向：向上找到最近的已存在祖先目录，canonicalize 后校验其在 root 内，再拼接剩余（已做过分量校验的）后缀；绝对路径分支补 `..`/前缀拒绝。同时合并 `path_safety.rs` 与 `extract_images.rs` 两套沙箱实现为唯一实现——两处重复正是 S1 在两处都未被发现的原因。
- S2 修复方向：clip server 校验请求 Origin 或要求本地 token，`projectPath` 必须属于已知项目列表；错误响应体统一走 `serde_json::json!`（消除 P3 未转义）。
- 密钥脱敏：为 stdout 建立与 `sanitize_agent_stderr_for_frontend` 对等的脱敏通道，并在 `eprintln!` 打日志前先脱敏；`redact_profile_pool_text`（`runtime_db.rs:6005+`）前缀白名单补齐非标准前缀（如本仓库 `litellm/config.yaml` 的 `tp-` 网关 key）。
- 子进程清理放在 Tauri 退出路径（`lib.rs:278,524`），在硬 `exit(0)` 前显式遍历 `AgentState`/`ClaudeCliState`/`CodexCliState` kill；并把 sidecar 内建的 `{type:"kill"}` 优雅取消路径接线（当前是死代码），SIGKILL 仅作兜底超时。
- 安全 P2（tauri asset scope、env 继承、解压炸弹）按纵深防御处理，与 P0 分 PR，不阻塞 hotfix。

## 预期 PR 拆分

1. **S1 沙箱逃逸修复**（最高优先级 hotfix）：`path_safety.rs:74-93` 祖先校验重写 + 绝对路径拒绝 + 合并两套沙箱实现；补漏洞分支测试（父目录不存在 + 项目外绝对路径）。
2. **S2 clip server 鉴权**（最高优先级 hotfix）：Origin/token 校验 + `projectPath` 已知项目白名单 + 错误响应 json! 化 + 单线程 panic 防护（`clip_server.rs` 走 `run_guarded`、去裸 unwrap）。
3. **S3 密钥泄露收口**：stdout 脱敏通道 + `eprintln!` 前脱敏 + `redact_profile_pool_text` 前缀补齐；测试覆盖"stdout/stderr 含凭证被脱敏"。
4. **S4 权限绕过**：wiki 写工具接入 `permissionPolicy` 档位与权限审批入口（与 SPEC-7 permission bridge 对齐）；"允许永久" suggestions 为空时不写空白名单。
5. **子进程生命周期**：退出路径清理子进程；接线优雅 kill、SIGKILL 兜底；`claude_cli.rs`/`codex_cli.rs` 补 `process_group(0)` 修 kill 不对称。
6. **能力面收敛**（纵深防御）：percent_decode 字符边界修复；`assetProtocol.scope` 收窄；子进程 `.env_clear()` + 显式 allowlist；zip/office 解压 + base64 读文件大小上限（照 `MAX_HASH_BYTES` 模式）。

## 验证策略

- S1：单测构造"父目录不存在的项目外绝对路径" → `create_directory`/`write_file` 必须拒绝；图片导出正常流程仍通过。
- S2：模拟跨域 `fetch` / 未知 `projectPath` → 必须拒绝写入与项目枚举；合法插件请求仍通过。
- S3：注入含 `ANTHROPIC_AUTH_TOKEN=...` / `sk-*` / `tp-*` 的 stdout/stderr → 前端事件与本地日志均已脱敏（快照不得含明文）。
- S4：默认 permission policy 下 agent 调 `update_page` 触发审批入口；收紧策略下写工具被拒；测试不得写入真实 secret。
- 子进程：退出时正在运行的 sidecar 被 kill，无孤儿进程；停止命中文件写入时优雅取消不截断。
- 能力面：`?path=%<多字节>` 不再 panic；超限 zip/大文件被拒而非 OOM。

## Gate 结论摘要

本 SPEC 来自 `spec-5-8-post-review-findings.md` 的深度 review 证据。S1/S2 因可被外部利用，建议作为独立 hotfix PR 优先合并。实现 PR 必须重新按 PR-level workflow 跑 GitNexus impact、focused tests、Simplicity、Tester、Reviewer 和 detect，并对安全 PR 额外做攻击场景验证。

## Non-goals / Follow-up

- 不改变产品功能或用户可见流程语义。
- 不实现 SPEC-7 完整 permission UI；本 SPEC 只保证写工具受策略约束、有审批入口，UI 产品化归 SPEC-7。
- 不把 secret、jsonl 私有路径、provider key 写入日志、PR 或测试快照。
- 不在本 SPEC 处理纯数据一致性 bug（归 SPEC-11）或流水线接线（归 SPEC-5-FIX）。
