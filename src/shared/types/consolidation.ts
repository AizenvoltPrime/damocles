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

/** The five sequential phases of a consolidation pass, in order. Defined here (the import-free shared
 *  module) and re-exported from messages.ts so a phase id can travel inside both the live-progress
 *  event stream AND the terminal result's failure footer without a module cycle. */
export type ConsolidationPhaseId = 'claim' | 'extract' | 'persist' | 'maintain' | 'profiles';

/** Per-phase lifecycle status emitted on the live-progress stream. */
export type ConsolidationPhaseStatus = 'active' | 'done' | 'skipped' | 'failed';

/** One live-progress event: a phase changed status, optionally with counts/reason metadata. */
export interface ConsolidationPhaseEvent {
  phase: ConsolidationPhaseId;
  status: ConsolidationPhaseStatus;
  meta?: { count?: number; done?: number; total?: number; reason?: string; summary?: string };
}

/** Terminal outcome of a pass: extracted ≥1 memory, found nothing new, or failed. */
export type ConsolidationStatus = 'extracted' | 'empty' | 'failed';

/** Who initiated the pass — a manual "Run now" vs a background auto pass. */
export type ConsolidationTrigger = 'auto' | 'manual';

/** Why a pass ended in `failed`. `unavailable` = the memory DB never initialized / init failed. */
export interface ConsolidationFailure {
  kind: 'no-model' | 'error' | 'unavailable';
  detail?: string;
  /** Which phase failed, for the failure-card footer. Absent for `unavailable` (no phase reached). */
  phase?: ConsolidationPhaseId;
}

/**
 * The single terminal record of a completed consolidation pass — covering EVERY outcome (success,
 * empty, or failure). Returned by the pure pass on every code path, so a silent finish is impossible
 * by construction. `failure` is present iff `status === 'failed'`.
 */
export interface ConsolidationResult {
  ranAt: number;
  trigger: ConsolidationTrigger;
  status: ConsolidationStatus;
  extracted: ConsolidationExtractedMemory[];
  maintenance: { promoted: number; decayed: number; pruned: number };
  candidatesReviewed: number;
  failure?: ConsolidationFailure;
}
