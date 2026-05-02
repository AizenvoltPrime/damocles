import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { usePromptNavigatorStore } from '../usePromptNavigatorStore';
import { useSessionStore } from '../useSessionStore';

describe('usePromptNavigatorStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('toggle() flips isOpen between true and false', () => {
    const store = usePromptNavigatorStore();
    expect(store.isOpen).toBe(false);

    store.toggle();
    expect(store.isOpen).toBe(true);

    store.toggle();
    expect(store.isOpen).toBe(false);
  });

  it('close() resets query and activeIndex to defaults', () => {
    const store = usePromptNavigatorStore();
    store.open();
    store.setQuery('hello world');
    store.setActiveIndex(7);

    store.close();

    expect(store.isOpen).toBe(false);
    expect(store.query).toBe('');
    expect(store.activeIndex).toBe(0);
  });

  it('toggleNodeCollapsed adds and removes keys, replacing the Set instance', () => {
    const store = usePromptNavigatorStore();
    const initialSet = store.collapsedNodes;

    store.toggleNodeCollapsed('node-a');
    expect(store.collapsedNodes.has('node-a')).toBe(true);
    expect(store.collapsedNodes).not.toBe(initialSet);

    const afterAdd = store.collapsedNodes;
    store.toggleNodeCollapsed('node-a');
    expect(store.collapsedNodes.has('node-a')).toBe(false);
    expect(store.collapsedNodes).not.toBe(afterAdd);
  });

  it('rapid re-flash cancels prior timer; second flash survives full duration', () => {
    vi.useFakeTimers();
    const store = usePromptNavigatorStore();

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

  it('switching currentResumedSessionId resets all navigator state', async () => {
    const store = usePromptNavigatorStore();
    const sessionStore = useSessionStore();

    store.open();
    store.setQuery('search-term');
    store.setActiveIndex(5);
    store.toggleNodeCollapsed('node-x');
    store.flashMessage('msg-flash');

    expect(store.isOpen).toBe(true);
    expect(store.query).toBe('search-term');
    expect(store.activeIndex).toBe(5);
    expect(store.collapsedNodes.size).toBe(1);
    expect(store.flashedMessageId).toBe('msg-flash');

    sessionStore.setResumedSession('new-session-id');
    await Promise.resolve();

    expect(store.isOpen).toBe(false);
    expect(store.query).toBe('');
    expect(store.activeIndex).toBe(0);
    expect(store.collapsedNodes.size).toBe(0);
    expect(store.flashedMessageId).toBe(null);
  });
});
