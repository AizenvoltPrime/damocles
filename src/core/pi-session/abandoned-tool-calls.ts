import type { ToolAbandonReason } from '../../shared/types/session';

/**
 * Why the tool calls of a model call that ended on `stopReason` never ran, or undefined when pi runs them.
 * pi's agent loop returns before executing any tool an errored or aborted message named (`agent-loop.js:143`).
 */
export function abandonReasonOf(stopReason: unknown): ToolAbandonReason | undefined {
  if (stopReason === 'error') return 'failed';
  if (stopReason === 'aborted') return 'stopped';
  return undefined;
}

/**
 * The calls of the assistant message before an aborted one (or an abort's wind-down error, `windDownRecorded`)
 * that pi skipped, which are `stopped`. An abort cuts a batch after the call it was running, whose result pi records, and
 * starts none after it (`agent-loop.js:402-404`, `:429-431`, `:449-451`), so a message none of whose calls has a result
 * is not a batch an abort cut.
 */
export function skippedToolCalls<T extends { id: string }>(calls: readonly T[], hasResult: (toolCallId: string) => boolean): T[] {
  if (!calls.some((call) => hasResult(call.id))) return [];
  return calls.filter((call) => !hasResult(call.id));
}
