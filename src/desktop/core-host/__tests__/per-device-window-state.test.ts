// A daemon's core whose chat two devices show: each device's editor context and terminal pane reach that device's views
// alone, and a send attaches the sending device's open file; a local core's one editor and terminal pane reach every view.
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHarness, folderEntry } from '../../../core/chat-panel/__tests__/panel-manager-harness';
import { createChatHandlers } from '../../../core/chat-panel/message-router/handlers/chat-handlers';
import type { HandlerContext, HandlerDependencies } from '../../../core/chat-panel/message-router/types';
import { TerminalAttachmentManager } from '../../../core/chat-panel/terminal-attachment-manager';
import type { SendOutcome } from '../../../core/chat-session';
import type { Disposable } from '../../../platform/disposable';
import type { ActiveEditorContext } from '../../../platform/editor-service';
import type { ExtensionToWebviewMessage, WebviewToExtensionMessage } from '../../../shared/types/messages';
import { createCoreEndpoint, createLoopback, createMainEndpoint, processActor, type CoreInit } from '../../core-protocol';
import { followTerminalPane } from '../core-service';
import { createClientSnapshots, createRemoteHost } from '../platform/clients';
import { createEditorProxy } from '../platform/editor';
import { createCorePanels } from '../platform/panels';
import { createWindowProxy } from '../platform/window';

const WORKSPACE = path.resolve('/srv/app');
const A_FILE: ActiveEditorContext = { filePath: path.join(WORKSPACE, 'a.ts'), selection: undefined };
const B_FILE: ActiveEditorContext = { filePath: path.join(WORKSPACE, 'b.ts'), selection: { startLine: 3, endLine: 4, text: 'two lines' } };
const TOGGLE_ON = { shown: true, shortcut: 'Ctrl+`' };

const quiet = (): void => undefined;
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

const disposables: Disposable[] = [];
afterEach(() => {
  for (const disposable of disposables.splice(0).reverse()) disposable.dispose();
});

/**
 * A chat over core's real editor, window, client snapshot and panel proxies, which main (the daemon, on a daemon's core)
 * reaches through a loopback. On a daemon's core view-a is device-a's and view-b device-b's.
 */
async function chatOnCore(daemon: boolean) {
  const loop = createLoopback();
  const actors = daemon ? processActor : undefined;
  const main = createMainEndpoint(loop.main, quiet, undefined, actors);
  const core = createCoreEndpoint(loop.core, quiet, undefined, actors);
  const init = {
    chatBrowserPane: false,
    mirrors: { editor: {}, terminal: { shown: false, shortcut: '' }, clientAuth: {}, clientUser: {}, clientPolicy: {}, actingClient: {} },
  } as unknown as CoreInit;
  const clients = createClientSnapshots(core, init);
  const panels = createCorePanels({ endpoint: core, resourceRoot: '/app' });
  const editor = createEditorProxy(core, init, daemon ? clients : undefined);
  const window = createWindowProxy(core, init, panels, daemon ? clients : undefined);
  const h = createHarness([folderEntry(WORKSPACE)]);
  const remote = daemon ? createRemoteHost(core, { ...init, remote: { hostId: 'host-1' } }, clients, (host) => panels.idOf(host)) : undefined;
  Object.assign(h.platform, { editor, window, remote });
  const terminal = followTerminalPane({ endpoint: core, window, ...(remote ? { remote } : {}) }, h.manager);
  disposables.push(terminal, { dispose: () => h.dispose() }, editor, window, clients, ...(remote ? [remote] : []), panels, { dispose: () => core.close('test') });

  const posts: Array<{ readonly viewKey?: string; readonly message: ExtensionToWebviewMessage }> = [];
  main.onPanel((_viewId, envelope) => {
    if (envelope.op === 'post') posts.push({ ...(envelope.payload.viewKey !== undefined ? { viewKey: envelope.payload.viewKey } : {}), message: JSON.parse(envelope.payload.json) as ExtensionToWebviewMessage });
  });
  const host = panels.attach('view-1');
  const panelId = await h.manager.initializeHost(host);
  if (daemon) {
    for (const [device, viewKey] of [['device-a', 'view-a'], ['device-b', 'view-b']] as const) {
      processActor.run(device, () => main.postPanel('view-1', 'message', { message: { type: 'ready' }, viewKey }));
    }
  } else {
    main.postPanel('view-1', 'message', { message: { type: 'ready' } });
  }
  await flush();
  posts.length = 0;

  const of = (type: ExtensionToWebviewMessage['type']) => posts.filter((post) => post.message.type === type);
  // a send with the IDE context chip on, from the view (and device) given; what the session was asked to send
  const send = async (viewKey: string | undefined, device: string | undefined): Promise<string> => {
    const sendMessage = vi.fn(async (..._args: unknown[]): Promise<SendOutcome> => 'sent');
    const deps = {
      postMessage: (target: { postMessage(message: unknown): unknown }, message: unknown) => void target.postMessage(message),
      storageManager: { broadcastPromptHistoryEntry: vi.fn() },
      workspaceManager: { findSkill: async () => undefined, findCommand: async () => undefined },
      markUserTypedDuringTurn: vi.fn(),
      worktrees: () => ({ interceptSend: () => false }),
      platform: h.platform,
    } as unknown as HandlerDependencies;
    const instance = h.instance(panelId);
    const ctx = {
      host,
      reply: viewKey === undefined ? host : host.viewHost!(viewKey),
      ...(viewKey !== undefined ? { viewKey } : {}),
      session: { sendMessage, resolveSlashInvocation: async () => ({ kind: 'text' }), beginSend: () => ({ signal: new AbortController().signal, end: () => undefined }) },
      ideContextManager: instance.ideContextManager,
      terminalAttachments: new TerminalAttachmentManager(() => undefined),
      panelId,
      folder: instance.folder,
    } as unknown as HandlerContext;
    const message = { type: 'sendMessage', content: 'what is this?', includeIdeContext: true } as WebviewToExtensionMessage;
    await processActor.run(device, () => createChatHandlers(deps).sendMessage!(message, ctx));
    return JSON.stringify(sendMessage.mock.calls[0]![0]);
  };
  return { main, of, send };
}

describe('a daemon\'s core whose chat two devices show', () => {
  it('posts device A\'s open file to A\'s views as ideContextUpdate and never to B\'s, and a send from B attaches B\'s file', async () => {
    const { main, of, send } = await chatOnCore(true);

    main.publish('clientEditor', { clientId: 'device-a', value: { context: A_FILE } });
    await flush();

    expect(of('ideContextUpdate')).toEqual([{ viewKey: 'view-a', message: { type: 'ideContextUpdate', context: { type: 'opened_file', filePath: A_FILE.filePath, fileName: 'a.ts' } } }]);
    // B has no file open: its send attaches none, never A's
    expect(await send('view-b', 'device-b')).not.toContain('a.ts');

    main.publish('clientEditor', { clientId: 'device-b', value: { context: B_FILE } });
    await flush();

    expect(of('ideContextUpdate').map((post) => post.viewKey)).toEqual(['view-a', 'view-b']);
    const fromB = await send('view-b', 'device-b');
    expect([fromB.includes('b.ts'), fromB.includes('a.ts')]).toEqual([true, false]);
    expect(await send('view-a', 'device-a')).toContain('a.ts');
  });

  it('forgets a device\'s editor context when its editor detaches, so the device back with no file open attaches none', async () => {
    const { main, send } = await chatOnCore(true);

    main.publish('clientEditor', { clientId: 'device-a', value: { context: A_FILE } });
    await flush();
    expect(await send('view-a', 'device-a')).toContain('a.ts');

    // device A's client detaches, then attaches again with no text editor focused
    main.publish('clientEditor', { clientId: 'device-a' });
    main.publish('clientEditor', { clientId: 'device-a', value: {} });
    await flush();
    expect(await send('view-a', 'device-a')).not.toContain('a.ts');
  });

  it('posts device A\'s terminal pane toggle to A\'s views alone', async () => {
    const { main, of } = await chatOnCore(true);

    main.publish('clientTerminal', { clientId: 'device-a', value: TOGGLE_ON });
    await flush();

    expect(of('terminalShown')).toEqual([{ viewKey: 'view-a', message: { type: 'terminalShown', ...TOGGLE_ON } }]);
  });

  it('reads neither the editor nor the terminal mirror, which hold no device\'s state', async () => {
    const { main, of } = await chatOnCore(true);

    main.publish('editor', { context: A_FILE });
    main.publish('terminal', TOGGLE_ON);
    await flush();

    expect([of('ideContextUpdate'), of('terminalShown')]).toEqual([[], []]);
  });
});

describe('a local core', () => {
  it('posts its one editor\'s context and terminal pane to every view, and a send attaches that editor\'s file', async () => {
    const { main, of, send } = await chatOnCore(false);

    main.publish('editor', { context: A_FILE });
    main.publish('terminal', TOGGLE_ON);
    await flush();

    expect(of('ideContextUpdate')).toEqual([{ message: { type: 'ideContextUpdate', context: { type: 'opened_file', filePath: A_FILE.filePath, fileName: 'a.ts' } } }]);
    expect(of('terminalShown')).toEqual([{ message: { type: 'terminalShown', ...TOGGLE_ON } }]);
    expect(await send(undefined, undefined)).toContain('a.ts');
  });
});
