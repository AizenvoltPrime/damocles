// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import UserMessageBlock from '../UserMessageBlock.vue';
import { i18n } from '@/i18n';
import { useStreamingStore } from '@/stores/useStreamingStore';
import { createHistoryHandlers } from '@/composables/message-handler/handlers/history-handlers';
import type { HandlerContext } from '@/composables/message-handler/types';
import { formatClock } from '@/utils/clock';
import type { ChatMessage } from '@shared/types/session';
import type { ExtensionToWebviewMessage } from '@shared/types/messages';

const mounted: VueWrapper[] = [];

beforeEach(() => setActivePinia(createPinia()));

afterEach(() => {
  for (const wrapper of mounted.splice(0)) wrapper.unmount();
});

function replay(message: Extract<ExtensionToWebviewMessage, { type: 'userReplay' }>): ChatMessage {
  const streaming = useStreamingStore();
  createHistoryHandlers().userReplay!(message, { stores: { streamingStore: streaming } } as unknown as HandlerContext);
  streaming.flushReplayQueue();
  return streaming.messages.at(-1)!;
}

function shownTime(message: ChatMessage): string {
  const row = mount(UserMessageBlock, {
    props: { message, messageIndex: 0, canRewind: false, promptIndex: 0 },
    global: { plugins: [i18n], stubs: { MarkdownRenderer: true } },
  });
  mounted.push(row);
  return row.get('[data-testid="user-message-time"]').text();
}

describe('a replayed user message shows when it was sent', () => {
  it('keeps the time the host read from the session file, for a prompt and for a steer chip', () => {
    const sent = new Date(2026, 2, 4, 0, 7);
    const prompt = replay({ type: 'userReplay', content: 'hello', sdkMessageId: 'u1', promptIndex: 0, timestamp: sent.getTime() });
    const steer = replay({ type: 'userReplay', content: 'look', isInjected: true, steerTarget: { agentId: 'a1' }, timestamp: sent.getTime() + 60_000 });

    expect(prompt.timestamp).toBe(sent.getTime());
    expect(steer.timestamp).toBe(sent.getTime() + 60_000);
    expect(shownTime(prompt)).toBe(formatClock(sent, i18n.global.locale.value));
    expect(shownTime(steer)).toBe(formatClock(sent.getTime() + 60_000, i18n.global.locale.value));
  });
});
