import type { RecallGraphState, SessionTrace } from '../../graph/recall-graph-state';
import type { StructuredTurn, RecallConfig } from '../../types';
import { DIRECT_CONTEXT_THRESHOLD, DEFAULT_SUBCALL_MODEL } from '../../types';
import { createLargeHistory } from './histories';

export function padHistory(history: StructuredTurn[]): StructuredTurn[] {
  const totalChars = history.reduce((sum, t) => sum + t.userMessage.length + t.assistantResponse.length, 0);
  if (totalChars > DIRECT_CONTEXT_THRESHOLD + 2000) return history;
  const deficit = DIRECT_CONTEXT_THRESHOLD + 2000 - totalChars;
  const padPerTurn = Math.ceil(deficit / history.length);
  return history.map(t => ({
    ...t,
    assistantResponse: t.assistantResponse + '\n\n' +
      'I also reviewed the surrounding code for consistency and made minor adjustments to ensure compatibility. '.repeat(Math.ceil(padPerTurn / 105)),
  }));
}

export function makeEmptyTrace(): SessionTrace {
  return { entries: [], lastIntent: '', recentEntities: [] };
}

export function makeDefaultConfig(): RecallConfig {
  return { enabled: true, subcallModel: DEFAULT_SUBCALL_MODEL, maxIterations: 15, maxInjectedChars: 200_000 };
}

export function makeGraphState(
  userPrompt: string,
  opts?: { history?: StructuredTurn[]; trace?: SessionTrace; promptIndex?: number },
): RecallGraphState {
  const history = opts?.history ?? padHistory(createLargeHistory(20));
  return {
    userPrompt,
    history,
    promptIndex: opts?.promptIndex ?? history.length,
    intent: 'general',
    secondaryIntent: null,
    keyEntities: [],
    recallContext: null,
    recallTrajectory: null,
    sessionTrace: opts?.trace ?? makeEmptyTrace(),
  };
}
