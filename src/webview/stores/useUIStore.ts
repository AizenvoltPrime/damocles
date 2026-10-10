import { ref, shallowRef } from 'vue';
import { defineStore } from 'pinia';
import type { ChatMessage, RewindHistoryItem, IdeContextDisplayInfo, RestorePoint, SkippedFile, SkippedFilesTarget } from '@shared/types/session';
import type { MemoryKind } from '@shared/types/memory';
import type { TerminalAttachmentInfo } from '@shared/types/terminal-attachment';
import type { SettingsTarget } from '@shared/settings-sections';
import { usePlatformBridge } from '@/composables/usePlatformBridge';

type RewindSource = 'picker' | 'bubble' | null;

export type ExpandedToolSource = 'session' | 'subagent' | 'team';

/** The on-demand list of files a checkpoint or restore point left out. */
export type SkippedFilesState = { status: 'loading' } | { status: 'loaded'; files: SkippedFile[] } | { status: 'error' };

export function skippedFilesKey(target: SkippedFilesTarget): string {
  return target.kind === 'turn' ? `turn:${target.userEntryId}` : `restore-point:${target.id}`;
}

/** A memory the panel should scroll to and highlight once it has loaded. */
export interface MemoryPanelFocus {
  id: string;
  kind: MemoryKind;
}

export const useUIStore = defineStore('ui', () => {
  const isProcessing = ref(false);
  const showSettingsModal = ref(false);
  // The latest request for the modal, a new object each time, so asking again while it shows still selects the section.
  const settingsTarget = shallowRef<SettingsTarget | null>(null);
  const showMcpPanel = ref(false);
  const showToolsPanel = ref(false);
  const currentRunningTool = ref<string | null>(null);
  const showRewindTypeModal = ref(false);
  const showRewindBrowser = ref(false);
  const rewindHistoryItems = ref<RewindHistoryItem[]>([]);
  const rewindRestorePoints = ref<RestorePoint[]>([]);
  // Keyed by `skippedFilesKey`; a checkpoint's list never changes, so a loaded one is kept until reset.
  const skippedFiles = ref<Record<string, SkippedFilesState>>({});
  const rewindHistoryLoading = ref(false);
  const rewindCanFork = ref(true);
  const selectedRewindItem = ref<RewindHistoryItem | null>(null);
  const rewindSource = ref<RewindSource>(null);
  const rewindMetadataLoading = ref(false);
  const showMemoryPanel = ref(false);
  const memoryPanelFocus = ref<MemoryPanelFocus | null>(null);
  // The source tags which store owns the call; the id alone is not unique across stores.
  const expandedToolId = ref<string | null>(null);
  const expandedToolSource = ref<ExpandedToolSource | null>(null);
  const ideContext = ref<IdeContextDisplayInfo | null>(null);
  const ideContextEnabled = ref(true);
  // Workspace default (damocles.ideContext.enabled); seeds new conversations.
  const ideContextDefaultEnabled = ref(true);
  // True once the user toggled the chip in this conversation — then the default no longer applies.
  const ideContextUserOverride = ref(false);
  // The composer's pending terminal attachments as core holds them; core owns the list, a conversation reset keeps it.
  const terminalAttachments = shallowRef<readonly TerminalAttachmentInfo[]>([]);
  const isCompacting = ref(false);
  // Set while pi waits to re-send a failed model call; the status bar names the attempt.
  const retryStatus = ref<{ attempt: number; maxAttempts: number } | null>(null);
  const activeHooks = ref<Map<string, { hookName: string; hookEvent: string }>>(new Map());
  const lastCheckpointTime = ref<number | null>(null);
  const authFailureMessage = ref<string | null>(null);
  // The desktop window's terminal pane, for the chat header's Terminal toggle (terminalShown); its shortcut's display label.
  const terminalShown = ref(false);
  const toggleTerminalShortcut = ref('');

  function setProcessing(value: boolean) {
    isProcessing.value = value;
    if (!value) {
      activeHooks.value = new Map();
      retryStatus.value = null;
    }
  }

  function setCurrentRunningTool(name: string | null) {
    currentRunningTool.value = name;
  }

  function openSettingsModal(target: SettingsTarget = {}) {
    settingsTarget.value = { ...target };
    showSettingsModal.value = true;
  }

  function closeSettingsModal() {
    showSettingsModal.value = false;
    settingsTarget.value = null;
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

  function setRewindHistory(items: RewindHistoryItem[], restorePoints: RestorePoint[], canFork: boolean) {
    rewindCanFork.value = canFork;
    rewindRestorePoints.value = restorePoints;
    if (rewindSource.value === 'bubble' && selectedRewindItem.value && showRewindTypeModal.value) {
      const match = items.find((item) => item.messageId === selectedRewindItem.value!.messageId);
      if (match) selectedRewindItem.value = match;
      rewindMetadataLoading.value = false;
      return;
    }
    rewindHistoryItems.value = items;
    rewindHistoryLoading.value = false;
  }

  /** Ask the host for a skipped list unless it is loaded or loading; a failed load is asked again. */
  function requestSkippedFiles(target: SkippedFilesTarget) {
    const key = skippedFilesKey(target);
    const current = skippedFiles.value[key];
    if (current && current.status !== 'error') return;
    skippedFiles.value = { ...skippedFiles.value, [key]: { status: 'loading' } };
    usePlatformBridge().postMessage({ type: 'requestSkippedFiles', target });
  }

  function setSkippedFiles(target: SkippedFilesTarget, files: SkippedFile[] | null) {
    const state: SkippedFilesState = files ? { status: 'loaded', files } : { status: 'error' };
    skippedFiles.value = { ...skippedFiles.value, [skippedFilesKey(target)]: state };
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

  function openMemoryPanel(focus?: MemoryPanelFocus) {
    memoryPanelFocus.value = focus ? { ...focus } : null;
    showMemoryPanel.value = true;
  }

  function closeMemoryPanel() {
    showMemoryPanel.value = false;
    memoryPanelFocus.value = null;
  }

  function clearMemoryPanelFocus() {
    memoryPanelFocus.value = null;
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

  function setTerminalAttachments(attachments: readonly TerminalAttachmentInfo[]) {
    terminalAttachments.value = attachments;
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

  function setRetryStatus(value: { attempt: number; maxAttempts: number } | null) {
    retryStatus.value = value;
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
    showSettingsModal.value = false;
    settingsTarget.value = null;
    showMcpPanel.value = false;
    showToolsPanel.value = false;
    showMemoryPanel.value = false;
    memoryPanelFocus.value = null;
    expandedToolId.value = null;
    expandedToolSource.value = null;
    currentRunningTool.value = null;
    showRewindTypeModal.value = false;
    showRewindBrowser.value = false;
    rewindHistoryItems.value = [];
    rewindRestorePoints.value = [];
    skippedFiles.value = {};
    rewindHistoryLoading.value = false;
    rewindCanFork.value = true;
    selectedRewindItem.value = null;
    rewindSource.value = null;
    rewindMetadataLoading.value = false;
    ideContext.value = null;
    ideContextEnabled.value = ideContextDefaultEnabled.value;
    ideContextUserOverride.value = false;
    isCompacting.value = false;
    retryStatus.value = null;
    activeHooks.value = new Map();
    lastCheckpointTime.value = null;
    authFailureMessage.value = null;
  }

  return {
    isProcessing,
    terminalShown,
    toggleTerminalShortcut,
    showSettingsModal,
    settingsTarget,
    showMcpPanel,
    currentRunningTool,
    showRewindTypeModal,
    showRewindBrowser,
    rewindHistoryItems,
    rewindRestorePoints,
    skippedFiles,
    requestSkippedFiles,
    setSkippedFiles,
    rewindHistoryLoading,
    rewindCanFork,
    selectedRewindItem,
    rewindSource,
    rewindMetadataLoading,
    startDirectRewind,
    startDirectCompactionRewind,
    setProcessing,
    setCurrentRunningTool,
    openSettingsModal,
    closeSettingsModal,
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
    memoryPanelFocus,
    openMemoryPanel,
    closeMemoryPanel,
    clearMemoryPanelFocus,
    expandedToolId,
    expandedToolSource,
    expandTool,
    collapseTool,
    ideContext,
    ideContextEnabled,
    ideContextDefaultEnabled,
    ideContextUserOverride,
    setIdeContext,
    toggleIdeContext,
    setIdeContextDefault,
    terminalAttachments,
    setTerminalAttachments,
    isCompacting,
    activeHooks,
    lastCheckpointTime,
    authFailureMessage,
    setCompacting,
    retryStatus,
    setRetryStatus,
    setHookActive,
    removeHook,
    setLastCheckpointTime,
    setAuthFailure,
    dismissAuthFailure,
    $reset,
  };
});
