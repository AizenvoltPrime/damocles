import type { ToolCallEvent, ToolCallEventResult, AgentEndEvent } from '@earendil-works/pi-coding-agent';
import type { PermissionHandler, CanUseToolContext } from '../permission-handler';
import type { MemoryService } from '../memory';
import type { CompassService } from '../compass';
import type { ExtensionToWebviewMessage } from '../../shared/types/messages';
import { FEEDBACK_MARKER } from '../../shared/types/constants';
import { IGNORED_TOOLS, TASK_MANAGEMENT_TOOLS, SUBAGENT_TOOLS, TOOL_EDIT, TOOL_WRITE } from '../../shared/tool-names';
import { isPlanFilePath } from '../paths';
import { mapPiToolName, normalizeToolInput, denormalizeToolInput, toolCategory } from './tool-normalization';
import { GATEABLE_MODULE_NAMES } from './tools/tool-catalog';
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

/** The slice of a panel's context the gate actually reads. `PanelGateContext` satisfies it; a nested
 *  subagent supplies the same parent handler + a parent-mode reader (inherit-parent-mode). */
export type GatePermissionContext = Pick<PanelGateContext, 'permissionHandler' | 'isPlanMode' | 'isMcpReadOnly'>;

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
        return { block: true, reason: formatDenyReason(result.reason) };
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
      ? { block: true, reason: formatDenyReason('Permission denied by settings rule') }
      : proceed();
  }

  // Plan-mode defense in depth: block any Damocles-native write/shell the read-only active set somehow
  // let through. The ONE write carve-out is Edit/Write to the plan file (US-002): the model maintains its
  // plan there while planning, so those fall through to the normal flow where the EvaluatorManager
  // auto-allows the plans-dir write. Every other Edit/Write (and all shell) stays blocked. MCP tools are
  // NOT blocked here — they follow normal-mode rules (read-only ones auto-allow via the read branch
  // below; non-read ones auto-allow via canUseTool), since the user controls which servers are enabled.
  if (panel.isPlanMode() && (category === 'write' || category === 'shell')) {
    const isPlanFileEdit =
      (damoclesName === TOOL_EDIT || damoclesName === TOOL_WRITE) &&
      isPlanFilePath(typeof input['file_path'] === 'string' ? (input['file_path'] as string) : '');
    if (!isPlanFileEdit) {
      return { block: true, reason: formatDenyReason('Plan mode is active — only read-only tools are allowed until you exit the plan.') };
    }
  }

  // Read tools (incl. known extension read tools + read-only MCP tools) auto-allow — still honoring
  // settings deny rules — without hitting the VS Code fallback modal (FR-6).
  if (category === 'read' || mcpReadOnly) {
    const evaluation = await panel.permissionHandler.evaluatePermission(damoclesName, input);
    return evaluation === 'deny'
      ? { block: true, reason: formatDenyReason('Permission denied by settings rule') }
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
