import { ref, computed } from 'vue';
import { defineStore } from 'pinia';
import { useVSCode } from '@/composables/useVSCode';
import type { TaskNodeDisplay, NodeTurnDisplay, RelatedNodeSummaryCard } from '@shared/types/recall';

export const useNodeStore = defineStore('nodes', () => {
  const nodes = ref<TaskNodeDisplay[]>([]);
  const activeNodeId = ref<string | null>(null);

  const isPickerOpen = ref(false);
  const pickerNodes = ref<Array<{
    nodeId: string;
    title: string;
    turnCount: number;
    entityTags: string[];
    lastActivityAge: string;
  }>>([]);
  const pickerCanCreateNew = ref(true);
  const createdPreview = ref<{ nodeId: string; title: string; keyEntities: string[] } | null>(null);

  const showClosePrompt = ref(false);
  const closePromptNodeId = ref<string | null>(null);
  const closePromptTitle = ref('');
  const isClosingNode = ref(false);
  const closingNodeIds = ref(new Set<string>());

  const isOverlayOpen = ref(false);
  const selectedNodeId = ref<string | null>(null);
  const selectedNodeTurns = ref<NodeTurnDisplay[]>([]);
  const selectedNodeSeedContext = ref<string | null>(null);
  const selectedNodeRelatedNodes = ref<RelatedNodeSummaryCard[]>([]);
  const isLoadingTurns = ref(false);

  const activeNodes = computed(() => nodes.value.filter(n => n.status === 'ACTIVE'));
  const closedNodes = computed(() => nodes.value.filter(n => n.status === 'CLOSED'));
  const currentNode = computed(() => activeNodeId.value ? nodes.value.find(n => n.nodeId === activeNodeId.value) : null);
  const selectedNode = computed(() => selectedNodeId.value ? nodes.value.find(n => n.nodeId === selectedNodeId.value) : null);

  const pickerPreSelectedNodeId = ref<string | null>(null);

  function openOverlay(): void {
    isOverlayOpen.value = true;
    selectedNodeId.value = null;
    selectedNodeTurns.value = [];
    selectedNodeSeedContext.value = null;
    selectedNodeRelatedNodes.value = [];
  }

  function closeOverlay(): void {
    isOverlayOpen.value = false;
    selectedNodeId.value = null;
    selectedNodeTurns.value = [];
    selectedNodeSeedContext.value = null;
    selectedNodeRelatedNodes.value = [];
    isLoadingTurns.value = false;
  }

  function viewNodeDetail(nodeId: string): void {
    selectedNodeId.value = nodeId;
    selectedNodeTurns.value = [];
    selectedNodeSeedContext.value = null;
    selectedNodeRelatedNodes.value = [];
    isLoadingTurns.value = true;
    useVSCode().postMessage({ type: 'requestNodeTurns', nodeId });
  }

  function backToList(): void {
    selectedNodeId.value = null;
    selectedNodeTurns.value = [];
    selectedNodeSeedContext.value = null;
    selectedNodeRelatedNodes.value = [];
    isLoadingTurns.value = false;
  }

  function handleNodeTurnsLoaded(
    nodeId: string,
    turns: NodeTurnDisplay[],
    seedContext: string | null,
    relatedNodes: RelatedNodeSummaryCard[],
  ): void {
    if (nodeId !== selectedNodeId.value) return;
    selectedNodeTurns.value = turns;
    selectedNodeSeedContext.value = seedContext;
    selectedNodeRelatedNodes.value = relatedNodes;
    isLoadingTurns.value = false;
  }

  function openPicker(data: {
    activeNodes: Array<{ nodeId: string; title: string; turnCount: number; entityTags: string[]; lastActivityAge: string }>;
    canCreateNew: boolean;
    currentActiveNodeId?: string | null;
  }): void {
    pickerNodes.value = data.activeNodes;
    pickerCanCreateNew.value = data.canCreateNew;
    pickerPreSelectedNodeId.value = data.currentActiveNodeId ?? null;
    createdPreview.value = null;
    isPickerOpen.value = true;
  }

  function selectNode(nodeId: string): void {
    isPickerOpen.value = false;
    createdPreview.value = null;
    useVSCode().postMessage({ type: 'node-selected', nodeId });
  }

  function requestNewNode(): void {
    useVSCode().postMessage({ type: 'new-node-requested' });
  }

  function handleCreatedPreview(data: { nodeId: string; title: string; keyEntities: string[] }): void {
    createdPreview.value = data;
  }

  function cancelPicker(): void {
    isPickerOpen.value = false;
    createdPreview.value = null;
    useVSCode().postMessage({ type: 'node-picker-cancelled' });
  }

  function handleNodeStateUpdated(data: { nodes: TaskNodeDisplay[]; activeNodeId: string | null }): void {
    nodes.value = data.nodes;
    activeNodeId.value = data.activeNodeId;
  }

  function openClosePrompt(nodeId: string, title: string): void {
    closePromptNodeId.value = nodeId;
    closePromptTitle.value = title;
    showClosePrompt.value = true;
    isClosingNode.value = false;
  }

  function confirmCloseNode(outcome: 'resolved' | 'partial' | 'abandoned'): void {
    if (!closePromptNodeId.value) return;
    isClosingNode.value = true;
    useVSCode().postMessage({ type: 'close-node-request', nodeId: closePromptNodeId.value, outcome });
  }

  function handleNodeClosed(nodeId?: string): void {
    showClosePrompt.value = false;
    closePromptNodeId.value = null;
    isClosingNode.value = false;
    if (nodeId) {
      const next = new Set(closingNodeIds.value);
      next.delete(nodeId);
      closingNodeIds.value = next;
    }
  }

  function dismissClosePrompt(): void {
    showClosePrompt.value = false;
    closePromptNodeId.value = null;
    isClosingNode.value = false;
    useVSCode().postMessage({ type: 'dismiss-node-close-prompt' });
  }

  function closeNodeFromDashboard(nodeId: string, outcome: 'resolved' | 'partial' | 'abandoned'): void {
    closingNodeIds.value = new Set([...closingNodeIds.value, nodeId]);
    useVSCode().postMessage({ type: 'close-node-request', nodeId, outcome });
  }

  function reopenNode(nodeId: string): void {
    useVSCode().postMessage({ type: 'reopen-node-request', nodeId });
  }

  function disconnectNodeRelation(nodeId: string, relatedNodeId: string): void {
    useVSCode().postMessage({ type: 'disconnect-node-relation', nodeId, relatedNodeId });
  }

  function $reset(): void {
    nodes.value = [];
    activeNodeId.value = null;
    isPickerOpen.value = false;
    pickerNodes.value = [];
    pickerCanCreateNew.value = true;
    pickerPreSelectedNodeId.value = null;
    createdPreview.value = null;
    showClosePrompt.value = false;
    closePromptNodeId.value = null;
    closePromptTitle.value = '';
    isClosingNode.value = false;
    closingNodeIds.value = new Set();
    isOverlayOpen.value = false;
    selectedNodeId.value = null;
    selectedNodeTurns.value = [];
    selectedNodeSeedContext.value = null;
    selectedNodeRelatedNodes.value = [];
    isLoadingTurns.value = false;
  }

  return {
    nodes,
    activeNodeId,
    isPickerOpen,
    pickerNodes,
    pickerCanCreateNew,
    pickerPreSelectedNodeId,
    createdPreview,
    showClosePrompt,
    closePromptNodeId,
    closePromptTitle,
    isClosingNode,
    closingNodeIds,

    isOverlayOpen,
    selectedNodeId,
    selectedNodeTurns,
    selectedNodeSeedContext,
    selectedNodeRelatedNodes,
    isLoadingTurns,

    activeNodes,
    closedNodes,
    currentNode,
    selectedNode,

    openOverlay,
    closeOverlay,
    viewNodeDetail,
    backToList,
    handleNodeTurnsLoaded,
    openPicker,
    selectNode,
    requestNewNode,
    handleCreatedPreview,
    cancelPicker,
    handleNodeStateUpdated,
    openClosePrompt,
    confirmCloseNode,
    handleNodeClosed,
    dismissClosePrompt,
    closeNodeFromDashboard,
    reopenNode,
    disconnectNodeRelation,
    $reset,
  };
});
