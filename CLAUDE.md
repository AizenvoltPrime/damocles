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

- **Extension:** esbuild → `dist/extension.js` (CJS). SDK, `sql.js-fts5`, `zod` are external.
- **Webview:** Vite → `dist/webview/` (ESM). shadcn-vue + Tailwind + Shiki.
- **Type aliases:** `@shared/*` → `src/shared/*`, `@/*` → `src/webview/*`

### Key Modules

| Module | Purpose |
| --- | --- |
| `claude-session/` | SDK integration: `index.ts` facade, `query-manager.ts`, `streaming-manager/` (map-based processor registry), `tool-manager.ts`, `checkpoint-manager.ts`, `hook-handlers.ts`, `btw-handler.ts` (ephemeral side-question queries) |
| `chat-panel/` | Webview management: `panel-manager.ts`, `session-manager.ts`, `settings-manager/`, `message-router/`, `history-manager.ts`, `workspace-manager.ts` |
| `permission-handler/` | Tool permissions: `managers/` for approval, question, plan, skill, subagent, elicitation domains |
| `memory/` | 5-tier persistent memory in WASM SQLite/FTS5. `file-change-tracker.ts` (staleness), `query-expansion.ts` (Haiku vocabulary enrichment) |
| `recall/` | Task-node-scoped context recall: `index.ts` facade, `node-manager.ts` (task node CRUD, entity overlap), `recall-loop.ts` (REPL iteration engine), `js-repl.ts` (vm sandbox), `sub-call-handler.ts`, `turn-persistence.ts` (per-node JSONL routing), `history-builder.ts` (node file merging), `subagent-manager.ts` (background agent persistence), `haiku-query.ts` (shared structured output utility), `summary-generator.ts` (node close summaries), `bm25.ts` (in-memory BM25 text search engine), `turn-indexer.ts` (write-time Haiku-powered turn summarization + keyword extraction), `orientation.ts` (auto-orientation pipeline: query expansion → BM25 ranking → chunk investigation) |
| `voice/` | Speech-to-text: `recorder.ts` (native audio capture), `transcription.ts` (Whisper, Deepgram, Google Cloud). Fails on Remote SSH |
| `session/` | JSONL session persistence (`~/.claude/projects/`), `sdk-operations.ts` (SDK `tagSession`/`getSessionInfo` wrappers) |
| `shared/types/` | Domain-organized types |

### Message Routing

Both sides use domain-handler registries: `message-router/handlers/` (extension) and `message-handler/handlers/` (webview).

## Memory Module

WASM SQLite with FTS5 at `~/.damocles/memory.db`. MCP server + Zod schemas loaded via lazy ESM `import()`.

**Pull-first catalog model:** Injects a compact relevance-ranked catalog (~300-800 tokens) per prompt; Claude calls `get_memory_details` on demand. Pinned memories injected in full. Retrieval counts feed back into ranking. Observation staleness tracked via `FileChangeTracker` (`[stale]` at ≥3 file changes). Catalog limits configurable via `damocles.memory.catalog*` settings.

## Recall Module

Stateless queries (`persistSession: false`) + task-node-scoped context retrieval. Based on the RLM paper (arXiv 2512.24601v2).

**Task nodes:** User-managed containers (`TaskNode`) that scope conversation turns to specific tasks. Each `StructuredTurn` has a `nodeId` (null for orphan turns predating the node system). `NodeManager` handles CRUD, two-tier entity extraction (Haiku-seeded on creation, deterministic on subsequent turns), and cross-node entity overlap computation (any shared entity triggers relation; manual disconnect via `manuallyDisconnectedNodeIds`; abandoned nodes excluded from overlap and creation context). Max 5 concurrent active nodes. Nodes persist to JSONL via `node-created`, `node-closed`, `node-reopened`, `node-seed-context`, and `node-state` checkpoint entries.

**Seed context:** When a new node first builds context, `extractSeedContext()` gathers orphan turns (pre-node history) and extracts relevant context. If orphan chars ≤ `DIRECT_CONTEXT_THRESHOLD` (12K) → includes all directly. If larger → runs REPL loop scoped to the node's title/prompt. Result stored as `TaskNode.seedContext` (per-node, persisted via `node-seed-context` JSONL entry). Different nodes can extract different seed contexts from the same orphan pool. Seed context is permanently prepended in `buildNodeContext()`. Users can regenerate seed context from the Session Node Overlay with a custom extraction instruction — `seedContextPrompt` persisted on `TaskNode`, regeneration runs through `runRecallLoop()` with `forceRepl`/`systemPromptOverride`/`initialPromptOverride` using dedicated prompts in `prompts.ts`.

**Context retrieval:** `buildNodeContext()` prepends `seedContext` (if present), gets the active node's turns via `buildDirectContext()`, appends related closed nodes' summary cards. If total chars ≤ `maxInjectedChars` (default 400K) → returns directly (zero LLM calls, the common path). If over limit → falls back to `runRecallLoop()` scoped to the node's turns only.

**REPL loop (fallback):** Two-stage architecture. **Stage 1 — Auto-Orientation** (`orientation.ts`, no root model calls): `buildOrientationContext()` expands query via Haiku, ranks turns with BM25 (`bm25.ts`), and if top score < 2.0 runs chunk investigation. **Stage 2 — Oriented Retrieval**: root model enters `JsRepl` sandbox with pre-ranked results, `turn_index` array, and `text_search(query)` BM25 function (max 8 iterations vs 15 unoriented). `llm_query()` routes sub-calls to Haiku. 120s total timeout. Results via `FINAL()`/`FINAL_VAR()`. Returns relevant turns, not direct answers. Small history (`DIRECT_CONTEXT_THRESHOLD` 12K chars) → full context directly. SDK truncates `additionalContext` at 10K chars; recall chunks into 9K pieces. Max chars configurable via `damocles.recallMaxInjectedChars` (default 400K). Also used for seed context regeneration via `forceRepl`/`systemPromptOverride`/`initialPromptOverride`.

**Turn indexing:** `turn-indexer.ts` — after each turn, Haiku generates `{ summary, keywords }` via `haikuStructuredQuery()`. Persisted as `turn-index` JSONL entries, patched back on reload via `applyTurnIndices()`. BM25 uses keywords for enriched scoring.

**Node lifecycle UI:** `NodeChip` (non-blocking popover in chat input bar — shows active node with color-coded states, click to switch or create new; auto-creates on prompt when `pendingNewNode` is set). `NodeClosePrompt` (inline banner after response — user selects outcome via Resolved/Partial/Abandoned buttons; outcome is authoritative, Haiku generates remaining summary fields). `SessionNodeOverlay` (dedicated overlay via top toolbar Layers button — two-column graph view with closed nodes left, active right, canvas bezier edges for relations; `TaskNodeCard` component with status indicators, entity badges, default badge, "Set Default" button, outcome popover for active cards; seed context regeneration with custom extraction instructions; collapsible "Recall Attempts" section showing per-node REPL history with orientation data). `useNodeStore` Pinia store with overlay state, selected node, `closingNodeIds` per-card loading, `pendingNewNode` state, `selectedNodeRecallAttempts`, and on-demand turn loading (`requestNodeTurns` → `nodeTurnsLoaded`). `useNodeFormatting` composable shares `formatAge()`/`outcomeBadgeClass()` across node components.

**`/btw` cross-node search:** `/btw` prompt-prefix bypasses node scoping, searches all turns across all nodes. Uses `getCrossNodeContext()` → `buildDirectContext()` or REPL fallback.

**Per-node JSONL files:** Turns are written to `<sessionId>/nodes/<nodeId>.jsonl` instead of the monolithic session file. Main JSONL receives `node-turn-ref` entries for branch tracking and leaf state. `buildSessionData()` and `readSessionEntriesPaginated()` merge node file entries by timestamp via `readNodeFileEntries()`/`mergeEntriesByTimestamp()`. `repairTaskNotificationBranching()` re-parents task-notification entries to prevent phantom sidechains.

**Subagent isolation:** `parentToolUseId` guards prevent subagent tool results from leaking into session JSONL. Deferred persistence ensures correct JSONL ordering when Agent tool_use blocks are pending. Agent results parsed via `extractAgentText()` (8K char limit vs 2K for others). Background agents (`run_in_background: true`) have tool calls tracked via `pendingToolCalls` in `SubagentManager`; on stop, prompt + tool pairs + final response are written to agent JSONL in order.

**Dual session IDs:** Stable `persistenceSessionId` (JSONL, checkpoints, webview) + rotating `sessionId` (per SDK query). Config flows through `ContextStrategyManager.buildRecallConfig()` — service never reads VS Code settings directly.

**Context injection viewer:** Per-prompt tabbed overlay (Recall | Memory | Node Context) with push-based live streaming. Always shows technical view (no friendly/technical toggle). Recall tab renders two stages — Stage 1 (Orientation: expanded terms, BM25 results, investigation report) with live phase streaming via `orientationPhaseUpdate`, Stage 2 (REPL iterations). Node Context tab shows injected turns as conversation cards (default) or raw `finalContext` text via Cards/Raw toggle. `RecallTrajectory` carries `nodeId`, `nodeTitle`, `contextTurns: NodeTurnDisplay[]`, `orientation: OrientationData | null` for the card view. `TaskNodeDisplay` enriched with `firstPrompt`, `filesTouched`, `lastActivity`.

**Test suite:** ~357 tests across 18 files (Vitest). Unit, integration (golden-retrieval, context-chunking, integration-quality, subagent-leak), node, BM25, turn-indexer, and orientation tests.

## SDK Integration

ClaudeSession wraps SDK `query()` with `canUseTool` → PermissionHandler, lifecycle hooks, `stream_event` delta handling. SDK dynamically imported (ESM from CJS).

**Thinking:** `buildThinkingOptions()` uses `ModelInfo.supportsAdaptiveThinking` — no hardcoded model checks. `DEFAULT_MODELS` in `constants.ts` pre-populates capabilities. Plan sites disable thinking via `disableThinkingForNextQuery()` override. `setPermissionMode()`/`setModel()` use `closeAndReset()` to recreate queries with new config.

**Tool result normalization:** `normalizeToolResult()` in `utils.ts` — dual-path (live via `tool-manager.ts`, history via `history-manager.ts`). Handles WebSearch, Read, WebFetch structured formats.

## Permission Modes

| Mode          | Behavior                                                                                              |
| ------------- | ----------------------------------------------------------------------------------------------------- |
| `plan`        | Prompts for Edit/Write/Bash — SDK instructs Claude to plan first, then seek approval via ExitPlanMode |
| `default`     | Shows diff view for Edit/Write, prompts for Bash                                                      |
| `acceptEdits` | Auto-approves Edit/Write, prompts for Bash                                                            |

Read-only tools auto-approved in all modes. YOLO mode (`dangerouslySkipPermissions`) is an ephemeral per-panel toggle that auto-approves everything.

## Code Quality Standards

- Never implement fallback business logic, backwards compatibility, or bandaid fixes
- Address root causes rather than symptoms
- Write self-documenting code; avoid inline comments
- Prefer functional patterns over OOP
- Use Tailwind instead of custom CSS
- Prefer shadcn-vue components from `src/webview/components/ui/`
- **Dependency Injection**: Managers receive dependencies through constructor, wired in facade `index.ts`
- **Locality of Behavior**: Keep related code physically close
