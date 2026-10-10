// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { nextTick } from 'vue';
import { setActivePinia, createPinia } from 'pinia';
import App from '@/App.vue';
import { useSettingsStore } from '@/stores/useSettingsStore';
import { i18n } from '@/i18n';

// happy-dom has no font loading API; VirtualizedMessageList awaits `document.fonts.ready` on mount.
if (!('fonts' in document)) {
  Object.defineProperty(document, 'fonts', { value: { ready: Promise.resolve() }, configurable: true });
}

let app: VueWrapper | null = null;
let posted: { type: string }[] = [];

beforeEach(() => {
  setActivePinia(createPinia());
  posted = [];
  const api = (globalThis as unknown as { acquireVsCodeApi: () => { postMessage: (message: unknown) => void } }).acquireVsCodeApi();
  vi.spyOn(api, 'postMessage').mockImplementation((message: unknown) => void posted.push(message as { type: string }));
});

afterEach(() => {
  app?.unmount();
  app = null;
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('a model that needed OpenAI sign-in', () => {
  it('is left to core: the chat requests no model when a credential appears', async () => {
    const settings = useSettingsStore();
    settings.setModelState('claude-opus-5-5', 'claude-opus-5-5');
    app = mount(App, { global: { plugins: [i18n] }, attachTo: document.body });
    await nextTick();

    window.dispatchEvent(new MessageEvent('message', { data: { type: 'openaiAuthRequired', modelValue: 'gpt-6.1-sol' } }));
    await nextTick();
    settings.setOpenAIAuthStatus({ ...settings.openaiAuthStatus, chatgpt: { ...settings.openaiAuthStatus.chatgpt, signedIn: true } }, false);
    await nextTick();

    expect(posted.filter((m) => m.type === 'setActiveModel')).toEqual([]);
    expect(settings.activeModel).toBe('claude-opus-5-5');
  });
});
