import { describe, it, expect, beforeEach } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { createStreamingHandlers } from '../streaming-handlers';
import type { HandlerContext, StoreContext } from '../../types';
import { useStreamingStore } from '@/stores/useStreamingStore';
import { defined } from '@/__tests__/helpers';
import type { ExtensionToWebviewMessage } from '@shared/types/messages';

type Msg<T extends ExtensionToWebviewMessage['type']> = Extract<ExtensionToWebviewMessage, { type: T }>;

function context(): HandlerContext {
  return { stores: { streamingStore: useStreamingStore() } as unknown as StoreContext } as unknown as HandlerContext;
}

function partial(messageId: string, streamingText: string): Msg<'partial'> {
  return { type: 'partial', data: { type: 'partial', content: [], session_id: 'SID', messageId, streamingText, isThinking: false } };
}

describe('assistantRetracted', () => {
  beforeEach(() => setActivePinia(createPinia()));

  it('takes the streamed message out, and the re-run call streams into a message of its own', () => {
    const handlers = createStreamingHandlers();
    const ctx = context();
    const store = ctx.stores.streamingStore;
    store.addUserMessage('question', false, undefined, undefined, 'c1', 0);

    defined(handlers.partial, 'partial handler')(partial('SID:a:1:1', 'Half an ans'), ctx);
    defined(handlers.assistantRetracted, 'assistantRetracted handler')({ type: 'assistantRetracted', messageId: 'SID:a:1:1' }, ctx);
    expect(store.messages.map((m) => m.role)).toEqual(['user']);
    expect(store.streamingMessageId).toBeNull();

    defined(handlers.partial, 'partial handler')(partial('SID:a:1:2', 'The answer'), ctx);
    expect(store.messages.map((m) => m.content)).toEqual(['question', 'The answer']);
  });

  it('changes nothing for a message the transcript does not hold', () => {
    const handlers = createStreamingHandlers();
    const ctx = context();
    const store = ctx.stores.streamingStore;
    defined(handlers.partial, 'partial handler')(partial('SID:a:1:1', 'kept'), ctx);

    defined(handlers.assistantRetracted, 'assistantRetracted handler')({ type: 'assistantRetracted', messageId: 'SID:a:9:9' }, ctx);
    expect(store.messages.map((m) => m.content)).toEqual(['kept']);
  });
});
