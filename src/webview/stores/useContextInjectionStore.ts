import { ref } from 'vue';
import { defineStore } from 'pinia';
import type { MemoryInjectionDisplay } from '@shared/types/context-injection';
import type { RecallTrajectory, RecallIteration } from '@shared/types/recall';
import type { GraphExecutionSnapshot } from '@shared/types/graph';

export type ExecutionPhase = 'idle' | 'started' | 'graph' | 'recall' | 'memory' | 'complete';
export type TabId = 'graph' | 'recall' | 'memory';

export const useContextInjectionStore = defineStore('contextInjection', () => {
  const isOverlayOpen = ref(false);
  const activePromptIndex = ref(-1);
  const currentInjection = ref<RecallTrajectory | null>(null);
  const currentMemoryInjection = ref<MemoryInjectionDisplay | null>(null);
  const currentGraphSnapshot = ref<GraphExecutionSnapshot | null>(null);
  const liveGraphState = ref<GraphExecutionSnapshot | null>(null);
  const isGraphLive = ref(false);
  const selectedGraphNode = ref<string | null>(null);
  const isLoading = ref(false);

  const executionPromptIndex = ref(-1);
  const executionPhase = ref<ExecutionPhase>('idle');
  const liveIterations = ref<RecallIteration[]>([]);
  const userTabOverride = ref(false);
  const activeTab = ref<TabId>('recall');
  const technicalView = ref(false);

  function openOverlay(promptIndex: number): void {
    userTabOverride.value = false;

    if (promptIndex === executionPromptIndex.value && executionPhase.value !== 'idle') {
      activePromptIndex.value = promptIndex;
      isOverlayOpen.value = true;
      isLoading.value = false;
      if (liveGraphState.value || currentGraphSnapshot.value) {
        activeTab.value = 'graph';
      } else if (currentInjection.value || liveIterations.value.length > 0) {
        activeTab.value = 'recall';
      }
      return;
    }

    activePromptIndex.value = promptIndex;
    currentInjection.value = null;
    currentMemoryInjection.value = null;
    currentGraphSnapshot.value = null;
    liveGraphState.value = null;
    isGraphLive.value = false;
    selectedGraphNode.value = null;
    liveIterations.value = [];
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
    liveGraphState.value = null;
    isGraphLive.value = false;
    currentInjection.value = null;
    currentMemoryInjection.value = null;
    currentGraphSnapshot.value = null;
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
    graphData: GraphExecutionSnapshot | null,
  ): void {
    if (promptIndex !== activePromptIndex.value) return;
    currentInjection.value = data;
    currentMemoryInjection.value = memoryData;
    currentGraphSnapshot.value = graphData;
    if (graphData) {
      liveGraphState.value = null;
      isGraphLive.value = false;
    }
    isLoading.value = false;

    if (promptIndex === executionPromptIndex.value) {
      executionPhase.value = 'complete';
    }

    if (!userTabOverride.value) {
      if (graphData) activeTab.value = 'graph';
      else if (data) activeTab.value = 'recall';
    }
  }

  function handleGraphExecutionUpdate(promptIndex: number, snapshot: GraphExecutionSnapshot): void {
    if (promptIndex !== executionPromptIndex.value) return;
    liveGraphState.value = snapshot;
    isGraphLive.value = snapshot.currentNode !== null;
    executionPhase.value = 'graph';
    if (snapshot.currentNode === null) {
      currentGraphSnapshot.value = snapshot;
      isGraphLive.value = false;
    }
    if (snapshot.currentNode) {
      selectedGraphNode.value = snapshot.currentNode;
    } else {
      const lastCompleted = [...snapshot.nodeStates]
        .reverse()
        .find(ns => ns.status === 'completed' && ns.name !== '__start__' && ns.name !== '__end__');
      if (lastCompleted) {
        selectedGraphNode.value = lastCompleted.name;
      }
    }
    if (isOverlayOpen.value && !userTabOverride.value) {
      activeTab.value = 'graph';
    }
  }

  function selectGraphNode(nodeName: string | null): void {
    selectedGraphNode.value = nodeName;
  }

  function setActiveTab(tab: TabId): void {
    activeTab.value = tab;
    userTabOverride.value = true;
  }

  function toggleTechnicalView(): void {
    technicalView.value = !technicalView.value;
  }

  function $reset(): void {
    isOverlayOpen.value = false;
    activePromptIndex.value = -1;
    currentInjection.value = null;
    currentMemoryInjection.value = null;
    currentGraphSnapshot.value = null;
    liveGraphState.value = null;
    isGraphLive.value = false;
    selectedGraphNode.value = null;
    isLoading.value = false;
    executionPromptIndex.value = -1;
    executionPhase.value = 'idle';
    liveIterations.value = [];
    userTabOverride.value = false;
    activeTab.value = 'recall';
    technicalView.value = false;
  }

  return {
    isOverlayOpen,
    activePromptIndex,
    currentInjection,
    currentMemoryInjection,
    currentGraphSnapshot,
    liveGraphState,
    isGraphLive,
    selectedGraphNode,
    isLoading,
    executionPromptIndex,
    executionPhase,
    liveIterations,
    userTabOverride,
    activeTab,
    technicalView,

    openOverlay,
    closeOverlay,
    handleContextInjectionStarted,
    handleRecallIterationUpdate,
    handleRecallCompleted,
    handleMemoryInjectionUpdate,
    handleInjectionLoaded,
    handleGraphExecutionUpdate,
    selectGraphNode,
    setActiveTab,
    handleContextInjectionComplete,
    toggleTechnicalView,
    $reset,
  };
});
