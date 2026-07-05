# LLM Wiki Agent

<p align="center">
  <img src="logo.jpg" width="128" height="128" style="border-radius: 22%;" alt="LLM Wiki Agent Logo">
</p>

<p align="center">
  <strong>An agentic knowledge workbench: one chat that builds, maintains, and answers from your personal wiki.</strong><br>
  Feed it documents — an LLM compiles a structured, interlinked wiki. Talk to it — a permission-controlled agent keeps that wiki current and puts it to work.
</p>

<p align="center">
  <a href="#what-is-this">What is this?</a> •
  <a href="#highlights">Highlights</a> •
  <a href="#how-it-works">How it works</a> •
  <a href="#features">Features</a> •
  <a href="#installation">Installation</a> •
  <a href="#agent--api">Agent &amp; API</a> •
  <a href="#credits">Credits</a>
</p>

<p align="center">
  English | <a href="README_CN.md">中文</a>
</p>

---

<p align="center">
  <img src="assets/overview.jpg" width="100%" alt="Overview">
</p>

## What is this?

LLM Wiki Agent is a macOS-first desktop app that turns a pile of documents into an organized, interlinked knowledge base — and gives you a single agentic chat to query it, direct it, and audit every change it makes.

Current active maintenance targets the Mac desktop app for Apple Silicon. Windows/Linux artifacts may exist in older releases or historical documentation, but they are legacy artifacts, not current active release or CI targets.

Most LLM-and-documents workflows look like RAG: you upload files, the model retrieves relevant chunks at query time, and answers from scratch. Nothing accumulates. LLM Wiki takes the opposite approach. The LLM **incrementally builds and maintains a persistent wiki** — a directory of markdown pages with cross-references, contradictions flagged, and an evolving synthesis. Knowledge is compiled **once** and kept current, not re-derived on every question.

The wiki is just markdown on disk: a git repo, an Obsidian vault, yours to keep. You curate sources and ask questions; the LLM does the reading, summarizing, cross-referencing, and bookkeeping. The long-term format direction is Google Open Knowledge Format (OKF)-compatible knowledge bundles, while keeping local wikilinks and Obsidian workflows intact.

It started as an implementation of [Andrej Karpathy's LLM Wiki pattern](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) and has grown into a full application with a knowledge graph, vector search, web research, a Chrome clipper, and a unified agentic chat whose permission-controlled agent can research and update the wiki on its own.

> **Fork status.** This project began as a fork of [nashsu/llm_wiki](https://github.com/nashsu/llm_wiki) and has since diverged into an independent product with its own version line (currently **0.7.0-alpha**): a unified chat entry (the Chat/Agent/Ingest mode switch is gone), an agent permission system, conversation rewind with write snapshots, a Wiki Health Center, a model profile pool, and a SQLite-backed work runtime. Credit for the original application belongs upstream; the two projects are no longer feature-equivalent, and this fork's update checks point at this repository.

<p align="center">
  <img src="assets/llm_wiki_arch.jpg" width="100%" alt="LLM Wiki Architecture">
</p>

## Highlights

- **Unified agentic chat** — one composer for everything: attach documents, scope sources, and let automatic routing decide how each message runs. Write-capable agent runs go through per-step permission approval (or read-only / skip-confirmations policies, switchable per conversation), every tool call lands on an activity timeline, each wiki write is reviewable and individually undoable, and whole conversations can be rewound with snapshot-backed file restore.
- **Wiki Health Center** — a derived-state dashboard (embeddings, tags, synthesis, index, overview) with one-click rebuilds, plus the lint and review inboxes, inside a five-section labeled navigation.
- **Model profiles & work runtime** — a profile pool with per-task-family assignment and automatic failover, a migration wizard from single-model config, and a SQLite job ledger (leases, crash recovery) underneath agent and ingest runs.
- **Two-step ingest** — the LLM analyzes a source first, then generates pages, with source traceability and SHA-256 incremental caching.
- **Knowledge graph** — a 4-signal relevance engine plus Louvain community detection, surfacing clusters, surprising connections, and knowledge gaps.
- **Hybrid search** — tokenized keyword search (English + CJK) with optional vector semantic search via LanceDB.
- **Deep Research** — finds knowledge gaps, runs multi-query web search (Tavily / SerpApi / SearXNG), and auto-ingests the findings.
- **Local-first** — everything is markdown on disk; works as an Obsidian vault; your data never leaves your machine except for the LLM/search API calls you configure.

## How it works

Three layers, three operations — the LLM owns the wiki, you own the sources and the questions.

```
Raw sources  →  Wiki  →  Schema + Purpose
(immutable)    (LLM-owned)   (your rules & intent)
```

- **Ingest** — drop a document in, the LLM reads it, writes a source summary, updates entity/concept pages, refreshes the index and overview, and logs what it did. A single source can touch 10–15 pages.
- **Query** — ask a question; the app retrieves relevant pages (keyword + vector + graph expansion), assembles a budgeted context, and the LLM answers with citations. Good answers can be filed back into the wiki.
- **Lint** — periodically health-check the wiki for contradictions, stale claims, orphan pages, and missing cross-references — with agent-driven auto-fix.

A wiki project on disk:

```
my-wiki/
├── purpose.md            # Goals, key questions, evolving thesis
├── schema.md             # Page types & structure rules
├── raw/
│   ├── sources/          # Your documents (immutable)
│   └── assets/           # Local images
├── wiki/
│   ├── index.md          # Content catalog (LLM navigation entry)
│   ├── log.md            # Chronological operation history
│   ├── overview.md       # Global summary (auto-updated)
│   ├── entities/         # People, orgs, products
│   ├── concepts/         # Theories, methods, ideas
│   ├── sources/          # Source summaries
│   ├── queries/          # Saved answers + research
│   ├── synthesis/        # Cross-source analysis
│   └── comparisons/      # Side-by-side comparisons
├── .obsidian/            # Obsidian vault config (auto-generated)
└── .llm-wiki/            # App config, chat history, review items
```

## Features

### Ingest & sources
- **Two-step chain-of-thought ingest** — analyze, then generate, for higher-quality pages
- **SHA-256 incremental cache** — unchanged sources are skipped to save tokens
- **Persistent ingest queue** — serial processing with crash recovery, cancel, and auto-retry
- **Folder import** — recursive import preserving structure; folder path used as a classification hint
- **Source folder auto-watch** — external changes in `raw/sources/` stay in sync (ingest + cascade delete)
- **Multi-format support** — PDF, DOCX, PPTX, XLSX/ODS, images, audio/video, web clips
- **Multimodal images** — extract embedded images from PDFs, caption them with a vision LLM, surface in search
- **Cascade delete** — removing a source cleans up its pages, index entries, and dead wikilinks while preserving shared entities

### Knowledge graph
- **4-signal relevance model** — direct links (×3), source overlap (×4), Adamic-Adar (×1.5), type affinity (×1)
- **Louvain community detection** — auto-discovered clusters with cohesion scoring
- **Graph insights** — surprising cross-community connections, isolated pages, sparse communities, bridge nodes
- **Interactive visualization** — sigma.js + ForceAtlas2, type/community coloring, hover highlighting, one-click Deep Research from gaps

### Search & query
- **Hybrid retrieval** — tokenized search (English words + CJK bigrams) with optional vector search (LanceDB)
- **Graph-expanded context** — top hits seed a 2-hop relevance traversal
- **Configurable context window** — 4K → 1M tokens with proportional budget allocation
- **Multi-conversation chat** — persistent sessions, cited references panel, regenerate, save-to-wiki, per-conversation model profile and permission overrides
- **Thinking display** — collapsible `<think>` reasoning blocks for DeepSeek / QwQ-style models
- **KaTeX math** — inline and block LaTeX rendering everywhere

### Research & review
- **Deep Research** — LLM-optimized topics, multi-query web search (Tavily / SerpApi / SearXNG), auto-ingest of findings
- **Async review queue** — the LLM flags items for human judgment with constrained actions and pre-generated search queries
- **Chrome Web Clipper** — one-click capture (Readability + Turndown) with auto-ingest

### Agent
- **Built-in agent (Claude Agent SDK)** — custom wiki MCP tools (`read_page`, `search_pages`, `update_page`, `create_entity` / `create_concept`, `get_graph`), hooks-based permission control, session resume / fork / continue, cost limits
- **Permission policies & activity timeline** — three policies (per-step confirmation / read-only / skip confirmations) switchable per conversation; every tool call and approval is recorded on the timeline, with the active model profile disclosed per run
- **Reviewable writes & rewind** — review every wiki page the agent wrote and undo individual writes; rewind a conversation to an earlier point with pre-write snapshots and fail-closed restore (later manual edits are never blindly overwritten)
- **Multi-agent pipeline** — 5 built-in roles (compiler / linter / fixer / synthesizer / qa) orchestrated in sequence or parallel
- **Property autofill** — auto-fill status and tags for concepts/entities during ingest
- **Lint loop** — agent-driven detection and auto-fix with concurrency control

### Platform
- **Mac-only active maintenance** — native desktop on macOS Apple Silicon via Tauri v2
- **Multi-provider LLM** — OpenAI, Anthropic, Google, Ollama, Azure, or any OpenAI-compatible endpoint
- **Local HTTP API** — token-protected `127.0.0.1` JSON API for external tools and agents
- **i18n** — English + Chinese interface
- **Obsidian-native** — the wiki directory is a ready-to-open vault

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Desktop | Tauri v2 (Rust backend) |
| Frontend | React 19 + TypeScript + Vite |
| UI | shadcn/ui + Tailwind CSS v4 |
| Editor | Milkdown (ProseMirror WYSIWYG) |
| Graph | sigma.js + graphology + ForceAtlas2 |
| Search | Tokenized + graph relevance + optional vector (LanceDB) |
| Documents | pdf-extract, docx-rs, calamine |
| State / i18n | Zustand · react-i18next |
| LLM | Streaming fetch — OpenAI, Anthropic, Google, Ollama, Azure, Custom |
| Web Search | Tavily, SerpApi, SearXNG |
| Agent | Claude Agent SDK via a Node.js sidecar |

The near-term product direction remains a Mac app built with Tauri, Rust, TypeScript, and the Agent SDK. Swift, SwiftUI, and iOS are tracked only as long-range architecture discussion, not near-term roadmap work.

## Installation

### Pre-built binaries

This fork has not published pre-built releases yet (the in-app update checker will tell you the same) — build from source below. A [Releases](https://github.com/6tizer/llm_wiki/releases) channel will open as the version line approaches 1.0. macOS Apple Silicon is the only active target; Windows/Linux artifacts in the upstream project's older releases are legacy artifacts of a diverged codebase.

### Build from source

```bash
# Prerequisites: Node.js 20+, Rust 1.70+
# Production Tauri builds also require Bun for the Agent sidecar binary.
git clone https://github.com/6tizer/llm_wiki.git
cd llm_wiki
npm install
npm --prefix src-tauri/sidecar install
npm run tauri dev      # Development
npm run tauri build    # Production build
```

### Chrome extension

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked** and select the `extension/` directory

## Quick Start

1. Launch the app and create a project (pick a scenario template — Research, Reading, Personal, Business, General)
2. **Settings** → configure your LLM provider (API key + model)
3. *(Optional)* configure web search providers, vector embeddings, and source folder auto-watch
4. **Sources** → import documents (PDF, DOCX, MD, …)
5. Watch the **Activity Panel** as the LLM builds wiki pages
6. **Chat** — one input for everything: ask questions, attach documents, scope context with **Sources ▾**, and let automatic routing decide how each message runs; agent runs that write to the wiki ask for permission step by step
7. Explore the **Knowledge Graph**, and keep things healthy in the **Wiki Health Center** — derived-state rebuilds plus the lint and review inboxes

## Agent & API

### Built-in Agent Sidecar

LLM Wiki Agent ships a built-in agent powered by the **Claude Agent SDK**, running as a bundled sidecar binary in production and a Node.js sidecar in development. It communicates with the Rust backend over stdin/stdout JSON-lines.

Terminology note: earlier versions of this app (and upstream llm_wiki, with its separate Chat Agent Router) exposed distinct **Chat / Agent / Ingest modes**. This fork removed the mode switch entirely: there is one composer, each message is routed automatically, and the Claude Agent SDK sidecar — with write-capable wiki tools, permission approval, and session lifecycle — is the single agent runtime.

- **Wiki MCP tools** — `read_page`, `search_pages`, `update_page`, `create_entity` / `create_concept`, `get_graph`
- **Hooks & permissions** — wiki tools auto-allowed within safe boundaries (writes restricted to `wiki/**/*.md`); built-in tools go through SDK permission approval
- **Session management** — resume / fork / continue, with cost controls (`maxTurns`, `maxBudgetUsd`)
- **Multi-agent pipeline** — orchestrate compiler / linter / fixer / synthesizer / qa roles

Any Messages-API-compatible backend works via `baseUrl` passthrough — Anthropic, OpenRouter, LiteLLM, Bedrock, and others.

### Local HTTP API

A token-protected JSON API on `http://127.0.0.1:19828` (localhost-only) lets external tools — Claude Code, Codex, or any HTTP client — query your wiki:

- `GET  /api/v1/health` — server status (no auth)
- `GET  /api/v1/projects` — list projects
- `GET  /api/v1/projects/{id}/files` · `files/content` — read files
- `POST /api/v1/projects/{id}/search` — hybrid retrieval (keyword + vector) with per-result scores
- `GET  /api/v1/projects/{id}/graph` — wikilinks graph
- `POST /api/v1/projects/{id}/sources/rescan` — trigger a backend rescan

Enable and generate a token in **Settings → API Server**. A ready-made agent skill is also available:

```bash
npx skills add https://github.com/nashsu/llm_wiki_skill.git --skill llm_wiki_skill
```

## Codebase Structure

```
src-tauri/                  # Rust backend (Tauri v2)
├── src/
│   ├── commands/
│   │   ├── file_ops/       # File sync, image extraction, filesystem
│   │   ├── search/         # Keyword / vector / hybrid search, vectorstore
│   │   ├── runtime_db/     # Work runtime: SQLite job ledger, leases, model profile pool
│   │   └── agent_cli/      # Agent sidecar bridge, Claude CLI, Codex CLI
│   ├── api_server.rs       # Local HTTP API server
│   └── lib.rs              # Entry point
└── sidecar/                # Agent Sidecar (Node.js)
    └── src/
        ├── main.ts         # Sidecar entry / stdin-stdout loop
        ├── core.ts         # SDK query() handler
        ├── wiki-tools.ts   # Custom MCP tool definitions
        ├── agent-hooks.ts  # PreToolUse / PostToolUse / Stop hooks
        └── permission-bridge.ts

src/                        # Frontend (React + TypeScript)
├── components/             # UI (layout, chat, graph, search, settings)
├── lib/                    # Core logic
│   ├── agent/              # Agent transport, pipeline, autofill, QA hooks
│   └── ingest*.ts          # Two-step ingest pipeline
├── stores/                 # Zustand state
└── i18n/                   # Internationalization
```

## Roadmap & versioning

Development runs as a sequence of SPECs (see the live index in [`docs/plans/`](docs/plans/)). SPEC-1 through SPEC-12 — architecture decomposition, the work runtime, model profiles, parallel knowledge pipelines, derived-knowledge rebuilds, unified agentic chat (SPEC-7), and the UI IA consolidation (SPEC-12) — are complete except three: SPEC-4 (model profile completion beyond the shipped baseline), SPEC-8 (maintainability tooling), and SPEC-9 (Swift shell, deferred).

This fork's version line restarted at **0.7.0-alpha**, independent of upstream's 0.5.x numbering. **1.0.0** lands when the remaining specs do; until then the app displays the `-alpha` channel suffix.

## Credits

The foundational methodology comes from **Andrej Karpathy**'s [llm-wiki.md](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) — the pattern of using an LLM to incrementally build and maintain a personal wiki. This project is a concrete implementation, originally forked from [nashsu/llm_wiki](https://github.com/nashsu/llm_wiki) and extended with the agent system, knowledge graph, vector search, and more.

## License

Licensed under the **GNU General Public License v3.0** — see [LICENSE](LICENSE).

## Star History

<a href="https://www.star-history.com/?repos=6tizer/llm_wiki&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=6tizer/llm_wiki&type=date&theme=dark&legend=top-left" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=6tizer/llm_wiki&type=date&legend=top-left" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=6tizer/llm_wiki&type=date&legend=top-left" />
 </picture>
</a>
