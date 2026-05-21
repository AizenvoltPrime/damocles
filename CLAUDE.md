# CLAUDE.md

## Project Overview

Damocles is a VS Code extension integrating Claude AI via the Claude Agent SDK. Webview chat with diff approval, tool visualization, session management, MCP server support.

## Development Commands

```bash
npm run build         # Build extension + webview
npm run dev           # Watch mode
npm run typecheck     # Type checking
npm run lint          # Lint
npm test              # Vitest (recall module)
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

| Module | Purpose |
| --- | --- |
| `browser/` | Integrated CDP browser: Chrome launch, screencast, element picker, 15 MCP tools |
| `claude-session/` | SDK integration: query/streaming/tool/checkpoint/hook managers, `btw-handler.ts` |
| `chat-panel/` | Webview management: panel, session, settings, message routing, history |
| `permission-handler/` | Tool permissions via domain managers (approval, question, plan, skill, subagent) |
| `memory/` | 5-tier persistent memory, WASM SQLite/FTS5, two-phase lazy init, pull-first catalog |
| `recall/` | Task-node-scoped context recall (RLM paper). BM25 → REPL sandbox |
| `voice/` | STT via Whisper/Deepgram/Google Cloud + Jarvis on-device sidecar |
| `team/` | 2-5 specialists + lead via MessageBus + Scratchpad. 161 AgentLand profiles |
| `explore/` | Optional third-party model for the `Explore` subagent via authenticated loopback proxy (OpenRouter / Gemini / StepFun) |
| `openai-bridge/` | In-process Anthropic↔OpenAI/Codex translator behind a loopback proxy; supports Codex OAuth and `OPENAI_API_KEY` auth paths |
| `compass/` | Knowledge graph: tree-sitter → SQLite → Louvain → 7 MCP tools |
| `session/` | JSONL session persistence + metadata cache |
| `auth/` | Damocles-owned OAuth, isolated from Claude Code CLI |

### Patterns

- **Facade + DI:** Each module has `index.ts`; managers receive deps via constructor
- **Two-phase lazy init:** Constructor reads config; `ensureInitialized()` defers heavy work to first access (Memory, Compass)
- **Message routing:** Domain-handler registries — `message-router/handlers/` (extension), `message-handler/handlers/` (webview)

## Module Notes

**Browser** — Headless Chromium + raw CDP WebSocket. Disabled by default. Browser-level WS connect + `Target.setDiscoverTargets` + `Target.setAutoAttach({autoAttach:true, waitForDebuggerOnStart:false, flatten:true})` so popups auto-attach. `sessions: Map<sessionId, PageSession>` (all attached) decoupled from `focusStack: string[]` (focus order, top = active). Promotion rule: `previousActive === null || targetInfo.openerId === previousActive.targetId` — covers first attach, DevTools reattach (focus vacated), and OAuth popups (opened by active page); background-spawned pages stay attached but hidden. Each `PageSession` stores `openerId` and `lastUrl` (updated on every `frameNavigated`/`navigatedWithinDocument` regardless of focus) so detach restores parent URL/title. Console/Network handlers gate on `isActive` (`sourceSession === active`) to prevent popup pollution of the shared collectors. Paired `firstSessionResolver`/`firstSessionRejecter` via `settleFirstSessionWait(err?)` surfaces real init errors instead of a 10 s timeout — called from `attachPage` catch (first-session path), `socket.onClose`, `cleanup()`, and `launchAndConnect`'s outer catch. Per-session webdriver mask + UA override + viewport via `Page.addScriptToEvaluateOnNewDocument` / `Emulation.setUserAgentOverride` / `Emulation.setDeviceMetricsOverride`; UA fetched from `Browser.getVersion` (fails loud — anti-detection contract).

**Memory** — WASM SQLite/FTS5 at `~/.damocles/memory.db`. Lazy ESM `import()`. Pull-first catalog (~300-800 tokens/prompt); `get_memory_details` on demand. Staleness via `FileChangeTracker`.

**Team** — In-process `MessageBus` + `Scratchpad`. Each agent = independent SDK `query()` with scoped MCP. Disabled by default. Lead facilitates only; specialists cross-reference peer scratchpad sections. Event-driven keep-alive (no hard turn cap; bounded by `KEEP_ALIVE_TIMEOUT_MS`/`MAX_KEEP_ALIVE_CYCLES`). Synthesis/review gates reject in precedence order: pending → non-settled → review-round-ready → stale-read. Strict section ownership (`Scratchpad.set()` throws on overwrite). Lead broadcast filter: direct messages only. Per-specialist AbortControllers. Wave-fired-on-terminal-status: terminal transitions trigger `notifyLeadIfReviewRoundReady()` to prevent deadlock. Pure helpers in `review-gate.ts`.

**Voice (Jarvis mode)** — Disabled by default. `mode === "wake-word"` spawns Python sidecar (OpenWakeWord + Silero VAD + Parakeet TDT 0.6B v2 + optional VibeVoice TTS). On-device only — sidecar captures audio natively (no PCM crosses WebSocket). IPC: loopback WS, subprotocol `damocles-voice.v1`, bearer token via `DAMOCLES_VOICE_TOKEN` env. Single protocol source: `protocol.py` ↔ `voice/sidecar/protocol.ts` (Zod). Pipeline: `LISTENING → POST_WAKE_OFFSET (250 ms) → WAITING_FOR_SPEECH → CAPTURING → TRANSCRIBING`. Two-layer wake-phrase exclusion (offset audio + regex strip; parity asserted by test). Manager: two-phase lazy init, env-sanitized, mkdir-lock singleton, 2 s ping / 3-miss restart. GPU detection via `nvidia-smi` (PATH + WSL2 fallback) gates torch channel. Pre-flight checks: C++ toolchain (`compiler-check.ts`), PortAudio (`system-libs-check.ts`), `localGpu` reconciliation. ~3.7 GB VRAM with TTS, ~2.2 GB without. OOM ladder unloads TTS → CPU restart.

**Explore** — Optional third-party model (OpenRouter/Gemini/StepFun) for the SDK's `Explore` subagent. Disabled by default. Per-call `ExploreProxy` on a random loopback port with a 256-bit `crypto.randomBytes(32)` bearer (constant-time validated, `/v1/messages` whitelist); env overrides flow via SDK `options.env`, never `process.env` — mutating it breaks peer extensions, same contract as Auth. SSE rewriter uses `StringDecoder('utf8')` + JSON-scoped `model`-field swap (raw `replaceAll` corrupts UTF-8 at chunk boundaries). Tool palette restricted via SDK `tools: [...]` — `allowedTools` is auto-allow, not a palette gate (`sdk.d.ts:1205-1211`). Rate-limit returns 429 + `rate_limit_error` so SDK retries engage. `LiveMessageBuilder` keeps incremental state for O(1) live updates. `EXPLORE_SECRET_KEYS` centralized in `explore/types.ts`.

**OpenAI Bridge** — In-process Anthropic↔Codex/OpenAI translator on a loopback `http.Server` with constant-time bearer auth (`crypto.timingSafeEqual`), so the Claude Agent SDK runs unchanged against GPT models. Disabled by default; enabled by selecting a GPT entry from `DEFAULT_MODELS`. Workspace-trust gated at both `proxy.start()` and `provisionOpenAIBridge()`. Two auth paths resolved per-request via `openai-auth.ts:resolvePreferredAuth()`: Codex OAuth (PKCE on `http://localhost:1455/auth/callback`; SecretStorage blob; module-level `refreshInFlight` mutex defeats thundering-herd from Team's parallel subprocesses; 5-minute expiry buffer) and `OPENAI_API_KEY` (probed via `GET /v1/models` before persist). Codex wins; `damocles.openai.preferApiKey` inverts (ack via `setOpenAIPreferApiKeyAck`). Per-bearer routing (`Map<bearer, BridgeRouteEntry>`) rotates on auth-mode change so panels with different backends share one proxy. Whitelist `/v1/messages` + `/health` + `/v1/messages/count_tokens`; `Content-Type: application/json` 415 gate; `Origin` / `Sec-Fetch-Site` 403 gate; inbound `Content-Length` + chunk-cumulative 25 MB cap (413 before parsing); 10-slot semaphore with split slot/drain queues; cancellation via `res.on('close')` + `AbortController` (the `!res.writableEnded` guard is critical — `req.on('close')` fires when `for await` finishes reading the body, not on disconnect); 4× exponential backoff honoring `Retry-After`; mid-stream 401 → Anthropic `auth_error` SSE. Translator (`openai-transform.ts`) does true event-by-event SSE — strips `x-anthropic-*` lines (neutralizes Claude Code CLI's rotating `cch` hash that defeats Codex's prompt cache), `cache_control` markers, and `thinking` blocks from inbound `messages[]`; tool-name normalization for >64-char MCP tools with reverse-mapping; over-limit raises typed errors instead of silent truncation. GPT-5.x quirks handled at the protocol boundary: `function_call_arguments` deltas are buffered per-item and stripped of top-level empty-string keys before SDK delivery; the post-`ExitPlanMode` "User has approved your plan…" tool_result gets an execution directive appended. `effortForPanelAndModel(panelId, modelId)` is a required dep, layering `damocles.effortByModel` user overrides above `ModelInfo.openaiReasoningEffort` factory defaults. Shared `provisionOpenAIBridge()` reaches `claude-session/query-manager.ts`, `team/agent-runner.ts`, `team/team-runner.ts`, and `explore/index.ts` "main-chat" provider. Team Lead auto-selected by panel backend (Opus 4.7 on Anthropic, `gpt-5.5` on OpenAI); specialist whitelist tier-aligned (`gpt-5.5`/`gpt-5.4`/`gpt-5.4-mini` for OpenAI, Opus/Sonnet/Haiku for Anthropic) and enforced inside `team_spawn_specialist`. `TeamRunner.releaseBridgePanels()` evicts every synthetic per-agent bearer on team completion so the route Map doesn't leak. Memory/Recall/btw use Haiku 4.5 on Anthropic (`getSmallFastModel()`) and `gpt-5.4-mini` on OpenAI (`resolveSmallFastModelForEnv()`); both hardcoded; graceful degradation via `requireAuthFor()` when the backend's credentials are absent. Family-alias env contract for OpenAI sessions: `buildOpenAIBridgeEnv()` injects `ANTHROPIC_DEFAULT_OPUS_MODEL=gpt-5.5`, `ANTHROPIC_DEFAULT_SONNET_MODEL=gpt-5.4`, `ANTHROPIC_DEFAULT_HAIKU_MODEL={smallFast}`, `CLAUDE_CODE_SUBAGENT_MODEL={active}` so any SDK tier-alias request resolves to a real Codex model ID — the bridge never receives a literal `claude-*` model name. Dedicated `Damocles: OpenAI Bridge` OutputChannel never logs tokens or bodies; no disk dumps.

**Compass** — Knowledge graph via tree-sitter AST → SQLite → Louvain → 7 MCP tools. Disabled by default. Grammar WASM via `npm run fetch:grammars`. SQLite (sql.js-fts5) at `~/.damocles/compass/<workspace-hash>/graph.db`. 15 language extractors share `extractor-base.ts`. FTS5 BM25 with `splitIdentifier()` for partial-name search; kind boosting. App-level bidirectional BFS for impact analysis. Louvain via graphology-communities-louvain (deterministic; resolution scales inversely with graph size; directory fallback >20K nodes). Incremental: git delta + SHA-256 + 2-hop transitive invalidation. Cooperative scheduler: light reads preempt heavy builds at `scheduler.yield()` checkpoints. Security: symlink skip, FTS5 query escaping, parameterized SQL. UI: D3 force graph, validation panel, tree view with blast-radius groups. Integrations: `UserPromptSubmit` injects `<damocles_compass>` XML; recall uses graph neighbors for BM25 expansion.

**Recall** — Stateless queries (`persistSession: false`) + task-node-scoped retrieval (RLM paper, arXiv 2512.24601v2). User-managed task nodes (max 5 active). New nodes seed from pre-node orphan history. Direct passthrough under `maxInjectedChars` (400K default). Two-stage REPL fallback: Haiku query expansion → BM25 → JS sandbox retrieval. Per-node JSONL in `<sessionId>/nodes/<nodeId>.jsonl`. Subagent isolation via `parentToolUseId`. Dual session IDs (stable persistence + rotating SDK). `/btw` bypasses node scoping.

**SDK Integration** — `ClaudeSession` wraps SDK `query()` with `canUseTool` → PermissionHandler, lifecycle hooks, `stream_event` deltas. SDK dynamically imported (ESM from CJS). Custom `systemPrompt` replaces SDK's `claude_code` preset (drops auto-memory ~800 tokens, adds anti-verbosity rules); `tools` preset unchanged so built-in tools/agents still load. `buildThinkingOptions()` via `ModelInfo.supportsAdaptiveThinking`. `normalizeToolResult()` dual-path (live via `tool-manager.ts`, history via `history-manager.ts`). Prompt-index advances only in `sendMessage`; `{ isInternal: true }` skips advance for system-issued prompts. Remote messages reroute through `sendMessage` via UserPromptSubmit `decision: 'block'` so recall and non-recall share one counter site. History replay restamps from `node-turn-ref` JSONL (`uuid → {promptIndex, nodeId}`), falling back to a synthetic counter that advances only when `!isInjected`.

**Auth** — Damocles owns its OAuth grant, fully isolated from Claude Code CLI. Credentials at `~/.damocles/auth/.credentials.json`; `~/.claude/.credentials.json` is never touched. Single path source: `paths.ts`. Per-call env sanitization via `sdk-env.ts:buildSdkEnv()` — fresh sanitized env per call (strips `CLAUDE_CODE_OAUTH_TOKEN` + `ANTHROPIC_API_KEY`, pins `CLAUDE_CONFIG_DIR`, force-enables PowerShell tool on Windows). Never mutates `process.env` (single Node process for all extensions). Dynamic config-dir mirror: `config-dir-bootstrap.ts` walks `~/.claude/` and surfaces every top-level entry (except `.credentials.json` and `.claude.json`) under `~/.damocles/auth/` — directories via symlink (junction on Windows), files via atomic copy + per-file watch. Both `.credentials.json` and `.claude.json` are exclusively Damocles-owned. `.claude.json` initialized via `initializeClaudeConfigViaCli()` — async spawn of bundled CLI's `mcp list` in ephemeral tmpdir, result copied in (in-place runs blocked by CLI backup-detection gate; hardcoded seeds rejected by SDK schema). Failed-merge memo + SHA-256 dedupe in `migrateRealDirIntoTarget()`. Existing CLI users sign in once to mint a separate grant — no migration.

## Permission Modes

| Mode          | Behavior |
| ------------- | -------- |
| `plan`        | Prompts Edit/Write/Bash/PowerShell — SDK instructs Claude to plan first |
| `default`     | Shows diff for Edit/Write, prompts Bash/PowerShell |
| `acceptEdits` | Auto-approves Edit/Write, prompts Bash/PowerShell |

Read-only tools auto-approved in all modes. `dangerouslySkipPermissions` (YOLO) auto-approves everything.

## Code Quality Standards

- No fallback business logic, backwards compatibility, or bandaid fixes — address root causes
- Self-documenting code; avoid inline comments
- Prefer functional patterns over OOP
- Tailwind instead of custom CSS; shadcn-vue from `src/webview/components/ui/`
- **Dependency Injection:** Managers receive deps via constructor, wired in facade `index.ts`
- **Locality of Behavior:** Keep related code physically close
