# CLAUDE.md

## Project Overview

Damocles is a VS Code extension integrating Claude (and GPT) via an agent harness. New sessions run on the **pi harness** (`pi-session/`) by default; the Claude Agent SDK path (`claude-session/`) is a Node < 22 fallback (the VS Code host satisfies ≥ 22, so it's dormant). Both backends share the webview message contract — only the producer differs. Webview chat with diff approval, tool visualization, session management, checkpoints/rewind, and persistent memory.

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
│ ChatSession seam:          │              │ App.vue + Pinia Stores   │
│   PiSession (default) /     │◄─postMessage─│ message-handler/         │
│   ClaudeSession (fallback) │              │ Components               │
│ PermissionHandler          │              │                          │
│ ChatPanelProvider          │              │                          │
└────────────────────────────┘              └──────────────────────────┘
```

- **Extension:** esbuild → `dist/extension.js` (CJS). Externals: SDK, `sql.js-fts5`, `zod`, `web-tree-sitter`
- **Webview:** Vite → `dist/webview/` (ESM). shadcn-vue + Tailwind + Shiki
- **Type aliases:** `@shared/*` → `src/shared/*`, `@/*` → `src/webview/*`

### Key Modules

| Module                | Purpose                                                                                                                    |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `browser/`            | Integrated CDP browser: Chrome launch, screencast, element picker, 15 MCP tools                                            |
| `claude-session/`     | **Fallback** SDK integration (Node < 22): query/streaming/tool/checkpoint/hook managers, `btw-handler.ts`. Also defines the `ChatSession` seam (`chat-session.ts`) both backends implement |
| `chat-panel/`         | Webview management: panel, session, settings, message routing, history                                                     |
| `permission-handler/` | Tool permissions via domain managers (approval, question, plan, skill, subagent)                                           |
| `memory/`             | Kind/scope memory + fact graph, auto-extraction, WASM SQLite/FTS5, pull-first catalog                                      |
| `recall/`             | Task-node-scoped context recall (RLM paper). BM25 → REPL sandbox. **SDK-only** (degrades on pi)                            |
| `voice/`              | STT via Whisper/Deepgram/Google Cloud + Jarvis on-device sidecar                                                           |
| `team/`               | 2-5 specialists + lead via MessageBus + Scratchpad. 161 AgentLand profiles. **SDK-only** (degrades on pi)                  |
| `explore/`            | Third-party model for the SDK `Explore` subagent via authenticated loopback proxy. **SDK-only** (degrades on pi)           |
| `compass/`            | Knowledge graph: tree-sitter → SQLite → Louvain → 8 MCP tools                                                              |
| `session/`            | **SDK-path** JSONL persistence + metadata cache (pi uses `pi-session/session-store/`)                                       |
| `auth/`               | Damocles-owned OAuth (SDK fallback path), isolated from Claude Code CLI                                                    |
| `pi-session/`         | **Default** agent harness: `PiSession` (implements `ChatSession`), single `PiRuntime`, 3-mode Claude auth, pi-native OpenAI (Codex OAuth + API key, no bridge). `session-store/` (tree-JSONL persistence, titles, rename/tag/delete, rewind history) + `checkpoints/` (per-session bare-git shadow repo: checkpoint/rewind/fork) |

### Patterns

- **Facade + DI:** Each module has `index.ts`; managers receive deps via constructor
- **Two-phase lazy init:** Constructor reads config; `ensureInitialized()` defers heavy work to first access (Memory, Compass)
- **Message routing:** Domain-handler registries — `message-router/handlers/` (extension), `message-handler/handlers/` (webview)

## Module Notes

Contracts and gotchas only — implementation details live in the code and memory observations.

**Browser** — Disabled by default. Headless Chromium over a raw CDP WebSocket (no Puppeteer). All attached pages live in `sessions: Map`; `focusStack` top is the active page — console/network handlers gate on it so popups don't pollute output. Anti-detection UA comes from `Browser.getVersion` and fails loud.

**Memory** — WASM SQLite/FTS5 at `~/.damocles/memory.v2.db`. Kind (fact/preference/observation/note/episode) × scope (session/project/global) with a versioned fact graph. Background consolidation (idle + session-switch) auto-extracts, dedups, and regenerates the user profile — crash-safe (reserve→persist→commit). Pull-first catalog per prompt (~300-800 tokens); 10 in-process MCP tools. Every mutation goes through a write queue; LLM calls run outside the lock.

**Team** — Disabled by default. **SDK** path only (each agent is an independent SDK `query()`); a GPT panel forces Claude models until Team is ported to pi (ROADMAP US-024). Coordinates via in-process MessageBus + Scratchpad (`Scratchpad.set()` throws on overwrite — strict section ownership). Event-driven keep-alive; terminal status transitions re-check review-round readiness to prevent deadlock. **Gotcha:** team agents bypass `query-manager`, so `agent-runner.ts:resolveAgentModel()` must re-apply the `[1m]` 1M-context suffix for `alwaysUses1mContext` models (Opus 4.8, Fable 5) — else an inherited bare `claude-opus-4-8` silently runs at 200K.

**Voice (Jarvis)** — Disabled by default. Python sidecar (wake word + VAD + ASR + optional TTS), fully on-device — no audio or transcripts leave the machine. Loopback WS with bearer token. Protocol is defined twice — `protocol.py` ↔ `voice/sidecar/protocol.ts` (Zod) — keep them in sync (a test asserts parity).

**Explore** — Disabled by default. Routes the SDK `Explore` subagent to a third-party model via a per-call loopback proxy (random 256-bit bearer, constant-time validated). Env overrides flow through SDK `options.env`, **never `process.env`** — one Node process hosts all extensions. SSE rewriting must stay UTF-8-safe (`StringDecoder` + JSON-scoped model swap; raw `replaceAll` corrupts chunk boundaries). SDK `tools: [...]` is the palette gate; `allowedTools` is auto-allow only.

**OpenAI / GPT** — Pi-native; the `openai-bridge/` module is deleted (no loopback translator). pi speaks both providers directly: `openai-codex` (Codex/ChatGPT OAuth) and `openai` (`OPENAI_API_KEY`). `resolvePiModel()` prefers Codex when both are set; `damocles.openai.preferApiKey` (workspaceState) inverts it — threaded into `resolvePiModel`/`buildAccountInfo`, so the toggle is functional. Auto-compaction stays opt-in (`damocles.autoCompact`) for all backends. SDK-fallback sub-calls (Memory/Recall/btw) are Anthropic-only; OpenAI models degrade via `requireAuthFor`.

**Compass** — Disabled by default. Tree-sitter AST → SQLite (sql.js-fts5, `~/.damocles/compass/<workspace-hash>/graph.db`) → Louvain; 8 MCP tools; watcher-fed incremental updates (bursts >500 files fall back to git diff). Invariants: `withTransaction` is the only transaction entry point and nothing `await`s inside one; the light request queue is strictly read-only; the DB is a regenerable cache (corrupt → discard + rebuild); 3 consecutive worker crashes trip a circuit breaker (Rebuild resets). Git-derived paths resolve against the repo root and are re-anchored to the workspace's drive-case spelling (Windows); `SAFE_GIT_REF` rejects refs starting with `-`. Scoped CALLS targets are emitted as `Scope::method` for `::`-syntax languages (php/cpp/rust/ruby) and resolved parent-aware in `resolveExternalEdges`; TESTED_BY is CALLS-derived (primary) plus a provenance-tagged (`extra={"derived":"name"}`) class/file-stem name fallback for DI-heavy tests that never call their subject. REFERENCES also covers type-position references (parameter/property/field/return type hints, incl. constructor promotion and generic args) across typed/type-hinted languages, so DI/type-hint-injected types are not false-positive dead code; primitive node types are skipped and unresolved builtins self-clean in `resolveExternalEdges`.

**Recall** — Stateless SDK queries (`persistSession: false`) + task-node-scoped retrieval (max 5 active nodes). Context returns directly under 400K chars; above that, BM25 orientation → REPL sandbox. Per-node JSONL at `<sessionId>/nodes/<nodeId>.jsonl`; dual session ids (stable persistence id + rotating SDK id). `/btw` bypasses node scoping.

**Workflow** — SDK `Workflow` tool (enabled by the Ultracode effort level) → dedicated card + 3-view overlay keyed by tool-use-id. The live completion notification is lean; the full result lives in the task output file (preferred over the SDK-truncated persisted `<result>`). The extension pushes per-agent transcripts; a per-session monotonic seq lets the webview drop out-of-order snapshots.

**SDK Integration** — `ClaudeSession` wraps SDK `query()`; SDK is dynamically imported (ESM from CJS). Custom `systemPrompt` replaces the `claude_code` preset; the `tools` preset is unchanged so built-in tools/agents still load. Prompt-index advances only in `sendMessage`; `{ isInternal: true }` skips it. Background-task ids are **not** turn-scoped (completion notifications arrive in later turns); `backgroundToolUseIds` is. Refusals (`stop_reason: 'refusal'`) → `RefusalCard`, structured detection only — never text-matched. `system:model_fallback` → inline notice: live wire is snake_case, persisted JSONL camelCase (type absent from `sdk.d.ts`, pinned from the engine binary + CI-tested); notices position by **adjacency, never wall clock** — replayed messages are stamped `Date.now()`.

**Session (SDK-path)** — JSONL persistence + regenerable metadata cache for the SDK fallback (pi uses `pi-session/session-store/`). Display title = `customTitle || aiTitle || preview`. Gotcha: `getSessionInfo({ dir })` wants the workspace path (not the encoded session dir) and folds `aiTitle` into its `customTitle`.

**Auth** — Damocles-owned OAuth at `~/.damocles/auth/.credentials.json`; `~/.claude/.credentials.json` is never touched. `buildSdkEnv()` sanitizes env per call and **never mutates `process.env`**. `~/.claude/` is mirrored into `~/.damocles/auth/` (symlinks/junctions + copy-watch) except credentials, so plugins/skills/sessions stay shared with the CLI.

**pi Harness (`pi-session/`)** — The **default** agent backend (replaces the SDK; full plan in `ROADMAP.md`), on the pi runtime (`@earendil-works/pi-coding-agent`). `getEffectiveHarness()` → `'pi'` when host Node ≥ 22 (B5), else `'sdk'` fallback — no user-facing toggle. pi loads via dynamic `import()` (B2); one module-level `PiRuntime` owns provider registration (B1); auto-compaction force-disabled (B3); pi reads a Damocles-owned `agentDir` (`~/.damocles/pi/agent`), never `process.env`. `PiSession` implements `ChatSession`; `PiStreamAdapter` maps pi events to the unchanged webview contract. **Phases 2–4 landed** (Phase 2: tools + permissions + plan + extension UI; Phase 3: SDK-decoupled on the pi path — memory/compass/browser re-wrapped, native sub-calls via `runStructuredCompletion`, Damocles `systemPromptOverride`, budget meter; Phase 4: native sessions/titles/tags/checkpoints/rewind/fork — see the **pi Sessions & Checkpoints** note; SDK now fallback-only). Tool set = pi-native `read/bash/write/grep/find/ls` + custom CC-shaped tools (`Edit`, `PowerShell`, `Task*`, `AskUserQuestion`, `EnterPlanMode`/`ExitPlanMode`; built per-session in `tools/`) + in-process module tools (memory/compass/browser) re-wrapped from `createSdkMcpServer` to pi `defineTool` under PascalCase active-set names (`SaveMemory`, `CompassSearch`…; US-006, schema-parity tested in `tools/__tests__/*-schema-parity.test.ts`) + opt-in `pi-web-access` (`web_search`/`fetch_content`); `tool-normalization.ts` maps pi name/input/`details` → the unchanged webview shapes. A `ToolsStatusPanel` (catalog in `tools/tool-catalog.ts`, live snapshot via `ChatSession.getToolStatus()`) groups every tool by subsystem (core/memory/compass/browser/web) with per-tool + per-subsystem switches (core locked on); it **replaces the removed Claude Code plugin system** (`PluginService` + plugin UI gone). A central `tool_call` gate (`permission-gate.ts`) routes through `canUseTool` (read auto-allowed; write/shell → diff approval; plan mode restricts to the read-only set). A webview-bridged `ExtensionUIContext` (`extension-ui-context.ts` ↔ `ExtensionUiDialog.vue`, additive `extensionUiRequest`/`extensionUiResponse` messages) renders extension `ctx.ui.*` dialogs. Sessions/titles/tags/checkpoints/rewind/fork are native (Phase 4); recall, team, btw, explore, external MCP, and remote control still degrade gracefully (no live method throws). **Gotchas:** `Edit` cannot create files (empty `old_string` throws — Write is the sole creation path); `reset()`/`clear()` chain `newSession()` serially via `resetPromise`; `prepareSessionExtensions()` reloads the shared extension runtime per session except the **process's first-ever** one (reload doesn't invalidate other panels' live sessions — it isolates each session's runtime); `interrupt()`/`cancel()` set `_aborting` so the abort-induced `prompt()` rejection doesn't stack an error card on `sessionCancelled`; `PowerShell` kills the whole tree (`taskkill /T /F` on Windows) on timeout/abort. **Three Claude auth modes** (`ClaudeAuthPanel.vue`): API key; subscription · **extra usage** (pi OAuth → metered); subscription · **allowance** (same `sk-ant-oat` token via the third-party `pi-anthropic-oauth` plugin — pinned to the `AizenvoltPrime` fork in `SUBSCRIPTION_SOURCE` with the `@<sha>` committish — so requests mimic the official Claude Code CLI → included quota). **Allowance very likely violates Anthropic's ToS** — explicit opt-in only; never ship the plugin/shaping code in the marketplace build (FR-2). pi owns + self-refreshes the grant.

**pi Sessions & Checkpoints (`pi-session/session-store/` + `checkpoints/`)** — Phase 4, native (not the SDK). **Sessions:** pi `SessionManager` tree-JSONL at `~/.damocles/pi/agent/sessions/<encoded-cwd>/<isoTs>_<uuidv7>.jsonl` — the file base is NOT the session id (split on the first `_`). Metadata is computed from the **active branch** (`getBranch(getLeafId())`, not `getEntries()`) so abandoned rewind/fork branches don't inflate counts; an **mtime-keyed cache** skips re-parsing unchanged files (key normalized — lowercased on win32 — so the watcher's `uri.fsPath` `c:\` and the list's `os.homedir()` `C:\` collapse to one entry). Rename/tag/title persist as inert in-tree custom entries (`damocles-user-renamed` / `damocles-tag`, latest-wins) + `setSessionName`; the lister skips custom entries. **Gotcha:** mutating a session that is **live** in some panel must go through that panel's own `SessionManager` (routed via `PiRuntime._sessionMutators` by sessionId) — a second file-writer anchors to the open()-time leaf and **forks the branch, silently dropping messages**. Deleting the active session tears it down (`whenReplaced()`) **before** the rm, else an in-flight append resurrects it. **Checkpoints:** per-session bare git repo at `~/.damocles/pi/checkpoints/sessions/<encoded-cwd>/<file-basename>/`, work-tree = project; object-DB **seeded from the user's repo** (alternates + warm index) to kill a ~47s cold start. Commit-before-turn on `message_start`; **rewind** = best-effort safety commit then `reset --hard <beforeCommit>` + `clean -fd` (unconditional hard restore — no dirty guard — recreates files deleted since); the "files affected" preview is the **live diff** (current work tree vs target), not the static turn diff. **Fork** = `createBranchedSession` on a **fresh** `SessionManager.open(sourceFile)` (NEVER the live manager — pi reassigns sessionId/sessionFile on whatever manager it runs on) + cloned checkpoint repo. Advisory lock = atomic `mkdir` + heartbeat + owner-pid liveness (only break when the owner is gone); `-c core.excludesFile=` pinned for determinism; per-workspace orphan-repo prune on session-list load. Context-used token count = the **last** assistant message's input+cacheRead+cacheWrite snapshot, never summed across a multi-call turn (summing double-counts cache).

## Permission Modes

| Mode          | Behavior                                                                |
| ------------- | ----------------------------------------------------------------------- |
| `plan`        | Prompts Edit/Write/Bash/PowerShell; on pi the active tool set is restricted to read-only + interactive |
| `default`     | Shows diff for Edit/Write, prompts Bash/PowerShell                      |
| `acceptEdits` | Auto-approves Edit/Write, prompts Bash/PowerShell                       |

Read-only tools auto-approved in all modes. `dangerouslySkipPermissions` (YOLO) auto-approves everything.

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
