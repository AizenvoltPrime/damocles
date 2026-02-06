import { ref } from 'vue';
import { defineStore } from 'pinia';

export const useContextViewStore = defineStore('contextView', () => {
  const viewingContext = ref<string | null>(null);
  const viewingContextPath = ref<string | null>(null);
  const haikuProcessing = ref(false);

  function setViewingContext(content: string, filePath: string): void {
    viewingContext.value = content;
    viewingContextPath.value = filePath;
  }

  function setHaikuProcessing(isProcessing: boolean): void {
    haikuProcessing.value = isProcessing;
  }

  function closeContextView(): void {
    viewingContext.value = null;
    viewingContextPath.value = null;
  }

  function $reset(): void {
    viewingContext.value = null;
    viewingContextPath.value = null;
    haikuProcessing.value = false;
  }

  return {
    viewingContext,
    viewingContextPath,
    haikuProcessing,
    setViewingContext,
    setHaikuProcessing,
    closeContextView,
    $reset,
  };
});
