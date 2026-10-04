import * as path from 'path';
import { vi } from 'vitest';
import { PanelManager } from '../panel-manager';
import { createFakePlatform, type FakePlatform } from '../../../__mocks__/fake-platform';
import { WorkspaceFolderRegistry } from '../../workspace-folders/folder-registry';
import type { FolderTarget } from '../../workspace-folders/folder-registry';
import type { ChatSession } from '../../chat-session';
import type { ChatActivity, TurnOutcome } from '../../pi-session/session-state';
import type { AttachedView, HostInstance } from '../types';
import type { PanelHost } from '../../../platform/window-service';
import type { ExtensionToWebviewMessage, WebviewToExtensionMessage } from '../../../shared/types/messages';

/** A `PanelManager` over fake webview hosts and fake sessions, with a real registry and permission handler. */

export interface FakeSession {
  cwd: string;
  conversation: boolean;
  /** The stored session this session is on or will open, as `persistenceSessionId` reports it. */
  storedId: string | null;
  readonly persistenceSessionId: string | null;
  readonly storedSessionId: string | null;
  /** The panel manager's activity forwarding while this session is bound, else null. */
  activityListener: ((activity: ChatActivity) => void) | null;
  setActivityListener: (listener: ((activity: ChatActivity) => void) | null) => void;
  setTurnSettledListener: (listener: ((outcome: TurnOutcome) => void) | null) => void;
  holdsSession: (sessionId: string) => boolean;
  setResumeSession: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
  initializeEarly: ReturnType<typeof vi.fn>;
  setPermissionMode: ReturnType<typeof vi.fn>;
  hasConversation: () => boolean;
  getToolStatus: () => object;
  setMcpStatusListener: () => void;
}

export interface FakeHost extends PanelHost {
  posted: ExtensionToWebviewMessage[];
  title: string;
  folderLabel: string | undefined;
  send(message: WebviewToExtensionMessage): void;
  closeFromUser(): void;
}

export function makeFakeHost(): FakeHost {
  const messageCbs: Array<(m: unknown) => void> = [];
  const disposeCbs: Array<() => void> = [];
  const host: FakeHost = {
    posted: [],
    title: 'Damocles',
    folderLabel: undefined,
    visible: true,
    active: true,
    column: 1,
    cspSource: '',
    themeCssSource: () => '',
    setHtml: () => undefined,
    postMessage: (m) => {
      host.posted.push(m as ExtensionToWebviewMessage);
      return Promise.resolve(true);
    },
    onMessage: (cb) => {
      messageCbs.push(cb);
      return { dispose: () => undefined };
    },
    onDispose: (cb) => {
      disposeCbs.push(cb);
      return { dispose: () => undefined };
    },
    onDidChangeViewState: () => ({ dispose: () => undefined }),
    asResourceUri: (absolutePath) => absolutePath,
    setIcon: () => undefined,
    setTitle: (title) => { host.title = title; },
    reveal: () => undefined,
    close: () => undefined,
    setFolderLabel: (label) => {
      host.folderLabel = label;
      host.title = label === undefined ? 'Damocles' : `Damocles · ${label}`;
    },
    send: (m) => { for (const cb of [...messageCbs]) cb(m); },
    closeFromUser: () => { for (const cb of [...disposeCbs]) cb(); },
  };
  return host;
}

export function folderEntry(fsPath: string, name = path.basename(fsPath)) {
  return { uri: { fsPath, scheme: 'file' }, name, index: 0 };
}

export interface Harness {
  manager: PanelManager;
  platform: FakePlatform;
  registry: WorkspaceFolderRegistry;
  sessions: FakeSession[];
  /** Every webview message the router received, with the session the panel held at that moment. */
  routed: Array<{ message: WebviewToExtensionMessage; panelId: string; session: ChatSession | undefined; view?: AttachedView }>;
  released: string[];
  /** A folder key here makes its release reject with that error, after it is recorded in `released`. */
  releaseErrors: Map<string, Error>;
  folderStatePushes: HostInstance[];
  /** Resolves the next session creation; creation waits while set. */
  holdCreation: { gate: Promise<void> | null };
  /** Each session creation takes the next error from the front and rejects with it, while any remain. */
  failCreation: { errors: Error[] };
  /** Awaited inside `sendFolderState`, so a test can act while the switch is re-pushing folder state. */
  holdFolderState: { gate: Promise<void> | null };
  /** The folder key each `getInitialMessages` call was asked about, in order. */
  initialMessageFolders: string[];
  /** How many times the manager reported a change of the last-focused panel or its folder. */
  activePanelChanges: { count: number };
  setFolders(folders: ReturnType<typeof folderEntry>[]): void;
  target(fsPath: string): FolderTarget;
  instance(panelId: string): HostInstance;
  dispose(): void;
}

export function createHarness(initial: ReturnType<typeof folderEntry>[]): Harness {
  const openFolders = (folders: ReturnType<typeof folderEntry>[]) => folders.map((f) => ({ fsPath: f.uri.fsPath, name: f.name }));
  const platform = createFakePlatform({ folders: openFolders(initial) });
  const registry = new WorkspaceFolderRegistry(platform.workspaceFolders, platform.state.workspace, platform.fileWatchers);

  const sessions: FakeSession[] = [];
  const routed: Harness['routed'] = [];
  const released: string[] = [];
  const releaseErrors = new Map<string, Error>();
  const folderStatePushes: HostInstance[] = [];
  const holdCreation: Harness['holdCreation'] = { gate: null };
  const failCreation: Harness['failCreation'] = { errors: [] };
  const holdFolderState: Harness['holdFolderState'] = { gate: null };
  const initialMessageFolders: string[] = [];
  const activePanelChanges = { count: 0 };
  const manager: PanelManager = new PanelManager({
    platform,
    folderRegistry: registry,
    createSessionForPanel: async (_host, _ph, _panelId, folder) => {
      if (holdCreation.gate) await holdCreation.gate;
      const error = failCreation.errors.shift();
      if (error) throw error;
      const session: FakeSession = {
        cwd: folder.fsPath,
        conversation: false,
        storedId: null,
        get persistenceSessionId() { return session.storedId; },
        get storedSessionId() { return session.storedId; },
        activityListener: null,
        setActivityListener: (listener) => {
          session.activityListener = listener;
          listener?.({ state: 'idle', pendingKinds: [], background: false });
        },
        setTurnSettledListener: () => undefined,
        holdsSession: (id) => session.storedId === id,
        setResumeSession: vi.fn((id: string | null) => { session.storedId = id; }),
        dispose: vi.fn(async () => undefined),
        initializeEarly: vi.fn(async () => undefined),
        setPermissionMode: vi.fn(async () => undefined),
        hasConversation: () => session.conversation,
        getToolStatus: () => ({}),
        setMcpStatusListener: () => undefined,
      };
      sessions.push(session);
      return session as unknown as ChatSession;
    },
    handleWebviewMessage: async (message, panelId, view) => {
      routed.push({ message, panelId, session: manager.getPanels().get(panelId)?.session, ...(view ? { view } : {}) });
    },
    sendCurrentSettings: async () => undefined,
    getStoredSessions: async () => ({ sessions: [], hasMore: false, nextOffset: 0 }),
    invalidateSessionsCache: () => undefined,
    initPanelModel: () => undefined,
    cleanupPanelModel: () => undefined,
    cleanupPanelThinking: () => undefined,
    sendThinkingForPanel: () => undefined,
    getInitialMessages: (folder) => { initialMessageFolders.push(folder.key); return []; },
    onActivePanelChanged: () => { activePanelChanges.count++; },
    inheritSettingsFromPanel: () => undefined,
    loadHistory: async () => [],
    sendFolderState: async (instance) => {
      folderStatePushes.push(instance);
      if (holdFolderState.gate) await holdFolderState.gate;
    },
    releaseFolder: async (key) => {
      released.push(key);
      const error = releaseErrors.get(key);
      if (error) throw error;
    },
  });

  return {
    manager,
    platform,
    registry,
    sessions,
    routed,
    released,
    releaseErrors,
    folderStatePushes,
    holdCreation,
    failCreation,
    holdFolderState,
    initialMessageFolders,
    activePanelChanges,
    setFolders: (folders) => platform.workspaceFolders.setFolders(openFolders(folders)),
    target: (fsPath) => {
      const found = registry.targets().find((t) => t.fsPath === fsPath);
      if (!found) throw new Error(`no target for ${fsPath}`);
      return found;
    },
    instance: (panelId) => {
      const found = manager.getPanels().get(panelId);
      if (!found) throw new Error(`no panel ${panelId}`);
      return found;
    },
    dispose: () => {
      manager.dispose();
      registry.dispose();
    },
  };
}

export function lastFolderUpdate(host: FakeHost): Extract<ExtensionToWebviewMessage, { type: 'workspaceFolderUpdate' }> | undefined {
  const updates = host.posted.filter((m): m is Extract<ExtensionToWebviewMessage, { type: 'workspaceFolderUpdate' }> => m.type === 'workspaceFolderUpdate');
  return updates.at(-1);
}
