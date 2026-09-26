// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { nextTick, ref } from 'vue';
import { setActivePinia, createPinia } from 'pinia';
import type { ExtensionToWebviewMessage } from '@shared/types/messages';
import { createMessageDispatcher } from '../index';
import type { HandlerContext, HandlerRegistry, ScrollBehavior } from '../types';
import { buildMessage, useStreamingStore } from '@/stores/useStreamingStore';
import { useUIStore } from '@/stores/useUIStore';

/** Reading `scrollHeight` forces a layout, so the dispatcher reads it at most once per animation frame. */

let frames: FrameRequestCallback[];

beforeEach(() => {
  setActivePinia(createPinia());
  frames = [];
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => frames.push(cb));
  vi.stubGlobal('cancelAnimationFrame', () => {});
});
afterEach(() => vi.unstubAllGlobals());

async function runFrame(): Promise<void> {
  const pending = frames;
  frames = [];
  // A browser runs pending microtasks after each frame callback, so a later callback sees their effects.
  for (const cb of pending) {
    cb(0);
    await nextTick();
  }
}

/** A container that counts its layout reads and records the transcript length at each one. */
function fakeContainer(onRead: () => void = () => {}) {
  const state = { reads: 0, scrollTop: 0 };
  const container = {
    get scrollHeight() {
      state.reads++;
      onRead();
      return 5_000;
    },
    set scrollTop(value: number) { state.scrollTop = value; },
    get scrollTop() { return state.scrollTop; },
  };
  return { container: container as unknown as HTMLElement, state };
}

function dispatcher(container: HTMLElement, handlers: Record<string, () => ScrollBehavior | void>) {
  const ctx = {
    stores: { streamingStore: useStreamingStore(), uiStore: useUIStore() },
    refs: { messageContainerRef: ref(container) },
  } as unknown as HandlerContext;
  return createMessageDispatcher(handlers as unknown as HandlerRegistry, ctx);
}

const msg = (type: string) => ({ type }) as ExtensionToWebviewMessage;

describe('createMessageDispatcher scrolling', () => {
  it('reads the layout once for many messages in one frame', async () => {
    const { container, state } = fakeContainer();
    const deliver = dispatcher(container, { streamDelta: () => undefined });

    for (let i = 0; i < 50; i++) deliver(msg('streamDelta'));
    expect(state.reads).toBe(0);
    expect(frames).toHaveLength(1);

    await runFrame();

    expect(state.reads).toBe(1);
    expect(state.scrollTop).toBe(5_000);
  });

  it('forces the scroll when any message in the frame asked for it, even away from the bottom', async () => {
    const { container, state } = fakeContainer();
    const deliver = dispatcher(container, { userMessage: () => ({ forceScrollToBottom: true }), streamDelta: () => undefined });
    useUIStore().setIsAtBottom(false);

    deliver(msg('userMessage'));
    deliver(msg('streamDelta'));
    await runFrame();

    expect(state.scrollTop).toBe(5_000);
  });

  it('leaves a reader who scrolled up where they are', async () => {
    const { container, state } = fakeContainer();
    const deliver = dispatcher(container, { streamDelta: () => undefined });

    useUIStore().setIsAtBottom(false);
    deliver(msg('streamDelta'));
    expect(frames).toHaveLength(0);

    useUIStore().setIsAtBottom(true);
    deliver(msg('streamDelta'));
    useUIStore().setIsAtBottom(false);
    await runFrame();

    expect(state.reads).toBe(0);
    expect(state.scrollTop).toBe(0);
  });

  it('schedules nothing for a message that skips the scroll', () => {
    const { container } = fakeContainer();
    const deliver = dispatcher(container, { teamUpdate: () => ({ skipScroll: true }) });

    deliver(msg('teamUpdate'));

    expect(frames).toHaveLength(0);
  });

  it('appends queued replay items before it reads the layout', async () => {
    const lengths: number[] = [];
    const { container } = fakeContainer(() => lengths.push(useStreamingStore().messages.length));
    const streamingStore = useStreamingStore();
    const deliver = dispatcher(container, {
      assistantReplay: () => { streamingStore.queueReplayMessage(buildMessage({ role: 'assistant', content: 'x', timestamp: 1 })); },
    });

    for (let i = 0; i < 3; i++) deliver(msg('assistantReplay'));
    expect(streamingStore.messages).toHaveLength(0);

    await runFrame();

    expect(lengths).toEqual([3]);
  });

  it('appends queued replay items before it reads the layout when its frame was requested first', async () => {
    const lengths: number[] = [];
    const { container } = fakeContainer(() => lengths.push(useStreamingStore().messages.length));
    const streamingStore = useStreamingStore();
    const deliver = dispatcher(container, {
      streamDelta: () => undefined,
      assistantReplay: () => { streamingStore.queueReplayMessage(buildMessage({ role: 'assistant', content: 'x', timestamp: 1 })); },
    });

    deliver(msg('streamDelta'));
    for (let i = 0; i < 3; i++) deliver(msg('assistantReplay'));
    await runFrame();

    expect(lengths).toEqual([3]);
  });

  it('flushes queued replay items before any other message is handled', () => {
    const { container } = fakeContainer();
    const streamingStore = useStreamingStore();
    const seen: number[] = [];
    const deliver = dispatcher(container, {
      assistantReplay: () => { streamingStore.queueReplayMessage(buildMessage({ role: 'assistant', content: 'x', timestamp: 1 })); },
      done: () => { seen.push(streamingStore.messages.length); },
    });

    deliver(msg('assistantReplay'));
    deliver(msg('assistantReplay'));
    deliver(msg('done'));

    expect(seen).toEqual([2]);
  });
});
