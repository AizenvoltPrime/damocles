// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { nextTick } from 'vue';
import { mount, type VueWrapper } from '@vue/test-utils';
import { setActivePinia, createPinia } from 'pinia';
import ContextInjectionOverlay from '../ContextInjectionOverlay.vue';
import MemoryPanel from '../../MemoryPanel.vue';
import { i18n } from '@/i18n';
import { useContextInjectionStore } from '@/stores/useContextInjectionStore';
import { useMemoryStore } from '@/stores/useMemoryStore';
import { useUIStore } from '@/stores/useUIStore';
import { createMemoryHandlers } from '@/composables/message-handler/handlers/memory-handlers';
import type { HandlerContext } from '@/composables/message-handler/types';
import { ID_A, ID_B, ID_C, carried, display, injected } from './fixtures';
import type { MemoryInjectionDisplay } from '@shared/types/context-injection';
import type { WebviewToExtensionMessage } from '@shared/types/messages';

const posted = vi.hoisted((): WebviewToExtensionMessage[] => []);
vi.mock('@/composables/useVSCode', () => ({
  useVSCode: () => ({ postMessage: (m: WebviewToExtensionMessage) => posted.push(m), getState: () => undefined, setState: () => {} }),
}));
const toasts = vi.hoisted((): string[] => []);
vi.mock('vue-sonner', () => {
  const record = (text: string) => void toasts.push(text);
  return { toast: Object.assign(record, { success: record, error: record, info: record }) };
});

const mounted: VueWrapper[] = [];

function track<T extends VueWrapper>(wrapper: T): T {
  mounted.push(wrapper);
  return wrapper;
}

async function mountOverlay() {
  const wrapper = track(mount(ContextInjectionOverlay, { global: { plugins: [i18n] }, attachTo: document.body }));
  await nextTick();
  return wrapper;
}

async function openWith(d: MemoryInjectionDisplay) {
  const store = useContextInjectionStore();
  store.openOverlay(d.promptIndex);
  store.handleInjectionLoaded(d.promptIndex, d);
  const wrapper = await mountOverlay();
  return { store, wrapper };
}

async function showExactText(wrapper: VueWrapper): Promise<void> {
  await wrapper.find('[data-view-tab="exactText"]').trigger('mousedown', { button: 0 });
  await nextTick();
}

function handlerContext(): HandlerContext {
  return {
    stores: {
      memoryStore: useMemoryStore(),
      contextInjectionStore: useContextInjectionStore(),
      uiStore: useUIStore(),
    },
  } as unknown as HandlerContext;
}

function pressEscape(): void {
  document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
}

beforeEach(() => {
  posted.length = 0;
  toasts.length = 0;
  setActivePinia(createPinia());
  document.body.innerHTML = '';
});
afterEach(() => {
  while (mounted.length) mounted.pop()?.unmount();
});

describe('ContextInjectionOverlay', () => {
  it('numbers the prompt from 1 and shows the KPI grid above the sections', async () => {
    const { wrapper } = await openWith(display());
    expect(wrapper.text()).toContain('Prompt 3');
    expect(wrapper.findAll('[data-kpi]')).toHaveLength(5);
    expect(wrapper.find('[data-section="added"] [data-memory-id]').attributes('data-memory-id')).toBe(ID_A);
    expect(wrapper.find('[data-section="carried"] [data-memory-id]').attributes('data-memory-id')).toBe(ID_C);
  });

  it('shows the query terms as chips and strikes the dropped ones through with the reason', async () => {
    const { wrapper } = await openWith(display({
      query: {
        terms: ['vitest'],
        dropped: [{ term: '985d5b12', reason: 'id' }, { term: 'the', reason: 'common' }],
        mentionedIds: [ID_B],
        files: [{ path: 'src/x.ts', source: 'editor' }],
      },
    }));
    expect(wrapper.findAll('[data-query-term]').map((c) => c.text())).toEqual(['vitest']);

    const dropped = wrapper.findAll('[data-dropped-term]');
    expect(dropped.map((c) => c.find('s').text())).toEqual(['985d5b12', 'the']);
    expect(dropped.map((c) => c.attributes('title'))).toEqual(['memory id', 'too common']);
    expect(dropped[1]!.find('.sr-only').text()).toBe('(dropped: too common)');

    expect(wrapper.find('[data-mentioned-id]').text()).toBe('22222222');
    expect(wrapper.find('[data-mentioned-id]').attributes('title')).toBe(ID_B);
    expect(wrapper.find('[data-query-file="editor"]').text()).toContain('src/x.ts');
    expect(wrapper.find('[data-query-empty]').exists()).toBe(false);
  });

  it('says the prompt had no usable query terms', async () => {
    const { wrapper } = await openWith(display({ query: { terms: [], dropped: [], mentionedIds: [], files: [] } }));
    expect(wrapper.find('[data-query-empty]').text()).toBe('No usable query terms');
  });

  it('expands the profile text only when this prompt injected it', async () => {
    const { store, wrapper } = await openWith(display({ profile: { state: 'injected', tokens: 42, text: 'Prefers Greek UI' } }));
    expect(wrapper.find('[data-profile-text]').exists()).toBe(false);
    await wrapper.find('[data-action="toggle-profile"]').trigger('click');
    expect(wrapper.find('[data-profile-text]').text()).toBe('Prefers Greek UI');

    store.handleInjectionLoaded(store.activePromptIndex, display({ profile: { state: 'inContext', tokens: 0, text: '' } }));
    await nextTick();
    expect(wrapper.find('[data-section="profile"]').text()).toContain('Already in context from an earlier prompt');

    store.handleInjectionLoaded(store.activePromptIndex, display({ profile: { state: 'disabled', tokens: 0, text: '' } }));
    await nextTick();
    expect(wrapper.find('[data-section="profile"]').text()).toContain('Profile disabled');
  });

  it('says nothing new was relevant when the prompt added nothing, in the plural form of the carried count', async () => {
    const { store, wrapper } = await openWith(display({ added: [], carried: [carried(), carried({ id: ID_B })] }));
    expect(wrapper.find('[data-state="nothing-new"]').text()).toBe(
      'Nothing new was relevant. 2 memories from earlier prompts are still in context.',
    );

    store.handleInjectionLoaded(store.activePromptIndex, display({ added: [], carried: [carried()] }));
    await nextTick();
    expect(wrapper.find('[data-state="nothing-new"]').text()).toBe(
      'Nothing new was relevant. 1 memory from an earlier prompt is still in context.',
    );

    store.handleInjectionLoaded(store.activePromptIndex, display({ added: [], carried: [] }));
    await nextTick();
    expect(wrapper.find('[data-state="nothing-new"]').text()).toBe(
      'Nothing new was relevant, and no memories from earlier prompts are in context.',
    );
  });

  it('does not say nothing new when only the Compass status was sent', async () => {
    const { wrapper } = await openWith(display({ added: [], compass: { state: 'injected', text: '<damocles_compass state="ready"/>' } }));
    expect(wrapper.find('[data-state="nothing-new"]').exists()).toBe(false);
  });

  it('expands the Compass status only when this prompt sent it, and states why otherwise', async () => {
    const { store, wrapper } = await openWith(display({
      compass: { state: 'injected', text: '<damocles_compass state="ready"/>' },
      tokens: { memories: 120, notices: 10, profile: 0, compass: 1, total: 131, budget: 2000 },
    }));
    const section = () => wrapper.find('[data-section="compass"]');
    expect(section().find('[data-section-tokens]').text()).toBe('1 token');
    expect(wrapper.find('[data-compass-text]').exists()).toBe(false);
    await wrapper.find('[data-action="toggle-compass"]').trigger('click');
    expect(wrapper.find('[data-compass-text]').text()).toBe('<damocles_compass state="ready"/>');

    store.handleInjectionLoaded(store.activePromptIndex, display({ compass: { state: 'unchanged', text: '' } }));
    await nextTick();
    expect(section().text()).toBe('Compass status: Unchanged since an earlier prompt, so not sent again');

    store.handleInjectionLoaded(store.activePromptIndex, display({ compass: { state: 'disabled', text: '' } }));
    await nextTick();
    expect(section().text()).toBe('Compass status: Compass is off');
  });

  it('lists the notices, naming a replacement by its short id', async () => {
    const { wrapper } = await openWith(display({
      notices: [
        { kind: 'superseded', id: ID_A, title: 'Old rule', snippet: 'old', replacementId: ID_B, tokens: 5 },
        { kind: 'forgotten', id: ID_C, title: null, snippet: 'gone', replacementId: null, tokens: 3 },
      ],
    }));
    const notices = wrapper.find('[data-section="notices"]');
    expect(notices.find('[data-notice="superseded"]').text()).toBe('"Old rule" was superseded by 22222222');
    expect(notices.find('[data-notice="forgotten"]').text()).toBe('"gone" was forgotten');
  });

  it('formats the header token count and marks a reranked prompt', async () => {
    const { store, wrapper } = await openWith(display({ tokens: { memories: 1200, notices: 34, profile: 0, compass: 0, total: 1234, budget: 2000 } }));
    expect(wrapper.find('[data-header="tokens"]').text()).toBe('+1,234 tokens');
    expect(wrapper.find('[data-header="reranked"]').exists()).toBe(false);

    store.handleInjectionLoaded(store.activePromptIndex, display({ rerankApplied: true, tokens: { memories: 1, notices: 0, profile: 0, compass: 0, total: 1, budget: 2000 } }));
    await nextTick();
    expect(wrapper.find('[data-header="tokens"]').text()).toBe('+1 token');
    expect(wrapper.find('[data-header="reranked"]').text()).toBe('Reranked');
    expect(wrapper.find('[data-header="reranked"]').attributes('title')).toContain('reranked the matched memories');
  });

  it('says there is no record for a prompt the host has none for', async () => {
    const store = useContextInjectionStore();
    store.openOverlay(4);
    store.handleInjectionLoaded(4, null);
    const wrapper = await mountOverlay();
    expect(wrapper.find('[data-state="no-record"]').exists()).toBe(true);
    expect(wrapper.find('[data-header="tokens"]').exists()).toBe(false);
  });

  it('shows the running prompt as building until its display arrives', async () => {
    const store = useContextInjectionStore();
    store.handleContextInjectionStarted(4);
    store.openOverlay(4);
    const wrapper = await mountOverlay();
    expect(wrapper.find('[data-state="building"]').exists()).toBe(true);

    store.handleMemoryInjectionUpdate(4, display({ promptIndex: 4 }));
    await nextTick();
    expect(wrapper.find('[data-state="building"]').exists()).toBe(false);
    expect(wrapper.find('[data-section="added"]').exists()).toBe(true);
  });

  it('says nothing was sent when the prompt carried no text', async () => {
    const { wrapper } = await openWith(display({ exactText: '' }));
    await showExactText(wrapper);
    expect(wrapper.find('[data-state="nothing-sent"]').exists()).toBe(true);
    expect(wrapper.find('[data-action="copy-exact-text"]').exists()).toBe(false);
  });

  it('marks the card and the carried row forgotten when the extension confirms the forget', async () => {
    const { wrapper } = await openWith(display({ added: [injected()], carried: [carried()] }));
    const handlers = createMemoryHandlers();

    handlers.memoryForgotten!({ type: 'memoryForgotten', id: ID_A, count: 1 }, handlerContext());
    handlers.memoryForgotten!({ type: 'memoryForgotten', id: ID_C, count: 1 }, handlerContext());
    await nextTick();

    expect(wrapper.find(`[data-memory-id="${ID_A}"]`).attributes('data-forgotten')).toBe('true');
    expect(wrapper.find(`[data-memory-id="${ID_C}"]`).attributes('data-forgotten')).toBe('true');
    expect(toasts).toEqual(['Forgot 1 memory', 'Forgot 1 memory']);
  });

  it('flips the pin on the card and the carried row when the extension confirms it', async () => {
    const { wrapper } = await openWith(display({ added: [injected()], carried: [carried()] }));
    const handlers = createMemoryHandlers();

    handlers.memoryPinned!({ type: 'memoryPinned', id: ID_A }, handlerContext());
    handlers.memoryPinned!({ type: 'memoryPinned', id: ID_C }, handlerContext());
    await nextTick();

    expect(wrapper.find(`[data-memory-id="${ID_A}"] [data-action="unpin"]`).exists()).toBe(true);
    expect(wrapper.find(`[data-memory-id="${ID_C}"] [data-badge="pinned"]`).exists()).toBe(true);
  });

  it('offers the same actions on a carried row', async () => {
    const { wrapper } = await openWith(display());
    const row = wrapper.find(`[data-section="carried"] [data-memory-id="${ID_C}"]`);
    expect(row.find('[data-action="pin"]').exists()).toBe(true);
    expect(row.find('[data-action="forget"]').exists()).toBe(true);
    await row.find('[data-action="open-in-panel"]').trigger('click');
    expect(useUIStore().memoryPanelFocus).toEqual({ id: ID_C, kind: 'preference' });
  });

  it('opens the memory panel above itself, and Escape closes only the panel', async () => {
    const { wrapper } = await openWith(display());
    await wrapper.find(`[data-memory-id="${ID_A}"] [data-action="open-in-panel"]`).trigger('click');

    const panel = track(mount(MemoryPanel, {
      props: { notes: [], observations: [], searchResults: [], hasMoreObservations: false, loadingObservations: false },
      global: { plugins: [i18n], stubs: { MarkdownRenderer: true } },
      attachTo: document.body,
    }));
    const zOf = (w: VueWrapper) => Number((w.element as HTMLElement).style.zIndex);
    expect(zOf(panel)).toBeGreaterThan(zOf(wrapper.findComponent({ name: 'OverlayShell' })));

    pressEscape();

    expect(panel.emitted('close')).toHaveLength(1);
    expect(wrapper.emitted('close')).toBeUndefined();
  });

  it('shows the exact text in a pre, as text', async () => {
    const { wrapper } = await openWith(display({ exactText: '<memory id="x">a & b</memory>' }));
    expect(wrapper.find('[data-view-tab="memories"]').attributes('role')).toBe('tab');
    await showExactText(wrapper);
    expect(wrapper.find('[data-section="added"]').exists()).toBe(false);
    expect(wrapper.find('[data-action="copy-exact-text"]').attributes('aria-label')).toBeUndefined();
    const pre = wrapper.find('[data-exact-text]');
    expect(pre.text()).toBe('<memory id="x">a & b</memory>');
    expect(pre.find('memory').exists()).toBe(false);
  });
});
