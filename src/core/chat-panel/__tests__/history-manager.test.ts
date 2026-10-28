import { describe, it, expect, vi } from 'vitest';
import type { ExtensionToWebviewMessage } from '../../../shared/types/messages';
import type { ChatSession } from '../../chat-session';
import type { PanelHost } from '../../../platform/window-service';

vi.mock('../../logger', () => ({ log: vi.fn() }));

/** The replay contract as the pi loader posts it: transcript and usage, and no panel state. */
const H = vi.hoisted(() => ({
  replay: [
    { type: 'sessionCleared', sessionId: 's1' },
    { type: 'userReplay', content: 'hi', isSynthetic: false, sdkMessageId: 'u1' },
    { type: 'assistantReplay', content: 'hello', contentBlocks: [] },
    { type: 'tokenUsageUpdate', inputTokens: 10, outputTokens: 5 },
    { type: 'sessionUsage', usage: { totalInputTokens: 10, totalOutputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0 }, numTurns: 1 },
    { type: 'done', data: { type: 'result', session_id: 's1', is_done: true } },
  ] as unknown as ExtensionToWebviewMessage[],
}));

vi.mock('../../pi-session/session-store', () => ({
  loadPiSessionHistory: vi.fn(async (_cwd: string, _sessionId: string, post: (m: ExtensionToWebviewMessage) => void) => {
    for (const m of H.replay) post(m);
    return ['u1'];
  }),
  getPiRewindHistory: vi.fn(async () => ({ items: [], restorePoints: [] })),
  getPiFileCheckpointContent: vi.fn(async () => null),
  getPiSkippedFiles: vi.fn(async () => ({ ok: true, value: [] })),
}));

vi.mock('../../pi-session/session-store/history-loader', () => ({
  replayContext: vi.fn(async () => ({ reasons: undefined, isContextOverflow: undefined })),
  replayLiveBranch: vi.fn(async (_context: unknown, _cwd: string, sessionId: string, _sm: unknown, _branch: unknown, post: (m: ExtensionToWebviewMessage) => void) => {
    post({ type: 'sessionCleared', sessionId });
    return [];
  }),
}));

import { HistoryManager } from '../history-manager';

function harness(): {
  manager: HistoryManager;
  host: PanelHost;
  session: ChatSession;
  posted: ExtensionToWebviewMessage[];
} {
  const posted: ExtensionToWebviewMessage[] = [];
  const host = { onDispose: () => ({ dispose: () => undefined }) } as unknown as PanelHost;
  // Stands in for PiSession.publishAccountInfo, which emits this message through the panel's onMessage.
  const session = {
    publishAccountInfo: () => posted.push({
      type: 'accountInfo',
      data: { model: 'gpt-6.1-sol', dollarBilled: true },
    }),
    // Stands in for PiSession.replayLiveAgents, which posts a running subagent's card state after the replay rebuilt it.
    replayLiveAgents: (sessionId: string) => posted.push({ type: 'taskStarted', taskId: `live-of-${sessionId}`, toolUseId: 'tc-1', description: 'dig' }),
  } as unknown as ChatSession;
  const manager = new HistoryManager({
    postMessage: (_h, m) => posted.push(m),
    maxCheckpointFileSizeBytes: () => 25 * 1024 * 1024,
  });
  return { manager, host, session, posted };
}

/**
 * A session reopened from the picker may never run a turn, and the replay carries no panel state, so
 * the restore itself has to deliver the account state.
 */
describe('HistoryManager.loadSessionHistory', () => {
  it('delivers account state to the restored panel with no turn', async () => {
    const { manager, host, session, posted } = harness();

    await manager.loadSessionHistory('/ws', 's1', host, session);

    const account = posted.filter((m) => m.type === 'accountInfo');
    expect(account).toHaveLength(1);
    expect(account[0]).toEqual({
      type: 'accountInfo',
      data: { model: 'gpt-6.1-sol', dollarBilled: true },
    });
  });

  it('delivers it after the replay, so the transcript never lands on top of it', async () => {
    const { manager, host, session, posted } = harness();

    await manager.loadSessionHistory('/ws', 's1', host, session);

    const types = posted.map((m) => m.type);
    expect(types.indexOf('accountInfo')).toBeGreaterThan(types.indexOf('sessionCleared'));
    expect(types.indexOf('accountInfo')).toBeGreaterThan(types.indexOf('done'));
  });

  it("replays the conversation's live subagents after the transcript rebuilt their cards", async () => {
    const { manager, host, session, posted } = harness();

    await manager.loadSessionHistory('/ws', 's1', host, session);

    const types = posted.map((m) => m.type);
    expect(posted.filter((m) => m.type === 'taskStarted')).toEqual([{ type: 'taskStarted', taskId: 'live-of-s1', toolUseId: 'tc-1', description: 'dig' }]);
    expect(types.indexOf('taskStarted')).toBeGreaterThan(types.indexOf('done'));
  });
});

/** A view joining a running chat (views.join) starts with an empty store, so its replay of pi's branch delivers the account state too. */
describe('HistoryManager.replayLive', () => {
  it('delivers account state to the joining view after the replay', async () => {
    const { manager, host, session, posted } = harness();
    const viewPosts: ExtensionToWebviewMessage[] = [];
    const live = { sessionId: 's1', stored: true, branch: [], sessionManager: {}, snapshot: { seq: 0, messages: [], liveToolCallIds: new Set<string>() } };

    await manager.replayLive({ reasons: undefined, isContextOverflow: undefined } as never, '/ws', session, host, (m) => viewPosts.push(m), live as never);

    expect(viewPosts.map((m) => m.type)).toEqual(['sessionCleared', 'sessionStarted']);
    expect(posted).toEqual([{ type: 'accountInfo', data: { model: 'gpt-6.1-sol', dollarBilled: true } }]);
  });
});

/** A conversation resumed from another folder is read from that folder's session dir, not the asking panel's. */
describe('HistoryManager reads the folder it is given', () => {
  it('replays and seeds checkpoints from the session\'s own folder', async () => {
    const store = await import('../../pi-session/session-store');
    const { manager, host, session } = harness();

    const rewindableIds = await manager.loadSessionHistory('/work/beta', 's-b', host, session);

    expect(vi.mocked(store.loadPiSessionHistory).mock.calls.at(-1)?.slice(0, 2)).toEqual(['/work/beta', 's-b']);
    // The checkpoint ids come from the replay's own read of that folder's file.
    expect(rewindableIds).toEqual(['u1']);
  });
});

/** A panel several views show (a daemon's clients): a replay to the whole panel and one to a view of it never post into that view at once. */
describe('HistoryManager replays to a panel and its views', () => {
  const blockingLoad = () => {
    const signals: AbortSignal[] = [];
    const releases: Array<() => void> = [];
    const load = async (_cwd: string, sessionId: string, post: (m: ExtensionToWebviewMessage) => void, signal: AbortSignal): Promise<string[]> => {
      signals.push(signal);
      post({ type: 'sessionCleared', sessionId } as ExtensionToWebviewMessage);
      await new Promise<void>((resolve) => {
        releases.push(resolve);
        signal.addEventListener('abort', () => resolve(), { once: true });
      });
      return [];
    };
    return { signals, releases, load };
  };
  const views = () => {
    const panel = { onDispose: () => ({ dispose: () => undefined }) } as unknown as PanelHost;
    const view = Object.assign(Object.create(panel) as PanelHost, { panelHost: panel });
    return { panel, view };
  };

  it('aborts a view\'s replay when the whole panel replays, which reaches that view too', async () => {
    const store = await import('../../pi-session/session-store');
    const { signals, releases, load } = blockingLoad();
    vi.mocked(store.loadPiSessionHistory).mockImplementation(load as never);
    const { manager, session } = harness();
    const { panel, view } = views();
    const toView = manager.loadSessionHistory('/ws', 's1', view, session);
    await vi.waitFor(() => expect(signals).toHaveLength(1));
    const toPanel = manager.loadSessionHistory('/ws', 's2', panel, session);
    await vi.waitFor(() => expect(signals).toHaveLength(2));
    expect(signals[0]!.aborted).toBe(true);
    releases[1]!();
    await Promise.all([toView, toPanel]);
    vi.mocked(store.loadPiSessionHistory).mockReset();
  });

  it('starts a view\'s replay once the panel\'s replay in flight ended, and leaves that one running', async () => {
    const store = await import('../../pi-session/session-store');
    const { signals, releases, load } = blockingLoad();
    vi.mocked(store.loadPiSessionHistory).mockImplementation(load as never);
    const { manager, session } = harness();
    const { panel, view } = views();
    const toPanel = manager.loadSessionHistory('/ws', 's1', panel, session);
    await vi.waitFor(() => expect(signals).toHaveLength(1));
    const toView = manager.loadSessionHistory('/ws', 's1', view, session);
    await new Promise((resolve) => setImmediate(resolve));
    expect(signals).toHaveLength(1);
    expect(signals[0]!.aborted).toBe(false);
    releases[0]!();
    await vi.waitFor(() => expect(signals).toHaveLength(2));
    releases[1]!();
    await Promise.all([toPanel, toView]);
    vi.mocked(store.loadPiSessionHistory).mockReset();
  });
});
