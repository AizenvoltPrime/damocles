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
  sessionManager: { getEntries: () => unknown[] };
}

function makeFakeSession(initial: Partial<Totals> = {}): FakeSession {
  let cb: (e: unknown) => void = () => {};
  const totals: Totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, ...initial };
  return {
    subscribe: (fn) => {
      cb = fn;
      return () => {};
    },
    emit: (e) => {
      cb(e);
      // pi persists an assistant message after its listeners ran, as `agent-session.js` `_handleAgentEvent` does.
      const { type, message } = e as { type: string; message?: { role: string; usage?: Omit<Totals, 'cost'> & { cost: { total: number } } } };
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
    sessionManager: { getEntries: () => [{ type: 'usage', usage: { ...totals, cost: { total: totals.cost } } }] },
  };
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

  it('emits subagentStart + model + template path on start (template only when provided, once)', () => {
    const sent: ExtensionToWebviewMessage[] = [];
    const bridge = makeBridge(sent);

    bridge.start('GPT-5.4', 'C:\\Users\\me\\.claude\\agents\\engineering\\code-reviewer.md');
    bridge.start('GPT-5.4', 'C:\\Users\\me\\.claude\\agents\\engineering\\code-reviewer.md');

    const templates = sent.filter((m): m is Extract<ExtensionToWebviewMessage, { type: 'subagentTemplateUpdate' }> => m.type === 'subagentTemplateUpdate');
    expect(templates).toHaveLength(1);
    expect(templates[0]).toMatchObject({ agentToolId: 'toolu_parent', templatePath: 'C:\\Users\\me\\.claude\\agents\\engineering\\code-reviewer.md' });
  });

  it('omits the template update when the agent has no template file (embedded default)', () => {
    const sent: ExtensionToWebviewMessage[] = [];
    makeBridge(sent).start('haiku');
    expect(sent.some((m) => m.type === 'subagentTemplateUpdate')).toBe(false);
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
    bridge.start('sonnet');
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
