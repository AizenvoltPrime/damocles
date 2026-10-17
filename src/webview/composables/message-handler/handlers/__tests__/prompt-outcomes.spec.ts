// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { createToolHandlers } from '../tool-handlers';
import { convertHistoryTools } from '../../utils';
import type { HandlerContext, StoreContext } from '../../types';
import { useStreamingStore } from '@/stores/useStreamingStore';
import { useSubagentStore } from '@/stores/useSubagentStore';
import { useUIStore } from '@/stores/useUIStore';
import { POLICY_BLOCK_MARKER } from '@shared/types/constants';
import { CANCELLED_TOOL_DETAIL_KEY, type ToolCall } from '@shared/types/session';
import type { ExtensionToWebviewMessage } from '@shared/types/messages';

/**
 * Core settles a prompt the run's Stop cut short as an unasked deny, so its error text carries the policy marker, and it marks
 * the result stopped on its `details`. A live transcript and a reloaded one must both read that call as stopped, and a real
 * policy block as blocked with its reason.
 */

const UNASKED = `${POLICY_BLOCK_MARKER} Damocles could not ask the user the question, so this tool call was denied`;
const RULE_BLOCK = `${POLICY_BLOCK_MARKER} Permission denied by settings rule`;

function context(): HandlerContext {
  const stores = { streamingStore: useStreamingStore(), subagentStore: useSubagentStore(), uiStore: useUIStore() } as unknown as StoreContext;
  return { stores } as unknown as HandlerContext;
}

function handle(msg: ExtensionToWebviewMessage, ctx: HandlerContext): void {
  const handler = createToolHandlers()[msg.type] as ((m: ExtensionToWebviewMessage, c: HandlerContext) => void) | undefined;
  if (!handler) throw new Error(`no handler registered for ${msg.type}`);
  handler(msg, ctx);
}

const liveTool = (ctx: HandlerContext): ToolCall | undefined =>
  ctx.stores.streamingStore.messages.flatMap((m) => m.toolCalls ?? []).find((t) => t.id === 'q-1');

function replayed(result: string, metadata?: Record<string, unknown>): ToolCall {
  const [tool] = convertHistoryTools([{ id: 'q-1', name: 'AskUserQuestion', input: {}, result, isError: true, ...(metadata ? { metadata } : {}) }]) ?? [];
  if (!tool) throw new Error('convertHistoryTools dropped the call');
  return tool;
}

describe('a question prompt the Stop settled', () => {
  beforeEach(() => setActivePinia(createPinia()));

  it('reads as stopped live, where core sends it completed with its stopped marker', () => {
    const ctx = context();
    ctx.stores.streamingStore.addToolCall({ id: 'q-1', name: 'AskUserQuestion', input: {} });

    handle({ type: 'toolCompleted', toolUseId: 'q-1', toolName: 'AskUserQuestion', result: UNASKED, durationMs: 4 }, ctx);
    handle({ type: 'toolMetadata', toolUseId: 'q-1', metadata: { [CANCELLED_TOOL_DETAIL_KEY]: true } }, ctx);

    expect(liveTool(ctx)?.status).toBe('cancelled');
  });

  it('reads as stopped on reload too, not as the policy block its error text carries', () => {
    expect(replayed(UNASKED, { [CANCELLED_TOOL_DETAIL_KEY]: true }).status).toBe('cancelled');
  });
});

describe('a question the runtime blocked', () => {
  beforeEach(() => setActivePinia(createPinia()));

  it('reads as blocked with its reason live', () => {
    const ctx = context();
    ctx.stores.streamingStore.addToolCall({ id: 'q-1', name: 'AskUserQuestion', input: {} });

    handle({ type: 'toolFailed', toolUseId: 'q-1', toolName: 'AskUserQuestion', error: RULE_BLOCK }, ctx);

    expect(liveTool(ctx)).toMatchObject({ status: 'blocked', feedback: 'Permission denied by settings rule' });
  });

  it('reads as blocked with the same reason on reload', () => {
    expect(replayed(RULE_BLOCK)).toMatchObject({ status: 'blocked', feedback: 'Permission denied by settings rule' });
  });
});

describe('a subagent call the runtime blocked', () => {
  beforeEach(() => setActivePinia(createPinia()));

  const subagentTool = (ctx: HandlerContext): ToolCall | undefined => ctx.stores.subagentStore.getToolCallWithStatus('agent-1', 'e-1');

  function withSubagent(): HandlerContext {
    const ctx = context();
    ctx.stores.subagentStore.registerAgentTool('agent-1', { description: 'build', prompt: 'go' });
    return ctx;
  }

  it('carries its reason when the block is the first the store hears of the call', () => {
    const ctx = withSubagent();

    handle({ type: 'toolFailed', toolUseId: 'e-1', toolName: 'Edit', error: RULE_BLOCK, parentToolUseId: 'agent-1' }, ctx);

    expect(subagentTool(ctx)).toMatchObject({ status: 'blocked', feedback: 'Permission denied by settings rule' });
  });

  it('carries its reason onto a call the store already tracks', () => {
    const ctx = withSubagent();
    ctx.stores.subagentStore.addToolCallToSubagent('agent-1', { id: 'e-1', name: 'Edit', input: {}, status: 'running' });

    handle({ type: 'toolFailed', toolUseId: 'e-1', toolName: 'Edit', error: RULE_BLOCK, parentToolUseId: 'agent-1' }, ctx);

    expect(subagentTool(ctx)).toMatchObject({ status: 'blocked', feedback: 'Permission denied by settings rule' });
  });
});
