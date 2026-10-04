import { onScopeDispose, reactive, watch, type Ref } from 'vue';
import type { VirtualItem } from './useVirtualizedMessages';

/** How long an arrival keeps its entrance class: past the animation, so a later remount by scrolling never replays it. */
export const ARRIVAL_MS = 600;

// A text block is the committed form of a streaming-text row, which already entered.
const ARRIVING_TYPES: ReadonlySet<VirtualItem['type']> = new Set([
  'user-message', 'tool-call', 'thinking-block', 'streaming-text', 'error-message', 'refusal-message',
  'background-label', 'compact-marker', 'cache-miss-notice', 'compaction-aborted-notice', 'thinking-dropped-notice',
]);

/**
 * The ids of transcript rows that arrived live within the last ARRIVAL_MS. The first population,
 * replayed history and rows re-mounted by scrolling never count, so a virtualized row never replays
 * its entrance.
 */
export function useLiveArrivals(items: Ref<VirtualItem[]>): ReadonlySet<string> {
  const seen = new Set<string>();
  const arriving = reactive(new Set<string>());
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let seeded = false;

  watch(items, (list) => {
    for (const item of list) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      if (!seeded || item.message.isReplay || !ARRIVING_TYPES.has(item.type)) continue;
      arriving.add(item.id);
      const timer = setTimeout(() => {
        timers.delete(timer);
        arriving.delete(item.id);
      }, ARRIVAL_MS);
      timers.add(timer);
    }
    seeded = true;
  }, { immediate: true });

  onScopeDispose(() => timers.forEach(clearTimeout), true);

  return arriving;
}
