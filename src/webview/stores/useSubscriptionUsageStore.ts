import { ref } from 'vue';
import { defineStore } from 'pinia';
import type { SubscriptionUsageData } from '@shared/types/usage';

export const useSubscriptionUsageStore = defineStore('subscriptionUsage', () => {
  const isOverlayOpen = ref(false);
  const isLoading = ref(false);
  const data = ref<SubscriptionUsageData | null>(null);

  function openOverlay(): void {
    data.value = null;
    isLoading.value = true;
    isOverlayOpen.value = true;
  }

  // Keep existing bars visible while re-fetching.
  function refresh(): void {
    isLoading.value = true;
  }

  function closeOverlay(): void {
    isOverlayOpen.value = false;
    isLoading.value = false;
    data.value = null;
  }

  // Drops late replies that arrive after close/session-switch.
  function handleDataLoaded(newData: SubscriptionUsageData): void {
    if (!isOverlayOpen.value) return;
    data.value = newData;
    isLoading.value = false;
  }

  function $reset(): void {
    isOverlayOpen.value = false;
    isLoading.value = false;
    data.value = null;
  }

  return {
    isOverlayOpen,
    isLoading,
    data,
    openOverlay,
    refresh,
    closeOverlay,
    handleDataLoaded,
    $reset,
  };
});
