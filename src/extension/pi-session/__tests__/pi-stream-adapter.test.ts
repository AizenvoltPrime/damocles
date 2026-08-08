import { describe, it, expect, vi } from 'vitest';
import { log } from '../../logger';
import { PiStreamAdapter, isNothingToCompact } from '../pi-stream-adapter';
import type { ExtensionToWebviewMessage } from '../../../shared/types/messages';
import type { ModelInfo } from '../../../shared/types/settings';

vi.mock('../../logger', () => ({ log: vi.fn() }));

/** A SessionManager stub whose active branch ends with a single user entry (the rewind/id key). */
function fakeSessionManager(userEntryId = 'u-entry', entries: unknown[] = []) {
  return {
    getLeafId: () => userEntryId,
    getBranch: () => [{ type: 'message', id: userEntryId, parentId: null, timestamp: '', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } }],
    getEntries: () => entries,
  };
}

function fakeSession(events: unknown[], opts?: { entries?: unknown[]; modelRuntime?: unknown }) {
  let listener: ((e: unknown) => void) | undefined;
  return {
    sessionId: 'SID',
    sessionManager: fakeSessionManager('u-entry', opts?.entries ?? []),
    modelRuntime: opts?.modelRuntime ?? { getModel: () => undefined },
    subscribe: (l: (e: unknown) => void) => { listener = l; return () => undefined; },
    setAutoCompactionEnabled: () => undefined,
    getSessionStats: () => ({ sessionId: 'SID', cost: 0.05, tokens: { input: 100, output: 42, cacheRead: 5, cacheWrite: 3, total: 150 } }),
    getLastAssistantText: () => 'Hello there!',
    play: () => { for (const e of events) listener?.(e); },
  };
}

function makeAdapter(
  out: ExtensionToWebviewMessage[],
  hooks?: {
    onUserMessageDelivered?: () => boolean;
    onMidStreamBatchCommitted?: (id: string) => void;
    modelValue?: () => string;
    defaultModelValue?: () => string;
    showCacheMissNotices?: () => boolean;
  },
): PiStreamAdapter {
  const models: ModelInfo[] = [{ value: 'claude-opus-4-8', displayName: 'Opus 4.8', description: '' }];
  return new PiStreamAdapter({
    onMessage: (m) => out.push(m),
    cwd: '/cwd',
    sessionId: () => 'SID',
    modelValue: hooks?.modelValue ?? (() => 'claude-opus-4-8'),
    defaultModelValue: hooks?.defaultModelValue ?? (() => 'claude-opus-4-8'),
    contextWindow: () => 1_000_000,
    supportedModels: () => models,
    accountInfo: () => ({ model: 'claude-opus-4-8', subscriptionType: 'allowance' }),
    permissionMode: () => 'default',
    apiKeySource: () => 'allowance',
    budgetLimit: () => null,
    showCacheMissNotices: hooks?.showCacheMissNotices ?? (() => false),
    onBudgetStop: () => undefined,
    onUserMessageDelivered: hooks?.onUserMessageDelivered ?? (() => false),
    onMidStreamBatchCommitted: hooks?.onMidStreamBatchCommitted ?? (() => undefined),
    onAssistantTextFinal: vi.fn(),
  });
}

/** Adapter wired with a dollar budget limit + abort spy for the US-008 budget tests. */
function makeBudgetAdapter(out: ExtensionToWebviewMessage[], limit: number, onStop: () => void): PiStreamAdapter {
  const models: ModelInfo[] = [{ value: 'claude-opus-4-8', displayName: 'Opus 4.8', description: '' }];
  return new PiStreamAdapter({
    onMessage: (m) => out.push(m),
    cwd: '/cwd',
    sessionId: () => 'SID',
    modelValue: () => 'claude-opus-4-8',
    defaultModelValue: () => 'claude-opus-4-8',
    contextWindow: () => 1_000_000,
    supportedModels: () => models,
    accountInfo: () => ({ model: 'claude-opus-4-8', subscriptionType: 'apikey' }),
    permissionMode: () => 'default',
    apiKeySource: () => 'apikey',
    budgetLimit: () => limit,
    showCacheMissNotices: () => false,
    onBudgetStop: onStop,
    onUserMessageDelivered: () => false,
    onMidStreamBatchCommitted: () => undefined,
    onAssistantTextFinal: vi.fn(),
  });
}

/** A session whose cumulative cost is controllable per read (so a turn can cross the limit mid-flight). */
function fakeSessionWithCost(events: unknown[], cost: () => number) {
  let listener: ((e: unknown) => void) | undefined;
  return {
    sessionId: 'SID',
    sessionManager: fakeSessionManager(),
    modelRuntime: { getModel: () => undefined },
    subscribe: (l: (e: unknown) => void) => { listener = l; return () => undefined; },
    setAutoCompactionEnabled: () => undefined,
    getSessionStats: () => ({ sessionId: 'SID', cost: cost(), tokens: { input: 100, output: 42, cacheRead: 5, cacheWrite: 3, total: 150 } }),
    getLastAssistantText: () => 'done',
    play: () => { for (const e of events) listener?.(e); },
  };
}

/** A read-only turn: think → text → Read tool → usage → end. Mirrors the SDK's logical output. */
const PI_EVENTS: unknown[] = [
  { type: 'message_start', message: { role: 'assistant', content: [] } },
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

  it('session-start modelUpdate reports the true workspace default, not the active panel model', () => {
    // Regression: `defaultModel: model` clobbered the webview's stored default with the active model
    // (most visible with stepfun/deepseek). The default must come from defaultModelValue, not modelValue.
    const out: ExtensionToWebviewMessage[] = [];
    const adapter = makeAdapter(out, {
      modelValue: () => 'step-3.7-flash',
      defaultModelValue: () => 'claude-opus-4-8',
    });
    const session = fakeSession([{ type: 'agent_end', messages: [], willRetry: false }]);
    adapter.subscribe(session as never);
    adapter.beginTurn('corr-default');

    const modelUpdate = out.find((m) => m.type === 'modelUpdate');
    expect(modelUpdate).toMatchObject({
      type: 'modelUpdate',
      activeModel: 'step-3.7-flash',
      defaultModel: 'claude-opus-4-8',
    });
  });

  it('holdNextAgentEnd suppresses the idle/done for the held agent_end, but only once', () => {
    const out: ExtensionToWebviewMessage[] = [];
    const adapter = makeAdapter(out);
    const session = fakeSession([
      { type: 'agent_end', messages: [], willRetry: false },
      { type: 'agent_end', messages: [], willRetry: false },
    ]);
    adapter.subscribe(session as never);
    adapter.beginTurn('c');
    out.length = 0;
    adapter.holdNextAgentEnd();
    session.play(); // first agent_end is the held one (continuation), second settles the turn
    expect(out.filter((m) => m.type === 'done')).toHaveLength(1);
    expect(out.filter((m) => m.type === 'stopInfo')).toHaveLength(1);
  });

  it('a normal agent_end (no hold) settles the turn with done + idle + stopInfo', () => {
    const out: ExtensionToWebviewMessage[] = [];
    const adapter = makeAdapter(out);
    const session = fakeSession([{ type: 'agent_end', messages: [], willRetry: false }]);
    adapter.subscribe(session as never);
    adapter.beginTurn('c');
    out.length = 0;
    session.play();
    expect(out.find((m) => m.type === 'done')).toBeDefined();
    expect(out.find((m) => m.type === 'stopInfo')).toBeDefined();
  });

  it('observedAgentRun is false for a command-only turn and true once an agent_end settles', () => {
    const out: ExtensionToWebviewMessage[] = [];
    const adapter = makeAdapter(out);
    const session = fakeSession([{ type: 'agent_end', messages: [], willRetry: false }]);
    adapter.subscribe(session as never);

    adapter.beginTurn('c');
    expect(adapter.observedAgentRun()).toBe(false); // no agent run yet (e.g. extension command)

    session.play();
    expect(adapter.observedAgentRun()).toBe(true); // a real run settled the turn
  });

  it('endTurnWithoutAgentRun releases the spinner (processing:false + idle) with no result card', () => {
    const out: ExtensionToWebviewMessage[] = [];
    const adapter = makeAdapter(out);
    adapter.beginTurn('c'); // arms processing:true + running, as an extension command would
    out.length = 0;

    adapter.endTurnWithoutAgentRun();
    expect(out.find((m) => m.type === 'processing' && m.isProcessing === false)).toBeDefined();
    expect(out.find((m) => m.type === 'sessionStateChanged' && m.state === 'idle')).toBeDefined();
    expect(out.find((m) => m.type === 'done')).toBeUndefined(); // no phantom result for a no-run turn
  });

  it('suppresses the before_agent_start context-injection custom message from chat rendering (US-005)', () => {
    const out: ExtensionToWebviewMessage[] = [];
    const adapter = makeAdapter(out);
    const session = fakeSession([
      { type: 'message_start', message: { role: 'custom', customType: 'damocles-context-injection', content: '<damocles_memory>x</damocles_memory>', display: false } },
      { type: 'message_end', message: { role: 'custom', customType: 'damocles-context-injection', content: '<damocles_memory>x</damocles_memory>', display: false } },
    ]);
    adapter.subscribe(session as never);
    adapter.beginTurn('c');
    out.length = 0; // drop the beginTurn init payloads; assert only what the custom message produced
    session.play();

    const rendered = out.filter((m) => m.type === 'assistant' || m.type === 'userMessage' || m.type === 'partial' || m.type === 'toolStreaming');
    expect(rendered).toEqual([]);
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
    const session = fakeSession([
      { type: 'message_start', message: { role: 'assistant', content: [] } },
      { type: 'message_update', assistantMessageEvent: { type: 'error', reason: 'aborted', error: { errorMessage: 'cancelled' } } },
    ]);
    adapter.subscribe(session as never);
    adapter.beginTurn('corr-9');
    session.play();

    // The user-message id is now the real pi entry id (resolved on the first message_start), linked
    // to the webview user bubble by correlationId (FR-3).
    const correlation = out.find((m) => m.type === 'userMessageIdAssigned');
    expect(correlation).toMatchObject({ type: 'userMessageIdAssigned', correlationId: 'corr-9', sdkMessageId: 'u-entry' });
    expect(out.some((m) => m.type === 'sessionCancelled')).toBe(true);
  });

  it('keys a delivered queued batch marker at the next assistant message_start, not at delivery', () => {
    const out: ExtensionToWebviewMessage[] = [];
    const committed: string[] = [];
    const adapter = makeAdapter(out, {
      onUserMessageDelivered: () => true,
      onMidStreamBatchCommitted: (id) => committed.push(id),
    });
    // pi commits the steered user entry AFTER its message_end; model the tree leaf accordingly.
    let leafId = 'u-prev';
    let listener: ((e: unknown) => void) | undefined;
    const session = {
      sessionId: 'SID',
      sessionManager: { getLeafId: () => leafId, getBranch: () => [{ type: 'message', id: leafId, parentId: null, timestamp: '', message: { role: 'user', content: [{ type: 'text', text: 'x' }] } }] },
      subscribe: (l: (e: unknown) => void) => { listener = l; return () => undefined; },
    };
    adapter.subscribe(session as never);
    adapter.beginTurn('corr-mid');

    // Queued batch delivered: at its message_end the steered entry is NOT yet committed (leaf still prior).
    listener!({ type: 'message_end', message: { role: 'user', content: [{ type: 'text', text: 'and 2' }] } });
    expect(committed).toHaveLength(0);

    // pi now commits the steered entry; the next assistant message_start resolves the owed marker to it.
    leafId = 'u-combined';
    listener!({ type: 'message_start', message: { role: 'assistant', content: [] } });
    expect(committed).toEqual(['u-combined']);

    // One-shot: a second assistant message_start in the same turn does not re-record.
    listener!({ type: 'message_start', message: { role: 'assistant', content: [] } });
    expect(committed).toEqual(['u-combined']);
  });

  it('drops a delivered-but-unresolved marker when the turn aborts before its assistant message_start', () => {
    const out: ExtensionToWebviewMessage[] = [];
    const committed: string[] = [];
    const adapter = makeAdapter(out, {
      onUserMessageDelivered: () => true,
      onMidStreamBatchCommitted: (id) => committed.push(id),
    });
    let leafId = 'u-prev';
    let listener: ((e: unknown) => void) | undefined;
    const session = {
      sessionId: 'SID',
      sessionManager: { getLeafId: () => leafId, getBranch: () => [{ type: 'message', id: leafId, parentId: null, timestamp: '', message: { role: 'user', content: [{ type: 'text', text: 'x' }] } }] },
      subscribe: (l: (e: unknown) => void) => { listener = l; return () => undefined; },
    };
    adapter.subscribe(session as never);
    adapter.beginTurn('corr-a');

    // A batch is delivered, arming the pending marker — but the turn aborts before any assistant
    // message_start resolves it (e.g. the user hits ESC, or the run errors out).
    listener!({ type: 'message_end', message: { role: 'user', content: [{ type: 'text', text: 'queued' }] } });
    expect(committed).toHaveLength(0);

    // A NEW turn begins; beginTurn's reset must clear the stale pending marker so the next assistant
    // message_start of THIS turn does not mis-key it to this turn's (unrelated) user entry.
    leafId = 'u-next-turn';
    adapter.beginTurn('corr-b');
    listener!({ type: 'message_start', message: { role: 'assistant', content: [] } });
    expect(committed).toHaveLength(0);
  });

  it('does not record a mid-stream marker when delivery reports no batch owed', () => {
    const out: ExtensionToWebviewMessage[] = [];
    const committed: string[] = [];
    const adapter = makeAdapter(out, {
      onUserMessageDelivered: () => false,
      onMidStreamBatchCommitted: (id) => committed.push(id),
    });
    const session = fakeSession([
      { type: 'message_end', message: { role: 'user', content: [{ type: 'text', text: 'plain follow-up' }] } },
      { type: 'message_start', message: { role: 'assistant', content: [] } },
    ]);
    adapter.subscribe(session as never);
    adapter.beginTurn('corr-plain');
    session.play();
    expect(committed).toHaveLength(0);
  });

  it('abandons running tool cards on abort and suppresses a late completion', () => {
    const out: ExtensionToWebviewMessage[] = [];
    const adapter = makeAdapter(out);
    let listener: ((e: unknown) => void) | undefined;
    const session = { sessionId: 'SID', subscribe: (l: (e: unknown) => void) => { listener = l; return () => undefined; } };
    adapter.subscribe(session as never);
    adapter.beginTurn('corr-10');

    // A long-running tool is mid-execution when the user hits ESC.
    listener!({ type: 'tool_execution_start', toolCallId: 't1', toolName: 'BrowserOpen', args: { url: 'x' } });
    adapter.markAborted();

    expect(out.find((m) => m.type === 'toolAbandoned')).toMatchObject({
      type: 'toolAbandoned', toolUseId: 't1', toolName: 'BrowserOpen',
    });

    // A tool_execution_end arriving after the abort must NOT resurrect the card as completed.
    out.length = 0;
    listener!({ type: 'tool_execution_end', toolCallId: 't1', toolName: 'BrowserOpen', result: { content: [{ type: 'text', text: 'done' }] }, isError: false });
    expect(out.some((m) => m.type === 'toolCompleted')).toBe(false);
  });
});

describe('PiStreamAdapter refusals (US-023)', () => {
  it('routes a model refusal (stopReason error + errorMessage) to a clean error, not authFailure', () => {
    const out: ExtensionToWebviewMessage[] = [];
    const adapter = makeAdapter(out);
    const session = fakeSession([
      { type: 'message_start', message: { role: 'assistant', content: [] } },
      { type: 'message_update', assistantMessageEvent: { type: 'error', reason: 'error', error: { errorMessage: "I'm sorry, but I can't help with that request." } } },
    ]);
    adapter.subscribe(session as never);
    adapter.beginTurn('corr-refusal');
    out.length = 0;
    session.play();

    const error = out.find((m): m is Extract<ExtensionToWebviewMessage, { type: 'error' }> => m.type === 'error');
    expect(error?.message).toContain("can't help");
    expect(out.some((m) => m.type === 'authFailure')).toBe(false);
    // Turn ends clean: processing stops and the session returns to idle.
    expect(out.some((m) => m.type === 'processing' && m.isProcessing === false)).toBe(true);
    expect(out.some((m) => m.type === 'sessionStateChanged' && m.state === 'idle')).toBe(true);
  });

  it('still routes a genuine auth error to authFailure (the heuristic is intact)', () => {
    const out: ExtensionToWebviewMessage[] = [];
    const adapter = makeAdapter(out);
    const session = fakeSession([
      { type: 'message_update', assistantMessageEvent: { type: 'error', reason: 'error', error: { errorMessage: 'Request failed: 401 Unauthorized (invalid api key)' } } },
    ]);
    adapter.subscribe(session as never);
    adapter.beginTurn('corr-auth');
    out.length = 0;
    session.play();

    expect(out.some((m) => m.type === 'authFailure')).toBe(true);
    expect(out.some((m) => m.type === 'error')).toBe(false);
  });
});

describe('PiStreamAdapter compaction no-op classification', () => {
  it('isNothingToCompact recognizes the benign refusal in raw and wrapped forms', () => {
    expect(isNothingToCompact('Nothing to compact (session too small)')).toBe(true);
    expect(isNothingToCompact('Compaction failed: Nothing to compact (session too small)')).toBe(true);
    expect(isNothingToCompact('Already compacted')).toBe(true);
    expect(isNothingToCompact('Compaction failed: Already compacted')).toBe(true);
  });

  it('isNothingToCompact does not match a genuine compaction failure', () => {
    expect(isNothingToCompact('Compaction failed: Request failed: 500')).toBe(false);
    expect(isNothingToCompact('No model selected')).toBe(false);
  });

  it('suppresses the red error for a "nothing to compact" compaction_end (PiSession owns the friendly notice)', () => {
    const out: ExtensionToWebviewMessage[] = [];
    const adapter = makeAdapter(out);
    const session = fakeSession([
      { type: 'compaction_end', reason: 'manual', result: undefined, aborted: false, willRetry: false, errorMessage: 'Compaction failed: Nothing to compact (session too small)' },
    ]);
    adapter.subscribe(session as never);
    adapter.beginTurn('c');
    out.length = 0;
    session.play();

    expect(out.some((m) => m.type === 'error')).toBe(false);
    expect(out.some((m) => m.type === 'statusUpdate' && m.status === 'ready')).toBe(true);
  });

  it('still routes a genuine compaction failure to a red error', () => {
    const out: ExtensionToWebviewMessage[] = [];
    const adapter = makeAdapter(out);
    const session = fakeSession([
      { type: 'compaction_end', reason: 'manual', result: undefined, aborted: false, willRetry: false, errorMessage: 'Compaction failed: Request failed: 500' },
    ]);
    adapter.subscribe(session as never);
    adapter.beginTurn('c');
    out.length = 0;
    session.play();

    expect(out.some((m) => m.type === 'error')).toBe(true);
  });

  it('forwards the post-compaction token estimate as postTokens (pi 0.79.8 #5877)', () => {
    const out: ExtensionToWebviewMessage[] = [];
    const adapter = makeAdapter(out);
    const session = fakeSession([
      { type: 'compaction_end', reason: 'manual', aborted: false, willRetry: false, result: { summary: 'done', firstKeptEntryId: 'k1', tokensBefore: 43000, estimatedTokensAfter: 5000 } },
    ]);
    adapter.subscribe(session as never);
    adapter.beginTurn('c');
    out.length = 0;
    session.play();

    expect(out.find((m) => m.type === 'compactBoundary')).toMatchObject({ preTokens: 43000, postTokens: 5000 });
  });

  it('omits postTokens when pi provides no post-compaction estimate', () => {
    const out: ExtensionToWebviewMessage[] = [];
    const adapter = makeAdapter(out);
    const session = fakeSession([
      { type: 'compaction_end', reason: 'manual', aborted: false, willRetry: false, result: { summary: 'done', firstKeptEntryId: 'k1', tokensBefore: 43000 } },
    ]);
    adapter.subscribe(session as never);
    adapter.beginTurn('c');
    out.length = 0;
    session.play();

    const boundary = out.find((m) => m.type === 'compactBoundary');
    expect(boundary && 'postTokens' in boundary).toBe(false);
  });

  it('carries the resolved compaction entryId on the boundary (US-001)', () => {
    const out: ExtensionToWebviewMessage[] = [];
    const adapter = makeAdapter(out);
    const session = fakeSession([
      { type: 'compaction_end', reason: 'manual', aborted: false, willRetry: false, result: { summary: 'done', firstKeptEntryId: 'k1', tokensBefore: 43000 } },
    ]);
    // The branch ends with the just-appended compaction entry — its id is the boundary's branch anchor.
    session.sessionManager.getBranch = () => [
      { type: 'message', id: 'u-entry', parentId: null, timestamp: '', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } },
      { type: 'compaction', id: 'comp-7', parentId: 'u-entry', timestamp: '' },
    ];
    adapter.subscribe(session as never);
    adapter.beginTurn('c');
    out.length = 0;
    session.play();

    expect(out.find((m) => m.type === 'compactBoundary')).toMatchObject({ entryId: 'comp-7' });
  });

  it('picks the latest (leaf) compaction when the branch has more than one (US-001 multi-compaction)', () => {
    const out: ExtensionToWebviewMessage[] = [];
    const adapter = makeAdapter(out);
    const session = fakeSession([
      { type: 'compaction_end', reason: 'manual', aborted: false, willRetry: false, result: { summary: 'done', firstKeptEntryId: 'k2', tokensBefore: 43000 } },
    ]);
    // A session compacted twice: the older compaction sits mid-branch, the newest is the leaf. The
    // backward scan must resolve the just-appended (leaf) compaction, never the stale older one.
    session.sessionManager.getBranch = () => [
      { type: 'message', id: 'u-entry', parentId: null, timestamp: '', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } },
      { type: 'compaction', id: 'comp-old', parentId: 'u-entry', timestamp: '' },
      { type: 'message', id: 'u-2', parentId: 'comp-old', timestamp: '', message: { role: 'user', content: [{ type: 'text', text: 'more' }] } },
      { type: 'compaction', id: 'comp-7', parentId: 'u-2', timestamp: '' },
    ];
    adapter.subscribe(session as never);
    adapter.beginTurn('c');
    out.length = 0;
    session.play();

    expect(out.find((m) => m.type === 'compactBoundary')).toMatchObject({ entryId: 'comp-7' });
  });

  it('omits entryId when no compaction entry is on the branch (never fabricated)', () => {
    const out: ExtensionToWebviewMessage[] = [];
    const adapter = makeAdapter(out);
    const session = fakeSession([
      { type: 'compaction_end', reason: 'manual', aborted: false, willRetry: false, result: { summary: 'done', firstKeptEntryId: 'k1', tokensBefore: 43000 } },
    ]);
    adapter.subscribe(session as never);
    adapter.beginTurn('c');
    out.length = 0;
    session.play();

    const boundary = out.find((m) => m.type === 'compactBoundary');
    expect(boundary && 'entryId' in boundary).toBe(false);
  });
});

describe('PiStreamAdapter budget enforcement (US-008)', () => {
  const turn = (): unknown[] => [
    { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }], usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: {} } } },
    { type: 'agent_end', messages: [], willRetry: false },
  ];

  it('emits budgetWarning at ≥80% on natural turn end', () => {
    const out: ExtensionToWebviewMessage[] = [];
    const onStop = vi.fn();
    const adapter = makeBudgetAdapter(out, 1.0, onStop); // limit $1.00
    const session = fakeSessionWithCost(turn(), () => 0.85); // 85%
    adapter.subscribe(session as never);
    adapter.beginTurn('c');
    session.play();

    const warn = out.find((m): m is Extract<ExtensionToWebviewMessage, { type: 'budgetWarning' }> => m.type === 'budgetWarning');
    expect(warn).toMatchObject({ currentSpend: 0.85, limit: 1.0 });
    expect(warn?.percentUsed).toBeCloseTo(85);
    expect(out.some((m) => m.type === 'budgetExceeded')).toBe(false);
    expect(onStop).not.toHaveBeenCalled();
  });

  it('emits budgetExceeded and aborts the turn in-flight when cumulative cost crosses the limit', () => {
    const out: ExtensionToWebviewMessage[] = [];
    const onStop = vi.fn();
    const adapter = makeBudgetAdapter(out, 1.0, onStop);
    const session = fakeSessionWithCost(turn(), () => 1.2); // over limit mid-turn
    adapter.subscribe(session as never);
    adapter.beginTurn('c');
    session.play();

    const exceeded = out.find((m): m is Extract<ExtensionToWebviewMessage, { type: 'budgetExceeded' }> => m.type === 'budgetExceeded');
    expect(exceeded).toMatchObject({ finalSpend: 1.2, limit: 1.0 });
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it('settles a budget-stopped turn through the normal agent_end path — done/processing/idle/stopInfo, never sessionCancelled', () => {
    const out: ExtensionToWebviewMessage[] = [];
    // The host's real onBudgetStop is graceful: it never calls markAborted, so agent_end must settle
    // the turn exactly like a natural completion. This is the claim the US-008 tests never asserted.
    const adapter = makeBudgetAdapter(out, 1.0, () => undefined);
    const session = fakeSessionWithCost(turn(), () => 1.2);
    adapter.subscribe(session as never);
    adapter.beginTurn('c');
    session.play();

    const tail = out.slice(out.findIndex((m) => m.type === 'done'));
    expect(tail.map((m) => m.type)).toEqual(['done', 'processing', 'sessionStateChanged', 'stopInfo']);
    expect(tail[1]).toMatchObject({ isProcessing: false });
    expect(tail[2]).toMatchObject({ state: 'idle' });
    expect(out.some((m) => m.type === 'sessionCancelled')).toBe(false);
  });

  it('re-arms in-flight enforcement per turn, so raising the limit does not leave the next turn unbounded', () => {
    const out: ExtensionToWebviewMessage[] = [];
    const onStop = vi.fn();
    let limit = 1.0;
    let cost = 1.1;
    const adapter = new PiStreamAdapter({
      onMessage: (m) => out.push(m),
      cwd: '/cwd',
      sessionId: () => 'SID',
      modelValue: () => 'claude-opus-4-8',
      defaultModelValue: () => 'claude-opus-4-8',
      contextWindow: () => 1_000_000,
      supportedModels: () => [{ value: 'claude-opus-4-8', displayName: 'Opus 4.8', description: '' }],
      accountInfo: () => ({ model: 'claude-opus-4-8', subscriptionType: 'apikey' }),
      permissionMode: () => 'default',
      apiKeySource: () => 'apikey',
      budgetLimit: () => limit,
      showCacheMissNotices: () => false,
      onBudgetStop: onStop,
      onUserMessageDelivered: () => false,
      onMidStreamBatchCommitted: () => undefined,
      onAssistantTextFinal: vi.fn(),
    });
    const session = fakeSessionWithCost(turn(), () => cost);
    adapter.subscribe(session as never);

    adapter.beginTurn('c1');
    session.play();
    expect(onStop).toHaveBeenCalledTimes(1);

    // The user raises the limit; spend never went back below it, so the turn-end re-arm never fired.
    // Without the per-turn re-arm this turn runs with NO in-flight bound at any spend.
    limit = 2.0;
    cost = 2.5;
    adapter.beginTurn('c2');
    session.play();

    expect(onStop).toHaveBeenCalledTimes(2);
    const exceeded = out.filter((m): m is Extract<ExtensionToWebviewMessage, { type: 'budgetExceeded' }> => m.type === 'budgetExceeded');
    expect(exceeded.at(-1)).toMatchObject({ finalSpend: 2.5, limit: 2.0 });
  });

  it('does not emit budget messages when no dollar limit applies (subscription/allowance)', () => {
    const out: ExtensionToWebviewMessage[] = [];
    // `makeAdapter` wires `budgetLimit: () => null` — the subscription/allowance case.
    const adapter = makeAdapter(out);
    const session = fakeSessionWithCost(turn(), () => 99); // far over any limit, but no dollar enforcement
    adapter.subscribe(session as never);
    adapter.beginTurn('c');
    session.play();
    expect(out.some((m) => m.type === 'budgetWarning' || m.type === 'budgetExceeded')).toBe(false);
  });
});

describe('PiStreamAdapter cache-miss notice (Slice 3)', () => {
  // A prior assistant entry with a large cached prompt (reportedCache true via cacheRead>0),
  // then a message_end whose usage re-bills the whole prompt (cacheRead ~ 0, large input) → a miss.
  const priorEntry = {
    type: 'message',
    message: {
      role: 'assistant',
      provider: 'anthropic',
      model: 'claude-opus-4-8',
      timestamp: 0,
      usage: { input: 100, output: 10, cacheRead: 49_900, cacheWrite: 0, cost: { input: 0, output: 0, cacheRead: 0.005, cacheWrite: 0 } },
    },
  };
  const missTurn = (): unknown[] => [
    {
      type: 'message_end',
      message: {
        role: 'assistant',
        provider: 'anthropic',
        model: 'claude-opus-4-8',
        timestamp: 10_000,
        content: [{ type: 'text', text: 'ok' }],
        usage: { input: 50_000, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 50_010, cost: { input: 0.15, output: 0, cacheRead: 0, cacheWrite: 0 } },
      },
    },
    { type: 'agent_end', messages: [], willRetry: false },
  ];

  it('emits cacheMissNotice when the setting is on and a miss is detectable', () => {
    const out: ExtensionToWebviewMessage[] = [];
    const adapter = makeAdapter(out, { showCacheMissNotices: () => true });
    const session = fakeSession(missTurn(), {
      entries: [priorEntry],
      modelRuntime: { getModel: () => ({ cost: { cacheRead: 1.5 } }) },
    });
    adapter.subscribe(session as never);
    adapter.beginTurn('c');
    out.length = 0;
    session.play();

    const notice = out.find(
      (m): m is Extract<ExtensionToWebviewMessage, { type: 'cacheMissNotice' }> => m.type === 'cacheMissNotice',
    );
    expect(notice).toBeDefined();
    // prev prompt = 50_000, this prompt = 50_000, min - cacheRead(0) = 50_000
    expect(notice!.missedTokens).toBe(50_000);
    expect(notice!.idleMs).toBe(10_000);
    expect(notice!.modelChanged).toBe(false);
    expect(notice!.missedCost).toBeGreaterThan(0);
    // Keyed to the paying message's own timestamp (stable id + correct transcript ordering), not Date.now().
    expect(notice!.timestamp).toBe(10_000);
  });

  // Same detectable miss as above, but the paying assistant message ended aborted/errored. pi's TUI
  // suppresses the notice on those stop reasons (interactive-mode.ts:2955-2971 live, :3344 resume), so
  // a cancelled or provider-errored turn must NOT surface a false "prompt cache expired" notice.
  const missTurnWithStop = (stopReason: 'aborted' | 'error' | 'pending'): unknown[] => [
    {
      type: 'message_end',
      message: {
        role: 'assistant',
        provider: 'anthropic',
        model: 'claude-opus-4-8',
        timestamp: 10_000,
        content: [{ type: 'text', text: 'ok' }],
        stopReason,
        usage: { input: 50_000, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 50_010, cost: { input: 0.15, output: 0, cacheRead: 0, cacheWrite: 0 } },
      },
    },
    { type: 'agent_end', messages: [], willRetry: false },
  ];

  // `'pending'` is pi 0.83.0's initial value for a streaming assistant message. `message_end` carries
  // the resolved reason (agent-loop awaits `response.result()`), so it should be unreachable here — but
  // the guard is a denylist, so this pins that an unresolved message's partial usage cannot surface a
  // false "prompt cache expired" notice.
  for (const stopReason of ['aborted', 'error', 'pending'] as const) {
    it(`does NOT emit cacheMissNotice when the turn ended ${stopReason}, despite a detectable miss`, () => {
      const out: ExtensionToWebviewMessage[] = [];
      const adapter = makeAdapter(out, { showCacheMissNotices: () => true });
      const session = fakeSession(missTurnWithStop(stopReason), {
        entries: [priorEntry],
        modelRuntime: { getModel: () => ({ cost: { cacheRead: 1.5 } }) },
      });
      adapter.subscribe(session as never);
      adapter.beginTurn('c');
      out.length = 0;
      session.play();

      expect(out.some((m) => m.type === 'cacheMissNotice')).toBe(false);
    });
  }

  it('does NOT emit cacheMissNotice when the setting is off (default), even with a detectable miss', () => {
    const out: ExtensionToWebviewMessage[] = [];
    const adapter = makeAdapter(out); // showCacheMissNotices defaults to () => false
    const session = fakeSession(missTurn(), {
      entries: [priorEntry],
      modelRuntime: { getModel: () => ({ cost: { cacheRead: 1.5 } }) },
    });
    adapter.subscribe(session as never);
    adapter.beginTurn('c');
    out.length = 0;
    session.play();

    expect(out.some((m) => m.type === 'cacheMissNotice')).toBe(false);
  });

  it('suppresses a miss below the display threshold (< 20k tokens and < $0.10)', () => {
    // Prior cached prompt of ~10k, then a full re-bill: missedTokens ~10k, cost tiny → under the gate.
    const smallPrior = {
      type: 'message',
      message: {
        role: 'assistant',
        provider: 'anthropic',
        model: 'claude-opus-4-8',
        timestamp: 0,
        usage: { input: 100, output: 10, cacheRead: 9_900, cacheWrite: 0, cost: { input: 0, output: 0, cacheRead: 0.001, cacheWrite: 0 } },
      },
    };
    const smallMiss: unknown[] = [
      {
        type: 'message_end',
        message: {
          role: 'assistant',
          provider: 'anthropic',
          model: 'claude-opus-4-8',
          timestamp: 5_000,
          content: [{ type: 'text', text: 'ok' }],
          usage: { input: 10_000, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 10_010, cost: { input: 0.001, output: 0, cacheRead: 0, cacheWrite: 0 } },
        },
      },
      { type: 'agent_end', messages: [], willRetry: false },
    ];
    const out: ExtensionToWebviewMessage[] = [];
    const adapter = makeAdapter(out, { showCacheMissNotices: () => true });
    const session = fakeSession(smallMiss, { entries: [smallPrior], modelRuntime: { getModel: () => undefined } });
    adapter.subscribe(session as never);
    adapter.beginTurn('c');
    out.length = 0;
    session.play();

    expect(out.some((m) => m.type === 'cacheMissNotice')).toBe(false);
  });

  it('a malformed entry (missing usage) does not throw out of the listener or block agent_end', () => {
    // getEntries returns a corrupt assistant entry with no `usage`; detectCacheMiss would throw on it.
    // The cosmetic block must swallow it so the turn still settles (agent_end → sessionStateChanged idle).
    const corruptPrior = { type: 'message', message: { role: 'assistant', provider: 'anthropic', model: 'x', timestamp: 0 } };
    const out: ExtensionToWebviewMessage[] = [];
    const adapter = makeAdapter(out, { showCacheMissNotices: () => true });
    const session = fakeSession(missTurn(), {
      entries: [corruptPrior],
      modelRuntime: { getModel: () => ({ cost: { cacheRead: 1.5 } }) },
    });
    adapter.subscribe(session as never);
    adapter.beginTurn('c');
    out.length = 0;
    expect(() => session.play()).not.toThrow();
    // No notice (detection failed), but the turn still settled to idle.
    expect(out.some((m) => m.type === 'cacheMissNotice')).toBe(false);
    expect(out.some((m) => m.type === 'sessionStateChanged')).toBe(true);
  });

  it('a healthy cache-hit turn (prompt served from cache) emits no notice even with the setting on', () => {
    // Steady state: the paying turn re-reads the whole cached prompt (cacheRead ≈ input, no re-bill),
    // so detectCacheMiss finds no significant miss. The setting is ON — proving the gate is the
    // detection result, not the toggle. Guards against a false notice firing on every normal turn.
    const healthyTurn: unknown[] = [
      {
        type: 'message_end',
        message: {
          role: 'assistant',
          provider: 'anthropic',
          model: 'claude-opus-4-8',
          timestamp: 10_000,
          content: [{ type: 'text', text: 'ok' }],
          usage: { input: 100, output: 10, cacheRead: 49_900, cacheWrite: 0, totalTokens: 50_010, cost: { input: 0, output: 0, cacheRead: 0.005, cacheWrite: 0 } },
        },
      },
      { type: 'agent_end', messages: [], willRetry: false },
    ];
    const out: ExtensionToWebviewMessage[] = [];
    const adapter = makeAdapter(out, { showCacheMissNotices: () => true });
    const session = fakeSession(healthyTurn, {
      entries: [priorEntry],
      modelRuntime: { getModel: () => ({ cost: { cacheRead: 1.5 } }) },
    });
    adapter.subscribe(session as never);
    adapter.beginTurn('c');
    out.length = 0;
    session.play();

    expect(out.some((m) => m.type === 'cacheMissNotice')).toBe(false);
  });
});

describe('logRawStopReason', () => {
  const rawLines = (): string[] =>
    vi.mocked(log).mock.calls.filter((c) => String(c[0]).includes('rawStopReason')).map((c) => String(c[1]));

  /** Drive a completed assistant message through the adapter the way a real turn ends. */
  function endTurn(stopReason: string, rawStopReason: string): void {
    const out: ExtensionToWebviewMessage[] = [];
    const adapter = makeAdapter(out);
    const message = { role: 'assistant', content: [], stopReason, rawStopReason, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
    (adapter as unknown as { logRawStopReason: (m: unknown) => void }).logRawStopReason(message);
  }

  it('logs the provider vocabulary for a turn that ended in error', () => {
    vi.mocked(log).mockClear();
    endTurn('error', 'overloaded_error');
    expect(rawLines()).toEqual(['error']);
  });

  it('logs an aborted turn', () => {
    vi.mocked(log).mockClear();
    endTurn('aborted', 'cancelled');
    expect(rawLines()).toEqual(['aborted']);
  });

  it('stays silent on toolUse, which ends every single tool call', () => {
    // A denylist that forgot `toolUse` emitted one line per tool call — a 50-call session buried the
    // diagnostic under 50 useless lines.
    vi.mocked(log).mockClear();
    endTurn('toolUse', 'tool_use');
    endTurn('stop', 'end_turn');
    endTurn('length', 'max_tokens');
    expect(rawLines()).toEqual([]);
  });
});
