import { describe, it, expect, beforeEach, vi } from 'vitest';
import { shallowRef } from 'vue';
import { setActivePinia, createPinia } from 'pinia';
import { useMemoryStore } from '../useMemoryStore';
import type { MemoryEntry } from '@shared/types/memory';
import type { ObservationCursor } from '@shared/types/messages';
import type { ChatHost } from '@/composables/useChatHost';

// A remote chat's page is one whose host main named; undefined is a local chat.
const chatHost = shallowRef<ChatHost | undefined>(undefined);
vi.mock('@/composables/useChatHost', () => ({ useChatHost: () => chatHost }));

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

    store.setPinned('a', true, 'chat');

    expect(store.memories.find(m => m.id === 'a')!.pinned).toBe(true);
    expect(store.memories.find(m => m.id === 'b')!.pinned).toBe(false);
  });

  it('setForgotten flips forgotten in place', () => {
    const store = useMemoryStore();
    store.setMemories([entry('a', { forgotten: false })]);

    store.setForgotten('a', true, 'chat');
    expect(store.memories.find(m => m.id === 'a')!.forgotten).toBe(true);

    store.setForgotten('a', false, 'chat');
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

    store.removeMemory('a', 'chat');

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
    const row = (id: string, rootId: string | null): MemoryEntry => ({
      id, tier: 'project', kind: 'fact', scope: 'project',
      content: id, sessionId: null, workspace: null, tags: [],
      createdAt: now, updatedAt: now, forgotten: false, rootId,
    });
    store.setMemories([row('v1', null), row('v2', 'v1'), row('unrelated', null)]);

    store.setForgotten('v2', true, 'chat');
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

describe('useMemoryStore clearFolderData', () => {
  beforeEach(() => setActivePinia(createPinia()));

  it('drops folder-bound data and keeps the user filters', () => {
    const store = useMemoryStore();
    store.setMemories([entry('a')], true, { createdAt: 1, id: 'a' });
    store.setVersionHistory('a', [entry('a')], 'chat');
    store.setProfile({ static: 'project', dynamic: 'p' }, { static: 'global', dynamic: 'g' });
    store.setKindFilter('fact');
    store.setShowForgotten(true);

    store.clearFolderData();

    expect(store.memories).toEqual([]);
    expect(store.hasMoreObservations).toBe(false);
    expect(store.observationCursor).toBeNull();
    expect(store.versionHistory).toEqual({ chat: {}, user: {} });
    expect(store.profile).toEqual({ project: { static: '', dynamic: '' }, global: { static: '', dynamic: '' } });
    expect(store.kindFilter).toBe('fact');
    expect(store.showForgotten).toBe(true);
  });

  const RESULT = { id: 'r', tier: 'project', kind: 'fact', scope: 'project', content: 'x', snippet: 'x', timestamp: 1 } as never;

  it.each([
    ['with its query', 'deploy'],
    ['without a query', undefined],
  ])('drops a late reply %s to a search run in the previous folder', (_name, query) => {
    const store = useMemoryStore();
    store.setPendingSearchQuery('deploy');

    store.clearFolderData();
    store.setSearchResults([RESULT], query);

    expect(store.searchResults).toEqual([]);
  });

  it('drops the late reply even after a memoryError cleared the pending query', () => {
    const store = useMemoryStore();
    store.setPendingSearchQuery('deploy');
    store.clearFolderData();

    store.setPendingSearchQuery(null);
    store.setSearchResults([RESULT], 'deploy');

    expect(store.searchResults).toEqual([]);
  });

  it('accepts results again once a search is dispatched in the new folder', () => {
    const store = useMemoryStore();
    store.clearFolderData();

    store.setPendingSearchQuery('build');
    store.setSearchResults([RESULT], 'build');

    expect(store.searchResults).toHaveLength(1);
  });
});

describe('useMemoryStore in a remote chat', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    chatHost.value = undefined;
  });

  const REMOTE: ChatHost = { name: 'prod-1', computer: 'ALEXIOS-PC' };
  const graph = (id: string, updatedAt: number, over: Partial<MemoryEntry> = {}) =>
    entry(id, { tier: 'project', kind: 'fact', scope: 'project', updatedAt, ...over });
  const userRow = (id: string, updatedAt: number, over: Partial<MemoryEntry> = {}) =>
    entry(id, { tier: 'global', kind: 'preference', scope: 'global', updatedAt, ...over });

  it('lists graph rows of both cores newest first, then the chat core\'s observations in its page order', () => {
    chatHost.value = REMOTE;
    const store = useMemoryStore();
    store.setMemories([graph('h2', 50), graph('h1', 10), entry('o1', { updatedAt: 1 }), entry('o2', { updatedAt: 99 })]);
    store.setUserMemories([userRow('u1', 70), userRow('n1', 20, { tier: 'note', kind: 'note' })], true);

    expect(store.memories.map(m => m.id)).toEqual(['u1', 'h2', 'n1', 'h1', 'o1', 'o2']);
    expect(store.notes.map(m => m.id)).toEqual(['n1']);
    expect(store.observations.map(m => m.id)).toEqual(['o1', 'o2']);
  });

  it('ignores the chat core\'s global rows, which only this computer\'s list shows', () => {
    chatHost.value = REMOTE;
    const store = useMemoryStore();
    store.setMemories([graph('h1', 10), userRow('global:client-1:u1', 30)]);
    store.setUserMemories([userRow('u1', 30)], true);

    expect(store.memories.map(m => m.id)).toEqual(['u1', 'h1']);
    expect(store.rowSource('u1')).toBe('user');
    expect(store.rowSource('h1')).toBe('chat');
    expect(store.rowSource('global:client-1:u1')).toBeUndefined();
  });

  it('shows one row per id: a host row reusing one of this computer\'s ids gives way to this computer\'s row', () => {
    chatHost.value = REMOTE;
    const store = useMemoryStore();
    store.setMemories([graph('n1', 90, { content: 'outdated, delete me' }), graph('h1', 10)]);
    store.setUserMemories([userRow('n1', 20, { tier: 'note', kind: 'note', content: 'my note' })], true);

    expect(store.memories.map(m => [m.id, m.content])).toEqual([['n1', 'my note'], ['h1', 'content h1']]);
    expect(store.rowSource('n1')).toBe('user');
  });

  it('shows the chat core\'s list unchanged in a local chat, global rows included', () => {
    const store = useMemoryStore();
    store.setMemories([graph('h1', 10), userRow('g1', 30), entry('o1')]);
    store.setUserMemories([userRow('u1', 70)], true);

    expect(store.separate).toBe(false);
    expect(store.memories.map(m => m.id)).toEqual(['h1', 'g1', 'o1']);
    expect(store.rowSource('g1')).toBe('chat');
    expect(store.rowSource('u1')).toBeUndefined();
  });

  it('merges once main names the host after the page started', () => {
    const store = useMemoryStore();
    store.setMemories([graph('h1', 10)]);
    store.setUserMemories([userRow('u1', 70)], true);
    expect(store.memories.map(m => m.id)).toEqual(['h1']);

    chatHost.value = REMOTE;
    expect(store.memories.map(m => m.id)).toEqual(['u1', 'h1']);
  });

  it('patches each list only by the replies of its own core', () => {
    chatHost.value = REMOTE;
    const store = useMemoryStore();
    store.setMemories([graph('h1', 10), graph('h2', 5)]);
    store.setUserMemories([userRow('u1', 70), userRow('u2', 60, { rootId: 'u1' }), userRow('u3', 50)], true);

    store.setPinned('u3', true, 'user');
    store.setPinned('h1', true, 'chat');
    store.setForgotten('u2', true, 'user');
    store.removeMemory('h2', 'chat');

    const byId = (id: string) => store.memories.find(m => m.id === id);
    expect(byId('u3')?.pinned).toBe(true);
    expect(byId('h1')?.pinned).toBe(true);
    expect([byId('u1')?.forgotten, byId('u2')?.forgotten, byId('u3')?.forgotten]).toEqual([true, true, undefined]);
    expect(byId('h1')?.forgotten).toBeUndefined();

    store.removeMemory('u1', 'user');
    expect(store.memories.map(m => m.id)).toEqual(['u2', 'u3', 'h1']);
  });

  it('never changes this computer\'s rows by a chat core patch naming their ids', () => {
    chatHost.value = REMOTE;
    const store = useMemoryStore();
    store.setMemories([graph('h1', 10)]);
    store.setUserMemories([userRow('u1', 70, { content: 'my preference' }), userRow('u2', 60, { content: 'my other one' })], true);
    const before = JSON.stringify(store.memories);

    store.replaceMemory(graph('u1', 99, { content: 'Outdated, delete me' }));
    store.replaceMemoryChain('u1', graph('u2', 99, { content: 'Outdated, delete me' }));
    store.setPinned('u1', true, 'chat');
    store.setForgotten('u2', true, 'chat');
    store.removeMemory('u1', 'chat');
    store.setVersionHistory('u1', [graph('u1', 1, { content: 'host text' })], 'chat');
    store.setRelatedMemories('u1', [graph('x', 1, { content: 'host text' })], 'chat');

    expect(JSON.stringify(store.memories)).toBe(before);
    expect([store.rowSource('u1'), store.rowSource('u2')]).toEqual(['user', 'user']);
    expect(store.versionHistory.user).toEqual({});
    expect(store.relatedMemories.user).toEqual({});
  });

  it('drops the chat core\'s notes, a note without a scope included', () => {
    chatHost.value = REMOTE;
    const store = useMemoryStore();
    store.setMemories([graph('h1', 10), entry('global:client-1:n1', { tier: 'note', kind: 'note', updatedAt: 20 })]);
    store.setUserMemories([], true);

    expect(store.memories.map(m => m.id)).toEqual(['h1']);
    expect(store.rowSource('global:client-1:n1')).toBeUndefined();
  });

  it('adds a row this computer\'s core created to its list once that list is loaded', () => {
    chatHost.value = REMOTE;
    const store = useMemoryStore();
    store.addUserMemory(userRow('u0', 80));
    expect(store.userMemories).toBeNull();

    store.setUserMemories([userRow('u1', 70)], true);
    store.addUserMemory(userRow('u2', 80));
    expect(store.memories.map(m => m.id)).toEqual(['u2', 'u1']);
    expect(store.rowSource('u2')).toBe('user');
  });

  it('keeps one row when the created row is already in a list read answered before the create\'s reply', () => {
    chatHost.value = REMOTE;
    const store = useMemoryStore();
    store.setUserMemories([userRow('u1', 70), userRow('u2', 60)], true);

    store.addUserMemory(userRow('u2', 60, { content: 'as created' }));

    expect(store.memories.map(m => [m.id, m.content])).toEqual([['u1', 'content u1'], ['u2', 'as created']]);
  });

  it('confirms a global profile section only from this computer\'s answer in a remote chat, and from the chat core in a local one', () => {
    chatHost.value = REMOTE;
    const store = useMemoryStore();
    store.setProfile({ static: 'proj', dynamic: '' }, { static: 'host global', dynamic: '' }, { scope: 'global', section: 'static' });
    expect(store.lastSavedProfileSection).toBeNull();
    store.setProfile({ static: 'proj', dynamic: '' }, { static: '', dynamic: '' }, { scope: 'project', section: 'static' });
    expect(store.lastSavedProfileSection).toBe('projectStatic');

    chatHost.value = undefined;
    store.setProfile({ static: 'proj', dynamic: '' }, { static: 'g', dynamic: '' }, { scope: 'global', section: 'static' });
    expect(store.lastSavedProfileSection).toBe('globalStatic');
  });

  it('counts failed list reads until a list arrives', () => {
    chatHost.value = REMOTE;
    const store = useMemoryStore();
    store.setUserMemoriesFailed();
    store.setUserMemoriesFailed();
    expect(store.userMemoryFailures).toBe(2);

    store.setUserMemories([userRow('u1', 70)], true);
    expect(store.userMemoryFailures).toBe(0);
  });

  it('records that memory is off on this computer and still shows the host\'s rows', () => {
    chatHost.value = REMOTE;
    const store = useMemoryStore();
    store.setMemories([graph('h1', 10)]);
    store.setUserMemories([], false);

    expect(store.userMemoryOff).toBe(true);
    expect(store.memories.map(m => m.id)).toEqual(['h1']);
  });

  it('takes the global profile from this computer and the project profile from the chat core', () => {
    chatHost.value = REMOTE;
    const store = useMemoryStore();
    store.setUserProfile({ static: 'mine', dynamic: 'here' }, true, { scope: 'global', section: 'static' });
    expect(store.lastSavedProfileSection).toBe('globalStatic');

    store.setProfile({ static: 'proj', dynamic: 'p' }, { static: 'host global', dynamic: 'h' });
    expect(store.profile).toEqual({ project: { static: 'proj', dynamic: 'p' }, global: { static: 'mine', dynamic: 'here' } });
    expect(store.lastSavedProfileSection).toBeNull();
  });

  it('keeps this computer\'s list and global profile across a folder switch', () => {
    chatHost.value = REMOTE;
    const store = useMemoryStore();
    store.setMemories([graph('h1', 10)]);
    store.setUserMemories([userRow('u1', 70)], true);
    store.setUserProfile({ static: 'mine', dynamic: '' }, true);

    store.clearFolderData();

    expect(store.memories.map(m => m.id)).toEqual(['u1']);
    expect(store.profile.global).toEqual({ static: 'mine', dynamic: '' });
  });

  it('records memory off on this computer from its profile answer too, and on again', () => {
    chatHost.value = REMOTE;
    const store = useMemoryStore();
    store.setUserProfile({ static: '', dynamic: '' }, false);
    expect(store.userMemoryOff).toBe(true);
    store.setUserProfile({ static: 'mine', dynamic: '' }, true);
    expect(store.userMemoryOff).toBe(false);
  });
});
