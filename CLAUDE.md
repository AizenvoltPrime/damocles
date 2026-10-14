# CLAUDE.md

## Project Overview

Damocles embeds an AI coding agent (Claude, GPT and others) in a Vue webview, shipped as a VS Code extension and an Electron desktop app. The agent runs on the **pi** runtime (`@earendil-works/pi-coding-agent`), the only backend.

## Development Commands

```bash
npm run build            # extension + webview
npm run build:desktop    # Electron main, preloads, shell and overlay renderers, hosts and workers
npm run dev:desktop      # fetch assets and Electron, build, launch (accepts --user-data-dir <path>)
npm run test:desktop     # same setup, then the Playwright Electron suite
node scripts/test-desktop-wsl.mjs --distro Ubuntu-24.04 [specs...]  # desktop suite on Linux, in WSL
npm run dist             # package the desktop app for this OS into dist-desktop/ (macOS needs Xcode 26+)
npm run dist:linux-wsl -- --distro Ubuntu-24.04  # Linux deb + rpm from Windows
DAMOCLES_E2E_PACKAGED_APP=<built app> npm run test:desktop:packaged  # e2e subset against a packaged app
npm run dev              # watch mode
npm run typecheck
npm run lint
npm test                 # Vitest, whole repo
npm run package          # VSIX
npm run package:linux-wsl -- --target linux-x64 --distro Ubuntu  # Linux VSIX from Windows
```

Generated files: run the command and commit its output. `generate:icons` (from `resources/icon.png`), `generate:profiles` (team catalog, from `agent-profiles/`), `generate:reference-words` (memory gate word lists), `generate:settings-schema` (after a desktop settings change). `sync:profiles` reports upstream agency-agents diffs (`--apply` copies). F5 launches the Extension Development Host.

## Architecture

- **Seam:** `PiSession` (interface `src/core/chat-session.ts`) is the only producer of session messages in the webview contract (`ExtensionToWebviewMessage`, `src/shared/types/messages.ts`). Cross-session views (`/usage`, `/stats`) post from their router handlers.
- **Layers:** `src/core` is host-neutral and never imports `vscode` or `electron` (eslint and `tsconfig.core.json` enforce it). `src/platform` holds the host interfaces core uses, `src/vscode` implements them and holds `extension.ts`, and `src/desktop` is the Electron app, the only place `electron` may be imported; its renderers (`shell/`, the overlay) never import it. Preloads expose `window.damoclesBridge` (chat and page views), `window.damoclesShell` and `window.damoclesOverlay`.
- **Builds:** esbuild → `dist/extension.js` (externals `scripts/extension-externals.mjs`, from which `scripts/sync-vscodeignore.mjs` derives the VSIX allowlist) and `dist/desktop/` plus hosts and workers in `dist/` (externals `scripts/desktop-externals.mjs`); Vite → `dist/webview/` (shadcn-vue, Tailwind, Shiki) and `dist/desktop-shell/`.
- **Desktop shell:** every menu item, app shortcut and palette entry comes from `src/desktop/main/commands.ts`; menus and dialogs render in the top-most overlay view, toasts only in the popup window; browser pages are editor tabs of their chat. Renderer security: "Desktop host" in `docs/invariants.md`.
- **Aliases:** `@shared/*` → `src/shared/*`, `@/*` → `src/webview/*`.

### Key Modules (`src/core/`; VS Code-only code in `src/vscode/`)

| Module | Purpose |
| --- | --- |
| `pi-session/` | Agent backend: `PiSession`, process-global `PiRuntime` (providers, auth, keys), one `FolderRuntime` per folder. `pi-stream-adapter.ts` + `tool-normalization.ts` map pi events onto webview shapes; `agent-records.ts` owns subagent and team data paths |
| `chat-panel/` | Panels, session manager, settings, message routing, history |
| `permission-handler/` | Tool permissions (approval, question, plan, skill) |
| `memory/` | Memory + fact graph, extraction, delta injection (`injection/`), `node:sqlite`/FTS5 |
| `compass/` | Knowledge graph: tree-sitter → SQLite → MCP tools (off by default) |
| `scm/` | Desktop source control engine (`git-runner.ts`, `scm-service.ts`); its host side is `src/desktop/main/scm/` |
| `usage-stats/` | `/stats` spend index |
| `web-access/` | Web tools (off by default); SSRF-guarded `safe-fetch.ts` |
| `browser/` | Patchright browser + tools, scoped by `agent-scope.ts` (off by default) |
| `team/` | Multi-agent teams (off by default) |
| `voice/` | Speech-to-text + Jarvis sidecar (off by default) |
| `paths.ts`, `asset-sources.ts` | `~/.damocles` paths; `.claude`/`.codex` skill and command sources |

### Patterns

- Each module has an `index.ts` facade; managers receive deps via constructor.
- Heavy modules (Memory, Compass) read config in the constructor and defer work to `ensureInitialized()`.
- Messages route through domain-handler registries: `message-router/handlers/` (extension), `message-handler/handlers/` (webview).

### Invariants

Rationale and failure modes: **`docs/invariants.md`**. Read the subsystem's section before changing it.

- pi is the only engine; never add harness selection. Map pi events onto existing webview shapes in `pi-stream-adapter.ts`; add a message type only for a capability no shape can carry.
- Tool-result image data never travels in a tool, history, subagent or team message or sits in a Pinia store: those carry `imageCount`, and `ToolResultImages.vue` fetches via `requestToolResultImages`.
- `Write` is the only text-file creation path; `Edit` cannot create. `GenerateImage` only creates new images and is gated as category `write`, never via `GATEABLE_MODULE_NAMES`.
- Browser/Compass/Web/Image/MCP tools are deferred until `ToolSearch` loads them: keep them in pi's eligible set, never name one in a prompt without an adjacent `ToolSearch` step, and pass every deferral site `deferrableToolNames()`. The ToolSearch menu equals the loadable set; report what pi activated and sanitize third-party MCP text.
- Nested (subagent/team) MCP arrives as `customTools` frozen at spawn from one descriptor read, never via the shared registrar. The grant is uniform; `disallowed_tools` (exact, case-sensitive) is the only opt-out.
- Read-only agents and team reviewers get plan mode's shell rule in every mode and are deliberately not capability-capped (they may call a non-annotated MCP tool through `canUseTool`). See "Teams and subagents" before changing it.
- The MCP client is `@earendil-works/pi-mcp`; Damocles owns the host layer (`mcp/`). Never load pi's built-in MCP extension, which keeps per-instance state where Damocles shares one instance per folder. See "MCP client and config sources".
- A custom tool under a pi built-in's name (`bash`, `grep`, `find`, `write`) replaces it: keep the exact lowercase name and never add an `excludeTools` entry for it, which drops the replacement too.
- The shell process-lifetime path has no timer, interval or process-table read (`tools/process-tree.ts`). `createShellJob` stays the first statement after `spawn`, or a background job becomes unkillable.
- A cancel note is user turn content, never appended to a tool result. A steer is a user message whose first line is `STEER_INSTRUCTION_PREFIX`; never merge peer or tool text into one, which would give it operator authority.
- An overlay's z-index comes from the shared stack (`useOverlayEscape.ts`), never a fixed `z-` class; popper content inside one binds `usePopperZIndex`, and a modal dialog joins via `useDialogLayer`.
- A chat's settings read passes its folder (`settingsFolderOf`) only for a `CHAT_SETTING_KEYS` key (`"scope": "resource"`), and project and local files apply only while the folder is trusted. Core decides write scopes per setter (D37), never the renderer. The desktop settings overlay is a `PanelManager.attachView` of the selected chat, limited to `SETTINGS_VIEW_MESSAGES` and `SETTINGS_VIEW_REQUESTS`, with host prompts only through `webview-prompts.ts`.
- Renderers read only `--d-*` tokens; `src/webview/styles/tokens.css` alone reads `--vscode-*`. Desktop fills the tokens from `src/desktop/main/theme.ts` (text at WCAG AA); `--s-*` and `--d-ansi-*` are desktop-only.
- Renderer sizes are rem (px ÷ 16); px only for border, ring and outline widths, blur, shadows and main's native view bounds. Icons use a `size-*` class, script-side sizes `remPx`, and layouts container queries, never viewport ones. ESLint and stylelint enforce it.
- All tool calls go through `permission-gate.ts`. Runtime blocks use `formatPolicyBlockReason` (an unasked deny only via `buildUnaskedDenyResult`); only a real user rejection uses `formatDenyReason`. Only a user deny without feedback or an opted-in hook sets `terminate`. A check that cannot decide blocks every tool, reads included.
- A conversation is live in one panel of one process (`claimStoredSession` plus the cross-process lease); a session-file write without a live session goes through `writeUnderSessionLease`. Session-keyed registries on `PiRuntime` and `FolderRuntime` unregister only the caller's own entry.
- Nothing appends to a deleted session file: every holder detaches first (`detachFromDeletedSession`), a writer re-checks liveness after each `await`, and no delete is sequenced off a promise that resolves on a failed replacement.
- Damocles reads other tools' config (`.claude`, `.codex`, `.pi`, `.mcp.json`) and writes only under `.damocles`, except the user-run Manage Unsafe Repositories and Add to .gitignore. Repository-authored input (instructions, skills, hooks, `.pi/`, MCP, permission rules) applies only in a trusted window, and on trust grant with no reload.
- Single sources of truth: plan content is the plan file (`getPlanContent()`), plan version is core's stamp on the `ExitPlanMode` result (`plan-version.ts`), plan guidance is `plan-mode-guidance.ts`, and the system prompt is `agent-start.ts` (pi's `customPrompt` plus named sections; returning `systemPrompt` drops every section).
- The pi extension is process-global: hold no instance-wide session state, route on `ctx.sessionManager.getSessionId()`, and queue checkpoint git work instead of awaiting it in a handler.
- Memory injection is a delta whose state comes only from each injection message's `details`. Neutralize emitted tag names in stored text; never register a `context` handler or rewrite a past injection, which breaks the prompt-cache prefix.
- An `agent_before_settle` handler returns `{ entries: [...event.entries, draft] }` and holds a turn open with `continue: true`, never `session.prompt()`.
- Page output is hostile: redact and bound it at capture, with linear-time patterns. Browser tools resolve tabs via the caller's `BrowserAgentScope`, never a global active page.
- Team delivery branches on `TeamMessage.kind`, never rendered text; the extension computes verification fingerprints, which fail visibly. `ReviewCoverage` (`review-coverage.ts`) is the one owner of review gating.
- `team_standby` and `team_report_complete` end the turn from the engine. Register a turn decider via `installTurnDecider`; assigning `agent.finishTurn` drops every extension `turn_end` handler.
- A team agent's work fields are per attempt and its usage is cumulative. The runner, `persistence.ts`, `TeamRunLog` and the webview store must agree, and agent times come only from team-log timestamps.
- Effort badges show pi's effective `thinkingLevel` after clamping, and only for a reasoning model (`src/shared/effort-badge.ts`).
- One publisher each: account state `PiSession.publishAccountInfo()` (called wherever an input changes, never once-guarded), session state `publishSessionState()` (a new prompt kind registers through `PermissionState`), and the chat's model `publishModel()` (only what pi adopted). The webview never infers or pre-shows them.
- The OpenAI key lives in the host secret store and the ChatGPT grant in `auth.json` `openai`. Never add OpenAI to `CUSTOM_PROVIDER_DEFS` or log out from the key sync; either deletes the grant.
- A subagent's model and effort are configuration (`Agent` has no `model` or `thinking` param). Every background subagent outcome reaches the parent once per branch; the branch and agent files are the truth, the `AgentManager` map a cache.
- Internal sub-calls use `PiRuntime.runStructuredCompletion` and classifier calls `PiRuntime.runClassification`; never hand-roll `completeSimple` or call `classify()`. Never mutate `process.env` for per-session config.
- Spend follows `src/shared/usage-accounting.ts`. Never bill from `history-loader.ts`'s context snapshot; status bar totals travel only in `sessionUsage`.
- Spawns use absolute paths: git via `resolveGitExecutable` (`src/core/git-executable.ts`), OS tools via `src/core/system-tools.ts` or a fixed path; `system-tools.test.ts` fails on a bare program name. `core/scm` runs git only in a trusted project (Clone excepted; its project starts untrusted), as argv with `GIT_EDITOR=true` and `GIT_TERMINAL_PROMPT=0`; a parent repository opens only after D9's answer, and askpass variables go only on calls that may need credentials, never into `process.env`.
- Search the code and memory observations for implementation gotchas before assuming.

## Permission Modes

| Mode | Behavior |
| --- | --- |
| `plan` | Bash/PowerShell classified by `readonly-shell.ts` (proven read-only auto-runs, else prompts); Edit/Write outside the plan file and GenerateImage blocked; memory, Compass and enabled MCP available |
| `default` | Diff for Edit/Write; prompts GenerateImage and Bash/PowerShell |
| `acceptEdits` | Auto-approves Edit/Write/GenerateImage, except a path a link carries outside the cwd; prompts Bash/PowerShell |

Read-only tools auto-approve in every mode unless an ask rule matches. Rules combine across all settings files as deny > ask > allow, and an ask rule prompts in every mode, after plan mode's blocks. `dangerouslySkipPermissions` (YOLO) approves everything. Detail: "Permissions and plan mode".

## Code Quality Standards

- Self-documenting, functional over OOP, related code kept close.
- Tailwind over custom CSS; controls are shadcn-vue parts from `src/webview/components/ui/` (add a missing one there), custom markup only with a one-line reason.

## Behavioral Principles

- **Think before coding:** state assumptions; if a request is unclear, ask. Push back when a simpler approach exists.
- **Simplicity first:** minimum code; no speculative features, abstractions, configurability or impossible-case handling.
- **Surgical changes:** touch only what the request needs; remove only what your change made unused, and mention pre-existing dead code instead of deleting it.
- **Goal-driven:** define success first; for a bug, write a failing test, then make it pass. State a brief plan for multi-step work.
