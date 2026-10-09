import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ref } from 'vue';
import { setActivePinia, createPinia } from 'pinia';
import { createQueueHandlers } from '../queue-handlers';
import type { HandlerContext, StoreContext } from '../../types';
import { useStreamingStore } from '@/stores/useStreamingStore';
import { defined } from '@/__tests__/helpers';

const toastMock = vi.hoisted(() => ({ info: vi.fn() }));
vi.mock('vue-sonner', () => ({ toast: toastMock }));

const IMAGE = { type: 'image' as const, source: { type: 'base64' as const, media_type: 'image/png' as const, data: 'AAAA' } };
const CHIP = { id: 't1', source: 'command' as const, commandLine: 'npm test', exitCode: 1, terminalTitle: 'pwsh', lineCount: 1, omittedLines: 0, preview: 'FAIL' };

function context(restoreQueued = vi.fn()): HandlerContext {
  const stores = { streamingStore: useStreamingStore() };
  return { stores: stores as unknown as StoreContext, refs: { chatInputRef: ref({ restoreQueued }) } } as unknown as HandlerContext;
}

describe('queueCancelled for a prompt pi queued into the running run', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    toastMock.info.mockClear();
  });

  it('takes the echo out by its correlation id and puts the typed text and image back in the composer', () => {
    const restoreQueued = vi.fn();
    const ctx = context(restoreQueued);
    const store = ctx.stores.streamingStore;
    store.addUserMessage('earlier', false, undefined, undefined, 'c0', 0);
    store.addUserMessage([{ type: 'text', text: 'what failed?' }, IMAGE], false, undefined, undefined, 'c1', 1, undefined, undefined, [CHIP]);

    defined(createQueueHandlers().queueCancelled, 'queueCancelled handler')({ type: 'queueCancelled', messageId: 'c1', returnToInput: true }, ctx);

    expect(store.messages.map((m) => m.correlationId)).toEqual(['c0']);
    expect(restoreQueued).toHaveBeenCalledWith([{ type: 'text', text: 'what failed?' }, IMAGE]);
    expect(toastMock.info).toHaveBeenCalledOnce();
  });
});
