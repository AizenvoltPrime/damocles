import { ref, computed } from 'vue';
import { defineStore } from 'pinia';
import type { HaikuPromptActivity, HaikuDisplayBlock } from '@shared/types/haiku-observer';

export const useHaikuObserverStore = defineStore('haikuObserver', () => {
  const activities = ref<HaikuPromptActivity[]>([]);
  const activePromptIndex = ref(0);
  const isOverlayOpen = ref(false);
  const activitiesLoaded = ref(false);

  const streamingPromptIndex = ref<number | null>(null);
  const streamingThinking = ref('');
  const streamingText = ref('');
  const streamingBlocks = ref<HaikuDisplayBlock[]>([]);
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

  const displayBlocks = computed<HaikuDisplayBlock[]>(() => {
    if (isViewingLivePrompt.value) {
      return streamingBlocks.value;
    }
    return currentActivity.value?.blocks ?? [];
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
    streamingBlocks.value = [];
    streamingPromptIndex.value = promptIndex;
    isObservationStreaming.value = true;

    if (isOverlayOpen.value) {
      activePromptIndex.value = promptIndex;
    }
  }

  function handleStreamDelta(promptIndex: number, deltaType: string, delta: string): void {
    if (promptIndex !== streamingPromptIndex.value) return;

    const blocks = streamingBlocks.value;

    switch (deltaType) {
      case 'thinking': {
        streamingThinking.value += delta;
        const last = blocks[blocks.length - 1];
        if (last?.type === 'thinking') {
          last.content += delta;
        } else {
          blocks.push({ type: 'thinking', content: delta });
        }
        break;
      }
      case 'text': {
        streamingText.value += delta;
        const last = blocks[blocks.length - 1];
        if (last?.type === 'text') {
          last.content += delta;
        } else {
          blocks.push({ type: 'text', content: delta });
        }
        break;
      }
    }
  }

  function handleObservationComplete(
    promptIndex: number,
    thinking: string,
    text: string,
    contextSnapshot?: string,
    annotationResult?: HaikuPromptActivity['annotationResult'],
  ): void {
    const blocks: HaikuDisplayBlock[] = promptIndex === streamingPromptIndex.value
      ? [...streamingBlocks.value]
      : text ? [{ type: 'text' as const, content: text }] : [];

    if (annotationResult) {
      blocks.push({
        type: 'annotation_summary',
        content: annotationResult.summary,
        annotationCount: annotationResult.annotationCount,
        lowRelevanceCount: annotationResult.lowRelevanceCount,
        linkCount: annotationResult.linkCount,
        failedCount: annotationResult.failedCount,
        summary: annotationResult.summary,
        groups: annotationResult.groups,
        entries: annotationResult.entries,
        links: annotationResult.links,
      });
    }

    activities.value.push({
      promptIndex,
      thinking,
      text,
      blocks,
      contextSnapshot: contextSnapshot ?? '',
      timestamp: Date.now(),
      annotationResult,
    });
    if (promptIndex === streamingPromptIndex.value) {
      streamingPromptIndex.value = null;
      streamingThinking.value = '';
      streamingText.value = '';
      streamingBlocks.value = [];
      isObservationStreaming.value = false;
    }
  }

  function handleActivitiesLoaded(loaded: HaikuPromptActivity[]): void {
    activities.value = loaded.map(a => ({
      ...a,
      blocks: a.blocks ?? (a.text ? [{ type: 'text' as const, content: a.text }] : []),
    }));
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
    streamingBlocks.value = [];
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
    streamingBlocks,
    isObservationStreaming,

    totalPrompts,
    currentActivity,
    isViewingLivePrompt,
    displayThinking,
    displayText,
    displayBlocks,

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
