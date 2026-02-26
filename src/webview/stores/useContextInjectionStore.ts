import { ref } from 'vue';
import { defineStore } from 'pinia';
import type { ContextInjectionDisplay, MemoryInjectionDisplay } from '@shared/types/context-injection';

export const useContextInjectionStore = defineStore('contextInjection', () => {
  const isOverlayOpen = ref(false);
  const activePromptIndex = ref(-1);
  const currentInjection = ref<ContextInjectionDisplay | null>(null);
  const currentMemoryInjection = ref<MemoryInjectionDisplay | null>(null);
  const isLoading = ref(false);

  function openOverlay(promptIndex: number): void {
    activePromptIndex.value = promptIndex;
    currentInjection.value = null;
    currentMemoryInjection.value = null;
    isLoading.value = true;
    isOverlayOpen.value = true;
  }

  function closeOverlay(): void {
    isOverlayOpen.value = false;
    isLoading.value = false;
    currentInjection.value = null;
    currentMemoryInjection.value = null;
    activePromptIndex.value = -1;
  }

  function handleInjectionLoaded(
    promptIndex: number,
    data: ContextInjectionDisplay | null,
    memoryData: MemoryInjectionDisplay | null,
  ): void {
    if (promptIndex !== activePromptIndex.value) return;
    currentInjection.value = data;
    currentMemoryInjection.value = memoryData;
    isLoading.value = false;
  }

  function $reset(): void {
    isOverlayOpen.value = false;
    activePromptIndex.value = -1;
    currentInjection.value = null;
    currentMemoryInjection.value = null;
    isLoading.value = false;
  }

  return {
    isOverlayOpen,
    activePromptIndex,
    currentInjection,
    currentMemoryInjection,
    isLoading,

    openOverlay,
    closeOverlay,
    handleInjectionLoaded,
    $reset,
  };
});
