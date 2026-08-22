import { describe, it, expect, vi } from 'vitest';
import { createSessionHandlers } from '../session-handlers';

vi.mock('vscode', () => ({ window: { showErrorMessage: vi.fn() }, workspace: { getConfiguration: () => ({ get: () => undefined }) } }));
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
      workspacePath: '/ws',
      postMessage: () => calls.push('postMessage'),
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
        sendOpenAIModelPricing: () => undefined,
        sendMcpConfig: () => undefined,
        sendModelForPanel: () => undefined,
        sendThinkingForPanel: () => undefined,
      },
      getLanguagePreference: () => 'en',
    } as unknown as Parameters<typeof createSessionHandlers>[0];

    const ctx = { session, host: {}, panelId: 'p1', permissionHandler: {} } as never;
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
