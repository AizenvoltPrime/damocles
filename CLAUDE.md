# CLAUDE.md

## Project Overview

Damocles is a VS Code extension that integrates Claude AI as a coding assistant using the Claude Agent SDK. Webview-based chat interface with diff approval, tool visualization, session management, and MCP server support.

## Development Commands

```bash
npm run build         # Build both extension and webview
npm run dev           # Watch mode for development
npm run typecheck     # Type checking
npm run lint          # Lint
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
| `permission-handler/` | Tool permissions: `managers/` for approval, question, plan, skill, subagent domains |
| `memory/` | 5-tier persistent memory in WASM SQLite/FTS5. `file-change-tracker.ts` (staleness), `query-expansion.ts` (Haiku vocabulary enrichment) |
| `context-distillation/` | Haiku-annotated per-session FTS5 context: `index.ts` facade, `managers/` (haiku-annotation, subagent, entry-coordinator, ui-display) |
| `voice/` | Speech-to-text: `recorder.ts` (native audio capture), `transcription.ts` (Whisper, Deepgram, Google Cloud). Fails on Remote SSH |
| `session/` | JSONL session persistence (`~/.claude/projects/`) |
| `shared/types/` | Domain-organized types |

### Message Routing

Both sides use domain-handler registries: `message-router/handlers/` (extension) and `message-handler/handlers/` (webview).

## Memory Module

WASM SQLite with FTS5, persisted to `~/.damocles/memory.db`. MCP server + Zod schemas are ESM — solved via lazy `import()` with dependency injection.

**Flow:** `QueryManager` appends `MEMORY_SYSTEM_PROMPT` → `hook-handlers.ts` injects FTS5-ranked memories in `UserPromptSubmit` (async) → `buildInjectionContext` returns `{ context, metadata }` for the transparency overlay.

**Key subsystems:** Observation staleness via `FileChangeTracker` (tags `[stale]` at `fileChangeCount >= 3`, `reset_observation_staleness` MCP tool). Haiku query expansion in `adaptive` mode (index-time term generation + query-time synonym fallback). `RetrievalConfidenceTracker` scales budgets by 0.25–1.0 based on FTS score distributions (shared with distill).
## Context Distillation Module

Alternative to SDK session resume: stateless queries (`persistSession: false`) + Haiku annotates structured entries in per-session FTS5 database. Context retrieved via BM25 + optional Haiku re-ranking + optional query decomposition.

**Annotation:** After each response, entries → Haiku structured JSON → `applyAnnotations()` batch apply. Failed entries retry next prompt. Semantic groups tracked across prompts.

**Retrieval pipeline:** `context-retriever.ts` — BM25-ranked annotated entries, two-layer output (continuity + relevant), semantic group expansion. Opt-in re-ranking (Haiku scores top-40, min 25 entries). Opt-in query decomposition (1-4 facets via `runMultiPassRetrieval()`).

**Dual session IDs:** Stable `persistenceSessionId` (JSONL, checkpoints, webview) + rotating `sessionId` (per SDK query).

**Config:** `ContextStrategyManager.buildDistillConfig(panelId)` → service via constructor/`refreshConfig()`. Service never reads VS Code settings directly.

**Context injection viewer:** Per-prompt tabbed overlay (Distill | Memory). `MessageList.vue` pill → `workspace-handlers.ts` → `ContextInjectionOverlay.vue`. Types in `shared/types/context-injection.ts`.

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
