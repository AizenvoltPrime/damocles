// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
// `vue3-lottie` runs canvas setup at import time, which happy-dom does not provide.
vi.mock('vue3-lottie', () => ({ Vue3Lottie: { name: 'Vue3Lottie', render: () => null } }));
import { mount, type VueWrapper } from '@vue/test-utils';
import { nextTick } from 'vue';
import { setActivePinia, createPinia } from 'pinia';
import App from '@/App.vue';
import ChatInput from '../ChatInput.vue';
import { i18n } from '@/i18n';
import type { SteerRequest } from '@/utils/steer-command';

// happy-dom has no font loading API; VirtualizedMessageList awaits `document.fonts.ready` on mount.
if (!('fonts' in document)) {
  Object.defineProperty(document, 'fonts', { value: { ready: Promise.resolve() }, configurable: true });
}

const PNG = { type: 'image' as const, source: { type: 'base64' as const, media_type: 'image/png' as const, data: 'AAAA' } };

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

/** ChatInput clears its draft as it emits, so a dropped binding would lose the steer without a trace. */
async function steerFromComposer(steer: SteerRequest): Promise<{ type: string }[]> {
  app = mount(App, { global: { plugins: [i18n] } });
  app.findComponent(ChatInput).vm.$emit('steer', steer, 'req-1');
  await nextTick();
  return posted.filter((m) => m.type === 'steerAgent');
}

describe('App on a steer from the composer', () => {
  it('posts steerAgent with the images and the request id', async () => {
    expect(await steerFromComposer({ agentId: 'abc', message: 'look', images: [PNG] })).toStrictEqual([
      { type: 'steerAgent', agentId: 'abc', message: 'look', images: [PNG], requestId: 'req-1' },
    ]);
  });

  it('omits an empty images array', async () => {
    expect(await steerFromComposer({ agentId: 'abc', message: 'stop', images: [] })).toStrictEqual([
      { type: 'steerAgent', agentId: 'abc', message: 'stop', requestId: 'req-1' },
    ]);
  });
});
