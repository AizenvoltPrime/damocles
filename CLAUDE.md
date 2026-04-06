# CLAUDE.md

## Project Overview

Damocles is a VS Code extension that integrates Claude AI as a coding assistant using the Claude Agent SDK. Webview-based chat interface with diff approval, tool visualization, session management, and MCP server support.

## Development Commands

```bash
npm run build         # Build both extension and webview
npm run dev           # Watch mode for development
npm run typecheck     # Type checking
npm run lint          # Lint
npm test              # Run recall module tests (Vitest)
npm run package       # Package for distribution
```

**Testing:** Press F5 in VS Code to launch the Extension Development Host.

## Architecture

```
Extension Host (Node.js)                    Webview (Vue 3 + Pinia)
┌────────────────────────────┐              ┌──────────────────────────┐
│ ClaudeSession (SDK wrapper)│              │ App.vue + Pinia Stores   │
│ PermissionHandler          │◄─postMessage─│ message-handler/         │
│ ChatPanelProvider          │              │ Components               │
└────────────────────────────┘              └──────────────────────────┘
```

- **Extension:** esbuild → `dist/extension.js` (CJS). SDK, `sql.js-fts5`, `zod`, `web-tree-sitter` are external.
- **Webview:** Vite → `dist/webview/` (ESM). shadcn-vue + Tailwind + Shiki.
- **Type aliases:** `@shared/*` → `src/shared/*`, `@/*` → `src/webview/*`

### Key Modules

| Module | Purpose |
| --- | --- |
| `browser/` | Integrated browser via CDP: Chrome launch, screencast panel, element picker, 15 MCP tools |
| `claude-session/` | SDK integration: `query-manager.ts` (context usage, plugin reload), `streaming-manager/` (processor registry), tool/checkpoint/hook managers, `btw-handler.ts` (ephemeral side-questions) |
| `chat-panel/` | Webview management: panel, session, settings, message routing, history, workspace |
| `permission-handler/` | Tool permissions with domain-specific managers (approval, question, plan, skill, subagent, elicitation) |
| `memory/` | 5-tier persistent memory in WASM SQLite/FTS5. Two-phase lazy init. Pull-first catalog model with on-demand detail retrieval |
| `recall/` | Task-node-scoped context recall based on RLM paper. BM25 orientation → REPL sandbox retrieval. Per-node JSONL persistence |
| `voice/` | Speech-to-text via Whisper/Deepgram/Google Cloud |
| `team/` | Collaborative multi-agent teams: 2-5 specialists + lead via MessageBus + Scratchpad. 161 domain profiles from AgentLand |
| `compass/` | Workspace knowledge graph: tree-sitter AST extraction → graphology graph → Louvain clustering → 4 MCP tools |
| `session/` | JSONL session persistence with metadata cache for fast history listing |

### Patterns

- **Facade + DI:** Each module has an `index.ts` facade. Managers receive dependencies through constructor.
- **Two-phase lazy init:** Constructor reads config only; `ensureInitialized()` defers heavy work (WASM, DB, graph) to first access. Used by Memory, Compass.
- **Message routing:** Both sides use domain-handler registries: `message-router/handlers/` (extension) and `message-handler/handlers/` (webview).

## Memory Module

WASM SQLite with FTS5 at `~/.damocles/memory.db`. Lazy ESM `import()` for MCP server + Zod schemas. Pull-first catalog (~300-800 tokens per prompt); Claude calls `get_memory_details` on demand. Observation staleness tracked via `FileChangeTracker`.

## Team Module

2-5 specialist agents collaborate via in-process `MessageBus` + `Scratchpad`, coordinated by a lead agent. Each agent runs as an independent SDK `query()` with a scoped MCP server. Disabled by default (`damocles.team.enabled`).

**Key design decisions:**
- **Deliberative collaboration:** Lead facilitates (no independent research); specialists must read peer scratchpad sections and cross-reference before reporting
- **Two MCP server factories:** `createTeamMainMcpServer()` (3 tools for main session) and `createTeamAgentMcpServer()` (8 tools per agent, lead-only tools gated by role)
- **Event-driven keep-alive:** Lead blocks on bus notifications, wakes on specialist completion (no polling)
- **Synthesis guard:** `team_synthesize_result` rejects if any specialist still running — lead must wait or cancel
- **Per-specialist AbortControllers:** Individual cancellation without aborting the whole team
- **Persistence:** Team JSONL + per-agent JSONL, serialized write queue with error accumulation

## Compass Module

Workspace knowledge graph via tree-sitter AST extraction + Louvain community detection. Disabled by default (`damocles.compass.enabled`). Grammar WASM files fetched at build time (`npm run fetch:grammars`) into `resources/grammars/` — no tree-sitter grammar npm packages in dependencies.

**Key design decisions:**
- **12 language extractors** following identical pattern: file → class/struct → function/method → import → call-graph (INFERRED). Each `addNode()` call includes an `EntityKind` (`file`/`class`/`function`/`method`/`type`/`import`)
- **4 MCP tools as a targeting system:** `query_graph` (entity search → file paths), `inspect_node` (entity connections, depth=1 preferred), `graph_overview` (stats/hubs/community), `trace_path` (shortest path). Compass identifies WHICH files to read — it does not replace reading them. Budget: 2-3 Compass calls → 15+ targeted file Reads
- **Shared base** in `extractor-base.ts`: `makeId`, `addNode`, `addEdge`, `walkCalls`, `cleanEdges`
- **Must use `mergeEdge()` everywhere** — graphology throws on duplicate edges
- **SHA256 content-hash cache** for incremental rebuilds (~150ms vs 20-30s full)
- **Security:** Symlink skip, workspace root validation, `MAX_EXCLUDE_PATTERN_LENGTH` for ReDoS prevention
- **Recall integration:** `CompassTermProvider` interface expands BM25 queries with graph terms
- **Team integration:** Compass MCP server + prompt suffix passed to all team agents when both enabled

## Recall Module

Stateless queries (`persistSession: false`) + task-node-scoped context retrieval. Based on the RLM paper (arXiv 2512.24601v2).

**Key design decisions:**
- **Task nodes:** User-managed containers scoping turns to tasks. Max 5 concurrent active. Entity overlap connects related nodes.
- **Seed context:** New nodes extract relevant context from pre-node orphan history (direct if small, REPL if large)
- **Context retrieval:** Direct passthrough if under `maxInjectedChars` (400K default, zero LLM calls). REPL fallback only when over limit.
- **Two-stage REPL:** Stage 1 (auto-orientation: Haiku query expansion → BM25 ranking → chunk investigation) → Stage 2 (oriented retrieval in JS sandbox)
- **Per-node JSONL:** Turns written to `<sessionId>/nodes/<nodeId>.jsonl`. Main JSONL gets `node-turn-ref` entries.
- **Subagent isolation:** `parentToolUseId` guards + deferred persistence prevent leaks into session JSONL
- **Dual session IDs:** Stable `persistenceSessionId` (JSONL/checkpoints) + rotating `sessionId` (per SDK query)
- **`/btw` cross-node search:** Bypasses node scoping, searches all turns across all nodes

## SDK Integration

ClaudeSession wraps SDK `query()` with `canUseTool` → PermissionHandler, lifecycle hooks, `stream_event` delta handling. SDK dynamically imported (ESM from CJS).

- **Thinking:** `buildThinkingOptions()` uses `ModelInfo.supportsAdaptiveThinking` — no hardcoded model checks
- **Tool result normalization:** `normalizeToolResult()` — dual-path (live via `tool-manager.ts`, history via `history-manager.ts`)

## Permission Modes

| Mode          | Behavior |
| ------------- | -------- |
| `plan`        | Prompts for Edit/Write/Bash — SDK instructs Claude to plan first |
| `default`     | Shows diff view for Edit/Write, prompts for Bash |
| `acceptEdits` | Auto-approves Edit/Write, prompts for Bash |

Read-only tools auto-approved in all modes. YOLO mode (`dangerouslySkipPermissions`) auto-approves everything.

## Code Quality Standards

- Never implement fallback business logic, backwards compatibility, or bandaid fixes
- Address root causes rather than symptoms
- Write self-documenting code; avoid inline comments
- Prefer functional patterns over OOP
- Use Tailwind instead of custom CSS
- Prefer shadcn-vue components from `src/webview/components/ui/`
- **Dependency Injection**: Managers receive dependencies through constructor, wired in facade `index.ts`
- **Locality of Behavior**: Keep related code physically close
