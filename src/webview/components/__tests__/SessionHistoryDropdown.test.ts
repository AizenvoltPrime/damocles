// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { nextTick } from 'vue';
import { setActivePinia, createPinia } from 'pinia';
import SessionHistoryDropdown from '../chat-header/SessionHistoryDropdown.vue';
import { i18n } from '@/i18n';
import type { StoredSession } from '@shared/types/session';

const SESSIONS: StoredSession[] = [
  { id: 's-login', timestamp: Date.now(), preview: 'Rate-limit the login route' },
  { id: 's-docs', timestamp: Date.now() - 3_600_000, preview: 'Add OpenAPI docs', tag: 'docs' },
];

const mounted: VueWrapper[] = [];
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const byTestId = <T extends HTMLElement = HTMLElement>(id: string, root: ParentNode = document.body) => root.querySelector<T>(`[data-testid="${id}"]`);
const row = (id: string) => document.body.querySelector<HTMLElement>(`[data-session-id="${id}"]`)!;

async function openHistory(props: Partial<InstanceType<typeof SessionHistoryDropdown>['$props']> = {}): Promise<VueWrapper> {
  const wrapper = mount(SessionHistoryDropdown, {
    attachTo: document.body,
    props: { sessions: SESSIONS, selectedSessionId: 's-login', selectedSessionName: null, hasMore: true, loading: false, ...props },
    global: { plugins: [i18n] },
  });
  mounted.push(wrapper);
  byTestId('chat-header-history')!.click();
  await flush();
  await nextTick();
  return wrapper;
}

async function type(input: HTMLInputElement, value: string): Promise<void> {
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await nextTick();
}

beforeEach(() => setActivePinia(createPinia()));
afterEach(() => {
  while (mounted.length) mounted.pop()?.unmount();
  vi.useRealTimers();
  document.body.innerHTML = '';
});

describe('SessionHistoryDropdown', () => {
  it('is a named button that opens the conversation list with its search', async () => {
    await openHistory();

    expect(byTestId('chat-header-history')?.getAttribute('aria-label')).toBe('Session history');
    expect(byTestId<HTMLInputElement>('history-search')?.placeholder).toBe('Search conversations');
    expect(document.body.querySelector('[data-session-id="s-login"] [aria-current="true"]')).not.toBeNull();
  });

  it('searches after the user stops typing', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const wrapper = mount(SessionHistoryDropdown, {
      attachTo: document.body,
      props: { sessions: SESSIONS, selectedSessionId: null, selectedSessionName: null, hasMore: false, loading: false },
      global: { plugins: [i18n] },
    });
    mounted.push(wrapper);
    byTestId('chat-header-history')!.click();
    await vi.runAllTimersAsync();

    await type(byTestId<HTMLInputElement>('history-search')!, 'login');
    await vi.advanceTimersByTimeAsync(300);

    expect(wrapper.emitted('search')).toEqual([['login', 0]]);
  });

  it('selects a conversation and closes', async () => {
    const wrapper = await openHistory();

    byTestId('session-select', row('s-docs'))!.click();
    await flush();

    expect(wrapper.emitted('select')).toEqual([['s-docs']]);
    expect(row('s-docs')).toBeNull();
  });

  it('renames a conversation', async () => {
    const wrapper = await openHistory();

    byTestId('session-rename', row('s-docs'))!.click();
    await nextTick();
    const input = row('s-docs').querySelector<HTMLInputElement>('input')!;
    await type(input, 'OpenAPI for /users');
    input.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true }));
    await nextTick();

    expect(wrapper.emitted('rename')).toEqual([['s-docs', 'OpenAPI for /users']]);
  });

  it('tags a conversation and removes a tag with an empty value', async () => {
    const wrapper = await openHistory();

    byTestId('session-tag', row('s-login'))!.click();
    await nextTick();
    const input = row('s-login').querySelector<HTMLInputElement>('input')!;
    await type(input, 'security');
    input.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true }));
    await nextTick();

    byTestId('session-tag', row('s-docs'))!.click();
    await nextTick();
    const tagInput = row('s-docs').querySelector<HTMLInputElement>('input')!;
    expect(tagInput.value).toBe('docs');
    await type(tagInput, '');
    tagInput.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true }));
    await nextTick();

    expect(wrapper.emitted('tag')).toEqual([['s-login', 'security'], ['s-docs', null]]);
  });

  it('deletes a conversation only after the confirmation', async () => {
    const wrapper = await openHistory();

    byTestId('session-delete', row('s-docs'))!.click();
    await flush();
    expect(wrapper.emitted('delete')).toBeUndefined();

    const confirm = [...document.body.querySelectorAll<HTMLButtonElement>('[role="alertdialog"] button')].find((b) => b.textContent?.trim() === 'Delete');
    confirm!.click();
    await flush();

    expect(wrapper.emitted('delete')).toEqual([['s-docs']]);
  });

  it('loads more conversations', async () => {
    const wrapper = await openHistory();

    byTestId('session-load-more')!.click();

    expect(wrapper.emitted('loadMore')).toHaveLength(1);
  });

  it('keeps the dropdown open when Escape cancels a rename', async () => {
    await openHistory();
    byTestId('session-rename', row('s-docs'))!.click();
    await nextTick();
    const input = row('s-docs').querySelector<HTMLInputElement>('input')!;
    input.focus();

    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    input.dispatchEvent(new KeyboardEvent('keyup', { key: 'Escape', bubbles: true }));
    await flush();

    expect(row('s-docs')).not.toBeNull();
    expect(row('s-docs').querySelector('input')).toBeNull();
  });
});
