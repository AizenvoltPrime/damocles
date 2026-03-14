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
| `session/` | JSONL session persistence (`~/.claude/projects/`), `sdk-operations.ts` (SDK `tagSession`/`getSessionInfo` wrappers) |
| `shared/types/` | Domain-organized types |

### Message Routing

Both sides use domain-handler registries: `message-router/handlers/` (extension) and `message-handler/handlers/` (webview).

## Memory Module

WASM SQLite with FTS5 at `~/.damocles/memory.db`. MCP server + Zod schemas loaded via lazy ESM `import()`.

**Pull-first catalog model:** Injects a compact relevance-ranked catalog (~300-800 tokens) per prompt; Claude calls `get_memory_details` on demand. Pinned memories injected in full. Retrieval counts feed back into ranking. Observation staleness tracked via `FileChangeTracker` (`[stale]` at ≥3 file changes). Catalog limits configurable via `damocles.memory.catalog*` settings.

## Recall Module

Stateless queries (`persistSession: false`) + LLM-driven REPL loop that searches conversation history. Based on the RLM paper (arXiv 2512.24601v2).

**Graph pipeline:** Three-node `StateGraph` (custom LangGraph-inspired engine): `intentAnalysis` → `recallRepl` → `stateUpdate`. Intent classifies as `recall|debug|explain|feature|refactor|test|continuation|general` with optional `secondaryIntent` for multi-intent prompts. Extracts key entities. Graph state persisted to JSONL.

**REPL loop:** Turns persisted as `StructuredTurn` JSONL entries (message, response, tool calls, `filesTouched`). `JsRepl` sandbox (`vm.createContext`) where the model writes JS to search/filter history. `llm_query()` routes sub-calls to a cheap model (default Haiku). Up to 15 iterations, 120s total timeout. Results via `FINAL()`/`FINAL_VAR()`. This is a **context retrieval system** — returns relevant turns, not direct answers. Short-circuits: small history (`DIRECT_CONTEXT_THRESHOLD` 12K chars) → full context; continuation prompts → last 3-5 turns. SDK truncates `additionalContext` at 10K chars; recall chunks output into 9K pieces across overflow entries. Max chars configurable via `damocles.recallMaxInjectedChars` (default 200K).

**Subagent isolation:** `parentToolUseId` guards prevent subagent tool results from leaking into session JSONL. Deferred persistence ensures correct JSONL ordering when Agent tool_use blocks are pending. Agent results parsed via `extractAgentText()` (8K char limit vs 2K for others).

**Dual session IDs:** Stable `persistenceSessionId` (JSONL, checkpoints, webview) + rotating `sessionId` (per SDK query). Config flows through `ContextStrategyManager.buildRecallConfig()` — service never reads VS Code settings directly.

**Context injection viewer:** Per-prompt tabbed overlay (Graph | Recall | Memory) with push-based live streaming. Friendly/technical toggle with i18n.

**Test suite:** 350 tests across 17 files (Vitest). Unit, integration (golden-retrieval, e2e-pipeline, context-chunking, integration-quality, subagent-leak), and graph tests.

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
