/**
 * status-note.ts — Parenthetical status note appended to agent result text.
 *
 * Ported from @tintinweb/pi-subagents (MIT, © 2026 tintinweb; see THIRD-PARTY-NOTICES.md).
 */

import { formatUserSteerPrefix } from '../../../shared/steer';
import type { AgentStopReason } from '../agent-records';
import type { AgentRecord } from './types';

export function resumeSentence(agentId: string): string {
  return `Resume it with Agent({resume:"${agentId}"}) if the user asks to continue.`;
}

/**
 * Explicit parenthetical note for a non-normal terminal outcome, so the parent
 * agent can't mistake partial output for a completed result. Empty string for a
 * clean completion (and any unknown/non-terminal status).
 *
 * `stopped` (a human aborted it) is deliberately distinct from `aborted` (the
 * turn limit was hit). Each stop reason names its cause, and only the resumable
 * ones (see `isResumableSubagentStatus`) name the resume call.
 */
export function getStatusNote(status: string, stopReason: AgentStopReason | undefined, agentId: string): string {
  const resume = resumeSentence(agentId);
  switch (status) {
    case 'stopped':
      switch (stopReason) {
        case 'user':
          return ` (STOPPED BY THE USER before completion; output is partial. ${resume})`;
        case 'shutdown':
          return ` (STOPPED before completion because its chat panel closed or the editor window reloaded; output is partial. ${resume})`;
        case 'budget':
          return ' (stopped by the budget limit before completion; output is partial and it cannot be resumed)';
        case 'reset':
          return ' (stopped before completion because the conversation was cleared; output is partial and it cannot be resumed)';
        default:
          return ' (STOPPED before completion; output is partial and the task was not finished)';
      }
    case 'error':
      return ` (FAILED before completion. ${resume})`;
    case 'aborted':
      return ' (aborted — hit the turn limit before completion; output may be incomplete)';
    case 'steered':
      return ' (wrapped up at the turn limit — output may be partial)';
    default:
      return '';
  }
}

/** A failed run's outcome: its error, then the text it wrote before failing. Team agents report the same shape. */
export function failureOutcomeText(error: string, partial: string | null | undefined): string {
  return error + (partial ? `\n\nPartial output:\n${partial}` : '');
}

/** A finished record's outcome with its status note: a failed run's error, then the text it wrote before failing. */
export function recordOutcomeText(record: AgentRecord): string {
  const base = record.status === 'error'
    ? failureOutcomeText(record.error ?? 'Subagent failed', record.result)
    : record.result ?? '';
  return base + getStatusNote(record.status, record.stopReason, record.id);
}

/** The final-result text the parent model sees for a finished record. */
export function recordResultText(record: AgentRecord): string {
  return formatUserSteerPrefix(record.userSteers) + recordOutcomeText(record);
}
