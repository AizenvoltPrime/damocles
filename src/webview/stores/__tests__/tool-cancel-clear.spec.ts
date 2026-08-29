import { describe, it, expect, beforeEach } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import type { ToolCall } from '@shared/types/session';
import { useStreamingStore } from '../useStreamingStore';
import { useSubagentStore } from '../useSubagentStore';
import { useTeamStore } from '../useTeamStore';
import { at, defined } from '@/__tests__/helpers';

/**
 * Clearing the optimistic stopping flag has to drop the key, not set it to undefined, because a later
 * spread would otherwise carry an explicit `cancelRequested: undefined` back onto the call and
 * `exactOptionalPropertyTypes` rejects the assignment that produces it.
 */

const RUNNING: Omit<ToolCall, 'status'> = { id: 't-1', name: 'Bash', input: { command: 'sleep 300' } };

function hasKey(tool: ToolCall): boolean {
  return Object.hasOwn(tool, 'cancelRequested');
}

beforeEach(() => setActivePinia(createPinia()));

describe('the streaming store', () => {
  function seed(): ReturnType<typeof useStreamingStore> {
    const store = useStreamingStore();
    store.addToolCall({ ...RUNNING });
    store.updateToolStatus('t-1', 'running');
    store.markToolCancelRequested('t-1');
    return store;
  }

  function tool(store: ReturnType<typeof useStreamingStore>): ToolCall {
    return defined(defined(at(store.messages, 0).toolCalls, 'toolCalls')[0], 't-1');
  }

  it('drops the key rather than leaving an undefined behind', () => {
    const store = seed();
    expect(tool(store).cancelRequested).toBe(true);

    store.clearToolCancelRequested('t-1');

    expect(hasKey(tool(store))).toBe(false);
  });

  it('leaves the call otherwise untouched', () => {
    const store = seed();
    store.clearToolCancelRequested('t-1');

    expect(tool(store).status).toBe('running');
    expect(tool(store).name).toBe('Bash');
  });

  it('rebuilds the owning message so a card watching it re-renders', () => {
    const store = seed();
    const before = at(store.messages, 0);

    store.clearToolCancelRequested('t-1');

    expect(at(store.messages, 0)).not.toBe(before);
  });

  it('does nothing for a tool id it does not hold', () => {
    const store = seed();
    store.clearToolCancelRequested('t-absent');

    expect(tool(store).cancelRequested).toBe(true);
  });
});

describe('the subagent store', () => {
  function seed(): ReturnType<typeof useSubagentStore> {
    const store = useSubagentStore();
    store.registerAgentTool('sub-1', { description: 'work', prompt: 'go' });
    store.addToolCallToSubagent('sub-1', { ...RUNNING, status: 'running' });
    expect(store.markSubagentToolCancelRequested('t-1')).toBe(true);
    return store;
  }

  function tool(store: ReturnType<typeof useSubagentStore>): ToolCall {
    return defined(defined(store.getSubagent('sub-1'), 'sub-1').toolCalls[0], 't-1');
  }

  it('drops the key rather than leaving an undefined behind', () => {
    const store = seed();
    expect(tool(store).cancelRequested).toBe(true);

    expect(store.clearSubagentToolCancelRequested('t-1')).toBe(true);

    expect(hasKey(tool(store))).toBe(false);
  });

  it('reports a miss for a tool id no agent holds', () => {
    const store = seed();

    expect(store.clearSubagentToolCancelRequested('t-absent')).toBe(false);
    expect(tool(store).cancelRequested).toBe(true);
  });
});

describe('the team store', () => {
  function seed(): ReturnType<typeof useTeamStore> {
    const store = useTeamStore();
    store.agentMessages = {
      'agent-1': [{
        id: 'msg-1',
        role: 'assistant',
        content: '',
        toolCalls: [{ ...RUNNING, status: 'running', cancelRequested: true }],
        timestamp: 1,
      }],
    };
    return store;
  }

  function tool(store: ReturnType<typeof useTeamStore>): ToolCall {
    const msgs = defined(store.agentMessages['agent-1'], 'agent messages');
    return defined(defined(at(msgs, 0).toolCalls, 'toolCalls')[0], 't-1');
  }

  it('drops the key rather than leaving an undefined behind', () => {
    const store = seed();

    expect(store.clearAgentToolCancelRequested('t-1')).toBe(true);

    expect(hasKey(tool(store))).toBe(false);
  });

  it('reports a miss for a tool id no agent holds', () => {
    const store = seed();

    expect(store.clearAgentToolCancelRequested('t-absent')).toBe(false);
    expect(tool(store).cancelRequested).toBe(true);
  });

  it('leaves the other calls in the same message alone', () => {
    const store = useTeamStore();
    store.agentMessages = {
      'agent-1': [{
        id: 'msg-1',
        role: 'assistant',
        content: '',
        toolCalls: [
          { ...RUNNING, status: 'running', cancelRequested: true },
          { id: 't-2', name: 'Bash', input: {}, status: 'running', cancelRequested: true },
        ],
        timestamp: 1,
      }],
    };

    store.clearAgentToolCancelRequested('t-1');

    const msgs = defined(store.agentMessages['agent-1'], 'agent messages');
    const calls = defined(at(msgs, 0).toolCalls, 'toolCalls');
    expect(hasKey(defined(calls[0], 't-1'))).toBe(false);
    expect(defined(calls[1], 't-2').cancelRequested).toBe(true);
  });
});
