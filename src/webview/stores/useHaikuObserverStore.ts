import { ref, computed } from 'vue';
import { defineStore } from 'pinia';
import type { HaikuIteration, HaikuPromptActivity } from '@shared/types/haiku-observer';

export const useHaikuObserverStore = defineStore('haikuObserver', () => {
  const activities = ref<HaikuPromptActivity[]>([]);
  const activePromptIndex = ref(0);
  const isOverlayOpen = ref(false);
  const activitiesLoaded = ref(false);

  const streamingPromptIndex = ref<number | null>(null);
  const streamingIteration = ref<number | null>(null);
  const streamingThinking = ref('');
  const streamingText = ref('');
  const isObservationStreaming = ref(false);
  const lastCompletedThinking = ref('');
  const lastCompletedText = ref('');
  const streamingIterations = ref<HaikuIteration[]>([]);

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
      return streamingThinking.value || lastCompletedThinking.value;
    }
    return currentActivity.value?.thinking ?? '';
  });

  const displayText = computed(() => {
    if (isViewingLivePrompt.value) {
      return streamingText.value || lastCompletedText.value;
    }
    return currentActivity.value?.text ?? '';
  });

  const currentIterationHistory = computed<HaikuIteration[]>(() => {
    if (isViewingLivePrompt.value && isObservationStreaming.value) {
      return streamingIterations.value;
    }
    const activity = currentActivity.value;
    if (!activity?.iterations || activity.iterations.length <= 1) return [];
    return activity.iterations.slice(0, -1);
  });

  const totalIterations = computed(() => {
    if (isViewingLivePrompt.value && isObservationStreaming.value) {
      return streamingIterations.value.length + (streamingIteration.value !== null ? 1 : 0);
    }
    return currentActivity.value?.iterations?.length ?? 1;
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

  function handleIterationStart(promptIndex: number, iteration: number): void {
    if (lastCompletedThinking.value || lastCompletedText.value) {
      streamingIterations.value.push({
        iteration: (streamingIteration.value ?? iteration) - 1,
        thinking: lastCompletedThinking.value,
        text: lastCompletedText.value,
        timestamp: Date.now(),
      });
    }
    lastCompletedThinking.value = streamingThinking.value;
    lastCompletedText.value = streamingText.value;
    streamingThinking.value = '';
    streamingText.value = '';
    streamingPromptIndex.value = promptIndex;
    streamingIteration.value = iteration;
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

  function handleIterationComplete(
    promptIndex: number,
    iteration: number,
    thinking: string,
    text: string,
    isFinal: boolean,
    contextSnapshot?: string
  ): void {
    if (isFinal) {
      if (lastCompletedThinking.value || lastCompletedText.value) {
        streamingIterations.value.push({
          iteration: iteration - 1,
          thinking: lastCompletedThinking.value,
          text: lastCompletedText.value,
          timestamp: Date.now(),
        });
      }

      const allIterations: HaikuIteration[] = [
        ...streamingIterations.value,
        { iteration, thinking, text, timestamp: Date.now() },
      ];

      activities.value.push({
        promptIndex,
        thinking,
        text,
        contextSnapshot: contextSnapshot ?? '',
        timestamp: Date.now(),
        iterations: allIterations,
      });
      streamingPromptIndex.value = null;
      streamingIteration.value = null;
      streamingThinking.value = '';
      streamingText.value = '';
      isObservationStreaming.value = false;
      lastCompletedThinking.value = '';
      lastCompletedText.value = '';
      streamingIterations.value = [];
    } else {
      lastCompletedThinking.value = thinking;
      lastCompletedText.value = text;
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
    streamingIteration.value = null;
    streamingThinking.value = '';
    streamingText.value = '';
    isObservationStreaming.value = false;
    lastCompletedThinking.value = '';
    lastCompletedText.value = '';
    streamingIterations.value = [];
  }

  return {
    activities,
    activePromptIndex,
    isOverlayOpen,
    activitiesLoaded,
    streamingPromptIndex,
    streamingIteration,
    streamingThinking,
    streamingText,
    isObservationStreaming,
    lastCompletedThinking,
    lastCompletedText,
    streamingIterations,

    totalPrompts,
    currentActivity,
    isViewingLivePrompt,
    displayThinking,
    displayText,
    currentIterationHistory,
    totalIterations,

    openOverlay,
    closeOverlay,
    navigatePrompt,
    handleIterationStart,
    handleStreamDelta,
    handleIterationComplete,
    handleActivitiesLoaded,
    $reset,
  };
});
