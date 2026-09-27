import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ref } from 'vue';
import { setActivePinia, createPinia } from 'pinia';
import { createQueueHandlers } from '../queue-handlers';
import type { HandlerContext, StoreContext } from '../../types';
import { useStreamingStore } from '@/stores/useStreamingStore';
import { defined } from '@/__tests__/helpers';
import type { ExtensionToWebviewMessage } from '@shared/types/messages';

const toastMock = vi.hoisted(() => ({ info: vi.fn() }));
vi.mock('vue-sonner', () => ({ toast: toastMock }));

type Cancelled = Extract<ExtensionToWebviewMessage, { type: 'queueCancelled' }>;

const IMAGE = { type: 'image' as const, source: { type: 'base64' as const, media_type: 'image/png' as const, data: 'AAAA' } };

function context(restoreQueued = vi.fn()): HandlerContext {
  const stores = { streamingStore: useStreamingStore() };
  return { stores: stores as unknown as StoreContext, refs: { chatInputRef: ref({ restoreQueued }) } } as unknown as HandlerContext;
}

function cancel(msg: Cancelled, ctx: HandlerContext): void {
  defined(createQueueHandlers().queueCancelled, 'queueCancelled handler')(msg, ctx);
}

describe('queueCancelled', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    toastMock.info.mockClear();
  });

  it('removes a discarded chip and leaves the input alone', () => {
    const restoreQueued = vi.fn();
    const ctx = context(restoreQueued);
    ctx.stores.streamingStore.addQueuedMessage({ id: 'q1', content: 'rerun the spec', timestamp: 1 });

    cancel({ type: 'queueCancelled', messageId: 'q1' }, ctx);

    expect(ctx.stores.streamingStore.messages).toEqual([]);
    expect(restoreQueued).not.toHaveBeenCalled();
    expect(toastMock.info).not.toHaveBeenCalled();
  });

  it('hands a returned chip back to the input, images included, so no chip is left pending', () => {
    const restoreQueued = vi.fn();
    const ctx = context(restoreQueued);
    ctx.stores.streamingStore.addQueuedMessage({ id: 'q1', content: 'rerun the spec', timestamp: 1 });
    ctx.stores.streamingStore.addQueuedMessage({ id: 'q2', content: [IMAGE, { type: 'text', text: 'and this one' }], timestamp: 2 });

    cancel({ type: 'queueCancelled', messageId: 'q1', returnToInput: true }, ctx);
    cancel({ type: 'queueCancelled', messageId: 'q2', returnToInput: true }, ctx);

    expect(ctx.stores.streamingStore.messages).toEqual([]);
    expect(restoreQueued.mock.calls).toEqual([
      [[{ type: 'text', text: 'rerun the spec' }]],
      [[IMAGE, { type: 'text', text: 'and this one' }]],
    ]);
    // A fixed id, so the chips of one stop share one toast.
    expect(toastMock.info.mock.calls.map((call) => call[1])).toEqual([{ id: 'queue-returned' }, { id: 'queue-returned' }]);
  });
});
