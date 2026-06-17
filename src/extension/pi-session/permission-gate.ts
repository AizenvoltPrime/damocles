import type { ToolCallEvent, ToolCallEventResult } from '@earendil-works/pi-coding-agent';
import type { PermissionHandler, CanUseToolContext } from '../permission-handler';
import { FEEDBACK_MARKER } from '../../shared/types/constants';
import { IGNORED_TOOLS, TASK_MANAGEMENT_TOOLS } from '../../shared/tool-names';
import { mapPiToolName, normalizeToolInput, toolCategory } from './tool-normalization';

/** A non-aborting signal for gate calls when pi hands us no AbortSignal (`ctx.signal` is optional). */
const NEVER_ABORT: AbortSignal = new AbortController().signal;

/** Build the `CanUseToolContext` the managers expect. `toolCallId` is pi's native, always-present id. */
export function buildCanUseToolContext(toolCallId: string, signal: AbortSignal | undefined): CanUseToolContext {
  return { signal: signal ?? NEVER_ABORT, toolUseID: toolCallId, parentToolUseId: null };
}

/** The per-panel state the gate routes to, looked up by sessionId in the shared Damocles extension. */
export interface PanelGateContext {
  permissionHandler: PermissionHandler;
  isPlanMode: () => boolean;
}

/**
 * Tools whose interaction is owned by their own `execute()` (they drive the managers directly) plus
 * the task-list tools (`TaskCreate`/`TaskUpdate`/`TaskList`/`TaskGet` — in-memory session state, never
 * a real-world side effect, so never prompted). The gate must NOT route these through `canUseTool` —
 * that would double-prompt. `IGNORED_TOOLS` already covers AskUserQuestion/Enter/Exit-PlanMode.
 */
const GATE_ALLOW_ALWAYS: ReadonlySet<string> = new Set<string>([...IGNORED_TOOLS, ...TASK_MANAGEMENT_TOOLS]);

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
 * The central permission gate: pi `tool_call` event → Damocles `PermissionHandler.canUseTool`. Runs in
 * the shared Damocles extension, routed to the right panel by sessionId. Returns a `ToolCallEventResult`
 * (`{ block, reason }`) to deny, or `undefined` to allow.
 *
 * It NEVER mutates `event.input`: native pi tools execute with their raw input (`{ path }`, not the
 * normalized `{ file_path }`), so only a normalized COPY is handed to `canUseTool`. The managers never
 * rewrite values in Phase 2, so there is nothing to propagate back.
 */
export async function runPermissionGate(
  event: ToolCallEvent,
  panel: PanelGateContext,
  signal: AbortSignal | undefined,
): Promise<ToolCallEventResult | undefined> {
  const damoclesName = mapPiToolName(event.toolName);
  const input = normalizeToolInput(event.toolName, event.input as Record<string, unknown>);
  const category = toolCategory(damoclesName);

  if (GATE_ALLOW_ALWAYS.has(damoclesName)) return undefined;

  // Plan-mode defense in depth: block any write/shell the read-only active set somehow let through.
  if (panel.isPlanMode() && (category === 'write' || category === 'shell')) {
    return { block: true, reason: formatDenyReason('Plan mode is active — only read-only tools are allowed until you exit the plan.') };
  }

  // Read tools (incl. known extension read tools) auto-allow — still honoring settings deny rules —
  // without hitting the VS Code fallback modal (FR-6).
  if (category === 'read') {
    const evaluation = await panel.permissionHandler.evaluatePermission(damoclesName, input);
    return evaluation === 'deny'
      ? { block: true, reason: formatDenyReason('Permission denied by settings rule') }
      : undefined;
  }

  // Gating tools (Edit/Write/Bash/PowerShell) + unknown tools: full approval flow.
  const result = await panel.permissionHandler.canUseTool(damoclesName, input, buildCanUseToolContext(event.toolCallId, signal));
  return result.behavior === 'deny' ? { block: true, reason: formatDenyReason(result.message) } : undefined;
}
