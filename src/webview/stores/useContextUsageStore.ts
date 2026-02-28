import { ref } from 'vue';
import { defineStore } from 'pinia';
import type { ContextUsageData } from '@shared/types/session';

export const useContextUsageStore = defineStore('contextUsage', () => {
  const isOverlayOpen = ref(false);
  const isLoading = ref(false);
  const data = ref<ContextUsageData | null>(null);
  const failReason = ref<'busy' | 'parseFailed' | null>(null);

  function openOverlay(): void {
    data.value = null;
    failReason.value = null;
    isLoading.value = true;
    isOverlayOpen.value = true;
  }

  function closeOverlay(): void {
    isOverlayOpen.value = false;
    isLoading.value = false;
    data.value = null;
    failReason.value = null;
  }

  function handleDataLoaded(newData: ContextUsageData | null, reason?: 'busy' | 'parseFailed'): void {
    if (!isOverlayOpen.value) return;
    data.value = newData;
    failReason.value = newData ? null : (reason ?? null);
    isLoading.value = false;
  }

  function $reset(): void {
    isOverlayOpen.value = false;
    isLoading.value = false;
    data.value = null;
    failReason.value = null;
  }

  return {
    isOverlayOpen,
    isLoading,
    data,
    failReason,
    openOverlay,
    closeOverlay,
    handleDataLoaded,
    $reset,
  };
});
