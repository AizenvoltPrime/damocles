// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import { setActivePinia, createPinia } from 'pinia';
import VirtualizedMessageList from '../VirtualizedMessageList.vue';
import VirtualItemWrapper from '../VirtualItemWrapper.vue';
import { i18n } from '@/i18n';
import type { VirtualItem } from '@/composables/useVirtualizedMessages';

/**
 * The empty state belongs to App.vue, so the list draws only its canvas when it has nothing. Each row
 * sits inside the centred chat column while the scroll container stays full width.
 */

function mountList(props: Record<string, unknown>) {
  return mount(VirtualizedMessageList, {
    props: { messages: [], ...props },
    global: { plugins: [createPinia(), i18n] },
  });
}

const row: VirtualItem = {
  id: 'user-u1',
  type: 'user-message',
  message: { id: 'u1', role: 'user', content: 'hello', timestamp: 1 },
  originalMessageIndex: 0,
  sourceMessageId: 'u1',
  spacingLevel: 0,
};

function wrapperFor(arriving: boolean) {
  return mount(VirtualItemWrapper, {
    props: { item: row, top: 0, arriving, canRewind: false, promptIndex: 0 },
    global: { plugins: [i18n], stubs: { UserMessageBlock: true } },
  });
}

describe('the transcript list', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    // happy-dom ships no font loading API, and the list measures text on mount.
    Object.defineProperty(document, 'fonts', { value: { ready: Promise.resolve() }, configurable: true });
  });

  it('draws no welcome screen of its own when the session has nothing at all', () => {
    const list = mountList({});

    expect(list.text()).toBe('');
    expect(list.find('img').exists()).toBe(false);
  });

  it('measures rows against an element carrying the chat column class', () => {
    expect(mountList({}).find('.chat-column[aria-hidden="true"]').exists()).toBe(true);
  });
});

describe('a transcript row', () => {
  it('sits in the chat column', () => {
    expect(wrapperFor(false).classes()).toContain('chat-column');
  });

  it('enters only while it is arriving live', () => {
    expect(wrapperFor(true).classes()).toContain('d-arrive');
    expect(wrapperFor(false).classes()).not.toContain('d-arrive');
  });
});
