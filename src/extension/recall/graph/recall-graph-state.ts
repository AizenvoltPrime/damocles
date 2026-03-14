import type { AnnotationSpec } from './types';
import type { StructuredTurn, RecallTrajectory } from '../types';

export interface SessionTraceEntry {
  promptIndex: number;
  intent: string;
  secondaryIntent: string | null;
  keyEntities: string[];
  recallSucceeded: boolean;
  timestamp: string;
}

export interface SessionTrace {
  entries: SessionTraceEntry[];
  lastIntent: string;
  recentEntities: string[];
}

export type RecallGraphState = {
  userPrompt: string;
  history: StructuredTurn[];
  promptIndex: number;
  intent: string;
  secondaryIntent: string | null;
  keyEntities: string[];
  recallContext: string | null;
  recallTrajectory: RecallTrajectory | null;
  sessionTrace: SessionTrace;
};

export function createRecallGraphAnnotation(): AnnotationSpec<RecallGraphState> {
  return {
    defaults: () => ({
      userPrompt: '',
      history: [],
      promptIndex: -1,
      intent: 'general',
      secondaryIntent: null,
      keyEntities: [],
      recallContext: null,
      recallTrajectory: null,
      sessionTrace: { entries: [], lastIntent: '', recentEntities: [] },
    }),
  };
}
