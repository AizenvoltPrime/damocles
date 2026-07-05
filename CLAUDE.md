# CLAUDE.md

## Project Overview

Damocles is a VS Code extension that embeds an AI coding agent (Claude and GPT) in a Vue webview: chat with diff approval, tool visualization, session management, checkpoints/rewind, persistent memory, subagents, MCP, Compass, a CDP browser, teams, and voice. The agent runs on the **pi** runtime (`@earendil-works/pi-coding-agent`) — the sole backend.

## Development Commands

```bash
npm run build         # Build extension + webview
npm run dev           # Watch mode
npm run typecheck     # Type checking
npm run lint          # Lint
npm test              # Vitest (whole repo)
npm run package       # Package for distribution
npm run generate:profiles  # Regenerate the team agent-profile catalog (commit the output)
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

- **Seam:** the webview message contract (`ExtensionToWebviewMessage`) is fixed; `PiSession` is its only producer. The interface lives in `src/extension/chat-session.ts`.
- **Extension:** esbuild → `dist/extension.js` (CJS). Externals are the single-source list in `scripts/extension-externals.mjs` (pi packages, MCP SDK, `node:sqlite`, `zod`, `web-tree-sitter`, `@vscode/ripgrep`, `jiti`, `typebox`, …); `scripts/sync-vscodeignore.mjs` derives the VSIX node_modules allowlist from it (via the `vscode:prepublish` hook).
- **Webview:** Vite → `dist/webview/` (ESM). shadcn-vue + Tailwind + Shiki.
- **Type aliases:** `@shared/*` → `src/shared/*`, `@/*` → `src/webview/*`.

### Key Modules

| Module                | Purpose                                                                                                                    |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `pi-session/`         | The agent backend. `PiSession` (implements `ChatSession`), the process-global `PiRuntime` (provider registration, 3-mode Claude auth, pi-native OpenAI, `custom-providers.ts` for native StepFun/DeepSeek/OpenRouter/Gemini wiring from SecretStorage keys). Catalog models carry an optional `piProvider` (`stepfun`/`deepseek`); `resolvePiModel` routes them and unauthed selections raise a "Sign in to {provider}" toast. Subdirs: `tools/` (CC-shaped `Edit`/`PowerShell`/`Task*`/`AskUserQuestion`/plan tools + re-wrapped memory/compass/browser/team module tools + native web tools), `session-store/` (tree-JSONL sessions, titles, rename/tag/delete, rewind, original-input + mid-stream sidecars), `checkpoints/` (per-session bare-git shadow repo: checkpoint/rewind/fork), `subagents/` (native nested agents: `Agent`/`GetSubagentResult`/`SteerSubagent`), `mcp/` (native MCP client), `web-access/` (native key-free web tools), `hooks/` (config-driven `.damocles/hooks.json` runner: native snake_case JSON stdin/stdout contract, `tool_call`/`tool_result`/`input`/lifecycle events; PreToolUse runs inside the permission gate). `pi-stream-adapter.ts` + `tool-normalization.ts` map pi events onto the unchanged webview shapes. |
| `chat-panel/`         | Webview management: panel, session manager, settings, message routing, history                                            |
| `permission-handler/` | Tool permissions via domain managers (approval, question, plan, skill, subagent)                                           |
| `memory/`             | Kind/scope memory + fact graph, auto-extraction, `node:sqlite`/FTS5 (WAL), pull-first catalog                              |
| `compass/`            | Knowledge graph: tree-sitter → SQLite → Louvain → MCP tools (disabled by default)                                         |
| `browser/`            | Integrated CDP browser + MCP tools (disabled by default)                                                                   |
| `team/`               | Multi-agent teams via MessageBus + Scratchpad (disabled by default). `create_team` requires a `brief` (authoritative intent; `title` is a ≤200-char label) seeded verbatim into the immutable `mission-brief` scratchpad section before any spawn; the lead is read-gated on it (`review-gate.ts`). Brief conflicts (`team_flag_brief_conflict`/`team_resolve_brief_conflict`) can't be silently dropped: synthesis is gated + `synthesizeResult` prepends a fail-loud block on any completion path + bounded lead re-nudge (`team-runner.ts`), none of which extend keep-alive. Model/thinking policy in `pi-session/team-model-resolution.ts`: on Anthropic every agent is forced to Opus 4.8 with fixed thinking (lead/reviewer xhigh, implementor high); the `kind` spawn param sets thinking depth only. Per-agent tokens accumulate lifetime (`agent-runner.ts`, via `subagents/usage.ts`). Other backends unchanged. |
| `voice/`              | STT via Whisper/Deepgram/Google Cloud + on-device Jarvis sidecar (disabled by default)                                     |
| `paths.ts`            | Root-level shared filesystem path constants (`~/.damocles` home, top-level `plans`/`explores` dirs, `workspaceHash`) plus the deterministic per-session plan-file path (`computePlanFilePath` → `<slug>-<id8>.md`, `findSessionPlanFiles`, `isPlanFilePath`). Credential & provider auth live in `pi-session/` (`subscription.ts`, `openai-auth.ts`, `agent-dir.ts`, MCP auth flows) |
| `asset-sources.ts`    | Root-level compat asset sourcing: `.claude` + `.codex` skill/command folder specs (`compatSources`) ordered by `damocles.assetSourcePrecedence`. Iterated identically by the pi resource loader and the webview `SlashCommandService` so the agent's resources and the slash-command menu never desync |

### Patterns

- **Facade + DI:** Each module has `index.ts`; managers receive deps via constructor.
- **Two-phase lazy init:** Constructor reads config; `ensureInitialized()` defers heavy work to first access (Memory, Compass).
- **Message routing:** Domain-handler registries — `message-router/handlers/` (extension), `message-handler/handlers/` (webview).

### Invariants

- pi is the only agent engine; new sessions always construct `PiSession` — there is no harness selection.
- Don't change the webview message contract to add a feature — map pi events to existing shapes via `pi-stream-adapter.ts` / `tool-normalization.ts`.
- `Edit` cannot create files (empty `old_string` throws); `Write` is the only creation path.
- All tool calls route through the central permission gate (`permission-gate.ts`): read auto-allowed, write/shell → diff approval. Plan mode blocks native `Bash`/`PowerShell` and non-plan-file `Edit`/`Write`; the sole write carve-out is `Edit`/`Write` to the session plan file (`isPlanFilePath`), auto-allowed by `EvaluatorManager`. All enabled MCP tools stay available in plan mode and follow normal-mode rules (read-only ones auto-allow via the read branch; non-read ones auto-allow via `canUseTool`). MCP has no settings-deny path — `EvaluatorManager.evaluate` short-circuits `mcp__` → `allow` before pattern matching — so the master + per-server enable/disable toggle is the only MCP control surface.
- The on-disk plan file is the single source of truth for plan-mode handoff. `ExitPlanMode` takes no `plan` argument; approval, persistence, and the clear-context continuation all read the full plan via `ChatSession.getPlanContent()` (located by the stable `-<id8>` suffix). Approval is blocked when no plan file exists, so no summary/empty plan is ever persisted.
- Plan-mode guidance has one source: `pi-session/plan-mode-guidance.ts` (`buildPlanModeGuidance(planFilePath?, { teamEnabled })`), consumed by both `agent-start.ts` (turn starts in plan mode) and `tools/plan-mode-tools.ts` (`EnterPlanMode` mid-turn). Edit the builder, not the call sites, so both paths stay identical. It mandates **vertical-slice** decomposition and branches the implementation-phase directive on `teamEnabled` (team-per-slice vs sequential slices); thread the flag from both call sites.
- Plan mode is deterministically funneled through `ExitPlanMode` (`PiSession.tryPlanModeHold` in the `agent_end` coordinator): a clean-`stop` plan-mode turn with no non-error `ExitPlanMode` result re-injects a hidden nudge follow-up (`triggerTurn`) and holds the turn; approved-exit detection reads the turn's own messages, not the racy mode flip. Unbounded by design — Stop or leaving plan mode breaks it. Both this hold and the background keep-alive call `CheckpointService.deferNextFinalize()` so a held continuation keeps its single pending checkpoint (one logical turn → one rewind entry); correctness relies on the keep-alive `agent_end` hook being registered before the checkpoint `agent_end` hook in `damocles-extension.ts`.
- The Damocles system prompt has one assembler: `agent-start.ts` (`assembleDamoclesSystemPrompt`), called by both the turn path and the `/context` preview (`buildEffectiveSystemPrompt`). Never read `session.systemPrompt` for display — pi populates that mutable field only during a turn; otherwise it holds pi's boilerplate.
- A slash command's typed input is persisted as a `damocles-original-input` sidecar (`session-store/original-input.ts`) keyed to the pi user entry when the stored (expanded) text diverges; all read paths restore it via `extractOriginalInputs`. Forward-only.
- A delivered mid-stream queued batch is recorded as a `damocles-mid-stream` sidecar (`session-store/mid-stream.ts`) so reload restores the amber "sent mid-stream" styling (webview reuses `isCombinedQueue`). The marker is keyed at the next assistant `message_start` (where pi has committed the steered user entry) — not at the user `message_end` delivery, where `lastUserEntry` would still resolve the previous turn's entry. Same boundary the checkpoint engine uses. Forward-only.
- Hooks are config-only (`~/.damocles/hooks.json` + trusted-workspace `.damocles/hooks.json`); blocking requires JSON on stdout (`{"decision":"deny"}`), never an exit code. A `tool_call` hook can deny, rewrite, or **force-allow** a tool past the gate AND plan mode — by design, bounded by workspace trust, logged + surfaced in chat.
- Internal sub-calls (memory, structured output) use `PiRuntime.runStructuredCompletion` + the terminating-tool idiom (no `toolChoice` — subscription OAuth can't force tools).
- Never mutate `process.env` for per-session config; pi reads a Damocles-owned `agentDir` (`~/.damocles/pi/agent`).
- Implementation gotchas live in the code and in memory observations — search those before assuming.

## Permission Modes

| Mode          | Behavior                                                                |
| ------------- | ----------------------------------------------------------------------- |
| `plan`        | Blocks native Bash/PowerShell and non-plan-file Edit/Write; enabled MCP tools stay available |
| `default`     | Shows diff for Edit/Write, prompts Bash/PowerShell                      |
| `acceptEdits` | Auto-approves Edit/Write, prompts Bash/PowerShell                       |

Read-only tools are auto-approved in all modes. `dangerouslySkipPermissions` (YOLO) auto-approves everything.

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
