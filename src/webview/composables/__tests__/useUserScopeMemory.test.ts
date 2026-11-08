import { describe, it, expect, beforeEach, vi } from 'vitest';
import { shallowRef } from 'vue';
import { useUserScopeMemory, type MemoryRowAction } from '../useUserScopeMemory';
import type { ChatHost } from '../useChatHost';

// A remote chat's page is one whose host main named; undefined is a local chat.
const chatHost = shallowRef<ChatHost | undefined>(undefined);
vi.mock('../useChatHost', () => ({ useChatHost: () => chatHost }));

const REMOTE: ChatHost = { name: 'prod-1', computer: 'ALEXIOS-PC' };
const ACTIONS: MemoryRowAction[] = ['pin', 'unpin', 'forget', 'unforget', 'delete', 'history', 'related'];

beforeEach(() => {
  chatHost.value = undefined;
});

describe('useUserScopeMemory', () => {
  it('is separate only once main names the chat\'s host', () => {
    const { separate } = useUserScopeMemory();
    expect(separate.value).toBe(false);
    chatHost.value = REMOTE;
    expect(separate.value).toBe(true);
  });

  it('sends a user row\'s actions by the *User* types and a chat row\'s by the chat core\'s', () => {
    const { rowMessage } = useUserScopeMemory();
    expect(ACTIONS.map((action) => rowMessage('user', action, 'u1'))).toEqual([
      { type: 'pinUserMemory', id: 'u1' },
      { type: 'unpinUserMemory', id: 'u1' },
      { type: 'forgetUserMemory', id: 'u1', scope: 'chain' },
      { type: 'unforgetUserMemory', id: 'u1', scope: 'chain' },
      { type: 'deleteUserMemory', id: 'u1' },
      { type: 'getUserMemoryHistory', id: 'u1' },
      { type: 'getUserRelatedMemories', id: 'u1' },
    ]);
    expect(ACTIONS.map((action) => rowMessage('chat', action, 'h1'))).toEqual([
      { type: 'pinMemory', id: 'h1' },
      { type: 'unpinMemory', id: 'h1' },
      { type: 'forgetMemory', id: 'h1', scope: 'chain' },
      { type: 'unforgetMemory', id: 'h1', scope: 'chain' },
      { type: 'deleteMemory', id: 'h1' },
      { type: 'getMemoryHistory', id: 'h1' },
      { type: 'getRelatedMemories', id: 'h1' },
    ]);
  });

  it('creates global memories and notes on this computer only in a remote chat', () => {
    const { createMessage } = useUserScopeMemory();
    const create = (tier: 'session' | 'project' | 'global' | 'note') => createMessage({ tier, kind: 'preference', content: 'x', requestId: 'r' });

    expect(create('global')).toEqual({ type: 'createMemory', tier: 'global', kind: 'preference', content: 'x', requestId: 'r' });
    chatHost.value = REMOTE;
    expect(create('global')).toEqual({ type: 'createUserMemory', tier: 'global', kind: 'preference', content: 'x', requestId: 'r' });
    expect(create('note')).toEqual({ type: 'createUserMemory', tier: 'note', content: 'x', requestId: 'r' });
    expect(create('project')).toEqual({ type: 'createMemory', tier: 'project', kind: 'preference', content: 'x', requestId: 'r' });
    expect(create('session')).toEqual({ type: 'createMemory', tier: 'session', kind: 'preference', content: 'x', requestId: 'r' });
  });

  it('saves the global profile on this computer only in a remote chat', () => {
    const { profileSaveMessage } = useUserScopeMemory();
    expect(profileSaveMessage('global', 'static', 'x')).toEqual({ type: 'setProfileSection', scope: 'global', section: 'static', content: 'x' });
    chatHost.value = REMOTE;
    expect(profileSaveMessage('global', 'dynamic', 'x')).toEqual({ type: 'setUserProfileSection', section: 'dynamic', content: 'x' });
    expect(profileSaveMessage('project', 'static', 'x')).toEqual({ type: 'setProfileSection', scope: 'project', section: 'static', content: 'x' });
  });
});
