import { ref, watch } from 'vue';
import { defineStore } from 'pinia';
import { useSessionStore } from './useSessionStore';

export const usePromptNavigatorStore = defineStore('promptNavigator', () => {
  const isOpen = ref(false);
  const query = ref('');
  const activeIndex = ref(0);
  const collapsedNodes = ref<Set<string>>(new Set());

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

  const sessionStore = useSessionStore();
  watch(
    () => sessionStore.currentResumedSessionId,
    () => {
      isOpen.value = false;
      query.value = '';
      activeIndex.value = 0;
      collapsedNodes.value = new Set();
    }
  );

  return {
    isOpen,
    query,
    activeIndex,
    collapsedNodes,
    open,
    close,
    toggle,
    setQuery,
    setActiveIndex,
    toggleNodeCollapsed,
  };
});
