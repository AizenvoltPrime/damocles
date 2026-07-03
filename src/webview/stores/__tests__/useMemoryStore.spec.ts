import { describe, it, expect, beforeEach } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { useMemoryStore } from '../useMemoryStore';
import type { MemoryEntry } from '@shared/types/memory';
import type { ObservationCursor } from '@shared/types/messages';

function entry(id: string, over: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    id,
    tier: 'observation',
    content: `content ${id}`,
    sessionId: null,
    workspace: null,
    createdAt: 1000,
    updatedAt: 1000,
    tags: [],
    ...over,
  };
}

describe('useMemoryStore in-place patches', () => {
  beforeEach(() => setActivePinia(createPinia()));

  it('setPinned flips pinned in place without touching other entries', () => {
    const store = useMemoryStore();
    store.setMemories([entry('a', { pinned: false }), entry('b', { pinned: false })]);

    store.setPinned('a', true);

    expect(store.memories.find(m => m.id === 'a')!.pinned).toBe(true);
    expect(store.memories.find(m => m.id === 'b')!.pinned).toBe(false);
  });

  it('setForgotten flips forgotten in place', () => {
    const store = useMemoryStore();
    store.setMemories([entry('a', { forgotten: false })]);

    store.setForgotten('a', true);
    expect(store.memories.find(m => m.id === 'a')!.forgotten).toBe(true);

    store.setForgotten('a', false);
    expect(store.memories.find(m => m.id === 'a')!.forgotten).toBe(false);
  });

  it('replaceMemory replaces the matching id and leaves others intact', () => {
    const store = useMemoryStore();
    store.setMemories([entry('a', { content: 'old' }), entry('b')]);

    store.replaceMemory(entry('a', { content: 'new' }));

    expect(store.memories.find(m => m.id === 'a')!.content).toBe('new');
    expect(store.memories.find(m => m.id === 'b')!.content).toBe('content b');
    expect(store.memories).toHaveLength(2);
  });

  it('removeMemory removes the matching id', () => {
    const store = useMemoryStore();
    store.setMemories([entry('a'), entry('b')]);

    store.removeMemory('a');

    expect(store.memories.map(m => m.id)).toEqual(['b']);
  });
});

describe('useMemoryStore keyset pagination', () => {
  beforeEach(() => setActivePinia(createPinia()));

  it('appendObservations appends entries and stores nextCursor + hasMore', () => {
    const store = useMemoryStore();
    const cursor: ObservationCursor = { createdAt: 500, id: 'a' };
    store.setMemories([entry('a')], true, { createdAt: 1000, id: 'a' });

    store.appendObservations([entry('b'), entry('c')], false, cursor);

    expect(store.memories.map(m => m.id)).toEqual(['a', 'b', 'c']);
    expect(store.hasMoreObservations).toBe(false);
    expect(store.observationCursor).toEqual(cursor);
    expect(store.loadingObservations).toBe(false);
  });

  it('a second append does not drop the first page and dedupes by id', () => {
    const store = useMemoryStore();
    store.setMemories([entry('a')], true, { createdAt: 1000, id: 'a' });

    store.appendObservations([entry('b')], true, { createdAt: 900, id: 'b' });
    store.appendObservations([entry('b'), entry('c')], false, { createdAt: 800, id: 'c' });

    expect(store.memories.map(m => m.id)).toEqual(['a', 'b', 'c']);
    expect(store.observationCursor).toEqual({ createdAt: 800, id: 'c' });
  });
});

describe('useMemoryStore create tokens', () => {
  beforeEach(() => setActivePinia(createPinia()));

  it('settleCreate records the requestId and outcome so only the matching create settles', () => {
    const store = useMemoryStore();
    expect(store.createSettlement).toBeNull();

    store.settleCreate('req-1', true);
    expect(store.createSettlement).toEqual({ requestId: 'req-1', ok: true });

    store.settleCreate('req-2', false);
    expect(store.createSettlement).toEqual({ requestId: 'req-2', ok: false });
  });

  it('setForgotten flips every loaded row sharing the version chain, not just the clicked id', () => {
    const store = useMemoryStore();
    const now = Date.now();
    const row = (id: string, rootId: string | null) => ({
      id, tier: 'project' as const, kind: 'fact' as const, scope: 'project' as const,
      content: id, sessionId: null, timestamp: now, forgotten: false, rootId,
    });
    store.setMemories([row('v1', null), row('v2', 'v1'), row('unrelated', null)]);

    store.setForgotten('v2', true);
    expect(store.memories.find(m => m.id === 'v1')?.forgotten).toBe(true);
    expect(store.memories.find(m => m.id === 'v2')?.forgotten).toBe(true);
    expect(store.memories.find(m => m.id === 'unrelated')?.forgotten).toBe(false);
  });

  it('appendObservations treats hasMore:true with a null cursor as end-of-list', () => {
    const store = useMemoryStore();
    store.appendObservations([], true, null);
    expect(store.hasMoreObservations).toBe(false);
  });

  it('setSearchResults drops results whose query no longer matches the pending dispatch', () => {
    const store = useMemoryStore();
    const result = { id: 'r', tier: 'project', kind: 'fact', scope: 'project', content: 'x', snippet: 'x', timestamp: Date.now() } as never;
    store.setPendingSearchQuery('B');
    store.setSearchResults([result], 'A'); // stale A→B landing: ignored
    expect(store.searchResults).toHaveLength(0);
    store.setSearchResults([result], 'B'); // matches the pending query: applied
    expect(store.searchResults).toHaveLength(1);
  });
});
