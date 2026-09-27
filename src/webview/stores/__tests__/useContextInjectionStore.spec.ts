import { describe, it, expect, beforeEach } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { useContextInjectionStore } from '../useContextInjectionStore';
import { ID_A, ID_B, ID_C, carried, display, injected } from '@/components/context-injection/__tests__/fixtures';

function loaded() {
  const store = useContextInjectionStore();
  const d = display({ added: [injected(), injected({ id: ID_B })], carried: [carried()] });
  store.openOverlay(d.promptIndex);
  store.handleInjectionLoaded(d.promptIndex, d);
  return store;
}

beforeEach(() => setActivePinia(createPinia()));

describe('useContextInjectionStore', () => {
  it('overrides the recorded pin of only the matching id, and leaves the record as recorded', () => {
    const store = loaded();
    store.setPinned(ID_A, true);
    store.setPinned(ID_C, true);

    expect(store.isPinned(ID_A, false)).toBe(true);
    expect(store.isPinned(ID_B, false)).toBe(false);
    expect(store.isPinned(ID_C, false)).toBe(true);
    expect(store.currentMemoryInjection!.added[0]!.isPinned).toBe(false);

    store.setPinned(ID_C, false);
    expect(store.isPinned(ID_C, true)).toBe(false);
  });

  it('keeps a pin made on one prompt when an earlier prompt is opened', () => {
    const store = loaded();
    store.setPinned(ID_A, true);
    store.openOverlay(0);
    store.handleInjectionLoaded(0, display({ promptIndex: 0, added: [injected({ isPinned: false })] }));

    expect(store.isPinned(ID_A, store.currentMemoryInjection!.added[0]!.isPinned)).toBe(true);
  });

  it('marks forgotten across prompts, and restores on unforget', () => {
    const store = loaded();
    store.setForgotten(ID_A);
    store.setForgotten(ID_C);

    expect(store.isForgotten(ID_A)).toBe(true);
    expect(store.isForgotten(ID_B)).toBe(false);
    expect(store.isForgotten(ID_C)).toBe(true);

    store.openOverlay(3);
    store.handleInjectionLoaded(3, display({ promptIndex: 3, added: [injected()] }));
    expect(store.isForgotten(ID_A)).toBe(true);

    store.setForgotten(ID_C, false);
    expect(store.isForgotten(ID_C)).toBe(false);
  });

  it('reads the recorded forget until an unforget overrides it', () => {
    const store = useContextInjectionStore();
    expect(store.isForgotten(ID_A, true)).toBe(true);

    store.setForgotten(ID_A, false);
    expect(store.isForgotten(ID_A, true)).toBe(false);
  });

  it('clears the overrides on reset', () => {
    const store = loaded();
    store.setForgotten(ID_A);
    store.setPinned(ID_B, true);
    store.$reset();
    expect(store.overrides.size).toBe(0);
    expect(store.isForgotten(ID_A)).toBe(false);
  });

  it('leaves an overlay on another prompt alone while a new prompt runs', () => {
    const store = loaded();
    const shown = store.currentMemoryInjection;

    store.handleContextInjectionStarted(5);
    store.handleMemoryInjectionUpdate(5, display({ promptIndex: 5, added: [] }));

    expect(store.currentMemoryInjection).toBe(shown);
    expect(store.isBuilding).toBe(false);
  });

  it('shows the running prompt as building, then its display, and keeps that display for a later open', () => {
    const store = useContextInjectionStore();
    store.handleContextInjectionStarted(5);
    store.openOverlay(5);
    expect(store.isBuilding).toBe(true);
    expect(store.currentMemoryInjection).toBeNull();

    const live = display({ promptIndex: 5 });
    store.handleMemoryInjectionUpdate(5, live);
    expect(store.currentMemoryInjection).toStrictEqual(live);

    store.closeOverlay();
    store.openOverlay(2);
    store.openOverlay(5);
    expect(store.currentMemoryInjection).toStrictEqual(live);
    expect(store.isLoading).toBe(false);
  });
});
