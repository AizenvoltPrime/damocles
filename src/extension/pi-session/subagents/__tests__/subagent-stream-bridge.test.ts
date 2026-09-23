import { describe, it, expect } from 'vitest';
import { SubagentStreamBridge } from '../subagent-stream-bridge';
import type { ExtensionToWebviewMessage } from '../../../../shared/types/messages';

interface FakeSession {
  subscribe: (fn: (e: unknown) => void) => () => void;
  emit: (e: unknown) => void;
  messages: readonly unknown[];
}

function makeFakeSession(): FakeSession {
  let cb: (e: unknown) => void = () => {};
  return {
    subscribe: (fn) => {
      cb = fn;
      return () => {};
    },
    emit: (e) => cb(e),
    messages: [],
  };
}

function makeBridge(sent: ExtensionToWebviewMessage[]) {
  return new SubagentStreamBridge({
    parentToolUseId: 'toolu_parent',
    agentId: 'agent-1',
    agentType: 'Explore',
    isBackground: false,
    getSessionId: () => 'parent-sid',
    postMessage: (m) => sent.push(m),
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
