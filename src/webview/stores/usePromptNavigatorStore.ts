import { ref, watch } from 'vue';
import { defineStore } from 'pinia';
import { useSessionStore } from './useSessionStore';

const FLASH_DURATION_MS = 2500;

export const usePromptNavigatorStore = defineStore('promptNavigator', () => {
  const isOpen = ref(false);
  const query = ref('');
  const activeIndex = ref(0);
  const collapsedNodes = ref<Set<string>>(new Set());
  const flashedMessageId = ref<string | null>(null);

  let flashTimer: ReturnType<typeof setTimeout> | null = null;

  function clearFlashTimer(): void {
    if (flashTimer !== null) {
      clearTimeout(flashTimer);
      flashTimer = null;
    }
  }

  function open(): void {
    isOpen.value = true;
  }

  function close(): void {
    isOpen.value = false;
    query.value = '';
    activeIndex.value = 0;
  }

  function toggle(): void {
    if (isOpen.value) {
      close();
    } else {
      open();
    }
  }

  function setQuery(q: string): void {
    query.value = q;
  }

  function setActiveIndex(i: number): void {
    activeIndex.value = i;
  }

  function toggleNodeCollapsed(key: string): void {
    const next = new Set(collapsedNodes.value);
    if (next.has(key)) {
      next.delete(key);
    } else {
      next.add(key);
    }
    collapsedNodes.value = next;
  }

  function flashMessage(id: string): void {
    clearFlashTimer();
    flashedMessageId.value = id;
    flashTimer = setTimeout(() => {
      flashedMessageId.value = null;
      flashTimer = null;
    }, FLASH_DURATION_MS);
  }

  const sessionStore = useSessionStore();
  watch(
    () => sessionStore.currentResumedSessionId,
    () => {
      clearFlashTimer();
      isOpen.value = false;
      query.value = '';
      activeIndex.value = 0;
      collapsedNodes.value = new Set();
      flashedMessageId.value = null;
    }
  );

  return {
    isOpen,
    query,
    activeIndex,
    collapsedNodes,
    flashedMessageId,
    open,
    close,
    toggle,
    setQuery,
    setActiveIndex,
    toggleNodeCollapsed,
    flashMessage,
  };
});
