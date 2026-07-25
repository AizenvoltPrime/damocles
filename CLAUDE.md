# CLAUDE.md

## Project Overview

Damocles is a VS Code extension that embeds an AI coding agent (Claude and GPT) in a Vue webview: chat with diff approval, tool visualization, session management, checkpoints/rewind, persistent memory, subagents, MCP, Compass, a Patchright browser, teams, and voice. The agent runs on the **pi** runtime (`@earendil-works/pi-coding-agent`) — the sole backend.

## Development Commands

```bash
npm run build         # Build extension + webview
npm run dev           # Watch mode
npm run typecheck     # Type checking
npm run lint          # Lint
npm test              # Vitest (whole repo)
npm run package       # Package for distribution
npm run generate:profiles  # Regenerate the team agent-profile catalog (commit the output)
npm run sync:profiles      # Report upstream agency-agents diffs (--apply to copy)
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

- **Seam:** the webview message contract (`ExtensionToWebviewMessage`) is fixed; `PiSession` is its only producer. Interface: `src/extension/chat-session.ts`.
- **Extension:** esbuild → `dist/extension.js` (CJS). Externals: `scripts/extension-externals.mjs` (single source; `scripts/sync-vscodeignore.mjs` derives the VSIX allowlist from it).
- **Webview:** Vite → `dist/webview/` (ESM). shadcn-vue + Tailwind + Shiki.
- **Type aliases:** `@shared/*` → `src/shared/*`, `@/*` → `src/webview/*`.

### Key Modules

| Module                | Purpose                                                                                                                    |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `pi-session/`         | The agent backend. `PiSession` (implements `ChatSession`) + process-global `PiRuntime` (provider registration, Claude auth, custom-provider keys from SecretStorage). `pi-stream-adapter.ts` + `tool-normalization.ts` map pi events onto webview shapes. Subdirs: `tools/` (CC-shaped + re-wrapped module tools), `session-store/` (tree-JSONL sessions + sidecars), `checkpoints/` (per-session bare-git shadow repo), `subagents/`, `mcp/`, `web-access/`, `hooks/`. |
| `chat-panel/`         | Webview management: panel, session manager, settings, message routing, history                                            |
| `permission-handler/` | Tool permissions via domain managers (approval, question, plan, skill, subagent)                                           |
| `memory/`             | Kind/scope memory + fact graph, auto-extraction, `node:sqlite`/FTS5 (WAL), pull-first catalog                              |
| `compass/`            | Knowledge graph: tree-sitter → SQLite → Louvain → MCP tools (disabled by default)                                         |
| `web-access/`         | Native key-free web tools behind `pi.webSearch.enabled` (default off). All fetches go through SSRF-guarded `safe-fetch.ts`; every `execute` is fail-soft. |
| `browser/`            | Integrated Patchright (stealth Chromium) browser + MCP tools; page-controller CDP chokepoint never sends `Runtime.enable` (disabled by default). One `BrowserPanel` (VS Code editor tab) per page; browser tools bind to a `BrowserAgentScope` (`agent-scope.ts`), never to a global active page. |
| `team/`               | Multi-agent teams via MessageBus + Scratchpad (disabled by default). `create_team` requires a `brief` (authoritative intent; `title` is a label). Per-role model/effort from `damocles.team.{lead,implementor,reviewer}{Model,Effort}`. Event-driven liveness (no timers). |
| `voice/`              | STT via Whisper/Deepgram/Google Cloud + on-device Jarvis sidecar (disabled by default)                                     |
| `paths.ts`            | Shared filesystem path constants (`~/.damocles` home, `plans`/`explores` dirs) + per-session plan-file path (`computePlanFilePath`, `isPlanFilePath`). |
| `asset-sources.ts`    | Compat asset sourcing: `.claude` + `.codex` skill/command specs (`compatSources`), ordered by `damocles.assetSourcePrecedence`. |

### Patterns

- **Facade + DI:** Each module has `index.ts`; managers receive deps via constructor.
- **Two-phase lazy init:** Constructor reads config; `ensureInitialized()` defers heavy work to first access (Memory, Compass).
- **Message routing:** Domain-handler registries — `message-router/handlers/` (extension), `message-handler/handlers/` (webview).

### Invariants

- pi is the only agent engine; new sessions always construct `PiSession` — there is no harness selection.
- Don't change the webview message contract to add a feature — map pi events to existing shapes via `pi-stream-adapter.ts` / `tool-normalization.ts`.
- `Edit` cannot create files (empty `old_string` throws); `Write` is the only creation path.
- All tool calls route through the central permission gate (`permission-gate.ts`): read auto-allowed, write/shell → diff approval. In plan mode, `Bash`/`PowerShell` are classified by `readonly-shell.ts` (fail-closed allowlist); non-plan-file `Edit`/`Write` stay blocked (the session plan file is the sole write carve-out); memory/Compass/enabled MCP tools stay available. The same classifier also holds a subagent whose resolved toolset has no write tool (`ResolvedToolset.readOnly` → `readOnlyShell`) in every mode — no write tool must mean no writes via the shell either.
- A block the runtime made itself (settings rule, plan mode, read-only agent, hook) uses `formatPolicyBlockReason`/`POLICY_BLOCK_MARKER`; only a real approval-prompt rejection uses `formatDenyReason`/`FEEDBACK_MARKER`. Never tell the model the user refused something the user was never asked. Both render as "denied"; `FEEDBACK_MARKER` is persisted in old sessions, so its value must not change.
- The on-disk plan file is the single source of truth for plan-mode handoff. `ExitPlanMode` takes no `plan` argument; everything reads it via `ChatSession.getPlanContent()`.
- Plan-mode guidance has one source: `pi-session/plan-mode-guidance.ts` (`buildPlanModeGuidance`), consumed by both `agent-start.ts` and `tools/plan-mode-tools.ts`. Edit the builder, not the call sites.
- The Damocles system prompt has one assembler: `agent-start.ts` (`assembleDamoclesSystemPrompt`). Never read `session.systemPrompt` for display — it holds pi's boilerplate outside a turn.
- Browser tools resolve tabs through the caller's `BrowserAgentScope`, never a global active page: main agent + human share `PRIMARY_SCOPE_ID`; every subagent/team agent passes its own id and its scope is disposed at settle (tabs closed only on success).
- Internal sub-calls (memory, structured output) use `PiRuntime.runStructuredCompletion` + the terminating-tool idiom (no `toolChoice`).
- Never mutate `process.env` for per-session config; pi reads a Damocles-owned `agentDir` (`~/.damocles/pi/agent`).
- Implementation gotchas live in the code and in memory observations — search those before assuming.

## Permission Modes

| Mode          | Behavior                                                                |
| ------------- | ----------------------------------------------------------------------- |
| `plan`        | Classifies Bash/PowerShell — provably read-only commands auto-run, all else blocked; blocks non-plan-file Edit/Write; memory/Compass/enabled MCP tools stay available |
| `default`     | Shows diff for Edit/Write, prompts Bash/PowerShell                      |
| `acceptEdits` | Auto-approves Edit/Write, prompts Bash/PowerShell                       |

Read-only tools are auto-approved in all modes. `dangerouslySkipPermissions` (YOLO) auto-approves everything.

## Code Quality Standards

- Self-documenting code; avoid inline comments
- Prefer functional patterns over OOP
- Tailwind instead of custom CSS; shadcn-vue from `src/webview/components/ui/`
- **Locality of Behavior:** Keep related code physically close

## Behavioral Principles

- **Think before coding:** State assumptions explicitly; if unclear or multiple interpretations exist, stop and ask. Push back when a simpler approach exists.
- **Simplicity first:** Minimum code that solves the problem. No speculative features, abstractions, configurability, or error handling for impossible scenarios.
- **Surgical changes:** Touch only what you must. Don't refactor working code or "improve" adjacent style. Remove only imports/vars YOUR changes made unused; leave pre-existing dead code (mention it). Every changed line should trace to the request.
- **Goal-driven execution:** Define success criteria and loop until verified — e.g. "fix the bug" → write a test that reproduces it, then make it pass. For multi-step tasks, state a brief plan with a verification step per item.
