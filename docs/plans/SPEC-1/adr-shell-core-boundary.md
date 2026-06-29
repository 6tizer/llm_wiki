# ADR: SPEC-1 Shell/Core Boundary

> Status: frozen for SPEC-2 PR1 planning | Owner: Commander | Scope: SPEC-1 PR1

## Context

LLM Wiki currently ships as a Tauri + React desktop app. The product behavior is already broader than a UI shell: startup side effects, ingest queues, local servers, CLI sidecars, app settings, search/vector operations, and agent tool events all cross React, Zustand, Tauri commands, Rust process state, and disk files.

SPEC-1 freezes a shell-agnostic boundary before SPEC-2 adds the Work Runtime / SQLite ledger. This boundary prevents new runtime capability from binding to React component lifecycle, Zustand stores, Tauri plugin-store, or webview-only APIs.

## Decision

The app is split into five architectural ownership zones.

| Zone | Owns | Must not own |
| --- | --- | --- |
| UI Shell | Rendering, local interaction state, user input, shell lifecycle hooks, command invocation, event subscription | Business runtime state machines, queue ownership, persistent runtime truth, model/provider execution policy |
| Core Runtime | Product capability contracts, job/work APIs, markdown commit contract, profile contract, derived rebuild contract, agent-run contract, runtime health/status | React render dependencies, Zustand store dependencies, Tauri plugin APIs, platform-specific process/window/dialog code |
| Platform Adapter | Filesystem, Keychain/secret references, window/tray/dialog/open-url, local HTTP/clip/MCP server lifecycle, subprocess lifecycle, Tauri IPC bridge | Product decisions, job state machine semantics, markdown commit correctness |
| Agent Adapter | Claude Agent SDK sidecar today, future agent runtime integration, permission bridge, tool/timeline event transport | React UI state, direct wiki business rules outside the core/app tool contract |
| Storage Boundary | Markdown vault as user-owned long-term asset; runtime DB, vector/search indexes, derived artifacts, caches as local intermediate or rebuildable state | Treating rebuildable indexes or runtime ledger rows as the canonical wiki content |

Contract maturity:

- `draft`: discussion only.
- `frozen`: implementation PRs may depend on family names, ownership, and command/event direction.
- `stable`: Swift shell can depend on wire details and compatibility guarantees.

SPEC-1 PR1 freezes family names and ownership. Payload examples below are placeholders for tests and planning, not normative runtime schema. SPEC-2 owns the detailed job/runtime schema and state machine.

## Current Coupling Map

| Surface | Current coupling | Boundary owner | Migration note |
| --- | --- | --- | --- |
| `src/App.tsx` | Auto-save, clip watcher, update check, config hydrate, queue restore, file sync, agent cleanup live in React lifecycle | UI Shell calls bootstrap/runtime services | PR3 extracts explicit bootstrap boundary without changing behavior |
| `src/lib/ingest-queue.ts` | Global in-memory queue, JSON persistence, abort cleanup, activity store side effects | Core Runtime job API | SPEC-2 replaces queue truth with runtime ledger; old path remains until migrated |
| `src/lib/project-store.ts` | Tauri plugin-store access and shared `app-state.json` keys | Storage Boundary + Platform Adapter | PR4 separates UI settings, runtime state, project runtime state, and secret references |
| Direct `invoke()` outside `src/commands/*.ts` | Search/vector, embedding, agent/Claude/Codex transport, provider detection, settings actions call Tauri directly | Platform Adapter IPC facade | PR2 enforcement prevents new core code from adding direct shell/platform imports |
| `src-tauri/src/lib.rs` | Shell lifecycle, tray/window, proxy/bootstrap, command registry, sidecar/process state in one root | Platform Adapter + Shell bootstrap | Later PRs delegate by owner without changing command behavior |
| `src/commands/*.ts` | Thin Tauri invoke wrappers, not a stable core contract | UI Shell adapter facade | Wrappers map to frozen command/event families over time |
| Local servers and sidecars | Clip server, local API server, MCP server, proxy, Claude/Codex CLI, Agent SDK sidecar | Platform Adapter and Agent Adapter | Contract must name lifecycle/status/event surfaces before runtime integration |
| Search/vector/graph logic in `src/lib/*.ts` | Search/vector logic mixes business rules with Tauri vector commands; graph libraries are currently pure TypeScript business logic | Core Runtime + Derived/Search contracts | SPEC-6 consumes derived/search contracts after runtime/commit boundaries exist |

## Storage Boundary Lock

`app-state.json` is a cross-language schema. TypeScript writes through plugin-store, while Rust reads selected keys directly. Renaming or moving these keys without a compatibility adapter silently breaks app behavior.

Locked keys for current boundary work:

- `language`: read for tray labels.
- `closeBehavior`: read for close/hide behavior.
- `proxyConfig`: read for live proxy behavior.
- `apiConfig`: read by local API auth/status.
- `apiConfig.mcpEnabled`: read by local API metadata for MCP clients.

PR4 may design a replacement settings boundary, but it must preserve this schema lock or ship a compatibility adapter first.

## Runtime Command/Event Inventory

Each family lists command direction and event direction. Payload names are placeholders only.

| Family | Commands | Events | Placeholder payload/error model |
| --- | --- | --- | --- |
| Project | open, create, list recent, get health, resolve project identity | project opened, project health changed | `{ projectId, projectPath }`; errors use `{ code, message, retryable? }` |
| Job runtime | create, claim, heartbeat, cancel, retry, pause, resume, list | job queued, progress, failed, cancelled, completed | `{ jobId, kind, state }`; detailed state machine belongs to SPEC-2 |
| Markdown commit | submit artifact, commit path, report conflict, enqueue repair | artifact ready, commit applied, conflict detected, repair queued | `{ artifactPath, targetPath, hash }`; no final markdown write during prepare |
| Profiles | list, create, update, test, resolve secret reference, read capability status | profile changed, capability changed | `{ profileId, profileKind }`; no secret values in payloads |
| Derived | mark stale, claim rebuild, report building/ready/failed, manual rebuild | derived stale, rebuild started, rebuild finished | `{ artifactKind, scope, status }`; derived artifacts are rebuildable |
| Search/vector | search, upsert chunks, replace page chunks, delete page, count, optimize | index stale, index updated, index failed | `{ pageId, chunkCount, mode }`; vector rows are disposable cache |
| File/platform | read, write, atomic write, delete, list, copy, preprocess, canonicalize, file metadata | file changed, watcher queue updated | `{ path, relativePath? }`; platform adapter owns filesystem details |
| Process/CLI | detect CLI, spawn, kill, send response, read status | process started, stdout/stderr/log, process exited | `{ streamId, commandKind }`; subprocess lifecycle stays platform-owned |
| Agent run | start, stop, resume, rewind, continue/fork, permission response, tool response | timeline event, permission request, tool call, wiki changed, action required, partial message | `{ streamId, sessionId? }`; SPEC-7 owns detailed chat UX semantics |
| Settings/status | read runtime health, read feature flags, reload config, read migration status, read adapter capabilities | runtime health changed, setting changed, migration status changed | `{ key?, status }`; settings storage split belongs to PR4/SPEC-2 |

## Enforcement Hooks

SPEC-1 PR1 adds a minimal headless contract skeleton under `src/core-runtime/contract/`. It must be importable from Vitest without rendering React or opening Tauri.

PR2 expands this into static enforcement:

- core contract modules cannot import React components, Zustand stores, Tauri plugin APIs, or plugin-store;
- test coverage includes negative examples for forbidden imports;
- old coupled modules can still exist, but new core modules must stay clean.

## Consequences

- SPEC-2 can design runtime schema and state machine against frozen family names without coupling to React/Tauri.
- SPEC-3/4 can prepare contracts but must wait for SPEC-2 gates before runtime-schema-dependent integration.
- SPEC-9 Swift shell remains deferred, but the Swift path now has an adapter target rather than a rewrite target.
- Existing TS/Rust paths remain in place until strangler migrations replace them.
