// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import type { ExtensionToWebviewMessage } from '@shared/types/messages';
import { createMessageDispatcher } from '../index';
import type { HandlerContext, HandlerRegistry, ScrollBehavior } from '../types';
import { buildMessage, useStreamingStore } from '@/stores/useStreamingStore';

function dispatcher(handlers: Record<string, () => ScrollBehavior | void>, followTranscript: () => void = () => {}) {
  const ctx = { stores: { streamingStore: useStreamingStore() } } as unknown as HandlerContext;
  return createMessageDispatcher(handlers as unknown as HandlerRegistry, ctx, followTranscript);
}

const msg = (type: string) => ({ type }) as ExtensionToWebviewMessage;

beforeEach(() => setActivePinia(createPinia()));

describe('createMessageDispatcher', () => {
  it('asks the transcript to follow again when a handler forces it, and only then', () => {
    const followTranscript = vi.fn();
    const deliver = dispatcher(
      { sessionCleared: () => ({ forceScrollToBottom: true }), streamDelta: () => undefined, sessionState: () => ({}) },
      followTranscript,
    );

    deliver(msg('streamDelta'));
    deliver(msg('sessionState'));
    expect(followTranscript).not.toHaveBeenCalled();

    deliver(msg('sessionCleared'));
    expect(followTranscript).toHaveBeenCalledOnce();
  });

  it('flushes queued replay items before any other message is handled', () => {
    const streamingStore = useStreamingStore();
    const seen: number[] = [];
    const deliver = dispatcher({
      assistantReplay: () => { streamingStore.queueReplayMessage(buildMessage({ role: 'assistant', content: 'x', timestamp: 1 })); },
      done: () => { seen.push(streamingStore.messages.length); },
    });

    deliver(msg('assistantReplay'));
    deliver(msg('assistantReplay'));
    deliver(msg('done'));

    expect(seen).toEqual([2]);
  });
});
