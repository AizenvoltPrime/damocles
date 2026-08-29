import { describe, it, expect, beforeEach } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import type { ToolCall } from '@shared/types/session';
import { CANCELLED_TOOL_DETAIL_KEY } from '@shared/types/session';
import type { TeamAgentContentBlock } from '@shared/types/team';
import { useTeamStore } from '../useTeamStore';

/**
 * The team agent transcript feeds `ToolCallCard`, the same component the main session and the subagent
 * overlays render. That is why these assert the shared `ToolCall` shape by name and by value: a card
 * keyed off `Bash` renders a generic icon for `bash`, and reads `input.command`, never a raw string.
 */

const AGENT = 'agent-1';

type TeamStore = ReturnType<typeof useTeamStore>;

function toolUse(id: string, name: string, input: unknown): TeamAgentContentBlock {
  return { type: 'tool_use', id, name, input };
}

function toolResult(
  id: string,
  content: string,
  extra?: { is_error?: boolean; metadata?: Record<string, unknown> },
): TeamAgentContentBlock {
  return { type: 'tool_result', tool_use_id: id, content, ...extra };
}

/** Fails loudly rather than letting an undefined element propagate into a comparison that passes. */
function toolCallById(store: TeamStore, agentId: string, toolUseId: string): ToolCall {
  for (const m of store.agentMessages[agentId] ?? []) {
    const found = m.toolCalls?.find((t) => t.id === toolUseId);
    if (found) return found;
  }
  throw new Error(`expected a tool call '${toolUseId}' on agent '${agentId}', found none`);
}

describe('useTeamStore.handleAgentAssistant tool calls', () => {
  beforeEach(() => setActivePinia(createPinia()));

  it('turns a tool_use block into a running ToolCall carrying an object input', () => {
    const store = useTeamStore();
    store.handleAgentAssistant(AGENT, 'msg-1', [
      { type: 'text', text: 'listing the tree' },
      toolUse('tc-1', 'Bash', { command: 'ls -la' }),
    ], 1);

    const call = toolCallById(store, AGENT, 'tc-1');
    expect(call.name).toBe('Bash');
    expect(call.status).toBe('running');
    expect(call.input).toEqual({ command: 'ls -la' });
    expect(typeof call.input).toBe('object');
    expect(call.result).toBeUndefined();
  });

  it('coerces a non-object tool input to an empty object', () => {
    // ToolCallCard indexes `input` by key, so a raw string reaching it throws at render.
    const store = useTeamStore();
    store.handleAgentAssistant(AGENT, 'msg-1', [toolUse('tc-1', 'Bash', 'ls -la')], 1);

    expect(toolCallById(store, AGENT, 'tc-1').input).toEqual({});
  });

  it('keeps the assistant text and thinking alongside the tool call', () => {
    const store = useTeamStore();
    store.handleAgentAssistant(AGENT, 'msg-1', [
      { type: 'thinking', thinking: 'which file' },
      { type: 'text', text: 'reading it' },
      toolUse('tc-1', 'Read', { file_path: 'c:/x.ts' }),
    ], 7);

    const msg = store.agentMessages[AGENT]?.[0];
    expect(msg?.content).toBe('reading it');
    expect(msg?.thinking).toBe('which file');
    expect(msg?.toolCalls).toHaveLength(1);
  });
});

describe('useTeamStore.handleAgentToolResult', () => {
  beforeEach(() => setActivePinia(createPinia()));

  it('completes the running call with the result text', () => {
    const store = useTeamStore();
    store.handleAgentAssistant(AGENT, 'msg-1', [toolUse('tc-1', 'Bash', { command: 'ls' })], 1);
    store.handleAgentToolResult(AGENT, 'tc-1', 'a.ts\nb.ts', false);

    const call = toolCallById(store, AGENT, 'tc-1');
    expect(call.status).toBe('completed');
    expect(call.result).toBe('a.ts\nb.ts');
    expect(call.isError).toBe(false);
  });

  it('fails the running call when the result is an error', () => {
    const store = useTeamStore();
    store.handleAgentAssistant(AGENT, 'msg-1', [toolUse('tc-1', 'Bash', { command: 'nope' })], 1);
    store.handleAgentToolResult(AGENT, 'tc-1', 'command not found', true);

    const call = toolCallById(store, AGENT, 'tc-1');
    expect(call.status).toBe('failed');
    expect(call.result).toBe('command not found');
    expect(call.isError).toBe(true);
  });

  it('resolves only the matching call and leaves its siblings running', () => {
    const store = useTeamStore();
    store.handleAgentAssistant(AGENT, 'msg-1', [
      toolUse('tc-1', 'Bash', { command: 'ls' }),
      toolUse('tc-2', 'Read', { file_path: 'c:/x.ts' }),
    ], 1);
    store.handleAgentToolResult(AGENT, 'tc-2', 'file body', false);

    expect(toolCallById(store, AGENT, 'tc-1').status).toBe('running');
    expect(toolCallById(store, AGENT, 'tc-2').status).toBe('completed');
  });

  it('no-ops for an agent with no transcript', () => {
    const store = useTeamStore();
    expect(() => store.handleAgentToolResult('nobody', 'tc-1', 'out', false)).not.toThrow();
    expect(store.agentMessages['nobody']).toBeUndefined();
  });
});

describe('useTeamStore.handleAgentToolProgress', () => {
  beforeEach(() => setActivePinia(createPinia()));

  function startBashCall(store: TeamStore): void {
    store.handleAgentAssistant(AGENT, 'msg-1', [toolUse('tc-1', 'Bash', { command: 'npm test' })], 1);
  }

  it('puts the frame on the running call', () => {
    const store = useTeamStore();
    startBashCall(store);
    store.handleAgentToolProgress(AGENT, 'tc-1', 'RUN  src/a.test.ts', true);

    const call = toolCallById(store, AGENT, 'tc-1');
    expect(call.liveOutput).toBe('RUN  src/a.test.ts');
    expect(call.liveOutputTruncated).toBe(true);
    expect(call.status).toBe('running');
  });

  it('stores an empty first frame as the empty string, never as undefined', () => {
    // LiveOutputPane gates on `liveOutput !== undefined`, so an empty frame is what shows the waiting state.
    const store = useTeamStore();
    startBashCall(store);
    store.handleAgentToolProgress(AGENT, 'tc-1', '');

    const call = toolCallById(store, AGENT, 'tc-1');
    expect(call.liveOutput).toBe('');
    expect(call.liveOutput).not.toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(call, 'liveOutput')).toBe(true);
  });

  it('replaces the previous frame rather than appending to it', () => {
    // Each frame is a full snapshot of pi's accumulator, not a delta.
    const store = useTeamStore();
    startBashCall(store);
    store.handleAgentToolProgress(AGENT, 'tc-1', 'line one');
    store.handleAgentToolProgress(AGENT, 'tc-1', 'line one\nline two');

    expect(toolCallById(store, AGENT, 'tc-1').liveOutput).toBe('line one\nline two');
  });

  it('drops both live keys when the call completes', () => {
    // exactOptionalPropertyTypes forbids assigning undefined, so the clear rebuilds without the keys.
    const store = useTeamStore();
    startBashCall(store);
    store.handleAgentToolProgress(AGENT, 'tc-1', 'partial output', true);
    store.handleAgentToolResult(AGENT, 'tc-1', 'final output', false);

    const call = toolCallById(store, AGENT, 'tc-1');
    expect(call.status).toBe('completed');
    expect(call.result).toBe('final output');
    expect(call.liveOutput).toBeUndefined();
    expect(call.liveOutputTruncated).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(call, 'liveOutput')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(call, 'liveOutputTruncated')).toBe(false);
  });

  it('drops both live keys when the call fails', () => {
    const store = useTeamStore();
    startBashCall(store);
    store.handleAgentToolProgress(AGENT, 'tc-1', 'partial output', true);
    store.handleAgentToolResult(AGENT, 'tc-1', 'exit 1', true);

    const call = toolCallById(store, AGENT, 'tc-1');
    expect(call.status).toBe('failed');
    expect(Object.prototype.hasOwnProperty.call(call, 'liveOutput')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(call, 'liveOutputTruncated')).toBe(false);
  });

  it('no-ops for an unknown agent and for an unknown tool id', () => {
    const store = useTeamStore();
    startBashCall(store);
    expect(() => store.handleAgentToolProgress('other-agent', 'tc-1', 'x')).not.toThrow();
    store.handleAgentToolProgress(AGENT, 'tc-missing', 'x');

    expect(store.agentMessages['other-agent']).toBeUndefined();
    expect(toolCallById(store, AGENT, 'tc-1').liveOutput).toBeUndefined();
  });
});

describe('useTeamStore.handleAgentDataLoaded', () => {
  beforeEach(() => setActivePinia(createPinia()));

  it('restores a historical tool call with its persisted result as completed', () => {
    const store = useTeamStore();
    store.handleAgentDataLoaded(AGENT, [
      [{ type: 'text', text: 'do the task' }],
      [{ type: 'text', text: 'running it' }, toolUse('tc-1', 'Bash', { command: 'ls' })],
      [toolResult('tc-1', 'a.ts\nb.ts')],
    ]);

    const call = toolCallById(store, AGENT, 'tc-1');
    expect(call.name).toBe('Bash');
    expect(call.status).toBe('completed');
    expect(call.input).toEqual({ command: 'ls' });
    expect(call.result).toBe('a.ts\nb.ts');
    expect(call.isError).toBe(false);
  });

  it('restores an errored call as failed rather than as a success', () => {
    const store = useTeamStore();
    store.handleAgentDataLoaded(AGENT, [
      [toolUse('tc-1', 'Bash', { command: 'nope' })],
      [{ type: 'tool_result', tool_use_id: 'tc-1', content: 'command not found', is_error: true }],
    ]);

    const call = toolCallById(store, AGENT, 'tc-1');
    expect(call.status).toBe('failed');
    expect(call.result).toBe('command not found');
    expect(call.isError).toBe(true);
  });

  it('restores a user-cancelled call as cancelled, from the marker on the persisted metadata', () => {
    const store = useTeamStore();
    store.handleAgentDataLoaded(AGENT, [
      [toolUse('tc-1', 'Bash', { command: 'sleep 300' })],
      [toolResult('tc-1', 'partial output', { metadata: { [CANCELLED_TOOL_DETAIL_KEY]: true } })],
    ]);

    const call = toolCallById(store, AGENT, 'tc-1');
    expect(call.status).toBe('cancelled');
    expect(call.metadata).toEqual({ [CANCELLED_TOOL_DETAIL_KEY]: true });
  });

  it('marks a call with no persisted result unrecorded instead of claiming it succeeded', () => {
    // Every team log written before results were persisted lands here, as does a team killed mid-call.
    const store = useTeamStore();
    store.handleAgentDataLoaded(AGENT, [[toolUse('tc-1', 'Bash', { command: 'ls' })]]);

    const call = toolCallById(store, AGENT, 'tc-1');
    expect(call.status).toBe('unrecorded');
    expect(call.result).toBeUndefined();
  });

  it('never restores such a call to a pre-terminal status, which renders it as still running', () => {
    // `pending` and `running` both put a live control on a card for a tool that ended long ago.
    const store = useTeamStore();
    store.handleAgentDataLoaded(AGENT, [[toolUse('tc-1', 'Bash', { command: 'ls' })]]);

    const status = toolCallById(store, AGENT, 'tc-1').status;
    expect(status).not.toBe('pending');
    expect(status).not.toBe('running');
    expect(status).not.toBe('completed');
  });

  it('applies each result to the call it names when one turn holds several', () => {
    const store = useTeamStore();
    store.handleAgentDataLoaded(AGENT, [
      [
        toolUse('tc-1', 'Bash', { command: 'ls' }),
        toolUse('tc-2', 'Read', { file_path: 'c:/x.ts' }),
        toolUse('tc-3', 'Bash', { command: 'nope' }),
      ],
      [toolResult('tc-2', 'file body')],
      [toolResult('tc-3', 'command not found', { is_error: true })],
    ]);

    expect(toolCallById(store, AGENT, 'tc-1').status).toBe('unrecorded');
    const read = toolCallById(store, AGENT, 'tc-2');
    expect(read.status).toBe('completed');
    expect(read.result).toBe('file body');
    expect(toolCallById(store, AGENT, 'tc-3').status).toBe('failed');
  });

  it('renders a result turn on its call rather than as a message of its own', () => {
    const store = useTeamStore();
    store.handleAgentDataLoaded(AGENT, [
      [toolUse('tc-1', 'Bash', { command: 'ls' })],
      [toolResult('tc-1', 'a.ts')],
    ]);

    expect(store.agentMessages[AGENT]).toHaveLength(1);
  });

  it('coerces a scalar input on a historical entry to an empty object', () => {
    // Team logs written before the extension normalized are not migrated, so this path meets junk input.
    const store = useTeamStore();
    store.handleAgentDataLoaded(AGENT, [[toolUse('tc-1', 'bash', 'ls')]]);

    expect(toolCallById(store, AGENT, 'tc-1').input).toEqual({});
  });
});

describe('useTeamStore.handleAgentToolProgress after the result', () => {
  beforeEach(() => setActivePinia(createPinia()));

  function seedRunningCall(store: TeamStore): void {
    store.handleAgentAssistant(AGENT, 'msg-1', [toolUse('tc-1', 'Bash', { command: 'sleep 300' })], 1);
  }

  it('drops a progress frame that arrives after the call was resolved', () => {
    const store = useTeamStore();
    seedRunningCall(store);
    store.handleAgentToolProgress(AGENT, 'tc-1', 'half a line', false);
    store.handleAgentToolResult(AGENT, 'tc-1', 'all of it');

    store.handleAgentToolProgress(AGENT, 'tc-1', 'a frame from the far side of the result', false);

    const call = toolCallById(store, AGENT, 'tc-1');
    expect(call.status).toBe('completed');
    expect(call.liveOutput).toBeUndefined();
    expect(call.liveOutputTruncated).toBeUndefined();
  });

  it('drops a progress frame after a failure too', () => {
    const store = useTeamStore();
    seedRunningCall(store);
    store.handleAgentToolResult(AGENT, 'tc-1', 'boom', true);

    store.handleAgentToolProgress(AGENT, 'tc-1', 'late output', false);

    expect(toolCallById(store, AGENT, 'tc-1').liveOutput).toBeUndefined();
  });

  it('still applies a progress frame while the call is running', () => {
    const store = useTeamStore();
    seedRunningCall(store);

    store.handleAgentToolProgress(AGENT, 'tc-1', 'still going', true);

    const call = toolCallById(store, AGENT, 'tc-1');
    expect(call.liveOutput).toBe('still going');
    expect(call.liveOutputTruncated).toBe(true);
  });
});
