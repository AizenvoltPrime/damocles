import { describe, it, expect, vi } from 'vitest';
import { PiStreamAdapter } from '../pi-stream-adapter';
import type { ExtensionToWebviewMessage } from '../../../shared/types/messages';
import type { ModelInfo } from '../../../shared/types/settings';

function fakeSession(events: unknown[]) {
  let listener: ((e: unknown) => void) | undefined;
  return {
    sessionId: 'SID',
    subscribe: (l: (e: unknown) => void) => { listener = l; return () => undefined; },
    setAutoCompactionEnabled: () => undefined,
    getSessionStats: () => ({ sessionId: 'SID', cost: 0.05, tokens: { input: 100, output: 42, cacheRead: 5, cacheWrite: 3, total: 150 } }),
    getLastAssistantText: () => 'Hello there!',
    play: () => { for (const e of events) listener?.(e); },
  };
}

function makeAdapter(out: ExtensionToWebviewMessage[]): PiStreamAdapter {
  const models: ModelInfo[] = [{ value: 'claude-opus-4-8', displayName: 'Opus 4.8', description: '' }];
  return new PiStreamAdapter({
    onMessage: (m) => out.push(m),
    cwd: '/cwd',
    sessionId: () => 'SID',
    modelValue: () => 'claude-opus-4-8',
    contextWindow: () => 1_000_000,
    supportedModels: () => models,
    accountInfo: () => ({ model: 'claude-opus-4-8', subscriptionType: 'allowance' }),
    permissionMode: () => 'default',
    apiKeySource: () => 'allowance',
    onAssistantTextFinal: vi.fn(),
  });
}

/** A read-only turn: think → text → Read tool → usage → end. Mirrors the SDK's logical output. */
const PI_EVENTS: unknown[] = [
  { type: 'message_update', assistantMessageEvent: { type: 'thinking_start', contentIndex: 0 } },
  { type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: 'Let me' } },
  { type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: ' think' } },
  { type: 'message_update', assistantMessageEvent: { type: 'thinking_end', content: 'Let me think' } },
  { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'Hello' } },
  { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: ' there!' } },
  { type: 'message_update', assistantMessageEvent: { type: 'toolcall_end', toolCall: { type: 'toolCall', id: 'tool-1', name: 'read', arguments: { path: '/a.ts' } } } },
  { type: 'tool_execution_start', toolCallId: 'tool-1', toolName: 'read', args: { path: '/a.ts' } },
  { type: 'tool_execution_end', toolCallId: 'tool-1', toolName: 'read', result: { content: [{ type: 'text', text: 'file contents' }], details: { lines: 10 } }, isError: false },
  { type: 'message_end', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'Let me think' }, { type: 'text', text: 'Hello there!' }], usage: { input: 100, output: 42, cacheRead: 5, cacheWrite: 3, totalTokens: 150, cost: {} } } },
  { type: 'agent_end', messages: [], willRetry: false },
];

/** Collapse consecutive `partial`s of the same phase and redact volatile fields → a logical trace. */
function normalize(messages: ExtensionToWebviewMessage[]): unknown[] {
  const out: unknown[] = [];
  for (const m of messages) {
    if (m.type === 'partial') {
      const phase = m.data.isThinking ? 'thinking' : 'text';
      const text = m.data.isThinking ? m.data.streamingThinking : m.data.streamingText;
      const prev = out[out.length - 1] as { type: string; phase?: string } | undefined;
      if (prev && prev.type === 'partial' && prev.phase === phase) {
        (prev as { text?: string }).text = text;
      } else {
        out.push({ type: 'partial', phase, text });
      }
    } else if (m.type === 'done') {
      out.push({ type: 'done', total_output_tokens: m.data.total_output_tokens, hasCost: typeof m.data.total_cost_usd === 'number' });
    } else if (m.type === 'toolCompleted') {
      out.push({ type: 'toolCompleted', toolName: m.toolName, result: m.result });
    } else if (m.type === 'toolStreaming') {
      out.push({ type: 'toolStreaming', name: m.tool.name, input: m.tool.input });
    } else if (m.type === 'tokenUsageUpdate') {
      out.push({ type: 'tokenUsageUpdate', inputTokens: m.inputTokens, outputTokens: m.outputTokens, cacheReadTokens: m.cacheReadTokens, cacheCreationTokens: m.cacheCreationTokens });
    } else {
      out.push({ type: m.type });
    }
  }
  return out;
}

describe('PiStreamAdapter golden master (US-P1-5/6)', () => {
  it('emits the SDK-equivalent logical sequence with tool renames and final text', () => {
    const out: ExtensionToWebviewMessage[] = [];
    const adapter = makeAdapter(out);
    const session = fakeSession(PI_EVENTS);
    adapter.subscribe(session as never);
    adapter.beginTurn('corr-1');
    session.play();

    expect(normalize(out)).toEqual([
      { type: 'processing' },
      { type: 'sessionStateChanged' },
      { type: 'systemInit' },
      { type: 'accountInfo' },
      { type: 'availableModels' },
      { type: 'modelUpdate' },
      { type: 'userMessageIdAssigned' },
      { type: 'partial', phase: 'thinking', text: 'Let me think' },
      { type: 'partial', phase: 'text', text: 'Hello there!' },
      { type: 'toolStreaming', name: 'Read', input: { file_path: '/a.ts' } },
      { type: 'toolPending' },
      { type: 'toolCompleted', toolName: 'Read', result: 'file contents' },
      { type: 'toolMetadata' },
      { type: 'assistant' },
      { type: 'tokenUsageUpdate', inputTokens: 100, outputTokens: undefined, cacheReadTokens: 5, cacheCreationTokens: 3 },
      { type: 'done', total_output_tokens: 42, hasCost: true },
      { type: 'processing' },
      { type: 'sessionStateChanged' },
      { type: 'stopInfo' },
    ]);
  });

  it('streams ordered contentBlocks (text before tool_use) so the webview keeps source order', () => {
    const out: ExtensionToWebviewMessage[] = [];
    const adapter = makeAdapter(out);
    const session = fakeSession(PI_EVENTS);
    adapter.subscribe(session as never);
    adapter.beginTurn('corr-1');
    session.play();

    const toolStreaming = out.find((m): m is Extract<ExtensionToWebviewMessage, { type: 'toolStreaming' }> => m.type === 'toolStreaming');
    expect(toolStreaming?.contentBlocks).toEqual([
      { type: 'text', text: 'Hello there!' },
      { type: 'tool_use', id: 'tool-1', name: 'Read', input: { file_path: '/a.ts' } },
    ]);
  });

  it('emits the authoritative final assistant message (text routed via contentBlocks) on message_end', () => {
    const out: ExtensionToWebviewMessage[] = [];
    const adapter = makeAdapter(out);
    const session = fakeSession([
      { type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: 'pondering' } },
      { type: 'message_end', message: { role: 'assistant', content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: 'Final answer' }], usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: {} } } },
      { type: 'agent_end', messages: [], willRetry: false },
    ]);
    adapter.subscribe(session as never);
    adapter.beginTurn('c');
    session.play();

    const assistantMsg = out.find((m): m is Extract<ExtensionToWebviewMessage, { type: 'assistant' }> => m.type === 'assistant');
    expect(assistantMsg?.data.message.content).toContainEqual({ type: 'text', text: 'Final answer' });
  });

  it('correlates the user message and maps an aborted error to sessionCancelled', () => {
    const out: ExtensionToWebviewMessage[] = [];
    const adapter = makeAdapter(out);
    const session = fakeSession([{ type: 'message_update', assistantMessageEvent: { type: 'error', reason: 'aborted', error: { errorMessage: 'cancelled' } } }]);
    adapter.subscribe(session as never);
    adapter.beginTurn('corr-9');
    session.play();

    const correlation = out.find((m) => m.type === 'userMessageIdAssigned');
    expect(correlation).toMatchObject({ type: 'userMessageIdAssigned', correlationId: 'corr-9' });
    expect(out.some((m) => m.type === 'sessionCancelled')).toBe(true);
  });
});
