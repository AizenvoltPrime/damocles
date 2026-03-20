import { ref, computed } from 'vue';
import { defineStore } from 'pinia';
import { useVSCode } from '@/composables/useVSCode';
import type { TaskNodeDisplay, NodeTurnDisplay, RelatedNodeSummaryCard, NodeRecallAttempt } from '@shared/types/recall';

export const useNodeStore = defineStore('nodes', () => {
  const nodes = ref<TaskNodeDisplay[]>([]);
  const activeNodeId = ref<string | null>(null);
  const pendingNewNode = ref(false);

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
  const selectedNodeSeedContextPrompt = ref<string | null>(null);
  const selectedNodeRelatedNodes = ref<RelatedNodeSummaryCard[]>([]);
  const selectedNodeRecallAttempts = ref<NodeRecallAttempt[]>([]);
  const isLoadingTurns = ref(false);
  const isRegeneratingSeedContext = ref(false);

  const activeNodes = computed(() => nodes.value.filter(n => n.status === 'ACTIVE'));
  const closedNodes = computed(() => nodes.value.filter(n => n.status === 'CLOSED'));
  const activeNode = computed(() => activeNodeId.value ? nodes.value.find(n => n.nodeId === activeNodeId.value) : null);
  const selectedNode = computed(() => selectedNodeId.value ? nodes.value.find(n => n.nodeId === selectedNodeId.value) : null);

  function openOverlay(): void {
    isOverlayOpen.value = true;
    selectedNodeId.value = null;
    selectedNodeTurns.value = [];
    selectedNodeSeedContext.value = null;
    selectedNodeSeedContextPrompt.value = null;
    selectedNodeRelatedNodes.value = [];
    selectedNodeRecallAttempts.value = [];
  }

  function closeOverlay(): void {
    isOverlayOpen.value = false;
    selectedNodeId.value = null;
    selectedNodeTurns.value = [];
    selectedNodeSeedContext.value = null;
    selectedNodeSeedContextPrompt.value = null;
    selectedNodeRelatedNodes.value = [];
    selectedNodeRecallAttempts.value = [];
    isLoadingTurns.value = false;
    isRegeneratingSeedContext.value = false;
  }

  function viewNodeDetail(nodeId: string): void {
    selectedNodeId.value = nodeId;
    selectedNodeTurns.value = [];
    selectedNodeSeedContext.value = null;
    selectedNodeSeedContextPrompt.value = null;
    selectedNodeRelatedNodes.value = [];
    selectedNodeRecallAttempts.value = [];
    isLoadingTurns.value = true;
    isRegeneratingSeedContext.value = false;
    useVSCode().postMessage({ type: 'requestNodeTurns', nodeId });
  }

  function backToList(): void {
    selectedNodeId.value = null;
    selectedNodeTurns.value = [];
    selectedNodeSeedContext.value = null;
    selectedNodeSeedContextPrompt.value = null;
    selectedNodeRelatedNodes.value = [];
    selectedNodeRecallAttempts.value = [];
    isLoadingTurns.value = false;
    isRegeneratingSeedContext.value = false;
  }

  function handleNodeTurnsLoaded(
    nodeId: string,
    turns: NodeTurnDisplay[],
    seedContext: string | null,
    seedContextPrompt: string | null,
    relatedNodes: RelatedNodeSummaryCard[],
    recallAttempts: NodeRecallAttempt[],
  ): void {
    if (nodeId !== selectedNodeId.value) return;
    selectedNodeTurns.value = turns;
    selectedNodeSeedContext.value = seedContext;
    selectedNodeSeedContextPrompt.value = seedContextPrompt;
    selectedNodeRelatedNodes.value = relatedNodes;
    selectedNodeRecallAttempts.value = recallAttempts;
    isLoadingTurns.value = false;
    isRegeneratingSeedContext.value = false;
  }

  function setActiveNode(nodeId: string): void {
    useVSCode().postMessage({ type: 'set-active-node', nodeId });
  }

  function requestNewNode(): void {
    useVSCode().postMessage({ type: 'new-node-requested' });
  }

  function handleCreatedPreview(data: { nodeId: string; title: string; keyEntities: string[] }): void {
    createdPreview.value = data;
  }

  function handleNodeStateUpdated(data: { nodes: TaskNodeDisplay[]; activeNodeId: string | null; pendingNewNode: boolean }): void {
    nodes.value = data.nodes;
    activeNodeId.value = data.activeNodeId;
    pendingNewNode.value = data.pendingNewNode;
  }

  function regenerateSeedContext(nodeId: string, customPrompt: string): void {
    isRegeneratingSeedContext.value = true;
    useVSCode().postMessage({ type: 'regenerate-seed-context', nodeId, customPrompt });
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
    pendingNewNode.value = false;
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
    selectedNodeSeedContextPrompt.value = null;
    selectedNodeRelatedNodes.value = [];
    selectedNodeRecallAttempts.value = [];
    isLoadingTurns.value = false;
    isRegeneratingSeedContext.value = false;
  }

  return {
    nodes,
    activeNodeId,
    pendingNewNode,
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
    selectedNodeSeedContextPrompt,
    selectedNodeRelatedNodes,
    selectedNodeRecallAttempts,
    isLoadingTurns,
    isRegeneratingSeedContext,

    activeNodes,
    closedNodes,
    activeNode,
    selectedNode,

    openOverlay,
    closeOverlay,
    viewNodeDetail,
    backToList,
    handleNodeTurnsLoaded,
    setActiveNode,
    requestNewNode,
    handleCreatedPreview,
    handleNodeStateUpdated,
    regenerateSeedContext,
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
