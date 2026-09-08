import { describe, it, expect, vi } from 'vitest';
import { log } from '../../logger';
import { PiStreamAdapter } from '../pi-stream-adapter';
import type { ExtensionToWebviewMessage } from '../../../shared/types/messages';
import type { ModelInfo } from '../../../shared/types/settings';

vi.mock('../../logger', () => ({ log: vi.fn() }));

/** A session stub carrying the seams the compaction and message_end handlers read. */
function fakeSession(events: unknown[]) {
  let listener: ((e: unknown) => void) | undefined;
  return {
    sessionId: 'SID',
    sessionManager: {
      getLeafId: () => 'u-entry',
      getBranch: () => [
        { type: 'message', id: 'u-entry', parentId: null, timestamp: '', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } },
      ],
      getEntries: () => [],
    },
    modelRuntime: { getModel: () => undefined },
    subscribe: (l: (e: unknown) => void) => { listener = l; return () => undefined; },
    setAutoCompactionEnabled: () => undefined,
    getContextUsage: () => ({ tokens: 900_000, contextWindow: 1_000_000, percent: 90 }),
    getSessionStats: () => ({ sessionId: 'SID', cost: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }),
    getLastAssistantText: () => '',
    play: () => { for (const e of events) listener?.(e); },
  };
}

function makeAdapter(
  out: ExtensionToWebviewMessage[],
  gates?: { showCacheMissNotices?: () => boolean; showThinkingDroppedNotices?: () => boolean },
): PiStreamAdapter {
  const models: ModelInfo[] = [{ value: 'claude-opus-4-8', displayName: 'Opus 4.8', description: '' }];
  return new PiStreamAdapter({
    onMessage: (m) => out.push(m),
    cwd: '/cwd',
    sessionId: () => 'SID',
    modelValue: () => 'claude-opus-4-8',
    defaultModelValue: () => 'claude-opus-4-8',
    contextWindow: () => 1_000_000,
    supportedModels: () => models,
    permissionMode: () => 'default',
    budgetLimit: () => null,
    sessionCost: () => 0,
    // Both gates default to the values the shipped settings default to, so a test that says nothing is
    // testing what a user with untouched settings gets.
    showCacheMissNotices: gates?.showCacheMissNotices ?? (() => false),
    showThinkingDroppedNotices: gates?.showThinkingDroppedNotices ?? (() => true),
    onBudgetStop: () => undefined,
    onUserMessageDelivered: () => false,
    onMidStreamBatchCommitted: () => undefined,
    onTurnStateChanged: () => undefined,
  });
}

/** Run the events through a subscribed adapter and return everything that reached the webview. */
function drive(events: unknown[], gates?: Parameters<typeof makeAdapter>[1]): ExtensionToWebviewMessage[] {
  const out: ExtensionToWebviewMessage[] = [];
  const adapter = makeAdapter(out, gates);
  const session = fakeSession(events);
  adapter.subscribe(session as never);
  adapter.beginTurn('c');
  out.length = 0;
  session.play();
  return out;
}

/** An assistant message_end carrying the diagnostics array pi copies from the Anthropic response. */
function assistantMessageEnd(diagnostics: unknown): unknown {
  return {
    type: 'message_end',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: 'ok' }],
      stopReason: 'stop',
      timestamp: 1_700_000_000_000,
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      diagnostics,
    },
  };
}

describe('PiStreamAdapter: an aborted compaction explains itself (3A)', () => {
  /**
   * pi 0.85.0 hard-codes `willRetry: false` and omits `errorMessage` at all three of its `aborted: true`
   * emit sites, so this pins PASSTHROUGH of a hand-built event rather than behaviour a user can reach.
   * It is what catches a later pi that starts varying either field.
   */
  it('passes a hand-built willRetry through to the card unchanged', () => {
    const out = drive([
      { type: 'compaction_end', reason: 'threshold', result: undefined, aborted: true, willRetry: true },
    ]);

    const aborted = out.find((m) => m.type === 'compactionAborted');
    expect(aborted).toMatchObject({ type: 'compactionAborted', trigger: 'threshold', willRetry: true });
    expect(aborted && 'willRetry' in aborted && aborted.willRetry).toBe(true);
    expect(out.some((m) => m.type === 'statusUpdate' && m.status === 'ready')).toBe(true);
  });

  it('emits compactionAborted when pi supplies no errorMessage, which is every real abort today', () => {
    const out = drive([
      { type: 'compaction_end', reason: 'manual', result: undefined, aborted: false, willRetry: false, errorMessage: undefined },
      { type: 'compaction_end', reason: 'manual', result: undefined, aborted: true, willRetry: false },
    ]);

    const aborted = out.filter((m) => m.type === 'compactionAborted');
    expect(aborted).toHaveLength(1);
    expect(aborted[0]).toMatchObject({ trigger: 'manual', willRetry: false });
    // Never fabricated: pi gave no message, so the field is absent rather than an empty string.
    expect(aborted[0] && 'errorMessage' in aborted[0]).toBe(false);
  });

  /** Also passthrough only: pi 0.85.0 computes `errorMessage` as undefined whenever `aborted` is true. */
  it('passes a hand-built errorMessage through on an abort', () => {
    const out = drive([
      { type: 'compaction_end', reason: 'overflow', result: undefined, aborted: true, willRetry: true, errorMessage: 'Compaction aborted: request cancelled' },
    ]);

    expect(out.find((m) => m.type === 'compactionAborted')).toMatchObject({
      trigger: 'overflow',
      willRetry: true,
      errorMessage: 'Compaction aborted: request cancelled',
    });
  });

  it('reports an overflow compaction as overflow, not threshold', () => {
    const out = drive([
      { type: 'compaction_start', reason: 'overflow' },
      { type: 'compaction_end', reason: 'overflow', aborted: false, willRetry: false, result: { summary: 'done', firstKeptEntryId: 'k1', tokensBefore: 43000 } },
    ]);

    const pre = out.find((m) => m.type === 'preCompact');
    const triggering = out.find((m) => m.type === 'autoCompactTriggering');
    const boundary = out.find((m) => m.type === 'compactBoundary');
    for (const m of [pre, triggering, boundary]) {
      expect(m && 'trigger' in m && m.trigger).toBe('overflow');
      expect(m && 'trigger' in m && m.trigger).not.toBe('threshold');
    }
  });

  it('reports a threshold compaction as threshold and still clears the auto banners', () => {
    const out = drive([
      { type: 'compaction_start', reason: 'threshold' },
      { type: 'compaction_end', reason: 'threshold', aborted: false, willRetry: false, result: { summary: 'done', firstKeptEntryId: 'k1', tokensBefore: 43000 } },
    ]);

    expect(out.find((m) => m.type === 'preCompact')).toMatchObject({ trigger: 'threshold' });
    expect(out.find((m) => m.type === 'autoCompactTriggering')).toMatchObject({ trigger: 'threshold', percentUsed: 90 });
    expect(out.some((m) => m.type === 'autoCompactComplete')).toBe(true);
  });

  it('leaves the auto-compaction banners alone for a manual compaction', () => {
    const out = drive([
      { type: 'compaction_start', reason: 'manual' },
      { type: 'compaction_end', reason: 'manual', aborted: false, willRetry: false, result: { summary: 'done', firstKeptEntryId: 'k1', tokensBefore: 43000 } },
    ]);

    expect(out.find((m) => m.type === 'preCompact')).toMatchObject({ trigger: 'manual' });
    expect(out.some((m) => m.type === 'autoCompactTriggering')).toBe(false);
    expect(out.some((m) => m.type === 'autoCompactComplete')).toBe(false);
  });
});

describe('PiStreamAdapter: the compaction reports what it billed (3C)', () => {
  const usage = { input: 1200, output: 800, cacheRead: 400, cacheWrite: 100, totalTokens: 2500, cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.03 } };
  const endWithUsage = { type: 'compaction_end', reason: 'manual', aborted: false, willRetry: false, result: { summary: 'done', firstKeptEntryId: 'k1', tokensBefore: 43000, usage } };

  it('sums the four billed token buckets and sends the raw cost when the gate is on', () => {
    const out = drive([endWithUsage], { showCacheMissNotices: () => true });

    expect(out.find((m) => m.type === 'compactBoundary')).toMatchObject({ billedTokens: 2500, billedCost: 0.03 });
  });

  it('sends a sub-cent cost raw and leaves the display threshold to the webview', () => {
    const cheap = { ...usage, cost: { ...usage.cost, total: 0.004 } };
    const out = drive(
      [{ ...endWithUsage, result: { summary: 'done', firstKeptEntryId: 'k1', tokensBefore: 43000, usage: cheap } }],
      { showCacheMissNotices: () => true },
    );

    expect(out.find((m) => m.type === 'compactBoundary')).toMatchObject({ billedTokens: 2500, billedCost: 0.004 });
  });

  it('omits both billing fields when the cost gate is off (its default)', () => {
    const out = drive([endWithUsage]);

    const boundary = out.find((m) => m.type === 'compactBoundary');
    expect(boundary).toMatchObject({ preTokens: 43000 });
    expect(boundary && 'billedTokens' in boundary).toBe(false);
    expect(boundary && 'billedCost' in boundary).toBe(false);
  });

  it('never fabricates billing when pi reports no usage', () => {
    const out = drive(
      [{ type: 'compaction_end', reason: 'manual', aborted: false, willRetry: false, result: { summary: 'done', firstKeptEntryId: 'k1', tokensBefore: 43000 } }],
      { showCacheMissNotices: () => true },
    );

    const boundary = out.find((m) => m.type === 'compactBoundary');
    expect(boundary && 'billedTokens' in boundary).toBe(false);
    expect(boundary && 'billedCost' in boundary).toBe(false);
  });
});

/**
 * Every `reason` below is one of the four codes Anthropic actually sends, taken from
 * `BetaThinkingDroppedInputTransformation` in the SDK's `resources/beta/messages/messages.d.ts`. pi
 * passes the diagnostic through untouched, so these are the only values that ever reach the adapter.
 * `path` is present on every real transformation and is deliberately not rendered: it indexes the wire
 * request (`messages.{i}.content.{j}`), not the transcript, so it names nothing the reader can find.
 */
describe('PiStreamAdapter: dropped thinking blocks reach the transcript (3B)', () => {
  const oneDrop = [
    {
      type: 'anthropic_input_transformations',
      timestamp: 1_700_000_000_000,
      details: { transformations: [{ type: 'thinking_dropped', path: 'messages.4.content.0', reason: 'prefix_binding_mismatch' }] },
    },
  ];

  it('emits thinkingDroppedNotice at count 1 with both settings at their defaults', () => {
    vi.mocked(log).mockClear();
    const out = drive([assistantMessageEnd(oneDrop)]);

    expect(out.find((m) => m.type === 'thinkingDroppedNotice')).toEqual({
      type: 'thinkingDroppedNotice',
      count: 1,
      reasons: ['the conversation changed since the reasoning was written'],
      timestamp: 1_700_000_000_000,
    });
    // The cost gate is off by default and must not be what decides this. A correctness signal ships on.
    expect(out.some((m) => m.type === 'cacheMissNotice')).toBe(false);
    // The log line is what tells a drop apart from a 400 or a compaction in a user's log.
    expect(log).toHaveBeenCalledWith(
      '[PiStreamAdapter] anthropic dropped %d thinking block(s): %s',
      1,
      'the conversation changed since the reasoning was written',
    );
  });

  it('explains all four binding-check codes rather than printing the enum', () => {
    const out = drive([
      assistantMessageEnd([
        {
          type: 'anthropic_input_transformations',
          timestamp: 1,
          details: {
            transformations: [
              { type: 'thinking_dropped', path: 'messages.1.content.0', reason: 'model_binding_mismatch' },
              { type: 'thinking_dropped', path: 'messages.2.content.0', reason: 'prefix_binding_mismatch' },
              { type: 'thinking_dropped', path: 'messages.3.content.0', reason: 'organization_binding_mismatch' },
              { type: 'thinking_dropped', path: 'messages.4.content.0', reason: 'end_user_binding_mismatch' },
            ],
          },
        },
      ]),
    ]);

    const notice = out.find((m) => m.type === 'thinkingDroppedNotice');
    expect(notice).toMatchObject({
      count: 4,
      reasons: [
        'a different model wrote the reasoning, and the requested model may not read it',
        'the conversation changed since the reasoning was written',
        'the reasoning was written under a different organization',
        'the reasoning was written for a different end user',
      ],
    });
    // No raw code and no wire path survives into what the user reads.
    const rendered = (notice as { reasons: string[] }).reasons.join(' ');
    expect(rendered).not.toContain('_binding_mismatch');
    expect(rendered).not.toContain('messages.');
  });

  it('falls back to the raw code for a reason it does not recognize', () => {
    const out = drive([
      assistantMessageEnd([
        {
          type: 'anthropic_input_transformations',
          timestamp: 1,
          details: { transformations: [{ type: 'thinking_dropped', path: 'messages.7', reason: 'some_future_mismatch' }] },
        },
      ]),
    ]);

    // Hiding a code Damocles has no sentence for would leave the card saying a drop happened for no
    // stated reason. The code is at least greppable.
    expect(out.find((m) => m.type === 'thinkingDroppedNotice')).toMatchObject({
      count: 1,
      reasons: ['some_future_mismatch'],
    });
  });

  it('suppresses the notice when showThinkingDroppedNotices is false', () => {
    const out = drive([assistantMessageEnd(oneDrop)], { showThinkingDroppedNotices: () => false });

    expect(out.some((m) => m.type === 'thinkingDroppedNotice')).toBe(false);
    // Nothing else changes: the turn's own messages still arrive.
    expect(out.some((m) => m.type === 'tokenUsageUpdate' || m.type === 'assistant')).toBe(true);
  });

  it('renders three drops as three reason strings', () => {
    const out = drive([
      assistantMessageEnd([
        {
          type: 'anthropic_input_transformations',
          timestamp: 1,
          details: {
            transformations: [
              { type: 'thinking_dropped', path: 'messages.2', reason: 'organization_binding_mismatch' },
              { type: 'thinking_dropped', reason: 'model_binding_mismatch' },
              // `reason` is required on the real type, so a missing one means pi or Anthropic changed
              // the shape. The card still counts the drop rather than dropping it silently.
              { type: 'thinking_dropped', path: 'messages.9' },
            ],
          },
        },
      ]),
    ]);

    expect(out.find((m) => m.type === 'thinkingDroppedNotice')).toMatchObject({
      count: 3,
      reasons: [
        'the reasoning was written under a different organization',
        'a different model wrote the reasoning, and the requested model may not read it',
        'unknown reason',
      ],
    });
  });

  it('ignores transformations that are not thinking drops', () => {
    const out = drive([
      assistantMessageEnd([
        { type: 'anthropic_input_transformations', timestamp: 1, details: { transformations: [{ type: 'tool_result_truncated', path: 'messages.1' }] } },
        { type: 'some_other_diagnostic', timestamp: 1, details: { transformations: [{ type: 'thinking_dropped', reason: 'wrong diagnostic' }] } },
      ]),
    ]);

    expect(out.some((m) => m.type === 'thinkingDroppedNotice')).toBe(false);
  });

  it('survives a malformed diagnostic without breaking the turn', () => {
    const out = drive([
      assistantMessageEnd([
        { type: 'anthropic_input_transformations', timestamp: 1, details: { transformations: 'not-an-array' } },
        { type: 'anthropic_input_transformations', timestamp: 1, details: { transformations: [null, 7, 'x'] } },
      ]),
    ]);

    expect(out.some((m) => m.type === 'thinkingDroppedNotice')).toBe(false);
    expect(out.some((m) => m.type === 'tokenUsageUpdate' || m.type === 'assistant')).toBe(true);
  });

  it('emits nothing when the message carries no diagnostics at all', () => {
    const out = drive([assistantMessageEnd(undefined)]);

    expect(out.some((m) => m.type === 'thinkingDroppedNotice')).toBe(false);
  });
});
