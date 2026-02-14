import { ref } from 'vue';
import { defineStore } from 'pinia';
import type { ContextInjectionDisplay } from '@shared/types/context-injection';

export const useContextInjectionStore = defineStore('contextInjection', () => {
  const isOverlayOpen = ref(false);
  const activePromptIndex = ref(-1);
  const currentInjection = ref<ContextInjectionDisplay | null>(null);
  const isLoading = ref(false);

  function openOverlay(promptIndex: number): void {
    activePromptIndex.value = promptIndex;
    currentInjection.value = null;
    isLoading.value = true;
    isOverlayOpen.value = true;
  }

  function closeOverlay(): void {
    isOverlayOpen.value = false;
    isLoading.value = false;
    currentInjection.value = null;
    activePromptIndex.value = -1;
  }

  function handleInjectionLoaded(promptIndex: number, data: ContextInjectionDisplay | null): void {
    if (promptIndex !== activePromptIndex.value) return;
    currentInjection.value = data;
    isLoading.value = false;
  }

  function $reset(): void {
    isOverlayOpen.value = false;
    activePromptIndex.value = -1;
    currentInjection.value = null;
    isLoading.value = false;
  }

  return {
    isOverlayOpen,
    activePromptIndex,
    currentInjection,
    isLoading,

    openOverlay,
    closeOverlay,
    handleInjectionLoaded,
    $reset,
  };
});
