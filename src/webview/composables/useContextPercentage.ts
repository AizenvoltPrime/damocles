import { computed, type MaybeRefOrGetter, toValue } from 'vue';
import type { SessionStats } from '@shared/types/session';

export function useContextPercentage(stats: MaybeRefOrGetter<SessionStats>) {
  const totalContext = computed(() => {
    const s = toValue(stats);
    if (s.contextTotalTokens !== undefined) {
      return s.contextTotalTokens;
    }
    return s.totalInputTokens + s.cacheCreationTokens + s.cacheReadTokens;
  });

  const contextPercentage = computed(() => {
    const s = toValue(stats);
    if (s.contextPercentage !== undefined) {
      return s.contextPercentage;
    }
    if (s.contextWindowSize === 0) return 0;
    return Math.round((totalContext.value / s.contextWindowSize) * 100);
  });

  return { totalContext, contextPercentage };
}
