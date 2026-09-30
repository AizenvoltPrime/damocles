import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { AssistantMessage, ToolResultMessage } from '@earendil-works/pi-ai';
import { TOOL_EXIT_PLAN_MODE } from '../../shared/tool-names';

/**
 * The plan-mode backstop's data: the hidden-nudge texts, their selector, and the two settle-time predicates.
 * `lastAssistant` and `turnHasNonErrorExitPlanModeResult` are plan-mode-specific (used only by
 * `PiSession.tryPlanModeHold`), so they live here rather than in the generic `branch-text` helpers.
 * Mirrors the leaf module `plan-mode-guidance.ts` (single source of truth for plan-mode directive text).
 */

/** Custom-message type for the plan-mode force-continue nudge (display:false → seen by the model, not
 *  rendered as a bubble), colocated in spirit with SUBAGENT_RESULTS_CUSTOM_TYPE. */
export const PLAN_MODE_NUDGE_CUSTOM_TYPE = 'damocles-plan-mode-nudge';

/** The hidden nudge injected when a plan-mode turn ends cleanly without a successful ExitPlanMode. The
 *  funnel is unbounded, so the text must never authorize a text-only reply: any clause the model can
 *  satisfy without a tool call makes the nudge re-fire forever against a model that is obeying it.
 *  Also directs the empty-plan loop (write the plan file first, then exit) so a
 *  denied-because-no-plan-file exit self-heals in one turn. */
export const PLAN_MODE_NUDGE_TEXT: string =
  'You are still in plan mode and your last response ended without calling ExitPlanMode. ' +
  'A plan-mode turn ends in one of two ways: you call ExitPlanMode, or you call AskUserQuestion. ' +
  'Text on its own does not end it. ' +
  'If your plan is complete and written to the plan file, call ExitPlanMode now to request approval. ' +
  'If ExitPlanMode was denied because no plan file exists, write your full plan to the plan file first, then call ExitPlanMode. ' +
  'If you need a decision from the user, call AskUserQuestion. ' +
  'If you still need to research before you can plan, call a read-only tool now, then finish with ExitPlanMode or AskUserQuestion.';

/** The escalation, sent once a nudge in this turn has already gone unheeded. It must read as a second
 *  contact rather than a first, and it names the user-instruction conflict outright, because a model
 *  told not to call ExitPlanMode will otherwise keep idling instead of asking. It repeats the base
 *  text's plan-file remedy: a denied-because-no-plan-file exit is the case most likely to reach a
 *  second nudge, and without the remedy here the model re-calls ExitPlanMode and is denied again. */
export const PLAN_MODE_NUDGE_ESCALATED_TEXT: string =
  'You are still in plan mode and your last response was text with no tool call. ' +
  'A previous message in this turn already told you that text does not end a plan-mode turn. ' +
  'You will get this message again at the end of any response that calls no tool. ' +
  'Call ExitPlanMode or AskUserQuestion now. ' +
  'If an ExitPlanMode call in this turn was denied because no plan file exists, that is still the blocker: ' +
  'write your full plan to the plan file first, then call ExitPlanMode. ' +
  'If the user told you not to call ExitPlanMode, or anything else they asked for conflicts with exiting plan mode, call AskUserQuestion and ask them how they want to proceed. ' +
  'Give them the choice between approving the plan and staying in plan mode, and let them answer. ' +
  'AskUserQuestion is always available and hands control back to the user, so repeating yourself in text is never the right response.';

/**
 * Which nudge text to inject, chosen by how many nudges this turn has already produced. Escalating on
 * the repeat count rather than on the last message's shape is what makes both texts reachable: the
 * caller nudges only on `stopReason === 'stop'`, and pi reports an assistant message carrying tool calls
 * as `stopReason: 'toolUse'`, so the last assistant message at this point never holds a tool call.
 *
 * There are exactly two levels: the first nudge of a turn gets the base text, every later nudge in that
 * turn gets the escalated one byte for byte. That is the deliberate stopping point, not a half-built
 * ladder: the funnel has no cap, and a level three would only trade one unheeded text for another.
 *
 * The count comes from the session projection and needs no extra state, so it survives resume, fork and
 * branch navigation. A compaction whose retention window starts after the current prompt drops that
 * prompt, leaving no user message for the turn boundary to find, so the count restarts from zero; the
 * only consequence is which text is selected, since the hold still fires on its own predicates. An
 * injected nudge is `role: 'custom'` there; the mapping to `role: 'user'` happens in `convertToLlm`,
 * which builds the LLM request and leaves the projection alone.
 */
export function selectPlanModeNudgeText(messages: readonly AgentMessage[]): string {
  return countPlanModeNudgesInTurn(messages) === 0 ? PLAN_MODE_NUDGE_TEXT : PLAN_MODE_NUDGE_ESCALATED_TEXT;
}

/** How many plan-mode nudges the current turn already carries. Custom messages of any other type
 *  (subagent results, context injection) are other features' traffic and must not count. */
function countPlanModeNudgesInTurn(messages: readonly AgentMessage[]): number {
  let count = 0;
  for (let i = currentTurnStart(messages); i < messages.length; i++) {
    const m = messages[i] as { role?: string; customType?: string } | undefined;
    if (m?.role === 'custom' && m.customType === PLAN_MODE_NUDGE_CUSTOM_TYPE) count++;
  }
  return count;
}

/** Index of the first message of the current turn: everything after the last real user message.
 *  `countPlanModeNudgesInTurn` and `turnHasNonErrorExitPlanModeResult` share this boundary so they
 *  cannot disagree about where a turn begins. Needed because the caller reads from the
 *  `agent_before_settle` boundary, which carries the whole session projection and no per-turn message
 *  list. */
function currentTurnStart(messages: readonly AgentMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if ((messages[i] as { role?: string } | undefined)?.role === 'user') return i + 1;
  }
  return 0;
}

/** The last assistant-role message in the session projection, or null. Its `stopReason` is the
 *  clean-completion signal for the plan-mode hold. */
export function lastAssistant(messages: readonly AgentMessage[]): AssistantMessage | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && (m as { role?: string }).role === 'assistant') return m as AssistantMessage;
  }
  return null;
}

/** Whether the current turn contains a NON-error `ExitPlanMode` tool result — i.e. an APPROVED exit.
 *  This is the authoritative "did the model successfully exit plan mode this turn?" signal, read from
 *  the turn's actual content rather than the racy downstream permission-mode flip. A rejected exit
 *  yields only an isError result (→ false here), so the hold still nudges the model to revise and
 *  re-exit.
 *
 *  Scoped to the current turn: scanning the full projection would find an approved exit from an earlier
 *  turn and silence the nudge for the rest of the session. */
export function turnHasNonErrorExitPlanModeResult(messages: readonly AgentMessage[]): boolean {
  for (let i = messages.length - 1, start = currentTurnStart(messages); i >= start; i--) {
    const m = messages[i];
    if (!m) continue;
    if ((m as { role?: string }).role !== 'toolResult') continue;
    const r = m as Partial<ToolResultMessage>;
    if (r.toolName === TOOL_EXIT_PLAN_MODE && r.isError !== true) return true;
  }
  return false;
}
