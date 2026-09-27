// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import { setActivePinia, createPinia } from 'pinia';
import UserMessageBlock from '../UserMessageBlock.vue';
import { i18n } from '@/i18n';
import { createStreamingHandlers } from '@/composables/message-handler/handlers/streaming-handlers';
import { useStreamingStore } from '@/stores/useStreamingStore';
import type { HandlerContext } from '@/composables/message-handler/types';
import type { ChatMessage } from '@shared/types/session';

function row(over: Partial<ChatMessage>): ChatMessage {
  return { id: 'u1', role: 'user', content: 'hello', timestamp: 1, ...over };
}

function mountRow(message: ChatMessage) {
  return mount(UserMessageBlock, {
    props: { message, messageIndex: 0, canRewind: false, promptIndex: 0 },
    global: { plugins: [i18n], stubs: { MarkdownRenderer: true } },
  });
}

const label = (message: ChatMessage) => mountRow(message).find('[data-user-label]');

beforeEach(() => setActivePinia(createPinia()));

describe('UserMessageBlock label', () => {
  it('labels a command echo as a command, not as sent mid-stream', () => {
    const l = label(row({ content: '/compact', isInjected: true, isCommandEcho: true }));
    expect(l.attributes('data-user-label')).toBe('command');
    expect(l.text()).toBe('↳ command');
  });

  it.each([
    ['a cancel note', { isInjected: true }],
    ['a mid-stream batch', { isCombinedQueue: true }],
    ['a queued message', { isQueued: true, isInjected: true }],
  ])('labels %s as sent mid-stream', (_name, over) => {
    expect(label(row(over)).attributes('data-user-label')).toBe('mid-stream');
  });

  it('shows no label on a prompt', () => {
    expect(label(row({})).exists()).toBe(false);
  });

  it('carries the command-echo flag from the host message onto the row', () => {
    const streamingStore = useStreamingStore();
    const ctx = { stores: { streamingStore } } as unknown as HandlerContext;
    createStreamingHandlers().userMessage!(
      { type: 'userMessage', content: '/init', correlationId: 'c1', promptIndex: 0, isInjected: true, isCommandEcho: true },
      ctx,
    );
    expect(streamingStore.messages.at(-1)).toMatchObject({ isInjected: true, isCommandEcho: true });
  });
});
