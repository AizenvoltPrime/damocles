import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { useMessageHighlightStore } from '../useMessageHighlightStore';
import { useSessionStore } from '../useSessionStore';

describe('useMessageHighlightStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('rapid re-flash cancels prior timer; second flash survives full duration', () => {
    vi.useFakeTimers();
    const store = useMessageHighlightStore();

    store.flashMessage('msg-1');
    expect(store.flashedMessageId).toBe('msg-1');

    vi.advanceTimersByTime(100);
    expect(store.flashedMessageId).toBe('msg-1');

    store.flashMessage('msg-2');
    expect(store.flashedMessageId).toBe('msg-2');

    vi.advanceTimersByTime(2400);
    expect(store.flashedMessageId).toBe('msg-2');

    vi.advanceTimersByTime(100);
    expect(store.flashedMessageId).toBe(null);
  });

  it('switching currentResumedSessionId resets flashedMessageId and cancels the pending timer', async () => {
    vi.useFakeTimers();
    const store = useMessageHighlightStore();
    const sessionStore = useSessionStore();

    store.flashMessage('msg-flash');
    expect(store.flashedMessageId).toBe('msg-flash');
    expect(vi.getTimerCount()).toBe(1);

    sessionStore.setResumedSession('new-session-id');
    await Promise.resolve();

    expect(store.flashedMessageId).toBe(null);
    expect(vi.getTimerCount()).toBe(0);

    vi.runAllTimers();
    expect(store.flashedMessageId).toBe(null);
  });
});
