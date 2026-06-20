# CLAUDE.md

## Project Overview

Damocles is a VS Code extension that embeds an AI coding agent (Claude and GPT) in a Vue webview: chat with diff approval, tool visualization, session management, checkpoints/rewind, persistent memory, subagents, MCP, Compass, a CDP browser, teams, and voice. The agent runs on the **pi** runtime (`@earendil-works/pi-coding-agent`) — the sole backend.

## Development Commands

```bash
npm run build         # Build extension + webview
npm run dev           # Watch mode
npm run typecheck     # Type checking
npm run lint          # Lint
npm test              # Vitest (whole repo)
npm run package       # Package for distribution
```

Press F5 in VS Code to launch the Extension Development Host.

## Architecture

```
Extension Host (Node.js)                    Webview (Vue 3 + Pinia)
┌────────────────────────────┐              ┌──────────────────────────┐
│ PiSession (ChatSession)    │              │ App.vue + Pinia stores   │
│ PiRuntime (providers/auth) │◄─postMessage─│ message-handler/         │
│ PermissionHandler          │              │ components               │
│ ChatPanelProvider          │              │                          │
└────────────────────────────┘              └──────────────────────────┘
```

- **Seam:** the webview message contract (`ExtensionToWebviewMessage`) is fixed; `PiSession` is its only producer. The interface lives in `src/extension/chat-session.ts`.
- **Extension:** esbuild → `dist/extension.js` (CJS). Externals are the single-source list in `scripts/extension-externals.mjs` (pi packages, MCP SDK, `sql.js-fts5`, `zod`, `web-tree-sitter`, `@vscode/ripgrep`, `jiti`, `typebox`, …); `scripts/sync-vscodeignore.mjs` derives the VSIX node_modules allowlist from it (via the `vscode:prepublish` hook).
- **Webview:** Vite → `dist/webview/` (ESM). shadcn-vue + Tailwind + Shiki.
- **Type aliases:** `@shared/*` → `src/shared/*`, `@/*` → `src/webview/*`.

### Key Modules

| Module                | Purpose                                                                                                                    |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `pi-session/`         | The agent backend. `PiSession` (implements `ChatSession`), the process-global `PiRuntime` (provider registration, 3-mode Claude auth, pi-native OpenAI). Subdirs: `tools/` (CC-shaped `Edit`/`PowerShell`/`Task*`/`AskUserQuestion`/plan tools + re-wrapped memory/compass/browser/team module tools + native web tools), `session-store/` (tree-JSONL sessions, titles, rename/tag/delete, rewind), `checkpoints/` (per-session bare-git shadow repo: checkpoint/rewind/fork), `subagents/` (native nested agents: `Agent`/`GetSubagentResult`/`SteerSubagent`), `mcp/` (native MCP client), `web-access/` (native key-free web tools). `pi-stream-adapter.ts` + `tool-normalization.ts` map pi events onto the unchanged webview shapes. |
| `chat-panel/`         | Webview management: panel, session manager, settings, message routing, history                                            |
| `permission-handler/` | Tool permissions via domain managers (approval, question, plan, skill, subagent)                                           |
| `memory/`             | Kind/scope memory + fact graph, auto-extraction, WASM SQLite/FTS5, pull-first catalog                                      |
| `compass/`            | Knowledge graph: tree-sitter → SQLite → Louvain → MCP tools (disabled by default)                                         |
| `browser/`            | Integrated CDP browser + MCP tools (disabled by default)                                                                   |
| `team/`               | Provider-agnostic multi-agent teams via MessageBus + Scratchpad (disabled by default)                                      |
| `voice/`              | STT via Whisper/Deepgram/Google Cloud + on-device Jarvis sidecar (disabled by default)                                     |
| `auth/`               | Shared filesystem path constants (`~/.damocles` home, `auth`/`plans`/`explores` dirs, `workspaceHash`). Credential & provider auth now live in `pi-session/` (`subscription.ts`, `openai-auth.ts`, `agent-dir.ts`, MCP auth flows) |

### Patterns

- **Facade + DI:** Each module has `index.ts`; managers receive deps via constructor.
- **Two-phase lazy init:** Constructor reads config; `ensureInitialized()` defers heavy work to first access (Memory, Compass).
- **Message routing:** Domain-handler registries — `message-router/handlers/` (extension), `message-handler/handlers/` (webview).

### Invariants

- pi is the only agent engine; new sessions always construct `PiSession` — there is no harness selection.
- Don't change the webview message contract to add a feature — map pi events to existing shapes via `pi-stream-adapter.ts` / `tool-normalization.ts`.
- `Edit` cannot create files (empty `old_string` throws); `Write` is the only creation path.
- All tool calls route through the central permission gate (`permission-gate.ts`): read auto-allowed, write/shell → diff approval, plan mode → read-only set.
- Internal sub-calls (memory, structured output) use `PiRuntime.runStructuredCompletion` + the terminating-tool idiom (no `toolChoice` — subscription OAuth can't force tools).
- Never mutate `process.env` for per-session config; pi reads a Damocles-owned `agentDir` (`~/.damocles/pi/agent`).
- Implementation gotchas live in the code and in memory observations — search those before assuming.

## Permission Modes

| Mode          | Behavior                                                                |
| ------------- | ----------------------------------------------------------------------- |
| `plan`        | Restricts the active tool set to read-only + interactive; prompts Edit/Write/Bash/PowerShell |
| `default`     | Shows diff for Edit/Write, prompts Bash/PowerShell                      |
| `acceptEdits` | Auto-approves Edit/Write, prompts Bash/PowerShell                       |

Read-only tools are auto-approved in all modes. `dangerouslySkipPermissions` (YOLO) auto-approves everything.

## Code Quality Standards

- Self-documenting code; avoid inline comments
- Prefer functional patterns over OOP
- Tailwind instead of custom CSS; shadcn-vue from `src/webview/components/ui/`
- **Locality of Behavior:** Keep related code physically close

## Behavioral Principles

### 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

### 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

### 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- Remove imports/variables/functions that YOUR changes made unused; leave pre-existing dead code (mention it instead).

The test: Every changed line should trace directly to the user's request.

### 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan with a verification step per item. Strong success criteria let you loop independently.
