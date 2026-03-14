import { ref, computed } from 'vue';
import { defineStore } from 'pinia';

export interface BtwAside {
  id: string;
  question: string;
  text: string;
  isStreaming: boolean;
  error?: string;
}

export const useBtwStore = defineStore('btw', () => {
  const aside = ref<BtwAside | null>(null);
  const isOverlayOpen = ref(false);

  const hasAside = computed(() => aside.value !== null);

  function addAside(id: string, question: string): void {
    aside.value = { id, question, text: '', isStreaming: true };
    isOverlayOpen.value = true;
  }

  function updateStreaming(id: string, text: string): void {
    if (aside.value?.id === id) {
      aside.value.text = text;
    }
  }

  function completeAside(id: string, text: string): void {
    if (aside.value?.id === id) {
      aside.value.text = text;
      aside.value.isStreaming = false;
    }
  }

  function setError(id: string, message: string): void {
    if (aside.value?.id === id) {
      aside.value.isStreaming = false;
      aside.value.error = message;
    }
  }

  function dismissAside(): void {
    aside.value = null;
    isOverlayOpen.value = false;
  }

  function openOverlay(): void {
    if (aside.value) {
      isOverlayOpen.value = true;
    }
  }

  function closeOverlay(): void {
    isOverlayOpen.value = false;
  }

  function $reset(): void {
    aside.value = null;
    isOverlayOpen.value = false;
  }

  return {
    aside,
    isOverlayOpen,
    hasAside,
    addAside,
    updateStreaming,
    completeAside,
    setError,
    dismissAside,
    openOverlay,
    closeOverlay,
    $reset,
  };
});
