// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { shallowRef } from 'vue';
import { setActivePinia, createPinia } from 'pinia';
import App from '@/App.vue';
import MemoryPanel from '../MemoryPanel.vue';
import { useUIStore } from '@/stores/useUIStore';
import { i18n } from '@/i18n';
import type { ChatHost } from '@/composables/useChatHost';

// happy-dom has no font loading API; VirtualizedMessageList awaits `document.fonts.ready` on mount.
if (!('fonts' in document)) {
  Object.defineProperty(document, 'fonts', { value: { ready: Promise.resolve() }, configurable: true });
}

// A remote chat's page is one whose host main named; undefined is a local chat.
const chatHost = shallowRef<ChatHost | undefined>(undefined);
vi.mock('@/composables/useChatHost', async (original) => ({ ...await original<typeof import('@/composables/useChatHost')>(), useChatHost: () => chatHost }));

let app: VueWrapper | null = null;
let posted: Record<string, unknown>[] = [];

beforeEach(() => {
  setActivePinia(createPinia());
  chatHost.value = undefined;
  posted = [];
  const api = (globalThis as unknown as { acquireVsCodeApi: () => { postMessage: (message: unknown) => void } }).acquireVsCodeApi();
  vi.spyOn(api, 'postMessage').mockImplementation((message: unknown) => void posted.push(message as Record<string, unknown>));
});

afterEach(() => {
  app?.unmount();
  app = null;
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

async function openPanel(): Promise<VueWrapper> {
  app = mount(App, { global: { plugins: [i18n], stubs: { MarkdownRenderer: true } }, attachTo: document.body });
  await flushPromises();
  useUIStore().openMemoryPanel();
  await flushPromises();
  posted = [];
  return app.findComponent(MemoryPanel) as VueWrapper;
}

async function create(panel: VueWrapper, payload: unknown): Promise<void> {
  panel.vm.$emit('create', payload);
  await flushPromises();
}

describe('the memory panel\'s create in App', () => {
  it('goes to the chat core in a local chat, a note included', async () => {
    const panel = await openPanel();

    await create(panel, { tier: 'note', kind: 'fact', content: 'n', requestId: 'r1' });

    expect(posted).toEqual([{ type: 'createMemory', tier: 'note', kind: 'fact', content: 'n', requestId: 'r1' }]);
  });

  it('goes to this computer for a global memory or note in a remote chat, and to the chat core otherwise', async () => {
    chatHost.value = { name: 'prod-1', computer: 'ALEXIOS-PC' };
    const panel = await openPanel();

    await create(panel, { tier: 'global', kind: 'preference', content: 'g', requestId: 'r2' });
    await create(panel, { tier: 'note', kind: 'fact', content: 'n', requestId: 'r3' });
    await create(panel, { tier: 'project', kind: 'fact', content: 'p', requestId: 'r4' });

    expect(posted).toEqual([
      { type: 'createUserMemory', tier: 'global', kind: 'preference', content: 'g', requestId: 'r2' },
      { type: 'createUserMemory', tier: 'note', content: 'n', requestId: 'r3' },
      { type: 'createMemory', tier: 'project', kind: 'fact', content: 'p', requestId: 'r4' },
    ]);
  });
});
