import { describe, it, expect } from 'vitest';
import { ref } from 'vue';
import type { ChatMessage, CompactMarker } from '@shared/types/session';
import { useVirtualizedMessages } from '../useVirtualizedMessages';

function build(messages: ChatMessage[]) {
  return useVirtualizedMessages(
    ref(messages),
    ref<CompactMarker[]>([]),
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
