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
| `claude-session/` | SDK integration: `index.ts` facade, `query-manager.ts`, `streaming-manager/` (map-based processor registry), `tool-manager.ts`, `checkpoint-manager.ts`, `hook-handlers.ts` |
| `chat-panel/` | Webview management: `panel-manager.ts`, `session-manager.ts`, `settings-manager/`, `message-router/`, `history-manager.ts`, `workspace-manager.ts` |
| `permission-handler/` | Tool permissions: `managers/` for approval, question, plan, skill, subagent, elicitation domains |
| `memory/` | 5-tier persistent memory in WASM SQLite/FTS5. `file-change-tracker.ts` (staleness), `query-expansion.ts` (Haiku vocabulary enrichment) |
| `recall/` | RLM-based context recall: `index.ts` facade, `recall-loop.ts` (REPL iteration engine), `js-repl.ts` (vm sandbox), `sub-call-handler.ts`, `turn-persistence.ts`, `history-builder.ts`. `graph/` subsystem: `state-graph.ts` (LangGraph-inspired engine), `nodes/` (intent-analysis, recall-repl, state-update), `session-state.ts`, `recall-graph-state.ts` |
| `voice/` | Speech-to-text: `recorder.ts` (native audio capture), `transcription.ts` (Whisper, Deepgram, Google Cloud). Fails on Remote SSH |
| `session/` | JSONL session persistence (`~/.claude/projects/`) |
| `shared/types/` | Domain-organized types |

### Message Routing

Both sides use domain-handler registries: `message-router/handlers/` (extension) and `message-handler/handlers/` (webview).

## Memory Module

WASM SQLite with FTS5, persisted to `~/.damocles/memory.db`. MCP server + Zod schemas are ESM — solved via lazy `import()` with dependency injection.

**Architecture: Pull-first catalog model.** Instead of auto-selecting and injecting full memory content (push), the system injects a compact relevance-ranked catalog (~300-800 tokens) and Claude retrieves details on demand via `get_memory_details`. Session/project/global memories appear as short text entries; observations appear as titles + IDs only.

**Flow:** `QueryManager` appends `MEMORY_SYSTEM_PROMPT` → `hook-handlers.ts` calls `buildMemoryCatalog` in `UserPromptSubmit` (async) → returns `{ context, metadata }` for the transparency overlay. Claude browses the catalog and calls `get_memory_details` for what it needs.

**Pinned memories:** User-designated memories always injected as full content (up to `pinnedTokenBudget` tokens). MCP tools: `pin_memory`/`unpin_memory`. Memory Panel: hover pin/unpin toggle on all card templates. Stored via `pinned` column in `memories` table.

**Retrieval tracking:** `memory_retrievals` table records when Claude calls `get_memory_details`. Retrieval counts feed a `retrievalBoost` scoring signal (log-saturating at ~10 retrievals), creating a closed feedback loop: catalog → Claude retrieves → retrievals inform future ranking.

**Catalog limits (entry counts, not token budgets):** Session: all entries. Project: up to 15. Global: up to 10. Observations: up to 20. Configurable via `damocles.memory.catalog*` settings.

**Key subsystems:** Observation staleness via `FileChangeTracker` (tags `[stale]` at `fileChangeCount >= 3`, `reset_observation_staleness` MCP tool). Haiku query expansion available for index-time term generation.

## Recall Module

Alternative to SDK session resume: stateless queries (`persistSession: false`) + LLM-driven REPL loop searches conversation history. Based on the RLM paper (arXiv 2512.24601v2).

**Graph pipeline:** `RecallService` wraps the recall loop in a LangGraph-inspired `StateGraph` (custom engine in `graph/state-graph.ts`). Three-node pipeline: `intentAnalysis` (classifies query intent + extracts key entities) → `recallRepl` (runs the REPL search loop with intent-guided prompts) → `stateUpdate` (appends trace entry to `GraphSessionState`). The graph compiles into a `CompiledGraph` with typed annotations (`RecallGraphAnnotation`), execution snapshots, and abort signal propagation. Graph state and snapshots are persisted to JSONL and loaded on session resume.

**Intent classification:** `intentAnalysisNode` uses the subcall model (default Haiku) to classify queries as `recall`, `debug`, `explain`, `feature`, `refactor`, `continuation`, or `general`, and extracts key entities via `outputFormat: json_schema`. Skips the SDK call when the answer is deterministic (empty history, small history under `DIRECT_CONTEXT_THRESHOLD`, or `isContinuationPrompt()` heuristic match). Intent and entities flow into `buildRecallSystemPrompt()` as `<retrieval_strategy>` guidance via `buildIntentGuidance()`. This replaces the static strategy section that told the model to self-classify.

**How the REPL loop works:** Each turn is persisted as a structured JSONL entry (`StructuredTurn`: user message, assistant response, tool calls with inputs/results, thinking blocks, `filesTouched` pre-extracted file paths). Before each prompt, the `RecallLoop` loads history into a `JsRepl` sandbox (`vm.createContext`) and the root model writes JavaScript code to search/filter it. `llm_query()` routes sub-calls to a cheap model (default Haiku). Loop runs up to 15 iterations with a 120s total timeout and 60s per-iteration abort timeout. `FINAL()` / `FINAL_VAR()` results captured via structured `ExecutionResult` fields (not stdout parsing). The recall loop is a **context retrieval system** — it returns relevant conversation turns for the main model to interpret, not direct answers. Scaffold variables (`context`, `llm_query`, etc.) are restored after each execution via `restoreScaffold()`. User-declared variables (`const`/`let`/`var`) are persisted to `globalThis` via `hoistDeclarations()`, mirroring Python `exec()`'s shared namespace from the original RLM. When history is under `DIRECT_CONTEXT_THRESHOLD` (12K chars), the full context is returned directly without running the REPL loop. Continuation prompts (trivially content-free like "yes", "do it", "go ahead") are short-circuited via `isContinuationPrompt()` (word-set heuristic) or `intent === 'continuation'` (model classification) → `buildRecentFullContext()`, returning the last 3-5 turns with backwards expansion through chained continuation messages to find the original specific request. Short referential queries with domain keywords (e.g., "fix the auth bug") now flow through intent classification and the REPL search rather than being dumped as raw recent turns. The SDK's CLI layer truncates each `additionalContext` at 10K chars via `mFq()`. Recall output is chunked into 9K-char pieces across dynamically generated overflow hook entries (each gets its own 10K budget), with memory on a separate entry. Max injected chars configurable via `damocles.recallMaxInjectedChars` (default 200K chars ≈ 50K tokens, max 400K ≈ 100K tokens).

**Test suite:** 297 tests across 14 files via Vitest (`vitest.config.ts` with `@shared`/`@` path aliases). Unit: js-repl, parsing, prompts, types, trajectory-manager. Integration: recall-loop, golden-retrieval, e2e-pipeline, context-chunking. Graph: state-graph, recall-graph-state, session-state, state-update-node, graph-integration.

**Dual session IDs:** Stable `persistenceSessionId` (JSONL, checkpoints, webview) + rotating `sessionId` (per SDK query).

**Config:** `ContextStrategyManager.buildRecallConfig(panelId)` → service via constructor/`refreshConfig()`. Service never reads VS Code settings directly.

**Context injection viewer:** Per-prompt tabbed overlay (Graph | Recall | Memory). `MessageList.vue` pill → `workspace-handlers.ts` → `ContextInjectionOverlay.vue`. Graph tab: `GraphView.vue` (SVG DAG layout), `GraphNode.vue`, `GraphEdge.vue`, `GraphStateInspector.vue` — live updates via `graphExecutionUpdate` messages. Types in `shared/types/context-injection.ts`, `shared/types/graph.ts`, and `recall/types.ts`.

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
