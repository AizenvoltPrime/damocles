import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { log } from '../../logger';
import { PiStreamAdapter, isNothingToCompact } from '../pi-stream-adapter';
import { TOOL_OUTPUT_COALESCE_MS, ToolOutputCoalescer } from '../tool-output-coalescer';
import { DAMOCLES_TURN_STOPPED_ENTRY } from '../session-store/constants';
import type { ExtensionToWebviewMessage } from '../../../shared/types/messages';
import type { ModelInfo } from '../../../shared/types/settings';
import type { TurnState } from '../session-state';
import type { TurnOutcome } from '../session-state';

vi.mock('../../logger', () => ({ log: vi.fn() }));

interface BranchEntry {
  type: string;
  id: string;
  parentId: string | null;
  timestamp: string;
  message?: unknown;
}

/** A SessionManager stub whose active branch ends with a single user entry (the rewind/id key). */
function fakeSessionManager(userEntryId = 'u-entry', entries: unknown[] = [], history: { headerTimestamp?: string | undefined; branch?: BranchEntry[] | undefined } = {}): {
  getLeafId: () => string;
  getBranch: () => BranchEntry[];
  getEntries: () => unknown[];
  getHeader: () => { timestamp: string } | null;
} {
  const userEntry: BranchEntry = { type: 'message', id: userEntryId, parentId: null, timestamp: '', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } };
  return {
    getLeafId: () => userEntryId,
    getBranch: () => [...(history.branch ?? []), userEntry],
    getEntries: () => entries,
    getHeader: () => (history.headerTimestamp ? { timestamp: history.headerTimestamp } : null),
  };
}

function fakeSession(events: unknown[], opts?: { entries?: unknown[]; modelRuntime?: unknown; headerTimestamp?: string; branch?: BranchEntry[] }) {
  let listener: ((e: unknown) => void) | undefined;
  return {
    sessionId: 'SID',
    sessionManager: fakeSessionManager('u-entry', opts?.entries ?? [], { headerTimestamp: opts?.headerTimestamp, branch: opts?.branch }),
    modelRuntime: opts?.modelRuntime ?? { getModel: () => undefined },
    subscribe: (l: (e: unknown) => void) => { listener = l; return () => undefined; },
    setAutoCompactionEnabled: () => undefined,
    getLastAssistantText: () => 'Hello there!',
    getContextUsage: () => undefined,
    play: () => { for (const e of events) listener?.(e); },
    emit: (e: unknown) => listener?.(e),
  };
}

function makeAdapter(
  out: ExtensionToWebviewMessage[],
  hooks?: {
    onUserMessageDelivered?: (deliveredText: string) => boolean;
    onMidStreamEntryCommitted?: (id: string) => void;
    modelValue?: () => string;
    showCacheMissNotices?: () => boolean;
    showThinkingDroppedNotices?: () => boolean;
    onTurnStateChanged?: (state: TurnState, outcome?: TurnOutcome) => void;
  },
): PiStreamAdapter {
  const models: ModelInfo[] = [{ value: 'claude-opus-4-8', displayName: 'Opus 4.8', description: '' }];
  return new PiStreamAdapter({
    onMessage: (m) => out.push(m),
    cwd: '/cwd',
    sessionId: () => 'SID',
    modelValue: hooks?.modelValue ?? (() => 'claude-opus-4-8'),
    supportedModels: () => models,
    permissionMode: () => 'default',
    budgetLimit: () => null,
    sessionCost: () => 0,
    showCacheMissNotices: hooks?.showCacheMissNotices ?? (() => false),
    showThinkingDroppedNotices: hooks?.showThinkingDroppedNotices ?? (() => true),
    onBudgetStop: () => undefined,
    onUserMessageDelivered: hooks?.onUserMessageDelivered ?? (() => false),
    onMidStreamEntryCommitted: hooks?.onMidStreamEntryCommitted ?? (() => undefined),
    promptEntryId: () => 'u-entry',
    onTurnStateChanged: (...[state, outcome]) => hooks?.onTurnStateChanged?.(state, outcome),
    onAssistantTextFinal: vi.fn(),
  });
}

/** Adapter wired with a dollar budget limit + abort spy for the US-008 budget tests. */
function makeBudgetAdapter(out: ExtensionToWebviewMessage[], limit: number, onStop: () => void, turns?: TurnState[], outcomes?: TurnOutcome[]): PiStreamAdapter {
  const models: ModelInfo[] = [{ value: 'claude-opus-4-8', displayName: 'Opus 4.8', description: '' }];
  return new PiStreamAdapter({
    onMessage: (m) => out.push(m),
    cwd: '/cwd',
    sessionId: () => 'SID',
    modelValue: () => 'claude-opus-4-8',
    supportedModels: () => models,
    permissionMode: () => 'default',
    budgetLimit: () => limit,
    sessionCost: () => 0,
    showCacheMissNotices: () => false,
    showThinkingDroppedNotices: () => true,
    onBudgetStop: onStop,
    onUserMessageDelivered: () => false,
    onMidStreamEntryCommitted: () => undefined,
    promptEntryId: () => 'u-entry',
    onTurnStateChanged: (...[state, outcome]) => {
      turns?.push(state);
      if (outcome) outcomes?.push(outcome);
    },
    onAssistantTextFinal: vi.fn(),
  });
}

/** A persisted assistant entry billing `cost`, the shape pi's session file holds. */
function assistantEntry(cost: number, timestamp = '2026-01-01T00:00:00.000Z', usage = { input: 100, output: 42, cacheRead: 5, cacheWrite: 3 }) {
  return { type: 'message', id: `a-${timestamp}`, parentId: null, timestamp, message: { role: 'assistant', usage: { ...usage, cost: { total: cost } } } };
}

/**
 * pi's agent loop reports a failed or aborted model call only on the assistant `message_end`
 * (`stopReason` plus `errorMessage`); it never emits a `message_update` for the stream's error event. Its
 * `turn_end` follows (pi-agent-core agent-loop.js:141-152).
 */
function terminalAssistant(stopReason: 'error' | 'aborted', errorMessage: string, provider = 'anthropic'): unknown[] {
  const message = { role: 'assistant', content: [], provider, stopReason, errorMessage, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: {} } };
  return [
    { type: 'message_start', message },
    { type: 'message_end', message },
    { type: 'turn_end', message, toolResults: [] },
  ];
}

/**
 * One failed model call as pi ends its run (pi-agent-core agent-loop.js:143-152), with agent-session's
 * verdict on `agent_end` (`_willRetryAfterAgentEnd`, agent-session.js:750 and :797).
 */
function failedCall(errorMessage: string, willRetry: boolean, provider = 'anthropic'): unknown[] {
  return [
    ...terminalAssistant('error', errorMessage, provider),
    { type: 'agent_end', messages: [], willRetry },
  ];
}

/** pi's backoff announcement, emitted before it omits the attempt and sleeps (`_prepareRetry`, agent-session.js:3040). */
function retryStart(attempt: number, errorMessage: string): unknown {
  return { type: 'auto_retry_start', attempt, maxAttempts: 3, delayMs: 2000 * 2 ** (attempt - 1), errorMessage };
}

/** A retried call that answered, then pi's `auto_retry_end` after the listeners saw its `message_end` (agent-session.js:750, :777). */
function answeredRetry(attempt: number): unknown[] {
  const message = { role: 'assistant', content: [{ type: 'text', text: 'The answer' }], provider: 'anthropic', stopReason: 'stop', usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: {} } };
  return [
    { type: 'agent_start' },
    { type: 'message_start', message },
    { type: 'message_end', message },
    { type: 'auto_retry_end', success: true, attempt },
    { type: 'turn_end', toolResults: [] },
    { type: 'agent_end', messages: [], willRetry: false },
  ];
}

/**
 * A session whose file bills `cost()` on each read (so a turn can cross the limit mid-flight). `play` yields a
 * microtask after each event, as pi's own awaits do, so work the adapter defers past a listener runs in order.
 */
function fakeSessionWithCost(events: unknown[], cost: () => number) {
  let listener: ((e: unknown) => void) | undefined;
  const sessionManager = fakeSessionManager();
  sessionManager.getEntries = () => [assistantEntry(cost())];
  return {
    sessionId: 'SID',
    sessionManager,
    modelRuntime: { getModel: () => undefined },
    subscribe: (l: (e: unknown) => void) => { listener = l; return () => undefined; },
    setAutoCompactionEnabled: () => undefined,
    getLastAssistantText: () => 'done',
    play: async () => {
      for (const e of events) {
        listener?.(e);
        await Promise.resolve();
      }
    },
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
  { type: 'agent_settled' },
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
        (prev as { text?: string | undefined }).text = text;
      } else {
        out.push({ type: 'partial', phase, text });
      }
    } else if (m.type === 'sessionUsage') {
      out.push({ type: 'sessionUsage', usage: m.usage, numTurns: m.numTurns });
    } else if (m.type === 'toolCompleted') {
      out.push({ type: 'toolCompleted', toolName: m.toolName, result: m.result });
    } else if (m.type === 'toolStreaming') {
      out.push({ type: 'toolStreaming', name: m.tool.name, input: m.tool.input });
    } else if (m.type === 'tokenUsageUpdate') {
      out.push({ type: 'tokenUsageUpdate', inputTokens: m.inputTokens, cacheReadTokens: m.cacheReadTokens, cacheCreationTokens: m.cacheCreationTokens });
    } else {
      out.push({ type: m.type });
    }
  }
  return out;
}

describe('PiStreamAdapter turn outcome', () => {
  const settle = (message: Record<string, unknown>): TurnOutcome | undefined => {
    const outcomes: Array<TurnOutcome | undefined> = [];
    const adapter = makeAdapter([], { onTurnStateChanged: (state, outcome) => { if (state === 'idle') outcomes.push(outcome); } });
    const session = fakeSession([
      { type: 'message_end', message: { role: 'assistant', content: [], usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: {} }, ...message } },
      { type: 'agent_settled' },
    ]);
    adapter.subscribe(session as never);
    adapter.beginTurn('c');
    session.play();
    expect(outcomes).toHaveLength(1);
    return outcomes[0];
  };

  it('the last assistant message of the turn decides it: completed, an error, or a rate limit', () => {
    expect(settle({ stopReason: 'stop' })).toEqual({ kind: 'completed' });
    expect(settle({ stopReason: 'error', errorMessage: 'invalid x-api-key' })).toEqual({ kind: 'error', message: 'invalid x-api-key' });
    expect(settle({ stopReason: 'error', errorMessage: '429 rate_limit_error' })).toEqual({ kind: 'rateLimit' });
  });
});

describe('PiStreamAdapter golden master (US-P1-5/6)', () => {
  it('emits the SDK-equivalent logical sequence with tool renames and final text', () => {
    const out: ExtensionToWebviewMessage[] = [];
    const turns: TurnState[] = [];
    const adapter = makeAdapter(out, { onTurnStateChanged: (s) => { turns.push(s); } });
    const session = fakeSession(PI_EVENTS, { entries: [assistantEntry(0.05)] });
    adapter.subscribe(session as never);
    adapter.beginTurn('corr-1');
    session.play();

    expect(normalize(out)).toEqual([
      { type: 'processing' },
      { type: 'systemInit' },
      { type: 'availableModels' },
      { type: 'userMessageIdAssigned' },
      { type: 'partial', phase: 'thinking', text: 'Let me think' },
      { type: 'partial', phase: 'text', text: 'Hello there!' },
      { type: 'toolStreaming', name: 'Read', input: { file_path: '/a.ts' } },
      { type: 'toolPending' },
      { type: 'toolCompleted', toolName: 'Read', result: 'file contents' },
      { type: 'toolMetadata' },
      { type: 'assistant' },
      { type: 'tokenUsageUpdate', inputTokens: 100, cacheReadTokens: 5, cacheCreationTokens: 3 },
      {
        type: 'sessionUsage',
        usage: { totalInputTokens: 100, totalOutputTokens: 42, cacheReadTokens: 5, cacheCreationTokens: 3, costUsd: 0.05 },
        numTurns: 1,
      },
      { type: 'done' },
      { type: 'processing' },
      { type: 'stopInfo' },
    ]);
    // The adapter reports the turn lifecycle to its host instead of emitting sessionStateChanged.
    expect(turns).toEqual(['running', 'idle']);
  });

  it('reports the whole file\'s totals and the branch prompt count in sessionUsage, and none in done', () => {
    const out: ExtensionToWebviewMessage[] = [];
    const adapter = makeAdapter(out);
    const earlier: BranchEntry[] = [1, 2].map((i) => ({ type: 'message', id: `u${i}`, parentId: null, timestamp: '', message: { role: 'user' } }));
    const rewound = assistantEntry(0.01, '2026-01-01T00:00:01.000Z', { input: 7, output: 1, cacheRead: 0, cacheWrite: 0 });
    const session = fakeSession(PI_EVENTS, { branch: earlier, entries: [assistantEntry(0.05), rewound] });
    adapter.subscribe(session as never);
    adapter.beginTurn('corr-1');
    session.play();

    const usage = out.find((m) => m.type === 'sessionUsage');
    expect(usage).toEqual({
      type: 'sessionUsage',
      usage: { totalInputTokens: 107, totalOutputTokens: 43, cacheReadTokens: 5, cacheCreationTokens: 3, costUsd: expect.closeTo(0.06) },
      numTurns: 3,
    });
    expect(out.find((m) => m.type === 'done')).toEqual({ type: 'done', data: { type: 'result', session_id: 'SID', is_done: true, stop_reason: null } });
  });

  it('excludes the usage and prompts a fork inherited, derived from the entries on every read', () => {
    const out: ExtensionToWebviewMessage[] = [];
    const adapter = makeAdapter(out);
    const header = '2026-01-02T00:00:00.000Z';
    const inheritedPrompt: BranchEntry = { type: 'message', id: 'u0', parentId: null, timestamp: '2026-01-01T00:00:00.000Z', message: { role: 'user' } };
    const inherited = assistantEntry(0.03, '2026-01-01T00:00:01.000Z', { input: 60, output: 20, cacheRead: 5, cacheWrite: 0 });
    const own = assistantEntry(0.02, '2026-01-02T00:00:01.000Z', { input: 40, output: 22, cacheRead: 0, cacheWrite: 3 });
    const session = fakeSession(PI_EVENTS, { headerTimestamp: header, branch: [inheritedPrompt], entries: [inherited, own] });
    adapter.subscribe(session as never);
    adapter.beginTurn('corr-1');
    session.play();

    expect(out.find((m) => m.type === 'sessionUsage')).toEqual({
      type: 'sessionUsage',
      usage: { totalInputTokens: 40, totalOutputTokens: 22, cacheReadTokens: 0, cacheCreationTokens: 3, costUsd: 0.02 },
      numTurns: 1,
    });
  });

  it('publishes the totals for an aborted turn, whose partial request was billed', () => {
    const out: ExtensionToWebviewMessage[] = [];
    const adapter = makeAdapter(out);
    const session = fakeSession([{ type: 'agent_settled' }], { entries: [assistantEntry(0.04)] });
    adapter.subscribe(session as never);
    adapter.beginTurn('c');
    adapter.markAborted();
    out.length = 0;
    session.play();

    expect(out.map((m) => m.type)).toEqual(['sessionUsage', 'processing']);
    expect(out[0]).toMatchObject({ usage: { costUsd: 0.04 } });
  });

  it('publishes the totals when pi appends a usage entry while the session is idle', () => {
    const out: ExtensionToWebviewMessage[] = [];
    const adapter = makeAdapter(out);
    const warm = { type: 'usage', id: 'w1', parentId: null, timestamp: '2026-01-01T01:00:00.000Z', kind: 'cache_warm', usage: { input: 0, output: 1, cacheRead: 900, cacheWrite: 0, cost: { total: 0.01 } } };
    const session = fakeSession([{ type: 'entry_appended', entry: warm }], { entries: [assistantEntry(0.05), warm] });
    adapter.subscribe(session as never);
    session.play();

    expect(out).toEqual([
      {
        type: 'sessionUsage',
        usage: { totalInputTokens: 100, totalOutputTokens: 43, cacheReadTokens: 905, cacheCreationTokens: 3, costUsd: expect.closeTo(0.06) },
        numTurns: 1,
      },
    ]);
  });

  it('publishes nothing for an appended entry that carries no usage', () => {
    const out: ExtensionToWebviewMessage[] = [];
    const adapter = makeAdapter(out);
    const custom = { type: 'custom', id: 'c1', parentId: null, timestamp: '', customType: 'damocles-checkpoint', data: {} };
    const session = fakeSession([{ type: 'entry_appended', entry: custom }]);
    adapter.subscribe(session as never);
    session.play();

    expect(out).toEqual([]);
  });

  it('reports no model at the session start, whose one publisher is PiSession', () => {
    const out: ExtensionToWebviewMessage[] = [];
    const adapter = makeAdapter(out, { modelValue: () => 'step-5-preview' });
    const session = fakeSession([{ type: 'agent_settled' }]);
    adapter.subscribe(session as never);
    adapter.beginTurn('corr-default');

    expect(out.some((m) => m.type === 'systemInit')).toBe(true);
    expect(out.some((m) => m.type === 'modelUpdate')).toBe(false);
  });

  it('a normal completion settles the turn with done + idle + stopInfo', () => {
    const out: ExtensionToWebviewMessage[] = [];
    const turns: TurnState[] = [];
    const adapter = makeAdapter(out, { onTurnStateChanged: (t) => { turns.push(t); } });
    const session = fakeSession([{ type: 'agent_settled' }]);
    adapter.subscribe(session as never);
    adapter.beginTurn('c');
    out.length = 0;
    turns.length = 0;
    session.play();
    expect(out.map((m) => m.type)).toEqual(['sessionUsage', 'done', 'processing', 'stopInfo']);
    expect(turns).toEqual(['idle']);
  });

  it('a continuation round emits no terminal state: agent_end alone never settles the turn', () => {
    // The boundary keeps the run going for one more request. pi emits `agent_end` per run segment, so
    // settling on it would flash idle mid-turn.
    const out: ExtensionToWebviewMessage[] = [];
    const turns: TurnState[] = [];
    const adapter = makeAdapter(out, { onTurnStateChanged: (t) => { turns.push(t); } });
    const session = fakeSession([
      { type: 'agent_end', messages: [] },
      { type: 'agent_end', messages: [] },
      { type: 'agent_settled' },
    ]);
    adapter.subscribe(session as never);
    adapter.beginTurn('c');
    out.length = 0;
    turns.length = 0;
    session.play();

    expect(out.filter((m) => m.type === 'done')).toHaveLength(1);
    expect(out.filter((m) => m.type === 'stopInfo')).toHaveLength(1);
    expect(out.filter((m) => m.type === 'processing')).toHaveLength(1);
    expect(turns).toEqual(['idle']);
  });

  it('an internally retried turn produces no intermediate idle', () => {
    // pi decides the retry after the failed assistant message has ended, so its message_end cannot carry the turn-state transition.
    const out: ExtensionToWebviewMessage[] = [];
    const turns: TurnState[] = [];
    const adapter = makeAdapter(out, { onTurnStateChanged: (t) => { turns.push(t); } });
    const session = fakeSession([
      ...failedCall('overloaded', true),
      retryStart(1, 'overloaded'),
      ...answeredRetry(1),
      { type: 'agent_settled' },
    ]);
    adapter.subscribe(session as never);
    adapter.beginTurn('c');
    out.length = 0;
    turns.length = 0;
    session.play();

    // One idle for the whole turn, and it arrives at the settle rather than before the retry.
    expect(turns).toEqual(['idle']);
    expect(out.filter((m) => m.type === 'processing')).toHaveLength(1);
  });

  it('a terminal provider error settles once, with the error card ahead of the result', () => {
    const out: ExtensionToWebviewMessage[] = [];
    const turns: TurnState[] = [];
    const adapter = makeAdapter(out, { onTurnStateChanged: (t) => { turns.push(t); } });
    const session = fakeSession([
      ...terminalAssistant('error', 'boom'),
      { type: 'agent_settled' },
    ]);
    adapter.subscribe(session as never);
    adapter.beginTurn('c');
    out.length = 0;
    turns.length = 0;
    session.play();

    expect(out.map((m) => m.type)).toEqual(['userMessageIdAssigned', 'error', 'sessionUsage', 'done', 'processing', 'stopInfo']);
    expect(turns).toEqual(['idle']);
  });

  it('an abort emits the cancel sequence exactly once and no completed result', () => {
    // markAborted is the host's own cancel path; the stream then delivers the aborted assistant error
    // and the settle. Neither may re-announce the cancel or stack a `done` on top of it.
    const out: ExtensionToWebviewMessage[] = [];
    const turns: TurnState[] = [];
    const adapter = makeAdapter(out, { onTurnStateChanged: (t) => { turns.push(t); } });
    const session = fakeSession([
      { type: 'agent_end', messages: [] },
      ...terminalAssistant('aborted', 'cancelled'),
      { type: 'agent_settled' },
    ]);
    adapter.subscribe(session as never);
    adapter.beginTurn('c');
    adapter.markAborted();
    out.length = 0;
    turns.length = 0;
    session.play();

    expect(out.filter((m) => m.type === 'sessionCancelled')).toHaveLength(0); // the host already emitted it
    expect(out.some((m) => m.type === 'done')).toBe(false);
    expect(out.some((m) => m.type === 'stopInfo')).toBe(false);
    expect(out.filter((m) => m.type === 'processing')).toHaveLength(1);
    expect(turns).toEqual(['idle']);
  });

  it('a Stop returns the calls it abandoned and shows no error from its wind-down', () => {
    const out: ExtensionToWebviewMessage[] = [];
    const adapter = makeAdapter(out);
    const events: unknown[] = [{ type: 'tool_execution_start', toolCallId: 'tc-1', toolName: 'read', args: { path: 'README.md' } }];
    const session = fakeSession(events);
    adapter.subscribe(session as never);
    adapter.beginTurn('c');
    session.play();

    expect(adapter.markAborted()).toEqual(['tc-1']);

    events.splice(0, events.length, ...failedCall('This operation was aborted', false), { type: 'agent_settled', aborted: true });
    out.length = 0;
    session.play();
    expect(out.some((m) => m.type === 'error' || m.type === 'authFailure')).toBe(false);
  });

  it('a stream-originated abort emits sessionCancelled once and still lowers the spinner at the settle', () => {
    const out: ExtensionToWebviewMessage[] = [];
    const turns: TurnState[] = [];
    const adapter = makeAdapter(out, { onTurnStateChanged: (t) => { turns.push(t); } });
    const session = fakeSession([
      ...terminalAssistant('aborted', 'cancelled'),
      { type: 'agent_settled' },
    ]);
    adapter.subscribe(session as never);
    adapter.beginTurn('c');
    out.length = 0;
    turns.length = 0;
    session.play();

    expect(out.map((m) => m.type)).toEqual(['userMessageIdAssigned', 'sessionCancelled', 'sessionUsage', 'processing']);
    expect(turns).toEqual(['idle']);
  });

  it('a turn aborted mid-run does not leak its suppression into the next turn', () => {
    const out: ExtensionToWebviewMessage[] = [];
    const adapter = makeAdapter(out);
    const aborted = fakeSession([{ type: 'agent_settled' }]);
    adapter.subscribe(aborted as never);
    adapter.beginTurn('c1');
    adapter.markAborted();
    aborted.play();
    expect(out.some((m) => m.type === 'done')).toBe(false);

    out.length = 0;
    const next = fakeSession([{ type: 'agent_settled' }]);
    adapter.subscribe(next as never);
    adapter.beginTurn('c2');
    out.length = 0;
    next.play();
    expect(out.map((m) => m.type)).toEqual(['sessionUsage', 'done', 'processing', 'stopInfo']);
  });

  it('observedAgentRun is false for a command-only turn and true once the run settles', () => {
    const out: ExtensionToWebviewMessage[] = [];
    const adapter = makeAdapter(out);
    const session = fakeSession([{ type: 'agent_settled' }]);
    adapter.subscribe(session as never);

    adapter.beginTurn('c');
    expect(adapter.observedAgentRun()).toBe(false); // no agent run yet (e.g. extension command)

    session.play();
    expect(adapter.observedAgentRun()).toBe(true); // a real run settled the turn
  });

  it('endTurnWithoutAgentRun releases the spinner (processing:false + idle) with no result card', () => {
    const out: ExtensionToWebviewMessage[] = [];
    const turns: TurnState[] = [];
    const adapter = makeAdapter(out, { onTurnStateChanged: (s) => { turns.push(s); } });
    adapter.beginTurn('c'); // arms processing:true + running, as an extension command would
    out.length = 0;
    turns.length = 0;

    adapter.endTurnWithoutAgentRun();
    expect(out.find((m) => m.type === 'processing' && m.isProcessing === false)).toBeDefined();
    expect(turns).toEqual(['idle']);
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
      { type: 'agent_settled' },
    ]);
    adapter.subscribe(session as never);
    adapter.beginTurn('c');
    session.play();

    const assistantMsg = out.find((m): m is Extract<ExtensionToWebviewMessage, { type: 'assistant' }> => m.type === 'assistant');
    expect(assistantMsg?.data.message.content).toContainEqual({ type: 'text', text: 'Final answer' });
  });

  describe('reply effort', () => {
    const replyAt = (thinkingLevel: string | undefined, reasoning: boolean | undefined) => {
      const out: ExtensionToWebviewMessage[] = [];
      const adapter = makeAdapter(out);
      const session = {
        ...fakeSession([
          { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }], ...(thinkingLevel ? { thinkingLevel } : {}), usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: {} } } },
        ]),
        model: reasoning === undefined ? undefined : { reasoning },
      };
      adapter.subscribe(session as never);
      adapter.beginTurn('c');
      session.play();
      const assistantMsg = out.find((m): m is Extract<ExtensionToWebviewMessage, { type: 'assistant' }> => m.type === 'assistant');
      return assistantMsg?.data.message;
    };

    it("carries the level pi ran the reply at, for a reasoning model", () => {
      expect(replyAt('high', true)?.effort).toBe('high');
    });

    it('carries no effort for a model that does not reason, or a reply pi recorded no level for', () => {
      expect(replyAt('off', false)).not.toHaveProperty('effort');
      expect(replyAt(undefined, true)).not.toHaveProperty('effort');
      expect(replyAt('high', undefined)).not.toHaveProperty('effort');
    });
  });

  it('correlates the user message and maps an aborted error to sessionCancelled', () => {
    const out: ExtensionToWebviewMessage[] = [];
    const adapter = makeAdapter(out);
    const session = fakeSession([
      ...terminalAssistant('aborted', 'cancelled'),
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
      onMidStreamEntryCommitted: (id) => committed.push(id),
    });
    // pi commits the steered user entry AFTER its message_end, persisting the delivered message object itself.
    const branch: unknown[] = [{ type: 'message', id: 'u-prev', parentId: null, timestamp: '', message: { role: 'user', content: [{ type: 'text', text: 'x' }] } }];
    let listener: ((e: unknown) => void) | undefined;
    const session = {
      sessionId: 'SID',
      sessionManager: { getLeafId: () => 'leaf', getBranch: () => branch },
      subscribe: (l: (e: unknown) => void) => { listener = l; return () => undefined; },
    };
    adapter.subscribe(session as never);
    adapter.beginTurn('corr-mid');

    // Queued batch delivered: at its message_end the steered entry is NOT yet committed.
    const batch = { role: 'user', content: [{ type: 'text', text: 'and 2' }] };
    listener!({ type: 'message_end', message: batch });
    expect(committed).toHaveLength(0);

    // pi now commits the steered entry; the next assistant message_start resolves the owed marker to it.
    branch.push({ type: 'message', id: 'u-combined', parentId: 'u-prev', timestamp: '', message: batch });
    listener!({ type: 'message_start', message: { role: 'assistant', content: [] } });
    expect(committed).toEqual(['u-combined']);

    // One-shot: a second assistant message_start in the same turn does not re-record.
    listener!({ type: 'message_start', message: { role: 'assistant', content: [] } });
    expect(committed).toEqual(['u-combined']);
  });

  it('marks a note and a batch delivered at one boundary, each by its own entry, in delivery order', () => {
    const committed: string[] = [];
    const adapter = makeAdapter([], {
      onUserMessageDelivered: () => true,
      onMidStreamEntryCommitted: (id) => committed.push(id),
    });
    const branch: unknown[] = [];
    let listener: ((e: unknown) => void) | undefined;
    const session = {
      sessionId: 'SID',
      sessionManager: { getLeafId: () => 'leaf', getBranch: () => branch },
      subscribe: (l: (e: unknown) => void) => { listener = l; return () => undefined; },
    };
    adapter.subscribe(session as never);
    adapter.beginTurn('corr-both');

    const note = { role: 'user', content: [{ type: 'text', text: 'skip it' }] };
    const batch = { role: 'user', content: [{ type: 'text', text: 'also say hi' }] };
    listener!({ type: 'message_end', message: note });
    branch.push({ type: 'message', id: 'u-note', parentId: null, timestamp: '', message: note });
    listener!({ type: 'message_end', message: batch });
    branch.push({ type: 'message', id: 'u-batch', parentId: 'u-note', timestamp: '', message: batch });
    listener!({ type: 'message_start', message: { role: 'assistant', content: [] } });

    expect(committed).toEqual(['u-note', 'u-batch']);
  });

  it('hands the delivered text to the host, so an injected note can be told from a queued batch', () => {
    const out: ExtensionToWebviewMessage[] = [];
    const delivered: string[] = [];
    const adapter = makeAdapter(out, { onUserMessageDelivered: (text) => { delivered.push(text); return false; } });
    let listener: ((e: unknown) => void) | undefined;
    const session = { sessionId: 'SID', subscribe: (l: (e: unknown) => void) => { listener = l; return () => undefined; } };
    adapter.subscribe(session as never);
    adapter.beginTurn('corr-text');

    listener!({ type: 'message_end', message: { role: 'user', content: [{ type: 'text', text: 'wrong loop, use seq 1 5' }] } });
    // Images and other blocks are dropped, matching how the host joins a queued batch's text.
    listener!({ type: 'message_end', message: { role: 'user', content: [{ type: 'image', data: 'x' }, { type: 'text', text: 'a' }, { type: 'text', text: 'b' }] } });

    expect(delivered).toEqual(['wrong loop, use seq 1 5', 'ab']);
  });

  it('drops a delivered-but-unresolved marker when the turn aborts before its assistant message_start', () => {
    const out: ExtensionToWebviewMessage[] = [];
    const committed: string[] = [];
    const adapter = makeAdapter(out, {
      onUserMessageDelivered: () => true,
      onMidStreamEntryCommitted: (id) => committed.push(id),
    });
    const branch: unknown[] = [];
    let listener: ((e: unknown) => void) | undefined;
    const session = {
      sessionId: 'SID',
      sessionManager: { getLeafId: () => 'leaf', getBranch: () => branch },
      subscribe: (l: (e: unknown) => void) => { listener = l; return () => undefined; },
    };
    adapter.subscribe(session as never);
    adapter.beginTurn('corr-a');

    // A batch is delivered, arming the pending marker — but the turn aborts before any assistant
    // message_start resolves it (e.g. the user hits ESC, or the run errors out).
    const queued = { role: 'user', content: [{ type: 'text', text: 'queued' }] };
    listener!({ type: 'message_end', message: queued });
    expect(committed).toHaveLength(0);

    // A NEW turn begins; beginTurn's reset clears the stale pending marker, so the next assistant
    // message_start of THIS turn records nothing for it.
    branch.push({ type: 'message', id: 'u-queued', parentId: null, timestamp: '', message: queued });
    adapter.beginTurn('corr-b');
    listener!({ type: 'message_start', message: { role: 'assistant', content: [] } });
    expect(committed).toHaveLength(0);
  });

  it('does not record a mid-stream marker when delivery reports no batch owed', () => {
    const out: ExtensionToWebviewMessage[] = [];
    const committed: string[] = [];
    const adapter = makeAdapter(out, {
      onUserMessageDelivered: () => false,
      onMidStreamEntryCommitted: (id) => committed.push(id),
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

  // pi emits tool_execution_start for every call it handles (agent-loop.js:378-383, :414-419), so a call without one never started.
  it('abandons at a Stop only the calls pi has not started, and returns every call in flight', () => {
    const out: ExtensionToWebviewMessage[] = [];
    const adapter = makeAdapter(out);
    let listener: ((e: unknown) => void) | undefined;
    const session = { sessionId: 'SID', subscribe: (l: (e: unknown) => void) => { listener = l; return () => undefined; } };
    adapter.subscribe(session as never);
    adapter.beginTurn('corr-10');

    listener!({ type: 'message_update', assistantMessageEvent: { type: 'toolcall_end', toolCall: { id: 't2', name: 'read', arguments: { path: 'a.ts' } } } });
    listener!({ type: 'tool_execution_start', toolCallId: 't1', toolName: 'bash', args: { command: 'sleep 20' } });
    out.length = 0;

    expect(adapter.markAborted()).toEqual(['t2', 't1']);
    expect(out).toEqual([{ type: 'toolAbandoned', toolUseId: 't2', toolName: 'Read', parentToolUseId: null, reason: 'stopped' }]);
  });

  // pi's abort settles a started call before it returns (agent-loop.js:397, :441, :446); this covers a run that settles without that end.
  it('settles a started call whose end never arrived when the aborted run settles', () => {
    const out: ExtensionToWebviewMessage[] = [];
    const adapter = makeAdapter(out);
    const session = fakeSession([]);
    adapter.subscribe(session as never);
    adapter.beginTurn('corr-10b');
    session.emit({ type: 'tool_execution_start', toolCallId: 't1', toolName: 'bash', args: { command: 'sleep 20' } });
    adapter.markAborted();
    out.length = 0;

    session.emit({ type: 'agent_settled', aborted: true });
    expect(out.filter((m) => m.type === 'toolAbandoned')).toEqual([
      { type: 'toolAbandoned', toolUseId: 't1', toolName: 'Bash', parentToolUseId: null, reason: 'stopped' },
    ]);
  });

  // Order for a running call aborted mid-execute: the tool rejects (bash.js:270-271), executePreparedToolCall turns that
  // into an error result with its durationMs (agent-loop.js:583-591), tool_result handlers run (:598-639), then
  // tool_execution_end (:397, :646-655) and the persisted toolResult (:398-399) follow the Stop's markAborted.
  it('shows the result pi recorded for a call it executed when the late end arrives after a Stop', () => {
    const out: ExtensionToWebviewMessage[] = [];
    const adapter = makeAdapter(out);
    let listener: ((e: unknown) => void) | undefined;
    const session = { sessionId: 'SID', subscribe: (l: (e: unknown) => void) => { listener = l; return () => undefined; } };
    adapter.subscribe(session as never);
    adapter.beginTurn('corr-11');

    listener!({ type: 'tool_execution_start', toolCallId: 't1', toolName: 'bash', args: { command: 'sleep 20' } });
    adapter.markAborted();
    out.length = 0;
    const result = { content: [{ type: 'text', text: 'Command aborted' }], details: { damoclesCancelled: true } };
    listener!({ type: 'tool_execution_end', toolCallId: 't1', toolName: 'bash', result, isError: true, durationMs: 812 });

    expect(out).toEqual([
      { type: 'toolCompleted', toolUseId: 't1', toolName: 'Bash', result: 'Command aborted', durationMs: 812 },
      { type: 'toolMetadata', toolUseId: 't1', metadata: { damoclesCancelled: true } },
    ]);
  });

  it('shows a call that finished as the Stop landed as completed', () => {
    const out: ExtensionToWebviewMessage[] = [];
    const adapter = makeAdapter(out);
    let listener: ((e: unknown) => void) | undefined;
    const session = { sessionId: 'SID', subscribe: (l: (e: unknown) => void) => { listener = l; return () => undefined; } };
    adapter.subscribe(session as never);
    adapter.beginTurn('corr-12');

    listener!({ type: 'tool_execution_start', toolCallId: 't1', toolName: 'bash', args: { command: 'ls' } });
    adapter.markAborted();
    out.length = 0;
    listener!({ type: 'tool_execution_end', toolCallId: 't1', toolName: 'bash', result: { content: [{ type: 'text', text: 'a.ts' }] }, isError: false, durationMs: 40 });

    expect(out).toEqual([{ type: 'toolCompleted', toolUseId: 't1', toolName: 'Bash', result: 'a.ts', durationMs: 40 }]);
  });

  // An abort that lands while the gate holds a call settles it before execute (agent-loop.js:500-504, :519-523), so it carries no durationMs.
  it('abandons a started call pi never executed when its late end arrives after a Stop, once', () => {
    const out: ExtensionToWebviewMessage[] = [];
    const adapter = makeAdapter(out);
    const session = fakeSession([]);
    adapter.subscribe(session as never);
    adapter.beginTurn('corr-13');

    session.emit({ type: 'tool_execution_start', toolCallId: 't1', toolName: 'bash', args: { command: 'rm -rf build' } });
    adapter.markAborted();
    out.length = 0;
    session.emit({ type: 'tool_execution_end', toolCallId: 't1', toolName: 'bash', result: { content: [{ type: 'text', text: 'Operation aborted' }], details: {} }, isError: true });
    session.emit({ type: 'agent_settled', aborted: true });

    expect(out.filter((m) => m.type !== 'sessionUsage' && m.type !== 'processing')).toEqual([
      { type: 'toolAbandoned', toolUseId: 't1', toolName: 'Bash', parentToolUseId: null, reason: 'stopped' },
    ]);
  });

  it('lands a stopped error result as completed with its marker, outside a Stop too', () => {
    const out: ExtensionToWebviewMessage[] = [];
    const adapter = makeAdapter(out);
    let listener: ((e: unknown) => void) | undefined;
    const session = { sessionId: 'SID', subscribe: (l: (e: unknown) => void) => { listener = l; return () => undefined; } };
    adapter.subscribe(session as never);
    adapter.beginTurn('corr-14');

    listener!({ type: 'tool_execution_start', toolCallId: 't1', toolName: 'bash', args: { command: 'sleep 20' } });
    out.length = 0;
    listener!({ type: 'tool_execution_end', toolCallId: 't1', toolName: 'bash', result: { content: [{ type: 'text', text: 'Command aborted' }], details: { damoclesCancelled: true } }, isError: true, durationMs: 90 });

    expect(out.map((m) => m.type)).toEqual(['toolCompleted', 'toolMetadata']);
  });

  it("reports pi's measured execution time, not the time since tool_execution_start, and none for a call that never ran", () => {
    vi.useFakeTimers();
    try {
      const out: ExtensionToWebviewMessage[] = [];
      const adapter = makeAdapter(out);
      let listener: ((e: unknown) => void) | undefined;
      const session = { sessionId: 'SID', subscribe: (l: (e: unknown) => void) => { listener = l; return () => undefined; } };
      adapter.subscribe(session as never);
      adapter.beginTurn('corr-duration');
      for (const id of ['ran', 'failed', 'denied']) listener!({ type: 'tool_execution_start', toolCallId: id, toolName: 'bash', args: { command: 'ls' } });
      // pi emits tool_execution_start before the permission gate, so this wait is approval time.
      vi.advanceTimersByTime(30_000);
      listener!({ type: 'tool_execution_end', toolCallId: 'ran', toolName: 'bash', result: { content: [{ type: 'text', text: 'ok' }] }, isError: false, durationMs: 1234 });
      listener!({ type: 'tool_execution_end', toolCallId: 'failed', toolName: 'bash', result: { content: [{ type: 'text', text: 'exit 1' }] }, isError: true, durationMs: 56 });
      listener!({ type: 'tool_execution_end', toolCallId: 'denied', toolName: 'bash', result: { content: [{ type: 'text', text: 'denied' }] }, isError: true });

      expect(out.find((m) => m.type === 'toolCompleted' && m.toolUseId === 'ran')).toMatchObject({ durationMs: 1234 });
      expect(out.find((m) => m.type === 'toolFailed' && m.toolUseId === 'failed')).toMatchObject({ durationMs: 56 });
      expect(out.find((m) => m.type === 'toolFailed' && m.toolUseId === 'denied')).not.toHaveProperty('durationMs');
    } finally {
      vi.useRealTimers();
    }
  });

  it('marks a successful result that carries images with imageCount, and never a text-only or failed one', () => {
    const out: ExtensionToWebviewMessage[] = [];
    const adapter = makeAdapter(out);
    let listener: ((e: unknown) => void) | undefined;
    const session = { sessionId: 'SID', subscribe: (l: (e: unknown) => void) => { listener = l; return () => undefined; } };
    adapter.subscribe(session as never);
    adapter.beginTurn('corr-img');
    const png = { type: 'image', data: 'AAAA', mimeType: 'image/png' };
    for (const id of ['img', 'text', 'fail']) listener!({ type: 'tool_execution_start', toolCallId: id, toolName: 'read', args: { path: '/a.png' } });
    listener!({ type: 'tool_execution_end', toolCallId: 'img', toolName: 'read', result: { content: [{ type: 'text', text: 'Read image file [image/png]' }, png, png] }, isError: false });
    listener!({ type: 'tool_execution_end', toolCallId: 'text', toolName: 'read', result: { content: [{ type: 'text', text: 'plain' }] }, isError: false });
    listener!({ type: 'tool_execution_end', toolCallId: 'fail', toolName: 'read', result: { content: [{ type: 'text', text: 'boom' }, png] }, isError: true });

    const completed = out.filter((m) => m.type === 'toolCompleted');
    expect(completed.find((m) => m.toolUseId === 'img')).toMatchObject({ result: 'Read image file [image/png]', imageCount: 2 });
    expect(completed.find((m) => m.toolUseId === 'text')).not.toHaveProperty('imageCount');
    expect(out.find((m) => m.type === 'toolFailed')).not.toHaveProperty('imageCount');
    expect(JSON.stringify(out)).not.toContain('AAAA');
  });

  it('carries the details of an error result, as a reload does, and nothing for a thrown error\'s empty details', () => {
    const out: ExtensionToWebviewMessage[] = [];
    const adapter = makeAdapter(out);
    let listener: ((e: unknown) => void) | undefined;
    const session = { sessionId: 'SID', subscribe: (l: (e: unknown) => void) => { listener = l; return () => undefined; } };
    adapter.subscribe(session as never);
    adapter.beginTurn('corr-details');
    for (const id of ['plan', 'thrown']) listener!({ type: 'tool_execution_start', toolCallId: id, toolName: 'ExitPlanMode', args: {} });
    listener!({ type: 'tool_execution_end', toolCallId: 'plan', toolName: 'ExitPlanMode', result: { content: [{ type: 'text', text: 'revise' }], details: { planVersion: 3 } }, isError: true });
    listener!({ type: 'tool_execution_end', toolCallId: 'thrown', toolName: 'ExitPlanMode', result: { content: [{ type: 'text', text: 'boom' }], details: {} }, isError: true });

    expect(out.filter((m) => m.type === 'toolFailed').map((m) => m.toolUseId)).toEqual(['plan', 'thrown']);
    expect(out.filter((m) => m.type === 'toolMetadata')).toEqual([{ type: 'toolMetadata', toolUseId: 'plan', metadata: { planVersion: 3 } }]);
  });
});

describe('PiStreamAdapter terminal assistant errors', () => {
  it('shows the Claude sign-in banner only for an Anthropic auth rejection; another provider gets the error card', () => {
    const run = (provider: string): ExtensionToWebviewMessage[] => {
      const out: ExtensionToWebviewMessage[] = [];
      const adapter = makeAdapter(out);
      const session = fakeSession([...failedCall('401 {"error":{"message":"Incorrect API key provided","type":"invalid_api_key"}}', false, provider), { type: 'agent_settled' }]);
      adapter.subscribe(session as never);
      adapter.beginTurn('c');
      out.length = 0;
      session.play();
      return out;
    };

    expect(run('anthropic').map((m) => m.type)).toContain('authFailure');
    const stepfun = run('stepfun');
    expect(stepfun.some((m) => m.type === 'authFailure')).toBe(false);
    expect(stepfun.find((m) => m.type === 'error')).toMatchObject({ message: expect.stringContaining('Incorrect API key provided') });
  });
});

/** Each case plays the events in the order pi's agent-session.js emits them (cited per case). */
describe('PiStreamAdapter provider errors and pi auto-retry', () => {
  const run = (
    play: (session: ReturnType<typeof fakeSession>, adapter: PiStreamAdapter) => void,
  ): { out: ExtensionToWebviewMessage[]; outcomes: TurnOutcome[] } => {
    const out: ExtensionToWebviewMessage[] = [];
    const outcomes: TurnOutcome[] = [];
    const adapter = makeAdapter(out, { onTurnStateChanged: (state, outcome) => { if (state === 'idle' && outcome) outcomes.push(outcome); } });
    const session = fakeSession([]);
    adapter.subscribe(session as never);
    adapter.beginTurn('c');
    out.length = 0;
    play(session, adapter);
    return { out, outcomes };
  };
  const playing = (events: unknown[]) => (session: ReturnType<typeof fakeSession>): void => replay(session, events);
  const cards = (out: ExtensionToWebviewMessage[]) => out.filter((m) => m.type === 'error' || m.type === 'authFailure');
  const statuses = (out: ExtensionToWebviewMessage[]) =>
    out.filter((m): m is Extract<ExtensionToWebviewMessage, { type: 'statusUpdate' }> => m.type === 'statusUpdate');

  // _handlePostAgentRun finds it not retryable (:1426) and the retry counter is 0 (:1436), so no auto_retry_* follows.
  it('a non-retryable failure shows one error card before the result, and the turn ends on it', () => {
    const { out, outcomes } = run(playing([...failedCall('400 invalid_request_error: bad tool schema', false), { type: 'agent_settled', aborted: false }]));

    expect(cards(out)).toEqual([{ type: 'error', message: '400 invalid_request_error: bad tool schema' }]);
    expect(out.findIndex((m) => m.type === 'error')).toBeLessThan(out.findIndex((m) => m.type === 'done'));
    expect(statuses(out)).toEqual([]);
    expect(outcomes).toEqual([{ kind: 'error', message: '400 invalid_request_error: bad tool schema' }]);
  });

  // agent_end{willRetry:true} (:750), auto_retry_start (:3040), the retried call, then auto_retry_end{success:true} at its message_end (:777).
  it('a failure pi retries into an answer shows no error card, says it is retrying, and the turn completes', () => {
    const { out, outcomes } = run(playing([
      ...failedCall('529 overloaded_error: Overloaded', true),
      retryStart(1, '529 overloaded_error: Overloaded'),
      ...answeredRetry(1),
      { type: 'agent_settled', aborted: false },
    ]));

    expect(cards(out)).toEqual([]);
    expect(statuses(out)).toEqual([
      { type: 'statusUpdate', status: 'retrying', attempt: 1, maxAttempts: 3 },
      { type: 'statusUpdate', status: 'ready' },
    ]);
    expect(outcomes).toEqual([{ kind: 'completed' }]);
  });

  // pi sends nothing when the backoff sleep ends (_prepareRetry, :3050-3062); the retried call opens with its assistant message_start (agent-loop.js:286).
  it('the retry status ends when the retried call starts, not when it has answered', () => {
    const { out } = run(playing([
      ...failedCall('529 overloaded_error: Overloaded', true),
      retryStart(1, '529 overloaded_error: Overloaded'),
      ...answeredRetry(1),
      { type: 'agent_settled', aborted: false },
    ]));

    const ready = out.findIndex((m) => m.type === 'statusUpdate' && m.status === 'ready');
    expect(ready).toBeGreaterThanOrEqual(0);
    expect(ready).toBeLessThan(out.findIndex((m) => m.type === 'assistant'));
  });

  // agent_end{willRetry:false} once the counter reaches maxRetries (:801), _prepareRetry declines (:3034), auto_retry_end{success:false} (:1436).
  it('a failure that exhausts the retries shows one error card, for the final attempt', () => {
    const { out, outcomes } = run(playing([
      ...failedCall('529 overloaded (1)', true),
      retryStart(1, '529 overloaded (1)'),
      ...failedCall('529 overloaded (2)', true),
      retryStart(2, '529 overloaded (2)'),
      ...failedCall('529 overloaded (3)', true),
      retryStart(3, '529 overloaded (3)'),
      ...failedCall('529 overloaded (4)', false),
      { type: 'auto_retry_end', success: false, attempt: 3, finalError: '529 overloaded (4)' },
      { type: 'agent_settled', aborted: false },
    ]));

    expect(cards(out)).toEqual([{ type: 'error', message: '529 overloaded (4)' }]);
    // Each retried call ends its backoff status as it starts; the final auto_retry_end has nothing left to end.
    expect(statuses(out).map((m) => (m.status === 'retrying' ? m.attempt : m.status))).toEqual([1, 'ready', 2, 'ready', 3, 'ready']);
    expect(outcomes).toEqual([{ kind: 'error', message: '529 overloaded (4)' }]);
  });

  // abort() cancels the backoff (:1909-1918), _prepareRetry's sleep rejects into auto_retry_end{finalError:'Retry cancelled'} (:3012, :3053), then agent_settled{aborted:true}.
  it('a Stop during the retry backoff shows no error card and the turn ends cancelled', () => {
    const { out, outcomes } = run((session, adapter) => {
      replay(session, [...failedCall('529 overloaded_error', true), retryStart(1, '529 overloaded_error')]);
      adapter.markAborted();
      replay(session, [
        { type: 'auto_retry_end', success: false, attempt: 1, finalError: 'Retry cancelled' },
        { type: 'agent_settled', aborted: true },
      ]);
    });

    expect(cards(out)).toEqual([]);
    expect(statuses(out).at(-1)).toEqual({ type: 'statusUpdate', status: 'ready' });
    expect(outcomes).toEqual([{ kind: 'cancelled' }]);
  });

  // With retry disabled agent_end says willRetry:false (:801) and _prepareRetry returns before counting (:3030), so no auto_retry_* events.
  it('a retryable failure with retries disabled shows one error card and no retry status', () => {
    const { out, outcomes } = run(playing([...failedCall('429 rate_limit_error', false), { type: 'agent_settled', aborted: false }]));

    expect(cards(out)).toEqual([{ type: 'error', message: '429 rate_limit_error' }]);
    expect(statuses(out)).toEqual([]);
    expect(outcomes).toEqual([{ kind: 'rateLimit' }]);
  });

  // An overflow is not retryable (:2980) but _checkCompaction omits the attempt and compacts to retry it (:2404-2407, compaction_start at :2477).
  it('an overflow pi compacts and retries shows no error card for the overflowed attempt', () => {
    const { out, outcomes } = run(playing([
      ...failedCall('prompt is too long: 210000 tokens > 200000 maximum', false),
      { type: 'compaction_start', reason: 'overflow' },
      { type: 'compaction_end', reason: 'overflow', aborted: false, willRetry: true, result: { summary: 's', firstKeptEntryId: 'k1', tokensBefore: 210000 } },
      ...answeredRetry(1).filter((e) => (e as { type: string }).type !== 'auto_retry_end'),
      { type: 'agent_settled', aborted: false },
    ]));

    expect(cards(out)).toEqual([]);
    expect(outcomes).toEqual([{ kind: 'completed' }]);
  });

  // _checkCompaction omits the attempt (:2405-2406), then _runAutoCompaction returns before compaction_start with no model or nothing to compact (:2465-2472).
  it('an overflow pi could not start recovering shows its card at the settle', () => {
    const { out } = run(playing([
      ...failedCall('prompt is too long: 210000 tokens > 200000 maximum', false),
      { type: 'agent_settled', aborted: false },
    ]));

    expect(cards(out)).toEqual([{ type: 'error', message: 'prompt is too long: 210000 tokens > 200000 maximum' }]);
  });

  // The recovered call overflowed again: _checkCompaction reports a compaction_end with no compaction_start and keeps the call in context (:2383-2399).
  it('an overflow recovery that failed a second time shows one card, the recovery failure', () => {
    const recoveryFailed = 'Context overflow recovery failed after one compact-and-retry attempt. Try reducing context or switching to a larger-context model.';
    const { out, outcomes } = run(playing([
      ...failedCall('prompt is too long: 210000 tokens > 200000 maximum', false),
      { type: 'compaction_start', reason: 'overflow' },
      { type: 'compaction_end', reason: 'overflow', aborted: false, willRetry: true, result: { summary: 's', firstKeptEntryId: 'k1', tokensBefore: 210000 } },
      { type: 'agent_start' },
      ...failedCall('prompt is too long: 201000 tokens > 200000 maximum', false),
      { type: 'compaction_end', reason: 'overflow', result: undefined, aborted: false, willRetry: false, errorMessage: recoveryFailed },
      { type: 'agent_settled', aborted: false },
    ]));

    expect(cards(out)).toEqual([{ type: 'error', message: recoveryFailed }]);
    expect(outcomes).toEqual([{ kind: 'error', message: 'prompt is too long: 201000 tokens > 200000 maximum' }]);
  });

  // A dropped connection ends the call with the streamed text in its content (agent-loop.js:286-319); pi then omits it and re-runs it (:3040-3048).
  it('a call pi re-runs takes back the text it streamed before failing, as the reload hides it', () => {
    const dropped = { role: 'assistant', content: [{ type: 'text', text: 'Half an ans' }], provider: 'anthropic', stopReason: 'error', errorMessage: 'terminated', usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: {} } };
    const { out } = run(playing([
      { type: 'message_start', message: dropped },
      { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'Half an ans' }, message: dropped },
      { type: 'message_end', message: dropped },
      { type: 'turn_end', toolResults: [] },
      { type: 'agent_end', messages: [], willRetry: true },
      retryStart(1, 'terminated'),
      ...answeredRetry(1),
      { type: 'agent_settled', aborted: false },
    ]));

    const partial = out.find((m): m is Extract<ExtensionToWebviewMessage, { type: 'partial' }> => m.type === 'partial');
    const retracted = out.filter((m) => m.type === 'assistantRetracted');
    expect(retracted).toEqual([{ type: 'assistantRetracted', messageId: partial?.data.messageId }]);
    const answer = out.filter((m): m is Extract<ExtensionToWebviewMessage, { type: 'assistant' }> => m.type === 'assistant').at(-1);
    expect(answer?.data.message.id).not.toBe(partial?.data.messageId);
    expect(out.indexOf(retracted[0]!)).toBeLessThan(out.indexOf(answer!));
    expect(cards(out)).toEqual([]);
  });

  it('a failure pi does not re-run is not taken back', () => {
    const dropped = { role: 'assistant', content: [{ type: 'text', text: 'Half an ans' }], provider: 'anthropic', stopReason: 'error', errorMessage: 'terminated', usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: {} } };
    const { out } = run(playing([
      { type: 'message_start', message: dropped },
      { type: 'message_end', message: dropped },
      { type: 'turn_end', toolResults: [] },
      { type: 'agent_end', messages: [], willRetry: false },
      { type: 'agent_settled', aborted: false },
    ]));

    expect(out.some((m) => m.type === 'assistantRetracted')).toBe(false);
    expect(cards(out)).toEqual([{ type: 'error', message: 'terminated' }]);
  });

  // pi returns from the turn before executing any tool of an errored message (agent-loop.js:143-152).
  const withToolCall = {
    role: 'assistant',
    content: [{ type: 'text', text: 'Reading' }, { type: 'toolCall', id: 'never-ran', name: 'read', arguments: { path: '/a.ts' } }],
    provider: 'anthropic',
    stopReason: 'error',
    errorMessage: 'terminated',
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: {} },
  };
  const streamedToolCall = [
    { type: 'message_start', message: withToolCall },
    { type: 'message_update', assistantMessageEvent: { type: 'toolcall_end', toolCall: withToolCall.content[1] }, message: withToolCall },
    { type: 'message_end', message: withToolCall },
    { type: 'turn_end', toolResults: [] },
  ];

  it('settles the tool cards of a failed call pi does not re-run as not executed when the call ends', () => {
    const { out } = run(playing([...streamedToolCall, { type: 'agent_end', messages: [], willRetry: false }, { type: 'agent_settled', aborted: false }]));

    const abandoned = out.filter((m) => m.type === 'toolAbandoned');
    expect(abandoned).toEqual([{ type: 'toolAbandoned', toolUseId: 'never-ran', toolName: 'Read', parentToolUseId: null, reason: 'failed' }]);
    expect(out.indexOf(abandoned[0]!)).toBeGreaterThan(out.findIndex((m) => m.type === 'assistant'));
    expect(out.indexOf(abandoned[0]!)).toBeLessThan(out.findIndex((m) => m.type === 'error'));
  });

  it('takes back a re-run call together with its tool cards, which never ran', () => {
    const { out } = run(playing([
      ...streamedToolCall,
      { type: 'agent_end', messages: [], willRetry: true },
      retryStart(1, 'terminated'),
      ...answeredRetry(1),
      { type: 'agent_settled', aborted: false },
    ]));

    const streamed = out.find((m): m is Extract<ExtensionToWebviewMessage, { type: 'toolStreaming' }> => m.type === 'toolStreaming');
    expect(out.filter((m) => m.type === 'assistantRetracted')).toEqual([{ type: 'assistantRetracted', messageId: streamed?.messageId }]);
    expect(out.filter((m) => m.type === 'toolAbandoned').map((m) => (m as { toolUseId: string }).toolUseId)).toEqual(['never-ran']);
  });

  it('a Stop after the failed call abandons no card twice', () => {
    const { out } = run((session, adapter) => {
      replay(session, streamedToolCall);
      adapter.markAborted();
    });

    expect(out.filter((m) => m.type === 'toolAbandoned')).toHaveLength(1);
  });

  // An aborted message ends the turn before pi runs its tools (agent-loop.js:143), whoever aborted the run.
  const abortedToolCall = { ...withToolCall, stopReason: 'aborted', errorMessage: 'Request was aborted' };
  const streamedAbortedCall = [
    { type: 'message_start', message: abortedToolCall },
    { type: 'message_update', assistantMessageEvent: { type: 'toolcall_end', toolCall: abortedToolCall.content[1] }, message: abortedToolCall },
    { type: 'message_end', message: abortedToolCall },
    { type: 'turn_end', toolResults: [] },
  ];

  it('settles the tool cards of a call the stream aborted with no Stop as stopped', () => {
    const { out } = run(playing([...streamedAbortedCall, { type: 'agent_end', messages: [] }, { type: 'agent_settled', aborted: true }]));

    expect(out.filter((m) => m.type === 'toolAbandoned')).toEqual([{ type: 'toolAbandoned', toolUseId: 'never-ran', toolName: 'Read', parentToolUseId: null, reason: 'stopped' }]);
    expect(cards(out)).toEqual([]);
  });

  it('a Stop abandons the cards of the call it aborts once, as stopped', () => {
    const { out } = run((session, adapter) => {
      replay(session, streamedAbortedCall.slice(0, 2));
      adapter.markAborted();
      replay(session, streamedAbortedCall.slice(2));
    });

    expect(out.filter((m) => m.type === 'toolAbandoned')).toEqual([{ type: 'toolAbandoned', toolUseId: 'never-ran', toolName: 'Read', parentToolUseId: null, reason: 'stopped' }]);
  });

  // An abort during a tool batch: pi finalizes the call it was running and starts none after it (agent-loop.js:402-404
  // sequential, :429-431 and :449-451 parallel), records the results of the calls it finalized (:398-399, :453-458), ends the turn (:179-180),
  // and the next model call, made under the aborted signal, ends aborted (:141-152); a request setup the signal rejects first ends it on an error stop instead (pi-ai lazy.js:41-44).
  const batch = {
    role: 'assistant',
    content: [
      { type: 'toolCall', id: 'ran', name: 'read', arguments: { path: '/a.ts' } },
      { type: 'toolCall', id: 'skipped-1', name: 'read', arguments: { path: '/b.ts' } },
      { type: 'toolCall', id: 'skipped-2', name: 'bash', arguments: { command: 'ls' } },
    ],
    provider: 'anthropic',
    stopReason: 'toolUse',
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: {} },
  };
  const ranResult = { role: 'toolResult', toolCallId: 'ran', toolName: 'read', content: [{ type: 'text', text: 'Operation aborted' }], isError: true };
  const abortedAfterBatch = { role: 'assistant', content: [], provider: 'anthropic', stopReason: 'aborted', errorMessage: 'Request was aborted', usage: batch.usage };
  const batchCutShort = (between: unknown[] = []) => [
    { type: 'message_start', message: batch },
    ...batch.content.map((toolCall) => ({ type: 'message_update', assistantMessageEvent: { type: 'toolcall_end', toolCall }, message: batch })),
    { type: 'message_end', message: batch },
    { type: 'tool_execution_start', toolCallId: 'ran', toolName: 'read', args: { path: '/a.ts' } },
    { type: 'tool_execution_end', toolCallId: 'ran', toolName: 'read', result: ranResult, isError: true },
    { type: 'message_start', message: ranResult },
    { type: 'message_end', message: ranResult },
    { type: 'turn_end', message: batch, toolResults: [ranResult] },
    ...between,
    { type: 'turn_start' },
    { type: 'message_start', message: abortedAfterBatch },
    { type: 'message_end', message: abortedAfterBatch },
    { type: 'turn_end', message: abortedAfterBatch, toolResults: [] },
    { type: 'agent_end', messages: [], willRetry: false },
    { type: 'agent_settled', aborted: true },
  ];

  it('settles the calls an abort skipped as stopped when the aborted call that follows ends, with no Stop', () => {
    const { out } = run(playing(batchCutShort()));

    expect(out.filter((m) => m.type === 'toolAbandoned')).toEqual([
      { type: 'toolAbandoned', toolUseId: 'skipped-1', toolName: 'Read', parentToolUseId: null, reason: 'stopped' },
      { type: 'toolAbandoned', toolUseId: 'skipped-2', toolName: 'Bash', parentToolUseId: null, reason: 'stopped' },
    ]);
    expect(out.filter((m) => m.type === 'toolFailed').map((m) => (m as { toolUseId: string }).toolUseId)).toEqual(['ran']);
  });

  // pi drains the steering queue into the transcript before the aborted call (agent-loop.js:186, :116-121).
  it('settles the skipped calls when pi delivered a steer before the aborted call', () => {
    const steer = { role: 'user', content: [{ type: 'text', text: 'also check c.ts' }] };
    const { out } = run(playing(batchCutShort([{ type: 'message_start', message: steer }, { type: 'message_end', message: steer }])));

    expect(out.filter((m) => m.type === 'toolAbandoned').map((m) => (m as { toolUseId: string }).toolUseId)).toEqual(['skipped-1', 'skipped-2']);
  });

  it('a Stop during the batch abandons each skipped call once', () => {
    const events = batchCutShort();
    const { out } = run((session, adapter) => {
      replay(session, events.slice(0, 6));
      adapter.markAborted();
      replay(session, events.slice(6));
    });

    // `ran` had started, so it settles at its own end, after the Stop settled the two pi never started.
    expect(out.filter((m) => m.type === 'toolAbandoned').map((m) => (m as { toolUseId: string }).toolUseId)).toEqual(['skipped-1', 'skipped-2', 'ran']);
  });

  it('touches no call of a batch that ran to the end before an aborted call', () => {
    const second = { ...ranResult, toolCallId: 'skipped-1' };
    const third = { ...ranResult, toolCallId: 'skipped-2', toolName: 'bash' };
    const events = batchCutShort().flatMap((e) => ((e as { type: string }).type === 'turn_end' && (e as { message: unknown }).message === batch
      ? [
          { type: 'tool_execution_end', toolCallId: 'skipped-1', toolName: 'read', result: second, isError: true },
          { type: 'tool_execution_end', toolCallId: 'skipped-2', toolName: 'bash', result: third, isError: true },
          e,
        ]
      : [e]));
    const { out } = run(playing(events));

    expect(out.filter((m) => m.type === 'toolAbandoned')).toEqual([]);
  });

  it("a Stop's wind-down failure leaves its cards stopped, not failed", () => {
    const { out } = run((session, adapter) => {
      replay(session, streamedToolCall.slice(0, 2));
      adapter.markAborted();
      replay(session, streamedToolCall.slice(2));
    });

    expect(out.filter((m) => m.type === 'toolAbandoned').map((m) => (m as { reason: string }).reason)).toEqual(['stopped']);
  });

  it('a failed call that showed nothing is taken back with no message', () => {
    const { out } = run(playing([
      ...failedCall('529 overloaded_error', true),
      retryStart(1, '529 overloaded_error'),
      ...answeredRetry(1),
      { type: 'agent_settled', aborted: false },
    ]));

    expect(out.some((m) => m.type === 'assistantRetracted')).toBe(false);
  });

  it('a failure pi moves past without re-running shows its card before what follows', () => {
    const { out } = run(playing([
      ...failedCall('400 invalid_request_error', false),
      { type: 'compaction_start', reason: 'threshold' },
    ]));

    expect(out.findIndex((m) => m.type === 'error')).toBeGreaterThanOrEqual(0);
    expect(out.findIndex((m) => m.type === 'error')).toBeLessThan(out.findIndex((m) => m.type === 'preCompact'));
  });

  it('an Anthropic sign-in failure raises the banner once, only when pi will not retry it', () => {
    const { out } = run(playing([
      ...failedCall('401 authentication_error: OAuth token has expired', false),
      { type: 'agent_settled', aborted: false },
    ]));

    expect(cards(out)).toEqual([{ type: 'authFailure', message: '401 authentication_error: OAuth token has expired' }]);
  });
});

/** Deliver `events` to the adapter subscribed to `session`, in order. */
function replay(session: ReturnType<typeof fakeSession>, events: unknown[]): void {
  for (const e of events) session.emit(e);
}

/**
 * The model call pi makes under an aborted run signal fails its request setup (`model-runtime.js:451-455` in
 * pi-coding-agent 1.1.0), and pi-ai's lazy stream ends it on an error stop (`lazy.js:41-44` in pi-ai 1.1.0), whoever
 * aborted the run. pi persists it after the `message_end` listeners (`agent-session.js:750-764`), and the draft
 * `registerWindDownErrorRecord` returns at its `turn_end` boundary is committed, with its `entry_appended`, before the
 * listeners get that `turn_end` (`agent-session.js:515`, `:636-641`).
 */
describe('PiStreamAdapter abort wind-down errors', () => {
  const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: {} };
  const batch = {
    role: 'assistant',
    content: [
      { type: 'toolCall', id: 'ran', name: 'read', arguments: { path: '/a.ts' } },
      { type: 'toolCall', id: 'skipped', name: 'bash', arguments: { command: 'ls' } },
    ],
    provider: 'anthropic',
    stopReason: 'toolUse',
    usage,
  };
  const ranResult = { role: 'toolResult', toolCallId: 'ran', toolName: 'read', content: [{ type: 'text', text: 'Operation aborted' }], isError: true };
  const errorStop = (errorMessage: string) => ({ role: 'assistant', content: [], provider: 'anthropic', stopReason: 'error', errorMessage, usage });

  function setup() {
    const out: ExtensionToWebviewMessage[] = [];
    const outcomes: TurnOutcome[] = [];
    const adapter = makeAdapter(out, { onTurnStateChanged: (state, outcome) => { if (state === 'idle' && outcome) outcomes.push(outcome); } });
    const branch: unknown[] = [];
    const base = fakeSession([]);
    const session = { ...base, sessionManager: { ...base.sessionManager, getBranch: () => branch } };
    adapter.subscribe(session as never);
    adapter.beginTurn('c');
    out.length = 0;
    const emit = (...events: unknown[]) => { for (const e of events) session.emit(e); };
    const persist = (id: string, message: unknown) => branch.push({ type: 'message', id, parentId: null, timestamp: '', message });
    const record = (entryId: string) => {
      const entry = { type: 'custom', id: `st-${entryId}`, parentId: null, timestamp: '', customType: DAMOCLES_TURN_STOPPED_ENTRY, data: { toolCallIds: [], entryIds: [entryId] } };
      branch.push(entry);
      emit({ type: 'entry_appended', entry });
    };
    /** A batch whose first call pi finalized and whose second it skipped, then the next call's error stop up to its message_end. */
    const cutBatchThen = (failure: unknown) => {
      emit({ type: 'message_start', message: batch });
      for (const toolCall of batch.content) emit({ type: 'message_update', assistantMessageEvent: { type: 'toolcall_end', toolCall }, message: batch });
      emit({ type: 'message_end', message: batch });
      persist('a1', batch);
      emit(
        { type: 'tool_execution_start', toolCallId: 'ran', toolName: 'read', args: { path: '/a.ts' } },
        { type: 'tool_execution_end', toolCallId: 'ran', toolName: 'read', result: ranResult, isError: true },
        { type: 'message_start', message: ranResult },
        { type: 'message_end', message: ranResult },
      );
      persist('r1', ranResult);
      emit({ type: 'turn_end', message: batch, toolResults: [ranResult] }, { type: 'turn_start' }, { type: 'message_start', message: failure }, { type: 'message_end', message: failure });
      persist('a2', failure);
    };
    const settle = (failure: unknown, aborted: boolean) =>
      emit({ type: 'turn_end', message: failure, toolResults: [] }, { type: 'agent_end', messages: [], willRetry: false }, { type: 'agent_settled', aborted });
    return { out, outcomes, adapter, emit, record, cutBatchThen, settle };
  }
  const cards = (out: ExtensionToWebviewMessage[]) => out.filter((m) => m.type === 'error' || m.type === 'authFailure');
  const abandoned = (out: ExtensionToWebviewMessage[]) =>
    out.filter((m): m is Extract<ExtensionToWebviewMessage, { type: 'toolAbandoned' }> => m.type === 'toolAbandoned').map((m) => [m.toolUseId, m.reason]);

  // An extension's ctx.abort(), a manual compaction (agent-session.js:2169) or a session replacement aborts with no Stop.
  it('an abort that is not a Stop: the recorded wind-down error shows no card, the skipped call stops, the turn ends cancelled', () => {
    const t = setup();
    const windDown = errorStop('This operation was aborted');
    t.cutBatchThen(windDown);
    t.record('a2');
    t.settle(windDown, true);

    expect(cards(t.out)).toEqual([]);
    expect(abandoned(t.out)).toEqual([['skipped', 'stopped']]);
    expect(t.out.filter((m) => m.type === 'sessionCancelled')).toHaveLength(1);
    expect(t.outcomes).toEqual([{ kind: 'cancelled' }]);
  });

  it('settles the calls a recorded wind-down error named as stopped, not failed', () => {
    const t = setup();
    const named = { ...errorStop('This operation was aborted'), content: [{ type: 'toolCall', id: 'never-ran', name: 'read', arguments: { path: '/b.ts' } }] };
    t.cutBatchThen(named);
    t.record('a2');
    t.settle(named, true);

    expect(abandoned(t.out)).toEqual([['skipped', 'stopped'], ['never-ran', 'stopped']]);
    expect(cards(t.out)).toEqual([]);
  });

  // The record's turn_end pass runs after the message_end listeners, so the live view decides there too, from the same record.
  it('a Stop landing between the error stop and its turn_end hides the card the record hides', () => {
    const t = setup();
    const windDown = errorStop('This operation was aborted');
    t.cutBatchThen(windDown);
    t.adapter.markAborted();
    t.record('a2');
    t.settle(windDown, true);

    expect(cards(t.out)).toEqual([]);
    expect(abandoned(t.out)).toEqual([['skipped', 'stopped']]);
  });

  it('a failure with no wind-down record shows its card and leaves the skipped call as a reload does', () => {
    const t = setup();
    const failure = errorStop('529 overloaded_error');
    t.cutBatchThen(failure);
    t.settle(failure, false);

    expect(cards(t.out)).toEqual([{ type: 'error', message: '529 overloaded_error' }]);
    expect(abandoned(t.out)).toEqual([]);
    expect(t.outcomes).toEqual([{ kind: 'error', message: '529 overloaded_error' }]);
  });

  // A reload shows the card too: the error entry precedes the leaf at Stop, and the record pass saw a live signal.
  it('a Stop landing after the record pass leaves the card the reload shows', () => {
    const t = setup();
    const failure = errorStop('529 overloaded_error');
    t.cutBatchThen(failure);
    t.adapter.markAborted();
    t.settle(failure, true);

    expect(cards(t.out)).toEqual([{ type: 'error', message: '529 overloaded_error' }]);
  });
});

describe('PiStreamAdapter refusals (US-023)', () => {
  it('routes a model refusal (stopReason error + errorMessage) to a clean error, not authFailure', () => {
    const out: ExtensionToWebviewMessage[] = [];
    const turns: TurnState[] = [];
    const adapter = makeAdapter(out, { onTurnStateChanged: (s) => { turns.push(s); } });
    const session = fakeSession([
      ...terminalAssistant('error', "I'm sorry, but I can't help with that request."),
      { type: 'agent_settled' },
    ]);
    adapter.subscribe(session as never);
    adapter.beginTurn('corr-refusal');
    out.length = 0;
    turns.length = 0;
    session.play();

    const error = out.find((m): m is Extract<ExtensionToWebviewMessage, { type: 'error' }> => m.type === 'error');
    expect(error?.message).toContain("can't help");
    expect(out.some((m) => m.type === 'authFailure')).toBe(false);
    // Turn ends clean: processing stops and the session returns to idle.
    expect(out.some((m) => m.type === 'processing' && m.isProcessing === false)).toBe(true);
    expect(turns).toEqual(['idle']);
  });

  it('still routes a genuine auth error to authFailure (the heuristic is intact)', () => {
    const out: ExtensionToWebviewMessage[] = [];
    const adapter = makeAdapter(out);
    const session = fakeSession([
      ...failedCall('Request failed: 401 Unauthorized (invalid api key)', false),
      { type: 'agent_settled' },
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

describe('PiStreamAdapter context snapshot and compaction billing', () => {
  const end = (stopReason: string, usage: Record<string, number>) => ({ type: 'message_end', message: { role: 'assistant', content: [], stopReason, usage: { ...usage, cost: {} } } });

  it.each(['aborted', 'error'])('keeps the meter on the last good request after an %s one', (stopReason) => {
    const out: ExtensionToWebviewMessage[] = [];
    const adapter = makeAdapter(out);
    const session = fakeSession([
      end('stop', { input: 10, output: 5, cacheRead: 3000, cacheWrite: 100, totalTokens: 3115 }),
      end(stopReason, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 }),
    ]);
    adapter.subscribe(session as never);
    session.play();

    expect(out.filter((m) => m.type === 'tokenUsageUpdate')).toEqual([
      { type: 'tokenUsageUpdate', inputTokens: 10, cacheReadTokens: 3000, cacheCreationTokens: 100 },
    ]);
  });

  it('ignores a clean message that reports no tokens', () => {
    const out: ExtensionToWebviewMessage[] = [];
    const adapter = makeAdapter(out);
    const session = fakeSession([end('stop', { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 })]);
    adapter.subscribe(session as never);
    session.play();

    expect(out.some((m) => m.type === 'tokenUsageUpdate')).toBe(false);
  });

  it('a compaction resets the meter and publishes the spend its summary billed', () => {
    const out: ExtensionToWebviewMessage[] = [];
    const adapter = makeAdapter(out);
    const compaction = { type: 'compaction', id: 'comp-1', parentId: null, timestamp: '2026-01-01T01:00:00.000Z', usage: { input: 20_000, output: 800, cacheRead: 0, cacheWrite: 0, cost: { total: 0.07 } } };
    const session = fakeSession(
      [{ type: 'compaction_end', reason: 'manual', aborted: false, willRetry: false, result: { summary: 's', firstKeptEntryId: 'k1', tokensBefore: 43000 } }],
      { entries: [assistantEntry(0.05), compaction] },
    );
    adapter.subscribe(session as never);
    session.play();

    expect(out.find((m) => m.type === 'tokenUsageUpdate')).toEqual({ type: 'tokenUsageUpdate', inputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 });
    expect(out.find((m) => m.type === 'sessionUsage')).toMatchObject({ usage: { totalInputTokens: 20_100, costUsd: expect.closeTo(0.12) } });
  });
});

describe('PiStreamAdapter budget enforcement (US-008)', () => {
  const turn = (): unknown[] => [
    { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }], usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: {} } } },
    { type: 'agent_settled' },
  ];

  it('emits budgetWarning at ≥80% on natural turn end', async () => {
    const out: ExtensionToWebviewMessage[] = [];
    const onStop = vi.fn();
    const adapter = makeBudgetAdapter(out, 1.0, onStop); // limit $1.00
    const session = fakeSessionWithCost(turn(), () => 0.85); // 85%
    adapter.subscribe(session as never);
    adapter.beginTurn('c');
    await session.play();

    const warn = out.find((m): m is Extract<ExtensionToWebviewMessage, { type: 'budgetWarning' }> => m.type === 'budgetWarning');
    expect(warn).toMatchObject({ currentSpend: 0.85, limit: 1.0 });
    expect(warn?.percentUsed).toBeCloseTo(85);
    expect(out.some((m) => m.type === 'budgetExceeded')).toBe(false);
    expect(onStop).not.toHaveBeenCalled();
  });

  it('emits budgetExceeded and aborts the turn in-flight when cumulative cost crosses the limit', async () => {
    const out: ExtensionToWebviewMessage[] = [];
    const onStop = vi.fn();
    const adapter = makeBudgetAdapter(out, 1.0, onStop);
    const session = fakeSessionWithCost(turn(), () => 1.2); // over limit mid-turn
    adapter.subscribe(session as never);
    adapter.beginTurn('c');
    await session.play();

    const exceeded = out.find((m): m is Extract<ExtensionToWebviewMessage, { type: 'budgetExceeded' }> => m.type === 'budgetExceeded');
    expect(exceeded).toMatchObject({ finalSpend: 1.2, limit: 1.0 });
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it('settles a budget-stopped turn like a natural completion — done/processing/idle/stopInfo, never sessionCancelled', async () => {
    const out: ExtensionToWebviewMessage[] = [];
    // The host's real onBudgetStop is graceful: it never calls markAborted, so the settle must finish
    // the turn exactly like a natural completion. This is the claim the US-008 tests never asserted.
    const turns: TurnState[] = [];
    const outcomes: TurnOutcome[] = [];
    const adapter = makeBudgetAdapter(out, 1.0, () => undefined, turns, outcomes);
    const session = fakeSessionWithCost(turn(), () => 1.2);
    adapter.subscribe(session as never);
    adapter.beginTurn('c');
    await session.play();

    const tail = out.slice(out.findIndex((m) => m.type === 'done'));
    expect(tail.map((m) => m.type)).toEqual(['done', 'processing', 'stopInfo']);
    expect(tail[1]).toMatchObject({ isProcessing: false });
    expect(turns).toEqual(['running', 'idle']);
    expect(outcomes).toEqual([{ kind: 'budget' }]);
    expect(out.some((m) => m.type === 'sessionCancelled')).toBe(false);
  });

  it('re-arms in-flight enforcement per turn, so raising the limit does not leave the next turn unbounded', async () => {
    const out: ExtensionToWebviewMessage[] = [];
    const onStop = vi.fn();
    let limit = 1.0;
    let cost = 1.1;
    const adapter = new PiStreamAdapter({
      onMessage: (m) => out.push(m),
      cwd: '/cwd',
      sessionId: () => 'SID',
      modelValue: () => 'claude-opus-4-8',
      supportedModels: () => [{ value: 'claude-opus-4-8', displayName: 'Opus 4.8', description: '' }],
      permissionMode: () => 'default',
      budgetLimit: () => limit,
      sessionCost: () => cost,
      showCacheMissNotices: () => false,
      showThinkingDroppedNotices: () => true,
      onBudgetStop: onStop,
      onUserMessageDelivered: () => false,
      onMidStreamEntryCommitted: () => undefined,
      promptEntryId: () => 'u-entry',
      onTurnStateChanged: () => undefined,
      onAssistantTextFinal: vi.fn(),
    });
    const session = fakeSessionWithCost(turn(), () => cost);
    adapter.subscribe(session as never);

    adapter.beginTurn('c1');
    await session.play();
    expect(onStop).toHaveBeenCalledTimes(1);

    // The user raises the limit; spend never went back below it, so the turn-end re-arm never fired.
    // Without the per-turn re-arm this turn runs with NO in-flight bound at any spend.
    limit = 2.0;
    cost = 2.5;
    adapter.beginTurn('c2');
    await session.play();

    expect(onStop).toHaveBeenCalledTimes(2);
    const exceeded = out.filter((m): m is Extract<ExtensionToWebviewMessage, { type: 'budgetExceeded' }> => m.type === 'budgetExceeded');
    expect(exceeded.at(-1)).toMatchObject({ finalSpend: 2.5, limit: 2.0 });
  });

  it('checks the in-flight budget after pi has persisted the response that ended', async () => {
    const out: ExtensionToWebviewMessage[] = [];
    const onStop = vi.fn();
    const adapter = makeBudgetAdapter(out, 1.0, onStop);
    let cost = 0.5;
    const session = fakeSessionWithCost([turn()[0]], () => cost);
    adapter.subscribe(session as never);
    adapter.beginTurn('c');
    // pi notifies listeners of message_end and appends the message after them, in the same tick.
    const played = session.play();
    cost = 1.2;
    await played;

    expect(out.find((m) => m.type === 'budgetExceeded')).toMatchObject({ finalSpend: 1.2, limit: 1.0 });
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it('counts only the spend a fork made itself, never what its parent paid', async () => {
    const out: ExtensionToWebviewMessage[] = [];
    const onStop = vi.fn();
    const adapter = makeBudgetAdapter(out, 1.0, onStop);
    const session = fakeSessionWithCost(turn(), () => 0);
    const header = '2026-01-02T00:00:00.000Z';
    session.sessionManager.getHeader = () => ({ timestamp: header });
    session.sessionManager.getEntries = () => [assistantEntry(5.2, '2026-01-01T00:00:00.000Z'), assistantEntry(0.12, '2026-01-02T00:00:01.000Z')];
    adapter.subscribe(session as never);
    adapter.beginTurn('c');
    await session.play();

    expect(out.some((m) => m.type === 'budgetExceeded' || m.type === 'budgetWarning')).toBe(false);
    expect(onStop).not.toHaveBeenCalled();
  });

  it('a resumed conversation starts with no subagent spend and a re-armed latch from the one it replaced', async () => {
    const out: ExtensionToWebviewMessage[] = [];
    const onStop = vi.fn();
    const adapter = makeBudgetAdapter(out, 1.0, onStop);
    adapter.addExternalCost(1.5);
    expect(out.filter((m) => m.type === 'budgetExceeded')).toHaveLength(1);

    adapter.seedResumedUsage(0.1);
    expect(adapter.externalCost).toBe(0);
    adapter.addExternalCost(1.05);
    const exceeded = out.filter((m): m is Extract<ExtensionToWebviewMessage, { type: 'budgetExceeded' }> => m.type === 'budgetExceeded');
    expect(exceeded).toHaveLength(2);
    expect(exceeded[1]!.finalSpend).toBeCloseTo(1.05);
  });

  it('does not emit budget messages when no dollar limit applies (subscription/allowance)', async () => {
    const out: ExtensionToWebviewMessage[] = [];
    // `makeAdapter` wires `budgetLimit: () => null` — the subscription/allowance case.
    const adapter = makeAdapter(out);
    const session = fakeSessionWithCost(turn(), () => 99); // far over any limit, but no dollar enforcement
    adapter.subscribe(session as never);
    adapter.beginTurn('c');
    await session.play();
    expect(out.some((m) => m.type === 'budgetWarning' || m.type === 'budgetExceeded')).toBe(false);
  });
});

describe('PiStreamAdapter per-response billing totals', () => {
  type SessionUsage = Extract<ExtensionToWebviewMessage, { type: 'sessionUsage' }>;
  const isSessionUsage = (m: ExtensionToWebviewMessage): m is SessionUsage => m.type === 'sessionUsage';
  const assistantEnd = { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }], usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: {} } } };
  const toolResultEnd = (usage?: unknown) => ({ type: 'message_end', message: { role: 'toolResult', toolCallId: 't1', content: [], ...(usage ? { usage } : {}) } });

  it('publishes the persisted cost after an assistant response, before the turn settles', async () => {
    const out: ExtensionToWebviewMessage[] = [];
    const adapter = makeAdapter(out);
    let cost = 0.1;
    const session = fakeSessionWithCost([assistantEnd], () => cost);
    adapter.subscribe(session as never);
    adapter.beginTurn('c');
    // pi appends the message after notifying listeners, in the same tick.
    const played = session.play();
    cost = 0.3;
    await played;

    const usage = out.filter(isSessionUsage);
    expect(usage).toHaveLength(1);
    expect(usage[0]!.usage.costUsd).toBe(0.3);
    expect(out.some((m) => m.type === 'done')).toBe(false);
  });

  it('publishes after a tool result only when it carries usage', async () => {
    const out: ExtensionToWebviewMessage[] = [];
    const billed = makeAdapter(out);
    const billedSession = fakeSessionWithCost([toolResultEnd({ input: 3, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } })], () => 0.2);
    billed.subscribe(billedSession as never);
    await billedSession.play();
    expect(out.filter(isSessionUsage)).toHaveLength(1);

    const unbilledOut: ExtensionToWebviewMessage[] = [];
    const unbilled = makeAdapter(unbilledOut);
    const unbilledSession = fakeSessionWithCost([toolResultEnd()], () => 0.2);
    unbilled.subscribe(unbilledSession as never);
    await unbilledSession.play();
    expect(unbilledOut.filter(isSessionUsage)).toHaveLength(0);
  });

  it('feeds the status bar and the in-flight budget from one reading', async () => {
    const out: ExtensionToWebviewMessage[] = [];
    const adapter = makeBudgetAdapter(out, 1.0, () => undefined);
    const session = fakeSessionWithCost([assistantEnd], () => 1.2);
    const getEntries = vi.spyOn(session.sessionManager, 'getEntries');
    adapter.subscribe(session as never);
    adapter.beginTurn('c');
    await session.play();

    const usage = out.find(isSessionUsage);
    const exceeded = out.find((m): m is Extract<ExtensionToWebviewMessage, { type: 'budgetExceeded' }> => m.type === 'budgetExceeded');
    expect(exceeded?.finalSpend).toBe(usage?.usage.costUsd);
    expect(getEntries).toHaveBeenCalledTimes(1);
  });

  it('publishes nothing for a session unsubscribed before the microtask runs', async () => {
    const out: ExtensionToWebviewMessage[] = [];
    const onStop = vi.fn();
    const adapter = makeBudgetAdapter(out, 1.0, onStop);
    const session = fakeSessionWithCost([assistantEnd], () => 1.2);
    const unsubscribe = adapter.subscribe(session as never);
    adapter.beginTurn('c');
    const played = session.play();
    unsubscribe();
    await played;

    expect(out.some((m) => m.type === 'sessionUsage' || m.type === 'budgetExceeded')).toBe(false);
    expect(onStop).not.toHaveBeenCalled();
  });

  it('publishes nothing for a session replaced before the microtask runs', async () => {
    const out: ExtensionToWebviewMessage[] = [];
    const onStop = vi.fn();
    const adapter = makeBudgetAdapter(out, 1.0, onStop);
    const replaced = fakeSessionWithCost([assistantEnd], () => 1.2);
    adapter.subscribe(replaced as never);
    adapter.beginTurn('c');
    const played = replaced.play();
    adapter.subscribe(fakeSessionWithCost([], () => 0) as never);
    await played;

    expect(out.some((m) => m.type === 'sessionUsage' || m.type === 'budgetExceeded')).toBe(false);
    expect(onStop).not.toHaveBeenCalled();
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
    { type: 'agent_settled' },
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
    { type: 'agent_settled' },
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
      { type: 'agent_settled' },
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

  it('a malformed entry (missing usage) does not throw out of the listener or block the settle', () => {
    // getEntries returns a corrupt assistant entry with no `usage`; detectCacheMiss would throw on it.
    // The cosmetic block must swallow it so the turn still settles (the settle reports the idle turn state).
    const corruptPrior = { type: 'message', message: { role: 'assistant', provider: 'anthropic', model: 'x', timestamp: 0 } };
    const out: ExtensionToWebviewMessage[] = [];
    const turns: TurnState[] = [];
    const adapter = makeAdapter(out, { showCacheMissNotices: () => true, onTurnStateChanged: (s) => { turns.push(s); } });
    const session = fakeSession(missTurn(), {
      entries: [corruptPrior],
      modelRuntime: { getModel: () => ({ cost: { cacheRead: 1.5 } }) },
    });
    adapter.subscribe(session as never);
    adapter.beginTurn('c');
    out.length = 0;
    turns.length = 0;
    expect(() => session.play()).not.toThrow();
    // No notice (detection failed), but the turn still settled to idle.
    expect(out.some((m) => m.type === 'cacheMissNotice')).toBe(false);
    expect(turns).toEqual(['idle']);
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
      { type: 'agent_settled' },
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

describe('PiStreamAdapter live shell output (Slice 3)', () => {
  beforeEach(() => {
    // The coalescer uses only setTimeout/clearTimeout, so fake timers drive its whole window.
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** Drive raw pi events into a subscribed adapter, returning the listener and the emitted messages. */
  function driven(): { out: ExtensionToWebviewMessage[]; fire: (e: unknown) => void; adapter: PiStreamAdapter } {
    const out: ExtensionToWebviewMessage[] = [];
    const adapter = makeAdapter(out);
    let listener: ((e: unknown) => void) | undefined;
    const session = { sessionId: 'SID', subscribe: (l: (e: unknown) => void) => { listener = l; return () => undefined; } };
    adapter.subscribe(session as never);
    adapter.beginTurn('corr-live');
    out.length = 0;
    return { out, fire: (e) => listener!(e), adapter };
  }

  /** A pi `partialResult` for a streaming shell tool (bash.ts:353-364 shape). */
  function partial(text: string, truncated = false): unknown {
    return {
      content: [{ type: 'text', text }],
      details: {
        truncation: truncated
          ? { content: text, truncated: true, truncatedBy: 'lines', totalLines: 9000, totalBytes: 90_000, outputLines: 2000, outputBytes: 20_000, lastLinePartial: false, firstLineExceedsLimit: false, maxLines: 2000, maxBytes: 51_200 }
          : undefined,
        fullOutputPath: undefined,
      },
    };
  }

  const progress = (out: ExtensionToWebviewMessage[]): Extract<ExtensionToWebviewMessage, { type: 'toolProgress' }>[] =>
    out.filter((m): m is Extract<ExtensionToWebviewMessage, { type: 'toolProgress' }> => m.type === 'toolProgress');

  it('carries the partialResult snapshot text as `output` for a Bash call', () => {
    const { out, fire } = driven();
    fire({ type: 'tool_execution_start', toolCallId: 'b1', toolName: 'bash', args: { command: 'npm test' } });
    fire({ type: 'tool_execution_update', toolCallId: 'b1', toolName: 'bash', args: {}, partialResult: partial('Test Suites: 3 passed\n') });

    // Leading edge: the first frame for an id lands with no timer advance at all.
    const frames = progress(out);
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ toolUseId: 'b1', toolName: 'Bash', output: 'Test Suites: 3 passed\n' });
    expect(frames[0]!.outputTruncated ?? false).toBe(false);
  });

  it('carries the empty first frame as a defined empty string, not an omitted field', () => {
    // pi's bash sends `content: []` the moment the call starts (contracts amendment 0). The webview
    // routes on `output !== undefined`, so an omitted field here would hide the waiting-for-output pane
    // for the whole of a slow command's silent period.
    const { out, fire } = driven();
    fire({ type: 'tool_execution_start', toolCallId: 'b1', toolName: 'bash', args: { command: 'sleep 30' } });
    fire({ type: 'tool_execution_update', toolCallId: 'b1', toolName: 'bash', args: {}, partialResult: { content: [], details: {} } });

    const first = progress(out)[0];
    expect(first).toBeDefined();
    expect(first!.output).toBe('');
    expect(first!.outputTruncated).toBe(false);
  });

  it('flags outputTruncated when pi reports the snapshot dropped earlier output', () => {
    const { out, fire } = driven();
    fire({ type: 'tool_execution_start', toolCallId: 'b1', toolName: 'bash', args: { command: 'yes' } });
    fire({ type: 'tool_execution_update', toolCallId: 'b1', toolName: 'bash', args: {}, partialResult: partial('tail only', true) });

    expect(progress(out)[0]).toMatchObject({ output: 'tail only', outputTruncated: true });
  });

  it('emits an elapsed-only, uncoalesced frame for a non-shell tool', () => {
    const { out, fire } = driven();
    fire({ type: 'tool_execution_start', toolCallId: 'r1', toolName: 'read', args: { path: '/a.ts' } });
    fire({ type: 'tool_execution_update', toolCallId: 'r1', toolName: 'read', args: {}, partialResult: partial('half the file') });

    // No timer advance: a Read frame must never enter the shell coalescer.
    const frames = progress(out);
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ toolUseId: 'r1', toolName: 'Read' });
    expect('output' in frames[0]!).toBe(false);
    expect('outputTruncated' in frames[0]!).toBe(false);
  });

  it('a non-shell tool stays uncoalesced: every update lands immediately', () => {
    const { out, fire } = driven();
    fire({ type: 'tool_execution_start', toolCallId: 'r1', toolName: 'read', args: { path: '/a.ts' } });
    for (let i = 0; i < 3; i++) {
      fire({ type: 'tool_execution_update', toolCallId: 'r1', toolName: 'read', args: {}, partialResult: partial(`chunk ${i}`) });
    }

    expect(progress(out)).toHaveLength(3);
  });

  it('collapses a burst inside one window to the LATEST payload', () => {
    const { out, fire } = driven();
    fire({ type: 'tool_execution_start', toolCallId: 'b1', toolName: 'bash', args: { command: 'seq 1 100' } });
    for (const text of ['frame-1', 'frame-2', 'frame-3', 'frame-4']) {
      fire({ type: 'tool_execution_update', toolCallId: 'b1', toolName: 'bash', args: {}, partialResult: partial(text) });
      vi.advanceTimersByTime(10); // four frames well inside the 250ms window
    }

    // Leading edge only so far: frames 2-4 are held, not emitted.
    expect(progress(out).map((m) => m.output)).toEqual(['frame-1']);

    vi.advanceTimersByTime(TOOL_OUTPUT_COALESCE_MS);
    // Trailing edge emits the newest snapshot. Dropping the middle frames is lossless because
    // partialResult is a replacement snapshot, not a delta.
    expect(progress(out).map((m) => m.output)).toEqual(['frame-1', 'frame-4']);

    // An idle window closes without emitting, so the next frame is a leading edge again.
    vi.advanceTimersByTime(TOOL_OUTPUT_COALESCE_MS * 2);
    expect(progress(out)).toHaveLength(2);
    fire({ type: 'tool_execution_update', toolCallId: 'b1', toolName: 'bash', args: {}, partialResult: partial('frame-5') });
    expect(progress(out).map((m) => m.output)).toEqual(['frame-1', 'frame-4', 'frame-5']);
  });

  it('beginTurn drops a frame left by a tool that reached no terminal event', () => {
    const { out, fire, adapter } = driven();
    fire({ type: 'tool_execution_start', toolCallId: 'b1', toolName: 'bash', args: { command: 'seq 1 100' } });
    fire({ type: 'tool_execution_update', toolCallId: 'b1', toolName: 'bash', args: {}, partialResult: partial('running...') });
    fire({ type: 'tool_execution_update', toolCallId: 'b1', toolName: 'bash', args: {}, partialResult: partial('held') });

    // No tool_execution_end and no markAborted: a session replaced under the call, or a turn settled
    // through endTurnWithoutAgentRun, leaves the frame with nobody to cancel it.
    adapter.beginTurn('corr-next');
    const startOfNextTurn = out.length;
    vi.advanceTimersByTime(TOOL_OUTPUT_COALESCE_MS * 4);

    // The webview may already have terminalized that card, so repainting liveOutput into the new turn
    // resurrects it.
    expect(out.slice(startOfNextTurn).some((m) => m.type === 'toolProgress')).toBe(false);
  });

  it('tool_execution_end cancels the pending frame so no output lands after toolCompleted', () => {
    const { out, fire } = driven();
    fire({ type: 'tool_execution_start', toolCallId: 'b1', toolName: 'bash', args: { command: 'seq 1 100' } });
    fire({ type: 'tool_execution_update', toolCallId: 'b1', toolName: 'bash', args: {}, partialResult: partial('running...') });
    fire({ type: 'tool_execution_update', toolCallId: 'b1', toolName: 'bash', args: {}, partialResult: partial('still running...') });
    fire({ type: 'tool_execution_end', toolCallId: 'b1', toolName: 'bash', result: { content: [{ type: 'text', text: 'done' }] }, isError: false });

    const completedAt = out.findIndex((m) => m.type === 'toolCompleted');
    expect(completedAt).toBeGreaterThanOrEqual(0);

    // Past the window the held 'still running...' snapshot must be gone, not flushed: a late partial
    // landing after the result would repaint stale output over a finished call.
    vi.advanceTimersByTime(TOOL_OUTPUT_COALESCE_MS * 4);
    expect(out.slice(completedAt).some((m) => m.type === 'toolProgress')).toBe(false);
    expect(progress(out).map((m) => m.output)).toEqual(['running...']);
  });
});

describe('ToolOutputCoalescer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('cancel drops the pending frame instead of flushing it', () => {
    // The regression this guards: a cancel that flushed would repaint a stale partial over a finished
    // tool result. Asserted here directly rather than by mutating the source, which would race the owner.
    const emit = vi.fn();
    const coalescer = new ToolOutputCoalescer<string>(emit);

    coalescer.push('t1', () => 'first');
    coalescer.push('t1', () => 'held');
    coalescer.cancel('t1');
    vi.advanceTimersByTime(TOOL_OUTPUT_COALESCE_MS * 4);

    expect(emit.mock.calls.map((c) => c[0])).toEqual(['first']);
  });

  it('cancel clears the window too, so the next push is a leading edge again', () => {
    const emit = vi.fn();
    const coalescer = new ToolOutputCoalescer<string>(emit);

    coalescer.push('t1', () => 'first');
    coalescer.cancel('t1');
    coalescer.push('t1', () => 'second');

    // No timer advance: a cancel that only dropped the payload would leave the window open and hold this.
    expect(emit.mock.calls.map((c) => c[0])).toEqual(['first', 'second']);
  });

  it('dispose drops every pending frame across ids and never flushes', () => {
    const emit = vi.fn();
    const coalescer = new ToolOutputCoalescer<string>(emit);

    coalescer.push('t1', () => 'a1');
    coalescer.push('t2', () => 'b1');
    coalescer.push('t1', () => 'a2');
    coalescer.push('t2', () => 'b2');
    coalescer.dispose();
    vi.advanceTimersByTime(TOOL_OUTPUT_COALESCE_MS * 4);

    expect(emit.mock.calls.map((c) => c[0])).toEqual(['a1', 'b1']);
  });

  it('builds the held frame at emit time, so a stale clock value cannot be shipped', () => {
    const emit = vi.fn();
    const coalescer = new ToolOutputCoalescer<number>(emit);
    let clock = 0;

    coalescer.push('t1', () => clock);
    clock = 1;
    coalescer.push('t1', () => clock);
    clock = 2;
    vi.advanceTimersByTime(TOOL_OUTPUT_COALESCE_MS);

    // The trailing frame reports 2, the value at emit, not the 1 it had when it was pushed.
    expect(emit.mock.calls.map((c) => c[0])).toEqual([0, 2]);
  });

  it('clear drops every pending frame and leaves the instance usable', () => {
    const emit = vi.fn();
    const coalescer = new ToolOutputCoalescer<string>(emit);

    coalescer.push('t1', () => 'a1');
    coalescer.push('t1', () => 'a2');
    coalescer.clear();
    vi.advanceTimersByTime(TOOL_OUTPUT_COALESCE_MS * 4);
    // A leading edge again, which is what makes this usable for the next turn rather than a teardown.
    coalescer.push('t1', () => 'b1');
    // And the window this opened must find nothing held: a clear that dropped the timers but kept the
    // payloads would flush the pre-clear frame here.
    vi.advanceTimersByTime(TOOL_OUTPUT_COALESCE_MS * 2);

    expect(emit.mock.calls.map((c) => c[0])).toEqual(['a1', 'b1']);
  });

  it('dispose retires the instance, so a later push cannot reopen a window', () => {
    const emit = vi.fn();
    const coalescer = new ToolOutputCoalescer<string>(emit);

    coalescer.push('t1', () => 'a1');
    coalescer.dispose();
    coalescer.push('t1', () => 'after');
    vi.advanceTimersByTime(TOOL_OUTPUT_COALESCE_MS * 4);

    expect(emit.mock.calls.map((c) => c[0])).toEqual(['a1']);
  });

  it('windows are per id, so a busy tool never starves another', () => {
    const emit = vi.fn();
    const coalescer = new ToolOutputCoalescer<string>(emit);

    coalescer.push('t1', () => 'a1');
    coalescer.push('t1', () => 'a2');
    coalescer.push('t2', () => 'b1');
    vi.advanceTimersByTime(TOOL_OUTPUT_COALESCE_MS);

    expect(emit.mock.calls.map((c) => c[0])).toEqual(['a1', 'b1', 'a2']);
  });

  it('honours an injected window rather than a module-level constant', () => {
    const emit = vi.fn();
    const coalescer = new ToolOutputCoalescer<string>(emit, 50);

    coalescer.push('t1', () => 'a1');
    coalescer.push('t1', () => 'a2');
    vi.advanceTimersByTime(50);

    expect(emit.mock.calls.map((c) => c[0])).toEqual(['a1', 'a2']);
  });
});
