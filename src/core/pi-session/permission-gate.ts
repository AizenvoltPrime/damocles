import * as path from 'path';
import type { ToolCallEvent, ToolCallEventResult, AgentBeforeSettleEvent, SessionBoundaryDraft } from '@earendil-works/pi-coding-agent';
import type { PermissionHandler, CanUseToolContext } from '../permission-handler';
import type { McpToolIdentity } from '../permission-handler/types';
import type { MemoryService } from '../memory';
import type { CompassService } from '../compass';
import type { ExtensionToWebviewMessage } from '../../shared/types/messages';
import { FEEDBACK_MARKER, POLICY_BLOCK_MARKER } from '../../shared/types/constants';
import { IGNORED_TOOLS, TASK_MANAGEMENT_TOOLS, SUBAGENT_TOOLS, TOOL_EDIT, TOOL_WRITE, TOOL_BASH, TOOL_POWERSHELL, TOOL_AGENT } from '../../shared/tool-names';
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
  mcpTool?: McpToolIdentity,
): CanUseToolContext {
  return { signal: signal ?? NEVER_ABORT, toolUseID: toolCallId, parentToolUseId, ...(mcpTool ? { mcpTool } : {}) };
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
  /** Gates the output-form guidance. Required, not optional: an omitted flag would render the
   *  `/context` preview thinking-on while the live turn runs thinking-off. */
  thinkingDisabled: boolean;
}

/**
 * The per-panel state the shared Damocles extension routes to, looked up by sessionId. Beyond the
 * permission gate (`permissionHandler`/`isPlanMode`), it carries everything the `before_agent_start`
 * hook needs to assemble the Damocles system prompt and inject memory/compass context: the panel's
 * services, its resolved session model + environment, and a webview-message emitter.
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
  /** Whether the multi-agent Team feature is enabled. Selects whether the team rung appears in the
   *  delivery-mechanism ladder the plan-mode and plan-execution directives carry. */
  isTeamEnabled?: () => boolean;
  /** Emit a webview message from a shared-extension hook (injection chips, etc.). */
  postMessage: (message: ExtensionToWebviewMessage) => void;
  /** True once the hard budget limit stopped the turn; a cache-warming refresh bills against that cap. */
  budgetStopRequested: () => boolean;
  /** Called from the `agent_before_settle` boundary: coordinates the background keep-alive (wait for
   *  running subagents and carry their results into one more request) and the plan-mode hold (nudge the
   *  model to call ExitPlanMode if a plan-mode turn ended without it). Returns the entry to append and
   *  continue the run with, or undefined to let the run settle. */
  onBeforeSettle?: (event: AgentBeforeSettleEvent) => Promise<SessionBoundaryDraft | undefined>;
  /**
   * Whether an `mcp__…` tool is annotated read-only (US-014.4). The panel reads it live off the MCP
   * client; a nested subagent/team agent supplies the FROZEN classifier from its per-spawn
   * `NestedMcpToolset` snapshot, so both get the same auto-allow-vs-prompt behaviour. Optional only
   * because a caller with no MCP at all (empty snapshot, MCP disabled) has nothing to classify —
   * absent ⇒ every `mcp__*` call routes to `canUseTool`, which is the fail-closed direction.
   */
  isMcpReadOnly?: (piToolName: string) => boolean;
  /**
   * The server and raw tool name behind an `mcp__…` tool, from the same descriptors as `isMcpReadOnly`,
   * which `mcp__` settings rules match. Absent, or undefined for a name with no descriptor, leaves only a
   * rule spelling the exact pi name able to match it.
   */
  mcpToolIdentity?: (piToolName: string) => McpToolIdentity | undefined;
  /** This panel's deferrable universe for `ToolSearch`; absent for subagents (no deferral). */
  deferrableTools?: () => DeferrableSnapshot;
  /** Load deferred tools into this panel's active set — synchronous, called inside `ToolSearch.execute`. */
  activateDeferredTools?: (names: string[]) => void;
  /**
   * Called from `before_agent_start` with the dispatching session's id. Holds the session's first prompt,
   * bounded, while a server with Always-loaded MCP tools is still connecting; every later call returns at once.
   */
  waitForAlwaysLoadedMcp?: (sessionId: string) => Promise<void>;
  /**
   * The panel's turn checkpoint. A nested agent passes its parent panel's, so its file changes never
   * land before the parent turn's baseline. Absent means no checkpoints to wait for.
   */
  checkpointBaseline?: CheckpointBaselineGate;
}

/** What the gate needs of a panel's turn checkpoint. */
export interface CheckpointBaselineGate {
  /** The folder the checkpoint captures; an Edit or Write outside it never waits. */
  readonly folder: string;
  /** Resolves once the current turn has its baseline, the bounded wait ran out, or `signal` aborted. Never rejects. */
  wait(signal: AbortSignal, toolName: string): Promise<void>;
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
export type GatePermissionContext = Pick<PanelGateContext, 'permissionHandler' | 'isPlanMode' | 'isMcpReadOnly' | 'mcpToolIdentity' | 'checkpointBaseline'> & {
  /**
   * Apply plan mode's shell rule to this caller in every mode: a command `readonly-shell.ts` proves
   * read-only auto-runs, any other goes through `canUseTool` (prompt, settings rules, YOLO), and write
   * tools are blocked. Set for a subagent whose resolved toolset contains no write tool.
   */
  readOnlyShell?: boolean;
};

/** Tools that start agents, which change files the turn's checkpoint must see first. */
const SPAWN_TOOLS: ReadonlySet<string> = new Set<string>([TOOL_AGENT, 'create_team', 'resume_team', 'team_spawn_specialist', 'team_redispatch_specialist']);

/**
 * Whether a call may change `folder` and so must wait for the turn's checkpoint baseline. Read-only
 * tools, read-only-annotated MCP tools, provably read-only shell commands, the in-process coordination
 * tools (none writes into the folder), and an Edit or Write of the plan file or of a path outside the
 * folder never wait; spawn tools, other writes, other shell and anything unknown do.
 */
export function waitsForCheckpointBaseline(piToolName: string, input: Record<string, unknown>, isMcpReadOnly: ((name: string) => boolean) | undefined, folder: string): boolean {
  const damoclesName = mapPiToolName(piToolName);
  if (SPAWN_TOOLS.has(damoclesName)) return true;
  if (damoclesName === TOOL_EDIT || damoclesName === TOOL_WRITE) {
    const filePath = normalizeToolInput(piToolName, input)['file_path'];
    if (typeof filePath !== 'string' || !filePath) return true;
    // Resolved against the folder, as the tools resolve it, so an unrecognised prefix reads as inside and waits.
    const target = path.resolve(folder, filePath);
    return !isPlanFilePath(target) && isInsideFolder(target, folder);
  }
  const category = toolCategory(damoclesName);
  if (category === 'read') return false;
  if (damoclesName.startsWith('mcp__')) return !(isMcpReadOnly?.(damoclesName) ?? false);
  if (GATE_ALLOW_ALWAYS.has(damoclesName) || GATEABLE_MODULE_NAMES.has(damoclesName)) return false;
  if (category === 'shell') {
    const shell = damoclesName === TOOL_BASH ? 'bash' : damoclesName === TOOL_POWERSHELL ? 'powershell' : null;
    const command = typeof input['command'] === 'string' ? (input['command'] as string) : '';
    return !(shell && classifyReadOnlyShellCommand(shell, command).readOnly);
  }
  return true;
}

function isInsideFolder(target: string, folder: string): boolean {
  const rel = path.relative(folder, target);
  return rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

/**
 * PreToolUse hooks plugged into the single gate handler (Section 3.3). `run` executes the configured
 * `tool_call` hooks for this event (null when none match); `onDecision` raises the transparency notice
 * when a hook force-allows or blocks. Built per tool-call by the extension wiring, which owns the panel's
 * webview emitter. Absent when no `tool_call` hook is configured, so the gate path stays zero-cost (FR-14).
 */
export interface PreToolUseHookGate {
  run: (event: ToolCallEvent) => Promise<ToolCallHookResult | null>;
  /** `terminate` is the hook's opt-in to ending the whole turn, not just this call — the notice must say
   *  so, because pi's terminate path settles the turn normally and leaves no other signal. */
  onDecision: (toolName: string, decision: 'allow' | 'deny', reason: string | undefined, terminate: boolean) => void;
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
 * The fail-closed answer for a tool call the gate cannot decide: blocked, whatever the tool. A read is
 * not exempt, because a settings deny or ask rule may name the file it reads, and an undecided check
 * cannot show that none does. Never terminating, so the model can re-plan.
 */
export function gateErrorFallback(): ToolCallEventResult {
  return { block: true, reason: formatPolicyBlockReason('This tool could not be approved, so it was blocked by default for safety.') };
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
  const mcpTool = isMcp ? panel.mcpToolIdentity?.(damoclesName) : undefined;

  // PreToolUse hooks run INSIDE the single gate handler, before the gate decides (Section 3.3). `allow`
  // skips the gate entirely (force-allow); `deny`/exit-2 blocks; `updatedInput` mutates `event.input` in
  // place (denormalized to pi's shape) so the gate + the tool both see the rewrite; `ask`/none falls
  // through. An infra failure (spawn/timeout) is fail-closed for write/shell only. All bounded to tools
  // the user wrote a hook for; both force-allow and block raise the transparency notice.
  // A PreToolUse hook's `additionalContext` (when the tool will proceed) is delivered on the matching
  // tool result — pi's `tool_call` return can't inject context. Stamped on any "tool proceeds" path.
  let pendingContext: string | undefined;
  // Every allow path funnels here, after approval, so the approval prompt's time counts toward the baseline.
  const proceed = async (): Promise<undefined> => {
    const checkpoint = panel.checkpointBaseline;
    if (checkpoint && waitsForCheckpointBaseline(event.toolName, event.input as Record<string, unknown>, panel.isMcpReadOnly, checkpoint.folder)) {
      await checkpoint.wait(signal ?? NEVER_ABORT, mapPiToolName(event.toolName));
    }
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
        preToolUse.onDecision(damoclesName, 'deny', result.reason, result.terminate === true);
        // A hook deny defaults to non-terminating; `terminate` is the hook author's explicit opt-in.
        return { block: true, reason: formatPolicyBlockReason(result.reason ?? 'Blocked by a configured PreToolUse hook'),
          ...(result.terminate ? { terminate: true } : {}) };
      }
      // Fail closed BEFORE the force-allow: a hook that timed out or failed to spawn may be the one that
      // would have denied, and a force-allow skips the gate entirely (canUseTool, plan mode, the
      // read-only-shell classifier, settings deny rules). A surviving sibling's `allow` is not evidence
      // that the down hook would have agreed.
      if (result.anyFailed && (category === 'write' || category === 'shell')) {
        return gateErrorFallback();
      }
      if (result.additionalContext) pendingContext = result.additionalContext;
      if (result.decision === 'allow') {
        preToolUse.onDecision(damoclesName, 'allow', result.reason, false);
        return proceed();
      }
    }
  }

  const input = normalizeToolInput(event.toolName, event.input as Record<string, unknown>);

  // The full approval flow: the prompt for gating tools and unknown tools, and for any call an ask rule names.
  const askUser = async (): Promise<ToolCallEventResult | undefined> => {
    const result = await panel.permissionHandler.canUseTool(
      damoclesName,
      input,
      buildCanUseToolContext(event.toolCallId, signal, parentToolUseId, mcpTool),
    );
    // `interrupt` becomes pi's `terminate`, and only `buildUserDenyResult`/`buildUserFileEditDenyResult`
    // (permission-handler/utils.ts) ever set it: the user answered the prompt and left the feedback box
    // empty. An unexplained "no" means stop; "no, do X instead" is instruction the model must keep. Every
    // deny the user was NOT asked about goes through `buildUnaskedDenyResult`, which cannot set it and
    // marks it `policy`, so the model is never told the user rejected it.
    // See docs/invariants.md ("Permissions and plan mode") for pi's per-batch terminate semantics.
    if (result.behavior !== 'deny') return proceed();
    if (result.policy) return { block: true, reason: formatPolicyBlockReason(result.message) };
    return { block: true, reason: formatDenyReason(result.message), ...(result.interrupt ? { terminate: true } : {}) };
  };

  if (GATE_ALLOW_ALWAYS.has(damoclesName)) return proceed();

  // In-process MCP module tools (memory/compass/browser, now PascalCase): auto-allow with exact SDK
  // parity — the SDK's `mcp__` rule never prompted, but a settings deny rule is still honored (FR-4)
  // and an ask rule prompts. Web tools are NOT here — they are in `READ_ONLY_TOOLS`, so they fall
  // through to the read branch.
  if (GATEABLE_MODULE_NAMES.has(damoclesName)) {
    const rule = await panel.permissionHandler.matchRule(damoclesName, input);
    if (rule === 'deny') return { block: true, reason: formatPolicyBlockReason('Permission denied by a rule in your Damocles settings') };
    return rule === 'ask' ? askUser() : proceed();
  }

  // Plan mode blocks the write-category tools. A shell command `readonly-shell.ts` proves read-only
  // auto-runs; any other goes through canUseTool like default mode (prompt, settings rules, YOLO), so
  // the model can gather what the plan needs (services, logs, endpoints) with the user's approval. The
  // plan-mode prompt forbids changing files through the shell. The ONE write carve-out is Edit/Write to
  // the plan file (US-002): it falls through to the normal flow where the EvaluatorManager auto-allows
  // the plans-dir write. MCP tools are NOT blocked here: they follow normal-mode rules, since the user
  // controls which servers are enabled.
  // Read-only SUBAGENTS (Explore/Plan, team reviewers, any agent whose toolset omits every write tool)
  // get the same shell rule in every permission mode: proven reads auto-run, anything else asks, and
  // YOLO approves it. Their prompts forbid writing through the shell. They have no plan file.
  //
  // MCP is exempt from the read-only-SUBAGENT branch too, on purpose and by the same reasoning. This
  // is load-bearing now that nested agents receive MCP tools: `toolCategory('mcp__…')` is `'other'`
  // (tool-normalization.ts:47-51), so the `write`/`shell` condition below never catches an MCP call,
  // and a read-only agent reaches MCP under normal-mode rules — annotated reads auto-allow, everything
  // else routes to `canUseTool` and prompts. That is a DECISION, not an oversight, and it is wrong to
  // "fix" in either direction without reading this:
  //   - Blocking MCP for read-only subagents would make them stricter than the panel AND stricter than
  //     plan mode, which the paragraph above already exempts. Most servers omit `readOnlyHint`
  //     entirely, so it would fail closed against the common case and grant Explore/Plan nothing.
  //   - Auto-allowing non-annotated MCP for them would be laxer than the panel. It is not.
  // `docs/invariants.md` scopes the read-only-agent rule to the SHELL: an unproven command needs the
  // user's approval, so `echo > file` cannot silently undo a denied `Edit`; it is not a general
  // capability ceiling. The trust boundary for MCP is the user's server-enablement list, which a
  // subagent cannot widen.
  const planMode = panel.isPlanMode();
  const readOnlyAgent = panel.readOnlyShell === true;
  if (category === 'shell' && (planMode || readOnlyAgent)) {
    const command = typeof input['command'] === 'string' ? (input['command'] as string) : '';
    const shell = damoclesName === TOOL_BASH ? 'bash'
      : damoclesName === TOOL_POWERSHELL ? 'powershell'
        : null; // A shell tool with no classifier always asks; never default it to allow.
    if (!shell || !classifyReadOnlyShellCommand(shell, command).readOnly) return askUser();
    // Auto-allow unless a settings rule names the command: never fall through to canUseTool for the
    // read-only verdict alone, since with no rule it would prompt for every shell command.
    const rule = await panel.permissionHandler.matchRule(damoclesName, input);
    if (rule === 'deny') return { block: true, reason: formatPolicyBlockReason('Permission denied by a rule in your Damocles settings') };
    return rule === 'ask' ? askUser() : proceed();
  }
  if (category === 'write' && (planMode || readOnlyAgent)) {
    const isPlanFileEdit =
      planMode &&
      (damoclesName === TOOL_EDIT || damoclesName === TOOL_WRITE) &&
      panel.permissionHandler.isPlanFile(typeof input['file_path'] === 'string' ? (input['file_path'] as string) : '');
    if (!isPlanFileEdit) {
      return { block: true, reason: formatPolicyBlockReason(
        planMode
          ? 'Plan mode is active — only read-only tools are allowed until you exit the plan.'
          : 'You are a read-only agent — only read-only tools are allowed.') };
    }
  }

  // Read tools (incl. known extension read tools + read-only MCP tools) auto-allow, still honoring
  // settings deny rules. The evaluator answers ask for them only when an ask rule names the call, and
  // that prompts below in every mode.
  if (category === 'read' || mcpReadOnly) {
    const evaluation = await panel.permissionHandler.evaluatePermission(damoclesName, input, mcpTool);
    if (evaluation === 'deny') {
      return { block: true, reason: formatPolicyBlockReason('Permission denied by a rule in your Damocles settings') };
    }
    if (evaluation !== 'ask') return proceed();
  }

  // Gating tools (Edit/Write/Bash/PowerShell) + unknown tools: full approval flow.
  return askUser();
}
