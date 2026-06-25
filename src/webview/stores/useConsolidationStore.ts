import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import type {
  PendingConsolidationCandidate,
  ConsolidationResult,
  ConsolidationPhaseId,
  ConsolidationPhaseStatus,
  ConsolidationPhaseEvent,
} from '@shared/types/consolidation';

/** Phase the UI is currently showing. `idle` before any run; `done`/`failed` after a terminal result. */
export type ConsolidationUiPhase = 'idle' | ConsolidationPhaseId | 'done' | 'failed';

/** Per-phase stepper status; `pending` = not yet reached this pass. */
export type StepperStatus = ConsolidationPhaseStatus | 'pending';

const PHASE_IDS: ConsolidationPhaseId[] = ['claim', 'extract', 'persist', 'maintain', 'profiles'];

/** Trailing-text metadata a phase event carries (counts for done rows, reasons for skipped/failed). */
export type PhaseMeta = NonNullable<ConsolidationPhaseEvent['meta']>;

function freshPhaseStatus(): Record<ConsolidationPhaseId, StepperStatus> {
  return { claim: 'pending', extract: 'pending', persist: 'pending', maintain: 'pending', profiles: 'pending' };
}

function freshPhaseMeta(): Record<ConsolidationPhaseId, PhaseMeta> {
  return { claim: {}, extract: {}, persist: {}, maintain: {}, profiles: {} };
}

/**
 * Drives the memory-consolidation header pill + overlay: the live pending count, the preview of
 * turns queued for the next pass, a phase state machine for the live stepper, determinate persist
 * progress, and the last pass's terminal result.
 */
export const useConsolidationStore = defineStore('consolidation', () => {
  const isOverlayOpen = ref(false);
  const pendingCount = ref(0);
  const pendingCandidates = ref<PendingConsolidationCandidate[]>([]);
  const lastResult = ref<ConsolidationResult | null>(null);

  const phase = ref<ConsolidationUiPhase>('idle');
  const phaseStatus = ref<Record<ConsolidationPhaseId, StepperStatus>>(freshPhaseStatus());
  const phaseMeta = ref<Record<ConsolidationPhaseId, PhaseMeta>>(freshPhaseMeta());
  const persistProgress = ref<{ done: number; total: number }>({ done: 0, total: 0 });

  /** Running = a pass is mid-flight (between Claim and the terminal result). Derived so existing
   *  `isRunning` consumers keep working without a separate flag to desync. */
  const isRunning = computed(() => phase.value !== 'idle' && phase.value !== 'done' && phase.value !== 'failed');

  function openOverlay(): void {
    isOverlayOpen.value = true;
  }
  function closeOverlay(): void {
    isOverlayOpen.value = false;
  }

  function setPendingCount(count: number): void {
    pendingCount.value = count;
  }
  function setPreview(candidates: PendingConsolidationCandidate[]): void {
    pendingCandidates.value = candidates;
  }

  /** New pass starting: reset the stepper to all-pending and clear persist state. */
  function startRun(): void {
    phaseStatus.value = freshPhaseStatus();
    phaseMeta.value = freshPhaseMeta();
    persistProgress.value = { done: 0, total: 0 };
    phase.value = 'claim';
  }

  /** Doherty-threshold ack: flip to a live stepper with Claim active before the backend round-trip. */
  function ackManualRun(): void {
    startRun();
    phaseStatus.value = { ...freshPhaseStatus(), claim: 'active' };
  }

  function setRunning(running: boolean): void {
    if (running) {
      // Only reset the stepper when a pass is NOT already running. The backend replays
      // `consolidationRunning:true` on every overlay (re)open; resetting unconditionally would blank
      // the completed phases of an in-flight pass, leaving a half-empty stepper on mid-pass reopen.
      if (!isRunning.value) startRun();
    } else if (isRunning.value) {
      // ORDERING CONTRACT: the backend always sends the terminal `consolidationResult` BEFORE
      // `consolidationRunning:false`. A real terminal result calls `setResult`, which moves `phase`
      // to `done`/`failed` — making `isRunning` false — so by the time `running:false` arrives this
      // branch is a no-op and the result is preserved. This branch only fires defensively when
      // `running:false` arrives with NO terminal result (e.g. a future reorder or a dropped result):
      // settle to idle so the spinner clears rather than spinning forever. If that contract is ever
      // reordered, this guard prevents a stranded spinner but cannot recover the lost result — keep
      // the result-before-running:false ordering intact on the backend.
      phase.value = 'idle';
    }
  }

  /**
   * Settle an optimistic / in-flight run out of "running" without fabricating a terminal result.
   * Used when a `memoryError` arrives mid-run (e.g. "Run now" while memory is disabled, which the
   * backend answers with ONLY a `memoryError` — no terminal `consolidationResult`). Settling to
   * `idle` (rather than `failed`) re-enables "Run now" and clears the spinner; the accompanying error
   * toast communicates the failure, and the failure *card* is intentionally not shown because it
   * requires a real `ConsolidationResult` we must not invent. Last good `lastResult`/queue/pending
   * state is untouched — only the live-run phase machine is reset. No-op when no run is in flight, so
   * unrelated memory errors (e.g. from `requestMemories`) do nothing here.
   */
  function abortRun(): void {
    if (!isRunning.value) return;
    phase.value = 'idle';
    phaseStatus.value = freshPhaseStatus();
    phaseMeta.value = freshPhaseMeta();
    persistProgress.value = { done: 0, total: 0 };
  }

  function applyProgress(event: ConsolidationPhaseEvent): void {
    phaseStatus.value = { ...phaseStatus.value, [event.phase]: event.status };
    if (event.meta) phaseMeta.value = { ...phaseMeta.value, [event.phase]: event.meta };
    if (event.status === 'active') phase.value = event.phase;
    if (event.phase === 'persist' && event.meta) {
      persistProgress.value = { done: event.meta.done ?? 0, total: event.meta.total ?? 0 };
    }
  }

  function setResult(result: ConsolidationResult): void {
    lastResult.value = result;
    phase.value = result.status === 'failed' ? 'failed' : 'done';
  }

  function $reset(): void {
    isOverlayOpen.value = false;
    pendingCount.value = 0;
    pendingCandidates.value = [];
    lastResult.value = null;
    phase.value = 'idle';
    phaseStatus.value = freshPhaseStatus();
    phaseMeta.value = freshPhaseMeta();
    persistProgress.value = { done: 0, total: 0 };
  }

  return {
    isOverlayOpen,
    pendingCount,
    pendingCandidates,
    lastResult,
    phase,
    phaseStatus,
    phaseMeta,
    persistProgress,
    isRunning,
    phaseIds: PHASE_IDS,
    openOverlay,
    closeOverlay,
    setPendingCount,
    setPreview,
    startRun,
    ackManualRun,
    setRunning,
    abortRun,
    applyProgress,
    setResult,
    $reset,
  };
});
