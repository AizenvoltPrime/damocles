import { describe, it, expect, beforeEach } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { CANCELLED_TOOL_DETAIL_KEY } from '@shared/types/session';
import type { ToolCall } from '@shared/types/session';
import type { ContentBlock } from '@shared/types/content';
import { useStreamingStore } from '../useStreamingStore';
import { useSubagentStore } from '../useSubagentStore';
import { useTeamStore } from '../useTeamStore';
import { at, defined } from '@/__tests__/helpers';

/**
 * A per-call cancel returns a NORMAL tool result, so the extension marks it on the result's `details`
 * and the completion still arrives as `toolCompleted`. The marker and the completion are two separate
 * messages and nothing orders them, so every case here runs twice: marker first, then completion, and
 * completion first, then marker. A store that only re-derived on one of the two paths passes half of
 * these and ships a green checkmark on a cancelled command.
 */

const CANCELLED_METADATA = { [CANCELLED_TOOL_DETAIL_KEY]: true };

function toolOf(store: ReturnType<typeof useStreamingStore>, id: string): ToolCall {
  const calls = defined(at(store.messages, 0).toolCalls, 'toolCalls');
  return defined(calls.find((t) => t.id === id), id);
}

beforeEach(() => setActivePinia(createPinia()));

describe('chat store cancelled derivation', () => {
  function seedRunningTool(): ReturnType<typeof useStreamingStore> {
    const store = useStreamingStore();
    store.addToolCall({ id: 't-1', name: 'Bash', input: { command: 'sleep 300' } });
    store.updateToolStatus('t-1', 'running');
    store.markToolCancelRequested('t-1');
    return store;
  }

  it('flips a completed call to cancelled when the marker arrived first', () => {
    const store = seedRunningTool();

    store.updateToolMetadata('t-1', CANCELLED_METADATA);
    store.updateToolStatus('t-1', 'completed', { result: 'partial output' });

    expect(toolOf(store, 't-1').status).toBe('cancelled');
  });

  it('flips a completed call to cancelled when the marker arrived second', () => {
    const store = seedRunningTool();

    store.updateToolStatus('t-1', 'completed', { result: 'partial output' });
    store.updateToolMetadata('t-1', CANCELLED_METADATA);

    expect(toolOf(store, 't-1').status).toBe('cancelled');
  });

  it('clears the optimistic stopping flag and the live output at the cancelled status', () => {
    const store = seedRunningTool();
    store.updateToolLiveOutput('t-1', 'half a line', false);

    store.updateToolMetadata('t-1', CANCELLED_METADATA);
    store.updateToolStatus('t-1', 'completed');

    const tool = toolOf(store, 't-1');
    expect(tool.status).toBe('cancelled');
    expect(tool.cancelRequested).toBeUndefined();
    expect(tool.liveOutput).toBeUndefined();
  });

  it('leaves an uncancelled completed call alone', () => {
    const store = seedRunningTool();

    store.updateToolMetadata('t-1', { fullOutputPath: 'c:/tmp/out.txt' });
    store.updateToolStatus('t-1', 'completed', { result: 'all of it' });

    expect(toolOf(store, 't-1').status).toBe('completed');
  });

  it('does not read a marker that is not literally true', () => {
    const store = seedRunningTool();

    store.updateToolMetadata('t-1', { [CANCELLED_TOOL_DETAIL_KEY]: 'yes' });
    store.updateToolStatus('t-1', 'completed');

    expect(toolOf(store, 't-1').status).toBe('completed');
  });

  it('leaves a pre-terminal status alone even with the marker present', () => {
    const store = seedRunningTool();

    store.updateToolMetadata('t-1', CANCELLED_METADATA);

    expect(toolOf(store, 't-1').status).toBe('running');
  });

  it('carries the derivation through the caches when both halves land before the block does', () => {
    // A status and a metadata frame can both arrive before the assistant block that owns the call.
    const store = useStreamingStore();

    store.updateToolMetadata('t-9', CANCELLED_METADATA);
    store.updateToolStatus('t-9', 'completed', { result: 'partial' });
    store.addToolCall({ id: 't-9', name: 'Bash', input: { command: 'sleep 300' } });

    expect(toolOf(store, 't-9').status).toBe('cancelled');
  });

  it('survives the authoritative assistant message that arrives after the tool ended', () => {
    // The adapter re-emits the sealed assistant message, which rebuilds the tool call from its content
    // block. That rebuild carries no metadata, so a merge that took its status verbatim dropped the
    // card back to completed even though the marker was still sitting on it.
    const store = useStreamingStore();
    store.addToolCall({ id: 't-1', name: 'Bash', input: { command: 'sleep 300' } });
    store.updateToolStatus('t-1', 'running');
    store.updateToolStatus('t-1', 'completed', { result: 'partial' });
    store.updateToolMetadata('t-1', CANCELLED_METADATA);

    const blocks: ContentBlock[] = [{ type: 'tool_use', id: 't-1', name: 'Bash', input: { command: 'sleep 300' } }];
    store.updateStreamingMessage({ toolCalls: store.extractToolCalls(blocks) });

    expect(toolOf(store, 't-1').status).toBe('cancelled');
  });

  it('keeps a cancelled card cancelled when the block arrived as a content block and a completion follows', () => {
    // The card built from a content block carries no metadata of its own unless the cache hands it
    // over, and the next status write re-derives from the call's own metadata.
    const store = useStreamingStore();
    store.updateToolMetadata('t-9', CANCELLED_METADATA);
    store.updateToolStatus('t-9', 'completed', { result: 'partial' });

    store.getOrCreateStreamingMessage('sdk-1');
    const blocks: ContentBlock[] = [{ type: 'tool_use', id: 't-9', name: 'Bash', input: { command: 'sleep 300' } }];
    store.updateStreamingMessage({ toolCalls: store.extractToolCalls(blocks) }, 'sdk-1');
    expect(toolOf(store, 't-9').status).toBe('cancelled');

    store.updateToolStatus('t-9', 'completed', { result: 'partial' });

    expect(toolOf(store, 't-9').status).toBe('cancelled');
    expect(defined(toolOf(store, 't-9').metadata, 'metadata')[CANCELLED_TOOL_DETAIL_KEY]).toBe(true);
  });

  it('carries the derivation through the caches when the marker lands after the status', () => {
    const store = useStreamingStore();

    store.updateToolStatus('t-9', 'completed', { result: 'partial' });
    store.updateToolMetadata('t-9', CANCELLED_METADATA);
    store.addToolCall({ id: 't-9', name: 'Bash', input: { command: 'sleep 300' } });

    expect(toolOf(store, 't-9').status).toBe('cancelled');
  });
});

describe('subagent store cancelled derivation', () => {
  function seedRunningTool(): ReturnType<typeof useSubagentStore> {
    const store = useSubagentStore();
    store.registerAgentTool('parent-1', { subagent_type: 'Explore', description: 'find' });
    store.addToolCallToSubagent('parent-1', { id: 't-1', name: 'Bash', input: { command: 'sleep 300' }, status: 'running' });
    store.markSubagentToolCancelRequested('t-1');
    return store;
  }

  function tool(store: ReturnType<typeof useSubagentStore>): ToolCall {
    return defined(defined(store.getSubagent('parent-1'), 'subagent').toolCalls.find((t) => t.id === 't-1'), 't-1');
  }

  it('flips a completed call to cancelled when the marker arrived first', () => {
    const store = seedRunningTool();

    store.updateSubagentToolMetadata('t-1', CANCELLED_METADATA);
    store.updateSubagentToolStatus('t-1', 'completed', 'partial output');

    expect(tool(store).status).toBe('cancelled');
  });

  it('flips a completed call to cancelled when the marker arrived second', () => {
    const store = seedRunningTool();

    store.updateSubagentToolStatus('t-1', 'completed', 'partial output');
    store.updateSubagentToolMetadata('t-1', CANCELLED_METADATA);

    expect(tool(store).status).toBe('cancelled');
  });

  it('clears the optimistic stopping flag at the cancelled status', () => {
    const store = seedRunningTool();
    store.updateSubagentToolLiveOutput('t-1', 'half a line', false);

    store.updateSubagentToolMetadata('t-1', CANCELLED_METADATA);
    store.updateSubagentToolStatus('t-1', 'completed');

    expect(tool(store).cancelRequested).toBeUndefined();
    expect(tool(store).liveOutput).toBeUndefined();
  });

  it('leaves an uncancelled completed call alone', () => {
    const store = seedRunningTool();

    store.updateSubagentToolStatus('t-1', 'completed', 'all of it');

    expect(tool(store).status).toBe('completed');
  });

  it('does not let the cancelled status be downgraded by a later frame', () => {
    const store = seedRunningTool();

    store.updateSubagentToolStatus('t-1', 'completed');
    store.updateSubagentToolMetadata('t-1', CANCELLED_METADATA);
    store.updateSubagentToolStatus('t-1', 'running');

    expect(tool(store).status).toBe('cancelled');
  });
});

describe('team store cancelled derivation', () => {
  // Seeded through the producers that build this state in the app, so the case fails if either of them
  // stops setting what it sets.
  function seedRunningTool(): ReturnType<typeof useTeamStore> {
    const store = useTeamStore();
    store.handleAgentAssistant(
      'agent-1',
      'msg-1',
      [{ type: 'tool_use', id: 't-1', name: 'Bash', input: { command: 'sleep 300' } }],
      1,
    );
    expect(store.markAgentToolCancelRequested('t-1')).toBe(true);
    expect(tool(store).status).toBe('running');
    expect(tool(store).cancelRequested).toBe(true);
    return store;
  }

  function tool(store: ReturnType<typeof useTeamStore>): ToolCall {
    const msgs = defined(store.agentMessages['agent-1'], 'agent messages');
    return defined(defined(at(msgs, 0).toolCalls, 'toolCalls').find((t) => t.id === 't-1'), 't-1');
  }

  it('flips the result to cancelled when it carries the marker', () => {
    const store = seedRunningTool();

    store.handleAgentToolResult('agent-1', 't-1', 'partial output', false, CANCELLED_METADATA);

    expect(tool(store).status).toBe('cancelled');
    expect(tool(store).cancelRequested).toBeUndefined();
  });

  it('flips to cancelled when the marker arrives merged onto metadata already on the call', () => {
    // The team path delivers one result message, so the two halves arrive together or not at all.
    const store = seedRunningTool();

    store.handleAgentToolResult('agent-1', 't-1', 'partial', false, { ...CANCELLED_METADATA, fullOutputPath: 'c:/tmp/o.txt' });

    expect(tool(store).status).toBe('cancelled');
    expect(defined(tool(store).metadata, 'metadata')['fullOutputPath']).toBe('c:/tmp/o.txt');
  });

  it('leaves a result with no marker completed', () => {
    const store = seedRunningTool();

    store.handleAgentToolResult('agent-1', 't-1', 'all of it', false);

    expect(tool(store).status).toBe('completed');
  });

  it('leaves an errored result failed rather than cancelled', () => {
    const store = seedRunningTool();

    store.handleAgentToolResult('agent-1', 't-1', 'boom', true);

    expect(tool(store).status).toBe('failed');
  });
});
