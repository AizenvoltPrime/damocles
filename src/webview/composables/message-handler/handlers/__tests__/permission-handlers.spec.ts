import { describe, it, expect, beforeEach } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { createPermissionHandlers } from '../permission-handlers';
import { usePermissionStore } from '@/stores/usePermissionStore';
import { useStreamingStore } from '@/stores/useStreamingStore';
import { useSessionStore } from '@/stores/useSessionStore';
import { useSubagentStore } from '@/stores/useSubagentStore';
import type { HandlerContext } from '../../types';
import type { ExtensionToWebviewMessage } from '@shared/types/messages';

beforeEach(() => setActivePinia(createPinia()));

describe('requestPermission', () => {
  it('keeps the tool input on the pending permission, which the generic prompt shows', () => {
    const ctx = {
      stores: { permissionStore: usePermissionStore(), streamingStore: useStreamingStore(), sessionStore: useSessionStore(), subagentStore: useSubagentStore() },
    } as unknown as HandlerContext;
    const msg: ExtensionToWebviewMessage = { type: 'requestPermission', toolUseId: 'r1', toolName: 'Read', toolInput: { file_path: 'notes/a.txt' } };
    createPermissionHandlers().requestPermission!(msg as never, ctx);

    expect(usePermissionStore().currentPermission).toMatchObject({ toolUseId: 'r1', toolName: 'Read', toolInput: { file_path: 'notes/a.txt' } });
  });
});

describe('permissionAutoResolved', () => {
  const setup = () => {
    const ctx = {
      stores: { permissionStore: usePermissionStore(), streamingStore: useStreamingStore(), sessionStore: useSessionStore(), subagentStore: useSubagentStore() },
    } as unknown as HandlerContext;
    const handlers = createPermissionHandlers();
    handlers.requestPermission!({ type: 'requestPermission', toolUseId: 'r1', toolName: 'Read', toolInput: { file_path: 'README.md' } } as never, ctx);
    const status = () => useStreamingStore().messages.flatMap((m) => m.toolCalls ?? []).find((t) => t.id === 'r1')?.status;
    return { ctx, handlers, status };
  };

  it.each([
    ['after', true],
    ['before', false],
  ])('clears a prompt that Stop withdrew, arriving %s the abandon, without marking the call approved', (_label, abandonFirst) => {
    const { ctx, handlers, status } = setup();
    if (abandonFirst) useStreamingStore().updateToolStatus('r1', 'abandoned');

    handlers.permissionAutoResolved!({ type: 'permissionAutoResolved', toolUseId: 'r1', outcome: 'withdrawn', parentToolUseId: null } as never, ctx);
    expect(status()).not.toBe('approved');
    expect(usePermissionStore().currentPermission).toBeNull();

    if (!abandonFirst) useStreamingStore().updateToolStatus('r1', 'abandoned');
    expect(status()).toBe('abandoned');
  });

  it('marks the call approved when the prompt was auto-approved', () => {
    const { ctx, handlers, status } = setup();

    handlers.permissionAutoResolved!({ type: 'permissionAutoResolved', toolUseId: 'r1', outcome: 'approved' } as never, ctx);

    expect(status()).toBe('approved');
    expect(usePermissionStore().currentPermission).toBeNull();
  });
});
