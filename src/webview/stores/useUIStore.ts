import { ref } from 'vue';
import { defineStore } from 'pinia';
import type { ChatMessage, RewindHistoryItem, IdeContextDisplayInfo } from '@shared/types/session';

type RewindSource = 'picker' | 'bubble' | null;

export type ExpandedToolSource = 'session' | 'subagent' | 'team';

export const useUIStore = defineStore('ui', () => {
  const isProcessing = ref(false);
  const isAtBottom = ref(true);
  const showSettingsPanel = ref(false);
  const showMcpPanel = ref(false);
  const showToolsPanel = ref(false);
  const currentRunningTool = ref<string | null>(null);
  const showRewindTypeModal = ref(false);
  const showRewindBrowser = ref(false);
  const rewindHistoryItems = ref<RewindHistoryItem[]>([]);
  const rewindHistoryLoading = ref(false);
  const rewindCanFork = ref(true);
  const selectedRewindItem = ref<RewindHistoryItem | null>(null);
  const rewindSource = ref<RewindSource>(null);
  const rewindMetadataLoading = ref(false);
  const tasksPanelCollapsed = ref(false);
  const showMemoryPanel = ref(false);
  // The source tags which store owns the call; the id alone is not unique across stores.
  const expandedToolId = ref<string | null>(null);
  const expandedToolSource = ref<ExpandedToolSource | null>(null);
  const ideContext = ref<IdeContextDisplayInfo | null>(null);
  const ideContextEnabled = ref(true);
  // Workspace default (damocles.ideContext.enabled); seeds new conversations.
  const ideContextDefaultEnabled = ref(true);
  // True once the user toggled the chip in this conversation — then the default no longer applies.
  const ideContextUserOverride = ref(false);
  const isCompacting = ref(false);
  const activeHooks = ref<Map<string, { hookName: string; hookEvent: string }>>(new Map());
  const lastCheckpointTime = ref<number | null>(null);
  const authFailureMessage = ref<string | null>(null);

  function setProcessing(value: boolean) {
    isProcessing.value = value;
    if (!value) {
      activeHooks.value = new Map();
    }
  }

  function setIsAtBottom(value: boolean) {
    isAtBottom.value = value;
  }

  function setCurrentRunningTool(name: string | null) {
    currentRunningTool.value = name;
  }

  function openSettingsPanel() {
    showSettingsPanel.value = true;
  }

  function closeSettingsPanel() {
    showSettingsPanel.value = false;
  }

  function openMcpPanel(): boolean {
    if (isProcessing.value) return false;
    showMcpPanel.value = true;
    return true;
  }

  function closeMcpPanel() {
    showMcpPanel.value = false;
  }

  function openToolsPanel(): boolean {
    if (isProcessing.value) return false;
    showToolsPanel.value = true;
    return true;
  }

  function closeToolsPanel() {
    showToolsPanel.value = false;
  }

  function closeRewindTypeModal() {
    showRewindTypeModal.value = false;
  }

  function openRewindBrowser() {
    rewindSource.value = 'picker';
    showRewindBrowser.value = true;
    rewindHistoryLoading.value = true;
  }

  function closeRewindBrowser() {
    showRewindBrowser.value = false;
    rewindHistoryLoading.value = false;
    rewindHistoryItems.value = [];
    if (rewindSource.value === 'picker' && !showRewindTypeModal.value) {
      rewindSource.value = null;
    }
  }

  function startDirectRewind(message: ChatMessage) {
    if (!message.sdkMessageId) return;
    rewindSource.value = 'bubble';
    selectedRewindItem.value = {
      messageId: message.sdkMessageId,
      content: message.content ?? '',
      timestamp: message.timestamp,
      filesAffected: 0,
    };
    rewindMetadataLoading.value = true;
    showRewindTypeModal.value = true;
  }

  function startDirectCompactionRewind(entryId: string, timestamp: number) {
    rewindSource.value = 'bubble';
    selectedRewindItem.value = {
      kind: 'compaction',
      messageId: entryId,
      content: '',
      timestamp,
      filesAffected: 0,
    };
    rewindMetadataLoading.value = true;
    showRewindTypeModal.value = true;
  }

  function setRewindHistory(items: RewindHistoryItem[], canFork: boolean) {
    rewindCanFork.value = canFork;
    if (rewindSource.value === 'bubble' && selectedRewindItem.value && showRewindTypeModal.value) {
      const match = items.find((item) => item.messageId === selectedRewindItem.value!.messageId);
      if (match) selectedRewindItem.value = match;
      rewindMetadataLoading.value = false;
      return;
    }
    rewindHistoryItems.value = items;
    rewindHistoryLoading.value = false;
  }

  function selectRewindItem(item: RewindHistoryItem) {
    selectedRewindItem.value = item;
    showRewindBrowser.value = false;
    showRewindTypeModal.value = true;
  }

  function cancelTypeSelection() {
    showRewindTypeModal.value = false;
    rewindMetadataLoading.value = false;
    selectedRewindItem.value = null;

    if (rewindSource.value === 'bubble') {
      rewindSource.value = null;
      return;
    }
    showRewindBrowser.value = true;
  }

  function cancelRewind() {
    selectedRewindItem.value = null;
    rewindMetadataLoading.value = false;
    rewindSource.value = null;
  }

  function setTasksPanelCollapsed(collapsed: boolean) {
    tasksPanelCollapsed.value = collapsed;
  }

  function openMemoryPanel() {
    showMemoryPanel.value = true;
  }

  function closeMemoryPanel() {
    showMemoryPanel.value = false;
  }

  function expandTool(toolId: string, source: ExpandedToolSource) {
    expandedToolId.value = toolId;
    expandedToolSource.value = source;
  }

  function collapseTool() {
    expandedToolId.value = null;
    expandedToolSource.value = null;
  }

  function setIdeContext(context: IdeContextDisplayInfo | null) {
    ideContext.value = context;
  }

  function toggleIdeContext() {
    ideContextEnabled.value = !ideContextEnabled.value;
    ideContextUserOverride.value = true;
  }

  function setIdeContextDefault(enabled: boolean) {
    ideContextDefaultEnabled.value = enabled;
    if (!ideContextUserOverride.value) {
      ideContextEnabled.value = enabled;
    }
  }

  function setCompacting(value: boolean) {
    isCompacting.value = value;
  }

  function setHookActive(hookId: string, hookName: string, hookEvent: string) {
    const updated = new Map(activeHooks.value);
    updated.set(hookId, { hookName, hookEvent });
    activeHooks.value = updated;
  }

  function removeHook(hookId: string) {
    const updated = new Map(activeHooks.value);
    updated.delete(hookId);
    activeHooks.value = updated;
  }

  function setLastCheckpointTime(time: number) {
    lastCheckpointTime.value = time;
  }

  function setAuthFailure(message: string) {
    authFailureMessage.value = message;
  }

  function dismissAuthFailure() {
    authFailureMessage.value = null;
  }

  function $reset() {
    isProcessing.value = false;
    isAtBottom.value = true;
    showSettingsPanel.value = false;
    showMcpPanel.value = false;
    showToolsPanel.value = false;
    showMemoryPanel.value = false;
    expandedToolId.value = null;
    expandedToolSource.value = null;
    currentRunningTool.value = null;
    showRewindTypeModal.value = false;
    showRewindBrowser.value = false;
    rewindHistoryItems.value = [];
    rewindHistoryLoading.value = false;
    rewindCanFork.value = true;
    selectedRewindItem.value = null;
    rewindSource.value = null;
    rewindMetadataLoading.value = false;
    tasksPanelCollapsed.value = false;
    ideContext.value = null;
    ideContextEnabled.value = ideContextDefaultEnabled.value;
    ideContextUserOverride.value = false;
    isCompacting.value = false;
    activeHooks.value = new Map();
    lastCheckpointTime.value = null;
    authFailureMessage.value = null;
  }

  return {
    isProcessing,
    isAtBottom,
    showSettingsPanel,
    showMcpPanel,
    currentRunningTool,
    showRewindTypeModal,
    showRewindBrowser,
    rewindHistoryItems,
    rewindHistoryLoading,
    rewindCanFork,
    selectedRewindItem,
    rewindSource,
    rewindMetadataLoading,
    startDirectRewind,
    startDirectCompactionRewind,
    setProcessing,
    setIsAtBottom,
    setCurrentRunningTool,
    openSettingsPanel,
    closeSettingsPanel,
    openMcpPanel,
    closeMcpPanel,
    showToolsPanel,
    openToolsPanel,
    closeToolsPanel,
    closeRewindTypeModal,
    openRewindBrowser,
    closeRewindBrowser,
    setRewindHistory,
    selectRewindItem,
    cancelTypeSelection,
    cancelRewind,
    showMemoryPanel,
    openMemoryPanel,
    closeMemoryPanel,
    expandedToolId,
    expandedToolSource,
    expandTool,
    collapseTool,
    tasksPanelCollapsed,
    setTasksPanelCollapsed,
    ideContext,
    ideContextEnabled,
    ideContextDefaultEnabled,
    ideContextUserOverride,
    setIdeContext,
    toggleIdeContext,
    setIdeContextDefault,
    isCompacting,
    activeHooks,
    lastCheckpointTime,
    authFailureMessage,
    setCompacting,
    setHookActive,
    removeHook,
    setLastCheckpointTime,
    setAuthFailure,
    dismissAuthFailure,
    $reset,
  };
});
