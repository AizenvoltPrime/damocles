import { ref } from 'vue';
import { defineStore } from 'pinia';
import type { MemoryInjectionDisplay } from '@shared/types/context-injection';
import type { RecallTrajectory } from '@shared/types/recall';
import type { GraphExecutionSnapshot } from '@shared/types/graph';

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

  function openOverlay(promptIndex: number): void {
    activePromptIndex.value = promptIndex;
    currentInjection.value = null;
    currentMemoryInjection.value = null;
    currentGraphSnapshot.value = null;
    liveGraphState.value = null;
    isGraphLive.value = false;
    selectedGraphNode.value = null;
    isLoading.value = true;
    isOverlayOpen.value = true;
  }

  function closeOverlay(): void {
    isOverlayOpen.value = false;
    isLoading.value = false;
    currentInjection.value = null;
    currentMemoryInjection.value = null;
    currentGraphSnapshot.value = null;
    liveGraphState.value = null;
    isGraphLive.value = false;
    selectedGraphNode.value = null;
    activePromptIndex.value = -1;
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
  }

  function handleGraphExecutionUpdate(promptIndex: number, snapshot: GraphExecutionSnapshot): void {
    if (!isOverlayOpen.value) return;
    if (promptIndex !== activePromptIndex.value) return;
    liveGraphState.value = snapshot;
    isGraphLive.value = snapshot.currentNode !== null;
    if (snapshot.currentNode === null) {
      currentGraphSnapshot.value = snapshot;
      isGraphLive.value = false;
    }
  }

  function selectGraphNode(nodeName: string | null): void {
    selectedGraphNode.value = nodeName;
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

    openOverlay,
    closeOverlay,
    handleInjectionLoaded,
    handleGraphExecutionUpdate,
    selectGraphNode,
    $reset,
  };
});
