// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { createSessionHandlers } from '../session-handlers';
import { createFakePlatform } from '../../../../../__mocks__/fake-platform';
import { TerminalAttachmentManager } from '../../../terminal-attachment-manager';
import { IdeContextManager } from '../../../ide-context-manager';
import type { ResumeOutcome } from '../../../../chat-session';
import type { ViewJoinGate } from '../../../types';
import type { ExtensionToWebviewMessage } from '../../../../../shared/types/messages';
import { HistoryManager } from '../../../history-manager';
import { pendingPromptOwners } from '../../../../pi-session/pending-prompts';
import { PermissionHandler } from '../../../../permission-handler';
import { TOOL_OUTPUT_COALESCE_MS } from '../../../../pi-session/tool-output-coalescer';
import { AT_GATE, BASH, cardsOf, chatPage, fakeSession, liveChatSession, makeAdapter, PROMPT, TURN, type ChatPage } from '../../../../pi-session/__tests__/live-chat-page';
vi.mock('../../../../pi-session/session-store', () => ({ renamePiSession: vi.fn(), deletePiSession: vi.fn(), tagPiSession: vi.fn() }));
vi.mock('../../../../pi-session/pi-runtime', () => ({ PiRuntime: { liveSessionMutator: () => undefined } }));
vi.mock('../../../../logger', () => ({ log: vi.fn() }));

// a panel's IDE context over an editor with no file open
const ideContext = (): IdeContextManager => new IdeContextManager(createFakePlatform().editor, () => undefined);

/**
 * The `ready` handler's dialog release, tested through the REAL handler.
 *
 * A webview restart (view recreation / "Developer: Reload Webviews") gives the webview a fresh, empty
 * dialog store while the extension side still holds live awaiters in `pending`. A nested agent's MCP
 * elicitation then blocks its `callTool`, which blocks the tool call, which blocks the agent run — with
 * no modal on screen to explain it and no later sweep to release it, because teardown only runs on a
 * completion path the run never reaches. One line in this handler is the whole fix, so it needs a test
 * that fails when the line is deleted.
 */
describe('ready handler — releases dialogs the restarted webview can no longer answer', () => {
  function harness() {
    const calls: string[] = [];
    const session = {
      onWebviewReady: () => calls.push('onWebviewReady'),
      getToolStatus: () => ({}),
      holdsLiveConversation: () => false,
      setResumeSession: () => undefined,
      openResumeTarget: async () => ({ kind: 'switched' as const }),
      initializeEarly: async () => undefined,
    };
    const deps = {
      platform: createFakePlatform(),
      postMessage: () => calls.push('postMessage'),
      postWorkspaceFolderState: () => undefined,
      folderRegistry: { resolve: () => undefined, targets: () => [] },
      worktrees: () => ({ interceptSend: () => false, resumeFolder: async (_panelId: string, _sessionId: string, folder: unknown) => ({ folder, settle: () => undefined }), viewOf: () => undefined }),
      getPanels: () => new Map(),
      storageManager: {
        getStoredSessions: async () => {
          calls.push('getStoredSessions');
          return { sessions: [], hasMore: false, nextOffset: 0 };
        },
        getPromptHistory: async () => ({ history: [], hasMore: false }),
      },
      settingsManager: {
        sendCurrentSettings: async () => calls.push('sendCurrentSettings'),
        sendAvailableModels: () => undefined,
        sendImageGenerationSettings: () => undefined,
        sendMcpConfig: () => undefined,
        sendModelForPanel: () => undefined,
        sendThinkingForPanel: () => undefined,
      },
      getLanguagePreference: () => 'en',
      webviewPrompts: { repost: () => undefined },
    } as unknown as Parameters<typeof createSessionHandlers>[0];

    const host = {};
    const ctx = { session, host, reply: host, panelId: 'p1', permissionHandler: {}, ideContextManager: ideContext(), terminalAttachments: new TerminalAttachmentManager(() => {}), folder: { key: '/ws', fsPath: '/ws' } } as never;
    return { calls, deps, ctx, session };
  }

  function waitingForPlace(overrides: (deps: Record<string, unknown>) => Record<string, unknown>) {
    const { deps, ctx } = harness();
    const published: unknown[] = [];
    const place = { phase: 'none', place: 'project', canHandOff: false };
    const live = ctx as unknown as { host: unknown; session: Record<string, unknown>; folder: object };
    Object.assign(live.session, { setPanelToken: () => undefined, holdsSession: () => false, worktree: { publishStored: (state: unknown) => published.push(state) } });
    const panels = new Map([['p1', { host: live.host, folder: live.folder, session: live.session }]]);
    const base = {
      ...deps,
      platform: createFakePlatform({ capabilities: { worktrees: true } }),
      getPanels: () => panels,
      worktrees: () => ({ interceptSend: () => false, viewOf: () => undefined, placeOf: () => place }),
    };
    return { deps: { ...base, ...overrides(base) } as unknown as Parameters<typeof createSessionHandlers>[0], ctx, published, place };
  }

  it('tells a webview waiting to restore where the panel works when the restore fails', async () => {
    const h = waitingForPlace((base) => ({ storageManager: { ...(base['storageManager'] as object), folderOf: async () => { throw new Error('unreadable'); } } }));
    await expect(createSessionHandlers(h.deps).ready!({ type: 'ready', savedSessionId: 'missing' } as never, h.ctx)).rejects.toThrow('unreadable');
    expect(h.published).toEqual([h.place]);
  });

  it('tells a webview waiting to restore where the panel works when posting the settings throws', async () => {
    const h = waitingForPlace((base) => ({ settingsManager: { ...(base['settingsManager'] as object), sendCurrentSettings: async () => { throw new Error('settings unreadable'); } } }));
    await expect(createSessionHandlers(h.deps).ready!({ type: 'ready', savedSessionId: 's1' } as never, h.ctx)).rejects.toThrow('settings unreadable');
    expect(h.published).toEqual([h.place]);
  });

  it('gives the stored file\'s place to the session\'s own publisher before the replay, never to the webview directly', async () => {
    const sent: Array<{ type: string }> = [];
    const order: string[] = [];
    const stored = { phase: 'ready', place: 'worktree', canHandOff: false };
    const h = waitingForPlace((base) => ({
      postMessage: (_host: unknown, m: { type: string }) => sent.push(m),
      historyManager: { loadSessionHistory: async () => { order.push('replay'); return []; } },
      storageManager: { ...(base['storageManager'] as object), folderOf: async () => (h.ctx as unknown as { folder: object }).folder },
      worktrees: () => ({ interceptSend: () => false, viewOf: () => undefined, placeOf: () => undefined, resumeFolder: async (_p: string, _s: string, folder: unknown) => ({ folder, state: stored, settle: () => order.push('settle') }) }),
    }));
    const publishStored = (h.ctx as unknown as { session: { worktree: { publishStored: (state: unknown) => void } } }).session.worktree;
    const original = publishStored.publishStored;
    publishStored.publishStored = (state) => { order.push('place'); original(state); };
    await createSessionHandlers(h.deps).ready!({ type: 'ready', savedSessionId: 'live-place' } as never, h.ctx);
    expect(h.published).toEqual([stored]);
    expect(order).toEqual(['place', 'replay', 'settle']);
    expect(sent.some((m) => m.type === 'worktreeState' || m.type === 'noWorktreeState')).toBe(false);
  });

  it('calls session.onWebviewReady()', async () => {
    const { calls, deps, ctx } = harness();
    await createSessionHandlers(deps).ready!({ type: 'ready' } as never, ctx);
    expect(calls).toContain('onWebviewReady');
  });

  it('releases them BEFORE pushing any state back, so nothing races the fresh store', async () => {
    // Ordering is the point, not just the call: a release that ran after the handler re-seeded the
    // webview could withdraw a dialog the extension had already re-posted into the new store.
    const { calls, deps, ctx } = harness();
    await createSessionHandlers(deps).ready!({ type: 'ready' } as never, ctx);
    expect(calls.indexOf('onWebviewReady')).toBe(0);
    expect(calls.length).toBeGreaterThan(1); // the handler really did go on to do its other work
  });

  it('re-posts the panel host prompts, then sends the host capabilities before any state', async () => {
    const { deps, ctx } = harness();
    const sent: Array<{ type: string }> = [];
    const reposted: string[] = [];
    const platform = createFakePlatform({ capabilities: { voice: false, settingsSources: true } });
    const recording = {
      ...deps,
      platform,
      postMessage: (_host: unknown, m: { type: string }) => sent.push(m),
      webviewPrompts: { repost: (panelId: string) => reposted.push(panelId) },
    } as unknown as Parameters<typeof createSessionHandlers>[0];
    await createSessionHandlers(recording).ready!({ type: 'ready' } as never, ctx);
    expect(reposted).toEqual(['p1']);
    expect(sent[0]).toStrictEqual({ type: 'hostCapabilities', capabilities: platform.capabilities });
    expect(platform.capabilities).toMatchObject({ voice: false, settingsSources: true, hostSettingsEditor: true });
    expect(sent.some((message) => message.type === 'terminalShown')).toBe(false);
  });

  it('tells a host with a window layout\'s chat whether the terminal pane shows, right after the capabilities', async () => {
    const { deps, ctx } = harness();
    const sent: Array<{ type: string }> = [];
    const platform = createFakePlatform({ capabilities: { windowLayout: true } });
    platform.window.toggleTerminal();
    const recording = { ...deps, platform, postMessage: (_host: unknown, m: { type: string }) => sent.push(m) } as unknown as Parameters<typeof createSessionHandlers>[0];
    await createSessionHandlers(recording).ready!({ type: 'ready' } as never, ctx);
    expect(sent[1]).toStrictEqual({ type: 'terminalShown', shown: true, shortcut: 'Ctrl+`' });
  });

  it('tells a daemon\'s chat view whether its own device shows the terminal pane, whatever another device shows', async () => {
    const { deps, ctx } = harness();
    const sent: Array<{ type: string }> = [];
    const platform = createFakePlatform({ capabilities: { windowLayout: true } });
    const toggles = new Map([['device-a', { shown: true, shortcut: 'Ctrl+`' }], ['device-b', { shown: false, shortcut: 'Ctrl+`' }]]);
    Object.assign(platform.window, { terminalToggle: (clientId?: string) => toggles.get(clientId!) });
    const recording = { ...deps, platform, postMessage: (_host: unknown, m: { type: string }) => sent.push(m) } as unknown as Parameters<typeof createSessionHandlers>[0];
    await createSessionHandlers(recording).ready!({ type: 'ready' } as never, { ...(ctx as object), reply: { clientId: 'device-b' } } as never);
    expect(sent[1]).toStrictEqual({ type: 'terminalShown', shown: false, shortcut: 'Ctrl+`' });
  });

  // A page that loads again, or a device's first view of a chat, was never told the editor context the chat holds for it.
  it('tells the replying view its own device\'s editor context, whatever another device has open', async () => {
    const { deps, ctx } = harness();
    const sent: Array<{ type: string; context?: unknown }> = [];
    const platform = createFakePlatform();
    const open = new Map([['device-a', { filePath: '/ws/a.ts', selection: undefined }], ['device-b', { filePath: '/ws/b.ts', selection: undefined }]]);
    // a daemon's core: each device's editor, none with no device named
    Object.assign(platform.editor, { getActiveContext: (clientId?: string) => (clientId === undefined ? { filePath: undefined, selection: undefined } : open.get(clientId)) });
    const recording = { ...deps, platform, postMessage: (_host: unknown, m: { type: string }) => sent.push(m) } as unknown as Parameters<typeof createSessionHandlers>[0];
    const ideContextManager = new IdeContextManager(platform.editor, () => undefined);

    await createSessionHandlers(recording).ready!({ type: 'ready' } as never, { ...(ctx as object), ideContextManager, reply: { clientId: 'device-b' } } as never);

    expect(sent.filter((message) => message.type === 'ideContextUpdate')).toEqual([{ type: 'ideContextUpdate', context: { type: 'opened_file', filePath: '/ws/b.ts', fileName: 'b.ts' } }]);
  });

  it('gives a restarted webview the composer\'s pending terminal attachments, and posts none when there are none', async () => {
    const { deps, ctx } = harness();
    const sent: Array<{ type: string; attachments?: unknown[] }> = [];
    const recording = { ...deps, postMessage: (_host: unknown, m: { type: string }) => sent.push(m) } as unknown as Parameters<typeof createSessionHandlers>[0];
    await createSessionHandlers(recording).ready!({ type: 'ready' } as never, ctx);
    expect(sent.some((message) => message.type === 'terminalAttachmentsUpdate')).toBe(false);
    (ctx as { terminalAttachments: TerminalAttachmentManager }).terminalAttachments.add({ kind: 'terminal', source: 'selection', commandLine: null, exitCode: null, terminalTitle: 'bash', text: 'ok', omittedLines: 0 });
    await createSessionHandlers(recording).ready!({ type: 'ready' } as never, ctx);
    expect(sent.filter((message) => message.type === 'terminalAttachmentsUpdate').map((message) => message.attachments?.length)).toEqual([1]);
  });
});

/**
 * A reloaded panel gets back to the folder it was on. The serializer already created the session in
 * the persisted folder; `ready` is where the sidebar view (no serializer) and a conversation whose
 * session lives in another folder reconcile.
 */
describe('ready handler: restores the panel into the right folder', () => {
  const folder = (fsPath: string) => ({ key: fsPath, fsPath, name: fsPath, label: fsPath, projectScope: true });
  const A = folder('/a');
  const B = folder('/b');

  function makeSession(order: string[]) {
    return {
      onWebviewReady: vi.fn(),
      getToolStatus: () => ({}),
      holdsLiveConversation: () => false,
      holdsSession: () => false,
      setPanelToken: vi.fn(),
      setResumeSession: vi.fn(),
      openResumeTarget: vi.fn(async (): Promise<ResumeOutcome> => { order.push('open'); return { kind: 'switched' }; }),
      letGoOfUnreadTarget: vi.fn((_sessionId: string) => false),
      initializeEarly: vi.fn(async () => { order.push('start'); }),
    };
  }

  function harness(opts: { sessionFolder?: typeof A; heldElsewhere?: string; compassFolders?: string[] } = {}) {
    const order: string[] = [];
    const posted: Array<{ type: string; status?: unknown }> = [];
    const compassRegistry = {
      get: (key: string) => opts.compassFolders?.includes(key) ? { isEnabled: true, getStatus: () => ({ state: 'ready', folder: key }) } : undefined,
    };
    const session = makeSession(order);
    const host = { id: 'host' };
    const instance: { host: unknown; session: ReturnType<typeof makeSession>; folder: typeof A } = { host, session, folder: A };
    const switchPanelFolder = vi.fn(async (_panelId: string, key: string, _reason: string, afterSwitch?: (i: unknown) => Promise<void>) => {
      instance.session = makeSession(order);
      instance.folder = key === B.key ? B : A;
      await afterSwitch?.(instance);
      order.push('gate-open');
      return instance;
    });
    const loadSessionHistory = vi.fn(async (..._args: unknown[]): Promise<string[] | null> => { order.push('load'); return []; });
    const postWorkspaceFolderState = vi.fn();
    const deps = {
      platform: createFakePlatform(),
      postMessage: (_host: unknown, m: { type: string; status?: unknown }) => { posted.push(m); },
      postWorkspaceFolderState,
      switchPanelFolder,
      compassRegistry,
      folderRegistry: { resolve: (key: string) => [A, B].find((f) => f.key === key), targets: () => [A, B] },
      worktrees: () => ({ interceptSend: () => false, resumeFolder: async (_panelId: string, _sessionId: string, folder: unknown) => ({ folder, settle: () => undefined }), viewOf: () => undefined }),
      getPanels: () => new Map<string, unknown>([
        ['p1', instance],
        ...(opts.heldElsewhere ? [['p2', { host: { id: 'other' }, session: { holdsSession: (id: string) => id === opts.heldElsewhere } }] as const] : []),
      ]),
      historyManager: { loadSessionHistory },
      storageManager: {
        getStoredSessions: async () => { order.push('list'); return { sessions: [], hasMore: false, nextOffset: 0 }; },
        getPromptHistory: async () => { order.push('history'); return { history: [], hasMore: false }; },
        folderOf: vi.fn(async () => opts.sessionFolder),
      },
      settingsManager: {
        sendCurrentSettings: async () => undefined,
        sendAvailableModels: () => undefined,
        sendImageGenerationSettings: () => undefined,
        sendMcpConfig: () => undefined,
        sendModelForPanel: () => undefined,
        sendThinkingForPanel: () => undefined,
      },
      getLanguagePreference: () => 'en',
      webviewPrompts: { repost: () => undefined },
    } as unknown as Parameters<typeof createSessionHandlers>[0];
    const ctx = { session, host, reply: host, panelId: 'p1', permissionHandler: {}, ideContextManager: ideContext(), terminalAttachments: new TerminalAttachmentManager(() => {}), folder: A } as never;
    const compassPosts = () => posted.filter((m) => m.type === 'compassStatusUpdate');
    return { deps, ctx, session, instance, switchPanelFolder, loadSessionHistory, postWorkspaceFolderState, order, compassPosts, posted };
  }

  // The session tells the user why it could not open one, so the handler adds no notice of its own.
  it.each([
    ['could not open', { kind: 'failed', reason: { message: 'its file was not found' } }],
    ['let go of first', { kind: 'cancelled' }],
  ] as const)('shows none of a saved conversation that pi, holding another one, %s, and starts a new conversation in its place', async (_what, outcome) => {
    const h = harness();
    h.session.openResumeTarget.mockImplementationOnce(async () => { h.order.push('open'); return outcome; });
    await createSessionHandlers(h.deps).ready!({ type: 'ready', savedSessionId: 's-a' } as never, h.ctx);

    expect(h.order).toEqual(['open', 'list', 'history', 'start']);
    expect(h.loadSessionHistory).not.toHaveBeenCalled();
    expect(h.posted.some((m) => m.type === 'sessionStarted')).toBe(false);
    expect((h.deps.platform as ReturnType<typeof createFakePlatform>).notifications.calls).toEqual([]);
  });

  it("replays a saved conversation a panel that has not started opens in its start, which runs after the lists", async () => {
    const h = harness();
    h.session.openResumeTarget.mockImplementationOnce(async () => { h.order.push('open'); return { kind: 'deferred' }; });
    await createSessionHandlers(h.deps).ready!({ type: 'ready', savedSessionId: 's-a' } as never, h.ctx);

    expect(h.order).toEqual(['open', 'load', 'list', 'history', 'start']);
    expect(h.posted.filter((m) => m.type === 'sessionStarted')).toEqual([{ type: 'sessionStarted', sessionId: 's-a', stored: true }]);
  });

  // The webview would otherwise name a conversation no start can open, and every send would be refused.
  it("lets go of a saved conversation whose file the replay could not read, names it to no webview, and starts a new one", async () => {
    const h = harness();
    h.session.openResumeTarget.mockImplementationOnce(async () => { h.order.push('open'); return { kind: 'deferred' }; });
    h.loadSessionHistory.mockImplementationOnce(async () => { h.order.push('load'); return null; });
    h.session.letGoOfUnreadTarget.mockReturnValueOnce(true);
    await createSessionHandlers(h.deps).ready!({ type: 'ready', savedSessionId: 's-a' } as never, h.ctx);

    expect(h.session.letGoOfUnreadTarget).toHaveBeenCalledWith('s-a');
    expect(h.order).toEqual(['open', 'load', 'list', 'history', 'start']);
    expect(h.posted.some((m) => m.type === 'sessionStarted')).toBe(false);
  });

  it('tells the webview its folder state', async () => {
    const h = harness();
    await createSessionHandlers(h.deps).ready!({ type: 'ready' } as never, h.ctx);
    expect(h.postWorkspaceFolderState).toHaveBeenCalledWith('p1');
  });

  // Every status the index emitted before the webview loaded was posted to a page with no listener.
  it("sends the panel's folder Compass status, which the fresh webview never received", async () => {
    const h = harness({ compassFolders: [A.key, B.key] });
    await createSessionHandlers(h.deps).ready!({ type: 'ready' } as never, h.ctx);
    expect(h.compassPosts()).toEqual([{ type: 'compassStatusUpdate', status: { state: 'ready', folder: A.key } }]);
  });

  it('sends no Compass status for a folder whose Compass is off', async () => {
    const h = harness();
    await createSessionHandlers(h.deps).ready!({ type: 'ready' } as never, h.ctx);
    expect(h.compassPosts()).toEqual([]);
  });

  it("leaves a restore into another folder to post that folder's Compass status", async () => {
    const h = harness({ compassFolders: [A.key, B.key] });
    await createSessionHandlers(h.deps).ready!({ type: 'ready', savedWorkspaceFolderKey: B.key } as never, h.ctx);
    expect(h.switchPanelFolder).toHaveBeenCalled();
    expect(h.compassPosts()).toEqual([]);
  });

  it("moves to the folder holding the saved conversation, then resumes it on the new session", async () => {
    const h = harness({ sessionFolder: B });
    await createSessionHandlers(h.deps).ready!({ type: 'ready', savedSessionId: 's-b', savedWorkspaceFolderKey: A.key } as never, h.ctx);

    expect(h.switchPanelFolder).toHaveBeenCalledWith('p1', B.key, 'restore', expect.any(Function));
    // Opened and replayed inside the switch, before queued webview messages are let through; pi opens it before the replay.
    expect(h.order).toEqual(['open', 'load', 'gate-open', 'list', 'history', 'start']);
    expect(h.instance.session).not.toBe(h.session);
    expect(h.instance.session.setResumeSession).toHaveBeenCalledWith('s-b');
    expect(h.session.setResumeSession).not.toHaveBeenCalled();
    expect(h.loadSessionHistory).toHaveBeenCalledWith('/b', 's-b', h.instance.host, h.instance.session);
    expect(h.instance.session.initializeEarly).toHaveBeenCalledTimes(1);
  });

  it('moves to the persisted folder when there is no saved conversation', async () => {
    const h = harness();
    await createSessionHandlers(h.deps).ready!({ type: 'ready', savedWorkspaceFolderKey: B.key } as never, h.ctx);

    expect(h.switchPanelFolder).toHaveBeenCalledWith('p1', B.key, 'restore', expect.any(Function));
    // The new session starts after the lists; the one it replaced is never started.
    expect(h.order).toEqual(['gate-open', 'list', 'history', 'start']);
    expect(h.session.initializeEarly).not.toHaveBeenCalled();
  });

  it('stays put and starts early when the persisted key is not an open folder', async () => {
    const h = harness();
    await createSessionHandlers(h.deps).ready!({ type: 'ready', savedWorkspaceFolderKey: '/not-open' } as never, h.ctx);

    expect(h.switchPanelFolder).not.toHaveBeenCalled();
    expect(h.session.initializeEarly).toHaveBeenCalledTimes(1);
  });

  it('stays put when already on the persisted folder', async () => {
    const h = harness();
    await createSessionHandlers(h.deps).ready!({ type: 'ready', savedWorkspaceFolderKey: A.key } as never, h.ctx);

    expect(h.switchPanelFolder).not.toHaveBeenCalled();
    expect(h.session.initializeEarly).toHaveBeenCalledTimes(1);
  });

  it('resumes in place when the saved conversation is in no open folder', async () => {
    const h = harness();
    await createSessionHandlers(h.deps).ready!({ type: 'ready', savedSessionId: 's-a' } as never, h.ctx);

    expect(h.switchPanelFolder).not.toHaveBeenCalled();
    expect(h.session.setResumeSession).toHaveBeenCalledWith('s-a');
    expect(h.loadSessionHistory).toHaveBeenCalledWith('/a', 's-a', h.instance.host, h.session);
  });

  it('neither moves nor resumes when another panel already holds the saved conversation', async () => {
    const h = harness({ sessionFolder: B, heldElsewhere: 's-b' });
    await createSessionHandlers(h.deps).ready!({ type: 'ready', savedSessionId: 's-b' } as never, h.ctx);

    expect(h.switchPanelFolder).not.toHaveBeenCalled();
    expect((h.deps.storageManager as unknown as { folderOf: ReturnType<typeof vi.fn> }).folderOf).not.toHaveBeenCalled();
    expect(h.loadSessionHistory).not.toHaveBeenCalled();
    expect(h.session.initializeEarly).toHaveBeenCalledTimes(1);
  });
});

describe('ready handler: paints the conversation before the session-wide lists', () => {
  function harness() {
    const order: string[] = [];
    const session = {
      onWebviewReady: () => undefined,
      getToolStatus: () => ({}),
      holdsLiveConversation: () => false,
      holdsSession: () => false,
      setPanelToken: () => undefined,
      setResumeSession: () => undefined,
      openResumeTarget: async () => { order.push('openResumeTarget'); return { kind: 'switched' as const }; },
      initializeEarly: async () => { order.push('initializeEarly'); },
    };
    const host = { id: 'host' };
    const folder = { key: '/a', fsPath: '/a' };
    const panel: { host: unknown; session: unknown; folder: unknown } = { host, session, folder };
    const deps = {
      platform: createFakePlatform(),
      postMessage: (_host: unknown, m: { type: string }) => { if (m.type === 'sessionStarted') order.push('sessionStarted'); },
      postWorkspaceFolderState: () => undefined,
      folderRegistry: { resolve: () => undefined, targets: () => [] },
      worktrees: () => ({ interceptSend: () => false, resumeFolder: async (_panelId: string, _sessionId: string, folder: unknown) => ({ folder, settle: () => undefined }), viewOf: () => undefined }),
      getPanels: () => new Map([['p1', panel]]),
      historyManager: { loadSessionHistory: async () => { order.push('loadSessionHistory'); } },
      storageManager: {
        getStoredSessions: async () => { order.push('getStoredSessions'); return { sessions: [], hasMore: false, nextOffset: 0 }; },
        getPromptHistory: async () => { order.push('getPromptHistory'); return { history: [], hasMore: false }; },
        folderOf: async () => undefined,
      },
      settingsManager: {
        sendCurrentSettings: async () => { order.push('sendCurrentSettings'); },
        sendAvailableModels: (session: { name?: string }) => { order.push(`sendAvailableModels:${session.name ?? 'own'}`); },
        sendImageGenerationSettings: () => undefined,
        sendMcpConfig: () => undefined,
        sendModelForPanel: () => undefined,
        sendThinkingForPanel: () => undefined,
      },
      getLanguagePreference: () => 'en',
      webviewPrompts: { repost: () => undefined },
    } as unknown as Parameters<typeof createSessionHandlers>[0];
    const ctx = { session, host, reply: host, panelId: 'p1', permissionHandler: {}, ideContextManager: ideContext(), terminalAttachments: new TerminalAttachmentManager(() => {}), folder } as never;
    return { deps, ctx, order, panel };
  }

  const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

  it('opens a restored conversation in pi, replays it before listing sessions or prompt history, then asks for models', async () => {
    const h = harness();
    await createSessionHandlers(h.deps).ready!({ type: 'ready', savedSessionId: 's-a' } as never, h.ctx);
    await settle();
    expect(h.order).toEqual(['sendCurrentSettings', 'openResumeTarget', 'loadSessionHistory', 'sessionStarted', 'getStoredSessions', 'getPromptHistory', 'initializeEarly', 'sendAvailableModels:own']);
  });

  it('asks the session the panel holds by then for models', async () => {
    const h = harness();
    const deps = h.deps as unknown as { storageManager: { getPromptHistory: () => Promise<unknown> } };
    deps.storageManager.getPromptHistory = async () => {
      h.panel.session = { name: 'replacement', initializeEarly: async () => { h.order.push('initializeEarly:replacement'); } };
      return { history: [], hasMore: false };
    };
    await createSessionHandlers(h.deps).ready!({ type: 'ready', savedSessionId: 's-a' } as never, h.ctx);
    await settle();
    expect(h.order.slice(-2)).toEqual(['initializeEarly:replacement', 'sendAvailableModels:replacement']);
  });

  it('posts both lists before starting a fresh panel', async () => {
    const h = harness();
    await createSessionHandlers(h.deps).ready!({ type: 'ready' } as never, h.ctx);
    await settle();
    expect(h.order).toEqual(['sendCurrentSettings', 'getStoredSessions', 'getPromptHistory', 'initializeEarly', 'sendAvailableModels:own']);
  });

  it('logs a failure to post the models instead of leaving the rejection unhandled', async () => {
    const h = harness();
    const deps = h.deps as unknown as { settingsManager: { sendAvailableModels: () => Promise<void> } };
    deps.settingsManager.sendAvailableModels = async () => { throw new Error('no runtime'); };
    const { log } = await import('../../../../logger');
    vi.mocked(log).mockClear();
    await createSessionHandlers(h.deps).ready!({ type: 'ready' } as never, h.ctx);
    await settle();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('posting the models'), expect.any(Error));
  });
});

/**
 * pi writes a conversation's file with its first prompt, so the webview persists a conversation's id for restore only once the
 * host says it is stored. A reload of a panel whose runtime holds a conversation pi has not written yet sends no saved id and
 * takes the live replay, which names that conversation; a panel that has not started names the target its start opens.
 */
describe('ready handler: a conversation pi has not written yet', () => {
  function harness(session: { currentSessionId: string | null; hasSessionFile: () => boolean; started: boolean }, loaded: string[] | null = []) {
    const posted: Array<{ type: string } & Record<string, unknown>> = [];
    const pi = fakeSession();
    const panelSession = {
      ...session,
      onWebviewReady: () => undefined,
      getToolStatus: () => ({}),
      // as PiSession's: a runtime holds the conversation a page that names none shows
      holdsLiveConversation: (id: string | undefined) => session.started && id === undefined,
      holdsSession: () => false,
      setPanelToken: vi.fn(),
      setResumeSession: vi.fn(),
      openResumeTarget: async () => ({ kind: 'switched' as const }),
      // pi holds the conversation it switched to, so the session keeps it whatever the replay read.
      letGoOfUnreadTarget: () => false,
      initializeEarly: async () => undefined,
      whenConversationSettled: async () => undefined,
      liveConversation: () => (session.started && session.currentSessionId !== null
        ? { sessionId: session.currentSessionId, stored: session.hasSessionFile(), branch: [], sessionManager: pi.sessionManager, snapshot: makeAdapter([]).liveSnapshot() }
        : undefined),
      eventSeq: 0,
      eventSeqOf: () => undefined,
      storedSessionId: null,
      fileCheckpoints: false,
      publishAccountInfo: () => undefined,
      replayLiveAgents: () => undefined,
    };
    const host = { id: 'host' };
    const folder = { key: '/a', fsPath: '/a' };
    const historyManager = new HistoryManager({ postMessage: (_host, m) => posted.push(m as { type: string } & Record<string, unknown>), maxCheckpointFileSizeBytes: () => 0 });
    const loadSessionHistory = vi.spyOn(historyManager, 'loadSessionHistory').mockImplementation(async () => loaded);
    const deps = {
      platform: createFakePlatform(),
      postMessage: (_host: unknown, m: { type: string } & Record<string, unknown>) => { posted.push(m); },
      postWorkspaceFolderState: () => undefined,
      folderRegistry: { resolve: () => undefined, targets: () => [] },
      worktrees: () => ({ interceptSend: () => false, resumeFolder: async (_panelId: string, _sessionId: string, folder: unknown) => ({ folder, settle: () => undefined }), viewOf: () => undefined }),
      getPanels: () => new Map([['p1', { host, session: panelSession, folder }]]),
      historyManager,
      storageManager: {
        getStoredSessions: async () => ({ sessions: [], hasMore: false, nextOffset: 0 }),
        getPromptHistory: async () => ({ history: [], hasMore: false }),
        folderOf: async () => undefined,
      },
      settingsManager: {
        sendCurrentSettings: async () => undefined,
        sendAvailableModels: () => undefined,
        sendImageGenerationSettings: () => undefined,
        sendMcpConfig: () => undefined,
        sendModelForPanel: () => undefined,
        sendThinkingForPanel: () => undefined,
      },
      getLanguagePreference: () => 'en',
      webviewPrompts: { repost: () => undefined },
      // the panel's one view takes the replay
      withViewGate: async (_host: unknown, _joining: string | undefined, run: (gate: ViewJoinGate) => Promise<void>) =>
        run({ post: (m) => posted.push(m as { type: string } & Record<string, unknown>), hold: () => undefined, release: () => undefined }),
    } as unknown as Parameters<typeof createSessionHandlers>[0];
    const ctx = { session: panelSession, host, reply: host, panelId: 'p1', permissionHandler: {}, ideContextManager: ideContext(), terminalAttachments: new TerminalAttachmentManager(() => {}), folder } as never;
    const started = () => posted.filter((m) => m.type === 'sessionStarted');
    return { deps, ctx, posted, started, loadSessionHistory, panelSession };
  }

  it('a reloaded page with no saved id takes the live replay of the conversation the runtime holds, unstored, with no file replay and no claim', async () => {
    const h = harness({ currentSessionId: 'fresh-1', hasSessionFile: () => false, started: true });
    await createSessionHandlers(h.deps).ready!({ type: 'ready' } as never, h.ctx);

    expect(h.posted.filter((m) => m.type === 'sessionCleared' || m.type === 'sessionStarted')).toEqual([
      { type: 'sessionCleared', sessionId: 'fresh-1' },
      { type: 'sessionStarted', sessionId: 'fresh-1', stored: false },
    ]);
    expect(h.loadSessionHistory).not.toHaveBeenCalled();
    expect(h.panelSession.setResumeSession).not.toHaveBeenCalled();
    expect(h.posted.some((m) => m.type === 'errorReplay')).toBe(false);
  });

  it('names a live conversation that has its file stored, so the page persists it again', async () => {
    const h = harness({ currentSessionId: 'live-1', hasSessionFile: () => true, started: true });
    await createSessionHandlers(h.deps).ready!({ type: 'ready' } as never, h.ctx);

    expect(h.started()).toEqual([{ type: 'sessionStarted', sessionId: 'live-1', stored: true }]);
  });

  it('a panel that has not started names the target its start opens, unstored', async () => {
    const h = harness({ currentSessionId: 'fork-1', hasSessionFile: () => false, started: false });
    await createSessionHandlers(h.deps).ready!({ type: 'ready' } as never, h.ctx);

    expect(h.started()).toEqual([{ type: 'sessionStarted', sessionId: 'fork-1', stored: false }]);
    expect(h.loadSessionHistory).not.toHaveBeenCalled();
  });

  it('announces nothing for a panel whose session has not started and has no target; its start announces it', async () => {
    const h = harness({ currentSessionId: null, hasSessionFile: () => false, started: false });
    await createSessionHandlers(h.deps).ready!({ type: 'ready' } as never, h.ctx);

    expect(h.started()).toEqual([]);
  });

  it('marks a restored conversation stored only when its file was read', async () => {
    const read = harness({ currentSessionId: null, hasSessionFile: () => false, started: false }, ['u1']);
    await createSessionHandlers(read.deps).ready!({ type: 'ready', savedSessionId: 's-a' } as never, read.ctx);
    expect(read.started()).toEqual([{ type: 'sessionStarted', sessionId: 's-a', stored: true }]);

    const missing = harness({ currentSessionId: null, hasSessionFile: () => false, started: false }, null);
    await createSessionHandlers(missing.deps).ready!({ type: 'ready', savedSessionId: 's-gone' } as never, missing.ctx);
    // Unstored, so the page drops the id and the next restart opens a fresh conversation instead of repeating the notice.
    expect(missing.started()).toEqual([{ type: 'sessionStarted', sessionId: 's-gone', stored: false }]);
  });
});

/**
 * A page that loads again while the panel's runtime holds the conversation it names (a renderer crash, a webview reload): the
 * file holds none of the running turn, so the page gets the live replay views.join gives, through the panel's view gate.
 */
describe('ready handler: a page that loads again while the runtime holds its conversation', () => {
  function harness(heldId: string) {
    const order: string[] = [];
    const posted: Array<{ type: string }> = [];
    const session = {
      holdsLiveConversation: (id: string | undefined) => id === undefined || id === heldId,
      holdsSession: (id: string) => id === heldId,
      onWebviewReady: vi.fn(() => order.push('onWebviewReady')),
      getToolStatus: () => ({}),
      setPanelToken: vi.fn(),
      setResumeSession: vi.fn(),
      openResumeTarget: vi.fn(async (): Promise<ResumeOutcome> => ({ kind: 'switched' })),
      letGoOfUnreadTarget: vi.fn(() => false),
      initializeEarly: vi.fn(async () => undefined),
      whenConversationSettled: vi.fn(async () => undefined),
      liveConversation: () => ({ sessionId: heldId, stored: true, branch: [], sessionManager: {}, snapshot: { seq: 3, messages: [], liveToolCallIds: new Set(), liveFailedCalls: new Set() } }),
      eventSeq: 3,
      storedSessionId: heldId as string | null,
      replayLiveAgents: vi.fn(),
    };
    const host = { id: 'host' };
    const folder = { key: '/a', fsPath: '/a' };
    const gated: unknown[] = [];
    const deps = {
      platform: createFakePlatform(),
      postMessage: (_host: unknown, m: { type: string }) => posted.push(m),
      postWorkspaceFolderState: () => undefined,
      switchPanelFolder: vi.fn(),
      folderRegistry: { resolve: () => undefined, targets: () => [] },
      worktrees: () => ({ interceptSend: () => false, resumeFolder: async (_panelId: string, _sessionId: string, f: unknown) => ({ folder: f, settle: () => undefined }), viewOf: () => undefined }),
      getPanels: () => new Map([['p1', { host, session, folder }]]),
      historyManager: {
        loadSessionHistory: vi.fn(async () => { order.push('file replay'); return []; }),
        liveReplayContext: async () => ({ reasons: undefined, isContextOverflow: undefined }),
        replayReaching: () => undefined,
        replayLive: vi.fn(async (_context: unknown, _cwd: string, _session: unknown, _host: unknown, post: (m: { type: string }) => void) => {
          order.push('live replay');
          post({ type: 'sessionStarted' });
        }),
      },
      storageManager: {
        getStoredSessions: async () => ({ sessions: [], hasMore: false, nextOffset: 0 }),
        getPromptHistory: async () => ({ history: [], hasMore: false }),
        folderOf: vi.fn(async () => undefined),
      },
      settingsManager: {
        sendCurrentSettings: async () => undefined,
        sendAvailableModels: () => undefined,
        sendImageGenerationSettings: () => undefined,
        sendMcpConfig: () => undefined,
        sendModelForPanel: () => undefined,
        sendThinkingForPanel: () => undefined,
      },
      getLanguagePreference: () => 'en',
      webviewPrompts: { repost: vi.fn(() => order.push('repost')) },
      withViewGate: vi.fn(async (_host: unknown, _joining: string | undefined, run: (gate: ViewJoinGate) => Promise<void>) => {
        order.push('gate');
        await run({ post: (m) => gated.push(m), hold: () => order.push('hold'), release: () => order.push('release') });
      }),
    };
    const ctx = { session, host, reply: host, viewKey: 'view-1', panelId: 'p1', permissionHandler: {}, ideContextManager: ideContext(), terminalAttachments: new TerminalAttachmentManager(() => {}), folder } as never;
    return { deps, typedDeps: deps as unknown as Parameters<typeof createSessionHandlers>[0], ctx, session, host, order, posted, gated };
  }

  it('ready of a panel whose runtime holds the named conversation claims nothing and posts no file replay', async () => {
    const h = harness('s-live');
    await createSessionHandlers(h.typedDeps).ready!({ type: 'ready', savedSessionId: 's-live' } as never, h.ctx);

    expect(h.session.setResumeSession).not.toHaveBeenCalled();
    expect(h.session.openResumeTarget).not.toHaveBeenCalled();
    expect(h.deps.storageManager.folderOf).not.toHaveBeenCalled();
    expect(h.deps.switchPanelFolder).not.toHaveBeenCalled();
    expect(h.deps.historyManager.loadSessionHistory).not.toHaveBeenCalled();
    expect(h.deps.withViewGate).toHaveBeenCalledWith(h.host, 'view-1', expect.any(Function));
    // the prompts and state go out after the replay, so a reposted prompt marks its replayed card
    expect(h.order).toEqual(['gate', 'hold', 'live replay', 'release', 'onWebviewReady', 'repost']);
    expect(h.gated).toEqual([{ type: 'sessionStarted' }]);
    expect(h.posted.some((m) => m.type === 'sessionCleared' || m.type === 'sessionStarted')).toBe(false);
  });

  // the runtime went (a replacement that failed after pi's teardown) between ready's check and the capture, and no stored conversation is left
  it('a live replay that finds no conversation clears the page unnamed, so its sends no longer name the one it saved', async () => {
    const h = harness('s-live');
    Object.assign(h.session, { liveConversation: () => undefined, storedSessionId: null });
    await createSessionHandlers(h.typedDeps).ready!({ type: 'ready', savedSessionId: 's-live' } as never, h.ctx);

    expect(h.gated).toEqual([{ type: 'sessionCleared' }]);
    expect(h.deps.historyManager.replayLive).not.toHaveBeenCalled();
    expect(h.deps.historyManager.loadSessionHistory).not.toHaveBeenCalled();
    const page = chatPage();
    page.stores.sessionStore.setResumedSession('s-live');
    page.deliver(h.gated as ExtensionToWebviewMessage[]);
    expect(page.stores.sessionStore.sendTargetSessionId).toBeNull();
    expect(h.order).toEqual(['gate', 'hold', 'release', 'onWebviewReady', 'repost']);
  });

  it('ready naming another conversation still restores it', async () => {
    const h = harness('s-live');
    await createSessionHandlers(h.typedDeps).ready!({ type: 'ready', savedSessionId: 's-other' } as never, h.ctx);

    expect(h.deps.withViewGate).not.toHaveBeenCalled();
    expect(h.deps.historyManager.replayLive).not.toHaveBeenCalled();
    expect(h.session.setResumeSession).toHaveBeenCalledWith('s-other');
    expect(h.session.openResumeTarget).toHaveBeenCalledWith('s-other');
    expect(h.order).toEqual(['onWebviewReady', 'repost', 'file replay']);
    expect(h.posted.filter((m) => m.type === 'sessionStarted')).toEqual([{ type: 'sessionStarted', sessionId: 's-other', stored: true }]);
  });
});

/** The reloaded page's own stores, fed what core posts it, against a page that watched the turn from its start. */
describe('ready handler: a reload mid-turn, through the real chat page stores', () => {
  // setImmediate stays real for the handler's awaits
  beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] }));
  afterEach(() => vi.useRealTimers());

  function reloadingChat(options: { worktrees?: boolean; onWebviewReady?: () => void; worktree?: unknown; modelReasons?: () => Promise<undefined>; repost?: (panelId: string) => void } = {}) {
    // every post of the panel reaches the page that watched the turn, and once it loaded again the reloaded page too, each when sent
    const stream: ExtensionToWebviewMessage[] = [];
    const watcher = chatPage();
    let reloaded: { page: ChatPage; received: ExtensionToWebviewMessage[] } | undefined;
    // what answers the reloaded page alone (its state, its replay)
    const reply = (message: ExtensionToWebviewMessage): void => {
      reloaded?.received.push(message);
      reloaded?.page.deliver([message]);
    };
    const panelPost = (message: ExtensionToWebviewMessage): void => {
      stream.push(message);
      watcher.deliver([message]);
      reply(message);
    };
    const session = liveChatSession(panelPost, { ...(options.onWebviewReady ? { onWebviewReady: options.onWebviewReady } : {}), ...(options.worktree ? { worktree: options.worktree } : {}) });
    const host = { id: 'host' };
    const folder = { key: '/a', fsPath: '/a' };
    const deps = {
      platform: createFakePlatform({ capabilities: { worktrees: options.worktrees ?? false } }),
      postMessage: (_host: unknown, m: ExtensionToWebviewMessage) => reply(m),
      postWorkspaceFolderState: () => undefined,
      folderRegistry: { resolve: () => undefined, targets: () => [] },
      worktrees: () => ({ interceptSend: () => false, viewOf: () => undefined, placeOf: () => ({ phase: 'none', place: 'project', canHandOff: false }) }),
      getPanels: () => new Map([['p1', { host, session, folder }]]),
      historyManager: new HistoryManager({ postMessage: (_host, m) => reply(m), maxCheckpointFileSizeBytes: () => 0, ...(options.modelReasons ? { modelReasons: options.modelReasons } : {}) }),
      storageManager: {
        getStoredSessions: async () => ({ sessions: [], hasMore: false, nextOffset: 0 }),
        getPromptHistory: async () => ({ history: [], hasMore: false }),
        folderOf: async () => undefined,
      },
      settingsManager: {
        sendCurrentSettings: async () => undefined,
        sendAvailableModels: () => undefined,
        sendImageGenerationSettings: () => undefined,
        sendMcpConfig: () => undefined,
        sendModelForPanel: () => undefined,
        sendThinkingForPanel: () => undefined,
      },
      getLanguagePreference: () => 'en',
      webviewPrompts: { repost: options.repost ?? (() => undefined) },
      // nothing streams during the replay here, so the gate only delivers
      withViewGate: async (_host: unknown, _joining: string | undefined, run: (gate: ViewJoinGate) => Promise<void>) => run({ post: reply, hold: () => undefined, release: () => undefined }),
    } as unknown as Parameters<typeof createSessionHandlers>[0];
    const ctx = { session, host, reply: host, panelId: 'p1', permissionHandler: {}, ideContextManager: ideContext(), terminalAttachments: new TerminalAttachmentManager(() => {}), folder } as never;
    const play = (events: readonly unknown[]): void => {
      for (const event of events) {
        session.pi.emit(event);
        vi.advanceTimersByTime(TOOL_OUTPUT_COALESCE_MS);
      }
    };
    /** `page` loads again and sends `ready`; it takes each later post as sent, and `received` lists them. */
    const reload = async (page: ChatPage = chatPage()): Promise<{ page: ChatPage; received: ExtensionToWebviewMessage[] }> => {
      reloaded = { page, received: [] };
      await createSessionHandlers(deps).ready!({ type: 'ready', savedSessionId: 'SID' } as never, ctx);
      return reloaded;
    };
    return { session, stream, watcher, panelPost, play, reload, received: () => reloaded?.received ?? [] };
  }

  it('a reload whose live replay fails still reposts the pending prompt and the session state to the page', async () => {
    const permissionHandler = new PermissionHandler(createFakePlatform());
    permissionHandler.setCwd(process.cwd());
    const reposted: string[] = [];
    const chat = reloadingChat({
      // as PiSession's: the prompts again, then the state, published again whatever it last published
      onWebviewReady: () => {
        permissionHandler.repostPendingPrompts();
        chat.panelPost({ type: 'sessionStateChanged', state: 'requires_action', sessionId: 'SID', pendingPrompts: pendingPromptOwners(permissionHandler.pendingPrompts()) });
      },
      // the model registry the replay's context reads failed to load
      modelReasons: () => Promise.reject(new Error('the model registry did not load')),
      repost: (panelId) => reposted.push(panelId),
    });
    permissionHandler.setPostMessage(chat.panelPost);
    chat.session.adapter.beginTurn('c', { message: PROMPT, text: null });
    chat.play(TURN.slice(0, AT_GATE));
    const approval = permissionHandler.canUseTool('Bash', BASH.arguments, { signal: new AbortController().signal, toolUseID: 'b1', parentToolUseId: null });
    await vi.waitFor(() => expect(chat.stream.some((m) => m.type === 'requestPermission')).toBe(true));

    const page = chatPage();
    await expect(chat.reload(page)).rejects.toThrow('the model registry did not load');
    expect(page.shown().prompts).toEqual(['b1']);
    expect(chat.received().filter((m) => m.type === 'sessionStateChanged')).toEqual([expect.objectContaining({ state: 'requires_action' })]);
    expect(reposted).toEqual(['p1']);

    await permissionHandler.resolveApproval('b1', true);
    await expect(approval).resolves.toMatchObject({ behavior: 'allow' });
  });

  it('a reload while a tool permission prompt is pending shows the prompt once, on its replayed card, and answering it continues the turn', async () => {
    const permissionHandler = new PermissionHandler(createFakePlatform());
    permissionHandler.setCwd(process.cwd());
    const chat = reloadingChat({ onWebviewReady: () => permissionHandler.repostPendingPrompts() });
    permissionHandler.setPostMessage(chat.panelPost);
    chat.session.adapter.beginTurn('c', { message: PROMPT, text: null });
    chat.play(TURN.slice(0, AT_GATE));
    const approval = permissionHandler.canUseTool('Bash', BASH.arguments, { signal: new AbortController().signal, toolUseID: 'b1', parentToolUseId: null });
    await vi.waitFor(() => expect(chat.stream.some((m) => m.type === 'requestPermission')).toBe(true));

    const { page, received } = await chat.reload();
    expect(page.shown()).toEqual(chat.watcher.shown());
    expect(page.shown().prompts).toEqual(['b1']);
    expect(received.filter((m) => m.type === 'requestPermission')).toHaveLength(1);
    expect(cardsOf(page.shown()).find((c) => c.id === 'b1')?.status).toBe('awaiting_approval');

    // the page's answer (approveEdit) reaches the awaiter the reload left in place, and the turn goes on
    await permissionHandler.resolveApproval('b1', true);
    await expect(approval).resolves.toMatchObject({ behavior: 'allow' });
    chat.play(TURN.slice(AT_GATE));
    expect(page.shown()).toEqual(chat.watcher.shown());
    expect(page.shown().processing).toBe(false);
    expect(cardsOf(page.shown()).find((c) => c.id === 'b1')?.status).toBe('completed');
  });

  it('a worktree chat reloaded mid-turn shows its composer and worktree state', async () => {
    const state = { phase: 'ready', place: 'worktree', canHandOff: true } as const;
    const worktree = {
      bindPanel: () => undefined, setListener: () => undefined, publish: () => undefined,
      // the session's republish to a page that loaded again
      republish: () => chat.panelPost({ type: 'worktreeState', ...state } as ExtensionToWebviewMessage),
      publishStored: vi.fn(),
      readOnly: () => false, inLiveWorktree: () => undefined, entry: () => undefined, record: () => undefined, place: () => 'worktree',
    };
    const chat = reloadingChat({ worktrees: true, worktree, onWebviewReady: () => worktree.republish() });
    chat.session.adapter.beginTurn('c', { message: PROMPT, text: null });
    const streaming = TURN.findIndex((event) => (event as { assistantMessageEvent?: { delta?: string } }).assistantMessageEvent?.delta === 'Run') + 1;
    chat.play(TURN.slice(0, streaming));
    const page = chatPage();
    // a restored desktop chat's composer waits for core to say where the chat works
    page.stores.uiStore.placePending = true;
    await chat.reload(page);
    expect(page.stores.uiStore.placePending).toBe(false);
    expect(page.stores.uiStore.worktree).toEqual(state);
    expect(worktree.publishStored).not.toHaveBeenCalled();
    expect(page.shown().processing).toBe(true);
    expect(page.shown().transcript.at(-1)).toEqual({ role: 'assistant', content: 'Run', thinking: 'Plan' });
  });
});
