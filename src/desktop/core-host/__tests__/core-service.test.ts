import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Disposable } from '../../../platform/disposable';
import type { PanelHost } from '../../../platform/window-service';
import { createCoreEndpoint, createLoopback, createMainEndpoint, type ChatEntry, type ChatPermissions, type MainEndpoint } from '../../core-protocol';
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
  };
  return {
    ChatPanelProvider: class {
      getPanelManager = () => panelManager;
      getFolderRegistry = () => ({ onDidChange: none, onDidChangeOwned: none, defaultTarget: () => target, targets: () => [target], ownedFolders: () => [], branchOf: () => undefined });
      getSessionCatalog = () => ({ onDidChange: none });
      getWebviewPrompts = () => ({});
      getVoiceService = () => ({});
      getBrowserService = () => ({ holdsPages: (chat: unknown) => H.holdsPages(chat) });
      restorePanel = async (...args: unknown[]) => void H.restored.push(args);
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
  H.disposeProvider = () => Promise.resolve();
  H.disposeRuntime = () => Promise.resolve();
  H.holdsPages = () => false;
});

function start(teardown: () => Promise<void> = async () => void H.order.push('teardown')): { main: MainEndpoint; addChat(panelId: string, viewId: string): Chat } {
  const loopback = createLoopback();
  const core = createCoreEndpoint(loopback.core, () => undefined);
  const main = createMainEndpoint(loopback.main, () => undefined);
  const hosts = new Map<string, PanelHost>();
  const platform = {
    endpoint: core,
    panels: { get: (viewId: string) => hosts.get(viewId), attach: (viewId: string) => hosts.get(viewId), idOf: (host: PanelHost) => [...hosts].find(([, candidate]) => candidate === host)?.[0] },
    init: { git: { available: true }, e2eHooks: false },
    secrets: {},
    settings: { get: <T>(_key: string, fallback: T) => fallback, onDidChange: () => ({ dispose: () => void H.order.push('subscription disposed') }) },
    setChatPrompts: () => undefined,
    notifications: {},
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
