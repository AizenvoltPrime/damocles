// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { createToolHandlers } from '../tool-handlers';
import type { HandlerContext, ScrollBehavior, StoreContext } from '../../types';
import { useStreamingStore } from '@/stores/useStreamingStore';
import { useSubagentStore } from '@/stores/useSubagentStore';
import type { ExtensionToWebviewMessage } from '@shared/types/messages';

/**
 * `message-handler/index.ts` scrolls the chat container to the bottom after every handled message
 * unless the handler returns `{ skipScroll: true }`. A running shell command emits several live-output
 * frames a second, so without the opt-out the view is yanked to the bottom continuously and the user
 * cannot read back. Elapsed-only frames keep their existing scroll behaviour: changing that is
 * unrelated to live output.
 */

function context(): HandlerContext {
  const stores = {
    streamingStore: useStreamingStore(),
    subagentStore: useSubagentStore(),
  } as unknown as StoreContext;
  return { stores } as unknown as HandlerContext;
}

function toolProgress(
  msg: Partial<Extract<ExtensionToWebviewMessage, { type: 'toolProgress' }>>,
): Extract<ExtensionToWebviewMessage, { type: 'toolProgress' }> {
  return {
    type: 'toolProgress',
    toolUseId: 't-1',
    toolName: 'Bash',
    parentToolUseId: null,
    elapsedTimeSeconds: 3,
    ...msg,
  };
}

function dispatch(msg: Extract<ExtensionToWebviewMessage, { type: 'toolProgress' }>, ctx: HandlerContext): ScrollBehavior | void {
  const handler = createToolHandlers().toolProgress;
  if (!handler) throw new Error('no toolProgress handler registered');
  return handler(msg, ctx);
}

describe('toolProgress live output', () => {
  beforeEach(() => setActivePinia(createPinia()));

  it('stores the output on the main-session tool call and opts out of the forced scroll', () => {
    const ctx = context();
    const streamingStore = ctx.stores.streamingStore;
    streamingStore.addToolCall({ id: 't-1', name: 'Bash', input: { command: 'npm test' } });

    const result = dispatch(toolProgress({ output: 'Test Suites: 3 passed\n', outputTruncated: false }), ctx);

    expect(result).toEqual({ skipScroll: true });
    const tool = streamingStore.messages.flatMap((m) => m.toolCalls ?? []).find((t) => t.id === 't-1');
    expect(tool?.liveOutput).toBe('Test Suites: 3 passed\n');
    expect(tool?.liveOutputTruncated).toBe(false);
  });

  it('routes the empty first frame, since an empty string is still defined output', () => {
    // Contracts amendment 0: every shell call opens with `output: ''`. A truthiness check here would
    // drop it, and the pane would appear only once the command printed, which is the whole waiting period.
    const ctx = context();
    const streamingStore = ctx.stores.streamingStore;
    streamingStore.addToolCall({ id: 't-1', name: 'Bash', input: { command: 'sleep 30' } });

    const result = dispatch(toolProgress({ output: '', outputTruncated: false }), ctx);

    expect(result).toEqual({ skipScroll: true });
    const tool = streamingStore.messages.flatMap((m) => m.toolCalls ?? []).find((t) => t.id === 't-1');
    expect(tool?.liveOutput).toBe('');
  });

  it('carries the truncated flag through to the tool call', () => {
    const ctx = context();
    ctx.stores.streamingStore.addToolCall({ id: 't-1', name: 'Bash', input: {} });

    dispatch(toolProgress({ output: 'tail only', outputTruncated: true }), ctx);

    const tool = ctx.stores.streamingStore.messages.flatMap((m) => m.toolCalls ?? []).find((t) => t.id === 't-1');
    expect(tool?.liveOutputTruncated).toBe(true);
  });

  it('routes an output frame to the subagent store when the call belongs to a subagent', () => {
    const ctx = context();
    const { subagentStore, streamingStore } = ctx.stores;
    subagentStore.registerAgentTool('agent-1', { description: 'build', prompt: 'go' });
    subagentStore.addToolCallToSubagent('agent-1', { id: 't-1', name: 'Bash', input: {}, status: 'running' });
    // The same id also exists in the main transcript: routing must prefer the subagent, not both.
    streamingStore.addToolCall({ id: 't-1', name: 'Bash', input: {} });

    const result = dispatch(toolProgress({ output: 'inside the subagent' }), ctx);

    expect(result).toEqual({ skipScroll: true });
    expect(subagentStore.getSubagent('agent-1')?.toolCalls[0]?.liveOutput).toBe('inside the subagent');
    const mainTool = streamingStore.messages.flatMap((m) => m.toolCalls ?? []).find((t) => t.id === 't-1');
    expect(mainTool?.liveOutput).toBeUndefined();
  });

  it('an elapsed-only frame does not skip the scroll and still updates elapsed time', () => {
    const ctx = context();
    const streamingStore = ctx.stores.streamingStore;
    streamingStore.addToolCall({ id: 't-1', name: 'Read', input: {} });

    const result = dispatch(toolProgress({ toolName: 'Read', elapsedTimeSeconds: 7 }), ctx);

    expect(result?.skipScroll).not.toBe(true);
    const tool = streamingStore.messages.flatMap((m) => m.toolCalls ?? []).find((t) => t.id === 't-1');
    expect(tool?.elapsedTimeSeconds).toBe(7);
    expect(tool?.liveOutput).toBeUndefined();
  });

  it('records the elapsed time on an output frame, which is the only frame a shell tool ever sends', () => {
    const ctx = context();
    const streamingStore = ctx.stores.streamingStore;
    streamingStore.addToolCall({ id: 't-1', name: 'Bash', input: { command: 'sleep 30' } });

    dispatch(toolProgress({ output: 'still going', elapsedTimeSeconds: 12 }), ctx);

    const tool = streamingStore.messages.flatMap((m) => m.toolCalls ?? []).find((t) => t.id === 't-1');
    expect(tool?.elapsedTimeSeconds).toBe(12);
  });

  it('records the elapsed time on a subagent output frame without writing it to the main transcript', () => {
    const ctx = context();
    const { subagentStore, streamingStore } = ctx.stores;
    subagentStore.registerAgentTool('agent-1', { description: 'build', prompt: 'go' });
    subagentStore.addToolCallToSubagent('agent-1', { id: 't-1', name: 'Bash', input: {}, status: 'running' });
    streamingStore.addToolCall({ id: 't-1', name: 'Bash', input: {} });

    dispatch(toolProgress({ output: 'inside', elapsedTimeSeconds: 14 }), ctx);

    expect(subagentStore.getSubagent('agent-1')?.toolCalls[0]?.metadata?.['elapsedTimeSeconds']).toBe(14);
    const mainTool = streamingStore.messages.flatMap((m) => m.toolCalls ?? []).find((t) => t.id === 't-1');
    expect(mainTool?.elapsedTimeSeconds).toBeUndefined();
  });

  it('an elapsed-only frame for a subagent tool still writes elapsed metadata', () => {
    const ctx = context();
    const { subagentStore } = ctx.stores;
    subagentStore.registerAgentTool('agent-1', { description: 'build', prompt: 'go' });
    subagentStore.addToolCallToSubagent('agent-1', { id: 't-1', name: 'Read', input: {}, status: 'running' });

    const result = dispatch(toolProgress({ toolName: 'Read', elapsedTimeSeconds: 9 }), ctx);

    expect(result?.skipScroll).not.toBe(true);
    expect(subagentStore.getSubagent('agent-1')?.toolCalls[0]?.metadata?.['elapsedTimeSeconds']).toBe(9);
  });
});
