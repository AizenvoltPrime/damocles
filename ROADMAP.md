# Plan: Optimize ROADMAP.md — Phase 3 and beyond (pi harness migration)

> **Deliverable of this plan:** a rewrite of `C:\GameDev\damocles\ROADMAP.md` (Phase 3+). This file is the standalone blueprint for that rewrite. No code is changed by approving this plan — only `ROADMAP.md` is edited during implementation.

---

## 1. Background (self-contained — no prior context needed)

**Damocles** is a VS Code extension: a Vue 3 + Pinia webview chat UI, with a Node extension host bundled as CJS via esbuild. It is migrating its agent engine off Anthropic's **Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk`) onto **pi** (`@earendil-works/pi-coding-agent`, MIT, the "pi" agent harness at `C:\GameDev\pi`). The webview message contract (`ExtensionToWebviewMessage`) must not change — only its producer does. The seam is the `ChatSession` interface (`src/extension/claude-session/chat-session.ts`), implemented by the old `ClaudeSession` and the new `PiSession` (`src/extension/pi-session/`).

**Goal of the migration:** fully replace the SDK with pi (own the agent loop, gain native multi-provider support), and turn pi's extension system into a user-facing extensibility platform.

**Where it stands (verified this session against `src/extension/pi-session/`):**

- **Phases 0–2 are done:** dynamic-import packaging, the single process-global `PiRuntime`, Claude 3-mode auth, the `PiStreamAdapter`, the pi-native tool layer + normalization, the central permission gate, plan-mode tools, `AskUserQuestion`, and the webview-bridged `ExtensionUIContext` (US-026).
- **Phase 3 has landed:** US-005/006/006b/007/008 decoupled the always-on subsystems from the SDK on the pi path — memory/compass/browser re-wrapped as pi `defineTool` (now PascalCase active-set names, schema-parity tested), internal sub-calls via `PiRuntime.runStructuredCompletion`, `systemPromptOverride` (`buildSystemPrompt`) wired through `before_agent_start`, consolidation triggered on the pi path, and the budget meter finished. The SDK persists only as the Node<22 fallback (deleted later in US-027). Separately, the legacy Claude Code plugin system was removed and its UI replaced by the `ToolsStatusPanel`.
- **Phases 4–9 are largely unstarted.** Every remaining SDK tie has a resolving story that lands before the US-027 cleanup: team → US-024 (ported), explore → US-019 (ported), btw → US-025 (ported), and **recall → US-029 (removed entirely)**.

**pi facts relied on (verified in `C:\GameDev\pi`):**

- Extensions register via a default factory `export default (pi: ExtensionAPI) => {…}`. ~30 lifecycle hooks exist; Damocles uses 2 today (`tool_call`, `before_agent_start`).
- `before_agent_start` fires **once per user prompt** (can inject a message + chain the system prompt). `context` fires **before every LLM call** (returns `{messages}`, non-destructive/ephemeral).
- `setThinkingLevel(level)` accepts `ThinkingLevel = "minimal"|"low"|"medium"|"high"|"xhigh"` — **not** `"off"`.
- Structured output: no `json_schema`/forced `toolChoice`; the idiom is a terminating tool (`defineTool` + TypeBox + `terminate:true`). Caveat: the loop stops only if **every** tool in the batch returns `terminate:true`.
- `DefaultPackageManager` installs extensions from npm/git/local at global or project scope, with progress events and `PackageFilter`.
- pi has **no native** subagent API, **no MCP client**, and **no web tools**.

---

## 2. Source material for the three native lifts (self-contained)

The user cloned three MIT repos to lift into **native Damocles code** (not runtime dependencies). LOC = liftable core (tests + pi-TUI excluded).

| Repo (path) | → Story | Core LOC | Lift | Drop (pi-TUI/CLI) |
| --- | --- | --- | --- | --- |
| `C:\GameDev\pi-mcp-adapter` | US-014 | ~2,800 | `server-manager.ts` (stdio + streamable-HTTP→SSE fallback), `lifecycle.ts` (health/idle/reconnect), `types.ts`, `tool-metadata.ts`, `tool-registrar.ts` (MCP content→pi blocks), `metadata-cache.ts`, `npx-resolver.ts`, `mcp-auth*.ts`+`mcp-oauth-provider.ts`+`mcp-callback-server.ts` (OAuth, deferred), `errors.ts`, `utils.ts` | `mcp-panel.ts`/`mcp-setup-panel.ts` (TUI), `ui-server.ts`/`ui-session.ts`/`glimpse-ui.ts` (MCP-UI, deferred), `consent-manager.ts` (use Damocles `PermissionHandler`) |
| `C:\GameDev\pi-web-access` | US-028 | ~1,000 | `extract.ts` (Readability→RSC→Jina→Gemini), `pdf-extract.ts` (unpdf), `rsc-extract.ts`, `exa.ts`, `perplexity.ts`, `gemini-*.ts`, `github-extract.ts`/`github-api.ts`, `youtube-extract.ts`, `video-extract.ts`, `storage.ts`, `utils.ts` | curator UI (`curator-server.ts`+`curator-page.ts`, ~3,400 LOC), TUI `renderCall`/`renderResult`, `activity.ts`, shortcuts/session hooks, `chrome-cookies.ts` (see §3) |
| `C:\GameDev\pi-subagents` | US-018/019 (+ reused by US-024/019) | ~1,700 | `agent-runner.ts` (in-process `createAgentSession`, callback streaming), `agent-manager.ts` (concurrency queue, default 4), `types.ts`, `agent-types.ts` (registry), `custom-agents.ts` (`.pi/agents/*.md` frontmatter parser), `default-agents.ts`, `invocation-config.ts`, `context.ts` (parent inheritance), `prompts.ts`, `memory.ts`, `skill-loader.ts`, `model-resolver.ts`, `usage.ts`, `group-join.ts`, `output-file.ts` (JSONL transcripts), `worktree.ts` (opt-in) | `ui/*` (widget/viewer/menus), `/agents` TUI handler, `pi.registerCommand`/`registerTool` shells, **`schedule.ts`+`croner`** (Cron/Loop stays dropped) |

---

## 3. Engineering principles for all three lifts (no bandaids)

These are mandated in the rewritten ROADMAP so the lifts integrate cleanly instead of bolting on a parallel system.

1. **Integrate, don't fork.** Each lift must reuse Damocles' existing systems, not the repo's CLI/TUI assumptions:
   - MCP → reuse the existing `McpManager` config + `FileSystemWatcher` (`.mcp.json` + `disabledMcpjsonServers`) and the existing seam shapes `McpServerConfig` / `McpServerStatusInfo`. Do **not** import pi-mcp-adapter's 4-file precedence config or `ConsentManager` (the central permission gate from US-004 already covers consent).
   - Web → reuse `ToolCallCard.vue` rendering and the existing `WebSearch`/`WebFetch` tool names; provider keys via VS Code **SecretStorage**, not a plaintext file.
   - Subagents → nested tool calls route through the **same central `tool_call` gate** (US-004); models resolve via the existing `resolvePiModel`; auth via the shared `PiRuntime` registry.
2. **Preserve MIT attribution.** Retain copyright/license headers on lifted files and add a NOTICE/attribution entry for each of the three repos.
3. **Follow the established ESM-from-CJS pattern.** pi is loaded via dynamic `import()` behind an async seam with esbuild `external`. `@modelcontextprotocol/sdk` (ESM) must use the **same** pattern — esbuild external + dynamic import, shipped as a real `node_module`, with an activation resolution smoke test (extend B2). Likewise verify the web-tools deps; if any (notably `unpdf`/`pdfjs-dist` WASM) cannot be bundled, externalize them as `sql.js-fts5`/`web-tree-sitter` already are.
4. **Drop the TUI; route UI through existing webview bridges.** No `pi-tui` imports. Extension-driven dialogs use the US-026 `ExtensionUIContext` bridge; tool rendering uses existing/additive Vue tool cards.
5. **Fail soft / degrade gracefully.** Missing external binaries (`yt-dlp`, `ffmpeg`, `git`, `gh`) → clear user message, never a hard crash. Missing provider keys → the tool reports it, the turn continues. Internal LLM sub-calls fail soft to a safe default.
6. **No behavior gated on `toolChoice`.** Subscription (OAuth) cannot force tools or constrain JSON (blocker B4); structured paths use the terminating-tool idiom and parse-from-text fallback.

---

## 4. The critical-path reframe (accuracy fix — belongs at the front of Phase 3)

The migration's stated goal is "full SDK replacement." **Status: Phase 3 landed — all three blockers below are resolved on the pi path; the SDK now persists only as the Node<22 fallback that US-027 deletes, alongside the still-SDK team/explore/btw subsystems (ported by US-024/US-019/US-025) and recall (removed by US-029).** Original framing retained for traceability:

1. **In-process tool servers (US-006, DONE on the pi path):** memory/compass/browser re-wrapped as pi `defineTool` (PascalCase active-set names, schema-parity tested). The SDK `createSdkMcpServer` copies (`memory/compass/browser` `mcp-server.ts`) remain only as the fallback. **team** (`team/mcp-server.ts`) is still SDK-only — deferred to US-024, not part of US-006.
2. **Internal LLM sub-calls (US-006b, DONE on the pi path):** `memory/subcall-runner.ts` and `memory/query-expansion.ts` branch on `getEffectiveHarness()` → `PiRuntime.runStructuredCompletion` (terminating-tool idiom, fail-soft). Still SDK and deferred: `explore/agent-runner.ts` (US-019), `team/agent-runner.ts` (US-024), btw (US-025).
3. **Memory consolidation is wired on pi:** session-switch consolidation runs in the `session-manager.ts` pi branch (mirroring the SDK path) — US-006b closed this gap.

Resolved: **US-007 `systemPromptOverride` is wired** — `agent-start.ts` injects Damocles' `buildSystemPrompt` + memory/plan/skills via `before_agent_start`, so the pi harness runs on Damocles' system prompt, not pi's default.

---

## 5. Corrections & clarifications to apply to the existing ROADMAP

- **Correction (real):** §8 says `setThinkingLevel("off" = disabled)`. `"off"` is not a valid `ThinkingLevel`. Confirm Damocles' actual disable mechanism (lowest level, or a non-reasoning model state) in `pi-models.ts:effortToThinkingLevel` and correct the note.
- **Clarification (I reconsidered my own first draft):** memory/compass injection (US-005) should use **`before_agent_start`** (once per user prompt — the true analog of the SDK's `UserPromptSubmit`, which is what `hook-handlers.ts:571/592` use). Using the `context` hook would re-inject the catalog on every turn (duplication + token bloat). Reserve `context` only for any genuinely per-turn ephemeral need. The roadmap's `before_agent_start` choice was right; make it explicit.
- **Wiring gap:** pass a shared `eventBus` (`createEventBus()`) to the loader (absent at `pi-runtime.ts:148`). It is the backbone for the lifted subagents' cross-component RPC and for marketplace extension interop.
- **FR-17 scope:** the subscription-path system-prompt sanitizer applies to the **whole** prompt — so subagent system prompts (from `.pi/agents/*.md`) and injected memory/compass text must also avoid bare `pi`/`Pi` tokens and the pi anchors on the subscription path.

---

## 6. New decisions and functional requirements (add to ROADMAP §2/§7/§13–14)

**Decisions:**

- **D15 — MCP:** lift `pi-mcp-adapter` (MIT) into a **native** client; no runtime dependency on the community package. **OAuth is in v1** (the implementation is lifted from the repo); MCP-UI/sampling/elicitation deferred behind a flag.
- **D16 — Web tools:** lift `pi-web-access` (MIT) into **native** `WebSearch`/`WebFetch` (+ `code_search`); **remove** the opt-in `pi-web-access` install; **works zero-config out of the box via Exa's free endpoint**, with optional Exa/Perplexity/Gemini keys (SecretStorage) for higher limits/quality; curator UI and browser-cookie auth dropped for v1.
- **D17 — Subagents:** **native** lift of `pi-subagents` (MIT); agents defined by markdown templates discovered from `.pi/agents/` (precedence) + `.claude/agents/` (compat, already mirrored) + the global agents dir; in-process nested sessions; background/parallel agents auto-approve within their `tools` allowlist (the allowlist is the sandbox); reused to power **Team (US-024)** and **Explore (US-019)**. Scheduler excluded (Cron/Loop stays dropped).
- **D18 — Extensibility:** capability-tiered open marketplace.
- **D19 — Bidirectional extensibility (publishing Damocles' own capabilities outward as a pi extension): out of scope.**
- **D20 — Recall removed:** the Recall context strategy is **deleted outright** (US-029, Phase 9), not ported to pi — it is the only remaining SDK-coupled subsystem whose REPL/stateless-query design has no clean pi migration that justifies its weight. Users who want it back opt into the third-party `context-mode` marketplace extension (§9, rec. 5). Closes recall's `loadSdkQuery` dependency ahead of US-027.

**Functional requirements:**

- **FR-18 (MCP):** native client supports stdio + streamable-HTTP (SSE fallback); external tools register through the central gate, namespaced `{server}_{tool}`; reuses the existing `McpManager` config/watcher and the `setMcpServers`/`getMcpServerStatus`/`reconnectMcpServerLive`/`restartForMcpChanges` seam; re-flushes provider regs + refreshes the active-tool set on change (B1). OAuth (authenticated remote servers, e.g. hosted MCP) is in v1; MCP-UI/sampling/elicitation are deferred behind a flag.
- **FR-19 (Web):** registers `WebSearch`/`WebFetch` (+ `code_search`), read-only; works zero-config via Exa's free endpoint by default, with optional provider keys (Exa/Perplexity/Gemini) in SecretStorage for higher limits/quality; graceful degradation when keys/binaries are absent; no `~/.pi/web-search.json` coupling; no browser-cookie scraping in v1.
- **FR-20 (Subagents):** subagents are nested in-process `AgentSession`s sharing the `PiRuntime`; defined by `.pi/agents/*.md` (project, trust-gated, precedence) + `.claude/agents/*.md` (compat) + the global agents dir; per-agent model/tools/thinking; **nested tool calls go through the central permission gate**; background/parallel agents **auto-approve calls within their declared `tools` allowlist and block anything outside it** (the allowlist is the sandbox — interactive diff approval would deadlock a background agent); **nested-session events are funneled into the parent `Agent` tool's `partialResult`, never the primary `PiStreamAdapter` stream** (no webview-contract change). The subagent tool is named **`Agent`** (not `Task`, which Damocles already uses for todo-style tools).
- **FR-21 (Extensibility):** installed extensions are capability-classified (tools/providers/commands/skills = supported; message-renderer/footer/header/custom-TUI = degraded with a clear badge); `ctx.ui.*` routes through the US-026 bridge; the bridge records calls to unsupported TUI surfaces to drive the badge.
- **FR-22 (Attribution):** lifted MIT code retains its license headers; a NOTICE entry credits each source repo.

---

## 7. The new phase structure (Phases 3–9)

> Per user direction, each of the three big native lifts is its **own phase**, not a sub-bullet.

**Phase 3 — Decouple from the SDK (true critical path; gates US-027). — LANDED (US-005/006/006b/007/008 done on the pi path; SDK now fallback-only).**

- **US-006 (LANDED):** re-wrapped memory/compass/browser `createSdkMcpServer` servers as pi `defineTool` (Zod→TypeBox); cores untouched; tools surfaced under PascalCase active-set names (`SaveMemory`, `CompassSearch`…) in the Tools panel; gated centrally; schema-parity tested. **Team's server is not in scope** — it moves with US-024. The SDK `mcp-server.ts` copies remain only as the Node<22 fallback.
- **US-006b (LANDED, scoped to memory):** routed memory's internal LLM sub-calls onto pi — `subcall-runner.ts`, `query-expansion.ts` → `PiRuntime.runStructuredCompletion`, small/fast model **per active provider** (Haiku-class on Anthropic, mini-class on OpenAI); fail soft; terminating-tool idiom (B4). **Includes** wiring memory consolidation-on-session-switch on the pi path (closed the `session-manager.ts:122` gap). **btw / team / explore sub-calls were deferred to their own subsystem stories** (US-025 / US-024 / US-019), not done here.
- **US-005 (clarified):** injection bus — memory + compass via `before_agent_start` (once per prompt); plan-mode mandatory instruction stays in `before_agent_start`; queued messages via `steer`/`followUp`; wire the shared `eventBus`.
- **US-007 (elevated):** wire `buildSystemPrompt` via `systemPromptOverride`; model resolver + thinking; FR-17 sanitizer parity test (subscription prompt byte-stable vs API-key except the prepended identity line), extended to subagent + injected text.
- **US-008:** finish the budget meter (cost accumulation done; add `maxBudgetUsd`/`taskBudget` abort + subscription "estimated usage").

**Phase 4 — Sessions, titles, checkpoints.**

- **US-010** pi `SessionManager` persistence (tree JSONL v3); SDK history read-only + export-to-markdown (D14).
- **US-012** AI title (one-shot pi completion → `session.setSessionName`).
- **US-013** checkpoints/rewind/fork on the session tree (`fork`/`branch`/`branchWithSummary`/`createBranchedSession`/`appendLabelChange`) + host file-snapshot; re-subscribe + `bindExtensions` after replacement.

**Phase 5 — Native subagent engine (own phase; lift `pi-subagents`).**

- **US-018/019:** lift the `pi-subagents` core into Damocles; in-process nested `AgentSession`s sharing `PiRuntime`; agent definitions from `.pi/agents/*.md` (precedence) + `.claude/agents/*.md` (compat) + global (frontmatter: name/description/tools/model/thinking/inherit_context/isolated/run_in_background…), project-scope loading **trust-gated** (US-022); tools **`Agent`** / `get_subagent_result` / `steer_subagent`; concurrency queue (default 4); nested tool calls through the central gate, background agents auto-approving within their `tools` allowlist (FR-20); nested-session events funnel into the parent `Agent` tool's `partialResult`, not the primary stream. **US-019 — Explore becomes a built-in agent type** (read-only tools), deleting the explore proxy. **Expansions:** opt-in `isolation: worktree` (distinct from the dropped worktree _tools_; off by default, requires git); per-agent memory; an optional live multi-agent transcript viewer (would use **additive** webview message types — call out explicitly if built). **Exclude** the scheduler. Unlocks US-024.

**Phase 6 — Native MCP client (own phase; lift `pi-mcp-adapter`).**

- **US-014:** lift the core; stdio + streamable-HTTP (SSE fallback); proxy + direct-tool modes; `{server}_{tool}` namespacing; central gate replaces `ConsentManager`; **reuse the existing `McpManager` config/watcher + `McpServerConfig`/`McpServerStatusInfo` seam**; status/reconnect in `McpStatusPanel.vue`; `@modelcontextprotocol/sdk` via the dynamic-import + external pattern (B2); re-flush provider regs + refresh active tools on change (B1). OAuth in v1 (lifted from the repo); MCP-UI/sampling/elicitation behind a flag (FR-18). Per-transport reference-server test.

**Phase 7 — Native web tools (own phase; lift `pi-web-access`).**

- **US-028 (new):** lift the core; register `WebSearch`/`WebFetch` (+ `code_search`) with Damocles names; works zero-config via Exa's free endpoint, with optional keys (Exa/Perplexity/Gemini) in SecretStorage; add npm deps (`@mozilla/readability`,`linkedom`,`p-limit`,`turndown`,`unpdf`) per the §3 bundling rule; drop the opt-in install + the `web_search`/`fetch_content` `PI_TOOL_NAME_MAP` entries; curator + cookie auth dropped v1; graceful degradation for missing keys/binaries (FR-19). `ToolCallCard.vue` already renders these tools.

**Phase 8 — Extensibility marketplace + commands/skills + structured + refusal.**

- **US-022 (prereq):** workspace-trust bridge (`setProjectTrusted(workspace.isTrusted)` + `project_trust` event); also gates `.pi/agents` project-scope loading.
- **US-021 (HEADLINE):** wrap `DefaultPackageManager` (install/remove/update; npm/git/local; global+project; progress; `PackageFilter`); **capability classification** (supported vs degraded-with-badge per FR-21, detected via registered capabilities + the US-026 UI-context shim); webview "pi Extensions" panel (pattern: `ToolsStatusPanel.vue`+`McpStatusPanel.vue`); trust gate + security warning before first enable; OAuth plugin is one entry; re-flush provider regs + refresh active tools after each op (B1); `settingsManager.flush()` at persist boundaries; CI grep gate (FR-2); surface `resources_discover` skills/prompts.
- **US-015/016:** commands (`registerCommand`/`getCommands`) + skills (`resources_discover`/`skillsOverride`, `/skill:name` expansion) pointed at Damocles' dirs.
- **US-011:** structured query-expansion via terminating-tool + TypeBox; document the batch-terminate caveat (single-tool turn); fail-soft on OAuth. Depends on US-006b.
- **US-023:** refusals through the existing error/notice path using pi `errorMessage` (drop `RefusalCard`, no text-match, D10); `auto_retry_*` → rate-limit UX (FR-14).

**Phase 9 — Kept subsystems + final cleanup.**

- **US-024 (Team on the subagent engine):** `AgentManager` manages multiple nested `AgentSession`s; MessageBus/Scratchpad retained; the 161 AgentLand profiles become `.pi/agents/*.md`; group-join replaces manual aggregation; **unlocks multi-provider/GPT Teams** (today a GPT panel forces Claude until Team is on pi); audit `toolChoice` reliance (B4). Depends on Phase 5.
- **US-025 (btw):** ephemeral pi session (`SessionManager.inMemory()`), single turn, shares context.
- **US-029 (remove Recall):** delete the Recall context strategy outright (D20). Remove the `recall/` module (the REPL loop + BM25/auto-orientation, the task-node system + `NodeManager`, per-node JSONL, and the `recall-loop`/`haiku-query`/`sub-call-handler` SDK `loadSdkQuery` sites), the recall webview surfaces (node chip, Session Node Overlay, Node Context tab, recall context-strategy dropdowns), and the `damocles.contextStrategy`/`recallSubcallModel`/`recallMaxIterations` config. Closes recall's last SDK dependency ahead of US-027; optional restore via the third-party `context-mode` extension (§9, rec. 5). **Gates US-027.**
- **US-027 (cleanup):** delete all `@anthropic-ai/claude-agent-sdk` imports + dropped-subsystem code + the web-access opt-in + the explore proxy; final Code Reviewer pass asserts a clean tree. Depends on US-024/US-025/US-029 (and US-019) having removed every remaining `createSdkMcpServer`/`loadSdkQuery` site.

---

## 8. Section-by-section ROADMAP edits (beyond §9 phases above)

- **§2 Decisions:** add D15–D19; note that native web (US-028) supersedes the US-003 opt-in install, and that Explore/Team are replaced by the subagent engine (not separately reimplemented).
- **§3 Architecture diagram:** clarify `before_agent_start` = per-prompt memory/compass + plan-mode; add the `eventBus → loader` wire; add boxes for the native MCP client, native web tools, and the shared subagent engine.
- **§4 Blockers:** extend **B2** externals to include `@modelcontextprotocol/sdk` (dynamic-import + resolution smoke test).
- **§5 Tool table:** WebSearch/WebFetch → "native (lifted), Damocles names, no `PI_TOOL_NAME_MAP`"; add `code_search` (read-only); `Agent`/`get_subagent_result`/`steer_subagent` → native subagent tools; add an MCP-tools row (external tools via the native client, centrally gated).
- **§6 Deletions:** add `pi-session/web-access.ts` + the opt-in install/remove in `pi-runtime.ts:165–238`; the `explore/` proxy + `agent-runner.ts` SDK path; `team/agent-runner.ts` SDK path; `memory/subcall-runner.ts` + `query-expansion.ts` SDK paths; the entire `recall/` module + its webview surfaces and config (US-029).
- **§7 FRs:** add FR-18–22.
- **§8 Seam:** fix the thinking-`off` note; point the MCP seam methods + `teamService`/`emitExploreHistory` at the native implementations.
- **§11 Execution:** re-sequence to 9 phases (below).
- **§12 Verification:** add per-phase tests — SDK-import-free assertion after US-006/006b; MCP reference-server (stdio + HTTP) test; web-tools provider-mock + graceful-degradation test; subagent parallel/chain + nested-permission-gate test; capability-classification test; FR-17 parity incl. subagent prompts.
- **§13–14 Decisions:** update D2 (MCP = native lift), D6 (web = native lift, opt-in removed), D9 (worktree _tools_ dropped ≠ subagent `isolation: worktree`); append D15–D19.

**§11 re-sequence (9 phases):**

- Step 4 → Phase 3 (US-006, US-006b, US-005, US-007, US-008).
- Step 5 → Phase 4 (US-010 → US-012 → US-013).
- Step 6 → Phase 5 (native subagents; unlocks Explore + Team).
- Step 7 → Phase 6 (native MCP).
- Step 8 → Phase 7 (native web). _Phases 6 and 7 share no files — parallelizable if staffed._
- Step 9 → Phase 8 (US-022 → parallel US-021, US-015/016, US-011, US-023).
- Step 10 → Phase 9 (US-024 [needs Phase 5], US-025, US-029 [remove recall]).
- Step 11 → US-027 cleanup + final review.
- Agents: Backend Architect on the three lifts + US-006/006b/011; Security Engineer on US-021/022/026 + FR-2/3/13/17 + MCP-OAuth + SecretStorage; Frontend on the Extensions panel, MCP/web tool cards, subagent transcript surfacing.

---

## 9. Recommendations / opportunities (add as a ROADMAP note)

1. **One engine for Agent + Team + Explore** — collapses three SDK-coupled subsystems into one in-process primitive (the largest simplification after the openai-bridge deletion).
2. **Unify agent definitions** — AgentLand's 161 profiles and user subagents both become `.pi/agents/*.md`; one user-extensible format.
3. **Capability-tiering via a `ctx.ui` interception shim** (extends the US-026 context) — makes the open marketplace usable in a webview by badging TUI-only extensions instead of silently breaking.
4. **MCP OAuth + sampling/elicitation** (already in `pi-mcp-adapter`) as a deferred, flagged tier — enables hosted/authenticated MCP servers; route sampling→Damocles LLM, elicitation→`QuestionManager`.
5. **Optional marketplace restore of removed capabilities** — `pi-lens` (LSP feedback), `context-mode` (context savings) let users opt back into the recall removed by US-029 (and LSP) without Damocles owning the code. User-facing option, not a committed story.
6. **Implementation gotchas to document:** B4 batch-terminate (single-tool turns for structured output); `settingsManager.flush()` durability boundaries; SecretStorage for all provider keys.

---

## 10. Critical files

- **Edited by implementation:** `C:\GameDev\damocles\ROADMAP.md` (only).
- **Lift sources (read, not edited now):** the three repos in §2.
- **Integration points the rewritten stories reference:** `src/extension/pi-session/{pi-runtime,pi-session,damocles-extension,tool-normalization,web-access}.ts`; `src/extension/{memory,compass,browser,team,explore}/`; `memory/{subcall-runner,query-expansion}.ts`; `chat-panel/settings-manager/managers/mcp-manager.ts`; `src/shared/tool-names.ts`; `esbuild.config.mjs`; webview `McpStatusPanel.vue`/`ToolsStatusPanel.vue`/`ToolCallCard.vue`.

## 11. Verification (that the rewritten roadmap is sound and complete)

- The "delete the SDK" claim (US-027) is traceable end-to-end: US-006 + US-006b removed the memory/compass/browser `createSdkMcpServer` and memory `loadSdkQuery` sites on the pi path (Phase 3, landed); the remaining sites are owned by US-024 (team), US-019 (explore), US-025 (btw), and US-029 (recall removed) — so no `createSdkMcpServer`/`loadSdkQuery` site is orphaned when US-027 runs.
- Corrections present: thinking-`off` fixed; injection documented as `before_agent_start`; `systemPromptOverride` wired; `eventBus` wired; B1 re-flush on every marketplace/MCP op.
- Each lift story names its source, the Damocles system it reuses (not forks), the bundling/ESM rule, and a test.
- No contradictions with locked decisions (no community-package runtime deps; scheduler excluded; cookie-scraping dropped; bidirectional publishing absent; webview contract unchanged except the explicitly-flagged additive transcript-viewer option).

## 12. Open questions

None blocking. One implementation-time verification (already captured as a §3 rule): confirm `unpdf`/`pdfjs-dist` (WASM) and `linkedom` bundle under the CJS esbuild build; if not, externalize them like `sql.js-fts5`/`web-tree-sitter`.
