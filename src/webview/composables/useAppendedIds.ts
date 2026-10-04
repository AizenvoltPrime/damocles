import { onScopeDispose, reactive, watch } from 'vue';
import { ARRIVAL_MS } from './useLiveArrivals';

/**
 * Ids appended to the end of a list after its first non-empty population, each for ARRIVAL_MS. Ids
 * inserted before ones already seen (a history load prepends) and the first population never count,
 * so an overlay's transcript plays an entrance only for what arrives while the user watches.
 */
export function useAppendedIds(ids: () => readonly string[]): ReadonlySet<string> {
  const seen = new Set<string>();
  const appended = reactive(new Set<string>());
  const timers = new Set<ReturnType<typeof setTimeout>>();

  watch(ids, (list) => {
    const seeded = seen.size > 0;
    let lastSeen = -1;
    list.forEach((id, index) => {
      if (seen.has(id)) lastSeen = index;
    });
    list.forEach((id, index) => {
      if (seen.has(id)) return;
      seen.add(id);
      if (!seeded || index < lastSeen) return;
      appended.add(id);
      const timer = setTimeout(() => {
        timers.delete(timer);
        appended.delete(id);
      }, ARRIVAL_MS);
      timers.add(timer);
    });
  }, { immediate: true });

  onScopeDispose(() => timers.forEach(clearTimeout), true);

  return appended;
}
