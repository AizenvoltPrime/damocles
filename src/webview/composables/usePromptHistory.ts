import { ref, computed, onMounted, onUnmounted } from 'vue';
import { useVSCode } from './useVSCode';
import type { ExtensionToWebviewMessage } from '@shared/types/messages';

const MAX_LOCAL_HISTORY_SIZE = 500;
const PREFETCH_THRESHOLD = 25;

export function usePromptHistory() {
  const { postMessage, onMessage } = useVSCode();

  const history = ref<string[]>([]);
  const historyIndex = ref(-1);
  const originalInput = ref('');
  const isLoading = ref(false);
  const isLoaded = ref(false);
  const hasMore = ref(false);
  const prefetchedUpTo = ref(0);
  const shouldRestoreOriginal = ref(false);

  const isNavigating = computed(() => historyIndex.value >= 0);
  const currentEntry = computed<string | null>(() =>
    historyIndex.value >= 0 ? history.value[historyIndex.value] ?? null : null
  );

  let pendingNavigate = false;
  let pendingLoadMore = false;

  function handleMessage(message: ExtensionToWebviewMessage) {
    if (message.type === 'promptHistory') {
      const loadedSet = new Set(message.history);
      const pushedEntries = history.value.filter(item => !loadedSet.has(item));

      if (pendingLoadMore) {
        const existingSet = new Set(history.value);
        const newItems = message.history.filter(item => !existingSet.has(item));
        history.value = [...history.value, ...newItems];
      } else {
        history.value = [...pushedEntries, ...message.history];
      }

      prefetchedUpTo.value = history.value.length;
      pendingLoadMore = false;
      hasMore.value = message.hasMore;
      isLoading.value = false;
      isLoaded.value = true;

      if (pendingNavigate && history.value.length > 0) {
        historyIndex.value = 0;
        pendingNavigate = false;
      }
    } else if (message.type === 'promptHistoryPush') {
      const entry = message.entry;
      const currentEntry = historyIndex.value >= 0 ? history.value[historyIndex.value] : null;
      const previousLength = history.value.length;
      const filtered = history.value.filter(h => h !== entry);
      history.value = [entry, ...filtered].slice(0, MAX_LOCAL_HISTORY_SIZE);

      if (history.value.length > previousLength) {
        prefetchedUpTo.value++;
      }

      if (historyIndex.value >= 0 && currentEntry && currentEntry !== entry) {
        historyIndex.value++;
      }
    }
  }

  let cleanup: (() => void) | null = null;

  onMounted(() => {
    cleanup = onMessage(handleMessage);
  });

  onUnmounted(() => {
    cleanup?.();
  });

  function navigateUp() {
    if (!isLoaded.value && !isLoading.value) {
      isLoading.value = true;
      pendingNavigate = true;
      postMessage({ type: 'requestPromptHistory' });
      return;
    }

    if (history.value.length === 0) return;

    if (historyIndex.value === -1) {
      historyIndex.value = 0;
    } else if (historyIndex.value < history.value.length - 1) {
      historyIndex.value++;

      const distanceFromEnd = prefetchedUpTo.value - historyIndex.value;
      if (distanceFromEnd <= PREFETCH_THRESHOLD && hasMore.value && !isLoading.value) {
        isLoading.value = true;
        pendingLoadMore = true;
        postMessage({ type: 'requestPromptHistory', offset: history.value.length });
      }
    } else if (hasMore.value && !isLoading.value) {
      isLoading.value = true;
      pendingLoadMore = true;
      postMessage({ type: 'requestPromptHistory', offset: history.value.length });
    }
  }

  function navigateDown() {
    if (historyIndex.value > 0) {
      historyIndex.value--;
    } else if (historyIndex.value === 0) {
      shouldRestoreOriginal.value = true;
      historyIndex.value = -1;
    }
  }

  function reset() {
    historyIndex.value = -1;
    originalInput.value = '';
    shouldRestoreOriginal.value = false;
    pendingNavigate = false;
    pendingLoadMore = false;
  }

  function clearRestoreFlag() {
    shouldRestoreOriginal.value = false;
  }

  function captureOriginal(text: string) {
    if (historyIndex.value === -1) {
      originalInput.value = text;
    }
  }

  function getOriginalInput() {
    return originalInput.value;
  }

  function addEntry(text: string) {
    const trimmed = text.trim();
    if (!trimmed) return;

    const filtered = history.value.filter(entry => entry !== trimmed);
    history.value = [trimmed, ...filtered].slice(0, MAX_LOCAL_HISTORY_SIZE);
  }

  return {
    isNavigating,
    isLoading,
    currentEntry,
    shouldRestoreOriginal,
    navigateUp,
    navigateDown,
    reset,
    captureOriginal,
    getOriginalInput,
    clearRestoreFlag,
    addEntry,
  };
}
