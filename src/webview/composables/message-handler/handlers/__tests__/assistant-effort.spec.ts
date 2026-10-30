// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { createStreamingHandlers } from '../streaming-handlers';
import type { HandlerContext, StoreContext } from '../../types';
import { useStreamingStore } from '@/stores/useStreamingStore';
import { useSubagentStore } from '@/stores/useSubagentStore';
import { useSessionStore } from '@/stores/useSessionStore';
import type { ExtensionToWebviewMessage } from '@shared/types/messages';

// A replay builds the reply whole with its effort, so the live reply must carry it too or only a reload shows the badge.

type Msg<T extends ExtensionToWebviewMessage['type']> = Extract<ExtensionToWebviewMessage, { type: T }>;

function context(): HandlerContext {
  return {
    stores: { streamingStore: useStreamingStore(), subagentStore: useSubagentStore(), sessionStore: useSessionStore() } as unknown as StoreContext,
  } as unknown as HandlerContext;
}

const streaming = createStreamingHandlers();

function partial(messageId: string, streamingText: string): Msg<'partial'> {
  return { type: 'partial', data: { type: 'partial', content: [], session_id: 'SID', messageId, streamingText, isThinking: false } };
}

function sealed(messageId: string, text: string, effort?: 'low' | 'high'): Msg<'assistant'> {
  return {
    type: 'assistant',
    data: { type: 'assistant', message: { id: messageId, role: 'assistant', content: [{ type: 'text', text }], model: '', stop_reason: null, ...(effort ? { effort } : {}) }, session_id: 'SID' },
  };
}

describe('a live reply\'s effort', () => {
  beforeEach(() => setActivePinia(createPinia()));

  it('is kept on the streamed message when the sealed message brings it', () => {
    const ctx = context();
    const store = ctx.stores.streamingStore;
    store.addUserMessage('question', false, undefined, undefined, 'c1', 0);

    streaming.partial!(partial('SID:a:1', 'The ans'), ctx);
    streaming.assistant!(sealed('SID:a:1', 'The answer', 'low'), ctx);

    expect(store.messages.find((m) => m.role === 'assistant')?.effort).toBe('low');
  });

  it('stays when a later update of the same message carries none', () => {
    const ctx = context();
    const store = ctx.stores.streamingStore;
    store.addUserMessage('question', false, undefined, undefined, 'c1', 0);

    streaming.assistant!(sealed('SID:a:1', 'The answer', 'high'), ctx);
    streaming.assistant!(sealed('SID:a:1', 'The answer, longer'), ctx);

    expect(store.messages.find((m) => m.role === 'assistant')?.effort).toBe('high');
  });
});
