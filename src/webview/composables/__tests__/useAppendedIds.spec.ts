import { describe, it, expect, vi, afterEach } from 'vitest';
import { effectScope, nextTick, ref } from 'vue';
import { ARRIVAL_MS } from '../useLiveArrivals';
import { useAppendedIds } from '../useAppendedIds';

/**
 * An agent overlay replays its transcript on open and prepends older history as it loads, so only an id
 * appended at the end while the overlay is open may play an entrance.
 */

afterEach(() => vi.useRealTimers());

describe('which ids count as appended', () => {
  it('ignores the ids present when the list first renders', () => {
    const appended = useAppendedIds(() => ['a', 'b']);

    expect(appended.size).toBe(0);
  });

  it('ignores the first population of a list that started empty', async () => {
    const ids = ref<string[]>([]);
    const appended = useAppendedIds(() => ids.value);

    ids.value = ['a', 'b'];
    await nextTick();

    expect(appended.size).toBe(0);
  });

  it('marks an id appended afterwards, then clears it once the entrance is over', async () => {
    vi.useFakeTimers();
    const ids = ref(['a']);
    const appended = useAppendedIds(() => ids.value);

    ids.value = ['a', 'b'];
    await nextTick();
    expect([...appended]).toEqual(['b']);

    vi.advanceTimersByTime(ARRIVAL_MS);
    expect(appended.size).toBe(0);
  });

  it('ignores history prepended before the ids already seen, in the same update as an append', async () => {
    const ids = ref(['c']);
    const appended = useAppendedIds(() => ids.value);

    ids.value = ['a', 'b', 'c', 'd'];
    await nextTick();

    expect([...appended]).toEqual(['d']);
  });

  it('leaves no timer running once its scope is disposed', async () => {
    vi.useFakeTimers();
    const ids = ref(['a']);
    const scope = effectScope();
    scope.run(() => useAppendedIds(() => ids.value));

    ids.value = ['a', 'b'];
    await nextTick();
    expect(vi.getTimerCount()).toBe(1);

    scope.stop();
    expect(vi.getTimerCount()).toBe(0);
  });
});
