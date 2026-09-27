import type { MemoryScoreBreakdown } from '@shared/types/context-injection';
import { SCORE_WEIGHTS } from '@shared/memory-score';

/** Placeholder values for the `contextInjection.formula.score` string. */
export const SCORE_FORMULA_WEIGHTS = {
  relevance: SCORE_WEIGHTS.relevance.toFixed(2),
  file: SCORE_WEIGHTS.file.toFixed(2),
  recency: SCORE_WEIGHTS.recency.toFixed(2),
  retrieval: SCORE_WEIGHTS.retrieval.toFixed(2),
};

export interface ScoreTerm {
  id: 'relevance' | 'file' | 'recency' | 'retrieval' | 'sourceCountBoost';
  weight: number | null;
  value: number;
  contribution: number;
}

/** The additive terms of the score, before the staleness penalty multiplies their sum. */
export function scoreTerms(b: MemoryScoreBreakdown): ScoreTerm[] {
  return [
    { id: 'relevance', weight: SCORE_WEIGHTS.relevance, value: b.relevance, contribution: SCORE_WEIGHTS.relevance * b.relevance },
    { id: 'file', weight: SCORE_WEIGHTS.file, value: b.fileProximity, contribution: SCORE_WEIGHTS.file * b.fileProximity },
    { id: 'recency', weight: SCORE_WEIGHTS.recency, value: b.recency, contribution: SCORE_WEIGHTS.recency * b.recency },
    { id: 'retrieval', weight: SCORE_WEIGHTS.retrieval, value: b.retrievalBoost, contribution: SCORE_WEIGHTS.retrieval * b.retrievalBoost },
    { id: 'sourceCountBoost', weight: null, value: b.sourceCountBoost, contribution: b.sourceCountBoost },
  ];
}

export function scoreFromBreakdown(b: MemoryScoreBreakdown): number {
  return scoreTerms(b).reduce((sum, term) => sum + term.contribution, 0) * b.stalenessPenalty;
}
