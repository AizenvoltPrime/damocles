// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
// `vue3-lottie` runs canvas setup at import time, which happy-dom does not provide.
vi.mock('vue3-lottie', () => ({ Vue3Lottie: { name: 'Vue3Lottie', render: () => null } }));
import { mount, type VueWrapper } from '@vue/test-utils';
import { nextTick } from 'vue';
import { setActivePinia, createPinia } from 'pinia';
import App from '@/App.vue';
import ChatInput from '@/components/ChatInput.vue';
import { i18n } from '@/i18n';
import { useUsageStatsStore } from '@/stores/useUsageStatsStore';

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
  vi.restoreAllMocks();
});

async function submit(event: 'send' | 'queue', content: string): Promise<string[]> {
  app = mount(App, { global: { plugins: [i18n] } });
  posted = [];
  app.findComponent(ChatInput).vm.$emit(event, content, false);
  await nextTick();
  return posted.map((m) => m.type);
}

describe('App on /stats', () => {
  it.each(['send', 'queue'] as const)('opens the overlay from the %s path and sends no chat message', async (event) => {
    const types = await submit(event, '  /stats ');
    expect(useUsageStatsStore().isOverlayOpen).toBe(true);
    expect(types).toEqual(['requestUsageStats']);
  });

  it('sends /stats with trailing text as a chat message', async () => {
    const types = await submit('send', '/stats please');
    expect(useUsageStatsStore().isOverlayOpen).toBe(false);
    expect(types).toContain('sendMessage');
  });
});
