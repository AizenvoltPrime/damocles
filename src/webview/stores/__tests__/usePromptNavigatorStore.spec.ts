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

  it('switching currentResumedSessionId resets all navigator state', async () => {
    const store = usePromptNavigatorStore();
    const sessionStore = useSessionStore();

    store.open();
    store.setQuery('search-term');
    store.setActiveIndex(5);

    expect(store.isOpen).toBe(true);
    expect(store.query).toBe('search-term');
    expect(store.activeIndex).toBe(5);

    sessionStore.setResumedSession('new-session-id');
    await Promise.resolve();

    expect(store.isOpen).toBe(false);
    expect(store.query).toBe('');
    expect(store.activeIndex).toBe(0);
  });
});
