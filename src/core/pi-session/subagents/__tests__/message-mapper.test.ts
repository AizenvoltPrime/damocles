import { describe, it, expect } from 'vitest';
import { piMessagesToHistoryAgentMessages } from '../message-mapper';

describe('piMessagesToHistoryAgentMessages', () => {
  it("carries a tool result's recorded execution time onto its tool_use block, and none when pi recorded none", () => {
    const out = piMessagesToHistoryAgentMessages([
      { role: 'assistant', content: [{ type: 'toolCall', id: 'timed', name: 'read', arguments: {} }, { type: 'toolCall', id: 'old', name: 'read', arguments: {} }] },
      { role: 'toolResult', toolCallId: 'timed', toolName: 'read', content: [{ type: 'text', text: 'a' }], durationMs: 1234 },
      { role: 'toolResult', toolCallId: 'old', toolName: 'read', content: [{ type: 'text', text: 'b' }] },
    ]);
    const [timed, old] = out[0]!.contentBlocks;
    expect(timed).toMatchObject({ type: 'tool_use', id: 'timed', durationMs: 1234 });
    expect(old).not.toHaveProperty('durationMs');
  });

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

  it('keeps a user turn\'s image parts as image blocks, dropping unsupported media types', () => {
    const png = { type: 'image', data: 'AAAA', mimeType: 'image/png' };
    const messages = [
      { role: 'user', content: [{ type: 'text', text: 'look' }, png, { type: 'image', data: 'BBBB', mimeType: 'image/bmp' }] },
      { role: 'user', content: [png] },
    ];
    const block = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } };
    expect(piMessagesToHistoryAgentMessages(messages)).toEqual([
      { role: 'user', contentBlocks: [{ type: 'text', text: 'look' }, block] },
      { role: 'user', contentBlocks: [block] },
    ]);
  });

  it("carries a tool result's details as its block's metadata, so a sealed or reloaded card keeps an edit's patch", () => {
    const patch = '--- a.ts\n+++ a.ts\n@@ -120,1 +120,1 @@\n-old\n+new\n';
    const messages = [
      { role: 'assistant', content: [{ type: 'toolCall', id: 'tc1', name: 'Edit', arguments: { file_path: '/a.ts', old_string: 'old', new_string: 'new' } }] },
      { role: 'toolResult', toolCallId: 'tc1', toolName: 'Edit', content: [{ type: 'text', text: 'ok' }], details: { patch, firstChangedLine: 120 } },
    ];

    const [assistant] = piMessagesToHistoryAgentMessages(messages);

    expect(assistant!.contentBlocks[0]).toMatchObject({ type: 'tool_use', id: 'tc1', metadata: { patch, editLineNumber: 120 } });
  });

  it('marks a successful tool result that carries images with imageCount, never a failed or text-only one', () => {
    const png = { type: 'image', data: 'AAAA', mimeType: 'image/png' };
    const messages = [
      { role: 'assistant', content: [
        { type: 'toolCall', id: 'img', name: 'read', arguments: { path: '/a.png' } },
        { type: 'toolCall', id: 'text', name: 'read', arguments: { path: '/a.ts' } },
        { type: 'toolCall', id: 'fail', name: 'read', arguments: { path: '/b.png' } },
      ] },
      { role: 'toolResult', toolCallId: 'img', toolName: 'read', content: [{ type: 'text', text: 'Read image file [image/png]' }, png, png] },
      { role: 'toolResult', toolCallId: 'text', toolName: 'read', content: [{ type: 'text', text: 'code' }] },
      { role: 'toolResult', toolCallId: 'fail', toolName: 'read', content: [png], isError: true },
    ];
    const [img, text, fail] = piMessagesToHistoryAgentMessages(messages)[0]!.contentBlocks;
    expect(img).toMatchObject({ id: 'img', result: 'Read image file [image/png]', imageCount: 2 });
    expect(text).not.toHaveProperty('imageCount');
    expect(fail).not.toHaveProperty('imageCount');
    expect(JSON.stringify(piMessagesToHistoryAgentMessages(messages))).not.toContain('AAAA');
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

describe('piMessagesToHistoryAgentMessages: a failed model call', () => {
  it('maps the text a failed call streamed and then its error, as the live card showed them', () => {
    const out = piMessagesToHistoryAgentMessages([
      { role: 'assistant', content: [{ type: 'text', text: 'Now I will' }], stopReason: 'error', errorMessage: '529 overloaded_error' },
    ]);
    expect(out).toEqual([
      { role: 'assistant', contentBlocks: [{ type: 'text', text: 'Now I will' }] },
      { role: 'error', contentBlocks: [{ type: 'text', text: '529 overloaded_error' }] },
    ]);
  });

  it('maps the error of a failed call that streamed nothing, and names an unknown one as the live card does', () => {
    const out = piMessagesToHistoryAgentMessages([{ role: 'assistant', content: [], stopReason: 'error' }]);
    expect(out).toEqual([{ role: 'error', contentBlocks: [{ type: 'text', text: 'Unknown error' }] }]);
  });

  it('maps no error for an aborted call', () => {
    expect(piMessagesToHistoryAgentMessages([{ role: 'assistant', content: [], stopReason: 'aborted', errorMessage: 'Request was aborted' }])).toEqual([]);
  });

  // pi returns before executing any tool of an errored or aborted message (agent-loop.js:143).
  it('marks the tool calls of a failed call failed and those of an aborted call stopped', () => {
    const call = (id: string) => ({ type: 'toolCall', id, name: 'bash', arguments: { command: 'ls' } });
    const out = piMessagesToHistoryAgentMessages([
      { role: 'assistant', content: [call('failed-call')], stopReason: 'error', errorMessage: 'terminated' },
      { role: 'assistant', content: [call('aborted-call')], stopReason: 'aborted', errorMessage: 'Request was aborted' },
    ]);
    expect(out.flatMap((m) => m.contentBlocks).filter((b) => b.type === 'tool_use')).toEqual([
      expect.objectContaining({ id: 'failed-call', abandoned: 'failed' }),
      expect.objectContaining({ id: 'aborted-call', abandoned: 'stopped' }),
    ]);
  });

  // pi finalizes the call it was running and starts none after it (agent-loop.js:402-404, :429-431, :449-451),
  // then drains steers (:186) and makes the next call under the aborted signal, which ends aborted (:141-152);
  // a request setup the signal rejects first ends it on an error stop instead (pi-ai lazy.js:41-44).
  it('marks the calls an abort skipped in a tool batch stopped when the aborted call follows', () => {
    const call = (id: string) => ({ type: 'toolCall', id, name: 'bash', arguments: { command: 'ls' } });
    const out = piMessagesToHistoryAgentMessages([
      { role: 'assistant', content: [call('ran'), call('skipped')], stopReason: 'toolUse' },
      { role: 'toolResult', toolCallId: 'ran', content: [{ type: 'text', text: 'Operation aborted' }], isError: true },
      { role: 'user', content: [{ type: 'text', text: 'steer' }] },
      { role: 'assistant', content: [], stopReason: 'aborted', errorMessage: 'Request was aborted' },
    ]);
    const tools = out.flatMap((m) => m.contentBlocks).filter((b) => b.type === 'tool_use');
    expect(tools).toEqual([
      expect.objectContaining({ id: 'ran', result: 'Operation aborted', isError: true }),
      expect.objectContaining({ id: 'skipped', abandoned: 'stopped' }),
    ]);
    expect(tools[0]).not.toHaveProperty('abandoned');
  });

  // The nested turn-stopped record names a call the abort settled before `execute` (agent-loop.js:500-504), which has no durationMs.
  it('marks a call the record names as stopped without the result pi wrote, and keeps one pi executed', () => {
    const call = (id: string) => ({ type: 'toolCall', id, name: 'bash', arguments: { command: 'ls' } });
    const out = piMessagesToHistoryAgentMessages([
      { role: 'assistant', content: [call('gated'), call('ran')], stopReason: 'toolUse' },
      { role: 'toolResult', toolCallId: 'gated', content: [{ type: 'text', text: 'Operation aborted' }], details: {}, isError: true },
      { role: 'toolResult', toolCallId: 'ran', content: [{ type: 'text', text: 'Command aborted' }], details: { damoclesCancelled: true }, isError: true, durationMs: 40 },
    ], new Set(['gated', 'ran']));
    const tools = out.flatMap((m) => m.contentBlocks).filter((b) => b.type === 'tool_use');
    expect(tools[0]).toEqual({ type: 'tool_use', id: 'gated', name: 'Bash', input: { command: 'ls' }, abandoned: 'stopped' });
    expect(tools[1]).toMatchObject({ id: 'ran', result: 'Command aborted', durationMs: 40 });
    expect(tools[1]).not.toHaveProperty('abandoned');
  });

  it('leaves a call with no result unmarked when no aborted call follows', () => {
    const call = (id: string) => ({ type: 'toolCall', id, name: 'bash', arguments: { command: 'ls' } });
    const out = piMessagesToHistoryAgentMessages([
      { role: 'assistant', content: [call('ran'), call('unknown')], stopReason: 'toolUse' },
      { role: 'toolResult', toolCallId: 'ran', content: [{ type: 'text', text: 'ok' }] },
    ]);
    expect(out.flatMap((m) => m.contentBlocks).find((b) => b.type === 'tool_use' && b.id === 'unknown')).not.toHaveProperty('abandoned');
  });
});

describe('piMessagesToHistoryAgentMessages: a Stop\'s wind-down error', () => {
  const call = (id: string) => ({ type: 'toolCall', id, name: 'bash', arguments: { command: 'sleep 20' } });
  const batch = { role: 'assistant', content: [call('ran'), call('skipped')], stopReason: 'toolUse' };
  const killed = { role: 'toolResult', toolCallId: 'ran', content: [{ type: 'text', text: 'Command aborted' }], details: { damoclesCancelled: true }, isError: true, durationMs: 700 };
  // pi-ai's lazy stream ends a request setup the aborted signal rejected on an error stop (lazy.js:41-44 in pi-ai 1.1.0).
  const windDown = { role: 'assistant', content: [], stopReason: 'error', errorMessage: 'This operation was aborted' };

  it('maps no error for a wind-down error and stops the calls the abort skipped, as for an aborted stop', () => {
    const out = piMessagesToHistoryAgentMessages([batch, killed, windDown], new Set(), new Set([windDown]));

    expect(out.map((m) => m.role)).toEqual(['assistant']);
    expect(out[0]!.contentBlocks).toEqual([
      expect.objectContaining({ id: 'ran', result: 'Command aborted', durationMs: 700 }),
      expect.objectContaining({ id: 'skipped', abandoned: 'stopped' }),
    ]);
  });

  it('marks the calls a wind-down error named as stopped', () => {
    const named = { ...windDown, content: [call('never-ran')] };
    const out = piMessagesToHistoryAgentMessages([named], new Set(), new Set([named]));
    expect(out).toEqual([{ role: 'assistant', contentBlocks: [expect.objectContaining({ id: 'never-ran', abandoned: 'stopped' })] }]);
  });

  it('keeps the error of a file written before the record existed, and of a failure the record does not name', () => {
    expect(piMessagesToHistoryAgentMessages([batch, killed, windDown]).map((m) => m.role)).toEqual(['assistant', 'error']);
    const failure = { role: 'assistant', content: [], stopReason: 'error', errorMessage: '529 overloaded_error' };
    expect(piMessagesToHistoryAgentMessages([failure, windDown], new Set(), new Set([windDown]))).toEqual([
      { role: 'error', contentBlocks: [{ type: 'text', text: '529 overloaded_error' }] },
    ]);
  });
});
