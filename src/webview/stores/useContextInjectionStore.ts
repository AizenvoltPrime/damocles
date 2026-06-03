import { ref, computed } from 'vue';
import { defineStore } from 'pinia';
import type { MemoryInjectionDisplay } from '@shared/types/context-injection';
import type { RecallTrajectory, RecallIteration, OrientationData, OrientationPhase } from '@shared/types/recall';

export type ExecutionPhase = 'idle' | 'started' | 'recall' | 'memory' | 'complete';
export type TabId = 'recall' | 'memory' | 'nodeContext';
export type ContextViewMode = 'cards' | 'raw';

export const useContextInjectionStore = defineStore('contextInjection', () => {
  const isOverlayOpen = ref(false);
  const activePromptIndex = ref(-1);
  const currentInjection = ref<RecallTrajectory | null>(null);
  const currentMemoryInjection = ref<MemoryInjectionDisplay | null>(null);
  const isLoading = ref(false);

  const executionPromptIndex = ref(-1);
  const executionPhase = ref<ExecutionPhase>('idle');
  const liveIterations = ref<RecallIteration[]>([]);
  const liveOrientation = ref<OrientationData | null>(null);
  const orientationPhase = ref<OrientationPhase | null>(null);
  const userTabOverride = ref(false);
  const activeTab = ref<TabId>('recall');
  const contextViewMode = ref<ContextViewMode>('cards');

  const displayOrientation = computed<OrientationData | null>(() => {
    if (currentInjection.value?.orientation) return currentInjection.value.orientation;
    return liveOrientation.value;
  });

  function openOverlay(promptIndex: number): void {
    userTabOverride.value = false;

    if (promptIndex === executionPromptIndex.value && executionPhase.value !== 'idle') {
      activePromptIndex.value = promptIndex;
      isOverlayOpen.value = true;
      isLoading.value = false;
      if (currentInjection.value || liveIterations.value.length > 0) {
        activeTab.value = 'recall';
      }
      return;
    }

    activePromptIndex.value = promptIndex;
    currentInjection.value = null;
    currentMemoryInjection.value = null;
    liveIterations.value = [];
    liveOrientation.value = null;
    orientationPhase.value = null;
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
    liveIterations.value = [];
    liveOrientation.value = null;
    orientationPhase.value = null;
    currentInjection.value = null;
    currentMemoryInjection.value = null;
  }

  function handleOrientationPhaseUpdate(promptIndex: number, phase: OrientationPhase, orientation: OrientationData): void {
    if (promptIndex !== executionPromptIndex.value) return;
    orientationPhase.value = phase;
    liveOrientation.value = orientation;
    executionPhase.value = 'recall';
    if (isOverlayOpen.value && !userTabOverride.value) {
      activeTab.value = 'recall';
    }
  }

  function handleRecallIterationUpdate(promptIndex: number, iteration: RecallIteration): void {
    if (promptIndex !== executionPromptIndex.value) return;
    liveIterations.value = [...liveIterations.value, iteration];
    executionPhase.value = 'recall';
    if (isOverlayOpen.value && !userTabOverride.value) {
      activeTab.value = 'recall';
    }
  }

  function handleRecallCompleted(promptIndex: number, trajectory: RecallTrajectory): void {
    if (promptIndex !== executionPromptIndex.value) return;
    currentInjection.value = trajectory;
    liveIterations.value = [];
    liveOrientation.value = null;
    orientationPhase.value = null;
    executionPhase.value = 'memory';
  }

  function handleMemoryInjectionUpdate(promptIndex: number, data: MemoryInjectionDisplay): void {
    if (promptIndex !== executionPromptIndex.value) return;
    currentMemoryInjection.value = data;
  }

  function handleContextInjectionComplete(promptIndex: number): void {
    if (promptIndex !== executionPromptIndex.value) return;
    executionPhase.value = 'complete';
  }

  function handleInjectionLoaded(
    promptIndex: number,
    data: RecallTrajectory | null,
    memoryData: MemoryInjectionDisplay | null,
  ): void {
    if (promptIndex !== activePromptIndex.value) return;
    currentInjection.value = data;
    currentMemoryInjection.value = memoryData;
    isLoading.value = false;

    if (promptIndex === executionPromptIndex.value) {
      executionPhase.value = 'complete';
    }

    if (!userTabOverride.value) {
      activeTab.value = data ? 'recall' : memoryData ? 'memory' : 'recall';
    }
  }

  function setActiveTab(tab: TabId): void {
    activeTab.value = tab;
    userTabOverride.value = true;
  }

  function setContextViewMode(mode: ContextViewMode): void {
    contextViewMode.value = mode;
  }

  function $reset(): void {
    isOverlayOpen.value = false;
    activePromptIndex.value = -1;
    currentInjection.value = null;
    currentMemoryInjection.value = null;
    isLoading.value = false;
    executionPromptIndex.value = -1;
    executionPhase.value = 'idle';
    liveIterations.value = [];
    liveOrientation.value = null;
    orientationPhase.value = null;
    userTabOverride.value = false;
    activeTab.value = 'recall';
    contextViewMode.value = 'cards';
  }

  return {
    isOverlayOpen,
    activePromptIndex,
    currentInjection,
    currentMemoryInjection,
    isLoading,
    executionPromptIndex,
    executionPhase,
    liveIterations,
    liveOrientation,
    orientationPhase,
    displayOrientation,
    userTabOverride,
    activeTab,
    contextViewMode,

    openOverlay,
    closeOverlay,
    handleContextInjectionStarted,
    handleOrientationPhaseUpdate,
    handleRecallIterationUpdate,
    handleRecallCompleted,
    handleMemoryInjectionUpdate,
    handleInjectionLoaded,
    setActiveTab,
    setContextViewMode,
    handleContextInjectionComplete,
    $reset,
  };
});
