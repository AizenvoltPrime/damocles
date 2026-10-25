import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHarness, folderEntry, makeFakeHost, type Harness } from './panel-manager-harness';
import { createViewJoin } from '../message-router/handlers/session-handlers';
import type { HandlerDependencies } from '../message-router/types';
import type { ViewJoinGate } from '../types';
import type { ExtensionToWebviewMessage } from '../../../shared/types/messages';
import type { LiveSnapshot } from '../../pi-session/pi-stream-adapter';

const TOKEN = '6f0c6b52-0d51-4c7b-9a3f-3f7d2c3e8a11';

interface Deferred {
  readonly promise: Promise<void>;
  resolve(): void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => { resolve = settle; });
  return { promise, resolve };
}

let harness: Harness | undefined;

afterEach(() => {
  harness?.dispose();
  harness = undefined;
});

/**
 * A chat whose session emits live events through the panel while a view joins: the join's replay holds at `replaying`, so
 * events land in the middle of it. Live events carry the adapter's number; the snapshot was taken at 5.
 */
async function joiningChat() {
  const settled = deferred();
  const replaying = deferred();
  const order: string[] = [];
  const joins: { run?: (panelId: string, gate: ViewJoinGate) => Promise<void> } = {};
  const h = createHarness([folderEntry('/ws')], { joinView: (panelId, gate) => joins.run!(panelId, gate) });
  harness = h;
  const host = makeFakeHost();
  const panelId = await h.manager.initializeHost(host);
  const instance = h.instance(panelId);
  instance.panelToken = TOKEN;
  const session = h.sessions[0]!;
  session.panelToken = TOKEN;
  const seqs = new WeakMap<object, number>();
  const snapshot: LiveSnapshot = { seq: 5, messages: [{ type: 'processing', isProcessing: true }, { type: 'partial', data: { type: 'partial', content: [], session_id: 'S1', messageId: 'S1:a:1:1', streamingText: 'Hel' } }], liveToolCallIds: new Set() };
  const live = (seq: number | undefined, message: ExtensionToWebviewMessage): void => {
    if (seq !== undefined) seqs.set(message, seq);
    h.manager.postMessage(host, message);
  };
  Object.assign(session, {
    eventSeq: 5,
    eventSeqOf: (message: object) => seqs.get(message),
    whenConversationSettled: vi.fn(async () => {
      order.push('settle wait');
      await settled.promise;
    }),
    liveConversation: () => ({ sessionId: 'S1', stored: true, branch: [], sessionManager: {}, snapshot }),
    onWebviewReady: vi.fn(),
    replayLiveAgents: vi.fn(),
    fileCheckpoints: true,
  });
  const historyManager = {
    liveReplayContext: async () => ({ reasons: undefined, isContextOverflow: undefined }),
    replayLive: async (_context: unknown, _cwd: string, _session: unknown, post: (m: ExtensionToWebviewMessage) => void, captured: { snapshot: LiveSnapshot }) => {
      post({ type: 'sessionCleared', sessionId: 'S1' });
      post({ type: 'userReplay', content: 'hi', isSynthetic: false, sdkMessageId: 'u1' });
      await replaying.promise;
      for (const message of captured.snapshot.messages) post(message);
      post({ type: 'sessionStarted', sessionId: 'S1', stored: true });
    },
  };
  const deps = {
    postMessage: (target: typeof host, message: ExtensionToWebviewMessage) => h.manager.postMessage(target, message),
    platform: h.platform,
    settingsManager: {
      sendCurrentSettings: async () => undefined,
      sendMcpConfig: () => undefined,
      sendModelForPanel: () => undefined,
      sendThinkingForPanel: () => undefined,
      sendAvailableModels: async () => undefined,
      sendImageGenerationSettings: () => undefined,
    },
    storageManager: {
      getStoredSessions: async () => ({ sessions: [], hasMore: false, nextOffset: 0 }),
      getPromptHistory: async () => ({ history: [], hasMore: false }),
    },
    historyManager,
    getLanguagePreference: () => 'en',
    postWorkspaceFolderState: () => undefined,
    webviewPrompts: { repost: vi.fn() },
  } as unknown as HandlerDependencies;
  const viewJoin = createViewJoin(deps);
  joins.run = (id, gate) => viewJoin({
    host,
    session: instance.session,
    permissionHandler: instance.permissionHandler,
    ideContextManager: instance.ideContextManager,
    terminalAttachments: instance.terminalAttachments,
    panelId: id,
    folder: instance.folder,
  }, gate);
  return { h, host, panelId, instance, session, settled, replaying, order, live };
}

describe('views.join in core', () => {
  it('waits for a pending resume before it replays anything', async () => {
    const { h, host, settled, replaying, order } = await joiningChat();
    host.posted.length = 0;
    const joined = h.manager.joinView(host, TOKEN);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(order).toEqual(['settle wait']);
    expect(host.posted.some((m) => m.type === 'userReplay')).toBe(false);
    settled.resolve();
    replaying.resolve();
    await joined;
    expect(host.posted.some((m) => m.type === 'userReplay')).toBe(true);
  });

  it('answers undefined for a key that is not the panel token, and never changes the token', async () => {
    const { h, host, panelId, instance, session, settled, replaying } = await joiningChat();
    settled.resolve();
    replaying.resolve();
    expect(await h.manager.joinView(host, 'not-the-token')).toBeUndefined();
    expect(await h.manager.joinView(host, TOKEN)).toBe(panelId);
    expect(instance.panelToken).toBe(TOKEN);
    expect(session.panelToken).toBe(TOKEN);
  });

  it('delivers live events posted during the replay after it, once, dropping those the snapshot holds', async () => {
    const { h, host, settled, replaying, live } = await joiningChat();
    settled.resolve();
    host.posted.length = 0;
    const joined = h.manager.joinView(host, TOKEN);
    await vi.waitFor(() => expect(host.posted.some((m) => m.type === 'userReplay')).toBe(true));
    // the snapshot (seq 5) already holds event 4; event 6 and a state message came after it
    live(4, { type: 'partial', data: { type: 'partial', content: [], session_id: 'S1', messageId: 'S1:a:1:1', streamingText: 'He' } });
    live(6, { type: 'partial', data: { type: 'partial', content: [], session_id: 'S1', messageId: 'S1:a:1:1', streamingText: 'Hello' } });
    live(undefined, { type: 'statusUpdate', status: 'ready' });
    expect(host.posted.some((m) => m.type === 'statusUpdate')).toBe(false);
    replaying.resolve();
    await joined;
    const types = host.posted.map((m) => (m.type === 'partial' ? `partial:${(m.data as { streamingText?: string }).streamingText}` : m.type));
    const started = types.indexOf('sessionStarted');
    expect(types.indexOf('userReplay')).toBeLessThan(types.indexOf('partial:Hel'));
    expect(types.indexOf('partial:Hel')).toBeLessThan(started);
    expect(types.slice(started + 1, started + 3)).toEqual(['partial:Hello', 'statusUpdate']);
    expect(types).not.toContain('partial:He');
    expect(types.filter((type) => type === 'partial:Hello')).toHaveLength(1);
    // after the join, posts go straight to the view again
    live(7, { type: 'processing', isProcessing: false });
    expect(host.posted.at(-1)).toEqual({ type: 'processing', isProcessing: false });
  });

  it('delivers everything it held when the join fails', async () => {
    const { h, host, settled, live, session } = await joiningChat();
    settled.resolve();
    (session as unknown as { liveConversation: () => unknown }).liveConversation = () => {
      throw new Error('no branch');
    };
    host.posted.length = 0;
    await expect(h.manager.joinView(host, TOKEN)).rejects.toThrow('no branch');
    live(9, { type: 'processing', isProcessing: false });
    expect(host.posted.at(-1)).toEqual({ type: 'processing', isProcessing: false });
  });
});
