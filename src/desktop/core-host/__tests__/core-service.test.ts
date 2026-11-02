import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Disposable } from '../../../platform/disposable';
import type { PanelHost } from '../../../platform/window-service';
import { createCoreEndpoint, createLoopback, createMainEndpoint, processActor, type ChatEntry, type ChatPermissions, type CoreInit, type MainEndpoint } from '../../core-protocol';
import { createActorContext, type ActorContext } from '../../core-protocol/actor';
import type { CorePlatform } from '../platform';

const H = vi.hoisted(() => ({
  order: [] as string[],
  disposeProvider: (): Promise<void> => Promise.resolve(),
  disposeRuntime: (): Promise<void> => Promise.resolve(),
  panels: new Map<string, unknown>(),
  holdsPages: (_chat: unknown): boolean => false,
  activity: [] as Array<(panelId: string, activity: unknown) => void>,
  worktree: [] as Array<(event: unknown) => void>,
  permissions: [] as Array<(panelId: string) => void>,
  restored: [] as unknown[][],
  foreignDispatched: [] as unknown[][],
  clientAuthListeners: [] as Array<() => void>,
  relayedMcpListeners: [] as Array<() => void>,
  // each relayed MCP request this core ran, with the signal it got
  relayedRuns: [] as Array<{ request: unknown; signal: AbortSignal | undefined }>,
  attached: [] as Array<{ panelId: string; view: { clientId?: string } }>,
  dispatched: [] as unknown[][],
  clientNetwork: [] as unknown[][],
  // each page open and restore: the authority whose context ran it, then its arguments
  pages: [] as unknown[][],
  // each release main asked of the remote chats' browser relay, and the browser setting the relay reads
  browserReleases: [] as unknown[][],
  browserEnabled: undefined as (() => boolean) | undefined,
}));

// a context's page calls, recorded under its authority
const browserOf = (authority: string) => ({
  openNewPageForChat: async (chat: unknown, url?: string) => void H.pages.push([authority, chat, url]),
  restoreChatPages: async (chat: unknown, urls: readonly string[], active?: number) => void H.pages.push([authority, chat, urls, active]),
});

vi.mock('../../../core/browser', async (importOriginal) => ({
  ...await importOriginal<Record<string, unknown>>(),
  BrowserServices: class {
    setClientNetwork = (authority: string, policy: unknown) => void H.clientNetwork.push([authority, policy]);
    forAuthority = browserOf;
    dispose = async () => undefined;
  },
}));

vi.mock('../browser-relay', () => ({
  createRemoteBrowsers: (deps: { readonly enabled: () => boolean }) => {
    H.browserEnabled = deps.enabled;
    return {
      tool: async () => ({ content: [] }),
      release: (authority: string, agentScope: unknown) => void H.browserReleases.push(['scope', authority, agentScope]),
      releaseAuthority: async (authority: string) => void H.browserReleases.push(['authority', authority]),
    };
  },
}));

vi.mock('../../../core/logger', () => ({ log: (line: string) => H.order.push(`log: ${line}`) }));
vi.mock('../../../core/chat-panel/session-ownership', () => ({ announceLeaseRefusal: vi.fn(), leaseRefusalFor: vi.fn() }));
vi.mock('../../../core/pi-session/checkpoints', () => ({ runCheckpointMaintenance: async () => undefined, setCheckpointGitAvailability: () => undefined }));
vi.mock('../../../core/pi-session/mcp/mcp-auth', () => ({ setMcpSecretStorage: () => undefined }));
vi.mock('../../../core/voice/auto-disable', () => ({ setupAutoDisable: () => undefined }));
vi.mock('../../../core/workspace-folders/folder-registry', () => ({ settingsFolderOf: () => undefined }));
vi.mock('../../../core/pi-session/pi-runtime', () => ({
  PiRuntime: {
    exists: true,
    onClientAuthChange: (listener: () => void) => {
      H.clientAuthListeners.push(listener);
      return () => undefined;
    },
    disposeInstance: () => {
      H.order.push('runtime.dispose');
      return H.disposeRuntime();
    },
  },
}));
vi.mock('../../../core/chat-panel', () => {
  const none = (): Disposable => ({ dispose: () => undefined });
  const target = { key: '/p', fsPath: '/p', name: 'p', label: 'p', projectScope: false };
  const panelManager = {
    getPanels: () => H.panels,
    heldPrompt: () => undefined,
    onActivity: (listener: (panelId: string, activity: unknown) => void) => {
      H.activity.push(listener);
      return none();
    },
    onDidChangeWorktreeState: (listener: (event: unknown) => void) => {
      H.worktree.push(listener);
      return none();
    },
    onTurnSettled: none,
    onChatChanges: none,
    onUsageThreshold: none,
    onAllPanelsClosed: none,
    onRestoreRetry: none,
    onPermissionsChanged: (listener: (panelId: string) => void) => {
      H.permissions.push(listener);
      return none();
    },
    broadcast: () => undefined,
    setWorktreeOptIn: async () => undefined,
    attachView: (panelId: string, view: { clientId?: string }) => {
      H.attached.push({ panelId, view });
      return none();
    },
    dispatchFromView: async (panelId: string, view: { clientId?: string }, message: { type: string }) => void H.dispatched.push([panelId, view.clientId, message.type]),
  };
  return {
    ChatPanelProvider: class {
      getPanelManager = () => panelManager;
      getFolderRegistry = () => ({ onDidChange: none, onDidChangeOwned: none, defaultTarget: () => target, targets: () => [target], ownedFolders: () => [], branchOf: () => undefined });
      getSessionCatalog = () => ({ onDidChange: none });
      getWebviewPrompts = () => ({});
      getVoiceService = () => ({});
      getBrowserService = () => ({ holdsPages: (chat: unknown) => H.holdsPages(chat), ...browserOf('local') });
      getMemoryService = () => ({});
      onRelayedMcpChange = (listener: () => void) => {
        H.relayedMcpListeners.push(listener);
        return { dispose: () => undefined };
      };
      runRelayedMcp = (request: unknown, signal?: AbortSignal) => {
        H.relayedRuns.push({ request, signal });
        return new Promise((_resolve, reject) => signal?.addEventListener('abort', () => reject(new Error('stopped'))));
      };
      restorePanel = async (...args: unknown[]) => void H.restored.push(args);
      dispatchForeign = async (...args: unknown[]) => void H.foreignDispatched.push(args);
      dispose = () => {
        H.order.push('provider.dispose');
        return H.disposeProvider();
      };
    },
    flushCoreWrites: async () => void H.order.push('flushCoreWrites'),
  };
});

import { startCoreService } from '../core-service';
import { createFinishHolds } from '../worktrees';

const FOLDER = { key: '/p', fsPath: '/p', name: 'p', label: 'p', projectScope: false };
const IDLE = { state: 'idle', pendingKinds: [], pendingPrompts: [], background: false };

interface Chat {
  readonly host: PanelHost & { close: ReturnType<typeof vi.fn> };
  readonly instance: {
    host: PanelHost;
    folder: typeof FOLDER;
    restoreRetry?: string;
    session: { storedSessionId: string | null; hasConversation(): boolean; processing: boolean };
    permissionHandler: { permissions: ChatPermissions; getPermissions(): ChatPermissions };
  };
}

afterEach(() => {
  H.order.length = 0;
  H.panels.clear();
  H.activity.length = 0;
  H.worktree.length = 0;
  H.permissions.length = 0;
  H.restored.length = 0;
  H.foreignDispatched.length = 0;
  H.clientAuthListeners.length = 0;
  H.relayedMcpListeners.length = 0;
  H.relayedRuns.length = 0;
  H.attached.length = 0;
  H.dispatched.length = 0;
  H.clientNetwork.length = 0;
  H.pages.length = 0;
  H.browserReleases.length = 0;
  H.disposeProvider = () => Promise.resolve();
  H.disposeRuntime = () => Promise.resolve();
  H.holdsPages = () => false;
});

// actors: the forwarding side's actor context, as a daemon stamps a client's requests; core then serves them as that client
// clientNetwork: the init's mirror of each remote authority's network policy
function start(teardown: () => Promise<void> = async () => void H.order.push('teardown'), remote?: object, actors?: ActorContext, clientNetwork?: CoreInit['mirrors']['clientNetwork']): { main: MainEndpoint; addChat(panelId: string, viewId: string): Chat; foreign: Map<string, PanelHost>; authorities: Map<string, string> } {
  const loopback = createLoopback();
  const core = createCoreEndpoint(loopback.core, () => undefined, undefined, actors ? processActor : undefined);
  const main = createMainEndpoint(loopback.main, () => undefined, undefined, actors);
  const hosts = new Map<string, PanelHost>();
  const foreign = new Map<string, PanelHost>();
  const authorities = new Map<string, string>();
  const platform = {
    endpoint: core,
    panels: { get: (viewId: string) => hosts.get(viewId), attach: (viewId: string) => hosts.get(viewId), idOf: (host: PanelHost) => [...hosts].find(([, candidate]) => candidate === host)?.[0], foreign: (viewId: string) => foreign.get(viewId), foreignAuthority: (viewId: string) => authorities.get(viewId) },
    init: { git: { available: true }, e2eHooks: false, mirrors: clientNetwork ? { clientNetwork } : {} },
    secrets: {},
    settings: { get: <T>(_key: string, fallback: T) => fallback, onDidChange: () => ({ dispose: () => void H.order.push('subscription disposed') }) },
    setChatPrompts: () => undefined,
    notifications: {},
    remote,
  } as unknown as CorePlatform;
  startCoreService(platform, {
    chatFolders: { set: () => undefined, changed: () => undefined },
    finishHolds: createFinishHolds(),
    teardown,
    flushLogs: async () => void H.order.push('flushLogs'),
    setPlatform: () => undefined,
  });
  return {
    main,
    foreign,
    authorities,
    addChat: (panelId, viewId) => {
      const host = { close: vi.fn(), onDispose: () => ({ dispose: () => undefined }) } as unknown as Chat['host'];
      hosts.set(viewId, host);
      const permissionHandler: Chat['instance']['permissionHandler'] = {
        permissions: { permissionMode: 'acceptEdits', dangerouslySkipPermissions: true },
        getPermissions: () => permissionHandler.permissions,
      };
      const instance: Chat['instance'] = { host, folder: FOLDER, session: { storedSessionId: 's-1', hasConversation: () => true, processing: false }, permissionHandler };
      H.panels.set(panelId, instance);
      return { host, instance };
    },
  };
}

describe('core.shutdown', () => {
  it('disposes the engine, then core\'s services, then lands core\'s config writes and its logs', async () => {
    const { main } = start();
    await main.request('core.shutdown', {});
    expect(H.order).toEqual(['runtime.dispose', 'provider.dispose', 'subscription disposed', 'teardown', 'flushCoreWrites', 'log: Damocles core disposed', 'flushLogs']);
  });

  it('still lands core\'s writes and logs when the engine\'s dispose fails, and answers with that failure', async () => {
    H.disposeProvider = () => Promise.reject(new Error('memory close failed'));
    const { main } = start();
    await expect(main.request('core.shutdown', {})).rejects.toThrow('memory close failed');
    expect(H.order).toEqual(expect.arrayContaining(['teardown', 'flushCoreWrites', 'log: Damocles core disposed', 'flushLogs']));
    expect(H.order.indexOf('teardown')).toBeGreaterThan(H.order.indexOf('provider.dispose'));
    expect(H.order.some((step) => step.includes('memory close failed'))).toBe(true);
  });

  it('raises no unhandled rejection for a runtime dispose that fails while the provider still disposes', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      let providerDone!: () => void;
      H.disposeProvider = () => new Promise((resolve) => (providerDone = resolve));
      H.disposeRuntime = () => Promise.reject(new Error('runtime dispose failed'));
      const { main } = start();
      const shutdown = main.request('core.shutdown', {});
      await new Promise((resolve) => setImmediate(resolve));
      providerDone();
      await expect(shutdown).rejects.toThrow('runtime dispose failed');
      await new Promise((resolve) => setImmediate(resolve));
      expect(unhandled).not.toHaveBeenCalled();
      expect(H.order).toEqual(expect.arrayContaining(['teardown', 'flushCoreWrites', 'flushLogs']));
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  it('still lands core\'s writes and logs when the teardown fails', async () => {
    const { main } = start(() => Promise.reject(new Error('scm close failed')));
    await expect(main.request('core.shutdown', {})).rejects.toThrow('scm close failed');
    expect(H.order.slice(-4)).toEqual(['flushCoreWrites', expect.stringMatching(/^log: \[core\] shutdown step failed: Error: scm close failed/), 'log: Damocles core disposed', 'flushLogs']);
  });
});

describe('a request whose work changed a chat', () => {
  it('publishes the chat\'s entry before its reply', async () => {
    const { main, addChat } = start();
    addChat('panel-1', 'view-1');
    const order: string[] = [];
    main.onMirror('chats', ({ panelId, entry }) => order.push(`${panelId} ${entry?.viewId}`));
    await main.request('chats.setWorktreeOptIn', { panelId: 'panel-1', startRef: 'refs/heads/main', bringChanges: false });
    order.push('reply');
    expect(order).toEqual(['panel-1 view-1', 'reply']);
  });
});

describe('a chat\'s permissions', () => {
  const ASK_NO_YOLO: ChatPermissions = { permissionMode: 'default', dangerouslySkipPermissions: false };

  it('are on its entry, published again when they change, for main to hand the next core after this one ends', async () => {
    const { main, addChat } = start();
    const chat = addChat('panel-1', 'view-1');
    const entries: Array<ChatEntry | undefined> = [];
    main.onMirror('chats', ({ entry }) => entries.push(entry));
    await main.request('chats.setWorktreeOptIn', { panelId: 'panel-1', startRef: 'refs/heads/main', bringChanges: false });
    expect(entries.at(-1)?.permissions).toEqual({ permissionMode: 'acceptEdits', dangerouslySkipPermissions: true });

    chat.instance.permissionHandler.permissions = ASK_NO_YOLO;
    for (const listener of H.permissions) listener('panel-1');
    await main.request('chats.setWorktreeOptIn', { panelId: 'panel-1', startRef: 'refs/heads/main', bringChanges: false });
    expect(entries.map((entry) => entry?.permissions)).toEqual([{ permissionMode: 'acceptEdits', dangerouslySkipPermissions: true }, ASK_NO_YOLO]);
  });

  it('that main hands a restore reach the restored panel; a restore with none hands none', async () => {
    const { main, addChat } = start();
    const chat = addChat('panel-1', 'view-1');
    await main.request('chats.restore', { viewId: 'view-1', folderKey: '/p', permissions: ASK_NO_YOLO });
    await main.request('chats.restore', { viewId: 'view-1' });
    expect(H.restored).toEqual([[chat.host, '/p', ASK_NO_YOLO], [chat.host, undefined, undefined]]);
  });
});

describe('settingsView.attach', () => {
  it('names the device whose overlay attached, so only that device\'s posts and replies reach it', async () => {
    const actors = createActorContext();
    const { main } = start(undefined, undefined, actors);
    await actors.run('laptop', () => main.request('settingsView.attach', { panelId: 'panel-1', attachment: 1, scope: 'user' }));
    await main.request('settingsView.attach', { panelId: 'panel-2', attachment: 2 });
    expect(H.attached.map(({ panelId, view }) => [panelId, view.clientId])).toEqual([['panel-1', 'laptop'], ['panel-2', undefined]]);
  });

  it('runs each device\'s request on one chat as the view that device attached', async () => {
    const actors = createActorContext();
    const { main } = start(undefined, undefined, actors);
    await actors.run('laptop', () => main.request('settingsView.attach', { panelId: 'panel-1', attachment: 1 }));
    await actors.run('desktop', () => main.request('settingsView.attach', { panelId: 'panel-1', attachment: 2 }));
    await actors.run('desktop', () => main.request('settingsView.dispatch', { attachment: 2, message: { type: 'requestSettingsState' } }));
    await actors.run('laptop', () => main.request('settingsView.dispatch', { attachment: 1, message: { type: 'requestSettingsState' } }));
    expect(H.dispatched).toEqual([['panel-1', 'desktop', 'requestSettingsState'], ['panel-1', 'laptop', 'requestSettingsState']]);
  });
});

describe('chats.unload', () => {
  it('closes an idle chat', async () => {
    const { main, addChat } = start();
    const chat = addChat('panel-1', 'view-1');
    expect(await main.request('chats.unload', { viewId: 'view-1', empty: false })).toBe(true);
    expect(chat.host.close).toHaveBeenCalledOnce();
  });

  it('refuses a chat that became active, holds its worktree setup, restores, or holds pages', async () => {
    const { main, addChat } = start();
    const chat = addChat('panel-1', 'view-1');
    const unload = (): Promise<boolean> => main.request('chats.unload', { viewId: 'view-1', empty: false });

    for (const listener of H.activity) listener('panel-1', { ...IDLE, state: 'running' });
    expect(await unload()).toBe(false);
    for (const listener of H.activity) listener('panel-1', IDLE);

    const event = { panelId: 'panel-1', projectPath: '/p', workingFolder: '/p', busy: false, state: { phase: 'creating', place: 'worktree', canHandOff: false } };
    for (const listener of H.worktree) listener(event);
    expect(await unload()).toBe(false);
    for (const listener of H.worktree) listener({ ...event, state: { ...event.state, phase: 'ready' } });

    chat.instance.restoreRetry = 's-1';
    expect(await unload()).toBe(false);
    delete chat.instance.restoreRetry;

    H.holdsPages = (host) => host === chat.host;
    expect(await unload()).toBe(false);
    H.holdsPages = () => false;

    expect(await unload()).toBe(true);
    expect(chat.host.close).toHaveBeenCalledOnce();
  });

  it('refuses an empty chat that has a conversation or a session file by now', async () => {
    const { main, addChat } = start();
    const chat = addChat('panel-1', 'view-1');
    expect(await main.request('chats.unload', { viewId: 'view-1', empty: true })).toBe(false);
    chat.instance.session = { storedSessionId: null, hasConversation: () => false, processing: false };
    expect(await main.request('chats.unload', { viewId: 'view-1', empty: true })).toBe(true);
  });
});

describe('panels.foreignMessage', () => {
  it('dispatches a voice message of an attached remote view, and refuses any other message or an unattached view', async () => {
    const { main, foreign } = start();
    const proxy = {} as PanelHost;
    foreign.set('remote-view', proxy);
    await main.request('panels.foreignMessage', { viewId: 'remote-view', message: { type: 'startVoiceRecording' } });
    await expect(main.request('panels.foreignMessage', { viewId: 'remote-view', message: { type: 'sendMessage', text: 'hi' } })).rejects.toThrow('Only voice messages reach this computer from a remote chat');
    await expect(main.request('panels.foreignMessage', { viewId: 'other-view', message: { type: 'startVoiceRecording' } })).rejects.toThrow('The remote chat view is not attached');
    expect(H.foreignDispatched).toEqual([[proxy, { type: 'startVoiceRecording' }]]);
  });
});

describe('user.mcpChanged', () => {
  it('reports a change of this computer\'s relayed MCP servers, and a daemon\'s core sends none', async () => {
    const { main } = start();
    const heard = vi.fn();
    main.onEvent('user.mcpChanged', heard);
    for (const listener of H.relayedMcpListeners) listener();
    await vi.waitFor(() => expect(heard).toHaveBeenCalledTimes(1));
    H.relayedMcpListeners.length = 0;
    start(undefined, { hostId: 'h', clients: { onDidChange: () => ({ dispose: () => undefined }) } });
    expect(H.relayedMcpListeners).toEqual([]);
  });
});

describe('a remote chat\'s relayed MCP request on this computer\'s core', () => {
  it('ends the call, the resource listing and the read when the remote caller stops', async () => {
    const { main } = start();
    const requests = [
      () => ['user.mcp.call', { server: 'notes', tool: 'search', args: {} }] as const,
      () => ['user.mcp.resources', { server: 'notes', kind: 'resources' }] as const,
      () => ['user.mcp.readResource', { server: 'notes', uri: 'notes://a' }] as const,
    ];
    for (const [index, request] of requests.entries()) {
      const stop = new AbortController();
      const [method, params] = request();
      const pending = (main.request as (name: string, value: unknown, signal: AbortSignal) => Promise<unknown>)(method, params, stop.signal);
      pending.catch(() => undefined);
      await vi.waitFor(() => expect(H.relayedRuns).toHaveLength(index + 1));
      expect(H.relayedRuns[index]!.signal?.aborted).toBe(false);
      stop.abort();
      await vi.waitFor(() => expect(H.relayedRuns[index]!.signal?.aborted).toBe(true));
    }
  });
});

describe('user.clientAuthChanged', () => {
  it('reports this computer\'s sign-in changes, and a daemon\'s core sends none', async () => {
    const { main } = start();
    const heard = vi.fn();
    main.onEvent('user.clientAuthChanged', heard);
    for (const listener of H.clientAuthListeners) listener();
    await vi.waitFor(() => expect(heard).toHaveBeenCalledTimes(1));
    H.clientAuthListeners.length = 0;
    start(undefined, { hostId: 'h', clients: { onDidChange: () => ({ dispose: () => undefined }) } });
    expect(H.clientAuthListeners).toEqual([]);
  });
});

describe('a remote authority\'s browser network policy', () => {
  it('reaches its context from the init, then from every clientNetwork delta main publishes', () => {
    const { main } = start(undefined, undefined, undefined, { 'ssh-a': { allowedPorts: [3000], allowLocalNetwork: false } });
    main.publish('clientNetwork', { authority: 'ssh-b', allowedPorts: [8080], allowLocalNetwork: true });
    main.publish('clientNetwork', { authority: 'ssh-a', allowedPorts: [], allowLocalNetwork: false });
    expect(H.clientNetwork).toEqual([
      ['ssh-a', { allowedPorts: [3000], allowLocalNetwork: false }],
      ['ssh-b', { allowedPorts: [8080], allowLocalNetwork: true }],
      ['ssh-a', { allowedPorts: [], allowLocalNetwork: false }],
    ]);
  });
});

describe('a remote chat\'s browser on this core', () => {
  it('releases an agent\'s scope and Forget host\'s authority through the relay, which reads this computer\'s browser setting', async () => {
    const { main } = start();
    await main.request('user.browser.release', { authority: 'ssh-a', agentScope: { viewId: 'view-1', scope: 'agent-1', closeTabs: true, discard: true } });
    await main.request('user.browser.release', { authority: 'ssh-a' });
    expect(H.browserReleases).toEqual([
      ['scope', 'ssh-a', { viewId: 'view-1', scope: 'agent-1', closeTabs: true, discard: true }],
      ['authority', 'ssh-a'],
    ]);
    // the test platform's settings answer every default, and the browser is off by default
    expect(H.browserEnabled?.()).toBe(false);
  });
});

describe('a chat\'s browser pages', () => {
  it('open and restore in this core\'s context for its own chat, and in the authority\'s context for a remote chat it shows', async () => {
    const { main, addChat, foreign, authorities } = start();
    const chat = addChat('panel-1', 'view-1');
    const proxy = {} as PanelHost;
    foreign.set('remote-view', proxy);
    authorities.set('remote-view', 'ssh-h1');
    await main.request('browser.newPage', { chatViewId: 'view-1', url: 'https://example.com/' });
    await main.request('browser.newPage', { chatViewId: 'remote-view', url: 'http://localhost:3000/' });
    await main.request('chats.restorePages', { viewId: 'view-1', urls: ['https://a.test/'] });
    await main.request('chats.restorePages', { viewId: 'remote-view', urls: ['http://localhost:3000/', 'http://localhost:4000/'], activePage: 1 });
    expect(H.pages).toEqual([
      ['local', chat.host, 'https://example.com/'],
      ['ssh-h1', proxy, 'http://localhost:3000/'],
      ['local', chat.host, ['https://a.test/'], undefined],
      ['ssh-h1', proxy, ['http://localhost:3000/', 'http://localhost:4000/'], 1],
    ]);
  });

  it('open nowhere for a view core neither holds nor holds a remote proxy with an authority for', async () => {
    const { main, foreign } = start();
    foreign.set('no-authority', {} as PanelHost);
    for (const chatViewId of ['gone', 'no-authority']) {
      await expect(main.request('browser.newPage', { chatViewId })).rejects.toThrow('The chat is not loaded');
      await main.request('chats.restorePages', { viewId: chatViewId, urls: ['https://a.test/'] });
    }
    expect(H.pages).toEqual([]);
  });
});
