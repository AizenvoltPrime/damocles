# CLAUDE.md

## Project Overview

Damocles is a VS Code extension that embeds an AI coding agent (Claude and GPT) in a Vue webview: chat with diff approval, tool visualization, session management, checkpoints/rewind, persistent memory, subagents, MCP, Compass, a Patchright browser, teams, and voice. The agent runs on the **pi** runtime (`@earendil-works/pi-coding-agent`), the sole backend.

## Development Commands

```bash
npm run build         # Build extension + webview
npm run build:desktop # Build the Electron main + panel, shell, pane and overlay preloads (dist/desktop/), the shell and overlay renderers (dist/desktop-shell/) and the workers
npm run dev:desktop   # Fetch assets and the Electron binary, build webview + desktop, then launch the app (accepts --user-data-dir <path>)
npm run test:desktop  # Same setup and build, then run the Playwright Electron suite (playwright.desktop.config.ts)
node scripts/test-desktop-wsl.mjs --distro Ubuntu-24.04 [specs...]  # The desktop suite on Linux, synced into WSL and run there
npm run dist          # Build and package the desktop app for this OS into dist-desktop/ (never publishes; macOS needs Xcode 26+ for the icon)
npm run dist:linux-wsl -- --distro Ubuntu-24.04  # Linux deb + rpm from Windows, built in WSL
DAMOCLES_E2E_PACKAGED_APP=<path to built app> npm run test:desktop:packaged  # e2e subset against a packaged app
npm run dev           # Watch mode
npm run typecheck     # Type checking
npm run lint          # Lint
npm test              # Vitest (whole repo)
npm run package       # Package for distribution
npm run package:linux-wsl -- --target linux-x64 --distro Ubuntu  # Linux VSIX from Windows, built in WSL
npm run generate:icons     # Regenerate resources/icon.ico and build/icon.icon's artwork from resources/icon.png (commit the output)
npm run generate:profiles  # Regenerate the team agent-profile catalog (commit the output)
npm run generate:reference-words  # Regenerate the memory gate's English and software word lists and their stems (commit the output)
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

- **Seam:** `PiSession` is the only producer of session messages in the webview contract (`ExtensionToWebviewMessage` in `src/shared/types/messages.ts`). Interface: `src/core/chat-session.ts`. Cross-session views (`/usage`, `/stats`) post from their router handlers; see `docs/invariants.md`.
- **Source layout:** `src/core` is host-neutral and never imports `vscode` or `electron` (eslint and `tsconfig.core.json` enforce both); `src/platform` holds the host service interfaces core uses; `src/vscode` implements them for VS Code and holds the entry point `extension.ts`; `src/desktop` is the Electron app (`main/`: entry `index.ts`, the window, chat views and overlay view, chat retention, `app://` protocol, platform implementations; `preload/`: the panel bridge `window.damoclesBridge`, the shell bridge `window.damoclesShell`, the browser pane bridge `window.damoclesPane` and the overlay bridge `window.damoclesOverlay`; `shell/`: the window's Vue shell renderer (title bar, Projects and Chats sidebar), the overlay renderer and the browser pane renderer, which never import `electron`), the only place `electron` may be imported.
- **Desktop:** esbuild → `dist/desktop/main.js` + `preload-panel.js` + `preload-shell.js` + `preload-pane.js` + `preload-overlay.js` (CJS); Vite (`vite.shell.config.ts`) → `dist/desktop-shell/` (shell, pane and overlay pages), which also receives the desktop fonts (`fonts/`). Externals: `scripts/desktop-externals.mjs`. The window is frameless; the sidebar's Chats list switches chats (no tab strip), each loaded chat's view loads the same `dist/webview` app over `app://damocles`, menus and dialogs render in the top-most overlay view and toasts only in the desktop popup window; browser pages live in a side pane beside their chat; see `docs/invariants.md` for the renderer security posture.
- **Extension:** esbuild → `dist/extension.js` (CJS). Externals: `scripts/extension-externals.mjs` (single source; `scripts/sync-vscodeignore.mjs` derives the VSIX allowlist from it).
- **Webview:** Vite → `dist/webview/` (ESM). shadcn-vue + Tailwind + Shiki.
- **Type aliases:** `@shared/*` → `src/shared/*`, `@/*` → `src/webview/*`.

### Key Modules (`src/core/`; VS Code-only code lives in `src/vscode/`: platform services, panels, Compass views and decorations, voice status bar)

| Module | Purpose |
| --- | --- |
| `pi-session/` | Agent backend. `PiSession` + process-global `PiRuntime` (providers, auth, keys, subscription plugin) + one `FolderRuntime` per workspace folder (pi services, loader, hooks, registries, project MCP). `pi-stream-adapter.ts` + `tool-normalization.ts` map pi events onto webview shapes. `agent-records.ts` builds and id-checks every subagent/team data path under the parent session's folder. Subdirs: `tools/`, `session-store/`, `checkpoints/`, `subagents/`, `mcp/`, `web-access/`, `hooks/`. |
| `chat-panel/` | Panel, session manager, settings, message routing, history |
| `permission-handler/` | Tool permissions via domain managers (approval, question, plan, skill) |
| `memory/` | Kind/scope memory + fact graph, auto-extraction, relevance-gated delta injection (`injection/`), manual quality audit (`audit.ts`), `node:sqlite`/FTS5 (WAL) |
| `compass/` | Knowledge graph: tree-sitter → SQLite → Louvain → MCP tools (off by default) |
| `usage-stats/` | `/stats`: sub-call ledger, `node:sqlite` spend index built by a worker thread from pi session files, `UsageStatsService` |
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

- pi is the only engine; never add harness selection. Map pi events onto existing webview shapes in `pi-stream-adapter.ts`; add a message type only for a capability no existing shape can carry, never to mirror a pi event.
- Tool-result image data never travels in a tool, history, subagent or team message or sits in a Pinia store: those carry `imageCount`, and `ToolResultImages.vue` fetches the blocks via `requestToolResultImages`.
- `Edit` cannot create files; `Write` is the only text-file creation path. `GenerateImage` only creates a new image file and is gated as category `write`, never through `GATEABLE_MODULE_NAMES`.
- Browser/Compass/Web/Image/MCP tools are DEFERRED until `ToolSearch` loads them: keep them in pi's eligible set, never name one in a prompt without an adjacent `ToolSearch` step, and pass every deferral site `deferrableToolNames()`, never all MCP names. The ToolSearch menu must equal the loadable set; report what pi actually activated and sanitize third-party MCP text.
- Nested (subagent/team) MCP arrives as `customTools` frozen at spawn from ONE descriptor read, never via the shared registrar. The grant is uniform across agent types; `disallowed_tools` is the one opt-out, exact and case-sensitive.
- Read-only agents and team reviewers get plan mode's shell rule in every mode (proven reads auto-run, anything else goes through `canUseTool`, which YOLO approves) and are not capability-capped: they may call a non-annotated MCP tool through `canUseTool`. That is a decision; see "Teams and subagents" before changing it.
- The MCP client is `@earendil-works/pi-mcp`; Damocles owns the host layer (`mcp/`). Never load pi's built-in MCP extension, which keeps per-instance state while Damocles shares one instance per folder. See "MCP client and config sources" before touching MCP config, naming, exposure, OAuth or logging.
- A custom tool registered under a pi built-in's name REPLACES it (`bash`, `grep`, `find`, `write`). Keep the exact lowercase name and never pair an override with an `excludeTools` entry, which drops the replacement too.
- The shell process-lifetime path has no timer, interval or process-table read (`tools/process-tree.ts`). `createShellJob` must stay the first statement after `spawn`, or a background job escapes the job and becomes unkillable.
- A cancel note is user turn content, never appended to a tool result, which a model correctly treats as untrusted. A steer is a user message whose first line is `STEER_INSTRUCTION_PREFIX`; never merge peer or tool text into one, which hands that text operator authority.
- An overlay's z-index comes from the shared overlay stack (`useOverlayEscape.ts`), never a fixed `z-` class, and popper content inside one binds `usePopperZIndex`.
- A settings read made for a chat passes its folder (`settingsFolderOf`; none on the home target), only for a `CHAT_SETTING_KEYS` key, which declares `"scope": "resource"`; a folder's project and local files apply only while it is trusted. Write scopes are decided in core per setter (D37), never by the renderer. A settings view outside the chat (the desktop overlay) is a `PanelManager.attachView` of the selected chat: it gets `SETTINGS_VIEW_MESSAGES` copies, may send only `SETTINGS_VIEW_REQUESTS`, and host prompts reach it only through `webview-prompts.ts`. See "Desktop settings come from three files" and "The desktop settings modal".
- Renderers read only the `--d-*` design tokens; `src/webview/styles/tokens.css` is the only renderer file that reads `--vscode-*`. Desktop fills every token from `src/desktop/main/theme.ts`, whose text colors stay at WCAG AA, and `--s-*` and `--d-ansi-*` are desktop-only. See "Design tokens".
- Webview text, spacing and sizes are rem (px ÷ 16), so they follow the host font; px only for border, ring and outline widths, blur and shadows. Icons are sized by a `size-*` class, never a numeric `size`; popper offsets and script-side sizes come from `remPx`; no viewport media queries, only container queries. ESLint and stylelint enforce it. See "Design tokens".
- All tool calls route through `permission-gate.ts`. Runtime blocks use `formatPolicyBlockReason` (an unasked deny comes only from `buildUnaskedDenyResult`); only a real user rejection uses `formatDenyReason`. Only a user deny with no feedback and a hook that opted in set `terminate`; every other block hands the model a reason to re-plan. A check that cannot decide blocks every tool, reads included.
- A conversation is live in at most one panel of one process (`claimStoredSession` plus the cross-process lease). Session-keyed registries on `PiRuntime` and `FolderRuntime` unregister only the caller's own entry, or a closing panel strips a live panel's gate.
- Nothing may append to a session file after it is deleted: every holder detaches first (`detachFromDeletedSession`), and a writer resuming after an `await` re-checks liveness. Never sequence a delete off a promise that resolves on a failed replacement.
- Damocles READS other tools' config (`.claude`, `.codex`, `.pi`, `.mcp.json`) and WRITES only under `.damocles`. Every repository-authored input (instructions, skills, hooks, `.pi/`, MCP, permission rules) applies only in a trusted window and takes effect on trust grant with no reload.
- Single sources of truth: plan content = the on-disk plan file (`getPlanContent()`); plan version = core's stamp on the `ExitPlanMode` result (`plan-version.ts`; the webview never counts plans); plan guidance = `plan-mode-guidance.ts`; system prompt = `agent-start.ts`, which writes pi's `customPrompt` plus one named section per toggleable piece. Returning `systemPrompt` instead sets `forceSystemPrompt` and drops every section.
- The pi extension is process-global and outlives any session: hold no instance-wide session state, route each dispatch on `ctx.sessionManager.getSessionId()`, and never await checkpoint git work in a handler (queue it).
- Memory injection is a delta whose state comes only from each injection message's `details`. Neutralize every emitted tag name in stored text, and never register a `context` handler or rewrite a past injection, which breaks the prompt-cache prefix.
- An `agent_before_settle` handler returns `{ entries: [...event.entries, draft] }`; a bare `[draft]` discards every other handler's entries. Hold a turn open with `continue: true`, never by calling `session.prompt()` from a settle handler.
- Page output is hostile input: redact and bound it at capture, with linear-time patterns only. Browser tools resolve tabs via the caller's `BrowserAgentScope`, never a global active page.
- Team delivery branches on `TeamMessage.kind`, never rendered text; verification fingerprints are computed by the extension and fail visibly. Review gating has one owner, `ReviewCoverage` (`review-coverage.ts`), whose `decisions` both the approval gates and the round-ready notice read.
- `team_standby` and `team_report_complete` end the turn from the engine; never trust the model to stop or block inside the tool. Register a turn decider through `installTurnDecider`, because assigning `agent.finishTurn` drops every extension `turn_end` handler.
- A team agent's work fields (effort and active time included) are per attempt and its usage is cumulative. The runner, `persistence.ts`, `TeamRunLog` and the webview store must agree, and agent times derive only from team-log timestamps, never the webview's clock.
- Effort badges show pi's effective `thinkingLevel` after clamping, never the requested setting, and only for a reasoning model (`src/shared/effort-badge.ts`).
- Account state has one publisher, `PiSession.publishAccountInfo()`, called wherever an input changes (the ChatGPT grant and the OpenAI key secret included), never from a once-guarded path. Session state has one publisher, `PiSession.publishSessionState()`; a new prompt kind registers through `PermissionState`, and the webview never infers state.
- The OpenAI key lives in the host secret store and the ChatGPT grant in `auth.json` `openai`. Never add OpenAI to `CUSTOM_PROVIDER_DEFS` or log out from the key sync, either of which deletes the grant. See "Agent auth store".
- The team profile catalog is generated: edit `agent-profiles/`, run `npm run generate:profiles`, commit the output.
- A subagent's model and effort are configuration, never the spawning model's choice (`Agent` has no `model` or `thinking` param).
- Every background subagent outcome reaches the parent once per branch. The branch and agent files are the truth and the `AgentManager` map is a cache; see "Teams and subagents".
- Internal sub-calls use `PiRuntime.runStructuredCompletion` and classifier (Jev) calls `PiRuntime.runClassification`. Never hand-roll `completeSimple` or call `classify()` directly: those seams keep untrusted content in data position. Never mutate `process.env` for per-session config. See "Memory judges on Jev".
- Spend follows one inclusion rule, `src/shared/usage-accounting.ts`. Never bill from `history-loader.ts`'s context snapshot, and the status bar's totals travel only in `sessionUsage`, never on `done`.
- Implementation gotchas live in the code and in memory observations, so search those before assuming.

## Permission Modes

| Mode | Behavior |
| --- | --- |
| `plan` | Bash/PowerShell classified by `readonly-shell.ts` (provably read-only auto-runs, else prompts; YOLO approves); non-plan-file Edit/Write and GenerateImage blocked; memory/Compass/enabled MCP stay available |
| `default` | Shows diff for Edit/Write, prompts GenerateImage and Bash/PowerShell |
| `acceptEdits` | Auto-approves Edit/Write/GenerateImage, except a path a link carries outside the cwd; prompts Bash/PowerShell |

Read-only tools auto-approve in every mode unless an ask rule matches. Settings rules combine across all files as deny > ask > allow, and an ask rule prompts in every mode (plan mode's blocks apply first). File rules follow Claude Code's "Read and Edit" semantics; matching detail is in "Permissions and plan mode" in `docs/invariants.md`. `dangerouslySkipPermissions` (YOLO) auto-approves everything.

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
