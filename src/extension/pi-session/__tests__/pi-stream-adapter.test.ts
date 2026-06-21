import { describe, it, expect, vi } from 'vitest';
import { PiStreamAdapter, isNothingToCompact } from '../pi-stream-adapter';
import type { ExtensionToWebviewMessage } from '../../../shared/types/messages';
import type { ModelInfo } from '../../../shared/types/settings';

/** A SessionManager stub whose active branch ends with a single user entry (the rewind/id key). */
function fakeSessionManager(userEntryId = 'u-entry') {
  return {
    getLeafId: () => userEntryId,
    getBranch: () => [{ type: 'message', id: userEntryId, parentId: null, timestamp: '', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } }],
  };
}

function fakeSession(events: unknown[]) {
  let listener: ((e: unknown) => void) | undefined;
  return {
    sessionId: 'SID',
    sessionManager: fakeSessionManager(),
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
    budgetLimit: () => null,
    onBudgetStop: () => undefined,
    onUserMessageDelivered: () => undefined,
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
    contextWindow: () => 1_000_000,
    supportedModels: () => models,
    accountInfo: () => ({ model: 'claude-opus-4-8', subscriptionType: 'apikey' }),
    permissionMode: () => 'default',
    apiKeySource: () => 'apikey',
    budgetLimit: () => limit,
    onBudgetStop: onStop,
    onUserMessageDelivered: () => undefined,
    onAssistantTextFinal: vi.fn(),
  });
}

/** A session whose cumulative cost is controllable per read (so a turn can cross the limit mid-flight). */
function fakeSessionWithCost(events: unknown[], cost: () => number) {
  let listener: ((e: unknown) => void) | undefined;
  return {
    sessionId: 'SID',
    sessionManager: fakeSessionManager(),
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
