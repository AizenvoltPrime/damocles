import { computed, toValue, type ComputedRef, type MaybeRefOrGetter } from 'vue';
import { usePlatformBridge } from '@/composables/usePlatformBridge';
import { useDesignStore, type DesignJourneyReplay } from '@/stores/useDesignStore';
import { prefersReducedMotion } from '@/utils/reducedMotion';

/** Replay in preview for a PreviewJourney call: offered only where the host has the preview tab (desktop), like Open preview. */
export function useReplayDesignJourney(toolCallId: MaybeRefOrGetter<string>): {
  available: ComputedRef<boolean>;
  replay: ComputedRef<DesignJourneyReplay | undefined>;
  start: () => void;
} {
  const designStore = useDesignStore();
  const { postMessage } = usePlatformBridge();
  const replay = computed(() => designStore.journeyReplays[toValue(toolCallId)]);
  return {
    available: computed(() => designStore.openPreview),
    replay,
    // Core reads the journey from the call on the branch; the view names only the call and its motion setting.
    start: () => {
      if (replay.value?.state === 'replaying') return;
      const id = toValue(toolCallId);
      designStore.replayStarted(id);
      postMessage({ type: 'replayDesignJourney', toolCallId: id, reducedMotion: prefersReducedMotion() });
    },
  };
}
