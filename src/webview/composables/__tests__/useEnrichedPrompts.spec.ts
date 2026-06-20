import { describe, it, expect, beforeEach } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import type { ChatMessage, ToolCall } from '@shared/types/session';
import { useEnrichedPrompts, type EnrichedPrompt } from '../useEnrichedPrompts';
import { useStreamingStore } from '@/stores/useStreamingStore';

let idCounter = 0;
function nextId(prefix = 'id'): string {
  idCounter += 1;
  return `${prefix}-${idCounter}`;
}

function userMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: overrides.id ?? nextId('msg'),
    role: 'user',
    content: overrides.content ?? 'hello',
    timestamp: overrides.timestamp ?? Date.UTC(2026, 4, 2, 14, 30),
    ...overrides,
  };
}

function assistantMessage(toolCalls: ToolCall[], overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: overrides.id ?? nextId('asst'),
    role: 'assistant',
    content: overrides.content ?? '',
    toolCalls,
    timestamp: overrides.timestamp ?? Date.UTC(2026, 4, 2, 14, 30),
    ...overrides,
  };
}

function errorMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: overrides.id ?? nextId('err'),
    role: 'error',
    content: overrides.content ?? 'boom',
    timestamp: overrides.timestamp ?? Date.UTC(2026, 4, 2, 14, 30),
    ...overrides,
  };
}

function tool(name: string, status: ToolCall['status'] = 'completed'): ToolCall {
  return {
    id: nextId('tool'),
    name,
    input: {},
    status,
  };
}

function setMessages(messages: ChatMessage[]): void {
  const store = useStreamingStore();
  store.messages = messages;
}

function rowAt(rows: EnrichedPrompt[], index: number): EnrichedPrompt {
  const row = rows[index];
  if (!row) {
    throw new Error(`Expected EnrichedPrompt at index ${index} but rows.length = ${rows.length}`);
  }
  return row;
}

describe('useEnrichedPrompts', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    idCounter = 0;
  });

  it('returns empty array when there are no messages', () => {
    const enriched = useEnrichedPrompts();
    expect(enriched.value).toEqual([]);
  });

  it('returns one row with no tools/errors when prompt has no following assistant turn', () => {
    setMessages([userMessage({ content: 'first prompt', promptIndex: 0 })]);
    const enriched = useEnrichedPrompts();
    expect(enriched.value).toHaveLength(1);
    const first = rowAt(enriched.value, 0);
    expect(first.text).toBe('first prompt');
    expect(first.tools).toEqual([]);
    expect(first.errored).toBe(false);
    expect(first.promptIndex).toBe(0);
  });

  it('collects unique tool names in window of 5 distinct tool calls', () => {
    setMessages([
      userMessage({ content: 'go', promptIndex: 0 }),
      assistantMessage([
        tool('Bash'),
        tool('Read'),
        tool('Grep'),
        tool('Edit'),
        tool('Write'),
      ]),
    ]);
    const enriched = useEnrichedPrompts();
    expect(enriched.value).toHaveLength(1);
    expect(rowAt(enriched.value, 0).tools).toEqual(['Bash', 'Read', 'Grep', 'Edit', 'Write']);
    expect(rowAt(enriched.value, 0).errored).toBe(false);
  });

  it('marks errored=true when an error message follows the prompt', () => {
    setMessages([
      userMessage({ content: 'do thing', promptIndex: 0 }),
      errorMessage(),
    ]);
    const enriched = useEnrichedPrompts();
    expect(rowAt(enriched.value, 0).errored).toBe(true);
  });

  it('marks errored=true when a refusal message follows the prompt', () => {
    setMessages([
      userMessage({ content: 'do thing', promptIndex: 0 }),
      { id: nextId('ref'), role: 'refusal', content: 'declined', timestamp: Date.UTC(2026, 4, 2, 14, 30) },
    ]);
    const enriched = useEnrichedPrompts();
    expect(rowAt(enriched.value, 0).errored).toBe(true);
  });

  it('marks errored=true when an assistant tool call has status failed', () => {
    setMessages([
      userMessage({ content: 'do thing', promptIndex: 0 }),
      assistantMessage([tool('Bash', 'failed')]),
    ]);
    const enriched = useEnrichedPrompts();
    expect(rowAt(enriched.value, 0).errored).toBe(true);
  });

  it('image-only prompt yields empty text and hasNonTextAttachments=true', () => {
    setMessages([
      userMessage({
        content: '[1 image]',
        contentBlocks: [
          {
            type: 'image',
            source: { type: 'base64', media_type: 'image/png', data: 'AAA' },
          },
        ],
      }),
    ]);
    const enriched = useEnrichedPrompts();
    expect(enriched.value).toHaveLength(1);
    const row = rowAt(enriched.value, 0);
    expect(row.text).toBe('');
    expect(row.hasNonTextAttachments).toBe(true);
  });

  it('subagent-internal prompt is excluded but still bounds the parent tool window', () => {
    setMessages([
      userMessage({ content: 'parent', promptIndex: 0 }),
      assistantMessage([tool('Bash')]),
      userMessage({ content: 'subagent inner', parentToolUseId: 'tool-123' }),
      assistantMessage([tool('Read')]),
    ]);
    const enriched = useEnrichedPrompts();
    expect(enriched.value).toHaveLength(1);
    const row = rowAt(enriched.value, 0);
    expect(row.text).toBe('parent');
    expect(row.tools).toEqual(['Bash']);
  });

  it('user record carrying tool_result content block is excluded', () => {
    setMessages([
      userMessage({
        content: '',
        contentBlocks: [
          { type: 'tool_result', tool_use_id: 'tool-1', content: 'ok' },
        ],
      }),
      userMessage({ content: 'real', promptIndex: 0 }),
    ]);
    const enriched = useEnrichedPrompts();
    expect(enriched.value).toHaveLength(1);
    expect(rowAt(enriched.value, 0).text).toBe('real');
  });

  it('queued message is excluded and does not terminate the previous prompt tool window', () => {
    setMessages([
      userMessage({ content: 'first', promptIndex: 0 }),
      userMessage({ content: 'queued', isQueued: true, isInjected: true }),
      assistantMessage([tool('Bash')]),
    ]);
    const enriched = useEnrichedPrompts();
    expect(enriched.value).toHaveLength(1);
    const row = rowAt(enriched.value, 0);
    expect(row.text).toBe('first');
    expect(row.tools).toEqual(['Bash']);
  });
});
