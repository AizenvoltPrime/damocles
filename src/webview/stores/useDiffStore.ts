import { ref } from 'vue';
import { defineStore } from 'pinia';
import type { FileDiffSource } from '@/utils/parseUnifiedDiff';

export interface ExpandedDiff {
  filePath: string;
  tool: 'Edit' | 'Write';
  /** The same source the card that opened it renders, so the two show the same lines and numbers. */
  source: FileDiffSource;
}

export const useDiffStore = defineStore('diff', () => {
  const expandedDiff = ref<ExpandedDiff | null>(null);

  function expandDiff(diff: ExpandedDiff): void {
    expandedDiff.value = diff;
  }

  function collapseDiff(): void {
    expandedDiff.value = null;
  }

  function $reset(): void {
    expandedDiff.value = null;
  }

  return {
    expandedDiff,
    expandDiff,
    collapseDiff,
    $reset,
  };
});
