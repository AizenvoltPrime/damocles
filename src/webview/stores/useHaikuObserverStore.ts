import { ref, computed } from 'vue';
import { defineStore } from 'pinia';
import type { HaikuPromptActivity } from '@shared/types/haiku-observer';

export const useHaikuObserverStore = defineStore('haikuObserver', () => {
  const activities = ref<HaikuPromptActivity[]>([]);
  const activePromptIndex = ref(0);
  const isOverlayOpen = ref(false);
  const activitiesLoaded = ref(false);

  const streamingPromptIndex = ref<number | null>(null);
  const streamingThinking = ref('');
  const streamingText = ref('');
  const isObservationStreaming = ref(false);

  const totalPrompts = computed(() =>
    activities.value.length + (isObservationStreaming.value ? 1 : 0)
  );

  const currentActivity = computed(() =>
    activities.value[activePromptIndex.value] ?? null
  );

  const isViewingLivePrompt = computed(() =>
    activePromptIndex.value === streamingPromptIndex.value
  );

  const displayThinking = computed(() => {
    if (isViewingLivePrompt.value) {
      return streamingThinking.value;
    }
    return currentActivity.value?.thinking ?? '';
  });

  const displayText = computed(() => {
    if (isViewingLivePrompt.value) {
      return streamingText.value;
    }
    return currentActivity.value?.text ?? '';
  });

  function openOverlay(): void {
    isOverlayOpen.value = true;
  }

  function closeOverlay(): void {
    isOverlayOpen.value = false;
  }

  function navigatePrompt(idx: number): void {
    const max = totalPrompts.value - 1;
    activePromptIndex.value = Math.max(0, Math.min(idx, max));
  }

  function handleObservationStart(promptIndex: number): void {
    streamingThinking.value = '';
    streamingText.value = '';
    streamingPromptIndex.value = promptIndex;
    isObservationStreaming.value = true;

    if (isOverlayOpen.value) {
      activePromptIndex.value = promptIndex;
    }
  }

  function handleStreamDelta(promptIndex: number, deltaType: 'thinking' | 'text', delta: string): void {
    if (promptIndex !== streamingPromptIndex.value) return;

    if (deltaType === 'thinking') {
      streamingThinking.value += delta;
    } else {
      streamingText.value += delta;
    }
  }

  function handleObservationComplete(
    promptIndex: number,
    thinking: string,
    text: string,
    contextSnapshot?: string
  ): void {
    activities.value.push({
      promptIndex,
      thinking,
      text,
      contextSnapshot: contextSnapshot ?? '',
      timestamp: Date.now(),
    });
    if (promptIndex === streamingPromptIndex.value) {
      streamingPromptIndex.value = null;
      streamingThinking.value = '';
      streamingText.value = '';
      isObservationStreaming.value = false;
    }
  }

  function handleActivitiesLoaded(loaded: HaikuPromptActivity[]): void {
    activities.value = loaded;
    activitiesLoaded.value = true;
  }

  function $reset(): void {
    activities.value = [];
    activePromptIndex.value = 0;
    isOverlayOpen.value = false;
    activitiesLoaded.value = false;
    streamingPromptIndex.value = null;
    streamingThinking.value = '';
    streamingText.value = '';
    isObservationStreaming.value = false;
  }

  return {
    activities,
    activePromptIndex,
    isOverlayOpen,
    activitiesLoaded,
    streamingPromptIndex,
    streamingThinking,
    streamingText,
    isObservationStreaming,

    totalPrompts,
    currentActivity,
    isViewingLivePrompt,
    displayThinking,
    displayText,

    openOverlay,
    closeOverlay,
    navigatePrompt,
    handleObservationStart,
    handleStreamDelta,
    handleObservationComplete,
    handleActivitiesLoaded,
    $reset,
  };
});
