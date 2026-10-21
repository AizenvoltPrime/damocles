// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { nextTick } from 'vue';
import { setActivePinia, createPinia } from 'pinia';
import App from '@/App.vue';
import ChatInput from '../ChatInput.vue';
import { i18n } from '@/i18n';
import { useSessionStore } from '@/stores/useSessionStore';

// happy-dom has no font loading API; VirtualizedMessageList awaits `document.fonts.ready` on mount.
if (!('fonts' in document)) {
  Object.defineProperty(document, 'fonts', { value: { ready: Promise.resolve() }, configurable: true });
}

// A restored panel replays its stored conversation before core starts its session, so a send in between names that
// conversation; core refuses a nameless send to a stored one (docs/invariants.md "A send names its conversation").

interface Posted {
  type: string;
  sessionId?: string | null;
}

let app: VueWrapper | null = null;
let posted: Posted[] = [];
let saved: unknown;

beforeEach(() => {
  setActivePinia(createPinia());
  posted = [];
  saved = undefined;
  const api = (globalThis as unknown as { acquireVsCodeApi: () => { postMessage: (message: unknown) => void; getState: () => unknown } }).acquireVsCodeApi();
  vi.spyOn(api, 'postMessage').mockImplementation((message: unknown) => void posted.push(message as Posted));
  vi.spyOn(api, 'getState').mockImplementation(() => saved);
});

afterEach(() => {
  app?.unmount();
  app = null;
  vi.restoreAllMocks();
});

async function sendFromComposer(): Promise<Posted[]> {
  app = mount(App, { global: { plugins: [i18n] } });
  await nextTick();
  app.findComponent(ChatInput).vm.$emit('send', 'hello', false, []);
  await nextTick();
  return posted.filter((m) => m.type === 'sendMessage');
}

describe('the conversation a send names', () => {
  it('is the restored conversation while its session has not started', async () => {
    saved = { sessionId: 'stored-1' };
    expect(await sendFromComposer()).toEqual([expect.objectContaining({ content: 'hello', sessionId: 'stored-1' })]);
  });

  it('is none for a new panel before its session is announced', async () => {
    expect(await sendFromComposer()).toEqual([expect.objectContaining({ content: 'hello', sessionId: null })]);
  });

  it('is the restored conversation while its replay runs, between the clear and the done', async () => {
    saved = { sessionId: 'stored-1' };
    app = mount(App, { global: { plugins: [i18n] } });
    await nextTick();
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'sessionCleared', sessionId: 'stored-1' } }));
    await nextTick();
    app.findComponent(ChatInput).vm.$emit('send', 'hello', false, []);
    await nextTick();
    expect(posted.filter((m) => m.type === 'sendMessage')).toEqual([expect.objectContaining({ sessionId: 'stored-1' })]);
  });

  it.each([
    ['core opened nothing for it (a lease or another panel refused it, its open failed)', [{ type: 'sessionCleared' }]],
    ['its replay read no file', [
      { type: 'sessionCleared', sessionId: 'stored-1' },
      { type: 'sessionCleared' },
      { type: 'errorReplay', content: 'gone' },
      { type: 'done', data: { type: 'result', session_id: 'stored-1', is_done: true } },
    ]],
  ])('is none for a restore whose conversation did not open because %s', async (_why, messages) => {
    saved = { sessionId: 'stored-1' };
    app = mount(App, { global: { plugins: [i18n] } });
    await nextTick();
    for (const data of messages) window.dispatchEvent(new MessageEvent('message', { data }));
    await nextTick();
    app.findComponent(ChatInput).vm.$emit('send', 'hello', false, []);
    await nextTick();
    expect(posted.filter((m) => m.type === 'sendMessage')).toEqual([expect.objectContaining({ sessionId: null })]);
  });

  it('is the started session once one is announced', async () => {
    saved = { sessionId: 'stored-1' };
    app = mount(App, { global: { plugins: [i18n] } });
    await nextTick();
    useSessionStore().setCurrentSession('started-2');
    app.findComponent(ChatInput).vm.$emit('send', 'hello', false, []);
    await nextTick();
    expect(posted.filter((m) => m.type === 'sendMessage')).toEqual([expect.objectContaining({ sessionId: 'started-2' })]);
  });
});
