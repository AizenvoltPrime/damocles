import { ref } from 'vue';
import { defineStore } from 'pinia';
import type { MemoryInjectionDisplay } from '@shared/types/context-injection';

export type ExecutionPhase = 'idle' | 'started' | 'memory' | 'complete';

export const useContextInjectionStore = defineStore('contextInjection', () => {
  const isOverlayOpen = ref(false);
  const activePromptIndex = ref(-1);
  const currentMemoryInjection = ref<MemoryInjectionDisplay | null>(null);
  const isLoading = ref(false);

  const executionPromptIndex = ref(-1);
  const executionPhase = ref<ExecutionPhase>('idle');

  function openOverlay(promptIndex: number): void {
    if (promptIndex === executionPromptIndex.value && executionPhase.value !== 'idle') {
      activePromptIndex.value = promptIndex;
      isOverlayOpen.value = true;
      isLoading.value = false;
      return;
    }

    activePromptIndex.value = promptIndex;
    currentMemoryInjection.value = null;
    isLoading.value = true;
    isOverlayOpen.value = true;
  }

  function closeOverlay(): void {
    isOverlayOpen.value = false;
    isLoading.value = false;
  }

  function handleContextInjectionStarted(promptIndex: number): void {
    executionPromptIndex.value = promptIndex;
    executionPhase.value = 'started';
    currentMemoryInjection.value = null;
  }

  function handleMemoryInjectionUpdate(promptIndex: number, data: MemoryInjectionDisplay): void {
    if (promptIndex !== executionPromptIndex.value) return;
    currentMemoryInjection.value = data;
    executionPhase.value = 'memory';
  }

  function handleContextInjectionComplete(promptIndex: number): void {
    if (promptIndex !== executionPromptIndex.value) return;
    executionPhase.value = 'complete';
  }

  function handleInjectionLoaded(promptIndex: number, memoryData: MemoryInjectionDisplay | null): void {
    if (promptIndex !== activePromptIndex.value) return;
    currentMemoryInjection.value = memoryData;
    isLoading.value = false;

    if (promptIndex === executionPromptIndex.value) {
      executionPhase.value = 'complete';
    }
  }

  function $reset(): void {
    isOverlayOpen.value = false;
    activePromptIndex.value = -1;
    currentMemoryInjection.value = null;
    isLoading.value = false;
    executionPromptIndex.value = -1;
    executionPhase.value = 'idle';
  }

  return {
    isOverlayOpen,
    activePromptIndex,
    currentMemoryInjection,
    isLoading,
    executionPromptIndex,
    executionPhase,

    openOverlay,
    closeOverlay,
    handleContextInjectionStarted,
    handleMemoryInjectionUpdate,
    handleInjectionLoaded,
    handleContextInjectionComplete,
    $reset,
  };
});
