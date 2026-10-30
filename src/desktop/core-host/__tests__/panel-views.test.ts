// @vitest-environment happy-dom
// A core panel several clients' views show: a view's host posts to that view alone and is paced by that view's client, the
// panel's host posts to every view, a join replays to the joining view alone while the others go on live, and a message
// names the view that sent it and keeps the client it came from while it waits behind a `ready`; a page that loads again
// mid-turn takes the same live replay through the panel's view gate.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHarness, folderEntry, handlingContext, makeFakeHost, makeMultiViewHost, type Harness } from '../../../core/chat-panel/__tests__/panel-manager-harness';
import { processActor, type CoreEndpoint } from '../../core-protocol';
import type { ViewJoinGate } from '../../../core/chat-panel/types';
import type { PanelHost } from '../../../platform/window-service';
import type { ExtensionToWebviewMessage } from '../../../shared/types/messages';
import { createCorePanels, PACE_CHARS } from '../platform/panels';
import { createSessionHandlers } from '../../../core/chat-panel/message-router/handlers/session-handlers';
import type { HandlerContext, HandlerDependencies } from '../../../core/chat-panel/message-router/types';
import { HistoryManager } from '../../../core/chat-panel/history-manager';
import type { ChatSession } from '../../../core/chat-session';
import { TOOL_OUTPUT_COALESCE_MS } from '../../../core/pi-session/tool-output-coalescer';
import { cardsOf, chatPage, liveChatSession, PROMPT, TURN, type ChatPage, type LiveChatSession } from '../../../core/pi-session/__tests__/live-chat-page';

// A session file's replay as pi's loader posts it: cleared under its name, then each row once the view's client drained.
vi.mock('../../../core/pi-session/session-store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../core/pi-session/session-store')>()),
  loadPiSessionHistory: async (_cwd: string, sessionId: string, post: (m: ExtensionToWebviewMessage) => void, signal: AbortSignal, _reasons: unknown, _checkpoints: boolean, paced: () => Promise<void>) => {
    post({ type: 'sessionCleared', sessionId });
    const rows: ExtensionToWebviewMessage[] = [
      { type: 'userReplay', content: 'from the file', sdkMessageId: 'u-file' },
      { type: 'assistantReplay', content: 'as stored' },
      { type: 'done', data: { type: 'result', session_id: sessionId, is_done: true } } as ExtensionToWebviewMessage,
    ];
    for (const row of rows) {
      await paced();
      if (signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      post(row);
    }
    return ['u-file'];
  },
}));

const TOKEN = '6f0c6b52-0d51-4c7b-9a3f-3f7d2c3e8a11';
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

function proxy() {
  const posted: unknown[] = [];
  const binary: unknown[] = [];
  const asked: unknown[] = [];
  const answers: Array<() => void> = [];
  let listener: ((panelId: string, envelope: unknown) => void) | undefined;
  const endpoint = {
    postPanel: (_id: string, op: string, payload: unknown) => {
      if (op === 'post') posted.push(payload);
      if (op === 'postBinary') binary.push(payload);
    },
    request: (method: string, params: unknown) => {
      asked.push([method, params]);
      return new Promise<void>((resolve) => answers.push(resolve));
    },
    onPanel: (next: (panelId: string, envelope: unknown) => void) => {
      listener = next;
      return { dispose: () => undefined };
    },
    onMirror: () => ({ dispose: () => undefined }),
    emit: () => undefined,
  } as unknown as CoreEndpoint;
  const host = createCorePanels({ endpoint, resourceRoot: '/app' }).attach('view-1');
  const deliver = (message: unknown, viewKey?: string): void => listener!('view-1', { op: 'message', payload: { message, ...(viewKey !== undefined ? { viewKey } : {}) } });
  const detach = (viewKey: string): void => listener!('view-1', { op: 'viewDetached', payload: { viewKey } });
  return { host, posted, binary, asked, answers, deliver, detach };
}

let harness: Harness | undefined;
afterEach(() => {
  harness?.dispose();
  harness = undefined;
});

describe('a core panel\'s view hosts', () => {
  it('post to one view by its key, to every view from the panel host, and to every view but some', async () => {
    const { host, posted } = proxy();
    const view = host.viewHost!('view-a');
    expect(view.panelHost).toBe(host);
    expect(host.viewHost!('view-a')).toBe(view);
    await view.postMessage({ type: 'sessionCleared' });
    await host.postMessage({ type: 'processing', isProcessing: true });
    await host.postMessageExcept!({ type: 'statusUpdate', status: 'ready' }, ['view-a']);
    expect(posted).toEqual([
      { type: 'sessionCleared', json: '{"type":"sessionCleared"}', viewKey: 'view-a' },
      { type: 'processing', json: '{"type":"processing","isProcessing":true}' },
      { type: 'statusUpdate', json: '{"type":"statusUpdate","status":"ready"}', except: ['view-a'] },
    ]);
  });

  it('pace a view\'s replay by that view\'s client alone (views.drained with its key)', async () => {
    const { host, asked, answers } = proxy();
    const view = host.viewHost!('view-b');
    await view.postMessage({ type: 'assistantReplay', text: 'x'.repeat(PACE_CHARS) });
    expect(asked).toEqual([['views.drained', { viewId: 'view-1', viewKey: 'view-b' }]]);
    // the panel host's own pacing is apart: it asked nothing and is not waiting
    await expect(host.drained!()).resolves.toBeUndefined();
    let drained = false;
    void view.drained!().then(() => { drained = true; });
    await settle();
    expect(drained).toBe(false);
    answers[0]!();
    await settle();
    expect(drained).toBe(true);
  });

  it('name the view a message came from, and list each view with the client its first message came from', () => {
    const { host, deliver } = proxy();
    const heard: Array<[unknown, string | undefined]> = [];
    host.onMessage((message, viewKey) => heard.push([message, viewKey]));
    processActor.run('device-a', () => deliver({ type: 'ready' }, 'view-a'));
    processActor.run('device-b', () => deliver({ type: 'sendMessage' }, 'view-b'));
    processActor.run('device-b', () => deliver({ type: 'sendMessage' }, 'view-a'));
    expect(heard.map(([, key]) => key)).toEqual(['view-a', 'view-b', 'view-a']);
    expect(host.views!()).toEqual([{ viewKey: 'view-a', clientId: 'device-a' }, { viewKey: 'view-b', clientId: 'device-b' }]);
    // a view's host names its device, so a settings view gets only its own device's posts
    expect([host.viewHost!('view-a').clientId, host.viewHost!('view-b').clientId, host.clientId]).toEqual(['device-a', 'device-b', undefined]);
  });

  it('forget a view the daemon says is gone, and make a new host for its key if it comes back', () => {
    const { host, deliver, detach } = proxy();
    processActor.run('device-a', () => deliver({ type: 'ready' }, 'view-a'));
    const gone = host.viewHost!('view-b');
    detach('view-b');
    expect(host.views!()).toEqual([{ viewKey: 'view-a', clientId: 'device-a' }]);
    expect(host.viewHost!('view-b')).not.toBe(gone);
  });

  it('address a binary post to its view, as a JSON post is', async () => {
    const { host, binary } = proxy();
    const frame = { type: 'frame', data: new Uint8Array([1]) };
    await host.viewHost!('view-a').postMessage(frame);
    await host.postMessageExcept!(frame, ['view-a']);
    expect(binary).toEqual([{ message: frame, viewKey: 'view-a' }, { message: frame, except: ['view-a'] }]);
  });
});

describe('a join of one view among several', () => {
  it('replays to the joining view alone, while the other views take the live posts the joining one gets after its replay', async () => {
    let gate!: ViewJoinGate;
    let joinHost!: PanelHost;
    let replayed!: () => void;
    const replay = new Promise<void>((resolve) => (replayed = resolve));
    const h = createHarness([folderEntry('/ws')], {
      joinView: async (joined, joinGate, target) => {
        gate = joinGate;
        joinHost = target;
        gate.post({ type: 'sessionCleared', sessionId: 'S1' });
        gate.hold(h.instance(joined).session);
        await replay;
      },
    });
    harness = h;
    const host = makeMultiViewHost();
    const panelId = await h.manager.initializeHost(host);
    h.instance(panelId).panelToken = TOKEN;
    Object.assign(h.sessions[0]!, { eventSeqOf: () => undefined });
    const joined = h.manager.joinView(host, TOKEN, 'view-2');
    await settle();
    expect(joinHost).toBe(host.viewHost!('view-2'));
    const live: ExtensionToWebviewMessage = { type: 'processing', isProcessing: true };
    h.manager.postMessage(host, live);
    expect(host.except).toEqual([{ message: live, except: ['view-2'] }]);
    expect(host.toView.get('view-2')).toEqual([{ type: 'sessionCleared', sessionId: 'S1' }]);
    replayed();
    expect(await joined).toBe(panelId);
    expect(host.toView.get('view-2')).toEqual([{ type: 'sessionCleared', sessionId: 'S1' }, live]);
    expect(host.posted).toEqual([]);
    // after the join a post reaches every view again
    h.manager.postMessage(host, { type: 'processing', isProcessing: false });
    expect(host.posted).toEqual([{ type: 'processing', isProcessing: false }]);
  });

  it('runs a second view\'s join once the first one\'s replay ended, holding posts from one view at a time', async () => {
    const replays: Array<() => void> = [];
    const started: PanelHost[] = [];
    const h = createHarness([folderEntry('/ws')], {
      joinView: async (joined, gate, target) => {
        started.push(target);
        gate.hold(h.instance(joined).session);
        await new Promise<void>((resolve) => replays.push(resolve));
      },
    });
    harness = h;
    const host = makeMultiViewHost();
    const panelId = await h.manager.initializeHost(host);
    h.instance(panelId).panelToken = TOKEN;
    Object.assign(h.sessions[0]!, { eventSeqOf: () => undefined });
    const first = h.manager.joinView(host, TOKEN, 'view-2');
    const second = h.manager.joinView(host, TOKEN, 'view-3');
    await settle();
    expect(started).toEqual([host.viewHost!('view-2')]);
    const live: ExtensionToWebviewMessage = { type: 'processing', isProcessing: true };
    h.manager.postMessage(host, live);
    expect(host.except).toEqual([{ message: live, except: ['view-2'] }]);
    replays[0]!();
    expect(await first).toBe(panelId);
    await settle();
    expect(started).toEqual([host.viewHost!('view-2'), host.viewHost!('view-3')]);
    replays[1]!();
    expect(await second).toBe(panelId);
  });

  it('keeps a post for every view but some out of those views, the joining one too once its replay ended', async () => {
    let replayed!: () => void;
    const h = createHarness([folderEntry('/ws')], {
      joinView: async (joined, gate) => {
        gate.hold(h.instance(joined).session);
        await new Promise<void>((resolve) => (replayed = resolve));
      },
    });
    harness = h;
    const host = makeMultiViewHost();
    const panelId = await h.manager.initializeHost(host);
    h.instance(panelId).panelToken = TOKEN;
    Object.assign(h.sessions[0]!, { eventSeqOf: () => undefined });
    const joined = h.manager.joinView(host, TOKEN, 'view-2');
    await settle();
    const notForView1: ExtensionToWebviewMessage = { type: 'queueCancelled', messageId: 'q-1' };
    const notForView2: ExtensionToWebviewMessage = { type: 'queueCancelled', messageId: 'q-2' };
    h.manager.postMessage(host, notForView1, ['view-1']);
    h.manager.postMessage(host, notForView2, ['view-2']);
    expect(host.except).toEqual([{ message: notForView1, except: ['view-1', 'view-2'] }, { message: notForView2, except: ['view-2'] }]);
    replayed();
    await joined;
    expect(host.toView.get('view-2')).toEqual([notForView1]);
  });

  it('copies a post held from the joining view to the attached settings view once', async () => {
    let replayed!: () => void;
    const h = createHarness([folderEntry('/ws')], {
      joinView: async (joined, gate) => {
        gate.hold(h.instance(joined).session);
        await new Promise<void>((resolve) => (replayed = resolve));
      },
    });
    harness = h;
    const host = makeMultiViewHost();
    const panelId = await h.manager.initializeHost(host);
    h.instance(panelId).panelToken = TOKEN;
    Object.assign(h.sessions[0]!, { eventSeqOf: () => undefined });
    const copied: unknown[] = [];
    h.manager.attachView(panelId, { post: (message) => copied.push(message), detached: () => undefined });
    const joined = h.manager.joinView(host, TOKEN, 'view-2');
    await settle();
    const update: ExtensionToWebviewMessage = { type: 'modelUpdate', activeModel: 'm', defaultModel: 'm', contextWindowSize: 1 };
    h.manager.postMessage(host, update);
    replayed();
    await joined;
    expect(copied).toEqual([update]);
    expect(host.toView.get('view-2')).toEqual([update]);
  });

  it('holds every post of a single-view panel and replays to the panel host itself, as before', async () => {
    let joinHost!: PanelHost;
    const h = createHarness([folderEntry('/ws')], {
      joinView: async (joined, gate, target) => {
        joinHost = target;
        gate.hold(h.instance(joined).session);
      },
    });
    harness = h;
    const host = makeFakeHost();
    const panelId = await h.manager.initializeHost(host);
    h.instance(panelId).panelToken = TOKEN;
    await h.manager.joinView(host, TOKEN);
    expect(joinHost).toBe(host);
  });
});

describe('a message from one view of several', () => {
  it('reaches the router with its view key, and one queued behind a ready keeps the client it came from', async () => {
    const h = createHarness([folderEntry('/ws')]);
    harness = h;
    let releaseReady!: () => void;
    h.holdReady.gate = new Promise<void>((resolve) => (releaseReady = resolve));
    const host = makeMultiViewHost();
    await h.manager.initializeHost(host);
    handlingContext.run('device-a', () => host.sendFrom({ type: 'ready' } as never, 'view-1'));
    await settle();
    handlingContext.run('device-b', () => host.sendFrom({ type: 'getSettings' } as never, 'view-2'));
    await settle();
    expect(h.routed.map((entry) => entry.message.type)).toEqual(['ready']);
    // the ready settles in device a's context; the queued message still runs as device b's
    handlingContext.run('device-a', () => releaseReady());
    await settle();
    expect(h.routed.map(({ message, viewKey, context }) => [message.type, viewKey, context])).toEqual([
      ['ready', 'view-1', 'device-a'],
      ['getSettings', 'view-2', 'device-b'],
    ]);
  });
});

describe('sends from several views', () => {
  it('reach the one panel and its one session, which keeps the first view\'s token for the lease owner record', async () => {
    const h = createHarness([folderEntry('/ws')]);
    harness = h;
    const host = makeMultiViewHost();
    const panelId = await h.manager.initializeHost(host);
    h.instance(panelId).panelToken = TOKEN;
    handlingContext.run('device-a', () => host.sendFrom({ type: 'sendMessage', content: 'from a' } as never, 'view-1'));
    handlingContext.run('device-b', () => host.sendFrom({ type: 'sendMessage', content: 'from b' } as never, 'view-2'));
    await settle();
    const sends = h.routed.filter((entry) => entry.message.type === 'sendMessage');
    expect(sends.map(({ panelId: routedTo, viewKey, context }) => [routedTo, viewKey, context])).toEqual([[panelId, 'view-1', 'device-a'], [panelId, 'view-2', 'device-b']]);
    expect(new Set(sends.map((entry) => entry.session)).size).toBe(1);
    expect(h.sessions).toHaveLength(1);
    expect(h.instance(panelId).panelToken).toBe(TOKEN);
  });
});

describe('a page that loads again mid-turn', () => {
  // setImmediate stays real: the panel's message gate and the settles run on it
  beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] }));
  afterEach(() => vi.useRealTimers());

  function reloadingChat(folders: readonly string[] = ['/ws']) {
    // a view that watched the turn, fed each live message when core posts it, so its clock is a watcher's
    const watcher = chatPage();
    const host = makeFakeHost();
    let pause: Promise<void> | undefined;
    // the page the host shows, which takes each post when the host does
    let shown: ChatPage | undefined;
    // the replay paces each post by the host, so a pause holds it mid-replay while the turn goes on
    Object.assign(host, {
      drained: () => pause ?? Promise.resolve(),
      postMessage: (message: ExtensionToWebviewMessage) => {
        host.posted.push(message);
        shown?.deliver([message]);
        return Promise.resolve(true);
      },
    });
    let handled: Promise<void> = Promise.resolve();
    // each session the panel ran, the first the one it opens with; `readied` lists those that reposted to a page that loaded again
    const sessions: LiveChatSession[] = [];
    const readied: LiveChatSession[] = [];
    // per session, a view that watched only that session's conversation, fed each of its posts when sent
    const watcherOf = new Map<LiveChatSession, ChatPage>();
    const newSession = (): LiveChatSession => {
      const own = chatPage();
      const created = liveChatSession((message) => {
        own.deliver([message]);
        watcher.deliver([message]);
        h.manager.postMessage(host, message);
      }, { onWebviewReady: () => readied.push(created) });
      watcherOf.set(created, own);
      sessions.push(created);
      return created;
    };
    const session = newSession();
    let opened = 0;
    let settingsHeld: Promise<void> | undefined;
    const ctxOf = (panelId: string, viewKey?: string): HandlerContext => {
      const instance = h.instance(panelId);
      return {
        host: instance.host,
        reply: instance.host,
        session: instance.session,
        permissionHandler: instance.permissionHandler,
        ideContextManager: instance.ideContextManager,
        terminalAttachments: instance.terminalAttachments,
        panelId,
        folder: instance.folder,
        ...(viewKey !== undefined ? { viewKey } : {}),
      };
    };
    const h = createHarness(folders.map((folder) => folderEntry(folder)), {
      // a folder switch or removal replaces the panel's session with a new one
      createSession: () => (opened++ === 0 ? session : newSession()) as unknown as ChatSession,
      handleWebviewMessage: async (message, panelId, _view, viewKey) => {
        if (message.type !== 'ready') return;
        handled = Promise.resolve(handlers.ready!(message, ctxOf(panelId, viewKey)));
        await handled;
      },
    });
    harness = h;
    const post = (target: PanelHost, message: ExtensionToWebviewMessage): void => h.manager.postMessage(target, message);
    const historyManager = new HistoryManager({ postMessage: post, maxCheckpointFileSizeBytes: () => 0 });
    const deps = {
      postMessage: post,
      platform: h.platform,
      getPanels: () => h.manager.getPanels(),
      historyManager,
      settingsManager: {
        sendCurrentSettings: () => settingsHeld ?? Promise.resolve(),
        sendMcpConfig: () => undefined,
        sendModelForPanel: () => undefined,
        sendThinkingForPanel: () => undefined,
        sendAvailableModels: async () => undefined,
        sendImageGenerationSettings: () => undefined,
      },
      storageManager: {
        getStoredSessions: async () => ({ sessions: [], hasMore: false, nextOffset: 0 }),
        getPromptHistory: async () => ({ history: [], hasMore: false }),
        folderOf: async () => undefined,
      },
      folderRegistry: h.registry,
      getLanguagePreference: () => 'en',
      postWorkspaceFolderState: () => undefined,
      webviewPrompts: { repost: () => undefined },
      withViewGate: (target: PanelHost, joining: string | undefined, run: (gate: ViewJoinGate) => Promise<void>) => h.manager.withViewGate(target, joining, run),
      worktrees: () => h.manager.worktrees,
    } as unknown as HandlerDependencies;
    const handlers = createSessionHandlers(deps);
    const play = (events: readonly unknown[], on: LiveChatSession = session): void => {
      for (const event of events) {
        on.pi.emit(event);
        vi.advanceTimersByTime(TOOL_OUTPUT_COALESCE_MS);
      }
    };
    /** The page loads again and sends `ready`; `during` plays while its replay is paused, after the snapshot was taken. */
    const reload = async (during: readonly unknown[]): Promise<{ page: ChatPage; posted: ExtensionToWebviewMessage[] }> => {
      const from = host.posted.length;
      const page = chatPage();
      shown = page;
      let resume!: () => void;
      pause = new Promise<void>((resolve) => (resume = resolve));
      host.send({ type: 'ready', savedSessionId: 'SID', panelToken: TOKEN } as never);
      await vi.waitFor(() => expect(host.posted.slice(from).some((m) => m.type === 'sessionCleared')).toBe(true));
      play(during);
      pause = undefined;
      resume();
      await vi.waitFor(() => expect(host.posted.slice(from).some((m) => m.type === 'storedSessions')).toBe(true));
      await handled;
      return { page, posted: host.posted.slice(from) };
    };
    /** Holds the host's posts until the returned call, as a client whose channel is full holds a paced replay. */
    const holdPosts = (): (() => void) => {
      let resume!: () => void;
      pause = new Promise<void>((resolve) => (resume = resolve));
      return () => {
        pause = undefined;
        resume();
      };
    };
    /** Holds the settings `ready` posts first until the returned call. */
    const holdSettings = (): (() => void) => {
      let resume!: () => void;
      settingsHeld = new Promise<void>((resolve) => (resume = resolve));
      return () => {
        settingsHeld = undefined;
        resume();
      };
    };
    /** A page that loads again: the host shows it from here on, and it sends `ready`. */
    const loadPage = (): ChatPage => {
      const page = chatPage();
      shown = page;
      host.send({ type: 'ready', savedSessionId: 'SID', panelToken: TOKEN } as never);
      return page;
    };
    return { h, host, session, sessions, readied, watcherOf, watcher, play, reload, historyManager, holdPosts, holdSettings, loadPage, handled: () => handled };
  }

  it('a page reloaded mid-turn gets the live replay through the view gate and ends with the stores of a view that watched (processing, streaming text, running tool card), and no live event reaches it twice', async () => {
    const { h, host, session, watcher, play, reload } = reloadingChat();
    await h.manager.initializeHost(host);
    session.adapter.beginTurn('c', { message: PROMPT, text: null });
    const shellRunning = TURN.findIndex((event) => (event as { type: string }).type === 'tool_execution_update') + 1;
    play(TURN.slice(0, shellRunning));

    // reloaded while the shell call runs; its next output and the read's end land while the replay is paused
    const atShell = await reload(TURN.slice(shellRunning, shellRunning + 2));
    expect(atShell.page.shown()).toEqual(watcher.shown());
    expect(atShell.page.shown().processing).toBe(true);
    expect(cardsOf(atShell.page.shown()).find((c) => c.id === 'b1')).toEqual({ id: 'b1', name: 'Bash', status: 'running', output: 'line 1\nline 2\n' });
    const streaming = TURN.findIndex((event) => (event as { assistantMessageEvent?: { delta?: string } }).assistantMessageEvent?.delta === 'All') + 1;
    play(TURN.slice(shellRunning + 2, streaming));
    expect(atShell.page.shown()).toEqual(watcher.shown());

    // reloaded while the answer streams; its next delta lands while the replay is paused
    const atAnswer = await reload(TURN.slice(streaming, streaming + 1));
    expect(atAnswer.page.shown()).toEqual(watcher.shown());
    expect(atAnswer.page.shown().transcript.at(-1)).toEqual({ role: 'assistant', content: 'All good' });
    expect(atAnswer.page.shown().processing).toBe(true);

    for (const { posted } of [atShell, atAnswer]) {
      const liveEvents = posted.filter((m) => session.eventSeqOf(m) !== undefined);
      expect(new Set(liveEvents).size).toBe(liveEvents.length);
    }
    // the rest of the turn reaches the reloaded page live
    play(TURN.slice(streaming + 1));
    expect(atAnswer.page.shown()).toEqual(watcher.shown());
    expect(atAnswer.page.shown().processing).toBe(false);
  });

  it('a page that loads again while a folder removal replaces the panel\'s session is shown the session the panel holds when the replay captures, and that session\'s events during the replay reach it once', async () => {
    const chat = reloadingChat(['/ws', '/other']);
    const panelId = await chat.h.manager.initializeHost(chat.host);
    const shellRunning = TURN.findIndex((event) => (event as { type: string }).type === 'tool_execution_update') + 1;
    const streaming = TURN.findIndex((event) => (event as { assistantMessageEvent?: { delta?: string } }).assistantMessageEvent?.delta === 'All') + 1;
    chat.session.adapter.beginTurn('c', { message: PROMPT, text: null });
    chat.play(TURN.slice(0, streaming));

    // the reloaded page's ready waits on its settings while the panel's folder goes
    const releaseSettings = chat.holdSettings();
    const loaded = chat.host.posted.length;
    const page = chat.loadPage();
    await vi.waitFor(() => expect(chat.host.posted.slice(loaded).some((m) => m.type === 'hostCapabilities')).toBe(true));
    chat.h.setFolders([folderEntry('/other')]);
    await vi.waitFor(() => expect(chat.h.instance(panelId).session).toBe(chat.sessions[1]));
    const moved = chat.sessions[1]!;
    moved.adapter.beginTurn('c', { message: PROMPT, text: null });
    chat.play(TURN.slice(0, shellRunning), moved);

    // the new session's next events land while the replay is paused, after its snapshot
    const resumePosts = chat.holdPosts();
    const from = chat.host.posted.length;
    releaseSettings();
    await vi.waitFor(() => expect(chat.host.posted.slice(from).some((m) => m.type === 'sessionCleared')).toBe(true));
    chat.play(TURN.slice(shellRunning, shellRunning + 2), moved);
    resumePosts();
    await vi.waitFor(() => expect(chat.host.posted.slice(from).some((m) => m.type === 'storedSessions')).toBe(true));
    await chat.handled();

    expect(page.shown()).toEqual(chat.watcherOf.get(moved)!.shown());
    // the read's end, which landed while the replay was paused
    expect(cardsOf(page.shown()).find((c) => c.id === 'r1')?.status).toBe('failed');
    // the session the page now shows reposts its prompts and state, never the disposed one
    expect(chat.readied).toEqual([moved]);
  });

  it('a page whose replay waits on a pending resume while a folder removal replaces the panel\'s session is shown the new session', async () => {
    const chat = reloadingChat(['/ws', '/other']);
    const panelId = await chat.h.manager.initializeHost(chat.host);
    const streaming = TURN.findIndex((event) => (event as { assistantMessageEvent?: { delta?: string } }).assistantMessageEvent?.delta === 'All') + 1;
    chat.session.adapter.beginTurn('c', { message: PROMPT, text: null });
    chat.play(TURN.slice(0, streaming));
    let settled!: () => void;
    chat.session.whenConversationSettled = () => new Promise<undefined>((resolve) => (settled = () => resolve(undefined)));

    const page = chat.loadPage();
    await vi.waitFor(() => expect(settled).toBeDefined());
    chat.h.setFolders([folderEntry('/other')]);
    await vi.waitFor(() => expect(chat.h.instance(panelId).session).toBe(chat.sessions[1]));
    const moved = chat.sessions[1]!;
    moved.adapter.beginTurn('c', { message: PROMPT, text: null });
    chat.play(TURN.slice(0, 3), moved);
    // the new session's next events land while the replay is paused, after its snapshot
    const resumePosts = chat.holdPosts();
    const from = chat.host.posted.length;
    settled();
    await vi.waitFor(() => expect(chat.host.posted.slice(from).some((m) => m.type === 'sessionCleared')).toBe(true));
    chat.play(TURN.slice(3, 6), moved);
    resumePosts();
    await vi.waitFor(() => expect(chat.host.posted.slice(from).some((m) => m.type === 'storedSessions')).toBe(true));
    await chat.handled();

    expect(page.shown()).toEqual(chat.watcherOf.get(moved)!.shown());
    expect(chat.readied).toEqual([moved]);
  });

  it('a page that loads again while a file replay to the panel runs takes the live replay once that replay ended, never interleaved with it', async () => {
    const chat = reloadingChat();
    await chat.h.manager.initializeHost(chat.host);
    const shellRunning = TURN.findIndex((event) => (event as { type: string }).type === 'tool_execution_update') + 1;
    chat.session.adapter.beginTurn('c', { message: PROMPT, text: null });
    chat.play(TURN.slice(0, shellRunning));

    // a resume or hand-off into the panel, from main or another device, replays a file to every view, paced by the client
    const resumePosts = chat.holdPosts();
    const fileReplay = chat.historyManager.loadSessionHistory('/ws', 'SID', chat.host, chat.session as unknown as ChatSession);
    // the page loads again once the file replay posted its sessionCleared
    const from = chat.host.posted.length;
    const page = chat.loadPage();
    await settle();
    await settle();
    resumePosts();
    await fileReplay;
    await vi.waitFor(() => expect(chat.host.posted.slice(from).some((m) => m.type === 'storedSessions')).toBe(true));
    await chat.handled();

    const posted = chat.host.posted.slice(from);
    const liveCleared = posted.map((m) => m.type).lastIndexOf('sessionCleared');
    expect(posted.slice(0, liveCleared).some((m) => m.type === 'userReplay' && m.content === 'from the file')).toBe(true);
    expect(posted.slice(liveCleared).some((m) => m.type === 'userReplay' && m.content === 'from the file')).toBe(false);
    expect(page.shown()).toEqual(chat.watcher.shown());
  });
});
