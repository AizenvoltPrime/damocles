import { describe, it, expect } from 'vitest';
import { piMessagesToHistoryAgentMessages } from '../message-mapper';

describe('piMessagesToHistoryAgentMessages', () => {
  it('maps user + assistant messages and pairs tool results back to their tool-call id', () => {
    const messages = [
      { role: 'user', content: 'do the thing' },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'hmm' },
          { type: 'text', text: 'looking' },
          { type: 'toolCall', id: 'tc1', name: 'read', arguments: { path: '/a.ts' } },
        ],
      },
      { role: 'toolResult', toolCallId: 'tc1', toolName: 'read', content: [{ type: 'text', text: 'file contents' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
    ];

    const out = piMessagesToHistoryAgentMessages(messages);
    expect(out).toHaveLength(3); // toolResult folds into the tool_use block, not a standalone message

    expect(out[0]).toEqual({ role: 'user', contentBlocks: [{ type: 'text', text: 'do the thing' }] });

    const assistant = out[1]!;
    expect(assistant.role).toBe('assistant');
    expect(assistant.contentBlocks[0]).toEqual({ type: 'thinking', thinking: 'hmm' });
    expect(assistant.contentBlocks[1]).toEqual({ type: 'text', text: 'looking' });
    const toolBlock = assistant.contentBlocks[2] as { type: string; id: string; result?: string };
    expect(toolBlock.type).toBe('tool_use');
    expect(toolBlock.id).toBe('tc1');
    expect(toolBlock.result).toBe('file contents');

    expect(out[2]).toEqual({ role: 'assistant', contentBlocks: [{ type: 'text', text: 'done' }] });
  });

  it('propagates a failed tool result as isError on the tool_use block', () => {
    const messages = [
      { role: 'user', content: 'run it' },
      { role: 'assistant', content: [{ type: 'toolCall', id: 'tc1', name: 'bash', arguments: { command: 'boom' } }] },
      { role: 'toolResult', toolCallId: 'tc1', toolName: 'bash', content: [{ type: 'text', text: 'exit 1' }], isError: true },
    ];
    const out = piMessagesToHistoryAgentMessages(messages);
    const toolBlock = out[1]!.contentBlocks[0] as { type: string; result?: string; isError?: boolean };
    expect(toolBlock.type).toBe('tool_use');
    expect(toolBlock.result).toBe('exit 1');
    expect(toolBlock.isError).toBe(true);
  });

  it('omits isError for a successful tool result', () => {
    const messages = [
      { role: 'assistant', content: [{ type: 'toolCall', id: 'tc1', name: 'read', arguments: {} }] },
      { role: 'toolResult', toolCallId: 'tc1', toolName: 'read', content: [{ type: 'text', text: 'ok' }], isError: false },
    ];
    const out = piMessagesToHistoryAgentMessages(messages);
    const toolBlock = out[0]!.contentBlocks[0] as { isError?: boolean };
    expect(toolBlock.isError).toBeUndefined();
  });

  it('skips empty user messages and assistant messages with no renderable blocks', () => {
    const out = piMessagesToHistoryAgentMessages([
      { role: 'user', content: '   ' },
      { role: 'assistant', content: [] },
    ]);
    expect(out).toEqual([]);
  });
});
