import { describe, it, expect, beforeEach } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { useSessionStore } from '../useSessionStore';

describe('useSessionStore.addCompactMarker — entryId (rewind-to-before-compaction)', () => {
  beforeEach(() => setActivePinia(createPinia()));

  it('stores the compaction entry id on the marker so the card can branch the tree', () => {
    const store = useSessionStore();
    store.addCompactMarker('manual', 43000, 5000, 'the summary', 111, 222, 'comp-7');

    expect(store.compactMarkers).toHaveLength(1);
    expect(store.compactMarkers[0]).toMatchObject({
      trigger: 'manual',
      preTokens: 43000,
      postTokens: 5000,
      summary: 'the summary',
      entryId: 'comp-7',
    });
  });

  it('leaves entryId undefined when none is provided (never fabricated)', () => {
    const store = useSessionStore();
    store.addCompactMarker('auto', 1000);

    expect(store.compactMarkers[0]!.entryId).toBeUndefined();
  });

  it('accumulates one marker per compaction, each carrying its own entry id', () => {
    const store = useSessionStore();
    store.addCompactMarker('manual', 1000, undefined, undefined, 1, undefined, 'comp-1');
    store.addCompactMarker('auto', 2000, undefined, undefined, 2, undefined, 'comp-2');

    expect(store.compactMarkers.map((m) => m.entryId)).toEqual(['comp-1', 'comp-2']);
  });
});
