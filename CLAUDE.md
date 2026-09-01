# CLAUDE.md

## Project Overview

Damocles is a VS Code extension that embeds an AI coding agent (Claude and GPT) in a Vue webview: chat with diff approval, tool visualization, session management, checkpoints/rewind, persistent memory, subagents, MCP, Compass, a Patchright browser, teams, and voice. The agent runs on the **pi** runtime (`@earendil-works/pi-coding-agent`), the sole backend.

## Development Commands

```bash
npm run build         # Build extension + webview
npm run dev           # Watch mode
npm run typecheck     # Type checking
npm run lint          # Lint
npm test              # Vitest (whole repo)
npm run package       # Package for distribution
npm run package:linux-wsl -- --target linux-x64 --distro Ubuntu  # Linux VSIX from Windows, built in WSL
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

| Module | Purpose |
| --- | --- |
| `pi-session/` | Agent backend. `PiSession` + process-global `PiRuntime` (providers, auth, keys). `pi-stream-adapter.ts` + `tool-normalization.ts` map pi events onto webview shapes. Subdirs: `tools/`, `session-store/`, `checkpoints/`, `subagents/`, `mcp/`, `web-access/`, `hooks/`. |
| `chat-panel/` | Panel, session manager, settings, message routing, history |
| `permission-handler/` | Tool permissions via domain managers (approval, question, plan, skill, subagent) |
| `memory/` | Kind/scope memory + fact graph, auto-extraction, `node:sqlite`/FTS5 (WAL) |
| `compass/` | Knowledge graph: tree-sitter → SQLite → Louvain → MCP tools (off by default) |
| `web-access/` | Key-free web tools behind `pi.webSearch.enabled` (off by default); SSRF-guarded `safe-fetch.ts`, fail-soft `execute` |
| `browser/` | Patchright (stealth Chromium) + MCP tools, one `BrowserPanel` per page, scoped by `agent-scope.ts` (off by default) |
| `team/` | Multi-agent teams via MessageBus + Scratchpad (off by default); per-role model/effort from `damocles.team.*` |
| `voice/` | STT via Whisper/Deepgram/Google Cloud + Jarvis sidecar (off by default) |
| `paths.ts` | Shared path constants (`~/.damocles`) + per-session plan-file path |
| `asset-sources.ts` | `.claude` + `.codex` skill/command specs, ordered by `damocles.assetSourcePrecedence` |

### Patterns

- **Facade + DI:** Each module has `index.ts`; managers receive deps via constructor.
- **Two-phase lazy init:** Constructor reads config; `ensureInitialized()` defers heavy work to first access (Memory, Compass).
- **Message routing:** Domain-handler registries in `message-router/handlers/` (extension) and `message-handler/handlers/` (webview).

### Invariants

Rationale, failure modes and per-subsystem detail: **`docs/invariants.md`**. Read the relevant section before changing a subsystem.

- pi is the only engine; never add harness selection. Don't extend the webview message contract for a feature; map onto existing shapes in `pi-stream-adapter.ts`.
- `Edit` cannot create files; `Write` is the only creation path.
- Browser/Compass/Web/MCP tools are DEFERRED, meaning registered but inactive until `ToolSearch` loads them. Keep them in pi's eligible set, defer per whole subsystem, and never name one in a prompt without an adjacent `ToolSearch` step.
- The advertised ToolSearch menu must equal the loadable set; report what pi actually activated, and sanitize third-party MCP text.
- Nested (subagent/team) MCP arrives as `customTools`, never via the shared registrar. That is what preserves the nested-session republisher exemption, so never "simplify" it into sharing the registrar.
- A nested agent's MCP set is frozen at spawn from ONE descriptor read (names + definitions + gate classifier + blurbs); a server connecting mid-run reaches the next agent, never a running one. The grant is uniform across every agent type and mode; `disallowed_tools` is the one opt-out and it is exact and case-sensitive.
- Read-only agents are shell-restricted, not capability-capped: a read-only subagent may call a non-annotated MCP tool (still via `canUseTool`). That is a decision, so see `docs/invariants.md` before changing it.
- A custom tool registered under a pi built-in's name REPLACES it, which is how Damocles owns `bash`. Keep the built-in's exact lowercase name (the gate and the active-set lists key off it) and never pair an override with an `excludeTools` entry, which drops the replacement too.
- The shell process-lifetime path has no timer, interval or process-table read on any platform (`tools/process-tree.ts`): Windows uses nested job objects, POSIX the process group plus a per-panel sentinel. `createShellJob` must stay the first statement after `spawn`, or a background job forks outside the job and becomes unkillable.
- A cancel note is user turn content, delivered to the agent that ran the command. Never append it to a tool result: a tool result is untrusted, so a model correctly refuses an instruction found in one.
- An overlay's z-index comes from the shared overlay stack (`useOverlayEscape.ts`), never a fixed `z-` class, or a nested overlay paints behind the one it opened from.
- All tool calls route through `permission-gate.ts`. Runtime-originated blocks use `formatPolicyBlockReason`; only real user rejections use `formatDenyReason`. Only two blocks set `terminate`: a user deny with no feedback, and a hook that opted in. Every other block must hand the model a reason it can re-plan against.
- Nothing may append to a session file after it is deleted: every holder detaches first (`detachFromDeletedSession`, routed by session id), and any writer resuming after an `await` re-checks liveness. `whenReplaced()` rejects when the replacement failed, so never sequence a delete off a promise that resolves either way.
- Damocles READS other tools' config (`.claude`, `.codex`, the project's `.mcp.json`) and WRITES only under `.damocles`. MCP writes go to `~/.damocles/mcp.json` alone; permission rules to `.damocles/settings*.json` alone. Never write to a file another tool owns.
- Single sources of truth: plan content = the on-disk plan file (`getPlanContent()`); plan guidance = `plan-mode-guidance.ts`; system prompt = `agent-start.ts`.
- Page output is hostile input: redact/bound at CAPTURE, with linear-time patterns only.
- Browser tools resolve tabs via the caller's `BrowserAgentScope`, never a global active page.
- Team delivery branches on `TeamMessage.kind`, never rendered text; verification fingerprints are computed by the extension and fail visibly.
- `team_standby` and `team_report_complete` end the turn from the engine's stop hook, keyed on a non-error result. Never trust the model to stop, and never block inside the tool.
- A team agent's work fields are per attempt and its usage fields are cumulative. The runner, the persistence loader and the webview store must all agree, or a reopened team contradicts the live one.
- Account state has one publisher, `PiSession.publishAccountInfo()`, called wherever its inputs change. Never publish it from a once-guarded session-start path.
- The team profile catalog is generated: edit `agent-profiles/`, run `npm run generate:profiles`, commit the output.
- A subagent's model is configuration, never the spawning model's choice (`Agent` has no `model` param).
- Internal sub-calls use `PiRuntime.runStructuredCompletion` + the terminating-tool idiom. Never hand-roll a `completeSimple` call, because that seam is what keeps untrusted content (transcripts, memories, queries) in data position instead of instruction position. Never mutate `process.env` for per-session config.
- Implementation gotchas live in the code and in memory observations, so search those before assuming.

## Permission Modes

| Mode | Behavior |
| --- | --- |
| `plan` | Bash/PowerShell classified by `readonly-shell.ts` (provably read-only auto-runs, else blocked); non-plan-file Edit/Write blocked; memory/Compass/enabled MCP stay available |
| `default` | Shows diff for Edit/Write, prompts Bash/PowerShell |
| `acceptEdits` | Auto-approves Edit/Write, prompts Bash/PowerShell |

Read-only tools are auto-approved in all modes. `dangerouslySkipPermissions` (YOLO) auto-approves everything.

## Code Quality Standards

- Self-documenting code
- Prefer functional patterns over OOP
- Tailwind instead of custom CSS; shadcn-vue from `src/webview/components/ui/`
- **Locality of Behavior:** Keep related code physically close

## Behavioral Principles

- **Think before coding:** State assumptions explicitly; if unclear or multiple interpretations exist, stop and ask. Push back when a simpler approach exists.
- **Simplicity first:** Minimum code that solves the problem. No speculative features, abstractions, configurability, or error handling for impossible scenarios.
- **Surgical changes:** Touch only what you must. Don't refactor working code or "improve" adjacent style. Remove only imports/vars YOUR changes made unused; leave pre-existing dead code (mention it). Every changed line should trace to the request.
- **Goal-driven execution:** Define success criteria up front. For "fix the bug", write a test that reproduces it, then make it pass. For multi-step tasks, state a brief plan before starting.
