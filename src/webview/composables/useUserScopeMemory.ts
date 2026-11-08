import { computed, type ComputedRef } from 'vue';
import type { WebviewToExtensionMessage } from '@shared/types/messages';
import type { MemoryTier } from '@shared/types/memory';
import { useChatHost } from './useChatHost';

/** The list a shown memory row came from: this computer's user list (a remote chat only), or the chat's own core. */
export type MemoryRowSource = 'user' | 'chat';
export type MemoryRowAction = 'pin' | 'unpin' | 'forget' | 'unforget' | 'delete' | 'history' | 'related';

export interface MemoryCreate {
  tier: Exclude<MemoryTier, 'observation'>;
  kind: 'fact' | 'preference' | 'episode';
  content: string;
  requestId: string;
}

export interface UserScopeMemory {
  /** A remote chat's page: this computer's notes and globals come from this computer's core as a second list. */
  separate: ComputedRef<boolean>;
  rowMessage: (source: MemoryRowSource, action: MemoryRowAction, id: string) => WebviewToExtensionMessage;
  createMessage: (create: MemoryCreate) => WebviewToExtensionMessage;
  profileSaveMessage: (scope: 'project' | 'global', section: 'static' | 'dynamic', content: string) => WebviewToExtensionMessage;
}

export function useUserScopeMemory(): UserScopeMemory {
  const host = useChatHost();
  // main names the host only once it answers the page's init, so this can turn true after the first render
  const separate = computed(() => host.value !== undefined);

  // A user row carries this computer's own id, which only the *User* types may name; main sends those to this computer's core alone.
  function rowMessage(source: MemoryRowSource, action: MemoryRowAction, id: string): WebviewToExtensionMessage {
    const user = source === 'user';
    switch (action) {
      case 'pin': return { type: user ? 'pinUserMemory' : 'pinMemory', id };
      case 'unpin': return { type: user ? 'unpinUserMemory' : 'unpinMemory', id };
      case 'forget': return { type: user ? 'forgetUserMemory' : 'forgetMemory', id, scope: 'chain' };
      case 'unforget': return { type: user ? 'unforgetUserMemory' : 'unforgetMemory', id, scope: 'chain' };
      case 'delete': return { type: user ? 'deleteUserMemory' : 'deleteMemory', id };
      case 'history': return { type: user ? 'getUserMemoryHistory' : 'getMemoryHistory', id };
      case 'related': return { type: user ? 'getUserRelatedMemories' : 'getRelatedMemories', id };
    }
  }

  function createMessage({ tier, kind, content, requestId }: MemoryCreate): WebviewToExtensionMessage {
    if (separate.value && tier === 'note') return { type: 'createUserMemory', tier, content, requestId };
    if (separate.value && tier === 'global') return { type: 'createUserMemory', tier, kind, content, requestId };
    return { type: 'createMemory', tier, kind, content, requestId };
  }

  function profileSaveMessage(scope: 'project' | 'global', section: 'static' | 'dynamic', content: string): WebviewToExtensionMessage {
    if (separate.value && scope === 'global') return { type: 'setUserProfileSection', section, content };
    return { type: 'setProfileSection', scope, section, content };
  }

  return { separate, rowMessage, createMessage, profileSaveMessage };
}
