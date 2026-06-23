import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { AssistantMessage, ToolResultMessage } from '@earendil-works/pi-ai';
import { TOOL_EXIT_PLAN_MODE } from '../../shared/tool-names';

/**
 * The plan-mode turn-end backstop's data: the hidden-nudge constants and the two turn-end predicates.
 * `lastAssistant` and `turnHasNonErrorExitPlanModeResult` are plan-mode-specific (used only by
 * `PiSession.tryPlanModeHold`), so they live here rather than in the generic `branch-text` helpers.
 * Mirrors the leaf module `plan-mode-guidance.ts` (single source of truth for plan-mode directive text).
 */

/** Custom-message type for the plan-mode force-continue nudge (display:false → seen by the model, not
 *  rendered as a bubble), colocated in spirit with SUBAGENT_RESULTS_CUSTOM_TYPE. */
export const PLAN_MODE_NUDGE_CUSTOM_TYPE = 'damocles-plan-mode-nudge';

/** The hidden nudge injected when a plan-mode turn ends cleanly without a successful ExitPlanMode. It
 *  names the correct non-stop escapes (ExitPlanMode / AskUserQuestion) and directs the empty-plan loop
 *  (write the plan file first, then exit) so a denied-because-no-plan-file exit self-heals in one turn. */
export const PLAN_MODE_NUDGE_TEXT: string =
  'You are still in plan mode and your last response ended without calling ExitPlanMode. ' +
  'If your plan is complete and written to the plan file, call ExitPlanMode now to request approval. ' +
  'If ExitPlanMode was denied because no plan file exists, write your full plan to the plan file first, then call ExitPlanMode. ' +
  'If you need a decision from the user, use AskUserQuestion. Otherwise, keep planning.';

/** The last assistant-role message in a turn's `agent_end` messages, or null. Its `stopReason` is the
 *  clean-completion signal for the plan-mode hold. */
export function lastAssistant(messages: readonly AgentMessage[]): AssistantMessage | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && (m as { role?: string }).role === 'assistant') return m as AssistantMessage;
  }
  return null;
}

/** Whether the turn contains a NON-error `ExitPlanMode` tool result — i.e. an APPROVED exit. This is the
 *  authoritative "did the model successfully exit plan mode this turn?" signal, read from the turn's
 *  actual content rather than the racy downstream permission-mode flip. A rejected exit yields only an
 *  isError result (→ false here), so the hold still nudges the model to revise and re-exit. */
export function turnHasNonErrorExitPlanModeResult(messages: readonly AgentMessage[]): boolean {
  return messages.some((m) => {
    const r = m as Partial<ToolResultMessage>;
    return r.role === 'toolResult' && r.toolName === TOOL_EXIT_PLAN_MODE && r.isError !== true;
  });
}
