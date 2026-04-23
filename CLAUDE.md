# CLAUDE.md

## Project Overview

Damocles is a VS Code extension that integrates Claude AI as a coding assistant via the Claude Agent SDK. Webview chat with diff approval, tool visualization, session management, MCP server support.

## Development Commands

```bash
npm run build         # Build extension + webview
npm run dev           # Watch mode
npm run typecheck     # Type checking
npm run lint          # Lint
npm test              # Vitest (recall module)
npm run package       # Package for distribution
```

Press F5 in VS Code to launch the Extension Development Host.

## Architecture

```
Extension Host (Node.js)                    Webview (Vue 3 + Pinia)
┌────────────────────────────┐              ┌──────────────────────────┐
│ ClaudeSession (SDK wrapper)│              │ App.vue + Pinia Stores   │
│ PermissionHandler          │◄─postMessage─│ message-handler/         │
│ ChatPanelProvider          │              │ Components               │
└────────────────────────────┘              └──────────────────────────┘
```

- **Extension:** esbuild → `dist/extension.js` (CJS). Externals: SDK, `sql.js-fts5`, `zod`, `web-tree-sitter`
- **Webview:** Vite → `dist/webview/` (ESM). shadcn-vue + Tailwind + Shiki
- **Type aliases:** `@shared/*` → `src/shared/*`, `@/*` → `src/webview/*`

### Key Modules

| Module | Purpose |
| --- | --- |
| `browser/` | Integrated CDP browser: Chrome launch, screencast panel, element picker, 15 MCP tools |
| `claude-session/` | SDK integration: `query-manager.ts`, `system-prompt.ts`, `streaming-manager/`, tool/checkpoint/hook managers, `btw-handler.ts` (ephemeral side-questions) |
| `chat-panel/` | Webview management: panel, session, settings, message routing, history, workspace |
| `permission-handler/` | Tool permissions via domain managers (approval, question, plan, skill, subagent, elicitation) |
| `memory/` | 5-tier persistent memory, WASM SQLite/FTS5, two-phase lazy init, pull-first catalog |
| `recall/` | Task-node-scoped context recall (RLM paper). BM25 → REPL sandbox. Per-node JSONL |
| `voice/` | STT via Whisper/Deepgram/Google Cloud |
| `team/` | 2-5 specialists + lead via MessageBus + Scratchpad. 161 AgentLand profiles |
| `compass/` | Knowledge graph: tree-sitter → SQLite → Louvain → 4 MCP tools |
| `session/` | JSONL session persistence + metadata cache for fast history |
| `auth/` | Damocles-owned OAuth, isolated from Claude Code CLI. Own credentials at `~/.damocles/auth/.credentials.json`, env-sanitized SDK spawns, dynamic `~/.claude/` mirror |

### Patterns

- **Facade + DI:** Each module has `index.ts`; managers receive deps via constructor
- **Two-phase lazy init:** Constructor reads config; `ensureInitialized()` defers heavy work (WASM, DB, graph) to first access. Used by Memory, Compass
- **Message routing:** Domain-handler registries — `message-router/handlers/` (extension), `message-handler/handlers/` (webview)

## Memory Module

WASM SQLite/FTS5 at `~/.damocles/memory.db`. Lazy ESM `import()` for MCP server + Zod schemas. Pull-first catalog (~300-800 tokens/prompt); Claude calls `get_memory_details` on demand. Staleness via `FileChangeTracker`.

## Team Module

2-5 specialists + lead via in-process `MessageBus` + `Scratchpad`. Each agent = independent SDK `query()` with scoped MCP server. Disabled by default (`damocles.team.enabled`).

- **Deliberative collaboration:** Lead facilitates (no independent research); specialists cross-reference peer scratchpad sections before reporting
- **Two MCP server factories:** `createTeamMainMcpServer()` (3 tools for main session), `createTeamAgentMcpServer()` (8 per-agent tools, lead-only gated by role)
- **Event-driven keep-alive:** Lead blocks on bus notifications, wakes on specialist completion. No hard turn cap — bounded by `KEEP_ALIVE_TIMEOUT_MS` (120s) and `MAX_KEEP_ALIVE_CYCLES` (20)
- **Synthesis guard:** `team_synthesize_result` rejects in order — **pending** → **active** → **unreviewed** → **recently-cancelled** → **stale-read**. No auto-cancel; lead resolves every pending explicitly
- **Wave dispatch:** `pending` only transitions to `running` or `cancelled`. `isReviewRoundReady()` / `notifyLeadIfReviewRoundReady()` operate on the **dispatched subset** — `[REVIEW ROUND READY]` fires once per wave
- **Review gate:** `team_approve_specialist` / `team_request_revision` blocked until all dispatched specialists settle. `approveSpecialist()` rejects pending-revision
- **Read-latest gate:** `Scratchpad` tracks per-reader section versions; approve + synthesize both reject when lead's last-read is below current version of any specialist-authored section. `[REVIEW ROUND READY]` lists sections with UNREAD/STALE/up-to-date markers. Pure helpers in `review-gate.ts` (`checkApprovalReadGate`, `checkSynthesisReadGate`, `formatReviewRoundReadyNotification`)
- **Strict section ownership:** `Scratchpad.set()` throws on non-original-author overwrite — each section owned by its first writer; peers communicate via separate sections (e.g., `reviewer-critique`)
- **Lead broadcast filter:** `shouldDeliverMessage: (msg) => msg.to !== null` — lead only wakes on direct messages, not scratchpad broadcasts
- **Per-specialist AbortControllers:** Individual cancellation without aborting the whole team
- **Persistence:** Team + per-agent JSONL, serialized write queue. `agent-completed` entries carry `name` (with `agentId` fallback) — pending cancellations survive reload

## Compass Module

Knowledge graph via tree-sitter AST → SQLite → Louvain → 7 MCP tools. Disabled by default (`damocles.compass.enabled`). Grammar WASM fetched at build time (`npm run fetch:grammars`) into `resources/grammars/`.

- **SQLite storage:** sql.js-fts5 with FTS5 content-sync triggers. DB at `~/.damocles/compass/<workspace-hash>/graph.db`. Atomic write-and-rename. Two-phase lazy init
- **15 language extractors** (Python, JS, TS, TSX, Go, Rust, Java, C, C++, Ruby, C#, Kotlin, Scala, PHP, Vue SFC): file → class/struct → function/method → import → call-graph (INFERRED). Shared base `extractor-base.ts` (`addNode`, `addEdge`, `walkCalls`, `walkReferences`, `cleanEdges`, `runCallGraphPass`). Go method receivers via `getGoReceiverType`. JSX `<Foo />` emits CALLS
- **7 MCP tools:** core (context, search, query, stats), impact (blast_radius, review_context), admin (build). All support `detail_level`. `review_context` auto-detects git diff when `changed_files` omitted. Compass identifies WHICH files to read — it does not replace reading them
- **FTS5 BM25:** `splitIdentifier("CompassService")` → `"compass service"` for partial-name search. Kind boosting (PascalCase → Class/Type, snake_case → Function). Content-sync triggers keep FTS aligned with `nodes`
- **Impact analysis:** App-level bidirectional BFS through all 8 edge kinds. Risk scoring via security keywords, test gaps, flow participation, caller/referencer count
- **Execution flows:** Entry-point detection → BFS call trees → criticality (file spread, external calls, security, test gaps, depth)
- **Community detection:** Louvain via graphology-communities-louvain (deterministic ORDER BY). Resolution scales inversely with graph size (`max(0.05, 1/log10(max(order,10)))`). Directory-based fallback >20K nodes (adaptive depth, strip common prefix, target ≥10 groups). Excludes TESTED_BY cross-edges. Pre-indexed edge lookup for O(communities × degree) cohesion
- **Incremental updates:** Git delta + SHA-256 hash + 2-hop transitive invalidation. Serialization after rebuild for crash recovery. Post-build `resolveExternalEdges()` fixes unambiguous bare-name targets for IMPORTS_FROM/INHERITS/IMPLEMENTS/DEPENDS_ON
- **Cooperative scheduler:** Two-queue (light/heavy); light reads preempt heavy builds at `scheduler.yield()` checkpoints. sql.js atomicity preserved (switches only at explicit `await`). Per-type `TIMEOUTS_BY_TYPE`. Progress via `WorkerProgressEvent` → `CompassService.onProgress(cb)`. Webview panels guard `onMounted` with `!loading && !result`
- **Security:** Symlink skip, workspace root validation, `MAX_EXCLUDE_PATTERN_LENGTH` (ReDoS), LIKE-wildcard + FTS5 query escaping, parameterized SQL
- **UI:** D3 force-directed graph (per-community, dynamic import), debounced search panel, validation panel (broken edges, orphans, stale files, FTS sync), tree view with blast-radius groups, gutter decorations, status bar
- **Integrations:** `UserPromptSubmit` injects `<damocles_compass>` XML per turn. Recall's `expandGraphTerms()` uses graph neighbors for BM25 expansion. Team agents receive Compass MCP + prompt suffix when both enabled

## Recall Module

Stateless queries (`persistSession: false`) + task-node-scoped retrieval. Based on the RLM paper (arXiv 2512.24601v2).

- **Task nodes:** User-managed containers scoping turns. Max 5 concurrent active. Entity overlap connects related nodes
- **Seed context:** New nodes extract from pre-node orphan history (direct if small, REPL if large)
- **Context retrieval:** Direct passthrough under `maxInjectedChars` (400K default, zero LLM calls). REPL fallback when over limit
- **Two-stage REPL:** (1) auto-orientation — Haiku query expansion → BM25 → chunk investigation. (2) oriented retrieval in JS sandbox
- **Per-node JSONL:** Turns in `<sessionId>/nodes/<nodeId>.jsonl`. Main JSONL gets `node-turn-ref` entries
- **Subagent isolation:** `parentToolUseId` guards + deferred persistence prevent session-JSONL leaks
- **Dual session IDs:** Stable `persistenceSessionId` (JSONL/checkpoints) + rotating `sessionId` (per SDK query)
- **`/btw`:** Cross-node search bypassing node scoping

## SDK Integration

`ClaudeSession` wraps SDK `query()` with `canUseTool` → PermissionHandler, lifecycle hooks, `stream_event` delta handling. SDK dynamically imported (ESM from CJS).

- **Custom system prompt:** `system-prompt.ts` builds a `systemPrompt: string` replacing SDK's `claude_code` preset. Drops auto-memory (~800 tokens saved), adds caveman-lite output rules + anti-verbosity Communication section. Memory/Compass/Recall prompts conditionally concatenated. `tools: { type: "preset", preset: "claude_code" }` unchanged — tool schemas + built-in agents (general-purpose, Explore, Plan) still loaded
- **Thinking:** `buildThinkingOptions()` via `ModelInfo.supportsAdaptiveThinking` — no hardcoded model checks
- **Tool result normalization:** `normalizeToolResult()` dual-path (live via `tool-manager.ts`, history via `history-manager.ts`)

## Auth Module

Damocles maintains its own OAuth grant, fully isolated from the Claude Code CLI. Credentials at `~/.damocles/auth/.credentials.json`; `~/.claude/.credentials.json` is never touched.

- **Single path source:** `paths.ts` exports `DAMOCLES_CONFIG_DIR`, `DAMOCLES_CREDENTIALS_PATH`, `CLI_CONFIG_DIR`
- **Per-call env sanitization (no `process.env` mutation):** `sdk-env.ts:buildSdkEnv()` returns a fresh sanitized env per call — shallow-copies `process.env`, strips `CLAUDE_CODE_OAUTH_TOKEN` + `ANTHROPIC_API_KEY`, pins `CLAUDE_CONFIG_DIR` to the Damocles dir. All SDK spawn sites pass via `options.env`. Never mutates `process.env` — VS Code runs every extension in one Node process; a global write would leak into peer extensions
- **Sign-in/out terminals:** `login-command.ts` spawns the bundled sidecar with `env: { CLAUDE_CONFIG_DIR: DAMOCLES_CONFIG_DIR }` and defensive `mkdirSync(..., { mode: 0o700 })`. Watchers target only the Damocles credentials path
- **Dynamic config-dir mirror:** `config-dir-bootstrap.ts` walks `~/.claude/` and surfaces every top-level entry (except `.credentials.json`) under `~/.damocles/auth/` — directories via symlink (`junction` on Windows, `"dir"` on Unix; no admin / no Developer Mode), files via atomic copy + per-file `fs.watch` (50ms debounce). 500ms debounced parent-dir watch rescans to propagate CLI-added plugins/skills/commands. Stale entries removed on rescan. All watchers tracked in `context.subscriptions`
- **No migration:** Existing CLI users sign in once in Damocles to mint a separate OAuth grant — sharing credentials would share the grant, defeating isolation

## Permission Modes

| Mode          | Behavior |
| ------------- | -------- |
| `plan`        | Prompts Edit/Write/Bash — SDK instructs Claude to plan first |
| `default`     | Shows diff for Edit/Write, prompts Bash |
| `acceptEdits` | Auto-approves Edit/Write, prompts Bash |

Read-only tools auto-approved in all modes. `dangerouslySkipPermissions` (YOLO) auto-approves everything.

## Code Quality Standards

- No fallback business logic, backwards compatibility, or bandaid fixes — address root causes
- Self-documenting code; avoid inline comments
- Prefer functional patterns over OOP
- Tailwind instead of custom CSS; shadcn-vue from `src/webview/components/ui/`
- **Dependency Injection:** Managers receive deps via constructor, wired in facade `index.ts`
- **Locality of Behavior:** Keep related code physically close
