# Plan: Route Monitor tool through in-webview permission flow

## 1. Context / Overview

### The bug

In Damocles (a VS Code extension that wraps the Claude Agent SDK), when Claude calls the `Monitor` tool — a built-in harness tool that runs a shell command and streams events for the lifetime of a background process — the permission request bubbles up to a generic VS Code modal:

> "Claude wants to use the \"Monitor\" tool. Allow?" — [Allow] [Deny] [Cancel]

This breaks the user's flow because every other command-bearing tool (`Bash`, `PowerShell`) renders an in-webview approval card inline in the chat panel, with the command preview and an "Always allow `Tool(<cmd>:*)`" allowlist option.

### The root cause

`PermissionHandler.canUseTool` in `src/extension/permission-handler/index.ts` routes tools to domain-specific handlers in this order (lines 132-184):

1. `TOOL_EXIT_PLAN_MODE` (when `permissionMode === 'plan'`) → `planManager`
2. `TOOL_ASK_USER_QUESTION` → `questionManager`
3. evaluator pass (auto-allow / auto-deny based on `.claude/settings*.json` rules)
4. `TOOL_EDIT` / `TOOL_WRITE` → `approvalManager.handleFilePermission` (in-webview diff card)
5. `isShellTool(toolName)` → `approvalManager.handleShellPermission` (in-webview command card)
6. `TOOL_SKILL` → `skillManager`
7. **Fallback:** `vscode.window.showInformationMessage(... { modal: true })` ← **the popup the user sees**

`isShellTool` at `src/shared/tool-names.ts:41` returns `SHELL_TOOLS.has(name)`. The set is `new Set([TOOL_BASH, TOOL_POWERSHELL])`. `Monitor` is not in it, so it falls all the way to step 7.

### Why this fix isn't a bandaid

The `SHELL_TOOLS` set's role across the codebase is "tools that take a `command` string and need command-style permission UX". Every consumer treats it that way:

- `permission-handler/index.ts:159` — routes to in-webview command card.
- `approval-manager.ts:16` — generates `Tool(<firstWord>:*)` allowlist suggestions.
- `evaluator-manager.ts:109` — uses `matchShellSpecifier` (handles `cmd:*`, `cmd *`, exact match) for pattern-based allow/deny rules.
- `PermissionPrompt.vue:42` — picks the "Run command" label.
- `TeamPermissionPrompt.vue:21` — surfaces `command` in team-spawned permission prompts.
- `ToolOverlay.vue:75, 254` — extracts `description` for the overlay header and renders command preview.

`Monitor`'s tool-input shape is `{ command: string; description: string; persistent: boolean; timeout_ms: number }` — it carries the same `command` field as Bash/PowerShell. Treating it as a member of `SHELL_TOOLS` is semantically correct: every consumer already knows what to do with a command-bearing tool. No special-casing, no duplicated handler, no bandaid logic.

The alternative — renaming `SHELL_TOOLS` to `COMMAND_TOOLS` for naming purity — would be a semantic refactor across tests, settings, UI, evaluator without changing runtime behavior. That is over-engineering for this fix and is rejected as scope creep. The current name `SHELL_TOOLS` is acceptable because Monitor literally runs a shell command; only its lifetime semantics differ.

### The user's chosen behavior

When a Monitor invocation matches an existing allow rule (e.g., `Monitor(npm:*)` in `.claude/settings.local.json`), it auto-approves silently — no card, no popup. Otherwise it presents the standard in-webview approval card with an "Always allow `Monitor(<firstWord>:*)`" option that, if chosen, persists a rule for future calls.

### Intended outcome

The VS Code modal "Claude wants to use the \"Monitor\" tool. Allow?" never appears for Monitor again. Monitor uses the exact same Allow/Deny + allowlist UX as Bash/PowerShell. Existing infrastructure (`MonitorCard.vue`, `useMonitorStore.ts`, monitor-event streaming) is untouched and continues to render the live status post-approval.

### SDK audit (no missing modules)

The Claude Agent SDK is at `0.2.133` (`node_modules/@anthropic-ai/claude-agent-sdk/package.json`). The SDK's static `ToolInputSchemas` covers Bash, Read, Write, Edit, Glob, Grep, WebSearch, WebFetch, Agent, ExitPlanMode, AskUserQuestion, EnterWorktree, ExitWorktree, NotebookEdit, TodoWrite, TaskStop, TaskOutput, ListMcpResources, Mcp, ReadMcpResource. Tools used by Damocles that are NOT in the SDK's static schemas (registered manually in `src/shared/tool-names.ts`) include `Monitor`, `PowerShell`, `Skill`, `TaskCreate`, `TaskUpdate`, `TaskList`, `TaskGet`, `CronCreate`, `CronDelete`, `CronList`, `TodoRead`, `LSP`, `ToolSearch`. All necessary display, store, and event-streaming infrastructure for Monitor already exists:

- `src/webview/components/MonitorCard.vue` — full status card (starting / monitoring / completed / failed / stopped, persistent badge, event count, elapsed timer).
- `src/webview/components/ToolCallRouter.vue:63` — routes `Monitor` tool calls to `MonitorCard`.
- `src/webview/stores/useMonitorStore.ts` — tracks monitor state by `toolUseId`.
- `src/extension/claude-session/streaming-manager/processors/user-processor.ts` — parses `<task-id>`/`<event>`/`<summary>` XML and emits `monitorEvent` messages.
- `src/extension/claude-session/utils.ts` (lines 124-150) — extracts Monitor input/output for tool metadata.
- `src/webview/components/ToolOverlay.vue:5,89` — already imports `TOOL_MONITOR` and special-cases it in `effectiveStatus` to read from the monitor store.

**Conclusion:** no new modules need to be added. The only missing wiring is the permission-routing step.

## 2. Goals

- The VS Code `showInformationMessage` modal never appears for Monitor.
- Monitor uses the existing `PermissionPrompt.vue` in-webview card — no new card components or new managers.
- Allowlist rules of form `Monitor(<cmd>:*)` are honoured by the evaluator (auto-approve when matching) and produced by `generatePatternSuggestions` (offered as "Always allow" option in the prompt).
- Bash, PowerShell, Edit, Write, Skill, EnterPlanMode, ExitPlanMode, AskUserQuestion permission flows are unchanged.
- `MonitorCard.vue` post-approval display continues to function identically.
- Type-safety is preserved end-to-end (no `as any`, no `@ts-ignore`).

## 3. User Stories

### US-001: Monitor permission flows in-webview with allowlist support

**Description:** As a Damocles user, I want Monitor permission prompts to appear inside the chat panel exactly like Bash, so approving / denying / allowlisting Monitor doesn't break my flow with a VS Code system modal.

**Acceptance Criteria:**

- [ ] Triggering Monitor with a command not covered by any settings rule renders the in-webview `PermissionPrompt` showing the command, "Run command" action label, and three options: Yes / Yes-and-accept-all / Always allow `Monitor(<firstWord>:*)` / No.
- [ ] Selecting "Always allow `Monitor(<firstWord>:*)`" persists the rule via the `addRules` permission update to `.claude/settings.local.json` (default destination).
- [ ] After persisting an allow rule, the next Monitor call whose `command` starts with that prefix auto-approves: no prompt is shown, no modal is shown, and the call proceeds straight to the `MonitorCard` display.
- [ ] A pre-existing deny rule (e.g., `Monitor(rm:*)`) blocks the call without prompting.
- [ ] Selecting "No" (or denying) blocks the Monitor call with the same "User rejected the shell command" message used for Bash.
- [ ] The VS Code system modal `Claude wants to use the "Monitor" tool. Allow?` never appears.
- [ ] After approval, `MonitorCard.vue` renders the live status (starting → monitoring → completed/failed/stopped) and the event counter increments as `monitorEvent` messages arrive — i.e., the existing post-approval flow is preserved.
- [ ] Bash and PowerShell prompts render and function identically to before the change (no regression).
- [ ] `Monitor` permission requests issued from inside a team specialist render via `TeamPermissionPrompt.vue` with the team-flavored UI; selecting Allow/Deny resolves correctly through the team approval pipeline.
- [ ] `npm run typecheck`, `npm run lint`, and `npm run build` all pass.

## 4. Functional Requirements

- **FR-1** `isShellTool("Monitor")` returns `true`. Achieved by adding `TOOL_MONITOR` to the `SHELL_TOOLS` set in `src/shared/tool-names.ts`.
- **FR-2** The `ShellToolName` type alias in `src/shared/tool-names.ts` includes `"Monitor"` so `handleShellPermission(toolName: ShellToolName, …)` accepts Monitor without casts.
- **FR-3** The `requestPermission` discriminated-union member in `src/shared/types/messages.ts` accepts `toolName: "Monitor"`. Currently this field inlines the literal union `"Write" | "Edit" | "Bash" | "PowerShell"` (line 256). It must be widened so postMessage payloads carrying `toolName: "Monitor"` are type-safe.
- **FR-4** No changes to `MonitorCard.vue`, `useMonitorStore.ts`, monitor-event processors, or `ToolCallRouter.vue` — these already render Monitor correctly post-approval.
- **FR-5** No changes to the evaluator's pattern-matching logic. Once `SHELL_TOOLS.has("Monitor") === true`, `evaluator-manager.ts:109` automatically routes `Monitor(<spec>)` patterns to `matchShellSpecifier` (which already supports `cmd:*`, `cmd *`, and exact match).
- **FR-6** No changes to `generatePatternSuggestions` in `approval-manager.ts:15-28`. Once `SHELL_TOOLS.has("Monitor") === true`, it automatically generates `{toolName: 'Monitor', ruleContent: '<firstWord>:*'}` suggestions.
- **FR-7** Permission settings file format is unchanged: existing rule strings such as `Monitor(npm:*)` already parse correctly (the parser at `evaluator-manager.ts:102` is generic — `^(\w+)(?:\((.+)\))?$` — and only consults `SHELL_TOOLS` when deciding which specifier-matcher to use).

## 5. Non-Goals

- Do NOT introduce a dedicated permission manager class for Monitor (e.g., `MonitorManager`). The shell flow handles it.
- Do NOT auto-approve Monitor unconditionally. Only auto-approve when a matching allow rule exists. (This falls out for free from the evaluator.)
- Do NOT add Monitor to `READ_ONLY_TOOLS`. Monitor runs arbitrary shell commands and is not read-only.
- Do NOT change `MonitorCard.vue` rendering, status states, monitor store schema, or event-stream processing.
- Do NOT modify `ToolCallRouter.vue` — Monitor routing to `MonitorCard` is already correct.
- Do NOT rename `SHELL_TOOLS` to `COMMAND_TOOLS` or refactor the type alias name. Considered and rejected as scope creep — the existing name is semantically acceptable since Monitor runs a shell command.
- Do NOT bump the SDK version or pull new modules. Audit confirmed nothing is missing.
- Do NOT introduce backwards-compatibility shims, fallback logic, or feature flags. The change is a direct semantic widening.

## 6. Technical Considerations

### Files to modify

#### `src/shared/tool-names.ts`

Two edits:

- Line 38 — `export const SHELL_TOOLS: Set<string> = new Set([TOOL_BASH, TOOL_POWERSHELL]);`
  Change to: `new Set([TOOL_BASH, TOOL_POWERSHELL, TOOL_MONITOR]);`
- Line 40 — `export type ShellToolName = "Bash" | "PowerShell";`
  Change to: `export type ShellToolName = "Bash" | "PowerShell" | "Monitor";`

#### `src/shared/types/messages.ts`

One edit:

- Line 256 (within the `requestPermission` discriminated-union member):
  `toolName: "Write" | "Edit" | "Bash" | "PowerShell";`
  Change to: `toolName: "Write" | "Edit" | "Bash" | "PowerShell" | "Monitor";`

This is mandatory: without it, the postMessage call at `approval-manager.ts:208-218` (which passes `toolName` of type `ShellToolName`) becomes a TypeScript error once `ShellToolName` includes `"Monitor"`.

### Files NOT modified — verified safe

| File | Why no change is needed |
| --- | --- |
| `src/extension/permission-handler/index.ts` | `isShellTool(toolName)` at line 159 automatically returns `true` for Monitor once `SHELL_TOOLS` is widened, routing to `handleShellPermission`. |
| `src/extension/permission-handler/managers/approval-manager.ts` | `SHELL_TOOLS.has(toolName)` at line 16 (allowlist suggestion generator) automatically returns `true`. `handleShellPermission` accepts the widened `ShellToolName`. |
| `src/extension/permission-handler/managers/evaluator-manager.ts` | `SHELL_TOOLS.has(toolName)` at line 109 automatically returns `true`, dispatching to `matchShellSpecifier`. |
| `src/webview/components/PermissionPrompt.vue` | `isShellTool(props.toolName)` at line 42 automatically returns `true`, picking the "Run command" label. |
| `src/webview/components/TeamPermissionPrompt.vue` | `isShellTool(toolName)` at line 21 automatically returns `true`, surfacing `command` for team-spawned Monitor calls. |
| `src/webview/components/ToolOverlay.vue` | Already imports `TOOL_MONITOR` (line 5) and special-cases it at line 89 (`effectiveStatus` reads from monitor store). `isShellTool` checks at lines 75 and 254 produce correct behavior for Monitor automatically. |
| `src/webview/components/ToolCallRouter.vue` | Already routes Monitor to `MonitorCard` at line 63. Permission prompt rendering is a separate concern (handled by `App.vue` / `ToolOverlay.vue`). |
| `src/webview/components/MonitorCard.vue` | Display-only, post-approval. Unrelated to permission flow. |
| `src/webview/composables/message-handler/handlers/permission-handlers.ts` | Routes `requestPermission` messages by string `toolName`. Generic — picks up Monitor automatically. |
| `src/extension/claude-settings.ts` | Generic JSON parser; does not enumerate tool names. |

### Reused functions / patterns

- `ApprovalManager.handleShellPermission` at `src/extension/permission-handler/managers/approval-manager.ts:67` — issues a `requestPermission` postMessage to the webview, awaits a resolution via `state.pendingApprovals`, returns allow/deny with optional `updatedPermissions`. Reused unchanged.
- `generatePatternSuggestions` at `src/extension/permission-handler/managers/approval-manager.ts:15` — produces `[{type: 'addRules', rules: [{toolName, ruleContent: \`${firstWord}:*\`}], behavior: 'allow', destination: 'localSettings'}]`. Reused unchanged — once `SHELL_TOOLS` includes Monitor, it generates Monitor-flavoured suggestions.
- `EvaluatorManager.matchShellSpecifier` at `src/extension/permission-handler/managers/evaluator-manager.ts:118` — supports `cmd:*` (prefix), `cmd *` (word boundary), exact match. Reused unchanged.
- `PermissionPrompt.vue` — Bash-style approve/deny prompt with "Always allow" option. Reused unchanged.

### Type-safety verification

After the three edits:

- `npm run typecheck` must pass clean. The `requestPermission` postMessage in `approval-manager.ts` will only typecheck after `messages.ts:256` is widened.
- No `as any` / `@ts-ignore` should be introduced anywhere.
- The function `isShellTool` is declared as a type-narrowing predicate (`name is ShellToolName`); its narrowing will now include `"Monitor"`.

### Test coverage

A repo-wide grep for `isShellTool`, `SHELL_TOOLS`, `TOOL_MONITOR`, and the literal `Monitor` across `src/**/__tests__/**` returned no matches — there are no existing unit tests asserting on shell-tool sets. No test files require updates. (If a future test wants to assert Monitor is in `SHELL_TOOLS`, that's an additive enhancement beyond this scope.)

### Performance and security

- Zero additional IPC round-trips, no extra evaluation passes.
- Existing security posture preserved: Monitor still requires an explicit user-opted-in allow rule (or per-call approval via the prompt) before auto-approving. No tool input is auto-trusted.
- The change does not affect `dangerouslySkipPermissions` (already auto-allows everything in the evaluator at line 34) or the `mcp__` short-circuit (line 38) — Monitor isn't MCP-prefixed.
- Plan permission mode behavior: Monitor inherits Bash/PowerShell behavior (always prompts in `plan` mode; `acceptEdits` mode does not auto-approve Monitor since the evaluator's `acceptEdits` branch only auto-allows EDIT/WRITE).

### Dependencies between requirements

None. The three edits in two files are independent enough that they can be made in any order, but `messages.ts:256` widening must happen before or together with `tool-names.ts:40` to keep the build green at every commit.

## 7. Execution Strategy

This change is intentionally small (three edits across two files). One sequential step is sufficient.

### Step 1 (sequential): US-001 — Widen Monitor classification → Frontend Developer

**Why this agent:** The change touches a shared types file consumed by both the extension host (TypeScript / Node) and the webview (Vue 3 / TypeScript). A Frontend Developer agent owns the responsibility of ensuring both sides typecheck and that the in-webview UI renders the prompt and resolves the message correctly. No backend, database, security, or build-system work is required.

**Context handoff for the agent (everything below is sufficient — no need to read prior conversation):**

- **Goal:** When Claude calls the `Monitor` tool, the in-webview `PermissionPrompt.vue` card must render exactly like it does for Bash, with allowlist suggestion `Monitor(<firstWord>:*)`. The current bug is that `Monitor` falls through to a VS Code system modal `vscode.window.showInformationMessage`. Root cause: `Monitor` is not in `SHELL_TOOLS` so `isShellTool("Monitor") === false` and the shell-permission router branch is skipped at `src/extension/permission-handler/index.ts:159`.

- **Edits — primary, in `src/shared/tool-names.ts`:**
  - Line 38: add `TOOL_MONITOR` to the `SHELL_TOOLS` set.
  - Line 40: widen `ShellToolName` to `"Bash" | "PowerShell" | "Monitor"`.

- **Edits — required, in `src/shared/types/messages.ts`:**
  - Line 256 (inside the `requestPermission` discriminated-union variant): widen `toolName` from `"Write" | "Edit" | "Bash" | "PowerShell"` to `"Write" | "Edit" | "Bash" | "PowerShell" | "Monitor"`.

- **No other edits.** Specifically do NOT modify: `MonitorCard.vue`, `useMonitorStore.ts`, `user-processor.ts`, `ToolCallRouter.vue`, `permission-handler/index.ts`, `approval-manager.ts`, `evaluator-manager.ts`, `PermissionPrompt.vue`, `TeamPermissionPrompt.vue`, or `ToolOverlay.vue`. They all consume `SHELL_TOOLS` / `isShellTool` / `ShellToolName` generically and pick up the change automatically.

- **Patterns to follow:** This is a direct mirror of the existing PowerShell parity precedent — PowerShell is in `SHELL_TOOLS`, `ShellToolName`, and `messages.ts:256`'s union, and inherits Bash's full permission UX without any dedicated handler. Apply the exact same treatment to Monitor.

- **Constraints:**
  - No fallback logic, no backwards-compat shims, no `as any`, no `@ts-ignore`.
  - Do not auto-approve Monitor unconditionally. The auto-approve-on-allow-rule behavior must come from the existing evaluator (`evaluator-manager.ts:matchAgainstPatterns`), not from a special case.
  - Do not change the SDK version or add new modules.
  - Do not refactor `SHELL_TOOLS` to `COMMAND_TOOLS` — out of scope.

- **Verification — automated:**
  ```bash
  npm run typecheck
  npm run lint
  npm run build
  ```
  All three must succeed.

- **Verification — manual end-to-end (requires F5 Extension Development Host):**

  1. **No-rule prompt path:**
     - Ensure `~/.damocles/auth/.claude/settings.local.json` has no `Monitor` rule.
     - In a chat session, ask Claude to use the Monitor tool with a fresh command (e.g., `command: "node script.js"`).
     - Confirm: in-webview `PermissionPrompt` card appears in the chat panel — NOT a VS Code system modal popup.
     - Confirm: prompt shows the command and an "Always allow `Monitor(node:*)`" option.

  2. **Allowlist persistence path:**
     - In the prompt above, choose "Always allow `Monitor(node:*)`".
     - Confirm: `~/.damocles/auth/.claude/settings.local.json` now contains `Monitor(node:*)` under the `allow` array.
     - Confirm: subsequent Monitor calls with `command` starting `node ` proceed without any prompt.

  3. **Pre-existing allow rule auto-approves silently:**
     - With `Monitor(node:*)` in `allow`, trigger Monitor with `node script.js`.
     - Confirm: NO prompt, NO modal — `MonitorCard` renders directly.

  4. **Pre-existing deny rule blocks silently:**
     - Add `Monitor(rm:*)` to `deny` in settings.
     - Trigger Monitor with `rm -rf /tmp/test`.
     - Confirm: blocked without prompt; tool result shows denial.

  5. **Bash/PowerShell regression check:**
     - Trigger a Bash command not in any rule.
     - Confirm: in-webview prompt still appears identically; suggestion is `Bash(<firstWord>:*)`.
     - Same for PowerShell.

  6. **Post-approval display:**
     - After approving a Monitor call, confirm `MonitorCard.vue` renders the starting → monitoring transition, the persistent badge (if `persistent: true`), event counter increments as `monitorEvent` messages arrive, and the elapsed-time timer ticks.

## 8. Open Questions

None. The user has confirmed:

- Monitor classification: treat as a member of the shell-tool family (auto-approve only when an allow rule matches; otherwise show the in-webview card).
- Allowlist support: yes, `Monitor(<cmd>:*)` patterns are offered in the plan and matched by the evaluator.

Implementation is fully scoped to the three edits described above.
