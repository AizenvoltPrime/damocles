// A core panel several clients' views show: a view's host posts to that view alone and is paced by that view's client, the
// panel's host posts to every view, a join replays to the joining view alone while the others go on live, and a message
// names the view that sent it and keeps the client it came from while it waits behind a `ready`.
import { afterEach, describe, expect, it } from 'vitest';
import { createHarness, folderEntry, handlingContext, makeFakeHost, makeMultiViewHost, type Harness } from '../../../core/chat-panel/__tests__/panel-manager-harness';
import { processActor, type CoreEndpoint } from '../../core-protocol';
import type { ViewJoinGate } from '../../../core/chat-panel/types';
import type { PanelHost } from '../../../platform/window-service';
import type { ExtensionToWebviewMessage } from '../../../shared/types/messages';
import { createCorePanels, PACE_CHARS } from '../platform/panels';

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
      joinView: async (_panelId, joinGate, target) => {
        gate = joinGate;
        joinHost = target;
        gate.post({ type: 'sessionCleared', sessionId: 'S1' });
        gate.hold();
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
      joinView: async (_panelId, gate, target) => {
        started.push(target);
        gate.hold();
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
      joinView: async (_panelId, gate) => {
        gate.hold();
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
      joinView: async (_panelId, gate) => {
        gate.hold();
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
      joinView: async (_panelId, gate, target) => {
        joinHost = target;
        gate.hold();
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
