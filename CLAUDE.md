# CLAUDE.md

## Project Overview

Damocles is a VS Code extension integrating Claude AI via the Claude Agent SDK. Webview chat with diff approval, tool visualization, session management, MCP server support.

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
│ ClaudeSession (SDK wrapper)│              │ App.vue + Pinia Stores   │
│ PermissionHandler          │◄─postMessage─│ message-handler/         │
│ ChatPanelProvider          │              │ Components               │
└────────────────────────────┘              └──────────────────────────┘
```

- **Extension:** esbuild → `dist/extension.js` (CJS). Externals: SDK, `sql.js-fts5`, `zod`, `web-tree-sitter`
- **Webview:** Vite → `dist/webview/` (ESM). shadcn-vue + Tailwind + Shiki
- **Type aliases:** `@shared/*` → `src/shared/*`, `@/*` → `src/webview/*`

### Key Modules

| Module                | Purpose                                                                                                                    |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `browser/`            | Integrated CDP browser: Chrome launch, screencast, element picker, 15 MCP tools                                            |
| `claude-session/`     | SDK integration: query/streaming/tool/checkpoint/hook managers, `btw-handler.ts`                                           |
| `chat-panel/`         | Webview management: panel, session, settings, message routing, history                                                     |
| `permission-handler/` | Tool permissions via domain managers (approval, question, plan, skill, subagent)                                           |
| `memory/`             | Kind/scope memory + fact graph, auto-extraction, WASM SQLite/FTS5, pull-first catalog                                      |
| `recall/`             | Task-node-scoped context recall (RLM paper). BM25 → REPL sandbox                                                           |
| `voice/`              | STT via Whisper/Deepgram/Google Cloud + Jarvis on-device sidecar                                                           |
| `team/`               | 2-5 specialists + lead via MessageBus + Scratchpad. 161 AgentLand profiles                                                 |
| `explore/`            | Optional third-party model for the `Explore` subagent via authenticated loopback proxy (OpenRouter / Gemini / StepFun)     |
| `openai-bridge/`      | In-process Anthropic↔OpenAI/Codex translator behind a loopback proxy; supports Codex OAuth and `OPENAI_API_KEY` auth paths |
| `compass/`            | Knowledge graph: tree-sitter → SQLite → Louvain → 8 MCP tools                                                              |
| `session/`            | JSONL session persistence + metadata cache (incl. SDK AI-title display tier)                                               |
| `auth/`               | Damocles-owned OAuth, isolated from Claude Code CLI                                                                        |

### Patterns

- **Facade + DI:** Each module has `index.ts`; managers receive deps via constructor
- **Two-phase lazy init:** Constructor reads config; `ensureInitialized()` defers heavy work to first access (Memory, Compass)
- **Message routing:** Domain-handler registries — `message-router/handlers/` (extension), `message-handler/handlers/` (webview)

## Module Notes

Contracts and gotchas only — implementation details live in the code and memory observations.

**Browser** — Disabled by default. Headless Chromium over a raw CDP WebSocket (no Puppeteer). All attached pages live in `sessions: Map`; `focusStack` top is the active page — console/network handlers gate on it so popups don't pollute output. Anti-detection UA comes from `Browser.getVersion` and fails loud.

**Memory** — WASM SQLite/FTS5 at `~/.damocles/memory.v2.db`. Kind (fact/preference/observation/note/episode) × scope (session/project/global) with a versioned fact graph. Background consolidation (idle + session-switch) auto-extracts, dedups, and regenerates the user profile — crash-safe (reserve→persist→commit). Pull-first catalog per prompt (~300-800 tokens); 10 in-process MCP tools. Every mutation goes through a write queue; LLM calls run outside the lock.

**Team** — Disabled by default. Each agent is an independent SDK `query()` coordinating via in-process MessageBus + Scratchpad (`Scratchpad.set()` throws on overwrite — strict section ownership). Event-driven keep-alive; terminal status transitions re-check review-round readiness to prevent deadlock.

**Voice (Jarvis)** — Disabled by default. Python sidecar (wake word + VAD + ASR + optional TTS), fully on-device — no audio or transcripts leave the machine. Loopback WS with bearer token. Protocol is defined twice — `protocol.py` ↔ `voice/sidecar/protocol.ts` (Zod) — keep them in sync (a test asserts parity).

**Explore** — Disabled by default. Routes the SDK `Explore` subagent to a third-party model via a per-call loopback proxy (random 256-bit bearer, constant-time validated). Env overrides flow through SDK `options.env`, **never `process.env`** — one Node process hosts all extensions. SSE rewriting must stay UTF-8-safe (`StringDecoder` + JSON-scoped model swap; raw `replaceAll` corrupts chunk boundaries). SDK `tools: [...]` is the palette gate; `allowedTools` is auto-allow only.

**OpenAI Bridge** — Disabled by default; enabled by selecting a GPT model. In-process Anthropic↔Codex/OpenAI translator on a loopback server (constant-time bearer, workspace-trust gated). Contracts:

- Codex rejects `system`-role input items — `normalizeInputRole()` maps non-user/assistant roles to `developer`; the Anthropic system prompt rides the top-level `instructions` field.
- `buildOpenAIBridgeEnv()` maps every SDK tier alias to a real Codex model id — the bridge must never receive a literal `claude-*` name.
- No message/tool-count caps — only the 25 MB body cap. Auto-compaction is opt-in (`damocles.autoCompact`) for ALL backends; never force-compact GPT sessions (user decision).
- Internal sub-calls (Memory/Recall/btw): Haiku 4.5 on Anthropic, `gpt-5.4-mini` on OpenAI.
- The `Damocles: OpenAI Bridge` OutputChannel never logs tokens or bodies.

**Compass** — Disabled by default. Tree-sitter AST → SQLite (sql.js-fts5, `~/.damocles/compass/<workspace-hash>/graph.db`) → Louvain; 8 MCP tools; watcher-fed incremental updates (bursts >500 files fall back to git diff). Invariants: `withTransaction` is the only transaction entry point and nothing `await`s inside one; the light request queue is strictly read-only; the DB is a regenerable cache (corrupt → discard + rebuild); 3 consecutive worker crashes trip a circuit breaker (Rebuild resets). Git-derived paths resolve against the repo root and are re-anchored to the workspace's drive-case spelling (Windows); `SAFE_GIT_REF` rejects refs starting with `-`.

**Recall** — Stateless SDK queries (`persistSession: false`) + task-node-scoped retrieval (max 5 active nodes). Context returns directly under 400K chars; above that, BM25 orientation → REPL sandbox. Per-node JSONL at `<sessionId>/nodes/<nodeId>.jsonl`; dual session ids (stable persistence id + rotating SDK id). `/btw` bypasses node scoping.

**Workflow** — SDK `Workflow` tool (enabled by the Ultracode effort level) → dedicated card + 3-view overlay keyed by tool-use-id. The live completion notification is lean; the full result lives in the task output file (preferred over the SDK-truncated persisted `<result>`). The extension pushes per-agent transcripts; a per-session monotonic seq lets the webview drop out-of-order snapshots.

**SDK Integration** — `ClaudeSession` wraps SDK `query()`; SDK is dynamically imported (ESM from CJS). Custom `systemPrompt` replaces the `claude_code` preset; the `tools` preset is unchanged so built-in tools/agents still load. Prompt-index advances only in `sendMessage`; `{ isInternal: true }` skips it. Background-task ids are **not** turn-scoped (completion notifications arrive in later turns); `backgroundToolUseIds` is. Refusals (`stop_reason: 'refusal'`) → `RefusalCard`, structured detection only — never text-matched. `system:model_fallback` → inline notice: live wire is snake_case, persisted JSONL camelCase (type absent from `sdk.d.ts`, pinned from the engine binary + CI-tested); notices position by **adjacency, never wall clock** — replayed messages are stamped `Date.now()`.

**Session** — JSONL persistence + regenerable metadata cache. Display title = `customTitle || aiTitle || preview`. Gotcha: `getSessionInfo({ dir })` wants the workspace path (not the encoded session dir) and folds `aiTitle` into its `customTitle`.

**Auth** — Damocles-owned OAuth at `~/.damocles/auth/.credentials.json`; `~/.claude/.credentials.json` is never touched. `buildSdkEnv()` sanitizes env per call and **never mutates `process.env`**. `~/.claude/` is mirrored into `~/.damocles/auth/` (symlinks/junctions + copy-watch) except credentials, so plugins/skills/sessions stay shared with the CLI.

## Permission Modes

| Mode          | Behavior                                                                |
| ------------- | ----------------------------------------------------------------------- |
| `plan`        | Prompts Edit/Write/Bash/PowerShell — SDK instructs Claude to plan first |
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
