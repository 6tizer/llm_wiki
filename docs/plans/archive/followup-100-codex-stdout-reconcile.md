# Follow-up #100: Codex stdout reconciliation

## SPEC

- Codex JSONL 的 `agent_message.text` 是完整 message，不是 token delta。
- Reconciliation 仅在 TypeScript 层实现，基于已发送完整 message 的有序集合/`Set`。
- Live event：解析到 `agent_message` 时，如果完整 `text` 未发送过，调用 `onToken(text)` 并记录；重复完整 `text` 不再发送。
- 成功 `done`：解析 `done` stdout，按 stdout 顺序补发未发送过的完整 `agent_message`；相同 message 不重复。
- `timeout` / non-zero：不补发 token；只把去重后的 stdout details 用于错误信息，避免重复已渲染 message。
- 无 Rust 改动；未来如果 Codex 引入真正 delta，再单独设计。

## Scope

- `src/lib/codex-cli-transport.ts`
- `src/lib/codex-cli-transport.test.ts`
- `docs/plans/followup-100-codex-stdout-reconcile.md`

## Non-goals

- 不修改 `src-tauri`。
- 不修改 `codex_cli.rs`。
- 不修改 CLI timeout/kill/sandbox/ephemeral/read-only 行为。
