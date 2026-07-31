import type { ToolCallEvent, ToolCallEventResult, AgentEndEvent } from '@earendil-works/pi-coding-agent';
import type { PermissionHandler, CanUseToolContext } from '../permission-handler';
import type { MemoryService } from '../memory';
import type { CompassService } from '../compass';
import type { ExtensionToWebviewMessage } from '../../shared/types/messages';
import { FEEDBACK_MARKER, POLICY_BLOCK_MARKER } from '../../shared/types/constants';
import { IGNORED_TOOLS, TASK_MANAGEMENT_TOOLS, SUBAGENT_TOOLS, TOOL_EDIT, TOOL_WRITE, TOOL_BASH, TOOL_POWERSHELL } from '../../shared/tool-names';
import { isPlanFilePath } from '../paths';
import { mapPiToolName, normalizeToolInput, denormalizeToolInput, toolCategory } from './tool-normalization';
import { classifyReadOnlyShellCommand } from './readonly-shell';
import { GATEABLE_MODULE_NAMES } from './tools/tool-catalog';
import type { DeferrableSnapshot } from './tools/tool-search-tool';
import type { ToolCallHookResult } from './hooks/dispatch';

/** A non-aborting signal for gate calls when pi hands us no AbortSignal (`ctx.signal` is optional). */
const NEVER_ABORT: AbortSignal = new AbortController().signal;

/**
 * Build the `CanUseToolContext` the managers expect. `toolCallId` is pi's native, always-present id.
 * `parentToolUseId` is the spawning `Agent` tool-call id for a nested subagent call (so requestPermission /
 * permissionAutoResolved attach to the subagent card), or `null` for a primary-agent call.
 */
export function buildCanUseToolContext(
  toolCallId: string,
  signal: AbortSignal | undefined,
  parentToolUseId: string | null = null,
): CanUseToolContext {
  return { signal: signal ?? NEVER_ABORT, toolUseID: toolCallId, parentToolUseId };
}

/** Environment facts for `buildSystemPrompt` on the pi path (US-007), resolved per session. */
export interface SystemPromptEnv {
  cwd: string;
  model: string;
  isGitRepo: boolean;
  platform: string;
  shell: string;
  osVersion: string;
  compassEnabled: boolean;
}

/**
 * The per-panel state the shared Damocles extension routes to, looked up by sessionId. Beyond the
 * permission gate (`permissionHandler`/`isPlanMode`), it carries everything the `before_agent_start`
 * hook needs to assemble the Damocles system prompt (US-007) and inject memory/compass context
 * (US-005): the panel's services, its resolved session model + environment, a webview-message emitter,
 * the per-prompt index, and first-message tracking.
 */
export interface PanelGateContext {
  permissionHandler: PermissionHandler;
  isPlanMode: () => boolean;
  /** The panel's memory service, when one is wired (enabled-check is the caller's). */
  memoryService?: MemoryService;
  /** The panel's compass service, when one is wired. */
  compassService?: CompassService;
  /** The resolved session model id (per-session, model-aware system prompt). */
  getSessionModel: () => string;
  /** Environment facts for `buildSystemPrompt`. */
  getSystemPromptEnv: () => SystemPromptEnv;
  /** The session's deterministic plan-file path, named in the plan-mode system prompt so the model
   *  maintains its plan there. */
  getPlanFilePath: () => string;
  /** Whether the multi-agent Team feature is enabled — shapes the plan-mode implementation-phase
   *  directive (team-per-slice vs sequential slices). */
  isTeamEnabled?: () => boolean;
  /** Emit a webview message from a shared-extension hook (injection chips, etc.). */
  postMessage: (message: ExtensionToWebviewMessage) => void;
  /** The current 0-based user-prompt index, to key per-prompt injection messages. */
  currentPromptIndex: () => number;
  /** Called from the `agent_end` hook (awaited before the turn settles): coordinates the background
   *  keep-alive (hold the turn until subagents finish and inject their results) and the plan-mode hold
   *  (nudge the model to call ExitPlanMode if a plan-mode turn ended without it). Receives the turn's
   *  `agent_end` event so the plan-mode hold can scan its messages. */
  onAgentEnd?: (event: AgentEndEvent) => Promise<void>;
  /** Whether an `mcp__…` tool is annotated read-only (US-014.4); absent for subagents (no MCP tools). */
  isMcpReadOnly?: (piToolName: string) => boolean;
  /** This panel's deferrable universe for `ToolSearch`; absent for subagents (no deferral). */
  deferrableTools?: () => DeferrableSnapshot;
  /** Load deferred tools into this panel's active set — synchronous, called inside `ToolSearch.execute`. */
  activateDeferredTools?: (names: string[]) => void;
}

/**
 * Tools whose interaction is owned by their own `execute()` (they drive the managers directly) plus
 * the task-list tools (`TaskCreate`/`TaskUpdate`/`TaskList`/`TaskGet` — in-memory session state, never
 * a real-world side effect, so never prompted). The gate must NOT route these through `canUseTool` —
 * that would double-prompt. `IGNORED_TOOLS` already covers AskUserQuestion/Enter/Exit-PlanMode.
 */
const GATE_ALLOW_ALWAYS: ReadonlySet<string> = new Set<string>([...IGNORED_TOOLS, ...TASK_MANAGEMENT_TOOLS, ...SUBAGENT_TOOLS]);

/**
 * Ensure a deny reason renders as the existing "denied" card state rather than "failed". The webview
 * derives "denied" from a tool error containing `FEEDBACK_MARKER` (`extractUserDenialFeedback`), so we
 * guarantee the marker is present in every gate block reason (FR-9). Also reused by the ExitPlanMode
 * tool so a rejected plan renders denied + feedback.
 */
export function formatDenyReason(message: string | undefined): string {
  const base = message ?? 'Permission denied';
  if (base.includes(FEEDBACK_MARKER)) return base;
  return `The user doesn't want to proceed with this tool use. The tool use was rejected. ${FEEDBACK_MARKER} ${base}`;
}

/**
 * The counterpart for a block the runtime made on its own — a settings permission rule, plan mode, a
 * read-only agent's toolset, or a configured PreToolUse hook. Renders "denied" exactly like
 * {@link formatDenyReason}, but never claims the user rejected anything: they were not asked, and a
 * model told otherwise stops to consult a human instead of working within the constraint it hit.
 */
export function formatPolicyBlockReason(message: string | undefined): string {
  const base = message ?? 'Blocked by a permission policy';
  if (base.includes(POLICY_BLOCK_MARKER)) return base;
  return `This tool call was blocked automatically and the user was not consulted. ${POLICY_BLOCK_MARKER} ${base}`;
}

/** The slice of a panel's context the gate actually reads. `PanelGateContext` satisfies it; a nested
 *  subagent supplies the same parent handler + a parent-mode reader (inherit-parent-mode). */
export type GatePermissionContext = Pick<PanelGateContext, 'permissionHandler' | 'isPlanMode' | 'isMcpReadOnly'> & {
  /**
   * Hold this caller to read-only shell commands even outside plan mode. Set for a subagent whose
   * resolved toolset contains no write tool: denying `Edit`/`Write` while handing over an unrestricted
   * `Bash` is not a read-only agent — `echo > file`, a heredoc, `tee`, or `cp` all restore writes, and
   * under `dangerouslySkipPermissions` nothing else would stop them.
   */
  readOnlyShell?: boolean;
};

/**
 * PreToolUse hooks plugged into the single gate handler (Section 3.3). `run` executes the configured
 * `tool_call` hooks for this event (null when none match); `onDecision` raises the D6 transparency notice
 * when a hook force-allows or blocks. Built per tool-call by the extension wiring, which owns the panel's
 * webview emitter. Absent when no `tool_call` hook is configured, so the gate path stays zero-cost (FR-14).
 */
export interface PreToolUseHookGate {
  run: (event: ToolCallEvent) => Promise<ToolCallHookResult | null>;
  onDecision: (toolName: string, decision: 'allow' | 'deny', reason?: string) => void;
  /** Surface any hook `systemMessage`(s) to the user (FR-16 transparency), independent of the decision. */
  notify: (messages: readonly string[]) => void;
  /**
   * Stash a hook's `additionalContext` for delivery on the matching tool result. pi's `tool_call` return
   * can only block (not inject context), so context is carried to the PostToolUse path keyed by toolCallId.
   * Called only on a proceed path (the tool will actually run), so a blocked tool leaves no orphan entry.
   */
  stashContext: (toolCallId: string, context: string) => void;
}

/**
 * Fail-closed fallback for when the permission gate itself throws (a bug in the gate or the handler).
 * A gate that errors must NOT silently grant a state-mutating tool, so anything in the write/shell
 * category — and any unknown ('other') tool that would otherwise hit the full approval flow — is
 * blocked. Read-only tools are let through: they are auto-allowed on the normal path and cannot mutate
 * state, so blocking them would only break harmless reads on an already-degraded gate.
 */
export function gateErrorFallback(piToolName: string): ToolCallEventResult | undefined {
  if (toolCategory(mapPiToolName(piToolName)) === 'read') return undefined;
  return { block: true, reason: 'The permission system failed to evaluate this tool, so it was blocked by default for safety.' };
}

/**
 * The central permission gate: pi `tool_call` event → Damocles `PermissionHandler.canUseTool`. Runs in
 * the shared Damocles extension, routed to the right panel by sessionId. Returns a `ToolCallEventResult`
 * (`{ block, reason }`) to deny, or `undefined` to allow.
 *
 * It NEVER mutates `event.input`: native pi tools execute with their raw input (`{ path }`, not the
 * normalized `{ file_path }`), so only a normalized COPY is handed to `canUseTool`. The managers never
 * rewrite values in Phase 2, so there is nothing to propagate back.
 *
 * `parentToolUseId` is non-null for a nested subagent's tool call (inherit-parent-mode gating): it is the
 * spawning `Agent` tool-call id, threaded into the approval flow so prompts attach to the subagent card.
 */
export async function runPermissionGate(
  event: ToolCallEvent,
  panel: GatePermissionContext,
  signal: AbortSignal | undefined,
  parentToolUseId: string | null = null,
  preToolUse?: PreToolUseHookGate,
): Promise<ToolCallEventResult | undefined> {
  const damoclesName = mapPiToolName(event.toolName);
  const category = toolCategory(damoclesName);
  // Read-only-annotated MCP tools auto-allow like reads; non-read MCP tools hit full approval (US-014.4).
  const isMcp = damoclesName.startsWith('mcp__');
  const mcpReadOnly = isMcp && (panel.isMcpReadOnly?.(damoclesName) ?? false);

  // PreToolUse hooks run INSIDE the single gate handler, before the gate decides (Section 3.3). `allow`
  // skips the gate entirely (force-allow); `deny`/exit-2 blocks; `updatedInput` mutates `event.input` in
  // place (denormalized to pi's shape) so the gate + the tool both see the rewrite; `ask`/none falls
  // through. An infra failure (spawn/timeout) is fail-closed for write/shell only. All bounded to tools
  // the user wrote a hook for; both force-allow and block raise the D6 transparency notice.
  // A PreToolUse hook's `additionalContext` (when the tool will proceed) is delivered on the matching
  // tool result — pi's `tool_call` return can't inject context. Stamped on any "tool proceeds" path.
  let pendingContext: string | undefined;
  const proceed = (): undefined => {
    if (pendingContext && preToolUse) preToolUse.stashContext(event.toolCallId, pendingContext);
    return undefined;
  };

  if (preToolUse) {
    const result = await preToolUse.run(event);
    if (result) {
      if (result.systemMessages.length) preToolUse.notify(result.systemMessages);
      if (result.mutated && result.decision !== 'deny') {
        // `finalInput` is the COMPLETE rewritten input: dispatch chains each hook's `updated_input` onto a
        // copy of the original tool input, so it always carries every key. Merging it back is therefore a
        // full overwrite of the live keys — there is no "hook dropped a key but it survives" case. The
        // approval diff is built from this same rewritten input below, so the user sees exactly what runs.
        Object.assign(event.input, denormalizeToolInput(event.toolName, result.finalInput));
      }
      if (result.decision === 'deny') {
        preToolUse.onDecision(damoclesName, 'deny', result.reason);
        return { block: true, reason: formatPolicyBlockReason(result.reason ?? 'Blocked by a configured PreToolUse hook') };
      }
      if (result.additionalContext) pendingContext = result.additionalContext;
      if (result.decision === 'allow') {
        preToolUse.onDecision(damoclesName, 'allow', result.reason);
        return proceed();
      }
      if (result.anyFailed && (category === 'write' || category === 'shell')) {
        return gateErrorFallback(event.toolName);
      }
    }
  }

  const input = normalizeToolInput(event.toolName, event.input as Record<string, unknown>);

  if (GATE_ALLOW_ALWAYS.has(damoclesName)) return proceed();

  // In-process MCP module tools (memory/compass/browser, now PascalCase): auto-allow with exact SDK
  // parity — the SDK's `mcp__` rule never prompted, but a settings deny rule is still honored (FR-4).
  // Web tools are NOT here — they are in `READ_ONLY_TOOLS`, so they fall through to the read branch.
  if (GATEABLE_MODULE_NAMES.has(damoclesName)) {
    const evaluation = await panel.permissionHandler.evaluatePermission(damoclesName, input);
    return evaluation === 'deny'
      ? { block: true, reason: formatPolicyBlockReason('Permission denied by a rule in your Damocles settings') }
      : proceed();
  }

  // Plan-mode defense in depth: gate any Damocles-native write/shell the read-only active set somehow let
  // through. Shell commands are classified: a provably read-only command (git status/log/diff, ls, cat,
  // grep, …) auto-allows through the settings evaluator (never prompts); anything not positively
  // recognized as read-only is blocked with a teaching reason so the model self-corrects. The ONE write
  // carve-out is Edit/Write to the plan file (US-002): the model maintains its plan there while planning,
  // so those fall through to the normal flow where the EvaluatorManager auto-allows the plans-dir write.
  // Every other Edit/Write (and every non-read-only shell command) stays blocked. MCP tools are NOT
  // blocked here — they follow normal-mode rules (read-only ones auto-allow via the read branch below;
  // non-read ones auto-allow via canUseTool), since the user controls which servers are enabled.
  // The same classifier also serves read-only SUBAGENTS (Explore/Plan, or any agent whose toolset omits
  // every write tool): an agent denied Edit/Write must not regain writes through the shell, in any
  // permission mode. Plan mode's plan-file carve-out is plan-mode-only — a read-only subagent has no
  // plan file to maintain.
  const planMode = panel.isPlanMode();
  if ((planMode || panel.readOnlyShell === true) && (category === 'write' || category === 'shell')) {
    if (category === 'shell') {
      const command = typeof input['command'] === 'string' ? (input['command'] as string) : '';
      const shell = damoclesName === TOOL_BASH ? 'bash'
        : damoclesName === TOOL_POWERSHELL ? 'powershell'
          : null; // Monitor / future shells: never read-only
      const verdict = shell
        ? classifyReadOnlyShellCommand(shell, command)
        : { readOnly: false as const, reason: 'this shell tool is not permitted in a read-only context' };
      if (verdict.readOnly) {
        // Auto-allow-or-block ONLY: honor a settings deny rule, but NEVER fall through to canUseTool
        // (which prompts) for a read-only shell verdict.
        const evaluation = await panel.permissionHandler.evaluatePermission(damoclesName, input);
        return evaluation === 'deny'
          ? { block: true, reason: formatPolicyBlockReason('Permission denied by a rule in your Damocles settings') }
          : proceed();
      }
      return { block: true, reason: formatPolicyBlockReason(
        planMode
          ? `Plan mode is active — read-only shell commands (e.g. git status/log/diff, ls, cat, grep) are allowed, but this command was not recognized as read-only: ${verdict.reason}. Rephrase using only read-only commands, or exit plan mode to run it.`
          : `You are a read-only agent — read-only shell commands (e.g. git status/log/diff, ls, cat, grep) are allowed, but this command was not recognized as read-only: ${verdict.reason}. Rephrase it as a pure read, or report back that the task needs an agent that can make changes.`) };
    }
    const isPlanFileEdit =
      planMode &&
      (damoclesName === TOOL_EDIT || damoclesName === TOOL_WRITE) &&
      isPlanFilePath(typeof input['file_path'] === 'string' ? (input['file_path'] as string) : '');
    if (!isPlanFileEdit) {
      return { block: true, reason: formatPolicyBlockReason(
        planMode
          ? 'Plan mode is active — only read-only tools are allowed until you exit the plan.'
          : 'You are a read-only agent — only read-only tools are allowed.') };
    }
  }

  // Read tools (incl. known extension read tools + read-only MCP tools) auto-allow — still honoring
  // settings deny rules — without hitting the VS Code fallback modal (FR-6).
  if (category === 'read' || mcpReadOnly) {
    const evaluation = await panel.permissionHandler.evaluatePermission(damoclesName, input);
    return evaluation === 'deny'
      ? { block: true, reason: formatPolicyBlockReason('Permission denied by a rule in your Damocles settings') }
      : proceed();
  }

  // Gating tools (Edit/Write/Bash/PowerShell) + unknown tools: full approval flow.
  const result = await panel.permissionHandler.canUseTool(
    damoclesName,
    input,
    buildCanUseToolContext(event.toolCallId, signal, parentToolUseId),
  );
  return result.behavior === 'deny' ? { block: true, reason: formatDenyReason(result.message) } : proceed();
}
