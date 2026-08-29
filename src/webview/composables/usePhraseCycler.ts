import { ref, watch, onUnmounted, type Ref, computed } from 'vue';
import {
  WITTY_PHRASES,
  PHRASE_CHANGE_INTERVAL_MS,
} from '../data/wittyPhrases';

/**
 * Vue composable for cycling through witty loading phrases.
 *
 * @param isActive - Reactive getter or ref indicating if cycling should be active
 * @param phrases - Optional custom phrase array (defaults to WITTY_PHRASES)
 * @returns Object containing the current phrase as a reactive ref
 *
 * @example
 * // In ThinkingIndicator.vue
 * const { currentPhrase } = usePhraseCycler(() => props.isStreaming ?? false);
 *
 * @example
 * // With custom phrases
 * const { currentPhrase } = usePhraseCycler(
 *   () => true,
 *   ['Mapping the codebase...', 'Scouting ahead...']
 * );
 */
export function usePhraseCycler(
  isActive: (() => boolean) | Ref<boolean>,
  phrases: string[] = WITTY_PHRASES
): { currentPhrase: Ref<string> } {
  const currentPhrase = ref(phrases[0] ?? '');
  let intervalId: ReturnType<typeof setInterval> | null = null;

  const selectRandomPhrase = () => {
    const next = phrases[Math.floor(Math.random() * phrases.length)];
    if (next !== undefined) currentPhrase.value = next;
  };

  const clearCurrentInterval = () => {
    if (intervalId) {
      clearInterval(intervalId);
      intervalId = null;
    }
  };

  // Convert getter function to computed if needed
  const activeValue = computed(() =>
    typeof isActive === 'function' ? isActive() : isActive.value
  );

  watch(
    activeValue,
    (active) => {
      clearCurrentInterval();

      if (active) {
        // Select initial phrase immediately
        selectRandomPhrase();
        // Start cycling
        intervalId = setInterval(selectRandomPhrase, PHRASE_CHANGE_INTERVAL_MS);
      }
    },
    { immediate: true }
  );

  // Cleanup on component unmount
  onUnmounted(() => {
    clearCurrentInterval();
  });

  return { currentPhrase };
}
