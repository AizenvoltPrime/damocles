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

### Extension ↔ Webview Communication

```
┌─────────────────────────────────────────────────────────────┐
│                      Extension Host (Node.js)               │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐  │
│  │ ClaudeSession │──│PermissionHdlr│──│  ChatPanelProvider│  │
│  │ (SDK wrapper) │  │(tool approval)│  │ (webview manager) │  │
│  └──────────────┘  └──────────────┘  └──────────────────┘  │
│           │                                    │            │
│           │              postMessage           │            │
├───────────┼────────────────────────────────────┼────────────┤
│           ▼                                    ▼            │
│                      Webview (Vue 3 + Pinia)                │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │  App.vue ─── Pinia Stores ─── Components            │   │
│  │  message-handler/ (composable) handles all events   │   │
│  └─────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

### Key Extension Files

| File                                   | Purpose                                                   |
| -------------------------------------- | --------------------------------------------------------- |
| `src/extension/claude-session/`        | Claude Agent SDK integration (see module breakdown below) |
| `src/extension/chat-panel/`            | Webview panel management (see module breakdown below)     |
| `src/extension/permission-handler/`    | Tool permission handling (see module breakdown below)     |
| `src/extension/DiffManager.ts`         | Manages concurrent diff views for file changes            |
| `src/extension/SlashCommandService.ts` | Discovers and executes custom slash commands              |
| `src/extension/ripgrep.ts`             | Fast workspace file listing for @ mention autocomplete    |
| `src/extension/session/`               | Session persistence module (see Session Storage below)    |
| `src/extension/PluginService.ts`       | Discovers Claude Code plugins from registry and project   |
| `src/extension/CustomAgentService.ts`  | Discovers custom agents from project/user/plugin sources  |
| `src/extension/memory/`                | Persistent memory module (see Memory Module below)        |
| `src/shared/types/`                    | Modular type definitions (see Shared Types below)         |

### ClaudeSession Module (`claude-session/`)

The SDK integration is modularized into focused managers wired together via dependency injection:

| File                    | Responsibility                                                   |
| ----------------------- | ---------------------------------------------------------------- |
| `index.ts`              | Thin facade exposing public API, wires managers together         |
| `query-manager.ts`      | SDK lifecycle, streaming query creation, model/permission config |
| `streaming-manager/`    | Message processing module (see StreamingManager Module below)    |
| `tool-manager.ts`       | Permission handling, tool use correlation, result tracking       |
| `checkpoint-manager.ts` | File checkpointing, rewind operations, cost tracking             |
| `types.ts`              | Interfaces, agent definitions (`AGENT_DEFINITIONS`)              |
| `utils.ts`              | Shared utility functions                                         |

### StreamingManager Module (`streaming-manager/`)

Message processing is modularized into domain-specific processors:

| File                                  | Responsibility                                            |
| ------------------------------------- | --------------------------------------------------------- |
| `index.ts`                            | Public facade (`StreamingManager`), wires processors      |
| `types.ts`                            | Processor interfaces, message types                       |
| `state.ts`                            | `StreamingState` class for turn/content accumulation      |
| `utils.ts`                            | Pure helper functions (token extraction, content parsing) |
| `processor-registry.ts`               | Combines all processors into unified registry             |
| `processors/assistant-processor.ts`   | Assistant message start, streaming deltas                 |
| `processors/stream-event-processor.ts`| Thinking/text content block deltas                        |
| `processors/system-processor.ts`      | System messages, errors                                   |
| `processors/user-processor.ts`        | User message display, replay                              |
| `processors/result-processor.ts`      | Tool results, final responses                             |

### PermissionHandler Module (`permission-handler/`)

Tool permission handling is modularized into domain-specific managers:

| File                              | Responsibility                                              |
| --------------------------------- | ----------------------------------------------------------- |
| `index.ts`                        | Public facade (`PermissionHandler`), wires managers         |
| `types.ts`                        | Permission interfaces, pending approval types               |
| `state.ts`                        | `PermissionState` class for pending approvals/questions     |
| `utils.ts`                        | Pure helper functions (deny/allow result builders)          |
| `managers/approval-manager.ts`    | Edit/Write/Bash permission prompts, diff view coordination  |
| `managers/question-manager.ts`    | AskUserQuestion tool handling                               |
| `managers/plan-manager.ts`        | EnterPlanMode/ExitPlanMode approval flows                   |
| `managers/skill-manager.ts`       | Skill approval, pre-approval tracking                       |
| `managers/subagent-manager.ts`    | Subagent auto-approval for nested tool calls                |

### Memory Module (`memory/`)

Persistent memory system with 5 tiers stored in SQLite, integrated via hooks, MCP server, and slash commands:

| File                                   | Responsibility                                                      |
| -------------------------------------- | ------------------------------------------------------------------- |
| `index.ts`                             | MemoryService facade with all CRUD, search, observation, MCP methods |
| `database.ts`                          | SQLite open/close (`~/.damocles/memory.db`), migrations, universal FTS5 |
| `types.ts`                             | Internal types (`MemoryRow`, `FtsMatchRow`, `DatabaseInstance`), shared `rowToEntry()` |
| `mcp-server.ts`                        | 6 MCP tools with Zod schemas, SDK functions dependency-injected    |
| `system-prompt.ts`                     | `MEMORY_SYSTEM_PROMPT` constant: auto-injection, observation expansion, recording, searching, notes, slash commands |
| `managers/session-memory-manager.ts`   | Session-scoped memory CRUD                                          |
| `managers/project-memory-manager.ts`   | Workspace-scoped memory CRUD                                        |
| `managers/global-memory-manager.ts`    | Cross-workspace memory CRUD                                         |
| `managers/note-manager.ts`             | Knowledge base notes CRUD                                           |
| `managers/observation-manager.ts`      | Rich observations via MCP tool                                      |
| `managers/search-manager.ts`           | Multi-strategy search: FTS5 + file + temporal + type + tier         |
| `managers/injection-manager.ts`        | Prompt-aware FTS5 context injection with BM25 scoring, session handoff |

**WASM SQLite:** Uses `sql.js-fts5` (SQLite compiled to WASM with FTS5 enabled) instead of native `better-sqlite3`. The WASM engine is initialized once during extension activation (`initSqlEngine()` in `database.ts`), then all operations are synchronous. A compatibility wrapper in `database.ts` preserves the `prepare/get/all/run` API used by all managers. The in-memory database is persisted to disk (`~/.damocles/memory.db`) via a 250ms debounced async write queue, with synchronous flush on shutdown.

**CJS/ESM boundary:** The MCP server and Zod schemas are ESM; the extension is CJS. Solved via lazy `import()` in `getMcpServerConfig()` with SDK functions passed as parameters (dependency injection) so `mcp-server.ts` never directly imports ESM modules.

**Integration points:**
- `QueryManager` appends `MEMORY_SYSTEM_PROMPT` and provides 3 hook dependencies (`getMemoryContext`, `isFirstMessageOfSession`, `markFirstMessageSent`)
- `hook-handlers.ts`: UserPromptSubmit → extracts `prompt` for FTS5 scoring, adaptive injection + handoff
- `chat-handlers.ts`: Intercepts `/remember`, `/note`, `/memories` before SDK
- `memory-handlers.ts`: CRUD + search message handlers for webview panel

### ChatPanel Module (`chat-panel/`)

The webview panel management is modularized into focused managers:

| File                     | Responsibility                                                       |
| ------------------------ | -------------------------------------------------------------------- |
| `index.ts`               | Public facade (ChatPanelProvider), wires managers together           |
| `panel-manager.ts`       | Webview panel lifecycle, HTML generation, resource URIs              |
| `message-router/`        | Modular message routing (see MessageRouter Module below)             |
| `session-manager.ts`     | ClaudeSession lifecycle, coordinates with claude-session module      |
| `settings-manager/`      | Settings management module (see SettingsManager Module below)        |
| `history-manager.ts`     | Session list, history pagination, session CRUD operations            |
| `storage-manager.ts`     | Checkpoint persistence, rewind operations                            |
| `workspace-manager.ts`   | File indexing for @ mentions, workspace queries                      |
| `ide-context-manager.ts` | Active editor tracking, selection context injection                  |
| `queue-manager.ts`       | Message queuing while Claude is processing (tool boundary injection) |
| `types.ts`               | Internal interfaces for manager communication                        |

### MessageRouter Module (`message-router/`)

Webview↔extension message routing is modularized into domain-specific handlers:

| File                            | Responsibility                                                |
| ------------------------------- | ------------------------------------------------------------- |
| `index.ts`                      | Thin facade exposing public API, wires handlers together      |
| `types.ts`                      | Handler types, context interfaces, dependency definitions     |
| `utils.ts`                      | Shared utilities (plan message builder)                       |
| `handler-registry.ts`           | Combines all handlers into unified registry                   |
| `handlers/chat-handlers.ts`     | sendMessage, cancel, clear, queue, resume, interrupt, /remember /note /memories |
| `handlers/memory-handlers.ts`   | Memory CRUD + search message handlers                         |
| `handlers/permission-handlers.ts` | Edit/plan/skill approvals, question responses               |
| `handlers/settings-handlers.ts` | Model, thinking tokens, permissions, MCP, plugins             |
| `handlers/session-handlers.ts`  | Panel ready, session rename/delete                            |
| `handlers/history-handlers.ts`  | Rewind, history pagination, prompt history                    |
| `handlers/workspace-handlers.ts`| File operations, plans, slash commands, agents                |
| `handlers/provider-handlers.ts` | Provider profile CRUD operations                              |

### SettingsManager Module (`settings-manager/`)

Settings management is modularized into domain-specific managers, each owning its internal state:

| File                          | Responsibility                                                |
| ----------------------------- | ------------------------------------------------------------- |
| `index.ts`                    | Thin facade (`SettingsManager`), wires managers together      |
| `types.ts`                    | Internal interfaces (McpServerEntry, PluginEntry, PostMessageFn) |
| `utils.ts`                    | Pure helper functions (config sync, model validation)         |
| `managers/mcp-manager.ts`     | MCP server state, file watcher, enable/disable operations     |
| `managers/plugin-manager.ts`  | Plugin state, enable/disable with lock pattern                |
| `managers/provider-manager.ts`| Provider profile CRUD, per-panel tracking, SecretStorage      |
| `managers/config-manager.ts`  | VS Code config operations (stateless), model/thinking/permissions |

### MessageHandler Module (`message-handler/`)

Webview message handling is modularized into domain-specific handlers (mirrors `message-router/` pattern):

| File                              | Responsibility                                            |
| --------------------------------- | --------------------------------------------------------- |
| `index.ts`                        | Public facade (`useMessageHandler`), registry dispatch    |
| `types.ts`                        | HandlerContext, HandlerRegistry, ScrollBehavior types     |
| `utils.ts`                        | Shared utilities (feedback extraction, history conversion)|
| `handler-registry.ts`             | Combines all handlers into unified registry               |
| `handlers/streaming-handlers.ts`  | userMessage, assistant, partial, done, processing, error  |
| `handlers/tool-handlers.ts`       | toolStreaming, toolPending, toolCompleted, toolFailed     |
| `handlers/permission-handlers.ts` | requestPermission, requestQuestion, plan/skill approvals  |
| `handlers/session-handlers.ts`    | sessionStarted, sessionCleared, sessionCancelled          |
| `handlers/settings-handlers.ts`   | accountInfo, models, MCP servers, plugins, budget         |
| `handlers/history-handlers.ts`    | userReplay, assistantReplay, historyChunk, rewind/compact |
| `handlers/subagent-handlers.ts`   | subagentStart, subagentStop, model/messages updates       |
| `handlers/queue-handlers.ts`      | messageQueued, queueProcessed, queueCancelled             |
| `handlers/ui-handlers.ts`         | notification, panelFocused, languageChange, tokenUsage    |
| `handlers/memory-handlers.ts`     | memoriesUpdate, memoryCreated, memoryDeleted, searchResults, openMemoryPanel |

### Webview State (Pinia Stores)

| Store                | Responsibility                                                 |
| -------------------- | -------------------------------------------------------------- |
| `useUIStore`         | Panel visibility, processing state, scroll position            |
| `useSettingsStore`   | Model selection, thinking tokens, permission mode, MCP servers |
| `useSessionStore`    | Session list, history pagination, checkpoints, stats           |
| `usePermissionStore` | Pending tool approvals queue                                   |
| `useStreamingStore`  | Messages array, streaming message, tool status                 |
| `useSubagentStore`   | Subagent instances and their streaming states                  |
| `useQuestionStore`   | AskUserQuestion tool responses                                 |
| `useMemoryStore`     | Memory entries, search results, 5-tier computed filters        |

### Communication Flow

1. User types in ChatInput → `postMessage({ type: 'sendMessage', content })`
2. ChatPanelProvider receives → calls `ClaudeSession.sendMessage()`
3. ClaudeSession streams SDK responses → converts to `ExtensionToWebviewMessage`
4. `message-handler/` composable dispatches to appropriate Pinia stores

### Build Targets

- **Extension:** esbuild bundles `src/extension/` → `dist/extension.js` (CommonJS for Node.js)
- **Webview:** Vite bundles `src/webview/` → `dist/webview/` (ESM for browser)
- SDK, `sql.js-fts5`, and `zod` are external (not bundled) - listed in `esbuild.config.mjs`

## SDK Integration

ClaudeSession wraps the Agent SDK `query()` function with:

- **Tool permission handling:** `canUseTool` callback routes to PermissionHandler
- **Lifecycle hooks:** `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `SubagentStart/Stop`
- **Streaming:** Handles `stream_event` deltas for thinking/text content
- **Built-in agents:** `code-reviewer`, `explorer`, `planner` defined in `AGENT_DEFINITIONS`

The SDK is dynamically imported (ESM) since the extension uses CommonJS.

## Webview UI

- **Component Library:** shadcn-vue (radix-vue based) in `src/webview/components/ui/`
- **Styling:** Tailwind CSS with shadcn-vue color tokens (mapped from VS Code theme variables)
- **Icons:** Lucide icons via wrapper components in `src/webview/components/icons/`
- **Code Highlighting:** Shiki with VS Code themes

## Type Aliases

Configured in both tsconfig.json and vite.config.ts:

- `@shared/*` → `src/shared/*`
- `@/*` → `src/webview/*` (webview only)

## Permission Modes

| Mode                | Behavior                                                |
| ------------------- | ------------------------------------------------------- |
| `default`           | Shows diff view for Edit/Write, prompts for other tools |
| `acceptEdits`       | Auto-approves Edit/Write, prompts for Bash              |
| `bypassPermissions` | Auto-approves all tools                                 |
| `plan`              | Read-only mode, no tool execution                       |

## Shared Types (`src/shared/types/`)

Type definitions are organized by domain:

| File              | Purpose                                                |
| ----------------- | ------------------------------------------------------ |
| `constants.ts`    | Shared constants (model tiers, permission modes)       |
| `content.ts`      | Content block types, history message structures        |
| `mcp.ts`          | MCP server configuration and status types              |
| `plugins.ts`      | Plugin definitions and state                           |
| `commands.ts`     | Slash command and skill types                          |
| `permissions.ts`  | Tool permission request/response types                 |
| `settings.ts`     | Settings structures (model, thinking, providers)       |
| `session.ts`      | Session metadata, chat message, tool call types        |
| `subagents.ts`    | Subagent state and message types                       |
| `memory.ts`       | Memory tiers, observation types/tags, search/timeline types |
| `messages.ts`     | Extension↔Webview message discriminated unions         |

## Session Storage

Sessions are stored in `~/.claude/projects/<encoded-workspace-path>/` as JSONL files. The `session/` module handles persistence:

| File          | Responsibility                                        |
| ------------- | ----------------------------------------------------- |
| `paths.ts`    | Path encoding, session directory resolution           |
| `types.ts`    | JSONL entry types, session interfaces                 |
| `reading.ts`  | List sessions, read entries, extract stats            |
| `writing.ts`  | Initialize sessions, persist messages, rename/delete  |
| `branches.ts` | Active branch resolution (handles conversation forks) |
| `history.ts`  | Prompt history extraction for up/down navigation      |
| `parsing.ts`  | Parse content blocks from JSONL entries               |

## Code Quality Standards

- Never implement fallback business logic, backwards compatibility, or bandaid fixes
- Address root causes rather than symptoms
- Write self-documenting code; avoid inline comments
- Use concise documentation comments for public APIs only
- Prefer functional patterns over OOP
- Use Tailwind instead of custom CSS
- Prefer shadcn-vue components from `src/webview/components/ui/` over raw HTML elements

### Architectural Patterns

- **Vertical Sliced Architecture**: Group related functionality together (e.g., `claude-session/`, `chat-panel/`, `session/`)
- **Data-oriented Programming**: Separate data structures from functions that operate on them
- **Locality of Behavior**: Keep related code physically close together
- **Dependency Injection**: Managers receive dependencies through constructor, wired in facade `index.ts`
