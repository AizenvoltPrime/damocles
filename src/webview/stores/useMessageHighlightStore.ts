import { ref, watch } from 'vue';
import { defineStore } from 'pinia';
import { useSessionStore } from './useSessionStore';

const FLASH_DURATION_MS = 2500;

export const useMessageHighlightStore = defineStore('messageHighlight', () => {
  const flashedMessageId = ref<string | null>(null);
  let flashTimer: ReturnType<typeof setTimeout> | null = null;

  function clearFlashTimer(): void {
    if (flashTimer !== null) {
      clearTimeout(flashTimer);
      flashTimer = null;
    }
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
      flashedMessageId.value = null;
    },
  );

  return { flashedMessageId, flashMessage };
});
