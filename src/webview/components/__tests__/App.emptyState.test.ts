// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { nextTick } from 'vue';
import { setActivePinia, createPinia } from 'pinia';
import App from '@/App.vue';
import ChatHeader from '../chat-header/ChatHeader.vue';
import { i18n } from '@/i18n';
import { useSessionStore } from '@/stores/useSessionStore';

// happy-dom has no font loading API; VirtualizedMessageList awaits `document.fonts.ready` on mount.
if (!('fonts' in document)) {
  Object.defineProperty(document, 'fonts', { value: { ready: Promise.resolve() }, configurable: true });
}

/**
 * The empty state follows the rows the transcript renders, and the composer's draft survives both entries
 * that start a prompt without typing: a suggestion chip and the More menu's Side question.
 */

let app: VueWrapper | null = null;
let posted: { type: string; content?: unknown }[] = [];

beforeEach(() => {
  setActivePinia(createPinia());
  posted = [];
  const api = (globalThis as unknown as { acquireVsCodeApi: () => { postMessage: (message: unknown) => void } }).acquireVsCodeApi();
  vi.spyOn(api, 'postMessage').mockImplementation((message: unknown) => void posted.push(message as { type: string }));
});

afterEach(() => {
  app?.unmount();
  app = null;
  vi.restoreAllMocks();
});

async function mountApp(): Promise<VueWrapper> {
  app = mount(App, { global: { plugins: [i18n] }, attachTo: document.body });
  await nextTick();
  return app;
}

async function typeDraft(wrapper: VueWrapper, text: string): Promise<HTMLTextAreaElement> {
  const textarea = wrapper.get('textarea');
  await textarea.setValue(text);
  return textarea.element as HTMLTextAreaElement;
}

describe('the empty state', () => {
  it('shows for a session with nothing in it', async () => {
    expect((await mountApp()).find('[data-testid="empty-state"]').exists()).toBe(true);
  });

  it('yields to a compaction-aborted notice that arrived before any message', async () => {
    const wrapper = await mountApp();

    useSessionStore().addCompactionAbortedNotice('threshold', true, 500);
    await nextTick();
    await nextTick();

    expect(wrapper.find('[data-testid="empty-state"]').exists()).toBe(false);
  });
});

describe('a suggestion chip with a draft in the box', () => {
  it('sends its own prompt and leaves the draft in the box', async () => {
    const wrapper = await mountApp();
    const textarea = await typeDraft(wrapper, 'half a thought');

    await wrapper.get('[data-testid="empty-state-suggestion"]').trigger('click');

    expect(posted.filter((m) => m.type === 'sendMessage')).toEqual([expect.objectContaining({ content: 'Explain this codebase' })]);
    expect(textarea.value).toBe('half a thought');
  });
});

describe('Side question with a draft in the box', () => {
  it('turns the draft into a side question instead of replacing it', async () => {
    const wrapper = await mountApp();
    const textarea = await typeDraft(wrapper, 'why is the build slow');

    wrapper.findComponent(ChatHeader).vm.$emit('action', 'sideQuestion');
    await nextTick();

    expect(textarea.value).toBe('/btw why is the build slow');
  });
});
