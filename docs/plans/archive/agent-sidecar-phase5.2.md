# Phase 5.2: Autonomous PR Loop 插件

> 类型：Phase 实施计划 | 创建：2026-06-12 | 更新：2026-06-12 | 状态：候选
> 上级：[Agent Sidecar 总规划](./agent-sidecar-roadmap.md)
> 前置：[Phase 5.1 计划](./agent-sidecar-phase5.1.md)
> 后续：[Phase 6 上游同步](./upstream-sync-phase6.md)

## 背景

Phase 5 到 Phase 5.1 期间，Agent Sidecar 的开发节奏已经稳定成一套固定循环：

1. 通过代码、git commit、GitHub issue/PR 和 `docs/plans/` 判断当前 Phase 进度。
2. 根据计划书和 GitHub 状态找到下一个最小 PR。
3. 为这个 PR 写 SPEC。
4. 切新分支实施开发，完成后 commit、push、开 PR。
5. 等 PR review 报告，修复评论里的问题。
6. 循环 review-fix，直到 review 同意合并。
7. 等 CI 转绿，合并 PR。
8. 切回基线分支，拉新代码，重建 GitNexus 索引。
9. 回到第 2 步。

这套流程已经跑过很多轮。现在的主要损耗不是步骤不会做，而是状态散落在对话、GitHub、git 分支和计划文档里。换对话或中断后，恢复成本高，也容易漏跑门禁，或者在 review-fix 阶段顺手改掉不属于当前 PR 的内容。

Phase 5.2 不再只做 `skill + scripts` 的小 MVP，而是交付产品化、可迁移的 Autonomous PR Loop 插件。插件把 role switch、状态机、worker 调度、安全拦截、MCP 控制面和状态 UI 放在同一个可安装单元里。它首先服务 `llm_wiki`，但设计上不能写死 `llm_wiki`，其他 GitHub 工作区也应能通过 repo config 接入。

本地调研结论：

- 本机存在 `codex` CLI，版本 `codex-cli 0.130.0`。
- `codex exec` 非交互模式可用，实测能输出 JSONL 事件，并能把最后一条 agent message 写到文件。
- `codex exec` 可以在当前仓库里运行只读命令，适合作为可编程 coder worker。
- Codex 手册确认 non-interactive mode、SDK、app-server 和 subagents 都是可用的程序化入口。
- 当前会话已暴露 `multi_agent_v1.spawn_agent`，可用 `worker` / `explorer` / `default` 子代理；但跨对话可恢复的基础执行器仍选 `codex exec`。
- `gh` 已登录，具备 `repo` 和 `workflow` scope；`gh pr view --json` 能拿 PR、review、files、checks，GraphQL 能拿 `reviewThreads.isResolved`、`isOutdated`、`diffHunk` 和 comment URL。
- Codex plugin 可以打包 skills、MCP servers 和 hooks。当前没有确认可用的 Codex App 原生插件 UI widget 接口，所以 UI 采用本地 Web dashboard，而不是承诺嵌入 Codex App。
- Codex hooks 能拦截 Codex tool loop 内的 `PreToolUse`、`PostToolUse`、`Stop` 等事件，但不能拦截用户在外部 Terminal 手动执行的命令。全局安全必须由 core policy、CLI 检查和 hooks 共同完成。
- Node v25 提供 `node:sqlite`，产品化状态库可以用 SQLite，不必先引入 native SQLite 依赖。

**结论**：Phase 5.2 用 7 个 PR 交付完整插件，包含 skill、scripts、hooks、MCP、UI 五件套。状态机内核只有一份，所有入口共用同一个 core。插件本体可跨工作区安装；每个工作区用 `.agent-loop/config.json` 描述本仓库的计划目录、测试命令、CI check、GitNexus alias 和安全策略。

---

## 产品目标

插件完成后，用户可以在任意已初始化工作区用一句话进入 loop：

```text
进入 Autonomous PR Loop，继续跑到 gate。
```

Codex 会通过 skill 切换为 supervisor，调用插件的 MCP 或 CLI，自动推进：

```text
SYNC_MAIN
  -> DISCOVER_PROGRESS
  -> SELECT_NEXT_PR
  -> WRITE_SPEC
  -> CREATE_BRANCH
  -> IMPLEMENT
  -> SELF_CHECK
  -> COMMIT_PUSH_PR
  -> WAIT_REVIEW_OR_CI
  -> FIX_REVIEW
  -> SELF_CHECK
  -> PUSH_FIX
  -> WAIT_REVIEW_OR_CI
  -> READY_TO_MERGE
  -> MERGE
  -> SYNC_MAIN
```

完整能力包括：

- 从配置的 `baseBranch` 同步开始。
- 判断当前 Phase 和下一个 PR。
- 生成或更新该 PR 的 SPEC。
- 创建分支。
- 调用 `codex exec` coder worker 实施开发。
- 跑测试、lint、GitNexus impact/detect。
- commit、push、开 draft PR。
- 读取 PR review comment。
- 调用 worker 修复 review。
- 重跑验证并 push。
- 等 CI 转绿。
- ready/merge PR。
- 回到 `baseBranch`，pull，重建 GitNexus 索引。
- 继续下一轮，直到遇到 gate。

可迁移能力包括：

- `agent-loop init` 在新工作区生成 `.agent-loop/config.json`。
- `agent-loop doctor` 检查 git、GitHub remote、`gh` auth、Codex CLI、GitNexus、测试命令、计划目录和 CI check。
- 计划目录、base branch、branch prefix、测试/lint 命令、required checks、GitNexus repo alias、protected paths 都来自 repo config。
- 缺少 repo config 时，插件进入 `needs_repo_init` gate，不按 `llm_wiki` 规则硬猜。
- `llm_wiki` 只是默认 fixture 和首个落地目标，不是内置唯一仓库。

---

## 插件组成

Phase 5.2 插件由五层组成：

| 层 | 作用 | 交付物 |
|----|------|--------|
| skill | 让 Codex 一键进入 loop supervisor 角色 | `skills/autonomous-pr-loop/SKILL.md` |
| scripts | 提供确定性 CLI，执行状态机和本地命令 | `scripts/agent-loop` |
| hooks | 强制安全规则和门禁，不让高风险操作绕过 loop | `hooks/*` |
| MCP | 给 Codex 和 UI 暴露状态机控制面 | `mcp-server/*` |
| UI | 本地 dashboard，展示状态、gate、PR、CI、worker 日志和 artifacts | `ui/*` |

共享内核：

```text
core/
  state-machine
  policy
  storage
  git
  github
  gitnexus
  worker
  artifacts
```

**单一真实来源**：状态机、gate、policy、命令计划、storage schema 都只在 `core` 里定义。skill、scripts、hooks、MCP、UI 只能调用 core，不能各自实现一套判断逻辑。

---

## 建议目录

插件建议放在仓库内，作为可版本化、可安装的产品包：

```text
plugins/autonomous-pr-loop/
  .codex-plugin/
    plugin.json
  skills/
    autonomous-pr-loop/
      SKILL.md
      agents/
        openai.yaml
  scripts/
    agent-loop.ts
  hooks/
    pre-tool-use.ts
    pre-commit.ts
    stop.ts
  mcp-server/
    src/index.ts
  ui/
    index.html
    src/
  core/
    state-machine.ts
    policy.ts
    storage.ts
    command-runner.ts
    git.ts
    github.ts
    gitnexus.ts
    worker.ts
    artifacts.ts
  schemas/
    state.schema.json
    worker-result.schema.json
    config.schema.json
  package.json
```

仓库级 marketplace 文件：

```text
.agents/plugins/marketplace.json
```

插件可以作为 repo marketplace 分发，也可以复制到用户级或团队级 marketplace：

```text
~/.codex/plugins/autonomous-pr-loop/
~/.agents/plugins/marketplace.json
```

根目录保留便捷入口：

```json
{
  "scripts": {
    "agent-loop": "tsx plugins/autonomous-pr-loop/scripts/agent-loop.ts"
  }
}
```

如果当前项目没有 `tsx` 或类似运行器，优先复用现有 TypeScript 脚本运行方式，不为插件引入重依赖。

---

## Skill 设计

skill 名：

```text
autonomous-pr-loop
```

触发方式：

```text
使用 autonomous-pr-loop，继续跑到 gate
进入 Autonomous PR Loop
继续 agent-loop
```

skill 只负责角色切换和操作协议，不实现状态机。

skill 必须要求 Codex：

1. 读取当前 repo 的 `AGENTS.md`。
2. 确认当前目录是 git repo，并读取 `.agent-loop/config.json` 的 `repoId`。
3. 优先调用 MCP `loop_status()`；MCP 不可用时运行 `pnpm agent-loop status`。
4. 读取 SQLite state，不靠聊天记忆判断进度。
5. 如果状态是 `BLOCKED`，先汇报 blocker，不擅自继续。
6. 如果用户要求继续，调用 `loop_run_until_gate()` 或 `pnpm agent-loop run --until=gate`。
7. loop 进入 `IMPLEMENT` / `FIX_REVIEW` 时，允许它调用 `codex exec` worker。
8. supervisor 负责检查 worker 输出、diff、测试、GitNexus、GitHub 状态。
9. 遇到 gate 立即停下，给出下一步建议。

skill 禁止：

- 让 worker commit、push、开 PR、merge。
- 跳过 GitNexus impact/detect。
- 在 review-fix 中处理明显越界内容。
- 使用聊天历史代替状态库。
- 执行 destructive git 操作。

---

## Scripts 设计

CLI 是插件的确定性执行面：

```bash
pnpm agent-loop status
pnpm agent-loop init
pnpm agent-loop run --until=gate
pnpm agent-loop resume
pnpm agent-loop step
pnpm agent-loop stop
pnpm agent-loop doctor
pnpm agent-loop logs
pnpm agent-loop approve-gate <gate-id>
```

职责：

- 初始化新工作区配置。
- 推进状态机。
- 调用 `git`。
- 调用 `gh`。
- 调用 `npx gitnexus`。
- 调用 `codex exec`。
- 写 SQLite state。
- 写 artifacts。
- 生成 worker prompt。
- 校验 worker output。
- 执行 dry-run。
- 支持 resume。

`init` 职责：

- 检查当前目录是否是 git repo。
- 识别 GitHub remote。
- 检查 `gh auth status` 和 `workflow` scope。
- 检查 `codex` CLI。
- 检查 GitNexus 是否可用，并尝试读取当前 repo alias。
- 识别常见包管理器和 scripts。
- 询问或推断 `plansDir`、`lintCommand`、`testCommand`、`requiredChecks`。
- 生成 `.agent-loop/config.json`。

`doctor` 职责：

- 验证 config schema。
- 验证 plansDir 是否存在。
- 验证 base branch 和 remote。
- 验证 `gh`、`codex`、`gitnexus`。
- 验证 required checks 是否能从最近 PR 或 workflow 中找到。
- 验证 SQLite state 是否可读。
- 输出缺失项和对应 gate。

`run --until=gate` 是主要无人值守入口。它持续推进，直到：

- PR merged 并回到 `SYNC_MAIN`。
- 遇到 gate。
- 达到配置的轮次上限。
- 用户调用 `stop`。

---

## Storage 设计

产品化版本使用 SQLite，不再把 JSON 文件作为主状态库。

默认路径：

```text
.agent-loop/state.sqlite
.agent-loop/artifacts/<run-id>/
.agent-loop/config.json
```

`.agent-loop/` 必须加入 `.gitignore`。仓库只提交 schema、模板和测试 fixture，不提交真实运行日志。

建议表：

| 表 | 内容 |
|----|------|
| `runs` | 每次 loop run 的元数据 |
| `states` | 状态快照和当前状态 |
| `events` | 状态迁移、命令、worker、gate 事件 |
| `gates` | blocker、原因、审批状态 |
| `workers` | worker prompt、thread id、退出状态、token/usage 摘要 |
| `artifacts` | SPEC、diff、test report、review comments、worker final |
| `pr_links` | PR number、URL、branch、base |
| `ci_checks` | check run 名称、状态、结论、rerun 次数 |
| `review_comments` | comment id、author、body、resolved/actionable 状态 |
| `decisions` | supervisor 或 loop 的决策日志 |
| `repo_config` | 当前工作区配置快照，便于 run 可复现 |

SQLite 是 hooks、MCP、UI、CLI 的共享状态源。所有写入必须通过 core storage API。

---

## Cross-workspace 使用

插件分成两部分：

1. 插件本体：skill、scripts、hooks、MCP、UI、core。
2. 工作区配置：`.agent-loop/config.json` 和 `.agent-loop/state.sqlite`。

安装插件后，任意 repo 第一次使用都先运行：

```bash
pnpm agent-loop init
pnpm agent-loop doctor
```

初始化后的最小配置：

```json
{
  "repoId": "owner/name",
  "baseBranch": "main",
  "branchPrefix": "codex/",
  "plansDir": "docs/plans",
  "lintCommand": "pnpm lint",
  "testCommand": "pnpm test",
  "gitnexusRepo": "repo_alias",
  "requiredChecks": ["check (ubuntu-22.04)"],
  "requireReviewApproval": true,
  "allowAutoMerge": false,
  "protectedPaths": [".git/**", ".agent-loop/**", ".env*", "**/*secret*"]
}
```

repo config 不存在或不完整时：

- `status` 显示 `needs_repo_init`。
- `run` 不会自动推进。
- UI 显示初始化向导。
- skill 必须提醒用户先运行 `agent-loop init` 或补配置。

可迁移边界：

- 默认只支持 GitHub PR 工作流。非 GitHub remote 进入 `unsupported_remote` gate。
- 默认要求本地 `gh` 已登录。未登录进入 `needs_secret_or_login` gate。
- GitNexus 不可用时，默认不允许进入会改代码的状态；除非 repo config 显式配置 `gitnexusRequired=false`。
- 没有计划目录时，可以用 `init` 生成空计划模板，但不能自动猜 Phase。
- 没有 lint/test command 时，可以进入 plan/spec 状态，进入 implement 前必须 gate。

---

## Worker 设计

默认 worker backend：

```text
codex-exec
```

调用形态：

```bash
codex exec \
  -C <repo> \
  -s workspace-write \
  --json \
  --output-schema <worker-result.schema.json> \
  --output-last-message <artifact>/worker-final.json \
  < <artifact>/worker-prompt.md
```

只读分析使用：

```bash
codex exec -s read-only --json ...
```

worker 类型：

| Worker | 作用 |
|--------|------|
| `planner` | 读取计划文档、issue、commit，生成下一个 PR SPEC |
| `implementation` | 按 SPEC 改代码、跑局部测试、输出变更摘要 |
| `review-fix` | 读取 PR review comments，修复当前 PR 范围内问题 |
| `ci-fix` | 分析 CI 日志，修复可复现失败 |
| `reviewer` | 在 commit 前做本地自审，找明显 bug/test gap |

worker prompt 必须包含：

- 当前状态。
- 当前 SPEC。
- 明确允许修改的范围。
- 必跑验证命令。
- AGENTS.md 关键约束。
- GitNexus impact/detect 规则。
- 禁止事项：不要 commit、不要 push、不要开 PR、不要 merge、不要处理越界 review。
- 输出 schema。

worker 输出必须结构化。解析失败进入 gate。

---

## Hooks 设计

hooks 是安全带，只做 deterministic guardrail，不做复杂推理。

### PreToolUse hook

拦截危险命令：

- `git reset --hard`
- `git push --force`
- `git checkout -- <path>`
- `rm -rf`
- 删除 `.git/`
- 删除 `.agent-loop/state.sqlite`
- worker 执行 `git commit` / `git push` / `gh pr merge`

如果当前命令属于 loop 允许的 orchestrator step，必须能在 SQLite 中找到对应 state 和 command plan。

### PreCommit hook

commit 前强制检查：

- 已记录 GitNexus impact。
- 已运行计划要求的测试。
- 已运行 `pnpm lint` 或有明确豁免。
- 已运行 `gitnexus detect_changes`。
- diff 没有越出当前 PR scope。

### Stop hook

turn 结束前检查：

- 如果 loop 正在运行，状态是否已写入 SQLite。
- 如果有未提交 diff，是否有 artifact 记录。
- 如果进入 `BLOCKED`，是否有 blocker reason。
- 如果 PR 已 merge，是否已回到 `baseBranch` 并重建 GitNexus 索引。

hooks 不负责判断下一个 PR、生成 SPEC、解释 review 或修代码。

---

## MCP 设计

MCP 是状态机控制面，给 Codex、UI 和未来外部工具使用。

建议 tools：

```text
loop_status()
loop_next_action()
loop_run_until_gate()
loop_resume()
loop_stop()
loop_step()
loop_list_gates()
loop_explain_gate(gateId)
loop_approve_gate(gateId, note)
loop_reject_gate(gateId, note)
loop_list_runs()
loop_read_artifact(runId, artifactName)
loop_get_pr_status()
loop_get_ci_status()
loop_get_review_comments()
loop_spawn_worker(kind, promptRef)
loop_open_dashboard()
```

MCP 只调用 core，不复制 CLI 逻辑。

权限原则：

- read-only tools 可随时调用。
- mutating tools 必须检查当前 state、gate、config。
- `loop_approve_gate` 需要明确 note，并写入 `decisions`。
- merge 类操作必须确认 CI green、review approved、无 unresolved blocker。

---

## UI 设计

UI 是观察和人工介入层，不负责自动修代码。Phase 5.2 的 UI 明确做成本地 dashboard，由 CLI/MCP 打开；不承诺嵌入 Codex App 原生面板。

入口：

```bash
pnpm agent-loop dashboard
```

### Design Plugin Collaboration Workflow

UI 升级不是只做 CSS polish。Phase 5.2 明确使用 `@product-design` 和 `@creative-production` 协作，把 dashboard 从工程面板提升为可长期使用的产品界面。

协作边界：

| 插件 | 介入阶段 | 主要产物 | 不负责 |
|------|----------|----------|--------|
| `@product-design` | PR 5.2-F 前做 P0 UX brief；PR 5.2-G 前做 P1 UX audit | 信息架构、页面优先级、关键用户路径、wireframe、状态/空态/错误态清单 | 生成生产代码、决定状态机规则 |
| `@creative-production` | PR 5.2-G 视觉方向阶段 | moodboard、视觉方向、色彩/质感/密度建议、关键页面视觉参考 | 修改业务逻辑、替代 UX 验收 |
| Codex implementation | PR 5.2-F/5.2-G 实现阶段 | dashboard 代码、组件、数据绑定、截图、design QA report | 绕过 MCP/core 直接读写 SQLite |

#### PR 5.2-F 前置设计输入

在实现 P0 Dashboard 前，先用 `@product-design` 产出一份 P0 dashboard UX brief，保存到 artifacts 或 docs：

- 目标用户：loop supervisor / repo maintainer。
- 核心任务：看当前状态、判断是否能继续、处理 gate、审计 worker、恢复中断。
- 页面信息架构：Mission Control、Gate Center、PR Inbox、Worker Runs、Scope Guard、Event Ledger、Artifact Diff Viewer、Recovery Center。
- 每个页面的主任务、关键数据、主要操作、危险操作。
- 必备状态：loading、empty、blocked、stale data、command running、permission required、CI pending、review changes requested。
- 密度原则：偏运维工具，不做营销页，不做装饰性 hero。

PR 5.2-F 只要求按 UX brief 做 P0 可用界面，不要求最终视觉 polish。

#### PR 5.2-G 视觉与交互升级

PR 5.2-G 开始前，用 `@product-design` 做一次基于 P0 截图的 UX audit：

- 信息是否过载。
- gate 是否足够突出。
- review/CI/worker 状态是否能一眼判断。
- 危险操作是否有足够确认和上下文。
- Plan Navigator / Policy Config / Dry-run Preview 是否能解释 loop 为什么这么做。

然后用 `@creative-production` 生成视觉方向探索：

- 至少 2 个 dashboard 视觉方向。
- 每个方向说明色彩、排版密度、状态色、卡片/表格/日志呈现方式。
- 至少覆盖 Mission Control、Gate Center、PR Inbox、Worker Runs 四个关键页面。
- 选择一个方向作为 implementation target，不把多个方向混在一起。

PR 5.2-G 实现后，保存 design QA report：

- 对照选定方向和最终截图。
- 列出 P0/P1/P2 设计问题。
- P0/P1 问题必须修复后才能 ready。
- P2 可记录为 follow-up，不阻塞合并。

#### 设计产物存放

设计协作产物不进入 `.agent-loop/state.sqlite`。建议存放：

```text
docs/plans/artifacts/phase5.2/
  p0-dashboard-ux-brief.md
  p1-dashboard-ux-audit.md
  visual-direction-options.md
  design-qa-report.md
```

若产物包含大量截图或图片，则只提交小型 markdown 摘要，大文件放 `.agent-loop/artifacts/<run-id>/`，计划书链接到摘要。

### P0 页面

P0 是无人值守能放心跑起来的最低 UI 集合。

#### Mission Control

当前任务总览：

- 当前 Phase / 当前 PR / 当前分支。
- 当前 state。
- 下一个动作。
- 是否可无人继续。
- 当前 gate / blocker。
- CI 状态。
- review 状态。
- GitNexus index 状态。
- 工作区是否干净。
- 最近一次 worker 是否成功。
- 下一步将执行的命令。

按钮：

```text
Run to Gate
Step Once
Pause
Resume
Stop
Open PR
Open Logs
```

#### Gate Center

Gate 是主要人工介入入口。每个 gate 显示：

- Gate 类型。
- 触发原因。
- 触发前后 state。
- 相关 diff。
- 相关 review comment / CI log / GitNexus report。
- loop 推荐动作。

操作：

```text
Approve and Continue
Reject
Convert to Issue
Add to Plan
Mark as Out of Scope
Retry
Stop Run
```

#### PR Inbox

展示当前 PR 的外部输入：

- PR 状态。
- review decision。
- unresolved review threads。
- actionable comments。
- CI checks。
- failed jobs。
- reviewer。
- 最近一次 push。
- loop 已处理 / 未处理 comment。

每条 comment 有处理状态：

```text
pending
assigned-to-worker
fixed
declined-out-of-scope
converted-to-plan
needs-human
```

数据来源：`gh pr view --json` 和 GitHub GraphQL `reviewThreads`。

#### Worker Runs

展示每次 worker：

- worker 类型：planner / implementation / review-fix / ci-fix / reviewer。
- prompt。
- final JSON。
- JSONL event stream 摘要。
- 改了哪些文件。
- 跑了哪些命令。
- 退出原因。
- usage 摘要，能拿到就显示。
- 是否违反 scope。
- 是否产生 gate。

操作：

```text
Open Prompt
Open Final
Open Diff
Rerun Worker
Rerun Read-only
```

#### Scope Guard

展示当前 diff 是否越界：

- SPEC 允许范围。
- 实际 changed files。
- GitNexus impact / detect changes 结果。
- HIGH/CRITICAL impact。
- 新增/删除文件。
- 敏感区域触碰：
  - auth/secrets
  - git config
  - CI config
  - migrations
  - hooks
  - MCP
  - package lock

#### Event Ledger

可审计事件流：

- state transition。
- command executed。
- worker spawned。
- gate opened。
- gate approved/rejected。
- test passed/failed。
- CI rerun。
- PR comment posted。
- merge completed。
- index rebuilt。

每条事件包含：

```text
time
actor: loop / supervisor / worker / hook / user
state before/after
artifact links
```

#### Artifact Diff Viewer

展示并关联：

- SPEC。
- worker prompt。
- worker final。
- diff patch。
- test report。
- lint report。
- GitNexus impact report。
- GitNexus detect report。
- review comments。
- CI logs。

#### Recovery Center

展示中断恢复状态：

- 上次 run 停在哪。
- 停止原因。
- 是否有未提交 diff。
- 是否有 worker 正在跑。
- 当前分支和状态库是否一致。
- GitHub PR 状态是否和本地状态一致。
- 可以恢复到哪个 checkpoint。

操作：

```text
Resume From Current State
Re-scan Reality
Mark Run Abandoned
```

不提供 destructive rollback。恢复中心只修 loop state，不自动回滚用户文件或 git 历史。

### P1 页面

P1 不是运行 loop 的硬依赖，但能明显降低长期使用成本。

#### Plan Navigator

- 当前 Phase。
- 已完成 PR。
- 当前 PR。
- 下一个候选 PR。
- 被 gate 推迟的内容。
- review 越界后写入哪份计划书。
- issue 对应关系。

#### Policy Config

- auto merge on/off。
- require review approval。
- max review fix rounds。
- max test fix rounds。
- max CI reruns。
- required checks。
- blocked commands。
- protected paths。
- worker sandbox mode。
- allowed branch prefix。
- allowed plans dir。

#### Dry-run Preview

- 下一个 PR 判断。
- 将创建的分支名。
- 将调用的 worker。
- 将运行的命令。
- 可能触发的 gate。
- 当前缺失条件。

操作：

```text
Start Real Run
Edit Config
Stop
```

#### Notifications

先做 UI 内通知，不做系统通知：

- PR review 出来了。
- CI 红了。
- CI 绿了。
- gate opened。
- merge completed。
- loop stopped。
- worker failed schema parse。

### UI 数据边界

| 功能 | 数据来源 | 新建接口 |
|------|----------|----------|
| Mission Control | git、gh、GitNexus、SQLite | `loop_status()`、summary query |
| Gate Center | SQLite gates/events/artifacts | gate approve/reject/convert actions |
| PR Inbox | `gh pr view`、GitHub GraphQL | review thread sync、comment status table |
| Worker Runs | `codex exec --json`、worker output schema | worker event ingest |
| Scope Guard | git diff、GitNexus impact/detect | scope policy engine |
| Event Ledger | core events | event writer/query |
| Artifact Diff Viewer | artifacts、git diff patch | artifact index |
| Recovery Center | git status、gh PR、SQLite | reality scan |
| Plan Navigator | `docs/plans/*`、GitHub issues/PRs | plan parser |
| Policy Config | config schema | config read/write/validate |
| Dry-run Preview | command planner | dry-run plan model |
| Notifications | core events | in-dashboard notification feed |

不可承诺的点：

- 不做 Codex App 原生嵌入式 UI。当前实现为本地 Web dashboard。
- 不拦截外部 Terminal 手动执行的危险命令。hooks 只覆盖 Codex tool loop，CLI/core policy 覆盖插件自身命令。
- 不做 GitHub webhook daemon。PR/CI 状态用 polling 或手动刷新同步。

UI 必须通过 MCP 或 core API 读写状态，不能直接改 SQLite。

---

## 状态定义

| 状态 | 动作 | 完成条件 |
|------|------|----------|
| `SYNC_MAIN` | 切回配置的 `baseBranch`，确认工作区干净，`git pull --ff-only origin <baseBranch>`，运行 `npx gitnexus analyze` | `baseBranch` 与 upstream 同步，GitNexus status fresh |
| `DISCOVER_PROGRESS` | 读取 `docs/plans/*`、最近 commit、open PR、closed PR、相关 issue | 识别当前 Phase、已完成 PR、待做 PR |
| `SELECT_NEXT_PR` | 根据计划书和 GitHub 状态选择下一个 PR | 得到唯一 next PR；不唯一则 gate |
| `WRITE_SPEC` | 调用 planner worker 或由 orchestrator 生成 SPEC | SPEC 写入计划文档或 run artifact |
| `CREATE_BRANCH` | 创建 `codex/...` 分支 | 当前分支为目标分支 |
| `IMPLEMENT` | 调用 implementation worker 开发 | worker 返回变更摘要，工作区有预期 diff |
| `SELF_CHECK` | 跑 impact、测试、lint、detect changes、本地 reviewer | 通过，或进入 retry/gate |
| `COMMIT_PUSH_PR` | stage、commit、push、开 draft PR | PR URL 记录到状态 |
| `WAIT_REVIEW_OR_CI` | 轮询 review comment、review decision、CI check | 出现 review fix、CI fail、approved 或 ready condition |
| `FIX_REVIEW` | 拉取 unresolved/actionable comments，调用 review-fix worker | comments 被处理，产生修复 diff 或记录不处理原因 |
| `PUSH_FIX` | 新 commit，push，留 PR comment | 新 commit pushed，comment 已发布 |
| `READY_TO_MERGE` | 确认 review approved、CI green、无 unresolved blocker | 可 merge |
| `MERGE` | ready PR，merge，删除远端分支 | PR merged |
| `BLOCKED` | 等待 supervisor 或用户处理 gate | gate 被 approve/reject/resolve |

---

## Gate 规则

loop 遇到以下情况必须停机，把状态写成 `BLOCKED`，并给 supervisor 一条明确报告：

| Gate | 停机原因 |
|------|----------|
| `needs_repo_init` | 当前工作区缺少 `.agent-loop/config.json` 或配置不完整 |
| `unsupported_remote` | 当前工作区不是 GitHub PR 工作流 |
| `ambiguous_next_pr` | 计划书和 GitHub 状态无法唯一判断下一个 PR |
| `unexpected_high_impact` | GitNexus impact 返回 HIGH/CRITICAL，且不在 SPEC 明确范围内 |
| `test_retry_exhausted` | 测试或 lint 连续自动修复 2 轮仍失败 |
| `review_out_of_scope` | PR review 要求明显超出当前 PR 范围 |
| `ci_infra_failed` | CI 重跑后仍失败，本地无法复现，疑似 infra 或环境问题 |
| `needs_secret_or_login` | 需要密钥、登录、外部 UI 授权或付费资源 |
| `destructive_operation` | 需要删除数据、重写历史、force push、reset hard 等操作 |
| `dirty_unowned_worktree` | 工作区有不属于当前 loop 的未提交变更 |
| `worker_output_invalid` | worker 输出无法按 schema 解析 |
| `policy_violation` | hooks 或 policy 检测到越权操作 |

Gate 不是失败。它是 loop 的安全出口，下一次 `resume` 应该能从同一个状态继续。

---

## PR 切分

Phase 5.2 最小用 6 个 PR 可落地，完整产品化用 7 个 PR。这里按 7 个 PR 规划，把 P1 UI polish 和配置体验也纳入 Phase 5.2 完成标准。

除非前一个 PR 的公共接口已经合并并通过验证，不跳到后一个 PR。每个 PR 都要保持可 review、可测试、可回滚，不把后续 PR 的实现偷塞进当前 PR。

### PR 5.2-A：Plugin Shell + Core Storage + Repo Init

**目标**：让插件作为可迁移产品站起来。

| 模块 | 工作项 | 验收 |
|------|--------|------|
| plugin manifest | 新增可安装插件结构、manifest、repo marketplace | Codex 能识别插件元数据 |
| skill | 提供 `autonomous-pr-loop` skill 初版 | 用户一句话能让 Codex 进入 supervisor 协议 |
| shared core | 建立 core 目录、类型、错误、policy/config 基础 | 后续 CLI/MCP/hooks/UI 共用同一 core |
| SQLite storage | 建库、迁移、schema、snapshot API | 能写入 run/state/event/gate/artifact/repo_config |
| repo portability | 新增 repo config、`init`、`doctor`、cross-workspace gates | 非 `llm_wiki` repo 能初始化并跑 doctor |
| CLI | 新增 `pnpm agent-loop init/status/doctor` | 缺 config 进入 `needs_repo_init`，不硬猜 |

**依赖**：无。
**风险**：MEDIUM。插件结构和 storage 是后续所有 PR 的基础。
**验收重点**：`init --dry-run`、`doctor`、SQLite schema、skill 入口、`.agent-loop/` 不进入 git。

---

### PR 5.2-B：State Machine + Command Runner + Artifacts

**目标**：状态机和事件账本可跑，先不接真实 GitHub 生命周期。

| 模块 | 工作项 | 验收 |
|------|--------|------|
| state machine | 实现状态枚举、迁移、gate、retry 计数 | mock 环境能从 `SYNC_MAIN` 推进到 gate |
| command runner | 封装命令计划、dry-run、stdout/stderr/exit code 记录 | destructive command 被 policy 拦截 |
| artifacts | SPEC、diff、test report、review comments、worker final 的统一索引 | artifact 可写入、读取、关联 event |
| CLI | 新增 `run --dry-run`、`step`、`resume`、`stop`、`logs` | 状态中断后能恢复 |
| Event Ledger | 写入 state transition、command、gate、artifact link | 每次状态推进可回溯 |

**依赖**：PR 5.2-A。
**风险**：MEDIUM。这里决定 loop 后续是否可恢复。
**验收重点**：不改文件、不 push 的 dry-run；resume 不从头开始；event/artifact 可追踪。

---

### PR 5.2-C：Git/GitHub/GitNexus + PR Lifecycle

**目标**：把真实 PR 生命周期接进状态机。

| 模块 | 工作项 | 验收 |
|------|--------|------|
| Git | branch、stage、commit、push、merge 后 sync baseBranch | 不执行 force push / reset hard |
| GitHub | 封装 `gh pr view/list/comment/ready/merge` | 能读取当前 PR 状态并留 comment |
| GraphQL | 同步 reviewThreads、isResolved、isOutdated、diffHunk、comment URL | PR Inbox 数据可用 |
| CI | check run 查询、failed job rerun、CI green 判断 | CI failed/success 进入正确状态 |
| GitNexus | analyze/status/impact/detect changes 报告 | 提交前 detect changes 必跑 |
| Review loop model | 解析 PR review comments，维护 comment status | review-fix 轮次可追踪 |

**依赖**：PR 5.2-B。
**风险**：MEDIUM-HIGH。这里触碰 git/GitHub 真实副作用。
**验收重点**：mock GitHub 覆盖 PR 创建、review-fix、CI green、merge 后 sync；真实测试分支只做受控验证。

---

### PR 5.2-D：Codex Worker Orchestration

**目标**：接入 `codex exec` worker，让 loop 能委派计划、实现、review-fix 和 CI-fix。

| 模块 | 工作项 | 验收 |
|------|--------|------|
| worker backend | 封装 `codex exec --json --output-schema --output-last-message` | worker 成功/失败都落盘 |
| worker types | planner、implementation、review-fix、ci-fix、reviewer | 每类 worker 有 prompt builder 和 schema |
| event ingest | JSONL event stream 摘要进入 SQLite | Worker Runs 有数据 |
| scope guard | worker changed files、allowed scope、sensitive paths 检查 | 越界进入 gate |
| safety | worker 禁止 commit/push/PR/merge | worker 执行越权命令会被 policy/hook 拦截 |
| gates | `worker_output_invalid`、`review_out_of_scope`、`unexpected_high_impact` | schema 失败和越界能停机 |

**依赖**：PR 5.2-C。
**风险**：HIGH。这里开始让子代理改代码。
**验收重点**：worker prompt/events/final 可审计；结构化输出失败会 gate；worker 不能直接提交。

---

### PR 5.2-E：Hooks + MCP Control Plane

**目标**：补齐安全带和控制面。

| 模块 | 工作项 | 验收 |
|------|--------|------|
| hooks | PreToolUse、PreCommit、Stop | Codex tool loop 内危险命令被挡 |
| hook policy | command allow/deny、protected paths、missing gate checks | 缺 detect/test/lint 不能 commit |
| MCP server | `loop_status`、`loop_run_until_gate`、`loop_resume`、`loop_step`、`loop_list_gates` | Codex 能通过 MCP 控制 loop |
| gate MCP | `loop_approve_gate`、`loop_reject_gate`、`loop_explain_gate` | gate 审批写入 decisions |
| artifact MCP | `loop_read_artifact`、PR/CI/review tools | UI 和 Codex 读同一份状态 |
| install/trust docs | hook trust、MCP 配置和插件启用说明 | 新工作区能按文档启用 |

**依赖**：PR 5.2-D。
**风险**：MEDIUM-HIGH。hook 误拦截会影响开发体验。
**验收重点**：hooks、CLI、MCP 同时访问状态库不互相覆盖；hooks 只声明覆盖 Codex tool loop。

---

### PR 5.2-F：P0 Dashboard

**目标**：本地 dashboard 可用于真实监督 loop。

| 页面 | 工作项 | 验收 |
|------|--------|------|
| P0 UX brief | 使用 Product Design 产出 P0 dashboard 信息架构、关键路径和状态清单 | brief 存档，P0 页面实现有依据 |
| Mission Control | current state、next action、PR/CI/review/GitNexus summary | 能判断是否可无人继续 |
| Gate Center | blocker、相关 artifacts、approve/reject/retry | 能处理 gate |
| PR Inbox | reviewThreads、CI checks、comment status | 能看哪些 review 已处理 |
| Worker Runs | prompt、final、events、changed files、scope status | 能审计 worker |
| Scope Guard | changed files、GitNexus impact/detect、sensitive paths | 越界风险可见 |
| Event Ledger | state transition、command、gate、test、CI、PR comment | 可复盘 |
| Artifact Diff Viewer | SPEC、diff、test report、GitNexus report、CI logs | artifact 可读 |
| Recovery Center | reality scan、checkpoint、resume action | 中断后能恢复 |

**依赖**：PR 5.2-E。
**风险**：MEDIUM。UI 要服务运维效率，不做营销页。
**验收重点**：`pnpm agent-loop dashboard` 打开本地 Web UI；P0 页面完整；UI 只通过 MCP/core API 读写状态。

---

### PR 5.2-G：P1 Product Polish + Config UX

**目标**：把 dashboard 从可用提升到产品化体验，并补配置 UX。

| 页面/能力 | 工作项 | 验收 |
|-----------|--------|------|
| P1 UX audit | 使用 Product Design 基于 P0 dashboard 截图审查信息架构、关键路径和风险操作 | audit 结论转成实现 checklist |
| Visual direction | 使用 Creative Production 生成至少 2 个 dashboard 视觉方向，并选择 1 个 implementation target | 有明确视觉目标，不混用多个方向 |
| Plan Navigator | Phase、已完成 PR、当前 PR、下一个候选 PR、issue 对应 | 用户知道 loop 为什么选这个 PR |
| Policy Config | auto merge、required checks、round limits、protected paths、worker sandbox | 不直接改 JSON 也能配置主要策略 |
| Dry-run Preview | 下一个 PR、分支名、worker、命令、可能 gate、缺失条件 | 放手前能确认方向 |
| Notifications | review/CI/gate/merge/worker failed schema parse | UI 内通知可用 |
| Visual polish | 按选定视觉方向收束布局、状态色、密度、日志/表格/卡片表现 | dashboard 达到产品级观感 |
| Design QA | 对照选定视觉目标和实现截图做 QA report | 无 P0/P1 设计阻塞；P2 follow-up 可追踪 |

**依赖**：PR 5.2-F。
**风险**：MEDIUM。范围容易发散。
**验收重点**：P1 页面可用；配置体验完整；UI 经过 design QA；不引入 Codex App 原生 UI 承诺。

---

## 配置

默认配置：

```text
.agent-loop/config.json
```

示例：

```json
{
  "repoId": "6tizer/llm_wiki",
  "baseBranch": "main",
  "branchPrefix": "codex/",
  "defaultWorkerBackend": "codex-exec",
  "maxReviewFixRounds": 3,
  "maxTestFixRounds": 2,
  "maxCiReruns": 1,
  "lintCommand": "pnpm lint",
  "testCommand": "pnpm test",
  "gitnexusRepo": "llm_wiki",
  "gitnexusRequired": true,
  "requiredChecks": ["check (macos-14)", "check (ubuntu-22.04)"],
  "requireReviewApproval": true,
  "allowAutoMerge": false,
  "plansDir": "docs/plans",
  "protectedPaths": [".git/**", ".agent-loop/**", ".env*", "**/*secret*"],
  "dashboard": {
    "enabled": true,
    "host": "127.0.0.1"
  }
}
```

默认必须保守：

- `requireReviewApproval=true`
- `allowAutoMerge=false`
- `maxCiReruns=1`
- `maxTestFixRounds=2`
- `gitnexusRequired=true`

允许用户显式开启 auto-merge，但 merge 前仍必须通过 gate 检查。

---

## GitHub 和 CI 语义

PR review 状态判断顺序：

1. 有 `CHANGES_REQUESTED` 或 unresolved actionable comment：进入 `FIX_REVIEW`。
2. 无 review 但 CI 红：进入 CI failure 分析；失败 job 可重跑一次。
3. CI 绿且 review approved：进入 `READY_TO_MERGE`。
4. CI 绿但无 review：保持等待或 gate，取决于配置。

评论处理规则：

- 只修当前 PR 范围内的问题。
- 越界建议写入对应计划文档，或 gate 给 supervisor。
- 修复后必须在 PR 留 comment，说明处理了哪些点，哪些点没有处理以及原因。

---

## 测试计划

### 单元测试

- 状态迁移：
  - 正常从 `SYNC_MAIN` 推进到 `DISCOVER_PROGRESS`。
  - `ambiguous_next_pr` 进入 `BLOCKED`。
  - review-fix 超过上限进入 `BLOCKED`。
- SQLite storage：
  - 初始化 schema。
  - 写入状态、事件、gate、artifact。
  - resume 读取当前 run。
  - 并发读写不会损坏当前状态。
- repo portability：
  - 缺少 config 时进入 `needs_repo_init`。
  - `init` 能生成最小 config。
  - `doctor` 能报告缺少 `gh` auth、plansDir、test command、GitNexus alias。
  - repo config 能覆盖 base branch、plansDir、lint/test command、required checks。
- command runner：
  - mock `git` / `gh` / `codex exec` / `gitnexus`。
  - 命令失败时记录 stderr 和 exit code。
  - destructive command 被 policy 拦截。
- hooks：
  - `git reset --hard` 被阻止。
  - worker 执行 commit/push/merge 被阻止。
  - commit 前缺少 detect changes 被阻止。
- MCP：
  - `loop_status()` 返回当前状态。
  - `loop_run_until_gate()` 推进到 gate。
  - `loop_approve_gate()` 写入 decision。
  - `loop_read_artifact()` 只读 artifact。
- UI：
  - Mission Control 能渲染 current state、next action、PR/CI/review/GitNexus summary。
  - Gate Center 能显示 blocker 并执行 approve/reject。
  - PR Inbox 能显示 review thread 状态和 comment 处理状态。
  - Worker Runs 能显示 prompt、final、events、changed files。
  - Scope Guard 能显示 GitNexus impact/detect 和越界状态。
  - Event Ledger 能显示 state transition 和 artifact links。
  - Artifact Diff Viewer 能显示 worker final、diff、test report。
  - Recovery Center 能显示 reality scan 和 resume action。
- worker 输出：
  - 解析结构化 JSON。
  - JSON 不合法时进入 `BLOCKED`。
  - worker 返回 out-of-scope 时进入 gate。

### 集成测试

- `pnpm agent-loop status` 在当前仓库能输出：
  - 当前分支。
  - 工作区是否干净。
  - GitNexus index 是否 fresh。
  - 当前 open PR 或 next candidate。
- 在临时 git repo 运行 `pnpm agent-loop init --dry-run`，能生成配置预览。
- 在缺少 config 的临时 repo 运行 `pnpm agent-loop run --dry-run`，进入 `needs_repo_init`。
- `pnpm agent-loop run --dry-run` 不改文件，不 push，不开 PR。
- mock GitHub 环境下跑完整状态机，覆盖 PR 创建、review-fix、CI green、merge 后 sync main。
- MCP server 启动后，CLI 和 UI 看到同一份 SQLite 状态。
- hooks、CLI、MCP 同时访问状态库时不产生互相覆盖。

### 手动验收

- 安装或启用插件。
- 在 `llm_wiki` 运行 `pnpm agent-loop init --dry-run`，确认能识别 GitHub remote、plansDir、lint/test command、GitNexus alias。
- 在一个临时 GitHub 测试 repo 或 fixture repo 运行 `pnpm agent-loop doctor`，确认不会写死 `llm_wiki`。
- 用一句话触发 skill：`进入 Autonomous PR Loop，继续跑到 gate`。
- 在干净 `baseBranch` 上运行 `pnpm agent-loop status`。
- 运行 `pnpm agent-loop run --dry-run`，确认下一个 PR 判断和命令计划正确。
- 人工制造一个状态文件，运行 `pnpm agent-loop resume`，确认不从头开始。
- 打开 dashboard，确认 P0 页面可用：Mission Control、Gate Center、PR Inbox、Worker Runs、Scope Guard、Event Ledger、Artifact Diff Viewer、Recovery Center。
- 用一个测试分支或临时 PR 验证：
  - 能读取 PR review comment。
  - 能生成 review-fix prompt。
  - 能识别 CI failed/success。
  - 不会在 auto-merge 关闭时自动 merge。

### 必跑

- 插件相关 Vitest。
- MCP server 测试。
- UI 组件测试。
- hook policy 测试。
- `pnpm lint`。
- 提交前 `npx gitnexus detect_changes --repo <gitnexusRepo> --scope staged`；在本仓库落地时为 `llm_wiki`。

---

## 风险和处理

| 风险 | 处理 |
|------|------|
| Phase 5.2 体积大 | 拆成 7 个 PR，每个 PR 只交付一层能力和对应测试 |
| PR 之间接口漂移 | shared core 的状态、gate、storage schema 和 command result 先稳定，后续只扩展不重复实现 |
| 迁移到其他 repo 时误用 `llm_wiki` 假设 | 所有 repo 特定值进入 `.agent-loop/config.json`，缺配置直接 gate |
| 非 GitHub 工作流无法支持 | 明确进入 `unsupported_remote` gate，不做硬兼容 |
| 目标 repo 没有计划文档 | `init` 可生成模板；进入 implement 前必须 gate |
| worker 改到当前 PR 以外的内容 | prompt 明确写入范围，SELF_CHECK 比对 changed files，越界则 gate |
| `codex exec` 输出不稳定 | 使用 `--output-schema`，解析失败进入 gate |
| review comment 越界 | 不自动修，记录到计划文档或交给 supervisor |
| CI flaky | 只允许自动 rerun 一次，仍红则 gate |
| SQLite 状态损坏 | 每次迁移和状态推进写 snapshot，`doctor` 提供诊断 |
| GitHub API/gh 认证失败 | gate 为 `needs_secret_or_login`，不要求 worker 处理 |
| GitNexus index stale | `SYNC_MAIN` 和 `SELF_CHECK` 自动跑 analyze/status，失败则 gate |
| hooks 误拦截 | 所有 hook 拦截必须写入 events，并提供明确 bypass/approve gate 路径 |
| UI 和 CLI 状态不一致 | UI 只通过 MCP/core 读写状态，不直接改 SQLite |
| Codex App 原生 UI 不可用 | 明确降级为本地 Web dashboard，不承诺原生嵌入 |
| hooks 覆盖范围被误解 | 文档和 UI 标明 hooks 只覆盖 Codex tool loop，不覆盖外部 Terminal |
| 子进程 token 成本过高 | 每个 worker prompt 只给 SPEC、必要 diff、必要日志，不塞完整聊天历史 |

---

## 成功标准

Phase 5.2 完成时应满足：

### 阶段性成功标准

- PR 5.2-A 合并后：插件 shell、skill、SQLite、repo init/doctor/status 可用。
- PR 5.2-B 合并后：状态机、command runner、events、artifacts、dry-run、resume 可用。
- PR 5.2-C 合并后：Git/GitHub/GitNexus 和 PR lifecycle 数据接入可用。
- PR 5.2-D 合并后：`codex exec` worker 可审计运行，越界和 schema 失败能 gate。
- PR 5.2-E 合并后：hooks 和 MCP 控制面可用。
- PR 5.2-F 合并后：P0 dashboard 可用于监督真实 loop。
- PR 5.2-G 合并后：P1 UI、配置体验、visual polish 和 design QA 完成。

### 最终成功标准

- 有可安装或可启用的 Autonomous PR Loop 插件结构。
- 插件可迁移：非 `llm_wiki` repo 能运行 `init --dry-run` 和 `doctor`，不会写死当前仓库。
- 有 `autonomous-pr-loop` skill，能一键进入 supervisor 角色。
- 有可运行的 `pnpm agent-loop init/status/run/resume/step/stop/doctor/logs/dashboard`。
- SQLite 是状态机唯一持久化来源。
- 状态机覆盖完整 PR 生命周期。
- `codex exec` worker 调用有落盘 prompt、events 和 final response。
- hooks 能阻止危险 git 命令和缺少门禁的 commit/merge。
- MCP 能暴露 loop 状态、gate、artifact、PR/CI 控制工具。
- UI P0 页面可用：Mission Control、Gate Center、PR Inbox、Worker Runs、Scope Guard、Event Ledger、Artifact Diff Viewer、Recovery Center。
- dry-run 不改文件、不 push、不开 PR。
- 状态中断后可以 resume。
- review-fix loop、CI wait/rerun、ready/merge 逻辑有测试覆盖。
- 默认配置不会自动 merge，除非明确开启。
- 所有 gate 都有清楚的 blocker reason。
- `.agent-loop/` 真实运行日志不进入 git。
- 相关测试和 `pnpm lint` 通过。
- 提交前 GitNexus detect changes 符合预期。

---

## 边界

- 不把插件变成永久后台 daemon；本 PR 只做按需运行和本地 dashboard。
- 不做 Codex App 原生嵌入式 UI。
- 不承诺 hooks 能拦截外部 Terminal 手动命令。
- 不做 GitHub webhook daemon。
- 不支持非 GitHub PR 平台，遇到 GitLab、Gitea、Bitbucket 等 remote 进入 `unsupported_remote` gate。
- 不保证没有计划文档的 repo 可以自动选择下一 PR；缺计划时只做初始化和 gate。
- 不引入远程服务。
- 不上传 worker prompt、diff、日志到第三方服务。
- 不实现 Codex SDK/app-server backend；它们保留为后续替换 `codex exec` 的可选 backend。
- 不改变 Phase 6 上游同步内容。
- 不把测试 API key、LLM token、GitHub token 或项目私有内容写入仓库、日志、PR 描述或快照。
