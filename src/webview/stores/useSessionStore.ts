import { ref, computed } from 'vue';
import { defineStore } from 'pinia';
import type { StoredSession, FileEntry, CompactMarker, SessionStats } from '@shared/types/session';

const DEFAULT_SESSION_STATS: SessionStats = {
  totalCostUsd: 0,
  totalInputTokens: 0,
  totalOutputTokens: 0,
  cacheCreationTokens: 0,
  cacheReadTokens: 0,
  numTurns: 0,
  contextWindowSize: 200000,
};

export const useSessionStore = defineStore('session', () => {
  const currentSessionId = ref<string | null>(null);
  const selectedSessionId = ref<string | null>(null);
  const selectedSessionName = ref<string | null>(null);
  const currentResumedSessionId = ref<string | null>(null);
  const storedSessions = ref<StoredSession[]>([]);

  const hasMoreSessions = ref(false);
  const nextSessionsOffset = ref(0);
  const loadingMoreSessions = ref(false);

  const hasMoreHistory = ref(false);
  const nextHistoryOffset = ref(0);
  const loadingMoreHistory = ref(false);
  const promptIndexOffset = ref(0);

  const accessedFiles = ref<Record<string, FileEntry>>({});
  const checkpointMessages = ref<Set<string>>(new Set());
  const compactMarkers = ref<CompactMarker[]>([]);
  const sessionStats = ref<SessionStats>({ ...DEFAULT_SESSION_STATS });
  const lastAssistantMessage = ref<string | null>(null);

  const selectedSession = computed(() => {
    if (!selectedSessionId.value) return null;
    return storedSessions.value.find(s => s.id === selectedSessionId.value) ?? null;
  });

  const selectedSessionDisplayName = computed(() => {
    if (!selectedSessionId.value) return null;
    // Prefer name from sessions list (source of truth)
    if (selectedSession.value) {
      return selectedSession.value.customTitle || selectedSession.value.preview;
    }
    // Fall back to stored name (for when session isn't in list yet)
    return selectedSessionName.value;
  });

  const lastAccessedFile = computed(() => {
    const files = Object.values(accessedFiles.value);
    if (files.length === 0) return undefined;
    return files[files.length - 1].path;
  });

  function setCurrentSession(id: string | null) {
    currentSessionId.value = id;
  }

  function setSelectedSession(id: string | null, name?: string | null) {
    selectedSessionId.value = id;
    selectedSessionName.value = name ?? null;
  }

  function setResumedSession(id: string | null) {
    currentResumedSessionId.value = id;
  }

  function updateStoredSessions(
    sessions: StoredSession[],
    isFirstPage: boolean,
    hasMore: boolean,
    nextOffset: number
  ) {
    if (isFirstPage) {
      storedSessions.value = sessions;
    } else {
      const existingIds = new Set(storedSessions.value.map(s => s.id));
      const newSessions = sessions.filter(s => !existingIds.has(s.id));
      storedSessions.value = [...storedSessions.value, ...newSessions];
    }
    hasMoreSessions.value = hasMore;
    nextSessionsOffset.value = nextOffset;
    loadingMoreSessions.value = false;
  }

  function setLoadingMoreSessions(loading: boolean) {
    loadingMoreSessions.value = loading;
  }

  function updateHistoryPagination(hasMore: boolean, nextOffset: number, newPromptIndexOffset: number) {
    hasMoreHistory.value = hasMore;
    nextHistoryOffset.value = nextOffset;
    loadingMoreHistory.value = false;
    promptIndexOffset.value = newPromptIndexOffset;
  }

  function setLoadingMoreHistory(loading: boolean) {
    loadingMoreHistory.value = loading;
  }

  function trackFileAccess(toolName: string, input: Record<string, unknown>) {
    const filePath = input.file_path as string | undefined;
    if (!filePath) return;

    let operation: FileEntry['operation'];
    switch (toolName) {
      case 'Read':
        operation = 'read';
        break;
      case 'Edit':
        operation = 'edit';
        break;
      case 'Write':
        operation = filePath in accessedFiles.value ? 'write' : 'create';
        break;
      default:
        return;
    }

    accessedFiles.value = {
      ...accessedFiles.value,
      [filePath]: { path: filePath, operation },
    };
  }

  function setCheckpointMessages(messageIds: string[]) {
    checkpointMessages.value = new Set(messageIds);
  }

  function addCompactMarker(trigger: 'manual' | 'auto', preTokens: number, postTokens?: number, summary?: string, timestamp?: number, messageCutoffTimestamp?: number) {
    const ts = timestamp ?? Date.now();
    const marker: CompactMarker = {
      id: `compact-${ts}`,
      timestamp: ts,
      trigger,
      preTokens,
      postTokens,
      summary,
      messageCutoffTimestamp,
    };
    compactMarkers.value = [...compactMarkers.value, marker];
  }

  function updateLastCompactMarkerSummary(summary: string) {
    if (compactMarkers.value.length === 0) return;
    const markers = [...compactMarkers.value];
    const lastIndex = markers.length - 1;
    markers[lastIndex] = { ...markers[lastIndex], summary };
    compactMarkers.value = markers;
  }

  function clearCompactMarkers() {
    compactMarkers.value = [];
  }

  function updateStats(updates: Partial<SessionStats>) {
    sessionStats.value = { ...sessionStats.value, ...updates };
  }

  function setLastAssistantMessage(message: string) {
    lastAssistantMessage.value = message;
  }

  function clearSessionData() {
    accessedFiles.value = {};
    checkpointMessages.value = new Set();
    compactMarkers.value = [];
    sessionStats.value = { ...DEFAULT_SESSION_STATS };
    lastAssistantMessage.value = null;
    hasMoreHistory.value = false;
    nextHistoryOffset.value = 0;
    loadingMoreHistory.value = false;
    promptIndexOffset.value = 0;
  }

  function $reset() {
    currentSessionId.value = null;
    selectedSessionId.value = null;
    selectedSessionName.value = null;
    currentResumedSessionId.value = null;
    storedSessions.value = [];
    hasMoreSessions.value = false;
    nextSessionsOffset.value = 0;
    loadingMoreSessions.value = false;
    hasMoreHistory.value = false;
    nextHistoryOffset.value = 0;
    loadingMoreHistory.value = false;
    promptIndexOffset.value = 0;
    accessedFiles.value = {};
    checkpointMessages.value = new Set();
    compactMarkers.value = [];
    sessionStats.value = { ...DEFAULT_SESSION_STATS };
    lastAssistantMessage.value = null;
  }

  return {
    currentSessionId,
    selectedSessionId,
    selectedSessionName,
    currentResumedSessionId,
    storedSessions,
    hasMoreSessions,
    nextSessionsOffset,
    loadingMoreSessions,
    hasMoreHistory,
    nextHistoryOffset,
    loadingMoreHistory,
    promptIndexOffset,
    accessedFiles,
    checkpointMessages,
    compactMarkers,
    sessionStats,
    lastAssistantMessage,
    selectedSession,
    selectedSessionDisplayName,
    lastAccessedFile,
    setCurrentSession,
    setSelectedSession,
    setResumedSession,
    updateStoredSessions,
    setLoadingMoreSessions,
    updateHistoryPagination,
    setLoadingMoreHistory,
    trackFileAccess,
    setCheckpointMessages,
    addCompactMarker,
    updateLastCompactMarkerSummary,
    clearCompactMarkers,
    updateStats,
    setLastAssistantMessage,
    clearSessionData,
    $reset,
  };
});
