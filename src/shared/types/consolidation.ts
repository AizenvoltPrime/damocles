/** A conversation turn queued for the next consolidation pass (the "considered" list, before a run). */
export interface PendingConsolidationCandidate {
  id: string;
  sessionId: string | null;
  userPreview: string;
  assistantPreview: string;
  createdAt: number;
}

/** What happened when an extracted memory was persisted. */
export type ConsolidationPersistOutcome = 'inserted' | 'deduped' | 'merged' | 'superseded' | 'invalid';

/** One memory a consolidation pass extracted, with how it was persisted. */
export interface ConsolidationExtractedMemory {
  kind: string;
  scope: string;
  content: string;
  outcome: ConsolidationPersistOutcome;
}

/** Summary of a completed consolidation pass — the memories it considered for storage. */
export interface ConsolidationResult {
  ranAt: number;
  extracted: ConsolidationExtractedMemory[];
}
