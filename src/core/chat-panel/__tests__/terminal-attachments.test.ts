import { afterEach, describe, expect, it, vi } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import type { TerminalAttachmentInfo, TerminalAttachmentInput } from '@shared/types/terminal-attachment';
import type { ExtensionToWebviewMessage, WebviewToExtensionMessage } from '@shared/types/messages';
import { MAX_PENDING_TERMINAL_ATTACHMENT_CHARS, MAX_PENDING_TERMINAL_ATTACHMENTS, TerminalAttachmentManager } from '../terminal-attachment-manager';
import { createChatHandlers } from '../message-router/handlers/chat-handlers';
import type { HandlerContext, HandlerDependencies } from '../message-router/types';
import { splitTerminalAttachments } from '../../terminal-attachment';
import type { SendOutcome, SlashInvocation } from '../../chat-session';
import { createHarness, folderEntry, type Harness } from './panel-manager-harness';

vi.mock('../ide-context-manager', () => ({
  IdeContextManager: class {
    dispose(): void {}
  },
}));

const input = (text: string, overrides: Partial<TerminalAttachmentInput> = {}): TerminalAttachmentInput => ({
  source: 'command', commandLine: 'npm test', exitCode: 1, terminalTitle: 'pwsh', text, omittedLines: 0, ...overrides,
});

describe('TerminalAttachmentManager', () => {
  it('publishes the whole list on every add, remove and take, and takes only named ids in added order', () => {
    const published: TerminalAttachmentInfo[][] = [];
    const added: boolean[] = [];
    const manager = new TerminalAttachmentManager((list, isAdd) => {
      published.push(list);
      added.push(isAdd);
    });
    manager.add(input('one'));
    manager.add(input('two'));
    manager.add(input('three'));
    const [first, second, third] = manager.displayInfo().map((info) => info.id);
    expect(published.map((list) => list.length)).toEqual([1, 2, 3]);

    manager.remove(second!);
    manager.remove('unknown');
    expect(published).toHaveLength(4);

    const taken = manager.take([third!, 'unknown', first!]);
    expect(taken.map(({ attachment }) => attachment.text)).toEqual(['one', 'three']);
    expect(manager.displayInfo()).toEqual([]);
    expect(published.at(-1)).toEqual([]);
    expect(manager.take([first!])).toEqual([]);
    expect(published).toHaveLength(5);
    // Only an add is the user's action that focuses the composer.
    expect(added).toEqual([true, true, true, false, false]);
  });

  it('keeps the newest attachments when more are added than a composer holds', () => {
    const manager = new TerminalAttachmentManager(() => {});
    for (let index = 0; index < MAX_PENDING_TERMINAL_ATTACHMENTS + 2; index++) manager.add(input(`out ${index}`));
    const previews = manager.displayInfo().map((info) => info.preview);
    expect(previews).toHaveLength(MAX_PENDING_TERMINAL_ATTACHMENTS);
    expect(previews[0]).toBe('out 2');
  });

  it('accepts pending output up to MAX_PENDING_TERMINAL_ATTACHMENT_CHARS in total and refuses an add past it, changing nothing', () => {
    let publishes = 0;
    const manager = new TerminalAttachmentManager(() => { publishes++; });
    const half = MAX_PENDING_TERMINAL_ATTACHMENT_CHARS / 2;
    expect(manager.add(input('a'.repeat(half)))).toBe(true);
    expect(manager.add(input('b'.repeat(half - 1)))).toBe(true);
    expect(manager.add(input('c'))).toBe(true);
    const before = manager.displayInfo();
    expect(manager.add(input('d'))).toBe(false);
    expect(manager.displayInfo()).toEqual(before);
    expect(publishes).toBe(3);
  });

  it('measures the budget after the oldest attachment a full composer drops', () => {
    const manager = new TerminalAttachmentManager(() => {});
    const share = MAX_PENDING_TERMINAL_ATTACHMENT_CHARS / MAX_PENDING_TERMINAL_ATTACHMENTS;
    for (let index = 0; index < MAX_PENDING_TERMINAL_ATTACHMENTS; index++) manager.add(input(String(index % 10).repeat(share)));
    expect(manager.add(input('n'.repeat(share)))).toBe(true);
    expect(manager.add(input('n'.repeat(share + 1)))).toBe(false);
  });

  it('puts taken attachments back with their ids, ahead of any added since', () => {
    const manager = new TerminalAttachmentManager(() => {});
    manager.add(input('one'));
    manager.add(input('two'));
    const ids = manager.displayInfo().map((info) => info.id);
    const taken = manager.take(ids);
    manager.add(input('three'));
    manager.restore(taken);
    expect(manager.displayInfo().map((info) => info.preview)).toEqual(['one', 'two', 'three']);
    expect(manager.displayInfo().slice(0, 2).map((info) => info.id)).toEqual(ids);
  });
});

const IDE_BLOCK = '<ide_opened_file>The user opened the file a.ts in the IDE. This may or may not be related to the current task.</ide_opened_file>';

function harness(options: { ideContext?: boolean } = {}) {
  const sendMessage = vi.fn(async (..._args: unknown[]): Promise<SendOutcome> => 'sent');
  const resolveSlashInvocation = vi.fn(async (_text: string): Promise<SlashInvocation> => ({ kind: 'text' }));
  const sent: ExtensionToWebviewMessage[] = [];
  const deps = {
    postMessage: (_host: unknown, message: ExtensionToWebviewMessage) => { sent.push(message); },
    storageManager: { broadcastPromptHistoryEntry: vi.fn() },
    workspaceManager: { findSkill: async () => undefined, findCommand: async () => undefined },
    markUserTypedDuringTurn: vi.fn(),
  } as unknown as HandlerDependencies;
  const terminalAttachments = new TerminalAttachmentManager((attachments) => sent.push({ type: 'terminalAttachmentsUpdate', attachments }));
  const ideContext = options.ideContext ?? true;
  const ctx = {
    host: { id: 'panel-1' },
    session: { sendMessage, resolveSlashInvocation },
    ideContextManager: {
      getDisplayInfo: () => (ideContext ? { type: 'opened_file', filePath: 'a.ts', fileName: 'a.ts' } : null),
      buildContentBlocks: (content: unknown) => (ideContext ? [{ type: 'text', text: IDE_BLOCK }, ...(typeof content === 'string' ? [{ type: 'text', text: content }] : content as unknown[])] : content),
    },
    terminalAttachments,
  } as unknown as HandlerContext;
  const handlers = createChatHandlers(deps);
  const send = (message: Partial<Extract<WebviewToExtensionMessage, { type: 'sendMessage' }>>) =>
    handlers.sendMessage!({ type: 'sendMessage', content: 'what failed?', ...message } as WebviewToExtensionMessage, ctx);
  return { sendMessage, resolveSlashInvocation, sent, terminalAttachments, handlers, ctx, send };
}

describe('sendMessage with terminal attachments', () => {
  it('sends each attachment as its own block before the IDE block and the typed text, never merged into it', async () => {
    const h = harness();
    h.terminalAttachments.add(input('FAIL a.test.ts'));
    h.terminalAttachments.add(input('second', { source: 'selection', commandLine: null, exitCode: null }));
    const ids = h.terminalAttachments.displayInfo().map((info) => info.id);
    await h.send({ includeIdeContext: true, terminalAttachmentIds: ids });

    const [content, , , broadcast] = h.sendMessage.mock.calls[0] as unknown as [Array<{ type: string; text: string }>, unknown, unknown, { content: string; terminalAttachments: TerminalAttachmentInfo[] }];
    expect(content).toHaveLength(4);
    expect(content[3]).toEqual({ type: 'text', text: 'what failed?' });
    expect(content[2]!.text.startsWith('<ide_opened_file>')).toBe(true);
    expect(splitTerminalAttachments(content.map((block) => block.text).join('\n'), 2).attachments.map((block) => block.text)).toEqual(['FAIL a.test.ts', 'second']);
    expect(broadcast.content).toBe('what failed?');
    expect(broadcast.terminalAttachments.map((info) => info.id)).toEqual(ids);
    expect(h.terminalAttachments.displayInfo()).toEqual([]);
  });

  it('leaves the message unchanged and the chips pending when no ids come, as from the VS Code host', async () => {
    const h = harness();
    h.terminalAttachments.add(input('kept'));
    await h.send({});
    await h.send({ terminalAttachmentIds: 'not-a-list' as unknown as string[] });
    const [id] = h.terminalAttachments.displayInfo().map((info) => info.id);
    await h.send({ terminalAttachmentIds: [id!, 7 as unknown as string] });
    await h.send({ terminalAttachmentIds: [id!, ...Array.from({ length: MAX_PENDING_TERMINAL_ATTACHMENTS }, (_, index) => `x${index}`)] });
    expect(h.sendMessage.mock.calls.map((call) => (call as unknown[])[0])).toEqual(['what failed?', 'what failed?', 'what failed?', 'what failed?']);
    expect((h.sendMessage.mock.calls[0] as unknown[])[3]).toEqual({ content: 'what failed?' });
    expect(h.terminalAttachments.displayInfo()).toHaveLength(1);
  });

  it('puts the attachments back in the composer when the prompt never reached the conversation', async () => {
    const h = harness();
    h.sendMessage.mockResolvedValueOnce('unsent');
    h.terminalAttachments.add(input('FAIL a.test.ts'));
    h.terminalAttachments.add(input('second'));
    const before = h.terminalAttachments.displayInfo();
    await h.send({ terminalAttachmentIds: before.map((info) => info.id) });

    expect(h.sendMessage).toHaveBeenCalledOnce();
    expect(h.terminalAttachments.displayInfo()).toEqual(before);
    expect(h.sent.at(-1)).toEqual({ type: 'terminalAttachmentsUpdate', attachments: before });
  });

  it('puts the attachments back in the composer when a prompt pi queued is withdrawn before it committed', async () => {
    const h = harness();
    h.terminalAttachments.add(input('FAIL a.test.ts'));
    h.terminalAttachments.add(input('second'));
    const before = h.terminalAttachments.displayInfo();
    await h.send({ terminalAttachmentIds: before.map((info) => info.id) });
    expect(h.terminalAttachments.displayInfo()).toEqual([]);

    // A Stop, the budget or a new chat drops pi's queue after `sendMessage` reported it sent.
    const onWithdrawn = (h.sendMessage.mock.calls[0] as unknown[])[4] as () => void;
    onWithdrawn();

    expect(h.terminalAttachments.displayInfo()).toEqual(before);
    expect(h.sent.at(-1)).toEqual({ type: 'terminalAttachmentsUpdate', attachments: before });
  });

  it('puts the attachments back once when the session withdrew the prompt itself before it returned', async () => {
    const h = harness();
    // The session's disposal returns a prompt pi's input handlers still hold.
    h.sendMessage.mockImplementationOnce(async (...args: unknown[]) => {
      (args[4] as () => void)();
      return 'withdrawn';
    });
    h.terminalAttachments.add(input('FAIL a.test.ts'));
    h.terminalAttachments.add(input('second'));
    const before = h.terminalAttachments.displayInfo();
    await h.send({ terminalAttachmentIds: before.map((info) => info.id) });

    expect(h.terminalAttachments.displayInfo()).toEqual(before);
  });

  it('expands a prompt template sent with attachments as typed, then puts the attachment and IDE blocks ahead of it', async () => {
    const h = harness();
    h.resolveSlashInvocation.mockResolvedValueOnce({ kind: 'expanded', text: 'Review PR 7 with care.' });
    h.terminalAttachments.add(input('FAIL a.test.ts'));
    const ids = h.terminalAttachments.displayInfo().map((info) => info.id);
    await h.send({ content: '/review 7', includeIdeContext: true, terminalAttachmentIds: ids });

    expect(h.resolveSlashInvocation).toHaveBeenCalledWith('/review 7');
    const [content, , , broadcast] = h.sendMessage.mock.calls[0] as unknown as [Array<{ type: string; text: string }>, unknown, unknown, { content: string; terminalAttachments: TerminalAttachmentInfo[] }];
    expect(content.map((block) => block.text).slice(1)).toEqual([IDE_BLOCK, 'Review PR 7 with care.']);
    expect(splitTerminalAttachments(content[0]!.text, 1).attachments.map((block) => block.text)).toEqual(['FAIL a.test.ts']);
    expect(broadcast.content).toBe('/review 7');
    expect(broadcast.terminalAttachments.map((info) => info.id)).toEqual(ids);
  });

  it('runs an extension command without the attachments or the IDE block, keeps the chips pending and says so', async () => {
    const h = harness();
    h.resolveSlashInvocation.mockResolvedValueOnce({ kind: 'command' });
    h.terminalAttachments.add(input('kept for later'));
    const pending = h.terminalAttachments.displayInfo();
    const published = h.sent.length;
    await h.send({ content: '/todos', includeIdeContext: true, terminalAttachmentIds: pending.map((info) => info.id) });

    expect(h.sendMessage.mock.calls[0]!.slice(0, 1)).toEqual(['/todos']);
    expect(h.sendMessage.mock.calls[0]![3]).toEqual({ content: '/todos' });
    expect(h.terminalAttachments.displayInfo()).toEqual(pending);
    expect(h.sent.slice(published).filter((message) => message.type === 'terminalAttachmentsUpdate')).toEqual([]);
    expect(h.sent).toContainEqual({ type: 'notification', notificationType: 'info', message: 'A command takes no terminal output, so the attached output stays in the composer for your next message.' });
  });

  it('runs an extension command without the IDE block and without a notice when nothing is attached', async () => {
    const h = harness();
    h.resolveSlashInvocation.mockResolvedValueOnce({ kind: 'command' });
    await h.send({ content: '/todos', includeIdeContext: true });

    expect(h.sendMessage.mock.calls[0]!.slice(0, 1)).toEqual(['/todos']);
    expect(h.sent.some((message) => message.type === 'notification')).toBe(false);
  });

  it('leaves a slash invocation to pi when no block would lead it', async () => {
    const h = harness({ ideContext: false });
    await h.send({ content: '/review 7', includeIdeContext: true });
    await h.send({ content: '/review 7' });

    expect(h.resolveSlashInvocation).not.toHaveBeenCalled();
    expect(h.sendMessage.mock.calls.map((call) => call[0])).toEqual(['/review 7', '/review 7']);
  });

  it('removes one pending attachment on the composer\'s request', () => {
    const h = harness();
    h.terminalAttachments.add(input('a'));
    const [id] = h.terminalAttachments.displayInfo().map((info) => info.id);
    void h.handlers.removeTerminalAttachment!({ type: 'removeTerminalAttachment', id: id! }, h.ctx);
    expect(h.terminalAttachments.displayInfo()).toEqual([]);
    expect(h.sent.at(-1)).toEqual({ type: 'terminalAttachmentsUpdate', attachments: [] });
  });
});

describe('PanelManager.addTerminalAttachment', () => {
  let h: Harness | undefined;
  afterEach(() => {
    h?.dispose();
    h = undefined;
  });

  it('refuses output past the pending budget with a warning naming the limit, and keeps the chips it has', async () => {
    h = createHarness([folderEntry(path.join(path.resolve(os.tmpdir(), 'attach-budget'), 'alpha'))]);
    const panelId = await h.manager.show();
    const pending = h.instance(panelId).terminalAttachments;
    expect(h.manager.addTerminalAttachment(panelId, input('a'.repeat(MAX_PENDING_TERMINAL_ATTACHMENT_CHARS)))).toBe(true);
    const before = pending.displayInfo();

    expect(h.manager.addTerminalAttachment(panelId, input('b'))).toBe(false);
    expect(pending.displayInfo()).toEqual(before);
    expect(h.platform.notifications.calls).toEqual([
      { level: 'warn', message: 'Not added to the chat: its attached terminal output would pass 128,000 characters. Send or remove an attachment first.', actions: [] },
    ]);
  });
});
