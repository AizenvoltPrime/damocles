import { describe, it, expect, vi } from 'vitest';
import { createSessionHandlers } from '../session-handlers';

vi.mock('vscode', () => ({
  window: { showErrorMessage: vi.fn(), showInformationMessage: vi.fn() },
  workspace: { getConfiguration: () => ({ get: () => undefined }) },
  l10n: { t: (s: string) => s },
}));
vi.mock('../../../../pi-session/session-store', () => ({ renamePiSession: vi.fn(), deletePiSession: vi.fn(), tagPiSession: vi.fn() }));
vi.mock('../../../../pi-session/pi-runtime', () => ({ PiRuntime: { exists: false, get: vi.fn() } }));
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
        sendMcpConfig: () => undefined,
        sendModelForPanel: () => undefined,
        sendThinkingForPanel: () => undefined,
      },
      getLanguagePreference: () => 'en',
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

  function makeSession() {
    return {
      onWebviewReady: vi.fn(),
      getToolStatus: () => ({}),
      holdsSession: () => false,
      setResumeSession: vi.fn(),
      initializeEarly: vi.fn(async () => undefined),
    };
  }

  function harness(opts: { sessionFolder?: typeof A; heldElsewhere?: string } = {}) {
    const session = makeSession();
    const host = { id: 'host' };
    const instance: { host: unknown; session: ReturnType<typeof makeSession>; folder: typeof A } = { host, session, folder: A };
    const order: string[] = [];
    const claims: boolean[] = [];
    const switchPanelFolder = vi.fn(async (_panelId: string, key: string, _reason: string, afterSwitch?: (i: unknown) => Promise<boolean>) => {
      instance.session = makeSession();
      instance.folder = key === B.key ? B : A;
      if (afterSwitch) claims.push(await afterSwitch(instance));
      order.push('gate-open');
      return instance;
    });
    const loadSessionHistory = vi.fn(async (..._args: unknown[]) => { order.push('load'); });
    const postWorkspaceFolderState = vi.fn();
    const deps = {
      postMessage: () => undefined,
      postWorkspaceFolderState,
      switchPanelFolder,
      folderRegistry: { resolve: (key: string) => [A, B].find((f) => f.key === key) },
      getPanels: () => new Map<string, unknown>([
        ['p1', instance],
        ...(opts.heldElsewhere ? [['p2', { host: { id: 'other' }, session: { holdsSession: (id: string) => id === opts.heldElsewhere } }] as const] : []),
      ]),
      historyManager: { loadSessionHistory },
      storageManager: {
        getStoredSessions: async () => ({ sessions: [], hasMore: false, nextOffset: 0 }),
        getPromptHistory: async () => ({ history: [], hasMore: false }),
        folderOf: vi.fn(async () => opts.sessionFolder),
      },
      settingsManager: {
        sendCurrentSettings: async () => undefined,
        sendAvailableModels: () => undefined,
        sendMcpConfig: () => undefined,
        sendModelForPanel: () => undefined,
        sendThinkingForPanel: () => undefined,
      },
      getLanguagePreference: () => 'en',
    } as unknown as Parameters<typeof createSessionHandlers>[0];
    const ctx = { session, host, panelId: 'p1', permissionHandler: {}, folder: A } as never;
    return { deps, ctx, session, instance, switchPanelFolder, loadSessionHistory, postWorkspaceFolderState, order, claims };
  }

  it('tells the webview its folder state', async () => {
    const h = harness();
    await createSessionHandlers(h.deps).ready!({ type: 'ready' } as never, h.ctx);
    expect(h.postWorkspaceFolderState).toHaveBeenCalledWith('p1');
  });

  it("moves to the folder holding the saved conversation, then resumes it on the new session", async () => {
    const h = harness({ sessionFolder: B });
    await createSessionHandlers(h.deps).ready!({ type: 'ready', savedSessionId: 's-b', savedWorkspaceFolderKey: A.key } as never, h.ctx);

    expect(h.switchPanelFolder).toHaveBeenCalledWith('p1', B.key, 'restore', expect.any(Function));
    // Resumed inside the switch, before queued webview messages are let through.
    expect(h.order).toEqual(['load', 'gate-open']);
    expect(h.instance.session).not.toBe(h.session);
    expect(h.instance.session.setResumeSession).toHaveBeenCalledWith('s-b');
    expect(h.session.setResumeSession).not.toHaveBeenCalled();
    expect(h.loadSessionHistory).toHaveBeenCalledWith('/b', 's-b', h.instance.host, h.instance.session);
    // Reported as claimed, so the switch leaves the session to start on the first send, as in place.
    expect(h.claims).toEqual([true]);
  });

  it('reports no claim when moving without a saved conversation, so the switch starts the session', async () => {
    const h = harness();
    await createSessionHandlers(h.deps).ready!({ type: 'ready', savedWorkspaceFolderKey: B.key } as never, h.ctx);
    expect(h.claims).toEqual([false]);
  });

  it('moves to the persisted folder when there is no saved conversation', async () => {
    const h = harness();
    await createSessionHandlers(h.deps).ready!({ type: 'ready', savedWorkspaceFolderKey: B.key } as never, h.ctx);

    expect(h.switchPanelFolder).toHaveBeenCalledWith('p1', B.key, 'restore', expect.any(Function));
    // The switch started the new session; the one it replaced is never started.
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
