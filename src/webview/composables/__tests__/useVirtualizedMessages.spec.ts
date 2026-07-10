import { describe, it, expect } from 'vitest';
import { ref } from 'vue';
import type { ChatMessage, CompactMarker, CacheMissNotice } from '@shared/types/session';
import { useVirtualizedMessages } from '../useVirtualizedMessages';

function build(messages: ChatMessage[], cacheMissNotices: CacheMissNotice[] = []) {
  return useVirtualizedMessages(
    ref(messages),
    ref<CompactMarker[]>([]),
    ref<CacheMissNotice[]>(cacheMissNotices),
    ref<string | null>(null),
    ref({}),
  );
}

describe('useVirtualizedMessages refusal handling', () => {
  it('emits a single refusal-message item for a role:refusal message', () => {
    const refusal: ChatMessage = {
      id: 'r1',
      role: 'refusal',
      content: 'declined for safety',
      refusalExplanation: 'declined for safety',
      refusalCategory: 'cyber',
      timestamp: 1,
    };
    const { items } = build([refusal]);

    expect(items.value).toHaveLength(1);
    const item = items.value[0];
    expect(item.type).toBe('refusal-message');
    expect(item.id).toBe('refusal-r1');
    expect(item.text).toBe('declined for safety');
    expect(item.message.refusalCategory).toBe('cyber');
  });

  it('does not emit a stray text bubble for an empty-content assistant turn preceding a refusal', () => {
    const assistant: ChatMessage = {
      id: 'a1',
      role: 'assistant',
      content: '',
      timestamp: 1,
    };
    const refusal: ChatMessage = {
      id: 'r1',
      role: 'refusal',
      content: '',
      refusalExplanation: null,
      refusalCategory: null,
      timestamp: 2,
    };
    const { items } = build([assistant, refusal]);

    expect(items.value).toHaveLength(1);
    expect(items.value[0].type).toBe('refusal-message');
  });
});

describe('useVirtualizedMessages cache-miss notice interleaving', () => {
  it('places a cache-miss-notice at the correct position between two messages', () => {
    const first: ChatMessage = { id: 'u1', role: 'user', content: 'first', timestamp: 100 };
    const second: ChatMessage = { id: 'u2', role: 'user', content: 'second', timestamp: 300 };
    // Store ids are prefix-free (`<timestamp>-<seq>`); the virtualizer namespaces with `cache-miss-`.
    const notice: CacheMissNotice = {
      id: '200-0',
      missedTokens: 12000,
      missedCost: 0.42,
      idleMs: 6 * 60 * 1000,
      modelChanged: false,
      timestamp: 200,
    };

    const { items } = build([first, second], [notice]);

    const types = items.value.map(i => i.type);
    expect(types).toEqual(['user-message', 'cache-miss-notice', 'user-message']);

    const noticeItem = items.value[1];
    expect(noticeItem.type).toBe('cache-miss-notice');
    // Namespaced once — no `cache-miss-cache-miss-` double prefix.
    expect(noticeItem.id).toBe('cache-miss-200-0');
    expect(noticeItem.notice).toEqual(notice);
  });

  it('emits a trailing cache-miss-notice when its timestamp is after the last message', () => {
    const only: ChatMessage = { id: 'u1', role: 'user', content: 'hello', timestamp: 100 };
    const notice: CacheMissNotice = {
      id: '500-0',
      missedTokens: 2048,
      missedCost: 0,
      idleMs: 1000,
      modelChanged: true,
      timestamp: 500,
    };

    const { items } = build([only], [notice]);

    const types = items.value.map(i => i.type);
    expect(types).toEqual(['user-message', 'cache-miss-notice']);
    expect(items.value[1].notice).toEqual(notice);
  });
});
