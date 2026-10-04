// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { defineComponent, h, nextTick } from 'vue';
import { setActivePinia, createPinia } from 'pinia';
import MemoryPanel from '../MemoryPanel.vue';
import { useMemoryStore } from '@/stores/useMemoryStore';
import { useUIStore } from '@/stores/useUIStore';
import { i18n } from '@/i18n';
import type { MemoryEntry } from '@shared/types/memory';
import type { WebviewToExtensionMessage } from '@shared/types/messages';

const posted = vi.hoisted((): WebviewToExtensionMessage[] => []);
vi.mock('@/composables/usePlatformBridge', () => ({
  usePlatformBridge: () => ({ postMessage: (m: WebviewToExtensionMessage) => posted.push(m), getState: () => undefined, setState: () => {} }),
}));

const toasts = vi.hoisted((): string[] => []);
vi.mock('vue-sonner', () => {
  const record = (text: string) => void toasts.push(text);
  return { toast: Object.assign(record, { success: record, error: record, info: record }) };
});

function entry(id: string, over: Partial<MemoryEntry> = {}): MemoryEntry {
  return { id, tier: 'project', kind: 'fact', content: `content ${id}`, sessionId: null, workspace: null, createdAt: 1, updatedAt: 1, tags: [], ...over };
}

const observation = (id: string): MemoryEntry => entry(id, { tier: 'observation', kind: 'observation' });

const mounted: VueWrapper[] = [];
let loadMoreCount = 0;

/** Wires the panel the way App.vue does: props from the memory store, load-more counted. */
function mountPanel(): VueWrapper {
  const store = useMemoryStore();
  const Host = defineComponent({
    setup: () => () => h(MemoryPanel, {
      notes: store.notes,
      observations: store.observations,
      searchResults: [],
      hasMoreObservations: store.hasMoreObservations,
      loadingObservations: store.loadingObservations,
      onLoadMoreObservations: () => { loadMoreCount++; },
    }),
  });
  const wrapper = mount(Host, { global: { plugins: [i18n], stubs: { MarkdownRenderer: true } }, attachTo: document.body });
  mounted.push(wrapper);
  return wrapper;
}

const row = (wrapper: VueWrapper, id: string) => wrapper.find(`[data-memory-id="${id}"]`);
const activeTab = (wrapper: VueWrapper) => wrapper.find('[data-tab][data-active]').attributes('data-tab');
const listRequests = () => posted.filter((m) => m.type === 'requestMemories').length;

let scrolled: string[] = [];
const originalScroll = Element.prototype.scrollIntoView;

beforeEach(() => {
  setActivePinia(createPinia());
  toasts.length = 0;
  posted.length = 0;
  loadMoreCount = 0;
  scrolled = [];
  Element.prototype.scrollIntoView = function (this: Element) {
    scrolled.push((this as HTMLElement).dataset.memoryId ?? '');
  };
});
afterEach(() => {
  while (mounted.length) mounted.pop()?.unmount();
  Element.prototype.scrollIntoView = originalScroll;
  vi.useRealTimers();
});

describe('MemoryPanel focus', () => {
  it('resets the filters, scrolls to the row and highlights it for 2s', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const store = useMemoryStore();
    store.setMemories([entry('a'), entry('b', { kind: 'preference', scope: 'global' })]);
    store.setKindFilter('episode');
    store.setScopeFilter('session');

    useUIStore().openMemoryPanel({ id: 'b', kind: 'preference' });
    const wrapper = mountPanel();
    await nextTick();
    await nextTick();

    expect(store.kindFilter).toBe('all');
    expect(store.scopeFilter).toBe('all');
    expect(row(wrapper, 'b').attributes('data-focused')).toBe('true');
    expect(scrolled).toEqual(['b']);
    expect(document.activeElement).toBe(row(wrapper, 'b').element);
    expect(useUIStore().memoryPanelFocus).toBeNull();

    vi.advanceTimersByTime(2000);
    await nextTick();
    expect(row(wrapper, 'b').attributes('data-focused')).toBeUndefined();
  });

  it('selects the tab for the kind', async () => {
    const store = useMemoryStore();
    store.setMemories([entry('n', { tier: 'note', kind: 'note' })]);
    useUIStore().openMemoryPanel({ id: 'n', kind: 'note' });
    const wrapper = mountPanel();
    await nextTick();

    expect(activeTab(wrapper)).toBe('note');
    expect(row(wrapper, 'n').attributes('data-focused')).toBe('true');
  });

  it('shows a forgotten memory, since focus asked for it', async () => {
    const store = useMemoryStore();
    store.setMemories([entry('f', { forgotten: true })]);
    useUIStore().openMemoryPanel({ id: 'f', kind: 'fact' });
    const wrapper = mountPanel();
    await nextTick();

    expect(store.showForgotten).toBe(true);
    expect(row(wrapper, 'f').attributes('data-focused')).toBe('true');
  });

  it('waits for the memory list, then pages observations until the row arrives', async () => {
    const store = useMemoryStore();
    useUIStore().openMemoryPanel({ id: 'o9', kind: 'observation' });
    const wrapper = mountPanel();
    await nextTick();
    expect(loadMoreCount).toBe(0);

    store.setMemories([observation('o1')], true, { createdAt: 1, id: 'o1' });
    await nextTick();
    expect(loadMoreCount).toBe(1);
    expect(activeTab(wrapper)).toBe('observations');

    store.appendObservations([observation('o9')], false, null);
    await nextTick();
    await nextTick();
    expect(loadMoreCount).toBe(1);
    expect(row(wrapper, 'o9').attributes('data-focused')).toBe('true');
    expect(toasts).toEqual([]);
  });

  it('asks for the list itself, and pages only after that reply when an older list arrived first', async () => {
    const store = useMemoryStore();
    store.setMemories([observation('o1')], true, { createdAt: 1, id: 'o1' });
    useUIStore().openMemoryPanel({ id: 'o9', kind: 'observation' });
    const wrapper = mountPanel();
    await nextTick();

    expect(listRequests()).toBe(1);
    expect(loadMoreCount).toBe(0);
    expect(toasts).toEqual([]);

    store.setMemories([observation('o1')], true, { createdAt: 1, id: 'o1' });
    await nextTick();
    expect(loadMoreCount).toBe(1);

    store.appendObservations([observation('o9')], false, null);
    await nextTick();
    await nextTick();
    expect(row(wrapper, 'o9').attributes('data-focused')).toBe('true');
    expect(toasts).toEqual([]);
    expect(listRequests()).toBe(1);
  });

  it('requests the list once on a plain open', async () => {
    mountPanel();
    await nextTick();
    expect(listRequests()).toBe(1);
  });

  it('requests a fresh list when focus is set on a panel that is already open', async () => {
    const store = useMemoryStore();
    const wrapper = mountPanel();
    await nextTick();
    useUIStore().openMemoryPanel({ id: 'late', kind: 'fact' });
    await nextTick();
    expect(listRequests()).toBe(2);
    expect(toasts).toEqual([]);

    store.setMemories([entry('late')]);
    await nextTick();
    await nextTick();
    expect(toasts).toEqual([]);
    expect(row(wrapper, 'late').attributes('data-focused')).toBe('true');
  });

  it('stops after five pages and says the memory is not in the panel', async () => {
    const store = useMemoryStore();
    useUIStore().openMemoryPanel({ id: 'missing', kind: 'observation' });
    mountPanel();
    await nextTick();

    store.setMemories([observation('o0')], true, { createdAt: 1, id: 'o0' });
    await nextTick();
    for (let page = 1; page <= 5; page++) {
      store.appendObservations([observation(`o${page}`)], true, { createdAt: 1, id: `o${page}` });
      await nextTick();
    }

    expect(loadMoreCount).toBe(5);
    expect(toasts).toEqual(['This memory is not in the memory panel. It may belong to another workspace, or it was removed.']);
    expect(useUIStore().memoryPanelFocus).toBeNull();
  });

  it('gives up on a missing fact once the list has loaded, without paging', async () => {
    const store = useMemoryStore();
    useUIStore().openMemoryPanel({ id: 'missing', kind: 'fact' });
    mountPanel();
    await nextTick();

    store.setMemories([entry('a')], true, { createdAt: 1, id: 'a' });
    await nextTick();

    expect(loadMoreCount).toBe(0);
    expect(toasts).toHaveLength(1);
  });
});

describe('MemoryPanel row marks', () => {
  it('marks a memory stale once its files changed three times, and shows its use count and a version past the first', async () => {
    const store = useMemoryStore();
    store.setMemories([
      entry('fresh', { fileChangeCount: 2 }),
      entry('worn', { fileChangeCount: 3, accessCount: 14, version: 3 }),
    ]);
    const wrapper = mountPanel();
    await nextTick();

    expect(row(wrapper, 'fresh').text()).not.toContain('stale');
    expect(row(wrapper, 'fresh').text()).not.toContain('used');
    expect(row(wrapper, 'fresh').text()).not.toMatch(/\bv\d/);
    const worn = row(wrapper, 'worn').text();
    expect(worn).toContain('stale');
    expect(worn).toContain('used 14×');
    expect(worn).toContain('v3');
  });
});
