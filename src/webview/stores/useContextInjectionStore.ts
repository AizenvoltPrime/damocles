import { computed, ref, shallowRef } from 'vue';
import { defineStore } from 'pinia';
import type { MemoryInjectionDisplay } from '@shared/types/context-injection';

export type ExecutionPhase = 'idle' | 'started' | 'memory' | 'complete';

interface MemoryOverride {
  pinned?: boolean;
  forgotten?: boolean;
}

export const useContextInjectionStore = defineStore('contextInjection', () => {
  const isOverlayOpen = ref(false);
  const activePromptIndex = ref(-1);
  const currentMemoryInjection = ref<MemoryInjectionDisplay | null>(null);
  const isLoading = ref(false);

  const executionPromptIndex = ref(-1);
  const executionPhase = ref<ExecutionPhase>('idle');
  /** The running prompt's latest display, kept whichever prompt the overlay shows. */
  const executionDisplay = shallowRef<MemoryInjectionDisplay | null>(null);
  /**
   * Pins and forgets confirmed during this conversation, applied over every record's flags. They are
   * cleared with the conversation, after which a record shows the state it recorded.
   */
  const overrides = shallowRef<ReadonlyMap<string, MemoryOverride>>(new Map());

  /** The overlay's prompt is still being built. */
  const isBuilding = computed(
    () => activePromptIndex.value === executionPromptIndex.value
      && (executionPhase.value === 'started' || executionPhase.value === 'memory'),
  );

  function openOverlay(promptIndex: number): void {
    activePromptIndex.value = promptIndex;
    isOverlayOpen.value = true;
    if (promptIndex === executionPromptIndex.value && executionPhase.value !== 'idle') {
      currentMemoryInjection.value = executionDisplay.value;
      isLoading.value = false;
      return;
    }
    currentMemoryInjection.value = null;
    isLoading.value = true;
  }

  function closeOverlay(): void {
    isOverlayOpen.value = false;
    isLoading.value = false;
  }

  function handleContextInjectionStarted(promptIndex: number): void {
    executionPromptIndex.value = promptIndex;
    executionPhase.value = 'started';
    executionDisplay.value = null;
    if (promptIndex === activePromptIndex.value) currentMemoryInjection.value = null;
  }

  function handleMemoryInjectionUpdate(promptIndex: number, data: MemoryInjectionDisplay): void {
    if (promptIndex !== executionPromptIndex.value) return;
    executionDisplay.value = data;
    executionPhase.value = 'memory';
    if (promptIndex === activePromptIndex.value) currentMemoryInjection.value = data;
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
      executionDisplay.value = memoryData;
      executionPhase.value = 'complete';
    }
  }

  function override(id: string, patch: MemoryOverride): void {
    const next = new Map(overrides.value);
    next.set(id, { ...next.get(id), ...patch });
    overrides.value = next;
  }

  function setPinned(id: string, pinned: boolean): void {
    override(id, { pinned });
  }

  function setForgotten(id: string, forgotten = true): void {
    override(id, { forgotten });
  }

  function isPinned(id: string, recorded: boolean): boolean {
    return overrides.value.get(id)?.pinned ?? recorded;
  }

  function isForgotten(id: string, recorded = false): boolean {
    return overrides.value.get(id)?.forgotten ?? recorded;
  }

  function $reset(): void {
    isOverlayOpen.value = false;
    activePromptIndex.value = -1;
    currentMemoryInjection.value = null;
    isLoading.value = false;
    executionPromptIndex.value = -1;
    executionPhase.value = 'idle';
    executionDisplay.value = null;
    overrides.value = new Map();
  }

  return {
    isOverlayOpen,
    activePromptIndex,
    currentMemoryInjection,
    isLoading,
    executionPromptIndex,
    executionPhase,
    isBuilding,
    overrides,

    openOverlay,
    closeOverlay,
    handleContextInjectionStarted,
    handleMemoryInjectionUpdate,
    handleInjectionLoaded,
    handleContextInjectionComplete,
    setPinned,
    setForgotten,
    isPinned,
    isForgotten,
    $reset,
  };
});
