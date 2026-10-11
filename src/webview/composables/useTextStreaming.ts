import { ref, watch, onScopeDispose, type Ref, computed } from "vue";
import { prefersReducedMotion } from "@/utils/reducedMotion";

export interface UseTextStreamingReturn {
  displayedContent: Ref<string>;
}

const BASE_CHARS_PER_SECOND = 200;
// The reveal rate grows with the waiting text, so the display trails the stream by about this long however fast it arrives.
const CATCH_UP_SECONDS = 0.5;

export function useTextStreaming(fullContent: Ref<string>, isActive: Ref<boolean>): UseTextStreamingReturn {
  // Text present at mount was already seen (the virtualized list remounts rows as it scrolls), so only later growth types.
  const displayedLength = ref(fullContent.value.length);
  const animationFrameId = ref<number | null>(null);
  const lastFrameTime = ref<number | null>(null);
  const accumulatedChars = ref(0);

  const displayedContent = computed(() => fullContent.value.slice(0, displayedLength.value));

  const cancelAnimation = () => {
    if (animationFrameId.value !== null) {
      cancelAnimationFrame(animationFrameId.value);
      animationFrameId.value = null;
    }
    lastFrameTime.value = null;
    accumulatedChars.value = 0;
  };

  const animate = (currentTime: number) => {
    animationFrameId.value = null;
    if (!isActive.value) {
      displayedLength.value = fullContent.value.length;
      cancelAnimation();
      return;
    }

    if (lastFrameTime.value !== null) {
      const deltaTime = (currentTime - lastFrameTime.value) / 1000;
      const waiting = fullContent.value.length - displayedLength.value;
      accumulatedChars.value += deltaTime * Math.max(BASE_CHARS_PER_SECOND, waiting / CATCH_UP_SECONDS);

      if (accumulatedChars.value >= 1) {
        const charsToAdd = Math.floor(accumulatedChars.value);
        accumulatedChars.value -= charsToAdd;
        displayedLength.value = Math.min(displayedLength.value + charsToAdd, fullContent.value.length);
      }
    }

    // A loop left running while caught up would bank reveal budget through a stall and spend it in one frame.
    if (displayedLength.value >= fullContent.value.length) {
      cancelAnimation();
      return;
    }

    lastFrameTime.value = currentTime;
    animationFrameId.value = requestAnimationFrame(animate);
  };

  watch(
    [fullContent, isActive],
    ([content, active]) => {
      if (!active || prefersReducedMotion()) {
        cancelAnimation();
        displayedLength.value = content.length;
        return;
      }

      if (content.length > displayedLength.value && animationFrameId.value === null) {
        animationFrameId.value = requestAnimationFrame(animate);
      }
    },
    { immediate: true }
  );

  onScopeDispose(cancelAnimation);

  return {
    displayedContent,
  };
}
