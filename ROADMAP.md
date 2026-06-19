# ROADMAP — pi harness migration

Damocles is migrating its agent engine off Anthropic's **Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk`) onto **pi** (`@earendil-works/pi-coding-agent`, MIT). The goal: own the agent loop, gain native multi-provider support, and turn pi's extension system into a user-facing extensibility platform.

**Hard invariant:** the webview message contract (`ExtensionToWebviewMessage`) does not change — only its producer does. The seam is the `ChatSession` interface (`src/extension/claude-session/chat-session.ts`), implemented by the legacy `ClaudeSession` and the default `PiSession` (`src/extension/pi-session/`).

---

## Status

`getEffectiveHarness()` returns `'pi'` whenever the host Node is ≥ 22 (the VS Code host always is), so **pi is the default engine**; the SDK persists only as the Node < 22 fallback, deleted in US-027.

**Landed (Phases 0–6):**

- **Phase 0–1** — Dynamic-import packaging, the single process-global `PiRuntime`, 3-mode Claude auth, the `PiStreamAdapter`, the `PiSession` vertical slice, and the pi-native OpenAI cutover (the loopback `openai-bridge` is deleted; pi speaks Codex OAuth + `OPENAI_API_KEY` directly).
- **Phase 2** — pi-native tool layer + normalization, the central `tool_call` permission gate, plan mode, `AskUserQuestion`, and the webview-bridged `ExtensionUIContext`. The legacy Claude Code plugin system was removed and replaced by the `ToolsStatusPanel`.
- **Phase 3** — SDK-decoupled on the pi path: memory/compass/browser re-wrapped as pi `defineTool` (PascalCase active-set names, schema-parity tested); internal sub-calls via `PiRuntime.runStructuredCompletion`; Damocles' `buildSystemPrompt` wired through `before_agent_start`; consolidation on the pi path; the budget meter.
- **Phase 4** — Native sessions on pi's `SessionManager` (tree-JSONL persistence, list/metadata/watch, rename/tag/delete), AI titles, and a per-session **bare-git checkpoint engine** for checkpoints / rewind / fork (separate from the user's real repo) — replacing the SDK session store and `forkSession` on the pi path.
- **Phase 5** — Native subagent engine (`pi-session/subagents/`): in-process nested `AgentSession`s reusing the `PiRuntime`; `Agent` / `GetSubagentResult` / `SteerSubagent` tools; markdown agents from `.pi/agents` + `.claude/agents` + the global dir + embedded defaults (general-purpose / Explore / Plan); concurrency queue (`damocles.subagents.maxConcurrent`); nested calls through the central gate at the panel's mode; JSONL transcripts + live streaming into the parent `Agent` card; recursion blocked; project scope trust-gated (US-022); Explore native multi-provider (US-019). Worktree / `inherit_context` / agent-memory deferred.
- **Phase 6** — Native MCP client (`pi-session/mcp/`, lifted from `pi-mcp-adapter`): stdio + streamable-HTTP (SSE probe-fallback) transports, a lifecycle/health/reconnect/idle connection pool, per-tool exposure as `mcp__{server}__{tool}` registered through the shared Damocles extension factory, OAuth (PKCE + client_credentials) and form elicitation via `ExtensionUIContext`, and an on-disk metadata cache. Config now merges workspace `.mcp.json` over a read-only Claude Code/Desktop import; the disabled set moved to the Damocles-owned `damocles.mcp.disabledServers` workspaceState; the central gate replaced `ConsentManager`.

**Remaining (Phases 7–9):** the web tools (one MIT lift), the extensibility marketplace, and the kept-subsystem ports + SDK-deletion cleanup.

---

## Native lifts (three MIT repos → native Damocles code, not runtime deps)

| Repo | → Phase / Story | Lift |
| --- | --- | --- |
| `pi-subagents` | Phase 5 (US-018/019, reused by US-024) | In-process nested `AgentSession`s, concurrency queue, `.pi/agents/*.md` parser, model/context/usage resolvers, JSONL transcripts, opt-in worktree. Drop the TUI + scheduler. |
| `pi-mcp-adapter` | Phase 6 (US-014) | stdio + streamable-HTTP→SSE client, lifecycle/health/reconnect, tool registrar (MCP content → pi blocks), OAuth. Drop the TUI + MCP-UI (deferred). |
| `pi-web-access` | Phase 7 (US-028) | `WebSearch`/`WebFetch` (+ `code_search`) extraction stack (Readability/RSC/Jina/Gemini, PDF, Exa/Perplexity). Drop the curator UI + cookie auth. |

---

## Phases 5–9

**Phase 5 — Native subagent engine (lift `pi-subagents`). LANDED.** In-process nested `AgentSession`s built from per-subagent `AgentSessionServices` that reuse the `PiRuntime` auth/registry; agents defined by `.pi/agents/*.md` (precedence) + `.claude/agents/*.md` (compat) + the global dir + embedded defaults; tools `Agent` / `GetSubagentResult` / `SteerSubagent` (PascalCase; `Agent`, not `Task` — already used for todos). Nested tool calls go through the central gate at the panel's current mode (**inherit-parent-mode**, superseding the earlier "allowlist = sandbox" idea). Nested-session events funnel into the parent `Agent` card via the `subagent*` + `parentToolUseId` webview messages — never the primary stream (no contract change). **US-019** makes Explore a built-in read-only agent type on pi via native multi-provider registration (StepFun/OpenRouter/Gemini — no loopback proxy); the `explore/` proxy module is left **intact but dormant on pi** and deleted in US-027 (deleting it now would break the SDK path's compile). Worktree isolation, `inherit_context`, and agent-memory are deferred (frontmatter fields parse but carry no behavior). Project-scope loading is trust-gated (US-022). Scheduler excluded. Unlocks US-024.

**Phase 6 — Native MCP client (lift `pi-mcp-adapter`). LANDED.** stdio + streamable-HTTP (SSE probe-fallback); each MCP tool/resource is an individual pi tool `mcp__{server}__{tool}` registered through the shared Damocles extension factory (pi's only `registerTool` seam) and routed through the central gate (server-advertised `readOnlyHint` auto-allows, but only when not `destructiveHint`/`openWorldHint`); **reused** the existing `McpManager` config/watcher + `McpServerConfig`/`McpServerStatusInfo` seam (the central gate replaced `ConsentManager`). Config now merges workspace `.mcp.json` over a read-only Claude Code/Desktop import; the disabled set moved to the Damocles-owned `damocles.mcp.disabledServers` workspaceState. `@modelcontextprotocol/sdk` (`^1.29.0`) ships via the dynamic-import + esbuild-external pattern. OAuth (PKCE + client_credentials) and form elicitation landed; MCP-UI / sampling / the single proxy tool were dropped.

**Phase 7 — Native web tools (lift `pi-web-access`).** Register `WebSearch`/`WebFetch` (+ `code_search`) under Damocles names; **zero-config via Exa's free endpoint**, with optional Exa/Perplexity/Gemini keys in VS Code SecretStorage for higher limits. Removes the opt-in `pi-web-access` install. Graceful degradation when keys/binaries are absent; no `~/.pi/web-search.json` coupling; no cookie scraping in v1.

**Phase 8 — Extensibility marketplace + commands/skills + structured output + refusals.**
- **US-022** — workspace-trust bridge (`setProjectTrusted` + `project_trust`); gates `.pi/agents` project loading.
- **US-021 (headline)** — wrap `DefaultPackageManager` (install/remove/update; npm/git/local; global + project); **capability classification** (tools/providers/commands/skills supported; renderer/footer/TUI degraded-with-badge via the US-026 UI shim); webview "pi Extensions" panel; trust gate + security warning; re-flush provider regs + refresh active tools after each op.
- **US-015/016** — commands + skills pointed at Damocles' dirs.
- **US-011** — structured query-expansion via the terminating-tool idiom (no `toolChoice`-gated behavior — subscription OAuth can't force tools).
- **US-023** — refusals through the existing error/notice path using pi `errorMessage` (no `RefusalCard`, no text-match).

**Phase 9 — Kept subsystems + final cleanup.**
- **US-024 (Team on the subagent engine)** — `AgentManager` drives multiple nested sessions; MessageBus/Scratchpad retained; the 161 AgentLand profiles become `.pi/agents/*.md`; unlocks multi-provider/GPT Teams (today a GPT panel forces Claude). Depends on Phase 5.
- **US-025 (btw)** — ephemeral in-memory pi session, single turn, shared context.
- **US-029 (remove Recall)** — delete the Recall context strategy and its webview surfaces/config outright (no pi port; its REPL/stateless-query design doesn't justify the weight). Optional restore via a third-party `context-mode` marketplace extension. Closes recall's last SDK dependency.
- **US-027 (cleanup)** — delete all `@anthropic-ai/claude-agent-sdk` imports + dropped-subsystem code; final review asserts a clean tree. Depends on US-019/US-024/US-025/US-029 having removed every remaining `createSdkMcpServer` / `loadSdkQuery` site.

---

## Engineering principles for the lifts (no bandaids)

1. **Integrate, don't fork.** Reuse Damocles' existing systems (the `McpManager` config/watcher, `ToolCallCard.vue`, `resolvePiModel`, the central gate, the shared `PiRuntime` registry) — not the source repos' CLI/TUI assumptions.
2. **Preserve MIT attribution.** Keep license headers on lifted files; credit each repo in `THIRD-PARTY-NOTICES.md`.
3. **ESM-from-CJS.** New ESM deps (`@modelcontextprotocol/sdk`, web-tools libs) load via dynamic `import()` behind esbuild `external`, with an activation resolution smoke test; externalize anything that can't bundle (as `sql.js-fts5` / `web-tree-sitter` already are).
4. **No TUI.** Extension dialogs use the US-026 `ExtensionUIContext` bridge; tool rendering uses existing/additive Vue tool cards.
5. **Fail soft.** Missing binaries/keys → clear message, never a crash; the turn continues. Internal sub-calls fail soft to a safe default.
6. **No behavior gated on `toolChoice`.** Subscription OAuth can't force tools or constrain JSON; structured paths use the terminating-tool idiom + parse-from-text fallback.

---

## Key decisions

- **D15 — MCP:** native lift; no runtime dep on the community package. OAuth in v1; MCP-UI/sampling/elicitation deferred behind a flag.
- **D16 — Web:** native lift; zero-config via Exa's free endpoint; the opt-in `pi-web-access` install is removed; curator UI + cookie auth dropped for v1.
- **D17 — Subagents:** native lift; markdown-defined agents; in-process nested sessions; allowlist-sandboxed background agents; reused to power Team and Explore. Scheduler excluded (Cron/Loop stays dropped).
- **D18 — Extensibility:** capability-tiered open marketplace.
- **D19 — Bidirectional extensibility** (publishing Damocles outward as a pi extension): out of scope.
- **D20 — Recall removed** (US-029), not ported; optional restore via a third-party marketplace extension.

---

## pi facts relied on

- Extensions register via a default factory `export default (pi: ExtensionAPI) => {…}`; Damocles uses `tool_call`, `before_agent_start`, plus the Phase-4 session/checkpoint lifecycle hooks (`message_start`/`turn_end`/`agent_end`).
- `before_agent_start` fires **once per user prompt** (inject a message + chain the system prompt). `context` fires before every LLM call (ephemeral) — reserved for genuinely per-turn needs.
- `setThinkingLevel(level)` takes `ThinkingLevel = "minimal"|"low"|"medium"|"high"|"xhigh"` — there is no `"off"`; the disable path maps to the lowest level (`effortToThinkingLevel`).
- Structured output uses a terminating tool (`defineTool` + TypeBox + `terminate:true`); the loop stops only if **every** tool in the batch terminates.
- pi has **no native** subagent API, MCP client, or web tools — hence the three lifts.
