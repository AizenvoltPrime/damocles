# ROADMAP: Rebuild Damocles' Agent Harness on pi (full Claude Agent SDK replacement)

> Self-contained plan. No prior context required to execute it.

## 0. Current state (branch `pi-harness`, not committed)

**Done + verified live (F5):**

- **Phase 0 / US-001** — pi embeds in-process; single `PiRuntime`; one prompt streams a subscription-billed Opus 4.8 reply. `src/extension/pi-session/`.
- **B1** single-runtime guard; **B2** pi as esbuild externals + node_modules + dynamic `import()`; **B3** compaction off (seeded settings + `setAutoCompactionEnabled(false)`).
- **B5 (NEW blocker, not in original plan)** — pi's `undici@8.3.0` needs **Node ≥ 22**; the VS Code host (Electron 42 → Node 22) satisfies it; guarded by `nodeSupportsPi()`. Local CLI is Node 20, so run smoke/spike under Node 22.
- **US-009** — Damocles agentDir `~/.damocles/pi/agent` (compaction off, blockImages false), passed explicitly, never via `process.env`.
- **US-021 — DONE but REDESIGNED (supersedes §10/§2 wording):** Claude auth is **pi-NATIVE**, not a token-bridge, surfaced as a **webview Settings → "Claude Authentication"** 3-mode radio panel (`ClaudeAuthPanel.vue`, no commands): **API key**; **subscription · allowance** (OAuth + `pi-anthropic-oauth` plugin → `user-agent: claude-code/…` → included quota, **ToS-gray: impersonates the official CLI**); **subscription · extra usage** (same OAuth token, no plugin → pi-ai built-in `claude-cli/…` → metered). allowance↔extra share one `sk-ant-oat` token; the plugin is a request-shaping layer toggled (install/remove) with no re-login. pi owns + self-refreshes the grant (cross-platform, survives SDK removal). Mode derived from credential type + plugin presence. FR-3 holds (stored OAuth beats env `ANTHROPIC_API_KEY`). The far-future/sentinel bridge (and old H1/H2 hazards) are **removed**.

**Verified:** typecheck + lint clean; extension + webview build green; pi-session unit tests pass; live F5 sign-out/in + Opus 4.8 stream confirmed.

**Pending decision:** OpenAI pi-native auth path (API key / ChatGPT subscription / both) — fold into US-002.

**Next:** US-002 — wire `PiSession` into the real chat behind a feature flag (stream→webview adapter), and migrate OpenAI to pi-native + delete the openai-bridge in the same cutover.

## 1. Context

**Damocles** is a VS Code extension (chat webview + Pinia, extension host in Node) currently built on Anthropic's **official Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk`). A single facade, `ClaudeSession` (`src/extension/claude-session/index.ts`), wraps the SDK `query()` call; ~15 streaming processors decode the SDK's wire format into `ExtensionToWebviewMessage`s the webview renders. A large ecosystem sits on top: permission handler (diff approval, modes), in-process MCP tools (memory, compass, browser, team), subagents, an OpenAI bridge (Anthropic↔Codex translator behind a loopback proxy), an explore proxy (third-party model for the Explore subagent), Damocles-owned OAuth, recall, voice, workflow.

**Goal:** replace the Claude Agent SDK with the best, most independent harness — owning the agent loop, gaining native multi-provider support, and reducing lock-in to Anthropic's SDK cadence and ToS.

**pi** (`C:\GameDev\pi`, MIT) is the "Pi Agent Harness" monorepo. Reusable layers:

- `@earendil-works/pi-ai` — unified multi-provider LLM API (Anthropic/OpenAI/Google/…): providers, streaming events (`AssistantMessageEvent`), model registry, `Usage`/cost, OAuth provider primitives. **No** constrained/structured-output (json_schema) support.
- `@earendil-works/pi-agent-core` — provider-agnostic agent runtime: tool-calling loop, hooks, session JSONL stores, compaction.
- `@earendil-works/pi-coding-agent` — the batteries-included SDK: `createAgentSession`/`createAgentSessionRuntime`, built-in tools, the **extension system** (loader + `ExtensionAPI`), `AuthStorage`, `ModelRegistry`, `SessionManager`, package manager. **This is the embed target.**
- `@earendil-works/pi-tui` — terminal UI; **not** webview-reusable; never import it.

**pi-anthropic-oauth** (`C:\GameDev\pi-anthropic-oauth`) is a third-party pi _extension_ that adds Claude Pro/Max **subscription** OAuth. Verified behavior: after `/login`, the stored token is an `sk-ant-oat…` OAuth token; the stream sends it as a **Bearer** token (not `x-api-key`), with `anthropic-beta: oauth-2025-04-20,claude-code-20250219,interleaved-thinking-2025-05-14`, `user-agent: claude-code/…`, `x-app: cli`, and forces the system prompt to begin with "You are Claude Code, Anthropic's official CLI for Claude." This bills against the **subscription quota, not metered API**. The README warns it "may go against Anthropic's terms."

## 2. Decisions (locked)

- **Strategy:** full replacement of the Claude Agent SDK with pi (not hybrid/cherry-pick).
- **Embed:** in-process, via the pi **coding-agent SDK** (`createAgentSessionRuntime`/`createAgentSession`), behind the existing `ClaudeSession` public interface (implemented as `PiSession`) so the webview/message layer is untouched. pi owns provider compatibility, auth/OAuth, model registry, sessions, and the extension loader; Damocles owns behavior (its tools, system prompt, hook/injection bus, permission gating, streaming-to-webview).
- **Subscription delivery (ToS-safe):** the marketplace build ships **no** provider/OAuth/Claude-Code-shaping code. An "Enable Claude subscription" action installs the **third-party** `pi-anthropic-oauth` into pi's global extensions dir; pi's loader registers the Claude Pro/Max provider into Damocles' runtime. The ToS-sensitive code lives only in a package Damocles neither authors nor ships (OpenCode-style stance — informed, accepted gray area).
- **Scope — keep:** memory, compass, browser, voice (cores are SDK-agnostic), **Team**, **btw**.
- **Scope — drop:** **Recall**, **Workflow/Ultracode**, **Cron/Loop jobs**, **remote-control** (superseded by pi's native steering).
- **Tools:** Damocles supplies its own Claude-Code-named tools (Read/Glob/Grep/Edit/Write/Bash + a first-class **PowerShell** tool) and re-wraps memory/compass/browser/team as pi `ToolDefinition`s, each keeping Damocles' diff-approval/permission gating. pi's lowercase built-ins are excluded.

## 3. CRITICAL BLOCKERS (must be solved first; these define the architecture)

These were found by source-level red-teaming and are front-and-center because the migration fails without them.

**B1 — pi's provider registry is a process-global singleton; `reload()` wipes the OAuth provider.** `registerApiProvider`/`registerOAuthProvider` (`pi/packages/ai/src/.../api-registry.ts`) write module-level singletons keyed by `api` ("anthropic-messages"). One Node process hosts _all_ VS Code extensions and could host multiple Damocles sessions/windows. `AgentSession.reload()` calls `resetApiProviders()` which `clearApiProviders()` then re-registers only built-ins — **silently dropping the OAuth provider** (so subscription requests fall back to API-key/identity).

- **Mitigation (architecture):** the _provider/OAuth registry_ is the shared singleton — own it once via a single module-level `PiRuntime` in Damocles that performs all provider registration. **Multiple concurrent `AgentSession`s are allowed and expected** (Team agents, btw, subagents) — they share that one registry/runtime; only provider (re)registration must be serialized and single-owned. After _any_ `reload()`, re-run extension provider registration and assert `pendingProviderRegistrations` re-flushed. Guard against a second `PiRuntime`/registry init in the process. This is the single highest-risk item.

**B2 — pi cannot be esbuild-bundled into `dist/extension.js`.** pi is pure ESM and uses `import.meta`/`import.meta.resolve`; the extension is a CJS esbuild bundle. Inlining breaks `import.meta`, `getPackageDir()`'s package.json walk, and the loader's `getAliases()` `dist/` resolution.

- **Mitigation:** add pi packages to esbuild `external` and ship them as **real `node_modules`** (exactly as `@anthropic-ai/claude-agent-sdk` is today). Import pi only via dynamic `import()` from CJS, behind an async seam. Externals to add in `esbuild.config.mjs`: `@earendil-works/pi-coding-agent`, `@earendil-works/pi-agent-core`, `@earendil-works/pi-ai`, `@earendil-works/pi-tui`, `jiti`, `typebox`, `@anthropic-ai/sdk`. Install the _published npm_ `@earendil-works/pi-coding-agent` with its real deps so the loader's fallback `import.meta.resolve("@earendil-works/pi-ai/oauth")` etc. succeed.

**B3 — pi auto-compaction defaults ON and runs inside the loop.** `getCompactionEnabled()` returns `?? true`; `_checkCompaction` runs after every `agent_end` and before each prompt, including a "force-compact on overflow" path. Damocles' hard rule: compaction is **opt-in via `damocles.autoCompact` for ALL backends, never forced**.

- **Mitigation:** at session creation, `session.setAutoCompactionEnabled(false)` unconditionally (or seed a `SettingsManager` with `compaction.enabled=false`). Gate all compaction behind `damocles.autoCompact`, driving `session.compact()` host-side at a chosen threshold. Because disabling also disables overflow auto-recovery, Damocles must handle context-overflow errors host-side (surface to user / offer manual compact).

**B4 — forced-tool / structured output is dropped on the subscription (OAuth) path.** pi-ai supports `toolChoice:{type:"tool",name}` on native providers, but `pi-anthropic-oauth`'s hand-built `streamSimple` never forwards `toolChoice`, and pi-ai has no json_schema/structured-output at all. So on subscription you cannot force a tool call or constrain JSON.

- **Mitigation:** any structured sub-call (memory query-expansion; any future `toolChoice` use) must use a forced-tool + TypeBox schema on API-key/OpenAI backends, but **degrade to prompt-for-JSON + parse + one retry on subscription**, failing soft (return `[]`). Audit Team/btw for `toolChoice` reliance.

## 4. Target architecture

```
VS Code Extension Host (Node, CJS bundle)                  Webview (UNCHANGED)
┌──────────────────────────────────────────────┐          ┌────────────────────┐
│ PiRuntime (SINGLE per process; B1 guard)      │          │ App.vue + stores    │
│  └─ pi loaded via dynamic import() (B2)        │◄─onMessage(ExtensionToWebview)│
│                                                │          └────────────────────┘
│ PiSession  (satisfies ClaudeSession seam)      │
│  ├─ PiRuntimeManager  → createAgentSessionRuntime (seeded agentDir+settings; B3)
│  ├─ PiStreamAdapter   (AssistantMessageEvent → ExtensionToWebviewMessage)
│  ├─ PiPermissionBridge(beforeToolCall/tool_call → canUseTool + modes)
│  ├─ PiInjectionExtension (memory/compass/plan/queued via pi hooks)
│  ├─ PiCheckpointManager (pi fork()/createBranchedSession)
│  ├─ PiBudgetMeter     (accumulate Usage.cost; abort on maxBudgetUsd)
│  └─ custom tools: Read/Glob/Grep/Edit/Write/Bash/PowerShell + memory/compass/browser/team
│                                                │
│ pi extension loader → loads user-installed (global scope) pi-anthropic-oauth
│   → registers Claude Pro/Max provider (re-register after every reload; B1)
└──────────────────────────────────────────────┘
```

Key mechanics, verified in source:

- **Embed entry:** `createAgentSessionRuntime`/`createAgentSession` (`pi/packages/coding-agent/src/core/sdk.ts`); default non-TUI ("print") mode; supply a no-op `ExtensionUIContext` shim so nothing terminal renders.
- **Streaming adapter:** translate pi's `AssistantMessageEvent` stream (`pi/packages/ai/src/types.ts:360-372`: `start/text_delta/thinking_delta/thinking_end/toolcall_*/done/error`) + `AgentSessionEvent`s into today's `ExtensionToWebviewMessage` shapes, so the webview processors/renderers survive unchanged. Refusals arrive as `done`/`error` with `stopReason` + `errorMessage` (no separate `'refusal'` reason) → synthesize the `RefusalStopDetails` shape the webview expects.
- **Mid-stream injection (upgrade):** Damocles' `queueInput` maps to pi's **native** `session.steer(text,images)` / `session.followUp(...)` (`agent-session.ts`, `streamingBehavior:"steer"|"followUp"`). Drop the old PostToolUse-hook queue hack.
- **Injection bus:** one pi extension object closing over Damocles services; map today's SDK hooks to pi hooks (`pi/packages/coding-agent/src/core/extensions/types.ts`): `before_agent_start`/`context` for memory + compass + plan-mode injection; `tool_call` (carries native `toolCallId`) for Explore/permission blocks.
- **Tools:** `createAgentSession({ customTools, excludeTools })`; Damocles supplies its own `ToolDefinition`s with Claude-Code names, `old_string/new_string`, and the `diff` details the webview expects; each tool's `execute` keeps diff-approval. Use `excludeTools` for pi's `bash/grep/find/ls` (Windows + replace with Damocles' own); control the active set with `setActiveTools(...)`.
- **Multimodal (works):** images flow via `prompt({images})` and tool `execute()` returning `{type:"image",...}`; ensure `blockImages=false` in seeded settings.
- **Abort (works):** `session.abort()` persists the partial aborted turn in pi state/JSONL; the OAuth `convert.ts` excludes aborted/errored turns from the next request automatically. Drop the SDK JSONL-marker cancelled-turn machinery (no analog).

## 5. Work breakdown

Disposition: **keep** (untouched), **re-wrap** (thin adapter), **rebuild** (new code), **drop**, **delete**. Effort S≤1d / M 2-4d / L 1-2wk / XL 3wk+.

| # | Item | pi support | Disposition | Effort | Risk | Tier |
| --- | --- | --- | --- | --- | --- | --- |
| B1 | Single pi runtime + provider re-registration after reload | — | rebuild (guard) | M | high | P0 |
| B2 | Packaging: pi as esbuild externals + node_modules + dynamic import; loader-resolve smoke test | — | rebuild | M | high | P0 |
| B3 | Disable pi auto-compaction; host-owned opt-in compaction + overflow handling | toggle exists | rebuild | M | med | P0 |
| 1 | Multi-provider model registry + Claude Pro/Max OAuth via user-installed pi-anthropic-oauth (global scope) | NATIVE loader | re-wrap (ship no provider code) | M | low | P0 |
| 2 | Built-in toolset: Read/Glob/Grep/Edit/Write/Bash + **PowerShell**, Claude-Code names + diff details; `excludeTools` pi's bash/grep/find/ls | PARTIAL | rebuild | L | high | P0 |
| 3 | Streaming → webview adapter (incl. refusal synthesis) | NATIVE events | rebuild | L | high | P0 |
| 4 | Permission system + modes (plan/default/acceptEdits/yolo) + diff approval; correlate by native `toolCallId` | PARTIAL (block primitive) | rebuild gate; **keep** Approval/Diff/Question/Plan managers | L | high | P0 |
| 5 | Hook/injection bus (memory + compass + plan marker + queued via steer/followUp) | NATIVE hooks | rebuild | L | med | P0 |
| 6 | Re-wrap in-process tools memory/compass/browser/team as pi `ToolDefinition`s | `registerTool` exists | re-wrap (cores **keep**) | M | low | P0 |
| 7 | System prompt + model(object) + thinking + context-usage; **audit system-prompt for OAuth sanitizer** | NATIVE | re-wrap | M | med | P0 |
| 8 | Host-side budget meter (accumulate `Usage.cost`; abort on maxBudgetUsd/taskBudget) | Usage.cost | rebuild | M | med | P0 |
| 9 | Seed damocles-owned `agentDir`/`SettingsManager` (compaction off, blockImages false, don't inherit ~/.pi) | NATIVE | rebuild (thin) | S | med | P0 |
| 10 | Session persistence on pi `SessionManager` | NATIVE (diff format) | rebuild | M | med | P0 |
| 11 | Structured query-expansion replacement (forced-tool on API key; prompt+parse on OAuth) | forced-tool only (not on OAuth) | rebuild | M | med | P1 |
| 12 | AI title generator (pi completion; replace SDK tagSession/getSessionInfo) | ABSENT | rebuild | S | low | P1 |
| 13 | Checkpoints / file-rewind / fork on pi `fork()`/`createBranchedSession` | PARTIAL | rebuild | L | high | P1 |
| 14 | MCP **client** (stdio first → HTTP/SSE) exposed as custom tools + status/reconnect | ABSENT | rebuild | XL | high | P1 |
| 15 | Commands / slash-commands | NATIVE | re-wrap | M | med | P1 |
| 16 | Skills (SKILL.md + `/skill:name`) | NATIVE | re-wrap | S | low | P1 |
| 17 | Plan mode (mode + before_agent_start mandatory instruction + Enter/ExitPlanMode tools) | ABSENT as mode | rebuild | M | med | P1 |
| 18 | Subagents / Task tool (nested in-process pi sessions) | ABSENT (example only) | rebuild | L | high | P1 |
| 19 | Explore-via-third-party-model (now a pi provider/model, no proxy) | NATIVE primitive | re-wrap (depends on #18) | M | med | P1 |
| 20 | AskUserQuestion / elicitation as a registered tool | PARTIAL | rebuild | M | med | P1 |
| 21 | Subscription enablement UX ("Enable Claude subscription" → install plugin global scope) | NATIVE package mgr | rebuild (thin) | S | low | P1 |
| 22 | VS Code workspace-trust → pi `setProjectTrusted` bridge (+ react to grant/revoke) | trust API | rebuild | S | med | P1 |
| 23 | Model-fallback notice (map pi `auto_retry_*`); optional real cross-model failover | NATIVE notice / ABSENT failover | re-wrap notice; optional failover | S/M | low/med | P1/P2 |
| 24 | **Team** (each agent = its own pi `AgentSession`; audit toolChoice reliance) | rework | rebuild | L | high | P2 |
| 25 | **btw** (ephemeral pi session sharing context) | rework | rebuild | M | med | P2 |
| 26 | Background tasks (host-owned task registry) | rework | rebuild | M | med | P2 |
| 27 | Drop `setBetas` on subscription (OAuth extension owns betas; inert) | — | drop/neutralize | S | low | P2 |
| — | **Recall**, **Workflow/Ultracode**, **Cron/Loop**, **remote-control** | rework | **drop** | — | — | — |
| — | memory core, compass core, browser core, voice | n/a | **keep** untouched | — | — | — |

## 6. What gets deleted

- `src/extension/openai-bridge/` (entire dir) — pi is natively multi-provider; the Anthropic-only translation workaround vanishes. Largest single simplification.
- `src/extension/explore/` proxy/env plumbing — `ExploreService` core stays; Explore now points at a pi provider/model directly (no loopback proxy).
- `src/extension/auth/sdk-env.ts` (`buildSdkEnv`, `CLAUDE_CONFIG_DIR` pinning, `~/.claude` mirroring, Linux token injection), `auth/native-binary-resolver.ts`, `auth/config-dir-bootstrap.ts` — no SDK subprocess/CLI binary. Subscription auth lives in the user-installed plugin; other providers via pi provider configs.
- `src/extension/claude-session/query-warmup.ts` — SDK startup/warmup machinery; in-process pi has no cold subprocess.
- `tool-manager.ts` FIFO name-correlation — replaced by pi's native `toolCallId`.
- `session/sdk-operations.ts` and SDK-JSONL-specific readers — replaced by pi `SessionManager`.
- Recall/Workflow/Cron/remote-control modules and their seam methods (see §9).
- All `@anthropic-ai/claude-agent-sdk` imports (`shared/sdk-loader.ts`, `query-manager.ts`, `hook-handlers.ts`, `streaming-manager/processors/*`, `permission-handler/*`, each `mcp-server.ts`).

## 7. Functional requirements

- FR-1: The webview message contract (`ExtensionToWebviewMessage`) MUST NOT change; only the producer changes.
- FR-2: The marketplace build MUST contain no Anthropic OAuth flow or Claude-Code request-shaping code (CI grep gate over `dist/` + `node_modules` minus the optionally-installed plugin).
- FR-3: Subscription billing MUST use the `sk-ant-oat` Bearer path only; a real `ANTHROPIC_API_KEY` MUST NOT silently take precedence. Surface the active auth mode in the UI.
- FR-4: Exactly **one** pi runtime per extension-host process; provider registrations MUST be re-applied after any `reload()` (B1).
- FR-5: pi auto-compaction MUST be disabled at startup; compaction occurs only when `damocles.autoCompact` is on, driven host-side; context-overflow MUST be handled host-side (B3).
- FR-6: Built-in tool names MUST match `shared/tool-names.ts` exactly; pi's `bash/grep/find/ls` MUST be excluded; tool approval MUST correlate by pi `toolCallId`.
- FR-7: Memory + compass injection MUST occur pre-LLM each turn via pi hooks; queued user messages MUST inject via native `steer`/`followUp`.
- FR-8: Structured sub-calls MUST degrade to prompt+parse on the subscription path and never hard-fail (B4).
- FR-9: pi MUST read a Damocles-owned `agentDir`/settings (not the user's `~/.pi` CLI config); `blockImages=false`.
- FR-10: VS Code workspace trust MUST gate pi project-scoped resources (`setProjectTrusted`); the OAuth plugin installs at global scope to avoid the conflict.
- FR-11: Dropped subsystems (Recall, Workflow, Cron/Loop, remote-control) MUST be removed cleanly (no dead UI, settings, or seam methods).
- FR-12: Env overrides MUST flow through pi/session config, never `process.env`.
- FR-13: No OutputChannel/log MUST ever emit the `sk-ant-oat` token, Bearer headers, or full request/response bodies (carry over the OpenAI-bridge logging-hygiene rule); a test asserts the token never appears in logs.
- FR-14: Rate-limit and usage-limit conditions (subscription 5-hour windows, 429s) MUST map to the existing rate-limit UX; the streaming adapter translates pi `error` stop reasons carrying limit info into today's rate-limit message.

## 8. Non-goals

- No Claude Code plugin-ecosystem compatibility (skills shared with the CLI not required).
- No Recall, Workflow/Ultracode, Cron/Loop, or remote-control on pi.
- No shipping any Anthropic-subscription provider code in the marketplace extension.
- No webview redesign; no `pi-tui` usage.
- No forking `pi-anthropic-oauth` (rely on the published package).

## 9. Seam scoping (`ClaudeSession` → `PiSession`)

**Removed / no-ops (dropped subsystems):** `getRecallService`, `getRecallTrajectory`, `recallService`, `isRecallMode`, `setRecallSession`, `refreshRecallConfig`, `planPath` get/set; `getLoopJobs`, `cancelLoopJob` (+ `LoopJobTracker`); workflow wiring; `enableRemoteControl`/`disableRemoteControl`/`remoteControlStatus` (+ `RemoteControlManager`).

**Reimplemented on pi (do NOT undersell — these grow):**

- `sendMessage`/`queueInput` → `session.prompt(text,{images})` + native `steer`/`followUp` mid-stream.
- `cancel`/`interrupt`/`reset`/`stopTask` → `session.abort()` (`stopTask` likely drops unless Team needs it).
- `setModel`/`getSupportedModels`/`getModelInfo` → `session.setModel(Model)` — **pi takes a `Model` object, not a string id**; add a model-id→`Model` resolver via `modelRegistry.find()`.
- `setPermissionMode` → no pi equivalent; implement via tool gating / `beforeToolCall` hook.
- `setMcpServers`/`getMcpServerStatus`/`reconnectMcpServerLive`/`restartForMcpChanges` → re-bridge MCP as custom tools/extension (significant; #14).
- `setPlugins`/`reloadPlugins`/`restartForPluginChanges` → pi "extensions" replace SDK "plugins"; remap to extension discovery/reload (mind B1's reload hazard).
- `requestContextUsage` → `session.getContextUsage()` (keep the trust-boundary override).
- `disableThinkingForNextQuery`/`restoreThinkingConfig`/`setFastMode` → `session.setThinkingLevel` ("off" = disabled).
- `getAccumulatedCost` → host-side budget meter (#8); checkpoints/`rewindFiles` → pi `fork()`/`createBranchedSession` (#13).
- `setBetas` → inert on subscription (OAuth extension owns betas); drop or document.
- `sendBtw`/`cancelBtw`, `emitExploreHistory`, browser/chrome wiring, `teamService` → keep, re-route through pi.

## 10. Phased user stories (each shippable behind a feature flag; webview unchanged)

### Phase 0 — Foundation spike (de-risk the blockers)

**US-001: Prove embed + packaging + subscription + streaming**

- [ ] pi added as esbuild externals + node_modules; loaded via dynamic `import()`; activation smoke test asserts the loader's `getAliases()`/`import.meta.resolve` resolves all four pi subpaths incl. `@earendil-works/pi-ai/oauth` (B2).
- [ ] A single `createAgentSessionRuntime` runs in the host (singleton guard; B1); one `prompt()` streams text+thinking deltas to the OutputChannel; no `pi-tui` output (no-op UI shim).
- [ ] A locally-installed `pi-anthropic-oauth` (global scope) loads; a request bills against subscription (`sk-ant-oat` Bearer, no `x-api-key`).
- [ ] `setAutoCompactionEnabled(false)` verified; a long context does NOT auto-compact (B3).
- [ ] Typecheck/lint pass.

### Phase 1 — Vertical slice behind the seam

**US-002: PiSession + streaming→webview adapter (read-only chat)** — minimal `PiSession` (`sendMessage`/`cancel`/`interrupt`/`dispose`/`setModel`/`onMessage`), feature-flagged; `PiStreamAdapter` maps deltas/usage/refusal → existing messages; golden-master vs current SDK for fixed prompts; read-only tools; **verify in webview**. **US-021: Subscription enablement UX** — "Enable Claude subscription" installs `pi-anthropic-oauth` global scope via the package manager + reloads; re-registers provider after reload (B1); CI grep gate asserts no provider code in the marketplace bundle (FR-2); graceful notice when absent. **US-009: Seed damocles-owned agentDir/SettingsManager** — own dir, `compaction.enabled=false`, `blockImages=false`; don't inherit `~/.pi`.

### Phase 2 — Tools + permissions (make-or-break)

**US-003: Built-in toolset (Claude-Code names + PowerShell)** — `Read/Glob/Grep/Edit/Write/Bash/PowerShell` as pi `ToolDefinition`s with exact `shared/tool-names.ts` names, `old_string/new_string`, `diff` details; `excludeTools:["bash","grep","find","ls"]`; conformance test asserts every expected name resolves; PowerShell is first-class (Windows); if bash kept, require Git Bash + set `shellPath`. **US-004: Permission bridge + modes + diff approval** — `tool_call`/`beforeToolCall` → `permissionHandler.canUseTool`; correlation via native `toolCallId` (FIFO deleted); modes plan/default/acceptEdits/yolo reproduced; reuse `ApprovalManager`/`DiffManager`/`QuestionManager`/`PlanManager`; **verify Edit round-trip in webview**.

### Phase 3 — Injection bus, tools, prompt, budget

**US-005: Hook/injection bus** — memory + compass status + plan-mode mandatory instruction via `before_agent_start`/`context`; queued messages via `steer`/`followUp`; verify injection pre-LLM in webview. **US-006: Re-wrap in-process tools** — memory/compass/browser/team `createSdkMcpServer` servers → pi `defineTool` (Zod→TypeBox); cores untouched. **US-007: System prompt + model object + thinking; sanitizer audit** — feed `buildSystemPrompt` as pi system prompt; model-id→`Model` resolver; **audit `system-prompt.ts` for bare `pi`/`Pi` tokens + pi anchors the OAuth sanitizer rewrites/deletes**; document the subscription "You are Claude Code" prepend + identity divergence vs API-key. **US-008: Host-side budget meter** — accumulate `Usage.cost.total` on `message_end`; abort on `maxBudgetUsd`/`taskBudget`; present as "estimated usage" on subscription; rewire `getAccumulatedCost()`.

### Phase 4 — Sessions, titles, checkpoints, plan, subagents

**US-010: Session persistence on pi** — adopt pi `SessionManager` JSONL; rewrite session readers. **US-012: AI title generator** — one-shot pi completion (small fast model) after first turn → `session.setSessionName`; store title in Damocles' own index. **US-013: Checkpoints / file-rewind / fork** — rewrite `CheckpointManager` on pi `fork()`/`createBranchedSession` + a host file-snapshot store; **verify rewind in webview**. **US-017: Plan mode** — mode + `before_agent_start` mandatory instruction + Enter/ExitPlanMode tools + `PlanManager`. **US-018: Subagents/Task + US-019 Explore** — `Task`/`Agent` tool spawning nested in-process pi sessions; Explore runs the configured third-party pi model (no proxy).

### Phase 5 — MCP, commands/skills, structured, elicitation, trust

**US-014: MCP client** — stdio + HTTP + SSE all in v1 (user decision), expose external tools via `registerTool`, surface status/reconnect. Use `@modelcontextprotocol/sdk` for all three transports; build behind a clean module boundary and test each transport against a reference server. **US-015/US-016: Commands + skills** — map `SlashCommandService`/`getSupportedCommands` to pi commands; point skill discovery at Damocles' skills dir. **US-011: Structured query-expansion replacement** — forced-tool + TypeBox on API-key/OpenAI; prompt+parse+retry, fail-soft on subscription (B4); change `memory/query-expansion.ts`. **US-020: AskUserQuestion/elicitation** — registered tool routed through `QuestionManager`. **US-022: Workspace-trust bridge** — `settingsManager.setProjectTrusted(workspace.isTrusted)` + react to grant/revoke; keep the OAuth plugin global-scope. **US-023: Refusal + model-fallback notice** — synthesize `RefusalStopDetails`; map pi `auto_retry_*` → notice; optional cross-model failover `streamFn` wrapper (P2).

### Phase 6 — Kept subsystems + cleanup

**US-024: Team on pi** — each agent = its own pi `AgentSession`; MessageBus/Scratchpad retained; team tool re-wrapped; audit `toolChoice` reliance (B4). **US-025: btw on pi** — ephemeral pi session sharing context (maxTurns≈1, no persistence). **US-026: Background tasks** — host-owned task registry for `run_in_background` bash/agents (P2). **US-027: Delete dead SDK plumbing** — remove openai-bridge, sdk-env/native-binary-resolver/config-dir-bootstrap, query-warmup, FIFO correlation, session/sdk-operations, Recall/Workflow/Cron/remote-control, all SDK imports; build green.

## 11. Technical considerations & defaults

- **Single runtime (B1):** module-level singleton; guard against concurrent runtimes; re-register providers after `reload()`; avoid frequent `reload()` (jiti `moduleCache:false` re-transpiles each time).
- **Packaging (B2):** externals + node_modules + dynamic import; install the published `@earendil-works/pi-coding-agent` with real deps; activation smoke test for loader resolution.
- **Compaction (B3):** disable pi auto-compaction; host-side opt-in via `damocles.autoCompact`; host-side overflow handling.
- **Session format:** adopt pi's JSONL (`uuidv7`, versioned entries); rewrite checkpoint/title/readers; do not preserve the SDK flat format. Existing SDK-format sessions are not loaded by pi — see Q7 (default: archive old sessions read-only / export-to-markdown, start fresh on pi).
- **Concurrency:** Damocles may run several `AgentSession`s at once (Team agents, btw, subagents); all share the one `PiRuntime`/provider registry (B1). The feature flag keeps the old `ClaudeSession` path until `PiSession` reaches parity; switch via a setting, then delete the SDK path in US-027.
- **Auth:** rely on pi `AuthStorage` + the plugin for subscription; other providers via pi provider configs. Install plugin at **global scope** (avoids workspace-trust conflict). The plugin creates a `~/.Claude Code → ~/.pi` symlink on load (Windows needs Developer Mode; failure is caught) — document it.
- **Windows shell:** `excludeTools` pi's `bash/grep/find/ls`; ship a first-class PowerShell tool; keep Damocles' ripgrep/compass for search.
- **MCP scope:** stdio + HTTP + SSE all in v1 (user decision) via `@modelcontextprotocol/sdk`; isolate in one module; per-transport reference-server tests. Note: this raises US-014 above the typical XL — sequence it so core parity (Phases 0-4) is not blocked by it.
- **Cross-model failover:** notice-only first; optional `streamFn` wrapper retrying a fallback `Model` (P2) — high value given native multi-provider.
- **pi-tui:** supply a no-op/webview `ExtensionUIContext`; never import `InteractiveMode`/`pi-tui` components.
- **Reuse, don't rebuild:** `permission-handler/` managers, `DiffManager`, `QuestionManager`, `PlanManager`, memory/compass/browser/team cores, voice — keep.

### Critical files

- Seam: `src/extension/claude-session/index.ts` (+ `types.ts`); injection bus: `claude-session/hook-handlers.ts`; streaming shapes: `claude-session/streaming-manager/processors/*`; permissions: `permission-handler/index.ts` + `tool-manager.ts`; build: `esbuild.config.mjs`; structured sub-call: `memory/query-expansion.ts`; titles: `session/sdk-operations.ts`; system prompt: `claude-session/system-prompt.ts`.
- Delete targets: `openai-bridge/`, `auth/sdk-env.ts`, `auth/native-binary-resolver.ts`, `claude-session/query-warmup.ts`, `shared/sdk-loader.ts`.
- pi embed: `pi/packages/coding-agent/src/core/sdk.ts`, `agent-session.ts`, `agent-session-runtime.ts`, `extensions/{types,loader}.ts`, `package-manager.ts`, `settings-manager.ts`, `config.ts`, `tools/shell.ts`.
- pi streaming/types: `pi/packages/ai/src/types.ts`; providers/registry: `ai/src/.../api-registry.ts`, `providers/anthropic.ts`.
- OAuth reference (do NOT ship): `pi-anthropic-oauth/src/{index,auth,stream,prompt,convert}.ts`.

## 12. Execution strategy

**Agent assignment**

- **Software Architect / Backend Architect** — B1/B2/B3, US-001/002/003/007/008/010/012/013 (runtime, packaging, seam, streaming, tools, sessions/titles/checkpoints).
- **Security Engineer** — US-004 (permission bridge + modes), US-021/US-022 + FR-2/FR-3/FR-10 (ToS separation, subscription billing guard, trust bridge, CI grep gate).
- **Backend Architect** — US-005/006/011 (injection bus, tool re-wrap, structured replacement), US-017/018/019 (plan/subagents/Explore), US-014 (MCP), US-024/025 (Team/btw).
- **Frontend Developer** — only if an `ExtensionToWebviewMessage` shape must change (goal: none); validates webview parity for US-002/004/005/013.
- **Code Reviewer** — gate each phase; verify no SDK imports after US-027.

**Sequencing**

- Step 1 (sequential): US-001 (foundation spike: B1+B2+B3 proven).
- Step 2 (sequential): US-002 + US-021 + US-009.
- Step 3 (sequential): US-003 → US-004 (tools before gate).
- Step 4 (parallel): US-005, US-006, US-007, US-008 (no shared files).
- Step 5 (sequential): US-010 → US-012 → US-013 → US-017 → US-018/019.
- Step 6 (parallel): US-014, US-015/016, US-011, US-020, US-022, US-023.
- Step 7 (parallel): US-024, US-025, US-026.
- Step 8 (sequential): US-027 cleanup; final Code Reviewer pass.

**Context handoff (per dispatch)**

- Requirements: the owning US + acceptance criteria; the relevant blocker (B1-B4) it must respect.
- Files: the critical-files list, scoped to the story.
- Contracts: `ClaudeSession` public method signatures (seam, §9), `ExtensionToWebviewMessage` shapes, pi `AssistantMessageEvent`/`ExtensionAPI`/`ToolDefinition`/`Model`/`Usage` types.
- Patterns: keep diff-approval in each tool's `execute`; map SDK hooks → pi hooks (§4); single runtime + re-register on reload; never `process.env`.
- Constraints: don't change the webview; don't ship provider code; don't import `pi-tui`; don't inline pi into the bundle; don't let pi auto-compact.

## 13. Verification

- **Unit/conformance:** loader-resolution smoke test (B2); single-runtime guard test (B1); auto-compaction-off test (B3); tool-name conformance (every `shared/tool-names.ts` entry resolves); adapter golden-master (translated stream == current SDK output for fixed prompts); permission-correlation test (parallel Edits map to correct diffs via `toolCallId`); structured-fallback test (query-expansion returns `[]` on OAuth without crashing).
- **CI compliance gate:** grep asserts no Anthropic OAuth/Claude-Code-shaping strings in the marketplace bundle (FR-2); a test asserts the OAuth `sk-ant-oat` path is used when present and an API key never overrides it (FR-3).
- **Manual (F5 Extension Development Host):** stream a turn; approve/deny an Edit diff; trigger memory/compass injection; steer a mid-stream message; rewind a checkpoint; run a subagent; connect a stdio MCP server; enable subscription and confirm a subscription-billed turn (no `x-api-key`); generate an AI title; run a 2-agent Team; `/btw`; confirm long context does not auto-compact unless `damocles.autoCompact` is on.
- **Build:** `npm run typecheck`, `npm run lint`, `npm test`, then `npm run package`; confirm pi resolves from the packaged `node_modules` and no `@anthropic-ai/claude-agent-sdk` references remain after US-027.

## 14. Resolved decisions & remaining defaults

**Resolved (user-confirmed):**

- D1 — Session format: adopt **pi's** JSONL. Existing SDK-format history is **archived read-only / export-to-markdown; start fresh on pi** (no fragile two-way converter).
- D2 — MCP: ship **stdio + HTTP + SSE all in v1** via `@modelcontextprotocol/sdk` (US-014); keep it off the critical path for core parity.
- D3 — Background tasks: **keep** (US-026, P2) on a host-owned task registry.
- D4 — Subscription resilience: if the third-party plugin lags an Anthropic auth change, **accept downtime + document**; users fall back to API key / other providers. Maximum ToS distance.

**Remaining low-stakes defaults (override anytime; reversible):**

- D5 — Cross-model failover: **defer to P2** (notice-only first; optional `streamFn` fallback-model wrapper later).
- D6 — Windows shell: **exclude pi's `bash`; ship a first-class PowerShell tool**; keep Damocles' ripgrep/compass for search.
