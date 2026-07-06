# SPEC-7 Closeout Hotfix Plan

Branch: `codex/spec7-closeout-hotfix`

Scope:
- Add per-entry sha guards to batch wiki snapshot restore.
- Disclose runtime profile override fallback in `profile_resolved` and chat timeline.
- Hold the per-conversation rewind lock while single-write undo runs.
- Add compatible rewind gate detail for wiki-write block reasons and route dialog copy.
- Remove verified-dead i18n keys from English and Chinese bundles.

Non-goals:
- No schema migration.
- No change to existing `wiki_write_after_target` reason compatibility.
- No broad chat UI refactor.

GitNexus impact summary:
- `restoreAgentWikiSnapshots`: LOW, 2 direct dependents, Agent/Chat modules.
- `build_agent_profile_resolved_event` / `emit_agent_profile_resolved`: LOW, affects `agent_spawn` and `agent_rewind_session` event payloads.
- `ChatPanel`: HIGH by shared UI reach; change is scoped to profile disclosure and candidate refresh.
- `computeAgentRewindGateDecision`: HIGH by gate reach; change preserves existing reason and adds `detail`.
- `AgentRewindDialogHost`: HIGH by UI reach; change is copy selection only.
- `ReviewView`: LOW, scoped to locking around undo.

Implementation order:
1. Batch restore guard and tests.
2. Rust payload field and frontend profile mismatch status.
3. Dropdown refresh and tests.
4. Undo lock and gate detail copy/tests.
5. i18n cleanup after grep verification.

Verification:
- `npx vitest run src/lib/agent/ src/components/chat/ src/components/review/ src/stores/ src/i18n/i18n-parity.test.ts`
- `source .agent/scripts/build-env.sh && CARGO_TARGET_DIR=src-tauri/target RUSTC_WRAPPER= cargo test --manifest-path src-tauri/Cargo.toml agent`
- `npm run typecheck`
- `/usr/bin/git diff --check`
- GitNexus `detect_changes({scope:"compare", base_ref:"main"})`
