import type { RecallGraphState, SessionTrace, SessionTraceEntry } from '../recall-graph-state';
import type { NodeExecutionContext } from '../types';

export async function stateUpdateNode(
  state: Readonly<RecallGraphState>,
  _context: NodeExecutionContext,
): Promise<Partial<RecallGraphState>> {
  const entry: SessionTraceEntry = {
    promptIndex: state.promptIndex,
    intent: state.intent,
    keyEntities: state.keyEntities,
    recallSucceeded: state.recallContext !== null
      && !state.recallTrajectory?.forcedAnswer
      && !state.recallTrajectory?.timedOut,
    timestamp: new Date().toISOString(),
  };

  const updatedTrace: SessionTrace = {
    entries: [...state.sessionTrace.entries, entry],
    lastIntent: state.intent,
    recentEntities: [...new Set([
      ...state.sessionTrace.recentEntities,
      ...state.keyEntities,
    ])].slice(-20),
  };

  return { sessionTrace: updatedTrace };
}
