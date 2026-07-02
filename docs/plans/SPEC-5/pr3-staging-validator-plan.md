# SPEC-5 PR3: Staging Artifact Parser / Validator

> 类型：PR 执行计划 | 状态：merged via #240 | issue：#239 | tracking：#191 | branch：`codex/spec-5-pr3-staging-validator` | run：`8cdcc964-0471-4385-92c5-450b2017bcde`

## Summary

本 PR 把 PR2 的 prepare executor 输出收口为可提交前验证的 staging artifact。它定义 prepare output schema、验证 staged Markdown candidate、通过 runtime staging store 写入 staging 文件和 metadata，并把 schema / path / size / partial failure 问题转成可观察的 job failure 或 repair/review job。

PR3 不提交 final Markdown；PR4 才把 validated staging artifact 交给 SPEC-3 commit operation。

## Scope

- 新增 shell-neutral staging artifact parser / validator，输入是 model-call executor 的 structured prepare output。
- 验证字段：
  - `kind: "bulk-knowledge-prepare-output"`
  - `sourcePath`
  - `targetPath`
  - `artifactPath`
  - `operationIntent`
  - `sourceKind`
  - `markdown`
  - optional `baseHash`
  - optional bounded diagnostics。
- `artifactId` 不接受模型输出作为真值；worker 按 `jobId + normalized targetPath` 派生 deterministic id。
- 拒绝 bad schema、空 Markdown、unsafe target path、unsafe artifact path、oversized Markdown payload、oversized diagnostics、partial prepare failure。
- 新增 runtime staging store 命令 / TS wrapper，用后端写入 runtime staging 文件、按 PR4 hash 规则计算 hash、记录 `runtime_staging_artifacts` metadata。
- 新增 runtime staging pending cleanup 命令 / TS wrapper，用于清理一个 job 的 pending artifacts 和 staging files。
- 新增 nullable commit-intent metadata columns：`target_path`、`operation_intent`、`base_hash`、`source_kind`。旧 record request 不扩展，旧调用写入 `NULL`，新 store 命令负责填充。
- 扩展 prepare worker success outcome：若 executor 返回 artifacts，worker 先验证整组 candidate set，清理该 job 旧 pending artifacts，再逐个 store；store 失败则清理本轮 pending artifacts 并 fail 当前 prepare job。
- 对 validation / store failure 写 worker-owned progress payload，供 PR6 diagnostics 读取。
- 失败时创建 bounded `bulk-knowledge-artifact-repair` job；payload 只包含 artifact/source/error metadata，不包含 Markdown body。
- Validation/store failure 是本地 staging 故障，释放 model-call profile 时使用 `success` outcome，避免错误打开 provider circuit breaker。

## Non-goals

- 不调用 `commitMarkdownArtifact`。
- 不写 final Markdown。
- 不实现 long-document map-reduce。
- 不做 Runtime Diagnostics UI。
- 不扩展旧 `RuntimeStagingArtifactRecordRequest` 语义。
- 不把 staging artifact 正文存进 SQLite。
- 不为 `bulk-knowledge-artifact-repair` 实现 consumer worker。
- 不承诺 PR3 解决 PR5 chunk-level partial-success；PR3 只保证 partial prepare failure 可见。
- 不修改 legacy `src/lib/ingest-queue.ts` 串行 ingest 行为。

## Key Files

- 新增：`src/core-runtime/parallel-knowledge/staging-artifact.ts`
- 新增：`src/core-runtime/parallel-knowledge/staging-artifact.test.ts`
- 修改：`src/core-runtime/parallel-knowledge/index.ts`
- 修改：`src/lib/parallel-knowledge/prepare-worker-pool.ts`
- 修改：`src/lib/parallel-knowledge/prepare-worker-pool.test.ts`
- 修改：`src/lib/parallel-knowledge/prepare-worker-pool-runtime-adapter.test.ts`
- 修改：`src/commands/runtime-db.ts`
- 修改：`src/commands/runtime-db.test.ts`
- 修改：`src-tauri/src/commands/runtime_db.rs`
- 修改：`src-tauri/src/lib.rs`
- 修改：`docs/plans/README.md`
- 本计划：`docs/plans/SPEC-5/pr3-staging-validator-plan.md`

## GitNexus Impact

- `runtimeStagingArtifactRecord`: LOW; 2 direct callers plus wrapper tests. PR3 will not change existing wrapper semantics.
- `RuntimeStagingArtifactRecordRequest`: MEDIUM; imported by broad UI/runtime files. PR3 will not extend this old request shape.
- `RuntimeStagingArtifactRecord`: MEDIUM; imported broadly. PR3 will add optional nullable commit-intent fields; existing callers can continue ignoring them.
- `runtime_staging_artifact_record_for_project`: MEDIUM; Rust staging tests cover record/cleanup/list behavior. PR3 may reuse it from a new store helper without changing its public semantics.
- `runtime_staging_artifact_record`: LOW; no upstream callers.
- `runPrepareWorkerPool`: LOW; direct affected test only.
- `PrepareWorkerRuntimeAdapter`: LOW; affected tests only.
- `BULK_KNOWLEDGE_PREPARE_JOB_KIND`: LOW; PR3 consumes the constant only.

## Implementation Order

1. Add core parser / validator for prepare artifact output with small pure helpers and focused tests.
   - Reject model-provided `artifactId`; the worker owns deterministic artifact ids.
   - Reject duplicate `targetPath` within the same prepare job using NFC + lowercase resource-key normalization compatible with Rust `normalize_affected_path`.
   - Enforce `operationIntent` / `baseHash` coupling: `create` requires `baseHash: null`; `update` / `delete` require a non-empty `baseHash`; `append` accepts `null` only for new-target append.
   - Bound Markdown body to `MAX_PREPARE_ARTIFACT_MARKDOWN_BYTES = 2_000_000` and diagnostics to `MAX_PREPARE_ARTIFACT_DIAGNOSTICS_BYTES = 4096` before any runtime write.
2. Add Rust `runtime_staging_artifact_store` request / command:
   - validate enabled project and job id through existing runtime DB helpers.
   - normalize artifact path with existing staging path guard.
   - normalize target path with existing commit affected-path rules, not staging path rules.
   - store commit-intent metadata in nullable staging artifact columns.
   - write Markdown body under runtime staging root.
   - compute artifact hash from canonical Markdown body with the same CRLF -> LF and lone CR -> LF canonicalization as `hashMarkdownContent`.
   - record metadata through existing staging artifact record path.
   - avoid storing Markdown body in SQLite.
3. Add runtime DB migration for existing DBs:
   - bump staging artifacts family version.
   - `ALTER TABLE` add nullable commit-intent columns when missing.
   - hydrate those nullable fields in record/list/commit_success return paths.
4. Add store-file containment guard: create parent dirs under staging root, canonicalize parent and staging root, assert parent stays under root, reject symlinked intermediate dirs, write temp file under the same parent, then atomic rename.
5. Add `runtime_staging_artifacts_clear_pending_for_job` request / command to remove pending files and rows for one job before retry/re-store and after store failure.
6. Register commands in Tauri and add TS wrapper/types.
7. Extend prepare worker runtime adapter with `storeStagingArtifact`, `clearPendingArtifactsForJob`, and `createRepairJob`.
8. Extend success executor outcome with optional artifact candidates.
9. In worker success path, validate all artifacts, derive deterministic artifact ids from `jobId + normalized targetPath`, clear old pending artifacts for the job, then store artifacts before completing job.
10. On validation/store failure, clear pending artifacts for the job, release the profile as `success` with a local-staging reason, write progress, create bounded repair job when enough metadata exists, and fail the prepare job.
11. Add focused TS tests for valid artifact store, bad schema, unsafe path, oversized payload, partial failure, duplicate normalized target path, deterministic artifact id, pending cleanup ordering, and repair job payload excluding Markdown.
12. Add focused Rust tests for store writes file + metadata, persists commit-intent columns, rejects unsafe path, rejects symlink escape, bounds body size, disabled/no-project behavior, idempotent re-store, pending cleanup, CRLF/lone-CR hash parity, migration on existing DBs, and commit cleanup can remove stored file.
13. Update README execution order: PR2 merged by #238, PR3 current.

## Architect Gate Findings Absorbed

- Claude ACP session `87330688-dc30-4017-b3b1-55355fa00d05` returned WARN.
- P1 absorbed: commit-intent metadata cannot be validation-only. PR3 will persist `targetPath` / `operationIntent` / `baseHash` / `sourceKind` in nullable staging artifact columns populated by the new store command.
- P1 absorbed: artifact hash must match PR4 `hashMarkdownContent`; PR3 Rust store will canonicalize CRLF to LF before SHA-256 and focused tests will prove parity.
- P1 absorbed: validation/store failure releases model-call profile as `success`, because it is local staging failure, not provider health failure.
- P1 absorbed: store must be retry-idempotent using worker-derived deterministic `artifactId`, pending cleanup on store phase entry, and pending cleanup on store failure.
- P2 absorbed: production body write needs containment and symlink guards, not the current test-only `write_staging_file` helper.
- P2 absorbed: add explicit body size and diagnostics bounds.
- P2 absorbed: duplicate target paths in one prepare output are rejected by commit resource-key normalization, not raw string compare.
- P2 absorbed: existing runtime DBs need an additive nullable-column migration, not only a new `CREATE TABLE` shape.
- P2 absorbed: hash canonicalization includes CRLF and lone-CR parity.
- P2 absorbed: PR3 batch-level failure remains acceptable; PR5 owns chunk-level partial-success map-reduce.

## Gate Plan

- Architect Gate：Claude ACP，timeout `600000`；fallback Kimi/ZCode/internal。
- Coder：Commander may inline if Architect confirms the new Rust command is narrow and old staging record semantics remain stable.
- Focused tests before Simplicity:
  - `pnpm vitest run src/core-runtime/parallel-knowledge/staging-artifact.test.ts src/lib/parallel-knowledge/prepare-worker-pool.test.ts src/lib/parallel-knowledge/prepare-worker-pool-runtime-adapter.test.ts src/commands/runtime-db.test.ts`
  - `cargo test staging_artifact --manifest-path src-tauri/Cargo.toml`
- Simplicity Gate：ZCode read-only simplicity reviewer because this PR touches Rust DB + shared runtime.
- Tester Gate：Kimi static packet，timeout `600000`; fallback ZCode/internal。
- Reviewer Gate：ZCode external reviewer + internal reviewer。
- Final verification:
  - `pnpm lint`
  - `pnpm test`
  - `cargo test --manifest-path src-tauri/Cargo.toml`
  - `git diff --check`
  - `npx gitnexus detect-changes --repo llm_wiki --scope staged`

## PR Body Notes

- Record run id `8cdcc964-0471-4385-92c5-450b2017bcde`.
- Record all implementation PR gates, including Simplicity Gate.
- Record that PR3 adds validated staging artifact storage but does not commit final Markdown.
- Record MEDIUM GitNexus impact on Rust staging helper and TS staging record types.
