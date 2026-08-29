// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import type { ChatMessage, ToolCall } from '@shared/types/session';
import type { SubagentState } from '@shared/types/subagents';
import { useExpandedTool } from '../useExpandedTool';
import { useUIStore } from '@/stores/useUIStore';
import { useStreamingStore } from '@/stores/useStreamingStore';
import { useSubagentStore } from '@/stores/useSubagentStore';
import { useTeamStore, type AgentChatMessage } from '@/stores/useTeamStore';
import { defined } from '@/__tests__/helpers';

/**
 * The resolver reads one store, the one named by `expandedToolSource`, and never the other two.
 *
 * The bug this replaces resolved every expanded tool id against the main-session transcript only, so a
 * tool card clicked inside a subagent overlay set an id that resolved to `undefined` and rendered
 * nothing. Scanning all three stores instead would trade that dead click for a worse failure: two calls
 * from different runs can carry the same id, and the wrong one would open. Several tests below plant a
 * same-id decoy in a store the source does not name, so an "search everywhere" resolver fails them.
 */

function tool(id: string, name: string): ToolCall {
  return { id, name, input: {}, status: 'completed' };
}

function message(id: string, toolCalls: ToolCall[]): ChatMessage {
  return { id, role: 'assistant', content: '', toolCalls, timestamp: 1 };
}

function subagent(over: Partial<SubagentState> = {}): SubagentState {
  return {
    id: 'sub-1',
    agentType: 'general-purpose',
    description: 'a subagent',
    prompt: 'do the thing',
    status: 'running',
    startTime: 1,
    messages: [],
    toolCalls: [],
    messagesSealed: false,
    ...over,
  };
}

function agentMessage(id: string, toolCalls: ToolCall[]): AgentChatMessage {
  return { id, role: 'assistant', content: '', toolCalls, timestamp: 1 };
}

beforeEach(() => setActivePinia(createPinia()));

describe('resolving a tool call from the store its source names', () => {
  it('finds a session call in the main transcript', () => {
    useStreamingStore().messages = [message('m1', [tool('t-1', 'Read')])];
    useUIStore().expandTool('t-1', 'session');

    expect(defined(useExpandedTool().value).name).toBe('Read');
  });

  it('finds a subagent call that is still in the live tool list', () => {
    useSubagentStore().subagents = {
      'sub-1': subagent({ toolCalls: [tool('t-live', 'Bash')] }),
    };
    useUIStore().expandTool('t-live', 'subagent');

    expect(defined(useExpandedTool().value).name).toBe('Bash');
  });

  it('finds a subagent call that has already been folded into a subagent message', () => {
    // `updateSubagentToolMetadata` walks both collections, so a resolver that reads only the live
    // `toolCalls` array goes blind the moment a subagent's turn seals into `messages[].toolCalls`.
    useSubagentStore().subagents = {
      'sub-1': subagent({
        messagesSealed: true,
        toolCalls: [],
        messages: [message('sub-msg-0', [tool('t-sealed', 'Grep')])],
      }),
    };
    useUIStore().expandTool('t-sealed', 'subagent');

    expect(defined(useExpandedTool().value).name).toBe('Grep');
  });

  it('finds a team agent call in that agent transcript', () => {
    // The team arm resolves against `agentMessages` only: a TeamAgent carries no live toolCalls array.
    useTeamStore().agentMessages = {
      'agent-1': [agentMessage('am1', [tool('t-team', 'WebFetch')])],
    };
    useUIStore().expandTool('t-team', 'team');

    const resolved = defined(useExpandedTool().value);
    expect(resolved.id).toBe('t-team');
    expect(resolved.name).toBe('WebFetch');
  });

  it('resolves nothing while no tool is expanded', () => {
    useStreamingStore().messages = [message('m1', [tool('t-1', 'Read')])];

    expect(useExpandedTool().value).toBeUndefined();
  });
});

describe('refusing to resolve a matching id from a store the source does not name', () => {
  it('does not open a subagent call when the source is the session', () => {
    // Same id in both places, present only in the subagent store. A resolver that scans all three
    // stores returns the subagent call here and opens a tool the user never clicked.
    useStreamingStore().messages = [message('m1', [tool('t-other', 'Read')])];
    useSubagentStore().subagents = {
      'sub-1': subagent({ toolCalls: [tool('t-collision', 'Bash')] }),
    };
    useUIStore().expandTool('t-collision', 'session');

    expect(useExpandedTool().value).toBeUndefined();
  });

  it('does not open a session call when the source is a subagent', () => {
    useStreamingStore().messages = [message('m1', [tool('t-collision', 'Read')])];
    useSubagentStore().subagents = { 'sub-1': subagent({ toolCalls: [] }) };
    useUIStore().expandTool('t-collision', 'subagent');

    expect(useExpandedTool().value).toBeUndefined();
  });

  it('does not open a session call when the source is a team agent', () => {
    useStreamingStore().messages = [message('m1', [tool('t-collision', 'Read')])];
    useUIStore().expandTool('t-collision', 'team');

    expect(useExpandedTool().value).toBeUndefined();
  });
});

describe('losing the tool call when the collection that held it clears', () => {
  it('stops resolving a subagent call once the subagent state is gone', () => {
    // This is how the tool overlay unmounts itself: App.vue's v-if reads this computed, so `undefined`
    // is the teardown. The same id sits in the session transcript throughout, so adding a fallback that
    // keeps the overlay alive by searching another store fails this test, which is the point.
    const subagentStore = useSubagentStore();
    useStreamingStore().messages = [message('m1', [tool('t-vanishing', 'Read')])];
    subagentStore.subagents = {
      'sub-1': subagent({ toolCalls: [tool('t-vanishing', 'Bash')] }),
    };
    useUIStore().expandTool('t-vanishing', 'subagent');

    const expandedTool = useExpandedTool();
    expect(defined(expandedTool.value).name).toBe('Bash');

    subagentStore.subagents = {};

    expect(expandedTool.value).toBeUndefined();
    // The id is deliberately left set. Resolution, not the id, is what closes the overlay.
    expect(useUIStore().expandedToolId).toBe('t-vanishing');
  });

  it('stops resolving a session call once the transcript clears', () => {
    const streamingStore = useStreamingStore();
    streamingStore.messages = [message('m1', [tool('t-vanishing', 'Read')])];
    useSubagentStore().subagents = {
      'sub-1': subagent({ toolCalls: [tool('t-vanishing', 'Bash')] }),
    };
    useUIStore().expandTool('t-vanishing', 'session');

    const expandedTool = useExpandedTool();
    expect(defined(expandedTool.value).name).toBe('Read');

    streamingStore.messages = [];

    expect(expandedTool.value).toBeUndefined();
  });
});

describe('collapsing a tool', () => {
  it('clears both the id and the source', () => {
    const uiStore = useUIStore();
    useStreamingStore().messages = [message('m1', [tool('t-1', 'Read')])];
    uiStore.expandTool('t-1', 'session');

    const expandedTool = useExpandedTool();
    expect(expandedTool.value).toBeDefined();

    uiStore.collapseTool();

    expect(uiStore.expandedToolId).toBeNull();
    expect(uiStore.expandedToolSource).toBeNull();
    expect(expandedTool.value).toBeUndefined();
  });
});
