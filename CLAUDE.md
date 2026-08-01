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

### Key Modules (`src/extension/`)

| Module                | Purpose                                                                                      |
| --------------------- | -------------------------------------------------------------------------------------------- |
| `pi-session/`         | Agent backend. `PiSession` + process-global `PiRuntime` (providers, auth, keys). `pi-stream-adapter.ts` + `tool-normalization.ts` map pi events onto webview shapes. Subdirs: `tools/`, `session-store/`, `checkpoints/`, `subagents/`, `mcp/`, `web-access/`, `hooks/`. |
| `chat-panel/`         | Panel, session manager, settings, message routing, history                                   |
| `permission-handler/` | Tool permissions via domain managers (approval, question, plan, skill, subagent)             |
| `memory/`             | Kind/scope memory + fact graph, auto-extraction, `node:sqlite`/FTS5 (WAL)                    |
| `compass/`            | Knowledge graph: tree-sitter → SQLite → Louvain → MCP tools (off by default)                 |
| `web-access/`         | Key-free web tools behind `pi.webSearch.enabled` (off by default); SSRF-guarded `safe-fetch.ts`, fail-soft `execute` |
| `browser/`            | Patchright (stealth Chromium) + MCP tools, one `BrowserPanel` per page, scoped by `agent-scope.ts` (off by default) |
| `team/`               | Multi-agent teams via MessageBus + Scratchpad (off by default); per-role model/effort from `damocles.team.*` |
| `voice/`              | STT via Whisper/Deepgram/Google Cloud + Jarvis sidecar (off by default)                      |
| `paths.ts`            | Shared path constants (`~/.damocles`) + per-session plan-file path                           |
| `asset-sources.ts`    | `.claude` + `.codex` skill/command specs, ordered by `damocles.assetSourcePrecedence`        |

### Patterns

- **Facade + DI:** Each module has `index.ts`; managers receive deps via constructor.
- **Two-phase lazy init:** Constructor reads config; `ensureInitialized()` defers heavy work to first access (Memory, Compass).
- **Message routing:** Domain-handler registries — `message-router/handlers/` (extension), `message-handler/handlers/` (webview).

### Invariants

Rationale, failure modes and per-subsystem detail: **`docs/invariants.md`** — read the relevant section before changing a subsystem.

- pi is the only engine; never add harness selection. Don't extend the webview message contract for a feature — map onto existing shapes in `pi-stream-adapter.ts`.
- `Edit` cannot create files; `Write` is the only creation path.
- Browser/Compass/Web/MCP tools are DEFERRED — registered but inactive until `ToolSearch` loads them. Keep them in pi's eligible set, defer per whole subsystem, and never name one in a prompt without an adjacent `ToolSearch` step.
- The advertised ToolSearch menu must equal the loadable set; report what pi actually activated, and sanitize third-party MCP text.
- All tool calls route through `permission-gate.ts`. Runtime-originated blocks use `formatPolicyBlockReason`; only real user rejections use `formatDenyReason`.
- Single sources of truth: plan content = the on-disk plan file (`getPlanContent()`); plan guidance = `plan-mode-guidance.ts`; system prompt = `agent-start.ts`.
- Page output is hostile input: redact/bound at CAPTURE, with linear-time patterns only.
- Browser tools resolve tabs via the caller's `BrowserAgentScope`, never a global active page.
- Team delivery branches on `TeamMessage.kind`, never rendered text; verification fingerprints are computed by the extension and fail visibly.
- The team profile catalog is generated — edit `agent-profiles/`, run `npm run generate:profiles`, commit the output.
- A subagent's model is configuration, never the spawning model's choice (`Agent` has no `model` param).
- Internal sub-calls use `PiRuntime.runStructuredCompletion` + the terminating-tool idiom. Never mutate `process.env` for per-session config.
- Implementation gotchas live in the code and in memory observations — search those before assuming.

## Permission Modes

| Mode          | Behavior                                                                |
| ------------- | ----------------------------------------------------------------------- |
| `plan`        | Bash/PowerShell classified by `readonly-shell.ts` (provably read-only auto-runs, else blocked); non-plan-file Edit/Write blocked; memory/Compass/enabled MCP stay available |
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
