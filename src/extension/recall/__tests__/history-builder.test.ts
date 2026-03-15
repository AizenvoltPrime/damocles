import { describe, it, expect } from 'vitest';
import { buildHistoryFromEntries } from '../history-builder';
import type { ClaudeSessionEntry } from '../../session/types';

function entry(partial: Partial<ClaudeSessionEntry> & Pick<ClaudeSessionEntry, 'type'>): ClaudeSessionEntry {
  return {
    sessionId: 'test-session',
    timestamp: new Date().toISOString(),
    ...partial,
  };
}

function userText(text: string): ClaudeSessionEntry {
  return entry({ type: 'user', message: { role: 'user', content: text } });
}

function userToolResult(toolUseId: string, content: string): ClaudeSessionEntry {
  return entry({
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'tool_result' as const, tool_use_id: toolUseId, content }],
    },
  });
}

function assistantText(text: string, msgId = 'msg-1'): ClaudeSessionEntry {
  return entry({
    type: 'assistant',
    message: {
      role: 'assistant',
      id: msgId,
      content: [{ type: 'text' as const, text }],
    },
  });
}

function assistantToolUse(
  id: string,
  name: string,
  input: Record<string, unknown>,
  msgId = 'msg-1'
): ClaudeSessionEntry {
  return entry({
    type: 'assistant',
    message: {
      role: 'assistant',
      id: msgId,
      content: [{ type: 'tool_use' as const, id, name, input }],
    },
  });
}

function assistantMixed(
  blocks: Array<
    | { type: 'text'; text: string }
    | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
    | { type: 'thinking'; thinking: string }
  >,
  msgId = 'msg-1'
): ClaudeSessionEntry {
  return entry({
    type: 'assistant',
    message: { role: 'assistant', id: msgId, content: blocks },
  });
}

describe('buildHistoryFromEntries', () => {
  it('matches tool results that arrive AFTER their tool_use blocks', () => {
    const entries = [
      userText('read the file'),
      assistantToolUse('tu-1', 'Read', { file_path: '/test.ts' }),
      userToolResult('tu-1', 'file contents here'),
      assistantText('Here is the file.'),
    ];

    const turns = buildHistoryFromEntries(entries);
    expect(turns).toHaveLength(1);
    expect(turns[0]!.toolCalls).toHaveLength(1);
    expect(turns[0]!.toolCalls[0]!.result).toBe('file contents here');
  });

  it('matches tool results that arrive BEFORE their tool_use blocks (actual JSONL ordering)', () => {
    const entries = [
      userText('write a file'),
      entry({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'thinking' as const, thinking: 'planning...' }] } }),
      userToolResult('tu-1', 'File written successfully'),
      assistantToolUse('tu-1', 'Write', { file_path: '/hello.txt' }),
      assistantText('Done.'),
    ];

    const turns = buildHistoryFromEntries(entries);
    expect(turns).toHaveLength(1);
    expect(turns[0]!.toolCalls).toHaveLength(1);
    expect(turns[0]!.toolCalls[0]!.name).toBe('Write');
    expect(turns[0]!.toolCalls[0]!.result).toBe('File written successfully');
  });

  it('handles multiple tool results before their tool_use blocks', () => {
    const entries = [
      userText('create 3 files'),
      entry({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'thinking' as const, thinking: 'planning' }] } }),
      userToolResult('tu-1', 'Written file1'),
      assistantMixed([
        { type: 'text', text: 'Created first file.' },
        { type: 'tool_use', id: 'tu-1', name: 'Write', input: { file_path: '/f1.txt' } },
      ]),
      userToolResult('tu-2', 'Written file2'),
      assistantMixed([
        { type: 'text', text: 'Created second file.' },
        { type: 'tool_use', id: 'tu-2', name: 'Write', input: { file_path: '/f2.txt' } },
      ]),
      userToolResult('tu-3', 'Written file3'),
      assistantMixed([
        { type: 'text', text: 'Created third file.' },
        { type: 'tool_use', id: 'tu-3', name: 'Write', input: { file_path: '/f3.txt' } },
      ]),
      assistantText('All done.'),
    ];

    const turns = buildHistoryFromEntries(entries);
    expect(turns).toHaveLength(1);
    expect(turns[0]!.toolCalls).toHaveLength(3);
    expect(turns[0]!.toolCalls[0]!.result).toBe('Written file1');
    expect(turns[0]!.toolCalls[1]!.result).toBe('Written file2');
    expect(turns[0]!.toolCalls[2]!.result).toBe('Written file3');
  });

  it('deduplicates tool_use blocks with the same id across assistant entries', () => {
    const entries = [
      userText('read file'),
      assistantMixed([
        { type: 'tool_use', id: 'tu-1', name: 'Read', input: { file_path: '/a.ts' } },
      ], 'msg-1'),
      userToolResult('tu-1', 'contents of a.ts'),
      assistantMixed([
        { type: 'text', text: 'response' },
        { type: 'tool_use', id: 'tu-1', name: 'Read', input: { file_path: '/a.ts' } },
      ], 'msg-1'),
    ];

    const turns = buildHistoryFromEntries(entries);
    expect(turns).toHaveLength(1);
    expect(turns[0]!.toolCalls).toHaveLength(1);
    expect(turns[0]!.toolCalls[0]!.result).toBe('contents of a.ts');
  });

  it('handles Agent tool results with extractAgentText', () => {
    const agentResult = JSON.stringify({
      type: 'result',
      subtype: 'success',
      cost_usd: 0.01,
      is_error: false,
      result: 'Agent found the answer: 42',
    });

    const entries = [
      userText('launch agent'),
      userToolResult('tu-1', agentResult),
      assistantToolUse('tu-1', 'Agent', { prompt: 'find answer' }),
      assistantText('The answer is 42.'),
    ];

    const turns = buildHistoryFromEntries(entries);
    expect(turns).toHaveLength(1);
    expect(turns[0]!.toolCalls[0]!.name).toBe('Agent');
    expect(turns[0]!.toolCalls[0]!.result).toContain('Agent found the answer: 42');
  });

  it('handles mixed ordering across multiple turns', () => {
    const entries = [
      userText('first question'),
      userToolResult('tu-1', 'result-1'),
      assistantToolUse('tu-1', 'Read', { file_path: '/a.ts' }),
      assistantText('First answer'),
      userText('second question'),
      assistantToolUse('tu-2', 'Read', { file_path: '/b.ts' }),
      userToolResult('tu-2', 'result-2'),
      assistantText('Second answer'),
    ];

    const turns = buildHistoryFromEntries(entries);
    expect(turns).toHaveLength(2);
    expect(turns[0]!.toolCalls[0]!.result).toBe('result-1');
    expect(turns[1]!.toolCalls[0]!.result).toBe('result-2');
  });

  it('produces correct contentBlocks indices for early-arriving tool results', () => {
    const entries = [
      userText('write file'),
      userToolResult('tu-1', 'Written'),
      assistantMixed([
        { type: 'text', text: 'Creating file...' },
        { type: 'tool_use', id: 'tu-1', name: 'Write', input: { file_path: '/f.txt' } },
      ]),
      assistantText('Done'),
    ];

    const turns = buildHistoryFromEntries(entries);
    const turn = turns[0]!;
    expect(turn.contentBlocks).toHaveLength(3);
    expect(turn.contentBlocks[0]).toEqual({ type: 'text', content: 'Creating file...' });
    expect(turn.contentBlocks[1]).toEqual({ type: 'tool_call', index: 0 });
    expect(turn.contentBlocks[2]).toEqual({ type: 'text', content: 'Done' });

    const toolCallBlock = turn.contentBlocks[1] as { type: 'tool_call'; index: number };
    expect(turn.toolCalls[toolCallBlock.index]!.result).toBe('Written');
  });
});
