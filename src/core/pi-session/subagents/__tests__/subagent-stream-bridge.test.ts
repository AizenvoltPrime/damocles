import { describe, it, expect } from 'vitest';
import { SubagentStreamBridge } from '../subagent-stream-bridge';
import type { ExtensionToWebviewMessage } from '../../../../shared/types/messages';
import type { AgentUsageTotals } from '../../../../shared/usage-accounting';

interface Totals { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number }

interface FakeSession {
  subscribe: (fn: (e: unknown) => void) => () => void;
  emit: (e: unknown) => void;
  messages: readonly unknown[];
  /** What pi's session file sums to. A test adds entries pi writes with no event. */
  totals: Totals;
  sessionManager: { getEntries: () => unknown[]; getBranch: () => unknown[] };
  /** The session's branch: each message pi persisted at its `message_end`, and what a test appends. */
  branch: unknown[];
}

function makeFakeSession(initial: Partial<Totals> = {}): FakeSession {
  let cb: (e: unknown) => void = () => {};
  const totals: Totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, ...initial };
  const branch: unknown[] = [];
  return {
    subscribe: (fn) => {
      cb = fn;
      return () => {};
    },
    emit: (e) => {
      cb(e);
      // pi persists a message after its listeners ran, as `agent-session.js` `_handleAgentEvent` does.
      const { type, message } = e as { type: string; message?: { role: string; usage?: Omit<Totals, 'cost'> & { cost: { total: number } } } };
      if (type === 'message_end' && message) branch.push({ type: 'message', id: `e${branch.length}`, message });
      if (type === 'message_end' && message?.role === 'assistant' && message.usage) {
        const u = message.usage;
        totals.input += u.input;
        totals.output += u.output;
        totals.cacheRead += u.cacheRead;
        totals.cacheWrite += u.cacheWrite;
        totals.cost += u.cost.total;
      }
    },
    messages: [],
    totals,
    // One `usage` entry carrying the running totals sums to what pi's file would.
    sessionManager: { getEntries: () => [{ type: 'usage', usage: { ...totals, cost: { total: totals.cost } } }], getBranch: () => branch },
    branch,
  };
}

/**
 * Append, as `registerWindDownErrorRecord`'s turn_end draft does, a turn-stopped entry naming `message`'s entry, and
 * emit its `entry_appended`. pi commits the draft before listeners get that `turn_end` (`agent-session.js:515`, `:636-641`).
 */
function recordWindDown(session: FakeSession, message: unknown): void {
  const persisted = session.branch.find((e) => (e as { message?: unknown }).message === message) as { id: string };
  const entry = { type: 'custom', id: `st-${persisted.id}`, customType: 'damocles-turn-stopped', data: { toolCallIds: [], entryIds: [persisted.id] } };
  session.branch.push(entry);
  session.emit({ type: 'entry_appended', entry });
}

const usageUpdates = (sent: ExtensionToWebviewMessage[]) =>
  sent.filter((m): m is Extract<ExtensionToWebviewMessage, { type: 'subagentUsageUpdate' }> => m.type === 'subagentUsageUpdate');

const assistantEnd = (u: Omit<Totals, 'cost'>, cost: number) => ({
  type: 'message_end',
  message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }], usage: { ...u, cost: { total: cost } } },
});

function makeBridge(sent: ExtensionToWebviewMessage[], readings: AgentUsageTotals[] = []) {
  return new SubagentStreamBridge({
    parentToolUseId: 'toolu_parent',
    agentId: 'agent-1',
    agentType: 'Explore',
    isBackground: false,
    getSessionId: () => 'parent-sid',
    postMessage: (m) => sent.push(m),
    onUsage: (usage) => readings.push(usage),
  });
}

describe('SubagentStreamBridge streaming', () => {
  it('streams thinking + text deltas as partial messages stamped with parentToolUseId, then seals an assistant message', () => {
    const sent: ExtensionToWebviewMessage[] = [];
    const bridge = makeBridge(sent);
    const session = makeFakeSession();
    bridge.attach(session as never);

    session.emit({ type: 'message_start', message: { role: 'assistant' } });
    session.emit({ type: 'message_update', assistantMessageEvent: { type: 'thinking_start' } });
    session.emit({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: 'hmm' } });
    session.emit({ type: 'message_update', assistantMessageEvent: { type: 'thinking_end' } });
    session.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'hello' } });
    session.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: ' world' } });
    session.emit({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'hello world' }] } });

    const partials = sent.filter((m): m is Extract<ExtensionToWebviewMessage, { type: 'partial' }> => m.type === 'partial');
    expect(partials.length).toBeGreaterThan(0);
    expect(partials.every((p) => p.parentToolUseId === 'toolu_parent')).toBe(true);
    expect(partials.some((p) => p.data.streamingThinking === 'hmm' && p.data.isThinking === true)).toBe(true);
    expect(partials.some((p) => p.data.streamingText === 'hello' && p.data.isThinking === false)).toBe(true);
    expect(partials.some((p) => p.data.streamingText === 'hello world')).toBe(true);

    // All deltas in one assistant message share a single messageId so the webview groups them.
    const msgIds = new Set(partials.map((p) => p.data.messageId));
    expect(msgIds.size).toBe(1);

    const assistant = sent.find((m): m is Extract<ExtensionToWebviewMessage, { type: 'assistant' }> => m.type === 'assistant');
    expect(assistant).toBeDefined();
    expect(assistant!.parentToolUseId).toBe('toolu_parent');
    expect(assistant!.data.session_id).toBe('parent-sid');
    expect(assistant!.data.message.content).toEqual([{ type: 'text', text: 'hello world' }]);
  });

  it('emits the template path once', () => {
    const sent: ExtensionToWebviewMessage[] = [];
    const bridge = makeBridge(sent);

    bridge.emitTemplate('C:\\Users\\me\\.claude\\agents\\engineering\\code-reviewer.md');
    bridge.emitTemplate('C:\\Users\\me\\.claude\\agents\\engineering\\code-reviewer.md');

    const templates = sent.filter((m): m is Extract<ExtensionToWebviewMessage, { type: 'subagentTemplateUpdate' }> => m.type === 'subagentTemplateUpdate');
    expect(templates).toHaveLength(1);
    expect(templates[0]).toMatchObject({ agentToolId: 'toolu_parent', templatePath: 'C:\\Users\\me\\.claude\\agents\\engineering\\code-reviewer.md' });
  });

  it('announces the agent alone on start, so a queued card learns its id before any model or template exists', () => {
    const sent: ExtensionToWebviewMessage[] = [];
    makeBridge(sent).start();
    expect(sent.map((m) => m.type)).toEqual(['subagentStart']);
  });

  it('maps pi toolCall blocks to tool_use in the sealed assistant message', () => {
    const sent: ExtensionToWebviewMessage[] = [];
    const bridge = makeBridge(sent);
    const session = makeFakeSession();
    bridge.attach(session as never);

    session.emit({ type: 'message_start', message: { role: 'assistant' } });
    session.emit({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'toolCall', id: 'tc1', name: 'read', arguments: { path: '/a.ts' } }] } });

    const assistant = sent.find((m): m is Extract<ExtensionToWebviewMessage, { type: 'assistant' }> => m.type === 'assistant');
    expect(assistant!.data.message.content[0]).toMatchObject({ type: 'tool_use', id: 'tc1', name: 'Read' });
  });

  it('marks a nested tool result that carries images with imageCount, never a text-only or failed one', () => {
    const sent: ExtensionToWebviewMessage[] = [];
    const bridge = makeBridge(sent);
    const session = makeFakeSession();
    bridge.attach(session as never);
    const png = { type: 'image', data: 'AAAA', mimeType: 'image/png' };

    session.emit({ type: 'tool_execution_end', toolCallId: 'img', toolName: 'browser_screenshot', result: { content: [{ type: 'text', text: 'shot' }, png] }, isError: false });
    session.emit({ type: 'tool_execution_end', toolCallId: 'text', toolName: 'read', result: { content: [{ type: 'text', text: 'a' }] }, isError: false });
    session.emit({ type: 'tool_execution_end', toolCallId: 'fail', toolName: 'read', result: { content: [png] }, isError: true });

    const completed = sent.filter((m): m is Extract<ExtensionToWebviewMessage, { type: 'toolCompleted' }> => m.type === 'toolCompleted');
    expect(completed.find((m) => m.toolUseId === 'img')).toMatchObject({ result: 'shot', imageCount: 1, parentToolUseId: 'toolu_parent' });
    expect(completed.find((m) => m.toolUseId === 'text')).not.toHaveProperty('imageCount');
    expect(sent.find((m) => m.type === 'toolFailed')).not.toHaveProperty('imageCount');
    expect(JSON.stringify(sent)).not.toContain('AAAA');
  });

  it("reports a nested call's measured execution time, and none for a call that never ran", () => {
    const sent: ExtensionToWebviewMessage[] = [];
    const bridge = makeBridge(sent);
    const session = makeFakeSession();
    bridge.attach(session as never);

    session.emit({ type: 'tool_execution_start', toolCallId: 'ran', toolName: 'read', args: { path: '/a' } });
    session.emit({ type: 'tool_execution_start', toolCallId: 'denied', toolName: 'bash', args: { command: 'rm x' } });
    session.emit({ type: 'tool_execution_end', toolCallId: 'ran', toolName: 'read', result: { content: [{ type: 'text', text: 'a' }] }, isError: false, durationMs: 1234 });
    session.emit({ type: 'tool_execution_end', toolCallId: 'denied', toolName: 'bash', result: { content: [{ type: 'text', text: 'denied' }] }, isError: true });

    expect(sent.find((m) => m.type === 'toolCompleted')).toMatchObject({ toolUseId: 'ran', durationMs: 1234 });
    expect(sent.find((m) => m.type === 'toolFailed')).not.toHaveProperty('durationMs');
  });

  it('forwards the details an error result carries, as the reload does, and none for a thrown error', () => {
    const sent: ExtensionToWebviewMessage[] = [];
    const bridge = makeBridge(sent);
    const session = makeFakeSession();
    bridge.attach(session as never);

    session.emit({ type: 'tool_execution_end', toolCallId: 'kept', toolName: 'edit', result: { content: [{ type: 'text', text: 'no match' }], details: { reason: 'no-match' } }, isError: true });
    session.emit({ type: 'tool_execution_end', toolCallId: 'thrown', toolName: 'edit', result: { content: [{ type: 'text', text: 'boom' }], details: {} }, isError: true });

    expect(sent.filter((m) => m.type === 'toolFailed' || m.type === 'toolMetadata').map((m) => [m.type, (m as { toolUseId: string }).toolUseId])).toEqual([
      ['toolFailed', 'kept'], ['toolMetadata', 'kept'], ['toolFailed', 'thrown'],
    ]);
    expect(sent.find((m) => m.type === 'toolMetadata')).toEqual({ type: 'toolMetadata', toolUseId: 'kept', metadata: { reason: 'no-match' } });
  });

  it('lands an error result an abort cut short as completed with its cancelled marker, as the reload shows it', () => {
    const sent: ExtensionToWebviewMessage[] = [];
    const bridge = makeBridge(sent);
    const session = makeFakeSession();
    bridge.attach(session as never);

    session.emit({ type: 'tool_execution_start', toolCallId: 'killed', toolName: 'bash', args: { command: 'sleep 20' } });
    sent.length = 0;
    session.emit({ type: 'tool_execution_end', toolCallId: 'killed', toolName: 'bash', result: { content: [{ type: 'text', text: 'Command aborted' }], details: { damoclesCancelled: true } }, isError: true, durationMs: 700 });

    expect(sent).toEqual([
      { type: 'toolCompleted', toolUseId: 'killed', toolName: 'Bash', result: 'Command aborted', parentToolUseId: 'toolu_parent', durationMs: 700 },
      { type: 'toolMetadata', toolUseId: 'killed', metadata: { damoclesCancelled: true } },
    ]);
  });

  // pi appends the nested record and emits its entry_appended inside the extension pass (agent-session.js:749, :2721-2726),
  // before listeners get the tool_execution_end of a call the abort settled at the gate (agent-loop.js:500-504).
  it('shows a call the turn-stopped record names as not executed, live and in the sealing snapshot', () => {
    const sent: ExtensionToWebviewMessage[] = [];
    const bridge = makeBridge(sent);
    const call = { role: 'assistant', content: [{ type: 'toolCall', id: 'gated', name: 'bash', arguments: { command: 'rm -rf build' } }], stopReason: 'toolUse' };
    const result = { role: 'toolResult', toolCallId: 'gated', content: [{ type: 'text', text: 'Operation aborted' }], details: {}, isError: true };
    const messages: unknown[] = [];
    const session = { ...makeFakeSession(), messages };
    bridge.attach(session as never);
    messages.push(call);

    session.emit({ type: 'tool_execution_start', toolCallId: 'gated', toolName: 'bash', args: { command: 'rm -rf build' } });
    sent.length = 0;
    session.emit({ type: 'entry_appended', entry: { type: 'custom', id: 's1', parentId: null, timestamp: '', customType: 'damocles-turn-stopped', data: { toolCallIds: ['gated'], entryIds: [] } } });
    session.emit({ type: 'tool_execution_end', toolCallId: 'gated', toolName: 'bash', result: { content: [{ type: 'text', text: 'Operation aborted' }], details: {} }, isError: true });
    messages.push(result);

    expect(sent).toEqual([{ type: 'toolAbandoned', toolUseId: 'gated', toolName: 'Bash', parentToolUseId: 'toolu_parent', reason: 'stopped' }]);

    bridge.finish({ session: session as never, responseText: '', resultJson: '{}', isError: false, durationMs: 1 });
    const update = sent.find((m): m is Extract<ExtensionToWebviewMessage, { type: 'subagentMessagesUpdate' }> => m.type === 'subagentMessagesUpdate');
    expect(update!.messages.flatMap((m) => m.contentBlocks)).toEqual([
      { type: 'tool_use', id: 'gated', name: 'Bash', input: { command: 'rm -rf build' }, abandoned: 'stopped' },
    ]);
  });

  it('finish emits toolCompleted{Agent} so a FOREGROUND card resolves without the parent stream event', () => {
    const sent: ExtensionToWebviewMessage[] = [];
    const bridge = makeBridge(sent); // isBackground: false → foreground
    const resultJson = '{"content":[{"type":"text","text":"done"}]}';
    bridge.finish({ responseText: 'done', resultJson, isError: false, durationMs: 5 });

    const completed = sent.filter((m): m is Extract<ExtensionToWebviewMessage, { type: 'toolCompleted' }> => m.type === 'toolCompleted');
    expect(completed).toHaveLength(1);
    expect(completed[0]).toMatchObject({ toolUseId: 'toolu_parent', toolName: 'Agent', result: resultJson });
    expect(sent.some((m) => m.type === 'subagentStop')).toBe(true);
  });

  it('finish emits toolFailed{Agent} on an error completion', () => {
    const sent: ExtensionToWebviewMessage[] = [];
    const bridge = makeBridge(sent);
    bridge.finish({ responseText: 'boom', resultJson: '{}', isError: true, durationMs: 0 });

    const failed = sent.filter((m): m is Extract<ExtensionToWebviewMessage, { type: 'toolFailed' }> => m.type === 'toolFailed');
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ toolUseId: 'toolu_parent', toolName: 'Agent', error: 'boom' });
  });

  it('subagentStart carries the description and resumedFrom when given, and omits them otherwise', () => {
    const sent: ExtensionToWebviewMessage[] = [];
    new SubagentStreamBridge({
      parentToolUseId: 'toolu_resume',
      agentId: 'agent-1',
      agentType: 'Explore',
      isBackground: true,
      description: 'dig in',
      resumedFrom: 'agent-1',
      getSessionId: () => 'parent-sid',
      postMessage: (m) => sent.push(m),
      onUsage: () => {},
    }).start();
    makeBridge(sent).start();

    expect(sent.filter((m) => m.type === 'subagentStart')).toEqual([
      { type: 'subagentStart', agentId: 'agent-1', agentType: 'Explore', toolUseId: 'toolu_resume', isBackground: true, description: 'dig in', resumedFrom: 'agent-1' },
      { type: 'subagentStart', agentId: 'agent-1', agentType: 'Explore', toolUseId: 'toolu_parent', isBackground: false },
    ]);
  });

  it('a reopened session seals only the messages of this run, not those it held when attached', () => {
    const sent: ExtensionToWebviewMessage[] = [];
    const bridge = makeBridge(sent);
    const messages: unknown[] = [
      { role: 'user', content: [{ type: 'text', text: 'earlier task' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'earlier answer' }] },
    ];
    const session = { ...makeFakeSession(), messages };
    bridge.attach(session as never);
    messages.push(
      { role: 'user', content: [{ type: 'text', text: 'continue' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'resumed answer' }] },
    );

    bridge.finish({ session: session as never, responseText: 'resumed answer', resultJson: '{}', isError: false, durationMs: 1 });

    const update = sent.find((m): m is Extract<ExtensionToWebviewMessage, { type: 'subagentMessagesUpdate' }> => m.type === 'subagentMessagesUpdate');
    expect(update!.messages).toEqual([
      { role: 'user', contentBlocks: [{ type: 'text', text: 'continue' }] },
      { role: 'assistant', contentBlocks: [{ type: 'text', text: 'resumed answer' }] },
    ]);
  });

  it('assigns a fresh messageId per assistant message', () => {
    const sent: ExtensionToWebviewMessage[] = [];
    const bridge = makeBridge(sent);
    const session = makeFakeSession();
    bridge.attach(session as never);

    session.emit({ type: 'message_start', message: { role: 'assistant' } });
    session.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'a' } });
    session.emit({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'a' }] } });
    session.emit({ type: 'message_start', message: { role: 'assistant' } });
    session.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'b' } });

    const partials = sent.filter((m): m is Extract<ExtensionToWebviewMessage, { type: 'partial' }> => m.type === 'partial');
    const ids = partials.map((p) => p.data.messageId);
    expect(new Set(ids).size).toBe(2);
  });
});

describe('SubagentStreamBridge usage', () => {
  it('publishes the run usage after each response, once pi has persisted it, with the billing flag from attach', async () => {
    const sent: ExtensionToWebviewMessage[] = [];
    const readings: AgentUsageTotals[] = [];
    const bridge = makeBridge(sent, readings);
    const session = makeFakeSession();
    bridge.start();
    bridge.emitModel('sonnet');
    bridge.attach(session as never, false);

    session.emit(assistantEnd({ input: 10, output: 20, cacheRead: 300, cacheWrite: 40 }, 0.5));
    expect(readings).toEqual([]);
    await Promise.resolve();
    session.emit(assistantEnd({ input: 1, output: 2, cacheRead: 330, cacheWrite: 4 }, 0.25));
    await Promise.resolve();

    expect(usageUpdates(sent)).toEqual([
      { type: 'subagentUsageUpdate', agentToolId: 'toolu_parent', usage: { totalInputTokens: 10, totalOutputTokens: 20, cacheReadTokens: 300, cacheCreationTokens: 40, costUsd: 0.5 }, dollarBilled: false },
      { type: 'subagentUsageUpdate', agentToolId: 'toolu_parent', usage: { totalInputTokens: 11, totalOutputTokens: 22, cacheReadTokens: 630, cacheCreationTokens: 44, costUsd: 0.75 }, dollarBilled: false },
    ]);
    // The budget roll is fed the same reading the card is sent, one per response.
    expect(readings).toEqual(usageUpdates(sent).map((u) => u.usage));
  });

  it('a reopened session counts only the spend after it was attached', async () => {
    const sent: ExtensionToWebviewMessage[] = [];
    const bridge = makeBridge(sent);
    const session = makeFakeSession({ input: 500, output: 600, cacheRead: 7000, cacheWrite: 800, cost: 9 });
    bridge.start();
    bridge.attach(session as never);

    session.emit(assistantEnd({ input: 5, output: 6, cacheRead: 70, cacheWrite: 8 }, 0.1));
    await Promise.resolve();

    const [update] = usageUpdates(sent);
    expect(update!.usage).toEqual({ totalInputTokens: 5, totalOutputTokens: 6, cacheReadTokens: 70, cacheCreationTokens: 8, costUsd: expect.closeTo(0.1) });
    expect(update).not.toHaveProperty('dollarBilled');
  });

  it('counts a compaction when it ends, and spend that raised no event when the run settles', () => {
    const sent: ExtensionToWebviewMessage[] = [];
    const bridge = makeBridge(sent);
    const session = makeFakeSession();
    bridge.attach(session as never);

    // A compaction entry is written before `compaction_end`; a cache warm writes a `usage` entry silently.
    Object.assign(session.totals, { input: 2000, output: 300, cost: 0.2 });
    session.emit({ type: 'compaction_end', reason: 'threshold', aborted: false, willRetry: false });
    expect(usageUpdates(sent).at(-1)!.usage).toMatchObject({ totalInputTokens: 2000, totalOutputTokens: 300, costUsd: 0.2 });

    session.totals.cacheRead += 9000;
    session.totals.cost += 0.05;
    bridge.settleUsage();
    bridge.finish({ session: session as never, responseText: 'done', resultJson: '{}', isError: false, durationMs: 1 });

    expect(usageUpdates(sent).at(-1)!.usage).toEqual({ totalInputTokens: 2000, totalOutputTokens: 300, cacheReadTokens: 9000, cacheCreationTokens: 0, costUsd: expect.closeTo(0.25) });
    // The card's usage is final before the completion flips it.
    const types = sent.map((m) => m.type);
    expect(types.lastIndexOf('subagentUsageUpdate')).toBeLessThan(types.indexOf('toolCompleted'));
  });

  it('publishes nothing for a run that never opened a session', () => {
    const sent: ExtensionToWebviewMessage[] = [];
    const bridge = makeBridge(sent);
    bridge.start();
    bridge.settleUsage();
    bridge.finish({ responseText: 'boom', resultJson: '{}', isError: true, durationMs: 0 });
    expect(usageUpdates(sent)).toEqual([]);
  });
});

describe('SubagentStreamBridge model and effort', () => {
  const modelUpdates = (sent: ExtensionToWebviewMessage[]) =>
    sent.filter((m): m is Extract<ExtensionToWebviewMessage, { type: 'subagentModelUpdate' }> => m.type === 'subagentModelUpdate');

  it('sends the model at start, then the same model with its effort once the session exists', () => {
    const sent: ExtensionToWebviewMessage[] = [];
    const bridge = makeBridge(sent);
    bridge.start();
    bridge.emitModel('Haiku 4.5');
    bridge.attach(makeFakeSession() as never, true, 'medium');

    expect(modelUpdates(sent)).toEqual([
      { type: 'subagentModelUpdate', agentToolId: 'toolu_parent', model: 'Haiku 4.5' },
      { type: 'subagentModelUpdate', agentToolId: 'toolu_parent', model: 'Haiku 4.5', effort: 'medium' },
    ]);
  });

  it('guards on the (model, effort) pair, so a repeat of either pair sends nothing', () => {
    const sent: ExtensionToWebviewMessage[] = [];
    const bridge = makeBridge(sent);
    bridge.start();
    bridge.emitModel('Haiku 4.5');
    bridge.emitModel('Haiku 4.5');
    bridge.attach(makeFakeSession() as never, true, 'medium');
    bridge.emitModel('Haiku 4.5', 'medium');

    expect(modelUpdates(sent)).toHaveLength(2);
  });

  it('sends no second message when the session publishes no effort', () => {
    const sent: ExtensionToWebviewMessage[] = [];
    const bridge = makeBridge(sent);
    bridge.start();
    bridge.emitModel('Haiku 4.5');
    bridge.attach(makeFakeSession() as never, true, undefined);

    expect(modelUpdates(sent)).toEqual([{ type: 'subagentModelUpdate', agentToolId: 'toolu_parent', model: 'Haiku 4.5' }]);
  });

  it('sends the effort of a reopened agent whose launch recorded no model label, as its reloaded card shows it', () => {
    const sent: ExtensionToWebviewMessage[] = [];
    const bridge = makeBridge(sent);
    bridge.start();
    bridge.emitModel(undefined);
    bridge.attach(makeFakeSession() as never, true, 'high');

    expect(modelUpdates(sent)).toEqual([{ type: 'subagentModelUpdate', agentToolId: 'toolu_parent', effort: 'high' }]);
  });
});

/**
 * A failed model call in pi 1.1.0's order: `message_start` (`agent-loop.js:286`), a delta (`agent-loop.js:299`),
 * `message_end` with `stopReason: 'error'` (`agent-loop.js:319`), `turn_end` and `agent_end`
 * (`agent-loop.js:151-152`), the last stamped with `willRetry` by `AgentSession` (`agent-session.js:750`).
 */
function emitFailedCall(session: FakeSession, errorMessage: string, opts: { partial?: string; willRetry: boolean }): void {
  session.emit({ type: 'message_start', message: { role: 'assistant' } });
  if (opts.partial) session.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: opts.partial } });
  const message = { role: 'assistant', content: opts.partial ? [{ type: 'text', text: opts.partial }] : [], stopReason: 'error', errorMessage };
  session.emit({ type: 'message_end', message });
  session.emit({ type: 'turn_end', message, toolResults: [] });
  session.emit({ type: 'agent_end', messages: [message], willRetry: opts.willRetry });
}

function emitAnsweredCall(session: FakeSession, text: string): void {
  session.emit({ type: 'message_start', message: { role: 'assistant' } });
  session.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: text } });
  session.emit({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text }], stopReason: 'stop' } });
}

describe('SubagentStreamBridge provider failures', () => {
  const ofType = <T extends ExtensionToWebviewMessage['type']>(sent: ExtensionToWebviewMessage[], type: T) =>
    sent.filter((m): m is Extract<ExtensionToWebviewMessage, { type: T }> => m.type === type);

  it('withdraws a call pi retries, shows no error, and marks the card retrying until the retried call starts', () => {
    const sent: ExtensionToWebviewMessage[] = [];
    const bridge = makeBridge(sent);
    const session = makeFakeSession();
    bridge.attach(session as never);

    emitFailedCall(session, '529 overloaded_error', { partial: 'Let me', willRetry: true });
    const failedId = ofType(sent, 'assistant').at(-1)!.data.message.id;
    // `_prepareRetry` (`agent-session.js:3041`), then the retried run (`agent-loop.js:68`).
    session.emit({ type: 'auto_retry_start', attempt: 1, maxAttempts: 3, delayMs: 2000, errorMessage: '529 overloaded_error' });
    session.emit({ type: 'agent_start' });
    emitAnsweredCall(session, 'done');
    // A successful retry is reported after the retried call's `message_end` (`agent-session.js:777`).
    session.emit({ type: 'auto_retry_end', success: true, attempt: 1 });
    session.emit({ type: 'turn_end' });
    session.emit({ type: 'agent_end', messages: [], willRetry: false });
    session.emit({ type: 'agent_settled', aborted: false });

    expect(ofType(sent, 'error')).toEqual([]);
    expect(ofType(sent, 'assistantRetracted')).toEqual([{ type: 'assistantRetracted', messageId: failedId, parentToolUseId: 'toolu_parent' }]);
    expect(ofType(sent, 'statusUpdate')).toEqual([
      { type: 'statusUpdate', status: 'retrying', attempt: 1, maxAttempts: 3, parentToolUseId: 'toolu_parent' },
      { type: 'statusUpdate', status: 'ready', parentToolUseId: 'toolu_parent' },
    ]);
    const retried = ofType(sent, 'partial').find((p) => p.data.streamingText === 'done')!;
    expect(sent.indexOf(ofType(sent, 'statusUpdate')[1]!)).toBeLessThan(sent.indexOf(retried));
    expect(retried.data.messageId).not.toBe(failedId);
  });

  it('withdraws nothing for a retried call that streamed nothing', () => {
    const sent: ExtensionToWebviewMessage[] = [];
    const bridge = makeBridge(sent);
    const session = makeFakeSession();
    bridge.attach(session as never);

    emitFailedCall(session, 'fetch failed', { willRetry: true });

    expect(ofType(sent, 'assistantRetracted')).toEqual([]);
    expect(ofType(sent, 'error')).toEqual([]);
  });

  it('shows a failure pi will not re-run once, after its agent_end, on the card', () => {
    const sent: ExtensionToWebviewMessage[] = [];
    const bridge = makeBridge(sent);
    const session = makeFakeSession();
    bridge.attach(session as never);

    emitFailedCall(session, '400 invalid_request_error', { partial: 'Now I will', willRetry: false });
    expect(ofType(sent, 'error')).toEqual([]);
    session.emit({ type: 'agent_settled', aborted: false });

    expect(ofType(sent, 'error')).toEqual([{ type: 'error', message: '400 invalid_request_error', parentToolUseId: 'toolu_parent' }]);
    expect(ofType(sent, 'assistantRetracted')).toEqual([]);
  });

  it('shows the last attempt once the retries run out', () => {
    const sent: ExtensionToWebviewMessage[] = [];
    const bridge = makeBridge(sent);
    const session = makeFakeSession();
    bridge.attach(session as never);

    emitFailedCall(session, '529 first', { partial: 'a', willRetry: true });
    session.emit({ type: 'auto_retry_start', attempt: 1, maxAttempts: 1, delayMs: 2000, errorMessage: '529 first' });
    session.emit({ type: 'agent_start' });
    emitFailedCall(session, '529 second', { partial: 'b', willRetry: false });
    // pi gives up after the last attempt's agent_end (`agent-session.js:1437`).
    session.emit({ type: 'auto_retry_end', success: false, attempt: 1, finalError: '529 second' });
    session.emit({ type: 'agent_settled', aborted: false });

    expect(ofType(sent, 'error').map((m) => m.message)).toEqual(['529 second']);
    expect(ofType(sent, 'assistantRetracted')).toHaveLength(1);
  });

  it('withdraws an overflowed call at its recovery compaction, whatever the compaction reports', () => {
    const sent: ExtensionToWebviewMessage[] = [];
    const bridge = makeBridge(sent);
    const session = makeFakeSession();
    bridge.attach(session as never);

    emitFailedCall(session, 'prompt is too long', { partial: 'x', willRetry: false });
    // `_checkCompaction` omits the call, then runs the overflow compaction (`agent-session.js:2406-2407`).
    session.emit({ type: 'compaction_start', reason: 'overflow' });
    session.emit({ type: 'compaction_end', reason: 'overflow', aborted: false, willRetry: false, errorMessage: 'Context overflow recovery failed: boom' });
    session.emit({ type: 'agent_settled', aborted: false });

    expect(ofType(sent, 'assistantRetracted')).toHaveLength(1);
    expect(ofType(sent, 'error')).toEqual([]);
  });

  it('shows an overflow pi will not recover again at the compaction_end that reports it, with the call\'s own error', () => {
    const sent: ExtensionToWebviewMessage[] = [];
    const bridge = makeBridge(sent);
    const session = makeFakeSession();
    bridge.attach(session as never);

    emitFailedCall(session, 'prompt is too long', { willRetry: false });
    // A second overflow after one recovery: a compaction_end with no start (`agent-session.js:2388`).
    session.emit({ type: 'compaction_end', reason: 'overflow', aborted: false, willRetry: false, errorMessage: 'Context overflow recovery failed after one compact-and-retry attempt.' });

    expect(ofType(sent, 'error')).toEqual([{ type: 'error', message: 'prompt is too long', parentToolUseId: 'toolu_parent' }]);
  });

  // pi returns from the turn before executing any tool of an errored message (agent-loop.js:143-152), and its turn_end
  // is where the wind-down record would be, so the call's end is decided there.
  it('settles the tool cards a failed call streamed as not executed when the call ends', () => {
    const sent: ExtensionToWebviewMessage[] = [];
    const bridge = makeBridge(sent);
    const session = makeFakeSession();
    bridge.attach(session as never);

    session.emit({ type: 'message_start', message: { role: 'assistant' } });
    const message = { role: 'assistant', content: [{ type: 'toolCall', id: 'never-ran', name: 'bash', arguments: { command: 'ls' } }], stopReason: 'error', errorMessage: 'terminated' };
    session.emit({ type: 'message_end', message });
    expect(ofType(sent, 'toolAbandoned')).toEqual([]);
    session.emit({ type: 'turn_end', message, toolResults: [] });

    const abandoned = ofType(sent, 'toolAbandoned');
    expect(abandoned).toEqual([{ type: 'toolAbandoned', toolUseId: 'never-ran', toolName: 'Bash', parentToolUseId: 'toolu_parent', reason: 'failed' }]);
    expect(sent.indexOf(abandoned[0]!)).toBeGreaterThan(sent.indexOf(ofType(sent, 'assistant')[0]!));
  });

  // pi returns before executing the tools of an aborted message too (agent-loop.js:143).
  it('settles the tool cards an aborted call streamed as stopped when the call ends', () => {
    const sent: ExtensionToWebviewMessage[] = [];
    const bridge = makeBridge(sent);
    const session = makeFakeSession();
    bridge.attach(session as never);

    session.emit({ type: 'message_start', message: { role: 'assistant' } });
    const message = { role: 'assistant', content: [{ type: 'toolCall', id: 'never-ran', name: 'bash', arguments: { command: 'ls' } }], stopReason: 'aborted', errorMessage: 'Request was aborted' };
    session.emit({ type: 'message_end', message });

    expect(ofType(sent, 'toolAbandoned')).toEqual([{ type: 'toolAbandoned', toolUseId: 'never-ran', toolName: 'Bash', parentToolUseId: 'toolu_parent', reason: 'stopped' }]);
    expect(ofType(sent, 'error')).toEqual([]);
  });

  // pi finalizes the call it was running and starts none after it (agent-loop.js:402-404, :429-431, :449-451), then
  // makes the next call under the aborted signal, which ends aborted (:141-152); the skipped calls get no event.
  // A wind-down error stop in its place is covered under 'SubagentStreamBridge abort wind-down'.
  it('settles the calls an abort skipped as stopped when the aborted call that follows ends, live and sealed', () => {
    const sent: ExtensionToWebviewMessage[] = [];
    const bridge = makeBridge(sent);
    const messages: unknown[] = [];
    const session = { ...makeFakeSession(), messages };
    bridge.attach(session as never);
    const call = (id: string) => ({ type: 'toolCall', id, name: 'bash', arguments: { command: 'ls' } });
    const batch = { role: 'assistant', content: [call('ran'), call('skipped')], stopReason: 'toolUse' };
    const ranResult = { role: 'toolResult', toolCallId: 'ran', content: [{ type: 'text', text: 'Operation aborted' }], isError: true };
    const aborted = { role: 'assistant', content: [], stopReason: 'aborted', errorMessage: 'Request was aborted' };

    session.emit({ type: 'message_start', message: { role: 'assistant' } });
    session.emit({ type: 'message_end', message: batch });
    session.emit({ type: 'tool_execution_start', toolCallId: 'ran', toolName: 'bash', args: { command: 'ls' } });
    session.emit({ type: 'tool_execution_end', toolCallId: 'ran', toolName: 'bash', result: ranResult, isError: true });
    session.emit({ type: 'message_start', message: aborted });
    session.emit({ type: 'message_end', message: aborted });
    messages.push(batch, ranResult, aborted);
    bridge.finish({ session: session as never, responseText: '', resultJson: '{}', isError: false, durationMs: 1 });

    expect(ofType(sent, 'toolAbandoned')).toEqual([{ type: 'toolAbandoned', toolUseId: 'skipped', toolName: 'Bash', parentToolUseId: 'toolu_parent', reason: 'stopped' }]);
    expect(ofType(sent, 'subagentMessagesUpdate')[0]!.messages[0]!.contentBlocks).toEqual([
      expect.not.objectContaining({ abandoned: expect.anything() }),
      expect.objectContaining({ type: 'tool_use', id: 'skipped', abandoned: 'stopped' }),
    ]);
  });

  it('seals the tool calls of a failed call pi kept in context as not executed', () => {
    const sent: ExtensionToWebviewMessage[] = [];
    const bridge = makeBridge(sent);
    const messages: unknown[] = [];
    const session = { ...makeFakeSession(), messages };
    bridge.attach(session as never);
    messages.push({ role: 'assistant', content: [{ type: 'toolCall', id: 'never-ran', name: 'bash', arguments: { command: 'ls' } }], stopReason: 'error', errorMessage: 'terminated' });

    bridge.finish({ session: session as never, responseText: '', resultJson: '{}', isError: true, durationMs: 1 });

    expect(ofType(sent, 'subagentMessagesUpdate')[0]!.messages[0]!.contentBlocks).toEqual([
      expect.objectContaining({ type: 'tool_use', id: 'never-ran', abandoned: 'failed' }),
    ]);
  });

  it('seals a failed call pi kept in context with its text and its error, and drops what it re-ran', () => {
    const sent: ExtensionToWebviewMessage[] = [];
    const bridge = makeBridge(sent);
    const messages: unknown[] = [];
    const session = { ...makeFakeSession(), messages };
    bridge.attach(session as never);
    // The session's messages are pi's projection, which no longer holds a call it re-ran (`_refreshFinalizedContext`).
    messages.push(
      { role: 'user', content: [{ type: 'text', text: 'task' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'Now I will' }], stopReason: 'error', errorMessage: '400 invalid_request_error' },
    );

    bridge.finish({ session: session as never, responseText: '', resultJson: '{}', isError: true, durationMs: 1 });

    expect(ofType(sent, 'subagentMessagesUpdate')[0]!.messages).toEqual([
      { role: 'user', contentBlocks: [{ type: 'text', text: 'task' }] },
      { role: 'assistant', contentBlocks: [{ type: 'text', text: 'Now I will' }] },
      { role: 'error', contentBlocks: [{ type: 'text', text: '400 invalid_request_error' }] },
    ]);
  });
});

/**
 * An abort while a subagent runs a tool, in pi 1.1.0's order: the abort kills the call, which pi records with its
 * `durationMs` (`agent-loop.js:583-591`), and the loop makes its next call under the aborted signal (`:141`). That
 * call's request setup resolves auth with the signal (`model-runtime.js:451-455`), which rejects at once
 * (`raceWithAbortSignal`), and pi-ai's lazy stream ends it on an error stop whatever the signal says (`lazy.js:41-44`):
 * "This operation was aborted". `registerWindDownErrorRecord` names it at its `turn_end` boundary, which pi runs after
 * the `message_end` listeners and commits before the listeners' `turn_end` (`agent-session.js:515`, `:636-641`).
 */
describe('SubagentStreamBridge abort wind-down', () => {
  const ofType = <T extends ExtensionToWebviewMessage['type']>(sent: ExtensionToWebviewMessage[], type: T) =>
    sent.filter((m): m is Extract<ExtensionToWebviewMessage, { type: T }> => m.type === type);
  const call = (id: string) => ({ type: 'toolCall', id, name: 'bash', arguments: { command: 'sleep 20' } });

  function stoppedRun(content: unknown[], opts: { recorded: boolean } = { recorded: true }) {
    const sent: ExtensionToWebviewMessage[] = [];
    const bridge = makeBridge(sent);
    const messages: unknown[] = [];
    const session = { ...makeFakeSession(), messages };
    bridge.attach(session as never);
    const batch = { role: 'assistant', content, stopReason: 'toolUse' };
    const killed = { role: 'toolResult', toolCallId: 'ran', content: [{ type: 'text', text: 'Command aborted' }], details: { damoclesCancelled: true }, isError: true, durationMs: 700 };
    const windDown = { role: 'assistant', content: [], stopReason: 'error', errorMessage: 'This operation was aborted' };

    session.emit({ type: 'message_start', message: { role: 'assistant' } });
    session.emit({ type: 'message_end', message: batch });
    messages.push(batch);
    session.emit({ type: 'tool_execution_start', toolCallId: 'ran', toolName: 'bash', args: { command: 'sleep 20' } });
    session.emit({ type: 'tool_execution_end', toolCallId: 'ran', toolName: 'bash', result: killed, isError: true, durationMs: 700 });
    messages.push(killed);
    session.emit({ type: 'message_start', message: windDown });
    session.emit({ type: 'message_end', message: windDown });
    messages.push(windDown);
    if (opts.recorded) recordWindDown(session, windDown);
    session.emit({ type: 'turn_end', message: windDown, toolResults: [] });
    session.emit({ type: 'agent_end', messages: [windDown], willRetry: false });
    session.emit({ type: 'agent_settled', aborted: true });
    bridge.finish({ session: session as never, responseText: '', resultJson: '{}', isError: false, durationMs: 1 });
    return { sent, sealed: ofType(sent, 'subagentMessagesUpdate')[0]!.messages };
  }

  it('shows no error card for the error stop that ends an aborted run, live or in the sealing snapshot', () => {
    const { sent, sealed } = stoppedRun([call('ran')]);

    expect(ofType(sent, 'error')).toEqual([]);
    expect(sealed.map((m) => m.role)).toEqual(['assistant']);
  });

  it('settles the calls the abort skipped in the cut batch as stopped, as an aborted stop does', () => {
    const { sent, sealed } = stoppedRun([call('ran'), call('skipped')]);

    expect(ofType(sent, 'toolAbandoned')).toEqual([{ type: 'toolAbandoned', toolUseId: 'skipped', toolName: 'Bash', parentToolUseId: 'toolu_parent', reason: 'stopped' }]);
    expect(sealed[0]!.contentBlocks).toEqual([
      expect.not.objectContaining({ abandoned: expect.anything() }),
      expect.objectContaining({ type: 'tool_use', id: 'skipped', abandoned: 'stopped' }),
    ]);
  });

  // No record: the record pass saw a live signal (the abort landed after it) or a later handler discarded the draft.
  it('shows the card and leaves the skipped call alone when no record names the error, as a reload does', () => {
    const { sent, sealed } = stoppedRun([call('ran'), call('skipped')], { recorded: false });

    expect(ofType(sent, 'error')).toEqual([{ type: 'error', message: 'This operation was aborted', parentToolUseId: 'toolu_parent' }]);
    expect(ofType(sent, 'toolAbandoned')).toEqual([]);
    expect(sealed.map((m) => m.role)).toEqual(['assistant', 'error']);
  });

  it('settles the calls a wind-down error named as stopped, not failed', () => {
    const sent: ExtensionToWebviewMessage[] = [];
    const bridge = makeBridge(sent);
    const session = makeFakeSession();
    bridge.attach(session as never);
    const windDown = { role: 'assistant', content: [call('never-ran')], stopReason: 'error', errorMessage: 'terminated' };

    session.emit({ type: 'message_start', message: { role: 'assistant' } });
    session.emit({ type: 'message_end', message: windDown });
    recordWindDown(session, windDown);
    session.emit({ type: 'turn_end', message: windDown, toolResults: [] });
    session.emit({ type: 'agent_settled', aborted: true });

    expect(ofType(sent, 'toolAbandoned')).toEqual([{ type: 'toolAbandoned', toolUseId: 'never-ran', toolName: 'Bash', parentToolUseId: 'toolu_parent', reason: 'stopped' }]);
    expect(ofType(sent, 'error')).toEqual([]);
  });

  it('still shows a provider failure no record names', () => {
    const sent: ExtensionToWebviewMessage[] = [];
    const bridge = makeBridge(sent);
    const session = makeFakeSession();
    bridge.attach(session as never);

    emitFailedCall(session, '400 invalid_request_error', { partial: 'Now I will', willRetry: false });
    session.emit({ type: 'agent_settled', aborted: false });

    expect(ofType(sent, 'error')).toEqual([{ type: 'error', message: '400 invalid_request_error', parentToolUseId: 'toolu_parent' }]);
  });
});
