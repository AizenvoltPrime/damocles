import { defineStore } from 'pinia';
import { ref } from 'vue';
import type { PendingConsolidationCandidate, ConsolidationResult } from '@shared/types/consolidation';

/**
 * Drives the memory-consolidation header pill + overlay: the live pending count, the preview of
 * turns queued for the next pass, the manual-run state, and the last pass's extracted result.
 */
export const useConsolidationStore = defineStore('consolidation', () => {
  const isOverlayOpen = ref(false);
  const pendingCount = ref(0);
  const pendingCandidates = ref<PendingConsolidationCandidate[]>([]);
  const isRunning = ref(false);
  const lastResult = ref<ConsolidationResult | null>(null);

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
  function setRunning(running: boolean): void {
    isRunning.value = running;
  }
  function setResult(result: ConsolidationResult): void {
    lastResult.value = result;
  }

  function $reset(): void {
    isOverlayOpen.value = false;
    pendingCount.value = 0;
    pendingCandidates.value = [];
    isRunning.value = false;
    lastResult.value = null;
  }

  return {
    isOverlayOpen,
    pendingCount,
    pendingCandidates,
    isRunning,
    lastResult,
    openOverlay,
    closeOverlay,
    setPendingCount,
    setPreview,
    setRunning,
    setResult,
    $reset,
  };
});
