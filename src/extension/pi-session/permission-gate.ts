import type { ToolCallEvent, ToolCallEventResult } from '@earendil-works/pi-coding-agent';
import type { PermissionHandler, CanUseToolContext } from '../permission-handler';
import type { MemoryService } from '../memory';
import type { CompassService } from '../compass';
import type { ExtensionToWebviewMessage } from '../../shared/types/messages';
import { FEEDBACK_MARKER } from '../../shared/types/constants';
import { IGNORED_TOOLS, TASK_MANAGEMENT_TOOLS, SUBAGENT_TOOLS } from '../../shared/tool-names';
import { mapPiToolName, normalizeToolInput, toolCategory } from './tool-normalization';
import { GATEABLE_MODULE_NAMES } from './tools/tool-catalog';

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
  /** Emit a webview message from a shared-extension hook (injection chips, etc.). */
  postMessage: (message: ExtensionToWebviewMessage) => void;
  /** The current 0-based user-prompt index, to key per-prompt injection messages. */
  currentPromptIndex: () => number;
  /** Called from the `agent_end` hook (awaited before the turn settles): if background subagents are
   *  still running, hold the turn until they finish and inject their results so the model continues. */
  onAgentEnd?: () => Promise<void>;
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
export type GatePermissionContext = Pick<PanelGateContext, 'permissionHandler' | 'isPlanMode'>;

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
): Promise<ToolCallEventResult | undefined> {
  const damoclesName = mapPiToolName(event.toolName);
  const input = normalizeToolInput(event.toolName, event.input as Record<string, unknown>);
  const category = toolCategory(damoclesName);

  if (GATE_ALLOW_ALWAYS.has(damoclesName)) return undefined;

  // In-process MCP module tools (memory/compass/browser, now PascalCase): auto-allow with exact SDK
  // parity — the SDK's `mcp__` rule never prompted, but a settings deny rule is still honored (FR-4).
  // Web tools are NOT here — they fall through to the read branch (`EXTENSION_READ_TOOLS`).
  if (GATEABLE_MODULE_NAMES.has(damoclesName)) {
    const evaluation = await panel.permissionHandler.evaluatePermission(damoclesName, input);
    return evaluation === 'deny'
      ? { block: true, reason: formatDenyReason('Permission denied by settings rule') }
      : undefined;
  }

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
  const result = await panel.permissionHandler.canUseTool(
    damoclesName,
    input,
    buildCanUseToolContext(event.toolCallId, signal, parentToolUseId),
  );
  return result.behavior === 'deny' ? { block: true, reason: formatDenyReason(result.message) } : undefined;
}
