import { describe, it, expect, vi } from 'vitest';
import { createSessionHandlers } from '../session-handlers';
import { createFakePlatform } from '../../../../../__mocks__/fake-platform';
vi.mock('../../../../pi-session/session-store', () => ({ renamePiSession: vi.fn(), deletePiSession: vi.fn(), tagPiSession: vi.fn() }));
vi.mock('../../../../pi-session/pi-runtime', () => ({ PiRuntime: { liveSessionMutator: () => undefined } }));
vi.mock('../../../../logger', () => ({ log: vi.fn() }));

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
      setResumeSession: () => undefined,
      initializeEarly: async () => undefined,
    };
    const deps = {
      platform: createFakePlatform(),
      postMessage: () => calls.push('postMessage'),
      postWorkspaceFolderState: () => undefined,
      folderRegistry: { resolve: () => undefined },
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

    const ctx = { session, host: {}, panelId: 'p1', permissionHandler: {}, folder: { key: '/ws', fsPath: '/ws' } } as never;
    return { calls, deps, ctx, session };
  }

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
      holdsSession: () => false,
      setResumeSession: vi.fn(),
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
    const loadSessionHistory = vi.fn(async (..._args: unknown[]) => { order.push('load'); });
    const postWorkspaceFolderState = vi.fn();
    const deps = {
      platform: createFakePlatform(),
      postMessage: (_host: unknown, m: { type: string; status?: unknown }) => { posted.push(m); },
      postWorkspaceFolderState,
      switchPanelFolder,
      compassRegistry,
      folderRegistry: { resolve: (key: string) => [A, B].find((f) => f.key === key) },
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
    const ctx = { session, host, panelId: 'p1', permissionHandler: {}, folder: A } as never;
    const compassPosts = () => posted.filter((m) => m.type === 'compassStatusUpdate');
    return { deps, ctx, session, instance, switchPanelFolder, loadSessionHistory, postWorkspaceFolderState, order, compassPosts };
  }

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
    // Resumed inside the switch, before queued webview messages are let through; started after the lists.
    expect(h.order).toEqual(['load', 'gate-open', 'list', 'history', 'start']);
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
      holdsSession: () => false,
      setResumeSession: () => undefined,
      initializeEarly: async () => { order.push('initializeEarly'); },
    };
    const host = { id: 'host' };
    const folder = { key: '/a', fsPath: '/a' };
    const panel: { host: unknown; session: unknown; folder: unknown } = { host, session, folder };
    const deps = {
      platform: createFakePlatform(),
      postMessage: (_host: unknown, m: { type: string }) => { if (m.type === 'sessionStarted') order.push('sessionStarted'); },
      postWorkspaceFolderState: () => undefined,
      folderRegistry: { resolve: () => undefined },
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
    const ctx = { session, host, panelId: 'p1', permissionHandler: {}, folder } as never;
    return { deps, ctx, order, panel };
  }

  const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

  it('replays a restored conversation before listing sessions or prompt history, then starts the session and asks for models', async () => {
    const h = harness();
    await createSessionHandlers(h.deps).ready!({ type: 'ready', savedSessionId: 's-a' } as never, h.ctx);
    await settle();
    expect(h.order).toEqual(['sendCurrentSettings', 'loadSessionHistory', 'sessionStarted', 'getStoredSessions', 'getPromptHistory', 'initializeEarly', 'sendAvailableModels:own']);
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
 * pi writes a conversation's file with its first prompt, so the webview persists a conversation's id for
 * restore only once the host says it is stored. A reload of a panel whose conversation is still unwritten
 * therefore sends no saved id, and the host tells the new page which live conversation it is showing.
 */
describe('ready handler: a conversation pi has not written yet', () => {
  function harness(session: { currentSessionId: string | null; hasSessionFile: () => boolean }, loaded: string[] | null = []) {
    const posted: Array<{ type: string } & Record<string, unknown>> = [];
    const panelSession = {
      ...session,
      onWebviewReady: () => undefined,
      getToolStatus: () => ({}),
      holdsSession: () => false,
      setResumeSession: vi.fn(),
      initializeEarly: async () => undefined,
    };
    const host = { id: 'host' };
    const folder = { key: '/a', fsPath: '/a' };
    const loadSessionHistory = vi.fn(async () => loaded);
    const deps = {
      platform: createFakePlatform(),
      postMessage: (_host: unknown, m: { type: string } & Record<string, unknown>) => { posted.push(m); },
      postWorkspaceFolderState: () => undefined,
      folderRegistry: { resolve: () => undefined },
      getPanels: () => new Map([['p1', { host, session: panelSession, folder }]]),
      historyManager: { loadSessionHistory },
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
    } as unknown as Parameters<typeof createSessionHandlers>[0];
    const ctx = { session: panelSession, host, panelId: 'p1', permissionHandler: {}, folder } as never;
    const started = () => posted.filter((m) => m.type === 'sessionStarted');
    return { deps, ctx, posted, started, loadSessionHistory, panelSession };
  }

  it('a reloaded page with no saved id learns the live conversation, unstored, with no replay and no error', async () => {
    const h = harness({ currentSessionId: 'fresh-1', hasSessionFile: () => false });
    await createSessionHandlers(h.deps).ready!({ type: 'ready' } as never, h.ctx);

    expect(h.started()).toEqual([{ type: 'sessionStarted', sessionId: 'fresh-1', stored: false }]);
    expect(h.loadSessionHistory).not.toHaveBeenCalled();
    expect(h.panelSession.setResumeSession).not.toHaveBeenCalled();
    expect(h.posted.some((m) => m.type === 'errorReplay')).toBe(false);
  });

  it('reports a live conversation that has its file as stored, so the page persists it again', async () => {
    const h = harness({ currentSessionId: 'live-1', hasSessionFile: () => true });
    await createSessionHandlers(h.deps).ready!({ type: 'ready' } as never, h.ctx);

    expect(h.started()).toEqual([{ type: 'sessionStarted', sessionId: 'live-1', stored: true }]);
  });

  it('announces nothing for a panel whose session has not started; its start announces it', async () => {
    const h = harness({ currentSessionId: null, hasSessionFile: () => false });
    await createSessionHandlers(h.deps).ready!({ type: 'ready' } as never, h.ctx);

    expect(h.started()).toEqual([]);
  });

  it('marks a restored conversation stored only when its file was read', async () => {
    const read = harness({ currentSessionId: null, hasSessionFile: () => false }, ['u1']);
    await createSessionHandlers(read.deps).ready!({ type: 'ready', savedSessionId: 's-a' } as never, read.ctx);
    expect(read.started()).toEqual([{ type: 'sessionStarted', sessionId: 's-a', stored: true }]);

    const missing = harness({ currentSessionId: null, hasSessionFile: () => false }, null);
    await createSessionHandlers(missing.deps).ready!({ type: 'ready', savedSessionId: 's-gone' } as never, missing.ctx);
    // Unstored, so the page drops the id and the next restart opens a fresh conversation instead of repeating the notice.
    expect(missing.started()).toEqual([{ type: 'sessionStarted', sessionId: 's-gone', stored: false }]);
  });
});
