// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { createApp, defineComponent, ref } from 'vue';
import { mount } from '@vue/test-utils';
import { createHandlerRegistry } from '../../handler-registry';
import type { HandlerRegistry, HandlerContext, StoreContext } from '../../types';
import { i18n } from '@/i18n';
import { useUIStore } from '@/stores/useUIStore';
import { useStreamingStore } from '@/stores/useStreamingStore';
import { useSubagentStore } from '@/stores/useSubagentStore';
import { useSessionStore } from '@/stores/useSessionStore';
import { useQuestionStore } from '@/stores/useQuestionStore';
import { useFormStore } from '@/stores/useFormStore';
import { usePermissionStore } from '@/stores/usePermissionStore';
import { usePlanViewStore } from '@/stores/usePlanViewStore';
import { useTaskStore } from '@/stores/useTaskStore';
import { useContextInjectionStore } from '@/stores/useContextInjectionStore';
import { useContextUsageStore } from '@/stores/useContextUsageStore';
import { useSubscriptionUsageStore } from '@/stores/useSubscriptionUsageStore';
import { useElicitationStore } from '@/stores/useElicitationStore';
import { useBtwStore } from '@/stores/useBtwStore';
import { useTeamStore } from '@/stores/useTeamStore';
import { useSettingsStore } from '@/stores/useSettingsStore';
import { useMemoryStore } from '@/stores/useMemoryStore';
import { useCompassStore } from '@/stores/useCompassStore';
import { useMessageHandler } from '../../index';
import type { ExtensionToWebviewMessage } from '@shared/types/messages';
import type { StoredSession } from '@shared/types/session';
import type { WorkspaceFolderInfo } from '@shared/types/workspace-folders';

const toastMock = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }));
vi.mock('vue-sonner', () => ({ toast: toastMock }));

/**
 * A session reset must close whatever tool overlay was open.
 *
 * The expanded tool id used to live on `useStreamingStore`, so `streamingStore.$reset()` cleared it for
 * free at both reset sites. It lives on `useUIStore` now, and these handlers never call
 * `uiStore.$reset()`, so the clearing has to be an explicit `uiStore.collapseTool()` in each handler.
 * Without it a stale id survives a session switch and can later resolve against an unrelated call that
 * happens to carry the same id. Both reset sites are driven, because each adds its own steps around the
 * shared reset.
 */

function context(): HandlerContext {
  const stores = {
    uiStore: useUIStore(),
    streamingStore: useStreamingStore(),
    sessionStore: useSessionStore(),
    subagentStore: useSubagentStore(),
    questionStore: useQuestionStore(),
    formStore: useFormStore(),
    permissionStore: usePermissionStore(),
    planViewStore: usePlanViewStore(),
    taskStore: useTaskStore(),
    contextInjectionStore: useContextInjectionStore(),
    contextUsageStore: useContextUsageStore(),
    subscriptionUsageStore: useSubscriptionUsageStore(),
    elicitationStore: useElicitationStore(),
    btwStore: useBtwStore(),
    teamStore: useTeamStore(),
    settingsStore: useSettingsStore(),
    memoryStore: useMemoryStore(),
    compassStore: useCompassStore(),
  } as unknown as StoreContext;

  let state: Record<string, unknown> = {};
  return {
    stores,
    refs: { messageContainerRef: { value: null }, chatInputRef: { value: null } },
    vscode: {
      postMessage: vi.fn(),
      getState: <T,>() => state as T,
      setState: <T,>(next: T) => {
        state = next as Record<string, unknown>;
      },
    },
  } as unknown as HandlerContext;
}

/** `createHandlerRegistry` calls `useI18n()`, which is only legal inside a component `setup`. */
function buildRegistry(): HandlerRegistry {
  let registry!: HandlerRegistry;
  const app = createApp({
    setup() {
      registry = createHandlerRegistry();
      return () => null;
    },
  });
  app.use(i18n);
  app.mount(document.createElement('div'));
  app.unmount();
  return registry;
}

function dispatch(msg: ExtensionToWebviewMessage, ctx: HandlerContext): void {
  const handler = buildRegistry()[msg.type] as
    | ((m: ExtensionToWebviewMessage, c: HandlerContext) => void)
    | undefined;
  if (!handler) throw new Error(`no handler registered for ${msg.type}`);
  handler(msg, ctx);
}

describe('a session reset closing the open tool overlay', () => {
  beforeEach(() => setActivePinia(createPinia()));

  it.each([
    ['sessionCleared', { type: 'sessionCleared' } as const],
    ['conversationCleared', { type: 'conversationCleared' } as const],
  ])('%s clears the expanded tool', (_name, msg) => {
    const ctx = context();
    const uiStore = ctx.stores.uiStore;
    uiStore.expandTool('t-1', 'subagent');

    dispatch(msg, ctx);

    expect(uiStore.expandedToolId).toBeNull();
    expect(uiStore.expandedToolSource).toBeNull();
  });
});

describe('resumeAccepted', () => {
  beforeEach(() => setActivePinia(createPinia()));

  it('clears the shown conversation and selects the accepted one under its stored name', () => {
    // Selecting from history no longer clears the panel up front, so this is the only place it happens.
    const ctx = context();
    const { sessionStore, streamingStore } = ctx.stores;
    const stored: StoredSession = { id: 's-x', timestamp: 1, preview: 'first prompt', customTitle: 'Refactor' };
    sessionStore.updateStoredSessions([stored], true, false, 1);
    streamingStore.addUserMessage('the conversation on screen');

    dispatch({ type: 'resumeAccepted', sessionId: 's-x' }, ctx);

    expect(streamingStore.messages).toEqual([]);
    expect(sessionStore.selectedSessionId).toBe('s-x');
    expect(sessionStore.selectedSessionName).toBe('Refactor');
    expect(sessionStore.currentResumedSessionId).toBe('s-x');
    expect(ctx.vscode.getState()).toMatchObject({ sessionId: 's-x', sessionName: 'Refactor' });
  });
});

describe('the webview reading sessionStateChanged', () => {
  beforeEach(() => setActivePinia(createPinia()));

  it.each([
    ['idle', false],
    ['running', false],
    ['requires_action', true],
  ] as const)('writes %s into the session store unchanged', (state, awaiting) => {
    const ctx = context();

    dispatch({ type: 'sessionStateChanged', state, sessionId: 's-1' }, ctx);

    expect(ctx.stores.sessionStore.sessionState).toBe(state);
    expect(ctx.stores.sessionStore.isAwaitingUserAction).toBe(awaiting);
  });

  it('replays a full parked-and-resumed turn onto the store in order', () => {
    const ctx = context();
    const seen: string[] = [];

    for (const state of ['running', 'requires_action', 'running', 'requires_action', 'running', 'idle'] as const) {
      dispatch({ type: 'sessionStateChanged', state, sessionId: 's-1' }, ctx);
      seen.push(ctx.stores.sessionStore.sessionState);
    }

    expect(seen).toEqual(['running', 'requires_action', 'running', 'requires_action', 'running', 'idle']);
  });

  it('leaves no parked state behind when idle follows requires_action directly', () => {
    const ctx = context();

    dispatch({ type: 'sessionStateChanged', state: 'requires_action', sessionId: 's-1' }, ctx);
    dispatch({ type: 'sessionStateChanged', state: 'idle', sessionId: 's-1' }, ctx);

    expect(ctx.stores.sessionStore.isAwaitingUserAction).toBe(false);
  });

  it('does not filter on the session id, which can arrive after the first running', () => {
    const ctx = context();
    ctx.stores.sessionStore.setCurrentSession('s-old');

    dispatch({ type: 'sessionStateChanged', state: 'requires_action', sessionId: 's-new' }, ctx);

    expect(ctx.stores.sessionStore.isAwaitingUserAction).toBe(true);
  });
});

/**
 * The seven sequences the extension publisher can produce, copied from the emitted-sequences contract.
 * Each row lands the webview on `idle` with nothing parked, which is what a stuck indicator would break.
 * Two rows are the ones a naive store gets wrong: a cancel jumps from `requires_action` straight to
 * `idle`, and a dialog opened outside a turn starts at `requires_action` with no `running` at all.
 */
const PUBLISHED_SEQUENCES = [
  ['clean turn, no prompts', ['running', 'idle']],
  ['one prompt answered mid turn', ['running', 'requires_action', 'running', 'idle']],
  ['permission dialog then a team agent elicitation', ['running', 'requires_action', 'running', 'requires_action', 'running', 'idle']],
  ['two prompts open at once, answered one at a time', ['running', 'requires_action', 'running', 'idle']],
  ['a ctx.ui dialog withdrawn by its abort signal', ['running', 'requires_action', 'running', 'idle']],
  ['turn cancelled with a permission dialog open', ['running', 'requires_action', 'idle']],
  ['a dialog opened with no turn in flight', ['requires_action', 'idle']],
] as const;

describe('every sequence the extension publisher can produce', () => {
  beforeEach(() => setActivePinia(createPinia()));

  it.each(PUBLISHED_SEQUENCES)('%s replays onto the store in order', (_name, sequence) => {
    const ctx = context();
    const seen: string[] = [];

    for (const state of sequence) {
      dispatch({ type: 'sessionStateChanged', state, sessionId: 's-1' }, ctx);
      seen.push(ctx.stores.sessionStore.sessionState);
    }

    expect(seen).toEqual([...sequence]);
  });

  it.each(PUBLISHED_SEQUENCES)('%s ends idle with nothing parked', (_name, sequence) => {
    const ctx = context();

    for (const state of sequence) {
      dispatch({ type: 'sessionStateChanged', state, sessionId: 's-1' }, ctx);
    }

    expect(ctx.stores.sessionStore.sessionState).toBe('idle');
    expect(ctx.stores.sessionStore.isAwaitingUserAction).toBe(false);
  });

  it('parks on the very first message when a dialog opens on a fresh panel', () => {
    // A dialog opened outside a turn publishes before any sessionStarted, so the store cannot wait for one.
    const ctx = context();

    expect(ctx.stores.sessionStore.sessionState).toBe('idle');

    dispatch({ type: 'sessionStateChanged', state: 'requires_action', sessionId: 's-1' }, ctx);

    expect(ctx.stores.sessionStore.isAwaitingUserAction).toBe(true);
  });

  it('stays up when a turn settles under an open dialog and no message arrives', () => {
    // The publisher suppresses the repeat, so the parked state has to survive the silence at turn end.
    const ctx = context();

    dispatch({ type: 'sessionStateChanged', state: 'running', sessionId: 's-1' }, ctx);
    dispatch({ type: 'sessionStateChanged', state: 'requires_action', sessionId: 's-1' }, ctx);
    dispatch({ type: 'processing', isProcessing: false }, ctx);

    expect(ctx.stores.sessionStore.isAwaitingUserAction).toBe(true);
    expect(ctx.stores.uiStore.isProcessing).toBe(false);
  });
});

const FOLDERS: WorkspaceFolderInfo[] = [
  { key: 'c:\\work\\client\\app', name: 'app', label: 'app (client)', path: 'C:\\work\\client\\app' },
  { key: 'c:\\work\\server\\app', name: 'app', label: 'app (server)', path: 'C:\\work\\server\\app' },
];
const [CLIENT, SERVER] = FOLDERS as [WorkspaceFolderInfo, WorkspaceFolderInfo];

function folderUpdate(panelFolderKey: string, switched?: boolean): ExtensionToWebviewMessage {
  return {
    type: 'workspaceFolderUpdate',
    folders: FOLDERS,
    panelFolderKey,
    defaultFolderKey: CLIENT.key,
    ...(switched !== undefined && { switched }),
  };
}

/** A panel that has a conversation on screen and a persisted session, as a folder switch finds it. */
function contextWithConversation(): HandlerContext {
  const ctx = context();
  const { sessionStore, streamingStore } = ctx.stores;
  streamingStore.addUserMessage('the conversation on screen');
  sessionStore.setCurrentSession('s-1');
  sessionStore.setSelectedSession('s-1', 'Refactor');
  ctx.vscode.setState({ sessionId: 's-1', sessionName: 'Refactor', workspaceFolderKey: CLIENT.key });
  return ctx;
}

describe('workspaceFolderUpdate', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
  });

  it('switched: clears the conversation, forgets the session, keeps the new folder and names it in a toast', () => {
    const ctx = contextWithConversation();
    const { sessionStore, streamingStore, settingsStore } = ctx.stores;

    dispatch(folderUpdate(SERVER.key, true), ctx);

    expect(streamingStore.messages).toEqual([]);
    expect(sessionStore.currentSessionId).toBeNull();
    expect(sessionStore.selectedSessionId).toBeNull();
    expect(settingsStore.panelWorkspaceFolderKey).toBe(SERVER.key);
    expect(ctx.vscode.getState()).toEqual({ sessionId: undefined, sessionName: undefined, workspaceFolderKey: SERVER.key });
    expect(toastMock.success).toHaveBeenCalledTimes(1);
    expect(toastMock.success).toHaveBeenCalledWith(i18n.global.t('toast.workspaceFolderSwitched', { folder: 'app (server)' }));
    // vue-i18n returns the bare key for a missing entry, which the equality above would also accept.
    expect(toastMock.success.mock.calls[0]?.[0]).toContain('app (server)');
  });

  it('without switched: leaves the conversation alone and shows no toast', () => {
    // A cancelled modal re-posts the current folder without `switched`; the conversation must survive it.
    const ctx = contextWithConversation();
    const { sessionStore, streamingStore, settingsStore } = ctx.stores;

    dispatch(folderUpdate(CLIENT.key), ctx);

    expect(streamingStore.messages).toHaveLength(1);
    expect(sessionStore.selectedSessionId).toBe('s-1');
    expect(settingsStore.panelWorkspaceFolderKey).toBe(CLIENT.key);
    expect(ctx.vscode.getState()).toEqual({ sessionId: 's-1', sessionName: 'Refactor', workspaceFolderKey: CLIENT.key });
    expect(toastMock.success).not.toHaveBeenCalled();
  });

  it('switched: false behaves like an absent flag', () => {
    const ctx = contextWithConversation();

    dispatch(folderUpdate(CLIENT.key, false), ctx);

    expect(ctx.stores.streamingStore.messages).toHaveLength(1);
    expect(toastMock.success).not.toHaveBeenCalled();
  });

  it('starts with no folders and not multi-root, so nothing folder-related renders before the first payload', () => {
    const store = useSettingsStore();
    expect(store.workspaceFolders).toEqual([]);
    expect(store.isMultiRoot).toBe(false);
  });

  it('stores the folders, the panel key and the default key', () => {
    const ctx = context();

    dispatch({ type: 'workspaceFolderUpdate', folders: FOLDERS, panelFolderKey: SERVER.key, defaultFolderKey: CLIENT.key }, ctx);

    const store = ctx.stores.settingsStore;
    expect(store.workspaceFolders).toEqual(FOLDERS);
    expect(store.panelWorkspaceFolderKey).toBe(SERVER.key);
    expect(store.defaultWorkspaceFolderKey).toBe(CLIENT.key);
    expect(store.isMultiRoot).toBe(true);
  });

  it('is not multi-root with one folder, which is also what a no-folder window sends', () => {
    const ctx = context();

    dispatch({ type: 'workspaceFolderUpdate', folders: [CLIENT], panelFolderKey: CLIENT.key, defaultFolderKey: CLIENT.key }, ctx);

    expect(ctx.stores.settingsStore.isMultiRoot).toBe(false);
  });

  it('persists a changed panel key into webview state without dropping the saved session', () => {
    const ctx = contextWithConversation();

    dispatch(folderUpdate(SERVER.key), ctx);

    expect(ctx.vscode.getState()).toEqual({ sessionId: 's-1', sessionName: 'Refactor', workspaceFolderKey: SERVER.key });
  });

  // The extension answers every setPanelWorkspaceFolder with one of these, including a cancel and a failure.
  it.each([
    ['a confirmed switch', true],
    ['a cancel or a failure', undefined],
  ])('ends a pending switch on %s', (_name, switched) => {
    const ctx = contextWithConversation();
    const { settingsStore } = ctx.stores;
    settingsStore.setWorkspaceFolders(FOLDERS, CLIENT.key, CLIENT.key);
    settingsStore.requestPanelWorkspaceFolder(SERVER.key);
    expect(settingsStore.workspaceFolderSwitchPending).toBe(true);

    dispatch(folderUpdate(switched ? SERVER.key : CLIENT.key, switched), ctx);

    expect(settingsStore.workspaceFolderSwitchPending).toBe(false);
  });
});

describe('workspaceFolderUpdate drops the previous folder Compass data', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
  });

  /** A Compass graph panel open on the client folder, with every folder-bound field populated. */
  function contextWithCompass(): HandlerContext {
    const ctx = contextWithConversation();
    const { compassStore } = ctx.stores;
    compassStore.updateStatus({ state: 'ready' } as never);
    compassStore.setGraphData({ nodes: [{ file_path: 'C:/work/client/app/main.ts' }], edges: [], communities: [] } as never);
    compassStore.setSearchResults([{ qualified_name: 'client.main' }] as never);
    compassStore.searchQuery = 'main';
    compassStore.graphCommunityFilter = 3;
    compassStore.setBlastRadius({ changedFiles: [] } as never);
    compassStore.setValidationResult({ issues: [] } as never);
    compassStore.buildProgress = { current: 1, total: 2, phase: 'parse' };
    compassStore.setActivePanel('graph');
    compassStore.setEdgeKindVisible('CALLS', false);
    return ctx;
  }

  it('switched: clears the graph, search, blast radius, validation, progress and status, and closes the view', () => {
    const ctx = contextWithCompass();
    const { compassStore } = ctx.stores;

    dispatch(folderUpdate(SERVER.key, true), ctx);

    expect(compassStore.graphData).toBeNull();
    expect(compassStore.searchResults).toEqual([]);
    expect(compassStore.searchQuery).toBe('');
    expect(compassStore.graphCommunityFilter).toBeNull();
    expect(compassStore.blastRadius).toBeNull();
    expect(compassStore.validationResult).toBeNull();
    expect(compassStore.buildProgress).toBeNull();
    expect(compassStore.status).toBeNull();
    expect(compassStore.activePanel).toBeNull();
    // A view preference, not folder data.
    expect(compassStore.visibleEdgeKinds.has('CALLS')).toBe(false);
  });

  it('without switched: keeps the Compass data', () => {
    const ctx = contextWithCompass();

    dispatch(folderUpdate(CLIENT.key), ctx);

    expect(ctx.stores.compassStore.graphData).not.toBeNull();
    expect(ctx.stores.compassStore.activePanel).toBe('graph');
  });
});

describe('workspaceFolderUpdate reloads the Memory panel for the new folder', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
  });

  const OLD_MEMORY = { id: 'm-old', tier: 'project', kind: 'fact', scope: 'project', content: 'old folder fact', sessionId: null, workspace: '/old', createdAt: 1, updatedAt: 1, tags: [] } as never;

  it('switched with the Memory panel open: drops the previous folder memories and profile and re-requests both', () => {
    const ctx = contextWithConversation();
    const { memoryStore, uiStore } = ctx.stores;
    memoryStore.setMemories([OLD_MEMORY], true, { createdAt: 1, id: 'm-old' });
    memoryStore.setProfile({ static: 'old project', dynamic: '' }, { static: 'global', dynamic: '' });
    memoryStore.setKindFilter('fact');
    uiStore.openMemoryPanel();

    dispatch(folderUpdate(SERVER.key, true), ctx);

    expect(memoryStore.memories).toEqual([]);
    expect(memoryStore.observationCursor).toBeNull();
    expect(memoryStore.profile.project.static).toBe('');
    expect(memoryStore.kindFilter).toBe('fact');
    expect(ctx.vscode.postMessage).toHaveBeenCalledWith({ type: 'requestMemories' });
    expect(ctx.vscode.postMessage).toHaveBeenCalledWith({ type: 'getProfile' });
  });

  it('switched with the Memory panel closed: clears without requesting, since opening the panel requests', () => {
    const ctx = contextWithConversation();
    ctx.stores.memoryStore.setMemories([OLD_MEMORY]);

    dispatch(folderUpdate(SERVER.key, true), ctx);

    expect(ctx.stores.memoryStore.memories).toEqual([]);
    expect(ctx.vscode.postMessage).not.toHaveBeenCalledWith({ type: 'requestMemories' });
  });

  it('without switched: keeps the loaded memories and requests nothing', () => {
    const ctx = contextWithConversation();
    ctx.stores.memoryStore.setMemories([OLD_MEMORY]);
    ctx.stores.uiStore.openMemoryPanel();

    dispatch(folderUpdate(CLIENT.key), ctx);

    expect(ctx.stores.memoryStore.memories).toHaveLength(1);
    expect(ctx.vscode.postMessage).not.toHaveBeenCalledWith({ type: 'requestMemories' });
  });
});

describe('conversationCleared', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
  });

  it('clears the conversation and the persisted session, keeps the folder key, and toasts its own message', () => {
    const ctx = contextWithConversation();
    const { sessionStore, streamingStore } = ctx.stores;

    dispatch({ type: 'conversationCleared' }, ctx);

    expect(streamingStore.messages).toEqual([]);
    expect(sessionStore.selectedSessionId).toBeNull();
    expect(ctx.vscode.getState()).toEqual({ sessionId: undefined, sessionName: undefined, workspaceFolderKey: CLIENT.key });
    expect(toastMock.success).toHaveBeenCalledWith(i18n.global.t('toast.conversationCleared'));
  });
});

describe('ready', () => {
  const api = (globalThis as unknown as {
    acquireVsCodeApi: () => { postMessage: (m: unknown) => void; getState: () => unknown };
  }).acquireVsCodeApi();
  const unmounts: (() => void)[] = [];

  beforeEach(() => setActivePinia(createPinia()));
  afterEach(() => {
    while (unmounts.length) unmounts.pop()?.();
    vi.restoreAllMocks();
  });

  function mountHandler(savedState: unknown): unknown[] {
    const posted: unknown[] = [];
    vi.spyOn(api, 'getState').mockReturnValue(savedState);
    vi.spyOn(api, 'postMessage').mockImplementation((m: unknown) => void posted.push(m));
    const Host = defineComponent({
      setup() {
        useMessageHandler({ messageContainerRef: ref(null), chatInputRef: ref(null) });
        return () => null;
      },
    });
    const wrapper = mount(Host, { global: { plugins: [i18n] } });
    unmounts.push(() => wrapper.unmount());
    return posted;
  }

  it('carries the persisted folder key so a restored panel returns to its folder', () => {
    const posted = mountHandler({ sessionId: 's-1', workspaceFolderKey: SERVER.key });

    expect(posted).toContainEqual({ type: 'ready', savedSessionId: 's-1', savedWorkspaceFolderKey: SERVER.key });
  });

  it('omits the key when nothing was persisted', () => {
    const posted = mountHandler(undefined);

    expect(posted).toContainEqual({ type: 'ready' });
  });
});
