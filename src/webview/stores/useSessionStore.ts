import { ref, computed } from 'vue';
import { defineStore } from 'pinia';
import type { StoredSession, FileEntry, CompactMarker, CacheMissNotice, SessionStats } from '@shared/types/session';
import { TOOL_READ, TOOL_EDIT, TOOL_WRITE } from '@shared/tool-names';
import { DEFAULT_CONTEXT_WINDOW } from '@shared/types/constants';

const DEFAULT_SESSION_STATS: SessionStats = {
  totalCostUsd: 0,
  totalInputTokens: 0,
  totalOutputTokens: 0,
  cacheCreationTokens: 0,
  cacheReadTokens: 0,
  numTurns: 0,
  contextWindowSize: DEFAULT_CONTEXT_WINDOW,
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

  const accessedFiles = ref<Record<string, FileEntry>>({});
  const checkpointMessages = ref<Set<string>>(new Set());
  const compactMarkers = ref<CompactMarker[]>([]);
  const cacheMissNotices = ref<CacheMissNotice[]>([]);
  // Monotonic counter so two cache-miss notices sharing a timestamp still get distinct ids.
  let cacheMissSeq = 0;
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
      return selectedSession.value.customTitle || selectedSession.value.aiTitle || selectedSession.value.preview;
    }
    // Fall back to stored name (for when session isn't in list yet)
    return selectedSessionName.value;
  });

  const lastAccessedFile = computed(() => {
    const files = Object.values(accessedFiles.value);
    return files[files.length - 1]?.path;
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

  function trackFileAccess(toolName: string, input: Record<string, unknown>) {
    const filePath = input.file_path as string | undefined;
    if (!filePath) return;

    let operation: FileEntry['operation'];
    switch (toolName) {
      case TOOL_READ:
        operation = 'read';
        break;
      case TOOL_EDIT:
        operation = 'edit';
        break;
      case TOOL_WRITE:
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

  function addCompactMarker(trigger: 'manual' | 'auto', preTokens: number, postTokens?: number, summary?: string, timestamp?: number, messageCutoffTimestamp?: number, entryId?: string) {
    const ts = timestamp ?? Date.now();
    const marker: CompactMarker = {
      id: `compact-${ts}`,
      timestamp: ts,
      trigger,
      preTokens,
      ...(postTokens !== undefined && { postTokens }),
      ...(summary !== undefined && { summary }),
      ...(messageCutoffTimestamp !== undefined && { messageCutoffTimestamp }),
      ...(entryId !== undefined && { entryId }),
    };
    compactMarkers.value = [...compactMarkers.value, marker];
  }

  function updateLastCompactMarkerSummary(summary: string) {
    if (compactMarkers.value.length === 0) return;
    const markers = [...compactMarkers.value];
    const lastIndex = markers.length - 1;
    const last = markers[lastIndex];
    if (!last) return;
    markers[lastIndex] = { ...last, summary };
    compactMarkers.value = markers;
  }

  function clearCompactMarkers() {
    compactMarkers.value = [];
  }

  function addCacheMissNotice(missedTokens: number, missedCost: number, idleMs: number, modelChanged: boolean, timestamp: number) {
    const notice: CacheMissNotice = {
      // Id is the raw store id; the virtualizer namespaces it (`cache-miss-${id}`). Keep it prefix-free
      // here so the two don't stack into `cache-miss-cache-miss-…`. A `_seq` disambiguates two misses
      // that share a timestamp (possible when idleMs is derived, not wall-clock).
      id: `${timestamp}-${cacheMissSeq++}`,
      missedTokens,
      missedCost,
      idleMs,
      modelChanged,
      timestamp,
    };
    cacheMissNotices.value = [...cacheMissNotices.value, notice];
  }

  function clearCacheMissNotices() {
    cacheMissNotices.value = [];
  }

  function updateStats(updates: Partial<SessionStats>) {
    sessionStats.value = { ...sessionStats.value, ...updates };
  }

  function clearContextStats() {
    const { contextTotalTokens, contextMaxTokens, contextPercentage, ...rest } = sessionStats.value;
    sessionStats.value = rest;
  }

  function setLastAssistantMessage(message: string) {
    lastAssistantMessage.value = message;
  }

  function clearSessionData() {
    accessedFiles.value = {};
    checkpointMessages.value = new Set();
    compactMarkers.value = [];
    cacheMissNotices.value = [];
    sessionStats.value = { ...DEFAULT_SESSION_STATS, contextWindowSize: sessionStats.value.contextWindowSize };
    lastAssistantMessage.value = null;
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
    accessedFiles.value = {};
    checkpointMessages.value = new Set();
    compactMarkers.value = [];
    cacheMissNotices.value = [];
    sessionStats.value = { ...DEFAULT_SESSION_STATS, contextWindowSize: sessionStats.value.contextWindowSize };
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
    accessedFiles,
    checkpointMessages,
    compactMarkers,
    cacheMissNotices,
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
    trackFileAccess,
    setCheckpointMessages,
    addCompactMarker,
    updateLastCompactMarkerSummary,
    clearCompactMarkers,
    addCacheMissNotice,
    clearCacheMissNotices,
    updateStats,
    clearContextStats,
    setLastAssistantMessage,
    clearSessionData,
    $reset,
  };
});
