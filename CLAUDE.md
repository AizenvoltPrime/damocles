# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Damocles is a VS Code extension that integrates Claude AI as a coding assistant using the Claude Agent SDK. It provides a webview-based chat interface with features like diff approval, tool visualization, session management, and MCP server support.

## Development Commands

```bash
npm install           # Install dependencies
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
|--------|---------|
| `claude-session/` | SDK integration: `index.ts` facade, `query-manager.ts`, `streaming-manager/`, `tool-manager.ts`, `checkpoint-manager.ts`, `hook-handlers.ts` |
| `chat-panel/` | Webview management: `panel-manager.ts`, `session-manager.ts`, `settings-manager/`, `message-router/`, `history-manager.ts`, `workspace-manager.ts` |
| `permission-handler/` | Tool permissions: `managers/` for approval, question, plan, skill, subagent domains. Centralized `PermissionState` |
| `memory/` | 5-tier persistent memory (session/project/global/notes/observations) in WASM SQLite with FTS5 |
| `context-distillation/` | Beta distill context strategy with Haiku observer: `index.ts` facade, `managers/` (haiku-annotation, subagent, entry-coordinator, ui-display) |
| `session/` | JSONL session persistence (`~/.claude/projects/`): reading, writing, branches, history, parsing |
| `shared/types/` | Domain-organized types: messages, session, settings, content, permissions, mcp, plugins, commands, subagents, memory, context-injection |

### Message Routing

Both sides use domain-handler registries with the same pattern:
- **Extension:** `message-router/handlers/` — chat, permissions, settings, sessions, history, workspace, providers, model, memory
- **Webview:** `message-handler/handlers/` — streaming, tools, permissions, sessions, settings, history, subagents, queue, UI, memory, context-injection

### Pinia Stores

`useUIStore`, `useSettingsStore`, `useSessionStore`, `usePermissionStore`, `useStreamingStore`, `useSubagentStore`, `useQuestionStore`, `usePlanViewStore`, `useTaskStore`, `useMemoryStore`, `useHaikuObserverStore`, `useContextInjectionStore`

## Memory Module

Uses `sql.js-fts5` (WASM SQLite with FTS5) — initialized once at activation, synchronous operations, persisted to `~/.damocles/memory.db` via 250ms debounced async writes.

**CJS/ESM boundary:** MCP server + Zod schemas are ESM. Solved via lazy `import()` in `getMcpServerConfig()` with dependency injection.

**Integration:** `QueryManager` appends `MEMORY_SYSTEM_PROMPT` → `hook-handlers.ts` injects FTS5-ranked memories in `UserPromptSubmit` → `chat-handlers.ts` intercepts `/remember`, `/note`, `/memories`

## Context Distillation Module

Alternative to SDK's session resume: each query runs stateless (`persistSession: false`) while Haiku annotates structured entries in a per-session FTS5 database via a single structured JSON output call. Context is retrieved using BM25 full-text search (with optional Haiku re-ranking) against the user's prompt and injected as system prompt prefix.

| File | Purpose |
|------|---------|
| `index.ts` | `ContextDistillationService` thin facade — dual session ID management, per-session database lifecycle, config, cross-manager event routing (subagent-vs-main dispatch, annotation trigger on response complete) |
| `utils.ts` | Pure stateless helpers — `loadSdkQuery()` (module-level cached SDK loader), `buildAgentAssistantEntry()`, `buildAgentToolResultEntry()`, `parseSubagentFinalContent()`, `buildAnnotationDisplayData()` |
| `managers/haiku-annotation-manager.ts` | `HaikuAnnotationManager` — annotation pipeline (`fireAnnotation()` → `runAnnotation()`), wait gate (`waitForReady()`/`cancelPendingWait()`), abort handling, Haiku JSONL log writing |
| `managers/subagent-manager.ts` | `SubagentManager` — subagent file init, write queues, thinking/tool-result routing (boolean returns for dispatch), final response assembly, `flushRemainingResponses()` |
| `managers/entry-coordinator.ts` | `EntryCoordinator` — `EntryTracker` lifecycle, assistant text accumulation, prompt index, `finalize()` snapshot for annotation handoff. Inserts synthetic `discussion` entry (type `discussion`, `file_path=null`) when `EntryTracker` returns zero entries but the assistant text buffer has content, ensuring text-only responses are annotated and searchable |
| `managers/ui-display-manager.ts` | `UIDisplayManager` — activity timeline (`getHaikuActivities()`), JSONL log parsing, context summary generation. Stateless |
| `context-database.ts` | Per-session SQLite FTS5 database: schema V1/V2/V3/V4/V5 migrations, CRUD operations, FTS5 triggers, `context_entries` + `entry_links` + `semantic_groups` + `context_injections` tables (V5 adds `decomposition_facets` column), `applyAnnotations()` batch apply (returns annotated IDs), annotation lifecycle (`setAnnotationStatus()`, `getFailedEntries()`), semantic group tracking (`upsertSemanticGroup()`, `getGroupEntries()`), `getRecentAnnotatedEntries()`, `getLinkedEntries()`, context injection persistence (`insertContextInjection()`, `getContextInjection()`) |
| `entry-tracker.ts` | `EntryTracker` groups tool calls by file path into pending context entries, committed on response complete |
| `context-retriever.ts` | Unified `retrieveContext()` pipeline with configurable token budget (`damocles.distillTokenBudget`): BM25-ranked entries filtered by `annotation_status = 'annotated'`, two-layer output (continuity + relevant context), stopword filtering, semantic group expansion (`expandSemanticGroups()`), optional reranking via `RetrievalOptions`, optional multi-pass retrieval via `runMultiPassRetrieval()` when decomposition facets provided, `decomposeQueryWithHaiku()` for query decomposition |
| `prompts.ts` | `STRUCTURED_ANNOTATION_SYSTEM_PROMPT` for single-pass annotation (with retry entry instructions and discussion entry guidance), `ANNOTATION_OUTPUT_SCHEMA` / `RERANKING_SCHEMA` / `DECOMPOSITION_SCHEMA` JSON schemas, `DECOMPOSITION_SYSTEM_PROMPT` for query decomposition, `buildAnnotationPrompt()` for per-turn Haiku input with current + historical + optional failed retry entries |
| `distill-persistence.ts` | Client-side JSONL session writing with `parentUuid` chain tracking and plan path persistence |
| `registry.ts` | Filesystem-based distill session registry (scans `.db` files in distill directory) |

**Annotation pipeline:** After each response, entries transition `pending → annotating` and Haiku runs a single `query()` with `outputFormat: { type: 'json_schema', schema: ANNOTATION_OUTPUT_SCHEMA }` — no MCP tools, no multi-turn. Input includes current entries + up to 30 historical annotated entries + up to 10 failed retry entries from prior prompts. Output: per-entry annotations (description, tags, confidence, semantic_group, low_relevance), cross-prompt links (depends_on/extends/reverts/related), and prompt summary. `applyAnnotations()` batch-applies everything, validating entry IDs (including retry IDs) and rejecting hallucinated ones, returning the list of successfully annotated IDs. Successfully annotated entries transition to `annotated`; unannotated entries are marked `failed` for retry on the next prompt. Semantic groups are upserted via `upsertSemanticGroup()`. If Haiku aborts, all in-flight entries are marked `failed`. Annotation is incremental — even partial structured output from retry errors is applied.

**Re-ranking (opt-in):** When `damocles.distillReranking` is enabled, the facade checks `getAnnotatedEntryCount()` against `RERANKING_MIN_ENTRIES` (25) — if below threshold, reranking is skipped and BM25 results are used directly (empirical breakeven: ~25-30 entries). Above threshold, `retrieveContext()` with reranking options widens BM25 to 100 results → takes top 40 → sends to Haiku for 0-10 relevance scoring via `RERANKING_SCHEMA` → selects by score → expands linked entries via `getLinkedEntries()` → expands semantic groups via `expandSemanticGroups()`. Falls back to BM25 on timeout/error.

**Query decomposition (opt-in):** When `damocles.distillQueryDecomposition` is enabled, `decomposeQueryWithHaiku()` uses Haiku to extract 1-4 keyword-rich search facets from the user's prompt via `DECOMPOSITION_SCHEMA`. Each facet runs as a separate BM25 query via `runMultiPassRetrieval()`, results are deduplicated (keeping best rank per entry), merged, and capped at the original limit. Orthogonal to reranking — both can be enabled simultaneously. Falls back to single-pass on timeout/error. Facets are persisted in `context_injections` table (V5 schema) and displayed in the context injection overlay.

**Dual session IDs:** Stable `persistenceSessionId` (UUID for JSONL, checkpoints, webview) + rotating `sessionId` (regenerated per SDK query). `ClauseSession.persistenceSessionId` getter returns the correct ID for the active mode.

**Config injection:** `ContextStrategyManager.buildDistillConfig(panelId)` constructs the full `DistillationConfig` (enabled, observerModel, tokenBudget, reranking, queryDecomposition) from per-panel strategy + VS Code settings. The service receives this via constructor and `refreshConfig()` — it never reads VS Code settings directly. `ClaudeSession.refreshDistillConfig(config)` passes config changes through. Token budget, re-ranking, and decomposition changes take effect on the next query without clearing the session.

**Integration:** `session-manager.ts` creates service with `buildDistillConfig(panelId)` → `sendMessage()` dual-path (distill waits for Haiku, persists client-side) → `UserPromptSubmit` hook passes user prompt to `getContextForInjection(prompt)` (async — runs optional decomposition, then BM25 ± reranking) → injects as `<distilled_session_context>` → `result-processor` triggers Haiku finalize → `reading.ts` `stitchDistillTurns()` patches `parentUuid` chains

**Subagent persistence:** `SubagentStart` hook → `SubagentManager.onSubagentStart()` creates `agent-{id}.jsonl` via `initSubagentFile()` → facade routes `persistAssistantData()` through `SubagentManager` first (boolean return for dispatch) → subagent data → agent JSONL, main data → `DistillPersistence` → `onSubagentDataReady` callback triggers `readAgentData()` + webview update

**Context injection viewer:** Per-prompt overlay showing what context was injected. `getContextForInjection()` optionally decomposes → always runs BM25, optionally runs Haiku reranking, stores both results + decomposition facets in `context_injections` table (V4+V5 schema). Webview flow: `MessageList.vue` always-visible inline pill (distill mode user messages) → `requestContextInjection` message → `workspace-handlers.ts` → `ClaudeSession.getContextInjection()` → `ContextDistillationService.getContextInjectionForPrompt()` → `getContextInjection()` DB read → `contextInjectionLoaded` response → `useContextInjectionStore` → `ContextInjectionOverlay.vue` with parsed structured entry cards. When reranking enabled, renders side-by-side BM25 vs reranked columns. When decomposition enabled, renders "Decomposition" badge and facets tag list. Shared type: `ContextInjectionDisplay` in `shared/types/context-injection.ts`.

## SDK Integration

ClaudeSession wraps the Agent SDK `query()` with `canUseTool` → PermissionHandler, lifecycle hooks (`PreToolUse`, `PostToolUse`, `SubagentStart/Stop`), and `stream_event` delta handling. Built-in agents: `code-reviewer`, `explorer`, `planner` in `AGENT_DEFINITIONS`. SDK is dynamically imported (ESM from CJS).

**Tool result normalization:** `normalizeToolResult()` in `utils.ts` transforms SDK wire formats into clean display strings. Applied in two paths: `tool-manager.ts` `handlePostToolUse` (live calls, receives raw SDK response object) and `history-manager.ts` `extractContentFromEntry` (history loading, receives `tool_result.content` string from JSONL). Normalizes WebSearch (structured object → markdown links + summary, text format → parse `Links: [...]` JSON), Read (structured object → extract `file.content`, cat-n text → strip line prefixes + `<system-reminder>` tags), and WebFetch (structured object → extract `result` field, JSON string → parse and extract). `extractReadMetadata()` extracts `numLines`/`startLine`/`totalLines` from the structured response for the overlay info card. Other built-in tools pass through unchanged via `serializeToolResult()`.

## Permission Modes

| Mode | Behavior |
|------|----------|
| `plan` | Prompts for Edit/Write/Bash — SDK instructs Claude to plan first, then seek approval via ExitPlanMode |
| `default` | Shows diff view for Edit/Write, prompts for Bash |
| `acceptEdits` | Auto-approves Edit/Write, prompts for Bash |

Read-only tools are auto-approved in all modes — Claude can't plan or work without reading the codebase. Modes only differ in how they handle write tools (Edit, Write, Bash). YOLO mode (`dangerouslySkipPermissions`) is orthogonal — an ephemeral per-panel toggle that auto-approves everything.

## Code Quality Standards

- Never implement fallback business logic, backwards compatibility, or bandaid fixes
- Address root causes rather than symptoms
- Write self-documenting code; avoid inline comments
- Use concise documentation comments for public APIs only
- Prefer functional patterns over OOP
- Use Tailwind instead of custom CSS
- Prefer shadcn-vue components from `src/webview/components/ui/` over raw HTML elements

### Architectural Patterns

- **Vertical Sliced Architecture**: Group related functionality together
- **Data-oriented Programming**: Separate data structures from functions
- **Locality of Behavior**: Keep related code physically close
- **Dependency Injection**: Managers receive dependencies through constructor, wired in facade `index.ts`
