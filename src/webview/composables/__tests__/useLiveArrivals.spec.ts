import { describe, it, expect, vi, afterEach } from 'vitest';
import { effectScope, nextTick, ref } from 'vue';
import type { ChatMessage } from '@shared/types/session';
import type { VirtualItem } from '../useVirtualizedMessages';
import { ARRIVAL_MS, useLiveArrivals } from '../useLiveArrivals';

/**
 * The transcript is virtualized: scrolling unmounts and remounts rows, so an entrance keyed to mount
 * would replay on every scroll. Only a row that arrived live may animate, and only briefly.
 */

function item(id: string, type: VirtualItem['type'], replay = false): VirtualItem {
  const message: ChatMessage = { id: `m-${id}`, role: 'assistant', content: '', timestamp: 1, ...(replay ? { isReplay: true } : {}) };
  return { id, type, message, originalMessageIndex: 0, sourceMessageId: message.id, spacingLevel: 0 };
}

afterEach(() => vi.useRealTimers());

describe('which transcript rows count as arriving', () => {
  it('ignores the rows already present when the list first renders', () => {
    const arriving = useLiveArrivals(ref([item('a', 'user-message'), item('b', 'tool-call')]));

    expect(arriving.size).toBe(0);
  });

  it('marks a row that appears afterwards, then clears it once the entrance is over', async () => {
    vi.useFakeTimers();
    const items = ref([item('a', 'user-message')]);
    const arriving = useLiveArrivals(items);

    items.value = [...items.value, item('b', 'tool-call')];
    await nextTick();
    expect(arriving.has('b')).toBe(true);

    vi.advanceTimersByTime(ARRIVAL_MS);
    expect(arriving.has('b')).toBe(false);
  });

  it('never marks replayed history', async () => {
    const items = ref<VirtualItem[]>([]);
    const arriving = useLiveArrivals(items);

    items.value = [item('a', 'user-message', true), item('b', 'tool-call', true)];
    await nextTick();

    expect(arriving.size).toBe(0);
  });

  it('never marks the text-block a finished stream turns into', async () => {
    const items = ref([item('s', 'streaming-text')]);
    const arriving = useLiveArrivals(items);

    items.value = [item('t', 'text-block')];
    await nextTick();

    expect(arriving.has('t')).toBe(false);
  });

  it('does not mark a row again when it leaves the list and comes back', async () => {
    vi.useFakeTimers();
    const items = ref<VirtualItem[]>([]);
    const arriving = useLiveArrivals(items);
    const row = item('a', 'user-message');

    items.value = [row];
    await nextTick();
    vi.advanceTimersByTime(ARRIVAL_MS);
    items.value = [];
    await nextTick();
    items.value = [row];
    await nextTick();

    expect(arriving.has('a')).toBe(false);
  });

  it('leaves no timer running once its scope is disposed', async () => {
    vi.useFakeTimers();
    const items = ref([item('a', 'user-message')]);
    const scope = effectScope();
    scope.run(() => useLiveArrivals(items));

    items.value = [...items.value, item('b', 'tool-call')];
    await nextTick();
    expect(vi.getTimerCount()).toBe(1);

    scope.stop();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('design cards arriving', () => {
  const result = { designId: 'd', version: 1, folder: 'f', title: 'T', screens: [], decisions: [], check: { errors: 0 as const, warnings: [] }, journeys: [], previousVersion: null, changes: [] };

  // A design card follows a message it is not part of: a live card after replayed history still enters, a replayed one never does.
  it.each([[true, true], [false, false]])('a card posted live=%s enters=%s whatever its anchor message is', async (live, enters) => {
    const items = ref<VirtualItem[]>([item('a', 'text-block', true)]);
    const arriving = useLiveArrivals(items);

    items.value = [...items.value, { ...item('design-r', 'design-result', true), designCard: { kind: 'result', entryId: 'r', afterMessageId: 'm-a', afterTimestamp: 1, live, result } }];
    await nextTick();

    expect(arriving.has('design-r')).toBe(enters);
  });
});
