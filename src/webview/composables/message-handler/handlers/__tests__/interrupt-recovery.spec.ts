import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ref } from 'vue';
import { setActivePinia, createPinia } from 'pinia';
import { createUIHandlers } from '../ui-handlers';
import type { HandlerContext, StoreContext } from '../../types';
import { useStreamingStore } from '@/stores/useStreamingStore';
import { defined } from '@/__tests__/helpers';
import type { ExtensionToWebviewMessage } from '@shared/types/messages';

const toastMock = vi.hoisted(() => ({ info: vi.fn() }));
vi.mock('vue-sonner', () => ({ toast: toastMock }));

const IMAGE = { type: 'image' as const, source: { type: 'base64' as const, media_type: 'image/png' as const, data: 'AAAA' } };
const TYPED = [{ type: 'text' as const, text: 'what is this?' }, IMAGE];

function context(restoreQueued = vi.fn()): HandlerContext {
  const stores = { streamingStore: useStreamingStore() };
  return { stores: stores as unknown as StoreContext, refs: { chatInputRef: ref({ restoreQueued, setInput: vi.fn() }) } } as unknown as HandlerContext;
}

function recover(msg: Extract<ExtensionToWebviewMessage, { type: 'interruptRecovery' }>, ctx: HandlerContext): void {
  defined(createUIHandlers().interruptRecovery, 'interruptRecovery handler')(msg, ctx);
}

describe('interruptRecovery for a prompt stopped before its run', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    toastMock.info.mockClear();
  });

  it('takes the echo out and puts the typed text and image back after whatever the composer holds', () => {
    const restoreQueued = vi.fn();
    const ctx = context(restoreQueued);
    const store = ctx.stores.streamingStore;
    store.addUserMessage('earlier', false, undefined, undefined, 'c0', 0);
    store.addUserMessage(TYPED, false, undefined, undefined, 'c1', 1);

    recover({ type: 'interruptRecovery', correlationId: 'c1', promptContent: 'what is this?', contentBlocks: TYPED }, ctx);

    expect(store.messages.map((m) => m.correlationId)).toEqual(['c0']);
    expect(restoreQueued).toHaveBeenCalledWith(TYPED);
    expect(toastMock.info).toHaveBeenCalledOnce();
  });

  it('puts the typed text and image back for a prompt stopped before it was echoed', () => {
    const restoreQueued = vi.fn();
    const ctx = context(restoreQueued);

    recover({ type: 'interruptRecovery', correlationId: 'c1', promptContent: 'what is this?', contentBlocks: TYPED }, ctx);

    expect(restoreQueued).toHaveBeenCalledWith(TYPED);
  });

  it('puts the typed text back for a prompt with no images', () => {
    const restoreQueued = vi.fn();
    const ctx = context(restoreQueued);

    recover({ type: 'interruptRecovery', correlationId: 'c1', promptContent: 'go' }, ctx);

    expect(restoreQueued).toHaveBeenCalledWith([{ type: 'text', text: 'go' }]);
  });
});
