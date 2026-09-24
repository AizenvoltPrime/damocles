import * as path from 'path';
import * as vscode from 'vscode';
import { vi } from 'vitest';
import { PanelManager } from '../panel-manager';
import { WorkspaceFolderRegistry } from '../../workspace-folders/folder-registry';
import type { FolderTarget } from '../../workspace-folders/folder-registry';
import type { ChatSession } from '../../chat-session';
import type { HostInstance, WebviewHost } from '../types';
import type { ExtensionToWebviewMessage, WebviewToExtensionMessage } from '../../../shared/types/messages';

/** A `PanelManager` over fake webview hosts and fake sessions, with a real registry and permission handler. */

type FolderCb = () => void;
const workspace = vscode.workspace as unknown as {
  workspaceFolders: unknown;
  onDidChangeWorkspaceFolders?: (cb: FolderCb) => { dispose: () => void };
};

export interface FakeSession {
  cwd: string;
  conversation: boolean;
  /** The stored session this session is on or will open, as `persistenceSessionId` reports it. */
  storedId: string | null;
  readonly persistenceSessionId: string | null;
  holdsSession: (sessionId: string) => boolean;
  setResumeSession: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
  initializeEarly: ReturnType<typeof vi.fn>;
  setPermissionMode: ReturnType<typeof vi.fn>;
  hasConversation: () => boolean;
  getToolStatus: () => object;
  setMcpStatusListener: () => void;
}

export interface FakeHost extends WebviewHost {
  posted: ExtensionToWebviewMessage[];
  title: string;
  folderLabel: string | undefined;
  send(message: WebviewToExtensionMessage): void;
  closeFromUser(): void;
}

export function makeFakeHost(): FakeHost {
  const messageCbs: Array<(m: WebviewToExtensionMessage) => void> = [];
  const disposeCbs: Array<() => void> = [];
  const host: FakeHost = {
    posted: [],
    title: 'Damocles',
    folderLabel: undefined,
    webview: {
      onDidReceiveMessage: (cb: (m: WebviewToExtensionMessage) => void) => {
        messageCbs.push(cb);
        return { dispose: () => undefined };
      },
      postMessage: (m: ExtensionToWebviewMessage) => {
        host.posted.push(m);
        return Promise.resolve(true);
      },
    } as unknown as vscode.Webview,
    visible: true,
    active: true,
    viewColumn: 1,
    onDidDispose: ((cb: () => void) => {
      disposeCbs.push(cb);
      return { dispose: () => undefined };
    }) as unknown as vscode.Event<void>,
    onDidChangeVisibility: (() => ({ dispose: () => undefined })) as unknown as vscode.Event<void>,
    onDidChangeActive: (() => ({ dispose: () => undefined })) as unknown as vscode.Event<void>,
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
  registry: WorkspaceFolderRegistry;
  sessions: FakeSession[];
  /** Every webview message the router received, with the session the panel held at that moment. */
  routed: Array<{ message: WebviewToExtensionMessage; panelId: string; session: ChatSession | undefined }>;
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
  // The permission handler's diff manager registers a content provider the shared mock does not define.
  (vscode.workspace as unknown as Record<string, unknown>)['registerTextDocumentContentProvider'] = () => ({ dispose: () => undefined });
  let folderListeners: FolderCb[] = [];
  const realFolders = workspace.workspaceFolders;
  workspace.workspaceFolders = initial;
  workspace.onDidChangeWorkspaceFolders = (cb) => {
    folderListeners.push(cb);
    return { dispose: () => { folderListeners = folderListeners.filter((l) => l !== cb); } };
  };
  const stateValues = new Map<string, unknown>();
  const state = {
    get: (k: string) => stateValues.get(k),
    update: async (k: string, v: unknown) => { stateValues.set(k, v); },
    keys: () => [...stateValues.keys()],
  } as unknown as vscode.Memento;
  const registry = new WorkspaceFolderRegistry(state);

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
    extensionUri: vscode.Uri.file('/ext') as unknown as vscode.Uri,
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
    handleWebviewMessage: async (message, panelId) => {
      routed.push({ message, panelId, session: manager.getPanels().get(panelId)?.session });
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
    loadHistory: async () => undefined,
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
    setFolders: (folders) => {
      workspace.workspaceFolders = folders;
      for (const cb of [...folderListeners]) cb();
    },
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
      workspace.workspaceFolders = realFolders;
      delete workspace.onDidChangeWorkspaceFolders;
    },
  };
}

export function lastFolderUpdate(host: FakeHost): Extract<ExtensionToWebviewMessage, { type: 'workspaceFolderUpdate' }> | undefined {
  const updates = host.posted.filter((m): m is Extract<ExtensionToWebviewMessage, { type: 'workspaceFolderUpdate' }> => m.type === 'workspaceFolderUpdate');
  return updates.at(-1);
}
