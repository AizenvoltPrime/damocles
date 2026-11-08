import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { shallowRef } from 'vue';
import { setActivePinia, createPinia } from 'pinia';
import { i18n } from '@/i18n';
import { createMemoryHandlers } from '../memory-handlers';
import { useMemoryStore } from '@/stores/useMemoryStore';
import { useContextInjectionStore } from '@/stores/useContextInjectionStore';
import { useUIStore } from '@/stores/useUIStore';
import { useMemoryAuditStore } from '@/stores/useMemoryAuditStore';
import { useSettingsStore } from '@/stores/useSettingsStore';
import type { HandlerContext } from '../../types';
import type { ExtensionToWebviewMessage, WebviewToExtensionMessage } from '@shared/types/messages';
import type { MemoryEntry } from '@shared/types/memory';
import type { ChatHost } from '@/composables/useChatHost';

// A remote chat's page is one whose host main named; undefined is a local chat.
const chatHost = shallowRef<ChatHost | undefined>(undefined);
vi.mock('@/composables/useChatHost', async (original) => ({ ...await original<typeof import('@/composables/useChatHost')>(), useChatHost: () => chatHost }));

const toasts = vi.hoisted((): string[] => []);
vi.mock('vue-sonner', () => {
  const record = (text: string) => void toasts.push(text);
  return { toast: Object.assign(record, { success: record, error: record, info: record }) };
});

const posted: WebviewToExtensionMessage[] = [];

function deliver(msg: ExtensionToWebviewMessage): void {
  const ctx = {
    stores: { memoryStore: useMemoryStore(), contextInjectionStore: useContextInjectionStore(), uiStore: useUIStore(), memoryAuditStore: useMemoryAuditStore(), settingsStore: useSettingsStore() },
    bridge: { postMessage: (m: WebviewToExtensionMessage) => posted.push(m) },
  } as unknown as HandlerContext;
  const handler = createMemoryHandlers()[msg.type] as ((m: ExtensionToWebviewMessage, c: HandlerContext) => void) | undefined;
  handler!(msg, ctx);
}

const memory: MemoryEntry = { id: 'm1', tier: 'global', kind: 'fact', content: 'x', sessionId: null, workspace: null, createdAt: 1, updatedAt: 1, tags: [] };

beforeEach(() => {
  setActivePinia(createPinia());
  toasts.length = 0;
  posted.length = 0;
  chatHost.value = undefined;
});
afterEach(() => {
  i18n.global.locale.value = 'en';
});

describe('memory toasts', () => {
  it('pluralizes forget and restore counts', () => {
    deliver({ type: 'memoryForgotten', id: 'm1', count: 1 });
    deliver({ type: 'memoryForgotten', id: 'm1', count: 3 });
    deliver({ type: 'memoryUnforgotten', id: 'm1', count: 2 });
    expect(toasts).toEqual(['Forgot 1 memory', 'Forgot 3 memories', 'Restored 2 memories']);
  });

  it('speaks the UI language', () => {
    i18n.global.locale.value = 'el';
    deliver({ type: 'memoryCreated', memory });
    deliver({ type: 'memoryPinned', id: 'm1' });
    deliver({ type: 'memoryForgotten', id: 'm1', count: 2 });
    expect(toasts).toEqual(['Η καθολική μνήμη αποθηκεύτηκε', 'Η μνήμη καρφιτσώθηκε', 'Ξεχάστηκαν 2 μνήμες']);
  });

  it('names the server for a global memory saved where the host keeps global memories on it', () => {
    const settings = useSettingsStore();
    settings.hostCapabilities = { ...settings.hostCapabilities, globalMemoryOnServer: true };
    deliver({ type: 'memoryCreated', memory });
    deliver({ type: 'memoryCreated', memory: { ...memory, tier: 'project' } });
    expect(toasts).toEqual(['Global memory saved on this server', 'Project memory saved']);
  });

  it('logs an audit error in English whatever the view language', () => {
    i18n.global.locale.value = 'el';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      deliver({ type: 'memoryError', source: 'audit', code: 'unavailable', message: { message: 'Memory system is not available' } });
      expect(warn).toHaveBeenCalledWith('[MemoryAudit] unavailable: Memory system is not available');
    } finally {
      warn.mockRestore();
    }
  });

  it('opens the memory panel without asking for the list, which the panel requests itself', () => {
    const postMessage = vi.fn();
    const ctx = { stores: { uiStore: useUIStore() }, bridge: { postMessage } } as unknown as HandlerContext;
    createMemoryHandlers().openMemoryPanel!({ type: 'openMemoryPanel' }, ctx);
    expect(useUIStore().showMemoryPanel).toBe(true);
    expect(postMessage).not.toHaveBeenCalled();
  });
});

describe('this computer\'s memories in a remote chat', () => {
  const REMOTE: ChatHost = { name: 'prod-1', computer: 'ALEXIOS-PC' };
  const hostRow: MemoryEntry = { ...memory, id: 'h1', tier: 'project', scope: 'project' };
  const userRow = (id: string, over: Partial<MemoryEntry> = {}): MemoryEntry => ({ ...memory, id, scope: 'global', updatedAt: 9, ...over });

  function remoteWithRows(): ReturnType<typeof useMemoryStore> {
    chatHost.value = REMOTE;
    deliver({ type: 'memoriesUpdate', memories: [hostRow], observationCursor: null });
    deliver({ type: 'userMemoriesUpdate', memories: [userRow('u1', { content: 'my preference', rootId: null }), userRow('u2', { content: 'my other one' })], available: true });
    return useMemoryStore();
  }

  it('asks this computer\'s list again for a note or global row the chat core created while the panel is open, and still settles and toasts', () => {
    chatHost.value = REMOTE;
    useUIStore().openMemoryPanel();
    const store = useMemoryStore();
    deliver({ type: 'memoryCreated', memory: { ...memory, id: 'global:client-1:g1', scope: 'global' } });
    deliver({ type: 'memoryCreated', memory: { ...memory, id: 'global:client-1:n1', tier: 'note', kind: 'note' }, requestId: 'create-1' });

    expect(store.chatMemories).toEqual([]);
    expect(posted).toEqual([{ type: 'requestUserMemories' }, { type: 'requestUserMemories' }]);
    expect(store.createSettlement).toEqual({ requestId: 'create-1', ok: true });
    expect(toasts).toEqual(['Global memory saved', 'Note saved']);
  });

  it('asks nothing for such a row while the panel is closed, since the panel asks when it opens', () => {
    chatHost.value = REMOTE;
    deliver({ type: 'memoryCreated', memory: { ...memory, id: 'global:client-1:g1', scope: 'global' } });

    expect(useMemoryStore().chatMemories).toEqual([]);
    expect(posted).toEqual([]);
  });

  it('inserts a created host row in a remote chat, and any created row in a local chat', () => {
    chatHost.value = REMOTE;
    deliver({ type: 'memoryCreated', memory: hostRow });
    expect(useMemoryStore().memories.map(m => m.id)).toEqual(['h1']);

    setActivePinia(createPinia());
    chatHost.value = undefined;
    deliver({ type: 'memoryCreated', memory: { ...memory, scope: 'global' } });
    expect(useMemoryStore().memories.map(m => m.id)).toEqual(['m1']);
    expect(posted).toEqual([]);
  });

  it('adds a row this computer\'s core created, settles its create and toasts', () => {
    const store = remoteWithRows();
    deliver({ type: 'userMemoryCreated', memory: userRow('u3', { tier: 'note', kind: 'note', updatedAt: 20 }), requestId: 'create-2' });

    expect(store.memories.map(m => [m.id, store.rowSource(m.id)])).toEqual([['u3', 'user'], ['u1', 'user'], ['u2', 'user'], ['h1', 'chat']]);
    expect(store.createSettlement).toEqual({ requestId: 'create-2', ok: true });
    expect(toasts).toEqual(['Note saved']);
  });

  it('shows memory off on this computer from its core\'s real answers, beside the host\'s rows, with no error toast', () => {
    chatHost.value = REMOTE;
    deliver({ type: 'memoriesUpdate', memories: [hostRow], observationCursor: null });
    deliver({ type: 'userMemoriesUpdate', memories: [], available: false });
    deliver({ type: 'userProfileData', global: { static: '', dynamic: '' }, available: false });

    const store = useMemoryStore();
    expect(store.userMemoryOff).toBe(true);
    expect(store.memories.map(m => m.id)).toEqual(['h1']);
    expect(toasts).toEqual([]);
  });

  it('patches this computer\'s rows by the replies only its core posts', () => {
    const store = remoteWithRows();
    deliver({ type: 'userMemoryPinned', id: 'u1' });
    deliver({ type: 'userMemoryForgotten', id: 'u2', count: 1 });
    deliver({ type: 'userMemoryHistory', id: 'u1', entries: [userRow('u1', { content: 'v1' })] });
    deliver({ type: 'userRelatedMemories', id: 'u1', entries: [userRow('u2')] });

    expect(store.memories.find(m => m.id === 'u1')).toMatchObject({ pinned: true });
    expect(store.memories.find(m => m.id === 'u2')).toMatchObject({ forgotten: true });
    expect(store.versionHistory.user.u1?.map(m => m.content)).toEqual(['v1']);
    expect(store.relatedMemories.user.u1?.map(m => m.id)).toEqual(['u2']);

    deliver({ type: 'userMemoryUnpinned', id: 'u1' });
    deliver({ type: 'userMemoryUnforgotten', id: 'u2', count: 1 });
    expect(store.memories.find(m => m.id === 'u1')?.pinned).toBe(false);
    expect(store.memories.find(m => m.id === 'u2')?.forgotten).toBe(false);
    deliver({ type: 'userMemoryDeleted', id: 'u1' });
    expect(store.memories.map(m => m.id)).toEqual(['u2', 'h1']);
    expect(toasts).toEqual(['Memory pinned', 'Forgot 1 memory', 'Memory unpinned', 'Restored 1 memory']);
  });

  it('leaves this computer\'s rows, and their dialogs, as they are for chat core replies naming their ids', () => {
    const store = remoteWithRows();
    const before = JSON.stringify(store.memories);

    deliver({ type: 'memoryUpdated', memory: { ...hostRow, id: 'u1', content: 'Outdated, delete me' } });
    deliver({ type: 'memoryUpdated', memory: { ...hostRow, id: 'u2', content: 'Outdated, delete me' }, replacedId: 'u1' });
    deliver({ type: 'memoryPinned', id: 'u1' });
    deliver({ type: 'memoryForgotten', id: 'u2', count: 1 });
    deliver({ type: 'memoryDeleted', id: 'u1' });
    deliver({ type: 'memoryHistory', id: 'u1', entries: [{ ...hostRow, id: 'u1', content: 'host text' }] });
    deliver({ type: 'relatedMemories', id: 'u1', entries: [{ ...hostRow, content: 'host text' }] });

    expect(JSON.stringify(store.memories)).toBe(before);
    expect([store.rowSource('u1'), store.rowSource('u2')]).toEqual(['user', 'user']);
    expect(store.versionHistory.user).toEqual({});
    expect(store.relatedMemories.user).toEqual({});
  });

  it('confirms a saved global profile section from this computer\'s answer', () => {
    chatHost.value = REMOTE;
    deliver({ type: 'userProfileData', global: { static: 'mine', dynamic: '' }, available: true, savedSection: { scope: 'global', section: 'dynamic' } });

    const store = useMemoryStore();
    expect(store.profile.global).toEqual({ static: 'mine', dynamic: '' });
    expect(store.lastSavedProfileSection).toBe('globalDynamic');
  });

  it('reports a failed global profile save only from this computer\'s answer', () => {
    chatHost.value = REMOTE;
    const store = useMemoryStore();
    deliver({ type: 'profileSectionError', scope: 'global', section: 'static', message: { message: 'host text' } });
    expect(store.profileSectionError).toBeNull();
    expect(toasts).toEqual([]);

    deliver({ type: 'userProfileSectionError', section: 'static', message: { message: 'Saving failed' } });
    expect(store.profileSectionError?.key).toBe('globalStatic');
    deliver({ type: 'profileSectionError', scope: 'project', section: 'dynamic', message: { message: 'Project failed' } });
    expect(store.profileSectionError?.key).toBe('projectDynamic');
    expect(toasts).toEqual(['Saving failed', 'Project failed']);
  });

  it('keeps the host\'s pending search and paging when this computer\'s core fails a request', () => {
    chatHost.value = REMOTE;
    const store = useMemoryStore();
    store.setPendingSearchQuery('deploy');
    store.loadingObservations = true;

    deliver({ type: 'userMemoryError', request: 'requestUserMemories', message: { message: 'The engine is not running' } });
    deliver({ type: 'userMemoryError', request: 'createUserMemory', requestId: 'create-3', message: { message: 'Too long' } });

    expect(store.pendingSearchQuery).toBe('deploy');
    expect(store.loadingObservations).toBe(true);
    expect(store.userMemoryFailures).toBe(1);
    expect(store.createSettlement).toEqual({ requestId: 'create-3', ok: false });
    expect(toasts).toEqual(['The engine is not running', 'Too long']);
  });

  it('counts only a failed list read as the list\'s failure', () => {
    chatHost.value = REMOTE;
    deliver({ type: 'userMemoryError', request: 'getUserProfile', message: { message: 'x' } });
    deliver({ type: 'userMemoryError', request: 'getUserMemoryHistory', message: { message: 'x' } });
    expect(useMemoryStore().userMemoryFailures).toBe(0);
  });
});

describe('a local chat\'s replies', () => {
  it('patch its global rows as before', () => {
    deliver({ type: 'memoriesUpdate', memories: [{ ...memory, id: 'g1', scope: 'global', pinned: false, forgotten: false }, { ...memory, id: 'g2', scope: 'global', pinned: false, forgotten: false }], observationCursor: null });
    deliver({ type: 'memoryPinned', id: 'g1' });
    deliver({ type: 'memoryForgotten', id: 'g2', count: 1 });
    deliver({ type: 'memoryUpdated', memory: { ...memory, id: 'g1', scope: 'global', pinned: true, forgotten: false, content: 'edited' } });
    deliver({ type: 'memoryHistory', id: 'g1', entries: [{ ...memory, id: 'g1' }] });

    const store = useMemoryStore();
    expect(store.memories.map(m => [m.id, m.content, m.pinned, m.forgotten])).toEqual([['g1', 'edited', true, false], ['g2', 'x', false, true]]);
    expect(store.versionHistory.chat.g1).toHaveLength(1);
    deliver({ type: 'memoryDeleted', id: 'g2' });
    expect(store.memories.map(m => m.id)).toEqual(['g1']);
    deliver({ type: 'profileSectionError', scope: 'global', section: 'static', message: { message: 'Saving failed' } });
    expect(store.profileSectionError?.key).toBe('globalStatic');
  });
});
