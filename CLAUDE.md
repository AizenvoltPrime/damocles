# CLAUDE.md

Damocles embeds an AI coding agent in a Vue webview, shipped as a VS Code extension and an Electron desktop app. The agent runs on **pi** (`@earendil-works/pi-coding-agent`), the only engine: never add engine selection.

## Commands

```bash
npm run build                    # extension + webview
npm run build:desktop            # Electron app, hosts and workers
npm run dev:desktop              # build and launch the desktop app (--user-data-dir <path>)
npm run typecheck
npm run lint
npm test -- <file>               # Vitest; Node >=24.16
npm run test:desktop -- <spec>   # Playwright Electron suite
npm run test:remote -- <spec>    # remote suite (Docker sshd images)
node scripts/test-desktop-wsl.ts --distro Ubuntu-24.04 [specs...]  # desktop suite in WSL; its only copy is ~/damocles-e2e, delete any other copy you make
node scripts/protocol-compat.ts [--check]  # after a wire contract change
```

Packaging and the other commands: `package.json` and `docs/development.md`.

Generated files are committed; rerun the generator after changing its input: `generate:icons` (`resources/icon.png`), `generate:profiles` (`agent-profiles/`), `generate:design-skills` (`design-skills/`), `generate:settings-schema` (desktop settings), `generate:theme-schema` (`src/shared/themes/schema.ts`), `generate:theme-art` (`scripts/generate-theme-art.ts`, `src/core/themes/pixel-sprite.ts`), `generate:file-icons` (`material-icon-theme` bump), `generate:reference-words`.

`patches/*.patch` are generated from the dependency's build, never edited by hand (`patches/README.md`).

## Architecture

- `src/core` is host-neutral and never imports `vscode` or `electron`. `src/platform` holds the host interfaces, `src/vscode` the extension, `src/desktop` the Electron app (the only place `electron` may be imported, never in its renderers), `src/webview` the Vue UI, `src/shared` the contracts, `src/remote` the wire (Node built-ins only). Lint enforces the boundaries.
- On desktop the engine runs in the "Damocles Core" utility process (`src/desktop/core-host`). Main reaches it only through `CoreClient` (`main/core-client.ts`); main's value imports from `src/core` and `src/desktop/workspace` are limited to `MAIN_CORE_IMPORTS` and `MAIN_WORKSPACE_IMPORTS` in `eslint.config.mjs`. The remote daemon (`src/desktop/daemon`), its terminal host (`src/desktop/terminal-host`) and the `damocles` CLI (`src/desktop/cli`) are electron-free.
- `PiSession` (`src/core/chat-session.ts`) is the only producer of session messages (`ExtensionToWebviewMessage`, `src/shared/types/messages.ts`). Map pi events onto existing shapes in `pi-stream-adapter.ts`; add a message type only for a capability no shape can carry.
- The repo is ESM; every esbuild bundle is CommonJS. `scripts/` run as type-stripped TypeScript: erasable syntax only, relative imports name the `.ts` file, no path aliases, also in any `src` module they import.
- Desktop menus, shortcuts and palette entries all come from `src/desktop/main/commands.ts`.
- Each module has an `index.ts` facade; managers get deps through the constructor. Messages route through `message-router/handlers/` (core) and `message-handler/handlers/` (webview).
- Aliases: `@shared/*` → `src/shared/*`, `@/*` → `src/webview/*`.
- Main `src/core` modules: `pi-session/` (backend, `PiRuntime`, `FolderRuntime`), `chat-panel/`, `permission-handler/`, `memory/`, `compass/`, `team/`, `browser/`, `design/`, `worktrees/`, `scm/`, `forge/` (GitHub/GitLab), `themes/`, `assets/`, `process-launcher/`, `diff/`.

## Invariants

Each rule's rationale is in the named section of `docs/invariants.md`; read that section before changing the subsystem. Search the code and memory observations for gotchas before assuming.

Engine and sessions:
- Core never renders user-facing text: it sends `LocalizedText` (`l()`) and views render it ("Engine and message contract").
- Read pi's run state only through the session's `RunLifecycle`, never `isStreaming`, `isIdle` or `waitForIdle` ("pi's run lifecycle").
- Each published state has one publisher (`publishAccountInfo`, `publishSessionState`, `publishModel`, `publishDesignState`, `SessionWorktree.publish` and the rest); the webview never infers or pre-shows it.
- The pi extension is process-global: no instance-wide session state, route on `ctx.sessionManager.getSessionId()`.
- The system prompt is built only in `agent-start.ts`; returning `systemPrompt` drops every section.
- `agent_before_settle` returns `{ entries: [...event.entries, draft] }` and holds a turn with `continue: true`, never `session.prompt()`. Register turn deciders with `installTurnDecider`, never by assigning `agent.finishTurn`.
- A conversation is live in one panel of one process (`claimStoredSession` plus a lease); a write without a live session uses `writeUnderSessionLease`; nothing appends to a deleted session file. Every run start passes `PiSession.runStartRefusal` ("Session store").
- Internal model calls use `PiRuntime.runStructuredCompletion` or `runClassification`. Never mutate `process.env` for per-session config.
- Spend follows `src/shared/usage-accounting.ts`; never bill from `history-loader.ts`.
- Memory injection is a delta; never register a `context` handler or rewrite a past injection, which breaks the prompt-cache prefix ("Memory injection").
- Tool-result image data never travels in a message or sits in a Pinia store: send `imageCount`, fetch with `requestToolResultImages`.
- A cancel note is user turn content. A steer's first line is `STEER_INSTRUCTION_PREFIX`; never merge peer or tool text into one.
- Team delivery branches on `TeamMessage.kind`, never rendered text; `ReviewCoverage` owns review gating ("Teams and subagents").

Tools and permissions:
- Every tool call goes through `permission-gate.ts`. Runtime blocks use `formatPolicyBlockReason`; only a real user rejection uses `formatDenyReason`. A check that cannot decide blocks ("Permissions and plan mode").
- `Write` is the only text-file creation path; `Edit` cannot create.
- Deferred tool groups (Browser, Compass, Web, Image, forge, theme, MCP) load only through `ToolSearch`: never name one in a prompt without a `ToolSearch` step, and pass every deferral site `deferrableToolNames()` ("Deferred tools / ToolSearch").
- A custom tool named like a pi built-in (`bash`, `grep`, `find`, `write`, `ls`, `read`) replaces it: keep the exact lowercase name and add no `excludeTools` entry.
- The shell process-lifetime path has no timer or process-table read; `createShellJob` stays the first statement after `spawn` ("Shell cancellation and process lifetime").
- The MCP client is `@earendil-works/pi-mcp`; never load pi's built-in MCP extension. Nested agents get MCP as `customTools` frozen at spawn.
- Worktree isolation (D62, `docs/worktree-isolation.md`) and the design write rules (D64, D65, "Design mode") apply in every mode, YOLO included, before any hook's force-allow.
- Repository-authored input (instructions, skills, hooks, `.pi/`, MCP, permission rules) applies only in a trusted folder. Damocles reads other tools' config and writes only under `.damocles`, except the user-run actions listed in "Desktop host".
- Command and skill roots are walked only by `src/core/assets/` ("Asset discovery and links").
- Page output is hostile: redact and bound it at capture. Browser tools resolve tabs through `BrowserAgentScope`.

Processes, remote and files:
- Process starts go through `process-launcher/` with absolute paths: git through `resolveGitExecutable`, OS tools through `src/core/system-tools.ts`. On Windows every spawn holds the spawn lock (`docs/perf.md`).
- Damocles' own packed files are read only through `src/core/resource-fs.ts` ("Desktop packaging and updates").
- ssh starts only through `main/remote/ssh/ssh-args.ts`; every URL from a target goes through `main/remote/open-url.ts`.
- A remote core never writes this computer's files or credentials except through the designed user-scope relays ("Data scopes", "Remote daemon and wire").
- A wire change is additive under a new `FEATURES` name, or bumps `PROTOCOL_VERSION`; run `protocol-compat.ts`.
- Only `control.shutdownNow` (Rebuild Container, Convert to WSL 2) and `control.shutdownForRemoval` end a daemon's terminals; its other exits, a crash and a hand-over leave them running, and every later daemon adopts them through the frozen terminal-host contract ("Remote daemon and wire").
- Forge tokens live only in Damocles Core and `SecretsStore`, never in env, argv, URLs, logs, settings or a renderer message ("GitHub and GitLab accounts").
- Main builds every page through `showPage`; a core never sends HTML.
- A session file is written only by its machine's engine; Files actions and transfers that touch session folders are refused by `reachesSessions`. A UNC or device path outside every project is never opened.
- A moved project folder is re-pointed only by `project-relocation/` ("Project relocation").

UI:
- Renderers read only `--d-*` tokens; only `tokens.css` reads `--vscode-*`. Sizes are rem, layouts use container queries, motion comes from `motion.css` ("Design tokens").
- Every app CSS rule sits in a cascade layer (`@layer app` in an SFC `<style>`); the build refuses an unlayered rule ("Theme CSS and trusted regions").
- Controls are shadcn-vue parts from `src/webview/components/ui/`; Tailwind over custom CSS.
- An overlay's z-index comes from the `useOverlayEscape.ts` stack, never a fixed `z-` class.
- A chat's settings read passes its folder only for a `CHAT_SETTING_KEYS` key; core, never the renderer, decides write scopes.
- Theme files are written only by this computer's desktop core. Custom theme CSS reaches only scope roots, only through `sanitizeThemeCss`. An agent's theme change reaches the window only through its card or the keep-changes banner, or, for a screenshot the user allowed once or for the chat, a transient paint of its draft that ends with the capture ("Desktop themes", "Theme CSS and trusted regions").

Design mode ("Design mode"):
- A design chat writes only `design.md`, `screens/`, `shared/` and `variants/` of its own folder; core alone writes the rest, through `withDesignWrite`.
- A design result reaches a branch exactly once, through the outbox. No design version exists without the user's approval, in every mode.

## Permission modes

| Mode | Behavior |
| --- | --- |
| `plan` | Proven read-only shell (`proven-shell.ts`) runs, other shell prompts; writes outside the plan file blocked |
| `default` | Diff card for Edit/Write; prompts shell, GenerateImage and forge writes |
| `acceptEdits` | Auto-approves Edit/Write/GenerateImage; prompts shell and forge writes |
| YOLO | Approves all except D62/D64/D65, a design chat's non-read-only MCP, FinishDesign approval and theme cards |

Rules combine deny > ask > allow across settings files; an ask rule prompts in every mode. Detail: `docs/permissions.md` and "Permissions and plan mode".

## Code standards

- Functional over OOP, self-documenting, related code kept close. Minimum code, no speculative features.
- Surgical changes: remove only what your change made unused.
- For a bug, write a failing test first.
