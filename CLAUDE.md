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
| `claude-session/` | SDK integration: `query-manager.ts` (context usage, plugin reload), `system-prompt.ts` (custom system prompt builder), `streaming-manager/` (processor registry), tool/checkpoint/hook managers, `btw-handler.ts` (ephemeral side-questions) |
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
- **Review gate:** `team_approve_specialist` and `team_request_revision` mechanically blocked until all specialists are settled (dynamic `isReviewRoundReady()` check). `approveSpecialist()` also rejects if specialist has a pending revision (`pendingReportComplete` guard). Keep-alive message shows count-only for awaiting-review to suppress premature attempts
- **Lead broadcast filter:** `shouldDeliverMessage: (msg) => msg.to !== null` — lead only wakes on direct messages (`[REVIEW ROUND READY]`, specialist completion/failure, direct questions), not scratchpad broadcasts. Specialists handle cross-review autonomously via task prompts
- **Per-specialist AbortControllers:** Individual cancellation without aborting the whole team
- **Persistence:** Team JSONL + per-agent JSONL, serialized write queue with error accumulation

## Compass Module

Workspace knowledge graph via tree-sitter AST extraction → SQLite persistent storage → Louvain community detection → 7 MCP tools. Disabled by default (`damocles.compass.enabled`). Grammar WASM files fetched at build time (`npm run fetch:grammars`) into `resources/grammars/`.

**Key design decisions:**
- **SQLite-backed storage:** sql.js-fts5 with FTS5 content-sync triggers (same pattern as Memory module). Database at `~/.damocles/compass/<workspace-hash>/graph.db`. Atomic write-and-rename persistence. Two-phase lazy init
- **15 language extractors** (Python, JS, TS, TSX, Go, Rust, Java, C, C++, Ruby, C#, Kotlin, Scala, PHP, Vue SFC) following identical pattern: file → class/struct → function/method → import → call-graph (INFERRED). Shared base in `extractor-base.ts`: `addNode`, `addEdge`, `walkCalls`, `walkReferences`, `cleanEdges`, `runCallGraphPass`. Go method receivers attach to their struct via `getGoReceiverType`. JSX component usage (`<Foo />`) emits CALLS edges
- **7 MCP tools** across 3 domains: core graph (context, search, query, stats), impact analysis (blast_radius, review_context), admin (build). All support `detail_level` parameter. `review_context` auto-detects changed files via git when `changed_files` is omitted. Compass identifies WHICH files to read — it does not replace reading them
- **FTS5 BM25 search:** `splitIdentifier("CompassService")` → `"compass service"` enables partial-name search. Kind boosting (PascalCase → Class/Type, snake_case → Function). Content-sync triggers keep FTS in sync with nodes table
- **Impact analysis:** App-level BFS with visited Set from changed files through all 8 edge kinds bidirectionally. Risk scoring with security keywords, test gaps, flow participation, caller/referencer count
- **Execution flows:** Entry point detection → BFS call trees → criticality scoring (file spread, external calls, security, test gaps, depth)
- **Community detection:** Louvain via graphology-communities-louvain (temporary graph, deterministic ORDER BY). File-based fallback for >20K nodes. Pre-indexed edge lookup for O(communities × degree) cohesion
- **Incremental updates:** Git-based delta + SHA-256 file hash + transitive dependent invalidation (2-hop). Serialization after rebuild for crash recovery. Post-build `resolveExternalEdges()` fixes unambiguous bare-name targets for IMPORTS_FROM/INHERITS/IMPLEMENTS/DEPENDS_ON edges
- **Security:** Symlink skip, workspace root validation, `MAX_EXCLUDE_PATTERN_LENGTH` for ReDoS prevention, LIKE wildcard escaping, parameterized SQL throughout, FTS5 query sanitization
- **UI:** D3 force-directed graph (dynamic import, per-community), search panel with debounce, validation panel (broken edges, orphans, stale files, FTS sync), tree view with blast radius groups, editor gutter decorations, status bar
- **Per-turn context injection:** `UserPromptSubmit` hook injects `<damocles_compass>` XML with graph state/staleness. System prompt recommends Compass-first search when enabled
- **Recall integration:** `expandGraphTerms()` expands BM25 queries with graph neighbor labels
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

- **Custom system prompt:** `system-prompt.ts` builds a custom `systemPrompt: string` replacing the SDK's `claude_code` preset. Drops auto-memory (~800 tokens saved), integrates caveman-lite output rules, adds anti-verbosity Communication style section. Memory/Compass/Recall prompts conditionally concatenated. `tools: { type: "preset", preset: "claude_code" }` unchanged — tool schemas and built-in agents (general-purpose, Explore, Plan) still loaded from the preset
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
