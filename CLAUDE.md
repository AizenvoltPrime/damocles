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
| `context-distillation/` | Beta distill context strategy with Haiku observer |
| `session/` | JSONL session persistence (`~/.claude/projects/`): reading, writing, branches, history, parsing |
| `shared/types/` | Domain-organized types: messages, session, settings, content, permissions, mcp, plugins, commands, subagents, memory |

### Message Routing

Both sides use domain-handler registries with the same pattern:
- **Extension:** `message-router/handlers/` — chat, permissions, settings, sessions, history, workspace, providers, model, memory
- **Webview:** `message-handler/handlers/` — streaming, tools, permissions, sessions, settings, history, subagents, queue, UI, memory

### Pinia Stores

`useUIStore`, `useSettingsStore`, `useSessionStore`, `usePermissionStore`, `useStreamingStore`, `useSubagentStore`, `useQuestionStore`, `usePlanViewStore`, `useTaskStore`, `useMemoryStore`, `useHaikuObserverStore`

## Memory Module

Uses `sql.js-fts5` (WASM SQLite with FTS5) — initialized once at activation, synchronous operations, persisted to `~/.damocles/memory.db` via 250ms debounced async writes.

**CJS/ESM boundary:** MCP server + Zod schemas are ESM. Solved via lazy `import()` in `getMcpServerConfig()` with dependency injection.

**Integration:** `QueryManager` appends `MEMORY_SYSTEM_PROMPT` → `hook-handlers.ts` injects FTS5-ranked memories in `UserPromptSubmit` → `chat-handlers.ts` intercepts `/remember`, `/note`, `/memories`

## Context Distillation Module

Alternative to SDK's session resume: each query runs stateless (`persistSession: false`) while Haiku annotates structured entries in a per-session FTS5 database via MCP tools. Context is retrieved using BM25 full-text search against the user's prompt and injected as system prompt prefix.

| File | Purpose |
|------|---------|
| `index.ts` | `ContextDistillationService` facade, dual session ID management, Haiku wait gate, subagent JSONL persistence routing, per-session database lifecycle, streaming block extraction |
| `context-database.ts` | Per-session SQLite FTS5 database: schema, CRUD operations, FTS5 triggers, `context_entries` table with FTS5 content-sync |
| `entry-tracker.ts` | `EntryTracker` groups tool calls by file path into pending context entries, committed on response complete |
| `context-mcp-server.ts` | 4 MCP tools for Haiku: `list_prompt_entries`, `update_entry_description`, `mark_low_relevance`, `write_prompt_summary` |
| `context-retriever.ts` | FTS5 retrieval with configurable token budget (`damocles.distillTokenBudget`): BM25-ranked entries, two-layer output (continuity + relevant context), stopword filtering |
| `prompts.ts` | `HAIKU_CONTEXT_SYSTEM_PROMPT` for MCP-oriented annotation, `buildHaikuPrompt()` for per-turn Haiku input |
| `distill-persistence.ts` | Client-side JSONL session writing with `parentUuid` chain tracking and plan path persistence |
| `registry.ts` | JSON file tracking which sessions are distill-mode |

**Dual session IDs:** Stable `persistenceSessionId` (UUID for JSONL, checkpoints, webview) + rotating `sessionId` (regenerated per SDK query). `ClaudeSession.persistenceSessionId` getter returns the correct ID for the active mode.

**Config injection:** `ContextStrategyManager.buildDistillConfig(panelId)` constructs the full `DistillationConfig` (enabled, observerModel, tokenBudget) from per-panel strategy + VS Code settings. The service receives this via constructor and `refreshConfig()` — it never reads VS Code settings directly. `ClaudeSession.refreshDistillConfig(config)` passes config changes through. Token budget changes take effect on the next query without clearing the session.

**Integration:** `session-manager.ts` creates service with `buildDistillConfig(panelId)` → `sendMessage()` dual-path (distill waits for Haiku, persists client-side) → `UserPromptSubmit` hook passes user prompt to `getContextForInjection(prompt)` → `retrieveContextForPrompt()` builds FTS5 query with configurable token budget → injects as `<distilled_session_context>` → `result-processor` triggers Haiku finalize → `reading.ts` `stitchDistillTurns()` patches `parentUuid` chains

**Subagent persistence:** `SubagentStart` hook → `onSubagentStart()` creates `agent-{id}.jsonl` via `initSubagentFile()` → `persistAssistantData()` routes by `parentToolUseId` (subagent → agent JSONL, main → `DistillPersistence`) → `onSubagentDataReady` callback triggers `readAgentData()` + webview update

## SDK Integration

ClaudeSession wraps the Agent SDK `query()` with `canUseTool` → PermissionHandler, lifecycle hooks (`PreToolUse`, `PostToolUse`, `SubagentStart/Stop`), and `stream_event` delta handling. Built-in agents: `code-reviewer`, `explorer`, `planner` in `AGENT_DEFINITIONS`. SDK is dynamically imported (ESM from CJS).

**Tool result normalization:** `normalizeToolResult()` in `utils.ts` transforms SDK wire formats into clean display strings. Applied in two paths: `tool-manager.ts` `handlePostToolUse` (live calls, receives raw SDK response object) and `history-manager.ts` `extractContentFromEntry` (history loading, receives `tool_result.content` string from JSONL). Normalizes WebSearch (structured object → markdown links + summary, text format → parse `Links: [...]` JSON) and Read (structured object → extract `file.content`, cat-n text → strip line prefixes + `<system-reminder>` tags). `extractReadMetadata()` extracts `numLines`/`startLine`/`totalLines` from the structured response for the overlay info card. Other built-in tools pass through unchanged via `serializeToolResult()`.

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
