/**
 * terminated-calls.ts — The tool calls the permission gate blocked with pi's `terminate`, per nested session.
 *
 * pi persists no `terminate` on a tool result, so a run that ended on a rejected call reads as a clean end. The gate
 * records each such call here under its session id, and the code that ran the session reads the record when the run
 * ends. Module state is keyed by session id only, as the process-global pi extension requires.
 */

/** Who rejected the call: the user, with no note, or a PreToolUse hook that opted in to `terminate`. */
export type TerminateCause = 'user' | 'hook';

export interface TerminatedCall {
  toolCallId: string;
  /** Damocles' name for the tool (`mapPiToolName`). */
  toolName: string;
  cause: TerminateCause;
}

const bySession = new Map<string, TerminatedCall[]>();

export function recordTerminatedCall(sessionId: string, call: TerminatedCall): void {
  const calls = bySession.get(sessionId);
  if (calls) calls.push(call);
  else bySession.set(sessionId, [call]);
}

export function clearTerminatedCalls(sessionId: string): void {
  bySession.delete(sessionId);
}

/** The calls recorded for `sessionId` since the last take, which this clears. */
export function takeTerminatedCalls(sessionId: string): TerminatedCall[] {
  const calls = bySession.get(sessionId) ?? [];
  bySession.delete(sessionId);
  return calls;
}

/**
 * The recorded call that ended a run, when every result of the run's last tool batch (the tool results after its last
 * assistant message) is a recorded call. That is pi's rule for ending a run after a batch: `shouldTerminateToolBatch`
 * requires every result to terminate (`agent-loop.js:472` in pi-agent-core 1.5.2). The first such result names the call.
 */
export function rejectionEndingRun(messages: readonly unknown[], calls: readonly TerminatedCall[]): TerminatedCall | undefined {
  if (calls.length === 0) return undefined;
  const results: string[] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i] as { role?: unknown; toolCallId?: unknown } | undefined;
    if (message?.role === 'assistant') break;
    if (message?.role === 'toolResult' && typeof message.toolCallId === 'string') results.unshift(message.toolCallId);
  }
  if (results.length === 0) return undefined;
  const byId = new Map(calls.map((call) => [call.toolCallId, call]));
  if (!results.every((id) => byId.has(id))) return undefined;
  return byId.get(results[0]!);
}
