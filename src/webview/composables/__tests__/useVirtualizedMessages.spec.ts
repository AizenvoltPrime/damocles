import { describe, it, expect } from 'vitest';
import { ref } from 'vue';
import type { ChatMessage, CompactMarker, ModelFallbackNotice } from '@shared/types/session';
import { useVirtualizedMessages } from '../useVirtualizedMessages';

function build(messages: ChatMessage[], notices: ModelFallbackNotice[] = []) {
  return useVirtualizedMessages(
    ref(messages),
    ref<CompactMarker[]>([]),
    ref<string | null>(null),
    ref({}),
    ref(notices),
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

describe('useVirtualizedMessages model fallback notices', () => {
  function makeNotice(anchorMessageId: string | null): ModelFallbackNotice {
    return {
      id: 'fb1',
      timestamp: 200,
      fromModel: 'claude-opus-4-8',
      toModel: 'claude-sonnet-4-6',
      trigger: 'overloaded',
      anchorMessageId,
    };
  }

  const first: ChatMessage = { id: 'u1', role: 'user', content: 'first', timestamp: 100 };
  const second: ChatMessage = { id: 'u2', role: 'user', content: 'second', timestamp: 300 };

  it('renders a notice anchored to the first message between the two messages', () => {
    const notice = makeNotice('u1');
    const { items } = build([first, second], [notice]);

    expect(items.value.map(i => i.type)).toEqual(['user-message', 'model-fallback-notice', 'user-message']);
    expect(items.value[1].id).toBe('fallback-fb1');
    expect(items.value[1].notice).toEqual(notice);
  });

  it('renders a notice anchored to the last message after it', () => {
    const notice = makeNotice('u2');
    const { items } = build([first, second], [notice]);

    expect(items.value.map(i => i.type)).toEqual(['user-message', 'user-message', 'model-fallback-notice']);
    expect(items.value[2].notice).toEqual(notice);
  });

  it('renders a null-anchored notice before all messages', () => {
    const notice = makeNotice(null);
    const { items } = build([first, second], [notice]);

    expect(items.value.map(i => i.type)).toEqual(['model-fallback-notice', 'user-message', 'user-message']);
  });

  it('treats a notice with a missing anchor as null-anchored', () => {
    const notice = makeNotice('gone');
    const { items } = build([first, second], [notice]);

    expect(items.value.map(i => i.type)).toEqual(['model-fallback-notice', 'user-message', 'user-message']);
  });
});
