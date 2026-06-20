import { ref, watch } from 'vue';
import { defineStore } from 'pinia';
import { useSessionStore } from './useSessionStore';

export const usePromptNavigatorStore = defineStore('promptNavigator', () => {
  const isOpen = ref(false);
  const query = ref('');
  const activeIndex = ref(0);

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

  const sessionStore = useSessionStore();
  watch(
    () => sessionStore.currentResumedSessionId,
    () => {
      isOpen.value = false;
      query.value = '';
      activeIndex.value = 0;
    }
  );

  return {
    isOpen,
    query,
    activeIndex,
    open,
    close,
    toggle,
    setQuery,
    setActiveIndex,
  };
});
