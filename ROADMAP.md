# ROADMAP: Rebuild Damocles' Agent Harness on pi (full Claude Agent SDK replacement)

> Self-contained plan. No prior context required to execute it. Every claim below was verified against pi source at `C:\GameDev\pi` (commit-local), pi docs (`packages/coding-agent/docs/`), and the third-party `C:\GameDev\pi-anthropic-oauth`.

## 1. Context & goal

**Damocles** is a VS Code extension (Vue 3 + Pinia webview; Node extension host, CJS esbuild bundle) currently built on Anthropic's **official Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk`). A single facade, `ClaudeSession` (`src/extension/claude-session/index.ts`), wraps the SDK `query()` call; ~15 streaming processors decode the SDK wire format into `ExtensionToWebviewMessage`s the webview renders. On top sit: a permission handler (diff approval + modes), in-process MCP tool servers (memory, compass, browser, team), subagents, an OpenAI bridge (in-process Anthropic↔Codex/OpenAI translator behind a loopback proxy), an explore proxy (third-party model for the `Explore` subagent), Damocles-owned OAuth, recall, voice, workflow.

**Goal:** replace the Claude Agent SDK with **pi** — owning the agent loop, gaining native multi-provider support, **and turning pi's extension system into a user-facing extensibility platform** — reducing lock-in to Anthropic's SDK cadence and ToS. The webview message contract must not change (only its producer does).

**pi** (`C:\GameDev\pi`, MIT) — the "Pi Agent Harness" monorepo. Layers used:

- `@earendil-works/pi-ai` — multi-provider LLM API (Anthropic/OpenAI/Google/…): providers, streaming events (`AssistantMessageEvent`), model registry, `Usage`/cost, OAuth primitives. **No json_schema/constrained-output** (see B4 for the idiomatic substitute).
- `@earendil-works/pi-agent-core` — provider-agnostic agent runtime: tool-calling loop, hooks, JSONL session stores, compaction.
- `@earendil-works/pi-coding-agent` — the embed target: `createAgentSession`/`createAgentSessionRuntime`, built-in tools (+ exported tool factories), the **extension system** (loader + `ExtensionAPI`, ~30 hooks), `AuthStorage`, `ModelRegistry`, `SessionManager`, `SettingsManager`, `DefaultPackageManager`. ESM-only, **Node ≥ 22.19**.
- `@earendil-works/pi-tui` — terminal UI; never import it.

**pi-anthropic-oauth** (`C:\GameDev\pi-anthropic-oauth`) — third-party pi extension adding Claude Pro/Max **subscription** OAuth. The stored token is an `sk-ant-oat…` OAuth token sent as a **Bearer** token (not `x-api-key`), with `anthropic-beta: oauth-2025-04-20,claude-code-20250219,interleaved-thinking-2025-05-14`, `user-agent: claude-code/…`, `x-app: cli`. It **prepends** `"You are Claude Code, Anthropic's official CLI for Claude."` to the system prompt and **sanitizes** the rest (see FR-17). Bills against the **subscription quota**. README warns it "may go against Anthropic's terms."

**Authoritative pi docs — read before implementing the matching story:** `docs/sdk.md` (embed recipe + exports), `docs/rpc.md` (full command/event/Extension-UI surface), `docs/extensions.md` (ExtensionAPI + hooks), `docs/packages.md` (package manager / marketplace), `docs/session-format.md`, `docs/json.md` (structured output), `docs/providers.md`, `docs/custom-provider.md`, `docs/windows.md`.

**pi ships ~70 example extensions** (`packages/coding-agent/examples/extensions/`). Direct reference implementations exist for: `permission-gate.ts`, `plan-mode/` (read-only mode, 340 LOC), `subagent/` (agent-def discovery + parallel/chain, 1009 LOC), `structured-output.ts`, `git-checkpoint.ts`, `question.ts`/`questionnaire.ts`, `project-trust.ts`, `session-name.ts`, `reload-runtime.ts`, `custom-provider-anthropic/`, `dynamic-tools.ts`, `input-transform*.ts`, `event-bus.ts`. **No MCP-client example exists** — US-014 builds it.

## 2. Decisions (locked)

- **Strategy:** full replacement of the Claude Agent SDK with pi (not hybrid/cherry-pick).
- **Embed:** in-process via the pi coding-agent SDK, using `createAgentSessionRuntime` + `createAgentSessionServices` + `createAgentSessionFromServices` (the runtime layer that owns session replacement: new/resume/fork/clone/import). Build the chat UI directly on `session.subscribe(...)` — **never** `runPrintMode`/`runRpcMode`/`InteractiveMode`/`pi-tui`. Damocles' entire integration is **one in-process pi extension factory** (closing over Damocles services), passed via `DefaultResourceLoader({ extensionFactories, systemPromptOverride, eventBus })`, behind the existing `ClaudeSession` public interface (implemented as `PiSession`). pi owns providers/auth/OAuth/model-registry/sessions/package-manager/extension-loader; Damocles owns behavior (added tools, system prompt, hook/injection bus, permission gating, streaming-to-webview, and a webview-bridged `ExtensionUIContext`).
- **Tools:** **use pi's native tools** (`read`/`bash`/`edit`/`write`/`grep`/`find`/`ls` + native skills) — do **not** rebuild Claude-Code clones. Because pi's tool parameter/result schemas differ from Claude Code's (see §5), the streaming adapter owns a **per-tool normalization layer** that maps pi tool name + input + result `details` → the exact `ExtensionToWebviewMessage` tool shapes the webview already renders, so the webview stays unchanged (FR-1). **Add** only the CC tools pi lacks, with CC-identical parameter schemas: WebSearch, WebFetch, AskUserQuestion, EnterPlanMode/ExitPlanMode, StructuredOutput, Agent/Task (subagents), PowerShell (alongside pi `bash`), TodoWrite/TodoRead, plus the re-wrapped memory/compass/browser/Team tools.
- **Extensibility (headline):** expose pi's extension system to **end users** as a **trust-gated marketplace** — install/enable/disable/update any pi extension from npm/git/local via `DefaultPackageManager`, surfaced in a webview "pi Extensions" panel. The `pi-anthropic-oauth` subscription plugin is one entry. Gated by VS Code workspace trust + explicit opt-in + a security warning before first enable (extensions run arbitrary in-process code with session/auth scope).
- **Subscription delivery (ToS-safe):** the marketplace build ships **no** provider/OAuth/Claude-Code-shaping code (CI grep gate, FR-2). Enabling Claude subscription installs the third-party `pi-anthropic-oauth` into pi's global extensions dir; pi's loader registers the provider into Damocles' runtime. The ToS-sensitive code lives only in a package Damocles neither authors nor ships (OpenCode-style stance — informed, accepted gray area).
- **OpenAI:** pi-native, **both** API-key and Codex/ChatGPT OAuth (pi has both built in; `OpenAIAuthPanel.vue` already drives both). Delete the openai-bridge in the US-002 cutover.
- **Scope — keep:** memory, compass, browser, voice (cores are SDK-agnostic), **Team**, **btw**.
- **Scope — drop (no pi reimplementation; clean up code, settings, webview, handlers, seam, tool-names):** **Recall**, **Workflow/Ultracode**, **Cron/Loop jobs**, **remote-control**, **background tasks + Monitor** (the `TaskCreate/Update/List/Get/Stop/Output` tools), **git-worktree tools** (`EnterWorktree`/`ExitWorktree`), **ToolSearch**, **NotebookEdit**, **LSP**.

## 3. Architecture & component lifecycle

```
VS Code Extension Host (Node 22, CJS bundle)                      Webview (UNCHANGED)
┌──────────────────────────────────────────────────────┐         ┌────────────────────┐
│ PiRuntime  — PROCESS singleton (B1) [DONE]             │         │ App.vue + Pinia     │
│  • pi loaded via dynamic import() (B2) [DONE]          │◄─onMessage(ExtensionToWebview)│
│  • owns provider/OAuth registry; re-register on reload │         └────────────────────┘
│  • DefaultPackageManager → extension marketplace        │
│                                                         │
│ PiSession  — one per chat panel (satisfies ClaudeSession seam)
│  • AgentSessionRuntime: new/resume/fork/clone/import   │
│    (re-subscribe + re-bindExtensions after replacement)│
│  • AgentSession(s): 1 primary + N nested (Team/subagents), all share PiRuntime
│  • PiStreamAdapter: AgentSessionEvent → ExtensionToWebview (+ per-tool normalization)
│  • DamoclesIntegration = ONE pi extension factory:
│      - tool_call    → CENTRAL permission gate (canUseTool + modes); ALL tools
│      - before_agent_start / context → memory + compass + plan-mode injection
│      - input        → queued-msg / slash interception (optional)
│      - tool_result  → diff/patch → webview shape
│      - message_end/turn_end → cost + checkpoints
│      - registerTool → added CC tools + re-wrapped memory/compass/browser/Team
│  • Webview-bridged ExtensionUIContext (hasUI:true):
│      ctx.ui.select/confirm/input/editor/notify → webview (Question/Approval/notice)
│  • PiBudgetMeter, PiCheckpointManager (session tree fork/branch/labels + file snapshot)
│                                                         │
│ pi extension loader → user-installed (global + project scope) marketplace extensions
│   incl. pi-anthropic-oauth → Claude Pro/Max provider (re-register after reload; B1)
└──────────────────────────────────────────────────────┘
```

**Lifecycle invariant:** `PiRuntime` is a process-global singleton (one provider/OAuth registry for the whole host). `PiSession` is per chat panel and satisfies the `ClaudeSession` seam. Each `PiSession` owns one primary `AgentSession` plus zero-or-more nested `AgentSession`s (Team agents, subagents, btw) — all sharing the one `PiRuntime`/registry. After any `runtime.newSession()/switchSession()/fork()/importFromJsonl()`, `runtime.session` is a NEW instance: **re-subscribe and re-call `session.bindExtensions(...)`** (verified `docs/sdk.md` "session replacement").

**Streaming adapter (verified `packages/ai/src/types.ts`, `docs/rpc.md`):** translate `AgentSessionEvent` (= `AgentEvent` ∪ `queue_update` / `compaction_start` / `compaction_end` / `auto_retry_start` / `auto_retry_end` / `session_info_changed` / `thinking_level_changed`) into existing `ExtensionToWebviewMessage` shapes. `message_update.assistantMessageEvent` carries `start` / `text_start|delta|end` / `thinking_start|delta|end` / `toolcall_start|delta|end` / `done` / `error`. Tool UI correlates by native `toolCallId` (FIFO name-correlation deleted). `tool_execution_update.partialResult` is the **accumulated** (not delta) tool output — render by replacement.

**Images:** pi `ImageContent` is `{ type: "image", data: <base64>, mimeType: "image/png" }` (verified `packages/ai/src/types.ts:251`; the `docs/sdk.md` `source:{...}` example is wrong). The adapter converts between Damocles' current Anthropic-style image shape and pi's. `blockImages=false` in seeded settings.

**Mid-stream injection:** map `queueInput` to `session.steer(text,images)` / `session.followUp(...)` (or `prompt(text,{streamingBehavior:"steer"|"followUp"})`). Drop the PostToolUse-hook queue hack.

**Permission gate (central):** gate via the `tool_call` extension event (`event.input` is mutable; return `{block, reason}`) — pattern from `examples/extensions/permission-gate.ts`. One uniform gate covers pi-native tools, added tools, MCP tools, AND user-installed extension tools. A small map (pi tool name → CC permission category: read-only / write / shell) drives the mode matrix. Tool `execute()` only produces diff/patch details, never approval.

**Abort:** `session.abort()` persists the partial turn; the next request excludes aborted turns automatically (no JSONL cancelled-turn marker needed).

## 4. Critical blockers (define the architecture)

**B1 — pi's provider registry is a process-global singleton; `reload()` wipes the OAuth provider.** `registerApiProvider`/`registerOAuthProvider` (`pi/packages/ai/src/api-registry.ts`, `ai/src/utils/oauth/index.ts`) write module-level singletons. After `reload()`/`resetApiProviders()`, only built-ins re-register — silently dropping the OAuth provider. One Node process hosts all VS Code extensions / multiple Damocles windows.

- **Mitigation [DONE, must stay hardened]:** the registry is owned once by the single module-level `PiRuntime`. Multiple concurrent `AgentSession`s share it; only provider (re)registration is serialized + single-owned. After **any** `reload()` — including every marketplace install/remove/update — re-run provider registration and assert `pendingProviderRegistrations` re-flushed. Use the stale-instance guard from `reload-runtime.ts` (`invalidate()`/`assertActive()` + `withSession` callback). The marketplace raises reload frequency, so this is the single highest-risk item.

**B2 — pi cannot be esbuild-bundled into `dist/extension.js`** (pure ESM, `import.meta`/`import.meta.resolve`; the extension is a CJS esbuild bundle).

- **Mitigation [DONE]:** pi packages in esbuild `external` + shipped as real `node_modules`; import only via dynamic `import()` behind an async seam. Externals: `@earendil-works/pi-coding-agent`, `@earendil-works/pi-agent-core`, `@earendil-works/pi-ai`, `@earendil-works/pi-tui`, `jiti`, `typebox`, `@anthropic-ai/sdk`. Activation smoke test asserts the loader's `getAliases()`/`import.meta.resolve` resolves all four pi subpaths incl. `@earendil-works/pi-ai/oauth`.

**B3 — pi auto-compaction defaults ON and runs inside the loop** (`getCompactionEnabled() ?? true`; force-compact on overflow). Damocles rule: compaction is opt-in via `damocles.autoCompact` for ALL backends, never forced.

- **Mitigation [DONE]:** seed `SettingsManager` with `compaction.enabled=false` + call `session.setAutoCompactionEnabled(false)` unconditionally. Gate compaction behind `damocles.autoCompact`, driving `session.compact()` host-side. Disabling also disables overflow auto-recovery → handle context-overflow host-side (watch `compaction_start`/`compaction_end`/`auto_retry_*`; surface to user / offer manual compact).

**B4 — no forced-tool / json_schema constrained output.** pi-ai has no json_schema decoding; on the subscription (OAuth) path `pi-anthropic-oauth`'s `streamSimple` never forwards `toolChoice` — you cannot force a tool call or constrain JSON.

- **Mitigation (idiomatic, all-provider):** pi's structured-output pattern is a normal **terminating tool** — `defineTool` with a TypeBox `parameters` schema + `terminate: true` + `promptGuidelines` nudging the model to call it as its final action (verified `examples/extensions/structured-output.ts`, `docs/json.md`). It is an ordinary tool call (not forced `toolChoice`), so it works on every provider including OAuth; TypeBox validates the args; `terminate:true` avoids an extra LLM round-trip. Structured sub-calls (memory query-expansion, US-011) register such a tool in a one-shot ephemeral session and **fail soft** (parse-from-text fallback → `[]`). Audit Team/btw for any `toolChoice` reliance.

## 5. Tool inventory & mapping (authoritative)

Damocles uses pi-native tools as-is; the **adapter normalizes input + result `details` to the existing webview shapes** (no webview change). Native tool schemas verified in `pi/packages/coding-agent/src/core/tools/`.

| Damocles display name | Disposition | pi tool | Param/result translation the adapter MUST do |
| --- | --- | --- | --- |
| Read | use-native | `read` (`path`, offset, limit; `ReadToolDetails`) | rename `file_path`↔`path` |
| Write | use-native | `write` (`path`, content) | rename `file_path`↔`path` |
| Edit | use-native | `edit` (`path`, `edits:[{oldText,newText}]`; `EditToolDetails{diff,patch,firstChangedLine}`) | **shape map**: present pi's batched-edit schema; render the webview diff from `details.diff`/`patch`. (CC's single `old_string`/`new_string` ⊂ pi's `edits[]`.) |
| Bash | use-native | `bash` (`command`, timeout; `BashToolDetails`) | drop CC's `run_in_background` (background tasks are dropped) + `description`; map output via `tool_execution_update.partialResult` |
| Grep | use-native | `grep` (`pattern`, path, glob, ignoreCase, literal, context, limit) | map `-i`↔`ignoreCase`; CC's `output_mode`/`multiline`/`-n`/`-o` have no pi equivalent — accept the capability delta (D12) |
| Glob | map→`find` | `find` (`pattern`, path, limit) | direct (`pattern`/`path` align) |
| (Ls) | available | `ls` (`path`, limit) | optional; no CC equivalent |
| Skill | use-native | native skills (`/skill:name`) | point discovery at Damocles' skills dir (US-016) |
| PowerShell | **add** | — | new `defineTool` (Windows-native shell); pi `bash` uses Git Bash via `shellPath` |
| WebSearch / WebFetch | **add** | — | new `defineTool`s (pi lacks both) |
| AskUserQuestion | **add** (CC schema) | adapt `question`/`questionnaire` | `defineTool` with CC's exact schema (questions[], header, options[+preview], multiSelect, annotations) → `QuestionManager` via the webview ExtensionUIContext |
| EnterPlanMode / ExitPlanMode | **add** | adapt `plan-mode/` | `defineTool`s driving `PlanManager` + `setActiveTools(readOnly)` (US-017) |
| StructuredOutput | **add** | adapt `structured-output.ts` | terminating tool with CC's schema |
| Agent / Task | **add** | adapt `subagent/` | nested in-process `AgentSession`s (US-018) |
| TodoWrite / TodoRead | **add** | adapt `todo.ts` | `defineTool`s with CC schema |
| memory / compass / browser / Team tools | re-wrap | `registerTool` | Zod→TypeBox; cores untouched (US-006/024) |
| CronCreate/Delete/List, Workflow, Task\*/Monitor, EnterWorktree/ExitWorktree, ToolSearch, NotebookEdit, LSP | **drop** | — | remove tool, name, permission rule, renderer, handler |

**Active-tool set:** pi enables built-ins via the `tools` allowlist; if `tools` is passed, every custom/extension tool name MUST be included. After a marketplace install/remove (US-021), refresh the active set (`setActiveTools`) so newly registered extension tools become callable. Default built-ins are `read/bash/edit/write`; `grep/find/ls` must be added to the allowlist explicitly.

## 6. What gets deleted

- `src/extension/openai-bridge/` (entire dir) — pi is natively multi-provider. Largest single simplification.
- `src/extension/explore/` proxy/env plumbing — `ExploreService` core stays; Explore points at a pi provider/model directly (no loopback proxy).
- `src/extension/auth/sdk-env.ts` (`buildSdkEnv`, `CLAUDE_CONFIG_DIR` pinning, `~/.claude` mirroring, Linux token injection), `auth/native-binary-resolver.ts`, `auth/config-dir-bootstrap.ts` — no SDK subprocess/CLI binary.
- `src/extension/claude-session/query-warmup.ts` — SDK startup/warmup; in-process pi has no cold subprocess.
- `tool-manager.ts` FIFO name-correlation — replaced by pi's native `toolCallId`.
- `session/sdk-operations.ts` + SDK-JSONL readers — replaced by pi `SessionManager`.
- Dropped subsystems + their UI/settings/handlers/seam/tool-names: **Recall** (`src/extension/recall/`), **Workflow/Ultracode**, **Cron/Loop** (+ `LoopJobTracker`), **remote-control** (+ `RemoteControlManager`), **background tasks + Monitor**, **git-worktree tools**, **ToolSearch**, **NotebookEdit**, **LSP**.
- All `@anthropic-ai/claude-agent-sdk` imports (`shared/sdk-loader.ts`, `query-manager.ts`, `hook-handlers.ts`, `streaming-manager/processors/*`, `permission-handler/*` SDK couplings, each `mcp-server.ts` SDK wrapper).

## 7. Functional requirements

- FR-1: `ExtensionToWebviewMessage` MUST NOT change shape; only the producer changes. The adapter maps pi tool name + input + result `details` → existing webview tool shapes. (Additive extension-UI request/response message types for US-026 are the only permitted addition.)
- FR-2: The marketplace build MUST contain no Anthropic OAuth flow or Claude-Code request-shaping code (CI grep gate over `dist/` + bundled `node_modules`, minus any user-installed extension).
- FR-3: Subscription billing MUST use the `sk-ant-oat` Bearer path only; a real `ANTHROPIC_API_KEY` MUST NOT silently take precedence. Surface the active auth mode in the UI.
- FR-4: Exactly one pi runtime per host process; provider registrations MUST be re-applied after any `reload()`, including marketplace install/remove/update (B1).
- FR-5: pi auto-compaction MUST be off at startup; compaction only when `damocles.autoCompact` is on, host-driven; context-overflow handled host-side (B3).
- FR-6: Use pi-native tools (`read/bash/edit/write/grep/find/ls`/skills); added tools use CC-identical parameter schemas (§5). Approval correlates by pi `toolCallId`.
- FR-7: Memory + compass injection occurs pre-LLM each turn via `before_agent_start`/`context`; queued user messages inject via native `steer`/`followUp`.
- FR-8: Structured sub-calls use the terminating-tool pattern and fail soft (parse fallback → `[]`); never hard-fail on subscription (B4).
- FR-9: pi reads a Damocles-owned `agentDir`/settings (not `~/.pi`); `blockImages=false`.
- FR-10: VS Code workspace trust gates pi project-scoped resources (`setProjectTrusted` + `project_trust` event). The OAuth plugin installs at **global scope**; marketplace extensions support **both global and project scope** (D11) — project-scope installs require a trusted workspace and the `project_trust` flow.
- FR-11: Dropped subsystems (§2) MUST be removed cleanly (no dead UI, settings, renderers, handlers, tool-names, or seam methods).
- FR-12: Env overrides flow through pi/session config, never `process.env`.
- FR-13: No OutputChannel/log emits the `sk-ant-oat` token, Bearer headers, or full request/response bodies; a test asserts the token never appears in logs.
- FR-14: Rate-limit/usage-limit conditions (subscription 5-hour windows, 429/529) map to the existing rate-limit UX; the adapter translates pi `error`/`auto_retry_*` events into today's rate-limit message.
- FR-15: A trusted user can install/enable/disable/update any pi extension (npm/git/local) at **global or project scope** (project requires a trusted workspace); each install/remove re-flushes provider registration (B1), refreshes the active-tool set, and shows a security warning before first enable. Third-party extension `ctx.ui.*` calls route through the webview-bridged `ExtensionUIContext` (US-026).
- FR-16: The OpenAI/GPT path supports both API-key and Codex OAuth via pi-native auth; selecting a GPT model spins up no loopback bridge.
- FR-17: **Subscription system-prompt safety.** On the OAuth path, `pi-anthropic-oauth/prompt.ts` prepends `"You are Claude Code, Anthropic's official CLI for Claude."`, **drops** paragraphs containing `you are pi` or the anchors `pi-coding-agent` / `@earendil-works/pi-coding-agent` / `badlogic/pi-mono`, and replaces `\bpi\b`/`\bPi\b` → `"Claude Code"` everywhere. Damocles' system prompt (`system-prompt.ts`) MUST contain no bare `pi`/`Pi` tokens or those anchors, so subscription and API-key behavior stay identical (a test asserts this).

## 8. Seam scoping (`ClaudeSession` → `PiSession`)

The seam is the `ClaudeSession` public method set (~40 methods). Group → pi mapping:

**Removed / no-ops (dropped subsystems):** `getRecallService`, `getRecallTrajectory`, `recallService`, `isRecallMode`, `setRecallSession`, `refreshRecallConfig`, `planPath` get/set; `getLoopJobs`, `cancelLoopJob` (+ `LoopJobTracker`); workflow wiring; `enableRemoteControl`/`disableRemoteControl`/`remoteControlStatus` (+ `RemoteControlManager`); plus any background-task/Monitor/worktree/LSP/notebook/toolsearch seam methods. With Recall gone, `currentPromptIndex`/`activeNodeId`/`persistenceSessionId`/`memorySessionId` collapse to the pi session id (no node scoping); the recall-aware prompt-index advancement in `sendMessage` becomes a plain counter advanced only on non-internal sends.

**Reimplemented on pi (these GROW — do not undersell):**

- `sendMessage`/`queueInput` → `session.prompt(text,{images})` + native `steer`/`followUp`.
- `cancel`/`interrupt`/`reset`/`stopTask` → `session.abort()` (+ runtime teardown for reset). `stopTask` drops unless Team needs it.
- `setModel`/`getSupportedModels`/`getModelInfo` → `session.setModel(Model)` — **takes a `Model` object, not a string**; resolve via `getModel(provider,id)` / `modelRegistry.find()`; list via `modelRegistry.getAvailable()`.
- `setPermissionMode` → no pi equivalent; the central `tool_call` gate + `setActiveTools` (plan mode) implement modes.
- `setMcpServers`/`getMcpServerStatus`/`reconnectMcpServerLive`/`restartForMcpChanges` → re-bridge MCP as custom tools/extension (US-014).
- `setPlugins`/`reloadPlugins`/`restartForPluginChanges` → pi extensions + `DefaultPackageManager`; remap to marketplace discovery/reload (mind B1).
- `requestContextUsage` → `session.getContextUsage()` / `getSessionStats().contextUsage` (keep trust-boundary override).
- `disableThinkingForNextQuery`/`restoreThinkingConfig`/`setFastMode` → `session.setThinkingLevel` ("off" = disabled).
- `getAccumulatedCost` → budget meter (US-008) using `getSessionStats().cost`; checkpoints/`rewindFiles` → session tree `fork`/`branch`/labels + host file-snapshot (US-013).
- `setBetas` → inert on subscription (OAuth extension owns betas). **1M-context (D13):** Damocles' profile fields `supports1MContext`/`alwaysUses1mContext` (`src/shared/types/settings.ts`) map to the Anthropic beta `context-1m-2025-08-07`. Honored on API-key Anthropic by adding that beta header via the pi provider config; on subscription, betas are plugin-owned and not host-controllable, so the `alwaysUses1mContext` toggle is **disabled with a tooltip** ("managed by the subscription plugin") and treated as a no-op.
- `sendBtw`/`cancelBtw`, `emitExploreHistory`, browser/chrome wiring, `teamService` → keep, re-route through pi.

## 9. Phased user stories (webview unchanged)

**Harness selection (shipped):** there is **no user-facing harness flag**. `getEffectiveHarness()` (`pi-session/harness.ts`) returns `'pi'` whenever the host Node supports pi (≥ 22 = B5; the VS Code host always satisfies this) and `'sdk'` only as a Node-too-old fallback. `session-manager.ts` reads it at session creation (`PiSession` vs `ClaudeSession`). Existing SDK-format sessions do NOT load in pi (D1); new work starts fresh on pi.

### Phase 0 — Foundation spike (DONE)

**US-001 (DONE):** dynamic-import packaging (B2), single runtime (B1), subscription billing via `pi-anthropic-oauth` (`sk-ant-oat` Bearer, no `x-api-key`), auto-compaction off (B3). Verified live (F5). **US-009 (DONE):** Damocles-owned `agentDir` (`~/.damocles/pi/agent`), `compaction.enabled=false`, `blockImages=false`, passed explicitly (never `process.env`). **US-021-auth (DONE):** Claude 3-mode auth (`ClaudeAuthPanel.vue`): API key / subscription·allowance (plugin) / subscription·extra (no plugin).

### Phase 1 — Vertical slice + auth cutover (DONE)

**US-002 (DONE): PiSession seam + streaming adapter (read-only chat) + OpenAI cutover.**

- [x] `PiSession` implements the full `ChatSession` seam on `createAgentSessionRuntime` (deferred subsystems degrade gracefully); re-subscribe + re-bind on replacement.
- [x] Harness selection via `getEffectiveHarness()` in `session-manager.ts` — **pi default**, SDK is a Node < 22 fallback, no user-facing flag.
- [x] `PiStreamAdapter` maps deltas + `done`/`error` → existing messages (authoritative `assistant` on `message_end`; per-message ids; output tokens only via `done`); images + tool-name map present.
- [x] OpenAI pi-native (API key + Codex OAuth, `preferApiKey` wired); `openai-bridge/` deleted; GPT spins up no bridge (FR-16).
- [x] Golden-master + model-resolution + auth-handler tests; two Code Reviewer passes applied. Verified live (F5); typecheck/lint/tests green.

### Phase 2 — Tools + permissions (make-or-break)

**US-003 (DONE): Tool layer (pi-native + normalization + added tools).**

- [x] Enable pi built-ins via `tools: ["read","bash","edit","write","grep","find","ls", …added]`; Windows `bash` uses Git Bash (`shellPath`).
- [x] Adapter normalization layer (`tool-normalization.ts`) implements the §5 table (Read/Write/Edit/Bash/Grep/Glob input+`details`→webview shapes; Edit renders from `details.diff`/`patch`).
- [x] Added tools (`tools/`, built per-session) with CC-identical schemas: `Edit` (delegates to pi's edit; `replace_all` collapses to a whole-file edit; empty `old_string` rejected — Write-only creation), `PowerShell` (pwsh→powershell.exe fallback, tree-kill on timeout/abort), `Task*` list tools (replacing the planned TodoWrite/TodoRead), `AskUserQuestion`, `EnterPlanMode`/`ExitPlanMode`. WebSearch/WebFetch land via opt-in `pi-web-access` (`web_search`/`fetch_content`); `StructuredOutput`/`Agent` deferred (asserted absent).
- [x] Conformance test (`custom-tools.test.ts` + `tool-normalization.test.ts`): every display name resolves; added schemas match CC; dropped tools (Cron/Workflow/Monitor/Worktree/ToolSearch/NotebookEdit/LSP/StructuredOutput/Agent) absent.
- [x] Edit + Bash render verified in the webview (Ls tool card added).

**US-004 (DONE): Central permission gate + modes + diff approval.**

- [x] `permission-gate.ts` `tool_call` handler → `permissionHandler.canUseTool` (block/allow), correlation by native `toolCallId`; normalized name/input drive routing (read auto-allow; write/shell → approval).
- [x] Modes plan/default/acceptEdits/yolo reproduce the existing matrix; plan mode restricts the active set to read-only tools (`setActiveToolsByName`).
- [x] Reuse `ApprovalManager`/`DiffManager`/`QuestionManager`/`PlanManager` via the shared `PermissionHandler`.
- [x] Edit approve+deny round-trip + parallel-Edit correlation covered by `permission-gate.test.ts`.

**US-026 (DONE): Webview-bridged `ExtensionUIContext`.**

- [x] In-process `WebviewExtensionUIContext` (`extension-ui-context.ts`) whose `select`/`confirm`/`input`/`editor` post additive `extensionUiRequest`/`extensionUiResponse` message pairs; `notify` maps to a webview notice; rendered by `ExtensionUiDialog.vue` (+ `useExtensionUiStore`); other TUI surfaces are RPC-mode no-ops. `cancelAll()` on session replacement/dispose so awaiters don't hang.
- [x] Round-trip test (`extension-ui-context.test.ts`): an extension's `ctx.ui.*` resolves from a webview response.

### Phase 3 — Injection bus, in-process tools, prompt, budget

**US-005: Hook/injection bus.**

- [ ] Memory + compass status + plan-mode mandatory instruction injected pre-LLM via `before_agent_start`/`context`; queued messages via `steer`/`followUp`; shared `eventBus` passed to the loader.
- [ ] Verify injection appears pre-LLM in the webview.

**US-006: Re-wrap in-process tools + internal LLM sub-calls.**

- [ ] memory/compass/browser/team `createSdkMcpServer` servers → pi `defineTool` (Zod→TypeBox); cores untouched; gated by the central gate.
- [ ] Re-wrapped tools **keep their existing names** (incl. `mcp__damocles-team__*`) so the webview's MCP/tool renderers are unchanged; if pi rejects an `mcp__`-prefixed tool name, the adapter aliases it back for the webview.
- [ ] All internal LLM sub-calls in memory (consolidation, auto-extraction, profile regeneration) and btw route through pi (a lightweight pi-ai completion or ephemeral `SessionManager.inMemory()` session) using a small/fast model per active provider (Haiku-class on Anthropic, mini-class on OpenAI), failing soft — not the SDK. (Memory query-expansion is US-011.)

**US-007: System prompt + model object + thinking; sanitizer compliance (FR-17).**

- [ ] Feed `buildSystemPrompt` via `systemPromptOverride` (static base); dynamic per-turn additions via `before_agent_start`/`context` message injection (not systemPrompt rewrite).
- [ ] Model-id→`Model` resolver; thinking via `setThinkingLevel`.
- [ ] `system-prompt.ts` audited: no bare `pi`/`Pi` tokens or pi anchors; test asserts the subscription-sanitized prompt is byte-stable vs the API-key prompt except the prepended Claude-Code identity line.

**US-008: Budget meter.**

- [ ] `getSessionStats().cost` baseline + accumulate `Usage.cost.total` on `message_end`; abort on `maxBudgetUsd`/`taskBudget`; present as "estimated usage" on subscription; rewire `getAccumulatedCost()`.

### Phase 4 — Sessions, titles, checkpoints, plan, subagents

**US-010: Session persistence on pi `SessionManager`** (tree JSONL, version 3; `docs/session-format.md`); rewrite readers. SDK-format history (D14): keep old SDK sessions **visible as read-only** with **export-to-markdown**; do not load them into pi and do not build a two-way converter; new work starts fresh on pi. **US-012: AI title generator** — one-shot pi completion (small fast model) after the first turn → `session.setSessionName`; stored in Damocles' index. **US-013: Checkpoints / file-rewind / fork** — rewrite `CheckpointManager` on the session tree (`fork`/`branch`/`branchWithSummary`/`createBranchedSession` + labels via `appendLabelChange`) + a host file-snapshot store; adapt `git-checkpoint.ts`; verify rewind in the webview. **US-017: Plan mode** (tools landed early in Phase 2: `EnterPlanMode`/`ExitPlanMode` in `tools/plan-mode-tools.ts` drive `PlanManager`; plan mode restricts the active set to read-only via `setActiveToolsByName`) — remaining: `before_agent_start` mandatory instruction + `context` filter. **US-018 + US-019: Subagents/Task + Explore** — `Task`/`Agent` spawn nested in-process `AgentSession`s sharing the runtime (adapt `subagent/`: markdown agent-defs `name/description/tools/model`, single/parallel/chain). Explore runs the configured third-party pi model (no proxy). **US-020 (DONE): AskUserQuestion/elicitation** — `tools/ask-user-question-tool.ts` registers CC's exact schema, routes through `canUseTool` → `QuestionManager`, and returns the full SDK output (questions + answers + annotations) so the card renders and notes reach the model.

### Phase 5 — Extensibility marketplace, MCP, commands/skills, structured, trust, notices

**US-021: pi Extensions marketplace (HEADLINE).**

- [ ] Wrap `DefaultPackageManager` (install/remove/update npm/git/local; **both global and project scope** in v1; progress events; `PackageFilter`); persist via settings `packages`/`extensions` at the chosen scope.
- [ ] Webview "pi Extensions" panel (pattern: `PluginStatusPanel.vue` + `McpStatusPanel.vue`) lists installed/available with enable/disable/update, a scope selector (global vs project), per-extension security disclosure + warning before first enable.
- [ ] Enabling Claude subscription == installing `pi-anthropic-oauth` (global scope) as one entry.
- [ ] Project-scope installs require a trusted workspace and go through the `project_trust` flow (US-022); global scope always available with the opt-in warning.
- [ ] Re-flush provider registration after every install/remove (B1); refresh the active-tool set so new extension tools become callable.
- [ ] CI grep gate: no provider code in the marketplace bundle (FR-2); graceful notice when an extension is absent/failed. **US-014: MCP client** — stdio + HTTP + SSE via `@modelcontextprotocol/sdk`; expose external tools via `registerTool` (gated centrally); status/reconnect UI; isolated module; per-transport reference-server tests. Off the core-parity critical path. **US-015/US-016: Commands + skills** — map `SlashCommandService`/`getSupportedCommands` to `registerCommand`/`getCommands`; point skill discovery (`resources_discover`/`skillsOverride`) at Damocles' skills dir. **US-011: Structured query-expansion** — terminating-tool + TypeBox; fail-soft on OAuth (B4); change `memory/query-expansion.ts`. **US-022: Workspace-trust bridge** — `settingsManager.setProjectTrusted(workspace.isTrusted)` + react to `project_trust` grant/revoke (adapt `project-trust.ts`); OAuth plugin + default extensions stay global-scope. **US-023: Refusal + model-fallback/rate-limit notice** — refusals (D10): pi maps Anthropic's `refusal` to `stopReason:"error"` with the refusal text in `errorMessage` (`anthropic.ts:1222-1226`) and does NOT expose `RefusalStopDetails` publicly. Render refusals through the **existing error/notice path showing pi's `errorMessage`**; **drop the distinct `RefusalCard`** and do **not** text-match (preserves the "structured detection only" invariant). Map `auto_retry_*` → notice + rate-limit UX (FR-14); optional cross-model failover `streamFn` wrapper (P2).

### Phase 6 — Kept subsystems + cleanup

**US-024: Team on pi** — each agent = its own pi `AgentSession`; MessageBus/Scratchpad retained; team tool re-wrapped; audit `toolChoice` reliance (B4). **US-025: btw on pi** — ephemeral pi session sharing context (single turn, no persistence; `SessionManager.inMemory()`). **US-027: Delete dead SDK plumbing + dropped subsystems** (see §6); build green; final Code Reviewer pass asserting no `@anthropic-ai/claude-agent-sdk` imports and no dead dropped-subsystem code remain.

## 10. Critical files

- **Seam:** `ChatSession` interface in `src/extension/claude-session/chat-session.ts` (implemented by both `ClaudeSession` and `PiSession`); `claude-session/index.ts` (+ `types.ts`); pi seam: `src/extension/pi-session/` (`harness.ts`, `pi-runtime.ts`, `pi-session.ts`, `pi-stream-adapter.ts`, `pi-models.ts`, `openai-auth.ts`, `agent-dir.ts`, `pi-loader.ts`, `subscription.ts`).
- **Streaming/permission/system-prompt (today):** `claude-session/streaming-manager/processors/*`, `claude-session/hook-handlers.ts`, `permission-handler/index.ts` (+ managers), `tool-manager.ts`, `claude-session/system-prompt.ts`.
- **Tools/build/structured/titles:** `shared/tool-names.ts`, `esbuild.config.mjs`, `memory/query-expansion.ts`, `session/sdk-operations.ts`.
- **Settings UI:** `webview/components/SettingsPanel.vue`, `ClaudeAuthPanel.vue`, `OpenAIAuthPanel.vue`, `McpStatusPanel.vue`, `PluginStatusPanel.vue`; managers `chat-panel/settings-manager/managers/mcp-manager.ts`; handlers `chat-panel/message-router/handlers/*`.
- **Delete targets:** `openai-bridge/`, `explore/` (proxy parts), `auth/sdk-env.ts`, `auth/native-binary-resolver.ts`, `auth/config-dir-bootstrap.ts`, `claude-session/query-warmup.ts`, `shared/sdk-loader.ts`, `recall/`, dropped-tool code.
- **pi embed:** `pi/packages/coding-agent/src/core/sdk.ts`, `agent-session.ts`, `agent-session-runtime.ts`, `extensions/{types,loader,runner}.ts`, `package-manager.ts`, `settings-manager.ts`, `config.ts`, `session-manager.ts`, `model-registry.ts`, `auth-storage.ts`, `tools/*`; `packages/ai/src/types.ts`, `api-registry.ts`.
- **pi docs:** `docs/{sdk,rpc,extensions,packages,json,session-format,providers,custom-provider,windows}.md`.
- **pi examples to adapt:** `examples/extensions/{permission-gate,plan-mode,subagent,structured-output,git-checkpoint,question,questionnaire,project-trust,session-name,reload-runtime,input-transform,event-bus,todo}`; `examples/rpc-extension-ui.ts`.
- **OAuth reference (do NOT ship):** `pi-anthropic-oauth/src/{index,auth,stream,prompt,convert}.ts`.

## 11. Execution strategy

**Agent assignment**

- **Software/Backend Architect** — B1/B2/B3 (done), US-002/003/007/008/010/012/013 (runtime, tools, seam, streaming, sessions/titles/checkpoints).
- **Security Engineer** — US-004 (gate), US-021/022/026 + FR-2/3/10/15/17 (ToS separation, marketplace trust + warnings, billing guard, trust bridge, extension-UI bridging, system-prompt sanitizer compliance, CI grep gate).
- **Backend Architect** — US-005/006/011 (injection, tool re-wrap, structured), US-017/018/019 (plan/subagents/Explore), US-014 (MCP), US-024/025 (Team/btw).
- **Frontend Developer** — webview "pi Extensions" panel (US-021), extension-UI message routing (US-026), webview parity validation for US-002/004/005/013.
- **Code Reviewer** — gate each phase; verify no SDK imports / no dead dropped code after US-027.

**Sequencing**

- Step 1 (DONE): US-001/009/021-auth.
- Step 2 (DONE): US-002 (+ OpenAI pi-native cutover; pi made the default harness — no user-facing flag; `openai-bridge/` deleted).
- Step 3 (DONE): US-003 → US-004 → US-026. Plan-mode tools (US-017) + AskUserQuestion (US-020) + opt-in `pi-web-access` install landed alongside.
- Step 4 (parallel): US-005, US-006, US-007, US-008.
- Step 5 (sequential): US-010 → US-012 → US-013 → US-017 → US-018/019 → US-020.
- Step 6a (sequential): US-022 (workspace-trust bridge) — prerequisite for US-021 project-scope installs.
- Step 6b (parallel): US-021, US-014, US-015/016, US-011, US-023.
- Step 7 (parallel): US-024, US-025.
- Step 8 (sequential): US-027 cleanup + final review.

**Context handoff (per dispatch):** owning US + acceptance criteria + relevant blocker (B1-B4); scoped critical-files list; contracts (`ClaudeSession` seam §8, `ExtensionToWebviewMessage` shapes, pi `AssistantMessageEvent`/`AgentSessionEvent`/`ExtensionAPI`/`ToolDefinition`/`Model`/`Usage`, the §5 tool map); patterns (central gate, SDK→pi hooks, single runtime + re-register on reload, use pi-native tools, never `process.env`); constraints (no webview-contract change beyond additive extension-UI types; ship no provider code; no `pi-tui`; no inlined pi; no auto-compaction; no native-tool rebuild; no bare `pi`/`Pi` in the system prompt).

## 12. Verification

- **Unit/conformance:** loader-resolution smoke test (B2); single-runtime + re-register-after-reload test incl. marketplace install/remove (B1); auto-compaction-off test (B3); tool conformance (every display name resolves; added schemas == CC; dropped tools absent); adapter golden-master; permission-correlation test (parallel Edits via `toolCallId`); structured-fallback test (`[]` on OAuth without crashing); extension-UI round-trip test; system-prompt-sanitizer parity test (FR-17).
- **CI compliance gate:** no Anthropic OAuth/Claude-Code-shaping strings in the marketplace bundle (FR-2); `sk-ant-oat` path used when present + API key never overrides (FR-3); token never logged (FR-13).
- **Manual (F5):** stream a turn; approve/deny an Edit diff; trigger memory/compass injection; steer a mid-stream message; rewind a checkpoint; run a subagent; install + enable a marketplace extension and use its tool/command/dialog; connect a stdio MCP server; enable subscription and confirm a subscription-billed turn (no `x-api-key`); select a GPT model and confirm no bridge; generate an AI title; run a 2-agent Team; `/btw`; confirm long context does not auto-compact unless `damocles.autoCompact` is on.
- **Build:** `npm run typecheck`, `npm run lint`, `npm test`, then `npm run package`; confirm pi resolves from packaged `node_modules` and no `@anthropic-ai/claude-agent-sdk` references remain after US-027.

## 13. Resolved decisions

- D1 — Session format: adopt pi's tree JSONL. SDK history archived read-only / export-to-markdown; start fresh on pi.
- D2 — MCP: stdio + HTTP + SSE all in v1 via `@modelcontextprotocol/sdk` (US-014); off the core-parity critical path.
- D3 — Background tasks: **DROP** (Task\*/Monitor tools + code removed).
- D4 — Subscription resilience: if the plugin lags an Anthropic auth change, accept downtime + document; users fall back to API key / other providers.
- D5 — Extensibility: full trust-gated marketplace exposed to end users (US-021); mandatory trust gate + security warning before first enable.
- D6 — Tools: use pi-native tools + normalization layer; add only the CC tools pi lacks (CC-identical params); Glob maps to pi `find`.
- D7 — OpenAI: both API-key + Codex OAuth, pi-native; delete the openai-bridge.
- D8 — Windows shell: pi `bash` (Git Bash via `shellPath`) AND a first-class PowerShell tool.
- D9 — Drop + clean up: Recall, Workflow/Ultracode, Cron/Loop, remote-control, background tasks + Monitor, git-worktree tools, ToolSearch, NotebookEdit, LSP.

## 14. Resolved decisions (continued)

- D10 — Refusals (US-023): render through the existing error/notice path using pi's `errorMessage`; **drop the distinct `RefusalCard`**; no text-matching (preserves the "structured detection only" invariant). Anthropic's refusal collapses to `stopReason:"error"` and `RefusalStopDetails` is not publicly exposed.
- D11 — Marketplace scope (US-021): ship **both global and project scope in v1**; project-scope installs require a trusted workspace + the `project_trust` flow; global scope always available with the opt-in security warning. OAuth plugin stays global-scope.
- D12 — Grep (US-003): use pi's native `grep` and keep Damocles' Compass/ripgrep for richer search; accept that pi grep lacks CC's `output_mode`/`multiline`/`-n`/`-o` flags.
- D13 — 1M context (US-007/§8): the profile fields `supports1MContext`/`alwaysUses1mContext` map to Anthropic beta `context-1m-2025-08-07`. Honored on API-key Anthropic via provider-config header; on subscription the `alwaysUses1mContext` toggle is disabled with a tooltip ("managed by the subscription plugin") and is a no-op.
- D14 — SDK history (US-010): keep old SDK-format sessions visible as read-only with export-to-markdown; no two-way converter; start fresh on pi.

No open questions remain.
