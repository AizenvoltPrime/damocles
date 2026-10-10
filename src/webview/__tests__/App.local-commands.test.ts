// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { nextTick } from 'vue';
import { setActivePinia, createPinia } from 'pinia';
import App from '@/App.vue';
import ChatInput from '@/components/ChatInput.vue';
import { i18n } from '@/i18n';
import { useUIStore } from '@/stores/useUIStore';
import { useContextUsageStore } from '@/stores/useContextUsageStore';

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

// `queue` is the composer's path while a turn runs; a local command must act the same on both.
async function submit(event: 'send' | 'queue', content: string): Promise<string[]> {
  app = mount(App, { global: { plugins: [i18n] } });
  posted = [];
  if (event === 'send') app.findComponent(ChatInput).vm.$emit('send', content, false, []);
  else app.findComponent(ChatInput).vm.$emit('queue', content);
  await nextTick();
  return posted.map((m) => m.type);
}

describe.each(['send', 'queue'] as const)('App local slash commands on the %s path', (event) => {
  it('/clear clears the session and sends no chat message', async () => {
    expect(await submit(event, ' /clear ')).toEqual(['clearSession']);
  });

  it('/rewind opens the rewind flow and sends no chat message', async () => {
    expect(await submit(event, '/rewind')).toEqual(['requestRewindHistory']);
    expect(useUIStore().showRewindBrowser).toBe(true);
  });

  it('/context opens the context view and sends no chat message', async () => {
    expect(await submit(event, '/context')).toEqual(['requestContextUsage']);
    expect(useContextUsageStore().isOverlayOpen).toBe(true);
  });

  it('/clear with trailing text is an ordinary message', async () => {
    expect(await submit(event, '/clear the cache')).toEqual([event === 'send' ? 'sendMessage' : 'queueMessage']);
  });
});
